import { createServer } from 'node:http';
import { readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Store } from './db.mjs';
import { HttpError, assert, integer, hash, random, equal, passwordHash, verifyPassword } from './security.mjs';
import { balanceOf, upstreamSubscription, downstreamSubscription, billingAccount, isActiveOpus, hasNai5Allowance, isNai5Generation, reservation, StreamCheck } from './billing.mjs';
import { upstreamClient, readBounded } from './upstream.mjs';
import { UpstreamRouter } from './router.mjs';
import { imageSize, base64Size } from './image-size.mjs';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const PAID = new Set(['/ai/generate-image', '/ai/generate-image-stream', '/ai/encode-vibe', '/ai/augment-image', '/ai/upscale']);
const MAX_BODY = 32 * 1024 * 1024;
const json = (res, status, data) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
async function readBody(req, max) {
  if (Number(req.headers['content-length']) > max) throw new HttpError(413, '请求内容过大');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; assert(size <= max, '请求内容过大', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function parse(bytes) { try { const value = JSON.parse(bytes.toString()); assert(value && typeof value === 'object' && !Array.isArray(value), '需要 JSON 对象'); return value; } catch { throw new HttpError(400, 'JSON 格式无效'); } }
const label = (value, max = 64) => { assert(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, `请输入 1–${max} 字的名称或备注`); return value.trim(); };
const cookieToken = (req) => req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('sakura_session='))?.slice(15);

export function createApp(config) {
  const store = new Store(config.dataDir), upstream = upstreamClient(config.upstreamOrigin ?? 'https://image.novelai.net', config.fetcher);
  const router = new UpstreamRouter(store), editingUpstreams = new Set();
  const limits = new Map();
  const allow = (id, max, period = 60000) => {
    const now = Date.now();
    for (const [key, val] of limits) if (val.until < now) limits.delete(key);
    const state = limits.get(id) ?? { until: now + period, count: 0 }; state.count++; limits.set(id, state);
    assert(state.count <= max, '操作太频繁，请稍后再试', 429);
  };
  const options = () => ({
    configured: store.upstreams().length > 0,
    origins: JSON.parse(store.get('origins') ?? '["http://127.0.0.1:3000","http://localhost:3000"]'),
    enabled: store.get('enabled') !== 'false',
  });
  const session = (req) => {
    const token = cookieToken(req);
    const s = token && store.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires>?').get(hash(token), Date.now());
    assert(s, '请先登录控制台', 401); return s;
  };
  function issueSession(res) {
    const token = random(), csrf = random();
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), csrf, Date.now() + 12 * 3600000);
    res.setHeader('Set-Cookie', `sakura_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${config.cookieSecure ? '; Secure' : ''}`);
    return csrf;
  }
  async function autoBindMember() {
    const rows = router.available().filter(row => !editingUpstreams.has(row.id));
    const candidates = []; let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(rows.length, 4) }, async () => {
      while (cursor < rows.length) {
        const row = rows[cursor++], tokenHash = store.upstream(row.id)?.token_hash;
        try {
          const data = await upstream.subscription(store.upstreamToken(row.id));
          if (isActiveOpus(data) && Number.isFinite(data.usage?.percent) && typeof data.usage?.isNegative === 'boolean')
            candidates.push({ id: row.id, percent: hasNai5Allowance(data) ? Math.max(0, Math.min(100, data.usage.percent)) : 0, tokenHash });
        } catch { /* Failed queries are not eligible for automatic binding. */ }
      }
    }));
    const available = new Set(router.available().filter(row => !editingUpstreams.has(row.id)).map(row => row.id));
    const selected = candidates.filter(row => available.has(row.id) && store.upstream(row.id)?.token_hash === row.tokenHash)
      .sort((a, b) => b.percent - a.percent || a.id - b.id)[0];
    assert(selected, '没有可绑定的有效 Opus 上游，请检查账户状态或额度查询', 503);
    return selected.id;
  }
  async function admin(req, res, path) {
    if (req.method !== 'GET') assert(req.headers.origin === config.publicOrigin, '请求来源不匹配，请检查 PUBLIC_ORIGIN', 403);
    if (path === '/admin/api/status' && req.method === 'GET') {
      let loggedIn = false, csrf = null;
      try { const s = session(req); loggedIn = true; csrf = s.csrf; } catch { /* Anonymous status. */ }
      return json(res, 200, { initialized: !!store.get('admin_password'), loggedIn, csrf });
    }
    if (['/admin/api/setup', '/admin/api/login'].includes(path) && req.method === 'POST') {
      allow(`login:${req.socket.remoteAddress}`, 8, 10 * 60000);
      const body = parse(await readBody(req, 4096));
      if (path.endsWith('/setup')) {
        assert(!store.get('admin_password'), '管理员已初始化', 409);
        assert(typeof body.code === 'string' && equal(hash(body.code.trim()), store.get('setup_hash')), '初始化码不正确', 401);
        assert(typeof body.password === 'string' && body.password.length >= 12 && body.password.length <= 256, '管理员密码需为 12–256 个字符');
        store.transaction(() => { store.set('admin_password', passwordHash(body.password)); store.set('setup_hash', ''); });
        try { unlinkSync(join(config.dataDir, 'setup-code.txt')); } catch { /* Hash is already invalidated. */ }
      } else assert(verifyPassword(body.password, store.get('admin_password')), '密码不正确', 401);
      return json(res, 200, { csrf: issueSession(res) });
    }
    const s = session(req);
    if (req.method !== 'GET') assert(equal(req.headers['x-csrf-token'], s.csrf), '会话校验失败，请刷新页面', 403);
    if (path === '/admin/api/logout' && req.method === 'POST') {
      store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash);
      res.setHeader('Set-Cookie', 'sakura_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (path === '/admin/api/snapshot' && req.method === 'GET') {
      const stats = store.db.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(charged),0) AS spent, COALESCE(SUM(upstream_spent),0) AS upstreamSpent FROM jobs`).get();
      const trend = store.db.prepare("SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch','+8 hours') AS day, COUNT(*) AS requests,COALESCE(SUM(charged),0) AS spent,COALESCE(SUM(upstream_spent),0) AS upstreamSpent FROM jobs WHERE created_at>? GROUP BY day").all(Date.now() - 7 * 86400000);
      return json(res, 200, { settings: options(), upstreams: store.upstreams().map(r => router.status(r)), keys: store.keys(), jobs: store.jobs(), ledger: store.ledger(), stats, trend, busy: router.busy.size > 0, relayUrl: config.publicOrigin });
    }
    if (path === '/admin/api/quota' && req.method === 'GET') {
      allow('admin-quota', 20);
      const rows = store.upstreams(), results = new Array(rows.length); let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(rows.length, 4) }, async () => {
        while (cursor < rows.length) {
          const index = cursor++, row = rows[index];
          try {
            const data = await upstream.subscription(store.upstreamToken(row.id));
            results[index] = { id: row.id, name: row.name, enabled: !!row.enabled, ok: true, account: upstreamSubscription(data) };
          } catch { results[index] = { id: row.id, name: row.name, enabled: !!row.enabled, ok: false, error: '额度查询失败，请检查 Key 或稍后重试' }; }
        }
      }));
      return json(res, 200, { upstreams: results, totalAnlas: results.reduce((sum, r) => sum + (r.ok ? r.account.relay.balance : 0), 0), failed: results.filter(r => !r.ok).length, fetchedAt: Date.now() });
    }
    const upstreamMatch = /^\/admin\/api\/upstreams(?:\/(\d+))?$/.exec(path);
    if (upstreamMatch && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
      const id = upstreamMatch[1] ? Number(upstreamMatch[1]) : null;
      assert(req.method === 'POST' ? id === null : id !== null, '请求方法无效', 405);
      const previous = id === null ? null : store.upstream(id);
      if (id !== null) assert(previous, '上游不存在', 404);
      assert(id === null || !editingUpstreams.has(id), '上游正在保存，请稍后重试', 409);
      if (id !== null) editingUpstreams.add(id);
      try {
        if (req.method === 'DELETE') {
          assert(!router.busy.has(id) && !store.hasUnsettled(id), '该上游仍有进行中的请求，暂不能移除', 409);
          store.retireUpstream(id); router.reset(id);
          return json(res, 200, { ok: true });
        }
        const body = parse(await readBody(req, 16384));
        const name = label(body.name);
        assert(typeof body.enabled === 'boolean', '状态无效');
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        assert(id !== null || token, '请填写官方 Key');
        if (token) {
          assert(token.length <= 4096 && /^pst-\S+$/.test(token), '请输入有效的 NovelAI Persistent Token');
          assert(id === null || !router.busy.has(id) && !store.hasUnsettled(id), '请等待该上游请求结束，再更换 Key', 409);
          await upstream.subscription(token);
          assert(id === null || !router.busy.has(id) && !store.hasUnsettled(id), '该上游有请求正在执行，请稍后更换 Key', 409);
        }
        const savedId = store.transaction(() => {
          if (id === null) return store.addUpstream({ name, token, enabled: body.enabled });
          store.updateUpstream(id, { name, token, enabled: body.enabled }); return id;
        });
        if (token) router.reset(savedId);
        return json(res, id === null ? 201 : 200, { id: savedId });
      } finally { if (id !== null) editingUpstreams.delete(id); }
    }
    if (path === '/admin/api/settings' && req.method === 'PUT') {
      const body = parse(await readBody(req, 16384));
      assert(Array.isArray(body.origins) && body.origins.length <= 30, '允许的站点格式无效');
      const origins = [...new Set(body.origins.map(value => {
        let u; try { u = new URL(value); } catch { throw new HttpError(400, '站点地址无效'); }
        assert(['https:', 'http:'].includes(u.protocol) && u.origin === value && !u.username && !u.password, '请填写完整站点来源，不含路径');
        assert(u.protocol === 'https:' || ['localhost','127.0.0.1','[::1]'].includes(u.hostname), '非本机站点必须使用 HTTPS'); return value;
      }))];
      assert(typeof body.enabled === 'boolean', '运行状态无效');
      assert(!body.token, '请通过上游列表添加或编辑 Key');
      store.transaction(() => {
        store.set('origins', JSON.stringify(origins)); store.set('enabled', String(body.enabled));
      });
      return json(res, 200, { ok: true });
    }
    if (path === '/admin/api/keys' && req.method === 'POST') {
      const body = parse(await readBody(req, 4096));
      const name = label(body.name), points = integer(body.points, 0, 1_000_000_000);
      if (body.tier === 'member') body.upstreamId = await autoBindMember();
      return json(res, 201, store.createKey(name, points, body));
    }
    const secretMatch = /^\/admin\/api\/keys\/(\d+)\/reveal$/.exec(path);
    if (secretMatch && req.method === 'POST') {
      await readBody(req, 4096);
      return json(res, 200, store.revealKey(Number(secretMatch[1])));
    }
    const keyMatch = /^\/admin\/api\/keys\/(\d+)(\/points)?$/.exec(path);
    if (keyMatch && !keyMatch[2] && req.method === 'DELETE') {
      await readBody(req, 4096);
      const id = Number(keyMatch[1]); assert(store.key(id), '密钥不存在', 404);
      assert(!router.keyQueue.size(id), '请等待该密钥的生成和排队结束，再删除密钥', 409);
      store.retireKey(id);
      return json(res, 200, { ok: true });
    }
    if (keyMatch && req.method === 'POST') {
      const id = Number(keyMatch[1]), body = parse(await readBody(req, 4096));
      assert(store.key(id), '密钥不存在', 404);
      if (keyMatch[2]) store.adjust(id, integer(body.delta, -1_000_000_000, 1_000_000_000), label(body.note, 160));
      else {
        if (body.name !== undefined) body.name = label(body.name);
        if (body.tier !== undefined || body.upstreamId !== undefined)
          assert(!router.keyQueue.size(id), '请等待该密钥的生成和排队结束，再修改等级或绑定', 409);
        store.updateKey(id, body);
      }
      return json(res, 200, { ok: true });
    }
    if (path === '/admin/api/password' && req.method === 'POST') {
      allow(`password:${req.socket.remoteAddress}`, 5, 10 * 60000);
      const body = parse(await readBody(req, 4096));
      assert(verifyPassword(body.current, store.get('admin_password')), '当前密码不正确', 401);
      assert(typeof body.password === 'string' && body.password.length >= 12 && body.password.length <= 256, '新密码需为 12–256 个字符');
      store.transaction(() => { store.set('admin_password', passwordHash(body.password)); store.db.exec('DELETE FROM sessions'); });
      return json(res, 200, { csrf: issueSession(res) });
    }
    throw new HttpError(404, '管理接口不存在');
  }

  async function selectUpstream(path, body, keyId, signal) {
    const key = store.usableKey(keyId);
    let account = billingAccount(key), mode = key.tier === 'member' ? 'anlas-pool' : 'pool';
    const requireAnlas = key.tier === 'member';
    let exhaustedNai5 = false;
    const inspect = async id => {
      const unlock = await router.lockUpstream(id, signal);
      try {
        assert(!signal.aborted, '请求已取消', 499);
        store.usableKey(keyId);
        const row = router.assertAvailable(id);
        assert(!editingUpstreams.has(id), '选定上游正在更新，请稍后重试', 503);
        const token = store.upstreamToken(id);
        let subscription;
        try { subscription = await upstream.subscription(token); }
        catch (error) { router.failed(id, '上游账户查询失败'); throw error; }
        return { id, name: row.name, token, subscription, unlock };
      } catch (error) { unlock(); throw error; }
    };
    // Only a free V5 request uses the binding. Paid requests retain the binding's local entitlement but use a pool.
    if (key.tier === 'member' && isNai5Generation(path, body)) {
      const selected = await inspect(key.nai5_upstream_id);
      try {
        account = billingAccount(key, selected.subscription);
        exhaustedNai5 = !hasNai5Allowance(selected.subscription);
        const amount = reservation(path, body, account);
        if (!exhaustedNai5 && amount === 0)
          return { ...selected, amount, upstreamEstimate: reservation(path, body, selected.subscription), mode: 'nai5-bound' };
      } catch (error) { selected.unlock(); throw error; }
      selected.unlock();
      if (exhaustedNai5) mode = 'nai5-paid-pool';
    }
    const amount = reservation(path, body, account);
    const current = store.usableKey(keyId);
    assert(current.balance - current.reserved >= amount, `Anlas 不足，本次需要 ${amount} Anlas`, 402);
    let lastError = null, pools = [null];
    if (key.tier === 'member') {
      // Read-only discovery does not occupy generation slots. Recheck under the selected account's lock below.
      const rows = router.available(); let cursor = 0;
      const freePool = { scope: 'free', ids: new Set(), mode: exhaustedNai5 ? 'nai5-stamina-pool' : 'opus-pool' };
      const anlasPool = { scope: 'anlas', ids: new Set(), mode };
      const preferFree = amount === 0 || exhaustedNai5;
      pools = preferFree ? [freePool, anlasPool] : [anlasPool];
      await Promise.all(Array.from({ length: Math.min(rows.length, 4) }, async () => {
        while (cursor < rows.length && !signal.aborted) {
          const row = rows[cursor++];
          if (editingUpstreams.has(row.id)) continue;
          try {
            const subscription = await upstream.subscription(store.upstreamToken(row.id));
            const estimate = reservation(path, body, subscription), balance = balanceOf(subscription);
            if (preferFree && isActiveOpus(subscription) && estimate === 0) freePool.ids.add(row.id);
            if (balance > 0 && balance >= estimate) anlasPool.ids.add(row.id);
          } catch (error) { router.failed(row.id, '上游账户查询失败'); lastError = error; }
        }
      }));
      assert(!signal.aborted, '请求已取消', 499);
      store.usableKey(keyId);
    }
    for (const pool of pools) {
      const excluded = new Set();
      while (excluded.size < store.upstreams().length) {
        let row;
        try { row = router.pick(excluded, pool); } catch (error) { if (lastError) throw lastError; throw error; }
        if (!row) break;
        excluded.add(row.id);
        let selected;
        try { selected = await inspect(row.id); }
        catch (error) {
          if (signal.aborted || error.status === 401 || error.code === 'KEY_EXPIRED') throw error;
          pool?.ids.delete(row.id);
          lastError = error; continue;
        }
        try {
          const upstreamEstimate = reservation(path, body, selected.subscription), balance = balanceOf(selected.subscription);
          const funded = balance > 0 && balance >= upstreamEstimate;
          const usable = pool?.scope === 'free' ? isActiveOpus(selected.subscription) && upstreamEstimate === 0
            : requireAnlas ? funded : balance >= upstreamEstimate;
          if (usable) return { ...selected, amount, upstreamEstimate, mode: pool?.mode ?? mode, pool };
          // Free eligibility can disappear while queued; the refreshed account may still join the funded pool.
          if (pool?.scope === 'free') {
            const anlasPool = pools.find(p => p?.scope === 'anlas');
            if (funded) anlasPool.ids.add(row.id); else anlasPool.ids.delete(row.id);
          }
        } catch (error) { selected.unlock(); throw error; }
        pool?.ids.delete(row.id);
        selected.unlock();
      }
    }
    if (lastError) throw lastError;
    throw new HttpError(503, '账号池没有余额足够的可用上游，请联系管理员补充 Anlas');
  }

  async function paid(req, res, path, key) {
    const waiting = new AbortController();
    const onClose = () => waiting.abort(); res.once('close', onClose);
    let jobId = null, status = null, selected = null, unlockKey = null;
    try {
      const raw = await readBody(req, MAX_BODY), type = req.headers['content-type'] ?? '';
      let body, payload = raw;
      if (path === '/ai/upscale' && type.startsWith('multipart/form-data')) {
        const form = await new Response(raw, { headers: { 'Content-Type': type } }).formData();
        const image = form.get('image'), request = form.get('request');
        assert(image instanceof Blob && image.size > 0 && request instanceof Blob, '放大请求缺少图片或参数');
        body = parse(Buffer.from(await request.arrayBuffer()));
        assert(body.image === 'image' && body.model === 'nai-diffusion-5-curated', '放大参数无效');
        Object.assign(body, imageSize(Buffer.from(await image.arrayBuffer())));
      } else {
        assert(type.startsWith('application/json'), '需要 JSON 或受支持的放大表单', 415);
        body = parse(raw);
        if (path === '/ai/upscale') {
          assert(body.model === 'nai-diffusion-5-curated', '放大参数无效');
          Object.assign(body, base64Size(body.image));
        }
        if (path === '/ai/augment-image') {
          const size = base64Size(body.image);
          assert(body.width === size.width && body.height === size.height, '声明尺寸与实际图片尺寸不符');
        }
      }
      // Drain uploads before queueing so the request-body timeout never includes queue wait.
      unlockKey = await router.lockKey(key.id, waiting.signal);
      // Validate the complete body before querying or occupying any upstream account.
      reservation(path, body, billingAccount(store.usableKey(key.id)));
      const idempotency = req.headers['idempotency-key'] ?? null;
      assert(idempotency === null || typeof idempotency === 'string' && idempotency.length <= 128 && /^[\w-]+$/.test(idempotency), 'Idempotency-Key 格式无效');
      if (idempotency) assert(!store.db.prepare('SELECT id FROM jobs WHERE key_id=? AND idempotency=?').get(key.id, idempotency), '该请求已受理，请勿重复提交', 409);
      selected = await selectUpstream(path, body, key.id, waiting.signal);
      assert(!waiting.signal.aborted, '请求已取消', 499);
      assert(options().enabled, '中转已暂停', 503);
      const { token, amount, upstreamEstimate, mode } = selected;
      const id = random().slice(0, 18);
      store.reserve(key.id, id, path, body.model ?? body.req_type ?? 'image-tool', amount, idempotency, selected.id, { mode, upstreamEstimate });
      jobId = id;
      res.setHeader('X-Request-Id', id);
      if (mode !== 'nai5-bound') router.commit(selected.id, selected.pool);
      const streaming = path.endsWith('-stream');
      if (streaming) { body.parameters.stream = 'sse'; payload = Buffer.from(JSON.stringify(body)); }
      const response = await upstream.request(path, token, { method: 'POST', headers: { 'Content-Type': type, Accept: streaming ? 'text/event-stream' : req.headers.accept ?? 'application/zip, application/json' }, body: payload });
      status = response.status;
      if (!response.ok) {
        await readBounded(response, 1024 * 1024); // Never expose upstream error bodies or secrets.
        if (status === 429) {
          store.fail(id, '上游限流，未扣 Anlas', status);
          router.failed(selected.id, '上游限流，稍后自动参与路由', 3);
          res.setHeader('Retry-After', '3');
          return json(res, 429, { error: '上游限流，请稍后重试', requestId: id });
        }
        if (status === 401 || status === 403) router.failed(selected.id, '上游鉴权失败，请检查 Key', 60);
        store.fail(id, `上游返回 HTTP ${status}，任务失败，未扣 Anlas`, status);
        return json(res, status, { error: `上游拒绝请求（HTTP ${status}）`, requestId: id });
      }
      let complete = false, result = null;
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      if (streaming) {
        assert(contentType.includes('text/event-stream'), '上游未返回预期 SSE 流', 502);
        const check = new StreamCheck(body.parameters.n_samples);
        if (!res.destroyed) { res.writeHead(status, { 'Content-Type': contentType, 'X-Accel-Buffering': 'no' }); res.flushHeaders(); }
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length; assert(size <= 256 * 1024 * 1024, '生成结果过大', 502);
          check.feed(chunk);
          // A disconnected client cannot avoid the locally priced charge for a completed generation.
          if (!res.destroyed && !res.write(chunk)) await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.once('drain', done); res.once('close', done);
          });
        }
        complete = check.complete();
      } else {
        result = await readBounded(response);
        complete = result.length > 0;
        if (contentType.includes('application/json')) {
          try { const value = JSON.parse(result); complete = Array.isArray(value.images) && value.images.length === (body.parameters?.n_samples ?? (body.req_type === 'bg-removal' ? 3 : 1)) && value.images.every(i => i.image); } catch { complete = false; }
        } else if (path !== '/ai/encode-vibe') complete &&= contentType.startsWith('image/') || result.subarray(0, 2).toString() === 'PK';
      }
      assert(complete, '上游未返回完整生成结果，任务失败，未扣点数', 502);
      store.settle(id, amount, 'completed', amount ? '按密钥等级的本地报价结算' : '会员免费权益，未扣点数', status);
      if (!res.destroyed) {
        if (!streaming) { res.writeHead(status, { 'Content-Type': contentType }); res.end(result); }
        else res.end();
      }
    } catch (error) {
      if (jobId) store.fail(jobId, '请求超时、中断或结果不完整，任务失败，已释放预留点数', status);
      if (res.headersSent && !res.destroyed && String(res.getHeader('Content-Type')).includes('text/event-stream')) {
        res.end(`event: error\ndata: ${JSON.stringify({ event_type: 'error', error: '生成失败，未扣点数', requestId: jobId })}\n\n`);
        return;
      }
      throw error;
    } finally { selected?.unlock(); unlockKey?.(); res.off('close', onClose); }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, config.publicOrigin), path = url.pathname;
      if (path.startsWith('/admin/api/')) return await admin(req, res, path);
      const relayRoute = path === '/user/subscription' || path === '/ai/generate-image/suggest-tags' || PAID.has(path);
      if (relayRoute) {
        const origin = req.headers.origin;
        if (origin) {
          assert(options().origins.includes(origin) || origin === config.publicOrigin, '该网站未获准连接中转', 403);
          res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Idempotency-Key');
          res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');
        }
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
        assert(req.method === (PAID.has(path) ? 'POST' : 'GET'), '请求方法不支持', 405);
        const token = req.headers.authorization?.match(/^Bearer (skr_[A-Za-z0-9_-]{43})$/)?.[1];
        const key = token && store.authenticate(token); assert(key, '中转密钥无效或已停用', 401);
        assert(options().enabled, '中转已暂停', 503);
        if (PAID.has(path)) return await paid(req, res, path, key);
        if (path === '/user/subscription') {
          const data = key.tier === 'member' ? await upstream.subscription(store.upstreamToken(key.nai5_upstream_id)) : null;
          const current = store.usableKey(key.id);
          assert(current.tier === key.tier && current.nai5_upstream_id === key.nai5_upstream_id, '密钥等级或绑定已变化，请重新查询订阅', 409);
          return json(res, 200, downstreamSubscription(current, data));
        }
        const selected = router.pick(), upstreamToken = store.upstreamToken(selected.id);
        assert(url.search.length < 4096, '标签查询过长');
        const response = await upstream.request(`${path}${url.search}`, upstreamToken, { headers: { Accept: 'application/json' } });
        assert(response.ok, `标签查询失败（HTTP ${response.status}）`, response.status);
        const bytes = await readBounded(response, 2 * 1024 * 1024);
        return json(res, 200, JSON.parse(bytes.toString()));
      }
      if (path === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true });
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/admin': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      assert(req.method === 'GET' && assets[path], '页面不存在', 404);
      const [file, type] = assets[path]; res.writeHead(200, { 'Content-Type': type }); res.end(readFileSync(join(PUBLIC, file)));
    } catch (error) {
      if (res.headersSent) { if (!res.destroyed) res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 502;
      if (status === 429) res.setHeader('Retry-After', '3');
      json(res, status, { error: error instanceof HttpError ? error.message : '服务暂时不可用，请稍后重试或查看用量记录', ...(error.code ? { code: error.code } : {}) });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.maxHeadersCount = 50;
  return { server, store, router, isBusy: () => router.busy.size > 0, close: async () => { router.close(); await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); store.close(); } };
}
