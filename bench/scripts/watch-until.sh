#!/bin/bash
# Bounded watcher for DETACHED long-running work (bench sweeps, loop batches,
# VM campaigns). Exists because ad-hoc watchers repeatedly lapsed and left
# supervising agents idle while the work they were watching had already
# finished (2026-07-21, three occurrences).
#
# Usage: watch-until.sh [--interval N] [--timeout N] -- <predicate cmd...>
#   Polls the predicate every N seconds (default 30) until it exits 0 → exit 0.
#   At the timeout (default 1200 s — deliberately under the harness ~25-min
#   background-task kill) → exit 42 ("not done yet, re-arm me").
#
# Supervision protocol (the part that actually fixes the failure mode):
#   1. Launch the watched work fully detached (nohup … & disown).
#   2. Arm THIS script as a harness background task so its exit re-invokes you.
#   3. On EVERY wake — whatever the notification says — run the predicate
#      yourself once, synchronously. Done → proceed to your next step NOW.
#   4. Not done → re-arm this script. Exit 42 means exactly that; it is not
#      an error.
#   5. Never idle without an armed watcher, and never trust notification
#      prose over the predicate's own answer.
set -euo pipefail

INTERVAL=30
TIMEOUT=1200
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) INTERVAL=$2; shift 2 ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || { echo "usage: watch-until.sh [--interval N] [--timeout N] -- <cmd...>" >&2; exit 2; }

elapsed=0
while true; do
  if "$@" >/dev/null 2>&1; then
    exit 0
  fi
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    exit 42
  fi
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done
