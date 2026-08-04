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
run_step 0 "project move to another area (E14)" project move "$T2PROJ" --to-area LAB-AREA-B
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
run_step 0 "detach project from its area (P24)" project move "$P19" --no-area
run_step 0 "delete project to the Trash" project delete "$P19"
run_step 0 "restore project IN PLACE (P06)" project restore "$P19"
run_step 4 "project restore requires a TRASHED target (guard)" project restore "$P19"
run_step 0 "seed scheduled to-do in the project" todo add "E2E-DETACH" --project "$P19" --when 2026-07-14
DET=$(json_get "d['data']['uuid']")
run_step 0 "detach keeps the schedule (P21/P22)" todo move "$DET" --loose
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

# Phase-B reorder grammar: kind-neutral `things reorder <refs…> [--in <target>]`
# for to-dos; `things project move <refs…> <position>` for standalone project
# order. The native re-rank is on by default (allow-experimental defaults true),
# so no enabling step. To-do reorders infer their scope from the operands; a
# Today/Evening set is DUAL-AXIS (view vs container index) and REFUSES without --in.
echo "== reorder: to-do grammar (--in axis) + project move order =="
run_step 0 "seed today R1" todo add "E2E-R1" --when today
R1=$(json_get "d['data']['uuid']")
run_step 0 "seed today R2" todo add "E2E-R2" --when today
R2=$(json_get "d['data']['uuid']")
run_step 0 "seed today R3" todo add "E2E-R3" --when today
R3=$(json_get "d['data']['uuid']")
# Dual-axis refusal: a loose Today set is ambiguous (Today view vs the flag-safe
# loose Anytime index, SIT6 LOOSEPARK) — REFUSED without --in (blocked, exit 4).
run_step 4 "loose Today reorder REFUSES without --in (dual-axis ambiguity)" reorder "$R3" "$R1"
# --in disambiguation success: name the Today view axis → native todayIndex re-rank.
run_step 0 "today reorder with --in today (native re-rank, partial list)" reorder "$R3" "$R1" --in today
# Flag-aware routing newly expressible (Phase B): --in anytime reorders the loose
# Anytime index via the flag-safe LOOSEPARK MOVE protocol, preserving the Today flag.
run_step 0 "loose Today reorder with --in anytime (flag-safe LOOSEPARK)" reorder "$R3" "$R1" --in anytime
run_step 0 "seed evening RE1" todo add "E2E-RE1" --when evening
RE1=$(json_get "d['data']['uuid']")
run_step 0 "seed evening RE2" todo add "E2E-RE2" --when evening
RE2=$(json_get "d['data']['uuid']")
# --in today over a mixed today+evening set: the evening member is not a Today
# member on that axis, so it is refused (blocked, exit 4).
run_step 4 "today axis rejects an evening member (mixed views, --in today)" reorder "$RE1" "$R1" --in today
run_step 0 "evening reorder with --in evening (bounce round-trip)" reorder "$RE2" "$RE1" --in evening
run_step 0 "seed project for ordering" project add "E2E-RPROJ"
RPROJ=$(json_get "d['data']['uuid']")
run_step 0 "seed project child P1" todo add "E2E-RP1" --project "$RPROJ"
RP1=$(json_get "d['data']['uuid']")
run_step 0 "seed project child P2" todo add "E2E-RP2" --project "$RPROJ"
RP2=$(json_get "d['data']['uuid']")
# Project CHILDREN (to-dos) share one container + anytime bucket → single-axis, bare.
run_step 0 "project-child reorder (bare, single container)" reorder "$RP2" "$RP1"
run_step 0 "seed area project AP1" project add "E2E-AP1" --area LAB-AREA-A
AP1=$(json_get "d['data']['uuid']")
run_step 0 "seed area project AP2" project add "E2E-AP2" --area LAB-AREA-A
AP2=$(json_get "d['data']['uuid']")
# Standalone PROJECT order is `project move` with a position (native area re-rank, O14).
run_step 0 "area project reorder via project move --first (O14)" project move "$AP2" "$AP1" --first
run_step 0 "seed area to-do for mixed check" todo add "E2E-AT1" --area LAB-AREA-A
AT1=$(json_get "d['data']['uuid']")
# Mixing a to-do and a project is a homogeneous-kinds USAGE error now (exit 2).
run_step 2 "mixed to-do+project reorder is a homogeneous-kinds error" reorder "$AT1" "$AP1"

