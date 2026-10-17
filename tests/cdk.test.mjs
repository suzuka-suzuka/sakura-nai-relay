import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';

const origin = 'http://127.0.0.1:3100';
const day = 86400000;

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sakura-cdk-'));
  const app = createApp({ dataDir: directory, publicOrigin: origin });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(base + '/admin/api/setup', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: readFileSync(join(directory, 'setup-code.txt'), 'utf8'), password: 'test-only-password-123' }) });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const csrf = (await setup.json()).csrf;
  const call = (path, method = 'GET', body) => fetch(base + path, { method, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, base, call };
}

async function mint(call, product, count = 1) {
  const response = await call('/admin/api/cdks', 'POST', { product, count });
  assert.equal(response.status, 201);
  return response.json();
}

async function redeem(base, code) {
  const response = await fetch(base + '/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  return { status: response.status, body: await response.json() };
}

test('兑换页可打开，提交兑换码后才创建对应规格的密钥', async t => {
  const { app, base, call } = await fixture(t);
  const page = await fetch(base + '/redeem');
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /每枚兑换码只能兑换一次/);
  assert.match(html, /src="\/redeem\.js"/);
  assert.doesNotMatch(html, /app\.js/);
  assert.equal((await fetch(base + '/redeem.js')).status, 200);

  const specs = [
    ['trial-100', { tier: 'standard', points: 100, stamina: 0, days: 30 }],
    ['trial-opus-1d', { tier: 'member', points: 0, stamina: 4480, days: 1 }],
    ['points-2k', { tier: 'standard', points: 2000, stamina: 0, days: 30 }],
    ['month-shared', { tier: 'member', points: 0, stamina: 28000, days: 30 }],
    ['month-shared-2k', { tier: 'member', points: 2000, stamina: 28000, days: 30 }],
    ['month-exclusive', { tier: 'member', points: 10000, stamina: 112000, days: 30 }],
  ];
  for (const [product, spec] of specs) {
    const existing = app.store.keys().length;
    const stock = await mint(call, product);
    assert.equal(app.store.keys().length, existing);
    assert.match(stock.codes[0], /^CDK-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const spaced = `  ${stock.codes[0].toLowerCase().replaceAll('-', ' ')}  `;
    const result = await redeem(base, spaced);
    assert.equal(result.status, 200);
    assert.equal(result.body.token !== undefined, true);
    assert.equal(result.body.tier, spec.tier);
    assert.equal(result.body.points, spec.points);
    assert.equal(result.body.relayUrl, origin);
    assert.match(result.body.token, /^skr_/);
    const key = app.store.authenticate(result.body.token);
    assert.equal(key.tier, spec.tier);
    assert.equal(key.balance, spec.points);
    assert.equal(key.stamina_capacity, spec.stamina);
    assert.equal(key.name, result.body.name);
    assert.ok(Math.abs(key.expires_at - (Date.now() + spec.days * day)) < 5000);
    const again = await redeem(base, stock.codes[0]);
    assert.equal(again.status, 409);
    assert.equal(again.body.token, undefined);
    assert.match(again.body.error, /已经兑换过/);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM keys WHERE name=?').get(key.name).n, 1);
  }
  const summary = await (await call('/admin/api/cdks')).json();
  assert.equal(summary.products.find(product => product.id === 'month-exclusive').staminaPercent, 100);
  assert.equal(summary.products.every(product => product.redeemed === 1 && product.unused === 0), true);
  assert.equal(summary.redemptions.length, 6);
  assert.doesNotMatch(JSON.stringify(summary), /CDK-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
  const ledger = app.store.ledger();
  assert.equal(ledger.find(row => row.delta === 10000).note, '兑换码创建');
  assert.equal(ledger.some(row => row.delta === 0), false);
});

test('未使用的兑换码可以导出，无效码和已删除密钥会拒绝', async t => {
  const { app, base, call } = await fixture(t);
  const stock = await mint(call, 'month-shared', 2);
  const exported = await (await call('/admin/api/cdks/export', 'POST', { product: 'month-shared' })).json();
  assert.deepEqual(exported.codes, stock.codes);
  const first = await redeem(base, stock.codes[0]);
  const left = await (await call('/admin/api/cdks/export', 'POST', { product: 'month-shared' })).json();
  assert.deepEqual(left.codes, [stock.codes[1]]);
  const found = await (await call('/admin/api/cdks/search', 'POST', { code: ` ${stock.codes[0].toLowerCase()} ` })).json();
  assert.equal(found.status, 'redeemed');
  assert.equal(found.keyId, app.store.authenticate(first.body.token).id);
  assert.equal(found.keyName, '月卡：4人Opus无限小图(无点)');
  assert.equal(Object.hasOwn(found, 'token'), false);
  const waiting = await (await call('/admin/api/cdks/search', 'POST', { code: stock.codes[1] })).json();
  assert.equal(waiting.status, 'unused');
  assert.equal(waiting.keyId, null);
  app.store.retireKey(found.keyId);
  const removed = await (await call('/admin/api/cdks/search', 'POST', { code: stock.codes[0] })).json();
  assert.equal(removed.status, 'deleted');
  assert.equal(removed.keyId, null);
  const gone = await redeem(base, stock.codes[0]);
  assert.equal(gone.status, 409);
  assert.equal(gone.body.token, undefined);
  assert.equal((await call('/admin/api/cdks/search', 'POST', { code: 'CDK-AAAA-AAAA-AAAA' })).status, 404);
  assert.equal((await fetch(base + '/admin/api/cdks/search', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: stock.codes[1] }) })).status, 401);
  const unknown = await redeem(base, 'CDK-AAAA-AAAA-AAAA');
  assert.equal(unknown.status, 404);
  const invalid = await redeem(base, '不是兑换码');
  assert.equal(invalid.status, 400);
  assert.equal((await call('/admin/api/cdks', 'POST', { product: 'missing', count: 1 })).status, 400);
  assert.equal((await fetch(base + '/admin/api/cdks')).status, 401);
});

test('同一枚兑换码并发提交只创建一把密钥', async t => {
  const { app, base, call } = await fixture(t);
  const { codes } = await mint(call, 'trial-opus-1d');
  const results = await Promise.all([redeem(base, codes[0]), redeem(base, codes[0])]);
  const ok = results.filter(result => result.status === 200);
  const denied = results.filter(result => result.status === 409);
  assert.equal(ok.length, 1);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].body.token, undefined);
  assert.equal(app.store.keys().length, 1);
  assert.equal(app.store.authenticate(ok[0].body.token).name, '体验：1天Opus');
});
