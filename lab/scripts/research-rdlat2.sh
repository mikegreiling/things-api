#!/bin/bash
# RDLAT2 — the Repeat dialog's latency, in AX ROUND-TRIPS rather than seconds.
#
# DRVLAT1 (#633) cut the HOP count 20 → 15 and removed the fixed post-preamble
# settle, and the lab drive went 5.5s → 3.7s. The field did not follow: on the
# maintainer's M1 the same command still ran ~11s, because the field's cost is
# not the hop count — it is the number of ACCESSIBILITY ROUND-TRIPS each hop
# makes. Measured 2026-09-02 on that machine: ~20ms per AX call against ~1.7ms
# in a clone. A hop that asks the tree 30 questions costs 50ms here and 600ms
# there.
#
# So this campaign counts calls, not hops. Phases:
#   setup       clone + boot + airgap + clock pin + warm-up + guest helpers
#   ship        push node + BOTH staged bundles (dist-old / dist-new) + ui-enabled
#   shipnew     re-push ONLY dist-new (after the optimization is built)
#   micro       the COST-MODEL calibration: osascript spawn cost, per-Apple-event
#               cost against the live Repeat dialog, per-raw-AX-call cost through
#               the ObjC bridge, and the plural-vs-singular property read
#   aecount     TAG=old|new — exact Apple-event counts per hop, from the drive's
#               own stderr under AEDebugSends
#   profile     TAG=old|new — the field's command shape, traced, per-hop table
#   states      TAG=old|new — the STATE MATRIX certification (fixed rule,
#               after-completion, deadlines incl. the #646 shape, ends-count,
#               paused) end to end through the production CLI
#   cells       the DRVLAT1/FGRD guard cells re-run (U/C2/S/T/X)
#   chord       one #606-family chord op (shared dispatch seam regression)
#   teardown    stop + delete the clone
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (trial wall
# 2026-07-18). Fixtures fully synthetic (RDLAT2-*). Beep sentinel default-on.
# Both lab escapes exported.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-rdlat2}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/drive" "$OUT/trace" "$OUT/ae"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — well inside the trial wall (2026-07-18)
STAGE="${STAGE:-/private/tmp/claude-503/-Volumes-Workspace-Projects-things-api/47c2c59d-13f5-4a26-a415-b9c5b748c288/scratchpad/rdlat2-bundles}"
note() { echo "[rdlat2] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
front() { lab_ssh "$IP" "osascript -e 'tell application \"$1\" to activate'; sleep 1" </dev/null; }
add() { lab_ssh "$IP" "open -g $(printf '%q' "things:///add?title=$1"); sleep 2" </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -g -a Things3; sleep 14' </dev/null; }
settle_quit() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3' </dev/null; }
dismiss() {
  front Things3
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null
}

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
  lab_scp lab/scripts/rdlat2-micro.sh "admin@$IP:/Users/admin/labh/rdlat2-micro.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh ~/labh/rdlat2-micro.sh' </dev/null

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

# ===================================================================== micro
# THE COST MODEL'S CALIBRATION. Everything the model needs that a trace cannot
# say: what one osascript process costs before it does anything, what ONE
# Apple event to System Events costs against the live Repeat dialog, what one
# RAW AX call costs through the ObjC bridge (the unit the field measured), and
# how much a PLURAL property read saves over the singular loop it replaces.
if [ "$CMD" = "micro" ]; then
  load_session
  note "=============================================================="
  note "MICRO start $(date +%H:%M:%S)"
  warm; front Things3
  add "RDLAT2%20micro%20seed"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='RDLAT2 micro seed' AND type=0 AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  note "  dialog open? $(axq 'tell application "System Events" to tell process "Things3" to return (exists sheet 1 of (first window whose subrole is "AXStandardWindow"))')"
  lab_ssh "$IP" '~/labh/rdlat2-micro.sh' </dev/null 2>&1 | tee -a "$REPORT"
  dismiss
  note "MICRO done $(date +%H:%M:%S)"
  exit 0
fi

# ==================================================================== micro2
# The SECOND calibration pass: where inside ONE addressed read the time goes.
# Run against the dialog in its WIDEST cadence state (a fixed monthly rule), so
# the plural-vs-singular question is asked where it actually matters.
if [ "$CMD" = "micro2" ]; then
  load_session
  note "=============================================================="
  note "MICRO2 start $(date +%H:%M:%S)"
  lab_scp lab/scripts/rdlat2-micro2.sh "admin@$IP:/Users/admin/labh/rdlat2-micro2.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/labh/rdlat2-micro2.sh' </dev/null
  warm; front Things3
  add "RDLAT2%20micro2%20seed"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='RDLAT2 micro2 seed' AND type=0 AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  # Drive the frequency to monthly so the cadence group is at its widest.
  axq 'tell application "System Events" to tell process "Things3"
  set pu to (pop up button 1 of (sheet 1 of (first window whose subrole is "AXStandardWindow")))
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.05
  end repeat
  click menu item "monthly" of menu 1 of pu
  delay 0.6
  return (value of pu) as text
end tell' | tail -1 | sed 's/^/[rdlat2]   frequency now: /' | tee -a "$REPORT"
  lab_ssh "$IP" '~/labh/rdlat2-micro2.sh' </dev/null 2>&1 | tee -a "$REPORT"
  dismiss
  note "MICRO2 done $(date +%H:%M:%S)"
  exit 0
fi

# =================================================================== profile
# THE PROFILE. Drives the FIELD's exact command shape with the per-osascript
# trace on and prints every hop in dispatch order, its duration, and — on the
# new bundle — the AX round-trips the hop's own script counted.
if [ "$CMD" = "profile" ]; then
  load_session
  TAG="${TAG:-old}"
  case "$TAG" in old) CLI="$OLDCLI" ;; new) CLI="$NEWCLI" ;; *) echo "TAG must be old|new" >&2; exit 1 ;; esac
  REPS="${REPS:-3}"
  # The field's exact command shape by default; SHAPE=monthly drives the WIDE
  # cadence group (a fixed monthly rule) where the per-read savings are largest.
  DRIVECMD="todo make-repeating"
  case "${SHAPE:-field}" in
    field) DRIVEARGS="--frequency monthly --interval 1 --after-completion" ;;
    monthly) DRIVEARGS="--frequency monthly --interval 3" ;;
    *) echo "SHAPE must be field|monthly" >&2; exit 1 ;;
  esac
  AXENV=""; [ "${AXCOUNT:-1}" = "1" ] && AXENV="THINGS_API_AX_COUNT=1"
  note "=============================================================="
  note "PROFILE $TAG start $(date +%H:%M:%S)  reps=$REPS shape=${SHAPE:-field} axcount=${AXCOUNT:-1} ($DRIVEARGS)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null

  for rep in $(seq 1 "$REPS"); do
    T="RDLAT2%20$TAG%20${SHAPE:-field}%20r$rep"
    TITLE="RDLAT2 $TAG ${SHAPE:-field} r$rep"
    lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'profile $TAG r$rep'" </dev/null >/dev/null
    add "$T"
    U=$(gq "SELECT uuid FROM TMTask WHERE title='$TITLE' AND type=0 AND rt1_recurrenceRule IS NULL AND trashed=0 ORDER BY rowid DESC LIMIT 1")
    [ -n "$U" ] || { note "  rep$rep FATAL: no seed uuid"; continue; }
    warm
    front Things3
    lab_ssh "$IP" "rm -rf ~/.local/state/things-api/trace" </dev/null
    # AXCOUNT=1 counts every Apple event (AEDebugSends) — exact, but the logging
    # itself inflates each hop's wall time, so the two questions are asked in
    # separate passes: AXCOUNT=1 for round-trips, AXCOUNT=0 for honest timings.
    lab_ssh "$IP" "THINGS_API_TRACE=true ${AXENV} $LAB_DIRECT $CLI $DRIVECMD $U ${DRIVEARGS:---frequency monthly --interval 1 --after-completion} --dangerously-drive-gui --json" \
      </dev/null >"$OUT/drive/$TAG-r$rep.log" 2>&1
    note "  rep$rep verdict: $(grep -o '"ok":[a-z]*\|"status":"[a-z-]*"\|"error"' "$OUT/drive/$TAG-r$rep.log" | head -3 | tr '\n' ' ')"
    settle_quit
    TPL=$(gq "SELECT uuid FROM TMTask WHERE title='$TITLE' AND rt1_recurrenceRule IS NOT NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 ORDER BY rowid DESC LIMIT 1")
    note "  rep$rep template=$TPL rule=$(gq "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE uuid='$TPL'")"
    TF=$(lab_ssh "$IP" 'cd ~/.local/state/things-api/trace 2>/dev/null && ls -t | head -1' </dev/null | tr -d '\r\n')
    if [ -n "$TF" ]; then
      lab_ssh "$IP" "cat ~/.local/state/things-api/trace/$(printf '%q' "$TF")" </dev/null > "$OUT/trace/$TAG-r$rep.jsonl" 2>/dev/null
      node lab/scripts/rdlat2-table.mjs "$OUT/trace/$TAG-r$rep.jsonl" "$TAG r$rep" | tee -a "$REPORT"
    else
      note "  rep$rep NO trace file"
    fi
  done
  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-$TAG.json --name rdlat2-$TAG" </dev/null >"$OUT/beeps-$TAG.txt" 2>&1
  note "BEEPS($TAG): $(tail -6 "$OUT/beeps-$TAG.txt" | tr '\n' ' ')"
  note "PROFILE $TAG done $(date +%H:%M:%S)"
  exit 0
