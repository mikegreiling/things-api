#!/bin/bash
# SESSGATE follow-up — the stuck-modal -> AS-mutation-block -> close/reopen recovery
# chain (oddities §9cc), reproduced faithfully by opening the Repeat sheet WHILE
# UNLOCKED (the plain Repeat… item is frontmost-dependent, §9dd, so it will not open
# under a locked screen), THEN locking, THEN exercising the AS-mutation block.
# Raw osascript only (no bundle). golden-v3 / Things 3.22.14. Disposable clone.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VM="sessgate-modal"
OUT="lab/artifacts/sessgate-lab"; mkdir -p "$OUT"
REPORT="$OUT/modal-report.txt"; : > "$REPORT"
note() { echo "[sg-modal] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"
GOLDEN="${GOLDEN:-things-lab-golden-v3}"

note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run-modal.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"
cleanup() { [ "$KEEP" = "1" ] && { note "KEEP=1 — leaving $VM"; return; }; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
UID_ADMIN=$(lab_ssh "$IP" 'id -u admin' </dev/null | tr -dc 0-9)
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 -noheader -list "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
osa() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null; }

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 12; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
sheet_probe() { osa 'tell application "System Events" to tell process "Things3"
  set s to "no-sheet"
  try
    if (exists sheet 1 of (first window whose subrole is "AXStandardWindow")) then set s to "sheet-visible"
  end try
  return s
end tell'; }

warm
note "seed a synthetic to-do (unlocked)"
osa 'tell application "Things3" to make new to do with properties {name:"SESSGATE modal seed"}' >/dev/null 2>&1
sleep 2
U=$(gq "SELECT uuid FROM TMTask WHERE title='SESSGATE modal seed' AND type=0 AND trashed=0 LIMIT 1")
note "  seed uuid=$U"

note "UNLOCKED: select + open the Repeat dialog (Items > Repeat…)…"
osa "open \"things:///show?id=$U\"" >/dev/null 2>&1; sleep 2
osa 'tell application "Things3" to activate' >/dev/null 2>&1; sleep 1
SEL=$(osa "tell application \"Things3\" to try
  return (id of selected to dos) as text
end try")
note "  selected (want $U): $SEL"
osa 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null 2>&1
sleep 2
note "  sheet visible while UNLOCKED (want sheet-visible): $(sheet_probe)"

note "LOCK the session (sheet stays open)…"
lab_ssh "$IP" 'sudo sysadminctl -screenLock immediate -password admin >/dev/null 2>&1' </dev/null
lab_ssh "$IP" "sudo launchctl asuser $UID_ADMIN sudo -u admin python3 -c 'import ctypes; lf=ctypes.CDLL(\"/System/Library/PrivateFrameworks/login.framework/Versions/Current/login\"); lf.SACLockScreenImmediate()' 2>&1 || true" </dev/null >/dev/null 2>&1
sleep 3
note "  reach UNDER LOCK (want 1 0 0): $(osa 'set a to -1
try
  tell application "Things3" to set a to count windows
end try
set b to -1
tell application "System Events" to try
  set b to count (windows of process "Things3")
end try
return (a as text) & " " & (b as text)' | tail -1)"
note "  sheet AX-probe UNDER LOCK (want no-sheet — the open sheet is AX-unreachable): $(sheet_probe)"

note "  AS delete the seed while the modal is stuck + AX-blind…"
osa "tell application \"Things3\" to delete (to do id \"$U\")" >/dev/null 2>&1
sleep 2
note "    trashed while modal stuck (want 0 — BLOCKED): $(gq "SELECT trashed FROM TMTask WHERE uuid='$U'")"

note "  RECOVERY: AppleScript close window 1 + reopen (app-level, no AX)…"
osa 'tell application "Things3"
  try
    close window 1
  end try
  reopen
end tell' >/dev/null 2>&1
sleep 2
osa "tell application \"Things3\" to delete (to do id \"$U\")" >/dev/null 2>&1
sleep 2
note "    trashed AFTER close+reopen (want 1 — modal cleared, mutations unblocked): $(gq "SELECT trashed FROM TMTask WHERE uuid='$U'")"
note "DONE — env: $GOLDEN / Things 3.22.14 / clock 2026-07-05"
