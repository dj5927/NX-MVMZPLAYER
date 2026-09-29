(function () {
  const api = globalThis.__mvmzCompatApi;
  if (!api) return;
  const profile = api.profile || {};
  api.log(
    'yariste V060 boot profile active | folder=' + String(api.game && api.game.name) +
    ' pluginSetFp=' + String(profile.pluginSetFingerprint) +
    ' plugins=' + String((profile.pluginNames || []).length) +
    ' coreFp=' + String(profile.coreFingerprint)
  );
})();
