// Field Notes service worker: app works fully offline; viewed map tiles are cached for the field.
const VERSION = 'fn-v2.0.0';
const SHELL = `${VERSION}-shell`;
const TILES = 'fn-tiles';
const MAX_TILES = 6000;

const ASSETS = [
  './', 'index.html', 'manifest.webmanifest',
  'css/app.css',
  'js/app.js', 'js/db.js', 'js/media.js', 'js/geo.js', 'js/taxon.js', 'js/maps.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/leaflet-heat.js',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-shadow.png',
  'vendor/fonts/fraunces-latin-400-normal.woff2', 'vendor/fonts/fraunces-latin-400-italic.woff2',
  'vendor/fonts/fraunces-latin-600-normal.woff2', 'vendor/fonts/fraunces-latin-600-italic.woff2',
  'icons/icon-192.png', 'icons/icon-512.png',
];

const TILE_HOSTS = ['tile.opentopomap.org', 'server.arcgisonline.com', 'tile.openstreetmap.org'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== TILES) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(k);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: cache-first so previously viewed areas work without signal.
  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    event.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()); if (Math.random() < 0.02) trimTiles(); }
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

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
  // Everything else (GBIF, iNaturalist, Wikipedia, elevation) goes to the network; the app caches lookups itself.
});
