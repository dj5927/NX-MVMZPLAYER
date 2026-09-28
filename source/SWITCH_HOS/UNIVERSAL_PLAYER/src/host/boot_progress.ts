import type { LogFn } from '../types';

type ProgressUpdate = (label: string, percent?: number, detail?: string) => void;

function compile(gl: any, type: number, source: string) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error('Boot progress shader compile failed: ' + gl.getShaderInfoLog(shader));
  }
  return shader;
}

export function createBootProgressPresenter(gl: any, gameName: string, engine: string, log: LogFn) {
  const WIDTH = 1280;
  const HEIGHT = 720;
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const c: any = canvas.getContext('2d');
  if (!c) throw new Error('Boot progress 2D context unavailable');

  const font = 'MVMZ_BootProgressFont';
  try {
    const bytes = Switch.readFileSync('romfs:/fonts/NotoSansCJKkr-Regular.otf');
    if (bytes) {
      const face = new FontFace(font, bytes);
      (globalThis as any).fonts?.add(face);
    }
  } catch (error) {
    log(`[progress] CJK font unavailable | ${String(error)}`);
  }

  const vs = compile(gl, gl.VERTEX_SHADER, `#version 300 es
    in vec2 aPos;
    in vec2 aUv;
    out vec2 vUv;
    void main(){ vUv=aUv; gl_Position=vec4(aPos,0.0,1.0); }
  `);
  const fs = compile(gl, gl.FRAGMENT_SHADER, `#version 300 es
    precision mediump float;
    uniform sampler2D uTex;
    in vec2 vUv;
    out vec4 outColor;
    void main(){ outColor=texture(uTex,vUv); }
  `);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.bindAttribLocation(program, 1, 'aUv');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('Boot progress shader link failed: ' + gl.getProgramInfoLog(program));
  }

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1,-1, 0,1,  1,-1, 1,1,  -1,1, 0,0,
    -1, 1, 0,0,  1,-1, 1,1,   1,1, 1,0
  ]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let disposed = false;
  let lastLoggedLabel = '';
  let lastLoggedPercent = -100;

  const update: ProgressUpdate = (label, percent, detail = '') => {
    if (disposed) return;
    const hasPercent = Number.isFinite(percent as number);
    const value = hasPercent ? Math.max(0, Math.min(100, Number(percent))) : 0;

    c.fillStyle = '#0c1118';
    c.fillRect(0, 0, WIDTH, HEIGHT);
    c.fillStyle = '#ffffff';
    c.textAlign = 'center';
    c.font = `38px ${font}`;
    c.fillText('NX-MVMZPLAYER', WIDTH / 2, 190);
    c.font = `22px ${font}`;
    c.fillStyle = '#9eadc0';
    c.fillText(`${engine}  |  ${gameName}`, WIDTH / 2, 235);
    c.font = `32px ${font}`;
    c.fillStyle = '#eef3f8';
    c.fillText(label, WIDTH / 2, 330);
    if (detail) {
      c.font = `19px ${font}`;
      c.fillStyle = '#93a3b7';
      c.fillText(detail, WIDTH / 2, 370);
    }

    if (hasPercent) {
      const x = 190;
      const y = 430;
      const w = 900;
      const h = 30;
      c.fillStyle = '#253140';
      c.fillRect(x, y, w, h);
      c.fillStyle = '#d9e6ff';
      c.fillRect(x, y, Math.round(w * value / 100), h);
      c.strokeStyle = '#5c6a7b';
      c.lineWidth = 2;
      c.strokeRect(x, y, w, h);
      c.font = `22px ${font}`;
      c.fillStyle = '#eef3f8';
      c.fillText(`${Math.round(value)}%`, WIDTH / 2, 505);
    } else {
      c.font = `19px ${font}`;
      c.fillStyle = '#758498';
      c.fillText('처리 중...', WIDTH / 2, 455);
    }
    c.textAlign = 'left';

    gl.viewport(0, 0, Number(gl.drawingBufferWidth || WIDTH), Number(gl.drawingBufferHeight || HEIGHT));
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0.05, 0.07, 0.10, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    try { gl.flush(); } catch {}

    if (label !== lastLoggedLabel || !hasPercent || Math.abs(value - lastLoggedPercent) >= 5 || value === 100) {
      log(`[progress] ${hasPercent ? `${Math.round(value)}% ` : ''}${label}${detail ? ` | ${detail}` : ''}`);
      lastLoggedLabel = label;
      lastLoggedPercent = value;
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { gl.deleteTexture(texture); } catch {}
    try { gl.deleteBuffer(buffer); } catch {}
    try { gl.deleteVertexArray(vao); } catch {}
    try { gl.deleteProgram(program); } catch {}
    try { gl.deleteShader(vs); } catch {}
    try { gl.deleteShader(fs); } catch {}
  };

  return { update, dispose };
}

