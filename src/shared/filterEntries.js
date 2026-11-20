/**
 * Client-side filter for the recorded-request table in Settings.
 *
 * A query is split on whitespace; every term must appear (case-insensitively)
 * somewhere in the entry's method, URL, status, MIME type, size or previews.
 * This makes queries like `post /api/orders` or `200 json` work as expected.
 */

/** @param {unknown} query */
export function parseFilterTerms(query) {
  return String(query ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Everything a filter query is matched against, lower-cased.
 * @param {any} entry
 */
export function entrySearchText(entry) {
  return [
    entry?.method,
    entry?.url,
    entry?.status,
    entry?.statusText,
    entry?.mimeType,
    entry?.size,
    entry?.requestPreview,
    entry?.responsePreview,
  ]
    .map((value) => (value == null ? '' : String(value)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * @param {any[]} entries
 * @param {unknown} query
 * @returns {any[]} matching entries (a copy; the input is not mutated)
 */
export function filterEntries(entries, query) {
  const list = Array.isArray(entries) ? entries : [];
  const terms = parseFilterTerms(query);
  if (terms.length === 0) return list.slice();

  return list.filter((entry) => {
    const haystack = entrySearchText(entry);
    return terms.every((term) => haystack.includes(term));
  });
}
