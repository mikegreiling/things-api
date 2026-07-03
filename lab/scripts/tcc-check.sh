#!/bin/bash
# Assert the TCC grants the harness depends on. Exit 0 if AppleEvents + FDA
# for sshd are present; reports Screen Recording status (optional).
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh
VM="${1:-things-lab-golden-v1}"
IP="$(tart ip "$VM")"
lab_ssh "$IP" 'bash -s' <<'GUEST'
udb="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
sdb="/Library/Application Support/com.apple.TCC/TCC.db"
ae=$(sqlite3 "$udb" "SELECT auth_value FROM access WHERE service='kTCCServiceAppleEvents' AND client LIKE '%sshd%';" 2>/dev/null | head -1)
fda=$(sudo sqlite3 "$sdb" "SELECT auth_value FROM access WHERE service='kTCCServiceSystemPolicyAllFiles' AND client LIKE '%sshd%';" 2>/dev/null | head -1)
scr=$(sudo sqlite3 "$sdb" "SELECT client||'='||auth_value FROM access WHERE service='kTCCServiceScreenCapture';" 2>/dev/null | tr '\n' ' ')
echo "AppleEvents(sshd)=${ae:-MISSING}  FullDiskAccess(sshd)=${fda:-MISSING}"
echo "ScreenCapture: ${scr:-none}"
[ "$ae" = "2" ] && [ "$fda" = "2" ] || { echo "REQUIRED TCC GRANT MISSING" >&2; exit 1; }
echo "TCC OK (required grants present)"
GUEST
