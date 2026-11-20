/**
 * In-page HUD for API Recorder.
 *
 * Injected into allowed sites at document_start (and on demand when a session
 * starts). Lives in a closed-off shadow root so it cannot clash with page CSS.
 * Shows the live request counter, mode (recording / replay / live), replay vs
 * live totals and a recent-request feed, and exposes Stop / Live controls.
 *
 * This file is intentionally dependency free: content scripts cannot be ES
 * modules, so the few message constants are mirrored here.
 */
(() => {
  'use strict';

  const GUARD = '__apiRecorderHudInstalled';
  if (window[GUARD]) return;
  window[GUARD] = true;

  const MSG = {
    OVERLAY_STATE: 'overlay.state',
    STOP_SESSION: 'session.stop',
    SET_LIVE: 'session.setLive',
    KEEPALIVE: 'keepalive',
  };

  const BROADCAST = {
    SESSION_UPDATE: 'session.update',
    FEED_EVENT: 'feed.event',
    TOAST: 'toast',
  };

  const KEEPALIVE_MS = 15000;
  const MAX_FEED = 40;

  const state = {
    /** @type {null | {mode:string, scenarioName:string, startedAt:number, recorded:number, hits:number, misses:number, skipped:number}} */
    session: null,
    /** @type {Array<{kind:string, method:string, url:string, status:number, at:number}>} */
    feed: [],
    expanded: false,
    tickTimer: null,
    pingTimer: null,
    toastTimer: null,
    busy: false,
  };

  /** @type {HTMLElement|null} */
  let host = null;
  /** @type {Record<string, any>|null} */
  let refs = null;

  const STYLES = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .wrap {
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #e5e7eb; max-width: 360px;
    }
    .wrap[hidden], .panel[hidden], .toast[hidden], .error[hidden], .toggle-live[hidden] { display: none !important; }
    .pill {
      display: flex; align-items: center; gap: 8px; max-width: 360px;
      padding: 8px 12px; border-radius: 999px; border: 1px solid #334155;
      background: #0f172a; color: #e5e7eb; cursor: pointer;
      box-shadow: 0 10px 30px rgba(2, 6, 23, 0.45); font: inherit;
    }
    .pill:hover { border-color: #475569; }
    .pill:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
    .pill-mode { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; }
    .pill-scenario { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #cbd5e1; }
    .pill-metric { font-variant-numeric: tabular-nums; color: #94a3b8; white-space: nowrap; }
    .pill-chevron { color: #64748b; font-size: 10px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; flex: none; }
    .wrap[data-mode="recording"] .dot { background: #ef4444; box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.22); animation: api-rec-pulse 1.6s ease-in-out infinite; }
    .wrap[data-mode="replay"] .dot { background: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.22); }
    .wrap[data-mode="live"] .dot { background: #9ca3af; box-shadow: 0 0 0 3px rgba(156, 163, 175, 0.18); }
    .wrap[data-mode="recording"] .pill-mode { color: #f87171; }
    .wrap[data-mode="replay"] .pill-mode { color: #60a5fa; }
    .wrap[data-mode="live"] .pill-mode { color: #cbd5e1; }
    @keyframes api-rec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    @media (prefers-reduced-motion: reduce) { .wrap[data-mode="recording"] .dot { animation: none; } }
    .panel { width: 340px; border-radius: 14px; border: 1px solid #334155; background: #0f172a; box-shadow: 0 18px 50px rgba(2, 6, 23, 0.5); overflow: hidden; }
    .panel-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 0; }
    .mode-label { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; }
    .scenario-name { font-weight: 600; color: #f1f5f9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .elapsed { color: #94a3b8; font-variant-numeric: tabular-nums; }
    .icon-button { background: transparent; border: none; color: #94a3b8; cursor: pointer; font: inherit; padding: 2px 6px; border-radius: 6px; }
    .icon-button:hover { color: #e5e7eb; background: #1e293b; }
    .icon-button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 1px; }
    .counts { padding: 6px 12px 10px; color: #94a3b8; font-variant-numeric: tabular-nums; }
    .controls { display: flex; gap: 8px; padding: 0 12px 12px; }
    .controls button { flex: 1; border-radius: 8px; border: 1px solid #334155; background: #1e293b; color: #e5e7eb; padding: 7px 10px; font: inherit; cursor: pointer; }
    .controls button:hover { background: #334155; }
    .controls button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 1px; }
    .controls button:disabled { opacity: 0.55; cursor: default; }
    .controls .stop { border-color: #7f1d1d; background: #450a0a; color: #fecaca; }
    .controls .stop:hover { background: #7f1d1d; }
    .controls .toggle-live { border-color: #1e3a8a; background: #172554; color: #bfdbfe; }
    .controls .toggle-live:hover { background: #1e3a8a; }
    .error { margin: 0 12px 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid #7f1d1d; background: #450a0a; color: #fecaca; }
    .feed { list-style: none; margin: 0; padding: 0 0 6px; max-height: 168px; overflow-y: auto; border-top: 1px solid #1e293b; }
    .feed:empty { display: none; }
    .feed li { display: flex; align-items: center; gap: 6px; padding: 5px 12px; border-bottom: 1px solid #16202f; }
    .feed li:last-child { border-bottom: none; }
    .feed .badge { font-size: 9px; font-weight: 700; letter-spacing: 0.04em; border-radius: 4px; padding: 1px 4px; flex: none; }
    .feed .badge[data-kind="recorded"] { background: #450a0a; color: #fca5a5; }
    .feed .badge[data-kind="replayed"] { background: #172554; color: #93c5fd; }
    .feed .badge[data-kind="live"] { background: #1f2937; color: #cbd5e1; }
    .feed .method { color: #e2e8f0; font-weight: 600; flex: none; }
    .feed .url { color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .feed .status { color: #64748b; font-variant-numeric: tabular-nums; flex: none; }
    .toast { max-width: 340px; padding: 8px 12px; border-radius: 10px; border: 1px solid #334155; background: #111827; color: #e5e7eb; box-shadow: 0 10px 30px rgba(2, 6, 23, 0.45); }
    .toast[data-level="warn"] { border-color: #92400e; background: #451a03; color: #fde68a; }
    .toast[data-level="error"] { border-color: #7f1d1d; background: #450a0a; color: #fecaca; }
  `;

  function ensureMounted() {
    if (host) return true;
    if (!document.documentElement) return false;

    host = document.createElement('div');
    host.id = 'api-recorder-hud';
    host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="wrap" data-mode="idle" hidden>
        <div class="panel" hidden>
          <div class="panel-head">
            <span class="dot" aria-hidden="true"></span>
            <span class="mode-label"></span>
            <span class="scenario-name"></span>
            <span class="elapsed"></span>
            <button class="icon-button collapse" type="button" title="Collapse" aria-label="Collapse API Recorder">▾</button>
          </div>
          <div class="counts" aria-live="polite"></div>
          <div class="controls">
            <button class="toggle-live" type="button" hidden></button>
            <button class="stop" type="button">Stop</button>
          </div>
          <div class="error" role="alert" hidden></div>
          <ol class="feed" aria-label="Recent requests"></ol>
        </div>
        <button class="pill" type="button" aria-expanded="false">
          <span class="dot" aria-hidden="true"></span>
          <span class="pill-mode"></span>
          <span class="pill-scenario"></span>
          <span class="pill-metric" aria-live="polite"></span>
          <span class="pill-chevron" aria-hidden="true">▴</span>
        </button>
        <div class="toast" role="status" aria-live="polite" hidden></div>
      </div>
    `;

    document.documentElement.appendChild(host);

    refs = {
      wrap: shadow.querySelector('.wrap'),
      panel: shadow.querySelector('.panel'),
      dot: shadow.querySelector('.panel .dot'),
      modeLabel: shadow.querySelector('.mode-label'),
      scenarioName: shadow.querySelector('.scenario-name'),
      elapsed: shadow.querySelector('.elapsed'),
      counts: shadow.querySelector('.counts'),
      toggleLive: shadow.querySelector('.toggle-live'),
      stop: shadow.querySelector('.stop'),
      error: shadow.querySelector('.error'),
      feed: shadow.querySelector('.feed'),
      pill: shadow.querySelector('.pill'),
      pillMode: shadow.querySelector('.pill-mode'),
      pillScenario: shadow.querySelector('.pill-scenario'),
      pillMetric: shadow.querySelector('.pill-metric'),
      pillChevron: shadow.querySelector('.pill-chevron'),
      collapse: shadow.querySelector('.collapse'),
      toast: shadow.querySelector('.toast'),
    };

    refs.pill.addEventListener('click', () => setExpanded(!state.expanded));
    refs.collapse.addEventListener('click', () => setExpanded(false));
    refs.stop.addEventListener('click', () => void stopSession());
    refs.toggleLive.addEventListener('click', () => void toggleLive());

    return true;
  }

  function destroy() {
    stopTimers();
    if (host) {
      host.remove();
      host = null;
      refs = null;
    }
  }

  /** @param {boolean} expanded */
  function setExpanded(expanded) {
    state.expanded = expanded;
    if (!refs) return;
    refs.panel.hidden = !expanded;
    refs.pill.setAttribute('aria-expanded', String(expanded));
    refs.pillChevron.textContent = expanded ? '▾' : '▴';
  }

  function render() {
    const session = state.session;
    if (!session) {
      destroy();
      return;
    }
    if (!ensureMounted() || !refs) return;

    refs.wrap.hidden = false;
    refs.wrap.dataset.mode = session.mode;
    setExpanded(state.expanded);

    const label = modeLabel(session.mode);
    refs.modeLabel.textContent = label;
    refs.scenarioName.textContent = session.scenarioName;
    refs.scenarioName.title = session.scenarioName;
    refs.elapsed.textContent = formatElapsed(Date.now() - session.startedAt);

    refs.pillMode.textContent = session.mode === 'recording' ? 'REC' : session.mode === 'replay' ? 'REP' : 'LIVE';
    refs.pillScenario.textContent = session.scenarioName;
    refs.pillScenario.title = session.scenarioName;
    refs.pillMetric.textContent = pillMetric(session);

    refs.counts.textContent = countsText(session);
    refs.stop.textContent = session.mode === 'recording' ? 'Stop recording' : 'Stop replay';
    refs.stop.disabled = state.busy;

    if (session.mode === 'recording') {
      refs.toggleLive.hidden = true;
    } else {
      refs.toggleLive.hidden = false;
      refs.toggleLive.textContent = session.mode === 'live' ? 'Resume replay' : 'Go live';
      refs.toggleLive.disabled = state.busy;
    }

    if (state.error) {
      refs.error.hidden = false;
      refs.error.textContent = state.error;
    } else {
      refs.error.hidden = true;
      refs.error.textContent = '';
    }

    renderFeed();
  }

  function renderFeed() {
    if (!refs) return;
    refs.feed.textContent = '';
    for (const event of [...state.feed].reverse()) {
      const item = document.createElement('li');

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.dataset.kind = event.kind || 'recorded';
      badge.textContent = feedKindLabel(event.kind);

      const method = document.createElement('span');
      method.className = 'method';
      method.textContent = String(event.method || 'GET').toUpperCase();

      const url = document.createElement('span');
      url.className = 'url';
      url.textContent = compactUrl(event.url);
      url.title = String(event.url || '');

      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = event.status ? String(event.status) : '';

      if (event.kind === 'replayed' && event.matchedVia && event.matchedVia !== 'exact') {
        badge.textContent = 'RPL*';
        item.title = `Replayed with ${event.matchedVia === 'url' ? 'URL' : 'path'} fallback match`;
      } else if (event.kind === 'live' && event.reason) {
        item.title = `Passed live: ${overlayReasonLabel(event.reason)}`;
      }

      item.append(badge, method, url, status);
      refs.feed.appendChild(item);
    }
  }

  /** @param {string} mode */
  function modeLabel(mode) {
    if (mode === 'recording') return 'RECORDING';
    if (mode === 'replay') return 'REPLAY';
    return 'LIVE';
  }

  /** @param {any} session */
  function pillMetric(session) {
    if (session.mode === 'recording') return `${session.recorded} req`;
    if (session.mode === 'replay') return `${session.hits} replay`;
    return 'Live mode';
  }

  /** @param {any} session */
  function countsText(session) {
    const skipped = session.skipped ? ` · ${session.skipped} skipped` : '';
    if (session.mode === 'recording') return `${session.recorded} recorded${skipped}`;
    if (session.mode === 'replay') return `${session.hits} replayed · ${session.misses} passed live${skipped}`;
    return `Live mode — ${session.hits} replayed earlier, ${session.misses} passed live`;
  }

  const OVERLAY_REASONS = {
    'no-recording': 'no recording for this request',
    'body-differs': 'same URL recorded, different request body',
    'url-differs': 'same endpoint recorded, different URL',
    'ambiguous-body': 'several recordings share this URL',
    'ambiguous-url': 'several recordings share this endpoint',
    'body-unavailable': 'Chrome did not expose the request body',
    'body-missing': 'recorded response body missing',
    'fulfill-error': 'recorded response could not be returned',
  };

  /** @param {string} reason */
  function overlayReasonLabel(reason) {
    return OVERLAY_REASONS[reason] ?? String(reason ?? 'unknown reason');
  }

  /** @param {string} kind */
  function feedKindLabel(kind) {
    if (kind === 'replayed') return 'RPL';
    if (kind === 'live') return 'LIVE';
    return 'REC';
  }

  /** @param {string} url */
  function compactUrl(url) {
    try {
      const parsed = new URL(url);
      const value = `${parsed.pathname}${parsed.search}`;
      return value.length > 60 ? `${value.slice(0, 59)}…` : value;
    } catch {
      const value = String(url || '');
      return value.length > 60 ? `${value.slice(0, 59)}…` : value;
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

  function ensureTimers() {
    if (!state.tickTimer) {
      state.tickTimer = setInterval(() => {
        if (refs && state.session) refs.elapsed.textContent = formatElapsed(Date.now() - state.session.startedAt);
      }, 1000);
    }
    if (!state.pingTimer) {
      state.pingTimer = setInterval(() => {
        if (!state.session) {
          stopTimers();
          return;
        }
        try {
          // Keeps the MV3 service worker alive while a session is active.
          chrome.runtime.sendMessage({ type: MSG.KEEPALIVE });
        } catch {
          stopTimers();
        }
      }, KEEPALIVE_MS);
    }
  }

  function stopTimers() {
    if (state.tickTimer) {
      clearInterval(state.tickTimer);
      state.tickTimer = null;
    }
    if (state.pingTimer) {
      clearInterval(state.pingTimer);
      state.pingTimer = null;
    }
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
  }

  /** @param {boolean} busy */
  function setBusy(busy) {
    state.busy = busy;
    if (!refs) return;
    refs.stop.disabled = busy;
    refs.toggleLive.disabled = busy;
  }

  /** @param {string} text @param {'info'|'warn'|'error'} [level] */
  function showToast(text, level = 'info') {
    if (!refs) return;
    refs.toast.hidden = false;
    refs.toast.textContent = text;
    refs.toast.dataset.level = level;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      state.toastTimer = null;
      if (refs) refs.toast.hidden = true;
    }, 4500);
  }

  /** @param {string} text */
  function showError(text) {
    state.error = text;
    render();
  }

  async function stopSession() {
    if (state.busy) return;
    setBusy(true);
    state.error = null;
    try {
      const response = await chrome.runtime.sendMessage({ type: MSG.STOP_SESSION });
      if (response && response.ok === false) throw new Error(response.error);
    } catch (error) {
      showError(/** @type {any} */ (error)?.message || 'Could not stop the session.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleLive() {
    const session = state.session;
    if (state.busy || !session || session.mode === 'recording') return;
    setBusy(true);
    state.error = null;
    try {
      const response = await chrome.runtime.sendMessage({ type: MSG.SET_LIVE, live: session.mode === 'replay' });
      if (response && response.ok === false) throw new Error(response.error);
    } catch (error) {
      showError(/** @type {any} */ (error)?.message || 'Could not switch mode.');
    } finally {
      setBusy(false);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.__broadcast) return undefined;

    switch (message.type) {
      case BROADCAST.SESSION_UPDATE: {
        const previous = state.session;
        state.session = message.session ?? null;
        if (!message.session) {
          state.feed = [];
          render();
          return undefined;
        }
        if (!previous || previous.startedAt !== message.session.startedAt) {
          state.feed = [];
          state.expanded = false;
        }
        render();
        ensureTimers();
        return undefined;
      }
      case BROADCAST.FEED_EVENT: {
        if (!state.session || !message.event) return undefined;
        state.feed.push(message.event);
        if (state.feed.length > MAX_FEED) state.feed.splice(0, state.feed.length - MAX_FEED);
        if (refs) renderFeed();
        return undefined;
      }
      case BROADCAST.TOAST: {
        if (message.text) showToast(String(message.text), message.level);
        return undefined;
      }
      default:
        return undefined;
    }
  });

  async function init() {
    try {
      const response = await chrome.runtime.sendMessage({ type: MSG.OVERLAY_STATE });
      if (!response || response.ok === false) return;
      state.session = response.session ?? null;
      if (!state.session) return;
      render();
      ensureTimers();
    } catch {
      /* extension context invalidated (extension updated/reloaded) */
    }
  }

  if (document.documentElement) {
    void init();
  } else {
    document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
  }
})();
