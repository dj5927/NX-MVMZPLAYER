import type { RuntimeContext } from '../types';
import { extractScriptSources, ScriptLoader } from '../host/scripts';
import { installMZStandaloneHostPump } from './mz_standalone';
import { installMZAudioCompat } from './mz_audio';
import { isWoff1, woff1ToSfnt } from '../compat/woff_sfnt';

function mzSfntHasHangul(data: ArrayBuffer | ArrayBufferView) {
  try {
    const bytes = data instanceof Uint8Array
      ? data
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 12) return false;
    const tableCount = view.getUint16(4, false);
    let cmapOffset = -1;
    let cmapLength = 0;
    for (let i = 0; i < tableCount; i++) {
      const p = 12 + i * 16;
      if (p + 16 > bytes.byteLength) break;
      const tag = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
      if (tag !== 'cmap') continue;
      cmapOffset = view.getUint32(p + 8, false);
      cmapLength = view.getUint32(p + 12, false);
      break;
    }
    if (cmapOffset < 0 || cmapOffset + cmapLength > bytes.byteLength) return false;
    const end = cmapOffset + cmapLength;
    const subCount = view.getUint16(cmapOffset + 2, false);
    const target = 0xd55c; // 한
    for (let i = 0; i < subCount; i++) {
      const p = cmapOffset + 4 + i * 8;
      if (p + 8 > end) break;
      const sub = cmapOffset + view.getUint32(p + 4, false);
      if (sub + 2 > end) continue;
      const format = view.getUint16(sub, false);
      if (format === 12 && sub + 16 <= end) {
        const groups = view.getUint32(sub + 12, false);
        for (let j = 0; j < groups; j++) {
          const gp = sub + 16 + j * 12;
          if (gp + 12 > end) break;
          const start = view.getUint32(gp, false);
          const finish = view.getUint32(gp + 4, false);
          if (target >= start && target <= finish) return true;
        }
      } else if (format === 4 && sub + 16 <= end) {
        const segCount = view.getUint16(sub + 6, false) / 2;
        const endCode = sub + 14;
        const startCode = endCode + segCount * 2 + 2;
        const idDelta = startCode + segCount * 2;
        const idRangeOffset = idDelta + segCount * 2;
        for (let j = 0; j < segCount; j++) {
          const finish = view.getUint16(endCode + j * 2, false);
          const start = view.getUint16(startCode + j * 2, false);
          if (target < start || target > finish) continue;
          const delta = view.getInt16(idDelta + j * 2, false);
          const range = view.getUint16(idRangeOffset + j * 2, false);
          if (range === 0) return ((target + delta) & 0xffff) !== 0;
          const rp = idRangeOffset + j * 2;
          const glyphPos = rp + range + (target - start) * 2;
          if (glyphPos + 2 > end) return false;
          let glyph = view.getUint16(glyphPos, false);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          return glyph !== 0;
        }
      }
    }
  } catch {}
  return false;
}

