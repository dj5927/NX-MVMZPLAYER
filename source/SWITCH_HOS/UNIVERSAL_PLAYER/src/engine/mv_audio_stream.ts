import type { RuntimeContext } from '../types';

export function installMvNativeAudioStream(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const WebAudio = g.WebAudio;
  const NativeAudio = g.Audio;
  const proto = WebAudio?.prototype;
  if (!proto || proto.__mvmzMvNativeAudioStream) return;
  const hasDedicatedStreamingPlugin = Array.isArray(g.$plugins) && g.$plugins.some((plugin: any) =>
    !!plugin?.status && String(plugin?.name || '').toLowerCase() === 'audiostreaming'
  );
  if (hasDedicatedStreamingPlugin) {
    ctx.log('[mv-audio-stream] skipped | game AudioStreaming plugin owns BGM transport');
    return;
  }
  if (typeof NativeAudio !== 'function') {
    ctx.log('[mv-audio-stream] native Audio unavailable; keeping AudioBuffer playback');
    return;
  }
  proto.__mvmzMvNativeAudioStream = true;

  const critical = (message: string) => {
    ctx.log(message);
    try { ctx.flushLog?.(); } catch {}
  };
  const streamBase = 'sdmc:/mvmz/_audio_stream';
  const safeGameId = String(ctx.game.id || 'game').replace(/[^A-Za-z0-9._%-]/g, '_');
  const streamRoot = `${streamBase}/${safeGameId}/mv`;
  try { Switch.mkdirSync(streamBase); } catch {}
  try { Switch.mkdirSync(`${streamBase}/${safeGameId}`); } catch {}
  try { Switch.mkdirSync(streamRoot); } catch {}

  const originalOnXhrLoad = proto._onXhrLoad;
  const originalClear = proto.clear;
  const originalIsReady = proto.isReady;
  const originalIsError = proto.isError;
  const originalIsPlaying = proto.isPlaying;
  const originalPlay = proto.play;
  const originalStop = proto.stop;
  const originalFadeIn = proto.fadeIn;
  const originalFadeOut = proto.fadeOut;
  const originalSeek = proto.seek;
  const volumeDescriptor = Object.getOwnPropertyDescriptor(proto, 'volume');
  const pitchDescriptor = Object.getOwnPropertyDescriptor(proto, 'pitch');
  const panDescriptor = Object.getOwnPropertyDescriptor(proto, 'pan');

  // Short SE stays on WebAudio so repeated effects can reuse decoded
  // AudioBuffers in memory. BGM/BGS/ME remain on native streaming.
  const isStreamCategory = (url: any) => /^audio\/(?:bgm|bgs|me)\//i.test(String(url || ''));
  const streamPathFor = (url: string) => {
    let name = String(url || 'audio.ogg')
      .replace(/^https?:\/\//i, '')
      .replace(/[^A-Za-z0-9._-]+/g, '__');
    if (!/\.[A-Za-z0-9]{2,5}$/i.test(name)) name += '.ogg';
    if (name.length > 180) name = name.slice(name.length - 180);
    return `${streamRoot}/${name}`;
  };

  const destroyStream = (owner: any) => {
    const media = owner?.__mvmzStream;
    if (media) {
      try { media.pause?.(); } catch {}
      try {
        media.onloadedmetadata = null;
        media.onerror = null;
        media.ontimeupdate = null;
        media.onended = null;
      } catch {}
      try { media.src = ''; } catch {}
    }
    owner.__mvmzStream = null;
    owner.__mvmzStreamMode = false;
    owner.__mvmzStreamReady = false;
    owner.__mvmzStreamError = false;
  };

  let transientSeDisposeLogs = 0;
  const disposeTransientSe = (owner: any) => {
    if (!/^audio\/se\//i.test(String(owner?._url || ''))) return;
    if (owner?._reservedSeName) return;
    if (!owner?.__mvmzStream && !owner?.__mvmzStreamMode) return;
    const url = String(owner?._url || '');
    destroyStream(owner);
    if (transientSeDisposeLogs < 8) {
      transientSeDisposeLogs++;
      ctx.log(`[mv-audio-stream] transient SE disposed | ${url}`);
      if (transientSeDisposeLogs === 8) ctx.log('[mv-audio-stream] further transient SE dispose logs suppressed');
    }
  };
  const applyParams = (owner: any) => {
    const media = owner?.__mvmzStream;
    if (!media) return;
    try { media.volume = Math.max(0, Math.min(1, Number(owner._volume ?? 1))); } catch {}
    try {
      if ('playbackRate' in media) media.playbackRate = Math.max(0.01, Number(owner._pitch || 1));
    } catch {}
  };

  const prepareStream = (owner: any, arrayBuffer: ArrayBuffer) => {
    try {
      destroyStream(owner);
      const bytes = new Uint8Array(arrayBuffer);
      const path = streamPathFor(String(owner._url || 'audio.ogg'));
      let needsWrite = true;
      try {
        const stat = Switch.statSync(path);
        needsWrite = !stat || Number(stat.size) !== bytes.byteLength;
      } catch {}
      if (needsWrite) {
        Switch.writeFileSync(path, bytes);
        ctx.log(`[mv-audio-stream] cache write | url=${String(owner._url || '')} bytes=${bytes.byteLength} path=${path}`);
      } else {
        ctx.log(`[mv-audio-stream] cache hit | url=${String(owner._url || '')} bytes=${bytes.byteLength}`);
      }

      const media: any = new NativeAudio();
      owner.__mvmzStreamMode = true;
      owner.__mvmzStreamReady = false;
      owner.__mvmzStreamError = false;
      owner.__mvmzStream = media;
      owner.__mvmzStreamPath = path;
      owner._hasError = false;
      owner._buffer = null;

      media.onloadedmetadata = () => {
        owner.__mvmzStreamReady = true;
        owner.__mvmzStreamError = false;
        owner._hasError = false;
        owner._totalTime = Number(media.duration || 0);
        if (owner._loopLength > 0 && owner._sampleRate > 0) {
          owner._loopStart /= owner._sampleRate;
          owner._loopLength /= owner._sampleRate;
        } else {
          owner._loopStart = 0;
          owner._loopLength = owner._totalTime;
        }
        applyParams(owner);
        critical(`[mv-audio-stream] ready | url=${String(owner._url || '')} duration=${Number(media.duration || 0).toFixed(3)} rate=${String(media.playbackRate ?? 'n/a')} loopStart=${Number(owner._loopStart || 0).toFixed(3)} loopLength=${Number(owner._loopLength || 0).toFixed(3)}`);
        owner._onLoad?.();
      };
      media.onerror = (event: any) => {
        owner.__mvmzStreamError = true;
        owner.__mvmzStreamReady = false;
        owner._hasError = true;
        critical(`[mv-audio-stream] FAILED | url=${String(owner._url || '')} path=${path} | ${String(event?.error?.stack ?? event?.error ?? event)}`);
      };
      media.ontimeupdate = () => {
        if (!owner._autoPlay || !owner.__mvmzStreamLoop) return;
        const start = Number(owner._loopStart || 0);
        const length = Number(owner._loopLength || 0);
        const total = Number(media.duration || 0);
        const end = start + length;
        if (length > 0 && end < total - 0.05 && Number(media.currentTime || 0) >= end - 0.02) {
          try { media.currentTime = start; } catch {}
        }
      };
      media.onended = () => {
        if (owner.__mvmzStreamLoop) {
          try {
            media.currentTime = Number(owner._loopStart || 0);
            Promise.resolve(media.play()).catch(() => {});
          } catch {}
        } else {
          owner._autoPlay = false;
          if (owner._stopListeners) {
            while (owner._stopListeners.length > 0) {
              try { owner._stopListeners.shift()?.(); } catch {}
            }
          }
          disposeTransientSe(owner);
        }
      };
      media.src = path;
      ctx.log(`[mv-audio-stream] armed | url=${String(owner._url || '')} bytes=${bytes.byteLength}`);
      return true;
    } catch (error) {
      destroyStream(owner);
      ctx.log(`[mv-audio-stream] setup FAILED | url=${String(owner?._url || '')} | ${String((error as any)?.stack ?? error)}`);
      return false;
    }
  };

  proto._onXhrLoad = function(xhr: any) {
    if (!isStreamCategory(this?._url)) return originalOnXhrLoad.call(this, xhr);
    let array = xhr?.response;
    if (!(array instanceof ArrayBuffer)) return originalOnXhrLoad.call(this, xhr);
    try {
      if (g.Decrypter?.hasEncryptedAudio) array = g.Decrypter.decryptArrayBuffer(array);
      try { this._readLoopComments(new Uint8Array(array)); } catch {}
      if (prepareStream(this, array)) return;
    } catch (error) {
      ctx.log(`[mv-audio-stream] decrypt/prepare FAILED -> AudioBuffer fallback | ${String(this?._url || '')} | ${String(error)}`);
    }
    return originalOnXhrLoad.call(this, xhr);
  };

  proto.clear = function() {
    if (this.__mvmzStreamMode || this.__mvmzStream) destroyStream(this);
    return originalClear.call(this);
  };
  proto.isReady = function() {
    if (this.__mvmzStreamMode) return !!this.__mvmzStreamReady;
    return originalIsReady.call(this);
  };
  proto.isError = function() {
    if (this.__mvmzStreamMode) return !!this.__mvmzStreamError;
    return originalIsError.call(this);
  };
  proto.isPlaying = function() {
    if (this.__mvmzStreamMode) return !!this._autoPlay && !this.__mvmzStream?.paused;
    return originalIsPlaying.call(this);
  };
  proto.play = function(loop: boolean, offset: number) {
    if (!this.__mvmzStreamMode) return originalPlay.call(this, loop, offset);
    this.__mvmzStreamLoop = !!loop;
    this._autoPlay = true;
    if (!this.__mvmzStreamReady) {
      this.addLoadListener(() => {
        if (this._autoPlay) this.play(loop, offset);
      });
      return;
    }
    const media = this.__mvmzStream;
    if (!media) return;
    const startOffset = Math.max(0, Number(offset || 0));
    const loopStart = Number(this._loopStart || 0);
    const loopLength = Number(this._loopLength || 0);
    const total = Number(media.duration || 0);
    const customLoop = !!loop && loopLength > 0 && loopStart + loopLength < total - 0.05;
    try { media.loop = !!loop && !customLoop; } catch {}
    try { media.currentTime = startOffset; } catch {}
    this._startTime = Number(WebAudio._context?.currentTime || 0) - startOffset / Number(this._pitch || 1);
    applyParams(this);
    Promise.resolve(media.play()).catch((error: any) => {
      this.__mvmzStreamError = true;
      this._hasError = true;
      critical(`[mv-audio-stream] play FAILED | url=${String(this._url || '')} | ${String(error?.stack ?? error)}`);
    });
  };
  proto.stop = function() {
    if (!this.__mvmzStreamMode) return originalStop.call(this);
    this._autoPlay = false;
    try { this.__mvmzStream?.pause?.(); } catch {}
    if (this._stopListeners) {
      while (this._stopListeners.length > 0) {
        try { this._stopListeners.shift()?.(); } catch {}
      }
    }
    disposeTransientSe(this);
  };
  proto.fadeIn = function(duration: number) {
    if (!this.__mvmzStreamMode) return originalFadeIn.call(this, duration);
    const media = this.__mvmzStream;
    if (!media) return;
    const target = Math.max(0, Math.min(1, Number(this._volume ?? 1)));
    const start = performance.now();
    try { media.volume = 0; } catch {}
    const tick = () => {
      if (!this.__mvmzStreamMode || this.__mvmzStream !== media) return;
      const p = Math.min(1, (performance.now() - start) / Math.max(1, Number(duration || 0) * 1000));
      try { media.volume = target * p; } catch {}
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  proto.fadeOut = function(duration: number) {
    if (!this.__mvmzStreamMode) return originalFadeOut.call(this, duration);
    const media = this.__mvmzStream;
    if (!media) return;
    const initial = Number(media.volume ?? this._volume ?? 1);
    const start = performance.now();
    this._autoPlay = false;
    const tick = () => {
      if (!this.__mvmzStreamMode || this.__mvmzStream !== media) return;
      const p = Math.min(1, (performance.now() - start) / Math.max(1, Number(duration || 0) * 1000));
      try { media.volume = initial * (1 - p); } catch {}
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  proto.seek = function() {
    if (this.__mvmzStreamMode) return Number(this.__mvmzStream?.currentTime || 0);
    return originalSeek.call(this);
  };

  if (volumeDescriptor?.get && volumeDescriptor?.set) {
    Object.defineProperty(proto, 'volume', {
      get: volumeDescriptor.get,
      set(value: number) {
        if (this.__mvmzStreamMode) {
          if (this._volume === value) return;
          this._volume = value;
          try {
            if (this.__mvmzStream) {
              this.__mvmzStream.volume = Math.max(0, Math.min(1, Number(value ?? 1)));
            }
          } catch {}
        } else {
          volumeDescriptor.set!.call(this, value);
        }
      },
      configurable: true
    });
  }
  if (pitchDescriptor?.get && pitchDescriptor?.set) {
    Object.defineProperty(proto, 'pitch', {
      get: pitchDescriptor.get,
      set(value: number) {
        if (this.__mvmzStreamMode) {
          if (this._pitch === value) return;
          this._pitch = value;
          try {
            if (this.__mvmzStream && 'playbackRate' in this.__mvmzStream) {
              this.__mvmzStream.playbackRate = Math.max(0.01, Number(value || 1));
            }
          } catch {}
          ctx.log(`[mv-audio-stream] pitch changed | url=${String(this._url || '')} pitch=${String(value)}`);
        } else {
          pitchDescriptor.set!.call(this, value);
        }
      },
      configurable: true
    });
  }
  if (panDescriptor?.get && panDescriptor?.set) {
    Object.defineProperty(proto, 'pan', {
      get: panDescriptor.get,
      set(value: number) {
        if (this.__mvmzStreamMode) {
          this._pan = value;
        } else {
          panDescriptor.set!.call(this, value);
        }
      },
      configurable: true
    });
  }

  ctx.log('[mv-audio-stream] native Audio BGM/BGS/ME installed | short SE=WebAudio decoded-memory cache');
}
