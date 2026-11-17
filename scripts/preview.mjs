// Software-rasterized previews of a GLB (no GPU needed): per-node bounding boxes + depth-shaded orthographic views.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import fs from 'fs'; import zlib from 'zlib';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const [,, file, out, viewsArg, filter] = process.argv;
const doc = await io.read(file);
const tris = [], perMesh = [];
const mul = (m, p) => [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12], m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  if (filter && !new RegExp(filter).test(mesh.getName() + '|' + node.getName())) continue;
  const W = node.getWorldMatrix(); const mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9]; let n = 0;
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION'), idx = prim.getIndices(); if (!pos) continue;
    const cnt = idx ? idx.getCount() : pos.getCount(), v = [0,0,0];
    for (let i = 0; i < cnt; i += 3) {
      const t = [];
      for (let k = 0; k < 3; k++) { pos.getElement(idx ? idx.getScalar(i + k) : i + k, v); const w = mul(W, v); t.push(w); for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], w[a]); mx[a] = Math.max(mx[a], w[a]); } }
      tris.push(t); n++;
    }
  }
  perMesh.push({ name: node.getName() + '/' + mesh.getName(), tris: n, min: mn.map(x => +x.toFixed(3)), max: mx.map(x => +x.toFixed(3)), mat: mesh.listPrimitives()[0]?.getMaterial()?.getName() });
}
for (const m of perMesh) console.log(`${m.name.padEnd(42)} tris ${String(m.tris).padStart(7)}  min ${m.min}  max ${m.max}  size ${m.max.map((x,i)=>(x-m.min[i]).toFixed(2))}  mat ${m.mat}`);
const gmn = [1e9,1e9,1e9], gmx = [-1e9,-1e9,-1e9];
for (const t of tris) for (const p of t) for (let a = 0; a < 3; a++) { gmn[a] = Math.min(gmn[a], p[a]); gmx[a] = Math.max(gmx[a], p[a]); }
console.log('TOTAL tris', tris.length, 'bbox min', gmn.map(x=>x.toFixed(3)), 'max', gmx.map(x=>x.toFixed(3)));
if (!out) process.exit(0);
// views: 'side' looks along -X (shows Z horizontally, Y up), 'front' along -Z (X horiz), 'top' along -Y (X horiz, Z vertical)
const views = (viewsArg || 'side,front,top').split(',');
const S = 360, imgs = [];
for (const v of views) {
  const ax = v === 'side' ? [2, 1, 0] : v === 'front' ? [0, 1, 2] : [0, 2, 1]; // [horiz, vert, depth]
  const flipH = v === 'side' ? -1 : 1, flipV = v === 'top' ? -1 : 1;
  const span = Math.max(gmx[ax[0]] - gmn[ax[0]], gmx[ax[1]] - gmn[ax[1]]) * 1.08, cx = (gmx[ax[0]] + gmn[ax[0]]) / 2, cy = (gmx[ax[1]] + gmn[ax[1]]) / 2;
  const zb = new Float32Array(S * S).fill(-1e9), col = new Uint8Array(S * S * 3).fill(28);
  const P = p => [S / 2 + flipH * (p[ax[0]] - cx) / span * S, S / 2 - flipV * (p[ax[1]] - cy) / span * S, p[ax[2]] * (v === 'side' ? 1 : v === 'front' ? 1 : 1)];
  const dmin = gmn[ax[2]], dmax = gmx[ax[2]];
  for (const t of tris) {
    const a = P(t[0]), b = P(t[1]), c = P(t[2]);
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(S - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(S - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const area = (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]); if (Math.abs(area) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((b[0]-px)*(c[1]-py) - (b[1]-py)*(c[0]-px)) / area, w1 = ((c[0]-px)*(a[1]-py) - (c[1]-py)*(a[0]-px)) / area, w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
      if (z > zb[y * S + x]) { zb[y * S + x] = z; const sh = 70 + 185 * (z - dmin) / Math.max(1e-6, dmax - dmin); col.set([sh * 0.95, sh, sh * 0.8], (y * S + x) * 3); }
    }
  }
  // grid ticks every 0.1 * span for scale
  imgs.push(col);
}
// compose horizontally with 4px gutters and write PNG
const Wd = S * imgs.length + 4 * (imgs.length - 1), raw = Buffer.alloc((Wd * 3 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (Wd * 3 + 1)] = 0; for (let i = 0; i < imgs.length; i++) for (let x = 0; x < S; x++) for (let k = 0; k < 3; k++) raw[y * (Wd * 3 + 1) + 1 + ((i * (S + 4)) + x) * 3 + k] = imgs[i][(y * S + x) * 3 + k]; }
const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const h = Buffer.alloc(13); h.writeUInt32BE(Wd, 0); h.writeUInt32BE(S, 4); h[8] = 8; h[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('preview ->', out, 'views', views.join(','));
