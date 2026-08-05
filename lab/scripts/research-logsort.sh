#!/bin/bash
# LOGSORT — does the HEADSORT reopen-on-rerank law extend to logged TO-DOS
# (direct project children), or is a completed/canceled to-do reorder index-only?
# The direct-children mirror of HEADSORT. Write-up:
#   docs/lab/logsort-logged-child-reorder.md.
#
# HEADSORT headline (for parallel): the private reorder verb re-ranks heading
# `index` into the exact sent order for EVERY heading lifecycle state (open,
# archived-unswept, archived-swept) in ONE comma-joined wire — but re-ranking an
# ARCHIVED heading also REOPENS it (status 3->0, stopDate->NULL, umd bump,
# heading-only); restore/archive/sweep are index-silent. LOGSORT asks the to-do
# parallels: is a completed (status 3) or canceled (status 2) DIRECT CHILD
# reopened by the re-rank, or is the to-do reorder purely index-only?
#
# The private reorder verb (undocumented sdef command, gated in the engine behind
# allow-experimental + the sdef canary; probed here RAW). Direct-child to-dos live
# in the project's ONE index space (heading=NULL, project=<proj>), addressed by
# the SAME specifier the shipped reorder --scope project compiles
# (src/write/commands.ts:1440):
#   tell application "Things3" to _private_experimental_ reorder to dos in \
#       project id "<PROJ>" with ids "t1,t2,t3"
# WIRE LAW: ids are ONE comma-joined STRING. A multi-item AppleScript LIST literal
# ({"a","b"}) throws -1700 at the AppleEvent boundary and the app never runs the
# command. This script NEVER uses list literals and NEVER swallows the osascript
# exit code — every reorder captures EXIT=<code> so a -1700 (wire-never-ran) is
# distinguishable from an app silent no-op (wire ran, refused the class).
#
# Sweep boundary (src/read/log-boundary.ts): there is NO per-row swept bit. An
# item is SWEPT iff status closed (completed OR canceled) AND stopDate <=
# logBoundary. golden default logInterval=0 (Immediately) => boundary=now => every
# resolution swept at once. To manufacture an UNSWEPT resolved to-do we set
# logInterval=4 (Manually) via the Settings popup (System Events AX — golden-v2
# has the L3 grant baked), which pins boundary=manualLogDate; a resolution after
# that sits UNSWEPT, and `log completed now` advances manualLogDate to sweep
# whichever resolutions precede it (PLOG1 / LOGNOW).
#
# ONE disposable clone of things-lab-golden-v2 (Things 3.22.12), pinned clock
# 2026-07-05 12:00. VM lifecycle is owned by the CALLER (tart clone + a tracked
# background `tart run`); this script only drives an already-booted guest.
# Subcommands (run in order; session.env carries IP+TOKEN across calls):
#   setup       airgap + clock-pin + warm-up + token + gsql + seed 3 projects
#   base        L-BASE   reorder 6 OPEN direct to-dos (control)
#   loginterval set logInterval=4 (Manually) via System Events AX; verify
#   archive     build LSORT-LIFE lifecycle: sweep Ts*, keep Tu*/Tc*/Tcm* unswept
#   canceled    L-CANCELED reorder a CANCELED + a COMPLETED (both unswept)
#   unswept     L-UNSWEPT  mixed wire open + completed-unswept
#   swept       L-SWEPT(a) swept-only wire
#   rebuild     re-resolve the 6 canonical actors + re-sweep Ts* (for MIXED)
#   mixed       L-SWEPT(b)/MIXED full permutation moving every class
#   restore     L-RESTORE  uncomplete a swept to-do; index retained?
#   headed      L-HEADED   re-rank logged to-do under a LIVE heading; FK + reopen?
#   dump        final full dump + crash/version + copy DB out
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-logsort-lab}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[logsort] $*" | tee -a "$REPORT"; }
CMD="${1:-}"

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
# direct-child to-do (type=0) uuid by title
tid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND trashed=0"; }

# The private reorder verb, ids = ONE comma-joined string. Captures EXIT=<code>
# (guest-side osascript exit) so -1700 (wire never ran) is distinguished from a
# silent no-op. NO `|| true`, NO list literals.
reord() { # $1 project-uuid  $2 comma-ids
  local script="tell application \"Things3\" to _private_experimental_ reorder to dos in project id \"$1\" with ids \"$2\""
  lab_ssh "$IP" "osascript -e $(printf '%q' "$script") >/tmp/reord.out 2>&1; echo \"EXIT=\$?\"; cat /tmp/reord.out" </dev/null
  sleep 2
}

