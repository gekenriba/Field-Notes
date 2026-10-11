// Location from a Google Maps link or pasted coordinates, and district lookup.

import { http, isNative } from './native.js';

// Arunachal Pradesh, generous bounding box (used only to warn about likely mistakes).
export const ARUNACHAL_BOUNDS = { s: 26.5, n: 29.6, w: 91.4, e: 97.5 };
export const ARUNACHAL_CENTER = [28.05, 94.3];
export const inArunachalBox = (lat, lng) => lat >= ARUNACHAL_BOUNDS.s && lat <= ARUNACHAL_BOUNDS.n && lng >= ARUNACHAL_BOUNDS.w && lng <= ARUNACHAL_BOUNDS.e;

const num = '([+-]?\\d{1,3}(?:\\.\\d+)?)';
const valid = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
const round = (x) => Math.round(x * 1e6) / 1e6;

function dmsToDec(d, m, s, hemi) {
  let v = (+d) + (+m || 0) / 60 + (+s || 0) / 3600;
  if (/[SW]/i.test(hemi)) v = -v;
  return v;
}

/**
 * Finds coordinates in a Google Maps URL or in plain text. Returns { lat, lng, how } or null.
 * Handles: …/@27.58,91.86,15z  …!3d27.58!4d91.86  ?q=27.58,91.86  ll= / center= / destination=
 *          /maps/search/27.58,+91.86  geo:27.58,91.86  "27.58, 91.86"  27°35'10.2"N 91°52'00.0"E
 */
export function parseCoordinates(input) {
  if (!input) return null;
  let s = String(input).trim();
  try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch { /* keep raw */ }
  let m;
  // Exact place pin (more precise than the map centre in @lat,lng)
  if ((m = s.match(new RegExp(`!3d${num}!4d${num}`)))) { const [lat, lng] = [+m[1], +m[2]]; if (valid(lat, lng)) return { lat: round(lat), lng: round(lng), how: 'pin in link' }; }
  for (const key of ['q', 'query', 'll', 'sll', 'center', 'destination', 'daddr', 'saddr', 'viewpoint']) {
    if ((m = s.match(new RegExp(`[?&]${key}=(?:loc:)?\\s*${num}\\s*,\\s*${num}`)))) { const [lat, lng] = [+m[1], +m[2]]; if (valid(lat, lng)) return { lat: round(lat), lng: round(lng), how: `${key}= in link` }; }
  }
  if ((m = s.match(new RegExp(`/(?:search|place|dir)/\\s*${num}\\s*,\\s*${num}`)))) { const [lat, lng] = [+m[1], +m[2]]; if (valid(lat, lng)) return { lat: round(lat), lng: round(lng), how: 'place in link' }; }
  // Degrees, minutes, seconds (Google shows pins like 27°35'10.2"N 91°52'00.0"E)
  const dms = /(\d{1,3})\s*[°º]\s*(\d{1,2})?\s*['′’]?\s*(\d{1,2}(?:\.\d+)?)?\s*["″”]?\s*([NS])[\s,;]+(\d{1,3})\s*[°º]\s*(\d{1,2})?\s*['′’]?\s*(\d{1,2}(?:\.\d+)?)?\s*["″”]?\s*([EW])/i;
  if ((m = s.match(dms))) { const lat = dmsToDec(m[1], m[2], m[3], m[4]), lng = dmsToDec(m[5], m[6], m[7], m[8]); if (valid(lat, lng)) return { lat: round(lat), lng: round(lng), how: 'degrees, minutes, seconds' }; }
  if ((m = s.match(new RegExp(`@${num},${num}`)))) { const [lat, lng] = [+m[1], +m[2]]; if (valid(lat, lng)) return { lat: round(lat), lng: round(lng), how: 'map centre in link' }; }
  if ((m = s.match(new RegExp(`geo:${num},${num}`)))) { const [lat, lng] = [+m[1], +m[2]]; if (valid(lat, lng)) return { lat: round(lat), lng: round(lng), how: 'geo link' }; }
  // Decimal with hemisphere letters: 27.586 N, 91.866 E
  if ((m = s.match(/(\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])[\s,;]+(\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])/i))) {
    const lat = (+m[1]) * (/S/i.test(m[2]) ? -1 : 1), lng = (+m[3]) * (/W/i.test(m[4]) ? -1 : 1);
    if (valid(lat, lng)) return { lat: round(lat), lng: round(lng), how: 'decimal degrees' };
  }
  // Plain "lat, lng" (only when the whole input is just the pair)
  if ((m = s.match(new RegExp(`^\\s*${num}\\s*[,;\\s]\\s*${num}\\s*$`)))) { const [lat, lng] = [+m[1], +m[2]]; if (valid(lat, lng)) return { lat: round(lat), lng: round(lng), how: 'coordinates' }; }
  return null;
}

