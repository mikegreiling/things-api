#!/bin/bash
# Re-ship dist/ to the running TORPH1 clone (iteration helper; the campaign
# driver ships it on bootstrap, this is for REUSE=1 loops).
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=lab/scripts/env.sh
source lab/scripts/env.sh
export TART_HOME="${TART_HOME:-/Volumes/Workspace/tart}"
IP=$(tart ip "${1:-things-run-torph1}")
sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
echo "redeployed dist to $IP"
