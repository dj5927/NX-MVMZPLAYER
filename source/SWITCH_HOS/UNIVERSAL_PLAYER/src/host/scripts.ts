import { ResourceFS, normalizeRelativePath } from './fs';
import type { LogFn } from '../types';

export type ScriptLoaderMode = 'legacy' | 'shared-lexical' | 'mv-batch';

type ScriptElement = {
  src?: string;
  type?: string;
  async?: boolean;
  defer?: boolean;
  onload?: ((event?: Event) => void) | null;
  onerror?: ((event?: Event) => void) | null;
  _url?: string;
  parentNode?: any;
  [key: string]: any;
};

export function extractScriptSources(indexHtml: string) {
  const result: string[] = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*><\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(indexHtml))) result.push(normalizeRelativePath(match[1]));
  return result;
}

export class ScriptLoader {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private beforeHooks: Array<(relative: string) => void | Promise<void>> = [];
  private afterHooks: Array<(relative: string) => void | Promise<void>> = [];
  private nativeBodyAppend: ((child: any) => any) | null = null;
  private nativeHeadAppend: ((child: any) => any) | null = null;
  private pluginLexicalStore: any = Object.create(null);
  private pluginLexicalScope: any = null;
  private pluginLexicalEvaluator: ((source: string) => any) | null = null;
  private pluginBatch: Array<{ relative: string; element: ScriptElement; document: any }> = [];
  private pluginBatchFlushed = false;

  constructor(
    private readonly fs: ResourceFS,
    private readonly log: LogFn,
    private readonly mode: ScriptLoaderMode = 'legacy'
  ) {}

  private ensurePluginLexicalEvaluator() {
    if (this.pluginLexicalEvaluator) return this.pluginLexicalEvaluator;
    const g: any = globalThis as any;
    const store = this.pluginLexicalStore;
    const localNames = new Set(['eval', '__mvmzScope__', '__mvmzCode__']);
    this.pluginLexicalScope = new Proxy(store, {
      has(target, property) {
        if (typeof property === 'string' && localNames.has(property)) return false;
        // Only intercept names that really belong to the emulated shared
        // global lexical environment. Let every other identifier fall
        // through to the real script/global environment so engine globals,
        // top-level function declarations and class bindings keep normal
        // classic-script lookup semantics.
        return Object.prototype.hasOwnProperty.call(target, property);
      },
      get(target, property) {
        if (property === Symbol.unscopables) return undefined;
        if (Object.prototype.hasOwnProperty.call(target, property)) return target[property as any];
        return g[property as any];
      },
      set(target, property, value) {
        if (Object.prototype.hasOwnProperty.call(target, property)) {
          target[property as any] = value;
        } else {
          g[property as any] = value;
        }
        return true;
      }
    });
    const evaluate: any = Function(
      '__mvmzScope__',
      '__mvmzCode__',
      'with(__mvmzScope__){ return eval(__mvmzCode__); }'
    );
    this.pluginLexicalEvaluator = (code: string) => evaluate(this.pluginLexicalScope, code);
    this.log('[script] classic-script shared lexical environment installed');
    return this.pluginLexicalEvaluator;
  }

