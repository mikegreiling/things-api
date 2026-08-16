#!/bin/bash
# ANCH2 Phase-B re-certification — the FIXED dist, driven through the PRODUCTION
# CLI on a fresh anch2-lab clone (golden-v2 / 3.22.12, clock pinned Sun 2026-07-05).
# Confirms the issue #476 fix end-to-end: the "Next:" first-occurrence field is
# driven + honored, §8v (ends-on) no longer collapses, --reminder is honored.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VM="anch2-lab"; OUT="lab/artifacts/$VM"; mkdir -p "$OUT/json"
REPORT="$OUT/recert.txt"; : > "$REPORT"
note() { echo "[recert] $*" | tee -a "$REPORT"; }
IP=$(tart ip "$VM" 2>/dev/null || true); [ -n "$IP" ] || { note "no IP"; exit 1; }
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
S(){ lab_ssh "$IP" "$@" </dev/null; }
gq(){ S "~/labh/gsql.sh -q $(printf '%q' "$1")"; }
rsum(){ S "python3 ~/labh/rsum.py $1"; }
uid(){ gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
warm(){ S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3; open -a Things3; sleep 15; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null'; }
settle(){ S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3'; }
jd(){ local n="$1"; shift; lab_ssh "$IP" "$CLI $* --json" </dev/null >"$OUT/json/$n.json" 2>"$OUT/json/$n.err"; echo "$?" >"$OUT/json/$n.exit"; note "  [$n] exit=$(cat "$OUT/json/$n.exit")"; }
jval(){ python3 - "$OUT/json/$1.json" "$2" <<'PY'
import json,sys
try: objs=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
except Exception: print(""); sys.exit()
d=objs[-1] if objs else {}; cur=d.get("data",{})
for k in sys.argv[2].split('.'): cur=cur.get(k) if isinstance(cur,dict) else None
print(cur if cur is not None else "")
PY
}
S "$CLI config set ui-enabled true" >/dev/null 2>&1
note "-- env: Things $(S 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString') / clock $(S 'date +%Y-%m-%dT%H:%M') --"

# RC1 — the ORIGINAL #476 repro: source when=2026-08-26 (Wed), weekly/2/wednesday.
# BEFORE the fix this anchored to the today-derived Wed (07-08) and dropped 08-26;
# NOW the Next drive lands the first occurrence on 08-26 exactly.
note ""; note "### RC1 — #476 repro (make-repeating): when=2026-08-26 Wed, weekly/2/wednesday ###"
S "$CLI todo add \"AB-RC1\" --when 2026-08-26" >/dev/null 2>&1; sleep 1
X1=$(uid AB-RC1); warm
jd rc1 todo make-repeating "$X1" --frequency weekly --interval 2 --weekdays wednesday --dangerously-drive-gui
settle
T1=$(jval rc1 repeating.templateUuid)
note "  RC1 template=$T1  rule: $(rsum "$T1")  (want next=2026-08-26 of=[{wd=3}] fa=2)"

note ""; note "### RC1b — #476 repro (add-repeating): --when 2026-08-26 weekly/2/wednesday ###"
warm
jd rc1b todo add-repeating \"AB-RC1b\" --when 2026-08-26 --frequency weekly --interval 2 --weekdays wednesday --dangerously-drive-gui
settle
T1B=$(jval rc1b repeating.templateUuid)
note "  RC1b template=$T1B  rule: $(rsum "$T1B")  (want next=2026-08-26)"

# RC2 — off-rule cell (b): --when a Monday, rule weekday Sunday, weekly/1.
note ""; note "### RC2 — off-rule (b): add-repeating --when 2026-08-24 (Mon) --weekdays sunday weekly/1 ###"
warm
jd rc2 todo add-repeating \"AB-RC2\" --when 2026-08-24 --frequency weekly --interval 1 --weekdays sunday --dangerously-drive-gui
settle
T2=$(jval rc2 repeating.templateUuid)
note "  RC2 template=$T2  rule: $(rsum "$T2")  (want icStart/sr=2026-08-24 Mon verbatim, ia/next=first Sunday after, of=[{wd=0}])"

# RC3 — monthly/2 cell (c).
note ""; note "### RC3 — monthly/2 (c): add-repeating --when 2026-09-15 --frequency monthly --interval 2 ###"
warm
jd rc3 todo add-repeating \"AB-RC3\" --when 2026-09-15 --frequency monthly --interval 2 --dangerously-drive-gui
settle
T3=$(jval rc3 repeating.templateUuid)
note "  RC3 template=$T3  rule: $(rsum "$T3")  (want icStart/sr=2026-09-15, fu=8 fa=2)"

# RC4 — Next + ends-on coexistence (d): NO §8v collapse.
note ""; note "### RC4 — Next + ends-on (d): add-repeating --when 2026-08-26 weekly/2/wed --ends-on 2026-12-30 ###"
warm
jd rc4 todo add-repeating \"AB-RC4\" --when 2026-08-26 --frequency weekly --interval 2 --weekdays wednesday --ends-on 2026-12-30 --dangerously-drive-gui
settle
T4=$(jval rc4 repeating.templateUuid)
note "  RC4 template=$T4  rule: $(rsum "$T4")  (want ed=2026-12-30 AND next=2026-08-26 — NO collapse)"

# RC5 — reminder honored (make-repeating --reminder).
note ""; note "### RC5 — reminder honored: make-repeating weekly/1 --reminder 18:00 ###"
S "$CLI todo add \"AB-RC5\" --when 2026-08-26" >/dev/null 2>&1; sleep 1
X5=$(uid AB-RC5); warm
jd rc5 todo make-repeating "$X5" --frequency weekly --interval 1 --reminder 18:00 --dangerously-drive-gui
settle
T5=$(jval rc5 repeating.templateUuid)
note "  RC5 template=$T5  reminderTime=$(gq "SELECT reminderTime FROM TMTask WHERE uuid='$T5'")  (want 18<<26=1207959552)  rule: $(rsum "$T5")"

note ""; note "### DONE. report: $REPORT  json: $OUT/json/"
