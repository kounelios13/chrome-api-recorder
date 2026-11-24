/**
 * Pure WebSocket replay planner.
 *
 * A recorded connection is a chronological list of frames (send/recv). Replay
 * is *hybrid*: the recorded timeline is compiled into
 *   - a prelude of server frames to deliver right after the socket opens,
 *   - a list of steps (one per client frame) carrying the server frames that
 *     followed it, and
 *   - a tail of server frames after the last client frame.
 *
 * When the page sends a frame the planner finds the matching step (exact bytes
 * first, protocol signature second) and plays its server frames with relative
 * timing. Correlation ids (Socket.IO ack ids, SignalR invocation ids, generic
 * JSON request ids) are rewritten to the live values.
 *
 * Everything here is pure so the matching rules can be unit tested.
 */
import { adapterByName } from './wsAdapters/index.js';

/** @typedef {'send'|'recv'} Direction */

/**
 * @typedef {{
 *   seq: number,
 *   direction: Direction,
 *   opcode: number,
 *   offsetMs: number,
 *   text?: string|null,
 *   base64?: string|null,
 * }} ReplayFrame
 */

/**
 * @typedef {{
 *   frameSeq: number,
 *   direction: Direction,
 *   opcode: number,
 *   offsetMs: number,
 *   text: string|null,
 *   base64: string|null,
 * }} ReplayMessage
 */

/**
 * Expand a recorded frame list into logical protocol messages.
 *
 * Text frames are split by the adapter (SignalR can pack several messages in
 * one frame); binary frames stay opaque and are matched by exact bytes.
 *
 * @param {ReplayFrame[]} frames
 * @param {import('./wsAdapters/index.js').WsAdapter} adapter
 * @returns {ReplayMessage[]}
 */
export function normalizeFrames(frames, adapter) {
  const list = Array.isArray(frames) ? frames : [];
  /** @type {ReplayMessage[]} */
  const messages = [];

  for (const frame of list) {
    const seq = Number(frame?.seq) || 0;
    const direction = frame?.direction === 'send' ? 'send' : 'recv';
    const opcode = Number(frame?.opcode) === 2 ? 2 : 1;
    const offsetMs = Number(frame?.offsetMs) || 0;

    if (opcode === 2) {
      messages.push({
        frameSeq: seq,
        direction,
        opcode: 2,
        offsetMs,
        text: null,
        base64: typeof frame?.base64 === 'string' ? frame.base64 : null,
      });
      continue;
    }

    const text = typeof frame?.text === 'string' ? frame.text : '';
    if (!text) continue;
    const parts = adapter.splitFrame(text);
    for (const part of parts) {
      messages.push({ frameSeq: seq, direction, opcode: 1, offsetMs, text: part, base64: null });
    }
  }

  return messages;
}

/**
 * @param {import('./wsAdapters/index.js').WsAdapter} adapter
 * @param {ReplayMessage} message
 */
function isNoise(adapter, message) {
  if (message.direction !== 'recv' || message.text == null) return false;
  if (adapter.isControlOrKeepalive(message.text, 'recv')) return true;
  // The SignalR handshake reply is synthesized when the client handshake is
  // answered; replaying the recorded copy as well would duplicate it.
  if (adapter.name === 'signalr' && message.text.trim() === '{}') return true;
  return false;
}

/**
 * Compile a recorded connection into a replay plan.
 *
 * @param {{frames: ReplayFrame[], adapter: string}} input
 * @returns {{
 *   adapter: string,
 *   prelude: ReplayMessage[],
 *   steps: Array<{
 *     index: number,
 *     trigger: ReplayMessage,
 *     signature: {key: string, correlationId?: string|null}|null,
 *     responses: ReplayMessage[],
 *     startOffsetMs: number,
 *   }>,
 * }}
 */
export function compileReplayPlan({ frames, adapter }) {
  const impl = adapterByName(adapter);
  const messages = normalizeFrames(frames, impl).filter((message) => !isNoise(impl, message));

  /** @type {ReplayMessage[]} */
  const prelude = [];
  /** @type {Array<{index:number, trigger:ReplayMessage, signature:any, responses:ReplayMessage[], startOffsetMs:number}>} */
  const steps = [];

  let current = null;

  for (const message of messages) {
    if (message.direction === 'send') {
      current = {
        index: steps.length,
        trigger: message,
        signature: message.text != null ? impl.matchSignature(message.text) : null,
        responses: [],
        startOffsetMs: message.offsetMs,
      };
      steps.push(current);
      continue;
    }

    if (current) current.responses.push(message);
    else prelude.push(message);
  }

  return {
    adapter: impl.name,
    prelude,
    steps,
  };
}

