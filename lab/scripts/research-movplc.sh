#!/bin/bash
# MOVPLC — reproduce & byte-characterize the move placement-leg Today rewrite.
#
# Field bug (up-next §0½ item 7, spec docs/research/today-canceled-grouping-audit.md):
# a container-only `todo move` with NO explicit position automatically fires its
# default placement leg — a native `_private_experimental_ reorder to dos in list
# "Today"` over ALL open Today members (moved row first, then raw `todayIndex ASC`,
# the computeReorderPre census). That order differs from the VISIBLE Today order
# (the two-level comparator: startBucket ASC, todayIndexReferenceDate DESC cohorts,
# todayIndex ASC). The report could not capture the native command's WRITE SET.
#
# CLAIMS UNDER TEST (byte level, golden-v2 / Things 3.22.12):
#  (a) the placement wire = [movee, ...open bucket-0 Today members by todayIndex ASC]
#      — materially different from the visible cohort order (host wire-capture proves
#      the compile; this VM proves the WRITE EFFECT).
#  (b) unswept canceled rows are EXCLUDED from the wire (status!=0) and consequently
#      regroup after the reorder.
#  (c) stale startBucket=1 rows are excluded by design (O03) and sort below bucket 0
#      — verify they stay byte-untouched.
#  (d) the planner census LEAKS derived-trashed children (own trashed=0, project
#      trashed=1) into the wire — verify they enter it, and characterize what the
#      native app does with them.
#  STEP 5 (the crux): does the native Today reorder write `todayIndex` ONLY, or does
#  it also re-stamp `todayIndexReferenceDate` -> today (collapsing the entry cohorts
#  and thereby rewriting the VISIBLE order)? (Prior signal: today-order-research.md
#  "re-stamped on manual reorder"; UPCDL-2a materialize law for NON-member rows —
#  this settles it for EXISTING multi-cohort members.)
#
# FIXTURE — three distinct todayIndexReferenceDate cohorts manufactured by rolling
# the pinned clock forward (the today-order-research method): items entering Today
# on 07-05 / 07-06 / 07-07 keep their entry date (the app never normalizes). Plus
# open + canceled-unswept rows (logInterval=Manually), a stale evening (bucket-1)
# row, a repeat-lineage stand-in spread across cohorts, and a TRASHED project with
# two Today-scheduled children (the derived-trash census leak).
#
# ONE disposable clone of things-lab-golden-v2 (Things 3.22.12). VM lifecycle is
# owned by the CALLER (tart clone + tracked background `tart run`); this script only
# drives an already-booted guest. Subcommands (run in order; session.env carries IP
# + TOKEN across calls):
#   setup       airgap + pin 07-05 + warm-up + token + seed cohort C5 + EVE1 + LIN-5
#   loginterval set logInterval=4 (Manually) via System Events AX; verify
#   roll06      clock -> 07-06, relaunch, seed cohort C6 + LIN-6
#   roll07      clock -> 07-07, relaunch, seed cohort C7 + LIN-7 + MOVEE + DEST +
#               a trashed project MOVPLC-TRASH over DTC1,DTC2 -> BASELINE (step 1)
#   cancel      cancel C5b,C6b (subset) -> snapshot (step 2: cancel alone must not reorder)
#   rawmove     URL update MOVEE list-id=DEST (membership leg ONLY) -> snapshot
#               (step 3: does the app itself reorder Today? expect NO)
#   nativereorder  fire the compiled placement wire -> full DB diff (steps 4-7)
#   dump        crash/version + final snapshots + copy DB out
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-movplc-lab}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[movplc] $*" | tee -a "$REPORT"; }
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
pid_of() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND trashed=0"; }
tid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0"; }
setstatus() { gas "tell application \"Things3\" to set status of to do id \"$1\" to $2"; sleep 1; }
boundary() { gq "SELECT 'logInterval='||logInterval||' manualLogDate='||COALESCE(printf('%.2f',manualLogDate),'NULL')||' now='||strftime('%s','now') FROM TMSettings LIMIT 1"; }

# Decode a packed date column to YYYY-MM-DD (or '-') for readable snapshots.
DEC() { echo "CASE WHEN $1 IS NULL THEN '-' ELSE ($1>>16)||'-'||printf('%02d',($1>>12)&15)||'-'||printf('%02d',($1>>7)&31) END"; }

# Seed via things:///json (multi-item project or loose to-dos).
tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}
# Schedule a to-do by title: $1 title, $2 when-token (today|evening|YYYY-MM-DD)
sched() { local u; u=$(tid "$1"); gurl "things:///update?auth-token=$TOKEN&id=$u&when=$2"; }

