/**
 * MAIN-world `WebSocket` shim.
 *
 * CDP has no `Fetch`-style interception for WebSockets, so replay needs a page
 * wrapper. The source below is injected with
 * `Page.addScriptToEvaluateOnNewDocument` (before any page script) and talks to
 * the service worker over a `Runtime.addBinding` function, which is captured and
 * deleted immediately so page code cannot call or see it.
 *
 * Commands from the service worker are delivered through
 * `globalThis[Symbol.for('api-recorder.ws')]`, a symbol-keyed object that is not
 * enumerable by ordinary page code.
 *
 * The shim is deliberately dependency free: Chrome executes this function in
 * the page, where no module scope is available.
 */

/** Binding name used by the service worker (`Runtime.addBinding`). */
export const WS_BRIDGE_NAME = '__apiRecorderWsBridge';

/** Symbol key of the service-worker -> page command surface. */
export const WS_SHIM_SYMBOL = 'api-recorder.ws';

/**
 * This function is serialized and injected into pages; it must stay entirely
 * self-contained (no imports, no module-level references).
 *
 * @param {string} bridgeName
 * @param {string} symbolKey
 */
function wsShimMain(bridgeName, symbolKey) {
  'use strict';

  const scope = globalThis;
  const installKey = Symbol.for(symbolKey);

  // Re-installing in the same document (stop -> start, scenario switch after a
  // service-worker restart) must replace the previous shim: its captured
  // binding is dead, and bailing out here would silently leave sockets on the
  // native constructor.
  const previous = scope[installKey];
  if (previous) {
    try {
      // reset() closes the old mocked sockets and puts the native constructor
      // back; closing without restoring would leave the wrapper installed with
      // no usable bridge.
      previous.reset();
    } catch {
      /* old shim may already be broken */
    }
    try {
      delete scope[installKey];
    } catch {
      /* ignore */
    }
  }

  const NativeWebSocket = scope.WebSocket;
  if (typeof NativeWebSocket !== 'function') return;

  let bridge = null;
  try {
    bridge = scope[bridgeName];
    delete scope[bridgeName];
  } catch {
    bridge = null;
  }
  if (typeof bridge !== 'function') return;

  const CONNECTING = 0;
  const OPEN = 1;
  const CLOSING = 2;
  const CLOSED = 3;

  let counter = 0;
  const sockets = new Map();

  function absolute(url) {
    try {
      return new URL(String(url), scope.location?.href || 'http://localhost/').toString();
    } catch {
      return String(url);
    }
  }

  function toBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return scope.btoa(binary);
  }

  function fromBase64(text) {
    const binary = scope.atob(String(text || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function sendBridge(payload) {
    try {
      bridge(JSON.stringify(payload));
    } catch {
      /* the worker is gone mid-replay */
    }
  }

  class MockWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      const state = {
        id: `ws-${++counter}`,
        url: absolute(url),
        protocols: normalizeProtocols(protocols),
        readyState: CONNECTING,
        protocol: '',
        extensions: '',
        bufferedAmount: 0,
        binaryType: 'blob',
        mock: false,
        native: null,
        queue: Promise.resolve(),
        closedByPage: false,
        timer: null,
      };
      sockets.set(state.id, this);
      this.__state = state;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;

      sendBridge({
        cmd: 'open',
        connId: state.id,
        url: state.url,
        protocols: state.protocols,
      });
    }

    get url() {
      return this.__state.url;
    }

    get readyState() {
      return this.__state.readyState;
    }

    get protocol() {
      return this.__state.protocol;
    }

    get extensions() {
      return this.__state.extensions;
    }

    get bufferedAmount() {
      return this.__state.bufferedAmount;
    }

    get binaryType() {
      return this.__state.binaryType;
    }

    set binaryType(value) {
      const next = value === 'arraybuffer' ? 'arraybuffer' : 'blob';
      this.__state.binaryType = next;
      if (this.__state.native) this.__state.native.binaryType = next;
    }

    send(data) {
      const state = this.__state;
      if (state.native) {
        state.native.send(data);
        return;
      }
      if (state.readyState === CONNECTING) {
        throw new DOMException('Still in CONNECTING state.', 'InvalidStateError');
      }
      if (state.readyState !== OPEN) return;

      // Keep async payload conversions (Blob) in call order.
      state.queue = state.queue.then(async () => {
        if (state.readyState !== OPEN) return;
        try {
          if (typeof data === 'string') {
            sendBridge({ cmd: 'send', connId: state.id, opcode: 1, text: data });
            return;
          }
          let bytes;
          if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
          else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          else if (typeof Blob === 'function' && data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
          else {
            sendBridge({ cmd: 'send', connId: state.id, opcode: 1, text: String(data) });
            return;
          }
          sendBridge({ cmd: 'send', connId: state.id, opcode: 2, base64: toBase64(bytes) });
        } catch (error) {
          fire(this, 'error', { type: 'error', message: String(error && error.message) });
        }
      });
    }

    close(code, reason) {
      const state = this.__state;
      if (state.native) {
        state.native.close(code, reason);
        return;
      }
      if (state.readyState === CLOSING || state.readyState === CLOSED) return;
      state.closedByPage = true;
      state.readyState = CLOSING;
      sendBridge({ cmd: 'close', connId: state.id, code: Number(code) || 1000, reason: String(reason || '') });
      const finish = () => {
        if (state.readyState === CLOSED) return;
        state.readyState = CLOSED;
        sockets.delete(state.id);
        fire(this, 'close', {
          type: 'close',
          code: Number(code) || 1000,
          reason: String(reason || ''),
          wasClean: true,
        });
      };
      setTimeout(finish, 0);
    }

    /** @param {string} type @param {any} event */
    __fire(type, event) {
      fire(this, type, event);
    }

    /** @param {any} options */
    __openMock(options) {
      const state = this.__state;
      if (state.readyState !== CONNECTING) return;
      state.mock = true;
      state.protocol = String(options?.protocol || '');
      state.extensions = String(options?.extensions || '');
      state.readyState = OPEN;
      fire(this, 'open', { type: 'open' });
    }

    /** @param {number} opcode @param {string} text @param {string} base64 */
    __deliver(opcode, text, base64) {
      const state = this.__state;
      if (state.readyState !== OPEN) return;
      let data;
      if (Number(opcode) === 2) {
        const bytes = fromBase64(base64);
        data = state.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]);
      } else {
        data = String(text ?? '');
      }
      fire(this, 'message', { type: 'message', data, origin: '', lastEventId: '' });
    }

    /** @param {string} message */
    __error(message) {
      fire(this, 'error', { type: 'error', message });
    }

    /** @param {number} code @param {string} reason */
    __closeFromServer(code, reason) {
      const state = this.__state;
      if (state.readyState === CLOSED) return;
      if (state.native) {
        state.native.close(code, reason);
        return;
      }
      state.readyState = CLOSING;
      const closeCode = Number(code) || 1000;
      const closeReason = String(reason || '');
      setTimeout(() => {
        if (state.readyState === CLOSED) return;
        state.readyState = CLOSED;
        sockets.delete(state.id);
        fire(this, 'close', { type: 'close', code: closeCode, reason: closeReason, wasClean: closeCode === 1000 });
      }, 0);
    }

    /** Connect the real socket and mirror its lifecycle onto this wrapper. */
    __passthrough() {
      const state = this.__state;
      if (state.native || state.readyState === CLOSED) return;
      let native;
      try {
        native = state.protocols.length > 0 ? new NativeWebSocket(state.url, state.protocols) : new NativeWebSocket(state.url);
      } catch (error) {
        state.readyState = CLOSED;
        sockets.delete(state.id);
        fire(this, 'error', { type: 'error', message: String(error && error.message) });
        fire(this, 'close', { type: 'close', code: 1006, reason: 'Could not open a real WebSocket', wasClean: false });
        return;
      }
      state.native = native;
      native.binaryType = state.binaryType;

      native.addEventListener('open', () => {
        state.protocol = native.protocol || '';
        state.extensions = native.extensions || '';
        state.readyState = OPEN;
        fire(this, 'open', { type: 'open' });
      });
      native.addEventListener('message', (event) => {
        fire(this, 'message', { type: 'message', data: event.data, origin: '', lastEventId: '' });
      });
      native.addEventListener('error', (event) => {
        fire(this, 'error', { type: 'error', message: String(event?.message || 'WebSocket error') });
      });
      native.addEventListener('close', (event) => {
        state.readyState = CLOSED;
        state.mock = false;
        state.native = null;
        sockets.delete(state.id);
        fire(this, 'close', {
          type: 'close',
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
      });
    }
  }

  function normalizeProtocols(protocols) {
    if (protocols == null) return [];
    if (Array.isArray(protocols)) return protocols.map(String);
    return [String(protocols)];
  }

  function fire(target, type, init) {
    let event;
    try {
      if (type === 'message' && typeof MessageEvent === 'function') {
        event = new MessageEvent('message', { data: init && init.data });
      } else if (type === 'close' && typeof CloseEvent === 'function') {
        event = new CloseEvent('close', {
          code: init && init.code,
          reason: init && init.reason,
          wasClean: Boolean(init && init.wasClean),
        });
      } else {
        event = new Event(type);
        // Event properties are read-only; attach diagnostics defensively so a
        // page that reads event.code/reason still sees them.
        const extras = init || {};
        for (const key of ['message', 'code', 'reason', 'wasClean']) {
          if (extras[key] === undefined) continue;
          try {
            Object.defineProperty(event, key, { value: extras[key], configurable: true });
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      event = { type, ...(init || {}) };
    }
    try {
      target.dispatchEvent(event);
    } catch {
      /* a page listener threw; the platform must not care */
    }
    const handler = target[`on${type}`];
    if (typeof handler === 'function') {
      try {
        handler.call(target, event);
      } catch {
        /* keep the socket alive */
      }
    }
  }

  MockWebSocket.CONNECTING = CONNECTING;
  MockWebSocket.OPEN = OPEN;
  MockWebSocket.CLOSING = CLOSING;
  MockWebSocket.CLOSED = CLOSED;
  MockWebSocket.prototype.CONNECTING = CONNECTING;
  MockWebSocket.prototype.OPEN = OPEN;
  MockWebSocket.prototype.CLOSING = CLOSING;
  MockWebSocket.prototype.CLOSED = CLOSED;

  const api = {
    /** Name of the bridge this shim captured; lets the worker detect a stale shim. */
    bindingName: bridgeName,
    openResult(connId, options) {
      const socket = sockets.get(String(connId));
      if (!socket) return;
      if (options && options.mock) socket.__openMock(options);
      else socket.__passthrough();
    },
    deliver(connId, opcode, text, base64) {
      const socket = sockets.get(String(connId));
      if (socket) socket.__deliver(opcode, text, base64);
    },
    closeSocket(connId, code, reason) {
      const socket = sockets.get(String(connId));
      if (socket) socket.__closeFromServer(code, reason);
    },
    closeAll(code, reason) {
      for (const socket of [...sockets.values()]) {
        // Only mocked sockets are ours to close; passthrough sockets belong to
        // the page and to the real server.
        if (socket.__state.native) continue;
        socket.__closeFromServer(code, reason);
      }
    },
    error(connId, message) {
      const socket = sockets.get(String(connId));
      if (socket) socket.__error(String(message || 'WebSocket replay error'));
    },
    reset() {
      for (const socket of [...sockets.values()]) {
        if (socket.__state.native) continue;
        socket.__closeFromServer(1001, 'Replay stopped');
      }
      scope.WebSocket = NativeWebSocket;
      // Leave no installed-shim marker behind: the next install must rebuild
      // the bridge, not bail out on a stale symbol.
      try {
        delete scope[installKey];
      } catch {
        /* ignore */
      }
    },
    socketCount() {
      return sockets.size;
    },
  };

  scope[installKey] = api;
  scope.WebSocket = MockWebSocket;
}

/**
 * The injectable script. `function.toString()` keeps the shim and its helpers in
 * one self-contained expression.
 */
export const WS_SHIM_SOURCE = wsShimSource(WS_BRIDGE_NAME);

/**
 * Build the injectable script for a specific binding name.
 *
 * Replay uses a fresh, unguessable name per session: a binding that the shim
 * already deleted cannot be recreated by calling `Runtime.addBinding` again
 * with the same name, so a unique name is what makes a second session work
 * without a page reload.
 *
 * @param {string} bindingName
 */
export function wsShimSource(bindingName) {
  return `(${wsShimMain.toString()})(${JSON.stringify(String(bindingName))}, ${JSON.stringify(WS_SHIM_SYMBOL)});`;
}

/**
 * Expression that runs one command against the installed shim.
 * @param {string} method
 * @param {any[]} args
 */
export function wsShimCommand(method, args = []) {
  return `globalThis[Symbol.for(${JSON.stringify(WS_SHIM_SYMBOL)})]?.${method}(${args
    .map((arg) => JSON.stringify(arg ?? null))
    .join(', ')});`;
}
