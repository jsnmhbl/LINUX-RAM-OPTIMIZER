// Genereert build/icon.png (512x512) zonder externe tools: handgeschreven PNG-encoder.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'build', 'icon.png');
const SIZE = 512;

const BG = [11, 13, 16];
const ACCENT = [200, 243, 29];
const DARK = [16, 19, 10];

function inRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// Vakje-vakje bitmap bouwen: accentvierkant met donker "L"-vorm (geheugen-balk).
const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const i = (y * SIZE + x) * 4;
    let color = BG;
    let alpha = 255;

    const cardLeft = 76;
    const cardTop = 76;
    const cardRight = SIZE - 76;
    const cardBottom = SIZE - 76;

    if (inRoundedRect(x, y, cardLeft, cardTop, cardRight, cardBottom, 46)) {
      color = ACCENT;

      // Donkere "RAM"-balk: twee horizontale balken met een verbinding links.
      const barTop = 168;
      const barBottom = 214;
      const barLeft = 140;
      const barRight = 372;
      if (inRoundedRect(x, y, barLeft, barTop, barRight, barBottom, 12)) color = DARK;

      const bar2Top = 250;
      const bar2Bottom = 296;
      const bar2Right = 300;
      if (inRoundedRect(x, y, barLeft, bar2Top, bar2Right, bar2Bottom, 12)) color = DARK;

      // Verticale verbinding links
      if (inRoundedRect(x, y, barLeft, barTop, barLeft + 34, bar2Bottom, 12)) color = DARK;
    }

    pixels[i] = color[0];
    pixels[i + 1] = color[1];
    pixels[i + 2] = color[2];
    pixels[i + 3] = alpha;
  }
}

// PNG-schrijven: filtertype 0 per rij, zlib-compressie, CRC per chunk.
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`icon geschreven: ${out} (${png.length} bytes)`);
