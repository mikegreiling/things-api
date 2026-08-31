#!/bin/bash
# SBRES1 — time the SHIPPED sidebar snapshot script N times against the clone,
# and print the head of what it returned. The before/after number for the re-cut.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/${VM:-sbres1-lab}"
source "$OUT/session.env"
N="${1:-3}"
for i in $(seq 1 "$N"); do
  lab_ssh "$IP" 'S=$( { /usr/bin/time -p /usr/bin/osascript -l JavaScript ~/labh/sidebar-snap.js >/tmp/snap.json ; } 2>&1 ); echo "$S" | tr "\n" " "; echo "bytes=$(wc -c < /tmp/snap.json)"' </dev/null 2>&1
done
echo "--- snapshot head ---"
lab_ssh "$IP" 'head -c 400 /tmp/snap.json; echo' </dev/null
