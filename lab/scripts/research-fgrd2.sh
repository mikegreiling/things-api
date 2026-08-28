#!/bin/bash
# FGRD2 — the window/focus census rebuilt on ADDRESSED queries (issue #629),
# probed and certified on BOTH Things builds:
#
#   VM=fgrd2-3231 SWAP=1   golden-v4 clone with /Applications/Things3.app
#                          swapped for Things 3.23.1 (direct channel, build
#                          32301002) — the field build's sibling.
#   VM=fgrd2-323           a PLAIN golden-v4 clone (Things 3.23 / 32300036) —
#                          the no-regression arm on the certified build.
#
# Phases:
#   setup     clone + boot + airgap + clock pin (+ app swap when SWAP=1) + warm-up
#   ship      build dist + push node/dist/commander + ui-enabled
#   probe     THE DIAGNOSIS: time every sub-query of the 0.19.2 census
#             individually with the Repeat sheet standing, small tree and big
#             tree, so the offending construct is named by measurement.
#   cells     the certification cells (F/G/S/U/C)
#   teardown  stop + delete the clone
#
# METHOD: the golden is NEVER booted. Airgapped, clock pinned 2026-07-05 and
# never rolled (trial wall 2026-07-18). Fixtures fully synthetic (FGRD2-*).
# Beep sentinel default-on. Both lab escapes exported.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-fgrd2-3231}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
SWAP="${SWAP:-0}"
SWAP_ZIP="${SWAP_ZIP:-/Volumes/Workspace/things-releases/Things3-3.23.1-32301002.zip}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)
note() { echo "[fgrd2/$VM] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\'' >/dev/null 2>&1; sleep 1; osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
front() { lab_ssh "$IP" "osascript -e 'tell application \"$1\" to activate'; sleep 1" </dev/null; }
add() { lab_ssh "$IP" "open -g $(printf '%q' "things:///add?title=$1"); sleep 2" </dev/null; }
cli() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*" </dev/null; }
beeps() { lab_ssh "$IP" '~/labh/beep-sentinel.sh report' </dev/null 2>&1; }

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }
  [ "$SWAP" = "1" ] && { [ -f "$SWAP_ZIP" ] || { note "FATAL: missing $SWAP_ZIP"; exit 1; }; }

  note "cloning $GOLDEN -> $VM (SWAP=$SWAP)"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"

  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (trial wall 2026-07-18 — never rolled)"

  if [ "$SWAP" = "1" ]; then
    note "pre-swap: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) ($(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)) sdef=$(lab_ssh "$IP" 'shasum -a 256 /Applications/Things3.app/Contents/Resources/Things.sdef' </dev/null | cut -c1-16)"
    lab_scp "$SWAP_ZIP" "$LAB_SSH_USER@$IP:/tmp/Things3.zip" >/dev/null
    lab_ssh "$IP" 'set -e
      rm -rf /tmp/things-extract
      ditto -xk /tmp/Things3.zip /tmp/things-extract
      sudo rm -rf /Applications/Things3.app
      sudo mv /tmp/things-extract/Things3.app /Applications/Things3.app
      rm -rf /tmp/Things3.zip /tmp/things-extract' </dev/null || { note "FATAL: swap failed"; exit 1; }
    note "post-swap: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) ($(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null))"
    note "post-swap sdef sha256: $(lab_ssh "$IP" 'shasum -a 256 /Applications/Things3.app/Contents/Resources/Things.sdef' </dev/null)"
    lab_ssh "$IP" 'codesign -dv /Applications/Things3.app 2>&1 | sed -n "1,4p"' </dev/null | tee -a "$REPORT"
  fi

  lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"
  lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null

  note "warm-up launch/quit/relaunch (runs any migration)"
  lab_ssh "$IP" 'open -g -a Things3; sleep 25; osascript -e "tell application \"Things3\" to quit"; sleep 5; open -g -a Things3; sleep 20' </dev/null

  echo "IP=$IP" > "$SESSION"
  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'")
  note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / dbv $DBV / golden $GOLDEN"
  note "setup complete — run: VM=$VM bash lab/scripts/research-fgrd2.sh ship"
  exit 0
fi

# ===================================================================== ship
if [ "$CMD" = "ship" ]; then
  load_session
  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }
  [ -d node_modules/commander ] || { note "FATAL: node_modules/commander missing"; exit 1; }

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null

  CLIV=$(lab_ssh "$IP" "$CLI --version 2>&1 | tail -1" </dev/null)
  case "$CLIV" in
    [0-9]*) note "guest CLI OK: things $CLIV" ;;
    *) note "FATAL: the guest CLI does not run — $CLIV"; exit 1 ;;
  esac
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null
  note "ui-enabled true"
  exit 0
