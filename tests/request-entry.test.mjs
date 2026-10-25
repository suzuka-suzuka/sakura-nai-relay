import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/db.mjs';

const path = '/ai/generate-image';
const payload = () => ({ model: 'nai-diffusion-5-full', action: 'generate', input: 'test',
  parameters: { width: 832, height: 1216, steps: 23, n_samples: 1 } });
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); }
  assert.fail('等待请求状态超时');
}
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sakura-entry-'));
  const state = { queryFailure: false, generations: 0 };
  const app = createApp({ dataDir: directory, publicOrigin: 'http://localhost:3100', fetcher: async url => {
    if (url.endsWith('/user/subscription')) {
      if (state.queryFailure) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }) });
      return Response.json({ tier: 3, active: true, trainingStepsLeft: { fixedTrainingStepsLeft: 10000, purchasedTrainingSteps: 0 }, usage: { percent: 50, isNegative: false } });
    }
    state.generations++;
    if (state.hold) await state.hold;
    return Response.json({ images: [{ image: 'result' }] });
  } });
  app.store.addUpstream({ token: 'pst-entry-test', name: '测试上游' });
  const key = app.store.createKey('测试用户', 1000);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' };
  const send = (options = {}) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(payload()), ...options });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, key, base, headers, send, state };
}

test('入口拒绝全部记录原因，失效密钥仍可关联，未知密钥不保存凭据', async t => {
  const f = await fixture(t);
  const check = async (options, status, reason, keyId = f.key.id) => {
    const response = await f.send(options), body = await response.json(), job = f.app.store.jobs()[0];
    assert.equal(response.status, status); assert.equal(job.response_status, status);
    assert.equal(body.requestId, job.id); assert.equal(response.headers.get('x-request-id'), job.id);
    assert.equal(job.key_id, keyId); assert.equal(job.upstream_id, null);
    assert.equal(job.status, 'failed'); assert.equal(job.charged, 0); assert.match(job.note, reason);
    const diagnostic = f.app.store.jobDiagnostics(job.id);
    assert.match(JSON.parse(diagnostic.failure_detail).message, reason);
    assert.ok(!JSON.stringify({ job, diagnostic }).includes(f.key.token));
  };
  await check({ headers: { ...f.headers, Origin: 'https://unlisted.example' } }, 403, /未获准/);
  await check({ method: 'GET', body: undefined }, 405, /方法/);
  await check({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private-invalid-token' } }, 401, /密钥无效/, null);
  f.app.store.updateKey(f.key.id, { enabled: false }); await check({}, 401, /停用/);
  f.app.store.updateKey(f.key.id, { enabled: true, expiresAt: Date.now() - 1 }); await check({}, 403, /已过期/);
  f.app.store.updateKey(f.key.id, { expiresAt: null }); f.app.store.set('enabled', 'false'); await check({}, 503, /暂停/);
  assert.equal(f.state.generations, 0); assert.equal(f.app.store.key(f.key.id).reserved, 0);
});

test('非法参数、余额不足、上游不可用和账户网络失败保存诊断且不扣费', async t => {
  const f = await fixture(t), before = f.app.store.ledger();
  for (const [options, reason] of [
    [{ body: '{bad json private-raw-body' }, /JSON/],
    [{ headers: { ...f.headers, 'Content-Type': 'text/plain' } }, /JSON/],
    [{ body: JSON.stringify({ ...payload(), parameters: { ...payload().parameters, steps: -1, api_key: 'private-cache' } }) }, /步数|steps|参数/],
  ]) {
    assert.ok((await f.send(options)).status >= 400);
    const job = f.app.store.jobs()[0], d = f.app.store.jobDiagnostics(job.id);
    assert.match(job.note, reason); assert.equal(job.charged, 0);
    assert.ok(!JSON.stringify(d).includes('private-cache')); assert.ok(!JSON.stringify(d).includes('private-raw-body'));
  }
  f.app.store.adjust(f.key.id, -1000, '测试扣除');
  assert.equal((await f.send()).status, 402); assert.match(f.app.store.jobs()[0].note, /Anlas 不足/);
  f.app.store.adjust(f.key.id, 1000, '测试恢复');
  f.app.store.updateUpstream(1, { enabled: false });
  assert.equal((await f.send()).status, 503); assert.match(f.app.store.jobs()[0].note, /没有启用/);
  f.app.store.updateUpstream(1, { enabled: true }); f.state.queryFailure = true;
  assert.equal((await f.send()).status, 502);
  const job = f.app.store.jobs()[0], d = f.app.store.jobDiagnostics(job.id);
  assert.match(job.note, /ECONNREFUSED/); assert.equal(JSON.parse(d.failure_detail).cause.code, 'ECONNREFUSED');
  assert.equal(f.app.store.key(f.key.id).balance, 1000); assert.equal(f.app.store.key(f.key.id).reserved, 0);
  assert.equal(f.app.store.ledger().filter(l => l.kind === 'usage').length, 0); assert.equal(before.length, 1);
});

test('重复幂等请求有独立失败记录，原任务保持一次结算', async t => {
  const f = await fixture(t), options = { headers: { ...f.headers, 'Idempotency-Key': 'same-request' } };
  assert.equal((await f.send(options)).status, 200);
  const first = f.app.store.jobs()[0];
  assert.equal((await f.send(options)).status, 409);
  const [duplicate, original] = f.app.store.jobs();
  assert.equal(original.id, first.id); assert.equal(original.status, 'completed');
  assert.match(duplicate.note, /重复/); assert.equal(duplicate.charged, 0); assert.equal(duplicate.idempotency, null);
  assert.equal(f.state.generations, 1); assert.equal(f.app.store.key(f.key.id).balance, 974);
});

test('密钥和上游排队时仅持久化，真实断连后显示取消，不预留或扣费', async t => {
  for (const queue of ['key', 'upstream']) await t.test(queue, async t => {
    const f = await fixture(t);
    const unlock = queue === 'key' ? await f.app.router.lockKey(f.key.id) : await f.app.router.lockUpstream(1);
    try {
      const controller = new AbortController();
      const request = f.send({ signal: controller.signal }).catch(error => error);
      await until(() => (queue === 'key' ? f.app.router.keyQueue.size(f.key.id) : f.app.router.upstreamQueue.size(1)) === 2);
      const job = f.app.store.db.prepare("SELECT * FROM jobs WHERE status='pending'").get();
      assert.equal(job.status, 'pending'); assert.match(job.stage, /排队/);
      assert.deepEqual(f.app.store.jobs(), []); assert.deepEqual(f.app.store.searchJobs(f.key.token), []);
      controller.abort(); await request;
      await until(() => f.app.store.jobs()[0]?.status === 'cancelled');
      const cancelled = f.app.store.jobs()[0];
      assert.equal(cancelled.id, job.id); assert.equal(cancelled.response_status, 499); assert.match(cancelled.note, /取消/);
      assert.equal(cancelled.charged, 0); assert.equal(cancelled.upstream_id, null);
      assert.equal(f.state.generations, 0); assert.equal(f.app.store.key(f.key.id).reserved, 0);
    } finally { unlock(); }
  });
});

test('上传中断和请求体过大也能保存，已开始生成后断连仍按结果结算', async t => {
  const f = await fixture(t);
  const partial = httpRequest(f.base + path, { method: 'POST', headers: { ...f.headers, 'Content-Length': '1000' } });
  partial.on('error', () => {}); partial.write('{');
  await until(() => f.app.store.db.prepare("SELECT id FROM jobs WHERE stage='读取请求'").get()); partial.destroy();
  await until(() => f.app.store.jobs()[0]?.status === 'cancelled');
  assert.match(f.app.store.jobs()[0].note, /断开/);
  await new Promise((resolve, reject) => {
    const oversized = httpRequest(f.base + path, { method: 'POST', headers: { ...f.headers, 'Content-Length': String(33 * 1024 * 1024) } }, res => {
      assert.equal(res.statusCode, 413); res.resume(); res.on('end', resolve);
    }); oversized.on('error', reject); oversized.end();
  });
  assert.match(f.app.store.jobs()[0].note, /过大/);
  let release; f.state.hold = new Promise(resolve => { release = resolve; });
  const controller = new AbortController(), request = f.send({ signal: controller.signal }).catch(error => error);
  await until(() => f.state.generations === 1); controller.abort(); await request;
  await until(() => f.app.store.jobs()[0].client_disconnected_at); release();
  await until(() => f.app.store.jobs()[0].status === 'completed');
  assert.equal(f.app.store.jobs()[0].charged, 26); assert.equal(f.app.store.key(f.key.id).balance, 974);
  assert.match(f.app.store.jobs()[0].note, /客户端已断开/);
});

test('成功额度查询和预检不增加记录，失败查询与预检保存原因', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/user/subscription', { headers: f.headers })).status, 200);
  assert.equal((await f.send({ method: 'OPTIONS', body: undefined })).status, 204);
  assert.equal(f.app.store.jobs().length, 0);
  assert.equal((await fetch(f.base + '/user/subscription')).status, 401);
  assert.equal((await f.send({ method: 'OPTIONS', body: undefined, headers: { Origin: 'https://unlisted.example' } })).status, 403);
  assert.equal(f.app.store.jobs().length, 2); assert.ok(f.app.store.jobs().every(j => j.status === 'failed'));
});

test('标签查询断连也保留取消记录，迟到的上游结果不覆盖取消状态', async t => {
  const f = await fixture(t);
  let release; f.state.hold = new Promise(resolve => { release = resolve; });
  try {
    const controller = new AbortController();
    const request = fetch(f.base + '/ai/generate-image/suggest-tags?tag=cat', { headers: f.headers, signal: controller.signal }).catch(error => error);
    await until(() => f.state.generations === 1); controller.abort(); await request;
    await until(() => f.app.store.jobs()[0]?.status === 'cancelled');
    const job = f.app.store.jobs()[0];
    assert.equal(job.stage, '标签查询'); assert.equal(job.response_status, 499); assert.match(job.note, /查询已取消/);
    assert.equal(job.charged, 0); assert.equal(f.app.store.key(f.key.id).balance, 1000);
  } finally { release(); }
});

test('旧库迁移保留任务、诊断和账单；入口记录重启后终结且不重复结算', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sakura-entry-'));
  let store = new Store(directory), db;
  try {
    store.addUpstream({ token: 'pst-migration' }); const key = store.createKey('用户', 100);
    store.reserve(key.id, 'old', path, 'nai-diffusion-5-full', 26, 'original', 1);
    store.settle('old', 26, 'completed', '成功', 200);
    store.saveJobDiagnostics('old', { request: { input: 'old' }, upstreamError: 'preserved' });
    const ledger = store.ledger(); store.close(); store = null;
    db = new DatabaseSync(join(directory, 'relay.sqlite'));
    db.exec('PRAGMA foreign_keys=OFF');
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='jobs'").get().sql
      .replace('CREATE TABLE jobs', 'CREATE TABLE legacy_jobs').replace(/(key_id|upstream_id) INTEGER REFERENCES/g, '$1 INTEGER NOT NULL REFERENCES');
    db.exec(`${schema}; INSERT INTO legacy_jobs SELECT * FROM jobs; DROP TABLE jobs; ALTER TABLE legacy_jobs RENAME TO jobs;`);
    db.close(); db = null; store = new Store(directory);
    assert.equal(store.jobs()[0].charged, 26); assert.equal(store.jobDiagnostics('old').upstream_error, 'preserved');
    assert.deepEqual(store.ledger(), ledger); assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    store.beginRequest('pending', path, 'POST', key.token); store.requestStage('pending', '密钥排队');
    store.beginRequest('anonymous', path, 'POST', null);
    store.close(); store = new Store(directory);
    assert.equal(store.jobs().length, 3);
    assert.ok(store.jobs().filter(j => j.id !== 'old').every(j => j.status === 'failed' && j.charged === 0 && /服务中断/.test(j.note)));
    assert.equal(store.key(key.id).balance, 74); assert.deepEqual(store.ledger(), ledger);
    store.close(); store = new Store(directory); assert.deepEqual(store.ledger(), ledger);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db?.close(); store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
