/**
 * Session lifecycle: one active session per tab, either recording or replay
 * (replay can be temporarily switched to live passthrough).
 *
 * This module owns the badge, broadcasts, crash-recovery persistence and the
 * hooks that turn engine events into UI counters/feed events.
 */
import { BADGE, BROADCAST, FEED_KIND, SESSION_MODE } from '../shared/constants.js';
import { isUrlAllowed } from '../shared/patterns.js';
import { entryHost } from '../shared/scenarioHosts.js';
import { isHttpUrl } from '../shared/url.js';
import * as broadcast from './broadcast.js';
import * as cdp from './cdp.js';
import * as recorder from './recorder.js';
import * as replay from './replay.js';
import * as sites from './sites.js';
import * as store from './store.js';

/** @type {Map<number, any>} tabId -> session */
const sessions = new Map();
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const flushTimers = new Map();
/** @type {Map<string, Set<string>>} de-duplicated transient toasts per session */
const toastHistory = new Map();

/** @type {Map<string, Set<string>>} hosts waiting to be added to scenario metadata */
const pendingHosts = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const hostFlushTimers = new Map();
/**
 * Tabs where we intentionally detach the debugger (stop/restart). The
 * chrome.debugger.onDetach event is async and can arrive after a new session
 * has already started; those events must not tear the new session down.
 * @type {Set<number>}
 */
const expectedDetaches = new Set();

/** @type {ReturnType<typeof setTimeout>|null} */
let persistTimer = null;

/** @param {number} tabId */
export function getSession(tabId) {
  return sessions.get(tabId) ?? null;
}

/** All active sessions (used by the debug report). */
export function listSessionPayloads() {
  return [...sessions.values()].map((session) => payload(session));
}

/** @param {any} session */
export function payload(session) {
  if (!session) return null;
  return {
    tabId: session.tabId,
    mode: session.mode,
    scenarioId: session.scenarioId,
    scenarioName: session.scenarioName,
    startedAt: session.startedAt,
    recorded: session.recorded,
    hits: session.hits,
    misses: session.misses,
    skipped: session.skipped,
    missReasons: { ...(session.missReasons ?? {}) },
    diagnostics: (session.diagnostics ?? []).slice(-10),
    error: session.error ?? null,
  };
}

/**
 * @param {number} tabId
 * @param {string} mode
 * @param {{id:string,name:string}} scenario
 */
function newSession(tabId, mode, scenario) {
  return {
    tabId,
    mode,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    startedAt: Date.now(),
    recorded: 0,
    hits: 0,
    misses: 0,
    skipped: 0,
    /** @type {Record<string, number>} */
    missReasons: {},
    /** @type {Array<{method:string,url:string,reason:string,sameUrl:number,samePath:number,at:number}>} */
    diagnostics: [],
    error: null,
  };
}

/** @param {number} tabId */
async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

/** @param {string} scenarioId */
async function findScenario(scenarioId) {
  const scenario = (await store.getScenarios()).find((item) => item.id === scenarioId);
  if (!scenario) throw new Error('That scenario no longer exists. Refresh the popup and try again.');
  return scenario;
}

/**
 * Validate that this tab may host a session.
 * @param {number} tabId
 */
async function assertTabCanRecord(tabId) {
  const tab = await getTab(tabId);
  const url = String(tab?.url ?? '');
  if (!isHttpUrl(url)) {
    throw new Error('Recording only works on http(s) pages. Open the page you want to record and try again.');
  }
  if (!(await sites.isSiteAllowed(url))) {
    throw new Error('This site is not enabled. Add it in Settings (or use “Enable on this site” in the popup) and try again.');
  }
}

