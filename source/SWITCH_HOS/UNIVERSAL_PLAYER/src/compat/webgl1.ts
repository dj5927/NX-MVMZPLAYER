export type CompatStats = {
  translatedShaders: number;
  vertexShaders: number;
  fragmentShaders: number;
  compileFailures: number;
  extensionAliases: string[];
};

type LogFn = (message: string) => void;

function stripVersionAndLegacyExtensions(source: string): string {
  return source
    .replace(/^\s*#version\s+100\s*\r?\n?/m, '')
    .replace(/^\s*#extension\s+GL_OES_standard_derivatives\s*:\s*(?:enable|require)\s*\r?\n?/gm, '')
    .replace(/^\s*#extension\s+GL_EXT_shader_texture_lod\s*:\s*(?:enable|require)\s*\r?\n?/gm, '');
}

function translateCommon(source: string): string {
  return source
    .replace(/\btexture2DProj\b/g, 'textureProj')
    .replace(/\btexture2DLodEXT\b/g, 'textureLod')
    .replace(/\btexture2D\b/g, 'texture')
    .replace(/\btextureCube\b/g, 'texture')
    .replace(/\bgl_FragDepthEXT\b/g, 'gl_FragDepth')
    // `sample` is a reserved keyword in GLSL ES 3.00. PixiJS 4.x uses it
    // as a local variable name in several WebGL1-era fragment shaders.
    .replace(/\bsample\b/g, 'mvmz_sample');
}

function translateVertex(source: string): string {
  let body = stripVersionAndLegacyExtensions(source);
  body = body.replace(/\battribute\b/g, 'in').replace(/\bvarying\b/g, 'out');
  body = translateCommon(body);
  return `#version 300 es\n${body}`;
}

function translateFragment(source: string): string {
  let body = stripVersionAndLegacyExtensions(source);
  body = body.replace(/\bvarying\b/g, 'in');
  body = translateCommon(body);
  let outputDecl = '';
  const fragDataLocations = new Set<number>();
  body = body.replace(/\bgl_FragData\s*\[\s*(\d+)\s*\]/g, (_match, indexText) => {
    const index = Number(indexText);
    if (Number.isFinite(index) && index >= 0) fragDataLocations.add(index);
    return `mvmz_FragData${index}`;
  });
  if (fragDataLocations.size) {
    outputDecl += [...fragDataLocations]
      .sort((a, b) => a - b)
      .map(index => `layout(location = ${index}) out mediump vec4 mvmz_FragData${index};\n`)
      .join('');
  }
  if (/\bgl_FragColor\b/.test(body)) {
    outputDecl += 'out mediump vec4 mvmz_FragColor;\n';
    body = body.replace(/\bgl_FragColor\b/g, 'mvmz_FragColor');
  }
  return `#version 300 es\n${outputDecl}${body}`;
}

function makeVertexArrayAlias(native: {
  create: null | (() => any);
  bind: null | ((vao: any) => any);
  remove: null | ((vao: any) => any);
  test: null | ((vao: any) => boolean);
}) {
  if (!native.create || !native.bind || !native.remove || !native.test) return null;
  return {
    createVertexArrayOES: () => native.create!(),
    bindVertexArrayOES: (vao: any) => native.bind!(vao),
    deleteVertexArrayOES: (vao: any) => native.remove!(vao),
    isVertexArrayOES: (vao: any) => native.test!(vao),
  };
}

export function createWebGL1Compat(raw: WebGL2RenderingContext, log: LogFn) {
  // Capture the native WebGL2 VAO entrypoints before exposing the context to
  // Pixi/Effekseer. Some WebGL1 compatibility code overwrites
  // gl.createVertexArray/bindVertexArray/deleteVertexArray with OES wrappers.
  // The OES alias must never look those properties up again after that point,
  // otherwise the wrapper can call back into itself forever.
  const nativeVao = {
    create: typeof (raw as any).createVertexArray === 'function' ? (raw as any).createVertexArray.bind(raw) : null,
    bind: typeof (raw as any).bindVertexArray === 'function' ? (raw as any).bindVertexArray.bind(raw) : null,
    remove: typeof (raw as any).deleteVertexArray === 'function' ? (raw as any).deleteVertexArray.bind(raw) : null,
    test: typeof (raw as any).isVertexArray === 'function' ? (raw as any).isVertexArray.bind(raw) : null,
  };
  const shaderTypes = new WeakMap<object, number>();
  const shaderSources = new WeakMap<object, string>();
  const stats: CompatStats = { translatedShaders: 0, vertexShaders: 0, fragmentShaders: 0, compileFailures: 0, extensionAliases: [] };
  const aliases = new Map<string, any>();
  const boundMethods = new Map<PropertyKey, any>();
  const maxFailureLogs = 8;
  let currentFramebuffer: any = null;
  let fitLogicalWidth = 0;
  let fitLogicalHeight = 0;
  let fitScale = 1;
  let fitX = 0;
  let fitY = 0;
  let fitWidth = Number(raw.drawingBufferWidth || (globalThis as any).screen?.width || 1280);
  let fitHeight = Number(raw.drawingBufferHeight || (globalThis as any).screen?.height || 720);

  const unwrapTexSource = (value: any) => {
    if (value && typeof value.getNativeCanvas === 'function') return value.getNativeCanvas();
    return value;
  };

  const summarizeUploadStage = (data: Uint8Array | Uint8ClampedArray, width: number, height: number) => {
    const pixelCount = Math.max(1, width * height);
    const step = Math.max(1, Math.ceil(Math.sqrt(pixelCount / 65536)));
    let sampled = 0, translucent = 0, redDom = 0, cyanDom = 0;
    let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        const r = Number(data[i] || 0), g = Number(data[i + 1] || 0), b = Number(data[i + 2] || 0), a = Number(data[i + 3] || 0);
        sampled++; sumR += r; sumG += g; sumB += b; sumA += a;
        if (a > 0 && a < 255) {
          translucent++;
          if (r > g + 20 && r > b + 20) redDom++;
          if (g > r + 20 && b > r + 20) cyanDom++;
        }
      }
    }
    const d = Math.max(1, sampled);
    return { sampled, translucent, redDom, cyanDom, avgR: sumR / d, avgG: sumG / d, avgB: sumB / d, avgA: sumA / d };
  };

  let canvasUploadLogs = 0;
  let dirtyUploadLogs = 0;
  let dirtyUploadedPixels = 0;
  let dirtyAvoidedPixels = 0;
  const prepareCanvasUpload = (value: any, preferDirty = false) => {
    if (!value || typeof value.getNativeCanvas !== 'function') return null;
    try {
      const native = value.getNativeCanvas();
      const fullWidth = Math.max(1, Number(native?.width || value.width || 0));
      const fullHeight = Math.max(1, Number(native?.height || value.height || 0));
      const context = native?.getContext?.('2d');
      if (!context || typeof context.getImageData !== 'function') return null;
      const sourceUrl = String((value as any).__mvmzSourceUrl || (native as any)?.__mvmzSourceUrl || '');
      const premultiply = !!raw.getParameter((raw as any).UNPACK_PREMULTIPLY_ALPHA_WEBGL);
      const flipY = !!raw.getParameter((raw as any).UNPACK_FLIP_Y_WEBGL);
      let x = 0, y = 0, width = fullWidth, height = fullHeight, dirty = false;
      if (preferDirty && !flipY && !sourceUrl && typeof value.__mvmzPeekDirtyRect === 'function') {
        const rect = value.__mvmzPeekDirtyRect?.();
        const rx = Math.max(0, Math.floor(Number(rect?.x || 0)));
        const ry = Math.max(0, Math.floor(Number(rect?.y || 0)));
        const rw = Math.max(0, Math.min(fullWidth - rx, Math.ceil(Number(rect?.width || 0))));
        const rh = Math.max(0, Math.min(fullHeight - ry, Math.ceil(Number(rect?.height || 0))));
        const area = rw * rh;
        const fullArea = fullWidth * fullHeight;
        if (area > 0 && area < fullArea * 0.85) {
          x = rx; y = ry; width = rw; height = rh; dirty = true;
        }
      }
      const image = context.getImageData(x, y, width, height);
      const rgba = image.data;
      const stageProbe = !dirty && /^img\/characters\/(?:\$00_Menu_|!00_rousoku|!00_Fire_eff_ex0001)/i.test(sourceUrl);
      const rawStage = stageProbe ? summarizeUploadStage(rgba, width, height) : null;
      if (premultiply) {
        for (let i = 0; i < rgba.length; i += 4) {
          const a = rgba[i + 3];
          if (a === 255) continue;
          if (a === 0) {
            rgba[i] = 0;
            rgba[i + 1] = 0;
            rgba[i + 2] = 0;
            continue;
          }
          rgba[i] = Math.round(rgba[i] * a / 255);
          rgba[i + 1] = Math.round(rgba[i + 1] * a / 255);
          rgba[i + 2] = Math.round(rgba[i + 2] * a / 255);
        }
      }
      const preparedStage = stageProbe ? summarizeUploadStage(rgba, width, height) : null;
      let upload = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      if (flipY && height > 1) {
        const rowBytes = width * 4;
        const flipped = new Uint8Array(upload.length);
        for (let row = 0; row < height; row++) {
          const from = row * rowBytes;
          const to = (height - 1 - row) * rowBytes;
          flipped.set(upload.subarray(from, from + rowBytes), to);
        }
        upload = flipped;
      }
      if (dirty) {
        const area = width * height, fullArea = fullWidth * fullHeight;
        dirtyUploadedPixels += area;
        dirtyAvoidedPixels += Math.max(0, fullArea - area);
        if (dirtyUploadLogs < 12) {
          dirtyUploadLogs++;
          const saved = fullArea > 0 ? (100 * (fullArea - area) / fullArea).toFixed(1) : '0.0';
          log(`[webgl1] Canvas dirty upload | rect=${x},${y} ${width}x${height} canvas=${fullWidth}x${fullHeight} saved=${saved}% cumulativeSavedMP=${(dirtyAvoidedPixels / 1000000).toFixed(1)}`);
          if (dirtyUploadLogs === 12) log('[webgl1] further Canvas dirty upload logs suppressed');
        }
      } else if (canvasUploadLogs < 8) {
        canvasUploadLogs++;
        log(`[webgl1] Canvas RGBA upload bridge | ${width}x${height} premultiply=${premultiply} flipY=${flipY}`);
        if (canvasUploadLogs === 8) log('[webgl1] further Canvas RGBA upload logs suppressed');
      }
      return { width, height, fullWidth, fullHeight, x, y, dirty, upload, premultiply, flipY, sourceUrl, rawStage, preparedStage, dirtyOwner: value };
    } catch (error) {
      if (canvasUploadLogs < 8) {
        canvasUploadLogs++;
        log(`[webgl1] Canvas RGBA upload fallback | ${String(error)}`);
      }
      return null;
    }
  };

  let gpuProbeLogs = 0;
  let gpuProbeSkipLogs = 0;
  let trackedActiveTexture = Number((raw as any).TEXTURE0 ?? 0x84c0);
  const trackedTexture2DByUnit = new Map<number, any>();
  let trackedLastTexture2D: any = null;
  let trackedTextureBindSerial = 0;
  const summarizeRgba = (data: Uint8Array | Uint8ClampedArray, width: number, height: number) => {
    const pixelCount = Math.max(1, width * height);
    const step = Math.max(1, Math.ceil(Math.sqrt(pixelCount / 65536)));
    let sampled = 0, translucent = 0, redDom = 0, cyanDom = 0;
    let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        const r = Number(data[i] || 0), g = Number(data[i + 1] || 0), b = Number(data[i + 2] || 0), a = Number(data[i + 3] || 0);
        sampled++; sumR += r; sumG += g; sumB += b; sumA += a;
        if (a > 0 && a < 255) {
          translucent++;
          if (r > g + 20 && r > b + 20) redDom++;
          if (g > r + 20 && b > r + 20) cyanDom++;
        }
      }
    }
    const d = Math.max(1, sampled);
    return { sampled, translucent, redDom, cyanDom, avgR: sumR / d, avgG: sumG / d, avgB: sumB / d, avgA: sumA / d };
  };

  const probeUploadedTexture = (prepared: any) => {
    const g: any = globalThis as any;
    if (!g.__mvmzGpuTextureReadbackProbe || gpuProbeLogs >= 8) return;
    const sourceUrl = String(prepared?.sourceUrl || '');
    const titlePriority = /^img\/titles\d*\/Castle-animation_000[12]\.png$/i.test(sourceUrl);
    const ghostPriority = /^img\/parallaxes\/!00_tittle\.png$/i.test(sourceUrl)
      || /^img\/characters\/(?:\$00_Menu_|!00_rousoku|!00_Fire_eff_ex0001|%2400_cursor)/i.test(sourceUrl);
    if (!titlePriority && !ghostPriority) {
      if (gpuProbeSkipLogs < 4 && sourceUrl) {
        gpuProbeSkipLogs++;
        log(`[webgl1] GPU probe non-target skip | source=${sourceUrl} size=${Number(prepared?.width || 0)}x${Number(prepared?.height || 0)}`);
      }
      return;
    }
    const width = Math.max(1, Number(prepared?.width || 0));
    const height = Math.max(1, Number(prepared?.height || 0));
    const pixelLimit = /!00_(?:rousoku|Fire_eff_ex0001)/i.test(sourceUrl) ? 3000000 : 1200000;
    if (width * height > pixelLimit) {
      if (gpuProbeSkipLogs < 6) {
        gpuProbeSkipLogs++;
        log(`[webgl1] GPU probe large skip | ${sourceUrl} ${width}x${height} limit=${pixelLimit}`);
      }
      return;
    }
    const texture = trackedTexture2DByUnit.get(trackedActiveTexture) || trackedLastTexture2D;
    if (!texture) {
      log(`[webgl1] GPU texture readback skipped | ${sourceUrl} trackedTexture=missing unit=${trackedActiveTexture} bindSerial=${trackedTextureBindSerial}`);
      return;
    }
    const drawEnum = (raw as any).DRAW_FRAMEBUFFER_BINDING;
    const readEnum = (raw as any).READ_FRAMEBUFFER_BINDING;
    const oldDraw = drawEnum != null ? raw.getParameter(drawEnum) : raw.getParameter((raw as any).FRAMEBUFFER_BINDING);
    const oldRead = readEnum != null ? raw.getParameter(readEnum) : oldDraw;
    const framebuffer = raw.createFramebuffer();
    if (!framebuffer) return;
    try {
      raw.bindFramebuffer((raw as any).FRAMEBUFFER, framebuffer);
      raw.framebufferTexture2D((raw as any).FRAMEBUFFER, (raw as any).COLOR_ATTACHMENT0, (raw as any).TEXTURE_2D, texture, 0);
      const status = raw.checkFramebufferStatus((raw as any).FRAMEBUFFER);
      if (status !== (raw as any).FRAMEBUFFER_COMPLETE) {
        log(`[webgl1] GPU texture readback skipped | ${sourceUrl} framebufferStatus=${status}`);
        return;
      }
      const pixels = new Uint8Array(width * height * 4);
      raw.readPixels(0, 0, width, height, (raw as any).RGBA, (raw as any).UNSIGNED_BYTE, pixels);
      const errorCode = Number(raw.getError?.() || 0);
      const src = summarizeRgba(prepared.upload, width, height);
      const gpu = summarizeRgba(pixels, width, height);
      const rawStage = prepared?.rawStage;
      const preparedStage = prepared?.preparedStage;
      gpuProbeLogs++;
      if (rawStage && preparedStage) {
        log(`[webgl1] Canvas upload stage | ${sourceUrl} rawAvg=${rawStage.avgR.toFixed(1)},${rawStage.avgG.toFixed(1)},${rawStage.avgB.toFixed(1)},${rawStage.avgA.toFixed(1)} rawTrans=${rawStage.translucent} rawRed=${rawStage.redDom} rawCyan=${rawStage.cyanDom} preparedAvg=${preparedStage.avgR.toFixed(1)},${preparedStage.avgG.toFixed(1)},${preparedStage.avgB.toFixed(1)},${preparedStage.avgA.toFixed(1)} preparedRed=${preparedStage.redDom} preparedCyan=${preparedStage.cyanDom} postCallAvg=${src.avgR.toFixed(1)},${src.avgG.toFixed(1)},${src.avgB.toFixed(1)},${src.avgA.toFixed(1)} postCallRed=${src.redDom} postCallCyan=${src.cyanDom}`);
      }
      log(`[webgl1] GPU texture readback | ${sourceUrl} ${width}x${height} pma=${!!prepared?.premultiply} flipY=${!!prepared?.flipY} unit=${trackedActiveTexture} bindSerial=${trackedTextureBindSerial} glError=${errorCode} srcAvg=${src.avgR.toFixed(1)},${src.avgG.toFixed(1)},${src.avgB.toFixed(1)},${src.avgA.toFixed(1)} gpuAvg=${gpu.avgR.toFixed(1)},${gpu.avgG.toFixed(1)},${gpu.avgB.toFixed(1)},${gpu.avgA.toFixed(1)} srcTrans=${src.translucent} gpuTrans=${gpu.translucent} srcRed=${src.redDom} gpuRed=${gpu.redDom} srcCyan=${src.cyanDom} gpuCyan=${gpu.cyanDom}`);
      if (gpuProbeLogs === 8) log('[webgl1] further GPU texture readback logs suppressed');
    } catch (error) {
      gpuProbeLogs++;
      log(`[webgl1] GPU texture readback FAILED | ${sourceUrl} | ${String(error)}`);
    } finally {
      try {
        if (drawEnum != null) raw.bindFramebuffer((raw as any).DRAW_FRAMEBUFFER, oldDraw);
        if (readEnum != null) raw.bindFramebuffer((raw as any).READ_FRAMEBUFFER, oldRead);
        if (drawEnum == null && readEnum == null) raw.bindFramebuffer((raw as any).FRAMEBUFFER, oldDraw);
      } catch {}
      try { raw.deleteFramebuffer(framebuffer); } catch {}
    }
  };
  const withRawUnpackDisabled = (work: () => any) => {
    const premultiplyEnum = (raw as any).UNPACK_PREMULTIPLY_ALPHA_WEBGL;
    const flipEnum = (raw as any).UNPACK_FLIP_Y_WEBGL;
    const oldPremultiply = !!raw.getParameter(premultiplyEnum);
    const oldFlip = !!raw.getParameter(flipEnum);
    try {
      raw.pixelStorei(premultiplyEnum, false);
      raw.pixelStorei(flipEnum, false);
      return work();
    } finally {
      raw.pixelStorei(premultiplyEnum, oldPremultiply);
      raw.pixelStorei(flipEnum, oldFlip);
    }
  };

  const updateDefaultFramebufferFit = (logicalWidth: number, logicalHeight: number) => {
    if (!(logicalWidth > 0) || !(logicalHeight > 0)) return;
    const physicalWidth = Number(raw.drawingBufferWidth || (globalThis as any).screen?.width || logicalWidth);
    const physicalHeight = Number(raw.drawingBufferHeight || (globalThis as any).screen?.height || logicalHeight);
    const scale = Math.min(physicalWidth / logicalWidth, physicalHeight / logicalHeight);
    const width = Math.max(1, Math.round(logicalWidth * scale));
    const height = Math.max(1, Math.round(logicalHeight * scale));
    const x = Math.floor((physicalWidth - width) / 2);
    const y = Math.floor((physicalHeight - height) / 2);
    const changed = logicalWidth !== fitLogicalWidth || logicalHeight !== fitLogicalHeight ||
      width !== fitWidth || height !== fitHeight || x !== fitX || y !== fitY;

    fitLogicalWidth = logicalWidth;
    fitLogicalHeight = logicalHeight;
    fitScale = scale;
    fitX = x;
    fitY = y;
    fitWidth = width;
    fitHeight = height;

    (globalThis as any).__mvmzViewportFit = {
      logicalWidth,
      logicalHeight,
      physicalWidth,
      physicalHeight,
      scale,
      x,
      y,
      width,
      height,
      top: physicalHeight - (y + height)
    };

    if (changed) {
      log(`[webgl1] default framebuffer fit | logical=${logicalWidth}x${logicalHeight} physical=${physicalWidth}x${physicalHeight} viewport=${x},${y},${width}x${height} scale=${scale.toFixed(4)}`);
    }
  };

  const bindFramebufferCompat = (target: number, framebuffer: any) => {
    if (target === (raw as any).FRAMEBUFFER || target === (raw as any).DRAW_FRAMEBUFFER) currentFramebuffer = framebuffer;
    return (raw as any).bindFramebuffer(target, framebuffer);
  };

  const viewportCompat = (x: number, y: number, width: number, height: number) => {
    if (currentFramebuffer == null) {
      if (x === 0 && y === 0) updateDefaultFramebufferFit(width, height);
      return (raw as any).viewport(
        Math.round(fitX + x * fitScale),
        Math.round(fitY + y * fitScale),
        Math.max(1, Math.round(width * fitScale)),
        Math.max(1, Math.round(height * fitScale))
      );
    }
    return (raw as any).viewport(x, y, width, height);
  };

  const scissorCompat = (x: number, y: number, width: number, height: number) => {
    if (currentFramebuffer == null && fitLogicalWidth > 0 && fitLogicalHeight > 0) {
      return (raw as any).scissor(
        Math.round(fitX + x * fitScale),
        Math.round(fitY + y * fitScale),
        Math.max(1, Math.round(width * fitScale)),
        Math.max(1, Math.round(height * fitScale))
      );
    }
    return (raw as any).scissor(x, y, width, height);
  };

  const getExtension = (name: string) => {
    const native = raw.getExtension(name);
    if (native) return native;
    if (aliases.has(name)) return aliases.get(name);
    let alias: any = null;
    if (name === 'OES_vertex_array_object' || name === 'MOZ_OES_vertex_array_object' || name === 'WEBKIT_OES_vertex_array_object') {
      alias = makeVertexArrayAlias(nativeVao);
      if (alias) log('[webgl1] OES VAO alias bound to frozen WebGL2 entrypoints');
    } else if (name === 'OES_packed_depth_stencil') {
      alias = { DEPTH_STENCIL_OES: 0x84f9 };
      log('[webgl1] OES packed depth-stencil alias -> WebGL2 core');
    } else if (name === 'OES_texture_float' || name === 'OES_element_index_uint' || name === 'OES_standard_derivatives') {
      alias = {};
    }
    aliases.set(name, alias);
    if (alias && !stats.extensionAliases.includes(name)) stats.extensionAliases.push(name);
    return alias;
  };

  const describeGlArg = (value: any) => {
    if (value == null) return String(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'string') return JSON.stringify(value.slice(0, 80));
    if (ArrayBuffer.isView(value)) return String(value.constructor?.name || 'TypedArray') + '(' + Number(value.byteLength || (value as any).length || 0) + ')';
    if (value instanceof ArrayBuffer) return 'ArrayBuffer(' + value.byteLength + ')';
    const ctor = String(value?.constructor?.name || typeof value);
    const width = Number(value?.width || value?.videoWidth || 0);
    const height = Number(value?.height || value?.videoHeight || 0);
    return width > 0 && height > 0 ? ctor + '(' + width + 'x' + height + ')' : ctor;
  };

  const tracedMethods = new Set([
    'texParameteri', 'pixelStorei',
    'framebufferTexture2D', 'framebufferRenderbuffer', 'renderbufferStorage',
    'bufferData', 'bufferSubData', 'vertexAttribPointer',
    'drawElements', 'drawArrays'
  ]);

  const callWithGlTrace = (target: any, name: string, fn: (...args: any[]) => any, args: any[]) => {
    const g: any = globalThis as any;
    if (!g.__mvmzGlErrorTraceEnabled) return fn(...args);
    const budget = Math.max(0, Number(g.__mvmzGlErrorTraceBudget ?? 0));
    if (budget <= 0) {
      g.__mvmzGlErrorTraceEnabled = false;
      return fn(...args);
    }
    let result: any;
    let thrown: any = null;
    try {
      result = fn(...args);
    } catch (error) {
      thrown = error;
    }
    const errorCode = Number(target.getError?.() || 0);
    g.__mvmzGlErrorTraceBudget = budget - 1;
    if (errorCode || thrown) {
      log('[webgl1] GL trace | call=' + name + ' error=' + errorCode + ' thrown=' + (thrown ? String(thrown) : 'none') + ' args=' + args.map(describeGlArg).join(','));
    }
    if (g.__mvmzGlErrorTraceBudget <= 0) {
      g.__mvmzGlErrorTraceEnabled = false;
      log('[webgl1] GL trace call budget exhausted');
    }
    if (thrown) throw thrown;
    return result;
  };

  const proxy = new Proxy(raw as any, {
    get(target, property) {
      if (property === 'getExtension') return getExtension;
      if (property === 'activeTexture') return (unit: number) => {
        trackedActiveTexture = Number(unit);
        return callWithGlTrace(target, 'activeTexture', target.activeTexture.bind(target), [unit]);
      };
      if (property === 'bindTexture') return (targetEnum: number, texture: any) => {
        if (targetEnum === target.TEXTURE_2D) {
          trackedTexture2DByUnit.set(trackedActiveTexture, texture);
          trackedLastTexture2D = texture;
          trackedTextureBindSerial++;
        }
        return callWithGlTrace(target, 'bindTexture', target.bindTexture.bind(target), [targetEnum, texture]);
      };
      if (property === 'bindFramebuffer') return bindFramebufferCompat;
      if (property === 'viewport') return viewportCompat;
      if (property === 'scissor') return scissorCompat;
      if (property === 'createShader') return (type: number) => { const shader = target.createShader(type); if (shader) shaderTypes.set(shader, type); return shader; };
      if (property === 'shaderSource') return (shader: object, source: string) => {
        const type = shaderTypes.get(shader);
        let translated = source;
        if (!/^\s*#version\s+300\s+es/m.test(source)) {
          if (type === target.VERTEX_SHADER) { translated = translateVertex(source); stats.vertexShaders++; }
          else if (type === target.FRAGMENT_SHADER) { translated = translateFragment(source); stats.fragmentShaders++; }
          if (translated !== source) stats.translatedShaders++;
        }
        shaderSources.set(shader, translated);
        return target.shaderSource(shader, translated);
      };
      if (property === 'compileShader') return (shader: object) => {
        target.compileShader(shader);
        if (!target.getShaderParameter(shader, target.COMPILE_STATUS)) {
          stats.compileFailures++;
          if (stats.compileFailures <= maxFailureLogs) {
            log(`[webgl1] shader compile FAILED: ${String(target.getShaderInfoLog(shader) ?? 'unknown')}`);
            log(`[webgl1] source head: ${(shaderSources.get(shader) ?? '').slice(0, 500).replace(/\s+/g, ' ')}`);
          } else if (stats.compileFailures === maxFailureLogs + 1) {
            log(`[webgl1] further shader failure logs suppressed after ${maxFailureLogs} failures`);
          }
        }
      };
      if (property === 'texImage2D') return (...args: any[]) => {
        if (args.length === 6) {
          const prepared = prepareCanvasUpload(args[5], false);
          if (prepared) {
            const typedArgs = [args[0], args[1], args[2], prepared.width, prepared.height, 0, args[3], args[4], prepared.upload];
            return withRawUnpackDisabled(() => {
              const result = callWithGlTrace(target, 'texImage2D', target.texImage2D.bind(target), typedArgs);
              probeUploadedTexture(prepared);
              try { prepared.dirtyOwner?.__mvmzClearDirtyRect?.(); } catch {}
              return result;
            });
          }
        }
        if (args.length >= 6) args[args.length - 1] = unwrapTexSource(args[args.length - 1]);
        return callWithGlTrace(target, 'texImage2D', target.texImage2D.bind(target), args);
      };
      if (property === 'texSubImage2D') return (...args: any[]) => {
        if (args.length === 7) {
          const prepared = prepareCanvasUpload(args[6], true);
          if (prepared) {
            const typedArgs = [args[0], args[1], Number(args[2] || 0) + Number(prepared.x || 0), Number(args[3] || 0) + Number(prepared.y || 0), prepared.width, prepared.height, args[4], args[5], prepared.upload];
            return withRawUnpackDisabled(() => {
              const result = callWithGlTrace(target, 'texSubImage2D', target.texSubImage2D.bind(target), typedArgs);
              probeUploadedTexture(prepared);
              try { prepared.dirtyOwner?.__mvmzClearDirtyRect?.(); } catch {}
              return result;
            });
          }
        }
        if (args.length >= 7) args[args.length - 1] = unwrapTexSource(args[args.length - 1]);
        return callWithGlTrace(target, 'texSubImage2D', target.texSubImage2D.bind(target), args);
      };
      if (property === 'renderbufferStorage') return (targetEnum: number, internalFormat: number, width: number, height: number) => {
        const mappedFormat = internalFormat === 0x84f9
          ? Number(target.DEPTH24_STENCIL8 ?? 0x88f0)
          : internalFormat;
        if (mappedFormat !== internalFormat) {
          log('[webgl1] renderbufferStorage DEPTH_STENCIL_OES -> DEPTH24_STENCIL8');
        }
        return callWithGlTrace(
          target,
          'renderbufferStorage',
          target.renderbufferStorage.bind(target),
          [targetEnum, mappedFormat, width, height]
        );
      };
      if (property === 'bufferSubData') return (...args: any[]) => {
        const data = args[2];
        if (data != null && Number(data.byteLength ?? 0) === 0) return;
        return callWithGlTrace(target, 'bufferSubData', target.bufferSubData.bind(target), args);
      };
      if (property === 'getContextAttributes') return () => ({ ...(target.getContextAttributes?.() ?? {}), stencil: true });
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property === 'string' && tracedMethods.has(property)) {
        if (boundMethods.has(property)) return boundMethods.get(property);
        const traced = (...args: any[]) => callWithGlTrace(target, property, value.bind(target), args);
        boundMethods.set(property, traced);
        return traced;
      }
      if (boundMethods.has(property)) return boundMethods.get(property);
      const bound = value.bind(target);
      boundMethods.set(property, bound);
      return bound;
    }
  });
  return { gl: proxy as any, stats };
}
