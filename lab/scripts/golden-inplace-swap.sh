#!/bin/bash
# In-place Things-version swap into a NEW golden (drift-runbook DRIFT-1
# in-place path — the routine recipe used to mint golden-v2 and golden-v3,
# scripted here for golden-v4).
#
#   bash lab/scripts/golden-inplace-swap.sh <from-golden> <new-version>
#   bash lab/scripts/golden-inplace-swap.sh things-lab-golden-v3 v4
#
# Clones the prior golden (APFS COW — every human-seeded layer rides along:
# seed dataset, TCC grants incl. the AXVM1 accessibility grant, the
# disruption-monitor LaunchAgent, the Shortcuts proxies, the trial clock),
# airgaps it, pins the clock BEFORE Things is ever launched, swaps
# /Applications/Things3.app for $REPO_ROOT/vendor/Things3.zip, warms the app
# up once so any database migration runs, and collects the structural
# evidence (Info.plist version pair, sdef digest, pre/post DB copies).
#
# Leaves the new golden STOPPED. Writes artifacts to
# lab/artifacts/<new-version>-build/ (gitignored).
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

FROM="${1:?usage: golden-inplace-swap.sh <from-golden> <new-version>}"
VERSION="${2:?usage: golden-inplace-swap.sh <from-golden> <new-version>}"
VM="things-lab-golden-$VERSION"
REPO_ROOT="$(cd ../.. && pwd)"
ZIP="$REPO_ROOT/vendor/Things3.zip"
OUT="$REPO_ROOT/lab/artifacts/$VERSION-build"
PINNED_DATE="${PINNED_DATE:-2026-07-05}"

[ -f "$ZIP" ] || { echo "missing $ZIP (see vendor/manifest.json)" >&2; exit 1; }
tart list | awk '{print $2}' | grep -qx "$FROM" || { echo "source golden $FROM not found" >&2; exit 1; }
if tart list | awk '{print $2}' | grep -qx "$VM"; then
  echo "VM $VM already exists — delete it first if rebuilding: tart delete $VM" >&2
  exit 1
fi
mkdir -p "$OUT"

echo "==> clone $FROM -> $VM (APFS COW)"
tart clone "$FROM" "$VM"

RUN_PID=""
cleanup() {
  local code=$?
  if [ -n "$RUN_PID" ]; then
    tart stop "$VM" >/dev/null 2>&1 || true
    wait "$RUN_PID" 2>/dev/null || true
  fi
  [ "$code" -ne 0 ] && echo "SWAP FAILED (exit $code) — $VM left on disk for inspection" >&2
  exit "$code"
}
trap cleanup EXIT

echo "==> boot (headless)"
tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &
RUN_PID=$!
IP="$(lab_wait_for_ssh "$VM" 300)"
echo "==> guest IP: $IP"

echo "==> airgap (delete default route) + pin clock to $PINNED_DATE BEFORE any launch"
lab_ssh "$IP" 'sudo route -n delete default' >/dev/null 2>&1 || true
NET="$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo up || echo down')"
[ "$NET" = "down" ] || { echo "guest still routable after route deletion" >&2; exit 1; }
Y="${PINNED_DATE:0:4}"; M="${PINNED_DATE:5:2}"; D="${PINNED_DATE:8:2}"
lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date ${M}${D}1200${Y}"
lab_ssh "$IP" 'date -u; pgrep -x Things3 && echo "WARN: Things running" || echo "Things not running"'

echo "==> pre-swap evidence (old app + pre-migration DB)"
lab_scp "$REPO_ROOT/lab/guest/probe-runner.py" "$LAB_SSH_USER@$IP:things-lab/probe-runner-swap.py"
lab_ssh "$IP" 'set -e
  defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString
  defaults read /Applications/Things3.app/Contents/Info CFBundleVersion
  shasum -a 256 /Applications/Things3.app/Contents/Resources/Things.sdef
  python3 things-lab/probe-runner-swap.py --copy-db ~/things-lab/db-pre-swap.sqlite
' | tee "$OUT/pre-swap.txt"
lab_scp "$LAB_SSH_USER@$IP:things-lab/db-pre-swap.sqlite" "$OUT/db-pre-swap.sqlite"

