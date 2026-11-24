/**
 * Recording engine.
 *
 * Uses the passive CDP `Network` domain: nothing is blocked or delayed, every
 * XHR/fetch response body is read as soon as it finishes and stored together
 * with the exact request body that produced it.
 */
import { LIMITS } from '../shared/constants.js';
import { base64ToBytes, bytesPreview, bytesToBase64, looksLikeText, utf8ToBytes } from '../shared/bytes.js';
import { isGraphqlRequest, requestKey, requestSignature } from '../shared/matchkey.js';
import { headersToArray } from '../shared/headers.js';
import * as cdp from './cdp.js';
import * as db from './db.js';
import * as wsRecorder from './wsRecorder.js';

/**
 * Large buffers keep response bodies available until we pull them at
 * `loadingFinished`; the values are only a ceiling, Chrome allocates as needed.
 */
const NETWORK_ENABLE_PARAMS = {
  maxTotalBufferSize: 64 * 1024 * 1024,
  maxResourceBufferSize: 16 * 1024 * 1024,
  maxPostDataSize: 2 * 1024 * 1024,
};

const MAX_PENDING_AGE_MS = 10 * 60 * 1000;

/** @type {Map<number, object>} tabId -> recording state */
const recordings = new Map();

/** @param {number} tabId */
export function isRecording(tabId) {
  return recordings.has(tabId);
}

/**
 * @param {{
 *   tabId: number,
 *   scenarioId: string,
 *   session: object,
 *   settings: {maxBodyBytes:number, skipGraphql:boolean},
 *   hooks: object,
 * }} options
 */
export async function startRecording({ tabId, scenarioId, session, settings, hooks }) {
  if (recordings.has(tabId)) await stopRecording(tabId, { detach: false });

  await cdp.ensureAttached(tabId);
  try {
    await cdp.sendCommand(tabId, 'Network.enable', NETWORK_ENABLE_PARAMS);
  } catch (error) {
    try {
      await cdp.detach(tabId);
    } catch {
      /* ignore */
    }
    throw error;
  }

  recordings.set(tabId, {
    tabId,
    scenarioId,
    session,
    settings,
    hooks,
    pending: new Map(),
  });

  // WebSocket frames are reported by the same `Network` domain.
  wsRecorder.start({ tabId, scenarioId, session, settings, hooks });
}

/**
 * Route a CDP event to the recording engine. Returns true when the event was
 * consumed.
 * @param {number} tabId
 * @param {string} method
 * @param {any} params
 */
export function handleEvent(tabId, method, params) {
  const state = recordings.get(tabId);
  if (!state) return false;

  if (wsRecorder.handleEvent(tabId, method, params)) return true;

  switch (method) {
    case 'Network.requestWillBeSent':
      onRequestWillBeSent(state, params);
      return true;
    case 'Network.responseReceived':
      onResponseReceived(state, params);
      return true;
    case 'Network.loadingFinished':
      void onLoadingFinished(state, params).catch((error) => {
        state.hooks.onWarning?.(state.session, `Could not save a response: ${error.message}`);
      });
      return true;
    case 'Network.loadingFailed':
      state.pending.delete(params?.requestId);
      return true;
    default:
      return false;
  }
}

/**
 * @param {number} tabId
 * @param {{detach?: boolean}} [options]
 */
export async function stopRecording(tabId, { detach = true } = {}) {
  const state = recordings.get(tabId);
  if (state) {
    recordings.delete(tabId);
    try {
      // Finalize open WebSocket connections before the Network domain goes away.
      await wsRecorder.stop(tabId);
    } catch {
      /* ignore */
    }
    try {
      await cdp.sendCommand(tabId, 'Network.disable');
    } catch {
      /* tab may already be gone */
    }
  } else {
    await wsRecorder.discard(tabId).catch(() => {});
  }
  if (detach) {
    try {
      await cdp.detach(tabId);
    } catch {
      /* ignore */
    }
  }
}

/** @param {object} state @param {any} params */
function onRequestWillBeSent(state, params) {
  const type = params?.type;
  if (type !== 'XHR' && type !== 'Fetch') return;

  const request = params.request ?? {};
  const pending = {
    requestId: params.requestId,
    url: String(request.url ?? ''),
    method: String(request.method ?? 'GET').toUpperCase(),
    hasPostData: Boolean(request.hasPostData),
    postData: typeof request.postData === 'string' ? request.postData : null,
    type,
    status: 0,
    statusText: '',
    mimeType: '',
    responseHeaders: null,
    skip: false,
    startedAt: Date.now(),
  };

  state.pending.set(params.requestId, pending);
  if (state.pending.size > 200) purgePending(state);
}

