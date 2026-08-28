#!/bin/bash
# DRVLAT1 — UI-drive latency: profile the per-osascript hop budget of a
# `todo make-repeating … --after-completion --dangerously-drive-gui` drive, then
# certify the collapse that removes hops (issue #633).
#
# The field measurement being chased: a SUCCESSFUL 10-step make-repeating took
# 11,337ms on the maintainer's desktop (v0.19.3). The recipe compiles to 10
# STEPS but dispatches many more osascript HOPS — each step can pay a candidate-
# resolution probe, a focus-guard census, and the action itself.
#
# Phases (the clone survives between them; SESSION carries the IP):
#   setup      clone + boot + airgap + clock pin + warm-up + guest helpers
#   ship       push node + BOTH staged bundles (dist-old / dist-new) + ui-enabled
#   shipnew    re-push ONLY dist-new (after the optimization is built)
#   profile    TAG=old|new — drive the field command shape with the trace on,
#              pull the JSONL, print the per-hop table
#   cells      the FGRD1/FGRD2 guard cells re-run on the NEW bundle
#   chord      one #606-family chord op cell (shared-primitive regression)
#   teardown   stop + delete the clone
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (trial wall
# 2026-07-18). Fixtures fully synthetic (DRVLAT1-*). Beep sentinel default-on.
# Both lab escapes exported. In a clone the escapes run osascript DIRECT — the
# deputy IPC adder the field pays per hop is NOT measurable here.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-drvlat1}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/drive" "$OUT/trace"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — well inside the trial wall (2026-07-18)
STAGE="${STAGE:-/private/tmp/claude-503/-Volumes-Workspace-Projects-things-api/47c2c59d-13f5-4a26-a415-b9c5b748c288/scratchpad/drvlat1-bundles}"
note() { echo "[drvlat1] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
front() { lab_ssh "$IP" "osascript -e 'tell application \"$1\" to activate'; sleep 1" </dev/null; }
add() { lab_ssh "$IP" "open -g $(printf '%q' "things:///add?title=$1"); sleep 2" </dev/null; }

OLDCLI='~/things-lab/bin/node ~/things-lab/dist-old/cli/main.js'
NEWCLI='~/things-lab/bin/node ~/things-lab/dist-new/cli/main.js'

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

  GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
  note "AX grant=$GRANT (want 2)"; [ "$GRANT" = "2" ] || { note "FATAL: AX grant"; exit 1; }

  lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"
  lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null

  note "warm-up launch/quit/relaunch"
  lab_ssh "$IP" 'open -g -a Things3; sleep 25; osascript -e "tell application \"Things3\" to quit"; sleep 5; open -g -a Things3; sleep 20' </dev/null

  echo "IP=$IP" > "$SESSION"
  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'")
  note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / dbv $DBV / golden $GOLDEN"
  note "setup complete"
  exit 0
fi

# ===================================================================== ship
if [ "$CMD" = "ship" ] || [ "$CMD" = "shipnew" ]; then
  load_session
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  MAIN_WT=$(dirname "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null || true)
  NODE_MODULES_DIR="$(pwd)/node_modules"; [ -d "$NODE_MODULES_DIR/commander" ] || NODE_MODULES_DIR="$MAIN_WT/node_modules"
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }

  if [ "$CMD" = "ship" ]; then
    [ -f "$STAGE/dist-old/cli/main.js" ] || { note "FATAL: staged OLD bundle missing at $STAGE/dist-old"; exit 1; }
    lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/node_modules' </dev/null
    scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
    lab_ssh "$IP" 'rm -rf ~/things-lab/dist-old' </dev/null
    scpO -r "$STAGE/dist-old" "admin@$IP:/Users/admin/things-lab/dist-old" >/dev/null
    scpO -r "$NODE_MODULES_DIR/commander" "admin@$IP:/Users/admin/things-lab/node_modules/commander" >/dev/null
    scpO package.json "admin@$IP:/Users/admin/things-lab/package.json" >/dev/null
    lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
    lab_ssh "$IP" "$OLDCLI config set ui-enabled true" </dev/null >/dev/null
    note "OLD bundle shipped; ui-enabled true; guest CLI $(lab_ssh "$IP" "$OLDCLI --version 2>&1 | tail -1" </dev/null)"
  fi
  if [ -d "$STAGE/dist-new" ]; then
    lab_ssh "$IP" 'rm -rf ~/things-lab/dist-new' </dev/null
    scpO -r "$STAGE/dist-new" "admin@$IP:/Users/admin/things-lab/dist-new" >/dev/null
    note "NEW bundle shipped; guest CLI $(lab_ssh "$IP" "$NEWCLI --version 2>&1 | tail -1" </dev/null)"
  else
    note "no staged NEW bundle at $STAGE/dist-new (skipped)"
  fi
  exit 0
fi

# =================================================================== profile
# THE PROFILE. Drives the FIELD's exact command shape with the per-osascript
# trace on and prints every hop in dispatch order, plus the gaps between hops
# (the fixed settles) and the post-drive verify.
if [ "$CMD" = "profile" ]; then
  load_session
  TAG="${TAG:-old}"
  case "$TAG" in old) CLI="$OLDCLI"; DIST=dist-old ;; new) CLI="$NEWCLI"; DIST=dist-new ;; *) echo "TAG must be old|new" >&2; exit 1 ;; esac
  REPS="${REPS:-2}"
  note "=============================================================="
  note "PROFILE $TAG start $(date +%H:%M:%S)  reps=$REPS"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null

  warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -g -a Things3; sleep 14' </dev/null; }
  settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3' </dev/null; }

  for rep in $(seq 1 "$REPS"); do
    T="DRVLAT1%20$TAG%20r$rep"
    TITLE="DRVLAT1 $TAG r$rep"
    lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'profile $TAG r$rep'" </dev/null >/dev/null
    add "$T"
    U=$(gq "SELECT uuid FROM TMTask WHERE title='$TITLE' AND type=0 AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1")
    [ -n "$U" ] || { note "  rep$rep FATAL: no seed uuid"; continue; }
    warm
    front Things3
    lab_ssh "$IP" "rm -rf ~/.local/state/things-api/trace" </dev/null
    lab_ssh "$IP" "THINGS_API_TRACE=true $LAB_DIRECT $CLI todo make-repeating $U --frequency monthly --interval 1 --after-completion --dangerously-drive-gui --json" \
      </dev/null >"$OUT/drive/$TAG-r$rep.log" 2>&1
    note "  rep$rep verdict: $(grep -o '"ok":[a-z]*\|"status":"[a-z-]*"\|"error"' "$OUT/drive/$TAG-r$rep.log" | head -3 | tr '\n' ' ')"
    settle
    TPL=$(gq "SELECT uuid FROM TMTask WHERE title='$TITLE' AND rt1_recurrenceRule IS NOT NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1")
    note "  rep$rep template=$TPL rule=$(gq "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE uuid='$TPL'")"
    TF=$(lab_ssh "$IP" 'cd ~/.local/state/things-api/trace 2>/dev/null && ls -t | head -1' </dev/null | tr -d '\r\n')
    if [ -n "$TF" ]; then
      lab_ssh "$IP" "cat ~/.local/state/things-api/trace/$(printf '%q' "$TF")" </dev/null > "$OUT/trace/$TAG-r$rep.jsonl" 2>/dev/null
      node lab/scripts/drvlat1-table.mjs "$OUT/trace/$TAG-r$rep.jsonl" "$TAG r$rep" | tee -a "$REPORT"
    else
      note "  rep$rep NO trace file"
    fi
  done
  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-$TAG.json --name drvlat1-$TAG" </dev/null >"$OUT/beeps-$TAG.txt" 2>&1
  note "BEEPS($TAG): $(tail -6 "$OUT/beeps-$TAG.txt" | tr '\n' ' ')"
  note "PROFILE $TAG done $(date +%H:%M:%S)"
  exit 0
