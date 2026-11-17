import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { openRelay } from './net.js';

const HEADLESS = !!globalThis.__HEADLESS;
const $ = id => document.getElementById(id);
const setLoad = t => { const e = $('loadMsg'); if (e) e.textContent = t; };
const tick = () => new Promise(r => setTimeout(r, 0));

/* =====================================================================
   CONSTANTS & UTILS
   ===================================================================== */
const BX = 45, BZ = 62;
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const angleDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const YAX = V3(0, 1, 0);
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const TOUCH = !globalThis.__HEADLESS && ((window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window);
const IS_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

let now = 0, state = 'loading', paused = false;

// ---------- tactical round rules ----------
const ROUNDS_TO_WIN = 7, HALF_ROUNDS = 6;
const BUY_TIME = 20, ROUND_TIME = 100, CHARGE_TIME = 40, PLANT_TIME = 4, DEFUSE_TIME = 7, END_TIME = 5;
const RUN_SPEED = 5.4, WALK_MUL = 0.56, CROUCH_MUL = 0.5;
const ECON = { start: 800, win: 3000, loss: [1900, 2400, 2900], kill: 200, plant: 300, max: 9000 };
const ARMOR = { light: { name: 'LIGHT ARMOR', price: 400, val: 25 }, heavy: { name: 'HEAVY ARMOR', price: 1000, val: 50 } };
const UTIL = { smoke: { name: 'SMOKE GRENADE', price: 300, max: 1 }, flash: { name: 'FLASHBANG', price: 250, max: 2 } };
// dmg rows: [max range m, head, body, leg]; errors are cone radii in radians
const WEAPONS = {
  knife:  { id: 'knife', name: 'COMBAT KNIFE', short: 'KNIFE', slot: 'melee', price: 0, melee: true, move: 1.25, equip: 0.4 },
  pistol: { id: 'pistol', name: 'P-12 SIDEARM', short: 'P-12', slot: 'side', price: 0, auto: false, rate: 6.5, mag: 12, reserve: 36, reload: 1.75, equip: 0.6, move: 1.06,
    dmg: [[30, 78, 26, 22], [999, 66, 22, 18]], err: 0.006, runErr: 0.035, airErr: 0.12, spray: 0.004, up: 0.012, upShots: 3, sway: 0.006, recover: 0.32, pen: 0.25, range: 28, sound: 'pistol' },
  magnum: { id: 'magnum', name: 'VX-6 MAGNUM', short: 'VX-6', slot: 'side', price: 800, auto: false, rate: 4, mag: 6, reserve: 24, reload: 2.25, equip: 0.75, move: 1.06,
    dmg: [[30, 159, 55, 46], [999, 145, 50, 42]], err: 0.004, runErr: 0.06, airErr: 0.15, spray: 0.012, up: 0.045, upShots: 2, sway: 0.008, recover: 0.42, pen: 0.8, range: 42, sound: 'magnum' },
  smg:    { id: 'smg', name: 'WASP SMG', short: 'WASP', slot: 'primary', price: 1600, auto: true, rate: 13.3, mag: 30, reserve: 90, reload: 2.25, equip: 0.75, move: 1.0,
    dmg: [[20, 78, 26, 22], [999, 66, 22, 18]], err: 0.008, runErr: 0.022, airErr: 0.1, spray: 0.0025, up: 0.006, upShots: 6, sway: 0.012, recover: 0.3, pen: 0.3, ads: true, range: 30, sound: 'smg' },
  rifle:  { id: 'rifle', name: 'KR-9 CARBINE', short: 'KR-9', slot: 'primary', price: 2900, auto: true, rate: 9.75, mag: 25, reserve: 50, reload: 2.5, equip: 1.0, move: 1.0,
    dmg: [[999, 160, 40, 34]], err: 0.0044, runErr: 0.1, airErr: 0.2, spray: 0.0042, up: 0.011, upShots: 8, sway: 0.018, recover: 0.375, pen: 0.8, ads: true, range: 60, sound: 'rifle' },
  ar:     { id: 'ar', name: 'AR-7 SUPPRESSED', short: 'AR-7', slot: 'primary', price: 2900, auto: true, rate: 11, mag: 30, reserve: 60, reload: 2.5, equip: 1.0, move: 1.0, silenced: true,
    dmg: [[15, 156, 39, 33], [30, 140, 35, 29], [999, 124, 31, 26]], err: 0.004, runErr: 0.09, airErr: 0.2, spray: 0.0035, up: 0.009, upShots: 8, sway: 0.014, recover: 0.33, pen: 0.8, ads: true, range: 50, sound: 'silenced' },
  sniper: { id: 'sniper', name: 'VSS VINTOREZ', short: 'VSS', slot: 'primary', price: 2900, auto: false, rate: 4, mag: 10, reserve: 30, reload: 2.6, equip: 1.0, move: 0.97, silenced: true,
    dmg: [[999, 190, 70, 58]], err: 0.03, scopeErr: 0.0012, runErr: 0.12, airErr: 0.25, spray: 0.002, up: 0.02, upShots: 3, sway: 0.006, recover: 0.35, pen: 1.0, scope: true, range: 80, sound: 'silenced' },
};
function dmgAt(W, dist, part) {
  let row = W.dmg[W.dmg.length - 1];
  for (const r of W.dmg) if (dist <= r[0]) { row = r; break; }
  return part === 'head' ? row[1] : part === 'leg' ? row[3] : row[2];
}

const QUALITY = {
  low:    { post: false, ao: false, bloom: false, shadow: 1024, grass: 0.35, pr: 1 },
  medium: { post: true,  ao: false, bloom: true,  shadow: 2048, grass: 0.65, pr: 1.25 },
  high:   { post: true,  ao: true,  bloom: true,  shadow: 4096, grass: 1.0,  pr: 1.5 },
};
let qName = TOUCH ? 'medium' : 'high';
try { const s = localStorage.getItem('tollgate-quality'); if (QUALITY[s]) qName = s; } catch (e) {}
let Q = QUALITY[qName];

/* =====================================================================
   PHYSICS
   ===================================================================== */
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 60;
const G_STATIC = 1, G_PROP = 2, G_RAG = 4, G_CHAR = 8, G_DEBRIS = 16;
const GRP = (member, filter) => ((member * 65536) + (filter & 0xffff)) >>> 0;
const QUERY_DYN = GRP(0xffff, G_PROP | G_RAG);
const fixedBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0).setCollisionGroups(GRP(G_STATIC, 0xffff)).setFriction(0.9), fixedBody);

/* =====================================================================
   RENDERER / SCENE / LIGHT
   ===================================================================== */
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pr));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xbfcbd4, 0.0052);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 1500);
camera.rotation.order = 'YXZ';
scene.add(camera);

// sun placed where it is in the HDRI (assets/sky_bridge_1k.hdr): azimuth 0.528 rad, elevation 18 deg
const SUN_EL = 18.1 * Math.PI / 180, SUN_AZ = 0.528;
const SUN_DIR = V3(Math.cos(SUN_EL) * Math.cos(SUN_AZ), Math.sin(SUN_EL), Math.cos(SUN_EL) * Math.sin(SUN_AZ)).normalize();
const sun = new THREE.DirectionalLight(0xfff0da, 3.3);
sun.castShadow = true;
sun.shadow.mapSize.set(Q.shadow, Q.shadow);
const SHADOW_R = 70;
Object.assign(sun.shadow.camera, { left: -SHADOW_R, right: SHADOW_R, top: SHADOW_R, bottom: -SHADOW_R, near: 1, far: 320 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.025;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xcfe0ee, 0x4a5530, 0.35);
scene.add(hemi);
const muzzleLight = new THREE.PointLight(0xffc070, 0, 10, 2);
muzzleLight.position.set(0.25, -0.1, -0.9);
camera.add(muzzleLight);

// physically based sky
const sky = new Sky();
sky.scale.setScalar(5000);
sky.material.fragmentShader = 'uniform float skyScale;\n' + sky.material.fragmentShader.replace('gl_FragColor = vec4( retColor, 1.0 );', 'gl_FragColor = vec4( retColor * skyScale, 1.0 );');
Object.assign(sky.material.uniforms, { skyScale: { value: 0.62 } });
sky.material.uniforms.turbidity.value = 3.6;
sky.material.uniforms.rayleigh.value = 1.25;
sky.material.uniforms.mieCoefficient.value = 0.004;
sky.material.uniforms.mieDirectionalG.value = 0.82;
sky.material.uniforms.sunPosition.value.copy(SUN_DIR);
scene.add(sky);

// weapon scene (rendered on top, never clips walls)
const weaponScene = new THREE.Scene();
const weaponCam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 10);
weaponScene.add(new THREE.HemisphereLight(0xdfe9f2, 0x4a4a3a, 0.5));
const wsun = new THREE.DirectionalLight(0xfff0d8, 2.4); wsun.position.set(-1, 2, 1.5); weaponScene.add(wsun);

function buildEnvironment() {
  if (HEADLESS) return;
  // soft gradient environment (no blinding sun disk) for image-based lighting
  const es = new THREE.Scene();
  const g = new THREE.SphereGeometry(10, 48, 24);
  const pa = g.attributes.position, cols = [];
  const zen = new THREE.Color(0.16, 0.3, 0.62), hor = new THREE.Color(0.62, 0.68, 0.74), gnd = new THREE.Color(0.11, 0.13, 0.07);
  for (let i = 0; i < pa.count; i++) {
    const y = pa.getY(i) / 10, c = new THREE.Color();
    if (y >= 0) c.copy(hor).lerp(zen, Math.pow(y, 0.6)); else c.copy(hor).lerp(gnd, Math.min(1, -y * 4));
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  es.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sunBlob = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 6.2, 5) }));
  sunBlob.position.copy(SUN_DIR).multiplyScalar(8); es.add(sunBlob);
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromScene(es, 0.02).texture;
  scene.environment = env; weaponScene.environment = env;
  // match the fog to the actual rendered sky horizon
  const rt = new THREE.WebGLRenderTarget(8, 8, { type: THREE.FloatType });
  const sc = new THREE.Scene(); const sk2 = sky.clone(); sc.add(sk2);
  const cam = new THREE.PerspectiveCamera(25, 1, 0.1, 10000);
  const buf = new Float32Array(8 * 8 * 4); const acc = [0, 0, 0]; let n = 0;
  for (let a = 0; a < 8; a++) {
    const az = a / 8 * TAU; cam.position.set(0, 0, 0); cam.lookAt(Math.cos(az), 0.03, Math.sin(az));
    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(sc, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, 8, 8, buf);
    for (let i = 0; i < 64; i++) { acc[0] += buf[i * 4]; acc[1] += buf[i * 4 + 1]; acc[2] += buf[i * 4 + 2]; n++; }
  }
  renderer.setRenderTarget(null);
  if (n && isFinite(acc[0]) && acc[0] > 0) scene.fog.color.setRGB(acc[0] / n, acc[1] / n, acc[2] / n, THREE.LinearSRGBColorSpace);
  rt.dispose();
  // real HDRI lighting (Poly Haven, CC0). Needs the page served over http; falls back to the gradient above.
  new RGBELoader().load('assets/sky_bridge_1k.hdr', tex => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const hdrEnv = pm.fromEquirectangular(tex).texture;
    scene.environment = hdrEnv; weaponScene.environment = hdrEnv;
    tex.dispose(); env.dispose();
  }, undefined, () => console.warn('HDRI not loaded (open via http://localhost) - using procedural environment'));
}

/* =====================================================================
   POST PROCESSING
   ===================================================================== */
class WeaponPass extends Pass {
  constructor() { super(); this.needsSwap = false; }
  render(r, writeBuffer, readBuffer) {
    const ac = r.autoClear; r.autoClear = false;
    r.setRenderTarget(this.renderToScreen ? null : readBuffer);
    r.clearDepth(); r.render(weaponScene, weaponCam);
    r.autoClear = ac;
  }
}
let composer = null, gtaoPass = null, bloomPass = null, weaponPass = null;
function buildComposer() {
  if (HEADLESS) return;
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  gtaoPass = new GTAOPass(scene, camera, innerWidth, innerHeight);
  gtaoPass.output = GTAOPass.OUTPUT.Default;
  gtaoPass.blendIntensity = 0.9;
  gtaoPass.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.6, thickness: 1.2, scale: 1.25, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false });
  gtaoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  const ov = gtaoPass.overrideVisibility.bind(gtaoPass);
  gtaoPass.overrideVisibility = function () { ov(); scene.traverse(o => { if (o.isSprite || o.userData.noAO) o.visible = false; }); };
  const ss = gtaoPass.setSize.bind(gtaoPass);
  gtaoPass.setSize = (w, h) => ss(Math.max(1, w * 0.5 | 0), Math.max(1, h * 0.5 | 0)); // half-res AO
  composer.addPass(gtaoPass);
  weaponPass = new WeaponPass(); composer.addPass(weaponPass);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.32, 0.55, 0.9);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  composer.addPass(new SMAAPass(innerWidth, innerHeight));
}

/* =====================================================================
   PROCEDURAL TEXTURES
   ===================================================================== */
function hash2(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, px, py, s) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px, y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
  const a = hash2(x0, y0, s), b = hash2(x1, y0, s), c = hash2(x0, y1, s), d = hash2(x1, y1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(u, v, oct, bx, by, s) {
  let sum = 0, amp = 0.5, norm = 0, fx = bx, fy = by;
  for (let i = 0; i < oct; i++) { sum += amp * vnoise(u * fx, v * fy, fx, fy, s + i * 31); norm += amp; amp *= 0.5; fx *= 2; fy *= 2; }
  return sum / norm;
}
function makeCanvas(size) { const c = document.createElement('canvas'); c.width = c.height = size; return c; }
function genTex(size, fn, { normal = 0, post = null, repeat = 1 } = {}) {
  const c = makeCanvas(size), g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  const H = normal ? new Float32Array(size * size) : null, o = [0, 0, 0, 0];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    o[3] = 0; fn(x / size, y / size, o, x, y);
    const i = (y * size + x) * 4;
    d[i] = clamp(o[0], 0, 1) * 255; d[i + 1] = clamp(o[1], 0, 1) * 255; d[i + 2] = clamp(o[2], 0, 1) * 255; d[i + 3] = 255;
    if (H) H[y * size + x] = o[3];
  }
  g.putImageData(img, 0, 0);
  if (post) post(g, size);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace; map.wrapS = map.wrapT = THREE.RepeatWrapping; map.anisotropy = 8; map.repeat.set(repeat, repeat);
  let normalMap = null;
  if (H) {
    const nc = makeCanvas(size), ng = nc.getContext('2d'), ni = ng.createImageData(size, size), nd = ni.data;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const l = H[y * size + (x - 1 + size) % size], r = H[y * size + (x + 1) % size];
      const u = H[((y - 1 + size) % size) * size + x], dn = H[((y + 1) % size) * size + x];
      let nx = (l - r) * normal, ny = (dn - u) * normal, nz = 1; const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4; nd[i] = (nx * 0.5 + 0.5) * 255; nd[i + 1] = (ny * 0.5 + 0.5) * 255; nd[i + 2] = (nz * 0.5 + 0.5) * 255; nd[i + 3] = 255;
    }
    ng.putImageData(ni, 0, 0);
    normalMap = new THREE.CanvasTexture(nc);
    normalMap.colorSpace = THREE.NoColorSpace; normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping; normalMap.repeat.set(repeat, repeat);
  }
  return { map, normalMap };
}
function canvasTex(w, h, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeatX !== 1 || repeatY !== 1) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeatX, repeatY); }
  return t;
}

const TX = {};
function buildTextures() {
  TX.grass = genTex(512, (u, v, o, x, y) => {
    const n1 = fbm(u, v, 4, 4, 4, 1), sp = hash2(x, y, 9), dry = smooth(0.6, 0.76, fbm(u, v, 3, 3, 3, 5));
    let r = 0.2 + n1 * 0.12, g = 0.33 + n1 * 0.15, b = 0.1 + n1 * 0.05;
    r = lerp(r, 0.45, dry * 0.55); g = lerp(g, 0.42, dry * 0.45); b = lerp(b, 0.2, dry * 0.45);
    const k = 0.78 + sp * 0.4; o[0] = r * k; o[1] = g * k; o[2] = b * k; o[3] = sp * 0.7 + n1 * 0.3;
  }, { normal: 2.2 });
  TX.asphalt = genTex(512, (u, v, o, x, y) => {
    const n = fbm(u, v, 4, 6, 6, 3), sp = hash2(x, y, 4), st = smooth(0.62, 0.8, fbm(u, v, 3, 3, 3, 8));
    let c = 0.22 + n * 0.08 + (sp - 0.5) * 0.1; c *= 1 - st * 0.3;
    o[0] = c; o[1] = c * 1.01; o[2] = c * 1.04; o[3] = sp;
  }, { normal: 2.5, post: (g, s) => {
    g.strokeStyle = 'rgba(18,18,18,.85)';
    for (let k = 0; k < 9; k++) {
      let x = Math.random() * s, y = Math.random() * s, a = Math.random() * TAU;
      g.lineWidth = rand(0.8, 2.2); g.beginPath(); g.moveTo(x, y);
      for (let i = 0; i < 40; i++) { a += rand(-0.6, 0.6); x += Math.cos(a) * 6; y += Math.sin(a) * 6; g.lineTo(x, y); }
      g.stroke();
    }
  } });
  TX.concrete = genTex(512, (u, v, o, x, y) => {
    const n = fbm(u, v, 5, 4, 4, 6), sp = hash2(x, y, 7), pit = sp > 0.994 ? 0.55 : 1;
    const c = (0.6 + (n - 0.5) * 0.24 + (sp - 0.5) * 0.06) * pit;
    o[0] = c; o[1] = c * 0.985; o[2] = c * 0.95; o[3] = n * 0.6 + sp * 0.25 - (pit < 1 ? 1 : 0);
  }, { normal: 2 });
  TX.paint = genTex(256, (u, v, o, x, y) => {
    const n = fbm(u, v, 4, 4, 4, 11), st = fbm(u, v, 4, 24, 2, 13), sp = hash2(x, y, 2);
    const c = 0.92 + (n - 0.5) * 0.12 - smooth(0.55, 0.85, st) * 0.2 - (sp > 0.997 ? 0.3 : 0);
    o[0] = c; o[1] = c * 0.98; o[2] = c * 0.95; o[3] = n * 0.3;
  }, { normal: 1 });
  TX.rust = genTex(512, (u, v, o) => {
    const corr = 0.5 + 0.5 * Math.sin(u * TAU * 14), n = fbm(u, v, 5, 4, 4, 12);
    const rs = smooth(0.48, 0.66, n + (1 - v) * 0.1);
    const k = 0.82 + corr * 0.2;
    o[0] = lerp(0.52, 0.4, rs) * k; o[1] = lerp(0.18, 0.23, rs) * k; o[2] = lerp(0.12, 0.12, rs) * k; o[3] = corr * 1.4 + n * 0.15;
  }, { normal: 3 });
  TX.bark = genTex(256, (u, v, o) => {
    const s = fbm(u, v, 5, 8, 2, 21), c = 0.22 + s * 0.22;
    o[0] = c * 1.12; o[1] = c * 0.86; o[2] = c * 0.64; o[3] = s;
  }, { normal: 4 });
  TX.fabric = genTex(128, (u, v, o, x, y) => {
    const w = 0.5 + 0.5 * Math.sin(u * TAU * 32) * Math.sin(v * TAU * 32), sp = hash2(x, y, 3);
    const c = 0.86 + w * 0.12 + (sp - 0.5) * 0.06; o[0] = o[1] = o[2] = c; o[3] = w;
  }, { normal: 1.2 });
  TX.fur = genTex(128, (u, v, o, x, y) => {
    const s = fbm(u, v, 3, 16, 4, 41), sp = hash2(x, y, 5); const c = 0.7 + s * 0.3 + (sp - 0.5) * 0.2;
    o[0] = o[1] = o[2] = c; o[3] = s + sp * 0.5;
  }, { normal: 3 });
  TX.leaf = canvasTex(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 46; i++) {
      const x = rand(26, w - 26), y = rand(26, h - 26), a = rand(0, TAU), L = rand(16, 28);
      g.save(); g.translate(x, y); g.rotate(a);
      g.fillStyle = `hsl(${rand(85, 112)},${rand(35, 55)}%,${rand(20, 38)}%)`;
      g.beginPath(); g.ellipse(0, 0, L, L * 0.42, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(200,220,150,.25)'; g.lineWidth = 1; g.beginPath(); g.moveTo(-L, 0); g.lineTo(L, 0); g.stroke();
      g.restore();
    }
  });
  TX.stripe = canvasTex(128, 16, (g, w, h) => { for (let x = 0; x < w; x += 32) { g.fillStyle = '#c9262b'; g.fillRect(x, 0, 16, h); g.fillStyle = '#efefe9'; g.fillRect(x + 16, 0, 16, h); } }, 3, 1);
  TX.hazard = canvasTex(64, 64, (g, w, h) => { g.fillStyle = '#e0b52a'; g.fillRect(0, 0, w, h); g.fillStyle = '#1a1a1a'; for (let i = -64; i < 128; i += 22) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 11, 0); g.lineTo(i + 11 - 64, 64); g.lineTo(i - 64, 64); g.fill(); } }, 4, 1);
  TX.flash = canvasTex(128, 128, (g) => {
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,235,1)'); grd.addColorStop(0.3, 'rgba(255,205,110,.95)'); grd.addColorStop(1, 'rgba(255,130,30,0)');
    g.fillStyle = grd; g.beginPath();
    for (let i = 0; i < 16; i++) { const a = i / 16 * TAU, r = i % 2 ? 20 : 63; g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); }
    g.closePath(); g.fill();
  });
  TX.smoke = canvasTex(64, 64, (g) => { const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32); grd.addColorStop(0, 'rgba(255,255,255,.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = grd; g.fillRect(0, 0, 64, 64); });
  TX.hole = canvasTex(64, 64, (g) => {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 30); grd.addColorStop(0, 'rgba(10,10,10,1)'); grd.addColorStop(0.28, 'rgba(25,22,20,.95)'); grd.addColorStop(0.5, 'rgba(60,55,50,.45)'); grd.addColorStop(1, 'rgba(60,55,50,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  });
}

/* =====================================================================
   MATERIALS & GEOMETRY HELPERS
   ===================================================================== */
const matCache = new Map();
function M(color, o = {}) {
  const k = color + '|' + JSON.stringify(o);
  if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...o }));
  return matCache.get(k);
}
function texMat(tex, color, o = {}, ns = 0.7) {
  return new THREE.MeshStandardMaterial({ color, map: tex.map, normalMap: tex.normalMap, normalScale: new THREE.Vector2(ns, ns), roughness: 0.85, ...o });
}
const fabCache = new Map();
function fab(color, rough = 0.92) {
  const k = color + rough;
  if (!fabCache.has(k)) fabCache.set(k, texMat(TX.fabric, color, { roughness: rough }, 0.5));
  return fabCache.get(k);
}
const MAT = {};
function buildMaterials() {
  MAT.concrete = texMat(TX.concrete, 0xffffff, { roughness: 0.9 }, 0.8);
  MAT.asphalt = texMat(TX.asphalt, 0xffffff, { roughness: 0.93 }, 0.9);
  MAT.orange = texMat(TX.paint, 0xd8891c, { roughness: 0.5, metalness: 0.2 }, 0.4);
  MAT.orangeDk = texMat(TX.paint, 0x9e5c18, { roughness: 0.6, metalness: 0.2 }, 0.4);
  MAT.yellow = texMat(TX.paint, 0xdca42a, { roughness: 0.48, metalness: 0.25 }, 0.4);
  MAT.galv = texMat(TX.paint, 0xb3b8ba, { roughness: 0.32, metalness: 0.85, side: THREE.DoubleSide }, 0.3);
  MAT.steel = M('#8f9598', { roughness: 0.4, metalness: 0.8 });
  MAT.rust = texMat(TX.rust, 0xffffff, { roughness: 0.75, metalness: 0.35 }, 1.0);
  MAT.wood = texMat(TX.bark, 0xd9b48a, { roughness: 0.85 }, 0.6);
  MAT.bark = texMat(TX.bark, 0xffffff, { roughness: 0.95 }, 1.0);
  MAT.rubber = M('#151515', { roughness: 0.92 });
  MAT.chrome = M('#d9dcde', { roughness: 0.18, metalness: 1 });
  MAT.glass = new THREE.MeshPhysicalMaterial({ color: 0x9fb4bb, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.3, envMapIntensity: 2.2, depthWrite: false });
  MAT.carGlass = new THREE.MeshPhysicalMaterial({ color: 0x1c2428, roughness: 0.06, metalness: 0.3, clearcoat: 1, envMapIntensity: 1.6 });
  MAT.shard = new THREE.MeshPhysicalMaterial({ color: 0xb8ccd2, roughness: 0.05, transparent: true, opacity: 0.55, envMapIntensity: 2 });
  MAT.leaf = new THREE.MeshStandardMaterial({ map: TX.leaf, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 });
  MAT.glow = new THREE.MeshBasicMaterial({ color: 0xfff2d0, toneMapped: false });
  MAT.brass = M('#c9a14a', { roughness: 0.3, metalness: 1 });
  MAT.hazard = new THREE.MeshStandardMaterial({ map: TX.hazard, roughness: 0.7 });
  MAT.stripe = new THREE.MeshStandardMaterial({ map: TX.stripe, roughness: 0.45, metalness: 0.1 });
  MAT.fur = (c) => texMat(TX.fur, c, { roughness: 1 }, 1.2);
}

