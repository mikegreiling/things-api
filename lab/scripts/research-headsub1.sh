#!/bin/bash
# HEADSUB1 — can the buckets UNDER a heading be ordered, and is the child-evening
# bounce insertion law provable? Closes the remaining unprobed ordering cells.
# Write-up: docs/lab/headsub1-heading-subbuckets.md.
#
# ONE disposable offline Tart clone `headsub1-lab` (pinned clock 2026-07-05 12:00;
# ordering is local — no cloud account). Fully HEADLESS (URL + AppleScript); no
# Accessibility, no VNC. Subcommands:
#   research-headsub1.sh setup      clone+boot+airgap+clock-pin+seed all four arms
#   research-headsub1.sh armA       container-day reorder vs HEADED same-day children (O06/FK risk)
#   research-headsub1.sh armB       move-to-heading append determinism per bucket class
#   research-headsub1.sh armC       unhead effects + round-trip re-head sort protocol
#   research-headsub1.sh armD       child-evening bounce insertion law
#   research-headsub1.sh teardown   stop + delete the clone
#
# Arms (each verdict stated as an implementable law — see the doc):
#   A  native container-day reorder (project specifier, todayIndex axis) over a mix
#      of HEADED + unheaded same-day children: does it (a) re-rank headed rows'
#      todayIndex date-preservingly, (b) SKIP them, or (c) RIP the heading FK (O06)?
#   B  move a movee of each class (anytime/someday/scheduled/evening) UNDER a heading
#      via the shipped URL leg (update?list-id=<proj>&heading=<title>); landing
#      position within the heading's matching sub-bucket + FULL state preservation.
#   C  unhead a headed child (update?list-id=<proj> no heading param): state kept?
#      index/todayIndex renumbered? Then round-trip: unhead N, sort via native
#      unheaded scope (SOMEORD-b), re-head in target order — final order correct?
#      Plus the SHORT version (skip the middle sort, just re-head in target order).
#   D  a project child flagged this-evening: run the evening bounce legs (when=today
#      away -> when=evening back, BounceSpec `evening`). Deterministic re-entry
#      position (front/back) with container + evening flag (startBucket=1) preserved?
#      Compare a loose evening control (the shipped evening scope front-insert).
#
# Conventions inherited from research-upcord1.sh / research-reordgaps.sh:
#   * offline COW clone, guest airgap (delete default route), clock pinned BEFORE
#     Things launches, read-only guest SQLite.
#   * `with ids` is a COMMA-SEPARATED STRING. The private reorder re-ranks the
#     addressed key ASCENDING in the sent id order (DAYORD-b / HEADORD-d).
#   * headings creatable headlessly only via TJSON new-project-with-heading; to-do
#     items following a heading item in the project's `items` array nest under it;
#     items BEFORE the first heading are unheaded direct children.
#   * NO clock advance anywhere (evening items live on today=2026-07-05; scheduled
#     on 2026-07-10 — both reachable from the pinned date without stepping).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"          # 2026-07-05 12:00 (golden pinnedDate)
DAY="${DAY:-2026-07-10}"            # future Upcoming test day
VM="headsub1-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[headsub1] $*" | tee -a "$REPORT"; }

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
# private reorder command (comma-separated ids string) — the container reorder compile
reord()  { gas "tell application \"Things3\" to _private_experimental_ reorder to dos in $1 with ids \"$2\""; sleep 2; }
# full within-container state for a title glob, ORDERED BY index (heading/anytime/someday axis)
dumpi() { gq "SELECT title||' idx='||\"index\"||' tIdx='||todayIndex||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(substr(startDate,1,10),'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-')||' rem='||COALESCE(reminderTime,'-')||' dl='||COALESCE(deadline,'-') FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY \"index\""; }
# same, ORDERED BY todayIndex (the day/evening axis)
dumpt() { gq "SELECT title||' tIdx='||todayIndex||' idx='||\"index\"||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(substr(startDate,1,10),'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-') FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY todayIndex, \"index\""; }
# heading FK exact hex (byte-for-byte pre/post compare for O06 detection)
fkhex() { gq "SELECT title||' h='||COALESCE(hex(heading),'NULL')||' p='||COALESCE(hex(project),'NULL') FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY title"; }

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (evening day=2026-07-05, scheduled day=$DAY)"
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

  # ---- SEED ----------------------------------------------------------------
  # ARM A: project A-P, heading A-H. Unheaded direct children A-u1/u2 (before the
  # heading) + headed children A-h1/h2/h3 (after it), ALL scheduled the same $DAY.
  note "seed ARM A: project A-P heading A-H; A-u1/u2 unheaded @$DAY; A-h1/h2/h3 headed @$DAY"
  tjson '[{"type":"project","attributes":{"title":"A-P","items":[{"type":"to-do","attributes":{"title":"A-u1","when":"2026-07-10"}},{"type":"to-do","attributes":{"title":"A-u2","when":"2026-07-10"}},{"type":"heading","attributes":{"title":"A-H"}},{"type":"to-do","attributes":{"title":"A-h1","when":"2026-07-10"}},{"type":"to-do","attributes":{"title":"A-h2","when":"2026-07-10"}},{"type":"to-do","attributes":{"title":"A-h3","when":"2026-07-10"}}]}}]'

  # ARM B: project B-P, heading B-H pre-seeded with per-class ANCHORS so a moved
  # item's landing position within the matching sub-bucket is measurable.
  note "seed ARM B: project B-P heading B-H with anytime/someday/scheduled anchors"
  tjson '[{"type":"project","attributes":{"title":"B-P","items":[{"type":"heading","attributes":{"title":"B-H"}},{"type":"to-do","attributes":{"title":"B-anc-a1"}},{"type":"to-do","attributes":{"title":"B-anc-a2"}},{"type":"to-do","attributes":{"title":"B-anc-s1","when":"someday"}},{"type":"to-do","attributes":{"title":"B-anc-s2","when":"someday"}},{"type":"to-do","attributes":{"title":"B-anc-d1","when":"2026-07-10"}},{"type":"to-do","attributes":{"title":"B-anc-d2","when":"2026-07-10"}}]}}]'
  note "seed ARM B movees (loose): 2 per class — anytime/someday/scheduled/evening"
  for t in MV-any1 MV-any2; do gurl "things:///add?title=$t&when=anytime"; done
  for t in MV-some1 MV-some2; do gurl "things:///add?title=$t&when=someday"; done
  for t in MV-sched1 MV-sched2; do gurl "things:///add?title=$t&when=$DAY"; done
  for t in MV-eve1 MV-eve2; do gurl "things:///add?title=$t&when=evening"; done
  # one scheduled movee also carries a reminder + deadline for state-preservation
  gurl "things:///add?title=MV-sched3&when=$DAY@09:00&deadline=$DAY"

  # ARM C: project C-P, heading C-H with someday headed children (SOMEORD-b sorts
  # the unheaded someday block cleanly) + same-day scheduled headed children.
  note "seed ARM C: project C-P heading C-H; C-s1/s2/s3 someday headed; C-d1/d2/d3 scheduled headed @$DAY"
  tjson '[{"type":"project","attributes":{"title":"C-P","items":[{"type":"heading","attributes":{"title":"C-H"}},{"type":"to-do","attributes":{"title":"C-s1","when":"someday"}},{"type":"to-do","attributes":{"title":"C-s2","when":"someday"}},{"type":"to-do","attributes":{"title":"C-s3","when":"someday"}},{"type":"to-do","attributes":{"title":"C-d1","when":"2026-07-10"}},{"type":"to-do","attributes":{"title":"C-d2","when":"2026-07-10"}},{"type":"to-do","attributes":{"title":"C-d3","when":"2026-07-10"}}]}}]'

  # ARM D: project D-P with this-evening children + loose this-evening controls.
  note "seed ARM D: project D-P children D-e1/e2/e3 (evening); loose controls D-le1/le2/le3 (evening)"
  tjson '[{"type":"project","attributes":{"title":"D-P","items":[{"type":"to-do","attributes":{"title":"D-e1","when":"evening"}},{"type":"to-do","attributes":{"title":"D-e2","when":"evening"}},{"type":"to-do","attributes":{"title":"D-e3","when":"evening"}}]}}]'
  for t in D-le1 D-le2 D-le3; do gurl "things:///add?title=$t&when=evening"; done
  sleep 2

  note "--- seed verification ---"
  note "A-P headed children (expect h=<A-H>, start=2, sb=0, sd=$DAY, tIdx set): $(dumpt 'A-h%' | tr '\n' ' ')"
  note "A-P unheaded children (expect h=-, p=<A-P>, start=2, sd=$DAY): $(dumpt 'A-u%' | tr '\n' ' ')"
  note "A-H heading row: $(gq "SELECT title||' type='||type||' uuid='||substr(uuid,1,8) FROM TMTask WHERE title='A-H'")"
  note "B-H anchors: $(dumpi 'B-anc-%' | tr '\n' ' ')"
  note "B movees: $(dumpi 'MV-%' | tr '\n' ' ')"
  note "C-P someday headed (expect h=<C-H>, start=2, sd=-): $(dumpi 'C-s%' | tr '\n' ' ')"
  note "C-P scheduled headed (expect h=<C-H>, start=2, sd=$DAY): $(dumpt 'C-d%' | tr '\n' ' ')"
  note "D-P evening children (expect sb=1, sd=2026-07-05, p=<D-P>): $(dumpt 'D-e%' | tr '\n' ' ')"
  note "D loose evening controls (expect sb=1, sd=2026-07-05, p=-,a=-): $(dumpt 'D-le%' | tr '\n' ' ')"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ==================================================================== ARM A
