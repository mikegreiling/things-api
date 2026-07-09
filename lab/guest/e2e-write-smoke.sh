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

echo "== phase 14b: project move / duplicate / notes modes, todo restore =="
run_step 0 "project add for tier-2 ops" project add "E2E-T2PROJ" --area LAB-AREA-A --todo "E2E-T2-CHILD"
T2PROJ=$(json_get "d['data']['uuid']")
run_step 0 "project move to another area (E14)" project move "$T2PROJ" --area LAB-AREA-B
run_step 0 "project append-notes (E18, newline-joined)" project update "$T2PROJ" --append-notes "ptail"
run_step 0 "project prepend-notes (E18)" project update "$T2PROJ" --prepend-notes "phead"
run_step 0 "project duplicate incl. children (E17, copy discovered)" project duplicate "$T2PROJ"
run_step 0 "seed to-do for restore" todo add "E2E-RESTOREME" --when today
REST=$(json_get "d['data']['uuid']")
run_step 0 "delete it to the Trash" todo delete "$REST"
run_step 0 "restore from Trash (E15: un-trash, lands in Inbox)" todo restore "$REST"
run_step 4 "restore requires a TRASHED target (guard)" todo restore "$REST"

echo "== phase 19: project lifecycle, detach, granular checklist, tag subtree =="
run_step 0 "project add for lifecycle" project add "E2E-P19" --area LAB-AREA-A --todo "E2E-P19-C1"
P19=$(json_get "d['data']['uuid']")
run_step 0 "cancel with verified auto-cancel cascade (P01)" project cancel "$P19" --children auto-cancel
run_step 0 "reopen canceled=false + cascade restore (P05/P03)" project reopen "$P19" --restore-children
run_step 0 "complete with auto-complete cascade" project complete "$P19" --children auto-complete
run_step 0 "reopen completed=false + cascade restore (P02)" project reopen "$P19" --restore-children
run_step 0 "detach project from its area (P24)" project move "$P19" --detach
run_step 0 "delete project to the Trash" project delete "$P19"
run_step 0 "restore project IN PLACE (P06)" project restore "$P19"
run_step 4 "project restore requires a TRASHED target (guard)" project restore "$P19"
run_step 0 "seed scheduled to-do in the project" todo add "E2E-DETACH" --project "$P19" --when 2026-07-14
DET=$(json_get "d['data']['uuid']")
run_step 0 "detach keeps the schedule (P21/P22)" todo move "$DET" --detach
run_step 0 "seed to-do for granular checklist" todo add "E2E-CLIST"
CL=$(json_get "d['data']['uuid']")
run_step 0 "wholesale checklist (fresh)" todo checklist "$CL" --item "Alpha" --item "Bravo"
run_step 0 "granular CHECK via json states (P18)" todo checklist "$CL" --check "Alpha"
run_step 0 "granular add at a position (states preserved)" todo checklist "$CL" --add "Charlie" --at 2
run_step 0 "granular rename" todo checklist "$CL" --rename "Bravo" --to "Bravo2"
run_step 0 "tag subtree: parent" tag add e2e-sub-parent
run_step 0 "tag subtree: child" tag add e2e-sub-child --parent e2e-sub-parent
run_step 4 "parent-tag delete blocked without subtree ack (P16 guard)" tag delete e2e-sub-parent --dangerously-permanent
run_step 0 "parent-tag delete with subtree ack" tag delete e2e-sub-parent --dangerously-permanent --acknowledge-subtree

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
run_step 0 "seed area project AP1" project add "E2E-AP1" --area LAB-AREA-A
AP1=$(json_get "d['data']['uuid']")
run_step 0 "seed area project AP2" project add "E2E-AP2" --area LAB-AREA-A
AP2=$(json_get "d['data']['uuid']")
run_step 0 "native area reorder of PROJECTS (O14)" reorder --scope area --area LAB-AREA-A "$AP2" "$AP1"
run_step 0 "seed area to-do for mixed check" todo add "E2E-AT1" --area LAB-AREA-A
AT1=$(json_get "d['data']['uuid']")
run_step 4 "mixed to-do+project area reorder is rejected (guard)" reorder --scope area --area LAB-AREA-A "$AT1" "$AP1"

