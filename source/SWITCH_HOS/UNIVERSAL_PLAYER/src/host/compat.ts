import type { EngineKind, GameInfo, LogFn } from '../types';
import type { ScriptLoader } from './scripts';

type CompatMatch = {
  engine?: EngineKind;
  gameId?: string;
  gameName?: string;
  pluginCount?: number;
  pluginsAll?: string[];
  pluginsAny?: string[];
  pluginsNone?: string[];
  pluginsFingerprint?: string | string[];
  pluginSetFingerprint?: string | string[];
  coreFingerprint?: string | string[];
  filesAll?: string[];
  filesAny?: string[];
  fileFingerprints?: Record<string, string | string[]>;
};

type CompatRule = {
  id: string;
  enabled?: boolean;
  priority?: number;
  match?: CompatMatch;
  scripts?: Record<string, string[]>;
  settings?: Record<string, any>;
};

type CompatManifest = {
  version?: number;
  rules?: CompatRule[];
};

type ResolvedRule = CompatRule & { root: string };

export type CompatProfile = {
  engine: EngineKind;
  gameId: string;
  gameName: string;
  pluginNames: string[];
  pluginsFingerprint: string;
  pluginSetFingerprint: string;
  coreFingerprint: string;
};

function normalizeName(value: any) {
  return String(value || '').trim().toLowerCase();
}

function dirname(path: string) {
  return String(path || '').replace(/\\/g, '/').replace(/\/[^/]+$/, '');
}

function exists(path: string) {
  try { return Switch.statSync(path) !== null; } catch { return false; }
}

function readTextAbsolute(path: string) {
  const raw = Switch.readFileSync(path);
  if (!raw) throw new Error(`compat file unavailable: ${path}`);
  return new TextDecoder().decode(raw);
}

function fnv1a(text: string) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function fingerprintMatches(actual: string, expected?: string | string[]) {
  if (expected == null) return true;
  const values = Array.isArray(expected) ? expected : [expected];
  return values.some(value => normalizeName(value) === normalizeName(actual));
}

function normalizeRelativePath(path: string) {
  return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.(?:\/|$)/g, '');
}

