/**
 * Shared constants for the API Recorder extension. This module is imported by
 * the service worker, the popup and the options page, so it must stay free of
 * side effects.
 */

/** Message types. Requests are answered with {ok:true, ...} or {ok:false, error}. */
export const MSG = Object.freeze({
  STATE_GET: 'state.get',
  SESSION_GET: 'session.get',
  OVERLAY_STATE: 'overlay.state',
  START_RECORDING: 'session.startRecording',
  START_REPLAY: 'session.startReplay',
  SET_LIVE: 'session.setLive',
  STOP_SESSION: 'session.stop',
  SCENARIO_CREATE: 'scenario.create',
  SCENARIO_RENAME: 'scenario.rename',
  SCENARIO_COPY: 'scenario.copy',
  SCENARIO_DELETE: 'scenario.delete',
  SCENARIO_ENTRIES: 'scenario.entries',
  ENTRY_GET: 'scenario.entry.get',
  ENTRY_UPDATE: 'scenario.entry.update',
  ENTRY_DELETE: 'scenario.entry.delete',
  WS_FRAMES_GET: 'scenario.ws.frames',
  WS_FRAME_UPDATE: 'scenario.ws.frame.update',
  WS_FRAME_DELETE: 'scenario.ws.frame.delete',
  EXPORT_SCENARIO: 'scenario.export',
  EXPORT_ALL_SCENARIOS: 'scenario.exportAll',
  IMPORT_SCENARIO: 'scenario.import',
  SETTINGS_SET: 'settings.set',
  SITES_ADD: 'sites.add',
  SITES_REMOVE: 'sites.remove',
  SITES_LIST: 'sites.list',
  DEBUG_STATE: 'debug.state',
  KEEPALIVE: 'keepalive',
});

/** Message types pushed from the service worker to extension pages / content scripts. */
export const BROADCAST = Object.freeze({
  SESSION_UPDATE: 'session.update',
  FEED_EVENT: 'feed.event',
  TOAST: 'toast',
  SITES_UPDATE: 'sites.update',
});

/** Kinds used in feed events. */
export const FEED_KIND = Object.freeze({
  RECORDED: 'recorded',
  REPLAYED: 'replayed',
  LIVE: 'live',
});

/** Storage keys used in chrome.storage.local / chrome.storage.session. */
export const STORAGE = Object.freeze({
  SITES: 'sites',
  SCENARIOS: 'scenarios',
  SETTINGS: 'settings',
  TAB_SESSIONS: 'tabSessions',
});

/** IndexedDB layout. */
export const DB = Object.freeze({
  NAME: 'api-recorder-db',
  VERSION: 2,
  ENTRIES: 'entries',
  BODIES: 'bodies',
  WS_FRAMES: 'ws_frames',
});

/** Kinds of recorded entry, stored on every `entries` record (`http` when absent). */
export const ENTRY_KIND = Object.freeze({
  HTTP: 'http',
  WS: 'ws',
});

/** Protocol adapter names used by WebSocket recording and replay. */
export const WS_ADAPTER = Object.freeze({
  SOCKET_IO: 'socketio',
  SIGNALR: 'signalr',
  GENERIC: 'generic',
});

/** How recorded WebSocket server frames are timed during replay. */
export const WS_TIMING = Object.freeze({
  /** Keep the recorded offsets, but cap every delay at `wsMaxFrameDelayMs`. */
  CAPPED: 'capped',
  /** Replay with the exact recorded delays (can be slow). */
  ORIGINAL: 'original',
  /** Deliver recorded server frames immediately. */
  INSTANT: 'instant',
});

export const DEFAULT_SETTINGS = Object.freeze({
  /** Responses bigger than this are skipped during recording. */
  maxBodyBytes: 10 * 1024 * 1024,
  /** Skip GraphQL-looking requests (URL contains "graphql" or body contains a query). */
  skipGraphql: true,
  /** Replay recorded Set-Cookie headers (off by default so replay cannot pollute cookies). */
  replayCookies: false,
  /**
   * When an exact method + URL + body recording is missing, replay the only
   * recording for the same URL (or same path) if that fallback is unambiguous.
   */
  smartFallback: true,
  /** Record and replay WebSocket connections. */
  recordWebSockets: true,
  /** How recorded server frames are spaced during WebSocket replay. */
  wsReplayTiming: WS_TIMING.CAPPED,
  /** Delay cap (ms) for `capped` replay timing. */
  wsMaxFrameDelayMs: 1500,
  /** Hard limit on recorded frames per WebSocket connection. */
  wsMaxFramesPerConnection: 2000,
  /** Largest single recorded WebSocket frame (bytes). */
  wsMaxFrameBytes: 1024 * 1024,
});

export const LIMITS = Object.freeze({
  MAX_SCENARIO_NAME: 64,
  MAX_PREVIEW_CHARS: 400,
  MAX_FEED_ITEMS: 50,
  MAX_UI_ENTRIES: 200,
  /** Requests above this many bytes of request body are not keyed reliably, so skipped. */
  MAX_REQUEST_BODY_BYTES: 2 * 1024 * 1024,
  /** Recorded WebSocket frames above this size are dropped (connection marked truncated). */
  MAX_WS_FRAME_BYTES: 1024 * 1024,
  /** Recorded WebSocket payload bytes across one connection. */
  MAX_WS_CONNECTION_BYTES: 20 * 1024 * 1024,
});

export const SESSION_MODE = Object.freeze({
  RECORDING: 'recording',
  REPLAY: 'replay',
  LIVE: 'live',
});

export const BADGE = Object.freeze({
  RECORDING_BG: '#dc2626',
  REPLAY_BG: '#2563eb',
  LIVE_BG: '#6b7280',
  ERROR_BG: '#b45309',
});

/** Files injected into pages. */
export const OVERLAY_FILE = 'src/content/overlay.js';
export const OVERLAY_SCRIPT_PREFIX = 'apirr-overlay-';

/** Content-script keepalive interval while a session is active (ms). */
export const KEEPALIVE_MS = 15000;
