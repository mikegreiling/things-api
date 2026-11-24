#!/bin/bash
# UIFIX1 — certification cells for the four GUI-driven verbs GV6 §5.3 found
# refusing on every version (docs/lab/uifix1-repeat-bar-and-picker.md). Run ON
# THE GUEST by lab/scripts/stage5-rc-run.sh: a ROUTED clone (golden-v6h for
# Things 3.25, -v5h for 3.24), NORMAL CLI syntax, read-only DB oracles. The one
# hand-built things:/// URL is FIXTURE management (heading seeds, as the e2e
# does); no operation under test is ever driven by anything but the CLI.
#
# For each optional-machinery quadrant {observer on/off} x {prefill on/off}
# (DEFAULTS3), REPS times:
#   T  todo pause-repeat then resume-repeat BACK TO BACK (the toggle-title lag)
#   P  project pause-repeat, resume-repeat, reschedule-repeat (the repeat bar)
#   M  project move-heading-to-project into a destination whose title is a
#      prefix of another project's (the Move… picker + its dialog guard)
# Every verb is checked against the database, timed, and its quadrant read
# back out of its own trace (a switch is only one reason machinery is absent).
#
# Usage: uifix1-cells.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
FAILURES=0
STEP=0
REPS="${UIFIX1_REPS:-3}"
TRACE_DIR="$HOME/.local/state/things-api/trace"
DEPUTY_LOG="$HOME/.local/state/things-api/deputy/deputy.log"
LATENCY="$OUT/latency.tsv"
: >"$LATENCY"
export THINGS_API_TRACE=1

BEEP_SENTINEL="$(dirname "$0")/beep-sentinel.sh"
export BEEP_MARKS="$HOME/things-lab/uifix1-beep-marks.tsv"
beep() {
  [ -f "$BEEP_SENTINEL" ] || return 0
  bash "$BEEP_SENTINEL" "$@"
}
beep reset
beep mark "uifix1 start"

