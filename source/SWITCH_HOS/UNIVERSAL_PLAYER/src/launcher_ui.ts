import { Button } from '@nx.js/constants';
import type { GameInfo, LogFn } from './types';

const WIDTH = 1280;
const HEIGHT = 720;
const EXIT_COMBO_HOLD_MS = 300;

export interface LauncherCatalog {
  displayNames: Record<string, string>;
  listPath: string;
  imageRoot: string;
}

function pressed(index: number) {
  return !!navigator.getGamepads()[0]?.buttons[index]?.pressed;
}

function exists(path: string) {
  try { return Switch.statSync(path) !== null; }
  catch { return false; }
}

function readText(path: string) {
  const data = Switch.readFileSync(path);
  if (!data) throw new Error(`Failed to read ${path}`);
  return new TextDecoder().decode(data);
}

export function prepareLauncherCatalog(gamesRoot: string, games: GameInfo[], log: LogFn): LauncherCatalog {
  const listPath = `${gamesRoot}/gamelist.json`;
  const imageRoot = `${gamesRoot}/_image`;
  try { Switch.mkdirSync(imageRoot); } catch {}

  let displayNames: Record<string, string> = {};
  let valid = true;
  let changed = false;

  if (exists(listPath)) {
    try {
      const parsed = JSON.parse(readText(listPath));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('root must be a JSON object');
      }
      for (const [folder, display] of Object.entries(parsed)) {
        if (typeof display === 'string') displayNames[folder] = display;
      }
    } catch (error) {
      valid = false;
      log(`[launcher] gamelist parse FAILED; using folder names without overwriting file | path=${listPath} | ${String(error)}`);
    }
  } else {
    changed = true;
  }

  if (valid) {
    for (const game of games) {
      if (!(game.name in displayNames)) {
        displayNames[game.name] = game.name;
        changed = true;
      }
    }

    if (changed) {
      const ordered: Record<string, string> = {};
      for (const key of Object.keys(displayNames).sort((a, b) => a.localeCompare(b))) ordered[key] = displayNames[key];
      displayNames = ordered;
      try {
        Switch.writeFileSync(listPath, JSON.stringify(displayNames, null, 2) + '\n');
        log(`[launcher] gamelist synced | path=${listPath} entries=${Object.keys(displayNames).length}`);
      } catch (error) {
        log(`[launcher] gamelist write FAILED | path=${listPath} | ${String(error)}`);
      }
    }
  }

  log(`[launcher] thumbnail root | ${imageRoot}`);
  return { displayNames, listPath, imageRoot };
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

function displayName(game: GameInfo, catalog?: LauncherCatalog) {
  const mapped = catalog?.displayNames?.[game.name];
  return typeof mapped === 'string' && mapped.trim() ? mapped : game.name;
}

