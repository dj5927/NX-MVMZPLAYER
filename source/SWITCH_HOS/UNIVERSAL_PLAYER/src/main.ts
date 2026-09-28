import { installDomCompat } from './compat/dom';
import { ResourceFS } from './host/fs';
import { RuntimeLogger } from './host/log';
import { scanGames } from './host/discovery';
import { makeFileXMLHttpRequest } from './host/xhr';
import { installImagePathBridge } from './host/images';
import { ScriptLoader } from './host/scripts';
import { bootMv } from './engine/mv';
import { bootMz } from './engine/mz';
import type { RuntimeContext } from './types';
import { selectGame } from './launcher';

const ROOT = 'sdmc:/mvmz';
const GAMES_ROOT = ROOT;
const LOG_ROOT = ROOT + '/_logs';
const LAUNCHER_LOG_PATH = LOG_ROOT + '/launcher.log';
let activeLogger: RuntimeLogger | null = null;
let exitQueued = false;

function gameLogPath(name: string) {
  const safe = String(name || 'game').replace(/[\\/:*?"<>|]/g, '_').trim() || 'game';
  return `${LOG_ROOT}/${safe}.log`;
}

function requestSafeExit(log: (message: string) => void, logger?: RuntimeLogger | null) {
  if (exitQueued) return;
  exitQueued = true;
  log('Exit requested by Plus+Minus');
  try { logger?.flush(); } catch {}
  setTimeout(() => {
    try { Switch.exit(); }
    catch (error) {
      exitQueued = false;
      log('Exit FAILED | ' + String(error));
      try { logger?.flush(); } catch {}
    }
  }, 80);
}

function buttonDown(index: number) {
  const pad = navigator.getGamepads()[0];
  return !!pad?.buttons[index]?.pressed;
}

async function main() {
  Switch.mkdirSync(ROOT);
  Switch.mkdirSync(LOG_ROOT);
  const logger = new RuntimeLogger(LAUNCHER_LOG_PATH);
  activeLogger = logger;
  const log = logger.log;
  log('MVMZ HOS Universal Player v1.0.10 starting');
  log('cwd=' + Switch.cwd());

  const games = scanGames(GAMES_ROOT, log);
  for (const game of games) {
    log('Detected game: ' + game.name + ' | engine=' + game.engine + ' | dataRoot=' + game.dataRoot);
  }
  if (!games.length) throw new Error('No MV/MZ games found under ' + GAMES_ROOT);

  const rawGl = screen.getContext('webgl2');
  if (!rawGl) throw new Error('WebGL2 context creation failed');
  log('WebGL2 renderer=' + rawGl.getParameter(rawGl.RENDERER) + ' vendor=' + rawGl.getParameter(rawGl.VENDOR));

  const game = await selectGame(rawGl, games, log);
  logger.switchPath(gameLogPath(game.name));
  log('MVMZ HOS Universal Player v1.0.10 starting');
  log('cwd=' + Switch.cwd());
  log('GAME LOG | ' + gameLogPath(game.name));
  log('SELECTED GAME | name=' + game.name + ' engine=' + game.engine + ' root=' + game.dataRoot + ' saveId=' + game.id);

  const fs = new ResourceFS(game.dataRoot, log);

  const dom = installDomCompat(rawGl, log);
  const g: any = globalThis as any;
  const NativeXHR = g.XMLHttpRequest;
  g.XMLHttpRequest = makeFileXMLHttpRequest(fs, log, NativeXHR);
  installImagePathBridge(fs, log);
  g.location.href = game.dataRoot + '/index.html';
  g.location.pathname = game.dataRoot + '/index.html';

  const scripts = new ScriptLoader(fs, log, game.engine === 'MV' ? 'mv-batch' : 'legacy');
  const ctx: RuntimeContext = { game, log, fs, gl: dom.gl, glStats: dom.glStats };

  if (game.engine === 'MV') await bootMv(ctx, scripts);
  else await bootMz(ctx, scripts);

  log('CONTROLS | B=OK A=Cancel X=Menu L=PageUp R=PageDown Plus+Minus=Exit');

  let lastScene = '';
  let lastExitCombo = false;
  setInterval(() => {
    const scene = g.SceneManager?._scene?.constructor?.name ?? 'none';
    if (scene !== lastScene) {
      lastScene = scene;
      log('SCENE | ' + scene);
    }
    const minus = buttonDown(8);
    const plus = buttonDown(9);
    const exitCombo = minus && plus;
    if (exitCombo && !lastExitCombo) {
      requestSafeExit(log, logger);
    }
    lastExitCombo = exitCombo;
  }, 100);

  let lastFrameCount = Number(g.Graphics?.frameCount ?? 0);
  let lastFpsTime = Date.now();
  let lastForcedGc = 0;
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
    let cacheReserved = 0;
    for (const key of cacheKeys) {
      const item = items[key];
      const bitmap = item?.bitmap;
      cachePixels += Number(bitmap?.width || 0) * Number(bitmap?.height || 0);
      if (item?.reservationId) cacheReserved++;
    }
    let memory = '';
    let memSnapshot: any = null;
    try {
      const mem = Switch.memoryUsage();
      memSnapshot = mem;
      const mib = (value: number) => (value / 1048576).toFixed(1);
      memory = ' heapMiB=' + mib(mem.usedHeapSize) +
        ' externalMiB=' + mib(mem.externalMemory) +
        ' nativeMiB=' + mib(mem.nativeHeapUsed) + '/' + mib(mem.nativeHeapTotal);
    } catch {}
    log('HEARTBEAT scene=' + (g.SceneManager?._scene?.constructor?.name ?? 'none') +
      ' fps=' + fps +
      ' cache=' + cacheKeys.length +
      ' cacheMP=' + (cachePixels / 1000000).toFixed(1) +
      ' reserved=' + cacheReserved +
      ' translatedShaders=' + dom.glStats.translatedShaders +
      ' compileFailures=' + dom.glStats.compileFailures + memory);

    if (memSnapshot && now - lastForcedGc >= 15000) {
      const total = Number(memSnapshot.nativeHeapTotal || 0);
      const used = Number(memSnapshot.nativeHeapUsed || 0);
      const ratio = total > 0 ? used / total : 0;
      if (ratio >= 0.75) {
        lastForcedGc = now;
        const beforeMiB = (used / 1048576).toFixed(1);
        const totalMiB = (total / 1048576).toFixed(1);
        log(`[mem] high-water native=${beforeMiB}/${totalMiB}MiB ratio=${(ratio * 100).toFixed(1)}% -> trim + textureGC + V8 GC`);
        try { g.ImageManager?._imageCache?._truncateCache?.(); } catch {}
        try { g.Graphics?.callGC?.(); } catch {}
        try {
          const gc = (globalThis as any).gc;
          if (typeof gc === 'function') {
            gc();
            const after = Switch.memoryUsage();
            log(`[mem] forced GC complete | nativeMiB=${(Number(after.nativeHeapUsed || 0) / 1048576).toFixed(1)}/${(Number(after.nativeHeapTotal || 0) / 1048576).toFixed(1)} heapMiB=${(Number(after.usedHeapSize || 0) / 1048576).toFixed(1)} externalMiB=${(Number(after.externalMemory || 0) / 1048576).toFixed(1)}`);
          } else {
            log('[mem] forced GC unavailable | global gc() not exposed');
          }
        } catch (error) {
          log(`[mem] forced GC FAILED | ${String(error)}`);
        }
      }
    }
  }, 5000);
}

main().catch(error => {
  try {
    const line = '[' + new Date().toISOString() + '] FATAL | ' + String(error) + '\n' + ((error as any)?.stack ?? '');
    console.printErr(line + '\n');
    if (activeLogger) {
      activeLogger.log('FATAL | ' + String(error) + '\n' + ((error as any)?.stack ?? ''));
      activeLogger.flush();
    } else {
      Switch.mkdirSync(ROOT);
      Switch.mkdirSync(LOG_ROOT);
      Switch.writeFileSync(LAUNCHER_LOG_PATH, line + '\n');
    }
  } catch {}
});