function installMZFontBridge(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const fm = g.FontManager;
  if (!fm) return;

  fm._states = fm._states || {};
  fm._urls = fm._urls || {};
  g.__mvmzMzHangulFontFamilies = g.__mvmzMzHangulFontFamilies || new Set<string>();
  fm.load = function(family: string, filename: string) {
    if (!filename) return;
    const clean = String(filename).replace(/^\.\//, '');
    const relative = clean.startsWith('fonts/') ? clean : `fonts/${clean}`;
    try {
      const sourceBytes = ctx.fs.readBuffer(relative);
      let fontBytes: any = sourceBytes;
      let sourceFormat = 'sfnt';
      if (isWoff1(sourceBytes)) {
        sourceFormat = 'woff1';
        try {
          fontBytes = woff1ToSfnt(sourceBytes);
          ctx.log(`[mz-font] WOFF1 -> SFNT | ${family} <- ${relative} sourceBytes=${Number((sourceBytes as any)?.byteLength || 0)} sfntBytes=${Number(fontBytes?.byteLength || 0)}`);
        } catch (convertError) {
          fontBytes = sourceBytes;
          ctx.log(`[mz-font] WOFF1 -> SFNT FAILED; using original bytes | ${family} <- ${relative} | ${String((convertError as any)?.stack ?? convertError)}`);
        }
      } else {
        try {
          const raw = sourceBytes instanceof Uint8Array ? sourceBytes : new Uint8Array((sourceBytes as any).buffer ?? sourceBytes);
          if (raw.length >= 4 && String.fromCharCode(raw[0], raw[1], raw[2], raw[3]) === 'wOF2') sourceFormat = 'woff2';
        } catch {}
      }
      const face = new FontFace(family, fontBytes);
      g.fonts?.add(face);
      const hangul = mzSfntHasHangul(fontBytes);
      if (hangul) g.__mvmzMzHangulFontFamilies.add(String(family));
      fm._urls[family] = relative;
      fm._states[family] = 'loaded';
      g.__mvmzMzFontFormats = g.__mvmzMzFontFormats || {};
      g.__mvmzMzFontFormats[String(family)] = sourceFormat;
      ctx.log(`[mz-font] registered | ${family} <- ${relative} format=${sourceFormat} hangul=${hangul} status=${face.status}`);
      if (String(family) === 'rmmz-numberfont') g.__mvmzMzRunNumberProbe?.();
    } catch (error) {
      fm._states[family] = 'error';
      ctx.log(`[mz-font] FAILED | ${family} <- ${relative} | ${String(error)}`);
    }
  };
  fm.isReady = function() {
    return !Object.values(fm._states || {}).some(state => state === 'loading');
  };

  const fallbackFamily = 'MVMZ_KoreanFallback';
  try {
    if (!g.__mvmzMzKoreanFallbackLoaded) {
      const bytes = Switch.readFileSync('romfs:/fonts/NotoSansCJKkr-Regular.otf');
      if (!bytes) throw new Error('romfs fallback font not found');
      const face = new FontFace(fallbackFamily, bytes);
      g.fonts?.add(face);
      g.__mvmzMzKoreanFallbackLoaded = true;
      g.__mvmzMzHangulFontFamilies.add(fallbackFamily);
      ctx.log(`[mz-font] Korean fallback registered | ${fallbackFamily} status=${face.status}`);
    }
  } catch (error) {
    ctx.log(`[mz-font] Korean fallback registration FAILED | ${String(error)}`);
  }

  if (g.__mvmzMzKoreanFallbackLoaded) {
    g.__mvmzCanvasHangulFallbackFamily = fallbackFamily;
    if (!g.__mvmzCanvasHangulFallbackLogger) {
      let canvasFallbackLogs = 0;
      g.__mvmzCanvasHangulFallbackLogger = (op: string, text: any, originalFont: any) => {
        if (canvasFallbackLogs >= 8) return;
        canvasFallbackLogs++;
        ctx.log(`[mz-font] Canvas Hangul fallback HIT | op=${op} original=${String(originalFont || '')} sample=${String(text || '').slice(0, 24)}`);
        if (canvasFallbackLogs === 8) ctx.log('[mz-font] further Canvas Hangul fallback logs suppressed');
      };
    }
  }

  const systemProto = g.Game_System?.prototype;
  if (systemProto?.mainFontFace && !systemProto.mainFontFace.__mvmzKoreanFallback) {
    const originalMainFontFace = systemProto.mainFontFace;
    const patchedMainFontFace = function(this: any) {
      const base = String(originalMainFontFace.call(this) || '');
      if (!g.__mvmzMzKoreanFallbackLoaded || base.includes(fallbackFamily)) return base;
      const parts = base.split(',').map((name: string) => name.trim()).filter(Boolean);
      if (parts.length > 0) parts.splice(1, 0, fallbackFamily);
      else parts.push(fallbackFamily);
      return parts.join(', ');
    };
    patchedMainFontFace.__mvmzKoreanFallback = true;
    systemProto.mainFontFace = patchedMainFontFace;
    ctx.log(`[mz-font] Game_System mainFontFace fallback injected | family=${fallbackFamily}`);
  }
  const bitmapProto = g.Bitmap?.prototype;
  const hasHangul = (value: any) => /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/.test(String(value ?? ''));
  const gameFontHasHangul = (bitmap: any) => {
    const stack = String(bitmap?.fontFace || '').split(',').map((name: string) => name.trim().replace(/^["']|["']$/g, ''));
    return stack.some((name: string) => g.__mvmzMzHangulFontFamilies.has(name));
  };
  if (bitmapProto && g.__mvmzMzKoreanFallbackLoaded) {
    if (typeof bitmapProto.drawText === 'function' && !bitmapProto.drawText.__mvmzKoreanDirectDraw) {
      const originalDrawText = bitmapProto.drawText;
      const patchedDrawText = function(this: any, text: any, ...args: any[]) {
        if (!hasHangul(text) || gameFontHasHangul(this)) return originalDrawText.call(this, text, ...args);
        if (!g.__mvmzMzKoreanDirectDrawLogged) {
          g.__mvmzMzKoreanDirectDrawLogged = true;
          ctx.log(`[mz-font] first Hangul draw routed to ${fallbackFamily} | original=${String(this.fontFace || '')}`);
        }
        const previous = this.fontFace;
        this.fontFace = fallbackFamily;
        try {
          return originalDrawText.call(this, text, ...args);
        } finally {
          this.fontFace = previous;
        }
      };
      patchedDrawText.__mvmzKoreanDirectDraw = true;
      bitmapProto.drawText = patchedDrawText;
    }
    if (typeof bitmapProto.measureTextWidth === 'function' && !bitmapProto.measureTextWidth.__mvmzKoreanDirectMeasure) {
      const originalMeasure = bitmapProto.measureTextWidth;
      const patchedMeasure = function(this: any, text: any) {
        if (!hasHangul(text) || gameFontHasHangul(this)) return originalMeasure.call(this, text);
        const previous = this.fontFace;
        this.fontFace = fallbackFamily;
        try {
          return originalMeasure.call(this, text);
        } finally {
          this.fontFace = previous;
        }
      };
      patchedMeasure.__mvmzKoreanDirectMeasure = true;
      bitmapProto.measureTextWidth = patchedMeasure;
    }
    if (typeof bitmapProto._makeFontNameText === 'function' && !bitmapProto._makeFontNameText.__mvmzKoreanFallback) {
      const originalMakeFont = bitmapProto._makeFontNameText;
      const patchedMakeFont = function(this: any) {
        const base = String(originalMakeFont.call(this));
        return base.includes(fallbackFamily) ? base : `${base}, ${fallbackFamily}`;
      };
      patchedMakeFont.__mvmzKoreanFallback = true;
      bitmapProto._makeFontNameText = patchedMakeFont;
      ctx.log('[mz-font] Korean fallback family appended to Bitmap font stack');
    }
  }
  g.__mvmzMzRunNumberProbe = () => {
    if (g.__mvmzMzNumberProbeDone || fm._states?.['rmmz-numberfont'] !== 'loaded') return;
  g.__mvmzMzNumberProbeDone = true;
      try {
        const canvas = g.document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 64;
        const c = canvas.getContext('2d');
        if (c) {
          const hashText = (text: string) => {
            c.clearRect(0, 0, 320, 64);
            c.font = '40px rmmz-numberfont';
            c.fillStyle = '#fff';
            c.fillText(text, 2, 48);
            const pixels = c.getImageData(0, 0, 320, 64).data;
            let hash = 2166136261;
            let ink = 0;
            for (let i = 0; i < pixels.length; i++) {
              hash ^= pixels[i];
              hash = Math.imul(hash, 16777619) >>> 0;
              if ((i & 3) === 3 && pixels[i]) ink++;
            }
            return { hash: hash.toString(16).padStart(8, '0'), ink };
          };
          const digits = hashText('0123456789');
          const missing = hashText('\u0378\u0378\u0378\u0378\u0378');
          ctx.log(`[mz-font] numberfont canvas probe | format=${String(g.__mvmzMzFontFormats?.['rmmz-numberfont'] || 'unknown')} digitsHash=${digits.hash} missingHash=${missing.hash} different=${digits.hash !== missing.hash} inkPixels=${digits.ink}`);
        }
      } catch (probeError) {
        ctx.log(`[mz-font] numberfont canvas probe FAILED | ${String((probeError as any)?.stack ?? probeError)}`);
      }
  };
  g.__mvmzMzRunNumberProbe();

  if (g.__mvmzMzKoreanFallbackLoaded && !g.__mvmzMzKoreanProbeDone) {
    g.__mvmzMzKoreanProbeDone = true;
    try {
      const canvas = g.document.createElement('canvas');
      canvas.width = 192;
      canvas.height = 48;
      const c = canvas.getContext('2d');
      if (c) {
        const hashText = (text: string) => {
          c.clearRect(0, 0, 192, 48);
          c.font = `32px ${fallbackFamily}`;
          c.fillStyle = '#fff';
          c.fillText(text, 0, 36);
          const pixels = c.getImageData(0, 0, 192, 48).data;
          let hash = 2166136261;
          let ink = 0;
          for (let i = 0; i < pixels.length; i++) {
            hash ^= pixels[i];
            hash = Math.imul(hash, 16777619) >>> 0;
            if ((i & 3) === 3 && pixels[i]) ink++;
          }
          return { hash: hash.toString(16).padStart(8, '0'), ink };
        };
        const korean = hashText('한글가힣');
        const missing = hashText('\u0378\u0378\u0378\u0378');
        ctx.log(`[mz-font] Korean fallback canvas probe | koreanHash=${korean.hash} missingHash=${missing.hash} different=${korean.hash !== missing.hash} inkPixels=${korean.ink}`);
      }
    } catch (probeError) {
      ctx.log(`[mz-font] Korean fallback canvas probe FAILED | ${String(probeError)}`);
    }
  }
  ctx.log('[mz-font] ResourceFS FontManager bridge installed');
}

function installMZBitmapCanvasBridge(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const proto = g.Bitmap?.prototype;
  if (!proto || proto.__mvmzCanvasUploadBridge) return;
  proto.__mvmzCanvasUploadBridge = true;
  const originalOnLoad = proto._onLoad;
  let logged = 0;

  proto._onLoad = function() {
    const image = this._image;
    if (!image || !(Number(image.width) > 0) || !(Number(image.height) > 0)) {
      return originalOnLoad.call(this);
    }
    try {
      const canvas = g.document.createElement('canvas');
      canvas.width = Math.max(1, Number(image.width) || 1);
      canvas.height = Math.max(1, Number(image.height) || 1);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D canvas unavailable');
      context.drawImage(image, 0, 0);
      if (g.Utils?.hasEncryptedImages?.()) {
        try { URL.revokeObjectURL(image.src); } catch {}
      }
      try { (canvas as any).src = String(image.src || ''); } catch {}
      this._canvas = canvas;
      this._context = context;
      // Some MZ plugins bypass Bitmap.image/canvas and call
      // drawImage(bitmap._image, ...) directly. Keep the private image slot
      // image-like by pointing it at the same CanvasShim used by the HOS-safe
      // texture path.
      this._image = canvas;
      this._loadingState = 'loaded';
      this._createBaseTexture(canvas);
      this._callLoadListeners();
      if (logged < 24) {
        logged++;
        ctx.log(`[mz-img] native Image -> Canvas texture | ${String(this._url || '(anonymous)')} ${canvas.width}x${canvas.height}`);
        if (logged === 24) ctx.log('[mz-img] further Image -> Canvas logs suppressed');
      }
      return;
    } catch (error) {
      ctx.log(`[mz-img] Canvas texture bridge FAILED -> native fallback | ${String(this._url || '(anonymous)')} | ${String((error as any)?.stack ?? error)}`);
      return originalOnLoad.call(this);
    }
  };

  ctx.log('[mz-img] native Image -> OffscreenCanvas -> Pixi texture bridge installed');
}

function installMZOffscreenPresenter(ctx: RuntimeContext, graphics: any) {
  const g: any = globalThis as any;
  const app = graphics?._app;
  const renderer = app?.renderer;
  const pixi = g.PIXI;
  if (!app || !renderer || !pixi?.RenderTexture || app.__mvmzOffscreenPresenter) return;
  app.__mvmzOffscreenPresenter = true;

  let target: any = null;
  let targetWidth = 0;
  let targetHeight = 0;
  let presentLogs = 0;

  const ensureTarget = (width: number, height: number) => {
    if (!target) {
      target = pixi.RenderTexture.create({
        width,
        height,
        resolution: 1,
        scaleMode: pixi.SCALE_MODES?.LINEAR ?? 1
      });
      targetWidth = width;
      targetHeight = height;
      ctx.log(`[mz-gfx] offscreen target created | ${width}x${height}`);
    } else if (targetWidth !== width || targetHeight !== height) {
      target.resize(width, height, true);
      targetWidth = width;
      targetHeight = height;
      ctx.log(`[mz-gfx] offscreen target resized | ${width}x${height}`);
    }
    return target;
  };

  app.render = function() {
    const stage = this.stage;
    if (!stage) return;
    const logicalWidth = Math.max(1, Math.round(Number(graphics.width || graphics._width || renderer.screen?.width || 1)));
    const logicalHeight = Math.max(1, Math.round(Number(graphics.height || graphics._height || renderer.screen?.height || 1)));
    const rt = ensureTarget(logicalWidth, logicalHeight);

    // All RPG Maker/Pixi/plugin drawing happens on a logical 0,0 framebuffer.
    // No physical 1280x720 letterbox offset is visible to filters or shaders.
    renderer.render(stage, rt, true);

    const gl = renderer.gl;
    const fbSystem = renderer.framebuffer;
    const pixiFramebuffer = rt?.baseTexture?.framebuffer;
    const contextUid = fbSystem?.CONTEXT_UID;
    const fboInfo = pixiFramebuffer?.glFramebuffers?.[contextUid];
    const sourceFramebuffer = fboInfo?.framebuffer;
    if (!gl?.blitFramebuffer || sourceFramebuffer == null) {
      if (presentLogs < 4) {
        presentLogs++;
        ctx.log(`[mz-gfx] offscreen blit unavailable | gl=${!!gl} fbo=${!!sourceFramebuffer} uid=${String(contextUid)}`);
      }
      return;
    }

    const physicalWidth = Math.max(1, Number(gl.drawingBufferWidth || g.screen?.width || 1280));
    const physicalHeight = Math.max(1, Number(gl.drawingBufferHeight || g.screen?.height || 720));
    const scale = Math.min(physicalWidth / logicalWidth, physicalHeight / logicalHeight);
    const fitWidth = Math.max(1, Math.round(logicalWidth * scale));
    const fitHeight = Math.max(1, Math.round(logicalHeight * scale));
    const fitX = Math.floor((physicalWidth - fitWidth) / 2);
    const fitY = Math.floor((physicalHeight - fitHeight) / 2);

    const scissorEnabled = !!gl.isEnabled?.(gl.SCISSOR_TEST);
    let presentError = 0;
    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sourceFramebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      if (scissorEnabled) gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // Pixi RenderTexture uses an offscreen projection with Y inverted
      // relative to the default framebuffer. Reverse destination Y during
      // the final raw WebGL2 blit so screen orientation remains browser-like.
      gl.blitFramebuffer(
        0, 0, logicalWidth, logicalHeight,
        fitX, fitY + fitHeight, fitX + fitWidth, fitY,
        gl.COLOR_BUFFER_BIT, gl.LINEAR
      );
      presentError = Number(gl.getError?.() || 0);
    } finally {
      try { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); } catch {}
      try { gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null); } catch {}
      if (scissorEnabled) { try { gl.enable(gl.SCISSOR_TEST); } catch {} }
      if (fbSystem) {
        fbSystem.current = null;
        if (fbSystem.viewport) {
          fbSystem.viewport.width = -1;
          fbSystem.viewport.height = -1;
        }
      }
      if (renderer.renderTexture) renderer.renderTexture.current = null;
    }

    g.__mvmzViewportFit = {
      logicalWidth, logicalHeight, physicalWidth, physicalHeight, scale,
      x: fitX, y: fitY, width: fitWidth, height: fitHeight,
      top: physicalHeight - (fitY + fitHeight)
    };
    if (presentLogs < 6) {
      presentLogs++;
      ctx.log(`[mz-gfx] offscreen present | logical=${logicalWidth}x${logicalHeight} physical=${physicalWidth}x${physicalHeight} dst=${fitX},${fitY},${fitWidth}x${fitHeight} flipY=true glError=${presentError}`);
      if (presentLogs === 6) ctx.log('[mz-gfx] further offscreen present logs suppressed');
    }
  };

  ctx.log('[mz-gfx] logical offscreen -> physical WebGL2 blit presenter installed');
}

function installMZSceneDiagnostics(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const sm = g.SceneManager;
  if (!sm || (sm as any).__mvmzMzDiagnostics) return;
  (sm as any).__mvmzMzDiagnostics = true;
  const critical = (message: string) => {
    ctx.log(message);
    try { ctx.flushLog?.(); } catch {}
  };

  if (typeof sm.run === 'function') {
    const originalRun = sm.run.bind(sm);
    sm.run = function(sceneClass: any) {
      ctx.log(`[mz-scene] run -> ${sceneClass?.name ?? 'unknown'}`);
      return originalRun(sceneClass);
    };
  }
  if (typeof sm.goto === 'function') {
    const originalGoto = sm.goto.bind(sm);
    sm.goto = function(sceneClass: any) {
      const sceneName = String(sceneClass?.name ?? 'null');
      ctx.log(`[mz-scene] goto -> ${sceneName}`);
      if (/^Scene_(?:Title|TitleMap|Map|Load|Options|Menu|Battle)/.test(sceneName)) {
        try {
          const gl = g.Graphics?._app?.renderer?.gl;
          if (gl?.getError) {
            for (let i = 0; i < 8; i++) {
              if (!Number(gl.getError() || 0)) break;
            }
          }
        } catch {}
        g.__mvmzGlErrorTraceEnabled = true;
        g.__mvmzGlErrorTraceBudget = 12;
      }
      return originalGoto(sceneClass);
    };
  }
  if (typeof sm.catchException === 'function') {
    const originalCatch = sm.catchException.bind(sm);
    sm.catchException = function(error: any) {
      critical(`[mz-scene] exception | ${error?.stack ?? String(error)}`);
      return originalCatch(error);
    };
  }
  if (typeof sm.onError === 'function') {
    const originalOnError = sm.onError.bind(sm);
    sm.onError = function(event: any) {
      critical(`[mz-scene] window error | message=${String(event?.message ?? event)} file=${String(event?.filename ?? '')} line=${String(event?.lineno ?? '')}`);
      return originalOnError(event);
    };
  }
  if (typeof sm.onReject === 'function') {
    const originalOnReject = sm.onReject.bind(sm);
    sm.onReject = function(event: any) {
      const reason = event?.reason;
      critical(`[mz-scene] unhandled rejection | ${String(reason?.stack ?? reason ?? event)}`);
      return originalOnReject(event);
    };
  }
  if (typeof sm.stop === 'function') {
    const originalStop = sm.stop.bind(sm);
    sm.stop = function() {
      const stack = String(new Error('SceneManager.stop trace').stack ?? '').split('\n').slice(1, 6).join(' | ');
      critical(`[mz-scene] stop requested | ${stack}`);
      return originalStop();
    };
  }
  ctx.log('[mz-scene] diagnostics installed');
}

function installMZBattleLifecycleDiagnostics(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  if (g.__mvmzMzBattleLifecycleDiagnostics) return;
  g.__mvmzMzBattleLifecycleDiagnostics = true;
  const critical = (message: string) => {
    ctx.log(message);
    try { ctx.flushLog?.(); } catch {}
  };
  const sceneName = (value: any) => String(value?.constructor?.name ?? value?.name ?? 'none');

  const battleProto = g.Scene_Battle?.prototype;
  if (battleProto && typeof battleProto.stop === 'function') {
    const originalStop = battleProto.stop;
    battleProto.stop = function(...args: any[]) {
      ctx.log(`[mz-battle] Scene_Battle.stop begin | next=${sceneName(g.SceneManager?._nextScene)}`);
      try {
        const result = originalStop.apply(this, args);
        ctx.log('[mz-battle] Scene_Battle.stop end');
        return result;
      } catch (error) {
        critical(`[mz-battle] Scene_Battle.stop FAILED | ${String((error as any)?.stack ?? error)}`);
        throw error;
      }
    };
  }
  if (battleProto && typeof battleProto.terminate === 'function') {
    const originalTerminate = battleProto.terminate;
    battleProto.terminate = function(...args: any[]) {
      ctx.log(`[mz-battle] Scene_Battle.terminate begin | next=${sceneName(g.SceneManager?._nextScene)} autosave=${String(this.shouldAutosave?.())}`);
      try {
        const result = originalTerminate.apply(this, args);
        ctx.log('[mz-battle] Scene_Battle.terminate end');
        return result;
      } catch (error) {
        critical(`[mz-battle] Scene_Battle.terminate FAILED | ${String((error as any)?.stack ?? error)}`);
        throw error;
      }
    };
  }

  const baseProto = g.Scene_Base?.prototype;
  if (baseProto && typeof baseProto.executeAutosave === 'function' && !baseProto.executeAutosave.__mvmzTrace) {
    const originalAutosave = baseProto.executeAutosave;
    const wrappedAutosave = function(this: any, ...args: any[]) {
      ctx.log(`[mz-battle] autosave dispatch begin | scene=${sceneName(this)}`);
      try {
        const result = originalAutosave.apply(this, args);
        ctx.log(`[mz-battle] autosave dispatch end | scene=${sceneName(this)}`);
        return result;
      } catch (error) {
        critical(`[mz-battle] autosave dispatch FAILED | ${String((error as any)?.stack ?? error)}`);
        throw error;
      }
    };
    wrappedAutosave.__mvmzTrace = true;
    baseProto.executeAutosave = wrappedAutosave;
  }

  const dm = g.DataManager;
  if (dm && typeof dm.saveGame === 'function' && !dm.saveGame.__mvmzTrace) {
    const originalSaveGame = dm.saveGame;
    const wrappedSaveGame = function(this: any, savefileId: any, ...args: any[]) {
      ctx.log(`[mz-battle] DataManager.saveGame begin | id=${String(savefileId)}`);
      try {
        const value = originalSaveGame.call(this, savefileId, ...args);
        return Promise.resolve(value).then(
          result => { ctx.log(`[mz-battle] DataManager.saveGame resolved | id=${String(savefileId)}`); return result; },
          error => { critical(`[mz-battle] DataManager.saveGame rejected | id=${String(savefileId)} | ${String((error as any)?.stack ?? error)}`); throw error; }
        );
      } catch (error) {
        critical(`[mz-battle] DataManager.saveGame threw | id=${String(savefileId)} | ${String((error as any)?.stack ?? error)}`);
        throw error;
      }
    };
    wrappedSaveGame.__mvmzTrace = true;
    dm.saveGame = wrappedSaveGame;
  }

  const audio = g.AudioManager;
  if (audio && typeof audio.stopMe === 'function' && !audio.stopMe.__mvmzTrace) {
    const originalStopMe = audio.stopMe;
    const wrappedStopMe = function(this: any, ...args: any[]) {
      ctx.log(`[mz-battle] AudioManager.stopMe begin | hasMe=${!!this._meBuffer}`);
      try {
        const result = originalStopMe.apply(this, args);
        ctx.log(`[mz-battle] AudioManager.stopMe end | hasMe=${!!this._meBuffer}`);
        return result;
      } catch (error) {
        critical(`[mz-battle] AudioManager.stopMe FAILED | ${String((error as any)?.stack ?? error)}`);
        throw error;
      }
    };
    wrappedStopMe.__mvmzTrace = true;
    audio.stopMe = wrappedStopMe;
  }

  ctx.log('[mz-battle] lifecycle/autosave/audio diagnostics installed | per-frame changeScene trace=off');
}

function installMZGraphicsCompat(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const graphics = g.Graphics;
  if (!graphics || graphics.__mvmzGraphicsCompat) return;
  graphics.__mvmzGraphicsCompat = true;
  const critical = (message: string) => {
    ctx.log(message);
    try { ctx.flushLog?.(); } catch {}
  };

  if (typeof graphics._createEffekseerContext === 'function') {
    graphics._createEffekseerContext = function() {
      if (!this._app || !g.effekseer) return;
      try {
        this._effekseer = g.effekseer.createContext();
        if (this._effekseer) {
          this._effekseer.init(this._app.renderer.gl);
          this._effekseer.setRestorationOfStatesFlag(false);
          ctx.log('[mz-gfx] Effekseer context initialized');
        }
      } catch (error) {
        this._effekseer = null;
        ctx.log(`[mz-gfx] Effekseer disabled; PIXI app preserved | ${String((error as any)?.message ?? error)}`);
      }
    };
  }

  if (typeof graphics._createPixiApp === 'function') {
    const originalCreatePixiApp = graphics._createPixiApp;
    graphics._createPixiApp = function() {
      originalCreatePixiApp.call(this);
      if (ctx.standaloneEngine) installMZOffscreenPresenter(ctx, this);
      ctx.log(`[mz-gfx] PIXI app=${!!this._app} renderer=${this._app?.renderer?.type ?? 'none'} webGLVersion=${this._app?.renderer?.context?.webGLVersion ?? 'unknown'} tickerStarted=${!!this._app?.ticker?.started} tickerCount=${Number(this._app?.ticker?.count ?? 0)}`);
    };
  }

  if (!ctx.standaloneEngine && typeof graphics.startGameLoop === 'function') {
    graphics.startGameLoop = function() {
      g.__mvmzMzHostLoopEnabled = true;
      try { this._app?.stop?.(); } catch {}
      ctx.log(`[mz-gfx] host game loop armed | tickerCount=${Number(this._app?.ticker?.count ?? 0)} frame=${Number(this.frameCount || 0)}`);
      try {
        this._onTick?.(1);
        ctx.log(`[mz-gfx] synchronous first tick complete | frame=${Number(this.frameCount || 0)}`);
      } catch (error) {
        g.__mvmzMzHostLoopEnabled = false;
        ctx.log(`[mz-gfx] synchronous first tick FAILED | ${String((error as any)?.stack ?? error)}`);
      }
    };
  }
  if (!ctx.standaloneEngine && typeof graphics.stopGameLoop === 'function') {
    graphics.stopGameLoop = function() {
      g.__mvmzMzHostLoopEnabled = false;
      try { this._app?.stop?.(); } catch {}
      ctx.log('[mz-gfx] host game loop stopped');
    };
  }
  if (ctx.standaloneEngine && typeof graphics.startGameLoop === 'function') {
    graphics.startGameLoop = function() {
      g.__mvmzMzStandaloneLoopEnabled = true;
      try { this._app?.ticker?.stop?.(); } catch {}
      critical(`[mz-gfx] standalone host loop armed | app=${!!this._app} tickerCount=${Number(this._app?.ticker?.count ?? 0)} frame=${Number(this.frameCount || 0)}`);
    };
  }
  if (ctx.standaloneEngine && typeof graphics.stopGameLoop === 'function') {
    graphics.stopGameLoop = function() {
      g.__mvmzMzStandaloneLoopEnabled = false;
      try { this._app?.ticker?.stop?.(); } catch {}
      critical('[mz-gfx] standalone host loop stopped');
    };
  }
  ctx.log('[mz-gfx] graphics compatibility installed');
}

function installMZHostPump(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  if (g.__mvmzMzHostPumpHandle) return;
  const raf = g.__mvmzHostRequestAnimationFrame || g.requestAnimationFrame?.bind(g);
  if (typeof raf !== 'function') {
    ctx.log('[mz-gfx] host RAF pump unavailable');
    return;
  }
  let callbacks = 0;
  let activeTicks = 0;
  const frame = () => {
    callbacks++;
    if (callbacks === 1) ctx.log('[mz-gfx] pre-armed host RAF callback');
    if (g.__mvmzMzHostLoopEnabled) {
      const graphics = g.Graphics;
      if (graphics?._app && typeof graphics._onTick === 'function') {
        try {
          graphics._onTick(1);
          activeTicks++;
          if (activeTicks === 1) {
            ctx.log(`[mz-gfx] pre-armed host RAF first active tick | frame=${Number(graphics.frameCount || 0)}`);
          }
        } catch (error) {
          g.__mvmzMzHostLoopEnabled = false;
          ctx.log(`[mz-gfx] pre-armed host RAF FAILED | ${String((error as any)?.stack ?? error)}`);
        }
      }
    }
    g.__mvmzMzHostPumpHandle = raf(frame);
  };
  g.__mvmzMzHostPumpHandle = raf(frame);
  ctx.log('[mz-gfx] pre-armed host RAF pump installed');
}

function installMZBootCompat(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  if (g.__mvmzMzBootCompat) return;
  g.__mvmzMzBootCompat = true;
  if (!g.__mvmzNativeMediaVideo && typeof g.Video === 'function') {
    g.__mvmzNativeMediaVideo = g.Video;
    ctx.log('[mz-host] captured native nx.js Video media class');
  }
  if (!g.__mvmzHostRequestAnimationFrame && typeof g.requestAnimationFrame === 'function') {
    g.__mvmzHostRequestAnimationFrame = g.requestAnimationFrame.bind(g);
    g.__mvmzHostCancelAnimationFrame = typeof g.cancelAnimationFrame === 'function'
      ? g.cancelAnimationFrame.bind(g)
      : null;
    ctx.log('[mz-host] captured host requestAnimationFrame');
  }
  ctx.log(`[mz-host] Worker=${typeof g.Worker} HTMLVideoElement=${typeof g.HTMLVideoElement}`);
}

function dispatchWindowLoad(log: RuntimeContext['log']) {
  const g: any = globalThis as any;
  try {
    if (g.PIXI?.settings && g.PIXI?.ENV?.WEBGL !== undefined) {
      const before = g.PIXI.settings.PREFER_ENV;
      g.PIXI.settings.PREFER_ENV = g.PIXI.ENV.WEBGL;
      log('[mz-gfx] pre-window-load PIXI env reassert | before=' + String(before) + ' after=' + String(g.PIXI.settings.PREFER_ENV));
    }
  } catch (error) {
    log('[mz-gfx] pre-window-load PIXI env reassert FAILED | ' + String(error));
  }
  log('[mz] dispatching synthetic window load');
  const event = new Event('load');
  if (typeof g.onload === 'function') {
    g.onload(event);
  }
  g.dispatchEvent?.(event);
}

function installMZPixiCreateDiagnostics(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const Graphics = g.Graphics;
  if (!Graphics || Graphics.__mvmzPixiCreateDiagnostics) return;
  Graphics.__mvmzPixiCreateDiagnostics = true;
  const originalCreatePixiApp = Graphics._createPixiApp;
  if (typeof originalCreatePixiApp !== 'function') return;
  Graphics._createPixiApp = function() {
    const env = g.PIXI?.settings?.PREFER_ENV;
    const canvas = this._canvas;
    ctx.log('[mz-gfx] _createPixiApp ENTER | preferEnv=' + String(env) + ' canvas=' + String(canvas?.width) + 'x' + String(canvas?.height));
    const originalGetContext = canvas?.getContext?.bind(canvas);
    if (canvas && originalGetContext && !canvas.__mvmzContextRequestTrace) {
      canvas.__mvmzContextRequestTrace = true;
      canvas.getContext = function(kind: string, options?: any) {
        ctx.log('[mz-gfx] canvas.getContext request | kind=' + String(kind) + ' preferEnv=' + String(g.PIXI?.settings?.PREFER_ENV));
        if (String(kind).toLowerCase() === 'webgl2') {
          ctx.log('[mz-gfx] canvas.getContext webgl2 blocked -> force Pixi WebGL1 systems');
          return null;
        }
        return originalGetContext(kind, options);
      };
    }
    const originalWebGL2Ctor = g.WebGL2RenderingContext;
    let maskedWebGL2Ctor = false;
    try {
      g.WebGL2RenderingContext = function MVMZWebGL1Sentinel() {};
      maskedWebGL2Ctor = g.WebGL2RenderingContext !== originalWebGL2Ctor;
      if (maskedWebGL2Ctor) ctx.log('[mz-gfx] WebGL2 instanceof detection masked during Pixi app create');
    } catch {}
    let result;
    try {
      result = originalCreatePixiApp.apply(this, arguments as any);
    } finally {
      if (maskedWebGL2Ctor) {
        try { g.WebGL2RenderingContext = originalWebGL2Ctor; } catch {}
      }
    }
    ctx.log('[mz-gfx] _createPixiApp EXIT | app=' + String(!!this._app) + ' webGLVersion=' + String(this._app?.renderer?.context?.webGLVersion) + ' preferEnv=' + String(g.PIXI?.settings?.PREFER_ENV));
    return result;
  };
  ctx.log('[mz-gfx] Pixi create diagnostics installed');
}

function installMZStorageHook(ctx: RuntimeContext, scripts: ScriptLoader) {
  scripts.onAfterScript(relative => {
    const lower = relative.toLowerCase();
    if (!(lower.endsWith('/rmmz_managers.js') || lower === 'js/rmmz_managers.js')) return;
    const g: any = globalThis as any;
    if (!g.StorageManager) return;
    const saveRoot = `sdmc:/mvmz/_saves/${ctx.game.id}/mz`;
    Switch.mkdirSync(saveRoot);

    const keyPath = (saveName: string) =>
      `${saveRoot}/${String(saveName).replace(/[^A-Za-z0-9._-]/g, '_')}.rmmzsave`;
    const exists = (path: string) => {
      try { return Switch.statSync(path) !== null; } catch { return false; }
    };
    const binaryStringToBytes = (value: string) => {
      const out = new Uint8Array(value.length);
      for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
      return out;
    };
    const bytesToBinaryString = (input: ArrayBuffer | ArrayBufferView) => {
      const bytes = input instanceof Uint8Array
        ? input
        : ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : new Uint8Array(input);
      const parts: string[] = [];
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + step))));
      }
      return parts.join('');
    };
    const zipLooksValid = (zip: string) => {
      try {
        if (!g.pako?.inflate) return true;
        g.pako.inflate(zip, { to: 'string' });
        return true;
      } catch {
        return false;
      }
    };

    if (typeof g.StorageManager.saveZip === 'function' && typeof g.StorageManager.loadZip === 'function') {
      const removeIfExists = (path: string) => {
        try { if (exists(path)) Switch.removeSync(path); } catch {}
      };
      const writeZipSync = (saveName: string, zip: string) => {
        const path = keyPath(saveName);
        const tmpPath = path + '.tmp';
        const backupPath = path + '.bak';
        const payload = binaryStringToBytes(zip);
        removeIfExists(tmpPath);
        Switch.writeFileSync(tmpPath, payload);
        let movedOld = false;
        try {
          removeIfExists(backupPath);
          if (exists(path)) {
            Switch.renameSync(path, backupPath);
            movedOld = true;
          }
          Switch.renameSync(tmpPath, path);
          removeIfExists(backupPath);
        } catch (error) {
          removeIfExists(tmpPath);
          try {
            if (!exists(path) && movedOld && exists(backupPath)) Switch.renameSync(backupPath, path);
          } catch {}
          throw error;
        }
        ctx.log(`[mz-save] write ${saveName} chars=${zip.length} rawBytes=${payload.byteLength} mode=binary8 atomic=true`);
      };
      const saveObjectSync = (saveName: string, object: any) => {
        const json = g.JsonEx.stringify(object);
        const zip = g.pako.deflate(json, { to: 'string', level: 1 });
        if (zip.length >= 50000) ctx.log(`[mz-save] large save | ${saveName} zipChars=${zip.length}`);
        writeZipSync(saveName, zip);
        return 0;
      };
      g.StorageManager.saveToLocalFile = function(saveName: string, zip: string) {
        try {
          writeZipSync(saveName, zip);
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      };
      g.StorageManager.saveObject = function(saveName: string, object: any) {
        try {
          saveObjectSync(saveName, object);
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      };
      g.StorageManager.loadFromLocalFile = async function(saveName: string) {
        const path = keyPath(saveName);
        const data = Switch.readFileSync(path);
        if (!data) throw new Error(`Savefile not found: ${saveName}`);
        const direct = bytesToBinaryString(data);
        if (zipLooksValid(direct)) {
          ctx.log(`[mz-save] read ${saveName} rawBytes=${Number((data as any).byteLength || 0)} mode=binary8`);
          return direct;
        }
        const legacy = new TextDecoder('utf-8').decode(data);
        if (zipLooksValid(legacy)) {
          ctx.log(`[mz-save] read ${saveName} rawBytes=${Number((data as any).byteLength || 0)} mode=legacy-utf8 -> migrating`);
          try { Switch.writeFileSync(path, binaryStringToBytes(legacy)); } catch {}
          return legacy;
        }
        ctx.log(`[mz-save] read ${saveName} FAILED validation | rawBytes=${Number((data as any).byteLength || 0)}`);
        return direct;
      };
      g.StorageManager.localFileExists = function(saveName: string) {
        return exists(keyPath(saveName));
      };
      g.StorageManager.removeLocalFile = function(saveName: string) {
        const path = keyPath(saveName);
        if (exists(path)) Switch.removeSync(path);
      };
      g.StorageManager.fileDirectoryPath = () => saveRoot + '/';
      g.StorageManager.filePath = (saveName: string) => keyPath(saveName);
      g.StorageManager.isLocalMode = () => true;
      g.StorageManager._forageKeys = [];
      g.StorageManager._forageKeysUpdated = true;
      g.StorageManager.updateForageKeys = function() {
        this._forageKeys = [];
        this._forageKeysUpdated = true;
        ctx.log('[mz-save] forage key scan bypassed | SD local backend active');
        return Promise.resolve(0);
      };
      g.StorageManager.forageKeysUpdated = function() {
        return true;
      };
      if (g.DataManager?.saveGame) {
        g.DataManager.saveGame = function(savefileId: number) {
          try {
            const contents = this.makeSaveContents();
            const saveName = this.makeSavename(savefileId);
            saveObjectSync(saveName, contents);
            this._globalInfo[savefileId] = this.makeSavefileInfo();
            saveObjectSync('global', this._globalInfo);
            ctx.log(`[mz-save] sync save complete | id=${String(savefileId)} name=${saveName}`);
            return Promise.resolve(0);
          } catch (error) {
            ctx.log(`[mz-save] sync save FAILED | id=${String(savefileId)} | ${String((error as any)?.stack ?? error)}`);
            return Promise.reject(error);
          }
        };
        g.DataManager.saveGlobalInfo = function() {
          try {
            saveObjectSync('global', this._globalInfo);
            return Promise.resolve(0);
          } catch (error) {
            ctx.log(`[mz-save] sync global save FAILED | ${String((error as any)?.stack ?? error)}`);
            return Promise.reject(error);
          }
        };
        ctx.log('[mz-save] synchronous atomic DataManager save bridge installed');
      }
      ctx.log(`[mz-save] SD backend installed | ${saveRoot}`);
    } else {
      ctx.log('[mz-save] StorageManager API variant not recognized yet; keeping engine backend');
    }
  });
}

