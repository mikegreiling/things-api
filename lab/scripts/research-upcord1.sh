#!/bin/bash
# UPCORD1 — the LAST ordering gap: LOOSE (container-less) items within a FUTURE
# Upcoming day-group, ordered on the shared `todayIndex` axis. DAYORD-b closed
# the CONTAINER same-day child case (project/area specifier, date-preserving) but
# left STANDALONE loose future-day items app-default: `list "Upcoming"` re-dates
# (§9g), date-shaped `list` specifiers don't exist (-1728), only `list "Tomorrow"`
# reaches the next day. This campaign hunts a deterministic loose-future-day
# protocol via three arms. Write-up: docs/lab/upcord1-loose-day-order.md.
#
# ONE disposable offline Tart clone `upcord1-lab` (pinned clock 2026-07-05 12:00,
# ordering is local — no cloud account). Fully HEADLESS (URL + AppleScript); no
# Accessibility, no VNC needed. Subcommands:
#   research-upcord1.sh setup      clone+boot+airgap+clock-pin+seed
#   research-upcord1.sh probe       Arm A · Arm B · Arm C (all headless)
#   research-upcord1.sh teardown    stop + delete the clone
#
# Arms (each verdict stated as an implementable law — see the doc):
#   A  re-when-same-date reindex: does URL `update when=<the SAME future date>`
#      move a loose to-do within that day's todayIndex order? (bounce-discovery)
#   B  park-sort-unparent: assign loose->scratch area, run the SHIPPED container-day
#      reorder (private `reorder to dos in area id` = the compile output), unpark
#      back to loose; does the todayIndex order SURVIVE? (+ scratch PROJECT, + projects)
#   C  templates: re-parent a golden repeating template, does the container-day
#      reorder RANK or SKIP it (§9e), does the series mutate (rt1_*), re-when law.
#
# Conventions inherited from research-reordgaps.sh / research-bounce2.sh:
#   * offline COW clone, guest airgap (delete default route), clock pinned BEFORE
#     Things launches, read-only guest SQLite.
#   * `with ids` is a COMMA-SEPARATED STRING. The private reorder re-ranks the
#     addressed key ASCENDING in the sent id order (DAYORD-b).
#   * NEVER send URL `when=`/schedule-class to a REPEATING template row (§1 CRASH).
#     Arm C touches templates only via container moves + reorder, never when=.
#   * NO clock advance anywhere (esp. Arm C: a parked template must not spawn).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"          # 2026-07-05 12:00 (golden pinnedDate)
DAY="${DAY:-2026-07-10}"             # the future Upcoming test day
VM="upcord1-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[upcord1] $*" | tee -a "$REPORT"; }

CMD="${1:-}"

