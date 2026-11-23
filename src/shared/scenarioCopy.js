/**
 * Pure whole-scenario copy & origin-rewriting helpers.
 *
 * Rewrites every recorded entry in a scenario to a single target origin
 * (scheme + host + optional port) while preserving paths, query strings,
 * hashes, response bodies, and optional edits.
 *
 * Because `matchKey` is a one-way SHA-256 of `METHOD\nnormalizeUrl(url)\n<body>`
 * and raw request bodies are not persisted:
 *  - Bodyless requests (GET, HEAD, empty-body POST, etc.) are detected
 *    deterministically and re-keyed for exact matching on the target origin.
 *  - Requests with a non-empty body keep their original `matchKey` and rely on
 *    `smartFallback` (byUrl / byPath) when replayed on the target host.
 */
import { LIMITS } from './constants.js';
import { requestKey } from './matchkey.js';
import { collectEntryHosts } from './scenarioHosts.js';
import { normalizeUrl, originOf } from './url.js';

/**
 * Validate and normalize a user-supplied target origin.
 * Accepts `http://` or `https://` URLs (any path/query/hash is ignored).
 *
 * @param {unknown} raw
 * @returns {{origin: string, host: string}}
 */
export function normalizeTargetOrigin(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    throw new Error('Enter a target origin like http://localhost:3000 or https://staging.example.com.');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Enter a valid origin starting with http:// or https://.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Target origin must start with http:// or https://.');
  }

  return {
    origin: parsed.origin,
    host: parsed.host.toLowerCase(),
  };
}

const SITE_PATTERN_RE = /^(\*|https?):\/\/([^/]+)(?:\/.*)?$/i;

/**
 * Infer a default scheme for a bare host (`http` for loopback/localhost, `https` otherwise).
 * @param {string} host
 */
function defaultSchemeForHost(host) {
  const lower = String(host ?? '').trim().toLowerCase();
  const hostname = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  ) {
    return 'http';
  }
  return 'https';
}

/**
 * Collect deduplicated, sorted target origin suggestions from configured
 * allowed sites and existing scenarios' recorded hosts.
 *
 * Wildcard site patterns (all-sites or wildcard subdomains) are skipped because
 * they do not represent a concrete target origin.
 *
 * @param {{
 *   sites?: Array<string | {pattern?: string}>,
 *   scenarios?: Array<{hosts?: string[]}>,
 * }} [options]
 * @returns {string[]}
 */
export function collectSuggestedTargetOrigins({ sites = [], scenarios = [] } = {}) {
  const origins = new Set();

  if (Array.isArray(sites)) {
    for (const item of sites) {
      const pattern = typeof item === 'string' ? item : String(item?.pattern ?? '');
      const match = SITE_PATTERN_RE.exec(pattern.trim());
      if (!match) continue;
      const rawScheme = match[1].toLowerCase();
      const host = match[2].toLowerCase();
      if (!host || host.includes('*')) continue;
      const scheme = rawScheme === '*' ? defaultSchemeForHost(host) : rawScheme;
      try {
        origins.add(normalizeTargetOrigin(`${scheme}://${host}`).origin);
      } catch {
        /* ignore malformed site pattern */
      }
    }
  }

  if (Array.isArray(scenarios)) {
    for (const scenario of scenarios) {
      const hosts = Array.isArray(scenario?.hosts) ? scenario.hosts : [];
      for (const rawHost of hosts) {
        const host = String(rawHost ?? '').trim().toLowerCase();
        if (!host || host.includes('*')) continue;
        const candidate = /^https?:\/\//i.test(host) ? host : `${defaultSchemeForHost(host)}://${host}`;
        try {
          origins.add(normalizeTargetOrigin(candidate).origin);
        } catch {
          /* ignore malformed host */
        }
      }
    }
  }

  return [...origins].sort();
}

/**
 * Build a default name for a copied scenario (`<name> (<targetHost>)`),
 * truncated to fit `LIMITS.MAX_SCENARIO_NAME`.
 *
 * @param {string} sourceName
 * @param {string} targetHost
 * @returns {string}
 */
export function defaultCopyScenarioName(sourceName, targetHost) {
  const base = String(sourceName ?? '').replace(/\s+/g, ' ').trim();
  const host = String(targetHost ?? '').trim().toLowerCase();
  if (!host) return base.slice(0, LIMITS.MAX_SCENARIO_NAME);

  const suffix = ` (${host})`;
  if (base.length + suffix.length <= LIMITS.MAX_SCENARIO_NAME) {
    return `${base}${suffix}`;
  }

  const maxBase = LIMITS.MAX_SCENARIO_NAME - suffix.length;
  if (maxBase >= 4) {
    return `${base.slice(0, maxBase - 1).trimEnd()}…${suffix}`;
  }
  return `${base}${suffix}`.slice(0, LIMITS.MAX_SCENARIO_NAME);
}

/**
 * Replace the origin of `rawUrl` with `targetOrigin`, keeping path, query, and hash.
 *
 * @param {string} rawUrl
 * @param {string} targetOrigin
 * @returns {string}
 */
