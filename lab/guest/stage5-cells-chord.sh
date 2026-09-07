#!/bin/bash
# CHORD3 + CHORD4 cells — the to-do arrow-chord reorder vector, run ON THE
# GUEST on a routed golden-v4h clone (helpers installed + granted,
# `helpers-enabled true`).
#
# Cells 0-11 are the `index` columns PR 1 migrated (`area-someday`, `anytime`).
# Cells 12-19 are the DAY axis PR 2 adds (`today`, `evening`), including the
# pre-flight entry-cohort fence and the reminder the evening bounce used to
# strip. Both batches share the fixtures, the beep sentinel and the oracles.
#
# NORMAL CLI syntax for everything under test: no direct driver invocation, no
# hand-built things:/// URL for an operation, no osascript standing in for a
# verb. Three deliberate lab escapes are marked LAB-ESCAPE and are all
# PRECONDITIONS or ORACLES, never the thing being measured: reading which app is
# frontmost, putting a different app in front before a drive (both feed the
# tier-0 claim), and applying a tag filter to a view (the fence's precondition).
#
# `things reorder` addresses its movees by UUID or partial-UUID only — never by
# title — so every cell resolves its fixture's uuid from the database first.
#
# Usage: stage5-cells-chord.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
DEPUTY_LOG="$HOME/.local/state/things-api/deputy/deputy.log"
AUDIT_DIR="$HOME/.local/state/things-api/audit"
FAILURES=0
STEP=0
TAG="CH3"

BEEP_SENTINEL="$(dirname "$0")/beep-sentinel.sh"
export BEEP_MARKS="$HOME/things-lab/chord-beep-marks.tsv"
beep() { [ -f "$BEEP_SENTINEL" ] || return 0; bash "$BEEP_SENTINEL" "$@"; }
beep reset; beep mark "chord cells start"

things() { "$NODE" "$APP" "$@"; }

fail() { echo "FAIL $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   $*"; }

# One read-only SQLite query against the live database (the DB oracle).
dbq() {
  python3 -c "
import glob, os, sqlite3, sys
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
for row in c.execute(sys.argv[1]).fetchall():
    print('|'.join('' if v is None else str(v) for v in row))
" "$1"
}

# The area-less loose ANYTIME column, in index order (the `anytime` scope's
# member predicate, transcribed).
anytime_order() {
  dbq "SELECT title FROM TMTask WHERE type=0 AND trashed=0 AND status=0
       AND project IS NULL AND area IS NULL AND heading IS NULL
       AND start=1 AND startDate IS NULL AND title LIKE '$TAG-A%'
       ORDER BY \"index\"" | tr '\n' ' '
}

# One area's SOMEDAY column, in index order (the `area-someday` predicate).
someday_order() {
  dbq "SELECT t.title FROM TMTask t JOIN TMArea a ON t.area=a.uuid
       WHERE t.type=0 AND t.trashed=0 AND t.status=0 AND t.heading IS NULL
       AND t.start=2 AND t.startDate IS NULL AND a.title='$TAG-AREA'
       ORDER BY t.\"index\"" | tr '\n' ' '
}

# Every umd in the fixture set — the crossing tripwire (CHORD2 §6a: a pure rank
# move stamps none of them).
umd_digest() {
  dbq "SELECT title || ':' || COALESCE(userModificationDate,'') FROM TMTask
       WHERE trashed=0 AND title LIKE '$TAG-%' ORDER BY title" | tr '\n' ' '
}