echo "== reorder: inbox / someday to-dos + someday/sidebar projects + move-heading (§C) =="
run_step 0 "seed inbox I1" todo add "E2E-I1"
I1=$(json_get "d['data']['uuid']")
run_step 0 "seed inbox I2" todo add "E2E-I2"
I2=$(json_get "d['data']['uuid']")
# Inbox to-dos are single-axis (no view) → bare reorder (A6 reversed wire convention).
run_step 0 "native inbox reorder (bare)" reorder "$I2" "$I1"
run_step 0 "seed someday S1" todo add "E2E-S1" --when someday
S1=$(json_get "d['data']['uuid']")
run_step 0 "seed someday S2" todo add "E2E-S2" --when someday
S2=$(json_get "d['data']['uuid']")
# Someday to-dos are single-axis → bare reorder (P6h/P8).
run_step 0 "native someday reorder of loose to-dos (bare)" reorder "$S2" "$S1"
run_step 0 "seed someday project SP1 (area-less)" project add "E2E-SP1" --when someday
SP1=$(json_get "d['data']['uuid']")
run_step 0 "seed someday project SP2 (area-less)" project add "E2E-SP2" --when someday
SP2=$(json_get "d['data']['uuid']")
# Someday PROJECTS reorder via project move --first (P9e descending stack).
run_step 0 "someday project reorder via project move --first (P9e)" project move "$SP2" "$SP1" --first
# Mixing a someday to-do and a someday project is a homogeneous-kinds usage error (exit 2).
run_step 2 "mixed someday to-do+project reorder is a homogeneous-kinds error" reorder "$S1" "$SP1"
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
run_step 0 "native reorder of a project's HEADINGS (scf P1)" project move-heading "$HPROJ" "$H2" "$H1" --first
run_step 0 "seed top-level project TP1" project add "E2E-TP1"
TP1=$(json_get "d['data']['uuid']")
run_step 0 "seed top-level project TP2" project add "E2E-TP2"
TP2=$(json_get "d['data']['uuid']")
# Top-level sidebar PROJECTS reorder via project move --first (someday-bounce round-trip).
run_step 0 "sidebar project reorder via project move --first (bounce)" project move "$TP2" "$TP1" --first

