#!/bin/bash
# ODDS1-D — oddities re-validation batch D: the clock-roll cells (§9n, §9z,
# §9x), the residuals batch C left inconclusive (§9bb project arm, §8j
# AXEnhancedUserInterface with a read-back), and — last, one at a time — the
# schedule-KEYWORD crash matrix on repeating templates, which batch A's stray
# `.ips` pointed at.
#
# ONE disposable clone `odds1d-lab` of things-lab-golden-v4. Teardown on EXIT.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="odds1d-lab"
OUT="lab/artifacts/odds1d-lab"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[odds1d] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

GOLDEN="${GOLDEN:-things-lab-golden-v4}"
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"
cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — $VM left running at $IP"; return; fi
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done"
}
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 -noheader -list "file:$DB?mode=ro" "$1"
EOF
lab_ssh "$IP" 'cat > ~/labh/ourl.sh && chmod +x ~/labh/ourl.sh' <<'EOF'
#!/bin/bash
u=$(printf %s "$1" | base64 --decode)
open -g "$u"; echo "EXIT=$?"
EOF
lab_ssh "$IP" 'cat > ~/labh/oas.sh && chmod +x ~/labh/oas.sh' <<'EOF'
#!/bin/bash
printf %s "$1" | base64 --decode > /tmp/odds1.scpt
osascript /tmp/odds1.scpt 2>&1; echo "EXIT=$?"
EOF

gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
b64() { printf %s "$1" | base64; }
ourl() { lab_ssh "$IP" "~/labh/ourl.sh $(b64 "$1")" </dev/null; }
oas() { lab_ssh "$IP" "~/labh/oas.sh $(b64 "$1")" </dev/null | tr '\n' ' '; }
settle() { lab_ssh "$IP" "sleep ${1:-3}" </dev/null; }
ipsn() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }
pidt() { lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null; }
relaunch() { lab_ssh "$IP" 'pkill -x Things3 >/dev/null 2>&1; sleep 4; open -g -a Things3; sleep 14' </dev/null; }
roll() { lab_ssh "$IP" "sudo date $1 >/dev/null" </dev/null; note "  --- clock rolled to $(lab_ssh "$IP" date </dev/null)"; relaunch; }

VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
note "env: Things $VER · clock $(lab_ssh "$IP" date </dev/null)"
lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null

########################################################################
note ""
note "===== CELL D0 — seeds at the pinned 2026-07-05"
ourl "things:///add?title=ODDS1-D-EVE&auth-token=$TOKEN&when=evening" >/dev/null
ourl "things:///add?title=ODDS1-D-REM&auth-token=$TOKEN&when=today@18:00" >/dev/null
ourl "things:///add?title=ODDS1-D-DATED&auth-token=$TOKEN&when=2026-07-06" >/dev/null
ourl "things:///add?title=ODDS1-D-SDDL&auth-token=$TOKEN&when=someday&deadline=2026-07-06" >/dev/null; settle 8
EVE=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-D-EVE' LIMIT 1")
REM=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-D-REM' LIMIT 1")
DTD=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-D-DATED' LIMIT 1")
SDL=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-D-SDDL' LIMIT 1")
row() { gq "SELECT 'start='||start||' sb='||startBucket||' sd='||IFNULL(startDate,'NULL')||' rem='||IFNULL(reminderTime,'NULL')||' st='||status||' dl='||IFNULL(deadline,'NULL') FROM TMTask WHERE uuid='$1'"; }
note "  EVE  : $(row "$EVE")"
note "  REM  : $(row "$REM")"
note "  DATED: $(row "$DTD")"
note "  SDDL : $(row "$SDL")"
ourl "things:///update?id=$DTD&auth-token=$TOKEN&completed=true" >/dev/null
ourl "things:///update?id=$SDL&auth-token=$TOKEN&completed=true" >/dev/null; settle 5
note "  log completed now: $(oas 'tell application "Things3" to log completed now')"
settle 5
note "  DATED completed+swept: $(row "$DTD")"
note "  SDDL  completed+swept: $(row "$SDL")"
TDL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
tmpl() { gq "SELECT 'icCount='||IFNULL(rt1_instanceCreationCount,'NULL')||' next='||IFNULL(rt1_nextInstanceStartDate,'NULL')||' icStart='||IFNULL(rt1_instanceCreationStartDate,'NULL')||' umd='||userModificationDate FROM TMTask WHERE uuid='$TDL'"; }
inst() { gq "SELECT COUNT(*)||' :: '||IFNULL(group_concat(IFNULL(startDate,'NULL'),','),'-') FROM TMTask WHERE rt1_repeatingTemplate='$TDL' AND trashed=0"; }
note "  template: $(tmpl)"
note "  instances: $(inst)"

