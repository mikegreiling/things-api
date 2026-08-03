#!/bin/bash
# UPCDL — the deadline-forecast ordering axis + which hidden-list specifier (if any)
# is a blind global-todayIndex writer for same-deadline-day SOMEDAY rows.
# Write-up: docs/lab/upcdl-deadline-axis.md.
#
# The maintainer's question: for SAME-DEADLINE-DAY SOMEDAY rows (deadline-forecast
# rows — a deadline set, NO startDate, someday-bucket members that render in the
# global Upcoming day-block on the deadline date) — is there a GOOD way to coerce
# their todayIndex? Candidate blind writers, in order of naturalness:
#   list "Today"    (UPCDL-2) — the maintainer's first hypothesis
#   list "Tomorrow" (UPCDL-5) — the mid-flight second hypothesis (TOMORROWLIST)
#   list "Upcoming" (UPCDL-6) — the structurally-natural front door (the global-axis view)
#
# ONE disposable offline Tart clone `upcdl-lab` (pinned clock 2026-07-05 12:00;
# ordering is local — no cloud account). All reorder arms are HEADLESS (URL scheme
# + `things:///json` + AppleScript private reorder). Arm 1 (GUI render-order + drag)
# needs Accessibility/VNC — NOT available on this host (no vncdotool); arm 1a is
# gathered headlessly (resting bytes + the encoding-column read off the reorder
# writes, per the REORDGAPS doctrine) and the direct GUI observation is a flagged
# residual.
#
# Subcommands:
#   research-upcdl.sh setup      clone+boot+airgap+clock-pin+warm+seed+canary
#   research-upcdl.sh arm1        UPCDL-1a — resting deadline-forecast bytes
#   research-upcdl.sh arm2        UPCDL-2  — list "Today" membership + collateral
#   research-upcdl.sh arm3        UPCDL-3  — project id specifier: index re-rank, deadline intact
#   research-upcdl.sh arm5        UPCDL-5  — list "Tomorrow" blind-writer hypothesis
#   research-upcdl.sh arm6        UPCDL-6  — list "Upcoming" reorder specifier (+ Anytime/Later enum)
#   research-upcdl.sh arm4        UPCDL-4  — (conditional) characterize a blind clean todayIndex writer
#   research-upcdl.sh pulldb <label>  copy the guest DB to the host for the reader oracle
#   research-upcdl.sh teardown    stop + delete the clone
#
# Conventions inherited from research-ordfin1.sh:
#   * offline COW clone, guest airgap (delete default route), clock pinned BEFORE
#     Things launches, read-only guest SQLite.
#   * dates SEEDED via URL `when=`/`deadline=<ISO>` (the APP packs the ints) —
#     NEVER hand-pack a date integer; preservation asserted by DB read comparison.
#   * `with ids` is a COMMA-SEPARATED STRING; the private reorder re-ranks the
#     addressed key ASCENDING in the sent id order (DAYORD-b). Wire lists SCRAMBLED
#     so a passing result proves array order CONTROLS placement, not a no-op.
#   * NEVER send URL `when=`/schedule-class to a REPEATING template row (§1 CRASH).
#   * sdef CANARY before every private-verb-using arm (safety rail).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
TODAY="${TODAY:-2026-07-05}"         # the pinned Today
TMRW="${TMRW:-2026-07-06}"           # tomorrow (the first upcoming day)
DLDAY="${DLDAY:-2026-07-08}"         # the shared future deadline day (3 days out; NOT tomorrow)
OTHERDAY="${OTHERDAY:-2026-07-09}"   # a second scheduled day for cross-date probes
AA="7Ck4hAXU36jyaBsy2Fkije"          # LAB-AREA-A (seed-manifest)
VM="upcdl-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[upcdl] $*" | tee -a "$REPORT"; }

CMD="${1:-}"

