import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isUrlAllowed,
  matchesPattern,
  normalizeSiteInput,
  patternForTabUrl,
  patternToRegExp,
} from '../../src/shared/patterns.js';

test('normalizeSiteInput adds both schemes for bare domains', () => {
  assert.equal(normalizeSiteInput('example.com'), '*://example.com/*');
  assert.equal(normalizeSiteInput('  Example.COM  '), '*://example.com/*');
});

test('normalizeSiteInput keeps explicit schemes and grows paths', () => {
  assert.equal(normalizeSiteInput('https://example.com'), 'https://example.com/*');
  assert.equal(normalizeSiteInput('https://example.com/app'), 'https://example.com/app*');
  assert.equal(normalizeSiteInput('https://example.com/app/'), 'https://example.com/app/*');
  assert.equal(normalizeSiteInput('https://example.com/*'), 'https://example.com/*');
});

test('normalizeSiteInput supports wildcard subdomains and all-sites patterns', () => {
  assert.equal(normalizeSiteInput('*.example.com'), '*://*.example.com/*');
  assert.equal(normalizeSiteInput('*://*/*'), '*://*/*');
});

test('normalizeSiteInput strips ports because match patterns ignore them', () => {
  assert.equal(normalizeSiteInput('localhost:3000'), '*://localhost/*');
  assert.equal(normalizeSiteInput('http://127.0.0.1:8080/app'), 'http://127.0.0.1/app*');
});

test('normalizeSiteInput is idempotent', () => {
  for (const pattern of ['*://example.com/*', 'https://example.com/app*', '*://*.example.com/*']) {
    assert.equal(normalizeSiteInput(pattern), pattern);
  }
});

test('normalizeSiteInput rejects nonsense', () => {
  assert.throws(() => normalizeSiteInput(''), /Enter a site address/);
  assert.throws(() => normalizeSiteInput('   '), /Enter a site address/);
  assert.throws(() => normalizeSiteInput('a b'), /Invalid host/);
  assert.throws(() => normalizeSiteInput('example..com'), /Invalid host/);
});

test('matchesPattern supports scheme and subdomain wildcards', () => {
  assert.equal(matchesPattern('*://*.example.com/*', 'https://api.example.com/users?x=1'), true);
  assert.equal(matchesPattern('*://*.example.com/*', 'http://example.com/'), true);
  assert.equal(matchesPattern('*://*.example.com/*', 'https://example.com.evil.test/'), false);
  assert.equal(matchesPattern('https://example.com/*', 'http://example.com/'), false);
});

test('matchesPattern respects ports in URLs but patterns omit them', () => {
  assert.equal(matchesPattern('http://127.0.0.1/*', 'http://127.0.0.1:41234/api/x'), true);
  assert.equal(matchesPattern('*://localhost/*', 'http://localhost:3000/app'), true);
  assert.equal(matchesPattern('http://127.0.0.1/*', 'http://127.0.0.2:41234/api/x'), false);
});

test('matchesPattern respects paths', () => {
  assert.equal(matchesPattern('https://example.com/app*', 'https://example.com/app/dashboard'), true);
  assert.equal(matchesPattern('https://example.com/app*', 'https://example.com/other'), false);
  assert.equal(matchesPattern('https://example.com/*', 'https://example.com/a/b/c'), true);
});

test('patternToRegExp rejects malformed patterns', () => {
  assert.throws(() => patternToRegExp('example.com'));
  assert.throws(() => patternToRegExp('ftp://example.com/*'));
});

test('patternForTabUrl builds a host pattern without the port', () => {
  assert.equal(patternForTabUrl('http://127.0.0.1:5123/page?x=1'), 'http://127.0.0.1/*');
  assert.equal(patternForTabUrl('https://app.test/dashboard'), 'https://app.test/*');
  assert.throws(() => patternForTabUrl('chrome://extensions'), /Only http/);
});

test('isUrlAllowed checks the whole allowlist', () => {
  const sites = ['*://example.com/*', 'http://127.0.0.1/*'];
  assert.equal(isUrlAllowed('https://example.com/x', sites), true);
  assert.equal(isUrlAllowed('http://127.0.0.1:9000/api', sites), true);
  assert.equal(isUrlAllowed('https://other.test/', sites), false);
  assert.equal(isUrlAllowed('https://example.com/', []), false);
});
