import { test } from 'node:test';
import assert from 'node:assert/strict';

import { headerValue, headersToArray, sanitizeResponseHeaders } from '../../src/shared/headers.js';

const recordedHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://app.test',
  'Content-Encoding': 'gzip',
  'Content-Length': '512',
  'Transfer-Encoding': 'chunked',
  Connection: 'keep-alive',
  'Set-Cookie': 'session=abc; Path=/',
  'Cache-Control': 'no-store',
};

test('headersToArray converts a CDP header map', () => {
  const headers = headersToArray({ 'Content-Type': 'application/json', 'X-Count': 3 });
  assert.deepEqual(headers, [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'X-Count', value: '3' },
  ]);
});

test('headersToArray passes arrays through and tolerates empty input', () => {
  const input = [{ name: 'A', value: '1' }];
  assert.deepEqual(headersToArray(input), input);
  assert.deepEqual(headersToArray(undefined), []);
  assert.deepEqual(headersToArray(null), []);
});

test('sanitizeResponseHeaders drops framing headers', () => {
  const sanitized = sanitizeResponseHeaders(recordedHeaders);
  const names = sanitized.map((header) => header.name.toLowerCase());
  assert.ok(!names.includes('content-encoding'), 'content-encoding must be dropped (body is decoded)');
  assert.ok(!names.includes('content-length'), 'content-length must be dropped');
  assert.ok(!names.includes('transfer-encoding'));
  assert.ok(!names.includes('connection'));
});

test('sanitizeResponseHeaders keeps content-type, CORS and caching headers', () => {
  const sanitized = sanitizeResponseHeaders(recordedHeaders);
  const names = sanitized.map((header) => header.name.toLowerCase());
  assert.ok(names.includes('content-type'));
  assert.ok(names.includes('access-control-allow-origin'));
  assert.ok(names.includes('cache-control'));
});

test('sanitizeResponseHeaders drops Set-Cookie by default', () => {
  const sanitized = sanitizeResponseHeaders(recordedHeaders);
  assert.ok(!sanitized.some((header) => header.name.toLowerCase() === 'set-cookie'));
});

test('sanitizeResponseHeaders can keep Set-Cookie when asked', () => {
  const sanitized = sanitizeResponseHeaders(recordedHeaders, { replayCookies: true });
  assert.ok(sanitized.some((header) => header.name.toLowerCase() === 'set-cookie'));
});

test('sanitizeResponseHeaders drops pseudo headers', () => {
  const sanitized = sanitizeResponseHeaders([{ name: ':status', value: '200' }, { name: 'X-Keep', value: 'yes' }]);
  assert.deepEqual(sanitized, [{ name: 'X-Keep', value: 'yes' }]);
});

test('headerValue is case insensitive for maps and arrays', () => {
  assert.equal(headerValue(recordedHeaders, 'content-type'), 'application/json');
  assert.equal(headerValue([{ name: 'Content-Type', value: 'text/plain' }], 'CONTENT-TYPE'), 'text/plain');
  assert.equal(headerValue(recordedHeaders, 'x-missing'), '');
});
