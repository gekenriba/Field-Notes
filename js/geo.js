// GPS fix, elevation fallback and place-name lookup.

// Watch position for up to `maxMs`, keeping the most accurate fix. Resolves early once
// accuracy is good enough. Mountain terrain often gives a poor first fix, so this helps.
export function getBestFix({ maxMs = 15000, goodEnough = 15, onUpdate } = {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('GPS is not available on this device.'));
    let best = null;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      if (best) resolve(best); else reject(err || new Error('Could not get a GPS fix. Try again in the open sky.'));
    };
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        const fix = {
          lat: +c.latitude.toFixed(6),
          lng: +c.longitude.toFixed(6),
          accuracy: Math.round(c.accuracy),
          altitude: c.altitude != null ? Math.round(c.altitude) : null,
          altitudeAccuracy: c.altitudeAccuracy != null ? Math.round(c.altitudeAccuracy) : null,
        };
        if (!best || fix.accuracy < best.accuracy) { best = fix; onUpdate?.(best); }
        if (fix.accuracy <= goodEnough) finish();
      },
      (err) => {
        const msg = err.code === 1 ? 'Location permission denied. Allow location for this site in browser settings.'
          : 'GPS signal unavailable.';
        finish(new Error(msg));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: maxMs }
    );
    const timer = setTimeout(() => finish(), maxMs);
  });
}

async function fetchJSON(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Terrain elevation from a digital elevation model (Copernicus 90 m via Open-Meteo).
export async function demElevation(lat, lng) {
  const j = await fetchJSON(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
  const e = j?.elevation?.[0];
  return Number.isFinite(e) ? Math.round(e) : null;
}

// Nearest named place from OpenStreetMap (Nominatim). Used only to pre-fill an empty locality.
export async function placeName(lat, lng) {
  const j = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lng}`);
  const a = j?.address || {};
  const parts = [a.village || a.hamlet || a.locality || a.suburb || a.town || a.city, a.county || a.state_district, a.state]
    .filter(Boolean);
  return [...new Set(parts)].join(', ') || j?.display_name || '';
}

export function formatCoord(lat, lng) {
  if (lat == null || lng == null) return 'not reported';
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(5)}° ${lng >= 0 ? 'E' : 'W'}`;
}
