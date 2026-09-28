import type { LogFn } from '../types';

const decoder = new TextDecoder();

export function normalizeRelativePath(input: string) {
  let value = String(input ?? '').replace(/\\/g, '/').split('#')[0].split('?')[0];
  while (value.startsWith('./')) value = value.slice(2);
  while (value.startsWith('/')) value = value.slice(1);
  try { value = decodeURIComponent(value); } catch {}
  const out: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export function isAbsoluteResource(url: string) {
  return /^(?:blob:|data:|https?:|sdmc:|romfs:)/i.test(String(url));
}

export class ResourceFS {
  private dirCache = new Map<string, Map<string, string>>();
  private resolvedPathCache = new Map<string, string>();
  private pathAliases = new Map<string, string>();
  private pathAliasesFolded = new Map<string, string>();
  private aliasLog = new Set<string>();

  constructor(readonly root: string, private readonly log: LogFn) {
    this.loadPathManifest();
    this.log('[fs] resolved-path cache enabled | sync I/O semantics preserved');
  }

  private aliasKeys(input: string) {
    const rel = normalizeRelativePath(input);
    const keys = new Set<string>([rel]);
    try { keys.add(rel.normalize('NFC')); } catch {}
    try { keys.add(rel.normalize('NFKC')); } catch {}
    return [...keys];
  }

  private loadPathManifest() {
    const manifestPath = `${this.root}/.mvmz_paths.json`;
    try {
      if (!this.existsAbsolute(manifestPath)) return;
      const raw = Switch.readFileSync(manifestPath);
      if (!raw) return;
      const parsed = JSON.parse(decoder.decode(raw));
      const paths = parsed?.paths;
      if (!paths || typeof paths !== 'object') return;
      let count = 0;
      for (const [original, safe] of Object.entries(paths)) {
        if (typeof safe !== 'string') continue;
        const safeRel = normalizeRelativePath(safe);
        if (!safeRel) continue;
        for (const key of this.aliasKeys(String(original))) {
          this.pathAliases.set(key, safeRel);
          this.pathAliasesFolded.set(key.toLowerCase(), safeRel);
        }
        count++;
      }
      this.log(`[fs-map] unicode path manifest loaded | entries=${count} root=${this.root}`);
    } catch (error) {
      this.log(`[fs-map] unicode path manifest FAILED | ${manifestPath} | ${String(error)}`);
    }
  }

  private resolveAlias(rel: string) {
    let safe: string | undefined;
    for (const key of this.aliasKeys(rel)) {
      safe = this.pathAliases.get(key) ?? this.pathAliasesFolded.get(key.toLowerCase());
      if (safe) break;
    }
    if (!safe) return null;
    const candidate = `${this.root}/${safe}`;
    if (!this.existsAbsolute(candidate)) {
      this.log(`[fs-map] mapped file missing | ${rel} -> ${safe}`);
      return null;
    }
    if (!this.aliasLog.has(rel)) {
      this.aliasLog.add(rel);
      this.log(`[fs-map] alias | ${rel} -> ${safe}`);
    }
    return candidate;
  }

  existsAbsolute(path: string) {
    try { return Switch.statSync(path) !== null; } catch { return false; }
  }

  private readDirMap(dir: string) {
    let cached = this.dirCache.get(dir);
    if (cached) return cached;
    cached = new Map();
    try {
      for (const name of Switch.readDirSync(dir) ?? []) {
        cached.set(name.toLowerCase(), name);
      }
    } catch {}
    this.dirCache.set(dir, cached);
    return cached;
  }

  resolve(relativeOrAbsolute: string) {
    const raw = String(relativeOrAbsolute);
    if (raw.startsWith('sdmc:') || raw.startsWith('romfs:')) return raw;
    const rel = normalizeRelativePath(raw);
    const cached = this.resolvedPathCache.get(rel);
    if (cached) return cached;
    const mapped = this.resolveAlias(rel);
    if (mapped) {
      this.resolvedPathCache.set(rel, mapped);
      return mapped;
    }
    const exact = `${this.root}/${rel}`;
    if (this.existsAbsolute(exact)) {
      this.resolvedPathCache.set(rel, exact);
      return exact;
    }

    let current = this.root;
    for (const segment of rel.split('/')) {
      if (!segment) continue;
      const actual = this.readDirMap(current).get(segment.toLowerCase());
      if (!actual) return exact;
      current = `${current}/${actual}`;
    }
    this.resolvedPathCache.set(rel, current);
    return current;
  }

  exists(relativeOrAbsolute: string) {
    return this.existsAbsolute(this.resolve(relativeOrAbsolute));
  }

  readBuffer(relativeOrAbsolute: string) {
    const path = this.resolve(relativeOrAbsolute);
    const buffer = Switch.readFileSync(path);
    if (!buffer) throw new Error(`File not found: ${path}`);
    return buffer;
  }

  readText(relativeOrAbsolute: string) {
    return decoder.decode(this.readBuffer(relativeOrAbsolute));
  }

  writeTextAbsolute(path: string, text: string) {
    const slash = path.lastIndexOf('/');
    if (slash > 0) Switch.mkdirSync(path.slice(0, slash));
    Switch.writeFileSync(path, text);
  }

  removeAbsolute(path: string) {
    try { if (this.existsAbsolute(path)) Switch.removeSync(path); } catch (error) {
      this.log(`[fs] remove failed | ${path} | ${String(error)}`);
    }
  }

  invalidate() {
    this.dirCache.clear();
    this.resolvedPathCache.clear();
  }
}
