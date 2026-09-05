#!/bin/bash
# DLSEED1 cells — run ON THE GUEST, on a ROUTED golden-v4h clone (helpers 1.4.0,
# `helpers-enabled true`). NORMAL CLI syntax only: no osascript, no hand-built
# things:/// URL, no lab escape, no direct driver invocation.
#
# The direct arm (lab/scripts/research-dlseed1.sh) owns the GUI ORACLE — the same
# promote driven by hand through the dialog, which is what says our landing IS the
# app's default. This arm answers the other question the release gate asks: does
# the shipped verb do it through the DEPUTY, with the field's own syntax.
#
# Usage: dlseed1-cells.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
FAILURES=0
STEP=0
TAG="DLS1R"
START="2026-07-09"   # a Thursday; the clock is pinned to 2026-07-05
DEADLINE="2026-07-12" # three days later

things() { "$NODE" "$APP" "$@"; }

db() {
  python3 -c "
import glob, os, sqlite3, sys
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
r = c.execute(sys.argv[1]).fetchone()
print('' if r is None else ('' if r[0] is None else r[0]))
" "$1"
}

# The decoded rule of one template row: ts (the deadline offset, negated),
# deadlined-ness, and the spawn cursor — the three the ruling is about.
rule() {
  python3 -c "
import glob, os, plistlib, sqlite3, sys
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
r = c.execute('SELECT rt1_recurrenceRule, rt1_instanceCreationStartDate, deadline FROM TMTask WHERE uuid=?', (sys.argv[1],)).fetchone()
def dpk(v):
    if not isinstance(v, int) or v == 0: return v
    y = v >> 16; m = (v >> 12) & 0xF; d = (v >> 7) & 0x1F
    return '%04d-%02d-%02d' % (y, m, d) if 1 < y < 5000 else v
if not r: print('NO-ROW'); raise SystemExit
d = plistlib.loads(r[0]) if r[0] else {}
print('tp=%s fu=%s fa=%s ts=%s icStart=%s deadlined=%s' % (
  d.get('tp'), d.get('fu'), d.get('fa'), d.get('ts'), dpk(r[1]), 'yes' if r[2] else 'no'))
" "$1"
}

fail() { echo "FAIL $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   $*"; }

seed() {
  # seed <title> <when> <deadline-or-empty> -> uuid on stdout
  local title="$1" when="$2" dl="$3"
  if [ -n "$dl" ]; then
    things todo add "$title" --when "$when" --deadline "$dl" --json >/dev/null 2>&1
  else
    things todo add "$title" --when "$when" --json >/dev/null 2>&1
  fi
  db "SELECT uuid FROM TMTask WHERE title='$title' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"
}

# promote <name> <uuid> <expect-ts> <expect-icStart> <expect-deadlined> -- <extra args...>
promote() {
  local name="$1" uuid="$2" wantTs="$3" wantIc="$4" wantDl="$5"; shift 5
  STEP=$((STEP + 1))
  local out code t0 t1
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  out=$(things todo make-repeating "$uuid" --frequency weekly --interval 1 "$@" \
    --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
  code=$?
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  printf '%s\n' "$out" >"$OUT/$name.json"
  local tmpl
  tmpl=$(db "SELECT uuid FROM TMTask WHERE uuid IN (SELECT uuid FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL AND trashed=0) AND title=(SELECT title FROM TMTask WHERE uuid='$uuid') ORDER BY creationDate DESC LIMIT 1")
  if [ "$code" -ne 0 ]; then
    fail "[$STEP] $name — exit $code (expected 0) wall=$((t1 - t0))ms"
    echo "     output: $(head -c 700 <<<"$out")"
    [ -n "$tmpl" ] && echo "     landed: $(rule "$tmpl")"
    return 1
  fi
  if [ -z "$tmpl" ]; then fail "[$STEP] $name — exit 0 but no template row"; return 1; fi
  local got
  got=$(rule "$tmpl")
  echo "     landed: $got   (wall=$((t1 - t0))ms)"
  local okAll=1
  case "$got" in *"ts=$wantTs "*) ;; *) fail "[$STEP] $name — ts is not $wantTs"; okAll=0 ;; esac
  case "$got" in *"icStart=$wantIc "*) ;; *) fail "[$STEP] $name — icStart is not $wantIc"; okAll=0 ;; esac
  case "$got" in *"deadlined=$wantDl"*) ;; *) fail "[$STEP] $name — deadlined is not $wantDl"; okAll=0 ;; esac
  [ "$okAll" = "1" ] && pass "[$STEP] $name — exit 0, ts=$wantTs icStart=$wantIc deadlined=$wantDl"
  return 0
}

echo "############################################################"
echo "# DLSEED1 — the deadlined source, routed through the deputy"
echo "# clock: $(date)"
echo "############################################################"

things config set ui-enabled true >/dev/null && pass "ui-enabled on" || fail "could not set ui-enabled"
export THINGS_API_TRACE=1

echo ""
echo "===== the ruling: a deadlined source promotes to a deadlined series ====="
U=$(seed "$TAG-A" "$START" "$DEADLINE")
[ -n "$U" ] && pass "seed $TAG-A ($U) start=$START deadline=$DEADLINE" || fail "no seed for $TAG-A"
promote "10-inherited" "$U" "-3" "$START" "yes"
python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
notes=(d.get('data') or {}).get('notes') or []
hit=[n for n in notes if 'deadline came with it' in n]
print('     disclosure:', hit[0] if hit else '(MISSING)')
raise SystemExit(0 if hit else 1)
" "$OUT/10-inherited.json" && pass "the inherited deadline is disclosed" || fail "no inherited-deadline disclosure"

echo ""
echo "===== the override: --deadline --start-days-earlier 7 ====="
U=$(seed "$TAG-B" "$START" "$DEADLINE")
promote "20-override" "$U" "-7" "$START" "yes" --deadline --start-days-earlier 7

echo ""
echo "===== the zero override: due ON its start date ====="
U=$(seed "$TAG-C" "$START" "$DEADLINE")
promote "30-zero" "$U" "0" "$START" "yes" --deadline --start-days-earlier 0

echo ""
echo "===== the control: a deadline-FREE source is unchanged ====="
U=$(seed "$TAG-D" "$START" "")
promote "40-control" "$U" "0" "$START" "no"

echo ""
echo "############################################################"
if [ "$FAILURES" -eq 0 ]; then
  echo "# DLSEED1 routed arm: GREEN ($STEP cells)"
else
  echo "# DLSEED1 routed arm: RED — $FAILURES failure(s) in $STEP cells"
fi
echo "############################################################"
exit $((FAILURES > 0))
