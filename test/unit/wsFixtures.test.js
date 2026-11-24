/**
 * Protocol-level tests for the e2e fixture server.
 *
 * These run without Chrome: they prove the RFC 6455 handshake, raw echo, the
 * Socket.IO polling + upgrade sequence and the SignalR hub behave as the
 * browser scenarios will assume, so a failing e2e run is the extension's fault
 * rather than the fixture's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from '../e2e/server.mjs';

const hasWebSocket = typeof WebSocket === 'function';
const skip = hasWebSocket ? false : 'Node has no global WebSocket client';

/** @param {WebSocket} socket */
function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', (event) => reject(new Error(`websocket error: ${event?.message ?? 'unknown'}`)), {
      once: true,
    });
  });
}

/** @param {WebSocket} socket @param {number} [timeoutMs] */
function nextMessage(socket, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        resolve(event.data);
      },
      { once: true },
    );
  });
}

/** @param {string} httpOrigin */
function wsOrigin(httpOrigin) {
  return httpOrigin.replace(/^http/, 'ws');
}

test('fixture server: raw WebSocket echo, binary and close', { skip }, async () => {
  const server = await startTestServer();
  const socket = new WebSocket(`${wsOrigin(server.origin)}/ws/echo`);
  socket.binaryType = 'arraybuffer';

  try {
    await opened(socket);
    assert.equal(await nextMessage(socket), 'hello-v1');

    socket.send('ping');
    assert.equal(await nextMessage(socket), 'echo:ping');

    const bytes = new Uint8Array([0, 255, 254, 195, 40, 128, 65]);
    socket.send(bytes);
    const echoed = new Uint8Array(await nextMessage(socket));
    assert.deepEqual([...echoed], [...bytes]);

    socket.send('bye');
    const closed = await new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
    assert.equal(closed.code, 1000);
    assert.equal(server.hitsOf('UPGRADE', '/ws/echo'), 1);
  } finally {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    await server.close();
  }
});

test('fixture server: Socket.IO polling handshake, upgrade and event echo', { skip }, async () => {
  const server = await startTestServer();

  try {
    const openResponse = await fetch(`${server.origin}/socket.io/?EIO=4&transport=polling&t=1`);
    const openPacket = await openResponse.text();
    assert.match(openPacket, /^0\{/);
    const { sid } = JSON.parse(openPacket.slice(1));
    assert.ok(sid);

    const connectResponse = await fetch(`${server.origin}/socket.io/?EIO=4&transport=polling&t=2&sid=${sid}`);
    const connectPacket = await connectResponse.text();
    assert.match(connectPacket, /^40\{/);

    const post = await fetch(`${server.origin}/socket.io/?EIO=4&transport=polling&t=3&sid=${sid}`, {
      method: 'POST',
      body: '40',
    });
    assert.equal(await post.text(), 'ok');

    const socket = new WebSocket(`${wsOrigin(server.origin)}/socket.io/?EIO=4&transport=websocket&sid=${sid}`);
    try {
      await opened(socket);
      socket.send('2probe');
      assert.equal(await nextMessage(socket), '3probe');

      socket.send('5');
      const welcomeFrame = String(await nextMessage(socket));
      assert.equal(welcomeFrame.slice(0, 2), '42', 'Socket.IO events are Engine.IO messages');
      const welcome = JSON.parse(welcomeFrame.slice(2));
      assert.equal(welcome[0], 'welcome');
      assert.equal(welcome[1].version, 'v1');

      socket.send('42["echo",{"id":7}]');
      const echoedFrame = String(await nextMessage(socket));
      assert.equal(echoedFrame.slice(0, 2), '42');
      const echoed = JSON.parse(echoedFrame.slice(2));
      assert.equal(echoed[0], 'echoed');
      assert.equal(echoed[1].id, 7);
      assert.equal(echoed[1].version, 'v1');
    } finally {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }

    // The fixture reports a new version after a "deploy".
    server.state.version = 'v2';
    const reconnect = await fetch(`${server.origin}/socket.io/?EIO=4&transport=polling&t=4`);
    assert.match(await reconnect.text(), /^0\{/);
  } finally {
    await server.close();
  }
});

test('fixture server: SignalR negotiate, handshake and batched invocation reply', { skip }, async () => {
  const server = await startTestServer();

  try {
    const negotiate = await fetch(`${server.origin}/hub/negotiate?negotiateVersion=1`, { method: 'POST' });
    const negotiation = await negotiate.json();
    assert.equal(negotiation.negotiateVersion, 1);
    assert.ok(negotiation.connectionToken);

    const socket = new WebSocket(`${wsOrigin(server.origin)}/hub`, ['json']);
    try {
      await opened(socket);
      socket.send('{"protocol":"json","version":1}\u001e');
      assert.equal(await nextMessage(socket), '{}\u001e');

      socket.send('{"type":1,"invocationId":"9","target":"Echo","arguments":[1,2]}\u001e');
      const frame = await nextMessage(socket);
      assert.ok(String(frame).endsWith('\u001e'), 'server frames must be terminated');

      const messages = String(frame)
        .split('\u001e')
        .filter(Boolean)
        .map((part) => JSON.parse(part));
      assert.equal(messages.length, 2, 'a single frame may carry several SignalR messages');
      assert.equal(messages[0].type, 2);
      assert.equal(messages[0].invocationId, '9');
      assert.equal(messages[1].type, 3);
      assert.deepEqual(messages[1].result.echo, [1, 2]);
      assert.equal(messages[1].result.version, 'v1');
    } finally {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  } finally {
    await server.close();
  }
});

test('fixture server: upgrades can be disabled to prove offline replay', { skip }, async () => {
  const server = await startTestServer();
  server.state.wsEnabled = false;

  try {
    const socket = new WebSocket(`${wsOrigin(server.origin)}/ws/echo`);
    const failed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 3000);
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        resolve('error');
      });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        resolve('close');
      });
    });
    assert.notEqual(failed, 'timeout');
    assert.equal(server.hitsOf('UPGRADE', '/ws/echo'), 1);
  } finally {
    await server.close();
  }
});
