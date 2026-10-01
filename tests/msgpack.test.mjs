import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeStreamEvent } from '../src/msgpack.mjs';
import { decodeStreamEvents } from './msgpack-fixture.mjs';

test('MessagePack 最终图片帧使用标准 map、UTF-8 字符串和大端长度', () => {
  const event = { event_type: 'final', samp_ix: 0, image: 'abc' };
  const encoded = encodeStreamEvent(event);
  assert.equal(encoded.toString('hex'), '0000002583aa6576656e745f74797065a566696e616ca773616d705f697800a5696d616765a3616263');
  assert.deepEqual(decodeStreamEvents(encoded), [event]);
});

test('长图片、中文错误、浮点进度和多帧不丢失内容', () => {
  const events = [
    { event_type: 'intermediate', samp_ix: 0, step_ix: 200, progress: 0.25, ok: true, data: null },
    { event_type: 'final', samp_ix: 0, image: 'a'.repeat(70000) },
    { event_type: 'error', error: '生成失败，未扣点数', requestId: 'test', values: [-1, -100, false] },
  ];
  assert.deepEqual(decodeStreamEvents(Buffer.concat(events.map(encodeStreamEvent))), events);
});
