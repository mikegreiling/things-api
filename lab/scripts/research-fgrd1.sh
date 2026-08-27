#!/bin/bash
# FGRD1 — the GUI-drive focus/liveness hardening (issue #620), certified against
# a golden-v4 clone (Things 3.23 / build 32300036 / dbv 27).
#
# What is under test, in the order the cells run:
#
#   U  ui-state       the read-only window/focus census: the 2×2 matrix of
#                     (dialog none | ours) × (frontmost us | another app), plus
#                     the census's own claim to be read-only (zero mutation).
#   S  skip           a numeric field that already holds the requested value is
#                     NOT typed into: the drive discloses "(already set)", the
#                     rule still lands, and the keystroke class disappears.
#   T  theft          FOCUS THEFT mid-drive: another app is activated the instant
#                     the Repeat dialog opens. The next keystroke-class hop must
#                     REFUSE, naming the app that owns the screen, and nothing
#                     may be typed or committed.
#   R  routing        the osascript seam's no-silent-fallback refusal: with the
#                     helpers EXPECTED but not carrying traffic, a script that
#                     would have a visible side effect must not run at all
#                     (positive control: the same script with helpers off DOES
#                     have that effect).
#   C  cleanup        a stranded dialog: the audited ladder recovers focus and
#                     dismisses it by its own Cancel button, verified by a fresh
#                     census; and the app-wide AppleScript freeze an open dialog
#                     imposes is measured directly (the "ghost clone" mechanism).
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (the trial wall is
# 2026-07-18). Fixtures are fully synthetic (FGRD1-*). The clone is destroyed on
# teardown. Beep sentinel marks every cell; counts are reported.
#
# Phases (the clone survives between them; SESSION carries the IP):
#   setup     clone + boot + airgap + clock pin + warm-up + guest helpers
#   ship      build dist + push node/dist/commander + ui-enabled
#   cells     U / S / T / R / C
#   teardown  stop + delete the clone
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-fgrd1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — a Sunday, well inside the trial wall
note() { echo "[fgrd1] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
front() { lab_ssh "$IP" "osascript -e 'tell application \"$1\" to activate'; sleep 1" </dev/null; }
add() { lab_ssh "$IP" "open -g $(printf '%q' "things:///add?title=$1"); sleep 2" </dev/null; }
cli() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*" </dev/null; }

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }

  note "cloning $GOLDEN -> $VM"
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

  lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"
  lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null

  note "warm-up launch/quit/relaunch"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14; osascript -e "tell application \"Things3\" to quit"; sleep 4; open -g -a Things3; sleep 12' </dev/null

  echo "IP=$IP" > "$SESSION"
  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"
  note "setup complete — run: bash lab/scripts/research-fgrd1.sh ship"
  exit 0
fi

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'

# ===================================================================== ship
if [ "$CMD" = "ship" ]; then
  load_session
  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }
  [ -d node_modules/commander ] || { note "FATAL: node_modules/commander missing — run npm ci"; exit 1; }

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
  note "ui-enabled true — run: bash lab/scripts/research-fgrd1.sh cells"
  exit 0
fi

# ==================================================================== cells
if [ "$CMD" = "cells" ]; then
  load_session
  note "=============================================================="
  note "CELLS start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null

  # --- fixtures (fully synthetic) -------------------------------------------
  add "FGRD1%20alpha"
  add "FGRD1%20bravo"
  add "FGRD1%20charlie"
  ALPHA=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD1 alpha' AND trashed=0 LIMIT 1")
  BRAVO=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD1 bravo' AND trashed=0 LIMIT 1")
  CHARLIE=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD1 charlie' AND trashed=0 LIMIT 1")
  note "fixtures: alpha=$ALPHA bravo=$BRAVO charlie=$CHARLIE"
  [ -n "$ALPHA" ] && [ -n "$BRAVO" ] && [ -n "$CHARLIE" ] || { note "FATAL: fixtures missing"; exit 1; }

  # ================================================================= U — ui-state
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "U ui-state"' </dev/null >/dev/null
  front Things3
  note "U1 (no dialog, Things frontmost):"
  cli ui-state --json | tee -a "$REPORT" >/dev/null
  cli ui-state --json > "$OUT/u1.json"
  note "  $(cat "$OUT/u1.json")"
  front Finder
  cli ui-state --json > "$OUT/u2.json"
  note "U2 (no dialog, Finder frontmost): $(cat "$OUT/u2.json")"

  # Open the Repeat dialog by hand (menu press), Things frontmost.
  front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$ALPHA'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  cli ui-state --json > "$OUT/u3.json"
  note "U3 (Repeat dialog open, Things frontmost): $(cat "$OUT/u3.json")"
  front Finder
  cli ui-state --json > "$OUT/u4.json"
  note "U4 (Repeat dialog open, Finder frontmost): $(cat "$OUT/u4.json")"

  # ============================================ C3 — the app-wide AppleScript freeze
  # The mechanism behind the field report's "AppleScript could not get that
  # to-do ID" on a row the database showed present: an open dialog wedges the
  # app's object model. Measured HERE, with the dialog from U3/U4 still open.
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "C3 freeze"' </dev/null >/dev/null
  FREEZE=$(axq "tell application \"Things3\" to delete (to do id \"$CHARLIE\")")
  FROW=$(gq "SELECT trashed FROM TMTask WHERE uuid='$CHARLIE'")
  note "C3 delete-with-dialog-open: reply=[${FREEZE//$'\n'/ }] trashed=$FROW (expect an error / no-op, row still 0)"

  # ============================================ C1/C2 — the audited cleanup ladder
  # The dialog is still open and FINDER owns the screen. A drive that fails now
  # must recover focus, dismiss OUR dialog by its own Cancel button, and verify.
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "C cleanup"' </dev/null >/dev/null
  front Finder
  cli todo make-repeating "$BRAVO" --frequency weekly --interval 2 --dangerously-drive-gui --verify-timeout 60000 --json > "$OUT/c2.json" 2>"$OUT/c2.err"
  note "C2 drive-with-stranded-dialog exit=$? out=$(head -c 600 "$OUT/c2.json")"
  note "C2 stderr: $(head -c 600 "$OUT/c2.err")"
  cli ui-state --json > "$OUT/c2-after.json"
  note "C2 census after: $(cat "$OUT/c2-after.json")"
  esc
  cli ui-state --json > "$OUT/c2-final.json"
  note "C2 census final: $(cat "$OUT/c2-final.json")"
  note "C2 bravo repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD1 bravo' AND rt1_recurrenceRule IS NOT NULL")"
  FRZ2=$(axq "tell application \"Things3\" to delete (to do id \"$CHARLIE\")")
  note "C3b delete AFTER the dialog cleared: reply=[${FRZ2//$'\n'/ }] trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$CHARLIE'") (expect it lands now)"

  # ================================================================= S — the skip
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "S skip"' </dev/null >/dev/null
  front Things3
  cli todo make-repeating "$ALPHA" --frequency daily --interval 1 --after-completion --dangerously-drive-gui --verify-timeout 60000 --json > "$OUT/s1.json" 2>"$OUT/s1.err"
  note "S1 interval-already-1 exit=$? out=$(head -c 800 "$OUT/s1.json")"
  note "S1 stderr: $(head -c 400 "$OUT/s1.err")"
  note "S1 template? $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD1 alpha' AND rt1_recurrenceRule IS NOT NULL")"

  # ================================================================= T — focus theft
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "T theft"' </dev/null >/dev/null
  lab_ssh "$IP" 'cat > ~/labh/theft.sh && chmod +x ~/labh/theft.sh' <<'EOF'
