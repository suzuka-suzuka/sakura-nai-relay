import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hash, random, seal, unseal, assert, integer, HttpError } from './security.mjs';
import { capacityFor, dailyFor, refillPeriod, availableStamina } from './stamina.mjs';
import { PRODUCTS, productById, createCode, normalizeCode } from './cdk.mjs';
import { grantFullStaminaOnce } from './grant-full-stamina-once.mjs';

const KEY_COLUMNS = `
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
  token_encrypted TEXT NOT NULL, tier TEXT NOT NULL CHECK(tier IN ('standard','member')),
  expires_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  last_used_at INTEGER, retired_at INTEGER,
  stamina_capacity INTEGER NOT NULL DEFAULT 0 CHECK(stamina_capacity BETWEEN 0 AND 112000),
  stamina_balance INTEGER NOT NULL DEFAULT 0 CHECK(stamina_balance BETWEEN 0 AND stamina_capacity),
  stamina_reserved INTEGER NOT NULL DEFAULT 0 CHECK(stamina_reserved BETWEEN 0 AND stamina_balance),
  stamina_refill_period INTEGER NOT NULL CHECK(stamina_refill_period >= 0),
  CHECK(tier='member' OR (stamina_capacity=0 AND stamina_balance=0 AND stamina_reserved=0))`;

