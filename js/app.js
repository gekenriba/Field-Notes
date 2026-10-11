import { db, uid, getMeta, setMeta, delMeta, deleteEntry, requestPersistence, storageEstimate } from './db.js';
import { processPhoto, LiveCamera } from './media.js';
import { getBestFix, demElevation, placeName, formatCoord } from './geo.js';
import { GROUPS, suggest, lookup, fieldsFrom } from './taxon.js';
import { createMap, heatLayer, pointsLayer, fitTo, heatEligible } from './maps.js';
import { elevationAt } from './contours.js';
import { isNative, shareTextFile } from './native.js';
import { haptic, setHaptics, enterView, countUp, installPressFeedback, reducedMotion } from './ui.js';
import { STAGES, FLOWERING_DETAIL, GROUPS as STAGE_GROUPS, stageLabel, stageGroup, migrateStage, phenoMatrix, phenogramHTML, phenoTableHTML, wirePhenogram } from './phenology.js';
import { familyIcon, familyTraits } from './familyIcons.js';
import { loadIdentSettings, saveIdentSettings, identReady, identSettings, identify, indiaRecords, frameToBlob, liveBudgetLeft, usageToday } from './ident.js';
import { MorphScanner, coverTransform } from './morph.js';
import { buildBackup, restoreBackup } from './backup.js';

export const APP_VERSION = '3.0';
const DEVELOPER = 'Geken';

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
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const fmtBytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

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
  haptic.warning();
  return new Promise((res) => d.addEventListener('close', () => res(d.returnValue === 'yes'), { once: true }));
}

/* ================= state ================= */
const state = {
  entries: [],
  thumbs: new Map(),
  settings: { recorder: '', haptics: true, mapStyle: 'Minimal' },
  map: null,
  heroTimer: null,
  credits: null,
};

async function loadEntries() {
  const all = await db.all('entries');
  for (const e of all) if (migrateStage(e)) { e.updatedAt = e.updatedAt || new Date().toISOString(); await db.put('entries', e); }
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
async function credits() {
  if (!state.credits) state.credits = fetch('assets/hero/credits.json').then((r) => r.json()).catch(() => []);
  return state.credits;
}

/* ================= overlays + back button ================= */
const overlays = [];
const popWaiters = [];
function pushOverlay(name, onBack) { overlays.push({ name, onBack }); history.pushState({ overlay: name }, ''); }
function swapOverlay(oldName, name, onBack) {
  const i = overlays.map((o) => o.name).lastIndexOf(oldName);
  if (i === -1) return pushOverlay(name, onBack);
  overlays[i] = { name, onBack };
  history.replaceState({ overlay: name }, '');
}
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
  flora: renderFlora, species: renderFlora, taxon: renderTaxon, family: renderFamily, more: renderMore,
};
let routeToken = 0;

async function router() {
  const token = ++routeToken;
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [pathPart, query = ''] = raw.split('?');
  const [name, ...rest] = pathPart.split('/');
  const params = Object.fromEntries(new URLSearchParams(query));
  if (state.map) { const m = state.map; state.map = null; try { m.stop(); m.off(); m.remove(); } catch { /* map already torn down */ } }
  clearInterval(state.heroTimer);
  const view = $('#view');
  view.innerHTML = '';
  view.className = `view-${name}`;
  document.body.classList.toggle('over-hero', name === 'home' || name === '');
  $('#topbar').classList.remove('solid');
  const tabName = { entry: 'records', taxon: 'flora', family: 'flora', species: 'flora' }[name] || name;
  $$('.tabbar .tab').forEach((a) => a.classList.toggle('active', a.dataset.tab === tabName));
  const fn = routes[name] || renderHome;
  try { await fn(view, decodeURIComponent(rest.join('/')), params, token); }
  catch (err) { console.error(err); view.innerHTML = `<div class="empty"><p>Something went wrong: ${esc(err.message)}</p></div>`; }
  if (token !== routeToken) return;
  enterView(view);
  if (!overlays.length) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);
window.addEventListener('scroll', () => {
  if (document.body.classList.contains('over-hero')) $('#topbar').classList.toggle('solid', window.scrollY > 260);
}, { passive: true });

/* ================= shared fragments ================= */
function stagePill(e) {
  if (!e.stage) return '';
  const g = stageGroup(e.stage);
  const detail = e.stage === 'flowering' && e.stageDetail ? ` (${e.stageDetail})` : '';
  return `<span class="pill"><span class="stage-dot" style="background:${g?.color}"></span>${esc(stageLabel(e.stage))}${esc(detail)}</span>`;
}

