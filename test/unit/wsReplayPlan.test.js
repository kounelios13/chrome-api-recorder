import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compileReplayPlan,
  deliveryDelay,
  frameTextForDelivery,
  matchReplayStep,
  normalizeFrames,
  prepareResponses,
  socketKey,
  synthesizeSocketIoConnect,
} from '../../src/shared/wsReplayPlan.js';
import { adapterByName } from '../../src/shared/wsAdapters/index.js';

/** @param {object[]} frames */
const planFor = (frames, adapter = 'socketio') => compileReplayPlan({ frames, adapter });

test('normalizeFrames splits SignalR packed frames into logical messages', () => {
  const messages = normalizeFrames(
    [
      {
        seq: 0,
        direction: 'recv',
        opcode: 1,
        offsetMs: 5,
        text: '{"type":6}\u001e{"type":2,"item":1}\u001e',
      },
    ],
    adapterByName('signalr'),
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[1].text, '{"type":2,"item":1}');
});

test('compileReplayPlan separates open prelude from request steps', () => {
  const plan = planFor([
    { seq: 0, direction: 'recv', opcode: 1, offsetMs: 0, text: '40{"sid":"abc"}' },
    { seq: 1, direction: 'send', opcode: 1, offsetMs: 20, text: '42["orders"]' },
    { seq: 2, direction: 'recv', opcode: 1, offsetMs: 40, text: '42["orders",[1,2]]' },
    { seq: 3, direction: 'send', opcode: 1, offsetMs: 80, text: '42["users"]' },
    { seq: 4, direction: 'recv', opcode: 1, offsetMs: 90, text: '42["users",[]]' },
  ]);

  assert.equal(plan.prelude.length, 1);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].trigger.text, '42["orders"]');
  assert.deepEqual(plan.steps[0].responses.map((r) => r.text), ['42["orders",[1,2]]']);
  assert.equal(plan.steps[1].responses[0].text, '42["users",[]]');
});

test('compileReplayPlan drops recorded keepalives from the replay plan', () => {
  const plan = planFor([
    { seq: 0, direction: 'send', opcode: 1, offsetMs: 0, text: '42["a"]' },
    { seq: 1, direction: 'recv', opcode: 1, offsetMs: 1, text: '2' },
  ]);
  assert.deepEqual(plan.steps[0].responses, []);
});

test('exact frame matches win and are consumed once', () => {
  const plan = planFor([
    { seq: 0, direction: 'send', opcode: 1, offsetMs: 0, text: '42["a",1]' },
    { seq: 1, direction: 'recv', opcode: 1, offsetMs: 1, text: '43[1]' },
    { seq: 2, direction: 'send', opcode: 1, offsetMs: 5, text: '42["a",1]' },
    { seq: 3, direction: 'recv', opcode: 1, offsetMs: 6, text: '43[2]' },
  ]);

  const used = new Set();
  const first = matchReplayStep(plan, { opcode: 1, text: '42["a",1]', base64: null }, { used });
  assert.equal(first.matchedVia, 'exact');
  assert.equal(first.step.index, 0);
  used.add(first.step.index);

  const second = matchReplayStep(plan, { opcode: 1, text: '42["a",1]', base64: null }, { used });
  assert.equal(second.step.index, 1);
});

test('ack ids are rewritten when a signature match is used', () => {
  const plan = planFor([
    { seq: 0, direction: 'send', opcode: 1, offsetMs: 0, text: '423["getOrders",{"page":2}]' },
    { seq: 1, direction: 'recv', opcode: 1, offsetMs: 10, text: '433[{"id":1}]' },
  ]);

  const match = matchReplayStep(plan, { opcode: 1, text: '427["getOrders",{"page":2}]', base64: null }, {});
  assert.equal(match.matchedVia, 'signature');

  const responses = prepareResponses(plan.adapter, match.step, match.liveSignature);
  assert.equal(responses[0].text, '437[{"id":1}]');
});

test('smartFallback can be disabled so only exact frames match', () => {
  const plan = planFor([
    { seq: 0, direction: 'send', opcode: 1, offsetMs: 0, text: '42["ev",1]' },
    { seq: 1, direction: 'recv', opcode: 1, offsetMs: 1, text: '42["ev",2]' },
  ]);
  const match = matchReplayStep(plan, { opcode: 1, text: '42["ev",9]', base64: null }, { smartFallback: false });
  assert.equal(match, null);
});

test('binary frames match byte for byte', () => {
  const plan = planFor([
    { seq: 0, direction: 'send', opcode: 1, offsetMs: 0, text: '451-["file",{"n":1}]' },
    { seq: 1, direction: 'recv', opcode: 2, offsetMs: 1, base64: 'AAEC' },
  ]);
  const match = matchReplayStep(plan, { opcode: 1, text: '451-["file",{"n":1}]', base64: null }, {});
  assert.equal(match.step.index, 0);
  assert.equal(match.step.responses[0].base64, 'AAEC');

  const binaryTrigger = planFor([
    { seq: 0, direction: 'send', opcode: 2, offsetMs: 0, base64: 'AAEC' },
    { seq: 1, direction: 'recv', opcode: 1, offsetMs: 1, text: 'ok' },
  ]);
  const binaryMatch = matchReplayStep(binaryTrigger, { opcode: 2, text: null, base64: 'AAEC' }, {});
  assert.equal(binaryMatch.matchedVia, 'exact');
});