# --------------------------------------------------------------- guest SQLite
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
# private reorder command (comma-separated ids string). Captures the AppleScript
# transport result (an error string vs a clean return distinguishes refuse/skip/apply).
reord()  { gas "tell application \"Things3\" to _private_experimental_ reorder to dos in $1 with ids \"$2\""; sleep 2; }
# FULL byte row for a uuid — every column the campaign cares about.
one() { gq "SELECT title||' tIdx='||todayIndex||' idx='||\"index\"||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(startDate,'-')||' tiRef='||COALESCE(todayIndexReferenceDate,'-')||' rem='||COALESCE(reminderTime,'-')||' dl='||COALESCE(deadline,'-')||' dlSup='||COALESCE(deadlineSuppressionDate,'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-')||' cd='||CAST(creationDate AS INT)||' umd='||CAST(COALESCE(userModificationDate,0) AS INT) FROM TMTask WHERE uuid='$1'"; }

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# FUNCTIONAL canary — the `_private_experimental_ reorder to dos in` verb is
# deliberately ABSENT from the public sdef (it is private), so an sdef grep is
# the wrong check. Instead re-rank a dedicated throwaway pair (CAN-A/CAN-B in P,
# seeded at setup) via the CONTAINER specifier and confirm the transport is NOT
# rejected (-1708 "doesn't understand the message" = verb moved; -1728 = specifier
# class moved). A clean return proves the surface is still live.
canary() {
  [ -n "${P:-}" ] && [ -n "${CANA:-}" ] && [ -n "${CANB:-}" ] || { note "canary: missing P/CANA/CANB — skipping (setup not complete)"; return 0; }
  local r; r=$(reord "project id \"$P\"" "$CANB,$CANA")
  if echo "$r" | grep -qiE "understand|-1708|-1728|-2740"; then
    note "FUNCTIONAL canary FAILED — private reorder verb/specifier moved: [$r]"; return 1
  fi
  note "functional canary OK (private reorder live) [${r:-clean}]"; return 0
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (deadline day $DLDAY, tomorrow $TMRW, other $OTHERDAY, today $TODAY)"
  pkill -f "tart run $VM" >/dev/null 2>&1 || true   # reap any stray run proc holding a VM slot
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || { note "clone FAILED (name still in use?)"; exit 1; }
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

  # ---- Fixture: project P with a heading, someday+deadline children S1/S2/S3 ----
  note "seed project P (with heading P-H)"
  tjson '[{"type":"project","attributes":{"title":"UPCDL-P","items":[{"type":"heading","attributes":{"title":"P-H"}}]}}]'; sleep 2
  P=$(gq "SELECT uuid FROM TMTask WHERE title='UPCDL-P' AND type=1")
  echo "P=$P" >> "$SESSION"
  note "  P=$P"

  # canary pair (two plain anytime rows in P) + functional canary
  note "seed canary pair CAN-A/CAN-B in P, then functional-canary the private reorder verb"
  for t in CAN-A CAN-B; do gurl "things:///add?title=$t&list-id=$P"; sleep 1; done
  CANA=$(uuid_of CAN-A); CANB=$(uuid_of CAN-B)
  { echo "CANA=$CANA"; echo "CANB=$CANB"; } >> "$SESSION"
  canary || { note "CANARY FAILED — aborting setup"; exit 1; }

  # S1,S2,S3 — someday to-dos in P, ALL same deadline, NO startDate (deadline-forecast).
  note "seed S1/S2/S3 — someday+deadline($DLDAY), no startDate, in P"
  for t in S1 S2 S3; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$P"; sleep 1; done
  S1=$(uuid_of S1); S2=$(uuid_of S2); S3=$(uuid_of S3)
  { echo "S1=$S1"; echo "S2=$S2"; echo "S3=$S3"; } >> "$SESSION"

  # Controls:
  # (a) SCHED — a loose SCHEDULED row for the DEADLINE day (startDate=DLDAY).
  note "seed control SCHED — loose scheduled @$DLDAY (startDate set)"
  gurl "things:///add?title=CTL-SCHED&when=$DLDAY"; sleep 1
  SCHED=$(uuid_of CTL-SCHED)
  # (b) ANYDL — an ANYTIME deadline-forecast row (start=1, deadline=DLDAY, no startDate), loose.
  note "seed control ANYDL — loose anytime+deadline($DLDAY), no startDate"
  gurl "things:///add?title=CTL-ANYDL&deadline=$DLDAY"; sleep 1
  ANYDL=$(uuid_of CTL-ANYDL)
  # (c) HDL — a HEADED someday+deadline row under P-H (heading-rip check).
  note "seed control HDL — someday+deadline($DLDAY) headed under P-H"
  gurl "things:///add?title=CTL-HDL&when=someday&deadline=$DLDAY&list-id=$P&heading=P-H"; sleep 1
  HDL=$(uuid_of CTL-HDL)
  # (d) TMRW1/TMRW2 — loose rows genuinely scheduled for TOMORROW (arm 5 members).
  note "seed TMRW1/TMRW2 — loose scheduled @$TMRW (genuine tomorrow members)"
  for t in TMRW1 TMRW2; do gurl "things:///add?title=$t&when=$TMRW"; sleep 1; done
  T1=$(uuid_of TMRW1); T2=$(uuid_of TMRW2)
  # (e) OTH1/OTH2 — loose rows scheduled for OTHERDAY (arm 5c/6b cross-date members).
  note "seed OTH1/OTH2 — loose scheduled @$OTHERDAY (cross-date members)"
  for t in OTH1 OTH2; do gurl "things:///add?title=$t&when=$OTHERDAY"; sleep 1; done
  O1=$(uuid_of OTH1); O2=$(uuid_of OTH2)
  { echo "SCHED=$SCHED"; echo "ANYDL=$ANYDL"; echo "HDL=$HDL"; echo "T1=$T1"; echo "T2=$T2"; echo "O1=$O1"; echo "O2=$O2"; } >> "$SESSION"

  # ---- arm6's OWN independent row set (U-prefixed) so arm5 + arm6 can share ONE clone ----
  note "seed arm6 rows: U1/U2/U3 someday+deadline forecast in P; UO1/UO2 scheduled @$OTHERDAY; UT1 scheduled @$TMRW; UHDL headed someday+deadline"
  for t in U1 U2 U3; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$P"; sleep 1; done
  U1=$(uuid_of U1); U2=$(uuid_of U2); U3=$(uuid_of U3)
  for t in UO1 UO2; do gurl "things:///add?title=$t&when=$OTHERDAY"; sleep 1; done
  UO1=$(uuid_of UO1); UO2=$(uuid_of UO2)
  gurl "things:///add?title=UT1&when=$TMRW"; sleep 1; UT1=$(uuid_of UT1)
  gurl "things:///add?title=UHDL&when=someday&deadline=$DLDAY&list-id=$P&heading=P-H"; sleep 1; UHDL=$(uuid_of UHDL)
  { echo "U1=$U1"; echo "U2=$U2"; echo "U3=$U3"; echo "UO1=$UO1"; echo "UO2=$UO2"; echo "UT1=$UT1"; echo "UHDL=$UHDL"; } >> "$SESSION"

  note "--- fixture bytes ---"
  for v in S1 S2 S3 SCHED ANYDL HDL T1 T2 O1 O2 U1 U2 U3 UO1 UO2 UT1 UHDL; do
    eval "u=\$$v"; note "  $v: $(one "$u")"
  done
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ==================================================================== arm1 (resting law)
if [ "$CMD" = "arm1" ]; then
  load_session
  note "################## ARM 1a — deadline-forecast resting bytes ##################"
  note "  S1: $(one "$S1")"
  note "  S2: $(one "$S2")"
  note "  S3: $(one "$S3")"
  note "  --- candidate sort bytes across S1/S2/S3 (all share deadline=$DLDAY): ---"
  note "  todayIndex: $(gq "SELECT group_concat(title||':'||todayIndex,' ') FROM TMTask WHERE title IN ('S1','S2','S3') AND trashed=0")"
  note "  index:      $(gq "SELECT group_concat(title||':'||\"index\",' ') FROM TMTask WHERE title IN ('S1','S2','S3') AND trashed=0")"
  note "  creation:   $(gq "SELECT group_concat(title||':'||CAST(creationDate AS INT),' ') FROM TMTask WHERE title IN ('S1','S2','S3') AND trashed=0")"
  note "  deadline:   $(gq "SELECT group_concat(title||':'||deadline,' ') FROM TMTask WHERE title IN ('S1','S2','S3') AND trashed=0")"
  note "  tiRef:      $(gq "SELECT group_concat(title||':'||COALESCE(todayIndexReferenceDate,'NULL'),' ') FROM TMTask WHERE title IN ('S1','S2','S3') AND trashed=0")"
  note "  start/sb/sd: $(gq "SELECT group_concat(title||':'||start||'/'||COALESCE(startBucket,'-')||'/'||COALESCE(startDate,'-'),' ') FROM TMTask WHERE title IN ('S1','S2','S3') AND trashed=0")"
  note "VERDICT-1a: which byte(s) DISTINGUISH the same-deadline forecast rows? (expect: todayIndex all EQUAL [0], index DISTINCT by creation, deadline EQUAL). If todayIndex is a constant tie, GUI render order can ONLY track index/creationDate — unless a todayIndex writer imposes distinct values."
  note "RESIDUAL: authoritative GUI render-order + drag-feasibility needs Accessibility/VNC (no vncdotool on this host) — flagged, not run."
  exit 0
fi

# ==================================================================== arm2 (list "Today")
if [ "$CMD" = "arm2" ]; then
  load_session; canary || exit 1
  note '################## ARM 2 — list "Today" membership + collateral ##################'
  note "  Today membership BEFORE: $(gas 'tell application "Things3" to get id of to dos of list "Today"')"
  note "  --- 2a: reorder to dos in list \"Today\" with ids <S3,S1,S2> (NO id is a Today member) ---"
  for v in S1 S2 S3; do eval "u=\$$v"; note "    $v before: $(one "$u")"; done
  note "  reorder result: [$(reord 'list "Today"' "$S3,$S1,$S2")]"
  for v in S1 S2 S3; do eval "u=\$$v"; note "    $v AFTER:  $(one "$u")"; done
  note "  VERDICT-2a: (i) error/skip [zero delta], (ii) blind CLEAN todayIndex write [only todayIndex; start/sd/dl INTACT], or (iii) DESTRUCTIVE materialize [start 2->1 and/or startDate stamped]?"

  note "  --- 2b: MIXED wire — one genuine Today member + the someday set ---"
  gurl "things:///add?title=TODAYMBR&when=today"; sleep 1
  TM=$(uuid_of TODAYMBR); echo "TM=$TM" >> "$SESSION"
  note "    TODAYMBR before: $(one "$TM")"
  note "    reorder ids <TODAYMBR,S3,S1>: [$(reord 'list "Today"' "$TM,$S3,$S1")]"
  note "    TODAYMBR after: $(one "$TM")"
  note "    S3 after: $(one "$S3")"
  note "    S1 after: $(one "$S1")"
  note "    VERDICT-2b: does a genuine member change treatment of non-members? skipped-while-member-reranks, or all coerced?"

  note "  --- 2c: HEADED control — CTL-HDL (headed someday+deadline) in a Today reorder (rip check) ---"
  note "    CTL-HDL before: $(one "$HDL")"
  note "    reorder ids <CTL-HDL,S2>: [$(reord 'list "Today"' "$HDL,$S2")]"
  note "    CTL-HDL after: $(one "$HDL")"
  note "    VERDICT-2c: heading FK survive (h=) or ripped to NULL on this specifier?"
  exit 0
fi

# ==================================================================== arm3 (project specifier)
if [ "$CMD" = "arm3" ]; then
  load_session; canary || exit 1
  note "################## ARM 3 — project id specifier on the same-deadline someday wire ##################"
  note "  (fresh reads — arm2 may have mutated S1/S2/S3; this certifies the CLEAN index lever regardless)"
  for v in S1 S2 S3; do eval "u=\$$v"; note "    $v before: $(one "$u")"; done
  note "  reorder to dos in project id P with ids <S3,S1,S2>: [$(reord "project id \"$P\"" "$S3,$S1,$S2")]"
  for v in S1 S2 S3; do eval "u=\$$v"; note "    $v after:  $(one "$u")"; done
  note "  VERDICT-3: rewrote INDEX to sent order (S3<S1<S2) while start/startDate/deadline/tiRef UNTOUCHED? (SOMEORD-b extended to deadline-carrying someday rows — 'the app infers the axis' = index for a no-startDate row)"
  exit 0
