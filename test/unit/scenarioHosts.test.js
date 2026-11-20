import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectEntryHosts,
  entryHost,
  filterScenariosByHost,
  sanitizeHosts,
} from '../../src/shared/scenarioHosts.js';

test('entryHost extracts the lower-cased host', () => {
  assert.equal(entryHost('https://MyApp.Some.com/api/foo?x=1'), 'myapp.some.com');
  assert.equal(entryHost('http://127.0.0.1:8080/path'), '127.0.0.1:8080');
  assert.equal(entryHost('not a url'), '');
});

test('collectEntryHosts deduplicates and sorts hosts', () => {
  const entries = [
    { url: 'https://b.test/x' },
    { url: 'https://A.test/y' },
    { url: 'https://a.test/z' },
    { url: 'garbage' },
  ];
  assert.deepEqual(collectEntryHosts(entries), ['a.test', 'b.test']);
  assert.deepEqual(collectEntryHosts(undefined), []);
});

test('sanitizeHosts trims, lower-cases and deduplicates', () => {
  assert.deepEqual(sanitizeHosts(['B.test', ' b.test ', 'A.test', '']), ['a.test', 'b.test']);
  assert.deepEqual(sanitizeHosts(undefined), []);
  assert.deepEqual(sanitizeHosts('nope'), []);
});

test('filterScenariosByHost keeps only scenarios that recorded on the host', () => {
  const scenarios = [
    { id: 's1', name: 'Checkout', hosts: ['myapp.some.com', 'api.some.com'] },
    { id: 's2', name: 'Admin', hosts: ['admin.some.com'] },
    { id: 's3', name: 'Empty', hosts: [] },
  ];
  assert.deepEqual(filterScenariosByHost(scenarios, 'myapp.some.com').map((s) => s.id), ['s1']);
  assert.deepEqual(filterScenariosByHost(scenarios, 'MYAPP.SOME.COM').map((s) => s.id), ['s1']);
  assert.deepEqual(filterScenariosByHost(scenarios, 'unknown.test').map((s) => s.id), []);
  // No host filter: everything is returned (a copy).
  const all = filterScenariosByHost(scenarios, '');
  assert.equal(all.length, 3);
  assert.notEqual(all, scenarios);
});
