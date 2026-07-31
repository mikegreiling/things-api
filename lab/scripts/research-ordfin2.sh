#!/bin/bash
# ORDFIN2 — three-arm ordering follow-up campaign.
# Write-up: docs/lab/ordfin2-followups.md.
#
# ONE disposable offline Tart clone `ordfin2-lab` (pinned clock 2026-07-05 12:00;
# ordering is local — no cloud account). Arms 1/2/3-LATERPROJ are HEADLESS
# (URL scheme + `things:///json` + AppleScript private reorder). Arm 3-AXDRAG3
# needs Accessibility (granted per-clone via the AXVM1 rung-b VNC toggle — $VNCDO)
# for the sidebar AX row read + the duplicate-area drag.
#
# Subcommands:
#   research-ordfin2.sh setup      clone+boot(+vnc)+airgap+clock-pin+warm+seed(all arms)
#   research-ordfin2.sh arm1        PRJMIX — project-row strand in a park-sort-restore
#   research-ordfin2.sh arm1var     PRJMIX variant — projects BELOW the to-dos in value
#   research-ordfin2.sh arm2        TOMORROWLIST — list "Tomorrow" one-call day-sort
#   research-ordfin2.sh arm3lp      LATERPROJ — the Later Projects list membership+reorder
#   research-ordfin2.sh grant       AXVM1 rung-b Accessibility toggle (needs $VNCDO)
#   research-ordfin2.sh arm3ax      AXDRAG3 — duplicate-titled-area tiebreaker (needs grant)
#   research-ordfin2.sh teardown    stop + delete the clone
#
# Conventions inherited from research-ordfin1.sh / research-upcord1.sh:
#   * offline COW clone, guest airgap (delete default route), clock pinned BEFORE
#     Things launches, read-only guest SQLite.
#   * dates SEEDED via URL `when=<ISO>` (the APP packs startDate) — NEVER hand-pack
#     a date integer; preservation asserted by DB read comparison before/after.
#   * `with ids` is a COMMA-SEPARATED STRING; the private reorder re-ranks the
#     addressed key ASCENDING in the sent id order. Wire lists SCRAMBLED so a
#     passing result proves array order CONTROLS placement, not a no-op.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
TODAY="${TODAY:-2026-07-05}"
DAY_PM="${DAY_PM:-2026-07-19}"       # Arm 1 PRJMIX future day (+14d)
DAY_TMR="${DAY_TMR:-2026-07-06}"     # Arm 2 tomorrow
DAY_LP="${DAY_LP:-2026-07-25}"       # Arm 3 later-projects future-scheduled day
VNCDO="${VNCDO:-}"
AA="7Ck4hAXU36jyaBsy2Fkije"          # LAB-AREA-A (seed-manifest)
AB="2piYxp6UzasLDSvkwY747J"          # LAB-AREA-B
VM="ordfin2-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[ordfin2] $*" | tee -a "$REPORT"; }