function entryCard(e, thumb) {
  const sci = !!e.scientificName;
  const meta = [fmtDate(e.date), e.altitude != null ? `${e.altitude} m` : null, e.locality].filter(Boolean).join(', ');
  const g = e.stage ? stageGroup(e.stage) : null;
  const sub = [e.family, e.commonName || e.localName].filter(Boolean).join(', ')
    || (!sci && e.suggestions?.length ? `Suggested: ${e.suggestions[0].name}` : (!sci ? 'Not identified yet' : ''));
  return `<a class="entry-card" href="#/entry/${e.id}">
    <div class="thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">${e.family ? `<span class="fbadge">${familyIcon(e.family, 22)}</span>` : ''}` : familyIcon(e.family || '', 44)}</div>
    <div class="entry-text">
      <div class="entry-name ${sci ? 'sci' : ''}">${esc(displayName(e))}</div>
      <div class="entry-sub">${esc(sub)}</div>
      <div class="entry-meta">${g ? `<span class="stage-dot" style="background:${g.color}" title="${esc(stageLabel(e.stage))}"></span>` : ''}${esc(meta)}${e.population ? `, ${e.population} plants` : ''}</div>
    </div>
    ${e.status === 'draft' ? '<span class="tag tag-draft">Draft</span>' : ''}
  </a>`;
}

/* ================= HOME ================= */
async function renderHome(view, _a, _p, token) {
  const E = state.entries;
  const drafts = E.filter((e) => e.status === 'draft');
  const species = new Set(E.map(speciesKey).filter(Boolean));
  const families = new Map();
  for (const e of E) if (e.status === 'identified' && e.family) families.set(e.family, (families.get(e.family) || 0) + 1);
  const alts = E.map((e) => e.altitude).filter((a) => a != null);
  const recent = E.slice(0, 5);
  const tmap = await thumbsFor([...drafts.slice(0, 8), ...recent]);
  const cr = await credits();
  if (token !== routeToken) return;
  const month = new Date().getMonth();
  const floweringNow = [...new Set(E.filter((e) => e.status === 'identified' && e.stage === 'flowering' && e.date && +e.date.slice(5, 7) - 1 === month).map((e) => e.scientificName))];
  const last = await getMeta('lastBackup');
  const daysSince = last ? (Date.now() - new Date(last.at)) / 864e5 : Infinity;
  const changedSince = last ? E.some((e) => (e.updatedAt || '') > last.at) : E.length > 0;

  view.innerHTML = `
    <section class="hero" aria-label="Himalayan medicinal plants">
      ${cr.map((c, i) => `<div class="hero-slide ${i === 0 ? 'on' : ''}"><img src="${c.file}" alt="${esc(c.species)}" ${i ? 'loading="lazy"' : ''}></div>`).join('')}
      <a class="hero-credit" id="heroCredit" href="#/more?s=credits"></a>
      <div class="hero-body">
        <h1>${E.length ? 'Your Himalayan field journal' : 'Document the flora of the high Himalaya'}</h1>
        <p class="hero-sub">${E.length
          ? `${E.length} observation${E.length === 1 ? '' : 's'} stored on this phone${alts.length ? `, from ${Math.min(...alts).toLocaleString()} to ${Math.max(...alts).toLocaleString()} m` : ''}.`
          : 'Photograph a plant: position, altitude and time are recorded automatically, even without signal.'}</p>
        <div class="hero-stats">
          <a href="#/records"><b data-count="${E.length}">0</b><span>Records</span></a>
          <a href="#/flora"><b data-count="${species.size}">0</b><span>Species</span></a>
          <a href="#/flora?tab=families"><b data-count="${families.size}">0</b><span>Families</span></a>
          <a href="#/records?filter=draft" class="${drafts.length ? 'warn-stat' : ''}"><b data-count="${drafts.length}">0</b><span>Drafts</span></a>
        </div>
        <div class="hero-cta">
          <button class="btn btn-primary" id="heroCam" type="button">Start observing</button>
          <a class="btn btn-glass" href="#/map">Open map</a>
        </div>
      </div>
    </section>
    ${E.length && daysSince > 7 && changedSince ? `<div class="reminder"><p>${last ? `Last backup ${Math.floor(daysSince)} days ago.` : 'Your records have never been backed up.'} Save a copy to Google Drive in case this phone is lost.</p><a class="btn btn-small btn-primary" href="#/more?s=backup">Back up</a></div>` : ''}
    ${drafts.length ? `<section class="block">
      <div class="block-head"><h2>Waiting for identification</h2><a href="#/records?filter=draft">All drafts</a></div>
      <div class="hscroll">${drafts.slice(0, 8).map((e) => `<a class="draft-card" href="#/entry/${e.id}"><div class="ph">${tmap.get(e.id) ? `<img src="${tmap.get(e.id)}" alt="" loading="lazy">` : ''}</div>
        ${e.suggestions?.length ? `<span class="sugg">${esc(e.suggestions[0].name)}?</span>` : ''}<small>${esc([fmtDate(e.date), e.altitude != null ? `${e.altitude} m` : ''].filter(Boolean).join(', '))}</small></a>`).join('')}</div>
    </section>` : ''}
    ${floweringNow.length ? `<section class="block"><div class="block-head"><h2>Flowering this month</h2><a href="#/flora?tab=phenology">Phenology</a></div>
      <div class="flowering-now">${floweringNow.slice(0, 12).map((n) => { const f = E.find((e) => e.scientificName === n)?.family; return `<a href="#/taxon/${encodeURIComponent(n)}">${familyIcon(f || '', 26)}<span class="sci">${esc(n)}</span></a>`; }).join('')}</div></section>` : ''}
    <section class="block">
      <div class="block-head"><h2>Recent observations</h2>${E.length ? '<a href="#/records">All records</a>' : ''}</div>
      ${recent.length ? `<div class="list">${recent.map((e) => entryCard(e, tmap.get(e.id))).join('')}</div>`
        : `<div class="empty"><p>No observations yet. Tap the camera button to record your first plant.</p></div>`}
    </section>
    ${families.size ? `<section class="block"><div class="block-head"><h2>Families recorded</h2><a href="#/flora?tab=families">All families</a></div>
      <div class="hscroll">${[...families.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([f, n]) => `<a class="fam-tile" style="flex:0 0 132px" href="#/family/${encodeURIComponent(f)}">${familyIcon(f, 48)}<b>${esc(f)}</b><small>${n} record${n === 1 ? '' : 's'}</small></a>`).join('')}</div></section>` : ''}`;

  $('#heroCam').addEventListener('click', () => camera.start());
  $$('[data-count]', view).forEach((b) => countUp(b, +b.dataset.count));
  // Slow crossfade through the photos; one at a time, paused for reduced motion.
  const slides = $$('.hero-slide', view);
  const creditEl = $('#heroCredit');
  let i = 0;
  const showCredit = () => { const c = cr[i]; if (c) creditEl.innerHTML = `<em>${esc(c.species)}</em>${esc(c.common)}. Photo ${esc(c.artist)}, ${esc(c.license)}`; };
  showCredit();
  if (slides.length > 1 && !reducedMotion()) {
    state.heroTimer = setInterval(() => {
      if (document.hidden) return;
      slides[i].classList.remove('on');
      i = (i + 1) % slides.length;
      slides[i].classList.add('on');
      creditEl.style.opacity = 0;
      setTimeout(() => { showCredit(); creditEl.style.opacity = 1; }, 600);
    }, 7000);
  }
}

/* ================= RECORDS ================= */
async function renderRecords(view, _arg, params) {
  const filter = params.filter || 'all';
  view.innerHTML = `
    <div class="page-head"><h1>Records</h1><button class="btn btn-small btn-primary" id="recNew" type="button">New observation</button></div>
    <div class="toolbar">
      <input id="recSearch" type="search" placeholder="Search name, family, place, notes, tags" value="${esc(params.q || '')}" aria-label="Search records" />
      <div class="seg" id="recFilter" role="tablist">
        ${['all', 'draft', 'identified'].map((f) => `<button type="button" class="${f === filter ? 'on' : ''}" data-f="${f}">${{ all: 'All', draft: 'Drafts', identified: 'Identified' }[f]}</button>`).join('')}
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
      : `<div class="empty"><p>${current === 'draft' && !q ? 'No drafts. Everything is identified.' : 'No matching records.'}</p></div>`;
  };
  $('#recSearch').addEventListener('input', debounce(draw, 200));
  $('#recFilter').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-f]'); if (!b) return;
    current = b.dataset.f; haptic.select();
    $$('#recFilter button').forEach((c) => c.classList.toggle('on', c === b));
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
  const ethno = e.ethno && Object.values(e.ethno).some(Boolean) ? e.ethno : null;
  const key = speciesKey(e);

  view.innerHTML = `
    <div class="detail-hero ${photos.length ? '' : 'no-photo'}">
      ${photos.length ? `<div class="gallery">${photos.map((u) => `<img src="${u}" alt="" data-full="${u}">`).join('')}</div>` : ''}
      ${photos.length > 1 ? `<div class="dots">${photos.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
      <div class="detail-nav">
        <button class="icon-btn" type="button" id="entBack" aria-label="Back"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button class="btn btn-small" id="entEdit" type="button">Edit</button>
      </div>
    </div>
    <section class="detail-head">
      ${e.status === 'draft' ? '<span class="tag tag-draft">Draft, needs identification</span>' : ''}
      <h1 class="${e.scientificName ? 'sci' : ''}">${esc(displayName(e))}${e.authorship ? ` <small class="auth">${esc(e.authorship)}</small>` : ''}</h1>
      ${e.family ? `<a class="family-line" href="#/family/${encodeURIComponent(e.family)}">${familyIcon(e.family, 30)}<span>${esc(e.family)}${e.commonName ? `, ${esc(e.commonName)}` : ''}</span></a>` : (e.commonName ? `<p class="muted">${esc(e.commonName)}</p>` : '')}
      ${e.localName ? `<p class="muted">Local name: ${esc(e.localName)}</p>` : ''}
      <div class="pill-row">${stagePill(e)}${e.population ? `<span class="pill">${e.population} plant${e.population === 1 ? '' : 's'}, ${e.popMethod === 'estimated' ? 'estimated' : 'counted'}</span>` : ''}${e.scientificName && e.idConfidence && e.idConfidence !== 'certain' ? `<span class="pill">ID ${esc(e.idConfidence)}</span>` : ''}</div>
      <div class="detail-actions">
        ${key ? `<a class="btn btn-small btn-outline" href="#/taxon/${encodeURIComponent(key)}">Species page and map</a>` : ''}
        ${e.status === 'draft' ? `<button class="btn btn-small btn-primary" id="entIdentify" type="button">Identify now</button>` : ''}
      </div>
    </section>
    ${e.status === 'draft' && e.suggestions?.length ? `<section class="card suggest-card"><h3>Suggestions <span class="src">Pl@ntNet</span></h3>${suggestionListHTML({ species: e.suggestions }, { readOnly: true })}<p class="muted small">Suggestions only. Open “Identify now” to confirm one.</p></section>` : ''}
    <dl class="facts">
      <dt>Family</dt><dd>${show(e.family)}</dd>
      <dt>Genus</dt><dd>${show(e.genus)}</dd>
      <dt>Group</dt><dd>${show(e.group)}</dd>
      <dt>Field label</dt><dd>${show(e.fieldLabel)}</dd>
      <dt>Growth stage</dt><dd>${e.stage ? esc(stageLabel(e.stage) + (e.stageDetail ? ` (${e.stageDetail})` : '')) : NR}</dd>
      <dt>Population</dt><dd>${e.population != null && e.population !== '' ? `${esc(e.population)} (${e.popMethod === 'estimated' ? 'estimated' : 'counted'})` : NR}</dd>
      <dt>Abundance</dt><dd>${show(e.abundance)}</dd>
      <dt>Date</dt><dd>${show([fmtDate(e.date), e.time].filter(Boolean).join(' '))}</dd>
      <dt>Coordinates</dt><dd>${esc(formatCoord(e.lat, e.lng))}${e.accuracy != null ? ` <span class="muted">±${e.accuracy} m</span>` : ''}</dd>
      <dt>Altitude</dt><dd>${e.altitude != null ? `${e.altitude.toLocaleString()} m <span class="muted">${esc(e.altitudeSource || '')}</span>` : NR}</dd>
      <dt>Locality</dt><dd>${show(e.locality)}</dd>
      <dt>Habitat</dt><dd>${show(e.habitat)}</dd>
      <dt>Tags</dt><dd>${(e.tags || []).length ? e.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') : NR}</dd>
      ${e.voucher && (e.voucher.collector || e.voucher.number) ? `<dt>Voucher</dt><dd>${esc([e.voucher.collector, e.voucher.number, e.voucher.herbarium].filter(Boolean).join(', '))}</dd>` : ''}
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
  const gal = $('.gallery', view);
  if (gal && photos.length > 1) gal.addEventListener('scroll', debounce(() => {
    const i = Math.round(gal.scrollLeft / gal.clientWidth);
    $$('.dots i', view).forEach((d, k) => d.classList.toggle('on', k === i));
  }, 60), { passive: true });

  if (e.lat != null) {
    state.map = createMap($('#entMap'), { style: 'Minimal', controls: false });
    state.map.setView([e.lat, e.lng], 13);
    L.circleMarker([e.lat, e.lng], { radius: 8, color: '#fff', weight: 2.5, fillColor: e.status === 'draft' ? '#C98A12' : '#1B5E50', fillOpacity: 1 }).addTo(state.map);
    if (e.accuracy) L.circle([e.lat, e.lng], { radius: e.accuracy, weight: 1, color: '#1B5E50', fillOpacity: 0.08 }).addTo(state.map);
  }
  renderInfoCard($('#entInfo'), e);
}

function renderInfoCard(el, e) {
  if (!e.scientificName) {
    el.innerHTML = '<h3>Reference information</h3><p class="muted">Add a scientific name to fetch family, accepted name and a short description from GBIF, iNaturalist and Wikipedia.</p>';
    return;
  }
  const draw = (info) => { el.innerHTML = `<h3>Reference information</h3>${infoHTML(info)}<button class="btn btn-small btn-ghost" type="button" id="infoRefresh">Refresh from the web</button>`;
    $('#infoRefresh', el).onclick = refresh; };
  const refresh = async () => {
    el.innerHTML = '<h3>Reference information</h3><div class="shimmer"></div><div class="shimmer" style="width:70%"></div>';
    try {
      const info = await lookup(e.scientificName, e.group, { force: true });
      e.taxonInfo = info; e.updatedAt = new Date().toISOString();
      await db.put('entries', e);
      draw(info);
    } catch { el.innerHTML = '<h3>Reference information</h3><p class="muted">Offline. It will be looked up automatically when you reconnect.</p>'; }
  };
  if (e.taxonInfo) draw(e.taxonInfo); else refresh();
}

function infoHTML(info) {
  if (!info) return '<p class="muted">No information.</p>';
  const g = info.gbif;
  const parts = [];
  if (!g) parts.push('<p class="warn">Name not found in the GBIF Backbone Taxonomy. Check the spelling; it may also be a newly described or unpublished name.</p>');
  else {
    const label = { EXACT: 'Exact match', FUZZY: 'Fuzzy match, check the spelling', HIGHERRANK: `Only matched at ${String(g.rank).toLowerCase()} level` }[g.matchType] || g.matchType;
    parts.push(`<p><span class="src">GBIF</span> ${esc(label)}: <em>${esc(g.scientificName)}</em>, ${esc(String(g.status || '').toLowerCase())}</p>`);
    if (g.status && g.status !== 'ACCEPTED' && info.accepted) {
      parts.push(`<p class="warn">Treated as a synonym. Accepted name: <em>${esc(info.accepted.scientificName)}</em>
        <button type="button" class="btn btn-small btn-outline" data-use-accepted="${esc(info.accepted.canonicalName)}">Use accepted name</button></p>`);
    }
    parts.push(`<p class="classif">${[g.kingdom, g.phylum, g.class, g.order, g.family, g.genus].filter(Boolean).map(esc).join(' › ')}</p>`);
  }
  if (info.inat?.commonName) parts.push(`<p><span class="src">iNaturalist</span> Common name: ${esc(info.inat.commonName)}</p>`);
  if (info.counts) parts.push(`<p><span class="src">GBIF</span> Occurrence records: ${info.counts.global != null ? info.counts.global.toLocaleString() : 'not reported'} worldwide, ${info.counts.india != null ? info.counts.india.toLocaleString() : 'not reported'} in India <span class="muted small">(unverified aggregate counts)</span></p>`);
  if (info.wiki) parts.push(`<div class="wiki">${info.wiki.thumb ? `<img src="${esc(info.wiki.thumb)}" alt="">` : ''}<p><span class="src">Wikipedia</span> ${esc(info.wiki.extract)}</p></div>`);
  const links = [g && `<a href="${esc(g.url)}" target="_blank" rel="noopener">GBIF</a>`, info.inat && `<a href="${esc(info.inat.url)}" target="_blank" rel="noopener">iNaturalist</a>`,
    info.wiki?.url && `<a href="${esc(info.wiki.url)}" target="_blank" rel="noopener">Wikipedia</a>`,
    g && `<a href="https://powo.science.kew.org/results?q=${encodeURIComponent(g.canonicalName || info.query)}" target="_blank" rel="noopener">POWO</a>`].filter(Boolean);
  parts.push(`<p class="links">${links.join(' &nbsp; ')}</p>`);
  parts.push(`<p class="muted small">Fetched ${esc(new Date(info.fetchedAt).toLocaleDateString())}${info.errors?.length ? `; unavailable: ${esc(info.errors.join(', '))}` : ''}. Verify against a regional flora before publishing.</p>`);
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
  const prefs = { contours: true, boundaries: false, ...(await getMeta('mapPrefs', {})) };
  let style = prefs.style || 'Minimal';
  view.innerHTML = `
    <div class="map-wrap">
      <div id="bigMap" class="big-map"></div>
      <div class="map-float">
        <div class="map-row">
          <label class="map-select glass"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 21v-7M12 14c-4 0-6-3-6-7 3 0 6 2 6 7Zm0 0c4 0 6-3 6-7-3 0-6 2-6 7Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
            <select id="mapTaxon" aria-label="Show on map">
              <option value="__all">All records (${state.entries.length})</option>
              <option value="__draft">Drafts only (${state.entries.filter((e) => e.status === 'draft').length})</option>
              ${names.length ? `<optgroup label="One species">${names.map((n) => `<option value="${esc(n)}">${esc(n)} (${idx.get(n).length})</option>`).join('')}</optgroup>` : ''}
            </select></label>
        </div>
        <div class="map-row">
          <div class="glass"><div class="seg seg-small" id="mapStyle">${['Minimal', 'Satellite', 'Topo'].map((s) => `<button type="button" data-s="${s}" class="${s === style ? 'on' : ''}">${s === 'Topo' ? 'Topographic' : s}</button>`).join('')}</div></div>
        </div>
        <div class="map-toggles">
          <button type="button" class="toggle glass ${prefs.contours ? 'on' : ''}" data-t="contours" aria-pressed="${prefs.contours}">Contours</button>
          <button type="button" class="toggle glass ${prefs.boundaries ? 'on' : ''}" data-t="boundaries" aria-pressed="${prefs.boundaries}">Boundaries</button>
          <button type="button" class="toggle glass on" data-t="heat" aria-pressed="true">Heatmap</button>
        </div>
      </div>
      <div class="map-legend glass" id="mapLegend"></div>
      <div class="elev-readout glass" id="elevOut"></div>
    </div>`;
  if (names.includes(sel) || sel === '__draft') $('#mapTaxon').value = sel;
  const toggles = { contours: prefs.contours, boundaries: prefs.boundaries, heat: true };
  const map = state.map = createMap($('#bigMap'), {
    style, contours: style === 'Topo' ? false : toggles.contours, boundaries: style === 'Satellite' ? true : toggles.boundaries,
  });
  let heat = null, pts = null;
  const legend = (hasHeat) => {
    $('#mapLegend').innerHTML = `${hasHeat ? `<div class="row"><span class="lg-heat"></span> fewer to more observations</div>` : ''}
      <div class="row"><span class="dot dot-id"></span> identified <span class="dot dot-draft" style="margin-left:.5rem"></span> draft</div>`;
  };
  const draw = async (fit) => {
    const v = $('#mapTaxon').value;
    const list = v === '__all' ? state.entries : v === '__draft' ? state.entries.filter((e) => e.status === 'draft') : (idx.get(v) || []);
    const geo = list.filter((e) => e.lat != null && e.lng != null);
    const thumbs = await thumbsFor(geo);
    if (state.map !== map) return;
    if (heat) map.removeLayer(heat);
    if (pts) map.removeLayer(pts);
    const heatPts = geo.filter(heatEligible);
    heat = heatLayer(heatPts);
    pts = pointsLayer(geo, { thumbs, onOpen: (id) => { location.hash = `#/entry/${id}`; } });
    if (toggles.heat && heatPts.length) heat.addTo(map);
    pts.addTo(map);
    legend(toggles.heat && heatPts.length > 0);
    if (fit) fitTo(map, geo);
  };
  const savePrefs = () => setMeta('mapPrefs', { style, contours: toggles.contours, boundaries: toggles.boundaries });
  $('#mapTaxon').onchange = () => { haptic.select(); history.replaceState(null, '', `#/map${$('#mapTaxon').value !== '__all' ? `?taxon=${encodeURIComponent($('#mapTaxon').value)}` : ''}`); draw(true); };
  $('#mapStyle').onclick = (ev) => {
    const b = ev.target.closest('[data-s]'); if (!b || b.dataset.s === style) return;
    style = b.dataset.s; haptic.select();
    $$('#mapStyle button').forEach((x) => x.classList.toggle('on', x === b));
    map.fnSetStyle(style);
    map.fnToggle('contours', style !== 'Topo' && toggles.contours);
    map.fnToggle('boundaries', style === 'Satellite' ? toggles.boundaries || true : toggles.boundaries);
    savePrefs();
  };
  $$('.map-toggles .toggle').forEach((t) => t.addEventListener('click', () => {
    const k = t.dataset.t; toggles[k] = !toggles[k]; haptic.select();
    t.classList.toggle('on', toggles[k]); t.setAttribute('aria-pressed', toggles[k]);
    if (k === 'heat') draw(false); else map.fnToggle(k, toggles[k]);
    savePrefs();
  }));
  // Tap the map to read the terrain elevation there.
  let elevTimer;
  map.on('click', async (ev) => {
    const out = $('#elevOut');
    try {
      const z = await elevationAt(ev.latlng.lat, ev.latlng.lng);
      out.textContent = `${z.toLocaleString()} m  ·  ${ev.latlng.lat.toFixed(4)}, ${ev.latlng.lng.toFixed(4)}`;
    } catch { out.textContent = 'Elevation unavailable offline here'; }
    out.classList.add('show'); haptic.tap();
    clearTimeout(elevTimer); elevTimer = setTimeout(() => out.classList.remove('show'), 4000);
  });
  setTimeout(() => { if (state.map === map) map.invalidateSize({ animate: false }); }, 60);
  await draw(true);
}

/* ================= FLORA: species, phenology, families ================= */
function familyIndex() {
  const fam = new Map();
  for (const e of state.entries) {
    if (e.status !== 'identified' || !e.family) continue;
    if (!fam.has(e.family)) fam.set(e.family, { records: 0, species: new Set() });
    const f = fam.get(e.family); f.records++; if (e.scientificName) f.species.add(e.scientificName);
  }
  return fam;
}

async function renderFlora(view, _a, params) {
  const tab = params.tab || 'species';
  view.innerHTML = `
    <div class="page-head"><h1>Flora</h1></div>
    <div class="seg seg-tabs" id="floraTabs" role="tablist">
      ${[['species', 'Species'], ['phenology', 'Phenology'], ['families', 'Families']].map(([k, l]) => `<button type="button" role="tab" data-k="${k}" class="${k === tab ? 'on' : ''}" aria-selected="${k === tab}">${l}</button>`).join('')}
    </div>
    <div id="floraBody"></div>`;
  $('#floraTabs').onclick = (ev) => {
    const b = ev.target.closest('[data-k]'); if (!b) return;
    haptic.select();
    history.replaceState(null, '', `#/flora?tab=${b.dataset.k}`);
    $$('#floraTabs button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
    drawTab(b.dataset.k);
  };
  const drawTab = async (k) => {
    const body = $('#floraBody');
    if (k === 'phenology') await drawPhenology(body);
    else if (k === 'families') drawFamilies(body);
    else await drawSpecies(body);
    enterView(body);
  };
  await drawTab(tab);
}

async function drawSpecies(body) {
  const idx = speciesIndex();
  const rows = [...idx.entries()].map(([name, list]) => {
    const alts = list.map((e) => e.altitude).filter((a) => a != null);
    return { name, list, fam: list.find((e) => e.family)?.family || '', common: list.find((e) => e.commonName)?.commonName || '', n: list.length, alts,
      photo: list.find((e) => e.photoIds?.length)?.photoIds[0] };
  });
  const drafts = state.entries.filter((e) => e.status === 'draft').length;
  body.innerHTML = `
    <div class="toolbar">
      <input id="spSearch" type="search" placeholder="Search species or family" aria-label="Search species" />
      <div class="chips" id="spSort">
        <button type="button" class="chip on" data-s="family">By family</button>
        <button type="button" class="chip" data-s="count">Most records</button>
        <button type="button" class="chip" data-s="name">A–Z</button>
      </div>
    </div>
    ${drafts ? `<a class="draft-row" href="#/records?filter=draft"><span>${drafts} unidentified draft${drafts === 1 ? '' : 's'}</span><span>Identify</span></a>` : ''}
    <p class="muted small">${rows.length} species in ${new Set(rows.map((r) => r.fam).filter(Boolean)).size} families</p>
    <div id="spList"></div>`;
  const thumbs = new Map();
  for (const r of rows) thumbs.set(r.name, await thumbURL(r.photo));
  let sort = 'family';
  const card = (r) => `<a class="entry-card" href="#/taxon/${encodeURIComponent(r.name)}">
      <div class="thumb">${thumbs.get(r.name) ? `<img src="${thumbs.get(r.name)}" alt="" loading="lazy">` : familyIcon(r.fam, 44)}</div>
      <div class="entry-text"><div class="entry-name sci">${esc(r.name)}</div>
        <div class="entry-sub">${esc([r.common, sort !== 'family' ? r.fam : ''].filter(Boolean).join(', '))}</div>
        <div class="entry-meta">${r.n} record${r.n === 1 ? '' : 's'}${r.alts.length ? `, ${Math.min(...r.alts).toLocaleString()}–${Math.max(...r.alts).toLocaleString()} m` : ''}</div></div></a>`;
  const draw = () => {
    const q = $('#spSearch').value.trim().toLowerCase();
    const list = rows.filter((r) => !q || `${r.name} ${r.fam} ${r.common}`.toLowerCase().includes(q));
    if (!list.length) { $('#spList').innerHTML = `<div class="empty"><p>${rows.length ? 'No match.' : 'Identified species appear here once you save records with a scientific name.'}</p></div>`; return; }
    if (sort === 'count') list.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)); else list.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'family') {
      const fams = new Map();
      for (const r of list) { const f = r.fam || 'Family not reported'; if (!fams.has(f)) fams.set(f, []); fams.get(f).push(r); }
      $('#spList').innerHTML = [...fams.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([f, rs]) => `<a class="fam-head" href="#/family/${encodeURIComponent(f)}" style="text-decoration:none;color:inherit">${familyIcon(f, 32)}<h3 style="margin:0">${esc(f)}</h3><span class="muted">${rs.length}</span></a><div class="list">${rs.map(card).join('')}</div>`).join('');
    } else $('#spList').innerHTML = `<div class="list">${list.map(card).join('')}</div>`;
  };
  $('#spSearch').addEventListener('input', debounce(draw, 150));
  $('#spSort').onclick = (ev) => { const b = ev.target.closest('[data-s]'); if (!b) return; sort = b.dataset.s; haptic.select(); $$('#spSort .chip').forEach((c) => c.classList.toggle('on', c === b)); draw(); };
  draw();
}

