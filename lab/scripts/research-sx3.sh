#!/bin/bash
# SX3 — extract ALL six proxies' action blobs + per-shortcut scalar metadata
# (§A distribution; SX2's while-read loop lost 5 of 6 blobs to an inner-ssh
# stdin steal). ONE clone, dump-and-ship. Host-side reconstruction + signing
# proven by SX2's create-heading blob (`shortcuts sign --mode anyone` exit 0).
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-sx3-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[sx3] $*" | tee -a "$REPORT"; }
cleanup() { echo "[sx3] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null

SDB='/Users/admin/Library/Shortcuts/Shortcuts.sqlite'
# One in-VM script: no host-side loops over ssh, no stdin to steal.
lab_ssh "$IP" "cat > /tmp/sx3-dump.sh && chmod +x /tmp/sx3-dump.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
SDB="$HOME/Library/Shortcuts/Shortcuts.sqlite"
mkdir -p /tmp/sx3-out
sqlite3 -readonly "$SDB" "SELECT s.ZNAME, s.ZACTIONS, s.ZHASSHORTCUTINPUTVARIABLES, s.ZHASOUTPUTFALLBACK, s.ZACTIONCOUNT, s.ZMINIMUMCLIENTVERSION, s.ZLASTMIGRATEDCLIENTVERSION FROM ZSHORTCUT s WHERE s.ZNAME LIKE 'things-proxy-%'" > /tmp/sx3-out/meta.psv
while IFS='|' read -r name actions rest; do
  [ -n "$actions" ] || continue
  sqlite3 -readonly "$SDB" "SELECT writefile('/tmp/sx3-out/$name.ZDATA.blob', ZDATA) FROM ZSHORTCUTACTIONS WHERE Z_PK = $actions AND ZDATA IS NOT NULL" >/dev/null
  # per-shortcut metadata blobs (output classes DIFFER per proxy)
  for col in ZINPUTCLASSESDATA ZOUTPUTCLASSESDATA ZIMPORTQUESTIONSDATA ZNOINPUTBEHAVIORDATA; do
    sqlite3 -readonly "$SDB" "SELECT writefile('/tmp/sx3-out/$name.$col.blob', $col) FROM ZSHORTCUT WHERE ZNAME = '$name' AND $col IS NOT NULL" >/dev/null
  done
done < /tmp/sx3-out/meta.psv
ls -la /tmp/sx3-out/
EOF
note "== in-VM dump =="
lab_ssh "$IP" '/tmp/sx3-dump.sh' </dev/null | tee -a "$REPORT"

note "== ship =="
lab_ssh "$IP" 'cd /tmp && tar cf - sx3-out' </dev/null | (cd "$OUT" && tar xf -)
cat "$OUT/sx3-out/meta.psv" | tee -a "$REPORT"
ls -la "$OUT/sx3-out/" | tee -a "$REPORT"
note "DONE."
