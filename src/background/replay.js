/**
 * Replay engine.
 *
 * Pauses every request in the tab through the CDP `Fetch` domain. Requests are
 * only held for as long as it takes to look up the recorded entry; matching
 * requests are answered with `Fetch.fulfillRequest` (the transparent part),
 * everything else is forwarded with `Fetch.continueRequest`.
 *
 * The match key is `method + normalized URL + exact request body`, so the same
 * endpoint with a different POST body maps to a different recording.
 */
import { base64ToBytes, concatBytes, utf8ToBytes } from '../shared/bytes.js';
import { isGraphqlRequest, requestKey } from '../shared/matchkey.js';
import { sanitizeResponseHeaders } from '../shared/headers.js';
import * as cdp from './cdp.js';
import * as db from './db.js';

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
 *   settings: {skipGraphql:boolean, replayCookies:boolean},
 *   hooks: object,
 * }} options
 */
export async function startReplay({ tabId, scenarioId, session, settings, hooks }) {
  if (replayers.has(tabId)) await stopReplay(tabId, { detach: false });

  const entries = await db.listEntries(scenarioId);
  if (entries.length === 0) {
    throw new Error('This scenario has no recorded requests yet. Record it once, then replay.');
  }

  const index = new Map();
  for (const entry of entries) {
    if (entry && typeof entry.matchKey === 'string') index.set(entry.matchKey, entry);
  }

  await cdp.ensureAttached(tabId);
  const state = {
    tabId,
    scenarioId,
    session,
    settings,
    hooks,
    index,
    live: false,
    bodyCache: new Map(),
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
}

/**
 * Reload the match index and clear cached bodies for every active replay of a
 * scenario. Called after a recorded payload is edited or restored so the next
 * intercepted request serves the new bytes (even mid-session).
 * @param {string} scenarioId
 * @returns {Promise<boolean>} whether any active replay was refreshed
 */
export async function refreshScenario(scenarioId) {
  const entries = await db.listEntries(scenarioId);
  const index = new Map();
  for (const entry of entries) {
    if (entry && typeof entry.matchKey === 'string') index.set(entry.matchKey, entry);
  }

  let refreshed = false;
  for (const state of replayers.values()) {
    if (state.scenarioId !== scenarioId) continue;
    state.index = index;
    state.bodyCache.clear();
    refreshed = true;
  }
  return refreshed;
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
}

/**
 * @param {number} tabId
 * @param {{detach?: boolean}} [options]
 */
export async function stopReplay(tabId, { detach = true } = {}) {
  const state = replayers.get(tabId);
  if (state) {
    replayers.delete(tabId);
    if (!state.live) {
      try {
        await cdp.sendCommand(tabId, 'Fetch.disable');
      } catch {
        /* ignore */
      }
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
 * @param {number} tabId
 * @param {string} method
 * @param {any} params
 */
export function handleEvent(tabId, method, params) {
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
  if (body.unknown) {
    state.hooks.onMiss?.(state.session, request);
    return continueLive();
  }

  if (state.settings.skipGraphql && isGraphqlRequest({ url: request.url, bodyBytes: body.bytes })) {
    return continueLive();
  }

  const matchKey = await requestKey({
    method: request.method ?? 'GET',
    url: String(request.url ?? ''),
    bodyBytes: body.bytes,
  });

  const entry = state.index.get(matchKey);
  if (!entry) {
    state.hooks.onMiss?.(state.session, request);
    return continueLive();
  }

  const record = await loadBody(state, entry.id);
  if (!record) {
    state.hooks.onMiss?.(state.session, request);
    return continueLive();
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
  state.hooks.onHit?.(state.session, entry);
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
