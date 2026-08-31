#!/bin/bash
# SBRES1 — "the sidebar did not resolve": why the shipped `area reorder` drive
# refuses on a host whose sidebar is plainly open (issues #665, #651).
#
# BACKGROUND. Two field reports, two CLI versions (0.19.4-dev and 0.20.1), one
# machine, one message: the drive completes its `activate` step and then dies at
# ~30–33s with
#
#     the sidebar did not resolve (is the window open and the sidebar visible?)
#
# `takeSnapshot()` conflates FOUR different failures into that one sentence — the
# osascript hop failed, the hop TIMED OUT, the locator matched nothing, or it
# matched a table with no rows. The 33.5s wall clock in #651 is one
# `STEP_TIMEOUT_MS = 30_000` kill plus the activate step, so the field failure is
# a TIMEOUT wearing a locator's error message.
#
# HYPOTHESES:
#   H1  the LOCATOR is geometry-keyed. `sidebarTable()` takes every AXTable under
#       the window and picks the narrowest with `w < 400`; the viewport is the
#       first AXScrollArea with `w < 400`. A host whose sidebar split is dragged
#       past 400pt (or whose tree differs) never matches.
#   H2  the COST cliff. AXDRAG5 measured ~3.4s per shipped snapshot on an 80-row
#       sidebar; a bigger sidebar on a slower host crosses 30s.
#   H3  a host-specific AX exposure difference (3.23.1 / macOS 15.7.4).
#   H4  *** the one the lab has been HIDING ***: `findAll(w,'AXTable',12,[])`
#       enumerates the WHOLE window subtree — including the CONTENT list — so the
#       locator's cost scales with the view the user happens to have open, not
#       with the sidebar. And every lab driver's `warm()` sets
#       AXEnhancedUserInterface = false, which is exactly the switch that makes
#       AppKit build the expensive tree. The lab has been measuring the cheap
#       path; the field runs the expensive one.
#
# CELLS:
#   anatomy   the full AX tree above the sidebar table at several geometries
#             (default, laptop-small, large, narrow split, wide split) plus the
#             View-menu census for a hide-sidebar command. Does the shipped
#             locator resolve at every one?
#   cost      the decomposition: shipped locator vs shipped row walk vs a PRUNED
#             locator, across {small content view, huge content view} ×
#             {AXEnhancedUserInterface off, on}. Node-visit counts alongside the
#             wall clock, so the answer is mechanical, not just a stopwatch.
#   msgmatrix what the SHIPPED CLI actually says for each distinct real cause.
#   e2e       a shipped `area reorder` end to end (the control move).
#   upgrade   install Things 3.23.1 INTO THE CLONE from the banked installer and
#             re-run anatomy/cost/e2e — the closest replica of the failing host.
#   reship    rebuild + redeploy dist (re-run cells against the fixed driver).
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05, never rolled (trial wall
# 2026-07-18). Fixtures fully synthetic. Clone destroyed at teardown.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-sbres1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)
INSTALLER="${INSTALLER:-/Volumes/Workspace/things-releases/Things3-3.23.1-32301002.zip}"
note() { echo "[sbres1] $*" | tee -a "$REPORT"; }

# Every cell re-pushes the probe, so a cell can never run against a stale copy
# (a stale probe answers "unknown verb" and the cell silently records nothing).
load_session() {
  [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }
  source "$SESSION"
  sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O lab/scripts/sbres1-probe.jxa.js "admin@$IP:/Users/admin/labh/sbres1.js" >/dev/null
}

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
show() { lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 3" </dev/null; }
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }

# the SBRES1 probe (verbs: tree / locate / cost / enhanced / split / menu)
P() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/sbres1.js $*" </dev/null 2>&1; }
# the SHIPPED snapshot script, verbatim
snapjson() { lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/sidebar-snap.js' </dev/null 2>/dev/null; }
snaptime() { lab_ssh "$IP" 'S=$( { /usr/bin/time -p /usr/bin/osascript -l JavaScript ~/labh/sidebar-snap.js >/tmp/snap.json ; } 2>&1 ); echo "$S" | tr "\n" " "; echo "bytes=$(wc -c < /tmp/snap.json)"' </dev/null 2>&1; }

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; true' </dev/null; }
# NOTE: deliberately NOT clearing AXEnhancedUserInterface here — this campaign
# treats that flag as an INDEPENDENT VARIABLE (H4), so no cell may silently
# normalize it. Cells set it explicitly with `P enhanced 0|1`.

setwin() { lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set size of (first window whose subrole is \"AXStandardWindow\") to {$1, $2}'" </dev/null 2>&1; }

area_order()  { gq 'SELECT COALESCE(group_concat(t," < "),"(none)") FROM (SELECT title AS t FROM TMArea ORDER BY "index", uuid)'; }
areacount()   { gq 'SELECT COUNT(*) FROM TMArea'; }
assign_digest() { gq "SELECT uuid||':'||COALESCE(area,'') FROM TMTask WHERE trashed=0 ORDER BY uuid" | shasum | cut -c1-12; }

# Render the SHIPPED snapshot script for the guest's own areas. Before 0.20.2
# the script took no arguments; the locator is semantic now, so the caller's
# area titles are baked into it exactly as the driver bakes them (SBRES1).
build_snap() {
  local titles
  titles=$(gq 'SELECT COALESCE(group_concat(title, "|"), "") FROM (SELECT title FROM TMArea ORDER BY "index", uuid)' 2>/dev/null)
  TITLES_CSV="$titles" node -e "
    const t = (process.env.TITLES_CSV || '').split('|').filter(Boolean);
    import('./dist/write/vectors/ui-drag.js').then(m => process.stdout.write(m.jxaSidebarSnapshotScript(t)));
  " > "$OUT/sidebar-snap.js"
}

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }

# ============================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "=== SBRES1 setup — $(date) ==="
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
  printf '%s\n' "$GSQL" | lab_ssh "$IP" 'cat > ~/labh/gsql.sh; chmod +x ~/labh/gsql.sh'
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null 2>&1
  lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null
  scpO lab/scripts/sbres1-probe.jxa.js "admin@$IP:/Users/admin/labh/sbres1.js" >/dev/null

  # the SHIPPED sidebar snapshot script (the exact one the driver runs). Built
  # with the guest's own area titles once they exist — the locator is SEMANTIC
  # now, so the titles are part of the script (SBRES1).
  build_snap
  lab_ssh "$IP" 'cat > ~/labh/sidebar-snap.js' < "$OUT/sidebar-snap.js"

  warm
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

  echo "IP=$IP" > "$SESSION"
  note "=== setup done ==="
  exit 0
fi

# ============================================================== reship
if [ "$CMD" = "reship" ]; then
  load_session
  npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  build_snap
  lab_ssh "$IP" 'cat > ~/labh/sidebar-snap.js' < "$OUT/sidebar-snap.js"
  scpO lab/scripts/sbres1-probe.jxa.js "admin@$IP:/Users/admin/labh/sbres1.js" >/dev/null
  note "reshipped dist ($(date))"
  exit 0
fi

# ============================================================== seed
# A field-shaped sidebar (areas + their project rows) AND a field-shaped CONTENT
# list — the second is the variable no prior campaign varied.
if [ "$CMD" = "seed" ]; then
  load_session
  note "=== seed — a field-shaped sidebar AND a field-shaped content list ==="
  AREAS="Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu"
  for A in $AREAS; do
    lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to make new area with properties {name:\"$A\"}'" </dev/null >/dev/null 2>&1
    sleep 1
  done
  note "areas seeded: $(areacount)"
  seed_projects() { # <area> <count>
    local a="$1" n="$2" i
    for i in $(seq -w 1 "$n"); do
      lab_ssh "$IP" "open -g 'things:///add-project?title=$a-P$i&area=$a'" </dev/null >/dev/null 2>&1
      sleep 0.7
    done
  }
  seed_projects Alpha 4
  seed_projects Beta 3
  seed_projects Gamma 5
  seed_projects Delta 3
  seed_projects Epsilon 4
  seed_projects Zeta 4
  seed_projects Eta 4
  seed_projects Theta 3
  seed_projects Iota 3
  seed_projects Kappa 2
  seed_projects Lambda 3
  seed_projects Mu 2
  sleep 3
  note "sidebar project census:"
  gt 'SELECT a.title AS area, COUNT(t.uuid) AS projects FROM TMArea a LEFT JOIN TMTask t ON t.area=a.uuid AND t.type=1 AND t.trashed=0 AND t.status=0 GROUP BY a.uuid ORDER BY a."index", a.uuid' | tee -a "$REPORT"

  # THE CONTENT LIST — one project holding N to-dos, built in ONE AppleScript
  # call (a URL per to-do would take minutes). Fully synthetic titles.
  N="${BIGLIST:-400}"
  note "seeding a $N-item content list (BIGLIST)…"
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\"
  set p to make new project with properties {name:\"BIGLIST\"}
  repeat with i from 1 to $N
    make new to do with properties {name:(\"SBRES1-item-\" & i)} at end of p
  end repeat
end tell'" </dev/null >/dev/null 2>&1
  sleep 5
  note "BIGLIST items: $(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'SBRES1-item-%' AND trashed=0")"
  note "area order: $(area_order)"
  exit 0
fi

# ============================================================== anatomy
# CELL 1 — the locator's anatomy: what sits above the sidebar table, and does the
# shipped locator still resolve when the geometry moves?
if [ "$CMD" = "anatomy" ]; then
  load_session
  TAG="${TAG:-}"
  note "=== anatomy${TAG:+ ($TAG)} — the AX tree above the sidebar table ==="
  warm
  note "  AXEnhancedUserInterface -> off (the lab's historical default)"
  P enhanced 0 | tee -a "$REPORT"

  note "--- View menu census (is there a hide-sidebar command?) ---"
  P menu View 2>&1 | tee -a "$REPORT"

  for GEOM in "935 420" "1024 640" "1440 900"; do
    set -- $GEOM
    note "--- window ${1}x${2} ---"
    setwin "$1" "$2" >/dev/null; sleep 2
    P tree 6 > "$OUT/ax/tree-${TAG:+$TAG-}${1}x${2}.txt" 2>&1
    head -50 "$OUT/ax/tree-${TAG:+$TAG-}${1}x${2}.txt" | tee -a "$REPORT"
    note "  shipped locator: $(P locate)"
  done

  note "--- sidebar RESIZE HANDLE dragged NARROWER, then WIDER ---"
  setwin 1440 900 >/dev/null; sleep 2
  for D in -60 60 120 240; do
    note "  handle drag ${D}px: $(P split $D)"
    sleep 1
    note "    shipped locator: $(P locate)"
  done
  P tree 6 > "$OUT/ax/tree-${TAG:+$TAG-}widesplit.txt" 2>&1
  head -30 "$OUT/ax/tree-${TAG:+$TAG-}widesplit.txt" | tee -a "$REPORT"
  note "  shipped snapshot at the WIDEST split:"
  snapjson | head -c 300 | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "  handle drag back: $(P split -360)"

  note "--- sidebar HIDDEN (Things' own View ▸ Hide Sidebar) ---"
  note "  $(P sidebar hide)"
  sleep 1
  note "    shipped locator: $(P locate)"
  P tree 6 > "$OUT/ax/tree-${TAG:+$TAG-}hidden.txt" 2>&1
  head -30 "$OUT/ax/tree-${TAG:+$TAG-}hidden.txt" | tee -a "$REPORT"
  note "  shipped snapshot with the sidebar hidden:"
  snapjson | head -c 300 | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "  the SHIPPED CLI against a hidden sidebar:"
  T0=$(date +%s)
  G area reorder Zeta --first --dangerously-drive-gui --json > "$OUT/anatomy-hidden.json" 2>&1
  T1=$(date +%s)
  note "  wall clock: $((T1-T0))s"
  head -c 1200 "$OUT/anatomy-hidden.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"

  note "  restoring the sidebar: $(P sidebar show)"
  note "    shipped locator: $(P locate)"
  exit 0
fi

# ============================================================== matrix
# CELL 1b — the EXPANSIVE sidebar-state matrix: every lever a user can pull that
# changes what the driver has to find, and the constraint each one imposes.
if [ "$CMD" = "matrix" ]; then
  load_session
  TAG="${TAG:-}"
  note "=== matrix${TAG:+ ($TAG)} — sidebar-state levers and their constraints ==="
  warm
  setwin 1024 640 >/dev/null; sleep 2

  note "--- (A) baseline: sidebar visible ---"
  note "  $(P state)"

  note "--- (B) Things' own View menu (the hide/show lever) ---"
  P menu View | tee -a "$REPORT"
  note "  hide:  $(P sidebar hide)"; sleep 1
  note "  state: $(P state)"
  note "  the SHIPPED CLI with the sidebar hidden (subject NOT already placed):"
  T0=$(date +%s)
  G area reorder Mu --first --dangerously-drive-gui --json > "$OUT/matrix-hidden.json" 2>&1
  T1=$(date +%s)
  note "  wall clock: $((T1-T0))s"
  head -c 1200 "$OUT/matrix-hidden.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "  area order after: $(area_order)"
  note "  show:  $(P sidebar show)"; sleep 1
  note "  state: $(P state)"

  note "--- (C) sidebar WIDTH sweep (the resize handle) ---"
  for D in -40 -40 -40 -40 -40; do
    note "  drag ${D}: $(P split $D)"
    note "    locator resolves: $(P locate | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("resolves"), "table", d.get("shippedTable"))')"
  done
  note "  (widening)"
  for D in 40 80 120 160 200; do
    note "  drag +${D}: $(P split $D)"
    note "    locator resolves: $(P locate | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("resolves"), "table", d.get("shippedTable"))')"
  done
  note "  the SHIPPED CLI with a >400pt sidebar:"
  T0=$(date +%s)
  G area reorder Delta --first --dangerously-drive-gui --json > "$OUT/matrix-widesidebar.json" 2>&1
  T1=$(date +%s)
  note "  wall clock: $((T1-T0))s"
  head -c 1200 "$OUT/matrix-widesidebar.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "  area order after: $(area_order)"

  note "--- (D) MULTIPLE WINDOWS ---"
  P menu Window | tee -a "$REPORT"
  P menu File | tee -a "$REPORT"
  note "  baseline windows:"
  P windows | tee -a "$REPORT"
  # Things opens a second main window by double-clicking a sidebar row; the
  # documented keyboard route is the Window menu's own "New Window" if present.
  KAPPAID=$(gq "SELECT uuid FROM TMArea WHERE title='Kappa' LIMIT 1")
  lab_ssh "$IP" "open -g 'things:///show?id=$KAPPAID&reveal=1'" </dev/null >/dev/null 2>&1
  sleep 2
  note "  after a second window attempt:"
  P windows | tee -a "$REPORT"

  note "--- (E) window SIZE floor ---"
  for S in "600 400" "500 300" "400 240" "300 200"; do
    set -- $S
    note "  setwin ${1}x${2}: $(setwin "$1" "$2")"
    sleep 1
    note "    $(P state | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("window", d.get("windowFrame"), "lists", [(l["frame"], l["rows"]) for l in d.get("lists",[])], "shippedResolves", d.get("shippedResolves"))')"
  done
  setwin 1024 640 >/dev/null; sleep 2

  note "--- (F) FULL SCREEN ---"
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to keystroke "f" using {command down, control down}'\''' </dev/null >/dev/null 2>&1
  sleep 6
  note "  $(P state)"
  P windows | tee -a "$REPORT"
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to keystroke "f" using {command down, control down}'\''' </dev/null >/dev/null 2>&1
  sleep 6
  note "  back from full screen: $(P state)"
  exit 0
fi

# ============================================================== cost
# CELL 3 — the cliff, decomposed. Wall clock AND node-visit counts for the
# shipped locator, the shipped row walk, and a pruned locator, across the two
# variables no prior campaign varied: the CONTENT view, and
# AXEnhancedUserInterface.
if [ "$CMD" = "cost" ]; then
  load_session
  TAG="${TAG:-}"
  note "=== cost${TAG:+ ($TAG)} — where the 30s step budget goes ==="
  warm
  setwin "${WIN_W:-1024}" "${WIN_H:-640}" >/dev/null; sleep 2
  BIGID=$(gq "SELECT uuid FROM TMTask WHERE title='BIGLIST' AND type=1 LIMIT 1")
  KAPPAID=$(gq "SELECT uuid FROM TMArea WHERE title='Kappa' LIMIT 1")

  for EUI in 0 1; do
    for VIEW in small big anytime; do
      case "$VIEW" in
        small) show "things:///show?id=$KAPPAID"; DESC="a small area view (Kappa)";;
        big)   show "things:///show?id=$BIGID";   DESC="the BIGLIST project";;
        anytime) show "things:///show?id=anytime"; DESC="Anytime (everything)";;
      esac
      P enhanced "$EUI" >/dev/null
      sleep 2
      note "--- AXEnhancedUserInterface=$EUI · content = $DESC ---"
      note "  decomposition: $(P cost)"
      note "  shipped snapshot wall clock: $(snaptime)"
    done
  done
  P enhanced 0 >/dev/null
  exit 0
fi

# ============================================================== msgmatrix
# CELL 4 — message truthfulness. What does the SHIPPED CLI say for each distinct
# real cause? (sidebar hidden / window closed / walk timeout / healthy control)
if [ "$CMD" = "msgmatrix" ]; then
  load_session
  note "=== msgmatrix — what the CLI says for each real cause ==="
  warm
  setwin 1024 640 >/dev/null; sleep 2

  run_case() { # <label> <slug>
    note "--- CAUSE: $1 ---"
    T0=$(date +%s)
    G area reorder Zeta --first --dangerously-drive-gui --json > "$OUT/msg-$2.json" 2>&1
    T1=$(date +%s)
    note "  wall clock: $((T1-T0))s"
    head -c 1400 "$OUT/msg-$2.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  }

  note "(a) sidebar HIDDEN (View ▸ Hide Sidebar)"
  P sidebar hide >/dev/null; sleep 2
  run_case "the sidebar is not visible" hidden
  P sidebar show >/dev/null; sleep 2

  note "(b) the main WINDOW is closed (⌘W)"
  axq 'tell application "System Events" to tell process "Things3" to keystroke "w" using command down' >/dev/null; sleep 3
  run_case "no Things window is open" nowindow
  lab_ssh "$IP" 'open -a Things3; sleep 8' </dev/null >/dev/null

  note "(c) the walk TIMES OUT (a huge content view + AXEnhancedUserInterface on)"
  BIGID=$(gq "SELECT uuid FROM TMTask WHERE title='BIGLIST' AND type=1 LIMIT 1")
  show "things:///show?id=$BIGID"
  P enhanced 1 >/dev/null; sleep 2
  run_case "the snapshot exceeds the 30s step budget" timeout
  P enhanced 0 >/dev/null

  note "(d) the control — everything healthy"
  KAPPAID=$(gq "SELECT uuid FROM TMArea WHERE title='Kappa' LIMIT 1")
  show "things:///show?id=$KAPPAID"
  run_case "healthy" ok
  exit 0
fi

# ============================================================== e2e
if [ "$CMD" = "e2e" ]; then
  load_session
  TAG="${TAG:-}"
  SUBJ="${SUBJ:-Kappa}"; ANCHOR="${ANCHOR:-Delta}"
  note "=== e2e${TAG:+ ($TAG)} — shipped \`area reorder $SUBJ --before $ANCHOR\` ==="
  warm
  setwin "${WIN_W:-1024}" "${WIN_H:-640}" >/dev/null; sleep 2
  KAPPAID=$(gq "SELECT uuid FROM TMArea WHERE title='Kappa' LIMIT 1")
  show "things:///show?id=$KAPPAID"
  BEFORE_ORDER=$(area_order); BEFORE_DIG=$(assign_digest); BEFORE_N=$(areacount)
  note "  before: $BEFORE_ORDER"
  T0=$(date +%s)
  G area reorder "$SUBJ" --before "$ANCHOR" --dangerously-drive-gui --json > "$OUT/e2e${TAG:+-$TAG}.json" 2>&1
  T1=$(date +%s)
  note "  wall clock: $((T1-T0))s"
  head -c 1600 "$OUT/e2e${TAG:+-$TAG}.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  AFTER_ORDER=$(area_order); AFTER_DIG=$(assign_digest); AFTER_N=$(areacount)
  note "  after:  $AFTER_ORDER"
  note "  area count invariant:  $([ "$BEFORE_N" = "$AFTER_N" ] && echo PASS || echo "FAIL ($BEFORE_N -> $AFTER_N)")"
  note "  assignments invariant: $([ "$BEFORE_DIG" = "$AFTER_DIG" ] && echo PASS || echo "FAIL")"
  note "  requested placement reached? $(gq "SELECT CASE WHEN (SELECT COUNT(*) FROM TMArea x, TMArea y WHERE x.title='$SUBJ' AND y.title='$ANCHOR' AND (SELECT COUNT(*) FROM TMArea z WHERE (z.\"index\",z.uuid) > (x.\"index\",x.uuid) AND (z.\"index\",z.uuid) < (y.\"index\",y.uuid))=0 AND (x.\"index\",x.uuid) < (y.\"index\",y.uuid)) > 0 THEN 'YES' ELSE 'no' END")"
  exit 0
fi

# ============================================================== certify
# The acceptance gate for the fix: every state the matrix found, driven end to
# end through the SHIPPED CLI, with the database asserted before and after.
if [ "$CMD" = "certify" ]; then
  load_session
  TAG="${TAG:-}"
  note "=== certify${TAG:+ ($TAG)} — the fixed driver against every measured state ==="
  warm
  setwin 1024 640 >/dev/null; sleep 2
  KAPPAID=$(gq "SELECT uuid FROM TMArea WHERE title='Kappa' LIMIT 1")
  show "things:///show?id=$KAPPAID"

  cert() { # <label> <slug> <subject> <placement…>
    local label="$1" slug="$2" subj="$3"; shift 3
    note "--- $label: area reorder $subj $* ---"
    local before after t0 t1
    before=$(area_order); BEFORE_DIG=$(assign_digest); BEFORE_N=$(areacount)
    note "  before: $before"
    t0=$(date +%s)
    G area reorder "$subj" "$@" --dangerously-drive-gui --json > "$OUT/cert-$slug.json" 2>&1
    t1=$(date +%s)
    note "  wall clock: $((t1-t0))s"
    head -c 900 "$OUT/cert-$slug.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
    after=$(area_order)
    note "  after:  $after"
    note "  area count invariant:  $([ "$BEFORE_N" = "$(areacount)" ] && echo PASS || echo FAIL)"
    note "  assignments invariant: $([ "$BEFORE_DIG" = "$(assign_digest)" ] && echo PASS || echo FAIL)"
  }

  note "### 1. control — an ordinary visible sidebar"
  note "  state: $(P state | head -c 400)"
  cert "control" control Mu --first

  note "### 2. THE FIELD BUG — a sidebar dragged past 400pt"
  note "  widen: $(P split 200)"
  note "  state: $(P state | head -c 400)"
  cert "wide sidebar" wide Delta --first
  note "  restore width: $(P split -200)"

  note "### 3. a HIDDEN sidebar (the normalization rung)"
  note "  $(P sidebar hide)"; sleep 1
  note "  state: $(P state | head -c 400)"
  cert "hidden sidebar" hidden Theta --first
  note "  visibility after the drive (must be hidden again): $(P state | head -c 400)"
  note "  $(P sidebar show)"; sleep 1

  note "### 4. TWO main windows (the AXMain rule)"
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"New Things Window\" of menu 1 of menu bar item \"File\" of menu bar 1'" </dev/null >/dev/null 2>&1
  sleep 4
  P windows | tee -a "$REPORT"
  cert "two windows" twowin Iota --first
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"Close\" of menu 1 of menu bar item \"File\" of menu bar 1'" </dev/null >/dev/null 2>&1
  sleep 3

  note "### 5. FULL SCREEN"
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to keystroke "f" using {command down, control down}'\''' </dev/null >/dev/null 2>&1
  sleep 6
  cert "full screen" fullscreen Lambda --first
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to keystroke "f" using {command down, control down}'\''' </dev/null >/dev/null 2>&1
  sleep 6

  note "### 6. the SBCOL1 collapse rung still works (a tall section in the path)"
  setwin 935 420 >/dev/null; sleep 2
  cert "collapse rung" collapse Beta --first
  exit 0
fi

# ============================================================== upgrade
# CELL 2 — version parity. Install the banked 3.23.1 direct installer INTO THE
# CLONE. The goldens and the host app are NEVER touched.
if [ "$CMD" = "upgrade" ]; then
  load_session
  [ -f "$INSTALLER" ] || { echo "no installer at $INSTALLER" >&2; exit 1; }
  note "=== upgrade — Things 3.23.1 into the clone ==="
  note "  before: $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)"
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit" >/dev/null 2>&1; sleep 3; pkill -x Things3 >/dev/null 2>&1; sleep 2; true' </dev/null
  scpO "$INSTALLER" "admin@$IP:/Users/admin/things331.zip" >/dev/null || exit 1
  lab_ssh "$IP" 'set -e; cd ~; rm -rf ~/things331 && mkdir ~/things331 && cd ~/things331 && ditto -x -k ~/things331.zip . && sudo rm -rf /Applications/Things3.app && sudo ditto ./Things3.app /Applications/Things3.app && sudo xattr -dr com.apple.quarantine /Applications/Things3.app 2>/dev/null; echo INSTALLED' </dev/null | tee -a "$REPORT"
  warm
  note "  after:  $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null | tr '\n' '/')"
  note "  db: $(gq 'SELECT value FROM Meta WHERE key="databaseVersion"')"
  note "  areas intact: $(areacount)  order: $(area_order)"
  exit 0
fi

# ============================================================== teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 2
  tart delete "$VM" >/dev/null 2>&1 || true
  note "=== teardown: $VM destroyed ($(date)) ==="
  tart list | tee -a "$REPORT"
  exit 0
fi

echo "usage: $0 {setup|seed|anatomy|cost|msgmatrix|e2e|upgrade|reship|teardown}" >&2
exit 2