fi

# ===================================================================== probe
# THE DIAGNOSIS. Times every sub-query of the 0.19.2 census INDIVIDUALLY, with
# the Repeat sheet standing and with it dismissed, under a SMALL and a BIG
# Accessibility tree — so the offending construct is named by measurement
# rather than by inspection. Read-only throughout (one hand-opened sheet).
if [ "$CMD" = "probe" ]; then
  load_session
  note "=============================================================="
  note "PROBE start $(date +%H:%M:%S)"

  # A guest-side timer: run one osascript, report elapsed ms + the first line
  # of its output (or the error). Never sleeps, never retries.
  lab_ssh "$IP" 'cat > ~/labh/axtime.py' <<'PY'
import subprocess, sys, time
label = sys.argv[1]
script = sys.stdin.read()
t0 = time.time()
try:
    p = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=90)
    out = (p.stdout.strip() or p.stderr.strip()).replace("\n", " ")[:150]
    code = p.returncode
except subprocess.TimeoutExpired:
    out, code = "TIMEOUT(90s)", -1
print("%-26s %8.0f ms  rc=%s  %s" % (label, (time.time() - t0) * 1000, code, out))
PY
  axt() { lab_ssh "$IP" "python3 ~/labh/axtime.py $(printf '%q' "$1")" <<<"$2"; }

  P_PROCS='tell application "System Events" to return (count of application processes) as text'
  P_FRONTENUM='tell application "System Events" to return name of first application process whose frontmost is true'
  P_FOCUSREF='tell application "System Events"
	set fp to first application process whose frontmost is true
	set fe to value of attribute "AXFocusedUIElement" of fp
	return "got-ref"
end tell'
  P_FOCUSROLE='tell application "System Events"
	set fp to first application process whose frontmost is true
	set fe to value of attribute "AXFocusedUIElement" of fp
	return (role of fe) as text
end tell'
  P_FOCUS_ADDR='tell application "System Events" to tell process "Things3"
	set fe to value of attribute "AXFocusedUIElement"
	return (role of fe) as text
end tell'
  P_FRONT_ADDR='tell application "System Events" to tell process "Things3" to return frontmost as text'
  P_SHEET='tell application "System Events" to tell process "Things3" to return (exists sheet 1 of (first window whose subrole is "AXStandardWindow")) as text'
  P_DETACHED='tell application "System Events" to tell process "Things3" to return (count of (windows whose subrole is "AXUnknown" and size is not {40, 40})) as text'
  P_CENSUS='tell application "System Events" to tell process "Things3"
	set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
	return "cb:" & (count of checkboxes of sh) & " pu:" & (count of pop up buttons of sh) & " bt:" & (count of buttons of sh) & " gp:" & (count of groups of sh) & " tf:" & (count of text fields of sh)
