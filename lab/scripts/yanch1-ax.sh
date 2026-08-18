#!/bin/bash
# YANCH1 interactive AX driver (issue #493) over the running yanch1-lab VM.
# Usage: bash lab/scripts/yanch1-ax.sh <cmd> [args...]
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VM="yanch1-lab"; OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax" "$OUT/json"
IP=$(tart ip "$VM" 2>/dev/null || true); [ -n "$IP" ] || { echo "no IP for $VM"; exit 1; }
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
S(){ lab_ssh "$IP" "$@" </dev/null; }
SE(){ S "osascript -e 'tell application \"System Events\"' -e 'tell process \"Things3\"' -e $(printf '%q' "$1") -e 'end tell' -e 'end tell'"; }
DLGrun(){ S "osascript -e 'tell application \"System Events\" to tell process \"Things3\"' -e $(printf '%q' "$1") -e 'end tell'"; }
popsel(){
  DLGrun "$(printf 'try\n tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to tell %s\n click\n delay 0.4\n click (first menu item of menu 1 whose title contains "%s")\n end tell\n on error\n tell (first window whose subrole is "AXUnknown" and size is not {40, 40}) to tell %s\n click\n delay 0.4\n click (first menu item of menu 1 whose title contains "%s")\n end tell\n end try' "$1" "$2" "$1" "$2")" 2>>"$OUT/ax/drive.err"; sleep 1; }
press_el(){
  DLGrun "$(printf 'try\n tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to click %s\n on error\n tell (first window whose subrole is "AXUnknown" and size is not {40, 40}) to click %s\n end try' "$1" "$1")" 2>>"$OUT/ax/drive.err"; sleep 1; }

cmd="${1:-}"; shift || true
case "$cmd" in
  ip) echo "$IP" ;;
  warm) S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3; open -a Things3; sleep 15; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; echo warm-done' ;;
  settle) S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3; echo settled' ;;
  cli) S "$CLI $*" ;;
  jcli) label="$1"; shift; lab_ssh "$IP" "$CLI $* --json" </dev/null >"$OUT/json/$label.json" 2>"$OUT/json/$label.err"; echo "$?" >"$OUT/json/$label.exit"; echo "[$label] exit=$(cat "$OUT/json/$label.exit")"; cat "$OUT/json/$label.json" ;;
  gq) S "~/labh/gsql.sh -q $(printf '%q' "$1")" ;;
  rsum) S "python3 ~/labh/rsum.py $1" ;;
  uid) S "~/labh/gsql.sh -q $(printf '%q' "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1")" ;;
  tuid) S "~/labh/gsql.sh -q $(printf '%q' "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1")" ;;
  reveal) S "open 'things:///show?id=$1'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 1; echo revealed" ;;
  repeat) SE 'click menu item "Repeat…" of menu 1 of menu bar item "Items" of menu bar 1'; sleep 2; echo repeat-opened ;;
  reschedule) SE 'click menu item "Reschedule…" of menu 1 of menu item "Repeat" of menu 1 of menu bar item "Items" of menu bar 1'; sleep 2; echo reschedule-opened ;;
  dump) S "osascript -l JavaScript ~/labh/axtree.jxa" >"$OUT/ax/$1.txt" 2>&1; echo "--- dump: $OUT/ax/$1.txt ($(wc -l <"$OUT/ax/$1.txt") lines) ---"; grep -n 'AXDateTimeArea INVENTORY' -A20 "$OUT/ax/$1.txt" | head -30 ;;
  freq) popsel "pop up button 1" "$1"; echo "freq<-$1" ;;
  popsel) popsel "$1" "$2"; echo "popsel[$1]<-$2" ;;
  press) press_el "$1"; echo "press[$1]" ;;
  deadlines) press_el 'checkbox "Add deadlines"'; echo deadlines-checked ;;
  reminders) press_el 'checkbox "Add reminders"'; echo reminders-checked ;;
  ok) press_el 'button "OK"'; sleep 2; echo ok-pressed ;;
  esc) SE 'key code 53'; sleep 1; echo esc ;;
  fg) S 'osascript -e '\''tell application "Things3" to activate'\'' 2>/dev/null; sleep 1; echo fg' ;;
  se) SE "$1" ;;
  raw) S "$1" ;;
  checkboxes) # list checkbox titles in the dialog shell
    DLGrun 'try
 tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to return title of every checkbox
 on error
 tell (first window whose subrole is "AXUnknown" and size is not {40, 40}) to return title of every checkbox
 end try' ;;
  *) echo "unknown cmd: $cmd"; exit 2 ;;
esac