CMD="${1:-}"

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }
gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
reord()  { gas "tell application \"Things3\" to _private_experimental_ reorder to dos in $1 with ids \"$2\""; sleep 2; }
# full row state for a title glob, ORDERED BY todayIndex then index.
# cols: title type tIdx idx start sd(startDate) cd(creationDate) h(heading8) p(project8) a(area8)
FULLSEL="title||' type='||type||' tIdx='||COALESCE(todayIndex,'-')||' idx='||COALESCE(\"index\",'-')||' start='||start||' sd='||COALESCE(startDate,'-')||' cd='||COALESCE(creationDate,'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-')"
dumpg() { gq "SELECT $FULLSEL FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY todayIndex, \"index\""; }
one()   { gq "SELECT $FULLSEL FROM TMTask WHERE uuid='$1'"; }

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (PM day $DAY_PM, tomorrow $DAY_TMR, LP day $DAY_LP)"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
  note "vnc url: ${VNC_URL:-<none>}"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  { echo "IP=$IP"; echo "VNC_URL=$VNC_URL"; } > "$SESSION"

  note "warm-up: launch/quit/relaunch Things on the pinned date"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"
  note "golden Things version: $(gq "SELECT 'schema '||value FROM Meta LIMIT 1" 2>/dev/null || echo '?')"

  # ---------- baselines: later-projects + tomorrow membership BEFORE seeding ----------
  note "--- baseline: list id later-projects membership (golden) ---"
  note "  $(gq "SELECT $FULLSEL FROM TMTask WHERE type=1 AND trashed=0 AND area IS NULL AND (start=2 OR (start=1 AND startDate IS NOT NULL)) ORDER BY todayIndex, \"index\"" | tr '\n' ' ')"

  # ---------- ARM 1 PRJMIX ----------
  note "seed Arm 1: 3 area-less scheduled PROJECT rows + 4 to-dos (2 loose, 2 in a project) @$DAY_PM"
  tjson '[{"type":"project","attributes":{"title":"PM-CONT"}}]'; sleep 1
  PMCONT=$(gq "SELECT uuid FROM TMTask WHERE title='PM-CONT' AND type=1")
  echo "PMCONT=$PMCONT" >> "$SESSION"
  note "  container PM-CONT=$PMCONT"
  # seed order: projects first, then loose, then project children
  for n in 1 2 3; do gurl "things:///add-project?title=PM-PRJ$n&when=$DAY_PM"; done
  gurl "things:///add?title=PM-L1&when=$DAY_PM"
  gurl "things:///add?title=PM-L2&when=$DAY_PM"
  gurl "things:///add?title=PM-C1&when=$DAY_PM&list-id=$PMCONT"
  gurl "things:///add?title=PM-C2&when=$DAY_PM&list-id=$PMCONT"
  note "  Arm1 day-group (7 rows, projects type=1): "
  dumpg 'PM-%' | tee -a "$REPORT"

  # ---------- ARM 2 TOMORROWLIST ----------
  note "seed Arm 2: 3 to-dos (loose/project/area) + 1 area-less scheduled PROJECT @tomorrow $DAY_TMR"
  tjson '[{"type":"project","attributes":{"title":"TM-CONT"}}]'; sleep 1
  TMCONT=$(gq "SELECT uuid FROM TMTask WHERE title='TM-CONT' AND type=1")
  echo "TMCONT=$TMCONT" >> "$SESSION"
  gurl "things:///add?title=TM-L&when=$DAY_TMR"
  gurl "things:///add?title=TM-C&when=$DAY_TMR&list-id=$TMCONT"
  gurl "things:///add?title=TM-A&when=$DAY_TMR&list-id=$AA"
  gurl "things:///add-project?title=TM-PRJ&when=$DAY_TMR"
  note "  Arm2 tomorrow-group: "
  dumpg 'TM-%' | tee -a "$REPORT"

  # ---------- ARM 3 LATERPROJ ----------
  note "seed Arm 3: area-less SOMEDAY proj, area-less FUTURE-SCHED proj, area'd someday proj, active area-less proj"
  gurl "things:///add-project?title=LP-SOME&when=someday"
  gurl "things:///add-project?title=LP-SCHED&when=$DAY_LP"
  gurl "things:///add-project?title=LP-AREASOME&when=someday&area-id=$AA"
  gurl "things:///add-project?title=LP-ACTIVE"
  sleep 1
  note "  seeded LP-* projects: "
  dumpg 'LP-%' | tee -a "$REPORT"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ==================================================================== arm1 (PRJMIX)
