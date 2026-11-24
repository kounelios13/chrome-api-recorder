/**
 * URL normalization used to build stable request keys.
 *
 * Two requests are considered "the same URL" when they agree on origin, path
 * and query parameters. The fragment is ignored (it never reaches the server)
 * and query parameters are sorted, so `?a=1&b=2` and `?b=2&a=1` are equivalent.
 */

/**
 * Normalize an absolute URL. Invalid URLs are returned unchanged so the caller
 * can still show something useful.
 * @param {string} rawUrl
 * @returns {string}
 */
export function normalizeUrl(rawUrl) {
  const raw = String(rawUrl ?? '');
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.hash = '';
    const entries = [...url.searchParams.entries()];
    entries.sort(([nameA, valueA], [nameB, valueB]) => {
      if (nameA !== nameB) return nameA < nameB ? -1 : 1;
      if (valueA !== valueB) return valueA < valueB ? -1 : 1;
      return 0;
    });
    const params = new URLSearchParams();
    for (const [name, value] of entries) params.append(name, value);
    const search = params.toString();
    url.search = search ? `?${search}` : '';
    return url.toString();
  } catch {
    return raw;
  }
}

/**
 * The path + query part of a URL, used for compact UI labels.
 * @param {string} rawUrl
 */
export function shortUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.pathname}${url.search}` || '/';
  } catch {
    return String(rawUrl ?? '');
  }
}

/** @param {string} rawUrl */
export function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '';
  }
}

/** @param {string} rawUrl */
export function originOf(rawUrl) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return '';
  }
}

/** @param {string} rawUrl */
export function isHttpUrl(rawUrl) {
  try {
    const { protocol } = new URL(rawUrl);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** @param {string} rawUrl */
export function isWsUrl(rawUrl) {
  try {
    const { protocol } = new URL(rawUrl);
    return protocol === 'ws:' || protocol === 'wss:';
  } catch {
    return false;
  }
}

/**
 * The endpoint a WebSocket URL points at, with the query string removed.
 *
 * Correlation ids, tokens and `sid`s live in the query string of most WS
 * handshakes, so the stable part of the address is origin + path.
 * @param {string} rawUrl
 */
export function wsEndpointKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return String(rawUrl ?? '');
  }
}

/** @param {string} rawUrl */
export function wsEndpointPath(rawUrl) {
  try {
    return new URL(rawUrl).pathname || '/';
  } catch {
    return String(rawUrl ?? '');
  }
}

/**
 * Is this WebSocket traffic GraphQL?
 *
 * The existing `skipGraphql` setting also hides GraphQL subscriptions, which use
 * the `graphql-ws` / `graphql-transport-ws` sub-protocols or a URL with
 * "graphql" in it.
 *
 * @param {{url: string, protocols?: string[]|string|null}} connection
 */
export function isGraphqlWs({ url, protocols }) {
  const list = Array.isArray(protocols)
    ? protocols
    : typeof protocols === 'string' && protocols
      ? protocols.split(',').map((item) => item.trim())
      : [];
  if (list.some((protocol) => /^graphql(-transport)?-ws$/i.test(String(protocol)))) return true;

  try {
    const parsed = new URL(url);
    if (/graphql/i.test(parsed.pathname)) return true;
    if (/graphql/i.test(parsed.search)) return true;
  } catch {
    return /graphql/i.test(String(url ?? ''));
  }
  return false;
}