uuid_of() { dbq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 LIMIT 1" | head -1; }

# LAB-ESCAPE (oracle): which app has the focus.
frontmost() {
  osascript -e 'tell application "System Events" to name of first application process whose frontmost is true' 2>/dev/null
}
# LAB-ESCAPE (precondition): put an app that is NOT Things in front, so a drive
# that steals focus is visible as a change rather than hidden by Things already
# being frontmost.
front_finder() { osascript -e 'tell application "Finder" to activate' >/dev/null 2>&1; sleep 2; }

# The vector + result the audit trail records for the LAST write.
last_audit() {
  python3 -c "
import glob, json, os, sys
files = sorted(glob.glob(os.path.expanduser('$AUDIT_DIR/*.jsonl')))
rec = None
for f in files:
    for line in open(f):
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get('op') == 'reorder' and d.get('result') != 'intent':
            rec = d
print('' if rec is None else '%s %s' % (rec.get('vector',''), rec.get('result','')))
"
}

# run_cell <expected-exit> <name> -- <cli args...>
run_cell() {
  local expect="$1" name="$2"; shift 2
  STEP=$((STEP + 1))
  beep mark "[$STEP] $name"
  local t0 t1 out code
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  out=$(things "$@" --json 2>/dev/null); code=$?
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  LAST_OUT="$out"; LAST_CODE=$code; LAST_WALL=$((t1 - t0))
  printf '%s\n' "$out" >"$OUT/$name.json"
  if [ "$code" -ne "$expect" ]; then
    fail "[$STEP] $name — exit $code (expected $expect) wall=${LAST_WALL}ms"
    echo "     output: $(head -c 900 <<<"$out")"
    return 1
  fi
  pass "[$STEP] $name — exit $code wall=${LAST_WALL}ms"
  return 0
}

echo "############################################################"
echo "# CHORD3 + CHORD4 — the to-do arrow-chord reorder vector, routed guest"
echo "# clock: $(date)"
echo "############################################################"

########################################################################
echo ""
echo "===== CELL 0 — routed identity + the GUI opt-in ====="
########################################################################
things helpers status 2>/dev/null | tee "$OUT/00-helpers-status.txt" | sed 's/^/     | /'
things config set ui-enabled true >/dev/null && pass "ui-enabled on" || fail "could not set ui-enabled"

########################################################################
echo ""
echo "===== CELL 1 — seed the two columns (synthetic) ====="
########################################################################
for n in 1 2 3 4 5; do
  things todo add "$TAG-A$n" --when anytime >/dev/null 2>&1
done
things area add "$TAG-AREA" >/dev/null 2>&1
for n in 1 2 3 4; do
  things todo add "$TAG-S$n" --area "$TAG-AREA" --when someday >/dev/null 2>&1
done
A1=$(uuid_of "$TAG-A1"); A2=$(uuid_of "$TAG-A2"); A3=$(uuid_of "$TAG-A3")
A4=$(uuid_of "$TAG-A4"); A5=$(uuid_of "$TAG-A5")
S1=$(uuid_of "$TAG-S1"); S4=$(uuid_of "$TAG-S4")
echo "     anytime column: $(anytime_order)"
echo "     someday column: $(someday_order)"
[ -n "$A5" ] && pass "anytime column seeded (A5=$A5)" || fail "anytime column is empty"
[ -n "$S4" ] && pass "area-someday column seeded (S4=$S4)" || fail "area-someday column is empty"

########################################################################
echo ""
echo "===== CELL 2 — MOVE UP N (anytime): the last row to the front ====="
########################################################################
UMD_BEFORE=$(umd_digest)
front_finder
FRONT_BEFORE=$(frontmost)
echo "     frontmost before the drive: $FRONT_BEFORE"
# The seed order is A5 A4 A3 A2 A1 (each add front-inserts), so A1 is LAST and
# --start is a genuine four-slot climb.
run_cell 0 "02-anytime-up-n" reorder "$A1" --in anytime --start
FRONT_AFTER=$(frontmost)
echo "     order after: $(anytime_order)"
echo "     audit:       $(last_audit)"
echo "     frontmost:   $FRONT_BEFORE -> $FRONT_AFTER"
case "$(anytime_order)" in
  "$TAG-A1 "*) pass "A1 climbed four slots to the front";;
  *) fail "A1 did not land at the front — $(anytime_order)";;
esac
case "$(last_audit)" in
  "ui ok") pass "the audit trail records vector=ui, result=ok";;
  *) fail "audit says '$(last_audit)', expected 'ui ok'";;
esac
[ "$FRONT_BEFORE" = "$FRONT_AFTER" ] && pass "no focus steal (frontmost stayed $FRONT_BEFORE)" \
  || fail "the drive changed the frontmost app: $FRONT_BEFORE -> $FRONT_AFTER"

########################################################################
echo ""
echo "===== CELL 3 — MOVE DOWN N (anytime): the front row to the end ====="
########################################################################
front_finder
run_cell 0 "03-anytime-down-n" reorder "$A1" --in anytime --end
echo "     order after: $(anytime_order)"
echo "     audit:       $(last_audit)"
echo "     frontmost:   $(frontmost)"
case "$(anytime_order)" in
  *" $TAG-A1 ") pass "A1 descended four slots to the end";;
  *) fail "A1 did not land at the end — $(anytime_order)";;
esac

