import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.mjs';
import { capacityFor, dailyFor, refillPeriod, DAY_MS, staminaPercent } from '../src/stamina.mjs';
import { downstreamSubscription, quoteRequest } from '../src/billing.mjs';

const request = () => ({ model:'nai-diffusion-5-full',action:'generate',parameters:{width:832,height:1216,steps:23,n_samples:1} });
function directory(t) {
  const dir=mkdtempSync(join(tmpdir(),'sakura-stamina-test-'));
  t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir())));rmSync(dir,{recursive:true,force:true});});
  return dir;
}
test('创建起满 24 小时的毫秒边界与各档容量，百分比只保留一位小数',()=>{
  const created=Date.parse('2026-10-12T15:30:17.250+08:00');
  assert.equal(refillPeriod(created,created+DAY_MS-1),0);
  assert.equal(refillPeriod(created,created+DAY_MS),1);
  assert.equal(refillPeriod(created,Date.parse('2026-10-13T04:00:00+08:00')),0);
  assert.equal(refillPeriod(created,created+2*DAY_MS),2);
  assert.equal(refillPeriod(created,created-1),0);
  for(const [p,cap,day] of [[25,28000,4000],[50,56000,8000],[75,84000,12000],[100,112000,16000]]) {
    assert.equal(capacityFor(p),cap);assert.equal(dailyFor(cap),day);
    assert.equal(staminaPercent(cap),p);
  }
  assert.equal(staminaPercent(16000),14.3);assert.equal(staminaPercent(4000),3.6);
  assert.equal(staminaPercent(100),0.1);
});

test('初始一天、每满 24 小时恢复、停机补算、满额丢弃与时钟回退不重复恢复',t=>{
  let store;t.after(()=>store?.close());store=new Store(directory(t));
  const key=store.createKey('体力',100,{tier:'member',staminaPercent:100}),created=store.key(key.id).created_at;
  assert.equal(store.key(key.id).stamina_balance,16000);
  const refill=period=>store.refillStamina(store.key(key.id),created+period*DAY_MS);
  assert.equal(store.refillStamina(store.key(key.id),created+DAY_MS-1).stamina_balance,16000);
  assert.equal(refill(0).stamina_balance,16000);assert.equal(refill(1).stamina_balance,32000);
  assert.equal(refill(1).stamina_balance,32000);assert.equal(refill(20).stamina_balance,112000);
  assert.equal(refill(25).stamina_balance,112000);
  store.db.prepare('UPDATE keys SET stamina_balance=100000 WHERE id=?').run(key.id);
  assert.equal(refill(25).stamina_balance,100000);assert.equal(refill(24).stamina_balance,100000);
  assert.equal(refill(26).stamina_balance,112000);
});

test('不同 Key 按自己的创建时间恢复，延迟查询和编辑不移动周期',t=>{
  let store;t.after(()=>store?.close());store=new Store(directory(t));
  const a=store.createKey('A',100,{tier:'member',staminaPercent:100}),b=store.createKey('B',100,{tier:'member',staminaPercent:25});
  const created=store.key(a.id).created_at;
  store.db.prepare('UPDATE keys SET created_at=? WHERE id=?').run(created+3*3600000,b.id);
  assert.equal(store.refillStamina(store.key(a.id),created+DAY_MS+3600000).stamina_balance,32000);
  assert.equal(store.refillStamina(store.key(b.id),created+DAY_MS+3600000).stamina_balance,4000);
  assert.equal(store.refillStamina(store.key(b.id),created+DAY_MS+3*3600000).stamina_balance,8000);
  store.updateKey(a.id,{name:'改名',validDays:30});
  assert.equal(store.key(a.id).created_at,created);assert.equal(store.key(a.id).stamina_refill_period,1);
  assert.equal(store.refillStamina(store.key(a.id),created+2*DAY_MS-1).stamina_balance,32000);
  assert.equal(store.refillStamina(store.key(a.id),created+2*DAY_MS).stamina_balance,48000);
});

test('预留体力不可双花，失败释放，重启不重新发放，编辑和续期不补满',t=>{
  const dir=directory(t);let store=new Store(dir);
  try {
    store.setUpstream('pst-fixture');const key=store.createKey('体力',100,{tier:'member',staminaPercent:25});
    store.db.prepare('UPDATE keys SET stamina_balance=100 WHERE id=?').run(key.id);
    store.reserve(key.id,'one','/ai/generate-image','nai-diffusion-5-full',0,'one',1,{stamina:100});
    assert.equal(downstreamSubscription(store.key(key.id)).usage.isNegative,true);
    assert.throws(()=>store.reserve(key.id,'two','/ai/generate-image','nai-diffusion-5-full',0,'two',1,{stamina:100}),/体力不足/);
    assert.throws(()=>store.updateKey(key.id,{staminaPercent:100}),/请求结束/);
    store.fail('one','failed');assert.equal(store.key(key.id).stamina_balance,100);assert.equal(store.key(key.id).stamina_reserved,0);
    store.reserve(key.id,'pending','/ai/generate-image','nai-diffusion-5-full',0,'pending',1,{stamina:100});
    store.close();store=new Store(dir);assert.equal(store.key(key.id).stamina_reserved,0);assert.equal(store.key(key.id).stamina_balance,100);
    store.updateKey(key.id,{name:'改名',validDays:30,staminaPercent:100});assert.equal(store.key(key.id).stamina_balance,100);
    store.reserve(key.id,'success','/ai/generate-image','nai-diffusion-5-full',0,'success',1,{stamina:100});
    store.settle('success',0,'completed','complete',200);assert.equal(store.key(key.id).stamina_balance,0);
    assert.equal(store.jobs()[0].stamina_charged,100);assert.equal(store.key(key.id).balance,100);
  } finally {store?.close();}
});

test('报价区分 V5 体力、额外批量点数和其他免费模型，小于一张不可抵扣',()=>{
  const key={tier:'member',balance:100,reserved:0,stamina_capacity:28000,stamina_balance:4000,stamina_reserved:0,expires_at:null};
  const body=request();assert.deepEqual(quoteRequest('/ai/generate-image',body,key),{amount:0,stamina:100});
  body.parameters.n_samples=2;assert.deepEqual(quoteRequest('/ai/generate-image',body,key),{amount:26,stamina:100});
  body.parameters.n_samples=1;body.model='nai-diffusion-4-5-full';assert.deepEqual(quoteRequest('/ai/generate-image',body,key),{amount:0,stamina:0});
  body.model='nai-diffusion-5-full';body.parameters.steps=29;assert.equal(quoteRequest('/ai/generate-image',body,key).stamina,0);
  body.parameters.steps=23;key.stamina_balance=99;assert.deepEqual(quoteRequest('/ai/generate-image',body,key),{amount:26,stamina:0});
});
