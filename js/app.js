import { db, uid, getMeta, setMeta, delMeta, deleteEntry, requestPersistence, storageEstimate, exportBackup, importBackup } from './db.js';
import { processPhoto, LiveCamera } from './media.js';
import { getBestFix, demElevation, placeName, formatCoord } from './geo.js';
import { GROUPS, suggest, lookup, fieldsFrom } from './taxon.js';
import { createMap, heatLayer, pointsLayer, fitTo } from './maps.js';
import { isNative, shareTextFile } from './native.js';

/* ================= helpers ================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NR = '<span class="nr">not reported</span>';
const show = (v) => (v === null || v === undefined || v === '' ? NR : esc(v));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${+d} ${MONTHS[+m - 1]} ${y}`; };
const PHENO = ['Vegetative', 'Budding', 'Flowering', 'Fruiting', 'Seeding', 'Senescent'];

export function normName(s) {
  s = String(s || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  return s[0].toUpperCase() + s.slice(1).toLowerCase().replace(/ x /g, ' × ');
}
const displayName = (e) => e.scientificName || e.fieldLabel || 'Unidentified';
const speciesKey = (e) => (e.status === 'identified' && e.scientificName ? e.scientificName : null);

function toast(msg, { action, onAction, ms = 3200 } = {}) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  if (action) $('button', el).onclick = () => { el.classList.remove('show'); onAction?.(); };
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function confirmBox(text, yesLabel = 'Delete') {
  const d = $('#confirmDialog');
  $('#confirmText').textContent = text;
  $('#confirmYes').textContent = yesLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise((res) => d.addEventListener('close', () => res(d.returnValue === 'yes'), { once: true }));
}

/* ================= state ================= */
const state = {
  entries: [],          // sorted newest first
  thumbs: new Map(),    // photoId -> object URL
  settings: { recorder: '' },
  map: null,            // current Leaflet map (destroyed on navigation)
};

async function loadEntries() {
  const all = await db.all('entries');
  all.sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  state.entries = all;
  const drafts = all.filter((e) => e.status === 'draft').length;
  const badge = $('#draftBadge');
  badge.textContent = drafts;
  badge.classList.toggle('hidden', !drafts);
}

async function thumbURL(photoId) {
  if (!photoId) return null;
  if (state.thumbs.has(photoId)) return state.thumbs.get(photoId);
  const p = await db.get('photos', photoId);
  if (!p) return null;
  const url = URL.createObjectURL(p.thumb || p.blob);
  state.thumbs.set(photoId, url);
  return url;
}
async function thumbsFor(entries) {
  const m = new Map();
  for (const e of entries) { const u = await thumbURL(e.photoIds?.[0]); if (u) m.set(e.id, u); }
  return m;
}

/* ================= overlays + back button ================= */
// Lets the Android back button close the camera / form instead of leaving the app.
const overlays = [];
const popWaiters = [];
function pushOverlay(name, onBack) { overlays.push({ name, onBack }); history.pushState({ overlay: name }, ''); }
// Hand the current history entry from one overlay to another (camera → form) without navigating.
function swapOverlay(oldName, name, onBack) {
  const i = overlays.map((o) => o.name).lastIndexOf(oldName);
  if (i === -1) return pushOverlay(name, onBack);
  overlays[i] = { name, onBack };
  history.replaceState({ overlay: name }, '');
}
// Resolves once the browser has actually gone back, so a following navigation can't be undone by it.
function popOverlay(name) {
  const i = overlays.map((o) => o.name).lastIndexOf(name);
  if (i === -1) return Promise.resolve();
  overlays.splice(i, 1);
  return new Promise((resolve) => {
    const w = { resolve, timer: setTimeout(() => { popWaiters.splice(popWaiters.indexOf(w), 1); resolve(); }, 600) };
    popWaiters.push(w);
    history.back();
  });
}
window.addEventListener('popstate', () => {
  const w = popWaiters.shift();
  if (w) { clearTimeout(w.timer); w.resolve(); return; }
  const top = overlays.pop();
  if (top) top.onBack();
});

/* ================= router ================= */
const routes = {
  home: renderHome, records: renderRecords, entry: renderEntry, map: renderMap,
  species: renderSpecies, taxon: renderTaxon, more: renderMore,
};

async function router() {
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [pathPart, query = ''] = raw.split('?');
  const [name, ...rest] = pathPart.split('/');
  const params = Object.fromEntries(new URLSearchParams(query));
  if (state.map) { state.map.remove(); state.map = null; }
  const view = $('#view');
  view.innerHTML = '';
  view.className = `view-${name}`;
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (name === 'entry' ? 'records' : name === 'taxon' ? 'species' : name)));
  const fn = routes[name] || renderHome;
  try { await fn(view, decodeURIComponent(rest.join('/')), params); }
  catch (err) { console.error(err); view.innerHTML = `<div class="empty"><p>Something went wrong: ${esc(err.message)}</p></div>`; }
  if (!overlays.length) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);

/* ================= cards ================= */
function entryCard(e, thumb) {
  const sci = !!e.scientificName;
  const meta = [fmtDate(e.date), e.altitude != null ? `${e.altitude} m` : null, e.locality].filter(Boolean).join(' · ');
  return `<a class="entry-card" href="#/entry/${e.id}">
    <div class="thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : `<span>${GROUPS[e.group]?.icon || '•'}</span>`}</div>
    <div class="entry-text">
      <div class="entry-name ${sci ? 'sci' : ''}">${esc(displayName(e))}</div>
      <div class="entry-sub">${esc([e.family, e.commonName || e.localName].filter(Boolean).join(' · ') || (sci ? '' : e.fieldLabel ? 'Unidentified' : ''))}</div>
      <div class="entry-meta">${esc(meta)}</div>
    </div>
    ${e.status === 'draft' ? '<span class="tag tag-draft">Draft</span>' : ''}
  </a>`;
}

/* ================= HOME ================= */
async function renderHome(view) {
  const E = state.entries;
  const drafts = E.filter((e) => e.status === 'draft');
  const species = new Set(E.map(speciesKey).filter(Boolean));
  const families = new Set(E.filter((e) => e.status === 'identified' && e.family).map((e) => e.family));
  const alts = E.map((e) => e.altitude).filter((a) => a != null);
  const recent = E.slice(0, 6);
  const tmap = await thumbsFor([...drafts.slice(0, 4), ...recent]);

  view.innerHTML = `
    <section class="hero">
      <p class="eyebrow">Tawang District · field journal</p>
      <h1>${E.length ? `${E.length} observation${E.length === 1 ? '' : 's'}` : 'Start your first observation'}</h1>
      <p class="hero-sub">${E.length ? `Stored on this device · ${alts.length ? `${Math.min(...alts)}–${Math.max(...alts)} m` : 'altitude not reported'}` : 'Tap the camera to photograph a plant. GPS, altitude and time are recorded automatically — even offline.'}</p>
    </section>
    <section class="stats">
      <a href="#/species" class="stat"><b>${species.size}</b><span>Species</span></a>
      <a href="#/species" class="stat"><b>${families.size}</b><span>Families</span></a>
      <a href="#/records?filter=draft" class="stat ${drafts.length ? 'stat-warn' : ''}"><b>${drafts.length}</b><span>Drafts</span></a>
      <a href="#/records" class="stat"><b>${E.reduce((n, e) => n + (e.photoIds?.length || 0), 0)}</b><span>Photos</span></a>
    </section>
    ${drafts.length ? `<section class="block">
      <div class="block-head"><h2>Waiting for identification</h2><a href="#/records?filter=draft">All drafts →</a></div>
      <div class="list">${drafts.slice(0, 4).map((e) => entryCard(e, tmap.get(e.id))).join('')}</div>
    </section>` : ''}
    <section class="block">
      <div class="block-head"><h2>Recent</h2>${E.length ? '<a href="#/records">All records →</a>' : ''}</div>
      ${recent.length ? `<div class="list">${recent.map((e) => entryCard(e, tmap.get(e.id))).join('')}</div>`
        : `<div class="empty"><p>No records yet.</p><button class="btn btn-primary" id="homeNew" type="button">New observation</button></div>`}
    </section>`;
  $('#homeNew')?.addEventListener('click', () => openForm({}));
}

