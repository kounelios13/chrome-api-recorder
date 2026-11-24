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
  frameTextForDelivery,
  matchReplayStep,
  prepareResponses,
  socketKey,
  synthesizeSocketIoConnect,
} from '../shared/wsReplayPlan.js';
import * as cdp from './cdp.js';
import * as db from './db.js';
import { WS_BRIDGE_NAME, WS_SHIM_SYMBOL, wsShimCommand, wsShimSource } from './wsShim.js';

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

  // A unique binding name per session: once the shim deletes the page global,
  // `Runtime.addBinding` with the same name does not recreate it, so reusing
  // the name is what made a second session impossible without a reload.
  const bindingName = `${WS_BRIDGE_NAME}_${randomToken()}`;
  const source = wsShimSource(bindingName);

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
    bindingName,
    source,
    bindingReady: false,
    /** @type {Set<number>} contexts the shim was actually injected into */
    installedContexts: new Set(),
    /** @type {Set<number>} contexts reported before the binding existed */
    pendingContexts: new Set(),
    /** @type {Map<number, number>} contextId -> frameId */
    contextFrames: new Map(),
    /** @type {Map<number, string>} frameId -> origin */
    frameOrigins: new Map(),
    /** @type {Set<number>} all contexts seen (for diagnostics/debug) */
    contexts: new Set(),
    mainFrameId: null,
    mainFrameOrigin: null,
    scriptIdentifier: null,
    timers: new Set(),
  };
  replayers.set(tabId, state);

  try {
    await cdp.sendCommand(tabId, 'Page.enable').catch(() => {});
    await cdp.sendCommand(tabId, 'Runtime.enable').catch(() => {});
    await seedFrameOrigins(tabId, state);
    await cdp.sendCommand(tabId, 'Runtime.addBinding', { name: bindingName });
    const result = await cdp.sendCommand(tabId, 'Page.addScriptToEvaluateOnNewDocument', {
      source,
      runImmediately: false,
    });
    state.scriptIdentifier = result?.identifier ?? null;
    state.bindingReady = true;
    // The current document needs the shim too: sockets opened after "Start
    // replay" (without a reload) must still be intercepted. Existing contexts
    // are installed individually so a same-origin iframe is covered as well;
    // the contextless evaluation is only a fallback for when no context was
    // reported.
    await installPendingContexts(tabId, state);
    if (state.installedContexts.size === 0) {
      await evaluate(tabId, source);
    }
  } catch (error) {
    replayers.delete(tabId);
    await teardown(tabId, state).catch(() => {});
    throw new Error(`WebSocket replay could not start: ${/** @type {any} */ (error)?.message || error}`);
  }

  return true;
}

/** @returns {string} */
function randomToken() {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  } catch {
    return Math.random().toString(36).slice(2, 14);
  }
}

/**
 * Record the tab's frame tree so subframe sockets can be checked against the
 * main frame's origin before scenario data is served to them.
 * @param {number} tabId
 * @param {object} state
 */
async function seedFrameOrigins(tabId, state) {
  try {
    const result = await cdp.sendCommand(tabId, 'Page.getFrameTree');
    applyFrameTree(state, result?.frameTree?.frame);
  } catch {
    /* frame tree is best effort */
  }
}

/**
 * @param {object} state
 * @param {any} frame
 */
function applyFrameTree(state, frame) {
  if (!frame || typeof frame.id !== 'string') return;
  const origin = originOfUrl(frame.url);
  state.frameOrigins.set(frame.id, origin);
  if (!frame.parentId) {
    state.mainFrameId = frame.id;
    if (origin) state.mainFrameOrigin = origin;
  }
}

/**
 * @param {string} url
 * @returns {string}
 */
