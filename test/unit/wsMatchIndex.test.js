import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceHandshakeCursor,
  buildMatchIndexes,
  handshakeKey,
  lookupHandshakeRecording,
  lookupWsRecording,
  wsEndpointForNegotiate,
  wsPathKey,
} from '../../src/shared/matchIndex.js';
import { wsConnectionKey } from '../../src/shared/matchkey.js';
import { isGraphqlWs, isWsUrl, wsEndpointKey } from '../../src/shared/url.js';

const wsEntry = (id, url, matchKey, capturedAt = 1) => ({
  id,
  kind: 'ws',
  method: 'WS',
  url,
  matchKey,
  capturedAt,
});

const httpEntry = (id, method, url, matchKey, capturedAt = 1) => ({
  id,
  method,
  url,
  matchKey,
  capturedAt,
  status: 200,
});

test('WS connection keys ignore volatile query parameters', async () => {
  const a = await wsConnectionKey('wss://api.test/socket.io/?EIO=4&transport=websocket&sid=aaa');
  const b = await wsConnectionKey('wss://api.test/socket.io/?EIO=4&transport=websocket&sid=bbb');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('isWsUrl and wsEndpointKey describe WebSocket endpoints', () => {
  assert.equal(isWsUrl('wss://api.test/ws?token=1'), true);
  assert.equal(isWsUrl('https://api.test/ws'), false);
  assert.equal(wsEndpointKey('wss://api.test/ws?token=1'), 'wss://api.test/ws');
});

test('GraphQL WebSockets are detected by sub-protocol or URL', () => {
  assert.equal(isGraphqlWs({ url: 'wss://api.test/graphql', protocols: [] }), true);
  assert.equal(isGraphqlWs({ url: 'wss://api.test/ws', protocols: ['graphql-transport-ws'] }), true);
  assert.equal(isGraphqlWs({ url: 'wss://api.test/ws', protocols: ['chat'] }), false);
});

test('handshakeKey canonicalizes Socket.IO polling phases', () => {
  const open = handshakeKey('GET', 'https://api.test/socket.io/?EIO=4&transport=polling&t=abc123');
  const poll = handshakeKey('GET', 'https://api.test/socket.io/?EIO=4&transport=polling&t=def456&sid=xyz');
  const post = handshakeKey('POST', 'https://api.test/socket.io/?EIO=4&transport=polling&t=ghi&sid=xyz');
  const upgrade = handshakeKey('GET', 'https://api.test/socket.io/?EIO=4&transport=websocket&sid=xyz');

  assert.equal(open, 'GET https://api.test/socket.io/?EIO=4&transport=polling#open');
  assert.match(poll, /#poll$/);
  assert.match(post, /#post$/);
  assert.equal(upgrade, null);
  assert.equal(handshakeKey('GET', 'https://api.test/api/items'), null);
});

test('handshakeKey canonicalizes SignalR negotiate calls', () => {
  assert.equal(handshakeKey('POST', 'https://api.test/hub/negotiate?negotiateVersion=1'), 'POST https://api.test/hub/negotiate');
});

test('Socket.IO polling handshakes replay in recorded order through a cursor', () => {
  const entries = [
    httpEntry('open', 'GET', 'https://api.test/socket.io/?EIO=4&transport=polling&t=1', 'k-open', 10),
    httpEntry('poll1', 'GET', 'https://api.test/socket.io/?EIO=4&transport=polling&t=2&sid=s', 'k-poll1', 20),
    httpEntry('poll2', 'GET', 'https://api.test/socket.io/?EIO=4&transport=polling&t=3&sid=s', 'k-poll2', 30),
  ];
  const indexes = buildMatchIndexes(entries);
  const cursor = new Map();

  const first = lookupHandshakeRecording(indexes, { method: 'GET', url: 'https://api.test/socket.io/?EIO=4&transport=polling&t=9&sid=s' }, cursor);
  assert.equal(first.entry.id, 'poll1');
  advanceHandshakeCursor(cursor, first.key);

  const second = lookupHandshakeRecording(indexes, { method: 'GET', url: 'https://api.test/socket.io/?EIO=4&transport=polling&t=9&sid=s' }, cursor);
  assert.equal(second.entry.id, 'poll2');
  advanceHandshakeCursor(cursor, second.key);

  // Past the end of the bucket the last recording is served instead of failing.
  const third = lookupHandshakeRecording(indexes, { method: 'GET', url: 'https://api.test/socket.io/?EIO=4&transport=polling&t=9&sid=s' }, cursor);
  assert.equal(third.entry.id, 'poll2');

  const open = lookupHandshakeRecording(indexes, { method: 'GET', url: 'https://api.test/socket.io/?EIO=4&transport=polling&t=0' }, new Map());
  assert.equal(open.entry.id, 'open');
});

test('lookupWsRecording prefers the exact key, then a unique endpoint', () => {
  const exactKey = 'a'.repeat(64);
  const indexes = buildMatchIndexes([
    wsEntry('e1', 'wss://api.test/ws?sid=1', exactKey),
    wsEntry('e2', 'wss://other.test/chat', 'b'.repeat(64)),
  ]);

  const exact = lookupWsRecording(indexes, { url: 'wss://api.test/ws?sid=2', matchKey: exactKey });
  assert.equal(exact.entry.id, 'e1');
  assert.equal(exact.matchedVia, 'exact');

  const byPath = lookupWsRecording(indexes, { url: 'wss://other.test/chat?sid=9', matchKey: null });
  assert.equal(byPath.entry.id, 'e2');
  assert.equal(byPath.matchedVia, 'path');
  assert.equal(wsPathKey('wss://other.test/chat?sid=9'), 'WS wss://other.test/chat');
});

test('lookupWsRecording refuses to guess between several sockets on one endpoint', () => {
  const indexes = buildMatchIndexes([
    wsEntry('e1', 'wss://api.test/ws', 'c'.repeat(64)),
    wsEntry('e2', 'wss://api.test/ws', 'd'.repeat(64)),
  ]);
  const result = lookupWsRecording(indexes, { url: 'wss://api.test/ws', matchKey: 'e'.repeat(64) });
  assert.equal(result.entry, null);
  assert.equal(result.reason, 'ws-ambiguous-url');
});

test('lookupWsRecording reports a missing recording clearly', () => {
  const indexes = buildMatchIndexes([]);
  const result = lookupWsRecording(indexes, { url: 'wss://api.test/ws', matchKey: null });
  assert.equal(result.reason, 'ws-no-recording');
});


test('SignalR negotiate is only treated as a WS handshake when the hub was recorded', () => {
  const negotiate = httpEntry(
    'neg',
    'POST',
    'https://api.test/hub/negotiate?negotiateVersion=1',
    'n'.repeat(64),
    10,
  );
  const hub = {
    ...wsEntry('hub', 'wss://api.test/hub?access_token=abc', 'h'.repeat(64), 20),
    wsAdapter: 'signalr',
  };

  const withHub = buildMatchIndexes([negotiate, hub]);
  const hit = lookupHandshakeRecording(
    withHub,
    { method: 'POST', url: 'https://api.test/hub/negotiate?negotiateVersion=1' },
    new Map(),
  );
  assert.equal(hit?.entry.id, 'neg');

  // A scenario with no recorded hub keeps ordinary matching for /negotiate.
  const withoutHub = buildMatchIndexes([negotiate]);
  const miss = lookupHandshakeRecording(
    withoutHub,
    { method: 'POST', url: 'https://api.test/hub/negotiate?negotiateVersion=1' },
    new Map(),
  );
  assert.equal(miss, null);
});

test('wsEndpointForNegotiate maps the negotiate path to the hub endpoint', () => {
  assert.equal(wsEndpointForNegotiate('https://api.test/hub/negotiate'), 'WS wss://api.test/hub');
  assert.equal(wsEndpointForNegotiate('http://localhost:3000/chat/negotiate?x=1'), 'WS ws://localhost:3000/chat');
  assert.equal(wsEndpointForNegotiate('https://api.test/api/items'), null);
});

test('a new Socket.IO session resets the previous polling cursors', () => {
  const cursor = new Map();
  const pollKey = 'GET https://api.test/socket.io/?EIO=4&transport=polling#poll';
  const postKey = 'POST https://api.test/socket.io/?EIO=4&transport=polling#post';
  const openKey = 'GET https://api.test/socket.io/?EIO=4&transport=polling#open';
  cursor.set(pollKey, 3);
  cursor.set(postKey, 2);

  advanceHandshakeCursor(cursor, openKey);
  assert.equal(cursor.get(pollKey), undefined);
  assert.equal(cursor.get(postKey), undefined);
  assert.equal(cursor.get(openKey), 1);
});

test('negotiate gating accepts a trailing slash and rejects non-SignalR hubs', () => {
  const negotiate = httpEntry('neg', 'POST', 'https://api.test/hub/negotiate/', 'n'.repeat(64));
  const genericHub = { ...wsEntry('hub', 'wss://api.test/hub', 'h'.repeat(64)), wsAdapter: 'generic' };
  const signalrHub = { ...genericHub, wsAdapter: 'signalr' };

  assert.equal(
    lookupHandshakeRecording(buildMatchIndexes([negotiate, genericHub]), { method: 'POST', url: 'https://api.test/hub/negotiate/' }, new Map()),
    null,
  );
  const hit = lookupHandshakeRecording(
    buildMatchIndexes([negotiate, signalrHub]),
    { method: 'POST', url: 'https://api.test/hub/negotiate/' },
    new Map(),
  );
  assert.equal(hit?.entry.id, 'neg');
});
