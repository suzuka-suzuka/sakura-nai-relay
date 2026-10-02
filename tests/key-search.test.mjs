import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const keys = [1, 2].map(id => ({ id, name: `用户${id}`, prefix: `skr_short${id}…end${id}`, tier: 'standard',
  enabled: 1, expires_at: null, balance: 0, reserved: 0 }));

async function fixture() {
  const events = {}, requests = [], timers = new Map(), notices = [], table = { innerHTML: '' };
  let nextTimer = 0;
  const context = createContext({
    initialKeys: keys,
    document: {
      addEventListener(type, handler) { events[type] = handler; },
      createElement() { return { remove() {} }; },
      querySelector(selector) { return {
        '#app': {}, '#dialog': { addEventListener() {} }, '#key-table': table,
        '#toasts': { append(node) { notices.push(node.textContent); } },
      }[selector]; },
    },
    navigator: {}, location: { hash: '' }, window: { addEventListener() {} },
    setTimeout(callback, delay) { const id = ++nextTimer; if (delay === 200) timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(path, options) {
      if (path === '/admin/api/status') return Promise.resolve({ ok: true, json: async () => ({ loggedIn: false, initialized: true }) });
      return new Promise(resolve => requests.push({ path, options,
        reply(ids) { resolve({ ok: true, json: async () => ({ ids }) }); },
        fail() { resolve({ ok: false, status: 503, json: async () => ({ error: '查询暂不可用' }) }); },
      }));
    },
  });
  runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  runInContext("state.data = { keys: initialKeys }; state.csrf = 'test-csrf'; state.view = 'keys'", context);
  return { requests, table, notices,
    input(value) { events.input({ target: { id: 'key-search', value } }); },
    flush() { const [id, callback] = timers.entries().next().value; timers.delete(id); return callback(); },
    ids() { return Array.from(runInContext('filteredKeys().map(key => key.id)', context)); },
  };
}

test('输入隐藏密钥片段后使用经过防抖的受保护 POST 查询，并显示对应记录', async () => {
  const f = await fixture();
  f.input('hidden'); f.input('  hidden-fragment  ');
  assert.equal(f.requests.length, 0);
  assert.match(f.table.innerHTML, /正在搜索/); assert.doesNotMatch(f.table.innerHTML, /没有匹配|暂无访问密钥/);
  const pending = f.flush(), request = f.requests[0];
  assert.match(f.table.innerHTML, /正在搜索/); assert.doesNotMatch(f.table.innerHTML, /没有匹配|暂无访问密钥/);
  assert.equal(request.path, '/admin/api/keys/search'); assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { query: 'hidden-fragment' });
  assert.equal(request.options.headers['X-CSRF-Token'], 'test-csrf');
  request.reply([2]); await pending;
  assert.deepEqual(f.ids(), [2]); assert.match(f.table.innerHTML, /用户2/); assert.doesNotMatch(f.table.innerHTML, /用户1/);
});

test('较早的搜索响应不能覆盖新的结果，清空搜索后迟到的响应也不能重新筛选', async () => {
  const f = await fixture();
  f.input('old-hidden'); const older = f.flush();
  f.input('new-hidden'); const newer = f.flush();
  f.requests[1].reply([2]); await newer;
  f.requests[0].reply([1]); await older;
  assert.deepEqual(f.ids(), [2]);
  f.input('another-hidden'); const late = f.flush();
  f.input('   '); assert.deepEqual(f.ids(), [1, 2]);
  f.requests[2].reply([1]); await late;
  assert.deepEqual(f.ids(), [1, 2]); assert.match(f.table.innerHTML, /用户1/); assert.match(f.table.innerHTML, /用户2/);
  assert.doesNotMatch(f.table.innerHTML, /正在搜索/);
});

test('只有当前服务端查询完成且结果为空时才显示没有匹配，下一次查询立即进入搜索状态', async () => {
  const f = await fixture();
  f.input('missing'); const pending = f.flush();
  assert.doesNotMatch(f.table.innerHTML, /没有匹配/);
  f.requests[0].reply([]); await pending;
  assert.match(f.table.innerHTML, /没有匹配的密钥/); assert.doesNotMatch(f.table.innerHTML, /正在搜索/);
  f.input('existing-hidden');
  assert.match(f.table.innerHTML, /正在搜索/); assert.doesNotMatch(f.table.innerHTML, /没有匹配/);
  const found = f.flush(); f.requests[1].reply([1]); await found;
  assert.match(f.table.innerHTML, /用户1/); assert.doesNotMatch(f.table.innerHTML, /没有匹配|正在搜索/);
});

test('搜索失败显示失败状态，旧查询的空结果和失败都不能覆盖正在进行的新查询', async () => {
  const f = await fixture();
  f.input('failed'); const failed = f.flush(); f.requests[0].fail(); await failed;
  assert.match(f.table.innerHTML, /搜索失败/); assert.doesNotMatch(f.table.innerHTML, /没有匹配|正在搜索/);
  f.input('old-missing'); const older = f.flush();
  f.input('old-failure'); const stale = f.flush();
  f.input('new-hidden'); const newer = f.flush();
  f.requests[1].reply([]); await older; f.requests[2].fail(); await stale;
  assert.match(f.table.innerHTML, /正在搜索/); assert.doesNotMatch(f.table.innerHTML, /没有匹配|搜索失败/);
  assert.equal(f.notices.length, 1);
  f.requests[3].reply([2]); await newer;
  assert.match(f.table.innerHTML, /用户2/); assert.doesNotMatch(f.table.innerHTML, /没有匹配|搜索失败|正在搜索/);
});
