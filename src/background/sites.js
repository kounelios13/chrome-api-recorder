/**
 * Site allowlist management.
 *
 * Only sites listed here get the in-page HUD content script and may start a
 * recording/replay session. Host access is an optional permission requested
 * explicitly by the user (from the popup or the settings page).
 */
import { BROADCAST, OVERLAY_FILE, OVERLAY_SCRIPT_PREFIX } from '../shared/constants.js';
import { isUrlAllowed, normalizeSiteInput } from '../shared/patterns.js';
import * as broadcast from './broadcast.js';
import * as store from './store.js';

/**
 * @param {string} pattern
 * @returns {Promise<boolean>}
 */
export async function hasHostAccess(pattern) {
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/** @returns {Promise<Array<{pattern: string, granted: boolean}>>} */
export async function listSites() {
  const sites = await store.getSites();
  const result = [];
  for (const pattern of sites) {
    result.push({ pattern, granted: await hasHostAccess(pattern) });
  }
  return result;
}

/** @param {string} url @returns {Promise<boolean>} */
export async function isSiteAllowed(url) {
  return isUrlAllowed(url, await store.getSites());
}

/**
 * Add a site. Host access must already be granted by the caller (which has to
 * happen inside a user gesture).
 * @param {string} rawInput
 */
export async function addSite(rawInput) {
  const pattern = normalizeSiteInput(rawInput);

  if (!(await hasHostAccess(pattern))) {
    throw new Error('Chrome has not granted access to this site yet. Add it from Settings or the popup so Chrome can ask for permission.');
  }

  const sites = await store.getSites();
  if (!sites.includes(pattern)) {
    sites.push(pattern);
    await store.setSites(sites);
  }

  await syncContentScripts();
  await injectOverlayIntoMatchingTabs(pattern);
  await broadcastSites();
  return listSites();
}

/**
 * @param {string} rawPattern stored pattern
 */
export async function removeSite(rawPattern) {
  const pattern = normalizeSiteInput(rawPattern);
  const sites = (await store.getSites()).filter((site) => site !== pattern);
  await store.setSites(sites);

  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    /* declared permissions cannot be removed; ignore */
  }

  await syncContentScripts();
  await broadcastSites();
  return listSites();
}

/**
 * Re-register the in-page HUD content script for every allowed site. Called on
 * startup and whenever the allowlist changes, so registrations always mirror
 * the stored list (and never contain stale patterns).
 */
export async function syncContentScripts() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const ids = existing
      .filter((script) => typeof script.id === 'string' && script.id.startsWith(OVERLAY_SCRIPT_PREFIX))
      .map((script) => script.id);
    if (ids.length > 0) await chrome.scripting.unregisterContentScripts({ ids });
  } catch (error) {
    console.warn('[api-recorder] could not reset content scripts', error);
  }

  for (const pattern of await store.getSites()) {
    if (!(await hasHostAccess(pattern))) continue;
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: `${OVERLAY_SCRIPT_PREFIX}${hashPattern(pattern)}`,
          matches: [pattern],
          js: [OVERLAY_FILE],
          runAt: 'document_start',
          allFrames: false,
          persistAcrossSessions: true,
        },
      ]);
    } catch (error) {
      console.warn('[api-recorder] could not register the overlay for', pattern, error);
    }
  }
}

/**
 * Inject the HUD into a tab that is already loaded (for example right after a
 * session starts, or after the site was just enabled).
 * @param {number} tabId
 */
export async function ensureOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [OVERLAY_FILE] });
  } catch {
    /* restricted pages simply get no HUD */
  }
}

/** @param {string} pattern */
async function injectOverlayIntoMatchingTabs(pattern) {
  try {
    const tabs = await chrome.tabs.query({ url: pattern });
    for (const tab of tabs) {
      if (typeof tab.id === 'number') await ensureOverlay(tab.id);
    }
  } catch {
    /* ignore */
  }
}

async function broadcastSites() {
  const sites = await listSites();
  void broadcast.broadcastToExtension({ type: BROADCAST.SITES_UPDATE, sites });
}

/** @param {string} pattern */
function hashPattern(pattern) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < pattern.length; index += 1) {
    hash ^= pattern.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
