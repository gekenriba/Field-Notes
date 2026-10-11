// Name search and taxon details from public biodiversity sources.
//   GBIF Backbone Taxonomy  — accepted name, synonym status, family / order / class, occurrence counts
//   iNaturalist             — common-name search, common name, link
//   Wikipedia               — short description
// Every value keeps its source so the app can label where it came from. Results are cached in
// IndexedDB so a name looked up once stays available offline.

import { db } from './db.js';

const GBIF = 'https://api.gbif.org';
const BACKBONE = 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c';
const INAT = 'https://api.inaturalist.org/v1';

// Group → GBIF kingdom filter and iNaturalist root taxon id
export const GROUPS = {
  Plant:     { kingdom: 'Plantae', inat: 47126, icon: '🌿' },
  Bryophyte: { kingdom: 'Plantae', inat: 47126, icon: '🌱' },
  Fungus:    { kingdom: 'Fungi',   inat: 47170, icon: '🍄' },
  Lichen:    { kingdom: 'Fungi',   inat: 47170, icon: '🪨' },
  Animal:    { kingdom: 'Animalia', inat: 1,    icon: '🦋' },
  Other:     { kingdom: null,      inat: null,  icon: '•' },
};

async function getJSON(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const enc = encodeURIComponent;

// ---------- Autocomplete while typing ----------
export async function suggest(q, group = 'Plant') {
  q = q.trim();
  if (q.length < 3) return [];
  const g = GROUPS[group] || GROUPS.Other;
  const [gb, nat] = await Promise.allSettled([
    getJSON(`${GBIF}/v1/species/suggest?q=${enc(q)}&datasetKey=${BACKBONE}&limit=10`, 6000),
    getJSON(`${INAT}/taxa/autocomplete?q=${enc(q)}&per_page=6&is_active=true${g.inat ? `&taxon_id=${g.inat}` : ''}`, 6000),
  ]);
  const out = [];
  const seen = new Set();
  if (gb.status === 'fulfilled' && Array.isArray(gb.value)) {
    for (const r of gb.value) {
      if (g.kingdom && r.kingdom && r.kingdom !== g.kingdom) continue;
      const name = r.canonicalName || r.scientificName;
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ name, rank: r.rank, family: r.family || null, status: r.status, source: 'GBIF' });
    }
  }
  if (nat.status === 'fulfilled' && nat.value?.results) {
    for (const r of nat.value.results) {
      if (!r.name || seen.has(r.name.toLowerCase())) continue;
      seen.add(r.name.toLowerCase());
      out.push({ name: r.name, rank: (r.rank || '').toUpperCase(), common: r.preferred_common_name || r.matched_term || null,
        thumb: r.default_photo?.square_url || null, source: 'iNaturalist' });
    }
  }
  if (!out.length && gb.status === 'rejected' && nat.status === 'rejected') throw new Error('offline');
  return out.slice(0, 10);
}

// ---------- Full details for a chosen name ----------
async function gbifMatch(name, kingdom) {
  try {
    const m = await getJSON(`${GBIF}/v1/species/match?verbose=false&name=${enc(name)}${kingdom ? `&kingdom=${kingdom}` : ''}`);
    if (m && m.matchType) return m;
  } catch { /* try v2 below */ }
  // GBIF's newer matching service, in case v1 is retired.
  const v2 = await getJSON(`${GBIF}/v2/species/match?scientificName=${enc(name)}${kingdom ? `&kingdom=${kingdom}` : ''}`);
  if (!v2?.usage) return { matchType: 'NONE' };
  const cls = Object.fromEntries((v2.classification || []).map((c) => [String(c.rank).toLowerCase(), c.name]));
  return {
    matchType: v2.diagnostics?.matchType || 'EXACT', confidence: v2.diagnostics?.confidence,
    usageKey: v2.usage.key, scientificName: v2.usage.name, canonicalName: v2.usage.canonicalName,
    rank: v2.usage.rank, status: v2.usage.status, acceptedUsageKey: v2.acceptedUsage?.key,
    kingdom: cls.kingdom, phylum: cls.phylum, class: cls.class, order: cls.order, family: cls.family, genus: cls.genus,
  };
}

