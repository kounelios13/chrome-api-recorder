/**
 * WebSocket protocol adapters.
 *
 * One generic engine records and replays raw `ws://` / `wss://` traffic; these
 * adapters add protocol knowledge on top: framing, keepalives, request
 * signatures and correlation-id rewriting. They are pure modules (no Chrome,
 * no I/O) so every rule can be unit tested with `node --test`.
 *
 * @typedef {{
 *   name: string,
 *   detect(input: {url: string, protocols?: string[]|null, firstSentFrame?: string|null, firstRecvFrame?: string|null}): boolean,
 *   splitFrame(text: string): string[],
 *   joinMessages(messages: string[]): string,
 *   isControlOrKeepalive(message: string, direction: 'send'|'recv'): boolean,
 *   handleControlMessage(message: string, ctx?: object): string[]|null,
 *   startKeepalive(ctx: object, sendServerFrame: (frame: string) => void): (() => void)|null,
 *   matchSignature(message: string): {key: string, correlationId?: string|null}|null,
 *   rewriteCorrelationId(recordedRecvMessage: string, recordedSendId: string|null, liveSendId: string|null): string,
 *   prettyPrint(text: string): string,
 * }} WsAdapter
 */
import generic from './generic.js';
import signalr from './signalr.js';
import socketio from './socketio.js';

/** Order matters: the most specific protocol wins. */
export const WS_ADAPTERS = Object.freeze([socketio, signalr, generic]);

/** @type {Record<string, WsAdapter>} */
const BY_NAME = Object.freeze(
  Object.fromEntries([socketio, signalr, generic].map((adapter) => [adapter.name, adapter])),
);

/**
 * Pick the adapter for a connection.
 *
 * @param {{url: string, protocols?: string[]|string|null, firstSentFrame?: string|null, firstRecvFrame?: string|null}} input
 * @returns {WsAdapter} always returns an adapter (generic is the fallback)
 */
export function detectAdapter(input) {
  const protocols = Array.isArray(input?.protocols)
    ? input.protocols
    : typeof input?.protocols === 'string' && input.protocols
      ? [input.protocols]
      : [];
  const connection = { ...input, protocols };

  for (const adapter of WS_ADAPTERS) {
    try {
      if (adapter.detect(connection)) return adapter;
    } catch {
      /* a broken detector must never break recording */
    }
  }
  return generic;
}

/**
 * @param {string|undefined|null} name
 * @returns {WsAdapter}
 */
export function adapterByName(name) {
  return BY_NAME[String(name ?? '')] ?? generic;
}

export { generic, signalr, socketio };
