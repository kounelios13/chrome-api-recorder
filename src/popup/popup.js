/**
 * API Recorder popup.
 *
 * Renders the small companion UI used to enable the current site, manage
 * scenarios and start/observe a per-tab recording/replay session.
 *
 * The popup is intentionally conservative about DOM updates: full re-renders
 * only happen after state-changing actions, while session broadcasts patch the
 * counters/badge in place so the UI does not flicker or steal focus from an
 * input the user is editing.
 */
import { BROADCAST, DEFAULT_SETTINGS, LIMITS, MSG, SESSION_MODE } from '../shared/constants.js';
import { onBroadcast, send } from '../shared/messages.js';
import { matchesPattern, patternForTabUrl } from '../shared/patterns.js';
import { hostOf, isHttpUrl, shortUrl } from '../shared/url.js';
import { normalizeScenarioName } from '../shared/scenarios.js';
import { filterScenariosByHost } from '../shared/scenarioHosts.js';

const LAST_SCENARIO_KEY = 'apirr:lastScenario';
const DELETE_CONFIRM_MS = 5000;
const NOTICE_MS = 2600;

/** @typedef {{id:string,name:string,createdAt:number,updatedAt:number,entryCount:number}} Scenario */
/** @typedef {{pattern:string,granted:boolean}} Site */
/** @typedef {{url:string,pattern:string|null,allowed:boolean}} CurrentSite */
/** @typedef {{tabId:number|null,mode:string,scenarioId:string|null,scenarioName:string,startedAt:number,recorded:number,hits:number,misses:number,skipped:number,error:string|null}} Session */

const MODE_STYLES = {
  [SESSION_MODE.RECORDING]: { label: 'RECORDING', className: 'badge badge-record' },
  [SESSION_MODE.REPLAY]: { label: 'REPLAY', className: 'badge badge-replay' },
  [SESSION_MODE.LIVE]: { label: 'LIVE', className: 'badge badge-live' },
};

const state = {
  tabId: null,
  loaded: false,
  loadError: false,
  version: '',

  /** @type {Scenario[]} */
  scenarios: [],
  /** @type {Site[]} */
  sites: [],
  settings: { ...DEFAULT_SETTINGS },
  /** @type {Session|null} */
  session: null,
  /** @type {CurrentSite|null} */
  currentSite: null,

  selectedScenarioId: null,
  renamingId: null,
  pendingDeleteId: null,
  pendingScenarioRender: false,
  showDiagnostics: false,
  hostFilter: true,

  timerId: 0,
  deleteTimer: 0,
  noticeTimer: 0,
  unsubscribe: null,
};

/** @type {Record<string, any>} */
const dom = {};

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function init() {
  cacheDom();
  wireStaticEvents();
  subscribeBroadcasts();
  window.addEventListener('pagehide', cleanup);

  bootstrap().catch((error) => {
    state.loaded = true;
    state.loadError = true;
    showError(error instanceof Error ? error.message : 'Could not start the popup.');
    renderAll();
  });
}

async function bootstrap() {
  try {
    const tabs = chrome?.tabs?.query ? await chrome.tabs.query({ active: true, currentWindow: true }) : [];
    const tabId = Number(tabs?.[0]?.id);
    state.tabId = Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
  } catch {
    state.tabId = null;
  }

  await refreshState({ initial: true });

  if (state.tabId == null && !state.loadError) {
    showError('No active tab is available. Open this popup from a normal web page tab.');
  }
}

function cacheDom() {
  const ids = [
    'version-chip',
    'error-banner',
    'error-text',
    'error-dismiss',
    'notice',
    'site-card',
    'site-status',
    'site-body',
    'scenario-count',
    'host-filter-toggle',
    'scenario-filter-hint',
    'scenario-select',
    'scenario-empty',
    'scenario-row',
    'new-scenario-form',
    'new-scenario-name',
    'create-scenario',
    'scenario-field-error',
    'session-card',
    'session-mode',
    'session-scenario',
    'session-timer',
    'session-counters',
    'counter-recorded',
    'counter-hits',
    'counter-misses',
    'counter-skipped',
    'session-diagnostics',
    'diagnostics-toggle',
    'diagnostics-summary',
    'diagnostics-body',
    'diagnostics-hint',
    'diagnostics-list',
    'session-error',
    'session-actions',
    'start-card',
    'start-scenario',
    'start-hint',
    'start-recording',
    'start-replay',
    'footer-count',
    'open-settings',
  ];
  for (const id of ids) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Popup markup is missing #${id}`);
    dom[toCamel(id)] = element;
  }
}

