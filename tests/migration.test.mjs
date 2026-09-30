import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.mjs';
import { seal, hash } from '../src/security.mjs';

test('删除账号权重保留密钥、绑定和流水，原权重零转为停用且只迁移一次',()=>{
  const directory=mkdtempSync(join(tmpdir(),'sakura-schema-test-'));let store;
  try {
    store=new Store(directory);store.set('admin_password','preserved-password-hash');
    for(const [name,token,enabled] of [['正常','pst-active',true],['旧暂停','pst-paused',true],['旧停用','pst-disabled',false]])
      store.addUpstream({name,token,enabled});
    const member=store.createKey('绑定保留',88,{tier:'member',upstreamId:2,validDays:30});
    const standard=store.createKey('历史保留',100);
    store.reserve(standard.id,'preserved-job','/ai/generate-image','nai-diffusion-5-full',26,null,1,{upstreamEstimate:26});
    store.settle('preserved-job',26,'completed','原有成功任务',200);
    store.db.exec('ALTER TABLE upstreams ADD COLUMN weight INTEGER NOT NULL DEFAULT 1 CHECK(weight BETWEEN 0 AND 1000); UPDATE upstreams SET weight=0 WHERE id=2; UPDATE upstreams SET weight=9 WHERE id=1;');
    store.close();store=new Store(directory);
    assert.ok(!store.db.prepare('PRAGMA table_info(upstreams)').all().some(c=>c.name==='weight'));
    assert.deepEqual(store.upstreams().map(u=>u.enabled),[1,0,0]);
    assert.equal(store.upstreamToken(2),'pst-paused');assert.deepEqual(store.revealKey(member.id),member);
    assert.equal(store.key(member.id).nai5_upstream_id,2);assert.equal(store.key(member.id).balance,88);
    assert.equal(store.key(standard.id).balance,74);assert.equal(store.jobs()[0].charged,26);
    assert.equal(store.jobs()[0].upstream_spent,26);assert.equal(store.get('admin_password'),'preserved-password-hash');
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
    store.updateUpstream(2,{name:'重新启用',enabled:true});
    store.close();store=new Store(directory);
    assert.equal(store.upstream(2).enabled,1);assert.equal(store.ledger().filter(l=>l.kind==='usage').length,1);
  } finally {
    store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+'\\sakura-schema-test-') || resolve(directory).startsWith(resolve(tmpdir())+'/sakura-schema-test-'));
    rmSync(directory,{recursive:true,force:true});
  }
});

