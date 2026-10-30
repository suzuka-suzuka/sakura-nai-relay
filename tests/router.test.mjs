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

test('所有池空闲账户按优先级选择，并跳过不合格账户', async t => {
  const { rows, router, occupy } = fixture(t);
  rows[0].priority = 10; rows[1].priority = 20;
  for (const scope of [null, 'pool', 'anlas', 'free', 'stamina']) {
    const pool = scope === null ? null : { scope, ids: new Set([1,2,3]),
      ...(['pool', 'anlas'].includes(scope) ? { order: 'expiry', nonOpus: new Set([1]), expires: new Map([[2,900],[3,100]]) } : {}) };
    assert.equal(router.pick(new Set(), pool).id, 2);
    assert.equal(router.pick(new Set([2]), pool).id, 1);
    router.failed(2, '冷却');
    assert.equal(router.pick(new Set(), pool).id, 1);
    router.reset(2); rows[1].enabled = false;
    assert.equal(router.pick(new Set(), pool).id, 1);
    rows[1].enabled = true;
    if (pool) { pool.ids.delete(2); assert.equal(router.pick(new Set(), pool).id, 1); }
  }
  await occupy(2);
  assert.equal(router.pick().id, 1);
});

test('所有池高优先级忙时用较低优先级空闲账户，全忙才按最短队列和优先级排队', async t => {
  const { rows, router, occupy } = fixture(t);
  rows.splice(3);
  rows[0].priority = 100; rows[1].priority = 50; rows[2].priority = 0;
  const pools = [null, ...['pool', 'anlas', 'free', 'stamina'].map(scope => ({ scope, ids: new Set([1,2,3]) }))];
  const expect = id => { for (const pool of pools) assert.equal(router.pick(new Set(), pool).id, id); };
  expect(1);
  const releaseHigh = await occupy(1);
  expect(2);
  await occupy(2);
  expect(3);
  await occupy(3);
  expect(1);
  const controller = new AbortController();
  const waiting = router.lockUpstream(1, controller.signal).catch(error => error);
  assert.deepEqual(rows.map(row => router.upstreamQueue.size(row.id)), [2,1,1]);
  expect(2);
  controller.abort(); await waiting;
  releaseHigh();
  expect(1);
});

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

test('未指定点数顺序时各池按账号 ID 轮询，查询和跳过候选不推进顺序',t=>{
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

test('点数请求先用非 Opus 账号，Opus 再按到期时间，占用中改用下一个',async t=>{
  const {router,occupy}=fixture(t);
  const pool={scope:'anlas',ids:new Set([1,2,3,4]),order:'expiry',expires:new Map([[1,100],[2,900],[3,200],[4,50]]),nonOpus:new Set([2,3])};
  assert.equal(router.pick(new Set(),pool).id,2);
  router.commit(2,pool);
  assert.equal(router.pick(new Set(),pool).id,2);
  await occupy(2);
  assert.equal(router.pick(new Set(),pool).id,3);
  await occupy(3);
  assert.equal(router.pick(new Set(),pool).id,4);
  await occupy(4);
  assert.equal(router.pick(new Set(),pool).id,1);
});