/* ================= RECORDS ================= */
async function renderRecords(view, _arg, params) {
  const filter = params.filter || 'all';
  view.innerHTML = `
    <div class="page-head"><h1>Records</h1><button class="btn btn-small btn-primary" id="recNew" type="button">+ New</button></div>
    <div class="toolbar">
      <input id="recSearch" type="search" placeholder="Search name, family, place, notes, tags…" value="${esc(params.q || '')}" />
      <div class="chips" id="recFilter">
        ${['all', 'draft', 'identified'].map((f) => `<button type="button" class="chip ${f === filter ? 'on' : ''}" data-f="${f}">${{ all: 'All', draft: 'Drafts', identified: 'Identified' }[f]}</button>`).join('')}
      </div>
    </div>
    <div id="recList" class="list"></div>`;
  $('#recNew').onclick = () => openForm({});
  let current = filter;
  const draw = async () => {
    const q = $('#recSearch').value.trim().toLowerCase();
    let list = state.entries;
    if (current !== 'all') list = list.filter((e) => e.status === current);
    if (q) list = list.filter((e) => [e.scientificName, e.fieldLabel, e.family, e.genus, e.commonName, e.localName, e.locality, e.habitat, e.notes, (e.tags || []).join(' ')]
      .filter(Boolean).join(' ').toLowerCase().includes(q));
    const tmap = await thumbsFor(list.slice(0, 300));
    $('#recList').innerHTML = list.length ? list.slice(0, 300).map((e) => entryCard(e, tmap.get(e.id))).join('')
      : `<div class="empty"><p>${current === 'draft' && !q ? 'No drafts — everything is identified.' : 'No matching records.'}</p></div>`;
  };
  $('#recSearch').addEventListener('input', debounce(draw, 200));
  $('#recFilter').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-f]'); if (!b) return;
    current = b.dataset.f;
    $$('#recFilter .chip').forEach((c) => c.classList.toggle('on', c === b));
    history.replaceState(null, '', `#/records?filter=${current}`);
    draw();
  });
  await draw();
}

/* ================= ENTRY DETAIL ================= */
async function renderEntry(view, id) {
  const e = await db.get('entries', id);
  if (!e) { view.innerHTML = '<div class="empty"><p>Record not found.</p></div>'; return; }
  const photos = [];
  for (const pid of e.photoIds || []) { const p = await db.get('photos', pid); if (p) photos.push(URL.createObjectURL(p.blob)); }
  const pheno = (e.phenology || []).join(', ');
  const ethno = e.ethno && Object.values(e.ethno).some(Boolean) ? e.ethno : null;
  const key = speciesKey(e);

  view.innerHTML = `
    <div class="page-head"><button class="icon-btn" type="button" id="entBack" aria-label="Back">←</button>
      <span class="spacer"></span>
      <button class="btn btn-small btn-outline" id="entEdit" type="button">Edit</button></div>
    ${photos.length ? `<div class="gallery">${photos.map((u) => `<img src="${u}" alt="" data-full="${u}">`).join('')}</div>` : ''}
    <section class="detail-head">
      ${e.status === 'draft' ? '<span class="tag tag-draft">Draft · needs identification</span>' : ''}
      <h1 class="${e.scientificName ? 'sci' : ''}">${esc(displayName(e))}${e.authorship ? ` <small class="auth">${esc(e.authorship)}</small>` : ''}</h1>
      <p class="muted">${esc([e.commonName, e.localName && `Local: ${e.localName}`].filter(Boolean).join(' · '))}</p>
      ${key ? `<a class="btn btn-small btn-outline" href="#/taxon/${encodeURIComponent(key)}">Species page &amp; heatmap →</a>` : ''}
      ${e.status === 'draft' ? `<button class="btn btn-small btn-primary" id="entIdentify" type="button">Identify now</button>` : ''}
    </section>
    <dl class="facts">
      <dt>Family</dt><dd>${show(e.family)}</dd>
      <dt>Genus</dt><dd>${show(e.genus)}</dd>
      <dt>Group</dt><dd>${show(e.group)}</dd>
      <dt>ID confidence</dt><dd>${show(e.scientificName ? e.idConfidence : null)}</dd>
      <dt>Field label</dt><dd>${show(e.fieldLabel)}</dd>
      <dt>Date</dt><dd>${show([fmtDate(e.date), e.time].filter(Boolean).join(' '))}</dd>
      <dt>Coordinates</dt><dd>${esc(formatCoord(e.lat, e.lng))}${e.accuracy != null ? ` <span class="muted">±${e.accuracy} m</span>` : ''}</dd>
      <dt>Altitude</dt><dd>${e.altitude != null ? `${e.altitude} m <span class="muted">${esc(e.altitudeSource || '')}</span>` : NR}</dd>
      <dt>Locality</dt><dd>${show(e.locality)}</dd>
      <dt>Habitat</dt><dd>${show(e.habitat)}</dd>
      <dt>Phenology</dt><dd>${show(pheno)}</dd>
      <dt>Abundance</dt><dd>${show(e.abundance)}</dd>
      <dt>Tags</dt><dd>${(e.tags || []).length ? e.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') : NR}</dd>
      ${e.voucher && (e.voucher.collector || e.voucher.number) ? `<dt>Voucher</dt><dd>${esc([e.voucher.collector, e.voucher.number, e.voucher.herbarium].filter(Boolean).join(' · '))}</dd>` : ''}
    </dl>
    ${e.notes ? `<section class="card"><h3>Notes</h3><p class="prewrap">${esc(e.notes)}</p></section>` : ''}
    ${ethno ? `<section class="card"><h3>Ethnobotany</h3><dl class="facts">
      <dt>Use</dt><dd>${show(ethno.use)}</dd><dt>Part used</dt><dd>${show(ethno.part)}</dd>
      <dt>Preparation</dt><dd>${show(ethno.prep)}</dd><dt>Community</dt><dd>${show(ethno.community)}</dd>
      <dt>Informant</dt><dd>${show([ethno.informant, ethno.age, ethno.gender].filter(Boolean).join(', '))}</dd>
      <dt>Consent</dt><dd>${show(ethno.consent)}</dd></dl></section>` : ''}
    ${e.lat != null ? '<div id="entMap" class="mini-map"></div>' : ''}
    <section class="card" id="entInfo"></section>`;

  $('#entBack').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/records'));
  $('#entEdit').onclick = () => openForm({ entry: e });
  $('#entIdentify')?.addEventListener('click', () => openForm({ entry: e, focusName: true }));
  $$('.gallery img').forEach((img) => img.addEventListener('click', () => openViewer(img.dataset.full)));

  if (e.lat != null) {
    state.map = createMap($('#entMap'), { layer: 'Satellite' });
    state.map.setView([e.lat, e.lng], 14);
    L.circleMarker([e.lat, e.lng], { radius: 8, color: '#fff', weight: 2, fillColor: e.status === 'draft' ? '#d4892a' : '#1f6b4a', fillOpacity: 1 }).addTo(state.map);
    if (e.accuracy) L.circle([e.lat, e.lng], { radius: e.accuracy, weight: 1, color: '#fff', fillOpacity: 0.1 }).addTo(state.map);
  }
  renderInfoCard($('#entInfo'), e);
}

function renderInfoCard(el, e) {
  if (!e.scientificName) {
    el.innerHTML = '<h3>Reference information</h3><p class="muted">Add a scientific name to fetch family, accepted name and a short description from GBIF, iNaturalist and Wikipedia.</p>';
    return;
  }
  const draw = (info) => { el.innerHTML = `<h3>Reference information</h3>${infoHTML(info)}<button class="btn btn-small btn-ghost" type="button" id="infoRefresh">↻ Refresh from web</button>`;
    $('#infoRefresh', el).onclick = refresh; };
  const refresh = async () => {
    el.innerHTML = '<h3>Reference information</h3><p class="muted">Looking up…</p>';
    try {
      const info = await lookup(e.scientificName, e.group, { force: true });
      e.taxonInfo = info; e.updatedAt = new Date().toISOString();
      await db.put('entries', e);
      draw(info);
    } catch { el.innerHTML = '<h3>Reference information</h3><p class="muted">Offline — will look up automatically when you reconnect.</p>'; }
  };
  if (e.taxonInfo) draw(e.taxonInfo); else refresh();
}

