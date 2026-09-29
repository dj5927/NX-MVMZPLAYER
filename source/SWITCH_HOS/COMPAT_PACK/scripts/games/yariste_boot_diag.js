(function () {
  const api = globalThis.__mvmzCompatApi;
  if (!api) return;
  const profile = api.profile || {};
  api.log(
    'yariste V064 boot profile active | folder=' + String(api.game && api.game.name) +
    ' pluginSetFp=' + String(profile.pluginSetFingerprint) +
    ' plugins=' + String((profile.pluginNames || []).length) +
    ' coreFp=' + String(profile.coreFingerprint) +
    ' lexicalLngImgArr=' + String(Array.isArray(globalThis._LngImgArr) ? globalThis._LngImgArr.length : 'missing') +
    ' btlStop=' + String(globalThis.BtlStopEventFlame) +
    ' recoSaveArr=' + String(Array.isArray(globalThis.RecoSaveArr) ? globalThis.RecoSaveArr.length : 'missing')
  );
})();
