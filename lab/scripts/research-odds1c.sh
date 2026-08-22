#!/bin/bash
# ODDS1-C — oddities re-validation batch C: the menu / AX / Shortcuts census,
# the §4b focus re-measurement, the NEW 3.23 delete-confirmation sheet, and an
# isolation pass for the unexplained `.ips` that appeared during batch A.
#
# ONE disposable clone `odds1c-lab` of things-lab-golden-v4. Teardown on EXIT.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="odds1c-lab"
OUT="lab/artifacts/odds1c-lab"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[odds1c] $*" | tee -a "$REPORT"; }
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
lab_ssh "$IP" 'cat > ~/labh/sc.sh && chmod +x ~/labh/sc.sh' <<'EOF'
#!/bin/bash
# sc.sh <shortcut-name> <base64-json-input>
printf %s "$2" | base64 --decode > /tmp/odds1-in.json
rm -f /tmp/odds1-out.txt
shortcuts run "$1" --input-path /tmp/odds1-in.json --output-path /tmp/odds1-out.txt 2>&1
echo "EXIT=$?"
[ -f /tmp/odds1-out.txt ] && echo "OUT=$(head -c 300 /tmp/odds1-out.txt | tr '\n' ' ')"
EOF

gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
b64() { printf %s "$1" | base64; }
ourl() { lab_ssh "$IP" "~/labh/ourl.sh $(b64 "$1")" </dev/null; }
oas() { lab_ssh "$IP" "~/labh/oas.sh $(b64 "$1")" </dev/null | tr '\n' ' '; }
sc() { lab_ssh "$IP" "~/labh/sc.sh $(printf '%q' "$1") $(b64 "$2")" </dev/null | tr '\n' ' '; }
settle() { lab_ssh "$IP" "sleep ${1:-3}" </dev/null; }
ipsn() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }
pidof_things() { lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null; }
relaunch() { lab_ssh "$IP" 'pkill -x Things3 >/dev/null 2>&1; sleep 3; open -g -a Things3; sleep 12' </dev/null; }
front() { oas 'tell application "System Events" to tell process "Things3" to return "windows=" & (count of windows) & " frontmost=" & (frontmost as text)'; }
sheets() { oas 'tell application "System Events" to tell process "Things3"
set s to 0
repeat with x in windows
set s to s + (count of sheets of x)
end repeat
return s
end tell'; }

VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
BLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
note "env: Things $VER ($BLD) · clock $(lab_ssh "$IP" date </dev/null)"
lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null

########################################################################
note ""
note "===== CELL C1 — isolate the unexplained .ips (each batch-A-unique step, pid+ips watched)"
step() { # step <label> <kind:as|url> <payload>
  local L="$1" K="$2" P="$3" p0 i0 r
  p0=$(pidof_things); i0=$(ipsn)
  if [ "$K" = as ]; then r=$(oas "$P"); else r=$(ourl "$P"); fi
  settle 6
  local p1 i1; p1=$(pidof_things); i1=$(ipsn)
  local flag=""; [ "$p0" != "$p1" ] && flag=" *** PID CHANGED"; [ "$i0" != "$i1" ] && flag="$flag *** IPS $i0->$i1"
  note "  [$L] pid $p0->$p1 ips $i0->$i1 :: ${r:0:150}$flag"
  [ -n "$flag" ] && relaunch
  return 0
}
ourl "things:///add?title=ODDS1-C-A&auth-token=$TOKEN" >/dev/null
ourl "things:///add?title=ODDS1-C-B&auth-token=$TOKEN" >/dev/null
ourl "things:///add?title=ODDS1-C-C&auth-token=$TOKEN&deadline=2026-07-20" >/dev/null; settle 6
CA=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-C-A' LIMIT 1")
CB=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-C-B' LIMIT 1")
CC=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-C-C' LIMIT 1")
PJ=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-PROJ-PLAIN' AND type=1 LIMIT 1")
step "A-cell1 completion-date=" url "things:///update?id=$CA&auth-token=$TOKEN&completion-date=2025-01-15"
step "A-cell1 creation-date="   url "things:///update?id=$CA&auth-token=$TOKEN&creation-date=2025-01-15"
step "A-cell3 delete completed" as "tell application \"Things3\" to delete to do id \"$CA\""
step "A-cell3 trash-list whose" as "tell application \"Things3\" to delete (first to do of list \"Trash\" whose id is \"$CB\")"
step "A-cell4 set completion date" as "tell application \"Things3\" to set completion date of to do id \"$CB\" to (date \"7/1/2026\")"
step "A-cell4 set creation date"   as "tell application \"Things3\" to set creation date of to do id \"$CB\" to (date \"1/2/2025\")"
step "A-cell6 set status of empty id" as "tell application \"Things3\" to set status of to do id \"\" to canceled"
step "A-cell7 set tag names ghost" as "tell application \"Things3\" to set tag names of to do id \"$CB\" to \"LAB-TAG-1, ODDS1-C-GHOST\""
step "A-cell8 when=ISO@evening"  url "things:///add?title=ODDS1-C-XD&auth-token=$TOKEN&when=2026-07-06@evening"
step "A-cell10 set due date missing value" as "tell application \"Things3\" to set due date of to do id \"$CC\" to missing value"
step "A-cell13 move template Anytime" as "tell application \"Things3\" to move (to do id \"$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-WEEKLY-PROJ' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")\") to list \"Anytime\""
step "A-cell13 schedule template" as "tell application \"Things3\" to schedule to do id \"$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")\" for (date \"7/8/2026\")"
step "A-cell15 move project bogus area" as "tell application \"Things3\" to move project id \"$PJ\" to area id \"ODDS1-NOT-A-REAL-UUID\""
step "A-cell19 make new area" as "tell application \"Things3\" to make new area with properties {name:\"ODDS1-C-AREA\"}"
step "A-cell19 log completed now" as "tell application \"Things3\" to log completed now"
note "  isolation total ips=$(ipsn)"

