import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMatchIndexes,
  describeMatchReason,
  lookupRecording,
  pathMatchKey,
  urlMatchKey,
} from '../../src/shared/matchIndex.js';

const entry = (id, method, url, matchKey) => ({
  id,
  method,
  url,
  matchKey,
  status: 200,
});

const entries = [
  entry('e1', 'GET', 'https://api.test/api/foo', 'key-foo'),
  entry('e2', 'POST', 'https://api.test/api/echo', 'key-echo-1'),
  entry('e3', 'POST', 'https://api.test/api/echo', 'key-echo-2'),
  entry('e4', 'GET', 'https://api.test/api/list?page=1', 'key-list-1'),
];

const indexes = buildMatchIndexes(entries);

test('exact key always wins', () => {
  const result = lookupRecording(indexes, {
    method: 'get',
    url: 'https://api.test/api/foo',
    matchKey: 'key-foo',
  });
  assert.equal(result.matchedVia, 'exact');
  assert.equal(result.entry?.id, 'e1');
});

test('exact matching is attempted before fallbacks', () => {
  const result = lookupRecording(indexes, {
    method: 'POST',
    url: 'https://api.test/api/echo',
    matchKey: 'key-echo-2',
  });
  assert.equal(result.entry?.id, 'e3');
  assert.equal(result.matchedVia, 'exact');
});

test('single recording for a URL falls back to URL matching', () => {
  const result = lookupRecording(indexes, {
    method: 'POST',
    url: 'https://api.test/api/echo?ts=123',
    matchKey: 'different-body-key',
    // query differs from the recording, but the same endpoint was recorded twice
  });
  // e2/e3 are different bodies for the same path, so this must be ambiguous.
  assert.equal(result.entry, null);
  assert.equal(result.reason, 'ambiguous-url');
});

test('URL fallback works when exactly one recording shares the URL', () => {
  const single = buildMatchIndexes([entry('e1', 'POST', 'https://api.test/api/foo', 'key-1')]);
  const result = lookupRecording(single, {
    method: 'POST',
    url: 'https://api.test/api/foo',
    matchKey: 'a-different-body',
  });
  assert.equal(result.entry?.id, 'e1');
  assert.equal(result.matchedVia, 'url');
});

test('ambiguous body variants are refused instead of guessing', () => {
  const result = lookupRecording(indexes, {
    method: 'POST',
    url: 'https://api.test/api/echo',
    matchKey: 'unknown-echo-body',
  });
  assert.equal(result.entry, null);
  assert.equal(result.matchedVia, null);
  assert.equal(result.reason, 'ambiguous-body');
  assert.equal(result.sameUrl, 2);
});

test('path fallback ignores query parameters when unambiguous', () => {
  const result = lookupRecording(indexes, {
    method: 'GET',
    url: 'https://api.test/api/foo?cacheBust=999',
    matchKey: 'nothing',
  });
  assert.equal(result.entry?.id, 'e1');
  assert.equal(result.matchedVia, 'path');
});

test('path fallback refuses when several recordings share the path', () => {
  const result = lookupRecording(indexes, {
    method: 'POST',
    url: 'https://api.test/api/echo?attempt=1',
    matchKey: 'nothing',
  });
  assert.equal(result.entry, null);
  assert.equal(result.reason, 'ambiguous-url');
  assert.equal(result.samePath, 2);
});

test('fallbacks can be disabled for strict exact matching', () => {
  const single = buildMatchIndexes([entry('e1', 'POST', 'https://api.test/api/foo', 'key-1')]);
  const withFallback = lookupRecording(single, { method: 'POST', url: 'https://api.test/api/foo', matchKey: 'x' });
  assert.equal(withFallback.entry?.id, 'e1');

  const strict = lookupRecording(
    single,
    { method: 'POST', url: 'https://api.test/api/foo', matchKey: 'x' },
    { smartFallback: false },
  );
  assert.equal(strict.entry, null);
  assert.equal(strict.reason, 'body-differs');
});

test('strict mode explains URL differences', () => {
  const result = lookupRecording(
    indexes,
    { method: 'GET', url: 'https://api.test/api/foo?cacheBust=1', matchKey: 'x' },
    { smartFallback: false },
  );
  assert.equal(result.entry, null);
  assert.equal(result.reason, 'url-differs');
});

test('a completely unknown request is reported as no-recording', () => {
  const result = lookupRecording(indexes, { method: 'DELETE', url: 'https://api.test/other', matchKey: 'zzz' });
  assert.equal(result.entry, null);
  assert.equal(result.reason, 'no-recording');
});

test('body-missing requests can still fall back by URL', () => {
  const single = buildMatchIndexes([entry('e1', 'POST', 'https://api.test/api/foo', 'key-1')]);
  const result = lookupRecording(single, { method: 'POST', url: 'https://api.test/api/foo', matchKey: null });
  assert.equal(result.entry?.id, 'e1');
  assert.equal(result.matchedVia, 'url');
});

test('match keys normalize method case and query order', () => {
  assert.equal(
    urlMatchKey('post', 'https://api.test/x?b=2&a=1'),
    urlMatchKey('POST', 'https://api.test/x?a=1&b=2'),
  );
  assert.equal(
    pathMatchKey('GET', 'https://api.test/x?b=2'),
    pathMatchKey('GET', 'https://api.test/x?a=1'),
  );
});

test('describeMatchReason produces readable explanations', () => {
  assert.match(describeMatchReason('ambiguous-body'), /several recordings/);
  assert.match(describeMatchReason('body-unavailable'), /body/);
  assert.match(describeMatchReason('fulfill-error'), /could not be returned/);
  assert.equal(describeMatchReason(undefined), 'unknown reason');
});