fi

# ===================================================================== cells
# The FGRD1/FGRD2 guard-cell set, re-run against whichever bundle TAG names.
# Every cell below is a GUARD SEMANTIC that the collapse must not weaken.
if [ "$CMD" = "cells" ]; then
  load_session
  TAG="${TAG:-new}"
  case "$TAG" in old) CLI="$OLDCLI" ;; new) CLI="$NEWCLI" ;; *) echo "TAG must be old|new" >&2; exit 1 ;; esac
  cli() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*" </dev/null; }
  note "=============================================================="
  note "CELLS ($TAG) start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null

  dismiss() {
    front Things3
    lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null
    note "  dismiss → $(cli ui-state --json 2>/dev/null | tail -1 | head -c 200)"
  }
  warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -g -a Things3; sleep 14' </dev/null; }

  P="DRVLAT1C-$TAG"
  add "${P}%20alpha"; add "${P}%20bravo"; add "${P}%20charlie"; add "${P}%20delta"
  ALPHA=$(gq "SELECT uuid FROM TMTask WHERE title='$P alpha' AND trashed=0 LIMIT 1")
  BRAVO=$(gq "SELECT uuid FROM TMTask WHERE title='$P bravo' AND trashed=0 LIMIT 1")
  CHARLIE=$(gq "SELECT uuid FROM TMTask WHERE title='$P charlie' AND trashed=0 LIMIT 1")
  DELTA=$(gq "SELECT uuid FROM TMTask WHERE title='$P delta' AND trashed=0 LIMIT 1")
  note "fixtures: alpha=$ALPHA bravo=$BRAVO charlie=$CHARLIE delta=$DELTA"

  # ---------------- U: the ui-state census 2x2 (FGRD1 U1..U4, FGRD2 U) --------
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "U ui-state"' </dev/null >/dev/null
  warm; front Things3
  note "U1 (no dialog, Things frontmost): $(cli ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  front Finder
  note "U2 (no dialog, Finder frontmost): $(cli ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$ALPHA'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  note "U3 (Repeat dialog open, Things frontmost): $(cli ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  front Finder
  note "U4 (Repeat dialog open, Finder frontmost): $(cli ui-state --json 2>/dev/null | tail -1 | head -c 300)"

  # -------- C: the stranded-dialog cleanup ladder (FGRD1 C2) ------------------
  # The dialog from U3/U4 is STILL OPEN and Finder owns the screen. A drive that
  # starts now must refuse/clean up, and nothing may be committed.
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "C cleanup"' </dev/null >/dev/null
  cli todo make-repeating "$BRAVO" --frequency weekly --interval 2 --dangerously-drive-gui --verify-timeout 60000 --json >"$OUT/c2-$TAG.json" 2>"$OUT/c2-$TAG.err"
  note "C2 exit=$? stdout: $(head -c 500 "$OUT/c2-$TAG.json")"
  note "C2 stderr: $(head -c 700 "$OUT/c2-$TAG.err")"
  note "C2 census after: $(cli ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  note "C2 bravo repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='$P bravo' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
  dismiss

  # -------- S: the already-set skip discloses and types nothing (FGRD1 S) -----
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "S skip"' </dev/null >/dev/null
  warm; front Things3
  cli todo make-repeating "$ALPHA" --frequency daily --interval 1 --after-completion --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/s1-$TAG.json" 2>"$OUT/s1-$TAG.err"
  note "S1 exit=$? out: $(head -c 700 "$OUT/s1-$TAG.json")"
  note "S1 template? $(gq "SELECT count(*) FROM TMTask WHERE title='$P alpha' AND rt1_recurrenceRule IS NOT NULL") (expect 1)"
  dismiss

  # -------- T: focus theft mid-drive REFUSES with nothing typed (FGRD1 T) -----
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "T theft"' </dev/null >/dev/null
  lab_ssh "$IP" 'cat > ~/labh/theft.sh && chmod +x ~/labh/theft.sh' <<EOF
#!/bin/bash
# Start a drive that MUST type (interval 3 is not the default, so the
# read-back-first skip cannot apply), then steal focus the instant the Repeat
# dialog appears — a closed loop on the dialog's existence, never a sleep.
CLI="\$HOME/things-lab/bin/node \$HOME/things-lab/$( [ "$TAG" = new ] && echo dist-new || echo dist-old )/cli/main.js"
export THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1
\$CLI todo make-repeating "\$1" --frequency weekly --interval 3 --dangerously-drive-gui \\
  --verify-timeout 60000 --json >"\$HOME/labh/theft-out.json" 2>"\$HOME/labh/theft-err.txt" &
DRIVE=\$!
SAW=no
for _ in \$(seq 1 400); do
  OPEN=\$(osascript -e 'tell application "System Events" to tell process "Things3" to return ((exists sheet 1 of (first window whose subrole is "AXStandardWindow")) or ((count of (windows whose subrole is "AXUnknown" and size is not {40, 40})) > 0))' 2>/dev/null)
  if [ "\$OPEN" = "true" ]; then SAW=yes; break; fi
  sleep 0.1
done
osascript -e 'tell application "Finder" to activate' >/dev/null 2>&1
echo "sheet-seen=\$SAW"
wait \$DRIVE
echo "drive-exit=\$?"
EOF
  warm; front Things3
  note "T1 $(lab_ssh "$IP" "~/labh/theft.sh $CHARLIE" </dev/null 2>&1 | tr '\n' ' ')"
  note "T1 stdout: $(lab_ssh "$IP" 'head -c 900 ~/labh/theft-out.json' </dev/null)"
  note "T1 stderr: $(lab_ssh "$IP" 'head -c 900 ~/labh/theft-err.txt' </dev/null)"
  note "T1 charlie repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='$P charlie' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
  note "T1 census after: $(cli ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  dismiss

  # -------- X: the open-dialog PREFLIGHT refusal (MODALX1 / #620) -------------
  # A dialog standing BEFORE a drive starts must refuse with nothing pressed.
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "X preflight"' </dev/null >/dev/null
  warm; front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$DELTA'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  cli todo make-repeating "$DELTA" --frequency weekly --interval 2 --dangerously-drive-gui --verify-timeout 60000 --json >"$OUT/x1-$TAG.json" 2>"$OUT/x1-$TAG.err"
  note "X1 exit=$? stderr: $(head -c 600 "$OUT/x1-$TAG.err")"
  note "X1 delta repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='$P delta' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
  dismiss

  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-cells-$TAG.json --name drvlat1-cells-$TAG" </dev/null >"$OUT/beeps-cells-$TAG.txt" 2>&1
  note "BEEPS(cells $TAG): $(tail -8 "$OUT/beeps-cells-$TAG.txt" | tr '\n' ' ')"
  note "CELLS ($TAG) done $(date +%H:%M:%S)"
  exit 0
fi

# ===================================================================== chord
# One chord-op cell (#606 family): the heading-reorder chord runs through the
# SAME dispatch seam and the same guard classification, so a shared-primitive
# change has to be shown not to have touched it.
if [ "$CMD" = "chord" ]; then
  load_session
  TAG="${TAG:-new}"
  case "$TAG" in old) CLI="$OLDCLI" ;; new) CLI="$NEWCLI" ;; esac
  cli() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*" </dev/null; }
  note "=============================================================="
  note "CHORD ($TAG) start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "chord reorder"' </dev/null >/dev/null

  PRJ="DRVLAT1 chord $TAG"
  cli project add "'$PRJ'" --json >"$OUT/chord-proj-$TAG.json" 2>&1
  PU=$(gq "SELECT uuid FROM TMTask WHERE title='$PRJ' AND type=1 AND trashed=0 LIMIT 1")
  note "  project=$PU"
  for h in Alpha Bravo Charlie; do
    cli project add-heading "$PU" "'$h'" --json >"$OUT/chord-head-$h-$TAG.json" 2>&1
  done
  note "  headings before: $(gq "SELECT group_concat(title,' | ') FROM (SELECT title FROM TMTask WHERE project='$PU' AND type=2 AND trashed=0 ORDER BY \"index\")")"
  cli project move-heading "$PU" "'Charlie'" --first --dangerously-drive-gui --json >"$OUT/chord-$TAG.json" 2>&1
  note "  move exit=$? out: $(head -c 500 "$OUT/chord-$TAG.json")"
  note "  headings after: $(gq "SELECT group_concat(title,' | ') FROM (SELECT title FROM TMTask WHERE project='$PU' AND type=2 AND trashed=0 ORDER BY \"index\")")"

  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-chord-$TAG.json --name drvlat1-chord-$TAG" </dev/null >"$OUT/beeps-chord-$TAG.txt" 2>&1
  note "BEEPS(chord $TAG): $(tail -6 "$OUT/beeps-chord-$TAG.txt" | tr '\n' ' ')"
  note "CHORD ($TAG) done $(date +%H:%M:%S)"
  exit 0