function infoHTML(info) {
  if (!info) return '<p class="muted">No information.</p>';
  const g = info.gbif;
  const parts = [];
  if (!g) parts.push('<p class="warn">Name not found in the GBIF Backbone Taxonomy. Check spelling, or it may be a newly described or unpublished name.</p>');
  else {
    const label = { EXACT: 'Exact match', FUZZY: 'Fuzzy match — check spelling', HIGHERRANK: `Only matched at ${String(g.rank).toLowerCase()} level` }[g.matchType] || g.matchType;
    parts.push(`<p><span class="src">GBIF</span> ${esc(label)} · <em>${esc(g.scientificName)}</em> · ${esc(String(g.status || '').toLowerCase())}</p>`);
    if (g.status && g.status !== 'ACCEPTED' && info.accepted) {
      parts.push(`<p class="warn">Treated as a synonym. Accepted name: <em>${esc(info.accepted.scientificName)}</em>
        <button type="button" class="btn btn-small btn-outline" data-use-accepted="${esc(info.accepted.canonicalName)}">Use accepted name</button></p>`);
    }
    parts.push(`<p class="classif">${[g.kingdom, g.phylum, g.class, g.order, g.family, g.genus].filter(Boolean).map(esc).join(' › ')}</p>`);
  }
  if (info.inat?.commonName) parts.push(`<p><span class="src">iNaturalist</span> Common name: ${esc(info.inat.commonName)}</p>`);
  if (info.counts) parts.push(`<p><span class="src">GBIF</span> Occurrence records: ${info.counts.global != null ? info.counts.global.toLocaleString() : 'not reported'} worldwide · ${info.counts.india != null ? info.counts.india.toLocaleString() : 'not reported'} in India <span class="muted small">(unverified aggregate counts)</span></p>`);
  if (info.wiki) parts.push(`<div class="wiki">${info.wiki.thumb ? `<img src="${esc(info.wiki.thumb)}" alt="">` : ''}<p><span class="src">Wikipedia</span> ${esc(info.wiki.extract)}</p></div>`);
  const links = [g && `<a href="${esc(g.url)}" target="_blank" rel="noopener">GBIF</a>`, info.inat && `<a href="${esc(info.inat.url)}" target="_blank" rel="noopener">iNaturalist</a>`,
    info.wiki?.url && `<a href="${esc(info.wiki.url)}" target="_blank" rel="noopener">Wikipedia</a>`,
    g && `<a href="https://powo.science.kew.org/results?q=${encodeURIComponent(g.canonicalName || info.query)}" target="_blank" rel="noopener">POWO</a>`].filter(Boolean);
  parts.push(`<p class="links">${links.join(' · ')}</p>`);
  parts.push(`<p class="muted small">Fetched ${esc(new Date(info.fetchedAt).toLocaleDateString())}${info.errors?.length ? ` · unavailable: ${esc(info.errors.join(', '))}` : ''}. Verify against a flora before publishing.</p>`);
  return parts.join('');
}

/* ================= MAP ================= */
function speciesIndex() {
  const idx = new Map();
  for (const e of state.entries) {
    const k = speciesKey(e); if (!k) continue;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(e);
  }
  return idx;
}

async function renderMap(view, _arg, params) {
  const idx = speciesIndex();
  const names = [...idx.keys()].sort();
  const sel = params.taxon || '__all';
  view.innerHTML = `
    <div class="map-controls">
      <select id="mapTaxon" aria-label="Show species">
        <option value="__all">All records (${state.entries.length})</option>
        <option value="__draft">Drafts only (${state.entries.filter((e) => e.status === 'draft').length})</option>
        ${names.length ? `<optgroup label="Species heatmap">${names.map((n) => `<option value="${esc(n)}" ${n === sel ? 'selected' : ''}>${esc(n)} (${idx.get(n).length})</option>`).join('')}</optgroup>` : ''}
      </select>
      <div class="seg seg-small" id="mapMode">
        <button type="button" data-m="both" class="on">Heat + points</button><button type="button" data-m="heat">Heat</button><button type="button" data-m="points">Points</button>
      </div>
    </div>
    <div id="bigMap" class="big-map"></div>
    <div class="legend"><span class="lg-heat"></span> fewer → more records <span class="dot dot-id"></span> identified <span class="dot dot-draft"></span> draft</div>`;
  if (sel !== '__all') $('#mapTaxon').value = sel;
  const map = state.map = createMap($('#bigMap'));
  let heat = null, pts = null, mode = 'both';
  const draw = async (fit) => {
    const v = $('#mapTaxon').value;
    const list = v === '__all' ? state.entries : v === '__draft' ? state.entries.filter((e) => e.status === 'draft') : (idx.get(v) || []);
    const geo = list.filter((e) => e.lat != null && e.lng != null);
    const thumbs = await thumbsFor(geo);
    if (state.map !== map) return;
    if (heat) map.removeLayer(heat);
    if (pts) map.removeLayer(pts);
    heat = heatLayer(geo);
    pts = pointsLayer(geo, { thumbs, onOpen: (id) => { location.hash = `#/entry/${id}`; } });
    if (mode !== 'points') heat.addTo(map);
    if (mode !== 'heat') pts.addTo(map);
    if (fit) fitTo(map, geo);
  };
  $('#mapTaxon').onchange = () => { history.replaceState(null, '', `#/map${$('#mapTaxon').value !== '__all' ? `?taxon=${encodeURIComponent($('#mapTaxon').value)}` : ''}`); draw(true); };
  $('#mapMode').onclick = (ev) => {
    const b = ev.target.closest('[data-m]'); if (!b) return;
    mode = b.dataset.m; $$('#mapMode button').forEach((x) => x.classList.toggle('on', x === b)); draw(false);
  };
  setTimeout(() => { if (state.map === map) map.invalidateSize(); }, 50);
  await draw(true);
}

/* ================= SPECIES LIST ================= */
async function renderSpecies(view) {
  const idx = speciesIndex();
  const rows = [...idx.entries()].map(([name, list]) => {
    const alts = list.map((e) => e.altitude).filter((a) => a != null);
    const fam = list.find((e) => e.family)?.family || '';
    const common = list.find((e) => e.commonName)?.commonName || '';
    return { name, list, fam, common, n: list.length, alts, photo: list.find((e) => e.photoIds?.length)?.photoIds[0] };
  });
  const drafts = state.entries.filter((e) => e.status === 'draft').length;
  view.innerHTML = `
    <div class="page-head"><h1>Species</h1><span class="muted">${rows.length} taxa · ${new Set(rows.map((r) => r.fam).filter(Boolean)).size} families</span></div>
    <div class="toolbar">
      <input id="spSearch" type="search" placeholder="Search species or family…" />
      <div class="chips" id="spSort">
        <button type="button" class="chip on" data-s="family">By family</button>
        <button type="button" class="chip" data-s="count">Most records</button>
        <button type="button" class="chip" data-s="name">A–Z</button>
      </div>
    </div>
    ${drafts ? `<a class="draft-row" href="#/records?filter=draft"><span>❓ ${drafts} unidentified draft${drafts === 1 ? '' : 's'}</span><span>Identify →</span></a>` : ''}
    <div id="spList"></div>`;
  const thumbs = new Map();
  for (const r of rows) thumbs.set(r.name, await thumbURL(r.photo));
  let sort = 'family';
  const card = (r) => `<a class="entry-card" href="#/taxon/${encodeURIComponent(r.name)}">
      <div class="thumb">${thumbs.get(r.name) ? `<img src="${thumbs.get(r.name)}" alt="" loading="lazy">` : '<span>🌿</span>'}</div>
      <div class="entry-text"><div class="entry-name sci">${esc(r.name)}</div>
        <div class="entry-sub">${esc([r.common, sort !== 'family' ? r.fam : ''].filter(Boolean).join(' · '))}</div>
        <div class="entry-meta">${r.n} record${r.n === 1 ? '' : 's'}${r.alts.length ? ` · ${Math.min(...r.alts)}–${Math.max(...r.alts)} m` : ''}</div></div></a>`;
  const draw = () => {
    const q = $('#spSearch').value.trim().toLowerCase();
    let list = rows.filter((r) => !q || `${r.name} ${r.fam} ${r.common}`.toLowerCase().includes(q));
    if (!list.length) { $('#spList').innerHTML = `<div class="empty"><p>${rows.length ? 'No match.' : 'Identified species appear here once you save records with a scientific name.'}</p></div>`; return; }
    if (sort === 'count') list.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    else list.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'family') {
      const fams = new Map();
      for (const r of list) { const f = r.fam || 'Family not reported'; if (!fams.has(f)) fams.set(f, []); fams.get(f).push(r); }
      $('#spList').innerHTML = [...fams.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([f, rs]) => `<h3 class="fam-head">${esc(f)} <span class="muted">${rs.length}</span></h3><div class="list">${rs.map(card).join('')}</div>`).join('');
    } else $('#spList').innerHTML = `<div class="list">${list.map(card).join('')}</div>`;
  };
  $('#spSearch').addEventListener('input', debounce(draw, 150));
  $('#spSort').onclick = (ev) => { const b = ev.target.closest('[data-s]'); if (!b) return; sort = b.dataset.s; $$('#spSort .chip').forEach((c) => c.classList.toggle('on', c === b)); draw(); };
  draw();
}