/** @param {string} id */
function toCamel(id) {
  return id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function wireStaticEvents() {
  dom.errorDismiss.addEventListener('click', hideError);
  dom.diagnosticsToggle.addEventListener('click', onDiagnosticsToggle);
  dom.newScenarioForm.addEventListener('submit', onCreateScenario);
  dom.scenarioSelect.addEventListener('change', onScenarioSelectionChange);
  dom.scenarioSelect.addEventListener('blur', onScenarioSelectBlur);
  dom.hostFilterToggle.addEventListener('click', onHostFilterToggle);
  dom.startRecording.addEventListener('click', (event) =>
    beginSession('recording', /** @type {HTMLButtonElement} */ (event.currentTarget)),
  );
  dom.startReplay.addEventListener('click', (event) =>
    beginSession('replay', /** @type {HTMLButtonElement} */ (event.currentTarget)),
  );
  dom.openSettings.addEventListener('click', openSettings);
}

function cleanup() {
  stopTimer();
  clearTimeout(state.deleteTimer);
  clearTimeout(state.noticeTimer);
  state.unsubscribe?.();
  state.unsubscribe = null;
}

/* ------------------------------------------------------------------ */
/* State loading                                                       */
/* ------------------------------------------------------------------ */

/**
 * Load the authoritative state for this tab from the service worker.
 * @param {{initial?: boolean}} [options]
 */
async function refreshState({ initial = false } = {}) {
  const payload = state.tabId == null ? {} : { tabId: state.tabId };
  try {
    const data = await send(MSG.STATE_GET, payload);
    applyState(data, { initial });
    state.loadError = false;
    hideError();
  } catch (error) {
    state.loaded = true;
    state.loadError = true;
    showError(errorMessage(error, 'Could not load the extension state.'));
    renderAll();
  }
}

/**
 * @param {any} data
 * @param {{initial?: boolean}} [options]
 */
function applyState(data, { initial = false } = {}) {
  state.loaded = true;
  state.scenarios = Array.isArray(data?.scenarios)
    ? data.scenarios.filter((item) => item && typeof item.id === 'string').map(normalizeScenario)
    : [];
  state.sites = normalizeSites(data?.sites);
  state.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
  state.session = normalizeSession(data?.session);
  state.currentSite = normalizeCurrentSite(data?.currentSite);
  state.version = typeof data?.version === 'string' ? data.version : '';

  const remembered = initial ? readStoredScenarioId() : state.selectedScenarioId;
  const exists = (id) => Boolean(id) && state.scenarios.some((scenario) => scenario.id === id);
  state.selectedScenarioId = exists(remembered)
    ? remembered
    : exists(state.selectedScenarioId)
      ? state.selectedScenarioId
      : (state.scenarios[0]?.id ?? null);
  persistSelection();
  ensureSelectionVisible();

  renderAll();
}

/** @param {any} value */
function normalizeScenario(value) {
  const fallback = Number(value?.createdAt) || 0;
  return {
    id: String(value.id),
    name: typeof value.name === 'string' ? value.name : String(value.name ?? ''),
    createdAt: fallback,
    updatedAt: Number(value.updatedAt) || fallback,
    entryCount: toCount(value.entryCount),
    hosts: Array.isArray(value.hosts) ? value.hosts.map((host) => String(host)) : [],
  };
}

/** @param {any} value @returns {Site[]} */
function normalizeSites(value) {
  if (!Array.isArray(value)) return [];
  /** @type {Site[]} */
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const pattern = typeof item === 'string' ? item : String(item?.pattern ?? '');
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push({
      pattern,
      granted: item && typeof item === 'object' ? item.granted !== false : true,
    });
  }
  return out;
}

/** @param {any} value @returns {CurrentSite|null} */
function normalizeCurrentSite(value) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string' || !value.url) return null;
  return {
    url: value.url,
    pattern: typeof value.pattern === 'string' && value.pattern ? value.pattern : null,
    allowed: value.allowed === true,
  };
}

/** @param {any} value @returns {Session|null} */
function normalizeSession(value) {
  if (!value || typeof value !== 'object') return null;
  const mode = Object.values(SESSION_MODE).includes(value.mode) ? value.mode : null;
  if (!mode) return null;
  return {
    tabId: toTabId(value.tabId),
    mode,
    scenarioId: typeof value.scenarioId === 'string' ? value.scenarioId : null,
    scenarioName: typeof value.scenarioName === 'string' ? value.scenarioName : '',
    startedAt: Number(value.startedAt) || 0,
    recorded: toCount(value.recorded),
    hits: toCount(value.hits),
    misses: toCount(value.misses),
    skipped: toCount(value.skipped),
    missReasons: normalizeMissReasons(value.missReasons),
    diagnostics: normalizeDiagnostics(value.diagnostics),
    error: value.error ? String(value.error) : null,
  };
}

/** @param {unknown} value @returns {Record<string, number>} */
function normalizeMissReasons(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [reason, count] of Object.entries(value)) {
    const number = toCount(count);
    if (number > 0) out[String(reason)] = number;
  }
  return out;
}

/** @param {unknown} value */
function normalizeDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object' && typeof item.url === 'string')
    .slice(-10)
    .map((item) => ({
      method: String(item.method ?? 'GET').toUpperCase(),
      url: String(item.url),
      reason: String(item.reason ?? 'no-recording'),
      sameUrl: toCount(item.sameUrl),
      samePath: toCount(item.samePath),
      at: Number(item.at) || 0,
    }));
}

/** @param {unknown} value @returns {number|null} */
function toTabId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

/** @param {unknown} value */
function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

/* ------------------------------------------------------------------ */
/* Broadcasts                                                          */
/* ------------------------------------------------------------------ */

function subscribeBroadcasts() {
  state.unsubscribe = onBroadcast((message) => {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case BROADCAST.SESSION_UPDATE:
        applySessionUpdate(message);
        break;
      case BROADCAST.SITES_UPDATE:
        applySitesUpdate(message);
        break;
      case BROADCAST.TOAST:
        handleToast(message);
        break;
      case BROADCAST.FEED_EVENT:
        // Feed events are consumed by the in-page overlay; counters arrive
        // through session.update instead.
        break;
      default:
        break;
    }
  });
}

/** @param {any} message */
function applySessionUpdate(message) {
  if (!('session' in message)) return;

  const raw = message.session;
  // The service worker puts `tabId` in the session payload and (for live
  // updates) on the message itself; `session: null` stop broadcasts carry no
  // tab, so those are confirmed against this tab with SESSION_GET.
  const explicitTabId = toTabId(message.tabId) ?? toTabId(raw?.tabId);
  if (explicitTabId != null) {
    if (state.tabId == null || explicitTabId !== state.tabId) return;
  }

  const incoming = normalizeSession(raw);

  if (!incoming) {
    if (!state.session) return;
    if (explicitTabId == null) {
      void confirmSessionStopped();
      return;
    }
    clearShownSession();
    return;
  }

  // Without any tab marker, only adopt updates that clearly refer to the
  // session this popup is already showing.
  if (
    explicitTabId == null &&
    state.session &&
    (state.session.startedAt !== incoming.startedAt || state.session.scenarioId !== incoming.scenarioId)
  ) {
    return;
  }

  const structural =
    !state.session ||
    state.session.mode !== incoming.mode ||
    state.session.scenarioId !== incoming.scenarioId ||
    state.session.startedAt !== incoming.startedAt;

  state.session = incoming;
  if (structural) {
    renderAll();
    return;
  }

  // Targeted updates only: keep the card, buttons and inputs untouched.
  updateSessionBadge(incoming);
  updateSessionCounters(incoming);
  updateSessionScenarioLabel(incoming);
  updateSessionError(incoming);
}

