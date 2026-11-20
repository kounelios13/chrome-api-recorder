/**
 * Service worker entry point.
 *
 * Owns the message API for the popup, options page and the in-page HUD, wires
 * Chrome events to the engines and recovers sessions after a restart.
 */
import { MSG } from '../shared/constants.js';
import { isHttpUrl } from '../shared/url.js';
import { patternForTabUrl } from '../shared/patterns.js';
import { newScenario, normalizeScenarioName } from '../shared/scenarios.js';
import * as db from './db.js';
import * as sessions from './sessions.js';
import * as sites from './sites.js';
import * as store from './store.js';

/** @type {Promise<void>|null} */
let initPromise = null;

/** @returns {Promise<void>} */
function initialize() {
  if (!initPromise) {
    initPromise = doInitialize();
  }
  return initPromise;
}

async function doInitialize() {
  try {
    await sites.syncContentScripts();
  } catch (error) {
    console.warn('[api-recorder] content script sync failed', error);
  }
  try {
    await sessions.recover();
  } catch (error) {
    console.warn('[api-recorder] session recovery failed', error);
  }
}

const ready = initialize();

// ---------------------------------------------------------------------------
// Chrome event wiring (must be registered synchronously)
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});
chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  sessions.handleCdpEvent(source.tabId, method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId === 'number') void sessions.handleDebuggerDetached(source.tabId, reason);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(() => sessions.stopSession(tabId)).catch(() => {});
});

chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
  void ready.then(() => sessions.stopSession(removedTabId)).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  void ready
    .then(() => sessions.handleTabUrlChange(tabId, changeInfo.url))
    .catch((error) => console.warn('[api-recorder] navigation handling failed', error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void dispatch(message, sender).then(
    (response) => sendResponse(response),
    (error) => sendResponse({ ok: false, error: /** @type {any} */ (error)?.message || String(error) }),
  );
  return true; // keep the message channel open for the async response
});

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

