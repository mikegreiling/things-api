#!/bin/bash
# Read-only access to the LIVE Things database — the ONE stable command
# shape agents use for prod reads, so a single permission grant covers all
# of them (ad-hoc sqlite3/node one-liners each re-prompt the sandbox).
#
# Structurally read-only: sqlite3 opens with SQLITE_OPEN_READONLY; any
# write statement fails. Never add a write mode here — prod writes are
# forbidden (see docs/design/architecture.md).
#
# Usage:
#   scripts/prod-read.sh "<SQL>"          one-shot query (default separator |)
#   scripts/prod-read.sh --json "<SQL>"   JSON row output
set -euo pipefail

MODE=""
if [ "${1:-}" = "--json" ]; then
  MODE="--json"
  shift
fi
SQL="${1:?usage: prod-read.sh [--json] \"<SQL>\"}"

DB=$(/bin/ls -d "$HOME/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-"*"/Things Database.thingsdatabase/main.sqlite" 2>/dev/null | head -1)
[ -n "$DB" ] || { echo "Things database not found" >&2; exit 7; }

# shellcheck disable=SC2086
exec /usr/bin/sqlite3 $MODE -readonly "$DB" "$SQL"
