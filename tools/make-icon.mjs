// Generates build/icon.ico (16..256) and build/icon.png from the same teal disc
// and white wave as the tray icon. Zero dependencies: hand-rolled PNG + ICO.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(outDir, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

// 4x4 supersampled, anti-aliased disc plus a three-pixel-thick sine wave.
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size * 0.47;
  const ss = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let disc = 0;
      let wave = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const px = x + (sx + 0.5) / ss - 0.5;
          const py = y + (sy + 0.5) / ss - 0.5;
          if (Math.hypot(px - centre, py - centre) <= radius) disc += 1;
          const t = (px - size * 0.22) / (size * 0.56);
          if (t >= 0 && t <= 1) {
            const waveY = centre + Math.sin(t * Math.PI * 4) * size * 0.1;
            if (Math.abs(py - waveY) <= size * 0.045) wave += 1;
          }
        }
      }
      const total = ss * ss;
      const a = disc / total;
      const w = Math.min(wave / total, a);
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(28 + (255 - 28) * (w / (a || 1)));
      rgba[i + 1] = Math.round(90 + (255 - 90) * (w / (a || 1)));
      rgba[i + 2] = Math.round(84 + (255 - 84) * (w / (a || 1)));
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

function png(size) {
  const rgba = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => png(s));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));
writeFileSync(path.join(outDir, 'icon.png'), images[images.length - 1]);
console.log('wrote build/icon.ico and build/icon.png');
