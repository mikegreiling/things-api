#!/bin/bash
# VOPAT1 — "read like a screen reader": hit-testing, visible sets, and
# notification-driven settles against the sweep-and-poll drivers we ship (#676).
#
# THE INSIGHT (maintainer's, 2026-09-02). Our AX drivers read Things the way a
# web crawler reads a site: they SWEEP — harvesting the content of every row in
# the sidebar to find one — and they POLL, re-reading a surface until two reads
# agree. A screen reader does neither. VoiceOver reads ONE element on demand,
# asks a table for its VISIBLE set rather than its whole contents, is TOLD by an
# AX notification when something changed, and hit-tests a point to find what is
# under it.
#
# THE FIELD LAW (measured on the maintainer's M1, issue #676) is why the
# distinction is worth money:
#   * per AX round-trip IPC          ~0.1 ms  (0.12 JXA / 0.05 native)
#   * per ROW REALIZED on content    ~115 ms  (AXChildren/AXDescription/AXValue),
#                                    paid again on EVERY sweep — nothing caches
#   * geometry (AXRows + AXFrame x174)  ~2 ms  — effectively free
# So the lever is touching content on as few ELEMENTS as possible, and never
# polling a content attribute.
#
# CELLS (each reports AX calls, ELEMENTS REALIZED, and wall time):
#   1 hittest   AXUIElementCopyElementAtPosition at a DB-predicted row centre.
#   2 visset    AXVisibleRows vs AXRows vs sparse (frames for all, content for
#               only the ~12 DB-predicted area rows).
#   3 notify    an AXObserver instead of a poll: which notifications fire for
#               which actuation, and how fast. A class that does NOT fire is a
#               law and is recorded as one.
#   4 sheet     the Repeat sheet, one element at a time: the minimum content
#               reads a recipe step needs against today's 88 round-trips.
#   5 rolecost  does the ~115 ms/row law apply to sheet controls too? Per-role
#               content-read cost, and first-touch vs second-sweep.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and never rolled (trial wall
# 2026-07-18). Fixtures fully synthetic. Clone destroyed on teardown.
#
# REPRODUCIBILITY. The lab is ~20x faster than the field for content reads and
# CANNOT reproduce field wall times. CALL AND ELEMENT COUNTS transfer; wall times
# do not. Every table below therefore leads with counts. The field-probe cells
# added in the same change (lab/scripts/field-probe-sidebar.jxa.js cells 9-11)
# are how the pattern gets measured on the maintainer's own machine.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-vopat1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)
note() { echo "[vopat1] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; true' </dev/null; }
setwin() { lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set size of (first window whose subrole is \"AXStandardWindow\") to {$1, $2}'" </dev/null 2>&1; }
activate() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null >/dev/null 2>&1; }

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'

titles_pipe() { gq 'SELECT group_concat(title, "|") FROM (SELECT title FROM TMArea ORDER BY "index", uuid)'; }

# The one guest entry point for every JXA measurement verb.
M() { # M <verb> [args...]
  local verb="$1"; shift
  lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/vopat1.jxa.js $(printf '%q' "$verb") $(printf '%q' "$TITLES") $(printf '%q ' "$@")" </dev/null 2>&1
}

# The observer rig (ctypes; JXA cannot build a C callback at all).
OBS() { # OBS <targets-json> <timeout-ms> <actuation>
  lab_ssh "$IP" "/usr/bin/python3 ~/labh/vopat1-observer.py $(printf '%q' "$PID") $(printf '%q' "$1") $(printf '%q' "$2") $(printf '%q' "$3")" </dev/null 2>&1
}

# The shipped snapshot script, regenerated with the CURRENT area titles — the
# BASELINE every cell is measured against.
ship_snap() {
  TITLES="$(titles_pipe)"
  node -e "
    const t = process.argv[1].split('|').filter(Boolean);
    import('./dist/write/vectors/ui-drag.js').then(m => process.stdout.write(m.jxaSidebarSnapshotScript(t)));
  " "$TITLES" > "$OUT/sidebar-snap.jxa.js"
  lab_ssh "$IP" 'cat > ~/labh/sidebar-snap.jxa.js' < "$OUT/sidebar-snap.jxa.js"
}
snapjson() { lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/sidebar-snap.jxa.js' </dev/null 2>/dev/null; }

# The row ORDINALS the database predicts for the area rows, and the table row
# count they are indexed into. Computed from the snapshot's own row list so the
# prediction is testable without first building the arithmetic predictor: what
# the sparse strategy needs is "the ordinal of each area row", and the point of
# the cell is what one costs to CONFIRM, not how it was derived.
predict_ordinals() { # -> comma-separated ordinals, one per area title, in table order
  snapjson > "$OUT/snap-predict.json"
  python3 - "$OUT/snap-predict.json" "$TITLES" <<'PY'
import json, sys
snap = json.load(open(sys.argv[1]))
titles = [t for t in sys.argv[2].split('|') if t]
rows = snap.get('rows', [])
out = []
for i, r in enumerate(rows):
    segs = (r.get('text') or '').split('|')
    for t in titles:
        if t in segs or (t + '.') in segs:
            out.append(str(i))
            break
print(','.join(out))
PY
}
ordinal_of() { # ordinal_of <title>
  snapjson > "$OUT/snap-one.json"
  python3 - "$OUT/snap-one.json" "$1" <<'PY'
import json, sys
snap = json.load(open(sys.argv[1]))
want = sys.argv[2]
for i, r in enumerate(snap.get('rows', [])):
    segs = (r.get('text') or '').split('|')
    if want in segs or (want + '.') in segs:
        print(i); break
else:
    print(-1)
PY
}

# The first area row whose centre is INSIDE the viewport band, as
# "<ordinal> <title>". A hit-test can only ask about a pixel that is drawn, so
# the in-band case and the off-band case are different cells, not one.
visible_area() {
  snapjson > "$OUT/snap-vis.json"
  python3 - "$OUT/snap-vis.json" "$TITLES" <<'PY'
import json, sys
snap = json.load(open(sys.argv[1]))
titles = [t for t in sys.argv[2].split('|') if t]
vp = snap.get('viewport') or {}
for i, r in enumerate(snap.get('rows', [])):
    segs = (r.get('text') or '').split('|')
    hit = next((t for t in titles if t in segs or (t + '.') in segs), None)
    if hit is None or r.get('y') is None:
        continue
    cy = r['y'] + r['h'] / 2
    if vp.get('y') is not None and vp['y'] + 8 < cy < vp['y'] + vp['h'] - 8:
        print("%d %s" % (i, hit))
        break
else:
    print("-1 ")
PY
}

# The first area row whose centre is OUTSIDE the band -- the honest limit.
offscreen_area() {
  snapjson > "$OUT/snap-off.json"
  python3 - "$OUT/snap-off.json" "$TITLES" <<'PY'
import json, sys
snap = json.load(open(sys.argv[1]))
titles = [t for t in sys.argv[2].split('|') if t]
vp = snap.get('viewport') or {}
for i, r in enumerate(snap.get('rows', [])):
    segs = (r.get('text') or '').split('|')
    hit = next((t for t in titles if t in segs or (t + '.') in segs), None)
    if hit is None or r.get('y') is None:
        continue
    cy = r['y'] + r['h'] / 2
    if not (vp.get('y') is not None and vp['y'] < cy < vp['y'] + vp['h']):
        print("%d %s" % (i, hit))
        break
else:
    print("-1 ")
PY
}

things_pid() { lab_ssh "$IP" '/usr/bin/pgrep -x Things3 | head -n 1' </dev/null | tr -d '[:space:]'; }

# ============================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "=== VOPAT1 setup — $(date) ==="
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
  scpO lab/scripts/vopat1-helper.jxa.js "admin@$IP:/Users/admin/labh/vopat1.jxa.js" >/dev/null
  scpO lab/scripts/vopat1-observer.py "admin@$IP:/Users/admin/labh/vopat1-observer.py" >/dev/null

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
  if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }; fi
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  # SBCHV1 operator note (a): the guest bundle needs node_modules/commander
  # beside dist, or every `things` invocation dies on ERR_MODULE_NOT_FOUND and
  # the failure surfaces much later as a puzzling "the GUI vector is off".
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO lab/scripts/vopat1-helper.jxa.js "admin@$IP:/Users/admin/labh/vopat1.jxa.js" >/dev/null
  scpO lab/scripts/vopat1-observer.py "admin@$IP:/Users/admin/labh/vopat1-observer.py" >/dev/null
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "reshipped dist + helpers ($(date)); cli: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1 | tail -1)"
  ship_snap
  exit 0
fi

# ============================================================== seed
# The #676 field shape, mirrored: 14 areas (12 seeded + the golden's 2), one
# section taller than any viewport, and a top-up to exactly the field's 174 rows.
if [ "$CMD" = "seed" ]; then
  load_session
  note "=== seed — the #676 sidebar shape ==="
  for A in Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu; do
    lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to make new area with properties {name:\"$A\"}'" </dev/null >/dev/null 2>&1
    sleep 1
  done
  seed_projects() { local a="$1" n="$2" i
    for i in $(seq -w 1 "$n"); do
      lab_ssh "$IP" "open -g 'things:///add-project?title=$a-P$i&area=$a'" </dev/null >/dev/null 2>&1
      sleep 0.55
    done; }
  seed_projects Beta 4
  seed_projects Delta 6
  seed_projects Eta 8
  seed_projects Theta "${WALL_PROJECTS:-63}"
  seed_projects Lambda 5
  seed_projects Mu 3
  sleep 3
  note "areas: $(gq 'SELECT COUNT(*) FROM TMArea')"
  ship_snap
  note "sidebar rows: $(snapjson | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("rows",[])))')"
  exit 0
fi

# ============================================================== topup
if [ "$CMD" = "topup" ]; then
  load_session; ship_snap
  A="${TOPUP_AREA:-Eta}"; N="${TOPUP_N:-42}"
  note "=== topup — $N more projects under \"$A\" (field parity: 174 table rows) ==="
  for i in $(seq -w 1 "$N"); do
    lab_ssh "$IP" "open -g 'things:///add-project?title=$A-T$i&area=$A'" </dev/null >/dev/null 2>&1
    sleep 0.5
  done
  sleep 3
  ship_snap
  note "  sidebar rows now: $(snapjson | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("rows",[])))')"
  exit 0
fi

# ============================================================== shape
if [ "$CMD" = "shape" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  note "=== shape — the fixture at the top boundary ==="
  M setbar 0 >/dev/null 2>&1; sleep 1
  note "  state: $(M state)"
  note "  paths: $(M paths)"
  note "  area ordinals (DB-predicted): $(predict_ordinals)"
  exit 0
fi

# ============================================================== CELL 1 hittest
if [ "$CMD" = "hittest" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  M setbar 0 >/dev/null 2>&1; sleep 1
  read -r ORD WANT <<<"$(visible_area)"
  read -r ORD2 WANT2 <<<"$(offscreen_area)"
  note "=== CELL 1 hittest — find one area's row, three ways ==="
  note "  IN-BAND target: ordinal $ORD ($WANT) · OFF-BAND target: ordinal $ORD2 ($WANT2)"
  note "  --- (A) the target is DRAWN: all three routes are available ---"
  for i in 1 2 3; do
    note "  run $i: $(M hittest "$WANT" "$ORD")"
    sleep 1
  done
  note "  --- (B) the target is OFF-SCREEN: the hit-test's honest limit ---"
  for i in 1 2; do
    note "  run $i: $(M hittest "$WANT2" "$ORD2")"
    sleep 1
  done
  exit 0
fi

# ============================================================== CELL 2 visset
if [ "$CMD" = "visset" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  M setbar 0 >/dev/null 2>&1; sleep 1
  ORDS=$(predict_ordinals)
  note "=== CELL 2 visset — full sweep vs AXVisibleRows vs sparse (ordinals: $ORDS) ==="
  for i in 1 2; do
    note "  run $i: $(M visset "$ORDS")"
    sleep 1
  done
  note "  --- scrolled to the middle, where the visible set is a different 28 rows ---"
  M setbar 0.5 >/dev/null 2>&1; sleep 1
  note "  mid: $(M visset "$ORDS")"
  M setbar 0 >/dev/null 2>&1; sleep 1
  exit 0
fi

# ============================================================== CELL 3 notify
# An AXObserver instead of a poll. Every actuation is run TWICE: once with the
# observer armed for a broad notification set (what fires at all?), and the
# silence list is the law.
if [ "$CMD" = "notify" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  M setbar 0 >/dev/null 2>&1; sleep 1
  PID=$(things_pid)
  note "=== CELL 3 notify — do notifications replace the poll? (pid $PID) ==="
  PATHS=$(M paths)
  echo "$PATHS" > "$OUT/paths.json"
  note "  paths: $PATHS"
  TP=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["tablePath"]))' "$OUT/paths.json")
  SP=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["scrollAreaPath"]))' "$OUT/paths.json")
  BP=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["scrollBarPath"]))' "$OUT/paths.json")

  TARGETS=$(python3 - "$TP" "$SP" <<'PY'
import json, sys
table, scroll = json.loads(sys.argv[1]), json.loads(sys.argv[2])
row_notes = ["AXRowCountChanged", "AXValueChanged", "AXLayoutChanged", "AXSelectedRowsChanged",
             "AXUIElementDestroyed", "AXResized", "AXMoved", "AXCreated"]
app_notes = ["AXFocusedUIElementChanged", "AXWindowCreated", "AXSheetCreated", "AXMainWindowChanged",
             "AXMenuOpened", "AXMenuClosed", "AXCreated", "AXUIElementDestroyed", "AXLayoutChanged",
             "AXValueChanged", "AXTitleChanged"]
print(json.dumps([
    {"label": "app", "path": [], "notifications": app_notes},
    {"label": "table", "path": table, "notifications": row_notes},
    {"label": "scrollArea", "path": scroll, "notifications": ["AXValueChanged", "AXLayoutChanged", "AXResized", "AXMoved"]},
]))
PY
)
  note "  --- (a) CONTROL: observer armed, nothing actuated (3s) ---"
  note "  $(OBS "$TARGETS" 3000 none)"

  note "  --- (b) the scroll bar's AXValue set to 0.5 (the SBSCR1 pointerless scroll) ---"
  note "  $(OBS "$TARGETS" 4000 "ax-setnum:$(python3 -c 'import json,sys; print(",".join(map(str, json.loads(sys.argv[1]))))' "$BP")=0.5")"
  M setbar 0 >/dev/null 2>&1; sleep 1

  note "  --- (c) a GEOMETRY-ONLY scroll loop onto an off-screen row ---"
  WALL="${WALL:-Theta}"
  ORDW=$(ordinal_of "$WALL")
  note "  seekord $ORDW: $(M seekord "$ORDW")"

  note "  --- (d) a disclosure chevron click (the actuation that CHANGES the row count) ---"
  CHEV=$(M chevpoint "$WALL" "$ORDW")
  echo "$CHEV" > "$OUT/chevpoint.json"
  note "  chevron: $CHEV"
  INBAND=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("yes" if d.get("inBand") else "no")' "$OUT/chevpoint.json")
  CX=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["point"][0] if d.get("point") else -1)' "$OUT/chevpoint.json")
  CY=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["point"][1] if d.get("point") else -1)' "$OUT/chevpoint.json")
  # REFUSE an off-band click. A synthesized click at a point the sidebar does not
  # own lands on whatever else is drawn there — measured once, it opened a second
  # Things window and invalidated the table element every observer was
  # registered on. A click is only ever dispatched inside the viewport.
  if [ "$CX" != "-1" ] && [ "$INBAND" = "yes" ]; then
    note "  collapse: $(OBS "$TARGETS" 6000 "cg-click:$CX,$CY")"
    sleep 2
    # The table element is destroyed and rebuilt by the fold, so the observer is
    # re-registered against freshly-read paths for the restoring click.
    PATHS2=$(M paths); echo "$PATHS2" > "$OUT/paths2.json"
    TP2=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["tablePath"]))' "$OUT/paths2.json")
    SP2=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["scrollAreaPath"]))' "$OUT/paths2.json")
    TARGETS2=$(python3 - "$TP2" "$SP2" <<'PY'
import json, sys
table, scroll = json.loads(sys.argv[1]), json.loads(sys.argv[2])
print(json.dumps([
    {"label": "app", "path": [], "notifications": ["AXFocusedUIElementChanged", "AXWindowCreated", "AXSheetCreated", "AXCreated", "AXUIElementDestroyed", "AXLayoutChanged", "AXValueChanged"]},
    {"label": "table", "path": table, "notifications": ["AXRowCountChanged", "AXValueChanged", "AXLayoutChanged", "AXSelectedRowsChanged", "AXUIElementDestroyed", "AXCreated"]},
    {"label": "scrollArea", "path": scroll, "notifications": ["AXValueChanged", "AXLayoutChanged", "AXResized", "AXMoved"]},
]))
PY
)
    CHEV2=$(M chevpoint "$WALL" "$ORDW"); echo "$CHEV2" > "$OUT/chevpoint2.json"
    CX2=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["point"][0] if d.get("point") else -1)' "$OUT/chevpoint2.json")
    CY2=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["point"][1] if d.get("point") else -1)' "$OUT/chevpoint2.json")
    IB2=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("yes" if d.get("inBand") else "no")' "$OUT/chevpoint2.json")
    if [ "$CX2" != "-1" ] && [ "$IB2" = "yes" ]; then
      note "  restore:  $(OBS "$TARGETS2" 6000 "cg-click:$CX2,$CY2")"
      sleep 2
    else
      note "  restore skipped — the chevron left the band after the fold ($CHEV2)"
    fi
  else
    note "  chevron not in band after the seek — no click dispatched"
  fi
  note "  rows after: $(M state)"
  exit 0