function installMZDamageBitmapCache(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const proto = g.Sprite_Damage?.prototype;
  if (!proto || proto.__mvmzDamageBitmapCache) return;
  proto.__mvmzDamageBitmapCache = true;
  const cache = new Map<string, any>();
  const MAX_ENTRIES = 96;
  let cacheLogs = 0;

  const makeKey = (owner: any, text: string, width: number, height: number) => {
    let face = '';
    let size = 0;
    let color = '';
    let outline = '';
    let outlineWidth = 0;
    try { face = String(owner.fontFace?.() || ''); } catch {}
    try { size = Number(owner.fontSize?.() || 0); } catch {}
    try { color = String(owner.damageColor?.() || ''); } catch {}
    try { outline = String(owner.outlineColor?.() || ''); } catch {}
    try { outlineWidth = Number(owner.outlineWidth?.() || 0); } catch {}
    return `${face}|${size}|${color}|${outline}|${outlineWidth}|${width}x${height}|${text}`;
  };

  const prepareBitmap = (bitmap: any) => {
    try {
      if (!bitmap || bitmap.__mvmzDamageGpuPrepared || bitmap.__mvmzDamageGpuPreparing) return;
      const baseTexture = bitmap.baseTexture || bitmap._baseTexture;
      const prepare = g.Graphics?._app?.renderer?.plugins?.prepare;
      if (!baseTexture || !prepare?.upload) return;
      bitmap.__mvmzDamageGpuPreparing = true;
      prepare.upload(baseTexture, () => {
        bitmap.__mvmzDamageGpuPreparing = false;
        bitmap.__mvmzDamageGpuPrepared = true;
      });
    } catch {
      bitmap.__mvmzDamageGpuPreparing = false;
    }
  };

  const trimCache = () => {
    while (cache.size > MAX_ENTRIES) {
      const first = cache.keys().next();
      if (first.done) break;
      const key = first.value;
      const bitmap = cache.get(key);
      cache.delete(key);
      try { bitmap?.destroy?.(); } catch {}
    }
  };

  const getSharedBitmap = (owner: any, text: string, width: number, height: number) => {
    const key = makeKey(owner, text, width, height);
    const existing = cache.get(key);
    if (existing && !existing._destroyed) {
      cache.delete(key);
      cache.set(key, existing);
      return existing;
    }
    const bitmap = proto.createBitmap.call(owner, width, height);
    bitmap.drawText(text, 0, 0, width, height, 'center');
    bitmap.__mvmzSharedDamageBitmap = true;
    cache.set(key, bitmap);
    trimCache();
    prepareBitmap(bitmap);
    if (cacheLogs < 12) {
      cacheLogs++;
      ctx.log(`[mz-damage-cache] STORE | text=${text} entries=${cache.size}`);
      if (cacheLogs === 12) ctx.log('[mz-damage-cache] further STORE logs suppressed');
    }
    return bitmap;
  };

  const addSharedChild = (owner: any, bitmap: any, width: number, height: number) => {
    const sprite = new g.Sprite();
    sprite.bitmap = bitmap;
    sprite.anchor.x = 0.5;
    sprite.anchor.y = 1;
    sprite.y = -40;
    sprite.ry = sprite.y;
    owner.addChild(sprite);
    return sprite;
  };

  proto.createDigits = function(value: number) {
    const string = Math.abs(value).toString();
    const h = this.fontSize();
    const w = Math.floor(h * 0.75);
    for (let i = 0; i < string.length; i++) {
      const bitmap = getSharedBitmap(this, string[i], w, h);
      const sprite = addSharedChild(this, bitmap, w, h);
      sprite.x = (i - (string.length - 1) / 2) * w;
      sprite.dy = -i;
    }
  };

  proto.createMiss = function() {
    const h = this.fontSize();
    const w = Math.floor(h * 3.0);
    const bitmap = getSharedBitmap(this, 'Miss', w, h);
    const sprite = addSharedChild(this, bitmap, w, h);
    sprite.dy = 0;
  };

  const originalDestroy = proto.destroy;
  if (typeof originalDestroy === 'function') {
    proto.destroy = function(this: any, options: any) {
      for (const child of this.children || []) {
        if (child?._bitmap?.__mvmzSharedDamageBitmap) child._bitmap = null;
      }
      return originalDestroy.call(this, options);
    };
  }

  g.__mvmzMZPrewarmDamageDigits = () => {
    if (g.__mvmzMZDamageDigitsPrewarmed) return;
    g.__mvmzMZDamageDigitsPrewarmed = true;
    try {
      const dummy = new g.Sprite_Damage();
      for (let colorType = 0; colorType < 4; colorType++) {
        dummy._colorType = colorType;
        const h = dummy.fontSize();
        const w = Math.floor(h * 0.75);
        for (let digit = 0; digit <= 9; digit++) getSharedBitmap(dummy, String(digit), w, h);
      }
      dummy._colorType = 0;
      const h = dummy.fontSize();
      getSharedBitmap(dummy, 'Miss', Math.floor(h * 3.0), h);
      try { g.PIXI?.Sprite?.prototype?.destroy?.call(dummy, { children: true, texture: true }); } catch {}
      ctx.log(`[mz-damage-cache] prewarm complete | entries=${cache.size}`);
    } catch (error) {
      ctx.log(`[mz-damage-cache] prewarm FAILED | ${String((error as any)?.stack ?? error)}`);
    }
  };

  ctx.log(`[mz-damage-cache] shared damage bitmap cache installed | maxEntries=${MAX_ENTRIES}`);
}