async function drawPhenology(body) {
  const matrix = phenoMatrix(state.entries);
  const staged = state.entries.filter((e) => e.stage).length;
  const fams = [...new Set(state.entries.filter((e) => matrix.has(e.scientificName) && e.family).map((e) => e.family))].sort();
  body.innerHTML = `
    <p class="muted small">Growth stages recorded per month, from your identified observations (${staged} record${staged === 1 ? '' : 's'} with a stage). Each cell is split by the share of records in each stage.</p>
    ${matrix.size ? `<div class="toolbar">
      <select id="phFamily" aria-label="Filter by family"><option value="">All families</option>${fams.map((f) => `<option>${esc(f)}</option>`).join('')}</select>
      <div class="seg seg-small" id="phView"><button type="button" class="on" data-v="chart">Chart</button><button type="button" data-v="table">Table</button></div>
    </div>
    <section class="card" id="phBody"></section>` : `<div class="empty"><p>No growth stages recorded yet. Choose a growth stage when you save an observation and the phenology chart builds itself.</p></div>`}`;
  if (!matrix.size) return;
  let mode = 'chart';
  const draw = () => {
    const f = $('#phFamily').value;
    const names = [...matrix.keys()].filter((n) => !f || state.entries.some((e) => e.scientificName === n && e.family === f)).sort();
    $('#phBody').innerHTML = mode === 'chart' ? phenogramHTML(matrix, { names }) : phenoTableHTML(matrix, names);
    if (mode === 'chart') wirePhenogram($('#phBody'));
  };
  $('#phFamily').onchange = draw;
  $('#phView').onclick = (ev) => { const b = ev.target.closest('[data-v]'); if (!b) return; mode = b.dataset.v; haptic.select(); $$('#phView button').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
  draw();
}

function drawFamilies(body) {
  const fam = familyIndex();
  const list = [...fam.entries()].sort((a, b) => b[1].records - a[1].records || a[0].localeCompare(b[0]));
  body.innerHTML = list.length ? `<p class="muted small">Icons are drawn from each family’s key traits: flower symmetry, number and shape of petals, inflorescence and typical colour.</p>
    <div class="fam-grid">${list.map(([f, v]) => `<a class="fam-tile" href="#/family/${encodeURIComponent(f)}">${familyIcon(f, 52)}<b>${esc(f)}</b>
      <small>${v.species.size} species, ${v.records} record${v.records === 1 ? '' : 's'}</small>${familyTraits(f) ? `<small>${esc(familyTraits(f).note)}</small>` : ''}</a>`).join('')}</div>`
    : `<div class="empty"><p>Families appear here once you save identified records.</p></div>`;
}

/* ================= FAMILY PAGE ================= */
async function renderFamily(view, name) {
  const recs = state.entries.filter((e) => e.status === 'identified' && e.family === name);
  const sp = [...new Set(recs.map((e) => e.scientificName).filter(Boolean))].sort();
  const t = familyTraits(name);
  const matrix = phenoMatrix(recs);
  view.innerHTML = `
    <div class="page-head"><button class="icon-btn" type="button" id="famBack" aria-label="Back"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    <section class="detail-head" style="grid-template-columns:auto 1fr;align-items:center;justify-items:start;column-gap:1rem">
      ${familyIcon(name, 84)}
      <div><h1>${esc(name)}</h1><p class="muted" style="margin:.3rem 0 0">${t ? esc(t.note) : 'No trait sketch for this family yet; its icon shows its initial.'}</p></div>
    </section>
    <div class="stats-row"><div class="stat"><b>${sp.length}</b><span>Species recorded</span></div><div class="stat"><b>${recs.length}</b><span>Records</span></div></div>
    ${matrix.size ? `<section class="block"><h2>Phenology</h2><div class="card" id="famPheno">${phenogramHTML(matrix)}</div></section>` : ''}
    <section class="block"><h2>Species</h2><div class="list">${sp.map((n) => {
      const r = recs.filter((e) => e.scientificName === n);
      return `<a class="entry-card" href="#/taxon/${encodeURIComponent(n)}"><div class="thumb">${familyIcon(name, 44)}</div><div class="entry-text"><div class="entry-name sci">${esc(n)}</div><div class="entry-meta">${r.length} record${r.length === 1 ? '' : 's'}</div></div></a>`;
    }).join('') || '<div class="empty"><p>No identified records in this family.</p></div>'}</div></section>`;
  $('#famBack').onclick = () => history.back();
  if ($('#famPheno')) wirePhenogram($('#famPheno'));
}

/* ================= SPECIES PAGE (own heatmap) ================= */
async function renderTaxon(view, name) {
  const list = speciesIndex().get(name) || [];
  if (!list.length) { view.innerHTML = `<div class="empty"><p>No identified records of <em>${esc(name)}</em>.</p></div>`; return; }
  const geo = list.filter((e) => e.lat != null);
  const alts = list.map((e) => e.altitude).filter((a) => a != null);
  const dates = list.map((e) => e.date).filter(Boolean).sort();
  const pops = list.map((e) => +e.population).filter((n) => n > 0);
  const fam = list.find((e) => e.family)?.family;
  const common = list.find((e) => e.commonName)?.commonName;
  const info = list.find((e) => e.taxonInfo)?.taxonInfo;
  const matrix = phenoMatrix(list);
  const stageCounts = new Map();
  for (const e of list) if (e.stage) { const g = stageGroup(e.stage); if (g) stageCounts.set(g.key, (stageCounts.get(g.key) || 0) + 1); }
  const maxStage = Math.max(1, ...stageCounts.values());
  const photos = [];
  for (const e of list) for (const pid of e.photoIds || []) { if (photos.length >= 12) break; const u = await thumbURL(pid); if (u) photos.push({ u, id: e.id }); }
  const tmap = await thumbsFor(list);

  view.innerHTML = `
    <div class="page-head"><button class="icon-btn" type="button" id="txBack" aria-label="Back"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    <section class="detail-head">
      ${fam ? `<a class="family-line" href="#/family/${encodeURIComponent(fam)}">${familyIcon(fam, 30)}<span>${esc(fam)}</span></a>` : '<p class="kicker">Family not reported</p>'}
      <h1 class="sci">${esc(name)}</h1>
      ${common ? `<p class="muted" style="margin:0">${esc(common)}</p>` : ''}
    </section>
    <div class="stats-row">
      <div class="stat"><b>${list.length}</b><span>Records</span></div>
      <div class="stat"><b>${alts.length ? `${Math.min(...alts).toLocaleString()}–${Math.max(...alts).toLocaleString()} m` : 'not reported'}</b><span>Altitude range</span></div>
      <div class="stat"><b>${pops.length ? pops.reduce((a, b) => a + b, 0).toLocaleString() : 'not reported'}</b><span>Plants counted${pops.length ? ` over ${pops.length} record${pops.length === 1 ? '' : 's'}` : ''}</span></div>
      <div class="stat"><b>${dates.length ? `${fmtDate(dates[0])}` : 'not reported'}</b><span>${dates.length > 1 ? `First seen; last ${fmtDate(dates.at(-1))}` : 'Seen'}</span></div>
    </div>
    <section class="block">
      <div class="block-head"><h2>Distribution</h2><a href="#/map?taxon=${encodeURIComponent(name)}">Full map</a></div>
      ${geo.length ? '<div id="txMap" class="mid-map"></div>' : `<p class="muted">No records with coordinates.</p>`}
      ${geo.length < list.length ? `<p class="muted small">${list.length - geo.length} record(s) without coordinates not shown.</p>` : ''}
    </section>
    <section class="block">
      <h2>Phenology</h2>
      ${matrix.size ? `<div class="card" id="txPheno">${phenogramHTML(matrix, { link: false })}
        <div class="stage-bars" style="margin-top:1rem">${STAGE_GROUPS.filter((g) => stageCounts.get(g.key)).map((g) => `<div class="stage-bar"><span>${g.label}</span><div class="track"><div class="fill" style="width:${(stageCounts.get(g.key) / maxStage) * 100}%;background:${g.color}"></div></div><b>${stageCounts.get(g.key)}</b></div>`).join('')}</div></div>`
        : '<p class="muted">No growth stages recorded for this species yet.</p>'}
    </section>
    ${photos.length ? `<section class="block"><h2>Photos</h2><div class="photo-grid">${photos.map((p) => `<a href="#/entry/${p.id}"><img src="${p.u}" alt="" loading="lazy"></a>`).join('')}</div></section>` : ''}
    ${info ? `<section class="card"><h3>Reference information</h3>${infoHTML(info)}</section>` : ''}
    <section class="block"><h2>Records</h2><div class="list">${list.map((e) => entryCard(e, tmap.get(e.id))).join('')}</div></section>`;
  $('#txBack').onclick = () => history.back();
  if ($('#txPheno')) wirePhenogram($('#txPheno'));
  if (geo.length) {
    const map = state.map = createMap($('#txMap'), { style: 'Minimal' });
    heatLayer(geo).addTo(map);
    pointsLayer(geo, { thumbs: tmap, onOpen: (id) => { location.hash = `#/entry/${id}`; } }).addTo(map);
    setTimeout(() => { if (state.map !== map) return; map.invalidateSize({ animate: false }); fitTo(map, geo); }, 60);
  }
}

/* ================= MORE: about, backup, identification, settings ================= */
async function renderMore(view, _a, params) {
  const est = await storageEstimate();
  const last = await getMeta('lastBackup');
  const id = identSettings();
  const use = await usageToday();
  const cr = await credits();
  view.innerHTML = `
    <section class="about-hero">
      <h2>Field Notes</h2>
      <p>A field journal for documenting the plants of the Eastern Himalaya. Each observation keeps photos, GPS position and altitude, growth stage and population size. It works without signal and builds species distribution maps and phenology charts from your own records.</p>
      <div class="dev"><span class="av">${DEVELOPER[0]}</span><div><b>Developed by ${esc(DEVELOPER)}</b><small>Tawang, Arunachal Pradesh. Version ${APP_VERSION}</small></div></div>
    </section>

    <section class="card" id="backupCard">
      <h3>Backup and moving to a new phone</h3>
      <p>${last ? `Last backup ${new Date(last.at).toLocaleString()}: ${last.entries} records, ${last.photos} photos (${fmtBytes(last.size || 0)}).` : 'No backup yet.'}</p>
      <div class="progress hidden" id="bkProgress"><i></i></div>
      <div class="stack">
        <button class="btn btn-primary" id="bkNow" type="button">Back up to Google Drive</button>
        <button class="btn btn-outline" id="bkRestore" type="button">Restore from a backup</button>
      </div>
      <p class="muted small">The backup is one .zip file with all records and full-size photos. ${isNative() ? 'Choose “Drive” in the share sheet to save it to Google Drive, or Files to keep a copy on the phone.' : 'It downloads to this device.'}</p>
      <details><summary class="small" style="cursor:pointer;font-weight:600">Moving to a new phone</summary>
        <ol class="steps small"><li>On this phone, tap <b>Back up to Google Drive</b> and choose Drive.</li><li>Install Field Notes on the new phone.</li><li>Open Settings there, tap <b>Restore from a backup</b> and pick the file from Drive.</li></ol>
        <p class="muted small">Restoring adds records to the ones already on a phone; a record is replaced only if the backup copy is newer. Records are not uploaded anywhere else: GitHub is not suitable because informant and location details are sensitive.</p>
      </details>
    </section>

    <section class="card">
      <h3>Exports for analysis</h3>
      <div class="stack">
        <button class="btn btn-outline" id="expCsv" type="button">Spreadsheet (.csv, Darwin Core columns)</button>
        <button class="btn btn-outline" id="expGeo" type="button">Map points (.geojson for QGIS)</button>
      </div>
    </section>

    <section class="card" id="identCard">
      <h3>Plant name suggestions</h3>
      <p class="small">Live suggestions in the camera and on entries come from <a href="https://my.plantnet.org" target="_blank" rel="noopener">Pl@ntNet</a>. Create a free account there, copy your API key and paste it below (500 identifications a day). Suggestions need internet; the flower and leaf callouts in the camera work offline.</p>
      <label class="field"><span>Pl@ntNet API key</span><input id="idKey" value="${esc(id.key || '')}" autocomplete="off" spellcheck="false" placeholder="Paste your key" /></label>
      <div class="switch-row"><span>Live suggestions while the camera is open</span><label class="switch"><input type="checkbox" id="idLive" ${id.live !== false ? 'checked' : ''}><span></span></label></div>
      <p class="muted small">Used today: ${use.used}${use.remaining != null ? `, ${use.remaining} remaining on your key` : ''}.</p>
    </section>

    <section class="card">
      <h3>Preferences</h3>
      <label class="field"><span>Recorder or collector name</span><input id="setRecorder" value="${esc(state.settings.recorder)}" placeholder="Used for new records and exports" /></label>
      <div class="switch-row"><span>Haptic feedback</span><label class="switch"><input type="checkbox" id="setHaptics" ${state.settings.haptics !== false ? 'checked' : ''}><span></span></label></div>
    </section>

    <section class="card">
      <h3>Storage on this phone</h3>
      <p>${state.entries.length} records. ${est ? `${fmtBytes(est.usage)} used.` : ''}</p>
      ${isNative() ? '<p class="muted small">Records and photos are stored inside the app. Uninstalling the app or clearing its storage deletes them, so keep a backup.</p>'
        : `<p class="${est?.persisted ? 'ok' : 'warn'}">${est?.persisted ? 'Storage is persistent; the browser won’t clear it automatically.' : 'Storage is not persistent yet. Install the app to the home screen, then tap below.'}</p>${est?.persisted ? '' : '<button class="btn btn-outline" id="persistBtn" type="button">Keep my data persistent</button>'}`}
    </section>

    <section class="card" id="creditsCard">
      <h3>Sources and credits</h3>
      <p class="small">Names and details: GBIF Backbone Taxonomy, iNaturalist, Wikipedia, Pl@ntNet. Elevation and contours: AWS Terrain Tiles (SRTM and others) and Copernicus DEM via Open-Meteo. Maps: Esri (light grey canvas and World Imagery), OpenStreetMap contributors, OpenTopoMap. Boundaries: DataMeet (CC BY 4.0; district boundaries as of Census 2011, so districts created later are not shown).</p>
      <p class="small"><b>Home screen photos</b> (Wikimedia Commons):</p>
      <ul class="credits">${cr.map((c) => `<li><em>${esc(c.species)}</em>: ${esc(c.artist)}, <a href="${esc(c.licenseUrl || c.source)}" target="_blank" rel="noopener">${esc(c.license)}</a>, <a href="${esc(c.source)}" target="_blank" rel="noopener">source</a></li>`).join('')}</ul>
    </section>`;

  const prog = $('#bkProgress');
  const setProg = (p) => { prog.classList.remove('hidden'); $('i', prog).style.width = pct(p); };
  $('#bkNow').onclick = async () => {
    const b = $('#bkNow'); b.disabled = true; b.textContent = 'Preparing backup…';
    try {
      const r = await buildBackup(setProg);
      setProg(1);
      if (r.uri) {
        try { await window.Capacitor.nativePromise('Share', 'share', { title: r.filename, dialogTitle: 'Save backup to Drive or Files', files: [r.uri] }); }
        catch (err) { if (!/cancel/i.test(String(err?.message || err))) throw err; }
      } else {
        const a = document.createElement('a'); a.href = URL.createObjectURL(r.blob); a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
      }
      haptic.success(); toast(`Backup ready: ${r.entries} records, ${r.photos} photos, ${fmtBytes(r.size)}.`);
    } catch (err) { haptic.warning(); toast(`Backup failed: ${err.message || err}`); }
    finally { b.disabled = false; b.textContent = 'Back up to Google Drive'; setTimeout(() => prog.classList.add('hidden'), 1200); }
  };
  $('#bkRestore').onclick = () => $('#importInput').click();
  $('#expCsv').onclick = () => download(`field-notes-${todayISO()}.csv`, toCSV(state.entries), 'text/csv');
  $('#expGeo').onclick = () => download(`field-notes-${todayISO()}.geojson`, toGeoJSON(state.entries), 'application/geo+json');
  $('#idKey').addEventListener('change', async (ev) => { await saveIdentSettings({ key: ev.target.value.trim() }); haptic.success(); toast(ev.target.value.trim() ? 'Pl@ntNet key saved.' : 'Key removed.'); });
  $('#idLive').addEventListener('change', async (ev) => { await saveIdentSettings({ live: ev.target.checked }); haptic.select(); });
  $('#setRecorder').addEventListener('change', async (ev) => { state.settings.recorder = ev.target.value.trim(); await setMeta('settings', state.settings); toast('Saved.'); });
  $('#setHaptics').addEventListener('change', async (ev) => { state.settings.haptics = ev.target.checked; setHaptics(ev.target.checked); await setMeta('settings', state.settings); haptic.select(); });
  $('#persistBtn')?.addEventListener('click', async () => { const ok = await requestPersistence(); toast(ok ? 'Storage is now persistent.' : 'The browser declined. Install the app to the home screen and try again.'); router(); });
  const target = { backup: '#backupCard', ident: '#identCard', credits: '#creditsCard' }[params.s];
  if (target) setTimeout(() => $(target)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }), 80);
}