/** Ask the service worker whether this tab still has a session after a stop broadcast. */
async function confirmSessionStopped() {
  if (state.tabId == null) return;
  try {
    const response = await send(MSG.SESSION_GET, { tabId: state.tabId });
    const session = normalizeSession(response?.session);
    if (!session) {
      clearShownSession();
      return;
    }
    // Another tab stopped: if this tab's session is still running, show it.
    if (!state.session || state.session.startedAt !== session.startedAt) {
      state.session = session;
      renderAll();
    }
  } catch {
    /* keep the current view if the background is unavailable */
  }
}

function clearShownSession() {
  state.session = null;
  state.pendingDeleteId = null;
  state.showDiagnostics = false;
  stopTimer();
  renderAll();
}

/** @param {any} message */
function applySitesUpdate(message) {
  if (!Array.isArray(message.sites)) return;
  state.sites = normalizeSites(message.sites);
  if (state.currentSite?.url) {
    state.currentSite = {
      ...state.currentSite,
      allowed: isUrlAllowed(state.currentSite.url, state.sites),
    };
  }
  renderSiteCard();
  renderStart();
}

/** @param {any} message */
function handleToast(message) {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) return;
  if (message.level === 'error') showError(text);
  else showNotice(text);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderAll() {
  renderVersion();
  renderSiteCard();
  renderScenarios();
  renderSession();
  renderStart();
  renderFooter();
}

function renderVersion() {
  if (!state.version) {
    dom.versionChip.hidden = true;
    return;
  }
  dom.versionChip.textContent = `v${state.version.replace(/^v/i, '')}`;
  dom.versionChip.hidden = false;
}

function renderSiteCard() {
  const body = dom.siteBody;
  const status = dom.siteStatus;
  body.replaceChildren();
  setBadge(status, 'Checking…', 'badge badge-neutral');

  if (state.loadError) {
    setBadge(status, 'Unavailable', 'badge badge-warn');
    body.append(el('p', { class: 'site-message' }, 'Could not read the recording state for this tab. See the error above.'));
    return;
  }

  if (state.tabId == null) {
    setBadge(status, 'No tab', 'badge badge-warn');
    body.append(el('p', { class: 'site-message' }, 'No active tab. Open the popup from the tab you want to record.'));
    return;
  }

  const site = state.currentSite;
  if (!site || !isHttpUrl(site.url)) {
    setBadge(status, 'Unavailable', 'badge badge-warn');
    body.append(
      el('p', { class: 'site-message' }, 'Open a normal web page to record.'),
      el('p', { class: 'site-pattern' }, 'Chrome internal pages (chrome://, the Web Store, extension pages) cannot be recorded.'),
    );
    return;
  }

  const host = hostOf(site.url) || site.url;
  if (site.allowed) {
    setBadge(status, 'Enabled', 'badge badge-ok');
    const pattern = site.pattern || safePatternForUrl(site.url) || 'matching site pattern';
    body.append(
      el('p', { class: 'site-host' }, `Enabled on ${host}`),
      el('p', { class: 'site-pattern' }, el('code', {}, pattern)),
    );
    return;
  }

  setBadge(status, 'Off', 'badge badge-warn');
  body.append(
    el('p', { class: 'site-host' }, host),
    el('p', { class: 'site-message' }, 'Recording and replay are disabled until you enable this site.'),
  );
  const enableButton = createButton({
    className: 'btn btn-primary btn-block',
    label: 'Enable on this site',
    testid: 'enable-site',
    title: `Allow API Recorder to record and replay on ${host}`,
    onClick: (button) => enableSite(button),
  });
  body.append(enableButton);
}

/** @returns {string} the current tab's host, or '' on non-http pages */
function currentTabHost() {
  if (!state.currentSite || !isHttpUrl(state.currentSite.url ?? '')) return '';
  return hostOf(state.currentSite.url);
}

/** @returns {Scenario[]} scenarios visible under the current host filter */
function visibleScenarios() {
  const host = currentTabHost();
  if (state.hostFilter && host) return filterScenariosByHost(state.scenarios, host);
  return state.scenarios;
}

/** Move the selection into the visible set when the filter hides it. */
function ensureSelectionVisible() {
  const visible = visibleScenarios();
  if (visible.some((scenario) => scenario.id === state.selectedScenarioId)) return;
  state.selectedScenarioId = visible[0]?.id ?? null;
  persistSelection();
}

function onHostFilterToggle() {
  state.hostFilter = !state.hostFilter;
  ensureSelectionVisible();
  renderScenarios();
  renderStart();
}