const geoCache = new Map();
function scaleBoxUV(g, w, h, d, s) {
  const uv = g.attributes.uv, per = uv.count / 6, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let i = 0; i < per; i++) { const k = f * per + i; uv.setXY(k, uv.getX(k) * dims[f][0] / s, uv.getY(k) * dims[f][1] / s); }
}
function boxGeo(w, h, d, r = 0, uvs = 0) {
  const k = [w, h, d, r, uvs].map(v => v.toFixed(4)).join(',');
  if (!geoCache.has(k)) {
    const rr = Math.min(r, Math.min(w, h, d) / 2 - 0.0005);
    const g = rr > 0.001 ? new RoundedBoxGeometry(w, h, d, 2, rr) : new THREE.BoxGeometry(w, h, d);
    if (uvs) scaleBoxUV(g, w, h, d, uvs);
    geoCache.set(k, g);
  }
  return geoCache.get(k);
}
// B(w,h,d, material, x,y,z, parent, {r: bevel radius, uv: meters per texture tile, cast})
function B(w, h, d, mat, x = 0, y = 0, z = 0, parent = scene, o = {}) {
  const m = new THREE.Mesh(boxGeo(w, h, d, o.r || 0, o.uv || 0), typeof mat === 'string' ? M(mat) : mat);
  m.position.set(x, y, z);
  m.castShadow = o.cast ?? true; m.receiveShadow = true;
  parent.add(m);
  return m;
}
const sphereG = new THREE.SphereGeometry(1, 20, 14);
function E(rx, ry, rz, mat, x, y, z, parent, cast = true) {
  const m = new THREE.Mesh(sphereG, typeof mat === 'string' ? M(mat) : mat);
  m.scale.set(rx, ry, rz); m.position.set(x, y, z); m.castShadow = cast; parent.add(m); return m;
}
const capCache = new Map();
function capsule(a, b, r, mat, parent) {
  const d = V3().subVectors(b, a), len = d.length();
  const k = r.toFixed(3) + ',' + len.toFixed(3);
  if (!capCache.has(k)) capCache.set(k, new THREE.CapsuleGeometry(r, Math.max(0.001, len), 4, 10));
  const m = new THREE.Mesh(capCache.get(k), typeof mat === 'string' ? M(mat) : mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(YAX, d.normalize());
  m.castShadow = true; parent.add(m); return m;
}
function cyl(rt, rb, h, mat, x, y, z, parent, seg = 16) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), typeof mat === 'string' ? M(mat) : mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
function addWind(mat, strength, mode) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = windTime;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 ip = instanceMatrix[3].xyz;
      #else
        vec3 ip = vec3(0.0);
      #endif
      float hh = ${mode === 'tree' ? 'max(position.y - 2.0, 0.0) * 0.25' : 'max(position.y, 0.0) * 2.2'};
      float w = sin(uTime * 1.6 + ip.x * 0.3 + ip.z * 0.21) * 0.65 + sin(uTime * 3.3 + ip.x * 0.8 + position.x * 2.0) * 0.3;
      transformed.x += w * ${strength.toFixed(3)} * hh * hh;
      transformed.z += w * ${(strength * 0.6).toFixed(3)} * hh * hh;`);
  };
  mat.customProgramCacheKey = () => 'wind-' + mode + strength;
}
const windTime = { value: 0 };

/* =====================================================================
   COLLISION WORLD (gameplay AABBs + physics fixed colliders)
   ===================================================================== */
const statics = []; // {b, bullet, nav, mat, glass, mesh, col, dead}
const glassPanes = [];
function addStatic(minx, miny, minz, maxx, maxy, maxz, o = {}) {
  const s = { b: new THREE.Box3(V3(minx, miny, minz), V3(maxx, maxy, maxz)), bullet: o.bullet ?? true, nav: o.nav ?? true, mat: o.mat || 'concrete', glass: !!o.glass, mesh: o.mesh || null, col: null, dead: false };
  s.col = makeFixedCollider(s.b);
  statics.push(s); if (s.glass) glassPanes.push(s);
  return s;
}
function makeFixedCollider(b) {
  const hx = (b.max.x - b.min.x) / 2, hy = (b.max.y - b.min.y) / 2, hz = (b.max.z - b.min.z) / 2;
  return world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(b.min.x + hx, b.min.y + hy, b.min.z + hz).setCollisionGroups(GRP(G_STATIC, 0xffff)).setFriction(0.8), fixedBody);
}
function staticC(x, y0, z, w, h, d, o) { return addStatic(x - w / 2, y0, z - d / 2, x + w / 2, y0 + h, z + d / 2, o); }
function staticRot(x, z, w, d, y0, h, rot, o) {
  const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  const hw = c * w / 2 + s * d / 2, hd = s * w / 2 + c * d / 2;
  return addStatic(x - hw, y0, z - hd, x + hw, y0 + h, z + hd, o);
}
let _hitAxis = 0;
function rayBox(o, d, b, maxT) {
  let tmin = 0, tmax = maxT, ax = -1;
  for (let a = 0; a < 3; a++) {
    const k = a === 0 ? 'x' : a === 1 ? 'y' : 'z';
    const dv = d[k], ov = o[k];
    if (Math.abs(dv) < 1e-9) { if (ov < b.min[k] || ov > b.max[k]) return -1; continue; }
    const inv = 1 / dv;
    let t1 = (b.min[k] - ov) * inv, t2 = (b.max[k] - ov) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) { tmin = t1; ax = a; }
    if (t2 < tmax) tmax = t2;
    if (tmax < tmin) return -1;
  }
  _hitAxis = ax;
  return tmin;
}
const _losDir = V3();
function losClear(a, b) {
  _losDir.subVectors(b, a); const len = _losDir.length(); _losDir.divideScalar(len);
  for (const s of statics) { if (!s.bullet || s.dead || s.glass) continue; const t = rayBox(a, _losDir, s.b, len); if (t >= 0 && t < len) return false; }
  return true;
}
function groundAt(x, z, r = 0.2) {
  let y = 0;
  for (const s of statics) {
    const b = s.b;
    if (s.dead || b.max.y > 0.45 || b.max.y <= y) continue;
    if (x + r > b.min.x && x - r < b.max.x && z + r > b.min.z && z - r < b.max.z) y = b.max.y;
  }
  return y;
}

/* =====================================================================
   WORLD
   ===================================================================== */
function heightAt(x, z) {
  const ox = Math.max(0, Math.abs(x) - (BX + 4)), oz = Math.max(0, Math.abs(z) - (BZ + 4));
  const o = Math.max(ox, oz);
  if (o <= 0) return 0;
  const k = Math.min(1, o / 22);
  return k * k * (3 + Math.sin(x * 0.07) * Math.cos(z * 0.06) * 4 + Math.sin(x * 0.19 + z * 0.11) * 1.4 + o * 0.13);
}
let grassMesh = null, GRASS_MAX = 0, FLOWER_MESHES = [], FLOWER_N = 0;
const noAO = o => { o.userData.noAO = true; return o; };

function buildGround() {
  const g = new THREE.PlaneGeometry(340, 340, 170, 170);
  g.rotateX(-Math.PI / 2);
  const pa = g.attributes.position, cols = [];
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), z = pa.getZ(i);
    pa.setY(i, heightAt(x, z));
    const m = 0.78 + fbm((x + 170) / 340, (z + 170) / 340, 4, 6, 6, 77) * 0.45;
    const worn = Math.abs(z) < 19 && Math.abs(x) < 47 ? smooth(19, 15.5, Math.abs(z)) * 0.25 : 0;
    cols.push(m * (1 + worn * 0.5), m * (1 - worn * 0.15), m * (1 - worn * 0.3));
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeVertexNormals();
  TX.grass.map.repeat.set(110, 110); TX.grass.normalMap.repeat.set(110, 110);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: TX.grass.map, normalMap: TX.grass.normalMap, normalScale: new THREE.Vector2(0.9, 0.9), vertexColors: true, roughness: 1 }));
  m.receiveShadow = true; scene.add(m);

  // old asphalt apron
  const ag = new THREE.PlaneGeometry(92, 32); ag.rotateX(-Math.PI / 2);
  const uv = ag.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 92 / 7, uv.getY(i) * 32 / 7);
  const ap = new THREE.Mesh(ag, MAT.asphalt); ap.position.y = 0.012; ap.receiveShadow = true; scene.add(ap);
  const paintM = new THREE.MeshStandardMaterial({ color: 0xd6d3c4, roughness: 0.8, transparent: true, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const lx of [-20, 0, 20]) for (const zz of [-11.5, 11.5]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(15, 0.35), paintM); p.rotation.x = -Math.PI / 2; p.position.set(lx, 0.016, zz); p.receiveShadow = true; scene.add(p);
  }
}

function buildGrass() {
  // tuft = 5 curved blades, vertex-coloured dark root -> light tip, normals pointing up for soft lighting
  const pos = [], col = [], nor = [], idx = [];
  let base = 0;
  for (let b = 0; b < 5; b++) {
    const a = rand(0, TAU), h = rand(0.28, 0.55), w = rand(0.025, 0.04), lean = rand(0.05, 0.18), ox = rand(-0.06, 0.06), oz = rand(-0.06, 0.06);
    const ca = Math.cos(a), sa = Math.sin(a), SEG = 3;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG, ww = w * (1 - t * 0.85), y = h * t, f = lean * t * t;
      for (const side of [-1, 1]) {
        if (s === SEG && side === 1) continue;
        const px = ox + ca * ww * side * (s === SEG ? 0 : 1) + (-sa) * f, pz = oz + sa * ww * side * (s === SEG ? 0 : 1) + ca * f;
        pos.push(px, y, pz); nor.push(0, 1, 0);
        const c = lerp(0.35, 1.0, t); col.push(0.18 * c + 0.03, 0.3 * c + 0.04, 0.07 * c + 0.01);
      }
    }
    // indices for strip: rows 0..SEG-1 have 2 verts, last has 1
    for (let s = 0; s < SEG - 1; s++) { const r0 = base + s * 2, r1 = r0 + 2; idx.push(r0, r0 + 1, r1, r0 + 1, r1 + 1, r1); }
    const lastRow = base + (SEG - 1) * 2, tip = base + SEG * 2; idx.push(lastRow, lastRow + 1, tip);
    base += SEG * 2 + 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85 });
  addWind(mat, 0.035, 'grass');
  GRASS_MAX = 52000;
  grassMesh = noAO(new THREE.InstancedMesh(geo, mat, GRASS_MAX));
  const dummy = new THREE.Object3D(), c = new THREE.Color();
  let n = 0;
  while (n < GRASS_MAX) {
    const x = rand(-72, 72), z = rand(-90, 90);
    if (Math.abs(x) < 46 && Math.abs(z) < 16 && Math.random() < 0.82) continue;
    if (fbm((x + 72) / 144, (z + 90) / 180, 3, 8, 8, 55) < 0.38 && Math.random() < 0.6) continue;
    dummy.position.set(x, heightAt(x, z), z);
    dummy.rotation.set(0, rand(0, TAU), 0);
    const s = rand(0.75, 1.45); dummy.scale.set(s, s * rand(0.8, 1.5), s);
    dummy.updateMatrix(); grassMesh.setMatrixAt(n, dummy.matrix);
    c.setRGB(rand(0.85, 1.15), rand(0.9, 1.1), rand(0.7, 1.0)); grassMesh.setColorAt(n, c);
    n++;
  }
  // shuffle-free: instances are already in random spatial order, so .count acts as a density slider
  grassMesh.receiveShadow = true; grassMesh.frustumCulled = false;
  grassMesh.count = Math.floor(GRASS_MAX * Q.grass);
  scene.add(grassMesh);

  // flowers: heads + stems
  const pal = ['#ecd23e', '#f3df5c', '#e6c92f', '#a99ad8', '#c4a6dc', '#eeecf4', '#b9a2d6'];
  const FN = 8000;
  const heads = noAO(new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.045, TOUCH ? 0 : 1), new THREE.MeshStandardMaterial({ roughness: 0.6 }), FN));
  const stemG = new THREE.CylinderGeometry(0.004, 0.006, 1, 3); stemG.translate(0, 0.5, 0);
  const stems = noAO(new THREE.InstancedMesh(stemG, M('#4c6b2a'), FN));
  const bushPos = [];
  let fi = 0;
  while (fi < FN) {
    const cx = rand(-62, 62), cz = rand(-80, 80), p = pal[(Math.random() * pal.length) | 0];
    const cnt = rand(20, 55) | 0, rad = rand(0.8, 2.4), gy = heightAt(cx, cz);
    if (Math.random() < 0.45) bushPos.push([cx, gy, cz, rad]);
    for (let k = 0; k < cnt && fi < FN; k++) {
      const a = rand(0, TAU), r = Math.sqrt(Math.random()) * rad, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const h = rand(0.22, 0.5), y = heightAt(x, z);
      dummy.position.set(x, y + h, z); dummy.rotation.set(rand(0, 3), rand(0, 3), 0); const s = rand(0.7, 1.4); dummy.scale.set(s, s * 0.7, s);
      dummy.updateMatrix(); heads.setMatrixAt(fi, dummy.matrix);
      c.set(p).offsetHSL(rand(-0.015, 0.015), 0, rand(-0.06, 0.05)); heads.setColorAt(fi, c);
      dummy.position.set(x, y, z); dummy.rotation.set(rand(-0.15, 0.15), 0, rand(-0.15, 0.15)); dummy.scale.set(1, h, 1); dummy.updateMatrix(); stems.setMatrixAt(fi, dummy.matrix);
      fi++;
    }
  }
  heads.receiveShadow = true;
  scene.add(heads, stems);
  FLOWER_MESHES = [heads, stems]; FLOWER_N = fi;

  // leafy bushes (alpha-tested leaf cards)
  const cards = [];
  for (let i = 0; i < 26; i++) {
    const p = new THREE.PlaneGeometry(0.7, 0.7);
    const v = V3(rand(-1, 1), rand(0, 1), rand(-1, 1)).normalize().multiplyScalar(rand(0.1, 0.5));
    p.lookAt(v.clone().add(V3(rand(-1, 1), rand(-1, 1), rand(-1, 1))));
    p.translate(v.x, v.y * 0.7 + 0.25, v.z);
    const n = p.attributes.normal; for (let k = 0; k < n.count; k++) { const nn = V3(v.x, v.y + 0.4, v.z).normalize(); n.setXYZ(k, nn.x, nn.y, nn.z); }
    cards.push(p);
  }
  const bushGeo = mergeGeometries(cards);
  const bushMat = MAT.leaf.clone(); addWind(bushMat, 0.05, 'grass');
  const bushes = noAO(new THREE.InstancedMesh(bushGeo, bushMat, bushPos.length + 60));
  let bi = 0;
  for (const [x, y, z, r] of bushPos) { dummy.position.set(x, y, z); dummy.rotation.set(0, rand(0, TAU), 0); dummy.scale.set(r * 1.1, rand(0.6, 1.1), r * 1.1); dummy.updateMatrix(); bushes.setMatrixAt(bi, dummy.matrix); c.setHSL(0.26, 0.3, rand(0.35, 0.55)); bushes.setColorAt(bi++, c); }
  for (let i = 0; i < 60; i++) { const x = rand(-47, 47), z = (Math.random() < 0.5 ? -1 : 1) * rand(63.5, 67); dummy.position.set(x, heightAt(x, z), z); dummy.rotation.set(0, rand(0, TAU), 0); dummy.scale.set(rand(2.5, 3.5), rand(1.6, 2.6), rand(2.5, 3.5)); dummy.updateMatrix(); bushes.setMatrixAt(bi, dummy.matrix); c.setHSL(0.26, 0.3, rand(0.35, 0.5)); bushes.setColorAt(bi++, c); }
  bushes.count = bi; bushes.castShadow = true; bushes.receiveShadow = true;
  scene.add(bushes);
}

function buildTrees(list) {
  // a few tree prototypes rendered with instancing (bark + leaf cards)
  const protos = [];
  for (let p = 0; p < 4; p++) {
    const conifer = p === 3;
    const barkParts = [], leafParts = [];
    const tr = new THREE.CylinderGeometry(conifer ? 0.12 : 0.15, conifer ? 0.3 : 0.32, conifer ? 6 : 4.2, 8, 3);
    tr.translate(0, conifer ? 3 : 2.1, 0); barkParts.push(tr);
    const center = conifer ? V3(0, 4, 0) : V3(0, 4.9, 0);
    if (!conifer) for (let i = 0; i < 5; i++) {
      const a = i / 5 * TAU + rand(-0.3, 0.3), br = new THREE.CylinderGeometry(0.05, 0.1, 2.2, 6);
      br.translate(0, 1.1, 0); br.rotateZ(rand(0.7, 1.1)); br.rotateY(a); br.translate(0, rand(2.8, 3.6), 0); barkParts.push(br);
    }
    const N = conifer ? 110 : 95;
    for (let i = 0; i < N; i++) {
      const s = rand(1.1, 1.8), q = new THREE.PlaneGeometry(s, s);
      let v;
      if (conifer) { const y = rand(1.2, 7.2), r = (7.6 - y) * 0.42 * Math.sqrt(Math.random()); const a = rand(0, TAU); v = V3(Math.cos(a) * r, y, Math.sin(a) * r); }
      else { v = V3(rand(-1, 1), rand(-0.7, 1), rand(-1, 1)).normalize().multiplyScalar(Math.cbrt(Math.random())); v.set(v.x * 2.4, v.y * 1.7, v.z * 2.4).add(center); }
      q.rotateX(rand(0, TAU)); q.rotateY(rand(0, TAU)); q.rotateZ(rand(0, TAU));
      q.translate(v.x, v.y, v.z);
      const n = q.attributes.normal, outward = V3(v.x - center.x, (v.y - center.y) + 1.2, v.z - center.z).normalize();
      for (let k = 0; k < n.count; k++) n.setXYZ(k, outward.x, outward.y, outward.z);
      leafParts.push(q);
    }
    for (const g of barkParts) { g.deleteAttribute('uv'); }
    const bark = mergeGeometries(barkParts.map(g => g.toNonIndexed()));
    bark.computeVertexNormals();
    const bp = bark.attributes.position, buv = [];
    for (let i = 0; i < bp.count; i++) buv.push(Math.atan2(bp.getZ(i), bp.getX(i)) / TAU * 2, bp.getY(i) * 0.6);
    bark.setAttribute('uv', new THREE.Float32BufferAttribute(buv, 2));
    protos.push({ bark, leaves: mergeGeometries(leafParts) });
  }
  const leafMat = MAT.leaf.clone(); addWind(leafMat, 0.012, 'tree');
  const dummy = new THREE.Object3D(), c = new THREE.Color();
  protos.forEach((p, pi) => {
    const mine = list.filter((_, i) => i % protos.length === pi);
    const bm = new THREE.InstancedMesh(p.bark, MAT.bark, mine.length);
    const lm = noAO(new THREE.InstancedMesh(p.leaves, leafMat, mine.length));
    mine.forEach((t, i) => {
      dummy.position.set(t.x, heightAt(t.x, t.z) - 0.1, t.z); dummy.rotation.set(0, rand(0, TAU), 0); dummy.scale.setScalar(t.s); dummy.updateMatrix();
      bm.setMatrixAt(i, dummy.matrix); lm.setMatrixAt(i, dummy.matrix);
      c.setHSL(rand(0.22, 0.3), rand(0.25, 0.45), rand(0.38, 0.6)); lm.setColorAt(i, c);
    });
    bm.castShadow = lm.castShadow = true; bm.receiveShadow = lm.receiveShadow = true;
    scene.add(bm, lm);
  });
  for (const t of list) if (t.collide) staticC(t.x, 0, t.z, 0.6 * t.s, 4 * t.s, 0.6 * t.s, { mat: 'wood' });
}

function buildCanopy() {
  const ribTex = canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#e0a62a'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 8) { g.fillStyle = '#9c6d14'; g.fillRect(x, 0, 2, h); g.fillStyle = '#f2c452'; g.fillRect(x + 2, 0, 1, h); }
    for (let i = 0; i < 30; i++) { g.fillStyle = 'rgba(90,60,20,.25)'; g.fillRect(Math.random() * w, Math.random() * h * 0.4 + h * 0.5, 1, h * 0.5); }
  }, 70, 1);
  B(92, 1.2, 15.2, MAT.yellow, 0, 7.8, 0, scene, { r: 0.08, uv: 4 });
  const ribM = new THREE.MeshStandardMaterial({ map: ribTex, roughness: 0.5, metalness: 0.25 });
  for (const zs of [-1, 1]) B(92.1, 1.22, 0.05, ribM, 0, 7.8, zs * 7.62, scene, { cast: false });
  B(91.6, 0.05, 14.8, M('#4a4334', { roughness: 0.9 }), 0, 7.19, 0, scene, { cast: false });
  // underside beams & light fixtures (some dead)
  for (let x = -44; x <= 44; x += 4) B(0.18, 0.28, 14.6, MAT.orangeDk, x, 7.04, 0, scene, { cast: false, r: 0.02 });
  for (let x = -42; x <= 42; x += 4) for (const z of [-4.5, 0, 4.5]) {
    B(1.1, 0.06, 0.4, M('#2c2c2c'), x, 7.12, z, scene, { cast: false });
    if (Math.random() < 0.55) B(1.0, 0.02, 0.32, MAT.glow, x, 7.085, z, scene, { cast: false });
  }
  addStatic(-46, 7.2, -7.6, 46, 8.4, 7.6, { nav: false, mat: 'metal' });
  // hanging overgrowth
  const vineM = M('#4c6b2e', { roughness: 0.9 });
  for (let i = 0; i < 130; i++) {
    const x = rand(-45.5, 45.5), zs = Math.random() < 0.5 ? -1 : 1, len = rand(0.2, 1.6);
    const v = B(rand(0.05, 0.14), len, 0.05, vineM, x, 7.2 - len / 2 + 0.05, zs * 7.63, scene, { cast: false, r: 0.02 });
    v.rotation.z = rand(-0.08, 0.08);
  }
  const mt = canvasTex(256, 112, (g, w, h) => {
    g.fillStyle = '#0c100d'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#4dff74'; g.font = 'bold 44px Arial'; g.textAlign = 'center'; g.fillText('MANUAL', w / 2, 46);
    g.fillRect(w / 2 - 7, 58, 14, 22);
    g.beginPath(); g.moveTo(w / 2 - 22, 78); g.lineTo(w / 2 + 22, 78); g.lineTo(w / 2, 104); g.closePath(); g.fill();
  });
  const signM = new THREE.MeshBasicMaterial({ map: mt, toneMapped: false, color: 0xcccccc });
  for (const lx of [-40, -20, 0, 20, 40]) for (const zs of [-1, 1]) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.7), signM);
    s.position.set(lx, 6.72, zs * 7.68); if (zs < 0) s.rotation.y = Math.PI; scene.add(s);
    B(1.72, 0.8, 0.06, '#1a1c1c', lx, 6.72, zs * 7.64, scene, { r: 0.02 });
  }
}

function makeBooth(x0) {
  const g = new THREE.Group(); g.position.set(x0, 0, 0); scene.add(g);
  B(3.0, 0.22, 19, MAT.concrete, 0, 0.11, 0, g, { r: 0.04, uv: 2 });
  for (const zs of [-1, 1]) B(3.04, 0.24, 0.6, MAT.hazard, 0, 0.12, zs * 9.2, g, { r: 0.03 });
  const yb = 0.22;
  B(2.6, 1.1, 3.8, MAT.orange, 0, yb + 0.55, 0, g, { r: 0.03, uv: 2 });
  B(2.64, 0.08, 3.84, MAT.orangeDk, 0, yb + 1.14, 0, g, { r: 0.02 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) B(0.1, 1.35, 0.1, MAT.orange, sx * 1.26, yb + 1.85, sz * 1.86, g, { r: 0.02 });
  B(2.65, 0.45, 3.85, MAT.orange, 0, yb + 2.75, 0, g, { r: 0.03, uv: 2 });
  B(3.1, 0.18, 4.3, MAT.orangeDk, 0, yb + 3.06, 0, g, { r: 0.05, uv: 2 });
  B(0.4, 0.22, 0.4, M('#e8e3c0', { emissive: '#3a3420' }), 0, yb + 3.26, 0, g, { r: 0.05 });
  B(0.03, 2.1, 0.9, '#3a2b1d', 1.315, yb + 1.05, 1.0, g);
  B(0.03, 2.1, 0.9, '#3a2b1d', -1.315, yb + 1.05, -1.0, g);
  // interior: desk, monitor, chair back
  B(2.2, 0.06, 0.7, MAT.wood, 0, yb + 1.21, 0.9, g, { r: 0.02 });
  B(0.45, 0.32, 0.06, '#1b1d1f', 0.3, yb + 1.4, 0.95, g, { r: 0.02 });
  B(0.32, 0.12, 0.28, '#d6d2c8', -0.4, yb + 1.3, 0.85, g, { r: 0.03 });
  B(0.45, 0.55, 0.08, fab('#2b3a52'), 0, yb + 1.5, -0.3, g, { r: 0.04 });
  // pillars with concrete footings
  for (const zs of [-1, 1]) {
    B(0.8, 7.0, 0.8, MAT.orange, 0, 3.7, zs * 7.2, g, { r: 0.06, uv: 2 });
    B(1.1, 0.35, 1.1, MAT.concrete, 0, 0.175, zs * 7.2, g, { r: 0.04, uv: 2 });
  }
  // gameplay colliders (booth split so its glass can break)
  staticC(x0, 0, 0, 3.0, 0.22, 19);
  staticC(x0, 0, 0, 2.62, yb + 1.18, 3.84, { mat: 'metal' });
  staticC(x0, yb + 2.5, 0, 3.1, 0.85, 4.3, { mat: 'metal' });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) staticC(x0 + sx * 1.26, yb + 1.18, sz * 1.86, 0.1, 1.35, 0.1, { mat: 'metal', nav: false });
  const paneH = 1.32, py = yb + 1.18 + paneH / 2;
  for (const sz of [-1, 1]) {
    const m = B(2.42, paneH, 0.02, MAT.glass, 0, py, sz * 1.87, g, { cast: false }); noAO(m);
    staticC(x0, yb + 1.18, sz * 1.87, 2.42, paneH, 0.06, { glass: true, mesh: m, nav: false, mat: 'glass' });
  }
  for (const sx of [-1, 1]) {
    const m = B(0.02, paneH, 3.62, MAT.glass, sx * 1.27, py, 0, g, { cast: false }); noAO(m);
    staticC(x0 + sx * 1.27, yb + 1.18, 0, 0.06, paneH, 3.62, { glass: true, mesh: m, nav: false, mat: 'glass' });
  }
  for (const zs of [-1, 1]) staticC(x0, 0, zs * 7.2, 0.8, 7.2, 0.8, { mat: 'metal' });
  for (let i = 0; i < 8; i++) B(rand(0.2, 0.6), 0.1, rand(0.2, 0.6), M(Math.random() < 0.5 ? '#5d7c35' : '#e5cb3c'), rand(-1.3, 1.3), yb + 3.18, rand(-1.9, 1.9), g, { cast: false, r: 0.04 });
}

function makeBarrier(x0, zs, dir, mode) {
  const px = x0 + dir * 1.3, pz = zs * 4.6;
  B(0.34, 1.0, 0.34, MAT.yellow, px, 0.72, pz, scene, { r: 0.04 });
  B(0.4, 0.3, 0.4, '#2b2b2b', px, 1.18, pz, scene, { r: 0.04 });
  B(0.16, 0.14, 0.1, M('#ff3a2c', { emissive: '#ff2010', emissiveIntensity: 0.6 }), px, 1.4, pz, scene, { r: 0.03 });
  const piv = new THREE.Group(); piv.position.set(px, 1.08, pz); scene.add(piv);
  const arm = B(7, 0.12, 0.1, MAT.stripe, dir * 3.6, 0, 0, piv, { r: 0.04 });
  const foot = B(0.1, 0.6, 0.06, MAT.yellow, dir * 6.9, -0.3, 0, piv);
  if (mode === 'up') piv.rotation.z = dir * 1.2;
  else if (mode === 'broken') { piv.rotation.z = -dir * 0.12; arm.rotation.x = 0.2; }
  else {
    foot.visible = false;
    const xa = px + dir * 0.1, xb = px + dir * 7.1;
    addStatic(Math.min(xa, xb), 1.0, pz - 0.07, Math.max(xa, xb), 1.14, pz + 0.07, { mat: 'metal' });
  }
  staticC(px, 0, pz, 0.4, 1.33, 0.4, { mat: 'metal' });
}

function taper(geo, topScaleX, frontShift, backShift) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) { p.setX(i, p.getX(i) * topScaleX); const z = p.getZ(i); p.setZ(i, z > 0 ? z - frontShift : z + backShift); }
  }
  geo.computeVertexNormals();
  return geo;
}
function makeCar(x, z, rot, color, rusty) {
  if (MODELS.car) return placeCarModel(x, z, rot);
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
  const paint = new THREE.MeshPhysicalMaterial({ color, map: TX.paint.map, roughness: rusty ? 0.6 : 0.42, metalness: 0.45, clearcoat: rusty ? 0.2 : 0.7, clearcoatRoughness: 0.25 });
  const body = new THREE.Mesh(new RoundedBoxGeometry(1.76, 0.66, 3.9, 3, 0.16), paint);
  body.position.y = 0.62; body.castShadow = body.receiveShadow = true; g.add(body);
  const cab = new THREE.Mesh(taper(new RoundedBoxGeometry(1.6, 0.62, 2.1, 3, 0.1), 0.86, 0.32, 0.08), MAT.carGlass);
  cab.position.set(0, 1.22, -0.32); cab.castShadow = true; g.add(cab);
  const roof = new THREE.Mesh(taper(new RoundedBoxGeometry(1.42, 0.07, 1.62, 2, 0.03), 1, 0, 0), paint);
  roof.position.set(0, 1.545, -0.42); roof.castShadow = true; g.add(roof);
  for (const sx of [-1, 1]) { B(0.07, 0.56, 0.07, paint, sx * 0.72, 1.2, -1.32, g); const ap = B(0.07, 0.64, 0.07, paint, sx * 0.71, 1.2, 0.63, g); ap.rotation.x = -0.48; }
  for (const zs of [-1, 1]) B(1.82, 0.2, 0.14, M('#222', { roughness: 0.6 }), 0, 0.38, zs * 1.96, g, { r: 0.05 });
  for (const sx of [-1, 1]) {
    B(0.36, 0.15, 0.05, M('#f4f1e1', { emissive: '#40402f', roughness: 0.2 }), sx * 0.55, 0.74, 1.94, g, { r: 0.03, cast: false });
    B(0.3, 0.15, 0.05, M('#b3231e', { emissive: '#300', roughness: 0.3 }), sx * 0.6, 0.76, -1.94, g, { r: 0.03, cast: false });
    B(0.05, 0.1, 0.18, '#1a1a1a', sx * 0.9, 1.0, 0.85, g, { r: 0.02 }); // mirrors
  }
  B(0.42, 0.11, 0.02, '#ecebe4', 0, 0.52, 2.01, g, { cast: false }); B(0.42, 0.11, 0.02, '#ecebe4', 0, 0.52, -2.01, g, { cast: false });
  B(1.0, 0.05, 0.02, '#151515', 0, 0.66, 1.96, g, { cast: false }); // grille
  const tireG = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 20); tireG.rotateZ(Math.PI / 2);
  const rimG = new THREE.CylinderGeometry(0.19, 0.19, 0.25, 12); rimG.rotateZ(Math.PI / 2);
  for (const sx of [-1, 1]) for (const zs of [-1, 1]) {
    const flat = rusty && Math.random() < 0.5 ? 0.08 : 0;
    const t = new THREE.Mesh(tireG, MAT.rubber); t.position.set(sx * 0.8, 0.33 - flat, zs * 1.22); t.castShadow = true; g.add(t);
    const r = new THREE.Mesh(rimG, MAT.chrome); r.position.copy(t.position); g.add(r);
    B(0.08, 0.3, 0.8, '#121212', sx * 0.86, 0.72, zs * 1.22, g, { cast: false, r: 0.03 }); // arch shadow
  }
  if (rusty) for (let i = 0; i < 10; i++) B(rand(0.1, 0.5), rand(0.06, 0.25), 0.02, M('#5e3b25', { roughness: 1 }), rand(-0.6, 0.6), rand(0.4, 0.85), 1.955 * (Math.random() < 0.5 ? 1 : -1), g, { cast: false });
  for (let i = 0; i < 6; i++) B(rand(0.2, 0.5), 0.05, rand(0.2, 0.4), M(Math.random() < 0.6 ? '#53702f' : '#e3c93a'), rand(-0.5, 0.5), 1.585, rand(-1.0, 0.1), g, { cast: false, r: 0.02 });
  staticRot(x, z, 1.85, 3.95, 0, 1.58, rot, { mat: 'metal' });
}

function makeJersey(x, z, rot, len = 3.2) {
  const sh = new THREE.Shape();
  sh.moveTo(-0.32, 0); sh.lineTo(0.32, 0); sh.lineTo(0.32, 0.08); sh.lineTo(0.2, 0.3); sh.lineTo(0.12, 0.81); sh.lineTo(-0.12, 0.81); sh.lineTo(-0.2, 0.3); sh.lineTo(-0.32, 0.08); sh.closePath();
  const geo = new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 1 });
  geo.translate(0, 0, -len / 2);
  const m = new THREE.Mesh(geo, MAT.concrete); m.position.set(x, 0, z); m.rotation.y = rot; m.castShadow = m.receiveShadow = true; scene.add(m);
  B(0.26, 0.04, len * 0.5, M('#b52a2a', { roughness: 0.8 }), 0, 0.8, rand(-0.4, 0.4), m, { cast: false });
  staticRot(x, z, 0.64, len, 0, 0.86, rot);
}
function makeCrate(x, z, y = 0) {
  B(1.1, 1.1, 1.1, MAT.wood, x, y + 0.55, z, scene, { r: 0.03, uv: 1.1 });
  for (const yy of [0.07, 1.03]) B(1.13, 0.12, 1.13, M('#5e4428', { roughness: 0.9 }), x, y + yy, z, scene, { cast: false, r: 0.02 });
  staticC(x, y, z, 1.1, 1.1, 1.1, { mat: 'wood' });
}
function makeContainer(x, z) {
  const w = 6.2, d = 2.5;
  B(w, 2.6, d, MAT.rust, x, 1.3, z, scene, { r: 0.04, uv: 2.4 });
  B(w + 0.06, 0.12, d + 0.06, M('#4c2116', { roughness: 0.8, metalness: 0.3 }), x, 2.62, z, scene, { cast: false });
  for (const s of [-1, 1]) for (const k of [-0.6, -0.2, 0.2, 0.6]) cyl(0.025, 0.025, 2.4, MAT.steel, x + s * (w / 2 + 0.03), 1.3, z + k * d * 0.8, scene, 6);
  staticC(x, 0, z, w, 2.6, d, { mat: 'metal' });
}
function makeRail(x1, z1, x2, z2) {
  const alongX = Math.abs(x2 - x1) > Math.abs(z2 - z1);
  const len = alongX ? Math.abs(x2 - x1) : Math.abs(z2 - z1);
  // W-beam profile
  const sh = new THREE.Shape(), pts = [[0, 0], [0.07, 0.06], [0.0, 0.16], [0.07, 0.26], [0, 0.32]], t = 0.012;
  sh.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) sh.lineTo(p[0], p[1]);
  for (const p of pts.slice().reverse()) sh.lineTo(p[0] + t, p[1]);
  sh.closePath();
  const geo = new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: false });
  geo.translate(-0.04, 0, -len / 2);
  const m = new THREE.Mesh(geo, MAT.galv);
  m.position.set((x1 + x2) / 2, 0.46, (z1 + z2) / 2); if (alongX) m.rotation.y = Math.PI / 2;
  m.castShadow = m.receiveShadow = true; scene.add(m);
  const n = Math.max(1, Math.round(len / 2.5));
  for (let i = 0; i <= n; i++) {
    const k = i / n, px = x1 + (x2 - x1) * k, pz = z1 + (z2 - z1) * k;
    B(alongX ? 0.15 : 0.1, 0.78, alongX ? 0.1 : 0.15, MAT.galv, px + (alongX ? 0 : -0.13), 0.39, pz + (alongX ? -0.13 : 0), scene, { r: 0.01 });
  }
  addStatic(Math.min(x1, x2) - 0.14, 0, Math.min(z1, z2) - 0.14, Math.max(x1, x2) + 0.14, 0.8, Math.max(z1, z2) + 0.14, { mat: 'metal' });
}
function makeSign(x, z, rot) {
  const tex = canvasTex(512, 288, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#2349d8'); gr.addColorStop(1, '#1631a8');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#f4f4f4'; g.lineWidth = 9; g.beginPath(); g.roundRect(14, 14, w - 28, h - 28, 22); g.stroke();
    g.fillStyle = '#1f9a47'; g.beginPath(); g.roundRect(48, 46, 120, 50, 8); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 4; g.stroke();
    g.fillStyle = '#fff'; g.font = 'bold 34px Arial'; g.textAlign = 'center'; g.fillText('N-41', 108, 84);
    g.lineWidth = 4; g.beginPath(); g.roundRect(330, 46, 130, 50, 8); g.stroke(); g.fillText('R-7', 395, 84);
    g.font = 'bold 66px Arial'; g.textAlign = 'left'; g.fillText('VALDORA', 48, 200); g.textAlign = 'right'; g.fillText('38', 464, 200);
    for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(80,60,30,${Math.random() * 0.12})`; g.fillRect(Math.random() * w, Math.random() * h, rand(2, 20), rand(2, 30)); }
  });
  const grp = new THREE.Group(); grp.position.set(x, 0, z); grp.rotation.y = rot; scene.add(grp);
  const side = M('#c7cacc', { roughness: 0.4, metalness: 0.7 });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.9, 0.06), [side, side, side, side, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.1 }), MAT.galv]);
  panel.position.y = 2.9; panel.castShadow = true; panel.receiveShadow = true; grp.add(panel);
  for (const sx of [-1, 1]) cyl(0.055, 0.055, 3.9, MAT.galv, sx * 1.1, 1.95, -0.08, grp, 10);
}

/* =====================================================================
   DYNAMIC PROPS
   ===================================================================== */
const props = [];
function addProp(obj, colliders, x, y, z, rotY = 0, density = 100) {
  obj.position.set(x, y, z); obj.rotation.y = rotY; scene.add(obj);
  const q = obj.quaternion;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setLinearDamping(0.1).setAngularDamping(0.4).setCanSleep(true));
  for (const cd of colliders) world.createCollider(cd.setDensity(density).setCollisionGroups(GRP(G_PROP, 0xffff)).setFriction(0.7).setRestitution(0.15), body);
  obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const p = { obj, body, home: [x, y, z, rotY] };
  props.push(p); return p;
}
function propCone(x, z) {
  const g = new THREE.Group(); const mat = M('#e2621f', { roughness: 0.55 });
  B(0.4, 0.04, 0.4, mat, 0, 0.02, 0, g, { r: 0.01 });
  cyl(0.03, 0.17, 0.62, mat, 0, 0.35, 0, g, 16);
  cyl(0.085, 0.115, 0.1, M('#f2f2f2', { roughness: 0.3 }), 0, 0.42, 0, g, 16);
  addProp(g, [RAPIER.ColliderDesc.cuboid(0.2, 0.02, 0.2).setTranslation(0, 0.02, 0), RAPIER.ColliderDesc.cone(0.31, 0.17).setTranslation(0, 0.35, 0)], x, 0.001, z, rand(0, TAU), 80);
}
function propBarrel(x, z, color) {
  const g = new THREE.Group(); const mat = texMat(TX.paint, color, { roughness: 0.5, metalness: 0.4 }, 0.4);
  cyl(0.29, 0.29, 0.88, mat, 0, 0, 0, g, 20);
  for (const y of [-0.3, 0, 0.3]) cyl(0.297, 0.297, 0.03, mat, 0, y, 0, g, 20);
  cyl(0.27, 0.27, 0.01, M('#2a2a2a'), 0, 0.445, 0, g, 20);
  addProp(g, [RAPIER.ColliderDesc.cylinder(0.44, 0.29)], x, 0.441, z, rand(0, TAU), 110);
}
function propTire(x, z, y = 0) {
  const g = new THREE.Group();
  const t = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.12, 10, 22), MAT.rubber); t.rotation.x = Math.PI / 2; g.add(t);
  addProp(g, [RAPIER.ColliderDesc.cylinder(0.12, 0.43)], x, y + 0.121, z, 0, 180);
}
function propBox(x, z, y = 0) {
  const g = new THREE.Group(); B(0.55, 0.42, 0.42, M('#a27b4f', { roughness: 0.95 }), 0, 0, 0, g, { r: 0.015 });
  B(0.56, 0.06, 0.43, M('#c8b48a', { roughness: 0.9 }), 0, 0.12, 0, g, { cast: false });
  addProp(g, [RAPIER.ColliderDesc.cuboid(0.275, 0.21, 0.21)], x, y + 0.211, z, rand(0, TAU), 60);
}

// spawns: ally side z<0 (facing +z), enemy side z>0
const SPAWNS = [[V3(-32, 0, -57), V3(-12, 0, -58), V3(8, 0, -57), V3(28, 0, -58), V3(-39, 0, -51), V3(38, 0, -50)], []];
SPAWNS[1] = SPAWNS[0].map(p => V3(-p.x, 0, -p.z));

async function buildWorld() {
  scene.background = null;
  buildGround();
  setLoad('GROWING GRASS…'); await tick();
  buildGrass();
  setLoad('BUILDING PLAZA…'); await tick();
  buildCanopy();
  for (const x0 of [-30, -10, 10, 30]) makeBooth(x0);
  makeBarrier(-30, 1, 1, 'down'); makeBarrier(30, -1, -1, 'down');
  makeBarrier(-30, -1, 1, 'broken'); makeBarrier(30, 1, -1, 'broken');
  makeBarrier(-10, 1, 1, 'up'); makeBarrier(10, -1, -1, 'up');
  makeBarrier(-10, -1, 1, 'down'); makeBarrier(10, 1, -1, 'down');
  const carCols = [[0x7c7f83, 0x8e3f31, 0x4f7d7a], [0xd9d6cc, 0x5b6a3c, 0x3f4f6e]];
  const trees = [];
  for (const s of [1, -1]) {
    const R = s < 0 ? Math.PI : 0, cc = carCols[s < 0 ? 1 : 0];
    makeCar(-21 * s, -15 * s, 0.25 + R, cc[0], false);
    makeCar(6 * s, -27 * s, Math.PI / 2 - 0.2 + R, cc[1], true);
    makeCar(33 * s, -31 * s, 0.4 + R, cc[2], true);
    makeJersey(-4 * s, -16 * s, Math.PI / 2);
    makeJersey(17 * s, -15 * s, 0);
    makeJersey(-34 * s, -35 * s, Math.PI / 2);
    makeJersey(-14 * s, -40 * s, Math.PI / 2);
    makeJersey(40 * s, -12 * s, 0);
    makeCrate(-26 * s, -28 * s); makeCrate(-27.15 * s, -28 * s); makeCrate(-26.6 * s, -28 * s, 1.1);
    makeCrate(24 * s, -46 * s); makeCrate(24 * s, -44.9 * s);
    makeCrate(12 * s, -38 * s);
    makeCrate(-41 * s, -22 * s);
    makeContainer(-28 * s, -47 * s);
    makeRail(2 * s, -46 * s, 14 * s, -46 * s);
    makeRail(36 * s, -17 * s, 36 * s, -24 * s);
    trees.push({ x: 40 * s, z: -42 * s, s: 1.0, collide: true }, { x: -6 * s, z: -51 * s, s: 0.9, collide: true });
    makeSign(-37 * s, -25 * s, R);
    // physics props
    for (let i = 0; i < 6; i++) propCone(rand(-38, 38) * s, rand(-14, -9.8) * s);
    propBarrel(-18 * s, -31 * s, 0x2f5a8a); propBarrel(-17.3 * s, -31.4 * s, 0x2f5a8a); propBarrel(-17.7 * s, -30.4 * s, 0x9a4b22);
    propBarrel(28 * s, -21 * s, 0x9a4b22); propBarrel(28.7 * s, -21.3 * s, 0x2f5a8a);
    propTire(-24.5 * s, -45 * s); propTire(-24.5 * s, -45 * s, 0.25); propTire(-24.5 * s, -45 * s, 0.5); propTire(-23.5 * s, -44 * s);
    propBox(13.5 * s, -38 * s); propBox(13.4 * s, -37.4 * s); propBox(13.45 * s, -37.7 * s, 0.43);
    propBox(-39.7 * s, -22.3 * s);
  }
  for (const sx of [-1, 1]) makeRail(sx * 44, -62, sx * 44, 62);
  for (const sx of [-1, 1]) addStatic(sx > 0 ? 45 : -46, 0, -70, sx > 0 ? 46 : -45, 6, 70, { bullet: false });
  for (const sz of [-1, 1]) addStatic(-50, 0, sz > 0 ? 62.5 : -63.5, 50, 6, sz > 0 ? 63.5 : -62.5, { bullet: false });
  for (let i = 0; i < 170; i++) {
    let x, z;
    if (Math.random() < 0.5) { x = (Math.random() < 0.5 ? -1 : 1) * rand(49, 125); z = rand(-125, 125); }
    else { x = rand(-125, 125); z = (Math.random() < 0.5 ? -1 : 1) * rand(67, 125); }
    trees.push({ x, z, s: rand(0.9, 1.7), collide: false });
  }
  setLoad('PLANTING TREES…'); await tick();
  buildTrees(trees);
}

