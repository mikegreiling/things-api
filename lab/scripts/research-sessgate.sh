#!/bin/bash
# SESSGATE (issue #480) — session-reachability root-cause reproduction + fix
# re-cert on things-lab-golden-v3 / Things 3.22.14.
#
# The TRUE root cause (found live on the maintainer's host 2026-08-16): a locked
# screen / full-screen Space makes System Events enumerate ZERO windows for every
# process, so a dialog-class op's Repeat/confirm sheet opens on an AX-UNREACHABLE
# window; the dialog-wait times out, the modal stays open and BLOCKS AppleScript
# mutations app-wide (the #480 auto-trash silent-noop), and the AX-blind Escape
# cleanup cannot even confirm the sheet is gone.
#
# CELLS (all SSH-scriptable — AX menu presses work under lock, AXVM1; the
# AS-mutation-block is the ground-truth signal, observable without unlocking; the
# "no-window" state reproduces the window-scope discriminator without multi-Space):
#   A. baseline reachable (window up)        — reach = AS>=1 AX>=1 ALL>=1
#   B. LOCKED session signature + raw cascade — reach = AS>=1 AX=0 ALL=0;
#      menu-press Repeat -> sheet AX-blind; AS delete BLOCKED; close+reopen RECOVERS
#   C. WINDOW-scope signature + relocation maneuver — reach = AS>=? AX=0 ALL>0;
#      close+reopen+activate restores AX>=1
#   D. FIXED-build re-cert: locked make-repeating -> blocked(4) zero mutation;
#      unlocked make-repeating -> works (no regression)
#
# METHOD: ONE disposable clone `sessgate` of things-lab-golden-v3. Ship the FIXED
# e2e bundle (built from THIS worktree). Airgap; pin clock 2026-07-05. Synthetic
# fixtures only. Teardown at the end (KEEP=1 to retain on failure).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="sessgate"
OUT="lab/artifacts/sessgate-lab"; mkdir -p "$OUT/drive"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[sessgate] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free."; exit 1; }

