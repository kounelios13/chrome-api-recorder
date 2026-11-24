/**
 * Recording lookup strategies for replay.
 *
 * Matching is tried in this order:
 *   1. exact     — method + normalized URL + exact request body (the recorded key)
 *   2. url       — method + normalized URL, when exactly one recording exists for it
 *   3. path      — method + origin + path (query string ignored), when exactly one
 *                  recording exists for it
 *
 * The fallback tiers only activate when `smartFallback` is enabled AND the choice
 * is unambiguous (exactly one candidate). If several recordings could match, the
 * request is passed through live and a diagnostic reason is returned instead of
 * guessing.
 *
 * Pure module so the tiered lookup can be unit tested without Chrome.
 */
import { normalizeUrl, wsEndpointKey } from './url.js';

/** @param {string} value */
export function methodOf(value) {
  return String(value ?? 'GET').toUpperCase();
}

/**
 * Key for the same URL + method, independent of the request body.
 * @param {string} method
 * @param {string} url
 */
export function urlMatchKey(method, url) {
  return `${methodOf(method)} ${normalizeUrl(url)}`;
}

/**
 * Key for the same origin + path + method, ignoring the query string.
 * @param {string} method
 * @param {string} url
 */
export function pathMatchKey(method, url) {
  try {
    const parsed = new URL(url);
    return `${methodOf(method)} ${parsed.origin}${parsed.pathname}`;
  } catch {
    return urlMatchKey(method, url);
  }
}

/** @param {Map<string, object[]>} map @param {string} key @param {object} entry */
function pushTo(map, key, entry) {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

/**
 * Canonical bucket for one step of a WebSocket transport handshake, or `null`
 * when the request is ordinary HTTP.
 *
 * Socket.IO clients perform an HTTP polling handshake before upgrading to
 * WebSocket, and every polling request carries a random `t` cache-buster plus a
 * `sid` once the session exists. Matching them by raw URL fails (several
 * entries, all slightly different) so they are bucketed by:
 *
 *   - `socketio-open`  the first `GET ...?EIO=4&transport=polling` (no `sid`),
 *   - `socketio-poll`  later `GET`s carrying a `sid`,
 *   - `socketio-post`  `POST`s carrying a `sid` (client -> server packets),
 *   - `signalr-negotiate` `POST`/`GET` to `.../negotiate`.
 *
 * The follow-up polling requests are replayed in recorded order through a
 * per-session cursor (see `advanceHandshakeCursor`), which is what makes an
 * offline Socket.IO handshake work end to end.
 *
 * @param {string} method
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function handshakeKey(method, rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const verb = methodOf(method);

  if (/\/socket\.io\/?$/i.test(parsed.pathname)) {
    if (parsed.searchParams.get('transport') !== 'polling') return null;
    const sid = parsed.searchParams.get('sid');
    const eio = parsed.searchParams.get('EIO') ?? '4';
    const phase = sid ? (verb === 'POST' ? 'post' : 'poll') : 'open';
    return `${verb} ${parsed.origin}${parsed.pathname}?EIO=${eio}&transport=polling#${phase}`;
  }

  if (/\/negotiate\/?$/i.test(parsed.pathname)) {
    return `${verb} ${parsed.origin}${parsed.pathname}`;
  }

  return null;
}

/**
 * Lookup keys for a recorded WebSocket connection.
 * @param {string} url
 */
export function wsUrlKey(url) {
  return `WS ${normalizeUrl(url)}`;
}

/**
 * The WS endpoint a SignalR `/negotiate` request belongs to, if any.
 *
 * `POST https://host/hub/negotiate` negotiates for `wss://host/hub`. Used to
 * avoid treating unrelated `/negotiate` endpoints as WebSocket handshakes.
 *
 * @param {string} rawUrl
 * @returns {string|null} a `wsPathKey`-style endpoint, or null
 */
export function wsEndpointForNegotiate(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/\/negotiate\/?$/i.test(parsed.pathname)) return null;
  const path = parsed.pathname.replace(/\/negotiate\/?$/i, '') || '/';
  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `WS ${wsProtocol}//${parsed.host}${path}`;
}

/** @param {string} url */
export function wsPathKey(url) {
  return `WS ${wsEndpointKey(url)}`;
}

/**
 * Index a scenario's recorded WebSocket connections by URL and by endpoint
 * (origin + path), plus the HTTP handshake buckets used for offline replay.
 *
 * @param {object[]} entries entry metadata (http and ws)
 */