########################################################################
echo ""
echo "===== CELL 4 — TO TOP / TO BOTTOM (area-someday) ====="
########################################################################
front_finder
run_cell 0 "04a-someday-to-top" reorder "$S4" --in "$TAG-AREA" --start
echo "     order after: $(someday_order)"
echo "     audit:       $(last_audit)"
case "$(someday_order)" in
  "$TAG-S4 "*) pass "S4 landed at the top of the area's someday order";;
  *) fail "S4 did not land at the top — $(someday_order)";;
esac
run_cell 0 "04b-someday-to-bottom" reorder "$S4" --in "$TAG-AREA" --end
echo "     order after: $(someday_order)"
echo "     audit:       $(last_audit)"
case "$(someday_order)" in
  *" $TAG-S4 ") pass "S4 landed at the bottom";;
  *) fail "S4 did not land at the bottom — $(someday_order)";;
esac

########################################################################
echo ""
echo "===== CELL 5 — the umd tripwire: a pure reorder stamps nothing ====="
########################################################################
UMD_AFTER=$(umd_digest)
if [ "$UMD_BEFORE" = "$UMD_AFTER" ]; then
  pass "no fixture row's modification date changed across four reorders (CHORD2 §6a)"
else
  fail "a modification date moved — a chord did more than re-rank"
  echo "     before: $UMD_BEFORE"
  echo "     after:  $UMD_AFTER"
fi

########################################################################
echo ""
echo "===== CELL 6 — a CROSS-BUCKET request is REFUSED ====="
########################################################################
# One area-someday row and one area-less anytime row are members of two
# different columns; no single reorder reaches both.
run_cell 2 "06a-cross-bucket-in-area" reorder "$S1" "$A1" --in "$TAG-AREA"
echo "     detail: $(head -c 400 <<<"$LAST_OUT")"
run_cell 4 "06b-cross-bucket-bare" reorder "$S1" "$A1"
echo "     detail: $(head -c 400 <<<"$LAST_OUT")"

########################################################################
echo ""
echo "===== CELL 7 — a REPEATING TEMPLATE is REFUSED ====="
########################################################################
front_finder
things todo add-repeating "$TAG-TMPL" --frequency weekly --interval 1 --when 2026-07-10 \
  --dangerously-drive-gui --verify-timeout 90000 >/dev/null 2>&1
TMPL=$(dbq "SELECT uuid FROM TMTask WHERE title='$TAG-TMPL' AND rt1_recurrenceRule IS NOT NULL LIMIT 1" | head -1)
if [ -z "$TMPL" ]; then
  echo "     (no template minted — the repeat drive did not land; cell skipped)"
else
  echo "     template: $TMPL  (start=$(dbq "SELECT start FROM TMTask WHERE uuid='$TMPL'"))"
  # Named onto the anytime axis: refused at the axis check, before any scope.
  run_cell 2 "07a-template-wrong-axis" reorder "$TMPL" --in anytime
  echo "     detail: $(head -c 400 <<<"$LAST_OUT")"
  # Named onto its OWN index axis: refused as a non-member (the same
  # NOT_TEMPLATE_ROW predicate the chord columns are built on).
  run_cell 4 "07b-template-refused" reorder "$TMPL" --in someday
  echo "     detail: $(head -c 400 <<<"$LAST_OUT")"
fi

########################################################################
echo ""
echo "===== CELL 8 — a FILTERED view ====="
########################################################################
things tag add "$TAG-T" >/dev/null 2>&1
things todo set-tags "$TAG-A2" "$TAG-T" >/dev/null 2>&1
# LAB-ESCAPE (precondition): apply a tag filter to the Anytime view the way
# CHORD2 §4bf did. This is the state the fence exists for, not the operation.
osascript -e "open location \"things:///show?id=anytime&filter=$TAG-T\"" >/dev/null 2>&1
sleep 3
front_finder
BEFORE_FILTER=$(anytime_order)
run_cell 0 "08-filtered-probe" reorder "$A1" --in anytime --start
echo "     exit=$LAST_CODE"
echo "     order before: $BEFORE_FILTER"
echo "     order after:  $(anytime_order)"
echo "     detail: $(head -c 600 <<<"$LAST_OUT")"
echo "     (VERDICT RECORDED EITHER WAY: refusing is the fence working; landing"
echo "      correctly means the recipe's own reveal clears the filter first.)"