fi

# =================================================================== aeprobe
# Does AEDebugSends actually give an exact Apple-event count on this OS? The
# whole `axOps` trace column rests on it, so it is proven before it is used:
# a script whose event count is KNOWN by construction is run under the flag and
# the logged lines are counted against it.
if [ "$CMD" = "aeprobe" ]; then
  load_session
  note "=============================================================="
  note "AEPROBE start $(date +%H:%M:%S)"
  for n in 1 5 20; do
    OUT_N=$(lab_ssh "$IP" "AEDebugSends=1 osascript -e 'tell application \"System Events\" to tell process \"Things3\"
  repeat $n times
    set c to (count of windows)
  end repeat
  return c
end tell' 2>&1 | grep -c 'AEDebugSends\|{ 1 }\|aevt\|core' " </dev/null)
    note "  n=$n → matched debug lines: $OUT_N"
  done
  warm; front Things3
  lab_ssh "$IP" "AEDebugSends=1 osascript -e 'tell application \"System Events\" to tell process \"Things3\"
  repeat 4 times
    set c to (count of windows)
  end repeat
  return c
end tell' >/tmp/ae-out.txt 2>/tmp/ae-err.txt; echo done" </dev/null >/dev/null
  note "  SPLIT STREAMS (4 events expected): stdout lines=$(lab_ssh "$IP" 'wc -l </tmp/ae-out.txt' </dev/null | tr -d ' ') stderr lines=$(lab_ssh "$IP" 'wc -l </tmp/ae-err.txt' </dev/null | tr -d ' ')"
  note "  stdout: $(lab_ssh "$IP" 'head -c 250 /tmp/ae-out.txt' </dev/null)"
  note "  stderr: $(lab_ssh "$IP" 'head -c 250 /tmp/ae-err.txt' </dev/null)"
  note "  which STREAM carries the debug lines (stdout must stay clean — the driver parses it):"
  note "    stdout only: $(lab_ssh "$IP" "AEDebugSends=1 osascript -e 'tell application \"System Events\" to tell process \"Things3\" to return (count of windows)' 2>/dev/null | head -c 300" </dev/null)"
  note "    stderr only: $(lab_ssh "$IP" "AEDebugSends=1 osascript -e 'tell application \"System Events\" to tell process \"Things3\" to return (count of windows)' 2>&1 1>/dev/null | head -c 300" </dev/null)"
  note "  same, inherited from a NODE parent (the shipped shape):"
  note "    $(lab_ssh "$IP" "AEDebugSends=1 ~/things-lab/bin/node -e \"const {execFileSync}=require('child_process'); const o=execFileSync('osascript',['-e','tell application \\\"System Events\\\" to tell process \\\"Things3\\\" to return (count of windows)'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}); console.log('STDOUT<'+o.trim()+'>')\" 2>&1 | head -c 400" </dev/null)"
  note "AEPROBE done $(date +%H:%M:%S)"
  exit 0