/**
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 */
async function dispatch(message, sender) {
  await ready;

  const type = message?.type;
  if (typeof type !== 'string') throw new Error('Malformed extension message.');

  switch (type) {
    case MSG.STATE_GET:
      return { ok: true, ...(await buildState(message.tabId)) };

    case MSG.SESSION_GET: {
      const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
      return { ok: true, session: typeof tabId === 'number' ? sessions.payload(sessions.getSession(tabId)) : null };
    }

    case MSG.OVERLAY_STATE: {
      const tabId = sender.tab?.id;
      return { ok: true, session: typeof tabId === 'number' ? sessions.payload(sessions.getSession(tabId)) : null };
    }

    case MSG.START_RECORDING: {
      const tabId = requireTabId(message, sender);
      const scenarioId = requireString(message.scenarioId, 'Missing scenario.');
      return { ok: true, session: await sessions.startRecording(tabId, scenarioId) };
    }

    case MSG.START_REPLAY: {
      const tabId = requireTabId(message, sender);
      const scenarioId = requireString(message.scenarioId, 'Missing scenario.');
      return { ok: true, session: await sessions.startReplay(tabId, scenarioId) };
    }

    case MSG.SET_LIVE: {
      const tabId = requireTabId(message, sender);
      return { ok: true, session: await sessions.setLive(tabId, Boolean(message.live)) };
    }

    case MSG.STOP_SESSION: {
      const tabId = requireTabId(message, sender);
      await sessions.stopSession(tabId);
      return { ok: true, session: null };
    }

    case MSG.SCENARIO_CREATE: {
      const name = normalizeScenarioName(message.name);
      const scenarios = await store.getScenarios();
      ensureUniqueName(scenarios, name);
      const scenario = newScenario(name);
      scenarios.push(scenario);
      await store.setScenarios(scenarios);
      return { ok: true, scenario, scenarios: await listScenariosWithCounts() };
    }

    case MSG.SCENARIO_RENAME: {
      const id = requireString(message.id, 'Missing scenario id.');
      const name = normalizeScenarioName(message.name);
      const scenarios = await store.getScenarios();
      const scenario = scenarios.find((item) => item.id === id);
      if (!scenario) throw new Error('That scenario no longer exists.');
      ensureUniqueName(scenarios, name, id);
      scenario.name = name;
      scenario.updatedAt = Date.now();
      await store.setScenarios(scenarios);
      sessions.updateSessionScenarioName(id, name);
      return { ok: true, scenario, scenarios: await listScenariosWithCounts() };
    }

    case MSG.SCENARIO_DELETE: {
      const id = requireString(message.id, 'Missing scenario id.');
      await sessions.stopSessionsForScenario(id);
      await db.deleteScenario(id);
      const scenarios = (await store.getScenarios()).filter((item) => item.id !== id);
      await store.setScenarios(scenarios);
      return { ok: true, scenarios: await listScenariosWithCounts() };
    }

    case MSG.SCENARIO_ENTRIES: {
      const scenarioId = requireString(message.scenarioId, 'Missing scenario id.');
      const limit = clampLimit(message.limit, 50, 200);
      const entries = await db.listEntries(scenarioId);
      entries.sort((left, right) => (right.capturedAt ?? 0) - (left.capturedAt ?? 0));
      return {
        ok: true,
        entries: entries.slice(0, limit).map((entry) => ({
          id: entry.id,
          method: entry.method,
          url: entry.url,
          status: entry.status,
          statusText: entry.statusText,
          capturedAt: entry.capturedAt,
          size: entry.size,
          mimeType: entry.mimeType,
          resourceType: entry.resourceType,
          requestPreview: entry.requestPreview,
          responsePreview: entry.responsePreview,
        })),
        total: entries.length,
      };
    }

    case MSG.SETTINGS_SET: {
      const settings = await store.setSettings(message.settings ?? {});
      return { ok: true, settings };
    }

    case MSG.SITES_ADD: {
      const pattern = requireString(message.pattern, 'Missing site pattern.');
      return { ok: true, sites: await sites.addSite(pattern) };
    }

    case MSG.SITES_REMOVE: {
      const pattern = requireString(message.pattern, 'Missing site pattern.');
      return { ok: true, sites: await sites.removeSite(pattern) };
    }

    case MSG.SITES_LIST:
      return { ok: true, sites: await sites.listSites() };

    case MSG.KEEPALIVE:
      return { ok: true, at: Date.now() };

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

/** @param {any} message @param {chrome.runtime.MessageSender} sender */
function requireTabId(message, sender) {
  const tabId = typeof message?.tabId === 'number' ? message.tabId : sender.tab?.id;
  if (typeof tabId !== 'number') throw new Error('No tab is associated with this request.');
  return tabId;
}

/**
 * @param {unknown} value
 * @param {string} message
 */
function requireString(value, message) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message);
  return value;
}

/**
 * @param {Array<{id:string,name:string}>} scenarios
 * @param {string} name
 * @param {string} [exceptId]
 */
function ensureUniqueName(scenarios, name, exceptId) {
  const wanted = name.toLowerCase();
  const clash = scenarios.find((scenario) => scenario.id !== exceptId && scenario.name.toLowerCase() === wanted);
  if (clash) throw new Error(`A scenario named “${name}” already exists.`);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 */
function clampLimit(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

// ---------------------------------------------------------------------------
// State snapshot used by the popup / options page
// ---------------------------------------------------------------------------

/** @param {number|undefined} tabId */
async function buildState(tabId) {
  const [scenarios, sitesList, settings] = await Promise.all([
    listScenariosWithCounts(),
    sites.listSites(),
    store.getSettings(),
  ]);

  let session = null;
  let currentSite = null;
  if (typeof tabId === 'number') {
    session = sessions.payload(sessions.getSession(tabId));
    currentSite = await describeTab(tabId);
  }

  return {
    scenarios,
    sites: sitesList,
    settings,
    session,
    currentSite,
    version: chrome.runtime.getManifest().version,
  };
}

async function listScenariosWithCounts() {
  const scenarios = await store.getScenarios();
  return Promise.all(
    scenarios.map(async (scenario) => ({
      ...scenario,
      entryCount: await db.countEntries(scenario.id),
    })),
  );
}

/** @param {number} tabId */
async function describeTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return null;
  }

  const url = typeof tab?.url === 'string' ? tab.url : '';
  if (!isHttpUrl(url)) {
    return { url: url || null, pattern: null, allowed: false, supported: false };
  }

  let pattern = null;
  try {
    pattern = patternForTabUrl(url);
  } catch {
    /* ignore */
  }

  return {
    url,
    pattern,
    allowed: await sites.isSiteAllowed(url),
    supported: true,
  };
}
