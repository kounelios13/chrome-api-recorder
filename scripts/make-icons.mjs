/**
 * Generates the extension icons (PNG) without any external dependency.
 * Run with: npm run icons
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  if (x < left || y < top || x > left + width || y > top + height) return false;
  const nearestX = Math.min(Math.max(x, left + radius), left + width - radius);
  const nearestY = Math.min(Math.max(y, top + radius), top + height - radius);
  return Math.hypot(x - nearestX, y - nearestY) <= radius;
}

function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/** Render one RGBA icon of `size` px, supersampled for smooth edges. */
function renderIcon(size) {
  const scale = size <= 32 ? 8 : 4;
  const big = size * scale;
  const radius = big * 0.22;
  const center = big / 2;
  const circleRadius = big * 0.34;
  const triangle = [
    center - big * 0.1,
    center - big * 0.145,
    center - big * 0.1,
    center + big * 0.145,
    center + big * 0.16,
    center,
  ];

  const canvas = new Float64Array(big * big * 4); // premultiplied RGBA
  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const index = (y * big + x) * 4;
      if (!insideRoundedRect(x, y, 0, 0, big, big, radius)) continue;

      let red = 15;
      let green = 23;
      let blue = 42;
      const distanceToCenter = Math.hypot(x - center, y - center);
      if (distanceToCenter <= circleRadius) {
        red = 220;
        green = 38;
        blue = 38;
        if (insideTriangle(x, y, ...triangle)) {
          red = 255;
          green = 255;
          blue = 255;
        }
      }
      canvas[index] = red;
      canvas[index + 1] = green;
      canvas[index + 2] = blue;
      canvas[index + 3] = 255;
    }
  }

  // Box-filter down to the requested size (premultiplied averaging).
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const source = ((y * scale + sy) * big + (x * scale + sx)) * 4;
          r += canvas[source];
          g += canvas[source + 1];
          b += canvas[source + 2];
          a += canvas[source + 3];
        }
      }
      const count = scale * scale;
      const alpha = a / count;
      const target = (y * size + x) * 4;
      if (alpha > 0) {
        pixels[target] = Math.round(r / (a / 255));
        pixels[target + 1] = Math.round(g / (a / 255));
        pixels[target + 2] = Math.round(b / (a / 255));
      }
      pixels[target + 3] = Math.round(alpha);
    }
  }
  return pixels;
}

function encodePng(size, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * size * 4, size * 4).copy(raw, y * stride + 1);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(resolve(ROOT, 'icons'), { recursive: true });
for (const size of SIZES) {
  const pixels = renderIcon(size);
  const png = encodePng(size, pixels);
  writeFileSync(resolve(ROOT, 'icons', `icon${size}.png`), png);
  console.log(`icons/icon${size}.png (${png.length} bytes)`);
}
