// Leaflet map helpers: base layers, record markers and density heatmaps.
/* global L */
import { ContourLayer } from './contours.js';

export const TAWANG = [27.586, 91.866];

// Leaflet.heat 0.2 keeps redrawing after its map is removed (pending animation frames, zoom
// animations), which throws once the map's panes are gone. Guard those paths.
if (L.HeatLayer && !L.HeatLayer.prototype._fnGuarded) {
  const P = L.HeatLayer.prototype;
  for (const fn of ['_reset', '_redraw', '_animateZoom']) {
    const orig = P[fn];
    P[fn] = function (...args) { if (!this._map || !this._map._mapPane || !this._map._loaded) { this._frame = null; return undefined; } return orig.apply(this, args); };
  }
  const rm = P.onRemove;
  P.onRemove = function (map) { if (this._frame) { L.Util.cancelAnimFrame(this._frame); this._frame = null; } rm.call(this, map); this._map = null; };
  P._fnGuarded = true;
}

// ---- Offline tile cache ----
// Every tile shown is stored with the Cache API, so areas you have looked at while online
// still display in the field without signal. Works in the browser and in the Android app.
const TILE_CACHE = 'fn-tiles';
const MAX_TILES = 8000;
let cachePromise = null;
const tileCache = () => (cachePromise ||= ('caches' in window ? caches.open(TILE_CACHE).catch(() => null) : Promise.resolve(null)));

async function trimTileCache() {
  const c = await tileCache(); if (!c) return;
  const keys = await c.keys();
  if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) await c.delete(k);
}

async function tileSource(url) {
  const c = await tileCache();
  if (!c) return { src: url };
  try {
    const hit = await c.match(url);
    if (hit) return { src: URL.createObjectURL(await hit.blob()), blob: true };
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return { src: url };
    c.put(url, res.clone()).then(() => { if (Math.random() < 0.02) trimTileCache(); }).catch(() => {});
    return { src: URL.createObjectURL(await res.blob()), blob: true };
  } catch {
    return { src: url };   // offline and not cached, or tile server without CORS: let <img> try directly
  }
}

const CachedTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement('img');
    tile.alt = '';
    tile.setAttribute('role', 'presentation');
    L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
    L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, done, tile));
    tileSource(this.getTileUrl(coords)).then(({ src, blob }) => {
      if (blob) tile.dataset.blob = '1';
      tile.src = src;
    });
    return tile;
  },
  onAdd(map) {
    this.on('tileunload', (e) => { if (e.tile.dataset.blob) URL.revokeObjectURL(e.tile.src); });
    return L.TileLayer.prototype.onAdd.call(this, map);
  },
});
const tileLayer = (url, opts) => new CachedTileLayer(url, opts);

const ESRI_GRAY = 'Base map © Esri, HERE, Garmin, © OpenStreetMap contributors';

// Three base styles. "Minimal" is a quiet grey base with contour lines and soft relief on top.
export const STYLES = {
  Minimal:   { label: 'Minimal', contours: true, relief: true, labels: true },
  Satellite: { label: 'Satellite', contours: false, boundaries: true },
  Topo:      { label: 'Topographic' },
};

function baseTiles(style) {
  if (style === 'Satellite') return tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' });
  if (style === 'Topo') return tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, attribution: 'Map data © OpenStreetMap contributors, SRTM | Style © OpenTopoMap (CC-BY-SA)' });
  // Esri light grey canvas: quiet, no key needed (CARTO now watermarks requests from apps).
  return tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 16, maxZoom: 19, attribution: ESRI_GRAY, className: 'tiles-minimal' });
}

// ---- Administrative boundaries (DataMeet, CC BY 4.0 / CC BY 2.5 IN) ----
let boundaryData = null;
async function loadBoundaries() {
  if (!boundaryData) boundaryData = Promise.all(['assets/geo/india-states.json', 'assets/geo/india-districts.json', 'assets/geo/arunachal-districts.json']
    .map((u) => fetch(u).then((r) => r.json())));
  return boundaryData;
}
const BOUNDARY_ATTR = 'Boundaries: <a href="https://github.com/datameet/maps" target="_blank" rel="noopener">DataMeet</a> (states; districts as of Census 2011)';

export function boundariesLayer(map, { onSatellite = true } = {}) {
  const group = L.layerGroup();
  group.getAttribution = () => BOUNDARY_ATTR;
  const stroke = onSatellite ? { state: '#FFFFFF', dist: 'rgba(255,255,255,.75)', label: 'light' } : { state: '#41505A', dist: 'rgba(65,80,90,.55)', label: 'dark' };
  loadBoundaries().then(([states, india, arunachal]) => {
    const pane = map.getPane('boundaries') || map.createPane('boundaries');
    pane.style.zIndex = 390; pane.style.pointerEvents = 'none';
    const districtStyle = { pane: 'boundaries', color: stroke.dist, weight: 0.8, dashArray: '4 4', fill: false, interactive: false };
    L.geoJSON(india, { style: districtStyle }).addTo(group);
    const ar = L.geoJSON(arunachal, { style: { ...districtStyle, weight: 1.1 } }).addTo(group);
    L.geoJSON(states, { style: { pane: 'boundaries', color: stroke.state, weight: 1.8, opacity: 0.9, fill: false, interactive: false } }).addTo(group);
    // District names inside Arunachal Pradesh, shown from zoom 8.
    const labels = L.layerGroup();
    ar.eachLayer((l) => {
      const name = l.feature.properties.DISTRICT;
      const c = l.getBounds().getCenter();
      L.marker(c, { pane: 'boundaries', interactive: false, icon: L.divIcon({ className: `district-label ${stroke.label}`, html: name, iconSize: null }) }).addTo(labels);
    });
    const sync = () => { if (map.getZoom() >= 8) group.addLayer(labels); else group.removeLayer(labels); };
    map.on('zoomend', sync); sync();
  }).catch((e) => console.warn('boundaries', e));
  return group;
}

