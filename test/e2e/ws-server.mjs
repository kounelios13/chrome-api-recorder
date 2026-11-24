/**
 * Minimal RFC 6455 server used by the fixture server.
 *
 * The e2e suite is zero-dependency, so the WebSocket handshake and framing are
 * implemented here: handshake acceptance, masked client frames, fragmentation,
 * text/binary messages, ping/pong and close. It is intentionally small — enough
 * to exercise the recorder and the replay shim, not a general-purpose server.
 */
import { createHash, randomUUID } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/**
 * Complete the opening handshake and return the connected socket wrapper.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head bytes already read past the headers
 * @returns {WsConnection}
 */
export function acceptUpgrade(request, socket, head) {
  const key = String(request.headers['sec-websocket-key'] ?? '');
  const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
  const requestedProtocol = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  if (requestedProtocol.length > 0) headers.push(`Sec-WebSocket-Protocol: ${requestedProtocol[0]}`);

  socket.write(`${headers.join('\r\n')}\r\n\r\n`);

  const connection = new WsConnection(socket, requestedProtocol);
  if (head && head.length > 0) connection.push(head);
  return connection;
}

export class WsConnection {
  /**
   * @param {import('node:stream').Duplex} socket
   * @param {string[]} [protocols]
   */
  constructor(socket, protocols = []) {
    this.socket = socket;
    this.protocols = protocols;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.closed = false;
    /** @type {Array<(message: {opcode: number, text: string|null, data: Buffer}) => void>} */
    this.listeners = [];
    /** @type {Array<() => void>} */
    this.closeListeners = [];

    socket.on('data', (chunk) => this.push(chunk));
    socket.on('close', () => this.markClosed());
    socket.on('error', () => this.markClosed());
  }

  /** @param {(message: {opcode: number, text: string|null, data: Buffer}) => void} listener */
  onMessage(listener) {
    this.listeners.push(listener);
    return this;
  }

  /** @param {() => void} listener */
  onClose(listener) {
    this.closeListeners.push(listener);
    return this;
  }

  /** @param {Buffer|string} chunk */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    this.parse();
  }

  parse() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        length = high * 2 ** 32 + low;
        offset += 8;
      }

      const maskKey = masked
        ? (() => {
            if (this.buffer.length < offset + 4) return null;
            const key = this.buffer.subarray(offset, offset + 4);
            offset += 4;
            return key;
          })()
        : null;
      if (masked && maskKey == null) return;
      if (this.buffer.length < offset + length) return;

      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (maskKey) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= maskKey[index % 4];
        }
      }

      this.handleFrame({ fin, opcode, payload });
      if (this.closed) return;
    }
  }

  /** @param {{fin: boolean, opcode: number, payload: Buffer}} frame */
  handleFrame({ fin, opcode, payload }) {
    if (opcode === OPCODE.CLOSE) {
      if (!this.closed) {
        this.rawSend(OPCODE.CLOSE, payload.subarray(0, 2).length === 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
      }
      this.markClosed();
      this.socket.end();
      return;
    }
    if (opcode === OPCODE.PING) {
      this.rawSend(OPCODE.PONG, payload);
      return;
    }
    if (opcode === OPCODE.PONG) return;

    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    } else if (opcode === OPCODE.CONTINUATION) {
      this.fragments.push(payload);
    } else {
      return;
    }

    if (!fin) return;

    const data = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    const messageOpcode = this.fragmentOpcode ?? OPCODE.TEXT;
    this.fragments = [];
    this.fragmentOpcode = null;

    const message = {
      opcode: messageOpcode,
      text: messageOpcode === OPCODE.TEXT ? data.toString('utf8') : null,
      data,
    };
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        /* a fixture handler error must not take the server down */
      }
    }
  }

  /** @param {string|Buffer} payload */
  sendText(payload) {
    this.rawSend(OPCODE.TEXT, Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'));
  }

  /** @param {Buffer} payload */
  sendBinary(payload) {
    this.rawSend(OPCODE.BINARY, payload);
  }

  /** @param {number} code @param {string} reason */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBytes = Buffer.from(String(reason), 'utf8');
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.rawSend(OPCODE.CLOSE, payload);
    this.markClosed();
    this.socket.end();
  }

  /** @param {number} opcode @param {Buffer} payload */
  rawSend(opcode, payload) {
    if (this.closed && opcode !== OPCODE.CLOSE) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
    const length = data.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, data]));
    } catch {
      this.markClosed();
    }
  }

  markClosed() {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {
        /* ignore */
      }
    }
  }
}

/** @returns {string} */
export function createSid() {
  return randomUUID().replace(/-/g, '').slice(0, 20);
}
