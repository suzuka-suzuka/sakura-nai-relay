import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Store } from '../src/db.mjs';
import { DAY_MS } from '../src/stamina.mjs';
import { FULL_STAMINA_GRANT, grantFullStaminaOnce } from '../src/grant-full-stamina-once.mjs';

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'sakura-full-grant-'));
  let store=new Store(directory);
  t.after(()=>{
    store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'sakura-full-grant-'));
    rmSync(directory,{recursive:true,force:true});
  });
  return {get store(){return store;},reopen(){store.close();store=null;store=new Store(directory);}};
}
const pending = store => store.db.prepare('DELETE FROM settings WHERE name=?').run(FULL_STAMINA_GRANT);

test('启动一次性补满所有未删除会员，保留点数、凭据、档位、有效期和历史',t=>{
  const f=fixture(t),store=f.store;
  const keys=[
    store.createKey('25%',100,{tier:'member'}),
    store.createKey('100%',6000,{tier:'member',staminaPercent:100}),
    store.createKey('停用',20,{tier:'member',staminaPercent:37}),
    store.createKey('到期',30,{tier:'member',expiresAt:Date.now()-1000}),
    store.createKey('普通',8000),
    store.createKey('已删除',50,{tier:'member'}),
  ];
  store.updateKey(keys[2].id,{enabled:false});store.retireKey(keys[5].id);
  store.db.exec('UPDATE keys SET stamina_balance=0');
  const before=store.db.prepare('SELECT * FROM keys ORDER BY id').all(),ledger=store.ledger();
  pending(store);f.reopen();
  const after=f.store.db.prepare('SELECT * FROM keys ORDER BY id').all();
  for(let i=0;i<after.length;i++){
    assert.deepEqual({...after[i]},{...before[i],stamina_balance:i<4?before[i].stamina_capacity:0});
  }
  assert.deepEqual(f.store.revealKey(keys[0].id),keys[0]);
  assert.equal(f.store.key(keys[5].id),undefined);
  assert.deepEqual(f.store.ledger(),ledger);assert.deepEqual(f.store.jobs(),[]);
  assert.ok(f.store.get(FULL_STAMINA_GRANT));
  f.store.db.prepare('UPDATE keys SET stamina_balance=100 WHERE id=?').run(keys[0].id);
  const marker=f.store.get(FULL_STAMINA_GRANT);
  f.reopen();assert.equal(f.store.key(keys[0].id).stamina_balance,100);
  assert.equal(f.store.get(FULL_STAMINA_GRANT),marker);
});

test('补满消化已过的恢复周期，保留创建时刻与下次 24 小时边界，时钟回退不倒退周期',t=>{
  const {store}=fixture(t),now=Date.now(),created=now-10*DAY_MS-6*3600000;
  const key=store.createKey('旧会员',0,{tier:'member'});
  store.db.prepare('UPDATE keys SET created_at=?,stamina_balance=100,stamina_refill_period=2 WHERE id=?').run(created,key.id);
  pending(store);assert.equal(grantFullStaminaOnce(store.db,now),1);
  assert.equal(store.key(key.id).stamina_balance,28000);
  assert.equal(store.key(key.id).created_at,created);assert.equal(store.key(key.id).stamina_refill_period,10);
  store.db.prepare('UPDATE keys SET stamina_balance=100 WHERE id=?').run(key.id);
  assert.equal(store.refillStamina(store.key(key.id),created+11*DAY_MS-1).stamina_balance,100);
  assert.equal(store.refillStamina(store.key(key.id),created+11*DAY_MS).stamina_balance,4100);
  pending(store);grantFullStaminaOnce(store.db,now);
  assert.equal(store.key(key.id).stamina_refill_period,11);
});

test('启动先释放中断任务预留，再补满体力；失败任务不新增零点流水',t=>{
  const f=fixture(t),store=f.store,upstream=store.setUpstream('pst-grant-test');
  const key=store.createKey('进行中会员',100,{tier:'member'});
  store.db.prepare('UPDATE keys SET stamina_balance=100 WHERE id=?').run(key.id);
  store.reserve(key.id,'interrupted','/ai/generate-image','nai-diffusion-5-full',26,null,upstream,{stamina:100});
  pending(store);f.reopen();
  const row=f.store.key(key.id),job=f.store.jobs()[0];
  assert.equal(row.balance,100);assert.equal(row.reserved,0);assert.equal(row.stamina_reserved,0);
  assert.equal(row.stamina_balance,28000);assert.equal(job.status,'failed');
  assert.equal(job.charged,0);assert.equal(job.stamina_charged,0);
  assert.equal(f.store.ledger().length,1);
});

test('补满与完成标记一起回滚，失败后可以重试；新库也只执行一次',t=>{
  const f=fixture(t),store=f.store;
  assert.ok(store.get(FULL_STAMINA_GRANT));
  const key=store.createKey('回滚验证',0,{tier:'member'});
  store.db.prepare('UPDATE keys SET stamina_balance=100 WHERE id=?').run(key.id);
  f.reopen();assert.equal(f.store.key(key.id).stamina_balance,100);
  pending(f.store);
  f.store.db.exec(`CREATE TRIGGER reject_full_grant BEFORE INSERT ON settings
    WHEN NEW.name='${FULL_STAMINA_GRANT}' BEGIN SELECT RAISE(ABORT,'grant fixture failure'); END`);
  assert.throws(()=>grantFullStaminaOnce(f.store.db),/grant fixture failure/);
  assert.equal(f.store.key(key.id).stamina_balance,100);assert.equal(f.store.get(FULL_STAMINA_GRANT),null);
  f.store.db.exec('DROP TRIGGER reject_full_grant');f.reopen();
  assert.equal(f.store.key(key.id).stamina_balance,28000);assert.ok(f.store.get(FULL_STAMINA_GRANT));
});
