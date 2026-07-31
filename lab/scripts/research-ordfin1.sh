#!/bin/bash
# ORDFIN1 — the ordering ENDGAME: the last four open ordering questions.
# Write-up: docs/lab/ordfin1-ordering-endgame.md.
#
# ONE disposable offline Tart clone `ordfin1-lab` (pinned clock 2026-07-05 12:00;
# ordering is local — no cloud account). Arms 2/3/4 are HEADLESS (URL scheme +
# `things:///json` + AppleScript private reorder). Arm 1 needs Accessibility
# (granted per-clone via the AXVM1 rung-b VNC toggle — requires $VNCDO) for the
# repeat-menu levers (1b) and the Upcoming-view AX inspection (1c/1d).
#
# Subcommands:
#   research-ordfin1.sh setup      clone+boot(+vnc)+airgap+clock-pin+warm+seed
#   research-ordfin1.sh grant       AXVM1 rung-b Accessibility toggle (needs $VNCDO)
#   research-ordfin1.sh arm1cd      TMPLIDX GUI/AX inspection (+ fail-closed drag)
#   research-ordfin1.sh arm1b       TMPLIDX template-todayIndex levers (menu ops)
#   research-ordfin1.sh arm2         EVEHEAD — headed evening children (headless)
#   research-ordfin1.sh arm3         AREADAY — an area's direct dated children (headless)
#   research-ordfin1.sh arm4         UPCORD2 — cross-container day interleave (headless)
#   research-ordfin1.sh teardown     stop + delete the clone
#
# Conventions inherited from research-upcord1.sh / research-headsub1.sh:
#   * offline COW clone, guest airgap (delete default route), clock pinned BEFORE
#     Things launches, read-only guest SQLite.
#   * dates SEEDED via URL `when=<ISO>` (the APP packs startDate) — NEVER hand-pack
#     a date integer; preservation asserted by DB read comparison before/after.
#   * `with ids` is a COMMA-SEPARATED STRING; the private reorder re-ranks the
#     addressed key ASCENDING in the sent id order (DAYORD-b). Wire lists SCRAMBLED
#     so a passing result proves array order CONTROLS placement, not a no-op.
#   * NEVER send URL `when=`/schedule-class to a REPEATING template row (§1 CRASH).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
TODAY="${TODAY:-2026-07-05}"         # the pinned Today (evening lives here)
DAY_GUI="${DAY_GUI:-2026-07-10}"     # Arm 1c/1d: template projects + ordinary to-dos
DAY_AREA="${DAY_AREA:-2026-07-15}"   # Arm 3 future day
DAY_UP="${DAY_UP:-2026-07-20}"       # Arm 4 future day
VNCDO="${VNCDO:-}"
AA="7Ck4hAXU36jyaBsy2Fkije"          # LAB-AREA-A (seed-manifest)
AB="2piYxp6UzasLDSvkwY747J"          # LAB-AREA-B
TMPL="W3PZB9e7W6BEtKmEKP4deG"        # LAB-REPEAT-DAILY (repeating to-do template)
TMPL_INST="11NNVsNH9gyTEAiG554nQ"    # its seeded current spawned instance
VM="ordfin1-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[ordfin1] $*" | tee -a "$REPORT"; }

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
# private reorder command (comma-separated ids string) — the container-day compile
reord()  { gas "tell application \"Things3\" to _private_experimental_ reorder to dos in $1 with ids \"$2\""; sleep 2; }
# full within-day state for a title glob, ORDERED BY todayIndex then index.
# columns: title tIdx idx start sb(startBucket) sd(startDate) rem dl h(heading8) p(project8) a(area8)
dumpday() { gq "SELECT title||' tIdx='||todayIndex||' idx='||\"index\"||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(startDate,'-')||' rem='||COALESCE(reminderTime,'-')||' dl='||COALESCE(deadline,'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-') FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY todayIndex, \"index\""; }
one() { gq "SELECT title||' tIdx='||todayIndex||' idx='||\"index\"||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(startDate,'-')||' rem='||COALESCE(reminderTime,'-')||' dl='||COALESCE(deadline,'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-') FROM TMTask WHERE uuid='$1'"; }

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (GUI day $DAY_GUI, area day $DAY_AREA, up day $DAY_UP)"
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

  note "--- resting template row (Arm 1a) ---"
  note "  $(one "$TMPL")"
  note "  rt1 state: $(gq "SELECT 'paused='||COALESCE(rt1_instanceCreationPaused,'-')||' next='||COALESCE(rt1_nextInstanceStartDate,'-')||' rule='||substr(hex(rt1_recurrenceRule),1,40) FROM TMTask WHERE uuid='$TMPL'")"
  note "  instance $TMPL_INST: $(one "$TMPL_INST")"

  # ---- ARM 1c GUI fodder: 3 ordinary dated to-dos on DAY_GUI (template projects daily) ----
  note "seed Arm 1c: TG-1/2/3 loose @$DAY_GUI (template projects this day)"
  for t in TG-1 TG-2 TG-3; do gurl "things:///add?title=$t&when=$DAY_GUI"; done

  # ---- ARM 2 EVEHEAD ----
  note "seed Arm 2: project EH-P with heading EH-H"
  tjson '[{"type":"project","attributes":{"title":"EH-P","items":[{"type":"heading","attributes":{"title":"EH-H"}}]}}]'; sleep 2
  EHP=$(gq "SELECT uuid FROM TMTask WHERE title='EH-P' AND type=1")
  echo "EHP=$EHP" >> "$SESSION"
  note "  EH-P=$EHP"
  note "  seed EH-C1 (loose evening), then MOVE under heading EH-H (proven path preserves startBucket=1)"
  gurl "things:///add?title=EH-C1&when=evening"; sleep 1
  EHC1=$(uuid_of EH-C1)
  gurl "things:///update?id=$EHC1&auth-token=$TOKEN&list-id=$EHP&heading=EH-H"
  note "  seed EH-C2 (unheaded evening child of EH-P)"
  gurl "things:///add?title=EH-C2&when=evening&list-id=$EHP"; sleep 1
  EHC2=$(uuid_of EH-C2)
  { echo "EHC1=$EHC1"; echo "EHC2=$EHC2"; } >> "$SESSION"
  note "  EH-C1 headed evening: $(one "$EHC1")"
  note "  EH-C2 unheaded evening: $(one "$EHC2")"

  # ---- ARM 3 AREADAY ----
  note "seed Arm 3: AD-1..4 direct dated children of LAB-AREA-A @$DAY_AREA (AD-2 carries reminder+deadline); AD-ANY/AD-SOME canaries"
  gurl "things:///add?title=AD-1&when=$DAY_AREA&list-id=$AA"
  gurl "things:///add?title=AD-2&when=$DAY_AREA@09:00&deadline=$DAY_AREA&list-id=$AA"
  gurl "things:///add?title=AD-3&when=$DAY_AREA&list-id=$AA"
  gurl "things:///add?title=AD-4&when=$DAY_AREA&list-id=$AA"
  gurl "things:///add?title=AD-ANY&list-id=$AA"
  gurl "things:///add?title=AD-SOME&when=someday&list-id=$AA"
  note "  area A dated members: $(dumpday 'AD-%' | tr '\n' ' ')"

  # ---- ARM 4 UPCORD2 ----
  note "seed Arm 4: project UC-P (with heading UC-H); 2 loose, 2 project children (1 headed), 2 area children (1 rem+dl) @$DAY_UP"
  tjson '[{"type":"project","attributes":{"title":"UC-P","items":[{"type":"heading","attributes":{"title":"UC-H"}}]}}]'; sleep 2
  UCP=$(gq "SELECT uuid FROM TMTask WHERE title='UC-P' AND type=1")
  echo "UCP=$UCP" >> "$SESSION"
  note "  UC-P=$UCP"
  gurl "things:///add?title=UC-L1&when=$DAY_UP"
  gurl "things:///add?title=UC-L2&when=$DAY_UP"
  gurl "things:///add?title=UC-P1&when=$DAY_UP&list-id=$UCP"
  gurl "things:///add?title=UC-P2&when=$DAY_UP&list-id=$UCP"; sleep 1
  UCP2=$(uuid_of UC-P2)
  gurl "things:///update?id=$UCP2&auth-token=$TOKEN&list-id=$UCP&heading=UC-H"   # UC-P2 headed under UC-H
  gurl "things:///add?title=UC-A1&when=$DAY_UP&list-id=$AA"
  gurl "things:///add?title=UC-A2&when=$DAY_UP@09:00&deadline=$DAY_UP&list-id=$AA"
  note "  Arm4 day-group: $(dumpday 'UC-%' | tr '\n' ' ')"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ==================================================================== grant (AXVM1 rung-b)
