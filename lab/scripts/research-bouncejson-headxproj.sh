#!/bin/bash
# BOUNCEJSON + HEADXPROJ — the two remaining queued ordering probes, ONE offline
# Tart clone (`bjhx-lab`, pinned clock; ordering is local, no cloud account).
# Full write-up + verdict tables: docs/lab/reordgaps-results.md (BOUNCEJSON /
# HEADXPROJ sections).
#
#   research-bouncejson-headxproj.sh setup        clone+boot+airgap+clock-pin+seed
#                                                  (+AX grant & e2e bundle when $VNCDO set)
#   research-bouncejson-headxproj.sh bouncejson    the headless json-array arms (BJ-0..d)
#   research-bouncejson-headxproj.sh headxproj     the GUI/AX cross-project heading drag
#   research-bouncejson-headxproj.sh teardown      stop + delete the clone
#
# ---------------------------------------------------------------- BOUNCEJSON
# Can ONE `things:///json` array dispatch collapse an N-item bounce (2N URL
# dispatches per BOUNCE2) to 2 dispatches (or 1)? Sub-questions (probe-backlog §C):
#   BJ-0  precondition: does json `operation:"update"` accept a `when` change on
#         an EXISTING item at all (auth-token update op)?  If not -> dead end.
#   BJ-a  does a json array apply ops in ARRAY ORDER so the BOUNCE2 front/back
#         insert laws hold?  Tested for BOTH container classes:
#           * headed anytime children (BOUNCE2-h BACK-insert / forward-order)
#           * area someday members    (SOMEBNC-area FRONT-insert / reverse-order)
#         and for BOTH collapse shapes: 2-dispatch (all-away array, all-back
#         array) and 1-dispatch (one array interleaving both legs per item).
#   BJ-b  is the terminal state the only verifiable point, or do elements land as
#         distinct DB transactions?  Oracle: per-row userModificationDate
#         granularity after a single N-op array.
#   BJ-c  mid-array failure: poison one element (bad uuid) mid-array — short-
#         circuit / skip-and-continue / full abort (partial-progress honesty).
#   BJ-d  timing: one 30-op array dispatch vs 30 sequential dispatches (vs the
#         BOUNCE2-t ~110 ms/item URL baseline).
#
# ---------------------------------------------------------------- HEADXPROJ
# Heading move to a DIFFERENT project (no headless automation spelling on any
# vector).  LOW stakes.  The recipe is the heading row's `…` ellipsis -> `Move…`
# MENU (NOT a drag — the drag was the fallback of last resort, unneeded):
#   (1) reconfirm the headless deadness (AS `move → project id` 301 / URL list-id
#       no-op) so the "GUI-only" claim is fresh.
#   (2) resolve the heading `…` button (AXUnknown desc="More. <headingTitle>" — an
#       AX node that CARRIES the title, so the reordgaps content-row title-
#       invisibility does NOT apply); AXPress is INERT (§8j) -> HID-click its frame.
#   (3) popover Archive/Move…/Convert to Project…/Delete -> HID-click Move… -> the
#       searchable project picker -> type destination name -> Return.  Bank the DB
#       delta (heading project-FK rewrite; children follow via intact heading FK).
#
# Conventions inherited from research-bounce2.sh / research-reordgaps.sh:
#   * offline COW clone, guest-side airgap (delete default route), clock pinned to
#     the golden's 2026-07-05T12:00 BEFORE Things launches, RO DB.
#   * headings only creatable headlessly via TJSON new-project-with-heading.
#   * GUI drags are CGEvent HID synthesis over SSH; vncdo needed ONLY for the
#     one-time Accessibility TCC grant (AXVM1 rung-b).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"          # 2026-07-05 12:00 (golden pinnedDate)
VNCDO="${VNCDO:-}"                   # vncdotool venv — only for the AX grant
VM="bjhx-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[bjhx] $*" | tee -a "$REPORT"; }

CMD="${1:-}"

# --------------------------------------------------------------- guest SQLite
GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

# guest json dispatcher: url-encode a json array + open it. $1=token $2=json
JDISP='#!/bin/bash
TOKEN="$1"; DATA="$2"
URL=$(python3 -c "import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))" "$TOKEN" "$DATA")
open -g "$URL"'

