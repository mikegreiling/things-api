#!/bin/bash
# ODDS1-B — oddities re-validation batch B: the modal/error classes, the
# heading cells batch A could not address, and the two remaining CRASH
# catalog triggers (§7 C3 and C2), run last, one at a time, with the app
# relaunched between them.
#
# Also isolates the unexplained `.ips` that appeared during batch A: does a
# malformed `things:///json` payload still raise an error MODAL on 3.23, or
# does it now kill the app?
#
# ONE disposable clone `odds1b-lab` of things-lab-golden-v4. Teardown on EXIT.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="odds1b-lab"
OUT="lab/artifacts/odds1b-lab"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[odds1b] $*" | tee -a "$REPORT"; }
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
ips_count() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }
ips_last() { lab_ssh "$IP" 'ls -t ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | head -1' </dev/null; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
relaunch() { lab_ssh "$IP" 'pkill -x Things3 >/dev/null 2>&1; sleep 3; open -g -a Things3; sleep 12' </dev/null; }
enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }

VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
BLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
note "env: Things $VER ($BLD) · clock $(lab_ssh "$IP" date </dev/null)"
lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
jsonurl() { echo "things:///json?auth-token=$TOKEN&data=$(enc "$1")"; }
winstate() {
  oas 'tell application "System Events" to tell process "Things3"
set w to count of windows
set s to 0
repeat with x in windows
set s to s + (count of sheets of x)
end repeat
return "windows=" & w & " sheets=" & s & " frontmost=" & (frontmost as text)
end tell'
}

note "ips baseline: $(ips_count) · $(winstate)"

########################################################################
note ""
note "===== CELL B1 (§2h / §4b) does a malformed json payload still raise a MODAL, or crash?"
I0=$(ips_count)
note "  pre : things=$(alive) ips=$I0 · $(winstate)"
ourl "$(jsonurl '[{"type":"to-do","attributes":{"title":"ODDS1-B-FRAC","creation-date":"2025-03-01T18:00:00.000Z"}}]')" >/dev/null
settle 8
note "  post: things=$(alive) ips=$(ips_count) · $(winstate)"
note "  rows created=$(gq "SELECT COUNT(*) FROM TMTask WHERE title='ODDS1-B-FRAC'")"
if [ "$(alive)" = "DEAD" ]; then
  note "  *** the app DIED — last ips: $(ips_last)"
  lab_ssh "$IP" "grep -o '\"exception\":{[^}]*}\|EXC_[A-Z_]*\|Trace/BPT trap: 5' $(ips_last) 2>/dev/null | head -3" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
fi
relaunch

########################################################################
note ""
note "===== CELL B2 (§4b) modal focus behavior by command class"
relaunch
lab_ssh "$IP" 'osascript -e "tell application \"Finder\" to activate" >/dev/null 2>&1; sleep 2' </dev/null
note "  baseline (Finder frontmost): $(winstate)"
ourl "things:///update?id=00000000000000000000000000&title=x" >/dev/null   # no auth token
settle 6
note "  after missing-token update : $(winstate)"
relaunch
lab_ssh "$IP" 'osascript -e "tell application \"Finder\" to activate" >/dev/null 2>&1; sleep 2' </dev/null
ourl "things:///delete?id=whatever&auth-token=$TOKEN" >/dev/null
settle 6
note "  after unsupported `delete`  : $(winstate)"
relaunch
lab_ssh "$IP" 'osascript -e "tell application \"Finder\" to activate" >/dev/null 2>&1; sleep 2' </dev/null
ourl "$(jsonurl '[{"type":"to-do","attributes":{"title":"ODDS1-B-BAD2","creation-date":"2025-01-15"}}]')" >/dev/null
settle 8
note "  after json payload error    : $(winstate) · things=$(alive) ips=$(ips_count)"
relaunch

########################################################################
note ""
note "===== CELL B3 (§4a) an open error modal does not block subsequent commands"
lab_ssh "$IP" 'osascript -e "tell application \"Finder\" to activate" >/dev/null 2>&1; sleep 2' </dev/null
ourl "things:///delete?id=whatever&auth-token=$TOKEN" >/dev/null; settle 5
note "  modal up: $(winstate)"
ourl "things:///add?title=ODDS1-B-BEHIND-MODAL&auth-token=$TOKEN" >/dev/null; settle 5
note "  URL add behind the modal -> rows=$(gq "SELECT COUNT(*) FROM TMTask WHERE title='ODDS1-B-BEHIND-MODAL'")"
note "  AppleScript write behind the modal: $(oas 'tell application "Things3" to make new to do with properties {name:"ODDS1-B-AS-BEHIND"}')"
settle 4
note "  -> rows=$(gq "SELECT COUNT(*) FROM TMTask WHERE title='ODDS1-B-AS-BEHIND'")"
note "  windows now: $(winstate)"
relaunch