end tell'
  P_POPUP='tell application "System Events" to tell process "Things3" to return (value of pop up button 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")) as text'

  run_matrix() {
    note "--- $1"
    axt "procs-count"            "$P_PROCS"      | tee -a "$REPORT"
    axt "A front-enumerate"      "$P_FRONTENUM"  | tee -a "$REPORT"
    axt "B focusref-sysWide"     "$P_FOCUSREF"   | tee -a "$REPORT"
    axt "B2 focusrole-sysWide"   "$P_FOCUSROLE"  | tee -a "$REPORT"
    axt "B3 focusrole-addressed" "$P_FOCUS_ADDR" | tee -a "$REPORT"
    axt "F front-addressed"      "$P_FRONT_ADDR" | tee -a "$REPORT"
    axt "C sheet-exists"         "$P_SHEET"      | tee -a "$REPORT"
    axt "E detached-whose"       "$P_DETACHED"   | tee -a "$REPORT"
    axt "D sheet-census"         "$P_CENSUS"     | tee -a "$REPORT"
    axt "G popup-read"           "$P_POPUP"      | tee -a "$REPORT"
  }
  uistate() {
    local t0 t1
    t0=$(python3 -c 'import time;print(time.time())')
    OUTJ=$(lab_ssh "$IP" "$LAB_DIRECT $CLI ui-state --json" </dev/null 2>&1 | head -c 600)
    t1=$(python3 -c 'import time;print(time.time())')
    note "  things ui-state ($(python3 -c "print('%.1f' % (($t1-$t0)*1000))") ms incl. ssh): $OUTJ"
  }
  opensheet() {
    lab_ssh "$IP" "open -g 'things:///show?id=$1'; sleep 3" </dev/null
    front Things3
    axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
    sleep 2
    note "sheet open? $(axq 'tell application "System Events" to tell process "Things3" to return (exists sheet 1 of (first window whose subrole is "AXStandardWindow")) as text')"
  }

  add "FGRD2%20probe%20target"
  PT=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD2 probe target' AND trashed=0 LIMIT 1")
  note "probe fixture: $PT"

  front Things3
  note "### SMALL TREE / sheet CLOSED"
  run_matrix "small-tree, no sheet"; uistate
  opensheet "$PT"
  note "### SMALL TREE / sheet OPEN"
  run_matrix "small-tree, sheet open"; uistate
  esc

  BIG="${BIG:-1200}"
  note "seeding $BIG synthetic rows (FGRD2-bulk-*)"
  lab_ssh "$IP" "cat > ~/labh/bulk.py" <<PY
import json, subprocess, time, urllib.parse
N = $BIG
for chunk in range(0, N, 100):
    items = [{"type": "to-do", "attributes": {"title": "FGRD2-bulk-%04d" % i, "when": "anytime"}}
             for i in range(chunk, min(chunk + 100, N))]
    subprocess.run(["open", "-g", "things:///json?data=" + urllib.parse.quote(json.dumps(items))])
    time.sleep(1.5)
PY
  lab_ssh "$IP" 'python3 ~/labh/bulk.py' </dev/null >/dev/null 2>&1
  sleep 10
  note "bulk rows in DB: $(gq "SELECT count(*) FROM TMTask WHERE title LIKE 'FGRD2-bulk-%' AND trashed=0")"
  front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=anytime'; sleep 8" </dev/null
  front Things3
  note "AX rows in the content table: $(axq 'tell application "System Events" to tell process "Things3" to return (count of rows of table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")) as text')"
  note "### BIG TREE / sheet CLOSED"
  run_matrix "big-tree, no sheet"; uistate
  opensheet "$PT"
  note "### BIG TREE / sheet OPEN"
  run_matrix "big-tree, sheet open"; uistate
  esc

  note "PROBE done $(date +%H:%M:%S); beeps: $(beeps)"
  exit 0
fi

# ====================================================================== hang
# THE CONTROLLED FAILURE. The field host differs from this clone in ways a
# headless golden cannot carry (a real display session, ~4x the process table,
# the deputy transport). What it CAN carry is the mechanism under suspicion: one
# application process in the table that does not answer Accessibility. SIGSTOP
# a GUI app, then time the census's UNADDRESSED constructs against the ADDRESSED
# ones. Read-only; the frozen process is resumed at the end of the cell.
if [ "$CMD" = "hang" ]; then
  load_session
  note "=============================================================="
  note "HANG cell start $(date +%H:%M:%S)"
  axt() { lab_ssh "$IP" "python3 ~/labh/axtime.py $(printf '%q' "$1")" <<<"$2"; }
  P_FRONTENUM='tell application "System Events" to return name of first application process whose frontmost is true'
  P_FOCUSROLE='tell application "System Events"
	set fp to first application process whose frontmost is true
	set fe to value of attribute "AXFocusedUIElement" of fp
	return (role of fe) as text
