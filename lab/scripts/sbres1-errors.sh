#!/bin/bash
# SBRES1 — the message-truthfulness matrix, after the fix: what does the SHIPPED
# CLI say for each cause it cannot normalize away?
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/${VM:-sbres1-lab}"
REPORT="$OUT/report.txt"
source "$OUT/session.env"
sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O lab/scripts/sbres1-probe.jxa.js "admin@$IP:/Users/admin/labh/sbres1.js" >/dev/null
P() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/sbres1.js $*" </dev/null 2>&1; }
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
order() { gq 'SELECT COALESCE(group_concat(t," < "),"(none)") FROM (SELECT title AS t FROM TMArea ORDER BY "index", uuid)'; }
note() { echo "[sbres1-err] $*" | tee -a "$REPORT"; }

note "=== message truthfulness, after the fix ==="

note "--- (a) NO Things window open (⌘W) ---"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2; osascript -e '\''tell application "System Events" to tell process "Things3" to keystroke "w" using command down'\''; sleep 3' </dev/null >/dev/null 2>&1
note "  windows now:"; P windows | grep -E "raw AX|AXStandardWindow" | tee -a "$REPORT"
B=$(order)
T0=$(date +%s); G area reorder Kappa --first --dangerously-drive-gui --json > "$OUT/err-nowindow.json" 2>&1; T1=$(date +%s)
note "  wall clock: $((T1-T0))s"
head -c 900 "$OUT/err-nowindow.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
note "  order unchanged: $([ "$B" = "$(order)" ] && echo PASS || echo '*** FAIL — something moved ***')"

note "--- reopening the window ---"
lab_ssh "$IP" 'open -a Things3; sleep 8' </dev/null >/dev/null 2>&1
note "  $(P state | head -c 200)"