const isShortLink = (s) => /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|maps\.google\.[a-z.]+\/\?cid=)/i.test(s.trim());
const findUrl = (s) => (String(s).match(/https?:\/\/[^\s<>"']+/) || [])[0] || '';

/**
 * Accepts anything the user pasted (a shared "Place · Google Maps https://maps.app.goo.gl/…"
 * text, a long link or coordinates) and returns { lat, lng, how, url } or throws a helpful error.
 */
export async function locationFromInput(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Paste a Google Maps link or coordinates first.');
  const direct = parseCoordinates(text);
  if (direct) return { ...direct, url: findUrl(text) || null };
  const url = findUrl(text);
  if (!url) throw new Error('No coordinates or link found. In Google Maps, drop a pin, tap Share and copy the link, or copy the coordinates.');
  if (!isNative() && isShortLink(url)) throw new Error('Short links can only be opened in the Android app. In the browser, open the link and paste the full address from the address bar.');
  // Follow the short link (and any consent page) to the full Maps URL.
  let r;
  try { r = await http(url, { responseType: 'text', timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36', 'Accept-Language': 'en' } }); }
  catch (e) { throw new Error(`Couldn’t open the link (${e.message || e}). Check the internet connection.`); }
  let final = r.url || url;
  const cont = final.match(/[?&]continue=([^&]+)/);
  if (cont) { try { final = decodeURIComponent(cont[1]); } catch { /* keep */ } }
  const fromUrl = parseCoordinates(final);
  if (fromUrl) return { ...fromUrl, url };
  // Some pages keep the coordinates only in the HTML (meta tags or preview image URLs).
  const html = typeof r.data === 'string' ? r.data : '';
  const m = html.match(/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/) || html.match(/markers=(-?\d+\.\d+)%2C(-?\d+\.\d+)/) || html.match(/\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/);
  if (m && valid(+m[1], +m[2])) return { lat: round(+m[1]), lng: round(+m[2]), how: 'link page', url };
  const fromHtml = parseCoordinates(html.slice(0, 200000));
  if (fromHtml) return { ...fromHtml, url };
  throw new Error('The link opened but had no coordinates (it may point to a named place without a pin). Drop a pin at the exact spot, then share that link.');
}

// ---------- districts (Census 2011 boundaries, offline) ----------
let districts = null;
async function loadDistricts() {
  if (!districts) districts = fetch('assets/geo/arunachal-districts.json').then((r) => r.json()).catch(() => null);
  return districts;
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inGeometry(lng, lat, g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some((p) => inRing(lng, lat, p[0]) && !p.slice(1).some((h) => inRing(lng, lat, h)));
}
// District name from the 2011 boundaries (offline). Districts created after 2011 aren't in this data.
export async function district2011(lat, lng) {
  const d = await loadDistricts();
  if (!d) return null;
  const f = d.features.find((x) => inGeometry(lng, lat, x.geometry));
  return f ? f.properties.DISTRICT : null;
}