/* =====================================================================
   NAVIGATION GRID + A*
   ===================================================================== */
const NAV = { minX: -BX, minZ: -BZ, cs: 1 };
NAV.w = Math.round(BX * 2 / NAV.cs); NAV.h = Math.round(BZ * 2 / NAV.cs);
NAV.blk = new Uint8Array(NAV.w * NAV.h);
const cellI = x => Math.floor((x - NAV.minX) / NAV.cs);
const cellJ = z => Math.floor((z - NAV.minZ) / NAV.cs);
const walkableCell = (i, j) => i >= 0 && j >= 0 && i < NAV.w && j < NAV.h && !NAV.blk[j * NAV.w + i];
const walkable = (x, z) => walkableCell(cellI(x), cellJ(z));
function buildNav() {
  const W = NAV.w, pad = 0.45;
  for (const s of statics) {
    if (!s.nav) continue; const b = s.b;
    if (b.max.y <= 0.45 || b.min.y >= 1.7) continue;
    const i0 = Math.max(0, cellI(b.min.x - pad)), i1 = Math.min(W - 1, cellI(b.max.x + pad));
    const j0 = Math.max(0, cellJ(b.min.z - pad)), j1 = Math.min(NAV.h - 1, cellJ(b.max.z + pad));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) NAV.blk[j * W + i] = 1;
  }
  for (let i = 0; i < W; i++) { NAV.blk[i] = 1; NAV.blk[(NAV.h - 1) * W + i] = 1; }
  for (let j = 0; j < NAV.h; j++) { NAV.blk[j * W] = 1; NAV.blk[j * W + W - 1] = 1; }
}
function nearestWalk(i, j) {
  if (walkableCell(i, j)) return [i, j];
  for (let r = 1; r < 10; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    if (Math.abs(di) !== r && Math.abs(dj) !== r) continue;
    if (walkableCell(i + di, j + dj)) return [i + di, j + dj];
  }
  return null;
}
function clearLine(ax, az, bx, bz) {
  const d = Math.hypot(bx - ax, bz - az), n = Math.ceil(d / 0.35);
  for (let k = 1; k <= n; k++) { const t = k / n; if (!walkable(ax + (bx - ax) * t, az + (bz - az) * t)) return false; }
  return true;
}
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
function findPath(sx, sz, gx, gz) {
  const W = NAV.w, H = NAV.h, N = W * H;
  const s = nearestWalk(cellI(sx), cellJ(sz)), g = nearestWalk(cellI(gx), cellJ(gz));
  if (!s || !g) return null;
  const start = s[1] * W + s[0], goal = g[1] * W + g[0];
  const gs = new Float32Array(N).fill(1e9), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const hi = [], hf = [];
  const push = (i, f) => { hi.push(i); hf.push(f); let n = hi.length - 1; while (n > 0) { const p = (n - 1) >> 1; if (hf[p] <= hf[n]) break; [hi[p], hi[n]] = [hi[n], hi[p]]; [hf[p], hf[n]] = [hf[n], hf[p]]; n = p; } };
  const pop = () => {
    const top = hi[0]; const li = hi.pop(), lf = hf.pop();
    if (hi.length) { hi[0] = li; hf[0] = lf; let n = 0; for (;;) { const l = 2 * n + 1, r = l + 1; let m = n; if (l < hi.length && hf[l] < hf[m]) m = l; if (r < hi.length && hf[r] < hf[m]) m = r; if (m === n) break; [hi[m], hi[n]] = [hi[n], hi[m]]; [hf[m], hf[n]] = [hf[n], hf[m]]; n = m; } }
    return top;
  };
  const gi = g[0], gj = g[1];
  const hfn = (i, j) => { const dx = Math.abs(i - gi), dy = Math.abs(j - gj); return dx + dy - 0.5858 * Math.min(dx, dy); };
  gs[start] = 0; push(start, hfn(s[0], s[1]));
  let found = false, iter = 0;
  while (hi.length) {
    const cur = pop();
    if (closed[cur]) continue;
    if (cur === goal) { found = true; break; }
    closed[cur] = 1; if (++iter > 25000) break;
    const ci = cur % W, cj = (cur / W) | 0;
    for (const [di, dj] of DIRS) {
      const ni = ci + di, nj = cj + dj;
      if (!walkableCell(ni, nj)) continue;
      if (di && dj && (!walkableCell(ci + di, cj) || !walkableCell(ci, cj + dj))) continue;
      const n = nj * W + ni; if (closed[n]) continue;
      const ng = gs[cur] + (di && dj ? 1.4142 : 1);
      if (ng < gs[n]) { gs[n] = ng; came[n] = cur; push(n, ng + hfn(ni, nj)); }
    }
  }
  if (!found) return null;
  const cells = []; for (let c = goal; c !== -1; c = came[c]) cells.push(c); cells.reverse();
  const pts = cells.map(c => ({ x: NAV.minX + ((c % W) + 0.5) * NAV.cs, z: NAV.minZ + (((c / W) | 0) + 0.5) * NAV.cs }));
  if (walkable(gx, gz)) pts[pts.length - 1] = { x: gx, z: gz };
  const out = [pts[0]]; let k = 0;
  while (k < pts.length - 1) {
    let nxt = k + 1;
    for (let m = Math.min(pts.length - 1, k + 22); m > k + 1; m--) if (clearLine(pts[k].x, pts[k].z, pts[m].x, pts[m].z)) { nxt = m; break; }
    out.push(pts[nxt]); k = nxt;
  }
  return out;
}
function randomWalkPoint() {
  for (let t = 0; t < 50; t++) { const x = rand(-BX + 3, BX - 3), z = rand(-BZ + 3, BZ - 3); if (walkable(x, z)) return { x, z }; }
  return { x: 0, z: 0 };
}

/* =====================================================================
   CHARACTERS (part hierarchy doubles as the ragdoll skeleton)
   ===================================================================== */
const LOOKS = {
  raven: { style: 'tactical', skin: '#e9c3ae', lips: '#a5525a', hair: '#151214', top: '#1c1c1f', pants: '#202126', boots: '#121214', glove: '#141416', sleeve: '#1c1c1f', bare: false },
  frost: { style: 'ushanka', skin: '#e8c1ad', lips: '#b9727a', hair: '#cfd3dc', top: '#e6e3dc', pants: '#3a3d31', boots: '#2b221d', glove: '#e8c1ad', sleeve: '#e8c1ad', fur: '#221d1c', bare: true },
};
const HAND_R = V3(-0.14, -0.2, 0.22), ELB_R = V3(0.03, -0.24, 0.07);
const HAND_L = V3(0.34, -0.17, 0.46), ELB_L = V3(0.05, -0.25, 0.24);

function buildCharacter(L) {
  const skin = M(L.skin, { roughness: 0.55 });
  const hair = M(L.hair, { roughness: 0.45, metalness: 0.05 });
  const top = L.bare ? fab(L.top, 0.85) : fab(L.top);
  const pants = fab(L.pants), boots = M(L.boots, { roughness: 0.55 }), glove = L.bare ? skin : M(L.glove, { roughness: 0.7 });
  const sleeve = L.bare ? skin : fab(L.sleeve);
  const root = new THREE.Group();
  const hips = new THREE.Group(); hips.position.set(0, 0.92, 0); root.add(hips);
  const torso = new THREE.Group(); torso.position.set(0, 0.33, 0); hips.add(torso);
  B(0.35, 0.2, 0.22, pants, 0, -0.3, 0, torso, { r: 0.07 });
  B(0.4, 0.5, 0.23, top, 0, 0.02, 0, torso, { r: 0.09 });
  B(0.37, 0.05, 0.235, M('#2a2622', { roughness: 0.6 }), 0, -0.21, 0, torso, { r: 0.02 });
  const thighs = [], shins = [];
  for (const s of [-1, 1]) {
    const th = new THREE.Group(); th.position.set(0.1 * s, -0.02, 0); hips.add(th);
    capsule(V3(0, 0.02, 0), V3(0, -0.42, 0), 0.085, pants, th);
    const sh = new THREE.Group(); sh.position.set(0, -0.44, 0); th.add(sh);
    capsule(V3(0, 0, 0), V3(0, -0.33, 0), 0.07, pants, sh);
    B(0.13, 0.12, 0.27, boots, 0, -0.4, 0.035, sh, { r: 0.045 });
    if (!L.bare) B(0.1, 0.11, 0.06, M('#26272a', { roughness: 0.6 }), 0, -0.01, 0.065, sh, { r: 0.03 });
    thighs.push(th); shins.push(sh);
  }
  const head = new THREE.Group(); head.position.set(0, 0.28, 0); torso.add(head);
  capsule(V3(0, -0.03, 0), V3(0, 0.07, 0), 0.05, skin, head);
  E(0.105, 0.13, 0.115, skin, 0, 0.17, 0.005, head);
  E(0.085, 0.06, 0.09, skin, 0, 0.1, 0.02, head);
  for (const s of [-1, 1]) {
    E(0.016, 0.01, 0.008, M('#1a1214', { roughness: 0.25 }), s * 0.042, 0.185, 0.112, head, false);
    B(0.035, 0.007, 0.01, hair, s * 0.043, 0.205, 0.113, head, { cast: false });
    E(0.012, 0.028, 0.02, skin, s * 0.106, 0.17, 0, head, false);
  }
  E(0.014, 0.022, 0.016, skin, 0, 0.155, 0.122, head, false);
  E(0.026, 0.01, 0.012, M(L.lips, { roughness: 0.35 }), 0, 0.115, 0.108, head, false);

  if (L.style === 'tactical') {
    E(0.115, 0.12, 0.12, hair, 0, 0.19, -0.03, head);
    B(0.22, 0.14, 0.06, hair, 0, 0.1, -0.1, head, { r: 0.025 });
    for (const s of [-1, 1]) { const lk = B(0.03, 0.15, 0.08, hair, s * 0.1, 0.13, 0.06, head, { r: 0.012 }); lk.rotation.z = s * 0.08; }
    const bang = B(0.2, 0.06, 0.03, hair, 0, 0.255, 0.105, head, { r: 0.012 }); bang.rotation.x = -0.3;
    const helmM = M('#17181a', { roughness: 0.5 });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.135, 20, 10, 0, TAU, 0, Math.PI * 0.55), helmM);
    dome.scale.set(1.06, 0.95, 1.12); dome.position.set(0, 0.215, -0.005); dome.castShadow = true; head.add(dome);
    for (const s of [-1, 1]) B(0.015, 0.03, 0.2, M('#2a2b2e', { roughness: 0.4, metalness: 0.5 }), s * 0.142, 0.235, 0, head, { r: 0.005 });
    B(0.06, 0.045, 0.03, M('#2a2b2e', { roughness: 0.4, metalness: 0.5 }), 0, 0.295, 0.13, head, { r: 0.008 });
    const cupG = new THREE.CylinderGeometry(0.05, 0.05, 0.04, 14); cupG.rotateZ(Math.PI / 2);
    for (const s of [-1, 1]) { const c = new THREE.Mesh(cupG, M('#222225', { roughness: 0.5 })); c.position.set(s * 0.123, 0.17, 0); head.add(c); }
    capsule(V3(0.13, 0.14, 0.03), V3(0.04, 0.11, 0.12), 0.007, M('#1e1e20'), head);
    E(0.013, 0.013, 0.013, '#111', 0.04, 0.11, 0.123, head, false);
    const vest = M('#2a2b2f', { roughness: 0.8 });
    B(0.44, 0.36, 0.29, vest, 0, 0.06, 0, torso, { r: 0.05 });
    for (const x of [-0.12, 0, 0.12]) B(0.1, 0.11, 0.05, '#33353a', x, -0.05, 0.16, torso, { r: 0.015 });
    for (const s of [-1, 1]) B(0.07, 0.03, 0.27, vest, s * 0.13, 0.25, 0, torso, { r: 0.01 });
  } else {
    B(0.22, 0.38, 0.06, hair, 0, 0.05, -0.1, head, { r: 0.025 });
    for (const s of [-1, 1]) {
      B(0.035, 0.36, 0.17, hair, s * 0.105, 0.07, -0.01, head, { r: 0.015 });
      B(0.04, 0.3, 0.035, hair, s * 0.087, 0.07, 0.1, head, { r: 0.012 });
    }
    B(0.13, 0.045, 0.03, hair, 0.02, 0.245, 0.11, head, { r: 0.012 });
    B(0.03, 0.12, 0.025, hair, -0.03, 0.21, 0.118, head, { r: 0.01 }).rotation.z = 0.25;
    const fur = MAT.fur(L.fur);
    B(0.27, 0.13, 0.27, fur, 0, 0.31, 0, head, { r: 0.05 });
    B(0.28, 0.09, 0.06, fur, 0, 0.31, 0.14, head, { r: 0.025 }).rotation.x = -0.3;
    B(0.28, 0.1, 0.06, fur, 0, 0.27, -0.14, head, { r: 0.025 });
    for (const s of [-1, 1]) B(0.05, 0.17, 0.19, fur, s * 0.15, 0.2, 0, head, { r: 0.02 });
    B(0.045, 0.045, 0.012, M('#c7ccd6', { metalness: 0.9, roughness: 0.25 }), 0, 0.33, 0.175, head, { cast: false }).rotation.x = -0.3;
    for (const s of [-1, 1]) E(0.07, 0.05, 0.08, skin, s * 0.17, 0.24, 0, torso);
    E(0.1, 0.05, 0.02, skin, 0, 0.22, 0.1, torso, false);
    for (const s of [-1, 1]) {
      B(0.05, 0.5, 0.025, '#2b2925', s * 0.12, 0.02, 0.122, torso, { r: 0.008, cast: false });
      B(0.05, 0.025, 0.26, '#2b2925', s * 0.12, 0.27, 0, torso, { r: 0.008, cast: false });
    }
    B(0.34, 0.4, 0.15, fab('#3a382f'), 0, 0.02, -0.2, torso, { r: 0.04 });
    B(0.28, 0.12, 0.16, fab('#2f2d26'), 0, 0.17, -0.21, torso, { r: 0.03 });
    for (let i = 0; i < 4; i++) B(rand(0.03, 0.07), rand(0.02, 0.04), 0.005, '#86584a', rand(-0.15, 0.15), rand(-0.15, 0.2), 0.117, torso, { cast: false });
  }
  const arms = [];
  for (const s of [1, -1]) {
    const ag = new THREE.Group(); ag.position.set(s * 0.235, 0.2, 0); torso.add(ag);
    const el = s > 0 ? ELB_R : ELB_L, ha = s > 0 ? HAND_R : HAND_L;
    capsule(V3(), el, 0.058, sleeve, ag); capsule(el, ha, 0.05, sleeve, ag);
    B(0.075, 0.085, 0.09, glove, ha.x, ha.y, ha.z, ag, { r: 0.03 });
    arms.push(ag);
  }
  const gun = new THREE.Group(); gun.position.set(0, 0.2, 0); torso.add(gun);
  const gm = M('#2a2c2f', { roughness: 0.4, metalness: 0.6 }), gm2 = M('#1c1d1f', { roughness: 0.7, metalness: 0.2 });
  B(0.06, 0.09, 0.3, gm, 0.1, -0.13, 0.3, gun, { r: 0.012 });
  B(0.065, 0.07, 0.25, M('#7d6e52', { roughness: 0.8 }), 0.1, -0.13, 0.57, gun, { r: 0.015 });
  cyl(0.012, 0.012, 0.18, gm, 0.1, -0.13, 0.78, gun, 8).rotation.x = Math.PI / 2;
  cyl(0.019, 0.019, 0.06, gm2, 0.1, -0.13, 0.86, gun, 8).rotation.x = Math.PI / 2;
  B(0.05, 0.08, 0.22, gm2, 0.1, -0.15, 0.05, gun, { r: 0.015 });
  B(0.035, 0.1, 0.045, gm2, 0.1, -0.21, 0.22, gun, { r: 0.01 }).rotation.x = -0.3;
  B(0.04, 0.16, 0.075, gm2, 0.1, -0.25, 0.33, gun, { r: 0.01 }).rotation.x = 0.2;
  B(0.035, 0.04, 0.06, '#111', 0.1, -0.065, 0.34, gun, { r: 0.008 });
  const muzzle = new THREE.Object3D(); muzzle.position.set(0.1, -0.13, 0.9); gun.add(muzzle);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.flash, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
  flash.scale.set(0.55, 0.55, 1); flash.visible = false; muzzle.add(flash);

  // ragdoll collider recipes (in each part's local frame)
  const armCol = (h) => () => {
    const d = h.clone(), len = d.length(); d.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(YAX, d);
    return [RAPIER.ColliderDesc.capsule(Math.max(0.02, len / 2 - 0.05), 0.05).setTranslation(h.x / 2, h.y / 2, h.z / 2).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })];
  };
  const cols = {
    torso: () => [RAPIER.ColliderDesc.cuboid(0.19, 0.33, 0.12).setTranslation(0, -0.04, 0)],
    head: () => [RAPIER.ColliderDesc.ball(0.14).setTranslation(0, 0.17, 0)],
    thighL: () => [RAPIER.ColliderDesc.capsule(0.14, 0.085).setTranslation(0, -0.21, 0)], thighR: () => [RAPIER.ColliderDesc.capsule(0.14, 0.085).setTranslation(0, -0.21, 0)],
    shinL: () => [RAPIER.ColliderDesc.capsule(0.14, 0.07).setTranslation(0, -0.24, 0)], shinR: () => [RAPIER.ColliderDesc.capsule(0.14, 0.07).setTranslation(0, -0.24, 0)],
    armR: armCol(HAND_R), armL: armCol(HAND_L),
    gun: () => [RAPIER.ColliderDesc.cuboid(0.035, 0.07, 0.42).setTranslation(0.1, -0.15, 0.42)],
  };
  root.traverse(o => { if (o.isMesh) o.receiveShadow = true; });
  return { root, hips, torso, head, thighs, shins, arms, gun, muzzle, flash, cols,
    parts: { torso, head, thighL: thighs[0], shinL: shins[0], thighR: thighs[1], shinR: shins[1], armR: arms[0], armL: arms[1], gun } };
}
function animateCharacter(m, phase, amt, pitch) {
  const sw = Math.sin(phase) * 0.62 * amt;
  m.thighs[0].rotation.x = -sw; m.thighs[1].rotation.x = sw;
  m.shins[0].rotation.x = Math.max(0, -Math.cos(phase)) * 0.9 * amt;
  m.shins[1].rotation.x = Math.max(0, Math.cos(phase)) * 0.9 * amt;
  m.hips.position.y = 0.92 + Math.abs(Math.cos(phase)) * 0.025 * amt;
  m.torso.rotation.x = 0.07 * amt;
  for (const a of m.arms) a.rotation.x = -pitch;
  m.gun.rotation.x = -pitch;
  m.head.rotation.x = -pitch * 0.6;
}

/* ----- ragdolls ----- */
const RAG_LINKS = [['torso', null], ['head', 'torso'], ['thighL', 'torso'], ['shinL', 'thighL'], ['thighR', 'torso'], ['shinR', 'thighR'], ['armL', 'torso'], ['armR', 'torso'], ['gun', null]];
const ragdolls = [];
function makeRagdoll(model, vel, imp, impPart) {
  model.root.updateMatrixWorld(true);
  const parts = {}, list = [];
  for (const [name] of RAG_LINKS) {
    const g = model.parts[name]; scene.attach(g);
    const q = g.quaternion;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(g.position.x, g.position.y, g.position.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinvel(vel.x, vel.y, vel.z).setLinearDamping(0.2).setAngularDamping(1.5).setCcdEnabled(name === 'torso' || name === 'head'));
    for (const cd of model.cols[name]()) world.createCollider(cd.setDensity(name === 'gun' ? 700 : 500).setCollisionGroups(GRP(G_RAG, 0xffff & ~G_RAG)).setFriction(0.9).setRestitution(0.05), body);
    parts[name] = { g, body }; list.push(parts[name]);
  }
  for (const [c, p] of RAG_LINKS) if (p) {
    const pg = parts[p].g; pg.updateMatrixWorld(true);
    const a = pg.worldToLocal(parts[c].g.getWorldPosition(V3()));
    const j = world.createImpulseJoint(RAPIER.JointData.spherical({ x: a.x, y: a.y, z: a.z }, { x: 0, y: 0, z: 0 }), parts[p].body, parts[c].body, true);
    j.setContactsEnabled(false);
  }
  model.root.visible = false;
  if (imp) parts[impPart || 'torso'].body.applyImpulse(imp, true);
  const r = { list, parts, model, born: now };
  ragdolls.push(r);
  while (ragdolls.length > 7) removeRagdoll(ragdolls[0]);
  return r;
}
function removeRagdoll(r) {
  for (const p of r.list) { world.removeRigidBody(p.body); scene.remove(p.g); }
  scene.remove(r.model.root);
  const i = ragdolls.indexOf(r); if (i >= 0) ragdolls.splice(i, 1);
}

function nameSprite(text, color) {
  const tex = canvasTex(256, 64, (g, w, h) => {
    g.font = 'bold 34px Rajdhani, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,.65)'; g.strokeText(text, w / 2, h / 2);
    g.fillStyle = color; g.fillText(text, w / 2, h / 2);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(1.3, 0.33, 1); s.renderOrder = 999;
  return s;
}

/* =====================================================================
   COMBATANTS
   ===================================================================== */
const combatants = [], bots = [];
function makeCombatant(name, team, isPlayer, look) {
  const c = { name, team, isPlayer, look, alive: false, hp: 100, armor: 0, armorMax: 0, pos: V3(), vel: V3(), kills: 0, deaths: 0,
    lastShot: -99, lastShotSil: false, lastDamage: -99, height: 1.84, credits: ECON.start, loadout: { primary: null, side: 'pistol' }, weapon: 'pistol',
    mag: {}, res: {}, smokes: 0, flashes: 0, tagT: -99, blindUntil: 0, noiseT: -99, seenBy: [-99, -99], lastSeenPos: V3(), ragdoll: null, idx: combatants.length };
  c.kin = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -50, 0));
  c.kinCol = world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.3).setCollisionGroups(GRP(G_CHAR, G_PROP | G_RAG | G_DEBRIS)), c.kin);
  c.kin.setEnabled(false);
  combatants.push(c); return c;
}
function refill(c, id) { const W = WEAPONS[id]; if (W && !W.melee) { c.mag[id] = W.mag; c.res[id] = W.reserve; } }
const player = makeCombatant('YOU', 0, true, LOOKS.raven);
Object.assign(player, { height: 1.75, onGround: false, yaw: Math.PI, pitch: 0, crouch: false, eye: 1.62, reloading: false, reloadEnd: 0, nextFire: 0,
  firing: false, fireQueuedAt: -99, ads: false, adsT: 0, recP: 0, recY: 0, swayDir: 1, shotIdx: 0, lastFireT: -99, equipEnd: 0, walkPhase: 0,
  landKick: 0, roll: 0, killer: null, deathT: 0, action: null, actionT: 0, knifeT: 0, knifeAnim: null, bought: [], shake: 0 });

function giveModel(b) {
  if (b.model && b.model.root.parent && !b.ragdoll) scene.remove(b.model.root);
  b.model = buildCharacter(b.look);
  if (b.team === player.team) { const s = nameSprite(b.name, '#5ab8ff'); s.position.y = 2.2; b.model.root.add(s); }
  scene.add(b.model.root);
}
function createBot(name, team, look) {
  const c = makeCombatant(name, team, false, look);
  Object.assign(c, { model: null, yaw: 0, path: null, pathIdx: 0, goalX: undefined, goalZ: undefined, nextRepath: 0, target: null, targetVisible: false, reactAt: 0,
    aimPos: V3(), lastKnown: null, lastSeen: -99, thinkAt: 0, nextShot: 0, burstLeft: 0, shotIdx: 0, strafeDir: 1, peekUntil: 0, stopUntil: 0,
    walkPhase: 0, stuckCheck: 0, stuckPos: V3(), alertedBy: null, alertUntil: 0, flashT: 0, aimPitch: 0, reloading: false, reloadEnd: 0,
    action: null, actionT: 0, task: null, siteIdx: 0, holdIdx: 0, rotated: false, rotCheck: 0, usedSmoke: false });
  bots.push(c);
  return c;
}
// ---------- roster: 8 slots (0-3 RAVEN, 4-7 FROST); each slot is the local player, a bot, or a networked puppet ----------
const TEAM_NAMES = ['RAVEN', 'FROST'];
const BOT_NAMES = [['KAI','MIKA', 'JUNO', 'RHEA'],['VESNA', 'LYRA', 'NIKA', 'OLYA']];
const TEAM_LOOKS = [
  [LOOKS.raven, LOOKS.raven, { ...LOOKS.raven, hair: '#4a2c1e' }, { ...LOOKS.raven, hair: '#b88a52', skin: '#d9a98c' }],
  [LOOKS.frost, { ...LOOKS.frost, hair: '#b8bcc8', fur: '#2c2320', pants: '#2f3330' }, { ...LOOKS.frost, hair: '#e2d2b0' }, { ...LOOKS.frost, hair: '#9a7a64', fur: '#3a2e26' }],
];
const SOLO_ROSTER = [{ slot: 0, kind: 'me', name: 'YOU' }, { slot: 1, kind: 'ai' }, { slot: 4, kind: 'ai' }, { slot: 5, kind: 'ai' }];
const SLOT = new Array(8).fill(null), nets = [];
const botPool = [];
for (let i = 0; i < 7; i++) botPool.push(createBot('BOT', 0, LOOKS.raven));
// spec: [{ slot, kind: 'me' | 'ai' | 'net', name?, peer? }]
function setupRoster(spec) {
  for (const c of [player, ...botPool]) {
    c.alive = false; c.kin.setEnabled(false); c.net = null;
    if (c.model && !c.ragdoll && c.model.root.parent) scene.remove(c.model.root);
  }
  combatants.length = 0; bots.length = 0; nets.length = 0; SLOT.fill(null);
  const pool = botPool.slice();
  for (const e of spec.slice().sort((a, b) => a.slot - b.slot)) {
    const team = e.slot < 4 ? 0 : 1, ti = e.slot % 4;
    const c = e.kind === 'me' ? player : pool.shift();
    c.team = team; c.slot = e.slot; c.idx = combatants.length; c.look = TEAM_LOOKS[team][ti];
    c.name = e.name || BOT_NAMES[team][ti];
    c.ctl = e.kind === 'me' ? 'local' : e.kind; c.peer = e.peer ?? -1;
    combatants.push(c); SLOT[e.slot] = c;
    if (c.ctl === 'ai') bots.push(c); else if (c.ctl === 'net') nets.push(c);
  }
}

const _hb = { head: new THREE.Box3(), body: new THREE.Box3(), leg: new THREE.Box3() };
function hitboxes(c) {
  const p = c.pos, h = c.height, lh = h * 0.47;
  _hb.leg.min.set(p.x - 0.27, p.y, p.z - 0.27); _hb.leg.max.set(p.x + 0.27, p.y + lh, p.z + 0.27);
  _hb.body.min.set(p.x - 0.3, p.y + lh, p.z - 0.3); _hb.body.max.set(p.x + 0.3, p.y + h - 0.33, p.z + 0.3);
  _hb.head.min.set(p.x - 0.19, p.y + h - 0.35, p.z - 0.19); _hb.head.max.set(p.x + 0.19, p.y + h + 0.02, p.z + 0.19);
  return _hb;
}
const chestOf = (c, out) => out.set(c.pos.x, c.pos.y + c.height * 0.62, c.pos.z);
const headOf = (c, out) => out.set(c.pos.x, c.pos.y + c.height - 0.16, c.pos.z);
const eyeOf = (c, out) => out.set(c.pos.x, c.pos.y + (c.isPlayer ? c.eye : c.height - 0.18), c.pos.z);

// wall penetration: thickness (m) x resistance must stay under the weapon's pen value
const PEN_RES = { glass: 0.05, wood: 0.5, metal: 2.5, concrete: 6 };
function rayBoxIO(o, d, b, maxT) {
  let tmin = -Infinity, tmax = Infinity, ax = -1;
  for (let a = 0; a < 3; a++) {
    const k = a === 0 ? 'x' : a === 1 ? 'y' : 'z', dv = d[k], ov = o[k];
    if (Math.abs(dv) < 1e-9) { if (ov < b.min[k] || ov > b.max[k]) return null; continue; }
    let t1 = (b.min[k] - ov) / dv, t2 = (b.max[k] - ov) / dv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) { tmin = t1; ax = a; }
    if (t2 < tmax) tmax = t2;
  }
  if (tmax < Math.max(tmin, 0) || tmin > maxT) return null;
  return [Math.max(0, tmin), tmax, tmin < 0 ? -1 : ax];
}
const _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
function traceShot(o, d, maxD, shooter, real = false, pen = 0) {
  const walls = [];
  for (const s of statics) {
    if (!s.bullet || s.dead || s.glass) continue;
    const r = rayBoxIO(o, d, s.b, maxD); if (r) walls.push({ t: r[0], out: r[1], axis: r[2], s });
  }
  walls.sort((a, b) => a.t - b.t);
  let stopT = maxD, surf = null, axis = 1, ground = false;
  const passed = [];
  if (d.y < 0) { const tg = -o.y / d.y; if (tg < stopT) { stopT = tg; ground = true; } }
  for (const w of walls) {
    if (w.t >= stopT) break;
    const res = (Math.min(w.out, maxD) - w.t) * (PEN_RES[w.s.mat] ?? 6);
    if (pen > 0 && res <= pen && w.axis >= 0) { passed.push({ t: w.t, out: w.out, axis: w.axis, s: w.s, mul: clamp(1 - 0.55 * res / pen, 0.3, 1) }); continue; }
    stopT = w.t; surf = w.s; axis = w.axis; ground = false; break;
  }
  _ray.origin = { x: o.x, y: o.y, z: o.z }; _ray.dir = { x: d.x, y: d.y, z: d.z };
  let prop = null;
  const ph = world.castRay(_ray, stopT, true, undefined, QUERY_DYN);
  if (ph && ph.toi < stopT) { stopT = ph.toi; prop = ph.collider; surf = null; ground = false; }
  let hit = null, part = null, best = stopT;
  for (const c of combatants) {
    if (!c.alive || c.team === shooter.team) continue;
    const hb = hitboxes(c);
    for (const k of ['head', 'body', 'leg']) { const t = rayBox(o, d, hb[k], best); if (t >= 0 && t < best) { best = t; hit = c; part = k; } }
  }
  if (hit) { prop = null; surf = null; ground = false; }
  let mul = 1; const through = passed.filter(p => p.t < best); for (const p of through) mul *= p.mul;
  if (real) for (const s of glassPanes) { if (s.dead) continue; const t = rayBox(o, d, s.b, best); if (t >= 0 && t < best) breakGlass(s, o, d, t); }
  return { t: best, hit, part, head: part === 'head', surf, axis, prop, ground, mul, passed: through };
}

/* =====================================================================
   FX: tracers, particles, smoke, decals, debris
   ===================================================================== */
const tracers = [];
let tracerIdx = 0, TGEO;
function initFX() {
  TGEO = new THREE.CylinderGeometry(0.012, 0.012, 1, 4, 1, true); TGEO.rotateX(Math.PI / 2);
  for (let i = 0; i < 48; i++) {
    const m = noAO(new THREE.Mesh(TGEO, new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.9, 1.1), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
    m.visible = false; m.frustumCulled = false; scene.add(m);
    tracers.push({ m, a: V3(), dir: V3(), dist: 0, travel: 0, on: false });
  }
  const PGEO = new THREE.BoxGeometry(0.05, 0.05, 0.05);
  PMAT.dust = new THREE.MeshStandardMaterial({ color: 0xa89c80, roughness: 1 });
  PMAT.spark = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.8, 1.2), toneMapped: false });
  PMAT.hit = new THREE.MeshStandardMaterial({ color: 0x6e1212, roughness: 0.6 });
  PMAT.grass = new THREE.MeshStandardMaterial({ color: 0x55712f, roughness: 1 });
  PMAT.wood = new THREE.MeshStandardMaterial({ color: 0x8a6a42, roughness: 1 });
  for (let i = 0; i < 260; i++) { const m = noAO(new THREE.Mesh(PGEO, PMAT.dust)); m.visible = false; scene.add(m); parts.push({ m, v: V3(), life: 0, max: 1, grav: 9.8 }); }
  for (let i = 0; i < 60; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.smoke, transparent: true, depthWrite: false, color: 0xd8d4cc, opacity: 0 }));
    s.visible = false; scene.add(s); smokes.push({ s, v: V3(), life: 0, max: 1, size: 1 });
  }
  const holeM = new THREE.MeshStandardMaterial({ map: TX.hole, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 1 });
  const hg = new THREE.PlaneGeometry(0.11, 0.11);
  for (let i = 0; i < 160; i++) { const m = noAO(new THREE.Mesh(hg, holeM)); m.visible = false; m.receiveShadow = true; scene.add(m); decals.push(m); }
}
function tracer(a, b) {
  const t = tracers[tracerIdx++ % tracers.length];
  t.a.copy(a); t.dir.subVectors(b, a); t.dist = t.dir.length(); if (t.dist < 0.5) return;
  t.dir.divideScalar(t.dist); t.travel = 0; t.on = true; t.m.visible = true;
}
const _ta = V3(), _tb = V3();
function updateTracers(dt) {
  for (const t of tracers) {
    if (!t.on) continue;
    t.travel += 400 * dt;
    const hd = Math.min(t.travel, t.dist), tl = Math.max(0, t.travel - 5);
    if (tl >= t.dist) { t.on = false; t.m.visible = false; continue; }
    _ta.copy(t.a).addScaledVector(t.dir, tl); _tb.copy(t.a).addScaledVector(t.dir, hd);
    t.m.position.copy(_ta).lerp(_tb, 0.5); t.m.scale.set(1, 1, Math.max(0.01, hd - tl)); t.m.lookAt(_tb);
  }
}
const PMAT = {}, parts = [], smokes = [], decals = [];
let partIdx = 0, smokeIdx = 0, decalIdx = 0;
function burst(pos, type, n, back, speed = 1) {
  for (let i = 0; i < n; i++) {
    const p = parts[partIdx++ % parts.length];
    p.m.material = PMAT[type]; p.m.position.copy(pos); p.m.visible = true;
    p.v.set(rand(-1.5, 1.5), rand(0.5, 3), rand(-1.5, 1.5)).multiplyScalar(speed); if (back) p.v.addScaledVector(back, rand(1, 3.5) * speed);
    p.life = p.max = type === 'spark' ? rand(0.12, 0.3) : rand(0.3, 0.7);
    p.m.scale.setScalar(type === 'spark' ? 0.35 : rand(0.6, 1.4));
  }
}
function puff(pos, size, n, v, life = 1.4, color = 0xd8d4cc) {
  for (let i = 0; i < n; i++) {
    const s = smokes[smokeIdx++ % smokes.length];
    s.s.position.copy(pos).add(V3(rand(-0.05, 0.05), rand(-0.05, 0.05), rand(-0.05, 0.05)));
    s.v.copy(v || V3()).add(V3(rand(-0.3, 0.3), rand(0.2, 0.6), rand(-0.3, 0.3)));
    s.life = s.max = life * rand(0.7, 1.2); s.size = size * rand(0.7, 1.3); s.s.visible = true; s.s.material.color.set(color);
    s.s.material.rotation = rand(0, TAU);
  }
}
function decal(pos, nrm) {
  const m = decals[decalIdx++ % decals.length];
  m.position.copy(pos).addScaledVector(nrm, 0.006); m.lookAt(V3().copy(m.position).add(nrm)); m.rotateZ(rand(0, TAU));
  m.scale.setScalar(rand(0.7, 1.2)); m.visible = true;
}
function updateParts(dt) {
  for (const p of parts) {
    if (p.life <= 0) continue;
    p.life -= dt; if (p.life <= 0) { p.m.visible = false; continue; }
    p.v.y -= 9.8 * dt; p.m.position.addScaledVector(p.v, dt);
    if (p.m.position.y < 0.01) { p.m.position.y = 0.01; p.v.multiplyScalar(0.3); }
  }
  for (const s of smokes) {
    if (s.life <= 0) continue;
    s.life -= dt; if (s.life <= 0) { s.s.visible = false; continue; }
    const k = 1 - s.life / s.max;
    s.s.position.addScaledVector(s.v, dt); s.v.multiplyScalar(Math.exp(-dt * 1.5));
    s.s.scale.setScalar(s.size * (0.4 + k * 1.4)); s.s.material.opacity = 0.55 * (1 - k) * Math.min(1, k * 8);
  }
}
function impactFX(end, d, surf, axis, isGround) {
  const back = d.clone().negate();
  const n = V3(); if (isGround || axis < 0) n.set(0, 1, 0); else { n.setComponent(axis, d.getComponent(axis) > 0 ? -1 : 1); }
  const type = isGround ? 'grass' : surf ? surf.mat : 'concrete';
  if (type === 'metal') { burst(end, 'spark', 7, n, 1.6); puff(end, 0.25, 1, n.clone().multiplyScalar(0.5), 0.6, 0xb0aca4); ricochet(end); }
  else if (type === 'wood') { burst(end, 'wood', 6, n); puff(end, 0.3, 1, n.clone().multiplyScalar(0.5), 0.8, 0xa58f6c); }
  else if (type === 'grass') { burst(end, 'grass', 5, n); puff(end, 0.35, 1, n.clone().multiplyScalar(0.4), 0.9, 0x8f8366); }
  else { burst(end, 'dust', 6, n); puff(end, 0.4, 2, n.clone().multiplyScalar(0.6), 1.1, 0xc9c2b2); }
  if (!isGround || Math.random() < 0.5) decal(end, n);
}