if [ "$CMD" = "arm1" ]; then
  load_session
  note "################## ARM 1 — PRJMIX (project-row strand + value law) ##################"
  P1=$(uuid_of PM-PRJ1 1); P2=$(uuid_of PM-PRJ2 1); P3=$(uuid_of PM-PRJ3 1)
  L1=$(uuid_of PM-L1 0); L2=$(uuid_of PM-L2 0); C1=$(uuid_of PM-C1 0); C2=$(uuid_of PM-C2 0)
  note "  uuids: P1=$P1 P2=$P2 P3=$P3 L1=$L1 L2=$L2 C1=$C1 C2=$C2"
  note "  --- (a) full day-group BEFORE, ordered by todayIndex ---"
  dumpg 'PM-%' | tee -a "$REPORT"
  note "  global day-group todayIndex min: $(gq "SELECT MIN(todayIndex) FROM TMTask WHERE title LIKE 'PM-%' AND trashed=0")"
  note "  parked-4 (to-dos) todayIndex min: $(gq "SELECT MIN(todayIndex) FROM TMTask WHERE title LIKE 'PM-L%' OR title LIKE 'PM-C%'")"
  note "  projects todayIndex values: $(gq "SELECT title||'='||todayIndex FROM TMTask WHERE title LIKE 'PM-PRJ%' ORDER BY todayIndex" | tr '\n' ' ')"

  note "  --- (b) run the raw upcoming-day protocol on the 4 TO-DOS only ---"
  tjson '[{"type":"project","attributes":{"title":"PM-SCRATCH"}}]'; sleep 2
  SP=$(gq "SELECT uuid FROM TMTask WHERE title='PM-SCRATCH' AND type=1")
  note "     scratch=$SP"
  note "     PARK the 4 to-dos into scratch (project rows untouched):"
  for u in "$L1" "$L2" "$C1" "$C2"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$SP"; done
  note "     after park: "; dumpg 'PM-%' | tee -a "$REPORT"
  note "     REORDER scrambled target C2,L1,C1,L2: $(reord "project id \"$SP\"" "$C2,$L1,$C1,$L2")"
  note "     after reorder: "; dumpg 'PM-%' | tee -a "$REPORT"
  note "     RESTORE to-dos to origin (L->loose, C->PM-CONT):"
  gurl "things:///update?id=$L1&auth-token=$TOKEN&list-id="
  gurl "things:///update?id=$L2&auth-token=$TOKEN&list-id="
  gurl "things:///update?id=$C1&auth-token=$TOKEN&list-id=$PMCONT"
  gurl "things:///update?id=$C2&auth-token=$TOKEN&list-id=$PMCONT"
  note "     after restore — FULL day-group ordered by todayIndex (WHERE do the 3 projects land?):"
  dumpg 'PM-%' | tee -a "$REPORT"
  note "     fresh to-do todayIndex values: $(gq "SELECT title||'='||todayIndex FROM TMTask WHERE (title LIKE 'PM-L%' OR title LIKE 'PM-C%') ORDER BY todayIndex" | tr '\n' ' ')"
  note "     project todayIndex values (UNTOUCHED?): $(gq "SELECT title||'='||todayIndex FROM TMTask WHERE title LIKE 'PM-PRJ%' ORDER BY todayIndex" | tr '\n' ' ')"

  note "  --- (c) REPEAT #2 (different target L2,C2,L1,C1) — strand position repeatable? ---"
  for u in "$L1" "$L2" "$C1" "$C2"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$SP"; done
  note "     REORDER L2,C2,L1,C1: $(reord "project id \"$SP\"" "$L2,$C2,$L1,$C1")"
  gurl "things:///update?id=$L1&auth-token=$TOKEN&list-id="
  gurl "things:///update?id=$L2&auth-token=$TOKEN&list-id="
  gurl "things:///update?id=$C1&auth-token=$TOKEN&list-id=$PMCONT"
  gurl "things:///update?id=$C2&auth-token=$TOKEN&list-id=$PMCONT"
  note "     after run#2: "; dumpg 'PM-%' | tee -a "$REPORT"

  note "  --- (c) REPEAT #3 (target C1,C2,L1,L2) ---"
  for u in "$L1" "$L2" "$C1" "$C2"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$SP"; done
  note "     REORDER C1,C2,L1,L2: $(reord "project id \"$SP\"" "$C1,$C2,$L1,$L2")"
  gurl "things:///update?id=$L1&auth-token=$TOKEN&list-id="
  gurl "things:///update?id=$L2&auth-token=$TOKEN&list-id="
  gurl "things:///update?id=$C1&auth-token=$TOKEN&list-id=$PMCONT"
  gurl "things:///update?id=$C2&auth-token=$TOKEN&list-id=$PMCONT"
  note "     after run#3: "; dumpg 'PM-%' | tee -a "$REPORT"
  note "  trash scratch"
  gas "tell application \"Things3\" to delete project id \"$SP\"" >/dev/null 2>&1 || true
  note "  VERDICT-1: is the strand position (projects vs sorted block) REPEATABLE across runs? Are fresh values below scratch-min / global-min / neighbor-spread?"
  exit 0
