/**
 * WebSocket replay engine.
 *
 * Replay needs two CDP halves:
 *   - `Page.addScriptToEvaluateOnNewDocument` installs a MAIN-world `WebSocket`
 *     shim before any page script runs (CSP/Trusted-Types safe), and
 *   - `Runtime.addBinding` gives the page a one-way channel back to us.
 *
 * The shim reports every `new WebSocket(...)` and every frame the page sends.
 * Mocked sockets replay the recorded timeline (`wsReplayPlan.js`), synthesizing
 * protocol keepalives; unmatched sockets are passed through to the real network.
 * "Go live" closes mocked sockets with code 1001 so Socket.IO / SignalR
 * auto-reconnect against the real server.
 */
import { base64ToBytes, bytesToUtf8 } from '../shared/bytes.js';
import { buildMatchIndexes, lookupWsRecording } from '../shared/matchIndex.js';
import { wsConnectionKey } from '../shared/matchkey.js';
import { isGraphqlWs } from '../shared/url.js';
import { adapterByName } from '../shared/wsAdapters/index.js';
import {
  compileReplayPlan,
  deliveryDelay,
  matchReplayStep,
  prepareResponses,
  synthesizeSocketIoConnect,
} from '../shared/wsReplayPlan.js';
import * as cdp from './cdp.js';
import * as db from './db.js';
import { WS_BRIDGE_NAME, WS_SHIM_SOURCE, wsShimCommand } from './wsShim.js';

/** @type {Map<number, object>} tabId -> replay state */
const replayers = new Map();

/** @param {number} tabId */
export function isReplaying(tabId) {
  return replayers.has(tabId);
}

/**
 * @param {{
 *   tabId: number,
 *   scenarioId: string,
 *   session: object,
 *   settings: object,
 *   hooks: object,
 * }} options
 * @returns {Promise<boolean>} whether WebSocket replay was enabled
 */
export async function startReplay({ tabId, scenarioId, session, settings, hooks }) {
  await stopReplay(tabId);
  if (settings?.recordWebSockets === false) return false;

  const entries = (await db.listEntries(scenarioId)).filter((entry) => entry.kind === 'ws');
  if (entries.length === 0) return false;

  const state = {
    tabId,
    scenarioId,
    session,
    settings,
    hooks,
    indexes: buildMatchIndexes(entries),
    entriesById: new Map(entries.map((entry) => [entry.id, entry])),
    live: false,
    sockets: new Map(),
    scriptIdentifier: null,
    timers: new Set(),
  };
  replayers.set(tabId, state);

  try {
    await cdp.sendCommand(tabId, 'Page.enable').catch(() => {});
    await cdp.sendCommand(tabId, 'Runtime.enable').catch(() => {});
    // A binding with this name can survive a service-worker restart; in that
    // case the existing one is reused.
    await cdp.sendCommand(tabId, 'Runtime.addBinding', { name: WS_BRIDGE_NAME }).catch(() => {});
    const result = await cdp.sendCommand(tabId, 'Page.addScriptToEvaluateOnNewDocument', {
      source: WS_SHIM_SOURCE,
      runImmediately: false,
    });
    state.scriptIdentifier = result?.identifier ?? null;
    // The current document needs the shim too: sockets opened after "Start
    // replay" (without a reload) must still be intercepted. This can fail while
    // the page is mid-navigation; the injected script covers the next document.
    await evaluate(tabId, WS_SHIM_SOURCE).catch(() => {});
  } catch (error) {
    replayers.delete(tabId);
    await teardown(tabId, state).catch(() => {});
    throw new Error(`WebSocket replay could not start: ${/** @type {any} */ (error)?.message || error}`);
  }

  return true;
}

/**
 * Toggle live passthrough for WebSockets.
 * @param {number} tabId
 * @param {boolean} live
 */
