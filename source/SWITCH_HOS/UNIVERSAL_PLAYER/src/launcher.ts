import type { GameInfo, LogFn } from './types';

const WIDTH = 1280;
const HEIGHT = 720;

function pressed(index: number) {
  return !!navigator.getGamepads()[0]?.buttons[index]?.pressed;
}

function compile(gl: any, type: number, source: string) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error('Launcher shader compile failed: ' + gl.getShaderInfoLog(shader));
  }
  return shader;
}

export async function selectGame(gl: any, games: GameInfo[], log: LogFn): Promise<GameInfo> {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const c: any = canvas.getContext('2d');
  if (!c) throw new Error('Launcher 2D context unavailable');

  const launcherFont = 'MVMZ_LauncherFont';
  try {
    const fontBytes = Switch.readFileSync('romfs:/fonts/NotoSansCJKkr-Regular.otf');
    if (fontBytes) {
      const face = new FontFace(launcherFont, fontBytes);
      (globalThis as any).fonts?.add(face);
      log(`[launcher] CJK font registered | status=${face.status}`);
    }
  } catch (error) {
    log(`[launcher] CJK font fallback unavailable | ${String(error)}`);
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
    throw new Error('Launcher shader link failed: ' + gl.getProgramInfoLog(program));
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

  let selected = 0;
  let scroll = 0;
  const visible = 10;
  let dirty = true;
  let prevUp = false;
  let prevDown = false;
  let prevB = false;
  let prevExit = false;
  let exitQueued = false;

  const redraw = () => {
    c.fillStyle = '#10151d';
    c.fillRect(0, 0, WIDTH, HEIGHT);
    c.fillStyle = '#ffffff';
    c.font = `36px ${launcherFont}`;
    c.fillText('MVMZ Player', 64, 72);
    c.font = `22px ${launcherFont}`;
    c.fillStyle = '#aab4c2';
    c.fillText(`${games.length} games found`, 66, 108);

    if (selected < scroll) scroll = selected;
    if (selected >= scroll + visible) scroll = selected - visible + 1;
    for (let i = 0; i < visible && scroll + i < games.length; i++) {
      const index = scroll + i;
      const y = 150 + i * 48;
      if (index === selected) {
        c.fillStyle = '#d9e6ff';
        c.fillRect(54, y - 31, 1172, 42);
        c.fillStyle = '#10151d';
      } else {
        c.fillStyle = '#e8edf3';
      }
      c.font = `26px ${launcherFont}`;
      c.fillText(games[index].name, 76, y);
      c.font = `17px ${launcherFont}`;
      c.fillStyle = index === selected ? '#445166' : '#7f8b9b';
      c.fillText(games[index].engine, 1120, y);
    }
    c.font = `19px ${launcherFont}`;
    c.fillStyle = '#9da8b6';
    c.fillText('D-Pad Up/Down: Select     B: Launch     Plus+Minus: Exit', 64, 680);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    dirty = false;
  };

  log(`[launcher] showing ${games.length} games`);
  return await new Promise<GameInfo>((resolve) => {
    const frame = () => {
      const up = pressed(12);
      const down = pressed(13);
      const b = pressed(1);
      const exit = pressed(8) && pressed(9);

      if (up && !prevUp) { selected = (selected + games.length - 1) % games.length; dirty = true; }
      if (down && !prevDown) { selected = (selected + 1) % games.length; dirty = true; }
      if (exit && !prevExit && !exitQueued) {
        exitQueued = true;
        log('[launcher] exit requested');
        setTimeout(() => {
          try { Switch.exit(); }
          catch (error) {
            exitQueued = false;
            log(`[launcher] exit FAILED | ${String(error)}`);
          }
        }, 80);
        return;
      }
      if (b && !prevB) {
        const game = games[selected];
        log(`[launcher] selected | index=${selected} name=${game.name} engine=${game.engine}`);
        gl.deleteTexture(texture);
        gl.deleteBuffer(buffer);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        resolve(game);
        return;
      }
      prevUp = up;
      prevDown = down;
      prevB = b;
      prevExit = exit;

      if (dirty) redraw();
      gl.viewport(0, 0, WIDTH, HEIGHT);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0.06, 0.08, 0.11, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      requestAnimationFrame(frame);
    };
    redraw();
    requestAnimationFrame(frame);
  });
}