fi

# ==================================================================== arm1var (projects below)
if [ "$CMD" = "arm1var" ]; then
  load_session
  note "################## ARM 1c variant — projects BELOW to-dos in value ##################"
  note "  Goal: arrange the 3 project rows' todayIndex MORE-negative (sort ABOVE) the 4 to-dos,"
  note "  so global-min == project-min < parked-min, to separate 'below scratch min' from 'below global min'."
  # Re-seed a fresh mixed day on a different day so seed-order puts projects most-negative.
  # Strategy: delete PM-* and re-seed with to-dos FIRST then projects (whichever direction
  # the app assigns most-negative to last-seeded is read from the setup dump; adjust here).
  note "  current PM group todayIndex: $(gq "SELECT title||'='||todayIndex FROM TMTask WHERE title LIKE 'PM-%' ORDER BY todayIndex" | tr '\n' ' ')"
  note "  (this subcommand re-uses the existing PM rows; the RELATIVE order of projects-vs-todos"
  note "   in the current seed already determines whether the disambiguation is available — see report)"
  P1=$(uuid_of PM-PRJ1 1); P2=$(uuid_of PM-PRJ2 1); P3=$(uuid_of PM-PRJ3 1)
  L1=$(uuid_of PM-L1 0); L2=$(uuid_of PM-L2 0); C1=$(uuid_of PM-C1 0); C2=$(uuid_of PM-C2 0)
  # Force projects most-negative by reordering them via the container-day scope among themselves?
  # Projects nest only in areas; park them into a scratch AREA is destructive. Instead: bounce
  # the to-dos to a LESS-negative band by re-dating them off/on the day (front-insert resets).
  # Simplest deterministic separator: re-schedule the 3 projects via a scratch-project park+reorder
  # of a set that includes them is impossible (they are projects). So we instead push the TO-DOS
  # down in value by a same-day re-add cycle. Read-only characterization if not separable.
  note "  attempt: re-schedule each project OFF then ON the day to front-insert (most-negative);"
  note "  3 rounds to drive project-min WELL below the to-do min (bigger than the fresh-offset spread):"
  for round in 1 2 3; do
    for u in "$P1" "$P2" "$P3"; do
      gurl "things:///update-project?id=$u&auth-token=$TOKEN&when=someday"
      gurl "things:///update-project?id=$u&auth-token=$TOKEN&when=$DAY_PM"
    done
    note "   round $round: $(gq "SELECT title||'='||todayIndex FROM TMTask WHERE title LIKE 'PM-PRJ%' ORDER BY todayIndex" | tr '\n' ' ')  toDoMin=$(gq "SELECT MIN(todayIndex) FROM TMTask WHERE title LIKE 'PM-L%' OR title LIKE 'PM-C%'")"
  done
  note "  after project re-front-insert: $(gq "SELECT title||'='||todayIndex FROM TMTask WHERE title LIKE 'PM-%' ORDER BY todayIndex" | tr '\n' ' ')"
  note "  now run the protocol on the 4 to-dos and see if fresh values land below project-min:"
  tjson '[{"type":"project","attributes":{"title":"PM-SCRATCH2"}}]'; sleep 2
  SP=$(gq "SELECT uuid FROM TMTask WHERE title='PM-SCRATCH2' AND type=1")
  for u in "$L1" "$L2" "$C1" "$C2"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$SP"; done
  note "  parked min (to-dos): $(gq "SELECT MIN(todayIndex) FROM TMTask WHERE title LIKE 'PM-L%' OR title LIKE 'PM-C%'")  project min: $(gq "SELECT MIN(todayIndex) FROM TMTask WHERE title LIKE 'PM-PRJ%'")"
  note "  REORDER C2,L1,C1,L2: $(reord "project id \"$SP\"" "$C2,$L1,$C1,$L2")"
  for u in "$L1" "$L2"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id="; done
  for u in "$C1" "$C2"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$PMCONT"; done
  note "  after variant run — full group: "; dumpg 'PM-%' | tee -a "$REPORT"
  note "  fresh to-do values: $(gq "SELECT title||'='||todayIndex FROM TMTask WHERE title LIKE 'PM-L%' OR title LIKE 'PM-C%' ORDER BY todayIndex" | tr '\n' ' ')"
  note "  project values: $(gq "SELECT title||'='||todayIndex FROM TMTask WHERE title LIKE 'PM-PRJ%' ORDER BY todayIndex" | tr '\n' ' ')"
  gas "tell application \"Things3\" to delete project id \"$SP\"" >/dev/null 2>&1 || true
  note "  VERDICT-1c: fresh values below project-min (=> below GLOBAL min) or only below parked-min (=> below SCRATCH min)?"
  exit 0
