#!/bin/bash
# SBRES1 — where the NEW snapshot's wall clock goes, phase by phase.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/${VM:-sbres1-lab}"
source "$OUT/session.env"
sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O lab/scripts/sbres1-probe.jxa.js "admin@$IP:/Users/admin/labh/sbres1.js" >/dev/null
TITLES=$(lab_ssh "$IP" "~/labh/gsql.sh -q 'SELECT group_concat(title, \"|\") FROM (SELECT title FROM TMArea ORDER BY \"index\", uuid)'" </dev/null)
lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/sbres1.js phases $(printf '%q' "$TITLES")" </dev/null 2>&1 | tee "$OUT/phases.json"
echo
