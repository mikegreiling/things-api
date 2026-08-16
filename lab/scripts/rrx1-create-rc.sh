#!/bin/bash
# RRX1 — add RC: a DAILY rule-level reminder series (make-repeating --reminder 08:00),
# so clock-advance spawns fresh daily instances whose reminderTime can be inspected.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/rrx1-lab"; REPORT="$OUT/create.txt"
source "$OUT/state.env"
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
note() { echo "[rrx1-rc] $*" | tee -a "$REPORT"; }
S(){ lab_ssh "$IP" "$@" </dev/null; }
gq(){ S "~/labh/gsql.sh -q $(printf '%q' "$1")"; }
rsum(){ S "python3 ~/labh/rsum.py $1"; }
insts(){ S "python3 ~/labh/inst.py $1"; }
uid(){ gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
warm(){ S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3; open -a Things3; sleep 15; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null'; }
settle(){ S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3'; }
drive(){ local n="$1"; shift; lab_ssh "$IP" "$CLI $* ; echo EXIT=\$?" </dev/null >"$OUT/json/$n.log" 2>&1; note "  [$n] $(grep -m1 'EXIT=' "$OUT/json/$n.log")"; }

note ""; note "### RC — make-repeating daily/1 --reminder 08:00 (rule-level) ###"
S "$CLI todo add \"RRX-RCSRC\" --when 2026-07-05" >/dev/null 2>&1; sleep 1
RCS=$(uid RRX-RCSRC); note "  RC source=$RCS"
warm; drive RC todo make-repeating "$RCS" --frequency daily --interval 1 --reminder 08:00 --dangerously-drive-gui; settle
RC=$(gq "SELECT uuid FROM TMTask WHERE title='RRX-RCSRC' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1")
note "  RC template=$RC"; note "  $(rsum "$RC")"; insts "$RC" | tee -a "$REPORT"
echo "RC=$RC" >> "$OUT/state.env"
note "DONE."
