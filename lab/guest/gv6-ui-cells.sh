#!/bin/bash
# GV6 — every ui-vector operation, end to end, through the deputy, on Things
# 3.25. Run ON THE GUEST by lab/scripts/stage5-rc-run.sh on a routed
# golden-v6h clone (helpers installed + granted, `helpers-enabled true`).
#
# WHY. 3.25 is the touch-input release (roomier menus and dialogs "when opened
# via touch", sidebar resizing, larger tap targets), and the GUI-driven op kinds
# are not in the recurring suites (suite-audit § ui-vector ops), so a green
# `lab:regress` says nothing about them. The v0.20.12 cell list already
# certifies the Repeat drive's quadrants, `area reorder` and the mutation lock;
# this list covers every OTHER entry of UI_DRIVE_OPS (src/write/operations.ts)
# once, so that together the two runs touch the whole set:
#
#   1  todo make-repeating · pause-repeat · resume-repeat · reschedule-repeat
#   2  todo convert-to-project
#   3  project make-repeating · pause-repeat · resume-repeat · reschedule-repeat
#   4  project promote-heading · move-heading (chord) · move-heading-to-project
#      · dissolve-heading
#   5  area reorder --first
#   6  rescue status · dismiss · relaunch
#
# NORMAL CLI syntax for every operation under test. Fixtures are seeded through
# the CLI where a verb exists, and through the json URL only for headings (the
# one headless heading-create path, HX0). Cell 6 opens a Repeat dialog with a
# System Events menu click as its FIXTURE (something has to be stranded for
# `rescue` to rescue); that click is never the thing measured. Every claim is
# judged by a read-only database oracle, never by the CLI's own say-so alone.
#
# Usage: gv6-ui-cells.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
FAILURES=0
T="GV6"
TRACE_DIR="$HOME/.local/state/things-api/trace"
export THINGS_API_TRACE=1
newest_trace() { ls -t "$TRACE_DIR"/*.jsonl 2>/dev/null | head -1; }

things() { "$NODE" "$APP" "$@"; }
fail() { echo "FAIL $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   $*"; }

dbq() {
  python3 -c "
import glob, os, sqlite3, sys
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
for row in c.execute(sys.argv[1]).fetchall():
    print('|'.join('' if v is None else str(v) for v in row))
" "$1"
}
uuid_of() { dbq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1" | head -1; }
# Retry the read-back: the URL scheme returns before Things commits the row.
wait_uuid() {
  local u i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    u=$(uuid_of "$1"); [ -n "$u" ] && { echo "$u"; return 0; }
    sleep 1
  done
  return 1
}
jget() { python3 -c "import json,sys
d=json.load(sys.stdin)
for k in sys.argv[1:]:
    d = d.get(k) if isinstance(d, dict) else None
print('' if d is None else (json.dumps(d) if isinstance(d,(dict,list)) else d))" "$@"; }

# run <name> -- <cli args...> : runs, banks stdout/stderr, echoes the exit code.
run() {
  local name="$1"; shift; [ "$1" = "--" ] && shift
  local t0 t1 code
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  things "$@" >"$OUT/$name.json" 2>"$OUT/$name.err"
  code=$?
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  echo "$code" >"$OUT/$name.exit"
  local tr; tr=$(newest_trace); [ -n "$tr" ] && cp "$tr" "$OUT/$name.trace.jsonl" 2>/dev/null
  echo "     [$name] exit=$code wall=$((t1 - t0))ms"
  if [ "$code" -ne 0 ]; then
    head -c 900 "$OUT/$name.json" | sed 's/^/     | /'
    tail -5 "$OUT/$name.err" | sed 's/^/     ! /'
  fi
  return "$code"
}
expect0() { local n="$1"; shift; if run "$n" "$@"; then pass "[$n] exit 0"; return 0; else fail "[$n] exit $(cat "$OUT/$n.exit")"; return 1; fi; }

rule_hex() { dbq "SELECT hex(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'"; }
paused() { dbq "SELECT rt1_instanceCreationPaused FROM TMTask WHERE uuid='$1'"; }

echo "############################################################"
echo "# GV6 ui-vector cells — Things $(defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString) ($(defaults read /Applications/Things3.app/Contents/Info CFBundleVersion))"
echo "# clock: $(date)"
echo "############################################################"

echo ""
echo "===== CELL 0 — routed identity + the GUI opt-ins ====="
things helpers status --json >"$OUT/00-helpers-status.json" 2>/dev/null
DEPUTY_RUNNING=$(jget data deputy running <"$OUT/00-helpers-status.json")
AXT=$(jget data deputy hello axTrusted <"$OUT/00-helpers-status.json")
[ "$DEPUTY_RUNNING" = "True" ] || [ "$DEPUTY_RUNNING" = "true" ] && pass "deputy running" || fail "deputy not running ($DEPUTY_RUNNING)"
[ "$AXT" = "True" ] || [ "$AXT" = "true" ] && pass "deputy axTrusted" || fail "deputy not axTrusted ($AXT)"
things doctor --json >"$OUT/00-doctor.json" 2>/dev/null
WMODE=$(jget data capability write mode <"$OUT/00-doctor.json")
[ "$WMODE" = "deputy" ] && pass "doctor: write mode = deputy" || fail "doctor: write mode = $WMODE (not routed)"
DBV=$(jget meta dbVersion <"$OUT/00-doctor.json"); FP=$(jget data fingerprint status <"$OUT/00-doctor.json")
echo "     doctor: dbVersion=$DBV fingerprint=$FP"
things config set ui-enabled true >/dev/null && pass "ui-enabled on" || fail "could not set ui-enabled"
things config set experimental-area-reorder true >/dev/null && pass "experimental-area-reorder on" || fail "could not set experimental-area-reorder"
UIMODE=$(things doctor --json 2>/dev/null | jget data capability ui mode)
echo "     doctor: ui mode=$UIMODE"

echo ""
echo "===== CELL 1 — to-do repeat family ====="
expect0 01a-seed -- todo add "$T-TODO-R" --json
TR=$(wait_uuid "$T-TODO-R") || fail "seed to-do never appeared"
if [ -n "${TR:-}" ] && expect0 01b-make-repeating -- todo make-repeating "$TR" --frequency weekly --interval 1 --dangerously-drive-gui --json; then
  TMPL=$(dbq "SELECT uuid FROM TMTask WHERE title='$T-TODO-R' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  [ -n "$TMPL" ] && pass "make-repeating: a template with a rule exists ($TMPL)" || fail "make-repeating: no template with a rule"
  if [ -n "$TMPL" ]; then
    expect0 01c-pause -- todo pause-repeat "$TMPL" --dangerously-drive-gui --json
    [ "$(paused "$TMPL")" = "1" ] && pass "pause-repeat: rt1_instanceCreationPaused=1" || fail "pause-repeat: paused=$(paused "$TMPL")"
    expect0 01d-resume -- todo resume-repeat "$TMPL" --dangerously-drive-gui --json
    [ "$(paused "$TMPL")" = "0" ] && pass "resume-repeat: rt1_instanceCreationPaused=0" || fail "resume-repeat: paused=$(paused "$TMPL")"
    BEFORE=$(rule_hex "$TMPL")
    expect0 01e-reschedule -- todo reschedule-repeat "$TMPL" --frequency weekly --interval 2 --dangerously-drive-gui --json
    AFTER=$(rule_hex "$TMPL")
    [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ] && pass "reschedule-repeat: the rule blob changed in place (same uuid)" || fail "reschedule-repeat: rule unchanged"
  fi
fi

echo ""
echo "===== CELL 2 — todo convert-to-project ====="
expect0 02a-seed -- todo add "$T-CONVERT" --notes "gv6 synthetic note" --json
TC=$(wait_uuid "$T-CONVERT") || fail "convert seed never appeared"
if [ -n "${TC:-}" ] && expect0 02b-convert -- todo convert-to-project "$TC" --dangerously-drive-gui --json; then
  P=$(dbq "SELECT uuid FROM TMTask WHERE title='$T-CONVERT' AND type=1 AND trashed=0 LIMIT 1")
  [ -n "$P" ] && pass "convert-to-project: a project titled $T-CONVERT exists ($P)" || fail "convert-to-project: no project row"
  N=$(dbq "SELECT notes FROM TMTask WHERE uuid='$P'")
  case "$N" in *"gv6 synthetic note"*) pass "convert-to-project: notes kept";; *) fail "convert-to-project: notes lost ($N)";; esac
fi

echo ""
echo "===== CELL 3 — project repeat family ====="
expect0 03a-area -- area add "$T-AREA-P" --json
expect0 03b-seed -- project add "$T-PROJ-R" --area "$T-AREA-P" --todo "$T-PROJ-R-CHILD" --json
PR=$(wait_uuid "$T-PROJ-R") || fail "project seed never appeared"
if [ -n "${PR:-}" ] && expect0 03c-make-repeating -- project make-repeating "$PR" --frequency monthly --interval 1 --dangerously-drive-gui --json; then
  PT=$(dbq "SELECT uuid FROM TMTask WHERE title='$T-PROJ-R' AND type=1 AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  [ -n "$PT" ] && pass "project make-repeating: a project template with a rule ($PT)" || fail "project make-repeating: no template"
  if [ -n "$PT" ]; then
    expect0 03d-pause -- project pause-repeat "$PT" --dangerously-drive-gui --json
    [ "$(paused "$PT")" = "1" ] && pass "project pause-repeat: paused=1" || fail "project pause-repeat: paused=$(paused "$PT")"
    expect0 03e-resume -- project resume-repeat "$PT" --dangerously-drive-gui --json
    [ "$(paused "$PT")" = "0" ] && pass "project resume-repeat: paused=0" || fail "project resume-repeat: paused=$(paused "$PT")"
    BEFORE=$(rule_hex "$PT")
    expect0 03f-reschedule -- project reschedule-repeat "$PT" --frequency monthly --interval 2 --dangerously-drive-gui --json
    AFTER=$(rule_hex "$PT")
    [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ] && pass "project reschedule-repeat: rule changed in place" || fail "project reschedule-repeat: rule unchanged"
  fi
fi

echo ""
echo "===== CELL 4 — the heading verbs (each on its OWN fresh project) ====="
# HX0 fixture: a project carrying three headings, each with one child to-do.
# Every verb gets its own project so a refusal that strands a dialog cannot
# contaminate the next cell. url-encoded json, titles parameterised by $1.
seed_hproj() {
  local P="$1" js enc
  js='[{"type":"project","attributes":{"title":"'"$P"'","items":[{"type":"heading","attributes":{"title":"'"$P"'-H1"}},{"type":"to-do","attributes":{"title":"'"$P"'-H1-CHILD"}},{"type":"heading","attributes":{"title":"'"$P"'-H2"}},{"type":"to-do","attributes":{"title":"'"$P"'-H2-CHILD"}},{"type":"heading","attributes":{"title":"'"$P"'-H3"}},{"type":"to-do","attributes":{"title":"'"$P"'-H3-CHILD"}}]}}]'
  enc=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$js")
  open -g "things:///json?data=$enc"
  wait_uuid "$P-H3-CHILD" >/dev/null || return 1
  wait_uuid "$P" >/dev/null || return 1
}
horder() { dbq "SELECT title FROM TMTask WHERE project='$1' AND type=2 AND trashed=0 AND status=0 ORDER BY \"index\"" | tr '\n' ' '; }
rowstate() { dbq "SELECT coalesce(heading,'NULL')||'/'||coalesce(project,'NULL')||'/'||trashed||'/'||\"index\" FROM TMTask WHERE uuid='$1'"; }
dismiss_any() { things rescue dismiss --dangerously-dismiss-dialog --json >/dev/null 2>&1; true; }

# 4a move-heading (the chord route)
seed_hproj "$T-HA" && HA=$(uuid_of "$T-HA")
if [ -n "${HA:-}" ]; then
  echo "     $T-HA heading order: $(horder "$HA")"
  expect0 04a-move-heading -- project move-heading "$HA" "$T-HA-H3" --first --dangerously-drive-gui --json
  case "$(horder "$HA")" in "$T-HA-H3 "*) pass "move-heading: H3 is first — $(horder "$HA")";; *) fail "move-heading: order $(horder "$HA")";; esac
else fail "4a fixture did not appear"; fi
dismiss_any

# 4b move-heading-to-project
seed_hproj "$T-HB" && HB=$(uuid_of "$T-HB")
expect0 04b-dest -- project add "$T-HB-DEST" --json
HBD=$(wait_uuid "$T-HB-DEST")
if [ -n "${HB:-}" ] && [ -n "$HBD" ]; then
  H2=$(uuid_of "$T-HB-H2"); C2=$(uuid_of "$T-HB-H2-CHILD")
  echo "     H2=$H2 child=$C2 dest=$HBD; child before: $(rowstate "$C2")"
  expect0 04b-move-to-project -- project move-heading-to-project "$HB" "$T-HB-H2" --to "$HBD" --dangerously-drive-gui --json
  sleep 2
  NEWP=$(dbq "SELECT project FROM TMTask WHERE uuid='$H2'")
  [ "$NEWP" = "$HBD" ] && pass "move-heading-to-project: H2 now lives in the destination" || fail "move-heading-to-project: H2 project=$NEWP (want $HBD)"
  echo "     child after: $(rowstate "$C2")"
else fail "4b fixture did not appear"; fi
dismiss_any

# 4c dissolve-heading — children must become direct project children (DISS1)
seed_hproj "$T-HC" && HC=$(uuid_of "$T-HC")
if [ -n "${HC:-}" ]; then
  H1=$(uuid_of "$T-HC-H1"); C1=$(uuid_of "$T-HC-H1-CHILD")
  echo "     H1=$H1 child=$C1; child before: $(rowstate "$C1")"
  expect0 04c-dissolve -- project dissolve-heading "$HC" "$T-HC-H1" --dangerously-drive-gui --json
  GONE=""; CH=""
  for i in 1 2 3 4 5 6 7 8 9 10; do
    GONE=$(dbq "SELECT count(*) FROM TMTask WHERE uuid='$H1'"); CH=$(rowstate "$C1")
    case "$CH" in NULL/"$HC"/0/*) break;; esac
    sleep 1
  done
  echo "     after (polled ${i}s): heading rows=$GONE  child=$CH"
  [ "$GONE" = "0" ] && pass "dissolve-heading: the heading row is hard-deleted" || fail "dissolve-heading: heading row count=$GONE"
  case "$CH" in NULL/"$HC"/0/*) pass "dissolve-heading: child re-homed as a direct project child, not trashed";; *) fail "dissolve-heading: child = $CH (heading/project/trashed/index; want NULL/$HC/0/*)";; esac
else fail "4c fixture did not appear"; fi
dismiss_any

# 4d promote-heading
seed_hproj "$T-HD" && HDP=$(uuid_of "$T-HD")
if [ -n "${HDP:-}" ]; then
  expect0 04d-promote -- project promote-heading "$HDP" "$T-HD-H3" --dangerously-drive-gui --json
  PP=$(dbq "SELECT uuid FROM TMTask WHERE title='$T-HD-H3' AND type=1 AND trashed=0 LIMIT 1")
  [ -n "$PP" ] && pass "promote-heading: a project titled $T-HD-H3 exists ($PP)" || fail "promote-heading: no project"
else fail "4d fixture did not appear"; fi
dismiss_any

echo ""
echo "===== CELL 5 — area reorder --first ====="
expect0 05a-area -- area add "$T-AREA-LAST" --json
sleep 2
aorder() { dbq "SELECT title FROM TMArea ORDER BY \"index\"" | tr '\n' ' '; }
echo "     area order before: $(aorder)"
expect0 05b-reorder -- area reorder "$T-AREA-LAST" --first --dangerously-drive-gui --json
case "$(aorder)" in "$T-AREA-LAST "*) pass "area reorder: $T-AREA-LAST is first — $(aorder)";; *) fail "area reorder: order $(aorder)";; esac

echo ""
echo "===== CELL 6 — rescue: status, dismiss, relaunch ====="
expect0 06a-status-clear -- rescue status --json
S0=$(jget data state sheetOpen <"$OUT/06a-status-clear.json")
[ "$S0" = "False" ] || [ "$S0" = "false" ] && pass "rescue status: no dialog open" || fail "rescue status: sheetOpen=$S0 before the fixture"
# FIXTURE: strand a Repeat dialog on a plain to-do.
expect0 06b-seed -- todo add "$T-RESCUE" --json
TRS=$(wait_uuid "$T-RESCUE")
open -g "things:///show?id=$TRS"; sleep 3
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1; sleep 2
osascript -e 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null 2>&1
sleep 4
expect0 06c-status-open -- rescue status --json
S1=$(jget data state sheetOpen <"$OUT/06c-status-open.json"); K1=$(jget data state sheetKind <"$OUT/06c-status-open.json"); C1=$(jget data state sheetControls <"$OUT/06c-status-open.json")
echo "     rescue status with the fixture dialog: sheetOpen=$S1 kind=$K1 controls=$C1"
[ "$S1" = "True" ] || [ "$S1" = "true" ] && pass "rescue status sees the stranded dialog (kind=$K1)" || fail "rescue status does not see the dialog"
run 06d-dismiss -- rescue dismiss --dangerously-dismiss-dialog --json
DO=$(jget data outcome <"$OUT/06d-dismiss.json")
[ "$DO" = "dismissed" ] && pass "rescue dismiss: dismissed" || fail "rescue dismiss: outcome=$DO"
expect0 06e-status-after -- rescue status --json
S2=$(jget data state sheetOpen <"$OUT/06e-status-after.json")
[ "$S2" = "False" ] || [ "$S2" = "false" ] && pass "rescue status: clear after dismiss" || fail "rescue status: sheetOpen=$S2 after dismiss"
PID0=$(pgrep -x Things3 | head -1)
run 06f-relaunch -- rescue relaunch --yes --dangerously-force-quit --json
RO=$(jget data outcome <"$OUT/06f-relaunch.json"); EB=$(jget data endedBy <"$OUT/06f-relaunch.json")
sleep 3
PID1=$(pgrep -x Things3 | head -1)
echo "     relaunch: outcome=$RO endedBy=$EB pid $PID0 -> $PID1"
[ -n "$PID1" ] && [ "$PID1" != "$PID0" ] && pass "rescue relaunch: Things is running again under a new pid" || fail "rescue relaunch: pid $PID0 -> $PID1 (outcome=$RO)"

echo ""
echo "===== CELL 7 — the deputy's own verdict ====="
DLOG="$HOME/.local/state/things-api/deputy/deputy.log"
REJ=$(grep -c 'rejected-script' "$DLOG" 2>/dev/null || true)
[ "${REJ:-0}" = "0" ] && pass "deputy log: no rejected-script" || fail "deputy log: $REJ rejected-script line(s)"

echo ""
if [ "$FAILURES" -eq 0 ]; then echo "GREEN — every GV6 ui-vector cell passed"; else echo "RED — $FAILURES failure(s)"; fi
exit "$FAILURES"
