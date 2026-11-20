import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entrySearchText, filterEntries, parseFilterTerms } from '../../src/shared/filterEntries.js';

const entries = [
  {
    id: 'a',
    method: 'GET',
    url: 'https://api.test/api/foo?page=1',
    status: 200,
    statusText: 'OK',
    mimeType: 'application/json',
    size: 120,
    requestPreview: 'GET https://api.test/api/foo?page=1',
    responsePreview: '{"items":[{"id":1}]}',
  },
  {
    id: 'b',
    method: 'POST',
    url: 'https://api.test/api/echo',
    status: 201,
    statusText: 'Created',
    mimeType: 'application/json',
    size: 220,
    requestPreview: 'POST https://api.test/api/echo · {"id":2}',
    responsePreview: '{"echo":{"id":2}}',
  },
  {
    id: 'c',
    method: 'POST',
    url: 'https://api.test/api/common',
    status: 500,
    statusText: 'Internal Server Error',
    mimeType: 'text/plain',
    size: 40,
    requestPreview: 'POST https://api.test/api/common · ping',
    responsePreview: 'boom',
  },
];

test('empty queries return every entry without mutating the input', () => {
  const result = filterEntries(entries, '');
  assert.equal(result.length, 3);
  assert.notEqual(result, entries);
  assert.deepEqual(filterEntries(entries, '   ').length, 3);
});

test('single terms match case-insensitively', () => {
  assert.deepEqual(filterEntries(entries, 'POST').map((entry) => entry.id), ['b', 'c']);
  assert.deepEqual(filterEntries(entries, '/api/foo').map((entry) => entry.id), ['a']);
});

test('multiple terms must all match', () => {
  assert.deepEqual(filterEntries(entries, 'post /api/echo').map((entry) => entry.id), ['b']);
  assert.deepEqual(filterEntries(entries, 'post 500').map((entry) => entry.id), ['c']);
  assert.deepEqual(filterEntries(entries, 'post /api/foo').map((entry) => entry.id), []);
});

test('status, MIME type and size are searchable', () => {
  assert.deepEqual(filterEntries(entries, '201').map((entry) => entry.id), ['b']);
  assert.deepEqual(filterEntries(entries, 'text/plain').map((entry) => entry.id), ['c']);
  assert.deepEqual(filterEntries(entries, '220').map((entry) => entry.id), ['b']);
});

test('request and response body previews are searchable', () => {
  assert.deepEqual(filterEntries(entries, 'boom').map((entry) => entry.id), ['c']);
  assert.deepEqual(filterEntries(entries, '"id":2').map((entry) => entry.id), ['b']);
  assert.deepEqual(filterEntries(entries, 'ping').map((entry) => entry.id), ['c']);
});

test('queries with no matches return an empty list', () => {
  assert.deepEqual(filterEntries(entries, 'graphql websocket'), []);
});

test('non-array input is treated as empty', () => {
  assert.deepEqual(filterEntries(undefined, 'x'), []);
  assert.deepEqual(filterEntries(null, ''), []);
});

test('parseFilterTerms normalizes whitespace and case', () => {
  assert.deepEqual(parseFilterTerms('  POST   /Api/Echo  '), ['post', '/api/echo']);
  assert.deepEqual(parseFilterTerms(''), []);
  assert.deepEqual(parseFilterTerms(undefined), []);
});

test('entrySearchText tolerates sparse entries', () => {
  assert.equal(entrySearchText({ method: 'GET' }), 'get');
  assert.equal(entrySearchText(null), '');
});