# Full snapshot of every Today-relevant row (any status), in the VISIBLE comparator
# order, with all tracked columns. Also the derived-trash flag (project trashed).
snap() { # $1 label
  note "==== SNAPSHOT: $1 ===="
  gq "SELECT printf('%-7s',title)||' u='||substr(uuid,1,8)||' sb='||startBucket||' tIdx='||todayIndex||' tiRef='||($(DEC todayIndexReferenceDate))||' sd='||($(DEC startDate))||' st='||status||' tr='||trashed||' pTr='||COALESCE((SELECT p.trashed FROM TMTask p WHERE p.uuid=TMTask.project),'-')||' p='||COALESCE(substr(project,1,8),'-')||' h='||COALESCE(substr(heading,1,8),'-')||' umd='||printf('%.3f',userModificationDate) FROM TMTask WHERE trashed=0 AND type IN (0,1) AND startDate IS NOT NULL AND startDate<=$P0707 AND start IN (1,2) ORDER BY startBucket ASC, COALESCE(todayIndexReferenceDate,startDate,deadline) DESC, todayIndex ASC, uuid ASC" | tee -a "$REPORT"
  note "-- GUI order (get name of to dos of list \"Today\") --"
  gas 'tell application "Things3" to get name of to dos of list "Today"' | tee -a "$REPORT"
}

# The compiled placement wire: [MOVEE, ...open bucket-0 Today members by todayIndex ASC].
# Mirrors computeReorderPre today-scope EXACTLY, INCLUDING the census leak (own
# trashed=0 only; a derived-trashed child is not excluded). $1 = movee uuid.
wire_ids() { # $1 movee-uuid
  local movee="$1" rest
  rest=$(gq "SELECT uuid FROM TMTask WHERE trashed=0 AND status=0 AND type IN (0,1) AND (rt1_recurrenceRule IS NULL AND repeater IS NULL) AND startDate IS NOT NULL AND startDate<=$P0707 AND start IN (1,2) AND startBucket=0 AND uuid!='$movee' ORDER BY todayIndex ASC" | tr '\n' ',' | sed 's/,$//')
  echo "$movee,$rest"
}

