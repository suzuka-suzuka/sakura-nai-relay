import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const context = createContext({});
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
runInContext(source.slice(0, source.indexOf("document.addEventListener('click'")), context);
const totals = (data, quota) => JSON.parse(JSON.stringify(context.quotaTotals(data, quota, 10000)));
const key = (patch = {}) => ({ enabled: true, expires_at: null, tier: 'member', balance: 2000, reserved: 100, stamina_balance: 56000, stamina_reserved: 1120, ...patch });
const upstream = (id, patch = {}) => ({ id, ok: true, account: { tier: 3, active: true, usage: { percent: 80, isNegative: false }, relay: { available: 5000 }, ...patch } });

test('compares member usable balances, excluding standard/disabled/expired keys and disabled upstreams', () => {
  const result = totals({ keys: [key(), key({ tier: 'standard' }), key({ enabled: false }), key({ expires_at: 10000 })], upstreams: [{ id: 1, enabled: true }, { id: 2, enabled: true }, { id: 3, enabled: false }] }, { upstreams: [upstream(1), upstream(2), upstream(3)] });
  assert.deepEqual(result, { stamina: { available: 160, issued: 49 }, anlas: { available: 10000, issued: 1900 } });
});

test('expired and non-Opus accounts contribute points but no V5 stamina; negative usage is zero', () => {
  const rows = [upstream(1, { expiresAt: 9 }), upstream(2, { tier: 1 }), upstream(3, { usage: { percent: 75, isNegative: true } }), upstream(4, { accountType: 1, expiresAt: 9 })];
  assert.deepEqual(totals({ keys: [], upstreams: rows.map(({ id }) => ({ id, enabled: true })) }, { upstreams: rows }), { stamina: { available: 80, issued: 0 }, anlas: { available: 20000, issued: 0 } });
});

test('unknown quota never appears as zero or a partial total', () => {
  const data = { keys: [key()], upstreams: [{ id: 1, enabled: true }, { id: 2, enabled: true }] };
  for (const quota of [null, { upstreams: [upstream(1)] }, { upstreams: [upstream(1), { id: 2, ok: false }] }]) {
    assert.deepEqual(totals(data, quota), { stamina: { available: null, issued: 49 }, anlas: { available: null, issued: 1900 } });
  }
  const missingUsage = totals({ ...data, upstreams: [{ id: 1, enabled: true }] }, { upstreams: [upstream(1, { usage: undefined })] });
  assert.equal(missingUsage.stamina.available, null);
  assert.equal(missingUsage.anlas.available, 5000);
  assert.deepEqual(totals({ keys: [], upstreams: [] }, null), { stamina: { available: 0, issued: 0 }, anlas: { available: 0, issued: 0 } });
});

test('quota SSE refresh updates comparison without replacing the overview or open forms', () => {
  const comparison = { outerHTML: '' };
  context.document = { querySelector: selector => selector === '.quota-comparison-grid' ? comparison : null };
  runInContext("state.data = { keys: [], upstreams: [{ id: 1, enabled: true }] }; state.quota = null;", context);
  context.updateQuota({ upstreams: [upstream(1)], fetchedAt: 2 });
  assert.match(comparison.outerHTML, /80\.0%/);
  assert.match(comparison.outerHTML, /5,000/);
  const previous = comparison.outerHTML;
  context.updateQuota({ upstreams: [], fetchedAt: 1 });
  assert.equal(comparison.outerHTML, previous);
  context.updateQuota({ upstreams: [{ id: 1, ok: false }], fetchedAt: 3 });
  assert.match(comparison.outerHTML, /—/);
  assert.doesNotMatch(comparison.outerHTML, /NaN|<small|<p[ >]/);
});