async function download(filename, text, type) {
  if (isNative()) {
    try { await shareTextFile(filename, text); } catch (err) { toast(`Export failed: ${err.message || err}`); }
    return;
  }
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function toCSV(entries) {
  const cols = ['occurrenceID', 'identificationStatus', 'scientificName', 'scientificNameAuthorship', 'family', 'genus', 'taxonRank', 'vernacularName', 'localName',
    'identificationQualifier', 'fieldLabel', 'eventDate', 'eventTime', 'decimalLatitude', 'decimalLongitude', 'coordinateUncertaintyInMeters',
    'minimumElevationInMeters', 'elevationSource', 'locality', 'habitat', 'reproductiveCondition', 'growthStageBBCH', 'individualCount', 'individualCountMethod', 'abundance',
    'recordedBy', 'recordNumber', 'herbarium', 'occurrenceRemarks', 'tags', 'ethnoUse', 'ethnoPartUsed', 'ethnoPreparation', 'ethnoCommunity', 'photoCount', 'gbifTaxonKey', 'suggestedName', 'suggestedScore'];
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const bbch = Object.fromEntries(STAGES.map((s) => [s.key, s.bbch]));
  const rows = entries.map((e) => [e.id, e.status, e.scientificName, e.authorship, e.family, e.genus, e.rank, e.commonName, e.localName,
    e.scientificName && e.idConfidence === 'tentative' ? 'cf.' : '', e.fieldLabel, e.date, e.time, e.lat, e.lng, e.accuracy,
    e.altitude, e.altitudeSource, e.locality, e.habitat, e.stage ? stageLabel(e.stage) + (e.stageDetail ? ` (${e.stageDetail})` : '') : '', e.stage ? bbch[e.stage] : '',
    e.population, e.population ? e.popMethod || 'counted' : '', e.abundance, e.voucher?.collector || e.recordedBy, e.voucher?.number, e.voucher?.herbarium,
    e.notes, (e.tags || []).join('|'), e.ethno?.use, e.ethno?.part, e.ethno?.prep, e.ethno?.community, (e.photoIds || []).length, e.taxonInfo?.gbif?.usageKey,
    e.suggestions?.[0]?.name, e.suggestions?.[0]?.score != null ? e.suggestions[0].score.toFixed(3) : ''].map(q).join(','));
  return '﻿' + [cols.join(','), ...rows].join('\n');
}

function toGeoJSON(entries) {
  return JSON.stringify({ type: 'FeatureCollection', features: entries.filter((e) => e.lat != null).map((e) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: e.altitude != null ? [e.lng, e.lat, e.altitude] : [e.lng, e.lat] },
    properties: { id: e.id, status: e.status, scientificName: e.scientificName || null, fieldLabel: e.fieldLabel || null, family: e.family || null,
      date: e.date, altitude: e.altitude, accuracy: e.accuracy, locality: e.locality || null, stage: e.stage || null, population: e.population ?? null },
  })) }, null, 1);
}

