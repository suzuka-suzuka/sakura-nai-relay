import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hash, random, seal, unseal, assert, integer } from './security.mjs';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'master.key');
    // Never replace a missing master key for an existing database.
    if (!existsSync(keyPath)) {
      assert(!existsSync(join(directory, 'relay.sqlite')), '数据库存在但加密主密钥缺失，请恢复 master.key', 500);
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    this.master = readFileSync(keyPath);
    this.db = new DatabaseSync(join(directory, 'relay.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keys (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
        balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
        enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_used_at INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, key_id INTEGER NOT NULL REFERENCES keys(id), endpoint TEXT NOT NULL, model TEXT,
        status TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER, before_balance INTEGER,
        after_balance INTEGER, http_status INTEGER, note TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
        idempotency TEXT, UNIQUE(key_id, idempotency));
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY, key_id INTEGER NOT NULL REFERENCES keys(id), delta INTEGER NOT NULL,
        kind TEXT NOT NULL, note TEXT NOT NULL, job_id TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_time ON jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS ledger_time ON ledger(created_at DESC);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS upstreams (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      suffix TEXT NOT NULL, weight INTEGER NOT NULL DEFAULT 1 CHECK(weight BETWEEN 0 AND 1000),
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, retired_at INTEGER);
    `);
    const keyColumns = new Set(this.db.prepare('PRAGMA table_info(keys)').all().map(c => c.name));
    if (!keyColumns.has('token_encrypted')) this.db.exec('ALTER TABLE keys ADD COLUMN token_encrypted TEXT');
    const jobColumns = new Set(this.db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name));
    if (!jobColumns.has('upstream_id')) this.db.exec('ALTER TABLE jobs ADD COLUMN upstream_id INTEGER REFERENCES upstreams(id)');
    if (!jobColumns.has('upstream_name')) this.db.exec('ALTER TABLE jobs ADD COLUMN upstream_name TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_upstream_state ON jobs(upstream_id,status)');
    // One-time migration preserves the existing encrypted credential, balances and ledger.
    if (!this.get('upstream_pool_migrated')) this.transaction(() => {
      const legacy = this.get('upstream_token');
      if (legacy) {
        const token = unseal(legacy, this.master);
        const existing = this.db.prepare('SELECT id FROM upstreams WHERE token_hash=?').get(hash(token));
        const id = existing?.id ?? this.addUpstream({ name: this.get('upstream_name') || 'NovelAI 官方', token, weight: 1, enabled: true });
        this.db.prepare('UPDATE jobs SET upstream_id=?,upstream_name=? WHERE upstream_id IS NULL').run(id, this.upstream(id).name);
      }
      this.db.prepare("DELETE FROM settings WHERE name IN ('upstream_token','upstream_suffix','upstream_name')").run();
      this.set('upstream_pool_migrated', '1');
    });
    this.db.prepare("UPDATE jobs SET status='review', note='服务中断，请核对上游账单后结算' WHERE status='running'").run();
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    if (!this.get('admin_password') && !this.get('setup_hash')) {
      const token = random();
      writeFileSync(join(directory, 'setup-code.txt'), token, { mode: 0o600 });
      this.set('setup_hash', hash(token));
    }
  }
  get(name) { return this.db.prepare('SELECT value FROM settings WHERE name=?').get(name)?.value ?? null; }
  set(name, value) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, value); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  upstreams() {
    return this.db.prepare(`SELECT u.id,u.name,u.suffix,u.weight,u.enabled,u.created_at,
      (SELECT COUNT(*) FROM jobs WHERE upstream_id=u.id AND status='review') AS reviews
      FROM upstreams u WHERE retired_at IS NULL ORDER BY id`).all();
  }
  upstream(id) { return this.db.prepare('SELECT * FROM upstreams WHERE id=? AND retired_at IS NULL').get(id); }
  upstreamToken(id = this.upstreams()[0]?.id) { const row = this.upstream(id ?? -1); return row ? unseal(row.token, this.master) : null; }
  addUpstream({ name, token, weight = 1, enabled = true }) {
    const existing = this.db.prepare('SELECT id,retired_at FROM upstreams WHERE token_hash=?').get(hash(token));
    if (existing) {
      assert(existing.retired_at, '这个上游 Key 已存在，请编辑原有记录', 409);
      this.db.prepare('UPDATE upstreams SET retired_at=NULL,name=?,weight=?,enabled=? WHERE id=?').run(name, weight, Number(enabled), existing.id);
      return existing.id;
    }
    const result = this.db.prepare('INSERT INTO upstreams(name,token,token_hash,suffix,weight,enabled,created_at) VALUES(?,?,?,?,?,?,?)').run(name, seal(token, this.master), hash(token), token.slice(-4), weight, Number(enabled), Date.now());
    return Number(result.lastInsertRowid);
  }
  updateUpstream(id, { name, token, weight, enabled }) {
    const previous = this.upstream(id); assert(previous, '上游不存在', 404);
    if (token) {
      assert(!this.db.prepare('SELECT id FROM upstreams WHERE token_hash=? AND id!=?').get(hash(token), id), '这个上游 Key 已存在', 409);
      this.db.prepare('UPDATE upstreams SET token=?,token_hash=?,suffix=? WHERE id=?').run(seal(token, this.master), hash(token), token.slice(-4), id);
    }
    this.db.prepare('UPDATE upstreams SET name=?,weight=?,enabled=? WHERE id=?').run(name, weight, Number(enabled), id);
  }
  retireUpstream(id) { this.db.prepare('UPDATE upstreams SET enabled=0,retired_at=? WHERE id=?').run(Date.now(), id); }
  hasUnsettled(id) { return !!this.db.prepare("SELECT id FROM jobs WHERE upstream_id=? AND status IN ('running','review') LIMIT 1").get(id); }
  hasOrphanReview() { return !!this.db.prepare("SELECT id FROM jobs WHERE upstream_id IS NULL AND status IN ('running','review') LIMIT 1").get(); }
  // Convenience for local fixtures; runtime routing always supplies an explicit upstream ID.
  setUpstream(token) {
    const first = this.upstreams()[0];
    if (first) { this.updateUpstream(first.id, { ...first, token }); return first.id; }
    return this.addUpstream({ name: 'NovelAI 官方', token });
  }
  keys() { return this.db.prepare('SELECT id,name,prefix,balance,reserved,enabled,created_at,last_used_at FROM keys ORDER BY id DESC').all(); }
  key(id) { return this.db.prepare('SELECT * FROM keys WHERE id=?').get(id); }
  authenticate(token) {
    const key = this.db.prepare('SELECT * FROM keys WHERE token_hash=? AND enabled=1').get(hash(token));
    // Older keys only have a hash. Save the original only after verifying it.
    if (key && !key.token_encrypted) {
      key.token_encrypted = seal(token, this.master);
      this.db.prepare('UPDATE keys SET token_encrypted=? WHERE id=?').run(key.token_encrypted, key.id);
    }
    return key;
  }
  revealKey(id) {
    const key = this.key(id); assert(key, '密钥不存在', 404);
    return { id: key.id, token: key.token_encrypted ? unseal(key.token_encrypted, this.master) : null };
  }
  regenerateKey(id) {
    return this.transaction(() => {
      const key = this.key(id); assert(key, '密钥不存在', 404);
      assert(!key.token_encrypted, '完整密钥已可查看，无需重新生成', 409);
      assert(!this.db.prepare("SELECT id FROM jobs WHERE key_id=? AND status='running' LIMIT 1").get(id), '请求进行中，请完成后再重新生成', 409);
      const token = `skr_${random()}`;
      this.db.prepare('UPDATE keys SET token_hash=?,prefix=?,token_encrypted=? WHERE id=?').run(hash(token), `${token.slice(0, 10)}…${token.slice(-4)}`, seal(token, this.master), id);
      return { id: key.id, token };
    });
  }
  createKey(name, balance) {
    const token = `skr_${random()}`;
    return this.transaction(() => {
      const result = this.db.prepare('INSERT INTO keys(name,token_hash,prefix,balance,created_at,token_encrypted) VALUES(?,?,?,?,?,?)').run(name, hash(token), `${token.slice(0, 10)}…${token.slice(-4)}`, balance, Date.now(), seal(token, this.master));
      const id = Number(result.lastInsertRowid);
      this.db.prepare('INSERT INTO ledger(key_id,delta,kind,note,created_at) VALUES(?,?,?,?,?)').run(id, balance, 'grant', '创建密钥', Date.now());
      return { id, token };
    });
  }
  adjust(id, delta, note) {
    return this.transaction(() => {
      const key = this.key(id); assert(key, '密钥不存在', 404);
      integer(key.balance + delta, key.reserved, 1_000_000_000, '调整后余额');
      this.db.prepare('UPDATE keys SET balance=balance+? WHERE id=?').run(delta, id);
      this.db.prepare('INSERT INTO ledger(key_id,delta,kind,note,created_at) VALUES(?,?,?,?,?)').run(id, delta, 'adjust', note, Date.now());
    });
  }
  reserve(keyId, id, endpoint, model, amount, before, idempotency, upstreamId = this.upstreams()[0]?.id) {
    this.transaction(() => {
      const key = this.key(keyId); assert(key?.enabled, '密钥已停用', 401);
      assert(key.balance - key.reserved >= amount, `Anlas 不足，本次需要预留 ${amount} Anlas`, 402);
      const selected = this.upstream(upstreamId ?? -1);
      assert(selected?.enabled && selected.weight > 0, '选定上游已停用，请重新查询额度', 409);
      assert(!this.hasOrphanReview() && !this.hasUnsettled(upstreamId), '该上游有未结算任务，请稍后再试或联系管理员', 409);
      if (idempotency) assert(!this.db.prepare('SELECT id FROM jobs WHERE key_id=? AND idempotency=?').get(keyId, idempotency), '该请求已受理，请勿重复提交', 409);
      this.db.prepare("INSERT INTO jobs(id,key_id,endpoint,model,status,reserved,before_balance,created_at,idempotency,upstream_id,upstream_name) VALUES(?,?,?,?,'running',?,?,?,?,?,?)").run(id, keyId, endpoint, model, amount, before, Date.now(), idempotency, upstreamId, selected.name);
      this.db.prepare('UPDATE keys SET reserved=reserved+?,last_used_at=? WHERE id=?').run(amount, Date.now(), keyId);
    });
  }
  settle(id, charged, status, note, after = null, http = null) {
    this.transaction(() => {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      assert(job && ['running', 'review'].includes(job.status), '任务已经结算或不存在', 409);
      const key = this.key(job.key_id);
      integer(charged, 0, key.balance - key.reserved + job.reserved, '结算 Anlas');
      this.db.prepare('UPDATE keys SET reserved=reserved-?,balance=balance-? WHERE id=?').run(job.reserved, charged, job.key_id);
      this.db.prepare('UPDATE jobs SET status=?,charged=?,after_balance=?,http_status=?,note=?,finished_at=? WHERE id=?').run(status, charged, after, http, note, Date.now(), id);
      this.db.prepare('INSERT INTO ledger(key_id,delta,kind,note,job_id,created_at) VALUES(?,?,?,?,?,?)').run(job.key_id, -charged, 'usage', note, id, Date.now());
    });
  }
  review(id, note, after = null, http = null) { this.db.prepare("UPDATE jobs SET status='review',note=?,after_balance=?,http_status=?,finished_at=? WHERE id=? AND status='running'").run(note, after, http, Date.now(), id); }
  jobs(limit = 100) { return this.db.prepare('SELECT jobs.*,keys.name AS key_name FROM jobs JOIN keys ON keys.id=jobs.key_id ORDER BY created_at DESC LIMIT ?').all(limit); }
  ledger(limit = 100) { return this.db.prepare('SELECT ledger.*,keys.name AS key_name FROM ledger JOIN keys ON keys.id=ledger.key_id ORDER BY ledger.id DESC LIMIT ?').all(limit); }
  close() { this.db.close(); }
}