########################################################################
note ""
note "===== CELL B4 heading census — what heading rows does the golden actually carry?"
note "  headings: $(gq "SELECT group_concat(title||'/'||uuid,' ') FROM TMTask WHERE type=2 AND trashed=0")"
HP=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-PROJ-HEADINGS' AND type=1 LIMIT 1")
note "  LAB-PROJ-HEADINGS=$HP children: $(gq "SELECT group_concat(title||':ty'||type,' ') FROM TMTask WHERE project='$HP' AND trashed=0")"
HA=$(gq "SELECT uuid FROM TMTask WHERE type=2 AND project='$HP' AND trashed=0 ORDER BY \"index\" LIMIT 1")
HAT=$(gq "SELECT title FROM TMTask WHERE uuid='$HA'")
HB=$(gq "SELECT uuid FROM TMTask WHERE type=2 AND project='$HP' AND trashed=0 ORDER BY \"index\" DESC LIMIT 1")
HBT=$(gq "SELECT title FROM TMTask WHERE uuid='$HB'")
note "  chosen: A=$HAT/$HA  B=$HBT/$HB"

########################################################################
note ""
note "===== CELL B5 (§2c) heading= on add only PLACES; it never CREATES a heading"
ourl "things:///add?title=ODDS1-B-NOHEAD&auth-token=$TOKEN&list-id=$HP&heading=ODDS1-NO-SUCH-HEADING" >/dev/null; settle 5
note "  add heading=<missing> -> $(gq "SELECT 'heading='||IFNULL(heading,'NULL')||' project='||IFNULL(project,'NULL') FROM TMTask WHERE title='ODDS1-B-NOHEAD' LIMIT 1") · heading rows named ODDS1-NO-SUCH-HEADING=$(gq "SELECT COUNT(*) FROM TMTask WHERE title='ODDS1-NO-SUCH-HEADING'")"
ourl "things:///add?title=ODDS1-B-HEADED&auth-token=$TOKEN&list-id=$HP&heading=$HAT" >/dev/null; settle 5
note "  add heading=<existing '$HAT'> -> $(gq "SELECT 'heading='||IFNULL(heading,'NULL') FROM TMTask WHERE title='ODDS1-B-HEADED' LIMIT 1")"

########################################################################
note ""
note "===== CELL B6 (§6a) heading 'canceled' stores COMPLETED but cascades CANCELED"
ourl "things:///add?title=ODDS1-HC-1&auth-token=$TOKEN&list-id=$HP&heading=$HAT" >/dev/null; settle 3
ourl "things:///add?title=ODDS1-HC-2&auth-token=$TOKEN&list-id=$HP&heading=$HAT" >/dev/null; settle 5
note "  children pre : $(gq "SELECT group_concat(title||':st'||status,' ') FROM TMTask WHERE heading='$HA' AND title LIKE 'ODDS1-HC-%'")"
note "  heading pre  : $(gq "SELECT 'st'||status||' stop='||IFNULL(stopDate,'NULL') FROM TMTask WHERE uuid='$HA'")"
note "  set status canceled: $(oas "tell application \"Things3\" to set status of to do id \"$HA\" to canceled")"
settle 5
note "  heading post : $(gq "SELECT 'st'||status||' stop='||IFNULL(stopDate,'NULL') FROM TMTask WHERE uuid='$HA'")"
note "  children post: $(gq "SELECT group_concat(title||':st'||status,' ') FROM TMTask WHERE heading='$HA' AND title LIKE 'ODDS1-HC-%'")"

########################################################################
note ""
note "===== CELL B7 (§5o) an open child landing under an ARCHIVED heading REOPENS it"
note "  archive heading B: $(oas "tell application \"Things3\" to set status of to do id \"$HB\" to completed")"
settle 4
note "  heading B: $(gq "SELECT 'st'||status||' stop='||IFNULL(stopDate,'NULL') FROM TMTask WHERE uuid='$HB'")"
ourl "things:///add?title=ODDS1-B-INTOARCH&auth-token=$TOKEN&list-id=$HP&heading=$HBT" >/dev/null; settle 6
note "  after add heading=<archived '$HBT'>: heading $(gq "SELECT 'st'||status||' stop='||IFNULL(stopDate,'NULL') FROM TMTask WHERE uuid='$HB'") · child $(gq "SELECT 'heading='||IFNULL(heading,'NULL') FROM TMTask WHERE title='ODDS1-B-INTOARCH' LIMIT 1")"

