import type { LogFn } from '../types';

export class RuntimeLogger {
  private pending: string[] = [];

  constructor(private path: string) {
    try {
      Switch.mkdirSync(this.path.substring(0, this.path.lastIndexOf('/')));
      Switch.writeFileSync(this.path, '');
    } catch {}
    setInterval(() => this.flush(), 1000);
  }

  switchPath(path: string, truncate = true) {
    this.flush();
    this.path = path;
    try {
      Switch.mkdirSync(this.path.substring(0, this.path.lastIndexOf('/')));
      if (truncate) Switch.writeFileSync(this.path, '');
    } catch (error) {
      console.printErr(`Failed to switch log path to ${this.path}: ${String(error)}\n`);
    }
  }

  readonly log: LogFn = (message: string) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.pending.push(line);
    if (/FATAL|FAILED|EXCEPTION|STOP requested/.test(message)) {
      console.printErr(`${line}\n`);
      this.flush();
    }
  };

  flush() {
    if (!this.pending.length) return;
    const batch = this.pending.splice(0, this.pending.length);
    try {
      Switch.mkdirSync(this.path.substring(0, this.path.lastIndexOf('/')));
      Switch.appendFileSync(this.path, batch.join('\n') + '\n');
    } catch (error) {
      this.pending.unshift(...batch);
      console.printErr(`Failed to write ${this.path}: ${String(error)}\n`);
    }
  }
}
