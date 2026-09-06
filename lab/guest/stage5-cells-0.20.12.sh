#!/bin/bash
# Stage 5 cells — the v0.20.12 batch. Run ON THE GUEST, on a routed
# golden-v4h clone (helpers 1.4.0, `helpers-enabled true`). NORMAL CLI syntax
# only: no osascript against an operation's path, no hand-built things:/// URL,
# no lab escape, no direct driver invocation. The osascript uses below are
# FIXTURE management (relaunch the app, close its window, start the saver) and
# the beep sentinel is the rig.
#
# WHY THIS LIST. The batch rewrites the Repeat drive's transport (RAWAX1, #734),
# puts a mutation lock around every multi-leg operation (BATCH1, #735), moves the
# session-lock question onto the preamble and adds a saver wake plus a window
# reopen rung (LOCKSCR1 #733 / LOCKSCR2 #737), and lets a routed drive drop the
# poll node already waited out (DEPOBS3, #736). So the cells are:
#
#   1   routed identity — the arm certifies nothing if it is not routed
#   2   GUI driving enabled (ui + experimental area reorder)
#   3   the PROVREM1 seed, with the deputy-hosted observer proven from the trace
#   4   RAWAX1 A/B — every dialog state driven BOTH ways, blobs byte-compared
#   5   the FENCES — pre-dispatch refusals, on both transports
#   6   the QUADRANTS — {rawax}x{observer}x{prefill} crossed, each proven from
#       its own trace, plus DEFAULTS3's original four on `add-repeating`
#   7   the CANCEL rung — a refusing drive commits nothing and leaves no sheet
#   8   DLSEED1 — the deadlined source promotes, four geometries + the control
#   9   the hop count, read out of the drive's own trace
#  10   area reorder --first / --last, and the BATCH1 CONTENTION cell
#  11   one op of each vector class (the broker sits under all of them)
#  12   the clock roll and the four #699 commands
#  13   the reopen rung: a closed window, sidebar class AND dialog class
#  14   screen saver, no password — the nudge wakes it
#  15   screen saver, password required — the nudge fails honestly
#  16   window closed AND hard-locked — the session outranks the inventory
#  17   LOCKED — the refusals, both operation classes
#  18   the broker's own verdict, and the beep sentinel
#
# ORDER IS LOAD-BEARING. A screen-saver sitting that is not dismissed leaves
# `CGSSessionScreenIsLocked` set for the rest of that login (LOCKSCR1 §1 law 2),
# so every cell that can leave the session locked runs last and the clone is
# destroyed straight after.
#
# BASH 3.2. Never write a `{...}` brace expression inside a `$( )` inside a
# double-quoted string — the guest's shell brace-expands the inner text at its
# commas and hands the shell fragments.
#
# Usage: stage5-cells-0.20.12.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP_DIR="$2"
APP="$APP_DIR/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
TRACE_DIR="$HOME/.local/state/things-api/trace"
DEPUTY_LOG="$HOME/.local/state/things-api/deputy/deputy.log"
FAILURES=0
STEP=0
RCTAG="RC2012"
START="2026-07-09"     # a Thursday; the guest clock is pinned to 2026-07-05
DEADLINE="2026-07-12"

UIDN=$(id -u)
ME=$(id -un)

BEEP_SENTINEL="$(dirname "$0")/beep-sentinel.sh"
export BEEP_MARKS="$HOME/things-lab/stage5-beep-marks.tsv"
beep() { [ -f "$BEEP_SENTINEL" ] || return 0; bash "$BEEP_SENTINEL" "$@"; }
beep reset; beep mark "stage5 start"

things() { "$NODE" "$APP" "$@"; }

# The Aqua-session wrapper (LOCKSCR2's field shape) — used by the cells whose
# subject IS the login session. Everything else runs as the ssh login does,
# which LOCKSCR1 §1 law 3 measured as byte-identical for the session read.
GUI_ENV=("HOME=$HOME" "PATH=$PATH")
gui() { sudo launchctl asuser "$UIDN" sudo -u "$ME" /usr/bin/env "${GUI_ENV[@]}" "$@"; }
things_gui() { gui "$NODE" "$APP" "$@"; }

fail() { echo "FAIL $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   $*"; }
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

db() {
  python3 -c "
import glob, os, sqlite3, sys
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
r = c.execute(sys.argv[1]).fetchone()
print('' if r is None else ('' if r[0] is None else r[0]))
" "$1"
}

# THE ORACLE: the recurrence blob as a HEX LITERAL. A decoded summary can agree
# while the blob differs; only the bytes settle "the same rule".
blob() { db "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'"; }

rule() {
  python3 -c "
import glob, os, plistlib, sqlite3, sys
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
r = c.execute('SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, deadline FROM TMTask WHERE uuid=?', (sys.argv[1],)).fetchone()
def dpk(v):
    if not isinstance(v, int) or v == 0: return v
    y = v >> 16; m = (v >> 12) & 0xF; d = (v >> 7) & 0x1F
    return '%04d-%02d-%02d' % (y, m, d) if 1 < y < 5000 else v
if not r: print('NO-ROW'); raise SystemExit
d = plistlib.loads(r[0]) if r[0] else {}
offs = ','.join('{' + ','.join('%s=%s' % (k, o[k]) for k in ('dy','mo','wd','wdo') if k in o) + '}' for o in d.get('of', []))
print('tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] next=%s deadlined=%s' % (
  d.get('tp'), d.get('fu'), d.get('fa'), d.get('ts'), d.get('rc'), offs, dpk(r[1]), 'yes' if r[2] else 'no'))
" "$1"
}