$('#importInput').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; ev.target.value = '';
  if (!f) return;
  toast('Restoring…', { ms: 20000 });
  try {
    const r = await restoreBackup(f, (p) => { const pr = $('#bkProgress'); if (pr) { pr.classList.remove('hidden'); $('i', pr).style.width = pct(p); } });
    await loadEntries();
    haptic.success();
    toast(`Restored: ${r.added} new, ${r.updated} updated, ${r.skipped} unchanged.`);
    router();
  } catch (err) { haptic.warning(); toast(`Restore failed: ${err.message}`); }
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

/* ================= CAMERA with live callouts and suggestions ================= */
function compactSuggestions(r) {
  return (r?.species || []).slice(0, 5).map((s) => ({ name: s.name, family: s.family, genus: s.genus, common: s.common, score: s.score, gbif: s.gbif, source: 'Pl@ntNet', at: new Date().toISOString() }));
}

const camera = {
  open: false, live: null, shots: [], fix: null, gpsRun: 0, scanner: null, nodes: new Map(),
  suggestions: [], selected: null, inflight: null, lastIdAt: 0, lastIdSig: null, lastSnap: null, hintTimer: 0, noKeyShown: false,

  async start() {
    if (!LiveCamera.supported()) { $('#nativeCamInput').click(); return; }
    this.open = true; this.shots = []; this.fix = null; this.suggestions = []; this.selected = null; this.lastIdSig = null;
    $('#camStrip').innerHTML = ''; $('#camSuggest').innerHTML = ''; $('#camOverlay').innerHTML = ''; this.nodes.clear();
    this.updateButtons();
    $('#camError').classList.add('hidden');
    $('#cameraSheet').classList.remove('hidden');
    document.body.classList.add('no-scroll');
    pushOverlay('camera', () => this.close('back'));
    this.setLive(identSettings().live !== false, false);
    this.locate();
    this.live = this.live || new LiveCamera($('#cameraVideo'));
    try {
      await this.live.start();
      $('#camTorch').classList.toggle('hidden', !this.live.torchSupported());
      this.scanner = new MorphScanner($('#cameraVideo'), { onChange: (s) => this.onScan(s) });
      this.scanner.start();
    } catch (err) {
      const denied = err.name === 'NotAllowedError';
      const el = $('#camError');
      el.innerHTML = `${denied ? 'Camera permission is blocked for Field Notes.' : 'The in-app camera could not start.'}<br>
        <button type="button" class="btn btn-primary" id="camNative">Use the phone’s camera app</button>`;
      el.classList.remove('hidden');
      $('#camNative').onclick = () => $('#nativeCamInput').click();
    }
  },

  setLive(on, save = true) {
    this.liveOn = on;
    const b = $('#camLive'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    if (!on) { $('#camSuggest').innerHTML = ''; this.hint(''); }
    if (save) saveIdentSettings({ live: on });
  },

  hint(text) {
    const h = $('#camHint');
    if (h.textContent !== text) h.textContent = text;
    h.classList.toggle('show', !!text);
  },

  async locate() {
    const run = ++this.gpsRun;
    $('#camGps').textContent = 'Locating…';
    try {
      this.fix = await getBestFix({ maxMs: 30000, goodEnough: 10, onUpdate: (f) => { if (run === this.gpsRun) { this.fix = f; $('#camGps').textContent = `GPS ±${f.accuracy} m`; } } });
      if (run === this.gpsRun) $('#camGps').textContent = `GPS ±${this.fix.accuracy} m${this.fix.altitude != null ? `, ${this.fix.altitude} m` : ''}`;
    } catch { if (run === this.gpsRun) $('#camGps').textContent = 'No GPS'; }
  },

  // Morphology callouts: thin corner brackets with a small label, smoothed by CSS transitions.
  onScan(snap) {
    if (!this.open) return;
    this.lastSnap = snap;
    const video = $('#cameraVideo');
    const tf = coverTransform(video);
    const overlay = $('#camOverlay');
    const flowers = snap.flowers.filter((t) => t.target.area >= 0.01).sort((a, b) => b.target.area - a.target.area).slice(0, 2);
    const shown = [...flowers];
    const fol = snap.foliage;
    if (fol && !flowers.some((f) => fol.target.cx > f.target.x0 && fol.target.cx < f.target.x1 && fol.target.cy > f.target.y0 && fol.target.cy < f.target.y1)) shown.push(fol);
    const keep = new Set();
    for (const t of shown) {
      keep.add(t.id);
      let el = this.nodes.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.className = `callout ${t.kind}`;
        el.innerHTML = '<span class="c tl"></span><span class="c tr"></span><span class="c bl"></span><span class="c br"></span><span class="lbl"></span>';
        overlay.appendChild(el);
        this.nodes.set(t.id, el);
        requestAnimationFrame(() => el.classList.add('show'));
        haptic.found();
      }
      const b = t.target;
      const big = t.kind === 'flower' && (b.x1 - b.x0) * (b.y1 - b.y0) > 0.5;   // fills the view: label only, no brackets
      el.classList.toggle('centered', t.kind === 'foliage' || big);
      if (t.kind === 'foliage' || big) {
        const [x, y] = tf(b.cx, b.cy);
        const [cx, cy] = t.kind === 'foliage' ? tf(b.cx, b.cy) : tf((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
        const H = video.clientHeight;
        el.style.transform = `translate(${cx}px, ${Math.min(H - 300, Math.max(150, cy))}px)`;
        el.style.width = '0px'; el.style.height = '0px';
        el.querySelector('.lbl').innerHTML = t.kind === 'foliage' ? 'Leaves' : `<i style="background:${swatch(t.colour)}"></i>${esc(cap(t.colour || ''))} ${(t.n || 1) >= 3 ? 'inflorescence' : 'flowers'}`;
      } else {
        let [x0, y0] = tf(b.x0, b.y0), [x1, y1] = tf(b.x1, b.y1);
        y0 = Math.max(y0, 110);   // keep the label clear of the top controls
        const padPx = 8;
        el.style.transform = `translate(${x0 - padPx}px, ${y0 - padPx}px)`;
        el.style.width = `${x1 - x0 + padPx * 2}px`; el.style.height = `${y1 - y0 + padPx * 2}px`;
        const many = (t.n || 1) >= 3;
        const col = t.colour || '';
        const lbl = el.querySelector('.lbl');
        lbl.innerHTML = `<i style="background:${swatch(col)}"></i>${esc(cap(col))} ${many ? 'inflorescence' : 'flower'}`;
        // Keep the label on screen near the right edge.
        const room = video.clientWidth - (x0 - padPx) - lbl.offsetWidth - 10;
        lbl.style.left = `${Math.min(0, room)}px`;
      }
      el.style.transition = 'transform .24s linear, width .24s linear, height .24s linear, opacity .35s ease';
    }
    for (const [id, el] of this.nodes) if (!keep.has(id)) {
      el.classList.remove('show'); this.nodes.delete(id); setTimeout(() => el.remove(), 380);
    }
    this.maybeIdentify(snap, flowers);
  },

  async maybeIdentify(snap, flowers) {
    if (!this.liveOn) return;
    const found = flowers.length || snap.foliage;
    if (!identSettings().key) {
      if (found && !this.noKeyShown) { this.hint('Add a Pl@ntNet key in Settings for name suggestions'); this.noKeyShown = true; setTimeout(() => this.hint(''), 4000); }
      return;
    }
    if (!navigator.onLine) { this.hint(found ? 'Offline: name suggestions need internet' : ''); return; }
    if (this.inflight) return;
    if (!found) { if (!this.suggestions.length) this.hint('Point at a flower or leaves'); return; }
    if (!snap.still) { this.hint(this.suggestions.length ? '' : 'Hold steady to identify'); return; }
    if (Date.now() - this.lastIdAt < 4000) return;
    // Don't send the same view twice.
    const sig = this.scanner?.prevSig;
    if (sig && this.lastIdSig) { let d = 0; for (let i = 0; i < 64; i++) d += Math.abs(sig[i] - this.lastIdSig[i]); if (d / 64 < 9) return; }
    if (!(await liveBudgetLeft())) { this.hint('Live suggestions paused: daily limit reached'); return; }
    const organ = flowers.some((f) => f.target.area >= 0.02) ? 'flower' : 'leaf';
    this.lastIdAt = Date.now(); this.lastIdSig = sig ? Float32Array.from(sig) : null;
    const ctrl = new AbortController(); this.inflight = ctrl;
    $('#camLive').classList.add('busy'); this.hint('Identifying…');
    try {
      const blob = await frameToBlob($('#cameraVideo'), 900);
      const r = await identify([{ blob, organ }], { results: 5, signal: ctrl.signal });
      if (!this.open) return;
      this.renderSuggestions(r, organ);
    } catch (err) {
      if (err.name !== 'AbortError') this.hint(err.message || 'Suggestion failed');
    } finally {
      this.inflight = null; $('#camLive').classList.remove('busy');
    }
  },

  renderSuggestions(r, organ) {
    const box = $('#camSuggest');
    const list = (r.species || []).filter((s) => s.score >= 0.05).slice(0, 3);
    if (!list.length) {
      box.innerHTML = `<span class="cs-note">${r.notPlant ? 'No plant recognised. Move closer to a flower or leaf' : 'No confident match. Try a closer view'}</span>`;
      this.hint('');
      return;
    }
    const prevTop = this.suggestions[0]?.name;
    this.suggestions = compactSuggestions(r);
    if (prevTop !== list[0].name) haptic.found();
    box.innerHTML = list.map((s, i) => `<button type="button" class="cs ${this.selected?.name === s.name ? 'on' : ''}" data-i="${i}">
      <span class="sci">${esc(s.name)}</span><small>${esc(s.family)}, ${pct(s.score)} ${i === 0 ? `(from ${organ})` : ''}</small></button>`).join('');
    this.hint('');
    $$('.cs', box).forEach((b) => b.addEventListener('click', () => {
      const s = list[+b.dataset.i];
      this.selected = this.selected?.name === s.name ? null : { ...s };
      haptic.select();
      $$('.cs', box).forEach((x) => x.classList.toggle('on', this.selected && x === b));
    }));
  },

  async snap() {
    const btn = $('#camShutter');
    if (btn.disabled || !this.live?.stream) return;
    btn.disabled = true;
    haptic.shutter();
    const sheet = $('#cameraSheet');
    sheet.classList.remove('flash'); void sheet.offsetWidth; sheet.classList.add('flash');
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
    await setMeta('unsavedForm', { values: { date: todayISO(), time: nowHM() }, photoIds: this.shots, isNew: true, fix: this.fix });
  },

  updateButtons() {
    const n = this.shots.length;
    $('#camDone').disabled = !n; $('#camQuickDraft').disabled = !n;
    $('#camDone').textContent = n ? `Add details (${n})` : 'Add details';
  },

  async quickDraft() {
    if (!this.shots.length) return;
    const fix = this.fix;
    const e = baseEntry();
    Object.assign(e, { status: 'draft', photoIds: [...this.shots], fieldLabel: `Unidentified, ${nowHM()}`, suggestions: this.suggestions.length ? this.suggestions : null });
    if (fix) Object.assign(e, { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, altitude: fix.altitude, altitudeSource: fix.altitude != null ? `GPS ±${fix.altitudeAccuracy ?? '?'} m` : '' });
    await db.put('entries', e);
    await delMeta('unsavedForm');
    requestPersistence();
    await loadEntries();
    if (fix) fillAltitudeLater(e); else locateDraftLater(e.id);
    this.shots = []; this.suggestions = []; this.selected = null;
    $('#camStrip').innerHTML = ''; $('#camSuggest').innerHTML = '';
    this.updateButtons();
    haptic.success();
    toast(fix ? 'Saved as draft. Next plant.' : 'Saved as draft. GPS is added when the fix arrives.');
  },

  async done() {
    const shots = [...this.shots], fix = this.fix, selected = this.selected, suggestions = this.suggestions;
    this.shots = [];
    this.close('handoff');
    await openForm({ photos: shots.map((id) => ({ id })), fix, fromCamera: true, selected, suggestions });
  },

  close(how) {
    if (!this.open) return;
    this.open = false;
    this.gpsRun++;
    this.inflight?.abort();
    this.scanner?.stop(); this.scanner = null;
    this.live?.stop();
    $('#camOverlay').innerHTML = ''; this.nodes.clear();
    $('#cameraSheet').classList.add('hidden');
    document.body.classList.remove('no-scroll');
    if (!how) popOverlay('camera');
    if (this.shots.length) this.quickDraft();
    else if (how !== 'handoff') delMeta('unsavedForm');
  },
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
function swatch(c) {
  return { white: '#fff', yellow: '#F2D04B', orange: '#F09A3E', red: '#D9383A', pink: '#F29BC0', magenta: '#D23F9A', purple: '#9050C8', 'blue-violet': '#6C6BE0', blue: '#4E86E8', 'pale blue-violet': '#B3B8F0' }[c] || '#ccc';
}

$('#cameraFab').addEventListener('click', () => (form.open ? $('#nativeCamInput').click() : camera.start()));
$('#camShutter').addEventListener('click', () => camera.snap());
$('#camClose').addEventListener('click', () => camera.close());
$('#camFlip').addEventListener('click', async () => { try { haptic.tap(); await camera.live.flip(); } catch (err) { toast(err.message); } });
$('#camGallery').addEventListener('click', () => $('#galleryInput').click());
$('#camDone').addEventListener('click', () => camera.done());
$('#camQuickDraft').addEventListener('click', () => camera.quickDraft());
$('#camLive').addEventListener('click', () => { camera.setLive(!camera.liveOn); haptic.select(); });
let torchOn = false;
$('#camTorch').addEventListener('click', () => { torchOn = !torchOn; camera.live.setTorch(torchOn); $('#camTorch').classList.toggle('on', torchOn); haptic.tap(); });
document.addEventListener('keydown', (ev) => { if (camera.open && (ev.key === ' ' || ev.key === 'Enter') && ev.target === document.body) { ev.preventDefault(); camera.snap(); } });

/* ================= ENTRY FORM ================= */
function baseEntry() {
  const now = new Date().toISOString();
  return {
    id: uid(), createdAt: now, updatedAt: now, status: 'draft', group: 'Plant',
    scientificName: '', authorship: '', family: '', genus: '', rank: '', commonName: '', localName: '',
    idConfidence: 'certain', fieldLabel: '', date: todayISO(), time: nowHM(),
    lat: null, lng: null, accuracy: null, altitude: null, altitudeSource: '',
    locality: '', habitat: '', stage: '', stageDetail: '', population: null, popMethod: 'counted', abundance: '', notes: '', tags: [],
    voucher: { collector: state.settings.recorder || '', number: '', herbarium: '' }, ethno: {},
    recordedBy: state.settings.recorder || '', photoIds: [], taxonInfo: null, suggestions: null,
  };
}

const F = {
  scientificName: '#fScientific', family: '#fFamily', genus: '#fGenus', commonName: '#fCommon', localName: '#fLocal',
  idConfidence: '#fConfidence', fieldLabel: '#fLabel', lat: '#fLat', lng: '#fLng', altitude: '#fAlt', accuracy: '#fAcc',
  date: '#fDate', time: '#fTime', locality: '#fLocality', habitat: '#fHabitat', abundance: '#fAbundance', notes: '#fNotes', population: '#fPopulation',
};
const ETHNO = { use: '#eUse', part: '#ePart', prep: '#ePrep', community: '#eCommunity', informant: '#eInformant', age: '#eAge', gender: '#eGender', consent: '#eConsent' };
const NUM = new Set(['lat', 'lng', 'altitude', 'accuracy', 'population']);

const form = {
  open: false, entry: null, isNew: true, photoIds: [], originalPhotoIds: [], group: 'Plant',
  stage: '', stageDetail: '', popMethod: 'counted',
  auto: new Set(), altitudeSource: '', taxonInfo: null, lookedUpName: '', dirty: false, gpsRun: 0,
  suggestions: null, suggestRun: 0, suggestedFor: '',

  fill(e) {
    for (const [k, sel] of Object.entries(F)) $(sel).value = e[k] ?? '';
    $('#fTags').value = (e.tags || []).join(', ');
    $('#fCollector').value = e.voucher?.collector || ''; $('#fCollNo').value = e.voucher?.number || ''; $('#fHerbarium').value = e.voucher?.herbarium || '';
    for (const [k, sel] of Object.entries(ETHNO)) $(sel).value = e.ethno?.[k] ?? '';
    $('#fDraft').checked = e.status === 'draft' && !this.isNew;
    this.group = e.group || 'Plant';
    this.stage = e.stage || ''; this.stageDetail = e.stageDetail || ''; this.popMethod = e.popMethod || 'counted';
    this.altitudeSource = e.altitudeSource || '';
    this.taxonInfo = e.taxonInfo || null;
    this.lookedUpName = e.taxonInfo ? e.scientificName : '';
    this.suggestions = e.suggestions ? { species: e.suggestions, genera: [], families: [], stored: true } : null;
    $('#voucherBox').open = !!(e.voucher?.number);
    $('#ethnoBox').open = !!(e.ethno && Object.values(e.ethno).some(Boolean));
    this.renderGroup(); this.renderStages(); this.renderPopMethod(); this.renderAltSource();
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
    if (e.population != null) e.population = Math.max(0, Math.round(e.population));
    e.scientificName = normName(e.scientificName);
    e.tags = $('#fTags').value.split(',').map((t) => t.trim()).filter(Boolean);
    e.voucher = { collector: $('#fCollector').value.trim(), number: $('#fCollNo').value.trim(), herbarium: $('#fHerbarium').value.trim() };
    e.ethno = Object.fromEntries(Object.entries(ETHNO).map(([k, sel]) => [k, $(sel).value.trim()]));
    e.group = this.group; e.stage = this.stage; e.stageDetail = this.stage === 'flowering' ? this.stageDetail : '';
    e.popMethod = this.popMethod; e.photoIds = [...this.photoIds];
    delete e.phenology;
    e.altitudeSource = e.altitude != null ? this.altitudeSource || 'Manual' : '';
    e.taxonInfo = this.taxonInfo && this.lookedUpName && normName(this.lookedUpName) === e.scientificName ? this.taxonInfo : null;
    if (e.taxonInfo) { const f = fieldsFrom(e.taxonInfo); e.authorship = f.authorship || ''; e.rank = f.rank || ''; }
    else if (!e.scientificName) { e.authorship = ''; e.rank = ''; }
    e.suggestions = this.suggestions?.species?.length
      ? this.suggestions.species.slice(0, 5).map((s) => ({ name: s.name, family: s.family, genus: s.genus, common: s.common, score: s.score, gbif: s.gbif, source: 'Pl@ntNet', at: s.at || new Date().toISOString() }))
      : (this.entry.suggestions || null);
    return e;
  },

  renderGroup() {
    $('#groupSeg').innerHTML = Object.keys(GROUPS).map((g) => `<button type="button" role="radio" aria-checked="${g === this.group}" class="${g === this.group ? 'on' : ''}" data-g="${g}">${g}</button>`).join('');
  },
  renderStages() {
    $('#stageList').innerHTML = STAGES.map((s) => {
      const g = stageGroup(s.key);
      return `<button type="button" role="radio" aria-checked="${this.stage === s.key}" class="stage-opt ${this.stage === s.key ? 'on' : ''}" data-st="${s.key}"><i style="background:${g.color}"></i><b>${s.label}</b><small>${s.hint}</small></button>`;
    }).join('');
    const fd = $('#flowerDetail');
    fd.classList.toggle('hidden', this.stage !== 'flowering');
    fd.innerHTML = FLOWERING_DETAIL.map((d) => `<button type="button" class="chip ${this.stageDetail === d.key ? 'on' : ''}" data-fd="${d.key}">${d.label}</button>`).join('');
  },
  renderPopMethod() { $$('#popMethod button').forEach((b) => b.classList.toggle('on', b.dataset.m === this.popMethod)); },
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
    if (exif.lat != null && $('#fLat').value === '') {
      this.gpsRun++;
      this.setAuto('lat', exif.lat); this.setAuto('lng', exif.lng); $('#fAcc').value = '';
      if (exif.alt != null) { this.setAuto('altitude', exif.alt); this.altitudeSource = 'Photo EXIF GPS'; this.renderAltSource(); }
      $('#gpsStatus').textContent = 'Location taken from photo';
      this.afterFix({ lat: exif.lat, lng: exif.lng, altitude: exif.alt ?? null });
    }
    if (exif.date && this.isNew && this.auto.has('date')) { this.setAuto('date', exif.date); if (exif.time) this.setAuto('time', exif.time); }
    this.changed();
    renderSuggestCard(true);
  },

  setAuto(name, value) { $(F[name]).value = value ?? ''; this.auto.add(name); },
  canAuto(name) { return $(F[name]).value === '' || this.auto.has(name); },

  async locate() {
    const run = ++this.gpsRun;
    const st = $('#gpsStatus');
    st.textContent = 'Getting a GPS fix…';
    $('#gpsBtn').disabled = true;
    try {
      const fix = await getBestFix({ maxMs: 20000, onUpdate: (f) => { if (run === this.gpsRun) { st.textContent = `Improving, ±${f.accuracy} m`; this.applyFix(f); } } });
      if (run !== this.gpsRun) return;
      this.applyFix(fix);
      st.textContent = `GPS fix ±${fix.accuracy} m`;
      haptic.tap();
      this.afterFix(fix);
    } catch (err) { if (run === this.gpsRun) st.textContent = err.message; }
    finally { $('#gpsBtn').disabled = false; }
  },

  applyFix(fix) {
    this.setAuto('lat', fix.lat); this.setAuto('lng', fix.lng); this.setAuto('accuracy', fix.accuracy);
    if (fix.altitude != null && this.canAuto('altitude')) { this.setAuto('altitude', fix.altitude); this.altitudeSource = `GPS ±${fix.altitudeAccuracy ?? '?'} m`; }
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

for (const [name, sel] of Object.entries(F)) $(sel).addEventListener('input', () => {
  form.auto.delete(name);
  if (name === 'scientificName') $('#fDraft').checked = false;
  if (name === 'altitude') { form.altitudeSource = 'Manual'; form.renderAltSource(); }
  form.changed();
});
$('#entryForm').addEventListener('input', (ev) => { if (!Object.values(F).some((s) => ev.target.matches(s))) form.changed(); });
$('#groupSeg').addEventListener('click', (ev) => { const b = ev.target.closest('[data-g]'); if (!b) return; form.group = b.dataset.g; haptic.select(); form.renderGroup(); form.changed(); });
$('#stageList').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-st]'); if (!b) return;
  form.stage = form.stage === b.dataset.st ? '' : b.dataset.st;
  haptic.select(); form.renderStages(); form.changed();
});
$('#flowerDetail').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-fd]'); if (!b) return;
  form.stageDetail = form.stageDetail === b.dataset.fd ? '' : b.dataset.fd;
  haptic.select(); form.renderStages(); form.changed();
});
$('#popMethod').addEventListener('click', (ev) => { const b = ev.target.closest('[data-m]'); if (!b) return; form.popMethod = b.dataset.m; haptic.select(); form.renderPopMethod(); form.changed(); });
$$('.step').forEach((b) => b.addEventListener('click', () => {
  const inp = $('#fPopulation');
  const v = Math.max(0, (parseInt(inp.value, 10) || 0) + +b.dataset.step);
  inp.value = v || (b.dataset.step === '1' ? 1 : '');
  haptic.select(); form.changed();
}));
$('#formPhotos').addEventListener('click', (ev) => {
  const rm = ev.target.closest('[data-rm]');
  if (rm) { form.photoIds = form.photoIds.filter((x) => x !== rm.dataset.rm); form.renderPhotos(); form.changed(); haptic.tap(); return; }
  const img = ev.target.closest('img'); if (img) openViewer(img.src);
});
$('#formCamera').addEventListener('click', () => $('#nativeCamInput').click());
$('#formGallery').addEventListener('click', () => $('#galleryInput').click());
$('#gpsBtn').addEventListener('click', () => form.locate());