########################################################################
echo ""
echo "===== CELL 9 — the FALLBACK: ui off, the bounce lands it ====="
########################################################################
things config set ui-enabled false >/dev/null
A3NOW=$(anytime_order)
run_cell 0 "09-fallback-bounce" reorder "$A3" --in anytime --start
echo "     order before: $A3NOW"
echo "     order after:  $(anytime_order)"
echo "     audit:        $(last_audit)"
case "$(anytime_order)" in
  "$TAG-A3 "*) pass "the bounce landed the same order with the chord vector off";;
  *) fail "the fallback did not land the order — $(anytime_order)";;
esac
case "$(last_audit)" in
  "url-scheme ok") pass "the audit trail records vector=url-scheme";;
  *) fail "fallback audit says '$(last_audit)', expected 'url-scheme ok'";;
esac
things config set ui-enabled true >/dev/null

########################################################################
echo ""
echo "===== CELL 10 — UNDO a chord reorder ====="
########################################################################
front_finder
BEFORE_MOVE=$(anytime_order)
run_cell 0 "10a-undo-seed" reorder "$A4" --in anytime --start
AFTER_MOVE=$(anytime_order)
TOKEN=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(((d.get('data') or {}).get('placement') or {}).get('undoToken',''))
" <<<"$LAST_OUT")
echo "     before the move: $BEFORE_MOVE"
echo "     after the move:  $AFTER_MOVE"
echo "     undo token:      $TOKEN"
echo "     audit:           $(last_audit)"
if [ -z "$TOKEN" ]; then
  fail "the chord reorder returned no undo token"
else
  run_cell 0 "10b-undo" undo --txn "$TOKEN"
  echo "     after the undo:  $(anytime_order)"
  if [ "$(anytime_order)" = "$BEFORE_MOVE" ]; then
    pass "undo restored the order the move started from"
  elif [ "$(anytime_order)" = "$AFTER_MOVE" ]; then
    fail "undo changed nothing"
  else
    fail "undo landed a third order: $(anytime_order)"
  fi
fi

########################################################################
echo ""
echo "===== CELL 11 — latency: one chord op, warm ====="
########################################################################
front_finder
run_cell 0 "11a-latency-one-slot" reorder "$A2" --in anytime --end
echo "     one-slot reorder wall: ${LAST_WALL}ms  order: $(anytime_order)"
run_cell 0 "11b-latency-four-slots" reorder "$A2" --in anytime --start
echo "     four-slot reorder wall: ${LAST_WALL}ms  order: $(anytime_order)"

########################################################################
#  THE DAY AXIS — CHORD4's `today` / `evening` columns (PR 2)
#
#  The clock is pinned to 2026-07-05 and the golden's own baked Today rows
#  entered Today on EARLIER days, so the clone arrives with a genuine
#  multi-cohort Today list — which is what cell 13 needs. The synthetic
#  `CH3-T*` / `CH3-EV*` rows all enter today, forming the newest cohort.
#
#  CELL ORDER MATTERS HERE. Every cell that lets the BOUNCE run on the today
#  axis re-stamps the named rows' entry cohorts forward to today (TODWIRE), so
#  the cells that assert the cohort structure run FIRST and the two that let the
#  bounce have it run last.
########################################################################