/** @param {number} tabId */
function createHooks(tabId) {
  return {
    onCaptured(session, entry) {
      session.recorded += 1;
      scheduleHostUpdate(session.scenarioId, entry.url);
      pushFeed(tabId, {
        kind: FEED_KIND.RECORDED,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        size: entry.size,
        at: Date.now(),
      });
      scheduleFlush(tabId);
    },
    onCapturedWs(session, entry) {
      session.recorded += 1;
      scheduleHostUpdate(session.scenarioId, entry.url);
      pushFeed(tabId, {
        kind: FEED_KIND.RECORDED,
        method: 'WS',
        url: entry.url,
        status: entry.status,
        size: entry.size,
        at: Date.now(),
        wsAdapter: entry.wsAdapter,
        frameCount: entry.frameCount,
      });
      scheduleFlush(tabId);
    },
    onHit(session, entry, info = {}) {
      session.hits += 1;
      pushFeed(tabId, {
        kind: FEED_KIND.REPLAYED,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        size: entry.size,
        at: Date.now(),
        matchedVia: info.matchedVia ?? 'exact',
      });
      scheduleFlush(tabId);
    },
    onMiss(session, request, info = {}) {
      session.misses += 1;

      const method = String(request?.method ?? 'GET').toUpperCase();
      const url = String(request?.url ?? '');
      const reason = String(info.reason ?? 'no-recording');
      session.missReasons = session.missReasons ?? {};
      session.missReasons[reason] = (session.missReasons[reason] ?? 0) + 1;

      session.diagnostics = session.diagnostics ?? [];
      session.diagnostics.push({
        method,
        url,
        reason,
        sameUrl: Number(info.sameUrl) || 0,
        samePath: Number(info.samePath) || 0,
        at: Date.now(),
      });
      if (session.diagnostics.length > 10) session.diagnostics.splice(0, session.diagnostics.length - 10);

      pushFeed(tabId, {
        kind: FEED_KIND.LIVE,
        method,
        url,
        status: 0,
        size: 0,
        at: Date.now(),
        reason,
      });
      scheduleFlush(tabId);
    },
    onSkipped(session, reason) {
      session.skipped += 1;
      toastOnce(session, reason, 'warn');
      scheduleFlush(tabId);
    },
    onWarning(session, message) {
      toastOnce(session, message, 'warn');
    },
  };
}

/**
 * Start recording a scenario in a tab.
 * @param {number} tabId
 * @param {string} scenarioId
 */
export async function startRecording(tabId, scenarioId) {
  await assertTabCanRecord(tabId);
  const scenario = await findScenario(scenarioId);

  if (sessions.has(tabId)) await stopSession(tabId);

  const session = newSession(tabId, SESSION_MODE.RECORDING, scenario);
  sessions.set(tabId, session);

  try {
    const settings = await store.getSettings();
    await sites.ensureOverlay(tabId);
    await recorder.startRecording({ tabId, scenarioId: scenario.id, session, settings, hooks: createHooks(tabId) });
  } catch (error) {
    sessions.delete(tabId);
    await clearBadge(tabId);
    throw new Error(/** @type {any} */ (error)?.message || 'Could not start recording.');
  }

  await flushSession(tabId);
  return payload(session);
}

/**
 * Start replaying a scenario in a tab.
 * @param {number} tabId
 * @param {string} scenarioId
 */
export async function startReplay(tabId, scenarioId) {
  await assertTabCanRecord(tabId);
  const scenario = await findScenario(scenarioId);

  if (sessions.has(tabId)) await stopSession(tabId);

  const session = newSession(tabId, SESSION_MODE.REPLAY, scenario);
  sessions.set(tabId, session);

  try {
    const settings = await store.getSettings();
    await sites.ensureOverlay(tabId);
    await replay.startReplay({ tabId, scenarioId: scenario.id, session, settings, hooks: createHooks(tabId) });
  } catch (error) {
    sessions.delete(tabId);
    await clearBadge(tabId);
    throw new Error(/** @type {any} */ (error)?.message || 'Could not start replay.');
  }

  await flushSession(tabId);
  return payload(session);
}

/**
 * Switch a replay session to live passthrough and back.
 * @param {number} tabId
 * @param {boolean} live
 */
export async function setLive(tabId, live) {
  const session = sessions.get(tabId);
  if (!session) throw new Error('No session is active for this tab.');
  if (session.mode === SESSION_MODE.RECORDING) {
    throw new Error('Stop recording before switching to live/replay mode.');
  }

  await replay.setLive(tabId, Boolean(live));
  session.mode = live ? SESSION_MODE.LIVE : SESSION_MODE.REPLAY;
  await flushSession(tabId);
  return payload(session);
}

