#!/usr/bin/env node
/**
 * End-to-end verification with a real Chrome for Testing build.
 *
 * Proves the core promises of the extension:
 *   1. Recording captures only fetch/XHR traffic (no images, no GraphQL).
 *   2. Same endpoint + different POST body = two independent recordings.
 *   3. Replay is transparent: the fixture server is bumped to v2, yet the page
 *      still receives the v1 payloads from storage and the server is not hit.
 *   4. Unrecorded requests pass through live during replay.
 *   5. Live mode sends everything to the real network; replay can be resumed.
 *   6. The toolbar badge shows the recorded/replayed counter.
 *
 * Usage:
 *   npm run e2e:install   # once, downloads Chrome for Testing into .e2e/
 *   npm run test:e2e      # or CHROME_BIN=/path/to/chrome npm run test:e2e
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchChrome } from './cdp-client.mjs';
import { startTestServer } from './server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE_PATTERN = 'http://127.0.0.1/*';
const EXTENSION_PAGE = 'src/options/options.html';

const checks = [];
function check(name, passed, detail = '') {
  const ok = Boolean(passed);
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// ---------------------------------------------------------------------------
// Chrome plumbing
// ---------------------------------------------------------------------------

function findChromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  const direct = join(ROOT, '.e2e', 'chrome-linux64', 'chrome');
  if (existsSync(direct)) return direct;

  const cacheDir = join(ROOT, '.e2e');
  if (existsSync(cacheDir)) {
    for (const entry of readdirSync(cacheDir)) {
      const candidate = join(cacheDir, entry, 'chrome-linux64', 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }

  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const which = spawnSync('which', [name], { encoding: 'utf8' });
    if (which.status === 0) {
      const path = which.stdout.trim();
      console.warn(
        `\n⚠ Using system browser (${path}). Branded Google Chrome no longer supports --load-extension;\n` +
          '  install Chrome for Testing with: npm run e2e:install\n',
      );
      return path;
    }
  }

  throw new Error('Chrome for Testing not found. Run "npm run e2e:install" or set CHROME_BIN.');
}

function prepareExtension(tmpRoot) {
  const extDir = join(tmpRoot, 'extension');
  mkdirSync(extDir, { recursive: true });
  for (const entry of ['manifest.json', 'icons', 'src']) {
    cpSync(join(ROOT, entry), join(extDir, entry), { recursive: true });
  }

  // Declared host permissions are needed so the e2e run can enable the fixture
  // site without a user-gesture permission prompt. Everything else is the real
  // extension.
  const manifestPath = join(extDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [SITE_PATTERN];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return extDir;
}

/** @param {import('./cdp-client.mjs').CdpClient} client */
async function resolveExtensionId(client, extensionPath) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const { targetInfos = [] } = await client.send('Target.getTargets');
      for (const info of targetInfos) {
        const url = String(info.url ?? '');
        const match = /^chrome-extension:\/\/([a-p]{32})\/src\/background\/service-worker\.js$/.exec(url);
        if (match) return match[1];
      }
    } catch {
      /* browser might still be starting */
    }
    await sleep(100);
  }

  // Fallback: unpacked extension ids are derived from the absolute path.
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(extensionPath).digest();
  const alphabet = 'abcdefghijklmnop';
  let id = '';
  for (let index = 0; index < 16; index += 1) {
    id += alphabet[digest[index] >> 4] + alphabet[digest[index] & 0x0f];
  }
  return id;
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

/**
 * @param {import('./cdp-client.mjs').CdpClient} client
 * @param {string} sessionId
 * @param {string} expression
 */
async function evaluate(client, sessionId, expression) {
  const response = await client.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (response.exceptionDetails) {
    const description =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ??
      'Runtime.evaluate failed';
    throw new Error(description);
  }
  return response.result?.value;
}

/**
 * @param {import('./cdp-client.mjs').CdpClient} client
 * @param {string} sessionId
 * @param {string} expression
 * @param {string} label
 */
