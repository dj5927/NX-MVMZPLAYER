import type { RuntimeContext } from '../types';

export function installMZStandaloneHostPump(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  if (g.__mvmzMzStandalonePumpHandle) return;
  const raf = g.__mvmzHostRequestAnimationFrame || g.requestAnimationFrame?.bind(g);
  const critical = (message: string) => {
    ctx.log(message);
    try { ctx.flushLog?.(); } catch {}
  };
  if (typeof raf !== 'function') {
    critical('[mz-gfx] standalone host RAF unavailable');
    return;
  }

  let callbacks = 0;
  let activeFrames = 0;
  let lastSceneName = '';
  const frame = (_timestamp?: number) => {
    callbacks++;
    if (callbacks === 1) critical('[mz-gfx] standalone host RAF callback');

    if (g.__mvmzMzStandaloneLoopEnabled) {
      const graphics = g.Graphics;
      const app = graphics?._app;
      if (graphics && app) {
        const first = activeFrames === 0;
        try {
          if (first) {
            critical(`[mz-gfx] frame1 ticker ENTER | scene=${g.SceneManager?._scene?.constructor?.name ?? 'none'} next=${g.SceneManager?._nextScene?.constructor?.name ?? 'none'} listeners=${Number(app.ticker?.count ?? 0)}`);
          }
          // Do not call Graphics._tickHandler/app.render separately. MZ's
          // actual PIXI.Application loop advances the shared ticker, whose
          // Graphics._onTick listener performs SceneManager update + render.
          // Plugins are allowed to attach additional ticker listeners; running
          // only _tickHandler leaves those callbacks frozen and can leave
          // fades/filters/title-map overlays permanently black.
          if (typeof app.ticker?.update === 'function') {
            app.ticker.update(performance.now());
          } else if (typeof graphics._onTick === 'function') {
            graphics._onTick(1);
          }
          if (first) {
            critical(`[mz-gfx] frame1 ticker EXIT | scene=${g.SceneManager?._scene?.constructor?.name ?? 'none'} next=${g.SceneManager?._nextScene?.constructor?.name ?? 'none'}`);
          }
        } catch (error) {
          g.__mvmzMzStandaloneLoopEnabled = false;
          critical(`[mz-gfx] ticker update FAILED | ${String((error as any)?.stack ?? error)}`);
        }

        activeFrames++;
        if (activeFrames === 1 && g.__mvmzMzStandaloneLoopEnabled) {
          critical(`[mz-gfx] standalone first frame complete | scene=${g.SceneManager?._scene?.constructor?.name ?? 'none'}`);
        }
        if (g.__mvmzMzStandaloneLoopEnabled) {
          const sceneName = String(g.SceneManager?._scene?.constructor?.name ?? 'none');
          const sceneChanged = sceneName !== lastSceneName;
          if (sceneChanged || activeFrames % 120 === 0) {
            lastSceneName = sceneName;
            try {
              const gl = app.renderer?.gl;
              if (gl?.readPixels) {
                const px = new Uint8Array(4);
                const x = Math.max(0, Math.floor(Number(gl.drawingBufferWidth || 1) / 2));
                const y = Math.max(0, Math.floor(Number(gl.drawingBufferHeight || 1) / 2));
                const beforeError = Number(gl.getError?.() || 0);
                gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                const afterError = Number(gl.getError?.() || 0);
                const viewport = Array.from(gl.getParameter?.(gl.VIEWPORT) ?? []).map(Number);
                const fit = g.__mvmzViewportFit;
                const present = fit ? `${Number(fit.x)},${Number(fit.y)},${Number(fit.width)}x${Number(fit.height)}` : 'none';
                critical(`[mz-gfx] framebuffer sample | reason=${sceneChanged ? 'scene' : 'periodic'} scene=${sceneName} center=${px[0]},${px[1]},${px[2]},${px[3]} viewport=${viewport.join(',')} present=${present} glBefore=${beforeError} glAfter=${afterError}`);
              }
            } catch (error) {
              ctx.log(`[mz-gfx] framebuffer sample unavailable | ${String(error)}`);
            }
          }
        }
      }
    }

    g.__mvmzMzStandalonePumpHandle = raf(frame);
  };

  g.__mvmzMzStandalonePumpHandle = raf(frame);
  critical('[mz-gfx] standalone host RAF pump installed');
}