export async function setLive(tabId, live) {
  const state = replayers.get(tabId);
  if (!state) return;
  state.live = Boolean(live);

  if (live) {
    // 1001 = Going Away: Socket.IO and SignalR reconnect on their own, and the
    // reconnecting socket passes through because `live` is set.
    await evaluate(tabId, wsShimCommand('closeAll', [1001, 'Replay stopped'])).catch(() => {});
    for (const socket of state.sockets.values()) clearSocketTimers(socket);
    state.sockets.clear();
  }
}

/**
 * @param {number} tabId
 * @param {{detach?: boolean, keepDebugger?: boolean}} [options]
 */
export async function stopReplay(tabId, { keepDebugger = false } = {}) {
  const state = replayers.get(tabId);
  if (!state) return;
  replayers.delete(tabId);
  await teardown(tabId, state, { keepDebugger });
}

/**
 * @param {number} tabId
 * @param {object} state
 * @param {{keepDebugger?: boolean}} [options]
 */
async function teardown(tabId, state, { keepDebugger = false } = {}) {
  void keepDebugger;
  for (const socket of state.sockets.values()) clearSocketTimers(socket);
  state.sockets.clear();
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();

  if (state.scriptIdentifier) {
    try {
      await cdp.sendCommand(tabId, 'Page.removeScriptToEvaluateOnNewDocument', {
        identifier: state.scriptIdentifier,
      });
    } catch {
      /* page may be gone */
    }
  }
  try {
    await evaluate(tabId, wsShimCommand('reset', []));
    await cdp.sendCommand(tabId, 'Runtime.removeBinding', { name: WS_BRIDGE_NAME });
  } catch {
    /* ignore */
  }
  if (!keepDebugger) {
    // The HTTP replay engine owns detaching; nothing to do here.
  }
}

/**
 * Reload recordings after an edit so the next connection uses the new frames.
 * @param {string} scenarioId
 */
export async function refreshScenario(scenarioId) {
  let refreshed = false;
  for (const state of replayers.values()) {
    if (state.scenarioId !== scenarioId) continue;
    const entries = (await db.listEntries(scenarioId)).filter((entry) => entry.kind === 'ws');
    state.indexes = buildMatchIndexes(entries);
    state.entriesById = new Map(entries.map((entry) => [entry.id, entry]));

    // Recompile the plan of sockets that are still mocked so an edit made in
    // Settings is used by the frames that have not been delivered yet.
    for (const socket of state.sockets.values()) {
      const entry = state.entriesById.get(socket.entryId);
      if (!entry) continue;
      const frames = await db.listWsFrames(entry.id);
      if (frames.length === 0) continue;
      socket.plan = compileReplayPlan({
        frames: frames.map(frameToPlanInput),
        adapter: socket.adapter.name,
      });
      socket.used.clear();
    }
    refreshed = true;
  }
  return refreshed;
}

/**
 * Map a stored frame row to the planner's input shape.
 * @param {object} frame
 */
function frameToPlanInput(frame) {
  return {
    seq: frame.seq,
    direction: frame.direction,
    opcode: frame.opcode,
    offsetMs: frame.offsetMs,
    text: frame.opcode === 1 ? bytesToUtf8(base64ToBytes(frame.payload)) : null,
    base64: frame.opcode === 2 ? frame.payload : null,
  };
}

/**
 * Route one CDP event.
 * @param {number} tabId
 * @param {string} method
 * @param {any} params
 * @returns {boolean} whether the event was consumed
 */
export function handleEvent(tabId, method, params) {
  const state = replayers.get(tabId);
  if (!state) return false;

  if (method === 'Runtime.bindingCalled') {
    if (params?.name !== WS_BRIDGE_NAME) return false;
    void onBindingPayload(tabId, state, params?.payload).catch((error) => {
      state.hooks?.onWarning?.(state.session, `WebSocket replay error: ${error.message}`);
    });
    return true;
  }

  if (method === 'Runtime.executionContextDestroyed' || method === 'Runtime.executionContextsCleared') {
    for (const socket of state.sockets.values()) clearSocketTimers(socket);
    state.sockets.clear();
    return true;
  }

  return false;
}

/**
 * @param {number} tabId
 * @param {object} state
 * @param {string} payload
 */
