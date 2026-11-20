/**
 * Message broadcasting helpers.
 *
 * Content scripts only receive `chrome.tabs.sendMessage`, while extension
 * pages (popup/options) only receive `chrome.runtime.sendMessage` from the
 * service worker. Failures are expected when no listener is present (for
 * example no popup is open), so they are swallowed.
 */

/**
 * @param {number} tabId
 * @param {object} message
 */
export async function broadcastToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, { ...message, __broadcast: true });
  } catch {
    /* no content script in that tab */
  }
}

/** @param {object} message */
export async function broadcastToExtension(message) {
  try {
    await chrome.runtime.sendMessage({ ...message, __broadcast: true });
  } catch {
    /* no extension page is open */
  }
}
