import type { RuntimeContext } from '../types';

type PhaseKey =
  | 'input'
  | 'change'
  | 'scene'
  | 'render'
  | 'map'
  | 'events'
  | 'interpreter'
  | 'spriteset';

export function installMvSlowFrameProfiler(ctx: RuntimeContext) {
  const g: any = globalThis as any;
  const sm: any = g.SceneManager;
  if (!sm || sm.__mvmzSlowFrameProfiler) return;

  const now = () => Number(g.performance?.now?.() ?? Date.now());
  const phase: Record<PhaseKey, number> = {
    input: 0,
    change: 0,
    scene: 0,
    render: 0,
    map: 0,
    events: 0,
    interpreter: 0,
    spriteset: 0
  };
  const reset = () => {
    for (const key of Object.keys(phase) as PhaseKey[]) phase[key] = 0;
  };

  const wrapObjectMethod = (obj: any, name: string, key: PhaseKey) => {
    const original = obj?.[name];
    if (typeof original !== 'function' || original.__mvmzProfileWrapped) return;
    const wrapped = function(this: any, ...args: any[]) {
      const begin = now();
      try {
        return original.apply(this, args);
      } finally {
        phase[key] += Math.max(0, now() - begin);
      }
    };
    wrapped.__mvmzProfileWrapped = true;
    obj[name] = wrapped;
  };

  wrapObjectMethod(sm, 'updateInputData', 'input');
  wrapObjectMethod(sm, 'changeScene', 'change');
  wrapObjectMethod(sm, 'updateScene', 'scene');
  wrapObjectMethod(sm, 'renderScene', 'render');
  wrapObjectMethod(g.Game_Map?.prototype, 'update', 'map');
  wrapObjectMethod(g.Game_Map?.prototype, 'updateEvents', 'events');
  wrapObjectMethod(g.Game_Map?.prototype, 'updateInterpreter', 'interpreter');
  wrapObjectMethod(g.Spriteset_Map?.prototype, 'update', 'spriteset');

  const originalUpdateMain = sm.updateMain;
  if (typeof originalUpdateMain !== 'function') {
    ctx.log('[mv-prof] skipped | SceneManager.updateMain unavailable');
    return;
  }

  let lastEnd = now();
  let lastLog = 0;
  let logCount = 0;
  let suppressionLogged = false;

  sm.updateMain = function(this: any, ...args: any[]) {
    const start = now();
    const outsideMs = Math.max(0, start - lastEnd);
    reset();
    try {
      return originalUpdateMain.apply(this, args);
    } finally {
      const end = now();
      const mainMs = Math.max(0, end - start);
      lastEnd = end;

      const slow =
        outsideMs >= 40 ||
        mainMs >= 40 ||
        phase.scene >= 25 ||
        phase.render >= 25 ||
        phase.map >= 25 ||
        phase.events >= 20 ||
        phase.interpreter >= 20 ||
        phase.spriteset >= 25;
      if (!slow) return;

      const urgent = outsideMs >= 100 || mainMs >= 100;
      if (!urgent && end - lastLog < 120) return;
      if (logCount >= 180) {
        if (!suppressionLogged) {
          suppressionLogged = true;
          ctx.log('[mv-prof] slow-frame log budget exhausted');
          try { ctx.flushLog?.(); } catch {}
        }
        return;
      }
      logCount++;
      lastLog = end;

      let pending = 0;
      const pendingUrls: string[] = [];
      try {
        const items = g.ImageManager?._imageCache?._items || {};
        for (const key of Object.keys(items)) {
          const bitmap = items[key]?.bitmap;
          const state = String(bitmap?._loadingState || '');
          if (state === 'requesting' || state === 'decrypting' || state === 'requestCompleted') {
            pending++;
            if (pendingUrls.length < 3) pendingUrls.push(String(bitmap?._url || key));
          }
        }
      } catch {}

      let memory = '';
      try {
        const mem = Switch.memoryUsage();
        const mib = (value: number) => (Number(value || 0) / 1048576).toFixed(1);
        memory = ` native=${mib(mem.nativeHeapUsed)}/${mib(mem.nativeHeapTotal)}MiB external=${mib(mem.externalMemory)}MiB`;
      } catch {}

      const logicMs = Math.max(phase.scene, phase.map, phase.events, phase.interpreter);
      let kind = 'mixed';
      if (outsideMs >= Math.max(40, mainMs * 1.5)) kind = 'outside/native';
      else if (phase.render >= Math.max(25, logicMs * 1.25)) kind = 'render';
      else if (logicMs >= 25) kind = 'logic';

      const sceneName = String(g.SceneManager?._scene?.constructor?.name || 'none');
      const frame = Number(g.Graphics?.frameCount || 0);
      ctx.log(
        `[mv-prof] slow | kind=${kind} scene=${sceneName} frame=${frame}` +
        ` outsideMs=${outsideMs.toFixed(1)} mainMs=${mainMs.toFixed(1)}` +
        ` input=${phase.input.toFixed(1)} change=${phase.change.toFixed(1)}` +
        ` sceneUpdate=${phase.scene.toFixed(1)} render=${phase.render.toFixed(1)}` +
        ` map=${phase.map.toFixed(1)} events=${phase.events.toFixed(1)}` +
        ` interpreter=${phase.interpreter.toFixed(1)} spriteset=${phase.spriteset.toFixed(1)}` +
        ` pending=${pending} urls=${pendingUrls.join(',') || '-'}${memory}`
      );
      try { ctx.flushLog?.(); } catch {}
    }
  };

  sm.__mvmzSlowFrameProfiler = true;
  ctx.log('[mv-prof] V072 slow-frame profiler installed | slow>=40ms phase>=20-25ms no behavior changes');
}
