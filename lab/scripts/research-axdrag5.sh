#!/bin/bash
# AXDRAG5 — the field stall: why `area reorder --dangerously-drive-gui` ground
# for 332s on a real sidebar, then reported a landed partial move as a silent
# no-op (issue #658).
#
# BACKGROUND. The AXDRAG1/2/4 certifications seeded BARE areas — an area row and
# almost nothing under it. A real sidebar is not shaped like that: Things renders
# every area's PROJECTS beneath its row, so one area's "section" can be dozens of
# rows tall. Both SHIPPED rungs of the drag ladder (rung 1, and the rung-3
# multi-hop floor; rung 2 ships dark per oddities §9) require the source row and
# the drop boundary to be inside the viewport AT THE SAME TIME. A section taller
# than the viewport is therefore a WALL — and the shipped refusal blames "the
# viewport is too small", which reads as "make your window bigger" for a geometry
# no window size fixes.
#
# CELLS:
#   census  the sidebar row census + geometry: what Things actually renders per
#           area, section heights vs the viewport, and what ONE shipped
#           sidebar-snapshot costs on a realistic sidebar (the 332s grind and
#           the #651 "sidebar did not resolve" timeout are both suspected to be
#           this number).
#   wall    reproduce the field failure end-to-end through the SHIPPED CLI: a
#           move whose path crosses a section taller than the viewport. Oracles:
#           the full TMArea index vector before/after, wall-clock, the exit
#           envelope's own claims.
#   empty   the control: the same move across EMPTY areas only (no projects) —
#           the geometry the certifications covered.
#   chord   THE BIG CELL (CHORD2 §11 left it unprobed): do the ⌘-arrow reorder
#           chords work on SIDEBAR rows? AX-select an AREA row, post ⌘↑/⌘↓/⌘⌥↑/
#           ⌘⌥↓ with CGEventPostToPid, Things BACKGROUNDED. If area rows honor
#           them the whole drag ladder retires and section height stops
#           mattering.
#   cproj   the same on a sidebar PROJECT row.
#   reship  rebuild + redeploy dist (to re-run `wall` against the FIXED driver).
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (trial wall
# 2026-07-18). Fixtures fully synthetic. Clone destroyed on teardown.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-axdrag5-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)
note() { echo "[axdrag5] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

# CGEvent modifier flag masks + arrow key codes (CHORD2)
FCMD=1048576        # ⌘
FCMDOPT=1572864     # ⌘⌥
KUP=126
KDOWN=125

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

KEYPID='ObjC.import("AppKit"); ObjC.import("ApplicationServices"); ObjC.import("CoreGraphics");
function pidOf(n){ return Application("System Events").processes.byName(n).unixId() }
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function run(argv){
  var pid=pidOf("Things3"), code=+argv[0], flags=+argv[1], n=argv[2]?+argv[2]:1, i;
  for(i=0;i<n;i++){
    var d=$.CGEventCreateKeyboardEvent($(),code,true), u=$.CGEventCreateKeyboardEvent($(),code,false);
    $.CGEventSetFlags(d,flags); $.CGEventSetFlags(u,flags);
    $.CGEventPostToPid(pid,d); sleepMs(70); $.CGEventPostToPid(pid,u); sleepMs(90);
  }
  return "POSTED-TO-PID "+pid+" code="+code+" flags="+flags+" x"+n }'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
show() { lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 3" </dev/null; }
front() { axq 'tell application "System Events" to return name of first process whose frontmost is true'; }
tofinder() { lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 3' </dev/null; }
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; true' </dev/null; }

# ---- the beep sentinel (probe opt-out: counted, never failing) --------------
bs()    { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh $*" </dev/null 2>&1; }
bmark() { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }

# ---- the disruption monitor slice ------------------------------------------
mon_mark()  { MON_AT=$(lab_ssh "$IP" 'wc -l < ~/things-lab/events.ndjson 2>/dev/null || echo 0' </dev/null | tr -d ' '); }
mon_slice() { lab_ssh "$IP" "tail -n +$(( ${MON_AT:-0} + 1 )) ~/things-lab/events.ndjson 2>/dev/null" </dev/null; }
mon_verdict() {
  local sl nl steal wins launch
  sl=$(mon_slice); nl=$(printf '%s' "$sl" | grep -c . )
  note "    monitor slice ($nl event(s)) for $1:"
  if [ "$nl" -gt 0 ]; then printf '%s\n' "$sl" | sed 's/^/      /' | tee -a "$REPORT"; fi
  steal=$(printf '%s' "$sl" | grep -c '"kind":"frontmost"\|"kind":"activate"')
  wins=$(printf '%s' "$sl" | grep -c '"kind":"window-new"\|"kind":"title-change"')
  launch=$(printf '%s' "$sl" | grep -c '"kind":"launch"')
  if [ "$steal" -eq 0 ] && [ "$wins" -eq 0 ]; then
    note "    DISRUPTION: tier $([ "$launch" -gt 0 ] && echo 1 || echo 0) — NO focus steal, NO new window  *** CLEAN ***"
  else
    note "    *** DISRUPTION: $steal focus/activate signal(s), $wins window signal(s) — NOT clean ***"
  fi
}

# ---- the sidebar oracles ----------------------------------------------------
# The canonical sidebar sort is TMArea."index" ASC, uuid ASC (AXDRAG3).
area_order()  { gq 'SELECT COALESCE(group_concat(t," < "),"(none)") FROM (SELECT title AS t FROM TMArea ORDER BY "index", uuid)'; }
area_dump()   { gt 'SELECT title, substr(uuid,1,8) AS uuid8, "index" AS idx, visible FROM TMArea ORDER BY "index", uuid'; }
area_vector() { gq 'SELECT title||"="||"index" FROM TMArea ORDER BY "index", uuid' | tr '\n' ' '; }
aid()         { gq "SELECT uuid FROM TMArea WHERE title='$1' LIMIT 1"; }
# the invariance tripwire the drag driver itself uses
assign_digest() { gq "SELECT uuid||':'||COALESCE(area,'') FROM TMTask WHERE trashed=0 ORDER BY uuid" | shasum | cut -c1-12; }
areacount()   { gq 'SELECT COUNT(*) FROM TMArea'; }

# the SHIPPED sidebar snapshot, run in-guest
snapjson() { lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/sidebar-snap.js' </dev/null 2>/dev/null; }
snaptime() { lab_ssh "$IP" 'S=$( { /usr/bin/time -p /usr/bin/osascript -l JavaScript ~/labh/sidebar-snap.js >/tmp/snap.json ; } 2>&1 ); echo "$S" | tr "\n" " "; echo "bytes=$(wc -c < /tmp/snap.json)"' </dev/null 2>&1; }

# window size (the viewport lever)
setwin() { lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set size of (first window whose subrole is \"AXStandardWindow\") to {$1, $2}'" </dev/null 2>&1; }

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }

# ============================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "=== AXDRAG5 setup — $(date) ==="
  df -g /Volumes/Workspace | tail -1 | tee -a "$REPORT"
  if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }; fi
  [ -f dist/cli/main.js ] || { echo "no dist/cli/main.js" >&2; exit 1; }

  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || exit 1
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "guest ip: $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  note "airgap: $AG"; [ "$AG" = "AIRGAP-OK" ] || exit 1
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "clock: $(lab_ssh "$IP" 'date' </dev/null)"

  lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  printf '%s\n' "$GSQL"   | lab_ssh "$IP" 'cat > ~/labh/gsql.sh; chmod +x ~/labh/gsql.sh'
  printf '%s\n' "$KEYPID" | lab_ssh "$IP" 'cat > ~/labh/keypid.js'
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null 2>&1
  lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null
  note "monitor: $(lab_ssh "$IP" 'launchctl list | grep -i disrupt || echo none' </dev/null)"

  # the SHIPPED sidebar snapshot script (the exact one the driver runs)
  node -e "import('./dist/write/vectors/ui-drag.js').then(m=>process.stdout.write(m.jxaSidebarSnapshotScript()))" > "$OUT/sidebar-snap.js"
  lab_ssh "$IP" 'cat > ~/labh/sidebar-snap.js' < "$OUT/sidebar-snap.js"

  warm
  TOKEN=$(gq 'SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1')
  VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null | tr '\n' '/')
  OSV=$(lab_ssh "$IP" 'sw_vers -productVersion; sw_vers -buildVersion' </dev/null | tr '\n' '/')
  note "things: $VER  macos: $OSV  db: $(gq 'SELECT value FROM Meta WHERE key="databaseVersion"' 2>/dev/null)"

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "cli: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1)"

  { echo "IP=$IP"; echo "TOKEN=$TOKEN"; } > "$SESSION"
  note "=== setup done ==="
  exit 0
fi

# ============================================================== reship
if [ "$CMD" = "reship" ]; then
  load_session
  npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  node -e "import('./dist/write/vectors/ui-drag.js').then(m=>process.stdout.write(m.jxaSidebarSnapshotScript()))" > "$OUT/sidebar-snap.js"
  lab_ssh "$IP" 'cat > ~/labh/sidebar-snap.js' < "$OUT/sidebar-snap.js"
  note "reshipped dist ($(date))"
  exit 0
fi

# ============================================================== seed
# The FIELD SHAPE, fully synthetic: twelve areas, one of them carrying enough
# projects that its sidebar section is taller than the whole viewport, and a
# run of EMPTY areas the subject can cross freely (the control geometry).
if [ "$CMD" = "seed" ]; then
  load_session
  note "=== seed — the field-shaped sidebar ==="
  AREAS="Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu"
  for A in $AREAS; do
    lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to make new area with properties {name:\"$A\"}'" </dev/null >/dev/null 2>&1
    sleep 1
  done
  note "areas seeded: $(areacount)"
  # projects per area — Eta is THE WALL; Theta/Iota/Kappa stay empty.
  seed_projects() { # <area> <count>
    local a="$1" n="$2" i
    for i in $(seq -w 1 "$n"); do
      lab_ssh "$IP" "open -g 'things:///add-project?title=$a-P$i&area=$a'" </dev/null >/dev/null 2>&1
      sleep 0.7
    done
  }
  seed_projects Alpha 2
  seed_projects Epsilon 3
  seed_projects Zeta 4
  seed_projects Eta "${ETA_PROJECTS:-24}"
  seed_projects Lambda 3
  seed_projects Mu 1
  sleep 3
  note "project census per area:"
  gt 'SELECT a.title AS area, COUNT(t.uuid) AS projects FROM TMArea a LEFT JOIN TMTask t ON t.area=a.uuid AND t.type=1 AND t.trashed=0 AND t.status=0 GROUP BY a.uuid ORDER BY a."index", a.uuid' | tee -a "$REPORT"
  note "area order: $(area_order)"
  note "index vector: $(area_vector)"
  exit 0
fi

# ============================================================== census
if [ "$CMD" = "census" ]; then
  load_session
  note "=== census — what the sidebar RENDERS, and what one snapshot costs ==="
  warm
  W="${WIN_W:-935}"; H="${WIN_H:-420}"
  note "window -> ${W}x${H}: $(setwin "$W" "$H")"
  sleep 2
  note "AX scroll-area map:"
  axq 'tell application "System Events" to tell process "Things3"
  set w to (first window whose subrole is "AXStandardWindow")
  set out to ""
  repeat with i from 1 to (count scroll areas of w)
    set sa to scroll area i of w
    set out to out & "  scroll area " & i & " size=" & ((size of sa) as text) & " pos=" & ((position of sa) as text) & " tables=" & (count tables of sa) & " outlines=" & (count outlines of sa) & " rows=" & (count rows of (table 1 of sa)) & linefeed
  end repeat
  return out
end tell' | tee -a "$REPORT"

  note "snapshot cost (3 runs):"
  for i in 1 2 3; do note "  run $i: $(snaptime)"; done

  snapjson > "$OUT/census-snap.json"
  note "snapshot bytes: $(wc -c < "$OUT/census-snap.json" | tr -d ' ')"
  AREAS_CSV=$(gq 'SELECT group_concat(title, "|") FROM (SELECT title FROM TMArea ORDER BY "index", uuid)')
  python3 - "$OUT/census-snap.json" "$AREAS_CSV" <<'PY' | tee -a "$REPORT"
import json, sys
snap = json.load(open(sys.argv[1]))
titles = [t for t in sys.argv[2].split('|') if t]
vp = snap.get('viewport') or {}
rows = [r for r in snap['rows'] if r.get('y') is not None]
rows.sort(key=lambda r: r['y'])
def is_area(r):
    segs = (r.get('text') or '').split('|')
    for t in titles:
        if t in segs or (t + '.') in segs:
            return t
    return None
print("  viewport: y=%s h=%s  (usable single-drag span = h - 24 = %s)" % (vp.get('y'), vp.get('h'), (vp.get('h') or 0) - 24))
print("  table rows resolved: %d" % len(rows))
areas = [(is_area(r), r) for r in rows]
areas = [(t, r) for (t, r) in areas if t]
print("  area rows resolved: %d of %d" % (len(areas), len(titles)))
bottom = max((r['y'] + r['h']) for r in rows)
usable = (vp.get('h') or 0) - 24
print("  %-10s %8s %8s %6s %6s  %s" % ("area", "top", "height", "rows", "fits?", ""))
for i, (t, r) in enumerate(areas):
    nxt = areas[i+1][1]['y'] if i + 1 < len(areas) else bottom
    h = nxt - r['y']
    n = len([x for x in rows if r['y'] <= x['y'] < nxt])
    print("  %-10s %8.0f %8.0f %6d %6s" % (t, r['y'], h, n, "yes" if h <= usable else "*** NO — WALL ***"))
PY
  exit 0
fi

# ============================================================== wall / empty
# `wall`  — the field shape: the path crosses Eta's oversized section.
# `empty` — the control: the path crosses EMPTY areas only.
if [ "$CMD" = "wall" ] || [ "$CMD" = "empty" ]; then
  load_session
  if [ "$CMD" = "wall" ]; then SUBJ="${SUBJ:-Zeta}"; ANCHOR="${ANCHOR:-Gamma}"; LABEL="crosses Eta (the oversized section)";
  else SUBJ="${SUBJ:-Zeta}"; ANCHOR="${ANCHOR:-Mu}"; LABEL="crosses EMPTY/small sections only (the certified geometry)"; fi
  note "=== $CMD — move \"$SUBJ\" --before \"$ANCHOR\" ($LABEL) ==="
  warm
  W="${WIN_W:-935}"; H="${WIN_H:-420}"
  setwin "$W" "$H" >/dev/null; sleep 2
  note "  window ${W}x${H}"
  BEFORE_ORDER=$(area_order); BEFORE_VEC=$(area_vector); BEFORE_DIG=$(assign_digest); BEFORE_N=$(areacount)
  note "  before: $BEFORE_ORDER"
  note "  vector: $BEFORE_VEC"
  bs reset >/dev/null; bmark "$CMD drive"
  mon_mark
  T0=$(date +%s)
  G area reorder "$SUBJ" --before "$ANCHOR" --dangerously-drive-gui --json > "$OUT/$CMD.json" 2>&1
  T1=$(date +%s)
  note "  wall clock: $((T1-T0))s"
  head -c 2600 "$OUT/$CMD.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  mon_verdict "the $CMD drive"
  bs assert --allow 99 --name "axdrag5-$CMD" | sed 's/^/    /' | tee -a "$REPORT"
  AFTER_ORDER=$(area_order); AFTER_VEC=$(area_vector); AFTER_DIG=$(assign_digest); AFTER_N=$(areacount)
  note "  after:  $AFTER_ORDER"
  note "  vector: $AFTER_VEC"
  note "  ORDER CHANGED?      $([ "$BEFORE_ORDER" = "$AFTER_ORDER" ] && echo 'no' || echo '*** YES — the sidebar moved ***')"
  note "  area count invariant: $([ "$BEFORE_N" = "$AFTER_N" ] && echo PASS || echo "FAIL ($BEFORE_N -> $AFTER_N)")"
  note "  assignments invariant: $([ "$BEFORE_DIG" = "$AFTER_DIG" ] && echo PASS || echo "FAIL ($BEFORE_DIG -> $AFTER_DIG)")"
  note "  requested placement reached? $(gq "SELECT CASE WHEN (SELECT COUNT(*) FROM TMArea x, TMArea y WHERE x.title='$SUBJ' AND y.title='$ANCHOR' AND (SELECT COUNT(*) FROM TMArea z WHERE (z.\"index\",z.uuid) > (x.\"index\",x.uuid) AND (z.\"index\",z.uuid) < (y.\"index\",y.uuid))=0 AND (x.\"index\",x.uuid) < (y.\"index\",y.uuid)) > 0 THEN 'YES' ELSE 'no' END")"
  exit 0
fi

# ============================================================== chord
# THE BIG CELL. Does a SIDEBAR row honor the ⌘-arrow reorder chords?
# Selection: the sidebar table's row `select` action (the UIC5 route), addressed
# by the row ordinal the SHIPPED snapshot reports for the area's title.
# Delivery: CGEventPostToPid with Finder frontmost (the CHORD2 background gate).
if [ "$CMD" = "chord" ] || [ "$CMD" = "cproj" ]; then
  load_session
  SA="${SIDEBAR_SA:-2}"        # sidebar scroll-area index (census prints the map)
  if [ "$CMD" = "chord" ]; then TARGET="${CHORD_TARGET:-Kappa}"; KIND="AREA"; else TARGET="${CHORD_TARGET:-Eta-P01}"; KIND="PROJECT"; fi
  note "=== $CMD — ⌘-arrow chords on a SIDEBAR $KIND row (\"$TARGET\"), scroll area $SA ==="
  warm
  setwin 935 684 >/dev/null; sleep 2

  # 1. locate the row ordinal from the SHIPPED snapshot (table order == AX order)
  snapjson > "$OUT/chord-snap.json"
  ORD=$(python3 - "$OUT/chord-snap.json" "$TARGET" <<'PY'
import json, sys
snap = json.load(open(sys.argv[1])); want = sys.argv[2]
for i, r in enumerate(snap['rows']):
    segs = (r.get('text') or '').split('|')
    if want in segs or (want + '.') in segs:
        print(i + 1); break
else:
    print(0)
PY
)
  note "  row ordinal (1-based) for \"$TARGET\": $ORD"
  [ "$ORD" = "0" ] && { note "  *** row not found in the sidebar snapshot — cell aborted ***"; exit 1; }

  tofinder
  note "  frontmost before anything: [$(front)]"
  bs reset >/dev/null; bmark "$CMD select"
  mon_mark
  SEL=$(axq "tell application \"System Events\" to tell process \"Things3\"
  set t to table 1 of scroll area $SA of (first window whose subrole is \"AXStandardWindow\")
  select (row $ORD of t)
  delay 0.5
  return \"selected=\" & ((selected of (row $ORD of t)) as text)
end tell")
  note "  selection: $SEL"
  note "  frontmost after the SELECT: [$(front)]"
  mon_verdict "the SELECTION half"

  for ARM in "up-one $KUP $FCMD ⌘↑" "down-one $KDOWN $FCMD ⌘↓" "to-top $KUP $FCMDOPT ⌘⌥↑" "to-bottom $KDOWN $FCMDOPT ⌘⌥↓"; do
    set -- $ARM
    NAME="$1"; CODE="$2"; FLAGS="$3"; GLYPH="$4"
    BEFORE_VEC=$(area_vector); BEFORE_ORDER=$(area_order)
    BEFORE_PROJ=$(gq 'SELECT COALESCE(group_concat(t," < "),"(none)") FROM (SELECT title AS t FROM TMTask WHERE type=1 AND trashed=0 AND area IS NOT NULL ORDER BY area, "index")')
    bmark "$CMD $NAME"
    mon_mark
    POST=$(lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/keypid.js $CODE $FLAGS 1" </dev/null 2>&1)
    sleep 3
    note "  --- $GLYPH ($NAME): $POST"
    note "      frontmost after the CHORD: [$(front)]"
    AFTER_VEC=$(area_vector); AFTER_ORDER=$(area_order)
    AFTER_PROJ=$(gq 'SELECT COALESCE(group_concat(t," < "),"(none)") FROM (SELECT title AS t FROM TMTask WHERE type=1 AND trashed=0 AND area IS NOT NULL ORDER BY area, "index")')
    if [ "$BEFORE_VEC" = "$AFTER_VEC" ]; then note "      TMArea index vector: UNCHANGED"; else
      note "      *** TMArea index vector CHANGED ***"
      note "        before: $BEFORE_VEC"
      note "        after:  $AFTER_VEC"
      note "        order:  $AFTER_ORDER"
    fi
    if [ "$BEFORE_PROJ" = "$AFTER_PROJ" ]; then note "      project order in areas: UNCHANGED"; else
      note "      *** project order in areas CHANGED ***"
      note "        before: $BEFORE_PROJ"
      note "        after:  $AFTER_PROJ"
    fi
    mon_verdict "the $GLYPH chord"
  done
  bs assert --allow 99 --name "axdrag5-$CMD" | sed 's/^/    /' | tee -a "$REPORT"
  note "  final area order: $(area_order)"
  exit 0
fi

# ============================================================== chordclick
# The stronger arm: give the SIDEBAR pane real keyboard focus with an HID click
# on the row (the AX `select` action navigates to the area, which may hand focus
# to the content list — a confound the first arm could not rule out), then
# deliver the chords BOTH ways: CGEventPostToPid (backgrounded) and a frontmost
# System Events keystroke. Oracle: the TMArea index vector + the decline beep.
if [ "$CMD" = "chordclick" ]; then
  load_session
  TARGET="${CHORD_TARGET:-Iota}"
  note "=== chordclick — HID-click the sidebar row \"$TARGET\", then chord it ==="
  warm
  setwin 935 684 >/dev/null; sleep 2
  lab_ssh "$IP" 'cat > ~/labh/click.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function run(argv){
  var x=+argv[0], y=+argv[1];
  function post(t){ var e=$.CGEventCreateMouseEvent($(), t, $.CGPointMake(x,y), 0); $.CGEventSetFlags(e,0); $.CGEventPost($.kCGHIDEventTap, e) }
  post(5); sleepMs(300); post(1); sleepMs(140); post(2); sleepMs(200);
  return 'CLICKED '+x+','+y }
EOF
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "  frontmost: [$(front)]"
  snapjson > "$OUT/click-snap.json"
  PT=$(python3 - "$OUT/click-snap.json" "$TARGET" <<'PY'
import json, sys
snap = json.load(open(sys.argv[1])); want = sys.argv[2]
vp = snap['viewport']
for r in snap['rows']:
    segs = (r.get('text') or '').split('|')
    if want in segs or (want + '.') in segs:
        x = r['x'] + r['w'] * 0.7; y = r['y'] + r['h'] / 2
        inband = vp['y'] + 6 <= y <= vp['y'] + vp['h'] - 6
        print("%d %d %s" % (round(x), round(y), "IN" if inband else "OFF"))
        break
else:
    print("0 0 MISSING")
PY
)
  set -- $PT; CX="$1"; CY="$2"; BAND="$3"
  note "  row point: ($CX,$CY) $BAND"
  [ "$BAND" = "IN" ] || { note "  *** row not inside the visible band — cell aborted ***"; exit 1; }
  note "  click: $(lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/click.js $CX $CY" </dev/null 2>&1)"
  sleep 2
  note "  window title now: $(axq 'tell application "System Events" to tell process "Things3" to return name of (first window whose subrole is "AXStandardWindow")')"
  note "  focused element: $(axq 'tell application "System Events" to tell process "Things3" to return (role of (value of attribute "AXFocusedUIElement")) & " / " & ((description of (value of attribute "AXFocusedUIElement")) as text)')"

  for ARM in "up-one $KUP $FCMD ⌘↑" "down-one $KDOWN $FCMD ⌘↓" "to-top $KUP $FCMDOPT ⌘⌥↑" "to-bottom $KDOWN $FCMDOPT ⌘⌥↓"; do
    set -- $ARM; NAME="$1"; CODE="$2"; FLAGS="$3"; GLYPH="$4"
    BEFORE_VEC=$(area_vector)
    bs reset >/dev/null; bmark "chordclick $NAME"
    lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/keypid.js $CODE $FLAGS 1" </dev/null >/dev/null 2>&1
    sleep 3
    AFTER_VEC=$(area_vector)
    BEEPS=$(bs assert --allow 99 --name "cc-$NAME" | grep -o '[0-9]* alert beep' | head -1)
    if [ "$BEFORE_VEC" = "$AFTER_VEC" ]; then
      note "  $GLYPH (PostToPid): NO index delta — $BEEPS (a decline)"
    else
      note "  *** $GLYPH (PostToPid): INDEX VECTOR MOVED ***"
      note "      before: $BEFORE_VEC"
      note "      after:  $AFTER_VEC"
      note "      order:  $(area_order)"
    fi
  done

  # frontmost System Events keystroke — the other delivery route
  for ARM in "⌘↑ up arrow command down" "⌘↓ down arrow command down"; do
    set -- $ARM; GLYPH="$1"; KEYNAME="$2 $3"; MODS="$4 $5"
    BEFORE_VEC=$(area_vector)
    bs reset >/dev/null; bmark "chordclick se $GLYPH"
    axq "tell application \"System Events\" to key code $([ "$GLYPH" = "⌘↑" ] && echo 126 || echo 125) using {command down}" >/dev/null
    sleep 3
    AFTER_VEC=$(area_vector)
    BEEPS=$(bs assert --allow 99 --name "cc-se" | grep -o '[0-9]* alert beep' | head -1)
    if [ "$BEFORE_VEC" = "$AFTER_VEC" ]; then
      note "  $GLYPH (System Events, frontmost): NO index delta — $BEEPS (a decline)"
    else
      note "  *** $GLYPH (System Events, frontmost): INDEX VECTOR MOVED ***"
      note "      after:  $AFTER_VEC / $(area_order)"
    fi
  done
  note "  final area order: $(area_order)"
  exit 0
fi

# ============================================================== teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true; sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  note "=== teardown: $VM destroyed ==="
  exit 0
fi

cat >&2 <<USAGE
usage: TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-axdrag5.sh <cmd>
  setup     clone golden-v4 + airgap + clock pin + helpers + shipped bundle
  seed      the field-shaped sidebar (12 areas; Eta oversized; Theta/Iota/Kappa empty)
  census    rendered-row census, section heights vs viewport, snapshot cost
  wall      SHIPPED CLI move whose path crosses the oversized section
  empty     the control move across empty areas only
  chord     ⌘-arrow chords on a sidebar AREA row (CHORD2 §11's open cell)
  cproj     ⌘-arrow chords on a sidebar PROJECT row
  reship    rebuild + redeploy dist (re-run wall against the fixed driver)
  teardown  destroy the clone
USAGE
exit 2
