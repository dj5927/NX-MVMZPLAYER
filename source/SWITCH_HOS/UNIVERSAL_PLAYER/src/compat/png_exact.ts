// pngjs ships a self-contained browser bundle (Buffer/zlib/pako included).
// Use that bundle instead of the Node entry so nx.js does not need Node built-ins.
// @ts-ignore - pngjs/browser.js has no TypeScript declaration file.
import pngBrowser from 'pngjs/browser.js';

export type ExactPngDecode = {
  width: number;
  height: number;
  data: Uint8Array;
};

export function decodePngExact(bytes: ArrayBuffer | Uint8Array): Promise<ExactPngDecode> {
  const PNG = (pngBrowser as any)?.PNG;
  if (!PNG) return Promise.reject(new Error('pngjs browser PNG export unavailable'));
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new Promise((resolve, reject) => {
    try {
      const parser = new PNG({ checkCRC: true });
      parser.parse(input, (error: any, png: any) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const width = Math.max(1, Number(png?.width || 0));
          const height = Math.max(1, Number(png?.height || 0));
          const expected = width * height * 4;
          const source = png?.data;
          if (!source || Number(source.length || 0) !== expected) {
            reject(new Error(`pngjs RGBA length mismatch ${width}x${height} got=${Number(source?.length || 0)}`));
            return;
          }
          const data = new Uint8Array(expected);
          data.set(source);
          resolve({ width, height, data });
        } catch (inner) {
          reject(inner);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}