jqp() { python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for k in sys.argv[1:]:
    d = d.get(k) if isinstance(d,dict) else None
    if d is None: break
print('' if d is None else (d if isinstance(d,str) else json.dumps(d)))
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
close_things_window() {
  osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1
  sleep 2
  osascript -e 'tell application "System Events" to keystroke "w" using command down' >/dev/null 2>&1
  sleep 3
}
std_windows() {
  osascript -e 'tell application "System Events" to tell process "Things3" to count (windows whose subrole is "AXStandardWindow")' 2>/dev/null
}
saver_state() { pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo gone; }
area_order() {
  db "SELECT group_concat(title,'|') FROM (SELECT title FROM TMArea WHERE title LIKE '$RCTAG-AREA-%' ORDER BY \"index\")"
}
session_state() { things_gui doctor --ui-state --json 2>/dev/null | jqp data uiState session state; }
session_keys() { things_gui doctor --ui-state --json 2>/dev/null | jqp data uiState session keys; }

# run_cell <expected-exit> <name> -- <cli args...>
run_cell() {
  local expect="$1" name="$2"; shift 2
  STEP=$((STEP + 1))
  beep mark "[$STEP] $name"
  local t0 t1 out code ems
  t0=$(now_ms)
  out=$(things "$@" --json 2>/dev/null); code=$?
  t1=$(now_ms)
  LAST_OUT="$out"; LAST_CODE=$code; LAST_WALL=$((t1 - t0))
  printf '%s\n' "$out" >"$OUT/$name.json"
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

# THE ADD IS ASYNCHRONOUS, SO THE READ-BACK RETRIES (RAWAX1's seed shape): the
# URL scheme returns before Things has committed the row, and a uuid readable in
# the database is not yet resolvable by the CLI.
seed() {
  local title="$1" when="$2" dl="${3:-}" i u
  if [ -n "$dl" ]; then
    things todo add "$title" --when "$when" --deadline "$dl" --json >/dev/null 2>&1
  else
    things todo add "$title" --when "$when" --json >/dev/null 2>&1
  fi
  for i in 1 2 3 4 5; do
    u=$(db "SELECT uuid FROM TMTask WHERE title='$title' AND trashed=0 AND rt1_recurrenceRule IS NULL ORDER BY creationDate DESC LIMIT 1")
    if [ -n "$u" ] && things todo get "$u" --json >/dev/null 2>&1; then
      printf '%s' "$u"
      return 0
    fi
    sleep "$i"
  done
  printf '%s' "$u"
}

LAST_BLOB=""; LAST_RULE=""; LAST_MS=0; LAST_CODE=0; LAST_TRACE=""
# drive <name> <uuid> <title> -- <make-repeating args...>
#
# THE UUID IS PASSED IN, NOT RE-LOOKED-UP: a promote mints a TEMPLATE carrying
# the seed's own title, so a title lookup after one returns the template.
drive() {
  local name="$1" uuid="$2" title="$3"; shift 3
  local t0 t1 out code tmpl
  if [ -z "$uuid" ]; then fail "[$STEP] $name — no seed uuid for $title"; return 1; fi
  STEP=$((STEP + 1))
  beep mark "[$STEP] $name"
  t0=$(now_ms)
  out=$(things todo make-repeating "$uuid" "$@" --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
  code=$?
  t1=$(now_ms)
  printf '%s\n' "$out" >"$OUT/$name.json"
  LAST_CODE=$code
  LAST_MS=$((t1 - t0))
  LAST_TRACE=$(newest_trace)
  [ -n "$LAST_TRACE" ] && cp "$LAST_TRACE" "$OUT/$name.trace.jsonl" 2>/dev/null
  tmpl=$(db "SELECT uuid FROM TMTask WHERE title='$title' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
  if [ "$code" -ne 0 ] || [ -z "$tmpl" ]; then
    LAST_BLOB=""; LAST_RULE=""
    if [ "${EXPECT_REFUSAL:-0}" = "1" ]; then
      echo "     [$STEP] $name — exit $code, template='$tmpl' wall=${LAST_MS}ms (the caller asserts this)"
      echo "     output: $(head -c 400 <<<"$out")"
      return 1
    fi
    fail "[$STEP] $name — exit $code, template='$tmpl' wall=${LAST_MS}ms"
    echo "     output: $(head -c 600 <<<"$out")"
    return 1
  fi
  LAST_BLOB=$(blob "$tmpl")
  LAST_RULE=$(rule "$tmpl")
  echo "     landed: $LAST_RULE   (wall=${LAST_MS}ms)"
  return 0
}

# ab <name> <args...> — the SAME rule driven both ways, blobs byte-compared.
# The campaign's central assertion: a transport change that alters a landed rule
# is not a transport change. BOTH arms always run, even when the first fails.
ab() {
  local name="$1"; shift
  local rawTitle="$RCTAG-$name-RAW" oldTitle="$RCTAG-$name-OLD" rawU oldU
  rawU=$(seed "$rawTitle" "$START")
  oldU=$(seed "$oldTitle" "$START")
  clear_banners
  THINGS_API_REPEAT_RAWAX=1 drive "$name-raw" "$rawU" "$rawTitle" "$@"
  local rawBlob="$LAST_BLOB" rawRule="$LAST_RULE" rawMs="$LAST_MS" rawCode="$LAST_CODE"
  clear_banners
  THINGS_API_REPEAT_RAWAX=0 drive "$name-old" "$oldU" "$oldTitle" "$@"
  local oldBlob="$LAST_BLOB" oldMs="$LAST_MS" oldCode="$LAST_CODE"
  STEP=$((STEP + 1))
  if [ -z "$rawBlob" ] && [ -z "$oldBlob" ]; then
    if [ "$rawCode" = "$oldCode" ]; then
      pass "[$STEP] $name — neither transport landed a rule, and both exited $rawCode (SAME on both)"
    else
      fail "[$STEP] $name — the transports refused DIFFERENTLY (raw exit $rawCode / applescript exit $oldCode)"
    fi
  elif [ "$rawBlob" = "$oldBlob" ] && [ -n "$rawBlob" ]; then
    pass "[$STEP] $name — blobs BYTE-IDENTICAL across transports  (raw ${rawMs}ms / applescript ${oldMs}ms)"
  elif [ -z "$rawBlob" ] || [ -z "$oldBlob" ]; then
    fail "[$STEP] $name — ONE transport landed a rule and the other did not (raw exit $rawCode / applescript exit $oldCode)"
    echo "     the one that landed: ${rawBlob:-$oldBlob}"
  else
    fail "[$STEP] $name — the transports landed DIFFERENT rules"
    echo "     raw: $rawBlob"
    echo "     old: $oldBlob"
    echo "     raw rule: $rawRule"
  fi
}

# refuses <name> <expected-substring> -- <args...> — a pre-dispatch fence, both
# transports. A refusal is contract too, and must survive the transport change.
refuses() {
  local name="$1" want="$2"; shift 2
  local title="$RCTAG-$name" u out code r
  for r in 1 0; do
    u=$(seed "$title-$r" "$START")
    STEP=$((STEP + 1))
    out=$(THINGS_API_REPEAT_RAWAX=$r things todo make-repeating "$u" "$@" \
      --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
    code=$?
    printf '%s\n' "$out" >"$OUT/$name-$r.json"
    case "$out" in
      *"$want"*) if [ "$code" -ne 0 ]; then
           pass "[$STEP] $name (rawax=$r) — refused before driving, and named it"
         else
           fail "[$STEP] $name (rawax=$r) — the sentence is there but the exit was 0"
         fi ;;
      *) fail "[$STEP] $name (rawax=$r) — exit $code, and the sentence did not name: $want"
         echo "     output: $(head -c 400 <<<"$out")" ;;
    esac
  done
}

echo "############################################################"
echo "# Stage 5 — v0.20.12 field-shaped RC run, routed guest"
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
[ "$HVER" = "1.4.0" ] && pass "helpers version 1.4.0 (unchanged this batch)" || fail "helpers version is '$HVER', expected 1.4.0"

things helpers status 2>/dev/null | tee "$OUT/01-helpers-status.txt" | sed 's/^/     | /'
run_cell 0 "02-doctor" doctor
things doctor 2>/dev/null | tee "$OUT/02-doctor.txt" | sed 's/^/     | /'
if grep -qi 'observer' "$OUT/02-doctor.txt" "$OUT/01-helpers-status.txt"; then
  pass "the observer row renders in doctor / helpers status"
else
  fail "neither doctor nor helpers status names the observer"
fi

# LOCKSCR1's new session row, on an unlocked Mac.
STEP=$((STEP + 1))
UI_SESSION=$(things doctor --ui-state --json 2>/dev/null | jqp data uiState session state)
if [ "$UI_SESSION" = "unlocked" ]; then
  pass "[$STEP] doctor --ui-state reports session=unlocked"
else
  fail "[$STEP] doctor --ui-state reports session='$UI_SESSION' (expected unlocked)"
fi

########################################################################
echo ""
echo "===== CELL 2 — enable GUI driving (routed) ====="
########################################################################
things config set ui-enabled true >/dev/null && pass "ui-enabled on" || fail "could not set ui-enabled"
things config set experimental-area-reorder true >/dev/null && pass "experimental-area-reorder on" || fail "could not set experimental-area-reorder"
export THINGS_API_TRACE=1

########################################################################
echo ""
echo "===== CELL 3 — PROVREM1 seed: the #699 rule shape (routed GUI drive) ====="
########################################################################
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
echo "===== CELL 4 — RAWAX1 A/B: every dialog state, BOTH transports ====="
echo "  THINGS_API_REPEAT_RAWAX=1 (the new default) vs =0 (the AppleScript path)"
########################################################################
ab "daily"     --frequency daily --interval 3
# THE SHAPE THE GATE WENT EIGHT RELEASES WITHOUT SEEING (RAWAX1 §5c.2): a weekly
# rule with a weekday converge that moves the first occurrence away from the
# seed's own date. `weekly --interval 1` alone cannot reproduce it.
ab "weekly"    --frequency weekly --interval 1 --weekdays monday,thursday
ab "monthly"   --frequency monthly --interval 2
ab "yearly"    --frequency yearly --interval 1
ab "aftercomp" --frequency weekly --interval 3 --after-completion
ab "deadline"  --frequency weekly --interval 1 --deadline --start-days-earlier 2
ab "zerodl"    --frequency weekly --interval 1 --deadline --start-days-earlier 0
ab "reminder"  --frequency weekly --interval 1 --reminder 09:30
ab "nextdate"  --frequency weekly --interval 1 --when "$START"
ab "monthday"  --frequency monthly --interval 1 --on-day 20 --when 2026-07-20
ab "yearmonth" --frequency yearly --interval 1 --yearly-month 11 --on-day 3 --when 2026-11-03
ab "endson"    --frequency weekly --interval 1 --ends-on 2026-09-30

# `--ends-after` TWICE IN A ROW — KNOWN RED, and marked so.
#
# The FIRST such promote lands and the SECOND refuses: the drive succeeds and the
# post-drive oracle then polls thirty times, reports `mismatch`, and rolls the
# original back — the caller sees `not-found` naming an internal clone uuid.
# Reproduced on origin/main with BOTH arms running the same AppleScript drive, so
# it is the SEQUENCE and not any transport. Queued in docs/up-next.md; the cell
# asserts the shape on record so the day it changes — in EITHER direction — the
# gate says so rather than staying quietly red.
echo ""
echo "--- the KNOWN RED cell: --ends-after twice in a row ---"
EA_RAW_TITLE="$RCTAG-endsafter-RAW"; EA_OLD_TITLE="$RCTAG-endsafter-OLD"
EA_RAW=$(seed "$EA_RAW_TITLE" "$START")
EA_OLD=$(seed "$EA_OLD_TITLE" "$START")
clear_banners
THINGS_API_REPEAT_RAWAX=1 drive "endsafter-raw" "$EA_RAW" "$EA_RAW_TITLE" --frequency daily --interval 1 --ends-after 4
EA_RAW_BLOB="$LAST_BLOB"; EA_RAW_CODE="$LAST_CODE"
clear_banners
EXPECT_REFUSAL=1 THINGS_API_REPEAT_RAWAX=0 drive "endsafter-old" "$EA_OLD" "$EA_OLD_TITLE" --frequency daily --interval 1 --ends-after 4
EA_OLD_BLOB="$LAST_BLOB"; EA_OLD_CODE="$LAST_CODE"
STEP=$((STEP + 1))
if [ -n "$EA_RAW_BLOB" ] && [ "$EA_RAW_BLOB" = "$EA_OLD_BLOB" ]; then
  fail "[$STEP] KNOWN RED cell: both --ends-after promotes landed — the queued defect is FIXED, retire this cell"
elif [ -n "$EA_RAW_BLOB" ] && [ -z "$EA_OLD_BLOB" ]; then
  pass "[$STEP] KNOWN RED (queued): the FIRST --ends-after promote lands (exit $EA_RAW_CODE), the SECOND refuses (exit $EA_OLD_CODE) — unchanged"
else
  fail "[$STEP] KNOWN RED cell: --ends-after changed shape (first exit $EA_RAW_CODE blob='$EA_RAW_BLOB' / second exit $EA_OLD_CODE blob='$EA_OLD_BLOB') — re-open the queued item"
fi

echo ""
echo "--- DEPOBS3: where the cross-hop wait lives on each transport ---"
# THE ROUTED LEVER, ASSERTED FROM THE TRACE RATHER THAN FROM THE SWITCH.
#
# The two transports place the cadence-rebuild wait in DIFFERENT places, and
# that is the design rather than a discrepancy:
#
#  * `THINGS_API_REPEAT_RAWAX=0` keeps the frequency selection as its own hop, so
#    node absorbs the rebuild BETWEEN hops against the deputy's ledger and emits
#    `ui-crosshop … observable: cadence-rebuild, absorbed: true` (DEPOBS3 A.2 i).
#  * the raw transport MERGES that boundary, so there is no between-hops moment
#    to absorb in and the merged program polls for the group in-script —
#    RAWAX1 §5c.8's fix, and the safe direction. What it must still show is that
#    the observer is DEPUTY-HOSTED and that node's own settles are being served
#    by it (`ui-settle … transport: deputy`).
STEP=$((STEP + 1))
if grep -q '"phase":"ui-crosshop".*"observable":"cadence-rebuild","absorbed":true' "$OUT/weekly-old.trace.jsonl" 2>/dev/null; then
  pass "[$STEP] DEPOBS3: the AppleScript transport absorbs the cadence rebuild in NODE"
  grep -o '"phase":"ui-crosshop"[^}]*' "$OUT/weekly-old.trace.jsonl" | head -2 | sed 's/^/     | /'
else
  fail "[$STEP] no absorbed cadence-rebuild record on the AppleScript transport"
  grep -o '"phase":"ui-crosshop"[^}]*' "$OUT/weekly-old.trace.jsonl" 2>/dev/null | head -3 | sed 's/^/     | /'
fi
STEP=$((STEP + 1))
if grep -q '"phase":"ui-settle","transport":"deputy"' "$OUT/weekly-raw.trace.jsonl" 2>/dev/null \
   && grep -q '"phase":"ui-observer","event":"armed","transport":"deputy"' "$OUT/weekly-raw.trace.jsonl" 2>/dev/null; then
  pass "[$STEP] DEPOBS3: the raw transport's settles are served by the DEPUTY-hosted observer"
  grep -o '"phase":"ui-settle"[^}]*' "$OUT/weekly-raw.trace.jsonl" | head -2 | sed 's/^/     | /'
else
  fail "[$STEP] the raw transport shows no deputy-hosted settle/observer"
  grep -o '"phase":"ui-\(settle\|observer\)"[^}]*' "$OUT/weekly-raw.trace.jsonl" 2>/dev/null | head -3 | sed 's/^/     | /'
fi

########################################################################
echo ""
echo "===== CELL 5 — the FENCES: refused before anything is driven ====="
########################################################################
refuses "fence-monthlast" "cannot start off its anchor" \
  --frequency monthly --interval 1 --on-day last
refuses "fence-monthord" "cannot start off its anchor" \
  --frequency monthly --interval 1 --on-weekday tuesday --on-ordinal 2
refuses "fence-monthday" "cannot start off its anchor" \
  --frequency monthly --interval 1 --on-day 20
# THE DEFAULTS1 CLAMP (oddities §32): an after-completion series caps its
# deadline offset at one day short of its period and enforces the cap by silent
# substitution, so a request that exceeds it is refused rather than committed as
# something else.
refuses "fence-clamp" "Things caps the offset at 6" \
  --frequency weekly --interval 1 --after-completion --deadline --start-days-earlier 9

########################################################################
echo ""
echo "===== CELL 6 — the QUADRANTS ====="
echo "  6a: {rawax} x {observer} x {prefill}, crossed — eight shapes, one blob"
########################################################################
QUAD_BLOBS=""
for RAWAX in 1 0; do
  for OBS in 1 0; do
    for PF in 1 0; do
      NAME="q-r$RAWAX-o$OBS-p$PF"
      TITLE="$RCTAG-Q-r$RAWAX-o$OBS-p$PF"
      QU=$(seed "$TITLE" "$START")
      echo "  -- quadrant rawax=$RAWAX observer=$OBS prefill=$PF"
      clear_banners
      THINGS_API_REPEAT_RAWAX="$RAWAX" THINGS_API_AX_OBSERVER="$OBS" THINGS_API_PREFILL="$PF" \
        drive "$NAME" "$QU" "$TITLE" --frequency weekly --interval 1 --weekdays thursday --when "$START"
      if [ -n "$LAST_BLOB" ]; then
        QUAD_BLOBS="$QUAD_BLOBS$NAME=$LAST_BLOB"$'\n'
      fi
      # PROVE THE QUADRANT FROM THE DRIVE'S OWN TRACE, never from the variable
      # the cell set (DEFAULTS3): a switch is only one of the reasons machinery
      # can be absent.
      STEP=$((STEP + 1))
      PROOF=$(python3 -c "
import json, sys
raw = obs = pf = False
for line in open(sys.argv[1], errors='ignore'):
    try: r = json.loads(line)
    except Exception: continue
    ph, ev = r.get('phase'), r.get('event')
    if ph == 'ui-rawax' and ev in ('op', 'hop'):
        raw = True
        if r.get('op') == 'verify-prefill': pf = True
    elif ph == 'ui-observer' and ev == 'armed': obs = True
    elif ph == 'ui-prefill' and ev == 'verify': pf = True
print('%d%d%d' % (raw, obs, pf))
" "$OUT/$NAME.trace.jsonl" 2>/dev/null || echo "???")
      if [ "$PROOF" = "$RAWAX$OBS$PF" ]; then
        pass "[$STEP] $NAME — the trace shows exactly this quadrant (rawax/observer/prefill = $PROOF)"
      else
        fail "[$STEP] $NAME — asked for $RAWAX$OBS$PF, the trace shows $PROOF"
      fi
    done
  done
done
STEP=$((STEP + 1))
UNIQ=$(printf '%s' "$QUAD_BLOBS" | sed 's/^[^=]*=//' | sort -u | grep -c . || true)
COUNT=$(printf '%s' "$QUAD_BLOBS" | grep -c . || true)
if [ "$COUNT" = "8" ] && [ "$UNIQ" = "1" ]; then
  pass "[$STEP] all 8 quadrants landed and agree on ONE blob"
else
  fail "[$STEP] quadrants: $COUNT/8 landed, $UNIQ distinct blob(s)"
  printf '%s' "$QUAD_BLOBS" | sed 's/^/     /'
fi

echo ""
echo "  6b: DEFAULTS3's original four on add-repeating, default transport"
quad() {
  local name="$1" obs="$2" pf="$3" title="$4"
  echo "--- quadrant $name (observer=$obs prefill=$pf) ---"
  clear_banners
  local before after t0 t1 out code ems
  before=$(db "SELECT count(*) FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL")
  STEP=$((STEP + 1))
  beep mark "[$STEP] quad $name"
  t0=$(now_ms)
  out=$(env THINGS_API_TRACE=1 ${obs:+THINGS_API_AX_OBSERVER=$obs} ${pf:+THINGS_API_PREFILL=$pf} \
    "$NODE" "$APP" todo add-repeating "$title" --when 2026-07-10 --frequency weekly --interval 1 \
    --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
  code=$?
  t1=$(now_ms)
  printf '%s\n' "$out" >"$OUT/06b-quad-$name.json"
  after=$(db "SELECT count(*) FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL")
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
echo "===== CELL 7 — the CANCEL rung: a refusing drive commits NOTHING ====="
########################################################################
# An interval of 0 is refused by the operation's own validation, before any
# drive: nothing is pressed, nothing is minted. It is the cheapest proof that a
# refusing path leaves the database alone, on both transports — and the drive
# that FOLLOWS it proves the dialog was not left standing.
for RAWAX in 1 0; do
  TITLE="$RCTAG-NOCOMMIT-$RAWAX"
  RU=$(seed "$TITLE" "$START")
  STEP=$((STEP + 1))
  OUT_TXT=$(THINGS_API_REPEAT_RAWAX="$RAWAX" things todo make-repeating "$RU" \
    --frequency weekly --interval 0 \
    --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
  printf '%s\n' "$OUT_TXT" >"$OUT/07-nocommit-$RAWAX.json"
  LANDED=$(db "SELECT uuid FROM TMTask WHERE title='$TITLE' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1")
  STILL=$(db "SELECT uuid FROM TMTask WHERE uuid='$RU' AND trashed=0")
  case "$OUT_TXT" in
    *'"ok":false'*)
      if [ -z "$LANDED" ] && [ -n "$STILL" ]; then
        pass "[$STEP] rawax=$RAWAX — refused, no rule minted, the row untouched"
      else
        fail "[$STEP] rawax=$RAWAX — refused but the database moved (landed='$LANDED' still='$STILL')"
      fi ;;
    *)
      fail "[$STEP] rawax=$RAWAX — an interval of 0 was not refused"
      echo "     output: $(head -c 300 <<<"$OUT_TXT")" ;;
  esac
done
# THE RUNG ITSELF: the next drive must open its own dialog. A sheet left standing
# by the refusals above would refuse this one with "a dialog is already open".
CANCEL_TITLE="$RCTAG-AFTER-CANCEL"
CANCEL_U=$(seed "$CANCEL_TITLE" "$START")
clear_banners
drive "07-after-cancel" "$CANCEL_U" "$CANCEL_TITLE" --frequency weekly --interval 1
STEP=$((STEP + 1))
if [ "$LAST_CODE" -eq 0 ] && [ -n "$LAST_BLOB" ]; then
  pass "[$STEP] a drive after two refusals opens its own dialog — nothing was left standing"
else
  fail "[$STEP] the drive after the refusals could not run (exit $LAST_CODE) — a sheet was left open"
fi

########################################################################
echo ""
echo "===== CELL 8 — DLSEED1: the deadlined source promotes ====="
########################################################################
DU=$(seed "$RCTAG-DL" "$START" "$DEADLINE")
clear_banners
drive "08a-dl-inherited" "$DU" "$RCTAG-DL" --frequency weekly --interval 1
STEP=$((STEP + 1))
case "$LAST_RULE" in
  *"ts=-3 "*deadlined=yes) pass "[$STEP] the seed's own deadline came with it (ts=-3, deadlined) — the GUI's own default" ;;
  *) fail "[$STEP] the inherited deadline did not land: $LAST_RULE" ;;
esac
STEP=$((STEP + 1))
if grep -q "came with it" "$OUT/08a-dl-inherited.json"; then
  pass "[$STEP] the result DISCLOSES the inherited deadline"
else
  fail "[$STEP] no inherited-deadline disclosure on the result"
fi

DU=$(seed "$RCTAG-DLO" "$START" "$DEADLINE")
clear_banners
drive "08b-dl-override" "$DU" "$RCTAG-DLO" --frequency weekly --interval 1 --deadline --start-days-earlier 7
STEP=$((STEP + 1))
case "$LAST_RULE" in
  *"ts=-7 "*deadlined=yes) pass "[$STEP] the CALLER's geometry wins (ts=-7)" ;;
  *) fail "[$STEP] the override did not land: $LAST_RULE" ;;
esac

DU=$(seed "$RCTAG-DLZ" "$START" "$DEADLINE")
clear_banners
drive "08c-dl-zero" "$DU" "$RCTAG-DLZ" --frequency weekly --interval 1 --deadline --start-days-earlier 0
STEP=$((STEP + 1))
case "$LAST_RULE" in
  *"ts=0 "*deadlined=yes) pass "[$STEP] a NAMED zero offset is typed, not skipped (ts=0, deadlined)" ;;
  *) fail "[$STEP] the named zero offset did not land: $LAST_RULE" ;;