/* ================= SPECIES PAGE (own heatmap) ================= */
async function renderTaxon(view, name) {
  const list = speciesIndex().get(name) || [];
  if (!list.length) { view.innerHTML = `<div class="empty"><p>No identified records of <em>${esc(name)}</em>.</p></div>`; return; }
  const geo = list.filter((e) => e.lat != null);
  const alts = list.map((e) => e.altitude).filter((a) => a != null);
  const dates = list.map((e) => e.date).filter(Boolean).sort();
  const months = Array(12).fill(0), flowering = Array(12).fill(0);
  for (const e of list) if (e.date) { const m = +e.date.slice(5, 7) - 1; months[m]++; if ((e.phenology || []).includes('Flowering')) flowering[m]++; }
  const maxM = Math.max(1, ...months);
  const fam = list.find((e) => e.family)?.family;
  const common = list.find((e) => e.commonName)?.commonName;
  const info = list.find((e) => e.taxonInfo)?.taxonInfo;
  const photos = [];
  for (const e of list) for (const pid of e.photoIds || []) { if (photos.length >= 12) break; const u = await thumbURL(pid); if (u) photos.push({ u, id: e.id }); }
  const tmap = await thumbsFor(list);

  view.innerHTML = `
    <div class="page-head"><button class="icon-btn" type="button" id="txBack" aria-label="Back">←</button></div>
    <section class="detail-head">
      <p class="eyebrow">${esc(fam || 'Family not reported')}</p>
      <h1 class="sci">${esc(name)}</h1>
      ${common ? `<p class="muted">${esc(common)}</p>` : ''}
    </section>
    <section class="stats">
      <div class="stat"><b>${list.length}</b><span>Records</span></div>
      <div class="stat stat-sm"><b>${alts.length ? `${Math.min(...alts)}–${Math.max(...alts)}` : '—'}</b><span>Altitude (m)</span></div>
      <div class="stat stat-sm"><b>${dates.length ? fmtDate(dates[0]) : '—'}</b><span>First seen</span></div>
      <div class="stat stat-sm"><b>${dates.length ? fmtDate(dates.at(-1)) : '—'}</b><span>Last seen</span></div>
    </section>
    <section class="block">
      <div class="block-head"><h2>Distribution heatmap</h2><a href="#/map?taxon=${encodeURIComponent(name)}">Full map →</a></div>
      ${geo.length ? '<div id="txMap" class="mid-map"></div>' : `<p class="muted">No records with coordinates.</p>`}
      ${geo.length < list.length ? `<p class="muted small">${list.length - geo.length} record(s) without coordinates not shown.</p>` : ''}
    </section>
    <section class="block">
      <h2>Seasonality</h2>
      <div class="months">${months.map((c, i) => `<div class="mbar" title="${MONTHS[i]}: ${c} record(s), ${flowering[i]} flowering">
        <div class="mfill" style="height:${(c / maxM) * 100}%"><div class="mflower" style="height:${c ? (flowering[i] / c) * 100 : 0}%"></div></div><span>${MONTHS[i][0]}</span></div>`).join('')}</div>
      <p class="muted small"><span class="dot dot-id"></span> records per month · <span class="dot dot-flower"></span> share recorded flowering</p>
    </section>
    ${photos.length ? `<section class="block"><h2>Photos</h2><div class="photo-grid">${photos.map((p) => `<a href="#/entry/${p.id}"><img src="${p.u}" alt="" loading="lazy"></a>`).join('')}</div></section>` : ''}
    ${info ? `<section class="card"><h3>Reference information</h3>${infoHTML(info)}</section>` : ''}
    <section class="block"><h2>Records</h2><div class="list">${list.map((e) => entryCard(e, tmap.get(e.id))).join('')}</div></section>`;
  $('#txBack').onclick = () => history.back();
  if (geo.length) {
    const map = state.map = createMap($('#txMap'));
    heatLayer(geo).addTo(map);
    pointsLayer(geo, { thumbs: tmap, onOpen: (id) => { location.hash = `#/entry/${id}`; } }).addTo(map);
    setTimeout(() => { if (state.map !== map) return; map.invalidateSize(); fitTo(map, geo); }, 50);
  }
}

/* ================= MORE ================= */
async function renderMore(view) {
  const est = await storageEstimate();
  const mb = (b) => (b / 1048576).toFixed(1);
  view.innerHTML = `
    <div class="page-head"><h1>Backup &amp; settings</h1></div>
    <section class="card">
      <h3>Storage on this device</h3>
      <p>${state.entries.length} records. ${est ? `${mb(est.usage)} MB used${est.quota ? ` of ~${Math.round(est.quota / 1073741824)} GB available` : ''}.` : ''}</p>
      ${isNative() ? `<p class="muted small">Records and photos are stored inside the Field Notes app on this phone. Uninstalling the app or using “Clear storage” in Android settings deletes them — export a full backup regularly.</p>`
      : `<p class="${est?.persisted ? 'ok' : 'warn'}">${est?.persisted ? '✓ Storage is marked persistent — the browser won’t clear it automatically.' : 'Storage is not yet persistent. Installing the app (Add to Home screen) and tapping below helps prevent the browser from clearing it.'}</p>
      ${est?.persisted ? '' : '<button class="btn btn-outline" id="persistBtn" type="button">Keep my data persistent</button>'}
      <p class="muted small">Data lives only in this browser on this phone. Export a backup regularly — clearing site data or uninstalling the browser deletes it.</p>`}
    </section>
    <section class="card">
      <h3>Export</h3>
      <div class="stack">
        <button class="btn btn-primary" id="expJson" type="button">Full backup (.json, with photos)</button>
        <button class="btn btn-outline" id="expCsv" type="button">Spreadsheet (.csv, Darwin Core columns)</button>
        <button class="btn btn-outline" id="expGeo" type="button">Map points (.geojson for QGIS)</button>
      </div>
    </section>
    <section class="card">
      <h3>Import</h3>
      <p class="muted small">Merges a Field Notes backup. Records already on this device are kept unless the backup copy is newer.</p>
      <button class="btn btn-outline" id="impBtn" type="button">Import backup…</button>
    </section>
    <section class="card">
      <h3>Settings</h3>
      <label class="field"><span>Recorder / collector name</span><input id="setRecorder" value="${esc(state.settings.recorder)}" placeholder="Used for new records and exports" /></label>
    </section>
    <section class="card">
      <h3>About the web lookups</h3>
      <p class="muted small">When online, names are checked against the GBIF Backbone Taxonomy (family, accepted name, synonyms, occurrence counts), iNaturalist (common names) and Wikipedia (short description). Results are saved with their source and date and stay available offline. Altitude falls back to a 90 m elevation model when the phone’s GPS gives none, and is labelled as such. Map tiles you have viewed are cached for offline use.</p>
    </section>`;
  $('#persistBtn')?.addEventListener('click', async () => { const ok = await requestPersistence(); toast(ok ? 'Storage is now persistent.' : 'The browser declined — install the app to the home screen and try again.'); router(); });
  $('#expJson').onclick = async () => { toast('Preparing backup…'); const data = await exportBackup(); download(`field-notes-backup-${todayISO()}.json`, JSON.stringify(data), 'application/json'); };
  $('#expCsv').onclick = () => download(`field-notes-${todayISO()}.csv`, toCSV(state.entries), 'text/csv');
  $('#expGeo').onclick = () => download(`field-notes-${todayISO()}.geojson`, toGeoJSON(state.entries), 'application/geo+json');
  $('#impBtn').onclick = () => $('#importInput').click();
  $('#setRecorder').addEventListener('change', async (ev) => { state.settings.recorder = ev.target.value.trim(); await setMeta('settings', state.settings); toast('Saved.'); });
}

