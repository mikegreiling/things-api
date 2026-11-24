#!/bin/bash
# ORD5J-T — repeat trials of the ONE-array json [someday, anytime] round-trip,
# because the first ORD5J pass on Things 3.25 saw it FRONT-insert a loose to-do
# (L1, and o-suite O40) where GV6 §6.2 P3 saw it land LAST, and saw the heading
# anchored run land correctly (H1) where o-suite O44 saw three of four rows
# untouched. Same build, same golden: so is the 3.25 json placement simply
# nondeterministic, or does a condition (how the column was seeded) decide it?
#
#   TU  loose, column seeded by URL `add`          × N
#   TC  loose, column seeded by `things todo add`  × N (GV6BNC's seeding)
#   TH  heading, anchored run [c5, c2, c3, c4]     × N
#   TS  loose, SEQUENTIAL URL legs (control)       × N
#
# Prints one line per trial: the outcome (front / back / middle) and the
# target's index against the column. Probes of the APP's placement, so they
# hand-build the wire.
#
# Usage: ord5-json-trials.sh <node-binary> <app-dir>   (N from $TRIALS, default 6)
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
N="${TRIALS:-6}"
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
LOOSE="type=0 AND trashed=0 AND status=0 AND project IS NULL AND area IS NULL AND heading IS NULL AND startDate IS NULL AND rt1_recurrenceRule IS NULL AND start=1"
enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }
el() { printf '{"type":"to-do","operation":"update","id":"%s","attributes":{"when":"%s"}}' "$1" "$2"; }
# Outcome of target $1 within the rows titled like $2 (front/back/middle) + raw index.
where() {
  dbq "SELECT title FROM TMTask WHERE $LOOSE AND title LIKE '$2' ORDER BY \"index\"" > /tmp/ord5t.$$
  local n first last
  n=$(wc -l < /tmp/ord5t.$$ | tr -d ' '); first=$(head -1 /tmp/ord5t.$$); last=$(tail -1 /tmp/ord5t.$$)
  local o=middle; [ "$first" = "$1" ] && o=front; [ "$last" = "$1" ] && o=back
  echo "$o idx=$(dbq "SELECT \"index\" FROM TMTask WHERE title='$1'") col=$(dbq "SELECT MIN(\"index\")||'..'||MAX(\"index\") FROM TMTask WHERE $LOOSE")"
}
things config set ui-enabled false >/dev/null 2>&1
echo "# Things $(defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString) ($(defaults read /Applications/Things3.app/Contents/Info CFBundleVersion))  N=$N"

for t in $(seq 1 "$N"); do
  p="TU${t}x"; for i in 1 2 3 4 5; do open -g "things:///add?title=$p$i&when=anytime"; sleep 1; done; sleep 2
  X=$(uuid_of "${p}3"); open -g "things:///json?data=$(enc "[$(el "$X" someday),$(el "$X" anytime)]")&auth-token=$TOKEN"; sleep 4
  echo "TU $t $(where "${p}3" "$p%")"
done
for t in $(seq 1 "$N"); do
  p="TC${t}x"; for i in 1 2 3 4 5; do things todo add "$p$i" --when anytime --json >/dev/null 2>&1; sleep 1; done; sleep 2
  X=$(uuid_of "${p}3"); open -g "things:///json?data=$(enc "[$(el "$X" someday),$(el "$X" anytime)]")&auth-token=$TOKEN"; sleep 4
  echo "TC $t $(where "${p}3" "$p%")"
done
for t in $(seq 1 "$N"); do
  p="TS${t}x"; for i in 1 2 3 4 5; do open -g "things:///add?title=$p$i&when=anytime"; sleep 1; done; sleep 2
  X=$(uuid_of "${p}3")
  open -g "things:///update?id=$X&when=someday&auth-token=$TOKEN"; sleep 2
  open -g "things:///update?id=$X&when=anytime&auth-token=$TOKEN"; sleep 2
  echo "TS $t $(where "${p}3" "$p%")"
done
for t in $(seq 1 "$N"); do
  p="TH${t}x"
  d=$(printf '[{"type":"project","attributes":{"title":"%sP","items":[{"type":"heading","attributes":{"title":"%sH"}},{"type":"to-do","attributes":{"title":"%sc1"}},{"type":"to-do","attributes":{"title":"%sc2"}},{"type":"to-do","attributes":{"title":"%sc3"}},{"type":"to-do","attributes":{"title":"%sc4"}},{"type":"to-do","attributes":{"title":"%sc5"}}]}}]' "$p" "$p" "$p" "$p" "$p" "$p" "$p")
  open -g "things:///json?data=$(enc "$d")&auth-token=$TOKEN"; sleep 4
  A=""; for c in 5 2 3 4; do U=$(uuid_of "${p}c$c"); A="$A$([ -n "$A" ] && echo ,)$(el "$U" someday),$(el "$U" anytime)"; done
  open -g "things:///json?data=$(enc "[$A]")&auth-token=$TOKEN"; sleep 4
  got=$(dbq "SELECT substr(title,length('$p')+1)||'='||\"index\" FROM TMTask WHERE title LIKE '${p}c%' AND trashed=0 ORDER BY \"index\", title" | tr '\n' ' ')
  ord=$(dbq "SELECT substr(title,length('$p')+1) FROM TMTask WHERE title LIKE '${p}c%' AND trashed=0 ORDER BY \"index\", title" | tr '\n' ' ')
  ties=$(dbq "SELECT COUNT(*) - COUNT(DISTINCT \"index\") FROM TMTask WHERE title LIKE '${p}c%' AND trashed=0")
  verdict=wrong; [ "$ord" = "c1 c5 c2 c3 c4 " ] && [ "$ties" = 0 ] && verdict=ok
  echo "TH $t $verdict ties=$ties | $got"
done
rm -f /tmp/ord5t.$$
exit 0
