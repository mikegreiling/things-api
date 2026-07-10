#!/bin/bash
# SX6 — end-to-end IMPORT validation of the repaired signed
# shortcuts/things-proxy-find-items.shortcut in a FRESH clone (queued VM work
# item 4, s-campaign-results.md 2026-07-10). ONE clone.
#
#   SX6a  `open` the signed file (shipped as sx6-import-test.shortcut to
#         dodge the golden-resident name) → import sheet appears
#         (signature accepted). Screenshot.
#   SX6b  VNC arm: tart run --vnc-experimental exposes an RFB server;
#         synthetic clicks arrive as hardware input (no TCC). Click
#         "Add Shortcut" via vncdotool → the shortcut LANDS in
#         Shortcuts.sqlite (ZSHORTCUT row) = import validated end-to-end.
#         Needs $VNCDO (vncdotool CLI); degrades to sheet-screenshot-only.
#   SX6c  stretch: `shortcuts run sx6-import-test` — fresh identity means a
#         consent modal; try to VNC-click Always Allow, then check output.
#
# Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}" # path to a vncdotool CLI (optional)

VM="things-run-sx6-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[sx6] $*" | tee -a "$REPORT"; }
cleanup() { echo "[sx6] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
note "vnc url: ${VNC_URL:-<none>}"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

shot() { lab_ssh "$IP" "screencapture -x /tmp/sx6-$1.png 2>/dev/null || true" </dev/null; lab_scp "$LAB_SSH_USER@$IP:/tmp/sx6-$1.png" "$OUT/" </dev/null 2>/dev/null || true; }
sdb() { lab_ssh "$IP" "sqlite3 -readonly ~/Library/Shortcuts/Shortcuts.sqlite $(printf '%q' "$1")" </dev/null; }

note "== [SX6a] ship + open the signed repaired file =="
lab_scp "shortcuts/things-proxy-find-items.shortcut" "$LAB_SSH_USER@$IP:/tmp/sx6-import-test.shortcut" </dev/null
lab_ssh "$IP" 'open /tmp/sx6-import-test.shortcut' </dev/null
sleep 12
shot "import-sheet"
note "-- pre-click ZSHORTCUT rows named sx6-import-test:"
sdb "SELECT COUNT(*) FROM ZSHORTCUT WHERE ZNAME='sx6-import-test'" | tee -a "$REPORT"

if [ -n "$VNCDO" ] && [ -n "$VNC_URL" ]; then
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"                 # host:port
  SERVER="${HP%%:*}::${HP##*:}"                          # vncdotool raw-port syntax
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  note "== [SX6b] VNC arm (server $SERVER) =="
  # Phase 1 (SX6_CLICK unset): grab a coordinate-true framebuffer capture and
  # stop — read the Add Shortcut button position off it. Phase 2 (rerun with
  # SX6_CLICK="x y"): the sheet layout is deterministic per golden resolution,
  # so click there, then verify the DB landing.
  "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} capture "$OUT/vnc-sheet.png" 2>&1 | tee -a "$REPORT" || true
  if [ -n "${SX6_CLICK:-}" ]; then
    read -r CX CY <<<"$SX6_CLICK"
    "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} move "$CX" "$CY" click 1 2>&1 | tee -a "$REPORT" || true
    sleep 8
    shot "after-add"
    "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} capture "$OUT/vnc-after-add.png" 2>&1 | tee -a "$REPORT" || true
    note "-- post-click ZSHORTCUT rows named sx6-import-test (1 = IMPORT VALIDATED):"
    sdb "SELECT COUNT(*) FROM ZSHORTCUT WHERE ZNAME='sx6-import-test'" | tee -a "$REPORT"
    note "-- shortcuts list:"
    lab_ssh "$IP" 'shortcuts list | grep -i sx6 || true' </dev/null | tee -a "$REPORT"
  else
    note "SX6_CLICK not set — phase 1 only (capture for coordinates, no click)"
  fi
else
  note "VNCDO/VNC_URL unavailable — sheet screenshot only; manual click needed for DB landing"
fi

note "artifacts in $OUT"
ls -la "$OUT" | tee -a "$REPORT"
note "DONE. Report: $REPORT"
