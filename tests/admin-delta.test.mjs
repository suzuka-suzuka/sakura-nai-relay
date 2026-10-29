import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { adminEvents, snapshotPatch } from '../src/admin-events.mjs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function frontend(extra = {}) {
  const context = createContext({ clearTimeout, ...extra });
  runInContext(source.slice(0, source.indexOf("document.addEventListener('click'")), context);
  return context;
}
const plain = value => JSON.parse(JSON.stringify(value));
const merge = frontend().mergeSnapshotPatch;

test('720 个密钥中仅一个余额变化时，传输单条记录；增删排序和最近记录滚动保持一致', () => {
  const before = { keys: Array.from({ length: 720 }, (_, id) => ({ id, name: '密钥'.repeat(20), balance: 100 })),
    jobs: [{ id: 'old', status: 'running' }, { id: 'evicted', status: 'completed' }], ledger: [], upstreams: [], stats: { requests: 2 } };
  const after = structuredClone(before); after.keys[500].balance = 90;
  const patch = snapshotPatch(before, after);
  assert.deepEqual(Object.keys(patch.collections), ['keys']);
  assert.equal(patch.collections.keys.upsert.length, 1);
  assert.equal(patch.collections.keys.order, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(patch)) < Buffer.byteLength(JSON.stringify(after)) / 100);
  assert.deepEqual(plain(merge(before, patch)), after);
  const next = structuredClone(after);
  next.keys = [{ id: 999, name: '新密钥', balance: 1 }, ...next.keys.slice(1).reverse()];
  next.jobs = [{ id: 'new', status: 'running' }, { id: 'old', status: 'completed' }];
  next.ledger = [{ id: 1, delta: -10 }]; next.upstreams = [{ id: 1, busy: true }];
  next.stats.requests = 3;
  assert.deepEqual(plain(merge(after, snapshotPatch(after, next))), next);
  const cleared = { ...next, keys: [], jobs: [], ledger: [], upstreams: [] };
  assert.deepEqual(plain(merge(next, snapshotPatch(next, cleared))), cleared);
  assert.equal(snapshotPatch(next, structuredClone(next)), null);
});

