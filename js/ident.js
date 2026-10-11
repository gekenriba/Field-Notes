// Plant identification suggestions.
//
// Two independent engines, used together when both keys are set:
//   • Google Gemini (vision model). Free key from https://aistudio.google.com/apikey. It is told
//     where and when the photo was taken (district, altitude, date, habitat), which matters a lot
//     in the Eastern Himalaya, and it reports the diagnostic features it can see. It is asked for
//     genus or family when the species can't be told from the photos.
//   • Pl@ntNet. Free key from https://my.plantnet.org (500 identifications a day).
// Every candidate is then checked against GBIF: accepted name and family from the GBIF
// Backbone, and whether there are occurrence records in Arunachal Pradesh and in India.
// Suggestions are labelled with their engine and score and are never saved as an
// identification unless the user picks one.

import { getMeta, setMeta } from './db.js';
import { http } from './native.js';

const PLANTNET = 'https://my-api.plantnet.org/v2/identify/all';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const GBIF = 'https://api.gbif.org/v1';
export const ARUNACHAL_GADM = 'IND.3_1';   // GADM id GBIF uses for Arunachal Pradesh

let settings = { key: '', geminiKey: '', geminiModel: '', geminiResolved: null, liveCamera: false };
export async function loadIdentSettings() {
  const saved = await getMeta('ident', {});
  settings = { ...settings, ...saved };
  if (!('liveCamera' in saved)) settings.liveCamera = false;   // v3 had live ID on by default; v4 keeps it opt-in
  return settings;
}
export async function saveIdentSettings(patch) {
  settings = { ...settings, ...patch };
  await setMeta('ident', settings);
  return settings;
}
export const identSettings = () => settings;
export const engines = () => ({ gemini: !!settings.geminiKey, plantnet: !!settings.key });
export const identReady = () => (!!settings.key || !!settings.geminiKey) && navigator.onLine;

// ---------- usage counter (keeps live scanning from using up the free quotas) ----------
const LIVE_DAILY_CAP = 200;
async function usage() {
  const u = await getMeta('identUsage', {});
  const today = new Date().toISOString().slice(0, 10);
  return u.day === today ? { gemini: 0, plantnet: 0, ...u } : { day: today, used: 0, gemini: 0, plantnet: 0, remaining: null };
}
async function recordUsage(engine, remaining) {
  const u = await usage();
  u.used = (u.used || 0) + 1; u[engine] = (u[engine] || 0) + 1;
  if (remaining != null) u.remaining = remaining;
  await setMeta('identUsage', u);
}
export async function usageToday() { return usage(); }
export async function liveBudgetLeft() {
  const u = await usage();
  if (u.remaining != null && u.remaining < 30) return false;
  return (u.used || 0) < LIVE_DAILY_CAP;
}

export class IdentError extends Error {
  constructor(code, message, engine) { super(message); this.code = code; this.engine = engine; }
}

const blobToBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

// Resize to a JPEG of at most `maxSide` px for upload.
export async function shrink(blob, maxSide = 1280, quality = 0.85) {
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch { return blob; }
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (s === 1 && blob.type === 'image/jpeg' && blob.size < 900000) { bmp.close?.(); return blob; }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((res) => c.toBlob((b) => res(b || blob), 'image/jpeg', quality));
}

// Small JPEG from a video element (live camera).
export async function frameToBlob(source, maxSide = 900, quality = 0.82) {
  const w0 = source.videoWidth || source.naturalWidth || source.width, h0 = source.videoHeight || source.naturalHeight || source.height;
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', quality));
}

const errText = (d) => (typeof d === 'string' ? d.slice(0, 200) : d?.error?.message || d?.message || JSON.stringify(d || '').slice(0, 200));

