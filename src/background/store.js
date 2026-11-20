/**
 * Persistence of small metadata (allowed sites, scenarios, settings) in
 * chrome.storage.local, plus per-tab session snapshots in
 * chrome.storage.session so a restarted service worker can recover them.
 */
import { DEFAULT_SETTINGS, STORAGE } from '../shared/constants.js';

/**
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @returns {Promise<T>}
 */
async function readLocal(key, fallback) {
  const bag = await chrome.storage.local.get(key);
  return bag[key] === undefined ? fallback : bag[key];
}

/** @param {unknown} value */
export function sanitizeSites(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const pattern = String(item ?? '').trim();
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

/** @returns {Promise<string[]>} */
export async function getSites() {
  return sanitizeSites(await readLocal(STORAGE.SITES, []));
}

/** @param {string[]} sites */
export async function setSites(sites) {
  await chrome.storage.local.set({ [STORAGE.SITES]: sanitizeSites(sites) });
}

/** @param {unknown} value */
function normalizeScenario(value) {
  return {
    id: String(value.id),
    name: String(value.name),
    createdAt: Number(value.createdAt) || 0,
    updatedAt: Number(value.updatedAt) || Number(value.createdAt) || 0,
  };
}

/** @returns {Promise<Array<{id:string,name:string,createdAt:number,updatedAt:number}>>} */
export async function getScenarios() {
  const value = await readLocal(STORAGE.SCENARIOS, []);
  if (!Array.isArray(value)) return [];
  return value
    .filter((scenario) => scenario && typeof scenario.id === 'string' && typeof scenario.name === 'string')
    .map(normalizeScenario);
}

/** @param {Array<{id:string,name:string,createdAt:number,updatedAt:number}>} scenarios */
export async function setScenarios(scenarios) {
  await chrome.storage.local.set({ [STORAGE.SCENARIOS]: scenarios.map(normalizeScenario) });
}

/**
 * Validate and clamp user settings.
 * @param {unknown} input
 */
export function sanitizeSettings(input) {
  const out = { ...DEFAULT_SETTINGS };
  if (!input || typeof input !== 'object') return out;

  const maxBodyBytes = Number(/** @type {any} */ (input).maxBodyBytes);
  if (Number.isFinite(maxBodyBytes)) {
    out.maxBodyBytes = Math.min(Math.max(Math.round(maxBodyBytes), 1024), 200 * 1024 * 1024);
  }
  if (typeof /** @type {any} */ (input).skipGraphql === 'boolean') {
    out.skipGraphql = /** @type {any} */ (input).skipGraphql;
  }
  if (typeof /** @type {any} */ (input).replayCookies === 'boolean') {
    out.replayCookies = /** @type {any} */ (input).replayCookies;
  }
  return out;
}

/** @returns {Promise<{maxBodyBytes:number, skipGraphql:boolean, replayCookies:boolean}>} */
export async function getSettings() {
  return sanitizeSettings(await readLocal(STORAGE.SETTINGS, {}));
}

/**
 * Merge a partial settings patch into the stored settings.
 * @param {object} patch
 */
export async function setSettings(patch) {
  const current = await getSettings();
  const merged = sanitizeSettings({ ...current, ...(patch ?? {}) });
  await chrome.storage.local.set({ [STORAGE.SETTINGS]: merged });
  return merged;
}

/**
 * Persisted per-tab session snapshots used only for crash/restart recovery.
 * @returns {Promise<object[]>}
 */
export async function readTabSessions() {
  try {
    const bag = await chrome.storage.session.get(STORAGE.TAB_SESSIONS);
    const value = bag[STORAGE.TAB_SESSIONS];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** @param {object[]} sessions */
export async function writeTabSessions(sessions) {
  try {
    await chrome.storage.session.set({ [STORAGE.TAB_SESSIONS]: sessions });
  } catch {
    /* storage.session is best effort */
  }
}
