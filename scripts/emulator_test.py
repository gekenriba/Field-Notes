"""Smoke test of the Android app on an emulator (run by .github/workflows/android.yml).

Drives the real app WebView over the DevTools protocol: opens the in-app camera, takes a
photo, checks the GPS fix, saves a record, saves an unidentified draft, opens the map and
species pages, and triggers an export to the Android share sheet. Screenshots of the real
screen are written to test-out/.
"""
import json, os, re, subprocess, sys, time
import urllib.request
import websocket  # pip install websocket-client


class CdpPage:
    """Minimal Chrome DevTools Protocol client for an Android WebView page.
    (Playwright's connect_over_cdp needs browser-context APIs that WebView lacks.)"""

    def __init__(self, port=9222):
        targets = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}/json', timeout=5).read())
        page = next(t for t in targets if t.get('type') == 'page')
        self.ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=60, suppress_origin=True)
        self.n = 0
        self.timeout = 25
        self.handlers = []
        self.send('Runtime.enable')

    def on(self, kind, fn):
        self.handlers.append((kind, fn))

    def _event(self, msg):
        m, prm = msg.get('method'), msg.get('params', {})
        if m == 'Runtime.exceptionThrown':
            d = prm['exceptionDetails']
            text = d.get('exception', {}).get('description') or d.get('text')
            for k, fn in self.handlers:
                if k == 'pageerror': fn(text)
        elif m == 'Runtime.consoleAPICalled':
            text = ' '.join(str(a.get('value', a.get('description', ''))) for a in prm.get('args', []))
            for k, fn in self.handlers:
                if k == 'console': fn(type('M', (), {'type': prm.get('type'), 'text': text})())

    def send(self, method, params=None):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == mid:
                if 'error' in msg: raise Exception(msg['error'].get('message'))
                return msg.get('result', {})
            self._event(msg)

    def evaluate(self, expr):
        r = self.send('Runtime.evaluate', {'expression': expr, 'awaitPromise': True, 'returnByValue': True, 'userGesture': True})
        if 'exceptionDetails' in r:
            raise Exception(r['exceptionDetails'].get('exception', {}).get('description') or r['exceptionDetails'].get('text'))
        return r.get('result', {}).get('value')

    def wait_for_function(self, expr, timeout=None):
        end = time.time() + (timeout / 1000 if timeout else self.timeout)
        while time.time() < end:
            try:
                if self.evaluate(f'!!({expr})'): return True
            except Exception:
                pass
            time.sleep(0.4)
        raise Exception(f'timed out waiting for: {expr[:120]}')

    def wait_for_selector(self, sel, timeout=None):
        return self.wait_for_function(f'document.querySelector({json.dumps(sel)})', timeout)

    def click(self, sel):
        self.wait_for_selector(sel)
        self.evaluate(f'document.querySelector({json.dumps(sel)}).click()')

    def fill(self, sel, value):
        self.wait_for_selector(sel)
        self.evaluate(f'(() => {{ const e = document.querySelector({json.dumps(sel)}); e.focus(); e.value = {json.dumps(value)}; e.dispatchEvent(new Event("input", {{bubbles: true}})); }})()')

    def input_value(self, sel):
        return self.evaluate(f'document.querySelector({json.dumps(sel)}).value')

    def text_content(self, sel):
        return self.evaluate(f'document.querySelector({json.dumps(sel)}).textContent')

    def locator(self, sel):
        page = self
        return type('L', (), {'count': lambda _: page.evaluate(f'document.querySelectorAll({json.dumps(sel)}).length')})()

    def set_default_timeout(self, ms):
        self.timeout = ms / 1000

    def close(self):
        try: self.ws.close()
        except Exception: pass

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
LOG = open(f'{OUT}/log.txt', 'w')
_print = print
def print(*a, **k):
    _print(*a, **k)
    k.pop('flush', None); _print(*a, **k, file=LOG, flush=True)

def main():
    adb('install', '-r', '-g', sys.argv[1], check=True)
    for p in ['CAMERA', 'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']:
        adb('shell', 'pm', 'grant', PKG, f'android.permission.{p}')
    adb('emu', 'geo', 'fix', '91.8594', '27.5861', '3900')
    adb('shell', 'am', 'start', '-n', f'{PKG}/.MainActivity')
    time.sleep(12)
    adb('emu', 'geo', 'fix', '91.8594', '27.5861', '3900')
    shot('01-launch')

    def forward_devtools():
        # /proc/net/unix is not readable on Android 10+, so derive the socket name from the pid.
        for _ in range(30):
            pid = adb('shell', 'pidof', PKG).strip()
            if pid:
                adb('forward', '--remove-all')
                r = subprocess.run(['adb', 'forward', 'tcp:9222', f'localabstract:webview_devtools_remote_{pid}'], capture_output=True, text=True)
                try:
                    import urllib.request
                    info = urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=3).read().decode()
                    print('DevTools:', info[:200], flush=True)
                    return
                except Exception as e:
                    print('waiting for DevTools', pid, r.stderr.strip(), e, flush=True)
            time.sleep(2)
        print(adb('logcat', '-d', '-t', '400'))
        sys.exit('WebView DevTools not reachable')

    forward_devtools()

    if True:
        page = CdpPage()
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
        page.close()
        time.sleep(3)
        forward_devtools()
        page = CdpPage()
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))

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


import traceback
try:
    main()
except SystemExit as e:
    results.append(('Test harness', 'FAIL', str(e)))
except Exception:
    results.append(('Test harness', 'FAIL', traceback.format_exc().strip().splitlines()[-1]))
    print(traceback.format_exc())
    print(adb('logcat', '-d', '-t', '300'))

with open(f'{OUT}/results.md', 'w') as f:
    f.write('| Check | Result | Detail |\n|---|---|---|\n')
    for n, r, d in results:
        f.write(f'| {n} | {r} | {d.replace("|", "/")} |\n')
print(open(f'{OUT}/results.md').read())
LOG.close()
sys.exit(1 if any(r == 'FAIL' for _, r, _ in results) else 0)