# --------------------------------------------------------------- guest SQLite
GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gsql(){ lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
areaid() { gq "SELECT uuid FROM TMArea WHERE title='$1'"; }
# private reorder command (comma-separated ids string) — the container-day compile
reord()  { gas "tell application \"Things3\" to _private_experimental_ reorder to dos in $1 with ids \"$2\""; sleep 2; }
# full within-day state for a title glob, ORDERED BY todayIndex (the day-bucket axis)
dumpday() { gq "SELECT title||' tIdx='||todayIndex||' idx='||\"index\"||' start='||start||' sd='||COALESCE(startDate,'-')||' rem='||COALESCE(reminderTime,'-')||' dl='||COALESCE(deadline,'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-') FROM TMTask WHERE title LIKE '$1' ORDER BY todayIndex, \"index\""; }
umod() { gq "SELECT title||'='||COALESCE(userModificationDate,'-') FROM TMTask WHERE title LIKE '$1' ORDER BY title"; }

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (test day $DAY)"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  echo "IP=$IP" > "$SESSION"

  note "warm-up: launch/quit/relaunch Things on the pinned date"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"
  AA=$(areaid LAB-AREA-A); AB=$(areaid LAB-AREA-B)
  note "areas: A=$AA B=$AB"

  # ---- SEED -------------------------------------------------------------
  # Arm A: 4 loose (area-less) to-dos all scheduled the SAME future day. One
  # (AA-2) carries a reminder + a deadline to test side-effect preservation.
  note "seed Arm A: AA-1/3/4 loose @$DAY; AA-2 loose @$DAY with reminder 09:00 + deadline $DAY"
  for t in AA-1 AA-2 AA-3 AA-4; do
    if [ "$t" = "AA-2" ]; then gurl "things:///add?title=$t&when=$DAY@09:00&deadline=$DAY";
    else gurl "things:///add?title=$t&when=$DAY"; fi
  done
  # Arm B: 4 loose (area-less) to-dos scheduled the same future day (park fodder).
  note "seed Arm B: BB-1/2/3/4 loose @$DAY"
  for t in BB-1 BB-2 BB-3 BB-4; do gurl "things:///add?title=$t&when=$DAY"; done
  # Arm B project sub-question: 4 area-less PROJECTS scheduled the same future day.
  note "seed Arm B(proj): PJ-1/2/3/4 area-less projects @$DAY"
  for t in PJ-1 PJ-2 PJ-3 PJ-4; do gurl "things:///add-project?title=$t&when=$DAY"; done
  sleep 2

  note "--- seed verification (todayIndex present? start=2? area NULL?) ---"
  note "Arm A loose @$DAY: $(dumpday 'AA-%' | tr '\n' ' ')"
  note "Arm B loose @$DAY: $(dumpday 'BB-%' | tr '\n' ' ')"
  note "Arm B projects @$DAY: $(gq "SELECT title||' tIdx='||todayIndex||' idx='||\"index\"||' type='||type||' start='||start||' sd='||COALESCE(startDate,'-')||' a='||COALESCE(substr(area,1,8),'-') FROM TMTask WHERE title LIKE 'PJ-%' ORDER BY todayIndex, \"index\"" | tr '\n' ' ')"
  note "golden repeating templates: $(gq "SELECT title||' type='||type||' tIdx='||todayIndex||' idx='||\"index\"||' start='||start||' sd='||COALESCE(startDate,'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-')||' rt='||substr(COALESCE(rt1_recurrenceRule,'-'),1,12) FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL ORDER BY type,title" | tr '\n' ' ')"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ==================================================================== probe