fi

# ==================================================================== arm5 (list "Tomorrow")
if [ "$CMD" = "arm5" ]; then
  load_session; canary || exit 1
  note '################## ARM 5 — list "Tomorrow" blind-writer hypothesis ##################'
  note "  Tomorrow membership BEFORE: $(gas 'tell application "Things3" to get id of to dos of list "Tomorrow"')"
  note "  --- 5a: someday deadline-forecast rows whose deadline ($DLDAY) is NOT tomorrow ---"
  for v in S1 S2 S3; do eval "u=\$$v"; note "    $v before: $(one "$u")"; done
  note "  reorder to dos in list \"Tomorrow\" ids <S3,S1,S2>: [$(reord 'list "Tomorrow"' "$S3,$S1,$S2")]"
  for v in S1 S2 S3; do eval "u=\$$v"; note "    $v after:  $(one "$u")"; done
  note "  VERDICT-5a: refused/skipped/blind-clean/blind-dirty for non-tomorrow deadline-forecast rows?"

  note "  --- 5c: rows SCHEDULED for OTHER dates ($OTHERDAY) — re-rank date-preserving (DAYORD-b) or re-DATE to tomorrow (destructive)? ---"
  for v in O1 O2; do eval "u=\$$v"; note "    $v before: $(one "$u")"; done
  note "  reorder to dos in list \"Tomorrow\" ids <OTH2,OTH1>: [$(reord 'list "Tomorrow"' "$O2,$O1")]"
  for v in O1 O2; do eval "u=\$$v"; note "    $v after:  $(one "$u")"; done
  note "  VERDICT-5c: startDate PRESERVED ($OTHERDAY) or OVERWRITTEN to $TMRW (symmetric hazard to Today-stamping)?"

  note "  --- 5b/5d: MIXED wire — genuine tomorrow members (TMRW1/2) + non-members (S1, OTH1) ---"
  for v in T1 T2 S1 O1; do eval "u=\$$v"; note "    $v before: $(one "$u")"; done
  note "  reorder to dos in list \"Tomorrow\" ids <TMRW2,S1,TMRW1,OTH1>: [$(reord 'list "Tomorrow"' "$T2,$S1,$T1,$O1")]"
  for v in T1 T2 S1 O1; do eval "u=\$$v"; note "    $v after:  $(one "$u")"; done
  note "  VERDICT-5bd: do the genuine tomorrow members re-rank cleanly while non-members are skipped/coerced/re-dated? (does deadline-membership count for 5b?)"

  note "  --- 5e: HEADED control (rip check on this specifier for a non-member headed row) ---"
  note "    CTL-HDL before: $(one "$HDL")"
  note "    reorder to dos in list \"Tomorrow\" ids <CTL-HDL,TMRW1>: [$(reord 'list "Tomorrow"' "$HDL,$T1")]"
  note "    CTL-HDL after: $(one "$HDL")"
  note "    VERDICT-5e: heading FK preserved (TOMORROWHEAD extends to non-members) or ripped?"
  exit 0