if [ "$CMD" = "armA" ]; then
  load_session
  note "################## ARM A — container-day reorder vs HEADED same-day children ##################"
  AP=$(gq "SELECT uuid FROM TMTask WHERE title='A-P' AND type=1")
  AH=$(gq "SELECT uuid FROM TMTask WHERE title='A-H' AND type=2")
  U1=$(uuid_of A-u1); U2=$(uuid_of A-u2)
  H1=$(uuid_of A-h1); H2=$(uuid_of A-h2); H3=$(uuid_of A-h3)
  note "  A-P=$AP  A-H=$AH"
  note "  BEFORE (todayIndex order): $(dumpt 'A-%' | tr '\n' ' ')"
  note "  BEFORE FK hex: $(fkhex 'A-h%' | tr '\n' ' ')"
  # Scrambled target mixing headed + unheaded rows so a pass proves array order
  # CONTROLS placement (not a no-op): A-h3, A-u2, A-h1, A-u1, A-h2
  note "  ---- native container-day reorder, project specifier, MIXED wire = A-h3,A-u2,A-h1,A-u1,A-h2 ----"
  note "     result: $(reord "project id \"$AP\"" "$H3,$U2,$H1,$U1,$H2")"
  note "  AFTER (todayIndex order): $(dumpt 'A-%' | tr '\n' ' ')"
  note "  AFTER FK hex: $(fkhex 'A-h%' | tr '\n' ' ')"
  note "  VERDICT-A: (a) headed rows' todayIndex re-ranked to sent order + h= UNCHANGED (byte-identical) + sd=$DAY preserved => headed scheduled day-order DIRECTLY achievable, NO O06. (b) headed tIdx unchanged => SKIP. (c) h= NULL / hex changed / p= flipped to project-root => O06 RIP (file oddity)."
  exit 0