# The rendered Today-PROPER section, in the VISIBLE comparator's order (the
# column the chord counts slots in — `todayOrderBy`, not the rank column).
TODAY_ORDER_BY="startBucket ASC, COALESCE(todayIndexReferenceDate, startDate, deadline) DESC, todayIndex ASC, uuid ASC"
today_column() {
  dbq "SELECT title FROM TMTask WHERE trashed=0 AND status=0 AND type IN (0,1)
       AND rt1_recurrenceRule IS NULL AND repeater IS NULL
       AND ((startDate IS NOT NULL AND startDate <= 132805248 AND start IN (1,2))
            OR (deadline IS NOT NULL AND deadline <= 132805248 AND startDate IS NULL
                AND (deadlineSuppressionDate IS NULL OR deadlineSuppressionDate < deadline)))
       AND NOT (startBucket = 1 AND startDate = 132805248)
       ORDER BY $TODAY_ORDER_BY" | tr '\n' ' '
}
# The LIVE This Evening section, same comparator.
evening_column() {
  dbq "SELECT title FROM TMTask WHERE trashed=0 AND status=0 AND type IN (0,1)
       AND rt1_recurrenceRule IS NULL AND repeater IS NULL
       AND startBucket = 1 AND startDate = 132805248 AND start IN (1,2)
       ORDER BY $TODAY_ORDER_BY" | tr '\n' ' '
}
# Every day-axis row's entry cohort — the fence's subject. Ordered by UUID, not
# by the comparator: this digest answers "did any row's entry group change?",
# and a reorder is supposed to change the display order.
cohorts() {
  dbq "SELECT uuid || '/' || title || '=' || COALESCE(todayIndexReferenceDate, startDate, deadline, 'null')
       FROM TMTask WHERE trashed=0 AND status=0 AND type IN (0,1)
       AND rt1_recurrenceRule IS NULL AND repeater IS NULL
       AND ((startDate IS NOT NULL AND startDate <= 132805248 AND start IN (1,2))
            OR (deadline IS NOT NULL AND deadline <= 132805248 AND startDate IS NULL))
       ORDER BY uuid" | tr '\n' ' '
}
# How many distinct entry cohorts the Today-proper section holds right now.
cohort_count() {
  dbq "SELECT COUNT(DISTINCT COALESCE(todayIndexReferenceDate, startDate, deadline))
       FROM TMTask WHERE trashed=0 AND status=0 AND type IN (0,1)
       AND rt1_recurrenceRule IS NULL AND repeater IS NULL AND startBucket = 0
       AND startDate IS NOT NULL AND startDate <= 132805248 AND start IN (1,2)" | head -1
}
# One row's reminderTime — the column R07 says the evening bounce's away leg
# strips and the chord does not touch.
reminder_of() { dbq "SELECT COALESCE(reminderTime,'none') FROM TMTask WHERE uuid='$1'" | head -1; }
# The first row of an OLDER Today cohort — the cross-cohort fence's subject.
older_cohort_row() {
  dbq "SELECT uuid FROM TMTask WHERE trashed=0 AND status=0 AND type IN (0,1)
       AND rt1_recurrenceRule IS NULL AND repeater IS NULL AND startBucket = 0
       AND startDate IS NOT NULL AND startDate <= 132805248 AND start IN (1,2)
       AND COALESCE(todayIndexReferenceDate, startDate, deadline) <
           (SELECT MAX(COALESCE(todayIndexReferenceDate, startDate, deadline)) FROM TMTask
            WHERE trashed=0 AND status=0 AND type IN (0,1) AND startBucket = 0
            AND startDate IS NOT NULL AND startDate <= 132805248 AND start IN (1,2))
       ORDER BY $TODAY_ORDER_BY LIMIT 1" | head -1
}
title_of() { dbq "SELECT title FROM TMTask WHERE uuid='$1'" | head -1; }
has_disclosure() {
  grep -qi 'keyboard-shortcut reorder could not run here' <<<"$LAST_OUT" && echo yes || echo no
}

########################################################################
echo ""
echo "===== CELL 12 — seed the Today / This Evening columns ====="
########################################################################
for n in 1 2 3 4; do
  things todo add "$TAG-T$n" --when today >/dev/null 2>&1
done
things todo add "$TAG-EV1" --when evening --reminder 20:00 >/dev/null 2>&1
things todo add "$TAG-EV2" --when evening --reminder 21:30 >/dev/null 2>&1
T1=$(uuid_of "$TAG-T1"); T2=$(uuid_of "$TAG-T2"); T3=$(uuid_of "$TAG-T3"); T4=$(uuid_of "$TAG-T4")
EV1=$(uuid_of "$TAG-EV1"); EV2=$(uuid_of "$TAG-EV2")
echo "     Today column:   $(today_column)"
echo "     Evening column: $(evening_column)"
echo "     cohorts:        $(cohorts)"
echo "     distinct Today entry cohorts: $(cohort_count)"
[ -n "$T4" ] && pass "Today column seeded (T4=$T4)" || fail "Today column is empty"
[ -n "$EV2" ] && pass "This Evening column seeded (EV2=$EV2)" || fail "evening column is empty"
[ "$(cohort_count)" -ge 2 ] && pass "the clone's Today list spans $(cohort_count) entry cohorts (the fence has something to fence)" \
  || fail "only one entry cohort — cells 13/13c cannot exercise the boundary"
REM_EV1_SEED=$(reminder_of "$EV1"); REM_EV2_SEED=$(reminder_of "$EV2")
echo "     reminders: EV1=$REM_EV1_SEED EV2=$REM_EV2_SEED"