#!/bin/bash
# Start a drive that MUST type (interval 3 is not the default, so the
# read-back-first skip cannot apply), then steal focus the instant the Repeat
# dialog appears — a closed loop on the dialog's existence, never a sleep.
CLI="$HOME/things-lab/bin/node $HOME/things-lab/things-api/dist/cli/main.js"
export THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1
$CLI todo make-repeating "$1" --frequency weekly --interval 3 --dangerously-drive-gui \
  --verify-timeout 60000 --json >"$HOME/labh/theft-out.json" 2>"$HOME/labh/theft-err.txt" &
DRIVE=$!
SAW=no
for _ in $(seq 1 400); do
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
  THEFT=$(lab_ssh "$IP" '~/labh/theft.sh '"$CHARLIE" </dev/null 2>&1)
  note "T1 $THEFT"
  note "T1 stdout: $(lab_ssh "$IP" 'head -c 900 ~/labh/theft-out.json' </dev/null)"
  note "T1 stderr: $(lab_ssh "$IP" 'head -c 900 ~/labh/theft-err.txt' </dev/null)"
  note "T1 charlie repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD1 charlie' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
  cli ui-state --json > "$OUT/t1-after.json"
  note "T1 census after: $(cat "$OUT/t1-after.json")"
  esc

  # ================================================================= R — the seam
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "R routing"' </dev/null >/dev/null
  lab_ssh "$IP" 'cat > ~/labh/seam.mjs' <<'EOF'