end tell'
  P_FRONT_ADDR='tell application "System Events" to tell process "Things3" to return frontmost as text'
  P_FOCUS_ADDR='tell application "System Events" to tell process "Things3"
	set fe to value of attribute "AXFocusedUIElement"
	return (role of fe) as text
end tell'
  P_SHEET='tell application "System Events" to tell process "Things3" to return (exists sheet 1 of (first window whose subrole is "AXStandardWindow")) as text'
  P_CENSUS='tell application "System Events" to tell process "Things3"
	set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
	return "cb:" & (count of checkboxes of sh) & " pu:" & (count of pop up buttons of sh) & " bt:" & (count of buttons of sh) & " gp:" & (count of groups of sh) & " tf:" & (count of text fields of sh)
end tell'
  P_CANCEL='tell application "System Events" to tell process "Things3" to return (exists button "Cancel" of sheet 1 of (first window whose subrole is "AXStandardWindow")) as text'

  hang_matrix() {
    note "--- $1"
    axt "A front-enumerate"      "$P_FRONTENUM"  | tee -a "$REPORT"
    axt "B2 focusrole-sysWide"   "$P_FOCUSROLE"  | tee -a "$REPORT"
    axt "F front-addressed"      "$P_FRONT_ADDR" | tee -a "$REPORT"
    axt "B3 focusrole-addressed" "$P_FOCUS_ADDR" | tee -a "$REPORT"
    axt "C sheet-exists"         "$P_SHEET"      | tee -a "$REPORT"
    axt "D sheet-census"         "$P_CENSUS"     | tee -a "$REPORT"
    axt "H cancel-exists"        "$P_CANCEL"     | tee -a "$REPORT"
  }
  uistate2() {
    local t0 t1
    t0=$(python3 -c 'import time;print(time.time())')
    OUTJ=$(lab_ssh "$IP" "$LAB_DIRECT $CLI ui-state --json" </dev/null 2>&1 | grep -o '"data":.*' | head -c 500)
    t1=$(python3 -c 'import time;print(time.time())')
    note "  things ui-state ($(python3 -c "print('%.0f' % (($t1-$t0)*1000))") ms incl. ssh): $OUTJ"
  }

  PT=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD2 probe target' AND trashed=0 LIMIT 1")
  [ -n "$PT" ] || { add "FGRD2%20probe%20target"; PT=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD2 probe target' AND trashed=0 LIMIT 1"); }
  lab_ssh "$IP" "open -g 'things:///show?id=$PT'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  note "sheet open? $(axq 'tell application "System Events" to tell process "Things3" to return (exists sheet 1 of (first window whose subrole is "AXStandardWindow")) as text')"

  note "### CONTROL — every process answering, sheet OPEN"
  hang_matrix "control"; uistate2

  lab_ssh "$IP" 'open -g -a TextEdit; sleep 5' </dev/null
  TEPID=$(lab_ssh "$IP" 'pgrep -x TextEdit | head -1' </dev/null)
  note "TextEdit pid=$TEPID — SIGSTOP (one unresponsive application process in the table)"
  lab_ssh "$IP" "kill -STOP $TEPID" </dev/null
  sleep 2
  note "### FROZEN — one application process not answering AX, sheet OPEN"
  hang_matrix "one frozen process"; uistate2
  note "  the SAME cell again (a second reading, so the first is not a one-off)"
  hang_matrix "one frozen process (rerun)"; uistate2

  lab_ssh "$IP" "kill -CONT $TEPID; sleep 1; osascript -e 'tell application \"TextEdit\" to quit'" </dev/null >/dev/null 2>&1
  sleep 2
  note "### RESUMED — the frozen process released"
  hang_matrix "resumed"; uistate2
  esc
  note "HANG cell done $(date +%H:%M:%S)"
  exit 0
fi

# ====================================================================== cells
# The certification set, run identically on BOTH builds:
#   F  the field's failing command shape, end to end (after-completion +
#      monthly unit + interval 1 + a future --when) — must LAND.
#   U  ui-state with the Repeat sheet standing — must NAME the sheet.
#   G  focus theft mid-drive — the guard must still refuse cleanly, type
#      nothing, and leave nothing behind.
#   S  a stranded sheet: an abort with the dialog open must end with the dialog
#      PROVENLY cancelled and the disposable clone trashed, zero manual action.
if [ "$CMD" = "cells" ]; then
  load_session
  note "=============================================================="
  note "CELLS start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  note "guest: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) ($(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null))"

  add "FGRD2%20delta"
  add "FGRD2%20echo"
  DELTA=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD2 delta' AND trashed=0 LIMIT 1")
  ECHO=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD2 echo' AND trashed=0 LIMIT 1")
  note "fixtures: delta=$DELTA echo=$ECHO"
  [ -n "$DELTA" ] && [ -n "$ECHO" ] || { note "FATAL: fixtures missing"; exit 1; }

  # ============================================================ F — the field shape
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "F field shape"' </dev/null >/dev/null
  front Things3
  cli todo add-repeating "'FGRD2 foxtrot'" --when 2026-07-10 --frequency monthly --interval 1 \
    --after-completion --dangerously-drive-gui --verify-timeout 90000 --json \
    > "$OUT/f1.json" 2>"$OUT/f1.err"
  note "F1 exit=$? out=$(head -c 900 "$OUT/f1.json")"
  note "F1 stderr: $(head -c 500 "$OUT/f1.err")"
  note "F1 template rows: $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD2 foxtrot' AND rt1_recurrenceRule IS NOT NULL AND trashed=0")"
  note "F1 total rows titled FGRD2 foxtrot: $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD2 foxtrot' AND trashed=0")"
  cli ui-state --json 2>/dev/null | tail -1 > "$OUT/f1-after.json"
  note "F1 census after: $(head -c 400 "$OUT/f1-after.json")"

  # =================================================================== U — ui-state
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "U ui-state"' </dev/null >/dev/null
  lab_ssh "$IP" "open -g 'things:///show?id=$DELTA'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  cli ui-state --json 2>/dev/null | tail -1 > "$OUT/u3.json"
  note "U3 (sheet open, Things frontmost): $(head -c 700 "$OUT/u3.json")"
  front Finder
  cli ui-state --json 2>/dev/null | tail -1 > "$OUT/u4.json"
  note "U4 (sheet open, Finder frontmost): $(head -c 700 "$OUT/u4.json")"
  esc
  cli ui-state --json 2>/dev/null | tail -1 > "$OUT/u1.json"
  note "U1 (no dialog): $(head -c 400 "$OUT/u1.json")"

  # ============================================================== G — focus theft
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "G theft"' </dev/null >/dev/null
  lab_ssh "$IP" 'cat > ~/labh/theft.sh && chmod +x ~/labh/theft.sh' <<'EOF'