########################################################################
echo ""
echo "===== CELL 13 — a CROSS-COHORT position is REFUSED PRE-FLIGHT ====="
########################################################################
# Runs FIRST of the day-axis cells: it is the only one that needs the clone's
# multi-cohort Today list intact, and every bounce below collapses it.
OLD=$(older_cohort_row)
ORDER_BEFORE=$(today_column); COHORTS_BEFORE=$(cohorts)
if [ -z "$OLD" ]; then
  fail "no older-cohort Today row in this clone — cell 13 measured nothing"
else
  echo "     older-group row: $(title_of "$OLD") ($OLD)"
  # (a) with the schedule round-trip OFF there is nothing to fall back to: the
  #     refusal stands, names the group, and NOTHING is moved.
  things config set bounce-enabled false >/dev/null
  front_finder
  run_cell 4 "13a-cross-cohort-refused" reorder "$OLD" --in today --start
  echo "     detail: $(head -c 700 <<<"$LAST_OUT")"
  grep -qi 'entry group' <<<"$LAST_OUT" && pass "the refusal names the Today entry group" \
    || fail "the refusal does not name the entry group"
  [ "$(today_column)" = "$ORDER_BEFORE" ] && pass "nothing moved (zero chords)" \
    || fail "the refused request still changed the order — $(today_column)"
  [ "$(cohorts)" = "$COHORTS_BEFORE" ] && pass "no row was re-dated on a refused request" \
    || fail "a row's entry group changed on a REFUSED request"
  things config set bounce-enabled true >/dev/null
fi

########################################################################
echo ""
echo "===== CELL 13c — --end on a multi-cohort Today list is the SAME refusal ====="
########################################################################
# "put this row at the bottom of Today" means "below the rows that entered
# Today earlier", which is a cross-group position by construction. Recorded
# because it is the shape a caller is most likely to type into it.
things config set bounce-enabled false >/dev/null
ORDER_BEFORE=$(today_column)
front_finder
run_cell 4 "13c-today-end-crosses-groups" reorder "$T1" --in today --end
echo "     detail: $(head -c 500 <<<"$LAST_OUT")"
[ "$(today_column)" = "$ORDER_BEFORE" ] && pass "nothing moved" || fail "the refusal still moved something"
things config set bounce-enabled true >/dev/null

########################################################################
echo ""
echo "===== CELL 14 — MOVE within TODAY's own entry group ====="
########################################################################
UMD_T_BEFORE=$(umd_digest)
COHORTS_BEFORE=$(cohorts)
front_finder
FRONT_BEFORE=$(frontmost)
# The seed front-inserts, so the column reads T4 T3 T2 T1 …: T1 is the last of
# the new cohort and --start is a genuine three-slot climb INSIDE it.
run_cell 0 "14a-today-up-n" reorder "$T1" --in today --start
FRONT_AFTER=$(frontmost)
echo "     order after: $(today_column)"
echo "     audit:       $(last_audit)"
echo "     frontmost:   $FRONT_BEFORE -> $FRONT_AFTER"
case "$(today_column)" in
  "$TAG-T1 "*) pass "T1 climbed to the top of Today";;
  *) fail "T1 did not land at the top — $(today_column)";;
esac
case "$(last_audit)" in
  "ui ok") pass "the audit trail records vector=ui, result=ok";;
  *) fail "audit says '$(last_audit)', expected 'ui ok'";;
esac
[ "$FRONT_BEFORE" = "$FRONT_AFTER" ] && pass "no focus steal (frontmost stayed $FRONT_BEFORE)" \
  || fail "the drive changed the frontmost app: $FRONT_BEFORE -> $FRONT_AFTER"

# …and back down, anchored on a row in the SAME group (`--end` would ask for a
# position below an older group — cell 13c).
front_finder
run_cell 0 "14b-today-after-anchor" reorder "$T1" --in today --after "$T3"
echo "     order after: $(today_column)"
echo "     audit:       $(last_audit)"
case "$(today_column)" in
  *"$TAG-T3 $TAG-T1 "*) pass "T1 landed immediately after T3, inside the group";;
  *) fail "T1 did not land after T3 — $(today_column)";;
esac
case "$(last_audit)" in
  "ui ok") pass "the anchored placement also ran on the chord";;
  *) fail "audit says '$(last_audit)', expected 'ui ok'";;
esac

echo "     cohorts:     $(cohorts)"
if [ "$(cohorts)" = "$COHORTS_BEFORE" ]; then
  pass "no row's Today entry group changed across two chord reorders (CHORD4)"
