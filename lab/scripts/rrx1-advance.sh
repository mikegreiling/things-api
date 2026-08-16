#!/bin/bash
# RRX1 clock-advance (+1 day). Args: DAY(e.g. 070612002026) LABEL(e.g. d0706)
# For each series: rsum (rule blob + cursor + icCount + rc) + instance rows.
# EB: complete its newest live occurrence AFTER snapshot (rc decrement disambiguation).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/rrx1-lab"; REPORT="$OUT/advance.txt"
source "$OUT/state.env"
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
note() { echo "[rrx1-adv] $*" | tee -a "$REPORT"; }
S(){ lab_ssh "$IP" "$@" </dev/null; }
gq(){ S "~/labh/gsql.sh -q $(printf '%q' "$1")"; }
rsum(){ S "python3 ~/labh/rsum.py $1"; }
insts(){ S "python3 ~/labh/inst.py $1"; }
warm(){ S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3; open -a Things3; sleep 16; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null'; }
settle(){ S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3'; }
nudge(){ S "open 'things:///show?id=upcoming'; sleep 5; open 'things:///show?id=today'; sleep 8"; }

DAY="$1"; LABEL="$2"
note ""; note "############### ADVANCE -> $DAY ($LABEL) ###############"
settle
S "sudo date $DAY >/dev/null"
note "  clock now: $(S 'date +%Y-%m-%dT%H:%M')"
warm; nudge; settle

for name in EA EB EO EP RC RD; do
  u="${!name}"
  note "  --- $name ($u) ---"
  note "    $(rsum "$u")"
  insts "$u" | sed 's/^/    /' | tee -a "$REPORT"
done

# EB: complete ALL open live occurrences to test per-completion decrement (vs EA never completed)
EBOPEN=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$EB' AND type=0 AND status=0 AND trashed=0 ORDER BY startDate")
if [ -n "$EBOPEN" ]; then
  for occ in $EBOPEN; do
    lab_ssh "$IP" "$CLI todo complete $occ ; echo EXIT=\$?" </dev/null >>"$OUT/json/EBcomplete-$LABEL.log" 2>&1
    note "  EB complete occ $occ: $(grep -m1 EXIT= "$OUT/json/EBcomplete-$LABEL.log" | tail -1)"
  done
  settle
  note "  EB after completing occ(s): $(rsum "$EB")"
else
  note "  EB no live occurrence to complete"
fi
note "done $LABEL."
