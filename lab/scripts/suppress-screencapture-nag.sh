#!/bin/bash
# Push the Sequoia screen-capture approval date far into the future so the
# monthly re-consent nag never fires in unattended clones. Run AFTER Screen
# Recording has been granted in System Settings.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh
VM="${1:-things-lab-golden-v1}"
IP="$(tart ip "$VM")"
lab_ssh "$IP" 'bash -s' <<'GUEST'
plist="$HOME/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist"
for bin in "/Users/admin/things-lab/bin/disruption-monitor" "/usr/libexec/sshd-keygen-wrapper"; do
  defaults write "$plist" "$bin" -date "4321-01-01 00:00:00 +0000" 2>/dev/null || true
done
echo "screen-capture approval dates pushed to 4321 for monitor + sshd"
GUEST
