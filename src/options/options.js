/**
 * API Recorder options page.
 *
 * Manages the site allowlist (with real host-permission requests), recording
 * settings, and the recorded scenarios. Runs in a normal browser tab, so it
 * talks to the service worker over the shared message API instead of direct
 * storage access.
 */
import { BROADCAST, DEFAULT_SETTINGS, LIMITS, MSG } from '../shared/constants.js';
import { onBroadcast, send } from '../shared/messages.js';
import { normalizeSiteInput } from '../shared/patterns.js';
import { shortUrl } from '../shared/url.js';
import { normalizeScenarioName } from '../shared/scenarios.js';

const MB = 1024 * 1024;
const MIN_MB = 0.01;
const MAX_MB = 200;
const DELETE_CONFIRM_MS = 5000;
const STATUS_TIMEOUT_MS = 4000;
const SAVED_TIMEOUT_MS = 2400;
const ENTRIES_LIMIT = 200;
const PREVIEW_CHARS = 240;
const ALL_SITES_PATTERN = '*://*/*';

/** @typedef {{pattern:string,granted:boolean}} Site */
/** @typedef {{id:string,name:string,createdAt:number,updatedAt:number,entryCount:number}} Scenario */

const state = {
  loaded: false,
  version: '',

  /** @type {Site[]} */
  sites: [],
  /** @type {Scenario[]} */
  scenarios: [],
  settings: { ...DEFAULT_SETTINGS },

  renamingId: null,
  pendingDeleteId: null,
  deleteTimer: 0,
  entriesScenarioId: null,
  /** @type {Scenario|null} */
  entriesScenario: null,
  /** @type {any[]} */
  entries: [],
  entriesTotal: 0,
  /** @type {null|{scenarioId:string, entry:any, payload:any, editable:boolean, hasOriginal:boolean}} */
  editing: null,
  statusTimer: 0,
  savedTimer: 0,
  unsubscribe: null,
};

/** @type {Record<string, any>} */
const dom = {};

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function init() {
  cacheDom();
  wireEvents();
  subscribeBroadcasts();
  window.addEventListener('pagehide', cleanup);
  loadState();
}

async function loadState() {
  try {
    const data = await send(MSG.STATE_GET);
    applyState(data);
    hideError();
  } catch (error) {
    state.loaded = true;
    showError(errorMessage(error, 'Could not load the extension state. Reload this page to try again.'));
    renderAll();
  }
}

/** @param {any} data */
function applyState(data) {
  state.loaded = true;
  state.sites = normalizeSites(data?.sites);
  state.scenarios = normalizeScenarios(data?.scenarios);
  state.settings = normalizeSettings(data?.settings);
  state.version = typeof data?.version === 'string' ? data.version : '';
  renderAll();
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
    out.push({ pattern, granted: item && typeof item === 'object' ? item.granted !== false : true });
  }
  return out;
}

/** @param {any} value @returns {Scenario[]} */
function normalizeScenarios(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item.id === 'string')
    .map((item) => {
      const createdAt = Number(item.createdAt) || 0;
      return {
        id: String(item.id),
        name: typeof item.name === 'string' ? item.name : String(item.name ?? ''),
        createdAt,
        updatedAt: Number(item.updatedAt) || createdAt,
        entryCount: toCount(item.entryCount),
      };
    });
}

/** @param {any} value */
function normalizeSettings(value) {
  const merged = { ...DEFAULT_SETTINGS, ...(value && typeof value === 'object' ? value : {}) };
  const bytes = Number(merged.maxBodyBytes);
  return {
    maxBodyBytes: Number.isFinite(bytes) && bytes > 0 ? bytes : DEFAULT_SETTINGS.maxBodyBytes,
    skipGraphql: merged.skipGraphql !== false,
    replayCookies: merged.replayCookies === true,
  };
}