MAIN_WT=$(dirname "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null || true)
NODE_VER=$(awk '/nodejs/{print $2}' "$MAIN_WT/.tool-versions" .tool-versions "$HOME/.tool-versions" 2>/dev/null | head -1 || true)
CANDS=("$HOME/.asdf/installs/nodejs/$NODE_VER/bin")
CANDS+=( $(ls -d "$HOME"/.asdf/installs/nodejs/*/bin 2>/dev/null | sort -t/ -k7 -V -r) )
CANDS+=(/opt/homebrew/bin)
for cand in "${CANDS[@]}"; do
  [ -x "$cand/node" ] || continue
  otool -L "$cand/node" 2>/dev/null | grep -q '/opt/homebrew/' && continue
  export PATH="$cand:$PATH"; break
done
node --version >/dev/null 2>&1 || { note "FATAL: no node"; exit 1; }
note "toolchain: node $(node --version)"
[ -d node_modules/commander ] || { note "npm ci…"; npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL npm ci"; exit 1; }; }

GOLDEN="${GOLDEN:-things-lab-golden-v3}"
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"
cleanup() { [ "$KEEP" = "1" ] && { note "KEEP=1 — leaving $VM at $IP"; return; }; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo FAIL || echo OK' </dev/null)
note "airgap: $AG"; [ "$AG" = "OK" ] || { note "FATAL airgap"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
UID_ADMIN=$(lab_ssh "$IP" 'id -u admin' </dev/null | tr -dc 0-9)

lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
osa() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null; }

note "build + ship FIXED bundle (this worktree)"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL build"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
drive() {
  local label="$1"; shift
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive/$label.log" 2>&1
  { grep -m1 'EXIT=' "$OUT/drive/$label.log" || echo '(no exit)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
}
G config set ui-enabled true >/dev/null 2>&1
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
note "bundle shipped; Things $TVER; ui-enabled=true; clock 2026-07-05"

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 12; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
plain_uuid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
tpl_uuid()   { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NOT NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
trashed_of() { gq "SELECT trashed FROM TMTask WHERE uuid='$1'"; }

# The exact reachability probe the shipped gate uses (AS AX ALL).
REACH_SCRIPT='set thingsAs to -1
try
  tell application "Things3" to set thingsAs to count windows
end try
set thingsAx to -1
set allAx to -1
tell application "System Events"
  try
    set thingsAx to count (windows of process "Things3")
  end try
  try
    set allAx to 0
    repeat with proc in (application processes whose background only is false)
      try
        set allAx to allAx + (count (windows of proc))
      end try
    end repeat
  end try
end tell
return ((thingsAs as integer) as text) & " " & ((thingsAx as integer) as text) & " " & ((allAx as integer) as text)'
reach() { osa "$REACH_SCRIPT" | tail -1; }

# ---- seed all synthetic targets while UNLOCKED (created up front) ----
warm
drive S_unlock todo add \"SESSGATE unlocked\" --when 2026-08-26 --json
drive S_window todo add \"SESSGATE window\" --when 2026-08-26 --json
drive S_raw    todo add \"SESSGATE raw cascade\" --when 2026-08-26 --json
drive S_lock   todo add \"SESSGATE locked\" --when 2026-08-26 --json
U_UNLOCK=$(plain_uuid "SESSGATE unlocked"); U_WINDOW=$(plain_uuid "SESSGATE window")
U_RAW=$(plain_uuid "SESSGATE raw cascade"); U_LOCK=$(plain_uuid "SESSGATE locked")
note "seeds: unlock=$U_UNLOCK window=$U_WINDOW raw=$U_RAW lock=$U_LOCK"

RULE="--frequency weekly --interval 1 --dangerously-drive-gui --json"

# ========================= A. baseline reachable =========================
note ""; note "########## A. baseline reachable (window up) ##########"
warm
note "  reach (want AS>=1 AX>=1 ALL>=1): $(reach)"

# ===================== D-unlocked. no-regression drive ====================
note ""; note "########## D1. FIXED make-repeating UNLOCKED (no regression) ##########"
warm
drive D_unlocked todo make-repeating $U_UNLOCK $RULE
sleep 2
note "  template created (want a uuid — no regression): '$(tpl_uuid "SESSGATE unlocked")'"
note "  original trashed (want 1 if promote landed): trashed=$(trashed_of "$U_UNLOCK")"
grep -o 'blocked[^"]*\|drove [0-9]* step[^"]*\|EXIT=[0-9]*' "$OUT/drive/D_unlocked.log" | head -2 | sed 's/^/    /' | tee -a "$REPORT"

# ==================== C. WINDOW-scope signature + maneuver ================
note ""; note "########## C. WINDOW-scope signature (Things AX-0, others visible) + relocation maneuver ##########"
warm
# establish an 'others visible' baseline, then close Things' own windows
osa 'tell application "Finder" to reopen' >/dev/null 2>&1
osa 'tell application "Finder" to activate' >/dev/null 2>&1
sleep 1
osa 'tell application "Things3" to close every window' >/dev/null 2>&1
sleep 1
note "  reach with Things windows closed (want AX=0, ALL>=1 -> WINDOW scope): $(reach)"
# the relocation maneuver the gate runs for a WINDOW-scope verdict:
osa 'tell application "Things3"
  try
    close window 1
  end try
  reopen
  activate
end tell' >/dev/null 2>&1
sleep 2
note "  reach AFTER close+reopen+activate (want AX>=1 -> relocation restores reachability): $(reach)"

# ========================= B. LOCKED cascade =============================
note ""; note "########## B. LOCKED session signature + raw #480 cascade ##########"
warm
note "  locking the session (sysadminctl + SACLockScreenImmediate)…"
lab_ssh "$IP" 'sudo sysadminctl -screenLock immediate -password admin 2>&1' </dev/null | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" "sudo launchctl asuser $UID_ADMIN sudo -u admin python3 -c 'import ctypes; lf=ctypes.CDLL(\"/System/Library/PrivateFrameworks/login.framework/Versions/Current/login\"); print(\"SACrc=\",lf.SACLockScreenImmediate())' 2>&1 || echo SAC-failed" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
sleep 3
note "  reach UNDER LOCK (want AS>=1 AX=0 ALL=0 -> SESSION scope): $(reach)"

note "  raw cascade: select the seed, press Items > Repeat… (AX works under lock)…"
osa "open \"things:///show?id=$U_RAW\"" >/dev/null 2>&1; sleep 2
SEL=$(osa "tell application \"Things3\" to try
  return (id of selected to dos) as text
end try")
note "    selected under lock (want $U_RAW): $SEL"
osa 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null 2>&1
sleep 2
SHEET=$(osa 'tell application "System Events" to tell process "Things3"
  set s to "blind"
  try
    if (exists sheet 1 of (first window whose subrole is "AXStandardWindow")) then set s to "sheet-visible" else set s to "no-sheet"
  end try
  return s
end tell')
note "    dialog-wait AX probe under lock (want 'blind'/'no-sheet' — sheet is AX-unreachable): $SHEET"
# AS-mutation-block: attempt an AppleScript delete of the seed while the modal is stuck
osa "tell application \"Things3\" to delete (to do id \"$U_RAW\")" >/dev/null 2>&1
sleep 2
note "    AS delete of the seed while the modal is stuck (want trashed=0 — BLOCKED): trashed=$(trashed_of "$U_RAW")"

note "  recovery: AppleScript close window 1 + reopen (app-level, no AX)…"
osa 'tell application "Things3"
  try
    close window 1
  end try
  reopen
end tell' >/dev/null 2>&1
sleep 2
osa "tell application \"Things3\" to delete (to do id \"$U_RAW\")" >/dev/null 2>&1
sleep 2
note "    AS delete AFTER close+reopen (want trashed=1 — modal cleared, mutations unblocked): trashed=$(trashed_of "$U_RAW")"

# ================= D-locked. FIXED build refusal under lock ===============
note ""; note "########## D2. FIXED make-repeating UNDER LOCK -> blocked, zero mutation ##########"
drive D_locked todo make-repeating $U_LOCK $RULE
sleep 2
note "  D2 exit + verdict:"
grep -o '\"code\":\"[^\"]*\"\|blocked[^\"]*\|EXIT=[0-9]*' "$OUT/drive/D_locked.log" | head -3 | sed 's/^/    /' | tee -a "$REPORT"
note "  original seed still live? trashed=$(trashed_of "$U_LOCK") (want 0 — untouched)"
note "  any template minted? '$(tpl_uuid "SESSGATE locked")' (want empty — zero mutation)"
note "  any stray clone rows? count=$(gq "SELECT COUNT(*) FROM TMTask WHERE title='SESSGATE locked' AND type=0")"

note ""; note "########## SESSGATE COMPLETE ##########"
note "env: Things $TVER / $GOLDEN / clock 2026-07-05"
note "artifacts under $OUT"
[ "$KEEP" = "1" ] && note "VM kept at $IP for inspection"