fi

# =================================================================== aecount
# EXACT Apple-event counts per drive, from AEDebugSends. Every osascript the
# drive spawns logs one line per event it SENDS; the drive is run with the
# variable exported, its combined stderr captured, and the events tallied. The
# drive's own stderr parsing is unaffected because the tally is read from the
# captured file, not from the process's structured output.
if [ "$CMD" = "aecount" ]; then
  load_session
  TAG="${TAG:-old}"
  case "$TAG" in old) CLI="$OLDCLI" ;; new) CLI="$NEWCLI" ;; *) echo "TAG must be old|new" >&2; exit 1 ;; esac
  note "=============================================================="
  note "AECOUNT $TAG start $(date +%H:%M:%S)"
  T="RDLAT2%20ae%20$TAG"; TITLE="RDLAT2 ae $TAG"
  add "$T"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='$TITLE' AND type=0 AND rt1_recurrenceRule IS NULL AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  warm; front Things3
  lab_ssh "$IP" "AEDebugSends=1 THINGS_API_TRACE=true $LAB_DIRECT $CLI todo make-repeating $U --frequency monthly --interval 1 --after-completion --dangerously-drive-gui --json" \
    </dev/null >"$OUT/ae/$TAG.log" 2>"$OUT/ae/$TAG.err"
  note "  exit=$? events=$(grep -c '^{ 1 } ' "$OUT/ae/$TAG.err" 2>/dev/null || echo '?')"
  note "  event classes: $(grep -oE "'[a-zA-Z0-9]{4}'\\\\'[a-zA-Z0-9]{4}'" "$OUT/ae/$TAG.err" 2>/dev/null | sort | uniq -c | sort -rn | head -8 | tr '\n' ' ')"
  note "  raw stderr head: $(head -c 400 "$OUT/ae/$TAG.err")"
  settle_quit
  note "AECOUNT $TAG done $(date +%H:%M:%S)"
  exit 0
