// Generates the app icons (PNG) procedurally: dark tile, gold diamond ring + "T" emblem.
import fs from 'fs'; import zlib from 'zlib';
const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(size, fn, alpha) {
  const ch = alpha ? 4 : 3, raw = Buffer.alloc((size * ch + 1) * size), SS = 4;
  for (let y = 0; y < size; y++) { raw[y * (size * ch + 1)] = 0; for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) { const c = fn(((x + (sx + 0.5) / SS) / size) * 2 - 1, ((y + (sy + 0.5) / SS) / size) * 2 - 1); for (let k = 0; k < 4; k++) acc[k] += c[k]; }
    for (let k = 0; k < ch; k++) raw[y * (size * ch + 1) + 1 + x * ch + k] = Math.round(acc[k] / (SS * SS));
  } }
  const h = Buffer.alloc(13); h.writeUInt32BE(size, 0); h.writeUInt32BE(size, 4); h[8] = 8; h[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const GOLD = [242, 182, 50], BG0 = [24, 29, 36], BG1 = [11, 13, 16];
function emblem(x, y, s) { // returns coverage 0..1 of the gold emblem at scale s
  x /= s; y /= s;
  const d = Math.abs(x) + Math.abs(y);
  const ring = d > 0.62 && d < 0.72;
  const bar = y > -0.32 && y < -0.19 && Math.abs(x) < 0.34;
  const stem = Math.abs(x) < 0.07 && y >= -0.19 && y < 0.36;
  return ring || bar || stem ? 1 : 0;
}
function tile(scale, transparentBg) {
  return (x, y) => {
    const r = Math.hypot(x, y), t = Math.min(1, r / 1.3);
    const bg = BG0.map((c, i) => c + (BG1[i] - c) * t);
    const e = emblem(x, y, scale);
    if (transparentBg) return e ? [...GOLD, 255] : [0, 0, 0, 0];
    return [...bg.map((c, i) => c + (GOLD[i] - c) * e), 255];
  };
}
export function makeIcons(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/icon-192.png`, png(192, tile(1, false), false));
  fs.writeFileSync(`${dir}/icon-512.png`, png(512, tile(1, false), false));
  fs.writeFileSync(`${dir}/icon-maskable-512.png`, png(512, tile(0.72, false), false));
}
export function makeAndroidIcons(resDir) {
  const legacy = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  const fg = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
  for (const k in legacy) {
    const d = `${resDir}/mipmap-${k}`; fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(`${d}/ic_launcher.png`, png(legacy[k], tile(0.85, false), false));
    fs.writeFileSync(`${d}/ic_launcher_round.png`, png(legacy[k], (x, y) => Math.hypot(x, y) > 1 ? [0, 0, 0, 0] : tile(0.85, false)(x, y), true));
    fs.writeFileSync(`${d}/ic_launcher_foreground.png`, png(fg[k], tile(0.62, true), true));
  }
}
if (process.argv[2] === 'web') { makeIcons('public/icons'); console.log('web icons written'); }
