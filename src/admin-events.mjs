const ROW_COLLECTIONS = new Set(['keys', 'upstreams', 'jobs', 'ledger']);

// Rows are replaced by ID; unchanged collections do not travel over the wire.
export function snapshotPatch(previous, next) {
  const values = {}, collections = {};
  for (const [field, value] of Object.entries(next)) {
    if (JSON.stringify(previous[field]) === JSON.stringify(value)) continue;
    if (!ROW_COLLECTIONS.has(field)) { values[field] = value; continue; }
    const before = previous[field] ?? [], old = new Map(before.map(row => [row.id, JSON.stringify(row)]));
    const ids = value.map(row => row.id), keep = new Set(ids);
    const change = {
      upsert: value.filter(row => old.get(row.id) !== JSON.stringify(row)),
      remove: before.filter(row => !keep.has(row.id)).map(row => row.id),
    };
    if (JSON.stringify(before.map(row => row.id)) !== JSON.stringify(ids)) change.order = ids;
    collections[field] = change;
  }
  return Object.keys(values).length || Object.keys(collections).length ? { values, collections } : null;
}

// Backpressure retains latest target snapshots, never drops an intermediate delta.
export function adminEvents({ snapshot, session, quota }) {
  const clients = new Map();
  let updateTimer, heartbeat, quotaTimer, quotaPending = null, quotaAgain = false, closed = false, latestQuota = null;
  const write = (res, event, data) => {
    if (res.destroyed || res.writableEnded) return;
    const client = clients.get(res);
    if (!client) return;
    if (client.blocked) { client.pending.set(event, data); return; }
    let payload = data, kind = event;
    if (event === 'snapshot') {
      if (client.snapshot) {
        if (client.delta) {
          payload = snapshotPatch(client.snapshot, data);
          if (!payload) return;
          kind = 'patch';
        } else if (JSON.stringify(client.snapshot) === JSON.stringify(data)) return;
      }
      // res.write accepts the frame even when it returns false. Advance only here,
      // so the next delta is based on data actually queued for this connection.
      client.snapshot = data;
    } else if (event === 'quota') {
      const { fetchedAt, ...content } = data;
      const encoded = JSON.stringify(content);
      if (client.quota === encoded) return;
      client.quota = encoded;
    }
    if (!res.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`)) {
      client.blocked = true;
      client.slowTimer = setTimeout(() => res.destroy(), 30000);
      res.once('drain', () => {
        clearTimeout(client.slowTimer); client.blocked = false;
        if (clients.get(res) !== client) return;
        const pending = [...client.pending]; client.pending.clear();
        for (const [event, data] of pending) write(res, event, data);
      });
    }
  };
  const valid = (res, client) => {
    try { session(client.req); return true; }
    catch { write(res, 'session-expired', {}); res.end(); remove(res); return false; }
  };
  function remove(res) {
    const client = clients.get(res); clearTimeout(client?.expiryTimer); clearTimeout(client?.slowTimer); clients.delete(res);
    if (!clients.size) {
      clearInterval(heartbeat); clearInterval(quotaTimer); clearTimeout(updateTimer); updateTimer = null;
    }
  }
  function publish() {
    clearTimeout(updateTimer);
    updateTimer = null;
    if (closed || !clients.size) return;
    const data = snapshot();
    for (const [res, client] of clients) {
      if (valid(res, client)) write(res, 'snapshot', data);
    }
  }
  function changed() {
    if (!closed && clients.size && !updateTimer) updateTimer = setTimeout(publish, 500);
  }
  async function refreshQuota() {
    if (closed || !clients.size) return;
    if (quotaPending) { quotaAgain = true; return quotaPending; }
    quotaPending = (async () => {
      try {
        latestQuota = await quota();
        if (!closed) for (const [res, client] of clients) if (valid(res, client)) write(res, 'quota', latestQuota);
      } catch { /* The next shared refresh retries without interrupting local data. */ }
    })();
    try { await quotaPending; }
    finally {
      quotaPending = null;
      if (quotaAgain) { quotaAgain = false; void refreshQuota(); }
    }
  }
  return {
    changed, refreshQuota,
    revalidate() { for (const [res, client] of clients) valid(res, client); },
    connect(req, res, adminSession, { delta = false } = {}) {
      if (closed) { res.writeHead(503); res.end(); return; }
      const data = snapshot();
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders(); res.write('retry: 3000\n\n');
      const client = { req, delta, snapshot: null, pending: new Map(), blocked: false };
      clients.set(res, client);
      res.once('close', () => remove(res));
      client.expiryTimer = setTimeout(() => valid(res, client), Math.max(1, adminSession.expires - Date.now()));
      write(res, 'snapshot', data);
      if (latestQuota) write(res, 'quota', latestQuota);
      if (clients.size === 1) {
        // Reconcile time-based stamina refills, expiry, cooldowns and daily charts.
        heartbeat = setInterval(() => {
          publish();
          for (const [res, client] of clients) if (!client.blocked && !res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
        }, 15000);
        quotaTimer = setInterval(() => { void refreshQuota(); }, 30000);
        void refreshQuota();
      }
    },
    async close() {
      closed = true; clearTimeout(updateTimer); clearInterval(heartbeat); clearInterval(quotaTimer);
      for (const res of clients.keys()) { res.end(); remove(res); }
      await quotaPending;
    },
  };
}