/* ----- suggestions card (Pl@ntNet on the entry's photos) ----- */
function suggestionListHTML(r, { readOnly = false } = {}) {
  const sp = (r.species || []).filter((s) => s.score >= 0.02).slice(0, 5);
  const lead = [];
  if (r.families?.[0]) lead.push(`<button type="button" class="chip" data-fam="${esc(r.families[0].name)}" ${readOnly ? 'disabled' : ''}>Family ${esc(r.families[0].name)}, ${pct(r.families[0].score)}</button>`);
  if (r.genera?.[0]) lead.push(`<button type="button" class="chip" data-gen="${esc(r.genera[0].name)}" ${readOnly ? 'disabled' : ''}>Genus ${esc(r.genera[0].name)}, ${pct(r.genera[0].score)}</button>`);
  if (r.genera?.[1] && r.genera[1].score > 0.1) lead.push(`<button type="button" class="chip" data-gen="${esc(r.genera[1].name)}" ${readOnly ? 'disabled' : ''}>or ${esc(r.genera[1].name)}, ${pct(r.genera[1].score)}</button>`);
  return `${lead.length ? `<div class="lead">${lead.join('')}</div>` : ''}
    <div class="sugg-list">${sp.map((s, i) => `<button type="button" class="sugg" data-i="${i}" ${readOnly ? 'tabindex="-1"' : ''}>
      <span class="sci">${esc(s.name)}</span><span class="score">${pct(s.score)}<span class="meter"><i style="width:${pct(s.score)}"></i></span></span>
      <small>${esc([s.family, s.common].filter(Boolean).join(', '))}<span class="india" data-gbif="${esc(s.gbif || '')}"></span></small></button>`).join('')
      || '<p class="muted small">No confident match.</p>'}</div>`;
}

