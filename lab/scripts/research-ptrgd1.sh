#!/bin/bash
# PTRGD1 — the pre-gesture occlusion / frontmost / identity guard for every
# synthesized POINTER gesture.
#
# BACKGROUND. Every keystroke primitive re-asserts, in the same osascript hop
# that types, that Things owns the screen (ui.ts `AX_FOCUS_GUARD_HANDLERS`,
# #620). The HID mouse gestures did not. They post at `kCGHIDEventTap` to screen
# coordinates read from AX frames, and AX frames resolve for a background or
# occluded window too — so a ⌘-Tab, a window dragged over the sidebar, a
# notification banner or a screen lock between the census and the gesture sends
# the drag into whatever is under the pointer. On the maintainer's M1 one sidebar
# census is 16–18 s, so the window is seconds wide on every move.
#
# HARDEN1 (#627) already runs a drive-level frontmost/focus census one hop ahead
# of every pointer-class primitive, and it STAYS. What it cannot do, and what
# this campaign certifies:
#   L1 the assertion runs in the SAME script as the post, not a hop earlier;
#   L2 containment — the point is inside Things' own window frame;
#   L3 occlusion — nothing of another application's is between the pointer and
#      Things AT THE POINT (frontmost is not unoccluded);
#   L4 identity — the element the coordinates now hit is the one that was
#      planned against (the same-app stale-frame class, invisible to the drag
#      driver's area-count + assignment-digest invariants);
#   L5 a DROP-TIME re-check, because a held drag runs for seconds.
#
# CELLS
#   A  baseline    the guarded area reorder still succeeds; the guard's own cost.
#   B  foreign     TextEdit over the grab point → refusal, order unchanged,
#                  nothing dragged in TextEdit.
#   B2 legs        each leg's verdict at a point, Things frontmost (the negative
#                  control) and at a point over TextEdit (the positive).
#   B3 occlusion   a REAL above-Things occluder with Things FRONTMOST — an
#                  opaque borderless window at NSFloatingWindowLevel over the
#                  grab point. This is what isolates L3 from L1. Neither
#                  obvious candidate works: the Dock owns ONE full-screen
#                  MOUSE-TRANSPARENT layer-20 window (measured on the guest AND
#                  the maintainer's host) and no separate strip, and Stickies'
#                  Note ▸ Float on Top is unreachable from System Events on
#                  macOS 15.7.7 (-1728, no `Note` menu). Ends by removing the
#                  cover and re-running the same drag, so the cell also proves
#                  the guard is not a wall.
#   C  frontmost   TextEdit activated off to the side → refusal, order unchanged.
#   D  stale       scroll between census and gesture → identity refusal; the
#                  gesture must NOT grab a wrong row silently.
#   E  drop-time   the drop point covered, the grab point clear. E1: the plain
#                  drag pre-checks both endpoints and refuses. E2: the HELD
#                  drag's pre-check passes at the grab and the DROP-TIME
#                  re-check fires on a live gesture → Escape abort.
#   F  dialog      the Repeat dialog opened and LEFT STANDING, then its Cancel
#                  button covered → the shipped click-point refuses, the dialog
#                  is left standing, the cover is removed and the same click
#                  lands, and the normal Cancel rung clears a reopened one. F2
#                  records the auditor's trap: a to-do Repeat drive addresses
#                  every dialog control by ELEMENT, so covering the whole window
#                  does NOT stop it, and should not.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (trial wall
# 2026-07-18). Fixtures fully synthetic. The clone is destroyed on every exit
# path — the trap is armed BEFORE the boot (PROVREM1's incident).
#
# The fixture is SBCHV1's: 12 areas and ~174 sidebar rows including one tall
# wall, so the baseline's guard cost is measured against a field-shaped read.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-ptrgd1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
KEEP="${KEEP:-0}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)
: > "$REPORT"
note() { echo "[ptrgd1] $*" | tee -a "$REPORT"; }

note "=== PTRGD1 — $(date) ==="
df -g /Volumes/Workspace | tail -1 | tee -a "$REPORT"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npm run build >/dev/null 2>&1 || { note "FATAL: build failed"; exit 1; }
fi
[ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }

# ---- ONE VM AT A TIME. Bounded wait, never an unbounded one. -----------------
for attempt in $(seq 1 45); do
  RUNNING=$(tart list 2>/dev/null | awk '$NF=="running"' | grep -cv "^$" || true)
  [ "${RUNNING:-1}" -eq 0 ] && break
  note "  $RUNNING VM(s) running — waiting for a free slot (attempt $attempt/45)"
  sleep 60
done
RUNNING=$(tart list 2>/dev/null | awk '$NF=="running"' | grep -cv "^$" || true)
[ "${RUNNING:-1}" -eq 0 ] || { note "FATAL: a VM is still running after 45min"; exit 1; }
AVAIL=$(df -g /Volumes/Workspace | tail -1 | awk '{print $4}')
[ "${AVAIL:-0}" -ge 10 ] || { note "FATAL: only ${AVAIL}GiB free, floor is 10"; exit 1; }

# ---- teardown FIRST, boot second ---------------------------------------------
cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — $VM left running at ${IP:-?}"; return; fi
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done"
}
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM" || { note "FATAL: clone failed"; exit 1; }
trap cleanup EXIT
tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &
TART_PID=$!
note "tart run pid $TART_PID (owned by this shell)"
IP=$(lab_wait_for_ssh "$VM" 600) || { note "FATAL: no SSH in 600s"; exit 1; }
note "ssh up at $IP"

# ---- airgap + clock pin, BEFORE Things is ever launched ----------------------
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AIRGAP=$(lab_ssh "$IP" 'ping -c1 -t3 1.1.1.1 >/dev/null 2>&1 && echo REACHABLE || echo UNREACHABLE' </dev/null)
note "airgap: 1.1.1.1 is $AIRGAP"
[ "$AIRGAP" = "UNREACHABLE" ] || { note "FATAL: clone still reaches the internet"; exit 1; }
lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
lab_mute_guest "$IP" || true
lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
note "clock pinned: $(lab_ssh "$IP" date </dev/null)"

# ---- guest helpers -----------------------------------------------------------
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-noheader -list); if [ "$1" = "-t" ]; then FMT=(-header -column); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh -t $(printf '%q' "$1")" </dev/null; }
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }

