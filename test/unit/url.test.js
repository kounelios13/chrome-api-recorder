import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hostOf, isHttpUrl, normalizeUrl, shortUrl } from '../../src/shared/url.js';

test('normalizeUrl drops the fragment', () => {
  assert.equal(normalizeUrl('https://example.com/a/b#section'), 'https://example.com/a/b');
});

test('normalizeUrl sorts query parameters', () => {
  assert.equal(normalizeUrl('https://example.com/search?b=2&a=1'), 'https://example.com/search?a=1&b=2');
});

test('normalizeUrl sorts repeated parameters by value', () => {
  assert.equal(normalizeUrl('https://example.com/x?a=2&a=1'), 'https://example.com/x?a=1&a=2');
});

test('normalizeUrl keeps the path, encodes consistently and normalizes host/port', () => {
  assert.equal(normalizeUrl('https://Example.Test:443/a%20b?q=hello world'), 'https://example.test/a%20b?q=hello+world');
});

test('normalizeUrl is idempotent', () => {
  const once = normalizeUrl('https://example.com/path?z=1&a=2#frag');
  assert.equal(normalizeUrl(once), once);
});

test('normalizeUrl leaves unparsable input untouched', () => {
  assert.equal(normalizeUrl('not a url'), 'not a url');
  assert.equal(normalizeUrl(''), '');
});

test('shortUrl returns path + query', () => {
  assert.equal(shortUrl('https://example.com/api/items?page=2#x'), '/api/items?page=2');
  assert.equal(shortUrl('https://example.com'), '/');
  assert.equal(shortUrl('garbage'), 'garbage');
});

test('hostOf and isHttpUrl', () => {
  assert.equal(hostOf('https://api.example.com:8443/x'), 'api.example.com:8443');
  assert.equal(hostOf('nope'), '');
  assert.equal(isHttpUrl('http://localhost/'), true);
  assert.equal(isHttpUrl('https://example.com/'), true);
  assert.equal(isHttpUrl('chrome://extensions'), false);
  assert.equal(isHttpUrl(''), false);
});