function deepMerge(target: any, source: any) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function parsePluginNames(source: string) {
  const start = source.indexOf('[');
  const end = source.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const list = JSON.parse(source.slice(start, end + 1));
    if (!Array.isArray(list)) return [];
    return list
      .filter((plugin: any) => plugin && plugin.status !== false && plugin.name)
      .map((plugin: any) => String(plugin.name));
  } catch {
    const names: string[] = [];
    const re = /["']name["']\s*:\s*["']([^"']+)["'][\s\S]{0,200}?["']status["']\s*:\s*true/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) names.push(match[1]);
    return names;
  }
}

function matchesRule(rule: CompatRule, profile: CompatProfile, dataRoot: string, fileFingerprintCache: Map<string, string>) {
  const match = rule.match || {};
  if (match.engine && match.engine !== profile.engine) return false;
  if (match.gameId && normalizeName(match.gameId) !== normalizeName(profile.gameId)) return false;
  if (match.gameName && normalizeName(match.gameName) !== normalizeName(profile.gameName)) return false;
  if (match.pluginCount != null && Number(match.pluginCount) !== profile.pluginNames.length) return false;
  if (!fingerprintMatches(profile.pluginsFingerprint, match.pluginsFingerprint)) return false;
  if (!fingerprintMatches(profile.pluginSetFingerprint, match.pluginSetFingerprint)) return false;
  if (!fingerprintMatches(profile.coreFingerprint, match.coreFingerprint)) return false;
  const plugins = new Set(profile.pluginNames.map(normalizeName));
  if (match.pluginsAll?.some(name => !plugins.has(normalizeName(name)))) return false;
  if (match.pluginsAny?.length && !match.pluginsAny.some(name => plugins.has(normalizeName(name)))) return false;
  if (match.pluginsNone?.some(name => plugins.has(normalizeName(name)))) return false;
  const hasRelative = (relative: string) => exists(`${dataRoot}/${normalizeRelativePath(relative)}`);
  if (match.filesAll?.some(relative => !hasRelative(relative))) return false;
  if (match.filesAny?.length && !match.filesAny.some(relative => hasRelative(relative))) return false;
  for (const [relativeRaw, expected] of Object.entries(match.fileFingerprints || {})) {
    const relative = normalizeRelativePath(relativeRaw);
    let actual = fileFingerprintCache.get(relative);
    if (!actual) {
      try { actual = fnv1a(readTextAbsolute(`${dataRoot}/${relative}`)); }
      catch { return false; }
      fileFingerprintCache.set(relative, actual);
    }
    if (!fingerprintMatches(actual, expected)) return false;
  }
  return true;
}

export class CompatManager {
  readonly config: Record<string, any> = {};
  readonly profile: CompatProfile;
  readonly matchedRules: ResolvedRule[] = [];
  private phaseRuns = new Set<string>();
  private prePluginsDone = false;

  constructor(readonly game: GameInfo, private readonly log: LogFn, installRoot: string) {
    let pluginsSource = '';
    let coreSource = '';
    try { pluginsSource = readTextAbsolute(`${game.dataRoot}/js/plugins.js`); } catch {}
    try {
      const core = game.engine === 'MV' ? 'js/rpg_core.js' : 'js/rmmz_core.js';
      coreSource = readTextAbsolute(`${game.dataRoot}/${core}`);
    } catch {}
    const pluginNames = parsePluginNames(pluginsSource);
    const pluginSetSource = pluginNames.map(normalizeName).sort().join('\n');
    this.profile = {
      engine: game.engine,
      gameId: game.id,
      gameName: game.name,
      pluginNames,
      pluginsFingerprint: fnv1a(pluginsSource),
      pluginSetFingerprint: fnv1a(pluginSetSource),
      coreFingerprint: fnv1a(coreSource)
    };

    const roots = [`${installRoot}/_compat`, 'sdmc:/mvmz/_compat'];
    const byId = new Map<string, ResolvedRule>();
    for (const root of roots) {
      const manifestPath = `${root}/manifest.json`;
      if (!exists(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readTextAbsolute(manifestPath)) as CompatManifest;
        for (const rule of manifest.rules || []) {
          if (!rule?.id || rule.enabled === false) continue;
          byId.set(String(rule.id), { ...rule, root });
        }
        this.log(`[compat] manifest loaded | ${manifestPath} rules=${manifest.rules?.length || 0}`);
      } catch (error) {
        this.log(`[compat] manifest FAILED | ${manifestPath} | ${String((error as any)?.stack ?? error)}`);
      }
    }

    const fileFingerprintCache = new Map<string, string>();
    for (const rule of byId.values()) {
      const match = rule.match || {};
      if (match.gameId || match.gameName) {
        this.log(`[compat] legacy folder/display-name selector present | rule=${rule.id}`);
      }
      if (matchesRule(rule, this.profile, game.dataRoot, fileFingerprintCache)) this.matchedRules.push(rule);
    }
    this.matchedRules.sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
    for (const rule of this.matchedRules) deepMerge(this.config, rule.settings || {});

    const g: any = globalThis as any;
    g.__mvmzCompatApi = {
      game: this.game,
      profile: this.profile,
      config: this.config,
      log: (message: any) => this.log(`[compat-script] ${String(message)}`)
    };
    this.log(`[compat] scan | engine=${game.engine} folderId=${game.id} plugins=${pluginNames.length} coreFp=${this.profile.coreFingerprint} pluginsFp=${this.profile.pluginsFingerprint} pluginSetFp=${this.profile.pluginSetFingerprint}`);
    this.log(`[compat] matched | count=${this.matchedRules.length} ids=${this.matchedRules.map(rule => rule.id).join(',') || 'none'}`);
  }

  private scriptsForPhase(phase: string) {
    const items: Array<{ rule: ResolvedRule; path: string }> = [];
    for (const rule of this.matchedRules) {
      for (const path of rule.scripts?.[phase] || []) items.push({ rule, path });
    }
    return items;
  }

  runPhase(phase: string, repeatable = false) {
    if (!repeatable && this.phaseRuns.has(phase)) return;
    if (!repeatable) this.phaseRuns.add(phase);
    for (const { rule, path } of this.scriptsForPhase(phase)) {
      const absolute = `${rule.root}/${String(path).replace(/^\/+/, '')}`;
      try {
        const source = readTextAbsolute(absolute);
        const g: any = globalThis as any;
        if (g.__mvmzCompatApi) {
          g.__mvmzCompatApi.ruleId = rule.id;
          g.__mvmzCompatApi.phase = phase;
          g.__mvmzCompatApi.scriptPath = absolute;
        }
        (0, eval)(`${source}\n//# sourceURL=${absolute}`);
        this.log(`[compat] script OK | phase=${phase} rule=${rule.id} path=${path}`);
      } catch (error) {
        this.log(`[compat] script FAILED | phase=${phase} rule=${rule.id} path=${path} | ${String((error as any)?.stack ?? error)}`);
      }
    }
  }

  attachScriptLoader(scripts: ScriptLoader) {
    scripts.onBeforeScript(relative => {
      const rel = String(relative).replace(/\\/g, '/');
      const plugin = /^js\/plugins\/([^/]+)\.js$/i.exec(rel)?.[1];
      if (plugin && !this.prePluginsDone) {
        this.prePluginsDone = true;
        this.runPhase('pre_plugins');
      }
      if (plugin) {
        this.runPhase(`before_plugin:${plugin}`, true);
        this.runPhase('before_plugin', true);
      }
    });
    scripts.onAfterScript(relative => {
      const rel = String(relative).replace(/\\/g, '/');
      if (/^js\/(?:rpg_core|rmmz_core)\.js$/i.test(rel)) this.runPhase('post_core');
      const plugin = /^js\/plugins\/([^/]+)\.js$/i.exec(rel)?.[1];
      if (plugin) {
        this.runPhase(`after_plugin:${plugin}`, true);
        this.runPhase('after_plugin', true);
      }
    });
  }
}

export function runtimeInstallRoot() {
  const ownPath = String(Switch.argv[0] || 'sdmc:/switch/MVMZ_HOS/runtime/player.nro');
  return dirname(dirname(ownPath));
}