fi

# ==================================================================== arm2 (TOMORROWLIST)
if [ "$CMD" = "arm2" ]; then
  load_session
  note "################## ARM 2 — TOMORROWLIST (list Tomorrow as a day-sort surface) ##################"
  TL=$(uuid_of TM-L 0); TC=$(uuid_of TM-C 0); TA=$(uuid_of TM-A 0); TP=$(uuid_of TM-PRJ 1)
  note "  uuids: TM-L=$TL TM-C=$TC TM-A=$TA TM-PRJ(type1)=$TP"
  note "  --- (a) tomorrow-group BEFORE ---"
  dumpg 'TM-%' | tee -a "$REPORT"
  note "  --- (b) reorder to dos in list \"Tomorrow\" with scrambled ids incl. the PROJECT uuid ---"
  note "     target order: TM-A, TM-PRJ, TM-L, TM-C"
  note "     result: $(reord 'list "Tomorrow"' "$TA,$TP,$TL,$TC")"
  note "  --- after reorder (todayIndex re-ranked to sent order? startDate PRESERVED? project accepted? start/startBucket side effects?) ---"
  dumpg 'TM-%' | tee -a "$REPORT"
  note "     startBucket check: $(gq "SELECT title||' sb='||COALESCE(startBucket,'-')||' start='||start||' sd='||COALESCE(startDate,'-') FROM TMTask WHERE title LIKE 'TM-%' AND trashed=0 ORDER BY todayIndex" | tr '\n' ' ')"
  note "  --- (c) list id \"tomorrow\" vs list \"Tomorrow\" spelling equivalence (re-rank reverse) ---"
  note "     target order via list id tomorrow: TM-C, TM-L, TM-PRJ, TM-A"
  note "     result: $(reord 'list id "tomorrow"' "$TC,$TL,$TP,$TA")"
  note "     after: "; dumpg 'TM-%' | tee -a "$REPORT"
  note "  VERDICT-2: is Tomorrow a clean one-call day-sort surface (projects included, startDate preserved, no re-date)?"
  exit 0
fi