fi

# ==================================================================== arm6 (list "Upcoming" + enum)
# Uses the INDEPENDENT U-prefixed row set so it can share ONE clone with arm5.
if [ "$CMD" = "arm6" ]; then
  load_session; canary || exit 1
  note '################## ARM 6 — list "Upcoming" reorder specifier (U-row set) ##################'
  note "  --- 6a: same-day scheduled rows UO1/UO2 @$OTHERDAY (re-rank todayIndex date-preserving, one call?) ---"
  for v in UO1 UO2; do eval "u=\$$v"; note "    $v before: $(one "$u")"; done
  note "  reorder to dos in list \"Upcoming\" ids <UO2,UO1> (same day): [$(reord 'list "Upcoming"' "$UO2,$UO1")]"
  for v in UO1 UO2; do eval "u=\$$v"; note "    $v after:  $(one "$u")"; done
  note "  VERDICT-6a: todayIndex re-ranked to sent order? startDate ($OTHERDAY) PRESERVED (contrast §9g re-date-to-first-upcoming-day)?"

  note "  --- 6b: CROSS-date scheduled wire (UT1 @$TMRW + UO1 @$OTHERDAY) — interleave across days, refuse, or re-date? ---"
  for v in UT1 UO1; do eval "u=\$$v"; note "    $v before: $(one "$u")"; done
  note "  reorder to dos in list \"Upcoming\" ids <UO1,UT1> (cross-date): [$(reord 'list "Upcoming"' "$UO1,$UT1")]"
  for v in UT1 UO1; do eval "u=\$$v"; note "    $v after:  $(one "$u")"; done
  note "  VERDICT-6b: cross-date — dates preserved+re-ranked, refused, or re-dated (§9g)?"

  note "  --- 6c: the someday deadline-forecast wire U1/U2/U3 (the campaign core) ---"
  for v in U1 U2 U3; do eval "u=\$$v"; note "    $v before: $(one "$u")"; done
  note "  reorder to dos in list \"Upcoming\" ids <U3,U1,U2>: [$(reord 'list "Upcoming"' "$U3,$U1,$U2")]"
  for v in U1 U2 U3; do eval "u=\$$v"; note "    $v after:  $(one "$u")"; done
  note "  VERDICT-6c: accepted? clean todayIndex write, or §9g re-date (startDate stamped), or de-someday?"

  note "  --- 6e: HEADED rip-check (UHDL) ---"
  note "    UHDL before: $(one "$UHDL")"
  note "    reorder to dos in list \"Upcoming\" ids <UHDL,UO1>: [$(reord 'list "Upcoming"' "$UHDL,$UO1")]"
  note "    UHDL after: $(one "$UHDL")"

  note "  --- 6f: Today member in the wire (O03-class collateral) ---"
  gurl "things:///add?title=UPTODAY&when=today"; sleep 1
  UPT=$(uuid_of UPTODAY); echo "UPT=$UPT" >> "$SESSION"
  note "    UPTODAY before: $(one "$UPT")"
  note "    reorder to dos in list \"Upcoming\" ids <UPTODAY,UO1>: [$(reord 'list "Upcoming"' "$UPT,$UO1")]"
  note "    UPTODAY after: $(one "$UPT")"
  note "    VERDICT-6f: does it disturb a Today flag (start/startBucket/startDate) — the O03-class collateral?"

  note "  --- enum completeness (ONE line each, no full matrix): do these resolve as reorder specifiers? ---"
  note "    list \"Anytime\" ids <U1>: [$(reord 'list "Anytime"' "$U1")]"
  note "    list \"Later Projects\" ids <P>: [$(reord 'list "Later Projects"' "$P")]"
  exit 0