fi

# ============================================================== CELL 3b/4/5 sheet
# Open the Repeat dialog and keep it open, then measure: which notifications the
# sheet's own actuations fire, the minimum content reads per recipe step, and
# per-role content cost.
if [ "$CMD" = "sheet" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  PID=$(things_pid)
  note "=== CELLS 3b/4/5 — the Repeat sheet (pid $PID) ==="

  # A synthetic target to-do, revealed and selected.
  UUID=$(gq "SELECT uuid FROM TMTask WHERE title='VOPAT1-TARGET' AND trashed=0 LIMIT 1")
  if [ -z "$UUID" ]; then
    lab_ssh "$IP" "open -g 'things:///add?title=VOPAT1-TARGET&list=Today'" </dev/null >/dev/null 2>&1
    sleep 3
    UUID=$(gq "SELECT uuid FROM TMTask WHERE title='VOPAT1-TARGET' AND trashed=0 LIMIT 1")
  fi
  note "  target: $UUID"
  lab_ssh "$IP" "open -g 'things:///show?id=$UUID'" </dev/null >/dev/null 2>&1
  sleep 2; activate

  # (a) SHEET-OPEN, watched. Does kAXSheetCreated fire, and how fast, against
  #     the polling wait the drive uses today?
  APPONLY='[{"label":"app","path":[],"notifications":["AXSheetCreated","AXWindowCreated","AXFocusedUIElementChanged","AXCreated","AXLayoutChanged","AXMenuOpened","AXMenuClosed","AXValueChanged"]}]'
  OPEN_CMD='/usr/bin/osascript -e '"'"'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1'"'"''
  note "  --- (a) Items ▸ Repeat… — is the sheet's arrival a notification? ---"
  note "  $(OBS "$APPONLY" 8000 "cmd:$OPEN_CMD")"
  sleep 2

  note "  --- (b) the sheet, one element at a time (CELL 4) ---"
  SHEET=$(M sheet)
  echo "$SHEET" > "$OUT/sheet.json"
  note "  $SHEET"

  note "  --- (c) per-role content cost (CELL 5) ---"
  note "  $(M rolecost "${ROLE_N:-60}")"

  # (d) the sheet's own actuations, watched.
  if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("ok") else 1)' "$OUT/sheet.json"; then
    SHP=$(python3 -c 'import json,sys; print(",".join(map(str, json.load(open(sys.argv[1]))["sheetPath"])))' "$OUT/sheet.json")
    POPUP=$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