fi

# ==================================================================== states
# THE STATE MATRIX. Every dialog STATE the shape manifest has to describe,
# driven end to end through the production CLI, verified against the guest
# SQLite oracle. A manifest that is wrong about a state shows up here as a
# refusal (fail-closed) or a wrong rule — never as a silent pass.
if [ "$CMD" = "states" ]; then
  load_session
  TAG="${TAG:-new}"
  case "$TAG" in old) CLI="$OLDCLI" ;; new) CLI="$NEWCLI" ;; esac
  cli() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*" </dev/null; }
  note "=============================================================="
  note "STATES ($TAG) start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  P="RDLAT2S-$TAG"

  seed() { add "${P}%20$1"; gq "SELECT uuid FROM TMTask WHERE title='$P $1' AND type=0 AND rt1_recurrenceRule IS NULL AND trashed=0 ORDER BY rowid DESC LIMIT 1"; }
  tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$P $1' AND rt1_recurrenceRule IS NOT NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
  rule() { gq "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'"; }

  # (1) FIXED rule — monthly, interval 2. Exercises the "Every" label row with
  #     the four-static-text monthly cadence group.
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "S1 fixed"' </dev/null >/dev/null
  warm; front Things3
  S1=$(seed s1); note "  S1 seed=$S1"
  cli todo make-repeating "$S1" --frequency monthly --interval 2 --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/st1-$TAG.json" 2>&1
  note "  S1 exit=$? out: $(head -c 400 "$OUT/st1-$TAG.json")"
  note "  S1 rule: $(rule "$(tmpl s1)")"
  dismiss

  # (2) AFTER COMPLETION — the one-static-text, one-field cadence group that
  #     falls through the label rules to the uniqueness check (CGRD1 §A law 2).
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "S2 after-completion"' </dev/null >/dev/null
  warm; front Things3
  S2=$(seed s2); note "  S2 seed=$S2"
  cli todo make-repeating "$S2" --frequency weekly --interval 3 --after-completion --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/st2-$TAG.json" 2>&1
  note "  S2 exit=$? out: $(head -c 400 "$OUT/st2-$TAG.json")"
  note "  S2 rule: $(rule "$(tmpl s2)")"
  dismiss

  # (3) DEADLINES TICKED — the #646 shape: ticking "Add deadlines" reveals the
  #     "and start N days earlier" field as a DIRECT child of the shell.
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "S3 deadlines"' </dev/null >/dev/null
  warm; front Things3
  S3=$(seed s3); note "  S3 seed=$S3"
  cli todo make-repeating "$S3" --frequency weekly --interval 1 --deadline --start-days-earlier 2 --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/st3-$TAG.json" 2>&1
  note "  S3 exit=$? out: $(head -c 400 "$OUT/st3-$TAG.json")"
  note "  S3 rule: $(rule "$(tmpl s3)")"
  note "  S3 deadline: $(gq "SELECT deadline FROM TMTask WHERE uuid='$(tmpl s3)'")"
  dismiss

  # (4) ENDS-COUNT — the HXPC1 state: the ends bound INSERTS a second numeric
  #     field AHEAD of the interval, so both the interval and the count have to
  #     land in the right one. Driven as a RESCHEDULE (pure-ui) on S1's template.
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "S4 ends-count"' </dev/null >/dev/null
  warm; front Things3
  T1=$(tmpl s1); note "  S4 target=$T1"
  cli todo reschedule-repeat "$T1" --frequency daily --interval 3 --ends-after 4 --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/st4-$TAG.json" 2>&1
  note "  S4 exit=$? out: $(head -c 400 "$OUT/st4-$TAG.json")"
  note "  S4 rule: $(rule "$T1")"
  dismiss

  # (5) PAUSED — the pause/resume pair, which drives the same dialog through a
  #     different menu path and must not be disturbed by the manifest.
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "S5 paused"' </dev/null >/dev/null
  warm; front Things3
  cli todo pause-repeat "$T1" --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/st5-$TAG.json" 2>&1
  note "  S5 pause exit=$? out: $(head -c 300 "$OUT/st5-$TAG.json")"
  note "  S5 rule after pause: $(rule "$T1")"
  cli todo resume-repeat "$T1" --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/st5b-$TAG.json" 2>&1
  note "  S5 resume exit=$? out: $(head -c 300 "$OUT/st5b-$TAG.json")"
  note "  S5 rule after resume: $(rule "$T1")"
  dismiss

  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-states-$TAG.json --name rdlat2-states-$TAG" </dev/null >"$OUT/beeps-states-$TAG.txt" 2>&1
  note "BEEPS(states $TAG): $(tail -8 "$OUT/beeps-states-$TAG.txt" | tr '\n' ' ')"
  note "STATES ($TAG) done $(date +%H:%M:%S)"
  exit 0
