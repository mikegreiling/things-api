#!/bin/bash
# SL1 clock-advance driver. Reuses the running sl1-lab VM + helpers left up by
# research-sl1.sh. Technique from RSIM-S: SMALL +1-day increments on a DAILY repeater
# (next occurrence = tomorrow), warm relaunch + Upcoming/Today nudge, to beat the
# +15-day wedge. Each advance accumulates a new OPEN instance (prior ones persist).
# Args: DAY (e.g. 070612002026 for 2026-07-06 12:00) LABEL.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/sl1-lab"; REPORT="$OUT/report.txt"
source "$OUT/state.env"
note() { echo "[sl1] $*" | tee -a "$REPORT"; }
gq() { lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
imatrix() { lab_ssh "$IP" "~/things-lab/helpers/imatrix.sh $1" </dev/null | tee -a "$REPORT"; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 16; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
nudge() { lab_ssh "$IP" "open 'things:///show?id=upcoming'; sleep 5; open 'things:///show?id=today'; sleep 8" </dev/null; }
alive() { lab_ssh "$IP" 'test -f ~/things-lab/helpers/imatrix.sh && echo HELPERS-OK || echo HELPERS-GONE; uptime | sed "s/^/uptime:/"' </dev/null; }

DAY="$1"; LABEL="$2"
note ""; note "############### SL1 clock-advance -> $DAY ($LABEL) ###############"
note "  BEFORE: instance matrix:"; imatrix "$TPL"
settle
lab_ssh "$IP" "sudo date $DAY >/dev/null" </dev/null
note "  clock now: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
note "  helper/reboot check: $(alive | tr '\n' ' ')"
warm; nudge
note "  post-warm helper/reboot check: $(alive | tr '\n' ' ')"
settle
note "  AFTER: instance matrix:"; imatrix "$TPL"
NCOUNT=$(gq "SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$TPL' AND type=0")
note "  instance count now = $NCOUNT"
note "  done $LABEL."
