import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { mockUpstream, image, canvasPng } from './mock.mjs';
import { Store } from '../src/db.mjs';
import { reservation } from '../src/billing.mjs';
import { decodeStreamEvents } from './msgpack-fixture.mjs';

const origin = 'http://127.0.0.1:3100';
export const payload = () => ({ model:'nai-diffusion-5-full', action:'generate', input:'test', parameters:{ width:832, height:1216, steps:23, n_samples:1, stream:'sse' } });
export async function fixture(t, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sakura-relay-test-')), mock = await mockUpstream();
  const app = createApp({ dataDir:directory, publicOrigin:origin, upstreamOrigin:mock.origin, ...config });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie, csrf;
  const call = (path, method = 'GET', body, headers = {}) => fetch(base + path, { method, headers:{ Origin:origin, ...(cookie ? { Cookie:cookie } : {}), ...(csrf ? { 'X-CSRF-Token':csrf } : {}), ...(body !== undefined ? { 'Content-Type':'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  const setup = await call('/admin/api/setup','POST',{ code:readFileSync(join(directory,'setup-code.txt'),'utf8'),password:'test-only-password-123' });
  assert.equal(setup.status,200); cookie = setup.headers.get('set-cookie').split(';')[0]; csrf = (await setup.json()).csrf;
  const upstream = await call('/admin/api/upstreams','POST',{ token:'pst-local-test',enabled:true,name:'Mock' });
  assert.equal(upstream.status,201);
  const settings = await call('/admin/api/settings','PUT',{enabled:true,origins:['http://127.0.0.1:3000'] });
  assert.equal(settings.status,200);
  const created = await call('/admin/api/keys','POST',{name:'测试用户',points:100}); const key = await created.json();
  const relay = (path, body, extra = {}) => fetch(base + path,{ method:body === undefined ? 'GET':'POST', headers:{ Authorization:`Bearer ${key.token}`, ...(body === undefined ? {} : {'Content-Type':'application/json'}),...extra }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  t.after(async () => { await app.close(); await mock.close(); rmSync(directory,{recursive:true,force:true}); });
  return { app,mock,base,call,relay,key,directory,cookie,csrf };
}

function assertEntryFailures(f, count) {
  const jobs = f.app.store.jobs(); assert.equal(jobs.length, count);
  for (const job of jobs) {
    assert.equal(job.status, 'failed'); assert.equal(job.charged, 0); assert.equal(job.reserved, 0);
    assert.equal(job.upstream_id, null); assert.ok(job.note); assert.ok(job.response_status >= 400);
    assert.ok(f.app.store.jobDiagnostics(job.id).failure_detail);
  }
}

function launcherForm(body, parts = {}) {
  const form = new FormData();
  for (const [name, bytes] of Object.entries(parts)) form.append(name, new Blob([bytes], { type: 'image/png' }), 'blob');
  form.append('request', new Blob([JSON.stringify(body)], { type: 'application/json' }), 'blob');
  return form;
}
const sendForm = (f, path, form) => fetch(f.base + path, { method: 'POST', headers: { Authorization: 'Bearer ' + f.key.token }, body: form });

test('Launcher 纯 request 的 multipart 文生图可生成，原表单完整转发并正常计费', async t => {
  const f = await fixture(t), request = payload(), form = launcherForm(request);
  const encoded = new Response(form), type = encoded.headers.get('content-type'), raw = Buffer.from(await encoded.arrayBuffer());
  const response = await fetch(f.base + '/ai/generate-image', { method: 'POST', headers: { Authorization: 'Bearer ' + f.key.token, 'Content-Type': type }, body: raw });
  assert.equal(response.status, 200);
  assert.deepEqual(generatedCalls(f)[0].body, request);
  assert.deepEqual(generatedCalls(f)[0].raw, raw);
  assert.equal(generatedCalls(f)[0].contentType, type);
  assert.equal(f.app.store.key(f.key.id).balance, 74);
});

test('Launcher 图生图和重绘保留源图、蒙版与缓存参数', async t => {
  const f = await fixture(t), bytes = Buffer.from(image, 'base64');
  for (const action of ['img2img', 'infill']) {
    const request = payload(); request.action = action;
    if (action === 'infill') request.model += '-inpainting';
    Object.assign(request.parameters, { image: 'image', image_cache_secret_key: 'source-cache', strength: 0.2, noise: 0, inpaintImg2ImgStrength: 0.2 });
    const parts = { image: action === 'infill' ? canvasPng(832,1216) : bytes };
    if (action === 'infill') { request.parameters.mask = 'mask'; request.parameters.mask_cache_secret_key = 'mask-cache'; parts.mask = canvasPng(832,1216); }
    assert.equal((await sendForm(f, '/ai/generate-image', launcherForm(request, parts))).status, 200);
    const call = generatedCalls(f).at(-1);
    assert.deepEqual(call.body, request); assert.deepEqual(call.parts, parts);
    assert.equal(f.app.store.jobs()[0].charged, reservation('/ai/generate-image', request, { tier: 1, active: true }));
  }
});

test('Launcher 缓存参考图按条目数计费，图片去重不减少附加费用', async t => {
  for (const field of ['director_reference_images', 'reference_image_multiple']) await t.test(field, async t => {
    const f = await fixture(t), bytes = Buffer.from(image, 'base64'), request = payload(); request.model = 'nai-diffusion-4-5-full';
    request.parameters[field + '_cached'] = [{ data: 'ref', cache_secret_key: 'one' }, { data: 'ref', cache_secret_key: 'one' }];
    const canonical = structuredClone(request); delete canonical.parameters[field + '_cached']; canonical.parameters[field] = [image, image];
    const price = reservation('/ai/generate-image', canonical, { tier: 1, active: true });
    assert.equal((await sendForm(f, '/ai/generate-image', launcherForm(request, { ref: bytes }))).status, 200);
    assert.deepEqual(generatedCalls(f)[0].body, request);
    assert.deepEqual(generatedCalls(f)[0].parts.ref, bytes);
    assert.equal(f.app.store.jobs()[0].charged, price);
    assert.equal(f.app.store.key(f.key.id).balance, 100 - price);
  });
});

test('缓存参考图不能绕过模型限制、互斥规则或余额检查，JSON 同样按缓存字段计费', async t => {
  const f = await fixture(t), bytes = Buffer.from(image, 'base64'); f.mock.state.calls = [];
  for (const field of ['director_reference_images_cached', 'reference_image_multiple_cached']) {
    const request = payload(); request.parameters[field] = [{ data: 'ref' }];
    assert.equal((await sendForm(f, '/ai/generate-image', launcherForm(request, { ref: bytes }))).status, 400);
  }
  const request = payload(); request.model = 'nai-diffusion-4-5-full'; request.parameters.director_reference_images_cached = [{ data: 'ref' }];
  for (const extra of [{ director_reference_images: [image] }, { reference_image_multiple_cached: [{ data: 'ref' }] }]) {
    const invalid = structuredClone(request); Object.assign(invalid.parameters, extra);
    assert.equal((await sendForm(f, '/ai/generate-image', launcherForm(invalid, { ref: bytes }))).status, 400);
  }
  await f.call('/admin/api/keys/' + f.key.id + '/points', 'POST', { delta: -99, note: '低余额' });
  assert.equal((await sendForm(f, '/ai/generate-image', launcherForm(request, { ref: bytes }))).status, 402);
  request.parameters.director_reference_images_cached[0].data = image;
  assert.equal((await f.relay('/ai/generate-image', request)).status, 402);
  assert.equal(f.mock.state.calls.filter(call => call.path.includes('generate-image')).length, 0);
  assert.equal(f.app.store.key(f.key.id).reserved, 0);
});

test('Launcher Vibe 编码、图像处理和放大表单都可转发，图片处理校验实际尺寸', async t => {
  const f = await fixture(t), bytes = Buffer.from(image, 'base64');
  const requests = [
    ['/ai/encode-vibe', { image: 'image', model: 'nai-diffusion-4-5-full', information_extracted: 1 }],
    ['/ai/augment-image', { image: 'image', req_type: 'lineart', width: 1, height: 1 }],
    ['/ai/upscale', { image: 'image', model: 'nai-diffusion-5-curated' }],
  ];
  // Augment requires at least 64 pixels; use a PNG header declaring 64x64 for this local fixture.
  const toolImage = Buffer.from(bytes); toolImage.writeUInt32BE(64, 16); toolImage.writeUInt32BE(64, 20);
  requests[1][1].width = 64; requests[1][1].height = 64;
  for (const [path, request] of requests) {
    const part = path === '/ai/augment-image' ? toolImage : bytes;
    const response = await sendForm(f, path, launcherForm(request, { image: part }));
    assert.equal(response.status, 200);
    const call = f.mock.state.calls.findLast(call => call.path === path);
    assert.deepEqual(call.body, request); assert.deepEqual(call.parts.image, part);
  }
  const invalid = { image: 'image', req_type: 'lineart', width: 1024, height: 1024 };
  assert.equal((await sendForm(f, '/ai/augment-image', launcherForm(invalid, { image: bytes }))).status, 400);
  assert.equal(f.mock.state.calls.filter(call => call.path === '/ai/augment-image').length, 1);
});

test('无效表单、缺少图片、重复分块和错误媒体类型在访问上游前拒绝', async t => {
  const f = await fixture(t); f.mock.state.calls = [];
  const missing = new FormData(), invalidJson = new FormData(), duplicate = launcherForm(payload());
  invalidJson.append('request', '{broken'); duplicate.append('request', '{}');
  const request = payload(); request.action = 'img2img'; Object.assign(request.parameters, { image: 'missing', strength: 0.5 });
  const forms = [missing, invalidJson, duplicate, launcherForm(request)];
  for (const form of forms) assert.equal((await sendForm(f, '/ai/generate-image', form)).status, 400);
  const text = new FormData(); text.append('request', JSON.stringify(payload()));
  assert.equal((await sendForm(f, '/ai/generate-image', text)).status, 200);
  f.mock.state.calls = [];
  const bad = await fetch(f.base + '/ai/generate-image', { method: 'POST', headers: { Authorization: 'Bearer ' + f.key.token, 'Content-Type': 'multipart/form-data' }, body: 'no boundary' });
  assert.equal(bad.status, 400);
  assert.equal((await f.relay('/ai/generate-image', payload(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(f.mock.state.calls.length, 0); assert.equal(f.app.store.key(f.key.id).reserved, 0);
});

test('Launcher multipart 实时预览接收 MessagePack，SSE 参数重写保留图片和缓存字段', async t => {
  const f = await fixture(t), request = payload(), bytes = Buffer.from(image, 'base64');
  request.action = 'img2img'; Object.assign(request.parameters, { stream: 'msgpack', image: 'image', image_cache_secret_key: 'cache', strength: 0.2 });
  const response = await sendForm(f, '/ai/generate-image-stream', launcherForm(request, { image: bytes }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/x-msgpack');
  const events = decodeStreamEvents(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual(events.map(event => event.event_type), ['intermediate', 'final']);
  assert.equal(events[1].samp_ix, 0); assert.equal(events[1].image, image);
  const call = f.mock.state.calls.find(call => call.path.endsWith('-stream'));
  assert.deepEqual(call.parts.image, bytes);
  assert.deepEqual(call.body, { ...request, parameters: { ...request.parameters, stream: 'sse' } });
  assert.equal(f.app.store.jobs()[0].status, 'completed'); assert.equal(f.app.store.jobs()[0].charged, 6);
});

test('JSON MessagePack 请求也按客户端格式响应，SSE 分块、UTF-8 和无终止空行正常转换', async t => {
  const f = await fixture(t), request = payload(); request.parameters.stream = 'msgpack';
  const final = { event_type: 'final', samp_ix: 0, image, text: '樱花' }, raw = Buffer.from('event: final\ndata: ' + JSON.stringify(final));
  f.mock.state.streamChunks = Array.from(raw, byte => Buffer.from([byte]));
  const response = await f.relay('/ai/generate-image-stream', request);
  assert.deepEqual(decodeStreamEvents(Buffer.from(await response.arrayBuffer())), [final]);
  assert.equal(f.app.store.jobs()[0].status, 'completed'); assert.equal(f.app.store.key(f.key.id).balance, 74);
});

test('MessagePack 缺图、畸形事件、上游错误和缺少批量结果都失败并释放预留', async t => {
  const f = await fixture(t), request = payload(); request.parameters.stream = 'msgpack';
  const scenarios = [
    ['event: intermediate\ndata: {"event_type":"intermediate","samp_ix":0}\n\n'],
    ['event: final\ndata: {broken}\n\n'],
    ['event: final\ndata: ' + JSON.stringify({ event_type: 'final', samp_ix: 0, image }) + '\n\nevent: error\ndata: {"event_type":"error","error":"failed"}\n\n'],
  ];
  for (const chunks of scenarios) {
    f.mock.state.streamChunks = chunks;
    const response = await sendForm(f, '/ai/generate-image-stream', launcherForm(request));
    const events = decodeStreamEvents(Buffer.from(await response.arrayBuffer()));
    assert.equal(events.at(-1).event_type, 'error'); assert.equal(events.at(-1).error, '生成失败，未扣点数');
    const job = f.app.store.jobs()[0]; assert.equal(job.status, 'failed'); assert.equal(job.charged, 0);
    assert.equal(f.app.store.key(f.key.id).balance, 100); assert.equal(f.app.store.key(f.key.id).reserved, 0);
  }
  f.mock.state.streamChunks = null; request.parameters.n_samples = 2; f.mock.state.finalCount = 1;
  const response = await sendForm(f, '/ai/generate-image-stream', launcherForm(request));
  assert.equal(decodeStreamEvents(Buffer.from(await response.arrayBuffer())).at(-1).event_type, 'error');
  assert.equal(f.app.store.key(f.key.id).balance, 100); assert.equal(f.app.store.key(f.key.id).reserved, 0);
  f.mock.state.finalCount = undefined; request.parameters.n_samples = 1;
  assert.equal((await sendForm(f, '/ai/generate-image', launcherForm(request))).status, 200);
});

test('管理员鉴权、CSRF、一次性初始化、登录密码与响应脱敏', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base+'/admin/api/snapshot')).status,401);
  assert.equal((await f.call('/admin/api/setup','POST',{code:'x',password:'not-relevant-password'})).status,409);
  assert.equal((await f.call('/admin/api/keys','POST',{name:'x',points:1},{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await f.call('/admin/api/keys','POST',{name:'x',points:1},{Origin:'https://evil.example'})).status,403);
  assert.equal((await f.call('/admin/api/login','POST',{password:'incorrect-password'})).status,401);
  assert.equal((await f.call('/admin/api/login','POST',{password:'test-only-password-123'})).status,200);
  const snapshot = await (await f.call('/admin/api/snapshot')).text();
  for (const secret of [f.key.token,'pst-local-test','test-only-password-123']) assert.ok(!snapshot.includes(secret));
  assert.ok(!readFileSync(join(f.directory,'relay.sqlite')).includes(Buffer.from('pst-local-test')));
});
test('普通与会员订阅均返回本地体力及自身余额', async t => {
  const f=await fixture(t); f.mock.state.paid=false; f.mock.state.calls=[];
  let data=await (await f.relay('/user/subscription')).json();
  assert.equal(data.tier,1); assert.deepEqual(data.usage,{percent:0,isNegative:true});
  assert.equal(data.trainingStepsLeft.fixedTrainingStepsLeft,100);
  assert.equal(f.mock.state.calls.length,0);
  await member(f);
  data=await (await f.relay('/user/subscription')).json();
  assert.equal(data.tier,3); assert.equal(data.usage.percent,3.6);
  assert.equal(data.usage.isNegative,false); assert.equal(data.email,undefined); assert.equal(data.token,undefined);
  assert.equal(data.relay.nai5UpstreamId,undefined); assert.equal(data.relay.usageSource,'local');
  const quota=await (await f.call('/admin/api/quota')).json();
  assert.equal(quota.upstreams[0].account.relay.balance,10000);
});

test('柏宝绘订阅兼容路径返回相同的普通及会员订阅，查询不改变计费状态', async t => {
  for (const tier of ['standard', 'member']) await t.test(tier, async t => {
    const f = await fixture(t);
    if (tier === 'member') await member(f);
    f.app.store.updateKey(f.key.id, { expiresAt: Date.now() + 7 * 86400000 });
    f.mock.state.queryFails = tier === 'standard'; f.mock.state.calls = [];
    const before = { key: f.app.store.key(f.key.id), jobs: f.app.store.jobs(), ledger: f.app.store.ledger() };
    const original = await f.relay('/user/subscription'); assert.equal(original.status, 200);
    const compatible = await f.relay('/ai/user/subscription'); assert.equal(compatible.status, 200);
    const data = await compatible.json();
    assert.deepEqual(data, await original.json());
    assert.equal(data.subscription, undefined); assert.equal(data.tier, tier === 'member' ? 3 : 1);
    for (const secret of ['private@example.com', 'SHOULD_NOT_LEAK', 'pst-local-test', f.key.token])
      assert.ok(!JSON.stringify(data).includes(secret));
    assert.deepEqual(f.mock.state.calls.map(call => call.path), []);
    if (tier === 'member') {
      f.mock.state.queryFails = true;
      assert.equal((await f.relay('/ai/user/subscription')).status, 200);
    }
    assert.deepEqual({ key: f.app.store.key(f.key.id), jobs: f.app.store.jobs(), ledger: f.app.store.ledger() }, before);
  });
});

test('柏宝绘订阅兼容路径沿用跨域预检、来源限制和密钥校验，只接受 GET', async t => {
  const f = await fixture(t), path = '/ai/user/subscription', website = 'http://127.0.0.1:3000';
  f.mock.state.calls = [];
  const preflight = origin => fetch(f.base + path, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
  } });
  const pre = await preflight(website);
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), website);
  assert.equal(pre.headers.get('vary'), 'Origin'); assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/i);
  const allowed = await f.relay(path, undefined, { Origin: website });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), website);
  for (const headers of [{}, { Authorization: 'Bearer skr_' + 'x'.repeat(43) }]) {
    const response = await fetch(f.base + path, { headers: { Origin: website, ...headers } });
    assert.equal(response.status, 401); assert.equal(response.headers.get('access-control-allow-origin'), website);
  }
  assert.equal((await preflight('https://unlisted.example')).status, 403);
  assert.equal((await f.relay(path, undefined, { Origin: 'https://unlisted.example' })).status, 403);
  assert.equal((await f.relay(path, {}, { Origin: website })).status, 405);
  f.app.store.updateKey(f.key.id, { enabled: false });
  assert.equal((await f.relay(path)).status, 401);
  f.app.store.updateKey(f.key.id, { enabled: true, expiresAt: Date.now() - 1 });
  const expired = await f.relay(path); assert.equal(expired.status, 403);
  assert.equal((await expired.json()).code, 'KEY_EXPIRED');
  f.app.store.updateKey(f.key.id, { expiresAt: null }); f.app.store.set('enabled', 'false');
  assert.equal((await f.relay(path)).status, 503);
  assert.equal((await f.call('/admin/api/settings', 'PUT', { enabled: true, origins: ['*'] })).status, 200);
  for (const origin of ['https://baibai.example', 'null']) {
    const pre = await preflight(origin);
    assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), origin);
    const response = await f.relay(path, undefined, { Origin: origin });
    assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), origin);
  }
  assert.equal(f.mock.state.calls.length, 0); assertEntryFailures(f, 8);
});

test('user/data 普通账号可解析下游套餐、可用余额和有效期，上游故障不影响查询', async t => {
  const f = await fixture(t), expiresAt = Date.now() + 7 * 86400000;
  f.app.store.updateKey(f.key.id, { expiresAt });
  f.app.store.reserve(f.key.id, 'account-query-reservation', '/ai/generate-image', 'nai-diffusion-5-full', 26, null, 1);
  f.mock.state.queryFails = true; f.mock.state.calls = [];
  const before = { key: f.app.store.key(f.key.id), jobs: f.app.store.jobs(), ledger: f.app.store.ledger() };
  const response = await f.relay('/user/data'); assert.equal(response.status, 200);
  const data = await response.json(), subscription = data.subscription;
  assert.deepEqual(data, { subscription: await (await f.relay('/user/subscription')).json() });
  assert.equal(subscription.tier, 1); assert.equal(subscription.active, true);
  assert.deepEqual(subscription.trainingStepsLeft, { fixedTrainingStepsLeft: 74, purchasedTrainingSteps: 0 });
  assert.equal(subscription.expiresAt, expiresAt / 1000); assert.equal(subscription.relay.expiresAt, expiresAt);
  assert.deepEqual(subscription.usage, { percent: 0, isNegative: true });
  assert.equal(f.mock.state.calls.length, 0);
  assert.deepEqual({ key: f.app.store.key(f.key.id), jobs: f.app.store.jobs(), ledger: f.app.store.ledger() }, before);
  f.app.store.fail('account-query-reservation', '测试结束');
  f.app.store.updateKey(f.key.id, { expiresAt: null });
  assert.equal((await (await f.relay('/user/data')).json()).subscription.expiresAt, undefined);
});

test('user/data 会员返回本地体力，不查询上游或透传上游恢复时间',async t=>{
 const f=await fixture(t),expiresAt=Date.now()+7*86400000;await member(f);f.app.store.updateKey(f.key.id,{expiresAt});
 f.mock.state.timeUntilNextPercent=19.5;f.mock.state.queryFails=true;f.mock.state.calls=[];
 const response=await f.relay('/user/data');assert.equal(response.status,200);const data=await response.json(),subscription=data.subscription;
 assert.deepEqual(Object.keys(data),['subscription']);assert.equal(subscription.tier,3);assert.equal(subscription.expiresAt,expiresAt/1000);
 assert.deepEqual(subscription.usage,{percent:3.6,isNegative:false});assert.equal(subscription.relay.usageSource,'local');assert.equal(subscription.relay.nai5UpstreamId,undefined);
 assert.deepEqual(subscription.trainingStepsLeft,{fixedTrainingStepsLeft:100,purchasedTrainingSteps:0});
 assert.equal(subscription.relay.stamina.availableImages,40);assert.equal(subscription.relay.stamina.capacityImages,280);
 assert.deepEqual((await(await f.relay('/user/subscription')).json()).usage,subscription.usage);assert.equal(f.mock.state.calls.length,0);
 for(const secret of ['private@example.com','SHOULD_NOT_LEAK','pst-local-test',f.key.token])assert.ok(!JSON.stringify(data).includes(secret));
});

test('user/data 保留鉴权、有效期、暂停状态和跨域校验，只接受 GET', async t => {
  const f = await fixture(t); f.mock.state.calls = [];
  for (const headers of [{}, { Authorization: 'Bearer skr_' + 'x'.repeat(43) }])
    assert.equal((await fetch(f.base + '/user/data', { headers })).status, 401);
  const website = 'http://127.0.0.1:3000';
  const pre = await fetch(f.base + '/user/data', { method: 'OPTIONS', headers: {
    Origin: website, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
  } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), website);
  const allowed = await f.relay('/user/data', undefined, { Origin: website });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), website);
  assert.equal((await f.relay('/user/data', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.relay('/user/data', {})).status, 405);
  f.app.store.updateKey(f.key.id, { enabled: false });
  assert.equal((await f.relay('/user/data')).status, 401);
  f.app.store.updateKey(f.key.id, { enabled: true, expiresAt: Date.now() - 1 });
  const expired = await f.relay('/user/data'); assert.equal(expired.status, 403);
  assert.equal((await expired.json()).code, 'KEY_EXPIRED');
  f.app.store.updateKey(f.key.id, { expiresAt: null }); f.app.store.set('enabled', 'false');
  assert.equal((await f.relay('/user/data')).status, 503);
  assert.equal(f.mock.state.calls.length, 0); assertEntryFailures(f, 7);
});

