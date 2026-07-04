#!/bin/bash
# One-off research: what comparator does the Things UI use for Today when
# todayIndexReferenceDate values are STALE? (Phase 10c)
#
# The golden's seeds carry referenceDate = the golden pin day (2026-07-05).
# Booting a clone pinned TWO DAYS LATER (07-07) manufactures staleness:
# launch-time maintenance runs against stale rows, upcoming seeds promote
# into Today, and freshly-added items get a 07-07 referenceDate. We then
# read the UI's own ordering via AppleScript (ground truth) and dump the
# DB columns to correlate.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-todayorder-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"
mkdir -p "$OUT"

cleanup() {
  echo "[research] teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[research] cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
echo "[research] ssh up at $IP"

echo "[research] airgap + pin clock to 2026-07-07 (2 days past golden pin)"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && exit 1 || exit 0'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070712002026 >/dev/null'

echo "[research] launch Things (maintenance runs against stale referenceDates)"
lab_ssh "$IP" 'open -g -a Things3; sleep 12'

echo "[research] add fresh Today items (referenceDate = 07-07 cohort) + membership edges"
for url in \
  'things:///add?title=F-NEW-1&when=today' \
  'things:///add?title=F-NEW-2&when=today' \
  'things:///add?title=F-NEW-3&when=today' \
  'things:///add?title=F-DL-TODAY&deadline=2026-07-07' \
  'things:///add?title=F-DL-FUTURE-START&when=2026-07-10&deadline=2026-07-06' \
  'things:///add?title=F-EVE-NEW&when=evening'; do
  lab_ssh "$IP" "open -g '$url'"
  sleep 2
done
sleep 3

echo "[research] UI ground truth: AppleScript order of list Today"
lab_ssh "$IP" 'osascript -e "with timeout of 60 seconds
tell application \"Things3\" to get id of to dos of list \"Today\"
end timeout"' > "$OUT/ui-order.txt"

echo "[research] copy DB out"
lab_ssh "$IP" 'DB="$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)"; sqlite3 "$DB" ".backup /tmp/research.sqlite"'
lab_scp "$LAB_SSH_USER@$IP:/tmp/research.sqlite" "$OUT/research.sqlite"

echo "[research] DB rows (Today members):"
sqlite3 "$OUT/research.sqlite" -header -column "
SELECT substr(title,1,22) AS title, uuid, start, startDate, startBucket,
       todayIndex, todayIndexReferenceDate
FROM TMTask
WHERE trashed=0 AND status=0 AND startDate IS NOT NULL AND start IN (1,2)
  AND rt1_recurrenceRule IS NULL AND repeater IS NULL AND type IN (0,1)
ORDER BY startBucket, todayIndex" | tee "$OUT/db-order.txt"

echo "[research] GREEN — artifacts in $OUT"
trap - EXIT
cleanup