export function rewriteUrlOrigin(rawUrl, targetOrigin) {
  try {
    const parsed = new URL(rawUrl);
    return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, targetOrigin).toString();
  } catch {
    return String(rawUrl ?? '');
  }
}

/**
 * Rewrite the URL portion of `entry.requestPreview` while preserving the method
 * prefix and any body preview suffix.
 *
 * @param {unknown} preview
 * @param {string} oldUrl
 * @param {string} newUrl
 */
export function rewriteRequestPreview(preview, oldUrl, newUrl) {
  if (typeof preview !== 'string' || !preview) return preview;
  const oldNormalized = normalizeUrl(oldUrl);
  const newNormalized = normalizeUrl(newUrl);
  if (oldNormalized && preview.includes(oldNormalized)) {
    return preview.replace(oldNormalized, newNormalized);
  }
  if (oldUrl && preview.includes(oldUrl)) {
    return preview.replace(oldUrl, newUrl);
  }
  return preview;
}

/**
 * Rewrite `Access-Control-Allow-Origin` and `Location` response headers when
 * they reference one of the scenario's original origins.
 *
 * @param {Array<{name: string, value: string}>} headers
 * @param {Set<string>} sourceOrigins lowercased origin strings
 * @param {string} targetOrigin
 * @returns {Array<{name: string, value: string}>}
 */
export function rewriteResponseHeaders(headers, sourceOrigins, targetOrigin) {
  if (!Array.isArray(headers)) return [];
  return headers.map((header) => {
    if (!header || typeof header.name !== 'string') return header;
    const lower = header.name.trim().toLowerCase();
    const value = String(header.value ?? '');

    if (lower === 'access-control-allow-origin') {
      if (sourceOrigins.has(value.trim().toLowerCase())) {
        return { name: header.name, value: targetOrigin };
      }
      return { name: header.name, value };
    }

    if (lower === 'location') {
      try {
        const parsed = new URL(value);
        if (sourceOrigins.has(parsed.origin.toLowerCase())) {
          return {
            name: header.name,
            value: new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, targetOrigin).toString(),
          };
        }
      } catch {
        /* relative Location header: leave as-is */
      }
      return { name: header.name, value };
    }

    return { name: header.name, value };
  });
}

/**
 * Rewrite all entries and bodies of a scenario to a single target origin.
 *
 * @param {{
 *   entries: Array<any>,
 *   bodiesById?: Record<string, {id?: string, body?: string, originalBody?: string}>,
 *   newScenarioId: string,
 *   targetOrigin: string,
 *   rewriteHeaders?: boolean,
 * }} options
 */
export async function rewriteScenarioEntries({
  entries,
  bodiesById = {},
  newScenarioId,
  targetOrigin,
  rewriteHeaders = true,
}) {
  const { origin: normalizedOrigin, host: targetHost } = normalizeTargetOrigin(targetOrigin);
  const list = Array.isArray(entries) ? entries : [];

  const sourceOrigins = new Set();
  for (const entry of list) {
    const origin = originOf(entry?.url);
    if (origin) sourceOrigins.add(origin.toLowerCase());
  }

  const records = [];
  let rekeyedCount = 0;
  let fallbackCount = 0;

  for (const entry of list) {
    const oldUrl = String(entry.url ?? '');
    const newUrl = rewriteUrlOrigin(oldUrl, normalizedOrigin);

    const emptyKey = await requestKey({ method: entry.method, url: oldUrl });
    let newMatchKey;
    if (emptyKey === entry.matchKey) {
      newMatchKey = await requestKey({ method: entry.method, url: newUrl });
      rekeyedCount += 1;
    } else {
      newMatchKey = entry.matchKey;
      fallbackCount += 1;
    }

    const newId = `${newScenarioId}:${newMatchKey}`;
    const newRequestPreview = rewriteRequestPreview(entry.requestPreview, oldUrl, newUrl);
    const rewrittenEntry = {
      ...entry,
      id: newId,
      scenarioId: newScenarioId,
      matchKey: newMatchKey,
      url: newUrl,
      requestPreview: newRequestPreview,
    };

    if (rewriteHeaders && Array.isArray(entry.responseHeaders)) {
      rewrittenEntry.responseHeaders = rewriteResponseHeaders(entry.responseHeaders, sourceOrigins, normalizedOrigin);
    }

    const bodyRecord = bodiesById?.[entry.id];
    const record = {
      entry: rewrittenEntry,
      body: typeof bodyRecord?.body === 'string' ? bodyRecord.body : '',
    };
    if (typeof bodyRecord?.originalBody === 'string') {
      record.originalBody = bodyRecord.originalBody;
    }
    records.push(record);
  }

  const hosts = records.length > 0 ? collectEntryHosts(records.map((record) => record.entry)) : [targetHost];

  return {
    records,
    hosts,
    copiedCount: records.length,
    rekeyedCount,
    fallbackCount,
    targetOrigin: normalizedOrigin,
    targetHost,
  };
}
