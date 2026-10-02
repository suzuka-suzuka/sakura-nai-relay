import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hash, random, seal, unseal, assert, integer, HttpError } from './security.mjs';

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
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    // Old keys are no longer accepted. Preserve their history in archival tables.
    const oldColumns = this.db.prepare('PRAGMA table_info(keys)').all();
    if (oldColumns.length && !oldColumns.some(c => c.name === 'tier')) this.transaction(() => {
      this.db.exec(`ALTER TABLE keys RENAME TO archived_keys;
        ALTER TABLE jobs RENAME TO archived_jobs;
        ALTER TABLE ledger RENAME TO archived_ledger;
        DROP INDEX IF EXISTS jobs_time; DROP INDEX IF EXISTS ledger_time; DROP INDEX IF EXISTS jobs_upstream_state;`);
    });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keys (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
        balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
        token_encrypted TEXT NOT NULL, tier TEXT NOT NULL CHECK(tier IN ('standard','member')),
        nai5_upstream_id INTEGER REFERENCES upstreams(id), expires_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_used_at INTEGER, retired_at INTEGER,
        CHECK((tier='member' AND nai5_upstream_id IS NOT NULL) OR (tier='standard' AND nai5_upstream_id IS NULL)));
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, key_id INTEGER NOT NULL REFERENCES keys(id), endpoint TEXT NOT NULL, model TEXT,
        status TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER,
        http_status INTEGER, note TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
        upstream_id INTEGER NOT NULL REFERENCES upstreams(id), upstream_name TEXT NOT NULL,
        tier_snapshot TEXT NOT NULL, route_mode TEXT NOT NULL, upstream_estimate INTEGER NOT NULL,
        upstream_spent INTEGER NOT NULL DEFAULT 0,
        idempotency TEXT, UNIQUE(key_id, idempotency));
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY, key_id INTEGER NOT NULL REFERENCES keys(id), delta INTEGER NOT NULL,
        kind TEXT NOT NULL, note TEXT NOT NULL, job_id TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_time ON jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS ledger_time ON ledger(created_at DESC);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS upstreams (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      suffix TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, retired_at INTEGER);
    `);
    if (this.db.prepare('PRAGMA table_info(upstreams)').all().some(c => c.name === 'weight')) this.transaction(() => {
      // Preserve accounts previously paused through weight=0 before removing the setting.
      this.db.exec('UPDATE upstreams SET enabled=0 WHERE weight=0; ALTER TABLE upstreams DROP COLUMN weight;');
    });
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(c => c.name === 'upstream_spent')) this.transaction(() => {
      this.db.exec('ALTER TABLE jobs ADD COLUMN upstream_spent INTEGER NOT NULL DEFAULT 0');
      this.db.exec("UPDATE jobs SET upstream_spent=upstream_estimate WHERE status='completed' OR (status='resolved' AND charged>0)");
    });
    if (!this.db.prepare('PRAGMA table_info(keys)').all().some(c => c.name === 'retired_at'))
      this.db.exec('ALTER TABLE keys ADD COLUMN retired_at INTEGER');
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_upstream_state ON jobs(upstream_id,status)');
    this.db.exec('CREATE INDEX IF NOT EXISTS keys_binding ON keys(nai5_upstream_id)');
    this.db.prepare("UPDATE jobs SET status='running' WHERE status='review'").run();
    for (const job of this.db.prepare("SELECT id FROM jobs WHERE status='running'").all())
      this.fail(job.id, '服务中断，任务失败，已自动释放预留点数');
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
    return this.db.prepare(`SELECT u.id,u.name,u.suffix,u.enabled,u.created_at,
      (SELECT COUNT(*) FROM keys WHERE nai5_upstream_id=u.id AND retired_at IS NULL) AS bound_keys
      FROM upstreams u WHERE retired_at IS NULL ORDER BY id`).all();
  }
  upstream(id) { return this.db.prepare('SELECT * FROM upstreams WHERE id=? AND retired_at IS NULL').get(id); }
  upstreamToken(id = this.upstreams()[0]?.id) { const row = this.upstream(id ?? -1); return row ? unseal(row.token, this.master) : null; }
  addUpstream({ name, token, enabled = true }) {
    const existing = this.db.prepare('SELECT id,retired_at FROM upstreams WHERE token_hash=?').get(hash(token));
    if (existing) assert(existing.retired_at, '这个上游 Key 已存在，请编辑原有记录', 409);
    name = this.recordName(name ?? '', 'upstreams');
    if (existing) {
      this.db.prepare('UPDATE upstreams SET retired_at=NULL,name=?,enabled=? WHERE id=?').run(name, Number(enabled), existing.id);
      return existing.id;
    }
    const result = this.db.prepare('INSERT INTO upstreams(name,token,token_hash,suffix,enabled,created_at) VALUES(?,?,?,?,?,?)').run(name, seal(token, this.master), hash(token), token.slice(-4), Number(enabled), Date.now());
    return Number(result.lastInsertRowid);
  }
  updateUpstream(id, { name, token, enabled }) {
    const previous = this.upstream(id); assert(previous, '上游不存在', 404);
    if (token) {
      assert(!this.db.prepare('SELECT id FROM upstreams WHERE token_hash=? AND id!=?').get(hash(token), id), '这个上游 Key 已存在', 409);
      this.db.prepare('UPDATE upstreams SET token=?,token_hash=?,suffix=? WHERE id=?').run(seal(token, this.master), hash(token), token.slice(-4), id);
    }
    this.db.prepare('UPDATE upstreams SET name=?,enabled=? WHERE id=?').run(name === undefined ? previous.name : this.recordName(name, 'upstreams'), Number(enabled), id);
  }
  boundKeys(id) { return this.db.prepare('SELECT id,reserved FROM keys WHERE nai5_upstream_id=? AND retired_at IS NULL').all(id); }
  retireUpstream(id, replacementId = null) {
    return this.transaction(() => {
      assert(this.upstream(id), '上游不存在', 404);
      assert(!this.hasUnsettled(id), '该上游仍有进行中的请求，暂不能移除', 409);
      const bindings = this.boundKeys(id);
      if (bindings.length) {
        assert(replacementId !== id && this.upstream(replacementId ?? -1)?.enabled, '没有可换绑的上游，原上游未移除', 503);
        const running = this.db.prepare("SELECT id FROM jobs WHERE key_id=? AND status='running' LIMIT 1");
        assert(bindings.every(key => key.reserved === 0 && !running.get(key.id)), '请等待绑定会员的生成和排队结束，再移除上游', 409);
        this.db.prepare('UPDATE keys SET nai5_upstream_id=? WHERE nai5_upstream_id=? AND retired_at IS NULL').run(replacementId, id);
      }
      this.db.prepare('UPDATE upstreams SET enabled=0,retired_at=? WHERE id=?').run(Date.now(), id);
      return bindings.length;
    });
  }
  hasUnsettled(id) { return !!this.db.prepare("SELECT id FROM jobs WHERE upstream_id=? AND status='running' LIMIT 1").get(id); }
  // Convenience for local fixtures; runtime routing always supplies an explicit upstream ID.
  setUpstream(token) {
    const first = this.upstreams()[0];
    if (first) { this.updateUpstream(first.id, { ...first, token }); return first.id; }
    return this.addUpstream({ name: 'NovelAI 官方', token });
  }
  keys() { return this.db.prepare(`SELECT k.id,k.name,k.prefix,k.balance,k.reserved,k.enabled,k.created_at,k.last_used_at,
    k.tier,k.nai5_upstream_id,k.expires_at,u.name AS upstream_name FROM keys k LEFT JOIN upstreams u ON u.id=k.nai5_upstream_id WHERE k.retired_at IS NULL ORDER BY k.id DESC`).all(); }
  key(id) { return this.db.prepare('SELECT * FROM keys WHERE id=? AND retired_at IS NULL').get(id); }
  usableKey(id) {
    const key = this.key(id); assert(key?.enabled, '中转密钥无效或已停用', 401);
    if (key.expires_at !== null && key.expires_at <= Date.now()) throw new HttpError(403, '访问密钥已过期，请联系管理员续期', 'KEY_EXPIRED');
    return key;
  }
  authenticate(token) {
    const key = this.db.prepare('SELECT id FROM keys WHERE token_hash=? AND retired_at IS NULL').get(hash(token));
    return key ? this.usableKey(key.id) : null;
  }
  revealKey(id) {
    const key = this.key(id); assert(key, '密钥不存在', 404);
    return { id: key.id, token: unseal(key.token_encrypted, this.master) };
  }
  searchKeys(query) {
    const text = query.toLowerCase();
    return this.db.prepare('SELECT id,name,prefix,token_encrypted FROM keys WHERE retired_at IS NULL ORDER BY id DESC').all()
      .filter(key => key.name.toLowerCase().includes(text) || key.prefix.toLowerCase().includes(text) || unseal(key.token_encrypted, this.master).includes(query))
      .map(key => key.id);
  }
  recordName(name, table) {
    if (name.trim()) return name.trim();
    const setting = table === 'keys' ? 'key_name_sequence' : 'upstream_name_sequence';
    const prefix = table === 'keys' ? '下游-Key-' : '上游-Key-';
    let sequence = Number(this.get(setting) ?? 0);
    const occupied = this.db.prepare(`SELECT id FROM ${table} WHERE lower(name)=? LIMIT 1`);
    do { sequence++; } while (occupied.get(`${prefix}${sequence}`.toLowerCase()));
    this.set(setting, String(sequence));
    return `${prefix}${sequence}`;
  }
  keySettings(options, previous = {}) {
    const tier = options.tier ?? previous.tier ?? 'standard';
    assert(['standard', 'member'].includes(tier), '等级只能是普通或会员');
    const binding = tier === 'member' ? (options.upstreamId === undefined ? previous.nai5_upstream_id : options.upstreamId) : null;
    if (tier === 'member') {
      integer(binding, 1, Number.MAX_SAFE_INTEGER, '会员绑定上游');
      assert(this.upstream(binding), '会员必须绑定一个存在的上游');
    } else assert(options.upstreamId === undefined || options.upstreamId === null, '普通密钥不绑定上游');
    assert(!(options.validDays !== undefined && options.expiresAt !== undefined), '有效天数和到期时间不能同时设置');
    let expires = options.expiresAt === undefined ? previous.expires_at ?? null : options.expiresAt;
    if (options.validDays !== undefined) expires = Math.max(Date.now(), previous.expires_at ?? 0) + integer(options.validDays, 1, 36500, '有效天数') * 86400000;
    if (expires !== null) integer(expires, 1, 8640000000000000, '到期时间');
    return { tier, binding, expires };
  }
  createKey(name, balance, options = {}) {
    const token = `skr_${random()}`;
    return this.transaction(() => {
      const { tier, binding, expires } = this.keySettings(options);
      name = this.recordName(name ?? '', 'keys');
      const result = this.db.prepare('INSERT INTO keys(name,token_hash,prefix,balance,created_at,token_encrypted,tier,nai5_upstream_id,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(name, hash(token), `${token.slice(0, 10)}…${token.slice(-4)}`, balance, Date.now(), seal(token, this.master), tier, binding, expires);
      const id = Number(result.lastInsertRowid);
      this.db.prepare('INSERT INTO ledger(key_id,delta,kind,note,created_at) VALUES(?,?,?,?,?)').run(id, balance, 'grant', '创建密钥', Date.now());
      return { id, token };
    });
  }
  updateKey(id, options) {
    this.transaction(() => {
      const key = this.key(id); assert(key, '密钥不存在', 404);
      const { tier, binding, expires } = this.keySettings(options, key);
      assert(options.enabled === undefined || typeof options.enabled === 'boolean', '状态无效');
      this.db.prepare('UPDATE keys SET name=?,tier=?,nai5_upstream_id=?,expires_at=?,enabled=? WHERE id=?')
        .run(options.name === undefined ? key.name : this.recordName(options.name, 'keys'), tier, binding, expires, options.enabled === undefined ? key.enabled : Number(options.enabled), id);
    });
  }
  retireKey(id) {
    this.transaction(() => {
      const key = this.key(id); assert(key, '密钥不存在', 404);
      assert(key.reserved === 0 && !this.db.prepare("SELECT id FROM jobs WHERE key_id=? AND status='running' LIMIT 1").get(id),
        '请等待该密钥的生成和排队结束，再删除密钥', 409);
      // Keep the row for historical job and ledger references; erase the recoverable credential.
      this.db.prepare("UPDATE keys SET enabled=0,retired_at=?,token_encrypted='' WHERE id=?").run(Date.now(), id);
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
  reserve(keyId, id, endpoint, model, amount, idempotency, upstreamId, { mode = 'pool', upstreamEstimate = 0 } = {}) {
    this.transaction(() => {
      const key = this.usableKey(keyId); integer(amount, 0, 1_000_000_000);
      assert(key.balance - key.reserved >= amount, `Anlas 不足，本次需要预留 ${amount} Anlas`, 402);
      const selected = this.upstream(upstreamId ?? -1);
      assert(selected?.enabled, '选定上游已停用，请重新查询额度', 409);
      if (idempotency) assert(!this.db.prepare('SELECT id FROM jobs WHERE key_id=? AND idempotency=?').get(keyId, idempotency), '该请求已受理，请勿重复提交', 409);
      this.db.prepare("INSERT INTO jobs(id,key_id,endpoint,model,status,reserved,created_at,idempotency,upstream_id,upstream_name,tier_snapshot,route_mode,upstream_estimate) VALUES(?,?,?,?,'running',?,?,?,?,?,?,?,?)").run(id, keyId, endpoint, model, amount, Date.now(), idempotency, upstreamId, selected.name, key.tier, mode, upstreamEstimate);
      this.db.prepare('UPDATE keys SET reserved=reserved+?,last_used_at=? WHERE id=?').run(amount, Date.now(), keyId);
    });
  }
  settle(id, charged, status, note, http = null) {
    this.transaction(() => {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      assert(job?.status === 'running', '任务已经结算或不存在', 409);
      assert(['completed', 'failed'].includes(status), '任务只能按成功或失败结算');
      assert(charged === (status === 'completed' ? job.reserved : 0), '成功按本地报价结算，失败释放全部预留');
      this.db.prepare('UPDATE keys SET reserved=reserved-?,balance=balance-? WHERE id=?').run(job.reserved, charged, job.key_id);
      this.db.prepare('UPDATE jobs SET status=?,charged=?,upstream_spent=?,http_status=?,note=?,finished_at=? WHERE id=?').run(status, charged, status === 'completed' ? job.upstream_estimate : 0, http, note, Date.now(), id);
      this.db.prepare('INSERT INTO ledger(key_id,delta,kind,note,job_id,created_at) VALUES(?,?,?,?,?,?)').run(job.key_id, -charged, 'usage', note, id, Date.now());
    });
  }
  fail(id, note, http = null) {
    if (this.db.prepare("SELECT id FROM jobs WHERE id=? AND status='running'").get(id)) this.settle(id, 0, 'failed', note, http);
  }
  jobs(limit = 100) { return this.db.prepare('SELECT jobs.*,keys.name AS key_name FROM jobs JOIN keys ON keys.id=jobs.key_id ORDER BY jobs.rowid DESC LIMIT ?').all(limit); }
  ledger(limit = 100) { return this.db.prepare('SELECT ledger.*,keys.name AS key_name FROM ledger JOIN keys ON keys.id=ledger.key_id ORDER BY ledger.id DESC LIMIT ?').all(limit); }
  close() { this.db.close(); }
}
