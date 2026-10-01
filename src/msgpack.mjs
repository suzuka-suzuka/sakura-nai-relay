import { assert } from './security.mjs';

/** Encode JSON SSE events into the length-prefixed MessagePack used by Launcher. */
export function encodeStreamEvent(event) {
  const chunks = [];
  const header = (tag, size, bytes) => {
    const value = Buffer.alloc(1 + bytes);
    value[0] = tag;
    value.writeUIntBE(size, 1, bytes);
    chunks.push(value);
  };
  function encode(value, depth = 0) {
    assert(depth <= 64, '上游流式事件嵌套过深', 502);
    if (value === null) { chunks.push(Buffer.from([0xc0])); return; }
    if (typeof value === 'boolean') { chunks.push(Buffer.from([value ? 0xc3 : 0xc2])); return; }
    if (typeof value === 'number') {
      assert(Number.isFinite(value), '上游流式数值无效', 502);
      if (Number.isInteger(value) && value >= 0 && value <= 127) chunks.push(Buffer.from([value]));
      else if (Number.isInteger(value) && value >= -32 && value < 0) chunks.push(Buffer.from([256 + value]));
      else if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) header(0xce, value, 4);
      else if (Number.isInteger(value) && value >= -2147483648 && value < 0) {
        const number = Buffer.alloc(5); number[0] = 0xd2; number.writeInt32BE(value, 1); chunks.push(number);
      } else {
        const number = Buffer.alloc(9); number[0] = 0xcb; number.writeDoubleBE(value, 1); chunks.push(number);
      }
      return;
    }
    if (typeof value === 'string') {
      const bytes = Buffer.from(value);
      if (bytes.length < 32) chunks.push(Buffer.from([0xa0 | bytes.length]));
      else if (bytes.length <= 255) header(0xd9, bytes.length, 1);
      else if (bytes.length <= 65535) header(0xda, bytes.length, 2);
      else header(0xdb, bytes.length, 4);
      chunks.push(bytes); return;
    }
    assert(value && typeof value === 'object', '上游流式事件无效', 502);
    const array = Array.isArray(value), entries = array ? value : Object.entries(value);
    if (entries.length < 16) chunks.push(Buffer.from([(array ? 0x90 : 0x80) | entries.length]));
    else header(array ? (entries.length <= 65535 ? 0xdc : 0xdd) : (entries.length <= 65535 ? 0xde : 0xdf), entries.length, entries.length <= 65535 ? 2 : 4);
    for (const entry of entries) {
      if (array) encode(entry, depth + 1);
      else { encode(entry[0], depth + 1); encode(entry[1], depth + 1); }
    }
  }
  encode(event);
  const data = Buffer.concat(chunks), length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}
