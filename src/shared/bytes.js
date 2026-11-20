/**
 * Small byte/string helpers shared by the background code and by the unit
 * tests. `btoa`/`atob` and `TextEncoder`/`TextDecoder` exist both in Chrome's
 * service worker and in Node >= 20, so this module stays dependency free.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/** @param {string} text */
export function utf8ToBytes(text) {
  return encoder.encode(text ?? '');
}

/** @param {Uint8Array} bytes */
export function bytesToUtf8(bytes) {
  try {
    return decoder.decode(bytes ?? new Uint8Array(0));
  } catch {
    return '';
  }
}

/** @param {Uint8Array|ArrayBuffer} bytes */
export function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(0);
}

/**
 * Base64 encode bytes without blowing the call stack on large responses.
 * @param {Uint8Array|ArrayBuffer} input
 */
export function bytesToBase64(input) {
  const bytes = toUint8Array(input);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Is this string well-formed base64 (including the empty string)?
 * @param {unknown} value
 */
export function isBase64(value) {
  if (typeof value !== 'string') return false;
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/** @param {string} base64 */
export function base64ToBytes(base64) {
  const binary = atob(base64 ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Concatenate a list of byte arrays. */
export function concatBytes(parts) {
  const list = parts.filter(Boolean);
  const total = list.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of list) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Number of bytes a string occupies as UTF-8. */
export function utf8ByteLength(text) {
  return encoder.encode(text ?? '').length;
}

/**
 * Human readable one-line preview of a request/response body.
 * @param {Uint8Array} bytes
 * @param {number} max
 */
export function bytesPreview(bytes, max = 200) {
  const text = bytesToUtf8(bytes).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Roughly is this body printable text? Used to decide how to preview bodies.
 * @param {Uint8Array} bytes
 */
export function looksLikeText(bytes) {
  if (!bytes || bytes.length === 0) return true;
  let suspicious = 0;
  const sample = bytes.subarray(0, Math.min(bytes.length, 512));
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length < 0.1;
}