// physics debris (casings, glass shards)
const debris = [];
function addDebris(mesh, desc, pos, quat, vel, angv, life, density) {
  mesh.position.copy(pos); if (quat) mesh.quaternion.copy(quat); scene.add(mesh); noAO(mesh);
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation(quat ? { x: quat.x, y: quat.y, z: quat.z, w: quat.w } : { x: 0, y: 0, z: 0, w: 1 }).setLinvel(vel.x, vel.y, vel.z).setAngvel(angv).setLinearDamping(0.3).setAngularDamping(0.5));
  world.createCollider(desc.setDensity(density).setCollisionGroups(GRP(G_DEBRIS, G_STATIC | G_PROP | G_RAG)).setRestitution(0.35).setFriction(0.6), body);
  debris.push({ mesh, body, die: now + life });
  if (debris.length > 110) killDebris(debris[0]);
}
function killDebris(d) { world.removeRigidBody(d.body); scene.remove(d.mesh); d.mesh.geometry.dispose(); const i = debris.indexOf(d); if (i >= 0) debris.splice(i, 1); }
const casingGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6); casingGeo.rotateX(Math.PI / 2);
function ejectCasing(pos, right, up, fwd, baseVel) {
  const v = V3().copy(baseVel).addScaledVector(right, rand(2, 3.2)).addScaledVector(up, rand(1.2, 2.2)).addScaledVector(fwd, rand(-0.5, 0.3));
  const m = new THREE.Mesh(casingGeo.clone(), MAT.brass); m.castShadow = false;
  addDebris(m, RAPIER.ColliderDesc.cuboid(0.007, 0.007, 0.015), pos, camera.quaternion, v, { x: rand(-20, 20), y: rand(-20, 20), z: rand(-20, 20) }, 4, 8000);
  setTimeout(() => tink(), rand(380, 650));
}
function breakGlass(s, o, d, t) {
  s.dead = true; s.mesh.visible = false;
  if (s.col) { world.removeCollider(s.col, true); s.col = null; }
  const c = s.b.getCenter(V3()), size = s.b.getSize(V3()), hitP = V3().copy(o).addScaledVector(d, t);
  const thinX = size.x < size.z;
  for (let i = 0; i < 18; i++) {
    const w = rand(0.06, 0.22), h = rand(0.06, 0.26);
    const p = V3(thinX ? c.x : c.x + rand(-size.x / 2, size.x / 2) * 0.9, c.y + rand(-size.y / 2, size.y / 2) * 0.9, thinX ? c.z + rand(-size.z / 2, size.z / 2) * 0.9 : c.z);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rand(-0.3, 0.3), thinX ? Math.PI / 2 : 0, rand(0, TAU)));
    const near = Math.max(0, 1.6 - p.distanceTo(hitP));
    const v = V3().copy(d).multiplyScalar(rand(0.5, 2.5) * (0.4 + near)).add(V3(rand(-0.6, 0.6), rand(-0.2, 1), rand(-0.6, 0.6)));
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.006), MAT.shard);
    addDebris(m, RAPIER.ColliderDesc.cuboid(w / 2, h / 2, 0.006), p, q, v, { x: rand(-6, 6), y: rand(-6, 6), z: rand(-6, 6) }, 7, 2500);
  }
  glassSound(c);
}
function resetGlass() {
  for (const s of glassPanes) { if (!s.dead) continue; s.dead = false; s.mesh.visible = true; s.col = makeFixedCollider(s.b); }
}

/* =====================================================================
   AUDIO (synthesized)
   ===================================================================== */
let actx = null, master = null, noiseBuf = null;
function initAudio() {
  if (actx) { actx.resume(); return; }
  actx = new (window.AudioContext || window.webkitAudioContext)();
  master = actx.createGain(); master.gain.value = 0.55; master.connect(actx.destination);
  noiseBuf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
  const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = actx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
  const g = actx.createGain(); g.gain.value = 0.045;
  src.connect(f).connect(g).connect(master); src.start();
  setInterval(() => { if (actx && state === 'playing' && !paused && Math.random() < 0.5) chirp(); }, 2600);
}
function chirp() {
  const t = actx.currentTime, n = 2 + (Math.random() * 3 | 0), base = rand(2400, 3600);
  for (let i = 0; i < n; i++) {
    const o = actx.createOscillator(), g = actx.createGain(); o.type = 'sine'; const st = t + i * 0.11;
    o.frequency.setValueAtTime(base, st); o.frequency.exponentialRampToValueAtTime(base * 1.35, st + 0.06);
    g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(0.025, st + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, st + 0.08);
    o.connect(g).connect(master); o.start(st); o.stop(st + 0.1);
  }
}
function panFor(pos) {
  const lx = pos.x - camera.position.x, lz = pos.z - camera.position.z, ld = Math.hypot(lx, lz);
  const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
  return { d: ld, pan: (lx * rx + lz * rz) / (ld || 1) * 0.8 };
}
function noiseHit(vol, type, freq, dur, pan = 0, q = 1, delay = 0, endFreq = 0) {
  if (!actx || vol < 0.003) return;
  const t = actx.currentTime + delay, src = actx.createBufferSource(); src.buffer = noiseBuf;
  const f = actx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (endFreq) f.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  const g = actx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  const p = actx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
  src.connect(f).connect(g).connect(p).connect(master); src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
}
function shotSound(dist, pan, mine) {
  if (!actx) return;
  const t = actx.currentTime, vol = mine ? 0.75 : 0.7 / (1 + dist / 10);
  if (vol < 0.01) return;
  noiseHit(vol, 'lowpass', mine ? 7000 : Math.max(600, 5200 - dist * 70), mine ? 0.2 : 0.32, pan, 0.7, 0, 300);
  const p = actx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); p.connect(master);
  const o = actx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(mine ? 170 : 110, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.12);
  const og = actx.createGain(); og.gain.setValueAtTime(vol * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  o.connect(og).connect(p); o.start(t); o.stop(t + 0.16);
  noiseHit(vol * 0.12, 'bandpass', 900, 0.6, pan, 0.6, 0.05); // tail
}
function blip(freq, dur, type = 'square', vol = 0.1, delay = 0) {
  if (!actx) return;
  const t = actx.currentTime + delay, o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
}
const click = (delay, freq = 2500, vol = 0.25) => noiseHit(vol, 'bandpass', freq, 0.05, 0, 3, delay);
const tink = () => { if (!actx) return; blip(rand(3800, 5200), 0.06, 'sine', 0.04); blip(rand(6000, 7000), 0.04, 'sine', 0.02, 0.05); };
function ricochet(pos) { const { d, pan } = panFor(pos); if (d < 30 && Math.random() < 0.5 && actx) { const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain(), p = actx.createStereoPanner(); p.pan.value = pan; o.frequency.setValueAtTime(rand(2500, 4000), t); o.frequency.exponentialRampToValueAtTime(rand(700, 1200), t + 0.25); g.gain.setValueAtTime(0.06 / (1 + d / 8), t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25); o.connect(g).connect(p).connect(master); o.start(t); o.stop(t + 0.27); } }
function glassSound(pos) { const { d, pan } = panFor(pos); const v = 0.5 / (1 + d / 8); for (let i = 0; i < 9; i++) noiseHit(v * rand(0.3, 0.8), 'bandpass', rand(3000, 8000), rand(0.05, 0.2), pan, 4, rand(0, 0.35)); noiseHit(v * 0.5, 'highpass', 2500, 0.5, pan, 0.5); }
function stepSound(vol, pan = 0) { noiseHit(vol, 'lowpass', rand(600, 900), 0.09, pan, 1); noiseHit(vol * 0.4, 'bandpass', rand(2500, 3500), 0.04, pan, 2); }
function hurtSound() { blip(90, 0.18, 'sine', 0.35); click(0, 400, 0.3); }

/* =====================================================================
   HUD
   ===================================================================== */
const hud = {};
for (const id of ['wA', 'wB', 'roleA', 'roleB', 'pipsA', 'pipsB', 'rtime', 'phase', 'mag', 'res', 'ammo', 'reloadhint', 'hpbar', 'hpnum', 'armnum', 'vignette', 'killfeed', 'hitmarker',
  'aimname', 'popups', 'dmgdirs', 'crosshair', 'fps', 'credits', 'wname', 'uQ', 'uE', 'chargeIco', 'banner', 'bannerT', 'bannerS', 'action', 'actionL', 'actionBar', 'ctxhint',
  'spectate', 'flashov', 'smokeov', 'scope', 'death', 'killer', 'note']) hud[id] = $(id);
const chParts = { t: hud.crosshair.querySelector('.t'), b: hud.crosshair.querySelector('.b'), l: hud.crosshair.querySelector('.l'), r: hud.crosshair.querySelector('.r') };
const cls = c => !c ? 'x' : c.isPlayer ? 'me' : c.team === player.team ? 'a' : 'e';
function killfeed(att, vic, head, wid, wall) {
  const el = document.createElement('div'); el.className = 'kf' + ((att && att.isPlayer) || vic.isPlayer ? ' mine' : '');
  const wn = att ? (WEAPONS[wid] ? WEAPONS[wid].short : '') : 'CHARGE';
  el.innerHTML = `${att ? `<span class="${cls(att)}">${att.name}</span>` : ''}<span class="wn">${wn}</span>${wall ? '<span class="hs">WALL</span>' : ''}${head ? '<span class="hs">HS</span>' : ''}<span class="${cls(vic)}">${vic.name}</span>`;
  hud.killfeed.prepend(el);
  while (hud.killfeed.children.length > 5) hud.killfeed.lastChild.remove();
  setTimeout(() => el.remove(), 6000);
}
function popup(text, big) { const el = document.createElement('div'); el.className = 'pop' + (big ? ' big' : ''); el.textContent = text; hud.popups.append(el); setTimeout(() => el.remove(), 1650); }
function hitmarker(kind) { hud.hitmarker.classList.remove('show', 'kill', 'head'); void hud.hitmarker.offsetWidth; hud.hitmarker.classList.add('show'); if (kind) hud.hitmarker.classList.add(kind); }
let bannerTimer = 0;
function banner(t, s, cls2, dur = 2.5) {
  hud.bannerT.textContent = t; hud.bannerS.textContent = s || '';
  hud.banner.className = cls2 || ''; void hud.banner.offsetWidth; bannerTimer = dur;
}
const dmgInds = [];
function damageIndicator(from) {
  const el = document.createElement('div'); el.className = 'dd'; hud.dmgdirs.append(el);
  dmgInds.push({ el, from: from.clone(), t: now });
  if (dmgInds.length > 4) { dmgInds[0].el.remove(); dmgInds.shift(); }
}
function updateDmgInds() {
  for (let i = dmgInds.length - 1; i >= 0; i--) {
    const d = dmgInds[i], age = now - d.t;
    if (age > 1.3) { d.el.remove(); dmgInds.splice(i, 1); continue; }
    const vx = d.from.x - player.pos.x, vz = d.from.z - player.pos.z;
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw), rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
    d.el.style.transform = `rotate(${Math.atan2(vx * rx + vz * rz, vx * fx + vz * fz)}rad)`; d.el.style.opacity = clamp(1.3 - age, 0, 1);
  }
}
function renderBoard(el) {
  const mp = NET.mode !== 'off';
  const ping = c => c.peer === 0 ? 'HOST' : c.isPlayer ? NET.ping + ' MS' : c.ctl !== 'ai' && c.ping >= 0 ? c.ping + ' MS' : 'BOT';
  const row = c => `<tr class="${c.alive ? '' : 'deadrow'}"><td style="color:${c.isPlayer ? 'var(--gold)' : c.team === player.team ? 'var(--ally)' : 'var(--enemy)'}">${c.name}</td><td>${c.kills}</td><td>${c.deaths}</td><td>${c.team === player.team ? '¤ ' + c.credits : '—'}</td>${mp ? `<td><small>${ping(c)}</small></td>` : ''}</tr>`;
  const team = t => combatants.filter(c => c.team === t).sort((a, b) => b.kills - a.kills).map(row).join('');
  const role = t => R.attTeam === t ? 'ATTACK' : 'DEFENSE';
  const sect = t => `<h3 style="color:${t === player.team ? 'var(--ally)' : 'var(--enemy)'}">${TEAM_NAMES[t]} · ${R.wins[t]} · ${role(t)}</h3><table><tr><th>NAME</th><th>K</th><th>D</th><th>CREDITS</th>${mp ? '<th>PING</th>' : ''}</tr>${team(t)}</table>`;
  el.innerHTML = sect(player.team) + sect(1 - player.team);
}
// minimap
const mm = $('minimap'), mctx = mm.getContext('2d'), MMS = 2;
const mmX = x => (BX - x) * MMS, mmY = z => (BZ - z) * MMS;
const mmBase = document.createElement('canvas'); mmBase.width = mm.width; mmBase.height = mm.height;
function buildMinimapBase() {
  const g = mmBase.getContext('2d');
  g.fillStyle = 'rgba(48,66,34,.9)'; g.fillRect(0, 0, mm.width, mm.height);
  g.fillStyle = 'rgba(80,82,85,.8)'; g.fillRect(mmX(46), mmY(16), 92 * MMS, 32 * MMS);
  g.fillStyle = 'rgba(220,166,42,.25)'; g.fillRect(mmX(46), mmY(7.6), 92 * MMS, 15.2 * MMS);
  for (const s of SITES) {
    g.fillStyle = 'rgba(255,90,78,.18)'; g.fillRect(mmX(s.max.x), mmY(s.max.z), (s.max.x - s.min.x) * MMS, (s.max.z - s.min.z) * MMS);
    g.fillStyle = 'rgba(255,255,255,.85)'; g.font = 'bold 18px Rajdhani, Arial'; g.textAlign = 'center'; g.fillText(s.id, mmX(s.center.x), mmY(s.center.z) + 6);
  }
  for (const s of statics) {
    const b = s.b; if (!s.nav || !s.bullet || b.max.y <= 0.45 || b.min.y > 2) continue;
    g.fillStyle = 'rgba(235,232,220,.75)'; g.fillRect(mmX(b.max.x), mmY(b.max.z), (b.max.x - b.min.x) * MMS, (b.max.z - b.min.z) * MMS);
  }
}
function drawMinimap() {
  mctx.clearRect(0, 0, mm.width, mm.height); mctx.drawImage(mmBase, 0, 0);
  const C = R.charge;
  const showCharge = C.state === 'planted' || C.state === 'dropped' && player.team === R.attTeam || (C.state === 'carried' && C.carrier && C.carrier.team === player.team && !C.carrier.isPlayer);
  if (showCharge) { const p = C.state === 'carried' ? C.carrier.pos : C.pos; mctx.fillStyle = C.state === 'planted' ? '#ff5a4e' : '#ff8a4e'; mctx.save(); mctx.translate(mmX(p.x), mmY(p.z)); mctx.rotate(Math.PI / 4); mctx.fillRect(-4, -4, 8, 8); mctx.restore(); }
  for (const c of combatants) {
    if (c.isPlayer) continue;
    if (c.team === player.team) {
      mctx.fillStyle = c.alive ? '#5ab8ff' : 'rgba(90,184,255,.35)';
      if (c.alive) { mctx.beginPath(); mctx.arc(mmX(c.pos.x), mmY(c.pos.z), 4, 0, TAU); mctx.fill(); }
      continue;
    }
    if (!c.alive) continue;
    const seen = now - c.seenBy[player.team];
    if (seen < 0.35) { mctx.fillStyle = '#ff5a4e'; mctx.beginPath(); mctx.arc(mmX(c.pos.x), mmY(c.pos.z), 4, 0, TAU); mctx.fill(); }
    else if (seen < 4) { mctx.fillStyle = `rgba(255,90,78,${(1 - seen / 4).toFixed(2)})`; mctx.font = 'bold 13px Arial'; mctx.textAlign = 'center'; mctx.fillText('?', mmX(c.lastSeenPos.x), mmY(c.lastSeenPos.z) + 4); }
  }
  if (player.alive) {
    const x = mmX(player.pos.x), y = mmY(player.pos.z), fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    mctx.save(); mctx.translate(x, y); mctx.rotate(Math.atan2(-fz, -fx));
    mctx.fillStyle = 'rgba(242,182,50,.18)'; mctx.beginPath(); mctx.moveTo(0, 0); mctx.arc(0, 0, 40, -0.6, 0.6); mctx.closePath(); mctx.fill();
    mctx.fillStyle = '#f2b632'; mctx.beginPath(); mctx.moveTo(8, 0); mctx.lineTo(-5, -5); mctx.lineTo(-2, 0); mctx.lineTo(-5, 5); mctx.closePath(); mctx.fill();
    mctx.restore();
  }
  for (const c of clouds) { const r = cloudR(c); if (r < 0.5) continue; mctx.fillStyle = 'rgba(200,200,205,.55)'; mctx.beginPath(); mctx.arc(mmX(c.pos.x), mmY(c.pos.z), r * MMS, 0, TAU); mctx.fill(); }
}
// buy menu
const BUY_ITEMS = [
  { cat: 'SIDEARMS', items: ['pistol', 'magnum'] }, { cat: 'SNIPER', items: ['sniper'] }, { cat: 'ARMOR', items: ['light', 'heavy'] }, { cat: 'UTILITY', items: ['smoke', 'flash'] },
];
function itemInfo(id) {
  if (WEAPONS[id]) { const W = WEAPONS[id], r = W.dmg[0]; return { name: W.name, price: W.price, sub: `${W.auto ? 'AUTO' : 'SEMI'} · ${r[1]}/${r[2]}/${r[3]} · ${W.mag} RDS` }; }
  if (ARMOR[id]) return { name: ARMOR[id].name, price: ARMOR[id].price, sub: `+${ARMOR[id].val} SHIELD · ABSORBS 66%` };
  return { name: UTIL[id].name, price: UTIL[id].price, sub: id === 'smoke' ? '15S VISION BLOCK · MAX 1' : 'BLINDS ANYONE FACING IT · MAX 2' };
}
let buyOpen = false;
function buildBuyMenu() {
  const root = $('buyGrid'); root.innerHTML = '';
  for (const cat of BUY_ITEMS) {
    const col = document.createElement('div'); col.className = 'bcat'; col.innerHTML = `<h4>${cat.cat}</h4>`;
    for (const id of cat.items) {
      const b = document.createElement('button'); b.className = 'bitem'; b.dataset.item = id;
      const inf = itemInfo(id);
      b.innerHTML = `<span class="bn">${inf.name}</span><span class="bs">${inf.sub}</span><span class="bp">${inf.price ? '¤ ' + inf.price : 'FREE'}</span>`;
      b.addEventListener('click', () => { playerBuy(id); refreshBuyMenu(); });
      col.append(b);
    }
    root.append(col);
  }
}
function refreshBuyMenu() {
  $('buyCredits').textContent = '¤ ' + player.credits;
  for (const b of document.querySelectorAll('.bitem')) {
    const id = b.dataset.item, own = owns(player, id);
    b.classList.toggle('owned', own); b.classList.toggle('poor', !own && priceOf(id) > player.credits);
  }
}

/* =====================================================================
   DAMAGE / KILLS / SPAWN
   ===================================================================== */
let hurtFlash = 0;
function applyDamage(t, raw, att, part, dir, wid, wall) {
  if (!t.alive) return;
  // multiplayer client: the host owns health, so report our hit and let it decide
  if (NET.mode === 'client') {
    if (att === player && t !== player) netSend({ t: 'h', v: t.slot, dmg: r2(raw), p: part, d: dir ? arr(dir) : 0, w: wid, wl: wall ? 1 : 0 });
    return;
  }
  let dmg = raw;
  if (t.armor > 0) { const ab = Math.min(t.armor, dmg * 0.66); t.armor -= ab; dmg -= ab; }
  t.hp -= dmg; t.lastDamage = now; t.tagT = now;
  netEmit({ t: 'd', v: t.slot, a: slotOf(att), hp: r2(t.hp), ar: r2(t.armor) });
  if (t.isPlayer) { if (att) damageIndicator(att.pos); hurtSound(); hurtFlash = 0.6; buzz(dmg > 60 ? 70 : 35); }
  else if (att) { t.alertedBy = att; t.alertUntil = now + 2.5; t.lastKnown = att.pos.clone(); t.lastSeen = Math.max(t.lastSeen, now - 2); }
  if (t.hp <= 0) kill(t, att, part === 'head', dir, wid, wall);
}
function kill(t, att, head, dir, wid, wall) {
  if (!t.alive) return;
  netEmit({ t: 'k', v: t.slot, a: slotOf(att), h: head ? 1 : 0, d: dir ? arr(dir) : 0, w: wid || '', wl: wall ? 1 : 0 });
  t.alive = false; t.hp = 0; t.deaths++;
  if (att && att.team !== t.team) { att.kills++; att.credits = Math.min(ECON.max, att.credits + ECON.kill); }
  killfeed(att, t, head, wid, wall);
  t.kin.setEnabled(false);
  if (R.charge.carrier === t) dropCharge(t);
  t.loadout = { primary: null, side: 'pistol' }; t.armor = 0; t.armorMax = 0; t.smokes = 0; t.flashes = 0;
  const imp = dir ? { x: dir.x * (head ? 14 : 50), y: 16 + (head ? 4 : 0), z: dir.z * (head ? 14 : 50) } : { x: rand(-30, 30), y: 40, z: rand(-30, 30) };
  if (!t.isPlayer) {
    t.target = null; t.action = null;
    if (t.model) { t.model.flash.visible = false; t.ragdoll = makeRagdoll(t.model, t.vel, imp, head ? 'head' : 'torso'); }
  }
  if (att && att.isPlayer) {
    buzz(25);
    hitmarker('kill'); blip(880, 0.08, 'square', 0.12); blip(1320, 0.14, 'square', 0.1, 0.07);
    popup(head ? 'HEADSHOT' : 'ELIMINATED');
    const alive = combatants.filter(c => c.team !== player.team && c.alive).length;
    if (alive === 0) popup('ACE', true);
  }
  if (t.isPlayer) {
    const p = player;
    p.killer = att; p.firing = false; p.ads = false; p.action = null; p.deathT = 0; p.reloading = false;
    const m = buildCharacter(p.look);
    m.root.position.copy(p.pos); m.root.rotation.y = p.yaw + Math.PI; scene.add(m.root);
    animateCharacter(m, 0, 0, p.pitch * 0.5);
    p.ragdoll = makeRagdoll(m, p.vel, imp, head ? 'head' : 'torso');
    hud.killer.textContent = att ? att.name : 'THE CHARGE'; hud.death.classList.remove('hidden');
    if (buyOpen) closeBuy(false);
  }
  for (const b of bots) if (b.target === t) { b.target = null; b.targetVisible = false; }
}
function placeAtSpawn(c, i) {
  const att = c.team === R.attTeam, list = att ? SPAWN_ATT : SPAWN_DEF, p = list[i % list.length];
  c.pos.set(p.x + rand(-0.6, 0.6), 0, p.z + rand(-0.6, 0.6)); c.vel.set(0, 0, 0);
  c.hp = 100; c.alive = true; c.tagT = -99; c.blindUntil = 0; c.lastDamage = -99; c.seenBy = [-99, -99];
  c.kin.setTranslation({ x: c.pos.x, y: 0.9, z: c.pos.z }, true);
  c.kin.setNextKinematicTranslation({ x: c.pos.x, y: 0.9, z: c.pos.z });
  c.kin.setEnabled(true);
  if (c.loadout.primary) refill(c, c.loadout.primary);
  refill(c, c.loadout.side);
  c.weapon = c.loadout.primary || c.loadout.side;
  if (c.isPlayer) {
    Object.assign(player, { yaw: att ? Math.PI : 0, pitch: 0, crouch: false, killer: null, ragdoll: null, action: null, actionT: 0, reloading: false,
      recP: 0, recY: 0, shotIdx: 0, adsT: 0, ads: false, firing: false, equipEnd: now + 0.3, knifeAnim: null, deathT: 0 });
    camera.rotation.z = 0; hud.death.classList.add('hidden');
  } else {
    c.ragdoll = null; giveModel(c); fitBotGun(c.model, c.weapon);
    Object.assign(c, { yaw: att ? 0 : Math.PI, path: null, goalX: undefined, target: null, targetVisible: false, lastKnown: null, lastSeen: -99, alertedBy: null,
      action: null, actionT: 0, reloading: false, burstLeft: 0, shotIdx: 0, stuckCheck: now + 1.5, task: null });
    c.stuckPos.copy(c.pos);
    c.model.root.position.copy(c.pos); c.model.root.rotation.set(0, c.yaw, 0);
  }
}

/* =====================================================================
   BOT AI
   ===================================================================== */
