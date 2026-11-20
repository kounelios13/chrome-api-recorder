import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEditedEntry, summarizeEntry } from '../../src/shared/entryBody.js';
import { utf8ToBytes } from '../../src/shared/bytes.js';

const baseEntry = {
  id: 'scenario-1:abc',
  scenarioId: 'scenario-1',
  matchKey: 'abc',
  method: 'GET',
  url: 'https://api.test/items',
  status: 200,
  statusText: 'OK',
  mimeType: 'application/json',
  resourceType: 'Fetch',
  capturedAt: 1000,
  size: 12,
  bodyKind: 'text',
  requestPreview: 'GET https://api.test/items',
  responsePreview: '{"ok":true}',
  edited: false,
  editedAt: null,
};

test('buildEditedEntry recalculates size, preview and body kind', () => {
  const bytes = utf8ToBytes('{"message":"edited"}');
  const edited = buildEditedEntry(baseEntry, bytes, { edited: true, editedAt: 2000 });

  assert.equal(edited.size, bytes.length);
  assert.equal(edited.bodyKind, 'text');
  assert.equal(edited.responsePreview, '{"message":"edited"}');
  assert.equal(edited.edited, true);
  assert.equal(edited.editedAt, 2000);
});

test('buildEditedEntry preserves identity fields', () => {
  const edited = buildEditedEntry(baseEntry, utf8ToBytes('x'), { edited: true, editedAt: 5 });
  assert.equal(edited.id, baseEntry.id);
  assert.equal(edited.scenarioId, baseEntry.scenarioId);
  assert.equal(edited.matchKey, baseEntry.matchKey);
  assert.equal(edited.method, baseEntry.method);
  assert.equal(edited.url, baseEntry.url);
  assert.equal(edited.capturedAt, baseEntry.capturedAt);
});

test('buildEditedEntry marks restored entries as not edited', () => {
  const restored = buildEditedEntry({ ...baseEntry, edited: true, editedAt: 2000 }, utf8ToBytes('{"ok":true}'), {
    edited: false,
  });
  assert.equal(restored.edited, false);
  assert.equal(restored.editedAt, null);
  assert.equal(restored.responsePreview, '{"ok":true}');
});

test('buildEditedEntry handles binary bodies', () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4]);
  const edited = buildEditedEntry(baseEntry, bytes, { edited: true });
  assert.equal(edited.bodyKind, 'binary');
  assert.equal(edited.size, 5);
  assert.match(edited.responsePreview, /binary/);
});

test('buildEditedEntry handles an empty payload', () => {
  const edited = buildEditedEntry(baseEntry, new Uint8Array(0), { edited: true });
  assert.equal(edited.size, 0);
  assert.equal(edited.responsePreview, '');
  assert.equal(edited.bodyKind, 'text');
});

test('buildEditedEntry tolerates non-array input', () => {
  const edited = buildEditedEntry(baseEntry, null, { edited: true });
  assert.equal(edited.size, 0);
});

test('summarizeEntry drops body data but keeps the editing flags', () => {
  const entry = { ...baseEntry, edited: true, editedAt: 3000, responseHeaders: [{ name: 'x', value: 'y' }], matchKey: 'abc' };
  const summary = summarizeEntry(entry);
  assert.equal(summary.id, entry.id);
  assert.equal(summary.edited, true);
  assert.equal(summary.editedAt, 3000);
  assert.equal(summary.responseHeaders, undefined);
  assert.equal(summary.matchKey, undefined);
  assert.equal(summary.size, entry.size);
});