# Full per-row snapshot of a project's to-dos (and any heading + heading-children),
# ordered by (type DESC, index). Captures status/index/stopDate/trashed/heading-FK/
# project-FK/umd — everything LOGSORT tracks for byte-diff.
dump() { # $1 project title
  local p; p=$(pid_of "$1")
  gq "SELECT type||'|'||title||'|st='||status||'|idx='||\"index\"||'|stop='||COALESCE(printf('%.3f',stopDate),'-')||'|tr='||trashed||'|h='||COALESCE(substr(heading,1,8),'-')||'|p='||COALESCE(substr(project,1,8),'-')||'|umd='||printf('%.4f',userModificationDate) FROM TMTask WHERE (project='$p' OR heading IN (SELECT uuid FROM TMTask WHERE project='$p' AND type=2)) AND trashed=0 ORDER BY type DESC, \"index\""
}
# direct-child to-dos only, index order, terse
kids() { # $1 project title
  local p; p=$(pid_of "$1")
  gq "SELECT title||' idx='||\"index\"||' st='||status||' stop='||COALESCE(printf('%.2f',stopDate),'-')||' umd='||printf('%.3f',userModificationDate) FROM TMTask WHERE project='$p' AND type=0 AND trashed=0 ORDER BY \"index\""
}
row() { gq "SELECT 'idx='||\"index\"||' st='||status||' stop='||COALESCE(printf('%.3f',stopDate),'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' umd='||printf('%.4f',userModificationDate) FROM TMTask WHERE uuid='$1'"; }
boundary() { gq "SELECT 'logInterval='||logInterval||' manualLogDate='||COALESCE(printf('%.2f',manualLogDate),'NULL')||' now='||strftime('%s','now') FROM TMSettings LIMIT 1"; }

setstatus() { gas "tell application \"Things3\" to set status of to do id \"$1\" to $2"; sleep 1; }

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# ============================================================ setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP (VM $VM)"
  echo "IP=$IP" > "$SESSION"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null; date' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"

  note "warm-up: launch/quit/relaunch Things on the pinned date"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null
  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "token in hand (${#TOKEN} chars)"
  AREA_A=$(gq "SELECT uuid FROM TMArea WHERE title='LAB-AREA-A'")
  note "LAB-AREA-A=$AREA_A"

  # LSORT-BASE: 6 OPEN direct to-dos (no headings) — control for L-BASE.
  note "seed LSORT-BASE: 6 open direct to-dos T1..T6"
  tjson '[{"type":"project","attributes":{"title":"LSORT-BASE","area-id":"'"$AREA_A"'","items":[
    {"type":"to-do","attributes":{"title":"T1"}},{"type":"to-do","attributes":{"title":"T2"}},
    {"type":"to-do","attributes":{"title":"T3"}},{"type":"to-do","attributes":{"title":"T4"}},
    {"type":"to-do","attributes":{"title":"T5"}},{"type":"to-do","attributes":{"title":"T6"}}]}}]'

  # LSORT-LIFE: 8 DIRECT to-dos (no headings), seeded interleaved so initial index
  # mixes the lifecycle classes:
  #   To1,To2  open;  Tu1,Tu2  completed-unswept;  Ts1,Ts2  completed-swept;
  #   Tc1      canceled-unswept;  Tcm1  completed-unswept (L-CANCELED pair)
  note "seed LSORT-LIFE: To1,Tu1,Ts1,Tc1,Tcm1,To2,Tu2,Ts2 (interleaved direct to-dos)"
  tjson '[{"type":"project","attributes":{"title":"LSORT-LIFE","area-id":"'"$AREA_A"'","items":[
    {"type":"to-do","attributes":{"title":"To1"}},{"type":"to-do","attributes":{"title":"Tu1"}},
    {"type":"to-do","attributes":{"title":"Ts1"}},{"type":"to-do","attributes":{"title":"Tc1"}},
    {"type":"to-do","attributes":{"title":"Tcm1"}},{"type":"to-do","attributes":{"title":"To2"}},
    {"type":"to-do","attributes":{"title":"Tu2"}},{"type":"to-do","attributes":{"title":"Ts2"}}]}}]'

  # LSORT-HEADED: one LIVE heading Hh with 3 to-dos under it (L-HEADED).
  note "seed LSORT-HEADED: heading Hh over Th1,Th2,Th3"
  tjson '[{"type":"project","attributes":{"title":"LSORT-HEADED","area-id":"'"$AREA_A"'","items":[
    {"type":"heading","attributes":{"title":"Hh"}},
    {"type":"to-do","attributes":{"title":"Th1"}},{"type":"to-do","attributes":{"title":"Th2"}},{"type":"to-do","attributes":{"title":"Th3"}}]}}]'
  sleep 2
  note "--- seed verification ---"
  note "BASE kids: $(kids LSORT-BASE | tr '\n' ' ')"
  note "LIFE kids: $(kids LSORT-LIFE | tr '\n' ' ')"
  note "BASE full:"; dump LSORT-BASE | tee -a "$REPORT"
  note "LIFE full:"; dump LSORT-LIFE | tee -a "$REPORT"
  note "HEADED full:"; dump LSORT-HEADED | tee -a "$REPORT"
  note "sweep state: $(boundary)"
  note "setup DONE"
  exit 0
