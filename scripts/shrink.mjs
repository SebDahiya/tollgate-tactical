// Downscale + recompress a GLB's textures (JPEG for opaque, PNG for alpha) and keep meshopt compression.
// usage: node scripts/shrink.mjs in.glb out.glb maxSize
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const [,, inp, out, maxArg] = process.argv, max = +maxArg || 512;
const doc = await io.read(inp);
let before = 0, after = 0;
for (const t of doc.getRoot().listTextures()) {
  const src = Buffer.from(t.getImage()); before += src.length;
  const meta = await sharp(src).metadata();
  const alpha = meta.hasAlpha && (await sharp(src).ensureAlpha().extractChannel(3).stats()).channels[0].min < 250;
  let img = sharp(src).resize(max, max, { fit: 'inside', withoutEnlargement: true }).toColourspace('srgb');
  const buf = alpha ? await img.png({ compressionLevel: 9, palette: false }).toBuffer() : await img.removeAlpha().jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  t.setImage(new Uint8Array(buf)).setMimeType(alpha ? 'image/png' : 'image/jpeg');
  if (t.getURI()) t.setURI(t.getURI().replace(/\.\w+$/, alpha ? '.png' : '.jpg'));
  after += buf.length;
}
await io.write(out, doc);
console.log(`${inp} -> ${out}: textures ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB (max ${max}px)`);