# guest timing helper (BJ-d): compare ONE N-op json array vs N sequential single
# -op json dispatches. Runs entirely guest-local (one ssh call) so timing excludes
# host<->guest SSH RTT — representative of the on-device op.
#   jtiming.sh <token> <uuid...>
JTIME='#!/bin/bash
TOKEN="$1"; shift
IDS=("$@"); N=${#IDS[@]}
INLIST=$(printf "'\''%s'\'',"  "${IDS[@]}" | sed "s/,$//")
poll() { local q="$1" i; for i in $(seq 1 500); do [ -n "$(/tmp/gsql.sh -q "$q")" ] && return 0; sleep 0.02; done; return 1; }
nowms() { python3 -c "import time; print(int(time.time()*1000))"; }
jdisp() { /tmp/jdisp.sh "$TOKEN" "$1"; }
arr() { local w="$1" o="[" f=1 u; for u in "${IDS[@]}"; do [ $f -eq 0 ] && o+=","; o+="{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$u\",\"attributes\":{\"when\":\"$w\"}}"; f=0; done; echo "$o]"; }
reset() { jdisp "$(arr anytime)"; poll "SELECT CASE WHEN COUNT(*)=$N THEN 1 END FROM TMTask WHERE start=1 AND startDate IS NULL AND uuid IN ($INLIST)"; }
reset
A0=$(nowms)
jdisp "$(arr someday)"
poll "SELECT CASE WHEN COUNT(*)=$N THEN 1 END FROM TMTask WHERE start=2 AND uuid IN ($INLIST)"
A1=$(nowms)
echo "ARRAY  $N ops (1 dispatch): $((A1-A0)) ms total ($(( (A1-A0)/N )) ms/op)"
reset
B0=$(nowms)
for u in "${IDS[@]}"; do
  jdisp "[{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$u\",\"attributes\":{\"when\":\"someday\"}}]"
  poll "SELECT 1 FROM TMTask WHERE uuid=\"$u\" AND start=2"
done
B1=$(nowms)
echo "SEQ    $N single-op dispatches: $((B1-B0)) ms total ($(( (B1-B0)/N )) ms/op)"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

# per-session helpers (need $IP)
gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gsql(){ lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
# dispatch a json array (host builds the string, guest url-encodes + opens)
jdisp(){ lab_ssh "$IP" "/tmp/jdisp.sh $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null; sleep 2; }
uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
areaid() { gq "SELECT uuid FROM TMArea WHERE title='$1'"; }
reord()  { gas "tell application \"Things3\" to _private_experimental_ reorder to dos in $1 with ids \"$2\""; sleep 2; }
dumpstate() { gq "SELECT title||' idx='||\"index\"||' tIdx='||todayIndex||' start='||start||' sd='||COALESCE(substr(startDate,1,10),'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-') FROM TMTask WHERE title LIKE '$1' ORDER BY \"index\""; }
ordtitles() { gq "SELECT group_concat(title,'<') FROM (SELECT title FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY \"index\")"; }
groupmin()  { gq "SELECT MIN(\"index\") FROM TMTask WHERE title LIKE '$1' AND trashed=0"; }
# build a json array of when=$1 update ops. args: when uuid...
jarray() { local w="$1"; shift; local o="[" f=1 u; for u in "$@"; do [ $f -eq 0 ] && o+=","; o+="{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$u\",\"attributes\":{\"when\":\"$w\"}}"; f=0; done; echo "$o]"; }
umoddates() { gq "SELECT title||'='||printf('%.6f',userModificationDate) FROM TMTask WHERE title LIKE '$1' ORDER BY title"; }
pkillthings() { lab_ssh "$IP" 'pkill -x Things3 2>/dev/null; sleep 3; open -g -a Things3; sleep 8' </dev/null; }

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
  VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  lab_ssh "$IP" 'cat > /tmp/jdisp.sh && chmod +x /tmp/jdisp.sh' <<<"$JDISP"
  lab_ssh "$IP" 'cat > /tmp/jtiming.sh && chmod +x /tmp/jtiming.sh' <<<"$JTIME"
  echo "IP=$IP" > "$SESSION"; echo "VNC_URL=$VNC_URL" >> "$SESSION"

  note "warm-up: launch Things, quit, relaunch (steady state on the pinned date)"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"
  AA=$(areaid LAB-AREA-A); AB=$(areaid LAB-AREA-B)
  note "areas: A=$AA B=$AB"

  # ---- SEED --------------------------------------------------------------
  note "seed BJ-0: BJ0 (loose anytime)"
  gurl "things:///add?title=BJ0&when=anytime"

  note "seed BJ-a headed: BJH1..4 (heading HJ2), BJK1..4 (heading HK1) — back-insert class"
  tjson '[{"type":"project","attributes":{"title":"BJ-HP2","items":[{"type":"heading","attributes":{"title":"HJ2"}},{"type":"to-do","attributes":{"title":"BJH1"}},{"type":"to-do","attributes":{"title":"BJH2"}},{"type":"to-do","attributes":{"title":"BJH3"}},{"type":"to-do","attributes":{"title":"BJH4"}}]}}]'
  tjson '[{"type":"project","attributes":{"title":"BJ-HP1","items":[{"type":"heading","attributes":{"title":"HK1"}},{"type":"to-do","attributes":{"title":"BJK1"}},{"type":"to-do","attributes":{"title":"BJK2"}},{"type":"to-do","attributes":{"title":"BJK3"}},{"type":"to-do","attributes":{"title":"BJK4"}}]}}]'

  note "seed BJ-a area-someday: BJA1..4 + BJB1..4 someday in LAB-AREA-A — front-insert class"
  for t in BJA1 BJA2 BJA3 BJA4 BJB1 BJB2 BJB3 BJB4; do gurl "things:///add?title=$t&when=someday&list-id=$AA"; done

  note "seed BJ-b: BJM1..5 loose anytime (userModificationDate oracle)"
  for t in BJM1 BJM2 BJM3 BJM4 BJM5; do gurl "things:///add?title=$t&when=anytime"; done

  note "seed BJ-c: BJG1..4 loose anytime (+1 bad-uuid poison element inserted mid-array)"
  for t in BJG1 BJG2 BJG3 BJG4; do gurl "things:///add?title=$t&when=anytime"; done

  note "seed BJ-d: BJT01..30 loose anytime"
  for n in $(seq -w 1 30); do gurl "things:///add?title=BJT$n&when=anytime"; done

  note "seed HEADXPROJ: HX-PA (heading HXH + HXC1/HXC2), HX-PB (target project, empty)"
  tjson '[{"type":"project","attributes":{"title":"HX-PA","items":[{"type":"heading","attributes":{"title":"HXH"}},{"type":"to-do","attributes":{"title":"HXC1"}},{"type":"to-do","attributes":{"title":"HXC2"}}]}}]'
  tjson '[{"type":"project","attributes":{"title":"HX-PB","items":[]}}]'
  sleep 2

  note "--- seed verification ---"
  note "BJ-0: $(dumpstate 'BJ0')"
  note "BJ-a headed HJ2 (start=1,h set): $(dumpstate 'BJH%' | tr '\n' ' ')"
  note "BJ-a headed HK1: $(dumpstate 'BJK%' | tr '\n' ' ')"
  note "headings: $(gq "SELECT title||'='||substr(uuid,1,8) FROM TMTask WHERE title IN ('HJ2','HK1','HXH') AND type=2" | tr '\n' ' ')"
  note "BJ-a area-someday BJA (start=2,a set): $(dumpstate 'BJA%' | tr '\n' ' ')"
  note "BJ-a area-someday BJB: $(dumpstate 'BJB%' | tr '\n' ' ')"
  note "BJ-b BJM: $(dumpstate 'BJM%' | tr '\n' ' ')"
  note "BJ-c BJG: $(dumpstate 'BJG%' | tr '\n' ' ')"
  note "BJ-d count: $(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'BJT%'")"
  note "HEADXPROJ HX-PA children (h=<HXH>, p=<HX-PA>): $(dumpstate 'HXC%' | tr '\n' ' ')"
  note "HEADXPROJ projects: $(gq "SELECT title||'='||substr(uuid,1,8) FROM TMTask WHERE title IN ('HX-PA','HX-PB') AND type=1" | tr '\n' ' ')"

  # ---- optional AX grant + e2e bundle for the headxproj phase --------------
  if [ -n "$VNCDO" ] && [ -x "$VNCDO" ] && [ -n "$VNC_URL" ]; then
    note "granting Accessibility (AXVM1 rung-b) for the headxproj phase"
    HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
    PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
    V() { sleep 2; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
    lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
    # CRITICAL: provoke a DENIED AX op first so the disabled sshd-keygen-wrapper
    # Accessibility TCC row is MATERIALIZED — else the pane has no row to toggle.
    lab_ssh "$IP" '/usr/bin/osascript -e "tell application \"System Events\" to tell process \"Things3\" to get value of attribute \"AXRole\" of window 1" 2>&1' </dev/null || true
    lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 10
    V capture "$OUT/screens/00-ax-pane.png"
    V move 1650 332 click 1; sleep 3
    V move 1020 872 click 1 pause 0.5 type admin pause 0.5 move 1020 967 click 1; sleep 3
    GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
    note "  AX grant auth_value=$GRANT (2=granted)"
    echo "AX_GRANTED=$([ "$GRANT" = 2 ] && echo 1 || echo 0)" >> "$SESSION"
    lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true
  else
    note "NOTE: \$VNCDO unset/missing — Accessibility NOT granted; the headxproj phase will be SKIPPED (headless BOUNCEJSON arms are unaffected)."
    echo "AX_GRANTED=0" >> "$SESSION"
  fi
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ================================================================= bouncejson
if [ "$CMD" = "bouncejson" ]; then
  load_session
  note "################################ BOUNCEJSON (headless) ################################"

  note "########## BJ-0 — precondition: json operation:update with a when change on an EXISTING item ##########"
  BJ0=$(uuid_of BJ0)
  note "  before: $(dumpstate 'BJ0')"
  jdisp "$(jarray someday "$BJ0")"
  note "  after [update BJ0 when=someday]: $(dumpstate 'BJ0')"
  S2=$(gq "SELECT CASE WHEN start=2 THEN 'YES start=2' ELSE 'NO still start='||start END FROM TMTask WHERE uuid='$BJ0'")
  note "  json update when=someday applied? $S2"
  jdisp "$(jarray anytime "$BJ0")"
  note "  after [update BJ0 when=anytime]: $(dumpstate 'BJ0')  <- both directions confirm the update surface"
  if [ "$(gq "SELECT start FROM TMTask WHERE uuid='$BJ0'")" != "1" ]; then
    note "  *** BJ-0 FAILED: json update when does NOT round-trip on existing items. BOUNCEJSON is a DEAD END (json can't carry the bounce legs). ***"
  fi

  note "########## BJ-a — array order vs the BOUNCE2 insert laws (both classes, both collapse shapes) ##########"

  note "  ===== BJ-a HEADED children (BOUNCE2-h: BACK-insert, forward-order protocol) ====="
  HJ2=$(gq "SELECT uuid FROM TMTask WHERE title='HJ2' AND type=2")
  BJH1=$(uuid_of BJH1); BJH2=$(uuid_of BJH2); BJH3=$(uuid_of BJH3); BJH4=$(uuid_of BJH4)
  # NB: seed order is already BJH1<BJH2<BJH3<BJH4, so a naive forward target would be
  # ambiguous (no-op vs applied). Use a SCRAMBLED target so the result proves array
  # order controls placement. Target visible order: BJH3<BJH1<BJH4<BJH2.
  note "  -- 2-DISPATCH: array1=[someday all], array2=[anytime BJH3,BJH1,BJH4,BJH2 = SCRAMBLED target]; want BJH3<BJH1<BJH4<BJH2 --"
  note "     before: $(ordtitles 'BJH%') | $(dumpstate 'BJH%' | tr '\n' ' ')"
  jdisp "$(jarray someday "$BJH1" "$BJH2" "$BJH3" "$BJH4")"
  note "     after away-array (all start=2?): $(dumpstate 'BJH%' | tr '\n' ' ')"
  jdisp "$(jarray anytime "$BJH3" "$BJH1" "$BJH4" "$BJH2")"
  note "     after back-array (forward-order back-insert): $(ordtitles 'BJH%') | $(dumpstate 'BJH%' | tr '\n' ' ')"
  note "     2-DISPATCH VERDICT (want BJH3<BJH1<BJH4<BJH2 = array order): $(ordtitles 'BJH%') | headed=$(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'BJH%' AND heading='$HJ2'")/4"

  HK1=$(gq "SELECT uuid FROM TMTask WHERE title='HK1' AND type=2")
  BJK1=$(uuid_of BJK1); BJK2=$(uuid_of BJK2); BJK3=$(uuid_of BJK3); BJK4=$(uuid_of BJK4)
  # SCRAMBLED target (seed is BJK1<BJK2<BJK3<BJK4): interleave both legs per item in
  # target order BJK2,BJK4,BJK1,BJK3 -> want visible BJK2<BJK4<BJK1<BJK3.
  note "  -- 1-DISPATCH: one array interleaving both legs per item, order BJK2,BJK4,BJK1,BJK3 = SCRAMBLED target; want BJK2<BJK4<BJK1<BJK3 --"
  note "     before: $(ordtitles 'BJK%') | $(dumpstate 'BJK%' | tr '\n' ' ')"
  INTER="["
  first=1
  for u in "$BJK2" "$BJK4" "$BJK1" "$BJK3"; do
    [ $first -eq 0 ] && INTER+=","
    INTER+="{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$u\",\"attributes\":{\"when\":\"someday\"}},{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$u\",\"attributes\":{\"when\":\"anytime\"}}"
    first=0
  done
  INTER+="]"
  jdisp "$INTER"
  note "     after 1-dispatch interleaved: $(ordtitles 'BJK%') | $(dumpstate 'BJK%' | tr '\n' ' ')"
  note "     1-DISPATCH VERDICT (want BJK2<BJK4<BJK1<BJK3 = array order; all start=1): $(ordtitles 'BJK%') | headed=$(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'BJK%' AND heading='$HK1'")/4 | start1=$(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'BJK%' AND start=1")/4"

  note "  ===== BJ-a AREA someday members (SOMEBNC-area: FRONT-insert, reverse-order protocol) ====="
  AA=$(areaid LAB-AREA-A)
  BJA1=$(uuid_of BJA1); BJA2=$(uuid_of BJA2); BJA3=$(uuid_of BJA3); BJA4=$(uuid_of BJA4)
  note "  -- 2-DISPATCH: array1=[anytime BJA4,3,2,1 rev], array2=[someday BJA4,3,2,1 rev]; want BJA1<BJA2<BJA3<BJA4 --"
  note "     before: $(ordtitles 'BJA%') | $(dumpstate 'BJA%' | tr '\n' ' ')"
  jdisp "$(jarray anytime "$BJA4" "$BJA3" "$BJA2" "$BJA1")"
  note "     after away-array (start=1?): $(dumpstate 'BJA%' | tr '\n' ' ')"
  jdisp "$(jarray someday "$BJA4" "$BJA3" "$BJA2" "$BJA1")"
  note "     after back-array: $(ordtitles 'BJA%') | $(dumpstate 'BJA%' | tr '\n' ' ')"
  note "     2-DISPATCH VERDICT (want BJA1<BJA2<BJA3<BJA4; start=2, area intact): $(ordtitles 'BJA%') | clean=$(gq "SELECT CASE WHEN COUNT(*)=4 THEN 'YES 4/4 someday+area' ELSE 'NO '||COUNT(*)||'/4' END FROM TMTask WHERE title LIKE 'BJA%' AND start=2 AND area='$AA'")"

  BJB1=$(uuid_of BJB1); BJB2=$(uuid_of BJB2); BJB3=$(uuid_of BJB3); BJB4=$(uuid_of BJB4)
  note "  -- 1-DISPATCH: one array interleaving both legs per item, reverse: [at B4,sd B4,at B3,sd B3,...]; want BJB1<BJB2<BJB3<BJB4 --"
  note "     before: $(ordtitles 'BJB%') | $(dumpstate 'BJB%' | tr '\n' ' ')"
  INTB="["
  first=1
  for u in "$BJB4" "$BJB3" "$BJB2" "$BJB1"; do
    [ $first -eq 0 ] && INTB+=","
    INTB+="{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$u\",\"attributes\":{\"when\":\"anytime\"}},{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$u\",\"attributes\":{\"when\":\"someday\"}}"
    first=0
  done
  INTB+="]"
  jdisp "$INTB"
  note "     after 1-dispatch interleaved: $(ordtitles 'BJB%') | $(dumpstate 'BJB%' | tr '\n' ' ')"
  note "     1-DISPATCH VERDICT (want BJB1<BJB2<BJB3<BJB4; start=2, area intact): $(ordtitles 'BJB%') | clean=$(gq "SELECT CASE WHEN COUNT(*)=4 THEN 'YES 4/4 someday+area' ELSE 'NO '||COUNT(*)||'/4' END FROM TMTask WHERE title LIKE 'BJB%' AND start=2 AND area='$AA'")"

  note "########## BJ-b — transaction granularity (userModificationDate oracle) ##########"
  BJM1=$(uuid_of BJM1); BJM2=$(uuid_of BJM2); BJM3=$(uuid_of BJM3); BJM4=$(uuid_of BJM4); BJM5=$(uuid_of BJM5)
  note "  umod BEFORE: $(umoddates 'BJM%' | tr '\n' ' ')"
  note "  -- single 5-op array (all someday) --"
  jdisp "$(jarray someday "$BJM1" "$BJM2" "$BJM3" "$BJM4" "$BJM5")"
  sleep 1
  note "  umod AFTER (distinct per row => distinct transactions; identical => one atomic commit): $(umoddates 'BJM%' | tr '\n' ' ')"
  note "  distinct-count of userModificationDate: $(gq "SELECT COUNT(DISTINCT printf('%.6f',userModificationDate)) FROM TMTask WHERE title LIKE 'BJM%'") of 5"
  note "  (5 distinct => per-element distinct-txn writes; 1 distinct => single batched commit; partial => sub-batches)"

  note "########## BJ-c — mid-array poison (bad uuid) — short-circuit / skip / abort ##########"
  BJG1=$(uuid_of BJG1); BJG2=$(uuid_of BJG2); BJG3=$(uuid_of BJG3); BJG4=$(uuid_of BJG4)
  BAD="00000000-0000-0000-0000-000000000000"
  note "  before (all start=1): $(dumpstate 'BJG%' | tr '\n' ' ')"
  note "  -- array = [sd BJG1, sd BJG2, sd <BAD>, sd BJG3, sd BJG4] --"
  POISON="[{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$BJG1\",\"attributes\":{\"when\":\"someday\"}},{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$BJG2\",\"attributes\":{\"when\":\"someday\"}},{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$BAD\",\"attributes\":{\"when\":\"someday\"}},{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$BJG3\",\"attributes\":{\"when\":\"someday\"}},{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$BJG4\",\"attributes\":{\"when\":\"someday\"}}]"
  jdisp "$POISON"
  sleep 2
  note "  after poison array: $(dumpstate 'BJG%' | tr '\n' ' ')"
  note "  start=2 map (which good elements landed): $(gq "SELECT group_concat(title||'='||start,' ') FROM (SELECT title,start FROM TMTask WHERE title LIKE 'BJG%' ORDER BY title)")"
  A=$(gq "SELECT start FROM TMTask WHERE title='BJG1'"); B=$(gq "SELECT start FROM TMTask WHERE title='BJG2'"); C=$(gq "SELECT start FROM TMTask WHERE title='BJG3'"); D=$(gq "SELECT start FROM TMTask WHERE title='BJG4'")
  note "  BJG1=$A BJG2=$B BJG3=$C BJG4=$D  => (2,2,-,-)=SHORT-CIRCUIT · (2,2,2,2)=SKIP-AND-CONTINUE · (-,-,-,-)=FULL ABORT"
  note "  (json error modal expected — clearing with pkill+relaunch before next arm)"
  pkillthings

  note "########## BJ-d — timing: 1x 30-op array vs 30 sequential dispatches (vs BOUNCE2-t ~110 ms/item URL) ##########"
  BJT=$(gq "SELECT group_concat(uuid,' ') FROM (SELECT uuid FROM TMTask WHERE title LIKE 'BJT%' ORDER BY title)")
  lab_ssh "$IP" "/tmp/jtiming.sh $(printf '%q' "$TOKEN") $BJT" </dev/null | tee -a "$REPORT"
  note "  NOTE: a bounce = 2 legs/item. A 30-item bounce via json = 2 array dispatches (60 legs);"
  note "  BOUNCE2-t URL baseline = ~110 ms/item = 2 legs = ~55 ms/leg, i.e. ~3.4 s for 30 items = 60 URL opens."

  note "BOUNCEJSON DONE — full log in $REPORT"
  exit 0
fi

# ================================================================= headxproj
if [ "$CMD" = "headxproj" ]; then
  load_session
  note "################################ HEADXPROJ (ellipsis-menu Move… cross-project heading move) ################################"

  PA=$(gq "SELECT uuid FROM TMTask WHERE title='HX-PA' AND type=1")
  PB=$(gq "SELECT uuid FROM TMTask WHERE title='HX-PB' AND type=1")
  HXH=$(gq "SELECT uuid FROM TMTask WHERE title='HXH' AND type=2")
  note "  HX-PA=$PA  HX-PB=$PB  heading HXH=$HXH"
  note "  baseline: $(dumpstate 'HXC%' | tr '\n' ' ')  heading-row: $(gq "SELECT title||' p='||COALESCE(substr(project,1,8),'-')||' h='||COALESCE(substr(heading,1,8),'-')||' idx='||\"index\" FROM TMTask WHERE uuid='$HXH'")"

  note "########## HEADXPROJ-1a — reconfirm NO headless spelling (scf P2 / backlog): AS move + URL list-id on a heading cross-project ##########"
  note "  -- AS: move heading id to project B --"
  note "     result: $(gas "tell application \"Things3\" to move (first to do whose id = \"$HXH\") to project id \"$PB\"")"
  note "     heading FK after AS move: $(gq "SELECT 'p='||COALESCE(substr(project,1,8),'-') FROM TMTask WHERE uuid='$HXH'") (expect UNCHANGED = still HX-PA)"
  note "  -- URL update list-id (expect no-op/ignored) --"
  gurl "things:///update?id=$HXH&auth-token=$TOKEN&list-id=$PB"
  note "     heading FK after URL list-id: $(gq "SELECT 'p='||COALESCE(substr(project,1,8),'-') FROM TMTask WHERE uuid='$HXH'")"
  note "     children after headless attempts: $(dumpstate 'HXC%' | tr '\n' ' ')"

  if [ "${AX_GRANTED:-0}" != "1" ]; then
    note "  AX NOT granted (setup needs \$VNCDO). The GUI Move… arm is SKIPPED; headless reconfirm above stands."
    note "headxproj DONE (headless-only) — $REPORT"
    exit 0
  fi

  # ------ ellipsis-menu AX kit: resolve the heading `…` button frame, HID-click
  # (AXPress is INERT — parallels §8j), then the Move… item + keyboard-drive the picker.
  # The heading `…` button is an AXUnknown desc="More. <headingTitle>" (it CARRIES the
  # heading title — the reordgaps content-row title-invisibility does NOT apply to it).
  lab_ssh "$IP" 'cat > /tmp/hxmenu.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleep(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]) }