const _eye = V3(), _tc = V3(), _th = V3(), _tmp = V3(), _dir = V3();
function think(b) {
  eyeOf(b, _eye);
  const blind = now < b.blindUntil;
  const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
  let best = null, bd = 1e9;
  if (!blind) for (const e of combatants) {
    if (e.team === b.team || !e.alive) continue;
    chestOf(e, _tc);
    const dx = _tc.x - _eye.x, dz = _tc.z - _eye.z, d = Math.hypot(dx, dz);
    if (d > 95) continue;
    const dot = (dx * fx + dz * fz) / (d || 1);
    const heard = (now - e.lastShot < 0.5 && d < (e.lastShotSil ? 14 : 50)) || (now - e.noiseT < 0.4 && d < 17);
    if (!(dot > 0.2 || d < 4 || b.alertedBy === e || b.target === e || heard)) continue;
    const vis = (losClear(_eye, _tc) && !smokeBlocks(_eye, _tc)) || (losClear(_eye, headOf(e, _th)) && !smokeBlocks(_eye, _th));
    if (!vis) { if (heard) { b.lastKnown = e.pos.clone(); b.lastSeen = Math.max(b.lastSeen, now - 2.5); } continue; }
    e.seenBy[b.team] = now; e.lastSeenPos.copy(e.pos);
    const shotAtMe = b.alertedBy === e && now < b.alertUntil;
    if (d > (WEAPONS[b.weapon].range || 50) && !shotAtMe) continue;
    if (d < bd) { bd = d; best = e; }
  }
  if (best) {
    if (b.target !== best) {
      b.target = best; b.reactAt = now + rand(0.26, 0.48);
      chestOf(best, b.aimPos); b.aimPos.x += rand(-1.2, 1.2); b.aimPos.y += rand(-0.5, 0.8); b.aimPos.z += rand(-1.2, 1.2);
    }
    b.targetVisible = true; b.lastKnown = best.pos.clone(); b.lastSeen = now;
  } else {
    b.targetVisible = false;
    if (b.target && now - b.lastSeen > 1.2) b.target = null;
  }
  if (now > b.alertUntil) b.alertedBy = null;
  // defenders rotate when the team spots attackers on the other site
  if (b.team !== R.attTeam && R.phase === 'live' && now > b.rotCheck && !b.rotated) {
    b.rotCheck = now + 1;
    const other = 1 - b.siteIdx;
    const near = (si, r) => combatants.some(e => e.team !== b.team && e.alive && now - e.seenBy[b.team] < 3 && dist2(e.lastSeenPos, SITES[si].center) < r);
    if (near(other, 20) && !near(b.siteIdx, 26) && Math.random() < 0.7) { b.siteIdx = other; b.holdIdx = 1; b.rotated = true; }
  }
}
function setGoal(b, x, z) { b.path = findPath(b.pos.x, b.pos.z, x, z); b.pathIdx = b.path && b.path.length > 1 ? 1 : 0; b.goalX = x; b.goalZ = z; }
function pathDir(b) {
  while (b.path && b.pathIdx < b.path.length) {
    const wp = b.path[b.pathIdx], dx = wp.x - b.pos.x, dz = wp.z - b.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.6) { b.pathIdx++; continue; }
    return _dir.set(dx / d, 0, dz / d);
  }
  return null;
}
function moveTo(b, x, z, arrive = 0.7) {
  if (Math.hypot(x - b.pos.x, z - b.pos.z) < arrive) return null;
  const changed = b.goalX === undefined || Math.hypot(x - b.goalX, z - b.goalZ) > 1.5;
  if ((changed || !b.path || b.pathIdx >= b.path.length) && now > b.nextRepath) { setGoal(b, x, z); b.nextRepath = now + 0.6; }
  return pathDir(b);
}
function botTask(b) {
  const C = R.charge, att = b.team === R.attTeam;
  if (R.phase === 'buy' || R.phase === 'end') return { mode: 'idle' };
  if (att) {
    if (C.state === 'dropped') {
      let best = null, bd = 1e9;
      for (const c of combatants) if (c.alive && c.team === b.team) { const d = dist2(c.pos, C.pos); if (d < bd) { bd = d; best = c; } }
      if (best === b) return { mode: 'move', goal: snapWalk(C.pos.x, C.pos.z) };
    }
    const s = SITES[R.planSite];
    if (C.carrier === b) {
      const sp = s.plantV[b.idx % s.plantV.length];
      if (siteAt(b.pos) === R.planSite && dist2(b.pos, sp) < 2.5) return { mode: 'plant', goal: sp };
      return { mode: 'move', goal: sp };
    }
    if (C.state === 'planted') { const ps = SITES[C.site].postV[b.idx % 2]; return { mode: 'hold', goal: ps.p, look: C.pos }; }
    const car = C.carrier && C.carrier.alive && C.carrier !== b && C.carrier.ctl === 'ai' ? C.carrier : null;
    if (car && dist2(car.pos, b.pos) > 8 && siteAt(b.pos) !== R.planSite) return { mode: 'move', goal: car.pos, follow: true };
    return { mode: 'move', goal: s.plantV[(b.idx + 1) % s.plantV.length], clear: true };
  }
  if (C.state === 'planted') { if (dist2(b.pos, C.pos) < 1.3) return { mode: 'defuse', goal: C.pos }; return { mode: 'move', goal: C.pos }; }
  const s = SITES[b.siteIdx], h = s.holdV[b.holdIdx % s.holdV.length];
  return { mode: 'hold', goal: h.p, look: h.look };
}
function botThrow(b, type, target) {
  if (type === 'smoke') b.smokes--; else b.flashes--;
  eyeOf(b, _eye);
  const dx = target.x - _eye.x, dz = target.z - _eye.z, d = Math.hypot(dx, dz) || 1, v = 15;
  const th = 0.5 * Math.asin(clamp(d * 9.81 / (v * v), 0, 1)) + 0.04;
  throwUtil(b, type, _eye.clone(), V3(dx / d * Math.cos(th), Math.sin(th), dz / d * Math.cos(th)), v);
}
function botUtility(b) {
  if (R.phase !== 'live' && R.phase !== 'planted') return;
  const att = b.team === R.attTeam, C = R.charge;
  if (att && R.phase === 'live' && b.smokes > 0 && !b.usedSmoke) {
    const s = SITES[R.planSite], d = dist2(b.pos, s.center);
    if (d < 32 && d > 13) { botThrow(b, 'smoke', s.holdV[0].p); b.usedSmoke = true; }
  }
  if (!att && R.phase === 'planted' && b.smokes > 0) { const d = dist2(b.pos, C.pos); if (d < 20 && d > 6) botThrow(b, 'smoke', C.pos); }
  if (b.flashes > 0 && !b.targetVisible && b.lastKnown && now - b.lastSeen < 3 && now - b.lastSeen > 0.5) {
    const d = dist2(b.pos, b.lastKnown);
    if (d > 6 && d < 22 && Math.random() < 0.08) { botThrow(b, 'flash', b.lastKnown); b.stopUntil = now + 0.9; b.peekUntil = now + 1.2; }
  }
}
function startBotReload(b) { const W = WEAPONS[b.weapon]; if (b.reloading || b.res[W.id] <= 0) return; b.reloading = true; b.reloadEnd = now + W.reload; }
function botFire(b, W) {
  b.lastShot = now; b.lastShotSil = !!W.silenced; b.shotIdx++; b.mag[W.id]--;
  b.model.flash.visible = true; b.model.flash.material.rotation = rand(0, TAU); b.flashT = 0.05;
  eyeOf(b, _eye);
  const dist = _eye.distanceTo(b.aimPos), spd = Math.hypot(b.vel.x, b.vel.z);
  const err = (W.scope ? W.scopeErr * 4 : W.err) + W.runErr * smooth(2.0, 4.97, spd) + W.spray * Math.max(0, b.shotIdx - 3);
  const spread = dist * err + 0.07 + dist * 0.011;
  _tmp.copy(b.aimPos);
  if (Math.random() < (W.scope ? 0.2 : 0.12)) _tmp.y += 0.5;
  _tmp.y += W.up * Math.min(b.shotIdx, W.upShots) * dist * 0.5;
  _tmp.x += rand(-1, 1) * spread; _tmp.y += rand(-1, 1) * spread; _tmp.z += rand(-1, 1) * spread;
  const d = _tmp.sub(_eye).normalize().clone();
  netShot(b, W, _eye, d);
  const res = traceShot(_eye, d, 200, b, true, W.pen);
  const end = V3().copy(_eye).addScaledVector(d, res.t);
  const mz = V3(); b.model.muzzle.getWorldPosition(mz);
  if (!W.silenced || Math.random() < 0.3) tracer(mz, end);
  if (Math.random() < 0.3) puff(mz, 0.25, 1, d.clone().multiplyScalar(0.8), 0.7);
  for (const p of res.passed) impactFX(V3().copy(_eye).addScaledVector(d, p.t), d, p.s, p.axis, false);
  if (res.hit) { applyDamage(res.hit, dmgAt(W, res.t, res.part) * res.mul, b, res.part, d, W.id, res.passed.length > 0); burst(end, 'hit', 4, d.clone().negate()); }
  else if (res.prop) { res.prop.parent()?.applyImpulseAtPoint({ x: d.x * 4, y: d.y * 4 + 0.5, z: d.z * 4 }, end, true); burst(end, 'dust', 4, d.clone().negate()); }
  else if (res.t < 200) impactFX(end, d, res.surf, res.axis, res.ground);
  const { d: ld, pan } = panFor(b.pos);
  weaponSound(W, ld, pan, false);
}
function updateBot(b, dt) {
  if (!b.alive) return;
  const m = b.model, W = WEAPONS[b.weapon], C = R.charge;
  if (b.flashT > 0) { b.flashT -= dt; if (b.flashT <= 0) m.flash.visible = false; }
  if (b.reloading && now >= b.reloadEnd) {
    b.reloading = false; const take = Math.min(W.mag - b.mag[W.id], b.res[W.id]); b.mag[W.id] += take; b.res[W.id] -= take;
  }
  if (now >= b.thinkAt) { b.thinkAt = now + rand(0.1, 0.16); think(b); b.task = botTask(b); botUtility(b); }
  const task = b.task || { mode: 'idle' };
  if (b.target && b.target.alive) { chestOf(b.target, _tc); b.aimPos.lerp(_tc, 1 - Math.exp(-dt * (W.scope ? 3.5 : 5))); }
  const blind = now < b.blindUntil;
  const engaging = !!(b.target && b.targetVisible && !blind);
  const runSpeed = RUN_SPEED * (W.move || 1);
  let mx = 0, mz = 0, speed = 0;
  if (blind) {
    mx = -Math.sin(b.yaw); mz = -Math.cos(b.yaw); speed = walkable(b.pos.x + mx, b.pos.z + mz) ? 1.8 : 0;
  } else if (b.action) {
    speed = 0;
  } else if (engaging) {
    // peek-stop rhythm: strafe briefly, then stop dead and shoot (counter-strafe)
    if (now > b.peekUntil) { b.stopUntil = now + rand(0.45, 0.95); b.peekUntil = b.stopUntil + rand(0.18, 0.4); b.strafeDir = Math.random() < 0.5 ? -1 : 1; }
    if (now > b.stopUntil && task.mode !== 'hold' && task.mode !== 'defuse') {
      const dx = b.target.pos.x - b.pos.x, dz = b.target.pos.z - b.pos.z, d = Math.hypot(dx, dz) || 1;
      let sx = dz / d * b.strafeDir, sz = -dx / d * b.strafeDir;
      if (!walkable(b.pos.x + sx * 1.3, b.pos.z + sz * 1.3)) { sx = -sx; sz = -sz; b.strafeDir *= -1; }
      if (walkable(b.pos.x + sx * 1.3, b.pos.z + sz * 1.3)) { mx = sx; mz = sz; speed = runSpeed; }
    }
  } else if (b.lastKnown && now - b.lastSeen < 4 && task.mode === 'move' && !task.follow && C.carrier !== b && dist2(b.pos, b.lastKnown) < 25) {
    const pd = moveTo(b, b.lastKnown.x, b.lastKnown.z); if (pd) { mx = pd.x; mz = pd.z; speed = runSpeed; } else b.lastKnown = null;
  } else if (task.goal) {
    const pd = (task.follow && dist2(b.pos, task.goal) < 5) ? null : moveTo(b, task.goal.x, task.goal.z, task.mode === 'defuse' ? 0.5 : 0.7);
    if (pd) { mx = pd.x; mz = pd.z; speed = runSpeed; }
  }
  // objective actions
  if (task.mode === 'plant' && !engaging && now - b.lastSeen > 0.8 && C.carrier === b && siteAt(b.pos) === R.planSite && R.phase === 'live' && speed === 0) {
    if (b.action !== 'plant') { b.action = 'plant'; b.actionT = 0; plantStartSound(b.pos); }
    b.actionT += dt;
    if (b.actionT >= PLANT_TIME) { b.action = null; plantCharge(b); }
  } else if (task.mode === 'defuse' && !engaging && now - b.lastSeen > 0.6 && R.phase === 'planted' && dist2(b.pos, C.pos) < 1.6) {
    if (b.action !== 'defuse') { b.action = 'defuse'; defuseStartSound(C.pos); }
    C.defuseProg += dt; if (C.defuseProg >= DEFUSE_TIME / 2) C.defuseCk = true;
    b.actionT = C.defuseProg;
    if (C.defuseProg >= DEFUSE_TIME) { b.action = null; defuseCharge(b); }
  } else if (b.action) {
    if (b.action === 'defuse') C.defuseProg = C.defuseCk ? DEFUSE_TIME / 2 : 0;
    b.action = null; b.actionT = 0;
  }
  if (b.action) speed = 0;
  const tag = now - b.tagT; if (tag < 0.5) speed *= 0.45 + 0.55 * tag / 0.5;
  // movement physics (fast accel / fast stop)
  const k = Math.min(1, dt * (speed > 0 ? 12 : 18));
  b.vel.x += (mx * speed - b.vel.x) * k; b.vel.z += (mz * speed - b.vel.z) * k;
  b.pos.x += b.vel.x * dt; b.pos.z += b.vel.z * dt;
  resolveXZ(b.pos, 0.33);
  for (const o of combatants) {
    if (o === b || !o.alive) continue;
    const dx = b.pos.x - o.pos.x, dz = b.pos.z - o.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.75 && d > 0.001) { const push = (0.75 - d) * 0.5; b.pos.x += dx / d * push; b.pos.z += dz / d * push; }
  }
  b.pos.y = groundAt(b.pos.x, b.pos.z);
  if (R.phase === 'buy') b.pos.z = b.team === R.attTeam ? Math.min(b.pos.z, -47) : Math.max(b.pos.z, 47);
  if (now > b.stuckCheck) {
    if (speed > 0 && b.pos.distanceTo(b.stuckPos) < 0.5) { b.path = null; b.goalX = undefined; b.nextRepath = 0; b.pos.x += rand(-0.3, 0.3); b.pos.z += rand(-0.3, 0.3); resolveXZ(b.pos, 0.33); }
    b.stuckPos.copy(b.pos); b.stuckCheck = now + 1.5;
  }
  // facing
  let desired = b.yaw;
  if (b.target && (b.targetVisible || now - b.lastSeen < 1) && !blind) desired = Math.atan2(b.aimPos.x - b.pos.x, b.aimPos.z - b.pos.z);
  else if (b.alertedBy && b.alertedBy.alive) desired = Math.atan2(b.alertedBy.pos.x - b.pos.x, b.alertedBy.pos.z - b.pos.z);
  else if (b.action === 'defuse' || b.action === 'plant') desired = b.yaw;
  else if (speed > 0) desired = Math.atan2(mx, mz);
  else if (task.look) desired = Math.atan2(task.look.x - b.pos.x, task.look.z - b.pos.z);
  else if (b.lastKnown && now - b.lastSeen < 6) desired = Math.atan2(b.lastKnown.x - b.pos.x, b.lastKnown.z - b.pos.z);
  const turn = (b.target ? 8 : 5) * dt;
  b.yaw += clamp(angleDiff(b.yaw, desired), -turn, turn);
  let pitch = 0;
  if (b.target) { const hd = Math.hypot(b.aimPos.x - b.pos.x, b.aimPos.z - b.pos.z); pitch = Math.atan2(b.aimPos.y - (b.pos.y + 1.45), hd); }
  if (b.action) pitch = -0.7;
  b.aimPitch += (pitch - b.aimPitch) * Math.min(1, dt * 8);
  // shooting: only when (nearly) stopped, like a real player would
  if (engaging && now >= b.reactAt && b.target.alive && !b.action && !b.reloading && R.phase !== 'end') {
    const ye = Math.abs(angleDiff(b.yaw, Math.atan2(b.target.pos.x - b.pos.x, b.target.pos.z - b.pos.z)));
    const spd = Math.hypot(b.vel.x, b.vel.z);
    if (ye < 0.14 && (spd < 1.7 || W.id === 'smg') && now >= b.nextShot) {
      if (b.mag[W.id] <= 0) startBotReload(b);
      else if (b.burstLeft <= 0) {
        const d = dist2(b.pos, b.target.pos);
        b.burstLeft = !W.auto ? 1 : d > 28 ? 1 + ((Math.random() * 2) | 0) : 3 + ((Math.random() * 5) | 0);
        b.nextShot = now + rand(0.16, 0.36) + (W.bolt ? 0.45 : 0); b.shotIdx = 0;
      } else { botFire(b, W); b.burstLeft--; b.nextShot = now + (1 / W.rate) * rand(1, 1.12); }
    }
  }
  if (!engaging && !b.reloading && b.mag[W.id] < W.mag * 0.4 && now - b.lastSeen > 2) startBotReload(b);
  // animation + footsteps
  const hs = Math.hypot(b.vel.x, b.vel.z), prev = b.walkPhase;
  b.walkPhase += hs * dt * 2.4;
  if (Math.floor(prev / Math.PI) !== Math.floor(b.walkPhase / Math.PI) && hs > 3.6) {
    b.noiseT = now;
    const { d, pan } = panFor(b.pos); if (d < 20) stepSound(0.2 / (1 + d / 4), pan);
  }
  m.root.position.set(b.pos.x, b.pos.y, b.pos.z);
  m.root.rotation.set(0, b.yaw, 0);
  animateCharacter(m, b.walkPhase, Math.min(1, hs / 3), b.aimPitch);
}
function resolveXZ(p, r) {
  for (const s of statics) {
    const b = s.b; if (s.dead || b.max.y <= 0.45 + p.y || b.min.y >= p.y + 1.6) continue;
    if (p.x + r <= b.min.x || p.x - r >= b.max.x || p.z + r <= b.min.z || p.z - r >= b.max.z) continue;
    const ox1 = p.x + r - b.min.x, ox2 = b.max.x - (p.x - r), oz1 = p.z + r - b.min.z, oz2 = b.max.z - (p.z - r);
    const m = Math.min(ox1, ox2, oz1, oz2);
    if (m === ox1) p.x -= ox1; else if (m === ox2) p.x += ox2; else if (m === oz1) p.z -= oz1; else p.z += oz2;
  }
}

/* =====================================================================
   VIEWMODEL
   ===================================================================== */
const vmRoot = new THREE.Group(); weaponScene.add(vmRoot);
const GUNS = {};
let vflash, vflash2, vmMat;
function addArms(g, grip, fore) {
  const { sleeve, glove, skin } = vmMat, o = { cast: false };
  capsule(grip, V3(grip.x + 0.11, grip.y - 0.16, grip.z + 0.29), 0.042, sleeve, g);
  B(0.058, 0.07, 0.085, glove, grip.x, grip.y + 0.01, grip.z, g, { ...o, r: 0.02 });
  for (let i = 0; i < 3; i++) capsule(V3(grip.x - 0.026, grip.y + 0.03 - i * 0.022, grip.z - 0.025), V3(grip.x - 0.032, grip.y + 0.02 - i * 0.022, grip.z - 0.06), 0.009, skin, g);
  if (fore) {
    const el = V3(fore.x - 0.16, fore.y - 0.165, fore.z + 0.3);
    capsule(fore, el, 0.038, sleeve, g); capsule(el, V3(fore.x - 0.23, fore.y - 0.305, fore.z + 0.63), 0.046, sleeve, g);
    B(0.075, 0.058, 0.09, glove, fore.x, fore.y, fore.z, g, { ...o, r: 0.02 });
    for (let i = 0; i < 4; i++) capsule(V3(fore.x - 0.02, fore.y + 0.023, fore.z - 0.03 + i * 0.022), V3(fore.x + 0.04, fore.y + 0.05, fore.z - 0.03 + i * 0.022), 0.008, skin, g);
  }
}
function gunEntry(g, muzzle, port, mag, hip, ads, extra = {}) {
  g.traverse(m => { if (m.isMesh) m.castShadow = false; });
  g.visible = false; vmRoot.add(g);
  const mz = new THREE.Object3D(); mz.position.copy(muzzle); g.add(mz);
  const pt = new THREE.Object3D(); pt.position.copy(port || muzzle); g.add(pt);
  return { g, muzzle: mz, port: port ? pt : null, mag, hip, ads, magY: mag ? mag.position.y : 0, ...extra };
}
function buildViewmodels() {
  vmMat = {
    gm: new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.32, metalness: 0.8 }),
    gm2: new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.6, metalness: 0.3 }),
    tan: texMat(TX.paint, 0x8a7a5a, { roughness: 0.75, metalness: 0.1 }, 0.3),
    olive: texMat(TX.paint, 0x4c5238, { roughness: 0.75, metalness: 0.1 }, 0.3),
    wood: M('#5a3a22', { roughness: 0.6 }),
    blade: M('#c9ccd0', { roughness: 0.2, metalness: 1 }),
    sleeve: fab('#1d1d20'), glove: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.75 }), skin: new THREE.MeshStandardMaterial({ color: 0xe5bfaa, roughness: 0.55 }),
  };
  const { gm, gm2, tan, olive, wood, blade } = vmMat, o = { cast: false };
  // --- KR-9 and AR-7 (shared rifle body, red-dot sight)
  for (const id of ['rifle', 'ar']) {
    const g = new THREE.Group(), sup = id === 'ar';
    B(0.058, 0.082, 0.3, gm, 0, 0, -0.08, g, { ...o, r: 0.01 });
    B(0.068, 0.072, 0.26, sup ? olive : tan, 0, 0.002, -0.36, g, { ...o, r: 0.014 });
    for (let i = 0; i < 6; i++) B(0.07, 0.01, 0.018, gm2, 0, 0.0, -0.26 - i * 0.04, g, { ...o, r: 0.003 });
    B(0.032, 0.012, 0.5, gm2, 0, 0.049, -0.22, g, o);
    for (let i = 0; i < 18; i++) B(0.036, 0.006, 0.008, gm, 0, 0.056, -0.02 - i * 0.026, g, o);
    cyl(0.012, 0.012, 0.13, gm, 0, 0.005, -0.555, g, 10).rotation.x = Math.PI / 2;
    if (sup) cyl(0.024, 0.024, 0.24, gm2, 0, 0.005, -0.72, g, 16).rotation.x = Math.PI / 2;
    else cyl(0.019, 0.019, 0.07, gm2, 0, 0.005, -0.645, g, 10).rotation.x = Math.PI / 2;
    const mag = new THREE.Group(); mag.position.set(0, -0.04, -0.14); g.add(mag);
    B(0.04, 0.17, 0.075, gm2, 0, -0.08, 0, mag, { ...o, r: 0.008 }).rotation.x = sup ? 0.12 : 0.22;
    B(0.036, 0.1, 0.05, gm2, 0, -0.085, 0.03, g, { ...o, r: 0.01 }).rotation.x = -0.35;
    B(0.045, 0.075, 0.2, gm2, 0, -0.012, 0.17, g, { ...o, r: 0.015 });
    B(0.03, 0.02, 0.07, gm, 0, 0.064, -0.06, g, { ...o, r: 0.005 });
    for (const s of [-1, 1]) B(0.006, 0.05, 0.05, gm2, s * 0.025, 0.096, -0.06, g, o);
    B(0.056, 0.008, 0.05, gm2, 0, 0.123, -0.06, g, o);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0022, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.4, 0.2), toneMapped: false }));
    dot.position.set(0, 0.096, -0.075); g.add(dot);
    addArms(g, V3(0, -0.08, 0.03), V3(-0.01, -0.035, -0.38));
    GUNS[id] = gunEntry(g, V3(0, 0.005, sup ? -0.85 : -0.68), V3(0.035, 0.015, -0.05), mag, V3(0.16, -0.165, -0.3), V3(0, -0.096, -0.2));
  }
  { // WASP SMG (iron sights)
    const g = new THREE.Group();
    B(0.05, 0.075, 0.26, gm, 0, 0, -0.07, g, { ...o, r: 0.01 });
    B(0.056, 0.06, 0.12, gm2, 0, -0.002, -0.26, g, { ...o, r: 0.012 });
    cyl(0.011, 0.011, 0.09, gm, 0, 0.005, -0.365, g, 10).rotation.x = Math.PI / 2;
    B(0.03, 0.01, 0.3, gm2, 0, 0.043, -0.12, g, o);
    for (const s of [-1, 1]) B(0.006, 0.026, 0.01, gm2, s * 0.011, 0.06, 0.02, g, o);
    B(0.004, 0.022, 0.006, gm2, 0, 0.058, -0.3, g, o);
    const mag = new THREE.Group(); mag.position.set(0, -0.04, -0.12); g.add(mag);
    B(0.03, 0.15, 0.045, gm2, 0, -0.075, 0, mag, { ...o, r: 0.006 }).rotation.x = 0.08;
    B(0.034, 0.09, 0.045, gm2, 0, -0.08, 0.03, g, { ...o, r: 0.01 }).rotation.x = -0.3;
    for (const s of [-1, 1]) B(0.01, 0.01, 0.18, gm, s * 0.018, -0.005, 0.15, g, o);
    B(0.045, 0.07, 0.014, gm2, 0, -0.02, 0.24, g, { ...o, r: 0.005 });
    addArms(g, V3(0, -0.08, 0.03), V3(-0.005, -0.035, -0.27));
    GUNS.smg = gunEntry(g, V3(0, 0.005, -0.42), V3(0.03, 0.012, -0.03), mag, V3(0.15, -0.155, -0.28), V3(0, -0.066, -0.2));
  }
  { // P-12 pistol
    const g = new THREE.Group();
    B(0.03, 0.034, 0.19, gm, 0, 0.03, -0.08, g, { ...o, r: 0.006 });
    B(0.028, 0.02, 0.15, gm2, 0, 0.005, -0.07, g, o);
    B(0.03, 0.1, 0.045, gm2, 0, -0.045, 0.0, g, { ...o, r: 0.008 }).rotation.x = -0.25;
    B(0.008, 0.02, 0.04, gm2, 0, -0.012, -0.04, g, o);
    B(0.02, 0.008, 0.008, gm2, 0, 0.05, 0.005, g, o); B(0.004, 0.008, 0.006, gm2, 0, 0.05, -0.165, g, o);
    const mag = new THREE.Group(); mag.position.set(0, -0.05, 0.005); g.add(mag);
    B(0.024, 0.06, 0.035, gm2, 0, -0.04, 0, mag, o);
    addArms(g, V3(0, -0.045, 0.01), V3(-0.022, -0.06, 0.0));
    GUNS.pistol = gunEntry(g, V3(0, 0.03, -0.185), V3(0.016, 0.035, -0.04), mag, V3(0.13, -0.13, -0.3), null);
  }
  { // VX-6 revolver
    const g = new THREE.Group();
    B(0.03, 0.05, 0.09, gm, 0, 0.02, -0.04, g, { ...o, r: 0.008 });
    cyl(0.025, 0.025, 0.05, gm, 0, 0.022, -0.045, g, 8).rotation.x = Math.PI / 2;
    B(0.02, 0.024, 0.17, gm, 0, 0.032, -0.17, g, { ...o, r: 0.005 });
    B(0.006, 0.006, 0.17, gm2, 0, 0.047, -0.17, g, o);
    B(0.032, 0.1, 0.048, wood, 0, -0.04, 0.02, g, { ...o, r: 0.012 }).rotation.x = -0.3;
    B(0.008, 0.02, 0.012, gm2, 0, 0.05, 0.015, g, o);
    addArms(g, V3(0, -0.045, 0.02), V3(-0.022, -0.06, 0.01));
    GUNS.magnum = gunEntry(g, V3(0, 0.032, -0.26), null, null, V3(0.13, -0.13, -0.3), null);
  }
  { // LONGBOW sniper
    const g = new THREE.Group();
    B(0.06, 0.08, 0.42, gm2, 0, 0, -0.06, g, { ...o, r: 0.012 });
    B(0.065, 0.06, 0.25, olive, 0, -0.01, -0.38, g, { ...o, r: 0.015 });
    cyl(0.013, 0.015, 0.46, gm, 0, 0.005, -0.66, g, 10).rotation.x = Math.PI / 2;
    cyl(0.021, 0.021, 0.06, gm2, 0, 0.005, -0.9, g, 10).rotation.x = Math.PI / 2;
    cyl(0.021, 0.021, 0.3, gm, 0, 0.088, -0.1, g, 16).rotation.x = Math.PI / 2;
    for (const z of [-0.27, 0.07]) cyl(0.029, 0.029, 0.06, gm, 0, 0.088, z, g, 16).rotation.x = Math.PI / 2;
    for (const z of [-0.17, -0.02]) B(0.022, 0.035, 0.022, gm2, 0, 0.055, z, g, o);
    cyl(0.006, 0.006, 0.07, gm, 0.045, 0.02, 0.06, g, 6).rotation.z = Math.PI / 2;
    E(0.012, 0.012, 0.012, gm2, 0.082, 0.02, 0.06, g, false);
    B(0.05, 0.1, 0.26, olive, 0, -0.02, 0.25, g, { ...o, r: 0.02 });
    const mag = new THREE.Group(); mag.position.set(0, -0.045, -0.04); g.add(mag);
    B(0.04, 0.07, 0.09, gm2, 0, -0.03, 0, mag, { ...o, r: 0.006 });
    B(0.036, 0.1, 0.05, gm2, 0, -0.09, 0.07, g, { ...o, r: 0.01 }).rotation.x = -0.3;
    addArms(g, V3(0, -0.085, 0.07), V3(-0.01, -0.045, -0.4));
    GUNS.sniper = gunEntry(g, V3(0, 0.005, -0.94), V3(0.035, 0.02, -0.02), mag, V3(0.17, -0.17, -0.33), null, { scope: true });
  }
  { // knife
    const g = new THREE.Group(), k = new THREE.Group(); g.add(k);
    B(0.026, 0.032, 0.11, '#151515', 0, 0, 0.03, k, { ...o, r: 0.01 });
    B(0.03, 0.052, 0.008, vmMat.gm, 0, 0.004, -0.028, k, o);
    B(0.005, 0.032, 0.17, blade, 0, 0.006, -0.12, k, o);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.05, 4), blade); tip.rotation.x = -Math.PI / 2; tip.scale.set(0.3, 1, 1); tip.position.set(0, 0.006, -0.225); k.add(tip);
    k.rotation.set(-0.25, 0.35, 0.2);
    addArms(g, V3(0, -0.01, 0.03), null);
    GUNS.knife = gunEntry(g, V3(0, 0, -0.2), null, null, V3(0.14, -0.15, -0.3), null, { knife: k });
  }
  if (MODELS.vss) { GUNS.sniper.g.removeFromParent(); GUNS.sniper = vssViewmodel(); }
  vflash = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), new THREE.MeshBasicMaterial({ map: TX.flash, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, color: new THREE.Color(2.5, 2.2, 1.8) }));
  vflash.visible = false; vflash2 = vflash.clone(); vflash2.rotation.y = Math.PI / 2; vflash2.scale.set(1.6, 0.6, 1);
}
let vmShown = null;
function showGun(id) {
  if (vmShown === id) return;
  for (const k in GUNS) GUNS[k].g.visible = k === id;
  const G = GUNS[id]; G.muzzle.add(vflash, vflash2); vmShown = id;
}
const VMS = { swayX: 0, swayY: 0, kick: 0, kickRot: 0, flashT: 0, camKick: 0 };
const _vp = V3();
function updateViewmodel(dt, hspeed) {
  const p = player, W = WEAPONS[p.weapon], G = GUNS[p.weapon];
  showGun(p.weapon);
  const scoped = W.scope && p.adsT > 0.9;
  vmRoot.visible = !scoped;
  const a = G.ads ? p.adsT : 0;
  _vp.copy(G.hip); if (G.ads) _vp.lerp(G.ads, a);
  const bobAmt = Math.min(1, hspeed / 5) * (p.onGround ? 1 : 0.2) * (1 - a * 0.85);
  const bx = Math.sin(p.walkPhase) * 0.01 * bobAmt, by = -Math.abs(Math.cos(p.walkPhase)) * 0.01 * bobAmt;
  VMS.swayX *= Math.exp(-dt * 8); VMS.swayY *= Math.exp(-dt * 8);
  VMS.kick *= Math.exp(-dt * 16); VMS.kickRot *= Math.exp(-dt * 13);
  const sm = 1 - a * 0.75;
  const eq = clamp((p.equipEnd - now) / Math.max(0.2, (W.equip || 0.5) * 0.7), 0, 1);
  const act = p.action ? 1 : 0;
  vmRoot.position.set(_vp.x + bx + VMS.swayX * sm, _vp.y + by + VMS.swayY * sm - p.landKick * 0.4 - eq * 0.25 - act * 0.22, _vp.z + VMS.kick);
  vmRoot.rotation.set(VMS.kickRot + eq * 0.7 + act * 0.5, VMS.swayX * 2, 0);
  if (p.reloading && G.mag) {
    const r = 1 - (p.reloadEnd - now) / W.reload, k = Math.sin(clamp(r, 0, 1) * Math.PI);
    vmRoot.rotation.x += k * 0.25; vmRoot.rotation.z += k * 0.55; vmRoot.position.y -= k * 0.05;
    G.mag.position.y = G.magY - Math.sin(clamp((r - 0.18) / 0.45, 0, 1) * Math.PI) * 0.22;
  } else if (p.reloading) { const r = 1 - (p.reloadEnd - now) / W.reload; vmRoot.rotation.z += Math.sin(clamp(r, 0, 1) * Math.PI) * 0.9; }
  else if (G.mag) G.mag.position.y = G.magY;
  if (G.knife && p.knifeAnim) {
    const dur = p.knifeAnim.heavy ? 0.6 : 0.32, k = (now - p.knifeAnim.t) / dur;
    if (k >= 1) p.knifeAnim = null;
    else { const s = Math.sin(k * Math.PI); if (p.knifeAnim.heavy) { vmRoot.position.z -= s * 0.18; vmRoot.rotation.x -= s * 0.4; } else { vmRoot.rotation.y += s * 0.9; vmRoot.position.x -= s * 0.12; vmRoot.rotation.z -= s * 0.5; } }
  }
  if (VMS.flashT > 0) { VMS.flashT -= dt; if (VMS.flashT <= 0) { vflash.visible = vflash2.visible = false; muzzleLight.intensity = 0; } }
}

/* =====================================================================
   PLAYER
   ===================================================================== */
