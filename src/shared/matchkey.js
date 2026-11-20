/**
 * Request identity.
 *
 * A recorded response is addressed by a hash of:
 *   METHOD \n normalized-url \n exact-request-body-bytes
 *
 * Using the exact body bytes means `POST /api/items {"id":1}` and
 * `POST /api/items {"id":2}` are stored as two independent recordings even
 * though the endpoint is identical.
 */
import { bytesToUtf8, bytesPreview, looksLikeText, utf8ToBytes } from './bytes.js';
import { normalizeUrl } from './url.js';

/**
 * SHA-256 of the given bytes as lowercase hex.
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function sha256Hex(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Stable identity of a request.
 *
 * @param {{method?: string, url: string, bodyBytes?: Uint8Array|null}} request
 * @returns {Promise<string>} hex hash
 */
export async function requestKey({ method, url, bodyBytes }) {
  const body = bodyBytes instanceof Uint8Array ? bodyBytes : new Uint8Array(0);
  const prefix = utf8ToBytes(`${String(method ?? 'GET').toUpperCase()}\n${normalizeUrl(url)}\n`);
  const combined = new Uint8Array(prefix.length + body.length);
  combined.set(prefix, 0);
  combined.set(body, prefix.length);
  return sha256Hex(combined);
}

/**
 * Human readable label for a request, useful for the UI and replay logs.
 * @param {{method?: string, url: string, bodyBytes?: Uint8Array|null}} request
 * @param {number} maxBodyChars
 */
export function requestSignature({ method, url, bodyBytes }, maxBodyChars = 200) {
  const head = `${String(method ?? 'GET').toUpperCase()} ${normalizeUrl(url)}`;
  if (!bodyBytes || bodyBytes.length === 0) return head;
  const preview = looksLikeText(bodyBytes) ? bytesPreview(bodyBytes, maxBodyChars) : `<${bodyBytes.length} bytes>`;
  return `${head} · ${preview}`;
}

/**
 * Is this a GraphQL request? The user asked for GraphQL traffic to be excluded
 * from recording and replay, so such requests always go to the live network.
 *
 * Detected when:
 *  - the URL path contains "graphql" (case insensitive), or
 *  - the URL has a `query` search parameter, or
 *  - the body is a raw GraphQL document starting with `query`/`mutation`/`subscription`, or
 *  - the body is JSON with a string `query` property (standard GraphQL-over-HTTP).
 *
 * @param {{url: string, bodyBytes?: Uint8Array|null, bodyText?: string}} request
 */
export function isGraphqlRequest({ url, bodyBytes, bodyText }) {
  try {
    const parsed = new URL(url);
    if (/graphql/i.test(parsed.pathname)) return true;
    if (parsed.searchParams.has('query')) return true;
  } catch {
    /* non-absolute URL: fall through to body checks */
  }

  let text = typeof bodyText === 'string' ? bodyText : '';
  if (!text && bodyBytes && bodyBytes.length > 0) text = bytesToUtf8(bodyBytes);
  text = text.trim();
  if (!text) return false;

  if (/^(query|mutation|subscription)\b/i.test(text)) return true;

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && typeof parsed.query === 'string') return true;
    } catch {
      /* not JSON */
    }
  }
  return false;
}