// Drive the osascript seam directly with a script whose effect is VISIBLE:
// activating Finder. If the seam refuses, Finder must NOT come forward.
const { osaExec } = await import(process.env.HOME + "/things-lab/things-api/dist/deputy/osa.js");
await import("child_process").then(({ execFileSync }) =>
  execFileSync("osascript", ["-e", 'tell application "Things3" to activate']));
await new Promise((r) => setTimeout(r, 1500));
const res = await osaExec('tell application "Finder" to activate', { timeoutMs: 8000 });
await new Promise((r) => setTimeout(r, 1500));
const front = (await import("child_process")).execFileSync("osascript", [
  "-e", 'tell application "System Events" to return name of first application process whose frontmost is true',
]).toString().trim();
console.log(JSON.stringify({ exitCode: res.exitCode, refused: res.refused === true, stderr: res.stderr.slice(0, 320), frontmostAfter: front }));
EOF
  R_REFUSE=$(lab_ssh "$IP" 'THINGS_API_HELPERS=true ~/things-lab/bin/node ~/labh/seam.mjs' </dev/null 2>&1 | tail -1)
  note "R1 helpers EXPECTED, deputy absent: $R_REFUSE"
  R_DIRECT=$(lab_ssh "$IP" 'THINGS_API_HELPERS=false ~/things-lab/bin/node ~/labh/seam.mjs' </dev/null 2>&1 | tail -1)
  note "R2 POSITIVE CONTROL (helpers off): $R_DIRECT"
  R_CLI=$(lab_ssh "$IP" "THINGS_API_HELPERS=true $LAB_UI_DIRECT $CLI todo make-repeating $CHARLIE --frequency daily --interval 2 --dangerously-drive-gui --json 2>&1 | head -c 700" </dev/null)
  note "R3 CLI with helpers expected: $R_CLI"
  note "R3 charlie repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD1 charlie' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"

  # ================================================================= beeps
  lab_ssh "$IP" '~/labh/beep-sentinel.sh assert --json ~/labh/beeps.json --name fgrd1' </dev/null >"$OUT/beeps.txt" 2>&1
  note "BEEPS: $(cat "$OUT/beeps.txt" | tail -20)"
  note "CELLS done $(date +%H:%M:%S) — artifacts in $OUT"
  exit 0
fi

