#!/bin/bash
# VMQ1 item 5 — SESSGATE stuck-modal -> AS-mutation-block -> close/reopen recovery
# chain (entry (b); oddities §9cc). The prior research-sessgate-modal.sh was
# INCONCLUSIVE because a raw two-command reveal did not leave the freshly-made row
# SELECTED, so Items ▸ Repeat… never opened a sheet. This re-run uses the ship-CLI's
# reveal shape + a SELECTION POLL (retry reveal+settle until `id of selected to dos`
# equals the seed) to reliably open the sheet BEFORE locking, then exercises the
# AS-mutation block + the close+reopen recovery. golden-v3 / Things 3.22.14.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VM="vmq1-sessgate"
GOLDEN="things-lab-golden-v3"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[sg] $*" | tee -a "$REPORT"; }
cleanup() { echo "[sg] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

tart delete "$VM" >/dev/null 2>&1 || true
note "clone $GOLDEN -> $VM"
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"

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
sheet_probe() { osa 'tell application "System Events" to tell process "Things3"
  set s to "no-sheet"
  try
    if (exists sheet 1 of (first window whose subrole is "AXStandardWindow")) then set s to "sheet-visible"
  end try
  return s
end tell'; }

note "warm-up Things"
lab_ssh "$IP" 'open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null

note "seed a synthetic to-do (unlocked)"
osa 'tell application "Things3" to make new to do with properties {name:"SESSGATE modal seed"}' >/dev/null 2>&1
sleep 2
U=$(gq "SELECT uuid FROM TMTask WHERE title='SESSGATE modal seed' AND type=0 AND trashed=0 LIMIT 1")
note "  seed uuid=$U"

note "UNLOCKED: reveal + SELECTION POLL (the fix for the prior inconclusive run)…"
SEL=""
for attempt in 1 2 3 4 5 6 7 8; do
  # SHELL `open` (the URL-scheme dispatcher) — NOT `osascript -e 'open "url"'`,
  # whose AppleScript `open` does not handle a URL scheme (the prior run's real
  # bug: the reveal never navigated, so the row was never list-selected).
  lab_ssh "$IP" "open 'things:///show?id=$U'" </dev/null >/dev/null 2>&1
  osa 'tell application "Things3" to activate' >/dev/null 2>&1
  sleep 2
  SEL=$(osa "tell application \"Things3\" to try
    return (id of selected to dos) as text
  end try" | tail -1)
  note "  attempt $attempt selected: '$SEL' (want $U)"
  [ "$SEL" = "$U" ] && break
  sleep 1
done

note "open Items ▸ Repeat… (make-repeating dialog) on the selected row…"
osa 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null 2>&1
sleep 2
SHEET_BEFORE=$(sheet_probe)
note "  sheet visible while UNLOCKED (want sheet-visible): $SHEET_BEFORE"

# The §9cc modal-block is LOCK-INDEPENDENT (an open modal blocks AS object-model
# mutations app-wide regardless of lock). LOCK=1 adds the locked-session confound
# (which in-lab keeps the sheet AX-reachable, `1 1`, and — as the first run showed —
# leaves the close+reopen recovery unable to complete under lock). Default LOCK=0
# isolates the block + recovery cleanly, where `reopen` can actually re-surface a window.
if [ "${LOCK:-0}" = "1" ]; then
  note "LOCK the session (sheet stays open — the live-host stuck-modal state)…"
  lab_ssh "$IP" 'sudo sysadminctl -screenLock immediate -password admin >/dev/null 2>&1' </dev/null
  lab_ssh "$IP" "sudo launchctl asuser $UID_ADMIN sudo -u admin python3 -c 'import ctypes; lf=ctypes.CDLL(\"/System/Library/PrivateFrameworks/login.framework/Versions/Current/login\"); lf.SACLockScreenImmediate()' 2>&1 || true" </dev/null >/dev/null 2>&1
  sleep 3
  REACH=$(osa 'set a to -1
try
  tell application "Things3" to set a to count windows
end try
set b to -1
tell application "System Events" to try
  set b to count (windows of process "Things3")
end try
return (a as text) & " " & (b as text)' | tail -1)
  note "  reach UNDER LOCK (want 1 0): $REACH"
  note "  sheet AX-probe UNDER LOCK: $(sheet_probe)"
else
  REACH="(unlocked)"
  note "UNLOCKED chain (LOCK=0): isolating the modal-block + close/reopen recovery"
fi

note "  AS delete the seed while the modal is stuck + AX-blind…"
osa "tell application \"Things3\" to delete (to do id \"$U\")" >/dev/null 2>&1
sleep 2
T_BLOCKED=$(gq "SELECT trashed FROM TMTask WHERE uuid='$U'")
note "    trashed while modal stuck (want 0 — BLOCKED by the open modal): $T_BLOCKED"

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
T_AFTER=$(gq "SELECT trashed FROM TMTask WHERE uuid='$U'")
note "    trashed AFTER close+reopen (want 1 — modal cleared, mutations unblocked): $T_AFTER"

note "==== SUMMARY: sheet_before=$SHEET_BEFORE reach=$REACH blocked_trashed=$T_BLOCKED recovered_trashed=$T_AFTER"
note "VMQ1 SESSGATE DONE."
