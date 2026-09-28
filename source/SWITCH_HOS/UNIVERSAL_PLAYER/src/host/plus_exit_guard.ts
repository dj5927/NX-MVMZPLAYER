import type { LogFn } from '../types';

export function installNxPlusExitGuard(log: LogFn) {
  const g: any = globalThis as any;
  if (g.__mvmzNxPlusExitGuardInstalled) return;
  g.__mvmzNxPlusExitGuardInstalled = true;
  let logged = false;
  g.addEventListener?.('beforeunload', (event: any) => {
    try { event?.preventDefault?.(); } catch {}
    if (!logged) {
      logged = true;
      log('[input] nx.js default Plus exit prevented; Start+Select is owned by MVMZ');
    }
  });
  log('[input] nx.js default Plus exit guard installed');
}