async function download(filename, text, type) {
  if (isNative()) {
    try { await shareTextFile(filename, text); } catch (err) { toast(`Export failed: ${err.message || err}`); }
    return;
  }
  const blob = new Blob([text], { type });
  const file = new File([blob], filename, { type });
  if (navigator.canShare?.({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function toCSV(entries) {
  const cols = ['occurrenceID', 'identificationStatus', 'scientificName', 'scientificNameAuthorship', 'family', 'genus', 'taxonRank', 'vernacularName', 'localName',
    'identificationQualifier', 'fieldLabel', 'eventDate', 'eventTime', 'decimalLatitude', 'decimalLongitude', 'coordinateUncertaintyInMeters',
    'minimumElevationInMeters', 'elevationSource', 'locality', 'habitat', 'reproductiveCondition', 'abundance', 'recordedBy', 'recordNumber', 'herbarium',
    'occurrenceRemarks', 'tags', 'ethnoUse', 'ethnoPartUsed', 'ethnoPreparation', 'ethnoCommunity', 'photoCount', 'gbifTaxonKey'];
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = entries.map((e) => [e.id, e.status, e.scientificName, e.authorship, e.family, e.genus, e.rank, e.commonName, e.localName,
    e.scientificName && e.idConfidence === 'tentative' ? 'cf.' : '', e.fieldLabel, e.date, e.time, e.lat, e.lng, e.accuracy,
    e.altitude, e.altitudeSource, e.locality, e.habitat, (e.phenology || []).join('|'), e.abundance, e.voucher?.collector || e.recordedBy, e.voucher?.number, e.voucher?.herbarium,
    e.notes, (e.tags || []).join('|'), e.ethno?.use, e.ethno?.part, e.ethno?.prep, e.ethno?.community, (e.photoIds || []).length, e.taxonInfo?.gbif?.usageKey].map(q).join(','));
  return '﻿' + [cols.join(','), ...rows].join('\n');
}

function toGeoJSON(entries) {
  return JSON.stringify({ type: 'FeatureCollection', features: entries.filter((e) => e.lat != null).map((e) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: e.altitude != null ? [e.lng, e.lat, e.altitude] : [e.lng, e.lat] },
    properties: { id: e.id, status: e.status, scientificName: e.scientificName || null, fieldLabel: e.fieldLabel || null, family: e.family || null,
      date: e.date, altitude: e.altitude, accuracy: e.accuracy, locality: e.locality || null, phenology: (e.phenology || []).join('|') },
  })) }, null, 1);
}

$('#importInput').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; ev.target.value = '';
  if (!f) return;
  try {
    const r = await importBackup(JSON.parse(await f.text()));
    await loadEntries();
    toast(`Imported: ${r.added} new, ${r.updated} updated, ${r.skipped} unchanged.`);
    router();
  } catch (err) { toast(`Import failed: ${err.message}`); }
});

/* ================= PHOTO VIEWER ================= */
function openViewer(src) {
  const v = $('#viewer'); $('img', v).src = src; v.classList.remove('hidden');
  pushOverlay('viewer', () => v.classList.add('hidden'));
}
$('#viewer').addEventListener('click', () => {
  if ($('#viewer').classList.contains('hidden')) return;
  $('#viewer').classList.add('hidden'); popOverlay('viewer');
});

/* ================= PHOTO INTAKE ================= */
async function savePhotoFile(fileOrBlob) {
  const p = await processPhoto(fileOrBlob);
  const id = uid();
  await db.put('photos', { id, blob: p.blob, thumb: p.thumb, w: p.w, h: p.h, addedAt: new Date().toISOString(), exif: p.exif });
  return { id, exif: p.exif };
}

async function intakeFiles(files) {
  if (!files.length) return;
  toast(`Processing ${files.length} photo${files.length > 1 ? 's' : ''}…`, { ms: 8000 });
  const saved = [];
  for (const f of files) {
    try { saved.push(await savePhotoFile(f)); } catch (err) { console.error(err); toast(`Could not read a photo: ${err.message}`); }
  }
  if (!saved.length) return;
  $('#toast').classList.remove('show');
  if (form.open) { for (const s of saved) await form.addPhoto(s.id, s.exif); }
  else if (camera.open) { for (const s of saved) await camera.addShot(s.id); }
  else await openForm({ photos: saved });
}
$('#nativeCamInput').addEventListener('change', (ev) => { const files = [...ev.target.files]; ev.target.value = ''; intakeFiles(files); });
$('#galleryInput').addEventListener('change', (ev) => { const files = [...ev.target.files]; ev.target.value = ''; intakeFiles(files); });

/* ================= CAMERA ================= */
const camera = {
  open: false, live: null, shots: [], fix: null, gpsRun: 0,

  async start() {
    if (!LiveCamera.supported()) { $('#nativeCamInput').click(); return; }
    this.open = true; this.shots = []; this.fix = null;
    $('#camStrip').innerHTML = '';
    this.updateButtons();
    $('#camError').classList.add('hidden');
    $('#cameraSheet').classList.remove('hidden');
    document.body.classList.add('no-scroll');
    pushOverlay('camera', () => this.close('back'));
    this.locate();
    this.live = this.live || new LiveCamera($('#cameraVideo'));
    try {
      await this.live.start();
      $('#camTorch').classList.toggle('hidden', !this.live.torchSupported());
    } catch (err) {
      const denied = err.name === 'NotAllowedError';
      const el = $('#camError');
      el.innerHTML = `${denied ? 'Camera permission was blocked for this site.' : 'Could not start the in-app camera.'}<br>
        <button type="button" class="btn btn-primary" id="camNative">Use phone camera app</button>`;
      el.classList.remove('hidden');
      $('#camNative').onclick = () => $('#nativeCamInput').click();
    }
  },

  async locate() {
    const run = ++this.gpsRun;
    $('#camGps').textContent = 'Locating…';
    try {
      this.fix = await getBestFix({ maxMs: 30000, goodEnough: 10, onUpdate: (f) => { if (run === this.gpsRun) { this.fix = f; $('#camGps').textContent = `GPS ±${f.accuracy} m`; } } });
      if (run === this.gpsRun) $('#camGps').textContent = `GPS ±${this.fix.accuracy} m`;
    } catch (err) { if (run === this.gpsRun) $('#camGps').textContent = 'No GPS'; }
  },

  async snap() {
    const btn = $('#camShutter');
    if (btn.disabled || !this.live?.stream) return;
    btn.disabled = true;
    $('#cameraSheet').classList.add('flash');
    setTimeout(() => $('#cameraSheet').classList.remove('flash'), 150);
    try {
      const blob = await this.live.snap();
      const { id } = await savePhotoFile(blob);
      await this.addShot(id);
    } catch (err) { toast(`Capture failed: ${err.message}`); }
    finally { btn.disabled = false; }
  },

  async addShot(id) {
    this.shots.push(id);
    const img = document.createElement('img');
    img.src = await thumbURL(id);
    $('#camStrip').appendChild(img);
    img.scrollIntoView({ inline: 'end', behavior: 'smooth' });
    this.updateButtons();
    // Safety net: if the browser kills the page, the photos can be restored.
    await setMeta('unsavedForm', { values: { date: todayISO(), time: nowHM() }, photoIds: this.shots, isNew: true, fix: this.fix });
  },

  updateButtons() {
    const n = this.shots.length;
    $('#camDone').disabled = !n; $('#camQuickDraft').disabled = !n;
    $('#camDone').textContent = n ? `Next: details (${n}) →` : 'Next: details →';
  },

  // Save current shots straight away as an unidentified draft and keep shooting.
  async quickDraft() {
    if (!this.shots.length) return;
    const fix = this.fix;
    const e = baseEntry();
    Object.assign(e, { status: 'draft', photoIds: [...this.shots], fieldLabel: `Unidentified · ${nowHM()}` });
    if (fix) Object.assign(e, { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, altitude: fix.altitude, altitudeSource: fix.altitude != null ? `GPS ±${fix.altitudeAccuracy ?? '?'} m` : '' });
    await db.put('entries', e);
    await delMeta('unsavedForm');
    requestPersistence();
    await loadEntries();
    fillAltitudeLater(e);
    this.shots = []; $('#camStrip').innerHTML = ''; this.updateButtons();
    toast('Saved as draft. Next plant!');
  },

  async done() {
    const shots = [...this.shots], fix = this.fix;
    this.shots = [];
    this.close('handoff');
    await openForm({ photos: shots.map((id) => ({ id })), fix, fromCamera: true });
  },

  // how: 'back' (Android back button), 'handoff' (going to the form), or undefined (✕ button)
  close(how) {
    if (!this.open) return;
    this.open = false;
    this.gpsRun++;
    this.live?.stop();
    $('#cameraSheet').classList.add('hidden');
    document.body.classList.remove('no-scroll');
    if (!how) popOverlay('camera');
    if (this.shots.length) {
      // Closed with unsaved photos: keep them as a draft rather than losing them.
      this.quickDraft();
    } else if (how !== 'handoff') delMeta('unsavedForm');
  },
};

