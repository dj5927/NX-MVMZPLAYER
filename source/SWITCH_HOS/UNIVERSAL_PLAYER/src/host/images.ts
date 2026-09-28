import { isAbsoluteResource, normalizeRelativePath, readFileAsyncBounded, ResourceFS } from './fs';
import type { LogFn } from '../types';

export function installImagePathBridge(fs: ResourceFS, log: LogFn) {
  const g: any = globalThis as any;
  const NativeImage: any = g.Image;
  const descriptor = Object.getOwnPropertyDescriptor(NativeImage.prototype, 'src');
  const originalUrls = new WeakMap<object, string>();

  if (!g.__mvmzLocalFileFetchBridge && typeof g.fetch === 'function' && typeof g.Response === 'function') {
    const nativeFetch = g.fetch.bind(g);
    const decodeLocalUrl = (value: string) => {
      try { return decodeURIComponent(value); } catch {}
      try { return decodeURIComponent(value.replace(/%(?![0-9a-fA-F]{2})/g, '%25')); } catch {}
      return value;
    };
    g.__mvmzLocalFileFetchBridge = true;
    g.fetch = function(input: any, init?: any) {
      try {
        const raw = String(input?.url ?? input?.href ?? input ?? '');
        const url = new URL(raw, String(g.location?.href || 'sdmc:/'));
        if (/^(?:sdmc:|romfs:|file:)$/.test(url.protocol)) {
          const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
          if (method !== 'GET') return nativeFetch(input, init);
          const signal = init?.signal ?? input?.signal;
          if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
          let path = decodeLocalUrl(url.href);
          if (url.protocol === 'file:') path = `sdmc:${decodeLocalUrl(url.pathname)}`;
          return readFileAsyncBounded(path).then((buffer: ArrayBuffer | null) => {
            if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
            const headers = new Headers();
            if (buffer) headers.set('content-length', String(buffer.byteLength));
            return new Response(buffer, { status: buffer ? 200 : 404, headers });
          });
        }
      } catch {
        // Fall through to the nx.js fetch implementation for non-local URLs
        // and unusual Request subclasses.
      }
      return nativeFetch(input, init);
    };
    log('[fetch] async local file bridge installed | sdmc/romfs/file percent-decoded via Switch.readFile');
  }

  const mapForImage = (image: object, value: any) => {
    const text = String(value ?? '');
    originalUrls.set(image, text);

    // nx.js Image.src already loads sdmc:/romfs:/file: URLs through the
    // runtime's asynchronous fetch/readFile path.  Older compatibility code
    // synchronously read every local image on the JS thread, copied it into a
    // Blob, then asked Image to fetch/decode that Blob again.  Resolve only
    // the game-relative/case-folded path here and let the native Image loader
    // perform the actual file I/O asynchronously.
    if (/^(?:blob:|data:|https?:|sdmc:|romfs:|file:)/i.test(text)) return text;

    try {
      return fs.resolve(normalizeRelativePath(text));
    } catch (error) {
      const fallback = isAbsoluteResource(text) ? text : fs.resolve(normalizeRelativePath(text));
      log(`[image] local direct-path bridge failed | ${text} | ${String(error)}`);
      return fallback;
    }
  };

  if (descriptor?.set && descriptor?.get) {
    try {
      Object.defineProperty(NativeImage.prototype, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: function() { return originalUrls.get(this) ?? descriptor.get!.call(this); },
        set: function(value: any) { descriptor.set!.call(this, mapForImage(this, value)); }
      });
      log('Image.src ResourceFS direct sdmc async bridge installed');
      return;
    } catch (error) {
      log(`Image.src prototype bridge failed, using constructor wrapper | ${String(error)}`);
    }
  }

  function GameImage(this: any) {
    const image = new NativeImage();
    if (descriptor?.set && descriptor?.get) {
      Object.defineProperty(image, 'src', {
        configurable: true,
        get: () => originalUrls.get(image) ?? descriptor.get!.call(image),
        set: (value: any) => descriptor.set!.call(image, mapForImage(image, value))
      });
    }
    return image;
  }
  GameImage.prototype = NativeImage.prototype;
  g.Image = GameImage;
  log('Image.src ResourceFS direct sdmc async bridge installed by constructor wrapper');
}