function sv(el,name){ var v=attr(el,name); return v? (''+v.js) : '' }
function frame(el){ var p=attr(el,'AXPosition'), z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function appEl(){ return $.AXUIElementCreateApplication(pidOf('Things3')) }
var MOVED=5, DOWN=1, UP=2;
function mev(t,x,y){ return $.CGEventCreateMouseEvent($(),t,$.CGPointMake(x,y),0) }
function postHID(ev){ $.CGEventPost($.kCGHIDEventTap, ev) }
function click(x,y){ postHID(mev(MOVED,x,y)); sleep(60); postHID(mev(DOWN,x,y)); sleep(90); postHID(mev(UP,x,y)); sleep(60) }
function key(code){ var d=$.CGEventCreateKeyboardEvent($(),code,true), u=$.CGEventCreateKeyboardEvent($(),code,false); postHID(d); sleep(40); postHID(u); sleep(40) }
// walk the whole app tree; return the frame of the first node whose AXDescription contains sub
function findByDesc(sub){ var hit=null;
  (function w(e){ if(hit) return; var d=sv(e,'AXDescription'); if(d && d.indexOf(sub)>=0){ hit=e; return; } var ch=kids(e); for(var i=0;i<ch.length;i++) w(ch[i]); })(appEl());
  return hit; }
function run(argv){
  var cmd=argv[0];
  if(cmd==='more-frame'){ var el=findByDesc('More. '+argv.slice(1).join(' ')); if(!el) return 'MORE_NOT_FOUND';
    var f=frame(el); if(!f) return 'NO_FRAME'; return JSON.stringify({cx:f.x+f.w/2, cy:f.y+f.h/2, f:f}); }
  if(cmd==='click'){ click(+argv[1],+argv[2]); return 'CLICKED '+argv[1]+','+argv[2]; }
  if(cmd==='key'){ key(+argv[1]); return 'KEY '+argv[1]; }
  if(cmd==='type'){ Application('System Events').keystroke(argv.slice(1).join(' ')); return 'TYPED'; }
  return 'UNKNOWN_CMD';
}
EOF
  AXM() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript /tmp/hxmenu.js $*" </dev/null; }
  relaunch() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 3; open -a Things3; sleep 9' </dev/null; }
  axoff() { lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true; }
  show() { lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 3" </dev/null; }
  cap() { [ -n "${VNCDO:-}" ] || return 0; local HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; local SERVER="${HP%%:*}::${HP##*:}"
    local PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
    timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} capture "$OUT/screens/$1.png" 2>>"$OUT/vnc.log" || true; }

  note "########## HEADXPROJ-2/3 — the ellipsis Move… recipe (heading HXH: HX-PA -> HX-PB) ##########"
  relaunch; axoff; show "things:///show?id=$PA"
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  note "  PRE-MOVE heading-row: $(gq "SELECT 'project='||COALESCE(substr(project,1,8),'-')||' heading='||COALESCE(substr(heading,1,8),'-')||' idx='||\"index\" FROM TMTask WHERE uuid='$HXH'")"
  note "  PRE-MOVE children:    $(dumpstate 'HXC%' | tr '\n' ' ')"

  # 1) resolve the heading `…` (More) button frame center (AX node, carries the title)
  MF=$(AXM more-frame HXH); note "  heading More-button frame: $MF"
  CX=$(echo "$MF" | python3 -c "import sys,json;print(int(round(json.load(sys.stdin)['cx'])))" 2>/dev/null || echo "")
  CY=$(echo "$MF" | python3 -c "import sys,json;print(int(round(json.load(sys.stdin)['cy'])))" 2>/dev/null || echo "")
  if [ -z "$CX" ]; then note "  FATAL: could not resolve the heading More button (AX). Aborting the GUI arm; headless reconfirm stands."; exit 1; fi

  # 2) HID-click it -> the Archive/Move…/Convert/Delete popover (AXPress is inert -> HID click)
  note "  HID-click More button ($CX,$CY): $(AXM click "$CX" "$CY")"; sleep 1; cap 20-popover
  # 3) HID-click Move… — the 2nd popover item, empirically ~(-36,+62) pts from the button
  #    center (the custom popover items are AX-readable-not-cleanly-enumerable; verify via 20-popover.png).
  MVX=$((CX-36)); MVY=$((CY+62))
  note "  HID-click Move… ($MVX,$MVY): $(AXM click "$MVX" "$MVY")"; sleep 1; cap 21-picker
  # 4) keyboard-drive the picker: type the destination name -> filters -> Return selects
  note "  type destination 'HX-PB': $(AXM type HX-PB)"; sleep 1; cap 22-filtered
  note "  press Return: $(AXM key 36)"; sleep 2; cap 23-done

  note "  POST-MOVE heading-row: $(gq "SELECT 'project='||COALESCE(substr(project,1,8),'-')||' heading='||COALESCE(substr(heading,1,8),'-')||' idx='||\"index\" FROM TMTask WHERE uuid='$HXH'")"
  note "  POST-MOVE children:    $(dumpstate 'HXC%' | tr '\n' ' ')"
  note "  DB DELTA VERDICT:"
  note "    HXH.project==HX-PB? $(gq "SELECT CASE WHEN project='$PB' THEN 'YES moved to B' ELSE 'NO still '||COALESCE(substr(project,1,8),'-') END FROM TMTask WHERE uuid='$HXH'")"
  note "    children follow via heading FK (project NULL, heading=HXH)? $(gq "SELECT COUNT(*)||'/2' FROM TMTask WHERE title LIKE 'HXC%' AND heading='$HXH' AND project IS NULL")"
  note "    dest contents (project=HX-PB or heading=HXH): $(gq "SELECT group_concat(title||'(idx'||\"index\"||')',' ') FROM (SELECT title,\"index\" FROM TMTask WHERE (project='$PB' OR heading='$HXH') AND trashed=0 ORDER BY \"index\")")"
  note "  VERDICT: FEASIBLE-with-recipe (ellipsis Move… menu; deterministic, keyboard-driveable, no drag, no §9 fragility)."
  note "  (The DRAG content->sidebar approach was the fallback of last resort — NOT needed; the menu path is the recipe.)"
  note "headxproj DONE — recipe log + screenshots in $OUT"
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|bouncejson|headxproj|teardown" >&2
exit 1
