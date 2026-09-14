#!/bin/bash
# GV5 — the DRPLC1 positive control, run on a THROWAWAY clone of a freshly
# minted golden before it is trusted with a sweep.
#
#   bash lab/scripts/gv5-poscontrol.sh things-lab-golden-v5
#   bash lab/scripts/gv5-poscontrol.sh things-lab-golden-v5h
#
# The trial wall is SILENT (REPX3): past it Things runs read-only and drops
# every write, which is indistinguishable from an app-behavior finding. So a
# newly-swapped golden must be shown to ACCEPT a write before anything is
# measured on it: create an area through the normal CLI, read it back in the
# database, delete it. Also re-reads the trial clock and — on a helpers golden
# — `things helpers status --json`, which the DRPLC1 note says survives an app
# swap because the TCC rows key on the HELPER's signing requirement.
#
# Leaves nothing behind: the clone is deleted on exit. The GOLDEN is never
# booted by this script.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

GOLDEN="${1:?usage: gv5-poscontrol.sh <golden-name>}"
REPO_ROOT="$(cd ../.. && pwd)"
VM="things-poscontrol-${GOLDEN##*-}"
OUT="$REPO_ROOT/lab/artifacts/poscontrol-${GOLDEN##*-}"
PIN="${PINNED_DATE:-2026-07-05}"
PIN_ARG="${PIN:5:2}${PIN:8:2}1200${PIN:0:4}"
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
PROBE="GV5-POSCONTROL-AREA"

mkdir -p "$OUT"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "$*" | tee -a "$REPORT"; }

GSQL='#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 -noheader -list "file:$DB?mode=ro" "$1"'
gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }

IP=""
cleanup() {
  local code=$?
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 2
  tart delete "$VM" >/dev/null 2>&1 || true
  exit "$code"
}

note "=== GV5 positive control — $GOLDEN — $(date) ==="
df -g /Volumes/Workspace | tail -1 | tee -a "$REPORT"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
trap cleanup EXIT
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP="$(lab_wait_for_ssh "$VM" 600)"
note "guest ip: $IP"

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG="$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)"
note "airgap: $AG"
[ "$AG" = "AIRGAP-OK" ] || exit 1
lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN_ARG >/dev/null" </dev/null
note "clock: $(lab_ssh "$IP" 'date -u' </dev/null)"

note "app: $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null | tr '\n' '/')"
note "trial clock (firstAppLaunchDate): $(lab_ssh "$IP" 'defaults read com.culturedcode.ThingsMac firstAppLaunchDate 2>/dev/null || echo "(unset in this domain)"' </dev/null)"
note "trial clock (container plist): $(lab_ssh "$IP" 'defaults read ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist firstAppLaunchDate 2>/dev/null || echo "(unset)"' </dev/null)"

note "-- shipping the CLI --"
lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
printf '%s\n' "$GSQL" | lab_ssh "$IP" 'cat > ~/labh/gsql.sh; chmod +x ~/labh/gsql.sh'
NODE_BIN="$(node -e 'console.log(process.execPath)')"
lab_scp -O "$NODE_BIN" "$LAB_SSH_USER@$IP:/Users/admin/things-lab/bin/node" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node; rm -rf ~/things-lab/things-api/dist' </dev/null
lab_scp -O -r "$REPO_ROOT/dist" "$LAB_SSH_USER@$IP:/Users/admin/things-lab/things-api/" >/dev/null
lab_scp -O -r "$(lab_commander_dir)" "$LAB_SSH_USER@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
lab_scp -O "$REPO_ROOT/package.json" "$LAB_SSH_USER@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null

if [[ "$GOLDEN" == *h ]]; then
  note "-- helpers status (DRPLC1: the grants must survive the app swap) --"
  lab_ssh "$IP" "$CLI helpers status --json" </dev/null 2>&1 | tee -a "$REPORT"
  note ""
fi

note "-- warm the app --"
lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
note "app running: $(lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo yes || echo no' </dev/null)"

BEFORE="$(gq 'SELECT COUNT(*) FROM TMArea')"
note "areas before: $BEFORE"
note "-- create --"
lab_ssh "$IP" "$LAB_WRITE_DIRECT $CLI area add $PROBE --json; echo EXIT=\$?" </dev/null 2>&1 | tail -3 | tee -a "$REPORT"
sleep 2
AFTER="$(gq 'SELECT COUNT(*) FROM TMArea')"
UUID="$(gq "SELECT uuid FROM TMArea WHERE title='$PROBE'")"
note "areas after: $AFTER   probe uuid: ${UUID:-(none)}"
if [ "$AFTER" = "$BEFORE" ] || [ -z "$UUID" ]; then
  note "POSITIVE CONTROL FAILED: the app accepted no write (trial wall, or worse)."
  exit 9
fi
note "-- read back through the CLI --"
lab_ssh "$IP" "$CLI show $UUID --json" </dev/null 2>&1 | head -c 400 | tee -a "$REPORT"
note ""
note "-- delete --"
lab_ssh "$IP" "$LAB_WRITE_DIRECT $CLI area delete $UUID --dangerously-permanent --allow-non-empty --json; echo EXIT=\$?" </dev/null 2>&1 | tail -2 | tee -a "$REPORT"
sleep 2
FINAL="$(gq 'SELECT COUNT(*) FROM TMArea')"
note "areas final: $FINAL (expected $BEFORE)"
[ "$FINAL" = "$BEFORE" ] || { note "POSITIVE CONTROL FAILED: the delete did not land."; exit 9; }

note "-- doctor --"
lab_ssh "$IP" "$CLI doctor --json" </dev/null 2>&1 | head -c 900 | tee -a "$REPORT"
note ""
note "POSITIVE CONTROL OK — $GOLDEN accepts writes; the trial wall is not in play."