function truncateText(c: any, text: string, maxWidth: number) {
  if (c.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && c.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
  return out + '…';
}

function drawCover(c: any, image: any, x: number, y: number, width: number, height: number) {
  const iw = Math.max(1, Number(image?.width || 1));
  const ih = Math.max(1, Number(image?.height || 1));
  const targetRatio = width / height;
  const sourceRatio = iw / ih;
  let sx = 0;
  let sy = 0;
  let sw = iw;
  let sh = ih;
  if (sourceRatio > targetRatio) {
    sw = ih * targetRatio;
    sx = (iw - sw) * 0.5;
  } else {
    sh = iw / targetRatio;
    sy = (ih - sh) * 0.5;
  }
  c.drawImage(image, sx, sy, sw, sh, x, y, width, height);
}

export async function selectGame(gl: any, games: GameInfo[], log: LogFn, catalog?: LauncherCatalog): Promise<GameInfo> {
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

  type ViewMode = 'list' | 'grid';
  type ThumbnailState = { state: 'loading' | 'ready' | 'missing' | 'error'; image?: ImageBitmap };

  let selected = 0;
  let scroll = 0;
  const visible = 10;
  let viewMode: ViewMode = 'list';
  let dirty = true;
  let exitModal = false;
  let exitYes = false;
  let exitQueued = false;
  let comboStartedAt: number | null = null;
  let comboLatched = false;
  let minusTapCandidate = false;
  const thumbnails = new Map<string, ThumbnailState>();

  let prevUp = false;
  let prevDown = false;
  let prevLeft = false;
  let prevRight = false;
  let prevConfirm = false;
  let prevCancel = false;
  let prevMinus = false;

  const wrapIndex = (value: number) => ((value % games.length) + games.length) % games.length;

  const ensureThumbnail = (game: GameInfo) => {
    if (!catalog?.imageRoot || thumbnails.has(game.name)) return;
    const path = `${catalog.imageRoot}/${game.name}.png`;
    if (!exists(path)) {
      thumbnails.set(game.name, { state: 'missing' });
      return;
    }
    thumbnails.set(game.name, { state: 'loading' });
    Promise.resolve().then(async () => {
      try {
        const bytes = Switch.readFileSync(path);
        if (!bytes) throw new Error('empty file');
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        thumbnails.set(game.name, { state: 'ready', image });
        log(`[launcher] thumbnail ready | folder=${game.name} size=${image.width}x${image.height}`);
      } catch (error) {
        thumbnails.set(game.name, { state: 'error' });
        log(`[launcher] thumbnail FAILED | folder=${game.name} path=${path} | ${String(error)}`);
      }
      dirty = true;
    });
  };

  const cleanup = () => {
    for (const value of thumbnails.values()) {
      try { value.image?.close?.(); } catch {}
    }
    gl.deleteTexture(texture);
    gl.deleteBuffer(buffer);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
  };

  const drawHeader = () => {
    c.fillStyle = '#10151d';
    c.fillRect(0, 0, WIDTH, HEIGHT);
    c.fillStyle = '#ffffff';
    c.font = `36px ${launcherFont}`;
    c.fillText('MVMZ Player', 54, 62);
    c.font = `20px ${launcherFont}`;
    c.fillStyle = '#aab4c2';
    c.fillText(`${games.length} games found`, 56, 96);
    c.textAlign = 'right';
    c.fillText(viewMode === 'list' ? 'TEXT LIST' : 'THUMBNAIL 5 x 2', 1224, 64);
    c.textAlign = 'left';
  };

  const drawList = () => {
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + visible) scroll = selected - visible + 1;
    for (let i = 0; i < visible && scroll + i < games.length; i++) {
      const index = scroll + i;
      const y = 142 + i * 49;
      if (index === selected) {
        c.fillStyle = '#d9e6ff';
        c.fillRect(44, y - 31, 1192, 42);
        c.fillStyle = '#10151d';
      } else {
        c.fillStyle = '#e8edf3';
      }
      c.font = `26px ${launcherFont}`;
      c.fillText(truncateText(c, displayName(games[index], catalog), 940), 66, y);
      c.font = `17px ${launcherFont}`;
      c.fillStyle = index === selected ? '#445166' : '#7f8b9b';
      c.fillText(games[index].engine, 1152, y);
    }
  };

  const drawGrid = () => {
    const pageStart = Math.floor(selected / 10) * 10;
    const colWidth = 236;
    const imageWidth = 166;
    const imageHeight = 221;
    const left = 42;
    const top = 112;
    const rowHeight = 260;
    for (let slot = 0; slot < 10 && pageStart + slot < games.length; slot++) {
      const index = pageStart + slot;
      const game = games[index];
      const col = slot % 5;
      const row = Math.floor(slot / 5);
      const cellX = left + col * colWidth;
      const imageX = cellX + (colWidth - imageWidth) * 0.5;
      const imageY = top + row * rowHeight;
      const isSelected = index === selected;

      if (isSelected) {
        c.fillStyle = '#d9e6ff';
        c.fillRect(cellX + 4, imageY - 8, colWidth - 8, 250);
      }

      c.fillStyle = '#202a36';
      c.fillRect(imageX, imageY, imageWidth, imageHeight);
      ensureThumbnail(game);
      const thumb = thumbnails.get(game.name);
      if (thumb?.state === 'ready' && thumb.image) {
        drawCover(c, thumb.image, imageX, imageY, imageWidth, imageHeight);
      } else {
        c.fillStyle = '#344153';
        c.fillRect(imageX + 3, imageY + 3, imageWidth - 6, imageHeight - 6);
        c.fillStyle = '#93a4ba';
        c.textAlign = 'center';
        c.font = `22px ${launcherFont}`;
        c.fillText(thumb?.state === 'loading' ? 'Loading...' : game.engine, imageX + imageWidth / 2, imageY + imageHeight / 2);
        c.textAlign = 'left';
      }

      c.strokeStyle = isSelected ? '#ffffff' : '#526174';
      c.lineWidth = isSelected ? 4 : 2;
      c.strokeRect(imageX, imageY, imageWidth, imageHeight);
      c.font = `18px ${launcherFont}`;
      c.fillStyle = isSelected ? '#10151d' : '#e8edf3';
      c.textAlign = 'center';
      c.fillText(truncateText(c, displayName(game, catalog), colWidth - 18), cellX + colWidth / 2, imageY + 243);
      c.textAlign = 'left';
    }
    c.font = `16px ${launcherFont}`;
    c.fillStyle = '#7f8b9b';
    c.textAlign = 'right';
    c.fillText(`${pageStart + 1}-${Math.min(pageStart + 10, games.length)} / ${games.length}`, 1224, 651);
    c.textAlign = 'left';
  };

  const drawExitModal = () => {
    c.fillStyle = 'rgba(0,0,0,0.68)';
    c.fillRect(0, 0, WIDTH, HEIGHT);
    const x = 360;
    const y = 220;
    const w = 560;
    const h = 270;
    c.fillStyle = '#17202b';
    c.fillRect(x, y, w, h);
    c.strokeStyle = '#d9e6ff';
    c.lineWidth = 3;
    c.strokeRect(x, y, w, h);
    c.fillStyle = '#ffffff';
    c.font = `30px ${launcherFont}`;
    c.textAlign = 'center';
    c.fillText('종료하시겠습니까?', WIDTH / 2, y + 72);

    const buttonY = y + 125;
    const buttonW = 170;
    const buttonH = 62;
    const yesX = WIDTH / 2 - 190;
    const noX = WIDTH / 2 + 20;
    const drawButton = (bx: number, label: string, selectedButton: boolean) => {
      c.fillStyle = selectedButton ? '#d9e6ff' : '#283545';
      c.fillRect(bx, buttonY, buttonW, buttonH);
      c.fillStyle = selectedButton ? '#10151d' : '#ffffff';
      c.font = `25px ${launcherFont}`;
      c.fillText(label, bx + buttonW / 2, buttonY + 40);
    };
    drawButton(yesX, '예', exitYes);
    drawButton(noX, '아니오', !exitYes);
    c.font = `17px ${launcherFont}`;
    c.fillStyle = '#9da8b6';
    c.fillText('←/→ 선택     A 결정     B 취소', WIDTH / 2, y + 232);
    c.textAlign = 'left';
  };

  const redraw = () => {
    drawHeader();
    if (viewMode === 'list') drawList();
    else drawGrid();

    c.font = `18px ${launcherFont}`;
    c.fillStyle = '#9da8b6';
    c.fillText(
      viewMode === 'list'
        ? 'D-Pad: Select     A: Launch     Select(-): Thumbnail View     Start(+)+Select(-): Exit'
        : 'D-Pad: Move     A: Launch     Select(-): Text List     Start(+)+Select(-): Exit',
      48,
      696
    );
    if (exitModal) drawExitModal();

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    dirty = false;
  };

  log(`[launcher] showing ${games.length} games | gamelist=${catalog?.listPath || 'none'} | view=${viewMode}`);
  return await new Promise<GameInfo>((resolve) => {
    const frame = () => {
      const now = performance.now();
      const up = pressed(Button.Up);
      const down = pressed(Button.Down);
      const left = pressed(Button.Left);
      const right = pressed(Button.Right);
      const confirm = pressed(Button.A);
      const cancel = pressed(Button.B);
      const minus = pressed(Button.Minus);
      const plus = pressed(Button.Plus);
      const combo = minus && plus;

      if (!exitModal && !exitQueued) {
        if (combo) {
          minusTapCandidate = false;
          if (comboStartedAt === null) comboStartedAt = now;
          if (!comboLatched && now - comboStartedAt >= EXIT_COMBO_HOLD_MS) {
            comboLatched = true;
            exitModal = true;
            exitYes = false;
            dirty = true;
            log(`[launcher] Start+Select exit confirmation opened | hold=${Math.round(now - comboStartedAt)}ms`);
          }
        } else {
          comboStartedAt = null;
          if (!minus && !plus) comboLatched = false;
        }
      }

      if (exitModal) {
        if (left && !prevLeft) { exitYes = true; dirty = true; }
        if (right && !prevRight) { exitYes = false; dirty = true; }
        if ((up && !prevUp) || (down && !prevDown)) { exitYes = !exitYes; dirty = true; }
        if (cancel && !prevCancel) {
          exitModal = false;
          exitYes = false;
          dirty = true;
          log('[launcher] exit confirmation cancelled');
        } else if (confirm && !prevConfirm) {
          if (!exitYes) {
            exitModal = false;
            dirty = true;
            log('[launcher] exit confirmation -> no');
          } else if (!exitQueued) {
            exitQueued = true;
            log('[launcher] exit confirmation -> yes');
            setTimeout(() => {
              try { Switch.exit(); }
              catch (error) {
                exitQueued = false;
                exitModal = false;
                dirty = true;
                log(`[launcher] exit FAILED | ${String(error)}`);
                requestAnimationFrame(frame);
              }
            }, 80);
            return;
          }
        }
      } else {
        if (minus && !prevMinus && !plus) minusTapCandidate = true;
        if (combo) minusTapCandidate = false;
        if (!minus && prevMinus) {
          if (minusTapCandidate && !plus) {
            viewMode = viewMode === 'list' ? 'grid' : 'list';
            dirty = true;
            log(`[launcher] view changed -> ${viewMode}`);
          }
          minusTapCandidate = false;
        }

        if (!combo) {
          if (viewMode === 'list') {
            if (up && !prevUp) { selected = wrapIndex(selected - 1); dirty = true; }
            if (down && !prevDown) { selected = wrapIndex(selected + 1); dirty = true; }
          } else {
            if (left && !prevLeft) { selected = wrapIndex(selected - 1); dirty = true; }
            if (right && !prevRight) { selected = wrapIndex(selected + 1); dirty = true; }
            if (up && !prevUp) { selected = wrapIndex(selected - 5); dirty = true; }
            if (down && !prevDown) { selected = wrapIndex(selected + 5); dirty = true; }
          }
        }

        if (confirm && !prevConfirm && !combo) {
          const game = games[selected];
          log(`[launcher] selected | index=${selected} folder=${game.name} display=${displayName(game, catalog)} engine=${game.engine}`);
          cleanup();
          resolve(game);
          return;
        }
      }

      prevUp = up;
      prevDown = down;
      prevLeft = left;
      prevRight = right;
      prevConfirm = confirm;
      prevCancel = cancel;
      prevMinus = minus;

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