esac

DU=$(seed "$RCTAG-DLC" "$START")
clear_banners
drive "08d-dl-control" "$DU" "$RCTAG-DLC" --frequency weekly --interval 1
STEP=$((STEP + 1))
case "$LAST_RULE" in
  *deadlined=no) pass "[$STEP] the deadline-free control is unchanged (not deadlined)" ;;
  *) fail "[$STEP] the control series came out deadlined: $LAST_RULE" ;;
esac

########################################################################
echo ""
echo "===== CELL 9 — the hop count, from the drive's own trace ====="
########################################################################
# RAWAX1 §5b.1's number for the shape the maintainer actually runs: weekly, with
# a named `--when`, on a freshly minted seed. Read out of the trace rather than
# asserted from the model.
HC_TITLE="$RCTAG-HOPS"
HC_U=$(seed "$HC_TITLE" "$START")
clear_banners
drive "09-hopcount" "$HC_U" "$HC_TITLE" --frequency weekly --interval 1 --when "$START"
STEP=$((STEP + 1))
HC=$(python3 -c "
import json, sys
hops = rawhops = ops = calls = elems = 0
for line in open(sys.argv[1], errors='ignore'):
    try: r = json.loads(line)
    except Exception: continue
    ph, ev = r.get('phase'), r.get('event')
    if ph == 'ui-dispatch' and ev == 'end': hops += 1
    elif ph == 'ui-rawax' and ev == 'hop':
        rawhops += 1
        calls += r.get('axCalls') or 0
        elems += r.get('axElems') or 0
    elif ph == 'ui-rawax' and ev == 'op': ops += 1
print('%d %d %d %d %d' % (hops, rawhops, ops, calls, elems))
" "$OUT/09-hopcount.trace.jsonl" 2>/dev/null || echo "0 0 0 0 0")
set -- $HC
HC_DISPATCH="$1"; HC_RAW="$2"; HC_OPS="$3"; HC_CALLS="$4"; HC_ELEMS="$5"
echo "     osascript hops=$HC_DISPATCH  merged raw-AX hops=$HC_RAW  ops=$HC_OPS  axCalls=$HC_CALLS  elements=$HC_ELEMS"
if [ "$HC_RAW" = "3" ]; then
  pass "[$STEP] make-repeating (weekly + --when + seed) ran in 3 merged raw-AX hops, as modelled"
else
  fail "[$STEP] MEASUREMENT: $HC_RAW merged raw-AX hops on the weekly+seed shape (RAWAX1 §5b.1 models 3)"
fi
echo "     per-op timings:"
python3 -c "
import json, sys
for line in open(sys.argv[1], errors='ignore'):
    try: r = json.loads(line)
    except Exception: continue
    if r.get('phase') == 'ui-rawax' and r.get('event') == 'op':
        print('       %-24s %6s ms  %s' % (r.get('op'), r.get('durationMs'), r.get('status') or ''))
" "$OUT/09-hopcount.trace.jsonl" 2>/dev/null | head -30

########################################################################
echo ""
echo "===== CELL 10 — area reorder --first / --last, and the BATCH1 mutation lock ====="
########################################################################
run_cell 0 "10a-area-add-1" area add "$RCTAG-AREA-A"
run_cell 0 "10b-area-add-2" area add "$RCTAG-AREA-B"
run_cell 0 "10c-area-add-3" area add "$RCTAG-AREA-C"
echo "     area order at seed: $(area_order)"

reorder_cell() {
  local name="$1" target="$2" where="$3" expect_pos="$4"
  clear_banners
  STEP=$((STEP + 1))
  beep mark "[$STEP] $name"
  local t0 t1 out code before after
  before=$(area_order)
  t0=$(now_ms)
  out=$(env THINGS_API_TRACE=1 "$NODE" "$APP" area reorder "$target" "$where" \
    --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
  code=$?
  t1=$(now_ms)
  printf '%s\n' "$out" >"$OUT/$name.json"
  after=$(area_order)
  echo "     order: $before  ->  $after   exit=$code wall=$((t1 - t0))ms"
  local landed
  if [ "$expect_pos" = "first" ]; then
    [ "${after%%|*}" = "$target" ] && landed=1 || landed=0
  else
    [ "${after##*|}" = "$target" ] && landed=1 || landed=0
  fi
  if [ "$code" -eq 0 ] && [ "$landed" = "1" ]; then
    pass "[$STEP] $name — the drag landed $target $expect_pos"
  else
    fail "[$STEP] $name — exit $code, order '$before' -> '$after'"
    echo "     output: $(head -c 600 <<<"$out")"
  fi
  local tr
  tr=$(newest_trace)
  if [ -n "$tr" ]; then
    echo "     sidebar trace: $(grep -o '"phase":"sidebar-drop-target"[^}]*' "$tr" | head -1)"
  fi
}
reorder_cell "10d-reorder-first" "$RCTAG-AREA-C" "--first" "first"
reorder_cell "10e-reorder-last"  "$RCTAG-AREA-C" "--last"  "last"

echo ""
echo "--- 10f: CONTENTION — a second write launched mid-drive must WAIT ---"
# BATCH1: the mutation lock is now held for a COMPOSITE's whole duration, so a
# second `things` write cannot land in a gap. The proof is three readings: the
# lock names the holder while the drive runs, the second write's wall covers the
# rest of the drive, and it FINISHES AFTER the drive does.
clear_banners
CT_BEFORE=$(area_order)
rm -f "$OUT/10f-drive.code" "$OUT/10f-drive.end"
CT_T0_DRIVE=$(now_ms)
(
  env THINGS_API_TRACE=1 "$NODE" "$APP" area reorder "$RCTAG-AREA-A" --last \
    --dangerously-drive-gui --verify-timeout 120000 --json >"$OUT/10f-drive.json" 2>/dev/null
  echo $? >"$OUT/10f-drive.code"
  now_ms >"$OUT/10f-drive.end"
) &
CT_PID=$!
# THE WINDOW IS THE WHOLE CELL, AND IT IS SHORT. A sidebar drag lands in ~2.7 s
# in this guest, so a probe three seconds in reads a lock that has already been
# released and proves nothing — which is exactly what the first pass of this
# cell did. The probe and the contending write both go in as early as the CLI's
# own start-up allows, and every judgement below is made against the drive's
# recorded END so a missed window reports itself as a missed window rather than
# as a product defect.
sleep 1
# THE PROBE RUNS CONCURRENTLY WITH THE CONTENDING WRITE, NOT AHEAD OF IT.
# `rescue status` reads the lock in its first milliseconds and then censuses the
# screen, which costs ~1.5 s — long enough, run in front of the write, to hand it
# a composite with 70 ms left to run. So it goes in the background and the write
# follows immediately; it holds no lock of its own, being read-only throughout.
CT_PROBE=$(now_ms)
(things rescue status --json >"$OUT/10f-rescue-status.json" 2>/dev/null) &
CT_PROBE_PID=$!
CT_T0=$(now_ms)
things todo add "$RCTAG-CONTEND" --when 2026-07-10 --json >"$OUT/10f-second-write.json" 2>/dev/null
CT_SECOND_CODE=$?
CT_T1=$(now_ms)
wait "$CT_PROBE_PID"
wait "$CT_PID"
CT_HELD=$(jqp data lock held <"$OUT/10f-rescue-status.json" 2>/dev/null)
CT_OP=$(jqp data lock op <"$OUT/10f-rescue-status.json" 2>/dev/null)
CT_PIDH=$(jqp data lock pid <"$OUT/10f-rescue-status.json" 2>/dev/null)
echo "     rescue status started at +$((CT_PROBE - CT_T0_DRIVE))ms: held=$CT_HELD op=$CT_OP pid=$CT_PIDH"
CT_DRIVE_CODE=$(cat "$OUT/10f-drive.code" 2>/dev/null || echo "?")
CT_DRIVE_END=$(cat "$OUT/10f-drive.end" 2>/dev/null || echo 0)
CT_WAIT=$((CT_T1 - CT_T0))
CT_AFTER=$(area_order)
CT_DRIVE_MS=$((CT_DRIVE_END - CT_T0_DRIVE))
echo "     drive: exit=$CT_DRIVE_CODE, ran ${CT_DRIVE_MS}ms (ended ${CT_DRIVE_END})"
echo "     probe at +$((CT_PROBE - CT_T0_DRIVE))ms ; second write started +$((CT_T0 - CT_T0_DRIVE))ms, waited ${CT_WAIT}ms, exit=$CT_SECOND_CODE (ended ${CT_T1})"
echo "     order: $CT_BEFORE  ->  $CT_AFTER"
STEP=$((STEP + 1))
if [ "$CT_DRIVE_CODE" = "0" ] && [ "$CT_SECOND_CODE" = "0" ]; then
  pass "[$STEP] both commands succeeded — the second one was serialized, not refused"
else
  fail "[$STEP] drive exit=$CT_DRIVE_CODE, second write exit=$CT_SECOND_CODE"
  echo "     second: $(head -c 400 <"$OUT/10f-second-write.json")"
fi
# THE LOCK PROBE IS ONLY EVIDENCE IF IT LANDED INSIDE THE DRIVE. Judged after the
# fact against the drive's recorded end, so a missed window says so.
STEP=$((STEP + 1))
if [ "$CT_PROBE" -ge "$CT_DRIVE_END" ]; then
  fail "[$STEP] the lock probe landed $((CT_PROBE - CT_DRIVE_END))ms AFTER the drive ended — the contention window was missed, not disproved"
elif [ "$CT_HELD" = "true" ]; then
  pass "[$STEP] the mutation lock is HELD mid-drive and names the holder: $CT_OP (pid $CT_PIDH)"
else
  fail "[$STEP] rescue status reports no lock holder $((CT_PROBE - CT_T0_DRIVE))ms into a composite that ran ${CT_DRIVE_MS}ms"
fi
STEP=$((STEP + 1))
if [ "$CT_T1" -ge "$CT_DRIVE_END" ]; then
  pass "[$STEP] the second write finished AFTER the drive released the lock (Δ $((CT_T1 - CT_DRIVE_END))ms) — no interleave"
else
  fail "[$STEP] the second write finished $((CT_DRIVE_END - CT_T1))ms BEFORE the drive did — it interleaved"
fi
STEP=$((STEP + 1))
if [ "$CT_T0" -ge "$CT_DRIVE_END" ]; then
  fail "[$STEP] the second write started $((CT_T0 - CT_DRIVE_END))ms AFTER the drive ended — the contention window was missed, not disproved"
elif [ "$CT_WAIT" -ge 500 ]; then
  pass "[$STEP] it WAITED ${CT_WAIT}ms for the lock rather than proceeding (the drive had $((CT_DRIVE_END - CT_T0))ms left to run)"
else
  fail "[$STEP] the second write returned in ${CT_WAIT}ms with $((CT_DRIVE_END - CT_T0))ms of the composite still to run — it did not wait"
fi
STEP=$((STEP + 1))
CT_LANDED=$(db "SELECT uuid FROM TMTask WHERE title='$RCTAG-CONTEND' AND trashed=0 LIMIT 1")
if [ -n "$CT_LANDED" ] && [ "${CT_AFTER##*|}" = "$RCTAG-AREA-A" ]; then
  pass "[$STEP] both changes landed: the drag put $RCTAG-AREA-A last AND the waiting to-do exists"
else
  fail "[$STEP] one of the two changes is missing (todo='$CT_LANDED', order='$CT_AFTER')"
fi
STEP=$((STEP + 1))
CT_AFTER_LOCK=$(things rescue status --json 2>/dev/null | jqp data lock held)
[ "$CT_AFTER_LOCK" = "false" ] && pass "[$STEP] the lock is released afterwards" || fail "[$STEP] the lock is still held ($CT_AFTER_LOCK)"

########################################################################
echo ""
echo "===== CELL 11 — one op of each vector class (the broker sits under all) ====="
########################################################################
run_cell 0 "11a-url-scheme-add" todo add "$RCTAG-URL" --when 2026-07-10 --reminder 09:00
V_URL=$(db "SELECT uuid FROM TMTask WHERE title='$RCTAG-URL' AND trashed=0 LIMIT 1")
run_cell 0 "11b-shortcuts-clear-reminder" todo clear-reminder "$V_URL"
V_REM=$(db "SELECT coalesce(reminderTime,-1) FROM TMTask WHERE uuid='$V_URL'")
STEP=$((STEP + 1))
[ "$V_REM" = "-1" ] && pass "[$STEP] shortcuts vector cleared the reminder" || fail "[$STEP] reminder still $V_REM"
run_cell 0 "11c-applescript-tag-add" tag add "$RCTAG-tag"
run_cell 0 "11d-applescript-delete" todo delete "$V_URL"

########################################################################
echo ""
echo "===== CELL 12 — clock -> 2026-07-08: the occurrence ARRIVES provisional ====="
########################################################################
kill_things
sudo date 070812002026 >/dev/null
echo "     clock -> $(date)"
launch_things
sleep 8
OCC_P=$(db "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TMPL_P' AND trashed=0 LIMIT 1")
STEP=$((STEP + 1))
if [ -n "$OCC_P" ]; then
  pass "[$STEP] occurrence spawned: $OCC_P"
else
  fail "[$STEP] no occurrence spawned from $TMPL_P"
fi
OCC_START=$(db "SELECT start FROM TMTask WHERE uuid='$OCC_P'")
echo "     occurrence start=$OCC_START (2 = someday-marked; the provisional Today shape)"
STEP=$((STEP + 1))
[ "$OCC_START" = "2" ] && pass "[$STEP] the occurrence arrived PROVISIONAL (start=2)" || fail "[$STEP] occurrence start=$OCC_START, expected 2"
run_cell 0 "12-show-occurrence" todo show "$OCC_P"
grep -o '"provisional":[a-z]*' "$OUT/12-show-occurrence.json" | head -1 | sed 's/^/     | /'

echo ""
echo "--- the four #699 commands (PROVREM1 §5) ---"
echo "--- 12.1  --exception aimed at the OCCURRENCE (expect refusal, exit 4) ---"
run_cell 4 "12a-exception-on-occurrence" todo update "$OCC_P" --exception --when anytime
STEP=$((STEP + 1))
if grep -q 'an exception is what it already is' "$OUT/12a-exception-on-occurrence.json"; then
  pass "[$STEP] 12.1 copy: names the occurrence-is-already-the-exception case"
else
  fail "[$STEP] 12.1 copy does not match PROVREM1 §5.1"
fi
STEP=$((STEP + 1))
if grep -q 'with no --exception' "$OUT/12a-exception-on-occurrence.json"; then
  pass "[$STEP] 12.1 remediation names the runnable command"
else
  fail "[$STEP] 12.1 remediation missing the runnable command"
fi

echo "--- 12.2  --exception aimed at the TEMPLATE (expect refusal, exit 4) ---"
run_cell 4 "12b-exception-on-template" todo update "$TMPL_P" --exception --when anytime
STEP=$((STEP + 1))
if grep -q 'no occurrence left to create' "$OUT/12b-exception-on-template.json"; then
  pass "[$STEP] 12.2 copy: names the after-completion cursor state"
else
  fail "[$STEP] 12.2 copy does not match PROVREM1 §5.2"
fi
STEP=$((STEP + 1))
if grep -q "$OCC_P" "$OUT/12b-exception-on-template.json"; then
  pass "[$STEP] 12.2 remediation NAMES the open occurrence ($OCC_P)"
else
  fail "[$STEP] 12.2 remediation does not name the occurrence"
fi

echo "--- 12.3  --when today --clear-reminder on the occurrence (expect ok, start stays 2) ---"
REM_BEFORE=$(db "SELECT coalesce(reminderTime,-1) FROM TMTask WHERE uuid='$OCC_P'")
run_cell 0 "12c-today-clear-reminder" todo update "$OCC_P" --when today --clear-reminder
REM_AFTER=$(db "SELECT coalesce(reminderTime,-1) FROM TMTask WHERE uuid='$OCC_P'")
START_AFTER=$(db "SELECT start FROM TMTask WHERE uuid='$OCC_P'")
echo "     reminderTime $REM_BEFORE -> $REM_AFTER ; start=$START_AFTER"
STEP=$((STEP + 1))
[ "$REM_AFTER" = "-1" ] && pass "[$STEP] the reminder is cleared" || fail "[$STEP] reminderTime still $REM_AFTER"
STEP=$((STEP + 1))
[ "$START_AFTER" = "2" ] && pass "[$STEP] start STAYS 2 — no false verify-failed" || fail "[$STEP] start moved to $START_AFTER (expected 2)"

echo "--- 12.4  --when anytime --clear-reminder in ONE call (expect ok) ---"
run_cell 0 "12d-anytime-clear-reminder" todo update "$OCC_P" --when anytime --clear-reminder
START_AT=$(db "SELECT start FROM TMTask WHERE uuid='$OCC_P'")
SD_AT=$(db "SELECT coalesce(startDate,-1) FROM TMTask WHERE uuid='$OCC_P'")
REM_AT=$(db "SELECT coalesce(reminderTime,-1) FROM TMTask WHERE uuid='$OCC_P'")
echo "     start=$START_AT startDate=$SD_AT reminderTime=$REM_AT"
STEP=$((STEP + 1))
[ "$START_AT" = "1" ] && pass "[$STEP] the occurrence moved to Anytime (start=1)" || fail "[$STEP] start=$START_AT, expected 1"
TMPL_RULE=$(db "SELECT rt1_recurrenceRule IS NOT NULL FROM TMTask WHERE uuid='$TMPL_P'")
STEP=$((STEP + 1))
[ "$TMPL_RULE" = "1" ] && pass "[$STEP] the template's rule is intact" || fail "[$STEP] the template lost its rule"

########################################################################
echo ""
echo "===== CELL 13 — the REOPEN rung: a closed window, both operation classes ====="
########################################################################
GUI_UID=$(gui /usr/bin/id -u 2>/dev/null | tr -dc 0-9)
STEP=$((STEP + 1))
[ "$GUI_UID" = "$UIDN" ] && pass "[$STEP] the Aqua-session wrapper re-enters as uid $GUI_UID" \
  || fail "[$STEP] launchctl asuser did not re-enter the session (got '$GUI_UID')"

echo ""
echo "--- 13a: the SIDEBAR class (LOCKSCR2 cell e) ---"
launch_things
close_things_window
echo "     standard windows after the close: $(std_windows)"
E_BEFORE=$(area_order)
STEP=$((STEP + 1))
E_T0=$(now_ms)
E_OUT=$(gui env THINGS_API_TRACE=1 "$NODE" "$APP" area reorder "$RCTAG-AREA-B" --first \
  --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
E_CODE=$?
E_T1=$(now_ms)
printf '%s\n' "$E_OUT" >"$OUT/13a-reopen-sidebar.json"
E_AFTER=$(area_order)
E_NOTES=$(jqp data notes <<<"$E_OUT")
echo "     exit=$E_CODE wall=$((E_T1 - E_T0))ms ; order $E_BEFORE -> $E_AFTER"
echo "     notes: $(head -c 400 <<<"$E_NOTES")"
echo "     standard windows after the drive: $(std_windows)"
if [ "$E_CODE" -eq 0 ] && [ "${E_AFTER%%|*}" = "$RCTAG-AREA-B" ]; then
  pass "[$STEP] the reorder LANDED through a closed window"
else
  fail "[$STEP] exit $E_CODE, order '$E_BEFORE' -> '$E_AFTER'"
fi
STEP=$((STEP + 1))
case "$E_NOTES" in
  *"reopened"*) pass "[$STEP] the result says a window was reopened" ;;
  *) fail "[$STEP] no reopen note on the result" ;;
esac
STEP=$((STEP + 1))
case "$E_NOTES" in
  *"left open"*) pass "[$STEP] the result says it was left open" ;;
  *) fail "[$STEP] the result does not say the window was left open" ;;
