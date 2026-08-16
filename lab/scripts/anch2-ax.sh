#!/bin/bash
# ANCH2 interactive AX driver — a thin dispatcher over the running anch2-lab VM.
# Usage: bash lab/scripts/anch2-ax.sh <cmd> [args...]
#   ip                       print the VM IP
#   warm                     quit + relaunch Things (recompute Today), disable AXEnhancedUI
#   settle                   quit Things
#   clock <MMDDhhmmYYYY>      settle + set guest clock + warm
#   cli <args...>            run the guest production CLI (no --json)
#   jcli <label> <args...>   run the guest CLI --json, save json/<label>.{json,err,exit}
#   gq <sql>                 read-only SQLite query (list mode)
#   rsum <uuid>              decoded recurrence-rule summary
#   inst <uuid>              live instances of a template
#   uid <title>             uuid of a plain to-do by title
#   reveal <uuid>            open things:///show?id=<uuid> and activate Things
#   repeat                   click Items > Repeat...
#   reschedule               click Items > Repeat > Reschedule...
#   dump <label>             full AX tree -> ax/<label>.txt ; print DT inventory
#   freq <needle>            select frequency pop-up (pop up button 1) menu item containing <needle>
#   endsmode <needle>        select Ends pop-up (pop up button 1 of group 1) item containing <needle>
#   setdt <index> <spec>     set Nth AXDateTimeArea (spec=date:YYYY-MM-DD|time:HH:mm)
#   reminders                check the "Add reminders" checkbox
#   ok                       press OK
#   esc                      key code 53 (dismiss dialog)
#   bg                       background Things (activate Finder)
#   se <applescript-body>    run arbitrary System Events snippet (escape hatch)
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VM="anch2-lab"; OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax" "$OUT/json"
IP=$(tart ip "$VM" 2>/dev/null || true); [ -n "$IP" ] || { echo "no IP for $VM"; exit 1; }
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
S(){ lab_ssh "$IP" "$@" </dev/null; }
OSA(){ S "osascript -e $(printf '%q' "$1")"; }
# SE: run a System Events body (may contain multi-line tell blocks) inside the
# Things3 process context, via multiple -e lines so tell-blocks parse cleanly.
SE(){ S "osascript -e 'tell application \"System Events\"' -e 'tell process \"Things3\"' -e $(printf '%q' "$1") -e 'end tell' -e 'end tell'"; }
# DLG: address an element specifier inside whichever dialog shell exists (sheet of
# the standard window, else the detached AXUnknown window). Emits a full script
# that tries the sheet form, and on error the detached form. $1 = inner statement
# template using @@ as the shell placeholder.
DLGrun(){ # $1 = full applescript body (already references both shells)
  S "osascript -e 'tell application \"System Events\" to tell process \"Things3\"' -e $(printf '%q' "$1") -e 'end tell'"; }

# popsel <popup-specifier> <needle> — open a pop-up and click the menu item whose
# title contains <needle>, trying the attached sheet then the detached window.
popsel(){
  DLGrun "$(printf 'try\n tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to tell %s\n click\n delay 0.4\n click (first menu item of menu 1 whose title contains "%s")\n end tell\n on error\n tell (first window whose subrole is "AXUnknown" and size is not {40, 40}) to tell %s\n click\n delay 0.4\n click (first menu item of menu 1 whose title contains "%s")\n end tell\n end try' "$1" "$2" "$1" "$2")" 2>>"$OUT/ax/drive.err"
  sleep 1
}
# press_el <element-specifier> — click an element inside whichever dialog shell.
press_el(){
  DLGrun "$(printf 'try\n tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to click %s\n on error\n tell (first window whose subrole is "AXUnknown" and size is not {40, 40}) to click %s\n end try' "$1" "$1")" 2>>"$OUT/ax/drive.err"
  sleep 1
}