test('增加密钥删除标记保留现有密钥与流水，删除后重启不会恢复凭据或绑定', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sakura-schema-test-')); let store;
  try {
    store = new Store(directory); store.setUpstream('pst-migration-test');
    const active = store.createKey('保留密钥', 100);
    const member = store.createKey('待删除会员', 88, { tier: 'member', upstreamId: 1, validDays: 30 });
    store.reserve(member.id, 'delete-history', '/ai/generate-image', 'nai-diffusion-5-full', 26, null, 1);
    store.settle('delete-history', 26, 'completed', '保留历史', 200);
    const expires = store.key(member.id).expires_at, ledger = store.ledger();
    store.db.exec('ALTER TABLE keys DROP COLUMN retired_at');
    store.close(); store = new Store(directory);
    assert.deepEqual(store.revealKey(active.id), active); assert.deepEqual(store.revealKey(member.id), member);
    assert.equal(store.key(member.id).expires_at, expires); assert.equal(store.key(member.id).balance, 62);
    assert.equal(store.upstreams()[0].bound_keys, 1); assert.deepEqual(store.ledger(), ledger);
    store.retireKey(member.id); store.retireUpstream(1);
    store.close(); store = new Store(directory);
    assert.equal(store.authenticate(member.token), null); assert.equal(store.key(member.id), undefined);
    assert.throws(() => store.updateKey(member.id, { enabled: true }), /密钥不存在/);
    assert.throws(() => store.revealKey(member.id), /密钥不存在/);
    assert.deepEqual(store.keys().map(key => key.id), [active.id]);
    assert.equal(store.authenticate(active.token).balance, 100); assert.equal(store.upstreams().length, 0);
    assert.equal(store.jobs()[0].charged, 26); assert.equal(store.jobs()[0].key_name, '待删除会员');
    assert.deepEqual(store.ledger(), ledger); assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\sakura-schema-test-') || resolve(directory).startsWith(resolve(tmpdir()) + '/sakura-schema-test-'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('升级使旧 Key 失效并归档旧流水，保留管理员和上游，重启不清理新 Key', () => {
  const directory=mkdtempSync(join(tmpdir(),'sakura-schema-test-')), master=Buffer.alloc(32,1);
  const token='skr_'+'a'.repeat(43);let db,store;
  try {
    writeFileSync(join(directory,'master.key'),master);
    db=new DatabaseSync(join(directory,'relay.sqlite'));
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE settings(name TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO settings VALUES('admin_password','preserved-password-hash');
      CREATE TABLE upstreams(id INTEGER PRIMARY KEY,name TEXT NOT NULL,token TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,
        suffix TEXT NOT NULL,weight INTEGER NOT NULL,enabled INTEGER NOT NULL,created_at INTEGER NOT NULL,retired_at INTEGER);
      CREATE TABLE keys(id INTEGER PRIMARY KEY,name TEXT,token_hash TEXT,balance INTEGER);
      CREATE TABLE jobs(id TEXT PRIMARY KEY,key_id INTEGER REFERENCES keys(id),charged INTEGER,upstream_id INTEGER REFERENCES upstreams(id));
      CREATE TABLE ledger(id INTEGER PRIMARY KEY,key_id INTEGER REFERENCES keys(id),delta INTEGER);
      CREATE INDEX jobs_time ON jobs(id); CREATE INDEX ledger_time ON ledger(id); CREATE INDEX jobs_upstream_state ON jobs(upstream_id);
    `);
    db.prepare('INSERT INTO upstreams VALUES(1,?,?,?,?,1,1,1,NULL)').run('旧上游',seal('pst-preserved',master),hash('pst-preserved'),'rved');
    db.prepare('INSERT INTO keys VALUES(1,?,?,100)').run('旧用户',hash(token));
    db.exec("INSERT INTO jobs VALUES('old-request',1,26,1); INSERT INTO ledger VALUES(1,1,-26);");
    db.close();db=null;
    store=new Store(directory);
    assert.equal(store.authenticate(token),null);assert.equal(store.keys().length,0);
    assert.equal(store.jobs().length,0);assert.equal(store.ledger().length,0);
    assert.equal(store.get('admin_password'),'preserved-password-hash');assert.equal(store.upstreamToken(1),'pst-preserved');
    assert.equal(store.db.prepare('SELECT charged FROM archived_jobs').get().charged,26);
    assert.equal(store.db.prepare('SELECT delta FROM archived_ledger').get().delta,-26);
    assert.equal(store.db.prepare('SELECT name FROM archived_keys').get().name,'旧用户');
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
    const key=store.createKey('新会员',88,{tier:'member',upstreamId:1,validDays:30});const expires=store.key(key.id).expires_at;
    store.close();store=new Store(directory);
    assert.equal(store.authenticate(key.token).balance,88);assert.equal(store.key(key.id).expires_at,expires);
    assert.deepEqual(store.revealKey(key.id),key);assert.equal(store.key(key.id).nai5_upstream_id,1);
    assert.equal(store.authenticate(token),null);
  } finally {
    db?.close();store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+'\\sakura-schema-test-') || resolve(directory).startsWith(resolve(tmpdir())+'/sakura-schema-test-'));
    rmSync(directory,{recursive:true,force:true});
  }
});

test('启动自动释放历史待处理及旧核对任务，重复重启不重复结算',()=>{
  const directory=mkdtempSync(join(tmpdir(),'sakura-schema-test-')); let store;
  try {
    store=new Store(directory); store.setUpstream('pst-test'); const key=store.createKey('恢复测试',100);
    store.reserve(key.id,'interrupted','/ai/generate-image','nai-diffusion-5-full',26,null,1,{upstreamEstimate:26});
    store.reserve(key.id,'old-review','/ai/generate-image','nai-diffusion-4-5-full',17,null,1,{upstreamEstimate:17});
    store.db.prepare("UPDATE jobs SET status='review' WHERE id='old-review'").run();
    store.updateKey(key.id,{enabled:false,expiresAt:Date.now()-1});
    store.close(); store=new Store(directory);
    assert.equal(store.key(key.id).balance,100); assert.equal(store.key(key.id).reserved,0);
    assert.ok(store.jobs().every(j=>j.status==='failed' && j.charged===0 && j.upstream_spent===0));
    assert.equal(store.ledger().filter(l=>l.kind==='usage').length,2);
    store.close(); store=new Store(directory);
    assert.equal(store.key(key.id).reserved,0); assert.equal(store.key(key.id).balance,100);
    assert.equal(store.ledger().filter(l=>l.kind==='usage').length,2);
  } finally {
    store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+'\\sakura-schema-test-') || resolve(directory).startsWith(resolve(tmpdir())+'/sakura-schema-test-'));
    rmSync(directory,{recursive:true,force:true});
  }
});