# Phase-B #393: repeating-template day-block wiring. A template's strictly-future
# projection is a first-class day-block todayIndex member — the `day`/`tomorrow`
# scopes place it (o-suite O34-O37 lock the compiled DB behavior; these steps drive
# the SHIPPED CLI end-to-end). Golden pin 2026-07-05: the baked to-do template
# projects 07-06 (== tomorrow), the project template 07-12 (an arbitrary day).
echo "== reorder: repeating-template day-block wiring (#393) =="
TEMPLATE_UUID=$(python3 -c "
import glob, os, sqlite3
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
print(sqlite3.connect(f'file:{db}?mode=ro', uri=True).execute(\"SELECT uuid FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL AND type=0 LIMIT 1\").fetchone()[0])
")
PROJ_TEMPLATE_UUID=$(python3 -c "
import glob, os, sqlite3
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
print(sqlite3.connect(f'file:{db}?mode=ro', uri=True).execute(\"SELECT uuid FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL AND type=1 LIMIT 1\").fetchone()[0])
")
# to-do arm: SCHEDULED + DEADLINE-FORECAST to-dos + the to-do template, all three
# upcoming mechanisms sorted together in ONE --in <day> op (the to-do template rides
# the single-id `list "Upcoming"` native front-insert leg, umd-silent).
run_step 0 "seed GI scheduled to-do (07-06)" todo add "E2E-GI-S1" --when 2026-07-06
GI_S1=$(json_get "d['data']['uuid']")
run_step 0 "seed GI deadline-forecast to-do (07-06)" todo add "E2E-GI-F1" --when someday --deadline 2026-07-06
GI_F1=$(json_get "d['data']['uuid']")
run_step 0 "grand interleave: scheduled+forecast+to-do-template in ONE --in day op" reorder "$GI_F1" "$TEMPLATE_UUID" "$GI_S1" --in 2026-07-06
if grep -q 'userModificationDate-SILENT' <<<"$LAST_OUT"; then
  echo "ok   to-do-template leg discloses the umd-silent warning (§9r)"
else
  echo "FAIL to-do-template interleave missing the umd-silent disclosure"; FAILURES=$((FAILURES + 1))
fi
# #393 gate fix: a MIXED to-do + PROJECT + to-do TEMPLATE day set now interleaves in
# ONE op. Before the fix `globalAxisIntermix` gated only on scheduleBucket/forecast, so
# a template row failed the `.every()` predicate and the whole mixed-kind set was refused
# UPSTREAM ("one kind at a time") before the day-axis resolver ran. Seed a 07-06 scheduled
# PROJECT to join the 07-06 to-dos + template (the project template projects 07-12, a
# different day, so it can't join this 07-06 op — that's why this uses a plain project).
run_step 0 "seed GI scheduled PROJECT (07-06)" project add "E2E-GI-P1" --when 2026-07-06
GI_P1=$(json_get "d['data']['uuid']")
run_step 0 "mixed-kind grand interleave: to-do + PROJECT + to-do-template in ONE op (#393 gate)" reorder "$GI_S1" "$GI_P1" "$TEMPLATE_UUID" "$GI_F1" --in 2026-07-06
if grep -q 'userModificationDate-SILENT' <<<"$LAST_OUT"; then
  echo "ok   mixed-kind interleave accepted (was refused pre-fix) + umd-silent disclosure"
else
  echo "FAIL mixed-kind to-do+project+template interleave refused or missing disclosure"; FAILURES=$((FAILURES + 1))
fi
# project arm: SCHEDULED + DEADLINE-FORECAST projects + the PROJECT template — the
# project template is the byte-untouched SUFFIX (no headless reach on a non-tomorrow
# day). ACCEPT (template last) vs REFUSE (template above a movable, H-REORDER-SCOPE).
run_step 0 "seed GP scheduled project (07-12)" project add "E2E-GP-S1" --when 2026-07-12
GP_S1=$(json_get "d['data']['uuid']")
run_step 0 "seed GP deadline-forecast project (07-12)" project add "E2E-GP-F1" --when someday --deadline 2026-07-12
GP_F1=$(json_get "d['data']['uuid']")
run_step 0 "project-template SUFFIX ACCEPT (template last, byte-untouched)" project move "$GP_F1" "$GP_S1" "$PROJ_TEMPLATE_UUID" --first
if grep -q 'byte-untouched' <<<"$LAST_OUT"; then
  echo "ok   project-template suffix accept discloses the byte-untouched warning"
else
  echo "FAIL project-template suffix accept missing the byte-untouched disclosure"; FAILURES=$((FAILURES + 1))
fi
# Non-conformant suffix: the project template requested ABOVE a movable → refused with
# the ratified H-REORDER-SCOPE copy naming the one achievable arrangement. The block now
# HOISTS to the CANONICAL top-level refusal (blocked → exit 4, code blocked:H-REORDER-
# SCOPE) instead of being buried under a generic verify-failed (exit 3) — the surfacing fix.
run_step 4 "project-template suffix REFUSE (template above a movable)" project move "$GP_S1" "$PROJ_TEMPLATE_UUID" "$GP_F1" --first
if grep -q 'blocked:H-REORDER-SCOPE' <<<"$LAST_OUT" && grep -q 'cannot be placed above a movable' <<<"$LAST_OUT"; then
  echo "ok   non-conformant suffix surfaces the canonical top-level blocked:H-REORDER-SCOPE refusal"
else
  echo "FAIL non-conformant suffix missing the canonical top-level refusal copy/code"; FAILURES=$((FAILURES + 1))
fi
# Experimental-off: a template-bearing day-group needs the native surface (a dated
# when= leg CRASHES a template) — with allow-experimental off it refuses NAMING the
# template, never a crash-path leg. Canonical top-level blocked refusal (exit 4).
things config set allow-experimental false >/dev/null 2>&1
run_step 4 "experimental-off refuses a template day-set (names the template, no crash leg)" reorder "$GI_F1" "$TEMPLATE_UUID" "$GI_S1" --in 2026-07-06
things config set allow-experimental true >/dev/null 2>&1
if grep -q "$TEMPLATE_UUID" <<<"$LAST_OUT" && grep -q 'allow-experimental is off' <<<"$LAST_OUT" && grep -q 'blocked:H-REORDER-SCOPE' <<<"$LAST_OUT"; then
  echo "ok   experimental-off refusal names the template + gate, canonical blocked:H-REORDER-SCOPE"
else
  echo "FAIL experimental-off refusal did not name the template / gate / canonical code"; FAILURES=$((FAILURES + 1))
fi

echo "== suite-audit gap closure: cancel / backdate / add-logged / project tags / heading ops =="
run_step 0 "seed to-do for cancel" todo add "E2E-CANCELME"
CXL=$(json_get "d['data']['uuid']")
run_step 0 "todo cancel" todo cancel "$CXL"
run_step 0 "reopen the canceled to-do" todo reopen "$CXL"
run_step 0 "complete it for backdating" todo complete "$CXL"
run_step 0 "todo backdate (completion + creation, applescript)" todo backdate "$CXL" --completed-on 2025-01-15 --created-on 2024-06-01
run_step 0 "todo add-logged (json at-creation import)" todo add-logged "E2E-LOGGED" --completed-on 2025-03-01 --created-on 2025-02-01
run_step 0 "project tags (full replacement)" project tags "$RPROJ" --set lab-tag-1
run_step 0 "heading rename (project rename-heading, by-uuid sel)" project rename-heading "$HPROJ" "$H1" --to "E2E-H1-RENAMED"
run_step 0 "seed a child under the heading" todo add "E2E-HCHILD" --project "$HPROJ" --heading "E2E-H1-RENAMED"
run_step 4 "heading archive requires a children policy (open child)" project archive-heading "$HPROJ" "$H1"
run_step 0 "heading archive with complete cascade" project archive-heading "$HPROJ" "$H1" --children complete
run_step 0 "heading unarchive with child restore (<2s window)" project unarchive-heading "$HPROJ" "$H1" --restore-children

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
# `changes` data is the R1/R2 items-wrapper shape: {items: [...]}, not a bare list.
if ! json_get "len([i for i in d['data']['items'] if i['title'].startswith('E2E-B')])" | grep -q "^2$"; then
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
# WG-3 (assumption-register): a NON-EMPTY area refuses fail-closed (H-AREA-NOT-EMPTY)
# unless --allow-non-empty. Seed an area with a live to-do, prove the refusal, then
# clear it — the live lock for the area-delete guard + AREADEL child-fate copy.
run_step 0 "area add for non-empty guard" area add "E2E-AREA-NE"
run_step 0 "seed a live to-do in the area" todo add "E2E-AREA-NE-C1" --area "E2E-AREA-NE"
run_step 4 "non-empty area delete refuses without --allow-non-empty (H-AREA-NOT-EMPTY)" area delete "E2E-AREA-NE" --dangerously-permanent
run_step 0 "non-empty area delete clears with --allow-non-empty" area delete "E2E-AREA-NE" --dangerously-permanent --allow-non-empty
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