# =================================================================== cells2
# The second pass. Pass one proved the app-wide freeze so thoroughly that it
# contaminated its own later cells: the hand-opened Repeat dialog from U3 was
# never dismissed (the driver's Escape went to FINDER, which is the very bug
# under test), so S/T/C2 all died at their first AppleScript leg with -1728
# instead of reaching the drive. The lesson is recorded in the campaign doc; the
# fix here is a dismissal that ACTIVATES Things first and then VERIFIES with the
# census, and fresh fixtures per pass.
if [ "$CMD" = "cells2" ]; then
  load_session
  note "=============================================================="
  note "CELLS2 start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null

  dismiss() {
    front Things3
    lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null
    KIND=$(cli ui-state --json 2>/dev/null | python3 -c 'import sys,json; print(json.loads(sys.stdin.read().strip().splitlines()[-1])["data"]["state"]["sheetKind"])' 2>/dev/null)
    note "  dismiss → sheetKind=$KIND"
  }
  dismiss

  add "FGRD1%20delta"
  add "FGRD1%20echo"
  DELTA=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD1 delta' AND trashed=0 LIMIT 1")
  ECHOT=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD1 echo' AND trashed=0 LIMIT 1")
  note "fixtures: delta=$DELTA echo=$ECHOT"

  # ================================================================= S — the skip
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "S2 skip"' </dev/null >/dev/null
  front Things3
  cli todo make-repeating "$DELTA" --frequency daily --interval 1 --after-completion --dangerously-drive-gui --verify-timeout 90000 --json > "$OUT/s2.json" 2>"$OUT/s2.err"
  note "S2 exit=$?"
  note "S2 out: $(head -c 900 "$OUT/s2.json")"
  note "S2 template? $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD1 delta' AND rt1_recurrenceRule IS NOT NULL") rule=$(gq "SELECT count(*) FROM TMTask WHERE title='FGRD1 delta'")"
  dismiss

  # ================================================================= T — focus theft
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "T2 theft"' </dev/null >/dev/null
  front Things3
  ECHO_AREA_BEFORE=$(gq "SELECT ifnull(area,'-')||'|'||ifnull(startDate,'-')||'|'||start FROM TMTask WHERE uuid='$ECHOT'")
  THEFT=$(lab_ssh "$IP" '~/labh/theft.sh '"$ECHOT" </dev/null 2>&1)
  note "T2 $THEFT"
  note "T2 stdout: $(lab_ssh "$IP" 'head -c 1200 ~/labh/theft-out.json' </dev/null)"
  note "T2 echo repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD1 echo' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
  note "T2 echo placement before=[$ECHO_AREA_BEFORE] after=[$(gq "SELECT ifnull(area,'-')||'|'||ifnull(startDate,'-')||'|'||start FROM TMTask WHERE uuid='$ECHOT'")] trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$ECHOT'")"
  note "T2 copies left: $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD1 echo' AND trashed=0")"
  cli ui-state --json > "$OUT/t2-after.json"
  note "T2 census after cleanup: $(cat "$OUT/t2-after.json")"

  # ============================================ C — the freeze, then the recovery
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "C4 freeze pair"' </dev/null >/dev/null
  dismiss
  add "FGRD1%20foxtrot"
  FOX=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD1 foxtrot' AND trashed=0 LIMIT 1")
  front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$FOX'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  F1=$(axq "tell application \"Things3\" to delete (to do id \"$FOX\")")
  note "C4a delete WITH a dialog open: [${F1//$'\n'/ }] trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$FOX'")"
  dismiss
  F2=$(axq "tell application \"Things3\" to delete (to do id \"$FOX\")")
  note "C4b the SAME delete once it is dismissed: [${F2//$'\n'/ }] trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$FOX'")"

  lab_ssh "$IP" '~/labh/beep-sentinel.sh assert --json ~/labh/beeps2.json --name fgrd1-2' </dev/null >"$OUT/beeps2.txt" 2>&1
  note "BEEPS2: $(tail -20 "$OUT/beeps2.txt")"
  note "CELLS2 done $(date +%H:%M:%S)"
  exit 0
fi

# =================================================================== cells3
# P — the rollback's PLACEMENT restore. The field report's original came back
# from a failed promote sitting in the Inbox with no schedule, because the only
# scriptable restore does exactly that (E15). The compound now puts the item
# back; this cell proves it on a to-do that HAS somewhere to go back to.
if [ "$CMD" = "cells3" ]; then
  load_session
  note "=============================================================="
  note "CELLS3 start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "P placement"' </dev/null >/dev/null

  AREA_TITLE=$(gq "SELECT title FROM TMArea LIMIT 1")
  note "P area fixture: [$AREA_TITLE]"
  lab_ssh "$IP" "open -g $(printf '%q' "things:///add?title=FGRD1%20golf&when=today&list=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$AREA_TITLE")"); sleep 3" </dev/null
  GOLF=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD1 golf' AND trashed=0 LIMIT 1")
  BEFORE=$(gq "SELECT ifnull(area,'-')||'|'||ifnull(startDate,'-')||'|'||start FROM TMTask WHERE uuid='$GOLF'")
  note "P golf=$GOLF placement before=[$BEFORE]"

  front Things3
  THEFT=$(lab_ssh "$IP" '~/labh/theft.sh '"$GOLF" </dev/null 2>&1)
  note "P $THEFT"
  note "P stdout: $(lab_ssh "$IP" 'head -c 1200 ~/labh/theft-out.json' </dev/null)"
  AFTER=$(gq "SELECT ifnull(area,'-')||'|'||ifnull(startDate,'-')||'|'||start FROM TMTask WHERE uuid='$GOLF'")
  note "P placement after=[$AFTER] trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$GOLF'")"
  note "P copies left: $(gq "SELECT count(*) FROM TMTask WHERE title='FGRD1 golf' AND trashed=0")"
  note "P VERDICT: $([ "$BEFORE" = "$AFTER" ] && echo "placement RESTORED byte-identical" || echo "placement DIVERGED before=[$BEFORE] after=[$AFTER]")"

  lab_ssh "$IP" '~/labh/beep-sentinel.sh assert --json ~/labh/beeps3.json --name fgrd1-3' </dev/null >"$OUT/beeps3.txt" 2>&1
  note "BEEPS3: $(tail -10 "$OUT/beeps3.txt")"
  note "CELLS3 done $(date +%H:%M:%S)"
  exit 0
