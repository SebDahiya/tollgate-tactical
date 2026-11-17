// Bundles src/game.js (three.js + Rapier included, no CDN) and assembles www/ for Vercel and the Android app.
import * as esbuild from 'esbuild';
import fs from 'fs';
const out = 'www';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();
// multiplayer relay the game connects to by default (override with RELAY_URL)
await esbuild.build({ entryPoints: ['src/game.js'], bundle: true, format: 'esm', target: 'es2022', minify: true, legalComments: 'none', outfile: `${out}/game.js`, logLevel: 'warning',
  define: { __RELAY_URL__: JSON.stringify(process.env.RELAY_URL || 'wss://tollgate-tactical-production.up.railway.app') } });
fs.cpSync('public', out, { recursive: true });
fs.copyFileSync('src/index.html', `${out}/index.html`);
fs.writeFileSync(`${out}/sw.js`, fs.readFileSync('public/sw.js', 'utf8').replaceAll('__BUILD__', String(Date.now())));
const kb = f => (fs.statSync(`${out}/${f}`).size / 1024).toFixed(0) + ' KB';
console.log(`built www/ in ${Date.now() - t0} ms  (game.js ${kb('game.js')}, index.html ${kb('index.html')})`);