if [ "$CMD" = "probe" ]; then
  load_session
  AA=$(areaid LAB-AREA-A); AB=$(areaid LAB-AREA-B)

  ############################################################################
  note "################## ARM A — re-when-same-date reindex ##################"
  A1=$(uuid_of AA-1); A2=$(uuid_of AA-2); A3=$(uuid_of AA-3); A4=$(uuid_of AA-4)
  note "  seeded todayIndex order: $(dumpday 'AA-%' | tr '\n' ' ')"
  note "  ---- A1: re-when ONE (AA-2) with when=$DAY (the SAME date) ----"
  note "     umod before: $(umod 'AA-2')"
  gurl "things:///update?id=$A2&auth-token=$TOKEN&when=$DAY"
  note "     after re-when AA-2: $(dumpday 'AA-%' | tr '\n' ' ')"
  note "     umod after : $(umod 'AA-2')"
  note "     INTERPRET: did AA-2's todayIndex move? append-to-END / front / no-op? sd/rem/dl preserved? start still 2?"
  note "  ---- A2: full permutation via sequential re-whens (SCRAMBLED target) ----"
  # Scrambled target order to PROVE sequence controls placement (not a no-op):
  # target AA-3 < AA-4 < AA-1 < AA-2. Re-when in FORWARD target order; if the
  # mechanism is append-to-end, final todayIndex order == the sent sequence.
  note "     target order: AA-3, AA-4, AA-1, AA-2 (scrambled). Re-when forward-sequence:"
  for u in "$A3" "$A4" "$A1" "$A2"; do
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=$DAY"
    note "       after re-when $(gq "SELECT title FROM TMTask WHERE uuid='$u'"): $(dumpday 'AA-%' | tr '\n' ' ')"
  done
  note "     FINAL: $(dumpday 'AA-%' | tr '\n' ' ')"
  note "     VERDICT-A: forward-sequence == target (AA-3<AA-4<AA-1<AA-2) => append-to-end, forward-order protocol. == reverse => front-insert, reverse-order protocol. no move => index-inert (dead end)."

  ############################################################################
  note "################## ARM B — park-sort-unparent ##################"
  B1=$(uuid_of BB-1); B2=$(uuid_of BB-2); B3=$(uuid_of BB-3); B4=$(uuid_of BB-4)
  note "  seeded loose @$DAY: $(dumpday 'BB-%' | tr '\n' ' ')"
  note "  ---- B.1 PARK: assign all 4 to scratch area LAB-AREA-B via URL update?list-id= ----"
  for u in "$B1" "$B2" "$B3" "$B4"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$AB"; done
  note "     after park (area set? sd/todayIndex survive? start still 2?): $(dumpday 'BB-%' | tr '\n' ' ')"
  note "  ---- B.2 REORDER: shipped container-day reorder against the AREA (scrambled target BB-3,BB-1,BB-4,BB-2) ----"
  note "     result: $(reord "area id \"$AB\"" "$B3,$B1,$B4,$B2")"
  note "     after reorder (todayIndex re-rank BB-3<BB-1<BB-4<BB-2? date preserved?): $(dumpday 'BB-%' | tr '\n' ' ')"
  note "  ---- B.3 UNPARK: area->none via URL update?list-id= (empty) ----"
  for u in "$B1" "$B2" "$B3" "$B4"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id="; done
  note "     after unpark (area cleared? WHEN-STATE survives: sd + todayIndex + start=2?): $(dumpday 'BB-%' | tr '\n' ' ')"
  note "     VERDICT-B: if final loose order (area NULL) == BB-3<BB-1<BB-4<BB-2 with sd=$DAY preserved => park-sort-unpark is a WIREABLE loose-day protocol. de-scheduled (sd NULL) at any leg => §9g-adjacent destructive, dead end."

  note "  ---- B.4 scratch PROJECT variant: park BB-* into a fresh area-less project, reorder, unpark ----"
  tjson '[{"type":"project","attributes":{"title":"UP-SCRATCH"}}]'; sleep 2
  SCRATCH=$(gq "SELECT uuid FROM TMTask WHERE title='UP-SCRATCH' AND type=1")
  note "     scratch project: $SCRATCH"
  for u in "$B1" "$B2" "$B3" "$B4"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$SCRATCH"; done
  note "     after park-in-project: $(dumpday 'BB-%' | tr '\n' ' ')"
  # reorder to a DIFFERENT scrambled target so a change is unambiguous: BB-2,BB-4,BB-1,BB-3
  note "     reorder(project id) result: $(reord "project id \"$SCRATCH\"" "$B2,$B4,$B1,$B3")"
  note "     after project reorder (BB-2<BB-4<BB-1<BB-3?): $(dumpday 'BB-%' | tr '\n' ' ')"
  for u in "$B1" "$B2" "$B3" "$B4"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id="; done
  note "     after unpark-from-project: $(dumpday 'BB-%' | tr '\n' ' ')"

  note "  ---- B.5 area-less PROJECTS as reorderees: do project ROWS sort on todayIndex in a day group? ----"
  P1=$(uuid_of PJ-1 1); P2=$(uuid_of PJ-2 1); P3=$(uuid_of PJ-3 1); P4=$(uuid_of PJ-4 1)
  note "     seeded projects @$DAY: $(gq "SELECT title||' tIdx='||todayIndex||' idx='||\"index\"||' a='||COALESCE(substr(area,1,8),'-') FROM TMTask WHERE title LIKE 'PJ-%' ORDER BY todayIndex,\"index\"" | tr '\n' ' ')"
  note "     apply Arm-A re-when-same-date to a project row (PJ-2): does a project ROW reindex on todayIndex?"
  gurl "things:///update-project?id=$P2&auth-token=$TOKEN&when=$DAY"
  note "     after re-when PJ-2: $(gq "SELECT title||' tIdx='||todayIndex||' idx='||\"index\"||' sd='||COALESCE(startDate,'-') FROM TMTask WHERE title LIKE 'PJ-%' ORDER BY todayIndex,\"index\"" | tr '\n' ' ')"

  ############################################################################
  note "################## ARM C — templates ##################"
  # Golden has LAB-REPEAT-DAILY (repeating TO-DO template) + LAB-REPEAT-WEEKLY-PROJ
  # (repeating PROJECT template). Never send when=/schedule-class (§1 CRASH).
  TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  note "  template LAB-REPEAT-DAILY uuid=$TMPL"
  note "  ---- C1: oracle visibility + resting state (GUI intermix law needs VNC — BLOCKED here) ----"
  note "     template row: $(gq "SELECT title||' type='||type||' tIdx='||todayIndex||' idx='||\"index\"||' start='||start||' sd='||COALESCE(startDate,'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-') FROM TMTask WHERE uuid='$TMPL'")"
  note "     AppleScript list-read visibility (expect OMITTED, §5e): $(gas 'tell application "Things3" to get name of every to do of list "Anytime"' | tr ',' '\n' | grep -c 'LAB-REPEAT-DAILY' | sed 's/^/matches=/')"
  note "     AppleScript by-id fetch (expect resolves, §5e): $(gas "tell application \"Things3\" to get name of to do id \"$TMPL\"")"

  note "  ---- C2/C3: re-parent template to LAB-AREA-A (brief: keep park BRIEF, no clock advance), dump rt1, check reorder stack/skip, unpark ----"
  note "     rt1 BEFORE park: $(gq "SELECT substr(hex(rt1_recurrenceRule),1,64) FROM TMTask WHERE uuid='$TMPL'")"
  note "     re-parent via URL update?list-id=<LAB-AREA-A>:"
  gurl "things:///update?id=$TMPL&auth-token=$TOKEN&list-id=$AA"
  note "     after re-parent: $(gq "SELECT title||' type='||type||' a='||COALESCE(substr(area,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' tIdx='||todayIndex||' idx='||\"index\"||' sd='||COALESCE(startDate,'-') FROM TMTask WHERE uuid='$TMPL'")"
  note "     rt1 AFTER re-parent (series mutated? expect BYTE-IDENTICAL): $(gq "SELECT substr(hex(rt1_recurrenceRule),1,64) FROM TMTask WHERE uuid='$TMPL'")"
  # Seed 2 ordinary dated to-dos in LAB-AREA-A on the test day so a container-day
  # reorder has real movees; include the template in the wire list to test RANK/SKIP.
  for t in CT-1 CT-2; do gurl "things:///add?title=$t&when=$DAY&list-id=$AA"; done; sleep 2
  CT1=$(uuid_of CT-1); CT2=$(uuid_of CT-2)
  note "     area-A day members before reorder: $(dumpday 'CT-%' | tr '\n' ' ')"
  note "     template tIdx/idx before reorder: $(gq "SELECT 'tIdx='||todayIndex||' idx='||\"index\" FROM TMTask WHERE uuid='$TMPL'")"
  note "     container-day reorder wire = <TMPL>,CT-2,CT-1 (template FIRST to see if it ranks):"
  note "     result: $(reord "area id \"$AA\"" "$TMPL,$CT2,$CT1")"
  note "     after: CT members: $(dumpday 'CT-%' | tr '\n' ' ')"
  note "     after: template: $(gq "SELECT 'tIdx='||todayIndex||' idx='||\"index\" FROM TMTask WHERE uuid='$TMPL'")"
  note "     INTERPRET: template tIdx UNCHANGED => reorder SKIPS the template row (§9e no-op law, invisible to 'to dos' set). CT-2<CT-1 re-rank => ordinary movees still ranked."
  note "     UNPARK template back to loose (list-id= empty):"
  gurl "things:///update?id=$TMPL&auth-token=$TOKEN&list-id="
  note "     after unpark: $(gq "SELECT title||' a='||COALESCE(substr(area,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' start='||start FROM TMTask WHERE uuid='$TMPL'")"
  note "     rt1 AFTER unpark (still byte-identical?): $(gq "SELECT substr(hex(rt1_recurrenceRule),1,64) FROM TMTask WHERE uuid='$TMPL'")"

  note "  ---- C4: does Arm-A re-when apply to templates? (one-liner LAW, do NOT execute — §1 CRASH) ----"
  note "     URL update?when= on a repeating template is the documented §1 CRASH (SIGTRAP) — NOT executed here."
  note "     AppleScript 'schedule to do id <template>' is guarded => error 302 (§1 contrast). Safe to probe:"
  note "     schedule result: $(gas "tell application \"Things3\" to schedule to do id \"$TMPL\" for (current date)")"
  note "     VERDICT-C4: templates have no when-reindex path — URL when= crashes, AppleScript schedule refuses (302). Re-when does NOT apply to templates."

  note "probe DONE — full log in $REPORT"
  exit 0
fi

# =========================================================== probeb2 (Arm B, clean)
# Arm B v1 used an AREA scratch container; the area-specifier reorder DE-SCHEDULES
# dated members (§9f extension: start 2->1, startDate->NULL), poisoning the later
# legs. This clean pass uses a PROJECT scratch container (the project specifier is
# date-preserving, DAYORD-b) and tests EACH leg's schedule preservation on fresh
# dated items — the real candidate wireable protocol + the load-bearing UNPARK leg.
if [ "$CMD" = "probeb2" ]; then
  load_session
  note "################## ARM B (clean, PROJECT scratch) ##################"
  note "  seed fresh CC-1/2/3/4 loose @$DAY"
  for t in CC-1 CC-2 CC-3 CC-4; do gurl "things:///add?title=$t&when=$DAY"; done; sleep 2
  C1=$(uuid_of CC-1); C2=$(uuid_of CC-2); C3=$(uuid_of CC-3); C4=$(uuid_of CC-4)
  note "  seeded loose @$DAY: $(dumpday 'CC-%' | tr '\n' ' ')"
  tjson '[{"type":"project","attributes":{"title":"UP-SCRATCH2"}}]'; sleep 2
  SP=$(gq "SELECT uuid FROM TMTask WHERE title='UP-SCRATCH2' AND type=1")
  note "  scratch PROJECT: $SP"
  note "  ---- leg 1 PARK loose->project via URL update?list-id=<project> ----"
  for u in "$C1" "$C2" "$C3" "$C4"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$SP"; done
  note "     after park (project set? DATE + todayIndex + start=2 SURVIVE?): $(dumpday 'CC-%' | tr '\n' ' ')"
  note "  ---- leg 2 REORDER: project container-day reorder (scrambled target CC-3,CC-1,CC-4,CC-2) ----"
  note "     result: $(reord "project id \"$SP\"" "$C3,$C1,$C4,$C2")"
  note "     after reorder (todayIndex re-rank CC-3<CC-1<CC-4<CC-2? DATE preserved? start=2?): $(dumpday 'CC-%' | tr '\n' ' ')"
  note "  ---- leg 3 UNPARK project->loose via URL update?list-id= (empty) — the load-bearing leg ----"
  for u in "$C1" "$C2" "$C3" "$C4"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id="; done
  note "     after unpark (project cleared? WHEN-STATE survives: DATE + todayIndex + start=2? order kept?): $(dumpday 'CC-%' | tr '\n' ' ')"
  note "     VERDICT-B(clean): all three legs date-preserving AND final loose order == CC-3<CC-1<CC-4<CC-2 with sd=$DAY => park-into-PROJECT-sort-unpark is the WIREABLE loose-day protocol. Any leg de-schedules (sd NULL / start 1) => dead end, loose-day stays app-default."
  note "  ---- control: isolate the UNPARK leg on an untouched dated loose item (no park/reorder) ----"
  note "     seed CX-1 loose @$DAY, then clear container it never had (list-id=) to see if a bare container-clear de-schedules:"
  gurl "things:///add?title=CX-1&when=$DAY"; sleep 2
  CX=$(uuid_of CX-1)
  note "     CX-1 before: $(dumpday 'CX-%' | tr '\n' ' ')"
  gurl "things:///update?id=$CX&auth-token=$TOKEN&list-id="
  note "     CX-1 after list-id= on an already-loose item (expect no-op): $(dumpday 'CX-%' | tr '\n' ' ')"
  note "probeb2 DONE"
  exit 0
