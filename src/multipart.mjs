import { HttpError, assert } from './security.mjs';
import { imageSize, base64Size } from './image-size.mjs';

export function parseJson(bytes) {
  try {
    const value = JSON.parse(bytes.toString());
    assert(value && typeof value === 'object' && !Array.isArray(value), '需要 JSON 对象');
    return value;
  } catch { throw new HttpError(400, 'JSON 格式无效'); }
}

/** Read the official `request` part without changing the binary image parts. */
export async function parseMultipart(raw, type) {
  let form;
  try { form = await new Response(raw, { headers: { 'Content-Type': type } }).formData(); }
  catch { throw new HttpError(400, '表单格式无效'); }
  const names = new Set();
  for (const [name] of form) {
    assert(!names.has(name), '表单分块名称重复');
    names.add(name);
  }
  const request = form.get('request');
  assert(request instanceof Blob || typeof request === 'string', '表单缺少 request 参数');
  const body = parseJson(request instanceof Blob ? Buffer.from(await request.arrayBuffer()) : Buffer.from(request));
  return { form, body };
}

export function imagePart(form, name) {
  assert(typeof name === 'string' && name !== 'request', '图片分块名称无效');
  const image = form.get(name);
  assert(image instanceof Blob && image.size > 0, '请求缺少图片分块');
  return image;
}

export function validateGenerationParts(form, body) {
  for (const container of [body, body.parameters]) {
    if (!container || typeof container !== 'object') continue;
    for (const field of ['image', 'mask', 'reference_image']) {
      if (container[field] !== undefined) imagePart(form, container[field]);
    }
  }
  const p = body.parameters;
  if (!p || typeof p !== 'object') return;
  for (const field of ['reference_image_multiple', 'director_reference_images']) {
    if (p[field] !== undefined) {
      assert(Array.isArray(p[field]) && p[field].length <= 16, '参考图数量无效');
      for (const name of p[field]) imagePart(form, name);
    }
    const cached = p[field + '_cached'];
    if (cached !== undefined) {
      assert(Array.isArray(cached) && cached.length <= 16, '参考图数量无效');
      for (const item of cached) imagePart(form, item?.data);
    }
  }
}

export async function replaceMultipartRequest(form, body) {
  // Keep all image bytes and names; only rewrite the JSON stream preference.
  const updated = new FormData();
  for (const [name, value] of form) {
    if (name === 'request') {
      const request = JSON.stringify(body);
      if (value instanceof Blob) updated.append(name, new Blob([request], { type: 'application/json' }), value.name ?? 'blob');
      else updated.append(name, request);
    } else if (value instanceof Blob) updated.append(name, value, value.name ?? 'blob');
    else updated.append(name, value);
  }
  const encoded = new Response(updated);
  return { payload: Buffer.from(await encoded.arrayBuffer()), type: encoded.headers.get('content-type') };
}

/** Reject mismatched infill canvases before reserving points or contacting an upstream. */
export async function validateInpaintingImages(body, form = null) {
  if (body.action !== 'infill') return;
  const p = body.parameters;
  assert(p && typeof p === 'object', '缺少生成参数');
  for (const field of ['image', 'mask']) {
    const size = form ? imageSize(Buffer.from(await imagePart(form, p[field]).arrayBuffer())) : base64Size(p[field]);
    assert(size.width === p.width && size.height === p.height, field === 'mask' ? '重绘蒙版尺寸与生成画布不一致' : '重绘原图尺寸与生成画布不一致');
  }
}