/* =========================== Pl@ntNet =========================== */
export async function plantnet(images, { detailed = true, results = 8, key = settings.key } = {}) {
  if (!key) throw new IdentError('nokey', 'No Pl@ntNet key set.', 'plantnet');
  const form = [];
  for (const im of images.slice(0, 5)) {
    form.push({ name: 'images', blob: await shrink(im.blob, 1280), filename: 'photo.jpg' });
    form.push({ name: 'organs', value: im.organ || 'auto' });
  }
  const url = `${PLANTNET}?api-key=${encodeURIComponent(key)}&nb-results=${results}&lang=en&include-related-images=false${detailed ? '&detailed=true' : ''}`;
  let r;
  try { r = await http(url, { method: 'POST', body: { form }, timeout: 60000 }); }
  catch (e) { throw new IdentError('network', `Could not reach Pl@ntNet (${e.message || e}).`, 'plantnet'); }
  if (r.status === 404) { await recordUsage('plantnet', null); return { engine: 'plantnet', species: [], genera: [], families: [], notPlant: true }; }
  if (r.status === 401) throw new IdentError('key', `Pl@ntNet rejected the API key: ${errText(r.data)}`, 'plantnet');
  if (r.status === 403) throw new IdentError('key', `Pl@ntNet refused the request: ${errText(r.data)}. In your Pl@ntNet account, check the key is active and that “authorized domains” is empty or allows this app.`, 'plantnet');
  if (r.status === 429) throw new IdentError('quota', 'Pl@ntNet daily limit reached.', 'plantnet');
  if (!r.ok) throw new IdentError('http', `Pl@ntNet error ${r.status}: ${errText(r.data)}`, 'plantnet');
  const j = r.data || {};
  await recordUsage('plantnet', j.remainingIdentificationRequests ?? null);
  const species = (j.results || []).map((x) => ({
    name: x.species?.scientificNameWithoutAuthor, author: x.species?.scientificNameAuthorship || '',
    genus: x.species?.genus?.scientificNameWithoutAuthor || '', family: x.species?.family?.scientificNameWithoutAuthor || '',
    common: (x.species?.commonNames || [])[0] || '', score: x.score, gbif: x.gbif?.id || null,
  })).filter((s) => s.name);
  const sum = (k) => {
    const m = new Map();
    for (const s of species) if (s[k]) m.set(s[k], (m.get(s[k]) || 0) + s.score);
    return [...m.entries()].map(([name, score]) => ({ name, score: Math.min(1, score) })).sort((a, b) => b.score - a.score);
  };
  const o = j.otherResults || {};
  const pick = (arr) => (Array.isArray(arr) ? arr.map((x) => ({ name: x.genus?.scientificNameWithoutAuthor || x.family?.scientificNameWithoutAuthor || x.scientificNameWithoutAuthor, score: x.score })).filter((x) => x.name) : null);
  const pg = pick(o.genus), pf = pick(o.family);
  return { engine: 'plantnet', species, genera: pg?.length ? pg : sum('genus'), families: pf?.length ? pf : sum('family'),
    organs: (j.predictedOrgans || []).map((x) => x.organ), remaining: j.remainingIdentificationRequests ?? null };
}

/* =========================== Gemini =========================== */
// Pick the newest stable "flash" model the key can use; re-checked weekly.
async function geminiModel(key) {
  if (settings.geminiModel) return settings.geminiModel;
  const res = settings.geminiResolved;
  if (res?.model && Date.now() - res.at < 7 * 864e5) return res.model;
  let model = 'gemini-flash-latest';
  try {
    const r = await http(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, timeout: 15000 });
    if (r.status === 400 || r.status === 401 || r.status === 403) throw new IdentError('key', `Gemini rejected the API key: ${errText(r.data)}`, 'gemini');
    const names = (r.data?.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
    const ver = (n) => parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/) || [])[1] || '0');
    const stable = names.filter((n) => /^gemini-\d+(?:\.\d+)?-flash$/.test(n)).sort((a, b) => ver(b) - ver(a));
    if (stable.length) model = stable[0];
    else if (names.includes('gemini-flash-latest')) model = 'gemini-flash-latest';
  } catch (e) { if (e instanceof IdentError) throw e; }
  await saveIdentSettings({ geminiResolved: { model, at: Date.now() } });
  return model;
}
export async function geminiModels(key = settings.geminiKey) {
  const r = await http(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, timeout: 15000 });
  if (!r.ok) throw new IdentError('key', errText(r.data), 'gemini');
  return (r.data?.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/.test(m.name) && !/image|tts|live|embedding|audio/.test(m.name))
    .map((m) => m.name.replace(/^models\//, '')).sort().reverse();
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    plant_visible: { type: 'BOOLEAN' },
    organs_visible: { type: 'ARRAY', items: { type: 'STRING' } },
    features: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Diagnostic morphological characters actually visible in the photos' },
    candidates: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          scientific_name: { type: 'STRING', description: 'Accepted binomial without authority; or just the genus when only the genus is supported' },
          rank: { type: 'STRING', enum: ['species', 'genus'] },
          genus: { type: 'STRING' },
          family: { type: 'STRING' },
          confidence: { type: 'NUMBER', description: '0 to 1, calibrated' },
          reason: { type: 'STRING', description: 'One short sentence: visible features supporting this name' },
        },
        required: ['scientific_name', 'rank', 'genus', 'family', 'confidence'],
      },
    },
    family: { type: 'STRING' },
    family_confidence: { type: 'NUMBER' },
    check_next: { type: 'STRING', description: 'What to examine in the field or herbarium to confirm' },
  },
  required: ['plant_visible', 'features', 'candidates', 'family', 'family_confidence'],
};

