/**
 * Socket.IO / Engine.IO protocol adapter.
 *
 * Engine.IO framing is a single leading digit (0 open, 1 close, 2 ping,
 * 3 pong, 4 message, 5 upgrade, 6 noop). A Socket.IO packet is an Engine.IO
 * message whose body starts with its own packet type (0 connect, 1 disconnect,
 * 2 event, 3 ack, 4 error, 5 binary event, 6 binary ack), optionally prefixed
 * with a namespace and followed by an ack id before the JSON payload.
 *
 * The adapter understands both Engine.IO v3 (client sends `2`, server answers
 * `3`) and v4 (server sends `2`, client answers `3`, negotiated over HTTP) so
 * recorded traffic replays online and offline.
 */

/** Engine.IO packet type digits. */
const ENGINE_OPEN = '0';
const ENGINE_CLOSE = '1';
const ENGINE_PING = '2';
const ENGINE_PONG = '3';
const ENGINE_MESSAGE = '4';
const ENGINE_UPGRADE = '5';

/** Socket.IO packet type digits (inside an Engine.IO message). */
const SIO_EVENT = '2';
const SIO_ACK = '3';
const SIO_BINARY_EVENT = '5';
const SIO_BINARY_ACK = '6';

/**
 * Parse one Engine.IO / Socket.IO text frame.
 *
 * @param {string} text
 * @returns {null|{
 *   engine: string,
 *   kind: string|null,
 *   namespace: string,
 *   ackId: string|null,
 *   data: any,
 *   rawTail: string,
 *   raw: string,
 * }}
 */
export function parseSocketIoPacket(text) {
  const raw = String(text ?? '');
  if (raw.length === 0 || !/^[0-6]$/.test(raw[0])) return null;
  const engine = raw[0];
  if (engine !== ENGINE_MESSAGE) {
    return { engine, kind: null, namespace: '/', ackId: null, data: null, rawTail: raw.slice(1), raw };
  }

  let rest = raw.slice(1);
  const kindMatch = /^([0-6])/.exec(rest);
  if (!kindMatch) {
    return { engine, kind: null, namespace: '/', ackId: null, data: null, rawTail: rest, raw };
  }
  const kind = kindMatch[1];
  rest = rest.slice(1);

  let namespace = '/';
  if (rest.startsWith('/')) {
    const comma = rest.indexOf(',');
    if (comma === -1) {
      namespace = rest;
      rest = '';
    } else {
      namespace = rest.slice(0, comma);
      rest = rest.slice(comma + 1);
    }
  }

  let ackId = null;
  const ackMatch = /^(\d+)/.exec(rest);
  if (ackMatch) {
    ackId = ackMatch[1];
    rest = rest.slice(ackMatch[0].length);
  }

  let data = null;
  if (rest) {
    try {
      data = JSON.parse(rest);
    } catch {
      data = rest;
    }
  }

  return { engine, kind, namespace, ackId, data, rawTail: rest, raw };
}

/**
 * Re-serialize a Socket.IO packet, optionally replacing its ack id.
 * The payload tail is preserved byte for byte.
 *
 * @param {{engine:string, kind:string|null, namespace:string, ackId:string|null, rawTail:string}} packet
 * @param {string|null} [ackId]
 */
export function serializeSocketIoPacket(packet, ackId = packet.ackId) {
  const namespace = packet.namespace && packet.namespace !== '/' ? `${packet.namespace},` : '';
  if (packet.kind == null) return `${packet.engine}${packet.rawTail}`;
  return `${packet.engine}${packet.kind}${namespace}${ackId ?? ''}${packet.rawTail}`;
}

/** @param {string} url @param {string[]} protocols */
function detectFromUrl(url, protocols) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (/\/socket\.io\//i.test(parsed.pathname)) return true;
  if (parsed.searchParams.has('EIO') || parsed.searchParams.get('transport') === 'websocket') return true;
  const list = Array.isArray(protocols) ? protocols : [];
  return list.some((protocol) => /^socket\.io/i.test(String(protocol)));
}

