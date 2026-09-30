import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamRouter } from '../src/router.mjs';

function fixture(t) {
  const rows=[1,2,3,4].map(id=>({id,enabled:true}));
  const router=new UpstreamRouter({upstreams:()=>rows,upstream:id=>rows.find(row=>row.id===id)});
  const releases=[];
  t.after(()=>{router.close();for(const release of releases)release();});
  return {rows,router,occupy:async id=>{const release=await router.lockUpstream(id);releases.push(release);return release;}};
}

test('账号池优先空闲，即使轮询下一位正在执行也不等待它',async t=>{
  const {rows,router,occupy}=fixture(t);rows.splice(2);
  router.commit(1);
  await occupy(2);
  assert.equal(router.pick().id,1);
  router.commit(1);
  assert.equal(router.pick().id,1);
});

test('全部账号忙时选择最短队列，队列一样长时依次轮询',async t=>{
  const {rows,router,occupy}=fixture(t);rows.splice(3);
  for(const row of rows)await occupy(row.id);
  const controller=new AbortController();
  const waiting=router.lockUpstream(1,controller.signal).catch(error=>error);
  assert.deepEqual(rows.map(row=>router.upstreamQueue.size(row.id)),[2,1,1]);
  const selected=[];
  for(let i=0;i<4;i++){const row=router.pick();selected.push(row.id);router.commit(row.id);}
  assert.deepEqual(selected,[2,3,2,3]);
  controller.abort();await waiting;
});

test('普通、免费和 Anlas 池各自轮询，查询和跳过候选不推进顺序',t=>{
  const {rows,router}=fixture(t);
  const free={scope:'free',ids:new Set([2,3])},anlas={scope:'anlas',ids:new Set([3,4])};
  assert.equal(router.pick().id,1);
  assert.equal(router.pick(new Set([1])).id,2);
  assert.equal(router.pick().id,1);
  assert.equal(router.pick(new Set(),free).id,2);router.commit(2,free);
  assert.equal(router.pick(new Set(),free).id,3);router.commit(3,free);
  assert.equal(router.pick(new Set(),free).id,2);
  assert.equal(router.pick(new Set(),anlas).id,3);router.commit(3,anlas);
  assert.equal(router.pick(new Set(),anlas).id,4);
  assert.equal(router.pick().id,1);router.commit(1);
  assert.equal(router.pick().id,2);
  rows[1].enabled=false;router.failed(3,'测试冷却');
  assert.equal(router.pick().id,4);router.commit(4);
  router.reset(3);rows[1].enabled=true;
  assert.equal(router.pick().id,1);
  anlas.ids.delete(3);
  assert.equal(router.pick(new Set(),anlas).id,4);router.commit(4,anlas);
  anlas.ids.add(3);
  assert.equal(router.pick(new Set(),anlas).id,3);
});