echo "==> swap /Applications/Things3.app"
lab_scp "$ZIP" "$LAB_SSH_USER@$IP:/tmp/Things3.zip"
lab_ssh "$IP" 'set -e
  shasum -a 256 /tmp/Things3.zip
  rm -rf /tmp/things-extract
  ditto -xk /tmp/Things3.zip /tmp/things-extract
  sudo rm -rf /Applications/Things3.app          # unlink, never overwrite in place
  sudo mv /tmp/things-extract/Things3.app /Applications/Things3.app
  rm -rf /tmp/Things3.zip /tmp/things-extract
  defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString
  defaults read /Applications/Things3.app/Contents/Info CFBundleVersion
  defaults read /Applications/Things3.app/Contents/Info LSMinimumSystemVersion
  shasum -a 256 /Applications/Things3.app/Contents/Resources/Things.sdef
  codesign -dv /Applications/Things3.app 2>&1 | sed -n "1,8p"
  cp /Applications/Things3.app/Contents/Resources/Things.sdef ~/things-lab/artifacts/Things.sdef
' | tee "$OUT/post-swap.txt"
lab_scp "$LAB_SSH_USER@$IP:things-lab/artifacts/Things.sdef" "$OUT/Things.sdef"

echo "==> warm-up launch (runs any database migration), then clean quit"
lab_ssh "$IP" 'open -g -a Things3'
deadline=$((SECONDS + 120))
until lab_ssh "$IP" 'python3 things-lab/probe-runner-swap.py --check-db' >/dev/null 2>&1; do
  [ "$SECONDS" -lt "$deadline" ] || { echo "DB never became readable after launch" >&2; exit 1; }
  sleep 3
done
# settle: let the migration + Today/repeat recomputation quiesce, then confirm
# the database version has stopped moving before quitting.
DBVER_PY='import glob,os,sqlite3
p=glob.glob(os.path.expanduser("~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite"))[0]
c=sqlite3.connect("file:%s?mode=ro"%p,uri=True,timeout=5.0)
print(c.execute("SELECT value FROM Meta WHERE key=?",("databaseVersion",)).fetchone()[0])'
prev=""; stable=0; deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
  cur="$(lab_ssh "$IP" "python3 -c '$DBVER_PY'" 2>/dev/null || true)"
  if [ -n "$cur" ] && [ "$cur" = "$prev" ]; then
    stable=$((stable + 1)); [ "$stable" -ge 3 ] && break
  else
    stable=0
  fi
  prev="$cur"
  sleep 5
done
echo "databaseVersion (guest, post-migration): ${prev:-unknown}" | tee -a "$OUT/post-swap.txt"
lab_ssh "$IP" 'osascript -e '"'"'tell application "Things3" to quit'"'"''
deadline=$((SECONDS + 60))
until ! lab_ssh "$IP" 'pgrep -x Things3 >/dev/null'; do
  [ "$SECONDS" -lt "$deadline" ] || { echo "Things did not quit" >&2; exit 1; }
  sleep 2
done
echo "warm-up complete (Things quit cleanly)"

echo "==> post-migration DB + housekeeping"
lab_ssh "$IP" 'set -e
  python3 things-lab/probe-runner-swap.py --copy-db ~/things-lab/db-post-swap.sqlite
  : > ~/things-lab/events.ndjson
  rm -f things-lab/probe-runner-swap.py
  ls ~/things-lab
  shortcuts list 2>/dev/null | sort
  sqlite3 -readonly "$HOME/Library/Application Support/com.apple.TCC/TCC.db" \
    "SELECT service, client, auth_value FROM access ORDER BY service" 2>/dev/null || true
  sudo sqlite3 -readonly /Library/Application\ Support/com.apple.TCC/TCC.db \
    "SELECT service, client, auth_value FROM access ORDER BY service" 2>/dev/null || true
  defaults read com.culturedcode.ThingsMac firstAppLaunchDate 2>/dev/null || true
' | tee "$OUT/housekeeping.txt"
lab_scp "$LAB_SSH_USER@$IP:things-lab/db-post-swap.sqlite" "$OUT/db-post-swap.sqlite"

echo "==> stop (golden freezes here)"
tart stop "$VM"
wait "$RUN_PID" 2>/dev/null || true
RUN_PID=""
trap - EXIT
tart list | grep "$VM"
echo "SWAP OK — artifacts in $OUT"
