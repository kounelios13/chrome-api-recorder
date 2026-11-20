/**
 * Minimal Chrome DevTools Protocol client over `--remote-debugging-pipe`.
 *
 * Chrome communicates null-terminated JSON over file descriptors 3 (client ->
 * browser) and 4 (browser -> client). Using the pipe avoids a WebSocket
 * dependency, so the test suite has zero npm dependencies.
 */
import { spawn } from 'node:child_process';

export class CdpClient {
  /** @param {import('node:child_process').ChildProcess} child */
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();
    /** @type {Set<object>} */
    this.waiters = new Set();
    this.buffer = '';
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', (chunk) => this.handleData(chunk));
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId]
   * @param {number} [timeoutMs]
   */
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try {
        this.child.stdio[3].write(`${JSON.stringify(payload)}\0`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /**
   * Wait for one CDP event.
   * @param {string} method
   * @param {{sessionId?: string, predicate?: (params:any)=>boolean, timeoutMs?: number}} [options]
   */
  waitForEvent(method, { sessionId, predicate = () => true, timeoutMs = 20000 } = {}) {
    const key = `${sessionId ?? ''}:${method}`;
    return new Promise((resolve, reject) => {
      const waiter = {
        key,
        predicate,
        resolve: (params) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(params);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`CDP event timed out: ${method}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /**
   * Subscribe to a CDP event for a session.
   * @param {string} method
   * @param {(params: any) => void} handler
   * @param {string} [sessionId]
   * @returns {() => void} unsubscribe
   */
  on(method, handler, sessionId) {
    const key = `${sessionId ?? ''}:${method}`;
    const current = this.listeners.get(key) ?? [];
    current.push(handler);
    this.listeners.set(key, current);
    return () => {
      const list = this.listeners.get(key) ?? [];
      this.listeners.set(
        key,
        list.filter((entry) => entry !== handler),
      );
    };
  }

  /** @param {Buffer|string} chunk */
  handleData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf('\0');
      if (index === -1) break;
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!raw.trim()) continue;

      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  /** @param {any} message */
  handleMessage(message) {
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`${message.error.message ?? 'CDP error'} (${message.error.code ?? '?'})`));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method === 'string') {
      const key = `${message.sessionId ?? ''}:${message.method}`;
      for (const waiter of [...this.waiters]) {
        if (waiter.key === key && waiter.predicate(message.params)) waiter.resolve(message.params);
      }
      for (const listener of this.listeners.get(key) ?? []) listener(message.params);
    }
  }

  /** Stop the browser process. */
  close() {
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Launch Chrome with remote debugging enabled over a pipe.
 * @param {{binary: string, args: string[]}} options
 */
export function launchChrome({ binary, args }) {
  const child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  });

  /** @type {string[]} */
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr.push(chunk);
    if (stderr.length > 200) stderr.shift();
  });

  const client = new CdpClient(child);

  return {
    child,
    client,
    stderrText: () => stderr.join(''),
    stop: () => {
      client.close();
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    },
  };
}