/** @param {unknown} value */
function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function cacheDom() {
  const ids = [
    'version-chip',
    'error-banner',
    'error-text',
    'error-dismiss',
    'status-line',
    'sites-count',
    'sites-list',
    'sites-empty',
    'add-site-form',
    'site-input',
    'add-site',
    'site-field-error',
    'add-all-sites',
    'settings-form',
    'max-body-mb',
    'skip-graphql',
    'replay-cookies',
    'save-settings',
    'reset-settings',
    'settings-saved',
    'settings-field-error',
    'scenarios-count',
    'scenario-list',
    'scenarios-empty',
    'entries-panel',
    'entries-title',
    'entries-close',
    'entries-body',
    'entries-empty',
    'footer-version',
    'entry-editor',
    'entry-editor-form',
    'entry-editor-title',
    'entry-editor-meta',
    'entry-editor-request',
    'entry-editor-note',
    'entry-editor-hint',
    'entry-editor-error',
    'entry-editor-close',
    'entry-editor-cancel',
    'entry-editor-format',
    'entry-editor-restore',
    'entry-editor-save',
    'payload-editor',
  ];
  for (const id of ids) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Options markup is missing #${id}`);
    dom[toCamel(id)] = element;
  }
}

/** @param {string} id */
function toCamel(id) {
  return id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function wireEvents() {
  dom.errorDismiss.addEventListener('click', hideError);
  dom.addSiteForm.addEventListener('submit', onAddSite);
  dom.addAllSites.addEventListener('click', onAddAllSites);
  dom.settingsForm.addEventListener('submit', onSaveSettings);
  dom.resetSettings.addEventListener('click', onResetSettings);
  dom.entriesClose.addEventListener('click', closeEntries);

  dom.entryEditorForm.addEventListener('submit', onSavePayload);
  dom.entryEditorClose.addEventListener('click', closeEditor);
  dom.entryEditorCancel.addEventListener('click', closeEditor);
  dom.entryEditorRestore.addEventListener('click', onRestorePayload);
  dom.entryEditorFormat.addEventListener('click', onFormatPayload);
  dom.payloadEditor.addEventListener('input', updateEditorHint);
  dom.entryEditor.addEventListener('close', () => {
    state.editing = null;
    hideFieldError(dom.entryEditorError);
  });
  dom.entryEditor.addEventListener('click', (event) => {
    if (event.target === dom.entryEditor) closeEditor();
  });
}

function cleanup() {
  clearTimeout(state.deleteTimer);
  clearTimeout(state.statusTimer);
  clearTimeout(state.savedTimer);
  state.unsubscribe?.();
  state.unsubscribe = null;
}

function renderAll() {
  renderVersion();
  renderSites();
  renderSettings();
  renderScenarios();
}

function renderVersion() {
  const version = state.version ? `v${state.version.replace(/^v/i, '')}` : '';
  if (version) {
    dom.versionChip.textContent = version;
    dom.versionChip.hidden = false;
  } else {
    dom.versionChip.hidden = true;
  }
  dom.footerVersion.textContent = version ? `API Recorder ${version}` : 'API Recorder';
}

/* ------------------------------------------------------------------ */
/* Broadcasts                                                          */
/* ------------------------------------------------------------------ */

function subscribeBroadcasts() {
  state.unsubscribe = onBroadcast((message) => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === BROADCAST.SITES_UPDATE) {
      refreshSitesFromBroadcast(message);
      return;
    }
    if (message.type === BROADCAST.TOAST) {
      const text = typeof message.text === 'string' ? message.text.trim() : '';
      if (!text) return;
      if (message.level === 'error') showError(text);
      else showStatus(text);
    }
    // session.update / feed.event do not change anything this page renders.
  });
}

/** @param {any} message */
async function refreshSitesFromBroadcast(message) {
  if (Array.isArray(message.sites)) {
    state.sites = normalizeSites(message.sites);
    renderSites();
    return;
  }
  try {
    const response = await send(MSG.SITES_LIST);
    state.sites = normalizeSites(response?.sites);
    renderSites();
  } catch {
    /* a failed refresh keeps the previous list visible */
  }
}

/* ------------------------------------------------------------------ */
/* Sites                                                               */
/* ------------------------------------------------------------------ */

