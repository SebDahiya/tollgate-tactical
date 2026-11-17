// Offline cache for the installed web app. the cache name is stamped at build time so each deploy refreshes the cache.
const CACHE = 'tollgate-__BUILD__';
const PRECACHE = ['./', './index.html', './game.js', './manifest.webmanifest', './assets/sky_bridge_1k.hdr', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const put = r => { if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return r; };
  if (req.mode === 'navigate') { e.respondWith(fetch(req).then(put).catch(() => caches.match('./index.html'))); return; }
  if (url.origin === location.origin || url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com')) {
    e.respondWith(caches.match(req).then(m => m || fetch(req).then(put)));
  }
});
