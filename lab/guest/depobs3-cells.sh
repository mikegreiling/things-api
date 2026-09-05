#!/bin/bash
# DEPOBS3 cells — the node-side cross-hop settle, measured in a ROUTED guest.
#
# Run ON THE GUEST, on a golden-v4h clone (helpers 1.4.0, `helpers-enabled
# true`). NORMAL CLI syntax only: no osascript against Things, no hand-built
# things:/// URL, no direct driver invocation. (The osascript uses below are
# FIXTURE management — quit/relaunch and the AXEnhancedUserInterface poke — never
# an operation's path.)
#
# WHAT IS BEING MEASURED. On a deputy-routed host the drive now waits for two
# cross-hop announcements in NODE, against the deputy-hosted ledger, instead of
# leaving the next osascript to poll for them:
#
#   1. the cadence group's REBUILD after the frequency selection, which lets the
#      `probe-dialog-shape` hop be generated WITHOUT its polling rounds;
#   2. the pop-up MENU CLOSING, before a hop that is itself a pop-up selection,
#      so that hop's first click is not swallowed.
#
# So the cells below are a PAIRED A/B in one guest: the same command, over the
# same fixtures, on the same boot, run under the baseline dist and then the RC's.
# What is read off each run is not the wall (a headless clone renders at a speed
# no Mac reproduces) but the per-hop `axOps` — the AX round-trip count, which is
# the only term that transfers between machines (RDLAT2 §1) — plus the hop wall
# for context and the `ui-crosshop` records that say which waits fired.
#
# Usage: depobs3-cells.sh <node-binary> <app-dir>
#        BASELINE_APP=<dir> to run the paired A/B (else the RC arm alone).
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
BASELINE_APP="${BASELINE_APP:-}"
# The driver hands this across ssh as a literal `$HOME/...` (the remote shell
# never expands a value inside the command it is given), so expand it here.
BASELINE_APP="${BASELINE_APP/#\$HOME/$HOME}"
BASE_CLI=""
[ -n "$BASELINE_APP" ] && BASE_CLI="$BASELINE_APP/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
TRACE_DIR="$HOME/.local/state/things-api/trace"
DEPUTY_LOG="$HOME/.local/state/things-api/deputy/deputy.log"
FAILURES=0
STEP=0
TAG="DEPOBS3"
REPS="${REPS:-3}"

