#!/bin/bash
# RAWAX1 cells — the raw-AX Repeat drive, certified with the FIELD'S OWN SYNTAX.
#
# Runs ON THE GUEST. On golden-v4h (routed, helpers 1.4.0, `helpers-enabled
# true`) these are the release gate's field-shaped arm; on golden-v4 with
# THINGS_API_UI_DIRECT=1 they are the direct arm. Same cells either way — the
# routing-arm law says WHICH IDENTITY EXECUTES A SCRIPT is a certification
# dimension, so the cells must be identical and only the host differs.
#
# WHAT IS BEING CERTIFIED. The raw-AX transport replaces every System Events
# round-trip in the Repeat drive and MERGES the dialog entry into two or three
# scripts. Three questions follow, and each has cells:
#
#  1. DOES IT LAND THE SAME RULE? The oracle is the committed blob, byte for
#     byte, against the same drive with `THINGS_API_REPEAT_RAWAX=0`. Not "a
#     correct rule" — the SAME one. A transport change that alters a landed rule
#     is not a transport change.
#  2. IS EVERY QUADRANT CERTIFIED? Optional machinery multiplies (DEFAULTS3): the
#     drive now has THREE switches — {rawax on/off} x {observer up/down} x
#     {prefill on/off} — so the matrix below crosses all three rather than
#     certifying each against the others' defaults, which is how #700 shipped.
#  3. DOES IT REFUSE THE SAME WAY? A faster driver that degrades a refusal has
#     traded the thing the refusals are for. The mismatch cell poisons an
#     intended value and requires the SAME sentence, naming the same control.
#
# NORMAL CLI SYNTAX ONLY: no osascript, no hand-built things:/// URL, no direct
# driver invocation. The one exception is the beep sentinel, which is the rig.
#
# Usage: rawax1-cells.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
FAILURES=0
STEP=0
TAG="RAWAX1"
START="2026-07-09"    # a Thursday; the guest clock is pinned to 2026-07-05
DEADLINE="2026-07-12"

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

# THE ORACLE: the recurrence blob as a HEX LITERAL. A decoded summary can agree
# while the blob differs; only the bytes settle "the same rule".
blob() { db "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'"; }

# The readable form, for a report a human has to act on.
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

fail() { echo "FAIL $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   $*"; }

# THE ADD IS ASYNCHRONOUS, SO THE READ-BACK RETRIES (the mkseed shape every other
# driver here uses). `todo add` goes through the URL scheme and returns before
# Things has committed the row, so a single SELECT can come back empty — or,
# worse, come back with a uuid that is not yet resolvable by the CLI, which then
# refuses the drive with "no to-do matching uuid" and reads exactly like a
# transport failure. Run 3 lost two cells to that.
seed() {
  local title="$1" when="$2" dl="${3:-}" i u
  if [ -n "$dl" ]; then
    things todo add "$title" --when "$when" --deadline "$dl" --json >/dev/null 2>&1
  else
    things todo add "$title" --when "$when" --json >/dev/null 2>&1
  fi
  for i in 1 2 3 4 5; do
    u=$(db "SELECT uuid FROM TMTask WHERE title='$title' AND trashed=0 AND rt1_recurrenceRule IS NULL ORDER BY creationDate DESC LIMIT 1")
    # Readable in the DB is not the same as resolvable by the CLI; ask the verb
    # that will actually be handed the uuid.
    if [ -n "$u" ] && things todo get "$u" --json >/dev/null 2>&1; then
      printf '%s' "$u"
      return 0
    fi
    sleep "$i"
  done
  printf '%s' "$u"
}

# drive <name> <title> -- <make-repeating args...>
#
# Runs one promote in the CURRENT quadrant (the caller exports the switches) and
# leaves the landed blob in $LAST_BLOB / the readable rule in $LAST_RULE.
LAST_BLOB=""
LAST_RULE=""
LAST_MS=0
LAST_CODE=0
LAST_TRACE=""

