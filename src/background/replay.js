/**
 * Replay engine.
 *
 * Pauses every request in the tab through the CDP `Fetch` domain. Requests are
 * only held for as long as it takes to look up the recorded entry; matching
 * requests are answered with `Fetch.fulfillRequest` (the transparent part),
 * everything else is forwarded with `Fetch.continueRequest`.
 *
 * Matching is tiered (see shared/matchIndex.js):
 *   exact (method + normalized URL + body) → unambiguous URL → unambiguous path.
 * The fallback tiers make replayed sessions work against APIs that embed
 * timestamps/tokens in request bodies or cache-busting query strings, without
 * guessing when several recordings could apply. Every live pass records a
 * diagnostic reason that the popup surfaces.
 */
import { base64ToBytes, concatBytes, utf8ToBytes } from '../shared/bytes.js';
import { isGraphqlRequest, requestKey } from '../shared/matchkey.js';
import {
  advanceHandshakeCursor,
  buildMatchIndexes,
  lookupHandshakeRecording,
  lookupRecording,
} from '../shared/matchIndex.js';
import { sanitizeResponseHeaders } from '../shared/headers.js';
import * as cdp from './cdp.js';
import * as db from './db.js';
import * as wsReplay from './wsReplay.js';

const MAX_BODY_CACHE = 64;

/** @type {Map<number, object>} */
const replayers = new Map();

/** @param {number} tabId */
export function isReplaying(tabId) {
  return replayers.has(tabId);
}

/**
 * @param {{
 *   tabId: number,
 *   scenarioId: string,
 *   session: object,
 *   settings: {skipGraphql:boolean, replayCookies:boolean, smartFallback:boolean},
 *   hooks: object,
 * }} options
 */
export async function startReplay({ tabId, scenarioId, session, settings, hooks }) {
  if (replayers.has(tabId)) await stopReplay(tabId, { detach: false });

  const entries = await db.listEntries(scenarioId);
  if (entries.length === 0) {
    throw new Error('This scenario has no recorded requests yet. Record it once, then replay.');
  }

  await cdp.ensureAttached(tabId);

  const state = {
    tabId,
    scenarioId,
    session,
    settings,
    hooks,
    indexes: buildMatchIndexes(entries),
    live: false,
    bodyCache: new Map(),
    handshakeCursor: new Map(),
  };
  replayers.set(tabId, state);

  try {
    await enableInterception(tabId);
  } catch (error) {
    replayers.delete(tabId);
    try {
      await cdp.detach(tabId);
    } catch {
      /* ignore */
    }
    throw error;
  }

  // WebSocket replay is best effort: a failure must never block HTTP replay.
  try {
    await wsReplay.startReplay({ tabId, scenarioId, session, settings, hooks });
  } catch (error) {
    hooks.onWarning?.(session, `WebSocket replay is unavailable: ${/** @type {any} */ (error)?.message || error}`);
  }
}

/**
 * Toggle between replay and live passthrough without losing the scenario.
 * @param {number} tabId
 * @param {boolean} live
 */
export async function setLive(tabId, live) {
  const state = replayers.get(tabId);
  if (!state) throw new Error('No replay session is active for this tab.');
  if (live === state.live) return;

  if (live) {
    await cdp.sendCommand(tabId, 'Fetch.disable');
  } else {
    await enableInterception(tabId);
  }
  state.live = Boolean(live);

  try {
    await wsReplay.setLive(tabId, Boolean(live));
  } catch {
    /* sockets are best effort; HTTP mode is authoritative */
  }
}

/**
 * @param {number} tabId
 * @param {{detach?: boolean}} [options]
 */
