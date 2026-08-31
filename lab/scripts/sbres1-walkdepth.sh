#!/bin/bash
# SBRES1 helper cell — how deep does the per-row text walk actually need to go?
# Run after `research-sbres1.sh setup && … seed`.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/${VM:-sbres1-lab}"
source "$OUT/session.env"
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO lab/scripts/sbres1-probe.jxa.js "admin@$IP:/Users/admin/labh/sbres1.js" >/dev/null
TITLES=$(lab_ssh "$IP" "~/labh/gsql.sh -q 'SELECT group_concat(title, \"|\") FROM (SELECT title FROM TMArea ORDER BY \"index\", uuid)'" </dev/null)
echo "area titles: $TITLES"
lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/sbres1.js walkdepth $(printf '%q' "$TITLES")" </dev/null 2>&1 \
  | tee "$OUT/walkdepth.json" \
  | python3 -c '
import json,sys
for r in json.load(sys.stdin):
    print("depth=%d  %5dms  calls=%5d  rows=%d  blank=%d  titles=%d/%d" % (r["depth"],r["ms"],r["calls"],r["rows"],r["blankRows"],r["titlesMatched"],r["of"]))
    for s in r["sample"]: print("      ", repr(s))
'
