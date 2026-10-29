import { createServer } from 'node:http';
import { readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Store } from './db.mjs';
import { HttpError, assert, integer, hash, random, equal, passwordHash, verifyPassword } from './security.mjs';
import { balanceOf, upstreamSubscription, downstreamSubscription, billingAccount, isActiveOpus, hasNai5Allowance, isNai5Generation, reservation, quoteRequest, StreamCheck } from './billing.mjs';
import { hasLocalStamina, staminaPercent } from './stamina.mjs';
import { productById } from './cdk.mjs';
import { upstreamClient, readBounded } from './upstream.mjs';
import { UpstreamRouter } from './router.mjs';
import { imageSize, base64Size } from './image-size.mjs';
import { parseJson as parse, parseMultipart, imagePart, validateGenerationParts, replaceMultipartRequest, validateInpaintingImages } from './multipart.mjs';
import { encodeStreamEvent } from './msgpack.mjs';
import { adminEvents } from './admin-events.mjs';
import { requestDiagnostics, redactDiagnosticText, failureDiagnostics, diagnosticSecrets } from './request-diagnostics.mjs';

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
const optionalNote = (value = '') => { assert(typeof value === 'string' && value.trim().length <= 160, '备注应为不超过 160 字的文本'); return value.trim(); };
const optionalName = value => { assert(typeof value === 'string' && value.trim().length <= 64, '名称应为不超过 64 字的文本'); return value.trim(); };
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
  function snapshot() {
    const now = Date.now(), dayStart = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
    const stats = store.db.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(charged),0) AS spent, COALESCE(SUM(upstream_spent),0) AS upstreamSpent,
      COUNT(DISTINCT CASE WHEN created_at>=? AND created_at<? AND upstream_id IS NOT NULL
        AND endpoint IN ('/ai/generate-image','/ai/generate-image-stream','/ai/augment-image','/ai/upscale') THEN key_id END) AS activeToday,
      COUNT(CASE WHEN status='running' AND upstream_id IS NOT NULL
        AND endpoint IN ('/ai/generate-image','/ai/generate-image-stream','/ai/augment-image','/ai/upscale') THEN 1 END) AS generating
      FROM jobs WHERE status!='pending'`).get(dayStart, dayStart + 86400000);
    const trend = store.db.prepare("SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch','+8 hours') AS day, COUNT(*) AS requests,COALESCE(SUM(charged),0) AS spent,COALESCE(SUM(upstream_spent),0) AS upstreamSpent FROM jobs WHERE status!='pending' AND created_at>? GROUP BY day").all(Date.now() - 7 * 86400000);
    return { settings: options(), upstreams: store.upstreams().map(r => router.status(r)), keys: store.keys().map(key => ({ ...key, expired: key.expires_at !== null && key.expires_at <= Date.now() })), jobs: store.jobs(), ledger: store.ledger(), stats, trend, cdks: { products: store.cdkSummary(), redemptions: store.cdkRedemptions() }, busy: router.busy.size > 0, relayUrl: config.relayUrl || config.publicOrigin, redeemUrl: config.redeemUrl || `${config.publicOrigin}/redeem` };
  }
  async function readQuota() {
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
    return { upstreams: results, totalAnlas: results.reduce((sum, r) => sum + (r.ok ? r.account.relay.balance : 0), 0), failed: results.filter(r => !r.ok).length, fetchedAt: Date.now() };
  }
  const events = adminEvents({ snapshot, session, quota: readQuota });
  store.onChange = events.changed; router.onChange = events.changed;
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
      events.revalidate();
      res.setHeader('Set-Cookie', 'sakura_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (path === '/admin/api/snapshot' && req.method === 'GET') {
      return json(res, 200, snapshot());
    }
    if (path === '/admin/api/jobs' && req.method === 'GET') {
      const params = new URL(req.url, config.publicOrigin).searchParams;
      const value = params.get('keyId');
      assert(value === null || /^[1-9]\d*$/.test(value), '密钥编号无效');
      const keyId = value === null ? null : integer(Number(value), 1, Number.MAX_SAFE_INTEGER, '密钥编号');
      return json(res, 200, { jobs: store.jobs(100, keyId, params.get('status') ?? 'all') });
    }
    if (path === '/admin/api/jobs/search' && req.method === 'POST') {
      const body = parse(await readBody(req, 4096));
      assert(typeof body.query === 'string' && body.query.trim().length <= 256, '搜索内容应为不超过 256 字的文本');
      return json(res, 200, { jobs: store.searchJobs(body.query, 100, body.status === undefined ? 'all' : body.status) });
    }
    if (path.startsWith('/admin/api/jobs/') && req.method === 'GET') {
      const id = path.slice('/admin/api/jobs/'.length);
      assert(store.db.prepare('SELECT id FROM jobs WHERE id=?').get(id), '请求记录不存在', 404);
      return json(res, 200, { diagnostics: store.jobDiagnostics(id) });
    }
    if (path === '/admin/api/events' && req.method === 'GET') {
      assert(!req.headers.origin || req.headers.origin === config.publicOrigin, '请求来源不匹配', 403);
      assert(!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin', '请求来源不匹配', 403);
      return events.connect(req, res, s, { delta: new URL(req.url, config.publicOrigin).searchParams.get('delta') === '1' });
    }
    if (path === '/admin/api/quota' && req.method === 'GET') {
      allow('admin-quota', 20);
      return json(res, 200, await readQuota());
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
        const name = optionalName(body.name === undefined ? previous?.name ?? '' : body.name);
        const metadata = {};
        for (const [field, label, limit] of [['note', '备注', 1000]]) {
          if (body[field] === undefined) continue;
          assert(typeof body[field] === 'string' && body[field].length <= limit, `${label}须为不超过 ${limit} 个字符的文本`);
          metadata[field] = body[field].trim();
        }
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
          if (id === null) return store.addUpstream({ name, token, enabled: body.enabled, ...metadata });
          store.updateUpstream(id, { name, token, enabled: body.enabled, ...metadata }); return id;
        });
        if (token) router.reset(savedId);
        return json(res, id === null ? 201 : 200, { id: savedId });
      } finally { if (id !== null) editingUpstreams.delete(id); }
    }
    if (path === '/admin/api/settings' && req.method === 'PUT') {
      const body = parse(await readBody(req, 16384));
      assert(Array.isArray(body.origins) && body.origins.length <= 30, '允许的站点格式无效');
      const origins = [...new Set(body.origins.map(value => {
        if (value === '*') return value;
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
    if (path === '/admin/api/keys/search' && req.method === 'POST') {
      const body = parse(await readBody(req, 4096));
      assert(typeof body.query === 'string' && body.query.trim().length <= 256, '搜索内容应为不超过 256 字的文本');
      return json(res, 200, { ids: store.searchKeys(body.query.trim()) });
    }
    if (path === '/admin/api/keys' && req.method === 'POST') {
      const body = parse(await readBody(req, 4096));
      const name = optionalName(body.name === undefined ? '' : body.name), points = integer(body.points, 0, 1_000_000_000);
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
      if (keyMatch[2]) store.adjust(id, integer(body.delta, -1_000_000_000, 1_000_000_000), optionalNote(body.note));
      else {
        if (body.name !== undefined) body.name = optionalName(body.name);
        if (body.tier !== undefined || body.staminaPercent !== undefined)
          assert(!router.keyQueue.size(id), '请等待该密钥的生成和排队结束，再修改等级或体力上限', 409);
        store.updateKey(id, body);
      }
      return json(res, 200, { ok: true });
    }
    if (path === '/admin/api/cdks' && req.method === 'GET') return json(res, 200, { products: store.cdkSummary(), redemptions: store.cdkRedemptions() });
    if (path === '/admin/api/cdks' && req.method === 'POST') {
      const body = parse(await readBody(req, 4096));
      assert(productById(body.product), '商品不存在');
      return json(res, 201, store.createCdks(body.product, integer(body.count, 1, 200, '生成数量')));
    }
    if (path === '/admin/api/cdks/export' && req.method === 'POST') {
      const body = parse(await readBody(req, 4096));
      assert(productById(body.product), '商品不存在');
      return json(res, 200, { codes: store.unusedCdks(body.product) });
    }
    if (path === '/admin/api/cdks/search' && req.method === 'POST') {
      const body = parse(await readBody(req, 4096));
      assert(typeof body.code === 'string' && body.code.trim(), '请填写兑换码');
      return json(res, 200, store.findCdk(body.code));
    }
    if (path === '/admin/api/cdks/void' && req.method === 'POST') {
      const body = parse(await readBody(req, 4096));
      assert(typeof body.code === 'string' && body.code.trim(), '请填写兑换码');
      assert(body.disableKey === undefined || typeof body.disableKey === 'boolean', '参数无效');
      const result = store.voidCdk(body.code, { reason: optionalNote(body.reason) || null, disableKey: body.disableKey === true });
      return json(res, 200, result);
    }
    if (path === '/admin/api/password' && req.method === 'POST') {
      allow(`password:${req.socket.remoteAddress}`, 5, 10 * 60000);
      const body = parse(await readBody(req, 4096));
      assert(verifyPassword(body.current, store.get('admin_password')), '当前密码不正确', 401);
      assert(typeof body.password === 'string' && body.password.length >= 12 && body.password.length <= 256, '新密码需为 12–256 个字符');
      store.transaction(() => { store.set('admin_password', passwordHash(body.password)); store.db.exec('DELETE FROM sessions'); });
      events.revalidate();
      return json(res, 200, { csrf: issueSession(res) });
    }
    throw new HttpError(404, '管理接口不存在');
  }

  async function selectUpstream(path, body, keyId, signal) {
    const key = store.usableKey(keyId);
    const { amount, stamina } = quoteRequest(path, body, key);
    const strictStamina = stamina > 0, mode = key.tier === 'member' ? 'anlas-pool' : 'pool';
    const requireAnlas = key.tier === 'member';
    const exhaustedNai5 = key.tier === 'member' && isNai5Generation(path, body) && !hasLocalStamina(key);
    const staminaUnavailable = cause => {
      const error = new HttpError(503, '上游暂时无法承接本次请求，请稍后重试', 'UPSTREAM_STAMINA_UNAVAILABLE');
      error.cause = cause ?? lastError ?? new Error('没有上游同时满足本次生成的体力、订阅及余额条件');
      return error;
    };
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
    const current = store.usableKey(keyId);
    assert(current.balance - current.reserved >= amount, `Anlas 不足，本次需要 ${amount} Anlas`, 402);
    let lastError = null, pools = [null];
    const noteAccount = (pool, id, subscription) => {
      if (!pool?.expires && !pool?.nonOpus) return;
      if (pool.expires) {
        if (Number.isFinite(subscription?.expiresAt)) pool.expires.set(id, subscription.expiresAt);
        else pool.expires.delete(id);
      }
      // Only an active Opus serves small and standard images without Anlas, so every other tier is used first.
      if (pool.nonOpus) { if (isActiveOpus(subscription)) pool.nonOpus.delete(id); else pool.nonOpus.add(id); }
    };
    // Read-only discovery does not occupy generation slots. Recheck under the selected account's lock below.
    const scan = async (rows, visit) => {
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(rows.length, 4) }, async () => {
        while (cursor < rows.length && !signal.aborted) {
          const row = rows[cursor++];
          if (editingUpstreams.has(row.id)) continue;
          try { visit(row, await upstream.subscription(store.upstreamToken(row.id))); }
          catch (error) { router.failed(row.id, '上游账户查询失败'); lastError = error; }
        }
      }));
      assert(!signal.aborted, '请求已取消', 499);
      store.usableKey(keyId);
    };
    if (key.tier === 'member') {
      let rows;
      try { rows = router.available(); } catch (error) { if (strictStamina) throw staminaUnavailable(error); throw error; }
      const staminaPool = { scope: 'stamina', ids: new Set(), mode: 'nai5-local-stamina' };
      const freePool = { scope: 'free', ids: new Set(), mode: exhaustedNai5 ? 'nai5-stamina-pool' : 'opus-pool' };
      const anlasPool = { scope: 'anlas', ids: new Set(), mode, order: 'expiry', expires: new Map(), nonOpus: new Set() };
      const preferFree = amount === 0 || exhaustedNai5;
      pools = strictStamina ? [staminaPool] : preferFree ? [freePool, anlasPool] : [anlasPool];
      await scan(rows, (row, subscription) => {
        const estimate = reservation(path, body, subscription), balance = balanceOf(subscription);
        if (strictStamina && hasNai5Allowance(subscription) && estimate === amount && balance >= estimate) staminaPool.ids.add(row.id);
        if (preferFree && isActiveOpus(subscription) && estimate === 0) freePool.ids.add(row.id);
        if (balance > 0 && balance >= estimate) { anlasPool.ids.add(row.id); noteAccount(anlasPool, row.id, subscription); }
      });
    } else {
      let rows;
      try { rows = router.available(); } catch (error) { throw error; }
      if (rows.length > 1) {
        const pointsPool = { scope: 'pool', ids: new Set(), mode, order: 'expiry', expires: new Map(), nonOpus: new Set() };
        pools = [pointsPool];
        await scan(rows, (row, subscription) => {
          const estimate = reservation(path, body, subscription), balance = balanceOf(subscription);
          if (balance >= estimate) { pointsPool.ids.add(row.id); noteAccount(pointsPool, row.id, subscription); }
        });
      }
    }
    for (const pool of pools) {
      const excluded = new Set();
      while (excluded.size < store.upstreams().length) {
        let row;
        try { row = router.pick(excluded, pool); } catch (error) { if (strictStamina) throw staminaUnavailable(lastError ?? error); if (lastError) throw lastError; throw error; }
        if (!row) break;
        excluded.add(row.id);
        let selected;
        try { selected = await inspect(row.id); }
        catch (error) {
          if (signal.aborted || error.status === 401 || error.code === 'KEY_EXPIRED') throw error;
          pool?.ids.delete(row.id); pool?.expires?.delete(row.id); pool?.nonOpus?.delete(row.id);
          lastError = error; continue;
        }
        try {
          const upstreamEstimate = reservation(path, body, selected.subscription), balance = balanceOf(selected.subscription);
          const funded = balance > 0 && balance >= upstreamEstimate;
          noteAccount(pool, row.id, selected.subscription);
          const usable = pool?.scope === 'stamina' ? hasNai5Allowance(selected.subscription) && upstreamEstimate === amount && balance >= upstreamEstimate
            : pool?.scope === 'free' ? isActiveOpus(selected.subscription) && upstreamEstimate === 0
            : requireAnlas ? funded : balance >= upstreamEstimate;
          if (usable) return { ...selected, amount, stamina, upstreamEstimate, mode: pool?.mode ?? mode, pool };
          // Free eligibility can disappear while queued; the refreshed account may still join the funded pool.
          if (pool?.scope === 'free') {
            const anlasPool = pools.find(p => p?.scope === 'anlas');
            if (funded) { anlasPool.ids.add(row.id); noteAccount(anlasPool, row.id, selected.subscription); }
            else { anlasPool.ids.delete(row.id); anlasPool.expires.delete(row.id); anlasPool.nonOpus.delete(row.id); }
          }
        } catch (error) { selected.unlock(); throw error; }
        pool?.ids.delete(row.id); pool?.expires?.delete(row.id); pool?.nonOpus?.delete(row.id);
        selected.unlock();
      }
    }
    if (strictStamina) throw staminaUnavailable();
    if (lastError) throw lastError;
    throw new HttpError(503, '账号池没有余额足够的可用上游，请联系管理员补充 Anlas');
  }

  async function paid(req, res, path, key, entry) {
    const waiting = new AbortController();
    const onClose = () => waiting.abort(); res.once('close', onClose);
    let jobId = null, status = null, selected = null, unlockKey = null, msgpack = false, streamCheck = null;
    let body, form = null;
    const secrets = entry.secrets;
    try {
      store.requestStage(entry.id, '读取请求');
      const raw = await readBody(req, MAX_BODY);
      store.requestStage(entry.id, '参数校验');
      let type = req.headers['content-type'] ?? '';
      const mediaType = type.split(';')[0].trim().toLowerCase(), streaming = path.endsWith('-stream');
      let payload = raw;
      if (mediaType === 'multipart/form-data') {
        ({ form, body } = await parseMultipart(raw, type));
        if (path === '/ai/generate-image' || streaming) validateGenerationParts(form, body);
        else {
          const image = imagePart(form, body.image);
          if (path === '/ai/upscale') {
            assert(body.image === 'image' && body.model === 'nai-diffusion-5-curated', '放大参数无效');
            Object.assign(body, imageSize(Buffer.from(await image.arrayBuffer())));
          }
          if (path === '/ai/augment-image') {
            const size = imageSize(Buffer.from(await image.arrayBuffer()));
            assert(body.width === size.width && body.height === size.height, '声明尺寸与实际图片尺寸不符');
          }
        }
      } else {
        assert(mediaType === 'application/json', '需要 JSON 或受支持的图片表单', 415);
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
      secrets.push(...diagnosticSecrets(body));
      store.requestStage(entry.id, '参数校验', typeof body.model === 'string' ? redactDiagnosticText(body.model, secrets).slice(0, 128) : null);
      await validateInpaintingImages(body, form);
      // Drain uploads before queueing so the request-body timeout never includes queue wait.
      store.requestStage(entry.id, '密钥排队');
      unlockKey = await router.lockKey(key.id, waiting.signal);
      // Validate the complete body before querying or occupying any upstream account.
      store.requestStage(entry.id, '参数与额度校验');
      reservation(path, body, billingAccount(store.usableKey(key.id)));
      if (streaming) {
        msgpack = body.parameters.stream === 'msgpack';
        body.parameters.stream = 'sse';
        if (form) ({ payload, type } = await replaceMultipartRequest(form, body));
        else payload = Buffer.from(JSON.stringify(body));
      }
      const idempotency = req.headers['idempotency-key'] ?? null;
      assert(idempotency === null || typeof idempotency === 'string' && idempotency.length <= 128 && /^[\w-]+$/.test(idempotency), 'Idempotency-Key 格式无效');
      if (idempotency) assert(!store.db.prepare('SELECT id FROM jobs WHERE key_id=? AND idempotency=?').get(key.id, idempotency), '该请求已受理，请勿重复提交', 409);
      store.requestStage(entry.id, '选择上游 / 上游排队');
      selected = await selectUpstream(path, body, key.id, waiting.signal);
      assert(!waiting.signal.aborted, '请求已取消', 499);
      assert(options().enabled, '中转已暂停', 503);
      const { token, amount, stamina, upstreamEstimate, mode } = selected;
      secrets.push(token, ...diagnosticSecrets(body));
      const id = entry.id;
      store.reserve(key.id,id,path,body.model ?? body.req_type ?? 'image-tool',amount,idempotency,selected.id,{ mode,upstreamEstimate,stamina });
      jobId = id;
      store.saveJobDiagnostics(id, { request: await requestDiagnostics(body, form, secrets) });
      res.setHeader('X-Request-Id', id);
      router.commit(selected.id, selected.pool);
      const response = await upstream.request(path, token, { method: 'POST', headers: { 'Content-Type': type, Accept: streaming ? 'text/event-stream' : req.headers.accept ?? 'application/zip, application/json' }, body: payload });
      status = response.status;
      store.saveJobDiagnostics(id, { contentType: response.headers.get('content-type') });
      if (!response.ok) {
        const detail = await readBounded(response, 1024 * 1024);
        store.saveJobDiagnostics(id, { upstreamError: redactDiagnosticText(detail.toString('utf8'), secrets) });
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
        const frames = [], check = new StreamCheck(body.parameters.n_samples, msgpack ? event => frames.push(encodeStreamEvent(event)) : null);
        streamCheck = check;
        if (!res.destroyed) { res.writeHead(status, { 'Content-Type': msgpack ? 'application/x-msgpack' : contentType, 'X-Accel-Buffering': 'no' }); res.flushHeaders(); }
        const forward = async chunk => {
          if (!res.destroyed && !res.write(chunk)) await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.once('drain', done); res.once('close', done);
          });
        };
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length; assert(size <= 256 * 1024 * 1024, '生成结果过大', 502);
          check.feed(chunk);
          // A disconnected client cannot avoid the locally priced charge for a completed generation.
          if (msgpack) { for (const frame of frames.splice(0)) await forward(frame); }
          else await forward(chunk);
        }
        complete = check.complete();
        for (const frame of frames.splice(0)) await forward(frame);
      } else {
        result = await readBounded(response);
        complete = result.length > 0;
        if (contentType.includes('application/json')) {
          try { const value = JSON.parse(result); complete = Array.isArray(value.images) && value.images.length === (body.parameters?.n_samples ?? (body.req_type === 'bg-removal' ? 3 : 1)) && value.images.every(i => i.image); } catch { complete = false; }
        } else if (path !== '/ai/encode-vibe') complete &&= contentType.startsWith('image/') || result.subarray(0, 2).toString() === 'PK';
        if (!complete && (contentType.includes('json') || contentType.startsWith('text/')))
          store.saveJobDiagnostics(id, { upstreamError: redactDiagnosticText(result.toString('utf8'), secrets) });
      }
      assert(complete, '上游未返回完整生成结果，任务失败，未扣点数', 502);
      store.settle(id, amount, 'completed', amount ? '按密钥等级的本地报价结算' : '会员免费权益，未扣点数', status);
      if (!res.destroyed) {
        if (!streaming) { res.writeHead(status, { 'Content-Type': contentType }); res.end(result); }
        else res.end();
      }
    } catch (error) {
      // Invalid parsed parameters are useful too; never persist an unparsed body or credentials.
      if (body) {
        try {
          secrets.push(...diagnosticSecrets(body));
          store.saveJobDiagnostics(entry.id, { request: await requestDiagnostics(body, form, secrets) });
        } catch { /* Malformed diagnostics must never replace the original validation failure. */ }
      }
      if (jobId) store.saveJobDiagnostics(jobId, { failure: failureDiagnostics(error, streamCheck, secrets),
        upstreamError: streamCheck?.upstreamError ? redactDiagnosticText(streamCheck.upstreamError, secrets) : null });
      const transportCode = error.cause?.code ?? error.code;
      const networkCode = typeof transportCode === 'string' && /^(UND_ERR_[A-Z_]+|E[A-Z]+)$/.test(transportCode) ? transportCode : null;
      if (jobId) store.fail(jobId, `${redactDiagnosticText(error.message, secrets)}${networkCode ? `（${networkCode}）` : ''}，任务失败，已释放预留点数`, status);
      if (jobId) store.db.prepare('UPDATE jobs SET response_status=? WHERE id=?').run(error instanceof HttpError ? error.status : 502, jobId);
      if (!(error instanceof HttpError)) console.error('上游请求异常', { endpoint: path, name: error.name, code: networkCode });
      if (res.headersSent && !res.destroyed && (msgpack || String(res.getHeader('Content-Type')).includes('text/event-stream'))) {
        const event = { event_type: 'error', error: '生成失败，未扣点数', requestId: jobId };
        res.end(msgpack ? encodeStreamEvent(event) : `event: error\ndata: ${JSON.stringify(event)}\n\n`);
        return;
      }
      throw error;
    } finally { selected?.unlock(); unlockKey?.(); res.off('close', onClose); if (jobId) void events.refreshQuota(); }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    let entry = null, relayPath = null, relayStage = '入口校验';
    const beginEntry = path => {
      if (entry) return entry;
      const token = req.headers.authorization?.match(/^Bearer (skr_[A-Za-z0-9_-]{43})$/)?.[1];
      entry = { id: random().slice(0, 18), secrets: [req.headers.authorization?.replace(/^Bearer\s+/i, '')] };
      store.beginRequest(entry.id, path, req.method, token);
      if (!res.headersSent) res.setHeader('X-Request-Id', entry.id);
      return entry;
    };
    const onEntryClose = () => {
      if (!relayPath || res.writableEnded) return;
      if (!entry) {
        beginEntry(relayPath);
        store.requestStage(entry.id, relayStage);
      }
      store.clientDisconnected(entry.id);
      const error = new HttpError(499, PAID.has(relayPath)
        ? '客户端断开连接，请求已取消，尚未转发上游，未扣点数'
        : '客户端断开连接，查询已取消');
      if (store.finishPending(entry.id, error.message, 499, true))
        store.saveJobDiagnostics(entry.id, { failure: failureDiagnostics(error, null, entry.secrets) });
    };
    res.once('close', onEntryClose);
    try {
      const url = new URL(req.url, config.publicOrigin), path = url.pathname;
      if (path.startsWith('/admin/api/')) {
        const result = await admin(req, res, path);
        if (res.statusCode >= 200 && res.statusCode < 300 && ['POST', 'PUT', 'DELETE'].includes(req.method) && (path.startsWith('/admin/api/upstreams') || path === '/admin/api/settings')) void events.refreshQuota();
        return result;
      }
      const accountRoute = path === '/user/subscription' || path === '/ai/user/subscription' || path === '/user/data';
      const relayRoute = accountRoute || path === '/ai/generate-image/suggest-tags' || PAID.has(path);
      if (relayRoute) {
        relayPath = path;
        if (PAID.has(path) && req.method !== 'OPTIONS') beginEntry(path);
        const origin = req.headers.origin;
        if (origin) {
          const origins = options().origins;
          assert(origins.includes('*') || origins.includes(origin) || origin === config.publicOrigin, '该网站未获准连接中转', 403);
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
        if (PAID.has(path)) return await paid(req, res, path, key, entry);
        if (accountRoute) {
          relayStage = '额度查询';
          const current = store.usableKey(key.id);
          const subscription = downstreamSubscription(current);
          if (path === '/user/data') {
            return json(res, 200, { subscription });
          }
          return json(res, 200, subscription);
        }
        relayStage = '标签查询';
        const selected = router.pick(), upstreamToken = store.upstreamToken(selected.id);
        assert(url.search.length < 4096, '标签查询过长');
        const response = await upstream.request(`${path}${url.search}`, upstreamToken, { headers: { Accept: 'application/json' } });
        assert(response.ok, `标签查询失败（HTTP ${response.status}）`, response.status);
        const bytes = await readBounded(response, 2 * 1024 * 1024);
        return json(res, 200, JSON.parse(bytes.toString()));
      }
      if (path === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true });
      if (path === '/api/redeem' && req.method === 'POST') {
        allow(`redeem:${req.socket.remoteAddress || 'local'}`, 120, 60000);
        const body = parse(await readBody(req, 4096));
        const result = store.redeemCdk(body.code), key = result.key;
        return json(res, 200, {
          token: result.token, relayUrl: config.relayUrl || config.publicOrigin, name: key.name, tier: key.tier, points: key.balance,
          staminaPercent: key.tier === 'member' ? staminaPercent(key.stamina_capacity) : 0, expiresAt: key.expires_at,
        });
      }
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/admin': ['index.html', 'text/html; charset=utf-8'], '/redeem': ['redeem.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/redeem.js': ['redeem.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      assert(req.method === 'GET' && assets[path], '页面不存在', 404);
      const [file, type] = assets[path]; res.writeHead(200, { 'Content-Type': type }); res.end(readFileSync(join(PUBLIC, file)));
    } catch (error) {
      if (relayPath) {
        const lateEntry = !entry;
        const record = beginEntry(relayPath);
        if (lateEntry) store.requestStage(record.id, relayStage);
        const cancelled = error.status === 499;
        const responseStatus = cancelled ? 499 : error instanceof HttpError ? error.status : 502;
        const note = `${redactDiagnosticText(error.message, record.secrets)}${error.cause?.code ? `（${redactDiagnosticText(error.cause.code, record.secrets)}）` : ''}`;
        if (store.finishPending(record.id, note, responseStatus, cancelled))
          store.saveJobDiagnostics(record.id, { failure: failureDiagnostics(error, null, record.secrets) });
        store.db.prepare('UPDATE jobs SET response_status=COALESCE(response_status,?) WHERE id=?').run(responseStatus, record.id);
      }
      if (res.headersSent) { if (!res.destroyed) res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 502;
      if (status === 429) res.setHeader('Retry-After', '3');
      json(res, status, { error: error instanceof HttpError ? error.message : '服务暂时不可用，请稍后重试或查看用量记录', ...(error.code ? { code: error.code } : {}), ...(entry ? { requestId: entry.id } : {}) });
    } finally { res.off('close', onEntryClose); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.maxHeadersCount = 50;
  return { server, store, router, isBusy: () => router.busy.size > 0, close: async () => {
    router.close();
    const stopped = new Promise(resolve => server.close(resolve));
    await events.close(); server.closeIdleConnections(); await stopped; store.close();
  } };
}