esac
STEP=$((STEP + 1))
case "$E_OUT" in
  *"Dock icon"*) fail "[$STEP] the #732 Dock-icon sentence is still being emitted" ;;
  *) pass "[$STEP] no Dock-icon instruction anywhere" ;;
esac

echo ""
echo "--- 13b: the DIALOG class — make-repeating through a closed window (new this batch) ---"
RE_TITLE="$RCTAG-REOPEN-MR"
RE_U=$(seed "$RE_TITLE" "$START")
sleep 6   # LOCKSCR2 §4.1: a drag leaves a sheet-shaped reading for a few seconds
close_things_window
echo "     standard windows after the close: $(std_windows)"
STEP=$((STEP + 1))
R2_T0=$(now_ms)
R2_OUT=$(gui env THINGS_API_TRACE=1 "$NODE" "$APP" todo make-repeating "$RE_U" \
  --frequency weekly --interval 1 --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
R2_CODE=$?
R2_T1=$(now_ms)
printf '%s\n' "$R2_OUT" >"$OUT/13b-reopen-dialog.json"
R2_TMPL=$(db "SELECT uuid FROM TMTask WHERE title='$RE_TITLE' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1")
echo "     exit=$R2_CODE wall=$((R2_T1 - R2_T0))ms template='$R2_TMPL'"
echo "     notes: $(jqp data notes <<<"$R2_OUT" | head -c 400)"
echo "     standard windows after the drive: $(std_windows)"
if [ "$R2_CODE" -eq 0 ] && [ -n "$R2_TMPL" ]; then
  pass "[$STEP] make-repeating LANDED through a closed window (the promote's pre-seed rung)"
else
  fail "[$STEP] exit $R2_CODE, template='$R2_TMPL'"
  echo "     output: $(head -c 600 <<<"$R2_OUT")"
fi
STEP=$((STEP + 1))
case "$R2_OUT" in
  *"Dock icon"*) fail "[$STEP] the #732 Dock-icon sentence is still being emitted by the dialog class" ;;
  *) pass "[$STEP] no Dock-icon instruction from the dialog class" ;;