fi

# ============================================================ base (L-BASE control)
if [ "$CMD" = "base" ]; then
  load_session
  note "################## L-BASE — reorder 6 OPEN direct to-dos (control) ##################"
  BP=$(pid_of LSORT-BASE)
  T1=$(tid T1); T2=$(tid T2); T3=$(tid T3); T4=$(tid T4); T5=$(tid T5); T6=$(tid T6)
  note "  LSORT-BASE=$BP  T1=$T1 T2=$T2 T3=$T3 T4=$T4 T5=$T5 T6=$T6"
  note "  BEFORE:"; dump LSORT-BASE | tee -a "$REPORT"
  note "  ---- reorder wire (full, target T4,T1,T6,T2,T5,T3) ----"
  note "  $(reord "$BP" "$T4,$T1,$T6,$T2,$T5,$T3")"
  note "  AFTER (expect index order T4<T1<T6<T2<T5<T3, index-only, umd-silent):"; dump LSORT-BASE | tee -a "$REPORT"
  exit 0
fi

# ============================================================ loginterval (AX)
if [ "$CMD" = "loginterval" ]; then
  load_session
  note "################## set logInterval=4 (Manually) via System Events AX ##################"
  note "  before: $(boundary)"
  lab_ssh "$IP" 'open -a Things3; sleep 3' </dev/null
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
  note "  (verify logInterval=4; if still 0 the AX flip failed — unswept/mixed classes blocked)"
  exit 0
fi

# ============================================================ archive (build lifecycle)
if [ "$CMD" = "archive" ]; then
  load_session
  note "################## build LSORT-LIFE lifecycle ##################"
  note "  (sweep Ts*; keep Tu*/Tcm* completed-unswept, Tc1 canceled-unswept; To* open)"
  TS1=$(tid Ts1); TS2=$(tid Ts2); TU1=$(tid Tu1); TU2=$(tid Tu2); TCM1=$(tid Tcm1); TC1=$(tid Tc1)
  note "  Ts1=$TS1 Ts2=$TS2 Tu1=$TU1 Tu2=$TU2 Tcm1=$TCM1 Tc1=$TC1"
  note "  -- complete Ts1,Ts2 (to be SWEPT) --"; setstatus "$TS1" completed; setstatus "$TS2" completed
  note "  state after completing Ts*: $(kids LSORT-LIFE | tr '\n' ' ')"
  note "  -- log completed now (advance manualLogDate past Ts* stopDate => Ts* SWEPT) --"
  gas "tell application \"Things3\" to log completed now"; sleep 2
  note "  boundary after log-now: $(boundary)"
  note "  -- resolve Tu1,Tu2,Tcm1 (complete) + Tc1 (cancel) AFTER the sweep => UNSWEPT --"
  setstatus "$TU1" completed; setstatus "$TU2" completed; setstatus "$TCM1" completed; setstatus "$TC1" canceled
  note "  boundary final: $(boundary)"
  note "  LIFE kids (idx/st/stop):"; kids LSORT-LIFE | tee -a "$REPORT"
  note "  LIFE full:"; dump LSORT-LIFE | tee -a "$REPORT"
  note "  classification: Ts* SWEPT iff stop<=manualLogDate; Tu*/Tcm*/Tc1 UNSWEPT iff stop>boundary; To* open"
  exit 0
fi

