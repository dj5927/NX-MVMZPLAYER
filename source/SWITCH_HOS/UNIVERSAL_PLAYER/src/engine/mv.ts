// @ts-nocheck
import { extractScriptSources } from '../host/scripts';
import { normalizeRelativePath } from '../host/fs';
import { installMvNativeVideoBridge } from './mv_video';
import { installMvNativeAudioStream } from './mv_audio_stream';
import { installMvNodeRequireCompat } from './mv_node_compat';
import { decodePngExact } from '../compat/png_exact';

var FPSMeterStub = class {
  isPaused = false;
  constructor(_options) {
  }
  hide() {
    this.isPaused = true;
  }
  show() {
    this.isPaused = false;
  }
  tickStart() {
  }
  tick() {
  }
  showFps() {
    this.isPaused = false;
  }
  showDuration() {
    this.isPaused = false;
  }
};
function installFpsFallback(log) {
  const g = globalThis;
  if (typeof g.FPSMeter !== "function") {
    g.FPSMeter = FPSMeterStub;
    log("[mv] FPSMeter fallback installed");
  }
}
function toFontBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}
function findSfntTable(data, wanted) {
  try {
    const bytes = toFontBytes(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 12) return null;
    const count = view.getUint16(4, false);
    for (let i = 0; i < count; i++) {
      const p = 12 + i * 16;
      if (p + 16 > bytes.byteLength) break;
      const tag = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
      if (tag !== wanted) continue;
      const offset = view.getUint32(p + 8, false);
      const length = view.getUint32(p + 12, false);
      if (offset + length > bytes.byteLength) return null;
      return { bytes, view, offset, length };
    }
  } catch {
  }
  return null;
}
function extractSfntFamilyNames(data) {
  const table = findSfntTable(data, "name");
  if (!table) return [];
  const { bytes, view, offset } = table;
  const names = /* @__PURE__ */ new Set();
  try {
    const count = view.getUint16(offset + 2, false);
    const stringBase = offset + view.getUint16(offset + 4, false);
    for (let i = 0; i < count; i++) {
      const p = offset + 6 + i * 12;
      const platform = view.getUint16(p, false);
      const nameId = view.getUint16(p + 6, false);
      if (nameId !== 1 && nameId !== 16) continue;
      const length = view.getUint16(p + 8, false);
      const start = stringBase + view.getUint16(p + 10, false);
      if (start + length > bytes.byteLength) continue;
      let value = "";
      if (platform === 0 || platform === 3) {
        for (let j = 0; j + 1 < length; j += 2) value += String.fromCharCode(bytes[start + j] << 8 | bytes[start + j + 1]);
      } else {
        for (let j = 0; j < length; j++) value += String.fromCharCode(bytes[start + j]);
      }
      value = value.replace(/\u0000/g, "").trim();
      if (value) names.add(value);
    }
  } catch {
  }
  return [...names];
}
function sfntHasCodePoint(data, codePoint) {
  const table = findSfntTable(data, "cmap");
  if (!table) return false;
  const { view, offset, length } = table;
  const end = offset + length;
  try {
    const count = view.getUint16(offset + 2, false);
    const subtables = [];
    for (let i = 0; i < count; i++) {
      const p = offset + 4 + i * 8;
      const sub = offset + view.getUint32(p + 4, false);
      if (sub + 2 <= end) subtables.push({ sub, format: view.getUint16(sub, false) });
    }
    subtables.sort((a, b) => (b.format === 12 ? 1 : 0) - (a.format === 12 ? 1 : 0));
    for (const item of subtables) {
      const sub = item.sub;
      if (item.format === 12 && sub + 16 <= end) {
        const groups = view.getUint32(sub + 12, false);
        for (let i = 0; i < groups; i++) {
          const p = sub + 16 + i * 12;
          if (p + 12 > end) break;
          const start = view.getUint32(p, false);
          const finish = view.getUint32(p + 4, false);
          if (codePoint >= start && codePoint <= finish) return true;
        }
      } else if (item.format === 4 && codePoint <= 65535 && sub + 16 <= end) {
        const segCount = view.getUint16(sub + 6, false) / 2;
        const endCode = sub + 14;
        const startCode = endCode + segCount * 2 + 2;
        const idDelta = startCode + segCount * 2;
        const idRangeOffset = idDelta + segCount * 2;
        for (let i = 0; i < segCount; i++) {
          const finish = view.getUint16(endCode + i * 2, false);
          const start = view.getUint16(startCode + i * 2, false);
          if (codePoint < start || codePoint > finish) continue;
          const delta = view.getInt16(idDelta + i * 2, false);
          const range = view.getUint16(idRangeOffset + i * 2, false);
          if (range === 0) return ((codePoint + delta) & 65535) !== 0;
          const rp = idRangeOffset + i * 2;
          const gp = rp + range + (codePoint - start) * 2;
          if (gp + 2 > end) return false;
          let glyph = view.getUint16(gp, false);
          if (glyph !== 0) glyph = glyph + delta & 65535;
          return glyph !== 0;
        }
      }
    }
  } catch {
  }
  return false;
}
function registerFontAliases(data, aliases, log) {
  const g = globalThis;
  g.__mvmzCustomFontFamilies = g.__mvmzCustomFontFamilies || /* @__PURE__ */ new Set();
  g.__mvmzHangulFontFamilies = g.__mvmzHangulFontFamilies || /* @__PURE__ */ new Set();
  const supportsHangul = sfntHasCodePoint(data, 0xD55C);
  for (const alias of aliases) {
    const family = String(alias || "").trim();
    if (!family || g.__mvmzCustomFontFamilies.has(family)) continue;
    try {
      const face = new FontFace(family, data);
      g.fonts?.add(face);
      g.__mvmzCustomFontFamilies.add(family);
      if (supportsHangul) g.__mvmzHangulFontFamilies.add(family);
      log(`[mv-font] custom family registered | ${family} hangul=${supportsHangul} status=${face.status}`);
    } catch (error) {
      log(`[mv-font] custom family registration FAILED | ${family} | ${String(error)}`);
    }
  }
  return supportsHangul;
}
function registerGameFont(ctx) {
  const { fs, log } = ctx;
  if (!fs.exists("fonts/gamefont.css")) return;
  try {
    const css = fs.readText("fonts/gamefont.css");
    const family = (css.match(/font-family\s*:\s*["']?([^;"']+)/i)?.[1] ?? "GameFont").trim();
    const file = css.match(/url\(["']?([^"')]+)["']?\)/i)?.[1];
    if (!file) return;
    const clean = file.replace(/^\.\//, "");
    const buffer = fs.readBuffer(`fonts/${clean}`);
    const internalFamilies = extractSfntFamilyNames(buffer);
    registerFontAliases(buffer, [family, ...internalFamilies], log);
    log(`[mv] font registered | ${family} <- ${clean} internal=${internalFamilies.join(" | ") || "unknown"}`);
  } catch (error) {
    log(`[mv] font registration fallback | ${String(error)}`);
  }
}
function installMvFontBridge(ctx) {
  const g = globalThis;
  if (!g.Graphics) return;
  const registered = /* @__PURE__ */ new Set();
  registered.add("GameFont");
  g.Graphics.loadFont = function(name, url) {
    try {
      const clean = String(url || "").replace(/^\.\//, "");
      const buffer = ctx.fs.readBuffer(clean);
      const internalFamilies = extractSfntFamilyNames(buffer);
      registerFontAliases(buffer, [name, ...internalFamilies], ctx.log);
      registered.add(name);
      ctx.log(`[mv-font] registered | ${name} <- ${clean} internal=${internalFamilies.join(" | ") || "unknown"}`);
    } catch (error) {
      ctx.log(`[mv-font] registration FAILED | ${name} <- ${url} | ${String(error)}`);
      throw error;
    }
  };
  const originalIsFontLoaded = g.Graphics.isFontLoaded?.bind(g.Graphics);
  g.Graphics.isFontLoaded = function(name) {
    if (registered.has(name)) return true;
    try {
      if (g.fonts?.check?.(`10px "${name}"`)) return true;
    } catch {
    }
    try {
      return !!originalIsFontLoaded?.(name);
    } catch {
      return false;
    }
  };
  ctx.log("[mv-font] Graphics.loadFont/isFontLoaded bridge installed");
}
function installMvKoreanFontFallback(ctx) {
  const g = globalThis;
  if (!g.Bitmap?.prototype?._makeFontNameText) return;
  const family = "MVMZ_KoreanFallback";
  try {
    if (!g.__mvmzKoreanFallbackLoaded) {
      const data = Switch.readFileSync("romfs:/fonts/NotoSansCJKkr-Regular.otf");
      if (!data) throw new Error("romfs fallback font not found");
      const face = new FontFace(family, data);
      g.fonts?.add(face);
      g.__mvmzKoreanFallbackLoaded = true;
      ctx.log(`[mv-font] Korean fallback registered | ${family} status=${face.status}`);
      try {
        const canvas = g.document.createElement("canvas");
        canvas.width = 192;
        canvas.height = 48;
        const c = canvas.getContext("2d");
        if (c) {
          const hashText = (text) => {
            c.clearRect(0, 0, 192, 48);
            c.font = `32px ${family}`;
            c.fillStyle = "#fff";
            c.fillText(text, 0, 36);
            const pixels = c.getImageData(0, 0, 192, 48).data;
            let hash = 2166136261;
            let ink = 0;
            for (let i = 0; i < pixels.length; i++) {
              hash ^= pixels[i];
              hash = Math.imul(hash, 16777619) >>> 0;
              if ((i & 3) === 3 && pixels[i]) ink++;
            }
            return { hash: hash.toString(16).padStart(8, "0"), ink };
          };
          const korean = hashText("\uD55C\uAE00\uAC00\uD7A3");
          const missing = hashText("\u0378\u0378\u0378\u0378");
          ctx.log(`[mv-font] Korean fallback canvas probe | koreanHash=${korean.hash} missingHash=${missing.hash} different=${korean.hash !== missing.hash} inkPixels=${korean.ink}`);
        }
      } catch (probeError) {
        ctx.log(`[mv-font] Korean fallback canvas probe FAILED | ${String(probeError)}`);
      }
    }
  } catch (error) {
    ctx.log(`[mv-font] Korean fallback registration FAILED | ${String(error)}`);
    return;
  }
  const hasHangul = (value) => /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/.test(String(value ?? ""));
  const usesHangulCapableGameFont = (bitmap) => {
    const capable = g.__mvmzHangulFontFamilies;
    if (!capable?.size) return false;
    const stack = String(bitmap?.fontFace || "").split(",").map((name) => name.trim().replace(/^["']|["']$/g, ""));
    for (const name of stack) {
      if (capable.has(name)) return true;
    }
    return false;
  };
  if (!g.Bitmap.prototype.drawText?.__mvmzKoreanDirectDraw) {
    const originalDrawText = g.Bitmap.prototype.drawText;
    const directDrawText = function(text, ...args) {
      if (!hasHangul(text)) return originalDrawText.call(this, text, ...args);
      if (usesHangulCapableGameFont(this)) {
        if (!g.__mvmzGameHangulFontLogged) {
          g.__mvmzGameHangulFontLogged = true;
          ctx.log(`[mv-font] Hangul kept on game font | fontFace=${String(this.fontFace || "")}`);
        }
        return originalDrawText.call(this, text, ...args);
      }
      if (!g.__mvmzKoreanDirectDrawLogged) {
        g.__mvmzKoreanDirectDrawLogged = true;
        ctx.log("[mv-font] first Hangul draw routed directly to MVMZ_KoreanFallback");
      }
      const previousFace = this.fontFace;
      this.fontFace = family;
      try {
        return originalDrawText.call(this, text, ...args);
      } finally {
        this.fontFace = previousFace;
      }
    };
    directDrawText.__mvmzKoreanDirectDraw = true;
    g.Bitmap.prototype.drawText = directDrawText;
  }
  if (!g.Bitmap.prototype.measureTextWidth?.__mvmzKoreanDirectMeasure) {
    const originalMeasureTextWidth = g.Bitmap.prototype.measureTextWidth;
    const directMeasureTextWidth = function(text) {
      if (!hasHangul(text)) return originalMeasureTextWidth.call(this, text);
      if (usesHangulCapableGameFont(this)) return originalMeasureTextWidth.call(this, text);
      const previousFace = this.fontFace;
      this.fontFace = family;
      try {
        return originalMeasureTextWidth.call(this, text);
      } finally {
        this.fontFace = previousFace;
      }
    };
    directMeasureTextWidth.__mvmzKoreanDirectMeasure = true;
    g.Bitmap.prototype.measureTextWidth = directMeasureTextWidth;
  }
  if (!g.Bitmap.prototype._makeFontNameText.__mvmzKoreanFallback) {
    const originalMakeFontNameText = g.Bitmap.prototype._makeFontNameText;
    const patched = function() {
      const base = String(originalMakeFontNameText.call(this));
      if (base.includes(family)) return base;
      return `${base}, ${family}`;
    };
    patched.__mvmzKoreanFallback = true;
    g.Bitmap.prototype._makeFontNameText = patched;
    ctx.log("[mv-font] Korean fallback family appended to Bitmap font stack");
  }
  ctx.log("[mv-font] Korean direct draw/measure routing verified");
}
function installMvNeutralUiCompat(ctx) {
  const g = globalThis;
  const bitmapProto = g.Bitmap?.prototype;
  if (!bitmapProto || bitmapProto.__mvmzNeutralUiCompat) return;
  bitmapProto.__mvmzNeutralUiCompat = true;

  const isNeutralColor = (value) => {
    const text = String(value ?? "").trim().toLowerCase();
    if (text === "white" || text === "black" || text === "gray" || text === "grey") return true;
    let m = /^#([0-9a-f]{3})$/i.exec(text);
    if (m) {
      const n = m[1];
      const r = parseInt(n[0] + n[0], 16);
      const gg = parseInt(n[1] + n[1], 16);
      const b = parseInt(n[2] + n[2], 16);
      return Math.max(r, gg, b) - Math.min(r, gg, b) <= 12;
    }
    m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(text);
    if (m) {
      const n = m[1];
      const r = parseInt(n.slice(0, 2), 16);
      const gg = parseInt(n.slice(2, 4), 16);
      const b = parseInt(n.slice(4, 6), 16);
      return Math.max(r, gg, b) - Math.min(r, gg, b) <= 12;
    }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(text);
    if (m) {
      const r = Number(m[1]);
      const gg = Number(m[2]);
      const b = Number(m[3]);
      return Math.max(r, gg, b) - Math.min(r, gg, b) <= 12;
    }
    return false;
  };

  const normalizeRegion = (bitmap, x, y, width, height, maxSpread) => {
    try {
      const context = bitmap?._context;
      const bw = Number(bitmap?.width || bitmap?._canvas?.width || 0);
      const bh = Number(bitmap?.height || bitmap?._canvas?.height || 0);
      if (!context || !(bw > 0) || !(bh > 0)) return 0;
      const sx = Math.max(0, Math.floor(Number(x) || 0));
      const sy = Math.max(0, Math.floor(Number(y) || 0));
      const ex = Math.min(bw, Math.ceil((Number(x) || 0) + (Number(width) || 0)));
      const ey = Math.min(bh, Math.ceil((Number(y) || 0) + (Number(height) || 0)));
      if (ex <= sx || ey <= sy) return 0;
      const image = context.getImageData(sx, sy, ex - sx, ey - sy);
      const data = image.data;
      let changed = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (!data[i + 3]) continue;
        const r = data[i];
        const gg = data[i + 1];
        const b = data[i + 2];
        const hi = Math.max(r, gg, b);
        const lo = Math.min(r, gg, b);
        if (hi - lo > maxSpread) continue;
        const neutral = Math.round((r + gg + b) / 3);
        if (r !== neutral || gg !== neutral || b !== neutral) {
          data[i] = neutral;
          data[i + 1] = neutral;
          data[i + 2] = neutral;
          changed++;
        }
      }
      if (changed) {
        context.putImageData(image, sx, sy);
        bitmap._setDirty?.();
      }
      return changed;
    } catch {
      return 0;
    }
  };

  const originalDrawText = bitmapProto.drawText;
  if (typeof originalDrawText === "function") {
    const patchedDrawText = function(text, x, y, maxWidth, lineHeight, align) {
      const result = originalDrawText.call(this, text, x, y, maxWidth, lineHeight, align);
      if (isNeutralColor(this.textColor) && isNeutralColor(this.outlineColor)) {
        const pad = Math.max(4, Number(this.outlineWidth || 0) + 2);
        const changed = normalizeRegion(this, Number(x || 0) - pad, Number(y || 0) - pad, Number(maxWidth || this.width || 0) + pad * 2, Number(lineHeight || this.fontSize || 36) + pad * 2, 48);
        if (changed && !g.__mvmzNeutralTextLogged) {
          g.__mvmzNeutralTextLogged = true;
          ctx.log("[mv-ui] neutral text RGB fringe normalized | pixels=" + changed);
        }
      }
      return result;
    };
    patchedDrawText.__mvmzNeutralText = true;
    bitmapProto.drawText = patchedDrawText;
  }

  const windowProto = g.Window?.prototype;
  if (windowProto && typeof windowProto._refreshCursor === "function" && !windowProto._refreshCursor.__mvmzNeutralCursor) {
    const originalRefreshCursor = windowProto._refreshCursor;
    const patchedRefreshCursor = function() {
      const result = originalRefreshCursor.apply(this, arguments);
      const bitmap = this?._windowCursorSprite?.bitmap;
      if (bitmap) {
        const changed = normalizeRegion(bitmap, 0, 0, bitmap.width, bitmap.height, 8);
        if (changed && !g.__mvmzNeutralCursorLogged) {
          g.__mvmzNeutralCursorLogged = true;
          ctx.log("[mv-ui] neutral cursor RGB fringe normalized | pixels=" + changed);
        }
      }
      return result;
    };
    patchedRefreshCursor.__mvmzNeutralCursor = true;
    windowProto._refreshCursor = patchedRefreshCursor;
  }

  ctx.log("[mv-ui] neutral UI RGB fringe compatibility installed");
}

function installMvBaseTextureBridge(ctx) {
  const g = globalThis;
  if (!g.Bitmap?.prototype || !g.PIXI?.BaseTexture) return;
  const originalCreateBaseTexture = g.Bitmap.prototype._createBaseTexture;
  g.Bitmap.prototype._createBaseTexture = function(source) {
    let actualSource = source;
    if (!actualSource) {
      const placeholder = g.document.createElement("canvas");
      placeholder.width = 1;
      placeholder.height = 1;
      actualSource = placeholder;
      this.__mvmzPlaceholderBaseTexture = true;
      ctx.log(`[mv-img] baseTexture placeholder | ${this._url || "(anonymous)"}`);
    }
    return originalCreateBaseTexture.call(this, actualSource);
  };
  ctx.log("[mv-img] BaseTexture placeholder compatibility installed");
}
function syncMvBitmapBaseTexture(ctx, bitmap, canvas, url) {
  try {
    try {
      (canvas as any).__mvmzSourceUrl = String(url || "");
      const native = (canvas as any)?.getNativeCanvas?.();
      if (native) (native as any).__mvmzSourceUrl = String(url || "");
    } catch {}
    if (bitmap.__baseTexture) {
      if (typeof bitmap.__baseTexture.loadSource === "function") {
        bitmap.__baseTexture.loadSource(canvas);
      } else {
        bitmap.__baseTexture.source = canvas;
        bitmap.__baseTexture.width = canvas.width;
        bitmap.__baseTexture.height = canvas.height;
        bitmap.__baseTexture.update?.();
      }
      bitmap.__baseTexture.mipmap = false;
      bitmap.__baseTexture.scaleMode = bitmap._smooth ? globalThis.PIXI.SCALE_MODES.LINEAR : globalThis.PIXI.SCALE_MODES.NEAREST;
      bitmap.__mvmzPlaceholderBaseTexture = false;
      ctx.log(`[mv-img] baseTexture source upgraded | ${url} ${canvas.width}x${canvas.height}`);
    } else {
      bitmap._createBaseTexture(canvas);
      ctx.log(`[mv-img] baseTexture created | ${url} ${canvas.width}x${canvas.height}`);
    }
    try { if (bitmap.__baseTexture) bitmap.__baseTexture.__mvmzSourceUrl = String(url || ""); } catch {}
  } catch (error) {
    ctx.log(`[mv-img] baseTexture sync FAILED | ${url} | ${String(error)}`);
    throw error;
  }
}
function queueMvGpuPrepare(ctx, bitmap, url, done) {
  try {
    const g = globalThis;
    const prepare = g.Graphics?._renderer?.plugins?.prepare;
    const baseTexture = bitmap?.__baseTexture;
    if (!prepare || !baseTexture) {
      done?.();
      return;
    }
    if (bitmap.__mvmzGpuPrepared) {
      done?.();
      return;
    }
    if (!Array.isArray(bitmap.__mvmzGpuPrepareWaiters)) bitmap.__mvmzGpuPrepareWaiters = [];
    if (done) bitmap.__mvmzGpuPrepareWaiters.push(done);
    if (bitmap.__mvmzGpuPrepareInFlight) return;
    bitmap.__mvmzGpuPrepareInFlight = true;
    prepare.upload(baseTexture, () => {
      bitmap.__mvmzGpuPrepared = true;
      bitmap.__mvmzGpuPrepareInFlight = false;
      const waiters = bitmap.__mvmzGpuPrepareWaiters.splice(0);
      for (const waiter of waiters) {
        try {
          waiter();
        } catch {
        }
      }
    });
  } catch (error) {
    ctx.log(`[mv-prewarm] GPU prepare FAILED | ${url} | ${String(error)}`);
    bitmap.__mvmzGpuPrepareInFlight = false;
    const waiters = Array.isArray(bitmap.__mvmzGpuPrepareWaiters) ? bitmap.__mvmzGpuPrepareWaiters.splice(0) : [];
    if (done && !waiters.includes(done)) waiters.push(done);
    for (const waiter of waiters) {
      try {
        waiter();
      } catch {
      }
    }
  }
}
function mvRawCachePath(url) {
  const rel = normalizeRelativePath(url);
  if (!/\.(?:png|jpg|jpeg)$/i.test(rel)) return null;
  return `.mvmz_cache/rgba/${rel.replace(/\.[^.\/]+$/, "")}.mrgba`;
}
var mvRawCacheValidation = "unknown";
function fnv1a32Hex(buffer) {
  const bytes = new Uint8Array(buffer);
  let value = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    value ^= bytes[i];
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
}
function validateMvRawCache(ctx) {
  if (mvRawCacheValidation !== "unknown") return mvRawCacheValidation === "valid";
  try {
    if (!ctx.fs.exists(".mvmz_cache/manifest.json")) {
      mvRawCacheValidation = "invalid";
      return false;
    }
    const manifest = JSON.parse(ctx.fs.readText(".mvmz_cache/manifest.json"));
    const expected = manifest?.game_fingerprint;
    if (!expected?.system_fnv1a32 || typeof expected.system_bytes !== "number") {
      mvRawCacheValidation = "invalid";
      ctx.log("[mv-pcache] disabled | manifest has no game fingerprint");
      return false;
    }
    const system = ctx.fs.readBuffer("data/System.json");
    const actualHash = fnv1a32Hex(system);
    const actualBytes = system.byteLength;
    if (String(expected.system_fnv1a32).toLowerCase() !== actualHash || Number(expected.system_bytes) !== actualBytes) {
      mvRawCacheValidation = "invalid";
      ctx.log(`[mv-pcache] disabled | game fingerprint mismatch expected=${expected.system_fnv1a32}/${expected.system_bytes} actual=${actualHash}/${actualBytes}`);
      return false;
    }
    mvRawCacheValidation = "valid";
    ctx.log(`[mv-pcache] enabled | game fingerprint ${actualHash}/${actualBytes}`);
    return true;
  } catch (error) {
    mvRawCacheValidation = "invalid";
    ctx.log(`[mv-pcache] disabled | fingerprint validation failed | ${String(error)}`);
    return false;
  }
}
function tryLoadMvRawCache(ctx, bitmap, url, expectedState) {
  const cachePath = mvRawCachePath(url);
  if (!cachePath || !ctx.fs.exists(cachePath)) return false;
  if (!validateMvRawCache(ctx)) return false;
  const g = globalThis;
  try {
    const bytes = ctx.fs.readBuffer(cachePath);
    if (bytes.byteLength < 24) throw new Error("cache file too small");
    const raw = new Uint8Array(bytes);
    const magic = String.fromCharCode(...raw.subarray(0, 8));
    if (magic !== "MVMZRGBA") throw new Error(`bad cache magic: ${magic}`);
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
    if (bitmap._loadingState !== expectedState) return true;
    const canvas = g.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas context unavailable for raw cache");
    const imageData = context.createImageData(width, height);
    imageData.data.set(new Uint8ClampedArray(bytes, 24, payloadLength));
    context.putImageData(imageData, 0, 0);
    bitmap.__canvas = canvas;
    bitmap.__context = context;
    try { (canvas as any).src = String(url || ""); } catch {}
    bitmap._image = canvas;
    syncMvBitmapBaseTexture(ctx, bitmap, canvas, url);
    bitmap._loadingState = "loaded";
    bitmap._setDirty();
    queueMvGpuPrepare(ctx, bitmap, url);
    bitmap._callLoadListeners();
    try {
      g.ImageManager?._imageCache?._truncateCache?.();
    } catch {
    }
    ctx.log(`[mv-pcache] HIT | ${url} -> ${cachePath} ${width}x${height} rawMiB=${(payloadLength / 1048576).toFixed(2)}`);
    return true;
  } catch (error) {
    ctx.log(`[mv-pcache] invalid/fallback | ${cachePath} | ${String(error)}`);
    return false;
  }
}
var MV_IMAGE_DECODE_CONCURRENCY = 2;
var mvImageDecodeActive = 0;
var mvImageDecodeWaiters = [];
async function withMvImageDecodeSlot(work) {
  if (mvImageDecodeActive >= MV_IMAGE_DECODE_CONCURRENCY) {
    await new Promise((resolve) => mvImageDecodeWaiters.push(resolve));
  }
  mvImageDecodeActive++;
  try {
    return await work();
  } finally {
    mvImageDecodeActive--;
    const next = mvImageDecodeWaiters.shift();
    if (next) next();
  }
}
function mvNeedsExactIndexedAlphaPng(bytes, url) {
  try {
    if (!/\.png(?:$|[?#])/i.test(String(url || "")) && !/^data:image\/png/i.test(String(url || ""))) return false;
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (input.byteLength < 33) return false;
    if (input[0] !== 0x89 || input[1] !== 0x50 || input[2] !== 0x4e || input[3] !== 0x47 || input[4] !== 0x0d || input[5] !== 0x0a || input[6] !== 0x1a || input[7] !== 0x0a) return false;
    if (input[25] !== 3) return false;
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    let offset = 8;
    while (offset + 12 <= input.byteLength) {
      const length = view.getUint32(offset, false);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > input.byteLength) return false;
      const tag = String.fromCharCode(input[offset + 4], input[offset + 5], input[offset + 6], input[offset + 7]);
      if (tag === 'tRNS') {
        for (let i = dataStart; i < dataEnd; i++) {
          const alpha = input[i];
          if (alpha > 0 && alpha < 255) return true;
        }
        return false;
      }
      if (tag === 'IEND') return false;
      offset = dataEnd + 4;
    }
  } catch {}
  return false;
}
async function decodeBitmapBytes(ctx, bitmap, bytes, url, expectedState) {
  const g = globalThis;
  try {
    if (bitmap._loadingState !== expectedState) return;
    ctx.log(`[mv-img] decode start | state=${expectedState} url=${url} bytes=${bytes.byteLength}`);
    if (!bitmap._decodeAfterRequest) {
      bitmap._image = null;
      bitmap._loadingState = "purged";
      ctx.log(`[mv-img] prefetch complete | ${url}`);
      return;
    }
    let canvas = null;
    let context = null;
    const exactEligible = mvNeedsExactIndexedAlphaPng(bytes, url);
    if (exactEligible) {
      try {
        const exact = await decodePngExact(bytes);
        if (bitmap._loadingState !== expectedState) return;
        canvas = g.document.createElement("canvas");
        canvas.width = Math.max(1, exact.width);
        canvas.height = Math.max(1, exact.height);
        context = canvas.getContext("2d");
        if (!context) throw new Error("2D canvas context unavailable for exact PNG");
        const imageData = context.createImageData(exact.width, exact.height);
        imageData.data.set(exact.data);
        context.putImageData(imageData, 0, 0);
        ctx.log(`[mv-img] exact indexed-alpha PNG restore | ${url} ${exact.width}x${exact.height} bytes=${exact.data.byteLength}`);
      } catch (exactError) {
        canvas = null;
        context = null;
        ctx.log(`[mv-img] exact indexed-alpha PNG restore FAILED | ${url} | ${String(exactError)} | fallback=native-canvas`);
      }
    }
    if (!canvas || !context) {
      const decoded = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      if (bitmap._loadingState !== expectedState) {
        decoded.close();
        return;
      }
      canvas = g.document.createElement("canvas");
      canvas.width = Math.max(1, decoded.width);
      canvas.height = Math.max(1, decoded.height);
      context = canvas.getContext("2d");
      if (!context) {
        decoded.close();
        throw new Error("2D canvas context unavailable for decoded bitmap");
      }
      context.drawImage(decoded, 0, 0);
      decoded.close();
    }
    bitmap.__canvas = canvas;
    bitmap.__context = context;
    try { (canvas as any).src = String(url || ""); } catch {}
    bitmap._image = canvas;
    syncMvBitmapBaseTexture(ctx, bitmap, canvas, url);
    bitmap._loadingState = "loaded";
    bitmap._setDirty();
    queueMvGpuPrepare(ctx, bitmap, url);
    bitmap._callLoadListeners();
    try {
      g.ImageManager?._imageCache?._truncateCache?.();
    } catch {
    }
    ctx.log(`[mv-img] decode ready | ${url} ${canvas.width}x${canvas.height}`);
  } catch (error) {
    bitmap._loadingState = "error";
    ctx.log(`[mv-img] decode FAILED | state=${expectedState} url=${url} | ${String(error)}`);
  }
}
function decodeMvDataImageUri(url) {
  const match = /^data:image\/[^;,]+;base64,(.*)$/i.exec(String(url || ""));
  if (!match) throw new Error("unsupported data image URI");
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 255;
  return bytes.buffer;
}
function scheduleMvBitmapDecode(ctx, bitmap, url, expectedState, loadBytes) {
  void withMvImageDecodeSlot(async () => {
    if (bitmap._loadingState !== expectedState) return;
    try {
      if (tryLoadMvRawCache(ctx, bitmap, url, expectedState)) return;
      const bytes = loadBytes();
      await decodeBitmapBytes(ctx, bitmap, bytes, url, expectedState);
    } catch (error) {
      bitmap._loadingState = "error";
      ctx.log(`[mv-img] read/decrypt FAILED | state=${expectedState} url=${url} | ${String(error)}`);
    }
  });
}
function installMvEncryptedImageBridge(ctx) {
  const { log } = ctx;
  const g = globalThis;
  if (!g.Decrypter || !g.Bitmap) return;
  g.Decrypter.decryptImg = function(url, bitmap) {
    const encryptedUrl = g.Decrypter.extToEncryptExt(url);
    ctx.log(`[mv-img] decrypt request | ${url} -> ${encryptedUrl}`);
    scheduleMvBitmapDecode(ctx, bitmap, url, "decrypting", () => {
      const encryptedBytes = ctx.fs.readBuffer(encryptedUrl);
      return g.Decrypter.decryptArrayBuffer(encryptedBytes);
    });
  };
  log("[mv] encrypted-image direct-decode compatibility installed");
}
function installMvRegularImageBridge(ctx) {
  const g = globalThis;
  if (!g.Bitmap || !g.Decrypter || !g.ResourceHandler) return;
  g.Bitmap.prototype._requestImage = function(url) {
    if (this._decodeAfterRequest && !this._loader) {
      this._loader = g.ResourceHandler.createLoader(
        url,
        this._requestImage.bind(this, url),
        this._onError.bind(this)
      );
    }
    this._url = url;
    this._loadingState = "requesting";
    ctx.log(`[mv-img] requestImage | decode=${!!this._decodeAfterRequest} url=${url}`);
    if (!this._decodeAfterRequest) {
      this._image = null;
      this._loadingState = "purged";
      ctx.log(`[mv-img] request-only deferred | ${url}`);
      return;
    }
    if (/^data:image\//i.test(String(url || ""))) {
      ctx.log("[mv-img] data URI direct-decode | chars=" + String(url).length);
      scheduleMvBitmapDecode(ctx, this, url, "requesting", () => decodeMvDataImageUri(url));
      return;
    }
    if (!g.Decrypter.checkImgIgnore(url) && g.Decrypter.hasEncryptedImages) {
      this._loadingState = "decrypting";
      g.Decrypter.decryptImg(url, this);
      return;
    }
    scheduleMvBitmapDecode(ctx, this, url, "requesting", () => ctx.fs.readBuffer(url));
  };
  ctx.log("[mv-img] direct createImageBitmap compatibility installed");
}
function installMvBitmapDecodeBridge(ctx) {
  const g = globalThis;
  if (!g.Bitmap?.prototype?.decode) return;
  if (g.Bitmap.prototype.decode.__mvmzDirectLoaderBridge) return;
  const originalDecode = g.Bitmap.prototype.decode;
  const directDecodeBridge = function() {
    const state = this._loadingState;
    switch (state) {
      case "requesting":
      case "decrypting":
        this._decodeAfterRequest = true;
        ctx.log(`[mv-img] decode wait | state=${state} url=${this._url ?? "unknown"}`);
        return;
      case "pending":
      case "purged":
      case "error":
        this._decodeAfterRequest = true;
        ctx.log(`[mv-img] decode restart | state=${state} url=${this._url ?? "unknown"}`);
        this._requestImage(this._url);
        return;
      case "requestCompleted":
      case "decryptCompleted":
        if (this.__canvas || this._image) {
          return originalDecode.call(this);
        }
        this._loadingState = "loaded";
        this._setDirty?.();
        this._callLoadListeners?.();
        return;
      default:
        return originalDecode.call(this);
    }
  };
  directDecodeBridge.__mvmzDirectLoaderBridge = true;
  g.Bitmap.prototype.decode = directDecodeBridge;
  ctx.log("[mv-img] Bitmap.decode direct-loader race compatibility installed");
}
function installMvSaveBackend(ctx) {
  const { game, log } = ctx;
  const g = globalThis;
  if (!g.StorageManager || !g.LZString) return;
  const saveRoot = `sdmc:/mvmz/_saves/${game.id}/mv`;
  Switch.mkdirSync(saveRoot);
  const fileName = (id) => id < 0 ? "config.rpgsave" : id === 0 ? "global.rpgsave" : `file${id}.rpgsave`;
  const pathFor = (id) => `${saveRoot}/${fileName(id)}`;
  const exists2 = (path) => {
    try {
      return Switch.statSync(path) !== null;
    } catch {
      return false;
    }
  };
  const readText = (path) => {
    const data = Switch.readFileSync(path);
    return data ? new TextDecoder().decode(data) : null;
  };
  g.StorageManager.save = (id, json) => {
    const compressed = g.LZString.compressToBase64(json);
    Switch.writeFileSync(pathFor(id), compressed);
    log(`[mv-save] write ${fileName(id)} bytes=${compressed.length}`);
  };
  g.StorageManager.load = (id) => {
    const text = readText(pathFor(id));
    return text ? g.LZString.decompressFromBase64(text) : null;
  };
  g.StorageManager.exists = (id) => exists2(pathFor(id));
  g.StorageManager.remove = (id) => {
    const path = pathFor(id);
    if (exists2(path)) Switch.removeSync(path);
  };
  g.StorageManager.backup = (id) => {
    const path = pathFor(id);
    if (exists2(path)) {
      const data = Switch.readFileSync(path);
      if (data) Switch.writeFileSync(path + ".bak", data);
    }
  };
  g.StorageManager.backupExists = (id) => exists2(pathFor(id) + ".bak");
  g.StorageManager.cleanBackup = (id) => {
    const path = pathFor(id) + ".bak";
    if (exists2(path)) Switch.removeSync(path);
  };
  g.StorageManager.restoreBackup = (id) => {
    const backup = pathFor(id) + ".bak";
    const target = pathFor(id);
    const data = Switch.readFileSync(backup);
    if (data) {
      Switch.writeFileSync(target, data);
      Switch.removeSync(backup);
    }
  };
  g.StorageManager.localFileDirectoryPath = () => saveRoot + "/";
  g.StorageManager.localFilePath = pathFor;
  log(`[mv-save] SD backend installed | ${saveRoot}`);
}
function installMvPostPluginSaveCompat(ctx) {
  const g = globalThis;
  const sm = g.StorageManager;
  if (!sm || !g.LZString) return;
  const saveRoot = `sdmc:/mvmz/_saves/${ctx.game.id}/mv`;
  Switch.mkdirSync(saveRoot);
  const commonPath = `${saveRoot}/common.rpgsave`;
  const exists = (path) => {
    try {
      return Switch.statSync(path) !== null;
    } catch {
      return false;
    }
  };
  const readText = (path) => {
    try {
      const data = Switch.readFileSync(path);
      return data ? new TextDecoder().decode(data) : null;
    } catch {
      return null;
    }
  };
  if (typeof sm.saveCommonSave === "function" || typeof sm.localFilePathCommonSave === "function") {
    sm.localFilePathCommonSave = () => commonPath;
    sm.saveCommonSave = (json) => {
      const compressed = g.LZString.compressToBase64(json);
      Switch.writeFileSync(commonPath, compressed);
      ctx.log(`[mv-save] write common.rpgsave bytes=${compressed.length}`);
    };
    sm.loadCommonSave = () => {
      const data = readText(commonPath);
      return data ? g.LZString.decompressFromBase64(data) : null;
    };
    sm.existsCommonSave = () => exists(commonPath);
    sm.localFileExistsCommonSave = () => exists(commonPath);
    sm.removeCommonSave = () => {
      if (exists(commonPath)) Switch.removeSync(commonPath);
    };
    sm.removeLocalFileCommonSave = sm.removeCommonSave;
    ctx.log(`[mv-save] plugin common-save SD compatibility installed | ${commonPath}`);
  }
  if (g.DataManager?.saveGame && !g.DataManager.saveGame.__mvmzSaveDiagnostics) {
    const originalSaveGame = g.DataManager.saveGame;
    const wrappedSaveGame = function(savefileId) {
      ctx.log(`[mv-save] saveGame start | id=${savefileId}`);
      try {
        const result = originalSaveGame.call(this, savefileId);
        ctx.log(`[mv-save] saveGame result | id=${savefileId} ok=${!!result}`);
        return result;
      } catch (error) {
        ctx.log(`[mv-save] saveGame EXCEPTION | id=${savefileId} | ${String(error?.stack ?? error)}`);
        return false;
      }
    };
    wrappedSaveGame.__mvmzSaveDiagnostics = true;
    g.DataManager.saveGame = wrappedSaveGame;
  }
}
function installMvEarlyEncryptionBootstrap(ctx) {
  const g = globalThis;
  const decrypter = g.Decrypter;
  if (!decrypter || decrypter.__mvmzEarlyEncryptionBootstrap) return;
  decrypter.__mvmzEarlyEncryptionBootstrap = true;
  try {
    if (!ctx.fs.exists("data/System.json")) return;
    const text = ctx.fs.readText("data/System.json").replace(/^\uFEFF/, "");
    const system = JSON.parse(text);
    const hasImages = !!system?.hasEncryptedImages;
    const hasAudio = !!system?.hasEncryptedAudio;
    const earlyKey = String(system?.encryptionKey || "");
    decrypter.hasEncryptedImages = hasImages;
    decrypter.hasEncryptedAudio = hasAudio;
    const originalReadEncryptionkey = decrypter.readEncryptionkey?.bind(decrypter);
    decrypter.readEncryptionkey = function() {
      const key = String(g.$dataSystem?.encryptionKey || earlyKey || "");
      if (key) {
        this._encryptionKey = key.split(/(.{2})/).filter(Boolean);
        return;
      }
      return originalReadEncryptionkey?.();
    };
    ctx.log(`[mv-host] early encryption metadata | images=${hasImages} audio=${hasAudio} key=${earlyKey ? "yes" : "no"}`);
  } catch (error) {
    ctx.log(`[mv-host] early encryption metadata unavailable | ${String(error)}`);
  }
}
function normalizeMvBooleanPluginParameters(ctx) {
  const g = globalThis;
  if (!Array.isArray(g.$plugins)) return;
  let total = 0;
  for (const plugin of g.$plugins) {
    if (!plugin?.status || !plugin?.name || !plugin?.parameters) continue;
    const path = `js/plugins/${plugin.name}.js`;
    if (!ctx.fs.exists(path)) continue;
    let source = "";
    try { source = ctx.fs.readText(path); } catch { continue; }
    let paramName = "";
    let paramType = "";
    let onLabel = "";
    let offLabel = "";
    const flush = () => {
      if (!paramName || paramType.toLowerCase() !== "boolean") return;
      const current = plugin.parameters[paramName];
      if (typeof current !== "string" || current === "true" || current === "false") return;
      let normalized = null;
      if (onLabel && current === onLabel) normalized = "true";
      else if (offLabel && current === offLabel) normalized = "false";
      if (normalized !== null) {
        plugin.parameters[paramName] = normalized;
        total++;
        ctx.log(`[mv-plugin] boolean parameter normalized | ${plugin.name}.${paramName}: ${current} -> ${normalized}`);
      }
    };
    for (const line of source.split(/\r?\n/)) {
      let match = line.match(/^\s*\*+\s*@param\s+(.+?)\s*$/i);
      if (match) {
        flush();
        paramName = match[1];
        paramType = "";
        onLabel = "";
        offLabel = "";
        continue;
      }
      match = line.match(/^\s*\*+\s*@type\s+(.+?)\s*$/i);
      if (match && paramName) { paramType = match[1]; continue; }
      match = line.match(/^\s*\*+\s*@on\s+(.+?)\s*$/i);
      if (match && paramName) { onLabel = match[1]; continue; }
      match = line.match(/^\s*\*+\s*@off\s+(.+?)\s*$/i);
      if (match && paramName) offLabel = match[1];
    }
    flush();
  }
  if (total) ctx.log(`[mv-plugin] normalized localized boolean parameters | count=${total}`);
}
function installMvRenderDiagnostics(ctx) {
  const g: any = globalThis as any;
  if (g.__mvmzMvRenderDiagnosticsInstalled) return;
  g.__mvmzMvRenderDiagnosticsInstalled = true;
  g.__mvmzGpuTextureReadbackProbe = true;
  try {
    const spriteProto: any = g.PIXI?.SpriteRenderer?.prototype;
    if (spriteProto && !spriteProto.__mvmzGhostBlendTraceInstalled && typeof spriteProto.flush === 'function') {
      const originalFlush = spriteProto.flush;
      const seen = new Set<string>();
      let blendTraceLogs = 0;
      spriteProto.flush = function(...args: any[]) {
        try {

          const count = Math.max(0, Number(this.currentIndex || 0));
          const sprites = this.sprites || [];
          for (let i = 0; i < count && blendTraceLogs < 32; i++) {
            const sprite: any = sprites[i];
            const bt: any = sprite?._texture?.baseTexture;
            const url = String(bt?.__mvmzSourceUrl || bt?.source?.__mvmzSourceUrl || '');
            const target = /^img\/titles\d*\/Castle-animation_000[12]\.png$/i.test(url)
              || /^img\/parallaxes\/!00_tittle\.png$/i.test(url)
              || /^img\/characters\/(?:\$00_Menu_|!00_rousoku|!00_Fire_eff_ex0001|%2400_cursor)/i.test(url);
            if (!target) continue;
            g.__mvmzGhostTargetSeen = true;
            const pma = !!bt?.premultipliedAlpha;
            const spriteBlend = Number(sprite?.blendMode ?? 0);
            const resolvedBlend = Number(g.PIXI?.utils?.premultiplyBlendMode?.[pma ? 1 : 0]?.[spriteBlend] ?? -1);
            const blendTable = this.renderer?.state?.blendModes?.[resolvedBlend];
            const worldAlpha = Number(sprite?.worldAlpha ?? 1);
            const tint = Number(sprite?._tintRGB ?? 0xffffff) >>> 0;
            const key = `${url}|${pma}|${spriteBlend}|${resolvedBlend}|${worldAlpha.toFixed(3)}|${tint}`;
            if (seen.has(key)) continue;
            seen.add(key);
            blendTraceLogs++;
            const glMode = Array.isArray(blendTable) ? blendTable.join(',') : String(blendTable ?? 'unknown');
            ctx.log(`[mv-gfx] sprite blend trace | url=${url} pma=${pma} spriteBlend=${spriteBlend} resolvedBlend=${resolvedBlend} glMode=${glMode} worldAlpha=${worldAlpha.toFixed(3)} tint=0x${tint.toString(16).padStart(6, '0')} tex=${Number(bt?.width || 0)}x${Number(bt?.height || 0)}`);
          }
        } catch (error) {
          ctx.log(`[mv-gfx] sprite blend trace FAILED | ${String(error)}`);
        }
        return originalFlush.apply(this, args);
      };
      spriteProto.__mvmzGhostBlendTraceInstalled = true;
      ctx.log('[mv-gfx] SpriteRenderer Ghost blend trace + FBO capture trigger installed');
    }
  } catch (error) {
    ctx.log(`[mv-gfx] SpriteRenderer Ghost blend trace install FAILED | ${String(error)}`);
  }
  try {
    const c: any = g.document?.createElement?.('canvas');
    c.width = 2; c.height = 2;
    const c2d: any = c.getContext?.('2d');
    c2d.clearRect(0, 0, 2, 2);
    c2d.fillStyle = 'rgba(200,100,50,0.5)';
    c2d.fillRect(0, 0, 2, 2);
    const p = c2d.getImageData(0, 0, 1, 1).data;
    ctx.log(`[mv-gfx] Canvas alpha semantics | rgba=${Number(p[0])},${Number(p[1])},${Number(p[2])},${Number(p[3])} expectedStraight~=200,100,50,128 expectedPMA~=100,50,25,128`);
  } catch (error) {
    ctx.log(`[mv-gfx] Canvas alpha semantics FAILED | ${String(error)}`);
  }
  ctx.log('[mv-gfx] non-mutating GPU texture readback diagnostics enabled');
}
function afterCoreScript(relative, ctx) {
  const g = globalThis;
  const lower = relative.toLowerCase();
  if (lower.endsWith("/rpg_core.js") || lower === "js/rpg_core.js") {
    installMvRenderDiagnostics(ctx);
    installMvEarlyEncryptionBootstrap(ctx);
    captureMvCoreWebAudio(ctx);
    installMvEncryptedImageBridge(ctx);
    installMvRegularImageBridge(ctx);
    installMvBitmapDecodeBridge(ctx);
    installMvBaseTextureBridge(ctx);
    registerGameFont(ctx);
    installMvFontBridge(ctx);
    installMvKoreanFontFallback(ctx);
    installMvAudioDiagnostics(ctx);
    installMvAudioPannerBridge(ctx);
    if (g.Utils?.canReadGameFiles) {
      g.Utils.canReadGameFiles = () => true;
      ctx.log("[mv-host] Utils.canReadGameFiles -> true via ResourceFS/XHR host capability");
    }
  }
  if (lower.endsWith("/plugins.js") || lower === "js/plugins.js") {
    normalizeMvBooleanPluginParameters(ctx);
  }
  if (lower.endsWith("/rpg_managers.js") || lower === "js/rpg_managers.js") {
    installMvSaveBackend(ctx);
    installMvSceneManagerHostHooks(ctx);
  }
}
function installMvSceneManagerHostHooks(ctx) {
  const g = globalThis;
  const sm = g.SceneManager;
  if (!sm) return;
  sm.initAudio = function() {
    const ok = !!g.WebAudio?.initialize?.(false);
    const hasContext = !!g.WebAudio?._context;
    const ogg = !!g.WebAudio?.canPlayOgg?.();
    const m4a = !!g.WebAudio?.canPlayM4a?.();
    ctx.log(`[mv-audio] WebAudio.initialize=${ok} context=${hasContext} ogg=${ogg} m4a=${m4a}`);
    if (!ok) ctx.log("[mv-audio] WebAudio unavailable -> continuing without audio");
  };
  const originalGoto = sm.goto.bind(sm);
  let lastDuplicatePendingScene: any = null;
  sm.goto = function(sceneClass) {
    try {
      const pending = this._nextScene;
      if (sceneClass && pending && pending.constructor === sceneClass) {
        if (lastDuplicatePendingScene !== sceneClass) {
          lastDuplicatePendingScene = sceneClass;
          ctx.log(`[mv-scene] duplicate pending goto suppressed -> ${sceneClass?.name ?? "unknown"}`);
        }
        return;
      }
    } catch {}
    lastDuplicatePendingScene = null;
    ctx.log(`[mv-scene] goto -> ${sceneClass?.name ?? "null"}`);
    return originalGoto(sceneClass);
  };
  const originalOnSceneCreate = sm.onSceneCreate?.bind(sm);
  sm.onSceneCreate = function() {
    const result = originalOnSceneCreate?.();
    const sceneName = this._scene?.constructor?.name ?? "unknown";
    g.__mvmzMvScenePresentationHold = {
      active: true,
      sceneName,
      startedAt: Date.now(),
      deadline: Date.now() + 4000,
      loadingLogged: false,
      releasedLogged: false,
      timeoutLogged: false
    };
    ctx.log(`[mv-scene-hold] armed | scene=${sceneName} timeoutMs=4000`);
    return result;
  };
  const originalOnSceneStart = sm.onSceneStart?.bind(sm);
  sm.onSceneStart = function() {
    const result = originalOnSceneStart?.();
    const hold = g.__mvmzMvScenePresentationHold;
    if (hold?.active) {
      hold.active = false;
      if (!hold.releasedLogged) {
        hold.releasedLogged = true;
        ctx.log(`[mv-scene-hold] release | scene=${String(hold.sceneName || "unknown")} reason=scene-start elapsedMs=${Date.now() - Number(hold.startedAt || Date.now())}`);
      }
    }
    try {
      const renderer = g.Graphics?._renderer;
      if (renderer?.reset) {
        renderer.reset();
        g.__mvmzMvSceneFrameProbe = { pending: true, sceneName: this._scene?.constructor?.name ?? "unknown", serial: (g.__mvmzMvSceneFrameProbeSerial = Number(g.__mvmzMvSceneFrameProbeSerial || 0) + 1) };
        ctx.log(`[mv-scene-state] renderer reset on scene start | scene=${this._scene?.constructor?.name ?? "unknown"}`);
      }
    } catch (error) {
      ctx.log(`[mv-scene-state] renderer reset on scene start FAILED | ${String(error)}`);
    }
    return result;
  };
  const originalOnSceneLoading = sm.onSceneLoading?.bind(sm);
  sm.onSceneLoading = function() {
    const result = originalOnSceneLoading?.();
    const hold = g.__mvmzMvScenePresentationHold;
    if (hold?.active) {
      const now = Date.now();
      if (now >= Number(hold.deadline || 0)) {
        hold.active = false;
        if (!hold.timeoutLogged) {
          hold.timeoutLogged = true;
          ctx.log(`[mv-scene-hold] timeout | scene=${String(hold.sceneName || "unknown")} elapsedMs=${now - Number(hold.startedAt || now)}`);
        }
      } else {
        const presented = !!g.Graphics?.__mvmzPresentRetainedFrame?.("scene-loading");
        if (presented && !hold.loadingLogged) {
          hold.loadingLogged = true;
          ctx.log(`[mv-scene-hold] retained previous frame while scene loads | scene=${String(hold.sceneName || "unknown")}`);
        }
      }
    }
    return result;
  };
  const originalCatch = sm.catchException?.bind(sm);
  sm.catchException = function(error) {
    ctx.log(`[mv-scene] exception | ${error?.stack ?? String(error)}`);
    return originalCatch?.(error);
  };
  const originalRun = sm.run.bind(sm);
  sm.run = function(sceneClass) {
    ctx.log(`[mv-scene] run -> ${sceneClass?.name ?? "unknown"}`);
    return originalRun(sceneClass);
  };
  ctx.log("[mv-host] SceneManager host hooks installed");
}
function installMvAudioDiagnostics(ctx) {
  const g = globalThis;
  if (!g.WebAudio) return;
  const originalLoad = g.WebAudio.prototype?._load;
  if (typeof originalLoad === "function") {
    g.WebAudio.prototype._load = function(url) {
      ctx.log(`[mv-audio] load -> ${url}`);
      try {
        this._url = url;
        let requestUrl = url;
        if (g.Decrypter?.hasEncryptedAudio && typeof g.Decrypter?.extToEncryptExt === "function") {
