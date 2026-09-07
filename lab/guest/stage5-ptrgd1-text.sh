#!/bin/bash
# PTRGD1 TEXT LEG — cells for the identity leg's text compare, run ON THE GUEST
# on a routed golden-v4h clone. NORMAL CLI syntax for every drive; the one
# osascript in here is the NEGATIVE cell's leg probe, generated from the RC's own
# dist so it interrogates exactly the guard the gestures carry.
#
# Usage (through lab/scripts/stage5-rc-run.sh): stage5-ptrgd1-text.sh <node> <app-dir>
set -u
NODE="$1"
APPDIR="$2"
APP="$APPDIR/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
FAILURES=0
TAG="PTX"

things() { "$NODE" "$APP" "$@"; }
fail() { echo "FAIL $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   $*"; }

db() {
  python3 -c "
import glob, os, sqlite3, sys
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
r = c.execute(sys.argv[1]).fetchone()
print('' if r is None else ('' if r[0] is None else r[0]))
" "$1"
}

order() {
  db "SELECT group_concat(title,',') FROM (SELECT title FROM TMArea WHERE title LIKE '$TAG-AREA-%' ORDER BY \"index\")"
}

things config set ui-enabled true >/dev/null
things config set experimental-area-reorder true >/dev/null

echo "===== SEED — 12 synthetic areas, enough sidebar to force a wheel scroll ====="
for n in 01 02 03 04 05 06 07 08 09 10 11 12; do
  things area add "$TAG-AREA-$n" --json >/dev/null 2>&1
done
# Projects under three of them, so the sidebar overflows its viewport and the
# drives must scroll to reach their grab points and their drop boundaries.
for n in 02 06 11; do
  for p in 1 2 3 4 5 6; do
    things project add "$TAG-P$n-$p" --area "$TAG-AREA-$n" --json >/dev/null 2>&1
  done
done
echo "     seeded: $(order)"
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1; sleep 3

# reorder_cell <name> <area> <flag...> — drive, then read the DB oracle.
reorder_cell() {
  local name="$1" area="$2"; shift 2
  local before after out code t0 t1
  before=$(order)
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  out=$(env THINGS_API_TRACE=1 "$NODE" "$APP" area reorder "$area" "$@" \
        --dangerously-drive-gui --verify-timeout 180000 --json 2>/dev/null)
  code=$?
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  after=$(order)
  printf '%s\n' "$out" >"$OUT/$name.json"
  echo "--- $name: $area $* ---"
  echo "     before: $before"
  echo "     after:  $after"
  echo "     exit=$code wall=$((t1 - t0))ms"
  echo "     $(head -c 400 <<<"$out")"
  if [ "$code" -eq 0 ] && [ "$before" != "$after" ]; then
    pass "$name — drove and the DB order changed (the text leg passed silently)"
  elif [ "$code" -eq 0 ]; then
    fail "$name — reported ok but the DB order did not change"
  else
    fail "$name — exit $code"
  fi
}

echo ""
echo "===== CELL T1 — top -> bottom (the drive scrolls the whole list) ====="
reorder_cell "t1-top-to-bottom" "$TAG-AREA-01" --last

echo ""
echo "===== CELL T2 — bottom -> top ====="
reorder_cell "t2-bottom-to-top" "$TAG-AREA-12" --first

echo ""
echo "===== CELL T3 — middle -> middle (a short move, mid-list offsets) ====="
reorder_cell "t3-middle" "$TAG-AREA-07" --before "$TAG-AREA-04"

echo ""
echo "===== CELL T4 — middle -> bottom ====="
reorder_cell "t4-middle-to-bottom" "$TAG-AREA-05" --last

