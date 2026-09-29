import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.mjs';
import { mockUpstream, image } from './mock.mjs';
import { Store } from '../src/db.mjs';
import { reservation } from '../src/billing.mjs';
import { seal } from '../src/security.mjs';

const origin = 'http://127.0.0.1:3100';
const payload = () => ({ model:'nai-diffusion-5-full', action:'generate', input:'test', parameters:{ width:832, height:1216, steps:23, n_samples:1, stream:'msgpack' } });
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sakura-relay-test-')), mock = await mockUpstream();
  const app = createApp({ dataDir:directory, publicOrigin:origin, upstreamOrigin:mock.origin, settlementDelay:0 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie, csrf;
  const call = (path, method = 'GET', body, headers = {}) => fetch(base + path, { method, headers:{ Origin:origin, ...(cookie ? { Cookie:cookie } : {}), ...(csrf ? { 'X-CSRF-Token':csrf } : {}), ...(body !== undefined ? { 'Content-Type':'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  const setup = await call('/admin/api/setup','POST',{ code:readFileSync(join(directory,'setup-code.txt'),'utf8'),password:'test-only-password-123' });
  assert.equal(setup.status,200); cookie = setup.headers.get('set-cookie').split(';')[0]; csrf = (await setup.json()).csrf;
  const upstream = await call('/admin/api/upstreams','POST',{ token:'pst-local-test',enabled:true,name:'Mock',weight:1 });
  assert.equal(upstream.status,201);
  const settings = await call('/admin/api/settings','PUT',{enabled:true,origins:['http://127.0.0.1:3000'] });
  assert.equal(settings.status,200);
  const created = await call('/admin/api/keys','POST',{name:'测试用户',points:100}); const key = await created.json();
  const relay = (path, body, extra = {}) => fetch(base + path,{ method:body === undefined ? 'GET':'POST', headers:{ Authorization:`Bearer ${key.token}`, ...(body === undefined ? {} : {'Content-Type':'application/json'}),...extra }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  t.after(async () => { await app.close(); await mock.close(); rmSync(directory,{recursive:true,force:true}); });
  return { app,mock,base,call,relay,key,directory,cookie,csrf };
}

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
test('订阅查询使用官方 Key；第三方余额独立、NAI5 额度真实转发', async t => {
  const f = await fixture(t); f.mock.state.paid = false;
  const response = await f.relay('/user/subscription'); assert.equal(response.status,200);
  const data = await response.json(); assert.equal(data.trainingStepsLeft.fixedTrainingStepsLeft,100); assert.equal(data.usage.percent,73.6);
  assert.equal(data.usage.isNegative,false); assert.equal(data.email,undefined); assert.equal(data.token,undefined);
  assert.equal(f.mock.state.calls.at(-1).auth,'Bearer pst-local-test');
  const quota = await (await f.call('/admin/api/quota')).json(); assert.equal(quota.upstreams[0].account.relay.balance,10000);
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
test('旧密钥只有正确且启用的客户端认证才会补存，查询额度即可恢复查看', async t => {
  const f = await fixture(t);
  f.app.store.db.prepare('UPDATE keys SET token_encrypted=NULL WHERE id=?').run(f.key.id);
  assert.equal(f.app.store.revealKey(f.key.id).token,null);
  assert.equal((await f.relay('/user/subscription',undefined,{Authorization:`Bearer skr_${'x'.repeat(43)}`})).status,401);
  assert.equal(f.app.store.key(f.key.id).token_encrypted,null);
  await f.call(`/admin/api/keys/${f.key.id}`,'POST',{enabled:false});
  assert.equal((await f.relay('/user/subscription')).status,401);
  assert.equal(f.app.store.key(f.key.id).token_encrypted,null);
  await f.call(`/admin/api/keys/${f.key.id}`,'POST',{enabled:true});
  const before = f.app.store.key(f.key.id);
  assert.equal((await f.relay('/user/subscription')).status,200);
  assert.deepEqual(await (await f.call(`/admin/api/keys/${f.key.id}/reveal`,'POST',{})).json(),f.key);
  const {token_encrypted, ...after} = f.app.store.key(f.key.id);
  const {token_encrypted: ignored, ...expected} = before;
  assert.deepEqual(after,expected); assert.ok(token_encrypted);
});
test('新增密钥重启后仍可查看；旧表迁移保留摘要、余额和历史', () => {
  const dir=mkdtempSync(join(tmpdir(),'sakura-key-migration-'));
  let store;
  try {
    store = new Store(dir); const key=store.createKey('迁移',321);
    const ledger=store.ledger(); store.close(); store=null;
    store=new Store(dir); assert.deepEqual(store.revealKey(key.id),key);
    const {token_encrypted, ...before}=store.key(key.id); store.close(); store=null;
    const legacy=new DatabaseSync(join(dir,'relay.sqlite'));
    legacy.exec('ALTER TABLE keys DROP COLUMN token_encrypted'); legacy.close();
    store=new Store(dir);
    assert.deepEqual({...store.key(key.id)}, {...before,token_encrypted:null});
    assert.deepEqual(store.ledger(),ledger); assert.equal(store.revealKey(key.id).token,null);
    assert.equal(store.authenticate(key.token).id,key.id); assert.deepEqual(store.revealKey(key.id),key);
    store.close(); store=new Store(dir); assert.deepEqual(store.revealKey(key.id),key);
    assert.deepEqual(store.ledger(),ledger);
  } finally { store?.close(); rmSync(dir,{recursive:true,force:true}); }
});
test('旧密钥重新生成需要确认，保留余额、预留、状态和历史，旧凭据立即失效', async t => {
  const f = await fixture(t), path=`/admin/api/keys/${f.key.id}/regenerate`;
  f.app.store.db.prepare('UPDATE keys SET token_encrypted=NULL WHERE id=?').run(f.key.id);
  assert.equal((await f.call(path,'POST',{})).status,400);
  assert.equal((await f.call(path,'POST',{confirm:true},{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await f.call(path,'POST',{confirm:true},{Origin:'https://evil.example'})).status,403);
  f.app.router.activeKeys.add(f.key.id);
  assert.equal((await f.call(path,'POST',{confirm:true})).status,409);
  f.app.router.activeKeys.delete(f.key.id);
  f.app.store.reserve(f.key.id,'legacy-hold','/ai/generate-image','test',26,10000,null);
  assert.equal((await f.call(path,'POST',{confirm:true})).status,409);
  f.app.store.review('legacy-hold','测试保留预留');
  await f.call(`/admin/api/keys/${f.key.id}`,'POST',{enabled:false});
  const {token_hash, prefix, token_encrypted, ...before}=f.app.store.key(f.key.id);
  const ledger=f.app.store.ledger(), jobs=f.app.store.jobs();
  const responses=await Promise.all([f.call(path,'POST',{confirm:true}),f.call(path,'POST',{confirm:true})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  const renewed=await responses.find(r=>r.status===200).json();
  assert.equal(renewed.id,f.key.id); assert.notEqual(renewed.token,f.key.token); assert.match(renewed.token,/^skr_[A-Za-z0-9_-]{43}$/);
  const {token_hash:nextHash,prefix:nextPrefix,token_encrypted:nextEncrypted,...after}=f.app.store.key(f.key.id);
  assert.deepEqual(after,before); assert.notEqual(nextHash,token_hash); assert.notEqual(nextPrefix,prefix); assert.ok(nextEncrypted);
  assert.deepEqual(f.app.store.ledger(),ledger); assert.deepEqual(f.app.store.jobs(),jobs);
  assert.deepEqual(f.app.store.revealKey(f.key.id),renewed);
  f.app.store.settle('legacy-hold',0,'resolved','测试解除上游待核对状态');
  await f.call(`/admin/api/keys/${f.key.id}`,'POST',{enabled:true});
  assert.equal((await f.relay('/user/subscription')).status,401);
  assert.equal((await f.relay('/user/subscription',undefined,{Authorization:`Bearer ${renewed.token}`})).status,200);
  assert.equal((await f.call(path,'POST',{confirm:true})).status,409);
});
test('生成按实际上游扣除 Anlas、持久化流水，并兼容现有请求', async t => {
  const f = await fixture(t);
  const res = await f.relay('/ai/generate-image',payload()); assert.equal(res.status,200); assert.equal((await res.json()).images.length,1);
  const key = f.app.store.key(f.key.id); assert.equal(key.balance,74); assert.equal(key.reserved,0);
  assert.equal(f.app.store.jobs()[0].charged,26); assert.equal(f.app.store.jobs()[0].status,'completed');
  assert.equal(f.app.store.ledger()[0].delta,-26);
});
test('NAI5 免费额度不扣 Anlas，0 余额仍可免费生成', async t => {
  const f = await fixture(t); f.mock.state.paid = false;
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
  assert.equal((await f.relay('/user/data')).status,404);
  assert.equal((await f.relay('/ai/generate',payload())).status,404);
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
test('不完整流保留预留、暂停后续生成，人工结算只执行一次', async t => {
  const f = await fixture(t); f.mock.state.incomplete = true;
  await (await f.relay('/ai/generate-image-stream',payload())).text();
  const job = f.app.store.jobs()[0]; assert.equal(job.status,'review'); assert.equal(f.app.store.key(f.key.id).reserved,26);
  assert.equal((await f.relay('/ai/generate-image',payload())).status,409);
  assert.equal((await f.call(`/admin/api/jobs/${job.id}/resolve`,'POST',{charged:26,note:'已核对账单'})).status,200);
  assert.equal((await f.call(`/admin/api/jobs/${job.id}/resolve`,'POST',{charged:26,note:'重复请求'})).status,409);
  assert.equal(f.app.store.key(f.key.id).balance,74); assert.equal(f.app.store.key(f.key.id).reserved,0);
});
test('并发请求无法双花或混淆上游账单', async t => {
  const f = await fixture(t); f.mock.state.slow = 100;
  const results = await Promise.all([f.relay('/ai/generate-image',payload()),f.relay('/ai/generate-image',payload())]);
  assert.deepEqual(results.map(r => r.status).sort(),[200,429]);
  assert.equal(f.app.store.key(f.key.id).balance,74);
});
test('幂等键不重复生成、账户超额变化转人工核对', async t => {
  const f = await fixture(t);
  assert.equal((await f.relay('/ai/generate-image',payload(),{'Idempotency-Key':'test-request'})).status,200);
  assert.equal((await f.relay('/ai/generate-image',payload(),{'Idempotency-Key':'test-request'})).status,409);
  f.mock.state.deltaOverride = 40;
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.equal(f.app.store.jobs()[0].status,'review'); assert.equal(f.app.store.key(f.key.id).balance,74);
});
test('预计付费却余额未变化时不贸然按免费结算', async t => {
  const f = await fixture(t); f.mock.state.deltaOverride = 0;
  await f.relay('/ai/generate-image',payload()); assert.equal(f.app.store.jobs()[0].status,'review');
});
test('Anlas 调整拒绝小数、负余额以及对预留 Anlas 的扣减', async t => {
  const f = await fixture(t);
  for (const delta of [-101,0.5,1e20]) assert.equal((await f.call(`/admin/api/keys/${f.key.id}/points`,'POST',{delta,note:'测试'})).status,400);
  f.app.store.reserve(f.key.id,'hold','/ai/generate-image','test',26,10000,null);
  assert.equal((await f.call(`/admin/api/keys/${f.key.id}/points`,'POST',{delta:-80,note:'不能动预留'})).status,400);
});
test('重启把未完成请求转为待核对，账本和 Key 保持持久化', () => {
  const dir=mkdtempSync(join(tmpdir(),'sakura-restart-')); const first=new Store(dir);
  const key=first.createKey('持久化',100); first.setUpstream('pst-test'); first.reserve(key.id,'interrupted','/ai/generate-image','v5',26,10000,null); first.close();
  const second=new Store(dir);
  assert.equal(second.jobs()[0].status,'review'); assert.equal(second.authenticate(key.token).reserved,26); assert.equal(second.upstreamToken(),'pst-test');
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
test('上游查询失败不发起生成，失效会话及暂停中转正确拒绝', async t => {
  const f=await fixture(t);f.mock.state.queryFails=true;
  assert.equal((await f.relay('/ai/generate-image',payload())).status,502);
  assert.equal(f.app.store.jobs().length,0);
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

async function addAccount(f, token, { weight = 1, enabled = true, ...account } = {}) {
  f.mock.state.accounts.set(token, { ...f.mock.state, ...account });
  const res = await f.call('/admin/api/upstreams', 'POST', { name: token.slice(4), token, weight, enabled });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}
const generatedCalls = f => f.mock.state.calls.filter(c => c.path === '/ai/generate-image');

test('多上游按 1:2 权重分配；权重 0 和停用上游不参与', async t => {
  const f = await fixture(t);
  const second = await addAccount(f, 'pst-second', { weight: 2 });
  await addAccount(f, 'pst-zero', { weight: 0 });
  await addAccount(f, 'pst-disabled', { enabled: false });
  f.app.store.adjust(f.key.id, 1000, '测试');
  for (let i = 0; i < 6; i++) assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  const calls = generatedCalls(f);
  assert.equal(calls.filter(c => c.auth === 'Bearer pst-local-test').length,2);
  assert.equal(calls.filter(c => c.auth === 'Bearer pst-second').length,4);
  assert.ok(f.app.store.jobs().some(j => j.upstream_id === second));
  assert.equal(f.app.store.key(f.key.id).balance,1100 - 26 * 6);
});

test('全部额度查询逐账户隔离失败，查询不推进路由；额度和生成固定同一上游', async t => {
  const f = await fixture(t);
  const id = await addAccount(f, 'pst-second', { weight: 2, balance: 6400, paid: false });
  await addAccount(f, 'pst-offline', { weight: 0 });
  f.mock.state.accounts.get('pst-offline').queryFails = true;
  for (let i = 0; i < 3; i++) {
    const q = await (await f.call('/admin/api/quota')).json();
    assert.equal(q.totalAnlas,16400); assert.equal(q.failed,1);
    assert.equal(q.upstreams.find(u => u.id === id).account.usage.percent,73.6);
  }
  for (let i = 0; i < 3; i++) {
    const q = await (await f.relay('/user/subscription')).json();
    assert.equal(q.relay.route.upstreamId,id); assert.equal(q.usage.percent,73.6);
  }
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.equal(generatedCalls(f)[0].auth,'Bearer pst-second');
  assert.equal(f.app.store.jobs()[0].upstream_id,id);
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.equal(generatedCalls(f)[1].auth,'Bearer pst-local-test');
});

test('不同上游可并行，同一访问 Key 不能借另一个上游重复花费', async t => {
  const f = await fixture(t);
  f.mock.state.slow = 140;
  await addAccount(f,'pst-second');
  const secondKey = await (await f.call('/admin/api/keys','POST',{name:'另一个用户',points:100})).json();
  const first = f.relay('/ai/generate-image',payload());
  while (!f.app.isBusy()) await new Promise(r => setTimeout(r,2));
  const sameKey = await f.relay('/ai/generate-image',payload());
  assert.equal(sameKey.status,429);
  const second = f.relay('/ai/generate-image',payload(),{Authorization:'Bearer '+secondKey.token});
  assert.deepEqual((await Promise.all([first,second])).map(r=>r.status),[200,200]);
  assert.equal(new Set(generatedCalls(f).map(c => c.auth)).size,2);
  assert.equal(f.app.store.key(f.key.id).balance,74);
  assert.equal(f.app.store.key(secondKey.id).balance,74);
});

test('某上游待核对只暂停该上游；执行中的任务不能更换或移除 Key', async t => {
  const f = await fixture(t);
  await addAccount(f,'pst-second');
  f.mock.state.incomplete=true;
  await (await f.relay('/ai/generate-image-stream',payload())).text();
  assert.equal(f.app.store.jobs()[0].status,'review');
  assert.equal((await f.call('/admin/api/upstreams/1','DELETE')).status,409);
  assert.equal((await f.call('/admin/api/upstreams/1','PUT',{name:'更换',token:'pst-new',weight:1,enabled:true})).status,409);
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.equal(generatedCalls(f)[0].auth,'Bearer pst-second');
});

test('添加和编辑无需专用账户确认；禁止重复 Key，移除后可重新添加', async t => {
  const f = await fixture(t);
  const body = {name:'另一个上游',token:'pst-second',weight:5,enabled:true};
  const saved = await (await f.call('/admin/api/upstreams','POST',body)).json();
  assert.equal((await f.call('/admin/api/upstreams','POST',body)).status,409);
  assert.equal((await f.call('/admin/api/upstreams/'+saved.id,'PUT',{name:'新名称',weight:0,enabled:false})).status,200);
  assert.equal(f.app.store.upstream(saved.id).weight,0);
  assert.equal((await f.call('/admin/api/upstreams/'+saved.id,'DELETE')).status,200);
  assert.equal((await f.call('/admin/api/upstreams','POST',body)).status,201);
  assert.equal(f.app.store.upstreams().find(u=>u.id===saved.id).name,body.name);
  for (const weight of [-1,0.5,1001]) assert.equal((await f.call('/admin/api/upstreams/'+saved.id,'PUT',{...body,token:'',weight})).status,400);
  const snapshot = await (await f.call('/admin/api/snapshot')).text();
  assert.ok(!snapshot.includes('pst-second'));
});

test('429 不把账户的其他余额变化记给本次请求，立即释放预留', async t => {
  const f = await fixture(t);
  f.mock.state.fail=true; f.mock.state.failBalanceDelta=50; f.mock.state.calls=[];
  assert.equal((await f.relay('/ai/generate-image',payload())).status,429);
  assert.equal(f.app.store.key(f.key.id).balance,100);
  assert.equal(f.app.store.key(f.key.id).reserved,0);
  assert.equal(f.app.store.jobs()[0].status,'rejected');
  assert.equal(f.mock.state.calls.filter(c=>c.path==='/user/subscription').length,1);
});

test('完成响应后立刻查余额，确认扣费后不再延迟或重复查询', async t => {
  const f=await fixture(t); f.mock.state.calls=[];
  assert.equal((await f.relay('/ai/generate-image',payload())).status,200);
  assert.deepEqual(f.mock.state.calls.map(c=>c.path),['/user/subscription','/ai/generate-image','/user/subscription']);
});

test('从旧单上游自动迁移，管理员、Key、Anlas 和历史流水保留', t => {
  const dir=mkdtempSync(join(tmpdir(),'sakura-migration-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const first=new Store(dir), key=first.createKey('老用户',500);
  first.setUpstream('pst-old');
  first.reserve(key.id,'old-job','/ai/generate-image','v5',26,10000,null);
  first.settle('old-job',26,'completed','旧记录',9974,200);
  first.set('admin_password','preserved-hash');
  first.set('upstream_token',seal('pst-old',first.master)); first.set('upstream_name','原官方账户');
  first.db.exec("UPDATE jobs SET upstream_id=NULL,upstream_name=NULL; DELETE FROM upstreams; DELETE FROM settings WHERE name='upstream_pool_migrated'");
  first.close();
  const next=new Store(dir);
  assert.equal(next.upstreams().length,1); assert.equal(next.upstreamToken(),'pst-old');
  assert.equal(next.get('admin_password'),'preserved-hash'); assert.equal(next.authenticate(key.token).balance,474);
  assert.equal(next.jobs()[0].upstream_name,'原官方账户'); assert.equal(next.ledger().length,2);
  assert.equal(next.get('upstream_token'),null);
  next.close();
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
  assert.equal(f.app.store.jobs().length,0);
});

test('足额时先原子预留 240，实扣 220 后释放 20，不能花掉处理中余额', async t => {
  const f=await fixture(t);
  f.app.store.adjust(f.key.id,140,'补充余额');
  f.mock.state.slow=150; f.mock.state.cost=220;
  const request=payload(); Object.assign(request.parameters,{width:1024,height:1536,steps:38,n_samples:4});
  const pending=f.relay('/ai/generate-image',request);
  while (!generatedCalls(f).length) await new Promise(r=>setTimeout(r,2));
  assert.equal(f.app.store.key(f.key.id).reserved,240);
  assert.equal((await f.relay('/ai/generate-image',request)).status,429);
  assert.equal((await f.call('/admin/api/keys/'+f.key.id+'/points','POST',{delta:-1,note:'不能动预留'})).status,400);
  assert.equal((await pending).status,200);
  assert.equal(f.app.store.key(f.key.id).balance,20);
  assert.equal(f.app.store.key(f.key.id).reserved,0);
  assert.equal(f.app.store.jobs()[0].charged,220);
});

test('上游免费额度耗尽时重新按付费计算；不相信客户端旧额度', async t => {
  const f=await fixture(t);
  f.mock.state.paid=false;
  const account=await (await f.relay('/user/subscription')).json();
  assert.equal(account.usage.isNegative,false);
  f.app.store.adjust(f.key.id,-99,'只留 1 Anlas');
  f.mock.state.paid=true;
  assert.equal((await f.relay('/ai/generate-image',payload())).status,402);
  assert.equal(generatedCalls(f).length,0);
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