test('完整密钥可重复查看，仅管理员通过 Origin 和 CSRF 校验后可读取', async t => {
  const f = await fixture(t), path = `/admin/api/keys/${f.key.id}/reveal`;
  assert.equal((await fetch(f.base + path, { method:'POST', headers:{Origin:origin}, body:'{}' })).status,401);
  for (const headers of [{'X-CSRF-Token':''}, {Origin:'https://evil.example'}]) {
    assert.equal((await f.call(path,'POST',{},headers)).status,403);
  }
  assert.equal((await f.call(path)).status,404);
  for (let i=0; i<2; i++) {
    const res = await f.call(path,'POST',{});
    assert.equal(res.status,200); assert.equal(res.headers.get('cache-control'),'no-store');
    assert.deepEqual(await res.json(),f.key);
  }
  assert.equal((await f.call('/admin/api/keys/99999/reveal','POST',{})).status,404);
  const encrypted = f.app.store.key(f.key.id).token_encrypted;
  assert.ok(encrypted); assert.notEqual(encrypted,f.key.token);
  const snapshot = await (await f.call('/admin/api/snapshot')).text();
  for (const secret of [f.key.token,encrypted,f.app.store.key(f.key.id).token_hash]) assert.ok(!snapshot.includes(secret));
  f.app.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(!readFileSync(join(f.directory,'relay.sqlite')).includes(Buffer.from(f.key.token)));
  await f.call(`/admin/api/keys/${f.key.id}`,'POST',{enabled:false});
  assert.deepEqual(await (await f.call(path,'POST',{})).json(),f.key);
  assert.equal((await f.relay('/user/subscription')).status,401);
  await f.call('/admin/api/logout','POST',{});
  assert.equal((await f.call(path,'POST',{})).status,401);
});






test('删除密钥仅管理员通过 Origin 和 CSRF 校验后可操作', async t => {
  const f = await fixture(t), path = `/admin/api/keys/${f.key.id}`;
  assert.equal((await fetch(f.base + path, { method: 'DELETE', headers: { Origin: origin } })).status, 401);
  for (const headers of [{ 'X-CSRF-Token': '' }, { Origin: 'https://evil.example' }])
    assert.equal((await f.call(path, 'DELETE', undefined, headers)).status, 403);
  assert.equal((await f.call(path + '/points', 'DELETE')).status, 404);
  assert.equal((await f.call('/admin/api/keys/99999', 'DELETE')).status, 404);
  assert.ok(f.app.store.key(f.key.id));
  assert.equal((await f.relay('/user/subscription')).status, 200);
});

