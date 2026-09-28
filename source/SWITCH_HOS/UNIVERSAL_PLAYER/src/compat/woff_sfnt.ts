// WOFF1 -> SFNT converter for runtimes that can register TTF/OTF but do not
// reliably rasterize WOFF-backed FontFace entries.
// @ts-ignore - pako v1 ships without TypeScript declarations in this tree.
import * as pako from 'pako';

function align4(value: number) { return (value + 3) & ~3; }
function tagString(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

export function isWoff1(data: ArrayBuffer | ArrayBufferView) {
  const bytes = data instanceof Uint8Array
    ? data
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
  return bytes.byteLength >= 4 && tagString(bytes, 0) === 'wOFF';
}

export function woff1ToSfnt(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  const bytes = data instanceof Uint8Array
    ? data
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
  if (bytes.byteLength < 44 || tagString(bytes, 0) !== 'wOFF') throw new Error('not WOFF1');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = view.getUint16(12, false);
  const declaredLength = view.getUint32(8, false);
  if (declaredLength > bytes.byteLength || numTables <= 0 || 44 + numTables * 20 > bytes.byteLength) {
    throw new Error(`invalid WOFF header length=${declaredLength} bytes=${bytes.byteLength} tables=${numTables}`);
  }
  const flavor = view.getUint32(4, false);
  const records: any[] = [];
  let sfntOffset = 12 + numTables * 16;
  for (let i = 0; i < numTables; i++) {
    const p = 44 + i * 20;
    const tag = view.getUint32(p, false);
    const offset = view.getUint32(p + 4, false);
    const compLength = view.getUint32(p + 8, false);
    const origLength = view.getUint32(p + 12, false);
    const checksum = view.getUint32(p + 16, false);
    if (offset + compLength > bytes.byteLength || !origLength) throw new Error(`invalid WOFF table ${i}`);
    const compressed = bytes.subarray(offset, offset + compLength);
    let table: Uint8Array;
    if (compLength < origLength) {
      const inflated: any = (pako as any).inflate(compressed);
      table = inflated instanceof Uint8Array ? inflated : new Uint8Array(inflated);
      if (table.byteLength !== origLength) throw new Error(`WOFF inflate length mismatch table=${i} got=${table.byteLength} expected=${origLength}`);
    } else {
      table = new Uint8Array(origLength);
      table.set(compressed.subarray(0, origLength));
    }
    records.push({ tag, checksum, offset: sfntOffset, length: origLength, table });
    sfntOffset += align4(origLength);
  }
  const out = new Uint8Array(sfntOffset);
  const o = new DataView(out.buffer);
  o.setUint32(0, flavor, false);
  o.setUint16(4, numTables, false);
  let maxPow2 = 1, entrySelector = 0;
  while ((maxPow2 << 1) <= numTables) { maxPow2 <<= 1; entrySelector++; }
  const searchRange = maxPow2 * 16;
  o.setUint16(6, searchRange, false);
  o.setUint16(8, entrySelector, false);
  o.setUint16(10, numTables * 16 - searchRange, false);
  let headOffset = -1;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const p = 12 + i * 16;
    o.setUint32(p, rec.tag, false);
    o.setUint32(p + 4, rec.checksum, false);
    o.setUint32(p + 8, rec.offset, false);
    o.setUint32(p + 12, rec.length, false);
    out.set(rec.table, rec.offset);
    if (rec.tag === 0x68656164) headOffset = rec.offset; // 'head'
  }
  // Recompute SFNT head.checkSumAdjustment for the reconstructed file.
  if (headOffset >= 0 && headOffset + 12 <= out.byteLength) {
    o.setUint32(headOffset + 8, 0, false);
    let sum = 0;
    for (let p = 0; p < out.byteLength; p += 4) {
      const b0 = out[p] || 0, b1 = out[p + 1] || 0, b2 = out[p + 2] || 0, b3 = out[p + 3] || 0;
      sum = (sum + (((b0 << 24) >>> 0) | (b1 << 16) | (b2 << 8) | b3)) >>> 0;
    }
    o.setUint32(headOffset + 8, (0xb1b0afba - sum) >>> 0, false);
  }
  return out;
}