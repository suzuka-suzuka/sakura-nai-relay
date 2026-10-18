// One shared publisher per process; backpressure retains only the latest event of each kind.
export function adminEvents({ snapshot, session, quota }) {
  const clients = new Map();
  let updateTimer, heartbeat, quotaTimer, quotaPending = null, quotaAgain = false, closed = false, latestQuota = null;
  const write = (res, event, data) => {
    if (res.destroyed || res.writableEnded) return;
    const client = clients.get(res);
    if (!client) return;
    if (client.blocked) { client.pending.set(event, data); return; }
    if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
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
    const data = snapshot(), encoded = JSON.stringify(data);
    for (const [res, client] of clients) {
      if (valid(res, client) && client.snapshot !== encoded) {
        client.snapshot = encoded; write(res, 'snapshot', data);
      }
    }
  }
  function changed() {
    if (!closed && clients.size && !updateTimer) updateTimer = setTimeout(publish, 50);
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
    connect(req, res, adminSession) {
      if (closed) { res.writeHead(503); res.end(); return; }
      const data = snapshot();
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders(); res.write('retry: 3000\n\n');
      const client = { req, snapshot: JSON.stringify(data), pending: new Map(), blocked: false };
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