function installMZEventAssetPrewarm(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const interpreterProto = g.Game_Interpreter?.prototype;
  const sceneMapProto = g.Scene_Map?.prototype;
  const imageManager = g.ImageManager;
  if (!interpreterProto || !sceneMapProto || !imageManager || interpreterProto.__mvmzEventAssetWarm) return;
  interpreterProto.__mvmzEventAssetWarm = true;

  type WarmItem =
    | { type: 'image'; kind: string; name: string; key: string; source: string }
    | { type: 'animation'; id: number; key: string; source: string }
    | { type: 'se'; name: string; key: string; source: string };

  const queue: WarmItem[] = [];
  const queued = new Set<string>();
  const completed = new Set<string>();
  let pumpArmed = false;
  let planLogs = 0;
  let assetLogs = 0;
  let mapScanSerial = 0;
  let mapUpdateCounter = 0;
  let lastMapScanX = Number.NaN;
  let lastMapScanY = Number.NaN;

  const hostRaf = (callback: () => void) => {
    const raf = g.__mvmzHostRequestAnimationFrame || g.requestAnimationFrame;
    if (typeof raf === 'function') raf(callback);
    else setTimeout(callback, 16);
  };

  const loadImage = (kind: string, name: string) => {
    switch (kind) {
      case 'face': return imageManager.loadFace?.(name);
      case 'picture': return imageManager.loadPicture?.(name);
      case 'character': return imageManager.loadCharacter?.(name);
      case 'svactor': return imageManager.loadSvActor?.(name);
      case 'battleback1': return imageManager.loadBattleback1?.(name);
      case 'battleback2': return imageManager.loadBattleback2?.(name);
      case 'parallax': return imageManager.loadParallax?.(name);
      default: return null;
    }
  };

  const gpuPrepare = (bitmap: any, key: string, source: string) => {
    try {
      if (!bitmap || bitmap.__mvmzMzWarmPrepared || bitmap.__mvmzMzWarmPreparing) return;
      const baseTexture = bitmap.baseTexture || bitmap._baseTexture;
      const prepare = g.Graphics?._app?.renderer?.plugins?.prepare;
      if (!baseTexture || !prepare?.upload) return;
      bitmap.__mvmzMzWarmPreparing = true;
      prepare.upload(baseTexture, () => {
        bitmap.__mvmzMzWarmPreparing = false;
        bitmap.__mvmzMzWarmPrepared = true;
        completed.add(key);
        if (assetLogs < 24) {
          assetLogs++;
          ctx.log(`[mz-asset-warm] GPU ready | ${key} source=${source}`);
          if (assetLogs === 24) ctx.log('[mz-asset-warm] further asset-ready logs suppressed');
        }
      });
    } catch (error) {
      bitmap.__mvmzMzWarmPreparing = false;
      if (assetLogs < 24) {
        assetLogs++;
        ctx.log(`[mz-asset-warm] GPU prepare FAILED | ${key} | ${String((error as any)?.message ?? error)}`);
      }
    }
  };

  const startImage = (item: Extract<WarmItem, { type: 'image' }>) => {
    try {
      const bitmap = loadImage(item.kind, item.name);
      if (!bitmap) { completed.add(item.key); return; }
      const ready = () => {
        try { gpuPrepare(bitmap, item.key, item.source); } catch {}
        if (!bitmap.baseTexture && !bitmap._baseTexture) completed.add(item.key);
      };
      if (bitmap.isReady?.()) ready();
      else bitmap.addLoadListener?.(ready);
    } catch (error) {
      completed.add(item.key);
      ctx.log(`[mz-asset-warm] image preload FAILED | ${item.key} | ${String((error as any)?.message ?? error)}`);
    }
  };

  const startAnimation = (item: Extract<WarmItem, { type: 'animation' }>) => {
    try {
      const animation = g.$dataAnimations?.[item.id];
      if (animation) {
        const effectName = String(animation.effectName || '');
        if (effectName) g.EffectManager?.load?.(effectName);
        for (const timing of animation.soundTimings || []) {
          const name = String(timing?.se?.name || '');
          if (name) enqueueSe(name, `${item.source}:anim${item.id}`);
        }
      }
    } catch (error) {
      ctx.log(`[mz-asset-warm] animation preload FAILED | id=${item.id} | ${String((error as any)?.message ?? error)}`);
    }
    completed.add(item.key);
  };

  const startSe = (item: Extract<WarmItem, { type: 'se' }>) => {
    try { g.__mvmzMZPrewarmSe?.(item.name); } catch {}
    completed.add(item.key);
  };

  const pump = () => {
    pumpArmed = false;
    let imageStarted = 0;
    let lightweightStarted = 0;
    while (queue.length && (imageStarted < 1 || lightweightStarted < 2)) {
      const item = queue.shift()!;
      if (completed.has(item.key)) continue;
      if (item.type === 'image') {
        if (imageStarted >= 1) { queue.unshift(item); break; }
        imageStarted++;
        startImage(item);
      } else if (item.type === 'animation') {
        if (lightweightStarted >= 2) { queue.unshift(item); break; }
        lightweightStarted++;
        startAnimation(item);
      } else {
        if (lightweightStarted >= 2) { queue.unshift(item); break; }
        lightweightStarted++;
        startSe(item);
      }
    }
    if (queue.length) schedulePump();
  };

  const schedulePump = () => {
    if (pumpArmed) return;
    pumpArmed = true;
    hostRaf(pump);
  };

  const enqueueImage = (kind: string, name: any, source: string) => {
    const clean = String(name || '').trim();
    if (!clean) return false;
    const key = `img:${kind}:${clean}`;
    if (queued.has(key) || completed.has(key)) return false;
    queued.add(key);
    queue.push({ type: 'image', kind, name: clean, key, source });
    schedulePump();
    return true;
  };

  const enqueueAnimation = (value: any, source: string) => {
    const id = Number(value || 0);
    if (!Number.isFinite(id) || id <= 0 || !g.$dataAnimations?.[id]) return false;
    const key = `anim:${id}`;
    if (queued.has(key) || completed.has(key)) return false;
    queued.add(key);
    queue.push({ type: 'animation', id, key, source });
    schedulePump();
    return true;
  };

  const enqueueSe = (name: any, source: string) => {
    const clean = String(name || '').trim();
    if (!clean) return false;
    const key = `se:${clean}`;
    if (queued.has(key) || completed.has(key)) return false;
    queued.add(key);
    queue.push({ type: 'se', name: clean, key, source });
    schedulePump();
    return true;
  };

  const scanList = (list: any[], start: number, maxCommands: number, source: string, imageLimit = 10, animationLimit = 8, seLimit = 12) => {
    if (!Array.isArray(list) || !list.length) return { images: 0, animations: 0, se: 0 };
    let images = 0;
    let animations = 0;
    let se = 0;
    const from = Math.max(0, Math.floor(Number(start) || 0));
    const end = Math.min(list.length, from + Math.max(1, maxCommands));
    for (let i = from; i < end; i++) {
      const command = list[i];
      const p = command?.parameters || [];
      switch (Number(command?.code || 0)) {
        case 101:
          if (images < imageLimit && enqueueImage('face', p[0], source)) images++;
          break;
        case 231:
          if (images < imageLimit && enqueueImage('picture', p[1], source)) images++;
          break;
        case 322:
          if (images < imageLimit && enqueueImage('character', p[1], source)) images++;
          if (images < imageLimit && enqueueImage('face', p[3], source)) images++;
          if (images < imageLimit && enqueueImage('svactor', p[5], source)) images++;
          break;
        case 323:
          if (images < imageLimit && enqueueImage('character', p[1], source)) images++;
          break;
        case 283:
          if (images < imageLimit && enqueueImage('battleback1', p[0], source)) images++;
          if (images < imageLimit && enqueueImage('battleback2', p[1], source)) images++;
          break;
        case 284:
          if (images < imageLimit && enqueueImage('parallax', p[0], source)) images++;
          break;
        case 212:
        case 337:
          if (animations < animationLimit && enqueueAnimation(p[1], source)) animations++;
          break;
        case 250:
          if (se < seLimit && enqueueSe(p[0]?.name, source)) se++;
          break;
      }
      if (images >= imageLimit && animations >= animationLimit && se >= seLimit) break;
    }
    if ((images || animations || se) && planLogs < 20) {
      planLogs++;
      ctx.log(`[mz-asset-warm] plan | source=${source} commands=${end - from} images=${images} animations=${animations} se=${se} queue=${queue.length}`);
      if (planLogs === 20) ctx.log('[mz-asset-warm] further plan logs suppressed');
    }
    return { images, animations, se };
  };

  const warmPartyCombat = (source: string) => {
    try { g.__mvmzMZPrewarmDamageDigits?.(); } catch {}
    const ids = new Set<number>();
    try {
      for (const actor of g.$gameParty?.battleMembers?.() || []) {
        try {
          const a1 = Number(actor.attackAnimationId1?.() || 0);
          const a2 = Number(actor.attackAnimationId2?.() || 0);
          if (a1 > 0) ids.add(a1);
          if (a2 > 0) ids.add(a2);
        } catch {}
        try {
          for (const skill of actor.skills?.() || []) {
            const id = Number(skill?.animationId || 0);
            if (id > 0) ids.add(id);
            else if (id < 0) {
              const a1 = Number(actor.attackAnimationId1?.() || 0);
              const a2 = Number(actor.attackAnimationId2?.() || 0);
              if (a1 > 0) ids.add(a1);
              if (a2 > 0) ids.add(a2);
            }
          }
        } catch {}
      }
    } catch {}
    let added = 0;
    for (const id of Array.from(ids).slice(0, 20)) if (enqueueAnimation(id, source)) added++;
    if (added && planLogs < 20) {
      planLogs++;
      ctx.log(`[mz-map-warm] party battle animations queued | source=${source} count=${added}`);
    }
  };

  const warmNearbyEvents = (scene: any, source: string) => {
    const serial = ++mapScanSerial;
    hostRaf(() => {
      if (serial !== mapScanSerial || g.SceneManager?._scene !== scene) return;
      try {
        const px = Number(g.$gamePlayer?.x || 0);
        const py = Number(g.$gamePlayer?.y || 0);
        const events = (g.$gameMap?.events?.() || [])
          .filter((event: any) => event && Number(event._pageIndex) >= 0)
          .map((event: any) => ({ event, distance: Math.abs(Number(event.x || 0) - px) + Math.abs(Number(event.y || 0) - py) }))
          .filter((entry: any) => entry.distance <= 8)
          .sort((a: any, b: any) => a.distance - b.distance)
          .slice(0, 4);
        let imageBudget = 8;
        let animationBudget = 10;
        let seBudget = 12;
        for (const entry of events) {
          if (imageBudget <= 0 && animationBudget <= 0 && seBudget <= 0) break;
          const event = entry.event;
          let list: any[] = [];
          try { list = event.list?.() || []; } catch {}
          const result = scanList(list, 0, 48, `${source}:event${Number(event.eventId?.() || event._eventId || 0)}`, imageBudget, animationBudget, seBudget);
          imageBudget -= result.images;
          animationBudget -= result.animations;
          seBudget -= result.se;
        }
        warmPartyCombat(`${source}:party`);
      } catch (error) {
        ctx.log(`[mz-map-warm] nearby scan FAILED | ${String((error as any)?.message ?? error)}`);
      }
    });
  };

  const originalSetup = interpreterProto.setup;
  if (typeof originalSetup === 'function') {
    interpreterProto.setup = function(this: any, list: any[], eventId: number) {
      const result = originalSetup.apply(this, arguments as any);
      this.__mvmzWarmLastScanIndex = -999;
      try { scanList(list, 0, 56, `interpreter:${Number(eventId || 0)}`, 10, 8, 12); } catch {}
      return result;
    };
  }

  const originalExecute = interpreterProto.executeCommand;
  if (typeof originalExecute === 'function') {
    interpreterProto.executeCommand = function(this: any) {
      try {
        const index = Number(this._index || 0);
        const last = Number(this.__mvmzWarmLastScanIndex ?? -999);
        if (Array.isArray(this._list) && index - last >= 8) {
          this.__mvmzWarmLastScanIndex = index;
          scanList(this._list, index, 48, `interpreter:${Number(this._eventId || 0)}@${index}`, 8, 6, 10);
        }
      } catch {}
      return originalExecute.apply(this, arguments as any);
    };
  }

  const originalMapTransfer = sceneMapProto.onTransfer;
  if (typeof originalMapTransfer === 'function') {
    sceneMapProto.onTransfer = function(this: any) {
      const result = originalMapTransfer.apply(this, arguments as any);
      queue.length = 0;
      queued.clear();
      completed.clear();
      mapScanSerial++;
      ctx.log('[mz-asset-warm] cache tracking reset after map transfer');
      return result;
    };
  }

  const originalMapStart = sceneMapProto.start;
  if (typeof originalMapStart === 'function') {
    sceneMapProto.start = function(this: any) {
      const result = originalMapStart.apply(this, arguments as any);
      try {
        lastMapScanX = Number(g.$gamePlayer?.x || 0);
        lastMapScanY = Number(g.$gamePlayer?.y || 0);
        warmNearbyEvents(this, 'map-start');
      } catch {}
      return result;
    };
  }

  const originalMapUpdate = sceneMapProto.update;
  if (typeof originalMapUpdate === 'function') {
    sceneMapProto.update = function(this: any) {
      const result = originalMapUpdate.apply(this, arguments as any);
      try {
        mapUpdateCounter++;
        if (mapUpdateCounter % 120 === 0 && !g.$gameMessage?.isBusy?.() && !g.SceneManager?.isSceneChanging?.()) {
          const px = Number(g.$gamePlayer?.x || 0);
          const py = Number(g.$gamePlayer?.y || 0);
          const moved = !Number.isFinite(lastMapScanX) || Math.abs(px - lastMapScanX) + Math.abs(py - lastMapScanY) >= 4;
          if (moved) {
            lastMapScanX = px;
            lastMapScanY = py;
            warmNearbyEvents(this, 'map-idle');
          }
        }
      } catch {}
      return result;
    };
  }

  g.__mvmzMZWarmAnimation = enqueueAnimation;
  g.__mvmzMZWarmImage = enqueueImage;
  ctx.log('[mz-asset-warm] generic event image / map animation lookahead installed | imagePerFrame=1 nearbyRadius=8');
}

