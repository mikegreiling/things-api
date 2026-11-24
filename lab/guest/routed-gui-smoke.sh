#!/bin/bash
# The ROUTED GUI smoke (HELPGST1). Runs ON THE GUEST, on a clone that carries
# the granted helper pair (golden-v4h) with `helpers-enabled` true.
#
# Usage: routed-gui-smoke.sh <node-binary> <app-dir>   (app-dir has dist/)
#
# WHAT THIS COVERS THAT THE WRITE-LAYER E2E DOES NOT. The e2e keeps `ui-enabled`
# off in both arms on purpose, so its 130-odd steps are byte-comparable between
# them — which means it never actually DRIVES the Things window. A GUI drive is
# the one place where "which identity runs this script" changes the script
# itself: the deputy's broker LINTS every script it is handed and refuses
# `do shell script` outright (`scriptGuard`, deputy/src/server.swift), so a
# generator that shells out is fine direct and dead routed. That is exactly how
# 0.20.7 shipped: the AX settle sidecar spawned itself through `do shell script`,
# every lab arm executed it direct and passed, and every helpers-routed Mac
# failed in ~2 s with nothing driven (#695, fixed in #698, then hosted inside the
# deputy by DEPOBS1).
#
# So this smoke drives ONE real repeat-rule dialog end to end through the deputy
# and then asks the deputy's own log whether it refused anything. It is the
# acceptance test for the routed arm as much as for the release: run against the
# v0.20.7 dist it MUST go red on the broker refusal.
set -u
NODE="$1"
APP="$2/dist/cli/main.js"

# NO ESCAPES. A routed host does not need them, and exporting one here would
# restore the direct path and hide the very difference this smoke measures.
FAILURES=0
STEP=0
DEPUTY_LOG="$HOME/.local/state/things-api/deputy/deputy.log"

BEEP_SENTINEL="$(dirname "$0")/beep-sentinel.sh"
export BEEP_MARKS="$HOME/things-lab/gui-beep-marks.tsv"
if [ ! -f "$BEEP_SENTINEL" ]; then
  echo "FAIL beep sentinel missing at $BEEP_SENTINEL — it must ship beside this script"
  FAILURES=$((FAILURES + 1))
fi
beep() {
  [ -f "$BEEP_SENTINEL" ] || return 0
  bash "$BEEP_SENTINEL" "$@"
}
beep reset
beep mark "routed gui smoke start"

things() {
  "$NODE" "$APP" "$@"
}

run_step() {
  local expect="$1" desc="$2"
  shift 2
  STEP=$((STEP + 1))
  beep mark "[$STEP] $desc"
  local out
  # stdout ONLY: the runtime prints an experimental-SQLite warning on stderr and
  # LAST_OUT is parsed as JSON by the caller.
  out=$(things "$@" --json 2>/dev/null)
  local code=$?
  LAST_OUT="$out"
  if [ "$code" -ne "$expect" ]; then
    echo "FAIL [$STEP] $desc — exit $code (expected $expect)"
    echo "     output: $(head -c 600 <<<"$out")"
    FAILURES=$((FAILURES + 1))
    return 1
  fi
  echo "ok   [$STEP] $desc"
  return 0
}

db_query() {
  python3 -c "
import glob, os, sqlite3, sys
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
print(c.execute(sys.argv[1]).fetchone()[0])
" "$1"
}

# The deputy log is append-only; remember where it stood so the assertions below
# read only THIS run's lines.
LOG_MARK=$(wc -l <"$DEPUTY_LOG" 2>/dev/null | tr -d ' ')
LOG_MARK=${LOG_MARK:-0}
deputy_log_since_mark() {
  tail -n "+$((LOG_MARK + 1))" "$DEPUTY_LOG" 2>/dev/null
}

echo "== routed GUI smoke: identity check =="
run_step 0 "helpers status" helpers status
ROUTED=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())['data']
hello = d['deputy']['hello'] or {}
auto = hello.get('automation') or {}
print(d['mode'], d['deputy']['running'], auto.get('things'), hello.get('axTrusted'), auto.get('systemEvents'))
" <<<"$LAST_OUT")
echo "     mode/running/things/ax/system-events: $ROUTED"
if [ "$ROUTED" = "true True granted True granted" ]; then
  echo "ok   the deputy holds the full GUI tier and is carrying traffic"
