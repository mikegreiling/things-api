#!/bin/bash
# Golden image builder — scripted layers only (lab.md §2 L0, L1, and the
# app-install half of L2). Produces a STOPPED `things-lab-golden-vN` with
# Things installed but NEVER LAUNCHED (first launch starts the 15-day trial
# clock — that belongs at the start of the human seeding session; see
# docs/lab/golden-runbook.md).
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

VERSION="${1:-v1}"
VM="things-lab-golden-$VERSION"
REPO_ROOT="$(cd ../.. && pwd)"
ZIP="$REPO_ROOT/vendor/Things3.zip"
[ -f "$ZIP" ] || { echo "missing $ZIP (see vendor/manifest.json)" >&2; exit 1; }

if tart list 2>/dev/null | awk '{print $2}' | grep -qx "$VM"; then
  echo "VM $VM already exists — delete it first if rebuilding: tart delete $VM" >&2
  exit 1
fi

echo "==> L0: clone + resize"
tart clone "$LAB_BASE_IMAGE" "$VM"
tart set "$VM" --cpu 4 --memory 8192

trap 'echo "BUILD FAILED — golden VM left RUNNING for inspection (tart stop $VM when done)" >&2' ERR

echo "==> boot"
# stdout/stderr redirected: an inherited pipe would hold downstream readers
# open for the VM's whole lifetime (learned the hard way)
tart run "$VM" --no-graphics >/dev/null 2>&1 &
RUN_PID=$!
IP="$(lab_wait_for_ssh "$VM" 240)"
echo "==> guest IP: $IP"

echo "==> L1: determinism hardening"
lab_ssh "$IP" 'bash -s' <<'GUEST'
set -euo pipefail
sudo softwareupdate --schedule off || true
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled -bool false
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool false
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
defaults write com.apple.commerce AutoUpdate -bool false
sudo mdutil -a -i off >/dev/null || true
sudo tmutil disable || true
sudo systemsetup -setusingnetworktime off >/dev/null 2>&1 || true
sudo pmset -a sleep 0 displaysleep 0 disksleep 0
mkdir -p "$HOME/things-lab/bin" "$HOME/things-lab/artifacts"
echo "hardening done"
GUEST

echo "==> L2 (scripted half): install Things WITHOUT launching"
lab_scp "$ZIP" "$LAB_SSH_USER@$IP:/tmp/Things3.zip"
lab_ssh "$IP" '
  set -e
  ditto -xk /tmp/Things3.zip /tmp/things-extract
  sudo mv /tmp/things-extract/Things3.app /Applications/Things3.app
  rm -rf /tmp/Things3.zip /tmp/things-extract
  test -d /Applications/Things3.app && echo "Things installed (NOT launched)"
  # NOT the sdef(1) tool — it requires full Xcode, absent in vanilla guests.
  # Things ships its dictionary as a bundle resource; copying it is equivalent.
  cp /Applications/Things3.app/Contents/Resources/Things.sdef "$HOME/things-lab/artifacts/Things.sdef"
  wc -c "$HOME/things-lab/artifacts/Things.sdef"
'

echo "==> metadata skeleton"
lab_ssh "$IP" "cat > \$HOME/things-lab/metadata.json" <<META
{
  "golden": "$VM",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "baseImage": "$LAB_BASE_IMAGE",
  "thingsZipSha256": "$(shasum -a 256 "$ZIP" | cut -d' ' -f1)",
  "thingsVersion": "3.22.11",
  "trialFirstLaunch": null,
  "pinnedDate": null,
  "schemaFingerprint": null,
  "seedManifest": null,
  "humanLayersDone": []
}
META

echo "==> stop (golden stays stopped until the human seeding session)"
tart stop "$VM"
wait "$RUN_PID" 2>/dev/null || true
tart list | grep "$VM"
echo "GOLDEN SCRIPTED LAYERS OK — next: docs/lab/golden-runbook.md (human session)"
