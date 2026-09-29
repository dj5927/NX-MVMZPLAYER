(function () {
  const g = globalThis;
  const api = g.__mvmzCompatApi;
  if (!api || !g.Scene_Boot || !g.DataManager || !g.PluginManager) return;

  const config = api.config && api.config.mvTemplateEvents || {};
  const pluginName = String(config.pluginName || 'JsScript104Set');
  const params = g.PluginManager.parameters(pluginName) || {};
  const primaryMapId = Number(params.TemplateMapId || 0);
  const secondaryMapId = Number(params.TemplateMapSecId == null ? -1 : params.TemplateMapSecId);
  const indexEventsPerFrame = Math.max(4, Number(config.indexEventsPerFrame || 32));
  const indexBytesPerFrame = Math.max(65536, Number(config.indexBytesPerFrame || 262144));
  const scanBytesPerYield = Math.max(16384, Number(config.scanBytesPerYield || 65536));
  const progressEvery = Math.max(64, Number(config.progressEvery || 256));

  if (!(primaryMapId > 0)) {
    api.log('MV template lazy compat skipped: invalid primary map id for ' + pluginName);
    return;
  }

  const decoder = new TextDecoder();
  const yieldHostFrame = () => new Promise(resolve => {
    const raf = typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame.bind(g) : null;
    if (raf) raf(() => resolve());
    else setTimeout(resolve, 16);
  });
  const isWs = b => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
  const dataDirectory = () => {
    const mode = String(g.LngMode || '').toLowerCase();
    if (mode === 'en') return 'data_en';
    if (mode === 'ko') return 'data_ko';
    if (mode === 'cn') return 'data_cn';
    if (mode === 'tc') return 'data_tc';
    return 'data';
  };
  const mapPath = mapId => {
    const name = 'Map' + String(mapId).padStart(3, '0') + '.json';
    return String(api.game.dataRoot).replace(/\/$/, '') + '/' + dataDirectory() + '/' + name;
  };
  const asciiEquals = (bytes, at, text) => {
    if (at < 0 || at + text.length > bytes.length) return false;
    for (let i = 0; i < text.length; i++) {
      if (bytes[at + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  };

  const findEventsArray = bytes => {
    const limit = Math.min(bytes.length, 1048576);
    const key = '"events"';
    for (let i = 0; i < limit - key.length; i++) {
      if (!asciiEquals(bytes, i, key)) continue;
      let pos = i + key.length;
      while (pos < limit && isWs(bytes[pos])) pos++;
      if (bytes[pos] !== 0x3a) continue;
      pos++;
      while (pos < limit && isWs(bytes[pos])) pos++;
      if (bytes[pos] === 0x5b) return pos;
    }
    throw new Error('top-level events array not found in map JSON');
  };

  const scanObjectEnd = async (bytes, start) => {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let sinceYield = 0;
    for (let i = start; i < bytes.length; i++) {
      const b = bytes[i];
      sinceYield++;
      if (inString) {
        if (escaped) escaped = false;
        else if (b === 0x5c) escaped = true;
        else if (b === 0x22) inString = false;
      } else if (b === 0x22) {
        inString = true;
      } else if (b === 0x7b) {
        depth++;
      } else if (b === 0x7d) {
        depth--;
        if (depth === 0) return i + 1;
      }
      if (sinceYield >= scanBytesPerYield) {
        await yieldHostFrame();
        sinceYield = 0;
      }
    }
    throw new Error('unterminated template event object');
  };

  const extractName = (bytes, start, end) => {
    const key = '"name"';
    const limit = Math.min(end, start + 8192);
    for (let i = start; i < limit - key.length; i++) {
      if (!asciiEquals(bytes, i, key)) continue;
      let pos = i + key.length;
      while (pos < limit && isWs(bytes[pos])) pos++;
      if (bytes[pos] !== 0x3a) continue;
      pos++;
      while (pos < limit && isWs(bytes[pos])) pos++;
      if (bytes[pos] !== 0x22) return '';
      const valueStart = pos;
      pos++;
      let escaped = false;
      for (; pos < end; pos++) {
        const b = bytes[pos];
        if (escaped) escaped = false;
        else if (b === 0x5c) escaped = true;
        else if (b === 0x22) {
          try {
            return JSON.parse(decoder.decode(bytes.subarray(valueStart, pos + 1)));
          } catch {
            return '';
          }
        }
      }
      return '';
    }
    return '';
  };

  const indexMap = async (mapId, label) => {
    const path = mapPath(mapId);
    const started = Date.now();
    api.log('MV template lazy read begin | map=' + mapId + ' path=' + path);
    const buffer = await Switch.readFile(path);
    if (!buffer) throw new Error('template map read returned null: ' + path);
    const bytes = new Uint8Array(buffer);
    api.log('MV template lazy read done | map=' + mapId + ' bytes=' + bytes.byteLength + ' ms=' + (Date.now() - started));

    const records = [];
    let pos = findEventsArray(bytes) + 1;
    let frameEvents = 0;
    let frameBytes = 0;
    let yields = 0;
    while (pos < bytes.length) {
      while (pos < bytes.length && (bytes[pos] === 0x2c || isWs(bytes[pos]))) pos++;
      if (bytes[pos] === 0x5d) break;
      const itemStart = pos;
      if (asciiEquals(bytes, pos, 'null')) {
        records.push(null);
        pos += 4;
      } else if (bytes[pos] === 0x7b) {
        const end = await scanObjectEnd(bytes, pos);
        records.push({
          source: null,
          start: pos,
          end,
          name: extractName(bytes, pos, end),
          overrideId: null,
          cached: undefined
        });
        pos = end;
      } else {
        throw new Error('unexpected token while indexing template events at byte ' + pos);
      }
      frameEvents++;
      frameBytes += Math.max(1, pos - itemStart);
      if (records.length % progressEvery === 0) {
        api.log('MV template lazy index | ' + label + ' events=' + records.length + ' yields=' + yields);
      }
      if (frameEvents >= indexEventsPerFrame || frameBytes >= indexBytesPerFrame) {
        await yieldHostFrame();
        yields++;
        frameEvents = 0;
        frameBytes = 0;
      }
    }

    const source = { mapId, label, buffer, bytes, records };
    for (const record of records) if (record) record.source = source;
    api.log('MV template lazy index complete | ' + label + ' events=' + records.length + ' yields=' + yields + ' totalMs=' + (Date.now() - started));
    return source;
  };

  const createLazyTemplateArray = (primary, secondary) => {
    const refs = primary.records.slice();
    if (secondary) {
      for (const record of secondary.records) {
        if (!record) continue;
        record.overrideId = refs.length;
        refs.push(record);
      }
    }

    const lazy = new Array(refs.length);
    const nameIndex = new Map();
    const stats = g.__mvmzTemplateLazyStats = {
      total: refs.length,
      parsed: 0,
      cacheHits: 0,
      nameHits: 0,
      primaryRecords: primary.records.length,
      secondaryRecords: secondary ? secondary.records.length : 0
    };

    const parseRecord = (record, mergedIndex) => {
      if (record.cached !== undefined) {
        stats.cacheHits++;
        return record.cached;
      }
      const text = decoder.decode(record.source.bytes.subarray(record.start, record.end));
      const event = JSON.parse(text);
      if (record.overrideId != null) event.id = record.overrideId;
      if (event && event.note !== undefined) g.DataManager.extractMetadata(event);
      record.cached = event;
      stats.parsed++;
      if (stats.parsed <= 8 || stats.parsed % 64 === 0) {
        api.log('MV template lazy materialize | index=' + mergedIndex + ' parsed=' + stats.parsed + '/' + stats.total + ' name=' + String(event && event.name || ''));
      }
      return event;
    };

    refs.forEach((record, index) => {
      if (!record) {
        lazy[index] = null;
        return;
      }
      if (record.name && !nameIndex.has(record.name)) nameIndex.set(record.name, index);
      Object.defineProperty(lazy, String(index), {
        enumerable: true,
        configurable: true,
        get() {
          return parseRecord(record, index);
        },
        set(value) {
          record.cached = value;
        }
      });
    });

    const originalSearchDataItem = g.DataManager.searchDataItem;
    g.DataManager.searchDataItem = function(dataArray, columnName, columnValue) {
      if (dataArray === lazy && columnName === 'name') {
        const index = nameIndex.get(columnValue);
        if (index === undefined) return 0;
        stats.nameHits++;
        return lazy[index];
      }
      return originalSearchDataItem.apply(this, arguments);
    };

    api.log('MV template lazy array ready | total=' + lazy.length + ' names=' + nameIndex.size + ' parsedAtBoot=' + stats.parsed + ' rawMiB=' + ((primary.bytes.byteLength + (secondary ? secondary.bytes.byteLength : 0)) / 1048576).toFixed(2));
    return lazy;
  };

  if (config.memoizeDatabaseReady !== false && typeof g.DataManager.isDatabaseLoaded === 'function') {
    const originalDatabaseReady = g.DataManager.isDatabaseLoaded;
    let latchedReady = false;
    g.DataManager.isDatabaseLoaded = function() {
      if (latchedReady) return true;
      const ready = originalDatabaseReady.apply(this, arguments);
      if (ready) {
        latchedReady = true;
        api.log('MV database ready latched after final plugin notetag pass');
      }
      return ready;
    };
  }

  g.Scene_Boot.prototype.templateMapLoadGenerator = function*() {
    const boot = this;
    if (!boot.__mvmzTemplateLazyState) {
      const state = boot.__mvmzTemplateLazyState = { done: false, error: null };
      api.log('MV template lazy boot started | plugin=' + pluginName + ' primary=' + primaryMapId + ' secondary=' + secondaryMapId + ' lang=' + dataDirectory());
      (async () => {
        try {
          const primary = await indexMap(primaryMapId, 'Map' + String(primaryMapId).padStart(3, '0'));
          const secondary = secondaryMapId >= 0
            ? await indexMap(secondaryMapId, 'Map' + String(secondaryMapId).padStart(3, '0'))
            : null;
          g.$dataTemplateEvents = createLazyTemplateArray(primary, secondary);
          g.$dataMap = {};
          state.done = true;
          api.log('MV template lazy boot ready | templates=' + g.$dataTemplateEvents.length + ' parsed=' + g.__mvmzTemplateLazyStats.parsed);
        } catch (error) {
          state.error = error;
          state.done = true;
          api.log('MV template lazy boot FAILED | ' + String(error && error.stack || error));
        }
      })();
    }
    while (!boot.__mvmzTemplateLazyState.done) yield false;
    if (boot.__mvmzTemplateLazyState.error) throw boot.__mvmzTemplateLazyState.error;
    return true;
  };

  api.log('MV template-event lazy compatibility installed | plugin=' + pluginName + ' primary=' + primaryMapId + ' secondary=' + secondaryMapId + ' indexEventsPerFrame=' + indexEventsPerFrame + ' indexBytesPerFrame=' + indexBytesPerFrame + ' scanBytesPerYield=' + scanBytesPerYield);
})();