function originOfUrl(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Is this execution context allowed to use replay data?
 *
 * Sockets are matched by endpoint, not by the frame that opened them, so a
 * frame on another origin inside the same target could otherwise pull a
 * scenario's recorded payloads. Unknown origins are allowed: they are almost
 * always about:blank/data frames that inherit the opener.
 *
 * @param {object} state
 * @param {number|null} contextId
 */
function contextAllowed(state, contextId) {
  if (contextId == null) return true;
  const frameId = state.contextFrames.get(contextId);
  if (frameId == null) return true;
  const frameOrigin = state.frameOrigins.get(frameId) ?? '';
  if (!frameOrigin || !state.mainFrameOrigin) return true;
  return frameOrigin === state.mainFrameOrigin;
}

/**
 * Install the shim into every default context that was reported before the
 * binding existed (existing same-origin iframes included).
 * @param {number} tabId
 * @param {object} state
 */
async function installPendingContexts(tabId, state) {
  const pending = [...state.pendingContexts];
  state.pendingContexts.clear();
  for (const contextId of pending) {
    await maybeInstallContext(tabId, state, contextId);
  }
}

/**
 * @param {number} tabId
 * @param {object} state
 * @param {number} contextId
 */
async function maybeInstallContext(tabId, state, contextId) {
  if (!state.bindingReady || state.live) return;
  if (!Number.isFinite(contextId) || contextId <= 0) return;
  if (state.installedContexts.has(contextId)) return;
  if (!contextAllowed(state, contextId)) return;

  try {
    // A document that navigated in already carries the shim from the injected
    // script. Re-evaluating it there would replace a working shim with one
    // whose bridge was already consumed, so check which bridge it captured.
    const probe = `globalThis[Symbol.for(${JSON.stringify(WS_SHIM_SYMBOL)})]?.bindingName ?? null`;
    const result = await evaluate(tabId, probe, contextId);
    if (result?.result?.value === state.bindingName) {
      state.installedContexts.add(contextId);
      return;
    }
    await evaluate(tabId, state.source, contextId);
    state.installedContexts.add(contextId);
  } catch {
    /* context vanished or is not scriptable */
  }
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
    for (const socket of state.sockets.values()) {
      clearSocketTimers(socket);
      void evaluate(
        tabId,
        wsShimCommand('closeSocket', [socket.connId, 1001, 'Replay stopped']),
        socket.contextId,
      ).catch(() => {});
    }
    state.sockets.clear();
    // Sockets in a context we never heard from still belong to the document.
    await evaluate(tabId, wsShimCommand('closeAll', [1001, 'Replay stopped'])).catch(() => {});
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
  // Restore the native constructor in every frame we injected into, not just
  // the main one.
  for (const contextId of state.installedContexts) {
    await evaluate(tabId, wsShimCommand('reset', []), contextId).catch(() => {});
  }
  state.installedContexts.clear();
  try {
    await evaluate(tabId, wsShimCommand('reset', []));
  } catch {
    /* page may be gone; the binding still has to be removed below */
  }
  try {
    if (state.bindingName) {
      await cdp.sendCommand(tabId, 'Runtime.removeBinding', { name: state.bindingName });
    }
  } catch {
    /* ignore */
  }
  state.contexts.clear();
  state.contextFrames.clear();
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
    if (params?.name !== state.bindingName) return false;
    const contextId = Number(params?.executionContextId);
    if (Number.isFinite(contextId)) state.contexts.add(contextId);
    if (!contextAllowed(state, Number.isFinite(contextId) ? contextId : null)) {
      state.hooks?.onWarning?.(
        state.session,
        'A WebSocket in a frame on another origin was not replayed.',
      );
      return true;
    }
    void onBindingPayload(tabId, state, params?.payload, Number.isFinite(contextId) ? contextId : null).catch(
      (error) => {
        state.hooks?.onWarning?.(state.session, `WebSocket replay error: ${error.message}`);
      },
    );
    return true;
  }

  if (method === 'Runtime.executionContextCreated') {
    const context = params?.context ?? {};
    const contextId = Number(context.id);
    const frameId = Number(context.auxData?.frameId);
    if (Number.isFinite(contextId)) {
      state.contexts.add(contextId);
      if (Number.isFinite(frameId)) state.contextFrames.set(contextId, frameId);
      if (context.auxData?.isDefault !== false) {
        if (state.bindingReady) void maybeInstallContext(tabId, state, contextId);
        else state.pendingContexts.add(contextId);
      }
    }
    return true;
  }

  if (method === 'Page.frameNavigated') {
    applyFrameTree(state, params?.frame);
    return true;
  }

  if (method === 'Runtime.executionContextsCleared') {
    // The whole document is gone: every socket in it is dead.
    for (const socket of state.sockets.values()) clearSocketTimers(socket);
    state.sockets.clear();
    state.contexts.clear();
    state.contextFrames.clear();
    state.installedContexts.clear();
    return true;
  }

  if (method === 'Runtime.executionContextDestroyed') {
    // Only that frame went away. Clearing every socket would silently stop
    // replay for the rest of the page (an iframe navigating is enough).
    const destroyed = Number(params?.executionContextId);
    if (!Number.isFinite(destroyed)) return true;
    state.contexts.delete(destroyed);
    state.contextFrames.delete(destroyed);
    state.installedContexts.delete(destroyed);
    for (const [key, socket] of [...state.sockets]) {
      if (socket.contextId !== destroyed) continue;
      clearSocketTimers(socket);
      state.sockets.delete(key);
    }
    return true;
  }

  return false;
}

/**
 * @param {number} tabId
 * @param {object} state
 * @param {string} payload
 */
async function onBindingPayload(tabId, state, payload, contextId) {
  let message;
  try {
    message = JSON.parse(String(payload ?? ''));
  } catch {
    return;
  }
  if (!message || typeof message.cmd !== 'string') return;

  switch (message.cmd) {
    case 'open':
      await onOpen(tabId, state, message, contextId);
      return;
    case 'send':
      await onSend(tabId, state, message, contextId);
      return;
    case 'close':
      closeSocket(state, contextId, message.connId);
      return;
    default:
  }
}

/**
 * @param {number} tabId
 * @param {object} state
 * @param {{connId:string, url:string, protocols?:string[]}} message
 */
