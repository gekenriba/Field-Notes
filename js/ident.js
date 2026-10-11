// Plant identification suggestions from Pl@ntNet (https://my.plantnet.org).
// Needs a free personal API key (500 identifications a day). Suggestions are labelled with their
// score and source and are never saved as an identification unless the user picks one.

import { getMeta, setMeta } from './db.js';

const API = 'https://my-api.plantnet.org/v2/identify/all';
const GBIF = 'https://api.gbif.org/v1';

let settings = { key: '', live: true };
export async function loadIdentSettings() {
  settings = { ...settings, ...(await getMeta('ident', {})) };
  return settings;
}
export async function saveIdentSettings(patch) {
  settings = { ...settings, ...patch };
  await setMeta('ident', settings);
  return settings;
}
export const identReady = () => !!settings.key && navigator.onLine;
export const identSettings = () => settings;

// Daily usage counter so live scanning can't burn through the free quota.
const LIVE_DAILY_CAP = 300;
async function usage() {
  const u = await getMeta('identUsage', {});
  const today = new Date().toISOString().slice(0, 10);
  return u.day === today ? u : { day: today, used: 0, remaining: null };
}
async function recordUsage(remaining) {
  const u = await usage();
  u.used += 1;
  if (remaining != null) u.remaining = remaining;
  await setMeta('identUsage', u);
  return u;
}
export async function usageToday() { return usage(); }
export async function liveBudgetLeft() {
  const u = await usage();
  if (u.remaining != null && u.remaining < 30) return false;   // keep some for entries
  return u.used < LIVE_DAILY_CAP;
}

export class IdentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * images: [{ blob, organ: 'flower'|'leaf'|'fruit'|'bark'|'auto' }] (max 5)
 * returns { species: [...], genera: [...], families: [...], organs, remaining }
 */
export async function identify(images, { detailed = false, results = 6, signal } = {}) {
  if (!settings.key) throw new IdentError('nokey', 'Add your free Pl@ntNet API key in Settings to get suggestions.');
  if (!navigator.onLine) throw new IdentError('offline', 'Suggestions need an internet connection.');
  const fd = new FormData();
  for (const im of images.slice(0, 5)) {
    fd.append('images', new File([im.blob], 'photo.jpg', { type: im.blob.type || 'image/jpeg' }));
    fd.append('organs', im.organ || 'auto');
  }
  const url = `${API}?api-key=${encodeURIComponent(settings.key)}&nb-results=${results}&lang=en&include-related-images=false${detailed ? '&detailed=true' : ''}`;
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: fd, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new IdentError('network', 'Could not reach Pl@ntNet.');
  }
  if (res.status === 404) { await recordUsage(null); return { species: [], genera: [], families: [], organs: [], remaining: null, notPlant: true }; }
  if (res.status === 401 || res.status === 403) throw new IdentError('key', 'Pl@ntNet did not accept the API key. Check it in Settings.');
  if (res.status === 429) throw new IdentError('quota', 'Daily Pl@ntNet limit reached. Suggestions resume tomorrow.');
  if (!res.ok) throw new IdentError('http', `Pl@ntNet error ${res.status}.`);
  const j = await res.json();
  await recordUsage(j.remainingIdentificationRequests ?? null);
  const species = (j.results || []).map((r) => ({
    name: r.species?.scientificNameWithoutAuthor,
    author: r.species?.scientificNameAuthorship || '',
    genus: r.species?.genus?.scientificNameWithoutAuthor || '',
    family: r.species?.family?.scientificNameWithoutAuthor || '',
    common: (r.species?.commonNames || [])[0] || '',
    score: r.score,
    gbif: r.gbif?.id || null,
  })).filter((s) => s.name);
  // Genus and family scores: Pl@ntNet's own when "detailed", else summed from the species list.
  const sum = (key) => {
    const m = new Map();
    for (const s of species) if (s[key]) m.set(s[key], (m.get(s[key]) || 0) + s.score);
    return [...m.entries()].map(([name, score]) => ({ name, score: Math.min(1, score) })).sort((a, b) => b.score - a.score);
  };
  const other = j.otherResults || {};
  const pick = (arr) => (Array.isArray(arr) ? arr.map((r) => ({ name: r.genus?.scientificNameWithoutAuthor || r.family?.scientificNameWithoutAuthor || r.scientificNameWithoutAuthor, score: r.score })).filter((x) => x.name) : null);
  const pg = pick(other.genus), pf = pick(other.family);
  const genera = pg?.length ? pg : sum('genus');
  const families = pf?.length ? pf : sum('family');
  return { species, genera, families, organs: (j.predictedOrgans || []).map((o) => o.organ), remaining: j.remainingIdentificationRequests ?? null, version: j.version };
}

// Has GBIF any occurrence of this taxon in India? Cached per session.
const indiaCache = new Map();
export async function indiaRecords(gbifKey) {
  if (!gbifKey) return null;
  if (indiaCache.has(gbifKey)) return indiaCache.get(gbifKey);
  const p = fetch(`${GBIF}/occurrence/search?limit=0&country=IN&taxonKey=${gbifKey}`)
    .then((r) => (r.ok ? r.json() : null)).then((j) => (j ? j.count : null)).catch(() => null);
  indiaCache.set(gbifKey, p);
  return p;
}

// Small JPEG from a video element or image for upload (keeps requests fast on weak signal).
export async function frameToBlob(source, maxSide = 900, quality = 0.82) {
  const w0 = source.videoWidth || source.naturalWidth || source.width, h0 = source.videoHeight || source.naturalHeight || source.height;
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', quality));
}
