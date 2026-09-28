import type { EngineKind, GameInfo, LogFn } from '../types';

function exists(path: string) {
  try { return Switch.statSync(path) !== null; } catch { return false; }
}

function gameId(text: string) {
  return encodeURIComponent(String(text).normalize('NFKC')).slice(0, 180) || 'game';
}

export function detectEngineAt(root: string): { engine: EngineKind; dataRoot: string } | null {
  for (const candidate of [`${root}/game`, `${root}/www`, `${root}/data/www`, `${root}/data/game`, root]) {
    if (!exists(`${candidate}/index.html`)) continue;
    if (exists(`${candidate}/js/rmmz_core.js`)) return { engine: 'MZ', dataRoot: candidate };
    if (exists(`${candidate}/js/rpg_core.js`)) return { engine: 'MV', dataRoot: candidate };
  }
  return null;
}

export function scanGames(gamesRoot: string, log: LogFn): GameInfo[] {
  const games: GameInfo[] = [];
  let names: string[] = [];
  try { names = Switch.readDirSync(gamesRoot) ?? []; }
  catch (error) { log(`Game scan failed: ${String(error)}`); return games; }

  for (const name of names) {
    if (!name || name === '.' || name === '..') continue;
    const root = `${gamesRoot}/${name}`;
    const detected = detectEngineAt(root);
    if (!detected) continue;
    games.push({
      name,
      root,
      dataRoot: detected.dataRoot,
      engine: detected.engine,
      id: gameId(name)
    });
  }
  games.sort((a, b) => a.name.localeCompare(b.name));
  return games;
}
