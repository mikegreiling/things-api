#!/bin/bash
# BOUNCE2 — the Phase A.1 bounce-protocol evidence campaign, ONE offline Tart
# clone (`bounce2-lab`, pinned clock; ordering is local, no cloud account).
# Full write-up + verdict tables: docs/lab/reordgaps-results.md (BOUNCE2/SOMEBNC
# sections). Extends REORDGAPS — resolves the HEADORD-c multi-item anomaly, the
# someday re-entry gap (§9f without the destructive area specifier), and banks
# the cap-calibration timing Mike's `bounce-max-items` default (30) will cite.
#
# Subcommand-driven so the session survives host-side iteration; ONE disposable
# clone lives across phases (explicit teardown). ALL arms are HEADLESS (URL /
# AppleScript) — no Accessibility grant, no VNC, no e2e bundle needed.
#
#   research-bounce2.sh setup       clone+boot+airgap+clock-pin+seed
#   research-bounce2.sh headless     BOUNCE2-h · SOMEBNC · BOUNCE2-t · DAYORD-o
#   research-bounce2.sh teardown     stop + delete the clone
#
# The four probes (see the task brief / probe-backlog §C BOUNCE2):
#   BOUNCE2-h  the HEADORD-c anomaly: multi-item WITHIN-HEADING bounce ORDERING.
#              Seed a heading with 5 anytime children; reverse-order someday->
#              anytime round-trips; map the exact landing law (front-insert to
#              heading-bucket top? global min interleave? per-leg timing?).
#              2/3/5-item permutations until deterministic or proven not.
#   SOMEBNC    someday re-entry position within a container (AREA + PROJECT
#              members): toggle someday->anytime->someday via when= writes (NOT
#              container moves); map re-entry index; if deterministic derive the
#              reverse-order protocol + verify full state preservation.
#   BOUNCE2-t  cap calibration: wall-clock per bounced item at 10/20/30 items
#              (idle clone, timing per leg incl. verify) — evidence for the
#              configurable `bounce-max-items` (default 30) help/dry-run copy.
#   DAYORD-o   reproduce the DAYORD-b date-preserving same-day todayIndex reorder
#              (the new o-suite O17 row) — container specifier on same-day
#              scheduled children rewrites todayIndex, preserves startDate.
#
# Conventions inherited from research-reordgaps.sh / research-p8.sh:
#   * offline COW clone, guest-side airgap (delete default route, both families),
#     clock pinned to the golden's 2026-07-05T12:00 BEFORE Things launches, RO DB.
#   * the `with ids` parameter is a COMMA-SEPARATED STRING, not an AS list.
#   * headings are only creatable headlessly via TJSON new-project-with-heading;
#     to-do items following a heading item in the project's `items` nest under it.
#   * the when= bounce is `things:///update?id=<uuid>&auth-token=<tok>&when=<w>`.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"          # 2026-07-05 12:00 (golden pinnedDate)
VM="bounce2-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[bounce2] $*" | tee -a "$REPORT"; }

CMD="${1:-}"

# --------------------------------------------------------------- guest SQLite
GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

# guest-side bounce-a-pool timer (BOUNCE2-t): bounce each uuid someday->anytime
# with a DB-poll between legs; print per-item + total elapsed in ms. Runs ENTIRELY
# guest-local (one ssh call for the whole pool) so timing excludes host<->guest
# SSH round-trips — representative of the on-device op (URL open + app settle +
# verify poll), which is what the production bounce does.
BPOOL='#!/bin/bash
TOKEN="$1"; shift
poll() { local q="$1" i; for i in $(seq 1 100); do [ -n "$(/tmp/gsql.sh -q "$q")" ] && return 0; sleep 0.05; done; return 1; }
nowms() { python3 -c "import time; print(int(time.time()*1000))"; }
T0=$(nowms)
for ID in "$@"; do
  a=$(nowms)
  open -g "things:///update?id=$ID&auth-token=$TOKEN&when=someday"
  poll "SELECT 1 FROM TMTask WHERE uuid=\"$ID\" AND start=2"
  open -g "things:///update?id=$ID&auth-token=$TOKEN&when=anytime"
  poll "SELECT 1 FROM TMTask WHERE uuid=\"$ID\" AND start=1 AND startDate IS NULL"
  b=$(nowms)
  echo "  item $ID: $((b-a)) ms"
