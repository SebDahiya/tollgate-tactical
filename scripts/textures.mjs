// Lists a GLB's textures (type, size, bytes) and which material slot uses them.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const dims = b => { if (b[0] === 0x89) return [b.readUInt32BE(16), b.readUInt32BE(20), 'png ' + b[24] + 'bit c' + b[25]]; let i = 2; while (i < b.length) { if (b[i] !== 0xff) return [0, 0, '?']; const m = b[i + 1], l = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc2) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5), 'jpeg']; i += 2 + l; } return [0, 0, '?']; };
let total = 0;
for (const t of doc.getRoot().listTextures()) {
  const img = t.getImage(); const [w, h, k] = dims(Buffer.from(img)); total += img.byteLength;
  const users = t.listParents().filter(p => p.propertyType === 'Material').map(m => m.getName()).slice(0, 2).join(',');
  console.log(`${(t.getName() || t.getURI() || '?').slice(0, 34).padEnd(34)} ${t.getMimeType().padEnd(11)} ${String(w).padStart(5)}x${String(h).padEnd(5)} ${k.padEnd(12)} ${(img.byteLength / 1024).toFixed(0).padStart(6)} KB  ${users}`);
}
console.log('textures total', (total / 1048576).toFixed(1), 'MB');