test('删除密钥立即撤销凭据并保留请求、流水和用量统计，不能再次管理', async t => {
  const f = await fixture(t), path = `/admin/api/keys/${f.key.id}`;
  const other = await (await f.call('/admin/api/keys', 'POST', { name: '保留的密钥', points: 55 })).json();
  assert.equal((await f.relay('/ai/generate-image', payload())).status, 200);
  const before = await (await f.call('/admin/api/snapshot')).json();
  const response = await f.call(path, 'DELETE');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  const after = await (await f.call('/admin/api/snapshot')).json();
  assert.deepEqual(after.keys.map(key => key.id), [other.id]);
  for (const field of ['jobs', 'ledger', 'stats', 'trend']) assert.deepEqual(after[field], before[field]);
  assert.equal(after.jobs[0].key_name, '测试用户');
  assert.equal(f.app.store.key(f.key.id), undefined); assert.equal(f.app.store.authenticate(f.key.token), null);
  const retired = f.app.store.db.prepare('SELECT * FROM keys WHERE id=?').get(f.key.id);
  assert.equal(retired.enabled, 0); assert.ok(retired.retired_at); assert.equal(retired.token_encrypted, '');
  assert.equal(retired.balance, 74); assert.equal(retired.reserved, 0);
  assert.equal((await f.relay('/user/subscription')).status, 401);
  assert.equal((await f.relay('/ai/generate-image', payload())).status, 401);
  for (const [endpoint, method, body] of [
    [path, 'DELETE'], [path, 'POST', { enabled: true }], [path, 'POST', { validDays: 30 }],
    [path + '/reveal', 'POST', {}], [path + '/points', 'POST', { delta: 1, note: '不可充值' }],
  ]) assert.equal((await f.call(endpoint, method, body)).status, 404);
  assert.equal(generatedCalls(f).length, 1);
  assert.deepEqual(f.app.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('删除会员密钥和上游保留各自的历史记录', async t => {
  const f = await fixture(t); await member(f); f.mock.state.paid = false;
  assert.equal((await f.relay('/ai/generate-image', payload())).status, 200);
  assert.equal(f.app.store.upstreams()[0].bound_keys, undefined);
  assert.equal((await f.call(`/admin/api/keys/${f.key.id}`, 'DELETE')).status, 200);
  assert.equal(f.app.store.upstreams()[0].bound_keys, undefined);
  assert.equal((await f.call('/admin/api/upstreams/1', 'DELETE')).status, 200);
  const snapshot = await (await f.call('/admin/api/snapshot')).json();
  assert.equal(snapshot.keys.length, 0); assert.equal(snapshot.upstreams.length, 0);
  assert.equal(snapshot.jobs[0].key_name, '测试用户'); assert.equal(snapshot.jobs[0].upstream_name, 'Mock');
  assert.equal(snapshot.ledger.filter(row => row.kind === 'usage').length, 0);
  assert.deepEqual(f.app.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('生成及排队期间拒绝删除，全部请求结算后才允许删除', async t => {
  const f = await fixture(t); f.mock.state.slow = 160;
  const path = `/admin/api/keys/${f.key.id}`;
  const first = f.relay('/ai/generate-image', payload()); await waitFor(() => generatedCalls(f).length === 1);
  const second = f.relay('/ai/generate-image', payload()); await waitFor(() => f.app.router.keyQueue.size(f.key.id) === 2);
  const rejected = await f.call(path, 'DELETE');
  assert.equal(rejected.status, 409); assert.match((await rejected.json()).error, /生成和排队结束/);
  assert.ok(f.app.store.key(f.key.id));
  assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [200, 200]);
  await waitFor(() => f.app.router.keyQueue.size(f.key.id) === 0);
  assert.equal(f.app.store.key(f.key.id).balance, 48); assert.equal(f.app.store.key(f.key.id).reserved, 0);
  assert.equal((await f.call(path, 'DELETE')).status, 200);
  assert.equal(f.app.store.jobs().length, 2);
});

test('尚未预留的排队请求和零点数进行中任务也会阻止删除', async t => {
  const f = await fixture(t), path = `/admin/api/keys/${f.key.id}`;
  const unlock = await f.app.router.lockKey(f.key.id);
  try { assert.equal((await f.call(path, 'DELETE')).status, 409); }
  finally { unlock(); }
  f.app.store.reserve(f.key.id, 'zero-running', '/ai/generate-image', 'nai-diffusion-5-full', 0, null, 1);
  assert.equal(f.app.store.key(f.key.id).reserved, 0);
  assert.equal((await f.call(path, 'DELETE')).status, 409);
  assert.throws(() => f.app.store.retireKey(f.key.id), /生成和排队结束/);
  f.app.store.fail('zero-running', '测试任务已结束');
  assert.equal((await f.call(path, 'DELETE')).status, 200);
  assert.equal(f.app.store.jobs()[0].charged, 0);
});

test('名称省略、留空或仅含空白时自动递增命名，会员可用零点数创建 30 天密钥', async t => {
  const f = await fixture(t); f.mock.state.paid = false;
  for (const [index, extra] of [{}, { name: '' }, { name: '  \t ' }].entries()) {
    const before = Date.now(), res = await f.call('/admin/api/keys', 'POST', { ...extra, points: 0, tier: 'member', validDays: 30 });
    assert.equal(res.status, 201);
    const created = await res.json(), key = f.app.store.key(created.id);
    assert.equal(key.name, `下游-Key-${index + 1}`); assert.equal(key.tier, 'member');
    assert.equal(key.balance, 0); assert.equal(key.nai5_upstream_id, undefined); assert.equal(key.stamina_balance,28000);
    assert.ok(key.expires_at >= before + 30 * 86400000 && key.expires_at <= Date.now() + 30 * 86400000);
  }
  assert.equal((await f.call(`/admin/api/keys/${f.key.id}`, 'POST', { name: '  ' })).status, 200);
  assert.equal(f.app.store.key(f.key.id).name, '下游-Key-4');
  await f.call(`/admin/api/keys/${f.key.id}`, 'POST', { enabled: false });
  assert.equal(f.app.store.key(f.key.id).name, '下游-Key-4');
  for (const name of [null, 123, 'x'.repeat(65)]) {
    assert.equal((await f.call('/admin/api/keys', 'POST', { name, points: 0 })).status, 400);
    assert.equal((await f.call(`/admin/api/keys/${f.key.id}`, 'POST', { name })).status, 400);
  }
});

test('上游名称可省略或留空，跳过占用编号、删除后不复用且与下游分别计数', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/admin/api/upstreams', 'POST', { name: '上游-KEY-1', token: 'pst-name-occupied', enabled: true })).status, 201);
  let last;
  for (const [index, extra] of [{}, { name: '' }, { name: '  \t ' }].entries()) {
    const res = await f.call('/admin/api/upstreams', 'POST', { ...extra, token: `pst-auto-name-${index}`, enabled: true });
    assert.equal(res.status, 201); last = (await res.json()).id;
    assert.equal(f.app.store.upstream(last).name, `上游-Key-${index + 2}`);
  }
  const token = f.app.store.upstreamToken(last);
  assert.equal((await f.call(`/admin/api/upstreams/${last}`, 'PUT', { name: '', token: '', enabled: false })).status, 200);
  assert.equal(f.app.store.upstream(last).name, '上游-Key-5'); assert.equal(f.app.store.upstreamToken(last), token);
  assert.equal((await f.call(`/admin/api/upstreams/${last}`, 'PUT', { token: '', enabled: true })).status, 200);
  assert.equal(f.app.store.upstream(last).name, '上游-Key-5');
  assert.equal((await f.call(`/admin/api/upstreams/${last}`, 'DELETE')).status, 200);
  const next = await (await f.call('/admin/api/upstreams', 'POST', { name: '', token: 'pst-auto-name-next', enabled: true })).json();
  assert.equal(f.app.store.upstream(next.id).name, '上游-Key-6');
  const downstream = await (await f.call('/admin/api/keys', 'POST', { name: '', points: 0 })).json();
  assert.equal(f.app.store.key(downstream.id).name, '下游-Key-1');
  for (const name of [null, 123, 'x'.repeat(65)]) {
    assert.equal((await f.call('/admin/api/upstreams', 'POST', { name, token: 'pst-invalid-name', enabled: true })).status, 400);
    assert.equal((await f.call(`/admin/api/upstreams/${next.id}`, 'PUT', { name, token: '', enabled: true })).status, 400);
  }
});

test('管理员可按完整密钥、隐藏片段或名称查询，响应只返回 ID 且保留过期和停用记录', async t => {
  const f = await fixture(t);
  const second = await (await f.call('/admin/api/keys', 'POST', { name: '  Alice  ', points: 0 })).json();
  for (const query of [f.key.token, `  ${f.key.token}  `, f.key.token.slice(12, 28), '测试用户']) {
    const res = await f.call('/admin/api/keys/search', 'POST', { query });
    assert.equal(res.status, 200); assert.deepEqual(await res.json(), { ids: [f.key.id] });
  }
  assert.deepEqual(await (await f.call('/admin/api/keys/search', 'POST', { query: 'ALICE' })).json(), { ids: [second.id] });
  assert.deepEqual(await (await f.call('/admin/api/keys/search', 'POST', { query: '' })).json(), { ids: [second.id, f.key.id] });
  assert.deepEqual(await (await f.call('/admin/api/keys/search', 'POST', { query: 'unknown-key' })).json(), { ids: [] });
  await f.call(`/admin/api/keys/${f.key.id}`, 'POST', { expiresAt: Date.now() - 1 });
  assert.deepEqual(await (await f.call('/admin/api/keys/search', 'POST', { query: f.key.token })).json(), { ids: [f.key.id] });
  await f.call(`/admin/api/keys/${f.key.id}`, 'POST', { enabled: false });
  assert.deepEqual(await (await f.call('/admin/api/keys/search', 'POST', { query: f.key.token })).json(), { ids: [f.key.id] });
  const snapshot = await (await f.call('/admin/api/snapshot')).json();
  assert.ok(!JSON.stringify(snapshot).includes(f.key.token));
  await f.call(`/admin/api/keys/${f.key.id}`, 'DELETE');
  assert.deepEqual(await (await f.call('/admin/api/keys/search', 'POST', { query: f.key.token })).json(), { ids: [] });
});

test('密钥搜索要求管理员登录、同源和 CSRF，并校验查询类型及长度', async t => {
  const f = await fixture(t), path = '/admin/api/keys/search', body = JSON.stringify({ query: f.key.token });
  const unauthenticated = await fetch(f.base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await f.call(path, 'POST', { query: f.key.token }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.call(path, 'POST', { query: f.key.token }, { Origin: 'https://other.test' })).status, 403);
  for (const query of [null, 42, 'x'.repeat(257)]) assert.equal((await f.call(path, 'POST', { query })).status, 400);
  assert.equal((await f.call(path, 'POST', {})).status, 400);
});

test('停用和过期密钥都可以删除', async t => {
  const f = await fixture(t);
  const expired = await (await f.call('/admin/api/keys', 'POST', { name: '过期密钥', points: 1, expiresAt: Date.now() - 1 })).json();
  await f.call(`/admin/api/keys/${f.key.id}`, 'POST', { enabled: false });
  for (const key of [f.key, expired]) assert.equal((await f.call(`/admin/api/keys/${key.id}`, 'DELETE')).status, 200);
  assert.equal(f.app.store.keys().length, 0);
});

test('生成按本地公式扣除 Anlas、持久化流水，并兼容现有请求', async t => {
  const f = await fixture(t);
  const res = await f.relay('/ai/generate-image',payload()); assert.equal(res.status,200); assert.equal((await res.json()).images.length,1);
  const key = f.app.store.key(f.key.id); assert.equal(key.balance,74); assert.equal(key.reserved,0);
  assert.equal(f.app.store.jobs()[0].charged,26); assert.equal(f.app.store.jobs()[0].status,'completed');
  assert.equal(f.app.store.ledger()[0].delta,-26);
});
test('NAI5 免费额度不扣 Anlas，0 余额仍可免费生成', async t => {
  const f = await fixture(t); f.mock.state.paid = false; await member(f);
  await f.call(`/admin/api/keys/${f.key.id}/points`,'POST',{delta:-100,note:'测试清空余额'});
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.equal(f.app.store.key(f.key.id).balance,0); assert.equal(f.app.store.jobs()[0].charged,0);
});
test('余额不足在调用付费接口前拒绝；停用 Key 拒绝请求', async t => {
  const f = await fixture(t);
  await f.call(`/admin/api/keys/${f.key.id}/points`,'POST',{delta:-90,note:'测试'});
  const res = await f.relay('/ai/generate-image',payload()); assert.equal(res.status,402);
  assert.equal(f.mock.state.calls.filter(c => c.path === '/ai/generate-image').length,0);
  await f.call(`/admin/api/keys/${f.key.id}`,'POST',{enabled:false});
  assert.equal((await f.relay('/user/subscription')).status,401);
});
test('CORS 预检、非法来源与未经许可的接口', async t => {
  const f = await fixture(t);
  const pre = await fetch(f.base+'/ai/generate-image',{method:'OPTIONS',headers:{Origin:'http://127.0.0.1:3000','Access-Control-Request-Headers':'authorization, content-type'}});
  assert.equal(pre.status,204); assert.equal(pre.headers.get('access-control-allow-origin'),'http://127.0.0.1:3000');
  assert.equal((await f.relay('/user/subscription',undefined,{Origin:'https://evil.example'})).status,403);
  assert.equal((await f.relay('/user/unknown')).status,404);
  assert.equal((await f.relay('/ai/generate',payload())).status,404);
});

test('允许所有来源支持跨域预检与请求，保留密钥及管理校验，可恢复来源限制', async t => {
  const f = await fixture(t), allowedOrigins = ['*', 'https://listed.example'];
  const saved = await f.call('/admin/api/settings','PUT',{enabled:true,origins:allowedOrigins});
  assert.equal(saved.status,200);
  assert.deepEqual((await (await f.call('/admin/api/snapshot')).json()).settings.origins,allowedOrigins);
  const persisted = new Store(f.directory);
  try { assert.deepEqual(JSON.parse(persisted.get('origins')),allowedOrigins); } finally { persisted.close(); }
  for (const website of ['https://drawing.example', 'http://192.168.1.10:8080', 'null']) {
    const pre = await fetch(f.base+'/ai/generate-image',{method:'OPTIONS',headers:{Origin:website,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, content-type'}});
    assert.equal(pre.status,204); assert.equal(pre.headers.get('access-control-allow-origin'),website);
    assert.equal(pre.headers.get('vary'),'Origin');
    assert.match(pre.headers.get('access-control-allow-methods'),/POST/);
    assert.match(pre.headers.get('access-control-allow-headers'),/Authorization/);
    const response = await f.relay('/user/subscription',undefined,{Origin:website});
    assert.equal(response.status,200); assert.equal(response.headers.get('access-control-allow-origin'),website);
    const anonymous = await fetch(f.base+'/user/subscription',{headers:{Origin:website}});
    assert.equal(anonymous.status,401); assert.equal(anonymous.headers.get('access-control-allow-origin'),website);
  }
  const generated = await f.relay('/ai/generate-image',payload(),{Origin:'https://drawing.example'});
  assert.equal(generated.status,200); assert.equal(generated.headers.get('access-control-allow-origin'),'https://drawing.example');
  await generated.arrayBuffer();
  assert.equal((await f.call('/admin/api/settings','PUT',{enabled:true,origins:['*']},{Origin:'https://drawing.example'})).status,403);
  assert.equal((await f.call('/admin/api/settings','PUT',{enabled:true,origins:['*']},{'X-CSRF-Token':''})).status,403);
  for (const invalid of ['not-an-origin', 'https://drawing.example/path', 'http://drawing.example'])
    assert.equal((await f.call('/admin/api/settings','PUT',{enabled:true,origins:[invalid]})).status,400);
  assert.deepEqual(JSON.parse(f.app.store.get('origins')),allowedOrigins);
  assert.equal((await f.call('/admin/api/settings','PUT',{enabled:true,origins:['https://listed.example']})).status,200);
  assert.equal((await f.relay('/user/subscription',undefined,{Origin:'https://drawing.example'})).status,403);
  assert.equal((await f.relay('/user/subscription',undefined,{Origin:'https://listed.example'})).status,200);
});
test('上游拒绝后释放 Anlas，敏感错误不回传，服务不自动重试', async t => {
  const f = await fixture(t); f.mock.state.fail = true;
  const res = await f.relay('/ai/generate-image',payload()); assert.equal(res.status,429); assert.ok(!(await res.text()).includes('pst-'));
  assert.equal(f.app.store.key(f.key.id).balance,100); assert.equal(f.app.store.key(f.key.id).reserved,0);
  assert.equal(f.mock.state.calls.filter(c => c.path === '/ai/generate-image').length,1);
});
test('流式 SSE 转发、完整性检测与扣除 Anlas', async t => {
  const f = await fixture(t); const res = await f.relay('/ai/generate-image-stream',payload());
  assert.equal(res.status,200); assert.ok(res.headers.get('content-type').includes('text/event-stream'));
  assert.match(await res.text(),/event: final/); assert.equal(f.app.store.jobs()[0].status,'completed'); assert.equal(f.app.store.key(f.key.id).balance,74);
});
test('不完整流自动失败并释放预留，返回错误事件且不阻塞后续请求', async t => {
  const f = await fixture(t); f.mock.state.incomplete = true;
  const stream=await (await f.relay('/ai/generate-image-stream',payload())).text(); assert.match(stream,/event: error/);
  const job = f.app.store.jobs()[0]; assert.equal(job.status,'failed'); assert.equal(f.app.store.key(f.key.id).reserved,0);
  assert.equal(f.app.store.key(f.key.id).balance,100); assert.equal(job.charged,0); assert.equal(job.upstream_spent,0);
  f.mock.state.incomplete=false;
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.equal((await f.call(`/admin/api/jobs/${job.id}/resolve`,'POST',{completed:true,note:'旧确认入口'})).status,404);
  assert.equal(f.app.store.key(f.key.id).balance,74); assert.equal(f.app.store.key(f.key.id).reserved,0);
});
test('同一访问 Key 并发请求依次排队，不限频且不会双花', async t => {
  const f=await fixture(t); f.mock.state.slow=50;
  const results=await Promise.all([f.relay('/ai/generate-image',payload()),f.relay('/ai/generate-image',payload())]);
  assert.deepEqual(results.map(r=>r.status),[200,200]);
  assert.equal(f.app.store.key(f.key.id).balance,48);
  assert.equal(f.mock.state.maxActiveGenerations,1);
});

test('幂等键不重复生成，上游余额变化不影响本地结算', async t => {
  const f=await fixture(t);
  assert.equal((await f.relay('/ai/generate-image',payload(),{'Idempotency-Key':'test-request'})).status,200);
  assert.equal((await f.relay('/ai/generate-image',payload(),{'Idempotency-Key':'test-request'})).status,409);
  f.mock.state.deltaOverride=40;
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.equal(f.app.store.jobs()[0].status,'completed');
  assert.equal(f.app.store.key(f.key.id).balance,48);
});

test('普通 Key 使用免费 Opus，上游消耗零仍按本地报价扣点', async t => {
  const f=await fixture(t); f.mock.state.paid=false; f.mock.state.calls=[];
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.equal(f.mock.state.balance,10000);
  assert.equal(f.app.store.key(f.key.id).balance,74);
  assert.equal(f.app.store.jobs()[0].charged,26);
  assert.equal(f.app.store.jobs()[0].upstream_estimate,0);
  assert.deepEqual(f.mock.state.calls.map(c=>c.path),['/user/subscription','/ai/generate-image']);
});

test('Anlas 调整拒绝小数、负余额以及对预留 Anlas 的扣减', async t => {
  const f = await fixture(t);
  for (const delta of [-101,0.5,1e20]) assert.equal((await f.call(`/admin/api/keys/${f.key.id}/points`,'POST',{delta,note:'测试'})).status,400);
  f.app.store.reserve(f.key.id,'hold','/ai/generate-image','test',26,null,1);
  assert.equal((await f.call(`/admin/api/keys/${f.key.id}/points`,'POST',{delta:-80,note:'不能动预留'})).status,400);
});
test('重启把未完成请求自动判为失败并释放预留，账本和 Key 保持持久化', () => {
  const dir=mkdtempSync(join(tmpdir(),'sakura-restart-')); const first=new Store(dir);
  const key=first.createKey('持久化',100); first.setUpstream('pst-test'); first.reserve(key.id,'interrupted','/ai/generate-image','v5',26,null,1); first.close();
  const second=new Store(dir);
  assert.equal(second.jobs()[0].status,'failed'); assert.equal(second.authenticate(key.token).reserved,0); assert.equal(second.authenticate(key.token).balance,100); assert.equal(second.upstreamToken(),'pst-test');
  second.close(); rmSync(dir,{recursive:true,force:true});
});
test('Vibe、标签建议与图片放大接口兼容', async t => {
  const f = await fixture(t); f.mock.state.cost=2;
  assert.equal((await f.relay('/ai/encode-vibe',{image:'base64',model:'nai-diffusion-4-5-full',information_extracted:1})).status,200);
  assert.equal(f.app.store.key(f.key.id).balance,98);
  assert.equal((await f.relay('/ai/generate-image/suggest-tags?model=nai-diffusion-5-full&prompt=cherry')).status,200);
  f.mock.state.cost=1;
  const form = new FormData(); form.append('request',new Blob([JSON.stringify({image:'image',model:'nai-diffusion-5-curated'})],{type:'application/json'})); form.append('image',new Blob([Buffer.from(image,'base64')],{type:'image/png'}),'image.png');
  const res=await fetch(f.base+'/ai/upscale',{method:'POST',headers:{Authorization:`Bearer ${f.key.token}`},body:form});
  assert.equal(res.status,200); assert.equal(f.app.store.key(f.key.id).balance,97);
});
test('局部重绘与零强度图生图的参数和预留兼容', () => {
  const account={tier:0,active:false}, request=payload();
  request.model+='-inpainting'; request.action='infill'; Object.assign(request.parameters,{image:'base64',mask:'base64',strength:1,inpaintImg2ImgStrength:0.2});
  assert.equal(reservation('/ai/generate-image',request,account),6);
  request.model='nai-diffusion-5-full';request.action='img2img';request.parameters.strength=0;
  assert.equal(reservation('/ai/generate-image',request,account),2);
});
const maxEnhancePayload = () => ({
  ...payload(), action: 'img2img', input: 'edited prompt',
  parameters: { ...payload().parameters, steps: 28, image, strength: 0.2, noise: 0.12,
    scale: 7, sampler: 'k_euler', upscaled_enhance: true },
});

test('V5 Full 与 Curated 的普通及流式 Max 增强按输出面积预留结算并保留请求参数', async t => {
  const f = await fixture(t); f.mock.state.cost = 18;
  for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated']) {
    for (const path of ['/ai/generate-image', '/ai/generate-image-stream']) {
      const request = { ...maxEnhancePayload(), model };
      const response = await f.relay(path, request);
      assert.equal(response.status, 200); await response.text();
      const sent = f.mock.state.calls.findLast(c => c.path === path).body;
      assert.equal(sent.model, model); assert.equal(sent.action, 'img2img'); assert.equal(sent.input, request.input);
      for (const name of ['width', 'height', 'steps', 'n_samples', 'image', 'strength', 'noise', 'scale', 'sampler', 'upscaled_enhance'])
        assert.equal(sent.parameters[name], request.parameters[name]);
      const job = f.app.store.jobs()[0];
      assert.equal(job.reserved, 18); assert.equal(job.charged, 18);
      assert.equal(job.upstream_estimate, 18); assert.equal(job.upstream_spent, 18);
      assert.equal(job.status, 'completed'); assert.equal(f.app.store.key(f.key.id).reserved, 0);
    }
  }
  assert.equal(f.app.store.key(f.key.id).balance, 28);
});

test('会员 Max 超出免费规格，上游有无体力均跳过不足额和零余额账号', async t => {
  for (const paid of [false, true]) await t.test(paid ? '上游体力耗尽' : '上游体力有效', async t => {
    const f = await fixture(t); f.mock.state.paid = paid; f.mock.state.balance = 0; await member(f);
    await addAccount(f, 'pst-poor-opus', { tier: 3, paid: false, balance: 17 });
    const funded = await addAccount(f, 'pst-funded-max', { tier: 1, paid: true, balance: 18, cost: 18 });
    f.mock.state.calls = [];
    assert.equal((await f.relay('/ai/generate-image', maxEnhancePayload())).status, 200);
    const job = f.app.store.jobs()[0];
    assert.equal(job.charged, 18); assert.equal(job.upstream_estimate, 18); assert.equal(job.upstream_id, funded);
    assert.equal(job.route_mode, 'anlas-pool');
    assert.equal(f.app.store.key(f.key.id).balance, 82);
    assert.equal(f.mock.state.balance, 0); assert.equal(f.mock.state.accounts.get('pst-poor-opus').balance, 17);
    assert.equal(generatedCalls(f).length, 1); assert.equal(generatedCalls(f)[0].auth, 'Bearer pst-funded-max');
  });
});

test('Max 按输出面积检查下游余额，17 Anlas 不足时生成前拒绝', async t => {
  const f = await fixture(t); f.app.store.adjust(f.key.id, -83, '只留 17 Anlas');
  for (const path of ['/ai/generate-image', '/ai/generate-image-stream']) {
    const response = await f.relay(path, maxEnhancePayload());
    assert.equal(response.status, 402); assert.match(await response.text(), /18 Anlas/);
  }
  assert.equal(f.mock.state.calls.filter(c => c.path.startsWith('/ai/')).length, 0);
  assertEntryFailures(f, 2); assert.equal(f.app.store.key(f.key.id).reserved, 0);
  assert.equal(f.app.store.key(f.key.id).balance, 17);
});

test('Max 上游拒绝或流式缺少最终图片时释放全部预留，不计入用量', async t => {
  for (const streaming of [false, true]) await t.test(streaming ? '流式断流' : '上游拒绝', async t => {
    const f = await fixture(t); f.mock.state.cost = 18;
    if (streaming) f.mock.state.incomplete = true; else f.mock.state.fail = true;
    const path = streaming ? '/ai/generate-image-stream' : '/ai/generate-image';
    const response = await f.relay(path, maxEnhancePayload());
    assert.equal(response.status, streaming ? 200 : 429);
    const text = await response.text(); if (streaming) assert.match(text, /event: error/);
    const job = f.app.store.jobs()[0];
    assert.equal(job.reserved, 18); assert.equal(job.charged, 0); assert.equal(job.upstream_spent, 0);
    assert.equal(job.status, 'failed'); assert.equal(f.app.store.key(f.key.id).reserved, 0);
    assert.equal(f.app.store.key(f.key.id).balance, 100);
    assert.equal(f.mock.state.calls.filter(c => c.path === path).length, 1);
  });
});

test('不支持的 Max 请求在查询上游和预留余额前拒绝', async t => {
  const f = await fixture(t); f.mock.state.calls = [];
  for (const change of [{ model: 'nai-diffusion-4-5-full' }, { action: 'generate' },
    { parameters: { upscaled_enhance: 'true' } }, { parameters: { noise: 1.1 } },
    { parameters: { steps: 50, strength: 0.99 } }]) {
    const request = maxEnhancePayload();
    const parameters = { ...request.parameters, ...change.parameters };
    Object.assign(request, change, { parameters });
    assert.equal((await f.relay('/ai/generate-image', request)).status, 400);
  }
  assert.equal(f.mock.state.calls.length, 0); assertEntryFailures(f, 5);
});

test('上游查询失败不发起生成，失效会话及暂停中转正确拒绝', async t => {
  const f=await fixture(t);f.mock.state.queryFails=true;
  assert.equal((await f.relay('/ai/generate-image',payload())).status,502);
  assertEntryFailures(f, 1);
  f.mock.state.queryFails=false;
  await f.call('/admin/api/settings','PUT',{name:'Mock',origins:[],enabled:false});
  assert.equal((await f.relay('/user/subscription')).status,503);
  await f.call('/admin/api/logout','POST',{});
  assert.equal((await f.call('/admin/api/snapshot')).status,401);
});
test('客户端在收到流后取消，后端仍读取上游并完成 Anlas 结算', async t => {
  const f=await fixture(t); const response=await f.relay('/ai/generate-image-stream',payload());
  const reader=response.body.getReader(); await reader.read(); await reader.cancel();
  for(let i=0;i<50 && f.app.isBusy();i++) await new Promise(r=>setTimeout(r,10));
  assert.equal(f.app.store.jobs()[0].status,'completed'); assert.equal(f.app.store.key(f.key.id).balance,74);
});

export async function addAccount(f, token, { enabled = true, ...account } = {}) {
  f.mock.state.accounts.set(token, { ...f.mock.state, ...account });
  const res = await f.call('/admin/api/upstreams', 'POST', { name: token.slice(4), token, enabled });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}
const generatedCalls = f => f.mock.state.calls.filter(c => c.path === '/ai/generate-image');

test('普通点数请求优先非 Opus 账号，占用中再按 Opus 到期时间换下一个', async t => {
  const f = await fixture(t), now = Math.floor(Date.now() / 1000);
  f.mock.state.tier = 3;
  f.mock.state.expiresAt = now + 86400;
  const points = await addAccount(f, 'pst-points', { tier: 1, expiresAt: now + 86400 * 30, balance: 10000 });
  await addAccount(f, 'pst-disabled-points', { enabled: false, tier: 0, expiresAt: now - 86400 });
  f.app.store.adjust(f.key.id, 1000, '测试');
  for (let i = 0; i < 3; i++) assert.equal((await f.relay('/ai/generate-image', payload())).status, 200);
  assert.deepEqual(generatedCalls(f).map(c => c.auth), Array(3).fill('Bearer pst-points'));
  assert.ok(!f.mock.state.calls.some(c => c.auth === 'Bearer pst-disabled-points' && c.path === '/ai/generate-image'));
  f.mock.state.accounts.get('pst-points').slow = 150;
  const other = await (await f.call('/admin/api/keys', 'POST', { name: '另一个用户', points: 100 })).json();
  const first = f.relay('/ai/generate-image', payload());
  await waitFor(() => generatedCalls(f).length === 4);
  const second = f.relay('/ai/generate-image', payload(), { Authorization: 'Bearer ' + other.token });
  await waitFor(() => generatedCalls(f).length === 5);
  assert.equal(generatedCalls(f).at(-1).auth, 'Bearer pst-local-test');
  assert.deepEqual((await Promise.all([first, second])).map(r => r.status), [200, 200]);
  assert.equal((await f.relay('/ai/generate-image', payload())).status, 200);
  assert.equal(generatedCalls(f).at(-1).auth, 'Bearer pst-points');
  assert.ok(f.app.store.jobs().some(j => j.upstream_id === points));
  assert.equal(f.app.store.key(f.key.id).balance, 1100 - 26 * 5);
});

test('全部上游额度查询隔离失败；会员本地体力不随账号池变化', async t => {
  const f=await fixture(t);
  const id=await addAccount(f,'pst-second',{balance:6400,paid:false});
  await addAccount(f,'pst-offline',{enabled:false}); f.mock.state.accounts.get('pst-offline').queryFails=true;
  const q=await (await f.call('/admin/api/quota')).json();
  assert.equal(q.totalAnlas,16400); assert.equal(q.failed,1);
  assert.equal(q.upstreams.find(u=>u.id===id).account.usage.percent,73.6);
  f.mock.state.paid=false; f.mock.state.usagePercent=41; await member(f);
  for(let i=0;i<3;i++){
    const account=await (await f.relay('/user/subscription')).json();
    assert.equal(account.relay.usageSource,'local'); assert.equal(account.usage.percent,3.6);
  }
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.equal(generatedCalls(f)[0].auth,'Bearer pst-local-test');
});

test('不同上游可并行，同一访问 Key 仍按顺序处理', async t => {
  const f=await fixture(t); f.mock.state.slow=100; await addAccount(f,'pst-second');
  const secondKey=await (await f.call('/admin/api/keys','POST',{name:'另一个用户',points:100})).json();
  const first=f.relay('/ai/generate-image',payload());
  await waitFor(()=>generatedCalls(f).length===1);
  const same=f.relay('/ai/generate-image',payload());
  const second=f.relay('/ai/generate-image',payload(),{Authorization:'Bearer '+secondKey.token});
  await waitFor(()=>generatedCalls(f).length===2);
  assert.equal(f.app.router.busy.size,2);
  assert.deepEqual((await Promise.all([first,same,second])).map(r=>r.status),[200,200,200]);
  assert.equal(f.app.store.key(f.key.id).balance,48); assert.equal(f.app.store.key(secondKey.id).balance,74);
});

test('失败请求自动结算，不阻止后续生成和上游凭据修改', async t => {
  const f=await fixture(t); f.mock.state.incomplete=true;
  await (await f.relay('/ai/generate-image-stream',payload())).text();
  assert.equal(f.app.store.jobs()[0].status,'failed');
  assert.equal((await f.call('/admin/api/upstreams/1','PUT',{name:'更换',token:'pst-new',enabled:true})).status,200);
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
});

test('添加和编辑无需专用账户确认；禁止重复 Key，移除后可重新添加', async t => {
  const f = await fixture(t);
  const body = {name:'另一个上游',token:'pst-second',enabled:true};
  const saved = await (await f.call('/admin/api/upstreams','POST',body)).json();
  assert.equal((await f.call('/admin/api/upstreams','POST',body)).status,409);
  assert.equal((await f.call('/admin/api/upstreams/'+saved.id,'PUT',{name:'新名称',enabled:false})).status,200);
  assert.equal(f.app.store.upstream(saved.id).enabled,0);
  assert.ok(!('weight' in f.app.store.upstream(saved.id)));
  assert.equal((await f.call('/admin/api/upstreams/'+saved.id,'DELETE')).status,200);
  assert.equal((await f.call('/admin/api/upstreams','POST',body)).status,201);
  assert.equal(f.app.store.upstreams().find(u=>u.id===saved.id).name,body.name);
  for (const enabled of [-1,0.5,1001]) assert.equal((await f.call('/admin/api/upstreams/'+saved.id,'PUT',{...body,token:'',enabled})).status,400);
  assert.ok(!(await (await f.call('/admin/api/quota')).json()).upstreams.some(u=>'weight' in u));
  const snapshot = await (await f.call('/admin/api/snapshot')).text();
  assert.ok(!snapshot.includes('pst-second'));
});

test('429 不把账户的其他余额变化记给本次请求，立即释放预留', async t => {
  const f = await fixture(t);
  f.mock.state.fail=true; f.mock.state.failBalanceDelta=50; f.mock.state.calls=[];
  assert.equal((await f.relay('/ai/generate-image',payload())).status,429);
  assert.equal(f.app.store.key(f.key.id).balance,100);
  assert.equal(f.app.store.key(f.key.id).reserved,0);
  assert.equal(f.app.store.jobs()[0].status,'failed');
  assert.equal(f.mock.state.calls.filter(c=>c.path==='/user/subscription').length,1);
});

test('完成响应后不查询余额，直接按本地价格结算', async t => {
  const f=await fixture(t); f.mock.state.calls=[];
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.deepEqual(f.mock.state.calls.map(c=>c.path),['/user/subscription','/ai/generate-image']);
});



test('余额仅 1 Anlas 时，240 Anlas 的生成与流式请求在上游调用前被拒绝', async t => {
  const f=await fixture(t);
  f.app.store.adjust(f.key.id,-99,'仅剩 1 Anlas');
  const request=payload();
  Object.assign(request.parameters,{width:1024,height:1536,steps:38,n_samples:4});
  // A direct caller cannot override server pricing with a forged client estimate.
  Object.assign(request,{cost:0,anlas:0,free:true});
  assert.equal(reservation('/ai/generate-image',request,{tier:0,active:false}),240);
  for (const path of ['/ai/generate-image','/ai/generate-image-stream']) {
    const response=await f.relay(path,request);
    assert.equal(response.status,402); assert.match((await response.json()).error,/240 Anlas/);
  }
  assert.equal(generatedCalls(f).length,0);
  assert.equal(f.mock.state.calls.filter(c=>c.path==='/ai/generate-image-stream').length,0);
  assert.equal(f.app.store.key(f.key.id).balance,1);
  assert.equal(f.app.store.key(f.key.id).reserved,0);
  assertEntryFailures(f, 2);
});

test('本地报价 240 就扣 240，上游实扣 220 不改变价格，排队请求不能透支', async t => {
  const f=await fixture(t); f.app.store.adjust(f.key.id,140,'补充余额'); f.mock.state.slow=100; f.mock.state.cost=220;
  const request=payload(); Object.assign(request.parameters,{width:1024,height:1536,steps:38,n_samples:4});
  const pending=f.relay('/ai/generate-image',request); await waitFor(()=>generatedCalls(f).length===1);
  assert.equal(f.app.store.key(f.key.id).reserved,240);
  const queued=f.relay('/ai/generate-image',request);
  assert.equal((await f.call('/admin/api/keys/'+f.key.id+'/points','POST',{delta:-1,note:'不能动预留'})).status,400);
  assert.equal((await pending).status,200); assert.equal((await queued).status,402);
  assert.equal(f.app.store.key(f.key.id).balance,0); assert.equal(f.app.store.key(f.key.id).reserved,0);
  assert.equal(f.app.store.jobs().find(job => job.status === 'completed').charged,240);
});

test('本地体力存在而上游耗尽时明确报错，不偷偷扣点或付费生成',async t=>{
 const f=await fixture(t);await member(f);f.mock.state.paid=false;assert.equal((await(await f.relay('/user/subscription')).json()).usage.isNegative,false);
 f.app.store.adjust(f.key.id,-99,'只留 1 Anlas');f.mock.state.paid=true;
 const response=await f.relay('/ai/generate-image',payload());assert.equal(response.status,503);assert.equal((await response.json()).code,'UPSTREAM_STAMINA_UNAVAILABLE');
 assert.equal(generatedCalls(f).length,0);assert.equal(f.app.store.key(f.key.id).stamina_balance,4000);assert.equal(f.app.store.key(f.key.id).balance,1);
});

test('参考图费用、批量与 Vibe 编码不能绕过余额检查', async t => {
  const f=await fixture(t); f.mock.state.paid=false;
  f.app.store.adjust(f.key.id,-99,'只留 1 Anlas');
  const reference=payload(); reference.model='nai-diffusion-4-5-full';
  reference.parameters.director_reference_images=['ref'];
  assert.equal((await f.relay('/ai/generate-image',reference)).status,402);
  const batch=payload(); batch.parameters.n_samples=2;
  assert.equal((await f.relay('/ai/generate-image',batch)).status,402);
  assert.equal((await f.relay('/ai/encode-vibe',{image,model:'nai-diffusion-4-5-full'})).status,402);
  assert.equal(f.mock.state.calls.filter(c=>c.path.startsWith('/ai/')).length,0);
});

test('拒绝伪造图片处理尺寸、未知模型与无效计价参数', async t => {
  const f=await fixture(t);
  assert.equal((await f.relay('/ai/augment-image',{image,width:1024,height:1024,req_type:'bg-removal'})).status,400);
  for (const parameters of [{n_samples:0},{n_samples:1.5},{steps:-1},{width:Infinity},{upscale:true},{sm_dyn:true}]) {
    const request=payload(); Object.assign(request.parameters,parameters);
    assert.equal((await f.relay('/ai/generate-image',request)).status,400);
  }
  const request=payload(); request.model='unknown-future-model';
  assert.equal((await f.relay('/ai/generate-image',request)).status,400);
  assert.equal(generatedCalls(f).length,0);
});

async function member(f) {
  assert.equal((await f.call('/admin/api/keys/'+f.key.id,'POST',{tier:'member'})).status,200);
}
async function waitFor(check) {
  for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}
  assert.fail('等待状态超时');
}

test('会员无需绑定或上游即可创建，体力上限校验且普通 Key 不分配体力',async t=>{
 const f=await fixture(t);assert.equal((await f.call('/admin/api/upstreams/1','DELETE')).status,200);f.mock.state.calls=[];
 for(const staminaPercent of [0,1,25,37,100]){const res=await f.call('/admin/api/keys','POST',{points:0,tier:'member',staminaPercent});assert.equal(res.status,201);
 const created=await res.json(),key=f.app.store.key(created.id);assert.equal(key.stamina_balance,staminaPercent*1120);assert.equal(key.stamina_capacity,staminaPercent*1120);assert.equal(key.nai5_upstream_id,undefined);
 const subscription=await(await f.relay('/user/subscription',undefined,{Authorization:'Bearer '+created.token})).json();assert.deepEqual(subscription.usage,{percent:staminaPercent,isNegative:staminaPercent === 0});}
 for(const staminaPercent of [-1,101,25.5,'25',null])assert.equal((await f.call('/admin/api/keys','POST',{points:0,tier:'member',staminaPercent})).status,400);
 assert.equal((await f.call('/admin/api/keys','POST',{points:0,tier:'standard',staminaPercent:25})).status,400);
 assert.equal((await f.call('/admin/api/keys','POST',{points:0,tier:'unknown'})).status,400);assert.equal(f.mock.state.calls.length,0);
 await member(f);assert.equal((await f.relay('/user/subscription')).status,200);
 const noUpstream=await f.relay('/ai/generate-image',payload());assert.equal(noUpstream.status,503);assert.equal((await noUpstream.json()).code,'UPSTREAM_STAMINA_UNAVAILABLE');
});

test('两个会员体力独立，上游出队时耗尽只拒绝后一个，不回退付费账号',async t=>{
 const f=await fixture(t);await member(f);f.mock.state.paid=false;f.mock.state.slow=150;f.mock.state.onGenerate=()=>{f.mock.state.paid=true;};
 await addAccount(f,'pst-funded',{paid:true,balance:1000});const other=f.app.store.createKey('另一会员',100,{tier:'member'});
 const first=f.relay('/ai/generate-image',payload());await waitFor(()=>generatedCalls(f).length===1);
 const second=f.relay('/ai/generate-image',payload(),{Authorization:'Bearer '+other.token});await waitFor(()=>f.app.router.upstreamQueue.size(1)===2);
 assert.deepEqual((await Promise.all([first,second])).map(r=>r.status),[200,503]);assert.equal(generatedCalls(f).length,1);
 assert.equal(f.app.store.key(f.key.id).stamina_balance,3900);assert.equal(f.app.store.key(other.id).stamina_balance,28000);
 assert.equal(f.app.store.key(other.id).stamina_reserved,0);assert.equal(f.app.store.key(other.id).balance,100);
});

test('会员体力耗尽后选到有体力的 Opus 仍收费，不继承账号池体力', async t => {
  const f=await fixture(t); f.mock.state.balance=0; await member(f); f.app.store.db.prepare('UPDATE keys SET stamina_balance=0 WHERE id=?').run(f.key.id);
  await addAccount(f,'pst-free-opus',{paid:false,balance:1000});
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.equal(generatedCalls(f)[0].auth,'Bearer pst-free-opus');
  assert.equal(f.app.store.key(f.key.id).balance,74);
  assert.equal(f.mock.state.accounts.get('pst-free-opus').balance,1000);
  assert.equal(f.app.store.jobs()[0].upstream_estimate,0);
  assert.equal((await (await f.relay('/user/subscription')).json()).usage.percent,0);
});

test('会员体力耗尽后优先零 Anlas 的体力池，下游仍扣点且不改变本地体力', async t => {
  const f=await fixture(t); f.mock.state.balance=0; await member(f); f.app.store.db.prepare('UPDATE keys SET stamina_balance=0 WHERE id=?').run(f.key.id);
  await addAccount(f,'pst-funded',{paid:true,balance:1000});
  await addAccount(f,'pst-empty-free',{paid:false,balance:0});
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.equal(generatedCalls(f)[0].auth,'Bearer pst-empty-free'); assert.equal(f.app.store.key(f.key.id).balance,74);
  assert.equal(f.app.store.jobs()[0].route_mode,'nai5-stamina-pool'); assert.equal(f.app.store.jobs()[0].upstream_estimate,0);
  assert.equal(f.mock.state.accounts.get('pst-empty-free').balance,0);
  assert.equal(f.mock.state.accounts.get('pst-funded').balance,1000);
  assert.equal((await (await f.relay('/user/subscription')).json()).usage.percent,0);
});

test('本地体力为零时按点数使用，不能继承上游免费体力',async t=>{
 const f=await fixture(t);await member(f);f.app.store.db.prepare('UPDATE keys SET stamina_balance=0 WHERE id=?').run(f.key.id);f.mock.state.paid=false;
 assert.deepEqual((await(await f.relay('/user/subscription')).json()).usage,{percent:0,isNegative:true});
 assert.equal((await f.relay('/ai/generate-image',payload())).status,200);assert.equal(f.app.store.jobs()[0].charged,26);assert.equal(f.app.store.jobs()[0].stamina_charged,0);
});

test('真实上游非 Opus 或已过期时不能承接本地体力请求，余额充足也报错',async t=>{
 const f=await fixture(t);await member(f);f.mock.state.paid=false;
 for(const value of [{tier:1,expiresAt:Date.now()/1000+10000},{tier:3,expiresAt:Date.now()/1000-10}]){
 Object.assign(f.mock.state,value);assert.deepEqual((await(await f.relay('/user/subscription')).json()).usage,{percent:3.6,isNegative:false});
 const response=await f.relay('/ai/generate-image',payload());assert.equal(response.status,503);assert.equal((await response.json()).code,'UPSTREAM_STAMINA_UNAVAILABLE');}
 assert.equal(generatedCalls(f).length,0);assert.equal(f.app.store.key(f.key.id).balance,100);assert.equal(f.app.store.key(f.key.id).stamina_balance,4000);
});

test('会员非 NAI5 按 Opus 本地计价且不锁定上游，放大不误判为 NAI5 生图', async t => {
  const f=await fixture(t); await member(f);
  const second=await addAccount(f,'pst-secondary',{tier:1,paid:true});
  await f.call('/admin/api/upstreams/1','PUT',{name:'暂停上游账号',enabled:false});
  const v45=payload();v45.model='nai-diffusion-4-5-full';
  assert.equal((await f.relay('/ai/generate-image',v45)).status,200);
  assert.equal(f.app.store.jobs()[0].charged,0); assert.equal(f.app.store.jobs()[0].upstream_id,second);
  assert.equal((await f.relay('/ai/upscale',{model:'nai-diffusion-5-curated',image})).status,200);
  assert.equal(f.app.store.jobs()[0].charged,0); assert.equal(f.app.store.jobs()[0].route_mode,'anlas-pool');
  assert.equal((await f.relay('/ai/generate-image',payload())).status,503);
});

test('会员请求超规格或带参考图时仍按 Opus 公式收费', async t => {
  const f=await fixture(t); await member(f); f.mock.state.paid=false;
  const large=payload();large.parameters.steps=35;
  assert.equal((await f.relay('/ai/generate-image',large)).status,200);
  assert.equal(f.app.store.jobs()[0].charged,36);assert.equal(f.app.store.jobs()[0].route_mode,'anlas-pool');
  const ref=payload();ref.model='nai-diffusion-4-5-full';ref.parameters.director_reference_images=['reference'];
  assert.equal((await f.relay('/ai/generate-image',ref)).status,200);
  assert.equal(f.app.store.jobs()[0].charged,5);
  const vibe=payload();vibe.model='nai-diffusion-4-5-full';vibe.parameters.reference_image_multiple=Array(5).fill('encoded');
  assert.equal((await f.relay('/ai/generate-image',vibe)).status,200);
  assert.equal(f.app.store.jobs()[0].charged,2);
});

test('普通与会员的 V4.5 和 Director 使用各自计价，与真实上游等级分开', async t => {
  const f=await fixture(t); f.mock.state.paid=false;
  const v45=payload();v45.model='nai-diffusion-4-5-full';
  assert.equal((await f.relay('/ai/generate-image',v45)).status,200);assert.equal(f.app.store.jobs()[0].charged,17);
  const png=Buffer.from(image,'base64');png.writeUInt32BE(64,16);png.writeUInt32BE(64,20);
  const director={image:png.toString('base64'),width:64,height:64,req_type:'lineart'};
  assert.equal((await f.relay('/ai/augment-image',director)).status,200);assert.equal(f.app.store.jobs()[0].charged,20);
  await member(f);
  assert.equal((await f.relay('/ai/generate-image',v45)).status,200);assert.equal(f.app.store.jobs()[0].charged,0);
  assert.equal((await f.relay('/ai/augment-image',director)).status,200);assert.equal(f.app.store.jobs()[0].charged,0);
});

test('到期在鉴权时拒绝；续期保留余额；订阅返回下游到期时间', async t => {
  const f=await fixture(t); const past=Date.now()-1000;
  assert.equal((await f.call('/admin/api/keys/'+f.key.id,'POST',{expiresAt:past})).status,200);
  const res=await f.relay('/user/subscription');assert.equal(res.status,403);assert.equal((await res.json()).code,'KEY_EXPIRED');
  assert.equal((await f.relay('/ai/generate-image',payload())).status,403);assert.equal(generatedCalls(f).length,0);
  const expiredKey = (await (await f.call('/admin/api/snapshot')).json()).keys.find(key => key.id === f.key.id);
  assert.equal(expiredKey.expires_at, past); assert.equal(expiredKey.balance, 100); assert.equal(expiredKey.enabled, 1);
  assert.deepEqual(await (await f.call(`/admin/api/keys/${f.key.id}/reveal`, 'POST', {})).json(), f.key);
  assert.equal(f.app.store.ledger().filter(row => row.key_id === f.key.id).length, 1);
  const before=Date.now();await f.call('/admin/api/keys/'+f.key.id,'POST',{validDays:7});
  const expires=f.app.store.key(f.key.id).expires_at;assert.ok(expires>=before+7*86400000);
  await f.call('/admin/api/keys/'+f.key.id,'POST',{validDays:3});
  assert.equal(f.app.store.key(f.key.id).expires_at,expires+3*86400000);
  await member(f); const data=await (await f.relay('/user/subscription')).json();
  assert.equal(data.expiresAt,(expires+3*86400000)/1000);assert.equal(data.relay.expiresAt,expires+3*86400000);
  assert.equal(data.trainingStepsLeft.fixedTrainingStepsLeft,100);
  await f.call('/admin/api/keys/'+f.key.id,'POST',{expiresAt:null});
  assert.equal((await (await f.relay('/user/subscription')).json()).expiresAt,undefined);
});

test('排队期间到期不再发起上游请求，已发送的请求继续结算', async t => {
  const f=await fixture(t);f.mock.state.slow=120;
  const first=f.relay('/ai/generate-image',payload());await waitFor(()=>generatedCalls(f).length===1);
  const second=f.relay('/ai/generate-image',payload());await waitFor(()=>f.app.router.keyQueue.size(f.key.id)===2);
  await f.call('/admin/api/keys/'+f.key.id,'POST',{expiresAt:Date.now()-1});
  assert.equal((await first).status,200);assert.equal((await second).status,403);
  assert.equal(generatedCalls(f).length,1);assert.equal(f.app.store.key(f.key.id).balance,74);
});

test('排队期间取消请求会撤销等待，不触发额外生成', async t => {
  const f=await fixture(t);f.mock.state.slow=120;
  const first=f.relay('/ai/generate-image',payload());await waitFor(()=>generatedCalls(f).length===1);
  const cancel=new AbortController();
  const next=fetch(f.base+'/ai/generate-image',{method:'POST',headers:{Authorization:'Bearer '+f.key.token,'Content-Type':'application/json'},body:JSON.stringify(payload()),signal:cancel.signal}).catch(e=>e.name);
  await waitFor(()=>f.app.router.keyQueue.size(f.key.id)===2);cancel.abort();assert.equal(await next,'AbortError');
  assert.equal((await first).status,200);await waitFor(()=>f.app.router.keyQueue.size(f.key.id)===0);
  assert.equal(generatedCalls(f).length,1);
});

test('查询上游期间到期在原子预留前拒绝；普通查询不受上游故障影响', async t => {
  const f=await fixture(t); f.mock.state.queryFails=true;
  assert.equal((await f.relay('/user/subscription')).status,200);
  f.mock.state.queryFails=false;f.mock.state.querySlow=100;
  const pending=f.relay('/ai/generate-image',payload());await waitFor(()=>f.app.isBusy());
  await f.call('/admin/api/keys/'+f.key.id,'POST',{expiresAt:Date.now()-1});
  assert.equal((await pending).status,403);assert.equal(generatedCalls(f).length,0);assert.equal(f.app.store.key(f.key.id).reserved,0);
});

test('同一上游的不同会员串行生成，执行期间禁止修改等级或体力上限', async t => {
  const f=await fixture(t);await member(f);f.mock.state.paid=false;f.mock.state.slow=70;
  const other=await (await f.call('/admin/api/keys','POST',{name:'会员2',points:100,tier:'member'})).json();
  const first=f.relay('/ai/generate-image',payload());await waitFor(()=>generatedCalls(f).length===1);
  const second=f.relay('/ai/generate-image',payload(),{Authorization:'Bearer '+other.token});
  assert.equal((await f.call('/admin/api/keys/'+f.key.id,'POST',{tier:'standard'})).status,409);
  assert.equal((await f.call('/admin/api/keys/'+f.key.id,'POST',{staminaPercent:100})).status,409);
  assert.deepEqual((await Promise.all([first,second])).map(r=>r.status),[200,200]);
  assert.equal(f.mock.state.maxActiveGenerations,1);assert.equal(f.app.store.key(f.key.id).balance,100);assert.equal(f.app.store.key(other.id).balance,100);
});

test('不限制下游查询频率，没有按日免费限额字段', async t => {
  const f=await fixture(t);
  for(let i=0;i<100;i++)assert.equal((await f.relay('/user/subscription')).status,200);
  const data=await (await f.call('/admin/api/snapshot')).json();
  assert.equal(data.keys[0].dailyLimit,undefined);assert.equal(data.keys[0].rateLimit,undefined);
});

test('上游拒绝与流式失败自动退款，人工确认接口已移除', async t => {
  const f=await fixture(t);f.mock.state.fail=true;f.mock.state.failStatus=400;f.mock.state.calls=[];
  assert.equal((await f.relay('/ai/generate-image',payload())).status,400);
  assert.equal(f.app.store.key(f.key.id).balance,100);assert.equal(f.app.store.key(f.key.id).reserved,0);
  assert.deepEqual(f.mock.state.calls.map(c=>c.path),['/user/subscription','/ai/generate-image']);
  f.mock.state.fail=false;f.mock.state.incomplete=true;
  await(await f.relay('/ai/generate-image-stream',payload())).text();const job=f.app.store.jobs()[0];
  assert.equal((await f.call('/admin/api/jobs/'+job.id+'/resolve','POST',{charged:10,note:'任意差额'})).status,404);
  assert.equal((await f.call('/admin/api/jobs/'+job.id+'/resolve','POST',{completed:false,note:'旧确认入口'})).status,404);
  assert.equal(f.app.store.key(f.key.id).balance,100);assert.equal(f.app.store.key(f.key.id).reserved,0);
});



test('会员本地体力轮询不改变点数请求的到期顺序', async t => {
  const f=await fixture(t),now=Math.floor(Date.now()/1000);
  f.mock.state.paid=false;f.mock.state.tier=3;f.mock.state.expiresAt=now+86400*30;
  await addAccount(f,'pst-second',{tier:3,paid:false,expiresAt:now+86400});
  await member(f);
  for(let i=0;i<4;i++)assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.deepEqual(generatedCalls(f).map(c=>c.auth),Array.from({length:4},(_,i)=>i%2?'Bearer pst-second':'Bearer pst-local-test'));
  await f.call('/admin/api/keys/'+f.key.id,'POST',{tier:'standard'});
  f.mock.state.calls=[];f.app.store.adjust(f.key.id,1000,'测试');
  for(let i=0;i<4;i++)assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.deepEqual(generatedCalls(f).map(c=>c.auth),Array(4).fill('Bearer pst-second'));
});

const v45Payload = () => ({ ...payload(), model:'nai-diffusion-4-5-full' });

test('会员非 NAI5 优先有效 Opus，零体力零 Anlas 仍可接免费请求', async t => {
  const f=await fixture(t); f.mock.state.tier=1; await member(f);
  await f.call('/admin/api/upstreams/1','PUT',{name:'普通账号',enabled:true});
  const opus=await addAccount(f,'pst-opus',{tier:3,balance:0,paid:true,deltaOverride:0});
  f.mock.state.calls=[];
  assert.equal((await f.relay('/ai/generate-image',v45Payload())).status,200);
  assert.deepEqual(generatedCalls(f).map(c=>c.auth),['Bearer pst-opus']);
  const job=f.app.store.jobs()[0];
  assert.equal(job.upstream_id,opus); assert.equal(job.route_mode,'opus-pool');
  assert.equal(job.upstream_estimate,0); assert.equal(job.charged,0);
  assert.equal(f.app.store.key(f.key.id).balance,100);
  assert.equal(f.mock.state.balance,10000); assert.equal(f.mock.state.accounts.get('pst-opus').balance,0);
});

test('Opus 池独立轮询，普通点数请求优先非 Opus 账号', async t => {
  const f=await fixture(t); f.mock.state.tier=1; await member(f);
  const now=Math.floor(Date.now()/1000);
  await addAccount(f,'pst-opus-a',{tier:3,deltaOverride:0,expiresAt:now+86400});
  await addAccount(f,'pst-opus-b',{tier:3,deltaOverride:0,expiresAt:now+86400*30});
  f.mock.state.calls=[];
  for(let i=0;i<6;i++) assert.equal((await f.relay('/ai/generate-image',v45Payload())).status,200);
  assert.deepEqual(generatedCalls(f).map(c=>c.auth),Array.from({length:6},(_,i)=>i%2 ? 'Bearer pst-opus-b' : 'Bearer pst-opus-a'));
  assert.ok(f.app.store.jobs().every(j=>j.route_mode==='opus-pool' && j.charged===0));
  await f.call('/admin/api/keys/'+f.key.id,'POST',{tier:'standard'}); f.mock.state.calls=[];
  for(let i=0;i<4;i++) assert.equal((await f.relay('/ai/generate-image',v45Payload())).status,200);
  assert.deepEqual(generatedCalls(f).map(c=>c.auth),Array(4).fill('Bearer pst-local-test'));
  assert.equal(f.app.store.key(f.key.id).balance,32);
  const memberKey=await (await f.call('/admin/api/keys','POST',{name:'续轮询',points:0,tier:'member'})).json();
  f.mock.state.calls=[];
  for(let i=0;i<2;i++) assert.equal((await f.relay('/ai/generate-image',v45Payload(),{Authorization:'Bearer '+memberKey.token})).status,200);
  assert.deepEqual(generatedCalls(f).map(c=>c.auth),['Bearer pst-opus-a','Bearer pst-opus-b']);
});

test('失效、停用或查询失败的 Opus 不阻止非 Opus 回退，会员报价不变', async t => {
  const f=await fixture(t); f.mock.state.expiresAt=Date.now()/1000-1; f.mock.state.balance=0; await member(f);
  await addAccount(f,'pst-paused-opus',{enabled:false,expiresAt:Date.now()/1000+3600});
  await addAccount(f,'pst-disabled-opus',{enabled:false,expiresAt:Date.now()/1000+3600});
  await addAccount(f,'pst-unreachable-opus',{expiresAt:Date.now()/1000+3600});
  f.mock.state.accounts.get('pst-unreachable-opus').queryFails=true;
  const other=await addAccount(f,'pst-non-opus',{tier:1,balance:10000}); f.mock.state.calls=[];
  assert.equal((await f.relay('/ai/generate-image',v45Payload())).status,200);
  const job=f.app.store.jobs()[0]; assert.equal(job.upstream_id,other); assert.equal(job.route_mode,'anlas-pool');
  assert.equal(job.charged,0); assert.equal(job.upstream_estimate,17);
  assert.equal(generatedCalls(f).length,1);
  assert.ok(!f.mock.state.calls.some(c=>['Bearer pst-paused-opus','Bearer pst-disabled-opus'].includes(c.auth)));
});

test('收费附加项目进入 Anlas 池，可使用非 Opus 并跳过零余额 Opus', async t => {
  const f=await fixture(t), now=Math.floor(Date.now()/1000);
  f.mock.state.tier=1; f.mock.state.cost=22; f.mock.state.expiresAt=now+86400*30; await member(f);
  await f.call('/admin/api/upstreams/1','PUT',{name:'普通账号',enabled:true});
  await addAccount(f,'pst-empty-opus',{tier:3,balance:0,expiresAt:now-86400});
  await addAccount(f,'pst-funded-opus',{tier:3,balance:5,cost:5,expiresAt:now+86400});
  const request=v45Payload(); request.parameters.director_reference_images=['reference'];
  assert.equal((await f.relay('/ai/generate-image',request)).status,200);
  const job=f.app.store.jobs()[0]; assert.equal(job.upstream_id,1); assert.equal(job.route_mode,'anlas-pool');
  assert.equal(job.charged,5); assert.equal(job.upstream_estimate,22);
  assert.equal(f.mock.state.balance,9978); assert.equal(f.mock.state.accounts.get('pst-funded-opus').balance,5);
  assert.equal(f.mock.state.accounts.get('pst-empty-opus').balance,0);
  assert.equal(generatedCalls(f).length,1);
});

test('所有 Opus 余额不足以接批量时回退有余额账号，仍只扣会员价格', async t => {
  const f=await fixture(t); f.mock.state.balance=0; await member(f);
  const fallback=await addAccount(f,'pst-funded-non-opus',{tier:1,balance:1000});
  const request=v45Payload(); request.parameters.n_samples=2;
  assert.equal((await f.relay('/ai/generate-image',request)).status,200);
  const job=f.app.store.jobs()[0]; assert.equal(job.upstream_id,fallback); assert.equal(job.route_mode,'anlas-pool');
  assert.equal(job.charged,17); assert.equal(job.upstream_estimate,34);
  assert.equal(generatedCalls(f).length,1); assert.equal(f.mock.state.balance,0);
});

test('Opus 池优先较短队列，不让空闲非 Opus 抢占会员免费请求', async t => {
  const f=await fixture(t); f.mock.state.tier=1; await member(f);
  await addAccount(f,'pst-opus-a',{tier:3,slow:150,deltaOverride:0});
  await addAccount(f,'pst-opus-b',{tier:3,slow:150,deltaOverride:0});
  const other=await (await f.call('/admin/api/keys','POST',{name:'另一会员',points:0,tier:'member'})).json();
  const first=f.relay('/ai/generate-image',v45Payload()); await waitFor(()=>generatedCalls(f).length===1);
  const second=f.relay('/ai/generate-image',v45Payload(),{Authorization:'Bearer '+other.token});
  await waitFor(()=>generatedCalls(f).length===2);
  assert.deepEqual(generatedCalls(f).map(c=>c.auth),['Bearer pst-opus-a','Bearer pst-opus-b']);
  assert.equal(f.app.router.busy.size,2);
  assert.deepEqual((await Promise.all([first,second])).map(r=>r.status),[200,200]);
});

test('Opus 在排队期间过期会重新选池，不沿用过期的免费资格', async t => {
  const f=await fixture(t); f.mock.state.slow=150; f.mock.state.deltaOverride=0; await member(f);
  await addAccount(f,'pst-non-opus',{tier:1,slow:0});
  const other=await (await f.call('/admin/api/keys','POST',{name:'排队会员',points:0,tier:'member'})).json();
  const first=f.relay('/ai/generate-image',v45Payload()); await waitFor(()=>generatedCalls(f).length===1);
  const second=f.relay('/ai/generate-image',v45Payload(),{Authorization:'Bearer '+other.token});
  await waitFor(()=>f.app.router.upstreamQueue.size(1)===2);
  f.mock.state.expiresAt=Date.now()/1000-1; f.mock.state.balance=0;
  assert.deepEqual((await Promise.all([first,second])).map(r=>r.status),[200,200]);
  assert.deepEqual(generatedCalls(f).map(c=>c.auth),['Bearer pst-local-test','Bearer pst-non-opus']);
  const job=f.app.store.jobs()[0]; assert.equal(job.route_mode,'anlas-pool'); assert.equal(job.charged,0);
  assert.equal(job.upstream_estimate,17);
});

test('Opus 生成已发出后被拒绝不会回退重发，完整释放预留', async t => {
  const f=await fixture(t); f.mock.state.tier=1; await member(f);
  await addAccount(f,'pst-rejecting-opus',{tier:3,fail:true});
  await addAccount(f,'pst-fallback-opus',{tier:3,balance:1000});
  f.mock.state.balance=0;
  const request=v45Payload(); request.parameters.director_reference_images=['reference'];
  assert.equal((await f.relay('/ai/generate-image',request)).status,429);
  assert.deepEqual(generatedCalls(f).map(c=>c.auth),['Bearer pst-rejecting-opus']);
  assert.equal(f.app.store.key(f.key.id).balance,100); assert.equal(f.app.store.key(f.key.id).reserved,0);
});

test('会员流式生图、Director、Vibe 和放大均可使用其他 Opus 账号', async t => {
  const f=await fixture(t); f.mock.state.tier=1; await member(f);
  const opus=await addAccount(f,'pst-tools-opus',{tier:3,deltaOverride:0});
  await f.call('/admin/api/upstreams/1','PUT',{name:'暂停上游账号',enabled:false});
  f.mock.state.calls=[];
  const response=await f.relay('/ai/generate-image-stream',v45Payload());
  assert.equal(response.status,200); assert.match(await response.text(),/event: final/);
  const png=Buffer.from(image,'base64'); png.writeUInt32BE(64,16); png.writeUInt32BE(64,20);
  assert.equal((await f.relay('/ai/augment-image',{image:png.toString('base64'),width:64,height:64,req_type:'lineart'})).status,200);
  assert.equal((await f.relay('/ai/encode-vibe',{model:'nai-diffusion-4-5-full',image})).status,200);
  assert.equal((await f.relay('/ai/upscale',{model:'nai-diffusion-5-curated',image})).status,200);
  const jobs=f.app.store.jobs(); assert.equal(jobs.length,4);
  assert.ok(jobs.every(j=>j.upstream_id===opus && j.status==='completed'));
  assert.deepEqual(jobs.map(j=>j.route_mode),['opus-pool','anlas-pool','opus-pool','opus-pool']);
  assert.deepEqual(jobs.map(j=>j.charged),[0,2,0,0]);
  assert.equal(f.app.store.key(f.key.id).balance,98);
  assert.ok(f.mock.state.calls.every(c=>c.auth==='Bearer pst-tools-opus'));
});

test('会员 NAI5 超规格需要点数时跳过零余额账号，使用 Anlas 池', async t => {
  const f=await fixture(t); f.mock.state.paid=false; f.mock.state.balance=0; await member(f);
  const funded=await addAccount(f,'pst-funded',{tier:1,balance:1000,paid:true,cost:36});
  const request=payload(); request.parameters.steps=35;
  assert.equal((await f.relay('/ai/generate-image',request)).status,200);
  const job=f.app.store.jobs()[0]; assert.equal(job.upstream_id,funded); assert.equal(job.route_mode,'anlas-pool');
  assert.equal(job.charged,36); assert.equal(job.upstream_estimate,36);
  assert.equal(generatedCalls(f).length,1); assert.equal(f.mock.state.balance,0);
});

test('会员 V5 批量扣一张体力和额外点数，只选有真实体力且余额足够的 Opus',async t=>{
 const f=await fixture(t);f.mock.state.paid=false;f.mock.state.balance=0;await member(f);
 const funded=await addAccount(f,'pst-funded',{tier:3,balance:1000,paid:false,deltaOverride:26});
 await addAccount(f,'pst-non-opus',{tier:1,balance:1000,paid:true,cost:52});
 const request=payload();request.parameters.n_samples=2;assert.equal((await f.relay('/ai/generate-image',request)).status,200);
 const job=f.app.store.jobs()[0];assert.equal(job.upstream_id,funded);assert.equal(job.route_mode,'nai5-local-stamina');assert.equal(job.charged,26);assert.equal(job.upstream_estimate,26);assert.equal(job.stamina_charged,100);
 assert.equal(f.app.store.key(f.key.id).balance,74);assert.equal(f.app.store.key(f.key.id).stamina_balance,3900);
 f.mock.state.accounts.get('pst-funded').paid=true;assert.equal((await f.relay('/ai/generate-image',request)).status,503);assert.equal(generatedCalls(f).length,1);
});

test('NAI5 体力池无法免费承接超规格请求时只使用余额足够的 Anlas 账号', async t => {
  const f=await fixture(t); f.mock.state.balance=0; await member(f);
  await addAccount(f,'pst-stamina-only',{paid:false,balance:0});
  const funded=await addAccount(f,'pst-funded',{paid:true,balance:1000,cost:36});
  const request=payload(); request.parameters.steps=35;
  assert.equal((await f.relay('/ai/generate-image',request)).status,200);
  const job=f.app.store.jobs()[0]; assert.equal(job.upstream_id,funded); assert.equal(job.route_mode,'anlas-pool');
  assert.equal(job.charged,36); assert.equal(job.upstream_estimate,36);
  assert.equal(f.mock.state.accounts.get('pst-stamina-only').balance,0);
});

test('NAI5 借用其他体力账号仍需下游余额，不能绕过本地报价', async t => {
  const f=await fixture(t); f.mock.state.balance=0; await member(f); f.app.store.db.prepare('UPDATE keys SET stamina_balance=0 WHERE id=?').run(f.key.id);
  await addAccount(f,'pst-stamina-only',{paid:false,balance:0});
  f.app.store.adjust(f.key.id,-100,'清空下游余额');
  assert.equal((await f.relay('/ai/generate-image',payload())).status,402);
  assert.equal(generatedCalls(f).length,0); assertEntryFailures(f, 1);
});



test('Anlas 池优先非 Opus，占用中改用下一个非 Opus，再按 Opus 到期时间', async t => {
  const f=await fixture(t), now=Math.floor(Date.now()/1000);
  f.mock.state.balance=0; f.mock.state.tier=1; f.mock.state.expiresAt=now-86400; await member(f);
  await f.call('/admin/api/upstreams/1','PUT',{name:'零余额账号',enabled:true});
  await addAccount(f,'pst-funded-tablet',{tier:1,balance:1000,cost:1,expiresAt:now+86400*30});
  await addAccount(f,'pst-funded-points',{tier:0,balance:1000,cost:1,expiresAt:now+86400*40});
  await addAccount(f,'pst-funded-opus',{tier:3,balance:1000,cost:1,expiresAt:now+86400});
  const body={model:'nai-diffusion-5-curated',image:canvasPng(832,1216).toString('base64')};
  const calls=()=>f.mock.state.calls.filter(c=>c.path==='/ai/upscale');
  f.mock.state.calls=[];
  for(let i=0;i<3;i++) assert.equal((await f.relay('/ai/upscale',body)).status,200);
  assert.deepEqual(calls().map(c=>c.auth),Array(3).fill('Bearer pst-funded-tablet'));
  assert.ok(!calls().some(c=>c.auth==='Bearer pst-local-test' || c.auth==='Bearer pst-funded-opus'));
  assert.ok(f.app.store.jobs().every(j=>j.route_mode==='anlas-pool' && j.charged===1));
  f.mock.state.accounts.get('pst-funded-tablet').slow=150;
  const other=await (await f.call('/admin/api/keys','POST',{name:'另一会员',points:10,tier:'member'})).json();
  const first=f.relay('/ai/upscale',body);
  await waitFor(()=>calls().length===4);
  const second=f.relay('/ai/upscale',body,{Authorization:'Bearer '+other.token});
  await waitFor(()=>calls().length===5);
  assert.equal(calls().at(-1).auth,'Bearer pst-funded-points');
  assert.deepEqual((await Promise.all([first,second])).map(r=>r.status),[200,200]);
  assert.equal(f.app.store.key(f.key.id).balance,96);
});

test('七天双柱只统计自动成功结算的本地用量，失败不计入上下游消耗', async t => {
  const f=await fixture(t); f.mock.state.tier=1; await member(f);
  const request=v45Payload(); request.parameters.director_reference_images=['reference'];
  assert.equal((await f.relay('/ai/generate-image',request)).status,200);
  f.mock.state.fail=true;
  assert.equal((await f.relay('/ai/generate-image',request)).status,429);
  f.mock.state.fail=false; f.app.router.reset(1); f.mock.state.incomplete=true;
  await (await f.relay('/ai/generate-image-stream',request)).text();
  const snapshot=await (await f.call('/admin/api/snapshot')).json();
  assert.equal(snapshot.stats.spent,5); assert.equal(snapshot.stats.upstreamSpent,22);
  assert.equal(snapshot.trend.reduce((n,d)=>n+d.spent,0),5);
  assert.equal(snapshot.trend.reduce((n,d)=>n+d.upstreamSpent,0),22);
  const failed=f.app.store.jobs()[0]; assert.equal(failed.status,'failed'); assert.equal(failed.upstream_spent,0);
  for(const completed of [true,false]) {
    const id='free-result-'+completed;
    f.app.store.reserve(f.key.id,id,'/ai/generate-image','nai-diffusion-4-5-full',0,null,1,{upstreamEstimate:17});
    if (completed) f.app.store.settle(id,0,'completed','免费请求完整成功',200);
    else f.app.store.fail(id,'生成失败',502);
  }
  const after=await (await f.call('/admin/api/snapshot')).json();
  assert.equal(after.stats.spent,5); assert.equal(after.stats.upstreamSpent,39);
});

test('HTTP 200 但缺少完整图片结果也按失败处理，返回 502 并自动退款', async t => {
  const f=await fixture(t); f.mock.state.badResult=true;
  const response=await f.relay('/ai/generate-image',payload()); assert.equal(response.status,502);
  assert.match((await response.json()).error,/完整生成结果/);
  const job=f.app.store.jobs()[0]; assert.equal(job.status,'failed'); assert.equal(job.charged,0); assert.equal(job.upstream_spent,0);
  assert.equal(f.app.store.key(f.key.id).balance,100); assert.equal(f.app.store.key(f.key.id).reserved,0);
  assert.equal(generatedCalls(f).length,1);
});

test('上游 5xx、连接中断与超时均自动失败并释放预留，不自动重发', async t => {
  for(const type of ['http500','connection','timeout']) await t.test(type,async t=>{
    const f=await fixture(t,type==='timeout' ? {fetcher:(url,options)=>{
      if(options?.method==='POST') throw new DOMException('测试超时','TimeoutError');
      return fetch(url,options);
    }} : {});
    if(type==='http500'){f.mock.state.fail=true;f.mock.state.failStatus=500;}
    if(type==='connection') f.mock.state.connectionFails=true;
    const response=await f.relay('/ai/generate-image',payload()); assert.equal(response.status,type==='http500'?500:502);
    const job=f.app.store.jobs()[0]; assert.equal(job.status,'failed'); assert.equal(job.charged,0); assert.equal(job.upstream_spent,0);
    assert.equal(f.app.store.key(f.key.id).balance,100); assert.equal(f.app.store.key(f.key.id).reserved,0);
    assert.ok(generatedCalls(f).length<=1);
    const ledger=f.app.store.ledger().length; f.app.store.fail(job.id,'重复错误回调'); assert.equal(f.app.store.ledger().length,ledger);
  });
});

test('批量流只有部分 final 图片时返回失败事件，整笔请求释放预留', async t => {
  const f=await fixture(t); f.mock.state.finalCount=1;
  const request=payload(); request.parameters.n_samples=2;
  const response=await f.relay('/ai/generate-image-stream',request), text=await response.text();
  assert.match(text,/event: final/); assert.match(text,/event: error/);
  const job=f.app.store.jobs()[0]; assert.equal(job.reserved,52); assert.equal(job.status,'failed'); assert.equal(job.charged,0);
  assert.equal(f.app.store.key(f.key.id).balance,100); assert.equal(f.app.store.key(f.key.id).reserved,0);
});

test('前端扩图与细节重绘的 JSON 和表单请求在两种生成接口保留图片、蒙版与新增参数', async t => {
  for (const model of ['nai-diffusion-4-5-full','nai-diffusion-5-full','nai-diffusion-5-curated']) await t.test(model,async t => {
    const f=await fixture(t), bytes=canvasPng(1024,1024), png=bytes.toString('base64');
    for (const streaming of [false,true]) for (const multipart of [false,true]) {
      const path=streaming?'/ai/generate-image-stream':'/ai/generate-image';
      const request={ model:model+'-inpainting',action:'infill',input:'extend the original scene',parameters:{
        width:1024,height:1024,steps:28,n_samples:1,seed:17,stream:'msgpack',
        image:multipart?'image':png,mask:multipart?'mask':png,strength:0.7,noise:0,
        inpaintImg2ImgStrength:0.6,img2img:{strength:0.6,color_correct:true},add_original_image:false,
        ...(model.includes('4-5')?{skip_cfg_above_sigma:58*Math.sqrt(1048576/(832*1216))}:{}) } };
      const response=multipart?await sendForm(f,path,launcherForm(request,{image:bytes,mask:bytes})):await f.relay(path,request);
      assert.equal(response.status,200); await response.arrayBuffer();
      const call=f.mock.state.calls.filter(c=>c.path===path).at(-1);
      assert.deepEqual(call.body,{...request,parameters:{...request.parameters,...(streaming?{stream:'sse'}:{})}});
      if(multipart){assert.deepEqual(call.parts.image,bytes);assert.deepEqual(call.parts.mask,bytes);}
      const expected=reservation(path,request,{tier:1,active:true});
      assert.equal(f.app.store.jobs()[0].charged,expected); assert.equal(f.app.store.jobs()[0].status,'completed');
    }
  });
});

test('V5 两种模型的普通及流式请求结算本地体力，幂等重试不重复扣除',async t=>{
  for(const model of ['nai-diffusion-5-full','nai-diffusion-5-curated']) for(const streaming of [false,true]) await t.test(model+(streaming?' stream':''),async t=>{
    const f=await fixture(t);f.mock.state.paid=false;
    assert.equal((await f.call('/admin/api/keys/'+f.key.id,'POST',{tier:'member',staminaPercent:100})).status,200);
    const body=payload();body.model=model;const path=streaming?'/ai/generate-image-stream':'/ai/generate-image';
    const response=await f.relay(path,body,{'Idempotency-Key':'stamina-once'});assert.equal(response.status,200);await response.text();
    await waitFor(()=>f.app.store.jobs()[0]?.status==='completed');
    const key=f.app.store.key(f.key.id),job=f.app.store.jobs()[0];
    assert.equal(key.stamina_balance,15900);assert.equal(key.stamina_reserved,0);assert.equal(key.balance,100);
    assert.equal(job.stamina_charged,100);assert.equal(job.charged,0);assert.equal(job.upstream_spent,0);assert.equal(job.route_mode,'nai5-local-stamina');
    assert.equal((await(await f.relay('/user/subscription')).json()).usage.percent,14.2);
    assert.equal((await f.relay(path,body,{'Idempotency-Key':'stamina-once'})).status,409);
    assert.equal(f.mock.state.calls.filter(c=>c.path===path).length,1);assert.equal(f.app.store.key(f.key.id).stamina_balance,15900);
  });
});

test('本地体力生成的上游错误及不完整结果释放体力和点数，不自动重发',async t=>{
  for(const [name,options,streaming,expected] of [
    ['400',{fail:true,failStatus:400},false,400],['429',{fail:true,failStatus:429},false,429],
    ['500',{fail:true,failStatus:500},false,500],['缺图',{badResult:true},false,502],['流式缺图',{incomplete:true},true,200],
  ]) await t.test(name,async t=>{
    const f=await fixture(t);await member(f);Object.assign(f.mock.state,{paid:false,...options});
    const response=await f.relay(streaming?'/ai/generate-image-stream':'/ai/generate-image',payload());assert.equal(response.status,expected);
    const text=await response.text();if(streaming)assert.ok(text.includes('event: error'));
    await waitFor(()=>f.app.store.jobs()[0]?.status==='failed');
    const key=f.app.store.key(f.key.id);assert.equal(key.stamina_balance,4000);assert.equal(key.stamina_reserved,0);assert.equal(key.balance,100);assert.equal(key.reserved,0);
    assert.equal(f.app.store.jobs()[0].stamina_charged,0);assert.equal(f.mock.state.calls.filter(c=>c.path===(streaming?'/ai/generate-image-stream':'/ai/generate-image')).length,1);
  });
});

test('最后一张体力并发不双花，后续零点数请求在生成前拒绝',async t=>{
  const f=await fixture(t);await member(f);f.mock.state.paid=false;f.mock.state.slow=60;
  f.app.store.db.prepare('UPDATE keys SET balance=0,stamina_balance=100 WHERE id=?').run(f.key.id);
  assert.equal((await(await f.relay('/user/subscription')).json()).usage.percent,0.1);
  const responses=await Promise.all([f.relay('/ai/generate-image',payload()),f.relay('/ai/generate-image',payload())]);
  assert.deepEqual(responses.map(r=>r.status),[200,402]);assert.equal(generatedCalls(f).length,1);
  const key=f.app.store.key(f.key.id);assert.equal(key.stamina_balance,0);assert.equal(key.stamina_reserved,0);assert.equal(key.balance,0);
});

test('真实体力池跳过停用、冷却、失效及查询失败账号，生成可切换上游',async t=>{
  const f=await fixture(t);await member(f);f.mock.state.paid=true;
  await addAccount(f,'pst-disabled',{paid:false,enabled:false});await addAccount(f,'pst-expired',{paid:false,expiresAt:Date.now()/1000-1});
  const failed=await addAccount(f,'pst-query-failed',{paid:false});f.mock.state.accounts.get('pst-query-failed').queryFails=true;
  const cooling=await addAccount(f,'pst-cooling',{paid:false});f.app.router.failed(cooling,'fixture',60);
  const a=await addAccount(f,'pst-stamina-a',{paid:false,balance:0}),b=await addAccount(f,'pst-stamina-b',{paid:false,balance:0});
  for(let i=0;i<2;i++)assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.deepEqual(generatedCalls(f).map(c=>c.auth),['Bearer pst-stamina-a','Bearer pst-stamina-b']);
  assert.deepEqual(f.app.store.jobs().map(j=>j.upstream_id),[b,a]);assert.equal(f.app.store.key(f.key.id).stamina_balance,3800);
});

test('错误重绘画布和强度在上游查询与扣点前被拒绝', async t => {
  const f=await fixture(t), bytes=canvasPng(1024,1024), png=bytes.toString('base64'); f.mock.state.calls=[];
  const valid={model:'nai-diffusion-4-5-full-inpainting',action:'infill',parameters:{width:1024,height:1024,steps:28,n_samples:1,image:png,mask:png,strength:0.7,inpaintImg2ImgStrength:1}};
  for(const changes of [
    {image:canvasPng(512,768).toString('base64')}, {mask:canvasPng(512,768).toString('base64')},
    {mask:''}, {img2img:{strength:0.5,color_correct:true}}, {skip_cfg_above_sigma:-1},
  ]) assert.equal((await f.relay('/ai/generate-image',{...valid,parameters:{...valid.parameters,...changes}})).status,400);
  assert.equal((await f.relay('/ai/generate-image',{...valid,model:'nai-diffusion-4-5-full'})).status,400);
  for(const field of ['image','mask']) {
    const parts={image:bytes,mask:bytes};parts[field]=canvasPng(512,768);
    assert.equal((await sendForm(f,'/ai/generate-image-stream',launcherForm({...valid,parameters:{...valid.parameters,image:'image',mask:'mask'}},parts))).status,400);
  }
  assert.equal(f.mock.state.calls.length,0); assertEntryFailures(f, 8);
  assert.equal(f.app.store.key(f.key.id).balance,100); assert.equal(f.app.store.key(f.key.id).reserved,0);
});