async function waitForValue(client, sessionId, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(client, sessionId, expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

/**
 * @param {import('./cdp-client.mjs').CdpClient} client
 * @param {string} url
 */
async function createAttachedTarget(client, url) {
  const { targetId } = await client.send('Target.createTarget', { url });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Runtime.enable', {}, sessionId).catch(() => {});
  await client.send('Page.enable', {}, sessionId).catch(() => {});
  return { targetId, sessionId };
}

/**
 * Collect uncaught JS errors (and console errors) from a target.
 * @param {import('./cdp-client.mjs').CdpClient} client
 * @param {string} sessionId
 */
function collectRuntimeErrors(client, sessionId) {
  const errors = [];
  client.on(
    'Runtime.exceptionThrown',
    (params) => {
      const details = params?.exceptionDetails;
      errors.push(details?.exception?.description ?? details?.text ?? 'uncaught exception');
    },
    sessionId,
  );
  client.on(
    'Log.entryAdded',
    (params) => {
      const entry = params?.entry;
      if (entry?.level === 'error') errors.push(`${entry.source ?? 'log'}: ${entry.text ?? ''}`);
    },
    sessionId,
  );
  return errors;
}

// ---------------------------------------------------------------------------
// Extension control surface (runs inside an extension page)
// ---------------------------------------------------------------------------

/**
 * @param {import('./cdp-client.mjs').CdpClient} client
 * @param {string} extensionSession
 * @param {string} type
 * @param {object} [payload]
 */
async function extensionCall(client, extensionSession, type, payload = {}) {
  const message = { type, ...payload };
  return evaluate(
    client,
    extensionSession,
    `(async () => await chrome.runtime.sendMessage(${JSON.stringify(message)}))()`,
  );
}

/**
 * @param {import('./cdp-client.mjs').CdpClient} client
 * @param {string} extensionSession
 * @param {object} values
 */
async function setExtensionStorage(client, extensionSession, values) {
  return evaluate(
    client,
    extensionSession,
    `(async () => { await chrome.storage.local.set(${JSON.stringify(values)}); return true; })()`,
  );
}

/** @param {import('./cdp-client.mjs').CdpClient} client @param {string} sessionId */
async function reloadExtensionPage(client, sessionId) {
  await client.send('Page.reload', {}, sessionId).catch(() => {});
  await waitForValue(
    client,
    sessionId,
    'typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id',
    'the options page',
  );
  await sleep(150);
}

/**
 * @param {import('./cdp-client.mjs').CdpClient} client
 * @param {string} sessionId
 * @param {string} selector
 */
async function clickInPage(client, sessionId, selector) {
  const clicked = await evaluate(
    client,
    sessionId,
    `(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return false;
      target.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`Could not click ${selector}`);
}

/** @param {import('./cdp-client.mjs').CdpClient} client @param {string} sessionId */
async function waitForDialogOpen(client, sessionId) {
  await waitForValue(
    client,
    sessionId,
    `(() => {
      const dialog = document.querySelector('[data-testid="entry-editor"]');
      return Boolean(dialog && dialog.open);
    })()`,
    'the payload editor to open',
  );
}

/** @param {import('./cdp-client.mjs').CdpClient} client @param {string} sessionId */
async function waitForDialogClosed(client, sessionId) {
  await waitForValue(
    client,
    sessionId,
    `(() => {
      const dialog = document.querySelector('[data-testid="entry-editor"]');
      return Boolean(dialog && !dialog.open);
    })()`,
    'the payload editor to close',
  );
}

/**
 * Run a function in the fixture page's MAIN world through chrome.scripting.
 * Using the extension API (instead of a second CDP debugger session) keeps the
 * tab free for chrome.debugger.
 * @param {import('./cdp-client.mjs').CdpClient} client
 * @param {string} extensionSession
 * @param {number} tabId
 * @param {Function} func
 * @param {any[]} [args]
 */
async function runInPage(client, extensionSession, tabId, func, args = []) {
  const expression = `(async () => {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: ${tabId} },
      world: 'MAIN',
      func: ${func.toString()},
      args: ${JSON.stringify(args)},
    });
    return injection ? injection.result : null;
  })()`;
  return evaluate(client, extensionSession, expression);
}

/**
 * @param {import('./cdp-client.mjs').CdpClient} client
 * @param {string} extensionSession
 * @param {number} tabId
 * @param {string} label
 */
async function waitForPageRun(client, extensionSession, tabId, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const snapshot = await runInPage(client, extensionSession, tabId, () => ({
        done: Boolean(window.__test && window.__test.done),
        results: window.__test ? window.__test.results : null,
        errors: window.__test ? window.__test.errors : [],
      }));
      if (snapshot && snapshot.done) {
        return { results: snapshot.results ?? {}, errors: snapshot.errors ?? [] };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

/**
 * Reload the fixture page and wait until the new document finished its run.
 * @param {import('./cdp-client.mjs').CdpClient} client
 * @param {string} extensionSession
 * @param {number} tabId
 */
async function reloadFixturePage(client, extensionSession, tabId) {
  await runInPage(client, extensionSession, tabId, () => {
    window.__e2eOldDocument = true;
  });

  await evaluate(client, extensionSession, `(async () => { await chrome.tabs.reload(${tabId}); return true; })()`);

  await waitForValue(
    client,
    extensionSession,
    `(async () => {
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId: ${tabId} },
          world: 'MAIN',
          func: () => ({
            oldDocument: Boolean(window.__e2eOldDocument),
            done: Boolean(window.__test && window.__test.done),
          }),
        });
        const result = injection && injection.result;
        return result && result.oldDocument === false && result.done === true ? true : null;
      } catch (error) {
        return null;
      }
    })()`,
    'the reloaded fixture page',
  );
}

/**
 * Start a fetch probe in the page (used to prove live vs replayed behaviour).
 * @param {import('./cdp-client.mjs').CdpClient} client
 * @param {string} extensionSession
 * @param {number} tabId
 * @param {string} tag
 * @param {string} path
 */
async function startProbe(client, extensionSession, tabId, tag, path, options = null) {
  await runInPage(
    client,
    extensionSession,
    tabId,
    (probeTag, probePath, probeOptions) => {
      window.__probe(probeTag, probePath, probeOptions);
    },
    [tag, path, options],
  );
}

/**
 * @param {import('./cdp-client.mjs').CdpClient} client
 * @param {string} extensionSession
 * @param {number} tabId
 * @param {string} tag
 */
async function waitForProbe(client, extensionSession, tabId, tag, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const probe = await runInPage(
        client,
        extensionSession,
        tabId,
        (probeTag) => (window.__test && window.__test.probes ? window.__test.probes[probeTag] ?? null : null),
        [tag],
      );
      if (probe && probe.done) return probe;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for probe "${tag}"${lastError ? ` (${lastError.message})` : ''}`);
}