# ============================================================ canceled (L-CANCELED)
if [ "$CMD" = "canceled" ]; then
  load_session
  note "################## L-CANCELED — reorder a CANCELED + a COMPLETED (both unswept) ##################"
  LP=$(pid_of LSORT-LIFE)
  TC1=$(tid Tc1); TCM1=$(tid Tcm1)
  note "  Tc1=$TC1 (canceled)  Tcm1=$TCM1 (completed)"
  note "  Tc1  BEFORE: $(row "$TC1")"
  note "  Tcm1 BEFORE: $(row "$TCM1")"
  note "  BEFORE:"; dump LSORT-LIFE | tee -a "$REPORT"
  note "  ---- reorder wire (canceled+completed, target Tc1,Tcm1) ----"
  note "  $(reord "$LP" "$TC1,$TCM1")"
  note "  Tc1  AFTER: $(row "$TC1")"
  note "  Tcm1 AFTER: $(row "$TCM1")"
  note "  AFTER (canceled reopened 2->0? completed reopened 3->0? same or different?):"; dump LSORT-LIFE | tee -a "$REPORT"
  exit 0
fi

# ============================================================ unswept (L-UNSWEPT)
if [ "$CMD" = "unswept" ]; then
  load_session
  note "################## L-UNSWEPT — mixed wire OPEN + COMPLETED-unswept ##################"
  LP=$(pid_of LSORT-LIFE)
  TO1=$(tid To1); TO2=$(tid To2); TU1=$(tid Tu1); TU2=$(tid Tu2)
  note "  To1=$TO1 To2=$TO2 Tu1=$TU1 Tu2=$TU2"
  note "  Tu1 BEFORE: $(row "$TU1")"; note "  Tu2 BEFORE: $(row "$TU2")"
  note "  BEFORE:"; dump LSORT-LIFE | tee -a "$REPORT"
  note "  ---- reorder wire (open+unswept, target Tu1,To1,Tu2,To2) ----"
  note "  $(reord "$LP" "$TU1,$TO1,$TU2,$TO2")"
  note "  Tu1 AFTER: $(row "$TU1")"; note "  Tu2 AFTER: $(row "$TU2")"
  note "  AFTER (accepted? order? completed-unswept REOPENED or index-only? open index-only+umd-silent?):"; dump LSORT-LIFE | tee -a "$REPORT"
  exit 0
fi

# ============================================================ swept (L-SWEPT a)
if [ "$CMD" = "swept" ]; then
  load_session
  note "################## L-SWEPT(a) — swept-ONLY wire ##################"
  LP=$(pid_of LSORT-LIFE)
  TS1=$(tid Ts1); TS2=$(tid Ts2)
  note "  Ts1=$TS1 Ts2=$TS2"
  note "  Ts1 BEFORE: $(row "$TS1")"; note "  Ts2 BEFORE: $(row "$TS2")"
  note "  BEFORE:"; dump LSORT-LIFE | tee -a "$REPORT"
  note "  ---- reorder wire (swept-only, target Ts2,Ts1 — swap the two swept to-dos) ----"
  note "  $(reord "$LP" "$TS2,$TS1")"
  note "  Ts1 AFTER: $(row "$TS1")"; note "  Ts2 AFTER: $(row "$TS2")"
  note "  AFTER (swept reachable? index swapped? reopened or index-only? others untouched?):"; dump LSORT-LIFE | tee -a "$REPORT"
  exit 0
fi

# ============================================================ rebuild (reconstitute lifecycle)
if [ "$CMD" = "rebuild" ]; then
  load_session
  note "################## rebuild LSORT-LIFE lifecycle before MIXED ##################"
  note "  (re-resolve the 6 canonical actors that prior legs may have reopened; re-sweep Ts*)"
  TS1=$(tid Ts1); TS2=$(tid Ts2); TU1=$(tid Tu1); TU2=$(tid Tu2)
  note "  -- reopen Tu1,Tu2 first so their FRESH stopDate lands ABOVE the advanced boundary --"
  note "     (a no-op re-complete keeps the OLD stopDate, which the advanced boundary would sweep)"
  setstatus "$TU1" open; setstatus "$TU2" open
  note "  -- (re)complete Ts1,Ts2 then log completed now (SWEEP) --"
  setstatus "$TS1" completed; setstatus "$TS2" completed
  gas "tell application \"Things3\" to log completed now"; sleep 2
  note "  boundary after re-sweep: $(boundary)"
  note "  -- complete Tu1,Tu2 AFTER the sweep (fresh stopDate > boundary => UNSWEPT) --"
  setstatus "$TU1" completed; setstatus "$TU2" completed
  note "  boundary final: $(boundary)"
  note "  LIFE kids: $(kids LSORT-LIFE | tr '\n' ' ')"
  note "  LIFE full:"; dump LSORT-LIFE | tee -a "$REPORT"
  exit 0
fi

