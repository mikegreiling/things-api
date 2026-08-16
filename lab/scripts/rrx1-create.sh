#!/bin/bash
# RRX1 create — seed all series on the running rrx1-lab clone at the pinned baseline
# (Sun 2026-07-05). Series:
#   EA  daily/1 --ends-after 3          (Q1: never completed — rc trajectory over spawns)
#   EB  daily/1 --ends-after 3          (Q1: completed each occurrence — decrement disambiguation)
#   EO  daily/1 --ends-on 2026-07-08    (Q1: ends-by-date exhaustion transition)
#   EP  daily/1 --ends-on 2026-07-03    (Q1: "born already ended" past ends-on symmetry)
#   RW  weekly/1 --reminder 18:00       (Q2: template reminderTime + current instance)
#   RD  daily/1  --reminder 09:00       (Q2: later-spawn instance reminderTime, via clock advance)
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/rrx1-lab"; REPORT="$OUT/create.txt"; : > "$REPORT"
IP=$(cat "$OUT/ip.txt")
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
note() { echo "[rrx1-create] $*" | tee -a "$REPORT"; }
S(){ lab_ssh "$IP" "$@" </dev/null; }
gq(){ S "~/labh/gsql.sh -q $(printf '%q' "$1")"; }
rsum(){ S "python3 ~/labh/rsum.py $1"; }
insts(){ S "python3 ~/labh/inst.py $1"; }
uid(){ gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
tmpl(){ gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
warm(){ S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3; open -a Things3; sleep 15; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null'; }
settle(){ S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3'; }
drive(){ local n="$1"; shift; lab_ssh "$IP" "$CLI $* ; echo EXIT=\$?" </dev/null >"$OUT/json/$n.log" 2>&1; note "  [$n] $(grep -m1 'EXIT=' "$OUT/json/$n.log")"; }

note "-- env: Things $(S 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString') / clock $(S 'date +%Y-%m-%dT%H:%M') --"
S "$CLI config set ui-enabled true" >/dev/null 2>&1

# EA — daily/1 ends-after 3 (never completed)
note ""; note "### EA — add-repeating daily/1 --ends-after 3 (never completed) ###"
warm; drive EA todo add-repeating \"RRX-EA\" --when 2026-07-05 --frequency daily --interval 1 --ends-after 3 --dangerously-drive-gui; settle
EA=$(tmpl RRX-EA); note "  EA template=$EA"; note "  $(rsum "$EA")"; insts "$EA" | tee -a "$REPORT"

# EB — daily/1 ends-after 3 (will complete each occurrence)
note ""; note "### EB — add-repeating daily/1 --ends-after 3 (complete-each) ###"
warm; drive EB todo add-repeating \"RRX-EB\" --when 2026-07-05 --frequency daily --interval 1 --ends-after 3 --dangerously-drive-gui; settle
EB=$(tmpl RRX-EB); note "  EB template=$EB"; note "  $(rsum "$EB")"; insts "$EB" | tee -a "$REPORT"

# EO — daily/1 ends-on 2026-07-08
note ""; note "### EO — add-repeating daily/1 --ends-on 2026-07-08 ###"
warm; drive EO todo add-repeating \"RRX-EO\" --when 2026-07-05 --frequency daily --interval 1 --ends-on 2026-07-08 --dangerously-drive-gui; settle
EO=$(tmpl RRX-EO); note "  EO template=$EO"; note "  $(rsum "$EO")"; insts "$EO" | tee -a "$REPORT"

# EP — daily/1 ends-on 2026-07-03 (past — born-ended symmetry)
note ""; note "### EP — add-repeating daily/1 --ends-on 2026-07-03 (past) ###"
warm; drive EP todo add-repeating \"RRX-EP\" --when 2026-07-05 --frequency daily --interval 1 --ends-on 2026-07-03 --dangerously-drive-gui; settle
EP=$(tmpl RRX-EP); note "  EP template=$EP"; note "  $(rsum "$EP")"; insts "$EP" | tee -a "$REPORT"

# RW — weekly/1 reminder 18:00 (make-repeating from a seeded to-do)
note ""; note "### RW — make-repeating weekly/1 --reminder 18:00 ###"
S "$CLI todo add \"RRX-RWSRC\" --when 2026-07-05" >/dev/null 2>&1; sleep 1
RWS=$(uid RRX-RWSRC); note "  RW source=$RWS"
warm; drive RW todo make-repeating "$RWS" --frequency weekly --interval 1 --reminder 18:00 --dangerously-drive-gui; settle
RW=$(tmpl RRX-RWSRC); [ -z "$RW" ] && RW=$(gq "SELECT uuid FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL AND fu IS NULL AND title='RRX-RWSRC' LIMIT 1")
RW=$(gq "SELECT uuid FROM TMTask WHERE title='RRX-RWSRC' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1")
note "  RW template=$RW"; note "  $(rsum "$RW")"; insts "$RW" | tee -a "$REPORT"

# RD — daily/1 reminder 09:00
note ""; note "### RD — add-repeating daily/1 --reminder 09:00 ###"
warm; drive RD todo add-repeating \"RRX-RD\" --when 2026-07-05 --frequency daily --interval 1 --reminder 09:00 --dangerously-drive-gui; settle
RD=$(tmpl RRX-RD); note "  RD template=$RD"; note "  $(rsum "$RD")"; insts "$RD" | tee -a "$REPORT"

# stash template uuids for the advance/complete scripts
cat > "$OUT/state.env" <<EOF
IP=$IP
EA=$EA
EB=$EB
EO=$EO
EP=$EP
RW=$RW
RD=$RD
EOF
note ""; note "state.env written. DONE."
