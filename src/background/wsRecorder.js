/**
 * Passive WebSocket recording engine (CDP `Network.webSocket*` events).
 *
 * Nothing is intercepted: Chrome reports creation, the handshake, every frame
 * and the close, and this module stores them as one WebSocket "entry" plus its
 * `ws_frames` rows.
 *
 * Frames are kept per connection (respecting the configured limits) and
 * mirrored to IndexedDB in batches onto a staging entry id, so a
 * service-worker restart cannot lose a long-lived connection. When the socket
 * closes — or recording stops — the connection is finalized: only a non-empty
 * connection is promoted to the canonical entry id, so a failed reconnect never
 * overwrites a good recording.
 */
import { DEFAULT_SETTINGS, LIMITS } from '../shared/constants.js';
import { decodeCdpFramePayload } from '../shared/wsFrames.js';
import { wsConnectionKey } from '../shared/matchkey.js';
import { isGraphqlWs, shortUrl } from '../shared/url.js';
import { detectAdapter } from '../shared/wsAdapters/index.js';
import * as db from './db.js';

const FLUSH_INTERVAL_MS = 250;

/** @typedef {{tabId:number, scenarioId:string, session:object, settings:object, hooks:object, connections:Map<string, object>}} TabState */

/** @type {Map<number, TabState>} */
const tabs = new Map();

/**
 * Begin recording WebSockets for a tab.
 * @param {{tabId: number, scenarioId: string, session: object, settings: object, hooks: object}} options
 * @returns {TabState}
 */
export function start({ tabId, scenarioId, session, settings, hooks }) {
  stop(tabId, { flush: false });
  /** @type {TabState} */
  const state = { tabId, scenarioId, session, settings, hooks, connections: new Map() };
  tabs.set(tabId, state);
  return state;
}

/** @param {number} tabId */
export function isActive(tabId) {
  return tabs.has(tabId);
}

/**
 * Stop recording and finalize every connection that is still open.
 * @param {number} tabId
 * @param {{flush?: boolean, reason?: string}} [options]
 */
export async function stop(tabId, { flush = true, reason = 'stopped' } = {}) {
  const state = tabs.get(tabId);
  if (!state) return;
  tabs.delete(tabId);

  for (const connection of [...state.connections.values()]) {
    clearTimeout(connection.flushTimer);
    connection.flushTimer = null;
    if (flush) {
      await finalize(state, connection, { reason });
    } else {
      await dropStaging(connection);
    }
  }
}

/**
 * Drop buffers and staging rows without saving (the tab is gone).
 * @param {number} tabId
 */
export async function discard(tabId) {
  const state = tabs.get(tabId);
  if (!state) return;
  tabs.delete(tabId);
  for (const connection of state.connections.values()) {
    clearTimeout(connection.flushTimer);
    await dropStaging(connection);
  }
}

/** @param {object} connection */
async function dropStaging(connection) {
  if (!connection.stagingEntryId) return;
  try {
    await db.deleteWsFrames(connection.stagingEntryId);
  } catch {
    /* best effort */
  }
}

/**
 * Route one CDP event. Returns true when the event was a WebSocket event (even
 * if this tab is not recording WebSockets, so callers can stop dispatching).
 *
 * @param {number} tabId
 * @param {string} method
 * @param {any} params
 */
export function handleEvent(tabId, method, params) {
  if (!method?.startsWith('Network.webSocket')) return false;
  const state = tabs.get(tabId);
  if (!state) return true;

  switch (method) {
    case 'Network.webSocketCreated':
      onCreate(state, params);
      return true;
    case 'Network.webSocketWillSendHandshakeRequest':
      onHandshakeRequest(state, params);
      return true;
    case 'Network.webSocketHandshakeResponseReceived':
      onHandshakeResponse(state, params);
      return true;
    case 'Network.webSocketFrameSent':
      onFrame(state, params, 'send');
      return true;
    case 'Network.webSocketFrameReceived':
      onFrame(state, params, 'recv');
      return true;
    case 'Network.webSocketFrameError':
      onFrameError(state, params);
      return true;
    case 'Network.webSocketClosed':
      onClosed(state, params);
      return true;
    default:
      return true;
  }
}

