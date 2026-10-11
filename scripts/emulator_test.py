"""Smoke test of the Android app on an emulator (run by .github/workflows/android.yml).

Drives the real app WebView over the DevTools protocol: opens the in-app camera, takes a
photo, checks the GPS fix, saves a record, saves an unidentified draft, opens the map and
species pages, and triggers an export to the Android share sheet. Screenshots of the real
screen are written to test-out/.
"""
import json, os, re, subprocess, sys, time
from playwright.sync_api import sync_playwright

OUT = 'test-out'
os.makedirs(OUT, exist_ok=True)
results = []

def adb(*args, check=False):
    r = subprocess.run(['adb', *args], capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout

def shot(name):
    with open(f'{OUT}/{name}.png', 'wb') as f:
        f.write(subprocess.run(['adb', 'exec-out', 'screencap', '-p'], capture_output=True).stdout)

def check(name, fn):
    try:
        detail = fn()
        results.append((name, 'PASS', str(detail or '')))
    except Exception as e:  # keep going so one failure doesn't hide the rest
        results.append((name, 'FAIL', str(e).splitlines()[0][:300]))
    print(results[-1], flush=True)

PKG = 'in.tawang.fieldnotes'
adb('install', '-r', '-g', sys.argv[1], check=True)
for p in ['CAMERA', 'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']:
    adb('shell', 'pm', 'grant', PKG, f'android.permission.{p}')
adb('emu', 'geo', 'fix', '91.8594', '27.5861', '3900')
adb('shell', 'am', 'start', '-n', f'{PKG}/.MainActivity')
time.sleep(12)
adb('emu', 'geo', 'fix', '91.8594', '27.5861', '3900')
shot('01-launch')

sock = None
for _ in range(20):
    m = re.search(r'@(webview_devtools_remote_\d+)', adb('shell', 'cat', '/proc/net/unix'))
    if m:
        sock = m.group(1); break
    time.sleep(2)
if not sock:
    print(adb('logcat', '-d', '-t', '300')); sys.exit('WebView DevTools socket not found')
adb('forward', 'tcp:9222', f'localabstract:{sock}', check=True)

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp('http://127.0.0.1:9222')
    page = browser.contexts[0].pages[0]
    page.set_default_timeout(25000)
    logs = []
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))

    check('App loads and shows Home', lambda: page.wait_for_selector('.hero') and page.text_content('.hero h1'))
    check('Running as native app', lambda: page.evaluate('window.Capacitor.isNativePlatform()') or (_ for _ in ()).throw(Exception('not native')))

    def camera():
        page.click('#cameraFab')
        page.wait_for_function('document.querySelector("#cameraVideo").videoWidth > 0')
        time.sleep(2); shot('02-camera')
        page.click('#camShutter'); page.wait_for_selector('#camStrip img')
        return page.evaluate('[document.querySelector("#cameraVideo").videoWidth, document.querySelector("#cameraVideo").videoHeight]')
    check('In-app camera opens and takes a photo', camera)

    def to_form():
        page.click('#camDone'); page.wait_for_selector('#formSheet:not(.hidden)')
        n = page.locator('#formPhotos img').count()
        if n != 1: raise Exception(f'{n} photos in form')
        return f'{n} photo in form'
    check('Photo carried into entry form', to_form)

    def gps():
        page.wait_for_function('document.querySelector("#fLat").value !== ""', timeout=45000)
        return f'lat {page.input_value("#fLat")}, lng {page.input_value("#fLng")}, alt {page.input_value("#fAlt")}, {page.text_content("#gpsStatus")}'
    check('GPS fills coordinates', gps)

    def lookup():
        page.fill('#fScientific', 'Rhododendron arboreum')
        page.click('#lookupBtn')
        page.wait_for_function('!document.querySelector("#lookupPanel").textContent.includes("Looking up")', timeout=40000)
        fam = page.input_value('#fFamily')
        shot('03-form-lookup')
        if not fam: raise Exception('family empty: ' + page.text_content('#lookupPanel')[:200])
        return f'family={fam}'
    check('Web lookup fills family (live GBIF)', lookup)

    def save():
        page.click('.form-foot [data-save=auto]')
        page.wait_for_selector('.detail-head h1'); time.sleep(2); shot('04-detail')
        return page.text_content('.detail-head h1')
    check('Save identified record', save)

    def draft():
        page.click('#cameraFab'); page.wait_for_function('document.querySelector("#cameraVideo").videoWidth > 0')
        page.click('#camShutter'); page.wait_for_selector('#camStrip img')
        page.click('#camQuickDraft'); page.wait_for_function('document.querySelectorAll("#camStrip img").length === 0')
        page.click('#camClose'); time.sleep(1)
        badge = page.text_content('#draftBadge')
        if badge.strip() != '1': raise Exception(f'draft badge {badge!r}')
        return 'draft badge 1'
    check('Quick-save unidentified draft', draft)

    def stored():
        n = page.evaluate('window.fieldNotes.db.all("entries").then(r => r.length)')
        ph = page.evaluate('window.fieldNotes.db.all("photos").then(r => r.length)')
        if n != 2 or ph != 2: raise Exception(f'{n} entries / {ph} photos')
        return f'{n} entries, {ph} photos in IndexedDB'
    check('Records stored on device', stored)

    def persists():
        adb('shell', 'am', 'force-stop', PKG); time.sleep(2)
        adb('shell', 'am', 'start', '-n', f'{PKG}/.MainActivity'); time.sleep(10)
        return 'restarted'
    check('Force-stop and relaunch', persists)

    # Reconnect after relaunch
    try: browser.close()
    except Exception: pass
    time.sleep(3)
    m = re.search(r'@(webview_devtools_remote_\d+)', adb('shell', 'cat', '/proc/net/unix'))
    adb('forward', '--remove-all'); adb('forward', 'tcp:9222', f'localabstract:{m.group(1)}')
    browser = p.chromium.connect_over_cdp('http://127.0.0.1:9222')
    page = browser.contexts[0].pages[0]
    page.set_default_timeout(25000)

    def after_restart():
        page.wait_for_selector('.hero')
        n = page.evaluate('window.fieldNotes.db.all("entries").then(r => r.length)')
        if n != 2: raise Exception(f'{n} entries after restart')
        shot('05-home-after-restart')
        return f'{n} entries after restart'
    check('Data survives app restart', after_restart)

    def maps():
        page.evaluate('location.hash = "#/map"')
        page.wait_for_selector('#bigMap canvas.leaflet-heatmap-layer'); time.sleep(6); shot('06-map')
        tiles = page.evaluate('document.querySelectorAll("#bigMap .leaflet-tile-loaded").length')
        return f'{tiles} map tiles loaded'
    check('Map with heatmap renders', maps)

    def species():
        page.evaluate('location.hash = "#/taxon/Rhododendron%20arboreum"')
        page.wait_for_selector('#txMap canvas.leaflet-heatmap-layer'); time.sleep(4); shot('07-species')
        return page.text_content('.detail-head h1')
    check('Species page with own heatmap', species)

    def export():
        page.evaluate('location.hash = "#/more"'); page.wait_for_selector('#expCsv')
        page.click('#expCsv'); time.sleep(4); shot('08-share-sheet')
        top = adb('shell', 'dumpsys', 'activity', 'activities')
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); time.sleep(2)
        if 'ChooserActivity' not in top and 'chooser' not in top.lower():
            raise Exception('share sheet not detected')
        return 'Android share sheet opened'
    check('Export opens Android share sheet', export)

    def back():
        page.evaluate('location.hash = "#/home"'); time.sleep(1)
        page.click('#cameraFab'); page.wait_for_function('!document.querySelector("#cameraSheet").classList.contains("hidden")')
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); time.sleep(2)
        if not page.evaluate('document.querySelector("#cameraSheet").classList.contains("hidden")'):
            raise Exception('camera still open')
        return 'back button closes camera, app stays open'
    check('Back button closes camera', back)

    errs = [l for l in logs if l.startswith(('error', 'pageerror'))]
    results.append(('No JavaScript errors', 'PASS' if not errs else 'FAIL', '; '.join(errs)[:500]))

crash = adb('logcat', '-d', '-b', 'crash')
results.append(('No native crash', 'PASS' if PKG not in crash else 'FAIL', crash[-500:] if PKG in crash else ''))

with open(f'{OUT}/results.md', 'w') as f:
    f.write('| Check | Result | Detail |\n|---|---|---|\n')
    for n, r, d in results:
        f.write(f'| {n} | {r} | {d.replace("|", "/")} |\n')
print(open(f'{OUT}/results.md').read())