fi

# =================================================================== bgpress
# THE ACTIVATION MEASUREMENT (issue #633 item 3). The preamble's `activate` step
# is labelled "skipped once background press is certified" — so certify it, or
# keep it on evidence. The question is NOT whether AXPress works backgrounded
# (HEADORD1 1h already says element-addressed presses do); it is whether the
# WHOLE Repeat-dialog drive does, keystrokes included, since the numeric fields
# ride System Events `keystroke`, which is delivered to whatever owns the screen.
#
# Every rung below runs with FINDER frontmost and Things in the background, and
# each one reports what it observed rather than what it expected.
if [ "$CMD" = "bgpress" ]; then
  load_session
  note "=============================================================="
  note "BGPRESS start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "bgpress"' </dev/null >/dev/null

  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -g -a Things3; sleep 14' </dev/null
  add "DRVLAT1%20bg%20seed"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='DRVLAT1 bg seed' AND type=0 AND trashed=0 LIMIT 1")
  note "  seed=$U"

  # Reveal WITHOUT foregrounding (open -g), then hand the screen to Finder.
  lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 2; osascript -e 'tell application \"Finder\" to activate'; sleep 2" </dev/null
  note "  R0 frontmost = $(axq 'tell application "System Events" to return name of first application process whose frontmost is true')"

  # R1 — the eligibility assertion + the menu press, both element-addressed.
  note "  R1 selected = $(axq 'tell application "Things3" to return id of selected to dos')"
  note "  R1 menu enabled = $(axq 'tell application "System Events" to tell process "Things3" to return enabled of menu item "Repeat…" of menu "Items" of menu bar 1')"
  note "  R1 press = $(axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1')"
  sleep 2
  note "  R2 frontmost after press = $(axq 'tell application "System Events" to return name of first application process whose frontmost is true')"
  note "  R2 attached sheet = $(axq 'tell application "System Events" to tell process "Things3" to return (exists sheet 1 of (first window whose subrole is "AXStandardWindow"))')"
  note "  R2 detached window = $(axq 'tell application "System Events" to tell process "Things3" to return (count of (windows whose subrole is "AXUnknown" and size is not {40, 40}))')"

  # R3 — an element-addressed pop-up selection while backgrounded.
  note "  R3 popup open+pick = $(axq 'tell application "System Events" to tell process "Things3"
  set pu to (pop up button 1 of (first window whose subrole is "AXUnknown" and size is not {40, 40}))
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.05
  end repeat
  click menu item "after completion" of menu 1 of pu
  delay 0.5
  return (value of pu) as text
