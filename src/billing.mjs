import { assert, integer } from './security.mjs';
import { estimateCost, augmentCost, upscaleCost, active } from './cost.mjs';

const models = new Set(['nai-diffusion-3', 'nai-diffusion-furry-3', 'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-5-full', 'nai-diffusion-5-curated']);
export function balanceOf(subscription) {
  const fixed = subscription?.trainingStepsLeft?.fixedTrainingStepsLeft;
  const purchased = subscription?.trainingStepsLeft?.purchasedTrainingSteps;
  assert(Number.isSafeInteger(fixed) && fixed >= 0 && Number.isSafeInteger(purchased) && purchased >= 0, '上游没有返回有效 Anlas 余额', 502);
  return fixed + purchased;
}
export function upstreamSubscription(data) {
  const balance = balanceOf(data);
  return { ...publicSubscription(data, { balance, reserved: 0 }), relay: { balance, reserved: 0, available: balance, unit: 'Anlas' } };
}
// Only the upstream administration view exposes the real subscription tier.
function publicSubscription(data, key) {
  balanceOf(data);
  assert(typeof data.tier === 'number' && typeof data.active === 'boolean', '上游账户响应无效', 502);
  return {
    tier: data.tier, active: data.active,
    ...(Number.isFinite(data.expiresAt) ? { expiresAt: data.expiresAt } : {}),
    ...(typeof data.accountType === 'number' ? { accountType: data.accountType } : {}),
    trainingStepsLeft: { fixedTrainingStepsLeft: key.balance - key.reserved, purchasedTrainingSteps: 0 },
    ...(data.usage && typeof data.usage.percent === 'number' && typeof data.usage.isNegative === 'boolean'
      ? { usage: { percent: data.usage.percent, isNegative: data.usage.isNegative } } : {}),
    relay: { balance: key.balance, reserved: key.reserved, available: key.balance - key.reserved, unit: 'Anlas' },
  };
}
export const emptyUsage = () => ({ percent: 0, isNegative: true });
export const isActiveOpus = data => active(data) && data?.tier === 3;
export function hasNai5Allowance(data) {
  return isActiveOpus(data) && Number.isFinite(data?.usage?.percent) && data.usage.percent > 0 && data.usage.isNegative === false;
}
export function billingAccount(key, boundSubscription = null) {
  return { tier: key.tier === 'member' ? 3 : 1, active: true,
    usage: key.tier === 'member' && hasNai5Allowance(boundSubscription)
      ? { percent: boundSubscription.usage.percent, isNegative: false } : emptyUsage() };
}
export function downstreamSubscription(key, boundSubscription = null) {
  const account = billingAccount(key, boundSubscription);
  return { ...account,
    ...(key.expires_at !== null ? { expiresAt: key.expires_at / 1000 } : {}),
    trainingStepsLeft: { fixedTrainingStepsLeft: key.balance - key.reserved, purchasedTrainingSteps: 0 },
    relay: { tier: key.tier, expiresAt: key.expires_at, balance: key.balance, reserved: key.reserved,
      available: key.balance - key.reserved, unit: 'Anlas', billing: 'local',
      nai5UpstreamId: key.nai5_upstream_id, usageSource: key.tier === 'member' ? 'bound-upstream' : 'none' } };
}
export const isNai5Generation = (path, body) => ['/ai/generate-image', '/ai/generate-image-stream'].includes(path) && /^nai-diffusion-5-(full|curated)(-inpainting)?$/.test(body.model);
function dimensions(p) {
  integer(p.width, 64, 4096, '宽度'); integer(p.height, 64, 4096, '高度');
  assert(p.width * p.height <= 3_145_728, '图片不能超过 3,145,728 像素');
  return p.width * p.height;
}
function arrayLength(value, limit = 16) { if (value === undefined) return 0; assert(Array.isArray(value) && value.length <= limit, '参考图数量无效'); return value.length; }
function referenceCount(parameters, field) {
  const plain = arrayLength(parameters[field]), cached = arrayLength(parameters[field + '_cached']);
  assert(!plain || !cached, '同类参考图不能同时使用普通与缓存字段');
  if (cached) assert(parameters[field + '_cached'].every(item => item && typeof item.data === 'string' && item.data.length > 0), '缓存参考图参数无效');
  return plain + cached;
}