  private promoteBrowserScriptGlobals(relative: string, source: string) {
    if (!/^js\/plugins\/.+\.js$/i.test(relative)) return source;

    if (this.mode !== 'shared-lexical') {
      const names = new Set<string>();
      const patterns = [
        /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/gm,
        /^class\s+([A-Za-z_$][\w$]*)\b/gm,
        /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm
      ];
      for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source))) names.add(match[1]);
      }
      if (!names.size) return source;
      const trailer = Array.from(names).map(name =>
        `try{globalThis[${JSON.stringify(name)}]=${name};}catch(_mvmzExportError){}`
      ).join('\n');
      this.log(`[script] browser-global bridge ${relative} exports=${names.size}`);
      return `${source}\n${trailer}`;
    }

    // Browser classic <script> elements share a global lexical environment.
    // Separate indirect eval() calls do not. Preserve that distinction without
    // turning lexical declarations into window/global var properties.
    const lexicalNames = new Set<string>();
    const lexicalPattern = /^\uFEFF?(?:let|const)\s+([^\s=,;]+)/gm;
    let lexicalMatch: RegExpExecArray | null;
    while ((lexicalMatch = lexicalPattern.exec(source))) lexicalNames.add(lexicalMatch[1]);
    const bareMulti = /^\uFEFF?(?:let|const)\s+((?:[^\s=,;]+\s*,\s*)+[^\s=,;]+)\s*;/gm;
    let multiMatch: RegExpExecArray | null;
    while ((multiMatch = bareMulti.exec(source))) {
      for (const name of multiMatch[1].split(',')) lexicalNames.add(name.trim());
    }
    for (const name of lexicalNames) {
      if (!Object.prototype.hasOwnProperty.call(this.pluginLexicalStore, name)) {
        this.pluginLexicalStore[name] = undefined;
      }
    }
    if (lexicalNames.size) {
      source = source.replace(/^(\uFEFF?)(?:let|const)\s+(?=[^\s=,;]+)/gm, '');
      this.log(`[script] classic-script shared lexical bridge ${relative} declarations=${lexicalNames.size}`);
    }

    // var/function/class exports keep the existing browser-global shim.
    // Lexical declarations above deliberately stay out of globalThis.
    const names = new Set<string>();
    const patterns = [
      /^var\s+([A-Za-z_$][\w$]*)\b/gm,
      /^class\s+([A-Za-z_$][\w$]*)\b/gm,
      /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) names.add(match[1]);
    }
    if (!names.size) return source;
    const trailer = Array.from(names).map(name =>
      `try{globalThis[${JSON.stringify(name)}]=${name};}catch(_mvmzExportError){}`
    ).join('\n');
    this.log(`[script] browser-global bridge ${relative} exports=${names.size}`);
    return `${source}\n${trailer}`;
  }

  onAfterScript(hook: (relative: string) => void | Promise<void>) {
    this.afterHooks.push(hook);
  }

  onBeforeScript(hook: (relative: string) => void | Promise<void>) {
    this.beforeHooks.push(hook);
  }

  installDynamicScriptBridge(document: any) {
    this.nativeBodyAppend = document.body.appendChild.bind(document.body);
    this.nativeHeadAppend = document.head.appendChild.bind(document.head);
    const wrap = (nativeAppend: (child: any) => any) => (child: any) => {
      const result = nativeAppend(child);
      if (child && String(child.tagName || child.nodeName || '').toUpperCase() === 'SCRIPT' && child.src) {
        this.enqueueScriptElement(child, document);
      }
      return result;
    };
    document.body.appendChild = wrap(this.nativeBodyAppend!);
    document.head.appendChild = wrap(this.nativeHeadAppend!);
    this.log('Dynamic <script> bridge installed');
  }

  evalGlobal(name: string, source: string, currentScript?: any, document?: any) {
    const doc: any = document ?? (globalThis as any).document;
    const previous = doc?.currentScript ?? null;
    const script = currentScript ?? { src: name };
    const previousSrc = script?.src;
    try {
      const rawSrc = String(previousSrc || name);
      if (!/^(?:[a-z]+:|\/)/i.test(rawSrc)) {
        script.src = this.fs.resolve(normalizeRelativePath(rawSrc));
      }
    } catch {}
    if (doc) doc.currentScript = script;
    try {
      const code = `${source}\n//# sourceURL=${name}`;
      if (this.mode === 'shared-lexical' && /^js\/plugins\/.+\.js$/i.test(normalizeRelativePath(name))) {
        this.ensurePluginLexicalEvaluator()(code);
      } else {
        (0, eval)(code);
      }
    } finally {
      if (script && previousSrc !== undefined) script.src = previousSrc;
      if (doc) doc.currentScript = previous;
    }
  }

  evalBrowserLibrary(name: string, source: string, currentScript?: any, document?: any) {
    const g: any = globalThis as any;
    const saved = { module: g.module, exports: g.exports, define: g.define };
    try {
      g.module = undefined;
      g.exports = undefined;
      g.define = undefined;
      this.evalGlobal(name, source, currentScript, document);
    } finally {
      if (saved.module === undefined) delete g.module; else g.module = saved.module;
      if (saved.exports === undefined) delete g.exports; else g.exports = saved.exports;
      if (saved.define === undefined) delete g.define; else g.define = saved.define;
    }
  }

  loadNow(relative: string, browserLibrary = false, scriptElement?: any, document?: any) {
    const rel = normalizeRelativePath(relative);
    const source = this.promoteBrowserScriptGlobals(rel, this.fs.readText(rel));
    const element = scriptElement ?? { src: rel, tagName: 'SCRIPT' };
    if (browserLibrary) this.evalBrowserLibrary(rel, source, element, document);
    else this.evalGlobal(rel, source, element, document);
    this.log(`[script] OK ${rel}`);
  }

  async loadNowWithHooks(relative: string, browserLibrary = false, scriptElement?: any, document?: any) {
    const rel = normalizeRelativePath(relative);
    for (const hook of this.beforeHooks) await hook(rel);
    this.loadNow(rel, browserLibrary, scriptElement, document);
    for (const hook of this.afterHooks) await hook(rel);
  }

  enqueue(relative: string, browserLibrary = false, scriptElement?: any, document?: any) {
    this.pending++;
    this.tail = this.tail.then(async () => {
      try {
        for (const hook of this.beforeHooks) await hook(normalizeRelativePath(relative));
        this.loadNow(relative, browserLibrary, scriptElement, document);
        for (const hook of this.afterHooks) await hook(normalizeRelativePath(relative));
        scriptElement?.onload?.({ target: scriptElement } as any);
      } catch (error) {
        this.log(`[script] FAILED ${relative} | ${String((error as any)?.stack ?? error)}`);
        scriptElement?.onerror?.({ target: scriptElement, error } as any);
        if (!scriptElement?.onerror) throw error;
      } finally {
        this.pending--;
      }
    });
    return this.tail;
  }

  private async flushPluginBatch() {
    if (!this.pluginBatch.length) return;
    const batch = this.pluginBatch.splice(0);
    this.pluginBatchFlushed = true;
    const g: any = globalThis as any;
    const doc: any = batch[0]?.document ?? g.document;
    const previous = doc?.currentScript ?? null;
    let currentIndex = -1;
    const previousSetter = g.__mvmzPluginBatchSetCurrent;
    const previousIndex = g.__mvmzPluginBatchIndex;
    g.__mvmzPluginBatchSetCurrent = (index: number) => {
      currentIndex = index;
      g.__mvmzPluginBatchIndex = index;
      if (doc) doc.currentScript = batch[index]?.element ?? null;
    };
    const pieces: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i];
      for (const hook of this.beforeHooks) await hook(normalizeRelativePath(entry.relative));
      const raw = this.fs.readText(entry.relative);
      pieces.push(`\n;globalThis.__mvmzPluginBatchSetCurrent(${i});\n${raw}\n`);
    }
    this.log(`[script] MV classic batch begin | count=${batch.length}`);
    try {
      (0, eval)(pieces.join('\n'));
      for (let i = 0; i < batch.length; i++) {
        const entry = batch[i];
        this.log(`[script] OK ${entry.relative}`);
        for (const hook of this.afterHooks) await hook(normalizeRelativePath(entry.relative));
        entry.element?.onload?.({ target: entry.element } as any);
      }
      this.log(`[script] MV classic batch PASS | count=${batch.length}`);
    } catch (error) {
      const entry = currentIndex >= 0 ? batch[currentIndex] : null;
      const path = entry?.relative ?? 'parse/before-first-script';
      const detail = `${String((error as any)?.name ?? 'Error')}: ${String((error as any)?.message ?? error)}`;
      this.log(`[script] MV classic batch FAILED | index=${currentIndex} path=${path} | ${detail} | ${String((error as any)?.stack ?? '')}`);
      entry?.element?.onerror?.({ target: entry.element, error } as any);
      throw error;
    } finally {
      if (doc) doc.currentScript = previous;
      if (previousSetter === undefined) delete g.__mvmzPluginBatchSetCurrent; else g.__mvmzPluginBatchSetCurrent = previousSetter;
      if (previousIndex === undefined) delete g.__mvmzPluginBatchIndex; else g.__mvmzPluginBatchIndex = previousIndex;
    }
  }

  async drain() {
    while (true) {
      if (this.mode === 'mv-batch' && this.pluginBatch.length) {
        await this.flushPluginBatch();
      }
      const current = this.tail;
      await current;
      await Promise.resolve();
      if (current === this.tail && this.pending === 0) return;
    }
  }

  private enqueueScriptElement(element: ScriptElement, document: any) {
    const rel = normalizeRelativePath(String(element.src));
    const lower = rel.toLowerCase();
    const browserLibrary = /(?:^|\/)js\/libs\//i.test(rel) ||
      /(?:pixi|pako|localforage|effekseer|vorbisdecoder|lz-string|fpsmeter)/i.test(lower);
    if (this.mode === 'mv-batch' && !this.pluginBatchFlushed && /^js\/plugins\/.+\.js$/i.test(rel) && !browserLibrary) {
      this.pluginBatch.push({ relative: rel, element, document });
      this.log(`[script] queued for MV classic batch ${rel}`);
      return;
    }
    this.enqueue(rel, browserLibrary, element, document);
  }
}