#!/bin/bash
# A drive that MUST type (interval 3 is not the default, so the read-back-first
# skip cannot apply), with focus stolen the instant the Repeat dialog appears —
# a closed loop on the dialog's existence, never a sleep. One ssh invocation
# that waits on everything it starts.
CLI="$HOME/things-lab/bin/node $HOME/things-lab/things-api/dist/cli/main.js"
export THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1
$CLI todo make-repeating "$1" --frequency weekly --interval 3 --dangerously-drive-gui \
  --verify-timeout 90000 --json >"$HOME/labh/theft-out.json" 2>"$HOME/labh/theft-err.txt" &
DRIVE=$!
SAW=no
for _ in $(seq 1 500); do
  OPEN=$(osascript -e 'tell application "System Events" to tell process "Things3" to return ((exists sheet 1 of (first window whose subrole is "AXStandardWindow")) or ((count of (windows whose subrole is "AXUnknown" and size is not {40, 40})) > 0))' 2>/dev/null)
  if [ "$OPEN" = "true" ]; then SAW=yes; break; fi
  sleep 0.1
done
osascript -e 'tell application "Finder" to activate' >/dev/null 2>&1
echo "sheet-seen=$SAW"
wait $DRIVE
echo "drive-exit=$?"
EOF
  front Things3
  note "G1 $(lab_ssh "$IP" "~/labh/theft.sh $DELTA" </dev/null 2>&1 | tr '\n' ' ')"
  note "G1 stdout: $(lab_ssh "$IP" 'head -c 900 ~/labh/theft-out.json' </dev/null)"
  note "G1 stderr: $(lab_ssh "$IP" 'head -c 1100 ~/labh/theft-err.txt' </dev/null)"
  note "G1 delta repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD2 delta' AND rt1_recurrenceRule IS NOT NULL AND trashed=0") (expect 0)"
  note "G1 delta rows: $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD2 delta' AND trashed=0") (expect 1 — no leaked clone)"
  cli ui-state --json 2>/dev/null | tail -1 > "$OUT/g1-after.json"
  note "G1 census after: $(head -c 400 "$OUT/g1-after.json")"

  # ================================================== S — the stranded-sheet recovery
  # An abort with the sheet standing: the same theft rig, but focus is NOT
  # returned, so the cleanup must recover on its own — Cancel the dialog by
  # address, PROVE it closed, and only then trash the disposable clone (the
  # sheet-empties-collections ordering, MODALX1 §2.1).
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "S stranded"' </dev/null >/dev/null
  front Things3
  note "S1 $(lab_ssh "$IP" "~/labh/theft.sh $ECHO" </dev/null 2>&1 | tr '\n' ' ')"
  note "S1 stderr: $(lab_ssh "$IP" 'head -c 1400 ~/labh/theft-err.txt' </dev/null)"
  SHEETS=$(axq 'tell application "System Events" to tell process "Things3" to return (count of sheets of (first window whose subrole is "AXStandardWindow")) as text')
  note "S1 sheets standing after cleanup: $SHEETS (expect 0 — zero manual action)"
  note "S1 echo rows: $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD2 echo' AND trashed=0") (expect 1 — the disposable clone was trashed)"
  note "S1 echo trashed rows: $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD2 echo' AND trashed=1")"
  note "S1 echo repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD2 echo' AND rt1_recurrenceRule IS NOT NULL AND trashed=0") (expect 0)"
  cli ui-state --json 2>/dev/null | tail -1 > "$OUT/s1-after.json"
  note "S1 census after: $(head -c 400 "$OUT/s1-after.json")"

  note "CELLS done $(date +%H:%M:%S)"
  note "BEEPS: $(lab_ssh "$IP" '~/labh/beep-sentinel.sh assert --allow 99' </dev/null 2>&1 | tr '\n' ' ')"
  exit 0