test('SignalR invocation steps match by target and arguments', () => {
  const plan = planFor(
    [
      { seq: 0, direction: 'send', opcode: 1, offsetMs: 0, text: '{"type":1,"invocationId":"1","target":"Get","arguments":[7]}\u001e' },
      { seq: 1, direction: 'recv', opcode: 1, offsetMs: 2, text: '{"type":3,"invocationId":"1","result":"ok"}\u001e' },
    ],
    'signalr',
  );

  const match = matchReplayStep(plan, { opcode: 1, text: '{"type":1,"invocationId":"42","target":"Get","arguments":[7]}', base64: null });
  assert.equal(match.matchedVia, 'signature');
  const responses = prepareResponses(plan.adapter, match.step, match.liveSignature);
  assert.equal(responses[0].text, '{"type":3,"invocationId":"42","result":"ok"}');
});

test('deliveryDelay honors capped, original and instant timing', () => {
  const trigger = { offsetMs: 100 };
  assert.equal(deliveryDelay({ timing: 'capped', maxDelayMs: 1500 }, trigger, { offsetMs: 5000 }), 1500);
  assert.equal(deliveryDelay({ timing: 'original' }, trigger, { offsetMs: 5000 }), 4900);
  assert.equal(deliveryDelay({ timing: 'instant' }, trigger, { offsetMs: 5000 }), 0);
  assert.equal(deliveryDelay({ timing: 'capped', maxDelayMs: 1500 }, trigger, { offsetMs: 50 }), 0);
});

test('Socket.IO namespace connects are synthesized when no recorded reply exists', () => {
  assert.equal(synthesizeSocketIoConnect('40'), '40{"sid":"replay-sid"}');
  assert.equal(synthesizeSocketIoConnect('40/admin,'), '40/admin,{"sid":"replay-sid"}');
  assert.equal(synthesizeSocketIoConnect('42["x"]'), null);
});


test('SignalR messages regain their record separator on delivery', () => {
  const message = '{"type":3,"invocationId":"1","result":"ok"}';
  assert.equal(frameTextForDelivery('signalr', message), `${message}\u001e`);
  // Keepalives already carry the separator; never double-terminate them.
  assert.equal(frameTextForDelivery('signalr', '{"type":6}\u001e'), '{"type":6}\u001e');
  assert.equal(frameTextForDelivery('socketio', '42["hi"]'), '42["hi"]');
  assert.equal(frameTextForDelivery('generic', '{"a":1}'), '{"a":1}');
});

test('a compiled SignalR plan delivers terminated frames', () => {
  const plan = planFor(
    [
      { seq: 0, direction: 'send', opcode: 1, offsetMs: 0, text: '{"type":1,"invocationId":"1","target":"Ping","arguments":[]}\u001e' },
      { seq: 1, direction: 'recv', opcode: 1, offsetMs: 2, text: '{"type":3,"invocationId":"1","result":"pong"}\u001e' },
    ],
    'signalr',
  );
  const delivered = plan.steps[0].responses.map((response) =>
    frameTextForDelivery(plan.adapter, response.text ?? ''),
  );
  assert.equal(delivered[0], '{"type":3,"invocationId":"1","result":"pong"}\u001e');
  assert.equal(delivered[0].endsWith('\u001e'), true);
});

test('socket keys keep identical per-frame connection ids apart', () => {
  // The shim numbers sockets per execution context, so every frame reports ws-1.
  assert.notEqual(socketKey(11, 'ws-1'), socketKey(12, 'ws-1'));
  assert.equal(socketKey(11, 'ws-1'), socketKey(11, 'ws-1'));
  assert.equal(socketKey(null, 'ws-1'), 'main:ws-1');
});

test('a direct Socket.IO connection keeps the Engine.IO open packet in the prelude', () => {
  const plan = planFor([
    { seq: 0, direction: 'recv', opcode: 1, offsetMs: 0, text: '0{"sid":"abc","pingInterval":25000}' },
    { seq: 1, direction: 'send', opcode: 1, offsetMs: 10, text: '40' },
    { seq: 2, direction: 'recv', opcode: 1, offsetMs: 12, text: '40{"sid":"abc"}' },
  ]);
  assert.equal(plan.prelude.length, 1);
  assert.match(plan.prelude[0].text, /^0\{/);
  assert.equal(plan.steps.length, 1);
});

test('post-upgrade Socket.IO pushes stay attached to the 5 upgrade step', () => {
  const plan = planFor([
    { seq: 0, direction: 'send', opcode: 1, offsetMs: 0, text: '2probe' },
    { seq: 1, direction: 'recv', opcode: 1, offsetMs: 1, text: '3probe' },
    { seq: 2, direction: 'send', opcode: 1, offsetMs: 2, text: '5' },
    { seq: 3, direction: 'recv', opcode: 1, offsetMs: 3, text: '42["push",1]' },
  ]);
  const upgrade = plan.steps.find((step) => step.trigger.text === '5');
  assert.ok(upgrade, 'the upgrade must be a matchable step');
  assert.equal(upgrade.responses[0].text, '42["push",1]');
});

test('a rejected SignalR handshake is captured for the synthetic reply', () => {
  const plan = planFor(
    [
      { seq: 0, direction: 'send', opcode: 1, offsetMs: 0, text: '{"protocol":"json","version":1}\u001e' },
      { seq: 1, direction: 'recv', opcode: 1, offsetMs: 1, text: '{"error":"Requested protocol is not supported"}\u001e' },
    ],
    'signalr',
  );
  assert.match(plan.handshakeResponse, /not supported/);
  assert.deepEqual(plan.prelude, []);
  assert.equal(plan.steps.length, 1);
});