########################################################################
note ""
note "===== CELL B8 (§9l) a same-heading re-head is index-INERT"
for n in 1 2 3 4; do
  ourl "things:///add?title=ODDS1-RH$n&auth-token=$TOKEN&list-id=$HP&heading=$HBT&when=someday" >/dev/null; settle 3
done
settle 4
note "  before: $(gq "SELECT group_concat(title||':'||\"index\",' ') FROM (SELECT title,\"index\" FROM TMTask WHERE heading='$HB' AND title LIKE 'ODDS1-RH%' ORDER BY \"index\")")"
for n in 3 1 4 2; do
  U=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-RH$n' LIMIT 1")
  ourl "things:///update?id=$U&auth-token=$TOKEN&list-id=$HP&heading=$HBT" >/dev/null; settle 3
done
settle 4
note "  after : $(gq "SELECT group_concat(title||':'||\"index\",' ') FROM (SELECT title,\"index\" FROM TMTask WHERE heading='$HB' AND title LIKE 'ODDS1-RH%' ORDER BY \"index\")")"

########################################################################
note ""
note "===== CELL B9 (§9u) things:///show?id=later-projects — modal, or does it resolve?"
relaunch
lab_ssh "$IP" 'osascript -e "tell application \"Finder\" to activate" >/dev/null 2>&1; sleep 2' </dev/null
note "  pre : $(winstate)"
ourl "things:///show?id=later-projects" >/dev/null; settle 7
note "  post: $(winstate)"
note "  window titles: $(oas 'tell application "System Events" to tell process "Things3" to return (name of every window)')"
note "  sheet texts  : $(oas 'tell application "System Events" to tell process "Things3" to return (value of every static text of every sheet of every window)')"
note "  AS reorder specifier still resolves? $(oas 'tell application "Things3" to _private_experimental_ reorder to dos in list "Later Projects" with ids "x"')"
relaunch

########################################################################
note ""
note "===== CELL B10 (§8e) is there a dismiss-deadline affordance in the Items menu?"
lab_ssh "$IP" 'open -g -a Things3; sleep 4; osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
note "  Items menu: $(oas 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu 1 of menu bar item "Items" of menu bar 1)')"
note "  deadlineSuppressionDate via a reschedule to someday:"
ourl "things:///add?title=ODDS1-DLSUP&auth-token=$TOKEN&deadline=2026-07-01&when=today" >/dev/null; settle 5
DS=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-DLSUP' LIMIT 1")
note "    pre : $(gq "SELECT 'supp='||IFNULL(deadlineSuppressionDate,'NULL')||' start='||start FROM TMTask WHERE uuid='$DS'")"
ourl "things:///update?id=$DS&auth-token=$TOKEN&when=someday" >/dev/null; settle 5
note "    post: $(gq "SELECT 'supp='||IFNULL(deadlineSuppressionDate,'NULL')||' start='||start FROM TMTask WHERE uuid='$DS'")"

########################################################################
note ""
note "===== CELL B11 (§9bb) is there ANY delete confirmation sheet?"
relaunch
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
TDEL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  reveal + Edit menu on a repeating TEMPLATE ($TDEL)"
ourl "things:///show?id=$TDEL" >/dev/null; settle 4
note "  Edit menu delete item: $(oas 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu 1 of menu bar item "Edit" of menu bar 1)')"
note "  pre : $(winstate)"
oas 'tell application "System Events" to tell process "Things3" to keystroke (ASCII character 8) using command down' >/dev/null
settle 5
note "  post ⌘⌫: $(winstate)"
note "  template trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$TDEL'")"

########################################################################
note ""
note "===== CELL B12 (§9cc) an open modal SHEET blocks AppleScript object-model mutations"
relaunch
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
ourl "things:///add?title=ODDS1-SESSGATE&auth-token=$TOKEN" >/dev/null; settle 4
SG=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-SESSGATE' LIMIT 1")
T2=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
ourl "things:///show?id=$T2" >/dev/null; settle 4
note "  open Items > Repeat > Edit Rule…: $(oas 'tell application "System Events" to tell process "Things3"
click menu bar item "Items" of menu bar 1
delay 1
click menu item "Repeat" of menu 1 of menu bar item "Items" of menu bar 1
delay 1
return (name of every menu item of menu 1 of menu item "Repeat" of menu 1 of menu bar item "Items" of menu bar 1)
end tell')"
oas 'tell application "System Events" to tell process "Things3"
try
click menu item "Edit Rule…" of menu 1 of menu item "Repeat" of menu 1 of menu bar item "Items" of menu bar 1
end try
end tell' >/dev/null
settle 4
note "  sheet state: $(winstate)"
note "  AS delete while the sheet is up: $(oas "tell application \"Things3\" to delete to do id \"$SG\"")"
settle 3
note "  -> trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$SG'")"
oas 'tell application "System Events" to tell process "Things3" to key code 53' >/dev/null
settle 3
note "  after Escape: $(winstate)"
note "  AS delete again: $(oas "tell application \"Things3\" to delete to do id \"$SG\"")"
settle 3
note "  -> trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$SG'")"