/** Authoritative local price. Upstream routing uses the same formula with the real account. */
export function reservation(path, body, subscription) {
  if (path === '/ai/encode-vibe') {
    assert(typeof body.image === 'string' && body.image.length > 0 && models.has(body.model) && body.model.startsWith('nai-diffusion-4'), 'Vibe 编码参数无效');
    return 2;
  }
  if (path === '/ai/upscale') { const cost = upscaleCost(body.width, body.height); assert(cost !== null, '放大尺寸无效'); return cost; }
  if (path === '/ai/augment-image') {
    assert(['lineart', 'sketch', 'bg-removal', 'declutter', 'colorize', 'emotion'].includes(body.req_type), '不支持的图片处理类型');
    assert(typeof body.image === 'string' && body.image.length > 0, '缺少图片');
    dimensions(body);
    return augmentCost(body.width, body.height, body.req_type === 'bg-removal', subscription);
  }
  const baseModel = typeof body.model === 'string' ? body.model.replace(/-inpainting$/, '') : '';
  assert(models.has(baseModel) && (body.model === baseModel || body.action === 'infill'), '不支持的模型');
  assert(['generate', 'img2img', 'infill'].includes(body.action), '不支持的生成方式');
  const p = body.parameters;
  assert(p && typeof p === 'object' && !Array.isArray(p), '缺少生成参数');
  const area = dimensions(p), v5 = baseModel.startsWith('nai-diffusion-5'), v4 = baseModel.startsWith('nai-diffusion-4');
  assert(p.width <= 2048 && p.height <= 2048 && p.width % 64 === 0 && p.height % 64 === 0, '生成尺寸必须为 64 的倍数且不超过 2048');
  integer(p.n_samples, 1, 8, '图片张数'); integer(p.steps, 1, 50, '步数');
  assert(!p.upscale, '请使用独立放大接口');
  assert(p.upscaled_enhance === undefined || typeof p.upscaled_enhance === 'boolean', 'Max 增强标记必须为布尔值');
  assert(!p.upscaled_enhance || v5 && body.action === 'img2img', 'Max 增强仅支持 V5 图生图');
  assert(body.action === 'generate' || typeof p.image === 'string', '缺少原图');
  const strength = body.action === 'generate' ? 1 : body.action === 'infill' ? p.inpaintImg2ImgStrength : p.strength;
  assert(Number.isFinite(strength) && strength >= 0 && strength <= 1, '图生图强度无效');
  if (body.action !== 'generate' && p.noise !== undefined)
    assert(Number.isFinite(p.noise) && p.noise >= 0 && p.noise <= 1, '图生图噪声无效');
  if (body.action === 'infill') assert(typeof p.mask === 'string' && p.mask.length > 0, '缺少重绘蒙版');
  const director = referenceCount(p, 'director_reference_images'), vibes = referenceCount(p, 'reference_image_multiple');
  assert(!p.sm_dyn, '暂不支持动态 SMEA 计价，请使用普通 SMEA');
  assert(!director || baseModel.includes('4-5') && body.action !== 'infill', '当前模型或生成方式不支持角色参考图');
  assert(!vibes || !v5 && body.action !== 'infill', '当前模型或生成方式不支持 Vibe');
  assert(!(director && vibes), '角色参考图与 Vibe 不能同时使用');
  const estimate = estimateCost({
    model: baseModel, width: p.width, height: p.height, steps: p.steps, nSamples: p.n_samples,
    autoSmea: !!p.sm, imageSource: body.action === 'generate' ? null : { mode: body.action, strength, inpaintStrength: strength, upscaledEnhance: p.upscaled_enhance === true },
    directorReference: Array(director), vibe: Array(vibes),
  }, subscription);
  assert(estimate.valid, '单张消耗不能超过 140 Anlas');
  return estimate.total;
}

/** Validate upstream SSE before settlement; optionally expose parsed events to a client encoder. */
export class StreamCheck {
  constructor(expected, onEvent = null) { this.expected = expected; this.onEvent = onEvent; this.buffer = ''; this.decoder = new TextDecoder(); this.finals = new Set(); this.failed = false; }
  feed(bytes) {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    assert(this.buffer.length < 64 * 1024 * 1024, '上游流式事件过大', 502);
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      this.record(this.buffer.slice(0, match.index)); this.buffer = this.buffer.slice(match.index + match[0].length);
    }
  }
  record(record) {
    const lines = record.split(/\r?\n/), kind = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { this.failed = true; return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { this.failed = true; return; }
    const type = parsed.event_type ?? kind;
    if (type === 'error' || parsed.error) this.failed = true;
    if (type === 'final') {
      if (!Number.isInteger(parsed.samp_ix) || parsed.samp_ix < 0 || parsed.samp_ix >= this.expected || !parsed.image) this.failed = true;
      else this.finals.add(parsed.samp_ix);
    }
    this.onEvent?.({ ...parsed, ...(type ? { event_type: type } : {}) });
  }
  complete() { this.buffer += this.decoder.decode(); if (this.buffer.trim()) this.record(this.buffer); return !this.failed && this.finals.size === this.expected; }
}