class Response extends EventEmitter {
  frames = []; blocked = false; destroyed = false; writableEnded = false;
  writeHead() {} flushHeaders() {}
  write(text) {
    if (text.startsWith('event:')) this.frames.push({ event: text.split('\n')[0].slice(7), data: JSON.parse(text.split('\ndata: ')[1]) });
    return !this.blocked;
  }
  end() { this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}
function publisher(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let data = { keys: [{ id: 1, balance: 100 }, { id: 2, balance: 200 }], jobs: [], upstreams: [], ledger: [] };
  let quota = { totalAnlas: 10, fetchedAt: 1 };
  let authorized = true;
  const events = adminEvents({ snapshot: () => structuredClone(data), session: () => { if (!authorized) throw Error('expired'); }, quota: async () => quota });
  t.after(() => events.close());
  const connect = (delta = true, blocked = false) => {
    const res = new Response(); res.blocked = blocked;
    events.connect({}, res, { expires: Date.now() + 3600000 }, { delta }); return res;
  };
  return { events, connect, update(value) { data = value; events.changed(); }, current: () => structuredClone(data),
    quota(value) { quota = value; return events.refreshQuota(); }, expire() { authorized = false; events.revalidate(); } };
}

test('合并连续变化，增量与旧版客户端同时同步；重连始终从完整快照开始', async t => {
  const f = publisher(t), delta = f.connect(), legacy = f.connect(false);
  const initial = delta.frames[0].data;
  const next = f.current(); next.keys[0].balance = 99; f.update(next);
  t.mock.timers.tick(250); next.keys[0].balance = 98; f.update(next);
  assert.equal(delta.frames.filter(f => f.event === 'patch').length, 0);
  t.mock.timers.tick(250);
  assert.deepEqual(delta.frames.map(f => f.event), ['snapshot', 'patch']);
  assert.deepEqual(plain(merge(initial, delta.frames[1].data)), next);
  assert.deepEqual(legacy.frames.at(-1), { event: 'snapshot', data: next });
  f.update(next); t.mock.timers.tick(500);
  assert.equal(delta.frames.length, 2);
  assert.deepEqual(f.connect().frames[0], { event: 'snapshot', data: next });
  f.expire(); assert.equal(delta.frames.at(-1).event, 'session-expired'); assert.equal(delta.writableEnded, true);
});

test('慢连接跳过中间状态但保留所有累计变化，客户端恢复后和最新快照一致', async t => {
  const f = publisher(t), res = f.connect(true, true), initial = res.frames[0].data;
  let next = f.current(); next.keys[0].balance = 99; f.update(next); t.mock.timers.tick(500);
  next = f.current(); next.keys[1].balance = 180; f.update(next); t.mock.timers.tick(500);
  next = f.current(); next.keys = [next.keys[1], { id: 3, balance: 50 }]; f.update(next); t.mock.timers.tick(500);
  assert.equal(res.frames.length, 1);
  res.blocked = false; res.emit('drain');
  assert.equal(res.frames[1].event, 'patch');
  let received = plain(merge(initial, res.frames[1].data)); assert.deepEqual(received, next);
  // A patch accepted by write(false) is already queued and must be the next baseline.
  res.blocked = true;
  next = f.current(); next.keys[0].balance = 170; f.update(next); t.mock.timers.tick(500);
  received = plain(merge(received, res.frames.at(-1).data));
  next = f.current(); next.keys[1].balance = 40; f.update(next); t.mock.timers.tick(500);
  res.blocked = false; res.emit('drain');
  assert.deepEqual(plain(merge(received, res.frames.at(-1).data)), next);
});

test('额度只有查询时间变化时不重复发送，余额变化仍推送', async t => {
  const f = publisher(t), res = f.connect();
  await f.events.refreshQuota();
  const count = () => res.frames.filter(f => f.event === 'quota').length;
  assert.equal(count(), 1);
  await f.quota({ totalAnlas: 10, fetchedAt: 2 }); assert.equal(count(), 1);
  await f.quota({ totalAnlas: 9, fetchedAt: 3 }); assert.equal(count(), 2);
});

test('默认请求列表复用实时数据，搜索或状态筛选仍查询完整历史', async () => {
  const calls = [], context = frontend({ document: { querySelector: () => null } });
  context.api = async (path, options) => { calls.push({ path, body: options.body }); return { jobs: [{ id: 'historical' }] }; };
  runInContext("state.data = { jobs: [{ id: 'recent' }] };", context);
  await context.loadFilteredJobs(); assert.equal(calls.length, 0);
  assert.equal(runInContext('state.filteredJobs[0].id', context), 'recent');
  runInContext("state.jobStatus = 'failed';", context);
  await context.loadFilteredJobs(); assert.equal(calls.length, 1);
  assert.equal(runInContext('state.filteredJobs[0].id', context), 'historical');
  runInContext("state.jobStatus = 'all'; state.jobQuery = '密钥';", context);
  await context.loadFilteredJobs(); assert.equal(calls.length, 2);
});

test('浏览器使用独立流基线合并增量，忽略旧连接事件，重连全量覆盖旧状态', () => {
  const connections = [], received = [];
  class EventSource {
    listeners = {};
    constructor(url) { this.url = url; connections.push(this); }
    addEventListener(event, fn) { this.listeners[event] = fn; }
    close() {}
    emit(event, data) { this.listeners[event]({ data: JSON.stringify(data) }); }
  }
  const context = frontend({ EventSource });
  context.applySnapshot = data => received.push(plain(data));
  runInContext("state.data = {}; state.csrf = 'test';", context);
  context.startEvents(); context.startEvents(); assert.equal(connections.length, 1);
  assert.equal(connections[0].url, '/admin/api/events?delta=1');
  const initial = { keys: [{ id: 1, balance: 100 }], jobs: [], stats: { requests: 1 } };
  connections[0].emit('snapshot', initial);
  runInContext('state.data = { keys: [], jobs: [], stats: { requests: 999 } };', context);
  const next = structuredClone(initial); next.keys[0].balance = 99;
  connections[0].emit('patch', snapshotPatch(initial, next));
  assert.deepEqual(received.at(-1), next);
  context.stopEvents(); context.startEvents();
  const count = received.length;
  connections[0].emit('snapshot', initial); assert.equal(received.length, count);
  connections[1].emit('snapshot', { ...next, jobs: [{ id: 'new' }] });
  assert.equal(received.at(-1).jobs[0].id, 'new');
});
