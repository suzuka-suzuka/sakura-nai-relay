import { HttpError } from './security.mjs';

/** FIFO mutexes. Cancellation removes waiters; started upstream work is never cancelled here. */
export class SerialQueue {
  constructor() { this.queues = new Map(); this.closed = false; }
  size(id) { return this.queues.get(id)?.length ?? 0; }
  enter(id, signal) {
    if (this.closed || signal?.aborted) return Promise.reject(new HttpError(503, '请求已取消或服务正在停止'));
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(id) ?? [];
      this.queues.set(id, queue);
      const entry = { started: false, reject, start: () => {
        entry.started = true; signal?.removeEventListener('abort', abort);
        let released = false;
        resolve(() => {
          if (released) return; released = true;
          queue.shift();
          if (queue.length) queue[0].start(); else this.queues.delete(id);
        });
      }};
      const abort = () => {
        if (entry.started) return;
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        reject(new HttpError(499, '排队请求已取消'));
        if (!queue.length) this.queues.delete(id);
      };
      entry.cancel = abort;
      queue.push(entry); signal?.addEventListener('abort', abort, { once: true });
      if (queue.length === 1) entry.start();
    });
  }
  close() {
    this.closed = true;
    for (const queue of this.queues.values()) for (const entry of [...queue]) if (!entry.started) entry.cancel();
  }
}