function renderScenarios() {
  // Never rebuild the select while the user has it open: it would close the
  // dropdown under their cursor. Re-run the render on blur instead.
  if (document.activeElement === dom.scenarioSelect) {
    state.pendingScenarioRender = true;
    return;
  }
  state.pendingScenarioRender = false;

  const host = currentTabHost();
  const filtering = state.hostFilter && host !== '';
  const scenarios = filtering ? filterScenariosByHost(state.scenarios, host) : state.scenarios;
  const total = state.scenarios.length;
  const select = dom.scenarioSelect;
  const hasScenarios = scenarios.length > 0;

  if (!hasScenarios) state.selectedScenarioId = null;
  else if (!scenarios.some((scenario) => scenario.id === state.selectedScenarioId)) {
    state.selectedScenarioId = scenarios[0].id;
    persistSelection();
  }

  select.replaceChildren();
  if (!hasScenarios) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = filtering && total > 0 ? 'No scenarios for this host' : 'No scenarios yet';
    select.append(placeholder);
  } else {
    for (const scenario of scenarios) {
      const option = document.createElement('option');
      option.value = scenario.id;
      option.textContent = `${scenario.name} (${scenario.entryCount})`;
      select.append(option);
    }
    select.value = state.selectedScenarioId ?? '';
  }
  select.disabled = !hasScenarios;

  dom.scenarioEmpty.hidden = hasScenarios;
  dom.scenarioEmpty.textContent =
    !hasScenarios && filtering && total > 0
      ? `No scenarios recorded requests on ${host} yet. Create one below, or switch to “All”.`
      : 'No scenarios yet. Create one below to start recording.';

  dom.scenarioCount.textContent = String(scenarios.length);
  dom.scenarioCount.title = filtering ? `${scenarios.length} of ${total} scenarios` : 'Total scenarios';

  dom.hostFilterToggle.disabled = host === '';
  dom.hostFilterToggle.title =
    host === '' ? 'Host filtering needs an http(s) page' : 'Toggle between this host and all scenarios';
  dom.hostFilterToggle.textContent = state.hostFilter ? 'This host' : 'All';
  dom.hostFilterToggle.setAttribute('aria-pressed', String(state.hostFilter));

  const hint = filtering && total > 0 && scenarios.length < total;
  dom.scenarioFilterHint.hidden = !hint;
  if (hint) {
    dom.scenarioFilterHint.textContent = `Showing the ${scenarios.length} scenario${
      scenarios.length === 1 ? '' : 's'
    } that recorded requests on ${host}. Switch to “All” to see everything.`;
  }

  // Do not destroy a rename form the user is actively typing into.
  if (!isRenameInputFocused()) renderScenarioRow();
}

function renderScenarioRow() {
  const row = dom.scenarioRow;
  row.replaceChildren();
  const scenario = getSelectedScenario();
  if (!scenario) {
    row.hidden = true;
    return;
  }
  row.hidden = false;

  if (state.renamingId === scenario.id) {
    renderRenameForm(row, scenario);
    return;
  }

  const count = scenario.entryCount;
  const info = el(
    'div',
    { class: 'scenario-info' },
    el('span', { class: 'scenario-name', title: scenario.name }, scenario.name),
    el('span', { class: 'scenario-meta' }, `${count} request${count === 1 ? '' : 's'} recorded`),
  );

  const renameButton = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'data-testid': 'rename-scenario',
      title: `Rename “${scenario.name}”`,
      'aria-label': `Rename scenario ${scenario.name}`,
    },
    icon('M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'),
  );
  renameButton.addEventListener('click', () => beginRename(scenario));

  const confirming = state.pendingDeleteId === scenario.id;
  const deleteButton = el('button', {
    class: `icon-btn${confirming ? ' is-confirming' : ''}`,
    type: 'button',
    'data-testid': 'delete-scenario',
    title: confirming ? 'Click again to delete permanently' : `Delete “${scenario.name}”`,
    'aria-label': confirming ? `Confirm delete scenario ${scenario.name}` : `Delete scenario ${scenario.name}`,
  });
  if (confirming) {
    deleteButton.textContent = 'Confirm delete?';
  } else {
    deleteButton.append(icon('M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'));
  }
  deleteButton.addEventListener('click', () => onDeleteClicked(scenario));

  const actions = el('div', { class: 'scenario-actions' }, renameButton, deleteButton);
  row.append(info, actions);
}

/**
 * @param {HTMLElement} row
 * @param {Scenario} scenario
 */
function renderRenameForm(row, scenario) {
  const input = el('input', {
    class: 'input',
    type: 'text',
    value: scenario.name,
    maxlength: String(LIMITS.MAX_SCENARIO_NAME),
    'data-testid': 'rename-scenario-name',
    'aria-label': `New name for scenario ${scenario.name}`,
  });
  const saveButton = el('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Save');
  const cancelButton = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Cancel');
  const form = el('form', { class: 'rename-form', autocomplete: 'off', novalidate: '' }, input, saveButton, cancelButton);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveRename(scenario, input.value, saveButton);
  });
  cancelButton.addEventListener('click', () => {
    state.renamingId = null;
    renderScenarios();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      state.renamingId = null;
      renderScenarios();
    }
  });

  row.append(form);
  queueMicrotask(() => {
    if (!input.isConnected) return;
    input.focus();
    input.select();
  });
}

function renderSession() {
  const session = state.session;
  if (!session) {
    dom.sessionCard.hidden = true;
    dom.sessionCard.removeAttribute('data-mode');
    dom.sessionDiagnostics.hidden = true;
    state.showDiagnostics = false;
    stopTimer();
    return;
  }

  dom.sessionCard.hidden = false;
  dom.sessionCard.dataset.mode = session.mode;
  updateSessionBadge(session);
  updateSessionScenarioLabel(session);
  updateSessionCounters(session);
  updateSessionError(session);
  renderSessionActions(session);
  startTimer(session.startedAt);
}

/** @param {Session} session */
function renderSessionActions(session) {
  const actions = dom.sessionActions;
  actions.replaceChildren();

  if (session.mode === SESSION_MODE.RECORDING) {
    actions.append(
      createButton({
        className: 'btn btn-danger btn-block',
        label: 'Stop recording',
        testid: 'stop-session',
        title: 'Stop recording and keep everything captured so far',
        onClick: (button) => stopSession(button),
      }),
    );
    return;
  }

  if (session.mode === SESSION_MODE.REPLAY) {
    actions.append(
      createButton({
        className: 'btn btn-ghost',
        label: 'Go live',
        testid: 'toggle-live',
        title: 'Send requests to the real network (live mode)',
        onClick: (button) => toggleLive(button, true),
      }),
      createButton({
        className: 'btn btn-danger',
        label: 'Stop replay',
        testid: 'stop-session',
        title: 'Stop replaying recorded requests',
        onClick: (button) => stopSession(button),
      }),
    );
    return;
  }

  actions.append(
    createButton({
      className: 'btn btn-replay',
      label: 'Resume replay',
      testid: 'toggle-live',
      title: 'Resume replaying recorded responses',
      onClick: (button) => toggleLive(button, false),
    }),
    createButton({
      className: 'btn btn-danger',
      label: 'Stop',
      testid: 'stop-session',
      title: 'Stop the session',
      onClick: (button) => stopSession(button),
    }),
  );
}

