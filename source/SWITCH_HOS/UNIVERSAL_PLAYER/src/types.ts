export type EngineKind = 'MV' | 'MZ';

export type GameInfo = {
  name: string;
  root: string;
  dataRoot: string;
  engine: EngineKind;
  id: string;
};

export type LogFn = (message: string) => void;

export type RuntimeContext = {
  game: GameInfo;
  log: LogFn;
  fs: import('./host/fs').ResourceFS;
  gl: any;
  glStats: import('./compat/webgl1').CompatStats;
  standaloneEngine?: boolean;
  flushLog?: () => void;
  mvWarmBudgetMP?: number;
  mvWarmMaxAssets?: number;
  mvWarmBackgroundMax?: number;
  reportProgress?: (label: string, percent?: number, detail?: string) => void;
};