$('#cameraFab').addEventListener('click', () => (form.open ? $('#nativeCamInput').click() : camera.start()));
$('#camShutter').addEventListener('click', () => camera.snap());
$('#camClose').addEventListener('click', () => camera.close());
$('#camFlip').addEventListener('click', async () => { try { await camera.live.flip(); } catch (err) { toast(err.message); } });
$('#camGallery').addEventListener('click', () => $('#galleryInput').click());
$('#camDone').addEventListener('click', () => camera.done());
$('#camQuickDraft').addEventListener('click', () => camera.quickDraft());
let torchOn = false;
$('#camTorch').addEventListener('click', () => { torchOn = !torchOn; camera.live.setTorch(torchOn); $('#camTorch').classList.toggle('on', torchOn); });
document.addEventListener('keydown', (ev) => { if (camera.open && (ev.key === ' ' || ev.key === 'Enter') && ev.target === document.body) { ev.preventDefault(); camera.snap(); } });

/* ================= ENTRY FORM ================= */
function baseEntry() {
  const now = new Date().toISOString();
  return {
    id: uid(), createdAt: now, updatedAt: now, status: 'draft', group: 'Plant',
    scientificName: '', authorship: '', family: '', genus: '', rank: '', commonName: '', localName: '',
    idConfidence: 'certain', fieldLabel: '', date: todayISO(), time: nowHM(),
    lat: null, lng: null, accuracy: null, altitude: null, altitudeSource: '',
    locality: '', habitat: '', phenology: [], abundance: '', notes: '', tags: [],
    voucher: { collector: state.settings.recorder || '', number: '', herbarium: '' }, ethno: {},
    recordedBy: state.settings.recorder || '', photoIds: [], taxonInfo: null,
  };
}

const F = {
  scientificName: '#fScientific', family: '#fFamily', genus: '#fGenus', commonName: '#fCommon', localName: '#fLocal',
  idConfidence: '#fConfidence', fieldLabel: '#fLabel', lat: '#fLat', lng: '#fLng', altitude: '#fAlt', accuracy: '#fAcc',
  date: '#fDate', time: '#fTime', locality: '#fLocality', habitat: '#fHabitat', abundance: '#fAbundance', notes: '#fNotes',
};
const ETHNO = { use: '#eUse', part: '#ePart', prep: '#ePrep', community: '#eCommunity', informant: '#eInformant', age: '#eAge', gender: '#eGender', consent: '#eConsent' };
const NUM = new Set(['lat', 'lng', 'altitude', 'accuracy']);

const form = {
  open: false, entry: null, isNew: true, photoIds: [], originalPhotoIds: [], group: 'Plant', pheno: new Set(),
  auto: new Set(),        // field names last filled automatically (safe to overwrite)
  altitudeSource: '', taxonInfo: null, lookedUpName: '', dirty: false, gpsRun: 0,

  fill(e) {
    for (const [k, sel] of Object.entries(F)) $(sel).value = e[k] ?? '';
    $('#fTags').value = (e.tags || []).join(', ');
    $('#fCollector').value = e.voucher?.collector || ''; $('#fCollNo').value = e.voucher?.number || ''; $('#fHerbarium').value = e.voucher?.herbarium || '';
    for (const [k, sel] of Object.entries(ETHNO)) $(sel).value = e.ethno?.[k] ?? '';
    $('#fDraft').checked = e.status === 'draft' && !this.isNew;
    this.group = e.group || 'Plant';
    this.pheno = new Set(e.phenology || []);
    this.altitudeSource = e.altitudeSource || '';
    this.taxonInfo = e.taxonInfo || null;
    this.lookedUpName = e.taxonInfo ? e.scientificName : '';
    $('#voucherBox').open = !!(e.voucher?.number);
    $('#ethnoBox').open = !!(e.ethno && Object.values(e.ethno).some(Boolean));
    this.renderGroup(); this.renderPheno(); this.renderAltSource();
    $('#lookupPanel').classList.toggle('hidden', !this.taxonInfo);
    if (this.taxonInfo) $('#lookupPanel').innerHTML = infoHTML(this.taxonInfo);
  },

  read() {
    const e = { ...this.entry };
    for (const [k, sel] of Object.entries(F)) {
      const v = $(sel).value.trim();
      e[k] = NUM.has(k) ? (v === '' ? null : Number(v)) : v;
    }
    if (e.altitude != null) e.altitude = Math.round(e.altitude);
    e.scientificName = normName(e.scientificName);
    e.tags = $('#fTags').value.split(',').map((t) => t.trim()).filter(Boolean);
    e.voucher = { collector: $('#fCollector').value.trim(), number: $('#fCollNo').value.trim(), herbarium: $('#fHerbarium').value.trim() };
    e.ethno = Object.fromEntries(Object.entries(ETHNO).map(([k, sel]) => [k, $(sel).value.trim()]));
    e.group = this.group; e.phenology = [...this.pheno]; e.photoIds = [...this.photoIds];
    e.altitudeSource = e.altitude != null ? this.altitudeSource || 'Manual' : '';
    e.taxonInfo = this.taxonInfo && this.lookedUpName && normName(this.lookedUpName) === e.scientificName ? this.taxonInfo : null;
    if (e.taxonInfo) { const f = fieldsFrom(e.taxonInfo); e.authorship = f.authorship || ''; e.rank = f.rank || ''; }
    else if (!e.scientificName) { e.authorship = ''; e.rank = ''; }
    return e;
  },

  renderGroup() {
    $('#groupSeg').innerHTML = Object.keys(GROUPS).map((g) => `<button type="button" role="radio" aria-checked="${g === this.group}" class="${g === this.group ? 'on' : ''}" data-g="${g}">${GROUPS[g].icon} ${g}</button>`).join('');
  },
  renderPheno() {
    $('#phenoChips').innerHTML = PHENO.map((p) => `<button type="button" class="chip ${this.pheno.has(p) ? 'on' : ''}" data-p="${p}">${p}</button>`).join('');
  },
  renderAltSource() { $('#altSource').textContent = $('#fAlt').value ? `Altitude source: ${this.altitudeSource || 'Manual'}` : ''; },

  async renderPhotos() {
    const html = [];
    for (const id of this.photoIds) {
      const u = await thumbURL(id);
      html.push(`<div class="ph"><img src="${u || ''}" alt=""><button type="button" class="ph-x" data-rm="${id}" aria-label="Remove photo">✕</button></div>`);
    }
    $('#formPhotos').innerHTML = html.join('') || '<p class="muted small ph-empty">No photos yet</p>';
  },

  async addPhoto(id, exif = {}) {
    this.photoIds.push(id);
    await this.renderPhotos();
    // A gallery photo may carry its own GPS and date — use them if the form has none yet.
    if (exif.lat != null && $('#fLat').value === '') {
      this.gpsRun++;
      this.setAuto('lat', exif.lat); this.setAuto('lng', exif.lng); $('#fAcc').value = '';
      if (exif.alt != null) { this.setAuto('altitude', exif.alt); this.altitudeSource = 'Photo EXIF GPS'; this.renderAltSource(); }
      $('#gpsStatus').textContent = 'Location taken from photo';
      this.afterFix({ lat: exif.lat, lng: exif.lng, altitude: exif.alt ?? null });
    }
    if (exif.date && this.isNew && this.auto.has('date')) { this.setAuto('date', exif.date); if (exif.time) this.setAuto('time', exif.time); }
    this.changed();
  },

  setAuto(name, value) { $(F[name]).value = value ?? ''; this.auto.add(name); },
  canAuto(name) { return $(F[name]).value === '' || this.auto.has(name); },

  async locate() {
    const run = ++this.gpsRun;
    const st = $('#gpsStatus');
    st.textContent = 'Getting GPS fix…';
    $('#gpsBtn').disabled = true;
    try {
      const fix = await getBestFix({ maxMs: 20000, onUpdate: (f) => { if (run === this.gpsRun) { st.textContent = `Improving… ±${f.accuracy} m`; this.applyFix(f); } } });
      if (run !== this.gpsRun) return;
      this.applyFix(fix);
      st.textContent = `GPS fix ±${fix.accuracy} m`;
      this.afterFix(fix);
    } catch (err) { if (run === this.gpsRun) st.textContent = err.message; }
    finally { $('#gpsBtn').disabled = false; }
  },

  applyFix(fix) {
    this.setAuto('lat', fix.lat); this.setAuto('lng', fix.lng); this.setAuto('accuracy', fix.accuracy);
    if (fix.altitude != null && this.canAuto('altitude')) {
      this.setAuto('altitude', fix.altitude);
      this.altitudeSource = `GPS ±${fix.altitudeAccuracy ?? '?'} m`;
    }
    this.renderAltSource(); this.changed();
  },

  async afterFix(fix) {
    if (!navigator.onLine) return;
    if (fix.altitude == null && this.canAuto('altitude')) {
      try {
        const z = await demElevation(fix.lat, fix.lng);
        if (z != null && this.canAuto('altitude')) { this.setAuto('altitude', z); this.altitudeSource = 'Elevation model (Copernicus 90 m)'; this.renderAltSource(); this.changed(); }
      } catch { /* leave empty */ }
    }
    if (this.canAuto('locality')) {
      try { const name = await placeName(fix.lat, fix.lng); if (name && this.canAuto('locality')) { this.setAuto('locality', name); this.changed(); } } catch { /* ignore */ }
    }
  },

  changed() { this.dirty = true; this.autosave(); },
  autosave: debounce(async function () {
    if (!form.open) return;
    await setMeta('unsavedForm', { values: form.read(), photoIds: form.photoIds, isNew: form.isNew, originalPhotoIds: form.originalPhotoIds });
  }, 500),
};