fi

# =================================================================== cells4
# D — the relative-date comparator (#625) and the open-dialog PRECONDITION
# (MODALX1's #620 guard requirement). Both are corrections to code this campaign
# already certified, so they get their own pass on a fresh clone.
if [ "$CMD" = "cells4" ]; then
  load_session
  note "=============================================================="
  note "CELLS4 start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null

  dismiss() {
    front Things3
    lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null
    KIND=$(cli ui-state --json 2>/dev/null | python3 -c 'import sys,json; print(json.loads(sys.stdin.read().strip().splitlines()[-1])["data"]["state"]["sheetKind"])' 2>/dev/null)
    note "  dismiss → sheetKind=$KIND"
  }
  dismiss

  # ---- D: --when today / tomorrow / +7d / far (the #625 matrix) -------------
  # The guest clock is pinned to 2026-07-05, so "today" is that date.
  drive_when() {
    # drive_when <label> <title> <iso>
    lab_ssh "$IP" "~/labh/beep-sentinel.sh mark \"D $1\"" </dev/null >/dev/null
    lab_ssh "$IP" "open -g 'things:///add?title=FGRD1%20$2'; sleep 3" </dev/null
    local U
    U=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD1 $2' AND trashed=0 LIMIT 1")
    front Things3
    cli todo make-repeating "$U" --frequency weekly --interval 1 --when "$3" --dangerously-drive-gui --verify-timeout 90000 --json > "$OUT/d-$1.json" 2>"$OUT/d-$1.err"
    local CODE=$?
    local OK ICS
    OK=$(python3 -c 'import sys,json;d=json.load(open(sys.argv[1]));print(d.get("ok"))' "$OUT/d-$1.json" 2>/dev/null)
    ICS=$(gq "SELECT count(*) FROM TMTask WHERE title='FGRD1 $2' AND rt1_recurrenceRule IS NOT NULL")
    note "D $1 (--when $3): exit=$CODE ok=$OK template=$ICS"
    if [ "$OK" != "True" ]; then
      note "   detail: $(python3 -c 'import sys,json;d=json.load(open(sys.argv[1]));print(str(d.get("error",{}).get("message"))[:400])' "$OUT/d-$1.json" 2>/dev/null)"
    fi
    dismiss
  }
  drive_when today hotel 2026-07-05
  drive_when tomorrow india 2026-07-06
  drive_when plus7 juliett 2026-07-12
  drive_when far kilo 2026-09-22

  # What does the control actually RENDER for each of those? (The census the
  # comparator has to satisfy — measured, not assumed.)
  lab_ssh "$IP" "open -g 'things:///add?title=FGRD1%20lima'; sleep 3" </dev/null
  LIMA=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD1 lima' AND trashed=0 LIMIT 1")
  front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$LIMA'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  axq 'tell application "System Events" to tell process "Things3" to click pop up button 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")' >/dev/null
  sleep 1
  axq 'tell application "System Events" to tell process "Things3" to click menu item "weekly" of menu 1 of pop up button 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")' >/dev/null
  sleep 1
  RENDER=$(axq 'tell application "System Events" to tell process "Things3" to return name of every menu item of menu 1 of pop up button 2 of group 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")')
  note "D render: the Next pop-up offers → $(echo "$RENDER" | head -c 400)"
  esc
  dismiss

  # ---- P2: the open-dialog PRECONDITION ------------------------------------
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "P2 precondition"' </dev/null >/dev/null
  lab_ssh "$IP" "open -g 'things:///add?title=FGRD1%20mike'; sleep 3" </dev/null
  MIKE=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD1 mike' AND trashed=0 LIMIT 1")
  BEFORE_ROWS=$(gq "SELECT count(*) FROM TMTask WHERE title='FGRD1 mike'")
  front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$MIKE'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  cli todo make-repeating "$MIKE" --frequency daily --interval 2 --dangerously-drive-gui --verify-timeout 60000 --json > "$OUT/p2.json" 2>"$OUT/p2.err"
  note "P2 composite with a dialog standing: exit=$? out=$(head -c 700 "$OUT/p2.json")"
  note "P2 rows titled 'FGRD1 mike': before=$BEFORE_ROWS after=$(gq "SELECT count(*) FROM TMTask WHERE title='FGRD1 mike'") (expect NO copy minted)"
  note "P2 mike trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$MIKE'") (expect 0)"
  # The -1728 hint, on the same standing dialog.
  cli todo delete "$MIKE" --json > "$OUT/p2-delete.json" 2>&1
  note "P2 delete with the dialog standing: $(head -c 700 "$OUT/p2-delete.json")"
  dismiss
  cli todo delete "$MIKE" --json > "$OUT/p2-delete2.json" 2>&1
  note "P2 the SAME delete once dismissed: $(head -c 300 "$OUT/p2-delete2.json")"

  lab_ssh "$IP" '~/labh/beep-sentinel.sh assert --json ~/labh/beeps4.json --name fgrd1-4' </dev/null >"$OUT/beeps4.txt" 2>&1
  note "BEEPS4: $(tail -10 "$OUT/beeps4.txt")"
  note "CELLS4 done $(date +%H:%M:%S)"
  exit 0