// Map with a small style switcher. Returns the Leaflet map; map.fnSetStyle(name) switches style.
export function createMap(el, { style = 'Minimal', controls = true, contours, boundaries, onStyle } = {}) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, preferCanvas: true, zoomSnap: 0.5, maxZoom: 18 }).setView(TAWANG, 10);
  if (controls) L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  map.attributionControl.setPrefix(false);
  const state = { base: null, contour: null, labels: null, bounds: null, style: null };
  const setStyle = (name) => {
    const st = STYLES[name] ? name : 'Minimal';
    const cfg = STYLES[st];
    for (const k of ['base', 'contour', 'labels', 'bounds']) if (state[k]) { map.removeLayer(state[k]); state[k] = null; }
    state.base = baseTiles(st).addTo(map);
    const wantContours = contours ?? cfg.contours;
    if (wantContours) state.contour = new ContourLayer({ relief: cfg.relief, light: st === 'Satellite', pane: 'overlayPane' }).addTo(map);
    if (cfg.labels) {
      const pane = map.getPane('labels') || map.createPane('labels');
      pane.style.zIndex = 450; pane.style.pointerEvents = 'none';
      state.labels = tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 19, pane: 'labels', attribution: '' }).addTo(map);
    }
    if (boundaries ?? cfg.boundaries) state.bounds = boundariesLayer(map, { onSatellite: st === 'Satellite' }).addTo(map);
    state.style = st;
    el.dataset.style = st;
    onStyle?.(st);
  };
  map.fnSetStyle = setStyle;
  map.fnState = state;
  map.fnToggle = (what, on) => {
    if (what === 'contours') {
      if (state.contour) { map.removeLayer(state.contour); state.contour = null; }
      if (on) state.contour = new ContourLayer({ relief: STYLES[state.style].relief, light: state.style === 'Satellite' }).addTo(map);
    }
    if (what === 'boundaries') {
      if (state.bounds) { map.removeLayer(state.bounds); state.bounds = null; }
      if (on) state.bounds = boundariesLayer(map, { onSatellite: state.style === 'Satellite' }).addTo(map);
    }
  };
  setStyle(style);
  return map;
}

// Density of records: one warm hue family from pale to deep, readable on grey and satellite.
const GRADIENT = { 0.25: '#FFE9A8', 0.5: '#F7B24A', 0.75: '#E0622A', 1: '#A3201C' };

// Heat is only drawn for observed, identified plants; drafts and other organisms stay as points.
export const heatEligible = (e) => e.lat != null && e.lng != null && e.status === 'identified' && !!e.scientificName
  && (e.group === 'Plant' || e.group === 'Bryophyte' || !e.group);

export function heatLayer(points) {
  return L.heatLayer(points.filter(heatEligible).map((p) => [p.lat, p.lng, Math.max(1, Math.min(4, Math.log2((p.population || 1) + 1)))]), {
    radius: 26, blur: 20, maxZoom: 13, minOpacity: 0.3, max: 3, gradient: GRADIENT,
  });
}

export function pointsLayer(entries, { onOpen, thumbs } = {}) {
  const group = L.featureGroup();
  for (const e of entries) {
    if (e.lat == null || e.lng == null) continue;
    const draft = e.status === 'draft';
    const m = L.circleMarker([e.lat, e.lng], {
      radius: draft ? 6 : 6.5, weight: 2, color: '#fff', fillOpacity: 1,
      fillColor: draft ? '#C98A12' : '#1B5E50', className: 'rec-dot',
    });
    const div = document.createElement('div');
    div.className = 'map-pop';
    const t = thumbs?.get(e.id);
    div.innerHTML = `${t ? `<img src="${t}" alt="">` : ''}<div><strong class="${e.scientificName ? 'sci' : ''}"></strong><small></small></div>`;
    div.querySelector('strong').textContent = e.scientificName || e.fieldLabel || 'Unidentified';
    div.querySelector('small').textContent = [e.date, e.altitude != null ? `${e.altitude} m` : null].filter(Boolean).join(', ');
    div.addEventListener('click', () => onOpen?.(e.id));
    m.bindPopup(div, { closeButton: false, minWidth: 180 });
    m.addTo(group);
  }
  return group;
}

export function fitTo(map, entries, maxZoom = 13) {
  const pts = entries.filter((e) => e.lat != null && e.lng != null).map((e) => [e.lat, e.lng]);
  if (!pts.length) { map.setView(TAWANG, 10); return; }
  if (pts.length === 1) { map.setView(pts[0], maxZoom, { animate: false }); return; }
  map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom, animate: false });
}
