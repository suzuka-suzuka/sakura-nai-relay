import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { mockUpstream } from './mock.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sakura-admin-events-')), mock = await mockUpstream();
  const origin = 'http://127.0.0.1:3100', app = createApp({ dataDir: directory, publicOrigin: origin, upstreamOrigin: mock.origin });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie, csrf;
  const call = (path, method = 'GET', body, extra = {}) => fetch(base + path, {
    method, headers: { Origin: origin, Cookie: cookie ?? '', 'X-CSRF-Token': csrf ?? '', 'Content-Type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setup = await call('/admin/api/setup', 'POST', { code: readFileSync(join(directory, 'setup-code.txt'), 'utf8'), password: 'test-only-password-123' });
  cookie = setup.headers.get('set-cookie').split(';')[0]; csrf = (await setup.json()).csrf;
  const response = await call('/admin/api/upstreams', 'POST', { token: 'pst-local-test', name: 'Mock', enabled: true });
  assert.equal(response.status, 201);
  const key = await (await call('/admin/api/keys', 'POST', { name: '实时测试', points: 100 })).json();
  async function stream(headers = {}) {
    const response = await call('/admin/api/events', 'GET', undefined, headers);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = response.body.getReader(), decoder = new TextDecoder(), queued = []; let buffer = '';
    t.after(() => reader.cancel().catch(() => {}));
    async function next(event, match = () => true) {
      const timeout = setTimeout(() => { void reader.cancel(); }, 4000);
      try {
        while (true) {
          const index = queued.findIndex(frame => frame.event === event && match(frame.data));
          if (index >= 0) return queued.splice(index, 1)[0].data;
          const end = buffer.indexOf('\n\n');
          if (end >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (!frame.startsWith('event: ')) continue;
            queued.push({ event: frame.split('\n')[0].slice(7), data: JSON.parse(frame.split('\ndata: ')[1]) });
            continue;
          }
          const part = await reader.read();
          assert.equal(part.done, false, `连接在收到 ${event} 前关闭`);
          buffer += decoder.decode(part.value, { stream: true });
        }
      } finally { clearTimeout(timeout); }
    }
    return { next, reader };
  }
  let stopped = false;
  const close = async () => { if (stopped) return; stopped = true; await app.close(); await mock.close(); rmSync(directory, { recursive: true, force: true }); };
  t.after(close);
  return { app, mock, base, origin, call, key, stream, cookie, csrf, close };
}

test('SSE 需要管理会话和同源来源，快照与额度均不泄露完整凭据', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/admin/api/events')).status, 401);
  assert.equal((await f.call('/admin/api/events', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.call('/admin/api/events', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const stream = await f.stream(), data = await stream.next('snapshot'), quota = await stream.next('quota');
  assert.equal(data.keys[0].id, f.key.id); assert.ok(data.cdks.products.length);
  assert.equal(quota.totalAnlas, 10000);
  for (const secret of [f.key.token, 'pst-local-test', 'private@example.com', 'SHOULD_NOT_LEAK', f.csrf]) {
    assert.ok(!JSON.stringify([data, quota]).includes(secret));
  }
});

test('两条 SSE 连接同步收到余额、流水、兑换库存与兑换记录；重连取得最新快照', async t => {
  const f = await fixture(t), a = await f.stream(), b = await f.stream();
  await a.next('snapshot'); await b.next('snapshot');
  await f.call(`/admin/api/keys/${f.key.id}/points`, 'POST', { delta: 5 });
  for (const stream of [a, b]) {
    const data = await stream.next('snapshot', data => data.keys[0].balance === 105);
    assert.equal(data.ledger[0].delta, 5);
  }
  const stock = await (await f.call('/admin/api/cdks', 'POST', { product: 'month-shared', count: 1 })).json();
  const minted = await a.next('snapshot', data => data.cdks.products.some(p => p.id === 'month-shared' && p.unused === 1));
  assert.ok(!JSON.stringify(minted).includes(stock.codes[0]));
  const redeemed = await fetch(f.base + '/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: stock.codes[0] }) });
  assert.equal(redeemed.status, 200);
  const data = await a.next('snapshot', data => data.cdks.redemptions.length === 1);
  assert.equal(data.keys.length, 2); assert.equal(data.cdks.redemptions[0].product_id, 'month-shared');
  await a.reader.cancel();
  const reconnected = await f.stream(), latest = await reconnected.next('snapshot');
  assert.equal(latest.keys.length, 2); assert.equal(latest.ledger.find(row => row.kind === 'adjust').delta, 5);
});

test('真实生成执行中及结算后推送状态、扣点、上游忙闲和额度', async t => {
  const f = await fixture(t), stream = await f.stream();
  await stream.next('snapshot'); await stream.next('quota'); f.mock.state.slow = 200;
  const pending = fetch(f.base + '/ai/generate-image', {
    method: 'POST', headers: { Authorization: `Bearer ${f.key.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nai-diffusion-5-full', action: 'generate', input: 'test', parameters: { width: 832, height: 1216, steps: 23, n_samples: 1 } }),
  });
  const running = await stream.next('snapshot', data => data.jobs[0]?.status === 'running');
  assert.equal(running.busy, true); assert.equal(running.keys[0].reserved, 26);
  const response = await pending; assert.equal(response.status, 200); await response.arrayBuffer();
  const completed = await stream.next('snapshot', data => data.jobs[0]?.status === 'completed' && !data.busy);
  assert.equal(completed.keys[0].balance, 74); assert.equal(completed.keys[0].reserved, 0);
  assert.equal(completed.stats.spent, 26); assert.equal(completed.ledger[0].kind, 'usage');
  const quota = await stream.next('quota', data => data.totalAnlas === 9974);
  assert.equal(quota.failed, 0);
});

test('上游新增的兑换码作废功能会实时更新库存，作废已兑换码也推送密钥停用状态', async t => {
  const f = await fixture(t);
  const stock = await (await f.call('/admin/api/cdks', 'POST', { product: 'trial-100', count: 2 })).json();
  const redeemed = await (await fetch(f.base + '/api/redeem', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: stock.codes[1] }),
  })).json();
  const keyId = f.app.store.authenticate(redeemed.token).id;
  const stream = await f.stream(); await stream.next('snapshot');
  assert.equal((await f.call('/admin/api/cdks/void', 'POST', { code: stock.codes[0] })).status, 200);
  const voided = await stream.next('snapshot', data => data.cdks.products.some(product => product.id === 'trial-100' && product.voided === 1));
  const product = voided.cdks.products.find(product => product.id === 'trial-100');
  assert.equal(product.unused, 0); assert.equal(product.redeemed, 1);
  assert.equal((await f.call('/admin/api/cdks/void', 'POST', { code: stock.codes[1], disableKey: true })).status, 200);
  const disabled = await stream.next('snapshot', data => data.keys.find(key => key.id === keyId)?.enabled === 0);
  for (const secret of [...stock.codes, redeemed.token]) assert.ok(!JSON.stringify(disabled).includes(secret));
});

test('退出登录会立即终止同会话所有推送，失效会话不能重连', async t => {
  const f = await fixture(t), a = await f.stream(), b = await f.stream();
  await a.next('snapshot'); await b.next('snapshot');
  assert.equal((await f.call('/admin/api/logout', 'POST', {})).status, 200);
  await a.next('session-expired'); await b.next('session-expired');
  assert.equal((await f.call('/admin/api/events')).status, 401);
});

test('改密撤销旧连接，重新登录会话可以恢复 SSE', async t => {
  const f = await fixture(t), stream = await f.stream(); await stream.next('snapshot');
  const password = await f.call('/admin/api/password', 'POST', { current: 'test-only-password-123', password: 'new-test-password-456' });
  assert.equal(password.status, 200); await stream.next('session-expired');
  assert.equal((await f.call('/admin/api/events')).status, 401);
  const cookie = password.headers.get('set-cookie').split(';')[0];
  const fresh = await f.stream({ Cookie: cookie }); assert.equal((await fresh.next('snapshot')).keys.length, 1);
});

test('每次推送前重新校验会话，失效后不再发送管理数据', async t => {
  const f = await fixture(t), stream = await f.stream(); await stream.next('snapshot');
  f.app.store.db.prepare('UPDATE sessions SET expires=?').run(Date.now() - 1);
  f.app.store.adjust(f.key.id, 1, '');
  await stream.next('session-expired');
});

test('超过输出缓冲区的大快照完整送达，后续变化仍可推送', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 230; index++) f.app.store.createKey(`大快照-${index}-` + '测'.repeat(40), 0);
  const stream = await f.stream(), initial = await stream.next('snapshot');
  assert.ok(Buffer.byteLength(JSON.stringify(initial)) > 65536);
  assert.equal(initial.keys.length, 231);
  f.app.store.adjust(f.key.id, 2, '');
  const updated = await stream.next('snapshot', data => data.keys.find(key => key.id === f.key.id).balance === 102);
  assert.equal(updated.keys.length, 231);
});

test('服务关闭会结束仍打开的 SSE，停止等待长连接', async t => {
  const f = await fixture(t), stream = await f.stream(); await stream.next('snapshot');
  await f.close();
  while (!(await stream.reader.read()).done) { /* Drain already delivered quota events. */ }
});
