#!/bin/bash
# SBRES1 — certify the batched harvest per depth against the CONSUMER contract
# (spacer detection + area-title segment matching), not against byte identity.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/${VM:-sbres1-lab}"
source "$OUT/session.env"
sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O lab/scripts/sbres1-probe.jxa.js "admin@$IP:/Users/admin/labh/sbres1.js" >/dev/null
TITLES=$(lab_ssh "$IP" "~/labh/gsql.sh -q 'SELECT group_concat(title, \"|\") FROM (SELECT title FROM TMArea ORDER BY \"index\", uuid)'" </dev/null)
echo "area titles: $TITLES"
lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/sbres1.js deptheq $(printf '%q' "$TITLES")" </dev/null 2>&1 \
  | tee "$OUT/deptheq.json" \
  | python3 -c '
import json,sys
for r in json.load(sys.stdin):
    extra = ""
    if "spacerRowsAgree" in r:
        extra = "  spacers=%s  areaMatches=%s  byteIdentical=%s" % (r["spacerRowsAgree"], r["areaTitleMatchesAgree"], r["byteIdentical"])
        if r.get("firstDisagreement"): extra += "  !! " + json.dumps(r["firstDisagreement"])
    print("%-32s %6dms  calls=%5d%s" % (r["label"], r["ms"], r["calls"], extra))
'
