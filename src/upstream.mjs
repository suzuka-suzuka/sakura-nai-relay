import { HttpError, assert } from './security.mjs';
import { balanceOf } from './billing.mjs';

export async function readBounded(response, max = 64 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > max) throw new HttpError(502, '上游响应超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function upstreamClient(origin, fetcher = fetch) {
  return {
    async subscription(token) {
      const res = await fetcher(`${origin}/user/subscription`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      assert(res.ok, `上游额度查询失败（HTTP ${res.status}）`, 502);
      let data; try { data = JSON.parse((await readBounded(res, 256 * 1024)).toString()); } catch { throw new HttpError(502, '无法解析上游额度'); }
      balanceOf(data); return data;
    },
    request(path, token, options = {}) {
      return fetcher(`${origin}${path}`, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(110000) });
    },
  };
}
