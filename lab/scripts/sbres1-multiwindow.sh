#!/bin/bash
# SBRES1 cell (D2) — a GENUINE second main window (File ▸ New Things Window).
# Which window does the driver address, and what must the rule be?
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/${VM:-sbres1-lab}"
source "$OUT/session.env"
sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O lab/scripts/sbres1-probe.jxa.js "admin@$IP:/Users/admin/labh/sbres1.js" >/dev/null
P() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/sbres1.js $*" </dev/null 2>&1; }
click_file_item() {
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"$1\" of menu 1 of menu bar item \"File\" of menu bar 1'" </dev/null 2>&1
}

echo "=== before ==="; P windows
echo "=== File > New Things Window ==="; click_file_item "New Things Window"; sleep 4
echo "=== after (2 main windows) ==="; P windows
echo "--- state (which one does the shipped locator see?) ---"; P state
echo "=== hide the sidebar in the FRONT window only ==="; P sidebar hide; sleep 2
P windows
P state
echo "=== restore ==="; P sidebar show; sleep 2
click_file_item "Close"; sleep 3
echo "=== after close ==="; P windows
