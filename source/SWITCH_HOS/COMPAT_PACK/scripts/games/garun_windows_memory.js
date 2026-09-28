(function () {
  const api = globalThis.__mvmzCompatApi;
  if (!api) return;
  const memory = api.config && api.config.mzMemory;
  api.log(
    'garun_windows memory profile active | preemptive=' +
    String(memory && memory.preemptiveWaterMiB) + 'MiB full=' +
    String(memory && memory.fullWaterMiB) + 'MiB transitions=' +
    String((memory && memory.preemptiveTransitions || []).join(','))
  );
})();