for (const [name, sel] of Object.entries(F)) $(sel).addEventListener('input', () => { form.auto.delete(name); if (name === 'scientificName') $('#fDraft').checked = false; if (name === 'altitude') { form.altitudeSource = 'Manual'; form.renderAltSource(); } form.changed(); });
$('#entryForm').addEventListener('input', (ev) => { if (!Object.values(F).some((s) => ev.target.matches(s))) form.changed(); });
$('#groupSeg').addEventListener('click', (ev) => { const b = ev.target.closest('[data-g]'); if (!b) return; form.group = b.dataset.g; form.renderGroup(); form.changed(); });
$('#phenoChips').addEventListener('click', (ev) => { const b = ev.target.closest('[data-p]'); if (!b) return; const p = b.dataset.p; form.pheno.has(p) ? form.pheno.delete(p) : form.pheno.add(p); form.renderPheno(); form.changed(); });
$('#formPhotos').addEventListener('click', (ev) => {
  const rm = ev.target.closest('[data-rm]');
  if (rm) { form.photoIds = form.photoIds.filter((x) => x !== rm.dataset.rm); form.renderPhotos(); form.changed(); return; }
  const img = ev.target.closest('img'); if (img) openViewer(img.src);
});
$('#formCamera').addEventListener('click', () => $('#nativeCamInput').click());
$('#formGallery').addEventListener('click', () => $('#galleryInput').click());
$('#gpsBtn').addEventListener('click', () => form.locate());

/* ----- name search + lookup ----- */
let suggestRun = 0;
const runSuggest = debounce(async () => {
  const q = $('#fScientific').value;
  const list = $('#suggestList');
  const run = ++suggestRun;
  if (q.trim().length < 3 || !navigator.onLine) { list.classList.add('hidden'); return; }
  try {
    const res = await suggest(q, form.group);
    if (run !== suggestRun) return;
    list.innerHTML = res.map((r, i) => `<li role="option" data-i="${i}"><span class="sci">${esc(r.name)}</span>
      <small>${esc([r.common, r.family, r.rank && r.rank.toLowerCase(), r.source].filter(Boolean).join(' · '))}</small></li>`).join('');
    list.classList.toggle('hidden', !res.length);
    list.onclick = (ev) => {
      const li = ev.target.closest('li'); if (!li) return;
      const r = res[+li.dataset.i];
      $('#fScientific').value = r.name;
      list.classList.add('hidden');
      form.changed();
      runLookup();
    };
  } catch { list.classList.add('hidden'); }
}, 300);
$('#fScientific').addEventListener('input', () => { $('#lookupPanel').classList.add('hidden'); runSuggest(); });
$('#fScientific').addEventListener('blur', () => setTimeout(() => $('#suggestList').classList.add('hidden'), 200));
$('#fScientific').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); $('#suggestList').classList.add('hidden'); runLookup(); } });
$('#lookupBtn').addEventListener('click', () => runLookup(true));

async function runLookup(force = false) {
  const name = normName($('#fScientific').value);
  const panel = $('#lookupPanel');
  if (!name) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  panel.innerHTML = '<p class="muted">Looking up family and details…</p>';
  try {
    const info = await lookup(name, form.group, { force });
    if (normName($('#fScientific').value) !== name) return;   // user kept typing
    form.taxonInfo = info; form.lookedUpName = name;
    applyLookup(info);
    panel.innerHTML = infoHTML(info);
    $$('[data-use-accepted]', panel).forEach((b) => b.addEventListener('click', () => {
      $('#fScientific').value = b.dataset.useAccepted; form.auto.delete('family'); form.changed(); runLookup();
    }));
  } catch (err) {
    panel.innerHTML = '<p class="muted">Offline — you can still save. Family and details will be fetched automatically when you are back online.</p>';
  }
}

function applyLookup(info) {
  const f = fieldsFrom(info);
  for (const k of ['family', 'genus', 'commonName']) if (f[k] && form.canAuto(k)) form.setAuto(k, f[k]);
  form.changed();
}