done
T1=$(nowms)
N=$#
echo "TOTAL $N items: $((T1-T0)) ms ($(( (T1-T0)/N )) ms/item)"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

# per-session helpers (need $IP)
gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gsql(){ lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
areaid() { gq "SELECT uuid FROM TMArea WHERE title='$1'"; }
reord()  { gas "tell application \"Things3\" to _private_experimental_ reorder to dos in $1 with ids \"$2\""; sleep 2; }
# full within-container state dump for a title glob (ordered by index):
# index/todayIndex/start/startDate/heading/project/area/reminder/deadline
dumpstate() { gq "SELECT title||' idx='||\"index\"||' tIdx='||todayIndex||' start='||start||' sd='||COALESCE(substr(startDate,1,10),'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-')||' rem='||COALESCE(reminderTime,'-')||' dl='||COALESCE(substr(deadline,1,10),'-') FROM TMTask WHERE title LIKE '$1' ORDER BY \"index\""; }
# ordered TITLE list (index ascending) — the visible order within a bucket
ordtitles() { gq "SELECT group_concat(title,'<') FROM (SELECT title FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY \"index\")"; }
globalmin() { gq "SELECT MIN(\"index\") FROM TMTask WHERE trashed=0"; }
groupmin()  { gq "SELECT MIN(\"index\") FROM TMTask WHERE title LIKE '$1' AND trashed=0"; }
# bounce one uuid someday->anytime (host-driven, with settle) — the primitive
bounce() { gurl "things:///update?id=$1&auth-token=$TOKEN&when=someday"; gurl "things:///update?id=$1&auth-token=$TOKEN&when=anytime"; }
# bounce one uuid someday-round-trip STAYING someday: anytime->someday->(implicit)
# SOMEBNC toggle: the item is someday; bounce it out to anytime then back to someday.
bounce_someday() { gurl "things:///update?id=$1&auth-token=$TOKEN&when=anytime"; gurl "things:///update?id=$1&auth-token=$TOKEN&when=someday"; }

# TJSON new-project(-with-heading)(-and-children). $1=json payload
tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  lab_ssh "$IP" 'cat > /tmp/bpool.sh && chmod +x /tmp/bpool.sh' <<<"$BPOOL"
  echo "IP=$IP" > "$SESSION"

  note "warm-up: launch Things, quit, relaunch (steady state on the pinned date)"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"
  AA=$(areaid LAB-AREA-A)
  note "area A=$AA"

  # ---- SEED --------------------------------------------------------------
  # BOUNCE2-h: three headed groups (5/3/2 anytime children) in separate projects
  # so the cardinality arms don't interfere. Headed via TJSON (children nest under
  # the heading item).
  note "seed BOUNCE2-h: BV1..5 (heading HV), BW1..3 (heading HW), BX1..2 (heading HX)"
  tjson '[{"type":"project","attributes":{"title":"BH-P5","items":[{"type":"heading","attributes":{"title":"HV"}},{"type":"to-do","attributes":{"title":"BV1"}},{"type":"to-do","attributes":{"title":"BV2"}},{"type":"to-do","attributes":{"title":"BV3"}},{"type":"to-do","attributes":{"title":"BV4"}},{"type":"to-do","attributes":{"title":"BV5"}}]}}]'
  tjson '[{"type":"project","attributes":{"title":"BH-P3","items":[{"type":"heading","attributes":{"title":"HW"}},{"type":"to-do","attributes":{"title":"BW1"}},{"type":"to-do","attributes":{"title":"BW2"}},{"type":"to-do","attributes":{"title":"BW3"}}]}}]'
  tjson '[{"type":"project","attributes":{"title":"BH-P2","items":[{"type":"heading","attributes":{"title":"HX"}},{"type":"to-do","attributes":{"title":"BX1"}},{"type":"to-do","attributes":{"title":"BX2"}}]}}]'

  # SOMEBNC: 3 someday to-dos in LAB-AREA-A; a project with 3 someday children.
  note "seed SOMEBNC: SBA1..3 someday in LAB-AREA-A; SBP1..3 someday children of BH-SBP"
  for t in SBA1 SBA2 SBA3; do gurl "things:///add?title=$t&when=someday&list-id=$AA"; done
  tjson '[{"type":"project","attributes":{"title":"BH-SBP","items":[{"type":"to-do","attributes":{"title":"SBP1","when":"someday"}},{"type":"to-do","attributes":{"title":"SBP2","when":"someday"}},{"type":"to-do","attributes":{"title":"SBP3","when":"someday"}}]}}]'

  # BOUNCE2-t: three independent loose-anytime pools sized 10/20/30.
  note "seed BOUNCE2-t: pools BTA01..10, BTB01..20, BTC01..30 (loose anytime)"
  for n in $(seq -w 1 10);  do gurl "things:///add?title=BTA$n&when=anytime"; done
  for n in $(seq -w 1 20);  do gurl "things:///add?title=BTB$n&when=anytime"; done
  for n in $(seq -w 1 30);  do gurl "things:///add?title=BTC$n&when=anytime"; done

  # DAYORD-o: a project with 3 children all scheduled the SAME future day (07-10).
  note "seed DAYORD-o: BH-DAYO children DO1/DO2/DO3 @ 2026-07-10"
  tjson '[{"type":"project","attributes":{"title":"BH-DAYO","items":[{"type":"to-do","attributes":{"title":"DO1","when":"2026-07-10"}},{"type":"to-do","attributes":{"title":"DO2","when":"2026-07-10"}},{"type":"to-do","attributes":{"title":"DO3","when":"2026-07-10"}}]}}]'
  sleep 2

  note "--- seed verification ---"
  note "BOUNCE2-h 5 (expect h=<HV>, start=1): $(dumpstate 'BV%' | tr '\n' ' ')"
  note "BOUNCE2-h 3: $(dumpstate 'BW%' | tr '\n' ' ')"
  note "BOUNCE2-h 2: $(dumpstate 'BX%' | tr '\n' ' ')"
  note "headings: $(gq "SELECT title||'='||substr(uuid,1,8) FROM TMTask WHERE title IN ('HV','HW','HX') AND type=2" | tr '\n' ' ')"
  note "SOMEBNC area (expect a=<A>, start=2): $(dumpstate 'SBA%' | tr '\n' ' ')"
  note "SOMEBNC proj (expect start=2, p=<BH-SBP>): $(dumpstate 'SBP%' | tr '\n' ' ')"
  note "BOUNCE2-t pool sizes: A=$(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'BTA%'") B=$(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'BTB%'") C=$(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'BTC%'")"
  note "DAYORD-o (expect start=2, sd=2026-07-10, tIdx set): $(dumpstate 'DO%' | tr '\n' ' ')"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ================================================================= headless