reord_today() { # $1 comma-ids
  local script="tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Today\" with ids \"$1\""
  lab_ssh "$IP" "osascript -e $(printf '%q' "$script") >/tmp/reord.out 2>&1; echo \"EXIT=\$?\"; cat /tmp/reord.out" </dev/null
  sleep 3
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
  AREA_A=$(gq "SELECT uuid FROM TMArea WHERE title='LAB-AREA-A'")
  note "LAB-AREA-A=$AREA_A"

  # Cohort C5: three loose open to-dos + one evening + one lineage stand-in.
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
  # Quit + relaunch first (harness RESID1: stale window state breaks the ⌘, panel).
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
  note "################## roll clock -> 07-07, seed C7 + MOVEE + DEST + trashed-project ##################"
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'sudo date 070712002026 >/dev/null; date' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'open -g -a Things3; sleep 10' </dev/null
  AREA_A=$(gq "SELECT uuid FROM TMArea WHERE title='LAB-AREA-A'")
  note "seed C7a,C7b,C7c,LIN-7,MOVEE (loose to-dos) + DEST project"
  tjson '[{"type":"to-do","attributes":{"title":"C7a"}},{"type":"to-do","attributes":{"title":"C7b"}},{"type":"to-do","attributes":{"title":"C7c"}},{"type":"to-do","attributes":{"title":"LIN-7"}},{"type":"to-do","attributes":{"title":"MOVEE"}}]'
  tjson '[{"type":"project","attributes":{"title":"MOVPLC-DEST","area-id":"'"$AREA_A"'"}}]'
  # Trashed-project leak: a project with two Today-scheduled children, then trashed.
  note "seed MOVPLC-TRASH project over DTC1,DTC2"
  tjson '[{"type":"project","attributes":{"title":"MOVPLC-TRASH","area-id":"'"$AREA_A"'","items":[{"type":"to-do","attributes":{"title":"DTC1"}},{"type":"to-do","attributes":{"title":"DTC2"}}]}}]'
  sleep 1
  note "schedule C7* + LIN-7 + MOVEE + DTC1 + DTC2 for TODAY (07-07)"
  sched C7a today; sched C7b today; sched C7c today; sched "LIN-7" today; sched MOVEE today
  sched DTC1 today; sched DTC2 today
  sleep 2
  note "-- pre-trash: DTC children own trashed + startDate --"
  gq "SELECT title||' u='||substr(uuid,1,8)||' tr='||trashed||' sd='||($(DEC startDate))||' p='||substr(project,1,8) FROM TMTask WHERE title LIKE 'DTC%'" | tee -a "$REPORT"
  note "-- TRASH the MOVPLC-TRASH project (children become derived-trashed) --"
  TP=$(pid_of MOVPLC-TRASH)
  gas "tell application \"Things3\" to move project id \"$TP\" to list \"Trash\""
  sleep 2
  note "-- post-trash: DTC children own trashed (expect 0) + project trashed (expect 1) --"
  gq "SELECT title||' u='||substr(uuid,1,8)||' ownTr='||trashed||' projTr='||COALESCE((SELECT p.trashed FROM TMTask p WHERE p.uuid=TMTask.project),'-')||' sd='||($(DEC startDate))||' st='||status FROM TMTask WHERE title LIKE 'DTC%' OR (title='MOVPLC-TRASH' AND type=1)" | tee -a "$REPORT"
  snap "BASELINE (step 1, clock 07-07)"
  note "roll07 DONE — baseline captured"
  exit 0
fi

# ============================================================ cancel (step 2)
if [ "$CMD" = "cancel" ]; then
  load_session
  note "################## STEP 2 — cancel C5b,C6b (subset); cancel alone must NOT reorder ##################"
  note "  boundary before: $(boundary)"
  C5B=$(tid C5b); C6B=$(tid C6b)
  note "  C5b=$C5B  C6b=$C6B"
  setstatus "$C5B" canceled; setstatus "$C6B" canceled
  note "  boundary after: $(boundary)  (canceled rows UNSWEPT iff stopDate>boundary)"
  snap "AFTER CANCEL (step 2)"
  note "  ASSERT vs BASELINE: only C5b,C6b status 0->2; NO todayIndex/tiRef change on any row"
  exit 0
fi

# ============================================================ rawmove (step 3)
if [ "$CMD" = "rawmove" ]; then
  load_session
  note "################## STEP 3 — raw membership move (URL update list-id), NO placement leg ##################"
  MOVEE=$(tid MOVEE); DEST=$(pid_of MOVPLC-DEST)
  note "  MOVEE=$MOVEE  DEST(MOVPLC-DEST)=$DEST"
  note "  MOVEE before: $(gq "SELECT 'tIdx='||todayIndex||' tiRef='||($(DEC todayIndexReferenceDate))||' sd='||($(DEC startDate))||' p='||COALESCE(substr(project,1,8),'-')||' sb='||startBucket FROM TMTask WHERE uuid='$MOVEE'")"
  gurl "things:///update?auth-token=$TOKEN&id=$MOVEE&list-id=$DEST"
  sleep 2
  note "  MOVEE after:  $(gq "SELECT 'tIdx='||todayIndex||' tiRef='||($(DEC todayIndexReferenceDate))||' sd='||($(DEC startDate))||' p='||COALESCE(substr(project,1,8),'-')||' sb='||startBucket FROM TMTask WHERE uuid='$MOVEE'")"
  snap "AFTER RAW MOVE (step 3)"
  note "  ASSERT vs step 2: MOVEE project FK changed to DEST; NO todayIndex/tiRef change on ANY Today row (the app does not reorder Today on a container change)"
  exit 0
fi

# ============================================================ nativereorder (steps 4-7)
if [ "$CMD" = "nativereorder" ]; then
  load_session
  note "################## STEP 4-7 — fire the compiled placement wire ##################"
  MOVEE=$(tid MOVEE)
  W=$(wire_ids "$MOVEE")
  note "  COMPILED WIRE (movee first, then open bucket-0 Today members by todayIndex ASC):"
  note "  ids=$W"
  note "  wire member titles (in order):"
  echo "$W" | tr ',' '\n' | while read -r u; do
    [ -n "$u" ] && gq "SELECT '   '||substr('$u',1,8)||' = '||printf('%-7s',title)||' tIdx='||todayIndex||' tiRef='||($(DEC todayIndexReferenceDate))||' ownTr='||trashed||' projTr='||COALESCE((SELECT p.trashed FROM TMTask p WHERE p.uuid=TMTask.project),'-') FROM TMTask WHERE uuid='$u'" | tee -a "$REPORT"
  done
  note "  -- rows EXCLUDED from the wire (canceled + stale bucket-1): --"
  gq "SELECT '   '||printf('%-7s',title)||' st='||status||' sb='||startBucket||' reason='||CASE WHEN status!=0 THEN 'canceled/status!=0' WHEN startBucket=1 THEN 'evening bucket-1 (O03)' ELSE '?' END FROM TMTask WHERE trashed=0 AND type IN (0,1) AND startDate IS NOT NULL AND startDate<=$P0707 AND start IN (1,2) AND NOT (status=0 AND startBucket=0)" | tee -a "$REPORT"
  note "  ---- FIRE: reorder to dos in list \"Today\" with ids ---- "
  note "  $(reord_today "$W")"
  snap "AFTER NATIVE REORDER (steps 4-7)"
  note "  STEP 5 write-set — per wire member: did todayIndex change (expect: wire order)?"
  note "                     did todayIndexReferenceDate re-stamp -> 07-07 (cohort collapse)?"
  note "  STEP 6 invariant — did UNRELATED rows' VISIBLE order change (the bug)?"
  note "  STEP 7 — bucket-1 EVE1 untouched? derived-trashed DTC1/DTC2 written (materialized)?"
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
  lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/movplc.sqlite"' </dev/null
  lab_scp "$LAB_SSH_USER@$IP:/tmp/movplc.sqlite" "$OUT/final.sqlite" </dev/null 2>/dev/null || true
  note "DONE — report: $REPORT"
  exit 0
fi

echo "usage: $0 setup|loginterval|roll06|roll07|cancel|rawmove|nativereorder|dump" >&2
exit 1