########################################################################
note ""
note "===== CELL B13 (§9dd) is Items > Repeat… present when Things is BACKGROUNDED?"
relaunch
ourl "things:///show?id=$T2" >/dev/null; settle 4
lab_ssh "$IP" 'osascript -e "tell application \"Finder\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
note "  backgrounded, selection=$(oas 'tell application "Things3" to return (id of every to do of selected to dos)')"
note "  Items menu (backgrounded): $(oas 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu 1 of menu bar item "Items" of menu bar 1)')"
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
note "  Items menu (frontmost)   : $(oas 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu 1 of menu bar item "Items" of menu bar 1)')"

########################################################################
note ""
note "########## HAZARD GROUP — crash triggers, one at a time ##########"
relaunch
note ""
note "===== CELL B14 (§6 / §7 C3) AppleScript schedule on a HEADING row"
HZ=$(gq "SELECT uuid FROM TMTask WHERE type=2 AND trashed=0 AND status=0 LIMIT 1")
HZT=$(gq "SELECT title FROM TMTask WHERE uuid='$HZ'")
I1=$(ips_count)
PID1=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null)
note "  target heading $HZT/$HZ · pid=$PID1 ips=$I1"
note "  get properties (control): $(oas "tell application \"Things3\" to get name of to do id \"$HZ\"")"
note "  schedule heading        : $(oas "tell application \"Things3\" to schedule to do id \"$HZ\" for (date \"7/8/2026\")")"
settle 10
note "  after: things=$(alive) pid=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null) ips $I1 -> $(ips_count)"
note "  heading row unchanged? $(gq "SELECT 'st'||status||' sd='||IFNULL(startDate,'NULL')||' start='||start FROM TMTask WHERE uuid='$HZ'")"
L=$(ips_last)
note "  last ips: $L"
[ -n "$L" ] && lab_ssh "$IP" "python3 -c \"import json,sys;d=json.loads(open('$L').read().split(chr(10),1)[1]);print('  app_version',d.get('app_version'),'build',d.get('build_version'));print('  termination',json.dumps(d.get('termination'))[:200]);print('  exception',json.dumps(d.get('exception'))[:200])\" 2>&1" </dev/null | tee -a "$REPORT"

relaunch
note ""
note "===== CELL B15 (§7 C2) URL update-project?when= on a repeating PROJECT template"
TPRJ=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-WEEKLY-PROJ' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
I2=$(ips_count)
PID2=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null)
BEF=$(gq "SELECT 'st'||status||' start='||start||' sd='||IFNULL(startDate,'NULL')||' umd='||userModificationDate FROM TMTask WHERE uuid='$TPRJ'")
note "  target project template $TPRJ · pid=$PID2 ips=$I2"
note "  before: $BEF"
ourl "things:///update-project?id=$TPRJ&auth-token=$TOKEN&when=today" >/dev/null
settle 12
note "  after : things=$(alive) pid=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null) ips $I2 -> $(ips_count)"
relaunch
note "  row  : $(gq "SELECT 'st'||status||' start='||start||' sd='||IFNULL(startDate,'NULL')||' umd='||userModificationDate FROM TMTask WHERE uuid='$TPRJ'")"
note "  byte-identical: $([ "$BEF" = "$(gq "SELECT 'st'||status||' start='||start||' sd='||IFNULL(startDate,'NULL')||' umd='||userModificationDate FROM TMTask WHERE uuid='$TPRJ'")" ] && echo yes || echo no)"
L2=$(ips_last)
note "  last ips: $L2"
[ -n "$L2" ] && lab_ssh "$IP" "python3 -c \"import json,sys;d=json.loads(open('$L2').read().split(chr(10),1)[1]);print('  app_version',d.get('app_version'),'build',d.get('build_version'));print('  termination',json.dumps(d.get('termination'))[:200]);print('  exception',json.dumps(d.get('exception'))[:200])\" 2>&1" </dev/null | tee -a "$REPORT"

note ""
note "final: things=$(alive) ips=$(ips_count)"
note "all ips: $(lab_ssh "$IP" 'ls -t ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | xargs -n1 basename 2>/dev/null | tr "\n" " "' </dev/null)"
note "ODDS1-B done"