function renderStart() {
  const visible = state.loaded && !state.session;
  dom.startCard.hidden = !visible;
  if (!visible) return;

  const scenario = getSelectedScenario();
  const count = scenario?.entryCount ?? 0;
  const site = state.currentSite;
  const pageIsHttp = Boolean(site?.url && isHttpUrl(site.url));
  const siteAllowed = Boolean(site?.allowed) && pageIsHttp;
  const hasTab = state.tabId != null;
  const hasScenario = Boolean(scenario);

  dom.startScenario.textContent = scenario
    ? `${scenario.name} · ${count} request${count === 1 ? '' : 's'}`
    : 'No scenario selected';
  dom.startScenario.title = scenario
    ? `${scenario.name} — ${count} recorded request${count === 1 ? '' : 's'}`
    : 'Select or create a scenario';

  /** @type {string} */
  let hint = '';
  if (state.loadError) hint = 'Could not load the recording state.';
  else if (!hasTab) hint = 'No active tab.';
  else if (!pageIsHttp) hint = 'Open a normal web page to record.';
  else if (!siteAllowed) hint = 'Enable recording on this site first.';
  else if (!hasScenario) hint = 'Create or select a scenario first.';
  dom.startHint.textContent = hint;
  dom.startHint.hidden = !hint;

  const ready = hasTab && pageIsHttp && siteAllowed && hasScenario;
  const recordReason = disabledReason({ hasTab, pageIsHttp, siteAllowed, hasScenario, scenario, count, replay: false });
  const replayReason = disabledReason({ hasTab, pageIsHttp, siteAllowed, hasScenario, scenario, count, replay: true });

  dom.startRecording.disabled = !ready;
  dom.startRecording.title = recordReason;
  dom.startReplay.disabled = !ready || count === 0;
  dom.startReplay.title = replayReason;
}

/**
 * @param {{hasTab:boolean,pageIsHttp:boolean,siteAllowed:boolean,hasScenario:boolean,scenario:Scenario|null,count:number,replay:boolean}} context
 */
function disabledReason({ hasTab, pageIsHttp, siteAllowed, hasScenario, scenario, count, replay }) {
  let reason;
  if (state.loadError) reason = 'The recording state could not be loaded.';
  else if (!hasTab) reason = 'No active tab. Open the popup from a normal web page tab.';
  else if (!pageIsHttp) reason = 'Open a normal web page to record.';
  else if (!siteAllowed) reason = 'Enable recording on this site first.';
  else if (!hasScenario) reason = 'Create or select a scenario first.';
  else if (replay && count === 0) reason = 'No recorded requests in this scenario yet — record first, then replay.';
  else reason = replay
    ? `Replay recorded requests for “${scenario?.name ?? ''}”.`
    : `Record requests into “${scenario?.name ?? ''}”.`;
  return reason;
}