fi

# ==================================================================== ARM B
if [ "$CMD" = "armB" ]; then
  load_session
  note "################## ARM B — move-to-heading append determinism per class ##################"
  BP=$(gq "SELECT uuid FROM TMTask WHERE title='B-P' AND type=1")
  BH=$(gq "SELECT uuid FROM TMTask WHERE title='B-H' AND type=2")
  note "  B-P=$BP  B-H=$BH (heading param takes the TITLE 'B-H')"
  note "  anchors BEFORE: $(dumpi 'B-anc-%' | tr '\n' ' ')"

  move_under() { # $1 uuid — shipped URL leg: update?list-id=<project>&heading=<title>
    gurl "things:///update?id=$1&auth-token=$TOKEN&list-id=$BP&heading=B-H"
  }

  note "  ====== class ANYTIME (control; BOUNCE2-h predicts append/back-insert) ======"
  MA1=$(uuid_of MV-any1); MA2=$(uuid_of MV-any2)
  note "     movees BEFORE: $(dumpi 'MV-any%' | tr '\n' ' ')"
  note "     move MV-any1 under B-H..."; move_under "$MA1"
  note "       after MV-any1: anchors+movee: $(dumpi 'B-anc-a%' | tr '\n' ' ') || $(dumpi 'MV-any1' | tr '\n' ' ')"
  note "     move MV-any2 under B-H..."; move_under "$MA2"
  note "       after MV-any2: $(dumpi 'B-anc-a%' | tr '\n' ' ') || $(dumpi 'MV-any%' | tr '\n' ' ')"
  note "     INTERPRET-anytime: final index order of {B-anc-a1,B-anc-a2,MV-any1,MV-any2}? append(anchors<any1<any2)=back-insert deterministic; state h=<B-H>,p=-,start=1 preserved?"

  note "  ====== class SOMEDAY ======"
  MS1=$(uuid_of MV-some1); MS2=$(uuid_of MV-some2)
  note "     movees BEFORE: $(dumpi 'MV-some%' | tr '\n' ' ')"
  note "     move MV-some1 under B-H..."; move_under "$MS1"
  note "       after: $(dumpi 'B-anc-s%' | tr '\n' ' ') || $(dumpi 'MV-some1' | tr '\n' ' ')"
  note "     move MV-some2 under B-H..."; move_under "$MS2"
  note "       after: $(dumpi 'B-anc-s%' | tr '\n' ' ') || $(dumpi 'MV-some%' | tr '\n' ' ')"
  note "     INTERPRET-someday: final index order incl anchors? start=2 preserved (NOT de-somedayed)? h=<B-H>?"

  note "  ====== class SCHEDULED (same-day @$DAY; day axis = todayIndex) ======"
  MD1=$(uuid_of MV-sched1); MD2=$(uuid_of MV-sched2); MD3=$(uuid_of MV-sched3)
  note "     movees BEFORE: $(dumpt 'MV-sched%' | tr '\n' ' ')"
  note "     anchors BEFORE (tIdx): $(dumpt 'B-anc-d%' | tr '\n' ' ')"
  note "     move MV-sched1 under B-H..."; move_under "$MD1"
  note "       after: $(dumpt 'B-anc-d%' | tr '\n' ' ') || $(dumpt 'MV-sched1' | tr '\n' ' ')"
  note "     move MV-sched2 under B-H..."; move_under "$MD2"
  note "       after: $(dumpt 'B-anc-d%' | tr '\n' ' ') || $(dumpt 'MV-sched%' | tr '\n' ' ')"
  note "     move MV-sched3 (reminder+deadline) under B-H..."; move_under "$MD3"
  note "       after MV-sched3 FULL state (rem=603979776 + dl=132805888 preserved? sd=$DAY? h=<B-H>?): $(dumpi 'MV-sched3' | tr '\n' ' ')"
  note "     INTERPRET-scheduled: landing on todayIndex vs anchors? sd=$DAY preserved (date kept)? h=<B-H>? reminder/deadline intact?"

  note "  ====== class EVENING (representable under a heading?) ======"
  ME1=$(uuid_of MV-eve1); ME2=$(uuid_of MV-eve2)
  note "     movees BEFORE (sb=1, sd=2026-07-05): $(dumpt 'MV-eve%' | tr '\n' ' ')"
  note "     move MV-eve1 under B-H..."; move_under "$ME1"
  note "       after MV-eve1 (sb still 1? sd still today? h=<B-H>? p=-?): $(dumpt 'MV-eve1' | tr '\n' ' ')"
  note "     move MV-eve2 under B-H..."; move_under "$ME2"
  note "       after MV-eve2: $(dumpt 'MV-eve%' | tr '\n' ' ')"
  note "     INTERPRET-evening: does the evening flag (sb=1) SURVIVE a move under a heading? landing position? If sb->0 or sd cleared => evening NOT representable under a heading (de-eveninged)."
  note "  VERDICT-B: per class, is the landing APPEND (deterministic back-insert) => sequential re-heading in target order IS a sort protocol; FRONT or nondeterministic => note. State preservation per class recorded above."
  exit 0
