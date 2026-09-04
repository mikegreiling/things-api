#!/bin/bash
# Stage 5 cells — THE v0.20.10 BATCH. Run ON THE GUEST, on a routed golden-v4h
# clone (helpers 1.4.0, `helpers-enabled true`). NORMAL CLI syntax only: no
# osascript against Things, no hand-built things:/// URL, no lab escape, no
# direct driver invocation. (The two osascript uses below are FIXTURE
# management — quit/relaunch and window geometry — never an operation's path.)
#
# The v0.20.9 list (lab/guest/stage5-cells.sh) is kept verbatim beside this one:
# a cell list is the audit trail of what a release certified. This batch adds
# CELL 11 — the VOPAT2 PR 2 sparse sidebar census (#725) — and widens CELL 7 to
# all four repeat-dialog quadrants, because ui.ts's observer arming changed.
#
# Usage: stage5-cells-0.20.10.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
TRACE_DIR="$HOME/.local/state/things-api/trace"
DEPUTY_LOG="$HOME/.local/state/things-api/deputy/deputy.log"
FAILURES=0
STEP=0
RCTAG="RC210"

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
echo "===== CELL 7 — make-repeating, routed, ALL FOUR QUADRANTS ====="
echo "  ui.ts changed this batch (recipeWantsObserver / observer.session hand-off),"
echo "  so the other repeat verb is re-certified in every {observer} x {prefill} corner."
########################################################################
mkrep_quad() {
  local name="$1" obs="$2" pf="$3" title="$4"
  echo "--- make-repeating quadrant $name (observer=${obs:-deputy} prefill=${pf:-on}) ---"
  run_cell 0 "07-$name-seed" todo add "$title" --when 2026-07-10
  local ref
  ref=$(db "SELECT uuid FROM TMTask WHERE title='$title' AND trashed=0 LIMIT 1")
  echo "     seed: $ref"
  clear_banners
  STEP=$((STEP + 1))
  beep mark "[$STEP] make-repeating quad $name"
  local t0 t1 out code
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  out=$(env THINGS_API_TRACE=1 ${obs:+THINGS_API_AX_OBSERVER=$obs} ${pf:+THINGS_API_PREFILL=$pf} \
    "$NODE" "$APP" todo make-repeating "$ref" --frequency weekly --interval 1 \
    --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
  code=$?
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  printf '%s\n' "$out" >"$OUT/07-$name.json"
  local ems rule
  ems=$(python3 -c "
import json,sys
try: print((json.loads(sys.stdin.read()).get('meta') or {}).get('elapsedMs',''))
except Exception: print('')
" <<<"$out")
  rule=$(db "SELECT count(*) FROM TMTask WHERE title='$title' AND rt1_recurrenceRule IS NOT NULL")
  if [ "$code" -eq 0 ] && [ "${rule:-0}" -ge 1 ]; then
    pass "[$STEP] make-repeating quad $name — exit 0, series landed, wall=$((t1 - t0))ms elapsedMs=$ems"
  else
    fail "[$STEP] make-repeating quad $name — exit $code, series rows=$rule, elapsedMs=$ems"
    echo "     output: $(head -c 700 <<<"$out")"
  fi
  local tr
  tr=$(newest_trace)
  if [ -n "$tr" ]; then
    echo "     observer trace: $(grep -o '"phase":"ui-observer","event":"[a-z-]*"[^}]*' "$tr" | tail -1)"
    if [ -z "$obs" ]; then
      grep -q '"phase":"ui-observer".*"transport":"deputy"' "$tr" \
        && pass "quad $name: observer transport = deputy" \
        || fail "quad $name: no deputy-hosted observer session in the trace"
    fi
  fi
}
mkrep_quad "mr-obsdeputy-pf-on"  ""  ""  "$RCTAG-MR1"
mkrep_quad "mr-obsdeputy-pf-off" ""  "0" "$RCTAG-MR2"
mkrep_quad "mr-obsoff-pf-on"     "0" ""  "$RCTAG-MR3"
mkrep_quad "mr-obsoff-pf-off"    "0" "0" "$RCTAG-MR4"

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
echo "===== CELL 11 — VOPAT2 PR 2: the sparse sidebar census (#725) ====="
echo "  ui-drag.ts / ui-sidebar-map.ts / ui-pointer-guard.ts / ui.ts all changed,"
echo "  so area.reorder is re-certified on a #676-shaped sidebar: --first, --last,"
echo "  a mid-list --before, a move that needs the SBCOL1 fold, and the"
echo "  THINGS_API_SIDEBAR_SPARSE=0 A/B that must land the identical order."
########################################################################
PLIST="$HOME/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist"
# `plutil -extract <array> raw` prints the element COUNT, not the elements
# (VOPAT2 PR 2 §10(a)) — xml1 plus the <string> bodies is the set.
collapsed_uuids() {
  plutil -extract collapsedAreaUUIDs xml1 -o - "$PLIST" 2>/dev/null \
    | sed -n 's:.*<string>\(.*\)</string>.*:\1:p' | tr -d '\r'
}
collapsed_n() { collapsed_uuids | grep -c . || true; }
area_order() { db "SELECT COALESCE(group_concat(t,'|'),'') FROM (SELECT title AS t FROM TMArea ORDER BY \"index\", uuid)"; }
sidebar_rows_db() { db "SELECT (SELECT count(*) FROM TMArea) + (SELECT count(*) FROM TMTask WHERE type=1 AND trashed=0 AND status=0 AND area IS NOT NULL)"; }

# The trace sink stamps `ts`/`elapsedMs` in FRONT of the event's own fields, so
# `phase` is never at the start of a line — parse, don't pattern-match.
cost_record() {
  local tr="$1"
  [ -n "$tr" ] || { echo ""; return; }
  python3 -c "
import json, sys
rec = None
for line in open(sys.argv[1], errors='replace'):
    line = line.strip()
    if not line: continue
    try: d = json.loads(line)
    except Exception: continue
    if d.get('phase') == 'sidebar-move-cost': rec = d
print(json.dumps(rec) if rec is not None else '')
" "$tr"
}

# cost_field <record-json> <key> — one field out of a cost record, tolerating an
# empty record (sb_move has already reported the FAIL in that case). A `g.`
# prefix reads the gesture counts, `s.` the settle counts.
cost_field() {
  python3 -c "
import json, sys
raw = sys.argv[1]
try: d = json.loads(raw) if raw else {}
except Exception: d = {}
g = d.get('gestures') or {}
st = d.get('settles') or {}
key = sys.argv[2]
if key.startswith('g.'): print(g.get(key[2:], 0))
elif key.startswith('s.'): print(st.get(key[2:], 0))
else: print(d.get(key, ''))
" "$1" "$2"
}

# --- the fixture: one WALL section taller than any viewport, plus four movers -
echo "--- seeding the #676-shaped sidebar (synthetic) ---"
things config set ui-enabled true >/dev/null
for A in WALL SB-1 SB-2 SB-3 SB-4; do
  things area add "$RCTAG-$A" >/dev/null 2>&1 || fail "could not add area $RCTAG-$A"
done
WALL_N="${STAGE5_WALL_PROJECTS:-40}"
echo "     seeding $WALL_N projects under $RCTAG-WALL (the wall)…"
for i in $(seq -w 1 "$WALL_N"); do
  things project add "$RCTAG-W$i" --area "$RCTAG-WALL" >/dev/null 2>&1
done
echo "     areas now: $(db 'SELECT count(*) FROM TMArea')  ·  db-modelled sidebar rows: $(sidebar_rows_db)"
# Window geometry pinned so the wall is a wall by construction (the vopat2
# fixture's own 935x420 -> a ~346pt sidebar viewport, ~14 rows).
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1
sleep 2
osascript -e 'tell application "System Events" to tell process "Things3" to set size of window 1 to {935, 420}' >/dev/null 2>&1
sleep 2
echo "     Things window: $(osascript -e 'tell application "System Events" to tell process "Things3" to get size of window 1' 2>/dev/null)"
echo "     area order: $(area_order)"

# --- one move, fully instrumented -------------------------------------------
# sb_move <name> <expect-exit> <extra-env> -- <cli args…>
sb_move() {
  local name="$1" expect="$2" envs="$3"; shift 3
  [ "$1" = "--" ] && shift
  clear_banners
  STEP=$((STEP + 1))
  beep mark "[$STEP] $name"
  local before after t0 t1 out code
  before=$(area_order)
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  out=$(env THINGS_API_TRACE=1 $envs "$NODE" "$APP" "$@" --json 2>/dev/null)
  code=$?
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  after=$(area_order)
  printf '%s\n' "$out" >"$OUT/11-$name.json"
  SB_OUT="$out"; SB_CODE=$code; SB_BEFORE="$before"; SB_AFTER="$after"; SB_WALL=$((t1 - t0))
  local ems
  ems=$(python3 -c "
import json,sys
try: print((json.loads(sys.stdin.read()).get('meta') or {}).get('elapsedMs',''))
except Exception: print('')
" <<<"$out")
  SB_ELAPSED="$ems"
  echo "     cmd:    things $* ${envs:+[$envs]}"
  echo "     before: $before"
  echo "     after:  $after"
  # NEVER put a `{...}` comprehension inside a `$( )` inside a double-quoted
  # string: the guest runs macOS /bin/bash 3.2, which brace-expands the python
  # source at its commas and hands the shell three fragments (the v0.20.10 gate
  # run printed three SyntaxErrors per move where this summary belongs — display
  # only, every assertion around it reads the DB, the trace or the envelope).
  # Assign at statement level and keep the python loop brace-free.
  local summary
  summary=$(python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read()).get('data') or dict()
    out = dict()
    for k in ('detail', 'collapsed', 'collapseUnrestored', 'notes'):
        if k in d: out[k] = d[k]
    print(json.dumps(out)[:400])
except Exception:
    print('(unparseable)')
" <<<"$out")
  echo "     result: $summary"
  local tr rec
  tr=$(newest_trace); rec=$(cost_record "$tr")
  SB_COST="$rec"
  if [ -n "$rec" ]; then
    pass "[$STEP] $name — sidebar-move-cost recorded"
    python3 -c "
import json,sys
d=json.loads(sys.argv[1])
g=d.get('gestures') or {}; st=d.get('settles') or {}
print('     cost: elapsedMs=%s sparseEnabled=%s observer=%s rows=%s | censuses=%s (sparse=%s sweep=%s esc=%s) axCalls=%s rowsRealized=%s | gestures drag=%s chevron=%s scroll=%s vis=%s | settles observed=%s missed=%s timer=%s' % (
  d.get('elapsedMs'), d.get('sparseEnabled'), d.get('observer'), d.get('rows'),
  d.get('censuses'), d.get('sparse'), d.get('sweeps'), d.get('escalations'),
  d.get('axCalls'), d.get('rowsRealized'),
  g.get('drag'), g.get('chevron'), g.get('scroll'), g.get('visibility'),
  st.get('observed'), st.get('missed'), st.get('timer')))
" "$rec"
  else
    fail "[$STEP] $name — no sidebar-move-cost record in $tr"
  fi
  if [ -n "$tr" ] && grep -q '"phase":"ui-observer".*"transport":"deputy"' "$tr"; then
    pass "[$STEP] $name — observer transport = deputy"
  else
    fail "[$STEP] $name — the drive's trace shows no deputy-hosted observer"
    [ -n "$tr" ] && grep -o '"phase":"ui-observer"[^}]*' "$tr" | head -3 | sed 's/^/     | /'
  fi
  if [ "$code" -eq "$expect" ]; then
    pass "[$STEP] $name — exit $code wall=${SB_WALL}ms elapsedMs=$ems"
  else
    fail "[$STEP] $name — exit $code (expected $expect) wall=${SB_WALL}ms elapsedMs=$ems"
    echo "     output: $(head -c 900 <<<"$out")"
  fi
}

pos_of() { python3 -c "
import sys
order=sys.argv[1].split('|'); t=sys.argv[2]
print(order.index(t) if t in order else -1)
" "$1" "$2"; }
last_area() { python3 -c "
import sys
print(sys.argv[1].split('|')[-1])
" "$1"; }
first_area() { python3 -c "
import sys
print(sys.argv[1].split('|')[0])
" "$1"; }

# --- 11.1  the move that must cross the WALL (SBCOL1 fold + restore) ---------
echo ""
echo "--- 11.1  a move ACROSS the wall — the SBCOL1 fold rung ---"
O="$(area_order)"
WPOS=$(pos_of "$O" "$RCTAG-WALL")
LASTA=$(last_area "$O"); FIRSTA=$(first_area "$O")
LPOS=$(pos_of "$O" "$LASTA")
if [ "$WPOS" -lt "$LPOS" ]; then
  MOVER="$LASTA"; DEST="--first"
else
  MOVER="$FIRSTA"; DEST="--last"
fi
echo "     wall at ordinal $WPOS; moving \"$MOVER\" $DEST across it"
sb_move "01-across-the-wall" 0 "" -- area reorder "$MOVER" "$DEST" --dangerously-drive-gui --verify-timeout 240000
FOLDED=$(python3 -c "
import json,sys
try: print(len((json.loads(sys.stdin.read()).get('data') or {}).get('collapsed') or []))
except Exception: print(0)
" <<<"$SB_OUT")
CHEV=$(cost_field "$SB_COST" "g.chevron")
if [ "${FOLDED:-0}" -ge 1 ] || [ "${CHEV:-0}" -ge 1 ]; then
  pass "11.1 the collapse rung fired (collapsed=${FOLDED}, chevron gestures=${CHEV})"
else
  fail "11.1 no fold happened — the fixture did not build a wall (collapsed=${FOLDED}, chevron=${CHEV})"
fi
sleep 3
NC=$(collapsed_n)
if [ "${NC:-0}" -eq 0 ]; then
  pass "11.1 the disclosure state is RESTORED (collapsedAreaUUIDs empty)"
else
  fail "11.1 the sidebar is left folded — collapsedAreaUUIDs holds ${NC}: $(collapsed_uuids | tr '\n' ' ')"
fi
python3 -c "
import sys
a=sys.argv[1].split('|'); m=sys.argv[2]; d=sys.argv[3]
want = 0 if d=='--first' else len(a)-1
print('ok' if a.index(m)==want else 'BAD')
" "$SB_AFTER" "$MOVER" "$DEST" | grep -q ok \
  && pass "11.1 \"$MOVER\" landed at the $DEST end" \
  || fail "11.1 \"$MOVER\" did not land at the $DEST end"

# --- 11.2  --last -----------------------------------------------------------
echo ""
echo "--- 11.2  --last ---"
sb_move "02-last" 0 "" -- area reorder "$RCTAG-SB-1" --last --dangerously-drive-gui --verify-timeout 240000
[ "$(last_area "$SB_AFTER")" = "$RCTAG-SB-1" ] \
  && pass "11.2 $RCTAG-SB-1 is last" || fail "11.2 $RCTAG-SB-1 is not last"

# --- 11.3  a mid-list --before ---------------------------------------------
echo ""
echo "--- 11.3  a mid-list --before ---"
sb_move "03-before" 0 "" -- area reorder "$RCTAG-SB-3" --before "$RCTAG-SB-2" --dangerously-drive-gui --verify-timeout 240000
python3 -c "
import sys
o=sys.argv[1].split('|')
print('ok' if o.index(sys.argv[2])+1==o.index(sys.argv[3]) else 'BAD')
" "$SB_AFTER" "$RCTAG-SB-3" "$RCTAG-SB-2" | grep -q ok \
  && pass "11.3 $RCTAG-SB-3 sits immediately above $RCTAG-SB-2" \
  || fail "11.3 the --before placement did not land"

# --- 11.4  THINGS_API_SIDEBAR_SPARSE=0 lands the IDENTICAL move -------------
echo ""
echo "--- 11.4  the A/B: sparse census vs the shipped-before full sweep ---"
AB_BASE="$(area_order)"
sb_move "04a-ab-sparse" 0 "" -- area reorder "$RCTAG-SB-1" --before "$RCTAG-SB-3" --dangerously-drive-gui --verify-timeout 240000
AB_SPARSE="$SB_AFTER"; AB_SPARSE_COST="$SB_COST"; AB_SPARSE_MS="$SB_ELAPSED"
sb_move "04b-ab-restore" 0 "" -- area reorder "$RCTAG-SB-1" --last --dangerously-drive-gui --verify-timeout 240000
if [ "$SB_AFTER" = "$AB_BASE" ]; then
  pass "11.4 the A/B baseline is restored"
else
  fail "11.4 could not restore the A/B baseline (got $SB_AFTER, wanted $AB_BASE)"
fi
sb_move "04c-ab-sweep" 0 "THINGS_API_SIDEBAR_SPARSE=0" -- area reorder "$RCTAG-SB-1" --before "$RCTAG-SB-3" --dangerously-drive-gui --verify-timeout 240000
AB_SWEEP="$SB_AFTER"; AB_SWEEP_COST="$SB_COST"; AB_SWEEP_MS="$SB_ELAPSED"
if [ "$AB_SPARSE" = "$AB_SWEEP" ]; then
  pass "11.4 SPARSE=0 landed the IDENTICAL order: $AB_SWEEP"
else
  fail "11.4 the two censuses disagree — sparse=$AB_SPARSE sweep=$AB_SWEEP"
fi
SW_SPARSE=$(cost_field "$AB_SWEEP_COST" "sparse")
SW_ENABLED=$(cost_field "$AB_SWEEP_COST" "sparseEnabled")
if [ "$SW_ENABLED" = "False" ] && [ "${SW_SPARSE:-1}" -eq 0 ]; then
  pass "11.4 the SPARSE=0 arm really ran the full sweep (sparseEnabled=False, sparse censuses=0)"
else
  fail "11.4 the SPARSE=0 arm did not fall back (sparseEnabled=$SW_ENABLED, sparse censuses=$SW_SPARSE)"
fi
echo "     A/B cost, same move, one env var apart:"
echo "       sparse: $AB_SPARSE_COST"
echo "       sweep : $AB_SWEEP_COST"

echo ""
echo "--- CELL 11 epilogue: the sidebar is as it was found ---"
echo "     collapsedAreaUUIDs: [$(collapsed_uuids | tr '\n' ' ')]"
echo "     final area order:   $(area_order)"

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