function installMZBattlePrewarm(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const proto = g.Scene_Battle?.prototype;
  if (!proto || typeof proto.create !== 'function' || proto.create.__mvmzBattleWarm) return;
  const originalCreate = proto.create;
  let planSerial = 0;

  const addAnimation = (set: Set<number>, value: any) => {
    const id = Number(value || 0);
    if (Number.isFinite(id) && id > 0 && g.$dataAnimations?.[id]) set.add(id);
  };
  const addSkillAnimation = (set: Set<number>, skill: any, actor?: any) => {
    if (!skill) return;
    const id = Number(skill.animationId || 0);
    if (id > 0) addAnimation(set, id);
    else if (id < 0 && actor) {
      try { addAnimation(set, actor.attackAnimationId1?.()); } catch {}
      try { addAnimation(set, actor.attackAnimationId2?.()); } catch {}
    } else if (id < 0) {
      addAnimation(set, 1);
    }
  };
  const collectPlan = () => {
    const animationIds = new Set<number>();
    try {
      for (const actor of g.$gameParty?.battleMembers?.() || []) {
        try { addAnimation(animationIds, actor.attackAnimationId1?.()); } catch {}
        try { addAnimation(animationIds, actor.attackAnimationId2?.()); } catch {}
        try {
          for (const skill of actor.skills?.() || []) addSkillAnimation(animationIds, skill, actor);
        } catch {}
      }
    } catch {}
    try {
      for (const enemy of g.$gameTroop?.members?.() || []) {
        const data = enemy?.enemy?.();
        for (const action of data?.actions || []) addSkillAnimation(animationIds, g.$dataSkills?.[Number(action?.skillId || 0)]);
      }
    } catch {}
    const selectedIds = Array.from(animationIds).slice(0, 32);
    const effects = new Set<string>();
    const sounds = new Set<string>();
    for (const id of selectedIds) {
      const animation = g.$dataAnimations?.[id];
      const effectName = String(animation?.effectName || '');
      if (effectName) effects.add(effectName);
      for (const timing of animation?.soundTimings || []) {
        const name = String(timing?.se?.name || '');
        if (name) sounds.add(name);
      }
    }
    return {
      animationIds: selectedIds,
      effects: Array.from(effects).slice(0, 12),
      sounds: Array.from(sounds).slice(0, 24)
    };
  };
  const prewarm = () => {
    const serial = ++planSerial;
    const plan = collectPlan();
    ctx.log(`[mz-battle-warm] plan | animations=${plan.animationIds.length} effects=${plan.effects.length} se=${plan.sounds.length}`);
    for (const name of plan.effects) {
      try { g.EffectManager?.load?.(name); } catch (error) {
        ctx.log(`[mz-battle-warm] effect preload FAILED | ${name} | ${String((error as any)?.message ?? error)}`);
      }
    }
    const queue = plan.sounds.slice();
    const pump = () => {
      if (serial !== planSerial || !queue.length) return;
      for (let i = 0; i < 2 && queue.length; i++) {
        const name = queue.shift()!;
        try { g.__mvmzMZPrewarmSe?.(name); } catch {}
      }
      if (queue.length) {
        const raf = g.__mvmzHostRequestAnimationFrame || g.requestAnimationFrame;
        if (typeof raf === 'function') raf(pump);
        else setTimeout(pump, 16);
      }
    };
    pump();
  };

  const wrappedCreate = function(this: any, ...args: any[]) {
    const result = originalCreate.apply(this, args);
    try { prewarm(); } catch (error) {
      ctx.log(`[mz-battle-warm] plan FAILED | ${String((error as any)?.stack ?? error)}`);
    }
    return result;
  };
  wrappedCreate.__mvmzBattleWarm = true;
  proto.create = wrappedCreate;
  ctx.log('[mz-battle-warm] generic animation effect/SE prewarm installed');
}

