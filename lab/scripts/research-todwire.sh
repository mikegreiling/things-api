#!/bin/bash
# TODWIRE — partial-wire laws on the native `list "Today"` reorder (the MOVPLC sequel).
#
# MOVPLC (docs/lab/movplc-move-placement-today.md) proved a FULL `list "Today"`
# wire re-stamps EVERY named row's todayIndexReferenceDate -> today (cohort fusion)
# and rewrites the whole VISIBLE order, while UNNAMED rows stay byte-untouched. This
# campaign characterizes PARTIAL / minimal wires so the engine can compile the
# smallest id list that realizes a requested placement while PRESERVING the
# observable order (maintainer ruling 2026-08-11).
#
# GATING QUESTIONS (byte level, golden-v2 / Things 3.22.12):
#  EXP1 single-ID wire  — name ONE old-cohort row. Where does it land VISIBLY
#       (above the visible top? above the raw todayIndex min?)? Is ONLY its
#       todayIndex/tiRef written, every other row byte-identical?
#  EXP2 prefix wire     — name 2 rows from two cohorts. Do they cluster at the
#       visible TOP in SENT order? Do the UNNAMED rows keep their visible
#       interleave (their cohorts intact => visible positions survive)?
#  EXP3 mid-list anchor — what wire is REQUIRED to realize "x directly after y"
#       when y is mid-visible-list? (Hypothesis: name the visible PREFIX through
#       y, plus x — which fuses the whole prefix's cohorts.) Characterize the
#       minimal wire + which rows re-stamp per anchor class.
#  EXP4 restamp scope   — is tiRef->today stamped on every NAMED row ALWAYS, or
#       only rows whose todayIndex changed? Is a re-fire of an already-placed wire
#       byte-idempotent / umd-silent?
#  BYSTANDERS across ALL fires: unswept canceled (status!=0) + stale evening
#       (startBucket=1) rows must stay byte-untouched (the MOVPLC exclusion law).
#
# FIXTURE — five distinct todayIndexReferenceDate cohorts (07-03/04 golden pre-seeds
# + 07-05/06/07 via clock rolls, the today-order-research method). ONE disposable
# clone of things-lab-golden-v2 (Things 3.22.12). VM lifecycle owned by the CALLER
# (tart clone + tracked background `tart run`); this script drives an already-booted
# guest. Subcommands (run in order; session.env carries IP + TOKEN):
#   setup       airgap + pin 07-05 + warm-up + token + seed cohort C5 + EVE1 + LIN-5
#   loginterval set logInterval=4 (Manually) via System Events AX; verify
#   roll06      clock -> 07-06, relaunch, seed cohort C6 + LIN-6
#   roll07      clock -> 07-07, relaunch, seed cohort C7 + LIN-7 -> BASELINE
#   cancel      cancel C5b,C6b (unswept bystanders); assert no reorder
#   exp1        single-ID wire (old-cohort C5a) -> byte diff
#   exp2        prefix wire (C6a,C7a) -> byte diff + visible interleave
#   exp3        mid-list anchor (place C7c after C6c) -> minimal-wire characterization
#   exp4        re-fire exp2 wire (idempotency) + restamp-scope readout
#   dump        crash/version + final snapshots + copy DB out
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-todwire-lab}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[todwire] $*" | tee -a "$REPORT"; }
CMD="${1:-}"

# Packed startDate constants (y<<16 | m<<12 | d<<7), verified against oddities §9c.
P0705=132805248   # 2026-07-05
P0706=132805376   # 2026-07-06
P0707=132805504   # 2026-07-07  (final "today")

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }
gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gsql(){ lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
tid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0"; }
setstatus() { gas "tell application \"Things3\" to set status of to do id \"$1\" to $2"; sleep 1; }
boundary() { gq "SELECT 'logInterval='||logInterval||' manualLogDate='||COALESCE(printf('%.2f',manualLogDate),'NULL')||' now='||strftime('%s','now') FROM TMSettings LIMIT 1"; }

# Decode a packed date column to YYYY-MM-DD (or '-') for readable snapshots.
DEC() { echo "CASE WHEN $1 IS NULL THEN '-' ELSE ($1>>16)||'-'||printf('%02d',($1>>12)&15)||'-'||printf('%02d',($1>>7)&31) END"; }

# Seed via things:///json (loose to-dos).
tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}
sched() { local u; u=$(tid "$1"); gurl "things:///update?auth-token=$TOKEN&id=$u&when=$2"; }