const keys = {};
let jumpQueued = false, locked = false, sens = 1;
try { const s = parseFloat(localStorage.getItem('tollgate-sens')); if (s) sens = s; } catch (e) {}
$('sens').value = sens; $('sensv').textContent = sens.toFixed(2);
$('sens').addEventListener('input', e => { sens = parseFloat(e.target.value); $('sensv').textContent = sens.toFixed(2); try { localStorage.setItem('tollgate-sens', sens); } catch (er) {} });
const PR = 0.33;
function playerHits(x, y, z, h) {
  for (const s of statics) { if (s.dead) continue; const b = s.b; if (x + PR > b.min.x && x - PR < b.max.x && z + PR > b.min.z && z - PR < b.max.z && y + h > b.min.y && y < b.max.y) return true; }
  return false;
}
function movePlayerAxis(axis, delta) {
  const p = player.pos, h = player.height;
  p[axis] += delta;
  for (const s of statics) {
    if (s.dead) continue;
    const b = s.b;
    if (p.x + PR <= b.min.x || p.x - PR >= b.max.x || p.z + PR <= b.min.z || p.z - PR >= b.max.z || p.y + h <= b.min.y || p.y >= b.max.y) continue;
    if (axis === 'y') {
      if (delta <= 0) { p.y = b.max.y; player.vel.y = 0; player.onGround = true; }
      else { p.y = b.min.y - h - 0.001; player.vel.y = 0; }
    } else {
      const step = b.max.y - p.y;
      if (step > 0 && step <= 0.46 && player.onGround && !playerHits(p.x, b.max.y + 0.01, p.z, h)) { p.y = b.max.y + 0.001; continue; }
      p[axis] = delta > 0 ? b.min[axis] - PR - 0.001 : b.max[axis] + PR + 0.001;
      if (axis === 'x') player.vel.x *= 0.2; else player.vel.z *= 0.2;
    }
  }
}
function selectBest() { switchWeapon(player.loadout.primary ? 'primary' : 'side', true); }
function switchWeapon(slot, force) {
  const p = player;
  const id = slot === 'primary' ? p.loadout.primary : slot === 'side' ? p.loadout.side : 'knife';
  if (!id || (id === p.weapon && !force)) return;
  p.weapon = id; p.reloading = false; p.ads = false; p.adsT = 0; p.shotIdx = 0; p.recP = 0; p.recY = 0;
  p.equipEnd = now + (WEAPONS[id].equip || 0.5) * 0.7;
  click(0.02, 1200, 0.15);
}
function startReload() {
  const p = player, W = WEAPONS[p.weapon];
  if (!p.alive || W.melee || p.reloading || p.mag[W.id] >= W.mag || p.res[W.id] <= 0 || state !== 'playing') return;
  p.reloading = true; p.reloadEnd = now + W.reload; p.ads = false;
  click(W.reload * 0.15, 1800, 0.25); click(W.reload * 0.5, 1400, 0.3); click(W.reload * 0.85, 2600, 0.3);
}
function curErr(p, W) {
  const spd = Math.hypot(p.vel.x, p.vel.z);
  let err = W.scope ? (p.adsT > 0.9 ? W.scopeErr : W.err) : W.err;
  err += W.runErr * smooth(2.0, RUN_SPEED * 0.92, spd);
  if (!p.onGround) err += W.airErr;
  if (now - p.lastFireT < 1 / W.rate * 1.6) err += W.spray * Math.max(0, p.shotIdx - 3);
  if (p.crouch) err *= 0.85;
  if (W.ads && p.adsT > 0.5) err *= 0.75;
  return err;
}
const _f = V3(), _r = V3(), _u = V3(), _o = V3(), _mzw = V3();
function playerFire(W, interval) {
  const p = player;
  p.mag[W.id]--; p.nextFire = now + interval; p.lastShot = now; p.lastShotSil = !!W.silenced;
  if (now - p.lastFireT > W.recover * 0.8) p.shotIdx = 0;
  const err = curErr(p, W);
  p.shotIdx++; p.lastFireT = now;
  // bullets leave along view + recoil offset (crosshair only shows part of it, so you pull down)
  const bp = p.pitch + p.recP, byw = p.yaw + p.recY;
  _f.set(-Math.sin(byw) * Math.cos(bp), Math.sin(bp), -Math.cos(byw) * Math.cos(bp));
  _r.set(Math.cos(byw), 0, -Math.sin(byw)); _u.crossVectors(_r, _f).normalize();
  const a = rand(0, TAU), rr = Math.sqrt(Math.random()) * err;
  const d = _f.clone().addScaledVector(_r, Math.cos(a) * rr).addScaledVector(_u, Math.sin(a) * rr).normalize();
  camera.updateMatrixWorld(); camera.getWorldPosition(_o);
  netShot(p, W, _o, d);
  const res = traceShot(_o, d, 250, p, true, W.pen);
  const end = V3().copy(_o).addScaledVector(d, res.t);
  const G = GUNS[W.id];
  G.g.updateMatrixWorld(true); G.muzzle.getWorldPosition(_mzw); _mzw.applyMatrix4(camera.matrixWorld);
  if (!W.silenced ? Math.random() < 0.6 : Math.random() < 0.2) tracer(_mzw, end);
  if (Math.random() < 0.35) puff(_mzw, 0.18, 1, d.clone().multiplyScalar(0.6), 0.5);
  for (const ps of res.passed) impactFX(V3().copy(_o).addScaledVector(d, ps.t), d, ps.s, ps.axis, false);
  if (res.hit) {
    const dmg = dmgAt(W, res.t, res.part) * res.mul;
    const willKill = res.hit.hp + res.hit.armor * 0.66 - dmg <= 0;
    applyDamage(res.hit, dmg, p, res.part, d, W.id, res.passed.length > 0);
    if (!willKill) { hitmarker(res.head ? 'head' : null); blip(res.head ? 2900 : 2100, 0.05, 'square', 0.09); if (res.head) blip(4200, 0.08, 'sine', 0.06, 0.02); }
    burst(end, 'hit', 5, d.clone().negate());
  } else if (res.prop) {
    const body = res.prop.parent(); if (body) body.applyImpulseAtPoint({ x: d.x * 6, y: d.y * 6 + 0.6, z: d.z * 6 }, end, true);
    burst(end, 'dust', 4, d.clone().negate()); puff(end, 0.3, 1, null, 0.8);
  } else if (res.t < 250) impactFX(end, d, res.surf, res.axis, res.ground);
  if (G.port) {
    _r.set(1, 0, 0).applyQuaternion(camera.quaternion); _u.set(0, 1, 0).applyQuaternion(camera.quaternion); const fw = V3(0, 0, -1).applyQuaternion(camera.quaternion);
    G.port.getWorldPosition(_mzw); _mzw.applyMatrix4(camera.matrixWorld);
    ejectCasing(_mzw, _r, _u, fw, p.vel);
  }
  // recoil pattern: straight climb, then random horizontal sway
  const rm = p.crouch ? 0.85 : 1;
  if (p.shotIdx <= W.upShots) p.recP += W.up * rm * rand(0.9, 1.1);
  else {
    if (Math.random() < 0.18) p.swayDir *= -1;
    p.recY = clamp(p.recY + p.swayDir * W.sway * rand(0.4, 1), -W.sway * 3, W.sway * 3);
    p.recP += W.up * 0.12 * rand(-1, 1);
  }
  VMS.kick += W.scope ? 0.08 : 0.025; VMS.kickRot += (W.scope ? 0.12 : 0.04) * rm; VMS.camKick += W.scope ? 0.02 : 0.004;
  if (!W.silenced) { vflash.visible = vflash2.visible = true; vflash.rotation.z = rand(0, TAU); VMS.flashT = 0.035; muzzleLight.intensity = 30; }
  weaponSound(W, 0, 0, true);
  if (W.bolt) click(0.55, 900, 0.25), click(0.75, 1600, 0.25);
}
function knifeAttack(heavy) {
  const p = player;
  p.knifeT = now + (heavy ? 1.0 : 0.5); p.knifeAnim = { t: now, heavy };
  noiseHit(0.18, 'bandpass', heavy ? 1200 : 1800, 0.18, 0, 1, 0, heavy ? 500 : 900);
  camera.getWorldPosition(_o); _f.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const range = heavy ? 1.8 : 2.1;
  let best = null, bd = 1e9;
  for (const c of combatants) {
    if (!c.alive || c.team === p.team) continue;
    chestOf(c, _tc); const v = V3().subVectors(_tc, _o), d = v.length();
    if (d > range + 0.35) continue;
    v.normalize(); if (v.dot(_f) < 0.82) continue;
    if (!losClear(_o, _tc)) continue;
    if (d < bd) { bd = d; best = c; }
  }
  if (!best) return;
  const back = (Math.sin(best.yaw) * _f.x + Math.cos(best.yaw) * _f.z) > 0.5;
  const dmg = (heavy ? 75 : 50) * (back ? 2 : 1);
  applyDamage(best, dmg, p, 'body', _f.clone(), 'knife', false);
  hitmarker(best.alive ? null : 'kill'); noiseHit(0.3, 'lowpass', 700, 0.12, 0, 1);
  if (back && heavy) popup('BACKSTAB');
}
function playerThrow(type) {
  const p = player;
  if (!p.alive || R.phase === 'buy' || R.phase === 'end' || p.action) return;
  if (type === 'smoke' ? p.smokes <= 0 : p.flashes <= 0) return;
  if (type === 'smoke') p.smokes--; else p.flashes--;
  camera.getWorldPosition(_o); _f.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _f.y += 0.12; _f.normalize();
  throwUtil(p, type, _o.clone().addScaledVector(_f, 0.4), _f.clone(), 15);
}
function updatePlayerAction(dt) {
  const p = player, C = R.charge;
  let want = null;
  if (keys.KeyF && p.onGround && !buyOpen) {
    if (R.phase === 'live' && C.carrier === p && siteAt(p.pos) >= 0) want = 'plant';
    else if (R.phase === 'planted' && p.team !== R.attTeam && dist2(p.pos, C.pos) < 1.6) want = 'defuse';
  }
  if (want !== p.action) {
    if (p.action === 'defuse') C.defuseProg = C.defuseCk ? DEFUSE_TIME / 2 : 0;
    p.action = want; p.actionT = 0;
    if (want === 'plant') plantStartSound(p.pos);
    if (want === 'defuse') defuseStartSound(C.pos);
  }
  // a multiplayer client asks the host to plant/defuse (it confirms with a 'plant'/'defuse' event)
  const ask = t => { if (now - (p.askT || -9) > 0.5) { p.askT = now; netSend({ t, p: arr(p.pos) }); } };
  if (p.action === 'plant') { p.actionT += dt; if (p.actionT >= PLANT_TIME) { p.action = null; if (NET.mode === 'client') ask('plant'); else plantCharge(p); } }
  else if (p.action === 'defuse') { C.defuseProg += dt; if (C.defuseProg >= DEFUSE_TIME / 2) C.defuseCk = true; if (C.defuseProg >= DEFUSE_TIME) { p.action = null; if (NET.mode === 'client') ask('defuse'); else defuseCharge(p); } }
}
const _hp = V3();
function deathCamera(dt) {
  const p = player;
  p.deathT += dt;
  if (p.deathT < 2.6 && p.ragdoll) {
    p.ragdoll.parts.head.g.getWorldPosition(_hp);
    const k = p.killer, target = V3(_hp.x, Math.max(_hp.y, 0.25) + 0.9, _hp.z);
    if (k) target.addScaledVector(V3(_hp.x - k.pos.x, 0, _hp.z - k.pos.z).normalize(), 1.4);
    camera.position.lerp(target, Math.min(1, dt * 4));
    if (k && k.alive) {
      headOf(k, _tc);
      const dx = _tc.x - camera.position.x, dz = _tc.z - camera.position.z, dy = _tc.y - camera.position.y;
      p.yaw += angleDiff(p.yaw, Math.atan2(-dx, -dz)) * Math.min(1, dt * 3); p.pitch += (Math.atan2(dy, Math.hypot(dx, dz)) - p.pitch) * Math.min(1, dt * 3);
    }
    camera.rotation.set(p.pitch, p.yaw, camera.rotation.z + (0.12 - camera.rotation.z) * Math.min(1, dt * 4));
    hud.spectate.classList.add('hidden');
    return;
  }
  hud.death.classList.add('hidden');
  const mate = combatants.find(c => c.team === p.team && c.alive && !c.isPlayer);
  if (mate) {
    headOf(mate, _tc);
    const fw = V3(Math.sin(mate.yaw), 0, Math.cos(mate.yaw));
    const want = V3().copy(_tc).addScaledVector(fw, -2.3).add(V3(0, 0.55, 0));
    camera.position.lerp(want, Math.min(1, dt * 6));
    camera.lookAt(_tc.x + fw.x * 6, _tc.y - 0.1, _tc.z + fw.z * 6);
    hud.spectate.textContent = 'SPECTATING ' + mate.name; hud.spectate.classList.remove('hidden');
  } else {
    const c = R.charge.state === 'planted' ? R.charge.pos : V3(0, 0, 0);
    camera.position.lerp(V3(c.x + 14, 22, c.z - 18), Math.min(1, dt * 2)); camera.lookAt(c.x, 0, c.z);
    hud.spectate.textContent = 'TEAM ELIMINATED'; hud.spectate.classList.remove('hidden');
  }
}
function updatePlayer(dt) {
  const p = player;
  if (!p.alive) { deathCamera(dt); return; }
  hud.spectate.classList.add('hidden');
  const W = WEAPONS[p.weapon];
  let ix = buyOpen ? 0 : (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), iz = buyOpen ? 0 : (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  let walking = keys.ShiftLeft || keys.ShiftRight;
  if (TOUCH && !buyOpen) { const mg = Math.hypot(touchMove.x, touchMove.y); if (mg > 0.12) { ix = touchMove.x; iz = touchMove.y; walking = mg < 0.62; } }
  if (keys.KeyC && !buyOpen) p.crouch = true; else if (p.crouch && !playerHits(p.pos.x, p.pos.y, p.pos.z, 1.75)) p.crouch = false;
  p.height = p.crouch ? 1.15 : 1.75;
  updatePlayerAction(dt);
  let speed = RUN_SPEED * (W.move || 1);
  if (walking) speed *= WALK_MUL;
  if (p.crouch) speed *= CROUCH_MUL;
  if (p.adsT > 0.5 && (W.ads || W.scope)) speed *= 0.76;
  const tag = now - p.tagT; if (tag < 0.5) speed *= 0.45 + 0.55 * tag / 0.5;
  if (p.action) speed = 0;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
  let wx = fx * iz + rx * ix, wz = fz * iz + rz * ix;
  const wl = Math.hypot(wx, wz); if (wl > 0) { wx = wx / wl * speed; wz = wz / wl * speed; }
  if (p.onGround) { const k = Math.min(1, dt * (wl > 0 && speed > 0 ? 13 : 20)); p.vel.x += (wx - p.vel.x) * k; p.vel.z += (wz - p.vel.z) * k; }
  else { const k = Math.min(1, dt * 2); p.vel.x += (wx - p.vel.x) * k * 0.6; p.vel.z += (wz - p.vel.z) * k * 0.6; }
  if (jumpQueued && p.onGround && !p.action && !p.crouch) { p.vel.y = 6.6; p.onGround = false; p.noiseT = now; }
  jumpQueued = false;
  const vyBefore = p.vel.y, wasGround = p.onGround;
  p.vel.y -= 20 * dt;
  movePlayerAxis('x', p.vel.x * dt);
  movePlayerAxis('z', p.vel.z * dt);
  p.onGround = false;
  movePlayerAxis('y', p.vel.y * dt);
  if (p.pos.y <= 0) { p.pos.y = 0; p.vel.y = 0; p.onGround = true; }
  if (R.phase === 'buy') p.pos.z = p.team === R.attTeam ? Math.min(p.pos.z, -47) : Math.max(p.pos.z, 47);
  if (!wasGround && p.onGround && vyBefore < -4) { p.landKick = Math.min(0.1, -vyBefore * 0.01); stepSound(0.35); p.noiseT = now; }
  p.landKick *= Math.exp(-dt * 8);
  p.kin.setNextKinematicTranslation({ x: p.pos.x, y: p.pos.y + 0.85, z: p.pos.z });
  // weapon handling
  if (p.reloading && now >= p.reloadEnd) { p.reloading = false; const take = Math.min(W.mag - p.mag[W.id], p.res[W.id]); p.mag[W.id] += take; p.res[W.id] -= take; }
  const ready = now >= p.equipEnd && !p.action && !buyOpen;
  const queued = now - p.fireQueuedAt < 0.15;
  if (W.melee) {
    if (ready && now >= p.knifeT && (p.firing || queued || p.ads)) { knifeAttack(p.ads && !p.firing); p.fireQueuedAt = -99; }
  } else {
    p.adsT += (((p.ads && (W.ads || W.scope) && !p.reloading && ready) ? 1 : 0) - p.adsT) * Math.min(1, dt * (W.scope ? 9 : 14));
    const interval = 1 / (W.rate * (W.ads && p.adsT > 0.5 ? 0.9 : 1));
    const want = W.auto ? p.firing : queued;
    if (want && ready && !p.reloading && now >= p.nextFire) {
      if (p.mag[W.id] > 0) { playerFire(W, interval); p.fireQueuedAt = -99; }
      else { startReload(); p.fireQueuedAt = -99; if (p.res[W.id] <= 0) click(0, 3000, 0.15); }
    }
    if (now - p.lastFireT > interval * 1.4) { const k = Math.exp(-dt * 3.2 / W.recover); p.recP *= k; p.recY *= k; }
  }
  // camera + footsteps
  const hs = Math.hypot(p.vel.x, p.vel.z), prevPhase = p.walkPhase;
  p.walkPhase += hs * dt * 2.1;
  if (p.onGround && hs > 1.2 && Math.floor(prevPhase / Math.PI) !== Math.floor(p.walkPhase / Math.PI)) {
    if (hs > 3.6) { stepSound(0.16); p.noiseT = now; } else stepSound(0.03);
  }
  p.eye += ((p.crouch ? 1.05 : 1.62) - p.eye) * Math.min(1, dt * 12);
  VMS.camKick *= Math.exp(-dt * 12);
  p.roll += ((-ix * 0.008) - p.roll) * Math.min(1, dt * 8);
  const bob = p.onGround ? Math.abs(Math.sin(p.walkPhase)) * 0.025 * Math.min(1, hs / 5) * (1 - p.adsT * 0.7) : 0;
  p.shake *= Math.exp(-dt * 4);
  camera.position.set(p.pos.x + rand(-1, 1) * p.shake * 0.08, p.pos.y + p.eye + bob - p.landKick + rand(-1, 1) * p.shake * 0.08, p.pos.z);
  camera.rotation.set(p.pitch + p.recP * 0.3 + VMS.camKick, p.yaw + p.recY * 0.3, p.roll);
  const zoom = W.scope ? 1 + p.adsT * 1.5 : W.ads ? 1 + p.adsT * 0.15 : 1;
  const fov = 75 / zoom;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  updateViewmodel(dt, hs);
}

/* =====================================================================
   INPUT
   ===================================================================== */
addEventListener('keydown', e => {
  if (e.code === 'Tab') { e.preventDefault(); if (state === 'playing') { renderBoard($('scoreboard')); $('scoreboard').classList.remove('hidden'); } }
  keys[e.code] = true;
  if (state !== 'playing' || paused) return;
  if (e.code === 'KeyB' && !e.repeat) { if (buyOpen) closeBuy(true); else openBuy(); return; }
  if (e.code === 'Escape' && buyOpen) { closeBuy(false); return; }
  if (buyOpen) return;
  if (e.code === 'KeyR') startReload();
  if (e.code === 'Space') { jumpQueued = true; e.preventDefault(); }
  if (e.code === 'Digit1') switchWeapon('primary');
  if (e.code === 'Digit2') switchWeapon('side');
  if (e.code === 'Digit3') switchWeapon('knife');
  if (e.code === 'KeyQ' && !e.repeat) playerThrow('smoke');
  if (e.code === 'KeyE' && !e.repeat) playerThrow('flash');
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'Tab') $('scoreboard').classList.add('hidden'); });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; player.firing = false; player.ads = false; });
addEventListener('mousedown', e => {
  if (!locked || state !== 'playing' || !player.alive || buyOpen) return;
  if (e.button === 0) { player.firing = true; player.fireQueuedAt = now; }
  if (e.button === 2) player.ads = true;
});
addEventListener('mouseup', e => { if (e.button === 0) player.firing = false; if (e.button === 2) player.ads = false; });
function cycleWeapon(dir) {
  const order = ['primary', 'side', 'knife'].filter(k => k === 'knife' || (k === 'primary' ? player.loadout.primary : player.loadout.side));
  const cur = order.findIndex(k => (k === 'primary' ? player.loadout.primary : k === 'side' ? player.loadout.side : 'knife') === player.weapon);
  switchWeapon(order[(cur + dir + order.length) % order.length]);
}
addEventListener('wheel', e => { if (locked && state === 'playing' && player.alive) cycleWeapon(e.deltaY > 0 ? 1 : -1); });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('mousemove', e => {
  if (!locked || paused || state !== 'playing' || !player.alive || buyOpen) return;
  const k = 0.0022 * sens * (camera.fov / 75);
  player.yaw -= e.movementX * k;
  player.pitch = clamp(player.pitch - e.movementY * k, -1.5, 1.5);
  VMS.swayX = clamp(VMS.swayX - e.movementX * 0.00025, -0.03, 0.03);
  VMS.swayY = clamp(VMS.swayY + e.movementY * 0.00025, -0.03, 0.03);
});
function lock() {
  if (TOUCH) { locked = true; paused = false; $('pause').classList.add('hidden'); hud.note.classList.add('hidden'); enterFullscreen(); return; }
  try { const r = renderer.domElement.requestPointerLock(); if (r && r.catch) r.catch(() => hud.note.classList.remove('hidden')); } catch (e) {} }
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  hud.note.classList.add('hidden');
  if (!locked && state === 'playing' && !buyOpen) { paused = true; player.firing = false; player.ads = false; if (NET.mode !== 'off') for (const k in keys) keys[k] = false; $('pause').classList.remove('hidden'); }
  if (locked && state === 'playing') { paused = false; $('pause').classList.add('hidden'); }
});
renderer.domElement.addEventListener('click', () => { if (state === 'playing' && !locked && !buyOpen) lock(); });
$('deploy').addEventListener('click', () => { initAudio(); startMatch(); lock(); });
$('resume').addEventListener('click', () => { initAudio(); lock(); });
$('again').addEventListener('click', () => { if (NET.mode === 'host') netStartMatch(); else if (NET.mode === 'off') startMatch(); lock(); });
for (const b of document.querySelectorAll('.qbtns button')) b.addEventListener('click', () => applyQuality(b.dataset.q));
function applyQuality(name) {
  qName = name; Q = QUALITY[name];
  try { localStorage.setItem('tollgate-quality', name); } catch (e) {}
  for (const b of document.querySelectorAll('.qbtns button')) b.classList.toggle('on', b.dataset.q === name);
  renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pr)); renderer.setSize(innerWidth, innerHeight);
  if (composer) { composer.setPixelRatio(Math.min(devicePixelRatio, Q.pr)); composer.setSize(innerWidth, innerHeight); gtaoPass.enabled = Q.ao; bloomPass.enabled = Q.bloom; }
  sun.shadow.mapSize.set(Q.shadow, Q.shadow);
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  if (grassMesh) grassMesh.count = Math.floor(GRASS_MAX * Q.grass);
  for (const fm of FLOWER_MESHES) fm.count = Math.floor(FLOWER_N * Math.max(0.5, Q.grass));
}

/* =====================================================================
   MATCH FLOW
   ===================================================================== */
/* ---------- sites & spawns ---------- */
const SPAWN_ATT = [V3(-12, 0, -58), V3(8, 0, -57), V3(-32, 0, -57), V3(28, 0, -58)];
const SPAWN_DEF = SPAWN_ATT.map(p => V3(-p.x, 0, -p.z));
const SITE_DEFS = [
  { id: 'A', min: [19, 25], max: [35, 40], plant: [[24, 33], [29, 35], [22, 37]], hold: [[[31.5, 43.5], [24, 20]], [[20, 40.5], [25, 18]]], post: [[[13, 21], [25, 33]], [[33, 19], [26, 33]]] },
  { id: 'B', min: [-37, 23], max: [-21, 38], plant: [[-27, 30], [-29, 34], [-24, 33]], hold: [[[-26, 42], [-30, 18]], [[-39, 36], [-28, 15]]], post: [[[-17, 21], [-28, 31]], [[-39, 18], [-28, 31]]] },
];
const SITES = SITE_DEFS.map(s => ({ id: s.id, min: V3(s.min[0], 0, s.min[1]), max: V3(s.max[0], 0, s.max[1]), center: V3((s.min[0] + s.max[0]) / 2, 0, (s.min[1] + s.max[1]) / 2), def: s }));
function snapWalk(x, z) {
  if (walkable(x, z)) return V3(x, 0, z);
  const c = nearestWalk(cellI(x), cellJ(z));
  return c ? V3(NAV.minX + (c[0] + 0.5) * NAV.cs, 0, NAV.minZ + (c[1] + 0.5) * NAV.cs) : V3(x, 0, z);
}
function initSites() {
  for (const s of SITES) {
    s.plantV = s.def.plant.map(([x, z]) => snapWalk(x, z));
    s.holdV = s.def.hold.map(([p, l]) => ({ p: snapWalk(p[0], p[1]), look: V3(l[0], 1.4, l[1]) }));
    s.postV = s.def.post.map(([p, l]) => ({ p: snapWalk(p[0], p[1]), look: V3(l[0], 0.5, l[1]) }));
    // ground paint: zone outline + big site letter
    const paint = new THREE.MeshStandardMaterial({ color: 0xe8c33c, roughness: 0.8, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -3, depthWrite: false });
    const w = s.max.x - s.min.x, d = s.max.z - s.min.z;
    const edge = (cx, cz, ew, ed) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(ew, ed), paint); m.rotation.x = -Math.PI / 2; m.position.set(cx, 0.03, cz); m.receiveShadow = true; scene.add(m); };
    edge(s.center.x, s.min.z, w, 0.3); edge(s.center.x, s.max.z, w, 0.3); edge(s.min.x, s.center.z, 0.3, d); edge(s.max.x, s.center.z, 0.3, d);
    const lt = canvasTex(256, 256, (g, W2, H2) => { g.clearRect(0, 0, W2, H2); g.fillStyle = 'rgba(232,195,60,1)'; g.font = 'bold 220px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(s.id, W2 / 2, H2 / 2 + 10); });
    const letter = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), new THREE.MeshStandardMaterial({ map: lt, transparent: true, opacity: 0.6, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -3, depthWrite: false }));
    letter.rotation.x = -Math.PI / 2; letter.rotation.z = Math.PI; letter.position.set(s.center.x, 0.035, s.center.z - 3); letter.receiveShadow = true; scene.add(letter);
    // site sign on a post
    const signT = canvasTex(128, 128, (g) => { g.fillStyle = '#c9362b'; g.fillRect(0, 0, 128, 128); g.strokeStyle = '#fff'; g.lineWidth = 8; g.strokeRect(8, 8, 112, 112); g.fillStyle = '#fff'; g.font = 'bold 90px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(s.id, 64, 70); });
    const sp = new THREE.Group(); sp.position.set(s.min.x + 0.6, 0, s.min.z + 0.6); scene.add(sp);
    cyl(0.04, 0.04, 2.6, MAT.galv, 0, 1.3, 0, sp, 8);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshStandardMaterial({ map: signT, roughness: 0.4, side: THREE.DoubleSide })); plate.position.set(0, 2.4, 0.05); plate.rotation.y = Math.PI; sp.add(plate);
  }
}
const siteAt = (p) => { for (let i = 0; i < SITES.length; i++) { const s = SITES[i]; if (p.x >= s.min.x && p.x <= s.max.x && p.z >= s.min.z && p.z <= s.max.z) return i; } return -1; };

/* ---------- round state ---------- */
const R = { phase: 'buy', t: 0, round: 1, wins: [0, 0], attTeam: 0, lossStreak: [0, 0], planSite: 0, planted: false, beepT: 0, halftime: false,
  charge: { state: 'carried', carrier: null, pos: V3(), site: 0, defuseProg: 0, defuseCk: false, body: null } };
let chargeMesh = null, chargeLightMat = null, chargeBlink = 0;
const fxLights = [], shockwaves = [];
function buildCharge() {
  const g = new THREE.Group();
  const shell = M('#2b2e33', { metalness: 0.7, roughness: 0.35 });
  cyl(0.14, 0.16, 0.3, shell, 0, 0.15, 0, g, 18);
  const glowM = new THREE.MeshStandardMaterial({ color: 0x103a33, emissive: 0x2fe0c0, emissiveIntensity: 1.6, roughness: 0.3 });
  for (const y of [0.08, 0.22]) cyl(0.165, 0.165, 0.025, glowM, 0, y, 0, g, 18);
  cyl(0.1, 0.12, 0.05, M('#1b1d20', { metalness: 0.5, roughness: 0.4 }), 0, 0.325, 0, g, 16);
  chargeLightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.05, 0.03), toneMapped: false });
  E(0.035, 0.035, 0.035, chargeLightMat, 0, 0.365, 0, g, false);
  B(0.22, 0.02, 0.03, '#111', 0, 0.39, 0, g, { r: 0.008 });
  for (const s of [-1, 1]) B(0.02, 0.05, 0.03, '#111', s * 0.1, 0.37, 0, g);
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.visible = false; scene.add(g);
  chargeMesh = g;
}
function dropCharge(c) {
  const C = R.charge; C.carrier = null; C.state = 'dropped';
  const p = V3(c.pos.x, c.pos.y + 1.0, c.pos.z);
  if (NET.mode !== 'client') { // clients just show where the host's charge lies (snapshot)
    C.body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setLinvel(c.vel.x * 0.5 + rand(-1, 1), 2, c.vel.z * 0.5 + rand(-1, 1))
      .setAngvel({ x: rand(-3, 3), y: rand(-3, 3), z: rand(-3, 3) }).setLinearDamping(0.2).setAngularDamping(0.6).setCcdEnabled(true));
    world.createCollider(RAPIER.ColliderDesc.cylinder(0.17, 0.16).setTranslation(0, 0.17, 0).setDensity(600).setCollisionGroups(GRP(G_DEBRIS, G_STATIC | G_PROP | G_RAG)).setFriction(0.8), C.body);
  }
  C.pos.copy(p); chargeMesh.position.copy(p); chargeMesh.quaternion.identity(); chargeMesh.visible = true;
  if (c.team === player.team) popup('CHARGE DROPPED');
}
function pickupCharge(c) {
  const C = R.charge;
  if (C.body) { world.removeRigidBody(C.body); C.body = null; }
  C.state = 'carried'; C.carrier = c; chargeMesh.visible = false;
  netEmit({ t: 'pick', s: c.slot });
  if (c.isPlayer) popup('YOU HAVE THE CHARGE'); else if (c.team === player.team) popup(c.name + ' HAS THE CHARGE');
}
function plantCharge(c, net) {
  const C = R.charge;
  C.state = 'planted'; C.carrier = null;
  if (net) C.pos.set(+net.p[0], +net.p[1], +net.p[2]); else C.pos.set(c.pos.x, groundAt(c.pos.x, c.pos.z), c.pos.z);
  const si = siteAt(C.pos); C.site = net ? (net.site ? 1 : 0) : si >= 0 ? si : R.planSite;
  const rot = net ? +net.rot || 0 : rand(0, TAU);
  netEmit({ t: 'plant', s: c.slot, p: arr(C.pos), site: C.site, rot: r2(rot) });
  chargeMesh.position.copy(C.pos); chargeMesh.quaternion.identity(); chargeMesh.rotation.y = rot; chargeMesh.visible = true;
  R.phase = 'planted'; R.t = CHARGE_TIME; R.planted = true; R.beepT = 0; C.defuseProg = 0; C.defuseCk = false;
  plantedSound(C.pos);
  banner('CHARGE PLANTED', `SITE ${SITES[C.site].id}`, 'warn', 2.2);
  for (const b of bots) if (b.team !== R.attTeam) b.rotated = true;
}
function defuseCharge() { netEmit({ t: 'defuse' }); R.charge.state = 'defused'; chargeLightMat.color.setRGB(0.05, 0.6, 0.4); defusedSound(R.charge.pos); endRound(1 - R.attTeam, 'CHARGE DEFUSED'); }
function explodeCharge() {
  netEmit({ t: 'boom' });
  const C = R.charge, pos = C.pos.clone();
  C.state = 'exploded'; chargeMesh.visible = false;
  const L = new THREE.PointLight(0xffb060, 600, 90, 1.6); L.position.copy(pos).add(V3(0, 2, 0)); scene.add(L); fxLights.push({ L, born: now, life: 0.9, i0: 600 });
  for (let i = 0; i < 28; i++) puff(V3(pos.x + rand(-3, 3), pos.y + rand(0, 4), pos.z + rand(-3, 3)), rand(3, 5), 1, V3(rand(-4, 4), rand(1, 6), rand(-4, 4)), 3.5, 0x6b625a);
  burst(pos.clone().add(V3(0, 0.5, 0)), 'spark', 50, null, 5);
  const sw = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.2, 1.4), transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
  sw.position.copy(pos); scene.add(sw); noAO(sw); shockwaves.push({ m: sw, born: now });
  if (NET.mode !== 'client') for (const c of combatants) if (c.alive && c.pos.distanceTo(pos) < 22) kill(c, null, false, V3().subVectors(c.pos, pos).setY(0.4).normalize(), 'charge');
  const bodies = [...props.map(p => p.body), ...ragdolls.flatMap(r => r.list.map(q => q.body)), ...debris.map(d => d.body)];
  for (const body of bodies) {
    const t = body.translation(), v = V3(t.x - pos.x, t.y - pos.y + 1, t.z - pos.z), d = v.length();
    if (d > 32) continue;
    v.normalize().multiplyScalar(body.mass() * 24 / (1 + d * 0.25)); body.applyImpulse(v, true);
  }
  player.shake = clamp(1.4 - camera.position.distanceTo(pos) / 50, 0.25, 1.4);
  explosionSound(pos);
  endRound(R.attTeam, 'CHARGE DETONATED');
}

/* ---------- utility: smoke & flash grenades ---------- */
const grenades = [], clouds = [];
function throwUtil(c, type, origin, dir, speed, vel = c.vel, fromNet = false) {
  if (!fromNet) { // everyone simulates the same throw locally
    const m = { t: 'g', s: c.slot, ty: type, o: arr(origin), d: arr(dir), sp: speed, v: [r2(vel.x), r2(vel.z)] };
    if (NET.mode === 'host') netEmit(m); else if (NET.mode === 'client' && c === player) netSend(m);
  }
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), M(type === 'smoke' ? '#5f6a74' : '#d6cfbd', { metalness: 0.5, roughness: 0.45 }));
  mesh.castShadow = true; mesh.position.copy(origin); scene.add(mesh); noAO(mesh);
  const v = V3().copy(dir).multiplyScalar(speed).add(V3(vel.x * 0.5, 0, vel.z * 0.5));
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(origin.x, origin.y, origin.z).setLinvel(v.x, v.y, v.z).setLinearDamping(0.08).setAngularDamping(0.4).setCcdEnabled(true));
  world.createCollider(RAPIER.ColliderDesc.ball(0.055).setDensity(1500).setRestitution(0.42).setFriction(0.6).setCollisionGroups(GRP(G_DEBRIS, G_STATIC | G_PROP | G_RAG)), body);
  grenades.push({ type, mesh, body, born: now, owner: c });
  noiseHit(0.12, 'bandpass', 900, 0.15, panFor(origin).pan, 1);
}
function updateGrenades() {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i], t = g.body.translation(), v = g.body.linvel(), sp = Math.hypot(v.x, v.y, v.z), age = now - g.born;
    g.mesh.position.copy(t); g.mesh.quaternion.copy(g.body.rotation());
    const pop = g.type === 'smoke' ? (age > 0.7 && sp < 0.7) || age > 2.6 : age > 0.95;
    if (pop || t.y < -5) {
      const p = V3(t.x, Math.max(t.y, 0.05), t.z);
      world.removeRigidBody(g.body); scene.remove(g.mesh); g.mesh.geometry.dispose(); grenades.splice(i, 1);
      if (g.type === 'smoke') popSmoke(p); else popFlash(p);
    }
  }
}
function popSmoke(pos) {
  const c = { pos: pos.clone(), born: now, until: now + 15, R: 4.3, sprites: [] };
  c.pos.y = Math.max(pos.y, 0) + 1.5;
  for (let i = 0; i < 32; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.smoke, color: new THREE.Color(0.6, 0.62, 0.66), transparent: true, depthWrite: false, opacity: 0 }));
    s.userData.off = V3(rand(-1, 1), rand(-0.55, 1), rand(-1, 1)).normalize().multiplyScalar(Math.cbrt(Math.random()) * c.R * 0.75);
    s.userData.sz = rand(3.4, 5.2); s.material.rotation = rand(0, TAU);
    scene.add(s); c.sprites.push(s);
  }
  clouds.push(c);
  noiseHit(0.25, 'lowpass', 1600, 1.8, panFor(pos).pan, 0.6, 0, 300);
}
function cloudR(c) { const left = c.until - now; return c.R * smooth(0, 1.0, now - c.born) * (left < 1.5 ? smooth(0, 1.5, left) : 1); }
function updateClouds(dt) {
  for (let i = clouds.length - 1; i >= 0; i--) {
    const c = clouds[i];
    if (now > c.until) { for (const s of c.sprites) { scene.remove(s); s.material.dispose(); } clouds.splice(i, 1); continue; }
    const r = cloudR(c) / c.R;
    for (const s of c.sprites) {
      s.position.copy(c.pos).addScaledVector(s.userData.off, 0.4 + 0.6 * r);
      s.scale.setScalar(s.userData.sz * (0.3 + 0.7 * r)); s.material.opacity = 0.93 * r; s.material.rotation += dt * 0.05;
    }
  }
}
const _sv = V3(), _sw = V3(), _sx = V3();
function smokeBlocks(a, b) {
  for (const c of clouds) {
    const r = cloudR(c) * 0.85; if (r < 0.5) continue;
    _sv.subVectors(b, a); const L2 = _sv.lengthSq();
    const t = L2 > 0 ? clamp(_sw.subVectors(c.pos, a).dot(_sv) / L2, 0, 1) : 0;
    _sx.copy(a).addScaledVector(_sv, t);
    if (_sx.distanceTo(c.pos) < r) return true;
  }
  return false;
}
let flashAmt = 0;
function popFlash(pos) {
  const L = new THREE.PointLight(0xffffff, 250, 30, 1.6); L.position.copy(pos); scene.add(L); fxLights.push({ L, born: now, life: 0.25, i0: 250 });
  puff(pos, 0.6, 2, null, 1.2, 0xe8e4dc);
  const { d: ld, pan } = panFor(pos);
  noiseHit(0.9 / (1 + ld / 8), 'highpass', 900, 0.35, pan, 0.7); blip(1600, 0.05, 'square', 0.2 / (1 + ld / 8));
  for (const c of combatants) {
    if (!c.alive) continue;
    const eye = eyeOf(c, V3()), d = eye.distanceTo(pos);
    if (d > 38 || !losClear(eye, pos) || smokeBlocks(eye, pos)) continue;
    const dir = V3().subVectors(pos, eye).normalize();
    const fwd = c.isPlayer ? V3(0, 0, -1).applyQuaternion(camera.quaternion) : V3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
    const dot = fwd.dot(dir);
    const dur = (dot > 0.55 ? 2.1 : dot > 0 ? 1.1 : 0.35) * clamp(1.3 - d / 35, 0.3, 1);
    c.blindUntil = Math.max(c.blindUntil, now + dur);
    if (c.isPlayer) { flashAmt = dot > 0 ? 1 : 0.55; blip(3500, Math.min(2.5, dur + 0.3), 'sine', 0.05); }
  }
}

/* ---------- economy & buying ---------- */
function priceOf(id) { return WEAPONS[id] ? WEAPONS[id].price : ARMOR[id] ? ARMOR[id].price : UTIL[id] ? UTIL[id].price : 0; }
function owns(c, id) {
  if (WEAPONS[id]) return c.loadout.primary === id || c.loadout.side === id;
  if (ARMOR[id]) return c.armorMax === ARMOR[id].val && c.armor > 0;
  if (id === 'smoke') return c.smokes >= UTIL.smoke.max;
  if (id === 'flash') return c.flashes >= UTIL.flash.max;
  return false;
}
function buyItem(c, id) {
  const price = priceOf(id);
  if (R.phase !== 'buy' || price > c.credits) return false;
  if (WEAPONS[id]) {
    const W = WEAPONS[id];
    if (W.slot === 'primary') { if (c.loadout.primary === id) return false; c.loadout.primary = id; }
    else { if (c.loadout.side === id) return false; c.loadout.side = id; }
    refill(c, id);
  } else if (ARMOR[id]) { if (c.armor >= ARMOR[id].val) return false; c.armor = ARMOR[id].val; c.armorMax = ARMOR[id].val; }
  else if (id === 'smoke') { if (c.smokes >= UTIL.smoke.max) return false; c.smokes++; }
  else if (id === 'flash') { if (c.flashes >= UTIL.flash.max) return false; c.flashes++; }
  c.credits -= price; return true;
}
function playerBuy(id) {
  const p = player;
  if (R.phase !== 'buy' || !p.alive) return;
  const j = p.bought.findIndex(x => x.id === id);
  if (j >= 0 && (WEAPONS[id] || ARMOR[id])) { // refund
    const x = p.bought[j]; p.credits += x.price; p.bought.splice(j, 1);
    if (WEAPONS[id]) { if (WEAPONS[id].slot === 'primary') p.loadout.primary = x.prev; else p.loadout.side = x.prev; if (x.prev) refill(p, x.prev); }
    else { p.armor = x.prev; p.armorMax = x.prevMax; }
    selectBest(); blip(500, 0.08, 'triangle', 0.12); return;
  }
  if (WEAPONS[id] && WEAPONS[id].slot === 'primary') { // swapping a primary bought this round refunds it first
    const k = p.bought.findIndex(x => WEAPONS[x.id] && WEAPONS[x.id].slot === 'primary');
    if (k >= 0) { p.credits += p.bought[k].price; p.loadout.primary = p.bought[k].prev; p.bought.splice(k, 1); }
  }
  const prev = WEAPONS[id] ? (WEAPONS[id].slot === 'primary' ? p.loadout.primary : p.loadout.side) : p.armor, prevMax = p.armorMax;
  if (!buyItem(p, id)) { blip(180, 0.12, 'square', 0.08); return; }
  p.bought.push({ id, price: priceOf(id), prev, prevMax });
  blip(1200, 0.06, 'triangle', 0.12); blip(1800, 0.06, 'triangle', 0.1, 0.05);
  if (WEAPONS[id]) selectBest();
}
function botBuy(b) {
  if (!b.loadout.primary) {
    if (b.credits >= 2900) buyItem(b, 'sniper');
  }
  if (b.credits >= 1000) buyItem(b, 'heavy'); else if (b.credits >= 400 && b.armor < 25) buyItem(b, 'light');
  if (!b.loadout.primary && b.loadout.side === 'pistol' && b.credits >= 800 && Math.random() < 0.6) buyItem(b, 'magnum');
  if (b.credits >= 300) buyItem(b, 'smoke');
  if (b.credits >= 250) buyItem(b, 'flash');
  b.weapon = b.loadout.primary || b.loadout.side;
}
function openBuy() {
  if (R.phase !== 'buy' || !player.alive || state !== 'playing') return;
  buyOpen = true; player.firing = false; player.ads = false;
  refreshBuyMenu(); $('buymenu').classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
}
function closeBuy(relock) {
  buyOpen = false; $('buymenu').classList.add('hidden');
  if (relock) lock(); else if (state === 'playing' && !locked) hud.note.classList.remove('hidden');
}