things() { "$NODE" "$APP" "$@"; }
pass() { echo "ok   $*"; }
fail() {
  echo "FAIL $*"
  FAILURES=$((FAILURES + 1))
}
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
newest_trace() { ls -t "$TRACE_DIR"/*.jsonl 2>/dev/null | head -1; }
db() {
  python3 -c "
import glob, os, sqlite3, sys
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
for row in c.execute(sys.argv[1]).fetchall():
    print('|'.join('' if v is None else str(v) for v in row))
" "$1"
}
uuid_of() { db "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
wait_uuid() {
  local u i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    u=$(uuid_of "$1")
    [ -n "$u" ] && { echo "$u"; return 0; }
    sleep 1
  done
  return 1
}
paused_of() { db "SELECT rt1_instanceCreationPaused FROM TMTask WHERE uuid='$1'"; }
rule_of() { db "SELECT hex(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1' AND trashed=0"; }

# drive <name> <obs> <pf> <args...> — one CLI call in the given quadrant; exit
# code in $LAST_CODE, wall time recorded; the trace is kept beside the output.
drive() {
  local name="$1" obs="$2" pf="$3"
  shift 3
  local t0 t1 tr
  STEP=$((STEP + 1))
  beep mark "[$STEP] $name"
  t0=$(now_ms)
  env ${obs:+THINGS_API_AX_OBSERVER=$obs} ${pf:+THINGS_API_PREFILL=$pf} \
    "$NODE" "$APP" "$@" --dangerously-drive-gui --json >"$OUT/$name.json" 2>"$OUT/$name.err"
  LAST_CODE=$?
  t1=$(now_ms)
  LAST_WALL=$((t1 - t0))
  tr=$(newest_trace)
  [ -n "$tr" ] && cp "$tr" "$OUT/$name.trace.jsonl" 2>/dev/null
  printf '%s\t%s\t%s\n' "$name" "$LAST_CODE" "$LAST_WALL" >>"$LATENCY"
  if [ "$LAST_CODE" -ne 0 ]; then
    python3 -c "import json,sys
try:
  d=json.load(open(sys.argv[1])); e=d.get('error') or {}; print('     | '+(e.get('code') or '')+' — '+(e.get('message') or '')[:700])
except Exception: print('     | (unparseable)')" "$OUT/$name.json"
  fi
}
# The machinery the drive actually used, read from its own trace: "<observer><prefill>".
machinery() {
  python3 -c "
import json, sys
obs = pf = False
for line in open(sys.argv[1], errors='ignore'):
    try: r = json.loads(line)
    except Exception: continue
    ph, ev = r.get('phase'), r.get('event')
    if ph == 'ui-observer' and ev == 'armed': obs = True
    elif ph == 'ui-prefill' and ev == 'verify': pf = True
    elif ph == 'ui-rawax' and r.get('op') == 'verify-prefill': pf = True
print('%d%d' % (obs, pf))
" "$OUT/$1.trace.jsonl" 2>/dev/null || echo "??"
}
# A switched-OFF machine must be absent from the trace; a switched-ON one is
# reported (not every verb exercises either — only the Repeat dialog does both).
check_quadrant() {
  local name="$1" obs="$2" pf="$3" m
  m=$(machinery "$name")
  if { [ "$obs" = "0" ] && [ "${m:0:1}" = "1" ]; } || { [ "$pf" = "0" ] && [ "${m:1:1}" = "1" ]; }; then
    fail "[$name] machinery switched off but present in the trace (observer/prefill = $m)"
  else
    echo "     [$name] trace machinery observer/prefill = $m"
  fi
}
expect() { # expect <actual> <expected> <what>
  if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 — got '$1', expected '$2'"; fi
}

echo "############################################################"
echo "# UIFIX1 cells — Things $(defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString) ($(defaults read /Applications/Things3.app/Contents/Info CFBundleVersion))"
echo "# clock: $(date)   reps per quadrant: $REPS"
echo "############################################################"
things config set ui-enabled true >/dev/null && pass "ui-enabled on" || fail "could not switch ui-enabled on"
things helpers status --json >"$OUT/helpers-status.json" 2>/dev/null
ROUTED=$(python3 -c "
import json
d = json.load(open('$OUT/helpers-status.json'))['data']
hello = d['deputy']['hello'] or {}
auto = hello.get('automation') or {}
print(d['mode'], d['deputy']['running'], auto.get('things'), hello.get('axTrusted'), auto.get('systemEvents'))
" 2>/dev/null)
expect "$ROUTED" "true True granted True granted" "routed through the deputy with the GUI tier (mode/running/things/ax/system-events)"
LOG_MARK=$(wc -l <"$DEPUTY_LOG" 2>/dev/null | tr -d ' ')

Q=0
for OBS in "" 0; do
  for PF in "" 0; do
    Q=$((Q + 1))
    QN="q$Q-o${OBS:-on}-p${PF:-on}"
    echo ""
    echo "===== quadrant $QN (observer=${OBS:-on} prefill=${PF:-on}) ====="
    # ---- fixtures for this quadrant
    TAG="UFX1-$Q"
    things todo add "$TAG-TD" --when 2026-07-10 --json >/dev/null
    TD=$(wait_uuid "$TAG-TD")
    things todo make-repeating "$TD" --frequency weekly --interval 1 --dangerously-drive-gui --json >/dev/null
    TT=$(db "SELECT uuid FROM TMTask WHERE title='$TAG-TD' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
    things area add "$TAG-AREA" --json >/dev/null
    things project add "$TAG-PJ" --area "$TAG-AREA" --when 2026-07-10 --todo "$TAG-PJ-C" --json >/dev/null
    PJ=$(wait_uuid "$TAG-PJ")
    things project make-repeating "$PJ" --frequency weekly --interval 1 --dangerously-drive-gui --json >/dev/null
    PT=$(db "SELECT uuid FROM TMTask WHERE title='$TAG-PJ' AND type=1 AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
    things project add "$TAG-DEST" --json >/dev/null
    things project add "$TAG-DEST-2" --json >/dev/null
    HD=$(wait_uuid "$TAG-DEST")
    if [ -z "$TT" ] || [ -z "$PT" ] || [ -z "$HD" ]; then
      fail "[$QN] fixtures did not land (todo template '$TT', project template '$PT', destination '$HD')"
      continue
    fi
    echo "     todo template=$TT  project template=$PT  destination=$HD"

    for R in $(seq 1 "$REPS"); do
      echo "  -- rep $R"
      # T: the to-do toggle, back to back
      drive "$QN-r$R-td-pause" "$OBS" "$PF" todo pause-repeat "$TT"
      expect "$LAST_CODE/$(paused_of "$TT")" "0/1" "[$QN r$R] todo pause-repeat exit 0, paused=1 (${LAST_WALL}ms)"
      check_quadrant "$QN-r$R-td-pause" "$OBS" "$PF"
      drive "$QN-r$R-td-resume" "$OBS" "$PF" todo resume-repeat "$TT"
      expect "$LAST_CODE/$(paused_of "$TT")" "0/0" "[$QN r$R] todo resume-repeat straight after, exit 0, paused=0 (${LAST_WALL}ms)"
      check_quadrant "$QN-r$R-td-resume" "$OBS" "$PF"

      # P: the project repeat bar
      drive "$QN-r$R-pj-pause" "$OBS" "$PF" project pause-repeat "$PT"
      expect "$LAST_CODE/$(paused_of "$PT")" "0/1" "[$QN r$R] project pause-repeat exit 0, paused=1 (${LAST_WALL}ms)"
      check_quadrant "$QN-r$R-pj-pause" "$OBS" "$PF"
      drive "$QN-r$R-pj-resume" "$OBS" "$PF" project resume-repeat "$PT"
      expect "$LAST_CODE/$(paused_of "$PT")" "0/0" "[$QN r$R] project resume-repeat exit 0, paused=0 (${LAST_WALL}ms)"
      check_quadrant "$QN-r$R-pj-resume" "$OBS" "$PF"
      B=$(rule_of "$PT")
      drive "$QN-r$R-pj-resched" "$OBS" "$PF" project reschedule-repeat "$PT" --frequency weekly --interval $((R + 1))
      A=$(rule_of "$PT")
      if [ "$LAST_CODE" -eq 0 ] && [ -n "$A" ] && [ "$A" != "$B" ]; then
        pass "[$QN r$R] project reschedule-repeat every $((R + 1)) weeks — exit 0, rule changed in place (${LAST_WALL}ms)"
      else
        fail "[$QN r$R] project reschedule-repeat — exit $LAST_CODE, rule changed: $([ "$A" != "$B" ] && echo yes || echo no)"
      fi
      check_quadrant "$QN-r$R-pj-resched" "$OBS" "$PF"

      # M: the Move… picker, a fresh heading each rep, into the prefix-colliding destination
      HPT="$TAG-R$R-HP"
      js='[{"type":"project","attributes":{"title":"'"$HPT"'","items":[{"type":"heading","attributes":{"title":"'"$HPT"'-H1"}},{"type":"to-do","attributes":{"title":"'"$HPT"'-H1-C"}},{"type":"heading","attributes":{"title":"'"$HPT"'-H2"}}]}}]'
      enc=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$js")
      open -g "things:///json?data=$enc"
      HC=$(wait_uuid "$HPT-H1-C")
      HP=$(wait_uuid "$HPT")
      H1=$(uuid_of "$HPT-H1")
      NPROJ=$(db "SELECT count(*) FROM TMTask WHERE type=1 AND trashed=0")
      drive "$QN-r$R-mv" "$OBS" "$PF" project move-heading-to-project "$HP" "$HPT-H1" --to "$HD"
      expect "$LAST_CODE/$(db "SELECT project FROM TMTask WHERE uuid='$H1'")/$(db "SELECT heading FROM TMTask WHERE uuid='$HC'")" \
        "0/$HD/$H1" "[$QN r$R] move-heading-to-project exit 0, heading in the destination, its to-do followed (${LAST_WALL}ms)"
      expect "$(db "SELECT count(*) FROM TMTask WHERE type=1 AND trashed=0")" "$NPROJ" "[$QN r$R] no project was created by the picker"
      check_quadrant "$QN-r$R-mv" "$OBS" "$PF"
    done
    things rescue dismiss --dangerously-dismiss-dialog --json >/dev/null 2>&1 || true
  done
done

echo ""
echo "===== the broker's verdict ====="
DENIED=$(tail -n "+$((${LOG_MARK:-0} + 1))" "$DEPUTY_LOG" 2>/dev/null | grep -c 'rejected-script' || true)
expect "${DENIED:-0}" "0" "the deputy refused no script this run"

echo ""
echo "===== latency (ms, wall per CLI call, routed) ====="
python3 - "$LATENCY" <<'EOF'
import sys, statistics, collections
rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[1]) if l.strip()]
by = collections.defaultdict(list)
for name, code, wall in rows:
    op = name
    if name.endswith("td-pause"): op = "todo pause-repeat"
    elif name.endswith("td-resume"): op = "todo resume-repeat"
    elif name.endswith("pj-pause"): op = "project pause-repeat"
    elif name.endswith("pj-resume"): op = "project resume-repeat"
    elif name.endswith("pj-resched"): op = "project reschedule-repeat"
    elif name.endswith("-mv"): op = "project move-heading-to-project"
    if code == "0": by[op].append(int(wall))
for op, w in sorted(by.items()):
    print(f"  {op:34s} n={len(w):2d}  median={int(statistics.median(w))}  min={min(w)}  max={max(w)}")
EOF

echo ""
echo "===== alert beeps ====="
beep mark "uifix1 end"
if ! beep assert --name "uifix1" --json "$HOME/things-lab/uifix1-beeps.json"; then
  FAILURES=$((FAILURES + 1))
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then echo "GREEN — UIFIX1, $STEP drives"; else echo "RED — $FAILURES failure(s) in $STEP drives"; fi
exit "$FAILURES"
