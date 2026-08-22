#!/bin/bash
# ODDS1-E — oddities re-validation batch E: confirmation pass.
#
# (1) The §1 / §7 C1+C2 crash SPLIT that batch D turned up: on 3.23 a KEYWORD
#     `when=` on a repeating template kills the app while a DATED `when=` is a
#     silent no-op. §1 claims "the whole when= family". Two runs per spelling.
# (2) The §9bb project-delete arm batch C/D could not select.
#
# ONE disposable clone `odds1e-lab` of things-lab-golden-v4. Teardown on EXIT.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="odds1e-lab"
OUT="lab/artifacts/odds1e-lab"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[odds1e] $*" | tee -a "$REPORT"; }
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

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
note "env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) · clock $(lab_ssh "$IP" date </dev/null)"
lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null

TDL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
TPRJ=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-WEEKLY-PROJ' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
snap() { gq "SELECT 'st'||status||' start='||start||' sd='||IFNULL(startDate,'NULL')||' rem='||IFNULL(reminderTime,'NULL')||' umd='||userModificationDate FROM TMTask WHERE uuid='$1'"; }

hazard() { # hazard <label> <url> <uuid>
  relaunch
  local p0 i0 p1 i1 b a
  p0=$(pidt); i0=$(ipsn); b=$(snap "$3")
  ourl "$2" >/dev/null
  settle 12
  p1=$(pidt); i1=$(ipsn)
  relaunch
  a=$(snap "$3")
  note "  [$1] pid $p0->${p1:-gone} ips $i0->$i1 :: $([ -n "$p1" ] && [ "$p0" = "$p1" ] && echo SURVIVED || echo CRASH) :: $([ "$b" = "$a" ] && echo byte-identical || echo "CHANGED before[$b] after[$a]")"
}

note ""
note "===== CELL E1 — repeating TO-DO template ($TDL): the when= spelling matrix, 2 runs"
for run in 1 2; do
  note "  --- run $run"
  hazard "update when=today"        "things:///update?id=$TDL&auth-token=$TOKEN&when=today" "$TDL"
  hazard "update when=someday"      "things:///update?id=$TDL&auth-token=$TOKEN&when=someday" "$TDL"
  hazard "update when=anytime"      "things:///update?id=$TDL&auth-token=$TOKEN&when=anytime" "$TDL"
  hazard "update when=evening"      "things:///update?id=$TDL&auth-token=$TOKEN&when=evening" "$TDL"
  hazard "update when=tomorrow"     "things:///update?id=$TDL&auth-token=$TOKEN&when=tomorrow" "$TDL"
  hazard "update when=2026-07-09"   "things:///update?id=$TDL&auth-token=$TOKEN&when=2026-07-09" "$TDL"
  hazard "update when=2026-07-09@18:00" "things:///update?id=$TDL&auth-token=$TOKEN&when=2026-07-09@18%3A00" "$TDL"
  hazard "update when= (empty)"     "things:///update?id=$TDL&auth-token=$TOKEN&when=" "$TDL"
done

note ""
note "===== CELL E2 — repeating PROJECT template ($TPRJ): dated vs keyword"
hazard "update-project when=2026-07-09" "things:///update-project?id=$TPRJ&auth-token=$TOKEN&when=2026-07-09" "$TPRJ"
hazard "update-project when=someday"    "things:///update-project?id=$TPRJ&auth-token=$TOKEN&when=someday" "$TPRJ"

note ""
note "===== CELL E3 — the AppleScript guard contrast, both kinds"
relaunch
note "  AS schedule to-do template   : $(oas "tell application \"Things3\" to schedule to do id \"$TDL\" for (date \"7/9/2026\")")"
note "  AS schedule project template : $(oas "tell application \"Things3\" to schedule to do id \"$TPRJ\" for (date \"7/9/2026\")")"
note "  AS move to-do template Someday: $(oas "tell application \"Things3\" to move (to do id \"$TDL\") to list \"Someday\"")"
note "  app: $(pidt) ips=$(ipsn)"

note ""
note "===== CELL E4 (§9bb) a PROJECT with open children, selected in an AREA view"
relaunch
AR=$(gq "SELECT uuid FROM TMArea WHERE title='LAB-AREA-A' LIMIT 1")
ourl "things:///add-project?title=ODDS1-E-PROJ&auth-token=$TOKEN&area-id=$AR&to-dos=k1%0Ak2" >/dev/null; settle 8
PRJ=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-E-PROJ' AND type=1 LIMIT 1")
note "  project=$PRJ area=$(gq "SELECT IFNULL(area,'NULL') FROM TMTask WHERE uuid='$PRJ'") open children=$(gq "SELECT COUNT(*) FROM TMTask WHERE project='$PRJ' AND trashed=0 AND status=0")"
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
ourl "things:///show?id=$AR" >/dev/null; settle 5
note "  select project row: $(oas "tell application \"System Events\" to tell process \"Things3\"
set t to first table of first scroll area of (first window whose subrole is \"AXStandardWindow\")
set n to count of rows of t
set found to \"none rows=\" & n
repeat with i from 1 to n
select (row i of t)
delay 0.4
set em to name of menu item 8 of menu 1 of menu bar item \"Edit\" of menu bar 1
if em contains \"Project\" then
set found to \"row \" & i & \" editMenu=\" & em
exit repeat
end if
end repeat
return found
end tell")"
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
note "  project trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$PRJ'") children trashed=$(gq "SELECT group_concat(trashed) FROM TMTask WHERE project='$PRJ'")"

note ""
note "final ips=$(ipsn)"
note "ODDS1-E done"