/* ----- open / close / save ----- */
async function openForm({ entry = null, photos = [], fix = null, restore = null, focusName = false, fromCamera = false } = {}) {
  if (camera.open) camera.close();
  form.isNew = !entry;
  form.entry = entry ? structuredClone(entry) : baseEntry();
  form.photoIds = [...(form.entry.photoIds || []), ...photos.map((p) => p.id)];
  form.originalPhotoIds = restore?.originalPhotoIds || [...(entry?.photoIds || [])];
  form.auto = new Set(form.isNew ? ['date', 'time', 'locality'] : []);
  form.dirty = !!(photos.length || restore);
  form.fill(restore ? { ...form.entry, ...restore.values } : form.entry);
  if (restore) form.photoIds = restore.photoIds || [];
  $('#formTitle').textContent = form.isNew ? 'New observation' : 'Edit observation';
  $('#deleteBtn').classList.toggle('hidden', form.isNew);
  $('#gpsStatus').textContent = form.entry.accuracy != null && !form.isNew ? `Saved fix ±${form.entry.accuracy} m` : '';
  $('#suggestList').classList.add('hidden');
  await form.renderPhotos();
  $('#formSheet').classList.remove('hidden');
  $('#formSheet').scrollTop = 0;
  document.body.classList.add('no-scroll');
  form.open = true;
  if (fromCamera) swapOverlay('camera', 'form', () => closeForm({ viaBack: true }));
  else pushOverlay('form', () => closeForm({ viaBack: true }));
  if (restore?.fix && $('#fLat').value === '') form.applyFix(restore.fix);

  if (form.isNew && !restore) {
    const exif = photos.find((p) => p.exif?.lat != null)?.exif;
    if (fix) { form.applyFix(fix); $('#gpsStatus').textContent = `GPS fix ±${fix.accuracy} m (from camera)`; form.afterFix(fix); }
    else if (exif) { await form.addPhoto(form.photoIds.pop(), exif); }
    else form.locate();
    const exifDate = photos.find((p) => p.exif?.date)?.exif;
    if (exifDate) { form.setAuto('date', exifDate.date); if (exifDate.time) form.setAuto('time', exifDate.time); }
    form.changed();
  }
  if (focusName) setTimeout(() => $('#fScientific').focus(), 200);
}

async function closeForm({ viaBack = false, discard = false } = {}) {
  form.open = false;
  form.gpsRun++;
  $('#formSheet').classList.add('hidden');
  document.body.classList.remove('no-scroll');
  if (!viaBack) await popOverlay('form');
  if (discard) {
    // Remove photos that were added in this session and never saved.
    for (const id of form.photoIds) if (!form.originalPhotoIds.includes(id)) await db.del('photos', id);
    await delMeta('unsavedForm');
  } else if (viaBack && form.dirty) {
    toast('Entry kept — you can restore it.', { action: 'Restore', onAction: restoreForm, ms: 6000 });
    showRestoreBanner();
  }
}

$('#formClose').addEventListener('click', async () => {
  if (!form.dirty) return closeForm({ discard: true });
  const ok = await confirmBox(form.isNew ? 'Discard this observation? Its photos will be deleted.' : 'Discard your changes?', 'Discard');
  if (ok) closeForm({ discard: true });
});

$('#deleteBtn').addEventListener('click', async () => {
  if (!(await confirmBox('Delete this record and its photos? This cannot be undone.'))) return;
  const saved = await db.get('entries', form.entry.id);
  if (saved) await deleteEntry({ ...saved, photoIds: [...new Set([...(saved.photoIds || []), ...form.photoIds])] });
  await closeForm({ discard: true });
  await loadEntries();
  toast('Record deleted.');
  location.hash = '#/records';
});

$('#entryForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const mode = ev.submitter?.dataset.save || 'auto';
  const e = form.read();
  if (e.lat != null && (e.lat < -90 || e.lat > 90 || e.lng == null || e.lng < -180 || e.lng > 180)) { toast('Check the coordinates.'); $('#fLat').focus(); return; }
  const wantsDraft = mode === 'draft' || $('#fDraft').checked;
  e.status = !e.scientificName || wantsDraft ? 'draft' : 'identified';
  if (e.status === 'draft' && !e.scientificName && !e.fieldLabel) e.fieldLabel = `Unidentified${e.time ? ` · ${e.time}` : ''}`;
  e.recordedBy = e.recordedBy || state.settings.recorder;
  e.updatedAt = new Date().toISOString();

  // Photos removed during editing are deleted now that the change is saved.
  for (const id of form.originalPhotoIds) if (!e.photoIds.includes(id)) await db.del('photos', id);
  await db.put('entries', e);
  await delMeta('unsavedForm');
  form.dirty = false;
  requestPersistence();
  await closeForm({});
  await loadEntries();
  toast(e.status === 'draft' ? (e.scientificName ? 'Saved as draft.' : 'Saved as draft — identify it later from Records › Drafts.') : 'Saved.');
  if (e.scientificName && !e.taxonInfo) enrich(e);   // fetch family/details in the background
  if (location.hash === `#/entry/${e.id}`) router(); else location.hash = `#/entry/${e.id}`;
});

/* ----- restore after the page was closed or killed ----- */
async function showRestoreBanner() {
  const saved = await getMeta('unsavedForm');
  $('#restoreBanner').classList.toggle('hidden', !saved || form.open || camera.open);
}
async function restoreForm() {
  const saved = await getMeta('unsavedForm');
  $('#restoreBanner').classList.add('hidden');
  if (!saved) return;
  const entry = !saved.isNew && saved.values?.id ? await db.get('entries', saved.values.id) : null;
  await openForm({ entry, restore: saved });
}
$('#restoreYes').addEventListener('click', restoreForm);
$('#restoreNo').addEventListener('click', async () => {
  const saved = await getMeta('unsavedForm');
  if (saved) for (const id of saved.photoIds || []) if (!(saved.originalPhotoIds || []).includes(id)) await db.del('photos', id);
  await delMeta('unsavedForm');
  $('#restoreBanner').classList.add('hidden');
});

/* ================= background enrichment ================= */
async function enrich(e) {
  try {
    const info = await lookup(e.scientificName, e.group);
    const cur = await db.get('entries', e.id);
    if (!cur || cur.scientificName !== e.scientificName) return;
    const f = fieldsFrom(info);
    cur.taxonInfo = info;
    for (const k of ['family', 'genus', 'commonName', 'authorship', 'rank']) if (!cur[k] && f[k]) cur[k] = f[k];
    cur.updatedAt = new Date().toISOString();
    await db.put('entries', cur);
    await loadEntries();
  } catch { /* offline: retried on reconnect */ }
}
async function fillAltitudeLater(e) {
  if (e.altitude != null || e.lat == null || !navigator.onLine) return;
  try {
    const z = await demElevation(e.lat, e.lng);
    const cur = await db.get('entries', e.id);
    if (cur && cur.altitude == null && z != null) { cur.altitude = z; cur.altitudeSource = 'Elevation model (Copernicus 90 m)'; await db.put('entries', cur); }
  } catch { /* ignore */ }
}
async function enrichPending() {
  if (!navigator.onLine) return;
  const pending = state.entries.filter((e) => e.scientificName && !e.taxonInfo).slice(0, 25);
  for (const e of pending) await enrich(e);
  for (const e of state.entries.filter((x) => x.altitude == null && x.lat != null).slice(0, 25)) await fillAltitudeLater(e);
  if (pending.length && !form.open) router();
}

/* ================= network + SW ================= */
function updateNet() {
  const on = navigator.onLine;
  const el = $('#netStatus');
  el.textContent = on ? 'Online' : 'Offline';
  el.classList.toggle('off', !on);
}
window.addEventListener('online', () => { updateNet(); enrichPending(); });
window.addEventListener('offline', updateNet);

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !isNative()) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version is ready.', { action: 'Reload', onAction: () => location.reload(), ms: 10000 });
        }
      });
    });
  }).catch((err) => console.warn('SW registration failed', err));
}

/* ================= Android back button ================= */
if (isNative()) {
  document.addEventListener('backbutton', () => {
    const route = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'home';
    if (!overlays.length && route === 'home') { navigator.app?.exitApp?.(); return; }
    const before = location.href;
    let moved = false;
    const mark = () => { moved = true; };
    window.addEventListener('popstate', mark, { once: true });
    history.back();
    // Opened straight onto a page with nothing behind it: go to Home instead of doing nothing.
    setTimeout(() => { window.removeEventListener('popstate', mark); if (!moved && location.href === before && !overlays.length) location.hash = '#/home'; }, 350);
  });
}

/* ================= boot ================= */
(async function boot() {
  updateNet();
  state.settings = { ...state.settings, ...(await getMeta('settings', {})) };
  await loadEntries();
  await router();
  showRestoreBanner();
  setTimeout(enrichPending, 2000);
})();

// Exposed for debugging in the browser console.
window.fieldNotes = { state, db, router };
