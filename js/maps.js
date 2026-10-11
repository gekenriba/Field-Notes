// Leaflet map helpers: base layers, record markers and density heatmaps.
/* global L */

export const TAWANG = [27.586, 91.866];

export function baseLayers() {
  return {
    Terrain: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, crossOrigin: true,
      attribution: 'Map data © OpenStreetMap contributors, SRTM | Style © OpenTopoMap (CC-BY-SA)',
    }),
    Satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, crossOrigin: true,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    }),
    Streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, crossOrigin: true, attribution: '© OpenStreetMap contributors',
    }),
  };
}

export function createMap(el, { layer = 'Terrain', controls = true } = {}) {
  const map = L.map(el, { zoomControl: controls, attributionControl: true, preferCanvas: true }).setView(TAWANG, 10);
  const layers = baseLayers();
  (layers[layer] || layers.Terrain).addTo(map);
  if (controls) {
    L.control.layers(layers, null, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
  }
  return map;
}

// Heat colours from cool to hot, tuned to read over both terrain and satellite tiles.
const GRADIENT = { 0.2: '#2c7fb8', 0.4: '#41b6c4', 0.6: '#a1dab4', 0.75: '#fed976', 0.9: '#fd8d3c', 1: '#e31a1c' };

export function heatLayer(points) {
  return L.heatLayer(points.map((p) => [p.lat, p.lng, 1]), {
    radius: 28, blur: 22, maxZoom: 13, minOpacity: 0.35, max: 1, gradient: GRADIENT,
  });
}

export function pointsLayer(entries, { onOpen, thumbs } = {}) {
  const group = L.featureGroup();
  for (const e of entries) {
    if (e.lat == null || e.lng == null) continue;
    const draft = e.status === 'draft';
    const m = L.circleMarker([e.lat, e.lng], {
      radius: 7, weight: 2, color: '#fff', fillOpacity: 0.95,
      fillColor: draft ? '#d4892a' : '#1f6b4a',
    });
    const div = document.createElement('div');
    div.className = 'map-pop';
    const t = thumbs?.get(e.id);
    div.innerHTML = `${t ? `<img src="${t}" alt="">` : ''}<div><strong class="${e.scientificName ? 'sci' : ''}"></strong><small></small></div>`;
    div.querySelector('strong').textContent = e.scientificName || e.fieldLabel || 'Unidentified';
    div.querySelector('small').textContent = [e.date, e.altitude != null ? `${e.altitude} m` : null].filter(Boolean).join(' · ');
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
