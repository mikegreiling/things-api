#!/bin/bash
# The pointer-guard diagnostic, in a routed guest — the same provisioning as any
# other Stage 5 run, with lab/guest/stage5-arprobe.sh as the cell script.
#
#   RC_DIST=/path/to/package/dist bash lab/scripts/stage5-arprobe-run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
GUEST_CELLS=lab/guest/stage5-arprobe.sh exec bash lab/scripts/stage5-rc-run.sh "$@"