/** @param {object} state @param {any} params */
function onResponseReceived(state, params) {
  const type = params?.type;
  if (type !== 'XHR' && type !== 'Fetch') return;

  const pending = state.pending.get(params.requestId);
  if (!pending) return;

  const response = params.response ?? {};
  pending.status = Number(response.status) || 0;
  pending.statusText = String(response.statusText ?? '');
  pending.mimeType = String(response.mimeType ?? '');
  pending.responseHeaders = response.headers ?? null;
  // Event streams never "finish" reliably; do not hold them in memory.
  if (/text\/event-stream/i.test(pending.mimeType)) pending.skip = true;
}

/** @param {object} state @param {any} params */
async function onLoadingFinished(state, params) {
  const pending = state.pending.get(params.requestId);
  if (!pending) return;
  state.pending.delete(params.requestId);

  if (pending.skip || !pending.status) return;

  const { settings, hooks, session, scenarioId, tabId } = state;

  const [responseBody, requestBody] = await Promise.all([
    readResponseBody(tabId, params.requestId),
    readRequestBody(tabId, pending),
  ]);

  if (!responseBody) {
    hooks.onSkipped?.(session, `Skipped ${pending.method} ${shortUrl(pending.url)}: Chrome did not expose the response body.`);
    return;
  }

  const responseBytes = responseBody.base64Encoded
    ? base64ToBytes(responseBody.body)
    : utf8ToBytes(responseBody.body);

  if (responseBytes.length > settings.maxBodyBytes) {
    hooks.onSkipped?.(
      session,
      `Skipped a ${formatBytes(responseBytes.length)} response (limit ${formatBytes(settings.maxBodyBytes)}).`,
    );
    return;
  }

  if (requestBody.unknown) {
    hooks.onSkipped?.(session, `Skipped ${pending.method} ${shortUrl(pending.url)}: the request body was not exposed by Chrome.`);
    return;
  }

  if (requestBody.bytes.length > LIMITS.MAX_REQUEST_BODY_BYTES) {
    hooks.onSkipped?.(session, `Skipped ${pending.method} ${shortUrl(pending.url)}: the request body is too large to match reliably.`);
    return;
  }

  if (settings.skipGraphql && isGraphqlRequest({ url: pending.url, bodyBytes: requestBody.bytes })) {
    hooks.onWarning?.(session, 'A GraphQL request was passed through without recording (GraphQL is excluded in Settings).');
    return;
  }

  const matchKey = await requestKey({ method: pending.method, url: pending.url, bodyBytes: requestBody.bytes });
  const id = db.entryId(scenarioId, matchKey);
  const textResponse = looksLikeText(responseBytes);

  /** @type {object} */
  const entry = {
    id,
    scenarioId,
    matchKey,
    method: pending.method,
    url: pending.url,
    status: pending.status,
    statusText: pending.statusText,
    mimeType: pending.mimeType,
    resourceType: pending.type,
    capturedAt: Date.now(),
    size: responseBytes.length,
    requestPreview: requestSignature(
      { method: pending.method, url: pending.url, bodyBytes: requestBody.bytes },
      LIMITS.MAX_PREVIEW_CHARS,
    ),
    responsePreview: textResponse
      ? bytesPreview(responseBytes, LIMITS.MAX_PREVIEW_CHARS)
      : `<binary ${formatBytes(responseBytes.length)}>`,
    bodyKind: textResponse ? 'text' : 'binary',
    responseHeaders: headersToArray(pending.responseHeaders),
  };

  await db.saveEntry(entry, bytesToBase64(responseBytes));
  hooks.onCaptured?.(session, entry);
}

/**
 * @param {number} tabId
 * @param {string} requestId
 */
async function readResponseBody(tabId, requestId) {
  try {
    const result = await cdp.sendCommand(tabId, 'Network.getResponseBody', { requestId });
    if (!result || typeof result.body !== 'string') return null;
    return { body: result.body, base64Encoded: Boolean(result.base64Encoded) };
  } catch {
    return null;
  }
}

/**
 * @param {number} tabId
 * @param {object} pending
 * @returns {Promise<{unknown: boolean, bytes: Uint8Array}>}
 */
async function readRequestBody(tabId, pending) {
  if (!pending.hasPostData) return { unknown: false, bytes: new Uint8Array(0) };
  if (typeof pending.postData === 'string') {
    return { unknown: false, bytes: utf8ToBytes(pending.postData) };
  }
  try {
    const result = await cdp.sendCommand(tabId, 'Network.getRequestPostData', { requestId: pending.requestId });
    if (result && typeof result.postData === 'string') {
      return { unknown: false, bytes: utf8ToBytes(result.postData) };
    }
  } catch {
    /* fall through */
  }
  return { unknown: true, bytes: new Uint8Array(0) };
}

/** @param {object} state */
function purgePending(state) {
  const now = Date.now();
  for (const [requestId, pending] of state.pending) {
    if (now - pending.startedAt > MAX_PENDING_AGE_MS) state.pending.delete(requestId);
  }
}

/** @param {number} bytes */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** @param {string} url */
function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