else
  echo "FAIL not routed with the GUI tier — refusing to call anything below a drive"
  FAILURES=$((FAILURES + 1))
fi

echo "== enable GUI-driving =="
# `config set` takes no --json, so it is called bare rather than through run_step.
if things config set ui-enabled true >/dev/null; then
  echo "ok   ui-enabled on"
else
  echo "FAIL could not switch ui-enabled on"
  FAILURES=$((FAILURES + 1))
fi

echo "== the drive: a repeating series through the deputy =="
BEFORE=$(db_query "SELECT count(*) FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL")
echo "     repeating templates before: $BEFORE"
START=$(date +%s)
run_step 0 "todo add-repeating (drives the Repeat dialog, brokered)" \
  todo add-repeating "E2E-ROUTED-WEEKLY" --when 2026-07-10 --frequency weekly --interval 1 \
  --dangerously-drive-gui
ELAPSED=$(($(date +%s) - START))
echo "     drive wall time: ${ELAPSED}s"
AFTER=$(db_query "SELECT count(*) FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL")
echo "     repeating templates after: $AFTER"
if [ "$AFTER" -eq "$((BEFORE + 1))" ]; then
  echo "ok   the series landed in the database (one new template)"
else
  echo "FAIL no new repeating template ($BEFORE -> $AFTER) — the drive did not land"
  FAILURES=$((FAILURES + 1))
fi
RULE=$(db_query "SELECT coalesce((SELECT rt1_recurrenceRule IS NOT NULL FROM TMTask WHERE title='E2E-ROUTED-WEEKLY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1), 0)")
if [ "$RULE" = "1" ]; then
  echo "ok   the new template is the one this smoke asked for, by title"
else
  echo "FAIL E2E-ROUTED-WEEKLY carries no recurrence rule"
  FAILURES=$((FAILURES + 1))
fi

echo "== the repeat toggles, the project repeat bar and the Move… picker (UIFIX1) =="
# Four shipped GUI-driven verbs refused on Things 3.23, 3.24 AND 3.25 for weeks
# (GV6 §5.3) because no gate ever drove them: the e2e keeps ui-enabled off, and
# this leg drove only the to-do Repeat dialog. Each is driven here through the
# deputy with normal CLI syntax and checked against the database
# (docs/lab/uifix1-repeat-bar-and-picker.md).
uuid_of() { db_query "SELECT coalesce((SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1), '')"; }
wait_uuid() {
  local u i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    u=$(uuid_of "$1")
    [ -n "$u" ] && { echo "$u"; return 0; }
    sleep 1
  done
  return 1
}
template_of() { db_query "SELECT coalesce((SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1), '')"; }
paused_of() { db_query "SELECT rt1_instanceCreationPaused FROM TMTask WHERE uuid='$1'"; }
check() { # check <actual> <expected> <what>
  if [ "$1" = "$2" ]; then echo "ok   $3"; else
    echo "FAIL $3 — got '$1', expected '$2'"
    FAILURES=$((FAILURES + 1))
  fi
}

# (a) to-do pause then resume, BACK TO BACK — the menu item's title lags the
# write, so resume right after pause is exactly the case that used to refuse.
TT=$(template_of "E2E-ROUTED-WEEKLY")
run_step 0 "todo pause-repeat (Items ▸ Repeat ▸ Pause)" todo pause-repeat "$TT" --dangerously-drive-gui
check "$(paused_of "$TT")" "1" "the to-do series is paused"
run_step 0 "todo resume-repeat straight after the pause" todo resume-repeat "$TT" --dangerously-drive-gui
check "$(paused_of "$TT")" "0" "the to-do series is running again"

# (b) a repeating PROJECT: pause, resume, then edit the rule — all through the
# repeat bar's popover.
run_step 0 "area add (project fixture)" area add "E2E-ROUTED-AREA"
run_step 0 "project add (project fixture)" \
  project add "E2E-ROUTED-PJ" --area "E2E-ROUTED-AREA" --when 2026-07-10 --todo "E2E-ROUTED-PJ-CHILD"
PJ=$(wait_uuid "E2E-ROUTED-PJ")
run_step 0 "project make-repeating" project make-repeating "$PJ" --frequency weekly --interval 1 \
  --dangerously-drive-gui
