import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
  WS_BRIDGE_NAME,
  WS_SHIM_SOURCE,
  WS_SHIM_SYMBOL,
  wsShimCommand,
} from '../../src/background/wsShim.js';

class FakeMessageEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.data = init.data;
  }
}

class FakeNativeWebSocket extends EventTarget {
  constructor(url, protocols) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.protocol = '';
    this.extensions = '';
    this.binaryType = 'blob';
    this.sent = [];
    this.closed = false;
    FakeNativeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }
}
FakeNativeWebSocket.instances = [];

/**
 * Execute the injected shim in a sandbox that looks enough like a page.
 */
function loadShim() {
  const calls = [];
  FakeNativeWebSocket.instances = [];
  const sandbox = {
    Event,
    EventTarget,
    DOMException,
    ArrayBuffer,
    Uint8Array,
    MessageEvent: FakeMessageEvent,
    Blob,
    URL,
    Symbol,
    btoa,
    atob,
    setTimeout,
    clearTimeout,
    console,
    location: { href: 'https://app.test/page' },
    WebSocket: FakeNativeWebSocket,
    [WS_BRIDGE_NAME]: (payload) => calls.push(JSON.parse(payload)),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WS_SHIM_SOURCE, sandbox, { filename: 'wsShim.js' });
  // Symbol-keyed globals created inside the context are not mirrored onto the
  // sandbox object, so read them back through the context itself.
  const api = vm.runInContext(`globalThis[Symbol.for(${JSON.stringify(WS_SHIM_SYMBOL)})]`, sandbox);
  return { sandbox, calls, api };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the shim installs a wrapper and deletes the binding', () => {
  const { sandbox } = loadShim();
  assert.notEqual(sandbox.WebSocket, FakeNativeWebSocket);
  assert.equal(sandbox[WS_BRIDGE_NAME], undefined);

  const socket = new sandbox.WebSocket('wss://api.test/socket.io/?EIO=4');
  assert.equal(socket.readyState, 0);
  assert.equal(socket.url, 'wss://api.test/socket.io/?EIO=4');
  assert.equal(sandbox.WebSocket.CONNECTING, 0);
  assert.equal(sandbox.WebSocket.prototype.OPEN, 1);
});

test('the shim reports every new socket to the worker', () => {
  const { sandbox, calls } = loadShim();
  new sandbox.WebSocket('/chat', ['chat']);
  new sandbox.WebSocket('/other');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, 'open');
  assert.equal(calls[0].url, 'https://app.test/chat');
  assert.deepEqual([...calls[0].protocols], ['chat']);
  assert.equal(calls[1].url, 'https://app.test/other');
});

test('mocked sockets fire open and deliver text frames', () => {
  const { sandbox, calls, api } = loadShim();
  const socket = new sandbox.WebSocket('wss://api.test/ws');
  const connId = calls[0].connId;

  const events = [];
  socket.addEventListener('open', () => events.push('open'));
  socket.onmessage = (event) => events.push(`message:${event.data}`);

  api.openResult(connId, { mock: true, protocol: 'chat' });
  assert.equal(socket.readyState, 1);
  assert.equal(socket.protocol, 'chat');

  api.deliver(connId, 1, 'hello', null);
  assert.deepEqual(events, ['open', 'message:hello']);
});

test('sends are queued in call order and reported with the right opcode', async () => {
  const { sandbox, calls, api } = loadShim();
  const socket = new sandbox.WebSocket('wss://api.test/ws');
  const connId = calls[0].connId;
  api.openResult(connId, { mock: true });

  socket.send('first');
  socket.send(new Uint8Array([1, 2, 3]).buffer);
  await tick();

  const sends = calls.filter((call) => call.cmd === 'send');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].opcode, 1);
  assert.equal(sends[0].text, 'first');
  assert.equal(sends[1].opcode, 2);
  assert.equal(Buffer.from(sends[1].base64, 'base64').toString('base64'), Buffer.from([1, 2, 3]).toString('base64'));
});

test('send before open throws and after close is ignored', () => {
  const { sandbox, calls, api } = loadShim();
  const socket = new sandbox.WebSocket('wss://api.test/ws');
  const connId = calls[0].connId;

  assert.throws(() => socket.send('too early'), /CONNECTING/);

  api.openResult(connId, { mock: true });
  api.closeSocket(connId, 1000, 'bye');
  assert.equal(socket.readyState, 2);
  assert.doesNotThrow(() => socket.send('ignored'));
});

