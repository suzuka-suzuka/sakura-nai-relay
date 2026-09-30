import { assert } from './security.mjs';
import { SerialQueue } from './queue.mjs';

/** Prefer idle accounts, then shortest queues; round-robin ties within each pool. */
export class UpstreamRouter {
  constructor(store) {
    this.store = store;
    this.cursors = new Map();
    this.busy = new Set(); this.activeKeys = new Set();
    this.keyQueue = new SerialQueue(); this.upstreamQueue = new SerialQueue();
    this.cooldowns = new Map();
  }
  rows() { return this.store.upstreams(); }
  status(row) {
    const cooling = this.cooldowns.get(row.id);
    return { ...row, busy: this.busy.has(row.id), queued: Math.max(0, this.upstreamQueue.size(row.id) - 1), cooldownUntil: cooling?.until > Date.now() ? cooling.until : null,
      error: cooling?.until > Date.now() ? cooling.error : null };
  }
  available() {
    const enabled = this.rows().filter(r => r.enabled);
    assert(enabled.length, '没有启用的上游，请在后台添加或启用 Key', 503);
    const healthy = enabled.filter(r => !(this.cooldowns.get(r.id)?.until > Date.now()));
    assert(healthy.length, '可用上游均在冷却中，请稍后重试', 503);
    return healthy;
  }
  pick(excluded = new Set(), pool = null) {
    const rows = this.available().filter(r => !excluded.has(r.id) && (!pool || pool.ids.has(r.id)));
    if (!rows.length) return null;
    const length = Math.min(...rows.map(r => this.upstreamQueue.size(r.id)));
    const candidates = rows.filter(r => this.upstreamQueue.size(r.id) === length).sort((a, b) => a.id - b.id);
    const last = this.cursors.get(pool?.scope ?? 'pool') ?? 0;
    return candidates.find(r => r.id > last) ?? candidates[0];
  }
  assertAvailable(id) {
    const row = this.store.upstream(id);
    assert(row?.enabled, '绑定或选定上游已停用或移除', 503);
    assert(!(this.cooldowns.get(id)?.until > Date.now()), '绑定或选定上游正在冷却，请稍后重试', 503);
    return row;
  }
  async lockKey(id, signal) {
    const unlock = await this.keyQueue.enter(id, signal); this.activeKeys.add(id);
    return () => { this.activeKeys.delete(id); unlock(); };
  }
  async lockUpstream(id, signal) {
    const unlock = await this.upstreamQueue.enter(id, signal); this.busy.add(id);
    return () => { this.busy.delete(id); unlock(); };
  }
  commit(id, pool = null) {
    // Advance only when dispatching generation, so reads and skipped accounts do not consume turns.
    this.cursors.set(pool?.scope ?? 'pool', id);
  }
  failed(id, error, seconds = 30) { this.cooldowns.set(id, { until: Date.now() + seconds * 1000, error }); }
  reset(id) { this.cooldowns.delete(id); }
  close() { this.keyQueue.close(); this.upstreamQueue.close(); }
}