NODE_BIN=$(node -e 'console.log(process.execPath)')
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
# commander by RESOLVED path, not `node_modules/commander`: an agent worktree
# under `.claude/worktrees/` has no node_modules of its own and resolves the
# primary checkout's by walking up, so the relative path is simply absent and
# the guest CLI dies with ERR_MODULE_NOT_FOUND on its first invocation.
COMMANDER_DIR=$(node -e "console.log(require.resolve('commander').replace(/\/(?:index|lib)\b.*$/, ''))" 2>/dev/null)
[ -d "$COMMANDER_DIR" ] || COMMANDER_DIR=$(node -e "
  const { dirname, join } = require('node:path'); const { existsSync } = require('node:fs');
  let d = process.cwd();
  for (;;) { const c = join(d, 'node_modules', 'commander');
    if (existsSync(join(c, 'package.json'))) { console.log(c); break }
    const up = dirname(d); if (up === d) break; d = up }
")
[ -d "$COMMANDER_DIR" ] || { note "FATAL: commander not resolvable — run npm ci"; exit 1; }
note "commander: $COMMANDER_DIR"
scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
lab_ssh "$IP" "$CLI config set experimental-area-reorder true" </dev/null >/dev/null 2>&1
note "cli: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1)"

VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null | tr '\n' '/')
OSV=$(lab_ssh "$IP" 'sw_vers -productVersion; sw_vers -buildVersion' </dev/null | tr '\n' '/')
note "VERSION STAMP — golden: $GOLDEN  things: $VER  macos: $OSV  db: $(gq 'SELECT value FROM Meta WHERE key="databaseVersion"')"