########################################################################
note ""
note "===== CELL C2 (§4b) modal focus behavior by command class — re-measured, 2 runs each"
for run in 1 2; do
  for k in badtoken delete json; do
    relaunch
    lab_ssh "$IP" 'osascript -e "tell application \"Finder\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
    B="$(front)"
    case "$k" in
      badtoken) ourl "things:///update?id=$CC&title=ODDS1-NOPE" >/dev/null ;;
      delete)   ourl "things:///delete?id=$CC&auth-token=$TOKEN" >/dev/null ;;
      json)     ourl "things:///json?auth-token=$TOKEN&data=%5B%7B%22type%22%3A%22to-do%22%2C%22attributes%22%3A%7B%22title%22%3A%22ODDS1-C-BAD%22%2C%22creation-date%22%3A%222025-01-15%22%7D%7D%5D" >/dev/null ;;
    esac
    settle 2; A2="$(front) sheets=$(sheets)"
    settle 6; A8="$(front) sheets=$(sheets)"
    note "  run$run $k :: before[$B] +2s[$A2] +8s[$A8]"
  done
done

########################################################################
note ""
note "===== CELL C3 (§9bb) 3.23 delete confirmation — which classes prompt?"
sheetdump() { oas 'tell application "System Events" to tell process "Things3"
set o to ""
repeat with w in windows
repeat with s in sheets of w
set o to o & "TEXT:" & (value of every static text of s as text) & " BUTTONS:" & (name of every button of s as text) & " | "
end repeat
end repeat
return o
end tell'; }
delprobe() { # delprobe <label> <uuid>
  relaunch
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 2' </dev/null
  ourl "things:///show?id=$2" >/dev/null; settle 4
  local s0; s0=$(sheets)
  oas 'tell application "System Events" to tell process "Things3" to keystroke (ASCII character 8) using command down' >/dev/null
  settle 5
  note "  [$1] sheets $s0 -> $(sheets) :: $(sheetdump)"
  note "      trashed=$(gq "SELECT IFNULL((SELECT trashed FROM TMTask WHERE uuid='$2'),'gone')") rows=$(gq "SELECT COUNT(*) FROM TMTask WHERE uuid='$2'")"
  oas 'tell application "System Events" to tell process "Things3" to key code 53' >/dev/null
  settle 2
}
TDL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
TIN=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TDL' AND trashed=0 LIMIT 1")
ourl "things:///add?title=ODDS1-C-PLAIN&auth-token=$TOKEN&when=today" >/dev/null; settle 5
PLN=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-C-PLAIN' LIMIT 1")
delprobe "plain to-do" "$PLN"
delprobe "repeating INSTANCE" "$TIN"
delprobe "repeating TO-DO TEMPLATE" "$TDL"
note "  project with open children:"
ourl "things:///add-project?title=ODDS1-C-PROJ&auth-token=$TOKEN&when=today&to-dos=k1%0Ak2" >/dev/null; settle 6
PRJ=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-C-PROJ' AND type=1 LIMIT 1")
note "    children=$(gq "SELECT COUNT(*) FROM TMTask WHERE project='$PRJ' AND trashed=0 AND status=0")"
delprobe "project + open children" "$PRJ"

########################################################################
note ""
note "===== CELL C4 (§8g/§8j/§8r) the 3.23 Items ▸ Repeat menu — Stop, Show Latest, parity"
menudump() { oas "tell application \"System Events\" to tell process \"Things3\"
try
return (name of every menu item of menu 1 of menu item \"Repeat\" of menu 1 of menu bar item \"Items\" of menu bar 1)
on error e
return \"ERR: \" & e
end try
end tell"; }
relaunch
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 2' </dev/null
ourl "things:///show?id=$PLN" >/dev/null; settle 4
note "  PLAIN to-do selected — Items menu: $(oas 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu 1 of menu bar item "Items" of menu bar 1)')"
note "  PLAIN to-do selected — Repeat submenu: $(menudump)"
ourl "things:///show?id=$TDL" >/dev/null; settle 4
note "  TEMPLATE selected — Items menu: $(oas 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu 1 of menu bar item "Items" of menu bar 1)')"
note "  TEMPLATE selected — Repeat submenu: $(menudump)"
note "  (§8r) trash every instance of the template, then re-read the submenu"
for u in $(gq "SELECT group_concat(uuid,' ') FROM TMTask WHERE rt1_repeatingTemplate='$TDL' AND trashed=0"); do
  oas "tell application \"Things3\" to delete to do id \"$u\"" >/dev/null
done
settle 4
oas 'tell application "Things3" to empty trash' >/dev/null; settle 6
note "  live instances now=$(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$TDL' AND trashed=0")"
relaunch
ourl "things:///show?id=$TDL" >/dev/null; settle 4
note "  TEMPLATE (0 instances) — Repeat submenu: $(menudump)"

########################################################################
note ""
note "===== CELL C5 (§9dd) is the plain Repeat entry frontmost-dependent on 3.23?"
relaunch
ourl "things:///show?id=$PLN" >/dev/null; settle 4
lab_ssh "$IP" 'osascript -e "tell application \"Finder\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
note "  backgrounded, AS selection=$(oas 'tell application "Things3" to return (name of selected to dos)')"
note "  backgrounded Items menu: $(oas 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu 1 of menu bar item "Items" of menu bar 1)')"
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
note "  frontmost    Items menu: $(oas 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu 1 of menu bar item "Items" of menu bar 1)')"

########################################################################
note ""
note "===== CELL C6 (§8h/§8j) AX-tree facts: window 1, AXEnhancedUserInterface, entire contents"
note "  windows: $(oas 'tell application "System Events" to tell process "Things3" to return (name of every window) & (subrole of every window as text) & (size of every window as text)')"
note "  UI elements of standard window: $(oas 'tell application "System Events" to tell process "Things3" to return (count of UI elements of (first window whose subrole is "AXStandardWindow"))')"
note "  set AXEnhancedUserInterface true: $(oas 'tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to true')"
settle 2
note "  UI elements after: $(oas 'tell application "System Events" to tell process "Things3" to return (count of UI elements of (first window whose subrole is "AXStandardWindow"))')"
oas 'tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false' >/dev/null
settle 2
note "  UI elements restored: $(oas 'tell application "System Events" to tell process "Things3" to return (count of UI elements of (first window whose subrole is "AXStandardWindow"))')"
note "  entire contents count: $(oas 'tell application "System Events" to tell process "Things3" to return (count of entire contents of (first window whose subrole is "AXStandardWindow"))')"

########################################################################
note ""
note "===== CELL C7 (§8c) the logInterval enum in Settings"
note "  TMSettings.logInterval = $(gq "SELECT logInterval FROM TMSettings")"
relaunch
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 2' </dev/null
oas 'tell application "System Events" to tell process "Things3" to keystroke "," using command down' >/dev/null
settle 5
note "  settings windows: $(oas 'tell application "System Events" to tell process "Things3" to return (name of every window)')"
note "  popups: $(oas 'tell application "System Events" to tell process "Things3" to return (value of every pop up button of window "General")')"
note "  logInterval popup items: $(oas 'tell application "System Events" to tell process "Things3"
set p to pop up button 3 of window "General"
click p
delay 1
set r to (name of every menu item of menu 1 of p)
key code 53
return r
end tell')"
oas 'tell application "System Events" to tell process "Things3" to keystroke "w" using command down' >/dev/null

########################################################################
note ""
note "===== CELL C8 (§5k/§5l/§8b) Shortcuts Edit Items — silent failures"
relaunch
ourl "things:///add?title=ODDS1-SC-PARENT&auth-token=$TOKEN&list-id=$PJ" >/dev/null
ourl "things:///add?title=ODDS1-SC-REM&auth-token=$TOKEN&when=2026-07-09@15:00" >/dev/null; settle 6
SP=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-SC-PARENT' LIMIT 1")
SR=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-SC-REM' LIMIT 1")
PJ2=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-C-PROJ' AND type=1 LIMIT 1")
note "  pre parent-target: $(gq "SELECT 'project='||IFNULL(project,'NULL') FROM TMTask WHERE uuid='$SP'")"
note "  set-detail Parent=<project uuid as TEXT>: $(sc things-proxy-set-detail "{\"id\":\"$SP\",\"detail\":\"Parent\",\"value\":\"$PJ2\"}")"
settle 5
note "  post: $(gq "SELECT 'project='||IFNULL(project,'NULL')||' heading='||IFNULL(heading,'NULL') FROM TMTask WHERE uuid='$SP'")"
note "  pre reminder: $(gq "SELECT IFNULL(reminderTime,'NULL') FROM TMTask WHERE uuid='$SR'")"
note "  set-detail Reminder Time='14:30' (text): $(sc things-proxy-set-detail "{\"id\":\"$SR\",\"detail\":\"Reminder Time\",\"value\":\"14:30\"}")"
settle 5
note "  post reminder: $(gq "SELECT IFNULL(reminderTime,'NULL') FROM TMTask WHERE uuid='$SR'")"
note "  set-detail Reminder Time='' (the working in-place clear, S-detail): $(sc things-proxy-set-detail "{\"id\":\"$SR\",\"detail\":\"Reminder Time\",\"value\":\"\"}")"
settle 5
note "  post clear: $(gq "SELECT 'rem='||IFNULL(reminderTime,'NULL')||' sd='||IFNULL(startDate,'NULL') FROM TMTask WHERE uuid='$SR'")"
note "  set-detail Completion Date (scf2 P4a class): $(sc things-proxy-set-detail "{\"id\":\"$SP\",\"detail\":\"Completion Date\",\"value\":\"2025-01-15\"}")"
settle 4
note "  post: $(gq "SELECT 'status='||status||' stop='||IFNULL(stopDate,'NULL') FROM TMTask WHERE uuid='$SP'")"
note "  (§8b) set-detail Reminder Time='' on a repeating TEMPLATE:"
TREM=$(gq "SELECT 'rem='||IFNULL(reminderTime,'NULL') FROM TMTask WHERE uuid='$TDL'")
note "    template pre: $TREM"
note "    $(sc things-proxy-set-detail "{\"id\":\"$TDL\",\"detail\":\"Reminder Time\",\"value\":\"\"}")"
settle 5
note "    template post: $(gq "SELECT 'rem='||IFNULL(reminderTime,'NULL') FROM TMTask WHERE uuid='$TDL'")"

########################################################################
note ""
note "===== CELL C9 (§8a) the deadline-less-repeat discriminator: the template deadline COLUMN"
note "  $(gq "SELECT group_concat(title||' :: deadlineCol='||IFNULL(deadline,'NULL')||' t2off='||IFNULL(t2_deadlineOffset,'NULL'), '  |  ') FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL")"

note ""
note "final ips=$(ipsn) things pid=$(pidof_things)"
note "ODDS1-C done"
