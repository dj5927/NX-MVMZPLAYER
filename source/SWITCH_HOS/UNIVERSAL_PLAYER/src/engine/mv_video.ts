import type { RuntimeContext } from '../types';

export function installMvNativeVideoBridge(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const graphics = g.Graphics;
  const NativeVideo = g.Video;
  const PIXI = g.PIXI;
  if (!graphics || graphics.__mvmzNativeVideoBridge) return;
  graphics.__mvmzNativeVideoBridge = true;

  if (typeof NativeVideo !== 'function' || !PIXI?.Texture?.fromCanvas || !PIXI?.Sprite) {
    ctx.log(`[mv-video] native bridge unavailable | Video=${typeof NativeVideo} PIXI=${!!PIXI}`);
    return;
  }

  let active: any = null;
  let serial = 0;
  let firstFrameLogged = false;
  let drawErrorLogged = false;

  const critical = (message: string) => {
    ctx.log(message);
    try { ctx.flushLog?.(); } catch {}
  };

  const removeSprite = (state: any) => {
    const sprite = state?.sprite;
    if (!sprite) return;
    try { sprite.parent?.removeChild?.(sprite); } catch {}
    try { sprite.destroy?.({ children: false, texture: true, baseTexture: true }); } catch {
      try { sprite.destroy?.(); } catch {}
    }
    state.sprite = null;
    state.texture = null;
    state.baseTexture = null;
    state.surface = null;
    state.surfaceContext = null;
  };

  const finish = (state: any, reason: string) => {
    if (!state || state.finished) return;
    state.finished = true;
    try { state.media?.pause?.(); } catch {}
    removeSprite(state);
    if (active === state) active = null;
    graphics._videoLoading = false;
    try { if (graphics._video?.style) graphics._video.style.opacity = 0; } catch {}
    critical(`[mv-video] finish | reason=${reason} src=${state.src} time=${Number(state.media?.currentTime || 0).toFixed(3)}/${Number(state.media?.duration || 0).toFixed(3)}`);
  };

  const attachSprite = (state: any) => {
    const scene = g.SceneManager?._scene;
    const sprite = state?.sprite;
    if (!scene?.addChild || !sprite) return;
    if (sprite.parent !== scene) {
      try { sprite.parent?.removeChild?.(sprite); } catch {}
      scene.addChild(sprite);
    } else if (typeof scene.setChildIndex === 'function') {
      try { scene.setChildIndex(sprite, Math.max(0, scene.children.length - 1)); } catch {}
    }
  };

  const createSurface = (state: any) => {
    const width = Math.max(1, Number(state.media?.videoWidth || graphics.width || 816));
    const height = Math.max(1, Number(state.media?.videoHeight || graphics.height || 624));
    const surface: any = new OffscreenCanvas(width, height);
    const surfaceContext: any = surface.getContext('2d');
    if (!surfaceContext) throw new Error('OffscreenCanvas 2D context unavailable');
    const texture: any = PIXI.Texture.fromCanvas(surface, PIXI.SCALE_MODES?.LINEAR, 'mvmz-mv-video');
    const sprite: any = new PIXI.Sprite(texture);
    sprite.x = 0;
    sprite.y = 0;
    sprite.width = Number(graphics.width || width);
    sprite.height = Number(graphics.height || height);
    sprite.visible = true;
    state.surface = surface;
    state.surfaceContext = surfaceContext;
    state.texture = texture;
    state.baseTexture = texture.baseTexture;
    state.sprite = sprite;
    attachSprite(state);
    critical(`[mv-video] surface ready | ${width}x${height} -> ${sprite.width}x${sprite.height}`);
  };

  const drawFrame = () => {
    const state = active;
    if (!state || state.finished || !state.ready || !state.surfaceContext || !state.media) return;
    try {
      attachSprite(state);
      state.surfaceContext.drawImage(state.media, 0, 0, state.surface.width, state.surface.height);
      state.baseTexture?.update?.();
      if (!firstFrameLogged && Number(state.media.currentTime || 0) > 0) {
        firstFrameLogged = true;
        critical(`[mv-video] first frame uploaded | t=${Number(state.media.currentTime || 0).toFixed(3)}`);
      }
    } catch (error) {
      if (!drawErrorLogged) {
        drawErrorLogged = true;
        critical(`[mv-video] frame upload FAILED | ${String((error as any)?.stack ?? error)}`);
      }
    }
  };

  const originalRender = graphics.render;
  graphics.render = function(stage: any) {
    drawFrame();
    return originalRender.call(this, stage);
  };

  graphics.playVideo = function(src: string) {
    const token = ++serial;
    if (active) finish(active, 'replaced');
    firstFrameLogged = false;
    drawErrorLogged = false;
    const relative = String(src || '').replace(/^\.\//, '');
    const path = ctx.fs.resolve(relative);
    const state: any = {
      token,
      src: relative,
      path,
      media: null,
      ready: false,
      finished: false,
      surface: null,
      surfaceContext: null,
      texture: null,
      baseTexture: null,
      sprite: null
    };
    active = state;
    this._videoLoading = true;
    try { if (this._video?.style) this._video.style.opacity = 0; } catch {}
    critical(`[mv-video] play | ${relative} -> ${path}`);

    try {
      const media: any = new NativeVideo();
      state.media = media;
      media.volume = Math.max(0, Math.min(1, Number(this._videoVolume ?? 1)));
      media.loop = false;
      media.onloadedmetadata = () => {
        if (active !== state || state.finished) return;
        try {
          createSurface(state);
          state.ready = true;
          this._videoLoading = false;
          critical(`[mv-video] metadata | ${Number(media.videoWidth || 0)}x${Number(media.videoHeight || 0)} duration=${Number(media.duration || 0).toFixed(3)}`);
        } catch (error) {
          critical(`[mv-video] surface setup FAILED | ${String((error as any)?.stack ?? error)}`);
          finish(state, 'surface-error');
        }
      };
      media.oncanplay = () => {
        if (active !== state || state.finished) return;
        critical(`[mv-video] canplay | buffered native media ready`);
      };
      media.onerror = (event: any) => {
        if (active !== state || state.finished) return;
        critical(`[mv-video] media FAILED | ${String(event?.error?.stack ?? event?.error ?? event)}`);
        finish(state, 'media-error');
      };
      media.onended = () => {
        if (active !== state || state.finished) return;
        finish(state, 'ended');
      };
      media.src = path;
      Promise.resolve(media.play()).catch((error: any) => {
        if (active !== state || state.finished) return;
        critical(`[mv-video] play FAILED | ${String(error?.stack ?? error)}`);
        finish(state, 'play-error');
      });
    } catch (error) {
      critical(`[mv-video] create FAILED | ${String((error as any)?.stack ?? error)}`);
      finish(state, 'create-error');
    }
  };

  graphics._playVideo = function(src: string) {
    return this.playVideo(src);
  };
  graphics.isVideoPlaying = function() {
    return !!active && !active.finished;
  };
  graphics._isVideoVisible = function() {
    return !!active && !!active.ready && !active.finished;
  };
  graphics._updateVisibility = function(_videoVisible: boolean) {
    try { if (this._canvas?.style) this._canvas.style.opacity = 1; } catch {}
    try { if (this._video?.style) this._video.style.opacity = 0; } catch {}
  };
  graphics._onVideoEnd = function() {
    if (active) finish(active, 'engine-end');
  };
  graphics._onVideoError = function() {
    if (active) finish(active, 'engine-error');
  };
  graphics.canPlayVideoType = function(type: string) {
    const value = String(type || '').toLowerCase();
    return value.includes('webm') || value.includes('mp4');
  };
  graphics.setVideoVolume = function(value: number) {
    this._videoVolume = Number(value);
    try { if (active?.media) active.media.volume = Math.max(0, Math.min(1, Number(value))); } catch {}
  };

  ctx.log('[mv-video] native nx.js Video -> OffscreenCanvas -> PIXI bridge installed');
}