/** @param {{body: string}} probe */
function probeJson(probe) {
  try {
    return JSON.parse(probe.body);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  const chromeBinary = findChromeBinary();
  const server = await startTestServer();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'api-recorder-e2e-'));
  const profileDir = join(tmpRoot, 'profile');
  mkdirSync(profileDir, { recursive: true });
  const extDir = prepareExtension(tmpRoot);

  const args = [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    'about:blank',
  ];

  console.log(`Fixture server: ${server.origin}`);
  console.log(`Chrome binary:    ${chromeBinary}`);
  const chrome = launchChrome({ binary: chromeBinary, args });
  const { client } = chrome;

  try {
    const extensionId = await resolveExtensionId(client, extDir);
    console.log(`Extension ID:     ${extensionId}\n`);

    const extensionTarget = await createAttachedTarget(
      client,
      `chrome-extension://${extensionId}/${EXTENSION_PAGE}`,
    );
    const extensionSession = extensionTarget.sessionId;

    await waitForValue(
      client,
      extensionSession,
      'typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id',
      'the extension options page',
    ).catch(() => {
      throw new Error(
        'The extension page did not load. The unpacked extension was probably not installed ' +
          '(branded Google Chrome no longer supports --load-extension; use Chrome for Testing).',
      );
    });

    await setExtensionStorage(client, extensionSession, {
      sites: [SITE_PATTERN],
      settings: { maxBodyBytes: 10 * 1024 * 1024, skipGraphql: true, replayCookies: false },
    });

    // ---- UI smoke test: the popup and options pages must load and render cleanly.
    await client.send('Log.enable', {}, extensionSession).catch(() => {});
    const optionsErrors = collectRuntimeErrors(client, extensionSession);
    await client.send('Page.reload', {}, extensionSession).catch(() => {});
    await waitForValue(
      client,
      extensionSession,
      'typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id',
      'the options page after reload',
    );
    await waitForValue(
      client,
      extensionSession,
      `document.querySelectorAll('[data-testid^="remove-site-"]').length === 1`,
      'the options page to render the allowlisted site',
    );
    const optionsDom = await evaluate(
      client,
      extensionSession,
      `(() => ({
        hasSiteInput: Boolean(document.querySelector('[data-testid="site-input"]')),
        hasSaveSettings: Boolean(document.querySelector('[data-testid="save-settings"]')),
        hasScenarioList: Boolean(document.querySelector('[data-testid="scenario-list"]')),
        hasDebugReport: Boolean(document.querySelector('[data-testid="copy-debug-report"]')),
        hasExportAll: Boolean(document.querySelector('[data-testid="export-all-scenarios"]')),
        siteRows: document.querySelectorAll('[data-testid^="remove-site-"]').length,
      }))()`,
    );
    check(
      'options page renders sites, settings and troubleshooting controls',
      optionsDom.hasSiteInput &&
        optionsDom.hasSaveSettings &&
        optionsDom.hasScenarioList &&
        optionsDom.hasDebugReport &&
        optionsDom.hasExportAll &&
        optionsDom.siteRows === 1,
      JSON.stringify(optionsDom),
    );

    const popupTarget = await createAttachedTarget(client, `chrome-extension://${extensionId}/src/popup/popup.html`);
    const popupErrors = collectRuntimeErrors(client, popupTarget.sessionId);
    await client.send('Page.reload', {}, popupTarget.sessionId).catch(() => {});
    await waitForValue(
      client,
      popupTarget.sessionId,
      'typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id',
      'the popup page',
    );
    await sleep(1200);
    const popupDom = await evaluate(
      client,
      popupTarget.sessionId,
      `(() => ({
        hasSelect: Boolean(document.querySelector('[data-testid="scenario-select"]')),
        hasStartRecording: Boolean(document.querySelector('[data-testid="start-recording"]')),
        hasStartReplay: Boolean(document.querySelector('[data-testid="start-replay"]')),
        hasHostFilter: Boolean(document.querySelector('[data-testid="host-filter-toggle"]')),
        hasSettings: Boolean(document.querySelector('[data-testid="open-settings"]')),
      }))()`,
    );
    check(
      'popup page renders its controls',
      popupDom.hasSelect && popupDom.hasStartRecording && popupDom.hasStartReplay && popupDom.hasHostFilter && popupDom.hasSettings,
      JSON.stringify(popupDom),
    );
    check('popup page has no uncaught errors', popupErrors.length === 0, popupErrors.join(' | '));

    // ---- Baseline: open the fixture page and let it run against the live server.
    const tab = await evaluate(
      client,
      extensionSession,
      `(async () => { const created = await chrome.tabs.create({ url: ${JSON.stringify(`${server.origin}/`)}, active: false }); return { id: created.id }; })()`,
    );
    const tabId = tab.id;

    const baseline = await waitForPageRun(client, extensionSession, tabId, 'the initial fixture page');
    check('fixture page completed its first live run', baseline.errors.length === 0, baseline.errors.join('; '));
    check('baseline greeting came from the server (v1)', baseline.results.greeting?.body?.version === 'v1');

    const state = await extensionCall(client, extensionSession, 'state.get', { tabId });
    check(
      'allowlist matching accepts the page including its port',
      state?.ok === true && state.currentSite?.supported === true && state.currentSite?.allowed === true,
      JSON.stringify(state?.currentSite),
    );
    check('state.get starts with no scenarios', Array.isArray(state?.scenarios) && state.scenarios.length === 0);
    check('smart fallback matching is enabled by default', state?.settings?.smartFallback === true, JSON.stringify(state?.settings));

    // ---- Create a scenario and record a fresh page run.
    const created = await extensionCall(client, extensionSession, 'scenario.create', { name: 'E2E checkout' });
    check('scenario.create works', created?.ok === true && Boolean(created.scenario?.id), created?.error);
    const scenarioId = created.scenario.id;

    const otherHostCreate = await extensionCall(client, extensionSession, 'scenario.create', {
      name: 'Other host scenario',
      host: 'other.example.com',
    });
    check(
      'scenario creation can seed the tab host for the filtered list',
      otherHostCreate?.scenario?.hosts?.includes('other.example.com') === true,
      JSON.stringify(otherHostCreate?.scenario),
    );

    // ---- The copy dialog must show its known-host combobox on screen.
    await reloadExtensionPage(client, extensionSession);
    await waitForValue(
      client,
      extensionSession,
      `document.querySelectorAll('.scenario-row').length === 2`,
      'the options page to list both scenarios',
    );
    await clickInPage(client, extensionSession, '.scenario-row .scenario-actions [data-testid^="copy-scenario-"]');
    await waitForValue(
      client,
      extensionSession,
      `(() => {
        const dialog = document.querySelector('[data-testid="copy-scenario-dialog"]');
        return Boolean(dialog && dialog.open);
      })()`,
      'the copy scenario dialog to open',
    );
    const combobox = await evaluate(
      client,
      extensionSession,
      `(() => {
        const list = document.querySelector('[data-testid="copy-target-origin-list"]');
        const input = document.querySelector('[data-testid="copy-target-origin"]');
        const rect = list.getBoundingClientRect();
        const topmost = document.elementFromPoint(rect.left + 8, rect.top + 8);
        return {
          hidden: list.hasAttribute('hidden'),
          display: getComputedStyle(list).display,
          optionCount: list.children.length,
          expanded: input.getAttribute('aria-expanded'),
          inViewport: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight,
          unobstructed: Boolean(topmost && topmost.closest('[data-testid="copy-scenario-dialog"]')),
        };
      })()`,
    );
    check(
      'copy dialog shows a visible, unclipped host combobox',
      !combobox.hidden &&
        combobox.display !== 'none' &&
        combobox.optionCount >= 1 &&
        combobox.expanded === 'true' &&
        combobox.inViewport &&
        combobox.unobstructed,
      JSON.stringify(combobox),
    );
    const picked = await evaluate(
      client,
      extensionSession,
      `(() => {
        const list = document.querySelector('[data-testid="copy-target-origin-list"]');
        const option = list.querySelector('[role="option"]');
        const input = document.querySelector('[data-testid="copy-target-origin"]');
        if (!option) return null;
        const origin = option.getAttribute('data-value');
        option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        return { value: input.value, origin, closed: list.hasAttribute('hidden') };
      })()`,
    );
    check(
      'picking a known host fills the target origin and closes the list',
      picked !== null && picked.value === picked.origin && picked.closed === true,
      JSON.stringify(picked),
    );
    await clickInPage(client, extensionSession, '#copy-scenario-cancel');

    const recording = await extensionCall(client, extensionSession, 'session.startRecording', { tabId, scenarioId });
    check('recording started', recording?.ok === true && recording.session?.mode === 'recording', recording?.error);

    await reloadFixturePage(client, extensionSession, tabId);
    const recordedRun = await waitForPageRun(client, extensionSession, tabId, 'the recorded page run');
    check('recorded run had no page errors', recordedRun.errors.length === 0, recordedRun.errors.join('; '));

    const recordedSession = await waitForValue(
      client,
      extensionSession,
      `(async () => {
        const response = await chrome.runtime.sendMessage({ type: 'session.get', tabId: ${tabId} });
        const session = response && response.session;
        return session && session.recorded >= 4 ? session : null;
      })()`,
      'four recorded requests',
    );
    check('recording count is exactly 4', recordedSession.recorded === 4, JSON.stringify(recordedSession));

    const badgeWhileRecording = await waitForValue(
      client,
      extensionSession,
      `(async () => {
        const text = await chrome.action.getBadgeText({ tabId: ${tabId} });
        return text === '4' ? text : null;
      })()`,
      'the recording badge count',
    );
    check('toolbar badge shows the recorded request count', badgeWhileRecording === '4');

    const entriesResponse = await extensionCall(client, extensionSession, 'scenario.entries', {
      scenarioId,
      limit: 50,
    });
    const entries = entriesResponse.entries ?? [];
    check(
      'scenario contains exactly the fetch/XHR requests',
      entries.length === 4 && entriesResponse.total === 4,
      `entries=${entries.length} total=${entriesResponse.total}`,
    );
    const entryPaths = entries.map((entry) => new URL(entry.url).pathname).sort();
    check(
      'recorded endpoints are greeting, echo x2 and xhr',
      JSON.stringify(entryPaths) === JSON.stringify(['/api/echo', '/api/echo', '/api/greeting', '/api/xhr']),
      JSON.stringify(entryPaths),
    );
    check('image requests are not recorded', !entryPaths.includes('/img.png'));
    check('GraphQL requests are not recorded', !entryPaths.includes('/api/graphql'));
    const requestPreviews = entries.map((entry) => entry.requestPreview).join('\n');
    check(
      'same endpoint with different POST bodies stored as separate recordings',
      requestPreviews.includes('{"id":1}') && requestPreviews.includes('{"id":2}'),
      requestPreviews,
    );

    const greetingEntry = entries.find((entry) => new URL(entry.url).pathname === '/api/greeting');
    check('greeting entry is available for editing', Boolean(greetingEntry?.id));

    const debugResponse = await extensionCall(client, extensionSession, 'debug.state');
    const debugReport = debugResponse?.report;
    const debugScenario = (debugReport?.scenarios ?? []).find((item) => item.id === scenarioId);
    check(
      'debug report includes recorded request signatures',
      debugScenario?.entries?.length === 4 &&
        debugScenario.entries.some((entry) => entry.url.includes('/api/greeting')),
      JSON.stringify(debugScenario?.entries?.map((entry) => entry.url)),
    );
    check(
      'debug report includes active session data',
      (debugReport?.sessions ?? []).some((session) => session.tabId === tabId),
      JSON.stringify(debugReport?.sessions),
    );

    await extensionCall(client, extensionSession, 'session.stop', { tabId });
    const afterStop = await extensionCall(client, extensionSession, 'session.get', { tabId });
    check('recording stops cleanly', afterStop?.ok === true && afterStop.session === null, JSON.stringify(afterStop));

    // ---- Hosts are derived from the recorded requests (drives the popup filter).
    const hostsAfterRecording = await waitForValue(
      client,
      extensionSession,
      `(async () => {
        const response = await chrome.runtime.sendMessage({ type: 'state.get', tabId: ${tabId} });
        const scenario = (response?.scenarios ?? []).find((item) => item.id === ${JSON.stringify(scenarioId)});
        return scenario && Array.isArray(scenario.hosts) && scenario.hosts.includes('127.0.0.1:${server.port}') ? scenario.hosts : null;
      })()`,
      'the scenario hosts to include the recorded site',
    );
    check(
      'scenario hosts are derived from the recorded requests',
      Array.isArray(hostsAfterRecording) && hostsAfterRecording.includes(`127.0.0.1:${server.port}`),
      JSON.stringify(hostsAfterRecording),
    );

    // ---- Import/export round trip.
    const exportResponse = await extensionCall(client, extensionSession, 'scenario.export', { scenarioId });
    check(
      'export includes every recorded request with its response body',
      exportResponse?.ok === true &&
        exportResponse?.data?.entries?.length === 4 &&
        exportResponse.data.entries.every((entry) => typeof entry.body === 'string' && entry.body.length > 0),
      JSON.stringify(exportResponse?.data?.entries?.map((entry) => ({ method: entry.method, url: entry.url }))),
    );
    check(
      'export document identifies itself',
      exportResponse?.data?.format === 'api-recorder-scenario' &&
        exportResponse?.data?.formatVersion === 1 &&
        typeof exportResponse?.fileName === 'string',
      JSON.stringify({
        format: exportResponse?.data?.format,
        formatVersion: exportResponse?.data?.formatVersion,
        fileName: exportResponse?.fileName,
      }),
    );

    const importedPayload = {
      ...exportResponse.data,
      scenario: { ...exportResponse.data.scenario, name: 'E2E imported' },
    };
    const importResponse = await extensionCall(client, extensionSession, 'scenario.import', { data: importedPayload });
    check(
      'import creates a new scenario with every recorded request',
      importResponse?.ok === true &&
        importResponse.imported === 4 &&
        importResponse.scenarios?.[0]?.name === 'E2E imported',
      importResponse?.error ?? JSON.stringify(importResponse),
    );
    check(
      'imported scenario inherits hosts from its entries',
      (importResponse?.scenarios?.[0]?.hosts ?? []).includes(`127.0.0.1:${server.port}`),
      JSON.stringify(importResponse?.scenarios?.[0]?.hosts),
    );
    const importedScenarioId = importResponse.scenarios?.[0]?.id;

    const importedReplay = await extensionCall(client, extensionSession, 'session.startReplay', {
      tabId,
      scenarioId: importedScenarioId,
    });
    check(
      'replay works from an imported scenario',
      importedReplay?.ok === true && importedReplay.session?.mode === 'replay',
      importedReplay?.error,
    );

    const hitsBeforeImportedProbe = server.hitsOf('GET', '/api/greeting');
    await startProbe(client, extensionSession, tabId, 'imported', '/api/greeting');
    const importedProbe = await waitForProbe(client, extensionSession, tabId, 'imported');
    const importedBody = probeJson(importedProbe);
    check(
      'imported recording replays without touching the server',
      importedProbe.status === 200 &&
        importedBody?.version === 'v1' &&
        server.hitsOf('GET', '/api/greeting') === hitsBeforeImportedProbe,
      JSON.stringify({ status: importedProbe.status, body: importedBody }),
    );
    await extensionCall(client, extensionSession, 'session.stop', { tabId });

    const invalidImport = await extensionCall(client, extensionSession, 'scenario.import', {
      data: { hello: 'world' },
    });
    check(
      'invalid import files are rejected with an explanation',
      invalidImport?.ok === false && typeof invalidImport.error === 'string',
      invalidImport?.error,
    );

    // ---- Export all / bulk import round trip.
    const exportAllResponse = await extensionCall(client, extensionSession, 'scenario.exportAll');
    check(
      'export all produces a self-describing collection document',
      exportAllResponse?.ok === true &&
        exportAllResponse.data?.format === 'api-recorder-scenarios' &&
        exportAllResponse.data?.formatVersion === 1 &&
        typeof exportAllResponse?.fileName === 'string',
      JSON.stringify({
        format: exportAllResponse?.data?.format,
        formatVersion: exportAllResponse?.data?.formatVersion,
        fileName: exportAllResponse?.fileName,
        error: exportAllResponse?.error,
      }),
    );
    check(
      'export all includes every scenario that has recorded requests',
      exportAllResponse?.data?.scenarios?.length === 2 &&
        exportAllResponse.data.scenarios.every(
          (section) => Array.isArray(section.entries) && section.entries.length === 4,
        ),
      JSON.stringify(
        exportAllResponse?.data?.scenarios?.map((section) => ({
          name: section.scenario?.name,
          entries: section.entries?.length,
        })),
      ),
    );

    const bulkPayload = {
      ...exportAllResponse.data,
      scenarios: exportAllResponse.data.scenarios.map((section) => ({
        ...section,
        scenario: { ...section.scenario, name: `Bulk ${section.scenario.name}` },
      })),
    };
    const bulkImportResponse = await extensionCall(client, extensionSession, 'scenario.import', {
      data: bulkPayload,
    });
    check(
      'bulk import creates one scenario per exported section',
      bulkImportResponse?.ok === true &&
        bulkImportResponse.imported === 8 &&
        bulkImportResponse.scenarios?.length === 2,
      bulkImportResponse?.error ?? JSON.stringify(bulkImportResponse),
    );
    check(
      'bulk imported scenarios carry their entries and hosts',
      (bulkImportResponse?.scenarios ?? []).every(
        (scenario) =>
          scenario.entryCount === 4 && (scenario.hosts ?? []).includes(`127.0.0.1:${server.port}`),
      ),
      JSON.stringify(bulkImportResponse?.scenarios),
    );

    // ---- Payload editor: edit a recorded response through the Settings UI.
    await reloadExtensionPage(client, extensionSession);
    await waitForValue(
      client,
      extensionSession,
      `Boolean(document.querySelector('[data-testid="view-entries-${scenarioId}"]'))`,
      'the scenario list on the settings page',
    );
    await clickInPage(client, extensionSession, `[data-testid="view-entries-${scenarioId}"]`);
    await waitForValue(
      client,
      extensionSession,
      `Boolean(document.querySelector('[data-testid="edit-entry-${greetingEntry.id}"]'))`,
      'the recorded request list with edit buttons',
    );

    // ---- Filter box in the recorded request list.
    await evaluate(
      client,
      extensionSession,
      `(() => {
        const input = document.querySelector('[data-testid="entries-filter"]');
        input.value = 'post /api/echo';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    );
    await waitForValue(
      client,
      extensionSession,
      `document.querySelectorAll('#entries-body tr').length === 2`,
      'the request filter to narrow the list',
    );
    const filteredEntries = await evaluate(
      client,
      extensionSession,
      `(() => ({
        rows: document.querySelectorAll('#entries-body tr').length,
        showsGreeting: Boolean(document.querySelector('[data-testid="edit-entry-${greetingEntry.id}"]')),
        count: String(document.querySelector('[data-testid="entries-filter-count"]').textContent ?? ''),
      }))()`,
    );
    check(
      'request filter narrows the recorded request list by method and URL',
      filteredEntries.rows === 2 && filteredEntries.showsGreeting === false && /2 of 4/.test(filteredEntries.count),
      JSON.stringify(filteredEntries),
    );

    await clickInPage(client, extensionSession, '[data-testid="entries-filter-clear"]');
    await waitForValue(
      client,
      extensionSession,
      `document.querySelectorAll('#entries-body tr').length === 4 &&
        Boolean(document.querySelector('[data-testid="edit-entry-${greetingEntry.id}"]'))`,
      'the cleared filter to restore all requests',
    );
    const clearedEntries = await evaluate(
      client,
      extensionSession,
      `(() => ({
        rows: document.querySelectorAll('#entries-body tr').length,
        count: String(document.querySelector('[data-testid="entries-filter-count"]').textContent ?? ''),
      }))()`,
    );
    check(
      'clearing the request filter restores every recorded request',
      clearedEntries.rows === 4 && /4 requests?/.test(clearedEntries.count),
      JSON.stringify(clearedEntries),
    );

    await clickInPage(client, extensionSession, `[data-testid="edit-entry-${greetingEntry.id}"]`);
    await waitForDialogOpen(client, extensionSession);
    if (process.env.E2E_SCREENSHOT) {
      const screenshot = await client.send('Page.captureScreenshot', { format: 'png' }, extensionSession);
      writeFileSync(process.env.E2E_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    }
    const originalEditorText = await evaluate(
      client,
      extensionSession,
      `document.querySelector('[data-testid="payload-editor"]').value`,
    );
    check(
      'payload editor opens with the recorded response body',
      typeof originalEditorText === 'string' && originalEditorText.includes('hello-v1'),
      String(originalEditorText).slice(0, 140),
    );

    const editedPayload = JSON.stringify({ message: 'edited-by-ui', version: 'edited' });
    await evaluate(
      client,
      extensionSession,
      `(() => {
        const editor = document.querySelector('[data-testid="payload-editor"]');
        editor.value = ${JSON.stringify(editedPayload)};
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    );
    await clickInPage(client, extensionSession, '[data-testid="save-payload"]');
    await waitForDialogClosed(client, extensionSession);

    const editedEntryResponse = await extensionCall(client, extensionSession, 'scenario.entry.get', {
      scenarioId,
      entryId: greetingEntry.id,
    });
    check(
      'Settings UI saves the edited payload and flags the request as edited',
      String(editedEntryResponse?.payload?.text ?? '').includes('edited-by-ui') &&
        editedEntryResponse?.entry?.edited === true,
      JSON.stringify({ payload: editedEntryResponse?.payload?.text, edited: editedEntryResponse?.entry?.edited }),
    );

    // ---- Replay proof: the edited payload is served, then the original is restored.
    const hitsBeforeReplay = { ...server.state.hits };
    server.state.version = 'v2';

    const replaying = await extensionCall(client, extensionSession, 'session.startReplay', { tabId, scenarioId });
    check('replay started', replaying?.ok === true && replaying.session?.mode === 'replay', replaying?.error);

    // First replayed page run must serve the payload edited in Settings.
    await reloadFixturePage(client, extensionSession, tabId);
    const editedRun = await waitForPageRun(client, extensionSession, tabId, 'the page run with the edited payload');
    check('edited payload run had no page errors', editedRun.errors.length === 0, editedRun.errors.join('; '));
    check(
      'replay serves the payload edited in Settings',
      editedRun.results.greeting?.body?.version === 'edited' &&
        editedRun.results.greeting?.body?.message === 'edited-by-ui',
      JSON.stringify(editedRun.results.greeting),
    );
    check(
      'edited payload keeps status and content-type',
      editedRun.results.greeting?.status === 200 &&
        String(editedRun.results.greeting?.contentType ?? '').includes('application/json'),
      JSON.stringify(editedRun.results.greeting),
    );
    check(
      'edited payload never reached the server',
      server.hitsOf('GET', '/api/greeting') === (hitsBeforeReplay['GET /api/greeting'] ?? 0),
      `before=${hitsBeforeReplay['GET /api/greeting'] ?? 0} after=${server.hitsOf('GET', '/api/greeting')}`,
    );

    // Restore the original payload from the same dialog, with replay still active.
    await clickInPage(client, extensionSession, `[data-testid="edit-entry-${greetingEntry.id}"]`);
    await waitForDialogOpen(client, extensionSession);
    const editedEditorText = await evaluate(
      client,
      extensionSession,
      `document.querySelector('[data-testid="payload-editor"]').value`,
    );
    check('editor reopens with the saved edit', String(editedEditorText).includes('edited-by-ui'));
    await clickInPage(client, extensionSession, '[data-testid="restore-payload"]');
    await waitForDialogClosed(client, extensionSession);

    const restoredEntryResponse = await extensionCall(client, extensionSession, 'scenario.entry.get', {
      scenarioId,
      entryId: greetingEntry.id,
    });
    check(
      'restore brings back the original recorded payload',
      String(restoredEntryResponse?.payload?.text ?? '').includes('hello-v1') &&
        restoredEntryResponse?.entry?.edited === false,
      JSON.stringify(restoredEntryResponse?.entry),
    );

    // Second run proves the restore took effect (the replay cache was refreshed).
    await reloadFixturePage(client, extensionSession, tabId);
    const replayRun = await waitForPageRun(client, extensionSession, tabId, 'the replayed page run');
    check('replayed run had no page errors', replayRun.errors.length === 0, replayRun.errors.join('; '));
    const replayResults = replayRun.results;

    check(
      'transparent replay: greeting is the recorded v1 response while the server is v2',
      replayResults.greeting?.body?.version === 'v1',
      JSON.stringify(replayResults.greeting),
    );
    check(
      'fulfilled response keeps status and content-type',
      replayResults.greeting?.status === 200 &&
        String(replayResults.greeting?.contentType ?? '').includes('application/json'),
      JSON.stringify(replayResults.greeting),
    );
    check(
      'POST /api/echo id=1 replayed its own recording',
      replayResults.echo1?.body?.echo?.id === 1 && replayResults.echo1?.body?.version === 'v1',
      JSON.stringify(replayResults.echo1),
    );
    check(
      'POST /api/echo id=2 replayed its own recording (body-aware matching)',
      replayResults.echo2?.body?.echo?.id === 2 && replayResults.echo2?.body?.version === 'v1',
      JSON.stringify(replayResults.echo2),
    );
    check(
      'XHR response was replayed',
      replayResults.xhr?.status === 200 && replayResults.xhr?.body === 'xhr-v1',
      JSON.stringify(replayResults.xhr),
    );

    check(
      'replayed greeting never reached the server',
      server.hitsOf('GET', '/api/greeting') === (hitsBeforeReplay['GET /api/greeting'] ?? 0),
      `before=${hitsBeforeReplay['GET /api/greeting'] ?? 0} after=${server.hitsOf('GET', '/api/greeting')}`,
    );
    check(
      'replayed POST /api/echo never reached the server',
      server.hitsOf('POST', '/api/echo') === (hitsBeforeReplay['POST /api/echo'] ?? 0),
      `before=${hitsBeforeReplay['POST /api/echo'] ?? 0} after=${server.hitsOf('POST', '/api/echo')}`,
    );
    check(
      'replayed XHR never reached the server',
      server.hitsOf('GET', '/api/xhr') === (hitsBeforeReplay['GET /api/xhr'] ?? 0),
    );

    check(
      'GraphQL passed through live during replay (server v2)',
      replayResults.graphql?.body?.data?.ping === 'v2',
      JSON.stringify(replayResults.graphql?.body),
    );
    check(
      'GraphQL requests reached the live server on both replayed runs',
      server.hitsOf('POST', '/api/graphql') === (hitsBeforeReplay['POST /api/graphql'] ?? 0) + 2,
      `before=${hitsBeforeReplay['POST /api/graphql'] ?? 0} after=${server.hitsOf('POST', '/api/graphql')}`,
    );
    check(
      'non-XHR image requests stay live',
      replayResults.image?.width === 1 &&
        server.hitsOf('GET', '/img.png') === (hitsBeforeReplay['GET /img.png'] ?? 0) + 2,
      JSON.stringify(replayResults.image),
    );

    const replaySession = await waitForValue(
      client,
      extensionSession,
      `(async () => {
        const response = await chrome.runtime.sendMessage({ type: 'session.get', tabId: ${tabId} });
        const session = response && response.session;
        return session && session.hits >= 8 ? session : null;
      })()`,
      'eight replayed requests',
    );
    check('replay counter includes both replayed page runs', replaySession.hits === 8, JSON.stringify(replaySession));

    const replayBadge = await waitForValue(
      client,
      extensionSession,
      `(async () => {
        const text = await chrome.action.getBadgeText({ tabId: ${tabId} });
        return text === '8' ? text : null;
      })()`,
      'the replay badge count',
    );
    check('toolbar badge shows the replayed count', replayBadge === '8');

    // ---- Smart fallback matching + diagnostics for requests that stay live.
    const greetingHitsBeforeFallback = server.hitsOf('GET', '/api/greeting');
    await startProbe(client, extensionSession, tabId, 'fallback-path', '/api/greeting?cacheBust=123');
    const fallbackProbe = await waitForProbe(client, extensionSession, tabId, 'fallback-path');
    const fallbackBody = probeJson(fallbackProbe);
    check(
      'smart fallback replays a recording with a different query string',
      fallbackProbe.status === 200 && fallbackBody?.version === 'v1',
      JSON.stringify({ status: fallbackProbe.status, body: fallbackBody }),
    );
    check(
      'smart fallback did not hit the server',
      server.hitsOf('GET', '/api/greeting') === greetingHitsBeforeFallback,
      `before=${greetingHitsBeforeFallback} after=${server.hitsOf('GET', '/api/greeting')}`,
    );

    const echoHitsBeforeAmbiguous = server.hitsOf('POST', '/api/echo');
    await startProbe(client, extensionSession, tabId, 'fallback-ambiguous', '/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 3 }),
    });
    const ambiguousProbe = await waitForProbe(client, extensionSession, tabId, 'fallback-ambiguous');
    const ambiguousBody = probeJson(ambiguousProbe);
    check(
      'ambiguous fallback stays live instead of guessing',
      ambiguousProbe.status === 200 && ambiguousBody?.version === 'v2' && ambiguousBody?.echo?.id === 3,
      JSON.stringify({ status: ambiguousProbe.status, body: ambiguousBody }),
    );
    check(
      'ambiguous fallback reached the server',
      server.hitsOf('POST', '/api/echo') === echoHitsBeforeAmbiguous + 1,
      `before=${echoHitsBeforeAmbiguous} after=${server.hitsOf('POST', '/api/echo')}`,
    );

    const diagnosticsResponse = await extensionCall(client, extensionSession, 'session.get', { tabId });
    const diagnosticsSession = diagnosticsResponse?.session;
    check(
      'live passes are categorized for diagnostics',
      diagnosticsSession?.missReasons?.['ambiguous-body'] >= 1,
      JSON.stringify(diagnosticsSession?.missReasons),
    );
    check(
      'diagnostics list the request that stayed live',
      (diagnosticsSession?.diagnostics ?? []).some(
        (entry) => entry.reason === 'ambiguous-body' && entry.url.includes('/api/echo'),
      ),
      JSON.stringify(diagnosticsSession?.diagnostics),
    );

    const debugAfterMisses = await extensionCall(client, extensionSession, 'debug.state');
    const reportSession = (debugAfterMisses?.report?.sessions ?? []).find((session) => session.tabId === tabId);
    check(
      'debug report includes live-pass diagnostics',
      reportSession?.missReasons?.['ambiguous-body'] >= 1,
      JSON.stringify(reportSession?.missReasons),
    );

    // ---- Live mode: everything goes to the network.
    const greetingHitsBeforeLive = server.hitsOf('GET', '/api/greeting');
    const liveToggle = await extensionCall(client, extensionSession, 'session.setLive', { tabId, live: true });
    check('live mode can be enabled', liveToggle?.ok === true && liveToggle.session?.mode === 'live', liveToggle?.error);

    await startProbe(client, extensionSession, tabId, 'live', '/api/greeting');
    const liveProbe = await waitForProbe(client, extensionSession, tabId, 'live');
    const liveBody = probeJson(liveProbe);
    check(
      'live mode reaches the real network (v2)',
      liveProbe.status === 200 && liveBody?.version === 'v2',
      JSON.stringify({ status: liveProbe.status, body: liveBody }),
    );
    check(
      'live mode request hit the server',
      server.hitsOf('GET', '/api/greeting') === greetingHitsBeforeLive + 1,
    );

    // ---- Back to replay for the same tab/scenario.
    const greetingHitsBeforeResume = server.hitsOf('GET', '/api/greeting');
    const resume = await extensionCall(client, extensionSession, 'session.setLive', { tabId, live: false });
    check('replay can be resumed from live mode', resume?.ok === true && resume.session?.mode === 'replay');

    await startProbe(client, extensionSession, tabId, 'resumed', '/api/greeting');
    const resumedProbe = await waitForProbe(client, extensionSession, tabId, 'resumed');
    const resumedBody = probeJson(resumedProbe);
    check(
      'resumed replay serves the recording again (v1)',
      resumedProbe.status === 200 && resumedBody?.version === 'v1',
      JSON.stringify({ status: resumedProbe.status, body: resumedBody }),
    );
    check(
      'resumed replay did not hit the server',
      server.hitsOf('GET', '/api/greeting') === greetingHitsBeforeResume,
    );

    // ---- Unrecorded request must pass through live during replay.
    const liveOnlyHitsBefore = server.hitsOf('GET', '/api/live-only');
    await startProbe(client, extensionSession, tabId, 'mismatch', '/api/live-only');
    const mismatchProbe = await waitForProbe(client, extensionSession, tabId, 'mismatch');
    const mismatchBody = probeJson(mismatchProbe);
    check(
      'unrecorded request passes through live during replay',
      mismatchProbe.status === 200 && mismatchBody?.live === 'v2',
      JSON.stringify({ status: mismatchProbe.status, body: mismatchBody }),
    );
    check(
      'unrecorded request reached the server',
      server.hitsOf('GET', '/api/live-only') === liveOnlyHitsBefore + 1,
    );

    // ---- Stop: pure live browsing again, scenario untouched.
    const greetingHitsBeforeStop = server.hitsOf('GET', '/api/greeting');
    await extensionCall(client, extensionSession, 'session.stop', { tabId });
    const finalSession = await extensionCall(client, extensionSession, 'session.get', { tabId });
    check('replay stops cleanly', finalSession?.ok === true && finalSession.session === null);

    await startProbe(client, extensionSession, tabId, 'after-stop', '/api/greeting');
    const afterStopProbe = await waitForProbe(client, extensionSession, tabId, 'after-stop');
    const afterStopBody = probeJson(afterStopProbe);
    check(
      'after stopping, requests are live again (v2)',
      afterStopBody?.version === 'v2' &&
        server.hitsOf('GET', '/api/greeting') === greetingHitsBeforeStop + 1,
      JSON.stringify(afterStopBody),
    );

    const finalEntries = await extensionCall(client, extensionSession, 'scenario.entries', {
      scenarioId,
      limit: 50,
    });
    check('replay did not modify the scenario', finalEntries?.total === 4, String(finalEntries?.total));
    check(
      'restored request is no longer flagged as edited',
      finalEntries?.entries?.find((entry) => entry.id === greetingEntry.id)?.edited === false,
    );

    // ---- Per-request deletion with explicit confirmation.
    const xhrEntry = entries.find((entry) => new URL(entry.url).pathname === '/api/xhr');
    await clickInPage(client, extensionSession, `[data-testid="delete-entry-${xhrEntry.id}"]`);
    await waitForValue(
      client,
      extensionSession,
      `(() => {
        const button = document.querySelector('[data-testid="delete-entry-${xhrEntry.id}"]');
        return Boolean(button && /confirm/i.test(button.textContent));
      })()`,
      'the delete confirmation state',
    );
    const confirmLabel = await evaluate(
      client,
      extensionSession,
      `String(document.querySelector('[data-testid="delete-entry-${xhrEntry.id}"]').textContent ?? '')`,
    );
    check('deleting a request asks for explicit confirmation first', /confirm/i.test(confirmLabel), confirmLabel);

    await clickInPage(client, extensionSession, `[data-testid="delete-entry-${xhrEntry.id}"]`);
    await waitForValue(
      client,
      extensionSession,
      `!document.querySelector('[data-testid="delete-entry-${xhrEntry.id}"]')`,
      'the deleted request to disappear from the list',
    );

    const entriesAfterDelete = await extensionCall(client, extensionSession, 'scenario.entries', {
      scenarioId,
      limit: 50,
    });
    check(
      'the request was removed from the recording',
      entriesAfterDelete?.total === 3 &&
        !(entriesAfterDelete.entries ?? []).some((entry) => entry.id === xhrEntry.id),
      JSON.stringify(entriesAfterDelete?.total),
    );

    const stateAfterDelete = await extensionCall(client, extensionSession, 'state.get', { tabId });
    const scenarioAfterDelete = (stateAfterDelete?.scenarios ?? []).find((item) => item.id === scenarioId);
    check('the scenario count updates after the deletion', scenarioAfterDelete?.entryCount === 3, JSON.stringify(scenarioAfterDelete?.entryCount));
    check('options page had no uncaught errors during the run', optionsErrors.length === 0, optionsErrors.join(' | '));
  } catch (error) {
    console.error(`\nE2E run aborted: ${error.message}`);
    const stderr = chrome.stderrText();
    if (stderr.trim()) console.error(`\nChrome stderr (tail):\n${stderr.slice(-3000)}`);
    checks.push({ name: 'e2e run completed without a fatal error', ok: false, detail: error.message });
  } finally {
    chrome.stop();
    await server.close();
    if (process.env.E2E_KEEP) {
      console.log(`\nArtifacts kept in ${tmpRoot}`);
    } else {
      rmSync(tmpRoot, { recursive: true, force: true });
    }

    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length > 0) {
      console.log('Failed checks:');
      for (const entry of failed) {
        console.log(`  - ${entry.name}${entry.detail ? `\n      ${entry.detail}` : ''}`);
      }
      process.exitCode = 1;
    } else {
      console.log('E2E OK');
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