p=[c for c in d["controlPaths"] if c["role"]=="AXPopUpButton"]
print(",".join(map(str,p[0]["path"])) if p else "")' "$OUT/sheet.json")
    SHEETTARGETS=$(python3 - "$SHP" <<'PY'
import json, sys
sheet = [int(x) for x in sys.argv[1].split(",")]
print(json.dumps([
    {"label": "app", "path": [], "notifications": ["AXFocusedUIElementChanged", "AXMenuOpened", "AXMenuClosed", "AXCreated", "AXUIElementDestroyed", "AXLayoutChanged", "AXValueChanged", "AXSheetCreated"]},
    {"label": "sheet", "path": sheet, "notifications": ["AXLayoutChanged", "AXValueChanged", "AXCreated", "AXUIElementDestroyed", "AXResized", "AXMoved", "AXTitleChanged"]},
]))
PY
)
    if [ -n "$POPUP" ]; then
      note "  --- (d) the frequency pop-up pressed (AXPress) — what does the rebuild announce? ---"
      note "  $(OBS "$SHEETTARGETS" 5000 "ax-press:$POPUP")"
      sleep 1
      note "  --- (e) Escape to close the menu ---"
      note "  $(OBS "$SHEETTARGETS" 3000 "key:53")"
      sleep 1
    fi
    note "  --- (f) typing one character into the sheet ---"
    note "  $(OBS "$SHEETTARGETS" 4000 "key:18")"
    sleep 1
  fi

  note "  --- closing the sheet (Escape) ---"
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to key code 53'" </dev/null >/dev/null 2>&1
  sleep 1
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to key code 53'" </dev/null >/dev/null 2>&1
  exit 0
