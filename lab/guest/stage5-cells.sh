#!/bin/bash
# Stage 5 cells — run ON THE GUEST, on a routed golden-v4h clone (helpers 1.4.0,
# `helpers-enabled true`). NORMAL CLI syntax only: no osascript, no hand-built
# things:/// URL, no lab escape, no direct driver invocation.
#
# Usage: stage5-cells.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
TRACE_DIR="$HOME/.local/state/things-api/trace"
DEPUTY_LOG="$HOME/.local/state/things-api/deputy/deputy.log"
FAILURES=0
STEP=0
RCTAG="RC209"

BEEP_SENTINEL="$(dirname "$0")/beep-sentinel.sh"
export BEEP_MARKS="$HOME/things-lab/stage5-beep-marks.tsv"
beep() { [ -f "$BEEP_SENTINEL" ] || return 0; bash "$BEEP_SENTINEL" "$@"; }
beep reset; beep mark "stage5 start"

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

fail() { echo "FAIL $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   $*"; }

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
  local ems
  ems=$(python3 -c "
import json,sys
try:
    d=json.loads(sys.stdin.read())
    print((d.get('meta') or {}).get('elapsedMs',''))
except Exception:
    print('')
" <<<"$out")
  if [ "$code" -ne "$expect" ]; then
    fail "[$STEP] $name — exit $code (expected $expect) wall=${LAST_WALL}ms elapsedMs=$ems"
    echo "     output: $(head -c 900 <<<"$out")"
    return 1
  fi
  pass "[$STEP] $name — exit $code wall=${LAST_WALL}ms elapsedMs=$ems"
  return 0
}

