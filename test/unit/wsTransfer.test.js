import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCENARIO_EXPORT_VERSION,
  buildExportDocument,
  normalizeImportedScenarios,
  validateScenarioImport,
} from '../../src/shared/scenarioTransfer.js';
import { filterEntries } from '../../src/shared/filterEntries.js';
import { summarizeEntry } from '../../src/shared/entryBody.js';

const scenario = { id: 's1', name: 'Socket scenario', createdAt: 1, updatedAt: 2, hosts: ['api.test'] };

const wsEntry = {
  id: 's1:abc',
  scenarioId: 's1',
  kind: 'ws',
  matchKey: 'a'.repeat(64),
  method: 'WS',
  url: 'wss://api.test/socket.io/?EIO=4',
  status: 101,
  statusText: '',
  mimeType: 'websocket',
  resourceType: 'WebSocket',
  wsAdapter: 'socketio',
  negotiatedProtocol: 'websocket',
  frameCount: 2,
  sentCount: 1,
  recvCount: 1,
  durationMs: 120,
  truncated: false,
  size: 6,
  capturedAt: 5,
  bodyKind: 'text',
  edited: false,
  requestPreview: 'WS /socket.io/',
  responsePreview: '2 frames · socketio',
  responseHeaders: [],
};

const frames = [
  { id: 's1:abc:0', entryId: 's1:abc', scenarioId: 's1', seq: 0, direction: 'recv', opcode: 1, offsetMs: 0, size: 3, payload: btoa('42['), edited: false },
  { id: 's1:abc:1', entryId: 's1:abc', scenarioId: 's1', seq: 1, direction: 'send', opcode: 1, offsetMs: 10, size: 3, payload: btoa('42]'), edited: false },
];

test('WebSocket entries export their frames and metadata', () => {
  const document = buildExportDocument({
    scenario,
    entries: [wsEntry],
    bodiesById: {},
    framesById: { [wsEntry.id]: frames },
    exportedAt: 10,
    extensionVersion: '1.3.0',
  });

  assert.equal(document.formatVersion, SCENARIO_EXPORT_VERSION);
  assert.equal(document.entries.length, 1);
  const exported = document.entries[0];
  assert.equal(exported.kind, 'ws');
  assert.equal(exported.wsAdapter, 'socketio');
  assert.equal(exported.frames.length, 2);
  assert.equal(exported.frames[0].payload, btoa('42['));
  assert.equal('body' in exported, false);
});

test('v2 WebSocket documents import back with their frames', () => {
  const document = buildExportDocument({
    scenario,
    entries: [wsEntry],
    bodiesById: {},
    framesById: { [wsEntry.id]: frames },
    exportedAt: 10,
    extensionVersion: '1.3.0',
  });

  assert.equal(validateScenarioImport(document).ok, true);
  const [section] = normalizeImportedScenarios(document, { now: 99 });
  assert.equal(section.records.length, 1);
  const record = section.records[0];
  assert.equal(record.entry.kind, 'ws');
  assert.equal(record.frames.length, 2);
  assert.equal(record.entry.frameCount, 2);
  assert.equal(record.entry.sentCount, 1);
  assert.equal(record.entry.size, 6);
});

test('version 1 documents are still importable', () => {
  const v1 = {
    format: 'api-recorder-scenario',
    formatVersion: 1,
    scenario: { name: 'Legacy', createdAt: 1, updatedAt: 1 },
    entries: [
      {
        matchKey: 'b'.repeat(64),
        method: 'GET',
        url: 'https://api.test/items',
        status: 200,
        body: btoa('[]'),
      },
    ],
  };

  assert.equal(validateScenarioImport(v1).ok, true);
  const [section] = normalizeImportedScenarios(v1, { now: 5 });
  assert.equal(section.records.length, 1);
  assert.equal(section.records[0].entry.kind, 'http');
});

test('WebSocket entries without frames are skipped with a reason', () => {
  const document = {
    format: 'api-recorder-scenario',
    formatVersion: 2,
    scenario: { name: 'Broken', createdAt: 1 },
    entries: [{ ...wsEntry, frames: [] }],
  };
  const [section] = normalizeImportedScenarios(document, { now: 1 });
  assert.equal(section.records.length, 0);
  assert.match(section.skipped[0].reason, /no frames/);
});

test('recorded WebSocket rows are searchable in the entries table', () => {
  const summary = summarizeEntry(wsEntry);
  assert.equal(summary.kind, 'ws');
  assert.equal(summary.wsAdapter, 'socketio');
  assert.equal(summary.frameCount, 2);

  assert.equal(filterEntries([summary], 'socketio').length, 1);
  assert.equal(filterEntries([summary], 'ws').length, 1);
  assert.equal(filterEntries([summary], 'missing').length, 0);
});
