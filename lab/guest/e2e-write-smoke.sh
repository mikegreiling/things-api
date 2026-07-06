#!/bin/bash
# End-to-end write smoke. Runs ON THE GUEST against the real Things app via
# the real vectors (open -g / osascript) — the same binaries users run.
# Usage: e2e-write-smoke.sh <node-binary> <app-dir>   (app-dir has dist/)
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
FAILURES=0
STEP=0

things() {
  "$NODE" "$APP" "$@"
}

# run_step <expected-exit> <description> <args...>
run_step() {
  local expect="$1" desc="$2"
  shift 2
  STEP=$((STEP + 1))
  local out
  out=$(things "$@" --json 2>/dev/null)
  local code=$?
  if [ "$code" -ne "$expect" ]; then
    echo "FAIL [$STEP] $desc — exit $code (expected $expect)"
    echo "     output: $out"
    FAILURES=$((FAILURES + 1))
    return 1
  fi
  echo "ok   [$STEP] $desc"
  LAST_OUT="$out"
  return 0
}

json_get() {
  # json_get <python-expr-on-d> — reads LAST_OUT
  printf '%s' "$LAST_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"
}

echo "== doctor =="
run_step 0 "doctor" doctor

echo "== todo lifecycle (url-scheme + applescript vectors) =="
run_step 0 "todo add (when=today, existing tag)" todo add "E2E-1" --when today --tags lab-tag-1
UUID=$(json_get "d['data']['uuid']")
echo "     created uuid=$UUID"
run_step 0 "todo update title" todo update "$UUID" --title "E2E-1-RENAMED"
run_step 0 "todo complete" todo complete "$UUID"
run_step 0 "todo reopen (applescript status setter)" todo reopen "$UUID" --vector applescript
run_step 0 "tag add (applescript create)" tag add e2e-tag
run_step 0 "todo set tags (replacement)" todo tags "$UUID" --set "lab-tag-1,e2e-tag"
run_step 0 "todo checklist (fresh, no ack needed)" todo checklist "$UUID" --item "Alpha" --item "Bravo"

echo "== project lifecycle with verified cascade =="
run_step 0 "project add with child in area" project add "E2E-PROJ" --area LAB-AREA-A --todo "E2E-C1"
PROJ=$(json_get "d['data']['uuid']")
echo "     created project uuid=$PROJ"
run_step 4 "project complete requires children policy resolution" project complete "$PROJ" --children require-resolved
run_step 0 "project complete with verified auto-complete cascade" project complete "$PROJ" --children auto-complete

echo "== reorder (native experimental + bounce) =="
run_step 0 "seed today R1" todo add "E2E-R1" --when today
R1=$(json_get "d['data']['uuid']")
run_step 0 "seed today R2" todo add "E2E-R2" --when today
R2=$(json_get "d['data']['uuid']")
run_step 0 "seed today R3" todo add "E2E-R3" --when today
R3=$(json_get "d['data']['uuid']")
run_step 6 "native reorder is gated until allow-experimental" reorder --scope today --strategy native "$R3" "$R1"
STEP=$((STEP + 1))
if things config set allow-experimental true >/dev/null 2>&1; then
  echo "ok   [$STEP] enable allow-experimental"
else
  echo "FAIL [$STEP] enable allow-experimental"
  FAILURES=$((FAILURES + 1))
fi
run_step 0 "native today reorder (partial list, verified ordering)" reorder --scope today "$R3" "$R1"
run_step 0 "seed evening RE1" todo add "E2E-RE1" --when evening
RE1=$(json_get "d['data']['uuid']")
run_step 0 "seed evening RE2" todo add "E2E-RE2" --when evening
RE2=$(json_get "d['data']['uuid']")
run_step 4 "today reorder rejects evening members (O03 guard)" reorder --scope today "$RE1" "$R1"
run_step 0 "evening bounce reorder (verified when= round-trips)" reorder --scope evening "$RE2" "$RE1"
run_step 0 "seed project for ordering" project add "E2E-RPROJ"
RPROJ=$(json_get "d['data']['uuid']")
run_step 0 "seed project child P1" todo add "E2E-RP1" --project "$RPROJ"
RP1=$(json_get "d['data']['uuid']")
run_step 0 "seed project child P2" todo add "E2E-RP2" --project "$RPROJ"
RP2=$(json_get "d['data']['uuid']")
run_step 0 "native project reorder (uuid specifier)" reorder --scope project --project "$RPROJ" "$RP2" "$RP1"

