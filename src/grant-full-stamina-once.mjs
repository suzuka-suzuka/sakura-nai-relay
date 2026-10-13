import { DAY_MS } from './stamina.mjs';

export const FULL_STAMINA_GRANT = 'full_stamina_grant_20261013_v1';

// Run before accepting requests. Credit and completion marker must commit together.
export function grantFullStaminaOnce(db, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    let count = 0;
    if (!db.prepare('SELECT value FROM settings WHERE name=?').get(FULL_STAMINA_GRANT)) {
      count = db.prepare(`UPDATE keys SET stamina_balance=stamina_capacity,
        stamina_refill_period=MAX(stamina_refill_period,CAST(MAX(0,?-created_at)/? AS INTEGER))
        WHERE tier='member' AND retired_at IS NULL`).run(now, DAY_MS).changes;
      db.prepare('INSERT INTO settings(name,value) VALUES(?,?)').run(FULL_STAMINA_GRANT, String(now));
    }
    db.exec('COMMIT');
    return count;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