# THE DRIVE'S OWN TRACE FILE. `THINGS_API_TRACE=1` writes one JSONL per CLI
# invocation under the state dir, and a `tracePath` reaches the JSON result only
# on a failure — which is why run 3 and run 4 both printed "(no trace)" for
# perfectly good drives, and why the quadrant proof read an absent field. The
# drive is the last thing to run a CLI, so the newest file is its own.
TRACE_DIR="$HOME/.local/state/things-api/trace"
newest_trace() { ls -t "$TRACE_DIR"/*.jsonl 2>/dev/null | head -1; }
drive() {
  local name="$1" uuid="$2" title="$3"; shift 3
  local t0 t1 out code tmpl
  # THE UUID IS PASSED IN, NOT RE-LOOKED-UP (run 2 rig defect). A promote mints a
  # TEMPLATE and an INSTANCE carrying the seed's own title, so a title lookup
  # after one returns the template — and make-repeating on a template refuses
  # with "no to-do matching uuid", which reads exactly like a drive failure.
  if [ -z "$uuid" ]; then fail "[$STEP] $name — no seed uuid for $title"; return 1; fi
  STEP=$((STEP + 1))
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  out=$(things todo make-repeating "$uuid" "$@" --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
  code=$?
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  printf '%s\n' "$out" >"$OUT/$name.json"
  LAST_CODE=$code
  LAST_MS=$((t1 - t0))
  LAST_TRACE=$(newest_trace)
  [ -n "$LAST_TRACE" ] && cp "$LAST_TRACE" "$OUT/$name.trace.jsonl" 2>/dev/null
  tmpl=$(db "SELECT uuid FROM TMTask WHERE title='$title' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
  if [ "$code" -ne 0 ] || [ -z "$tmpl" ]; then
    LAST_BLOB=""; LAST_RULE=""
    fail "[$STEP] $name — exit $code, template='$tmpl' wall=${LAST_MS}ms"
    echo "     output: $(head -c 600 <<<"$out")"
    return 1
  fi
  LAST_BLOB=$(blob "$tmpl")
  LAST_RULE=$(rule "$tmpl")
  echo "     landed: $LAST_RULE   (wall=${LAST_MS}ms)"
  return 0
}

# ab <name> <freq-args...> — the SAME rule driven both ways, blobs compared.
#
# This is the campaign's central assertion and the reason the switch exists: a
# transport change that alters a landed rule is not a transport change.
ab() {
  local name="$1"; shift
  local rawTitle="$TAG-$name-RAW" oldTitle="$TAG-$name-OLD" rawU oldU
  rawU=$(seed "$rawTitle" "$START")
  oldU=$(seed "$oldTitle" "$START")

  THINGS_API_REPEAT_RAWAX=1 drive "$name-raw" "$rawU" "$rawTitle" "$@" || return 1
  local rawBlob="$LAST_BLOB" rawRule="$LAST_RULE" rawMs="$LAST_MS"
  THINGS_API_REPEAT_RAWAX=0 drive "$name-old" "$oldU" "$oldTitle" "$@" || return 1
  local oldBlob="$LAST_BLOB" oldMs="$LAST_MS"

  STEP=$((STEP + 1))
  if [ "$rawBlob" = "$oldBlob" ] && [ -n "$rawBlob" ]; then
    pass "[$STEP] $name — blobs BYTE-IDENTICAL across transports  (raw ${rawMs}ms / applescript ${oldMs}ms)"
  else
    fail "[$STEP] $name — the transports landed DIFFERENT rules"
    echo "     raw: $rawBlob"
    echo "     old: $oldBlob"
    echo "     raw rule: $rawRule"
  fi
}

echo "############################################################"
echo "# RAWAX1 — the raw-AX Repeat drive"
echo "# clock: $(date)"
echo "############################################################"

things config set ui-enabled true >/dev/null && pass "ui-enabled on" || fail "could not set ui-enabled"
export THINGS_API_TRACE=1

echo ""
echo "===== A/B: every dialog state lands the SAME rule on both transports ====="
ab "daily"     --frequency daily --interval 3
# KEPT AS IT IS, DELIBERATELY. This pair diverged on run 3 — the raw arm landed
# and the APPLESCRIPT arm refused at its own audit with `Next (first occurrence)
# … dialog shows "Mon, Jul 6, 2026"` — and the divergence is a finding about the
# SHIPPED path rather than about the port (see the campaign doc §5c.2): a `next`
# pre-fill confirmed by the verify hop can be invalidated by a weekday converge
# that runs after it, and DEFAULTS2's skip then leaves an occurrence the audit
# correctly rejects. The raw arm happens to re-select it because its own verify
# did not confirm the key. Left in so the pair keeps reporting it.
ab "weekly"    --frequency weekly --interval 1 --weekdays monday,thursday
ab "monthly"   --frequency monthly --interval 2
ab "yearly"    --frequency yearly --interval 1
ab "aftercomp" --frequency weekly --interval 3 --after-completion
ab "endsafter" --frequency daily --interval 1 --ends-after 4
ab "deadline"  --frequency weekly --interval 1 --deadline --start-days-earlier 2
ab "zerodl"    --frequency weekly --interval 1 --deadline --start-days-earlier 0
ab "reminder"  --frequency weekly --interval 1 --reminder 09:30
ab "nextdate"  --frequency weekly --interval 1 --when "$START"
# THE RESHAPING SHAPES (RAWAX1 §5c.2's fix, certified where it was found). Each
# of these names a rule whose FIRST OCCURRENCE the app recomputes away from the
# seed's own date — a second weekday, a day-of-month that is not the seed's, an
# ordinal weekday, a yearly month that is not the seed's. Before the fix, the
# `Next:` pre-fill was confirmed by a read taken before that step and the skip it
# licensed left the dialog holding the recomputed date, which the pre-commit
# audit refused. They are A/B pairs like every other, so the fix is asserted on
# BOTH transports rather than on the one that happened to survive.
ab "monthlast" --frequency monthly --interval 1 --on-day last
ab "monthord"  --frequency monthly --interval 1 --on-weekday tuesday --on-ordinal 2
ab "monthday"  --frequency monthly --interval 1 --on-day 20
ab "yearmonth" --frequency yearly --interval 1 --yearly-month 11 --on-day 3
ab "endson"    --frequency weekly --interval 1 --ends-on 2026-09-30

echo ""
echo "===== the SHIPPED path, as it stands on origin/main (RAWAX1 §5c.2) ====="
# IS THE DEFECT OURS, OR WAS IT ALREADY THERE? The A/B pair above compares two
# transports inside ONE build, which can never answer that — `THINGS_API_REPEAT_RAWAX=0`
# is this branch's rendering of the certified path, not the released one. So the
# orchestrator ships the BASELINE dist (origin/main) into the same guest, over the
# same fixtures, on the same boot, and the released CLI drives the same request.
#
# A refusal here is a SHIPPED defect and not a port regression; a pass here would
# mean the branch introduced it. Skipped, loudly, when no baseline was shipped.
if [ -n "${BASELINE_APP:-}" ]; then
  BASE_APP_DIR="${BASELINE_APP/#\$HOME/$HOME}"
  BASE_CLI="$BASE_APP_DIR/dist/cli/main.js"
  base_drive() {
    local name="$1" uuid="$2" title="$3"; shift 3
    local out code tmpl
    STEP=$((STEP + 1))
    out=$("$NODE" "$BASE_CLI" todo make-repeating "$uuid" "$@" \
      --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
    code=$?
    printf '%s\n' "$out" >"$OUT/$name.json"
    tmpl=$(db "SELECT uuid FROM TMTask WHERE title='$title' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
    BASE_CODE=$code
    BASE_OUT=$out
    BASE_TMPL=$tmpl
  }
  echo "     baseline CLI: $BASE_CLI ($("$NODE" "$BASE_CLI" --version 2>/dev/null))"

  # (1) THE GATE'S OWN WEEKLY SHAPE — `weekly --interval 1`, exactly what
  #     stage5-cells.sh 07b drives. It passes, which is why the release gate has
  #     never seen this.
  BU=$(seed "$TAG-BASE-GATE" "$START")
  base_drive "base-gate" "$BU" "$TAG-BASE-GATE" --frequency weekly --interval 1
  if [ "$BASE_CODE" -eq 0 ] && [ -n "$BASE_TMPL" ]; then
    pass "[$STEP] baseline: the release gate's weekly shape lands (this is the blind spot, not the bug)"
  else
    fail "[$STEP] baseline: the gate's own weekly shape did NOT land — exit $BASE_CODE"
    echo "     output: $(head -c 400 <<<"$BASE_OUT")"
  fi

  # (2) THE SAME REQUEST THE A/B PAIR REFUSED. Two weekdays, one of them the
  #     seed's own — the shape whose first occurrence the converge moves.
  BU=$(seed "$TAG-BASE-WEEKLY" "$START")
  base_drive "base-weekly" "$BU" "$TAG-BASE-WEEKLY" --frequency weekly --interval 1 --weekdays monday,thursday
  case "$BASE_OUT" in
    *"dialog shows"*)
      pass "[$STEP] baseline REPRODUCES the refusal — the defect is SHIPPED, not introduced here"
      echo "     baseline says: $(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print((d.get('error') or {}).get('message','')[:300])
" <<<"$BASE_OUT" 2>/dev/null)" ;;
    *)
      if [ "$BASE_CODE" -eq 0 ] && [ -n "$BASE_TMPL" ]; then
        fail "[$STEP] baseline LANDED the multi-weekday rule — then this branch introduced the refusal"
      else
        fail "[$STEP] baseline failed for some OTHER reason — exit $BASE_CODE"
      fi
      echo "     output: $(head -c 400 <<<"$BASE_OUT")" ;;
  esac

  # (3) AND THE SAME REQUEST WITH THE PRE-FILL SWITCHED OFF, on the baseline.
  #     `THINGS_API_PREFILL=0` tags nothing, so the occurrence setter runs and the
  #     rule lands — which localizes the defect to the confirmed skip rather than
  #     to the converge, the audit, or the shape.
  BU=$(seed "$TAG-BASE-NOPF" "$START")
  THINGS_API_PREFILL=0 base_drive "base-nopf" "$BU" "$TAG-BASE-NOPF" --frequency weekly --interval 1 --weekdays monday,thursday
  if [ "$BASE_CODE" -eq 0 ] && [ -n "$BASE_TMPL" ]; then
    pass "[$STEP] baseline with PREFILL=0 lands the same request — the confirmed skip is the mechanism"
  else
    fail "[$STEP] baseline with PREFILL=0 also refused — the mechanism is NOT the pre-fill skip"
    echo "     output: $(head -c 400 <<<"$BASE_OUT")"
  fi
else
  echo "     (no BASELINE_APP shipped — the shipped-path comparison is NOT certified in this run)"
fi

echo ""
echo "===== the QUADRANTS: {rawax} x {observer} x {prefill}, crossed ====="
# DEFAULTS3's law: optional machinery multiplies, so the shapes that ship broken
# are the PRODUCTS. Three switches is eight shapes; each lands the same blob or
# the matrix is not certified.
QUAD_BLOBS=""
for RAWAX in 1 0; do
  for OBS in 1 0; do
    for PF in 1 0; do
      NAME="q-r$RAWAX-o$OBS-p$PF"
      TITLE="$TAG-Q-r$RAWAX-o$OBS-p$PF"
      QU=$(seed "$TITLE" "$START")
      echo "  -- quadrant rawax=$RAWAX observer=$OBS prefill=$PF"
      THINGS_API_REPEAT_RAWAX="$RAWAX" THINGS_API_AX_OBSERVER="$OBS" THINGS_API_PREFILL="$PF" \
        drive "$NAME" "$QU" "$TITLE" --frequency weekly --interval 1 --weekdays thursday --when "$START"
      if [ -n "$LAST_BLOB" ]; then
        QUAD_BLOBS="$QUAD_BLOBS$NAME=$LAST_BLOB"$'\n'
      fi
      # PROVE THE QUADRANT FROM THE DRIVE'S OWN TRACE, never from the variable
      # the cell set (DEFAULTS3): a switch is only one of the reasons machinery
      # can be absent. Each switch has a phase that only appears when it is ON —
      # `ui-rawax` for the transport, an ARMED `ui-observer` for the sidecar, and
      # a `ui-prefill`/`verify-prefill` verdict for the pre-fill reads — so the
      # trace says which of the eight shapes actually ran.
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
echo "===== the REFUSAL keeps its sentence (the fold's debt) ====="
# RDLAT2 §10 declined the hop merge because folding costs per-step failure
# attribution, so a refusal has to survive it. This cell is NOT the off-rule
# occurrence refusal it started as, and the reason is a finding of its own.
#
# NO DRIVE-LEVEL REFUSAL IS REACHABLE THROUGH NORMAL CLI SYNTAX on this build.
# `select-next-occurrence` fails closed when the requested first occurrence is
# not one the rule produces — but `--when` sets the ANCHOR as well as the
# occurrence, on make-repeating (it dates the seed) and on reschedule-repeat (it
# moves the rule), so every date a caller can ask for is on-rule by construction.
# Run 2 asked for one through a promote and run 3 through a reschedule; both
# landed a correct rule and the cell reported the code at fault.
#
# So the refusal is certified where it IS reachable — the unit matrix, which
# hands the driver an envelope carrying a refused op and requires the sentence,
# the failing op's name and the completed trail to survive
# (test/engine/write-ui-rawax-drive.test.ts) — and what is asserted here is the
# thing the guest can actually prove: that a drive which refuses commits NOTHING.
# The audit's own mismatch path does that, and the A/B pairs above reach it.
for RAWAX in 1 0; do
  TITLE="$TAG-NOCOMMIT-$RAWAX"
  RU=$(seed "$TITLE" "$START")
  STEP=$((STEP + 1))
  # An interval of 0 is refused by the operation's own validation, before any
  # drive: nothing is pressed, nothing is minted. It is the cheapest proof that a
  # refusing path leaves the database alone, on both transports.
  OUT_TXT=$(THINGS_API_REPEAT_RAWAX="$RAWAX" things todo make-repeating "$RU" \
    --frequency weekly --interval 0 \
    --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
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

echo ""
echo "===== the deadlined source (DLSEED1, under the new transport) ====="
# BATCH1's ruling, re-asserted on the raw-AX path: a deadlined seed promotes to a
# deadlined series, and a NAMED zero offset is driven rather than skipped.
U=$(seed "$TAG-DL" "$START" "$DEADLINE")
THINGS_API_REPEAT_RAWAX=1 drive "dl-inherited" "$U" "$TAG-DL" --frequency weekly --interval 1
STEP=$((STEP + 1))
case "$LAST_RULE" in
  *"ts=-3 "*deadlined=yes) pass "[$STEP] the inherited deadline survives the port (ts=-3, deadlined)" ;;
  *) fail "[$STEP] the inherited deadline did not land: $LAST_RULE" ;;
esac
U=$(seed "$TAG-DLZ" "$START" "$DEADLINE")
THINGS_API_REPEAT_RAWAX=1 drive "dl-zero" "$U" "$TAG-DLZ" --frequency weekly --interval 1 --deadline --start-days-earlier 0
STEP=$((STEP + 1))
case "$LAST_RULE" in
  *"ts=0 "*deadlined=yes) pass "[$STEP] a NAMED zero offset is typed, not skipped (ts=0, deadlined)" ;;
  *) fail "[$STEP] the named zero offset did not land: $LAST_RULE" ;;
esac

echo ""
echo "===== the hop count, from the drive's own trace ====="
# The number the cost table is built on, READ OUT of the trace rather than
# asserted. `THINGS_API_TRACE=1` appends a step-level timeline to ONE JSONL file
# under the state dir, so the counts come from the drives that just ran — the
# `tracePath` in a JSON result is only present on a failure, which is why run 3
# printed "(no trace)" for two perfectly good drives.
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
            merged[r.get(\"op\")] = merged.get(r.get(\"op\"), 0) + 1
        elif ph == 'ui-rawax' and ev == 'compiled':
            pass
print('     osascript hops (all drives): %d' % hops)
print('     merged raw-AX hops:         %d' % rawhops)
print('     ops executed:               %d' % ops)
print('     raw AX calls:               %d' % calls)
print('     elements realized:          %d' % elems)
if rawhops:
    print('     ops per merged hop:         %.1f' % (ops / rawhops))
    print('     calls per merged hop:       %.1f' % (calls / rawhops))
for k in sorted(merged):
    print('       %-20s %d' % (k, merged[k]))
" 2>/dev/null || echo "     (trace summary unavailable)"

echo ""
echo "############################################################"
if [ "$FAILURES" -eq 0 ]; then
  echo "# RAWAX1: GREEN ($STEP cells)"
else
  echo "# RAWAX1: RED — $FAILURES failure(s) in $STEP cells"
fi
echo "############################################################"
exit "$FAILURES"
