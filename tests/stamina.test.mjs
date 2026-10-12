import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.mjs';
import { seal, hash } from '../src/security.mjs';
import { migrateLocalStamina } from '../src/migrate-local-stamina.mjs';
import { capacityFor, dailyFor, refillPeriod, DAY_MS, staminaPercent } from '../src/stamina.mjs';
import { downstreamSubscription, quoteRequest } from '../src/billing.mjs';

const request = () => ({ model:'nai-diffusion-5-full',action:'generate',parameters:{width:832,height:1216,steps:23,n_samples:1} });
function directory(t) {
  const dir=mkdtempSync(join(tmpdir(),'sakura-stamina-test-'));
  t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir())));rmSync(dir,{recursive:true,force:true});});
  return dir;
}
function legacyDatabase(dir) {
  const master=Buffer.alloc(32,7);writeFileSync(join(dir,'master.key'),master);
  const db=new DatabaseSync(join(dir,'relay.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE settings(name TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO settings VALUES('admin_password','preserved-hash');
    CREATE TABLE upstreams(id INTEGER PRIMARY KEY,name TEXT NOT NULL,token TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,suffix TEXT NOT NULL,enabled INTEGER NOT NULL,created_at INTEGER NOT NULL,retired_at INTEGER,exclusive INTEGER NOT NULL DEFAULT 0 CHECK(exclusive IN(0,1)));
    CREATE TABLE keys(id INTEGER PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,prefix TEXT NOT NULL,balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0),reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0),token_encrypted TEXT NOT NULL,tier TEXT NOT NULL CHECK(tier IN('standard','member')),nai5_upstream_id INTEGER REFERENCES upstreams(id),expires_at INTEGER,enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,last_used_at INTEGER,retired_at INTEGER,CHECK((tier='member' AND nai5_upstream_id IS NOT NULL) OR (tier='standard' AND nai5_upstream_id IS NULL)));
    CREATE INDEX keys_binding ON keys(nai5_upstream_id);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,key_id INTEGER NOT NULL REFERENCES keys(id),endpoint TEXT NOT NULL,model TEXT,status TEXT NOT NULL,reserved INTEGER NOT NULL,charged INTEGER,http_status INTEGER,note TEXT,created_at INTEGER NOT NULL,finished_at INTEGER,upstream_id INTEGER NOT NULL REFERENCES upstreams(id),upstream_name TEXT NOT NULL,tier_snapshot TEXT NOT NULL,route_mode TEXT NOT NULL,upstream_estimate INTEGER NOT NULL,upstream_spent INTEGER NOT NULL DEFAULT 0,idempotency TEXT,UNIQUE(key_id,idempotency));
    CREATE TABLE ledger(id INTEGER PRIMARY KEY,key_id INTEGER NOT NULL REFERENCES keys(id),delta INTEGER NOT NULL,kind TEXT NOT NULL,note TEXT,job_id TEXT REFERENCES jobs(id),created_at INTEGER NOT NULL);`);
  db.prepare('INSERT INTO upstreams VALUES(1,?,?,?,?,1,1,NULL,1)').run('原上游',seal('pst-fixture',master),hash('pst-fixture'),'ture');
  const insert=db.prepare('INSERT INTO keys VALUES(?,?,?,?,?,0,?,?,?,?,1,1,NULL,?)');
  for(const [id,balance,tier,enabled,retired] of [[1,5001,'member',1,null],[2,5000,'member',1,null],[3,4999,'member',0,null],[4,9000,'standard',1,null],[5,9000,'member',0,123]]) {
    const token='skr_'+String(id).repeat(43);
    insert.run(id,'旧用户'+id,hash(token),'prefix'+id,balance,retired?'':seal(token,master),tier,tier==='member'?1:null,id===3?1:null,retired);
    db.prepare('UPDATE keys SET enabled=? WHERE id=?').run(enabled,id);
  }
  db.exec(`INSERT INTO jobs VALUES('old-success',1,'/ai/generate-image','nai-diffusion-5-full','completed',26,26,200,'旧记录',1,2,1,'原上游','member','nai5-bound',26,26,'once');
    INSERT INTO ledger VALUES(1,1,-26,'usage','旧记录','old-success',2);
    INSERT INTO jobs VALUES('old-running',2,'/ai/generate-image','nai-diffusion-5-full','running',17,NULL,NULL,NULL,1,NULL,1,'原上游','member','nai5-bound',17,0,'pending');
    UPDATE keys SET reserved=17 WHERE id=2;`);
  return db;
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

test('一次性迁移以余额 >5000 分档，只发一天并保留凭据、余额、状态与历史',t=>{
  const dir=directory(t);let db=legacyDatabase(dir),store;
  const old=db.prepare('SELECT * FROM keys ORDER BY id').all(),job=db.prepare("SELECT * FROM jobs WHERE id='old-success'").get();
  db.close();store=new Store(dir);
  try {
    assert.equal(store.key(1).stamina_capacity,112000);assert.equal(store.key(1).stamina_balance,16000);
    assert.ok(store.key(1).stamina_refill_period>1000);
    assert.equal(store.usableKey(1).stamina_balance,16000); // Decades of old creation cycles are already handled.
    for(const id of [2,3]) {assert.equal(store.key(id).stamina_capacity,28000);assert.equal(store.key(id).stamina_balance,4000);}
    assert.equal(store.key(4).stamina_capacity,0);
    assert.equal(store.db.prepare('SELECT stamina_capacity FROM keys WHERE id=5').get().stamina_capacity,0);
    for(const row of old) for(const field of ['id','name','token_hash','prefix','balance','token_encrypted','tier','expires_at','enabled','created_at','last_used_at','retired_at'])
      assert.equal(store.db.prepare('SELECT * FROM keys WHERE id=?').get(row.id)[field],row[field],field);
    assert.equal(store.revealKey(1).token,'skr_'+'1'.repeat(43));assert.equal(store.upstreamToken(1),'pst-fixture');
    assert.equal(store.get('admin_password'),'preserved-hash');assert.equal(store.key(2).reserved,0);
    const migratedJob=store.db.prepare("SELECT * FROM jobs WHERE id='old-success'").get();
    for(const field of Object.keys(job)) assert.equal(migratedJob[field],job[field],field);
    assert.equal(migratedJob.stamina_charged,null);assert.equal(store.jobs().find(j=>j.id==='old-running').status,'failed');
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
    assert.ok(!store.db.prepare('PRAGMA table_info(keys)').all().some(c=>c.name==='nai5_upstream_id'));
    assert.ok(!store.db.prepare('PRAGMA table_info(upstreams)').all().some(c=>c.name==='exclusive'));
    const backups=readdirSync(join(dir,'backups'));assert.equal(backups.length,1);
    const backup=new DatabaseSync(join(dir,'backups',backups[0],'relay.sqlite'),{readOnly:true});
    assert.equal(backup.prepare('SELECT balance FROM keys WHERE id=1').get().balance,5001);backup.close();
    assert.deepEqual(readFileSync(join(dir,'backups',backups[0],'master.key')),readFileSync(join(dir,'master.key')));
    const marker=store.get('local_stamina_v1'),scheduleMarker=store.get('local_stamina_created_v2');store.adjust(2,1000,'超过旧分档阈值');
    store.db.prepare('UPDATE keys SET stamina_balance=100 WHERE id=1').run();
    store.close();store=new Store(dir);
    assert.equal(store.get('local_stamina_v1'),marker);assert.equal(store.key(1).stamina_balance,100);
    assert.equal(store.get('local_stamina_created_v2'),scheduleMarker);
    assert.equal(store.key(2).stamina_capacity,28000);assert.equal(store.key(2).balance,6000);
    assert.equal(readdirSync(join(dir,'backups')).length,1);
  } finally {store?.close();}
});

test('迁移失败整体回滚、恢复外键检查，下一次启动可重试',t=>{
  const dir=directory(t),db=legacyDatabase(dir);
  try {
    db.exec("CREATE TRIGGER reject_migration BEFORE INSERT ON settings WHEN NEW.name='local_stamina_v1' BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END");
    assert.throws(()=>migrateLocalStamina(db,dir),/fixture migration failure/);
    assert.ok(db.prepare('PRAGMA table_info(keys)').all().some(c=>c.name==='nai5_upstream_id'));
    assert.ok(db.prepare('PRAGMA table_info(upstreams)').all().some(c=>c.name==='exclusive'));
    assert.equal(db.prepare("SELECT value FROM settings WHERE name='local_stamina_v1'").get(),undefined);
    assert.equal(db.prepare("SELECT value FROM settings WHERE name='local_stamina_created_v2'").get(),undefined);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM keys').get().n,5);
    db.exec('DROP TRIGGER reject_migration');migrateLocalStamina(db,dir);
    assert.equal(db.prepare('SELECT stamina_balance FROM keys WHERE id=1').get().stamina_balance,16000);
  } finally {db.close();}
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

test('已迁移的 04:00 数据升级只转换周期，保留档位和体力，旧 Key 不追补历史',t=>{
  const dir=directory(t);let store=new Store(dir);
  try {
    store.setUpstream('pst-fixture');const a=store.createKey('100%',10000,{tier:'member',staminaPercent:100}),b=store.createKey('25%',100,{tier:'member',staminaPercent:25});
    store.adjust(a.id,-9500,'低于分档阈值');store.adjust(b.id,6000,'高于分档阈值');
    const now=Date.now(),created=now-90*DAY_MS-6*3600000;
    store.db.prepare('UPDATE keys SET created_at=?,stamina_balance=12300,stamina_refill_period=90 WHERE id=?').run(created,a.id);
    store.db.prepare('UPDATE keys SET created_at=?,stamina_balance=1700,stamina_refill_period=90 WHERE id=?').run(created,b.id);
    store.reserve(a.id,'schedule-pending','/ai/generate-image','nai-diffusion-5-full',0,null,1,{stamina:100});
    const oldMarker=store.get('local_stamina_v1'),before=store.db.prepare('SELECT * FROM keys ORDER BY id').all();
    store.db.exec("ALTER TABLE keys RENAME COLUMN stamina_refill_period TO stamina_refill_day; DELETE FROM settings WHERE name='local_stamina_created_v2'");
    store.db.prepare('UPDATE keys SET stamina_refill_day=?').run(Math.floor((now+4*3600000)/DAY_MS));
    store.close();store=new Store(dir);
    assert.equal(store.get('local_stamina_v1'),oldMarker);
    assert.equal(store.key(a.id).stamina_capacity,112000);assert.equal(store.key(b.id).stamina_capacity,28000);
    assert.equal(store.usableKey(a.id).stamina_balance,12300);assert.equal(store.usableKey(b.id).stamina_balance,1700);
    assert.equal(store.key(a.id).stamina_reserved,0);assert.equal(store.jobs()[0].status,'failed');
    for(const row of before) for(const field of ['id','name','token_hash','token_encrypted','balance','tier','enabled','created_at','expires_at','stamina_capacity']) assert.equal(store.key(row.id)[field],row[field],field);
    assert.equal(store.key(a.id).stamina_refill_period,90);
    assert.equal(store.refillStamina(store.key(a.id),created+91*DAY_MS-1).stamina_balance,12300);
    assert.equal(store.refillStamina(store.key(a.id),created+91*DAY_MS).stamina_balance,28300);
    assert.equal(store.refillStamina(store.key(b.id),created+91*DAY_MS).stamina_balance,5700);
    const marker=store.get('local_stamina_created_v2');store.close();store=new Store(dir);
    assert.equal(store.get('local_stamina_created_v2'),marker);assert.equal(store.key(a.id).stamina_balance,28300);
    assert.equal(readdirSync(join(dir,'backups')).length,1);assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {store?.close();}
});

test('恢复周期升级失败不改原余额或标记，回滚后可重试',t=>{
  const dir=directory(t);let store=new Store(dir);const key=store.createKey('已有体力',6000,{tier:'member',staminaPercent:100});
  store.db.exec("ALTER TABLE keys RENAME COLUMN stamina_refill_period TO stamina_refill_day; DELETE FROM settings WHERE name='local_stamina_created_v2'");
  store.db.exec("CREATE TRIGGER reject_schedule BEFORE INSERT ON settings WHEN NEW.name='local_stamina_created_v2' BEGIN SELECT RAISE(ABORT,'fixture schedule failure'); END");
  try {
    const balance=store.key(key.id).stamina_balance,oldMarker=store.get('local_stamina_v1');
    assert.throws(()=>migrateLocalStamina(store.db,dir),/fixture schedule failure/);
    assert.equal(store.key(key.id).stamina_balance,balance);assert.equal(store.get('local_stamina_v1'),oldMarker);
    assert.equal(store.get('local_stamina_created_v2'),null);assert.ok(store.db.prepare('PRAGMA table_info(keys)').all().some(c=>c.name==='stamina_refill_day'));
    store.db.exec('DROP TRIGGER reject_schedule');migrateLocalStamina(store.db,dir);
    assert.equal(store.key(key.id).stamina_balance,balance);assert.equal(store.key(key.id).stamina_refill_period,0);
  } finally {store.close();}
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