function contextText(ctx = {}) {
  const parts = [];
  if (ctx.district || ctx.locality) parts.push(`Locality: ${[ctx.locality, ctx.district].filter(Boolean).join(', ')}, Arunachal Pradesh, India.`);
  else parts.push('Region: Arunachal Pradesh, Eastern Himalaya, India.');
  if (ctx.lat != null && ctx.lng != null) parts.push(`Coordinates: ${(+ctx.lat).toFixed(4)}, ${(+ctx.lng).toFixed(4)}.`);
  if (ctx.altitude != null && ctx.altitude !== '') parts.push(`Elevation: ${ctx.altitude} m.`);
  if (ctx.date) parts.push(`Date photographed: ${ctx.date}.`);
  if (ctx.habitat) parts.push(`Habitat: ${ctx.habitat}.`);
  if (ctx.notes) parts.push(`Field notes: ${String(ctx.notes).slice(0, 400)}`);
  if (ctx.group && ctx.group !== 'Plant') parts.push(`Organism group: ${ctx.group}.`);
  return parts.join(' ');
}

const INSTRUCTIONS = `You are an expert field botanist and taxonomist for the flora of Arunachal Pradesh and the Eastern Himalaya (including Bhutan, Sikkim, south-east Tibet and northern Myanmar).
Identify the plant in the photos for a researcher. Rules:
- Base the identification on what is visible. List the diagnostic features you can actually see (leaf arrangement and margin, flower symmetry, number of parts, spur, inflorescence, indumentum, etc.).
- Use the locality, elevation and date: prefer taxa known to occur in the Eastern Himalaya at that elevation and season, but do not force a regional name onto a plant that does not match.
- Give up to 5 candidates, best first. Use currently accepted names (POWO / World Flora Online), no authorities. Never invent a name.
- If the species cannot be told from the photos, give the genus as a candidate with rank "genus" rather than guessing a species.
- Confidence must be calibrated: 0.9 or above only when unmistakable; similar congeners lower it.
- If no plant is visible, set plant_visible false and return no candidates.`;