esac

########################################################################
echo ""
echo "===== CELL 14 — SCREEN SAVER, no password required: the nudge ====="
########################################################################
launch_things
sudo sysadminctl -screenLock off -password admin >/dev/null 2>&1
echo "     screenLock: $(sudo sysadminctl -screenLock status 2>&1 | tr '\n' ' ')"
open -a ScreenSaverEngine >/dev/null 2>&1
sleep 6
echo "     ScreenSaverEngine: $(saver_state)"
echo "     session keys, saver up: $(session_keys)"
C_STATE=$(session_state)
STEP=$((STEP + 1))
[ "$C_STATE" = "screensaver" ] && pass "[$STEP] the saver reads SCREENSAVER, not LOCKED" || fail "[$STEP] session read '$C_STATE'"
open -a ScreenSaverEngine >/dev/null 2>&1
sleep 5
C_BEFORE=$(area_order)
STEP=$((STEP + 1))
C_T0=$(now_ms)
C_OUT=$(gui env THINGS_API_TRACE=1 "$NODE" "$APP" area reorder "$RCTAG-AREA-C" --first \
  --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
C_CODE=$?
C_T1=$(now_ms)
printf '%s\n' "$C_OUT" >"$OUT/14-saver-nopw.json"
C_AFTER=$(area_order)
C_NOTES=$(jqp data notes <<<"$C_OUT")
echo "     exit=$C_CODE wall=$((C_T1 - C_T0))ms ; order $C_BEFORE -> $C_AFTER"
echo "     notes: $(head -c 400 <<<"$C_NOTES")"
echo "     ScreenSaverEngine after the drive: $(saver_state) ; session: $(session_state)"
if [ "$C_CODE" -eq 0 ] && [ "${C_AFTER%%|*}" = "$RCTAG-AREA-C" ]; then
  pass "[$STEP] the reorder LANDED through a screen saver"
else
  fail "[$STEP] exit $C_CODE, order '$C_BEFORE' -> '$C_AFTER'"
fi
STEP=$((STEP + 1))
case "$C_NOTES" in
  *"screen saver was up and was dismissed"*) pass "[$STEP] the result says the saver was dismissed" ;;
  *) fail "[$STEP] no saver-dismissed note on the result" ;;
