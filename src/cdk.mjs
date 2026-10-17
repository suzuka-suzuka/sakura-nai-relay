import { randomBytes } from 'node:crypto';
import { assert } from './security.mjs';

// 体力是 1–100 的百分比。4% 约 44 张免费小图，25% 是 280 张，100% 是 1120 张。
export const PRODUCTS = [
  { id: 'trial-100', name: '体验：100点数', tier: 'standard', points: 100, validDays: 30 },
  { id: 'trial-opus-1d', name: '体验：1天Opus', tier: 'member', points: 0, staminaPercent: 4, validDays: 1 },
  { id: 'points-2k', name: '按量：2k点数包', tier: 'standard', points: 2000, validDays: 30 },
  { id: 'month-shared', name: '月卡：4人Opus无限小图(无点)', tier: 'member', points: 0, staminaPercent: 25, validDays: 30 },
  { id: 'month-shared-2k', name: '月卡：4人Opus无限小图+2k点', tier: 'member', points: 2000, staminaPercent: 25, validDays: 30 },
  { id: 'month-exclusive', name: '月卡：单人独享Opus(含1w点)', tier: 'member', points: 10000, staminaPercent: 100, validDays: 30 },
];

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const productById = id => PRODUCTS.find(product => product.id === id) ?? null;

export function createCode() {
  const bytes = randomBytes(12);
  const chars = [...bytes].map(byte => ALPHABET[byte % ALPHABET.length]).join('');
  return `CDK-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function normalizeCode(value) {
  assert(typeof value === 'string' && value.trim().length <= 40, '兑换码无效');
  const compact = value.trim().toUpperCase().replace(/[\s-]/g, '');
  assert(/^CDK[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/.test(compact), '兑换码无效');
  return `CDK-${compact.slice(3, 7)}-${compact.slice(7, 11)}-${compact.slice(11, 15)}`;
}