async function onOpen(tabId, state, message, contextId) {
  const connId = String(message.connId ?? '');
  const url = String(message.url ?? '');
  const protocols = Array.isArray(message.protocols) ? message.protocols.map(String) : [];
  const key = socketKey(contextId, connId);

  const passthrough = async (reason, detail = {}) => {
    if (reason) {
      state.hooks?.onMiss?.(
        state.session,
        { method: 'WS', url },
        { reason, sameUrl: detail.samePath ?? 0, samePath: detail.samePath ?? 0 },
      );
    }
    await evaluate(tabId, wsShimCommand('openResult', [connId, { mock: false }]), contextId).catch(() => {});
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
    contextId,
    key,
    entryId: lookup.entry.id,
    url,
    adapter,
    plan,
    used: new Set(),
    timers: new Set(),
    keepaliveStop: null,
    closed: false,
  };
  state.sockets.set(key, socket);

  await evaluate(
    tabId,
    wsShimCommand('openResult', [
      connId,
      { mock: true, protocol: lookup.entry.negotiatedProtocol || protocols[0] || '' },
    ]),
    contextId,
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

  // Play everything the server said before the first client frame, honoring
  // the configured timing relative to the socket opening.
  for (const entry of plan.prelude) {
    const delay = deliveryDelay(
      { timing: state.settings?.wsReplayTiming, maxDelayMs: state.settings?.wsMaxFrameDelayMs },
      { offsetMs: 0 },
      entry,
    );
    scheduleDelivery(tabId, state, socket, entry, delay);
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
async function onSend(tabId, state, message, contextId) {
  const socket = state.sockets.get(socketKey(contextId, message.connId));
  if (!socket || socket.closed) return;

  const opcode = Number(message.opcode) === 2 ? 2 : 1;
  if (opcode === 2) {
    await handleOutgoingFrame(tabId, state, socket, {
      opcode: 2,
      text: null,
      base64: String(message.base64 ?? ''),
    });
    return;
  }

  const raw = String(message.text ?? '');
  // A frame may carry several logical messages (SignalR batches them with
  // `\x1e`). Match each one: live text is framed exactly as the client sends
  // it, while plan triggers are separator-free.
  const logical = socket.adapter.splitFrame(raw);
  const messages = logical.length > 0 ? logical : [raw];
  for (const text of messages) {
    if (socket.closed) return;
    await handleOutgoingFrame(tabId, state, socket, { opcode: 1, text, base64: null });
  }
}

/**
 * Answer one logical client message.
 *
 * Order matters: a control message may also be a recorded trigger (the
 * Engine.IO `5` upgrade is exactly that), so matching is attempted before
 * keepalive traffic is absorbed.
 *
 * @param {number} tabId
 * @param {object} state
 * @param {object} socket
 * @param {{opcode: number, text: string|null, base64: string|null}} frame
 */
async function handleOutgoingFrame(tabId, state, socket, frame) {
  const { opcode, text, base64 } = frame;

  if (opcode === 1) {
    const control = socket.adapter.handleControlMessage(text, {
      recordedHandshakeResponse: socket.plan?.handshakeResponse ?? undefined,
    });
    if (control && control.length > 0) {
      for (const reply of control) {
        scheduleDelivery(tabId, state, socket, { opcode: 1, text: reply, offsetMs: 0 }, 0);
      }
      return;
    }
  }

  const smartFallback = state.settings?.smartFallback !== false;
  const match = matchReplayStep(socket.plan, { opcode, text, base64 }, { smartFallback, used: socket.used });

  if (match) {
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
    return;
  }

  // Absorbed handshake/keepalive traffic is never reported as unmatched.
  if (opcode === 1 && socket.adapter.isControlOrKeepalive(text, 'send')) return;

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
  // Surface it in the page as well: a silently swallowed frame leaves callers
  // awaiting an ack that will never arrive.
  await evaluate(
    tabId,
    wsShimCommand('error', [socket.connId, 'No recorded reply for this WebSocket frame']),
    socket.contextId,
  ).catch(() => {});
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
        ? evaluate(
            tabId,
            wsShimCommand('deliver', [socket.connId, 2, null, frame.base64 ?? '']),
            socket.contextId,
          )
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
  // Plans hold logical messages; restore the protocol framing (SignalR's
  // record separator) on the way out.
  const payload = frameTextForDelivery(socket.adapter.name, text);
  return evaluate(tabId, wsShimCommand('deliver', [socket.connId, 1, payload, null]), socket.contextId);
}

/** @param {object} state @param {number|null} contextId @param {string} connId */
function closeSocket(state, contextId, connId) {
  const key = socketKey(contextId, connId);
  const socket = state.sockets.get(key);
  if (!socket) return;
  socket.closed = true;
  clearSocketTimers(socket);
  state.sockets.delete(key);
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
async function evaluate(tabId, expression, executionContextId = null) {
  /** @type {any} */
  const params = { expression, silent: true, returnByValue: true };
  // Never coerce a missing context to 0: `contextId: 0` is not "the default",
  // it is a context that does not exist, and Chrome rejects the evaluation.
  const contextId = Number(executionContextId);
  if (executionContextId != null && Number.isFinite(contextId) && contextId > 0) {
    params.contextId = contextId;
  }
  return cdp.sendCommand(tabId, 'Runtime.evaluate', params);
}