# ==================================================================== arm3lp (LATERPROJ)
if [ "$CMD" = "arm3lp" ]; then
  load_session
  note "################## ARM 3 — LATERPROJ (the Later Projects list) ##################"
  SOME=$(uuid_of LP-SOME 1); SCHED=$(uuid_of LP-SCHED 1); ASOME=$(uuid_of LP-AREASOME 1); ACTV=$(uuid_of LP-ACTIVE 1)
  note "  uuids: LP-SOME=$SOME LP-SCHED=$SCHED LP-AREASOME=$ASOME LP-ACTIVE=$ACTV"
  note "  --- (a) FULL state of each seeded project ---"
  dumpg 'LP-%' | tee -a "$REPORT"
  note "  --- membership predicate: area-less AND (someday OR future-scheduled) ---"
  note "  area-less someday|scheduled projects (expected Later Projects members): "
  gq "SELECT $FULLSEL FROM TMTask WHERE type=1 AND trashed=0 AND area IS NULL AND (start=2 OR (start=1 AND startDate IS NOT NULL)) ORDER BY todayIndex, \"index\"" | tee -a "$REPORT"
  note "  active area-less projects (expected SIDEBAR rows, NOT in list): $(gq "SELECT title FROM TMTask WHERE type=1 AND trashed=0 AND area IS NULL AND start=1 AND startDate IS NULL ORDER BY \"index\"" | tr '\n' ' ')"
  note "  area'd someday projects (expected in Someday view, NOT Later Projects): $(gq "SELECT title FROM TMTask WHERE type=1 AND trashed=0 AND area IS NOT NULL AND start=2 ORDER BY \"index\"" | tr '\n' ' ')"

  note "  --- (b) reorder someday projects via list id later-projects in ONE forward call (scrambled) ---"
  # Gather ALL area-less someday project uuids (pin full membership); scramble target.
  note "  someday members before: $(gq "SELECT title||' idx='||COALESCE(\"index\",'-')||' tIdx='||COALESCE(todayIndex,'-')||' start='||start FROM TMTask WHERE type=1 AND trashed=0 AND area IS NULL AND start=2 AND startDate IS NULL ORDER BY \"index\"" | tr '\n' ' ')"
  # LP-SOME is the seeded area-less someday project. Add a couple more someday projects to make a re-rankable set.
  gurl "things:///add-project?title=LP-SOME2&when=someday"
  gurl "things:///add-project?title=LP-SOME3&when=someday"; sleep 1
  SOME2=$(uuid_of LP-SOME2 1); SOME3=$(uuid_of LP-SOME3 1)
  note "  someday set now: $(gq "SELECT title||' idx='||COALESCE(\"index\",'-')||' tIdx='||COALESCE(todayIndex,'-') FROM TMTask WHERE type=1 AND trashed=0 AND area IS NULL AND start=2 AND startDate IS NULL ORDER BY \"index\"" | tr '\n' ' ')"
  note "  forward one-call reorder to scrambled target LP-SOME3,LP-SOME,LP-SOME2:"
  note "     result: $(reord 'list id "later-projects"' "$SOME3,$SOME,$SOME2")"
  note "  after (which column moved — index or todayIndex? start=2 preserved? de-someday?):"
  gq "SELECT $FULLSEL FROM TMTask WHERE title LIKE 'LP-SOME%' AND trashed=0 ORDER BY COALESCE(todayIndex,0), \"index\"" | tee -a "$REPORT"

  note "  --- (b2) mixed request INCLUDING the future-scheduled project (accepted? which axis? re-date?) ---"
  note "  LP-SCHED before: $(one "$SCHED")"
  note "     reorder list id later-projects with LP-SCHED,LP-SOME3,LP-SOME2,LP-SOME:"
  note "     result: $(reord 'list id "later-projects"' "$SCHED,$SOME3,$SOME2,$SOME")"
  note "  after mixed: "; dumpg 'LP-%' | tee -a "$REPORT"
  note "  LP-SCHED after (startDate re-dated? axis moved?): $(one "$SCHED")"
  note "  VERDICT-3lp: forward ONE-call container semantics (vs list Someday two-call anchor-stack)? which axis? state preserved?"
  exit 0
fi

# ==================================================================== grant (AXVM1 rung-b)
if [ "$CMD" = "grant" ]; then
  load_session
  [ -n "$VNCDO" ] || { note "VNCDO unset — cannot grant Accessibility"; exit 1; }
  [ -n "${VNC_URL:-}" ] || { note "no VNC_URL in session"; exit 1; }
  note "provoke the disabled Accessibility TCC row (a denied AX op)"
  lab_ssh "$IP" 'open -g -a Things3; sleep 3' </dev/null
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
  note "TCC before: $(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''" 2>&1' </dev/null)"
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
  lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
  V capture "$OUT/screens/g1-ax-pane.png"
  V move 1642 332 click 1; sleep 3; V capture "$OUT/screens/g2-auth.png"
  V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3
  V capture "$OUT/screens/g3-after-auth.png"
  note "TCC after: $(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''" 2>&1' </dev/null)"
  note "re-probe AX op (expect menu list, exit 0): $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' 2>&1; echo "[exit $?]"' </dev/null)"
  exit 0
fi