export async function lookup(name, group = 'Plant', { force = false } = {}) {
  name = name.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const key = `${group}:${name.toLowerCase()}`;
  if (!force) {
    const cached = await db.get('taxa', key);
    if (cached) return { ...cached.data, cached: true };
  }
  const kingdom = (GROUPS[group] || GROUPS.Other).kingdom;
  const errors = [];
  let match = null;
  try { match = await gbifMatch(name, kingdom); } catch (e) { errors.push('GBIF'); }
  if (!match && errors.length) {
    // Nothing reachable at all — most likely offline.
    const err = new Error('offline'); err.offline = true; throw err;
  }

  const found = match && match.matchType && match.matchType !== 'NONE';
  const usable = found && match.matchType !== 'HIGHERRANK';
  const canonical = usable ? (match.canonicalName || name) : name;
  const taxonKey = usable ? (match.acceptedUsageKey || match.usageKey) : null;

  const [accepted, global, india, wiki, inat] = await Promise.allSettled([
    usable && match.status && match.status !== 'ACCEPTED' && match.acceptedUsageKey
      ? getJSON(`${GBIF}/v1/species/${match.acceptedUsageKey}`) : Promise.resolve(null),
    taxonKey ? getJSON(`${GBIF}/v1/occurrence/search?limit=0&taxonKey=${taxonKey}`) : Promise.resolve(null),
    taxonKey ? getJSON(`${GBIF}/v1/occurrence/search?limit=0&country=IN&taxonKey=${taxonKey}`) : Promise.resolve(null),
    getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(canonical.replace(/ /g, '_'))}`),
    getJSON(`${INAT}/taxa?q=${enc(canonical)}&per_page=1&is_active=true${GROUPS[group]?.inat ? `&taxon_id=${GROUPS[group].inat}` : ''}`),
  ]);
  const val = (r, label) => { if (r.status === 'rejected') { errors.push(label); return null; } return r.value; };

  const acc = val(accepted, 'GBIF');
  const w = val(wiki, 'Wikipedia');
  const n = val(inat, 'iNaturalist')?.results?.[0];
  const inatOk = n && n.name && n.name.toLowerCase() === canonical.toLowerCase();

  const data = {
    query: name,
    group,
    fetchedAt: new Date().toISOString(),
    gbif: found ? {
      matchType: match.matchType,              // EXACT | FUZZY | HIGHERRANK
      confidence: match.confidence ?? null,
      usageKey: match.usageKey,
      scientificName: match.scientificName,    // includes authorship
      canonicalName: match.canonicalName,
      rank: match.rank,
      status: match.status,                    // ACCEPTED | SYNONYM | DOUBTFUL …
      kingdom: match.kingdom, phylum: match.phylum, class: match.class,
      order: match.order, family: match.family, genus: match.genus,
      url: `https://www.gbif.org/species/${match.usageKey}`,
    } : null,
    accepted: acc ? { key: acc.key, scientificName: acc.scientificName, canonicalName: acc.canonicalName,
      family: acc.family, url: `https://www.gbif.org/species/${acc.key}` } : null,
    counts: taxonKey ? { global: val(global, 'GBIF')?.count ?? null, india: val(india, 'GBIF')?.count ?? null } : null,
    wiki: w && w.type !== 'disambiguation' && w.extract
      ? { title: w.title, extract: w.extract, url: w.content_urls?.desktop?.page || null, thumb: w.thumbnail?.source || null }
      : null,
    inat: inatOk ? { id: n.id, commonName: n.preferred_common_name || null, url: `https://www.inaturalist.org/taxa/${n.id}`,
      observations: n.observations_count ?? null, photo: n.default_photo?.medium_url || null } : null,
    errors: [...new Set(errors)],
  };
  // Only cache complete lookups, so a partial result from a weak signal is retried later.
  if (!data.errors.length) await db.put('taxa', { key, data });
  return data;
}

// Fields to auto-fill into an entry from a lookup result.
export function fieldsFrom(info) {
  if (!info?.gbif) return {};
  const g = info.gbif;
  const usable = g.matchType !== 'HIGHERRANK';
  return {
    family: info.accepted?.family || g.family || '',
    genus: g.genus || '',
    order: g.order || '',
    rank: usable ? g.rank : '',
    authorship: usable && g.scientificName && g.canonicalName && g.scientificName.startsWith(g.canonicalName)
      ? g.scientificName.slice(g.canonicalName.length).trim() : '',
    commonName: info.inat?.commonName || '',
  };
}
