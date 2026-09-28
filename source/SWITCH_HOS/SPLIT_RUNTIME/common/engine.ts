import { installDomCompat } from '../../UNIVERSAL_PLAYER/src/compat/dom';
import { ResourceFS } from '../../UNIVERSAL_PLAYER/src/host/fs';
import { RuntimeLogger } from '../../UNIVERSAL_PLAYER/src/host/log';
import { makeFileXMLHttpRequest } from '../../UNIVERSAL_PLAYER/src/host/xhr';
import { installImagePathBridge } from '../../UNIVERSAL_PLAYER/src/host/images';
import { installPointerBridge } from '../../UNIVERSAL_PLAYER/src/host/pointer';
import { ScriptLoader } from '../../UNIVERSAL_PLAYER/src/host/scripts';
import { bootMv } from '../../UNIVERSAL_PLAYER/src/engine/mv';
import { bootMz } from '../../UNIVERSAL_PLAYER/src/engine/mz';
import type { EngineKind, GameInfo, RuntimeContext } from '../../UNIVERSAL_PLAYER/src/types';

const ROOT = 'sdmc:/mvmz';
const LOG_ROOT = ROOT + '/_logs';
const RUNTIME_ROOT = ROOT + '/_runtime';
const HANDOFF_PATH = RUNTIME_ROOT + '/launch.json';

function dirname(path: string) {
  return String(path).replace(/\\/g, '/').replace(/\/[^/]+$/, '');
}

