// In-app self-test for the iOS simulator (CI only; injected into the test build, never shipped).
// Drives the real app inside WKWebView and writes results to Documents/selftest.json, which the
// workflow reads with `xcrun simctl get_app_container`. The workflow takes a screenshot whenever
// `step` changes, and relaunches the app once `phase` is "relaunch" to check persistence.

const cap = window.Capacitor;
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { phase: 'running', step: 'start', checks: [], errors: [], ua: navigator.userAgent };
window.addEventListener('error', (e) => out.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => out.errors.push(String(e.reason?.message || e.reason)));

async function save() {
  try { await cap.nativePromise('Filesystem', 'writeFile', { path: 'selftest.json', data: JSON.stringify(out, null, 1), directory: 'DOCUMENTS', encoding: 'utf8' }); } catch (e) { console.log('selftest save failed', e); }
}
async function waitFor(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
const click = (s) => { const el = $(s); if (!el) throw new Error(`missing ${s}`); el.click(); };
const fill = (s, v) => { const el = $(s); if (!el) throw new Error(`missing ${s}`); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
const text = (s) => ($(s)?.textContent || '').replace(/\s+/g, ' ').trim();
const visible = (s) => { const el = $(s); if (!el || el.classList.contains('hidden')) return false; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0; };

async function check(name, fn, shot) {
  out.step = shot || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  try { const detail = await fn(); out.checks.push({ name, ok: true, detail: String(detail ?? '') }); }
  catch (e) { out.checks.push({ name, ok: false, detail: String(e?.message || e) }); }
  await save();
  await sleep(4000); // time for the workflow's screenshot
}

async function phase1() {
  await check('App loads and shows Home', async () => {
    await waitFor(() => $('.hero h1'), 20000, 'home');
    if (cap.getPlatform() !== 'ios') throw new Error(`platform ${cap.getPlatform()}`);
    return `${text('.hero h1')} (platform ios, ${navigator.userAgent.match(/OS [\d_]+/)?.[0] || ''})`;
  }, '01-home');

  await check('Home photos load (no credits)', async () => {
    await waitFor(() => $('.hero-slide.on img')?.naturalWidth > 0, 15000, 'hero photo');
    if ($('#heroCredit, .hero-credit')) throw new Error('old credits shown');
    return `${document.querySelectorAll('.hero-slide').length} photos`;
  }, '02-home-photos');

  await check('Settings: About shows developer; keys saved', async () => {
    location.hash = '#/more?s=ident';
    await waitFor(() => $('#gemKey') && $('#idKey'), 10000, 'settings');
    fill('#gemKey', 'fieldnotes-ci-invalid-key'); fill('#idKey', 'fieldnotes-ci-invalid-key');
    await sleep(800);
    const about = document.body.textContent.includes('Developed by Geken');
    if (!about) throw new Error('developer line missing');
    return 'Developed by Geken; test keys entered';
  }, '03-settings');

  await check('Camera opens (simulator has no camera, so the fallback shows)', async () => {
    location.hash = '#/home'; await sleep(800);
    click('#cameraFab');
    await waitFor(() => visible('#cameraSheet') || document.activeElement?.id === 'nativeCamInput', 8000, 'camera sheet');
    await waitFor(() => visible('#camError') || $('#cameraVideo').videoWidth > 0, 10000, 'video or fallback');
    const r = $('#cameraVideo').videoWidth > 0 ? `live video ${$('#cameraVideo').videoWidth}px` : `fallback: ${text('#camError').slice(0, 80)}`;
    await sleep(1500);
    return r;
  }, '04-camera');
  try { click('#camClose'); } catch { /* not open */ }
  await sleep(800);

  await check('Gallery photo: date and camera from EXIF', async () => {
    const blob = await (await fetch('selftest/dslr.jpg')).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'IMG_0421.JPG', { type: 'image/jpeg' }));
    const input = $('#galleryInput'); input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => visible('#formSheet'), 15000, 'form');
    await waitFor(() => $('#fDate').value, 8000, 'date');
    const d = `${$('#fDate').value} ${$('#fTime').value}, "${text('#dateSource')}", lat="${$('#fLat').value}"`;
    if ($('#fDate').value !== '2025-08-21') throw new Error(d);
    if ($('#fLat').value) throw new Error(`phone GPS used for a gallery photo: ${d}`);
    return d;
  }, '05-form-exif');

  await check('Google Maps link fills location, altitude and district', async () => {
    $('#fMapsLink').scrollIntoView();
    fill('#fMapsLink', "https://www.google.com/maps/place/27%C2%B030'15.1%22N+92%C2%B006'29.9%22E/@27.5042,92.1083,15z");
    click('#mapsApply');
    await waitFor(() => $('#fLat').value.startsWith('27.504'), 15000, 'lat');
    await waitFor(() => $('#fDistrict').value && $('#fAlt').value, 30000, 'district and altitude');
    return `${$('#fLat').value}, ${$('#fLng').value}, ${$('#fAlt').value} m, district ${$('#fDistrict').value}, locality ${$('#fLocality').value}`;
  }, '06-maps-link');

  await check('Suggestions reach Gemini and Pl@ntNet via native HTTP', async () => {
    $('#suggestCard').scrollIntoView();
    await waitFor(() => /Gemini/.test(text('#suggestCard')) && /Pl@ntNet/.test(text('#suggestCard')) && !/Asking|checking/.test(text('#suggestCard')), 60000, 'both engines');
    const t = text('#suggestCard');
    if (/Could not reach/.test(t)) throw new Error(t.slice(0, 300));
    return `test key rejected by both servers, as expected: ${t.slice(0, 200)}`;
  }, '07-suggestions');

  await check('Name lookup fills family (live GBIF)', async () => {
    fill('#fScientific', 'Rhododendron arboreum');
    click('#lookupBtn');
    await waitFor(() => $('#fFamily').value, 40000, 'family');
    return `family=${$('#fFamily').value}`;
  }, '08-lookup');

  await check('Save record with growth stage', async () => {
    click('[data-st=flowering]');
    await sleep(500);
    click('.form-foot [data-save=auto]');
    await waitFor(() => $('.detail-head h1'), 15000, 'detail page');
    return `${text('.detail-head h1')} | ${text('.detail-body')?.slice(0, 160) || ''}`;
  }, '09-detail');

  await check('Phone GPS through Core Location', async () => {
    const { getBestFix } = await import('../js/geo.js');
    const fix = await getBestFix({ maxMs: 20000, goodEnough: 100 });
    return `lat ${fix.lat}, lng ${fix.lng}, ±${fix.accuracy} m (simulated location)`;
  }, '10-gps');

  await check('Records page lists the record', async () => {
    location.hash = '#/records';
    await waitFor(() => document.querySelectorAll('#view .rec, #view [data-id], #view .record').length || /Rhododendron/.test(text('#view')), 10000, 'records');
    return `${window.fieldNotes.state.entries.length} record(s) in IndexedDB`;
  }, '11-records');

  await check('Map renders with tiles', async () => {
    location.hash = '#/map';
    await waitFor(() => document.querySelectorAll('.leaflet-tile-loaded').length > 2, 30000, 'tiles');
    await sleep(2000);
    return `${document.querySelectorAll('.leaflet-tile-loaded').length} tiles`;
  }, '12-map');

  await check('Flora and phenology', async () => {
    location.hash = '#/flora';
    await waitFor(() => /Rhododendron/.test(text('#view')), 10000, 'flora');
    return text('#view').slice(0, 120);
  }, '13-flora');

  await check('Export file can be written for the share sheet', async () => {
    const r = await cap.nativePromise('Filesystem', 'writeFile', { path: 'fieldnotes-test.csv', data: 'a,b\n1,2\n', directory: 'CACHE', encoding: 'utf8' });
    return `written: ${r.uri}`;
  }, '14-export');

  try { localStorage.setItem('fn-selftest', 'phase2'); } catch { /* ignore */ }
  out.phase = 'relaunch'; out.step = 'relaunch';
  await save();
}

async function phase2() {
  const prev = await cap.nativePromise('Filesystem', 'readFile', { path: 'selftest.json', directory: 'DOCUMENTS', encoding: 'utf8' }).then((r) => JSON.parse(r.data)).catch(() => null);
  if (prev) { out.checks = prev.checks; out.errors = prev.errors; }
  out.phase = 'running';
  await check('Data survives app restart', async () => {
    await waitFor(() => window.fieldNotes?.state?.entries, 15000, 'app');
    await sleep(1500);
    const n = window.fieldNotes.state.entries.length;
    if (n < 1) throw new Error('no records after restart');
    return `${n} record(s) after restart`;
  }, '15-after-restart');
  try { localStorage.removeItem('fn-selftest'); } catch { /* ignore */ }
  out.phase = 'done'; out.step = 'done';
  await save();
}

(async () => {
  await waitFor(() => window.fieldNotes, 30000, 'app boot').catch(() => {});
  let p = null; try { p = localStorage.getItem('fn-selftest'); } catch { /* ignore */ }
  if (p === 'phase2') await phase2(); else await phase1();
})();
