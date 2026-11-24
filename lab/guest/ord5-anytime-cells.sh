#!/bin/bash
# ORD-5 field-shaped cells — `things reorder … --in anytime` (and the heading
# bounce that took the same ruling) THROUGH THE DEPUTY with NORMAL CLI syntax,
# GUI off (the sequential bounce) and GUI on (the chord vector). Run ON THE GUEST
# by lab/scripts/stage5-rc-run.sh on a routed golden (helpers installed + granted).
#
# No hand-built wire anywhere: every write is a `things …` command. The oracles
# are read-only SQLite queries, and every cell compares the WHOLE loose Anytime
# column (not just this script's rows), because the bounce must land the moved
# block at the edge of the whole column — the exact claim ORD-5's column verify
# now makes before it exits 0.
#
# Timings (wall, ms) are printed per cell; the ruling traded the json collapse's
# speed away, so the N=1 and N=5 GUI-off numbers are the ones to record.
#
# Usage: ord5-anytime-cells.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
AUDIT_DIR="$HOME/.local/state/things-api/audit"
FAILURES=0
STEP=0
TAG="O5"

BEEP_SENTINEL="$(dirname "$0")/beep-sentinel.sh"
export BEEP_MARKS="$HOME/things-lab/ord5-beep-marks.tsv"
beep() { [ -f "$BEEP_SENTINEL" ] || return 0; bash "$BEEP_SENTINEL" "$@"; }
beep reset; beep mark "ord5 cells start"

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
uuid_of() { dbq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 LIMIT 1" | head -1; }

# The WHOLE area-less loose Anytime column (the `anytime` scope's predicate).
column() {
  dbq "SELECT title FROM TMTask WHERE type=0 AND trashed=0 AND status=0
       AND project IS NULL AND area IS NULL AND heading IS NULL
       AND start=1 AND startDate IS NULL AND rt1_recurrenceRule IS NULL
       ORDER BY \"index\"" | tr '\n' ' '
}
# One heading's anytime children, in index order.
heading_column() {
  dbq "SELECT title FROM TMTask WHERE type=0 AND trashed=0 AND status=0 AND start=1
       AND startDate IS NULL AND heading='$1' ORDER BY \"index\"" | tr '\n' ' '
}

last_audit() {
  python3 -c "
import glob, json, os
rec = None
for f in sorted(glob.glob(os.path.expanduser('$AUDIT_DIR/*.jsonl'))):
    for line in open(f):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get('op') == 'reorder' and d.get('result') != 'intent' and (d.get('txn') or {}).get('role') != 'leg':
            rec = d
print('' if rec is None else '%s %s' % (rec.get('vector',''), rec.get('result','')))
"
}

# run_cell <expected-exit> <name> <cli args...>
run_cell() {
  local expect="$1" name="$2"; shift 2
  STEP=$((STEP + 1))
  beep mark "[$STEP] $name"
  local t0 t1 out code
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  out=$(things "$@" --json 2>/dev/null); code=$?
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  LAST_OUT="$out"; LAST_WALL=$((t1 - t0))
  printf '%s\n' "$out" >"$OUT/$name.json"
  if [ "$code" -ne "$expect" ]; then
    fail "[$STEP] $name — exit $code (expected $expect) wall=${LAST_WALL}ms"
    echo "     output: $(head -c 900 <<<"$out")"
    return 1
  fi
  pass "[$STEP] $name — exit $code wall=${LAST_WALL}ms"
  return 0
}

# expect_column <label> <expected column string> <actual column string>
expect_column() {
  if [ "$2" = "$3" ]; then pass "$1 — column as planned"; else
    fail "$1 — column differs"; echo "     expected: $2"; echo "     actual:   $3"; fi
}

# The planned column for `<movees…> --start` / `--after <anchor>` / `--before`, from a before-column.
plan() {
  python3 - "$@" <<'PY'
import sys
mode, before, rest = sys.argv[1], sys.argv[2].split(), sys.argv[3:]
if mode == "start":
    print(" ".join(rest + [t for t in before if t not in rest]) + " ")
elif mode in ("after", "before"):
    anchor, movees = rest[0], rest[1:]
    out = [t for t in before if t not in movees]
    k = out.index(anchor) + (1 if mode == "after" else 0)
    print(" ".join(out[:k] + movees + out[k:]) + " ")
elif mode == "end":
    print(" ".join([t for t in before if t not in rest] + rest) + " ")
PY
}

echo "############################################################"
echo "# ORD-5 — anytime / heading reorder through the deputy, normal CLI syntax"
echo "# Things $(defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString) ($(defaults read /Applications/Things3.app/Contents/Info CFBundleVersion))  clock: $(date)"
echo "############################################################"
things helpers status 2>/dev/null | tee "$OUT/00-helpers-status.txt" | sed 's/^/     | /'

echo ""
echo "===== SEED (synthetic) ====="
for n in 1 2 3 4 5 6; do things todo add "$TAG-A$n" --when anytime >/dev/null 2>&1; done
things project add "$TAG-P" >/dev/null 2>&1
things project add-heading "$TAG-P" "$TAG-H" >/dev/null 2>&1
HEAD_UUID=$(dbq "SELECT uuid FROM TMTask WHERE title='$TAG-H' AND type=2 AND trashed=0 LIMIT 1")
for n in 1 2 3 4 5; do things todo add "$TAG-c$n" --project "$TAG-P" --heading "$TAG-H" >/dev/null 2>&1; done
echo "     loose column:   $(column)"
echo "     heading column: $(heading_column "$HEAD_UUID")"
[ -n "$(uuid_of "$TAG-A6")" ] && pass "loose column seeded" || fail "loose column not seeded"
[ "$(heading_column "$HEAD_UUID" | wc -w | tr -d ' ')" = 5 ] && pass "heading seeded with 5 children" || fail "heading not seeded"

########################################################################
echo ""
echo "===== GUI OFF — the sequential bounce (ORD-5) ====="
########################################################################
things config set ui-enabled false >/dev/null

run_cell 0 "01-dry-run" reorder "$(uuid_of "$TAG-A3")" --in anytime --start --dry-run
case "$LAST_OUT" in
  *json-collapse*) fail "dry-run still plans a json collapse";;
  *"bounce ×1"*) pass "dry-run plans the sequential bounce (bounce ×1, 2 legs)";;
  *) fail "dry-run plan not recognised: $(head -c 300 <<<"$LAST_OUT")";;