end tell')"

  # R4 — the KEYSTROKE half: focus the interval field and type into it with
  # Finder owning the screen. This is the rung the activation step exists for.
  note "  R4 type-into-field = $(axq 'tell application "System Events" to tell process "Things3"
  set g to (group 1 of (first window whose subrole is "AXUnknown" and size is not {40, 40}))
  set tf to text field 1 of g
  set wasValue to (value of tf) as text
  set focused of tf to true
  delay 0.2
  set gotFocus to false
  try
    set gotFocus to (focused of tf) as boolean
  end try
  keystroke "7"
  delay 0.3
  key code 48
  delay 0.3
  return "before=" & wasValue & " focused=" & gotFocus & " after=" & ((value of tf) as text)
end tell')"
  note "  R4 frontmost during type = $(axq 'tell application "System Events" to return name of first application process whose frontmost is true')"

  # R5 — clean up: cancel the dialog, still backgrounded.
  note "  R5 cancel = $(axq 'tell application "System Events" to tell process "Things3" to click button "Cancel" of (first window whose subrole is "AXUnknown" and size is not {40, 40})')"
  sleep 3
  note "  R5 dialog gone = $(axq 'tell application "System Events" to tell process "Things3" to return (count of (windows whose subrole is "AXUnknown" and size is not {40, 40}))')"
  note "  R5 seed still non-repeating? $(gq "SELECT count(*) FROM TMTask WHERE uuid='$U' AND rt1_recurrenceRule IS NULL") (expect 1)"

  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-bg.json --name drvlat1-bgpress" </dev/null >"$OUT/beeps-bg.txt" 2>&1
  note "BEEPS(bgpress): $(tail -6 "$OUT/beeps-bg.txt" | tr '\n' ' ')"
  note "BGPRESS done $(date +%H:%M:%S)"
  exit 0
fi

# ================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  rm -f "$SESSION"
  note "teardown complete — $VM stopped and deleted"
  exit 0
fi

echo "usage: [VM=… TAG=old|new REPS=N] bash lab/scripts/research-drvlat1.sh <setup|ship|shipnew|profile|cells|chord|bgpress|teardown>" >&2
exit 2