if [ "$CMD" = "grant" ]; then
  load_session
  [ -n "$VNCDO" ] || { note "VNCDO unset — cannot grant Accessibility"; exit 1; }
  [ -n "${VNC_URL:-}" ] || { note "no VNC_URL in session"; exit 1; }
  note "provoke the disabled Accessibility TCC row (a denied AX op)"
  lab_ssh "$IP" 'open -g -a Things3; sleep 3' </dev/null
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' 2>&1; echo "[exit $?]"' </dev/null | tee -a "$REPORT"
  note "TCC Accessibility rows before grant: $(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''" 2>&1' </dev/null)"
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  V() { "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
  lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
  V capture "$OUT/g1-ax-pane.png"; sleep 0.5
  V move 1642 332 click 1; sleep 3
  V capture "$OUT/g2-auth-sheet.png"; sleep 0.5
  V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3
  V capture "$OUT/g3-after-auth.png"; sleep 0.5
  note "TCC Accessibility rows after grant: $(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''" 2>&1' </dev/null)"
  note "re-probe AX op (expect menu list, exit 0): $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' 2>&1; echo "[exit $?]"' </dev/null)"
  exit 0
fi

# ==================================================================== arm1cd (GUI/AX)
if [ "$CMD" = "arm1cd" ]; then
  load_session
  note "################## ARM 1c/1d — TMPLIDX GUI/AX inspection ##################"
  note "template resting row: $(one "$TMPL")"
  # deploy the AX dumper
  lab_ssh "$IP" 'cat > /tmp/axdump.js' < lab/scripts/ordfin1-axdump.jxa
  note "open the Upcoming view and settle"
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 1; open 'things:///show?id=upcoming'; sleep 4" </dev/null
  # VNC screenshot of the Upcoming view for evidence
  if [ -n "$VNCDO" ] && [ -n "${VNC_URL:-}" ]; then
    HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
    PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
    "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} capture "$OUT/arm1c-upcoming.png" 2>>"$OUT/vnc.log" || true
  fi
  note "--- AX dump of the main (Upcoming) list rows (subrole + descendant text + AXDescription) ---"
  lab_ssh "$IP" 'osascript -l JavaScript /tmp/axdump.js maindump 2>&1' </dev/null | tee -a "$OUT/arm1c-axdump.txt" | tee -a "$REPORT"
  note "--- day-group $DAY_GUI members in the DB (what the projected + ordinary rows correspond to) ---"
  note "  ordinary TG-* @$DAY_GUI: $(dumpday 'TG-%' | tr '\n' ' ')"
  note "  template row (todayIndex/startDate): $(gq "SELECT 'tIdx='||todayIndex||' idx='||\"index\"||' sd='||COALESCE(startDate,'-')||' nextInst='||COALESCE(rt1_nextInstanceStartDate,'-') FROM TMTask WHERE uuid='$TMPL'")"
  note "VERDICT-1cd: is the projected repeating row an addressable AX row with a VERIFIABLE identity (template title or a stable id)? If NOT -> DO NOT DRAG (fail closed); the blocking finding IS the feasibility answer."
  note "(Per §9e / reordgaps: Things list rows expose cell-template identifiers, not to-do titles, to AX — expect identity NOT verifiable.)"
  exit 0