esac

B=$(column); W=$(plan start "$B" "$TAG-A3")
run_cell 0 "02-off-single-start" reorder "$(uuid_of "$TAG-A3")" --in anytime --start
echo "     N=1 wall: ${LAST_WALL}ms  audit: $(last_audit)"
expect_column "02 single --start" "$W" "$(column)"
[ "$(last_audit)" = "url-scheme ok" ] && pass "02 audit url-scheme ok" || fail "02 audit '$(last_audit)'"

B=$(column); W=$(plan start "$B" "$TAG-A1" "$TAG-A5" "$TAG-A2")
run_cell 0 "03-off-multi-start" reorder "$(uuid_of "$TAG-A1")" "$(uuid_of "$TAG-A5")" "$(uuid_of "$TAG-A2")" --in anytime --start
echo "     N=3 wall: ${LAST_WALL}ms"
expect_column "03 multi --start" "$W" "$(column)"

B=$(column); W=$(plan after "$B" "$TAG-A5" "$TAG-A6")
run_cell 0 "04-off-anchored-after" reorder "$(uuid_of "$TAG-A6")" --after "$(uuid_of "$TAG-A5")" --in anytime
echo "     anchored wall: ${LAST_WALL}ms  touched: $(python3 -c 'import json,sys;d=json.loads(sys.stdin.read());print(len(((d.get("data") or {}).get("placement") or d.get("data") or {}).get("touched") or []))' <<<"$LAST_OUT" 2>/dev/null)"
expect_column "04 anchored --after" "$W" "$(column)"

B=$(column); W=$(plan before "$B" "$TAG-A1" "$TAG-A4")
run_cell 0 "05-off-anchored-before" reorder "$(uuid_of "$TAG-A4")" --before "$(uuid_of "$TAG-A1")" --in anytime
expect_column "05 anchored --before" "$W" "$(column)"

B=$(column); W=$(plan start "$B" "$TAG-A6" "$TAG-A5" "$TAG-A4" "$TAG-A3" "$TAG-A2")
run_cell 0 "06-off-n5-start" reorder "$(uuid_of "$TAG-A6")" "$(uuid_of "$TAG-A5")" "$(uuid_of "$TAG-A4")" "$(uuid_of "$TAG-A3")" "$(uuid_of "$TAG-A2")" --in anytime --start
echo "     N=5 wall: ${LAST_WALL}ms"
expect_column "06 N=5 --start" "$W" "$(column)"

B=$(heading_column "$HEAD_UUID"); W=$(plan end "$B" "$TAG-c1")
run_cell 0 "07-off-heading-end" reorder "$(uuid_of "$TAG-c1")" --in "$HEAD_UUID" --end
echo "     heading N=1 wall: ${LAST_WALL}ms"
expect_column "07 heading single --end" "$W" "$(heading_column "$HEAD_UUID")"

B=$(heading_column "$HEAD_UUID"); W=$(plan before "$B" "$TAG-c2" "$TAG-c5")
run_cell 0 "08-off-heading-anchored" reorder "$(uuid_of "$TAG-c5")" --before "$(uuid_of "$TAG-c2")" --in "$HEAD_UUID"
echo "     heading anchored wall: ${LAST_WALL}ms"
expect_column "08 heading anchored --before" "$W" "$(heading_column "$HEAD_UUID")"

########################################################################
echo ""
echo "===== GUI ON — the chord vector ====="
########################################################################
things config set ui-enabled true >/dev/null
osascript -e 'tell application "Finder" to activate' >/dev/null 2>&1; sleep 2

B=$(column); W=$(plan start "$B" "$TAG-A4")
run_cell 0 "09-on-single-start" reorder "$(uuid_of "$TAG-A4")" --in anytime --start
echo "     GUI-on N=1 wall: ${LAST_WALL}ms  audit: $(last_audit)"
expect_column "09 GUI-on single --start" "$W" "$(column)"

B=$(column); W=$(plan start "$B" "$TAG-A2" "$TAG-A6")
run_cell 0 "10-on-multi-start" reorder "$(uuid_of "$TAG-A2")" "$(uuid_of "$TAG-A6")" --in anytime --start
echo "     GUI-on N=2 wall: ${LAST_WALL}ms  audit: $(last_audit)"
expect_column "10 GUI-on multi --start" "$W" "$(column)"
things config set ui-enabled false >/dev/null

beep assert --name ord5-cells 2>&1 | sed 's/^/     | /'
BEEPS=${PIPESTATUS[0]}
[ "${BEEPS:-0}" -eq 0 ] && pass "no unallowed alert beeps in the arm" || fail "alert beep(s) in the arm"
echo ""
echo "ORD-5 cells: $FAILURES failure(s)"
exit "$FAILURES"
