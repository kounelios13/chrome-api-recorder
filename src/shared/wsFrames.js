/**
 * CDP WebSocket frame payload decoding.
 *
 * `Network.webSocketFrameSent` / `FrameReceived` carry `payloadData` as a
 * string, but Chrome already base64-encodes **binary** frames. Text frames stay
 * raw text. Getting this wrong double-encodes binary traffic: the stored
 * payload becomes the ASCII text of its own base64 and replay delivers that
 * text as bytes.
 *
 * Pure module so the encoding can be unit tested without Chrome.
 */
import { base64ToBytes, bytesToBase64, isBase64, utf8ToBytes } from './bytes.js';

/**
 * @param {number} opcode WebSocket opcode (1 = text, 2 = binary)
 * @param {string} payloadData CDP `payloadData`
 * @returns {{
 *   opcode: 1|2,
 *   isText: boolean,
 *   bytes: Uint8Array,
 *   payload: string,
 *   size: number,
 *   text: string|null,
 * }}
 */
export function decodeCdpFramePayload(opcode, payloadData) {
  const raw = typeof payloadData === 'string' ? payloadData : '';

  if (Number(opcode) === 2) {
    // Chrome's binary frames arrive base64-encoded. Tolerate a payload that is
    // not valid base64 (older/custom CDP emitters) by encoding the raw string.
    const payload = isBase64(raw) ? raw : bytesToBase64(utf8ToBytes(raw));
    let bytes;
    try {
      bytes = base64ToBytes(payload);
    } catch {
      bytes = new Uint8Array(0);
    }
    return { opcode: 2, isText: false, bytes, payload, size: bytes.length, text: null };
  }

  const bytes = utf8ToBytes(raw);
  return {
    opcode: 1,
    isText: true,
    bytes,
    payload: bytesToBase64(bytes),
    size: bytes.length,
    text: raw,
  };
}