/* ---------- round flow ---------- */
function clearWorldForRound() {
  for (const r of ragdolls.slice()) removeRagdoll(r);
  for (const d of debris.slice()) killDebris(d);
  for (const g of grenades) { world.removeRigidBody(g.body); scene.remove(g.mesh); }
  grenades.length = 0;
  for (const c of clouds) for (const s of c.sprites) { scene.remove(s); s.material.dispose(); }
  clouds.length = 0;
  for (const f of fxLights) scene.remove(f.L); fxLights.length = 0;
  for (const s of shockwaves) scene.remove(s.m); shockwaves.length = 0;
  resetGlass();
  for (const pr of props) { const [x, y, z, r] = pr.home; const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r, 0)); pr.body.setTranslation({ x, y, z }, true); pr.body.setRotation(q, true); pr.body.setLinvel({ x: 0, y: 0, z: 0 }, true); pr.body.setAngvel({ x: 0, y: 0, z: 0 }, true); }
  for (const m of decals) m.visible = false;
  flashAmt = 0;
}
function resetEconomy(c) { c.credits = ECON.start; c.loadout = { primary: null, side: 'pistol' }; c.armor = 0; c.armorMax = 0; c.smokes = 0; c.flashes = 0; }
// mp: true when a multiplayer match starts (roster already set up by the lobby)
function startMatch(mp) {
  if (!mp) { netLeave(); setupRoster(SOLO_ROSTER); }
  R.wins = [0, 0]; R.round = 1; R.attTeam = 0; R.lossStreak = [0, 0]; R.halftime = false;
  for (const c of combatants) { c.kills = 0; c.deaths = 0; resetEconomy(c); c.alive = false; }
  hud.killfeed.innerHTML = '';
  state = 'playing'; paused = false;
  for (const id of ['menu', 'endscreen', 'pause', 'lobby']) $(id).classList.add('hidden');
  $('hud').classList.remove('hidden');
  updateMpButtons();
  if (NET.mode !== 'client') startRound(); // clients wait for the host's 'round' event
}
// net: the host's round data when running as a multiplayer client
function startRound(net) {
  if (!net) hostAdmitPending(); // players who joined mid-match take over their reserved bot now
  clearWorldForRound();
  R.phase = 'buy'; R.t = BUY_TIME; R.planted = false; R.beepT = 0;
  const C = R.charge;
  C.state = 'carried'; C.carrier = null; C.defuseProg = 0; C.defuseCk = false;
  if (C.body) { world.removeRigidBody(C.body); C.body = null; }
  chargeMesh.visible = false; chargeLightMat.color.setRGB(0.4, 0.05, 0.03);
  R.planSite = net ? (net.ps ? 1 : 0) : Math.random() < 0.5 ? 0 : 1;
  const half = R.halftime;
  let ai = 0, di = 0;
  for (const c of combatants) placeAtSpawn(c, c.team === R.attTeam ? ai++ : di++);
  for (const c of nets) c.net = null;
  if (net) for (const [s, x, z, w] of net.sp) {
    const c = bySlot(s); if (!c) continue;
    c.pos.set(+x, 0, +z); c.kin.setTranslation({ x: c.pos.x, y: 0.9, z: c.pos.z }, true);
    if (!c.isPlayer) { if (WEAPONS[w]) c.weapon = w; c.model.root.position.copy(c.pos); }
  }
  const atts = combatants.filter(c => c.team === R.attTeam);
  if (net) C.carrier = bySlot(net.car);
  else { const hum = atts.filter(c => c.ctl !== 'ai'), pick = hum.length ? hum : atts; C.carrier = pick[(Math.random() * pick.length) | 0]; }
  const defBots = bots.filter(b => b.team !== R.attTeam);
  defBots.forEach((b, i) => { b.siteIdx = defBots.length === 1 ? 1 : i % 2; b.holdIdx = (Math.random() * 2) | 0; b.rotated = false; b.rotCheck = 0; });
  for (const b of bots) { b.usedSmoke = false; botBuy(b); b.weapon = b.loadout.primary || b.loadout.side; refill(b, b.weapon); fitBotGun(b.model, b.weapon); }
  player.bought = []; selectBest();
  netEmit({ t: 'round', n: R.round, att: R.attTeam, ps: R.planSite, half: half ? 1 : 0, car: slotOf(C.carrier), w: R.wins,
    sp: combatants.map(c => [c.slot, r2(c.pos.x), r2(c.pos.z), c.weapon]) });
  const att = player.team === R.attTeam;
  banner(half ? 'SWITCHING SIDES' : `ROUND ${R.round}`, att ? 'ATTACK · PLANT THE CHARGE ON A OR B' : 'DEFEND · HOLD SITES A AND B', att ? 'att' : 'def', 2.6);
  R.halftime = false;
  refreshBuyMenu();
}
function goLive() {
  R.phase = 'live'; R.t = ROUND_TIME;
  netEmit({ t: 'live' });
  if (buyOpen) closeBuy(false);
  blip(520, 0.15, 'square', 0.1); blip(780, 0.2, 'square', 0.1, 0.12);
}
function endRound(win, reason) {
  if (R.phase === 'end') return;
  netEmit({ t: 'end', win, why: reason });
  R.phase = 'end'; R.t = END_TIME;
  R.wins[win]++;
  const lose = 1 - win;
  for (const c of combatants) {
    if (c.team === win) c.credits += ECON.win;
    else c.credits += ECON.loss[Math.min(R.lossStreak[lose], 2)];
    if (R.planted && c.team === R.attTeam) c.credits += ECON.plant;
    c.credits = Math.min(ECON.max, c.credits);
  }
  R.lossStreak[lose]++; R.lossStreak[win] = 0;
  player.action = null; for (const b of bots) b.action = null;
  const mine = win === player.team;
  banner(mine ? 'ROUND WON' : 'ROUND LOST', reason, mine ? 'win' : 'lose', END_TIME - 0.3);
  if (mine) { blip(660, 0.12, 'triangle', 0.15); blip(990, 0.25, 'triangle', 0.15, 0.12); } else { blip(330, 0.18, 'triangle', 0.15); blip(220, 0.35, 'triangle', 0.15, 0.15); }
}
function nextRound() {
  if (R.wins[0] >= ROUNDS_TO_WIN || R.wins[1] >= ROUNDS_TO_WIN) return endMatch();
  R.round++;
  if (R.round === HALF_ROUNDS + 1) { R.attTeam = 1 - R.attTeam; R.lossStreak = [0, 0]; R.halftime = true; for (const c of combatants) resetEconomy(c); }
  startRound();
}
function updateRound(dt) {
  const C = R.charge;
  R.t -= dt;
  if (NET.mode === 'client') { // the host decides everything; clients only tick the clock and beep
    if (R.phase === 'planted') { R.beepT -= dt; if (R.beepT <= 0) { R.beepT = R.t > 20 ? 1 : R.t > 10 ? 0.5 : R.t > 5 ? 0.25 : 0.12; chargeBlink = 0.07; chargeBeep(C.pos, R.t < 10); } }
    return;
  }
  if (R.phase === 'buy') { if (R.t <= 0) goLive(); return; }
  if (R.phase === 'end') { if (R.t <= 0) nextRound(); return; }
  // when a human carries the charge, the bots play the site closest to them
  if (C.carrier && C.carrier.ctl !== 'ai' && R.phase === 'live') { const cp = C.carrier.pos, dA = dist2(cp, SITES[0].center), dB = dist2(cp, SITES[1].center); if (Math.abs(dA - dB) > 12) R.planSite = dA < dB ? 0 : 1; }
  if (C.state === 'dropped' && C.body) {
    for (const c of combatants) if (c.alive && c.team === R.attTeam && dist2(c.pos, C.pos) < 2.0 && Math.abs(c.pos.y + 0.4 - C.pos.y) < 1.8) { pickupCharge(c); break; }
  }
  const attAlive = combatants.some(c => c.alive && c.team === R.attTeam), defAlive = combatants.some(c => c.alive && c.team !== R.attTeam);
  if (R.phase === 'live') {
    if (!attAlive) return endRound(1 - R.attTeam, 'ATTACKERS ELIMINATED');
    if (!defAlive) return endRound(R.attTeam, 'DEFENDERS ELIMINATED');
    if (R.t <= 0) return endRound(1 - R.attTeam, 'TIME EXPIRED');
  } else if (R.phase === 'planted') {
    if (!defAlive) return endRound(R.attTeam, 'DEFENDERS ELIMINATED');
    R.beepT -= dt;
    if (R.beepT <= 0) { R.beepT = R.t > 20 ? 1 : R.t > 10 ? 0.5 : R.t > 5 ? 0.25 : 0.12; chargeBlink = 0.07; chargeBeep(C.pos, R.t < 10); }
    if (R.t <= 0) explodeCharge();
  }
}
function updateFX(dt) {
  chargeBlink -= dt;
  if (R.charge.state === 'planted') chargeLightMat.color.setRGB(chargeBlink > 0 ? 6 : 0.4, chargeBlink > 0 ? 0.6 : 0.05, chargeBlink > 0 ? 0.3 : 0.03);
  for (let i = fxLights.length - 1; i >= 0; i--) { const f = fxLights[i], k = (now - f.born) / f.life; if (k >= 1) { scene.remove(f.L); fxLights.splice(i, 1); continue; } f.L.intensity = f.i0 * (1 - k) * (1 - k); }
  for (let i = shockwaves.length - 1; i >= 0; i--) { const s = shockwaves[i], k = (now - s.born) / 0.6; if (k >= 1) { scene.remove(s.m); shockwaves.splice(i, 1); continue; } s.m.scale.setScalar(1 + k * 22); s.m.material.opacity = 0.55 * (1 - k); }
}
function endMatch() {
  netEmit({ t: 'over' });
  state = 'ended';
  const win = R.wins[player.team] > R.wins[1 - player.team];
  const t = $('endTitle'); t.textContent = win ? 'VICTORY' : 'DEFEAT'; t.className = win ? 'win' : 'lose';
  $('endSub').textContent = `RAVEN ${R.wins[0]} — ${R.wins[1]} FROST`;
  updateMpButtons();
  renderBoard($('endBoard'));
  $('hud').classList.add('hidden'); hud.death.classList.add('hidden'); $('scoreboard').classList.add('hidden'); $('buymenu').classList.add('hidden'); buyOpen = false;
  $('endscreen').classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
}

/* ---------- extra sounds ---------- */
function weaponSound(W, dist, pan, mine) {
  if (!actx) return;
  if (W.silenced) { const v = mine ? 0.32 : 0.28 / (1 + dist / 6); noiseHit(v, 'lowpass', 1800, 0.13, pan, 0.8, 0, 500); noiseHit(v * 0.5, 'bandpass', 3400, 0.05, pan, 2); return; }
  const P = { pistol: [0.55, 7500, 0.16, 210], magnum: [0.95, 5200, 0.38, 120], smg: [0.48, 8000, 0.12, 190], rifle: [0.75, 7000, 0.22, 165], sniper: [1.0, 4500, 0.6, 85] }[W.sound] || [0.7, 7000, 0.2, 160];
  const vol = mine ? P[0] : P[0] * 0.95 / (1 + dist / 10);
  if (vol < 0.01) return;
  const t = actx.currentTime;
  noiseHit(vol, 'lowpass', mine ? P[1] : Math.max(600, P[1] - dist * 70), P[2], pan, 0.7, 0, 300);
  const pn = actx.createStereoPanner(); pn.pan.value = clamp(pan, -1, 1); pn.connect(master);
  const o = actx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(P[3], t); o.frequency.exponentialRampToValueAtTime(38, t + 0.12);
  const og = actx.createGain(); og.gain.setValueAtTime(vol * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  o.connect(og).connect(pn); o.start(t); o.stop(t + 0.16);
  noiseHit(vol * 0.13, 'bandpass', 800, P[2] * 3, pan, 0.6, 0.05);
}
function plantStartSound(pos) { const { d, pan } = panFor(pos); for (let i = 0; i < 4; i++) noiseHit(0.15 / (1 + d / 8), 'bandpass', 2200 + i * 300, 0.06, pan, 3, i * 0.9); }
function defuseStartSound(pos) { const { d, pan } = panFor(pos); noiseHit(0.2 / (1 + d / 8), 'bandpass', 1500, 0.25, pan, 2); }
function plantedSound(pos) { const { d, pan } = panFor(pos); const v = 0.25 / (1 + d / 15); blip(880, 0.15, 'square', v); blip(1320, 0.3, 'square', v, 0.15); noiseHit(v, 'bandpass', 600, 0.4, pan, 1); }
function chargeBeep(pos, fast) { if (!actx) return; const { d } = panFor(pos); blip(fast ? 1900 : 1500, 0.06, 'sine', 0.12 / (1 + d / 20)); }
function defusedSound() { blip(600, 0.1, 'triangle', 0.15); blip(450, 0.3, 'triangle', 0.15, 0.1); }
function explosionSound(pos) {
  if (!actx) return;
  const { d, pan } = panFor(pos), v = 1.2 / (1 + d / 25), t = actx.currentTime;
  noiseHit(v, 'lowpass', 2500, 2.2, pan, 0.5, 0, 80);
  const o = actx.createOscillator(), g = actx.createGain(); o.type = 'sine';
  o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(25, t + 1.2);
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
  o.connect(g).connect(master); o.start(t); o.stop(t + 1.5);
}

/* =====================================================================
   HUD UPDATE
   ===================================================================== */
const lastHud = {};
function setText(el, key, v) { if (lastHud[key] !== v) { lastHud[key] = v; el.textContent = v; } }
function setHTML(el, key, v) { if (lastHud[key] !== v) { lastHud[key] = v; el.innerHTML = v; } }
const fmtT = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const _aimDir = V3(), _aimO = V3();
let aimCheck = 0, spotCheck = 0;
function updateHud(dt) {
  const p = player, W = WEAPONS[p.weapon], C = R.charge;
  const my = p.team, ot = 1 - my; // left side of the top bar is always your team
  setText(hud.wA, 'wA', R.wins[my]); setText(hud.wB, 'wB', R.wins[ot]);
  setText(hud.roleA, 'rA', R.attTeam === my ? 'ATK' : 'DEF'); setText(hud.roleB, 'rB', R.attTeam === ot ? 'ATK' : 'DEF');
  const pips = t => combatants.filter(c => c.team === t).map(c => `<i class="${c.alive ? '' : 'dead'}"></i>`).join('');
  setHTML(hud.pipsA, 'pA', pips(my)); setHTML(hud.pipsB, 'pB', pips(ot));
  const tt = Math.max(0, R.t);
  setText(hud.rtime, 'rt', R.phase === 'planted' ? '◆ ' + Math.ceil(tt) : fmtT(Math.ceil(tt)));
  hud.rtime.classList.toggle('planted', R.phase === 'planted');
  const att = p.team === R.attTeam;
  setText(hud.phase, 'ph', R.phase === 'buy' ? 'BUY PHASE' : R.phase === 'planted' ? (att ? 'DEFEND THE CHARGE' : 'DEFUSE THE CHARGE') : R.phase === 'end' ? 'ROUND OVER' : att ? 'ATTACK' : 'DEFEND');
  const hp = Math.max(0, Math.round(p.hp));
  setText(hud.hpnum, 'hp', hp); setText(hud.armnum, 'ar', p.armor > 0 ? '◈ ' + Math.round(p.armor) : '');
  hud.hpbar.style.width = hp + '%'; hud.hpbar.style.background = hp < 35 ? '#ff4b3e' : '';
  setText(hud.credits, 'cr', '¤ ' + p.credits);
  setText(hud.wname, 'wn', W.name);
  if (W.melee) { setText(hud.mag, 'mag', '—'); setText(hud.res, 'res', ''); hud.ammo.classList.remove('low'); }
  else { setText(hud.mag, 'mag', p.mag[W.id]); setText(hud.res, 'res', '/ ' + p.res[W.id]); hud.ammo.classList.toggle('low', p.mag[W.id] <= Math.ceil(W.mag * 0.25)); }
  const lowAmmo = !W.melee && p.mag[W.id] <= Math.ceil(W.mag * 0.25) && p.alive;
  hud.reloadhint.classList.toggle('hidden', !(lowAmmo || p.reloading));
  setText(hud.reloadhint, 'hint', p.reloading ? 'RELOADING…' : p.mag[W.id] === 0 && p.res[W.id] === 0 ? 'OUT OF AMMO' : 'PRESS R TO RELOAD');
  setText(hud.uQ, 'uQ', p.smokes); setText(hud.uE, 'uE', p.flashes);
  hud.chargeIco.classList.toggle('hidden', C.carrier !== p);
  hurtFlash = Math.max(0, hurtFlash - dt * 1.5);
  hud.vignette.style.opacity = clamp((1 - p.hp / 100) * 0.9 + hurtFlash, 0, 1).toFixed(3);
  // crosshair shows current error (stop moving -> it tightens)
  const err = W.melee ? 0 : curErr(p, W);
  const gap = clamp(3 + err * 320, 3, 60);
  const scoped = W.scope && p.adsT > 0.9 && p.alive;
  hud.crosshair.style.opacity = (!p.alive || scoped || (W.ads && p.adsT > 0.6)) ? 0 : 1;
  chParts.t.style.top = (-gap - 7) + 'px'; chParts.b.style.top = gap + 'px'; chParts.l.style.left = (-gap - 7) + 'px'; chParts.r.style.left = gap + 'px';
  hud.scope.classList.toggle('hidden', !scoped);
  // flash / smoke overlays
  flashAmt = now < p.blindUntil ? flashAmt : Math.max(0, flashAmt - dt * 1.6);
  hud.flashov.style.opacity = (p.alive ? clamp(flashAmt * Math.min(1, (p.blindUntil - now + 0.6) / 0.6), 0, 1) : 0).toFixed(3);
  let inSmoke = 0;
  for (const c of clouds) { const r = cloudR(c); if (r < 0.5) continue; inSmoke = Math.max(inSmoke, clamp(1.15 - camera.position.distanceTo(c.pos) / (r * 0.9), 0, 1)); }
  hud.smokeov.style.opacity = inSmoke.toFixed(3);
  // objective action bar + hints
  let act = null, prog = 0;
  if (p.action === 'plant') { act = 'PLANTING'; prog = p.actionT / PLANT_TIME; }
  else if (p.action === 'defuse') { act = 'DEFUSING'; prog = C.defuseProg / DEFUSE_TIME; }
  else { const b = combatants.find(b => !b.isPlayer && b.alive && b.action && b.team === p.team); if (b) { act = `${b.name} ${b.action === 'plant' ? 'PLANTING' : 'DEFUSING'}`; prog = b.actionT / (b.action === 'plant' ? PLANT_TIME : DEFUSE_TIME); } }
  hud.action.classList.toggle('hidden', !act);
  if (act) { setText(hud.actionL, 'al', act); hud.actionBar.style.width = (clamp(prog, 0, 1) * 100).toFixed(1) + '%'; }
  let hint = '';
  if (p.alive && !p.action) {
    if (R.phase === 'buy') hint = buyOpen ? '' : 'PRESS B TO BUY';
    else if (R.phase === 'live' && C.carrier === p) hint = siteAt(p.pos) >= 0 ? 'HOLD F TO PLANT' : 'BRING THE CHARGE TO SITE A OR B';
    else if (R.phase === 'planted' && !att && dist2(p.pos, C.pos) < 1.6) hint = 'HOLD F TO DEFUSE';
  }
  setText(hud.ctxhint, 'ctx', hint);
  if (bannerTimer > 0) { bannerTimer -= dt; if (bannerTimer <= 0) hud.banner.classList.add('hidden'); else hud.banner.classList.remove('hidden'); }
  // enemy name under crosshair + player's own spotting for the minimap
  aimCheck -= dt;
  if (aimCheck <= 0) {
    aimCheck = 0.1; let name = '';
    if (p.alive) { camera.getWorldPosition(_aimO); _aimDir.set(0, 0, -1).applyQuaternion(camera.quaternion); const r = traceShot(_aimO, _aimDir, 90, p); if (r.hit && !smokeBlocks(_aimO, r.hit.pos.clone().setY(r.hit.pos.y + 1.2))) name = r.hit.name; }
    setText(hud.aimname, 'aim', name);
  }
  spotCheck -= dt;
  if (spotCheck <= 0 && p.alive) {
    spotCheck = 0.2;
    camera.getWorldPosition(_aimO); _aimDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    for (const e of combatants) {
      if (e.team === p.team || !e.alive) continue;
      chestOf(e, _tc); const v = V3().subVectors(_tc, _aimO), d = v.length(); v.normalize();
      if (d < 90 && v.dot(_aimDir) > 0.55 && losClear(_aimO, _tc) && !smokeBlocks(_aimO, _tc)) { e.seenBy[p.team] = now; e.lastSeenPos.copy(e.pos); }
    }
  }
  updateDmgInds();
  drawMinimap();
}

/* =====================================================================
   PHYSICS SYNC
   ===================================================================== */
let physAcc = 0;
function stepPhysics(dt) {
  for (const c of combatants) if (!c.isPlayer && c.alive) c.kin.setNextKinematicTranslation({ x: c.pos.x, y: c.pos.y + 0.9, z: c.pos.z });
  physAcc += dt; let n = 0;
  while (physAcc >= world.timestep && n < 4) { world.step(); physAcc -= world.timestep; n++; }
  if (n === 4) physAcc = 0;
  for (const p of props) { if (p.body.isSleeping()) continue; p.obj.position.copy(p.body.translation()); p.obj.quaternion.copy(p.body.rotation()); }
  for (const r of ragdolls) for (const p of r.list) { if (p.body.isSleeping()) continue; p.g.position.copy(p.body.translation()); p.g.quaternion.copy(p.body.rotation()); }
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    if (now > d.die) { killDebris(d); continue; }
    if (!d.body.isSleeping()) { d.mesh.position.copy(d.body.translation()); d.mesh.quaternion.copy(d.body.rotation()); }
  }
  const C = R.charge;
  if (C.body) { const t = C.body.translation(); C.pos.set(t.x, t.y, t.z); chargeMesh.position.copy(t); chargeMesh.quaternion.copy(C.body.rotation()); }
  updateGrenades();
}

/* =====================================================================
   SHADOW FOLLOW + MAIN LOOP
   ===================================================================== */
const _lr = V3(), _lu = V3(), _lc = V3();
function updateShadowCam(center) {
  const texel = (2 * SHADOW_R) / sun.shadow.mapSize.x;
  _lr.crossVectors(SUN_DIR, YAX).normalize(); _lu.crossVectors(_lr, SUN_DIR).normalize();
  const px = Math.round(center.dot(_lr) / texel) * texel, py = Math.round(center.dot(_lu) / texel) * texel, pz = center.dot(SUN_DIR);
  _lc.copy(_lr).multiplyScalar(px).addScaledVector(_lu, py).addScaledVector(SUN_DIR, pz);
  sun.target.position.copy(_lc); sun.position.copy(_lc).addScaledVector(SUN_DIR, 160);
}
let menuT = 0;
function menuCamera(dt) {
  menuT += dt * 0.05;
  const r = 30;
  camera.position.set(Math.cos(menuT) * r, 8 + Math.sin(menuT * 2) * 1.5, Math.sin(menuT) * r);
  camera.lookAt(0, 3, 0);
  if (camera.fov !== 55) { camera.fov = 55; camera.updateProjectionMatrix(); }
}
function update(dt) {
  now += dt;
  updateRound(dt);
  updatePlayer(dt);
  for (const b of bots) updateBot(b, dt);
  for (const c of nets) updateNetPuppet(c, dt);
  stepPhysics(dt);
  updateClouds(dt); updateFX(dt);
  updateTracers(dt); updateParts(dt);
  updateHud(dt);
  netTick(dt);
}
let last = performance.now(), fpsAcc = 0, fpsN = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const rdt = (t - last) / 1000; last = t;
  const dt = Math.min(0.05, rdt);
  fpsAcc += rdt; fpsN++; if (fpsAcc > 0.5) { hud.fps.textContent = Math.round(fpsN / fpsAcc) + ' FPS · ' + qName.toUpperCase() + (NET.mode === 'client' ? ' · ' + NET.ping + ' MS' : ''); fpsAcc = 0; fpsN = 0; }
  windTime.value += dt;
  if (TOUCH) updateTouchUI();
  if (state === 'playing' && (!paused || NET.mode !== 'off')) update(dt); // an online match keeps running while you're paused
  else if (state !== 'playing') { menuCamera(dt); now += dt; stepPhysics(dt); updateTracers(dt); updateParts(dt); }
  updateShadowCam(state === 'playing' ? camera.position : _lc.set(0, 0, 0));
  const showVM = state === 'playing' && player.alive;
  if (!showVM) vmRoot.visible = false;
  if (composer && Q.post) composer.render(dt);
  else {
    renderer.setRenderTarget(null); renderer.clear(); renderer.render(scene, camera);
    if (showVM) { renderer.clearDepth(); renderer.render(weaponScene, weaponCam); }
  }
}
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  if (composer) composer.setSize(innerWidth, innerHeight);
  camera.aspect = weaponCam.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix(); weaponCam.updateProjectionMatrix();
});

/* =====================================================================
   TOUCH CONTROLS & APP INSTALL
   ===================================================================== */
const touchMove = { x: 0, y: 0 };
let touchSens = 1;
try { const s = parseFloat(localStorage.getItem('tollgate-tsens')); if (s) touchSens = s; } catch (e) {}
function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }
function enterFullscreen() {
  if (IS_APP) return;
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) {
    el.requestFullscreen({ navigationUI: 'hide' }).then(() => { try { screen.orientation.lock('landscape').catch(() => {}); } catch (e) {} }).catch(() => {});
  }
}
const TB = {};
function setupTouch() {
  document.body.classList.add('touch');
  const ts = $('tsens'); ts.value = touchSens; $('tsensv').textContent = touchSens.toFixed(2);
  ts.addEventListener('input', e => { touchSens = parseFloat(e.target.value); $('tsensv').textContent = touchSens.toFixed(2); try { localStorage.setItem('tollgate-tsens', touchSens); } catch (er) {} });
  for (const id of ['touch', 'tzone', 'tjoy', 'tknob', 'tFire', 'tFire2', 'tAds', 'tJump', 'tCrouch', 'tReload', 'tSwap', 'tSmoke', 'tFlash', 'tAct', 'tBuy', 'tPause', 'tBoard']) TB[id] = $(id);
  const JR = 58;
  let moveId = null, mx0 = 0, my0 = 0;
  const looks = new Map();
  const homeJoy = () => { TB.tjoy.style.left = '110px'; TB.tjoy.style.top = (innerHeight - 110) + 'px'; };
  const look = (id, x, y) => {
    const l = looks.get(id); if (!l) return;
    const dx = x - l.x, dy = y - l.y; l.x = x; l.y = y;
    if (!player.alive || paused || state !== 'playing' || buyOpen) return;
    const k = 0.0045 * touchSens * (camera.fov / 75);
    player.yaw -= dx * k; player.pitch = clamp(player.pitch - dy * k, -1.5, 1.5);
    VMS.swayX = clamp(VMS.swayX - dx * 0.0002, -0.03, 0.03); VMS.swayY = clamp(VMS.swayY + dy * 0.0002, -0.03, 0.03);
  };
  TB.tzone.addEventListener('touchstart', e => {
    e.preventDefault(); initAudio();
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth * 0.42 && moveId === null) {
        moveId = t.identifier; mx0 = t.clientX; my0 = t.clientY;
        TB.tjoy.style.left = mx0 + 'px'; TB.tjoy.style.top = my0 + 'px'; TB.tjoy.classList.add('on'); TB.tknob.style.transform = 'translate(-50%,-50%)';
      } else looks.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
  }, { passive: false });
  TB.tzone.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) {
        let dx = t.clientX - mx0, dy = t.clientY - my0; const d = Math.hypot(dx, dy);
        if (d > JR) { dx *= JR / d; dy *= JR / d; }
        touchMove.x = dx / JR; touchMove.y = -dy / JR;
        TB.tknob.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
      } else look(t.identifier, t.clientX, t.clientY);
    }
  }, { passive: false });
  const zoneEnd = e => {
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) { moveId = null; touchMove.x = touchMove.y = 0; TB.tjoy.classList.remove('on'); TB.tknob.style.transform = 'translate(-50%,-50%)'; homeJoy(); }
      looks.delete(t.identifier);
    }
  };
  TB.tzone.addEventListener('touchend', zoneEnd); TB.tzone.addEventListener('touchcancel', zoneEnd);
  const btn = (id, down, up, lookToo) => {
    const el = TB[id];
    el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); initAudio(); el.classList.add('down'); if (lookToo) for (const t of e.changedTouches) looks.set(t.identifier, { x: t.clientX, y: t.clientY }); if (down) down(); }, { passive: false });
    el.addEventListener('touchmove', e => { e.preventDefault(); e.stopPropagation(); if (lookToo) for (const t of e.changedTouches) look(t.identifier, t.clientX, t.clientY); }, { passive: false });
    const end = e => { e.preventDefault(); e.stopPropagation(); el.classList.remove('down'); for (const t of e.changedTouches) looks.delete(t.identifier); if (up) up(); };
    el.addEventListener('touchend', end, { passive: false }); el.addEventListener('touchcancel', end, { passive: false });
  };
  const fireDown = () => { if (!player.alive || paused || buyOpen) return; player.firing = true; player.fireQueuedAt = now; };
  const fireUp = () => { player.firing = false; };
  btn('tFire', fireDown, fireUp, true);
  btn('tFire2', fireDown, fireUp, false);
  btn('tAds', () => { player.ads = !player.ads; });
  btn('tJump', () => { jumpQueued = true; });
  btn('tCrouch', () => { keys.KeyC = !keys.KeyC; });
  btn('tReload', () => startReload());
  btn('tSwap', () => cycleWeapon(1));
  btn('tSmoke', () => playerThrow('smoke'));
  btn('tFlash', () => playerThrow('flash'));
  btn('tAct', () => { keys.KeyF = true; }, () => { keys.KeyF = false; });
  btn('tBuy', () => { if (buyOpen) closeBuy(true); else openBuy(); });
  btn('tPause', () => { if (state !== 'playing') return; paused = true; player.firing = false; keys.KeyF = false; if (NET.mode !== 'off') touchMove.x = touchMove.y = 0; $('pause').classList.remove('hidden'); });
  btn('tBoard', () => { renderBoard($('scoreboard')); $('scoreboard').classList.remove('hidden'); }, () => $('scoreboard').classList.add('hidden'));
  homeJoy();
  addEventListener('resize', () => { if (moveId === null) homeJoy(); });
  $('buyFoot').textContent = 'TAP TO BUY · TAP AGAIN TO REFUND · CLOSE WITH THE BUY BUTTON';
}
let touchKey = '';
function updateTouchUI() {
  const show = state === 'playing' && !paused;
  const p = player, C = R.charge, W = WEAPONS[p.weapon];
  const fight = show && p.alive && !buyOpen;
  const act = fight && ((R.phase === 'live' && C.carrier === p && siteAt(p.pos) >= 0) || (R.phase === 'planted' && p.team !== R.attTeam && dist2(p.pos, C.pos) < 1.6));
  if (!act && keys.KeyF) keys.KeyF = false;
  const buyBtn = R.phase === 'buy' && p.alive && show;
  const key = [show, fight, act, buyBtn, R.phase, W.scope, p.ads, !!keys.KeyC, p.smokes, p.flashes, buyOpen].join('|');
  if (key === touchKey) return;
  touchKey = key;
  TB.touch.classList.toggle('hidden', !show);
  for (const id of ['tFire', 'tFire2', 'tAds', 'tJump', 'tCrouch', 'tReload', 'tSwap']) TB[id].classList.toggle('hidden', !fight);
  TB.tSmoke.classList.toggle('hidden', !fight || p.smokes <= 0); TB.tSmoke.textContent = 'SMOKE ' + p.smokes;
  TB.tFlash.classList.toggle('hidden', !fight || p.flashes <= 0); TB.tFlash.textContent = 'FLASH ' + p.flashes;
  TB.tAct.classList.toggle('hidden', !act); TB.tAct.textContent = R.phase === 'planted' ? 'HOLD · DEFUSE' : 'HOLD · PLANT';
  TB.tBuy.classList.toggle('hidden', !buyBtn); TB.tBuy.textContent = buyOpen ? 'CLOSE' : 'BUY';
  TB.tAds.textContent = W.scope ? 'SCOPE' : 'AIM'; TB.tAds.classList.toggle('on', !!p.ads);
  TB.tCrouch.classList.toggle('on', !!keys.KeyC);
}
let installEvt = null;
function setupInstall() {
  if (IS_APP) return;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('installBtn').classList.remove('hidden'); });
  $('installBtn').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (e) {} installEvt = null; $('installBtn').classList.add('hidden'); });
  addEventListener('appinstalled', () => $('installBtn').classList.add('hidden'));
}

/* =====================================================================
   3D MODELS (glTF, meshopt-compressed; procedural fallbacks if loading fails)
   ===================================================================== */
