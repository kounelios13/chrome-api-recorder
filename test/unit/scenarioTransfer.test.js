import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCENARIO_EXPORT_FORMAT,
  SCENARIOS_EXPORT_FORMAT,
  SCENARIO_EXPORT_VERSION,
  buildCollectionExportDocument,
  buildExportDocument,
  detectExportKind,
  normalizeImportedScenario,
  normalizeImportedScenarios,
  scenarioFileSlug,
  uniqueImportedName,
  validateScenarioImport,
} from '../../src/shared/scenarioTransfer.js';
import { bytesToBase64, utf8ToBytes } from '../../src/shared/bytes.js';

const sampleEntries = [
  {
    id: 'scn:key1',
    scenarioId: 'scn',
    matchKey: 'a'.repeat(64),
    method: 'GET',
    url: 'https://api.test/greeting',
    status: 200,
    statusText: 'OK',
    mimeType: 'application/json',
    resourceType: 'Fetch',
    size: 13,
    capturedAt: 1000,
    bodyKind: 'text',
    edited: false,
    editedAt: null,
    requestPreview: 'GET https://api.test/greeting',
    responsePreview: '{"message":"hi"}',
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
  },
];

const sampleBodies = {
  'scn:key1': { body: bytesToBase64(utf8ToBytes('{"message":"hi"}')) },
};

test('buildExportDocument produces the documented format', () => {
  const document = buildExportDocument({
    scenario: { id: 'scn', name: 'Checkout', createdAt: 1, updatedAt: 2, hosts: ['api.test'] },
    entries: sampleEntries,
    bodiesById: sampleBodies,
    exportedAt: 3000,
    extensionVersion: '1.1.0',
  });

  assert.equal(document.format, SCENARIO_EXPORT_FORMAT);
  assert.equal(document.formatVersion, SCENARIO_EXPORT_VERSION);
  assert.equal(document.scenario.name, 'Checkout');
  assert.equal(document.entries.length, 1);
  assert.equal(document.entries[0].matchKey, 'a'.repeat(64));
  assert.equal(document.entries[0].body, sampleBodies['scn:key1'].body);
  assert.equal(document.entries[0].id, undefined);
  assert.equal(document.entries[0].scenarioId, undefined);
  assert.deepEqual(document.entries[0].responseHeaders, [{ name: 'Content-Type', value: 'application/json' }]);
});

test('buildExportDocument includes originalBody only when it exists', () => {
  const document = buildExportDocument({
    scenario: { id: 'scn', name: 'X', createdAt: 0, updatedAt: 0, hosts: [] },
    entries: sampleEntries,
    bodiesById: { 'scn:key1': { body: 'aGk=', originalBody: 'b3JpZw==' } },
    exportedAt: 0,
    extensionVersion: '1.1.0',
  });
  assert.equal(document.entries[0].originalBody, 'b3JpZw==');

  const withoutOriginal = buildExportDocument({
    scenario: { id: 'scn', name: 'X', createdAt: 0, updatedAt: 0, hosts: [] },
    entries: sampleEntries,
    bodiesById: { 'scn:key1': { body: 'aGk=' } },
    exportedAt: 0,
    extensionVersion: '1.1.0',
  });
  assert.equal(withoutOriginal.entries[0].originalBody, undefined);
});

test('validateScenarioImport rejects foreign or broken files', () => {
  assert.equal(validateScenarioImport(null).ok, false);
  assert.equal(validateScenarioImport({}).ok, false);
  assert.equal(validateScenarioImport({ format: 'other', formatVersion: 1, scenario: { name: 'x' }, entries: [] }).ok, false);
  assert.equal(
    validateScenarioImport({ format: SCENARIO_EXPORT_FORMAT, formatVersion: 99, scenario: { name: 'x' }, entries: [] }).ok,
    false,
  );
  assert.equal(
    validateScenarioImport({ format: SCENARIO_EXPORT_FORMAT, formatVersion: 1, scenario: { name: '  ' }, entries: [] }).ok,
    false,
  );
  assert.equal(
    validateScenarioImport({ format: SCENARIO_EXPORT_FORMAT, formatVersion: 1, scenario: { name: 'x' }, entries: 'nope' }).ok,
    false,
  );
});