cmd="${1:-}"; shift || true
case "$cmd" in
  ip) echo "$IP" ;;
  warm) S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3; open -a Things3; sleep 15; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; echo warm-done' ;;
  settle) S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3; echo settled' ;;
  clock) S "osascript -e 'tell application \"Things3\" to quit' 2>/dev/null; sleep 3; sudo date $1 >/dev/null; date; open -a Things3; sleep 15; osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set value of attribute \"AXEnhancedUserInterface\" to false' 2>/dev/null; echo clock-warm-done" ;;
  cli) S "$CLI $*" ;;
  jcli) label="$1"; shift; lab_ssh "$IP" "$CLI $* --json" </dev/null >"$OUT/json/$label.json" 2>"$OUT/json/$label.err"; echo "$?" >"$OUT/json/$label.exit"; echo "[$label] exit=$(cat "$OUT/json/$label.exit")"; cat "$OUT/json/$label.json" ;;
  gq) S "~/labh/gsql.sh -q $(printf '%q' "$1")" ;;
  rsum) S "python3 ~/labh/rsum.py $1" ;;
  inst) S "python3 ~/labh/inst.py $1" ;;
  uid) S "~/labh/gsql.sh -q $(printf '%q' "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1")" ;;
  reveal) S "open 'things:///show?id=$1'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 1; echo revealed" ;;
  repeat) SE 'click menu item "Repeat…" of menu 1 of menu bar item "Items" of menu bar 1'; sleep 2; echo repeat-opened ;;
  reschedule) SE 'click menu item "Reschedule…" of menu 1 of menu item "Repeat" of menu 1 of menu bar item "Items" of menu bar 1'; sleep 2; echo reschedule-opened ;;
  dump) S "osascript -l JavaScript ~/labh/axtree.jxa" >"$OUT/ax/$1.txt" 2>&1; echo "--- dump saved: $OUT/ax/$1.txt ($(wc -l <"$OUT/ax/$1.txt") lines) ---"; grep -n 'AXDateTimeArea INVENTORY' -A20 "$OUT/ax/$1.txt" | head -30 ;;
  freq) popsel "pop up button 1" "$1"; echo "freq<-$1" ;;
  endsmode) popsel "pop up button 1 of group 1" "$1"; echo "ends<-$1" ;;
  popsel) popsel "$1" "$2"; echo "popsel[$1]<-$2" ;;   # generic: <popup-specifier> <needle>
  menuitems) # list menu items of a pop-up: <popup-specifier>
    DLGrun "$(printf 'try\n tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to tell %s\n click\n delay 0.4\n set r to title of every menu item of menu 1\n key code 53\n return r\n end tell\n on error\n tell (first window whose subrole is "AXUnknown" and size is not {40, 40}) to tell %s\n click\n delay 0.4\n set r to title of every menu item of menu 1\n key code 53\n return r\n end tell\n end try' "$1" "$1")" ;;
  typefield) # focus + select-all + type + tab (commits the edit, unlike set value): <field-specifier> <value>
    DLGrun "$(printf 'try\n tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to set focused of %s to true\n on error\n tell (first window whose subrole is "AXUnknown" and size is not {40, 40}) to set focused of %s to true\n end try\n delay 0.2\n keystroke "a" using command down\n delay 0.1\n keystroke "%s"\n delay 0.1\n key code 48\n delay 0.2' "$1" "$1" "$2")"; echo "typefield[$1]<-$2" ;;
  setfield) # set a text field value: <field-specifier> <value>
    DLGrun "$(printf 'try\n tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to set value of %s to "%s"\n on error\n tell (first window whose subrole is "AXUnknown" and size is not {40, 40}) to set value of %s to "%s"\n end try' "$1" "$2" "$1" "$2")"; echo "setfield[$1]<-$2" ;;
  setdt) S "osascript -l JavaScript ~/labh/axsetdt.jxa $1 $2" ;;
  reminders) press_el 'checkbox "Add reminders"'; echo reminders-checked ;;
  ok) press_el 'button "OK"'; sleep 2; echo ok-pressed ;;
  press) press_el "$1"; echo "press[$1]" ;;
  esc) SE 'key code 53'; sleep 1; echo esc ;;
  fg) S 'osascript -e '\''tell application "Things3" to activate'\'' 2>/dev/null; sleep 1; echo foregrounded' ;;
  bg) S 'osascript -e '\''tell application "Finder" to activate'\'' 2>/dev/null; sleep 1; echo backgrounded' ;;
  se) SE "$1" ;;
  raw) S "$1" ;;
  *) echo "unknown cmd: $cmd"; exit 2 ;;
esac
