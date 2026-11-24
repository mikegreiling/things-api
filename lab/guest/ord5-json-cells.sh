#!/bin/bash
# ORD5J — what exactly does Things 3.25 change about a `when=` round-trip
# delivered through ONE `things:///json` update array, and does the sequential
# URL round-trip still hold? Run ON THE GUEST by lab/scripts/stage5-rc-run.sh,
# identically on golden-v6h (3.25) and golden-v5h (3.24).
#
# WHY. GV6 §6 found the loose json collapse BACK-inserting on 3.25 (GV6BNC P3,
# index -1000 against a column at -17871..-13871). The first ORD-5 o-suite pass
# then saw the same shape FRONT-insert on a fresh clone (O40: -4871 -> -7871)
# and the heading collapse for an anchored move with an untouched prefix leave
# three of four rows where they were (O44: only c5 moved, 4000 -> 0). Both fit
# one hypothesis: on 3.25 the json `when=anytime` element no longer re-inserts
# the row, so it keeps whatever index the `when=someday` element gave it. These
# cells dump every index so the hypothesis is tested, not assumed.
#
#   L1  loose: json [someday, anytime] on the middle of five, plus the loose
#       Someday bucket's min before and after (the hypothesis predicts the
#       result = that min - 1000 on 3.25)
#   L2  loose: json [someday] alone, then json [anytime] alone, on a fresh middle
#   L3  loose: sequential URL legs, index after EACH leg
#   H1  heading: json anchored run [c5, c2, c3, c4] (c5 --before c2)
#   H2  heading: the same run as sequential URL legs, forward order
#   H3  heading: json [someday] alone, then json [anytime] alone, on c3
#
# These are probes of the APP's placement, so they hand-build the wire; the
# operation itself is exercised by ord5-anytime-cells.sh with normal CLI syntax.
#
# Usage: ord5-json-cells.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
things() { "$NODE" "$APP" "$@"; }
dbq() {
  python3 -c "
import glob, os, sqlite3, sys
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
for row in c.execute(sys.argv[1]).fetchall():
    print('|'.join('' if v is None else str(v) for v in row))
" "$1"
}
TOKEN=$(dbq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
uuid_of() { dbq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 LIMIT 1" | head -1; }
idx() { dbq "SELECT title||'='||\"index\"||'/s'||start FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY \"index\"" | tr '\n' ' '; }
LOOSE="type=0 AND trashed=0 AND status=0 AND project IS NULL AND area IS NULL AND heading IS NULL AND startDate IS NULL AND rt1_recurrenceRule IS NULL"
buckets() {
  echo "     loose anytime min/max: $(dbq "SELECT MIN(\"index\")||'/'||MAX(\"index\")||' n='||COUNT(*) FROM TMTask WHERE $LOOSE AND start=1")"
  echo "     loose someday min/max: $(dbq "SELECT MIN(\"index\")||'/'||MAX(\"index\")||' n='||COUNT(*) FROM TMTask WHERE $LOOSE AND start=2")"
}
enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }
el() { printf '{"type":"to-do","operation":"update","id":"%s","attributes":{"when":"%s"}}' "$1" "$2"; }
json() { open -g "things:///json?data=$(enc "$1")&auth-token=$TOKEN"; sleep 4; }
url() { open -g "things:///update?id=$1&when=$2&auth-token=$TOKEN"; sleep 2; }
seed_loose() {
  local p="$1" i
  for i in 1 2 3 4 5; do open -g "things:///add?title=$p$i&when=anytime"; sleep 1; done
  sleep 2
}
seed_heading() {
  local p="$1"
  local d
  d=$(printf '[{"type":"project","attributes":{"title":"%sP","items":[{"type":"heading","attributes":{"title":"%sH"}},{"type":"to-do","attributes":{"title":"%sc1"}},{"type":"to-do","attributes":{"title":"%sc2"}},{"type":"to-do","attributes":{"title":"%sc3"}},{"type":"to-do","attributes":{"title":"%sc4"}},{"type":"to-do","attributes":{"title":"%sc5"}}]}}]' "$p" "$p" "$p" "$p" "$p" "$p" "$p")
  open -g "things:///json?data=$(enc "$d")&auth-token=$TOKEN"; sleep 4
  echo "     heading FK on: $(dbq "SELECT COUNT(*) FROM TMTask WHERE title LIKE '${p}c%' AND heading=(SELECT uuid FROM TMTask WHERE title='${p}H' AND type=2)")/5"
}

things config set ui-enabled false >/dev/null 2>&1
echo "# Things $(defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString) ($(defaults read /Applications/Things3.app/Contents/Info CFBundleVersion))"

echo "===== L1 — loose json [someday, anytime] on L1x3 ====="
seed_loose L1x; buckets; echo "     before: $(idx 'L1x%')"
X=$(uuid_of L1x3); json "[$(el "$X" someday),$(el "$X" anytime)]"
echo "     after:  $(idx 'L1x%')"; buckets

echo "===== L2 — loose json [someday] then json [anytime] on L2x3 ====="
seed_loose L2x; buckets; echo "     before:       $(idx 'L2x%')"
X=$(uuid_of L2x3); json "[$(el "$X" someday)]"
echo "     after someday: $(idx 'L2x%')"; buckets
json "[$(el "$X" anytime)]"
echo "     after anytime: $(idx 'L2x%')"; buckets

echo "===== L3 — loose sequential URL legs on L3x3 ====="
seed_loose L3x; buckets; echo "     before:        $(idx 'L3x%')"
X=$(uuid_of L3x3); url "$X" someday
echo "     after someday: $(idx 'L3x%')"
url "$X" anytime
echo "     after anytime: $(idx 'L3x%')"; buckets

echo "===== H1 — heading json anchored run [c5,c2,c3,c4] ====="
seed_heading H1x; echo "     before: $(idx 'H1xc%')"
A=""; for c in 5 2 3 4; do U=$(uuid_of "H1xc$c"); A="$A$([ -n "$A" ] && echo ,)$(el "$U" someday),$(el "$U" anytime)"; done
json "[$A]"
echo "     after:  $(idx 'H1xc%')"

echo "===== H2 — heading sequential URL legs, forward [c5,c2,c3,c4] ====="
seed_heading H2x; echo "     before: $(idx 'H2xc%')"
for c in 5 2 3 4; do U=$(uuid_of "H2xc$c"); url "$U" someday; url "$U" anytime; done
echo "     after:  $(idx 'H2xc%')"

echo "===== H3 — heading json [someday] then json [anytime] on c3 ====="
seed_heading H3x; echo "     before:        $(idx 'H3xc%')"
U=$(uuid_of H3xc3); json "[$(el "$U" someday)]"
echo "     after someday: $(idx 'H3xc%')"
json "[$(el "$U" anytime)]"
echo "     after anytime: $(idx 'H3xc%')"
exit 0
