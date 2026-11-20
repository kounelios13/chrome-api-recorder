/**
 * Scenario ↔ host association helpers.
 *
 * A scenario "belongs" to every host it recorded requests from. The popup uses
 * this to show, for the current tab, only the scenarios that recorded requests
 * on that tab's host.
 */

/** @param {string} url */
export function entryHost(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * All unique hosts (sorted) of a set of recorded entries.
 * @param {Array<{url?: string}>} entries
 */
export function collectEntryHosts(entries) {
  const hosts = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const host = entryHost(entry?.url);
    if (host) hosts.add(host);
  }
  return [...hosts].sort();
}

/**
 * Normalize a stored/imported hosts list.
 * @param {unknown} value
 */
export function sanitizeHosts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const hosts = [];
  for (const item of value) {
    const host = String(item ?? '')
      .trim()
      .toLowerCase();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts.sort();
}

/**
 * Keep only the scenarios that recorded requests on the given host.
 * @param {Array<{hosts?: string[]}>} scenarios
 * @param {string} host
 */
export function filterScenariosByHost(scenarios, host) {
  const wanted = String(host ?? '')
    .trim()
    .toLowerCase();
  const list = Array.isArray(scenarios) ? scenarios : [];
  if (!wanted) return list.slice();
  return list.filter((scenario) =>
    (scenario?.hosts ?? []).some((item) => String(item).toLowerCase() === wanted),
  );
}
