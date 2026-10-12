import { mkdirSync, copyFileSync, constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert } from './security.mjs';
import { capacityFor, dailyFor, refillPeriod } from './stamina.mjs';

export const KEY_COLUMNS = `
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

// Called synchronously before the HTTP server starts. The marker and all schema/data changes commit together.
export function migrateLocalStamina(db, directory, now = Date.now()) {
  if (db.prepare("SELECT value FROM settings WHERE name='local_stamina_created_v2'").get()) return;
  const columns = db.prepare('PRAGMA table_info(keys)').all();
  const legacy = columns.some(c => c.name === 'nai5_upstream_id');
  const fixedSchedule = columns.some(c => c.name === 'stamina_refill_day');
  if (legacy || fixedSchedule) {
    const backup = join(directory, 'backups', `local-stamina-v2-${now}-${randomUUID()}`);
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    copyFileSync(join(directory, 'master.key'), join(backup, 'master.key'), constants.COPYFILE_EXCL);
    // Produces a consistent SQLite snapshot, including committed WAL content.
    db.prepare('VACUUM INTO ?').run(join(backup, 'relay.sqlite'));
  }
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    if (legacy || fixedSchedule) {
      const rows = db.prepare('SELECT * FROM keys ORDER BY id').all();
      db.exec(`CREATE TABLE keys_local_stamina (${KEY_COLUMNS})`);
      const insert = db.prepare(`INSERT INTO keys_local_stamina
        (id,name,token_hash,prefix,balance,reserved,token_encrypted,tier,expires_at,enabled,created_at,last_used_at,retired_at,
         stamina_capacity,stamina_balance,stamina_reserved,stamina_refill_period) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const row of rows) {
        const capacity = legacy ? (row.tier === 'member' && row.retired_at === null ? capacityFor(row.balance > 5000 ? 100 : 25) : 0) : row.stamina_capacity;
        // Existing local balances survive a schedule-only upgrade. Mark every past creation cycle as handled.
        const balance = legacy ? dailyFor(capacity) : row.stamina_balance;
        const reserved = legacy ? 0 : row.stamina_reserved;
        insert.run(row.id,row.name,row.token_hash,row.prefix,row.balance,row.reserved,row.token_encrypted,row.tier,
          row.expires_at,row.enabled,row.created_at,row.last_used_at,row.retired_at,capacity,balance,reserved,refillPeriod(row.created_at,now));
      }
      // Keep child-table references pointing to keys: never rename the old parent first.
      db.exec('DROP TABLE keys; ALTER TABLE keys_local_stamina RENAME TO keys');
    }
    const jobs = db.prepare('PRAGMA table_info(jobs)').all();
    if (!jobs.some(c => c.name === 'stamina_reserved')) db.exec('ALTER TABLE jobs ADD COLUMN stamina_reserved INTEGER NOT NULL DEFAULT 0');
    if (!jobs.some(c => c.name === 'stamina_charged')) db.exec('ALTER TABLE jobs ADD COLUMN stamina_charged INTEGER');
    if (db.prepare('PRAGMA table_info(upstreams)').all().some(c => c.name === 'exclusive')) db.exec('ALTER TABLE upstreams DROP COLUMN exclusive');
    assert(db.prepare('PRAGMA foreign_key_check').all().length === 0, '体力迁移外键校验失败，已回滚', 500);
    db.prepare("INSERT OR IGNORE INTO settings(name,value) VALUES('local_stamina_v1',?)").run(String(now));
    db.prepare("INSERT INTO settings(name,value) VALUES('local_stamina_created_v2',?)").run(String(now));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally { db.exec('PRAGMA foreign_keys=ON'); }
}