/**
 * Stop whatever session is running in the tab.
 * @param {number} tabId
 * @param {{reason?: 'stopped'|'navigation'|'scenario-deleted'}} [options]
 */
export async function stopSession(tabId, { reason = 'stopped' } = {}) {
  markExpectedDetach(tabId);
  const session = sessions.get(tabId);
  sessions.delete(tabId);

  const timer = flushTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(tabId);
  }

  if (session) {
    try {
      if (session.mode === SESSION_MODE.RECORDING) await recorder.stopRecording(tabId);
      else await replay.stopReplay(tabId);
    } catch {
      /* tab may be gone already */
    }
    toastHistory.delete(toastKey(session));
  } else {
    try {
      await cdp.detach(tabId);
    } catch {
      /* nothing attached */
    }
  }

  await clearBadge(tabId);

  if (session) {
    void broadcast.broadcastToTab(tabId, { type: BROADCAST.SESSION_UPDATE, tabId, session: null });
    void broadcast.broadcastToExtension({ type: BROADCAST.SESSION_UPDATE, tabId, session: null });

    if (reason === 'stopped') {
      if (session.mode === SESSION_MODE.RECORDING) {
        const count = session.recorded;
        toast(
          tabId,
          'info',
          `Recording stopped — ${count} request${count === 1 ? '' : 's'} saved to “${session.scenarioName}”.`,
        );
      } else {
        toast(tabId, 'info', `Replay stopped for “${session.scenarioName}”.`);
      }
    }
    schedulePersist();
    return payload(session);
  }

  schedulePersist();
  return null;
}

/**
 * Refresh any active replay session after recorded payload data changed.
 * @param {string} scenarioId
 */
export async function refreshScenarioData(scenarioId) {
  await replay.refreshScenario(scenarioId);
}

/**
 * Stop every session that uses a scenario (called before deleting it).
 * @param {string} scenarioId
 */
export async function stopSessionsForScenario(scenarioId) {
  for (const [tabId, session] of [...sessions]) {
    if (session.scenarioId === scenarioId) await stopSession(tabId, { reason: 'scenario-deleted' });
  }
}

/**
 * Keep live sessions in sync when a scenario is renamed.
 * @param {string} scenarioId
 * @param {string} name
 */
export function updateSessionScenarioName(scenarioId, name) {
  for (const session of sessions.values()) {
    if (session.scenarioId === scenarioId) {
      session.scenarioName = name;
      void flushSession(session.tabId);
    }
  }
}

/**
 * Route a chrome.debugger event to the right engine.
 * @param {number} tabId
 * @param {string} method
 * @param {any} params
 */
export function handleCdpEvent(tabId, method, params) {
  if (typeof tabId !== 'number') return;
  const session = sessions.get(tabId);
  if (!session) return;

  try {
    if (session.mode === SESSION_MODE.RECORDING) {
      recorder.handleEvent(tabId, method, params);
    } else {
      replay.handleEvent(tabId, method, params);
    }
  } catch (error) {
    console.warn('[api-recorder] CDP event handling failed', error);
  }
}

/**
 * Called when chrome.debugger detaches unexpectedly (DevTools opened, tab
 * closed, permission revoked...).
 * @param {number} tabId
 * @param {string} reason
 */
export async function handleDebuggerDetached(tabId, reason) {
  if (typeof tabId !== 'number') return;
  // Our own stop/restart is detaching this tab; ignore the echo.
  if (expectedDetaches.has(tabId)) return;
  const session = sessions.get(tabId);
  if (!session) return;

  sessions.delete(tabId);
  const timer = flushTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(tabId);
  }
  toastHistory.delete(toastKey(session));

  await clearBadge(tabId);
  schedulePersist();

  void broadcast.broadcastToTab(tabId, { type: BROADCAST.SESSION_UPDATE, tabId, session: null });
  void broadcast.broadcastToExtension({ type: BROADCAST.SESSION_UPDATE, tabId, session: null });
  toast(
    tabId,
    'warn',
    `The debugger detached (${describeDetachReason(reason)}). The ${
      session.mode === SESSION_MODE.RECORDING ? 'recording' : 'replay'
    } was stopped.`,
  );
}