jqp() { python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for k in sys.argv[1:]:
    d = d.get(k) if isinstance(d,dict) else None
    if d is None: break
print(json.dumps(d))
" "$@"; }

newest_trace() { ls -t "$TRACE_DIR"/*.jsonl 2>/dev/null | head -1; }

LOG_MARK=$(wc -l <"$DEPUTY_LOG" 2>/dev/null | tr -d ' '); LOG_MARK=${LOG_MARK:-0}
deputy_since() { tail -n "+$((LOG_MARK + 1))" "$DEPUTY_LOG" 2>/dev/null; }

clear_banners() { killall NotificationCenter >/dev/null 2>&1 || true; sleep 2; }
kill_things() { osascript -e 'tell application "Things3" to quit' >/dev/null 2>&1; sleep 4; }
launch_things() {
  open -a Things3; sleep 16
  osascript -e 'tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false' >/dev/null 2>&1
}

echo "############################################################"
echo "# Stage 5 — field-shaped RC run, routed guest"
echo "# clock: $(date)"
echo "############################################################"

########################################################################
echo ""
echo "===== CELL 1 — routed identity, doctor + helpers status rows ====="
########################################################################
run_cell 0 "01-helpers-status" helpers status
echo "     mode/running/version/capabilities:"
python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
h=d['deputy'].get('hello') or {}
print('     ', 'mode=%s running=%s version=%s caps=%s axTrusted=%s reader=%s' % (
  d.get('mode'), d['deputy'].get('running'), h.get('deputyVersion'),
  h.get('capabilities'), h.get('axTrusted'), d['reader'].get('granted')))
" <"$OUT/01-helpers-status.json"
CAPS=$(python3 -c "
import json,sys
h=(json.load(sys.stdin)['data']['deputy'].get('hello') or {})
print(','.join(h.get('capabilities') or []))
" <"$OUT/01-helpers-status.json")
HVER=$(python3 -c "
import json,sys
h=(json.load(sys.stdin)['data']['deputy'].get('hello') or {})
print(h.get('deputyVersion') or '')
" <"$OUT/01-helpers-status.json")
case ",$CAPS," in *,observer,*) pass "helpers status advertises the observer capability (caps=$CAPS)";; *) fail "no observer capability in hello (caps=$CAPS)";; esac
[ "$HVER" = "1.4.0" ] && pass "helpers version 1.4.0" || fail "helpers version is '$HVER', expected 1.4.0"

things helpers status 2>/dev/null | tee "$OUT/01-helpers-status.txt" | sed 's/^/     | /'
run_cell 0 "02-doctor" doctor
things doctor 2>/dev/null | tee "$OUT/02-doctor.txt" | sed 's/^/     | /'
if grep -qi 'observer' "$OUT/02-doctor.txt" "$OUT/01-helpers-status.txt"; then
  pass "the observer row renders in doctor / helpers status"
else
  fail "neither doctor nor helpers status names the observer"
fi

########################################################################
echo ""
echo "===== CELL 2 — enable GUI driving (routed) ====="
########################################################################
things config set ui-enabled true >/dev/null && pass "ui-enabled on" || fail "could not set ui-enabled"
things config set experimental-area-reorder true >/dev/null && pass "experimental-area-reorder on" || fail "could not set experimental-area-reorder"

########################################################################
echo ""
echo "===== CELL 3 — PROVREM1 seed: the #699 rule shape (routed GUI drive) ====="
########################################################################
export THINGS_API_TRACE=1
clear_banners
run_cell 0 "03-seed-add-repeating" \
  todo add-repeating "$RCTAG-P" --after-completion --frequency weekly --interval 2 \
  --when 2026-07-08 --start-days-earlier 6 --reminder 12:00 --dangerously-drive-gui \
  --verify-timeout 90000
TR=$(newest_trace)
if [ -n "$TR" ] && grep -q '"phase":"ui-observer".*"transport":"deputy"' "$TR"; then
  pass "trace: observer transport = deputy"
  grep -o '"event":"[a-z-]*","transport":"deputy"[^}]*' "$TR" | head -3 | sed 's/^/     | /'
else
  fail "trace does not show a deputy-hosted observer session ($TR)"
  [ -n "$TR" ] && grep -o '"phase":"ui-observer"[^}]*' "$TR" | head -5 | sed 's/^/     | /'
fi
TMPL_P=$(db "SELECT uuid FROM TMTask WHERE title='$RCTAG-P' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
[ -n "$TMPL_P" ] && pass "template minted: $TMPL_P" || fail "no template for $RCTAG-P"

########################################################################
echo ""
echo "===== CELL 6 — DEFAULTS3 quadrants on a ROUTED host ====="
echo "  {observer deputy, observer off} x {prefill on, prefill off}"
########################################################################
quad() {
  local name="$1" obs="$2" pf="$3" title="$4"
  echo "--- quadrant $name (observer=$obs prefill=$pf) ---"
  clear_banners
  local before after
  before=$(db "SELECT count(*) FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL")
  STEP=$((STEP + 1))
  beep mark "[$STEP] quad $name"
  local t0 t1 out code
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  out=$(env THINGS_API_TRACE=1 ${obs:+THINGS_API_AX_OBSERVER=$obs} ${pf:+THINGS_API_PREFILL=$pf} \
    "$NODE" "$APP" todo add-repeating "$title" --when 2026-07-10 --frequency weekly --interval 1 \
    --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
  code=$?
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  printf '%s\n' "$out" >"$OUT/06-quad-$name.json"
  after=$(db "SELECT count(*) FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL")
  local ems
  ems=$(python3 -c "
import json,sys
try: print((json.loads(sys.stdin.read()).get('meta') or {}).get('elapsedMs',''))
except Exception: print('')
" <<<"$out")
  if [ "$code" -eq 0 ] && [ "$after" -eq "$((before + 1))" ]; then
    pass "[$STEP] quad $name — exit 0, template landed, wall=$((t1 - t0))ms elapsedMs=$ems"
  else
    fail "[$STEP] quad $name — exit $code, templates $before -> $after, elapsedMs=$ems"
    echo "     output: $(head -c 700 <<<"$out")"
  fi
  local tr
  tr=$(newest_trace)
  if [ -n "$tr" ]; then
    echo "     observer trace: $(grep -o '"phase":"ui-observer","event":"[a-z-]*"[^}]*' "$tr" | tail -1)"
  fi
}
quad "obsdeputy-pf-on"  ""  ""  "$RCTAG-Q1"
quad "obsdeputy-pf-off" ""  "0" "$RCTAG-Q2"
quad "obsoff-pf-on"     "0" ""  "$RCTAG-Q3"
quad "obsoff-pf-off"    "0" "0" "$RCTAG-Q4"

########################################################################
echo ""
echo "===== CELL 7 — make-repeating, routed (the other repeat verb) ====="
########################################################################
run_cell 0 "07a-seed-plain" todo add "$RCTAG-MR" --when 2026-07-10
MR=$(db "SELECT uuid FROM TMTask WHERE title='$RCTAG-MR' AND trashed=0 LIMIT 1")
echo "     seed: $MR"
clear_banners
run_cell 0 "07b-make-repeating" todo make-repeating "$MR" --frequency weekly --interval 1 \
  --dangerously-drive-gui --verify-timeout 90000
MRT=$(db "SELECT count(*) FROM TMTask WHERE title='$RCTAG-MR' AND rt1_recurrenceRule IS NOT NULL")
[ "$MRT" -ge 1 ] && pass "make-repeating landed a series" || fail "no series for $RCTAG-MR"
TR=$(newest_trace)
if [ -n "$TR" ] && grep -q '"transport":"deputy"' "$TR"; then
  pass "make-repeating used the deputy-hosted observer"
else
  fail "make-repeating trace shows no deputy observer"
fi

########################################################################
echo ""
echo "===== CELL 8 — area reorder (PTRGD1 pointer guards, ui-drag) ====="
########################################################################
run_cell 0 "08a-area-add-1" area add "$RCTAG-AREA-A"
run_cell 0 "08b-area-add-2" area add "$RCTAG-AREA-B"
AREA_ORDER_BEFORE=$(db "SELECT group_concat(title,'|') FROM (SELECT title FROM TMArea WHERE title LIKE '$RCTAG-AREA-%' ORDER BY \"index\")")
echo "     area order before: $AREA_ORDER_BEFORE"
clear_banners
STEP=$((STEP + 1)); beep mark "[$STEP] area reorder"
T0=$(python3 -c 'import time;print(int(time.time()*1000))')
AR_OUT=$(env THINGS_API_TRACE=1 "$NODE" "$APP" area reorder "$RCTAG-AREA-B" --first --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
AR_CODE=$?
T1=$(python3 -c 'import time;print(int(time.time()*1000))')
printf '%s\n' "$AR_OUT" >"$OUT/08c-area-reorder.json"
AREA_ORDER_AFTER=$(db "SELECT group_concat(title,'|') FROM (SELECT title FROM TMArea WHERE title LIKE '$RCTAG-AREA-%' ORDER BY \"index\")")
echo "     area order after:  $AREA_ORDER_AFTER"
echo "     exit=$AR_CODE wall=$((T1 - T0))ms"
echo "     $(head -c 700 <<<"$AR_OUT")"
if [ "$AR_CODE" -eq 0 ]; then
  pass "[$STEP] area reorder drove and reported ok"
else
  fail "[$STEP] area reorder exit $AR_CODE"
fi
if [ -n "$(newest_trace)" ]; then
  echo "     sidebar/drag trace lines:"
  grep -o '"phase":"sidebar-[a-z-]*"[^}]*' "$(newest_trace)" | head -4 | sed 's/^/     | /'
fi

########################################################################
echo ""
echo "===== CELL 9 — one op of each vector class, routed (the broker sits under all) ====="
########################################################################
run_cell 0 "09a-url-scheme-add" todo add "$RCTAG-URL" --when 2026-07-10 --reminder 09:00
V_URL=$(db "SELECT uuid FROM TMTask WHERE title='$RCTAG-URL' AND trashed=0 LIMIT 1")
run_cell 0 "09b-shortcuts-clear-reminder" todo clear-reminder "$V_URL"
V_REM=$(db "SELECT coalesce(reminderTime,-1) FROM TMTask WHERE uuid='$V_URL'")
[ "$V_REM" = "-1" ] && pass "shortcuts vector cleared the reminder" || fail "reminder still $V_REM"
run_cell 0 "09c-applescript-tag-add" tag add "$RCTAG-tag"
run_cell 0 "09d-applescript-delete" todo delete "$V_URL"

########################################################################
echo ""
echo "===== CELL 4 — roll the clock to 2026-07-08: the occurrence ARRIVES provisional ====="
########################################################################
kill_things
sudo date 070812002026 >/dev/null
echo "     clock -> $(date)"
launch_things
sleep 8
OCC_P=$(db "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TMPL_P' AND trashed=0 LIMIT 1")
if [ -n "$OCC_P" ]; then
  pass "occurrence spawned: $OCC_P"
else
  fail "no occurrence spawned from $TMPL_P"
fi
OCC_START=$(db "SELECT start FROM TMTask WHERE uuid='$OCC_P'")
echo "     occurrence start=$OCC_START (2 = someday-marked; the provisional Today shape)"
[ "$OCC_START" = "2" ] && pass "the occurrence arrived PROVISIONAL (start=2)" || fail "occurrence start=$OCC_START, expected 2"
run_cell 0 "04-show-occurrence" todo show "$OCC_P"
grep -o '"provisional":[a-z]*' "$OUT/04-show-occurrence.json" | head -1 | sed 's/^/     | /'

########################################################################
echo ""
echo "===== CELL 5 — the four #699 commands (PROVREM1 §5) ====="
########################################################################
echo "--- 5.1  --exception aimed at the OCCURRENCE (expect refusal, exit 4) ---"
run_cell 4 "05a-exception-on-occurrence" todo update "$OCC_P" --exception --when anytime
sed 's/^/     | /' <"$OUT/05a-exception-on-occurrence.json" | head -c 1200; echo
if grep -q 'an exception is what it already is' "$OUT/05a-exception-on-occurrence.json"; then
  pass "5.1 copy: names the occurrence-is-already-the-exception case"
else
  fail "5.1 copy does not match PROVREM1 §5.1"
fi
if grep -q 'with no --exception' "$OUT/05a-exception-on-occurrence.json"; then
  pass "5.1 remediation names the runnable command"
else
  fail "5.1 remediation missing the runnable command"
fi

echo "--- 5.2  --exception aimed at the TEMPLATE (expect refusal, exit 4) ---"
run_cell 4 "05b-exception-on-template" todo update "$TMPL_P" --exception --when anytime
sed 's/^/     | /' <"$OUT/05b-exception-on-template.json" | head -c 1200; echo
if grep -q 'no occurrence left to create' "$OUT/05b-exception-on-template.json"; then
  pass "5.2 copy: names the after-completion cursor state"
else
  fail "5.2 copy does not match PROVREM1 §5.2"
fi
if grep -q "$OCC_P" "$OUT/05b-exception-on-template.json"; then
  pass "5.2 remediation NAMES the open occurrence ($OCC_P)"
else
  fail "5.2 remediation does not name the occurrence"
fi

echo "--- 5.3  --when today --clear-reminder on the occurrence (expect ok, start stays 2) ---"
REM_BEFORE=$(db "SELECT coalesce(reminderTime,-1) FROM TMTask WHERE uuid='$OCC_P'")
run_cell 0 "05c-today-clear-reminder" todo update "$OCC_P" --when today --clear-reminder
REM_AFTER=$(db "SELECT coalesce(reminderTime,-1) FROM TMTask WHERE uuid='$OCC_P'")
START_AFTER=$(db "SELECT start FROM TMTask WHERE uuid='$OCC_P'")
echo "     reminderTime $REM_BEFORE -> $REM_AFTER ; start=$START_AFTER"
[ "$REM_AFTER" = "-1" ] && pass "the reminder is cleared" || fail "reminderTime still $REM_AFTER"
[ "$START_AFTER" = "2" ] && pass "start STAYS 2 — no false verify-failed" || fail "start moved to $START_AFTER (expected 2)"

echo "--- 5.4  --when anytime --clear-reminder in ONE call (expect ok) ---"
OCC_Q=""
run_cell 0 "05d-anytime-clear-reminder" todo update "$OCC_P" --when anytime --clear-reminder
START_AT=$(db "SELECT start FROM TMTask WHERE uuid='$OCC_P'")
SD_AT=$(db "SELECT coalesce(startDate,-1) FROM TMTask WHERE uuid='$OCC_P'")
REM_AT=$(db "SELECT coalesce(reminderTime,-1) FROM TMTask WHERE uuid='$OCC_P'")
echo "     start=$START_AT startDate=$SD_AT reminderTime=$REM_AT"
[ "$START_AT" = "1" ] && pass "the occurrence moved to Anytime (start=1)" || fail "start=$START_AT, expected 1"
TMPL_RULE=$(db "SELECT rt1_recurrenceRule IS NOT NULL FROM TMTask WHERE uuid='$TMPL_P'")
[ "$TMPL_RULE" = "1" ] && pass "the template's rule is intact" || fail "the template lost its rule"

########################################################################
echo ""
echo "===== CELL 10 — the broker's own verdict ====="
########################################################################
DENIED=$(deputy_since | grep -c 'rejected-script' || true)
if [ "${DENIED:-0}" -eq 0 ]; then
  pass "the deputy refused no script this run"
else
  fail "the deputy refused $DENIED script(s):"
  deputy_since | grep 'rejected-script' | head -5 | sed 's/^/     | /'
fi
OBS_SESSIONS=$(deputy_since | grep -c 'observer' || true)
echo "     deputy.log observer lines this run: ${OBS_SESSIONS:-0}"

echo ""
echo "===== alert beeps ====="
beep mark "stage5 end"
beep assert --name "stage5" --json "$HOME/things-lab/stage5-beeps.json" || fail "beep assertion"

echo ""
echo "STAGE 5 RESULT: $STEP cells, $FAILURES failures"
exit $((FAILURES > 0 ? 1 : 0))