esac
STEP=$((STEP + 1))
[ "$(saver_state)" = "gone" ] && pass "[$STEP] the saver is actually gone" || fail "[$STEP] the saver is still running"
STEP=$((STEP + 1))
[ "$(session_state)" = "unlocked" ] && pass "[$STEP] the session reads unlocked again" || fail "[$STEP] the session reads $(session_state)"

########################################################################
echo ""
echo "===== CELL 15 prep — close the window while the screen is still unlocked ====="
########################################################################
launch_things
close_things_window
echo "     standard windows: $(std_windows)"

########################################################################
echo ""
echo "===== CELL 15 — SCREEN SAVER, password REQUIRED: the nudge fails honestly ====="
########################################################################
sudo sysadminctl -screenLock immediate -password admin >/dev/null 2>&1
echo "     screenLock: $(sudo sysadminctl -screenLock status 2>&1 | tr '\n' ' ')"
open -a ScreenSaverEngine >/dev/null 2>&1
sleep 6
echo "     ScreenSaverEngine: $(saver_state)"
echo "     session keys, saver up (password required): $(session_keys)"
echo "     session state: $(session_state)"
D_BEFORE=$(area_order)
STEP=$((STEP + 1))
D_T0=$(now_ms)
D_OUT=$(gui env THINGS_API_TRACE=1 "$NODE" "$APP" area reorder "$RCTAG-AREA-B" --first \
  --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
D_CODE=$?
D_T1=$(now_ms)
printf '%s\n' "$D_OUT" >"$OUT/15-saver-pw.json"
D_AFTER=$(area_order)
D_MSG=$(jqp error message <<<"$D_OUT")
echo "     exit=$D_CODE wall=$((D_T1 - D_T0))ms ; error code: $(jqp error code <<<"$D_OUT")"
echo "     message: $(head -c 500 <<<"$D_MSG")"
echo "     ScreenSaverEngine after the drive: $(saver_state)"
[ "$D_CODE" -eq 4 ] && pass "[$STEP] refused, exit 4" || fail "[$STEP] exit $D_CODE (wanted 4)"
STEP=$((STEP + 1))
[ "$D_BEFORE" = "$D_AFTER" ] && pass "[$STEP] the sidebar is unchanged" || fail "[$STEP] order '$D_BEFORE' -> '$D_AFTER'"
STEP=$((STEP + 1))
case "$D_MSG" in
  *"did not clear when the Mac was nudged"*) pass "[$STEP] the refusal says the nudge was tried and failed" ;;
  *"the screen saver is up"*) pass "[$STEP] the un-nudged saver sentence fired (also honest)" ;;
  *"the screen is locked"*) pass "[$STEP] the hard-lock sentence fired (also honest)" ;;
  *) fail "[$STEP] the refusal names neither the saver nor the lock" ;;
