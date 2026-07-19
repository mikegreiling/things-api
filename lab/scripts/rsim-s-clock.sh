#!/bin/bash
# RSIM-S clock-advance driver (Q1 spawn). Reuses the running rsim-s-lab VM + helpers
# left up by research-rsim-s.sh. Technique 1: SMALL +1-day increments with a DAILY
# repeater (next occurrence = tomorrow), warm relaunch + Upcoming/Today nudge, to beat
# the +15-day wedge. Args: DAY (e.g. 070612002026 for 2026-07-06 12:00) LABEL.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/rsim-s-lab"; REPORT="$OUT/report.txt"
source "$OUT/state.env"
note() { echo "[rsims] $*" | tee -a "$REPORT"; }
gq() { lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
snap() { lab_ssh "$IP" 'python3 ~/things-lab/helpers/rsnap.py' </dev/null > "$OUT/snaps/$1.json"; note "  snap $1 ($(wc -c <"$OUT/snaps/$1.json"|tr -d ' ')B)"; }
kids() { lab_ssh "$IP" "python3 ~/things-lab/helpers/kids.py $1" </dev/null | tee -a "$REPORT"; }
diff_c() { python3 "$OUT/diff_snaps.py" "$OUT/snaps/$1.json" "$OUT/snaps/$2.json" "${3:-}" | tee -a "$REPORT"; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 16; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
nudge() { lab_ssh "$IP" "open 'things:///show?id=upcoming'; sleep 5; open 'things:///show?id=today'; sleep 8" </dev/null; }
alive() { lab_ssh "$IP" 'test -f ~/things-lab/helpers/rsnap.py && echo HELPERS-OK || echo HELPERS-GONE; uptime | sed "s/^/uptime:/"' </dev/null; }
tmpldate() { gq "SELECT title,rt1_instanceCreationCount,rt1_nextInstanceStartDate,rt1_instanceCreationStartDate FROM TMTask WHERE uuid='$TPL'"; }
insts() { gq "SELECT uuid,title,type,start,status,startDate,startBucket FROM TMTask WHERE rt1_repeatingTemplate='$TPL' AND type=1 ORDER BY startDate"; }

DAY="$1"; LABEL="$2"
note ""; note "############### S1 clock-advance -> $DAY ($LABEL) ###############"
note "  BEFORE advance: template dates: $(tmpldate)"
note "  BEFORE advance: instances of template:"; insts | sed 's/^/    /' | tee -a "$REPORT"
settle
lab_ssh "$IP" "sudo date $DAY >/dev/null" </dev/null
note "  clock now: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
note "  reboot/helper check: $(alive | tr '\n' ' ')"
warm; nudge
note "  post-warm reboot/helper check: $(alive | tr '\n' ' ')"
settle; snap "$LABEL"
note "  --- delta prepared -> $LABEL ---"; diff_c prepared "$LABEL" ""
note "  AFTER: template dates: $(tmpldate)"
note "  AFTER: instances of template:"; insts | sed 's/^/    /' | tee -a "$REPORT"
NEWINS=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TPL' AND type=1 AND uuid!='$INS0' AND trashed=0 ORDER BY startDate DESC LIMIT 1")
if [ -n "$NEWINS" ]; then
  note "  *** NEW instance spawned: $NEWINS — subtree: ***"; kids "$NEWINS"
  echo "NEWINS_$LABEL=$NEWINS" >> "$OUT/state.env"
else
  note "  *** NO new instance spawned at $DAY (only INS0=$INS0 present). ***"
fi
note "  done $LABEL."
