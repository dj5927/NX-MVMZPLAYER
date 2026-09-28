import { isAbsoluteResource, normalizeRelativePath, ResourceFS } from './fs';
import type { LogFn } from '../types';

export function installImagePathBridge(fs: ResourceFS, log: LogFn) {
  const g: any = globalThis as any;
  const NativeImage: any = g.Image;
  const descriptor = Object.getOwnPropertyDescriptor(NativeImage.prototype, 'src');
  const objectUrls = new WeakMap<object, string>();
  const originalUrls = new WeakMap<object, string>();

  const mimeFor = (path: string) => {
    const lower = path.toLowerCase().split('?')[0].split('#')[0];
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    return 'image/png';
  };

  const mapForImage = (image: object, value: any) => {
    const text = String(value ?? '');
    originalUrls.set(image, text);

    const previous = objectUrls.get(image);
    if (previous) {
      try { URL.revokeObjectURL(previous); } catch {}
      objectUrls.delete(image);
    }

    if (/^(?:blob:|data:|https?:|romfs:)/i.test(text)) return text;

    try {
      const path = text.startsWith('sdmc:') ? text : fs.resolve(normalizeRelativePath(text));
      const buffer = fs.readBuffer(path);
      const blob = new Blob([buffer], { type: mimeFor(path) });
      const blobUrl = URL.createObjectURL(blob);
      objectUrls.set(image, blobUrl);
      return blobUrl;
    } catch (error) {
      const fallback = isAbsoluteResource(text) ? text : fs.resolve(normalizeRelativePath(text));
      log(`[image] local blob bridge failed | ${text} | ${String(error)}`);
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
      log('Image.src ResourceFS/Blob bridge installed');
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
  log('Image.src ResourceFS/Blob bridge installed by constructor wrapper');
}