fi

# ==================================================================== arm7 (two-step restore protocol)
# The maintainer's follow-up: does a `list "..."` todayIndex re-rank SURVIVE a
# fast-follow restore of the original `when` (someday), or does assigning a new
# `when` CLOBBER todayIndex? Also directly measure the when=-vs-todayIndex law.
# Self-seeds fresh R/Q rows so it can run on a pristine clone right after setup.
if [ "$CMD" = "arm7" ]; then
  load_session; canary || exit 1
  note "################## ARM 7 — two-step reorder→restore protocol + when=/todayIndex clobber law ##################"
  note "  seed R1/R2/R3 + Q1/Q2 — someday+deadline($DLDAY) forecast rows in P"
  for t in R1 R2 R3 Q1 Q2; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$P"; sleep 1; done
  R1=$(uuid_of R1); R2=$(uuid_of R2); R3=$(uuid_of R3); Q1=$(uuid_of Q1); Q2=$(uuid_of Q2)

  note "  --- 7-CLOBBER: does assigning a new when= change todayIndex? (the crux sub-question) ---"
  note "    Q1 before: $(one "$Q1")"
  note "    Q1 apply when=someday (same bucket, idempotent):"
  gurl "things:///update?id=$Q1&auth-token=$TOKEN&when=someday"
  note "    Q1 after when=someday: $(one "$Q1")"
  note "    Q2 before: $(one "$Q2")"
  note "    Q2 apply when=$OTHERDAY (schedule it):"
  gurl "things:///update?id=$Q2&auth-token=$TOKEN&when=$OTHERDAY"
  note "    Q2 after when=$OTHERDAY: $(one "$Q2")"
  note "    Q2 apply when=someday (restore):"
  gurl "things:///update?id=$Q2&auth-token=$TOKEN&when=someday"
  note "    Q2 after when=someday: $(one "$Q2")"
  note "    VERDICT-7clobber: does when=someday PRESERVE or RESET todayIndex? does when=<date> FRONT-INSERT (clobber) it?"

  note "  --- 7a: TWO-STEP via list \"Tomorrow\" (start=2-preserving reorder), then restore when=someday ---"
  for v in R1 R2 R3; do eval "u=\$$v"; note "    $v resting: $(one "$u")"; done
  note "    STEP 1 — reorder list \"Tomorrow\" ids <R3,R1,R2> (sets todayIndex order + re-dates to tomorrow): [$(reord 'list "Tomorrow"' "$R3,$R1,$R2")]"
  for v in R1 R2 R3; do eval "u=\$$v"; note "    $v after step1: $(one "$u")"; done
  note "    STEP 2 — restore when=someday on each (R3,R1,R2 — clears startDate back to the forecast state):"
  for u in "$R3" "$R1" "$R2"; do gurl "things:///update?id=$u&auth-token=$TOKEN&when=someday"; done
  for v in R1 R2 R3; do eval "u=\$$v"; note "    $v after restore: $(one "$u")"; done
  note "    VERDICT-7a: after restore — is startDate NULL + start=2 + deadline=$DLDAY (back in the 07-08 forecast block)? and is the STEP-1 todayIndex ORDER (R3<R1<R2) PRESERVED, or clobbered back to a tie/creation order?"
  exit 0