fi

# ==================================================================== ARM C
if [ "$CMD" = "armC" ]; then
  load_session
  note "################## ARM C — unhead effects + round-trip re-head sort ##################"
  CP=$(gq "SELECT uuid FROM TMTask WHERE title='C-P' AND type=1")
  CH=$(gq "SELECT uuid FROM TMTask WHERE title='C-H' AND type=2")
  S1=$(uuid_of C-s1); S2=$(uuid_of C-s2); S3=$(uuid_of C-s3)
  note "  C-P=$CP  C-H=$CH"
  note "  someday headed BEFORE: $(dumpi 'C-s%' | tr '\n' ' ')"

  unhead() { # $1 uuid — shipped --no-heading URL leg: re-assert project, no heading param
    gurl "things:///update?id=$1&auth-token=$TOKEN&list-id=$CP"
  }
  rehead() { # $1 uuid — move back under C-H
    gurl "things:///update?id=$1&auth-token=$TOKEN&list-id=$CP&heading=C-H"
  }

  note "  ---- C.1 unhead ONE (C-s1): state preserved? index/todayIndex renumbered or kept? ----"
  note "     C-s1 FK before: $(fkhex 'C-s1' | tr '\n' ' ')"
  unhead "$S1"
  note "     C-s1 after unhead (expect h=NULL, p=<C-P>, start=2 preserved): $(dumpi 'C-s1' | tr '\n' ' ')"
  note "     C-s1 FK after: $(fkhex 'C-s1' | tr '\n' ' ')"

  note "  ---- C.2 FULL round-trip: unhead s2/s3 too, sort unheaded block via SOMEORD-b, re-head in target order ----"
  unhead "$S2"; unhead "$S3"
  note "     all three unheaded now: $(dumpi 'C-s%' | tr '\n' ' ')"
  # native someday order via the PROJECT specifier (SOMEORD-b, clean) — scrambled target C-s3,C-s1,C-s2
  note "     SOMEORD-b sort (project specifier) target C-s3,C-s1,C-s2: $(reord "project id \"$CP\"" "$S3,$S1,$S2")"
  note "     after unheaded sort: $(dumpi 'C-s%' | tr '\n' ' ')"
  # re-head in the SAME target order; if Arm B append law holds, final in-heading order == target
  note "     re-head in target order C-s3,C-s1,C-s2:"
  rehead "$S3"; rehead "$S1"; rehead "$S2"
  note "     FINAL in-heading order: $(dumpi 'C-s%' | tr '\n' ' ')"
  note "     VERDICT-C(full): final index order == C-s3<C-s1<C-s2 with h=<C-H>, start=2 => unhead->sort->rehead is a wireable within-heading sort protocol."

  note "  ---- C.3 SHORT version (skip middle sort): fresh scheduled headed children, unhead, re-head DIRECTLY in target order ----"
  D1=$(uuid_of C-d1); D2=$(uuid_of C-d2); D3=$(uuid_of C-d3)
  note "     scheduled headed BEFORE: $(dumpt 'C-d%' | tr '\n' ' ')"
  unhead "$D1"; unhead "$D2"; unhead "$D3"
  note "     after unhead (date preserved? still @$DAY? tIdx kept?): $(dumpt 'C-d%' | tr '\n' ' ')"
  note "     re-head DIRECTLY in scrambled target C-d2,C-d3,C-d1 (relies on Arm B append law):"
  rehead "$D2"; rehead "$D3"; rehead "$D1"
  note "     FINAL (index order, in-heading): $(dumpi 'C-d%' | tr '\n' ' ')"
  note "     FINAL (todayIndex order): $(dumpt 'C-d%' | tr '\n' ' ')"
  note "     VERDICT-C(short): if final in-heading order == C-d2<C-d3<C-d1 => the SHORT re-head-in-order IS the sort protocol (no middle sort needed). Note whether headed scheduled children order on index or todayIndex."
  exit 0
