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
      critical(`[mz-battle] Scene_Battle.stop begin | next=${sceneName(g.SceneManager?._nextScene)}`);
      try {
        const result = originalStop.apply(this, args);
        critical('[mz-battle] Scene_Battle.stop end');
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
      critical(`[mz-battle] Scene_Battle.terminate begin | next=${sceneName(g.SceneManager?._nextScene)} autosave=${String(this.shouldAutosave?.())}`);
      try {
        const result = originalTerminate.apply(this, args);
        critical('[mz-battle] Scene_Battle.terminate end');
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
      critical(`[mz-battle] autosave dispatch begin | scene=${sceneName(this)}`);
      try {
        const result = originalAutosave.apply(this, args);
        critical(`[mz-battle] autosave dispatch end | scene=${sceneName(this)}`);
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
      critical(`[mz-battle] DataManager.saveGame begin | id=${String(savefileId)}`);
      try {
        const value = originalSaveGame.call(this, savefileId, ...args);
        return Promise.resolve(value).then(
          result => { critical(`[mz-battle] DataManager.saveGame resolved | id=${String(savefileId)}`); return result; },
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
      critical(`[mz-battle] AudioManager.stopMe begin | hasMe=${!!this._meBuffer}`);
      try {
        const result = originalStopMe.apply(this, args);
        critical(`[mz-battle] AudioManager.stopMe end | hasMe=${!!this._meBuffer}`);
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
      ctx.log(`[mz-asset-warm] image preload FAILED | ${item.key} | ${String((error as any)?.message ?