/**
 * Stop a session when the tab navigates outside the allowlist.
 * @param {number} tabId
 * @param {string} url
 */
export async function handleTabUrlChange(tabId, url) {
  const session = sessions.get(tabId);
  if (!session) return;

  if (!isHttpUrl(url)) {
    await stopSession(tabId, { reason: 'navigation' });
    return;
  }
  if (!(await sites.isSiteAllowed(url))) {
    await stopSession(tabId, { reason: 'navigation' });
  }
}

/**
 * Recover sessions after the service worker restarted. Chrome usually keeps
 * the debugger attachment, so `ensureAttached()` can reuse it.
 */
export async function recover() {
  const snapshots = await store.readTabSessions();
  if (!Array.isArray(snapshots) || snapshots.length === 0) return;

  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot.tabId !== 'number' || typeof snapshot.scenarioId !== 'string') continue;
    try {
      const tab = await getTab(snapshot.tabId);
      if (!tab) continue;
      await restoreSession(snapshot);
    } catch (error) {
      toast(
        snapshot.tabId,
        'warn',
        `Could not restore the previous session (${/** @type {any} */ (error)?.message || 'unknown error'}). Start it again from the popup.`,
      );
    }
  }

  await persistSessions();
}

/**
 * @param {any} snapshot
 */
async function restoreSession(snapshot) {
  const scenario = await findScenario(snapshot.scenarioId);
  const mode = [SESSION_MODE.RECORDING, SESSION_MODE.REPLAY, SESSION_MODE.LIVE].includes(snapshot.mode)
    ? snapshot.mode
    : SESSION_MODE.RECORDING;

  const session = newSession(snapshot.tabId, mode, scenario);
  session.startedAt = Number(snapshot.startedAt) || session.startedAt;
  session.recorded = Number(snapshot.recorded) || 0;
  session.hits = Number(snapshot.hits) || 0;
  session.misses = Number(snapshot.misses) || 0;
  session.skipped = Number(snapshot.skipped) || 0;
  sessions.set(snapshot.tabId, session);

  const settings = await store.getSettings();
  const hooks = createHooks(snapshot.tabId);

  try {
    await sites.ensureOverlay(snapshot.tabId);
    if (mode === SESSION_MODE.RECORDING) {
      await recorder.startRecording({ tabId: snapshot.tabId, scenarioId: scenario.id, session, settings, hooks });
    } else {
      await replay.startReplay({ tabId: snapshot.tabId, scenarioId: scenario.id, session, settings, hooks });
      if (mode === SESSION_MODE.LIVE) await replay.setLive(snapshot.tabId, true);
    }
  } catch (error) {
    sessions.delete(snapshot.tabId);
    throw error;
  }

  await flushSession(snapshot.tabId);
}

// ---------------------------------------------------------------------------
// UI plumbing: badge, broadcasts, persistence
// ---------------------------------------------------------------------------

/** @param {number} tabId */
function scheduleFlush(tabId) {
  if (flushTimers.has(tabId)) return;
  const timer = setTimeout(() => {
    flushTimers.delete(tabId);
    void flushSession(tabId);
  }, 150);
  flushTimers.set(tabId, timer);
}

/** @param {number} tabId */
async function flushSession(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;

  await updateBadge(session);
  const snapshot = payload(session);
  void broadcast.broadcastToTab(tabId, { type: BROADCAST.SESSION_UPDATE, tabId, session: snapshot });
  void broadcast.broadcastToExtension({ type: BROADCAST.SESSION_UPDATE, tabId, session: snapshot });
  schedulePersist();
}

