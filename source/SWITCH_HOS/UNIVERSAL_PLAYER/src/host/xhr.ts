import { isAbsoluteResource, normalizeRelativePath, ResourceFS } from './fs';
import type { LogFn } from '../types';

type XhrCallback = ((event?: Event) => void) | null;

export function makeFileXMLHttpRequest(fs: ResourceFS, log: LogFn, NativeXHR?: any) {
  return class FileXMLHttpRequest extends EventTarget {
    method = 'GET';
    url = '';
    async = true;
    status = 0;
    statusText = '';
    readyState = 0;
    responseText = '';
    response: any = null;
    responseType = '';
    responseURL = '';
    timeout = 0;
    withCredentials = false;
    onload: XhrCallback = null;
    onerror: XhrCallback = null;
    onreadystatechange: XhrCallback = null;
    onloadend: XhrCallback = null;
    onabort: XhrCallback = null;
    private aborted = false;

    open(method: string, url: string, async = true) {
      this.method = String(method || 'GET').toUpperCase();
      this.url = String(url || '');
      this.async = async !== false;
      this.readyState = 1;
      this.fireReadyState();
    }

    overrideMimeType(_mime: string) {}
    setRequestHeader(_name: string, _value: string) {}
    getResponseHeader(_name: string) { return null; }
    getAllResponseHeaders() { return ''; }

    abort() {
      this.aborted = true;
      this.readyState = 0;
      this.onabort?.(new Event('abort'));
      this.dispatchEvent(new Event('abort'));
    }

    send(_body?: any) {
      if (this.aborted) return;
      if (/^https?:/i.test(this.url) && NativeXHR) {
        const native = new NativeXHR();
        native.open(this.method, this.url, this.async);
        native.responseType = this.responseType;
        native.onload = () => {
          this.status = native.status;
          this.statusText = native.statusText;
          this.readyState = 4;
          this.response = native.response;
          this.responseText = this.responseType && this.responseType !== 'text' ? '' : native.responseText;
          this.responseURL = native.responseURL || this.url;
          this.finish(true);
        };
        native.onerror = () => {
          this.status = native.status || 0;
          this.readyState = 4;
          this.finish(false);
        };
        native.send(_body);
        return;
      }
      const resolveLocal = () => {
        if (this.method !== 'GET') throw new Error(`unsupported local method ${this.method}`);
        const relative = normalizeRelativePath(this.url);
        const path = (isAbsoluteResource(this.url) && (this.url.startsWith('sdmc:') || this.url.startsWith('romfs:')))
          ? this.url
          : fs.resolve(relative);
        return { relative, path };
      };
      const runSync = () => {
        if (this.aborted) return;
        let ok = false;
        try {
          const { relative, path } = resolveLocal();
          const buffer = fs.readBuffer(path);
          this.status = 200;
          this.statusText = 'OK';
          this.responseURL = path;
          this.readyState = 4;
          if (this.responseType === 'arraybuffer') {
            this.response = buffer;
            this.responseText = '';
          } else if (this.responseType === 'blob') {
            this.response = new Blob([buffer]);
            this.responseText = '';
          } else {
            const text = new TextDecoder().decode(buffer);
            this.responseText = text;
            this.response = this.responseType === 'json' ? JSON.parse(text) : text;
          }
          log(`[fs-xhr] 200 ${relative} bytes=${buffer.byteLength}`);
          ok = true;
        } catch (error) {
          this.status = 404;
          this.statusText = 'Not Found';
          this.readyState = 4;
          log(`[fs-xhr] 404 ${normalizeRelativePath(this.url)} error=${String(error)}`);
        }
        try {
          this.finish(ok);
        } catch (callbackError) {
          log(`[fs-xhr] callback FAILED ${normalizeRelativePath(this.url)} | ${String(callbackError)}`);
          // Match browser event behavior: report handler exceptions without
          // terminating the HOS process.
        }
      };
      const runAsync = async () => {
        if (this.aborted) return;
        let relative = normalizeRelativePath(this.url);
        let path = this.url;
        try {
          ({ relative, path } = resolveLocal());
          const buffer = await fs.readBufferAsync(path);
          if (this.aborted) return;
          this.status = 200;
          this.statusText = 'OK';
          this.responseURL = path;
          if (this.responseType === 'arraybuffer') {
            this.response = buffer;
            this.responseText = '';
          } else if (this.responseType === 'blob') {
            this.response = new Blob([buffer]);
            this.responseText = '';
          } else {
            const text = new TextDecoder().decode(buffer);
            this.responseText = text;
            this.response = this.responseType === 'json' ? JSON.parse(text) : text;
          }
          if (this.aborted) return;
          this.readyState = 4;
          log(`[fs-xhr] 200 async ${relative} bytes=${buffer.byteLength}`);
          try {
            this.finish(true);
          } catch (callbackError) {
            log(`[fs-xhr] callback FAILED ${relative} | ${String(callbackError)}`);
          }
        } catch (error) {
          if (this.aborted) return;
          this.status = 404;
          this.statusText = 'Not Found';
          this.readyState = 4;
          log(`[fs-xhr] 404 async ${relative} error=${String(error)}`);
          try {
            this.finish(false);
          } catch (callbackError) {
            log(`[fs-xhr] callback FAILED ${relative} | ${String(callbackError)}`);
          }
        }
      };
      if (this.async) queueMicrotask(() => { void runAsync(); });
      else runSync();
    }

    private fireReadyState() {
      const event = new Event('readystatechange');
      this.onreadystatechange?.(event);
      this.dispatchEvent(event);
    }

    private finish(ok: boolean) {
      this.fireReadyState();
      const event = new Event(ok ? 'load' : 'error');
      if (ok) this.onload?.(event); else this.onerror?.(event);
      this.dispatchEvent(event);
      const end = new Event('loadend');
      this.onloadend?.(end);
      this.dispatchEvent(end);
    }
  };
}
