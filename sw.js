// Field Notes service worker (browser only): keeps the app working offline. Map tiles are cached by js/maps.js.
const VERSION = 'fn-v2.1.0';
const SHELL = `${VERSION}-shell`;
const TILES = 'fn-tiles';   // filled by js/maps.js; kept across updates

const ASSETS = [
  './', 'index.html', 'manifest.webmanifest',
  'css/app.css',
  'js/app.js', 'js/native.js', 'js/db.js', 'js/media.js', 'js/geo.js', 'js/taxon.js', 'js/maps.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/leaflet-heat.js',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-shadow.png',
  'vendor/fonts/fraunces-latin-400-normal.woff2', 'vendor/fonts/fraunces-latin-400-italic.woff2',
  'vendor/fonts/fraunces-latin-600-normal.woff2', 'vendor/fonts/fraunces-latin-600-italic.woff2',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== TILES) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App shell: stale-while-revalidate for same-origin files.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      if (hit) { event.waitUntil(net); return hit; }
      const res = await net;
      if (res) return res;
      if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      return Response.error();
    })());
  }
  // Everything else (tiles, GBIF, iNaturalist, Wikipedia, elevation) goes to the network; the app caches those itself.
});