echo "== phase 9b: reminders, notes modes, duplicate, entity updates =="
run_step 0 "todo add with reminder (emitter: 10:05 -> 10:05am)" todo add "E2E-REM" --when today --reminder 10:05
REM=$(json_get "d['data']['uuid']")
run_step 0 "re-schedule preserves the reminder (auto-preserve)" todo update "$REM" --when evening
run_step 0 "clear the reminder (bare when=)" todo update "$REM" --when evening --clear-reminder
run_step 0 "DATED reminder set (Phase 12b)" todo update "$REM" --when 2026-07-09 --reminder 15:00
run_step 0 "dated re-schedule auto-preserves the reminder" todo update "$REM" --when 2026-07-10
run_step 4 "clearing a DATED reminder is blocked (sticky, R20/R21)" todo update "$REM" --when 2026-07-10 --clear-reminder
run_step 0 "re-schedule to today and clear (the documented path)" todo update "$REM" --when today --clear-reminder
run_step 0 "append-notes (newline separator verified)" todo update "$REM" --append-notes "appended"
run_step 0 "prepend-notes" todo update "$REM" --prepend-notes "prepended"
run_step 0 "duplicate (url-only, copy discovered)" todo duplicate "$REM"
run_step 0 "move back to Inbox (de-schedules)" todo move "$REM" --inbox
run_step 0 "area update: rename + tags" area update LAB-AREA-B --title "E2E-AREA-RENAMED" --tags lab-tag-1
run_step 0 "tag add for update tests" tag add e2e-parent
run_step 0 "tag update: re-parent + shortcut" tag update lab-tag-2 --parent e2e-parent --shortcut 8

echo "== batch + changes (Phase 13) =="
SINCE=$(date -v-2M +%Y-%m-%dT%H:%M:%S)
cat > /tmp/e2e-batch.jsonl <<'EOB'
{"op":"todo.add","params":{"title":"E2E-B1","when":"today"}}
{"op":"todo.add","params":{"title":"E2E-B2","notes":"from batch"}}
EOB
run_step 0 "batch: two verified adds via JSONL" batch /tmp/e2e-batch.jsonl
run_step 0 "changes --since shows the batch adds" changes --since "$SINCE"
if ! json_get "len([i for i in d['data'] if i['title'].startswith('E2E-B')])" | grep -q "^2$"; then
  echo "FAIL changes did not include both batch adds"
  FAILURES=$((FAILURES + 1))
fi

echo "== deletes =="
run_step 0 "todo delete -> trash (applescript)" todo delete "$UUID"
run_step 0 "area add (applescript)" area add "E2E-AREA"
run_step 0 "area delete (permanent, acknowledged)" area delete "E2E-AREA" --dangerously-permanent
run_step 0 "tag delete (permanent, acknowledged)" tag delete e2e-tag --dangerously-permanent

echo "== guard checks against the live app =="
TEMPLATE_UUID=$(python3 -c "
import glob, os, sqlite3
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
row = sqlite3.connect(f'file:{db}?mode=ro', uri=True).execute(\"SELECT uuid FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL AND type=0 LIMIT 1\").fetchone()
print(row[0])
")
run_step 4 "repeating-template when= is hard-blocked (would crash Things)" todo update "$TEMPLATE_UUID" --when today
run_step 4 "empty trash requires --dangerously-permanent" trash empty
run_step 0 "empty trash (acknowledged, verified)" trash empty --dangerously-permanent

echo "== audit trail =="
AUDIT_LINES=$(cat ~/.local/state/things-api/audit/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
echo "     audit records: $AUDIT_LINES"
if [ "$AUDIT_LINES" -lt 15 ]; then
  echo "FAIL audit trail too short ($AUDIT_LINES records)"
  FAILURES=$((FAILURES + 1))
fi
TOKEN=$(python3 -c "
import glob, os, sqlite3
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
row = sqlite3.connect(f'file:{db}?mode=ro', uri=True).execute('SELECT uriSchemeAuthenticationToken FROM TMSettings').fetchone()
print(row[0] or '')
")
if [ -n "$TOKEN" ] && grep -q "$TOKEN" ~/.local/state/things-api/audit/*.jsonl 2>/dev/null; then
  echo "FAIL auth token leaked into the audit trail"
  FAILURES=$((FAILURES + 1))
else
  echo "ok   audit trail is token-free (structural redaction verified)"
fi

echo ""
echo "E2E RESULT: $STEP steps, $FAILURES failures"
exit $((FAILURES > 0 ? 1 : 0))
