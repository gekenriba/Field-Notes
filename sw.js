// Field Notes service worker (browser only): keeps the app working offline. Map tiles are cached by js/maps.js.
const VERSION = 'fn-v3.0.0';
const SHELL = `${VERSION}-shell`;
const TILES = 'fn-tiles';   // filled by js/maps.js; kept across updates

const ASSETS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "js/app.js",
  "js/backup.js",
  "js/contours.js",
  "js/db.js",
  "js/familyIcons.js",
  "js/geo.js",
  "js/ident.js",
  "js/maps.js",
  "js/media.js",
  "js/morph.js",
  "js/native.js",
  "js/phenology.js",
  "js/taxon.js",
  "js/ui.js",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/leaflet.css",
  "vendor/leaflet-heat.js",
  "vendor/fflate.js",
  "vendor/leaflet/images/layers.png",
  "vendor/leaflet/images/layers-2x.png",
  "vendor/leaflet/images/marker-icon.png",
  "vendor/leaflet/images/marker-shadow.png",
  "vendor/fonts/fraunces-latin-400-italic.woff2",
  "vendor/fonts/fraunces-latin-400-normal.woff2",
  "vendor/fonts/fraunces-latin-600-italic.woff2",
  "vendor/fonts/fraunces-latin-600-normal.woff2",
  "vendor/fonts/instrument-sans-latin-400-normal.woff2",
  "vendor/fonts/instrument-sans-latin-500-normal.woff2",
  "vendor/fonts/instrument-sans-latin-600-normal.woff2",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "assets/geo/arunachal-districts.json",
  "assets/geo/india-districts.json",
  "assets/geo/india-states.json",
  "assets/hero/credits.json",
  "assets/hero/aconitum-ferox-1.jpg",
  "assets/hero/bergenia-ciliata-1.jpg",
  "assets/hero/dactylorhiza-hatagirea-2.jpg",
  "assets/hero/fritillaria-cirrhosa-3.jpg",
  "assets/hero/meconopsis-horridula-3.jpg",
  "assets/hero/nardostachys-jatamansi-3.jpg",
  "assets/hero/paris-polyphylla-2.jpg",
  "assets/hero/rheum-nobile-2.jpg",
  "assets/hero/rhododendron-anthopogon-0.jpg",
  "assets/hero/saussurea-obvallata-1.jpg",
  "assets/hero/sinopodophyllum-hexandrum-1.jpg",
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