fi

# ===================================================================== axdump
# The version census: everything a recipe or a guard addresses, dumped from the
# live tree so 3.23 and 3.23.1 can be diffed line for line. Read-only.
if [ "$CMD" = "axdump" ]; then
  load_session
  DUMP="$OUT/axcensus.txt"
  : > "$DUMP"
  {
    echo "Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) ($(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null))"
    echo "macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)"
    echo "databaseVersion $(gq "SELECT value FROM Meta WHERE key='databaseVersion'")"
    echo "sdef $(lab_ssh "$IP" 'shasum -a 256 /Applications/Things3.app/Contents/Resources/Things.sdef' </dev/null | awk '{print $1}')"
    echo "LSMinimumSystemVersion $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info LSMinimumSystemVersion' </dev/null)"
  } | tee -a "$DUMP"

  PT=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD2 probe target' AND trashed=0 LIMIT 1")
  if [ -z "$PT" ]; then add "FGRD2%20probe%20target"; PT=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD2 probe target' AND trashed=0 LIMIT 1"); fi
  lab_ssh "$IP" "open -g 'things:///show?id=$PT'; sleep 3" </dev/null
  front Things3
  {
    echo "--- Items menu items"
    axq 'tell application "System Events" to tell process "Things3" to return name of every menu item of menu "Items" of menu bar 1'
    echo "--- Items ▸ Repeat submenu"
    axq 'tell application "System Events" to tell process "Things3" to return name of every menu item of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1'
    echo "--- windows"
    axq 'tell application "System Events" to tell process "Things3" to return (name of every window) & (subrole of every window)'
  } | tee -a "$DUMP"

  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  lab_ssh "$IP" 'cat > ~/labh/axtree.scpt' <<'EOF'
