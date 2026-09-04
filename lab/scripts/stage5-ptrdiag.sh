#!/bin/bash
# Stage 5 diagnostic: the SHIPPED pointer guard's legs at the area-reorder grab
# point, in a lab guest. GOLDEN=<name> ARM=direct|routed
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
source lab/scripts/helpers-guest.sh

RC_DIST="${RC_DIST:?set RC_DIST}"
GOLD="${GOLDEN_NAME:-things-lab-golden-v4h}"
ARM="${ARM:-routed}"
# The signed helper bundle: deputy/build/ is GITIGNORED, so a fresh checkout or
# a worktree has none and the routed arm's first step would fail. Only the routed
# arm needs it; a direct clone brokers nothing.
if [ "$ARM" = "routed" ] && [ ! -x "deputy/build/Things API Helper.app/Contents/MacOS/things-deputy" ]; then
  echo "[diag] no helper bundle in deputy/build — building it"
  bash scripts/build-helpers.sh >/dev/null
fi
VM="things-ptrdiag-$(date +%H%M%S)"
ART="lab/artifacts/$VM"; mkdir -p "$ART"
NODE_BIN=$(node -e 'console.log(process.execPath)')

cleanup() { echo "[diag] teardown $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
echo "[diag] golden=$GOLD arm=$ARM"
tart clone "$GOLD" "$VM"
trap cleanup EXIT
(tart run "$VM" --no-graphics >"$ART/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 600)
echo "[diag] ssh $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules ~/labh'
lab_scp "$NODE_BIN" "admin@$IP:things-lab/bin/node"
lab_scp -r "$RC_DIST" "admin@$IP:things-lab/things-api/dist"
# commander by RESOLVED path — an agent worktree has no node_modules of its own
# and resolves the primary checkout's by walking up, so the relative path is absent.
COMMANDER_DIR=$(lab_commander_dir)
[ -d "$COMMANDER_DIR" ] || { echo "[diag] commander not resolvable from $PWD" >&2; exit 2; }
lab_scp -r "$COMMANDER_DIR" "admin@$IP:things-lab/things-api/node_modules/commander"
lab_scp package.json "admin@$IP:things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node'
CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"

# The leg probe, generated from the RC's OWN dist (same code the gestures carry).
node -e "
  import('$RC_DIST/write/vectors/ui-pointer-guard.js').then(m => {
    process.stdout.write(m.POINTER_GUARD_STANDALONE + '\n' + \`
var ARG = \\\$.NSProcessInfo.processInfo.arguments;
function argv(i){ return ObjC.unwrap(ARG.objectAtIndex(i + 4)) }
var VERB = argv(0);
if (VERB === 'windows') {
  var l = ptrWindowList() || [];
  JSON.stringify(l.map(function(w){ var b = w['kCGWindowBounds'];
    return { pid: w['kCGWindowOwnerPID'], owner: w['kCGWindowOwnerName'], layer: w['kCGWindowLayer'],
             a: w['kCGWindowAlpha'], b: [b.X, b.Y, b.Width, b.Height] } }), null, 1)
} else if (VERB === 'legs') {
  var x = Number(argv(1)), y = Number(argv(2));
  var front = ptrFrontApp(), list = ptrWindowList();
  var wins = front === null ? [] : ptrThingsWindows(front.pid, true);
  var inside = false, k;
  for (k = 0; k < wins.length; k++) if (ptrRectHas(wins[k].f, x, y)) inside = true;
  JSON.stringify({ point:[x,y], L1_front: front, L2_mainWindow: wins.length ? wins[0].f : null,
    L2_contains: inside, L3_topBanded: list === null ? null : ptrTopWindowAt(list, x, y),
    L3_hitPid: ptrHitPidAt(x, y),
    L3_hitApp: (function(){ var p = ptrHitPidAt(x, y); return p === null ? null : ptrAppName(p) })(),
    sentence_drag: ptrGuard('drag the area row', [{x:x,y:y}], {}) }, null, 1)
} else { JSON.stringify({error:'?'}) }
\`);
  });
" > "$ART/probe.jxa.js"
lab_scp "$ART/probe.jxa.js" "admin@$IP:labh/probe.jxa.js"

if [ "$ARM" = "routed" ]; then
  guest_helpers_provision "$IP" "$CLI"
  ESC=""
else
  ESC="THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1"
fi

lab_ssh "$IP" "$ESC $CLI config set ui-enabled true" >/dev/null
lab_ssh "$IP" "$ESC $CLI config set experimental-area-reorder true" >/dev/null
lab_ssh "$IP" "$ESC $CLI area add DIAG-A --json" >/dev/null 2>&1 || true
lab_ssh "$IP" "$ESC $CLI area add DIAG-B --json" >/dev/null 2>&1 || true
lab_ssh "$IP" 'open -a Things3; sleep 14; osascript -e '\''tell application "Things3" to activate'\'' >/dev/null 2>&1; sleep 3'

echo "======== on-screen window list (the guard's own scan) ========"
lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/probe.jxa.js windows' | tee "$ART/windows.json"
echo ""
echo "======== the guard's legs at the grab point ========"
for pt in "212 524" "212 300" "150 200"; do
  echo "--- point $pt ---"
  lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/probe.jxa.js legs $pt" | tee "$ART/legs-${pt// /-}.json"
done
echo ""
echo "======== the field-shaped reorder ========"
lab_ssh "$IP" "$ESC $CLI area reorder DIAG-B --first --dangerously-drive-gui --verify-timeout 120000 --json" 2>/dev/null | head -c 800
echo ""
echo "[diag] artifacts: $ART"
