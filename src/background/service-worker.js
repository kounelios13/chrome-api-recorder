/**
 * Service worker entry point.
 *
 * Owns the message API for the popup, options page and the in-page HUD, wires
 * Chrome events to the engines and recovers sessions after a restart.
 */
import { DEFAULT_SETTINGS, LIMITS, MSG } from '../shared/constants.js';
import { base64ToBytes, bytesToBase64, bytesToUtf8, looksLikeText, utf8ToBytes } from '../shared/bytes.js';
import { buildEditedEntry, summarizeEntry } from '../shared/entryBody.js';
import { isHttpUrl } from '../shared/url.js';
import { patternForTabUrl } from '../shared/patterns.js';
import { newScenario, newScenarioId, normalizeScenarioName } from '../shared/scenarios.js';
import { collectEntryHosts, sanitizeHosts } from '../shared/scenarioHosts.js';
import { normalizeTargetOrigin, rewriteScenarioEntries } from '../shared/scenarioCopy.js';
import {
  buildCollectionExportDocument,
  buildExportDocument,
  normalizeImportedScenarios,
  scenarioFileSlug,
  uniqueImportedName,
} from '../shared/scenarioTransfer.js';
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
  if (changeInfo.status === 'loading') {
    void ready.then(() => sessions.handleTabLoad(tabId)).catch(() => {});
  }
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
      // Seed the current tab's host so a brand-new scenario shows up in the
      // popup's host-filtered list before it has captured anything.
      const seedHosts = sanitizeHosts([typeof message.host === 'string' ? message.host : '']);
      if (seedHosts.length > 0) scenario.hosts = seedHosts;
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

    case MSG.SCENARIO_COPY: {
      const sourceId = requireString(message.scenarioId, 'Missing scenario id.');
      const name = normalizeScenarioName(message.name);
      const target = normalizeTargetOrigin(message.targetOrigin);
      const rewriteHeaders = message.rewriteHeaders !== false;

      const scenarios = await store.getScenarios();
      const source = scenarios.find((item) => item.id === sourceId);
      if (!source) throw new Error('That scenario no longer exists.');
      ensureUniqueName(scenarios, name);

      const entries = await db.listEntries(sourceId);
      const bodiesById = {};
      const framesById = {};
      for (const entry of entries) {
        if (entry.kind === 'ws') {
          framesById[entry.id] = await db.listWsFrames(entry.id);
          continue;
        }
        bodiesById[entry.id] = (await db.getBody(entry.id)) ?? { id: entry.id, body: '' };
      }

      const id = newScenarioId();
      const now = Date.now();
      const rewritten = await rewriteScenarioEntries({
        entries,
        bodiesById,
        framesById,
        newScenarioId: id,
        targetOrigin: target.origin,
        rewriteHeaders,
      });

      if (rewritten.records.length > 0) {
        await db.saveEntriesBulk(rewritten.records);
      }

      const scenario = {
        id,
        name,
        createdAt: now,
        updatedAt: now,
        hosts: rewritten.hosts,
      };
      scenarios.push(scenario);
      await store.setScenarios(scenarios);

      return {
        ok: true,
        scenario: { ...scenario, entryCount: rewritten.copiedCount },
        scenarios: await listScenariosWithCounts(),
        copiedCount: rewritten.copiedCount,
        rekeyedCount: rewritten.rekeyedCount,
        fallbackCount: rewritten.fallbackCount,
      };
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
        entries: entries.slice(0, limit).map((entry) => summarizeEntry(entry)),
        total: entries.length,
      };
    }

    case MSG.ENTRY_GET: {
      const { scenarioId, entryId } = requireEntryIds(message);
      const entry = await findRecordedEntry(scenarioId, entryId);
      if (entry.kind === 'ws') {
        throw new Error('WebSocket recordings are edited frame by frame. Open the WS frame timeline instead.');
      }
      const bodyRecord = await db.getBody(entryId);
      if (!bodyRecord) throw new Error('The response body for this request is missing from storage.');

      const bytes = base64ToBytes(bodyRecord.body);
      const editable = looksLikeText(bytes);
      const payload = editable
        ? { kind: 'text', text: bytesToUtf8(bytes), size: bytes.length }
        : { kind: 'binary', base64: bodyRecord.body, size: bytes.length };

      return {
        ok: true,
        entry: summarizeEntry(entry),
        payload,
        editable,
        hasOriginal: typeof bodyRecord.originalBody === 'string',
      };
    }

    case MSG.ENTRY_UPDATE: {
      const { scenarioId, entryId } = requireEntryIds(message);
      const entry = await findRecordedEntry(scenarioId, entryId);

      if (message.restoreOriginal) {
        const bodyRecord = await db.getBody(entryId);
        if (!bodyRecord || typeof bodyRecord.originalBody !== 'string') {
          throw new Error('There is no original payload to restore for this request.');
        }

        const bytes = base64ToBytes(bodyRecord.originalBody);
        const restoredEntry = buildEditedEntry(entry, bytes, { edited: false });
        const restored = await db.restoreEntryBody(restoredEntry);
        if (!restored) throw new Error('The original payload could not be restored. Try again.');

        await sessions.refreshScenarioData(scenarioId);
        return { ok: true, entry: summarizeEntry(restoredEntry), hasOriginal: false };
      }

      if (typeof message.bodyText !== 'string') throw new Error('The payload must be text.');

      const settings = await store.getSettings();
      const bytes = utf8ToBytes(message.bodyText);
      if (bytes.length > settings.maxBodyBytes) {
        throw new Error(
          `This payload is ${formatBytes(bytes.length)}, above the ${formatBytes(settings.maxBodyBytes)} limit. Raise “Max response size” in Settings first.`,
        );
      }

      const editedEntry = buildEditedEntry(entry, bytes, { edited: true });
      const { hasOriginal } = await db.updateEntryBody(editedEntry, bytesToBase64(bytes), {
        preserveOriginal: true,
      });
      await sessions.refreshScenarioData(scenarioId);
      return { ok: true, entry: summarizeEntry(editedEntry), hasOriginal };
    }

    case MSG.ENTRY_DELETE: {
      const { scenarioId, entryId } = requireEntryIds(message);
      await findRecordedEntry(scenarioId, entryId);
      await db.deleteEntry(entryId);
      await sessions.refreshScenarioData(scenarioId);

      // Keep the scenario's hosts and count accurate after the removal.
      const remaining = await db.listEntries(scenarioId);
      const hosts = collectEntryHosts(remaining);
      const scenarios = await store.getScenarios();
      const scenario = scenarios.find((item) => item.id === scenarioId);
      if (scenario) {
        scenario.hosts = hosts;
        await store.setScenarios(scenarios);
      }

      return {
        ok: true,
        deleted: true,
        scenario: { ...(scenario ?? {}), entryCount: remaining.length, hosts },
      };
    }

    case MSG.WS_FRAMES_GET: {
      const { scenarioId, entryId } = requireEntryIds(message);
      const entry = await findRecordedEntry(scenarioId, entryId);
      if (entry.kind !== 'ws') throw new Error('That recording is not a WebSocket connection.');

      const frames = await db.listWsFrames(entryId);
      return {
        ok: true,
        entry: summarizeEntry(entry),
        frames: frames.map(summarizeWsFrame),
        hasEdits: frames.some((frame) => frame.edited === true),
      };
    }

    case MSG.WS_FRAME_UPDATE: {
      const { scenarioId, entryId } = requireEntryIds(message);
      const frameId = requireString(message.frameId, 'Missing WebSocket frame id.');
      const entry = await findRecordedEntry(scenarioId, entryId);
      if (entry.kind !== 'ws') throw new Error('That recording is not a WebSocket connection.');

      const frame = await db.getWsFrame(frameId);
      if (!frame || frame.entryId !== entryId) {
        throw new Error('That WebSocket frame was not found. Close the timeline and open it again.');
      }

      if (message.restoreOriginal) {
        if (typeof frame.originalPayload !== 'string') {
          throw new Error('There is no original payload to restore for this frame.');
        }
        const size = base64ToBytes(frame.originalPayload).length;
        /** @type {any} */
        const restoredFrame = { ...frame, size, edited: false };
        delete restoredFrame.originalPayload;
        const restored = await db.restoreWsFramePayload(restoredFrame);
        if (!restored) throw new Error('The original frame payload could not be restored. Try again.');

        const nextEntry = await persistWsFrameEdit(entry, entryId);
        await sessions.refreshScenarioData(scenarioId);
        const updated = await db.getWsFrame(frameId);
        return {
          ok: true,
          frame: updated ? summarizeWsFrame(updated) : null,
          entry: summarizeEntry(nextEntry),
        };
      }

      if (frame.opcode === 2) throw new Error('Binary WebSocket frames cannot be edited as text.');
      if (typeof message.text !== 'string') throw new Error('The frame payload must be text.');

      const settings = await store.getSettings();
      const bytes = utf8ToBytes(message.text);
      const frameLimit =
        Number(settings.wsMaxFrameBytes) || DEFAULT_SETTINGS.wsMaxFrameBytes;
      if (bytes.length > frameLimit) {
        throw new Error(
          `This frame is ${formatBytes(bytes.length)}, above the ${formatBytes(
            frameLimit,
          )} WebSocket frame limit.`,
        );
      }

      const { hasOriginal } = await db.updateWsFramePayload(
        { ...frame, size: bytes.length, edited: true },
        bytesToBase64(bytes),
      );
      const nextEntry = await persistWsFrameEdit(entry, entryId);
      await sessions.refreshScenarioData(scenarioId);
      const updated = await db.getWsFrame(frameId);
      return {
        ok: true,
        frame: updated ? summarizeWsFrame(updated) : null,
        entry: summarizeEntry(nextEntry),
        hasOriginal,
      };
    }

    case MSG.WS_FRAME_DELETE: {
      const { scenarioId, entryId } = requireEntryIds(message);
      const frameId = requireString(message.frameId, 'Missing WebSocket frame id.');
      const entry = await findRecordedEntry(scenarioId, entryId);
      if (entry.kind !== 'ws') throw new Error('That recording is not a WebSocket connection.');

      const frame = await db.getWsFrame(frameId);
      if (!frame || frame.entryId !== entryId) {
        throw new Error('That WebSocket frame was not found. Close the timeline and open it again.');
      }

      await db.deleteWsFrame(frameId);
      const remaining = await db.listWsFrames(entryId);

      if (remaining.length === 0) {
        await db.deleteEntry(entryId);
        await sessions.refreshScenarioData(scenarioId);

        const entriesLeft = await db.listEntries(scenarioId);
        const hosts = collectEntryHosts(entriesLeft);
        const scenarios = await store.getScenarios();
        const scenario = scenarios.find((item) => item.id === scenarioId);
        if (scenario) {
          scenario.hosts = hosts;
          await store.setScenarios(scenarios);
        }
        return {
          ok: true,
          deleted: true,
          removedEntry: true,
          frames: [],
          scenario: { ...(scenario ?? {}), entryCount: entriesLeft.length, hosts },
        };
      }

      const nextEntry = recomputeWsEntry(entry, remaining);
      await db.putEntry(nextEntry);
      await sessions.refreshScenarioData(scenarioId);
      return {
        ok: true,
        deleted: true,
        removedEntry: false,
        entry: summarizeEntry(nextEntry),
        frames: remaining.map(summarizeWsFrame),
      };
    }

    case MSG.EXPORT_SCENARIO: {
      const scenarioId = requireString(message.scenarioId, 'Missing scenario id.');
      const scenario = (await store.getScenarios()).find((item) => item.id === scenarioId);
      if (!scenario) throw new Error('That scenario no longer exists.');

      const entries = await db.listEntries(scenarioId);
      if (entries.length === 0) throw new Error('This scenario has no recorded requests to export.');

      const bodiesById = {};
      const framesById = {};
      for (const entry of entries) {
        if (entry.kind === 'ws') {
          framesById[entry.id] = await db.listWsFrames(entry.id);
          continue;
        }
        bodiesById[entry.id] = (await db.getBody(entry.id)) ?? { id: entry.id, body: '' };
      }

      const data = buildExportDocument({
        scenario,
        entries,
        bodiesById,
        framesById,
        exportedAt: Date.now(),
        extensionVersion: chrome.runtime.getManifest().version,
      });
      const fileName = `api-recorder-scenario-${scenarioFileSlug(scenario.name)}-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      return { ok: true, fileName, data };
    }

    case MSG.EXPORT_ALL_SCENARIOS: {
      const scenarios = await store.getScenarios();
      const entriesById = {};
      const bodiesById = {};
      const framesById = {};
      const withEntries = [];

      for (const scenario of scenarios) {
        const entries = await db.listEntries(scenario.id);
        if (entries.length === 0) continue;
        entriesById[scenario.id] = entries;
        for (const entry of entries) {
          if (entry.kind === 'ws') {
            framesById[entry.id] = await db.listWsFrames(entry.id);
            continue;
          }
          bodiesById[entry.id] = (await db.getBody(entry.id)) ?? { id: entry.id, body: '' };
        }
        withEntries.push(scenario);
      }

      if (withEntries.length === 0) {
        throw new Error('There are no scenarios with recorded requests to export.');
      }

      const data = buildCollectionExportDocument({
        scenarios: withEntries,
        entriesById,
        bodiesById,
        framesById,
        exportedAt: Date.now(),
        extensionVersion: chrome.runtime.getManifest().version,
      });
      const fileName = `api-recorder-scenarios-${new Date().toISOString().slice(0, 10)}.json`;
      return { ok: true, fileName, data, scenarioCount: withEntries.length };
    }

    case MSG.IMPORT_SCENARIO: {
      const settings = await store.getSettings();
      const sections = normalizeImportedScenarios(message.data, {
        now: Date.now(),
        maxBodyBytes: settings.maxBodyBytes,
        maxFrameBytes: Number(settings.wsMaxFrameBytes) || DEFAULT_SETTINGS.wsMaxFrameBytes,
      });

      const scenarios = await store.getScenarios();
      const importedSummaries = [];
      let importedTotal = 0;
      let skippedTotal = 0;

      for (const section of sections) {
        if (section.records.length === 0) {
          skippedTotal += Math.max(section.skipped.length, 1);
          continue;
        }

        const name = uniqueImportedName(
          section.name,
          scenarios.map((item) => item.name),
        );
        const id = newScenarioId();
        const records = section.records.map(({ entry, body, originalBody, frames }) => ({
          entry: { ...entry, id: db.entryId(id, entry.matchKey), scenarioId: id },
          body,
          originalBody,
          // WebSocket entries carry their frames in the export; dropping them
          // here would import an entry whose replay falls back to the network.
          frames,
        }));
        await db.saveEntriesBulk(records);

        const scenarioMeta = {
          id,
          name,
          createdAt: section.createdAt,
          updatedAt: section.updatedAt,
          hosts: collectEntryHosts(records.map((record) => record.entry)),
        };
        scenarios.push(scenarioMeta);
        importedSummaries.push({ ...scenarioMeta, entryCount: records.length });
        importedTotal += records.length;
        skippedTotal += section.skipped.length;
      }

      if (importedTotal === 0) {
        const firstReason =
          sections.flatMap((section) => section.skipped).map((skip) => skip.reason)[0] ??
          'the file has no valid recorded requests.';
        throw new Error(`Nothing could be imported: ${firstReason}`);
      }

      await store.setScenarios(scenarios);
      return { ok: true, scenarios: importedSummaries, imported: importedTotal, skipped: skippedTotal };
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

    case MSG.DEBUG_STATE: {
      const [settings, sitesList, scenarios] = await Promise.all([
        store.getSettings(),
        sites.listSites(),
        store.getScenarios(),
      ]);

      const scenarioReports = [];
      for (const scenario of scenarios) {
        const entries = await db.listEntries(scenario.id);
        entries.sort((left, right) => (right.capturedAt ?? 0) - (left.capturedAt ?? 0));
        scenarioReports.push({
          id: scenario.id,
          name: scenario.name,
          entryCount: entries.length,
          entries: entries.slice(0, 100).map((entry) => ({
            method: entry.method,
            url: entry.url,
            status: entry.status,
            size: entry.size,
            requestPreview: entry.requestPreview,
            edited: Boolean(entry.edited),
            capturedAt: entry.capturedAt,
          })),
        });
      }

      return {
        ok: true,
        report: {
          generatedAt: Date.now(),
          version: chrome.runtime.getManifest().version,
          settings,
          sites: sitesList,
          scenarios: scenarioReports,
          sessions: sessions.listSessionPayloads(),
        },
      };
    }

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
 * @param {any} message
 * @returns {{scenarioId: string, entryId: string}}
 */
function requireEntryIds(message) {
  return {
    scenarioId: requireString(message?.scenarioId, 'Missing scenario id.'),
    entryId: requireString(message?.entryId, 'Missing recorded request id.'),
  };
}

/**
 * @param {string} scenarioId
 * @param {string} entryId
 */
async function findRecordedEntry(scenarioId, entryId) {
  const entry = await db.getEntry(entryId);
  if (!entry || entry.scenarioId !== scenarioId) {
    throw new Error('That recorded request was not found. Refresh the request list and try again.');
  }
  return entry;
}

/** @param {number} bytes */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * The subset of one recorded WebSocket frame sent to the options page.
 * Text frames carry their payload so the timeline editor can show/edit it;
 * binary frames stay opaque.
 *
 * @param {object} frame
 */
function summarizeWsFrame(frame) {
  const payload = typeof frame.payload === 'string' ? frame.payload : '';
  const bytes = base64ToBytes(payload);
  const isText = Number(frame.opcode) !== 2;
  return {
    id: frame.id,
    seq: Number(frame.seq) || 0,
    direction: frame.direction === 'send' ? 'send' : 'recv',
    opcode: isText ? 1 : 2,
    offsetMs: Number(frame.offsetMs) || 0,
    size: Number(frame.size) || bytes.length,
    edited: frame.edited === true,
    hasOriginal: typeof frame.originalPayload === 'string',
    text: isText ? bytesToUtf8(bytes) : null,
  };
}

/**
 * Recompute a WebSocket entry's derived metadata after its frames changed.
 *
 * @param {object} entry
 * @param {object[]} frames
 */
function recomputeWsEntry(entry, frames) {
  const sent = frames.filter((frame) => frame.direction === 'send').length;
  const size = frames.reduce((sum, frame) => sum + (Number(frame.size) || 0), 0);
  const edited = frames.some((frame) => frame.edited === true);
  return {
    ...entry,
    frameCount: frames.length,
    sentCount: sent,
    recvCount: frames.length - sent,
    size,
    edited,
    editedAt: edited ? Date.now() : null,
    responsePreview: `${frames.length} frame${frames.length === 1 ? '' : 's'}`,
  };
}

/**
 * Refresh an entry's metadata from its stored frames and persist it.
 *
 * @param {object} entry
 * @param {string} entryIdValue
 */
async function persistWsFrameEdit(entry, entryIdValue) {
  const frames = await db.listWsFrames(entryIdValue);
  const nextEntry = recomputeWsEntry(entry, frames);
  await db.putEntry(nextEntry);
  return nextEntry;
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
  let hostsChanged = false;

  const withCounts = await Promise.all(
    scenarios.map(async (scenario) => {
      const entryCount = await db.countEntries(scenario.id);
      let hosts = scenario.hosts ?? [];
      // Backfill scenarios recorded before host tracking existed.
      if (entryCount > 0 && hosts.length === 0) {
        const entries = await db.listEntries(scenario.id);
        hosts = collectEntryHosts(entries);
        scenario.hosts = hosts;
        hostsChanged = true;
      }
      return { ...scenario, entryCount, hosts };
    }),
  );

  if (hostsChanged) {
    await store.setScenarios(
      withCounts.map(({ id, name, createdAt, updatedAt, hosts }) => ({ id, name, createdAt, updatedAt, hosts })),
    );
  }
  return withCounts;
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
