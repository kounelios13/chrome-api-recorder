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
import { normalizeUrl } from './url.js';

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
    pushTo(byUrl, urlMatchKey(entry.method, entry.url), entry);
    pushTo(byPath, pathMatchKey(entry.method, entry.url), entry);
  }

  return { exact, byUrl, byPath };
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
    default:
      return String(reason ?? 'unknown reason');
  }
}
