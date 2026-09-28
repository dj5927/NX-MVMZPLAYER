import { RuntimeLogger } from '../../../UNIVERSAL_PLAYER/src/host/log';
import { scanGames } from '../../../UNIVERSAL_PLAYER/src/host/discovery';
import { selectGame } from '../../../UNIVERSAL_PLAYER/src/launcher';

const ROOT = 'sdmc:/mvmz';
const LOG_ROOT = ROOT + '/_logs';
const RUNTIME_ROOT = ROOT + '/_runtime';
const HANDOFF_PATH = RUNTIME_ROOT + '/launch.json';

function dirname(path: string) {
  return String(path).replace(/\\/g, '/').replace(/\/[^/]+$/, '');
}

async function main() {
  Switch.mkdirSync(ROOT);
  Switch.mkdirSync(LOG_ROOT);
  Switch.mkdirSync(RUNTIME_ROOT);
  const logger = new RuntimeLogger(`${LOG_ROOT}/launcher.log`);
  const log = logger.log;
  log('MVMZ Split Launcher v0.4.0 starting');
  log('argv=' + JSON.stringify(Switch.argv));
  logger.flush();

  const games = scanGames(ROOT, log);
  for (const game of games) log(`Detected game: ${game.name} | engine=${game.engine} | dataRoot=${game.dataRoot}`);
  if (!games.length) throw new Error(`No MV/MZ games found under ${ROOT}`);

  const rawGl = screen.getContext('webgl2');
  if (!rawGl) throw new Error('WebGL2 context creation failed');
  log('WebGL2 renderer=' + rawGl.getParameter(rawGl.RENDERER) + ' vendor=' + rawGl.getParameter(rawGl.VENDOR));

  const game = await selectGame(rawGl, games, log);
  const suiteDir = dirname(String(Switch.argv[0] || 'sdmc:/switch/MVMZ_HOS/MVMZ_Launcher.nro'));
  const targetName = game.engine === 'MV' ? 'MVMZ_MV_Player.nro' : 'MVMZ_MZ_Player.nro';
  const target = `${suiteDir}/runtime/${targetName}`;
  log(`[split] launch ${game.engine} | ${target} | ${game.dataRoot}`);
  const handoff = {
    version: 3,
    engine: game.engine,
    root: game.root,
    dataRoot: game.dataRoot,
    name: game.name,
    id: game.id
  };
  Switch.writeFileSync(HANDOFF_PATH, JSON.stringify(handoff));
  log(`[split] handoff -> ${HANDOFF_PATH} | ${JSON.stringify(handoff)}`);
  logger.flush();

  const app = new Switch.Application(target);
  app.launch();
}

main().catch(error => {
  try {
    const logger = new RuntimeLogger(`${LOG_ROOT}/launcher.log`);
    logger.log('FATAL | ' + String(error) + '\n' + ((error as any)?.stack ?? ''));
    logger.flush();
  } catch {}
});
