#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/rrx1-lab"; source "$OUT/state.env"
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
echo "=== clear-reminder on RW TEMPLATE (reminderTime=18:00, repeating) ==="
lab_ssh "$IP" "$CLI todo clear-reminder $RW ; echo EXIT=\$?" </dev/null 2>&1 | grep -vE "ExperimentalWarning|trace-warnings"
echo "RW reminderTime after: $(lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT reminderTime FROM TMTask WHERE uuid='$RW'\"" </dev/null)"
echo ""
echo "=== clear-reminder --vector shortcuts on RW TEMPLATE ==="
lab_ssh "$IP" "$CLI todo clear-reminder $RW --vector shortcuts ; echo EXIT=\$?" </dev/null 2>&1 | grep -vE "ExperimentalWarning|trace-warnings"
echo "RW reminderTime after: $(lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT reminderTime FROM TMTask WHERE uuid='$RW'\"" </dev/null)"
