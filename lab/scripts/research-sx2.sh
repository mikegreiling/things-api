#!/bin/bash
# SX2 — extract the six proxies' ACTION blobs from ZSHORTCUTACTIONS (§A
# distribution, follow-up to SX which dumped only ZSHORTCUT's metadata blobs).
# ONE clone, dump-and-ship; old-format reconstruction + signing happen on the
# HOST afterwards (host has python3 + an Apple ID for `shortcuts sign`).
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-sx2-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[sx2] $*" | tee -a "$REPORT"; }
cleanup() { echo "[sx2] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'

SDB='/Users/admin/Library/Shortcuts/Shortcuts.sqlite'
sq() { lab_ssh "$IP" "sqlite3 -readonly $(printf '%q' "$SDB") $(printf '%q' "$1")"; }

note "== ZSHORTCUTACTIONS schema =="
sq "PRAGMA table_info(ZSHORTCUTACTIONS)" | tee -a "$REPORT"

note "== shortcut -> actions row map =="
sq "SELECT s.Z_PK, s.ZNAME, s.ZACTIONS FROM ZSHORTCUT s WHERE s.ZNAME LIKE 'things-proxy-%'" | tee -a "$REPORT"

note "== dump every BLOB column of each proxy's actions row =="
lab_ssh "$IP" 'mkdir -p /tmp/sx2-out'
BLOBCOLS=$(sq "SELECT group_concat(name) FROM pragma_table_info('ZSHORTCUTACTIONS') WHERE type='BLOB'")
note "blob columns: ${BLOBCOLS:-none}"
IFS=',' read -ra COLS <<< "$BLOBCOLS"
while IFS='|' read -r pk name actions; do
  [ -n "$actions" ] || { note "  $name: ZACTIONS NULL"; continue; }
  for col in "${COLS[@]}"; do
    sq "SELECT writefile('/tmp/sx2-out/$name.$col.blob', $col) FROM ZSHORTCUTACTIONS WHERE Z_PK = $actions AND $col IS NOT NULL" >/dev/null 2>&1 || true
  done
done < <(sq "SELECT s.Z_PK, s.ZNAME, s.ZACTIONS FROM ZSHORTCUT s WHERE s.ZNAME LIKE 'things-proxy-%'")

note "== inventory + magic + parse heads =="
lab_ssh "$IP" 'for f in /tmp/sx2-out/*.blob; do [ -f "$f" ] || continue; printf "%s  %s bytes  " "$f" "$(stat -f%z "$f")"; head -c 8 "$f" | xxd -p; done' | tee -a "$REPORT" || true
lab_ssh "$IP" 'for f in /tmp/sx2-out/*.blob; do [ -f "$f" ] || continue; if head -c 6 "$f" | grep -q bplist; then echo "== $f"; plutil -p "$f" 2>&1 | head -25; fi; done' | tee -a "$REPORT" || true

note "== ship =="
lab_ssh "$IP" 'cd /tmp && tar cf - sx2-out' | (cd "$OUT" && tar xf -)
ls -la "$OUT/sx2-out/" | tee -a "$REPORT" || true
note "DONE. Host next: reconstruct old-format .shortcut + shortcuts sign."