# Full byte snapshot of every Today-relevant row (any status) in the VISIBLE
# comparator order (src/read/views.ts) + the AppleScript GUI order (ground truth).
snap() { # $1 label
  note "==== SNAPSHOT: $1 ===="
  gq "SELECT printf('%-8s',title)||' u='||substr(uuid,1,8)||' sb='||startBucket||' tIdx='||todayIndex||' tiRef='||($(DEC todayIndexReferenceDate))||' sd='||($(DEC startDate))||' st='||status||' umd='||printf('%.2f',userModificationDate) FROM TMTask WHERE trashed=0 AND type IN (0,1) AND startDate IS NOT NULL AND startDate<=$P0707 AND start IN (1,2) ORDER BY startBucket ASC, COALESCE(todayIndexReferenceDate,startDate,deadline) DESC, todayIndex ASC, uuid ASC" | tee -a "$REPORT"
  note "-- GUI order (get name of to dos of list \"Today\") --"
  gas 'tell application "Things3" to get name of to dos of list "Today"' | tee -a "$REPORT"
}

# The VISIBLE-ordered uuid list of OPEN bucket-0 Today members (the reader comparator,
# open rows only — the reorder-eligible cohort). One uuid per line, top -> bottom.
visible_open_uuids() {
  gq "SELECT uuid FROM TMTask WHERE trashed=0 AND status=0 AND type IN (0,1) AND (rt1_recurrenceRule IS NULL AND repeater IS NULL) AND startDate IS NOT NULL AND startDate<=$P0707 AND start IN (1,2) AND startBucket=0 ORDER BY COALESCE(todayIndexReferenceDate,startDate,deadline) DESC, todayIndex ASC, uuid ASC"
}
# The RAW todayIndex-ASC order (what the OLD full-wire census used) — for the
# "visible top != raw-index min" contrast.
raw_open_uuids() {
  gq "SELECT uuid FROM TMTask WHERE trashed=0 AND status=0 AND type IN (0,1) AND (rt1_recurrenceRule IS NULL AND repeater IS NULL) AND startDate IS NOT NULL AND startDate<=$P0707 AND start IN (1,2) AND startBucket=0 ORDER BY todayIndex ASC, uuid ASC"
}
titleof() { gq "SELECT title FROM TMTask WHERE uuid='$1'"; }

reord_today() { # $1 comma-ids
  local script="tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Today\" with ids \"$1\""
  lab_ssh "$IP" "osascript -e $(printf '%q' "$script") >/tmp/reord.out 2>&1; echo \"EXIT=\$?\"; cat /tmp/reord.out" </dev/null
  sleep 3
}

# Per-row before/after readout helper: prints tIdx + tiRef for a list of titles.
row_bytes() { # $@ titles
  local t u
  for t in "$@"; do
    u=$(tid "$t")
    [ -n "$u" ] && gq "SELECT '   '||printf('%-8s','$t')||' tIdx='||todayIndex||' tiRef='||($(DEC todayIndexReferenceDate))||' umd='||printf('%.2f',userModificationDate) FROM TMTask WHERE uuid='$u'" | tee -a "$REPORT"
  done
}

# ============================================================ setup (clock 07-05)
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP (VM $VM)"
  echo "IP=$IP" > "$SESSION"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null; date' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"

  note "warm-up: launch/quit/relaunch Things on the pinned 07-05 date"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null
  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "token in hand (${#TOKEN} chars)"

  note "seed C5a,C5b,C5c,EVE1,LIN-5 (loose to-dos)"
  tjson '[{"type":"to-do","attributes":{"title":"C5a"}},{"type":"to-do","attributes":{"title":"C5b"}},{"type":"to-do","attributes":{"title":"C5c"}},{"type":"to-do","attributes":{"title":"EVE1"}},{"type":"to-do","attributes":{"title":"LIN-5"}}]'
  sleep 1
  note "schedule C5* + LIN-5 for TODAY (07-05); EVE1 for THIS EVENING"
  sched C5a today; sched C5b today; sched C5c today; sched "LIN-5" today; sched EVE1 evening
  sleep 2
  snap "setup C5 (clock 07-05)"
  note "setup DONE — run loginterval next"
  exit 0
fi

