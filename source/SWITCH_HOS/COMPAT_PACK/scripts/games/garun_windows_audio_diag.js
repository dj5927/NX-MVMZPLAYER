(function () {
  const api = globalThis.__mvmzCompatApi;
  if (!api) return;
  const audio = api.config && api.config.mzAudio;
  api.log(
    'garun_windows V058 profile active | preemptiveMemory=off audioStreamDiag=' +
    String(!!(audio && audio.streamLifecycleDiagnostics)) + ' samples=' +
    String((audio && audio.progressSamplesMs || []).join(','))
  );
})();
