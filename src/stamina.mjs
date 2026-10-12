// Integer units: one V5 allowance costs 100; 100% stores seven days of 160 images.
export const IMAGE_STAMINA = 100;
export const FULL_STAMINA = 112_000;
export const DAY_MS = 86_400_000;
// Each key keeps its creation-time phase; delayed reads never shift the next boundary.
export const refillPeriod = (createdAt, now = Date.now()) => Math.max(0, Math.floor((now - createdAt) / DAY_MS));
export const capacityFor = percent => percent * 1120;
export const dailyFor = capacity => capacity / 7;
export const availableStamina = key => Math.max(0, (key.stamina_balance ?? 0) - (key.stamina_reserved ?? 0));
export const hasLocalStamina = key => key.tier === 'member' && availableStamina(key) >= IMAGE_STAMINA;
export const staminaPercent = units => Math.round(units / FULL_STAMINA * 1000) / 10;
export function localUsage(key) {
  return { percent: key.tier === 'member' ? staminaPercent(availableStamina(key)) : 0, isNegative: !hasLocalStamina(key) };
}
