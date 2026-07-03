#!/bin/bash
# Install + start the disruption-monitor LaunchAgent in the guest Aqua
# session, then verify it emits events. Idempotent.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh
VM="${1:-things-lab-golden-v1}"
IP="$(tart ip "$VM")"
lab_ssh "$IP" 'bash -s' <<'GUEST'
set -e
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.thingslab.disruption-monitor.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.thingslab.disruption-monitor</string>
  <key>ProgramArguments</key><array><string>/Users/admin/things-lab/bin/disruption-monitor</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/Users/admin/things-lab/monitor.err</string>
</dict></plist>
PLIST
launchctl bootout gui/$(id -u)/com.thingslab.disruption-monitor 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.thingslab.disruption-monitor.plist
launchctl kickstart -k gui/$(id -u)/com.thingslab.disruption-monitor
sleep 2
osascript -e 'tell application "Finder" to activate' >/dev/null 2>&1 || true
sleep 1; open -a Things3; sleep 2
n=$(wc -l < ~/things-lab/events.ndjson 2>/dev/null || echo 0)
echo "monitor state: $(launchctl print gui/$(id -u)/com.thingslab.disruption-monitor 2>/dev/null | grep -m1 state | tr -d ' ')"
echo "events after activity burst: $n"
[ "$n" -gt 0 ] || { echo "MONITOR NOT EMITTING" >&2; exit 1; }
echo "MONITOR AGENT OK"
GUEST