else
  fail "an entry group moved — a chord re-dated a row"
  echo "     before: $COHORTS_BEFORE"
  echo "     after:  $(cohorts)"
fi
UMD_T_AFTER=$(umd_digest)
[ "$UMD_T_BEFORE" = "$UMD_T_AFTER" ] && pass "no fixture row's modification date changed" \
  || { fail "a modification date moved on the day axis"; echo "     before: $UMD_T_BEFORE"; echo "     after:  $UMD_T_AFTER"; }

########################################################################
echo ""
echo "===== CELL 15 — the This Evening TOP edge is REFUSED ====="
########################################################################
# A ⌘↑ from the first evening row clears startBucket and carries the row into
# the daytime section (CHORD2 §4be2, reconfirmed by CHORD4). The only request
# that asks for it is "put this evening row in Today proper", and that is
# refused at the scope's own membership check — before any vector is chosen.
ORDER_BEFORE=$(today_column); EVE_BEFORE=$(evening_column)
front_finder
things reorder "$EV1" --in today --start --json >"$OUT/15-evening-top-edge.json" 2>/dev/null
EDGE_CODE=$?
LAST_OUT=$(cat "$OUT/15-evening-top-edge.json")
echo "     exit: $EDGE_CODE"
echo "     detail: $(head -c 500 <<<"$LAST_OUT")"
if [ "$EDGE_CODE" -eq 0 ]; then
  fail "an evening row was accepted onto the Today axis — the section edge is unfenced"
else
  pass "refused (exit $EDGE_CODE)"
fi
grep -qi 'evening' <<<"$LAST_OUT" && pass "the refusal names the evening section" || fail "the refusal does not mention evening"
[ "$(evening_column)" = "$EVE_BEFORE" ] && [ "$(today_column)" = "$ORDER_BEFORE" ] \
  && pass "neither section moved" || fail "the refused request changed a section"

########################################################################
echo ""
echo "===== CELL 16 — an evening reorder on the chord, reminders asserted ====="
########################################################################
front_finder
EVE_BEFORE=$(evening_column)
# The seed front-inserts, so EV2 is first and EV1 last: --start is a real chord.
run_cell 0 "16a-evening-chord" reorder "$EV1" --in evening --start
echo "     evening before: $EVE_BEFORE"
echo "     evening after:  $(evening_column)"
echo "     audit:          $(last_audit)"
case "$(evening_column)" in
  "$TAG-EV1 "*) pass "EV1 moved to the top of This Evening";;
  *) fail "EV1 did not move — $(evening_column)";;
esac
case "$(last_audit)" in
  "ui ok") pass "the audit trail records vector=ui";;
  *) fail "audit says '$(last_audit)', expected 'ui ok'";;
esac
REM_EV1_CHORD=$(reminder_of "$EV1"); REM_EV2_CHORD=$(reminder_of "$EV2")
echo "     reminders after the chord: EV1=$REM_EV1_CHORD EV2=$REM_EV2_CHORD"
if [ "$REM_EV1_SEED" = "$REM_EV1_CHORD" ] && [ "$REM_EV2_SEED" = "$REM_EV2_CHORD" ]; then
  pass "reminderTime byte-identical on both evening rows after the chord"
else
  fail "the chord changed a reminder: EV1 $REM_EV1_SEED->$REM_EV1_CHORD, EV2 $REM_EV2_SEED->$REM_EV2_CHORD"
fi

# THE R07 QUESTION, measured rather than assumed: does the evening BOUNCE still
# strip reminderTime on this build? Same move, same rows, chord vector off.
things config set ui-enabled false >/dev/null
front_finder
run_cell 0 "16b-evening-bounce-contrast" reorder "$EV2" --in evening --start
REM_EV1_BOUNCE=$(reminder_of "$EV1"); REM_EV2_BOUNCE=$(reminder_of "$EV2")
echo "     evening after:  $(evening_column)"
echo "     audit:          $(last_audit)"
echo "     reminders after the BOUNCE: EV1=$REM_EV1_BOUNCE EV2=$REM_EV2_BOUNCE"
if [ "$REM_EV2_CHORD" = "$REM_EV2_BOUNCE" ]; then
  echo "     *** R07 DID NOT REPRODUCE: the evening bounce PRESERVED the moved row's reminder ***"
else
  echo "     *** R07 REPRODUCED: the evening bounce cleared the moved row's reminder ***"
