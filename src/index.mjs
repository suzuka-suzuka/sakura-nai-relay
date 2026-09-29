import { resolve } from 'node:path';
import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { createApp } from './server.mjs';

const host = process.env.HOST ?? '127.0.0.1', port = Number(process.env.PORT ?? 3100);
const publicOrigin = new URL(process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`).origin;
const upstreamOrigin = new URL(process.env.UPSTREAM_ORIGIN ?? 'https://image.novelai.net').origin;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
if (!upstreamOrigin.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(upstreamOrigin)) throw new Error('上游必须使用 HTTPS');
const dataDir = resolve(process.env.DATA_DIR ?? '.data'); mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const lock = resolve(dataDir, 'process.lock');
try {
  if (readFileSync(lock, 'utf8')) {
    const pid = Number(readFileSync(lock, 'utf8')); let alive = true;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('该数据目录已有运行中的实例');
    unlinkSync(lock);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const lockFd = openSync(lock, 'wx', 0o600); writeFileSync(lockFd, String(process.pid)); closeSync(lockFd);
const app = createApp({ dataDir, publicOrigin, upstreamOrigin, cookieSecure: process.env.COOKIE_SECURE === 'true' || publicOrigin.startsWith('https://') });
app.server.listen(port, host, () => {
  console.log(`Sakura Relay · ${publicOrigin}`);
  if (!app.store.get('admin_password')) console.log(`首次使用：打开控制台，用 ${resolve(dataDir, 'setup-code.txt')} 中的初始化码设置管理员密码。`);
});
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); try { unlinkSync(lock); } catch {} process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
