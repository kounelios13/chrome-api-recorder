import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeCdpFramePayload } from '../../src/shared/wsFrames.js';
import { bytesToBase64 } from '../../src/shared/bytes.js';

test('text frames are stored as UTF-8 base64 and keep their text', () => {
  const frame = decodeCdpFramePayload(1, 'hello ✓');
  assert.equal(frame.opcode, 1);
  assert.equal(frame.isText, true);
  assert.equal(frame.text, 'hello ✓');
  assert.equal(frame.size, new TextEncoder().encode('hello ✓').length);
  assert.equal(Buffer.from(frame.payload, 'base64').toString('utf8'), 'hello ✓');
});

test('binary frames are decoded from Chrome\'s base64 payload', () => {
  // Chrome sends `opcode: 2` payloads already base64-encoded.
  const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0x41, 0x7b, 0x22, 0x7d]);
  const payloadData = bytesToBase64(bytes);

  const frame = decodeCdpFramePayload(2, payloadData);
  assert.equal(frame.opcode, 2);
  assert.equal(frame.isText, false);
  assert.equal(frame.text, null);
  assert.equal(frame.size, bytes.length);
  assert.equal(frame.payload, payloadData);
  assert.deepEqual([...frame.bytes], [...bytes]);
});

test('binary frames survive the full record -> replay round trip', () => {
  const bytes = new Uint8Array([0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]);
  const recorded = decodeCdpFramePayload(2, bytesToBase64(bytes));

  // Replay hands the stored payload to the shim, which base64-decodes it.
  const delivered = Buffer.from(recorded.payload, 'base64');
  assert.deepEqual([...delivered], [...bytes]);
});

test('a non-base64 binary payload is tolerated instead of throwing', () => {
  const frame = decodeCdpFramePayload(2, 'plain text from a custom emitter');
  assert.equal(frame.opcode, 2);
  assert.equal(frame.size, Buffer.from(frame.payload, 'base64').length);
});