const validDocument = {
  format: SCENARIO_EXPORT_FORMAT,
  formatVersion: SCENARIO_EXPORT_VERSION,
  exportedAt: 5000,
  extensionVersion: '1.1.0',
  scenario: { name: 'Checkout', createdAt: 100, updatedAt: 200, hosts: ['api.test'] },
  entries: [
    {
      matchKey: 'b'.repeat(64),
      method: 'post',
      url: 'https://api.test/echo',
      status: 201,
      statusText: 'Created',
      mimeType: 'application/json',
      resourceType: 'XHR',
      size: 9,
      capturedAt: 150,
      bodyKind: 'text',
      edited: true,
      editedAt: 300,
      requestPreview: 'POST https://api.test/echo · {"id":1}',
      responsePreview: '{"ok":true}',
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Set-Cookie', value: 'a=b' },
        null,
        { name: 42, value: 'x' },
      ],
      body: bytesToBase64(utf8ToBytes('{"ok":true}')),
      originalBody: 'b3JpZw==',
    },
  ],
};

test('validateScenarioImport accepts a valid document', () => {
  assert.equal(validateScenarioImport(validDocument).ok, true);
});

test('normalizeImportedScenario normalizes entries and preserves the match key', () => {
  const { name, records, skipped } = normalizeImportedScenario(validDocument, { now: 9999 });
  assert.equal(name, 'Checkout');
  assert.equal(skipped.length, 0);
  assert.equal(records.length, 1);

  const { entry, body, originalBody } = records[0];
  assert.equal(entry.matchKey, 'b'.repeat(64));
  assert.equal(entry.method, 'POST');
  assert.equal(entry.status, 201);
  assert.equal(entry.size, 11); // decoded length of '{"ok":true}'
  assert.equal(entry.edited, true);
  assert.equal(entry.editedAt, 300);
  assert.equal(entry.bodyKind, 'text');
  assert.equal(body, validDocument.entries[0].body);
  assert.equal(originalBody, 'b3JpZw==');
  // Response headers keep only well-formed {name,value} pairs.
  assert.deepEqual(entry.responseHeaders, [{ name: 'Content-Type', value: 'application/json' }, { name: 'Set-Cookie', value: 'a=b' }]);
});

test('normalizeImportedScenario skips broken entries with reasons', () => {
  const document = {
    format: SCENARIO_EXPORT_FORMAT,
    formatVersion: SCENARIO_EXPORT_VERSION,
    scenario: { name: 'Broken', createdAt: 0, updatedAt: 0 },
    entries: [
      { matchKey: 'not-hex', url: 'https://a.test/', body: 'aGk=' },
      { matchKey: 'c'.repeat(64), url: 'https://a.test/', body: '%%%' },
      { matchKey: 'd'.repeat(64), url: '', body: 'aGk=' },
      { matchKey: 'e'.repeat(64), url: 'https://a.test/', body: 'aGk=' },
    ],
  };

  const { records, skipped } = normalizeImportedScenario(document, { now: 1, maxBodyBytes: 1024 });
  assert.equal(records.length, 1);
  assert.equal(skipped.length, 3);
  assert.equal(skipped[0].reason, 'entry has a missing or invalid match key');
  assert.equal(skipped[1].reason, 'response body is not valid base64');
  assert.equal(skipped[2].reason, 'entry has no URL');
});

test('normalizeImportedScenario enforces the body size cap', () => {
  const document = {
    format: SCENARIO_EXPORT_FORMAT,
    formatVersion: SCENARIO_EXPORT_VERSION,
    scenario: { name: 'Big', createdAt: 0, updatedAt: 0 },
    entries: [{ matchKey: 'f'.repeat(64), url: 'https://a.test/', body: 'aGk=' }],
  };
  const { records, skipped } = normalizeImportedScenario(document, { now: 1, maxBodyBytes: 1 });
  assert.equal(records.length, 0);
  assert.equal(skipped[0].reason, 'response body is larger than the configured limit');
});

test('uniqueImportedName avoids local name collisions', () => {
  assert.equal(uniqueImportedName('Checkout', ['Admin']), 'Checkout');
  assert.equal(uniqueImportedName('Checkout', ['checkout']), 'Checkout (imported 2)');
  assert.equal(uniqueImportedName('Checkout', ['checkout', 'Checkout (imported 2)']), 'Checkout (imported 3)');
  assert.equal(uniqueImportedName('  ', []), 'Imported scenario');
});

test('scenarioFileSlug produces file-safe names', () => {
  assert.equal(scenarioFileSlug('Checkout flow'), 'checkout-flow');
  assert.equal(scenarioFileSlug('API  Recorder!!!'), 'api-recorder');
  assert.equal(scenarioFileSlug(''), 'scenario');
});

/* ------------------------------------------------------------------ */
/* Collection (export-all) format                                      */
/* ------------------------------------------------------------------ */

const collectionScenarios = [
  { id: 's1', name: 'Checkout', createdAt: 1, updatedAt: 2, hosts: ['api.test'] },
  { id: 's2', name: 'Admin', createdAt: 3, updatedAt: 4, hosts: [] },
];