function renderSites() {
  dom.sitesList.replaceChildren();
  dom.sitesCount.textContent = String(state.sites.length);
  dom.sitesEmpty.hidden = state.sites.length > 0;

  state.sites.forEach((site, index) => {
    const granted = site.granted !== false;
    const badge = el(
      'span',
      { class: `site-badge ${granted ? 'site-badge-granted' : 'site-badge-lost'}` },
      el('span', { class: 'site-dot', 'aria-hidden': 'true' }),
      granted ? 'Granted' : 'Access lost — remove and re-add',
    );

    const removeButton = el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      'data-testid': `remove-site-${index}`,
      'aria-label': `Remove site ${site.pattern}`,
    });
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => removeSite(site, removeButton));

    const row = el(
      'li',
      { class: 'site-row' },
      el('code', { class: 'site-pattern', title: site.pattern }, site.pattern),
      badge,
      removeButton,
    );
    dom.sitesList.append(row);
  });
}

/** @param {Event} event */
async function onAddSite(event) {
  event.preventDefault();
  hideFieldError(dom.siteFieldError);
  hideError();

  let pattern;
  try {
    pattern = normalizeSiteInput(dom.siteInput.value);
  } catch (error) {
    showFieldError(dom.siteFieldError, errorMessage(error, 'Enter a site like example.com'));
    dom.siteInput.focus();
    return;
  }

  if (state.sites.some((site) => site.pattern === pattern)) {
    showFieldError(dom.siteFieldError, `“${pattern}” is already in the list.`);
    dom.siteInput.focus();
    return;
  }

  setBusy(dom.addSite, true);
  try {
    // The permission request must be triggered by the user gesture; it is the
    // first async call in this handler.
    const granted = await requestOrigins([pattern]);
    if (!granted) {
      showFieldError(dom.siteFieldError, 'Chrome did not grant access to this site. Nothing was added.');
      return;
    }

    const response = await send(MSG.SITES_ADD, { pattern });
    state.sites = normalizeSites(response?.sites ?? [...state.sites, { pattern, granted: true }]);
    dom.siteInput.value = '';
    renderSites();
    showStatus(`Added ${pattern}.`);
  } catch (error) {
    showError(errorMessage(error, 'Could not add the site.'));
  } finally {
    setBusy(dom.addSite, false);
  }
}

async function onAddAllSites() {
  hideError();
  hideFieldError(dom.siteFieldError);
  setBusy(dom.addAllSites, true);
  try {
    const granted = await requestAllSites();
    if (!granted) {
      showError('Chrome did not grant access to all sites. The allowlist was not changed.');
      return;
    }
    const response = await send(MSG.SITES_ADD, { pattern: ALL_SITES_PATTERN });
    state.sites = normalizeSites(
      response?.sites ?? [...state.sites, { pattern: ALL_SITES_PATTERN, granted: true }],
    );
    renderSites();
    showStatus('All http(s) sites are now allowed. Recording still only starts from the popup.');
  } catch (error) {
    showError(errorMessage(error, 'Could not add all sites.'));
  } finally {
    setBusy(dom.addAllSites, false);
  }
}

/**
 * Ask for every http(s) site. Chrome expands a scheme-wildcard request itself,
 * but some versions only accept the two expressly declared scheme patterns, so
 * fall back to those when the wildcard is rejected.
 * @returns {Promise<boolean>}
 */
async function requestAllSites() {
  try {
    return await requestOrigins([ALL_SITES_PATTERN]);
  } catch {
    return requestOrigins(['http://*/*', 'https://*/*']);
  }
}

/**
 * @param {Site} site
 * @param {HTMLButtonElement} button
 */