function renderFooter() {
  const count = state.scenarios.length;
  dom.footerCount.textContent = `${count} scenario${count === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ */
/* Session live updates (targeted)                                     */
/* ------------------------------------------------------------------ */

/** @param {Session} session */
function updateSessionBadge(session) {
  const style = MODE_STYLES[session.mode] ?? MODE_STYLES[SESSION_MODE.RECORDING];
  dom.sessionMode.className = style.className;
  dom.sessionMode.textContent = style.label;
}

/** @param {Session} session */
function updateSessionScenarioLabel(session) {
  const name = session.scenarioName || scenarioNameById(session.scenarioId) || 'Unknown scenario';
  dom.sessionScenario.textContent = `Scenario: ${name}`;
  dom.sessionScenario.title = name;
}

/** @param {Session} session */
function updateSessionCounters(session) {
  setText(dom.counterRecorded, session.recorded);
  setText(dom.counterHits, session.hits);
  setText(dom.counterMisses, session.misses);
  setText(dom.counterSkipped, session.skipped);
  updateSessionDiagnostics(session);
}

const REASON_LABELS = {
  'no-recording': 'no recording',
  'body-differs': 'body differs',
  'url-differs': 'URL differs',
  'ambiguous-body': 'ambiguous body',
  'ambiguous-url': 'ambiguous URL',
  'body-unavailable': 'body unavailable',
  'body-missing': 'body missing',
  'fulfill-error': 'replay error',
  'ws-no-recording': 'WebSocket not recorded',
  'ws-ambiguous-url': 'ambiguous WebSocket',
  'ws-frame-unmatched': 'unmatched WebSocket frame',
  'ws-frames-missing': 'WebSocket frames missing',
};

/** @param {string} reason */
function reasonLabel(reason) {
  return REASON_LABELS[reason] ?? String(reason ?? 'unknown');
}

function onDiagnosticsToggle() {
  state.showDiagnostics = !state.showDiagnostics;
  if (state.session) updateSessionDiagnostics(state.session);
}

/** @param {Session} session */
function updateSessionDiagnostics(session) {
  const diagnostics = session.diagnostics ?? [];
  const reasons = session.missReasons ?? {};
  const show =
    session.mode !== SESSION_MODE.RECORDING && session.misses > 0 && diagnostics.length > 0;

  if (!show) {
    dom.sessionDiagnostics.hidden = true;
    state.showDiagnostics = false;
    return;
  }

  dom.sessionDiagnostics.hidden = false;

  const reasonParts = Object.entries(reasons)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([reason, count]) => `${count} ${reasonLabel(reason)}`);
  setText(
    dom.diagnosticsSummary,
    `${session.misses} request${session.misses === 1 ? '' : 's'} stayed live${
      reasonParts.length ? ` · ${reasonParts.join(' · ')}` : ''
    }`,
  );

  dom.diagnosticsToggle.setAttribute('aria-expanded', String(state.showDiagnostics));
  dom.diagnosticsBody.hidden = !state.showDiagnostics;

  const hint = diagnosticsHint(diagnostics, state.settings);
  dom.diagnosticsHint.hidden = !hint;
  dom.diagnosticsHint.textContent = hint;

  dom.diagnosticsList.replaceChildren();
  for (const entry of [...diagnostics].slice(-6).reverse()) {
    dom.diagnosticsList.append(
      el(
        'li',
        { class: 'diagnostics-item', title: entry.url },
        el('span', { class: 'diagnostics-method' }, entry.method),
        el('span', { class: 'diagnostics-url' }, shortUrl(entry.url) || entry.url),
        el('span', { class: 'diagnostics-reason' }, reasonLabel(entry.reason)),
      ),
    );
  }
}

/**
 * @param {Array<{reason:string,sameUrl:number,samePath:number}>} diagnostics
 * @param {{smartFallback?:boolean}} settings
 */
function diagnosticsHint(diagnostics, settings) {
  const reasons = new Set(diagnostics.map((entry) => entry.reason));
  if (reasons.has('ambiguous-body')) {
    return 'Several recordings share this URL with different request bodies, so matching was refused. Delete the extra variants in Settings or re-record this scenario.';
  }
  if (reasons.has('ambiguous-url')) {
    return 'Several recordings share this endpoint with different URLs, so matching was refused. Delete the extra variants in Settings or re-record this scenario.';
  }
  if (reasons.has('body-differs') || reasons.has('url-differs')) {
    return settings?.smartFallback === false
      ? 'Enable “Smart fallback matching” in Settings to replay recordings with a similar URL/body.'
      : 'A similar recording exists but is ambiguous. Edit the recorded payload or re-record this scenario.';
  }
  if (reasons.has('body-unavailable')) {
    return 'Chrome did not expose the request body for these requests. Enable “Smart fallback matching” in Settings or re-record the scenario.';
  }
  if (reasons.has('body-missing')) {
    return 'The stored response body is missing. Re-record this scenario.';
  }
  if (reasons.has('fulfill-error')) {
    return 'The recorded response could not be returned. Reload the extension and try again.';
  }
  if (reasons.has('ws-ambiguous-url')) {
    return 'Several recorded WebSockets share this endpoint, so replay was refused. Delete the extra variants in Settings or re-record the scenario.';
  }
  if (reasons.has('ws-frame-unmatched')) {
    return 'The page sent WebSocket frames that have no recorded reply. Reload the page so the socket reconnects, or re-record this scenario.';
  }
  if (reasons.has('ws-frames-missing')) {
    return 'The recorded WebSocket frames are missing from storage. Re-record this scenario.';
  }
  return 'These requests have no recording in this scenario. Record them again, or check the recorded URLs in Settings.';
}

/** @param {Session} session */
function updateSessionError(session) {
  if (!session.error) {
    dom.sessionError.hidden = true;
    dom.sessionError.textContent = '';
    return;
  }
  dom.sessionError.textContent = `Session error: ${session.error}`;
  dom.sessionError.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Scenario actions                                                    */
/* ------------------------------------------------------------------ */

/** @param {Event} event */
async function onCreateScenario(event) {
  event.preventDefault();
  hideFieldError(dom.scenarioFieldError);
  hideError();

  let name;
  try {
    name = normalizeScenarioName(dom.newScenarioName.value);
  } catch (error) {
    showFieldError(dom.scenarioFieldError, errorMessage(error, 'Give the scenario a name.'));
    dom.newScenarioName.focus();
    return;
  }

  const button = dom.createScenario;
  setBusy(button, true);
  try {
    const response = await send(MSG.SCENARIO_CREATE, { name, host: currentTabHost() || undefined });
    const scenario = response?.scenario ? normalizeScenario(response.scenario) : null;
    if (!scenario) throw new Error('The scenario was created but no scenario data came back.');

    state.scenarios = state.scenarios.some((item) => item.id === scenario.id)
      ? state.scenarios.map((item) => (item.id === scenario.id ? scenario : item))
      : [...state.scenarios, scenario];
    state.selectedScenarioId = scenario.id;
    state.pendingDeleteId = null;
    state.renamingId = null;
    persistSelection();

    dom.newScenarioName.value = '';
    hideFieldError(dom.scenarioFieldError);
    renderScenarios();
    renderStart();
    renderFooter();
    showNotice(`Created “${scenario.name}”.`);
  } catch (error) {
    showError(errorMessage(error, 'Could not create the scenario.'));
  } finally {
    setBusy(button, false);
  }
}

/** @param {Scenario} scenario */
function beginRename(scenario) {
  state.renamingId = scenario.id;
  state.pendingDeleteId = null;
  clearTimeout(state.deleteTimer);
  renderScenarioRow();
}

/**
 * @param {Scenario} scenario
 * @param {string} rawName
 * @param {HTMLButtonElement} button
 */
async function saveRename(scenario, rawName, button) {
  hideError();
  let name;
  try {
    name = normalizeScenarioName(rawName);
  } catch (error) {
    showError(errorMessage(error, 'Give the scenario a name.'));
    return;
  }

  if (name === scenario.name) {
    state.renamingId = null;
    renderScenarios();
    return;
  }

  setBusy(button, true);
  try {
    const response = await send(MSG.SCENARIO_RENAME, { id: scenario.id, name });
    const updated = response?.scenario;
    state.scenarios = state.scenarios.map((item) =>
      item.id === scenario.id
        ? { ...item, name: typeof updated?.name === 'string' ? updated.name : name, updatedAt: Number(updated?.updatedAt) || Date.now() }
        : item,
    );
    state.renamingId = null;
    renderScenarios();
    renderStart();
    showNotice('Scenario renamed.');
  } catch (error) {
    showError(errorMessage(error, 'Could not rename the scenario.'));
  } finally {
    if (button.isConnected) setBusy(button, false);
  }
}

/** @param {Scenario} scenario */
function onDeleteClicked(scenario) {
  if (state.pendingDeleteId !== scenario.id) {
    state.pendingDeleteId = scenario.id;
    clearTimeout(state.deleteTimer);
    state.deleteTimer = setTimeout(() => {
      state.pendingDeleteId = null;
      if (state.loaded) renderScenarioRow();
    }, DELETE_CONFIRM_MS);
    renderScenarioRow();
    showNotice('Press “Confirm delete?” again to delete this scenario.');
    return;
  }

  clearTimeout(state.deleteTimer);
  state.pendingDeleteId = null;
  deleteScenario(scenario);
}

/** @param {Scenario} scenario */
async function deleteScenario(scenario) {
  hideError();
  const button = dom.scenarioRow.querySelector('[data-testid="delete-scenario"]');
  if (button) setBusy(/** @type {HTMLButtonElement} */ (button), true);
  try {
    await send(MSG.SCENARIO_DELETE, { id: scenario.id });
    state.scenarios = state.scenarios.filter((item) => item.id !== scenario.id);
    if (state.selectedScenarioId === scenario.id) {
      state.selectedScenarioId = state.scenarios[0]?.id ?? null;
      persistSelection();
    }
    if (state.renamingId === scenario.id) state.renamingId = null;
    renderScenarios();
    renderStart();
    renderFooter();
    showNotice(`Deleted “${scenario.name}”.`);
  } catch (error) {
    showError(errorMessage(error, 'Could not delete the scenario.'));
  } finally {
    if (button?.isConnected) setBusy(/** @type {HTMLButtonElement} */ (button), false);
  }
}

/** @param {Event} event */
function onScenarioSelectionChange(event) {
  const select = /** @type {HTMLSelectElement} */ (event.currentTarget);
  state.selectedScenarioId = select.value || null;
  state.pendingDeleteId = null;
  clearTimeout(state.deleteTimer);
  persistSelection();
  renderScenarioRow();
  renderStart();
}

function onScenarioSelectBlur() {
  if (state.pendingScenarioRender) renderScenarios();
}

/** Is the inline rename input currently focused (so re-renders must not replace it)? */
function isRenameInputFocused() {
  const active = document.activeElement;
  return Boolean(
    state.renamingId &&
      active &&
      typeof active.getAttribute === 'function' &&
      active.getAttribute('data-testid') === 'rename-scenario-name',
  );
}

/* ------------------------------------------------------------------ */
/* Site permission                                                     */
/* ------------------------------------------------------------------ */

/** @param {HTMLButtonElement} button */
async function enableSite(button) {
  hideError();
  const site = state.currentSite;
  if (!site?.url || !isHttpUrl(site.url)) {
    showError('Open a normal web page to enable recording.');
    return;
  }

  let pattern;
  try {
    pattern = patternForTabUrl(site.url);
  } catch (error) {
    showError(errorMessage(error, 'This page cannot be enabled.'));
    return;
  }

  setBusy(button, true);
  try {
    // chrome.permissions.request must run inside the user gesture — it is the
    // first async call in this handler, before any other await.
    const granted = await requestOrigins([pattern]);
    if (!granted) {
      showError('Chrome did not grant access to this site. Click “Enable on this site” to try again.');
      return;
    }

    const response = await send(MSG.SITES_ADD, { pattern });
    if (Array.isArray(response?.sites)) state.sites = normalizeSites(response.sites);
    if (state.currentSite?.url) {
      // SITES_ADD succeeded, so the pattern is allow-listed: reflect that
      // immediately, then let STATE_GET confirm the authoritative values.
      state.currentSite = {
        ...state.currentSite,
        allowed: true,
        pattern: state.currentSite.pattern ?? pattern,
      };
      renderSiteCard();
      renderStart();
    }

    await refreshState();
    showNotice(`Enabled on ${hostOf(site.url) || 'this site'}.`);
  } catch (error) {
    showError(errorMessage(error, 'Could not enable this site.'));
  } finally {
    if (button.isConnected) setBusy(button, false);
  }
}

/** @param {string[]} origins */
function requestOrigins(origins) {
  if (!chrome?.permissions?.request) {
    return Promise.reject(new Error('The permissions API is unavailable in this browser.'));
  }
  try {
    return Promise.resolve(chrome.permissions.request({ origins }));
  } catch (error) {
    return Promise.reject(error);
  }
}

/* ------------------------------------------------------------------ */
/* Session actions                                                     */
/* ------------------------------------------------------------------ */

/**
 * @param {'recording'|'replay'} kind
 * @param {HTMLButtonElement} button
 */
async function beginSession(kind, button) {
  hideError();
  hideFieldError(dom.scenarioFieldError);
  const scenario = getSelectedScenario();
  if (!scenario) {
    showError('Select or create a scenario first.');
    return;
  }
  if (state.tabId == null) {
    showError('No active tab to record. Open the popup from a normal web page tab.');
    return;
  }
  if (!state.currentSite?.allowed || !isHttpUrl(state.currentSite?.url ?? '')) {
    showError('Enable recording on this site first.');
    return;
  }

  setBusy(button, true);
  try {
    const type = kind === 'replay' ? MSG.START_REPLAY : MSG.START_RECORDING;
    const response = await send(type, { tabId: state.tabId, scenarioId: scenario.id });
    const session = normalizeSession(response?.session);
    if (!session) throw new Error('The session could not be started.');
    state.session = session;
    state.pendingDeleteId = null;
    renderSession();
    renderStart();
    showNotice(
      kind === 'replay'
        ? 'Replay started. Reload the page if WebSocket connections were already open.'
        : 'Recording started.',
    );
  } catch (error) {
    showError(errorMessage(error, `Could not start ${kind === 'replay' ? 'replay' : 'recording'}.`));
  } finally {
    if (button.isConnected) setBusy(button, false);
    renderStart();
  }
}

/** @param {HTMLButtonElement} button */
async function stopSession(button) {
  hideError();
  setBusy(button, true);
  try {
    const response = await send(MSG.STOP_SESSION, { tabId: state.tabId });
    state.session = normalizeSession(response?.session);
    state.pendingDeleteId = null;
    renderSession();
    renderStart();
    showNotice('Session stopped.');
  } catch (error) {
    showError(errorMessage(error, 'Could not stop the session.'));
  } finally {
    if (button.isConnected) setBusy(button, false);
  }
}

/**
 * @param {HTMLButtonElement} button
 * @param {boolean} live
 */
async function toggleLive(button, live) {
  hideError();
  if (state.tabId == null) {
    showError('No active tab for this session.');
    return;
  }
  setBusy(button, true);
  try {
    const response = await send(MSG.SET_LIVE, { tabId: state.tabId, live });
    state.session = normalizeSession(response?.session) ?? state.session;
    renderSession();
    renderStart();
    showNotice(live ? 'Live mode on — requests go to the real network.' : 'Replay resumed.');
  } catch (error) {
    showError(errorMessage(error, live ? 'Could not switch to live mode.' : 'Could not resume replay.'));
  } finally {
    if (button.isConnected) setBusy(button, false);
  }
}

/* ------------------------------------------------------------------ */
/* Timer                                                               */
/* ------------------------------------------------------------------ */

/** @param {number} startedAt */
function startTimer(startedAt) {
  stopTimer();
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    dom.sessionTimer.textContent = '--:--';
    return;
  }
  const update = () => {
    dom.sessionTimer.textContent = formatElapsed(Date.now() - startedAt);
  };
  update();
  state.timerId = window.setInterval(update, 1000);
}

function stopTimer() {
  if (state.timerId) {
    window.clearInterval(state.timerId);
    state.timerId = 0;
  }
}

/** @param {number} elapsedMs */
function formatElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

async function openSettings() {
  try {
    if (!chrome?.runtime?.openOptionsPage) throw new Error('Options page unavailable.');
    await chrome.runtime.openOptionsPage();
  } catch {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') });
    } catch {
      showError('Could not open the settings page.');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Selection persistence                                               */
/* ------------------------------------------------------------------ */

function readStoredScenarioId() {
  try {
    return localStorage.getItem(LAST_SCENARIO_KEY);
  } catch {
    return null;
  }
}

function persistSelection() {
  try {
    if (state.selectedScenarioId) localStorage.setItem(LAST_SCENARIO_KEY, state.selectedScenarioId);
    else localStorage.removeItem(LAST_SCENARIO_KEY);
  } catch {
    /* localStorage may be unavailable; selection just will not persist */
  }
}

/** @returns {Scenario|null} */
function getSelectedScenario() {
  return state.scenarios.find((scenario) => scenario.id === state.selectedScenarioId) ?? null;
}

/** @param {string|null} id */
function scenarioNameById(id) {
  if (!id) return '';
  return state.scenarios.find((scenario) => scenario.id === id)?.name ?? '';
}

/** @param {string} url @param {Site[]} sites */
function isUrlAllowed(url, sites) {
  return sites.some((site) => site.granted !== false && matchesPattern(site.pattern, url));
}

/** @param {string} url */
function safePatternForUrl(url) {
  try {
    return patternForTabUrl(url);
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

/** @param {unknown} error @param {string} fallback */
function errorMessage(error, fallback) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim() || fallback;
}

/** @param {string} message */
function showError(message) {
  dom.errorText.textContent = message;
  dom.errorBanner.hidden = false;
  hideNotice();
}

function hideError() {
  dom.errorBanner.hidden = true;
  dom.errorText.textContent = '';
}

/** @param {string} message */
function showNotice(message) {
  dom.notice.textContent = message;
  dom.notice.hidden = false;
  window.clearTimeout(state.noticeTimer);
  state.noticeTimer = window.setTimeout(() => {
    dom.notice.hidden = true;
    dom.notice.textContent = '';
  }, NOTICE_MS);
}

function hideNotice() {
  window.clearTimeout(state.noticeTimer);
  dom.notice.hidden = true;
  dom.notice.textContent = '';
}

/** @param {HTMLElement} node @param {string} message */
function showFieldError(node, message) {
  node.textContent = message;
  node.hidden = false;
}

/** @param {HTMLElement} node */
function hideFieldError(node) {
  node.hidden = true;
  node.textContent = '';
}

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Tiny hyperscript helper. Text is always assigned with textContent.
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...any} children
 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * @param {{className:string,label:string,testid?:string,title?:string,onClick:(button:HTMLButtonElement)=>void}} options
 */
function createButton({ className, label, testid, title, onClick }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  if (testid) button.setAttribute('data-testid', testid);
  if (title) button.title = title;
  button.addEventListener('click', () => onClick(button));
  return button;
}

/**
 * Build a stroke-only SVG icon from path definitions.
 * @param {...string} paths
 */
function icon(...paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const definition of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', definition);
    svg.append(path);
  }
  return svg;
}

/** @param {HTMLElement} node @param {string} label @param {string} className */
function setBadge(node, label, className) {
  node.textContent = label;
  node.className = className;
}

/** @param {HTMLElement} node @param {number} value */
function setText(node, value) {
  const next = String(value);
  if (node.textContent !== next) node.textContent = next;
}

/**
 * @param {HTMLButtonElement} button
 * @param {boolean} busy
 */
function setBusy(button, busy) {
  if (!button) return;
  if (busy) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

init();
