import { normalizeRelativePath } from './fs';
import type { RuntimeContext } from '../types';

type OptEntry = {
  logical?: string;
  cache?: string;
  width?: number;
  height?: number;
  raw_bytes?: number;
};

type OptManifest = {
  format?: string;
  version?: number;
  engine?: string;
  game_fingerprint?: {
    system_fnv1a32?: string;
    system_bytes?: number;
  };
  entries?: Record<string, OptEntry>;
};

export type OptCanvas = {
  canvas: any;
  context: any;
  width: number;
  height: number;
  payloadLength: number;
  cachePath: string;
  logical: string;
};

function fnv1a32Hex(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let value = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    value ^= bytes[i];
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

function canonicalLogical(input: string) {
  return normalizeRelativePath(input).replace(/\\/g, '/').toLowerCase();
}

export class MvmzOptCache {
  private manifest: OptManifest | null = null;
  private valid = false;
  private hitLogs = 0;
  private missLogs = 0;

  constructor(private readonly ctx: RuntimeContext, private readonly expectedEngine: 'MV' | 'MZ') {
    this.loadManifest();
  }

  private loadManifest() {
    const { fs, log } = this.ctx;
    const manifestPath = '.mvmz_opt/manifest.json';
    try {
      if (!fs.exists(manifestPath)) {
        log('[mvmz-opt] disabled | manifest not found');
        return;
      }
      const parsed = JSON.parse(fs.readText(manifestPath)) as OptManifest;
      if (parsed?.format !== 'MVMZOPT' || Number(parsed?.version) !== 1) {
        log(`[mvmz-opt] disabled | unsupported manifest format=${String(parsed?.format)} version=${String(parsed?.version)}`);
        return;
      }
      if (String(parsed?.engine || '').toUpperCase() !== this.expectedEngine) {
        log(`[mvmz-opt] disabled | engine mismatch manifest=${String(parsed?.engine)} runtime=${this.expectedEngine}`);
        return;
      }
      if (!parsed.entries || typeof parsed.entries !== 'object') {
        log('[mvmz-opt] disabled | manifest entries missing');
        return;
      }
      const expected = parsed.game_fingerprint;
      if (!expected?.system_fnv1a32 || typeof expected.system_bytes !== 'number') {
        log('[mvmz-opt] disabled | fingerprint missing');
        return;
      }
      const system = fs.readBuffer('data/System.json');
      const actualHash = fnv1a32Hex(system);
      const actualBytes = system.byteLength;
      if (String(expected.system_fnv1a32).toLowerCase() !== actualHash || Number(expected.system_bytes) !== actualBytes) {
        log(`[mvmz-opt] disabled | fingerprint mismatch expected=${expected.system_fnv1a32}/${expected.system_bytes} actual=${actualHash}/${actualBytes}`);
        return;
      }
      this.manifest = parsed;
      this.valid = true;
      log(`[mvmz-opt] enabled | engine=${this.expectedEngine} entries=${Object.keys(parsed.entries).length} fingerprint=${actualHash}/${actualBytes}`);
    } catch (error) {
      log(`[mvmz-opt] disabled | manifest validation failed | ${String(error)}`);
      this.manifest = null;
      this.valid = false;
    }
  }

  isEnabled() {
    return this.valid;
  }

  has(logical: string) {
    if (!this.valid || !this.manifest?.entries) return false;
    return !!this.manifest.entries[canonicalLogical(logical)];
  }

  loadCanvas(logicalInput: string): OptCanvas | null {
    if (!this.valid || !this.manifest?.entries) return null;
    const logical = canonicalLogical(logicalInput);
    const entry = this.manifest.entries[logical];
    if (!entry || typeof entry.cache !== 'string') {
      if (this.missLogs < 8) {
        this.missLogs++;
        this.ctx.log(`[mvmz-opt] miss | ${logicalInput}`);
        if (this.missLogs === 8) this.ctx.log('[mvmz-opt] further miss logs suppressed');
      }
      return null;
    }
    const cacheRel = normalizeRelativePath(entry.cache);
    if (!cacheRel || cacheRel.includes('..')) return null;
    const cachePath = `.mvmz_opt/${cacheRel}`;
    try {
      if (!this.ctx.fs.exists(cachePath)) {
        this.ctx.log(`[mvmz-opt] fallback | cache file missing ${cachePath}`);
        return null;
      }
      const bytes = this.ctx.fs.readBuffer(cachePath);
      if (bytes.byteLength < 24) throw new Error('cache file too small');
      const raw = new Uint8Array(bytes);
      const magic = String.fromCharCode(...raw.subarray(0, 8));
      if (magic !== 'MVMZRGBA') throw new Error(`bad cache magic: ${magic}`);
      const view = new DataView(bytes);
      const version = view.getUint32(8, true);
      const width = view.getUint32(12, true);
      const height = view.getUint32(16, true);
      const payloadLength = view.getUint32(20, true);
      const expectedLength = width * height * 4;
      if (version !== 1) throw new Error(`unsupported cache version: ${version}`);
      if (!width || !height || payloadLength !== expectedLength || 24 + payloadLength > bytes.byteLength) {
        throw new Error(`invalid cache geometry ${width}x${height} payload=${payloadLength}`);
      }
      const document: any = (globalThis as any).document;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D canvas context unavailable');
      const imageData = context.createImageData(width, height);
      imageData.data.set(new Uint8ClampedArray(bytes, 24, payloadLength));
      context.putImageData(imageData, 0, 0);
      try { canvas.src = String(logicalInput || entry.logical || logical); } catch {}
      if (this.hitLogs < 40) {
        this.hitLogs++;
        this.ctx.log(`[mvmz-opt] HIT | ${logicalInput} -> ${cachePath} ${width}x${height} rawMiB=${(payloadLength / 1048576).toFixed(2)}`);
        if (this.hitLogs === 40) this.ctx.log('[mvmz-opt] further HIT logs suppressed');
      }
      return { canvas, context, width, height, payloadLength, cachePath, logical };
    } catch (error) {
      this.ctx.log(`[mvmz-opt] fallback | ${cachePath} | ${String(error)}`);
      return null;
    }
  }
}