# ============================================================ mixed (L-SWEPT b / MIXED)
if [ "$CMD" = "mixed" ]; then
  load_session
  note "################## L-SWEPT(b)/MIXED — full permutation moving every class ##################"
  LP=$(pid_of LSORT-LIFE)
  TO1=$(tid To1); TO2=$(tid To2); TU1=$(tid Tu1); TU2=$(tid Tu2); TS1=$(tid Ts1); TS2=$(tid Ts2)
  note "  To1=$TO1 To2=$TO2 Tu1=$TU1 Tu2=$TU2 Ts1=$TS1 Ts2=$TS2"
  note "  BEFORE:"; dump LSORT-LIFE | tee -a "$REPORT"
  note "  ---- full 6-id wire, target Ts1,To2,Tu1,Ts2,To1,Tu2 (every class moves) ----"
  note "  $(reord "$LP" "$TS1,$TO2,$TU1,$TS2,$TO1,$TU2")"
  note "  AFTER (exact order? each class repositioned? which classes reopen? children/others intact?):"; dump LSORT-LIFE | tee -a "$REPORT"
  exit 0
fi

# ============================================================ restore (L-RESTORE)
if [ "$CMD" = "restore" ]; then
  load_session
  note "################## L-RESTORE — a freshly-SWEPT to-do unarchived retains its index ##################"
  note "  (isolates the PURE unarchive: complete+sweep one open actor, capture its swept index,"
  note "   then set-status-open — does it re-enter the body at the RETAINED index?)"
  T=$(tid To1)
  note "  target To1=$T"
  note "  To1 (pre-complete): $(row "$T")"
  note "  -- complete To1 then log completed now (SWEEP it) --"
  setstatus "$T" completed
  gas "tell application \"Things3\" to log completed now"; sleep 2
  note "  boundary: $(boundary)"
  note "  To1 (swept — index UNCHANGED by complete+sweep?): $(row "$T")"
  note "  -- unarchive To1 (set status to open) — the RESTORE --"
  setstatus "$T" open
  note "  To1 (restored — index retained? status 3->0, stop->NULL only?): $(row "$T")"
  note "  FINAL LIFE kids: $(kids LSORT-LIFE | tr '\n' ' ')"
  exit 0
fi

# ============================================================ headed (L-HEADED)
if [ "$CMD" = "headed" ]; then
  load_session
  note "################## L-HEADED — re-rank logged to-do under a LIVE heading ##################"
  HP=$(pid_of LSORT-HEADED)
  HH=$(gq "SELECT uuid FROM TMTask WHERE title='Hh' AND type=2 AND trashed=0")
  TH1=$(tid Th1); TH2=$(tid Th2); TH3=$(tid Th3)
  note "  LSORT-HEADED=$HP  Hh=$HH  Th1=$TH1 Th2=$TH2 Th3=$TH3"
  note "  -- complete Th2 then log completed now (a LOGGED to-do under a live heading) --"
  setstatus "$TH2" completed
  gas "tell application \"Things3\" to log completed now"; sleep 2
  note "  boundary: $(boundary)"
  note "  Th2 (logged): $(row "$TH2")"
  note "  BEFORE:"; dump LSORT-HEADED | tee -a "$REPORT"
  note "  ---- reorder the heading's children (target Th3,Th1,Th2) via project-scope wire ----"
  note "  $(reord "$HP" "$TH3,$TH1,$TH2")"
  note "  Th1 AFTER: $(row "$TH1")"; note "  Th2 AFTER: $(row "$TH2")"; note "  Th3 AFTER: $(row "$TH3")"
  note "  AFTER (accepted? order? heading-FK preserved (h=$HH)? logged Th2 reopened or index-only?):"; dump LSORT-HEADED | tee -a "$REPORT"
  exit 0
fi

# ============================================================ dump
if [ "$CMD" = "dump" ]; then
  load_session
  note "== crash / version =="
  lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo "Things3 ALIVE" || echo "Things3 DEAD"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i things || echo "no Things crash reports"' </dev/null | tee -a "$REPORT"
  note "Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)"
  note "FINAL BASE:"; dump LSORT-BASE | tee -a "$REPORT"
  note "FINAL LIFE:"; dump LSORT-LIFE | tee -a "$REPORT"
  note "FINAL HEADED:"; dump LSORT-HEADED | tee -a "$REPORT"
  lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/logsort.sqlite"' </dev/null
  lab_scp "$LAB_SSH_USER@$IP:/tmp/logsort.sqlite" "$OUT/final.sqlite" </dev/null 2>/dev/null || true
  note "DONE — report: $REPORT"
  exit 0
fi

echo "usage: $0 setup|base|loginterval|archive|canceled|unswept|swept|rebuild|mixed|restore|headed|dump" >&2
exit 1