/** @param {import('./wsAdapters/index.js').WsAdapter} adapter @param {ReplayMessage} message */
function signatureOf(adapter, message) {
  if (message.text == null) return null;
  try {
    return adapter.matchSignature(message.text);
  } catch {
    return null;
  }
}

/**
 * Find the recorded step that answers a live client frame.
 *
 * Exact text/binary match wins. With `smartFallback` a protocol signature match
 * (event name + arguments, SignalR target + arguments, generic discriminator)
 * is accepted. Steps already used by this connection are skipped so repeated
 * requests pick successive recordings.
 *
 * @param {{adapter:string, steps:Array<{index:number, trigger:ReplayMessage, signature:any, responses:ReplayMessage[]}>}} plan
 * @param {{text: string|null, base64: string|null, opcode: number}} live
 * @param {{smartFallback?: boolean, used?: Set<number>}} [options]
 * @returns {{step: any, matchedVia: 'exact'|'signature', liveSignature: any}|null}
 */
export function matchReplayStep(plan, live, { smartFallback = true, used } = {}) {
  const impl = adapterByName(plan?.adapter);
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const isUsed = (step) => Boolean(used?.has(step.index));

  for (const step of steps) {
    if (isUsed(step)) continue;
    if (live.opcode === 2) {
      if (step.trigger.opcode === 2 && step.trigger.base64 === live.base64) {
        return { step, matchedVia: 'exact', liveSignature: null };
      }
      continue;
    }
    if (step.trigger.opcode !== 1) continue;
    if (typeof live.text === 'string' && step.trigger.text === live.text) {
      return { step, matchedVia: 'exact', liveSignature: null };
    }
  }

  if (!smartFallback || live.opcode === 2 || typeof live.text !== 'string') return null;

  const liveSignature = signatureOf(impl, { text: live.text, opcode: live.opcode, direction: 'send' });
  if (!liveSignature) return null;

  for (const step of steps) {
    if (isUsed(step)) continue;
    if (!step.signature || step.trigger.opcode !== 1) continue;
    if (step.signature.key === liveSignature.key) {
      return { step, matchedVia: 'signature', liveSignature };
    }
  }
  return null;
}

/**
 * Apply the connection's correlation-id rewrite to the recorded responses of a
 * matched step.
 *
 * @param {string} adapterName
 * @param {any} step
 * @param {any} liveSignature
 * @returns {ReplayMessage[]}
 */
export function prepareResponses(adapterName, step, liveSignature) {
  const impl = adapterByName(adapterName);
  const recordedId = step?.signature?.correlationId ?? null;
  const liveId = liveSignature?.correlationId ?? null;
  const responses = Array.isArray(step?.responses) ? step.responses : [];
  if (recordedId == null || liveId == null || String(recordedId) === String(liveId)) return responses;

  return responses.map((message) => {
    if (message.text == null) return message;
    try {
      const text = impl.rewriteCorrelationId(message.text, recordedId, liveId);
      return text === message.text ? message : { ...message, text };
    } catch {
      return message;
    }
  });
}

/**
 * Delay before a server frame is delivered.
 *
 * @param {{timing?: string, maxDelayMs?: number}} options
 * @param {{offsetMs: number}} trigger start of the client step
 * @param {{offsetMs: number}} response recorded server frame
 */
export function deliveryDelay({ timing = 'capped', maxDelayMs = 1500 } = {}, trigger, response) {
  const relative = Math.max(0, (Number(response?.offsetMs) || 0) - (Number(trigger?.offsetMs) || 0));
  if (timing === 'instant') return 0;
  if (timing === 'original') return relative;
  const cap = Number.isFinite(Number(maxDelayMs)) ? Math.max(0, Number(maxDelayMs)) : 1500;
  return Math.min(relative, cap);
}

/**
 * Synthesize the reply to a Socket.IO namespace connect (`40`) when the
 * recording has no connect exchange (e.g. only raw WS frames were captured).
 *
 * @param {string|null} liveText
 */
export function synthesizeSocketIoConnect(liveText) {
  const match = /^40(\/[^,]*)?(,?)(.*)$/.exec(String(liveText ?? ''));
  if (!match) return null;
  const namespace = match[1] ?? '';
  const sid = 'replay-sid';
  return namespace ? `40${namespace},${JSON.stringify({ sid })}` : `40${JSON.stringify({ sid })}`;
}
