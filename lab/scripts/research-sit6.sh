#!/bin/bash
# SITTING 6 — flag-safe index-axis MOVE protocols: PROJSTAR / HEADMOVE / LOOSEPARK / PROJPARK.
#
# THEME (Mike-driven 2026-07-31): the index-axis reorder protocols for heading
# children and loose anytime rows are when=-BOUNCE-only, and their when= legs
# OVERWRITE the Today/Evening flag (the de-Today hazard). MOVE legs (list-id
# re-parenting) are the flag-SAFE family — proven to preserve start/startDate/
# startBucket/reminder/deadline everywhere probed (P9f, HEADSUB1/2, UPCORD1).
# Each arm characterizes ONE unknown insertion/preservation law that would make
# a move-based protocol wireable — replacing the de-Today bounce.
#
#   ARM 0 PROJSTAR   hazard confirm (FIRST): flag an area-less anytime PROJECT
#                    Today, then run the shipped sidebar `projects` bounce legs
#                    (when=someday -> when=anytime). Does the star survive?
#                    Expected NO -> a LIVE de-star hazard in the shipped path.
#   ARM 1 HEADMOVE   heading anytime children: unhead (list-id=P) then re-head
#                    (list-id=P&heading=H). index-axis insertion law + star
#                    preservation; is `heading` scope wireable as a MOVE
#                    round-trip for flag-carrying movees?
#   ARM 2 LOOSEPARK  loose area-less anytime rows: park into a scratch PROJECT,
#                    native project reorder, UNPARK (empty list-id). CENTRAL law:
#                    does unpark PRESERVE the in-scratch index order or re-insert
#                    deterministically? + the unpark-order SHORTCUT + the AREA
#                    scratch variant.
#   ARM 3 PROJPARK   area-less anytime PROJECTS: park into a scratch AREA (move
#                    to area), native O14 area-specifier project reorder, detach
#                    (empty area-id). Same questions; flag-safe alt to the
#                    `projects` bounce?
#
# ONE offline COW clone `sit6-lab`, clock pinned to the golden's 2026-07-05 12:00.
# ALL ARMS HEADLESS (URL scheme + AppleScript private reorder) — no Accessibility,
# no VNC. Raw before/after DB reads for every touched row, every leg. `encodePacked
# Date` discipline — ISO dates to the URL scheme, the app encodes; raw values read
# back. Synthetic seeds only (S6-* prefix) — public repo.
# Write-up: docs/lab/sit6-flagsafe-index-protocols.md.
#
#   research-sit6.sh setup     clone+boot+airgap+clock-pin+warm-up+token
#   research-sit6.sh arm0      PROJSTAR de-star hazard confirm
#   research-sit6.sh arm1      HEADMOVE heading anytime children unhead/re-head
#   research-sit6.sh arm2      LOOSEPARK project-scratch park/reorder/unpark
#   research-sit6.sh arm2d     LOOSEPARK unpark-order shortcut
#   research-sit6.sh arm2e     LOOSEPARK area-scratch variant
#   research-sit6.sh arm3      PROJPARK area-scratch park/reorder/detach for projects
#   research-sit6.sh teardown  stop + delete the clone
#
# Conventions inherited from research-sit5.sh:
#   * offline COW clone, guest airgap (delete default route), clock pinned BEFORE
#     Things launches, read-only guest SQLite.
#   * NEVER send URL when=/schedule-class to a REPEATING template row (§1 CRASH).
#   * NO clock advance anywhere.
#   TODAY = 2026-07-05 (pinned); DL = 2026-07-10 (a deadline date, never a when=).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
DL="${DL:-2026-07-10}"               # a deadline date (NOT a schedule when=)
VM="sit6-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[sit6] $*" | tee -a "$REPORT"; }

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