# ============================================================ loginterval (AX)
if [ "$CMD" = "loginterval" ]; then
  load_session
  note "################## set logInterval=4 (Manually) via System Events AX ##################"
  note "  before: $(boundary)"
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3; open -a Things3; sleep 8' </dev/null
  lab_ssh "$IP" "cat > /tmp/setlog.scpt" <<'AS'
tell application "Things3" to activate
delay 1.5
tell application "System Events"
  tell process "Things3"
    set frontmost to true
    delay 0.5
    keystroke "," using command down
    delay 2.5
    try
      click button "General" of toolbar 1 of window "General"
    end try
    delay 0.8
    set report to ""
    set w to window "General"
    repeat with pb in (UI elements of w)
      if (role of pb) is "AXPopUpButton" then
        set v to ""
        try
          set v to (value of pb) as string
        end try
        if v is "Immediately" then
          set report to "found-log-popup value=[" & v & "]"
          click pb
          delay 0.9
          key code 125
          delay 0.3
          key code 125
          delay 0.3
          key code 36
          delay 0.8
          set report to report & "<2down+return>"
          exit repeat
        end if
      end if
    end repeat
    delay 0.5
    try
      keystroke "w" using command down
    end try
    return report
  end tell
end tell
AS
  note "  AX result: $(lab_ssh "$IP" 'osascript /tmp/setlog.scpt 2>&1' </dev/null)"
  sleep 2
  note "  after: $(boundary)"
  note "  (verify logInterval=4; if still 0 the AX flip failed — canceled rows would sweep)"
  exit 0
fi

# ============================================================ roll06 (clock 07-06)
if [ "$CMD" = "roll06" ]; then
  load_session
  note "################## roll clock -> 07-06, seed cohort C6 ##################"
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'sudo date 070612002026 >/dev/null; date' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'open -g -a Things3; sleep 10' </dev/null
  note "seed C6a,C6b,C6c,LIN-6"
  tjson '[{"type":"to-do","attributes":{"title":"C6a"}},{"type":"to-do","attributes":{"title":"C6b"}},{"type":"to-do","attributes":{"title":"C6c"}},{"type":"to-do","attributes":{"title":"LIN-6"}}]'
  sleep 1
  note "schedule C6* + LIN-6 for TODAY (07-06)"
  sched C6a today; sched C6b today; sched C6c today; sched "LIN-6" today
  sleep 2
  snap "roll06 (clock 07-06)"
  exit 0
fi

# ============================================================ roll07 (clock 07-07) + baseline
if [ "$CMD" = "roll07" ]; then
  load_session
  note "################## roll clock -> 07-07, seed C7 -> BASELINE ##################"
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'sudo date 070712002026 >/dev/null; date' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'open -g -a Things3; sleep 10' </dev/null
  note "seed C7a,C7b,C7c,LIN-7"
  tjson '[{"type":"to-do","attributes":{"title":"C7a"}},{"type":"to-do","attributes":{"title":"C7b"}},{"type":"to-do","attributes":{"title":"C7c"}},{"type":"to-do","attributes":{"title":"LIN-7"}}]'
  sleep 1
  note "schedule C7* + LIN-7 for TODAY (07-07)"
  sched C7a today; sched C7b today; sched C7c today; sched "LIN-7" today
  sleep 2
  snap "BASELINE (step 1, clock 07-07)"
  note "-- RAW todayIndex-ASC order (the OLD full-wire census order) vs VISIBLE order above --"
  raw_open_uuids | while read -r u; do [ -n "$u" ] && note "   raw: $(printf '%-8s' "$(titleof "$u")") u=${u:0:8}"; done
  note "roll07 DONE — baseline captured"
  exit 0
fi

# ============================================================ cancel (bystanders)
if [ "$CMD" = "cancel" ]; then
  load_session
  note "################## cancel C5b,C6b (unswept bystanders); cancel alone must NOT reorder ##################"
  note "  boundary before: $(boundary)"
  C5B=$(tid C5b); C6B=$(tid C6b)
  note "  C5b=$C5B  C6b=$C6B"
  setstatus "$C5B" canceled; setstatus "$C6B" canceled
  note "  boundary after: $(boundary)  (canceled rows UNSWEPT iff stopDate>boundary)"
  snap "AFTER CANCEL"
  note "  ASSERT vs BASELINE: only C5b,C6b status 0->2; NO todayIndex/tiRef change on any row"
  exit 0