/** @param {string|null|undefined} frame */
function detectFromFrame(frame) {
  const text = String(frame ?? '');
  if (!text) return false;
  if (text === '2probe' || text === '3probe') return true;
  if (text.startsWith('0{') || text.startsWith('40')) return true;
  return false;
}

/** @param {string} text */
function jsonPreview(data) {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

/** @type {import('./index.js').WsAdapter} */
const socketio = {
  name: 'socketio',

  detect({ url, protocols, firstSentFrame, firstRecvFrame }) {
    return (
      detectFromUrl(url, protocols) ||
      detectFromFrame(firstSentFrame) ||
      detectFromFrame(firstRecvFrame)
    );
  },

  splitFrame(text) {
    const raw = String(text ?? '');
    return raw ? [raw] : [];
  },

  joinMessages(messages) {
    return (Array.isArray(messages) ? messages : []).join('');
  },

  isControlOrKeepalive(message, direction) {
    const packet = parseSocketIoPacket(message);
    if (!packet) return false;
    if (packet.engine === ENGINE_PING || packet.engine === ENGINE_PONG) return true;
    if (packet.engine === ENGINE_CLOSE) return true;
    // `0{...}` on a direct WebSocket connection is the server handshake and a
    // `5` upgrade is a trigger whose recorded pushes must be replayed, so
    // neither is noise here.
    return false;
  },

  handleControlMessage(message) {
    if (message === '2probe') return ['3probe'];
    const packet = parseSocketIoPacket(message);
    if (!packet) return null;
    if (packet.engine === ENGINE_PING) return ['3'];
    // Engine.IO v4 client pong, probe pong and upgrade requests are absorbed:
    // the server (us) drives the keepalive instead.
    if (packet.engine === ENGINE_PONG || packet.engine === ENGINE_UPGRADE) return null;
    return null;
  },

  /**
   * Engine.IO v4: the server pings, the client answers with `3`. Send the ping
   * ourselves so a replayed client never hits its ping timeout.
   */
  startKeepalive(ctx, sendServerFrame) {
    const interval = Number(ctx?.pingIntervalMs);
    if (!Number.isFinite(interval) || interval <= 0) return null;
    const timer = setInterval(() => {
      try {
        sendServerFrame('2');
      } catch {
        /* socket closed */
      }
    }, Math.max(1000, Math.min(interval, 60000)));
    return () => clearInterval(timer);
  },

  matchSignature(message) {
    const packet = parseSocketIoPacket(message);
    if (!packet || packet.engine !== ENGINE_MESSAGE) return null;
    if (packet.kind !== SIO_EVENT && packet.kind !== SIO_BINARY_EVENT) return null;

    const data = Array.isArray(packet.data) ? packet.data : [];
    const eventName = typeof data[0] === 'string' ? data[0] : '';
    const args = data.slice(1);
    return {
      key: `${packet.namespace ?? '/'}:${eventName}:${jsonPreview(args)}`,
      correlationId: packet.ackId,
    };
  },

  rewriteCorrelationId(recordedRecvMessage, recordedSendId, liveSendId) {
    if (recordedSendId == null || liveSendId == null) return recordedRecvMessage;
    const packet = parseSocketIoPacket(recordedRecvMessage);
    if (!packet) return recordedRecvMessage;
    if (packet.kind !== SIO_ACK && packet.kind !== SIO_BINARY_ACK) return recordedRecvMessage;
    if (packet.ackId !== recordedSendId) return recordedRecvMessage;
    return serializeSocketIoPacket(packet, liveSendId);
  },

  prettyPrint(text) {
    const packet = parseSocketIoPacket(text);
    if (!packet) return String(text ?? '');
    const head = [
      `engine.io ${packet.engine}`,
      packet.kind == null ? '' : `socket.io ${packet.kind}`,
      packet.namespace !== '/' ? `namespace ${packet.namespace}` : '',
      packet.ackId != null ? `ack ${packet.ackId}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (packet.data == null) return head;
    try {
      return `${head}\n${JSON.stringify(packet.data, null, 2)}`;
    } catch {
      return `${head}\n${String(packet.data)}`;
    }
  },
};

export default socketio;
