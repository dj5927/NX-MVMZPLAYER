// @ts-nocheck
import { extractScriptSources } from '../host/scripts';
import { normalizeRelativePath } from '../host/fs';
import { installMvNativeVideoBridge } from './mv_video';
import { installMvNativeAudioStream } from './mv_audio_stream';
import { installMvNodeRequireCompat } from './mv_node_compat';
import { MvmzOptCache } from '../host/opt_cache';
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
var mvOptCacheReader;
function getMvOptCache(ctx) {
  if (mvOptCacheReader === void 0) {
    mvOptCacheReader = new MvmzOptCache(ctx, "MV");
  }
  return mvOptCacheReader;
}
function tryLoadMvOptCache(ctx, bitmap, url, expectedState) {
  const opt = getMvOptCache(ctx);
  if (!opt?.isEnabled?.() || !opt.has(url)) return false;
  const loaded = opt.loadCanvas(url);
  if (!loaded) return false;
  if (bitmap._loadingState !== expectedState) return true;
  const g = globalThis;
  try {
    bitmap.__canvas = loaded.canvas;
    bitmap.__context = loaded.context;
    bitmap._image = loaded.canvas;
    syncMvBitmapBaseTexture(ctx, bitmap, loaded.canvas, url);
    bitmap._loadingState = "loaded";
    bitmap._setDirty();
    queueMvGpuPrepare(ctx, bitmap, url);
    bitmap._callLoadListeners();
    try {
      g.ImageManager?._imageCache?._truncateCache?.();
    } catch {
    }
    ctx.log(`[mv-opt] cache ready | ${url} ${loaded.width}x${loaded.height}`);
    return true;
  } catch (error) {
    ctx.log(`[mv-opt] apply FAILED -> source fallback | ${url} | ${String(error)}`);
    return false;
  }
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
      if (tryLoadMvOptCache(ctx, bitmap, url, expectedState)) return;
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
          try {
            const encryptedUrl = String(g.Decrypter.extToEncryptExt(url));
            if (encryptedUrl && ctx.fs.exists(encryptedUrl)) {
              requestUrl = encryptedUrl;
              ctx.log(`[mv-audio] encrypted request -> ${url} => ${requestUrl}`);
            }
          } catch (error) {
            ctx.log(`[mv-audio] encrypted path probe FAILED -> ${url} | ${String(error)}`);
          }
        }
        const xhr = new g.XMLHttpRequest();
        xhr.open("GET", requestUrl);
        xhr.responseType = "arraybuffer";
        xhr.onload = () => {
          if (Number(xhr.status || 0) < 400) {
            ctx.log(`[mv-audio] host xhr ready -> ${requestUrl} bytes=${Number(xhr.response?.byteLength || 0)}`);
            this._onXhrLoad(xhr);
          } else {
            this._hasError = true;
            ctx.log(`[mv-audio] host xhr HTTP FAILED -> ${requestUrl} status=${xhr.status}`);
          }
        };
        xhr.onerror = (error) => {
          this._hasError = true;
          ctx.log(`[mv-audio] host xhr FAILED -> ${requestUrl} | ${String(error)}`);
        };
        xhr.send();
      } catch (error) {
        this._hasError = true;
        ctx.log(`[mv-audio] host load FAILED -> ${url} | ${String(error)}`);
      }
    };
  }
  if (typeof g.WebAudio.prototype?._onXhrLoad === "function") {
    const LARGE_AUDIO_BYTES = 1024 * 1024;
    const logMemory = (label) => {
      try {
        const mem = Switch.memoryUsage();
        const mib = (value) => (Number(value || 0) / 1048576).toFixed(1);
        ctx.log(`[mv-audio] ${label} | heapMiB=${mib(mem.usedHeapSize)} externalMiB=${mib(mem.externalMemory)} nativeMiB=${mib(mem.nativeHeapUsed)}/${mib(mem.nativeHeapTotal)}`);
      } catch {
      }
    };
    const prepareDecode = async (aggressive) => {
      try {
        const am = g.AudioManager;
        if (Array.isArray(am?._seBuffers)) {
          am._seBuffers = am._seBuffers.filter((audio) => {
            try {
              return !!audio?.isPlaying?.();
            } catch {
              return false;
            }
          });
        }
      } catch {
      }
      const oldLimit = Number(g.ImageCache?.limit || 0);
      if (aggressive && g.ImageCache && oldLimit > 0) {
        g.ImageCache.limit = Math.min(oldLimit, 14 * 1e3 * 1e3);
      }
      try {
        g.ImageManager?._imageCache?._truncateCache?.();
      } catch {
      }
      try {
        g.Graphics?.callGC?.();
      } catch {
      }
      try {
        const gc = globalThis.gc;
        if (typeof gc === "function") gc();
      } catch {
      }
      if (aggressive && g.ImageCache && oldLimit > 0) {
        g.ImageCache.limit = oldLimit;
      }
      await Promise.resolve();
    };
    const finishDecode = (audio, buffer) => {
      audio._buffer = buffer;
      audio._totalTime = buffer.duration;
      if (audio._loopLength > 0 && audio._sampleRate > 0) {
        audio._loopStart /= audio._sampleRate;
        audio._loopLength /= audio._sampleRate;
      } else {
        audio._loopStart = 0;
        audio._loopLength = audio._totalTime;
      }
      audio._hasError = false;
      audio._onLoad();
    };
    const installSilentFallback = (audio, reason) => {
      try {
        const context = g.WebAudio._context;
        const sampleRate = Number(context?.sampleRate || 48e3);
        const silent = context.createBuffer(1, Math.max(1, Math.floor(sampleRate)), sampleRate);
        audio._buffer = silent;
        audio._sampleRate = sampleRate;
        audio._totalTime = silent.duration || 1;
        audio._loopStart = 0;
        audio._loopLength = audio._totalTime;
        audio._hasError = false;
        ctx.log(`[mv-audio] decode fallback -> silence | ${audio?._url ?? "unknown"} | ${String(reason)}`);
        audio._onLoad();
      } catch (fallbackError) {
        audio._hasError = true;
        ctx.log(`[mv-audio] silent fallback FAILED | ${audio?._url ?? "unknown"} | ${String(fallbackError)}`);
      }
    };
    g.WebAudio.__mvmzDecodeQueue = Promise.resolve();
    g.WebAudio.__mvmzDecodedSeCache = g.WebAudio.__mvmzDecodedSeCache || new Map();
    const SE_CACHE_MAX = 64;
    const SE_CACHE_MAX_COMPRESSED = 256 * 1024;
    const SE_CACHE_MAX_DURATION = 15;
    const getCachedSe = (url) => {
      const cache = g.WebAudio.__mvmzDecodedSeCache;
      const key = String(url || "");
      if (!/^audio\/se\//i.test(key)) return null;
      const value = cache.get(key);
      if (!value) return null;
      cache.delete(key);
      cache.set(key, value);
      return value;
    };
    const putCachedSe = (url, bytes, buffer) => {
      const key = String(url || "");
      if (!/^audio\/se\//i.test(key)) return;
      if (Number(bytes || 0) > SE_CACHE_MAX_COMPRESSED) return;
      if (Number(buffer?.duration || 0) > SE_CACHE_MAX_DURATION) return;
      const cache = g.WebAudio.__mvmzDecodedSeCache;
      if (cache.has(key)) cache.delete(key);
      cache.set(key, buffer);
      while (cache.size > SE_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === void 0) break;
        cache.delete(oldest);
      }
      ctx.log(`[mv-audio] decode cache STORE | ${key} duration=${Number(buffer?.duration || 0).toFixed(2)}s entries=${cache.size}`);
    };
    g.WebAudio.prototype._onXhrLoad = function(xhr) {
      const audio = this;
      let array = xhr?.response;
      if (!(array instanceof ArrayBuffer)) {
        audio._hasError = true;
        ctx.log(`[mv-audio] invalid xhr buffer | ${audio?._url ?? "unknown"}`);
        return;
      }
      if (g.Decrypter?.hasEncryptedAudio) array = g.Decrypter.decryptArrayBuffer(array);
      const bytes = Number(array.byteLength || 0);
      ctx.log(`[mv-audio] xhr/decrypt -> ${audio?._url ?? "unknown"} bytes=${bytes}`);
      try {
        audio._readLoopComments(new Uint8Array(array));
      } catch {
      }
      const cachedSe = getCachedSe(audio?._url);
      if (cachedSe) {
        finishDecode(audio, cachedSe);
        ctx.log(`[mv-audio] decode cache HIT | ${audio?._url ?? "unknown"} duration=${Number(cachedSe?.duration || 0).toFixed(2)}s`);
        return;
      }
      const retryArray = array.slice(0);
      const previous = g.WebAudio.__mvmzDecodeQueue || Promise.resolve();
      const task = previous.catch(() => {
      }).then(async () => {
        const url = audio?._url ?? "unknown";
        const isLarge = bytes >= LARGE_AUDIO_BYTES;
        ctx.log(`[mv-audio] decode begin | queued=1 large=${isLarge} bytes=${bytes} url=${url}`);
        if (isLarge) {
          logMemory(`preflight before ${url}`);
          await prepareDecode(false);
          logMemory(`preflight after ${url}`);
        }
        try {
          const buffer = await g.WebAudio._context.decodeAudioData(array);
          finishDecode(audio, buffer);
          putCachedSe(url, bytes, buffer);
          ctx.log(`[mv-audio] decode ready | ${url} duration=${Number(buffer?.duration || 0).toFixed(2)}s`);
          return;
        } catch (error) {
          const message = String(error?.message ?? error);
          ctx.log(`[mv-audio] decode FAILED | ${url} | ${message}`);
          if (/out of memory/i.test(message)) {
            logMemory(`OOM before retry ${url}`);
            await prepareDecode(true);
            logMemory(`OOM after cleanup ${url}`);
            try {
              const buffer = await g.WebAudio._context.decodeAudioData(retryArray);
              finishDecode(audio, buffer);
              putCachedSe(url, bytes, buffer);
              ctx.log(`[mv-audio] decode retry ready | ${url} duration=${Number(buffer?.duration || 0).toFixed(2)}s`);
              return;
            } catch (retryError) {
              ctx.log(`[mv-audio] decode retry FAILED | ${url} | ${String(retryError?.message ?? retryError)}`);
              installSilentFallback(audio, retryError);
              return;
            }
          }
          installSilentFallback(audio, error);
        }
      });
      g.WebAudio.__mvmzDecodeQueue = task.catch((error) => {
        ctx.log(`[mv-audio] decode queue FAILED | ${audio?._url ?? "unknown"} | ${String(error)}`);
      });
    };
  }
  ctx.log("[mv-audio] serialized decode/OOM recovery installed");
}
const MV_STREAMING_AUDIO_CORE_KEYS = [
  "clear", "pitch", "isReady", "isPlaying", "play", "stop", "seek",
  "_load", "_onXhrLoad", "_startPlaying", "_createNodes", "_connectNodes",
  "_removeNodes", "_onLoad", "_readLoopComments"
];
function captureMvCoreWebAudio(ctx) {
  const g = globalThis;
  const proto = g.WebAudio?.prototype;
  if (!proto || g.__mvmzMvCoreWebAudioSnapshot) return;
  const snapshot = {};
  for (const key of MV_STREAMING_AUDIO_CORE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (descriptor) snapshot[key] = descriptor;
  }
  g.__mvmzMvCoreWebAudioSnapshot = snapshot;
  ctx.log("[mv-audio] core WebAudio snapshot captured | keys=" + Object.keys(snapshot).length);
}
function restoreMvCoreAudioForStreamingPlugin(ctx) {
  const g = globalThis;
  const enabled = Array.isArray(g.$plugins) && g.$plugins.some((plugin) =>
    !!plugin?.status && String(plugin?.name || "").toLowerCase() === "audiostreaming"
  );
  if (!enabled) return false;
  const proto = g.WebAudio?.prototype;
  const snapshot = g.__mvmzMvCoreWebAudioSnapshot;
  if (!proto || !snapshot) {
    ctx.log("[mv-audio] AudioStreaming detected but core WebAudio snapshot is unavailable");
    return false;
  }
  for (const [key, descriptor] of Object.entries(snapshot)) {
    try {
      Object.defineProperty(proto, key, descriptor);
    } catch (error) {
      ctx.log("[mv-audio] core restore FAILED | " + key + " | " + String(error));
    }
  }
  for (const extra of ["_loading", "_onDecode", "_calcSourceNodeParams", "_createSourceNode", "_createSourceNodes"]) {
    if (!(extra in snapshot)) {
      try {
        delete proto[extra];
      } catch {
      }
    }
  }
  ctx.log("[mv-audio] AudioStreaming detected -> restored MV core playback methods");
  return true;
}
function installMvAudioPannerBridge(ctx) {
  const g = globalThis;
  const audioProto = g.AudioContext?.prototype;
  if (!audioProto) {
    ctx.log("[mv-audio] panner bridge skipped | AudioContext prototype unavailable");
    return;
  }
  if (audioProto.__mvmzPannerBridgeInstalled) return;
  const createStereoPanner = audioProto.createStereoPanner;
  const createGain = audioProto.createGain;
  let loggedBackend = false;
  const createCompatPanner = function() {
    if (typeof createStereoPanner === "function") {
      try {
        const node = createStereoPanner.call(this);
        node.panningModel = "equalpower";
        node.setPosition = (x, _y, _z) => {
          const pan = Math.max(-1, Math.min(1, Number(x) || 0));
          try {
            if (node.pan?.setValueAtTime) node.pan.setValueAtTime(pan, this.currentTime);
            else if (node.pan) node.pan.value = pan;
          } catch {
          }
        };
        if (!loggedBackend) {
          loggedBackend = true;
          ctx.log("[mv-audio] panner backend=StereoPannerNode");
        }
        return node;
      } catch (error) {
        ctx.log(`[mv-audio] StereoPanner unavailable -> Gain passthrough | ${String(error)}`);
      }
    }
    if (typeof createGain === "function") {
      const node = createGain.call(this);
      node.panningModel = "equalpower";
      node.setPosition = (_x, _y, _z) => {
      };
      if (!loggedBackend) {
        loggedBackend = true;
        ctx.log("[mv-audio] panner backend=GainNode passthrough");
      }
      return node;
    }
    throw new Error("No compatible audio panner backend available");
  };
  try {
    audioProto.createPanner = createCompatPanner;
    audioProto.__mvmzPannerBridgeInstalled = true;
    ctx.log("[mv-audio] AudioContext.createPanner compatibility installed");
  } catch (error) {
    ctx.log(`[mv-audio] prototype createPanner patch failed | ${String(error)}`);
  }
  if (g.WebAudio?.prototype?._createNodes) {
    g.WebAudio.prototype._createNodes = function() {
      const context = g.WebAudio._context;
      this._sourceNode = context.createBufferSource();
      this._sourceNode.buffer = this._buffer;
      this._sourceNode.loopStart = this._loopStart;
      this._sourceNode.loopEnd = this._loopStart + this._loopLength;
      this._sourceNode.playbackRate.setValueAtTime(this._pitch, context.currentTime);
      this._gainNode = context.createGain();
      this._gainNode.gain.setValueAtTime(this._volume, context.currentTime);
      this._pannerNode = createCompatPanner.call(context);
      this._updatePanner();
    };
    ctx.log("[mv-audio] WebAudio._createNodes compatibility installed");
  }
}
function installMvBootReadinessDiagnostics(ctx) {
  const g = globalThis;
  if (!g.Scene_Boot?.prototype?.isReady) return;
  const original = g.Scene_Boot.prototype.isReady;
  let lastLog = 0;
  g.Scene_Boot.prototype.isReady = function(...args) {
    const ready = original.apply(this, args);
    const now = Date.now();
    if (!ready && now - lastLog >= 1e3) {
      lastLog = now;
      const pending = [];
      const items = g.ImageManager?._imageCache?._items || {};
      for (const key of Object.keys(items)) {
        const bitmap = items[key]?.bitmap;
        if (bitmap && !bitmap.isRequestOnly?.() && !bitmap.isReady?.()) {
          pending.push({ key, state: bitmap._loadingState, url: bitmap._url });
        }
      }
      const detail = pending.slice(0, 10).map((x) => `${x.state}:${x.url || x.key}`).join(" ; ");
      let db = false;
      let map = false;
      try {
        db = !!g.DataManager?.isDatabaseLoaded?.();
      } catch {
      }
      try {
        map = !!g.DataManager?.isMapLoaded?.();
      } catch {
      }
      ctx.log(`[mv-boot] wait | db=${db} images=${!!g.ImageManager?.isReady?.()} font=${!!g.Graphics?.isFontLoaded?.("GameFont")} map=${map} stopped=${!!g.SceneManager?._stopped} pending=${pending.length}${detail ? ` | ${detail}` : ""}`);
    }
    return ready;
  };
  ctx.log("[mv-boot] readiness diagnostics installed");
}
function installMvGraphicsPerformanceBridge(ctx) {
  const g = globalThis;
  const graphics = g.Graphics;
  if (!graphics?.render) return;
  const pixi = g.PIXI;
  let target = null;
  let targetWidth = 0;
  let targetHeight = 0;
  let presentLogs = 0;
  let ghostCaptureDone = false;
  let ghostCaptureFrames = 0;

  const ensureTarget = (renderer, width, height) => {
    if (!renderer?.gl?.blitFramebuffer || !pixi?.RenderTexture?.create) return null;
    if (!target) {
      target = pixi.RenderTexture.create(width, height, pixi.SCALE_MODES?.LINEAR ?? 1, 1);
      targetWidth = width;
      targetHeight = height;
      ctx.log(`[mv-gfx] offscreen target created | ${width}x${height}`);
    } else if (targetWidth !== width || targetHeight !== height) {
      target.resize(width, height, false);
      targetWidth = width;
      targetHeight = height;
      ctx.log(`[mv-gfx] offscreen target resized | ${width}x${height}`);
    }
    return target;
  };

  let retainedPresentLogs = 0;
  const presentRetainedTarget = (reason = "retained") => {
    const renderer = graphics._renderer;
    const gl = renderer?.gl;
    if (!target || !renderer || !gl || !gl.blitFramebuffer || targetWidth <= 0 || targetHeight <= 0) return false;
    try {
      const renderTarget = target?.baseTexture?._glRenderTargets?.[renderer.CONTEXT_UID];
      const sourceFramebuffer = renderTarget?.frameBuffer?.framebuffer;
      if (sourceFramebuffer == null) return false;
      const logicalWidth = targetWidth;
      const logicalHeight = targetHeight;
      const physicalWidth = Math.max(1, Number(gl.drawingBufferWidth || g.screen?.width || 1280));
      const physicalHeight = Math.max(1, Number(gl.drawingBufferHeight || g.screen?.height || 720));
      const scale = Math.min(physicalWidth / logicalWidth, physicalHeight / logicalHeight);
      const fitWidth = Math.max(1, Math.round(logicalWidth * scale));
      const fitHeight = Math.max(1, Math.round(logicalHeight * scale));
      const fitX = Math.floor((physicalWidth - fitWidth) / 2);
      const fitY = Math.floor((physicalHeight - fitHeight) / 2);
      const scissorEnabled = !!gl.isEnabled?.(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sourceFramebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      if (scissorEnabled) gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blitFramebuffer(
        0, 0, logicalWidth, logicalHeight,
        fitX, fitY + fitHeight, fitX + fitWidth, fitY,
        gl.COLOR_BUFFER_BIT, gl.LINEAR
      );
      const presentError = Number(gl.getError?.() || 0);
      try { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); } catch {}
      try { gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null); } catch {}
      if (scissorEnabled) {
        try { gl.enable(gl.SCISSOR_TEST); } catch {}
      }
      try {
        if (typeof renderer.reset === "function") renderer.reset();
        else renderer._activeRenderTarget = null;
      } catch {
        renderer._activeRenderTarget = null;
      }
      g.__mvmzViewportFit = {
        logicalWidth,
        logicalHeight,
        physicalWidth,
        physicalHeight,
        scale,
        x: fitX,
        y: fitY,
        width: fitWidth,
        height: fitHeight,
        top: physicalHeight - (fitY + fitHeight)
      };
      if (retainedPresentLogs < 6) {
        retainedPresentLogs++;
        ctx.log(`[mv-scene-hold] retained present | reason=${reason} logical=${logicalWidth}x${logicalHeight} dst=${fitX},${fitY},${fitWidth}x${fitHeight} glError=${presentError}`);
        if (retainedPresentLogs === 6) ctx.log("[mv-scene-hold] further retained present logs suppressed");
      }
      return presentError === 0;
    } catch (error) {
      if (!g.__mvmzMvRetainedPresentFailedLogged) {
        g.__mvmzMvRetainedPresentFailedLogged = true;
        ctx.log(`[mv-scene-hold] retained present FAILED | ${String(error)}`);
      }
      return false;
    }
  };
  graphics.__mvmzPresentRetainedFrame = presentRetainedTarget;

  let sceneProbeSerial = 0;
  const probeRenderedScene = (renderer: any, sourceFramebuffer: any, logicalWidth: number, logicalHeight: number) => {
    try {
      const marker = g.__mvmzMvSceneFrameProbe;
      if (!marker?.pending || sourceFramebuffer == null) return;
      marker.pending = false;
      const gl = renderer?.gl;
      if (!gl) return;
      const sampleW = Math.max(1, Math.min(64, logicalWidth));
      const sampleH = Math.max(1, Math.min(64, logicalHeight));
      const sampleX = Math.max(0, Math.floor((logicalWidth - sampleW) / 2));
      const sampleY = Math.max(0, Math.floor((logicalHeight - sampleH) / 2));
      const pixels = new Uint8Array(sampleW * sampleH * 4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sourceFramebuffer);
      gl.readPixels(sampleX, sampleY, sampleW, sampleH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let i = 0; i < pixels.length; i += 4) { sr += pixels[i]; sg += pixels[i+1]; sb += pixels[i+2]; sa += pixels[i+3]; }
      const count = Math.max(1, pixels.length / 4);
      ctx.log(`[mv-scene-state] first rendered frame probe | scene=${String(marker.sceneName || "unknown")} centerAvg=${(sr/count).toFixed(1)},${(sg/count).toFixed(1)},${(sb/count).toFixed(1)},${(sa/count).toFixed(1)}`);
    } catch (error) {
      ctx.log(`[mv-scene-state] first rendered frame probe FAILED | ${String(error)}`);
    }
  };

  graphics.render = function(stage) {
    const hold = g.__mvmzMvScenePresentationHold;
    if (hold?.active) {
      const now = Date.now();
      let imagesReady = true;
      try { imagesReady = !!g.ImageManager?.isReady?.(); } catch {}
      if (!imagesReady && now < Number(hold.deadline || 0)) {
        if (presentRetainedTarget("post-start-pending-images")) {
          this._skipCount = 0;
          this._rendered = true;
          this.frameCount++;
          return;
        }
      } else {
        hold.active = false;
        if (!hold.releasedLogged) {
          hold.releasedLogged = true;
          const reason = imagesReady ? "images-ready" : "timeout";
          ctx.log(`[mv-scene-hold] release | scene=${String(hold.sceneName || "unknown")} reason=${reason} elapsedMs=${now - Number(hold.startedAt || now)}`);
        }
      }
    }
    if (stage) {
      const renderer = this._renderer;
      const gl = renderer?.gl;
      const logicalWidth = Math.max(1, Math.round(Number(this.width || this._width || renderer?.screen?.width || 1)));
      const logicalHeight = Math.max(1, Math.round(Number(this.height || this._height || renderer?.screen?.height || 1)));
      const rt = ensureTarget(renderer, logicalWidth, logicalHeight);
      if (renderer && gl && rt) {
        try {
          renderer.render(stage, rt, true);
          const renderTarget = rt?.baseTexture?._glRenderTargets?.[renderer.CONTEXT_UID];
          const sourceFramebuffer = renderTarget?.frameBuffer?.framebuffer;
          if (sourceFramebuffer == null) throw new Error("Pixi4 RenderTexture framebuffer unavailable");
          probeRenderedScene(renderer, sourceFramebuffer, logicalWidth, logicalHeight);

          if (g.__mvmzGhostTargetSeen && !ghostCaptureDone) {
            ghostCaptureFrames++;
            if (ghostCaptureFrames >= 30) {
              ghostCaptureDone = true;
              try {
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sourceFramebuffer);
                const rgba = new Uint8Array(logicalWidth * logicalHeight * 4);
                gl.readPixels(0, 0, logicalWidth, logicalHeight, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
                const captureError = Number(gl.getError?.() || 0);
                let hash = 2166136261 >>> 0;
                let sumR = 0, sumG = 0, sumB = 0, sumA = 0, redDom = 0, cyanDom = 0, translucent = 0;
                const pixels = Math.max(1, logicalWidth * logicalHeight);
                for (let i = 0; i < rgba.length; i += 4) {
                  const r = rgba[i], gg = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
                  sumR += r; sumG += gg; sumB += b; sumA += a;
                  if (a > 0 && a < 255) translucent++;
                  if (r > gg + 24 && r > b + 24) redDom++;
                  if (gg > r + 18 && b > r + 18) cyanDom++;
                  hash ^= r; hash = Math.imul(hash, 16777619) >>> 0;
                  hash ^= gg; hash = Math.imul(hash, 16777619) >>> 0;
                  hash ^= b; hash = Math.imul(hash, 16777619) >>> 0;
                  hash ^= a; hash = Math.imul(hash, 16777619) >>> 0;
                }
                const avg = [sumR, sumG, sumB, sumA].map(v => (v / pixels).toFixed(1)).join(',');
                const logRoot = 'sdmc:/mvmz/_logs';
                Switch.mkdirSync(logRoot);
                const safeId = String(ctx.game.id || 'game').replace(/[^A-Za-z0-9._-]+/g, '_');
                const capturePath = `${logRoot}/${safeId}_mv_v030_fbo.ppm`;
                if (captureError === 0) {
                  const header = new TextEncoder().encode(`P6\n${logicalWidth} ${logicalHeight}\n255\n`);
                  const ppm = new Uint8Array(header.length + logicalWidth * logicalHeight * 3);
                  ppm.set(header, 0);
                  let out = header.length;
                  for (let y = logicalHeight - 1; y >= 0; y--) {
                    let src = y * logicalWidth * 4;
                    for (let x = 0; x < logicalWidth; x++, src += 4) {
                      ppm[out++] = rgba[src];
                      ppm[out++] = rgba[src + 1];
                      ppm[out++] = rgba[src + 2];
                    }
                  }
                  Switch.writeFileSync(capturePath, ppm);
                }
                ctx.log(`[mv-gfx] offscreen FBO capture | path=${capturePath} size=${logicalWidth}x${logicalHeight} glError=${captureError} hash=${hash.toString(16).padStart(8, '0')} avg=${avg} trans=${translucent} redDom=${redDom} cyanDom=${cyanDom}`);
              } catch (error) {
                ctx.log(`[mv-gfx] offscreen FBO capture FAILED | ${String(error)}`);
              }
            }
          }

          const physicalWidth = Math.max(1, Number(gl.drawingBufferWidth || g.screen?.width || 1280));
          const physicalHeight = Math.max(1, Number(gl.drawingBufferHeight || g.screen?.height || 720));
          const scale = Math.min(physicalWidth / logicalWidth, physicalHeight / logicalHeight);
          const fitWidth = Math.max(1, Math.round(logicalWidth * scale));
          const fitHeight = Math.max(1, Math.round(logicalHeight * scale));
          const fitX = Math.floor((physicalWidth - fitWidth) / 2);
          const fitY = Math.floor((physicalHeight - fitHeight) / 2);
          const scissorEnabled = !!gl.isEnabled?.(gl.SCISSOR_TEST);

          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sourceFramebuffer);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
          if (scissorEnabled) gl.disable(gl.SCISSOR_TEST);
          gl.colorMask(true, true, true, true);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.blitFramebuffer(
            0, 0, logicalWidth, logicalHeight,
            fitX, fitY + fitHeight, fitX + fitWidth, fitY,
            gl.COLOR_BUFFER_BIT, gl.LINEAR
          );
          const presentError = Number(gl.getError?.() || 0);
          try { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); } catch {}
          try { gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null); } catch {}
          if (scissorEnabled) {
            try { gl.enable(gl.SCISSOR_TEST); } catch {}
          }

          renderer._activeRenderTarget = null;
          g.__mvmzViewportFit = {
            logicalWidth,
            logicalHeight,
            physicalWidth,
            physicalHeight,
            scale,
            x: fitX,
            y: fitY,
            width: fitWidth,
            height: fitHeight,
            top: physicalHeight - (fitY + fitHeight)
          };
          if (presentLogs < 6) {
            presentLogs++;
            ctx.log(`[mv-gfx] offscreen present | logical=${logicalWidth}x${logicalHeight} physical=${physicalWidth}x${physicalHeight} dst=${fitX},${fitY},${fitWidth}x${fitHeight} flipY=true glError=${presentError}`);
            if (presentLogs === 6) ctx.log("[mv-gfx] further offscreen present logs suppressed");
          }
        } catch (error) {
          if (!g.__mvmzMvOffscreenFailedLogged) {
            g.__mvmzMvOffscreenFailedLogged = true;
            ctx.log(`[mv-gfx] offscreen presenter FAILED -> direct render fallback | ${String(error)}`);
          }
          renderer._activeRenderTarget = null;
          renderer.render(stage);
        }
      } else if (renderer) {
        renderer.render(stage);
      }
    }
    this._skipCount = 0;
    this._rendered = true;
    this.frameCount++;
  };
  graphics._maxSkip = 0;
  ctx.log("[mv-gfx] logical offscreen -> physical WebGL2 blit presenter installed");
  ctx.log("[mv-perf] HOS render pacing installed | adaptiveSkip=off gl.flush=off");
}
function installMvImageCachePolicy(ctx) {
  const g = globalThis;
  if (!g.ImageCache) return;
  let total = 0;
  try {
    total = Number(Switch.memoryUsage().nativeHeapTotal || 0);
  } catch {
  }
  let limit = 10 * 1e3 * 1e3;
  if (total >= 2 * 1024 * 1024 * 1024) limit = 24 * 1e3 * 1e3;
  else if (total >= 1024 * 1024 * 1024) limit = 16 * 1e3 * 1e3;
  g.__mvmzMvBaseImageCacheLimit = limit;
  g.ImageCache.limit = limit;
  try {
    g.ImageManager?._imageCache?._truncateCache?.();
  } catch {
  }
  ctx.log(`[mv-mem] ImageCache.limit=${(limit / 1e6).toFixed(0)}MP nativeTotalMiB=${(total / 1048576).toFixed(1)}`);
}
function installMvPictureMemoryReclaimer(ctx) {
  const g = globalThis;
  const cache = g.ImageManager?._imageCache;
  const proto = g.ImageCache?.prototype;
  if (!cache || !proto || typeof proto._truncateCache !== "function") {
    ctx.log("[mv-picture-gc] skipped | ImageCache unavailable");
    return;
  }
  const retired = /* @__PURE__ */ new Map();
  let releaseLogs = 0;
  let trimLogs = 0;
  const bitmapUrl = (bitmap) => String(bitmap?._url || bitmap?.__mvmzSourceUrl || bitmap?._image?.src || "").replace(/\\/g, "/");
  const isPictureBitmap = (bitmap) => /(?:^|\/)img\/pictures\//i.test(bitmapUrl(bitmap));
  const pixelsFor = (bitmap) => Math.max(1, Number(bitmap?.width || bitmap?.__canvas?.width || bitmap?._canvas?.width || 1)) * Math.max(1, Number(bitmap?.height || bitmap?.__canvas?.height || bitmap?._canvas?.height || 1));
  const sceneUsesBitmap = (bitmap) => {
    const baseTexture = bitmap?.__baseTexture || bitmap?._baseTexture || bitmap?.baseTexture || null;
    const roots = [g.SceneManager?._scene, g.SceneManager?._nextScene, g.SceneManager?._previousScene].filter(Boolean);
    const visited = /* @__PURE__ */ new Set();
    const walk = (node) => {
      if (!node || visited.has(node)) return false;
      visited.add(node);
      try {
        if (node.bitmap === bitmap) return true;
        if (baseTexture && node.texture?.baseTexture === baseTexture) return true;
      } catch {
      }
      const children = Array.isArray(node.children) ? node.children : [];
      for (const child of children) if (walk(child)) return true;
      return false;
    };
    for (const root of roots) if (walk(root)) return true;
    return false;
  };
  const bitmapStillCached = (bitmap) => {
    try {
      const items = cache?._items || {};
      for (const key of Object.keys(items)) if (items[key]?.bitmap === bitmap) return true;
    } catch {
    }
    return false;
  };
  const retireBitmap = (bitmap, reason) => {
    if (!bitmap || !isPictureBitmap(bitmap) || retired.has(bitmap)) return;
    retired.set(bitmap, {
      bitmap,
      url: bitmapUrl(bitmap),
      pixels: pixelsFor(bitmap),
      retiredAt: Number(performance.now?.() || Date.now()),
      reason
    });
  };
  const destroyRetiredBitmap = (entry) => {
    const bitmap = entry.bitmap;
    if (!bitmap) return false;
    try {
      const baseTextures = [];
      for (const candidate of [bitmap.__baseTexture, bitmap._baseTexture, bitmap.baseTexture]) {
        if (candidate && !baseTextures.includes(candidate)) baseTextures.push(candidate);
      }
      for (const baseTexture of baseTextures) {
        try { baseTexture.destroy?.(); } catch {
        }
      }
      const canvases = [];
      for (const candidate of [bitmap.__canvas, bitmap._canvas, bitmap._image]) {
        if (candidate && typeof candidate === "object" && typeof candidate.width === "number" && !canvases.includes(candidate)) canvases.push(candidate);
      }
      for (const canvas of canvases) {
        try {
          canvas.width = 1;
          canvas.height = 1;
        } catch {
        }
      }
      try {
        bitmap.__canvas = null;
        bitmap.__context = null;
      } catch {
      }
      try {
        bitmap._image = null;
        bitmap._canvas = null;
        bitmap._context = null;
      } catch {
      }
      try { bitmap._baseTexture = null; } catch {
      }
      try { bitmap.__baseTexture = null; } catch {
      }
      try {
        bitmap.__mvmzGpuPrepared = false;
        bitmap.__mvmzGpuPrepareWaiters = [];
        bitmap._loadingState = "purged";
      } catch {
      }
      return true;
    } catch (error) {
      ctx.log(`[mv-picture-gc] release FAILED | ${entry.url} | ${String(error)}`);
      return false;
    }
  };
  if (!proto._truncateCache.__mvmzPictureRetireHook) {
    const originalTruncate = proto._truncateCache;
    const patchedTruncate = function() {
      const before = [];
      try {
        const items = this?._items || {};
        for (const key of Object.keys(items)) {
          const item = items[key];
          if (item?.bitmap && isPictureBitmap(item.bitmap)) before.push([key, item.bitmap]);
        }
      } catch {
      }
      const result = originalTruncate.apply(this, arguments);
      try {
        const items = this?._items || {};
        for (const [key, bitmap] of before) if (!items[key]) retireBitmap(bitmap, "ImageCache-LRU");
      } catch {
      }
      return result;
    };
    patchedTruncate.__mvmzPictureRetireHook = true;
    proto._truncateCache = patchedTruncate;
  }
  const pressureTrim = (usedMiB) => {
    const items = cache?._items || {};
    const pictures = [];
    for (const key of Object.keys(items)) {
      const item = items[key];
      const bitmap = item?.bitmap;
      if (!bitmap || !isPictureBitmap(bitmap)) continue;
      pictures.push({ key, item, bitmap, pixels: pixelsFor(bitmap), touch: Number(item.touch || 0) });
    }
    pictures.sort((a, b) => b.touch - a.touch);
    const budgetMP = usedMiB >= 1050 ? 6 : 10;
    let budget = budgetMP * 1e6;
    let evicted = 0;
    let evictedPixels = 0;
    for (const pic of pictures) {
      const held = !!pic.item?.reservationId || pic.bitmap?._loadingState === "requesting" || pic.bitmap?._loadingState === "decrypting" || sceneUsesBitmap(pic.bitmap);
      if (held) {
        budget -= pic.pixels;
        continue;
      }
      if (budget > 0) {
        budget -= pic.pixels;
        continue;
      }
      if (items[pic.key] === pic.item) {
        delete items[pic.key];
        retireBitmap(pic.bitmap, `pressure-${budgetMP}MP`);
        evicted++;
        evictedPixels += pic.pixels;
      }
    }
    if (evicted && trimLogs < 24) {
      trimLogs++;
      ctx.log(`[mv-picture-gc] pressure trim | usedMiB=${usedMiB.toFixed(1)} budgetMP=${budgetMP} evicted=${evicted} evictedMP=${(evictedPixels / 1e6).toFixed(1)} cachePictures=${pictures.length} retired=${retired.size}`);
      if (trimLogs === 24) ctx.log("[mv-picture-gc] further trim logs suppressed");
    }
  };
  setInterval(() => {
    let usedMiB = 0;
    try {
      usedMiB = Number(Switch.memoryUsage().nativeHeapUsed || 0) / 1048576;
    } catch {
    }
    if (usedMiB >= 900) pressureTrim(usedMiB);
    const now = Number(performance.now?.() || Date.now());
    const graceMs = usedMiB >= 1050 ? 350 : 1200;
    for (const [bitmap, entry] of [...retired.entries()]) {
      if (bitmapStillCached(bitmap)) {
        retired.delete(bitmap);
        continue;
      }
      if (now - entry.retiredAt < graceMs) continue;
      if (bitmap?.__mvmzGpuPrepareInFlight) continue;
      if (sceneUsesBitmap(bitmap)) {
        entry.retiredAt = now;
        continue;
      }
      if (destroyRetiredBitmap(entry)) {
        retired.delete(bitmap);
        if (releaseLogs < 32) {
          releaseLogs++;
          ctx.log(`[mv-picture-gc] native release | ${entry.url} pixels=${entry.pixels} reason=${entry.reason} remaining=${retired.size}`);
          if (releaseLogs === 32) ctx.log("[mv-picture-gc] further release logs suppressed");
        }
      }
    }
  }, 500);
  ctx.log("[mv-picture-gc] installed | pressure>=900MiB pictureBudget=10MP >=1050MiB pictureBudget=6MP scene-reference-safe native release");
}
function installMvAssetPrewarmBridge(ctx) {
  const g = globalThis;
  const mapProto = g.Game_Map?.prototype;
  const sceneMapProto = g.Scene_Map?.prototype;
  if (!mapProto || !sceneMapProto || !g.ImageManager) {
    ctx.log("[mv-prewarm] skipped | Game_Map/Scene_Map/ImageManager unavailable");
    return;
  }
  const WARM_PIXEL_BUDGET = Math.max(0, Number(ctx.mvWarmBudgetMP ?? 18)) * 1e6;
  const WARM_MAX_ASSETS = Math.max(0, Math.floor(Number(ctx.mvWarmMaxAssets ?? 32)));
  const BACKGROUND_MAX_ASSETS = Math.max(0, Math.floor(Number(ctx.mvWarmBackgroundMax ?? 48)));
  const WARM_GATE_TIMEOUT_MS = 4e3;
  const warmManifestPath = ".mvmz_warm/manifest.json";
  let warmManifestChecked = false;
  let warmManifest = null;
  let currentReservationId = null;
  let gate = null;
  let backgroundQueue = [];
  let backgroundTimer = null;
  let orderCounter = 0;
  const folderForKind = {
    animation: "img/animations",
    battleback1: "img/battlebacks1",
    battleback2: "img/battlebacks2",
    character: "img/characters",
    face: "img/faces",
    parallax: "img/parallaxes",
    picture: "img/pictures",
    svactor: "img/sv_actors",
    tileset: "img/tilesets"
  };
  const configurePrepareLimiter = (maxPerFrame) => {
    try {
      const limiter = g.Graphics?._renderer?.plugins?.prepare?.limiter;
      if (limiter && typeof limiter.maxItemsPerFrame === "number") limiter.maxItemsPerFrame = maxPerFrame;
      if (g.PIXI?.settings) g.PIXI.settings.UPLOADS_PER_FRAME = maxPerFrame;
    } catch {
    }
  };
  const validateWarmManifest = () => {
    if (warmManifestChecked) return warmManifest;
    warmManifestChecked = true;
    try {
      if (!ctx.fs.exists(warmManifestPath)) {
        ctx.log("[mv-warm] no PC warm manifest | runtime active-page warm still enabled");
        return null;
      }
      const parsed = JSON.parse(ctx.fs.readText(warmManifestPath));
      if (parsed?.format !== "MVMZWARM" || Number(parsed?.version) !== 1) {
        ctx.log("[mv-warm] manifest ignored | unsupported format/version");
        return null;
      }
      const expected = parsed?.game_fingerprint;
      const system = ctx.fs.readBuffer("data/System.json");
      const actualHash = fnv1a32Hex(system);
      const actualBytes = system.byteLength;
      if (!expected || String(expected.system_fnv1a32).toLowerCase() !== actualHash || Number(expected.system_bytes) !== actualBytes) {
        ctx.log(`[mv-warm] manifest ignored | game fingerprint mismatch expected=${expected?.system_fnv1a32}/${expected?.system_bytes} actual=${actualHash}/${actualBytes}`);
        return null;
      }
      warmManifest = parsed;
      ctx.log(`[mv-warm] PC manifest enabled | maps=${Object.keys(parsed.maps || {}).length} assets=${Object.keys(parsed.asset_meta || {}).length} fingerprint=${actualHash}/${actualBytes}`);
      return warmManifest;
    } catch (error) {
      ctx.log(`[mv-warm] manifest load FAILED | ${String(error)}`);
      return null;
    }
  };
  const logicalFor = (kind, name) => {
    const folder = folderForKind[kind];
    return folder && name ? `${folder}/${name}.png` : "";
  };
  const makeAsset = (kind, name, hue = 0, priority = 1, source = "runtime") => {
    const normalizedName = String(name || "");
    if (!normalizedName) return null;
    const logical = logicalFor(kind, normalizedName);
    if (!logical) return null;
    const manifest = validateWarmManifest();
    const meta = manifest?.asset_meta?.[logical.toLowerCase()] || {};
    const pixels = Number(meta.pixels || 0);
    return {
      key: `${kind}|${normalizedName}|${Number(hue || 0)}`,
      kind,
      name: normalizedName,
      hue: Number(hue || 0),
      priority: Number(priority || 0),
      order: orderCounter++,
      logical,
      pixels,
      source
    };
  };
  const addAsset = (target, asset) => {
    if (!asset) return;
    const old = target.get(asset.key);
    if (!old || asset.priority < old.priority || asset.priority === old.priority && asset.order < old.order) target.set(asset.key, asset);
  };
  const addTileset = (target, tilesetId, priority = 0, source = "runtime") => {
    const tileset = g.$dataTilesets?.[Number(tilesetId || 0)];
    const names = Array.isArray(tileset?.tilesetNames) ? tileset.tilesetNames : [];
    for (const name of names) addAsset(target, makeAsset("tileset", name, 0, priority, source));
  };
  const addAnimation = (target, animationId, priority = 1, source = "runtime") => {
    const animation = g.$dataAnimations?.[Number(animationId || 0)];
    if (!animation) return;
    addAsset(target, makeAsset("animation", animation.animation1Name, Number(animation.animation1Hue || 0), priority, source));
    addAsset(target, makeAsset("animation", animation.animation2Name, Number(animation.animation2Hue || 0), priority, source));
  };
  const scanMoveRoute = (target, route, priority = 1, source = "move_route") => {
    const list = Array.isArray(route?.list) ? route.list : [];
    for (const command of list) {
      if (Number(command?.code || 0) === 41) addAsset(target, makeAsset("character", command?.parameters?.[0], 0, priority, source));
    }
  };
  const scanList = (target, list, priority = 1, depth = 0, seenCommon = /* @__PURE__ */ new Set(), source = "event") => {
    if (!Array.isArray(list)) return;
    for (const command of list) {
      const code = Number(command?.code || 0);
      const params = command?.parameters || [];
      if (code === 101) {
        addAsset(target, makeAsset("face", params[0], 0, priority, source));
      } else if (code === 117 && depth < 2) {
        const id = Number(params[0] || 0);
        if (id && !seenCommon.has(id)) {
          seenCommon.add(id);
          scanList(target, g.$dataCommonEvents?.[id]?.list, priority + 1, depth + 1, seenCommon, `common:${id}`);
        }
      } else if (code === 205) {
        scanMoveRoute(target, params[1], priority, source);
      } else if (code === 212) {
        addAnimation(target, Number(params[1] || 0), priority, source);
      } else if (code === 231) {
        addAsset(target, makeAsset("picture", params[1], 0, priority, source));
      } else if (code === 282) {
        addTileset(target, Number(params[0] || 0), priority, source);
      } else if (code === 283) {
        addAsset(target, makeAsset("battleback1", params[0], 0, priority, source));
        addAsset(target, makeAsset("battleback2", params[1], 0, priority, source));
      } else if (code === 284) {
        addAsset(target, makeAsset("parallax", params[0], 0, priority, source));
      } else if (code === 322) {
        addAsset(target, makeAsset("character", params[1], 0, priority, source));
        addAsset(target, makeAsset("face", params[3], 0, priority, source));
        addAsset(target, makeAsset("svactor", params[5], 0, priority, source));
      } else if (code === 323) {
        addAsset(target, makeAsset("character", params[1], 0, priority, source));
      }
    }
  };
  const reserveMethod = {
    animation: "reserveAnimation",
    battleback1: "reserveBattleback1",
    battleback2: "reserveBattleback2",
    character: "reserveCharacter",
    face: "reserveFace",
    parallax: "reserveParallax",
    picture: "reservePicture",
    svactor: "reserveSvActor",
    tileset: "reserveTileset"
  };
  const loadMethod = {
    animation: "loadAnimation",
    battleback1: "loadBattleback1",
    battleback2: "loadBattleback2",
    character: "loadCharacter",
    face: "loadFace",
    parallax: "loadParallax",
    picture: "loadPicture",
    svactor: "loadSvActor",
    tileset: "loadTileset"
  };
  const loadWarmAsset = (asset, reservationId) => {
    try {
      if (reservationId != null) {
        const reserve = g.ImageManager?.[reserveMethod[asset.kind]];
        if (typeof reserve === "function") return reserve.call(g.ImageManager, asset.name, asset.hue, reservationId);
      }
      const load = g.ImageManager?.[loadMethod[asset.kind]];
      if (typeof load === "function") return load.call(g.ImageManager, asset.name, asset.hue);
    } catch (error) {
      ctx.log(`[mv-warm] load FAILED | ${asset.key} | ${String(error)}`);
    }
    return null;
  };
  const warmAssetExists = (asset) => {
    try {
      if (ctx.fs.exists(asset.logical)) return true;
      const encrypted = g.Decrypter?.extToEncryptExt?.(asset.logical);
      if (encrypted && ctx.fs.exists(String(encrypted))) return true;
    } catch {
    }
    ctx.log(`[mv-warm] skip missing | ${asset.key} logical=${asset.logical}`);
    return false;
  };
  const memoryAllowsBackgroundWork = () => {
    try {
      const mem = Switch.memoryUsage();
      const total = Number(mem.nativeHeapTotal || 0);
      const used = Number(mem.nativeHeapUsed || 0);
      return total <= 0 || used / total < 0.68;
    } catch {
      return true;
    }
  };
  const startBackgroundPump = () => {
    if (backgroundTimer !== null || !backgroundQueue.length) return;
    backgroundTimer = setTimeout(() => {
      backgroundTimer = null;
      if (!backgroundQueue.length) return;
      if (!memoryAllowsBackgroundWork()) {
        startBackgroundPump();
        return;
      }
      const asset = backgroundQueue.shift();
      if (asset) {
        const bitmap = loadWarmAsset(asset);
        if (bitmap) {
          const prepare = () => queueMvGpuPrepare(ctx, bitmap, asset.key);
          try {
            if (bitmap.isReady?.()) prepare();
            else bitmap.addLoadListener?.(prepare);
          } catch {
          }
        }
      }
      if (backgroundQueue.length) backgroundTimer = setTimeout(() => {
        backgroundTimer = null;
        startBackgroundPump();
      }, 55);
    }, 55);
  };
  const finishGateIfDone = (state) => {
    if (!state || state.pending > 0 || state.completeLogged) return;
    state.completeLogged = true;
    state.completedAt = Date.now();
    configurePrepareLimiter(1);
    ctx.log(`[mv-warm] gate ready | map=${state.mapId} assets=${state.selectedCount} pixelsMP=${(state.selectedPixels / 1e6).toFixed(1)} elapsedMs=${state.completedAt - state.startedAt}`);
  };
  const watchGateBitmap = (state, asset, bitmap) => {
    if (!bitmap) return;
    state.pending++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      state.pending = Math.max(0, state.pending - 1);
      state.gpuPrepared++;
      finishGateIfDone(state);
    };
    const prepare = () => queueMvGpuPrepare(ctx, bitmap, asset.key, finish);
    try {
      if (bitmap.isReady?.()) prepare();
      else bitmap.addLoadListener?.(prepare);
    } catch (error) {
      ctx.log(`[mv-warm] gate watch FAILED | ${asset.key} | ${String(error)}`);
      finish();
    }
  };
  const releasePreviousReservation = () => {
    if (currentReservationId == null) return;
    try {
      g.ImageManager.releaseReservation?.(currentReservationId);
    } catch {
    }
    currentReservationId = null;
  };
  const collectRuntimeMapAssets = (mapId) => {
    const assets = /* @__PURE__ */ new Map();
    addTileset(assets, Number(g.$gameMap?.tilesetId?.() || 0), 0, "map_base");
    addAsset(assets, makeAsset("parallax", g.$gameMap?.parallaxName?.(), 0, 0, "map_base"));
    addAsset(assets, makeAsset("battleback1", g.$gameMap?.battleback1Name?.(), 0, 0, "map_base"));
    addAsset(assets, makeAsset("battleback2", g.$gameMap?.battleback2Name?.(), 0, 0, "map_base"));
    try {
      addAsset(assets, makeAsset("character", g.$gamePlayer?.characterName?.(), 0, 0, "player"));
    } catch {
    }
    try {
      const followers = g.$gamePlayer?.followers?.()?.visibleFollowers?.() || g.$gamePlayer?.followers?.()?._data || [];
      for (const follower of followers) addAsset(assets, makeAsset("character", follower?.characterName?.(), 0, 0, "follower"));
    } catch {
    }
    const events = g.$gameMap?.events?.() || [];
    for (const event of events) {
      addAsset(assets, makeAsset("character", event?.characterName?.(), 0, 0, `event:${event?.eventId?.() || 0}`));
      try {
        const page = event?.page?.();
        if (page?.list) scanList(assets, page.list, 1, 0, /* @__PURE__ */ new Set(), `event:${event?.eventId?.() || 0}`);
      } catch {
      }
    }
    const manifest = validateWarmManifest();
    const staticEntries = manifest?.maps?.[String(mapId)] || [];
    for (const entry of staticEntries) {
      const asset = makeAsset(entry.kind, entry.name, Number(entry.hue || 0), Number(entry.priority || 0), `pc:${entry.source || "map"}`);
      if (asset) {
        if (!asset.pixels && Number(entry.pixels || 0) > 0) asset.pixels = Number(entry.pixels || 0);
        addAsset(assets, asset);
      }
    }
    return assets;
  };
  const beginMapWarmGate = (mapId) => {
    releasePreviousReservation();
    if (backgroundTimer !== null) {
      clearTimeout(backgroundTimer);
      backgroundTimer = null;
    }
    backgroundQueue = [];
    orderCounter = 0;
    currentReservationId = Number(g.Utils?.generateRuntimeId?.() || Date.now() & 2147483647);
    const assetMap = collectRuntimeMapAssets(mapId);
    const orderedAll = Array.from(assetMap.values()).sort((a, b) => a.priority - b.priority || a.order - b.order);
    const ordered = orderedAll.filter(warmAssetExists);
    const selected = [];
    const overflow = [];
    let pixels = 0;
    for (const asset of ordered) {
      const estimate = asset.pixels > 0 ? asset.pixels : 262144;
      const mustHave = asset.priority === 0;
      if (selected.length < WARM_MAX_ASSETS && (mustHave || pixels + estimate <= WARM_PIXEL_BUDGET)) {
        selected.push(asset);
        pixels += estimate;
      } else if (overflow.length < BACKGROUND_MAX_ASSETS) {
        overflow.push(asset);
      }
    }
    gate = {
      mapId,
      token: Number(g.Utils?.generateRuntimeId?.() || Date.now()),
      reservationId: currentReservationId,
      pending: 0,
      gpuPrepared: 0,
      selectedCount: selected.length,
      selectedPixels: pixels,
      startedAt: Date.now(),
      deadline: Date.now() + WARM_GATE_TIMEOUT_MS,
      released: false,
      completeLogged: false
    };
    configurePrepareLimiter(2);
    const selectedSummary = selected.slice(0, 16).map((asset) => `${asset.kind}:${asset.name}@p${asset.priority}`).join(",");
    ctx.log(`[mv-warm] gate start | map=${mapId} selected=${selected.length}/${ordered.length} discovered=${orderedAll.length} pixelsMP=${(pixels / 1e6).toFixed(1)} overflow=${overflow.length} manifest=${!!warmManifest} assets=${selectedSummary || "(none)"}`);
    for (const asset of selected) {
      const bitmap = loadWarmAsset(asset, currentReservationId);
      watchGateBitmap(gate, asset, bitmap);
    }
    backgroundQueue = overflow;
    finishGateIfDone(gate);
  };
  const originalSetup = mapProto.setup;
  mapProto.setup = function(mapId) {
    const result = originalSetup.call(this, mapId);
    beginMapWarmGate(Number(mapId || 0));
    return result;
  };
  const originalSceneMapIsReady = sceneMapProto.isReady;
  sceneMapProto.isReady = function() {
    const ready = originalSceneMapIsReady.call(this);
    if (!ready) return false;
    const state = gate;
    if (!state || state.mapId !== Number(g.$gameMap?.mapId?.() || 0) || state.released) return ready;
    if (state.pending <= 0) {
      state.released = true;
      configurePrepareLimiter(1);
      ctx.log(`[mv-warm] gate release | map=${state.mapId} reason=ready gpuPrepared=${state.gpuPrepared}/${state.selectedCount} elapsedMs=${Date.now() - state.startedAt}`);
      startBackgroundPump();
      return true;
    }
    if (Date.now() >= state.deadline) {
      state.released = true;
      configurePrepareLimiter(1);
      ctx.log(`[mv-warm] gate timeout | map=${state.mapId} pending=${state.pending} gpuPrepared=${state.gpuPrepared}/${state.selectedCount} elapsedMs=${Date.now() - state.startedAt} -> scene start, remaining continues in background`);
      startBackgroundPump();
      return true;
    }
    return false;
  };
  const interpreterProto = g.Game_Interpreter?.prototype;
  if (interpreterProto?.setup) {
    const originalInterpreterSetup = interpreterProto.setup;
    interpreterProto.setup = function(list, eventId) {
      const result = originalInterpreterSetup.call(this, list, eventId);
      try {
        const dynamic = /* @__PURE__ */ new Map();
        scanList(dynamic, list, 1, 0, /* @__PURE__ */ new Set(), `interpreter:${eventId || 0}`);
        for (const asset of dynamic.values()) {
          if (backgroundQueue.length >= BACKGROUND_MAX_ASSETS) break;
          if (!backgroundQueue.some((item) => item.key === asset.key)) backgroundQueue.push(asset);
        }
        if (!gate || gate.released) startBackgroundPump();
      } catch {
      }
      return result;
    };
  }
  validateWarmManifest();
  configurePrepareLimiter(1);
  ctx.log(`[mv-warm] map-start gate installed | budgetMP=${(WARM_PIXEL_BUDGET / 1e6).toFixed(0)} maxAssets=${WARM_MAX_ASSETS} gateTimeoutMs=${WARM_GATE_TIMEOUT_MS} backgroundMax=${BACKGROUND_MAX_ASSETS}`);
}
function installMvFinalFrameDiagnostics(ctx) {
  const g = globalThis;
  const sm = g.SceneManager;
  if (!sm || !g.Scene_Boot) return;
  const originalStop = sm.stop.bind(sm);
  sm.stop = function() {
    ctx.log("[mv-frame] STOP requested");
    return originalStop();
  };
  const pluginCatch = sm.catchException?.bind(sm);
  sm.catchException = function(error) {
    ctx.log(`[mv-frame] EXCEPTION | ${error?.stack ?? String(error)}`);
    try {
      return pluginCatch?.(error);
    } catch (secondary) {
      ctx.log(`[mv-frame] exception reporter FAILED | ${secondary?.stack ?? String(secondary)}`);
      sm._stopped = true;
    }
  };
  const originalUpdateScene = sm.updateScene.bind(sm);
  let frameCount = 0;
  sm.updateScene = function() {
    frameCount++;
    try {
      return originalUpdateScene();
    } catch (error) {
      ctx.log(`[mv-frame] updateScene FAILED frame=${frameCount} scene=${sm._scene?.constructor?.name ?? "none"} started=${!!sm._sceneStarted} | ${error?.stack ?? String(error)}`);
      throw error;
    }
  };
  const originalBootStart = g.Scene_Boot.prototype.start;
  g.Scene_Boot.prototype.start = function(...args) {
    ctx.log("[mv-boot] start ENTER");
    try {
      const result = originalBootStart.apply(this, args);
      ctx.log(`[mv-boot] start EXIT | next=${sm._nextScene?.constructor?.name ?? "none"}`);
      return result;
    } catch (error) {
      ctx.log(`[mv-boot] start FAILED | ${error?.stack ?? String(error)}`);
      throw error;
    }
  };
  ctx.log("[mv-frame] final post-plugin diagnostics installed");
}
function isBrowserLibrary(path) {
  return /(?:^|\/)js\/libs\//i.test(path);
}
function isOptionalMvLibrary(path) {
  return /(?:fpsmeter|iphone-inline-video)/i.test(path);
}
function installMissingPluginsManifestFallback(log) {
  const g = globalThis;
  if (!Array.isArray(g.$plugins)) g.$plugins = [];
  log("[mv] plugins.js missing -> synthesized empty $plugins");
}
function installMissingMainFallback(log) {
  const g = globalThis;
  if (!g.PluginManager || !g.SceneManager || !g.Scene_Boot) {
    throw new Error("Cannot synthesize MV main.js before core engine is ready");
  }
  g.PluginManager.setup(Array.isArray(g.$plugins) ? g.$plugins : []);
  g.onload = function() {
    g.SceneManager.run(g.Scene_Boot);
  };
  log("[mv] main.js missing -> synthesized standard MV bootstrap");
}
function dispatchWindowLoad(log) {
  const g = globalThis;
  const event = new Event("load");
  if (typeof g.onload === "function") {
    log("[mv] invoking window.onload");
    g.onload(event);
  }
  try {
    g.dispatchEvent?.(event);
  } catch {
  }
}
export async function bootMv(ctx, scripts) {
  const { fs, log } = ctx;
  const document = globalThis.document;
  installMvNodeRequireCompat(ctx);
  installFpsFallback(log);
  scripts.installDynamicScriptBridge(document);
  scripts.onAfterScript((relative) => afterCoreScript(relative, ctx));
  const indexHtml = fs.readText("index.html");
  const sources = extractScriptSources(indexHtml);
  if (!sources.length) throw new Error("MV index.html has no external scripts");
  log(`[mv] index scripts=${sources.length} | ${sources.join(", ")}`);
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex];
    if (!fs.exists(source)) {
      if (isOptionalMvLibrary(source)) {
        log(`[mv] optional script missing, fallback used | ${source}`);
        installFpsFallback(log);
        continue;
      }
      if (/^js\/plugins\.js$/i.test(source)) {
        installMissingPluginsManifestFallback(log);
        continue;
      }
      if (/^js\/main\.js$/i.test(source)) {
        installMissingMainFallback(log);
        continue;
      }
      throw new Error(`MV script missing: ${source}`);
    }
    scripts.loadNow(source, isBrowserLibrary(source), void 0, document);
    afterCoreScript(source, ctx);
  }
  await scripts.drain();
  installMvPostPluginSaveCompat(ctx);
  restoreMvCoreAudioForStreamingPlugin(ctx);
  installMvAudioDiagnostics(ctx);
  installMvNativeAudioStream(ctx);
  log("[mv-audio] post-plugin host transport re-applied");
  installMvBitmapDecodeBridge(ctx);
  installMvKoreanFontFallback(ctx);
  installMvBootReadinessDiagnostics(ctx);
  installMvGraphicsPerformanceBridge(ctx);
  installMvNativeVideoBridge(ctx);
  installMvImageCachePolicy(ctx);
  installMvPictureMemoryReclaimer(ctx);
  log('[mv-warm] V049 all manifest/map warm gates remain disabled; natural on-demand MV loading retained');
  installMvFinalFrameDiagnostics(ctx);
  const g = globalThis;
  if (!g.Utils || g.Utils.RPGMAKER_NAME !== "MV") {
    throw new Error(`MV engine identity mismatch: ${g.Utils?.RPGMAKER_NAME ?? "missing"}`);
  }
  log(`[mv] core/plugins ready | version=${g.Utils.RPGMAKER_VERSION}`);
  dispatchWindowLoad(log);
}