if [ "$CMD" = "headless" ]; then
  load_session
  note "################################ BOUNCE2 HEADLESS ################################"

  note "########## BOUNCE2-h — multi-item WITHIN-HEADING bounce ordering (the HEADORD-c anomaly) ##########"
  HV=$(gq "SELECT uuid FROM TMTask WHERE title='HV' AND type=2")
  BV1=$(uuid_of BV1); BV2=$(uuid_of BV2); BV3=$(uuid_of BV3); BV4=$(uuid_of BV4); BV5=$(uuid_of BV5)
  note "  heading HV=$HV"
  note "  BEFORE (5-item, order by index): $(ordtitles 'BV%')"
  note "         $(dumpstate 'BV%' | tr '\n' ' ')"
  note "  -- reverse-order bounce (BV5,BV4,BV3,BV2,BV1); target visible order BV1<BV2<BV3<BV4<BV5 --"
  for u in "$BV5" "$BV4" "$BV3" "$BV2" "$BV1"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    bounce "$u"
    note "    after bounce $t: gmin=$(globalmin) hmin(BV)=$(groupmin 'BV%') h=$(gq "SELECT COALESCE(substr(heading,1,8),'-') FROM TMTask WHERE uuid='$u'") | order=$(ordtitles 'BV%')"
  done
  note "  AFTER 5-item full state: $(dumpstate 'BV%' | tr '\n' ' ')"
  note "  5-ITEM VERDICT order (want BV1<BV2<BV3<BV4<BV5): $(ordtitles 'BV%')"
  note "  heading FK survived all legs? $(gq "SELECT CASE WHEN COUNT(*)=5 THEN 'YES all 5 h='||substr(MIN(heading),1,8) ELSE 'NO only '||COUNT(*)||' still headed' END FROM TMTask WHERE title LIKE 'BV%' AND heading='$HV'")"

  note "  -- 3-item VALIDATION: apply the same reverse protocol; want BW1<BW2<BW3 --"
  HW=$(gq "SELECT uuid FROM TMTask WHERE title='HW' AND type=2")
  BW1=$(uuid_of BW1); BW2=$(uuid_of BW2); BW3=$(uuid_of BW3)
  note "     BEFORE: $(ordtitles 'BW%') | $(dumpstate 'BW%' | tr '\n' ' ')"
  for u in "$BW3" "$BW2" "$BW1"; do bounce "$u"; note "       after $(gq "SELECT title FROM TMTask WHERE uuid='$u'"): gmin=$(globalmin) order=$(ordtitles 'BW%')"; done
  note "     3-ITEM VERDICT (want BW1<BW2<BW3): $(ordtitles 'BW%') | headed=$(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'BW%' AND heading='$HW'")/3"
  note "  -- 3-item DETERMINISM re-run: scramble (bounce BW2 alone), then re-apply reverse protocol --"
  bounce "$BW2"
  note "     after scramble bounce BW2: $(ordtitles 'BW%')"
  for u in "$BW3" "$BW2" "$BW1"; do bounce "$u"; done
  note "     RE-RUN VERDICT (want BW1<BW2<BW3 again): $(ordtitles 'BW%')"

  note "  -- 2-item HEADORD-c reproduction: bounce ONLY BX1 once (the original anomaly config) --"
  HX=$(gq "SELECT uuid FROM TMTask WHERE title='HX' AND type=2")
  BX1=$(uuid_of BX1); BX2=$(uuid_of BX2)
  note "     BEFORE: $(ordtitles 'BX%') | $(dumpstate 'BX%' | tr '\n' ' ')"
  bounce "$BX1"
  note "     AFTER single BX1 bounce: $(ordtitles 'BX%') | $(dumpstate 'BX%' | tr '\n' ' ')"
  note "     (HEADORD-c anomaly = the non-bounced sibling ends lowest; does front-insert-to-min hold for a headed item?)"
  note "  -- 2-item FULL reverse protocol (bounce BX2 then BX1); want BX1<BX2 --"
  for u in "$BX2" "$BX1"; do bounce "$u"; done
  note "     2-ITEM VERDICT (want BX1<BX2): $(ordtitles 'BX%') | $(dumpstate 'BX%' | tr '\n' ' ')"

  note "########## SOMEBNC — someday re-entry position within a container (AREA + PROJECT) ##########"
  AA=$(areaid LAB-AREA-A)
  SBA1=$(uuid_of SBA1); SBA2=$(uuid_of SBA2); SBA3=$(uuid_of SBA3)
  note "  -- AREA someday members: map re-entry of a single toggle first --"
  note "     BEFORE: $(ordtitles 'SBA%') | $(dumpstate 'SBA%' | tr '\n' ' ')"
  note "     gmin(all)=$(globalmin) groupmin(SBA)=$(groupmin 'SBA%')"
  note "     -- toggle SBA2 someday->anytime->someday (via when=, NOT a container move) --"
  gurl "things:///update?id=$SBA2&auth-token=$TOKEN&when=anytime"
  note "        after anytime leg: $(dumpstate 'SBA%' | tr '\n' ' ')"
  gurl "things:///update?id=$SBA2&auth-token=$TOKEN&when=someday"
  note "        after someday leg (WHERE does SBA2 re-enter?): $(ordtitles 'SBA%') | gmin=$(globalmin) | $(dumpstate 'SBA%' | tr '\n' ' ')"
  note "     RE-ENTRY LAW: front (idx below someday group min) / bottom / index-preserved?"
  note "     -- derive+verify reverse protocol; target order SBA1<SBA2<SBA3 --"
  for u in "$SBA3" "$SBA2" "$SBA1"; do bounce_someday "$u"; note "        after toggle $(gq "SELECT title FROM TMTask WHERE uuid='$u'"): $(ordtitles 'SBA%')"; done
  note "     AREA VERDICT (want SBA1<SBA2<SBA3): $(ordtitles 'SBA%')"
  note "     state preserved? $(dumpstate 'SBA%' | tr '\n' ' ')"
  note "     assert: all start=2, a=<A> intact, rem=- (no reminder), dl=- (no deadline): $(gq "SELECT CASE WHEN COUNT(*)=3 THEN 'CLEAN 3/3 someday+area+no-rem+no-dl' ELSE 'DIRTY '||COUNT(*)||'/3' END FROM TMTask WHERE title LIKE 'SBA%' AND start=2 AND area='$AA' AND reminderTime IS NULL AND deadline IS NULL")"

  SBP=$(gq "SELECT uuid FROM TMTask WHERE title='BH-SBP' AND type=1")
  SBP1=$(uuid_of SBP1); SBP2=$(uuid_of SBP2); SBP3=$(uuid_of SBP3)
  note "  -- PROJECT someday children: same protocol --"
  note "     BEFORE: $(ordtitles 'SBP%') | $(dumpstate 'SBP%' | tr '\n' ' ')"
  gurl "things:///update?id=$SBP2&auth-token=$TOKEN&when=anytime"
  note "        after anytime leg (project FK survive?): $(dumpstate 'SBP%' | tr '\n' ' ')"
  gurl "things:///update?id=$SBP2&auth-token=$TOKEN&when=someday"
  note "        after someday leg: $(ordtitles 'SBP%') | $(dumpstate 'SBP%' | tr '\n' ' ')"
  for u in "$SBP3" "$SBP2" "$SBP1"; do bounce_someday "$u"; done
  note "     PROJECT VERDICT (want SBP1<SBP2<SBP3): $(ordtitles 'SBP%')"
  note "     assert: all start=2, p=<SBP> intact, no rem/dl: $(gq "SELECT CASE WHEN COUNT(*)=3 THEN 'CLEAN 3/3 someday+proj+no-rem+no-dl' ELSE 'DIRTY '||COUNT(*)||'/3' END FROM TMTask WHERE title LIKE 'SBP%' AND start=2 AND project='$SBP' AND reminderTime IS NULL AND deadline IS NULL")"

  note "########## BOUNCE2-t — cap calibration: wall-clock per bounced item @ 10/20/30 ##########"
  note "  (guest-local timing: URL open + DB-poll verify per leg, 2 legs/item; excludes host SSH RTT)"
  BTA=$(gq "SELECT group_concat(uuid,' ') FROM (SELECT uuid FROM TMTask WHERE title LIKE 'BTA%' ORDER BY title)")
  BTB=$(gq "SELECT group_concat(uuid,' ') FROM (SELECT uuid FROM TMTask WHERE title LIKE 'BTB%' ORDER BY title)")
  BTC=$(gq "SELECT group_concat(uuid,' ') FROM (SELECT uuid FROM TMTask WHERE title LIKE 'BTC%' ORDER BY title)")
  note "  -- pool A (10 items) --"
  lab_ssh "$IP" "/tmp/bpool.sh $(printf '%q' "$TOKEN") $BTA" </dev/null | tee -a "$REPORT"
  note "  -- pool B (20 items) --"
  lab_ssh "$IP" "/tmp/bpool.sh $(printf '%q' "$TOKEN") $BTB" </dev/null | tee -a "$REPORT"
  note "  -- pool C (30 items) --"
  lab_ssh "$IP" "/tmp/bpool.sh $(printf '%q' "$TOKEN") $BTC" </dev/null | tee -a "$REPORT"
  note "  sync-event note: offline clone — cloud sync unmeasurable. Each item = 2 mutations"
  note "  (someday + anytime), i.e. 2 Things-Cloud change records/item when online (SYNC2 model)."

  note "########## DAYORD-o — reproduce the DAYORD-b same-day todayIndex reorder (o-suite O17) ##########"
  DAYO=$(gq "SELECT uuid FROM TMTask WHERE title='BH-DAYO' AND type=1")
  DO1=$(uuid_of DO1); DO2=$(uuid_of DO2); DO3=$(uuid_of DO3)
  note "  BEFORE: $(dumpstate 'DO%' | tr '\n' ' ')"
  note "  -- reorder project children to DO3,DO1,DO2 (expect todayIndex re-rank, startDate PRESERVED) --"
  note "     result: $(reord "project id \"$DAYO\"" "$DO3,$DO1,$DO2")"
  note "  AFTER: $(dumpstate 'DO%' | tr '\n' ' ')"
  note "  todayIndex order DO3<DO1<DO2? $(gq "SELECT CASE WHEN (SELECT todayIndex FROM TMTask WHERE title='DO3')<(SELECT todayIndex FROM TMTask WHERE title='DO1') AND (SELECT todayIndex FROM TMTask WHERE title='DO1')<(SELECT todayIndex FROM TMTask WHERE title='DO2') THEN 'YES re-ranked' ELSE 'NO' END")"
  note "  startDate preserved (all still 2026-07-10)? $(gq "SELECT CASE WHEN COUNT(*)=3 THEN 'YES 3/3 @07-10' ELSE 'NO' END FROM TMTask WHERE title LIKE 'DO%' AND substr(startDate,1,10)='2026-07-10'")"
  note "  index untouched (scheduled items carry index=0)? $(gq "SELECT 'idx values: '||group_concat(\"index\") FROM TMTask WHERE title LIKE 'DO%'")"

  note "BOUNCE2 headless DONE — full log in $REPORT"
  exit 0