test('page close is reported to the worker and fires a close event', async () => {
  const { sandbox, calls, api } = loadShim();
  const socket = new sandbox.WebSocket('wss://api.test/ws');
  const connId = calls[0].connId;
  api.openResult(connId, { mock: true });

  const closes = [];
  socket.addEventListener('close', (event) => closes.push([event.code, event.reason]));

  socket.close(4000, 'done');
  await tick();

  const closeCall = calls.find((call) => call.cmd === 'close');
  assert.equal(closeCall.code, 4000);
  assert.equal(closeCall.reason, 'done');
  assert.equal(socket.readyState, 3);
  assert.deepEqual(closes, [[4000, 'done']]);
});

test('unmatched connections pass through to the native WebSocket', () => {
  const { sandbox, calls, api } = loadShim();
  const socket = new sandbox.WebSocket('wss://api.test/ws');
  const connId = calls[0].connId;

  const events = [];
  socket.addEventListener('open', () => events.push('open'));
  socket.addEventListener('message', (event) => events.push(`message:${event.data}`));

  api.openResult(connId, { mock: false });
  const native = FakeNativeWebSocket.instances.at(-1);
  assert.ok(native, 'a native socket should have been created');
  assert.equal(native.url, 'wss://api.test/ws');

  native.dispatchEvent(new Event('open'));
  native.dispatchEvent(new FakeMessageEvent('message', { data: 'from-server' }));
  socket.send('to-server');

  assert.deepEqual(events, ['open', 'message:from-server']);
  assert.deepEqual(native.sent, ['to-server']);
});

test('closeAll closes every mocked socket with code 1001', async () => {
  const { sandbox, api } = loadShim();
  const first = new sandbox.WebSocket('wss://api.test/a');
  const second = new sandbox.WebSocket('wss://api.test/b');
  api.openResult(first.__state.id, { mock: true });
  api.openResult(second.__state.id, { mock: true });

  const closes = [];
  first.addEventListener('close', (event) => closes.push(event.code));
  second.addEventListener('close', (event) => closes.push(event.code));

  api.closeAll(1001, 'Replay stopped');
  await tick();
  assert.deepEqual(closes.sort(), [1001, 1001]);
});

test('wsShimCommand targets the symbol-keyed command surface', () => {
  const expression = wsShimCommand('deliver', ['ws-1', 1, 'hi', null]);
  assert.match(expression, /Symbol\.for\("api-recorder\.ws"\)/);
  assert.match(expression, /deliver\("ws-1", 1, "hi", null\)/);
});


test('re-installing after reset restores the mock and re-captures the bridge', () => {
  const { sandbox, calls, api } = loadShim();
  const first = new sandbox.WebSocket('wss://api.test/one');
  api.openResult(first.__state.id, { mock: true });
  assert.equal(calls.filter((call) => call.cmd === 'open').length, 1);

  // stopReplay(): reset + removeBinding, then startReplay(): addBinding + re-evaluate.
  api.reset();
  assert.equal(sandbox.WebSocket, FakeNativeWebSocket);
  sandbox[WS_BRIDGE_NAME] = (payload) => calls.push(JSON.parse(payload));
  vm.runInContext(WS_SHIM_SOURCE, sandbox, { filename: 'wsShim.js' });
  const reinstalled = vm.runInContext(
    `globalThis[Symbol.for(${JSON.stringify(WS_SHIM_SYMBOL)})]`,
    sandbox,
  );

  assert.notEqual(sandbox.WebSocket, FakeNativeWebSocket, 'shim must be installed again');
  assert.notEqual(reinstalled, api, 'a fresh command surface must own the new bridge');
  const second = new sandbox.WebSocket('wss://api.test/two');
  assert.equal(calls.filter((call) => call.cmd === 'open').length, 2);
  reinstalled.openResult(second.__state.id, { mock: true });
  assert.equal(second.readyState, 1);
});

test('the in-page error command surfaces unmatched frames without closing', () => {
  const { sandbox, calls, api } = loadShim();
  const socket = new sandbox.WebSocket('wss://api.test/ws');
  api.openResult(calls[0].connId, { mock: true });

  const errors = [];
  socket.addEventListener('error', (event) => errors.push(event.message));
  api.error(calls[0].connId, 'no recorded reply');

  assert.deepEqual(errors, ['no recorded reply']);
  assert.equal(socket.readyState, 1);
});
