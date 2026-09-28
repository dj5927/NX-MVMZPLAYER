import type { LogFn } from '../types';

function decodeText(data: ArrayBuffer | Uint8Array | null | undefined) {
  if (!data) return '';
  return new TextDecoder().decode(data as any);
}

export function installPersistentLocalStorage(saveId: string, log: LogFn) {
  const g: any = globalThis as any;
  const root = `sdmc:/mvmz/_saves/${saveId}/web`;
  const path = `${root}/localStorage.json`;
  Switch.mkdirSync(root);

  let values: Record<string, string> = Object.create(null);
  try {
    const raw = decodeText(Switch.readFileSync(path));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) values[key] = String(value);
      }
    }
  } catch (error) {
    log(`[storage] localStorage read fallback | ${String(error)}`);
  }

  const persist = () => Switch.writeFileSync(path, JSON.stringify(values));
  const storage: any = {
    get length() { return Object.keys(values).length; },
    key(index: number) { return Object.keys(values)[Number(index) || 0] ?? null; },
    getItem(key: string) {
      const name = String(key);
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null;
    },
    setItem(key: string, value: any) { values[String(key)] = String(value); persist(); },
    removeItem(key: string) { delete values[String(key)]; persist(); },
    clear() { values = Object.create(null); persist(); }
  };

  g.localStorage = storage;
  if (!g.sessionStorage) {
    const session: Record<string, string> = Object.create(null);
    g.sessionStorage = {
      get length() { return Object.keys(session).length; },
      key(index: number) { return Object.keys(session)[Number(index) || 0] ?? null; },
      getItem(key: string) { return Object.prototype.hasOwnProperty.call(session, String(key)) ? session[String(key)] : null; },
      setItem(key: string, value: any) { session[String(key)] = String(value); },
      removeItem(key: string) { delete session[String(key)]; },
      clear() { for (const key of Object.keys(session)) delete session[key]; }
    };
  }
  log(`[storage] persistent localStorage installed | ${path}`);
}