# ==================================================================== arm3ax (AXDRAG3)
if [ "$CMD" = "arm3ax" ]; then
  load_session
  note "################## ARM 3 — AXDRAG3 (duplicate-titled-area tiebreaker) ##################"
  # ship the AX sidebar tooling
  lab_ssh "$IP" 'cat > /tmp/ax3.js' < lab/scripts/ordfin2-ax3.jxa
  note "  --- (d) seed 3 areas with IDENTICAL title DUPE-AREA (AppleScript make new area) ---"
  for i in 1 2 3; do
    gas "tell application \"Things3\" to make new area with properties {name:\"DUPE-AREA\"}"
    sleep 1
  done
  note "  DB rows (title, uuid, index, creationDate, rowid) in creationDate order:"
  gq "SELECT 'uuid='||uuid||' idx='||COALESCE(\"index\",'-')||' cd='||COALESCE(creationDate,'-')||' rowid='||rowid FROM TMArea WHERE title='DUPE-AREA' ORDER BY creationDate" | tee -a "$REPORT"
  note "  candidate DB orders:"
  note "   creationDate ASC: $(gq "SELECT substr(uuid,1,8) FROM TMArea WHERE title='DUPE-AREA' ORDER BY creationDate" | tr '\n' ' ')"
  note "   uuid ASC:         $(gq "SELECT substr(uuid,1,8) FROM TMArea WHERE title='DUPE-AREA' ORDER BY uuid" | tr '\n' ' ')"
  note "   rowid ASC:        $(gq "SELECT substr(uuid,1,8) FROM TMArea WHERE title='DUPE-AREA' ORDER BY rowid" | tr '\n' ' ')"
  note "   index,uuid:       $(gq "SELECT substr(uuid,1,8) FROM TMArea WHERE title='DUPE-AREA' ORDER BY \"index\", uuid" | tr '\n' ' ')"

  note "  --- read the AX sidebar row order (all sidebar rows w/ title + frame y) ---"
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  lab_ssh "$IP" 'osascript -l JavaScript /tmp/ax3.js dumprows 2>&1' </dev/null | tee "$OUT/ax3-rows-before.json" | tee -a "$REPORT"
  if [ -n "$VNCDO" ] && [ -n "${VNC_URL:-}" ]; then
    HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
    PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
    timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} capture "$OUT/screens/ax3-sidebar.png" 2>>"$OUT/vnc.log" || true
  fi
  note "  MAP the 3 DUPE-AREA AX rows (top->bottom) to DB uuids: which candidate order matches AX order?"
  note "  (analysis in the write-up: compare the DUPE-AREA AX row sequence against the candidate orders above)"

  note "  --- (e) DRAG the 2nd DUPE-AREA row DOWN one slot; re-read AX order + DB index; confirm mapping ---"
  note "  DB index BEFORE drag: $(gq "SELECT substr(uuid,1,8)||'='||COALESCE(\"index\",'-') FROM TMArea WHERE title='DUPE-AREA' ORDER BY \"index\", creationDate" | tr '\n' ' ')"
  lab_ssh "$IP" 'osascript -l JavaScript /tmp/ax3.js dragdupe 2 down 2>&1' </dev/null | tee "$OUT/ax3-drag.json" | tee -a "$REPORT"
  sleep 2
  note "  DB index AFTER drag: $(gq "SELECT substr(uuid,1,8)||'='||COALESCE(\"index\",'-')||' cd='||creationDate FROM TMArea WHERE title='DUPE-AREA' ORDER BY \"index\", creationDate" | tr '\n' ' ')"
  note "  AX order AFTER drag:"
  lab_ssh "$IP" 'osascript -l JavaScript /tmp/ax3.js dumprows 2>&1' </dev/null | tee "$OUT/ax3-rows-after.json" | tee -a "$REPORT"
  note "  VERDICT-3ax: tiebreaker for tied index = which DB order matched AX? Did the intended (2nd) uuid's index move? Is Nth-row<->Nth-DB-row disambiguation sound?"
  exit 0
fi