fi

# ==================================================================== ARM D
if [ "$CMD" = "armD" ]; then
  load_session
  note "################## ARM D — child-evening bounce insertion law ##################"
  DP=$(gq "SELECT uuid FROM TMTask WHERE title='D-P' AND type=1")
  E1=$(uuid_of D-e1); E2=$(uuid_of D-e2); E3=$(uuid_of D-e3)
  L1=$(uuid_of D-le1); L2=$(uuid_of D-le2); L3=$(uuid_of D-le3)
  note "  D-P=$DP"
  note "  BounceSpec 'evening': away=today, back=evening, direction=front, rankKey=todayIndex, legOp=todo.update"
  note "  evening children BEFORE (todayIndex order): $(dumpt 'D-e%' | tr '\n' ' ')"
  note "  loose evening controls BEFORE: $(dumpt 'D-le%' | tr '\n' ' ')"

  ebounce() { # $1 uuid — the evening bounce legs: away when=today, back when=evening
    gurl "things:///update?id=$1&auth-token=$TOKEN&when=today"
    gurl "things:///update?id=$1&auth-token=$TOKEN&when=evening"
  }

  note "  ---- D.1 bounce ONE project child (D-e2): where does it re-enter? flag + container preserved? ----"
  note "     D-e2 FK before: $(fkhex 'D-e2' | tr '\n' ' ')"
  ebounce "$E2"
  note "     after bounce D-e2 (sb still 1? sd still 2026-07-05? p=<D-P>? tIdx front/back?): $(dumpt 'D-e%' | tr '\n' ' ')"
  note "     D-e2 FK after: $(fkhex 'D-e2' | tr '\n' ' ')"

  note "  ---- D.2 full-block bounce in a target order to derive the direction law ----"
  note "     bounce children FORWARD order D-e1,D-e2,D-e3 (if back-insert => final tIdx == that order; if front-insert => reverse):"
  ebounce "$E1"; note "       after D-e1: $(dumpt 'D-e%' | tr '\n' ' ')"
  ebounce "$E2"; note "       after D-e2: $(dumpt 'D-e%' | tr '\n' ' ')"
  ebounce "$E3"; note "       after D-e3: $(dumpt 'D-e%' | tr '\n' ' ')"
  note "     FINAL children tIdx order: $(dumpt 'D-e%' | tr '\n' ' ')"

  note "  ---- D.3 loose evening control (the shipped evening scope) — same forward bounce ----"
  ebounce "$L1"; ebounce "$L2"; ebounce "$L3"
  note "     FINAL loose control tIdx order: $(dumpt 'D-le%' | tr '\n' ' ')"
  note "  VERDICT-D: child-evening bounce re-enters at a DETERMINISTIC position (front => forward-bounce gives reverse order; back => forward-bounce gives target order) with sb=1 + p=<D-P> + sd=today preserved => the evening scope IS extensible to container children (state the exact leg sequence + direction). Compare children vs loose control: SAME direction => uniform law; DIFFER => container children differ (note)."
  note "  NOTE: watch for R07 (bare when=today/evening clears a reminder) — evening bounce items here carry no reminder, so no loss; flag if a caller's evening item has one."
  exit 0
