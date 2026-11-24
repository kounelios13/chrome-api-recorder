import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adapterByName, detectAdapter } from '../../src/shared/wsAdapters/index.js';
import { parseSocketIoPacket, serializeSocketIoPacket } from '../../src/shared/wsAdapters/socketio.js';
import {
  joinSignalRMessages,
  splitSignalRMessages,
} from '../../src/shared/wsAdapters/signalr.js';
import generic from '../../src/shared/wsAdapters/generic.js';

test('detectAdapter prefers Socket.IO when the URL or frames say so', () => {
  assert.equal(detectAdapter({ url: 'wss://api.test/socket.io/?EIO=4&transport=websocket' }).name, 'socketio');
  assert.equal(detectAdapter({ url: 'wss://api.test/ws', firstSentFrame: '2probe' }).name, 'socketio');
});

test('detectAdapter recognizes the SignalR protocol handshake', () => {
  const adapter = detectAdapter({
    url: 'wss://api.test/hub',
    firstSentFrame: '{"protocol":"json","version":1}\u001e',
  });
  assert.equal(adapter.name, 'signalr');
});

test('detectAdapter falls back to generic for plain WebSockets', () => {
  assert.equal(detectAdapter({ url: 'wss://api.test/ws', firstSentFrame: 'hello' }).name, 'generic');
  assert.equal(adapterByName('nope').name, 'generic');
});

test('Socket.IO packet parser understands namespaces and ack ids', () => {
  const packet = parseSocketIoPacket('42/orders,7["getOrders",{"page":2}]');
  assert.equal(packet.engine, '4');
  assert.equal(packet.kind, '2');
  assert.equal(packet.namespace, '/orders');
  assert.equal(packet.ackId, '7');
  assert.deepEqual(packet.data, ['getOrders', { page: 2 }]);
  assert.equal(serializeSocketIoPacket(packet, '9'), '42/orders,9["getOrders",{"page":2}]');
});

test('Socket.IO matching ignores the ack id and rewrites it in the ack reply', () => {
  const socketio = adapterByName('socketio');
  const recorded = '423["getOrders",123]';
  const live = '427["getOrders",123]';

  const recordedSignature = socketio.matchSignature(recorded);
  const liveSignature = socketio.matchSignature(live);
  assert.equal(recordedSignature.key, liveSignature.key);
  assert.equal(recordedSignature.correlationId, '3');
  assert.equal(liveSignature.correlationId, '7');

  const rewritten = socketio.rewriteCorrelationId('433[{"id":1}]', '3', '7');
  assert.equal(rewritten, '437[{"id":1}]');
});

test('Socket.IO keeps the payload bytes when rewriting an ack', () => {
  const socketio = adapterByName('socketio');
  const rewritten = socketio.rewriteCorrelationId('4312[{"total":5}]', '12', '99');
  const parsed = parseSocketIoPacket(rewritten);
  assert.equal(parsed.ackId, '99');
  assert.equal(parsed.rawTail, '[{"total":5}]');
});

test('Socket.IO handshake control messages are answered synthetically', () => {
  const socketio = adapterByName('socketio');
  assert.deepEqual(socketio.handleControlMessage('2probe'), ['3probe']);
  assert.deepEqual(socketio.handleControlMessage('2'), ['3']);
  assert.equal(socketio.handleControlMessage('3'), null);
  assert.equal(socketio.handleControlMessage('40'), null);
  assert.equal(socketio.isControlOrKeepalive('2', 'send'), true);
  assert.equal(socketio.isControlOrKeepalive('42["ev"]', 'send'), false);
});

test('Socket.IO keepalive pings the client on Engine.IO v4 connections', () => {
  const socketio = adapterByName('socketio');
  const sent = [];
  const stop = socketio.startKeepalive({ pingIntervalMs: 1000 }, (frame) => sent.push(frame));
  assert.equal(typeof stop, 'function');
  stop();
  assert.deepEqual(socketio.handleControlMessage('3'), null);
});

test('SignalR frames may pack several \\u001e-delimited messages', () => {
  const frame = '{"type":1,"invocationId":"1","target":"A","arguments":[]}\u001e{"type":6}\u001e';
  assert.deepEqual(splitSignalRMessages(frame), [
    '{"type":1,"invocationId":"1","target":"A","arguments":[]}',
    '{"type":6}',
  ]);
  assert.equal(joinSignalRMessages(['{"type":6}']), '{"type":6}\u001e');
});

test('SignalR handshake, keepalive and invocation matching', () => {
  const signalr = adapterByName('signalr');
  assert.deepEqual(signalr.handleControlMessage('{"protocol":"json","version":1}\u001e'), ['{}\u001e']);
  assert.equal(signalr.handleControlMessage('{"type":6}\u001e'), null);
  assert.equal(signalr.isControlOrKeepalive('{"type":7}\u001e', 'recv'), true);

  const signature = signalr.matchSignature('{"type":1,"invocationId":"5","target":"GetOrders","arguments":[{"mine":true}]}');
  assert.equal(signature.correlationId, '5');
  assert.match(signature.key, /GetOrders/);
});

test('SignalR rewrites invocation ids on StreamItem and Completion frames', () => {
  const signalr = adapterByName('signalr');
  const rewritten = signalr.rewriteCorrelationId(
    '{"type":3,"invocationId":"2","result":1}\u001e',
    '2',
    '9',
  );
  assert.equal(rewritten, '{"type":3,"invocationId":"9","result":1}');
  // StreamItem without a matching id is left untouched.
  assert.equal(
    signalr.rewriteCorrelationId('{"type":2,"invocationId":"4","item":1}', '2', '9'),
    '{"type":2,"invocationId":"4","item":1}',
  );
});

test('generic JSON matching ignores common correlation ids', () => {
  const recorded = generic.matchSignature('{"action":"get","id":11,"payload":{"a":1}}');
  const live = generic.matchSignature('{"action":"get","id":77,"payload":{"a":1}}');
  assert.equal(recorded.key, live.key);
  assert.equal(recorded.correlationId, '11');
  assert.equal(live.correlationId, '77');
});

test('generic JSON responses are rewritten when they echo the request id', () => {
  assert.equal(
    generic.rewriteCorrelationId('{"id":11,"result":"ok"}', '11', '77'),
    '{"id":77,"result":"ok"}',
  );
  assert.equal(generic.rewriteCorrelationId('{"id":5}', '11', '77'), '{"id":5}');
});

test('prettyPrint keeps unparseable payloads intact', () => {
  assert.equal(adapterByName('socketio').prettyPrint('not-a-packet'), 'not-a-packet');
  assert.match(adapterByName('signalr').prettyPrint('{"type":6}'), /"type": 6/);
  assert.match(adapterByName('generic').prettyPrint('{"a":1}'), /"a": 1/);
});
