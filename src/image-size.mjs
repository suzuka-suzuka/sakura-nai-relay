import { assert } from './security.mjs';

// Read dimensions from submitted bytes; never trust client-provided billing dimensions.
export function imageSize(bytes) {
  let width, height;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i++] !== 255) break;
      while (bytes[i] === 255) i++;
      const marker = bytes[i++];
      if ([0xd8,0x01,...Array.from({length:8},(_,j)=>0xd0+j)].includes(marker)) continue;
      if (marker === 0xda || marker === 0xd9 || i + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(i + 3); width = bytes.readUInt16BE(i + 5); break;
      }
      i += length;
    }
  } else if (bytes.length >= 30 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') {
    const type = bytes.toString('ascii',12,16);
    if (type === 'VP8X') { width = bytes.readUIntLE(24,3) + 1; height = bytes.readUIntLE(27,3) + 1; }
    if (type === 'VP8 ' && bytes.subarray(23,26).equals(Buffer.from([157,1,42]))) { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
    if (type === 'VP8L' && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; }
  }
  assert(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0, '无法读取图片尺寸，请上传 PNG、JPEG 或 WebP 图片');
  assert(width * height <= 3145728, '图片不能超过 3,145,728 像素');
  return { width, height };
}
export function base64Size(value) {
  assert(typeof value === 'string' && value.length > 0, '缺少图片');
  return imageSize(Buffer.from(value.replace(/^data:image\/[^;]+;base64,/, ''), 'base64'));
}
