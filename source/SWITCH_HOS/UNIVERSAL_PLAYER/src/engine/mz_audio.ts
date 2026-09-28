import type { RuntimeContext } from '../types';

export function installMZAudioCompat(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const WebAudio = g.WebAudio;
  const NativeVideo = g.__mvmzNativeMediaVideo;
  const proto = WebAudio?.prototype;
  if (!proto || proto.__mvmzAudioCompat) return;
  proto.__mvmzAudioCompat = true;

  const critical = (message: string) => {
    ctx.log(message);
    try { ctx.flushLog?.(); } catch {}
  };
  const streamBase = 'sdmc:/mvmz/_audio_stream';
  const safeGameId = String(ctx.game.id || 'game').replace(/[^A-Za-z0-9._%-]/g, '_');
  const streamRoot = `${streamBase}/${safeGameId}`;
  const streamThreshold = 1024 * 1024;
  const seCacheMaxBytes = 48 * 1024 * 1024;
  const seCacheMaxEntries = 96;
  const seDecodeCache = new Map<string, any>();
  let seCacheBytes = 0;
  let seCacheLogCount = 0;
  try { Switch.mkdirSync(streamBase); } catch {}
  try { Switch.mkdirSync(streamRoot); } catch {}

  const originalDecodeAudioData = proto._decodeAudioData;
  const originalStartLoading = proto._startLoading;
  const originalOnDecode = proto._onDecode;
  const originalIsReady = proto.isReady;
  const originalIsError = proto.isError;
  const originalPlay = proto.play;
  const originalStop = proto.stop;
  const originalDestroy = proto.destroy;
  const originalFadeIn = proto.fadeIn;
  const originalFadeOut = proto.fadeOut;
  const originalSeek = proto.seek;
  const originalOnError = proto._onError;
  const volumeDescriptor = Object.getOwnPropertyDescriptor(proto, 'volume');
  const pitchDescriptor = Object.getOwnPropertyDescriptor(proto, 'pitch');

  const audioProto: any = g.AudioContext?.prototype;
  if (audioProto && !audioProto.__mvmzMzPannerBridgeInstalled) {
    const createStereoPanner = audioProto.createStereoPanner;
    const createGain = audioProto.createGain;
    let loggedBackend = false;
    const createCompatPanner = function(this: any) {
      if (typeof createStereoPanner === 'function') {
        try {
          const node: any = createStereoPanner.call(this);
          node.panningModel = 'equalpower';
          node.setPosition = (x: number, _y: number, _z: number) => {
            const pan = Math.max(-1, Math.min(1, Number(x) || 0));
            try {
              if (node.pan?.setValueAtTime) node.pan.setValueAtTime(pan, this.currentTime);
              else if (node.pan) node.pan.value = pan;
            } catch {}
          };
          if (!loggedBackend) {
            loggedBackend = true;
            ctx.log('[mz-audio] panner backend=StereoPannerNode');
          }
          return node;
        } catch (error) {
          ctx.log(`[mz-audio] StereoPanner unavailable -> Gain passthrough | ${String(error)}`);
        }
      }
      if (typeof createGain === 'function') {
        const node: any = createGain.call(this);
        node.panningModel = 'equalpower';
        node.setPosition = (_x: number, _y: number, _z: number) => {};
        if (!loggedBackend) {
          loggedBackend = true;
          ctx.log('[mz-audio] panner backend=GainNode passthrough');
        }
        return node;
      }
      throw new Error('No compatible audio panner backend available');
    };
    try {
      audioProto.createPanner = createCompatPanner;
      audioProto.__mvmzMzPannerBridgeInstalled = true;
      proto._createPannerNode = function() {
        this._pannerNode = createCompatPanner.call(WebAudio._context);
        this._pannerNode.panningModel = 'equalpower';
        this._pannerNode.connect(WebAudio._masterGainNode);
        this._updatePanner();
      };
      ctx.log('[mz-audio] AudioContext/WebAudio panner compatibility installed');
    } catch (error) {
      critical(`[mz-audio] panner compatibility FAILED | ${String((error as any)?.stack ?? error)}`);
    }
  }

  const normalizeAudioUrl = (url: any) => String(url || '').replace(/\\/g, '/');
  const isSeUrl = (url: any) => /(?:^|\/)audio\/se\//i.test(normalizeAudioUrl(url));
  const estimateAudioBufferBytes = (buffer: any) => {
    const frames = Math.max(0, Number(buffer?.length || 0));
    const channels = Math.max(1, Number(buffer?.numberOfChannels || 1));
    return Math.max(0, Math.floor(frames * channels * 4));
  };
  const trimSeCache = () => {
    while (seDecodeCache.size > seCacheMaxEntries || seCacheBytes > seCacheMaxBytes) {
      const oldest = seDecodeCache.keys().next();
      if (oldest.done) break;
      const key = oldest.value;
      const entry = seDecodeCache.get(key);
      seDecodeCache.delete(key);
      seCacheBytes = Math.max(0, seCacheBytes - Number(entry?.bytes || 0));
    }
  };
  const storeSeCache = (owner: any, buffer: any) => {
    const key = normalizeAudioUrl(owner?._url);
    if (!isSeUrl(key) || !buffer || owner?._shouldUseDecoder?.()) return;
    const bytes = estimateAudioBufferBytes(buffer);
    const previous = seDecodeCache.get(key);
    if (previous) seCacheBytes = Math.max(0, seCacheBytes - Number(previous.bytes || 0));
    seDecodeCache.delete(key);
    seDecodeCache.set(key, {
      buffer, bytes,
      totalTime: Number(owner?._totalTime || buffer.duration || 0),
      loopStart: Number(owner?._loopStart || 0),
      loopLength: Number(owner?._loopLength || 0),
      sampleRate: Number(owner?._sampleRate || buffer.sampleRate || 0),
      loopStartTime: Number(owner?._loopStartTime || 0),
      loopLengthTime: Number(owner?._loopLengthTime || buffer.duration || 0)
    });
    seCacheBytes += bytes;
    trimSeCache();
    if (seCacheLogCount < 24) {
      seCacheLogCount++;
      ctx.log(`[mz-audio] SE decode cache STORE | url=${key} entries=${seDecodeCache.size} cacheMiB=${(seCacheBytes / 1048576).toFixed(1)}`);
    }
  };
  const restoreSeCache = (owner: any, entry: any, key: string) => {
    seDecodeCache.delete(key);
    seDecodeCache.set(key, entry);
    owner._lastUpdateTime = WebAudio._currentTime() - 0.5;
    owner._isError = false;
    owner._isLoaded = true;
    owner._data = null;
    try { owner._destroyDecoder?.(); } catch {}
    owner._buffers = [entry.buffer];
    owner._totalTime = Number(entry.totalTime || entry.buffer?.duration || 0);
    owner._loopStart = Number(entry.loopStart || 0);
    owner._loopLength = Number(entry.loopLength || 0);
    owner._sampleRate = Number(entry.sampleRate || entry.buffer?.sampleRate || 0);
    owner._loopStartTime = Number(entry.loopStartTime || 0);
    owner._loopLengthTime = Number(entry.loopLengthTime || owner._totalTime || 0);
    if (seCacheLogCount < 24) {
      seCacheLogCount++;
      ctx.log(`[mz-audio] SE decode cache HIT | url=${key} entries=${seDecodeCache.size}`);
    }
    try { owner._onLoad?.(); } catch {}
  };

  const streamPathFor = (url: string) => {
    let name = String(url || 'audio.ogg')
      .replace(/^https?:\/\//i, '')
      .replace(/[^A-Za-z0-9._-]+/g, '__');
    if (!/\.[A-Za-z0-9]{2,5}$/i.test(name)) name += '.ogg';
    if (name.length > 180) name = name.slice(name.length - 180);
    return `${streamRoot}/${name}`;
  };

  const applyStreamParams = (owner: any) => {
    const media = owner.__mvmzStream;
    if (!media) return;
    try { media.volume = Math.max(0, Math.min(1, Number(owner._volume ?? 1))); } catch {}
    try {
      if ('playbackRate' in media) media.playbackRate = Number(owner._pitch || 1);
      else if (Number(owner._pitch || 1) !== 1 && !owner.__mvmzPitchWarning) {
        owner.__mvmzPitchWarning = true;
        ctx.log(`[mz-audio] native stream pitch unsupported; using 1.0 | url=${String(owner._url || '')} requested=${String(owner._pitch)}`);
      }
    } catch {}
  };

  const startStreamingFallback = (owner: any, arrayBuffer: ArrayBuffer, reason: any) => {
    if (typeof NativeVideo !== 'function') return false;
    try {
      const path = streamPathFor(String(owner._url || 'audio.ogg'));
      const bytes = new Uint8Array(arrayBuffer);
      let needsWrite = true;
      try {
        const stat = Switch.statSync(path);
        needsWrite = !stat || Number(stat.size) !== bytes.byteLength;
      } catch {}
      if (needsWrite) {
        Switch.writeFileSync(path, bytes);
        critical(`[mz-audio] stream cache write | url=${String(owner._url || '')} bytes=${bytes.byteLength} path=${path}`);
      } else {
        ctx.log(`[mz-audio] stream cache hit | url=${String(owner._url || '')} bytes=${bytes.byteLength}`);
      }

      const media: any = new NativeVideo();
      owner.__mvmzStreamMode = true;
      owner.__mvmzStreamReady = false;
      owner.__mvmzStreamError = false;
      owner.__mvmzStream = media;
      owner.__mvmzStreamPath = path;
      owner._isError = false;
      if (reason) {
        critical(`[mz-audio] native decode fallback -> streaming | url=${String(owner._url || '')} bytes=${bytes.byteLength} reason=${String(reason?.stack ?? reason)}`);
      } else {
        ctx.log(`[mz-audio] large audio -> streaming | url=${String(owner._url || '')} bytes=${bytes.byteLength}`);
      }

      media.onloadedmetadata = () => {
        owner.__mvmzStreamReady = true;
        owner.__mvmzStreamError = false;
        owner._isError = false;
        owner._totalTime = Number(media.duration || 0);
        if (owner._loopLength > 0 && owner._sampleRate > 0) {
          owner._loopStartTime = owner._loopStart / owner._sampleRate;
          owner._loopLengthTime = owner._loopLength / owner._sampleRate;
        } else {
          owner._loopStartTime = 0;
          owner._loopLengthTime = owner._totalTime;
        }
        applyStreamParams(owner);
        critical(`[mz-audio] stream ready | url=${String(owner._url || '')} duration=${Number(media.duration || 0).toFixed(3)} loopStart=${Number(owner._loopStartTime || 0).toFixed(3)} loopLength=${Number(owner._loopLengthTime || 0).toFixed(3)}`);
        owner._onLoad?.();
      };
      media.onerror = (event: any) => {
        owner.__mvmzStreamError = true;
        owner.__mvmzStreamReady = false;
        critical(`[mz-audio] stream FAILED | url=${String(owner._url || '')} path=${path} | ${String(event?.error?.stack ?? event?.error ?? event)}`);
        originalOnError.call(owner);
      };
      media.ontimeupdate = () => {
        if (!owner._isPlaying || !owner._loop) return;
        const loopStart = Number(owner._loopStartTime || 0);
        const loopLength = Number(owner._loopLengthTime || 0);
        const total = Number(media.duration || 0);
        const loopEnd = loopStart + loopLength;
        if (loopLength > 0 && loopEnd < total - 0.05 && Number(media.currentTime || 0) >= loopEnd - 0.02) {
          try { media.currentTime = loopStart; } catch {}
        }
      };
      media.onended = () => {
        if (!owner._loop) owner._isPlaying = false;
      };
      media.src = path;
      return true;
    } catch (error) {
      critical(`[mz-audio] streaming fallback setup FAILED | url=${String(owner._url || '')} | ${String((error as any)?.stack ?? error)}`);
      return false;
    }
  };

  proto._startLoading = function() {
    const key = normalizeAudioUrl(this._url);
    const entry = isSeUrl(key) ? seDecodeCache.get(key) : null;
    if (entry) {
      restoreSeCache(this, entry, key);
      return;
    }
    return originalStartLoading.apply(this, arguments as any);
  };

  proto._onDecode = function(buffer: any) {
    const result = originalOnDecode.call(this, buffer);
    storeSeCache(this, buffer);
    return result;
  };

  g.__mvmzMZPrewarmSe = (name: any) => {
    const seName = String(name || '');
    const audioManager = g.AudioManager;
    if (!seName || !audioManager?.createBuffer) return false;
    const ext = typeof audioManager.audioFileExt === 'function' ? audioManager.audioFileExt() : '.ogg';
    const encoded = g.Utils?.encodeURI ? g.Utils.encodeURI(seName) : encodeURIComponent(seName);
    const key = normalizeAudioUrl(`${audioManager._path || 'audio/'}se/${encoded}${ext}`);
    if (seDecodeCache.has(key)) return true;
    try {
      const buffer = audioManager.createBuffer('se/', seName);
      if (!buffer) return false;
      buffer.__mvmzPrewarmOnly = true;
      const dispose = () => { try { buffer.destroy?.(); } catch {} };
      if (buffer.isReady?.()) dispose();
      else buffer.addLoadListener?.(dispose);
      return true;
    } catch {
      return false;
    }
  };

  proto._decodeAudioData = function(arrayBuffer: ArrayBuffer) {
    if (this._shouldUseDecoder?.()) return originalDecodeAudioData.call(this, arrayBuffer);
    const bytes = Number(arrayBuffer?.byteLength || 0);
    if (bytes >= streamThreshold && startStreamingFallback(this, arrayBuffer, null)) return;
    const copy = arrayBuffer.slice(0);
    ctx.log(`[mz-audio] decode start | url=${String(this._url || '')} bytes=${bytes}`);
    WebAudio._context
      .decodeAudioData(copy)
      .then((buffer: any) => {
        ctx.log(`[mz-audio] decode OK | url=${String(this._url || '')} duration=${Number(buffer?.duration || 0).toFixed(3)}`);
        this._onDecode(buffer);
      })
      .catch((error: any) => {
        critical(`[mz-audio] decode FAILED | url=${String(this._url || '')} bytes=${bytes} | ${String(error?.stack ?? error)}`);
        if (!startStreamingFallback(this, arrayBuffer, error)) originalOnError.call(this);
      });
  };

  proto.isReady = function() {
    if (this.__mvmzStreamMode) return !!this.__mvmzStreamReady;
    return originalIsReady.call(this);
  };
  proto.isError = function() {
    if (this.__mvmzStreamMode) return !!this.__mvmzStreamError;
    return originalIsError.call(this);
  };
  proto.play = function(loop: boolean, offset: number) {
    if (!this.__mvmzStreamMode) return originalPlay.call(this, loop, offset);
    this._loop = loop;
    this._isPlaying = true;
    if (!this.__mvmzStreamReady) {
      this.addLoadListener(() => this.play(loop, offset));
      return;
    }
    const media = this.__mvmzStream;
    if (!media) return;
    const loopStart = Number(this._loopStartTime || 0);
    const loopLength = Number(this._loopLengthTime || 0);
    const total = Number(media.duration || 0);
    const customLoop = !!loop && loopLength > 0 && loopStart + loopLength < total - 0.05;
    try { media.loop = !!loop && !customLoop; } catch {}
    const startOffset = Math.max(0, Number(offset || 0));
    try { if (startOffset > 0) media.currentTime = startOffset; } catch {}
    this._startTime = WebAudio._currentTime() - startOffset / Number(this._pitch || 1);
    applyStreamParams(this);
    Promise.resolve(media.play()).catch((error: any) => {
      this.__mvmzStreamError = true;
      critical(`[mz-audio] stream play FAILED | url=${String(this._url || '')} | ${String(error?.stack ?? error)}`);
    });
  };
  proto.stop = function() {
    if (!this.__mvmzStreamMode) return originalStop.call(this);
    try { this.__mvmzStream?.pause?.(); } catch {}
    this._isPlaying = false;
    this._loadListeners = [];
    if (this._stopListeners) {
      while (this._stopListeners.length > 0) this._stopListeners.shift()?.();
    }
  };
  proto.destroy = function() {
    if (!this.__mvmzStreamMode) return originalDestroy.call(this);
    try { this.__mvmzStream?.pause?.(); } catch {}
    try {
      const media = this.__mvmzStream;
      if (media) {
        media.onloadedmetadata = null;
        media.onerror = null;
        media.ontimeupdate = null;
        media.onended = null;
      }
    } catch {}
    this.__mvmzStream = null;
    this.__mvmzStreamReady = false;
    this.__mvmzStreamMode = false;
    return originalDestroy.call(this);
  };
  proto.fadeIn = function(duration: number) {
    if (!this.__mvmzStreamMode) return originalFadeIn.call(this, duration);
    if (this.__mvmzStreamReady) applyStreamParams(this);
    else this.addLoadListener(() => this.fadeIn(duration));
  };
  proto.fadeOut = function(duration: number) {
    if (!this.__mvmzStreamMode) return originalFadeOut.call(this, duration);
    try { if (this.__mvmzStream) this.__mvmzStream.volume = 0; } catch {}
    this._isPlaying = false;
    this._loadListeners = [];
  };
  proto.seek = function() {
    if (this.__mvmzStreamMode) return Number(this.__mvmzStream?.currentTime || 0);
    return originalSeek.call(this);
  };

  if (volumeDescriptor?.get && volumeDescriptor?.set) {
    Object.defineProperty(proto, 'volume', {
      get: volumeDescriptor.get,
      set(value: number) {
        volumeDescriptor.set!.call(this, value);
        if (this.__mvmzStreamMode) applyStreamParams(this);
      },
      configurable: true
    });
  }
  if (pitchDescriptor?.get && pitchDescriptor?.set) {
    Object.defineProperty(proto, 'pitch', {
      get: pitchDescriptor.get,
      set(value: number) {
        pitchDescriptor.set!.call(this, value);
        if (this.__mvmzStreamMode) applyStreamParams(this);
      },
      configurable: true
    });
  }
  ctx.log(`[mz-audio] compatibility installed | nativeVideo=${typeof NativeVideo} streamThreshold=${streamThreshold} seCacheMiB=${seCacheMaxBytes / 1048576} seCacheEntries=${seCacheMaxEntries}`);
}