fi

# ============================================= ARM C confirm (scheduled full round-trip)
# The SHORT re-head-in-order fails for scheduled headed children (C.3: rehead is a
# todayIndex no-op). This confirms the FULL round-trip closes it: unhead -> DAYORD-b
# (project-specifier todayIndex re-rank, date-preserving) -> rehead (todayIndex kept).
if [ "$CMD" = "armC2" ]; then
  load_session
  note "################## ARM C confirm — scheduled headed full round-trip (DAYORD-b middle sort) ##################"
  CP=$(gq "SELECT uuid FROM TMTask WHERE title='C-P' AND type=1")
  D1=$(uuid_of C-d1); D2=$(uuid_of C-d2); D3=$(uuid_of C-d3)
  unhead2() { gurl "things:///update?id=$1&auth-token=$TOKEN&list-id=$CP"; }
  rehead2() { gurl "things:///update?id=$1&auth-token=$TOKEN&list-id=$CP&heading=C-H"; }
  note "  scheduled headed BEFORE (todayIndex): $(dumpt 'C-d%' | tr '\n' ' ')"
  note "  ---- unhead all three ----"
  unhead2 "$D1"; unhead2 "$D2"; unhead2 "$D3"
  note "     after unhead (h=-, p=<C-P>, tIdx+date kept): $(dumpt 'C-d%' | tr '\n' ' ')"
  note "  ---- DAYORD-b middle sort (project specifier), scrambled target C-d2,C-d3,C-d1 ----"
  note "     result: $(reord "project id \"$CP\"" "$D2,$D3,$D1")"
  note "     after sort (todayIndex re-ranked C-d2<C-d3<C-d1? date preserved?): $(dumpt 'C-d%' | tr '\n' ' ')"
  note "  ---- rehead in the same target order ----"
  rehead2 "$D2"; rehead2 "$D3"; rehead2 "$D1"
  note "     FINAL (todayIndex order, in-heading): $(dumpt 'C-d%' | tr '\n' ' ')"
  note "     VERDICT-C2: final todayIndex order == C-d2<C-d3<C-d1 with h=<C-H>, sd preserved => the FULL round-trip (unhead->DAYORD-b->rehead) IS the wireable scheduled within-heading day-order protocol (rehead preserves the sorted todayIndex)."
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|armA|armB|armC|armD|teardown" >&2
exit 1
