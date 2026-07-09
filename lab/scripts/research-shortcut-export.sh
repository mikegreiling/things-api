#!/bin/bash
# SX — shortcut-extraction probe (§A distribution, 2026-07-09). ONE clone.
#
# lab/shortcuts/ is empty because `shortcuts export` does not exist (the l5
# script's export loop warned and moved on). The six proxies live only inside
# the golden. Question: can we get them OUT headlessly, as files that
# `shortcuts sign` accepts ("also supports signing a shortcut in the old
# format"), making the proxies repo-distributable signed .shortcut files —
# instead of a manual rebuild + iCloud links (roadmap §A)?
#   SX1  Where does Shortcuts store workflows in the VM? (Shortcuts.sqlite
#        schema dump — table/column enumeration, no assumptions.)
#   SX2  Are the six proxies' action blobs present + parseable binary plists
#        (WFWorkflowActions), or encrypted/opaque?
#   SX3  Wrap a blob as an old-format .shortcut plist; does `shortcuts sign`
#        accept it on an Apple-ID-less machine (in-VM)?
#   SX4  Ship blobs + wrapped plists to host artifacts for a host-side sign
#        attempt (host has an Apple ID; run manually after this script).
# Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-sx-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[sx] $*" | tee -a "$REPORT"; }
cleanup() { echo "[sx] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PROXIES=(things-proxy-find-items things-proxy-create-heading things-proxy-edit-title things-proxy-set-detail things-proxy-delete-items things-proxy-delete-items-permanently)

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'

note "== [SX0] shortcuts CLI surface (confirm: no export subcommand) =="
lab_ssh "$IP" 'shortcuts help 2>&1' | tee -a "$REPORT"
lab_ssh "$IP" 'shortcuts list 2>&1' | tee -a "$REPORT"

note "== [SX1] locate the Shortcuts store =="
lab_ssh "$IP" 'ls -la ~/Library/Shortcuts/ 2>/dev/null; ls -d ~/Library/Group\ Containers/*shortcuts* 2>/dev/null; ls -la ~/Library/Group\ Containers/group.com.apple.shortcuts/ 2>/dev/null' | tee -a "$REPORT" || true
SDB=$(lab_ssh "$IP" 'for c in ~/Library/Shortcuts/Shortcuts.sqlite ~/Library/Group\ Containers/group.com.apple.shortcuts/Shortcuts.sqlite; do [ -f "$c" ] && { echo "$c"; break; }; done' || true)
note "store candidate: ${SDB:-NONE FOUND}"
if [ -z "$SDB" ]; then
  note "no sqlite store found — dumping broader search then aborting"
  lab_ssh "$IP" 'find ~/Library -iname "*shortcut*" -maxdepth 4 2>/dev/null' | tee -a "$REPORT" || true
  exit 0
fi

note "-- schema (tables + ZSHORTCUT columns):"
lab_ssh "$IP" "sqlite3 -readonly $(printf '%q' "$SDB") '.tables'" | tee -a "$REPORT"
lab_ssh "$IP" "sqlite3 -readonly $(printf '%q' "$SDB") 'PRAGMA table_info(ZSHORTCUT)'" | tee -a "$REPORT" || true

note "== [SX2] dump per-proxy rows + blobs =="
lab_ssh "$IP" 'mkdir -p /tmp/sx-out'
# Enumerate name column candidates at runtime; ZNAME is the usual suspect.
NAMECOL=$(lab_ssh "$IP" "sqlite3 -readonly $(printf '%q' "$SDB") \"SELECT name FROM pragma_table_info('ZSHORTCUT') WHERE name IN ('ZNAME','ZTITLE','ZWORKFLOWNAME') LIMIT 1\"" || true)
note "name column: ${NAMECOL:-unknown}"
BLOBCOLS=$(lab_ssh "$IP" "sqlite3 -readonly $(printf '%q' "$SDB") \"SELECT group_concat(name) FROM pragma_table_info('ZSHORTCUT') WHERE type='BLOB'\"" || true)
note "blob columns: ${BLOBCOLS:-none}"
if [ -n "$NAMECOL" ]; then
  lab_ssh "$IP" "sqlite3 -readonly $(printf '%q' "$SDB") \"SELECT Z_PK, $NAMECOL FROM ZSHORTCUT\"" | tee -a "$REPORT"
  for s in "${PROXIES[@]}"; do
    IFS=',' read -ra COLS <<< "$BLOBCOLS"
    for col in "${COLS[@]}"; do
      lab_ssh "$IP" "sqlite3 -readonly $(printf '%q' "$SDB") \"SELECT writefile('/tmp/sx-out/$s.$col.blob', $col) FROM ZSHORTCUT WHERE $NAMECOL = '$s' AND $col IS NOT NULL\"" >/dev/null 2>&1 || true
    done
  done
  note "-- blob inventory + magic bytes:"
  lab_ssh "$IP" 'for f in /tmp/sx-out/*.blob; do [ -f "$f" ] || continue; printf "%s  %s bytes  " "$f" "$(stat -f%z "$f")"; head -c 8 "$f" | xxd -p; done' | tee -a "$REPORT" || true
  note "-- plutil parse attempts (bplist blobs only):"
  lab_ssh "$IP" 'for f in /tmp/sx-out/*.blob; do [ -f "$f" ] || continue; if head -c 6 "$f" | grep -q bplist; then echo "== $f"; plutil -p "$f" 2>&1 | head -12; fi; done' | tee -a "$REPORT" || true
fi

note "== [SX3] in-VM sign attempt (Apple-ID-less) =="
# Wrap the create-heading actions blob (if bplist) as an old-format shortcut:
# an old-format .shortcut IS a bare plist with WFWorkflowActions at top level.
lab_ssh "$IP" '
set -e
src=""
for f in /tmp/sx-out/things-proxy-create-heading.*.blob; do
  [ -f "$f" ] && head -c 6 "$f" | grep -q bplist && src="$f" && break
done
if [ -z "$src" ]; then echo "[sx3] no parseable create-heading blob — skip"; exit 0; fi
cp "$src" /tmp/sx-out/candidate.shortcut
shortcuts sign --mode anyone -i /tmp/sx-out/candidate.shortcut -o /tmp/sx-out/candidate-signed.shortcut 2>&1 && echo "[sx3] SIGNED OK (Apple-ID-less)" || echo "[sx3] sign failed (exit $?)"
ls -la /tmp/sx-out/candidate*.shortcut 2>/dev/null
' | tee -a "$REPORT" || true

note "== [SX4] ship artifacts to host =="
lab_scp -r "$LAB_SSH_USER@$IP:/tmp/sx-out" "$OUT/" 2>/dev/null || lab_ssh "$IP" 'cd /tmp && tar cf - sx-out' | (cd "$OUT" && tar xf -)
ls -la "$OUT/sx-out/" | tee -a "$REPORT" || true

note "DONE. Next (host): try plutil -p + shortcuts sign on $OUT/sx-out/*.blob"