# FULL raw row for a title glob. The brief's required columns: uuid,type,start,
# startDate,startBucket,todayIndex,index,heading,project,area,reminderTime — plus
# deadline,status,trashed for context. Ordered by index then todayIndex.
dumprow() { gq "SELECT title
  ||' uuid='||substr(uuid,1,8)
  ||' ty='||type
  ||' st='||start
  ||' sd='||COALESCE(startDate,'-')
  ||' sb='||COALESCE(startBucket,'-')
  ||' tIdx='||COALESCE(todayIndex,'-')
  ||' idx='||\"index\"
  ||' hd='||COALESCE(substr(heading,1,8),'-')
  ||' p='||COALESCE(substr(project,1,8),'-')
  ||' a='||COALESCE(substr(area,1,8),'-')
  ||' rem='||COALESCE(reminderTime,'-')
  ||' dl='||COALESCE(deadline,'-')
  ||' status='||status
  ||' tr='||trashed
  FROM TMTask WHERE title LIKE '$1' AND trashed IN (0,1) ORDER BY \"index\", todayIndex"; }
# compact index-order line for quick order reads (the anytime/heading axis)
idxord() { gq "SELECT title||'('||\"index\"||')' FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY \"index\""; }

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (TODAY=pinned 2026-07-05, DL=$DL)"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
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
  note "guest date: $(lab_ssh "$IP" 'date' </dev/null)"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ==================================================================== ARM 0 PROJSTAR
if [ "$CMD" = "arm0" ]; then
  load_session
  note "############################################################"
  note "########## ARM 0 — PROJSTAR (de-star hazard confirm) ##########"
  note "############################################################"
  note "seed: area-less ANYTIME project P0, then flag Today (update-project?when=today)"
  gurl "things:///add-project?title=S6-P0"
  sleep 1
  P0=$(uuid_of S6-P0 1)
  note "  P0=$P0 raw BEFORE flag: $(dumprow 'S6-P0' | tr '\n' ' ')"
  gurl "things:///update-project?id=$P0&auth-token=$TOKEN&when=today"
  note "  P0 raw AFTER when=today (star set? start=1,sd=today,tIdx set?): $(dumprow 'S6-P0' | tr '\n' ' ')"

  note "===== run the SHIPPED sidebar 'projects' bounce legs on the STARRED project ====="
  note "  leg 1: update-project?when=someday"
  gurl "things:///update-project?id=$P0&auth-token=$TOKEN&when=someday"
  note "    after when=someday: $(dumprow 'S6-P0' | tr '\n' ' ')"
  note "  leg 2: update-project?when=anytime"
  gurl "things:///update-project?id=$P0&auth-token=$TOKEN&when=anytime"
  note "    after when=anytime: $(dumprow 'S6-P0' | tr '\n' ' ')"
  note "  VERDICT-0: did start/startDate (the Today star) SURVIVE the projects bounce? Expected NO (de-Today) => LIVE silent-de-star hazard in the shipped 'project move' path for a Today/Evening-flagged area-less project."
  exit 0
fi