fi

# ==================================================================== elemcheck
# Attribution check for the element counter: with a dialog open in a KNOWN state,
# run the shipped guard prelude and the shipped group snapshot and print what each
# one reports, so a per-hop total in the profile can be explained line by line
# rather than assumed.
if [ "$CMD" = "elemcheck" ]; then
  load_session
  SHEET='sheet 1 of (first window whose subrole is "AXStandardWindow")'
  note "=============================================================="
  note "ELEMCHECK start $(date +%H:%M:%S)"
  node -e "
import('$STAGE/dist-new/write/vectors/ui-state.js').then((m) => {
  process.stdout.write(m.axFocusGuardPrelude('repeat') + '\nreturn \"PRELUDE-OK\"\n');
});" > "$OUT/elemcheck-prelude.applescript"
  lab_scp "$OUT/elemcheck-prelude.applescript" "admin@$IP:/Users/admin/labh/elemcheck-prelude.applescript" >/dev/null
  warm; front Things3
  add "RDLAT2%20ec%20seed"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='RDLAT2 ec seed' AND type=0 AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  for FREQ in "after completion" monthly; do
    axq "tell application \"System Events\" to tell process \"Things3\"
  set pu to (pop up button 1 of ($SHEET))
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.05
  end repeat
  click menu item \"$FREQ\" of menu 1 of pu
  delay 1.5
  return (value of pu) as text
end tell" >/dev/null
    note "  --- $FREQ ---"
    note "    direct children of shell = $(axq "tell application \"System Events\" to tell process \"Things3\" to return (count of UI elements of ($SHEET))" | tail -1)"
    note "    direct children of group = $(axq "tell application \"System Events\" to tell process \"Things3\" to return (count of UI elements of (group 1 of ($SHEET)))" | tail -1)"
    note "    prelude reports: $(lab_ssh "$IP" 'osascript ~/labh/elemcheck-prelude.applescript 2>&1 | grep AXELEMS | tr "\n" " "' </dev/null)"
  done
  dismiss
  note "ELEMCHECK done $(date +%H:%M:%S)"
  exit 0
fi

# ======================================================================== elem
# §E — DOES THE REPEAT SHEET REALIZE PER ELEMENT, the way the sidebar does?
#
# The field finding (M1, 2026-09-02) is that an AX sweep's cost is the app
# realizing each custom row's content — ~115ms/row on a Retina display,
# independent of depth and call count, and paid again on a repeat sweep. The
# Repeat dialog is ordinary AppKit controls in a sheet, not custom cell views, so
# whether it behaves the same way is an open question. A clone cannot answer it
# for the FIELD (the whole point is that realization is cheap in a VM), but it
# can measure the geometry-vs-content ratio and whether a repeat sweep re-pays.
if [ "$CMD" = "elem" ]; then
  load_session
  note "=============================================================="
  note "ELEM start $(date +%H:%M:%S)"
  lab_scp lab/scripts/rdlat2-elem.jxa.js "admin@$IP:/Users/admin/labh/rdlat2-elem.jxa.js" >/dev/null
  SHEET='sheet 1 of (first window whose subrole is "AXStandardWindow")'
  warm; front Things3
  add "RDLAT2%20elem%20seed"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='RDLAT2 elem seed' AND type=0 AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2

  for FREQ in "after completion" monthly; do
    axq "tell application \"System Events\" to tell process \"Things3\"
  set pu to (pop up button 1 of ($SHEET))
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.05
  end repeat
  click menu item \"$FREQ\" of menu 1 of pu
  delay 1
  return (value of pu) as text
end tell" >/dev/null
    note "  --- frequency = $FREQ ---"
    lab_ssh "$IP" 'osascript -l JavaScript ~/labh/rdlat2-elem.jxa.js' </dev/null 2>&1 | sed 's/^/[rdlat2]   /' | tee -a "$REPORT"
  done
  dismiss
  note "ELEM done $(date +%H:%M:%S)"
  exit 0
fi