function mzEffectMemoryBrief() {
  try {
    const mem: any = Switch.memoryUsage();
    const mib = (value: number) => (Number(value || 0) / 1048576).toFixed(1);
    return ` heapMiB=${mib(mem.usedHeapSize)} externalMiB=${mib(mem.externalMemory)} nativeMiB=${mib(mem.nativeHeapUsed)}/${mib(mem.nativeHeapTotal)}`;
  } catch {
    return '';
  }
}

function installMZEffectDiagnostics(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const manager = g.EffectManager;
  if (!manager || manager.__mvmzEffectDiagnostics) return;
  manager.__mvmzEffectDiagnostics = true;
  const starts = new Map<string, number>();
  let hitLogs = 0;
  const now = () => Number(g.performance?.now?.() ?? Date.now());

  if (typeof manager.load === 'function') {
    const originalLoad = manager.load;
    manager.load = function(filename: string) {
      const name = String(filename || '');
      if (name) {
        try {
          const url = String(this.makeUrl?.(name) || name);
          const cached = this._cache?.[url];
          if (cached?.isLoaded && hitLogs < 20) {
            hitLogs++;
            ctx.log(`[mz-effect] CACHE HIT | ${url}${mzEffectMemoryBrief()}`);
            if (hitLogs === 20) ctx.log('[mz-effect] further cache-hit logs suppressed');
          }
        } catch {}
      }
      return originalLoad.call(this, filename);
    };
  }

  if (typeof manager.startLoading === 'function') {
    const originalStartLoading = manager.startLoading;
    manager.startLoading = function(url: string) {
      const key = String(url || '');
      starts.set(key, now());
      ctx.log(`[mz-effect] START | ${key}${mzEffectMemoryBrief()}`);
      try {
        return originalStartLoading.call(this, url);
      } catch (error) {
        starts.delete(key);
        ctx.log(`[mz-effect] START FAILED | ${key} | ${String((error as any)?.stack ?? error)}${mzEffectMemoryBrief()}`);
        throw error;
      }
    };
  }

  if (typeof manager.onLoad === 'function') {
    const originalOnLoad = manager.onLoad;
    manager.onLoad = function(url: string, ...args: any[]) {
      const key = String(url || '');
      const stamp = starts.get(key);
      const elapsed = stamp == null ? -1 : Math.max(0, now() - stamp);
      starts.delete(key);
      ctx.log(`[mz-effect] READY | ${key} elapsedMs=${elapsed < 0 ? 'unknown' : elapsed.toFixed(1)}${mzEffectMemoryBrief()}`);
      return originalOnLoad.call(this, url, ...args);
    };
  }

  if (typeof manager.onError === 'function') {
    const originalOnError = manager.onError;
    manager.onError = function(url: string, ...args: any[]) {
      const key = String(url || '');
      const stamp = starts.get(key);
      const elapsed = stamp == null ? -1 : Math.max(0, now() - stamp);
      starts.delete(key);
      ctx.log(`[mz-effect] ERROR | ${key} elapsedMs=${elapsed < 0 ? 'unknown' : elapsed.toFixed(1)}${mzEffectMemoryBrief()}`);
      return originalOnError.call(this, url, ...args);
    };
  }

  if (typeof manager.clear === 'function') {
    const originalClear = manager.clear;
    manager.clear = function(...args: any[]) {
      const count = Object.keys(this._cache || {}).length;
      starts.clear();
      ctx.log(`[mz-effect] CLEAR | cached=${count}${mzEffectMemoryBrief()}`);
      return originalClear.apply(this, args);
    };
  }

  ctx.log('[mz-effect] first-use load timing diagnostics installed | preload=off');
}