PT=$(db_query "SELECT coalesce((SELECT uuid FROM TMTask WHERE title='E2E-ROUTED-PJ' AND type=1 AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1), '')")
run_step 0 "project pause-repeat (repeat bar ▸ Pause)" project pause-repeat "$PT" --dangerously-drive-gui
check "$(paused_of "$PT")" "1" "the project series is paused"
run_step 0 "project resume-repeat (repeat bar ▸ Resume)" project resume-repeat "$PT" --dangerously-drive-gui
check "$(paused_of "$PT")" "0" "the project series is running again"
RULE_BEFORE=$(db_query "SELECT hex(rt1_recurrenceRule) FROM TMTask WHERE uuid='$PT'")
run_step 0 "project reschedule-repeat (repeat bar ▸ Edit Rule…, every 2 weeks)" \
  project reschedule-repeat "$PT" --frequency weekly --interval 2 --dangerously-drive-gui
RULE_AFTER=$(db_query "SELECT coalesce((SELECT hex(rt1_recurrenceRule) FROM TMTask WHERE uuid='$PT' AND trashed=0), '')")
if [ -n "$RULE_AFTER" ] && [ "$RULE_AFTER" != "$RULE_BEFORE" ]; then
  echo "ok   the project's rule changed in place (same template uuid)"
else
  echo "FAIL the project's rule did not change in place"
  FAILURES=$((FAILURES + 1))
fi

# (c) move a heading to another project, with a destination whose title is a
# PREFIX of another project's (HXPC1 §B3): the row is committed by exact title.
open -g 'things:///json?data=%5B%7B%22type%22%3A%22project%22%2C%22attributes%22%3A%7B%22title%22%3A%22E2E-ROUTED-HP%22%2C%22items%22%3A%5B%7B%22type%22%3A%22heading%22%2C%22attributes%22%3A%7B%22title%22%3A%22E2E-ROUTED-H1%22%7D%7D%2C%7B%22type%22%3A%22to-do%22%2C%22attributes%22%3A%7B%22title%22%3A%22E2E-ROUTED-H1-CHILD%22%7D%7D%2C%7B%22type%22%3A%22heading%22%2C%22attributes%22%3A%7B%22title%22%3A%22E2E-ROUTED-H2%22%7D%7D%5D%7D%7D%5D'
HCHILD=$(wait_uuid "E2E-ROUTED-H1-CHILD")
run_step 0 "project add (destination)" project add "E2E-ROUTED-DEST"
run_step 0 "project add (a project whose title extends the destination's)" project add "E2E-ROUTED-DEST-2"
HP=$(wait_uuid "E2E-ROUTED-HP")
HD=$(wait_uuid "E2E-ROUTED-DEST")
H1=$(uuid_of "E2E-ROUTED-H1")
run_step 0 "project move-heading-to-project (… ▸ Move… ▸ the destination row)" \
  project move-heading-to-project "$HP" "E2E-ROUTED-H1" --to "$HD" --dangerously-drive-gui
check "$(db_query "SELECT project FROM TMTask WHERE uuid='$H1'")" "$HD" "the heading lives in the destination"
check "$(db_query "SELECT heading FROM TMTask WHERE uuid='$HCHILD'")" "$H1" "its to-do followed it"
check "$(db_query "SELECT count(*) FROM TMTask WHERE title='E2E-ROUTED-DEST' AND type=1 AND trashed=0")" "1" \
  "no new project was created by the picker"

echo "== the broker's own verdict =="
# The client sees a refused script as a failed drive; the DEPUTY records WHY.
# Reading its log is what turns "the drive failed" into "the broker refused the
# script we generated", which is the finding 0.20.7 needed and nothing had.
DENIED=$(deputy_log_since_mark | grep -c 'rejected-script' || true)
if [ "${DENIED:-0}" -eq 0 ]; then
  echo "ok   the deputy refused no script this run"
else
  echo "FAIL the deputy refused $DENIED script(s) — the generator emitted something the broker bans:"
  deputy_log_since_mark | grep 'rejected-script' | head -3
  FAILURES=$((FAILURES + 1))
fi

echo "== alert beeps =="
beep mark "routed gui smoke end"
if ! beep assert --name "routed-gui-smoke" --json "$HOME/things-lab/gui-beeps.json"; then
  FAILURES=$((FAILURES + 1))
fi

echo ""
echo "ROUTED GUI SMOKE RESULT: $STEP steps, $FAILURES failures"
exit $((FAILURES > 0 ? 1 : 0))