# ==================================================================== arm3ax2 (tie + real drag)
if [ "$CMD" = "arm3ax2" ]; then
  load_session
  note "################## ARM 3 — AXDRAG3b (force a real index TIE + a genuine drag) ##################"
  lab_ssh "$IP" 'cat > /tmp/ax3.js' < lab/scripts/ordfin2-ax3.jxa
  note "  --- separate make-new-area calls gave DISTINCT indexes; force a TIE via ONE AppleScript batch ---"
  gas 'tell application "Things3"
    repeat with i from 1 to 3
      make new area with properties {name:"TIE-AREA"}
    end repeat
  end tell'
  sleep 2
  note "  TIE-AREA rows (rowid, uuid, index) in rowid order:"
  gq "SELECT 'rowid='||rowid||' uuid='||uuid||' idx='||COALESCE(\"index\",'-') FROM TMArea WHERE title='TIE-AREA' ORDER BY rowid" | tee -a "$REPORT"
  note "  tied at 0? distinct? -> $(gq "SELECT 'distinct_idx_count='||COUNT(DISTINCT \"index\")||' of '||COUNT(*) FROM TMArea WHERE title='TIE-AREA'")"
  note "  candidate orders for TIE-AREA:"
  note "   rowid ASC (creation): $(gq "SELECT substr(uuid,1,8) FROM TMArea WHERE title='TIE-AREA' ORDER BY rowid" | tr '\n' ' ')"
  note "   uuid  ASC:            $(gq "SELECT substr(uuid,1,8) FROM TMArea WHERE title='TIE-AREA' ORDER BY uuid" | tr '\n' ' ')"
  note "   index,rowid:          $(gq "SELECT substr(uuid,1,8) FROM TMArea WHERE title='TIE-AREA' ORDER BY \"index\", rowid" | tr '\n' ' ')"
  note "  --- AX sidebar order (find TIE-AREA row sequence top->bottom) ---"
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  lab_ssh "$IP" 'osascript -l JavaScript /tmp/ax3.js dumprows 2>&1' </dev/null | tee "$OUT/ax3b-rows.json" | tee -a "$REPORT"

  note "  --- (e) GENUINE DRAG: move DUPE-AREA #1 (uuid 6NuTE4zb, distinct idx) to the BOTTOM (below the last dupe) ---"
  note "  full area index BEFORE: $(gq "SELECT title||':'||substr(uuid,1,8)||'='||COALESCE(\"index\",'-') FROM TMArea ORDER BY \"index\", rowid" | tr '\n' ' ')"
  DUPEY_LAST=$(lab_ssh "$IP" 'osascript -l JavaScript -e "ObjC.import(\"Foundation\")" /tmp/ax3.js dumprows 2>/dev/null' </dev/null >/dev/null 2>&1; echo 700)
  note "  drag DUPE-AREA nth=1 to y=700 (below all dupes):"
  lab_ssh "$IP" 'osascript -l JavaScript /tmp/ax3.js dragto DUPE-AREA 1 700 2>&1' </dev/null | tee "$OUT/ax3b-drag.json" | tee -a "$REPORT"
  sleep 2
  note "  full area index AFTER: $(gq "SELECT title||':'||substr(uuid,1,8)||'='||COALESCE(\"index\",'-') FROM TMArea ORDER BY \"index\", rowid" | tr '\n' ' ')"
  note "  which DUPE uuid moved (got a new index)? 6NuTE4zb was the AX-1st dupe & lowest-index dupe:"
  gq "SELECT substr(uuid,1,8)||' idx='||COALESCE(\"index\",'-') FROM TMArea WHERE title='DUPE-AREA' ORDER BY \"index\", rowid" | tee -a "$REPORT"
  note "  --- AX order AFTER drag ---"
  lab_ssh "$IP" 'osascript -l JavaScript /tmp/ax3.js dumprows 2>&1' </dev/null | tee "$OUT/ax3b-rows-after.json" | tee -a "$REPORT"
  note "  VERDICT-3ax2: primary sort = TMArea.index ASC; tie secondary key = uuid or rowid? Did DUPE#1 (6NuTE4zb, AX-1st) move to bottom + get top index? Nth-AX<->Nth-DB-by-index sound?"
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|arm1|arm1var|arm2|arm3lp|grant|arm3ax|teardown" >&2
exit 1