fi

# ==================================================================== arm7b (clean someday<->anytime forecast bounce)
# The clean candidate: bounce each deadline-forecast row someday->anytime->someday
# (BOTH forecast states — the row NEVER leaves its 07-08 block, never re-dates,
# never materializes to Today), dispatched in REVERSE target order, and check the
# final todayIndex order == target with deadline/forecast state fully preserved.
if [ "$CMD" = "arm7b" ]; then
  load_session; canary || exit 1
  note "################## ARM 7b — clean someday<->anytime forecast bounce (reverse-order front-insert on todayIndex) ##################"
  note "  seed W1/W2/W3 — someday+deadline($DLDAY) forecast rows in P"
  for t in W1 W2 W3; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$P"; sleep 1; done
  W1=$(uuid_of W1); W2=$(uuid_of W2); W3=$(uuid_of W3)
  for v in W1 W2 W3; do eval "u=\$$v"; note "    $v resting: $(one "$u")"; done
  note "  TARGET order W2 < W1 < W3 (scrambled vs creation). Reverse-target dispatch = W3, W1, W2 (front-insert => last dispatched lands most-negative => first)."
  note "  --- each row: when=anytime (leg A) then when=someday (leg B), dispatched in REVERSE target order W3,W1,W2 ---"
  for u in "$W3" "$W1" "$W2"; do
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=anytime"
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=someday"
  done
  for v in W1 W2 W3; do eval "u=\$$v"; note "    $v after bounce: $(one "$u")"; done
  note "  todayIndex order now: $(gq "SELECT group_concat(title||':'||todayIndex, ' ') FROM (SELECT title, todayIndex FROM TMTask WHERE title IN ('W1','W2','W3') AND trashed=0 ORDER BY todayIndex)")"
  note "  VERDICT-7b: is final ascending todayIndex order == TARGET (W2<W1<W3)? and did EVERY row stay a forecast member (start=2, startDate NULL, deadline=$DLDAY, tiRef=$DLDAY-int) — no re-date, no materialize, no de-someday?"
  note "  NOTE: this is the shipped someday reverse-order bounce (SOMEBACK/SOMEBNC) — the question is whether it rewrites the FORECAST rows' todayIndex (the Upcoming-block axis), not just the someday-view index."
  exit 0
