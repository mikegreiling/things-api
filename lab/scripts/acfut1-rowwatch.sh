#!/bin/bash
# ACFUT1 side-car: dump the INSTANCE rows of every ACFUT1 template, read-only,
# alongside the main driver (whose instrows helper mis-quotes and returns empty).
# Read-only SQLite against the guest — cannot perturb the campaign.
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
IP="${IP:-192.168.64.3}"
OUT="lab/artifacts/acfut1-lab/rows.txt"
Q="SELECT t.title||' | inst='||substr(i.uuid,1,8)||' sd='||IFNULL(i.startDate,'-')||' status='||i.status||' trashed='||i.trashed||' bkt='||IFNULL(i.startBucket,'-')||' created='||IFNULL(i.creationDate,'-') FROM TMTask i JOIN TMTask t ON i.rt1_repeatingTemplate=t.uuid WHERE t.title LIKE 'ACFUT1-%' ORDER BY t.title, i.startDate"
for i in $(seq 1 200); do
  {
    echo "=== $(lab_ssh "$IP" 'date "+%Y-%m-%d %H:%M:%S"' </dev/null) app=$(lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null) ==="
    lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$Q")" </dev/null
  } >>"$OUT" 2>&1
  sleep 15
done