fi

# =========================================================== probeb3 (side effects)
# Confirm the wireable park-sort-unpark protocol preserves a movee's REMINDER +
# DEADLINE (schedule-class fields untouched by the container-move legs).
if [ "$CMD" = "probeb3" ]; then
  load_session
  note "################## ARM B side effects — reminder + deadline through the protocol ##################"
  gurl "things:///add?title=CR-1&when=$DAY@09:00&deadline=$DAY"; sleep 2
  R1=$(uuid_of CR-1)
  tjson '[{"type":"project","attributes":{"title":"UP-SCRATCH3"}}]'; sleep 2
  SP=$(gq "SELECT uuid FROM TMTask WHERE title='UP-SCRATCH3' AND type=1")
  gurl "things:///add?title=CR-2&when=$DAY"; sleep 2; R2=$(uuid_of CR-2)
  note "  before: $(dumpday 'CR-%' | tr '\n' ' ')"
  for u in "$R1" "$R2"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$SP"; done
  note "  after park: $(dumpday 'CR-%' | tr '\n' ' ')"
  note "  reorder result: $(reord "project id \"$SP\"" "$R2,$R1")"
  note "  after reorder: $(dumpday 'CR-%' | tr '\n' ' ')"
  for u in "$R1" "$R2"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id="; done
  note "  after unpark (rem=603979776 + dl=132805888 on CR-1 SURVIVE? order CR-2<CR-1?): $(dumpday 'CR-%' | tr '\n' ' ')"
  note "probeb3 DONE"
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|probe|teardown" >&2
exit 1
