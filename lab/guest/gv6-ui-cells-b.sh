#!/bin/bash
# GV6 — the DISCRIMINATOR cells: run identically on golden-v6h (3.25), -v5h
# (3.24) and -v4h (3.23) to decide whether each red in gv6-ui-cells.sh is the
# app version or not. Run ON THE GUEST by lab/scripts/stage5-rc-run.sh.
#
#   A  a DATED to-do: make-repeating → pause → resume → reschedule (interval 2)
#   B  a fresh, UNSCHEDULED Inbox to-do: make-repeating --interval 1 vs 2
#      (is the "interval field did not take keyboard focus" refusal tied to
#      the typed interval, i.e. to the dialog-defaults gate?)
#   C  a DATED project in an area: make-repeating → pause → resume → reschedule,
#      plus an AX dump of the project's header row (the repeat bar the project
#      verbs click) — the evidence for the 3.25 AXTextArea removal
#   D  move-heading-to-project on a fresh fixture
#
# NORMAL CLI syntax for every operation under test; read-only DB oracles; the
# one JXA call is an ORACLE (an AX read of the header row), never a drive.
#
# Usage: gv6-ui-cells-b.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
FAILURES=0
T="GV6B"
TRACE_DIR="$HOME/.local/state/things-api/trace"
export THINGS_API_TRACE=1
newest_trace() { ls -t "$TRACE_DIR"/*.jsonl 2>/dev/null | head -1; }

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
uuid_of() { dbq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1" | head -1; }
wait_uuid() {
  local u i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    u=$(uuid_of "$1"); [ -n "$u" ] && { echo "$u"; return 0; }
    sleep 1
  done
  return 1
}
tmpl_of() { dbq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1"; }
rule_hex() { dbq "SELECT hex(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'"; }
paused() { dbq "SELECT rt1_instanceCreationPaused FROM TMTask WHERE uuid='$1'"; }
run() {
  local name="$1"; shift; [ "$1" = "--" ] && shift
  local t0 t1 code tr
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  things "$@" >"$OUT/$name.json" 2>"$OUT/$name.err"
  code=$?
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  echo "$code" >"$OUT/$name.exit"
  tr=$(newest_trace); [ -n "$tr" ] && cp "$tr" "$OUT/$name.trace.jsonl" 2>/dev/null
  echo "     [$name] exit=$code wall=$((t1 - t0))ms"
  if [ "$code" -ne 0 ]; then
    python3 -c "import json,sys
try:
  d=json.load(open(sys.argv[1])); e=d.get('error') or {}; print('     | '+(e.get('code') or '')+' — '+(e.get('message') or '')[:600])
except Exception as x: print('     | (unparseable)')" "$OUT/$name.json"
  fi
  return "$code"
}
expect0() { local n="$1"; shift; if run "$n" "$@"; then pass "[$n] exit 0"; return 0; else fail "[$n] exit $(cat "$OUT/$n.exit")"; return 1; fi; }
dismiss_any() { things rescue dismiss --dangerously-dismiss-dialog --json >/dev/null 2>&1; true; }

# ORACLE: the content table's first row, as AX sees it (role/desc/value, 4 deep).
lab_axrow1() {
  osascript -l JavaScript -e '
ObjC.import("ApplicationServices")
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):""}catch(e){return ""}}
function kids(el){var c=attr(el,"AXChildren");if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
var pid=Application("System Events").processes.byName("Things3").unixId()
var app=$.AXUIElementCreateApplication(pid), out=[]
var w=kids(app).filter(function(x){return sv(x,"AXSubrole")==="AXStandardWindow"})[0]
var sa=kids(w).filter(function(x){return sv(x,"AXRole")==="AXScrollArea"})[0]
var tb=kids(sa)[0], r1=kids(tb).filter(function(x){return sv(x,"AXRole")==="AXRow"})[0]
function walk(el,d){out.push(Array(d+1).join("  ")+sv(el,"AXRole")+(sv(el,"AXDescription")?" desc="+sv(el,"AXDescription"):"")+(sv(el,"AXValue")?" val="+sv(el,"AXValue").slice(0,40):"")); if(d<4) kids(el).forEach(function(k){walk(k,d+1)})}
walk(r1,0); out.join("\n")' 2>&1
}

echo "############################################################"
echo "# GV6 discriminator cells — Things $(defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString) ($(defaults read /Applications/Things3.app/Contents/Info CFBundleVersion))"
echo "# clock: $(date)"
echo "############################################################"
things config set ui-enabled true >/dev/null && pass "ui-enabled on" || fail "could not set ui-enabled"

echo ""
echo "===== A — a DATED to-do: the to-do repeat family ====="
expect0 A0-seed -- todo add "$T-TD" --when 2026-07-10 --json
TD=$(wait_uuid "$T-TD")
if [ -n "$TD" ] && expect0 A1-make -- todo make-repeating "$TD" --frequency weekly --interval 1 --dangerously-drive-gui --json; then
  TT=$(tmpl_of "$T-TD"); echo "     template=$TT"
  expect0 A2-pause -- todo pause-repeat "$TT" --dangerously-drive-gui --json
  [ "$(paused "$TT")" = "1" ] && pass "todo pause-repeat: paused=1" || fail "todo pause-repeat: paused=$(paused "$TT")"
  expect0 A3-resume -- todo resume-repeat "$TT" --dangerously-drive-gui --json
  [ "$(paused "$TT")" = "0" ] && pass "todo resume-repeat: paused=0" || fail "todo resume-repeat: paused=$(paused "$TT")"
  B=$(rule_hex "$TT")
  expect0 A4-reschedule -- todo reschedule-repeat "$TT" --frequency weekly --interval 2 --dangerously-drive-gui --json
  [ "$(rule_hex "$TT")" != "$B" ] && pass "todo reschedule-repeat: rule changed in place" || fail "todo reschedule-repeat: rule unchanged"
fi
dismiss_any

echo ""
echo "===== B — a fresh UNSCHEDULED Inbox to-do: interval 1 vs interval 2 ====="
expect0 B0-seed1 -- todo add "$T-IN1" --json
expect0 B0-seed2 -- todo add "$T-IN2" --json
I1=$(wait_uuid "$T-IN1"); I2=$(wait_uuid "$T-IN2")
run B1-interval1 -- todo make-repeating "$I1" --frequency weekly --interval 1 --dangerously-drive-gui --json
echo "     interval 1 → exit $(cat "$OUT/B1-interval1.exit")  template=$(tmpl_of "$T-IN1")"
dismiss_any
run B2-interval2 -- todo make-repeating "$I2" --frequency weekly --interval 2 --dangerously-drive-gui --json
echo "     interval 2 → exit $(cat "$OUT/B2-interval2.exit")  template=$(tmpl_of "$T-IN2")"
dismiss_any

echo ""
echo "===== C — a DATED project in an area: the project repeat family ====="
expect0 C0-area -- area add "$T-AREA" --json
expect0 C0-seed -- project add "$T-PJ" --area "$T-AREA" --when 2026-07-10 --todo "$T-PJ-CHILD" --json
PJ=$(wait_uuid "$T-PJ")
if [ -n "$PJ" ] && expect0 C1-make -- project make-repeating "$PJ" --frequency weekly --interval 1 --dangerously-drive-gui --json; then
  PT=$(dbq "SELECT uuid FROM TMTask WHERE title='$T-PJ' AND type=1 AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1"); echo "     project template=$PT"
  open -g "things:///show?id=$PT"; sleep 3
  echo "     AX of the project view's first content row (the header):"
  lab_axrow1 | sed 's/^/     | /' | tee "$OUT/C-header-row.txt" | head -40
  expect0 C2-pause -- project pause-repeat "$PT" --dangerously-drive-gui --json
  [ "$(paused "$PT")" = "1" ] && pass "project pause-repeat: paused=1" || fail "project pause-repeat: paused=$(paused "$PT")"
  dismiss_any
  # resume needs a paused series to be meaningful; pause it headlessly if the drive did not
  expect0 C3-resume -- project resume-repeat "$PT" --dangerously-drive-gui --json
  [ "$(paused "$PT")" = "0" ] && pass "project resume-repeat: paused=0" || fail "project resume-repeat: paused=$(paused "$PT")"
  dismiss_any
  B=$(rule_hex "$PT")
  expect0 C4-reschedule -- project reschedule-repeat "$PT" --frequency weekly --interval 2 --dangerously-drive-gui --json
  [ "$(rule_hex "$PT")" != "$B" ] && pass "project reschedule-repeat: rule changed in place" || fail "project reschedule-repeat: rule unchanged"
fi
dismiss_any

echo ""
echo "===== D — move-heading-to-project ====="
js='[{"type":"project","attributes":{"title":"'"$T"'-HP","items":[{"type":"heading","attributes":{"title":"'"$T"'-HP-H1"}},{"type":"to-do","attributes":{"title":"'"$T"'-HP-H1-CHILD"}},{"type":"heading","attributes":{"title":"'"$T"'-HP-H2"}}]}}]'
enc=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$js")
open -g "things:///json?data=$enc"
wait_uuid "$T-HP-H1-CHILD" >/dev/null
expect0 D0-dest -- project add "$T-HP-DEST" --json
HP=$(wait_uuid "$T-HP"); HD=$(wait_uuid "$T-HP-DEST"); H1=$(uuid_of "$T-HP-H1")
expect0 D1-move -- project move-heading-to-project "$HP" "$T-HP-H1" --to "$HD" --dangerously-drive-gui --json
sleep 2
[ "$(dbq "SELECT project FROM TMTask WHERE uuid='$H1'")" = "$HD" ] && pass "move-heading-to-project: H1 lives in the destination" || fail "move-heading-to-project: H1 project=$(dbq "SELECT project FROM TMTask WHERE uuid='$H1'")"
dismiss_any

echo ""
if [ "$FAILURES" -eq 0 ]; then echo "GREEN — every discriminator cell passed"; else echo "RED — $FAILURES failure(s)"; fi
exit "$FAILURES"