function jobStatuses(status) {
  assert(['all', 'failed', 'cancelled'].includes(status), '请求状态筛选无效');
  return status === 'all' ? null : JSON.stringify(status === 'failed' ? ['failed', 'rejected'] : ['cancelled']);
}

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
      CREATE TABLE IF NOT EXISTS keys (${KEY_COLUMNS});
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, key_id INTEGER REFERENCES keys(id), endpoint TEXT NOT NULL, model TEXT,
        status TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER,
        http_status INTEGER, note TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
        upstream_id INTEGER REFERENCES upstreams(id), upstream_name TEXT NOT NULL,
        tier_snapshot TEXT NOT NULL, route_mode TEXT NOT NULL, upstream_estimate INTEGER NOT NULL,
        upstream_spent INTEGER NOT NULL DEFAULT 0,
        stamina_reserved INTEGER NOT NULL DEFAULT 0, stamina_charged INTEGER,
        idempotency TEXT, UNIQUE(key_id, idempotency));
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY, key_id INTEGER NOT NULL REFERENCES keys(id), delta INTEGER NOT NULL,
        kind TEXT NOT NULL, note TEXT NOT NULL, job_id TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_time ON jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_key ON jobs(key_id);
      CREATE INDEX IF NOT EXISTS ledger_time ON ledger(created_at DESC);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS job_diagnostics (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id), request_json TEXT,
      upstream_error TEXT, failure_detail TEXT, response_content_type TEXT);`);
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
    // Entry failures may have neither an authenticated key nor a selected upstream.
    if (this.db.prepare('PRAGMA table_info(jobs)').all().some(c => ['key_id', 'upstream_id'].includes(c.name) && c.notnull)) {
      const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get().sql
        .replace(/^CREATE TABLE\s+(?:"jobs"|jobs)\s*\(/i, 'CREATE TABLE jobs_new (')
        .replace(/(key_id|upstream_id) INTEGER NOT NULL/g, '$1 INTEGER');
      this.db.exec('PRAGMA foreign_keys=OFF');
      try {
        this.transaction(() => {
          this.db.exec(schema);
          this.db.exec('INSERT INTO jobs_new SELECT * FROM jobs; DROP TABLE jobs; ALTER TABLE jobs_new RENAME TO jobs;');
          this.db.exec('CREATE INDEX jobs_time ON jobs(created_at DESC); CREATE INDEX jobs_key ON jobs(key_id);');
          assert(!this.db.prepare('PRAGMA foreign_key_check').all().length, '请求记录迁移外键校验失败', 500);
        });
      } finally { this.db.exec('PRAGMA foreign_keys=ON'); }
    }
    const jobColumns = this.db.prepare('PRAGMA table_info(jobs)').all();
    for (const [name, type] of [['request_method', 'TEXT'], ['stage', 'TEXT'], ['response_status', 'INTEGER'], ['client_disconnected_at', 'INTEGER']])
      if (!jobColumns.some(c => c.name === name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
    if (!this.db.prepare('PRAGMA table_info(keys)').all().some(c => c.name === 'retired_at'))
      this.db.exec('ALTER TABLE keys ADD COLUMN retired_at INTEGER');
    this.db.exec(`CREATE TABLE IF NOT EXISTS cdks (
      id INTEGER PRIMARY KEY, product_id TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE,
      code_encrypted TEXT NOT NULL, prefix TEXT NOT NULL, created_at INTEGER NOT NULL,
      redeemed_at INTEGER, key_id INTEGER REFERENCES keys(id));
      CREATE INDEX IF NOT EXISTS cdks_product ON cdks(product_id, redeemed_at);`);
    const cdkColumns = this.db.prepare('PRAGMA table_info(cdks)').all();
    if (!cdkColumns.some(c => c.name === 'voided_at')) this.transaction(() => {
      this.db.exec('ALTER TABLE cdks ADD COLUMN voided_at INTEGER; ALTER TABLE cdks ADD COLUMN void_reason TEXT');
    });
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_upstream_state ON jobs(upstream_id,status)');
    this.db.prepare("UPDATE jobs SET status='running' WHERE status='review'").run();
    for (const job of this.db.prepare("SELECT id FROM jobs WHERE status='running'").all())
      this.fail(job.id, '服务中断，任务失败，已自动释放预留点数和体力');
    for (const job of this.db.prepare("SELECT id FROM jobs WHERE status='pending'").all())
      this.finishPending(job.id, '服务中断，请求尚未转发上游，未扣点数', 503);
    try { grantFullStaminaOnce(this.db); } catch (error) { this.db.close(); throw error; }
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    if (!this.get('admin_password') && !this.get('setup_hash')) {
      const token = random();
      writeFileSync(join(directory, 'setup-code.txt'), token, { mode: 0o600 });
      this.set('setup_hash', hash(token));
    }
  }
  get(name) { return this.db.prepare('SELECT value FROM settings WHERE name=?').get(name)?.value ?? null; }
  set(name, value) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, value); this.onChange?.(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE'); let result;
    try { result = fn(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.onChange?.(); return result;
  }
  upstreams() {
    return this.db.prepare('SELECT id,name,suffix,enabled,created_at FROM upstreams WHERE retired_at IS NULL ORDER BY id').all();
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
  retireUpstream(id) {
    return this.transaction(() => {
      assert(this.upstream(id), '上游不存在', 404);
      assert(!this.hasUnsettled(id), '该上游仍有进行中的请求，暂不能移除', 409);
      this.db.prepare('UPDATE upstreams SET enabled=0,retired_at=? WHERE id=?').run(Date.now(), id);
    });
  }
  hasUnsettled(id) { return !!this.db.prepare("SELECT id FROM jobs WHERE upstream_id=? AND status='running' LIMIT 1").get(id); }
  // Convenience for local fixtures; runtime routing always supplies an explicit upstream ID.
  setUpstream(token) {
    const first = this.upstreams()[0];
    if (first) { this.updateUpstream(first.id, { ...first, token }); return first.id; }
    return this.addUpstream({ name: 'NovelAI 官方', token });
  }
  keys() {
    for (const key of this.db.prepare("SELECT * FROM keys WHERE tier='member' AND retired_at IS NULL").all()) this.refillStamina(key);
    return this.db.prepare(`SELECT id,name,prefix,balance,reserved,enabled,created_at,last_used_at,tier,expires_at,
      stamina_capacity,stamina_balance,stamina_reserved,stamina_refill_period FROM keys WHERE retired_at IS NULL ORDER BY id DESC`).all();
  }
  key(id) { return this.db.prepare('SELECT * FROM keys WHERE id=? AND retired_at IS NULL').get(id); }
  refillStamina(key, now = Date.now()) {
    const period = refillPeriod(key.created_at,now);
    if (key.tier !== 'member' || period <= key.stamina_refill_period) return key;
    this.db.prepare(`UPDATE keys SET stamina_balance=MIN(stamina_capacity,stamina_balance+?),stamina_refill_period=?
      WHERE id=? AND stamina_refill_period=? AND retired_at IS NULL`).run((period-key.stamina_refill_period)*dailyFor(key.stamina_capacity),period,key.id,key.stamina_refill_period);
    this.onChange?.();
    return this.key(key.id);
  }
  usableKey(id) {
    const key = this.key(id); assert(key?.enabled, '中转密钥无效或已停用', 401);
    if (key.expires_at !== null && key.expires_at <= Date.now()) throw new HttpError(403, '访问密钥已过期，请联系管理员续期', 'KEY_EXPIRED');
    return this.refillStamina(key);
  }
  authenticate(token) {
    const key = this.db.prepare('SELECT id FROM keys WHERE token_hash=? AND retired_at IS NULL').get(hash(token));
    return key ? this.usableKey(key.id) : null;
  }
  revealKey(id) {
    const key = this.key(id); assert(key, '密钥不存在', 404);
    return { id: key.id, token: unseal(key.token_encrypted, this.master) };
  }
  searchKeys(query, { includeRetired = false } = {}) {
    const text = query.toLowerCase(), tokenHash = hash(query);
    return this.db.prepare(`SELECT id,name,prefix,token_hash,token_encrypted FROM keys ${includeRetired ? '' : 'WHERE retired_at IS NULL'} ORDER BY id DESC`).all()
      .filter(key => key.name.toLowerCase().includes(text) || key.prefix.toLowerCase().includes(text) || key.token_hash === tokenHash || (key.token_encrypted && unseal(key.token_encrypted, this.master).includes(query)))
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
    assert(options.staminaPercent === undefined || tier === 'member', '普通密钥不能分配体力');
    const percent = options.staminaPercent === undefined ? (previous.tier === 'member' ? previous.stamina_capacity / 1120 : 25) : options.staminaPercent;
    const capacity = tier === 'member' ? capacityFor(integer(percent, 0, 100, '体力上限')) : 0;
    assert(!(options.validDays !== undefined && options.expiresAt !== undefined), '有效天数和到期时间不能同时设置');
    let expires = options.expiresAt === undefined ? previous.expires_at ?? null : options.expiresAt;
    if (options.validDays !== undefined) expires = Math.max(Date.now(), previous.expires_at ?? 0) + integer(options.validDays, 1, 36500, '有效天数') * 86400000;
    if (expires !== null) integer(expires, 1, 8640000000000000, '到期时间');
    return { tier, capacity, expires };
  }
  insertKey(name, balance, options = {}) {
    const token = `skr_${random()}`;
    const createdAt = Date.now();
    const { tier, capacity, expires } = this.keySettings(options);
    name = this.recordName(name ?? '', 'keys');
    const result = this.db.prepare(`INSERT INTO keys(name,token_hash,prefix,balance,created_at,token_encrypted,tier,expires_at,stamina_capacity,stamina_balance,stamina_refill_period)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(name,hash(token),`${token.slice(0,10)}…${token.slice(-4)}`,balance,createdAt,seal(token,this.master),tier,expires,capacity,capacity,0);
    const id = Number(result.lastInsertRowid);
    if (balance !== 0) this.db.prepare('INSERT INTO ledger(key_id,delta,kind,note,created_at) VALUES(?,?,?,?,?)').run(id, balance, 'grant', options.grantNote ?? '创建密钥', Date.now());
    return { id, token };
  }
  createKey(name, balance, options = {}) { return this.transaction(() => this.insertKey(name, balance, options)); }
  cdkSummary() {
    const counts = new Map(this.db.prepare(`SELECT product_id, SUM(key_id IS NULL AND voided_at IS NULL) AS unused, SUM(key_id IS NOT NULL) AS redeemed, SUM(key_id IS NULL AND voided_at IS NOT NULL) AS voided FROM cdks GROUP BY product_id`).all().map(row => [row.product_id, row]));
    return PRODUCTS.map(product => ({ ...product, unused: counts.get(product.id)?.unused ?? 0, redeemed: counts.get(product.id)?.redeemed ?? 0, voided: counts.get(product.id)?.voided ?? 0 }));
  }
  createCdks(productId, count) {
    const product = productById(productId); assert(product, '商品不存在');
    return this.transaction(() => {
      const insert = this.db.prepare('INSERT INTO cdks(product_id,code_hash,code_encrypted,prefix,created_at) VALUES(?,?,?,?,?)');
      const codes = Array.from({ length: count }, () => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = createCode();
          try { insert.run(product.id, hash(code), seal(code, this.master), code.slice(0, 8), Date.now()); return code; }
          catch (error) { if (!String(error.message).includes('UNIQUE')) throw error; }
        }
        assert(false, '兑换码生成失败，请重试', 500);
      });
      return { product: product.id, codes };
    });
  }
  unusedCdks(productId) {
    assert(productById(productId), '商品不存在');
    return this.db.prepare('SELECT code_encrypted FROM cdks WHERE product_id=? AND key_id IS NULL AND voided_at IS NULL ORDER BY id').all(productId).map(row => unseal(row.code_encrypted, this.master));
  }
  cdkRedemptions(limit = 50) {
    return this.db.prepare(`SELECT cdks.product_id, cdks.prefix, cdks.redeemed_at, cdks.key_id, keys.name AS key_name, keys.prefix AS key_prefix
      FROM cdks LEFT JOIN keys ON keys.id=cdks.key_id WHERE cdks.key_id IS NOT NULL ORDER BY cdks.redeemed_at DESC LIMIT ?`).all(limit);
  }
  findCdk(rawCode) {
    const code = normalizeCode(rawCode);
    const row = this.db.prepare(`SELECT cdks.product_id, cdks.prefix, cdks.created_at, cdks.redeemed_at, cdks.key_id, cdks.voided_at, cdks.void_reason,
      keys.name AS key_name, keys.prefix AS key_prefix, keys.retired_at, keys.enabled AS key_enabled
      FROM cdks LEFT JOIN keys ON keys.id=cdks.key_id WHERE cdks.code_hash=?`).get(hash(code));
    assert(row, '没有这枚兑换码', 404);
    const deleted = row.key_id !== null && row.retired_at !== null;
    return {
      productId: row.product_id, prefix: row.prefix, createdAt: row.created_at, redeemedAt: row.redeemed_at,
      status: row.key_id === null ? (row.voided_at === null ? 'unused' : 'voided') : deleted ? 'deleted' : 'redeemed',
      keyId: deleted ? null : row.key_id, keyName: row.key_name, keyPrefix: deleted ? null : row.key_prefix,
      keyEnabled: row.key_id === null || deleted ? false : !!row.key_enabled, voidedAt: row.voided_at, voidReason: row.void_reason,
    };
  }
  // 退款处理：未兑换的码直接作废；已兑换的码必须显式确认 disableKey 才会停用对应密钥。
  voidCdk(rawCode, { reason = null, disableKey = false } = {}) {
    const code = normalizeCode(rawCode);
    this.transaction(() => {
      const row = this.db.prepare('SELECT id,key_id,voided_at FROM cdks WHERE code_hash=?').get(hash(code));
      assert(row, '没有这枚兑换码', 404);
      if (row.key_id === null) {
        assert(row.voided_at === null, '这枚兑换码已经作废', 409);
      } else {
        const key = this.key(row.key_id);
        assert(disableKey || !key || key.retired_at !== null, '这枚兑换码已兑换，需同时停用对应密钥才能作废', 409);
        if (key && key.retired_at === null) this.db.prepare('UPDATE keys SET enabled=0 WHERE id=?').run(row.key_id);
      }
      this.db.prepare('UPDATE cdks SET voided_at=COALESCE(voided_at,?),void_reason=COALESCE(?,void_reason) WHERE id=?').run(Date.now(), reason, row.id);
    });
    return this.findCdk(code);
  }
  redeemCdk(rawCode) {
    const code = normalizeCode(rawCode);
    const used = '这枚兑换码已经兑换过，请联系管理员查询密钥';
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM cdks WHERE code_hash=?').get(hash(code));
      assert(row, '兑换码无效', 404);
      assert(!row.key_id, used, 409);
      assert(row.voided_at === null, '兑换码已作废，请联系卖家', 410);
      const product = productById(row.product_id); assert(product, '兑换码商品不存在', 500);
      const created = this.insertKey(product.name, product.points, {
        tier: product.tier, validDays: product.validDays, grantNote: '兑换码创建',
        ...(product.staminaPercent === undefined ? {} : { staminaPercent: product.staminaPercent }),
      });
      const updated = this.db.prepare('UPDATE cdks SET redeemed_at=?, key_id=? WHERE id=? AND key_id IS NULL AND voided_at IS NULL').run(Date.now(), created.id, row.id);
      assert(updated.changes === 1, used, 409);
      const key = this.key(created.id);
      return { token: created.token, key };
    });
  }
  updateKey(id, options) {
    this.transaction(() => {
      let key = this.key(id); assert(key, '密钥不存在', 404);
      key = this.refillStamina(key);
      const { tier, capacity, expires } = this.keySettings(options, key);
      if (tier !== key.tier || capacity !== key.stamina_capacity)
        assert(key.reserved === 0 && key.stamina_reserved === 0 && !this.db.prepare("SELECT id FROM jobs WHERE key_id=? AND status='running' LIMIT 1").get(id), '请等待该密钥请求结束，再修改等级或体力上限', 409);
      assert(options.enabled === undefined || typeof options.enabled === 'boolean', '状态无效');
      const stamina = tier !== key.tier ? dailyFor(capacity) : Math.min(capacity,key.stamina_balance);
      this.db.prepare('UPDATE keys SET name=?,tier=?,expires_at=?,enabled=?,stamina_capacity=?,stamina_balance=?,stamina_refill_period=? WHERE id=?')
        .run(options.name === undefined ? key.name : this.recordName(options.name,'keys'),tier,expires,options.enabled === undefined ? key.enabled : Number(options.enabled),capacity,stamina,Math.max(refillPeriod(key.created_at),key.stamina_refill_period),id);
    });
  }
  retireKey(id) {
    this.transaction(() => {
      const key = this.key(id); assert(key, '密钥不存在', 404);
      assert(key.reserved === 0 && key.stamina_reserved === 0 && !this.db.prepare("SELECT id FROM jobs WHERE key_id=? AND status='running' LIMIT 1").get(id),
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
      if (delta !== 0) this.db.prepare('INSERT INTO ledger(key_id,delta,kind,note,created_at) VALUES(?,?,?,?,?)').run(id, delta, 'adjust', note, Date.now());
    });
  }
  beginRequest(id, endpoint, method, token) {
    // Resolve identity without accepting a disabled, expired or retired credential.
    const key = token ? this.db.prepare('SELECT id,tier FROM keys WHERE token_hash=?').get(hash(token)) : null;
    this.db.prepare(`INSERT INTO jobs(id,key_id,endpoint,status,reserved,created_at,upstream_name,tier_snapshot,route_mode,upstream_estimate,request_method,stage)
      VALUES(?,?,?,'pending',0,?,'',?,'',0,?,'入口校验')`).run(id, key?.id ?? null, endpoint, Date.now(), key?.tier ?? '', method);
    // Persist early failures, but publish only after routing or a terminal outcome.
  }
  requestStage(id, stage, model = null) {
    this.db.prepare("UPDATE jobs SET stage=?,model=COALESCE(?,model) WHERE id=? AND status='pending'").run(stage, model, id);
  }
  finishPending(id, note, responseStatus, cancelled = false) {
    const result = this.db.prepare(`UPDATE jobs SET status=?,note=?,response_status=?,charged=0,stamina_charged=0,finished_at=?
      WHERE id=? AND status='pending'`).run(cancelled ? 'cancelled' : 'failed', note, responseStatus, Date.now(), id);
    if (result.changes) this.onChange?.();
    return !!result.changes;
  }
  clientDisconnected(id) {
    this.db.prepare("UPDATE jobs SET client_disconnected_at=? WHERE id=? AND status IN ('pending','running')").run(Date.now(), id);
    this.onChange?.();
  }
  reserve(keyId, id, endpoint, model, amount, idempotency, upstreamId, { mode = 'pool', upstreamEstimate = 0, stamina = 0 } = {}) {
    this.transaction(() => {
      const key = this.usableKey(keyId); integer(amount, 0, 1_000_000_000);
      assert(key.balance - key.reserved >= amount, `Anlas 不足，本次需要预留 ${amount} Anlas`, 402);
      integer(stamina,0,100,'预留体力');
      assert(stamina === 0 || key.tier === 'member' && stamina === 100, '体力预留无效');
      assert(availableStamina(key) >= stamina, '本地体力不足，请重新查询额度', 409);
      const selected = this.upstream(upstreamId ?? -1);
      assert(selected?.enabled, '选定上游已停用，请重新查询额度', 409);
      if (idempotency) assert(!this.db.prepare('SELECT id FROM jobs WHERE key_id=? AND idempotency=?').get(keyId, idempotency), '该请求已受理，请勿重复提交', 409);
      const existing = this.db.prepare('SELECT status FROM jobs WHERE id=?').get(id);
      assert(!existing || existing.status === 'pending', '请求已结束', 499);
      this.db.prepare(`INSERT INTO jobs(id,key_id,endpoint,model,status,reserved,created_at,idempotency,upstream_id,upstream_name,tier_snapshot,route_mode,upstream_estimate,stamina_reserved)
        VALUES(?,?,?,?,'running',?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        model=excluded.model,status='running',reserved=excluded.reserved,idempotency=excluded.idempotency,
        upstream_id=excluded.upstream_id,upstream_name=excluded.upstream_name,tier_snapshot=excluded.tier_snapshot,
        route_mode=excluded.route_mode,upstream_estimate=excluded.upstream_estimate,stamina_reserved=excluded.stamina_reserved,stage='上游执行'`)
        .run(id,keyId,endpoint,model,amount,Date.now(),idempotency,upstreamId,selected.name,key.tier,mode,upstreamEstimate,stamina);
      this.db.prepare('UPDATE keys SET reserved=reserved+?,stamina_reserved=stamina_reserved+?,last_used_at=? WHERE id=?').run(amount,stamina,Date.now(),keyId);
    });
  }
  settle(id, charged, status, note, http = null) {
    this.transaction(() => {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      assert(job?.status === 'running', '任务已经结算或不存在', 409);
      assert(['completed', 'failed'].includes(status), '任务只能按成功或失败结算');
      assert(charged === (status === 'completed' ? job.reserved : 0), '成功按本地报价结算，失败释放全部预留');
      const staminaCharged = status === 'completed' ? job.stamina_reserved : 0;
      if (job.client_disconnected_at) note += '；客户端已断开连接，按上游结果结算';
      this.db.prepare('UPDATE keys SET reserved=reserved-?,balance=balance-?,stamina_reserved=stamina_reserved-?,stamina_balance=stamina_balance-? WHERE id=?').run(job.reserved,charged,job.stamina_reserved,staminaCharged,job.key_id);
      this.db.prepare('UPDATE jobs SET status=?,charged=?,upstream_spent=?,http_status=?,note=?,finished_at=?,stamina_charged=? WHERE id=?').run(status,charged,status === 'completed' ? job.upstream_estimate : 0,http,note,Date.now(),staminaCharged,id);
      if (charged > 0) this.db.prepare('INSERT INTO ledger(key_id,delta,kind,note,job_id,created_at) VALUES(?,?,?,?,?,?)').run(job.key_id, -charged, 'usage', note, id, Date.now());
    });
  }
  fail(id, note, http = null) {
    if (this.db.prepare("SELECT id FROM jobs WHERE id=? AND status='running'").get(id)) this.settle(id, 0, 'failed', note, http);
  }
  jobs(limit = 100, keyId = null, status = 'all') {
    const statuses = jobStatuses(status);
    const query = `SELECT jobs.*,keys.name AS key_name,keys.prefix AS key_prefix FROM jobs LEFT JOIN keys ON keys.id=jobs.key_id
      WHERE jobs.status!='pending' AND (? IS NULL OR jobs.key_id=?) AND (? IS NULL OR jobs.status IN (SELECT value FROM json_each(?)))
      ORDER BY jobs.rowid DESC LIMIT ?`;
    return this.db.prepare(query).all(keyId, keyId, statuses, statuses, limit);
  }
  searchJobs(query, limit = 100, status = 'all') {
    const statuses = jobStatuses(status);
    if (!query.trim()) return this.jobs(limit, null, status);
    const ids = this.searchKeys(query.trim(), { includeRetired: true });
    if (!ids.length) return [];
    return this.db.prepare(`SELECT jobs.*,keys.name AS key_name,keys.prefix AS key_prefix FROM jobs JOIN keys ON keys.id=jobs.key_id
      WHERE jobs.status!='pending' AND jobs.key_id IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR jobs.status IN (SELECT value FROM json_each(?)))
      ORDER BY jobs.rowid DESC LIMIT ?`).all(JSON.stringify(ids), statuses, statuses, limit);
  }
  saveJobDiagnostics(id, { request = null, upstreamError = null, failure = null, contentType = null } = {}) {
    this.db.prepare(`INSERT INTO job_diagnostics(job_id,request_json,upstream_error,failure_detail,response_content_type) VALUES(?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET request_json=COALESCE(excluded.request_json,request_json),
      upstream_error=COALESCE(excluded.upstream_error,upstream_error),failure_detail=COALESCE(excluded.failure_detail,failure_detail),
      response_content_type=COALESCE(excluded.response_content_type,response_content_type)`)
      .run(id, request === null ? null : JSON.stringify(request), upstreamError, failure, contentType);
  }
  jobDiagnostics(id) { return this.db.prepare('SELECT * FROM job_diagnostics WHERE job_id=?').get(id) ?? null; }
  ledger(limit = 100) { return this.db.prepare('SELECT ledger.*,keys.name AS key_name FROM ledger JOIN keys ON keys.id=ledger.key_id WHERE ledger.delta != 0 ORDER BY ledger.id DESC LIMIT ?').all(limit); }
  close() { this.db.close(); }
}