echo ""
echo "===== CELL T5 (NEGATIVE) — the text leg FIRES on a wrong expected title ====="
# The probe is generated from the RC's own dist: the SHIPPED guard, asked the
# same question the drag script asks it, with the expected title swapped for one
# the row under the pointer does not carry. Nothing is posted either way — the
# guard returns a sentence, it does not gesture.
"$NODE" -e "
  import('$APPDIR/dist/write/vectors/ui-pointer-guard.js').then(m => {
    process.stdout.write(m.POINTER_GUARD_STANDALONE + '\n' + \`
var ARG = \\\$.NSProcessInfo.processInfo.arguments;
function argv(i){ return ObjC.unwrap(ARG.objectAtIndex(i + 4)) }
var x = Number(argv(0)), y = Number(argv(1)), right = argv(2), wrong = argv(3);
var front = ptrFrontApp();
var chain = front === null ? [] : ptrChainAt(front.pid, x, y);
function legs(title){ return ptrGuard('drag the area row', [{x:x,y:y}], { identity: function(c){
  return ptrTitleMismatch(c, ['AXRow','AXTableRow'], title) } }) }
JSON.stringify({
  point: [x, y],
  chain: ptrChainRoles(chain),
  rowText: ptrChainText(chain, ['AXRow','AXTableRow']),
  sentence_right: legs(right),
  sentence_wrong: legs(wrong),
  ops: PTR_OPS
}, null, 1)
\`);
  });
" > "$HOME/things-lab/textleg.jxa.js"

# A real sidebar row point, read out of the SHIPPED snapshot script.
"$NODE" -e "
  import('$APPDIR/dist/write/vectors/ui-drag.js').then(m => process.stdout.write(
    m.jxaSidebarSnapshotScript(['$TAG-AREA-01','$TAG-AREA-03','$TAG-AREA-12'])));
" > "$HOME/things-lab/snap.jxa.js"
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1; sleep 2
SNAP=$(osascript -l JavaScript "$HOME/things-lab/snap.jxa.js" 2>/dev/null)
printf '%s\n' "$SNAP" >"$OUT/t5-snapshot.json"
read -r PX PY WANT <<<"$(python3 -c "
import json, sys
try: s = json.loads('''$SNAP''')
except Exception: print(''); sys.exit()
vp = s.get('viewport') or {}
rows = [r for r in s.get('rows', []) if r.get('y') is not None and (r.get('text') or '')]
def visible(r):
    return not vp or (r['y'] >= vp['y'] and r['y'] + r['h'] <= vp['y'] + vp['h'])
for r in sorted(rows, key=lambda r: r['y']):
    segs = [t for t in (r.get('text') or '').split('|') if t.startswith('$TAG-AREA-')]
    if segs and visible(r):
        print('%d %d %s' % (round(r['x'] + r['w'] * 0.7), round(r['y'] + r['h'] / 2), segs[0].rstrip('.')))
        break
")"
if [ -z "${PX:-}" ]; then
  fail "t5 — no visible $TAG area row in the snapshot, cannot site the probe"
else
  echo "     probing at ($PX, $PY); the row there is \"$WANT\""
  osascript -l JavaScript "$HOME/things-lab/textleg.jxa.js" "$PX" "$PY" "$WANT" "$TAG-AREA-NOT-HERE" \
    2>&1 | tee "$OUT/t5-textleg.json"
  RIGHT=$(python3 -c "
import json
d = json.load(open('$OUT/t5-textleg.json'))
print('null' if d.get('sentence_right') is None else d['sentence_right'])
" 2>/dev/null)
  WRONGS=$(python3 -c "
import json
d = json.load(open('$OUT/t5-textleg.json'))
print('null' if d.get('sentence_wrong') is None else d['sentence_wrong'])
" 2>/dev/null)
  [ "$RIGHT" = "null" ] && pass "t5a — the true title passes every leg (no refusal)" \
    || fail "t5a — the true title was refused: $RIGHT"
  case "$WRONGS" in
    *"expected area \"$TAG-AREA-NOT-HERE\" under the pointer, found \"$WANT\""*)
      pass "t5b — the text leg fired and named BOTH titles" ;;
    *) fail "t5b — the text leg did not name both titles: $WRONGS" ;;
  esac
fi

echo ""
echo "===== final area order ====="
order

echo ""
if [ "$FAILURES" -eq 0 ]; then echo "PTRGD1-TEXT GREEN"; else echo "PTRGD1-TEXT RED ($FAILURES)"; fi
exit "$FAILURES"
