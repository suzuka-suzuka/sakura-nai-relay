import { randomBytes, createHash, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

export const random = () => randomBytes(32).toString('base64url');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 256 || !encoded) return false;
  const [salt, expected] = encoded.split(':');
  return equal(scryptSync(password, salt, 64).toString('hex'), expected);
}
export function seal(value, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
export function unseal(value, key) {
  const data = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString('utf8');
}
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const assert = (condition, message, status = 400) => { if (!condition) throw new HttpError(status, message); };
export function integer(value, min, max, label = 'Anlas') {
  assert(Number.isSafeInteger(value) && value >= min && value <= max, `${label}必须是 ${min}–${max} 范围内的整数`);
  return value;
}