async function renderSuggestCard(auto = false) {
  const card = $('#suggestCard');
  if (!form.open) return;
  const hasPhotos = form.photoIds.length > 0;
  const r = form.suggestions;
  const named = !!$('#fScientific').value.trim();
  if (!hasPhotos && !r) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const head = `<h3><span>Suggestions</span><span class="src">Pl@ntNet</span></h3>`;
  if (!identSettings().key) {
    card.innerHTML = `${head}<p class="small">Get likely species, genus and family from your photos. Add a free Pl@ntNet API key in <a href="#/more?s=ident" id="sgKeyLink">Settings</a>.</p>`;
    $('#sgKeyLink').onclick = async (e) => { e.preventDefault(); await closeForm({ viaBack: false, keep: true }); location.hash = '#/more?s=ident'; };
    return;
  }
  const photoSig = form.photoIds.join(',');
  const canRun = hasPhotos && navigator.onLine;
  if (auto && canRun && !named && form.suggestedFor !== photoSig && !(r && !r.stored && form.suggestedFor === photoSig)) { runEntrySuggestions(); return; }
  if (!r) {
    card.innerHTML = `${head}<p class="small muted">${navigator.onLine ? 'Get likely names from these photos.' : 'Offline. Suggestions need internet.'}</p>
      <button type="button" class="btn btn-small btn-outline" id="sgRun" ${canRun ? '' : 'disabled'}>Suggest from photos</button>`;
    $('#sgRun')?.addEventListener('click', runEntrySuggestions);
    return;
  }
  card.innerHTML = `${head}${r.stored ? '<p class="muted small" style="margin-top:0">From the live camera.</p>' : ''}${suggestionListHTML(r)}
    <p class="muted small">Scores are Pl@ntNet’s confidence. Check against a flora: species missing from its database can’t be suggested.</p>
    ${canRun ? `<button type="button" class="btn btn-small btn-ghost" id="sgRun">${r.stored ? 'Suggest from saved photos' : 'Run again'}</button>` : ''}`;
  $('#sgRun')?.addEventListener('click', runEntrySuggestions);
  const sp = (r.species || []).filter((s) => s.score >= 0.02).slice(0, 5);
  $$('.sugg', card).forEach((b) => b.addEventListener('click', () => applySuggestion(sp[+b.dataset.i])));
  $$('[data-gen]', card).forEach((b) => b.addEventListener('click', () => {
    const g = b.dataset.gen;
    if (form.canAuto('genus') || !$('#fGenus').value) form.setAuto('genus', g);
    if (!$('#fLabel').value) $('#fLabel').value = `${g} sp.`;
    const fam = r.species.find((s) => s.genus === g)?.family;
    if (fam && (form.canAuto('family') || !$('#fFamily').value)) form.setAuto('family', fam);
    haptic.select(); form.changed(); toast(`Genus set to ${g}. Kept as draft until you confirm the species.`);
  }));
  $$('[data-fam]', card).forEach((b) => b.addEventListener('click', () => {
    form.setAuto('family', b.dataset.fam); haptic.select(); form.changed(); toast(`Family set to ${b.dataset.fam}.`);
  }));
  // Is each suggested species known from India? (GBIF occurrence count)
  for (const el of $$('.india', card)) {
    const k = el.dataset.gbif; if (!k) continue;
    indiaRecords(k).then((n) => { if (n == null) return; el.textContent = n > 0 ? `. GBIF: ${n.toLocaleString()} records in India` : '. GBIF: no records in India'; });
  }
}

