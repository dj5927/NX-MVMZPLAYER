// @ts-nocheck
import { normalizeRelativePath } from '../host/fs';

export function installMvNodeRequireCompat(ctx) {
  const g = globalThis as any;
  if (typeof g.require === 'function' && g.require.__mvmzNodeCompat) return;

  const { game, log } = ctx;
  const runtimeRoot = /\/www$/i.test(String(game.dataRoot)) ? String(game.dataRoot).replace(/\/www$/i, '') : String(game.root);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const once = new Set<string>();
  const logOnce = (key: string, message: string) => {
    if (once.has(key)) return;
    once.add(key);
    log(message);
  };

  const pathText = (value: any) => String(value ?? '').replace(/\\/g, '/');
  const normalizePath = (value: any) => {
    let raw = pathText(value);
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*:\/)/.exec(raw)?.[1] || '';
    const absolute = !scheme && raw.startsWith('/');
    if (scheme) raw = raw.slice(scheme.length);
    else if (absolute) raw = raw.slice(1);

    const out: string[] = [];
    for (const part of raw.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    const body = out.join('/');
    if (scheme) return scheme + body;
    if (absolute) return '/' + body;
    return body || '.';
  };
  const isAbsolutePath = (value: any) => /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/|\/)/.test(pathText(value));
  const dirname = (value: any) => {
    const p = normalizePath(value).replace(/\/$/, '');
    const i = p.lastIndexOf('/');
    if (i < 0) return '.';
    if (i === 0) return '/';
    if (i > 0 && p[i - 1] === ':') return p.slice(0, i + 1);
    return p.slice(0, i);
  };
  const basename = (value: any, ext?: string) => {
    const p = normalizePath(value).replace(/\/$/, '');
    let base = p.slice(p.lastIndexOf('/') + 1);
    if (ext && base.endsWith(ext)) base = base.slice(0, -String(ext).length);
    return base;
  };
  const extname = (value: any) => {
    const base = basename(value);
    const i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i) : '';
  };
  const join = (...parts: any[]) => normalizePath(parts.filter(x => x !== '').map(pathText).join('/'));
  const resolve = (...parts: any[]) => {
    let current = runtimeRoot;
    for (const part0 of parts) {
      const part = pathText(part0);
      if (!part) continue;
      current = isAbsolutePath(part) ? part : join(current, part);
    }
    return normalizePath(current);
  };
  const pathModule: any = {
    sep: '/',
    delimiter: ':',
    normalize: normalizePath,
    join,
    resolve,
    dirname,
    basename,
    extname,
    isAbsolute: isAbsolutePath,
    relative(from: any, to: any) {
      const a = normalizePath(from).split('/');
      const b = normalizePath(to).split('/');
      while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); }
      return [...a.map(() => '..'), ...b].join('/');
    }
  };

  const existsAbs = (path: string) => {
    try { return Switch.statSync(path) !== null; } catch { return false; }
  };
  const readCandidates = (value: any) => {
    const raw = pathText(value);
    if (isAbsolutePath(raw)) return [normalizePath(raw)];
    const rel = normalizeRelativePath(raw);
    return [...new Set([join(runtimeRoot, rel), join(game.dataRoot, rel), join(game.root, rel)])];
  };
  const resolveRead = (value: any) => {
    const candidates = readCandidates(value);
    for (const candidate of candidates) if (existsAbs(candidate)) return candidate;
    throw new Error(`ENOENT: no such file, open '${String(value)}' | tried=${candidates.join(' ; ')}`);
  };
  const resolveWrite = (value: any) => {
    const raw = pathText(value);
    return isAbsolutePath(raw) ? normalizePath(raw) : join(runtimeRoot, normalizeRelativePath(raw));
  };
  const encodingName = (value: any) => typeof value === 'string' ? value : value?.encoding;
  const decodeBase64 = (text: any) => {
    let value = String(text ?? '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (value.length % 4) value += '=';
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 255;
    return out;
  };
  const encodeBase64 = (data: Uint8Array) => {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.subarray(offset, Math.min(data.length, offset + chunkSize));
      let part = '';
      for (let i = 0; i < chunk.length; i++) part += String.fromCharCode(chunk[i]);
      binary += part;
    }
    return btoa(binary);
  };
  const decodeHex = (text: any) => {
    const value = String(text ?? '').replace(/\s+/g, '');
    const size = Math.floor(value.length / 2);
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      const byte = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
      out[i] = Number.isFinite(byte) ? byte & 255 : 0;
    }
    return out;
  };
  const encodeHex = (data: Uint8Array) => {
    let out = '';
    for (let i = 0; i < data.length; i++) out += data[i].toString(16).padStart(2, '0');
    return out;
  };
  const normalizeBufferEncoding = (value: any) => {
    const enc = String(value || 'utf8').toLowerCase().replace(/[-_]/g, '');
    if (enc === 'utf8' || enc === 'utf') return 'utf8';
    if (enc === 'base64') return 'base64';
    if (enc === 'hex') return 'hex';
    if (enc === 'latin1' || enc === 'binary') return 'latin1';
    if (enc === 'ascii') return 'ascii';
    return enc;
  };
  class BufferCompat extends Uint8Array {
    static from(value: any, encoding?: any) {
      if (typeof value === 'string') {
        const enc = normalizeBufferEncoding(encoding);
        if (enc === 'base64') return new BufferCompat(decodeBase64(value));
        if (enc === 'hex') return new BufferCompat(decodeHex(value));
        if (enc === 'latin1' || enc === 'ascii') {
          const out = new BufferCompat(String(value).length);
          for (let i = 0; i < out.length; i++) out[i] = String(value).charCodeAt(i) & 255;
          return out;
        }
        return new BufferCompat(encoder.encode(String(value)));
      }
      if (value instanceof ArrayBuffer) return new BufferCompat(new Uint8Array(value));
      if (ArrayBuffer.isView(value)) return new BufferCompat(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      if (value == null) return new BufferCompat(0);
      return new BufferCompat(value);
    }
    static alloc(size: any, fill: any = 0, encoding?: any) {
      const out = new BufferCompat(Math.max(0, Number(size) || 0));
      if (typeof fill === 'string') {
        const pattern = BufferCompat.from(fill, encoding);
        if (pattern.length) for (let i = 0; i < out.length; i++) out[i] = pattern[i % pattern.length];
      } else {
        out.fill(Number(fill) & 255);
      }
      return out;
    }
    static allocUnsafe(size: any) {
      return BufferCompat.alloc(size);
    }
    static isBuffer(value: any) {
      return value instanceof BufferCompat;
    }
    static byteLength(value: any, encoding?: any) {
      return BufferCompat.from(value, encoding).byteLength;
    }
    static concat(list: any[], totalLength?: any) {
      const buffers = Array.isArray(list) ? list.map(item => BufferCompat.from(item)) : [];
      const length = totalLength == null
        ? buffers.reduce((sum, item) => sum + item.length, 0)
        : Math.max(0, Number(totalLength) || 0);
      const out = new BufferCompat(length);
      let offset = 0;
      for (const item of buffers) {
        if (offset >= out.length) break;
        const take = item.subarray(0, Math.min(item.length, out.length - offset));
        out.set(take, offset);
        offset += take.length;
      }
      return out;
    }
    toString(encoding: any = 'utf8', start: any = 0, end: any = this.length) {
      const begin = Math.max(0, Math.min(this.length, Number(start) || 0));
      const finish = Math.max(begin, Math.min(this.length, end == null ? this.length : Number(end) || 0));
      const view = this.subarray(begin, finish);
      const enc = normalizeBufferEncoding(encoding);
      if (enc === 'base64') return encodeBase64(view);
      if (enc === 'hex') return encodeHex(view);
      if (enc === 'latin1' || enc === 'ascii') {
        let out = '';
        for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i] & (enc === 'ascii' ? 127 : 255));
        return out;
      }
      return decoder.decode(view);
    }
  }
  const bufferModule: any = {
    Buffer: BufferCompat,
    SlowBuffer: BufferCompat,
    INSPECT_MAX_BYTES: 50
  };
  const toWriteData = (data: any, encoding: any) =>
    typeof data === 'string' && String(encoding || '').toLowerCase() === 'base64' ? decodeBase64(data) : data;

  const openFiles = new Map<number, { path: string; flags: string }>();
  let nextFd = 100;
  const fsModule: any = {
    readFileSync(path: any, options?: any) {
      const abs = resolveRead(path);
      const data = Switch.readFileSync(abs);
      if (!data) throw new Error(`ENOENT: no such file, open '${String(path)}'`);
      const enc = String(encodingName(options) || '').toLowerCase();
      logOnce(`read:${String(path)}`, `[mv-node] fs.readFileSync | ${String(path)} -> ${abs}${enc ? ` encoding=${enc}` : ''}`);
      return enc ? decoder.decode(data) : new Uint8Array(data);
    },
    existsSync(path: any) {
      try { resolveRead(path); return true; } catch { return false; }
    },
    openSync(path: any, flags: any = 'r') {
      const mode = String(flags || 'r');
      const wantsWrite = /[wa+]/.test(mode);
      const abs = wantsWrite ? resolveWrite(path) : resolveRead(path);
      const exists = existsAbs(abs);
      if (mode.includes('x') && exists) throw new Error(`EEXIST: file already exists, open '${String(path)}'`);
      if (mode.includes('w')) {
        Switch.writeFileSync(abs, new Uint8Array(0));
      } else if (mode.includes('a')) {
        if (!exists) Switch.writeFileSync(abs, new Uint8Array(0));
      } else if (!exists) {
        throw new Error(`ENOENT: no such file, open '${String(path)}'`);
      }
      const fd = nextFd++;
      openFiles.set(fd, { path: abs, flags: mode });
      logOnce(`open:${String(path)}:${mode}`, `[mv-node] fs.openSync | ${String(path)} -> ${abs} flags=${mode}`);
      return fd;
    },
    closeSync(fd: any) {
      openFiles.delete(Number(fd));
    },
    mkdirSync(path: any) {
      Switch.mkdirSync(resolveWrite(path));
    },
    writeFileSync(path: any, data: any, options?: any) {
      Switch.writeFileSync(resolveWrite(path), toWriteData(data, encodingName(options)));
    },
    appendFileSync(path: any, data: any, options?: any) {
      Switch.appendFileSync(resolveWrite(path), toWriteData(data, encodingName(options)));
    },
    unlinkSync(path: any) {
      const abs = resolveWrite(path);
      if (existsAbs(abs)) Switch.removeSync(abs);
    },
    readdirSync(path: any) {
      return Switch.readDirSync(resolveRead(path)) ?? [];
    },
    statSync(path: any) {
      const abs = resolveRead(path);
      const stat = Switch.statSync(abs);
      if (!stat) throw new Error(`ENOENT: no such file or directory, stat '${String(path)}'`);
      let isDirectory = false;
      try { isDirectory = Switch.readDirSync(abs) !== null; } catch { isDirectory = false; }
      return { ...stat, isFile: () => !isDirectory, isDirectory: () => isDirectory };
    },
    renameSync(from: any, to: any) {
      Switch.renameSync(resolveRead(from), resolveWrite(to));
    },
    createWriteStream(path: any) {
      const abs = resolveWrite(path);
      const chunks: string[] = [];
      let ended = false;
      const stream: any = {
        write(chunk: any) {
          if (ended) return false;
          chunks.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk));
          return true;
        },
        end(chunk: any = '') {
          if (ended) return;
          if (chunk !== undefined && chunk !== null && String(chunk).length) chunks.push(String(chunk));
          ended = true;
          Switch.writeFileSync(abs, chunks.join(''));
        },
        on() { return stream; },
        once() { return stream; }
      };
      return stream;
    },
    readFile(path: any, options: any, callback?: any) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      Promise.resolve().then(() => callback?.(null, fsModule.readFileSync(path, options))).catch(error => callback?.(error));
    },
    writeFile(path: any, data: any, options: any, callback?: any) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      Promise.resolve().then(() => { fsModule.writeFileSync(path, data, options); callback?.(null); }).catch(error => callback?.(error));
    },
    mkdir(path: any, options: any, callback?: any) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      Promise.resolve().then(() => { fsModule.mkdirSync(path); callback?.(null); }).catch(error => callback?.(error));
    },
    unlink(path: any, callback?: any) {
      Promise.resolve().then(() => { fsModule.unlinkSync(path); callback?.(null); }).catch(error => callback?.(error));
    },
    rename(from: any, to: any, callback?: any) {
      Promise.resolve().then(() => { fsModule.renameSync(from, to); callback?.(null); }).catch(error => callback?.(error));
    }
  };

  const winStub: any = {
    showDevTools() {
      logOnce('nw-devtools', '[mv-node] nw.gui showDevTools ignored on HOS');
      return null;
    },
    close() { try { g.close?.(); } catch {} },
    focus() {}, blur() {}, show() {}, hide() {}, minimize() {}, maximize() {}, restore() {},
    moveTo() {}, moveBy() {}, resizeTo() {}, resizeBy() {},
    isDevToolsOpen() { return false; }
  };
  const nwGuiModule: any = {
    Window: {
      get() { return winStub; },
      open(_url: any, _options: any, callback?: any) { callback?.(winStub); return winStub; }
    },
    App: { quit() { try { g.close?.(); } catch {} }, dataPath: runtimeRoot, fullArgv: [] },
    Shell: { openExternal() {}, openItem() {}, showItemInFolder() {} }
  };
  const childProcessModule: any = {
    exec(command: any, options: any, callback?: any) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      logOnce(`exec:${String(command)}`, `[mv-node] child_process.exec ignored on HOS | ${String(command)}`);
      Promise.resolve().then(() => callback?.(null, '', ''));
      return { pid: 0, kill() {}, on() { return this; }, once() { return this; } };
    }
  };

  const greenworksStub: any = {
    _version: 'mvmz-hos-stub',
    initAPI() {
      logOnce('greenworks', '[mv-node] Steam/Greenworks unavailable on HOS -> safe stub active');
      return false;
    },
    isSteamRunning() { return false; },
    isCloudEnabledForUser() { return false; },
    isCloudEnabled() { return false; },
    enableCloud() {},
    getSteamId() { return null; },
    getAchievementNames() { return []; },
    getNumberOfAchievements() { return 0; },
    getCurrentGameLanguage() { return 'koreana'; },
    isGameOverlayEnabled() { return false; },
    activateGameOverlay() {},
    activateGameOverlayToWebPage() {},
    activateAchievement(_name: any, ok?: any) { ok?.(); },
    clearAchievement(_name: any, ok?: any) { ok?.(); },
    getAchievement(_name: any, ok?: any) { ok?.(false); },
    getNumberOfPlayers(ok?: any) { ok?.(0); },
    getCloudQuota(ok?: any) { ok?.(0, 0); },
    saveTextToFile(_file: any, _contents: any, ok?: any) { ok?.(); },
    readTextFromFile(_file: any, ok?: any, fail?: any) { fail?.(new Error('Steam cloud unavailable on HOS')); },
    on() { return greenworksStub; },
    emit() { return false; }
  };
  const requireCompat: any = function(name: any) {
    const id = String(name || '').replace(/\\\\/g, '/');
    if (/^(?:\.\/)?js\/libs\/greenwo