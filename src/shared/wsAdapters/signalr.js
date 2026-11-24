/**
 * ASP.NET Core SignalR (JSON protocol) adapter.
 *
 * SignalR frames are one or more JSON messages separated by the record
 * separator `\x1e` (0x1E). Messages carry a numeric `type`:
 *   1 Invocation, 2 StreamItem, 3 Completion, 4 StreamInvocation,
 *   5 CancelInvocation, 6 Ping, 7 Close.
 *
 * Text traffic uses JSON; `protocol: "messagepack"` connections switch to
 * binary frames after the JSON handshake and are replayed as opaque binary.
 */

const RECORD_SEPARATOR = '\x1e';
const HANDSHAKE_SENT = `{"protocol":"json","version":1}${RECORD_SEPARATOR}`;
const HANDSHAKE_RECV = `{}${RECORD_SEPARATOR}`;

const MESSAGE = Object.freeze({
  INVOCATION: 1,
  STREAM_ITEM: 2,
  COMPLETION: 3,
  STREAM_INVOCATION: 4,
  CANCEL_INVOCATION: 5,
  PING: 6,
  CLOSE: 7,
});

/**
 * Split a SignalR text frame into its logical messages.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSignalRMessages(text) {
  return String(text ?? '')
    .split(RECORD_SEPARATOR)
    .filter((part) => part.length > 0);
}

/**
 * Join logical messages back into one SignalR frame.
 * @param {string[]} messages
 */
export function joinSignalRMessages(messages) {
  const parts = (Array.isArray(messages) ? messages : []).map((message) => String(message ?? '')).filter(Boolean);
  return parts.length === 0 ? '' : `${parts.join(RECORD_SEPARATOR)}${RECORD_SEPARATOR}`;
}

/**
 * Parse one logical SignalR message.
 * @param {string} message
 * @returns {any|null}
 */
export function parseSignalRMessage(message) {
  const text = String(message ?? '')
    .replace(/\u001e/g, '')
    .trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Serialize one logical SignalR message, preserving compact JSON.
 * @param {any} message
 */
export function serializeSignalRMessage(message) {
  return JSON.stringify(message);
}

/** @param {string|null|undefined} frame */
function isHandshakeFrame(frame) {
  const text = String(frame ?? '');
  if (!text) return false;
  for (const message of splitSignalRMessages(text)) {
    const parsed = parseSignalRMessage(message);
    if (parsed && typeof parsed.protocol === 'string' && /messagepack|json/i.test(parsed.protocol)) return true;
  }
  return false;
}

/** @param {string} url */
function looksLikeSignalRUrl(url) {
  try {
    const parsed = new URL(url);
    return /\/negotiate\/?$/i.test(parsed.pathname) || /\/hub(\/|$)/i.test(parsed.pathname);
  } catch {
    return /\/negotiate|\/hub/i.test(String(url ?? ''));
  }
}

/** @param {any} message */
function isSignalRMessage(message) {
  return Boolean(message) && typeof message === 'object' && Number.isFinite(Number(message.type));
}

/** @type {import('./index.js').WsAdapter} */
const signalr = {
  name: 'signalr',

  detect({ url, firstSentFrame, firstRecvFrame }) {
    if (isHandshakeFrame(firstSentFrame) || isHandshakeFrame(firstRecvFrame)) return true;
    if (/signalr/i.test(String(url ?? ''))) return true;
    // A first frame that is a bare `\x1e`-terminated JSON object is a strong
    // hint even before the handshake is recorded.
    return looksLikeSignalRUrl(String(url ?? '')) && isHandshakeFrame(firstSentFrame);
  },

  splitFrame(text) {
    return splitSignalRMessages(text);
  },

  joinMessages(messages) {
    return joinSignalRMessages(messages);
  },

  isControlOrKeepalive(message, direction) {
    const parsed = parseSignalRMessage(message);
    if (!parsed) return false;
    if (typeof parsed.protocol === 'string') return true; // handshake
    const type = Number(parsed.type);
    if (type === MESSAGE.PING) return true;
    if (type === MESSAGE.CLOSE) return true;
    if (direction === 'recv' && type === MESSAGE.CANCEL_INVOCATION) return true;
    return false;
  },

  handleControlMessage(message, ctx) {
    const parsed = parseSignalRMessage(message);
    if (!parsed) return null;
    if (typeof parsed.protocol === 'string') {
      // Answer the protocol handshake. If the recorded server rejected the
      // protocol, replay its recorded error payload instead.
      const recorded = ctx?.recordedHandshakeResponse;
      if (typeof recorded === 'string' && recorded) return [recorded];
      return [HANDSHAKE_RECV];
    }
    if (Number(parsed.type) === MESSAGE.PING) return null;
    if (Number(parsed.type) === MESSAGE.CLOSE) return null;
    return null;
  },

  /**
   * SignalR clients disconnect when they hear nothing for
   * `serverTimeoutInMilliseconds` (30s by default), so a mocked connection must
   * keep pinging.
   */
  startKeepalive(ctx, sendServerFrame) {
    const interval = Number(ctx?.serverKeepaliveMs) || 15000;
    const timer = setInterval(() => {
      try {
        sendServerFrame(`{"type":6}${RECORD_SEPARATOR}`);
      } catch {
        /* socket closed */
      }
    }, Math.max(1000, interval));
    return () => clearInterval(timer);
  },

  matchSignature(message) {
    const parsed = parseSignalRMessage(message);
    if (!isSignalRMessage(parsed)) return null;
    const type = Number(parsed.type);
    if (type !== MESSAGE.INVOCATION && type !== MESSAGE.STREAM_INVOCATION) return null;
    const target = typeof parsed.target === 'string' ? parsed.target : '';
    const args = Array.isArray(parsed.arguments) ? parsed.arguments : [];
    return {
      key: `${target}:${JSON.stringify(args)}`,
      correlationId: parsed.invocationId == null ? null : String(parsed.invocationId),
      target,
    };
  },

  rewriteCorrelationId(recordedRecvMessage, recordedSendId, liveSendId) {
    if (recordedSendId == null || liveSendId == null) return recordedRecvMessage;
    const parsed = parseSignalRMessage(recordedRecvMessage);
    if (!isSignalRMessage(parsed)) return recordedRecvMessage;
    const type = Number(parsed.type);
    if (type !== MESSAGE.STREAM_ITEM && type !== MESSAGE.COMPLETION) return recordedRecvMessage;
    if (String(parsed.invocationId ?? '') !== String(recordedSendId)) return recordedRecvMessage;
    const rewritten = { ...parsed, invocationId: liveSendId };
    return serializeSignalRMessage(rewritten);
  },

  prettyPrint(text) {
    const messages = splitSignalRMessages(text);
    if (messages.length === 0) return String(text ?? '');
    return messages
      .map((message) => {
        const parsed = parseSignalRMessage(message);
        if (!parsed) return message;
        try {
          return JSON.stringify(parsed, null, 2);
        } catch {
          return message;
        }
      })
      .join(`\n${RECORD_SEPARATOR}\n`);
  },
};

export { HANDSHAKE_RECV, HANDSHAKE_SENT, MESSAGE as SIGNALR_MESSAGE, RECORD_SEPARATOR };
export default signalr;