function safeName(name: string) {
  return String(name || 'game').replace(/[\\/:*?"<>|]/g, '_').trim() || 'game';
}

function gameId(text: string) {
  return encodeURIComponent(String(text).normalize('NFKC')).slice(0, 180) || 'game';
}

function buttonDown(index: number) {
  const pad = navigator.getGamepads()[0];
  return !!pad?.buttons[index]?.pressed;
}

function readHandoff() {
  const raw = Switch.readFileSync(HANDOFF_PATH);
  if (!raw) throw new Error('empty handoff');
  return JSON.parse(new TextDecoder().decode(raw));
}

function launchMainLauncher(log: (message: string) => void, logger: RuntimeLogger) {
  const ownPath = String(Switch.argv[0] || 'sdmc:/switch/MVMZ_HOS/engine.nro');
  const runtimeDir = dirname(ownPath);
  const target = `${dirname(runtimeDir)}/MVMZ_Launcher.nro`;
  log(`[split] chain-load -> ${target}`);
  try { logger.flush(); } catch {}
  const app = new Switch.Application(target);
  app.launch();
}

export async function runEngine(expectedEngine: EngineKind, playerVersion = '0.3.0') {
  Switch.mkdirSync(ROOT);
  Switch.mkdirSync(LOG_ROOT);
  Switch.mkdirSync(RUNTIME_ROOT);

  let handoff: any;
  try {
    handoff = readHandoff();
  } catch (error) {
    throw new Error(`Launch handoff unavailable: ${HANDOFF_PATH} | ${String(error)}`);
  }
  const dataRoot = String(handoff?.dataRoot || '');
  const gameRoot = String(handoff?.root || dataRoot);
  const name = String(handoff?.name || gameRoot.split('/').filter(Boolean).pop() || dataRoot.split('/').filter(Boolean).pop() || expectedEngine);
  const id = String(handoff?.id || gameId(name));
  const logPath = `${LOG_ROOT}/${safeName(name)}.log`;
  const logger = new RuntimeLogger(logPath);
  const log = logger.log;

  log(`MVMZ Split ${expectedEngine} Player v${playerVersion} starting`);
  log(`argv=${JSON.stringify(Switch.argv)}`);
  log(`HANDOFF | ${JSON.stringify(handoff)}`);
  log(`GAME LOG | ${logPath}`);
  log(`SELECTED GAME | name=${name} engine=${expectedEngine} root=${dataRoot} saveId=${id}`);
  logger.flush();

  if (!dataRoot) throw new Error(`Missing game data root in ${HANDOFF_PATH}`);
  if (handoff?.engine && handoff.engine !== expectedEngine) {
    throw new Error(`Engine handoff mismatch: expected=${expectedEngine} actual=${handoff.engine}`);
  }
  const expectedCore = expectedEngine === 'MV' ? 'js/rpg_core.js' : 'js/rmmz_core.js';
  try {
    if (Switch.statSync(`${dataRoot}/${expectedCore}`) === null) {
      throw new Error(`Expected ${expectedEngine} core missing: ${expectedCore}`);
    }
  } catch (error) {
    throw new Error(`Invalid ${expectedEngine} game root ${dataRoot}: ${String(error)}`);
  }

  const game: GameInfo = { name, root: gameRoot, dataRoot, engine: expectedEngine, id };
  const rawGl = screen.getContext('webgl2');
  if (!rawGl) throw new Error('WebGL2 context creation failed');
  log('WebGL2 renderer=' + rawGl.getParameter(rawGl.RENDERER) + ' vendor=' + rawGl.getParameter(rawGl.VENDOR));
  logger.flush();

  const fs = new ResourceFS(dataRoot, log);
  const dom = installDomCompat(rawGl, log);
  const g: any = globalThis as any;
  installPointerBridge(log);
  const NativeXHR = g.XMLHttpRequest;
  g.XMLHttpRequest = makeFileXMLHttpRequest(fs, log, NativeXHR);
  installImagePathBridge(fs, log);
  g.location.href = dataRoot + '/index.html';
  g.location.pathname = dataRoot + '/index.html';

  const scripts = new ScriptLoader(fs, log, expectedEngine === 'MV' ? 'mv-batch' : 'legacy');
  const ctx: RuntimeContext = {
    game,
    log,
    fs,
    gl: dom.gl,
    glStats: dom.glStats,
    standaloneEngine: true,
    flushLog: () => logger.flush(),
    mvWarmBudgetMP: expectedEngine === 'MV' ? 6 : undefined,
    mvWarmMaxAssets: expectedEngine === 'MV' ? 8 : undefined,
    mvWarmBackgroundMax: expectedEngine === 'MV' ? 0 : undefined
  };
  logger.flush();

  if (expectedEngine === 'MV') await bootMv(ctx, scripts);
  else await bootMz(ctx, scripts);

  log('CONTROLS | B=OK A=Cancel X=Menu L=PageUp R=PageDown RightStick=Mouse ZL=LeftClick ZR=RightClick Touch=Mouse Plus+Minus=Launcher');
  logger.flush();

  let lastScene = '';
  let lastExitCombo = false;
  setInterval(() => {
    const scene = g.SceneManager?._scene?.constructor?.name ?? 'none';
    if (scene !== lastScene) {
      lastScene = scene;
      log('SCENE | ' + scene);
    }
    const exitCombo = buttonDown(8) && buttonDown(9);
    if (exitCombo && !lastExitCombo) launchMainLauncher(log, logger);
    lastExitCombo = exitCombo;
  }, 100);

  let lastFrameCount = Number(g.Graphics?.frameCount ?? 0);
  let lastFpsTime = Date.now();
  let lastForcedGc = 0;
  let mvPressureMode = 'normal';
  setInterval(() => {
    const now = Date.now();
    const frameCount = Number(g.Graphics?.frameCount ?? 0);
    const elapsed = Math.max(1, now - lastFpsTime);
    const fps = ((frameCount - lastFrameCount) * 1000 / elapsed).toFixed(1);
    lastFrameCount = frameCount;
    lastFpsTime = now;
    const items = g.ImageManager?._imageCache?._items || {};
    const cacheKeys = Object.keys(items);
    let cachePixels = 0;
    for (const key of cacheKeys) {
      const bitmap = items[key]?.bitmap;
      cachePixels += Number(bitmap?.width || 0) * Number(bitmap?.height || 0);
    }
    let memSnapshot: any = null;
    let memory = '';
    try {
      memSnapshot = Switch.memoryUsage();
      const mib = (value: number) => (Number(value || 0) / 1048576).toFixed(1);
      memory = ` heapMiB=${mib(memSnapshot.usedHeapSize)} externalMiB=${mib(memSnapshot.externalMemory)} nativeMiB=${mib(memSnapshot.nativeHeapUsed)}/${mib(memSnapshot.nativeHeapTotal)}`;
    } catch {}
    log(`HEARTBEAT scene=${g.SceneManager?._scene?.constructor?.name ?? 'none'} fps=${fps} cache=${cacheKeys.length} cacheMP=${(cachePixels / 1e6).toFixed(1)}${memory}`);
    try { logger.flush(); } catch {}

    if (memSnapshot) {
      const total = Number(memSnapshot.nativeHeapTotal || 0);
      const used = Number(memSnapshot.nativeHeapUsed || 0);
      const ratio = total > 0 ? used / total : 0;
      if (expectedEngine === 'MV') {
        const softHighWater = 850 * 1024 * 1024;
        const hardHighWater = 1000 * 1024 * 1024;
        const recoverWater = 750 * 1024 * 1024;
        const baseLimit = Number(g.__mvmzMvBaseImageCacheLimit || g.ImageCache?.limit || 0);
        const hardLimit = baseLimit > 0 ? Math.min(baseLimit, 10 * 1e6) : 10 * 1e6;
        if ((used >= hardHighWater || ratio >= 0.35) && now - lastForcedGc >= 4000) {
          lastForcedGc = now;
          if (g.ImageCache && Number(g.ImageCache.limit || 0) !== hardLimit) {
            const oldLimit = Number(g.ImageCache.limit || 0);
            g.ImageCache.limit = hardLimit;
            log(`[mem] MV HARD pressure cache cap -> ${(hardLimit / 1e6).toFixed(0)}MP (old=${(oldLimit / 1e6).toFixed(1)}MP)`);
          }
          mvPressureMode = 'hard';
          log(`[mem] MV HARD pressure usedMiB=${(used / 1048576).toFixed(1)} ratio=${(ratio * 100).toFixed(1)}% -> trim + textureGC + V8 GC`);
          try { g.ImageManager?._imageCache?._truncateCache?.(); } catch {}
          try { g.Graphics?.callGC?.(); } catch {}
          try { if (typeof g.gc === 'function') g.gc(); } catch {}
          try { logger.flush(); } catch {}
        } else if (used >= softHighWater && mvPressureMode === 'normal' && now - lastForcedGc >= 1000) {
          lastForcedGc = now;
          mvPressureMode = 'soft';
          log(`[mem] MV soft pressure usedMiB=${(used / 1048576).toFixed(1)} ratio=${(ratio * 100).toFixed(1)}% -> textureGC + V8 GC (cache retained)`);
          try { g.Graphics?.callGC?.(); } catch {}
          try { if (typeof g.gc === 'function') g.gc(); } catch {}
          try { logger.flush(); } catch {}
        } else if (used <= recoverWater && mvPressureMode !== 'normal') {
          if (g.ImageCache && baseLimit > 0 && Number(g.ImageCache.limit || 0) !== baseLimit) {
            g.ImageCache.limit = baseLimit;
            log(`[mem] MV recovered usedMiB=${(used / 1048576).toFixed(1)} -> cache restored ${(baseLimit / 1e6).toFixed(0)}MP`);
          }
          mvPressureMode = 'normal';
        }
      } else if (ratio >= 0.65 && now - lastForcedGc >= 5000) {
        lastForcedGc = now;
        log(`[mem] high-water engine=${expectedEngine} usedMiB=${(used / 1048576).toFixed(1)} ratio=${(ratio * 100).toFixed(1)}% -> trim + textureGC + V8 GC`);
        try { g.ImageManager?._imageCache?._truncateCache?.(); } catch {}
        try { g.Graphics?.callGC?.(); } catch {}
        try { if (typeof g.gc === 'function') g.gc(); } catch {}
        try { logger.flush(); } catch {}
      }
    }
  }, 1000);
}

export function reportFatal(error: any) {
  try {
    Switch.mkdirSync(ROOT);
    Switch.mkdirSync(LOG_ROOT);
    Switch.mkdirSync(RUNTIME_ROOT);
    let name = 'engine';
    try { name = String(readHandoff()?.name || name); } catch {}
    const logger = new RuntimeLogger(`${LOG_ROOT}/${safeName(name)}.log`);
    logger.log('FATAL | ' + String(error) + '\n' + (error?.stack ?? ''));
    logger.flush();
  } catch {}
}

