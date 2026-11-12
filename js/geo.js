// GPS fix, elevation fallback and place-name lookup.

// Watch position for up to `maxMs`, keeping the most accurate fix. Resolves early once
// accuracy is good enough. Mountain terrain often gives a poor first fix, so this helps.
export function getBestFix(opts = {}) {
  if (window.Capacitor?.getPlatform?.() === 'ios') return iosBestFix(opts);
  return webBestFix(opts);
}

const toFix = (c) => ({
  lat: +c.latitude.toFixed(6),
  lng: +c.longitude.toFixed(6),
  accuracy: Math.round(c.accuracy),
  altitude: c.altitude != null && (c.altitudeAccuracy == null || c.altitudeAccuracy > 0) ? Math.round(c.altitude) : null,
  altitudeAccuracy: c.altitudeAccuracy != null && c.altitudeAccuracy > 0 ? Math.round(c.altitudeAccuracy) : null,
});

// iPhone app: Capacitor's Geolocation plugin (Core Location), polled until the fix is good enough.
async function iosBestFix({ maxMs = 15000, goodEnough = 15, onUpdate } = {}) {
  const cap = window.Capacitor;
  let perm = await cap.nativePromise('Geolocation', 'checkPermissions', {}).catch(() => ({}));
  if (perm.location !== 'granted') perm = await cap.nativePromise('Geolocation', 'requestPermissions', { permissions: ['location'] }).catch((e) => ({ error: e }));
  if (perm.error && /disabled/i.test(perm.error.message || '')) throw new Error('Location Services are off. Turn them on in Settings › Privacy & Security.');
  if (perm.location === 'denied') throw new Error('Location permission denied. Allow it in Settings › Field Notes › Location.');
  const end = Date.now() + maxMs;
  let best = null, lastErr = null;
  while (Date.now() < end) {
    const left = end - Date.now();
    try {
      const pos = await Promise.race([
        cap.nativePromise('Geolocation', 'getCurrentPosition', { enableHighAccuracy: true, timeout: left, maximumAge: 0 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), left)),
      ]);
      const fix = toFix(pos.coords);
      if (!best || fix.accuracy < best.accuracy) { best = fix; onUpdate?.(best); }
      if (fix.accuracy <= goodEnough) break;
    } catch (e) {
      lastErr = e;
      if (/denied|permission/i.test(e.message || '')) throw new Error('Location permission denied. Allow it in Settings › Field Notes › Location.');
      if (e.message === 'timeout') break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (best) return best;
  throw new Error(lastErr && lastErr.message !== 'timeout' ? `GPS: ${lastErr.message}` : 'Could not get a GPS fix. Try again in the open sky.');
}

function webBestFix({ maxMs = 15000, goodEnough = 15, onUpdate } = {}) {
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

// Nearest named place and current district from OpenStreetMap (Nominatim).
export async function placeName(lat, lng) {
  const j = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&accept-language=en&lat=${lat}&lon=${lng}`);
  const a = j?.address || {};
  const local = [a.village || a.hamlet || a.isolated_dwelling || a.locality || a.suburb, a.town || a.city || a.municipality || a.county_town].filter(Boolean);
  const district = String(a.state_district || a.county || '').replace(/\s+district$/i, '').trim();
  const name = [...new Set(local)].join(', ') || (j?.name || '');
  return { name, district: /arunachal/i.test(a.state || '') ? district : '' , state: a.state || '' };
}

export function formatCoord(lat, lng) {
  if (lat == null || lng == null) return 'not reported';
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(5)}° ${lng >= 0 ? 'E' : 'W'}`;
}