/** @param {TabState} state @param {any} params */
function onCreate(state, params) {
  const requestId = String(params?.requestId ?? '');
  if (!requestId) return;

  const url = String(params?.url ?? '');
  const protocols = Array.isArray(params?.protocols) ? params.protocols.map(String) : [];
  const settings = state.settings ?? {};

  if (settings.recordWebSockets === false) return;
  if (settings.skipGraphql !== false && isGraphqlWs({ url, protocols })) {
    state.hooks?.onWarning?.(
      state.session,
      'A GraphQL WebSocket connection was passed through without recording (GraphQL is excluded in Settings).',
    );
    return;
  }

  state.connections.set(requestId, {
    requestId,
    url,
    protocols,
    status: 101,
    statusText: '',
    openedAt: Date.now(),
    firstSentFrame: null,
    firstRecvFrame: null,
    frames: [],
    stagedCount: 0,
    pendingFlushes: new Set(),
    bytes: 0,
    truncated: false,
    protocol: '',
    stagingEntryId: `${state.scenarioId}:ws-staging:${requestId}`,
    flushTimer: null,
  });
}

/** @param {TabState} state @param {any} params */
function onHandshakeRequest(state, params) {
  const connection = state.connections.get(String(params?.requestId ?? ''));
  if (!connection) return;
  const wallTime = Number(params?.wallTime);
  if (Number.isFinite(wallTime) && wallTime > 0) connection.openedAt = Math.round(wallTime * 1000);

  // `Network.webSocketCreated` does not report sub-protocols, but the handshake
  // request does. They decide GraphQL exclusion and adapter detection.
  const headers = params?.request?.headers ?? {};
  for (const [name, value] of Object.entries(headers)) {
    if (String(name).toLowerCase() !== 'sec-websocket-protocol') continue;
    connection.requestProtocols = String(value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

/** @param {TabState} state @param {any} params */
function onHandshakeResponse(state, params) {
  const connection = state.connections.get(String(params?.requestId ?? ''));
  if (!connection) return;
  const response = params?.response ?? {};
  connection.status = Number(response.status) || 101;
  connection.statusText = String(response.statusText ?? '');
  const headers = response.headers ?? {};
  const negotiated = headers['Sec-WebSocket-Protocol'] ?? headers['sec-websocket-protocol'] ?? '';
  connection.protocol = String(negotiated).split(',')[0].trim();
}

/**
 * @param {TabState} state
 * @param {any} params
 * @param {'send'|'recv'} direction
 */
function onFrame(state, params, direction) {
  const connection = state.connections.get(String(params?.requestId ?? ''));
  if (!connection) return;

  const settings = state.settings ?? {};
  const response = params?.response ?? {};
  const frame = decodeCdpFramePayload(response.opcode, response.payloadData);
  const opcode = frame.opcode;

  const maxFrameBytes =
    Number(settings.wsMaxFrameBytes) || DEFAULT_SETTINGS.wsMaxFrameBytes || LIMITS.MAX_WS_FRAME_BYTES;
  const maxFrames = Number(settings.wsMaxFramesPerConnection) || DEFAULT_SETTINGS.wsMaxFramesPerConnection;

  if (connection.frames.length >= maxFrames) {
    warnOnce(state, connection, `WebSocket ${shortUrl(connection.url)} stopped recording after ${maxFrames} frames.`);
    return;
  }
  if (frame.size > maxFrameBytes) {
    connection.truncated = true;
    warnOnce(
      state,
      connection,
      `A ${frame.size}-byte WebSocket frame was skipped (limit ${maxFrameBytes} bytes).`,
    );
    return;
  }
  if (connection.bytes + frame.size > LIMITS.MAX_WS_CONNECTION_BYTES) {
    connection.truncated = true;
    warnOnce(
      state,
      connection,
      `WebSocket ${shortUrl(connection.url)} hit the connection size limit; the recording was truncated.`,
    );
    return;
  }

  if (opcode === 1 && frame.text != null) {
    if (direction === 'send' && connection.firstSentFrame == null) connection.firstSentFrame = frame.text;
    if (direction === 'recv' && connection.firstRecvFrame == null) connection.firstRecvFrame = frame.text;
  }

  // CDP frame timestamps are monotonic seconds, while the handshake wallTime is
  // epoch seconds: subtracting them collapses every offset to 0. Anchor on the
  // first frame instead, which is all replay needs (relative spacing).
  const timestamp = Number(params?.timestamp);
  let offsetMs;
  if (Number.isFinite(timestamp) && timestamp > 0) {
    if (connection.firstFrameTimestamp == null) connection.firstFrameTimestamp = timestamp;
    offsetMs = Math.max(0, Math.round((timestamp - connection.firstFrameTimestamp) * 1000));
  } else {
    if (connection.firstFrameWallMs == null) connection.firstFrameWallMs = Date.now();
    offsetMs = Math.max(0, Date.now() - connection.firstFrameWallMs);
  }

  connection.frames.push({
    seq: connection.frames.length,
    direction,
    opcode,
    offsetMs,
    size: frame.size,
    payload: frame.payload,
    edited: false,
  });
  connection.bytes += frame.size;

  // Mirror frames to IndexedDB in batches (crash insurance).
  const pending = connection.frames.length - connection.stagedCount;
  if (pending >= 20) {
    flush(state, connection);
    return;
  }
  if (!connection.flushTimer) {
    connection.flushTimer = setTimeout(() => {
      connection.flushTimer = null;
      flush(state, connection);
    }, FLUSH_INTERVAL_MS);
    if (typeof connection.flushTimer?.unref === 'function') connection.flushTimer.unref();
  }
}

/** @param {TabState} state @param {object} connection */
function flush(state, connection) {
  if (connection.finalized) return;
  if (connection.frames.length <= connection.stagedCount) return;
  const frames = connection.frames.slice(connection.stagedCount);
  connection.stagedCount = connection.frames.length;
  const task = db
    .appendWsFrames(connection.stagingEntryId, state.scenarioId, frames)
    .catch(() => {
      /* staging is best-effort */
    });
  connection.pendingFlushes.add(task);
  void task.finally(() => connection.pendingFlushes.delete(task));
}

/** @param {TabState} state @param {object} connection @param {string} message */
function warnOnce(state, connection, message) {
  connection.truncated = true;
  if (connection.limitWarned) return;
  connection.limitWarned = true;
  state.hooks?.onWarning?.(state.session, message);
}

/** @param {TabState} state @param {any} params */
function onFrameError(state, params) {
  const connection = state.connections.get(String(params?.requestId ?? ''));
  if (!connection) return;
  state.hooks?.onWarning?.(
    state.session,
    `WebSocket ${shortUrl(connection.url)}: ${String(params?.errorMessage ?? 'frame error')}`,
  );
}

/** @param {TabState} state @param {any} params */
function onClosed(state, params) {
  const requestId = String(params?.requestId ?? '');
  const connection = state.connections.get(requestId);
  if (!connection) return;
  state.connections.delete(requestId);
  clearTimeout(connection.flushTimer);
  connection.flushTimer = null;
  void finalize(state, connection, { reason: 'closed' }).catch((error) => {
    state.hooks?.onWarning?.(state.session, `Could not save a WebSocket recording: ${error.message}`);
  });
}

/**
 * Persist a finished connection.
 * @param {TabState} state
 * @param {object} connection
 * @param {{reason?: 'closed'|'stopped'}} [options]
 * @returns {Promise<boolean>} whether a recording was saved
 */
async function finalize(state, connection, { reason = 'stopped' } = {}) {
  connection.finalized = true;
  if (connection.pendingFlushes?.size > 0) {
    await Promise.allSettled([...connection.pendingFlushes]);
  }

  const frames = connection.frames;
  if (frames.length === 0) {
    await dropStaging(connection);
    return false;
  }

  const protocols =
    connection.requestProtocols?.length > 0 ? connection.requestProtocols : connection.protocols;

  if (state.settings?.skipGraphql !== false && isGraphqlWs({ url: connection.url, protocols })) {
    await dropStaging(connection);
    return false;
  }

  const adapter = detectAdapter({
    url: connection.url,
    protocols,
    firstSentFrame: connection.firstSentFrame,
    firstRecvFrame: connection.firstRecvFrame,
  });

  const matchKey = await wsConnectionKey(connection.url);
  const entryId = db.entryId(state.scenarioId, matchKey);
  const size = frames.reduce((sum, frame) => sum + (Number(frame.size) || 0), 0);

  /** @type {object} */
  const entry = {
    id: entryId,
    scenarioId: state.scenarioId,
    kind: 'ws',
    matchKey,
    method: 'WS',
    url: connection.url,
    status: connection.status || 101,
    statusText: connection.statusText || '',
    mimeType: 'websocket',
    resourceType: 'WebSocket',
    wsAdapter: adapter.name,
    negotiatedProtocol: connection.protocol || protocols[0] || '',
    frameCount: frames.length,
    sentCount: frames.filter((frame) => frame.direction === 'send').length,
    recvCount: frames.filter((frame) => frame.direction === 'recv').length,
    durationMs: Math.max(0, Date.now() - connection.openedAt),
    truncated: Boolean(connection.truncated),
    size,
    capturedAt: Date.now(),
    edited: false,
    editedAt: null,
    requestPreview: `WS ${shortUrl(connection.url)}`,
    responsePreview: `${frames.length} frame${frames.length === 1 ? '' : 's'} · ${
      adapter.name === 'generic' ? 'WS' : adapter.name
    }`,
    bodyKind: 'text',
  };

  const saved = await db.saveWsRecording(entry, frames, connection.stagingEntryId);
  if (saved) {
    state.hooks?.onCapturedWs?.(state.session, entry);
    // Clean up any staging rows an in-flight flush wrote after the promotion.
    await dropStaging(connection);
  }
  return saved;
}