async function onBindingPayload(tabId, state, payload) {
  let message;
  try {
    message = JSON.parse(String(payload ?? ''));
  } catch {
    return;
  }
  if (!message || typeof message.cmd !== 'string') return;

  switch (message.cmd) {
    case 'open':
      await onOpen(tabId, state, message);
      return;
    case 'send':
      await onSend(tabId, state, message);
      return;
    case 'close':
      closeSocket(state, message.connId);
      return;
    default:
  }
}

/**
 * @param {number} tabId
 * @param {object} state
 * @param {{connId:string, url:string, protocols?:string[]}} message
 */
async function onOpen(tabId, state, message) {
  const connId = String(message.connId ?? '');
  const url = String(message.url ?? '');
  const protocols = Array.isArray(message.protocols) ? message.protocols.map(String) : [];

  const passthrough = async (reason, detail = {}) => {
    if (reason) {
      state.hooks?.onMiss?.(
        state.session,
        { method: 'WS', url },
        { reason, sameUrl: detail.samePath ?? 0, samePath: detail.samePath ?? 0 },
      );
    }
    await evaluate(tabId, wsShimCommand('openResult', [connId, { mock: false }])).catch(() => {});
  };

  if (state.live) return passthrough(null);
  if (state.settings?.skipGraphql !== false && isGraphqlWs({ url, protocols })) return passthrough(null);

  const matchKey = await wsConnectionKey(url);
  const lookup = lookupWsRecording(state.indexes, { url, matchKey });
  if (!lookup.entry) return passthrough(lookup.reason ?? 'ws-no-recording', { samePath: lookup.samePath });

  const frames = await db.listWsFrames(lookup.entry.id);
  if (frames.length === 0) return passthrough('ws-frames-missing');

  const adapter = adapterByName(lookup.entry.wsAdapter);
  const plan = compileReplayPlan({
    frames: frames.map(frameToPlanInput),
    adapter: adapter.name,
  });

  const socket = {
    connId,
    entryId: lookup.entry.id,
    url,
    adapter,
    plan,
    used: new Set(),
    timers: new Set(),
    keepaliveStop: null,
    closed: false,
  };
  state.sockets.set(connId, socket);

  await evaluate(
    tabId,
    wsShimCommand('openResult', [
      connId,
      { mock: true, protocol: lookup.entry.negotiatedProtocol || protocols[0] || '' },
    ]),
  );

  state.hooks?.onHit?.(state.session, lookup.entry, { matchedVia: lookup.matchedVia ?? 'exact' });

  // The connection's protocol drives keepalive behavior.
  const keepaliveCtx = buildKeepaliveContext(socket, url, lookup.entry);
  if (typeof adapter.startKeepalive === 'function') {
    try {
      const stop = adapter.startKeepalive(keepaliveCtx, (frame) => {
        if (socket.closed) return;
        void deliverText(tabId, socket, frame).catch(() => {});
      });
      socket.keepaliveStop = typeof stop === 'function' ? stop : null;
    } catch {
      socket.keepaliveStop = null;
    }
  }

  // Play everything the server said before the first client frame.
  for (const entry of plan.prelude) {
    scheduleDelivery(tabId, state, socket, entry, 0);
  }
}

/**
 * @param {object} socket
 * @param {string} url
 * @param {object} entry
 */
function buildKeepaliveContext(socket, url, entry) {
  if (socket.adapter.name === 'signalr') return { serverKeepaliveMs: 15000 };
  if (socket.adapter.name !== 'socketio') return {};
  let eio = '4';
  try {
    eio = new URL(url).searchParams.get('EIO') || '4';
  } catch {
    /* keep default */
  }
  if (eio === '3') return {}; // Engine.IO v3: the client pings, we answer.
  return { pingIntervalMs: 20000 };
}

/**
 * @param {number} tabId
 * @param {object} state
 * @param {{connId:string, opcode?:number, text?:string, base64?:string}} message
 */