BEEP_SENTINEL="$(dirname "$0")/beep-sentinel.sh"
export BEEP_MARKS="$HOME/things-lab/depobs3-beep-marks.tsv"
beep() { [ -f "$BEEP_SENTINEL" ] || return 0; bash "$BEEP_SENTINEL" "$@"; }
beep reset; beep mark "depobs3 start"

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
newest_trace() { ls -t "$TRACE_DIR"/*.jsonl 2>/dev/null | head -1; }
clear_banners() { killall NotificationCenter >/dev/null 2>&1 || true; sleep 2; }

# THE READER of a drive's trace: the hops this campaign moves, by name, plus the
# node-side records that say what was waited out. One python, reused everywhere.
read_trace() {
  python3 - "$1" <<'PY'
import json, sys
hops, crosshop, settles, skipped = [], [], [], []
with open(sys.argv[1]) as fh:
    for line in fh:
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("phase") == "ui-dispatch" and r.get("event") == "end":
            hops.append({
                "primitive": r.get("primitive"), "label": (r.get("label") or "")[:44],
                "ms": r.get("durationMs"), "axOps": r.get("axOps"), "axElems": r.get("axElems"),
            })
        elif r.get("phase") == "ui-crosshop":
            crosshop.append(r)
        elif r.get("phase") == "ui-settle":
            settles.append({k: r.get(k) for k in ("what", "ok", "latencyMs", "skipped")})
print(json.dumps({"hops": hops, "crosshop": crosshop, "settles": settles}))
PY
}

echo "############################################################"
echo "# DEPOBS3 — node-side cross-hop settles, routed guest"
echo "# clock: $(date)"
echo "# RC:       $APP"
echo "# baseline: ${BASE_CLI:-<none — RC arm only>}"
echo "############################################################"

########################################################################
echo ""
echo "===== CELL 1 — routed identity (fail closed before any measurement) ====="
########################################################################
things helpers status --json >"$OUT/01-helpers.json" 2>/dev/null
python3 -c "
import json,sys
d=json.load(open('$OUT/01-helpers.json'))['data']
h=d['deputy'].get('hello') or {}
print('     mode=%s running=%s version=%s caps=%s axTrusted=%s reader=%s' % (
  d.get('mode'), d['deputy'].get('running'), h.get('deputyVersion'),
  h.get('capabilities'), h.get('axTrusted'), d['reader'].get('granted')))
"
CAPS=$(python3 -c "
import json
h=(json.load(open('$OUT/01-helpers.json'))['data']['deputy'].get('hello') or {})
print(','.join(h.get('capabilities') or []))
")
case ",$CAPS," in *,observer,*) pass "the deputy hosts the observer (caps=$CAPS)";; *) fail "no observer capability (caps=$CAPS)";; esac

things config set ui-enabled true >/dev/null && pass "ui-enabled on" || fail "could not set ui-enabled"
things config set experimental-area-reorder true >/dev/null \
  && pass "experimental-area-reorder on" || fail "could not set experimental-area-reorder"
export THINGS_API_TRACE=1

########################################################################
echo ""
echo "===== CELL 2 — the paired A/B: make-repeating, monthly-day (the shape that probes) ====="
echo "  --frequency monthly --interval 1 --on-weekday monday --on-ordinal 3 is the smallest shape with BOTH levers in it:"
echo "  a probe hop right after the frequency selection, and two consecutive pop-ups."
########################################################################
# ab_run <cli-main.js> <tag> <n> -> drives one make-repeating and prints its hops
ab_run() {
  local cli="$1" tag="$2" n="$3"
  local title="$TAG-$tag-$n"
  "$NODE" "$cli" todo add "$title" --when 2026-07-20 --json >/dev/null 2>&1
  local ref
  ref=$(db "SELECT uuid FROM TMTask WHERE title='$title' AND trashed=0 LIMIT 1")
  if [ -z "$ref" ]; then fail "[$tag/$n] no seed row for $title"; return 1; fi
  clear_banners
  STEP=$((STEP + 1))
  beep mark "[$STEP] ab $tag/$n"
  local t0 t1 out code
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  out=$(env THINGS_API_TRACE=1 "$NODE" "$cli" todo make-repeating "$ref" \
    --frequency monthly --interval 1 --on-weekday monday --on-ordinal 3 --dangerously-drive-gui \
    --verify-timeout 90000 --json 2>/dev/null)
  code=$?
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  printf '%s\n' "$out" >"$OUT/02-$tag-$n.json"
  local rule
  rule=$(db "SELECT count(*) FROM TMTask WHERE title='$title' AND rt1_recurrenceRule IS NOT NULL")
  if [ "$code" -eq 0 ] && [ "${rule:-0}" -ge 1 ]; then
    pass "[$STEP] $tag/$n — exit 0, series landed, wall=$((t1 - t0))ms"
  else
    fail "[$STEP] $tag/$n — exit $code, series rows=$rule"
    echo "     output: $(head -c 600 <<<"$out")"
  fi
  local tr
  tr=$(newest_trace)
  [ -z "$tr" ] && { echo "     (no trace)"; return 1; }
  cp "$tr" "$OUT/02-$tag-$n.jsonl"
  read_trace "$tr" >"$OUT/02-$tag-$n.trace.json"
  python3 - "$OUT/02-$tag-$n.trace.json" "$tag/$n" "$((t1 - t0))" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
want = ("probe-dialog-shape", "select-popup", "dialog-open", "audit-dialog")
rows = [h for h in d["hops"] if h["primitive"] in want]
tot_ops = sum(h["axOps"] or 0 for h in d["hops"])
tot_ms = sum(h["ms"] or 0 for h in d["hops"])
print(f"     {sys.argv[2]}: {len(d['hops'])} hops, {tot_ops} axOps, {tot_ms} ms in hops, {sys.argv[3]} ms wall")
for h in rows:
    print(f"       {h['primitive']:<20} {str(h['ms']):>6} ms  axOps={h['axOps']}  {h['label']}")
for c in d["crosshop"]:
    print(f"       crosshop: {json.dumps(c, sort_keys=True)}")
PY
  return 0
}

# INTERLEAVED, never one arm then the other. A cold app, a cold dialog and a
# cold trace directory make the first drives of a boot the slowest, so running
# all of one arm first hands that warm-up entirely to the other — which is the
# same confound RDLAT2 §7c caught in a different costume. base/rc/base/rc pairs
# each RC drive with a baseline drive taken a minute either side of it.
for n in $(seq 1 "$REPS"); do
  [ -n "$BASE_CLI" ] && ab_run "$BASE_CLI" "base" "$n"
  ab_run "$APP" "rc" "$n"
done

echo ""
echo "--- A/B summary (probe-dialog-shape is the hop whose poll the RC drops) ---"
python3 - "$OUT" "$REPS" <<'PY'
import glob, json, os, statistics, sys
out, reps = sys.argv[1], int(sys.argv[2])


def load(tag):
    rows = []
    for p in sorted(glob.glob(os.path.join(out, f"02-{tag}-*.trace.json"))):
        rows.append(json.load(open(p)))
    return rows


def hop(d, prim, nth=0):
    hits = [h for h in d["hops"] if h["primitive"] == prim]
    return hits[nth] if nth < len(hits) else None


def col(rows, prim, key, nth=0):
    vals = [hop(d, prim, nth)[key] for d in rows if hop(d, prim, nth) and hop(d, prim, nth)[key] is not None]
    return vals


for prim, nth in (("probe-dialog-shape", 0), ("select-popup", 0), ("select-popup", 1), ("select-popup", 2)):
    line = f"{prim}[{nth}]".ljust(24)
    for tag in ("base", "rc"):
        rows = load(tag)
        if not rows:
            continue
        ms, ops = col(rows, prim, "ms", nth), col(rows, prim, "axOps", nth)
        if not ms:
            continue
        line += f"  {tag}: {statistics.median(ms):>6.0f} ms / {statistics.median(ops) if ops else '-'} axOps"
    print("   ", line)
for tag in ("base", "rc"):
    rows = load(tag)
    if not rows:
        continue
    tot = [sum(h["ms"] or 0 for h in d["hops"]) for d in rows]
    ops = [sum(h["axOps"] or 0 for h in d["hops"]) for d in rows]
    hops = [len(d["hops"]) for d in rows]
    print(f"    TOTAL {tag}: hops={statistics.median(hops):.0f} axOps={statistics.median(ops):.0f} "
          f"hop-wall={statistics.median(tot):.0f} ms")
PY

########################################################################
echo ""
echo "===== CELL 3 — the four DEFAULTS3 quadrants, RC dist, routed ====="
echo "  {observer deputy, observer off} x {prefill on, prefill off}, on the shape that probes"
########################################################################
quad() {
  local name="$1" obs="$2" pf="$3"
  local title="$TAG-Q-$name"
  echo "--- quadrant $name (observer=${obs:-deputy} prefill=${pf:-on}) ---"
  "$NODE" "$APP" todo add "$title" --when 2026-07-20 --json >/dev/null 2>&1
  local ref
  ref=$(db "SELECT uuid FROM TMTask WHERE title='$title' AND trashed=0 LIMIT 1")
  clear_banners
  STEP=$((STEP + 1))
  beep mark "[$STEP] quad $name"
  local t0 t1 out code rule
  t0=$(python3 -c 'import time;print(int(time.time()*1000))')
  out=$(env THINGS_API_TRACE=1 ${obs:+THINGS_API_AX_OBSERVER=$obs} ${pf:+THINGS_API_PREFILL=$pf} \
    "$NODE" "$APP" todo make-repeating "$ref" --frequency monthly --interval 1 --on-weekday monday --on-ordinal 3 \
    --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
  code=$?
  t1=$(python3 -c 'import time;print(int(time.time()*1000))')
  printf '%s\n' "$out" >"$OUT/03-quad-$name.json"
  rule=$(db "SELECT count(*) FROM TMTask WHERE title='$title' AND rt1_recurrenceRule IS NOT NULL")
  if [ "$code" -eq 0 ] && [ "${rule:-0}" -ge 1 ]; then
    pass "[$STEP] quad $name — exit 0, series landed, wall=$((t1 - t0))ms"
  else
    fail "[$STEP] quad $name — exit $code, series rows=$rule"
    echo "     output: $(head -c 600 <<<"$out")"
  fi
  local tr
  tr=$(newest_trace)
  [ -z "$tr" ] && return 0
  read_trace "$tr" >"$OUT/03-quad-$name.trace.json"
  python3 - "$OUT/03-quad-$name.trace.json" "${obs:-deputy}" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
ch = d["crosshop"]
p = [h for h in d["hops"] if h["primitive"] == "probe-dialog-shape"]
print(f"     probe hop: {p[0]['ms'] if p else '-'} ms axOps={p[0]['axOps'] if p else '-'}; "
      f"crosshop records: {len(ch)}")
for c in ch:
    print("       " + json.dumps(c, sort_keys=True))
# The observer-off quadrants must carry NO node-side claim at all.
if sys.argv[2] == "0" and ch:
    print("     !! observer off but crosshop records present")
PY
}
quad "obsdeputy-pf-on"  ""  ""
quad "obsdeputy-pf-off" ""  "0"
quad "obsoff-pf-on"     "0" ""
quad "obsoff-pf-off"    "0" "0"

########################################################################
echo ""
echo "===== CELL 4 — add-repeating, routed (the other repeat verb) ====="
########################################################################
clear_banners
STEP=$((STEP + 1)); beep mark "[$STEP] add-repeating"
AR_OUT=$(env THINGS_API_TRACE=1 "$NODE" "$APP" todo add-repeating "$TAG-AR" \
  --when 2026-07-20 --frequency monthly --interval 1 --on-weekday monday --on-ordinal 3 \
  --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
AR_CODE=$?
printf '%s\n' "$AR_OUT" >"$OUT/04-add-repeating.json"
AR_ROWS=$(db "SELECT count(*) FROM TMTask WHERE title='$TAG-AR' AND rt1_recurrenceRule IS NOT NULL")
if [ "$AR_CODE" -eq 0 ] && [ "${AR_ROWS:-0}" -ge 1 ]; then
  pass "[$STEP] add-repeating — exit 0, template landed"
else
  fail "[$STEP] add-repeating — exit $AR_CODE, templates=$AR_ROWS"
  echo "     output: $(head -c 600 <<<"$AR_OUT")"
fi
TR=$(newest_trace)
[ -n "$TR" ] && { read_trace "$TR" >"$OUT/04-add-repeating.trace.json"; \
  python3 -c "
import json
d=json.load(open('$OUT/04-add-repeating.trace.json'))
print('     crosshop:', json.dumps(d['crosshop']))
"; }

########################################################################
echo ""
echo "===== CELL 5 — area reorder --first, routed (no pop-up, must be untouched) ====="
########################################################################
"$NODE" "$APP" area add "$TAG-A1" --json >/dev/null 2>&1
"$NODE" "$APP" area add "$TAG-A2" --json >/dev/null 2>&1
clear_banners
STEP=$((STEP + 1)); beep mark "[$STEP] area reorder"
RO_OUT=$(env THINGS_API_TRACE=1 "$NODE" "$APP" area reorder "$TAG-A2" --first \
  --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
RO_CODE=$?
printf '%s\n' "$RO_OUT" >"$OUT/05-area-reorder.json"
if [ "$RO_CODE" -eq 0 ]; then
  pass "[$STEP] area reorder --first — exit 0"
else
  fail "[$STEP] area reorder --first — exit $RO_CODE"
  echo "     output: $(head -c 600 <<<"$RO_OUT")"
fi
TR=$(newest_trace)
[ -n "$TR" ] && { read_trace "$TR" >"$OUT/05-area-reorder.trace.json"; \
  python3 -c "
import json
d=json.load(open('$OUT/05-area-reorder.trace.json'))
ch=d['crosshop']
print('     crosshop records:', len(ch), '(expected 0 — a drag recipe has no select-popup)')
"; }

########################################################################
echo ""
echo "===== CELL 6 — the DIRECT arm must be BYTE-UNCHANGED ====="
echo "  helpers-enabled false + the lab's UI escape: no deputy, no ledger, no claim."
########################################################################
things config set helpers-enabled false >/dev/null
direct_run() {
  local cli="$1" tag="$2"
  local title="$TAG-D-$tag"
  env THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1 "$NODE" "$cli" todo add "$title" \
    --when 2026-07-20 --json >/dev/null 2>&1
  local ref
  ref=$(db "SELECT uuid FROM TMTask WHERE title='$title' AND trashed=0 LIMIT 1")
  clear_banners
  STEP=$((STEP + 1)); beep mark "[$STEP] direct $tag"
  local out code rule
  out=$(env THINGS_API_TRACE=1 THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1 \
    "$NODE" "$cli" todo make-repeating "$ref" --frequency monthly --interval 1 --on-weekday monday --on-ordinal 3 \
    --dangerously-drive-gui --verify-timeout 90000 --json 2>/dev/null)
  code=$?
  printf '%s\n' "$out" >"$OUT/06-direct-$tag.json"
  rule=$(db "SELECT count(*) FROM TMTask WHERE title='$title' AND rt1_recurrenceRule IS NOT NULL")
  if [ "$code" -eq 0 ] && [ "${rule:-0}" -ge 1 ]; then
    pass "[$STEP] direct $tag — exit 0, series landed"
  else
    fail "[$STEP] direct $tag — exit $code, series rows=$rule"
    echo "     output: $(head -c 600 <<<"$out")"
  fi
  local tr
  tr=$(newest_trace)
  [ -z "$tr" ] && return 0
  read_trace "$tr" >"$OUT/06-direct-$tag.trace.json"
  python3 - "$OUT/06-direct-$tag.trace.json" "$tag" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
p = [h for h in d["hops"] if h["primitive"] == "probe-dialog-shape"]
print(f"     direct {sys.argv[2]}: probe hop {p[0]['ms'] if p else '-'} ms "
      f"axOps={p[0]['axOps'] if p else '-'}, crosshop records={len(d['crosshop'])}")
if d["crosshop"]:
    print("     !! a direct drive carried a node-side cross-hop claim")
PY
}
[ -n "$BASE_CLI" ] && direct_run "$BASE_CLI" "base"
direct_run "$APP" "rc"
things config set helpers-enabled true >/dev/null

########################################################################
echo ""
echo "===== the deputy's own verdict ====="
########################################################################
REJ=$(grep -c 'rejected-script' "$DEPUTY_LOG" 2>/dev/null | head -1)
REJ=${REJ:-0}
if [ "${REJ:-0}" -eq 0 ]; then
  pass "the deputy refused 0 scripts"
else
  fail "the deputy refused $REJ script(s)"
  grep 'rejected-script' "$DEPUTY_LOG" | tail -3 | sed 's/^/     | /'
fi
beep mark "depobs3 end"
beep assert --name "depobs3" --json "$HOME/things-lab/depobs3-beeps.json" || fail "beep assertion"

echo ""
echo "############################################################"
if [ "$FAILURES" -eq 0 ]; then echo "# DEPOBS3 cells GREEN ($STEP steps)"; else echo "# DEPOBS3 cells RED — $FAILURES failure(s)"; fi
echo "############################################################"
exit "$FAILURES"
