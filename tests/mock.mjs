import { deflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
export const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSuQAAAAASUVORK5CYII=';
export async function mockUpstream() {
  const state = { balance: 10000, paid: true, fail: false, incomplete: false, cost: 26, calls: [], slow: 0, queryFails: false, deltaOverride: null, accounts: new Map(), failBalanceDelta: 0 };
  const server = createServer(async (req, res) => {
    const call = { path: req.url, auth: req.headers.authorization, contentType: req.headers['content-type'] }; state.calls.push(call);
    const account = state.accounts.get(req.headers.authorization?.replace('Bearer ', '')) ?? state;
    if (req.url === '/user/subscription') {
      if (account.querySlow) await delay(account.querySlow);
      if (account.queryFails) { res.writeHead(503); return res.end('{}'); }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ tier: account.tier ?? 3, active: account.active ?? true, expiresAt: account.expiresAt ?? Date.now() / 1000 + 86400, trainingStepsLeft: { fixedTrainingStepsLeft: account.balance, purchasedTrainingSteps: 0 }, usage: { percent: account.usagePercent ?? (account.paid ? 0 : 73.6), isNegative: account.usageNegative ?? account.paid, timeUntilNextPercent: account.timeUntilNextPercent }, email: 'private@example.com', token: 'SHOULD_NOT_LEAK' }));
    }
    if (req.url.startsWith('/ai/generate-image/suggest-tags')) { res.setHeader('Content-Type', 'application/json'); return res.end('{"tags":[{"tag":"cherry blossoms"}]}'); }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body = {};
    try {
      if (call.contentType?.startsWith('multipart/form-data')) {
        const form = await new Response(raw, { headers: { 'Content-Type': call.contentType } }).formData();
        const request = form.get('request');
        body = JSON.parse(request instanceof Blob ? await request.text() : request);
        call.parts = {};
        for (const [name, value] of form) if (name !== 'request' && value instanceof Blob) call.parts[name] = Buffer.from(await value.arrayBuffer());
        call.raw = raw;
      } else body = JSON.parse(raw);
    } catch {}
    call.body = body;
    if (account.connectionFails) { res.destroy(); return; }
    account.activeGenerations = (account.activeGenerations ?? 0) + 1;
    account.maxActiveGenerations = Math.max(account.maxActiveGenerations ?? 0, account.activeGenerations);
    res.once('finish', () => { account.activeGenerations--; });
    if (account.slow) await delay(account.slow);
    if (account.fail) { account.balance -= account.failBalanceDelta ?? 0; res.writeHead(account.failStatus ?? 429); return res.end('pst-local-test must not leak'); }
    account.balance -= account.deltaOverride ?? (account.paid ? account.cost : 0);
    account.onGenerate?.(body);
    if (req.url.endsWith('-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      if (account.streamChunks) {
        for (const chunk of account.streamChunks) { res.write(chunk); await delay(1); }
        return res.end();
      }
      res.write('event: intermediate\ndata: {"event_type":"intermediate","samp_ix":0,"step_ix":1,"image":"'+image+'"}\n\n');
      if (!account.incomplete) for (let i=0; i<Math.min(account.finalCount ?? Infinity, body.parameters?.n_samples ?? 1); i++) res.write(`event: final\ndata: ${JSON.stringify({ event_type: 'final', samp_ix: i, step_ix: 23, image })}\n\n`);
      return res.end();
    }
    if (req.url === '/ai/encode-vibe') { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(Buffer.from([1,2,3])); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ images: account.badResult ? [] : Array.from({ length: body.parameters?.n_samples ?? 1 }, (_, index) => ({ image, index })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) };
}

// Real opaque PNG canvases for request-size and multipart regression tests.
export function canvasPng(width, height) {
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return Buffer.concat([u32(data.length), payload, u32((crc ^ 0xffffffff) >>> 0)]);
  };
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * (width * 4 + 1) + 1 + x * 4;
    raw[i] = raw[i + 1] = raw[i + 2] = raw[i + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', Buffer.concat([u32(width),u32(height),Buffer.from([8,6,0,0,0])])),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