async function onSend(tabId, state, message) {
  const socket = state.sockets.get(String(message.connId ?? ''));
  if (!socket || socket.closed) return;

  const opcode = Number(message.opcode) === 2 ? 2 : 1;
  const text = opcode === 1 ? String(message.text ?? '') : null;
  const base64 = opcode === 2 ? String(message.base64 ?? '') : null;

  if (opcode === 1) {
    const control = socket.adapter.handleControlMessage(text, {});
    if (control && control.length > 0) {
      for (const reply of control) scheduleDelivery(tabId, state, socket, { opcode: 1, text: reply, offsetMs: 0 }, 0);
      return;
    }
    // Absorbed handshake/keepalive traffic is never reported as unmatched.
    if (socket.adapter.isControlOrKeepalive(text, 'send')) return;
  }

  const smartFallback = state.settings?.smartFallback !== false;
  const match = matchReplayStep(socket.plan, { opcode, text, base64 }, { smartFallback, used: socket.used });

  if (!match) {
    // A Socket.IO namespace connect can be answered even when the recording
    // started on a raw WS connection (no connect exchange was captured).
    if (socket.adapter.name === 'socketio' && text?.startsWith('40')) {
      const synthesized = synthesizeSocketIoConnect(text);
      if (synthesized) {
        scheduleDelivery(tabId, state, socket, { opcode: 1, text: synthesized, offsetMs: 0 }, 0);
        return;
      }
    }
    state.hooks?.onMiss?.(
      state.session,
      { method: 'WS', url: socket.url },
      { reason: 'ws-frame-unmatched', sameUrl: socket.plan.steps.length, samePath: socket.plan.steps.length },
    );
    return;
  }

  socket.used.add(match.step.index);
  const responses = prepareResponses(socket.plan.adapter, match.step, match.liveSignature);
  for (const response of responses) {
    const delay = deliveryDelay(
      { timing: state.settings?.wsReplayTiming, maxDelayMs: state.settings?.wsMaxFrameDelayMs },
      match.step.trigger,
      response,
    );
    scheduleDelivery(tabId, state, socket, response, delay);
  }
}

/**
 * @param {number} tabId
 * @param {object} state
 * @param {object} socket
 * @param {{opcode:number, text?:string|null, base64?:string|null, offsetMs?:number}} frame
 * @param {number} delay
 */
function scheduleDelivery(tabId, state, socket, frame, delay) {
  if (socket.closed) return;
  const run = () => {
    if (socket.closed) return;
    const send =
      Number(frame.opcode) === 2
        ? evaluate(tabId, wsShimCommand('deliver', [socket.connId, 2, null, frame.base64 ?? '']))
        : deliverText(tabId, socket, String(frame.text ?? ''));
    void send.catch(() => {});
  };

  if (!delay || delay <= 0) {
    run();
    return;
  }
  const timer = setTimeout(() => {
    socket.timers.delete(timer);
    run();
  }, delay);
  if (typeof timer?.unref === 'function') timer.unref();
  socket.timers.add(timer);
}

/** @param {number} tabId @param {object} socket @param {string} text */
function deliverText(tabId, socket, text) {
  return evaluate(tabId, wsShimCommand('deliver', [socket.connId, 1, text, null]));
}

/** @param {object} state @param {string} connId */
function closeSocket(state, connId) {
  const socket = state.sockets.get(String(connId ?? ''));
  if (!socket) return;
  socket.closed = true;
  clearSocketTimers(socket);
  state.sockets.delete(socket.connId);
}

/** @param {object} socket */
function clearSocketTimers(socket) {
  socket.closed = true;
  if (typeof socket.keepaliveStop === 'function') {
    try {
      socket.keepaliveStop();
    } catch {
      /* ignore */
    }
    socket.keepaliveStop = null;
  }
  for (const timer of socket.timers) clearTimeout(timer);
  socket.timers.clear();
}

/**
 * @param {number} tabId
 * @param {string} expression
 */
async function evaluate(tabId, expression) {
  return cdp.sendCommand(tabId, 'Runtime.evaluate', {
    expression,
    silent: true,
    returnByValue: true,
  });
}