on walk(el, d, acc)
	if d > 4 then return acc
	tell application "System Events"
		repeat with k in (UI elements of el)
			set r to ""
			try
				set r to (role of k) as text
			end try
			set sub to ""
			try
				set sub to (subrole of k) as text
			end try
			set t to ""
			try
				set t to (title of k) as text
			end try
			set nm to ""
			try
				set nm to (name of k) as text
			end try
			set sz to ""
			try
				set sz to (size of k) as text
			end try
			set acc to acc & (my pad(d)) & r & " sub=" & sub & " title=" & t & " name=" & nm & " size=" & sz & linefeed
			set acc to my walk(k, d + 1, acc)
		end repeat
	end tell
	return acc
end walk

on pad(d)
	set s to ""
	repeat d times
		set s to s & "  "
	end repeat
	return s
end pad

tell application "System Events" to tell process "Things3"
	set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
	set hdr to "SHEET role=" & (role of sh) & " size=" & ((size of sh) as text) & linefeed
	return hdr & my walk(sh, 1, "")
end tell
EOF
  {
    echo "--- Repeat sheet tree (roles/titles/sizes; NO control values — synthetic fixture, but the rule stands)"
    lab_ssh "$IP" 'osascript ~/labh/axtree.scpt' </dev/null 2>&1
  } | tee -a "$DUMP"
  esc
  note "axdump written to $DUMP"
  exit 0
fi

# ====================================================================== wedge
# THE INSPECTION THAT WILL NOT ANSWER, staged deterministically: SIGSTOP the
# System Events process itself, so every Accessibility read the census makes
# blocks until its Apple-event budget expires. This is the field's failure MODE
# — not its trigger, which needs the maintainer's host — and it is the arm that
# separates 0.19.2 from the fix: how long `ui-state` takes to give up, and what
# it can still say. System Events is resumed at the end of the cell.
if [ "$CMD" = "wedge" ]; then
  load_session
  note "=============================================================="
  note "WEDGE cell ($(lab_ssh "$IP" "$CLI --version 2>/dev/null | tail -1" </dev/null)) start $(date +%H:%M:%S)"
  PT=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD2 probe target' AND trashed=0 LIMIT 1")
  if [ -z "$PT" ]; then add "FGRD2%20probe%20target"; PT=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD2 probe target' AND trashed=0 LIMIT 1"); fi
  lab_ssh "$IP" "open -g 'things:///show?id=$PT'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  note "sheet open? $(axq 'tell application "System Events" to tell process "Things3" to return (exists sheet 1 of (first window whose subrole is "AXStandardWindow")) as text')"

  lab_ssh "$IP" 'cat > ~/labh/wedge.sh && chmod +x ~/labh/wedge.sh' <<'EOF'
#!/bin/bash
# Freeze System Events, run one `things ui-state`, time it, thaw. Single ssh
# invocation that waits on everything it starts (no orphaned process, ever).
CLI="$HOME/things-lab/bin/node $HOME/things-lab/things-api/dist/cli/main.js"
export THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1
SEPID=$(pgrep -x 'System Events' | head -1)
[ -n "$SEPID" ] || { echo "no System Events process"; exit 1; }
kill -STOP "$SEPID"
T0=$(python3 -c 'import time;print(time.time())')
OUT=$($CLI ui-state --json 2>/dev/null | tail -1)
T1=$(python3 -c 'import time;print(time.time())')
kill -CONT "$SEPID"
python3 -c "print('elapsed_ms=%.0f' % (($T1-$T0)*1000))"
echo "$OUT"
EOF
  note "--- System Events FROZEN, Repeat sheet standing"
  lab_ssh "$IP" '~/labh/wedge.sh' </dev/null 2>&1 | head -c 1400 | tee -a "$REPORT"
  echo | tee -a "$REPORT"
  sleep 3
  note "--- System Events thawed: ui-state again (must be healthy)"
  cli ui-state --json 2>/dev/null | tail -1 | head -c 700 | tee -a "$REPORT"
  echo | tee -a "$REPORT"
  esc
  note "WEDGE cell done $(date +%H:%M:%S)"
  exit 0
fi

# ================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown: $VM stopped and deleted"
  tart list | tee -a "$REPORT"
  exit 0
fi

echo "usage: [VM=…] [SWAP=1] research-fgrd2.sh setup|ship|probe|cells|teardown" >&2
exit 2