########################################################################
note ""
note "===== CELL D1 (§9x) a forward clock step materializes early; the reverse step does NOT roll it back"
roll 070612002026
note "  after +1 day: template $(tmpl)"
note "  after +1 day: instances $(inst)"
roll 070512002026
note "  after roll BACK: template $(tmpl)"
note "  after roll BACK: instances $(inst)"

########################################################################
note ""
note "===== CELL D2 (§9n REMSTALE) a stale This-Evening flag / reminder byte is never cleared"
roll 070812002026
note "  EVE after 3 days: $(row "$EVE")"
note "  REM after 3 days: $(row "$REM")"
note "  (the bytes above must be byte-identical to the D0 seeds)"

########################################################################
note ""
note "===== CELL D3 (§9n REMREV) a reschedule CLEARS a stale reminder, PRESERVES a live one"
ourl "things:///update?id=$REM&auth-token=$TOKEN&when=2026-07-10" >/dev/null; settle 6
note "  stale REM rescheduled to 07-10: $(row "$REM")"
ourl "things:///add?title=ODDS1-D-LIVE&auth-token=$TOKEN&when=today@18:00" >/dev/null; settle 6
LIV=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-D-LIVE' LIMIT 1")
note "  fresh LIVE reminder: $(row "$LIV")"
ourl "things:///update?id=$LIV&auth-token=$TOKEN&when=2026-07-11" >/dev/null; settle 6
note "  live rescheduled to 07-11: $(row "$LIV")"
note "  AppleScript schedule of a stale reminder:"
ourl "things:///add?title=ODDS1-D-STALE2&auth-token=$TOKEN&when=2026-07-06@18:00" >/dev/null; settle 6
ST2=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-D-STALE2' LIMIT 1")
note "    seeded (past date): $(row "$ST2")"
note "    $(oas "tell application \"Things3\" to schedule to do id \"$ST2\" for (date \"7/12/2026\")")"
settle 5
note "    after AS schedule: $(row "$ST2")"

########################################################################
note ""
note "===== CELL D4 (§9z) reactivating a swept DATED to-do re-derives its when"
ourl "things:///update?id=$DTD&auth-token=$TOKEN&completed=false" >/dev/null
ourl "things:///update?id=$SDL&auth-token=$TOKEN&completed=false" >/dev/null; settle 8
note "  DATED (was start=2 sd=07-06) reactivated: $(row "$DTD")"
note "  SDDL  (was someday + overdue deadline)  : $(row "$SDL")"

########################################################################
note ""
note "===== CELL D5 (§8s/§8d) the Today 'N new to-dos' banner on 3.23"
note "  provisional Today members (start<>1 OR startDate IS NULL) among today's set:"
note "  $(gq "SELECT COUNT(*) FROM TMTask WHERE trashed=0 AND status=0 AND ((start=1 AND startDate IS NOT NULL AND startDate<=132806144) OR (todayIndexReferenceDate IS NOT NULL AND (start<>1 OR startDate IS NULL)))")"
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
ourl "things:///show?id=today" >/dev/null; settle 5
note "  AX buttons in the standard window: $(oas 'tell application "System Events" to tell process "Things3" to return (name of every button of (first window whose subrole is "AXStandardWindow"))')"
note "  AX groups/desc: $(oas 'tell application "System Events" to tell process "Things3" to return (description of every UI element of (first window whose subrole is "AXStandardWindow"))')"

