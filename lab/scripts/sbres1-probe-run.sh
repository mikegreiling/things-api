#!/bin/bash
# SBRES1 — push the probe and run one verb against the live clone.
#   bash lab/scripts/sbres1-probe-run.sh <verb> [args…]
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/${VM:-sbres1-lab}"
source "$OUT/session.env"
sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O lab/scripts/sbres1-probe.jxa.js "admin@$IP:/Users/admin/labh/sbres1.js" >/dev/null
lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/sbres1.js $*" </dev/null 2>&1