fi

# ============================================================ EXP1 — single-ID wire
if [ "$CMD" = "exp1" ]; then
  load_session
  note "################## EXP1 — single-ID wire, OLD-cohort row C5a (07-05) ##################"
  C5A=$(tid C5a)
  note "  visible TOP before: $(titleof "$(visible_open_uuids | head -1)")   raw-index MIN before: $(titleof "$(raw_open_uuids | head -1)")"
  note "  BEFORE bytes:"; row_bytes C5a C7a C6a C5c
  note "  ---- FIRE: reorder ... with ids \"$C5A\" (C5a only) ----"
  note "  $(reord_today "$C5A")"
  snap "AFTER EXP1 (single-ID C5a)"
  note "  AFTER bytes:"; row_bytes C5a C7a C6a C5c
  note "  Q1a: did C5a land at VISIBLE TOP (above the 07-07 cohort)?"
  note "  Q1b: C5a tiRef 07-05 -> 07-07? todayIndex -> new min?"
  note "  Q1c: EVERY other row byte-identical (tIdx, tiRef, umd)? (bystanders C5b/C6b/EVE1 untouched?)"
  exit 0
fi

# ============================================================ EXP2 — prefix wire
if [ "$CMD" = "exp2" ]; then
  load_session
  note "################## EXP2 — prefix wire (C6a, C7a), SENT order ##################"
  C6A=$(tid C6a); C7A=$(tid C7a)
  note "  BEFORE bytes:"; row_bytes C6a C7a C7b C7c C6c C5c
  note "  ---- FIRE: reorder ... with ids \"$C6A,$C7A\" (C6a first, C7a second) ----"
  note "  $(reord_today "$C6A,$C7A")"
  snap "AFTER EXP2 (prefix C6a,C7a)"
  note "  AFTER bytes:"; row_bytes C6a C7a C7b C7c C6c C5c
  note "  Q2a: do C6a,C7a cluster at VISIBLE TOP in SENT order (C6a above C7a)?"
  note "  Q2b: both restamp tiRef -> 07-07, todayIndex -> wire order?"
  note "  Q2c: do UNNAMED rows keep their visible interleave (07-07 unnamed still above 07-06/05 unnamed)?"
  exit 0
fi

# ============================================================ EXP3 — mid-list anchor
if [ "$CMD" = "exp3" ]; then
  load_session
  note "################## EXP3 — mid-list anchor: place C7c directly AFTER C6c ##################"
  C7C=$(tid C7c); C6C=$(tid C6c)
  # Compute the minimal prefix wire: the VISIBLE open order from top through C6c,
  # with C7c removed then appended (minimalReorderWire for a down-move — name the
  # prefix through the anchor, movee last).
  mapfile -t VIS < <(visible_open_uuids)
  WIRE=()
  for u in "${VIS[@]}"; do
    [ "$u" = "$C7C" ] && continue           # movee excluded from the prefix
    WIRE+=("$u")
    [ "$u" = "$C6C" ] && break              # stop at the anchor
  done
  WIRE+=("$C7C")                             # movee lands last in the named block
  IDS=$(IFS=,; echo "${WIRE[*]}")
  note "  computed minimal wire (visible prefix through C6c + C7c last):"
  for u in "${WIRE[@]}"; do note "     $(printf '%-8s' "$(titleof "$u")") u=${u:0:8}"; done
  note "  named count = ${#WIRE[@]}  (rows whose cohort will re-stamp)"
  note "  BEFORE bytes:"; row_bytes C7c C6c C6a C5c LIN-7 LIN-6
  note "  ---- FIRE: reorder ... with ids \"$IDS\" ----"
  note "  $(reord_today "$IDS")"
  snap "AFTER EXP3 (C7c after C6c via prefix wire)"
  note "  AFTER bytes:"; row_bytes C7c C6c C6a C5c LIN-7 LIN-6
  note "  Q3a: did C7c land directly AFTER C6c visually?"
  note "  Q3b: which rows re-stamped tiRef->07-07 (expect: the whole named prefix)? UNNAMED tail untouched?"
  note "  Q3c: is this the MINIMAL wire — could naming fewer rows realize 'C7c after C6c'? (analyze)"
  exit 0
fi

