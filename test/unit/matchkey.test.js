import { test } from 'node:test';
import assert from 'node:assert/strict';

import { utf8ToBytes } from '../../src/shared/bytes.js';
import { isGraphqlRequest, requestKey, requestSignature, sha256Hex } from '../../src/shared/matchkey.js';

const body = (text) => utf8ToBytes(text);

test('sha256Hex returns lowercase hex of the right length', async () => {
  const digest = await sha256Hex(body('hello'));
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('equivalent URLs produce the same key', async () => {
  const first = await requestKey({ method: 'GET', url: 'https://example.com/api?b=2&a=1#frag', bodyBytes: undefined });
  const second = await requestKey({ method: 'get', url: 'https://example.com/api?a=1&b=2', bodyBytes: new Uint8Array(0) });
  assert.equal(first, second);
});

test('different methods produce different keys', async () => {
  const get = await requestKey({ method: 'GET', url: 'https://example.com/api', bodyBytes: undefined });
  const post = await requestKey({ method: 'POST', url: 'https://example.com/api', bodyBytes: body('{}') });
  assert.notEqual(get, post);
});

test('different URLs produce different keys', async () => {
  const one = await requestKey({ method: 'GET', url: 'https://example.com/a', bodyBytes: undefined });
  const two = await requestKey({ method: 'GET', url: 'https://example.com/b', bodyBytes: undefined });
  assert.notEqual(one, two);
});

test('same endpoint with different POST bodies produces different keys (core requirement)', async () => {
  const first = await requestKey({ method: 'POST', url: 'https://example.com/api/items', bodyBytes: body('{"id":1}') });
  const second = await requestKey({ method: 'POST', url: 'https://example.com/api/items', bodyBytes: body('{"id":2}') });
  assert.notEqual(first, second);
});

test('exact body bytes matter (whitespace changes the key)', async () => {
  const compact = await requestKey({ method: 'POST', url: 'https://example.com/api', bodyBytes: body('{"id":1}') });
  const spaced = await requestKey({ method: 'POST', url: 'https://example.com/api', bodyBytes: body('{ "id": 1 }') });
  assert.notEqual(compact, spaced);
});

test('missing body equals empty body', async () => {
  const missing = await requestKey({ method: 'POST', url: 'https://example.com/api', bodyBytes: null });
  const empty = await requestKey({ method: 'POST', url: 'https://example.com/api', bodyBytes: new Uint8Array(0) });
  assert.equal(missing, empty);
});

test('requestSignature shows method, normalized URL and body preview', () => {
  const signature = requestSignature({
    method: 'post',
    url: 'https://example.com/api?b=2&a=1#x',
    bodyBytes: body('{"id":1}'),
  });
  assert.match(signature, /^POST https:\/\/example\.com\/api\?a=1&b=2 · \{"id":1\}$/);
});

test('isGraphqlRequest detects graphql URLs', () => {
  assert.equal(isGraphqlRequest({ url: 'https://example.com/graphql' }), true);
  assert.equal(isGraphqlRequest({ url: 'https://example.com/api/graphql/v2' }), true);
  assert.equal(isGraphqlRequest({ url: 'https://example.com/api?query=%7Bme%7D' }), true);
  assert.equal(isGraphqlRequest({ url: 'https://example.com/api/items' }), false);
});

test('isGraphqlRequest detects graphql bodies', () => {
  assert.equal(isGraphqlRequest({ url: 'https://example.com/api', bodyText: '{"query":"{ me { id } }"}' }), true);
  assert.equal(isGraphqlRequest({ url: 'https://example.com/api', bodyBytes: body('query { me { id } }') }), true);
  assert.equal(isGraphqlRequest({ url: 'https://example.com/api', bodyText: 'mutation { login }' }), true);
  assert.equal(isGraphqlRequest({ url: 'https://example.com/api', bodyText: '{"id":1}' }), false);
  assert.equal(isGraphqlRequest({ url: 'https://example.com/api', bodyText: 'hello' }), false);
});