/** @param {any} session */
async function updateBadge(session) {
  const tabId = session.tabId;
  let text = '';
  let color = BADGE.RECORDING_BG;
  let title = 'API Recorder';

  if (session.mode === SESSION_MODE.RECORDING) {
    text = compactCount(session.recorded);
    color = BADGE.RECORDING_BG;
    title = `Recording “${session.scenarioName}” — ${session.recorded} recorded`;
  } else if (session.mode === SESSION_MODE.REPLAY) {
    text = compactCount(session.hits);
    color = BADGE.REPLAY_BG;
    title = `Replaying “${session.scenarioName}” — ${session.hits} replayed, ${session.misses} passed live`;
  } else {
    text = 'LIVE';
    color = BADGE.LIVE_BG;
    title = `Live mode — “${session.scenarioName}”`;
  }

  await Promise.all([
    safeAction(() => chrome.action.setBadgeText({ tabId, text })),
    safeAction(() => chrome.action.setBadgeBackgroundColor({ tabId, color })),
    safeAction(() => chrome.action.setTitle({ tabId, title })),
  ]);
}

/** @param {number} tabId */
async function clearBadge(tabId) {
  await Promise.all([
    safeAction(() => chrome.action.setBadgeText({ tabId, text: '' })),
    safeAction(() => chrome.action.setTitle({ tabId, title: 'API Recorder' })),
  ]);
}

/** @param {() => Promise<unknown>} action */
async function safeAction(action) {
  try {
    await action();
  } catch {
    /* tab may be gone */
  }
}

/** @param {number} count */
function compactCount(count) {
  if (count > 999) return '999+';
  return String(count);
}

/** @param {number} tabId @param {object} event */
function pushFeed(tabId, event) {
  void broadcast.broadcastToTab(tabId, { type: BROADCAST.FEED_EVENT, event });
}

/** @param {number} tabId @param {'info'|'warn'|'error'} level @param {string} text */
function toast(tabId, level, text) {
  void broadcast.broadcastToTab(tabId, { type: BROADCAST.TOAST, level, text });
  void broadcast.broadcastToExtension({ type: BROADCAST.TOAST, level, text });
}

/** @param {any} session */
function toastKey(session) {
  return `${session.tabId}:${session.startedAt}`;
}

/**
 * Send a toast at most once per unique message per session (avoids flooding the
 * HUD when many requests are skipped for the same reason).
 * @param {any} session @param {string} text @param {'info'|'warn'|'error'} level
 */
function toastOnce(session, text, level) {
  const key = toastKey(session);
  const seen = toastHistory.get(key) ?? new Set();
  if (seen.has(text) || seen.size >= 5) return;
  seen.add(text);
  toastHistory.set(key, seen);
  toast(session.tabId, level, text);
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistSessions();
  }, 400);
}

async function persistSessions() {
  const snapshots = [...sessions.values()].map((session) => ({
    tabId: session.tabId,
    mode: session.mode,
    scenarioId: session.scenarioId,
    startedAt: session.startedAt,
    recorded: session.recorded,
    hits: session.hits,
    misses: session.misses,
    skipped: session.skipped,
  }));
  await store.writeTabSessions(snapshots);
}

/**
 * Record the request host on the scenario (debounced), so the popup can show
 * only scenarios that recorded on the current tab's host.
 * @param {string} scenarioId
 * @param {string} url
 */
function scheduleHostUpdate(scenarioId, url) {
  const host = entryHost(url);
  if (!host) return;

  const hosts = pendingHosts.get(scenarioId) ?? new Set();
  hosts.add(host);
  pendingHosts.set(scenarioId, hosts);

  if (hostFlushTimers.has(scenarioId)) return;
  hostFlushTimers.set(
    scenarioId,
    setTimeout(() => {
      hostFlushTimers.delete(scenarioId);
      const collected = [...(pendingHosts.get(scenarioId) ?? [])];
      pendingHosts.delete(scenarioId);
      void store.addScenarioHosts(scenarioId, collected);
    }, 600),
  );
}

/**
 * Remember that this tab's detach is expected for a short window.
 * @param {number} tabId
 */
function markExpectedDetach(tabId) {
  expectedDetaches.add(tabId);
  setTimeout(() => expectedDetaches.delete(tabId), 2000);
}

/** @param {string} reason */
function describeDetachReason(reason) {
  switch (reason) {
    case 'target_closed':
      return 'the tab was closed';
    case 'canceled_by_user':
      return 'the debugger was cancelled';
    case 'replaced_with_devtools':
      return 'DevTools was opened';
    case 'reload':
      return 'the page reloaded';
    default:
      return String(reason || 'unknown reason');
  }
}