# ====================================================================== census
# THE CENSUS 2x2 (FGRD1 U1..U4), on its own fixtures so it can be re-run.
# This is the cell the RDLAT2 census change has to answer for: the control
# inventory is now read as ONE role list instead of five counts, and the focus
# probe is skipped while Things owns the screen. Both are supposed to be
# invisible — the same four verdicts, the same control census string.
if [ "$CMD" = "census" ]; then
  load_session
  TAG="${TAG:-new}"
  case "$TAG" in old) CLI="$OLDCLI" ;; new) CLI="$NEWCLI" ;; esac
  note "=============================================================="
  note "CENSUS ($TAG) start $(date +%H:%M:%S)"
  ui() {
    lab_ssh "$IP" "$LAB_DIRECT $CLI doctor --ui-state --json" </dev/null 2>/dev/null \
      | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const m = /(\{"apiVersion[\s\S]*)/.exec(s);
  if (m === null) return console.log("(no json)");
  const ui = JSON.parse(m[1]).data?.uiState ?? null;
  console.log(JSON.stringify(ui));
});'
  }
  P="RDLAT2U-$TAG-$$"
  warm; front Things3
  add "${P}%20one"
  ONE=$(gq "SELECT uuid FROM TMTask WHERE title='$P one' AND type=0 AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  note "  U1 (no dialog, Things frontmost): $(ui)"
  front Finder
  note "  U2 (no dialog, Finder frontmost): $(ui)"
  front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$ONE'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  note "  U3 (Repeat dialog open, Things frontmost): $(ui)"
  front Finder
  note "  U4 (Repeat dialog open, Finder frontmost): $(ui)"
  # …and with the deadline box TICKED, the shell carries a direct text field
  # (CNCAC2/#646): the census must still read `repeat`, not `other`.
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click (checkbox "Add deadlines" of (sheet 1 of (first window whose subrole is "AXStandardWindow")))' >/dev/null
  sleep 1
  note "  U5 (Repeat dialog, deadlines TICKED — the #646 shape): $(ui)"
  dismiss
  note "  U6 (after dismissal): $(ui)"
  note "CENSUS ($TAG) done $(date +%H:%M:%S)"
  exit 0
fi

# ====================================================================== s1diag
# ISOLATE the fixed-frequency interval step. The dialog is driven by hand to a
# fixed monthly rule, and then the SHIPPED set-group-number script — emitted out
# of each staged bundle, so the thing under test is the thing that ships (the
# CGRD1 §C test seam) — is run against it. Whatever differs between the bundles
# shows up here without the driver in the way.
if [ "$CMD" = "s1diag" ]; then
  load_session
  SHEET='sheet 1 of (first window whose subrole is "AXStandardWindow")'
  for B in old new; do
    node -e "
import('$STAGE/dist-$B/write/vectors/ui.js').then((m) => {
  process.stdout.write(m.axSetGroupNumberScript('group 1 of ($SHEET)', 'interval', '2'));
});" > "$OUT/s1diag-$B.applescript" 2>/dev/null
    note "s1diag: emitted $B script ($(wc -c <"$OUT/s1diag-$B.applescript" | tr -d ' ') bytes)"
    lab_scp "$OUT/s1diag-$B.applescript" "admin@$IP:/Users/admin/labh/s1diag-$B.applescript" >/dev/null
  done

  for B in old new; do
    warm; front Things3
    add "RDLAT2D-$B"
    U=$(gq "SELECT uuid FROM TMTask WHERE title='RDLAT2D-$B' AND type=0 AND trashed=0 ORDER BY rowid DESC LIMIT 1")
    lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 3" </dev/null
    front Things3
    axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
    sleep 2
    axq "tell application \"System Events\" to tell process \"Things3\"
  set pu to (pop up button 1 of ($SHEET))
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.05
  end repeat
  click menu item \"monthly\" of menu 1 of pu
  delay 1
  return (value of pu) as text
end tell" | tail -1 | sed "s/^/[rdlat2]   $B frequency now: /" | tee -a "$REPORT"
    note "  $B group census: statics=$(axq "tell application \"System Events\" to tell process \"Things3\" to return (value of static texts of (group 1 of ($SHEET))) as text" | tail -1 | cut -c1-160)"
    note "  $B field values=$(axq "tell application \"System Events\" to tell process \"Things3\" to return (value of text fields of (group 1 of ($SHEET))) as text" | tail -1) positions=$(axq "tell application \"System Events\" to tell process \"Things3\" to return (position of text fields of (group 1 of ($SHEET))) as text" | tail -1)"
    note "  $B RESULT: $(lab_ssh "$IP" "osascript ~/labh/s1diag-$B.applescript 2>&1 | tail -3" </dev/null | tr '\n' ' ' | cut -c1-400)"
    note "  $B field after: $(axq "tell application \"System Events\" to tell process \"Things3\" to return (value of text fields of (group 1 of ($SHEET))) as text" | tail -1)"
    dismiss
  done
  note "S1DIAG done $(date +%H:%M:%S)"
  exit 0
