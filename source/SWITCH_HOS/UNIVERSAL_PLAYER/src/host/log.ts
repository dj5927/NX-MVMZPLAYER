import type { LogFn } from '../types';

export class RuntimeLogger {
  private pending: string[] = [];
  private dirReady = false;
  private dropped = 0;
  private static readonly MAX_PENDING = 4096;

  constructor(private path: string) {
    try {
      this.ensureDir();
      Switch.writeFileSync(this.path, '');
    } catch {}
    setInterval(() => this.flush(), 1000);
  }

  private ensureDir() {
    if (this.dirReady) return;
    Switch.mkdirSync(this.path.substring(0, this.path.lastIndexOf('/')));
    this.dirReady = true;
  }

  switchPath(path: string, truncate = true) {
    this.flush();
    this.path = path;
    this.dirReady = false;
    try {
      this.ensureDir();
      if (truncate) Switch.writeFileSync(this.path, '');
    } catch (error) {
      console.printErr(`Failed to switch log path to ${this.path}: ${String(error)}\n`);
    }
  }

  readonly log: LogFn = (message: string) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.pending.push(line);
    if (this.pending.length > RuntimeLogger.MAX_PENDING) {
      const overflow = this.pending.length - RuntimeLogger.MAX_PENDING;
      this.pending.splice(0, overflow);
      this.dropped += overflow;
    }
    if (/FATAL|FAILED|EXCEPTION|STOP requested/.test(message)) {
      console.printErr(`${line}\n`);
      this.flush();
    }
  };

  flush() {
    if (!this.pending.length) return;
    const batch = this.pending.splice(0, this.pending.length);
    if (this.dropped > 0) {
      batch.unshift(`[${new Date().toISOString()}] [log] dropped ${this.dropped} buffered lines after write backpressure`);
      this.dropped = 0;
    }
    try {
      this.ensureDir();
      Switch.appendFileSync(this.path, batch.join('\n') + '\n');
    } catch (error) {
      this.pending.unshift(...batch);
      if (this.pending.length > RuntimeLogger.MAX_PENDING) {
        const overflow = this.pending.length - RuntimeLogger.MAX_PENDING;
        this.pending.splice(0, overflow);
        this.dropped += overflow;
      }
      console.printErr(`Failed to write ${this.path}: ${String(error)}\n`);
    }
  }
}
