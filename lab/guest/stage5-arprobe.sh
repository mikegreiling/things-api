#!/bin/bash
# Diagnostic: why does the area-reorder pointer guard name Notification Center
# in a v4h guest, when PTRGD1 cell A was green on a v4 guest?
set -u
NODE="$1"; APP="$2/dist/cli/main.js"
things() { "$NODE" "$APP" "$@"; }
OUT="$HOME/things-lab/out"; mkdir -p "$OUT"

things config set ui-enabled true >/dev/null
things config set experimental-area-reorder true >/dev/null
things area add "PROBE-AREA-A" --json >/dev/null 2>&1
things area add "PROBE-AREA-B" --json >/dev/null 2>&1

echo "=== on-screen window list (owner / layer / alpha / bounds) ==="
osascript -l JavaScript -e '
ObjC.import("CoreGraphics"); ObjC.import("Foundation");
const list = $.CGWindowListCopyWindowInfo(
  $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
const arr = ObjC.deepUnwrap(list);
for (const w of arr) {
  const b = w.kCGWindowBounds;
  console.log(`L${w.kCGWindowLayer} a${w.kCGWindowAlpha} pid${w.kCGWindowOwnerPID} ${w.kCGWindowOwnerName} [${b.X},${b.Y} ${b.Width}x${b.Height}]`);
}' 2>&1 | tee "$OUT/windowlist-before.txt"

echo ""
echo "=== bring Things forward, then re-list ==="
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1; sleep 3
osascript -l JavaScript -e '
ObjC.import("CoreGraphics"); ObjC.import("Foundation");
const arr = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(
  $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
for (const w of arr) {
  const b = w.kCGWindowBounds;
  console.log(`L${w.kCGWindowLayer} a${w.kCGWindowAlpha} pid${w.kCGWindowOwnerPID} ${w.kCGWindowOwnerName} [${b.X},${b.Y} ${b.Width}x${b.Height}]`);
}' 2>&1 | tee "$OUT/windowlist-front.txt"

echo ""
echo "=== NotificationCenter process state ==="
pgrep -lf NotificationCenter || echo "(no NotificationCenter process)"

echo ""
echo "=== attempt 1: area reorder as-is ==="
things area reorder "PROBE-AREA-B" --first --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null | head -c 900
echo ""

echo ""
echo "=== disable Notification Center, then attempt 2 ==="
launchctl bootout "gui/$(id -u)/com.apple.notificationcenterui" 2>&1 || echo "(bootout returned $?)"
sleep 3
pgrep -lf NotificationCenter || echo "(NotificationCenter is gone)"
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1; sleep 2
things area reorder "PROBE-AREA-B" --first --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null | head -c 900
echo ""

echo ""
echo "=== PTRGD1 four-leg probe, from the SHIPPED guard, at the sidebar grab point ==="
# The probe is generated from the RC's own dist, so it interrogates exactly the
# code the gestures carry — never a copy.
"$NODE" -e "
  import('$2/dist/write/vectors/ui-pointer-guard.js').then(m => {
    process.stdout.write(m.POINTER_GUARD_STANDALONE + '\n' + \`
var ARG = \\\$.NSProcessInfo.processInfo.arguments;
function argv(i){ return ObjC.unwrap(ARG.objectAtIndex(i + 4)) }
var x = Number(argv(0)), y = Number(argv(1));
var front = ptrFrontApp(), list = ptrWindowList();
var wins = front === null ? [] : ptrThingsWindows(front.pid, true);
var inside = false, k;
for (k = 0; k < wins.length; k++) if (ptrRectHas(wins[k].f, x, y)) inside = true;
var hit = ptrHitPidAt(x, y), screen = ptrScreenAt(x, y);
var chain = front === null ? [] : ptrChainAt(front.pid, x, y);
JSON.stringify({
  point: [x, y],
  L1_frontmost: front, L1_pass: front !== null && front.bundleId === PTRGD1_BUNDLE,
  L2_window: wins.length ? wins[0].f : null, L2_pass: inside,
  L3_hitPid: hit, L3_hitApp: hit === null ? null : ptrAppName(hit),
  L3_screen: screen,
  L3_scanOwner: list === null ? null : ptrScanOwnerAt(list, x, y, screen, ptrIsSystemOwner),
  L3_verdict: ptrOcclusionVerdict(front === null ? -1 : front.pid, hit, list || [], x, y, screen, ptrIsSystemOwner),
  L4_chain: ptrChainRoles(chain),
  sentence: ptrGuard('drag the area row', [{x:x,y:y}], {}),
  ops: PTR_OPS
}, null, 1)
\`);
  });
" > "$HOME/things-lab/legprobe.jxa.js"
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1; sleep 2
# Read a real sidebar area-row point out of the shipped snapshot script.
"$NODE" -e "
  import('$2/dist/write/vectors/ui-drag.js').then(m => process.stdout.write(m.jxaSidebarSnapshotScript(['PROBE-AREA-A','PROBE-AREA-B'])));
" > "$HOME/things-lab/snap.jxa.js"
SNAP=$(osascript -l JavaScript "$HOME/things-lab/snap.jxa.js" 2>/dev/null)
PT=$(python3 -c "
import json, sys
try: s = json.loads('''$SNAP''')
except Exception: print('212 524'); sys.exit()
rows = [r for r in s.get('rows', []) if r.get('y') is not None]
rows.sort(key=lambda r: r['y'])
hit = None
for r in rows:
    segs = (r.get('text') or '').split('|')
    if 'PROBE-AREA-B' in segs or 'PROBE-AREA-B.' in segs: hit = r; break
if hit is None: print('212 524')
else: print('%d %d' % (round(hit['x'] + hit['w'] * 0.7), round(hit['y'] + hit['h'] / 2)))
")
echo "  probing at ($PT)"
osascript -l JavaScript "$HOME/things-lab/legprobe.jxa.js" $PT 2>&1 | tee "$OUT/legprobe.json"

echo ""
echo "=== attempt 3: area reorder, routed, with Notification Center RESTORED ==="
launchctl bootstrap "gui/$(id -u)" /System/Library/LaunchAgents/com.apple.notificationcenterui.plist 2>&1 || echo "(bootstrap returned $?)"
sleep 4
pgrep -lf NotificationCenter || echo "(NotificationCenter did not come back)"
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1; sleep 2
osascript -l JavaScript "$HOME/things-lab/legprobe.jxa.js" $PT 2>&1 | tee "$OUT/legprobe-nc-restored.json"
things area reorder "PROBE-AREA-A" --first --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null | head -c 900
echo ""
