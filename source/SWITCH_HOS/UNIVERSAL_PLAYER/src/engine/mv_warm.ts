import type { RuntimeContext } from '../types';

type WarmAsset = {
  kind: string;
  name: string;
  hue: number;
  priority: number;
  order: number;
  logical: string;
  pixels: number;
  source_bytes: number;
  source: string;
};

type AutoFingerprint = {
  stat_fnv1a32: string;
  files: number;
  total_bytes: number;
};

const encoder = new TextEncoder();

const folders: Record<string, string> = {
  animation: 'img/animations',
  battleback1: 'img/battlebacks1',
  battleback2: 'img/battlebacks2',
  character: 'img/characters',
  enemy: 'img/enemies',
  face: 'img/faces',
  parallax: 'img/parallaxes',
  picture: 'img/pictures',
  svactor: 'img/sv_actors',
  svenemy: 'img/sv_enemies',
  tileset: 'img/tilesets'
};

function fnv1a32Bytes(bytes: Uint8Array) {
  let value = 0x811c9dc5;
  for (const byte of bytes) {
    value ^= byte;
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

function fnv1a32Text(text: string) {
  return fnv1a32Bytes(encoder.encode(text));
}

function readJson(ctx: RuntimeContext, path: string, fallback: any) {
  try {
    return JSON.parse(ctx.fs.readText(path).replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function relevantDataFiles(ctx: RuntimeContext) {
  const fixed = new Set([
    'System.json', 'Animations.json', 'CommonEvents.json', 'Tilesets.json',
    'Troops.json', 'Enemies.json', 'Skills.json', 'MapInfos.json'
  ]);
  let names: string[] = [];
  try { names = (Switch.readDirSync(`${ctx.fs.root}/data`) ?? []).map(String); } catch {}
  return names
    .filter(name => fixed.has(name) || /^Map\d{3}\.json$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
}

function statFingerprint(ctx: RuntimeContext): AutoFingerprint {
  const parts: string[] = [];
  let total = 0;
  for (const name of relevantDataFiles(ctx)) {
    try {
      const stat = Switch.statSync(`${ctx.fs.root}/data/${name}`);
      if (!stat) continue;
      const size = Number(stat.size || 0);
      const mtime = Number(stat.mtime || 0);
      total += size;
      parts.push(`${name}:${size}:${mtime}`);
    } catch {}
  }
  return { stat_fnv1a32: fnv1a32Text(parts.join('|')), files: parts.length, total_bytes: total };
}

function sameAutoFingerprint(a: any, b: AutoFingerprint) {
  return !!a
    && String(a.stat_fnv1a32 || '') === b.stat_fnv1a32
    && Number(a.files || 0) === b.files
    && Number(a.total_bytes || 0) === b.total_bytes;
}

function estimatePixelsFromSourceBytes(bytes: number) {
  if (bytes <= 0) return 0;
  return Math.max(65536, Math.min(4194304, Math.floor(bytes * 4)));
}

function sourceSize(ctx: RuntimeContext, logical: string) {
  for (const candidate of [logical, `${logical}_`, logical.replace(/\.png$/i, '.rpgmvp')]) {
    try {
      const stat = Switch.statSync(ctx.fs.resolve(candidate));
      if (stat) return Number(stat.size || 0);
    } catch {}
  }
  return 0;
}

function compileMvManifest(ctx: RuntimeContext, autoFingerprint: AutoFingerprint) {
  const startedAt = Date.now();
  const animations = readJson(ctx, 'data/Animations.json', []);
  const commonEvents = readJson(ctx, 'data/CommonEvents.json', []);
  const tilesets = readJson(ctx, 'data/Tilesets.json', []);
  const troops = readJson(ctx, 'data/Troops.json', []);
  const enemies = readJson(ctx, 'data/Enemies.json', []);
  const skills = readJson(ctx, 'data/Skills.json', []);
  const system = readJson(ctx, 'data/System.json', {});
  const systemBytes = ctx.fs.readBuffer('data/System.json');
  const sideView = !!system?.optSideView;
  const mapFiles = relevantDataFiles(ctx).filter(name => /^Map\d{3}\.json$/i.test(name));
  const maps: Record<string, WarmAsset[]> = {};
  const assetMeta: Record<string, any> = {};
  let globalOrder = 0;

  for (let mapIndex = 0; mapIndex < mapFiles.length; mapIndex++) {
    const filename = mapFiles[mapIndex];
    const match = /Map(\d{3})\.json$/i.exec(filename);
    if (!match) continue;
    const mapId = Number(match[1]);
    const map = readJson(ctx, `data/${filename}`, {});
    const items = new Map<string, WarmAsset>();

    const add = (kind: string, name: any, hue = 0, priority = 1, source = 'map') => {
      const clean = String(name || '');
      const folder = folders[kind];
      if (!clean || !folder) return;
      const logical = `${folder}/${clean}.png`;
      const key = `${kind}|${clean}|${Number(hue || 0)}`;
      const bytes = sourceSize(ctx, logical);
      const estimatedPixels = estimatePixelsFromSourceBytes(bytes);
      const asset: WarmAsset = {
        kind, name: clean, hue: Number(hue || 0), priority: Number(priority || 0),
        order: globalOrder++, logical, pixels: estimatedPixels, source_bytes: bytes, source
      };
      const old = items.get(key);
      if (!old || asset.priority < old.priority || (asset.priority === old.priority && asset.order < old.order)) items.set(key, asset);
      const lower = logical.toLowerCase();
      if (!assetMeta[lower]) assetMeta[lower] = { logical, width: 0, height: 0, pixels: estimatedPixels, source_bytes: bytes, estimate: 'compressed-bytes-x4' };
    };

    const addAnimation = (id: any, priority = 1, source = 'animation') => {
      const animation = animations?.[Number(id || 0)];
      if (!animation) return;
      add('animation', animation.animation1Name, animation.animation1Hue || 0, priority, source);
      add('animation', animation.animation2Name, animation.animation2Hue || 0, priority, source);
    };

    const addTileset = (id: any, priority = 0, source = 'tileset') => {
      const tileset = tilesets?.[Number(id || 0)];
      for (const name of tileset?.tilesetNames || []) add('tileset', name, 0, priority, source);
    };

    const addSkill = (id: any, priority = 1, source = 'skill') => {
      const skill = skills?.[Number(id || 0)];
      if (!skill) return;
      const animationId = Number(skill.animationId || 0);
      if (animationId > 0) addAnimation(animationId, priority, source);
    };

    const scanMoveRoute = (route: any, priority = 1, source = 'move_route') => {
      for (const command of route?.list || []) {
        if (Number(command?.code || 0) === 41) add('character', command?.parameters?.[0], 0, priority, source);
      }
    };

    const addTroop = (id: any, priority = 1, source = 'troop') => {
      const troop = troops?.[Number(id || 0)];
      if (!troop) return;
      for (const member of troop.members || []) {
        const enemy = enemies?.[Number(member?.enemyId || 0)];
        if (!enemy) continue;
        add(sideView ? 'svenemy' : 'enemy', enemy.battlerName, enemy.battlerHue || 0, priority, source);
        for (const action of enemy.actions || []) addSkill(action?.skillId, priority, source);
      }
      for (const page of troop.pages || []) scanList(page?.list, priority + 1, 0, new Set<number>(), source);
    };

    const scanList = (list: any[], priority = 1, depth = 0, seenCommon = new Set<number>(), source = 'event') => {
      if (!Array.isArray(list)) return;
      for (const command of list) {
        const code = Number(command?.code || 0);
        const params = command?.parameters || [];
        if (code === 101) add('face', params[0], 0, priority, source);
        else if (code === 117 && depth < 3) {
          const id = Number(params[0] || 0);
          if (id && !seenCommon.has(id)) {
            seenCommon.add(id);
            scanList(commonEvents?.[id]?.list, priority + 1, depth + 1, seenCommon, `common:${id}`);
          }
        } else if (code === 205) scanMoveRoute(params[1], priority, source);
        else if (code === 212 || code === 337) addAnimation(params[1], priority, source);
        else if (code === 231) add('picture', params[1], 0, priority, source);
        else if (code === 282) addTileset(params[0], priority, source);
        else if (code === 283) {
          add('battleback1', params[0], 0, priority, source);
          add('battleback2', params[1], 0, priority, source);
        } else if (code === 284) add('parallax', params[0], 0, priority, source);
        else if (code === 301 && Number(params[0] || 0) === 0) addTroop(params[1], priority, source);
        else if (code === 322) {
          add('character', params[1], 0, priority, source);
          add('face', params[3], 0, priority, source);
          add('svactor', params[5], 0, priority, source);
        } else if (code === 323) add('character', params[1], 0, priority, source);
      }
    };

    addTileset(map.tilesetId, 0, 'map_base');
    add('parallax', map.parallaxName, 0, 0, 'map_base');
    if (map.specifyBattleback) {
      add('battleback1', map.battleback1Name, 0, 0, 'map_base');
      add('battleback2', map.battleback2Name, 0, 0, 'map_base');
    }
    for (const encounter of map.encounterList || []) addTroop(encounter?.troopId, 1, 'encounter');
    for (const event of map.events || []) {
      if (!event) continue;
      for (let pageIndex = 0; pageIndex < (event.pages || []).length; pageIndex++) {
        const page = event.pages[pageIndex];
        const image = page?.image || {};
        add('character', image.characterName, 0, 0, `event:${event.id}:page:${pageIndex}`);
        scanList(page?.list, 1, 0, new Set<number>(), `event:${event.id}:page:${pageIndex}`);
      }
    }

    maps[String(mapId)] = [...items.values()].sort((a, b) => a.priority - b.priority || a.order - b.order || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    if ((mapIndex + 1) % 25 === 0) ctx.log(`[mv-warm-compile] maps ${mapIndex + 1}/${mapFiles.length}`);
  }

  const manifest = {
    format: 'MVMZWARM',
    version: 1,
    engine: 'MV',
    generated_unix: Math.floor(Date.now() / 1000),
    generator: 'switch-first-run-v1',
    auto_fingerprint: autoFingerprint,
    game_fingerprint: {
      system_fnv1a32: fnv1a32Bytes(new Uint8Array(systemBytes)),
      system_bytes: systemBytes.byteLength
    },
    asset_meta: assetMeta,
    maps
  };
  const deps = Object.values(maps).reduce((sum, list) => sum + list.length, 0);
  ctx.log(`[mv-warm-compile] complete | maps=${Object.keys(maps).length} dependencies=${deps} assets=${Object.keys(assetMeta).length} elapsedMs=${Date.now() - startedAt}`);
  return manifest;
}

function writeManifest(ctx: RuntimeContext, manifest: any) {
  const dir = `${ctx.fs.root}/.mvmz_warm`;
  try { Switch.mkdirSync(dir); } catch {}
  ctx.fs.writeTextAbsolute(`${dir}/manifest.json`, JSON.stringify(manifest));
  ctx.fs.invalidate();
}

export function ensureMVWarmManifest(ctx: RuntimeContext) {
  const autoFingerprint = statFingerprint(ctx);
  let existing: any = null;
  try {
    if (ctx.fs.exists('.mvmz_warm/manifest.json')) existing = JSON.parse(ctx.fs.readText('.mvmz_warm/manifest.json'));
  } catch {}

  try {
    const systemBytes = ctx.fs.readBuffer('data/System.json');
    const currentSystemHash = fnv1a32Bytes(new Uint8Array(systemBytes));
    const existingSystem = existing?.game_fingerprint;
    const baseCompatible = existing?.format === 'MVMZWARM'
      && Number(existing?.version) === 1
      && (!existing?.engine || existing.engine === 'MV')
      && String(existingSystem?.system_fnv1a32 || '').toLowerCase() === currentSystemHash
      && Number(existingSystem?.system_bytes || 0) === systemBytes.byteLength;

    if (baseCompatible && existing?.generator !== 'switch-first-run-v1') {
      ctx.log(`[mv-warm] existing manual manifest retained | maps=${Object.keys(existing.maps || {}).length}`);
      return existing;
    }
    if (baseCompatible && existing?.generator === 'switch-first-run-v1' && sameAutoFingerprint(existing?.auto_fingerprint, autoFingerprint)) {
      ctx.log(`[mv-warm] auto manifest valid | maps=${Object.keys(existing.maps || {}).length} fingerprint=${autoFingerprint.stat_fnv1a32}`);
      return existing;
    }

    if (existing) ctx.log('[mv-warm] manifest stale/unsupported -> auto rebuild');
    else ctx.log('[mv-warm] first run -> auto compiling manifest');
    const built = compileMvManifest(ctx, autoFingerprint);
    writeManifest(ctx, built);
    ctx.log(`[mv-warm] auto manifest saved | path=.mvmz_warm/manifest.json bytes=${ctx.fs.readBuffer('.mvmz_warm/manifest.json').byteLength}`);
    return built;
  } catch (error) {
    ctx.log(`[mv-warm] auto manifest FAILED | ${String((error as any)?.stack ?? error)}`);
    return null;
  }
}

export function installMVWarmLearning(ctx: RuntimeContext, manifest: any) {
  const g: any = globalThis as any;
  if (!manifest || manifest?.generator !== 'switch-first-run-v1' || !g.ImageManager?.loadBitmap) return;
  const original = g.ImageManager.loadBitmap;
  if ((original as any).__mvmzWarmLearn) return;
  const reverseFolders = new Map(Object.entries(folders).map(([kind, folder]) => [`${folder}/`.toLowerCase(), kind]));
  let dirty = 0;
  let timer: any = null;

  const flushSoon = () => {
    if (timer !== null || dirty <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty <= 0) return;
      try {
        writeManifest(ctx, manifest);
        ctx.log(`[mv-warm-learn] manifest updated | additions=${dirty}`);
        dirty = 0;
      } catch (error) {
        ctx.log(`[mv-warm-learn] manifest update FAILED | ${String(error)}`);
      }
    }, 1200);
  };

  const wrapped = function(this: any, folder: any, filename: any, hue: any, smooth: any) {
    const result = original.apply(this, arguments as any);
    try {
      const mapId = Number(g.$gameMap?.mapId?.() || 0);
      const name = String(filename || '');
      const normalizedFolder = String(folder || '').replace(/\\/g, '/').replace(/^\.\//, '');
      const keyFolder = normalizedFolder.endsWith('/') ? normalizedFolder.toLowerCase() : `${normalizedFolder}/`.toLowerCase();
      const kind = reverseFolders.get(keyFolder);
      if (mapId > 0 && name && kind) {
        const list = manifest.maps?.[String(mapId)] || (manifest.maps[String(mapId)] = []);
        const hueValue = Number(hue || 0);
        if (!list.some((item: any) => item.kind === kind && item.name === name && Number(item.hue || 0) === hueValue) && list.length < 192) {
          const logical = `${folders[kind]}/${name}.png`;
          const bytes = sourceSize(ctx, logical);
          const estimatedPixels = estimatePixelsFromSourceBytes(bytes);
          list.push({
            kind, name, hue: hueValue, priority: 2, order: 1000000 + list.length,
            logical, pixels: estimatedPixels, source_bytes: bytes, source: 'learned'
          });
          const lower = logical.toLowerCase();
          if (!manifest.asset_meta) manifest.asset_meta = {};
          if (!manifest.asset_meta[lower]) manifest.asset_meta[lower] = { logical, width: 0, height: 0, pixels: estimatedPixels, source_bytes: bytes, estimate: 'compressed-bytes-x4' };
          dirty++;
          flushSoon();
        }
      }
    } catch {}
    return result;
  };
  (wrapped as any).__mvmzWarmLearn = true;
  g.ImageManager.loadBitmap = wrapped;
  ctx.log('[mv-warm-learn] runtime image learning installed | auto manifest only');
}