fi

# ======================================================= CELL 3c settle
# THE SETTLE QUESTION, which is the whole point of cell 3 for the Repeat dialog:
# a frequency SELECTION rebuilds the cadence group (BEEP1), and the shipped
# settle waits for two agreeing reads of that group. Does the rebuild ANNOUNCE
# itself? And does a keystroke into the rebuilt field announce anything, so a
# read-back could be skipped?
if [ "$CMD" = "settle" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  PID=$(things_pid)
  note "=== CELL 3c settle — does the cadence-group rebuild announce itself? (pid $PID) ==="

  UUID=$(gq "SELECT uuid FROM TMTask WHERE title='VOPAT1-TARGET' AND trashed=0 LIMIT 1")
  if [ -z "$UUID" ]; then
    lab_ssh "$IP" "open -g 'things:///add?title=VOPAT1-TARGET&list=Today'" </dev/null >/dev/null 2>&1
    sleep 3
    UUID=$(gq "SELECT uuid FROM TMTask WHERE title='VOPAT1-TARGET' AND trashed=0 LIMIT 1")
  fi
  lab_ssh "$IP" "open -g 'things:///show?id=$UUID'" </dev/null >/dev/null 2>&1
  sleep 2; activate
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"Repeat…\" of menu \"Items\" of menu bar 1'" </dev/null >/dev/null 2>&1
  sleep 2

  MENU=$(M menuitems); echo "$MENU" > "$OUT/menu.json"
  note "  frequency pop-up: $MENU"
  FLD=$(M fieldpath); echo "$FLD" > "$OUT/field.json"
  note "  cadence field: $FLD"

  SHP=$(python3 -c 'import json,sys; print(",".join(map(str, json.load(open(sys.argv[1]))["sheetPath"])))' "$OUT/field.json")
  GRP=$(python3 -c 'import json,sys; print(",".join(map(str, json.load(open(sys.argv[1]))["groupPath"])))' "$OUT/field.json")
  FLDP=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(",".join(map(str, d["fieldPath"])) if d.get("fieldPath") else "")' "$OUT/field.json")

  TGT=$(python3 - "$OUT/menu.json" "$SHP" "$GRP" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
sheet = [int(x) for x in sys.argv[2].split(",")]
group = [int(x) for x in sys.argv[3].split(",")]
print(json.dumps([
    {"label": "app", "path": [], "notifications": ["AXFocusedUIElementChanged", "AXMenuOpened", "AXMenuClosed", "AXCreated", "AXUIElementDestroyed", "AXValueChanged", "AXLayoutChanged", "AXSheetCreated"]},
    {"label": "sheet", "path": sheet, "notifications": ["AXLayoutChanged", "AXValueChanged", "AXCreated", "AXUIElementDestroyed", "AXResized", "AXMoved", "AXRowCountChanged"]},
    {"label": "group", "path": group, "notifications": ["AXLayoutChanged", "AXValueChanged", "AXCreated", "AXUIElementDestroyed", "AXResized", "AXMoved"]},
]))
PY
)
  # Pick a menu item that is NOT the pop-up's current value, so the selection
  # genuinely rebuilds the group rather than re-selecting what is already there.
  ITEM=$(python3 - "$OUT/menu.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
cur = (d.get("currentValue") or "").strip()
for it in d.get("items", []):
    t = (it.get("title") or "").strip()
    if it.get("role") == "AXMenuItem" and t and t != cur:
        print("%s|%s" % (",".join(map(str, it["path"])), t))
        break
else:
    print("|")
PY
)
  ITEMPATH="${ITEM%%|*}"; ITEMTITLE="${ITEM##*|}"
  note "  --- (g) the pop-up opened, then \"$ITEMTITLE\" selected — what does the REBUILD announce? ---"
  if [ -n "$ITEMPATH" ]; then
    POPUP=$(python3 -c 'import json,sys; print(",".join(map(str, json.load(open(sys.argv[1]))["popUpPath"])))' "$OUT/menu.json")
    note "  open:   $(OBS "$TGT" 2500 "ax-press:$POPUP")"
    sleep 1
    note "  select: $(OBS "$TGT" 5000 "ax-press:$ITEMPATH")"
    sleep 2
  else
    note "  no distinct menu item found — skipped"
  fi

  note "  --- (h) the numeric field focused, then a digit typed — is a read-back avoidable? ---"
  FLD2=$(M fieldpath); echo "$FLD2" > "$OUT/field2.json"
  note "  field after the rebuild: $FLD2"
  FLDP2=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(",".join(map(str, d["fieldPath"])) if d.get("fieldPath") else "")' "$OUT/field2.json")
  if [ -n "$FLDP2" ]; then
    note "  focus:  $(OBS "$TGT" 2500 "ax-focus:$FLDP2")"
    sleep 1
    note "  type 3: $(OBS "$TGT" 3000 "key:20")"
    sleep 1
    note "  field now: $(M fieldpath)"
  else
    note "  no numeric field on the rebuilt group — skipped"
  fi

  note "  --- closing the sheet without committing (Escape) ---"
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to key code 53'" </dev/null >/dev/null 2>&1
  sleep 1
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to key code 53'" </dev/null >/dev/null 2>&1
  sleep 1
  note "  repeating rule left behind (expect 0): $(gq "SELECT COUNT(*) FROM TMTask WHERE uuid='$UUID' AND rt1_recurrenceRule IS NOT NULL")"
  exit 0
fi

# ============================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "=== teardown — destroying $VM ==="
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  rm -f "$SESSION"
  note "  remaining VMs: $(tart list | tail -n +2 | awk '{print $2}' | tr '\n' ' ')"
  exit 0
fi

echo "usage: $0 {setup|reship|seed|topup|shape|hittest|visset|notify|sheet|settle|teardown}" >&2
exit 2
