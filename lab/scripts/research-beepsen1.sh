#!/bin/bash
# BEEPSEN1 — certify the BEEP SENTINEL itself (lab/guest/beep-sentinel.sh).
#
# BEEP1 proved the oracle; this campaign proves the HARNESS PIECE built on it:
# the post-hoc mark/assert sentinel that makes an alert beep a failure state for
# every lab suite. An oracle that cannot see a deliberate beep proves nothing
# about a clean run, so the liveness cell comes FIRST and the clean-window cell
# is only meaningful after it.
#
# Cells:
#   V1  liveness — three deliberate `osascript -e beep` calls between mark and
#       assert: the assert must FAIL, count exactly 3, and print the log lines.
#   V2  clean window — mark, nothing, assert: 0 beeps, exit 0.
#   V3  a REAL shipped numeric-field drive — `todo reschedule-repeat` through
#       the production CLI against a live 3.23 Repeat dialog (post-#590): the
#       sentinel must pass with 0, and the per-step marks must attribute.
#   V4  opt-out — THINGS_LAB_BEEPS_OK=1 with a deliberate beep: exit 0, count
#       still printed (probes are exempt from failing, never from accounting).
#
# METHOD: one disposable clone of things-lab-golden-v4 (Things 3.23, DB v27; the
# golden is never booted). Airgap, clock pinned 2026-07-05 (inside the trial
# wall — this campaign never rolls the clock). Fixtures fully synthetic
# (BEEPSEN1-*). Teardown on EXIT (KEEP=1 keeps it, REUSE=1 attaches).
#
# Usage:  CELLS="V1 V2" VM=beepsen-lab KEEP=1 lab/scripts/research-beepsen1.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-beepsen-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-V1 V2 V3 V4}"
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[beepsen1] $*" | tee -a "$REPORT"; }
has_cell() { case " $CELLS " in *" $1 "*) return 0;; *) return 1;; esac; }

IP=""
if [ "$REUSE" = "1" ]; then
  IP="$(tart ip "$VM" 2>/dev/null || true)"
  if [ -n "$IP" ] && lab_ssh "$IP" true 2>/dev/null; then
    note "REUSE=1 — attached to running $VM at $IP"
  else IP=""; fi
fi

if [ -z "$IP" ]; then
  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
fi

# Idempotent: airgap + pin the clock BEFORE Things is ever launched in the clone.
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
[ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
# Pin ONCE. Re-pinning on an attach would rewind the guest clock into a window
# this campaign already measured, and the sentinel windows by guest timestamp —
# a rewind makes an earlier cell's beeps reappear inside a later cell's window.
if [ "$(lab_ssh "$IP" 'date +%Y-%m' </dev/null)" != "2026-07" ]; then
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
fi
lab_mute_guest "$IP"
note "airgap OK; muted; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM running at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run' </dev/null
lab_scp lab/guest/beep-sentinel.sh "admin@$IP:labh/beep-sentinel.sh" >/dev/null
lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# The sentinel, driven exactly as a suite drives it. Every verb is one ssh
# invocation: nothing is ever left running in the guest between calls.
SENT='BEEP_MARKS=~/things-lab/run/beep-marks.tsv bash ~/labh/beep-sentinel.sh'
sent() { lab_ssh "$IP" "$SENT $*; echo SENTINEL-EXIT=\$?" </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"; }
sent_optout() { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 $SENT $*; echo SENTINEL-EXIT=\$?" </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }

cell() { note ""; note "=== $1 ==="; }

# ============================================================ V1 liveness
if has_cell V1; then
  cell "V1 liveness — 3 deliberate beeps between mark and assert MUST fail the assert"
  sent reset
  sent mark "'V1 prelude'"
  lab_ssh "$IP" 'sleep 2' </dev/null
  sent mark "'V1 three deliberate beeps'"
  lab_ssh "$IP" "for i in 1 2 3; do osascript -e beep; sleep 1.5; done" </dev/null
  sent assert --name V1
fi

# ============================================================ V2 clean window
if has_cell V2; then
  cell "V2 clean window — mark, nothing, assert"
  sent reset
  sent mark "'V2 quiet control'"
  lab_ssh "$IP" 'sleep 6' </dev/null
  sent mark "'V2 still quiet'"
  sent assert --name V2
fi

# ============================================================ V3 real drive
if has_cell V3; then
  cell "V3 a REAL shipped numeric-field drive (post-#590) under the sentinel"
  if [ "${SKIP_BUILD:-0}" != "1" ]; then
    note "  building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "  shipped dist; ui-enabled=true"

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
  warm
  # The AppleScript vector is blocked in a clone (Wave A write gate), so the
  # repeating fixture is built REPX2/REPX3-style: URL-scheme add + a raw AX
  # Repeat-dialog drive.
  lab_ssh "$IP" "open -g 'things:///add?title=BEEPSEN1-SERIES&auth-token=$TOKEN'; sleep 4" </dev/null
  U=$(gq "SELECT uuid FROM TMTask WHERE title='BEEPSEN1-SERIES' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1")
  note "  seed uuid=$U"
  lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 3" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    set p to pop up button 1 of sh
    repeat 20 times
      if (exists menu 1 of p) then exit repeat
      click p
      delay 0.3
    end repeat
    set nms to name of every menu item of menu 1 of p
    set hit to ""
    repeat with n in nms
      if hit is "" and ((n as text) contains "eek") then set hit to (n as text)
    end repeat
    if hit is "" then
      key code 53
      return "FREQ-NOT-FOUND; offered: " & (nms as text)
    end if
    click menu item hit of menu 1 of p
    delay 1.5
    click button "OK" of sh
    delay 2
    return "frequency = " & hit
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
  TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='BEEPSEN1-SERIES' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  if [ -z "$TMPL" ]; then
    note "  FATAL: no template minted — V3 cannot run"
  else
    note "  template uuid=$TMPL"
    sent reset
    sent mark "'V3 fixture settled'"
    # Two drives, each marked: the numeric fields (interval / ends-after) are
    # exactly the ones that beeped before #590, and a frequency switch (the
    # second beep source) happens on both.
    sent mark "'V3 reschedule-repeat weekly --interval 2'"
    lab_ssh "$IP" "$LAB_UI_DIRECT $CLI todo reschedule-repeat $TMPL --frequency weekly --interval 2 --weekdays tuesday --dangerously-drive-gui --json; echo CLI-EXIT=\$?" </dev/null 2>&1 | tail -4 | sed 's/^/    /' | tee -a "$REPORT"
    sent mark "'V3 reschedule-repeat daily --interval 5 --ends-after 9'"
    lab_ssh "$IP" "$LAB_UI_DIRECT $CLI todo reschedule-repeat $TMPL --frequency daily --interval 5 --ends-after 9 --dangerously-drive-gui --json; echo CLI-EXIT=\$?" </dev/null 2>&1 | tail -4 | sed 's/^/    /' | tee -a "$REPORT"
    sent mark "'V3 drives complete'"
    sent assert --name V3
    note "  rule after the drives: $(gq "SELECT rt1_recurrenceRule IS NOT NULL FROM TMTask WHERE uuid='$TMPL'")"
  fi
fi

# ============================================================ V4 opt-out
if has_cell V4; then
  cell "V4 opt-out — THINGS_LAB_BEEPS_OK=1: counted, printed, NOT failing"
  sent reset
  sent mark "'V4 deliberate beeps under opt-out'"
  lab_ssh "$IP" "for i in 1 2; do osascript -e beep; sleep 1.5; done" </dev/null
  sent_optout assert --name V4
fi

note ""
note "report: $REPORT"
