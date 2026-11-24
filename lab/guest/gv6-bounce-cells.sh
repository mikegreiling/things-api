#!/bin/bash
# GV6BNC — where does a someday→anytime round-trip re-insert a LOOSE to-do in
# Anytime? Run ON THE GUEST by lab/scripts/stage5-rc-run.sh, identically on
# golden-v6h (3.25) and golden-v5h (3.24).
#
# WHY. The CHORD3 cell 9 fallback (`things reorder <x> --in anytime --start`
# with GUI driving off, i.e. the bounce) landed its target at the END of the
# loose Anytime list on 3.25 and at the FRONT on 3.24, exit 0 both times. ORD-4
# says a loose item re-inserts at its bucket FRONT; its live lock (o-suite
# O07/O08) covers Today/Evening only, so an Anytime change would pass the suite.
#
#   P1  the shipped command: `reorder <x> --in anytime --start` (bounce route)
#   P2  PROBE: the sequential URL legs by hand — update when=someday, then
#       when=anytime — on a fresh member
#   P3  PROBE: the one-call json collapse [someday, anytime] (ORD-5) on a fresh
#       member
# Each starts from a freshly seeded five-member column; P2/P3 hand-build URLs
# because they are probes of the APP's placement, never the operation.
#
# Usage: gv6-bounce-cells.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
FAILURES=0
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
uuid_of() { dbq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 LIMIT 1" | head -1; }
TOKEN=$(dbq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
# The loose Anytime column for one prefix, in index order (start=1, no area/project/heading).
col() { dbq "SELECT title FROM TMTask WHERE title LIKE '$1-%' AND trashed=0 AND status=0 AND type=0 AND start=1 AND area IS NULL AND project IS NULL AND heading IS NULL ORDER BY \"index\"" | tr '\n' ' '; }
seed() {
  local p="$1" i
  for i in 1 2 3 4 5; do things todo add "$p-$i" --when anytime --json >/dev/null 2>&1; sleep 1; done
  sleep 2
}
things config set ui-enabled false >/dev/null 2>&1
echo "# Things $(defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString) ($(defaults read /Applications/Things3.app/Contents/Info CFBundleVersion))"

echo "===== P1 — the shipped bounce: reorder P1-4 --in anytime --start ====="
seed P1; echo "     before: $(col P1)"
things reorder "$(uuid_of P1-4)" --in anytime --start --json >"$OUT/P1.json" 2>"$OUT/P1.err"; echo "     exit=$?  vector=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print((d.get("data") or {}).get("vector"),(d.get("data") or {}).get("strategy"))' "$OUT/P1.json" 2>/dev/null)"
sleep 3; echo "     after:  $(col P1)"
case "$(col P1)" in "P1-4 "*) echo "ok   P1 front";; *) echo "FAIL P1 not at front"; FAILURES=$((FAILURES+1));; esac

echo "===== P2 — PROBE: sequential URL legs someday → anytime on P2-4 ====="
seed P2; echo "     before: $(col P2)"
X=$(uuid_of P2-4)
open -g "things:///update?id=$X&when=someday&auth-token=$TOKEN"; sleep 3
open -g "things:///update?id=$X&when=anytime&auth-token=$TOKEN"; sleep 3
echo "     after:  $(col P2)"

echo "===== P3 — PROBE: json collapse [someday, anytime] on P3-4 ====="
seed P3; echo "     before: $(col P3)"
X=$(uuid_of P3-4)
js='[{"type":"to-do","operation":"update","id":"'"$X"'","attributes":{"when":"someday"}},{"type":"to-do","operation":"update","id":"'"$X"'","attributes":{"when":"anytime"}}]'
enc=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$js")
open -g "things:///json?data=$enc&auth-token=$TOKEN"; sleep 4
echo "     after:  $(col P3)"
echo "     index values (P3): $(dbq "SELECT title||'='||\"index\" FROM TMTask WHERE title LIKE 'P3-%' AND trashed=0 ORDER BY \"index\"" | tr '\n' ' ')"
exit "$FAILURES"
