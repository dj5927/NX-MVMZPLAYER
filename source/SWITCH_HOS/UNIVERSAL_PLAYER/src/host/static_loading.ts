import type { LogFn } from '../types';

function vec4(value: any, fallback: number[]) {
  try {
    if (value && typeof value.length === 'number' && value.length >= 4) {
      return [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
    }
  } catch {}
  return fallback.slice();
}

export function drawStaticLoadingBar(gl: any, engine: string, gameName: string, log: LogFn) {
  try {
    const width = Math.max(1, Number(gl.drawingBufferWidth || 1280));
    const height = Math.max(1, Number(gl.drawingBufferHeight || 720));
    const oldViewport = vec4(gl.getParameter?.(gl.VIEWPORT), [0, 0, width, height]);
    const oldScissor = vec4(gl.getParameter?.(gl.SCISSOR_BOX), [0, 0, width, height]);
    const oldClear = vec4(gl.getParameter?.(gl.COLOR_CLEAR_VALUE), [0, 0, 0, 1]);
    const oldScissorEnabled = !!gl.isEnabled?.(gl.SCISSOR_TEST);

    const clearRect = (x: number, y: number, w: number, h: number, r: number, g: number, b: number, a = 1) => {
      gl.scissor(Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y)), Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)));
      gl.clearColor(r, g, b, a);
      gl.clear(gl.COLOR_BUFFER_BIT);
    };

    gl.viewport(0, 0, width, height);
    gl.enable(gl.SCISSOR_TEST);
    clearRect(0, 0, width, height, 0.035, 0.047, 0.063, 1);

    const trackW = Math.round(width * 0.58);
    const trackH = Math.max(18, Math.round(height * 0.027));
    const trackX = Math.round((width - trackW) * 0.5);
    const trackY = Math.round(height * 0.16);
    clearRect(trackX - 2, trackY - 2, trackW + 4, trackH + 4, 0.30, 0.34, 0.40, 1);
    clearRect(trackX, trackY, trackW, trackH, 0.10, 0.13, 0.17, 1);

    // Fixed indeterminate segment. It is intentionally not labeled with a
    // fake percentage. The frame is drawn exactly once before game scripts.
    const segmentW = Math.round(trackW * 0.34);
    const segmentX = trackX + Math.round((trackW - segmentW) * 0.5);
    clearRect(segmentX, trackY + 2, segmentW, Math.max(1, trackH - 4), 0.82, 0.88, 0.97, 1);

    gl.clearColor(oldClear[0], oldClear[1], oldClear[2], oldClear[3]);
    gl.viewport(oldViewport[0], oldViewport[1], oldViewport[2], oldViewport[3]);
    gl.scissor(oldScissor[0], oldScissor[1], oldScissor[2], oldScissor[3]);
    if (!oldScissorEnabled) gl.disable(gl.SCISSOR_TEST);
    try { gl.flush?.(); } catch {}
    log(`[loading] static boot bar drawn | engine=${engine} game=${gameName} size=${width}x${height}`);
  } catch (error) {
    log(`[loading] static boot bar FAILED | ${String(error)}`);
  }
}

export async function presentStaticLoadingFrame() {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, 34);
    try {
      requestAnimationFrame(() => {
        clearTimeout(timer);
        finish();
      });
    } catch {}
  });
}