fi

# ==================================================================== arm4 (conditional)
if [ "$CMD" = "arm4" ]; then
  load_session; canary || exit 1
  SPEC="${2:-list \"Today\"}"
  note "################## ARM 4 — characterize the blind todayIndex writer: $SPEC ##################"
  note "  (run only if a specifier showed a blind CLEAN todayIndex write with no de-someday/re-date collateral)"
  note "  seed F1/F2/F3 — fresh someday+deadline rows (no prior todayIndex)"
  for t in F1 F2 F3; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$P"; sleep 1; done
  F1=$(uuid_of F1); F2=$(uuid_of F2); F3=$(uuid_of F3)
  for v in F1 F2 F3; do eval "u=\$$v"; note "    $v before: $(one "$u")"; done
  note "  reorder to dos in $SPEC ids <F2,F3,F1>: [$(reord "$SPEC" "$F2,$F3,$F1")]"
  for v in F1 F2 F3; do eval "u=\$$v"; note "    $v after:  $(one "$u")"; done
  note "  VERDICT-4: insertion law for ids with no prior todayIndex; clean protocol (universal todayIndex writer)? undo shape (umd bumps above)?"
  exit 0
fi

# ==================================================================== pulldb
if [ "$CMD" = "pulldb" ]; then
  load_session
  LABEL="${2:-snapshot}"; DST="$OUT/db-$LABEL.sqlite"
  note "pulling guest DB -> $DST"
  RP=$(lab_ssh "$IP" 'echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite' </dev/null)
  lab_scp "$IP:$RP" "$DST"
  note "  pulled $(ls -la "$DST" | awk '{print $5}') bytes"
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|arm1|arm2|arm3|arm5|arm6|arm7|arm4 [spec]|pulldb <label>|teardown" >&2
exit 1