function installMZHighWaterTransitionReclaim(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const manager = g.SceneManager;
  const imageManager = g.ImageManager;
  const mapProto = g.Scene_Map?.prototype;
  if (!manager || !imageManager || manager.__mvmzHighWaterTransitionReclaim) return;
  manager.__mvmzHighWaterTransitionReclaim = true;

  const MIB = 1048576;
  const compatMemory = g.__mvmzCompatApi?.config?.mzMemory || {};
  const fullWaterMiB = Math.max(512, Number(compatMemory.fullWaterMiB || 1280));
  const preemptiveWaterMiB = Number.isFinite(Number(compatMemory.preemptiveWaterMiB))
    ? Math.max(512, Number(compatMemory.preemptiveWaterMiB))
    : Number.POSITIVE_INFINITY;
  const HIGH_WATER = fullWaterMiB * MIB;
  const PREEMPTIVE_WATER = preemptiveWaterMiB * MIB;
  const STRONG_WATER = 1400 * MIB;
  const CRITICAL_WATER = 1500 * MIB;
  const preemptiveTransitions = new Set<string>(
    Array.isArray(compatMemory.preemptiveTransitions)
      ? compatMemory.preemptiveTransitions.map((value: any) => String(value))
      : []
  );
  const now = () => Number(g.performance?.now?.() ?? Date.now());
  const memory = () => {
    try {
      const mem: any = Switch.memoryUsage();
      return {
        used: Number(mem.nativeHeapUsed || 0),
        total: Number(mem.nativeHeapTotal || 0),
        arena: Number(mem.nativeHeapArena || 0),
        free: Number(mem.nativeHeapFree || 0),
        heap: Number(mem.usedHeapSize || 0),
        external: Number(mem.externalMemory || 0),
        malloced: Number(mem.mallocedMemory || 0)
      };
    } catch {
      return { used: 0, total: 0, arena: 0, free: 0, heap: 0, external: 0, malloced: 0 };
    }
  };
  const mib = (value: number) => (Number(value || 0) / MIB).toFixed(1);

  const originalLoadBitmapFromUrl = imageManager.loadBitmapFromUrl;
  if (typeof originalLoadBitmapFromUrl === 'function' && !originalLoadBitmapFromUrl.__mvmzTouchTracked) {
    const wrappedLoadBitmapFromUrl = function(this: any, url: string) {
      const bitmap = originalLoadBitmapFromUrl.call(this, url);
      if (bitmap) {
        try {
          bitmap.__mvmzLastTouch = now();
          bitmap.__mvmzCacheUrl = String(url || '');
        } catch {}
      }
      return bitmap;
    };
    wrappedLoadBitmapFromUrl.__mvmzTouchTracked = true;
    imageManager.loadBitmapFromUrl = wrappedLoadBitmapFromUrl;
  }

  const collectBitmapRefs = (ignoredScene?: any) => {
    const bitmaps = new Set<any>();
    const baseTextures = new Set<any>();
    const visited = new Set<any>();
    const rememberBitmap = (bitmap: any) => {
      if (!bitmap || typeof bitmap !== 'object') return;
      bitmaps.add(bitmap);
      try {
        const base = bitmap._baseTexture || bitmap.baseTexture;
        if (base) baseTextures.add(base);
      } catch {}
    };
    const walk = (node: any) => {
      if (!node || typeof node !== 'object' || visited.has(node)) return;
      visited.add(node);
      try { rememberBitmap(node.bitmap); } catch {}
      try { rememberBitmap(node._bitmap); } catch {}
      try { rememberBitmap(node.contents); } catch {}
      try { rememberBitmap(node.contentsBack); } catch {}
      try { rememberBitmap(node.windowskin); } catch {}
      try { rememberBitmap(node._windowskin); } catch {}
      try {
        const base = node.texture?.baseTexture;
        if (base) baseTextures.add(base);
      } catch {}
      const children = Array.isArray(node.children) ? node.children : [];
      for (const child of children) walk(child);
    };
    if (manager._scene !== ignoredScene) walk(manager._scene);
    if (manager._nextScene !== ignoredScene) walk(manager._nextScene);
    if (manager._previousScene !== ignoredScene) walk(manager._previousScene);
    return { bitmaps, baseTextures };
  };

  const trimUnusedImageCache = (usedBefore: number, ignoredScene?: any) => {
    const cache = imageManager._cache || {};
    const refs = collectBitmapRefs(ignoredScene);
    const candidates: Array<{ url: string; bitmap: any; pixels: number; touch: number }> = [];
    let totalPixels = 0;
    let protectedPixels = 0;
    for (const url of Object.keys(cache)) {
      const bitmap = cache[url];
      if (!bitmap) continue;
      const width = Math.max(0, Number(bitmap.width || bitmap._canvas?.width || 0));
      const height = Math.max(0, Number(bitmap.height || bitmap._canvas?.height || 0));
      const pixels = width * height;
      totalPixels += pixels;
      let protectedNow = false;
      try {
        const base = bitmap._baseTexture || bitmap.baseTexture;
        protectedNow = refs.bitmaps.has(bitmap) || (!!base && refs.baseTextures.has(base));
      } catch {
        protectedNow = refs.bitmaps.has(bitmap);
      }
      try {
        if (!protectedNow && typeof bitmap.isReady === 'function' && !bitmap.isReady()) protectedNow = true;
      } catch {
        protectedNow = true;
      }
      if (protectedNow) {
        protectedPixels += pixels;
        continue;
      }
      candidates.push({
        url,
        bitmap,
        pixels,
        touch: Number(bitmap.__mvmzLastTouch || 0)
      });
    }

    const targetMP = usedBefore >= CRITICAL_WATER ? 8 : usedBefore >= STRONG_WATER ? 14 : 24;
    let optionalPixels = candidates.reduce((sum, item) => sum + item.pixels, 0);
    const targetPixels = targetMP * 1e6;
    candidates.sort((a, b) => a.touch - b.touch || b.pixels - a.pixels);
    let evicted = 0;
    let evictedPixels = 0;
    for (const item of candidates) {
      if (optionalPixels <= targetPixels) break;
      if (cache[item.url] !== item.bitmap) continue;
      delete cache[item.url];
      optionalPixels -= item.pixels;
      evictedPixels += item.pixels;
      evicted++;
      try { item.bitmap.destroy?.(); } catch (error) {
        ctx.log(`[mz-mem] cache bitmap destroy FAILED | ${item.url} | ${String((error as any)?.stack ?? error)}`);
      }
    }
    return {
      beforeCount: Object.keys(cache).length + evicted,
      afterCount: Object.keys(cache).length,
      totalPixels,
      protectedPixels,
      evicted,
      evictedPixels,
      targetMP
    };
  };

  const heavyTransition = (oldName: string, nextName: string) => {
    return nextName === 'Scene_Map' || nextName === 'Scene_Battle' || oldName === 'Scene_Battle';
  };
  const transitionKey = (oldName: string, nextName: string) => `${oldName}->${nextName}`;
  const lightTransition = (oldName: string, nextName: string, used: number) => {
    return used >= PREEMPTIVE_WATER && preemptiveTransitions.has(transitionKey(oldName, nextName));
  };

  if (mapProto && typeof mapProto.terminate === 'function' && !mapProto.terminate.__mvmzHighWaterWrapped) {
    const originalMapTerminate = mapProto.terminate;
    const wrappedMapTerminate = function(this: any, ...args: any[]) {
      const mem = memory();
      const isMapTransfer = !!g.Scene_Map && manager.isNextScene?.(g.Scene_Map);
      const preemptive = isMapTransfer && lightTransition('Scene_Map', 'Scene_Map', mem.used);
      if (!isMapTransfer || (mem.used < HIGH_WATER && !preemptive) || typeof manager.snapForBackground !== 'function') {
        return originalMapTerminate.apply(this, args);
      }
      const originalSnapForBackground = manager.snapForBackground;
      let skipped = false;
      manager.snapForBackground = function() {
        skipped = true;
      };
      try {
        return originalMapTerminate.apply(this, args);
      } finally {
        manager.snapForBackground = originalSnapForBackground;
        if (skipped) {
          const mode = mem.used >= HIGH_WATER ? 'full' : 'light';
          ctx.log(`[mz-mem] ${mode} Map->Map snapshot skipped | nativeMiB=${mib(mem.used)} fullThresholdMiB=${mib(HIGH_WATER)} preemptiveThresholdMiB=${Number.isFinite(PREEMPTIVE_WATER) ? mib(PREEMPTIVE_WATER) : 'off'}`);
        }
      }
    };
    wrappedMapTerminate.__mvmzHighWaterWrapped = true;
    mapProto.terminate = wrappedMapTerminate;
  }

  if (typeof manager.onSceneTerminate === 'function' && !manager.onSceneTerminate.__mvmzHighWaterWrapped) {
    const originalOnSceneTerminate = manager.onSceneTerminate;
    const wrappedOnSceneTerminate = function(this: any, ...args: any[]) {
      const oldScene = this._scene;
      const nextScene = this._nextScene;
      const oldName = String(oldScene?.constructor?.name || 'none');
      const nextName = String(nextScene?.constructor?.name || 'none');
      const before = memory();
      const result = originalOnSceneTerminate.apply(this, args);
      const fullReclaim = before.used >= HIGH_WATER && heavyTransition(oldName, nextName);
      const lightReclaim = lightTransition(oldName, nextName, before.used);
      if (!fullReclaim && !lightReclaim) return result;

      let earlyDestroyed = false;
      const previous = this._previousScene;
      if (previous) {
        try {
          previous.destroy?.();
          this._previousScene = null;
          earlyDestroyed = true;
        } catch (error) {
          ctx.log(`[mz-mem] early previous-scene destroy FAILED | ${oldName}->${nextName} | ${String((error as any)?.stack ?? error)}`);
        }
      }

      const cache = fullReclaim
        ? trimUnusedImageCache(before.used, previous)
        : {
            beforeCount: Object.keys(imageManager._cache || {}).length,
            afterCount: Object.keys(imageManager._cache || {}).length,
            totalPixels: 0,
            protectedPixels: 0,
            evicted: 0,
            evictedPixels: 0,
            targetMP: -1
          };
      try { g.Graphics?.effekseer?.stopAll?.(); } catch {}
      try { g.Graphics?.app?.renderer?.textureGC?.run?.(); } catch {}
      try { if (typeof g.gc === 'function') g.gc(); } catch {}
      const immediate = memory();
      const mode = fullReclaim ? 'full' : 'light';
      ctx.log(`[mz-mem] transition reclaim | mode=${mode} ${oldName}->${nextName} nativeMiB=${mib(before.used)}=>${mib(immediate.used)} nativeArenaMiB=${mib(before.arena)} nativeFreeMiB=${mib(before.free)} capacityFreeMiB=${mib(Math.max(0, before.total - before.used))} externalMiB=${mib(before.external)} mallocMiB=${mib(before.malloced)} earlyDestroy=${earlyDestroyed} cache=${cache.beforeCount}->${cache.afterCount} cacheMP=${(cache.totalPixels / 1e6).toFixed(1)} protectedMP=${(cache.protectedPixels / 1e6).toFixed(1)} evicted=${cache.evicted} evictedMP=${(cache.evictedPixels / 1e6).toFixed(1)} targetOptionalMP=${cache.targetMP}`);
      try {
        setTimeout(() => {
          const after = memory();
          ctx.log(`[mz-mem] transition reclaim settled | ${oldName}->${nextName} nativeMiB=${mib(after.used)} externalMiB=${mib(after.external)} heapMiB=${mib(after.heap)}`);
        }, 0);
      } catch {}
      return result;
    };
    wrappedOnSceneTerminate.__mvmzHighWaterWrapped = true;
    manager.onSceneTerminate = wrappedOnSceneTerminate;
  }

  ctx.log(`[mz-mem] transition reclaim installed | fullThreshold=${fullWaterMiB}MiB preemptiveThreshold=${Number.isFinite(preemptiveWaterMiB) ? `${preemptiveWaterMiB}MiB` : 'off'} preemptiveTransitions=${Array.from(preemptiveTransitions).join(',') || 'none'} | light=early destroy/snapshot skip/textureGC/V8GC full=+scene-safe ImageManager LRU trim`);
}

