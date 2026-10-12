import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db.mjs';
import { DAY_MS } from '../src/stamina.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sakura-ledger-test-'));
  let store = new Store(directory);
  t.after(() => {
    store.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'sakura-ledger-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, get store() { return store; }, reopen() { store.close(); store = new Store(directory); } };
}

test('零点创建和调整不写流水，分配、充值与人工扣点保留，失败调整不影响余额或流水', t => {
  const { store } = fixture(t);
  const empty = store.createKey('零点会员', 0, { tier: 'member' });
  assert.equal(store.key(empty.id).stamina_balance, 4000);
  assert.deepEqual(store.ledger(), []);
  store.adjust(empty.id, 0, '零点调整');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM ledger').get().count, 0);
  const funded = store.createKey('发放点数', 100);
  store.adjust(funded.id, 50, '充值');
  store.adjust(funded.id, -20, '人工扣点');
  const before = store.ledger();
  assert.deepEqual(before.map(row => [row.kind, row.delta]), [['adjust', -20], ['adjust', 50], ['grant', 100]]);
  assert.throws(() => store.adjust(funded.id, -131, '余额不足'), /调整后余额/);
  assert.equal(store.key(funded.id).balance, 130);
  assert.deepEqual(store.ledger(), before);
});

test('免费体力生成和失败请求保留任务但不写流水，实际扣点只记录一次', t => {
  const { store } = fixture(t), upstream = store.setUpstream('pst-ledger-fixture');
  const key = store.createKey('会员', 100, { tier: 'member' }), initial = store.ledger();
  const reserve = (id, amount, stamina = 0) => store.reserve(key.id, id, '/ai/generate-image', 'nai-diffusion-5-full', amount, id, upstream, { stamina });
  reserve('free', 0, 100);
  store.settle('free', 0, 'completed', '免费生成', 200);
  assert.equal(store.key(key.id).stamina_balance, 3900);
  assert.equal(store.jobs()[0].stamina_charged, 100);
  assert.deepEqual(store.ledger(), initial);
  reserve('failed', 26, 100);
  store.fail('failed', '上游失败', 500);
  assert.equal(store.key(key.id).balance, 100);
  assert.equal(store.key(key.id).stamina_balance, 3900);
  assert.equal(store.key(key.id).reserved, 0);
  assert.equal(store.key(key.id).stamina_reserved, 0);
  assert.deepEqual(store.ledger(), initial);
  reserve('paid', 26, 100);
  store.settle('paid', 26, 'completed', '批量额外扣点', 200);
  assert.equal(store.key(key.id).balance, 74);
  assert.equal(store.key(key.id).stamina_balance, 3800);
  assert.deepEqual(store.ledger().map(row => [row.kind, row.delta, row.job_id]), [['usage', -26, 'paid'], ['grant', 100, null]]);
  assert.equal(store.jobs().length, 3);
  assert.throws(() => store.settle('paid', 26, 'completed', '重复结算', 200), /已经结算/);
  store.fail('paid', '迟到的失败回调');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM ledger WHERE kind='usage'").get().count, 1);
});

test('历史零点流水在查询限制前过滤，非零历史与底层记录保留', t => {
  const { store } = fixture(t), key = store.createKey('历史流水', 100);
  store.adjust(key.id, 20, '历史充值');
  const expected = store.ledger();
  const insert = store.db.prepare('INSERT INTO ledger(key_id,delta,kind,note,created_at) VALUES(?,0,?,?,?)');
  for (let i = 0; i < 120; i++) insert.run(key.id, ['usage', 'grant', 'adjust'][i % 3], '旧零点记录', Date.now());
  assert.deepEqual(store.ledger(), expected);
  assert.deepEqual(store.ledger(1), [expected[0]]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM ledger WHERE delta=0').get().count, 120);
});

test('已迁移数据库重启保留体力档位、周期、凭据和历史，不依赖或重写迁移标记', t => {
  const f = fixture(t), store = f.store, upstream = store.setUpstream('pst-current-schema-fixture');
  store.set('admin_password', 'preserved-password-hash');
  store.set('local_stamina_v1', 'completed-v1');
  store.set('local_stamina_created_v2', 'completed-v2');
  const high = store.createKey('100%低余额', 500, { tier: 'member', staminaPercent: 100 });
  const low = store.createKey('25%高余额', 6000, { tier: 'member', staminaPercent: 25 });
  const created = Date.now() - 90 * DAY_MS - 6 * 3600000;
  store.db.prepare('UPDATE keys SET created_at=?,stamina_balance=?,stamina_refill_period=90 WHERE id=?').run(created, 12300, high.id);
  store.db.prepare('UPDATE keys SET created_at=?,stamina_balance=?,stamina_refill_period=90 WHERE id=?').run(created, 1700, low.id);
  store.reserve(low.id, 'history', '/ai/generate-image', 'nai-diffusion-5-full', 26, 'history', upstream, { stamina: 100 });
  store.settle('history', 26, 'completed', '已迁移历史', 200);
  const before = { keys: store.keys(), jobs: store.jobs(), ledger: store.ledger() };
  const master = readFileSync(join(f.directory, 'master.key'));
  f.reopen();
  assert.deepEqual({ keys: f.store.keys(), jobs: f.store.jobs(), ledger: f.store.ledger() }, before);
  assert.deepEqual(f.store.revealKey(high.id), high);
  assert.deepEqual(f.store.revealKey(low.id), low);
  assert.equal(f.store.upstreamToken(upstream), 'pst-current-schema-fixture');
  assert.equal(f.store.get('admin_password'), 'preserved-password-hash');
  assert.equal(f.store.get('local_stamina_v1'), 'completed-v1');
  assert.equal(f.store.get('local_stamina_created_v2'), 'completed-v2');
  assert.deepEqual(readFileSync(join(f.directory, 'master.key')), master);
  assert.equal(existsSync(join(f.directory, 'backups')), false);
  f.store.db.exec("DELETE FROM settings WHERE name IN ('local_stamina_v1','local_stamina_created_v2')");
  f.reopen();
  assert.deepEqual({ keys: f.store.keys(), jobs: f.store.jobs(), ledger: f.store.ledger() }, before);
  assert.equal(f.store.get('local_stamina_v1'), null);
  assert.equal(f.store.get('local_stamina_created_v2'), null);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});
