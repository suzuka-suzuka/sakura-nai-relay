import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
export const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSuQAAAAASUVORK5CYII=';
export async function mockUpstream() {
  const state = { balance: 10000, paid: true, fail: false, incomplete: false, cost: 26, calls: [], slow: 0, queryFails: false, deltaOverride: null, accounts: new Map(), failBalanceDelta: 0 };
  const server = createServer(async (req, res) => {
    state.calls.push({ path: req.url, auth: req.headers.authorization });
    const account = state.accounts.get(req.headers.authorization?.replace('Bearer ', '')) ?? state;
    if (req.url === '/user/subscription') {
      if (account.queryFails) { res.writeHead(503); return res.end('{}'); }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ tier: 3, active: true, expiresAt: Date.now() / 1000 + 86400, trainingStepsLeft: { fixedTrainingStepsLeft: account.balance, purchasedTrainingSteps: 0 }, usage: { percent: account.paid ? 0 : 73.6, isNegative: account.paid }, email: 'private@example.com', token: 'SHOULD_NOT_LEAK' }));
    }
    if (req.url.startsWith('/ai/generate-image/suggest-tags')) { res.setHeader('Content-Type', 'application/json'); return res.end('{"tags":[{"tag":"cherry blossoms"}]}'); }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks)); } catch {}
    state.calls.at(-1).body = body;
    if (account.slow) await delay(account.slow);
    if (account.fail) { account.balance -= account.failBalanceDelta ?? 0; res.writeHead(429); return res.end('pst-local-test must not leak'); }
    account.balance -= account.deltaOverride ?? (account.paid ? account.cost : 0);
    if (req.url.endsWith('-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('event: intermediate\ndata: {"event_type":"intermediate","samp_ix":0,"step_ix":1,"image":"'+image+'"}\n\n');
      if (!account.incomplete) for (let i=0; i<(body.parameters?.n_samples ?? 1); i++) res.write(`event: final\ndata: ${JSON.stringify({ event_type: 'final', samp_ix: i, step_ix: 23, image })}\n\n`);
      return res.end();
    }
    if (req.url === '/ai/encode-vibe') { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(Buffer.from([1,2,3])); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ images: Array.from({ length: body.parameters?.n_samples ?? 1 }, (_, index) => ({ image, index })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) };
}