fi

# ==================================================================== arm1b (levers)
if [ "$CMD" = "arm1b" ]; then
  load_session
  note "################## ARM 1b — TMPLIDX template-todayIndex levers ##################"
  tidx() { gq "SELECT 'tIdx='||todayIndex||' idx='||\"index\"||' paused='||COALESCE(rt1_instanceCreationPaused,'-')||' next='||COALESCE(rt1_nextInstanceStartDate,'-')||' fu='||substr(hex(rt1_recurrenceRule),1,8) FROM TMTask WHERE uuid='$TMPL'"; }
  # select the template + drive the Items>Repeat submenu BY NAME (AXVM1-d recipe)
  rsel() { lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 1; open 'things:///show?id=$TMPL'; sleep 2" </dev/null; }
  rclick() { lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"$1\" of menu 1 of menu item \"Repeat\" of menu \"Items\" of menu bar item \"Items\" of menu bar 1' 2>&1; echo \"[exit \$?]\"" </dev/null; }
  note "resting (Arm 1a confirm): $(tidx)"

  note "---- lever 1: PAUSE ----"
  rsel; note "  submenu: $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu item of menu 1 of menu item "Repeat" of menu "Items" of menu bar item "Items" of menu bar 1'\'' 2>&1' </dev/null)"
  note "  click Pause: $(rclick Pause)"; sleep 2
  note "  after PAUSE: $(tidx)"

  note "---- lever 2: RESUME ----"
  rsel; note "  click Resume: $(rclick Resume)"; sleep 2
  note "  after RESUME: $(tidx)"

  note "---- lever 3: COMPLETE the current spawned instance (series advances) ----"
  note "  instance before: $(one "$TMPL_INST")"
  note "  complete via AppleScript: $(gas "tell application \"Things3\" to set status of to do id \"$TMPL_INST\" to completed")"
  sleep 3
  note "  instance after: $(one "$TMPL_INST")"
  note "  template after complete: $(tidx)"

  note "---- lever 4: RESCHEDULE-repeat (change interval daily -> every 2 days) via the Repeat dialog ----"
  rsel; note "  open Reschedule dialog: $(rclick 'Reschedule…')"; sleep 2
  # the interval field is text field 1 of group 1 of the sheet on the main std window (UIC1 map)
  lab_ssh "$IP" '/usr/bin/osascript <<'\''AS'\'' 2>&1; echo "[exit $?]"