fi

# ============================================ forward-protocol confirmation
# The headless arms mapped the LAW (headed anytime + project-someday children
# BACK-insert = append to bucket end; area-someday FRONT-inserts). The reverse-
# order arms therefore produced reversed output for the back-insert cases — this
# subcommand runs the DERIVED FORWARD-order protocol on fresh groups to prove it
# lands the target order (the positive green for a compile-able promise).
if [ "$CMD" = "confirm" ]; then
  load_session
  note "################################ FORWARD-PROTOCOL CONFIRMATION ################################"

  note "########## BOUNCE2-h forward: headed anytime children, FORWARD-order bounce ##########"
  tjson '[{"type":"project","attributes":{"title":"BH-PZ","items":[{"type":"heading","attributes":{"title":"HZ"}},{"type":"to-do","attributes":{"title":"BZ1"}},{"type":"to-do","attributes":{"title":"BZ2"}},{"type":"to-do","attributes":{"title":"BZ3"}},{"type":"to-do","attributes":{"title":"BZ4"}}]}}]'
  sleep 2
  HZ=$(gq "SELECT uuid FROM TMTask WHERE title='HZ' AND type=2")
  BZ1=$(uuid_of BZ1); BZ2=$(uuid_of BZ2); BZ3=$(uuid_of BZ3); BZ4=$(uuid_of BZ4)
  note "  BEFORE: $(ordtitles 'BZ%')"
  # scramble to prove the protocol reorders (not just preserves seed order)
  bounce "$BZ1"; note "  scrambled (bounce BZ1 -> end): $(ordtitles 'BZ%')"
  note "  -- FORWARD bounce BZ1,BZ2,BZ3,BZ4; want BZ1<BZ2<BZ3<BZ4 --"
  for u in "$BZ1" "$BZ2" "$BZ3" "$BZ4"; do bounce "$u"; note "    after $(gq "SELECT title FROM TMTask WHERE uuid='$u'"): $(ordtitles 'BZ%')"; done
  note "  HEADED FORWARD VERDICT (want BZ1<BZ2<BZ3<BZ4): $(ordtitles 'BZ%') | headed=$(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'BZ%' AND heading='$HZ'")/4"

  note "########## SOMEBNC-project forward: project someday children, FORWARD-order bounce ##########"
  tjson '[{"type":"project","attributes":{"title":"BH-SZP","items":[{"type":"to-do","attributes":{"title":"SZP1","when":"someday"}},{"type":"to-do","attributes":{"title":"SZP2","when":"someday"}},{"type":"to-do","attributes":{"title":"SZP3","when":"someday"}}]}}]'
  sleep 2
  SZP=$(gq "SELECT uuid FROM TMTask WHERE title='BH-SZP' AND type=1")
  SZP1=$(uuid_of SZP1); SZP2=$(uuid_of SZP2); SZP3=$(uuid_of SZP3)
  note "  BEFORE: $(ordtitles 'SZP%')"
  bounce_someday "$SZP1"; note "  scrambled (toggle SZP1 -> end): $(ordtitles 'SZP%')"
  note "  -- FORWARD toggle SZP1,SZP2,SZP3; want SZP1<SZP2<SZP3 --"
  for u in "$SZP1" "$SZP2" "$SZP3"; do bounce_someday "$u"; note "    after $(gq "SELECT title FROM TMTask WHERE uuid='$u'"): $(ordtitles 'SZP%')"; done
  note "  PROJECT-SOMEDAY FORWARD VERDICT (want SZP1<SZP2<SZP3): $(ordtitles 'SZP%')"
  note "  state clean? $(gq "SELECT CASE WHEN COUNT(*)=3 THEN 'CLEAN 3/3 someday+proj' ELSE 'DIRTY '||COUNT(*)||'/3' END FROM TMTask WHERE title LIKE 'SZP%' AND start=2 AND project='$SZP' AND reminderTime IS NULL AND deadline IS NULL")"
  note "confirm DONE"
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|headless|teardown" >&2
exit 1