# ============================================================ EXP4 — restamp scope / idempotency
if [ "$CMD" = "exp4" ]; then
  load_session
  note "################## EXP4 — re-fire EXP2 wire (idempotency) + restamp-scope readout ##################"
  C6A=$(tid C6a); C7A=$(tid C7a)
  note "  BEFORE bytes (C6a,C7a already at front from EXP2):"; row_bytes C6a C7a
  note "  ---- RE-FIRE: reorder ... with ids \"$C6A,$C7A\" (same wire) ----"
  note "  $(reord_today "$C6A,$C7A")"
  note "  AFTER bytes:"; row_bytes C6a C7a
  note "  Q4a: did the app REWRITE their todayIndex again (new values) or leave byte-identical?"
  note "  Q4b: umd — silent (placement re-ranks are umd-silent, TDRAG-7)?"
  note "  -- Also: scan ALL named rows across EXP1-3 for any whose todayIndex did NOT change"
  note "     but whose tiRef still re-stamped -> today (answers claim 4 'always vs only-changed')"
  snap "AFTER EXP4"
  exit 0
fi

# ============================================================ GUI cross-cohort drag (addendum)
# vncdotool against the --vnc-experimental framebuffer (golden-v2 AXVM1 layer). The
# TDRAG recipe: explicit move waypoints with the button held (NOT vncdo's `drag`),
# trailing capture flushes the release. Rows are identified VISUALLY from a capture
# (content rows expose no AX title — ORDFIN1 §8h / TDRAG).
VNCDO="${VNCDO:-lab/vncvenv/bin/vncdo}"
V() { sleep 1; timeout 90 "$VNCDO" -s "$VSERVER" ${VPASS:+-p "$VPASS"} "$@" 2>>"$OUT/vnc.log"; }

if [ "$CMD" = "drag-shot" ]; then
  load_session
  [ -n "${VSERVER:-}" ] || { echo "set VSERVER=127.0.0.1::<port> VPASS=<pw>" >&2; exit 1; }
  LBL="${2:-today}"
  lab_ssh "$IP" 'open -g "things:///show?id=today"; osascript -e "tell application \"Things3\" to activate"; sleep 2' </dev/null
  sleep 1
  V capture "$OUT/screens/$LBL.png" && note "  captured screens/$LBL.png ($(ls -la "$OUT/screens/$LBL.png" 2>/dev/null | awk '{print $5}') bytes)" || note "  capture FAILED (see vnc.log)"
  exit 0
fi

if [ "$CMD" = "drag" ]; then
  load_session
  [ -n "${VSERVER:-}" ] || { echo "set VSERVER=127.0.0.1::<port> VPASS=<pw>" >&2; exit 1; }
  SX="$2" SY="$3" TX="$4" TY="$5" LBL="${6:-drag}"
  note "  DRAG ($SX,$SY) -> ($TX,$TY) [$LBL]"
  # ONE vncdo session, explicit held-button waypoints; trailing capture flushes.
  V move "$SX" "$SY" pause 0.7 mousedown 1 pause 0.8 \
    move "$SX" $((SY-12)) pause 0.4 \
    move "$TX" $(((SY+TY)/2)) pause 0.4 \
    move "$TX" $((TY-3)) pause 0.4 \
    move "$TX" "$TY" pause 0.6 \
    mouseup 1 pause 0.7 capture "$OUT/screens/${LBL}-drop.png"
  sleep 2
  note "  drop capture -> screens/${LBL}-drop.png"
  exit 0
fi

if [ "$CMD" = "drag-snap" ]; then
  load_session
  snap "DRAG ${2:-snapshot}"
  exit 0
fi

# ============================================================ dump
if [ "$CMD" = "dump" ]; then
  load_session
  note "== crash / version =="
  lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo "Things3 ALIVE" || echo "Things3 DEAD"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i things || echo "no Things crash reports"' </dev/null | tee -a "$REPORT"
  note "Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)"
  snap "FINAL"
  lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/todwire.sqlite"' </dev/null
  lab_scp "$LAB_SSH_USER@$IP:/tmp/todwire.sqlite" "$OUT/final.sqlite" </dev/null 2>/dev/null || true
  note "DONE — report: $REPORT"
  exit 0
fi

echo "usage: $0 setup|loginterval|roll06|roll07|cancel|exp1|exp2|exp3|exp4|dump" >&2
exit 1