tell application "System Events" to tell process "Things3"
  set mw to first window whose subrole is "AXStandardWindow"
  set sh to sheet 1 of mw
  set value of text field 1 of group 1 of sh to "2"
  delay 0.4
  keystroke tab
  delay 0.4
  click button "OK" of sh
end tell
AS' </dev/null | tee -a "$REPORT"
  sleep 2
  note "  after RESCHEDULE: $(tidx)"
  note "VERDICT-1b: did the template todayIndex (=0 at rest) CHANGE under ANY lever? (expect NO — todayIndex is inert to repeat-series mutation)"
  exit 0
fi

# ==================================================================== arm2 (EVEHEAD)
if [ "$CMD" = "arm2" ]; then
  load_session
  note "################## ARM 2 — EVEHEAD (headed evening children) ##################"
  note "  EH-C1 (headed evening) seed: $(one "$EHC1")"
  note "  ---- 2b: evening bounce legs on the HEADED child C1: when=today then when=evening ----"
  note "     leg A: update?id=C1&when=today"
  gurl "things:///update?id=$EHC1&auth-token=$TOKEN&when=today"
  note "        after when=today (heading FK? project FK? startBucket? startDate?): $(one "$EHC1")"
  note "     leg B: update?id=C1&when=evening"
  gurl "things:///update?id=$EHC1&auth-token=$TOKEN&when=evening"
  note "        after when=evening: $(one "$EHC1")"
  note "     VERDICT-2b: does the today<->evening round-trip PRESERVE the heading FK (h=)? (someday<->anytime provably does — HEADORD-c)"

  note "  ---- 2c: micro-check — native project reorder over the UNHEADED evening child C2: does startBucket=1 survive? ----"
  # need >=2 unheaded members in the project scope for a meaningful reorder; C1 is under a heading.
  gurl "things:///add?title=EH-C3&when=evening&list-id=$EHP"; sleep 1
  EHC3=$(uuid_of EH-C3)
  note "     EH-C2 before: $(one "$EHC2")"
  note "     EH-C3 before: $(one "$EHC3")"
  note "     reorder to dos in project id EH-P with ids C3,C2 (scrambled): $(reord "project id \"$EHP\"" "$EHC3,$EHC2")"
  note "     EH-C2 after: $(one "$EHC2")"
  note "     EH-C3 after: $(one "$EHC3")"
  note "     VERDICT-2c: did the PROJECT-specifier reorder KEEP startBucket=1 (evening survives) or de-even it to sb=0 like the today-scope native reorder (O03)?"
  exit 0