esac
STEP=$((STEP + 1))
case "$D_MSG" in
  *"Dock icon"*) fail "[$STEP] the #732 Dock-icon sentence is still being emitted" ;;
  *) pass "[$STEP] no Dock-icon instruction anywhere" ;;
esac

########################################################################
echo ""
echo "===== CELL 16 — window CLOSED and the screen HARD-LOCKED: the session wins ====="
########################################################################
killall ScreenSaverEngine >/dev/null 2>&1
sleep 3
gui /usr/bin/python3 -c 'import ctypes; lf=ctypes.CDLL("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login"); print("SACLockScreenImmediate rc=", lf.SACLockScreenImmediate())' 2>&1 | sed 's/^/     /'
sleep 5
echo "     standard windows: $(std_windows)   session: $(session_state)"
F_BEFORE=$(area_order)
STEP=$((STEP + 1))
F_OUT=$(gui env THINGS_API_TRACE=1 "$NODE" "$APP" area reorder "$RCTAG-AREA-C" --last \
  --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
F_CODE=$?
printf '%s\n' "$F_OUT" >"$OUT/16-closed-and-locked.json"
F_AFTER=$(area_order)
F_MSG=$(jqp error message <<<"$F_OUT")
echo "     exit=$F_CODE message: $(head -c 400 <<<"$F_MSG")"
[ "$F_CODE" -eq 4 ] && pass "[$STEP] refused, exit 4" || fail "[$STEP] exit $F_CODE (wanted 4)"
STEP=$((STEP + 1))
[ "$F_BEFORE" = "$F_AFTER" ] && pass "[$STEP] the sidebar is unchanged" || fail "[$STEP] order changed"
STEP=$((STEP + 1))
case "$F_MSG" in
  *"no open window"*) fail "[$STEP] the WINDOW sentence won over the session evidence" ;;
  *) pass "[$STEP] the session refusal outranks the window inventory" ;;
