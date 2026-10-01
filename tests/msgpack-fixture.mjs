import assert from 'node:assert/strict';

// Independent reader for the MessagePack value types present in our fixtures.
export function decodeStreamEvents(bytes) {
  const events = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    assert.ok(cursor + 4 <= bytes.length, 'truncated frame header');
    const size = bytes.readUInt32BE(cursor); cursor += 4;
    const end = cursor + size;
    assert.ok(end <= bytes.length, 'truncated frame');
    function string(size) { const value = bytes.toString('utf8', cursor, cursor + size); cursor += size; return value; }
    function read() {
      const tag = bytes[cursor++];
      if (tag <= 0x7f) return tag;
      if (tag >= 0xe0) return tag - 256;
      if (tag >= 0xa0 && tag <= 0xbf) return string(tag & 31);
      if (tag >= 0x80 && tag <= 0x8f) return Object.fromEntries(Array.from({ length: tag & 15 }, () => [read(), read()]));
      if (tag >= 0x90 && tag <= 0x9f) return Array.from({ length: tag & 15 }, read);
      if (tag === 0xc0) return null;
      if (tag === 0xc2 || tag === 0xc3) return tag === 0xc3;
      if (tag === 0xce) { const value = bytes.readUInt32BE(cursor); cursor += 4; return value; }
      if (tag === 0xd2) { const value = bytes.readInt32BE(cursor); cursor += 4; return value; }
      if (tag === 0xcb) { const value = bytes.readDoubleBE(cursor); cursor += 8; return value; }
      if ([0xd9, 0xda, 0xdb].includes(tag)) {
        const length = tag === 0xd9 ? 1 : tag === 0xda ? 2 : 4, size = bytes.readUIntBE(cursor, length); cursor += length;
        return string(size);
      }
      assert.fail(`unexpected MessagePack tag ${tag}`);
    }
    events.push(read());
    assert.equal(cursor, end, 'incorrect frame size');
  }
  return events;
}