# ==================================================================== ARM 1 HEADMOVE
if [ "$CMD" = "arm1" ]; then
  load_session
  note "############################################################"
  note "########## ARM 1 — HEADMOVE (heading anytime children) ##########"
  note "############################################################"
  note "seed: project S6-P1 carrying heading H1 (headings are create-time-only in an existing project; seed via things:///json HX0 pattern)"
  CJSON='[{"type":"project","attributes":{"title":"S6-P1","items":[{"type":"heading","attributes":{"title":"H1"}}]}}]'
  ENC=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1],safe=\"\"))' $(printf '%q' "$CJSON")" </dev/null)
  gurl "things:///json?auth-token=$TOKEN&data=$ENC"
  sleep 2
  P1=$(uuid_of S6-P1 1)
  H1=$(gq "SELECT uuid FROM TMTask WHERE title='H1' AND type=2 AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
  note "  P1=$P1 H1(heading)=$H1"

  note "seed 3 anytime children UNDER H1 (forward order c1,c2,c3; c2 STARRED Today+09:00 reminder+deadline $DL)"
  gurl "things:///add?title=S6-c1&list-id=$P1&heading=H1"
  gurl "things:///add?title=S6-c2&list-id=$P1&heading=H1&when=today@09:00&deadline=$DL"
  gurl "things:///add?title=S6-c3&list-id=$P1&heading=H1"
  note "seed 2 unheaded root anytime children (r1,r2)"
  gurl "things:///add?title=S6-r1&list-id=$P1"
  gurl "things:///add?title=S6-r2&list-id=$P1"
  sleep 2
  C1=$(uuid_of S6-c1); C2=$(uuid_of S6-c2); C3=$(uuid_of S6-c3); R1=$(uuid_of S6-r1); R2=$(uuid_of S6-r2)
  note "  uuids c1=$C1 c2=$C2(starred) c3=$C3 r1=$R1 r2=$R2"
  note "--- seeded roster (raw) ---"
  dumprow 'S6-c_' | tee -a "$REPORT"
  dumprow 'S6-r_' | tee -a "$REPORT"

  note "===== (a) UNHEAD each headed child (update?list-id=P1, no heading param) — index preserved? star preserved? ====="
  for u in "$C1" "$C2" "$C3"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    note "  before unhead $t: $(dumprow "$t" | tr '\n' ' ')"
    gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$P1"
    note "  after  unhead $t (hd->NULL? idx kept? star st/sd/tIdx/rem/dl kept?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  index order of the now-unheaded block: $(idxord 'S6-c_' | tr '\n' ' ')"

  note "===== (b) RE-HEAD each in FORWARD target order c3,c1,c2 (update?list-id=P1&heading=H1) — insertion law on the ANYTIME axis? star preserved? ====="
  for u in "$C3" "$C1" "$C2"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$P1&heading=H1"
    note "  re-head $t (hd=H1? idx=back-insert? star kept?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  in-heading index order after forward re-head c3,c1,c2: $(idxord 'S6-c_' | tr '\n' ' ')"
  note "  INTERPRET b: does forward re-head order = final index order (deterministic back-insert on index)? is c2's star (sd/tIdx/rem/dl) intact?"

  note "===== (c) FULL round-trip to a SCRAMBLED target c2,c3,c1 (unhead all, re-head in target order) — exact? repeat once ====="
  for pass in 1 2; do
    note "  --- pass $pass: target c2,c3,c1 ---"
    for u in "$C1" "$C2" "$C3"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$P1"; done
    note "    unheaded: $(idxord 'S6-c_' | tr '\n' ' ')"
    for u in "$C2" "$C3" "$C1"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$P1&heading=H1"; done
    note "    pass $pass final index order (want c2<c3<c1): $(idxord 'S6-c_' | tr '\n' ' ')"
    note "    pass $pass c2 star check: $(dumprow 'S6-c2' | tr '\n' ' ')"
  done
  note "  VERDICT-1: is the \`heading\` scope wireable as the flag-safe MOVE round-trip (unhead list-id=P -> re-head list-id=P&heading=H in forward target order) for flag-carrying movees, replacing the de-Today someday->anytime bounce?"
  exit 0
fi

# ==================================================================== ARM 2 LOOSEPARK
if [ "$CMD" = "arm2" ]; then
  load_session
  note "############################################################"
  note "########## ARM 2 — LOOSEPARK (loose area-less anytime) ##########"
  note "############################################################"
  note "seed: 4 loose anytime to-dos L1..L4 (L2 STARRED Today+09:00 reminder+deadline $DL); scratch project SCR; area SCRA"
  gurl "things:///add?title=S6-L1"
  gurl "things:///add?title=S6-L2&when=today@09:00&deadline=$DL"
  gurl "things:///add?title=S6-L3"
  gurl "things:///add?title=S6-L4"
  gurl "things:///add-project?title=S6-SCR"
  gas "tell application \"Things3\" to make new area with properties {name:\"S6-SCRA\"}"
  sleep 2
  L1=$(uuid_of S6-L1); L2=$(uuid_of S6-L2); L3=$(uuid_of S6-L3); L4=$(uuid_of S6-L4)
  SCR=$(uuid_of S6-SCR 1); SCRA=$(areaid S6-SCRA)
  note "  uuids L1=$L1 L2=$L2(starred) L3=$L3 L4=$L4 SCR(proj)=$SCR SCRA(area)=$SCRA"
  note "--- seeded loose roster (raw, index-ordered) ---"
  dumprow 'S6-L_' | tee -a "$REPORT"

  note "===== (a) PARK each into scratch PROJECT (update?list-id=SCR) — index preserved/back-inserted? star kept? ====="
  for u in "$L1" "$L2" "$L3" "$L4"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$SCR"
    note "  parked $t (project=SCR? idx? star st/sd/tIdx/rem/dl?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  in-scratch index order after park: $(idxord 'S6-L_' | tr '\n' ' ')"

  note "===== (b) in-scratch native PROJECT reorder to target L3,L1,L4,L2 (flag-safe check on starred L2) ====="
  gas "tell application \"Things3\" to _private_experimental_ reorder to dos in project id \"$SCR\" with ids \"$L3,$L1,$L4,$L2\""
  sleep 2
  note "  after native reorder (index re-ranked to L3<L1<L4<L2? L2 star intact?):"
  dumprow 'S6-L_' | tee -a "$REPORT"
  note "  in-scratch index order: $(idxord 'S6-L_' | tr '\n' ' ')"

  note "===== (c) UNPARK each (update?list-id= empty) — CENTRAL law: does unpark PRESERVE the in-scratch index order or re-insert deterministically? star kept? ====="
  # Unpark in the SAME target order L3,L1,L4,L2 to see whether unpark preserves in-scratch index or re-bases on unpark order.
  for u in "$L3" "$L1" "$L4" "$L2"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&list-id="
    note "  unparked $t (project->NULL? idx? star kept?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  FINAL loose index order after unpark (want L3<L1<L4<L2 if unpark preserves in-scratch index): $(idxord 'S6-L_' | tr '\n' ' ')"
  note "  INTERPRET c: does the loose order == the in-scratch reorder target (index PRESERVED across unpark) OR is it re-based on unpark dispatch order (deterministic re-insert)?"
  exit 0
fi

# ==================================================================== ARM 2d LOOSEPARK shortcut
if [ "$CMD" = "arm2d" ]; then
  load_session
  note "########## ARM 2d — LOOSEPARK unpark-order SHORTCUT (park all, unpark in REVERSE target order, NO in-scratch reorder) ##########"
  note "ARM 2 proved UNPARK FRONT-INSERTS at the loose min in dispatch order (net order = reverse of dispatch). So the wireable shortcut is: park all, then unpark in REVERSE target order — no in-scratch reorder needed."
  note "seed fresh 4 loose ANYTIME M1..M4 (when=anytime; M2 starred Today+09:00 reminder+deadline); reuse scratch project S6-SCR"
  gurl "things:///add?title=S6-M1&when=anytime"
  gurl "things:///add?title=S6-M2&when=today@09:00&deadline=$DL"
  gurl "things:///add?title=S6-M3&when=anytime"
  gurl "things:///add?title=S6-M4&when=anytime"
  sleep 2
  M1=$(uuid_of S6-M1); M2=$(uuid_of S6-M2); M3=$(uuid_of S6-M3); M4=$(uuid_of S6-M4)
  SCR=$(uuid_of S6-SCR 1)
  note "  uuids M1=$M1 M2=$M2(starred) M3=$M3 M4=$M4 SCR=$SCR"
  note "  seed roster (all st=1 loose anytime; M2 st=1 sd=today): $(dumprow 'S6-M_' | tr '\n' ' ')"
  note "  PARK all into SCR (dispatch order M1,M2,M3,M4) — star-preserving?"
  for u in "$M1" "$M2" "$M3" "$M4"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$SCR"; done
  note "  parked roster: $(dumprow 'S6-M_' | tr '\n' ' ')"
  note "  in-scratch index order after park: $(idxord 'S6-M_' | tr '\n' ' ')"
  note "  TARGET final loose order (top->bottom): M3,M1,M4,M2  => UNPARK in REVERSE target order M2,M4,M1,M3 (front-insert law)"
  for u in "$M2" "$M4" "$M1" "$M3"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&list-id="
    note "    unparked $t: $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  FINAL loose order (want M3<M1<M4<M2): $(idxord 'S6-M_' | tr '\n' ' ')"
  note "  M2 star check: $(dumprow 'S6-M2' | tr '\n' ' ')"
  note "  VERDICT-2d: does park-all + unpark-in-REVERSE-target-order (no in-scratch reorder) land the exact target, star-preserving? => the wireable flag-safe loose-anytime MOVE protocol (a flag-safe analog of the de-Today ANYBNC/anytime bounce)."
  exit 0
fi

# ==================================================================== ARM 2e LOOSEPARK area variant
if [ "$CMD" = "arm2e" ]; then
  load_session
  note "########## ARM 2e — LOOSEPARK AREA-scratch variant (anytime rows; §9f says anytime reorders clean) ##########"
  note "seed fresh 4 loose ANYTIME N1..N4 (when=anytime; N2 starred Today+09:00 reminder+deadline); reuse scratch area S6-SCRA"
  gurl "things:///add?title=S6-N1&when=anytime"
  gurl "things:///add?title=S6-N2&when=today@09:00&deadline=$DL"
  gurl "things:///add?title=S6-N3&when=anytime"
  gurl "things:///add?title=S6-N4&when=anytime"
  sleep 2
  N1=$(uuid_of S6-N1); N2=$(uuid_of S6-N2); N3=$(uuid_of S6-N3); N4=$(uuid_of S6-N4)
  SCRA=$(areaid S6-SCRA)
  note "  uuids N1=$N1 N2=$N2(starred) N3=$N3 N4=$N4 SCRA=$SCRA"
  note "  seed roster: $(dumprow 'S6-N_' | tr '\n' ' ')"
  note "  PARK each into scratch AREA (update?list-id=SCRA) — idx? star kept? (§9f applies to someday/dated; ANYTIME expected clean)"
  for u in "$N1" "$N2" "$N3" "$N4"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$SCRA"
    note "    parked $t (area=SCRA? idx? star kept?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  native AREA reorder to target N3,N1,N4,N2 (does it de-schedule the starred N2 per §9f, or is anytime clean?)"
  gas "tell application \"Things3\" to _private_experimental_ reorder to dos in area id \"$SCRA\" with ids \"$N3,$N1,$N4,$N2\""
  sleep 2
  note "    after area reorder: $(dumprow 'S6-N_' | tr '\n' ' ')"
  note "    index order: $(idxord 'S6-N_' | tr '\n' ' ')"
  note "  N2 star check after area reorder (did §9f de-schedule the Today-flagged member? sd still today?): $(dumprow 'S6-N2' | tr '\n' ' ')"
  note "  DETACH each (update?list-id= empty) in REVERSE target order N2,N4,N1,N3 (front-insert law) to land N3,N1,N4,N2 — order? star kept?"
  for u in "$N2" "$N4" "$N1" "$N3"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&list-id="
    note "    detached $t: $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  FINAL loose order (want N3<N1<N4<N2): $(idxord 'S6-N_' | tr '\n' ' ')"
  note "  VERDICT-2e: is the AREA-scratch variant flag-safe for loose ANYTIME rows? The anytime siblings reorder clean (§9f shipped area scope), but the STARRED N2 is a non-anytime (dated) member — did the area reorder de-schedule it (§9f/UPCORD1)? If so, AREA-scratch is NOT flag-safe; only PROJECT-scratch is."
  exit 0
fi

# ==================================================================== ARM 3 PROJPARK
if [ "$CMD" = "arm3" ]; then
  load_session
  note "############################################################"
  note "########## ARM 3 — PROJPARK (area-less anytime PROJECTS) ##########"
  note "############################################################"
  note "seed: 3 area-less anytime projects PP1..PP3 (PP2 STARRED Today via update-project?when=today); scratch area S6-PARK"
  gurl "things:///add-project?title=S6-PP1"
  gurl "things:///add-project?title=S6-PP2"
  gurl "things:///add-project?title=S6-PP3"
  gas "tell application \"Things3\" to make new area with properties {name:\"S6-PARK\"}"
  sleep 2
  PP1=$(uuid_of S6-PP1 1); PP2=$(uuid_of S6-PP2 1); PP3=$(uuid_of S6-PP3 1); PARK=$(areaid S6-PARK)
  note "  uuids PP1=$PP1 PP2=$PP2(->starred) PP3=$PP3 PARK(area)=$PARK"
  gurl "things:///update-project?id=$PP2&auth-token=$TOKEN&when=today"
  note "  PP2 flagged Today: $(dumprow 'S6-PP2' | tr '\n' ' ')"
  note "--- seeded project roster (raw, index-ordered) ---"
  dumprow 'S6-PP_' | tee -a "$REPORT"

  note "===== (a) PARK each project into scratch AREA (update-project?id=<p>&area-id=PARK) — index? star kept? ====="
  for u in "$PP1" "$PP2" "$PP3"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update-project?id=$u&auth-token=$TOKEN&area-id=$PARK"
    note "  parked $t (area=PARK? idx? star st/sd/tIdx kept?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  in-area index order after park: $(idxord 'S6-PP_' | tr '\n' ' ')"

  note "===== (b) native O14 AREA-specifier PROJECT reorder to target PP3,PP1,PP2 (flag-safe on starred PP2?) ====="
  gas "tell application \"Things3\" to _private_experimental_ reorder to dos in area id \"$PARK\" with ids \"$PP3,$PP1,$PP2\""
  sleep 2
  note "  after O14 reorder (index re-ranked PP3<PP1<PP2? PP2 star intact?):"
  dumprow 'S6-PP_' | tee -a "$REPORT"
  note "  index order: $(idxord 'S6-PP_' | tr '\n' ' ')"

  note "===== (c) DETACH each (update-project?area-id= empty) — index order preserved? star kept? exact target? ====="
  for u in "$PP3" "$PP1" "$PP2"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update-project?id=$u&auth-token=$TOKEN&area-id="
    note "  detached $t (area->NULL? idx? star kept?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  FINAL area-less project index order (want PP3<PP1<PP2): $(idxord 'S6-PP_' | tr '\n' ' ')"
  note "  VERDICT-3: is the area-scratch park-sort-detach a flag-safe alternative to the de-Today \`projects\` bounce for area-less projects (esp. the starred PP2)?"
  exit 0
fi

# ==================================================================== ARM 3b PROJPARK land-target
if [ "$CMD" = "arm3b" ]; then
  load_session
  note "########## ARM 3b — PROJPARK land-target (re-park + detach in REVERSE target order) ##########"
  note "ARM 3 proved project DETACH FRONT-INSERTS (net order = reverse of dispatch), star-preserving. So detach in REVERSE target order lands the target."
  PP1=$(uuid_of S6-PP1 1); PP2=$(uuid_of S6-PP2 1); PP3=$(uuid_of S6-PP3 1); PARK=$(areaid S6-PARK)
  note "  uuids PP1=$PP1 PP2=$PP2(starred) PP3=$PP3 PARK=$PARK"
  note "  re-PARK all into scratch AREA (dispatch PP1,PP2,PP3)"
  for u in "$PP1" "$PP2" "$PP3"; do gurl "things:///update-project?id=$u&auth-token=$TOKEN&area-id=$PARK"; done
  note "  parked index order: $(idxord 'S6-PP_' | tr '\n' ' ')"
  note "  TARGET area-less order: PP3,PP1,PP2  => DETACH in REVERSE target order PP2,PP1,PP3"
  for u in "$PP2" "$PP1" "$PP3"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update-project?id=$u&auth-token=$TOKEN&area-id="
    note "    detached $t: $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  FINAL area-less project index order (want PP3<PP1<PP2): $(idxord 'S6-PP_' | tr '\n' ' ')"
  note "  PP2 star check: $(dumprow 'S6-PP2' | tr '\n' ' ')"
  note "  VERDICT-3: park-all-into-scratch-area + detach-in-REVERSE-target-order lands the exact target, star-preserving => the flag-safe MOVE alternative to the de-Today \`projects\` bounce for area-less projects."
  exit 0
fi

# ==================================================================== AREADEL micro-arm
if [ "$CMD" = "areadel" ]; then
  load_session
  note "############################################################"
  note "########## AREADEL micro-arm — contained PROJECT fate on area delete ##########"
  note "############################################################"
  note "A25/A25B: area delete HARD-deletes the area row + trashed=1 on contained TO-DOS. UNPROBED: fate of a contained PROJECT (+ its child)."
  note "seed: area S6-DELA with one DIRECT to-do (DT), one project DELP (with one child DPC inside DELP)"
  gas "tell application \"Things3\" to make new area with properties {name:\"S6-DELA\"}"
  sleep 1
  DELA=$(areaid S6-DELA)
  note "  area S6-DELA uuid=$DELA"
  gurl "things:///add?title=S6-DT&list=S6-DELA"
  gurl "things:///add-project?title=S6-DELP&area=S6-DELA"
  sleep 1
  DELP=$(uuid_of S6-DELP 1)
  gurl "things:///add?title=S6-DPC&list-id=$DELP"
  sleep 2
  DT=$(uuid_of S6-DT); DPC=$(uuid_of S6-DPC)
  note "  uuids DELA(area)=$DELA DT(direct todo)=$DT DELP(project)=$DELP DPC(project child)=$DPC"
  note "--- BEFORE delete (raw) ---"
  dumprow 'S6-DT' | tee -a "$REPORT"
  dumprow 'S6-DELP' | tee -a "$REPORT"
  dumprow 'S6-DPC' | tee -a "$REPORT"
  note "  area row present? $(gq "SELECT 'yes uuid='||substr(uuid,1,8) FROM TMArea WHERE uuid='$DELA'")"

  note "===== DELETE the area (AppleScript 'delete area id <uuid>' — the shipped spelling) ====="
  note "  Things3 pid alive before: $(lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null)"
  gas "tell application \"Things3\" to delete area id \"$DELA\""
  sleep 3
  note "  Things3 pid alive after: $(lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null)"

  note "--- AFTER delete (raw; trashed IN (0,1)) ---"
  note "  area row now? $(gq "SELECT COUNT(*)||' rows in TMArea for this uuid (0 = HARD-deleted)' FROM TMArea WHERE uuid='$DELA'")"
  note "  DT   (direct to-do — A25B reconfirm, expect trashed=1): $(dumprow 'S6-DT' | tr '\n' ' ')"
  note "  DELP (project — trashed=1? hard-deleted? area FK cleared/orphaned?): $(dumprow 'S6-DELP' | tr '\n' ' ')"
  note "  DPC  (project child — trashed? or via-parent derivation like the shallow project-delete A24B?): $(dumprow 'S6-DPC' | tr '\n' ' ')"
  note "  RAW existence check (in case a row was HARD-deleted, trashed filter would hide it):"
  gq "SELECT 'DELP exists='||COUNT(*) FROM TMTask WHERE uuid='$DELP'" | tee -a "$REPORT"
  gq "SELECT 'DPC exists='||COUNT(*) FROM TMTask WHERE uuid='$DPC'" | tee -a "$REPORT"
  gq "SELECT 'DT exists='||COUNT(*) FROM TMTask WHERE uuid='$DT'" | tee -a "$REPORT"
  note "  DELP raw flags: $(gq "SELECT 'tr='||trashed||' status='||status||' area='||COALESCE(substr(area,1,8),'NULL')||' project='||COALESCE(substr(project,1,8),'NULL') FROM TMTask WHERE uuid='$DELP'")"
  note "  DPC  raw flags: $(gq "SELECT 'tr='||trashed||' status='||status||' project='||COALESCE(substr(project,1,8),'NULL') FROM TMTask WHERE uuid='$DPC'")"
  note "  VERDICT-AREADEL: contained PROJECT fate (trashed vs hard-deleted vs orphaned), child fate (direct-trashed vs via-parent derivation A24B), DT A25B reconfirm => PROJPARK teardown-risk profile + the host-side emptiness-guard refusal copy."
  exit 0
fi

# ==================================================================== AREADEL2 reconciliation (empty vs child-bearing project)
if [ "$CMD" = "areadel2" ]; then
  load_session
  note "############################################################"
  note "########## AREADEL2 — reconcile P20 (orphan) vs AREADEL (trashed): empty project vs child-bearing ##########"
  note "############################################################"
  note "P20 claimed area-delete leaves projects as live area=NULL orphans; AREADEL found trashed=1. Test BOTH an EMPTY project and a CHILD-BEARING project in ONE area."
  gas "tell application \"Things3\" to make new area with properties {name:\"S6-DELA2\"}"
  sleep 1
  DELA=$(areaid S6-DELA2)
  note "  area S6-DELA2 uuid=$DELA"
  gurl "things:///add-project?title=S6-EMPTYP&area=S6-DELA2"        # empty project (no children)
  gurl "things:///add-project?title=S6-CHILDP&area=S6-DELA2"        # project with a child
  sleep 1
  EMPTYP=$(uuid_of S6-EMPTYP 1); CHILDP=$(uuid_of S6-CHILDP 1)
  gurl "things:///add?title=S6-CPC&list-id=$CHILDP"
  sleep 2
  CPC=$(uuid_of S6-CPC)
  note "  uuids EMPTYP=$EMPTYP CHILDP=$CHILDP CPC=$CPC"
  note "--- BEFORE ---"
  dumprow 'S6-EMPTYP' | tee -a "$REPORT"
  dumprow 'S6-CHILDP' | tee -a "$REPORT"
  dumprow 'S6-CPC' | tee -a "$REPORT"
  note "  DELETE area S6-DELA2"
  gas "tell application \"Things3\" to delete area id \"$DELA\""
  sleep 3
  note "--- AFTER ---"
  note "  area row now (0=hard-deleted): $(gq "SELECT COUNT(*) FROM TMArea WHERE uuid='$DELA'")"
  note "  EMPTYP (empty project) flags: $(gq "SELECT 'exists='||COUNT(*) FROM TMTask WHERE uuid='$EMPTYP'") | $(gq "SELECT 'tr='||trashed||' status='||status||' area='||COALESCE(substr(area,1,8),'NULL') FROM TMTask WHERE uuid='$EMPTYP'")"
  note "  CHILDP (child-bearing) flags: $(gq "SELECT 'exists='||COUNT(*) FROM TMTask WHERE uuid='$CHILDP'") | $(gq "SELECT 'tr='||trashed||' status='||status||' area='||COALESCE(substr(area,1,8),'NULL') FROM TMTask WHERE uuid='$CHILDP'")"
  note "  CPC    (child) flags: $(gq "SELECT 'tr='||trashed||' project='||COALESCE(substr(project,1,8),'NULL') FROM TMTask WHERE uuid='$CPC'")"
  note "  VERDICT-AREADEL2: does emptiness change the project fate (P20 orphan vs AREADEL trash)? Both trashed => P20 is superseded (app-version/behavior change); split => the child-presence is the discriminator."
  exit 0
fi

# ==================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|arm0|arm1|arm2|arm2d|arm2e|arm3|arm3b|areadel|teardown" >&2
exit 1