export async function gemini(images, ctx = {}, { key = settings.geminiKey } = {}) {
  if (!key) throw new IdentError('nokey', 'No Gemini key set.', 'gemini');
  const model = await geminiModel(key);
  const parts = [];
  for (const im of images.slice(0, 4)) parts.push({ inline_data: { mime_type: 'image/jpeg', data: await blobToBase64(await shrink(im.blob, 1280)) } });
  parts.push({ text: `${contextText(ctx)}\nIdentify this plant.` });
  const body = {
    systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA },
  };
  let r;
  try { r = await http(`${GEMINI}/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key }, body, timeout: 90000 }); }
  catch (e) { throw new IdentError('network', `Could not reach Gemini (${e.message || e}).`, 'gemini'); }
  if (r.status === 404 && !settings.geminiModel) { await saveIdentSettings({ geminiResolved: null }); }
  if (r.status === 400 && /API key/i.test(errText(r.data))) throw new IdentError('key', `Gemini rejected the API key: ${errText(r.data)}`, 'gemini');
  if (r.status === 401 || r.status === 403) throw new IdentError('key', `Gemini refused the request: ${errText(r.data)}`, 'gemini');
  if (r.status === 429) throw new IdentError('quota', 'Gemini rate limit reached. Wait a minute and try again.', 'gemini');
  if (!r.ok) throw new IdentError('http', `Gemini error ${r.status} (${model}): ${errText(r.data)}`, 'gemini');
  await recordUsage('gemini', null);
  const text = (r.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  let j;
  try { j = JSON.parse(text); } catch { throw new IdentError('parse', 'Gemini returned an unreadable answer. Try again.', 'gemini'); }
  const clamp = (x) => Math.max(0, Math.min(1, +x || 0));
  const cands = (j.candidates || []).filter((c) => c.scientific_name).map((c) => ({
    name: c.scientific_name.trim().replace(/\s+/g, ' '), rank: c.rank === 'genus' || !/\s/.test(c.scientific_name.trim()) ? 'genus' : 'species',
    genus: c.genus || c.scientific_name.split(' ')[0], family: c.family || '', score: clamp(c.confidence), reason: c.reason || '',
  }));
  return {
    engine: 'gemini', model,
    notPlant: j.plant_visible === false,
    species: cands.filter((c) => c.rank === 'species'),
    genera: cands.filter((c) => c.rank === 'genus').map((c) => ({ name: c.name, score: c.score, family: c.family })),
    families: j.family ? [{ name: j.family, score: clamp(j.family_confidence) }] : [],
    features: (j.features || []).slice(0, 8),
    organs: j.organs_visible || [],
    checkNext: j.check_next || '',
  };
}

/* =========================== GBIF checks =========================== */
const gbifCache = new Map();
export function gbifCheck(name) {
  const k = name.toLowerCase();
  if (gbifCache.has(k)) return gbifCache.get(k);
  const p = (async () => {
    const m = await http(`${GBIF}/species/match?name=${encodeURIComponent(name)}&kingdom=Plantae`, { timeout: 15000 }).then((r) => r.data).catch(() => null);
    if (!m || m.matchType === 'NONE' || m.matchType === 'HIGHERRANK') return { matched: false };
    const key = m.acceptedUsageKey || m.usageKey;
    const count = (extra) => http(`${GBIF}/occurrence/search?limit=0&taxonKey=${key}${extra}`, { timeout: 15000 }).then((r) => r.data?.count ?? null).catch(() => null);
    const [arunachal, india] = await Promise.all([count(`&gadmGid=${ARUNACHAL_GADM}`), count('&country=IN')]);
    let accepted = null;
    if (m.status && m.status !== 'ACCEPTED' && m.acceptedUsageKey) {
      const a = await http(`${GBIF}/species/${m.acceptedUsageKey}`, { timeout: 15000 }).then((r) => r.data).catch(() => null);
      if (a?.canonicalName) accepted = a.canonicalName;
    }
    return { matched: true, key, status: m.status, family: m.family || '', genus: m.genus || '', accepted, arunachal, india, fuzzy: m.matchType === 'FUZZY' };
  })();
  gbifCache.set(k, p);
  return p;
}
export async function indiaRecords(gbifKey) {   // kept for the live camera
  if (!gbifKey) return null;
  const r = await http(`${GBIF}/occurrence/search?limit=0&country=IN&taxonKey=${gbifKey}`, { timeout: 15000 }).catch(() => null);
  return r?.data?.count ?? null;
}

/* =========================== combined =========================== */
/**
 * Runs every configured engine on the photos, merges their answers and checks names in GBIF.
 * images: [{ blob }]; ctx: { lat, lng, altitude, date, district, locality, habitat, notes, group }
 * returns { species: [{ name, family, genus, score, sources:{gemini,plantnet}, gbif:{...}, reason }],
 *           genera, families, features, checkNext, engines: { gemini: {ok|error}, plantnet: {...} } }
 */
export async function identifyAll(images, ctx = {}, { onPartial } = {}) {
  if (!navigator.onLine) throw new IdentError('offline', 'Suggestions need an internet connection.');
  const en = engines();
  if (!en.gemini && !en.plantnet) throw new IdentError('nokey', 'Add a free Gemini or Pl@ntNet key in Settings to get suggestions.');
  const jobs = {};
  if (en.gemini) jobs.gemini = gemini(images, ctx);
  if (en.plantnet) jobs.plantnet = plantnet(images.map((i) => ({ blob: i.blob, organ: 'auto' })));
  const settled = {};
  await Promise.all(Object.entries(jobs).map(([k, p]) => p.then((v) => { settled[k] = { ok: true, v }; onPartial?.(k); }, (e) => { settled[k] = { ok: false, error: e }; })));
  const ok = Object.values(settled).filter((s) => s.ok).map((s) => s.v);
  if (!ok.length) {
    const errs = Object.values(settled).map((x) => x.error).filter(Boolean);
    if (errs.length === 1) throw errs[0];
    const e = new IdentError(errs.some((x) => x.code === 'key') ? 'key' : 'none', errs.map((x) => x.message).join(' ') || 'No identification engine answered.');
    throw e;
  }
  const out = merge(ok);
  out.engines = Object.fromEntries(Object.entries(settled).map(([k, s]) => [k, s.ok ? { ok: true, model: s.v.model } : { ok: false, error: s.error.message }]));
  out.notPlant = ok.every((r) => r.notPlant);
  // GBIF checks for the top candidates; adjust ranking by regional records.
  await Promise.all(out.species.slice(0, 6).map(async (s) => {
    s.gbif = await gbifCheck(s.name).catch(() => null);
    if (s.gbif?.accepted && s.gbif.accepted !== s.name) s.acceptedName = s.gbif.accepted;
    if (!s.family && s.gbif?.family) s.family = s.gbif.family;
  }));
  for (const s of out.species) {
    let f = 1;
    if (s.gbif?.arunachal > 0) f = 1.12;
    else if (s.gbif?.india === 0) f = 0.75;
    s.rank = Math.min(1, s.score * f);
  }
  out.species.sort((a, b) => b.rank - a.rank);
  return out;
}

function merge(results) {
  const sp = new Map(), ge = new Map(), fa = new Map();
  const weight = { gemini: 0.9, plantnet: 1 };
  const add = (map, key, item, engine) => {
    const k = key.toLowerCase();
    const cur = map.get(k) || { ...item, score: 0, sources: {} };
    cur.sources[engine] = item.score;
    for (const f of ['family', 'genus', 'common', 'reason', 'gbif']) if (!cur[f] && item[f]) cur[f] = item[f];
    map.set(k, cur);
  };
  for (const r of results) {
    for (const s of r.species || []) add(sp, s.name, s, r.engine);
    for (const g of r.genera || []) add(ge, g.name, g, r.engine);
    for (const f of r.families || []) add(fa, f.name, f, r.engine);
  }
  // Combined score: probability that at least one engine is right, with agreement rewarded.
  const combine = (m) => [...m.values()].map((x) => {
    const vals = Object.entries(x.sources).map(([e, v]) => Math.max(0, Math.min(1, v)) * weight[e]);
    x.score = 1 - vals.reduce((p, v) => p * (1 - v), 1);
    x.agree = Object.keys(x.sources).length > 1;
    return x;
  }).sort((a, b) => b.score - a.score);
  // Genus and family leads also count the species under them.
  const species = combine(sp);
  for (const s of species) {
    if (s.genus) add(ge, s.genus, { name: s.genus, score: 0, family: s.family }, '_');
    if (s.family) add(fa, s.family, { name: s.family, score: 0 }, '_');
  }
  const rollup = (m, key) => [...m.values()].map((x) => {
    delete x.sources._;
    const own = Object.entries(x.sources).map(([e, v]) => v * (weight[e] || 1));
    const fromSpecies = species.filter((s) => (s[key] || '').toLowerCase() === x.name.toLowerCase()).reduce((a, s) => a + s.score, 0);
    x.score = Math.min(1, Math.max(...own, 0, fromSpecies));
    return x;
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const gem = results.find((r) => r.engine === 'gemini');
  return { species, genera: rollup(ge, 'genus'), families: rollup(fa, 'family'), features: gem?.features || [], checkNext: gem?.checkNext || '', organs: gem?.organs || results[0]?.organs || [] };
}

// Quick single-engine call used by the experimental live camera.
export async function identify(images, { results = 5 } = {}) {
  if (settings.key) return plantnet(images, { detailed: false, results });
  if (settings.geminiKey) return gemini(images, {});
  throw new IdentError('nokey', 'Add a Gemini or Pl@ntNet key in Settings for suggestions.');
}

// Verifies a key with the smallest possible request and explains failures.
export async function testKey(engine, key) {
  if (!key) return { ok: false, message: 'No key entered.' };
  try {
    if (engine === 'gemini') {
      const models = await geminiModels(key);
      const saved = { ...settings, geminiKey: key };
      settings = saved;
      const m = await geminiModel(key);
      return { ok: true, message: `Key works. Using ${m} (${models.length} models available).` };
    }
    // Pl@ntNet: a 1×1 white image costs one identification and checks key + permissions.
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 64, 64);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    const r = await http(`${PLANTNET}?api-key=${encodeURIComponent(key)}&nb-results=1`, { method: 'POST', body: { form: [{ name: 'images', blob, filename: 'test.jpg' }, { name: 'organs', value: 'auto' }] }, timeout: 30000 });
    if (r.status === 404 || r.ok) return { ok: true, message: `Key works${r.data?.remainingIdentificationRequests != null ? `, ${r.data.remainingIdentificationRequests} identifications left today` : ''}.` };
    return { ok: false, message: `Pl@ntNet answered ${r.status}: ${errText(r.data)}` };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}