echo "== reorder scopes: inbox / someday / headings / projects (§C) =="
run_step 0 "seed inbox I1" todo add "E2E-I1"
I1=$(json_get "d['data']['uuid']")
run_step 0 "seed inbox I2" todo add "E2E-I2"
I2=$(json_get "d['data']['uuid']")
run_step 0 "native inbox reorder (A6 reversed wire convention)" reorder --scope inbox "$I2" "$I1"
run_step 0 "seed someday S1" todo add "E2E-S1" --when someday
S1=$(json_get "d['data']['uuid']")
run_step 0 "seed someday S2" todo add "E2E-S2" --when someday
S2=$(json_get "d['data']['uuid']")
run_step 0 "native someday reorder of loose to-dos (P6h/P8)" reorder --scope someday "$S2" "$S1"
run_step 0 "seed someday project SP1 (area-less)" project add "E2E-SP1" --when someday
SP1=$(json_get "d['data']['uuid']")
run_step 0 "seed someday project SP2 (area-less)" project add "E2E-SP2" --when someday
SP2=$(json_get "d['data']['uuid']")
run_step 0 "native someday reorder of PROJECTS (P9e descending stack)" reorder --scope someday "$SP2" "$SP1"
run_step 4 "mixed someday to-do+project reorder is rejected (guard)" reorder --scope someday "$S1" "$SP1"
# Headings seed via the json URL (HX0: heading items inside a NEW project's
# payload create real type=2 rows — the only headless create path).
open -g 'things:///json?data=%5B%7B%22type%22%3A%22project%22%2C%22attributes%22%3A%7B%22title%22%3A%22E2E-HPROJ%22%2C%22items%22%3A%5B%7B%22type%22%3A%22heading%22%2C%22attributes%22%3A%7B%22title%22%3A%22E2E-H1%22%7D%7D%2C%7B%22type%22%3A%22heading%22%2C%22attributes%22%3A%7B%22title%22%3A%22E2E-H2%22%7D%7D%5D%7D%7D%5D'
sleep 3
read -r HPROJ H1 H2 <<< "$(python3 -c "
import glob, os, sqlite3
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
proj = c.execute(\"SELECT uuid FROM TMTask WHERE title='E2E-HPROJ' AND type=1\").fetchone()[0]
h1 = c.execute(\"SELECT uuid FROM TMTask WHERE title='E2E-H1' AND type=2\").fetchone()[0]
h2 = c.execute(\"SELECT uuid FROM TMTask WHERE title='E2E-H2' AND type=2\").fetchone()[0]
print(proj, h1, h2)
")"
if [ -n "$HPROJ" ] && [ -n "$H1" ] && [ -n "$H2" ]; then
  echo "ok   heading fixtures seeded via json url ($H1, $H2)"
else
  echo "FAIL heading fixtures did not appear (json url seed)"
  FAILURES=$((FAILURES + 1))
fi
run_step 0 "native reorder of a project's HEADINGS (scf P1)" reorder --scope headings --project "$HPROJ" "$H2" "$H1"
run_step 0 "seed top-level project TP1" project add "E2E-TP1"
TP1=$(json_get "d['data']['uuid']")
run_step 0 "seed top-level project TP2" project add "E2E-TP2"
TP2=$(json_get "d['data']['uuid']")
run_step 0 "bounce reorder of top-level sidebar PROJECTS (someday round-trip)" reorder --scope projects "$TP2" "$TP1"

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
run_step 0 "tag update: UN-NEST to root (P29 property-delete)" tag update lab-tag-2 --unnest
run_step 2 "unnest is exclusive with --parent" tag update lab-tag-2 --parent e2e-parent --unnest

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

echo "== undo (Phase 15: audit replay) =="
run_step 0 "seed to-do for undo" todo add "E2E-UNDOME" --when today
UNDO1=$(json_get "d['data']['uuid']")
run_step 0 "complete it" todo complete "$UNDO1"
run_step 0 "undo reopens it (inverse verified)" undo
run_step 0 "it IS open again (completing works)" todo complete "$UNDO1"
run_step 0 "undo dry-run plans without executing" undo --dry-run
run_step 0 "undo the re-completion" undo
run_step 0 "delete it to the Trash" todo delete "$UNDO1"
run_step 0 "undo restores it from the Trash (E15 inverse)" undo

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
