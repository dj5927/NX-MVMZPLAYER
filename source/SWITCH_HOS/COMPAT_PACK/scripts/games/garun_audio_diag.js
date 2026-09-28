(function () {
  const api = globalThis.__mvmzCompatApi;
  if (!api) return;
  const audio = api.config && api.config.mzAudio;
  const profile = api.profile || {};
  api.log(
    'garun V059 content identity matched | folder=' + String(api.game && api.game.name) +
    ' pluginSetFp=' + String(profile.pluginSetFingerprint) +
    ' plugins=' + String((profile.pluginNames || []).length) +
    ' audioStreamDiag=' + String(!!(audio && audio.streamLifecycleDiagnostics))
  );
})();
