// Ported from Sakura NAI lib/nai/cost.ts. See THIRD_PARTY_NOTICES.md.
// Keep this pure calculation aligned with the drawing frontend.
const isV4 = model => model.startsWith('nai-diffusion-4');
const isV5 = model => model.startsWith('nai-diffusion-5');
// Max submits the source canvas; price and free eligibility use its expanded output.
export function imageToolOutputSize(s) {
  if (!isV5(s.model) || s.imageSource?.mode !== 'img2img' || !s.imageSource.upscaledEnhance)
    return { width: s.width, height: s.height };
  const factor = Math.sqrt(3_145_728 / (s.width * s.height));
  return { width: Math.round(s.width * factor), height: Math.round(s.height * factor) };
}
export function upscaleCost(width, height) {
  const area = width * height;
  if (!Number.isFinite(area) || area <= 0 || area > 3145728) return null;
  return area <= 1048576 ? 1 : area <= 1747627 ? 2 : area <= 2446678 ? 3 : 4;
}
export const active = account => !!account && ([1, 2, 3, 4].includes(account.accountType ?? 0) ||
  (account.expiresAt !== undefined ? account.expiresAt > Date.now() / 1000 : account.active));
export function augmentCost(width, height, backgroundRemoval, account) {
  const area = Math.max(1048576, Math.min(3145728, width * height));
  const base = Math.max(2, Math.ceil(2.951823174884865e-6 * area + 5.753298233447344e-7 * area * 28));
  return backgroundRemoval ? base * 3 + 5 : active(account) && account?.tier === 3 && area <= 1048576 ? 0 : base;
}
export function estimateCost(s, account, uncachedVibes = 0) {
  const v5 = isV5(s.model), opus = active(account) && account?.tier === 3;
  const allowance = !v5 || !!(account?.usage && Number.isFinite(account.usage.percent) && account.usage.percent > 0 && account.usage.isNegative === false);
  const billed = imageToolOutputSize(s);
  const area = billed.width * billed.height, free = opus && allowance && area <= 1048576 && s.steps <= 28;
  const smea = !s.imageSource && !v5 && !isV4(s.model) && s.autoSmea;
  const strength = s.imageSource ? s.imageSource.mode === 'infill' ? s.imageSource.inpaintStrength : s.imageSource.strength : 1;
  const perImage = Math.max(2, Math.ceil(Math.ceil(2.951823174884865e-6 * area + 5.753298233447344e-7 * area * s.steps) * (smea ? 1.2 : 1) * (v5 ? 1.5 : 1) * strength));
  const base = perImage * Math.max(0, s.nSamples - (free ? 1 : 0));
  const refsAllowed = !v5 && s.imageSource?.mode !== 'infill';
  const director = refsAllowed && ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'].includes(s.model) ? s.directorReference.length : 0;
  const references = !refsAllowed ? 0 : director ? director * 5 * s.nSamples : isV4(s.model) ? Math.max(0, s.vibe.length - 4) * 2 : 0;
  const encoding = refsAllowed && !director && isV4(s.model) ? uncachedVibes * 2 : 0;
  return { total: base + references + encoding, base, references, encoding, usesAllowance: !!(free && v5), accountKnown: !!account, valid: perImage <= 140 };
}
