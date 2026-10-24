import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, runInContext } from 'node:vm';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/db.mjs';
import { hash } from '../src/security.mjs';
import { requestDiagnostics, redactDiagnosticText } from '../src/request-diagnostics.mjs';
import { canvasPng, image } from './mock.mjs';

const payload = () => ({ model: 'nai-diffusion-5-full', action: 'generate', input: '1girl, 桜',
  parameters: { width: 1024, height: 1024, steps: 23, n_samples: 1, seed: 42, stream: 'msgpack' } });
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sakura-diagnostics-'));
  const state = { response: () => new Response('rejected', { status: 400 }) };
  const app = createApp({ dataDir: directory, publicOrigin: 'http://127.0.0.1:3100', fetcher: async url => {
    if (url.endsWith('/user/subscription')) return Response.json({ tier: 3, active: true,
      trainingStepsLeft: { fixedTrainingStepsLeft: 10000, purchasedTrainingSteps: 0 }, usage: { percent: 50, isNegative: false } });
    return state.response();
  } });
  app.store.addUpstream({ token: 'pst-diagnostics-token', name: '测试上游' });
  const key = app.store.createKey('测试用户', 1000);
  app.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash('diagnostics-admin'), 'csrf', Date.now() + 60000);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const relay = (path, body) => fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${key.token}`,
    ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body instanceof FormData ? body : JSON.stringify(body) });
  const admin = path => fetch(base + '/admin/api' + path, { headers: { Cookie: 'sakura_session=diagnostics-admin' } });
  t.after(async () => {
    await app.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'sakura-diagnostics-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, state, key, relay, admin, base };
}

test('HTTP 失败保存超过 800 字的上游原文和实际参数，仅管理员按需读取', async t => {
  const f = await fixture(t), request = payload(); request.action = 'img2img';
  Object.assign(request.parameters, { image: canvasPng(832, 1216).toString('base64'), strength: 0.7, noise: 0.1, image_cache_secret_key: 'private-cache' });
  const detail = '尺寸不匹配：832×1216 -> 1024×1024\n' + '上游详细原因。'.repeat(200);
  for (const status of [400, 401, 403, 429, 503]) {
    f.app.router.cooldowns.clear();
    f.state.response = () => new Response(detail + `\npst-diagnostics-token ${f.key.token} ${request.parameters.image} private-cache`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const response = await f.relay('/ai/generate-image', request);
    assert.equal(response.status, status); const publicBody = await response.text(); assert.ok(!publicBody.includes(detail));
    const job = f.app.store.jobs()[0], result = await f.admin('/jobs/' + job.id);
    assert.equal(result.status, 200); const { diagnostics: d } = await result.json();
    assert.equal(d.upstream_error, detail + '\n[已脱敏] [已脱敏] [已脱敏] [已脱敏]');
    assert.equal(d.response_content_type, 'text/plain; charset=utf-8');
    const saved = JSON.parse(d.request_json);
    assert.equal(saved.input, request.input); assert.equal(saved.parameters.width, 1024); assert.equal(saved.parameters.seed, 42);
    assert.deepEqual(saved.parameters.image, { omitted: 'image data', bytes: Buffer.from(request.parameters.image, 'base64').length, width: 832, height: 1216 });
    assert.equal(saved.parameters.image_cache_secret_key, '[已脱敏]');
    assert.equal(job.http_status, status); assert.equal(job.charged, 0);
    const snapshot = await (await f.admin('/snapshot')).json();
    assert.equal(snapshot.jobs[0].request_json, undefined); assert.equal(snapshot.jobs[0].upstream_error, undefined);
    assert.equal((await fetch(f.base + '/admin/api/jobs/' + job.id)).status, 401);
    assert.equal((await fetch(f.base + '/admin/api/jobs/' + job.id, { headers: { Authorization: `Bearer ${f.key.token}` } })).status, 401);
  }
  assert.equal(f.app.store.key(f.key.id).balance, 1000); assert.equal(f.app.store.key(f.key.id).reserved, 0);
});

test('multipart 日志读取实际图片尺寸，流参数记录最终转发的 SSE 值', async t => {
  const f = await fixture(t), request = payload(); request.action = 'img2img';
  request.input = 'image';
  Object.assign(request.parameters, { image: 'image', strength: 0.7, noise: 0, image_cache_secret_key: 'cache-secret' });
  const form = new FormData(); form.append('image', new Blob([canvasPng(832, 1216)]), 'source.png');
  form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
  assert.equal((await f.relay('/ai/generate-image-stream', form)).status, 400);
  const d = f.app.store.jobDiagnostics(f.app.store.jobs()[0].id), saved = JSON.parse(d.request_json);
  assert.equal(saved.input, 'image');
  assert.equal(saved.parameters.stream, 'sse'); assert.equal(saved.parameters.image.part, 'image');
  assert.equal(saved.parameters.image.width, 832); assert.equal(saved.parameters.image.height, 1216);
  assert.ok(!d.request_json.includes('cache-secret')); assert.ok(!d.request_json.includes(image));
});

test('HTTP 200 的流内报错记录原始 SSE 错误，缺少最终图片记录收到数量', async t => {
  const f = await fixture(t), request = payload();
  const upstreamError = 'event: error\ndata: {"error":"CUDA out of memory", "code":123}';
  for (const tail of [upstreamError + '\n\n', '']) {
    f.state.response = () => new Response(`event: intermediate\ndata: ${JSON.stringify({ event_type: 'intermediate', samp_ix: 0, step_ix: 1, image })}\n\n` + tail,
      { headers: { 'Content-Type': 'text/event-stream' } });
    const response = await f.relay('/ai/generate-image-stream', request); await response.arrayBuffer();
    const job = f.app.store.jobs()[0], d = f.app.store.jobDiagnostics(job.id);
    assert.equal(job.status, 'failed'); assert.equal(job.http_status, 200); assert.equal(job.charged, 0);
    assert.equal(d.upstream_error, tail ? upstreamError : null);
    const failure = JSON.parse(d.failure_detail);
    assert.equal(failure.finalImages, 0); assert.equal(failure.expectedImages, 1);
    assert.match(failure.message, /未返回完整/);
  }
});

test('网络断开记录底层原因；HTTP 200 错误 JSON 保存响应而不是虚构上游原文', async t => {
  const f = await fixture(t);
  f.state.response = () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) }); };
  assert.equal((await f.relay('/ai/generate-image', payload())).status, 502);
  let job = f.app.store.jobs()[0], d = f.app.store.jobDiagnostics(job.id);
  assert.equal(job.http_status, null); assert.equal(d.upstream_error, null);
  assert.equal(JSON.parse(d.failure_detail).cause.code, 'ECONNRESET');
  f.state.response = () => Response.json({ error: 'invalid latent shape', images: [] });
  assert.equal((await f.relay('/ai/generate-image', payload())).status, 502);
  job = f.app.store.jobs()[0]; d = f.app.store.jobDiagnostics(job.id);
  assert.match(d.upstream_error, /invalid latent shape/); assert.equal(job.http_status, 200);
});

test('参数日志保留提示词及数值，脱敏嵌套凭据、图片数组和错误正文', async () => {
  const saved = await requestDiagnostics({ input: 'cat, 桜', parameters: { seed: 42, strength: 0.5,
    reference_image_multiple: [image], director_reference_images_cached: [{ data: image, cache_secret_key: 'hidden' }],
    image, mask: 'data:image/png;base64,' + image, nested: { authorization: 'Bearer hidden', api_key: 'hidden' } } });
  assert.equal(saved.input, 'cat, 桜'); assert.equal(saved.parameters.seed, 42);
  assert.equal(saved.parameters.reference_image_multiple[0].width, 1);
  assert.equal(saved.parameters.director_reference_images_cached[0].data.height, 1);
  assert.ok(!JSON.stringify(saved).includes(image)); assert.ok(!JSON.stringify(saved).includes('hidden'));
  const text = redactDiagnosticText('{"message":"bad image", "image":"' + image + '", "token":"arbitrary-token"}\nBearer arbitrary-secret');
  assert.match(text, /bad image/); assert.ok(!text.includes(image)); assert.ok(!text.includes('arbitrary-token')); assert.ok(!text.includes('arbitrary-secret'));
  assert.match(redactDiagnosticText('错'.repeat(150000)), /已截断/);
});

test('新增诊断表兼容旧库且重启保留日志，不改变结算记录', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sakura-diagnostics-')); let store = new Store(directory);
  t.after(() => { store.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'sakura-diagnostics-')); rmSync(directory, { recursive: true, force: true }); });
  store.addUpstream({ token: 'pst-test' }); const key = store.createKey('历史用户', 100);
  store.reserve(key.id, 'old-job', '/ai/generate-image', 'nai-diffusion-5-full', 26, null, 1);
  store.fail('old-job', '历史错误', 400); store.db.exec('DROP TABLE job_diagnostics');
  store.close(); store = new Store(directory); assert.equal(store.jobDiagnostics('old-job'), null);
  store.saveJobDiagnostics('old-job', { request: { parameters: { seed: 42 } }, upstreamError: 'bad dimensions' });
  store.close(); store = new Store(directory);
  assert.equal(store.jobDiagnostics('old-job').upstream_error, 'bad dimensions');
  assert.equal(store.jobs()[0].charged, 0); assert.equal(store.key(key.id).balance, 100);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('详情保留错误原文，参数在单独弹窗格式化并转义，旧记录提示缺失', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function jobDiagnosticsView('), end = source.indexOf('async function jobDetail(', start);
  const context = createContext({});
  runInContext(`const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));\n` + source.slice(start, end), context);
  const html = runInContext(`jobDiagnosticsView({request_json:'{"parameters":{"seed":42}}',upstream_error:'<script>alert(1)</script>',failure_detail:'socket closed',response_content_type:'text/plain'})`, context);
  assert.match(html, /NovelAI 错误原文/); assert.match(html, /&lt;script&gt;/); assert.ok(!html.includes('<script>'));
  assert.match(html, /data-action="job-parameters">请求参数/); assert.match(html, /socket closed/);
  assert.ok(!html.includes('seed'));
  const parameters = runInContext(`jobParametersView('{"parameters":{"seed":42},"input":"<script>alert(1)</script>"}')`, context);
  assert.match(parameters, /&quot;seed&quot;: 42/); assert.match(parameters, /&lt;script&gt;/);
  assert.ok(!parameters.includes('<script>'));
  assert.match(runInContext('jobDiagnosticsView(null)', context), /未保存诊断信息/);
});
