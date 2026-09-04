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