export function buildWsIndexes(entries) {
  const exact = new Map();
  const byPath = new Map();
  const byHandshake = new Map();

  for (const entry of entries) {
    if (!entry) continue;
    if (entry.kind === 'ws' || String(entry.method).toUpperCase() === 'WS') {
      if (typeof entry.matchKey === 'string') exact.set(entry.matchKey, entry);
      pushTo(byPath, wsPathKey(entry.url), entry);
      continue;
    }
    const key = handshakeKey(entry.method, entry.url);
    if (key) pushTo(byHandshake, key, entry);
  }

  for (const bucket of byHandshake.values()) {
    bucket.sort((left, right) => (Number(left.capturedAt) || 0) - (Number(right.capturedAt) || 0));
  }

  return { exact, byPath, byHandshake };
}

/**
 * Find the recorded WebSocket connection for a live URL.
 *
 * Exact key first; otherwise the single recording for the same origin + path.
 * Different sockets on the same endpoint are indistinguishable to a page, so
 * several candidates mean "ambiguous" and the connection stays live.
 *
 * @param {{exact: Map<string,object>, byPath: Map<string,object[]>}} indexes
 * @param {{matchKey?: string|null, url: string}} connection
 * @returns {{entry: object|null, matchedVia: 'exact'|'path'|null, reason: string|null, samePath: number}}
 */
export function lookupWsRecording(indexes, connection) {
  const url = String(connection?.url ?? '');
  const exactEntry = connection?.matchKey ? indexes.exact.get(connection.matchKey) : undefined;
  if (exactEntry) return { entry: exactEntry, matchedVia: 'exact', reason: null, samePath: 1 };

  const candidates = indexes.byPath.get(wsPathKey(url)) ?? [];
  if (candidates.length === 1) {
    return { entry: candidates[0], matchedVia: 'path', reason: null, samePath: 1 };
  }
  if (candidates.length > 1) {
    return { entry: null, matchedVia: null, reason: 'ws-ambiguous-url', samePath: candidates.length };
  }
  return { entry: null, matchedVia: null, reason: 'ws-no-recording', samePath: 0 };
}

/**
 * Pick the recording for one handshake request and say where in its bucket the
 * session is. The caller owns the cursor so concurrent replays do not share it.
 *
 * @param {{byHandshake: Map<string, object[]>}} indexes
 * @param {{method?: string, url: string}} request
 * @param {Map<string, number>} cursor
 * @returns {{entry: object, key: string, position: number, total: number}|null}
 */
export function lookupHandshakeRecording(indexes, request, cursor) {
  const key = handshakeKey(request?.method, request?.url);
  if (!key) return null;

  // A `/negotiate` call is only a WebSocket handshake when this scenario also
  // recorded the SignalR hub socket it negotiates for; otherwise it is ordinary
  // HTTP and must go through normal matching. A non-SignalR `/negotiate`
  // endpoint that happens to share a path with a socket must not be hijacked.
  if (/\/negotiate\/?$/i.test(key)) {
    const endpoint = wsEndpointForNegotiate(request?.url);
    const candidates = endpoint ? indexes.byPath?.get(endpoint) ?? [] : [];
    if (!candidates.some((entry) => entry?.wsAdapter === 'signalr')) return null;
  }

  const bucket = indexes.byHandshake.get(key) ?? [];
  if (bucket.length === 0) return null;

  const position = Math.min(Number(cursor.get(key)) || 0, bucket.length - 1);
  return { entry: bucket[position], key, position, total: bucket.length };
}

/**
 * Move a handshake bucket's cursor forward so the next polling request of the
 * same session gets the next recorded response.
 * @param {Map<string, number>} cursor
 * @param {string} key
 */
export function advanceHandshakeCursor(cursor, key) {
  if (!key) return;

  // A new Socket.IO session starts with the `open` request; the polling and
  // POST cursors of the previous session must not leak into it (otherwise a
  // reconnecting client is served the last recorded responses).
  if (key.endsWith('#open')) {
    const base = key.slice(0, key.lastIndexOf('#'));
    cursor.delete(`${base}#poll`);
    const [verb, ...rest] = base.split(' ');
    if (verb === 'GET' || verb === 'POST') {
      const otherVerb = verb === 'GET' ? 'POST' : 'GET';
      cursor.delete(`${otherVerb} ${rest.join(' ')}#post`);
    }
  }

  cursor.set(key, (Number(cursor.get(key)) || 0) + 1);
}


/**
 * Build the lookup indexes for a scenario's recorded entries.
 * @param {object[]} entries entry metadata with at least method, url, matchKey
 */