fi

# =================================================================== cells5
# N — what the "Next:" control actually OFFERS and RENDERS for a same-day first
# occurrence. #625's fix moved the today case past the audit; this measures what
# is left, so the remaining failure is attributed rather than guessed at.
if [ "$CMD" = "cells5" ]; then
  load_session
  note "=============================================================="
  note "CELLS5 start $(date +%H:%M:%S)"
  SHEET='sheet 1 of (first window whose subrole is "AXStandardWindow")'
  lab_ssh "$IP" "open -g 'things:///add?title=FGRD1%20november'; sleep 3" </dev/null
  NOV=$(gq "SELECT uuid FROM TMTask WHERE title='FGRD1 november' AND trashed=0 LIMIT 1")
  front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$NOV'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  axq "tell application \"System Events\" to tell process \"Things3\" to click pop up button 1 of $SHEET" >/dev/null
  sleep 1
  axq "tell application \"System Events\" to tell process \"Things3\" to click menu item \"weekly\" of menu 1 of pop up button 1 of $SHEET" >/dev/null
  sleep 2
  note "N value of Next: [$(axq "tell application \"System Events\" to tell process \"Things3\" to return (value of pop up button 2 of group 1 of $SHEET) as text")]"
  note "N weekday pop-up: [$(axq "tell application \"System Events\" to tell process \"Things3\" to return (value of pop up button 3 of group 1 of $SHEET) as text")]"
  axq "tell application \"System Events\" to tell process \"Things3\" to click pop up button 2 of group 1 of $SHEET" >/dev/null
  sleep 1
  note "N menu offers: $(axq "tell application \"System Events\" to tell process \"Things3\" to return name of every menu item of menu 1 of pop up button 2 of group 1 of $SHEET" | head -c 400)"
  esc
  sleep 1
  esc
  note "N census: $(cli ui-state --json | tail -1 | head -c 200)"
  note "CELLS5 done $(date +%H:%M:%S)"
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 2
  tart delete "$VM" >/dev/null 2>&1 || true
  note "clone $VM stopped + deleted"
  exit 0
fi

echo "usage: research-fgrd1.sh {setup|ship|cells|teardown}" >&2
exit 2