const collectionEntries = {
  s1: [
    {
      id: 's1:k1',
      matchKey: 'a'.repeat(64),
      method: 'GET',
      url: 'https://api.test/greeting',
      status: 200,
      statusText: 'OK',
      mimeType: 'application/json',
      resourceType: 'Fetch',
      size: 13,
      capturedAt: 10,
      bodyKind: 'text',
      edited: false,
      editedAt: null,
      requestPreview: 'GET https://api.test/greeting',
      responsePreview: '{"message":"hi"}',
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    },
  ],
  s2: [
    {
      id: 's2:k1',
      matchKey: 'b'.repeat(64),
      method: 'POST',
      url: 'https://admin.test/x',
      status: 204,
      mimeType: '',
      resourceType: 'XHR',
      size: 0,
      capturedAt: 11,
      bodyKind: 'text',
      edited: false,
      editedAt: null,
      requestPreview: 'POST https://admin.test/x',
      responsePreview: '',
      responseHeaders: [],
    },
  ],
};

const collectionBodies = {
  's1:k1': { body: bytesToBase64(utf8ToBytes('{"message":"hi"}')) },
  's2:k1': { body: '' },
};

test('buildCollectionExportDocument produces the collection format', () => {
  const document = buildCollectionExportDocument({
    scenarios: collectionScenarios,
    entriesById: collectionEntries,
    bodiesById: collectionBodies,
    exportedAt: 42,
    extensionVersion: '1.2.0',
  });

  assert.equal(document.format, SCENARIOS_EXPORT_FORMAT);
  assert.equal(document.formatVersion, SCENARIO_EXPORT_VERSION);
  assert.equal(document.scenarios.length, 2);
  assert.equal(document.scenarios[0].scenario.name, 'Checkout');
  assert.equal(document.scenarios[0].entries.length, 1);
  assert.equal(document.scenarios[0].entries[0].body, collectionBodies['s1:k1'].body);
  assert.equal(document.scenarios[1].scenario.name, 'Admin');
  assert.equal(document.scenarios[1].entries[0].body, '');
});

test('detectExportKind distinguishes single and collection documents', () => {
  assert.equal(detectExportKind({ format: SCENARIO_EXPORT_FORMAT }), 'single');
  assert.equal(detectExportKind({ format: SCENARIOS_EXPORT_FORMAT }), 'collection');
  assert.equal(detectExportKind({ format: 'other' }), null);
  assert.equal(detectExportKind(null), null);
});

test('validateScenarioImport accepts a collection and rejects broken sections', () => {
  const document = buildCollectionExportDocument({
    scenarios: collectionScenarios,
    entriesById: collectionEntries,
    bodiesById: collectionBodies,
    exportedAt: 42,
    extensionVersion: '1.2.0',
  });
  assert.equal(validateScenarioImport(document).ok, true);
  assert.equal(validateScenarioImport(document).kind, 'collection');

  const missingName = { ...document, scenarios: [{ scenario: { name: '  ' }, entries: [] }] };
  assert.equal(validateScenarioImport(missingName).ok, false);

  const noScenarios = { ...document, scenarios: [] };
  assert.equal(validateScenarioImport(noScenarios).ok, false);
});

test('normalizeImportedScenarios handles both kinds and keeps per-scenario skips', () => {
  const document = buildCollectionExportDocument({
    scenarios: collectionScenarios,
    entriesById: collectionEntries,
    bodiesById: collectionBodies,
    exportedAt: 42,
    extensionVersion: '1.2.0',
  });
  const sections = normalizeImportedScenarios(document, { now: 9999 });
  assert.equal(sections.length, 2);
  assert.equal(sections[0].name, 'Checkout');
  assert.equal(sections[0].records.length, 1);
  assert.equal(sections[0].records[0].entry.matchKey, 'a'.repeat(64));
  assert.equal(sections[1].records[0].entry.method, 'POST');
  assert.equal(sections[1].records[0].entry.size, 0);

  // The legacy single-scenario document normalizes to exactly one section.
  const singleSections = normalizeImportedScenarios(validDocument, { now: 9999 });
  assert.equal(singleSections.length, 1);
  assert.equal(singleSections[0].name, 'Checkout');
});

test('normalizeImportedScenarios rejects foreign files with a clear error', () => {
  assert.throws(() => normalizeImportedScenarios({ hello: 'world' }), /not created by API Recorder/);
});

test('normalizeImportedScenario still returns the first section of a single document', () => {
  const result = normalizeImportedScenario(validDocument, { now: 9999 });
  assert.equal(result.name, 'Checkout');
  assert.equal(result.records.length, 1);
});