async function runEntrySuggestions() {
  const card = $('#suggestCard');
  const run = ++form.suggestRun;
  const photoSig = form.photoIds.join(',');
  form.suggestedFor = photoSig;
  card.classList.remove('hidden');
  card.innerHTML = `<h3><span>Suggestions</span><span class="src">Pl@ntNet</span></h3><p class="small muted">Comparing your photos…</p><div class="shimmer"></div><div class="shimmer" style="width:80%"></div><div class="shimmer" style="width:60%"></div>`;
  try {
    const images = [];
    for (const id of form.photoIds.slice(0, 5)) {
      const p = await db.get('photos', id);
      if (p) images.push({ blob: p.blob, organ: 'auto' });
    }
    const r = await identify(images, { detailed: true, results: 8 });
    if (run !== form.suggestRun || !form.open) return;
    form.suggestions = r;
    form.changed();
    haptic.found();
    renderSuggestCard();
  } catch (err) {
    if (run !== form.suggestRun) return;
    card.innerHTML = `<h3><span>Suggestions</span><span class="src">Pl@ntNet</span></h3><p class="small">${esc(err.message)}</p>`;
  }
}

function applySuggestion(s) {
  if (!s) return;
  $('#fScientific').value = s.name;
  $('#fDraft').checked = false;
  if ($('#fConfidence').value === 'certain') $('#fConfidence').value = 'probable';
  form.auto.add('family'); form.auto.add('genus'); form.auto.add('commonName');
  if (s.family) form.setAuto('family', s.family);
  if (s.genus) form.setAuto('genus', s.genus);
  haptic.select();
  form.changed();
  runLookup();
  toast('Name filled from a suggestion, marked “probable”. Check it before saving.');
  $('#fScientific').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
}

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
      <small>${esc([r.common, r.family, r.rank && r.rank.toLowerCase(), r.source].filter(Boolean).join(', '))}</small></li>`).join('');
    list.classList.toggle('hidden', !res.length);
    list.onclick = (ev) => {
      const li = ev.target.closest('li'); if (!li) return;
      const r = res[+li.dataset.i];
      $('#fScientific').value = r.name;
      list.classList.add('hidden');
      haptic.select();
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
  panel.innerHTML = '<p class="muted small">Looking up family and details…</p><div class="shimmer"></div><div class="shimmer" style="width:70%"></div>';
  try {
    const info = await lookup(name, form.group, { force });
    if (normName($('#fScientific').value) !== name) return;
    form.taxonInfo = info; form.lookedUpName = name;
    applyLookup(info);
    panel.innerHTML = infoHTML(info);
    $$('[data-use-accepted]', panel).forEach((b) => b.addEventListener('click', () => {
      $('#fScientific').value = b.dataset.useAccepted; form.auto.delete('family'); form.changed(); runLookup();
    }));
  } catch {
    panel.innerHTML = '<p class="muted">Offline. You can still save; family and details are fetched automatically when you are back online.</p>';
  }
}

function applyLookup(info) {
  const f = fieldsFrom(info);
  for (const k of ['family', 'genus', 'commonName']) if (f[k] && form.canAuto(k)) form.setAuto(k, f[k]);
  form.changed();
}

/* ----- open / close / save ----- */
async function openForm({ entry = null, photos = [], fix = null, restore = null, focusName = false, fromCamera = false, selected = null, suggestions = null } = {}) {
  if (camera.open) camera.close();
  form.isNew = !entry;
  form.entry = entry ? structuredClone(entry) : baseEntry();
  form.photoIds = [...(form.entry.photoIds || []), ...photos.map((p) => p.id)];
  form.originalPhotoIds = restore?.originalPhotoIds || [...(entry?.photoIds || [])];
  form.auto = new Set(form.isNew ? ['date', 'time', 'locality'] : []);
  form.dirty = !!(photos.length || restore);
  form.suggestedFor = form.photoIds.join(',');   // don't auto-run for photos that already have suggestions
  form.fill(restore ? { ...form.entry, ...restore.values } : form.entry);
  if (restore) form.photoIds = restore.photoIds || [];
  if (suggestions?.length) form.suggestions = { species: suggestions, genera: [], families: [], stored: true };
  $('#formTitle').textContent = form.isNew ? 'New observation' : (entry.status === 'draft' ? 'Identify draft' : 'Edit observation');
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
    if (selected) applySuggestion(selected);
    form.changed();
  }
  // Drafts and new entries with photos get suggestions automatically (if a key is set).
  form.suggestedFor = form.suggestions ? form.photoIds.join(',') : '';
  renderSuggestCard(!form.entry.scientificName && !selected);
  if (focusName) setTimeout(() => $('#fScientific').focus(), 250);
}

async function closeForm({ viaBack = false, discard = false } = {}) {
  form.open = false;
  form.gpsRun++; form.suggestRun++;
  $('#formSheet').classList.add('hidden');
  document.body.classList.remove('no-scroll');
  if (!viaBack) await popOverlay('form');
  if (discard) {
    for (const id of form.photoIds) if (!form.originalPhotoIds.includes(id)) await db.del('photos', id);
    await delMeta('unsavedForm');
  } else if (form.dirty) {
    toast('Entry kept. You can restore it.', { action: 'Restore', onAction: restoreForm, ms: 6000 });
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
  if (e.status === 'draft' && !e.scientificName && !e.fieldLabel) e.fieldLabel = `Unidentified${e.time ? `, ${e.time}` : ''}`;
  e.recordedBy = e.recordedBy || state.settings.recorder;
  e.updatedAt = new Date().toISOString();

  for (const id of form.originalPhotoIds) if (!e.photoIds.includes(id)) await db.del('photos', id);
  await db.put('entries', e);
  await delMeta('unsavedForm');
  form.dirty = false;
  requestPersistence();
  haptic.success();
  await closeForm({});
  await loadEntries();
  toast(e.status === 'draft' ? (e.scientificName ? 'Saved as draft.' : 'Saved as draft. Identify it later from Records, Drafts.') : 'Saved.');
  if (e.scientificName && !e.taxonInfo) enrich(e);
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
async function locateDraftLater(id) {
  try {
    const fix = await getBestFix({ maxMs: 45000, goodEnough: 20 });
    const cur = await db.get('entries', id);
    if (!cur || cur.lat != null) return;
    Object.assign(cur, { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, updatedAt: new Date().toISOString() });
    if (cur.altitude == null && fix.altitude != null) { cur.altitude = fix.altitude; cur.altitudeSource = `GPS ±${fix.altitudeAccuracy ?? '?'} m`; }
    await db.put('entries', cur);
    await loadEntries();
    fillAltitudeLater(cur);
  } catch { /* no fix: the draft stays without coordinates */ }
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
  if (pending.length && !form.open && !camera.open && !location.hash.startsWith('#/map')) router();
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
    setTimeout(() => { window.removeEventListener('popstate', mark); if (!moved && location.href === before && !overlays.length) location.hash = '#/home'; }, 350);
  });
}

/* ================= boot ================= */
(async function boot() {
  updateNet();
  installPressFeedback();
  state.settings = { ...state.settings, ...(await getMeta('settings', {})) };
  setHaptics(state.settings.haptics !== false);
  await loadIdentSettings();
  await loadEntries();
  await router();
  showRestoreBanner();
  setTimeout(enrichPending, 2000);
})();

window.fieldNotes = { state, db, router, camera, form, version: APP_VERSION };
