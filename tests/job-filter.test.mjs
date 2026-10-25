import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { createApp } from '../src/server.mjs';
import { hash } from '../src/security.mjs';

test('管理员按 Key 查询完整历史中的最近 100 条，保留已删除 Key 且不泄漏凭据', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sakura-job-filter-'));
  const app = createApp({ dataDir: directory, publicOrigin: 'http://localhost:3100' });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = app.store, upstream = store.addUpstream({ name: '上游', token: 'pst-filter-test' });
  const a = store.createKey('同名', 100), b = store.createKey('同名', 100), unused = store.createKey('未使用', 0);
  const prefixA = store.key(a.id).prefix;
  store.beginRequest('old-failure', '/ai/generate-image', 'POST', a.token);
  store.finishPending('old-failure', '余额不足', 402);
  store.beginRequest('anonymous-failure', '/ai/generate-image', 'POST', null);
  store.finishPending('anonymous-failure', '密钥无效', 401);
  store.beginRequest('old-cancelled', '/ai/generate-image', 'POST', b.token);
  store.finishPending('old-cancelled', '排队取消', 499, true);
  for (const [key, prefix, count] of [[a, 'old', 105], [b, 'new', 110]]) {
    for (let i = 0; i < count; i++) {
      store.reserve(key.id, `${prefix}-${i}`, '/ai/generate-image', 'nai-diffusion-4', 0, null, upstream);
      store.settle(`${prefix}-${i}`, 0, 'completed', '', 200);
    }
  }
  store.retireKey(a.id);
  store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash('filter-admin'), 'csrf', Date.now() + 60000);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/admin/api`;
  const get = path => fetch(base + path, { headers: { Cookie: 'sakura_session=filter-admin' } });
  assert.equal((await fetch(base + '/jobs?keyId=' + a.id)).status, 401);
  const snapshot = await (await get('/snapshot')).json();
  assert.equal(snapshot.jobs.length, 100);
  assert.ok(snapshot.jobs.every(j => j.key_id === b.id));
  const { jobs } = await (await get('/jobs?keyId=' + a.id)).json();
  assert.equal(jobs.length, 100);
  assert.equal(jobs[0].id, 'old-104'); assert.equal(jobs[99].id, 'old-5');
  assert.ok(jobs.every(j => j.key_id === a.id && j.key_prefix === prefixA));
  const encoded = JSON.stringify({ jobs });
  for (const secret of [a.token, b.token, 'token_hash', 'token_encrypted', 'pst-filter-test']) assert.ok(!encoded.includes(secret));
  assert.deepEqual((await (await get('/jobs?keyId=' + unused.id)).json()).jobs, []);
  assert.deepEqual((await (await get('/jobs?keyId=999999')).json()).jobs, []);
  for (const value of ['', '-1', '0', '1.2', '1e2', 'abc', '9007199254740992', '1%20OR%201=1']) {
    assert.equal((await get('/jobs?keyId=' + value)).status, 400);
  }
  assert.deepEqual((await (await get('/jobs')).json()).jobs, snapshot.jobs);
  const search = (query, headers = {}, status) => fetch(base + '/jobs/search', { method: 'POST', headers: {
    Cookie: 'sakura_session=filter-admin', Origin: 'http://localhost:3100', 'X-CSRF-Token': 'csrf',
    'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ query, status }) });
  for (const query of [prefixA, a.token, '  ' + prefixA + '  ']) {
    const result = await search(query); assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).jobs, jobs);
  }
  for (const query of [b.token, b.token.slice(-8), store.key(b.id).prefix, '同名']) {
    const result = await search(query); assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).jobs, snapshot.jobs);
  }
  assert.deepEqual((await (await search('   ')).json()).jobs, snapshot.jobs);
  for (const query of ['不存在的名称', '未使用', "%_' OR 1=1"]) assert.deepEqual((await (await search(query)).json()).jobs, []);
  assert.equal((await search(b.token, { Cookie: '' })).status, 401);
  assert.equal((await search(b.token, { 'X-CSRF-Token': '' })).status, 403);
  for (const query of [null, 123, 'a'.repeat(257)]) assert.equal((await search(query)).status, 400);
  assert.ok(!store.searchKeys(prefixA).includes(a.id));

  const ids = response => response.json().then(data => data.jobs.map(job => job.id));
  assert.deepEqual(await ids(await get('/jobs?status=failed')), ['anonymous-failure', 'old-failure']);
  assert.deepEqual(await ids(await get('/jobs?status=cancelled')), ['old-cancelled']);
  assert.deepEqual(await ids(await get(`/jobs?status=failed&keyId=${a.id}`)), ['old-failure']);
  assert.deepEqual(await ids(await search('', {}, 'failed')), ['anonymous-failure', 'old-failure']);
  assert.deepEqual(await ids(await search(a.token, {}, 'failed')), ['old-failure']);
  assert.deepEqual(await ids(await search(b.token, {}, 'failed')), []);
  assert.deepEqual(await ids(await search(b.token, {}, 'cancelled')), ['old-cancelled']);
  for (const status of ['', 'unknown', "failed' OR 1=1", null, 1, ['failed']]) {
    assert.equal((await search('', {}, status)).status, 400);
  }
  assert.equal((await get('/jobs?status=unknown')).status, 400);
  assert.equal((await fetch(base + '/jobs?status=failed')).status, 401);
  // Legacy rejected rows belong to the failure filter too.
  store.db.prepare("UPDATE jobs SET status='rejected' WHERE id='old-failure'").run();
  assert.deepEqual(await ids(await search(a.token, {}, 'failed')), ['old-failure']);

});

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function ui() {
  const context = createContext({ clearTimeout, setTimeout, document: { querySelector: () => null } });
  runInContext(source.slice(0, source.indexOf("document.addEventListener('click'")), context);
  runInContext("state.data = { keys: [], jobs: [], ledger: [] };", context);
  return context;
}
const job = id => ({ id, key_id: 1, key_name: '<同名>', key_prefix: 'sk-a…1', endpoint: '/ai/generate-image', model: 'nai-diffusion-4', status: 'completed' });

test('匿名失败与取消记录显示原因、阶段及本地状态，详情不会把未知 Key 当成已删除', async () => {
  const context = ui();
  context.rows = [{ ...job('cancelled-request'), key_id: null, key_name: null, key_prefix: null, model: null,
    upstream_name: '', status: 'cancelled', stage: '密钥排队', response_status: 499, http_status: null,
    request_method: 'POST', charged: 0, note: '客户端断开 <script>secret</script>' }];
  runInContext('state.data.jobs = rows;', context);
  const html = context.jobTable();
  assert.match(html, /已取消/); assert.match(html, /未识别密钥/); assert.match(html, /未选择上游/);
  assert.match(html, /客户端断开 &lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  runInContext("modal = (title, html) => { globalThis.detailHTML = html; }; api = async () => ({ diagnostics: null });", context);
  await context.jobDetail('cancelled-request');
  assert.match(context.detailHTML, /密钥排队/); assert.match(context.detailHTML, /响应状态<\/dt><dd>499/);
  assert.match(context.detailHTML, /上游 HTTP 状态<\/dt><dd>—/); assert.doesNotMatch(context.detailHTML, /密钥已删除/);
});

test('请求列表用正常字号标识 Key，筛选旧记录后详情仍可打开', async () => {
  const context = ui(); context.rows = [job('old-request')];
  runInContext("state.jobQuery = '1'; state.filteredJobs = rows;", context);
  const html = context.usageView();
  assert.match(html, /type="search"/); assert.match(html, /value="1"/); assert.doesNotMatch(html, /<select|<option/);
  assert.match(html, /&lt;同名&gt;/); assert.match(html, /sk-a…1/);
  assert.doesNotMatch(html, /<small|最近 100 条/);
  runInContext("modal = (title, html) => { globalThis.detailHTML = html; }; api = async () => ({ diagnostics: null });", context);
  await context.jobDetail('old-request');
  assert.match(context.detailHTML, /old-request/); assert.match(context.detailHTML, /sk-a…1/);
  assert.match(context.detailHTML, /disabled>密钥已删除/);
  runInContext("state.data.keys = [{ id: 1, enabled: false, expires_at: 1 }];", context);
  await context.jobDetail('old-request');
  assert.match(context.detailHTML, /data-action="reveal-job-key" data-id="1" >查看密钥/);
  assert.doesNotMatch(context.detailHTML, /id="new-token"/);
});

test('请求详情按需读取完整 Key，关闭或切换详情后丢弃迟到的密钥响应', async () => {
  const context = ui(), container = { isConnected: true, innerHTML: '' }, pending = [];
  context.document = { querySelector: selector => selector === '#job-key-secret' ? container : null };
  context.request = (path, options) => new Promise(resolve => pending.push({ path, options, resolve }));
  runInContext('api = request;', context);
  const revealed = context.revealJobKey(1);
  assert.equal(pending[0].path, '/keys/1/reveal');
  assert.equal(pending[0].options.method, 'POST');
  assert.equal(container.innerHTML, '');
  pending[0].resolve({ token: 'skr-test<secret>' }); await revealed;
  assert.match(container.innerHTML, /id="new-token"/);
  assert.match(container.innerHTML, /skr-test&lt;secret&gt;/);
  assert.match(container.innerHTML, /data-action="copy-key">复制密钥/);
  const stale = context.revealJobKey(1);
  container.isConnected = false; container.innerHTML = '';
  pending[1].resolve({ token: 'skr-stale-secret' }); await stale;
  assert.equal(container.innerHTML, '');
});

test('快速切换 Key 时忽略迟到响应和错误，清除筛选后恢复全部记录', async () => {
  const context = ui(), pending = [];
  context.request = (path, options) => new Promise((resolve, reject) => pending.push({ path, options, resolve, reject }));
  runInContext("api = request; state.jobQuery = '1';", context);
  const first = context.loadFilteredJobs();
  runInContext("state.jobQuery = '2';", context);
  const second = context.loadFilteredJobs();
  pending[1].resolve({ jobs: [job('second')] }); await second;
  pending[0].reject(new Error('过期错误')); await first;
  assert.equal(context.visibleJobs()[0].id, 'second');
  const third = context.loadFilteredJobs();
  runInContext("state.jobQuery = ''; state.data.jobs = [{ id: 'all' }]; jobSearchVersion++;", context);
  pending[2].resolve({ jobs: [job('stale')] }); await third;
  assert.equal(context.visibleJobs()[0].id, 'all');
  assert.equal(pending[0].path, '/jobs/search');
  assert.equal(pending[0].options.method, 'POST');
  assert.equal(pending[0].options.body.query, '1');
});

test('状态筛选可单独使用或组合 Key，切换后忽略旧响应，实时更新保留筛选', async () => {
  const context = ui(), pending = [];
  context.request = (path, options) => new Promise((resolve, reject) => pending.push({ path, options, resolve, reject }));
  runInContext("api = request; state.jobStatus = 'failed';", context);
  assert.match(context.usageView(), /data-status="failed" class="selected" aria-pressed="true"/);
  const first = context.loadFilteredJobs();
  assert.equal(pending[0].options.body.query, ''); assert.equal(pending[0].options.body.status, 'failed');
  runInContext("state.jobStatus = 'cancelled'; state.jobQuery = '用户';", context);
  const second = context.loadFilteredJobs();
  pending[1].resolve({ jobs: [{ ...job('cancelled'), status: 'cancelled' }] }); await second;
  pending[0].resolve({ jobs: [job('stale-failure')] }); await first;
  assert.equal(context.visibleJobs()[0].id, 'cancelled');
  assert.equal(pending[1].options.body.query, '用户'); assert.equal(pending[1].options.body.status, 'cancelled');
  context.updateJobSearch('');
  const third = context.loadFilteredJobs();
  assert.equal(pending[2].options.body.status, 'cancelled'); assert.equal(pending[2].options.body.query, '');
  pending[2].resolve({ jobs: [] }); await third;
  assert.match(context.jobTable(), /没有匹配的请求记录/);
  runInContext("state.view = 'usage';", context);
  context.applySnapshot({ keys: [], jobs: [job('new-success')], cdks: {} });
  assert.equal(pending[3].options.body.status, 'cancelled');
  pending[3].resolve({ jobs: [{ ...job('live-cancelled'), status: 'cancelled' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.visibleJobs()[0].id, 'live-cancelled');
  runInContext("state.jobStatus = 'all';", context); context.updateJobSearch('');
  assert.equal(context.visibleJobs()[0].id, 'new-success');
});