# ---- the leg probe: the SHIPPED guard, asked what it thinks of a point -------
# Generated from dist so it is the same code the gestures carry, never a copy.
node -e "
  import('./dist/write/vectors/ui-pointer-guard.js').then(m => {
    process.stdout.write(m.POINTER_GUARD_STANDALONE + '\n' + \`
var ARG = \\\$.NSProcessInfo.processInfo.arguments;
function argv(i){ return ObjC.unwrap(ARG.objectAtIndex(i + 4)) }
var VERB = argv(0);
function legs(x, y){
  var front = ptrFrontApp(), list = ptrWindowList();
  var wins = front === null ? [] : ptrThingsWindows(front.pid, true);
  var anyw = front === null ? [] : ptrThingsWindows(front.pid, false);
  var inside = false, k;
  for (k = 0; k < wins.length; k++) if (ptrRectHas(wins[k].f, x, y)) inside = true;
  var chain = front === null ? [] : ptrChainAt(front.pid, x, y);
  return {
    point: { x: x, y: y },
    L1_front: front,
    L1_isThings: front !== null && front.bundleId === PTRGD1_BUNDLE,
    L2_mainWindow: wins.length ? wins[0].f : null,
    L2_contains: inside,
    L2_allWindows: anyw.length,
    L3_hitFirst: 'the hit test is authoritative; the scan speaks only when it answers nothing',
    L3_screen: ptrScreenAt(x, y),
    L3_scanOwner: list === null ? null : ptrScanOwnerAt(list, x, y, ptrScreenAt(x, y), ptrIsSystemOwner),
    L3_hitPid: ptrHitPidAt(x, y),
    L3_hitApp: (function(){ var p = ptrHitPidAt(x, y); return p === null ? null : ptrAppName(p) })(),
    L4_chain: ptrChainRoles(chain),
    L4_frames: chain.map(function(c){ return c.f }),
    sentence_drag: ptrGuard('drag the area row', [{x:x,y:y}], {}),
    sentence_click: ptrGuard('click the control', [{x:x,y:y}], { anyWindow: true }),
    ops: PTR_OPS
  };
}
if (VERB === 'legs') { JSON.stringify(legs(Number(argv(1)), Number(argv(2))), null, 1) }
else if (VERB === 'windows') {
  var l = ptrWindowList() || [];
  JSON.stringify(l.map(function(w){ var b = w['kCGWindowBounds'];
    return { pid: w['kCGWindowOwnerPID'], owner: w['kCGWindowOwnerName'], layer: w['kCGWindowLayer'],
             a: w['kCGWindowAlpha'], b: [b.X, b.Y, b.Width, b.Height] } }), null, 1)
}
else if (VERB === 'cost') {
  var n = Number(argv(1)) || 10, t0 = Date.now(), i, base = PTR_OPS;
  for (i = 0; i < n; i++) ptrGuard('drag the area row', [{x:Number(argv(2)),y:Number(argv(3))},{x:Number(argv(2)),y:Number(argv(4))}], {});
  JSON.stringify({ runs: n, totalMs: Date.now() - t0, msPerGuard: (Date.now() - t0) / n, opsPerGuard: (PTR_OPS - base) / n })
}
else { JSON.stringify({ error: 'unknown verb ' + VERB }) }
\`);
  });
" > "$OUT/ptrgd1-probe.jxa.js"
scpO "$OUT/ptrgd1-probe.jxa.js" "admin@$IP:/Users/admin/labh/probe.jxa.js" >/dev/null
scpO lab/scripts/ptrgd1-panel.jxa.js "admin@$IP:/Users/admin/labh/panel.jxa.js" >/dev/null
P() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/probe.jxa.js $(printf '%q ' "$@")" </dev/null 2>&1; }

# ---- app / window plumbing ---------------------------------------------------
OSA() { lab_ssh "$IP" "/usr/bin/osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; true' </dev/null; }
activate_things() { OSA 'tell application "Things3" to activate' >/dev/null; sleep 2; }
things_frame() { OSA 'tell application "System Events" to tell process "Things3" to tell (first window whose subrole is "AXStandardWindow") to return (position as text) & " " & (size as text)'; }
set_things() { OSA "tell application \"System Events\" to tell process \"Things3\" to tell (first window whose subrole is \"AXStandardWindow\") to set {position, size} to {{$1, $2}, {$3, $4}}"; }
screen_size() { OSA 'tell application "Finder" to return bounds of window of desktop'; }

# ---- shipped script shipping -------------------------------------------------
titles_pipe() { gq 'SELECT group_concat(title, "|") FROM (SELECT title FROM TMArea ORDER BY "index", uuid)'; }
area_order() { gq 'SELECT COALESCE(group_concat(t," < "),"(none)") FROM (SELECT title AS t FROM TMArea ORDER BY "index", uuid)'; }
assign_digest() { gq "SELECT uuid||':'||COALESCE(area,'') FROM TMTask WHERE trashed=0 ORDER BY uuid" | shasum | cut -c1-12; }

ship_snap() {
  TITLES="$(titles_pipe)"
  node -e "
    const t = process.argv[1].split('|').filter(Boolean);
    import('./dist/write/vectors/ui-drag.js').then(m => process.stdout.write(m.jxaSidebarSnapshotScript(t)));
  " "$TITLES" > "$OUT/snap.jxa.js"
  scpO "$OUT/snap.jxa.js" "admin@$IP:/Users/admin/labh/snap.jxa.js" >/dev/null
}
snapjson() { lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/snap.jxa.js' </dev/null 2>/dev/null; }

# ship_drag <sx> <sy> <tx> <ty> <srcJSON>
ship_drag() {
  node -e "
    import('./dist/write/vectors/ui-drag.js').then(m => process.stdout.write(
      m.jxaSidebarDragScript(Number(process.argv[1]), Number(process.argv[2]),
                             Number(process.argv[3]), Number(process.argv[4]),
                             JSON.parse(process.argv[5]))));
  " "$1" "$2" "$3" "$4" "$5" > "$OUT/drag.jxa.js"
  scpO "$OUT/drag.jxa.js" "admin@$IP:/Users/admin/labh/drag.jxa.js" >/dev/null
}
run_drag() { lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/drag.jxa.js' </dev/null 2>&1; }

# ship_held <sx> <sy> <anchorTitleJSON> <maxTicks> <srcJSON>
ship_held() {
  TITLES="$(titles_pipe)"
  node -e "
    const t = process.argv[6].split('|').filter(Boolean);
    import('./dist/write/vectors/ui-drag.js').then(m => process.stdout.write(
      m.jxaSidebarHeldScrollDragScript(Number(process.argv[1]), Number(process.argv[2]),
        JSON.parse(process.argv[3]), Number(process.argv[4]), t, JSON.parse(process.argv[5]))));
  " "$1" "$2" "$3" "$4" "$5" "$TITLES" > "$OUT/held.jxa.js"
  scpO "$OUT/held.jxa.js" "admin@$IP:/Users/admin/labh/held.jxa.js" >/dev/null
}
run_held() { lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/held.jxa.js' </dev/null 2>&1; }

# ship_click <x> <y> <what>
ship_click() {
  node -e "
    import('./dist/write/vectors/ui.js').then(m => process.stdout.write(
      m.jxaClickScript(Number(process.argv[1]), Number(process.argv[2]), process.argv[3])));
  " "$1" "$2" "$3" > "$OUT/click.jxa.js"
  scpO "$OUT/click.jxa.js" "admin@$IP:/Users/admin/labh/click.jxa.js" >/dev/null
}
run_click() { lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/click.jxa.js' </dev/null 2>&1; }

# ship_chevron <title>
ship_chevron() {
  TITLES="$(titles_pipe)"
  node -e "
    const t = process.argv[2].split('|').filter(Boolean);
    import('./dist/write/vectors/ui-drag.js').then(m => process.stdout.write(
      m.jxaSidebarChevronClickScript(process.argv[1], -1, t)));
  " "$1" "$TITLES" > "$OUT/chevron.jxa.js"
  scpO "$OUT/chevron.jxa.js" "admin@$IP:/Users/admin/labh/chevron.jxa.js" >/dev/null
}
run_chevron() { lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/chevron.jxa.js' </dev/null 2>&1; }

# rows: the AREA rows of the live snapshot, as "title x y w h", visual order
area_rows() {
  snapjson > "$OUT/ax/snap-live.json"
  python3 - "$OUT/ax/snap-live.json" "$(titles_pipe)" <<'PY'
import json, sys
snap = json.load(open(sys.argv[1]))
titles = [t for t in sys.argv[2].split('|') if t]
if not snap.get('ok'):
    print("SNAPFAIL %s" % snap.get('why')); raise SystemExit
rows = [r for r in snap['rows'] if r.get('y') is not None]
rows.sort(key=lambda r: r['y'])
vp = snap.get('viewport') or {}
print("VIEWPORT %s %s %s %s" % (vp.get('x'), vp.get('y'), vp.get('w'), vp.get('h')))
print("SCROLL %s" % snap.get('scroll'))
print("ROWS %d" % len(rows))
for r in rows:
    segs = (r.get('text') or '').split('|')
    for t in titles:
        if t in segs or (t + '.') in segs:
            print("AREA %s %s %s %s %s" % (t, r['x'], r['y'], r['w'], r['h']))
            break
PY
}

# Scroll the sidebar back to the top, POINTERLESSLY (SBSCR1's scroll-bar write).
# Cells that ran before this one may have left the list scrolled or a section
# folded, and a cell that plans against three visible rows needs a known start.
to_top() {
  node -e "
    const t = process.argv[1].split('|').filter(Boolean);
    import('./dist/write/vectors/ui-drag.js').then(m => process.stdout.write(m.jxaSidebarScrollToScript(0, t)));
  " "$(titles_pipe)" > "$OUT/scroll-top.jxa.js"
  scpO "$OUT/scroll-top.jxa.js" "admin@$IP:/Users/admin/labh/scroll-top.jxa.js" >/dev/null
  lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/scroll-top.jxa.js' </dev/null >/dev/null 2>&1
  sleep 1
}

# ============================================================== fixture
note ""
note "=== fixture — SBCHV1's shape: 12 areas, ~174 sidebar rows, one tall wall ==="
warm
AREAS="Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu"
for A in $AREAS; do
  OSA "tell application \"Things3\" to make new area with properties {name:\"$A\"}" >/dev/null
  sleep 0.6
done
note "areas: $(gq 'SELECT COUNT(*) FROM TMArea')"
seed_projects() {
  local a="$1" n="$2" i
  for i in $(seq -w 1 "$n"); do
    lab_ssh "$IP" "open -g 'things:///add-project?title=$a-P$i&area=$a'" </dev/null >/dev/null 2>&1
    sleep 0.45
  done
}
seed_projects Beta 4
seed_projects Delta 6
seed_projects Eta "${ETA_N:-50}"
seed_projects Theta "${WALL_PROJECTS:-63}"
seed_projects Lambda 5
seed_projects Mu 3
sleep 3
ship_snap
note "area order: $(area_order)"
note "assignment digest: $(assign_digest)"

warm
set_things 40 44 "${WIN_W:-935}" "${WIN_H:-620}" >/dev/null
sleep 2
activate_things
note "screen: $(screen_size)   things window: $(things_frame)"
to_top
area_rows | tee -a "$REPORT" > "$OUT/rows-0.txt"
note "on-screen windows:"; P windows | tee -a "$REPORT" > "$OUT/ax/windows.json"

# Two adjacent visible area rows: the grab (SUBJ) and an anchor below it.
read_row() { grep "^AREA $1 " "$OUT/rows-0.txt" | head -1; }
pick_pair() {
  python3 - "$OUT/rows-0.txt" <<'PY'
import sys
vp = None; rows = []
for line in open(sys.argv[1]):
    p = line.split()
    if p[0] == 'VIEWPORT': vp = [float(x) for x in p[1:5]]
    if p[0] == 'AREA': rows.append((p[1], [float(x) for x in p[2:6]]))
if vp is None: print("NOPAIR"); raise SystemExit
top, h = vp[1] + 8, vp[3] - 16
vis = [(t, f) for (t, f) in rows if top <= f[1] + f[3] / 2 <= top + h]
if len(vis) < 2: print("NOPAIR visible=%d of %d" % (len(vis), len(rows))); raise SystemExit
# The subject is the second visible row where there is one (so the drag has a
# slot above it too); the anchor is the last visible row.
(st, sf) = vis[1] if len(vis) > 2 else vis[0]
(at, af) = vis[-1]
print("%s %g %g %g %g %s %g %g %g %g" % (st, sf[0], sf[1], sf[2], sf[3], at, af[0], af[1], af[2], af[3]))
PY
}
PAIR="$(pick_pair)"
note "pair: $PAIR"
case "$PAIR" in NOPAIR*) note "FATAL: could not pick two visible area rows ($PAIR)"; exit 1 ;; esac
set -- $PAIR
SUBJ="$1"; SX_X="$2"; SX_Y="$3"; SX_W="$4"; SX_H="$5"
ANCH="$6"; AN_Y="$8"; AN_H="${10}"
GRAB_X=$(python3 -c "print(round($SX_X + $SX_W * 0.7))")
GRAB_Y=$(python3 -c "print(round($SX_Y + $SX_H / 2))")
DROP_Y=$(python3 -c "print(round($AN_Y + $AN_H + $AN_H / 4))")
SRC_JSON="{\"x\":$SX_X,\"y\":$SX_Y,\"w\":$SX_W,\"h\":$SX_H}"
note "subject=$SUBJ grab=($GRAB_X,$GRAB_Y) anchor=$ANCH dropY=$DROP_Y src=$SRC_JSON"

# ============================================================== A baseline
note ""
note "=== A baseline — the guarded reorder succeeds, and what the guard costs ==="
PRE_ORDER="$(area_order)"; PRE_DIGEST="$(assign_digest)"
note "  guard cost, in isolation (10 runs, both endpoints):"
note "    $(P cost 10 "$GRAB_X" "$GRAB_Y" "$DROP_Y")"
note "  the shipped drag script, alone (grab -> the anchor's lower boundary):"
ship_drag "$GRAB_X" "$GRAB_Y" "$GRAB_X" "$DROP_Y" "$SRC_JSON"
note "    $(run_drag)"
sleep 2
note "  order after the raw drag: $(area_order)"
note "  digest: $(assign_digest)  (pre: $PRE_DIGEST)"
note "  the field-shaped path — \`area reorder\` end to end:"
warm; set_things 40 44 "${WIN_W:-935}" "${WIN_H:-620}" >/dev/null; sleep 2; activate_things
E2E_SUBJ="${E2E_SUBJ:-Mu}"
G area reorder "$E2E_SUBJ" --first --dangerously-drive-gui --json --verbose > "$OUT/a-e2e.json" 2>&1
python3 -c "
import json,sys
raw = open('$OUT/a-e2e.json').read()
i = raw.find('{')
print('    ' + (raw[:400] if i < 0 else json.dumps(json.loads(raw[i:raw.rfind('}')+1]), indent=1)[:1800]))
" 2>/dev/null | tee -a "$REPORT" || sed 's/^/    /' "$OUT/a-e2e.json" | head -30 | tee -a "$REPORT"
note "  order after e2e: $(area_order)"
note "  digest after e2e: $(assign_digest)  (pre: $PRE_DIGEST)"
note "  chevron (also guarded), for its own guard split:"
ship_chevron "$SUBJ"
note "    $(run_chevron)"

# ============================================================== B foreign
note ""
note "=== B foreign — TextEdit's window over the grab point ==="
ship_snap; area_rows > "$OUT/rows-b.txt"
B_ORDER="$(area_order)"
lab_ssh "$IP" 'open -a TextEdit; sleep 4; osascript -e '\''tell application "TextEdit" to make new document'\'' >/dev/null 2>&1; sleep 2' </dev/null >/dev/null 2>&1
# Park TextEdit's window right over the sidebar band.
OSA "tell application \"System Events\" to tell process \"TextEdit\" to tell window 1 to set {position, size} to {{20, 60}, {520, 520}}" >/dev/null
sleep 1
lab_ssh "$IP" "osascript -e 'tell application \"TextEdit\" to activate'" </dev/null >/dev/null 2>&1
sleep 2
note "  TextEdit window: $(OSA 'tell application "System Events" to tell process "TextEdit" to tell window 1 to return (position as text) & " " & (size as text)')"
note "  legs at the grab point:"
P legs "$GRAB_X" "$GRAB_Y" | sed 's/^/    /' | tee -a "$REPORT" > "$OUT/ax/legs-b.json"
ship_drag "$GRAB_X" "$GRAB_Y" "$GRAB_X" "$DROP_Y" "$SRC_JSON"
note "  the drag script says:"
note "    $(run_drag)"
sleep 2
note "  order unchanged? $( [ "$(area_order)" = "$B_ORDER" ] && echo YES || echo "NO — now $(area_order)" )"
note "  TextEdit document text after the refusal (must be empty): [$(OSA 'tell application "TextEdit" to return text of document 1' | head -3)]"
note "  TextEdit selection after the refusal: [$(OSA 'tell application "System Events" to tell process "TextEdit" to return value of attribute "AXSelectedText" of text area 1 of scroll area 1 of window 1' 2>&1 | head -2)]"

# ============================================================== B2 legs
note ""
note "=== B2 legs — each leg's verdict, Things frontmost (control) and over TextEdit ==="
activate_things
note "  Things frontmost, point INSIDE the sidebar (must pass every leg):"
P legs "$GRAB_X" "$GRAB_Y" | sed 's/^/    /' | tee -a "$REPORT" > "$OUT/ax/legs-b2-control.json"
TE_X=$(python3 -c "print(20 + 520 - 40)")
TE_Y=$(python3 -c "print(60 + 520 - 40)")
note "  Things frontmost, point over TextEdit's still-visible corner ($TE_X,$TE_Y):"
P legs "$TE_X" "$TE_Y" | sed 's/^/    /' | tee -a "$REPORT" > "$OUT/ax/legs-b2-foreign.json"

# ============================================================== the occluder
# A REAL above-Things window. The Dock cannot serve: on this guest (and on the
# maintainer's host) the Dock owns ONE full-screen layer-20 window and no
# separate strip, which is exactly the mouse-transparent case the guard's layer
# band exists for. Stickies can: it ships with macOS and its Note ▸ Float on Top
# puts a note above the frontmost application's own windows. That is the
# only stock surface that isolates OCCLUSION from FRONTMOST.
occluder_layer() { # -> the highest window level the occluder currently holds
  P windows | python3 -c "
import json,sys
try: ws = json.load(sys.stdin)
except Exception: print('NONE'); raise SystemExit
s = [w for w in ws if w['owner'] == 'osascript']
print(max([w['layer'] for w in s]) if s else 'NONE')
" 2>/dev/null
}
# An opaque, click-catching window ABOVE Things while Things stays FRONTMOST.
#
# Two candidates were tried and one survived. STICKIES (Note ▸ Float on Top)
# was the faithful shape — a real app with a real AX tree — but on macOS 15.7.7
# `process "Stickies"` exposes no `Note` menu to System Events (-1728), so the
# note never floats and the cell measures nothing. What works is a borderless
# `NSWindow` at `NSFloatingWindowLevel` (3), the level an ordinary always-on-top
# palette uses, put up by a JXA process under the ACCESSORY activation policy so
# it never takes the front. It self-terminates and lives entirely inside the
# disposable clone.
occluder_open() { # <x> <y> <w> <h>
  local layer
  lab_ssh "$IP" "nohup /usr/bin/osascript -l JavaScript ~/labh/panel.jxa.js $1 $2 $3 $4 ${OCCLUDER_SECS:-240} >/dev/null 2>&1 & echo started" </dev/null >/dev/null 2>&1
  sleep 4
  activate_things
  layer="$(occluder_layer)"
  note "  occluder: a floating NSPanel at ($1,$2 ${3}x${4}), layer=$layer; front app now $(OSA 'tell application "System Events" to return name of first application process whose frontmost is true')"
  P windows > "$OUT/ax/windows-occluded.json" 2>/dev/null
  OCCLUDER_LAYER="$layer"
}
# A SECOND panel, for a cell that must cover both sides of a clear band.
occluder_add() { # <x> <y> <w> <h>
  lab_ssh "$IP" "nohup /usr/bin/osascript -l JavaScript ~/labh/panel.jxa.js $1 $2 $3 $4 ${OCCLUDER_SECS:-240} >/dev/null 2>&1 & echo started" </dev/null >/dev/null 2>&1
  sleep 3
  activate_things
  note "  second panel at ($1,$2 ${3}x${4})"
}
occluder_close() {
  lab_ssh "$IP" 'pkill -f panel.jxa.js' </dev/null >/dev/null 2>&1
  sleep 2
  activate_things
}

# ============================================================== B3 occlusion
note ""
note "=== B3 occlusion — a floating foreign window over the grab point, Things FRONTMOST ==="
warm; set_things 40 44 "${WIN_W:-935}" "${WIN_H:-620}" >/dev/null; sleep 2; activate_things
ship_snap; area_rows > "$OUT/rows-b3.txt"
B3_PLAN="$(python3 - "$OUT/rows-b3.txt" <<'PY'
import sys
vp = None; rows = []
for line in open(sys.argv[1]):
    p = line.split()
    if p[0] == 'VIEWPORT': vp = [float(x) for x in p[1:5]]
    if p[0] == 'AREA': rows.append((p[1], [float(x) for x in p[2:6]]))
top, h = vp[1] + 8, vp[3] - 16
vis = [(t, f) for (t, f) in rows if top <= f[1] + f[3] / 2 <= top + h]
if len(vis) < 2: print("NOPLAN visible=%d" % len(vis)); raise SystemExit
(st, sf) = vis[1] if len(vis) > 2 else vis[0]
(at, af) = vis[-1]
print("%s %g %g %g %g %s %g %g %g %g" % (st, sf[0], sf[1], sf[2], sf[3], at, af[0], af[1], af[2], af[3]))
PY
)"
note "  plan: $B3_PLAN"
if [ "$B3_PLAN" = "NOPLAN" ]; then
  note "  SKIPPED — fewer than three area rows visible"
else
  set -- $B3_PLAN
  B3_SUBJ="$1"; B3_X="$2"; B3_Y="$3"; B3_W="$4"; B3_H="$5"
  B3_AN="$6"; B3_AY="$8"; B3_AH="${10}"
  B3_GX=$(python3 -c "print(round($B3_X + $B3_W * 0.7))")
  B3_GY=$(python3 -c "print(round($B3_Y + $B3_H / 2))")
  B3_DY=$(python3 -c "print(round($B3_AY + $B3_AH + $B3_AH / 4))")
  B3_SRC="{\"x\":$B3_X,\"y\":$B3_Y,\"w\":$B3_W,\"h\":$B3_H}"
  note "  grab $B3_SUBJ at ($B3_GX,$B3_GY), drop below $B3_AN at y=$B3_DY"
  B3_ORDER="$(area_order)"; B3_DIGEST="$(assign_digest)"
  occluder_open "$(python3 -c "print($B3_GX - 90)")" "$(python3 -c "print($B3_GY - 40)")" 260 90
  note "  legs at the grab point (Things frontmost, a floating note over it):"
  P legs "$B3_GX" "$B3_GY" | sed 's/^/    /' | tee -a "$REPORT" > "$OUT/ax/legs-b3.json"
  ship_drag "$B3_GX" "$B3_GY" "$B3_GX" "$B3_DY" "$B3_SRC"
  note "  the drag script says:"
  note "    $(run_drag)"
  ship_chevron "$B3_SUBJ"
  note "  the chevron script says:"
  note "    $(run_chevron)"
  sleep 2
  note "  order unchanged? $( [ "$(area_order)" = "$B3_ORDER" ] && echo YES || echo "NO — now $(area_order)" )"
  note "  digest unchanged? $( [ "$(assign_digest)" = "$B3_DIGEST" ] && echo YES || echo NO )"
  occluder_close
  note "  --- and with the note gone, the same drag lands (the guard is not a wall) ---"
  ship_snap; area_rows > "$OUT/rows-b3b.txt"
  note "    $(run_drag)"
  sleep 2
  note "  order now: $(area_order)"
fi

# ============================================================== C frontmost
note ""
note "=== C frontmost — TextEdit activated off to the side ==="
OSA "tell application \"System Events\" to tell process \"TextEdit\" to tell window 1 to set {position, size} to {{1200, 500}, {320, 260}}" >/dev/null
sleep 1
lab_ssh "$IP" "osascript -e 'tell application \"TextEdit\" to activate'" </dev/null >/dev/null 2>&1
sleep 2
C_ORDER="$(area_order)"
ship_snap
note "  legs at the grab point:"
P legs "$GRAB_X" "$GRAB_Y" | sed 's/^/    /' | tee -a "$REPORT" > "$OUT/ax/legs-c.json"
ship_drag "$GRAB_X" "$GRAB_Y" "$GRAB_X" "$DROP_Y" "$SRC_JSON"
note "  the drag script says:"
note "    $(run_drag)"
note "  the chevron script says:"
ship_chevron "$SUBJ"
note "    $(run_chevron)"
note "  the wheel-scroll fallback says:"
node -e "
  const t = process.argv[1].split('|').filter(Boolean);
  import('./dist/write/vectors/ui-drag.js').then(m => process.stdout.write(m.jxaSidebarScrollScript(-3, t)));
" "$(titles_pipe)" > "$OUT/wheel.jxa.js"
scpO "$OUT/wheel.jxa.js" "admin@$IP:/Users/admin/labh/wheel.jxa.js" >/dev/null
note "    $(lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/wheel.jxa.js' </dev/null 2>&1 | tail -2 | tr '\n' ' ')"
sleep 2
note "  order unchanged? $( [ "$(area_order)" = "$C_ORDER" ] && echo YES || echo "NO — now $(area_order)" )"
lab_ssh "$IP" "osascript -e 'tell application \"TextEdit\" to quit saving no'" </dev/null >/dev/null 2>&1
sleep 2

# ============================================================== D stale frames
note ""
note "=== D stale frames — the sidebar scrolls between the census and the gesture ==="
warm; set_things 40 44 "${WIN_W:-935}" "${WIN_H:-620}" >/dev/null; sleep 2; activate_things
ship_snap; area_rows > "$OUT/rows-d0.txt"
D_PAIR="$(python3 - "$OUT/rows-d0.txt" <<'PY'
import sys
vp = None; rows = []
for line in open(sys.argv[1]):
    p = line.split()
    if p[0] == 'VIEWPORT': vp = [float(x) for x in p[1:5]]
    if p[0] == 'AREA': rows.append((p[1], [float(x) for x in p[2:6]]))
top, h = vp[1] + 8, vp[3] - 16
vis = [(t, f) for (t, f) in rows if top <= f[1] + f[3] / 2 <= top + h]
(st, sf) = vis[1] if len(vis) > 1 else vis[0]
print("%s %g %g %g %g" % (st, sf[0], sf[1], sf[2], sf[3]))
PY
)"
set -- $D_PAIR
D_SUBJ="$1"; D_X="$2"; D_Y="$3"; D_W="$4"; D_H="$5"
D_GRAB_X=$(python3 -c "print(round($D_X + $D_W * 0.7))")
D_GRAB_Y=$(python3 -c "print(round($D_Y + $D_H / 2))")
D_SRC="{\"x\":$D_X,\"y\":$D_Y,\"w\":$D_W,\"h\":$D_H}"
note "  planned against $D_SUBJ at grab ($D_GRAB_X,$D_GRAB_Y), row $D_SRC"
ship_drag "$D_GRAB_X" "$D_GRAB_Y" "$D_GRAB_X" "$(python3 -c "print($D_GRAB_Y + 120)")" "$D_SRC"
# NOW scroll — pointerlessly, through the scroll bar's own AXValue (SBSCR1).
node -e "
  const t = process.argv[1].split('|').filter(Boolean);
  import('./dist/write/vectors/ui-drag.js').then(m => process.stdout.write(m.jxaSidebarScrollToScript(0.45, t)));
" "$(titles_pipe)" > "$OUT/scrollto.jxa.js"
scpO "$OUT/scrollto.jxa.js" "admin@$IP:/Users/admin/labh/scrollto.jxa.js" >/dev/null
note "  scrolled: $(lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/scrollto.jxa.js' </dev/null 2>&1)"
sleep 1
D_ORDER="$(area_order)"; D_DIGEST="$(assign_digest)"
note "  legs at the now-stale grab point:"
P legs "$D_GRAB_X" "$D_GRAB_Y" | sed 's/^/    /' | tee -a "$REPORT" > "$OUT/ax/legs-d.json"
note "  the stale-framed drag script says:"
note "    $(run_drag)"
sleep 2
note "  order unchanged? $( [ "$(area_order)" = "$D_ORDER" ] && echo YES || echo "NO — now $(area_order)" )"
note "  assignment digest unchanged? $( [ "$(assign_digest)" = "$D_DIGEST" ] && echo YES || echo "NO — a to-do or project moved" )"
note "  what row is actually there now:"
ship_snap; area_rows | sed 's/^/    /' | tee -a "$REPORT" > "$OUT/rows-d1.txt"

# ============================================================== E drop-time
note ""
note "=== E drop-time re-check — the DROP half covered, the grab point clear ==="
warm; set_things 40 44 "${WIN_W:-935}" "${WIN_H:-620}" >/dev/null; sleep 2; activate_things
to_top
ship_snap; area_rows > "$OUT/rows-e.txt"
E_PLAN="$(python3 - "$OUT/rows-e.txt" <<'PY'
import sys
vp = None; rows = []
for line in open(sys.argv[1]):
    p = line.split()
    if p[0] == 'VIEWPORT': vp = [float(x) for x in p[1:5]]
    if p[0] == 'AREA': rows.append((p[1], [float(x) for x in p[2:6]]))
if vp is None: print("NOPLAN no-viewport"); raise SystemExit
top, h = vp[1] + 8, vp[3] - 16
vis = [(t, f) for (t, f) in rows if top <= f[1] + f[3] / 2 <= top + h]
if len(vis) < 2: print("NOPLAN visible=%d" % len(vis)); raise SystemExit
(st, sf) = vis[0]
(at, af) = vis[-1]
# The covered band: from a little below the grab row to the bottom of the
# viewport, so WHEREVER the held drag decides to drop, it drops into it.
cover_top = sf[1] + sf[3] + 24
print("%s %g %g %g %g %s %g %g %g %g %g %g %g" % (
    st, sf[0], sf[1], sf[2], sf[3], at, af[0], af[1], af[2], af[3],
    cover_top, vp[0], vp[1] + vp[3]))
PY
)"
note "  plan: $E_PLAN"
case "$E_PLAN" in
  NOPLAN*) note "  SKIPPED — $E_PLAN" ;;
  *)
  set -- $E_PLAN
  E_SUBJ="$1"; E_X="$2"; E_Y="$3"; E_W="$4"; E_H="$5"
  E_AN="$6"; E_AY="$8"; E_AH="${10}"
  E_COVER_TOP="${11}"; E_VPX="${12}"; E_VPBOT="${13}"
  E_GX=$(python3 -c "print(round($E_X + $E_W * 0.7))")
  E_GY=$(python3 -c "print(round($E_Y + $E_H / 2))")
  E_DY=$(python3 -c "print(round($E_AY + $E_AH + $E_AH / 4))")
  E_SRC="{\"x\":$E_X,\"y\":$E_Y,\"w\":$E_W,\"h\":$E_H}"
  note "  grab $E_SUBJ at ($E_GX,$E_GY) — clear; the whole band below y=$E_COVER_TOP — covered"
  # The cover spans the sidebar's full width from just under the grab row to the
  # bottom of the viewport. The held drag re-resolves its drop boundary LIVE, so
  # a spot cover can (and in an earlier pass did) miss where it decides to land.
  occluder_open "$(python3 -c "print(int($E_VPX) - 10)")" "$(python3 -c "print(int($E_COVER_TOP))")" \
                "$(python3 -c "print(int($E_W) + 40)")" "$(python3 -c "print(int($E_VPBOT - $E_COVER_TOP) + 10)")"
  # The held drag re-resolves its drop boundary LIVE and was MEASURED choosing a
  # point 20 pt ABOVE the grab row, so covering only the band below leaves it a
  # legal place to land. Cover above as well, leaving a narrow clear band on the
  # grab row itself -- which is what the pre-check needs and all it needs.
  occluder_add "$(python3 -c "print(int($E_VPX) - 10)")" "$(python3 -c "print(int($E_Y) - 120)")" \
               "$(python3 -c "print(int($E_W) + 40)")" 112
  note "  legs at the GRAB point (must PASS):"
  P legs "$E_GX" "$E_GY" | sed 's/^/    /' | tee -a "$REPORT" > "$OUT/ax/legs-e-grab.json"
  note "  legs at the DROP point (must REFUSE):"
  P legs "$E_GX" "$E_DY" | sed 's/^/    /' | tee -a "$REPORT" > "$OUT/ax/legs-e-drop.json"
  E1_ORDER="$(area_order)"; E1_DIGEST="$(assign_digest)"
  note "  E1 — the PLAIN drag pre-checks BOTH endpoints, so it refuses before the press:"
  ship_drag "$E_GX" "$E_GY" "$E_GX" "$E_DY" "$E_SRC"
  note "    $(run_drag)"
  sleep 2
  note "    order unchanged? $( [ "$(area_order)" = "$E1_ORDER" ] && echo YES || echo "NO — now $(area_order)" )"
  note "    digest unchanged? $( [ "$(assign_digest)" = "$E1_DIGEST" ] && echo YES || echo NO )"
  E2_ORDER="$(area_order)"; E2_DIGEST="$(assign_digest)"
  note "  E2 — the HELD drag pre-checks the GRAB only; its drop point is computed"
  note "       mid-gesture, so this is the drop-time re-check firing on a LIVE drag:"
  ship_held "$E_GX" "$E_GY" "\"$E_AN\"" 40 "$E_SRC"
  note "    $(run_held)"
  sleep 3
  note "    order unchanged? $( [ "$(area_order)" = "$E2_ORDER" ] && echo YES || echo "NO — now $(area_order)" )"
  note "    digest unchanged? $( [ "$(assign_digest)" = "$E2_DIGEST" ] && echo YES || echo NO )"
  occluder_close
  note "  --- cover removed: the same held drag lands (the guard is not a wall) ---"
  ship_snap
  note "    $(run_held)"
  sleep 3
  note "    order now: $(area_order)"
  ;;
esac

# ============================================================== F dialog
note ""
note "=== F dialog — the Repeat dialog's click-point with a window over its button ==="
warm; set_things 40 44 "${WIN_W:-935}" "${WIN_H:-620}" >/dev/null; sleep 2; activate_things
lab_ssh "$IP" "open -g 'things:///add?title=PTRGD1-F-subject'" </dev/null >/dev/null 2>&1
sleep 3
F_UUID="$(gq "SELECT uuid FROM TMTask WHERE title='PTRGD1-F-subject' AND trashed=0 LIMIT 1")"
note "  subject: $F_UUID"
lab_ssh "$IP" "open -g 'things:///show?id=$F_UUID'" </dev/null >/dev/null 2>&1
sleep 3
activate_things
# Open the dialog the way the recipe's reveal does and LEAVE IT STANDING. The
# item is found by INDEX from the live menu, never by its literal name: its title
# ends in a real U+2026 and the quoting round-trip through ssh mangles it.
F_ITEMS="$(OSA 'tell application "System Events" to tell process "Things3" to return name of every menu item of menu "Items" of menu bar 1' 2>&1)"
note "  Items menu: $(echo "$F_ITEMS" | head -c 400)"
F_IDX="$(python3 -c "
import sys
items = [s.strip() for s in '''$F_ITEMS'''.split(',')]
hits = [i + 1 for i, s in enumerate(items) if s.startswith('Repeat') and s != 'Repeat']
print(hits[0] if hits else 0)
")"
note "  Repeat… is item $F_IDX; enabled=$(OSA "tell application \"System Events\" to tell process \"Things3\" to return enabled of menu item $F_IDX of menu \"Items\" of menu bar 1" 2>&1)"
sheet_count() { OSA 'tell application "System Events" to tell process "Things3" to return (count of sheets of window 1)' 2>&1 | tail -1; }
open_repeat_sheet() { # press the Repeat item, then WAIT for the sheet to arrive
  local i
  [ "${F_IDX:-0}" -gt 0 ] 2>/dev/null || return 1
  OSA "tell application \"System Events\" to tell process \"Things3\" to click menu item $F_IDX of menu \"Items\" of menu bar 1" >/dev/null 2>&1
  for i in 1 2 3 4 5 6 7 8; do
    [ "$(sheet_count)" = "1" ] && return 0
    sleep 2
  done
  return 1
}
open_repeat_sheet
note "  sheets on window 1: $(sheet_count)"
F_CANCEL="$(OSA 'tell application "System Events" to tell process "Things3" to tell (first button of sheet 1 of window 1 whose title is "Cancel") to return (position as text) & " " & (size as text)' 2>&1)"
note "  Cancel button frame: $F_CANCEL"
if [[ "$F_CANCEL" == *","* ]]; then
  read -r FBX FBY FBW FBH <<<"$(python3 -c "
import re
print(' '.join(re.findall(r'-?[0-9]+', '''$F_CANCEL''')[:4]))
")"
  FPX=$(python3 -c "print(round($FBX + $FBW/2))")
  FPY=$(python3 -c "print(round($FBY + $FBH/2))")
  note "  Cancel centre: ($FPX,$FPY)"
  note "  legs there with nothing over it (the control):"
  P legs "$FPX" "$FPY" | sed 's/^/    /' | tee -a "$REPORT" > "$OUT/ax/legs-f-control.json"
  ship_click "$FPX" "$FPY" "click the open dialog's Cancel button"
  occluder_open "$(python3 -c "print($FPX - 150)")" "$(python3 -c "print($FPY - 90)")" 300 180
  note "  legs at the Cancel centre, covered:"
  P legs "$FPX" "$FPY" | sed 's/^/    /' | tee -a "$REPORT" > "$OUT/ax/legs-f.json"
  note "  the click-point script says:"
  note "    $(run_click)"
  sleep 2
  note "  dialog still standing? sheets=$(OSA 'tell application "System Events" to tell process "Things3" to return (count of sheets of window 1)' 2>&1 | tail -1)"
  occluder_close
  note "  --- cover removed: the same click-point lands on Cancel ---"
  note "    $(run_click)"
  sleep 2
  note "  sheets now: $(OSA 'tell application "System Events" to tell process "Things3" to return (count of sheets of window 1)' 2>&1 | tail -1)"
  note "  the subject is still non-repeating? $(gq "SELECT CASE WHEN rt1_recurrenceRule IS NULL THEN 'YES' ELSE 'NO' END FROM TMTask WHERE uuid='$F_UUID'")"
  note "  --- and the Cancel rung on a dialog reopened and left standing ---"
  open_repeat_sheet
  note "  sheets before the rung: $(sheet_count)"
  G rescue dismiss --dangerously-dismiss-dialog --json > "$OUT/f-rescue.json" 2>&1
  grep -v -e ExperimentalWarning -e trace-warnings "$OUT/f-rescue.json" | sed 's/^/    /' | head -4 | tee -a "$REPORT"
  note "  sheets after the rung: $(OSA 'tell application "System Events" to tell process "Things3" to return (count of sheets of window 1)' 2>&1 | tail -1)"
else
  note "  SKIPPED — the Repeat dialog did not open (Cancel frame unresolved)"
fi

# ---- F2: the FIELD-SHAPED arm, and what it shows about this recipe ----------
note ""
note "  F2 — the same op through the NORMAL CLI with the WHOLE Things window covered:"
warm; set_things 40 44 "${WIN_W:-935}" "${WIN_H:-620}" >/dev/null; sleep 2; activate_things
F2_UUID="$(gq "SELECT uuid FROM TMTask WHERE title='PTRGD1-F-subject' AND trashed=0 LIMIT 1")"
G rescue dismiss --dangerously-dismiss-dialog --json >/dev/null 2>&1
sleep 2
occluder_open 40 44 "${WIN_W:-935}" "${WIN_H:-620}"
G todo make-repeating "$F2_UUID" --frequency daily --interval 1 --dangerously-drive-gui --json > "$OUT/f2-drive.json" 2>&1
grep -v -e ExperimentalWarning -e trace-warnings "$OUT/f2-drive.json" | sed 's/^/    /' | head -6 | tee -a "$REPORT"
occluder_close
note "  (a to-do Repeat drive addresses every dialog control by ELEMENT — AXPress and"
note "   set-value — so a cover over the window does not stop it, and should not:"
note "   its only pointer hops are the Cancel rung's fallback and the project-verb"
note "   repeat-bar popover. F1 above is the pointer hop, guarded.)"

# ============================================================== closing state
note ""
note "=== closing state ==="
note "  area order: $(area_order)"
note "  assignment digest: $(assign_digest)"
note "  areas: $(gq 'SELECT COUNT(*) FROM TMArea')  projects: $(gq 'SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0')"

note ""
note "=== PTRGD1 done — $(date) ==="
