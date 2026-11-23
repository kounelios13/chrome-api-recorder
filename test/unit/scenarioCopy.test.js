import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultCopyScenarioName,
  normalizeTargetOrigin,
  rewriteRequestPreview,
  rewriteResponseHeaders,
  rewriteScenarioEntries,
  rewriteUrlOrigin,
} from '../../src/shared/scenarioCopy.js';
import { requestKey } from '../../src/shared/matchkey.js';
import { utf8ToBytes } from '../../src/shared/bytes.js';
import { LIMITS } from '../../src/shared/constants.js';

test('normalizeTargetOrigin accepts http and https origins and strips paths/queries', () => {
  assert.deepEqual(normalizeTargetOrigin('http://localhost:3000'), {
    origin: 'http://localhost:3000',
    host: 'localhost:3000',
  });
  assert.deepEqual(normalizeTargetOrigin('  https://Staging.Example.com/api/v1?x=1  '), {
    origin: 'https://staging.example.com',
    host: 'staging.example.com',
  });
});

test('normalizeTargetOrigin rejects empty, malformed, and non-http origins', () => {
  assert.throws(() => normalizeTargetOrigin(''), /Enter a target origin/i);
  assert.throws(() => normalizeTargetOrigin('localhost:3000'), /http:\/\/ or https:\/\//i);
  assert.throws(() => normalizeTargetOrigin('ftp://example.com'), /http:\/\/ or https:\/\//i);
  assert.throws(() => normalizeTargetOrigin('javascript:alert(1)'), /http:\/\/ or https:\/\//i);
});

test('defaultCopyScenarioName formats name with target host and respects max length', () => {
  assert.equal(defaultCopyScenarioName('Checkout Flow', 'localhost:3000'), 'Checkout Flow (localhost:3000)');

  const longName = 'A'.repeat(60);
  const result = defaultCopyScenarioName(longName, 'staging.example.com');
  assert.ok(result.length <= LIMITS.MAX_SCENARIO_NAME);
  assert.ok(result.endsWith(' (staging.example.com)'));
});

test('rewriteUrlOrigin swaps scheme/host/port while keeping path, query, and hash', () => {
  assert.equal(
    rewriteUrlOrigin('https://api.prod.example.com:8443/v1/items?b=2&a=1#top', 'http://localhost:3000'),
    'http://localhost:3000/v1/items?b=2&a=1#top',
  );
  assert.equal(rewriteUrlOrigin('not-a-url', 'http://localhost:3000'), 'not-a-url');
});

test('rewriteRequestPreview updates URL prefix while keeping method and body preview', () => {
  assert.equal(
    rewriteRequestPreview(
      'POST https://api.prod.com/items?a=1&b=2 · {"id":1}',
      'https://api.prod.com/items?b=2&a=1',
      'http://localhost:3000/items?b=2&a=1',
    ),
    'POST http://localhost:3000/items?a=1&b=2 · {"id":1}',
  );
});

test('rewriteResponseHeaders rewrites matching CORS and Location headers only', () => {
  const sourceOrigins = new Set(['https://api.prod.com', 'https://auth.prod.com']);
  const headers = [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Access-Control-Allow-Origin', value: 'https://api.prod.com' },
    { name: 'Location', value: 'https://auth.prod.com/callback?ok=1' },
    { name: 'X-Other', value: 'https://api.prod.com' },
  ];

  const rewritten = rewriteResponseHeaders(headers, sourceOrigins, 'http://localhost:3000');
  assert.deepEqual(rewritten, [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Access-Control-Allow-Origin', value: 'http://localhost:3000' },
    { name: 'Location', value: 'http://localhost:3000/callback?ok=1' },
    { name: 'X-Other', value: 'https://api.prod.com' },
  ]);

  // Unrelated origins and relative Location headers are preserved
  const untouched = rewriteResponseHeaders(
    [
      { name: 'Access-Control-Allow-Origin', value: 'https://other.example.com' },
      { name: 'Location', value: '/relative/path' },
    ],
    sourceOrigins,
    'http://localhost:3000',
  );
  assert.deepEqual(untouched, [
    { name: 'Access-Control-Allow-Origin', value: 'https://other.example.com' },
    { name: 'Location', value: '/relative/path' },
  ]);
});

test('rewriteScenarioEntries re-keys bodyless entries, preserves body-bearing keys, and copies bodies', async () => {
  const getUrl = 'https://api.prod.com/users?page=1';
  const postUrl = 'https://api.prod.com/users';
  const getKey = await requestKey({ method: 'GET', url: getUrl });
  const postKey = await requestKey({ method: 'POST', url: postUrl, bodyBytes: utf8ToBytes('{"name":"Ada"}') });

  const entries = [
    {
      id: `src:${getKey}`,
      scenarioId: 'src',
      matchKey: getKey,
      method: 'GET',
      url: getUrl,
      status: 200,
      requestPreview: `GET ${getUrl}`,
      responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: 'https://api.prod.com' }],
    },
    {
      id: `src:${postKey}`,
      scenarioId: 'src',
      matchKey: postKey,
      method: 'POST',
      url: postUrl,
      status: 201,
      requestPreview: `POST ${postUrl} · {"name":"Ada"}`,
      responseHeaders: [{ name: 'Location', value: 'https://api.prod.com/users/42' }],
    },
  ];

  const bodiesById = {
    [`src:${getKey}`]: { id: `src:${getKey}`, body: 'W10=', originalBody: 'W3siZCI6MX1d' },
    [`src:${postKey}`]: { id: `src:${postKey}`, body: 'eyJpZCI6NDJ9' },
  };

  const result = await rewriteScenarioEntries({
    entries,
    bodiesById,
    newScenarioId: 'dst',
    targetOrigin: 'http://localhost:3000',
    rewriteHeaders: true,
  });

  assert.equal(result.copiedCount, 2);
  assert.equal(result.rekeyedCount, 1);
  assert.equal(result.fallbackCount, 1);
  assert.deepEqual(result.hosts, ['localhost:3000']);

  const [getRec, postRec] = result.records;

  // GET entry was deterministically re-keyed for the new origin
  const expectedNewGetKey = await requestKey({ method: 'GET', url: 'http://localhost:3000/users?page=1' });
  assert.equal(getRec.entry.url, 'http://localhost:3000/users?page=1');
  assert.equal(getRec.entry.matchKey, expectedNewGetKey);
  assert.equal(getRec.entry.id, `dst:${expectedNewGetKey}`);
  assert.equal(getRec.entry.scenarioId, 'dst');
  assert.equal(getRec.entry.requestPreview, 'GET http://localhost:3000/users?page=1');
  assert.deepEqual(getRec.entry.responseHeaders, [
    { name: 'Access-Control-Allow-Origin', value: 'http://localhost:3000' },
  ]);
  assert.equal(getRec.body, 'W10=');
  assert.equal(getRec.originalBody, 'W3siZCI6MX1d');

  // POST entry with body keeps its matchKey (relies on smartFallback) while rewriting URL & headers
  assert.equal(postRec.entry.url, 'http://localhost:3000/users');
  assert.equal(postRec.entry.matchKey, postKey);
  assert.equal(postRec.entry.id, `dst:${postKey}`);
  assert.equal(postRec.entry.requestPreview, 'POST http://localhost:3000/users · {"name":"Ada"}');
  assert.deepEqual(postRec.entry.responseHeaders, [
    { name: 'Location', value: 'http://localhost:3000/users/42' },
  ]);
  assert.equal(postRec.body, 'eyJpZCI6NDJ9');
  assert.equal(postRec.originalBody, undefined);
});

test('rewriteScenarioEntries respects rewriteHeaders: false and handles empty scenarios', async () => {
  const getUrl = 'https://api.prod.com/ping';
  const getKey = await requestKey({ method: 'GET', url: getUrl });
  const result = await rewriteScenarioEntries({
    entries: [
      {
        id: `src:${getKey}`,
        scenarioId: 'src',
        matchKey: getKey,
        method: 'GET',
        url: getUrl,
        responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: 'https://api.prod.com' }],
      },
    ],
    bodiesById: {},
    newScenarioId: 'dst',
    targetOrigin: 'https://staging.example.com',
    rewriteHeaders: false,
  });

  assert.deepEqual(result.records[0].entry.responseHeaders, [
    { name: 'Access-Control-Allow-Origin', value: 'https://api.prod.com' },
  ]);

  const empty = await rewriteScenarioEntries({
    entries: [],
    bodiesById: {},
    newScenarioId: 'dst2',
    targetOrigin: 'https://staging.example.com',
  });
  assert.equal(empty.copiedCount, 0);
  assert.deepEqual(empty.hosts, ['staging.example.com']);
});
