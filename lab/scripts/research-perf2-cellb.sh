#!/bin/bash
# PERF2 S8-B re-drive on the KEPT perf2c VM: Next+ends-on coexistence, OLD vs NEW
# bundle, byte-identical rule. (Cell B first run omitted the required --interval.)
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
IP="${IP:-$(tart ip perf2c 2>/dev/null)}"
OUT="lab/artifacts/perf2-cert"; mkdir -p "$OUT/drive"
note() { echo "[cellb] $*"; }
[ -n "$IP" ] || { note "FATAL: perf2c not up"; exit 1; }
note "perf2c at $IP"

lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
warm()   { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
plain_uuid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
tpl_uuid()   { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NOT NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
rule_hex()   { gq "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'"; }
ENDS="--frequency weekly --interval 1 --weekdays wednesday --when 2026-08-26 --ends-on 2027-01-01 --dangerously-drive-gui --json"

warm
lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/dist-old/cli/main.js todo add 'PERF2 endsB old' --json" </dev/null >/dev/null 2>&1
settle
SO=$(plain_uuid "PERF2 endsB old"); note "OLD seed=$SO"
warm
lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/dist-old/cli/main.js todo make-repeating $SO $ENDS" </dev/null >"$OUT/drive/endsB-old.log" 2>&1
note "OLD verdict: $(grep -m1 '"ok"\|verify-failed\|"error"\|blocked' "$OUT/drive/endsB-old.log" | head -c 140)"
settle
EO=$(tpl_uuid "PERF2 endsB old"); HO=$(rule_hex "$EO"); note "OLD tpl=$EO"

warm
lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/dist-new/cli/main.js todo add 'PERF2 endsB new' --json" </dev/null >/dev/null 2>&1
settle
SN=$(plain_uuid "PERF2 endsB new"); note "NEW seed=$SN"
warm
lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/dist-new/cli/main.js todo make-repeating $SN $ENDS" </dev/null >"$OUT/drive/endsB-new.log" 2>&1
note "NEW verdict: $(grep -m1 '"ok"\|verify-failed\|"error"\|blocked' "$OUT/drive/endsB-new.log" | head -c 140)"
settle
EN=$(tpl_uuid "PERF2 endsB new"); HN=$(rule_hex "$EN"); note "NEW tpl=$EN"

note "OLD rule=$HO"
note "NEW rule=$HN"
if [ -n "$EN" ] && [ "$HO" = "$HN" ]; then note "B VERDICT: PASS — byte-identical rule (Next + ends-on both landed)"; else note "B VERDICT: FAIL ($HO vs $HN)"; fi
note "CELLB COMPLETE"