fi
echo "     (MEASUREMENT, not an assertion — the verdict is recorded either way.)"
things config set ui-enabled true >/dev/null

########################################################################
echo ""
echo "===== CELL 17 — the day-axis FALLBACK: ui off, the bounce lands it ====="
########################################################################
things config set ui-enabled false >/dev/null
BEFORE=$(today_column)
run_cell 0 "17-today-fallback-bounce" reorder "$T2" --in today --start
echo "     order before: $BEFORE"
echo "     order after:  $(today_column)"
echo "     audit:        $(last_audit)"
case "$(today_column)" in
  "$TAG-T2 "*) pass "the bounce landed the same order with the chord vector off";;
  *) fail "the fallback did not land the order — $(today_column)";;
esac
case "$(last_audit)" in
  "url-scheme ok") pass "the audit trail records vector=url-scheme";;
  *) fail "fallback audit says '$(last_audit)', expected 'url-scheme ok'";;
esac
things config set ui-enabled true >/dev/null

########################################################################
echo ""
echo "===== CELL 18 — UNDO a Today chord reorder ====="
########################################################################
front_finder
BEFORE_MOVE=$(today_column)
run_cell 0 "18a-undo-seed" reorder "$T4" --in today --start
AFTER_MOVE=$(today_column)
TOKEN=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(((d.get('data') or {}).get('placement') or {}).get('undoToken',''))
" <<<"$LAST_OUT")
echo "     before the move: $BEFORE_MOVE"
echo "     after the move:  $AFTER_MOVE"
echo "     undo token:      $TOKEN"
echo "     audit:           $(last_audit)"
if [ -z "$TOKEN" ]; then
  fail "the Today chord reorder returned no undo token"
else
  run_cell 0 "18b-undo" undo --txn "$TOKEN"
  echo "     after the undo:  $(today_column)"
  if [ "$(today_column)" = "$BEFORE_MOVE" ]; then
    pass "undo restored the Today order the move started from"
  elif [ "$(today_column)" = "$AFTER_MOVE" ]; then
    fail "undo changed nothing"
  else
    fail "undo landed a third order: $(today_column)"
  fi
fi

########################################################################
echo ""
echo "===== CELL 19 — the cross-cohort request FALLS BACK to the bounce ====="
########################################################################
# LAST of the day-axis cells: the bounce expresses a cross-group move by
# re-dating the rows it names FORWARD to today, which collapses the clone's
# cohort structure — so nothing after this can assert it.
OLD=$(older_cohort_row)
if [ -z "$OLD" ]; then
  echo "     (no older cohort left in this clone — cell skipped)"
else
  echo "     older-group row: $(title_of "$OLD") ($OLD)"
  front_finder
  run_cell 0 "19-cross-cohort-falls-back" reorder "$OLD" --in today --start
  echo "     audit:       $(last_audit)"
  echo "     disclosure:  $(has_disclosure)"
  echo "     order after: $(today_column)"
  echo "     cohorts:     $(cohorts)"
  [ "$(has_disclosure)" = "yes" ] && pass "the result discloses reorder-chord-unavailable" \
    || fail "the fallback did not disclose which transport ran"
  case "$(last_audit)" in
    "url-scheme ok") pass "the audit trail records vector=url-scheme";;
    *) fail "audit says '$(last_audit)', expected 'url-scheme ok'";;
  esac
fi

########################################################################
echo ""
echo "===== BEEPS ====="
########################################################################
# `report` is not a sentinel verb — the CHORD3 script called it and the section
# printed nothing on every run. `assert` is the verb, and it FAILS the arm on a
# beep: a certification suite is exactly where an unallowed alert tone is red.
beep assert --name chord-cells 2>&1 | sed 's/^/     | /'
BEEPS=${PIPESTATUS[0]}
[ "${BEEPS:-0}" -eq 0 ] && pass "no unallowed alert beeps in the arm" || fail "alert beep(s) in the arm"
tail -n 60 "$DEPUTY_LOG" 2>/dev/null | grep -i 'reject\|error' | sed 's/^/     deputy| /'

echo ""
echo "############################################################"
if [ "$FAILURES" -eq 0 ]; then
  echo "# CHORD3 + CHORD4 cells GREEN"
else
  echo "# CHORD3 + CHORD4 cells RED — $FAILURES failure(s)"
fi
echo "############################################################"
exit "$FAILURES"
