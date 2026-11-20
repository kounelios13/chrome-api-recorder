/**
 * Thin, friendly wrapper around chrome.debugger.
 *
 * Chrome only allows one debugger client per tab, so attach can fail when
 * DevTools is open; the raw error is translated into something actionable.
 */

const PROTOCOL_VERSION = '1.3';

export class CdpError extends Error {
  /** @param {string} message @param {unknown} [cause] */
  constructor(message, cause) {
    super(message);
    this.name = 'CdpError';
    this.cause = cause;
  }
}

/**
 * @param {unknown} rawMessage
 * @returns {string}
 */
export function friendlyCdpError(rawMessage) {
  const message = String(rawMessage ?? '');
  if (/Another debugger is already attached/i.test(message)) {
    return 'Chrome is already debugging this tab. Close DevTools (or another debugger extension) for this tab and try again.';
  }
  if (/Cannot attach|Cannot access|not attachable|Cannot find context/i.test(message)) {
    return 'Chrome does not allow debugging this page. Open a normal http(s) page and try again.';
  }
  if (/Permission denied|not enabled/i.test(message)) {
    return 'The extension is missing the debugger permission. Reload the extension and try again.';
  }
  return message || 'Could not attach the Chrome debugger.';
}

/** @param {number} tabId */
export async function attach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (error) {
    throw new CdpError(friendlyCdpError(/** @type {any} */ (error)?.message ?? error), error);
  }
}

/** @param {number} tabId */
export async function detach(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    const message = String(/** @type {any} */ (error)?.message ?? error ?? '');
    if (/not attached/i.test(message)) return;
    throw new CdpError(friendlyCdpError(message), error);
  }
}

/**
 * @param {number} tabId
 * @param {string} method
 * @param {object} [params]
 */
export async function sendCommand(tabId, method, params) {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params ?? {});
  } catch (error) {
    throw new CdpError(friendlyCdpError(/** @type {any} */ (error)?.message ?? error), error);
  }
}

/**
 * Attach if needed. If chrome.debugger reports that a debugger is already
 * attached, probe whether it is our own session that survived a service worker
 * restart; only then treat it as attached.
 * @param {number} tabId
 * @returns {Promise<'attached'|'reused'>}
 */
export async function ensureAttached(tabId) {
  try {
    await attach(tabId);
    return 'attached';
  } catch (error) {
    if (await canReachSession(tabId)) return 'reused';
    throw error;
  }
}

/**
 * Check whether the extension can still talk to an existing debugger session
 * (used to recover sessions after the service worker restarts).
 * @param {number} tabId
 */
export async function canReachSession(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: '1',
      returnByValue: true,
      silent: true,
    });
    return true;
  } catch {
    return false;
  }
}