function installMZCoreHooks(ctx: RuntimeContext, scripts: ScriptLoader) {
  scripts.onAfterScript(relative => {
    const lower = relative.toLowerCase();
    const g: any = globalThis as any;
    if (lower.endsWith('/pixi.js') || lower === 'js/libs/pixi.js') {
      const pixi = g.PIXI;
      const webgl1 = pixi?.ENV?.WEBGL;
      if (pixi?.settings && webgl1 !== undefined) {
        const before = pixi.settings.PREFER_ENV;
        // The host is still a real WebGL2 context, but MZ's Tilemap and many
        // plugins are authored for Pixi's WebGL1 systems/GLSL100 path. Earlier
        // WebGL1 attempts recursed through the OES VAO shim; that root cause
        // was fixed in V007 by freezing the native WebGL2 VAO entrypoints.
        // Running Pixi as WebGL1 over the WebGL2 compatibility proxy avoids
        // the WebGL2 renderer path that leaves MZ Tilemap scenes black on HOS.
        pixi.settings.PREFER_ENV = webgl1;
        ctx.log(`[mz-gfx] PIXI compatibility env | before=${String(before)} after=${String(pixi.settings.PREFER_ENV)} webgl1=${String(webgl1)} host=WebGL2`);
      } else {
        ctx.log('[mz-gfx] PIXI WebGL1 compatibility hook unavailable');
      }
    }
    if (lower.endsWith('/rmmz_core.js') || lower === 'js/rmmz_core.js') {
      if (g.Utils?.RPGMAKER_NAME) {
        ctx.log(`[mz] core loaded | maker=${g.Utils.RPGMAKER_NAME} version=${g.Utils.RPGMAKER_VERSION}`);
      }
      if (g.Utils) {
        g.Utils.canUseIndexedDB = () => true;
        ctx.log('[mz-host] Utils.canUseIndexedDB -> true via SD StorageManager backend');
        g.Utils.isLocal = () => true;
        ctx.log('[mz-host] Utils.isLocal -> true via ResourceFS/XHR local runtime');
      }
      installMZFontBridge(ctx);
      installMZBitmapCanvasBridge(ctx);
      installMZGraphicsCompat(ctx);
      installMZPixiCreateDiagnostics(ctx);
      installMZAudioCompat(ctx);
    }
    if (lower.endsWith('/rmmz_managers.js') || lower === 'js/rmmz_managers.js') {
      installMZSceneDiagnostics(ctx);
      installMZEffectDiagnostics(ctx);
    }
    if (lower.endsWith('/rmmz_scenes.js') || lower === 'js/rmmz_scenes.js') {
      installMZBattleLifecycleDiagnostics(ctx);
    }
  });
  installMZStorageHook(ctx, scripts);
}

export async function bootMz(ctx: RuntimeContext, scripts: ScriptLoader) {
  const { fs, log } = ctx;
  const document: any = (globalThis as any).document;
  log('[mvmz-opt] V052 raw RGBA optimizer cache remains disabled after device regression; .mvmz_opt ignored');
  scripts.installDynamicScriptBridge(document);
  installMZBootCompat(ctx);
  installMZCoreHooks(ctx, scripts);

  const indexHtml = fs.readText('index.html');
  const sources = extractScriptSources(indexHtml);
  if (!sources.length) throw new Error('MZ index.html has no external scripts');
  log(`[mz] index scripts=${sources.length} | ${sources.join(', ')}`);

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex];
    if (!fs.exists(source)) throw new Error(`MZ script missing: ${source}`);
    await scripts.loadNowWithHooks(source, false, undefined, document);
  }

  await scripts.drain();
  const g: any = globalThis as any;
  if (g.Utils && g.Utils.RPGMAKER_NAME && g.Utils.RPGMAKER_NAME !== 'MZ') {
    throw new Error(`MZ engine identity mismatch: ${g.Utils.RPGMAKER_NAME}`);
  }
  log(`[mz] scripts/plugins drained | version=${g.Utils?.RPGMAKER_VERSION ?? 'pending-main'}`);
  ctx.compat?.runPhase('post_plugins');
  installMZFontBridge(ctx);
  installMZSceneDiagnostics(ctx);
  installMZEffectDiagnostics(ctx);
  installMZHighWaterTransitionReclaim(ctx);
  installMZDamageBitmapCache(ctx);
  log('[mz-warm] V052 all proactive asset/battle warm paths remain disabled; on-demand MZ loading retained');
  if (!ctx.standaloneEngine) installMZHostPump(ctx);
  else installMZStandaloneHostPump(ctx);
  ctx.compat?.runPhase('pre_boot');
  dispatchWindowLoad(log);
  ctx.compat?.runPhase('post_boot');
}