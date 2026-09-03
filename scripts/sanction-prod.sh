#!/usr/bin/env bash
# MAINTAINER-ONLY. Grants a time-boxed sanction for agent-driven writes / GUI
# drives against PRODUCTION Things on this host (see AGENTS.md § Safety rails and
# .claude/hooks/prod-things-guard.sh). Run it in YOUR OWN terminal — the guard
# hook refuses any agent command that names this script.
#
#   scripts/sanction-prod.sh <minutes> "<what you are sanctioning>"
#   scripts/sanction-prod.sh revoke
set -euo pipefail
f="${HOME}/.local/state/things-api/prod-sanction"
if [ "${1:-}" = "revoke" ]; then rm -f "$f"; echo "sanction revoked"; exit 0; fi
mins="${1:-}"; reason="${2:-}"
if ! [[ "$mins" =~ ^[0-9]+$ ]] || [ -z "$reason" ]; then
  echo "usage: $0 <minutes> \"<reason>\" | $0 revoke" >&2; exit 64
fi
mkdir -p "$(dirname "$f")"
exp=$(( $(date +%s) + mins*60 ))
printf '%s %s\n' "$exp" "$reason" > "$f"
echo "production sanction until $(date -r "$exp" '+%H:%M:%S') — $reason"