########################################################################
note ""
note "===== CELL D6 (§9bb) does a PROJECT with open children prompt on delete? (proper selection)"
relaunch
ourl "things:///add-project?title=ODDS1-D-PROJ&auth-token=$TOKEN&to-dos=k1%0Ak2" >/dev/null; settle 7
PRJ=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-D-PROJ' AND type=1 LIMIT 1")
note "  project=$PRJ open children=$(gq "SELECT COUNT(*) FROM TMTask WHERE project='$PRJ' AND trashed=0 AND status=0")"
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
ourl "things:///show?id=anytime" >/dev/null; settle 5
note "  select the project row by AS: $(oas "tell application \"System Events\" to tell process \"Things3\"
set t to first table of first scroll area of (first window whose subrole is \"AXStandardWindow\")
set n to count of rows of t
set found to \"none\"
repeat with i from 1 to n
select (row i of t)
delay 0.3
tell application \"Things3\" to set sel to (name of selected to dos)
if (sel as text) contains \"ODDS1-D-PROJ\" then
set found to \"row \" & i
exit repeat
end if
end repeat
return found
end tell")"
note "  Edit menu: $(oas 'tell application "System Events" to tell process "Things3" to return (name of menu item 8 of menu 1 of menu bar item "Edit" of menu bar 1)')"
S0=$(oas 'tell application "System Events" to tell process "Things3" to return (count of sheets of (first window whose subrole is "AXStandardWindow"))')
oas 'tell application "System Events" to tell process "Things3" to keystroke (ASCII character 8) using command down' >/dev/null
settle 5
note "  sheets $S0 -> $(oas 'tell application "System Events" to tell process "Things3" to return (count of sheets of (first window whose subrole is "AXStandardWindow"))')"
note "  sheet text: $(oas 'tell application "System Events" to tell process "Things3"
set o to ""
repeat with w in windows
repeat with s in sheets of w
set o to o & (value of every static text of s as text) & " [" & (name of every button of s as text) & "]"
end repeat
end repeat
return o
end tell')"
note "  project trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$PRJ'")"
oas 'tell application "System Events" to tell process "Things3" to key code 53' >/dev/null

########################################################################
note ""
note "===== CELL D7 (§8j) AXEnhancedUserInterface — with a read-back"
relaunch
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
note "  before: elements=$(oas 'tell application "System Events" to tell process "Things3" to return (count of UI elements of (first window whose subrole is "AXStandardWindow"))') attr=$(oas 'tell application "System Events" to tell process "Things3" to return (value of attribute "AXEnhancedUserInterface" as text)')"
oas 'tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to true' >/dev/null
settle 3
note "  after set true: attr=$(oas 'tell application "System Events" to tell process "Things3" to return (value of attribute "AXEnhancedUserInterface" as text)') elements=$(oas 'tell application "System Events" to tell process "Things3" to return (count of UI elements of (first window whose subrole is "AXStandardWindow"))') entire=$(oas 'tell application "System Events" to tell process "Things3" to return (count of entire contents of (first window whose subrole is "AXStandardWindow"))')"
oas 'tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false' >/dev/null

########################################################################
note ""
note "########## HAZARD GROUP — the schedule-KEYWORD matrix on repeating templates ##########"
TPRJ=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-WEEKLY-PROJ' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
hazard() { # hazard <label> <url>
  relaunch
  local p0 i0 p1 i1 b a
  p0=$(pidt); i0=$(ipsn)
  b=$(gq "SELECT 'st'||status||' start='||start||' sd='||IFNULL(startDate,'NULL')||' umd='||userModificationDate FROM TMTask WHERE uuid='$3'")
  ourl "$2" >/dev/null
  settle 12
  p1=$(pidt); i1=$(ipsn)
  relaunch
  a=$(gq "SELECT 'st'||status||' start='||start||' sd='||IFNULL(startDate,'NULL')||' umd='||userModificationDate FROM TMTask WHERE uuid='$3'")
  note "  [$1] pid $p0->$p1 ips $i0->$i1 :: $([ "$p0" = "$p1" ] && echo SURVIVED || echo 'CRASH — process death') :: row $([ "$b" = "$a" ] && echo byte-identical || echo "CHANGED  before[$b] after[$a]")"
}
note ""
note "  --- repeating PROJECT template ($TPRJ)"
hazard "update-project when=someday" "things:///update-project?id=$TPRJ&auth-token=$TOKEN&when=someday" "$TPRJ"
hazard "update-project when=anytime" "things:///update-project?id=$TPRJ&auth-token=$TOKEN&when=anytime" "$TPRJ"
hazard "update-project when=today"   "things:///update-project?id=$TPRJ&auth-token=$TOKEN&when=today" "$TPRJ"
note ""
note "  --- repeating TO-DO template ($TDL)"
hazard "update when=someday" "things:///update?id=$TDL&auth-token=$TOKEN&when=someday" "$TDL"
hazard "update when=anytime" "things:///update?id=$TDL&auth-token=$TOKEN&when=anytime" "$TDL"
hazard "update when=2026-07-09" "things:///update?id=$TDL&auth-token=$TOKEN&when=2026-07-09" "$TDL"

note ""
note "final ips=$(ipsn)"
note "all ips: $(lab_ssh "$IP" 'ls -t ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | xargs -n1 basename 2>/dev/null | tr "\n" " "' </dev/null)"
note "ODDS1-D done"
