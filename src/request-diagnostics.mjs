import { imageSize } from './image-size.mjs';

const LIMIT = 128 * 1024;
const sensitive = /token|authorization|password|secret|cookie|session|api[_-]?key/i;
const binary = /^(image|mask|data|base64|preview|reference_image_multiple|director_reference_images)$/i;
const clip = text => text.length > LIMIT ? text.slice(0, LIMIT) + '\n[内容超过 128 KiB，已截断]' : text;

/** Also scrub input images/cache credentials if an upstream error echoes their values. */
export function diagnosticSecrets(body) {
  const result = [];
  const visit = (value, key = '') => {
    if (typeof value === 'string' && (sensitive.test(key) || binary.test(key) && value.length >= 64 || value.startsWith('data:image/'))) {
      result.push(value);
      if (value.startsWith('data:image/')) result.push(value.split(',')[1]);
    } else if (Array.isArray(value)) value.forEach(item => visit(item, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([name, item]) => visit(item, name));
  };
  visit(body); return result;
}

/** Preserve upstream wording while removing credentials and encoded image content. */
export function redactDiagnosticText(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length > 0)) text = text.replaceAll(secret, '[已脱敏]');
  return clip(text
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [已脱敏]')
    .replace(/\b(?:pst-[\w.-]+|skr_[\w-]+)\b/g, '[已脱敏]')
    .replace(/("(?:[^"\\]*(?:token|authorization|password|secret|cookie|session|api[_-]?key)[^"\\]*)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[已脱敏]"')
    .replace(/("(?:image|mask|base64|preview)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[图片数据已省略]"')
    .replace(/data:image\/[^\s"'<>]+/gi, '[图片数据已省略]')
    .replace(/[A-Za-z0-9+/]{512,}={0,2}/g, '[编码数据已省略]'));
}

function imageSummary(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
  let size = {};
  try { size = imageSize(bytes); } catch { /* Invalid/encoded references still have useful byte lengths. */ }
  return { omitted: 'image data', bytes: bytes.length, ...size };
}

/** Snapshot the forwarded JSON, including dimensions of images carried as multipart files. */
export async function requestDiagnostics(body, form, secrets = []) {
  const parts = new Map();
  if (form) for (const [name, value] of form) if (name !== 'request' && value instanceof Blob)
    parts.set(name, imageSummary(Buffer.from(await value.arrayBuffer())));
  let remaining = 1024 * 1024;
  const visit = (value, key = '', depth = 0) => {
    if (sensitive.test(key)) return '[已脱敏]';
    if (depth > 24 || remaining <= 0) return '[请求日志大小超限，已省略]';
    if (typeof value === 'string') {
      if (binary.test(key) && parts.has(value)) return { part: value, ...parts.get(value) };
      if (binary.test(key) || value.startsWith('data:image/')) return imageSummary(value);
      const text = redactDiagnosticText(value, secrets); remaining -= text.length;
      return text;
    }
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value) {
        if (remaining <= 0) { result.push('[请求日志大小超限，已省略]'); break; }
        result.push(visit(item, key, depth + 1));
      }
      return result;
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => {
      remaining -= name.length + 16;
      return [name, visit(item, name, depth + 1)];
    }));
    remaining -= 16;
    return value;
  };
  return visit(body);
}

export function failureDiagnostics(error, stream, secrets = []) {
  return redactDiagnosticText(JSON.stringify({ name: error.name, message: error.message,
    code: error.code, cause: error.cause && { name: error.cause.name, message: error.cause.message, code: error.cause.code },
    ...(stream ? { finalImages: stream.finals.size, expectedImages: stream.expected } : {}),
  }, null, 2), secrets);
}