fi

# ==================================================================== arm3 (AREADAY)
if [ "$CMD" = "arm3" ]; then
  load_session
  note "################## ARM 3 — AREADAY (an area's direct dated children) ##################"
  D1=$(uuid_of AD-1); D2=$(uuid_of AD-2); D3=$(uuid_of AD-3); D4=$(uuid_of AD-4)
  ANY=$(uuid_of AD-ANY); SOME=$(uuid_of AD-SOME)
  note "  dated children before: $(dumpday 'AD-%' | tr '\n' ' ')"
  note "  canary AD-ANY: $(one "$ANY")"
  note "  canary AD-SOME: $(one "$SOME")"
  note "  ---- create scratch PROJECT AD-SCRATCH ----"
  tjson '[{"type":"project","attributes":{"title":"AD-SCRATCH"}}]'; sleep 2
  SP=$(gq "SELECT uuid FROM TMTask WHERE title='AD-SCRATCH' AND type=1")
  note "     scratch=$SP"
  note "  ---- leg 1 PARK each dated child into the scratch project (area FK replaced; date/todayIndex/start=2 preserved?) ----"
  for u in "$D1" "$D2" "$D3" "$D4"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$SP"; done
  note "     after park: $(dumpday 'AD-%' | tr '\n' ' ')"
  note "  ---- leg 2 native container-day reorder (scrambled target AD-3,AD-1,AD-4,AD-2) ----"
  note "     result: $(reord "project id \"$SP\"" "$D3,$D1,$D4,$D2")"
  note "     after reorder (todayIndex re-rank AD-3<AD-1<AD-4<AD-2? date preserved?): $(dumpday 'AD-%' | tr '\n' ' ')"
  note "  ---- leg 3 RESTORE each into LAB-AREA-A (area FK restored; startDate+start=2 preserved; todayIndex ORDER=target; rem/dl intact) ----"
  for u in "$D1" "$D2" "$D3" "$D4"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$AA"; done
  note "     after restore: $(dumpday 'AD-%' | tr '\n' ' ')"
  note "     canary AD-ANY after: $(one "$ANY")"
  note "     canary AD-SOME after: $(one "$SOME")"
  note "  ---- trash the scratch project ----"
  gas "tell application \"Things3\" to move to do id \"$SP\" to list \"Trash\"" >/dev/null 2>&1 || true
  gas "tell application \"Things3\" to delete project id \"$SP\"" >/dev/null 2>&1 || true
  note "     scratch after trash: $(gq "SELECT title||' trashed='||trashed FROM TMTask WHERE uuid='$SP'")"
  note "     VERDICT-3: area-day protocol wireable? (all legs date/state-preserving, area FK round-trips, todayIndex order lands target, rem/dl survive, canaries untouched)"
  exit 0
fi

