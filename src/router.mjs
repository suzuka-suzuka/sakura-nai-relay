import { assert } from './security.mjs';

/** Smooth weighted round-robin; reads never advance scheduling. */
export class UpstreamRouter {
  constructor(store) {
    this.store = store;
    this.currents = new Map(); this.busy = new Set(); this.activeKeys = new Set();
    this.leases = new Map(); this.cooldowns = new Map(); this.signature = '';
  }
  rows() {
    const rows = this.store.upstreams(), signature = rows.map(r => `${r.id}:${r.weight}:${r.enabled}`).join('|');
    if (signature !== this.signature) { this.currents.clear(); this.signature = signature; }
    return rows;
  }
  status(row) {
    const cooling = this.cooldowns.get(row.id);
    return { ...row, busy: this.busy.has(row.id), cooldownUntil: cooling?.until > Date.now() ? cooling.until : null,
      error: cooling?.until > Date.now() ? cooling.error : null };
  }
  available(includeBusy = false) {
    assert(!this.store.hasOrphanReview(), '有旧请求待核对，请先完成结算', 409);
    const enabled = this.rows().filter(r => r.enabled && r.weight > 0);
    assert(enabled.length, '没有启用的上游，请在后台添加或启用 Key', 503);
    const healthy = enabled.filter(r => !r.reviews && !(this.cooldowns.get(r.id)?.until > Date.now()));
    assert(healthy.length, '可用上游均待核对或冷却中，请稍后重试', enabled.some(r => r.reviews) ? 409 : 503);
    const ready = healthy.filter(r => includeBusy || !this.busy.has(r.id));
    assert(ready.length, '上游正在生成，请稍后重试', 429);
    return ready;
  }
  best(rows) { return rows.reduce((a, b) => (this.currents.get(b.id) ?? 0) + b.weight > (this.currents.get(a.id) ?? 0) + a.weight ? b : a); }
  lease(keyId, includeBusy = false) {
    for (const [key, value] of this.leases) if (value.until < Date.now() && !this.activeKeys.has(key)) this.leases.delete(key);
    const previous = this.leases.get(keyId);
    if (previous) {
      const row = this.rows().find(r => r.id === previous.id);
      if (row?.enabled && row.weight > 0 && !row.reviews && !(this.cooldowns.get(row.id)?.until > Date.now())) return row;
      this.leases.delete(keyId);
    }
    const candidates = this.available(includeBusy), idle = candidates.filter(r => !this.busy.has(r.id));
    const row = this.best(idle.length ? idle : candidates);
    this.leases.set(keyId, { id: row.id, until: Date.now() + 30000 });
    return row;
  }
  query(keyId) { return this.lease(keyId, true); }
  acquire(keyId) {
    assert(!this.activeKeys.has(keyId), '此访问密钥已有进行中的请求', 429);
    const row = this.lease(keyId);
    assert(!this.busy.has(row.id), '已查询额度的上游正在生成，请稍后重试', 429);
    this.busy.add(row.id); this.activeKeys.add(keyId);
    return { id: row.id, name: row.name, token: this.store.upstreamToken(row.id) };
  }
  commit(id) {
    const rows = this.rows().filter(r => r.enabled && r.weight > 0 && !r.reviews && !(this.cooldowns.get(r.id)?.until > Date.now()));
    for (const row of rows) this.currents.set(row.id, (this.currents.get(row.id) ?? 0) + row.weight);
    this.currents.set(id, (this.currents.get(id) ?? 0) - rows.reduce((n, r) => n + r.weight, 0));
  }
  release(keyId, id) { this.busy.delete(id); this.activeKeys.delete(keyId); this.leases.delete(keyId); }
  failed(id, error, seconds = 30) { this.cooldowns.set(id, { until: Date.now() + seconds * 1000, error }); }
  reset(id) { this.cooldowns.delete(id); }
}
