(function () {
  const g = globalThis;
  const api = g.__mvmzCompatApi;
  if (!api || !g.Scene_Boot || !g.DataManager || !g.PluginManager) return;

  const config = api.config && api.config.mvTemplateEvents || {};
  const pluginName = String(config.pluginName || 'JsScript104Set');
  const params = g.PluginManager.parameters(pluginName) || {};
  const primaryMapId = Number(params.TemplateMapId || 0);
  const secondaryMapId = Number(params.TemplateMapSecId == null ? -1 : params.TemplateMapSecId);
  const sliceMs = Math.max(2, Number(config.sliceMs || 8));
  const progressEvery = Math.max(32, Number(config.progressEvery || 128));

  if (!(primaryMapId > 0)) {
    api.log('MV template async compat skipped: invalid primary map id for ' + pluginName);
    return;
  }

  const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));
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

  const findEventsArray = text => {
    let objectDepth = 0;
    let arrayDepth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        if (objectDepth === 1 && arrayDepth === 0) {
          let end = i + 1;
          let localEscaped = false;
          for (; end < text.length; end++) {
            const c = text[end];
            if (localEscaped) localEscaped = false;
            else if (c === '\\') localEscaped = true;
            else if (c === '"') break;
          }
          let key = '';
          try { key = JSON.parse(text.slice(i, end + 1)); } catch {}
          if (key === 'events') {
            let pos = end + 1;
            while (/\s/.test(text[pos] || '')) pos++;
            if (text[pos] === ':') pos++;
            while (/\s/.test(text[pos] || '')) pos++;
            if (text[pos] === '[') return pos;
          }
          i = end;
          continue;
        }
        inString = true;
        continue;
      }
      if (ch === '{') objectDepth++;
      else if (ch === '}') objectDepth--;
      else if (ch === '[') arrayDepth++;
      else if (ch === ']') arrayDepth--;
    }
    throw new Error('top-level events array not found');
  };

  const scanObjectEnd = (text, start) => {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    throw new Error('unterminated event object');
  };

  const parseEvents = async (text, label) => {
    const start = findEventsArray(text);
    const events = [];
    let pos = start + 1;
    let sliceStart = Date.now();
    while (pos < text.length) {
      while (pos < text.length && (text[pos] === ',' || /\s/.test(text[pos]))) pos++;
      if (text[pos] === ']') break;
      if (text.startsWith('null', pos)) {
        events.push(null);
        pos += 4;
      } else if (text[pos] === '{') {
        const end = scanObjectEnd(text, pos);
        const event = JSON.parse(text.slice(pos, end));
        if (event && event.note !== undefined) g.DataManager.extractMetadata(event);
        events.push(event);
        pos = end;
      } else {
        throw new Error('unexpected token in events array at ' + pos + ': ' + text.slice(pos, pos + 24));
      }
      if (events.length % progressEvery === 0) {
        api.log('MV template async parse | ' + label + ' events=' + events.length);
      }
      if (Date.now() - sliceStart >= sliceMs) {
        await nextTurn();
        sliceStart = Date.now();
      }
    }
    return events;
  };

  const loadEvents = async mapId => {
    const path = mapPath(mapId);
    const started = Date.now();
    api.log('MV template async read begin | map=' + mapId + ' path=' + path);
    let buffer = await Switch.readFile(path);
    if (!buffer) throw new Error('template map read returned null: ' + path);
    api.log('MV template async read done | map=' + mapId + ' bytes=' + buffer.byteLength + ' ms=' + (Date.now() - started));
    let text = new TextDecoder().decode(buffer);
    buffer = null;
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const events = await parseEvents(text, 'Map' + String(mapId).padStart(3, '0'));
    text = '';
    api.log('MV template async parse done | map=' + mapId + ' events=' + events.length + ' totalMs=' + (Date.now() - started));
    return events;
  };

  if (config.memoizeDatabaseReady !== false && typeof g.DataManager.isDatabaseLoaded === 'function') {
    const originalDatabaseReady = g.DataManager.isDatabaseLoaded;
    let latchedReady = false;
    g.DataManager.isDatabaseLoaded = function () {
      if (latchedReady) return true;
      const ready = originalDatabaseReady.apply(this, arguments);
      if (ready) {
        latchedReady = true;
        api.log('MV database ready latched after final plugin notetag pass');
      }
      return ready;
    };
  }

  g.Scene_Boot.prototype.templateMapLoadGenerator = function* () {
    const boot = this;
    if (!boot.__mvmzTemplateAsyncState) {
      const state = boot.__mvmzTemplateAsyncState = { done: false, error: null };
      api.log('MV template async boot started | plugin=' + pluginName + ' primary=' + primaryMapId + ' secondary=' + secondaryMapId + ' lang=' + dataDirectory());
      (async () => {
        try {
          const primary = await loadEvents(primaryMapId);
          if (secondaryMapId >= 0) {
            const secondary = await loadEvents(secondaryMapId);
            for (const eventData of secondary) {
              if (!eventData) continue;
              eventData.id = primary.length;
              primary.push(eventData);
            }
          }
          g.$dataTemplateEvents = primary;
          g.$dataMap = {};
          state.done = true;
          api.log('MV template async boot ready | templates=' + primary.length);
        } catch (error) {
          state.error = error;
          state.done = true;
          api.log('MV template async boot FAILED | ' + String(error && error.stack || error));
        }
      })();
    }
    while (!boot.__mvmzTemplateAsyncState.done) yield false;
    if (boot.__mvmzTemplateAsyncState.error) throw boot.__mvmzTemplateAsyncState.error;
    return true;
  };

  api.log('MV template-event async compatibility installed | plugin=' + pluginName + ' primary=' + primaryMapId + ' secondary=' + secondaryMapId + ' sliceMs=' + sliceMs);
})();
