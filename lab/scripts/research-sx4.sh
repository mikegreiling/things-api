#!/bin/bash
# SX4 — signed-shortcut IMPORT + RUN validation, end-to-end (§A distribution).
# ONE clone. Doubles as the first System Events (AX) feasibility probe.
#
# Input: lab/shortcuts/things-proxy-create-heading.shortcut — reconstructed
# from the golden's Shortcuts.sqlite blobs and signed on the host with
# `shortcuts sign --mode anyone` (SX2/SX3). Questions:
#   SX4a  Can we seed kTCCServiceAccessibility for sshd via direct TCC.db
#         write (sshd has FDA)? → unlocks System Events UI scripting.
#   SX4b  Does `open <signed file>` present the import sheet (signature
#         ACCEPTED) or an error (rejected)? Screenshot either way.
#   SX4c  Can System Events click "Add Shortcut"? (`shortcuts list` gains the
#         file-basename shortcut — we ship it renamed sx-import-test to dodge
#         the golden-resident name.)
#   SX4d  Run it: consent prompt (new shortcut = fresh output-class consent)
#         → AX-click Always Allow → type=2 row lands in Things DB = the
#         signed-file pipeline is FULLY validated for distribution.
# Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-sx4-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[sx4] $*" | tee -a "$REPORT"; }
cleanup() { echo "[sx4] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

shot() { lab_ssh "$IP" "screencapture -x /tmp/sx4-$1.png 2>/dev/null || true" </dev/null; }
gas() { note "-- osascript: ${1:0:90}"; lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null | tee -a "$REPORT" || true; }

note "== [SX4a] seed Accessibility for sshd (direct TCC.db write via FDA) =="
lab_ssh "$IP" 'bash -s' </dev/null <<'GUEST' 2>&1 | tee -a "$REPORT"
sdb="/Library/Application Support/com.apple.TCC/TCC.db"
for client in "/usr/libexec/sshd-keygen-wrapper" "/usr/bin/osascript"; do
  sudo sqlite3 "$sdb" "INSERT OR REPLACE INTO access
    (service, client, client_type, auth_value, auth_reason, auth_version, flags)
    VALUES ('kTCCServiceAccessibility', '$client', 1, 2, 4, 1, 0)" 2>&1
done
sudo sqlite3 "$sdb" "SELECT service, client, auth_value FROM access WHERE service='kTCCServiceAccessibility'"
GUEST

note "-- AX sanity: can System Events see processes?"
gas 'tell application "System Events" to get name of first process'

note "== [SX4b] ship signed file + open it =="
lab_scp "lab/shortcuts/things-proxy-create-heading.shortcut" "$LAB_SSH_USER@$IP:/tmp/sx-import-test.shortcut" </dev/null
lab_ssh "$IP" 'open /tmp/sx-import-test.shortcut' </dev/null
sleep 8
shot "import-sheet"
note "-- Shortcuts frontmost windows:"
gas 'tell application "System Events" to tell process "Shortcuts" to get name of every window'
note "-- import sheet buttons (walk the AX tree):"
gas 'tell application "System Events" to tell process "Shortcuts" to get name of every button of window 1'
gas 'tell application "System Events" to tell process "Shortcuts" to get name of every button of every sheet of window 1'

note "== [SX4c] click Add Shortcut =="
gas 'tell application "System Events" to tell process "Shortcuts"
  set frontmost to true
  repeat with b in (every button of window 1)
    if name of b contains "Add" then click b
  end repeat
end tell'
sleep 4
shot "after-add"
note "-- shortcuts list now contains:"
lab_ssh "$IP" 'shortcuts list | grep -i "sx-import\|things-proxy" ' </dev/null | tee -a "$REPORT" || true

note "== [SX4d] run the imported shortcut against Things =="
lab_ssh "$IP" 'open -g -a Things3; sleep 10' </dev/null
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' </dev/null <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 -noheader -list "file:$DB?mode=ro" "$1"
EOF
PROJ=$(lab_ssh "$IP" "/tmp/gsql.sh \"SELECT uuid FROM TMTask WHERE type=1 AND trashed=0 LIMIT 1\"" </dev/null)
note "target project: $PROJ"
lab_ssh "$IP" "printf '%s' '{\"title\":\"SX4-IMPORTED-HEADING\",\"project\":\"$PROJ\"}' > /tmp/sx4-in.json" </dev/null
# First run of a NEW shortcut fires a fresh output-class consent prompt; run
# in bg, wait, screenshot, then AX-click Always Allow if present.
lab_ssh "$IP" 'rm -f /tmp/sx4-out.txt; (perl -e "alarm 90; exec @ARGV" shortcuts run sx-import-test --input-path /tmp/sx4-in.json --output-path /tmp/sx4-out.txt > /tmp/sx4-run.log 2>&1; echo "[run exit $?]" >> /tmp/sx4-run.log) & echo bg-started' </dev/null | tee -a "$REPORT"
sleep 10
shot "consent-prompt"
note "-- consent dialog AX walk (UserNotificationCenter or Shortcuts):"
gas 'tell application "System Events" to get name of every process whose visible is true'
for proc in UserNotificationCenter CoreServicesUIAgent Shortcuts; do
  gas "tell application \"System Events\" to tell process \"$proc\" to get name of every button of every window"
done
note "-- try clicking Always Allow / Allow:"
for proc in UserNotificationCenter CoreServicesUIAgent Shortcuts; do
  gas "tell application \"System Events\" to tell process \"$proc\"
  repeat with w in (every window)
    repeat with b in (every button of w)
      if name of b contains \"Always\" or name of b is \"Allow\" or name of b is \"OK\" then click b
    end repeat
  end repeat
end tell"
done
sleep 20
shot "after-run"
note "-- run log + output:"
lab_ssh "$IP" 'cat /tmp/sx4-run.log 2>/dev/null; cat /tmp/sx4-out.txt 2>/dev/null; echo' </dev/null | tee -a "$REPORT"
note "-- DB truth (type=2 row = FULL PIPELINE VALIDATED):"
lab_ssh "$IP" "/tmp/gsql.sh \"SELECT uuid, title, type, project FROM TMTask WHERE title='SX4-IMPORTED-HEADING'\"" </dev/null | tee -a "$REPORT" || true

note "== ship screenshots =="
lab_ssh "$IP" 'cd /tmp && tar cf - sx4-*.png 2>/dev/null' </dev/null | (cd "$OUT" && tar xf -) || true
ls -la "$OUT"/*.png 2>/dev/null | tee -a "$REPORT" || true
note "DONE. Report: $REPORT"