export function buildMatchIndexes(entries) {
  const exact = new Map();
  const byUrl = new Map();
  const byPath = new Map();

  for (const entry of entries) {
    if (!entry || typeof entry.matchKey !== 'string') continue;
    exact.set(entry.matchKey, entry);
    if (entry.kind === 'ws' || String(entry.method).toUpperCase() === 'WS') continue;
    pushTo(byUrl, urlMatchKey(entry.method, entry.url), entry);
    pushTo(byPath, pathMatchKey(entry.method, entry.url), entry);
  }

  // WebSocket recordings and WS transport handshakes share the same index so
  // one pass over a scenario serves both HTTP and WS replay.
  const ws = buildWsIndexes(entries);
  for (const [key, entry] of ws.exact) exact.set(key, entry);
  for (const [key, bucket] of ws.byPath) {
    const list = byPath.get(key);
    if (list) list.push(...bucket);
    else byPath.set(key, bucket.slice());
  }

  return { exact, byUrl, byPath, byHandshake: ws.byHandshake };
}

/**
 * @typedef {{
 *   entry: object|null,
 *   matchedVia: 'exact'|'url'|'path'|null,
 *   reason: string|null,
 *   sameUrl: number,
 *   samePath: number,
 * }} LookupResult
 */

/**
 * Find the best recording for an outgoing request.
 *
 * @param {{exact: Map<string,object>, byUrl: Map<string,object[]>, byPath: Map<string,object[]>}} indexes
 * @param {{method?: string, url: string, matchKey?: string|null}} request
 * @param {{smartFallback?: boolean}} [options]
 * @returns {LookupResult}
 */
export function lookupRecording(indexes, request, { smartFallback = true } = {}) {
  const method = methodOf(request.method);
  const url = String(request?.url ?? '');

  const exactEntry = request.matchKey ? indexes.exact.get(request.matchKey) : undefined;
  if (exactEntry) {
    return { entry: exactEntry, matchedVia: 'exact', reason: null, sameUrl: 1, samePath: 1 };
  }

  const urlCandidates = indexes.byUrl.get(urlMatchKey(method, url)) ?? [];
  const pathCandidates = indexes.byPath.get(pathMatchKey(method, url)) ?? [];
  const sameUrl = urlCandidates.length;
  const samePath = pathCandidates.length;

  if (smartFallback) {
    if (sameUrl === 1) {
      return { entry: urlCandidates[0], matchedVia: 'url', reason: null, sameUrl, samePath };
    }
    if (sameUrl > 1) {
      return { entry: null, matchedVia: null, reason: 'ambiguous-body', sameUrl, samePath };
    }
    if (samePath === 1) {
      return { entry: pathCandidates[0], matchedVia: 'path', reason: null, sameUrl, samePath };
    }
    if (samePath > 1) {
      return { entry: null, matchedVia: null, reason: 'ambiguous-url', sameUrl, samePath };
    }
    return { entry: null, matchedVia: null, reason: 'no-recording', sameUrl, samePath };
  }

  if (sameUrl > 0) {
    return { entry: null, matchedVia: null, reason: 'body-differs', sameUrl, samePath };
  }
  if (samePath > 0) {
    return { entry: null, matchedVia: null, reason: 'url-differs', sameUrl, samePath };
  }
  return { entry: null, matchedVia: null, reason: 'no-recording', sameUrl, samePath };
}

/**
 * Human readable explanation of a live-pass reason.
 * @param {string|null|undefined} reason
 */
export function describeMatchReason(reason) {
  switch (reason) {
    case 'no-recording':
      return 'no recording exists for this request';
    case 'body-differs':
      return 'the same URL is recorded, but with a different request body';
    case 'url-differs':
      return 'the same endpoint is recorded, but with a different URL';
    case 'ambiguous-body':
      return 'several recordings share this URL with different bodies, so matching was refused';
    case 'ambiguous-url':
      return 'several recordings share this endpoint with different URLs, so matching was refused';
    case 'body-unavailable':
      return 'Chrome did not expose the request body, so it could not be matched';
    case 'body-missing':
      return 'the recorded response body is missing from storage';
    case 'fulfill-error':
      return 'the recorded response could not be returned';
    case 'ws-no-recording':
      return 'no recorded WebSocket exists for this endpoint';
    case 'ws-ambiguous-url':
      return 'several recorded WebSockets share this endpoint, so replay was refused';
    case 'ws-frame-unmatched':
      return 'the page sent a WebSocket frame that has no recorded reply';
    case 'ws-frames-missing':
      return 'the recorded WebSocket frames are missing from storage';
    case 'ws-start-error':
      return 'WebSocket replay could not be started for this tab';
    default:
      return String(reason ?? 'unknown reason');
  }
}