async function removeSite(site, button) {
  hideError();
  hideFieldError(dom.siteFieldError);
  setBusy(button, true);
  try {
    const response = await send(MSG.SITES_REMOVE, { pattern: site.pattern });
    state.sites = normalizeSites(response?.sites ?? state.sites.filter((item) => item.pattern !== site.pattern));
    renderSites();
    showStatus(`Removed ${site.pattern}.`);
  } catch (error) {
    showError(errorMessage(error, 'Could not remove the site.'));
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
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function renderSettings() {
  dom.maxBodyMb.value = formatMb(state.settings.maxBodyBytes);
  dom.skipGraphql.checked = state.settings.skipGraphql !== false;
  dom.replayCookies.checked = state.settings.replayCookies === true;
  hideFieldError(dom.settingsFieldError);
}

/** @param {Event} event */
async function onSaveSettings(event) {
  event.preventDefault();
  hideError();
  hideFieldError(dom.settingsFieldError);

  const raw = String(dom.maxBodyMb.value ?? '').trim();
  const megabytes = Number(raw);
  if (!raw || !Number.isFinite(megabytes) || megabytes < MIN_MB || megabytes > MAX_MB) {
    showFieldError(dom.settingsFieldError, `Enter a max response size between ${MIN_MB} and ${MAX_MB} MB.`);
    dom.maxBodyMb.focus();
    return;
  }

  const settings = {
    maxBodyBytes: Math.round(megabytes * MB),
    skipGraphql: dom.skipGraphql.checked,
    replayCookies: dom.replayCookies.checked,
  };
  const saved = await persistSettings(settings, dom.saveSettings);
  if (saved) showSaved('Settings saved');
}

async function onResetSettings() {
  hideError();
  hideFieldError(dom.settingsFieldError);
  const defaults = { ...DEFAULT_SETTINGS };
  const saved = await persistSettings(defaults, dom.resetSettings);
  if (saved) showSaved('Defaults restored');
}

/**
 * @param {{maxBodyBytes:number,skipGraphql:boolean,replayCookies:boolean}} settings
 * @param {HTMLButtonElement} button
 */
async function persistSettings(settings, button) {
  setBusy(button, true);
  try {
    const response = await send(MSG.SETTINGS_SET, { settings });
    state.settings = normalizeSettings(response?.settings ?? settings);
    renderSettings();
    return true;
  } catch (error) {
    showError(errorMessage(error, 'Could not save settings.'));
    return false;
  } finally {
    setBusy(button, false);
  }
}

/** @param {number} bytes */
function formatMb(bytes) {
  const megabytes = bytes / MB;
  if (!Number.isFinite(megabytes) || megabytes <= 0) return String(DEFAULT_SETTINGS.maxBodyBytes / MB);
  const clamped = Math.min(MAX_MB, Math.max(MIN_MB, megabytes));
  return String(Math.round(clamped * 100) / 100);
}

function showSaved(message) {
  dom.settingsSaved.textContent = message;
  dom.settingsSaved.hidden = false;
  clearTimeout(state.savedTimer);
  state.savedTimer = window.setTimeout(() => {
    dom.settingsSaved.hidden = true;
  }, SAVED_TIMEOUT_MS);
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

function renderScenarios() {
  dom.scenariosCount.textContent = String(state.scenarios.length);
  dom.scenariosEmpty.hidden = state.scenarios.length > 0;

  // Keep an actively edited rename form alive if something triggered a
  // re-render (for example a delete confirmation on another row).
  if (!isRenameInputFocused()) {
    dom.scenarioList.replaceChildren();
    for (const scenario of state.scenarios) {
      dom.scenarioList.append(renderScenarioRow(scenario));
    }

    if (state.entriesScenarioId && !state.scenarios.some((scenario) => scenario.id === state.entriesScenarioId)) {
      closeEntries();
    }
  }
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

/** @param {Scenario} scenario */
function renderScenarioRow(scenario) {
  const row = el('li', { class: 'scenario-row', 'data-scenario-id': scenario.id });

  if (state.renamingId === scenario.id) {
    row.append(renderRenameForm(scenario));
    return row;
  }

  const count = scenario.entryCount;
  const created = formatDate(scenario.createdAt);
  const meta = [`${count} request${count === 1 ? '' : 's'}`, created ? `created ${created}` : '']
    .filter(Boolean)
    .join(' · ');

  const main = el(
    'div',
    { class: 'scenario-main' },
    el('span', { class: 'scenario-name', title: scenario.name }, scenario.name),
    el('span', { class: 'scenario-meta' }, meta),
  );

  const isViewing = state.entriesScenarioId === scenario.id && !dom.entriesPanel.hidden;
  const viewButton = el(
    'button',
    {
      class: `btn btn-sm ${isViewing ? 'btn-secondary' : 'btn-ghost'}`,
      type: 'button',
      'aria-expanded': String(isViewing),
      'aria-label': `View requests for scenario ${scenario.name}`,
      'data-testid': `view-entries-${scenario.id}`,
    },
    isViewing ? 'Hide requests' : 'View requests',
  );
  viewButton.addEventListener('click', () => viewEntries(scenario, viewButton));

  const renameButton = el(
    'button',
    {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      'aria-label': `Rename scenario ${scenario.name}`,
    },
    'Rename',
  );
  renameButton.addEventListener('click', () => beginRename(scenario));

  const confirming = state.pendingDeleteId === scenario.id;
  const deleteButton = el(
    'button',
    {
      class: `btn btn-sm ${confirming ? 'btn-danger' : 'btn-ghost'}`,
      type: 'button',
      'aria-label': confirming ? `Confirm delete scenario ${scenario.name}` : `Delete scenario ${scenario.name}`,
    },
    confirming ? 'Confirm delete?' : 'Delete',
  );
  deleteButton.addEventListener('click', () => onDeleteClicked(scenario, deleteButton));

  const actions = el('div', { class: 'scenario-actions' }, viewButton, renameButton, deleteButton);
  row.append(main, actions);
  return row;
}

/** @param {Scenario} scenario */
function renderRenameForm(scenario) {
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

  queueMicrotask(() => {
    if (!input.isConnected) return;
    input.focus();
    input.select();
  });

  return form;
}

/** @param {Scenario} scenario */
function beginRename(scenario) {
  state.renamingId = scenario.id;
  state.pendingDeleteId = null;
  clearTimeout(state.deleteTimer);
  renderScenarios();
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
        ? {
            ...item,
            name: typeof updated?.name === 'string' ? updated.name : name,
            updatedAt: Number(updated?.updatedAt) || Date.now(),
          }
        : item,
    );
    state.renamingId = null;
    renderScenarios();
    showStatus('Scenario renamed.');
  } catch (error) {
    showError(errorMessage(error, 'Could not rename the scenario.'));
  } finally {
    if (button.isConnected) setBusy(button, false);
  }
}

/**
 * @param {Scenario} scenario
 * @param {HTMLButtonElement} button
 */
function onDeleteClicked(scenario, button) {
  if (state.pendingDeleteId !== scenario.id) {
    state.pendingDeleteId = scenario.id;
    clearTimeout(state.deleteTimer);
    state.deleteTimer = window.setTimeout(() => {
      state.pendingDeleteId = null;
      renderScenarios();
    }, DELETE_CONFIRM_MS);
    renderScenarios();
    showStatus(`Press “Confirm delete?” again to permanently delete “${scenario.name}”.`);
    return;
  }

  clearTimeout(state.deleteTimer);
  state.pendingDeleteId = null;
  deleteScenario(scenario, button);
}

/**
 * @param {Scenario} scenario
 * @param {HTMLButtonElement} button
 */
async function deleteScenario(scenario, button) {
  hideError();
  setBusy(button, true);
  try {
    await send(MSG.SCENARIO_DELETE, { id: scenario.id });
    // Update locally first so the row disappears even if the follow-up
    // refresh cannot reach the background, then re-read authoritative counts.
    state.scenarios = state.scenarios.filter((item) => item.id !== scenario.id);
    if (state.entriesScenarioId === scenario.id) closeEntries();
    if (state.renamingId === scenario.id) state.renamingId = null;
    renderScenarios();
    await refreshScenarios();
    showStatus(`Deleted “${scenario.name}” and its recorded requests.`);
  } catch (error) {
    showError(errorMessage(error, 'Could not delete the scenario.'));
  } finally {
    if (button.isConnected) setBusy(button, false);
  }
}

/**
 * Re-read scenario metadata after a destructive action so entry counts are
 * authoritative. Settings/sites are deliberately left untouched.
 */
async function refreshScenarios() {
  try {
    const data = await send(MSG.STATE_GET);
    state.scenarios = normalizeScenarios(data?.scenarios);
    if (typeof data?.version === 'string' && data.version) state.version = data.version;
    renderScenarios();
    renderVersion();
  } catch (error) {
    showError(errorMessage(error, 'Could not refresh scenarios.'));
  }
}

/* ------------------------------------------------------------------ */
/* Recorded entries                                                    */
/* ------------------------------------------------------------------ */

/**
 * @param {Scenario} scenario
 * @param {HTMLButtonElement} button
 */
async function viewEntries(scenario, button) {
  if (state.entriesScenarioId === scenario.id && !dom.entriesPanel.hidden) {
    closeEntries();
    renderScenarios();
    return;
  }

  hideError();
  setBusy(button, true);
  try {
    const response = await send(MSG.SCENARIO_ENTRIES, { scenarioId: scenario.id, limit: ENTRIES_LIMIT });
    const entries = Array.isArray(response?.entries) ? response.entries : [];
    const total = Number(response?.total);
    const entryCount = Number.isFinite(total) && total >= 0 ? total : scenario.entryCount;
    state.entriesScenarioId = scenario.id;
    if (entryCount !== scenario.entryCount) {
      state.scenarios = state.scenarios.map((item) =>
        item.id === scenario.id ? { ...item, entryCount } : item,
      );
    }
    renderEntries(scenario, entries, entryCount);
    dom.entriesPanel.hidden = false;
    renderScenarios();
    dom.entriesPanel.scrollIntoView({ block: 'nearest' });
  } catch (error) {
    showError(errorMessage(error, 'Could not load recorded requests.'));
  } finally {
    if (button.isConnected) setBusy(button, false);
  }
}

/**
 * @param {Scenario} scenario
 * @param {any[]} entries
 * @param {number} total
 */
function renderEntries(scenario, entries, total) {
  state.entriesScenario = scenario;
  state.entries = entries;
  state.entriesTotal = total;
  dom.entriesTitle.textContent = `Requests in “${scenario.name}” — ${entries.length} of ${total}`;
  dom.entriesBody.replaceChildren();
  dom.entriesEmpty.hidden = entries.length > 0;

  for (const entry of entries) {
    dom.entriesBody.append(renderEntryRow(entry));
  }
}

/** @param {any} entry */
function renderEntryRow(entry) {
  const method = String(entry?.method ?? 'GET').toUpperCase();
  const status = Number(entry?.status);
  const hasStatus = Number.isFinite(status) && status > 0;
  const statusText = hasStatus ? String(Math.trunc(status)) : '—';
  const statusClass = !hasStatus
    ? 'muted'
    : status >= 400
      ? 'error'
      : status >= 300
        ? 'warn'
        : 'ok';

  const url = shortUrl(entry?.url ?? '');
  const preview = truncateText(entry?.responsePreview);
  const size = formatBytes(entry?.size);
  const captured = formatTimestamp(entry?.capturedAt);
  const edited = entry?.edited === true;
  const editedTitle = edited
    ? `Payload edited ${formatTimestamp(entry?.editedAt)} (original kept for restore)`
    : '';

  const methodCell = el('td', { class: 'entry-method' }, method);
  if (edited) {
    methodCell.append(el('span', { class: 'entry-edited-badge', title: editedTitle }, 'edited'));
  }

  const editButton = el(
    'button',
    {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      'data-testid': `edit-entry-${entry.id}`,
      'aria-label': `Edit payload for ${method} ${url || entry?.url || ''}`,
      title: edited ? editedTitle : 'Edit the recorded response payload',
    },
    edited ? 'Edit' : 'Edit',
  );
  editButton.addEventListener('click', () => openEntryEditor(entry.id, editButton));

  return el(
    'tr',
    edited ? { class: 'entry-row-edited' } : {},
    methodCell,
    el('td', { class: `entry-status entry-status-${statusClass}` }, statusText),
    el('td', { class: 'entry-url', title: String(entry?.url ?? '') }, url || '—'),
    el('td', { class: 'entry-size' }, size),
    el('td', { class: 'entry-time' }, captured),
    el('td', { class: 'entry-preview', title: preview }, preview || '—'),
    el('td', { class: 'entry-actions' }, editButton),
  );
}

function closeEntries() {
  state.entriesScenarioId = null;
  state.entriesScenario = null;
  state.entries = [];
  state.entriesTotal = 0;
  dom.entriesPanel.hidden = true;
  dom.entriesBody.replaceChildren();
  dom.entriesEmpty.hidden = true;
  dom.entriesTitle.textContent = 'Recorded requests';
}

/** @param {unknown} value */
function truncateText(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

/** @param {unknown} value */
function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${Math.trunc(bytes)} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

/** @param {unknown} value */
function formatDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  try {
    return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/** @param {unknown} value */
function formatTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  try {
    return new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '—';
  }
}

/* ------------------------------------------------------------------ */
/* Recorded payload editor                                             */
/* ------------------------------------------------------------------ */

/** @param {any} updatedEntry */
function applyEntryUpdate(updatedEntry) {
  if (!updatedEntry?.id || !state.entriesScenario) return;
  state.entries = state.entries.map((entry) =>
    entry.id === updatedEntry.id ? { ...entry, ...updatedEntry } : entry,
  );
  renderEntries(state.entriesScenario, state.entries, state.entriesTotal);
}

/**
 * @param {string} entryId
 * @param {HTMLButtonElement} button
 */
async function openEntryEditor(entryId, button) {
  if (!state.entriesScenarioId) return;
  hideError();
  hideFieldError(dom.entryEditorError);
  setBusy(button, true);
  try {
    const response = await send(MSG.ENTRY_GET, { scenarioId: state.entriesScenarioId, entryId });
    const entry = response?.entry;
    const payload = response?.payload;
    if (!entry || !payload) throw new Error('Could not load that recorded request.');

    if (dom.entryEditor.open) dom.entryEditor.close();
    state.editing = {
      scenarioId: state.entriesScenarioId,
      entry,
      payload,
      editable: response.editable === true && payload.kind === 'text',
      hasOriginal: response.hasOriginal === true,
    };
    renderEditor();
    dom.entryEditor.showModal();
    if (state.editing.editable) {
      queueMicrotask(() => {
        if (!state.editing) return;
        dom.payloadEditor.focus();
        dom.payloadEditor.setSelectionRange(0, 0);
      });
    }
  } catch (error) {
    showError(errorMessage(error, 'Could not load the recorded payload.'));
  } finally {
    if (button.isConnected) setBusy(button, false);
  }
}

function renderEditor() {
  const editing = state.editing;
  if (!editing) return;

  const { entry, payload, editable, hasOriginal } = editing;
  const status = Number(entry.status);
  const statusLabel = Number.isFinite(status) && status > 0
    ? `${Math.trunc(status)}${entry.statusText ? ` ${entry.statusText}` : ''}`
    : 'no status';

  dom.entryEditorMeta.textContent = [
    `${String(entry.method || 'GET').toUpperCase()} ${statusLabel}`,
    entry.mimeType || 'unknown content-type',
    formatBytes(entry.size),
    entry.edited ? 'edited' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  dom.entryEditorRequest.textContent = String(entry.url || '');
  dom.entryEditorRequest.title = String(entry.url || '');

  dom.entryEditorNote.hidden = editable;
  if (!editable) {
    dom.entryEditorNote.dataset.tone = 'warn';
    dom.entryEditorNote.textContent =
      'This response is binary, so it cannot be edited as text. You can restore the original payload if one is available.';
  } else {
    dom.entryEditorNote.textContent = '';
    delete dom.entryEditorNote.dataset.tone;
  }

  dom.payloadEditor.value = editable ? String(payload.text ?? '') : '';
  dom.payloadEditor.disabled = !editable;
  dom.entryEditorSave.disabled = !editable;
  dom.entryEditorFormat.disabled = !editable;
  dom.entryEditorRestore.hidden = !hasOriginal;
  hideFieldError(dom.entryEditorError);
  updateEditorHint();
}

function updateEditorHint() {
  const editing = state.editing;
  if (!editing) return;

  const text = dom.payloadEditor.value;
  const bytes = new TextEncoder().encode(text).length;
  const limit = Number(state.settings.maxBodyBytes) || DEFAULT_SETTINGS.maxBodyBytes;
  const parts = [`${bytes.toLocaleString()} bytes`];
  let tone = '';

  const expectsJson = /json/i.test(String(editing.entry.mimeType || '')) || /^\s*[[{]/.test(text);
  if (expectsJson && text.trim()) {
    try {
      JSON.parse(text);
      parts.push('valid JSON');
    } catch {
      parts.push('not valid JSON — it will still be saved as typed');
      tone = 'warn';
    }
  }
  if (bytes > limit) {
    parts.push(`over the ${formatBytes(limit)} limit`);
    tone = 'warn';
  }

  dom.entryEditorHint.textContent = parts.join(' · ');
  if (tone) dom.entryEditorHint.dataset.tone = tone;
  else dom.entryEditorHint.removeAttribute('data-tone');
}

function closeEditor() {
  state.editing = null;
  hideFieldError(dom.entryEditorError);
  if (dom.entryEditor.open) dom.entryEditor.close();
  else dom.entryEditor.removeAttribute('open');
}

/** @param {Event} event */
async function onSavePayload(event) {
  event.preventDefault();
  const editing = state.editing;
  if (!editing || !editing.editable) return;

  hideError();
  hideFieldError(dom.entryEditorError);
  setBusy(dom.entryEditorSave, true);
  try {
    const response = await send(MSG.ENTRY_UPDATE, {
      scenarioId: editing.scenarioId,
      entryId: editing.entry.id,
      bodyText: dom.payloadEditor.value,
    });
    const updated = response?.entry;
    applyEntryUpdate(updated);
    closeEditor();
    showStatus('Recorded payload saved. Replay will use the edited payload.');
  } catch (error) {
    showFieldError(dom.entryEditorError, errorMessage(error, 'Could not save the payload.'));
  } finally {
    setBusy(dom.entryEditorSave, false);
  }
}

async function onRestorePayload() {
  const editing = state.editing;
  if (!editing) return;

  hideError();
  hideFieldError(dom.entryEditorError);
  setBusy(dom.entryEditorRestore, true);
  try {
    const response = await send(MSG.ENTRY_UPDATE, {
      scenarioId: editing.scenarioId,
      entryId: editing.entry.id,
      restoreOriginal: true,
    });
    applyEntryUpdate(response?.entry);
    closeEditor();
    showStatus('Original recorded payload restored.');
  } catch (error) {
    showFieldError(dom.entryEditorError, errorMessage(error, 'Could not restore the original payload.'));
  } finally {
    setBusy(dom.entryEditorRestore, false);
  }
}

function onFormatPayload() {
  if (!state.editing?.editable) return;
  try {
    dom.payloadEditor.value = JSON.stringify(JSON.parse(dom.payloadEditor.value), null, 2);
    hideFieldError(dom.entryEditorError);
    updateEditorHint();
  } catch {
    showFieldError(dom.entryEditorError, 'The payload is not valid JSON, so it cannot be formatted.');
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
  hideStatus();
}

function hideError() {
  dom.errorBanner.hidden = true;
  dom.errorText.textContent = '';
}

/** @param {string} message */
function showStatus(message) {
  dom.statusLine.textContent = message;
  dom.statusLine.hidden = false;
  clearTimeout(state.statusTimer);
  state.statusTimer = window.setTimeout(() => {
    dom.statusLine.hidden = true;
  }, STATUS_TIMEOUT_MS);
}

function hideStatus() {
  clearTimeout(state.statusTimer);
  dom.statusLine.hidden = true;
  dom.statusLine.textContent = '';
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
