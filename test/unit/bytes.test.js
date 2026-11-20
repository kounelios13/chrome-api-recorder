import { test } from 'node:test';
import assert from 'node:assert/strict';

import { base64ToBytes, bytesPreview, bytesToBase64, bytesToUtf8, looksLikeText, utf8ToBytes, utf8ByteLength } from '../../src/shared/bytes.js';
import { newScenario, normalizeScenarioName } from '../../src/shared/scenarios.js';

test('utf8 <-> bytes round trip', () => {
  const text = 'héllo 🌍 — {"id":1}';
  assert.equal(bytesToUtf8(utf8ToBytes(text)), text);
});

test('base64 round trip for arbitrary bytes', () => {
  const bytes = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) bytes[index] = index;
  const encoded = bytesToBase64(bytes);
  assert.deepEqual([...base64ToBytes(encoded)], [...bytes]);
});

test('base64 round trip for an empty body', () => {
  assert.equal(bytesToBase64(new Uint8Array(0)), '');
  assert.equal(base64ToBytes('').length, 0);
});

test('bytesPreview collapses whitespace and truncates', () => {
  assert.equal(bytesPreview(utf8ToBytes('a\n\n  b\t c')), 'a b c');
  const preview = bytesPreview(utf8ToBytes('x'.repeat(50)), 10);
  assert.equal(preview.length, 10);
  assert.ok(preview.endsWith('…'));
});

test('looksLikeText distinguishes text from binary', () => {
  assert.equal(looksLikeText(utf8ToBytes('{"ok":true}')), true);
  assert.equal(looksLikeText(new Uint8Array([0, 1, 2, 3, 0])), false);
  assert.equal(looksLikeText(new Uint8Array(0)), true);
});

test('utf8ByteLength counts UTF-8 bytes', () => {
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength('é'), 2);
  assert.equal(utf8ByteLength('🌍'), 4);
});

test('normalizeScenarioName trims and collapses whitespace', () => {
  assert.equal(normalizeScenarioName('  My   scenario  '), 'My scenario');
  assert.throws(() => normalizeScenarioName(''), /name/);
  assert.throws(() => normalizeScenarioName('   '), /name/);
  assert.throws(() => normalizeScenarioName('x'.repeat(65)), /64/);
});

test('newScenario creates a unique id and timestamps', () => {
  const first = newScenario('Checkout flow', 1000);
  const second = newScenario('Checkout flow', 2000);
  assert.notEqual(first.id, second.id);
  assert.equal(first.name, 'Checkout flow');
  assert.equal(first.createdAt, 1000);
  assert.equal(first.updatedAt, 1000);
  assert.match(first.id, /^[0-9a-f-]{36}$/);
});
