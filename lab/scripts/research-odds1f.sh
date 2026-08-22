#!/bin/bash
# ODDS1-F — oddities re-validation batch F: two arms batch E left open.
#
# (1) §9bb project arm — drive Edit ▸ "Delete Project" as a MENU CLICK rather
#     than ⌘⌫, which did not actuate on a project row.
# (2) The batch-E side observation: on a repeating TEMPLATE a DATED
#     `when=<date>@<time>` does not crash and WRITES `reminderTime` onto the
#     template row. Confirm it, and check whether the bare dated form clears.
#
# ONE disposable clone `odds1f-lab` of things-lab-golden-v4. Teardown on EXIT.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="odds1f-lab"
OUT="lab/artifacts/odds1f-lab"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[odds1f] $*" | tee -a "$REPORT"; }
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
sheetn() { oas 'tell application "System Events" to tell process "Things3"
set s to 0
repeat with w in windows
set s to s + (count of sheets of w)
end repeat
return s
end tell'; }
sheettxt() { oas 'tell application "System Events" to tell process "Things3"
set o to ""
repeat with w in windows
repeat with s in sheets of w
set o to o & (value of every static text of s as text) & " [" & (name of every button of s as text) & "]"
end repeat
end repeat
return o
end tell'; }

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
note "env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) · clock $(lab_ssh "$IP" date </dev/null)"
lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null

########################################################################
note ""
note "===== CELL F1 (§9bb) delete a PROJECT via the Edit menu ITEM, not ⌘⌫"
AR=$(gq "SELECT uuid FROM TMArea WHERE title='LAB-AREA-A' LIMIT 1")
ourl "things:///add-project?title=ODDS1-F-KIDS&auth-token=$TOKEN&area-id=$AR&to-dos=k1%0Ak2" >/dev/null
ourl "things:///add-project?title=ODDS1-F-EMPTY&auth-token=$TOKEN&area-id=$AR" >/dev/null; settle 8
PK=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-F-KIDS' AND type=1 LIMIT 1")
PE=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-F-EMPTY' AND type=1 LIMIT 1")
note "  with-children=$PK (open children=$(gq "SELECT COUNT(*) FROM TMTask WHERE project='$PK' AND trashed=0 AND status=0")) · empty=$PE"
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 3' </dev/null

delproj() { # delproj <label> <title> <uuid>
  ourl "things:///show?id=$AR" >/dev/null; settle 5
  local sel
  sel=$(oas "tell application \"System Events\" to tell process \"Things3\"
set t to first table of first scroll area of (first window whose subrole is \"AXStandardWindow\")
set n to count of rows of t
set found to \"none rows=\" & n
repeat with i from 1 to n
select (row i of t)
delay 0.4
tell application \"Things3\" to set sel to (name of selected to dos) as text
if sel contains \"$2\" then
set found to \"row \" & i & \" sel=\" & sel
exit repeat
end if
end repeat
return found
end tell")
  note "  [$1] selection: $sel"
  note "  [$1] Edit menu item 8: $(oas 'tell application "System Events" to tell process "Things3" to return (name of menu item 8 of menu 1 of menu bar item "Edit" of menu bar 1)')"
  local s0; s0=$(sheetn)
  note "  [$1] click Edit ▸ Delete: $(oas 'tell application "System Events" to tell process "Things3"
click menu bar item "Edit" of menu bar 1
delay 1
click menu item 8 of menu 1 of menu bar item "Edit" of menu bar 1
delay 2
return "clicked"
end tell')"
  settle 4
  note "  [$1] sheets $s0 -> $(sheetn) :: $(sheettxt)"
  note "  [$1] project trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$3'") children trashed=$(gq "SELECT IFNULL(group_concat(trashed),'-') FROM TMTask WHERE project='$3'")"
  oas 'tell application "System Events" to tell process "Things3" to key code 53' >/dev/null
  settle 2
}
delproj "project + 2 open children" "ODDS1-F-KIDS" "$PK"
relaunch
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 3' </dev/null
delproj "empty project (control)" "ODDS1-F-EMPTY" "$PE"

########################################################################
note ""
note "===== CELL F2 — a DATED when= on a repeating TEMPLATE: what actually lands?"
relaunch
TDL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
snap() { gq "SELECT 'start='||start||' sd='||IFNULL(startDate,'NULL')||' rem='||IFNULL(reminderTime,'NULL')||' next='||IFNULL(rt1_nextInstanceStartDate,'NULL')||' icS='||IFNULL(rt1_instanceCreationStartDate,'NULL')||' icC='||IFNULL(rt1_instanceCreationCount,'NULL')||' umd='||userModificationDate FROM TMTask WHERE uuid='$TDL'"; }
note "  baseline      : $(snap)"
note "  instances     : $(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$TDL' AND trashed=0")"
ourl "things:///update?id=$TDL&auth-token=$TOKEN&when=2026-07-09" >/dev/null; settle 8
note "  after bare dated : $(snap)"
ourl "things:///update?id=$TDL&auth-token=$TOKEN&when=2026-07-09@18%3A00" >/dev/null; settle 8
note "  after dated@18:00: $(snap)"
note "  pid alive=$(pidt) ips=$(ipsn)"
ourl "things:///update?id=$TDL&auth-token=$TOKEN&when=2026-07-10" >/dev/null; settle 8
note "  after bare dated (does it CLEAR the reminder?): $(snap)"
note "  spawned instances now: $(gq "SELECT COUNT(*)||' :: '||IFNULL(group_concat('sd='||IFNULL(startDate,'NULL')||'/rem='||IFNULL(reminderTime,'NULL')),'-') FROM TMTask WHERE rt1_repeatingTemplate='$TDL' AND trashed=0")"
note "  --- roll the clock +1 day and relaunch: does the next spawn inherit the reminder?"
lab_ssh "$IP" 'sudo date 070612002026 >/dev/null' </dev/null
relaunch
note "  template : $(snap)"
note "  instances: $(gq "SELECT COUNT(*)||' :: '||IFNULL(group_concat('sd='||IFNULL(startDate,'NULL')||'/rem='||IFNULL(reminderTime,'NULL')),'-') FROM TMTask WHERE rt1_repeatingTemplate='$TDL' AND trashed=0")"

note ""
note "final ips=$(ipsn)"
note "ODDS1-F done"
