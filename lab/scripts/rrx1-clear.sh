#!/bin/bash
# RRX1 Q2 clear-refusal consequence check. On 3.22.12 a repeating template DOES carry
# a real reminderTime column value (RW=18:00). RCLEAR's refusal premise ("no reminderTime
# to clear on a template") is falsified — so re-test the clear surfaces against a template
# that HAS a committed reminder:
#   1. shipped op: `things todo clear-dated-reminder <RW>`   (was H-NO-REMINDER-blocked when NULL)
#   2. raw Shortcuts proxy: things-proxy-set-detail Reminder Time=""  (does it clear the column?)
#   3. raw AppleScript move-to-Inbox on the template (RCLEAR avenue A → expect 301 refusal)
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/rrx1-lab"; REPORT="$OUT/clear.txt"; : > "$REPORT"
source "$OUT/state.env"
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
note() { echo "[rrx1-clear] $*" | tee -a "$REPORT"; }
S(){ lab_ssh "$IP" "$@" </dev/null; }
gq(){ S "~/labh/gsql.sh -q $(printf '%q' "$1")"; }
rsum(){ S "python3 ~/labh/rsum.py $1"; }
warm(){ S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3; open -a Things3; sleep 12'; }
settle(){ S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3'; }

note "-- clock $(S 'date +%Y-%m-%dT%H:%M') --"
note "RW template (before): $(rsum "$RW")"

# 1. shipped op (repeating -> shortcuts path). ui not required; shortcuts is headless.
note ""; note "### 1. shipped: things todo clear-dated-reminder RW ###"
warm
S "$CLI todo clear-dated-reminder $RW ; echo EXIT=\$?" >"$OUT/json/clear-op.log" 2>&1
sed 's/^/  /' "$OUT/json/clear-op.log" | tee -a "$REPORT"
settle
note "RW after shipped clear: $(rsum "$RW")"

# 2. raw Shortcuts proxy directly (bypass op) — re-mint a fresh 18:00 reminder first if needed
note ""; note "### 2. raw proxy: things-proxy-set-detail Reminder Time=\"\" on RW ###"
RWRT=$(gq "SELECT reminderTime FROM TMTask WHERE uuid='$RW'")
note "  RW reminderTime before raw proxy = $RWRT"
S "printf '{\"id\":\"$RW\",\"detail\":\"Reminder Time\",\"value\":\"\"}' > /tmp/rrx1in.json; shortcuts run things-proxy-set-detail --input-path /tmp/rrx1in.json 2>&1; echo PROXY_EXIT=\$?" >"$OUT/json/clear-proxy.log" 2>&1
sed 's/^/  /' "$OUT/json/clear-proxy.log" | tee -a "$REPORT"
settle
note "RW after raw proxy: $(rsum "$RW")"

# 3. raw AppleScript move-to-Inbox on the template (RCLEAR avenue A)
note ""; note "### 3. raw AppleScript: move RW template to Inbox (expect error 301) ###"
S "osascript -e 'tell application \"Things3\" to move to do id \"$RW\" to list \"Inbox\"' 2>&1; echo AS_EXIT=\$?" >"$OUT/json/clear-as.log" 2>&1
sed 's/^/  /' "$OUT/json/clear-as.log" | tee -a "$REPORT"
settle
note "RW after AS move-to-Inbox: $(rsum "$RW")"
note "DONE."