export async function stopReplay(tabId, { detach = true } = {}) {
  const state = replayers.get(tabId);
  if (state) {
    replayers.delete(tabId);
    try {
      await wsReplay.stopReplay(tabId);
    } catch {
      /* ignore */
    }
    if (!state.live) {
      try {
        await cdp.sendCommand(tabId, 'Fetch.disable');
      } catch {
        /* ignore */
      }
    }
  } else {
    try {
      await wsReplay.stopReplay(tabId);
    } catch {
      /* ignore */
    }
  }
  if (detach) {
    try {
      await cdp.detach(tabId);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Reload match indexes and clear cached bodies for every active replay of a
 * scenario. Called after a recorded payload is edited or restored so the next
 * intercepted request serves the new bytes (even mid-session).
 * @param {string} scenarioId
 * @returns {Promise<boolean>} whether any active replay was refreshed
 */
export async function refreshScenario(scenarioId) {
  const entries = await db.listEntries(scenarioId);

  let refreshed = false;
  for (const state of replayers.values()) {
    if (state.scenarioId !== scenarioId) continue;
    state.indexes = buildMatchIndexes(entries);
    state.bodyCache.clear();
    state.handshakeCursor.clear();
    refreshed = true;
  }
  try {
    const wsRefreshed = await wsReplay.refreshScenario(scenarioId);
    refreshed = refreshed || wsRefreshed;
  } catch {
    /* ignore */
  }
  return refreshed;
}

/**
 * Start the Socket.IO polling / SignalR negotiate cursors over.
 *
 * A reload replays a fresh handshake sequence, so continuing from the previous
 * page's cursor would serve the last recorded polling response for every
 * request.
 *
 * @param {number} tabId
 */
export function resetHandshakeCursor(tabId) {
  const state = replayers.get(tabId);
  if (state) state.handshakeCursor.clear();
}

/**
 * @param {number} tabId
 * @param {string} method
 * @param {any} params
 */
export function handleEvent(tabId, method, params) {
  if (wsReplay.handleEvent(tabId, method, params)) return true;
  if (method !== 'Fetch.requestPaused') return false;

  const state = replayers.get(tabId);
  if (!state) {
    // Never leave a paused request hanging.
    void cdp.sendCommand(tabId, 'Fetch.continueRequest', { requestId: params?.requestId }).catch(() => {});
    return true;
  }

  void handlePaused(tabId, state, params).catch(async (error) => {
    try {
      await cdp.sendCommand(tabId, 'Fetch.continueRequest', { requestId: params?.requestId });
    } catch {
      /* request may be gone */
    }
    state.hooks.onMiss?.(state.session, params?.request ?? {}, {
      reason: 'fulfill-error',
      sameUrl: 0,
      samePath: 0,
    });
    state.hooks.onWarning?.(state.session, `Replay failed for one request: ${error.message}`);
  });

  return true;
}

/**
 * @param {number} tabId
 * @param {object} state
 * @param {any} params
 */
async function handlePaused(tabId, state, params) {
  const requestId = params?.requestId;
  const request = params?.request ?? {};
  const continueLive = () => cdp.sendCommand(tabId, 'Fetch.continueRequest', { requestId });

  if (state.live) return continueLive();

  // Only fetch/XHR are recorded or replayed; documents, scripts, images,
  // fonts and stylesheets pass straight through.
  if (params?.resourceType !== 'XHR' && params?.resourceType !== 'Fetch') return continueLive();

  const body = readPausedBody(request);
  const smartFallback = state.settings.smartFallback !== false;
  const method = request.method ?? 'GET';
  const url = String(request.url ?? '');

  if (body.unknown) {
    const lookup = lookupRecording(state.indexes, { method, url, matchKey: null }, { smartFallback });
    if (!lookup.entry) {
      state.hooks.onMiss?.(state.session, request, {
        reason: 'body-unavailable',
        sameUrl: lookup.sameUrl,
        samePath: lookup.samePath,
      });
      return continueLive();
    }
    return fulfillRequest(tabId, state, requestId, request, lookup.entry, lookup.matchedVia);
  }

  if (state.settings.skipGraphql && isGraphqlRequest({ url, bodyBytes: body.bytes })) {
    return continueLive();
  }

  const matchKey = await requestKey({ method, url, bodyBytes: body.bytes });

  // An exact method + URL + body match always wins, even for a handshake URL:
  // the bucket cursor is only a fallback for the volatile polling sequence.
  const exactEntry = state.indexes.exact.get(matchKey);
  if (exactEntry) return fulfillRequest(tabId, state, requestId, request, exactEntry, 'exact');

  // Socket.IO / SignalR transport handshakes are matched by canonical bucket and
  // replayed in recorded order, so an offline client can finish its polling
  // handshake and upgrade to WebSocket. Only when WebSocket replay is enabled.
  if (state.settings.recordWebSockets !== false) {
    const handshake = lookupHandshakeRecording(state.indexes, { method, url }, state.handshakeCursor);
    if (handshake) {
      advanceHandshakeCursor(state.handshakeCursor, handshake.key);
      return fulfillRequest(tabId, state, requestId, request, handshake.entry, 'handshake');
    }
  }

  const lookup = lookupRecording(state.indexes, { method, url, matchKey }, { smartFallback });

  if (!lookup.entry) {
    state.hooks.onMiss?.(state.session, request, {
      reason: lookup.reason,
      sameUrl: lookup.sameUrl,
      samePath: lookup.samePath,
    });
    return continueLive();
  }

  return fulfillRequest(tabId, state, requestId, request, lookup.entry, lookup.matchedVia);
}

/**
 * @param {number} tabId
 * @param {object} state
 * @param {string} requestId
 * @param {any} request
 * @param {object} entry
 * @param {'exact'|'url'|'path'} matchedVia
 */
async function fulfillRequest(tabId, state, requestId, request, entry, matchedVia) {
  const record = await loadBody(state, entry.id);
  if (!record) {
    state.hooks.onMiss?.(state.session, request, { reason: 'body-missing', sameUrl: 0, samePath: 0 });
    return cdp.sendCommand(tabId, 'Fetch.continueRequest', { requestId });
  }

  const status = Number(entry.status) || 200;
  /** @type {any} */
  const fulfillParams = {
    requestId,
    responseCode: status,
    responseHeaders: sanitizeResponseHeaders(entry.responseHeaders, {
      replayCookies: state.settings.replayCookies,
    }),
  };
  if (entry.statusText) fulfillParams.responsePhrase = entry.statusText;
  if (canHaveBody(status) && record.body) fulfillParams.body = record.body;

  await cdp.sendCommand(tabId, 'Fetch.fulfillRequest', fulfillParams);
  state.hooks.onHit?.(state.session, entry, { matchedVia });
}

/**
 * Extract the exact request body bytes from a paused CDP request.
 * @param {any} request
 * @returns {{unknown: boolean, bytes: Uint8Array}}
 */
function readPausedBody(request) {
  const entries = request?.postDataEntries;
  if (Array.isArray(entries) && entries.length > 0) {
    const parts = [];
    for (const entry of entries) {
      try {
        parts.push(base64ToBytes(entry?.bytes ?? ''));
      } catch {
        return { unknown: true, bytes: new Uint8Array(0) };
      }
    }
    return { unknown: false, bytes: concatBytes(parts) };
  }

  if (typeof request?.postData === 'string') {
    return { unknown: false, bytes: utf8ToBytes(request.postData) };
  }

  if (request?.hasPostData) return { unknown: true, bytes: new Uint8Array(0) };
  return { unknown: false, bytes: new Uint8Array(0) };
}

/**
 * @param {{bodyCache: Map<string, object>}} state
 * @param {string} id
 */
async function loadBody(state, id) {
  const cached = state.bodyCache.get(id);
  if (cached) return cached;

  const record = await db.getBody(id);
  if (!record) return null;
  if (state.bodyCache.size >= MAX_BODY_CACHE) state.bodyCache.clear();
  state.bodyCache.set(id, record);
  return record;
}

/** @param {number} status */
function canHaveBody(status) {
  return status !== 204 && status !== 205 && status !== 304;
}

/** @param {number} tabId */
async function enableInterception(tabId) {
  await cdp.sendCommand(tabId, 'Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
  });
}