const MODELS = {};
const VSS_S = 0.894 / 1929;          // model units -> metres (real VSS length 894 mm)
const VSS_GRIP = V3(60, 140, 0);     // pistol-grip point in model space
async function loadModels() {
  if (HEADLESS) return;
  const L = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const get = url => L.loadAsync(url).then(g => g.scene).catch(e => { console.warn('model failed', url, e); return null; });
  const [vss, car] = await Promise.all([get('assets/models/vss.glb'), get('assets/models/rusty_car.glb')]);
  if (vss) {
    vss.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; if (o.material) o.material.envMapIntensity = 1.2; } });
    MODELS.vss = vss;
  }
  if (car) {
    // drop the baked ground-shadow plane, then scale to a 5.2 m sedan sitting on y=0
    const kill = []; car.traverse(o => { if (o.isMesh && /Plane001/i.test(o.name + (o.material && o.material.name))) kill.push(o); });
    kill.forEach(o => o.removeFromParent());
    const box = new THREE.Box3().setFromObject(car), size = box.getSize(V3()), c = box.getCenter(V3());
    const s = 5.2 / size.z;
    const holder = new THREE.Group(); car.position.set(-c.x * s, -box.min.y * s, -c.z * s); car.scale.setScalar(s); holder.add(car);
    holder.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    MODELS.car = holder; MODELS.carSize = V3(size.x * s, size.y * s, size.z * s);
  }
}
// rusty car in different paint colours (tint multiplies the rust texture)
const CAR_TINTS = [0xffffff, 0x9db7dc, 0xdc9a8c, 0xa9c79b, 0xeadfc4, 0x9a9ea6];
const carMatCache = new Map();
let carTintIdx = 0;
function placeCarModel(x, z, rot) {
  const tint = CAR_TINTS[carTintIdx++ % CAR_TINTS.length];
  const g = MODELS.car.clone(true);
  g.traverse(o => {
    if (!o.isMesh || !o.material) return;
    if (/295/.test(o.material.name)) { o.material.envMapIntensity = 1.6; return; } // glass/trim keep their look
    const k = o.material.uuid + tint;
    if (!carMatCache.has(k)) { const m = o.material.clone(); m.color.multiply(new THREE.Color(tint)); m.envMapIntensity = 1.1; carMatCache.set(k, m); }
    o.material = carMatCache.get(k);
  });
  g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
  const S = MODELS.carSize;
  staticRot(x, z, S.x * 0.96, S.z * 0.96, 0, S.y * 0.92, rot, { mat: 'metal' });
}
// first-person VSS: barrel along -Z, grip at the arms' grip point
function vssViewmodel() {
  const g = new THREE.Group();
  const m = MODELS.vss.clone(true);
  m.rotation.y = -Math.PI / 2; m.scale.setScalar(VSS_S);
  m.position.set(0, -0.085 - VSS_GRIP.y * VSS_S, 0.07 - VSS_GRIP.x * VSS_S);
  g.add(m);
  addArms(g, V3(0, -0.085, 0.07), V3(-0.01, -0.045, -0.16));
  return gunEntry(g, V3(0, -0.006, -0.51), V3(0.03, 0.0, -0.01), null, V3(0.17, -0.17, -0.33), null, { scope: true });
}
// third-person: swap the bot's procedural rifle for the VSS when it carries one
function fitBotGun(model, wid) {
  if (!model || !MODELS.vss) return;
  if (!model.gunProc) model.gunProc = model.gun.children.filter(o => o.isMesh);
  const want = wid === 'sniper';
  for (const o of model.gunProc) o.visible = !want;
  if (want && !model.vss) {
    const m = MODELS.vss.clone(true);
    m.rotation.y = Math.PI / 2; m.scale.setScalar(VSS_S);
    m.position.set(0.1, -0.21 - VSS_GRIP.y * VSS_S, 0.22 + VSS_GRIP.x * VSS_S);
    model.gun.add(m); model.vss = m;
  }
  if (model.vss) model.vss.visible = want;
  model.muzzle.position.set(0.1, -0.13, want ? 0.79 : 0.9);
}

// menu backdrop: squad posed around the plaza
function menuBackdrop() {
  R.attTeam = 0;
  let i = 0;
  for (const c of combatants) placeAtSpawn(c, i++);
  bots[0].pos.set(-14, 0, -6); bots[1].pos.set(4, 0, 9); bots[2].pos.set(22, 0, 5);
  bots[0].yaw = 0.6; bots[1].yaw = Math.PI + 0.4; bots[2].yaw = Math.PI - 0.5;
  for (const b of bots) { b.model.root.position.copy(b.pos); b.model.root.rotation.y = b.yaw; animateCharacter(b.model, 0, 0, 0); b.kin.setTranslation({ x: b.pos.x, y: 0.9, z: b.pos.z }, true); }
}

/* =====================================================================
   MULTIPLAYER
   The host's browser runs the real match: rounds, economy, bots, damage, the charge.
   Every player owns their own movement, aim, buying and shooting, and reports hits
   to the host, which applies them and broadcasts the result. Messages go through the
   relay (server/relay.mjs); see net.js for the connection itself.
   ===================================================================== */
const NET = { mode: 'off', conn: null, id: 0, code: '', name: '', members: [], peerSlot: new Map(), pending: new Map(), sendT: 0, inMatch: false, busy: false, queued: false, ping: 0 };
const PUBLIC_URL = 'https://gamefile.vercel.app/'; // where invite links point when playing from the Android app
const SEND_HZ = 20;
const r2 = v => Math.round(v * 100) / 100;
const arr = v => [r2(v.x), r2(v.y), r2(v.z)];
const vec = a => V3(+a[0] || 0, +a[1] || 0, +a[2] || 0);
const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const cleanName = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').trim().slice(0, 12) || 'PLAYER';
const slotOf = c => (c && c.slot != null ? c.slot : -1);
const bySlot = s => (Number.isInteger(s) && s >= 0 && s < 8 ? SLOT[s] : null);
function netEmit(m, except) { if (NET.mode === 'host' && NET.conn) NET.conn.send((except != null ? '!' + except : '*') + '|' + JSON.stringify(m)); }
function netSend(m) { if (NET.mode === 'client' && NET.conn) NET.conn.send(JSON.stringify(m)); }
function netTo(id, m) { if (NET.mode === 'host' && NET.conn) NET.conn.send(id + '|' + JSON.stringify(m)); }
// clients measure their round trip to the host every 2s and report it in their state
setInterval(() => { if (NET.mode === 'client') netSend({ t: 'pi', c: Math.round(performance.now()) }); }, 2000);
// browsers stop requestAnimationFrame in background tabs, which would freeze an online match
// (the host simulates for everyone), so a worker-driven timer keeps stepping the game while hidden
try {
  const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 50)'], { type: 'text/javascript' })));
  ticker.onmessage = () => {
    if (!document.hidden || state !== 'playing' || NET.mode === 'off') return;
    const t = performance.now();
    let rdt = Math.min(1, (t - last) / 1000); last = t;
    while (rdt > 0.0001) { const s = Math.min(0.05, rdt); update(s); rdt -= s; }
  };
} catch (e) { console.warn('background ticker unavailable', e); }
function netShot(c, W, o, d) {
  const m = { t: 'f', s: c.slot, o: arr(o), d: [+d.x.toFixed(4), +d.y.toFixed(4), +d.z.toFixed(4)], w: W.id };
  if (NET.mode === 'host') netEmit(m); else if (NET.mode === 'client' && c === player) netSend(m);
}
// someone else's shot: visuals and sound only; damage always comes from the host
function remoteShot(c, W, o, d) {
  c.lastShot = now; c.lastShotSil = !!W.silenced;
  if (c.model) { c.model.flash.visible = true; c.model.flash.material.rotation = rand(0, TAU); c.flashT = 0.05; }
  const res = traceShot(o, d, 250, c, true, W.pen);
  const end = V3().copy(o).addScaledVector(d, res.t), mz = V3();
  if (c.model) c.model.muzzle.getWorldPosition(mz); else mz.copy(o);
  if (!W.silenced || Math.random() < 0.3) tracer(mz, end);
  if (Math.random() < 0.3) puff(mz, 0.25, 1, d.clone().multiplyScalar(0.8), 0.7);
  for (const p of res.passed) impactFX(V3().copy(o).addScaledVector(d, p.t), d, p.s, p.axis, false);
  if (res.hit) burst(end, 'hit', 4, d.clone().negate());
  else if (res.prop) { res.prop.parent()?.applyImpulseAtPoint({ x: d.x * 4, y: d.y * 4 + 0.5, z: d.z * 4 }, end, true); burst(end, 'dust', 4, d.clone().negate()); }
  else if (res.t < 250) impactFX(end, d, res.surf, res.axis, res.ground);
  const { d: ld, pan } = panFor(c.pos);
  weaponSound(W, ld, pan, false);
}
// networked characters (other humans; on clients also the host's bots) follow received states
function updateNetPuppet(c, dt) {
  if (!c.alive || !c.model) return;
  const m = c.model, n = c.net;
  if (c.flashT > 0) { c.flashT -= dt; if (c.flashT <= 0) m.flash.visible = false; }
  if (n) {
    const age = Math.min(0.2, now - n.rt), tx = n.x + n.vx * age, tz = n.z + n.vz * age;
    if (Math.hypot(tx - c.pos.x, tz - c.pos.z) > 4) c.pos.set(tx, n.y, tz);
    else { const k = 1 - Math.exp(-dt * 16); c.pos.x += (tx - c.pos.x) * k; c.pos.z += (tz - c.pos.z) * k; c.pos.y += (n.y - c.pos.y) * k; }
    c.vel.set(n.vx, 0, n.vz);
    c.yaw += angleDiff(c.yaw, n.yaw) * Math.min(1, dt * 18);
    c.aimPitch += (n.pitch - c.aimPitch) * Math.min(1, dt * 14);
  }
  if (m.gunFor !== c.weapon) { fitBotGun(m, c.weapon); m.gunFor = c.weapon; }
  const hs = Math.hypot(c.vel.x, c.vel.z), prev = c.walkPhase;
  c.walkPhase += hs * dt * 2.4;
  if (Math.floor(prev / Math.PI) !== Math.floor(c.walkPhase / Math.PI) && hs > 3.6) {
    c.noiseT = now;
    const { d, pan } = panFor(c.pos); if (d < 20) stepSound(0.2 / (1 + d / 4), pan);
  }
  m.root.position.set(c.pos.x, c.pos.y, c.pos.z);
  m.root.rotation.set(0, c.yaw, 0);
  animateCharacter(m, c.walkPhase, Math.min(1, hs / 3), c.aimPitch);
  if (c.height < 1.5) { // crouch: squat pose matching the lowered hitbox
    const sw = Math.sin(c.walkPhase) * 0.25 * Math.min(1, hs / 2);
    m.hips.position.y = 0.42; m.torso.rotation.x = 0.3; m.head.rotation.x -= 0.3;
    m.thighs[0].rotation.x = -1.35 - sw; m.thighs[1].rotation.x = -1.35 + sw;
    m.shins[0].rotation.x = m.shins[1].rotation.x = 2.25;
    for (const a of m.arms) a.rotation.x -= 0.3;
  }
}
// ---------- per-tick state ----------
function netTick(dt) {
  if (NET.mode === 'off' || !NET.inMatch || state !== 'playing') return;
  NET.sendT -= dt; if (NET.sendT > 0) return;
  NET.sendT = 1 / SEND_HZ;
  if (NET.mode === 'host') netEmit(hostSnapshot()); else netSend(clientState());
}
function hostSnapshot() {
  const C = R.charge;
  return { t: 'S', rt: r2(R.t), w: R.wins, ch: C.state === 'dropped' ? arr(C.pos) : 0,
    c: combatants.map(c => [c.slot, r2(c.pos.x), r2(c.pos.y), r2(c.pos.z), r2(c.vel.x), r2(c.vel.z), r2(c.isPlayer ? c.yaw + Math.PI : c.yaw), r2(c.isPlayer ? c.pitch : c.aimPitch),
      Math.round(c.hp), Math.round(c.armor), c.weapon, r2(c.height), c.action || 0, r2(c.isPlayer && c.action === 'defuse' ? C.defuseProg : c.actionT || 0), c.kills, c.deaths, c.credits,
      c.isPlayer ? 0 : c.ctl === 'net' && c.ping >= 0 ? c.ping : -1]) };
}
function clientState() {
  const p = player, C = R.charge;
  return { t: 's', rn: R.round, p: arr(p.pos), v: [r2(p.vel.x), r2(p.vel.z)], y: r2(p.yaw + Math.PI), pi: r2(p.pitch), h: r2(p.height), w: p.weapon,
    a: p.action || 0, at: r2(p.action === 'defuse' ? C.defuseProg : p.actionT || 0), cr: p.credits, ar: Math.round(p.armor), ms: NET.ping };
}
function applySnapshot(m) {
  R.t = num(m.rt, R.t);
  if (Array.isArray(m.w)) R.wins = [num(m.w[0]), num(m.w[1])];
  const C = R.charge;
  if (Array.isArray(m.ch) && C.state === 'dropped') { C.pos.copy(vec(m.ch)); chargeMesh.position.copy(C.pos); chargeMesh.visible = true; }
  for (const e of Array.isArray(m.c) ? m.c : []) {
    const c = bySlot(e[0]); if (!c) continue;
    if (c === player) { if (player.alive) { player.hp = num(e[8], player.hp); if (R.phase !== 'buy') player.armor = num(e[9], player.armor); } continue; }
    c.net = { x: num(e[1]), y: num(e[2]), z: num(e[3]), vx: num(e[4]), vz: num(e[5]), yaw: num(e[6]), pitch: num(e[7]), rt: now };
    c.hp = num(e[8], c.hp); c.armor = num(e[9]); if (WEAPONS[e[10]]) c.weapon = e[10]; c.height = num(e[11], 1.75);
    c.action = e[12] === 'plant' || e[12] === 'defuse' ? e[12] : null; c.actionT = num(e[13]);
    c.kills = num(e[14]); c.deaths = num(e[15]); c.credits = num(e[16]); c.ping = num(e[17], -1);
  }
}
// ---------- host side ----------
function hostOnRaw(raw) {
  const bar = raw.indexOf('|'); if (bar < 0) return;
  let m; try { m = JSON.parse(raw.slice(bar + 1)); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  const from = raw.slice(0, bar);
  try { if (from === 'S') hostOnRoom(m); else hostOnPeer(Number(from), m); } catch (e) { console.warn('net message failed', m.t, e); }
}
function teamCount(t) { return NET.members.filter(m => m.team === t).length; }
function hostOnRoom(m) {
  if (m.t === 'join') {
    const team = teamCount(0) <= teamCount(1) ? 0 : 1;
    const mem = { id: m.id, name: cleanName(m.name), team: teamCount(team) < 4 ? team : 1 - team };
    NET.members.push(mem);
    if (state === 'playing' && NET.inMatch) hostQueueJoin(mem);
    hostLobbyChanged();
  } else if (m.t === 'leave') {
    NET.members = NET.members.filter(x => x.id !== m.id);
    NET.pending.delete(m.id);
    const s = NET.peerSlot.get(m.id);
    if (s != null) { NET.peerSlot.delete(m.id); const c = SLOT[s]; if (c && c.ctl === 'net') { aiTakeover(c); if (state === 'playing') popup(c.name + ' LEFT · BOT TAKES OVER'); } }
    hostLobbyChanged();
  }
}
// someone joined during a match: reserve a bot's slot for them, handed over at the next round start
function hostQueueJoin(mem) {
  const reserved = [...NET.pending.values()];
  const humans = t => combatants.filter(c => c.team === t && c.ctl !== 'ai').length + reserved.filter(s => (s < 4 ? 0 : 1) === t).length;
  const free = t => combatants.filter(c => c.team === t && c.ctl === 'ai' && !reserved.includes(c.slot));
  let t = humans(0) <= humans(1) ? 0 : 1;
  if (!free(t).length) t = 1 - t;
  const f = free(t);
  if (!f.length) return; // no bots left to replace: they play from the next match
  NET.pending.set(mem.id, f[0].slot); mem.team = t;
  netTo(mem.id, { t: 'queued' });
}
function hostAdmitPending() {
  if (NET.mode !== 'host' || !NET.pending.size) return;
  const admitted = [];
  for (const [id, slot] of NET.pending) {
    const c = SLOT[slot], mem = NET.members.find(x => x.id === id);
    if (!c || c.ctl !== 'ai' || !mem) continue;
    const i = bots.indexOf(c); if (i >= 0) bots.splice(i, 1);
    nets.push(c);
    Object.assign(c, { ctl: 'net', peer: id, net: null, ping: -1, name: mem.name, height: 1.75, action: null });
    NET.peerSlot.set(id, slot); admitted.push(id);
    netEmit({ t: 'ren', s: slot, n: mem.name });
  }
  NET.pending.clear();
  if (!admitted.length) return;
  const ro = combatants.map(c => ({ s: c.slot, n: c.name, p: c.isPlayer ? NET.id : c.ctl === 'net' ? c.peer : -1 }));
  for (const id of admitted) netTo(id, { t: 'start', ro, cr: SLOT[NET.peerSlot.get(id)].credits });
  popup(admitted.length === 1 ? NET.members.find(x => x.id === admitted[0]).name + ' JOINED' : admitted.length + ' PLAYERS JOINED');
  hostLobbyChanged();
}
function hostOnPeer(id, m) {
  if (m.t === 'pi') { netTo(id, { t: 'po', c: m.c }); return; }
  if (m.t === 'team') {
    const me = NET.members.find(x => x.id === id), t = m.team ? 1 : 0;
    if (me && me.team !== t && teamCount(t) < 4 && state !== 'playing') { me.team = t; hostLobbyChanged(); }
    return;
  }
  const s = NET.peerSlot.get(id), c = s != null ? SLOT[s] : null;
  if (!c || c.ctl !== 'net' || state !== 'playing') return;
  const C = R.charge;
  switch (m.t) {
    case 's': {
      if (m.rn !== R.round || !c.alive || !Array.isArray(m.p) || !Array.isArray(m.v)) return; // ignore states from before this round's respawn
      c.net = { x: num(m.p[0]), y: num(m.p[1]), z: num(m.p[2]), vx: num(m.v[0]), vz: num(m.v[1]), yaw: num(m.y), pitch: num(m.pi), rt: now };
      c.height = clamp(num(m.h, 1.75), 1, 1.9); if (WEAPONS[m.w]) c.weapon = m.w;
      c.action = m.a === 'plant' || m.a === 'defuse' ? m.a : null; c.actionT = num(m.at);
      c.credits = clamp(Math.round(num(m.cr, c.credits)), 0, ECON.max);
      c.ping = clamp(Math.round(num(m.ms, -1)), -1, 9999);
      if (R.phase === 'buy') c.armor = c.armorMax = clamp(num(m.ar), 0, 50);
      break;
    }
    case 'f': {
      const W = WEAPONS[m.w];
      if (!c.alive || !W || W.melee || !Array.isArray(m.o) || !Array.isArray(m.d)) return;
      remoteShot(c, W, vec(m.o), vec(m.d).normalize());
      netEmit({ ...m, s: c.slot }, id);
      break;
    }
    case 'h': {
      const t = bySlot(m.v), dmg = num(m.dmg);
      if (!t || !c.alive || !t.alive || t.team === c.team || !(dmg > 0 && dmg <= 400)) return;
      const part = m.p === 'head' || m.p === 'leg' ? m.p : 'body';
      applyDamage(t, dmg, c, part, Array.isArray(m.d) ? vec(m.d).normalize() : null, WEAPONS[m.w] ? m.w : 'pistol', !!m.wl);
      break;
    }
    case 'g': {
      if (!c.alive || !Array.isArray(m.o) || !Array.isArray(m.d) || !Array.isArray(m.v)) return;
      const type = m.ty === 'smoke' ? 'smoke' : 'flash';
      throwUtil(c, type, vec(m.o), vec(m.d).normalize(), clamp(num(m.sp, 15), 0, 20), { x: num(m.v[0]), z: num(m.v[1]) }, true);
      netEmit({ ...m, s: c.slot, ty: type }, id);
      break;
    }
    case 'plant': {
      if (Array.isArray(m.p)) { const p = vec(m.p); if (dist2(p, c.pos) < 2.5) c.pos.copy(p); }
      if (R.phase === 'live' && c.alive && C.carrier === c && siteAt(c.pos) >= 0) plantCharge(c);
      break;
    }
    case 'defuse': {
      if (Array.isArray(m.p)) { const p = vec(m.p); if (dist2(p, c.pos) < 2.5) c.pos.copy(p); }
      if (R.phase === 'planted' && c.alive && c.team !== R.attTeam && dist2(c.pos, C.pos) < 2.2) defuseCharge(c);
      break;
    }
  }
}
// a player who disconnects mid-match hands their slot to a bot
function aiTakeover(c) {
  const i = nets.indexOf(c); if (i >= 0) nets.splice(i, 1);
  c.ctl = 'ai'; c.peer = -1; c.net = null; c.ping = -1; bots.push(c);
  const W = WEAPONS[c.weapon];
  c.loadout = { primary: W && W.slot === 'primary' ? W.id : null, side: W && W.slot === 'side' ? W.id : 'pistol' };
  if (c.loadout.primary) refill(c, c.loadout.primary);
  refill(c, c.loadout.side);
  c.weapon = c.loadout.primary || c.loadout.side;
  Object.assign(c, { path: null, goalX: undefined, target: null, targetVisible: false, task: null, thinkAt: 0, action: null, actionT: 0, burstLeft: 0, reloading: false,
    stuckCheck: now + 1.5, siteIdx: c.idx % 2, holdIdx: 0, rotated: false, rotCheck: 0, usedSmoke: true, height: 1.84 });
  c.stuckPos.copy(c.pos);
}
function hostLobbyChanged() {
  netEmit({ t: 'L', code: NET.code, m: NET.members, busy: state === 'playing' });
  renderLobby();
}
function netStartMatch() {
  const spec = [];
  for (const t of [0, 1]) {
    const ms = NET.members.filter(m => m.team === t);
    for (let i = 0; i < 4; i++) {
      const m = ms[i], slot = t * 4 + i;
      spec.push(m ? { slot, kind: m.id === NET.id ? 'me' : 'net', name: m.name, peer: m.id } : { slot, kind: 'ai' });
    }
  }
  NET.peerSlot = new Map(spec.filter(e => e.kind === 'net').map(e => [e.peer, e.slot]));
  NET.pending.clear();
  NET.inMatch = true;
  netEmit({ t: 'start', ro: spec.map(e => ({ s: e.slot, n: e.name || null, p: e.peer ?? -1 })) });
  setupRoster(spec);
  startMatch(true);
  hostLobbyChanged();
}
// ---------- client side ----------
function clientOnRaw(raw) {
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  try { clientOnMsg(m); } catch (e) { console.warn('net message failed', m.t, e); }
}
function clientOnMsg(m) {
  if (m.t === 'L') { NET.members = Array.isArray(m.m) ? m.m.map(x => ({ id: x.id, name: cleanName(x.name), team: x.team ? 1 : 0 })) : []; NET.code = String(m.code || NET.code); NET.busy = !!m.busy; renderLobby(); return; }
  if (m.t === 'start') {
    const spec = (Array.isArray(m.ro) ? m.ro : []).map(e => ({ slot: e.s, kind: e.p === NET.id ? 'me' : 'net', name: e.n ? cleanName(e.n) : null, peer: e.p }));
    if (!spec.some(e => e.kind === 'me')) return; // joined during a match: wait for the next one
    NET.inMatch = true; NET.queued = false;
    setupRoster(spec);
    startMatch(true);
    if (num(m.cr) > 0) player.credits = clamp(Math.round(m.cr), 0, ECON.max); // took over a bot mid-match: keep its money
    lock();
    return;
  }
  if (m.t === 'po') { NET.ping = clamp(Math.round(performance.now() - num(m.c)), 0, 9999); return; }
  if (m.t === 'queued') { NET.queued = true; renderLobby(); return; }
  if (m.t === 'tolobby') { NET.inMatch = false; showLobbyScreen(); return; }
  if (!NET.inMatch) return;
  switch (m.t) {
    case 'S': applySnapshot(m); break;
    case 'ren': { const c = bySlot(m.s); if (c && c !== player) c.name = cleanName(m.n); break; }
    case 'round':
      R.round = num(m.n, R.round); R.attTeam = m.att ? 1 : 0; if (Array.isArray(m.w)) R.wins = [num(m.w[0]), num(m.w[1])];
      R.halftime = !!m.half; if (R.halftime) for (const c of combatants) resetEconomy(c);
      if (state === 'playing' && Array.isArray(m.sp)) startRound(m);
      break;
    case 'live': goLive(); break;
    case 'end': endRound(m.win ? 1 : 0, String(m.why || '')); break;
    case 'over': endMatch(); break;
    case 'k': { const t = bySlot(m.v); if (t) kill(t, bySlot(m.a), !!m.h, Array.isArray(m.d) ? vec(m.d) : null, String(m.w || ''), !!m.wl); break; }
    case 'd': {
      const t = bySlot(m.v), a = bySlot(m.a); if (!t || !t.alive) break;
      t.hp = num(m.hp, t.hp); t.armor = num(m.ar, t.armor); t.tagT = now; t.lastDamage = now;
      if (t === player) { if (a) damageIndicator(a.pos); hurtSound(); hurtFlash = 0.6; buzz(35); }
      break;
    }
    case 'f': { const c = bySlot(m.s), W = WEAPONS[m.w]; if (c && c !== player && c.alive && W && !W.melee && Array.isArray(m.o) && Array.isArray(m.d)) remoteShot(c, W, vec(m.o), vec(m.d).normalize()); break; }
    case 'g': { const c = bySlot(m.s); if (c && c !== player && Array.isArray(m.o) && Array.isArray(m.d) && Array.isArray(m.v)) throwUtil(c, m.ty === 'smoke' ? 'smoke' : 'flash', vec(m.o), vec(m.d).normalize(), clamp(num(m.sp, 15), 0, 20), { x: num(m.v[0]), z: num(m.v[1]) }, true); break; }
    case 'plant': { const c = bySlot(m.s); if (c && Array.isArray(m.p)) plantCharge(c, m); break; }
    case 'pick': { const c = bySlot(m.s); if (c) pickupCharge(c); break; }
    case 'defuse': defuseCharge(); break;
    case 'boom': explodeCharge(); break;
  }
}
// ---------- connecting & lobby UI ----------
const DEFAULT_RELAY = typeof __RELAY_URL__ !== 'undefined' ? __RELAY_URL__ : '';
function prefGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function prefSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
$('lbName').value = prefGet('tollgate-name');
$('lbServer').value = prefGet('tollgate-relay') || DEFAULT_RELAY || (location.protocol === 'http:' ? `ws://${location.hostname}:8787` : '');
function relayUrl() {
  let u = $('lbServer').value.trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) u = u.replace(/^http/i, 'ws');
  else if (!/^wss?:\/\//i.test(u)) u = 'wss://' + u;
  return u;
}
function lobbyErr(msg) { $('lbErr').textContent = msg || ''; $('lbErr').classList.add('err'); }
async function netConnect(hello) {
  initAudio();
  const url = relayUrl();
  if (!url) { lobbyErr('ENTER THE RELAY SERVER ADDRESS'); return null; }
  NET.name = cleanName($('lbName').value); $('lbName').value = NET.name;
  prefSet('tollgate-name', NET.name); prefSet('tollgate-relay', $('lbServer').value.trim());
  lobbyErr('CONNECTING…');
  const btns = document.querySelectorAll('#lbConnect button');
  for (const b of btns) b.disabled = true;
  try {
    const conn = await openRelay(url, { ...hello, name: NET.name });
    lobbyErr('');
    conn.onclose = reason => netLost(reason);
    return conn;
  } catch (e) { lobbyErr(String(e.message || e).toUpperCase()); return null; }
  finally { for (const b of btns) b.disabled = false; }
}
async function hostGame() {
  const conn = await netConnect({ t: 'host' }); if (!conn) return;
  Object.assign(NET, { mode: 'host', conn, id: 0, code: conn.code, members: [{ id: 0, name: NET.name, team: 0 }], inMatch: false, busy: false });
  conn.onmessage = hostOnRaw;
  renderLobby();
}
async function joinGame() {
  const code = $('lbCode').value.toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== 4) { lobbyErr('ROOM CODES ARE 4 LETTERS'); return; }
  const conn = await netConnect({ t: 'join', code }); if (!conn) return;
  Object.assign(NET, { mode: 'client', conn, id: conn.id, code: conn.code, members: [], inMatch: false, busy: false });
  conn.onmessage = clientOnRaw;
  renderLobby();
}
function netLeave() {
  if (NET.conn) NET.conn.close();
  Object.assign(NET, { mode: 'off', conn: null, members: [], inMatch: false, busy: false, queued: false, ping: 0 });
  NET.peerSlot.clear(); NET.pending.clear();
}
function netLost(reason) {
  const inGame = state === 'playing' || state === 'ended';
  netLeave();
  if (inGame) quitToMenu();
  showLobbyScreen();
  lobbyErr(String(reason || 'DISCONNECTED').toUpperCase());
}
function quitToMenu() {
  netLeave();
  state = 'menu'; paused = false; buyOpen = false;
  if (document.pointerLockElement) document.exitPointerLock();
  for (const id of ['hud', 'pause', 'endscreen', 'scoreboard', 'buymenu', 'lobby']) $(id).classList.add('hidden');
  hud.death.classList.add('hidden'); hud.note.classList.add('hidden'); hud.spectate.classList.add('hidden');
  clearWorldForRound();
  setupRoster(SOLO_ROSTER);
  menuBackdrop();
  $('menu').classList.remove('hidden');
}
function showLobbyScreen() {
  for (const id of ['menu', 'endscreen', 'pause', 'hud', 'scoreboard', 'buymenu']) $(id).classList.add('hidden');
  hud.death.classList.add('hidden'); buyOpen = false;
  if (document.pointerLockElement) document.exitPointerLock();
  if (state === 'playing') state = 'ended';
  $('lobby').classList.remove('hidden');
  renderLobby();
}
function renderLobby() {
  const inRoom = NET.mode !== 'off';
  $('lbConnect').classList.toggle('hidden', inRoom); $('lbRoom').classList.toggle('hidden', !inRoom);
  $('lbBack').textContent = inRoom ? 'LEAVE ROOM' : 'BACK';
  if (!inRoom) return;
  $('lbCodeShow').textContent = NET.code;
  $('lbLink').value = inviteUrl();
  for (const t of [0, 1]) {
    const ol = $('lbT' + t); ol.textContent = '';
    const ms = NET.members.filter(m => m.team === t);
    for (let i = 0; i < 4; i++) {
      const m = ms[i], li = document.createElement('li');
      li.textContent = m ? m.name + (m.id === 0 ? '  ★ HOST' : '') : 'BOT · ' + BOT_NAMES[t][i];
      li.className = !m ? 'bot' : m.id === NET.id ? 'me' : '';
      ol.append(li);
    }
  }
  const host = NET.mode === 'host', humans = NET.members.length;
  $('lbStart').classList.toggle('hidden', !host || state === 'playing');
  $('lbSwap').classList.toggle('hidden', state === 'playing' && host);
  $('lbStatus').textContent = host
    ? (state === 'playing' ? 'MATCH IN PROGRESS' : `${humans} PLAYER${humans === 1 ? '' : 'S'} · EMPTY SLOTS ARE FILLED WITH BOTS`)
    : NET.queued ? 'MATCH IN PROGRESS · YOU TAKE OVER A BOT WHEN THE NEXT ROUND STARTS'
    : NET.busy ? 'MATCH IN PROGRESS · YOU JOIN THE NEXT ONE' : 'WAITING FOR THE HOST TO START';
}
// ---------- invite links: <game>/?room=ABCD opens the lobby with the code filled in ----------
function inviteUrl() {
  const web = /^https?:$/.test(location.protocol) && !IS_APP && !/^(localhost|127\.)/.test(location.hostname) ? location.origin + location.pathname : PUBLIC_URL;
  return web + '?room=' + NET.code;
}
async function shareInvite() {
  const url = inviteUrl(), btn = $('lbCopy');
  const done = t => { btn.textContent = t; setTimeout(() => { btn.textContent = 'COPY INVITE LINK'; }, 1600); };
  if (TOUCH && navigator.share) { try { await navigator.share({ title: 'Tollgate Tactical', text: `Join my Tollgate Tactical match (room ${NET.code})`, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(url); done('COPIED!'); return; } catch (e) {}
  const inp = $('lbLink'); inp.focus(); inp.select();
  try { document.execCommand('copy'); done('COPIED!'); } catch (e) { done('SELECT & COPY IT'); }
}
$('lbCopy').addEventListener('click', shareInvite);
$('lbLink').addEventListener('focus', e => e.target.select());
function openInviteFromUrl() {
  let code = '';
  try { code = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, ''); } catch (e) {}
  if (code.length !== 4) return;
  try { history.replaceState(null, '', location.pathname); } catch (e) {} // a reload shouldn't re-open the invite
  $('menu').classList.add('hidden'); $('lobby').classList.remove('hidden');
  $('lbCode').value = code;
  renderLobby();
  lobbyErr(`INVITED TO ROOM ${code} · ${$('lbName').value ? 'PRESS JOIN' : 'PICK A CALLSIGN, THEN PRESS JOIN'}`);
  $('lbErr').classList.remove('err');
  $(!$('lbName').value ? 'lbName' : 'lbJoin').focus();
}
function updateMpButtons() {
  const mp = NET.mode !== 'off', host = NET.mode === 'host';
  $('again').classList.toggle('hidden', mp && !host);
  $('toLobby').classList.toggle('hidden', !host);
  $('endLeave').classList.toggle('hidden', !mp);
  $('endWait').classList.toggle('hidden', !(mp && !host));
  $('leaveBtn').classList.toggle('hidden', !mp);
  $('pauseNote').classList.toggle('hidden', !mp);
}
$('mpBtn').addEventListener('click', () => { lobbyErr(''); $('menu').classList.add('hidden'); $('lobby').classList.remove('hidden'); renderLobby(); });
$('lbHost').addEventListener('click', hostGame);
$('lbJoin').addEventListener('click', joinGame);
$('lbCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });
$('lbStart').addEventListener('click', () => { if (NET.mode === 'host' && state !== 'playing') { netStartMatch(); lock(); } });
$('lbSwap').addEventListener('click', () => {
  const me = NET.members.find(m => m.id === NET.id); if (!me) return;
  if (NET.mode === 'host') { if (state !== 'playing' && teamCount(1 - me.team) < 4) { me.team = 1 - me.team; hostLobbyChanged(); } }
  else netSend({ t: 'team', team: 1 - me.team });
});
$('lbBack').addEventListener('click', () => {
  lobbyErr('');
  if (state !== 'menu') { quitToMenu(); return; } // left after a match: tidy the world back to the menu scene
  const was = NET.mode !== 'off'; netLeave();
  if (was) { renderLobby(); return; }
  $('lobby').classList.add('hidden'); $('menu').classList.remove('hidden');
});
$('toLobby').addEventListener('click', () => { if (NET.mode !== 'host') return; NET.inMatch = false; netEmit({ t: 'tolobby' }); showLobbyScreen(); hostLobbyChanged(); });
for (const id of ['endLeave', 'leaveBtn']) $(id).addEventListener('click', () => quitToMenu());

/* =====================================================================
   BOOT
   ===================================================================== */
setLoad('LOADING MODELS…'); await tick();
await loadModels();
setLoad('GENERATING TEXTURES…'); await tick();
buildTextures();
buildMaterials();
buildEnvironment();
initFX();
buildViewmodels();
await buildWorld();
setLoad('FINALIZING…'); await tick();
buildNav();
initSites();
buildCharge();
buildMinimapBase();
buildBuyMenu();
if (TOUCH) setupTouch();
setupInstall();
buildComposer();
applyQuality(qName);
setupRoster(SOLO_ROSTER);
menuBackdrop();
for (let i = 0; i < 90; i++) world.step();
for (const p of props) { p.obj.position.copy(p.body.translation()); p.obj.quaternion.copy(p.body.rotation()); }
if (!HEADLESS) renderer.compile(scene, camera);
state = 'menu';
$('loading').classList.add('hidden'); $('menu').classList.remove('hidden');
openInviteFromUrl();
requestAnimationFrame(frame);
window.__game = { player, bots, combatants, statics, props, ragdolls, debris, R, world, get now() { return now; } };
globalThis.__T = { startMatch, startRound, update, player, bots, combatants, R, SITES, findPath, NAV, statics, props, ragdolls, debris, glassPanes, traceShot, kill, applyDamage, smokeBlocks, curErr, popFlash, plantCharge, defuseCharge, explodeCharge, updatePlayerAction, keys, WEAPONS, losClear, throwUtil, clouds, grenades, buyItem, playerBuy, siteAt, walkable, get state() { return state; }, world, NET, SLOT, nets, get now() { return now; } };

