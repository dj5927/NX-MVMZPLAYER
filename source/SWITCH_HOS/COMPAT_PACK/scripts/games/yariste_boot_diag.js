(function () {
  const api = globalThis.__mvmzCompatApi;
  if (!api) return;
  const profile = api.profile || {};
  const yanfly = globalThis.Yanfly;
  if (yanfly && yanfly.Util && typeof yanfly.Util.displayError === 'function' &&
      !yanfly.Util.displayError.__mvmzYaristeLogBridge) {
    const originalDisplayError = yanfly.Util.displayError;
    const wrappedDisplayError = function (error, code, message) {
      try {
        const detail =
          String(error && error.name || 'Error') + ': ' +
          String(error && error.message || error) +
          (error && error.stack ? ' | ' + String(error.stack).replace(/\s+/g, ' ').slice(0, 1200) : '');
        api.log('yariste caught error | ' + detail);
      } catch (_) {
      }
      return originalDisplayError.apply(this, arguments);
    };
    wrappedDisplayError.__mvmzYaristeLogBridge = true;
    yanfly.Util.displayError = wrappedDisplayError;
    api.log('yariste Yanfly error-log bridge installed');
  }
  api.log(
    'yariste V069 boot profile active | folder=' + String(api.game && api.game.name) +
    ' pluginSetFp=' + String(profile.pluginSetFingerprint) +
    ' plugins=' + String((profile.pluginNames || []).length) +
    ' coreFp=' + String(profile.coreFingerprint) +
    ' lexicalLngImgArr=' + String(Array.isArray(globalThis._LngImgArr) ? globalThis._LngImgArr.length : 'missing') +
    ' btlStop=' + String(globalThis.BtlStopEventFlame) +
    ' recoSaveArr=' + String(Array.isArray(globalThis.RecoSaveArr) ? globalThis.RecoSaveArr.length : 'missing') +
    ' naGCUp=' + String(globalThis.NaGCUpFlg) +
    ' mainText=' + String(globalThis.MainTextUpdateFlg) +
    ' eventLexicals=' + String((((api.config || {}).scriptLoader || {}).mvBatchGlobalLexicalLiveBindings || []).length)
  );
})();