fi

# ====================================================================== s1rep
# The FIXED-FREQUENCY INTERVAL cell, repeated. `make-repeating --frequency
# monthly --interval 2` is the one state whose interval step must actually TYPE
# (the default is 1), immediately after a frequency switch has rebuilt the
# cadence group — the BEEP1 re-layout race. A single sample says nothing about a
# race, so this runs it N times per bundle and reports the rate.
if [ "$CMD" = "s1rep" ]; then
  load_session
  TAG="${TAG:-new}"
  case "$TAG" in old) CLI="$OLDCLI" ;; new) CLI="$NEWCLI" ;; esac
  REPS="${REPS:-5}"
  note "=============================================================="
  note "S1REP ($TAG) start $(date +%H:%M:%S) reps=$REPS"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 's1rep $TAG'" </dev/null >/dev/null
  PASS=0; FAIL=0
  for rep in $(seq 1 "$REPS"); do
    warm; front Things3
    add "RDLAT2R-$TAG-$rep"
    U=$(gq "SELECT uuid FROM TMTask WHERE title='RDLAT2R-$TAG-$rep' AND type=0 AND rt1_recurrenceRule IS NULL AND trashed=0 ORDER BY rowid DESC LIMIT 1")
    lab_ssh "$IP" "THINGS_API_TRACE=true $LAB_DIRECT $CLI todo make-repeating $U --frequency monthly --interval 2 --dangerously-drive-gui --verify-timeout 90000 --json" \
      </dev/null >"$OUT/drive/s1rep-$TAG-$rep.log" 2>&1
    if grep -q '"ok":true' "$OUT/drive/s1rep-$TAG-$rep.log"; then
      PASS=$((PASS+1)); note "  rep$rep PASS"
    else
      FAIL=$((FAIL+1))
      note "  rep$rep FAIL: $(grep -o '"message":"[^"]*"' "$OUT/drive/s1rep-$TAG-$rep.log" | head -1 | cut -c1-240)"
    fi
    dismiss
  done
  note "S1REP ($TAG): $PASS pass / $FAIL fail of $REPS"
  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-s1rep-$TAG.json --name rdlat2-s1rep-$TAG" </dev/null >"$OUT/beeps-s1rep-$TAG.txt" 2>&1
  note "BEEPS(s1rep $TAG): $(tail -4 "$OUT/beeps-s1rep-$TAG.txt" | tr '\n' ' ')"
  note "S1REP ($TAG) done $(date +%H:%M:%S)"
  exit 0
fi

# ===================================================================== cells
# The DRVLAT1/FGRD1/FGRD2 guard-cell set. Every cell is a GUARD SEMANTIC the
# manifest must not have weakened.
if [ "$CMD" = "cells" ]; then
  load_session
  TAG="${TAG:-new}"
  case "$TAG" in old) CLI="$OLDCLI" ;; new) CLI="$NEWCLI" ;; *) echo "TAG must be old|new" >&2; exit 1 ;; esac
  cli() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*" </dev/null; }
  note "=============================================================="
  note "CELLS ($TAG) start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null

  cdismiss() {
    dismiss
    note "  dismiss → $(cli doctor --ui-state --json 2>/dev/null | tail -1 | head -c 200)"
  }

  P="RDLAT2C-$TAG-$$"   # unique per run: the cells mutate their fixtures, so a re-run must not inherit them
  add "${P}%20alpha"; add "${P}%20bravo"; add "${P}%20charlie"; add "${P}%20delta"
  ALPHA=$(gq "SELECT uuid FROM TMTask WHERE title='$P alpha' AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  BRAVO=$(gq "SELECT uuid FROM TMTask WHERE title='$P bravo' AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  CHARLIE=$(gq "SELECT uuid FROM TMTask WHERE title='$P charlie' AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  DELTA=$(gq "SELECT uuid FROM TMTask WHERE title='$P delta' AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  note "fixtures: alpha=$ALPHA bravo=$BRAVO charlie=$CHARLIE delta=$DELTA"

  # ---------------- U: the ui-state census 2x2 (FGRD1 U1..U4, FGRD2 U) --------
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "U ui-state"' </dev/null >/dev/null
  warm; front Things3
  note "U1 (no dialog, Things frontmost): $(cli doctor --ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  front Finder
  note "U2 (no dialog, Finder frontmost): $(cli doctor --ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$ALPHA'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  note "U3 (Repeat dialog open, Things frontmost): $(cli doctor --ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  front Finder
  note "U4 (Repeat dialog open, Finder frontmost): $(cli doctor --ui-state --json 2>/dev/null | tail -1 | head -c 300)"

  # -------- C: the stranded-dialog cleanup ladder (FGRD1 C2) ------------------
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "C cleanup"' </dev/null >/dev/null
  cli todo make-repeating "$BRAVO" --frequency weekly --interval 2 --dangerously-drive-gui --verify-timeout 60000 --json >"$OUT/c2-$TAG.json" 2>"$OUT/c2-$TAG.err"
  note "C2 exit=$? stdout: $(head -c 500 "$OUT/c2-$TAG.json")"
  note "C2 stderr: $(head -c 700 "$OUT/c2-$TAG.err")"
  note "C2 census after: $(cli doctor --ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  note "C2 bravo repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='$P bravo' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
  cdismiss

  # -------- S: the already-set skip discloses and types nothing (FGRD1 S) -----
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "S skip"' </dev/null >/dev/null
  warm; front Things3
  cli todo make-repeating "$ALPHA" --frequency daily --interval 1 --after-completion --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/s1-$TAG.json" 2>"$OUT/s1-$TAG.err"
  note "S1 exit=$? out: $(head -c 700 "$OUT/s1-$TAG.json")"
  note "S1 template? $(gq "SELECT count(*) FROM TMTask WHERE title='$P alpha' AND rt1_recurrenceRule IS NOT NULL") (expect 1)"
  cdismiss

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
  note "T1 census after: $(cli doctor --ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  cdismiss

  # -------- X: the open-dialog PREFLIGHT refusal (MODALX1 / #620) -------------
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "X preflight"' </dev/null >/dev/null
  warm; front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$DELTA'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  cli todo make-repeating "$DELTA" --frequency weekly --interval 2 --dangerously-drive-gui --verify-timeout 60000 --json >"$OUT/x1-$TAG.json" 2>"$OUT/x1-$TAG.err"
  note "X1 exit=$? stderr: $(head -c 600 "$OUT/x1-$TAG.err")"
  note "X1 delta repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='$P delta' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
  cdismiss

  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-cells-$TAG.json --name rdlat2-cells-$TAG" </dev/null >"$OUT/beeps-cells-$TAG.txt" 2>&1
  note "BEEPS(cells $TAG): $(tail -8 "$OUT/beeps-cells-$TAG.txt" | tr '\n' ' ')"
  note "CELLS ($TAG) done $(date +%H:%M:%S)"
  exit 0
fi

# ===================================================================== chord
if [ "$CMD" = "chord" ]; then
  load_session
  TAG="${TAG:-new}"
  case "$TAG" in old) CLI="$OLDCLI" ;; new) CLI="$NEWCLI" ;; esac
  cli() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*" </dev/null; }
  note "=============================================================="
  note "CHORD ($TAG) start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  lab_ssh "$IP" '~/labh/beep-sentinel.sh mark "chord reorder"' </dev/null >/dev/null

  PRJ="RDLAT2 chord $TAG"
  cli project add "'$PRJ'" --json >"$OUT/chord-proj-$TAG.json" 2>&1
  PU=$(gq "SELECT uuid FROM TMTask WHERE title='$PRJ' AND type=1 AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  note "  project=$PU"
  for h in Alpha Bravo Charlie; do
    cli project add-heading "$PU" "'$h'" --json >"$OUT/chord-head-$h-$TAG.json" 2>&1
  done
  note "  headings before: $(gq "SELECT group_concat(title,' | ') FROM (SELECT title FROM TMTask WHERE project='$PU' AND type=2 AND trashed=0 ORDER BY \"index\")")"
  cli project move-heading "$PU" "'Charlie'" --first --dangerously-drive-gui --json >"$OUT/chord-$TAG.json" 2>&1
  note "  move exit=$? out: $(head -c 500 "$OUT/chord-$TAG.json")"
  note "  headings after: $(gq "SELECT group_concat(title,' | ') FROM (SELECT title FROM TMTask WHERE project='$PU' AND type=2 AND trashed=0 ORDER BY \"index\")")"

  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-chord-$TAG.json --name rdlat2-chord-$TAG" </dev/null >"$OUT/beeps-chord-$TAG.txt" 2>&1
  note "BEEPS(chord $TAG): $(tail -6 "$OUT/beeps-chord-$TAG.txt" | tr '\n' ' ')"
  note "CHORD ($TAG) done $(date +%H:%M:%S)"
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

echo "usage: research-rdlat2.sh setup|ship|shipnew|micro|profile|aecount|states|cells|chord|teardown" >&2
exit 2
