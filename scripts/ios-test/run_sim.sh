#!/usr/bin/env bash
# Runs the self-test build on an iOS simulator: installs the app, grants location and photos,
# sets a simulated location in Tawang, launches, screenshots each step, relaunches once to check
# that data persists, and writes test-out/results.md. Usage: run_sim.sh path/to/App.app
set -uo pipefail
APP="$1"; BUNDLE=in.tawang.fieldnotes; OUT=test-out
mkdir -p "$OUT"

UDID=$(xcrun simctl list devices available -j | python3 -c "
import json,sys
d=json.load(sys.stdin)['devices']
c=[(rt,x) for rt,xs in d.items() if 'iOS' in rt for x in xs if x['name'].startswith('iPhone')]
c.sort(key=lambda t:(t[0],'Pro' in t[1]['name']))
print(c[-1][1]['udid'] if c else '')")
[ -n "$UDID" ] || { echo "No iPhone simulator available"; exit 1; }
xcrun simctl list devices | grep "$UDID" | tee "$OUT/device.txt"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl status_bar "$UDID" override --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
for s in location location-always photos camera; do xcrun simctl privacy "$UDID" grant "$s" "$BUNDLE" 2>/dev/null || true; done
xcrun simctl location "$UDID" set 27.5862,91.8594 2>/dev/null || true   # near Tawang

DATA=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)
RES="$DATA/Documents/selftest.json"
rm -f "$RES"
field() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$RES" "$1" 2>/dev/null; }

run_until() {   # $1 = phase value to wait for, $2 = timeout seconds
  local last="" end=$((SECONDS + $2))
  while [ $SECONDS -lt $end ]; do
    sleep 1
    [ -f "$RES" ] || continue
    local step; step=$(field step)
    if [ -n "$step" ] && [ "$step" != "$last" ] && [ "$step" != "relaunch" ] && [ "$step" != "done" ]; then
      sleep 1.2; xcrun simctl io "$UDID" screenshot "$OUT/$step.png" >/dev/null 2>&1; last="$step"
    fi
    [ "$(field phase)" = "$1" ] && return 0
  done
  return 1
}

xcrun simctl launch --console-pty "$UDID" "$BUNDLE" > "$OUT/log.txt" 2>&1 &
run_until relaunch 420 || echo "phase 1 did not finish in time"
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
sleep 3
xcrun simctl launch --console-pty "$UDID" "$BUNDLE" >> "$OUT/log.txt" 2>&1 &
run_until done 120 || echo "phase 2 did not finish in time"
xcrun simctl io "$UDID" screenshot "$OUT/16-final.png" >/dev/null 2>&1
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true

python3 - "$RES" "$OUT/results.md" <<'EOF'
import json, sys
try: r = json.load(open(sys.argv[1]))
except Exception as e: r = {'checks': [], 'errors': [f'no results file: {e}'], 'phase': 'missing'}
rows = ['| Check | Result | Detail |', '|---|---|---|']
for c in r.get('checks', []):
    rows.append(f"| {c['name']} | {'PASS' if c['ok'] else 'FAIL'} | {c['detail'].replace('|', '/')[:300]} |")
errs = r.get('errors', [])
rows.append(f"| No JavaScript errors | {'PASS' if not errs else 'FAIL'} | {'; '.join(errs)[:300]} |")
rows.append(f"| Test finished | {'PASS' if r.get('phase') == 'done' else 'FAIL'} | phase={r.get('phase')} |")
open(sys.argv[2], 'w').write('\n'.join(rows) + '\n')
print('\n'.join(rows))
ok = all(c['ok'] for c in r.get('checks', [])) and not errs and r.get('phase') == 'done' and r.get('checks')
sys.exit(0 if ok else 1)
EOF
