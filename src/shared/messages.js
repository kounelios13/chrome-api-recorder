/**
 * Typed message helpers shared by extension pages and content scripts.
 *
 * Every request message is `{type, ...payload}` and every response is
 * `{ok: true, ...data}` or `{ok: false, error}`. The service worker pushes
 * unsolicited updates with `__broadcast: true`.
 *
 * Request contracts (see `src/background/service-worker.js` for behavior):
 *
 *  state.get            {tabId?}
 *    -> {scenarios, sites, settings, session, currentSite, version}
 *  session.get          {tabId}
 *    -> {session}
 *  session.startRecording {tabId, scenarioId} -> {session}
 *  session.startReplay    {tabId, scenarioId} -> {session}
 *  session.setLive        {tabId, live:boolean} -> {session}
 *  session.stop           {tabId} -> {session:null}
 *  scenario.create        {name} -> {scenario}
 *  scenario.rename        {id, name} -> {scenario}
 *  scenario.delete        {id} -> {scenarios}
 *  scenario.entries       {scenarioId, limit?} -> {entries}
 *  scenario.entry.get     {scenarioId, entryId} -> {entry, payload, editable, hasOriginal}
 *  scenario.entry.update  {scenarioId, entryId, bodyText} -> {entry, hasOriginal}
 *                         {scenarioId, entryId, restoreOriginal:true} -> {entry, hasOriginal}
 *  settings.set           {settings} -> {settings}
 *  sites.add              {pattern} -> {sites}
 *  sites.remove           {pattern} -> {sites}
 *  sites.list             {} -> {sites}
 *  keepalive              {} -> {}
 *
 * The UIs should import `send` instead of calling chrome.runtime.sendMessage
 * directly so error handling stays consistent.
 */

/**
 * @param {string} type
 * @param {object} [payload]
 * @returns {Promise<object>}
 */
export async function send(type, payload = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (error) {
    throw new Error(friendlyError(error));
  }
  if (response == null) {
    throw new Error('The extension background did not respond. Reopen the popup and try again.');
  }
  if (response.ok === false) {
    throw new Error(response.error || 'The operation failed');
  }
  return response;
}

/** @param {unknown} error */
function friendlyError(error) {
  const message = String(/** @type {any} */ (error)?.message ?? error ?? '');
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
    return 'The extension background is starting up. Try again in a second.';
  }
  return message || 'The extension background did not respond';
}

/**
 * Subscribe to service-worker broadcasts from an extension page.
 * @param {(message: {type: string, [key: string]: any}) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onBroadcast(handler) {
  const listener = (message) => {
    if (message && message.__broadcast) handler(message);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