# ==================================================================== arm4 (UPCORD2)
if [ "$CMD" = "arm4" ]; then
  load_session
  note "################## ARM 4 — UPCORD2 (cross-container day interleave) ##################"
  L1=$(uuid_of UC-L1); L2=$(uuid_of UC-L2)
  P1=$(uuid_of UC-P1); P2=$(uuid_of UC-P2)
  A1=$(uuid_of UC-A1); A2=$(uuid_of UC-A2)
  note "  note: the golden daily template projects EVERY future day; its future projection is DISPLAY-ONLY (no TMTask row on $DAY_UP), so the DB todayIndex axis for this day = the 6 seeded rows only. Confirm no phantom row:"
  note "    dated type=0 rows sharing UC-L1's startDate (expect exactly 6): $(gq "SELECT COUNT(*) FROM TMTask WHERE startDate=(SELECT startDate FROM TMTask WHERE uuid='$L1') AND trashed=0 AND type=0")"
  note "  before: $(dumpday 'UC-%' | tr '\n' ' ')"
  note "  ---- create scratch PROJECT UC-SCRATCH, park ALL 6 ----"
  tjson '[{"type":"project","attributes":{"title":"UC-SCRATCH"}}]'; sleep 2
  SP=$(gq "SELECT uuid FROM TMTask WHERE title='UC-SCRATCH' AND type=1")
  note "     scratch=$SP"
  for u in "$L1" "$L2" "$P1" "$P2" "$A1" "$A2"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$SP"; done
  note "     after park: $(dumpday 'UC-%' | tr '\n' ' ')"
  note "  ---- container-day reorder to a scrambled GLOBAL interleave (UC-A2,UC-L1,UC-P2,UC-A1,UC-L2,UC-P1) ----"
  note "     result: $(reord "project id \"$SP\"" "$A2,$L1,$P2,$A1,$L2,$P1")"
  note "     after reorder: $(dumpday 'UC-%' | tr '\n' ' ')"
  note "  ---- RESTORE each to origin, in a DIFFERENT order than the target (order-irrelevance test) ----"
  # restore order deliberately scrambled vs target: P1, A1, L2, P2, A2, L1
  note "     restore UC-P1 -> project UC-P: "; gurl "things:///update?id=$P1&auth-token=$TOKEN&list-id=$UCP"
  note "     restore UC-A1 -> area A: ";       gurl "things:///update?id=$A1&auth-token=$TOKEN&list-id=$AA"
  note "     restore UC-L2 -> loose (empty list-id): "; gurl "things:///update?id=$L2&auth-token=$TOKEN&list-id="
  note "     restore UC-P2 -> project UC-P + heading UC-H: "; gurl "things:///update?id=$P2&auth-token=$TOKEN&list-id=$UCP&heading=UC-H"
  note "     restore UC-A2 -> area A: ";       gurl "things:///update?id=$A2&auth-token=$TOKEN&list-id=$AA"
  note "     restore UC-L1 -> loose (empty list-id): "; gurl "things:///update?id=$L1&auth-token=$TOKEN&list-id="
  note "     after restore: $(dumpday 'UC-%' | tr '\n' ' ')"
  note "  ---- trash the scratch project ----"
  gas "tell application \"Things3\" to move to do id \"$SP\" to list \"Trash\"" >/dev/null 2>&1 || true
  gas "tell application \"Things3\" to delete project id \"$SP\"" >/dev/null 2>&1 || true
  note "     scratch after trash: $(gq "SELECT title||' trashed='||trashed FROM TMTask WHERE uuid='$SP'")"
  note "     VERDICT-4: final GLOBAL todayIndex order == target (UC-A2<UC-L1<UC-P2<UC-A1<UC-L2<UC-P1)? every FK restored (loose a/p NULL; project p=UC-P; headed p=UC-P h=UC-H; area a=LAB-AREA-A)? startDate/start=2 preserved? rem+dl on UC-A2 intact? order-irrelevance held (restored out of target order)?"
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|grant|arm1cd|arm1b|arm2|arm3|arm4|teardown" >&2
exit 1
