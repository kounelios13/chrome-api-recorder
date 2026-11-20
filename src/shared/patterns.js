/**
 * Site allowlist patterns.
 *
 * The extension only runs on pages the user explicitly added in Settings.
 * Each entry is a Chrome match pattern such as `*://*.example.com/*`.
 *
 * Chrome match patterns do not support port numbers (host permissions cover
 * every port of the host), so ports are stripped from user input and optional
 * in URL matching.
 */

const PATTERN_RE = /^(\*|https?):\/\/([^/]+)(\/.*)?$/;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn a match pattern into a RegExp. Throws on malformed patterns.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function patternToRegExp(pattern) {
  const match = PATTERN_RE.exec(String(pattern ?? '').trim());
  if (!match) throw new Error(`Invalid site pattern: ${pattern}`);
  const [, scheme, host] = match;
  const path = match[3] || '/*';

  const schemeRe = scheme === '*' ? 'https?' : scheme;
  let hostRe;
  if (host === '*') {
    hostRe = '[^/]+';
  } else if (host.startsWith('*.')) {
    hostRe = `(?:[^/]+\\.)?${escapeRegExp(host.slice(2))}`;
  } else {
    hostRe = escapeRegExp(host);
  }

  // Host permissions apply to every port; accept an optional port in URLs.
  const portRe = host === '*' ? '' : '(?::\\d+)?';
  const pathRe = escapeRegExp(path).replace(/\\\*/g, '.*');
  return new RegExp(`^${schemeRe}://${hostRe}${portRe}${pathRe}$`, 'i');
}

/** Does `url` match the Chrome-style match `pattern`? */
export function matchesPattern(pattern, url) {
  try {
    return patternToRegExp(pattern).test(String(url ?? ''));
  } catch {
    return false;
  }
}

/** Is `url` allowed by any of the configured site patterns? */
export function isUrlAllowed(url, sites) {
  if (!Array.isArray(sites) || sites.length === 0) return false;
  return sites.some((pattern) => matchesPattern(pattern, url));
}

/**
 * Normalize user input from Settings into a valid match pattern.
 * Accepts `example.com`, `*.example.com`, `localhost:3000`, `https://example.com/app`, ...
 * @param {string} input
 * @returns {string}
 */
export function normalizeSiteInput(input) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new Error('Enter a site address, for example example.com');
  if (/\s/.test(raw)) throw new Error('Invalid host name');

  // Bare domain / path gets both schemes so http-only dev servers also work.
  if (!/^[a-zA-Z*]+:\/\//.test(raw)) raw = `*://${raw}`;

  const match = PATTERN_RE.exec(raw);
  if (!match) {
    throw new Error('Use a domain like example.com, or a URL like https://example.com/app');
  }

  const scheme = match[1].toLowerCase();
  let host = match[2].toLowerCase().replace(/\/+$/, '');
  let path = match[3] || '/*';

  if (!host || /\s/.test(host) || host.includes('..')) throw new Error('Invalid host name');

  // Chrome match patterns ignore ports; strip a `:port` suffix instead of
  // producing an invalid pattern.
  const portMatch = /^(.+?):(\d{1,5})$/.exec(host);
  if (portMatch) host = portMatch[1];
  if (host.includes(':')) throw new Error('Invalid host name');

  if (host !== '*' && host.startsWith('*') && !host.startsWith('*.')) {
    throw new Error('Wildcards are only supported at the start of the host, e.g. *.example.com');
  }
  if (host !== '*' && host.includes('*') && !host.startsWith('*.')) throw new Error('Invalid wildcard host');

  if (!path.startsWith('/')) path = `/${path}`;
  if (!path.endsWith('*')) path = `${path}*`;

  const pattern = `${scheme}://${host}${path}`;
  patternToRegExp(pattern); // validate
  return pattern;
}

/**
 * Default match pattern for enabling the current page, e.g. `https://app.test/*`.
 * Ports are omitted because host permissions cover all of them.
 * @param {string} url
 */
export function patternForTabUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) pages can be enabled');
  }
  return `${parsed.protocol}//${parsed.hostname}/*`;
}
