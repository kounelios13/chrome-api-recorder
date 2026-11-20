/**
 * Response header handling for replay.
 *
 * The body stored by CDP is already decompressed, so replaying it with the
 * original `content-encoding`/`content-length` would corrupt the response.
 * Those framing headers are dropped before `Fetch.fulfillRequest`.
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

/** Header names whose values must not be replayed verbatim. */
const NEVER_REPLAY = new Set(['set-cookie', 'set-cookie2']);

/**
 * Convert CDP `response.headers` (a map) or a header array into
 * `[{name, value}]`, which is what `Fetch.fulfillRequest` expects.
 * @param {Record<string,string>|Array<{name:string,value:string}>|undefined|null} headers
 */
export function headersToArray(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers
      .filter((header) => header && header.name)
      .map((header) => ({ name: String(header.name), value: String(header.value ?? '') }));
  }
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value ?? '') }));
}

/**
 * Sanitize recorded response headers for `Fetch.fulfillRequest`.
 *
 * @param {Record<string,string>|Array<{name:string,value:string}>} headers
 * @param {{replayCookies?: boolean}} [options]
 * @returns {Array<{name: string, value: string}>}
 */
export function sanitizeResponseHeaders(headers, { replayCookies = false } = {}) {
  const out = [];
  for (const header of headersToArray(headers)) {
    const name = header.name.trim();
    if (!name || name.startsWith(':')) continue;

    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (!replayCookies && NEVER_REPLAY.has(lower)) continue;

    out.push({ name, value: header.value });
  }
  return out;
}

/**
 * Case-insensitive lookup of a header in a map or array.
 * @param {Record<string,string>|Array<{name:string,value:string}>} headers
 * @param {string} name
 */
export function headerValue(headers, name) {
  if (!headers) return '';
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    const found = headers.find((header) => String(header.name ?? '').toLowerCase() === wanted);
    return found ? String(found.value ?? '') : '';
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value ?? '');
  }
  return '';
}