esac
STEP=$((STEP + 1))
case "$F_MSG" in
  *"the screen is locked"*) pass "[$STEP] and it is the LOCK sentence, on a closed-window Mac" ;;
  *) fail "[$STEP] the lock sentence did not fire: $(head -c 200 <<<"$F_MSG")" ;;
esac

########################################################################
echo ""
echo "===== CELL 17 — LOCKED: the refusals, both operation classes ====="
########################################################################
B_STATE=$(session_state)
echo "     session state: $B_STATE"
echo "     session keys, locked: $(session_keys)"
STEP=$((STEP + 1))
[ "$B_STATE" = "locked" ] && pass "[$STEP] the session reads LOCKED" || fail "[$STEP] session read '$B_STATE'"
B_BEFORE=$(area_order)
STEP=$((STEP + 1))
B_T0=$(now_ms)
B_OUT=$(gui env THINGS_API_TRACE=1 "$NODE" "$APP" area reorder "$RCTAG-AREA-A" --first \
  --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
B_CODE=$?
B_T1=$(now_ms)
printf '%s\n' "$B_OUT" >"$OUT/17a-locked-reorder.json"
B_AFTER=$(area_order)
B_MSG=$(jqp error message <<<"$B_OUT")
B_ERRCODE=$(jqp error code <<<"$B_OUT")
B_WALL=$((B_T1 - B_T0))
echo "     exit=$B_CODE wall=${B_WALL}ms error code: $B_ERRCODE"
echo "     message: $(head -c 500 <<<"$B_MSG")"
[ "$B_CODE" -eq 4 ] && pass "[$STEP] area reorder — exit 4 (blocked)" || fail "[$STEP] exit $B_CODE"
STEP=$((STEP + 1))
[ "$B_ERRCODE" = "blocked:H-UI-SESSION-UNREACHABLE" ] && pass "[$STEP] blocked:H-UI-SESSION-UNREACHABLE" \
  || fail "[$STEP] error code '$B_ERRCODE'"
STEP=$((STEP + 1))
case "$B_MSG" in
  *"the screen is locked"*) pass "[$STEP] the refusal names the lock" ;;
  *) fail "[$STEP] the refusal does not name the lock" ;;
esac
STEP=$((STEP + 1))
[ "$B_WALL" -le 5000 ] && pass "[$STEP] refused in ${B_WALL}ms — the lock question costs no AX round-trip" || fail "[$STEP] took ${B_WALL}ms"
STEP=$((STEP + 1))
[ "$B_BEFORE" = "$B_AFTER" ] && pass "[$STEP] the sidebar is unchanged" || fail "[$STEP] order changed"

echo ""
echo "--- 17b: make-repeating under the same lock (the composite's pre-seed gate) ---"
LK_TITLE="$RCTAG-LOCKED-MR"
LK_U=$(seed "$LK_TITLE" "$START")
sleep 6
STEP=$((STEP + 1))
M_T0=$(now_ms)
M_OUT=$(gui env THINGS_API_TRACE=1 "$NODE" "$APP" todo make-repeating "$LK_U" \
  --frequency weekly --interval 1 --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
M_CODE=$?
M_T1=$(now_ms)
printf '%s\n' "$M_OUT" >"$OUT/17b-locked-make-repeating.json"
MR_MSG=$(jqp error message <<<"$M_OUT")
echo "     exit=$M_CODE wall=$((M_T1 - M_T0))ms message: $(head -c 400 <<<"$MR_MSG")"
[ "$M_CODE" -eq 4 ] && pass "[$STEP] make-repeating — exit 4" || fail "[$STEP] exit $M_CODE"
STEP=$((STEP + 1))
case "$MR_MSG" in
  *"the screen is locked"*) pass "[$STEP] the same clause from the composite's pre-seed gate" ;;
  *) fail "[$STEP] the refusal does not name the lock: $(head -c 200 <<<"$MR_MSG")" ;;
esac
STEP=$((STEP + 1))
MR_TPL=$(db "SELECT count(*) FROM TMTask WHERE title='$LK_TITLE' AND rt1_recurrenceRule IS NOT NULL")
[ "$MR_TPL" = "0" ] && pass "[$STEP] no rule was written (zero mutation)" || fail "[$STEP] $MR_TPL template row(s)"

########################################################################
echo ""
echo "===== CELL 18 — the broker's own verdict ====="
########################################################################
DENIED=$(deputy_since | grep -c 'rejected-script' || true)
STEP=$((STEP + 1))
if [ "${DENIED:-0}" -eq 0 ]; then
  pass "[$STEP] the deputy refused no script this run"
else
  fail "[$STEP] the deputy refused $DENIED script(s):"
  deputy_since | grep 'rejected-script' | head -5 | sed 's/^/     | /'
fi
OBS_SESSIONS=$(deputy_since | grep -c 'observer' || true)
DEP_CALLS=$(deputy_since | grep -c 'osascript' || true)
echo "     deputy.log this run: ${DEP_CALLS:-0} osascript calls, ${OBS_SESSIONS:-0} observer lines"

echo ""
echo "===== the whole run's hop ledger ====="
python3 -c "
import glob, json, os
tdir = os.path.expanduser('~/.local/state/things-api/trace')
files = sorted(glob.glob(os.path.join(tdir, '*.jsonl')))
if not files:
    print('     (no trace files under %s)' % tdir); raise SystemExit
hops = rawhops = ops = calls = elems = 0
merged = {}
for path in files:
    for line in open(path, errors='ignore'):
        try: r = json.loads(line)
        except Exception: continue
        ph, ev = r.get('phase'), r.get('event')
        if ph == 'ui-dispatch' and ev == 'end': hops += 1
        elif ph == 'ui-rawax' and ev == 'hop':
            rawhops += 1
            calls += r.get('axCalls') or 0
            elems += r.get('axElems') or 0
        elif ph == 'ui-rawax' and ev == 'op':
            ops += 1
            k = r.get('op')
            merged[k] = merged.get(k, 0) + 1
print('     osascript hops (all drives): %d' % hops)
print('     merged raw-AX hops:         %d' % rawhops)
print('     ops executed:               %d' % ops)
print('     raw AX calls:               %d' % calls)
print('     elements realized:          %d' % elems)
if rawhops:
    print('     ops per merged hop:         %.1f' % (ops / rawhops))
    print('     calls per merged hop:       %.1f' % (calls / rawhops))
for k in sorted(merged):
    print('       %-24s %d' % (k, merged[k]))
" 2>/dev/null || echo "     (trace summary unavailable)"

echo ""
echo "===== alert beeps ====="
beep mark "stage5 end"
beep assert --name "stage5" --json "$HOME/things-lab/stage5-beeps.json" || fail "beep assertion"

echo ""
echo "############################################################"
echo "STAGE 5 RESULT: $STEP cells, $FAILURES failures"
echo "############################################################"
exit $((FAILURES > 0 ? 1 : 0))
