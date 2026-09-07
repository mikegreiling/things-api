#!/bin/bash
# CHORDMH1 §7 — ONE routed cell: the heading chord op's reveal must NOT bring
# Things forward. Run ON THE GUEST on a routed golden-v4h clone (helpers
# installed + granted, `helpers-enabled true`).
#
# WHY. `moveHeadingChordRecipe` documented the CHORDMH1 measurement — background
# `open -g`, Finder frontmost at every stage, Things never activated — but the
# shipped `reveal` primitive ran a plain `open`, which activates the handler app.
# The `backgroundReveal` step flag that carries the shape arrived with CHORD3 and
# was set on the to-do chord recipe only. This cell re-certifies the heading
# recipe with the flag set: the frontmost app is read BEFORE, sampled DURING the
# drive, and read AFTER, and the heading is asserted to have landed.
#
# NORMAL CLI syntax for the operation under test (`things project move-heading`,
# the field-shaped path). Two LAB-ESCAPES, both preconditions/oracles and never
# the thing measured: reading which app is frontmost, and putting Finder in front
# so a focus steal is visible as a change. The heading FIXTURES are seeded with
# the json URL because that is the only headless heading-create path (HX0), the
# same way lab/guest/e2e-write-smoke.sh seeds its heading fixtures.
#
# Usage: stage5-cells-heading-reveal.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
AUDIT_DIR="$HOME/.local/state/things-api/audit"
FAILURES=0
TAG="MHR"

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

# The project's LIVE heading order — index order, open rows only (what the
# project view renders, CHORD2 cell 7a').
heading_order() {
  dbq "SELECT h.title FROM TMTask h JOIN TMTask p ON h.project = p.uuid
       WHERE h.type=2 AND h.trashed=0 AND h.status=0 AND p.title='$TAG-PROJ'
       ORDER BY h.\"index\"" | tr '\n' ' '
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

# The vector + result the audit trail records for the LAST move-heading write.
last_audit() {
  python3 -c "
import glob, json, os
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
        if d.get('op') == 'project.move-heading' and d.get('result') != 'intent':
            rec = d
print('' if rec is None else '%s %s' % (rec.get('vector',''), rec.get('result','')))
"
}

echo "############################################################"
echo "# CHORDMH1 §7 — the heading reveal stays in the background"
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
echo "===== CELL 1 — seed a synthetic project with three headings ====="
########################################################################
# HX0: heading items inside a NEW project's json payload create real type=2 rows
# — the only headless heading-create path (same seed shape as e2e-write-smoke).
open -g 'things:///json?data=%5B%7B%22type%22%3A%22project%22%2C%22attributes%22%3A%7B%22title%22%3A%22MHR-PROJ%22%2C%22items%22%3A%5B%7B%22type%22%3A%22heading%22%2C%22attributes%22%3A%7B%22title%22%3A%22MHR-H1%22%7D%7D%2C%7B%22type%22%3A%22heading%22%2C%22attributes%22%3A%7B%22title%22%3A%22MHR-H2%22%7D%7D%2C%7B%22type%22%3A%22heading%22%2C%22attributes%22%3A%7B%22title%22%3A%22MHR-H3%22%7D%7D%5D%7D%7D%5D'
sleep 4
PROJ=$(uuid_of "$TAG-PROJ")
H3=$(uuid_of "$TAG-H3")
echo "     heading order: $(heading_order)"
if [ -n "$PROJ" ] && [ -n "$H3" ]; then
  pass "fixtures seeded (project=$PROJ, H3=$H3)"
else
  fail "heading fixtures did not appear"
  exit 1
fi
case "$(heading_order)" in
  "$TAG-H1 $TAG-H2 $TAG-H3 ") pass "seed order is H1 H2 H3";;
  *) fail "unexpected seed order — $(heading_order)"; exit 1;;
esac

########################################################################
echo ""
echo "===== CELL 2 — move H3 to the front, watching the frontmost app ====="
########################################################################
front_finder
FRONT_BEFORE=$(frontmost)
echo "     frontmost before the drive: $FRONT_BEFORE"

SAMPLES="$OUT/frontmost-samples.txt"
: >"$SAMPLES"
# A foreground-owned sampler: it is killed and reaped by this same script, so it
# never outlives the run.
( while :; do frontmost >>"$SAMPLES"; sleep 1; done ) &
POLLER=$!

t0=$(python3 -c 'import time;print(int(time.time()*1000))')
OUT_JSON=$(things project move-heading "$PROJ" "$H3" --first --dangerously-drive-gui --json 2>/dev/null)
CODE=$?
t1=$(python3 -c 'import time;print(int(time.time()*1000))')
kill "$POLLER" 2>/dev/null
wait "$POLLER" 2>/dev/null
printf '%s\n' "$OUT_JSON" >"$OUT/02-move-heading.json"

FRONT_AFTER=$(frontmost)
SAMPLE_COUNT=$(wc -l <"$SAMPLES" | tr -d ' ')
DISTINCT=$(sort -u "$SAMPLES" | tr '\n' ',')
echo "     exit:        $CODE  wall=$((t1 - t0))ms"
echo "     order after: $(heading_order)"
echo "     audit:       $(last_audit)"
echo "     frontmost:   $FRONT_BEFORE -> [$SAMPLE_COUNT samples: $DISTINCT] -> $FRONT_AFTER"

[ "$CODE" -eq 0 ] && pass "the drive exited 0" || { fail "the drive exited $CODE"; echo "     output: $(head -c 900 <<<"$OUT_JSON")"; }
case "$(heading_order)" in
  "$TAG-H3 "*) pass "H3 landed at the front (DB oracle)";;
  *) fail "H3 did not land at the front — $(heading_order)";;
esac
case "$(last_audit)" in
  "ui ok") pass "the audit trail records vector=ui, result=ok";;
  *) fail "audit says '$(last_audit)', expected 'ui ok'";;
esac
[ "$FRONT_BEFORE" = "Finder" ] && pass "Finder was frontmost before the drive" \
  || fail "the precondition failed: $FRONT_BEFORE was frontmost, not Finder"
[ "$FRONT_AFTER" = "Finder" ] && pass "Finder is still frontmost after the drive" \
  || fail "the drive changed the frontmost app: $FRONT_BEFORE -> $FRONT_AFTER"
if [ "$SAMPLE_COUNT" -lt 2 ]; then
  fail "only $SAMPLE_COUNT frontmost sample(s) taken during the drive — inconclusive"
elif [ "$DISTINCT" = "Finder," ]; then
  pass "every one of the $SAMPLE_COUNT samples DURING the drive read Finder"
else
  fail "the frontmost app changed mid-drive: $DISTINCT"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "GREEN — the heading reveal never brought Things forward"
else
  echo "RED — $FAILURES failure(s)"
fi
exit "$FAILURES"
