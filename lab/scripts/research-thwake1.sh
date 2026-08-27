#!/bin/bash
# THWAKE1 — waking a dormant THINGS (issue #617, golden-v4 / Things 3.23).
#
# THE CLAIM UNDER TEST. `AEDeterminePermissionToAutomateTarget(askUserIfNeeded:
# false)` answers procNotFound (-600) for a target that is not running, which
# the deputy reports as `automation.things: "not-running"` — a fact about the
# PROCESS, not about the grant. Things is the user's own app, closed whenever
# they are not using it, so a fully onboarded machine sits in that state most of
# the day. The fix (src/deputy/wake.ts + src/capability.ts) starts the app with
# a plain background LaunchServices dispatch and re-reads the determination
# before any verdict is taken. SEWAKE1 proved the mechanism for System Events; a
# headless agent has no UI, and this cell answers the question that only the
# user's own app raises: does the wake stay OUT OF THE WAY?
#
#   THWAKE1-a  inventory: Things liveness at boot, the guest's AppleEvents TCC
#              rows, the baseline determination for a LIVE app, and the
#              frontmost/window baseline.
#   THWAKE1-b  quit Things; the determination must read -600 and STAY -600.
#   THWAKE1-c  positive control: -600 tracks LIVENESS, not the target — a second
#              app that is also down reads -600 from the same probe.
#   THWAKE1-d  THE WAKE: `open -g -b com.culturedcode.ThingsMac`, then poll the
#              determination at the SHIPPED interval and bound for this target
#              (50 ms / 10 s) until it stops saying -600.
#   THWAKE1-e  BACKGROUNDEDNESS: Finder is made frontmost first, and frontmost +
#              the Things window census are sampled across the launch window. A
#              foreground `open -a Things3` runs afterwards as the CONTRAST, so
#              the oracle is calibrated rather than assumed (APPRUN1 warns that
#              a single-app headless session can read a just-launched app as
#              frontmost with nothing else competing for focus).
#   THWAKE1-f  ZERO DIALOGS: no consent-dialog agent ever holds a window across
#              the sequence, and the beep sentinel reads 0.
#
# The probe is a ctypes replica of deputy/src/tcc.swift's call — same function,
# same wildcard event class/id, same askUserIfNeeded:false — because a clone has
# no helper bundle to ask. The TS loop and the verdict matrix around it are
# covered by unit tests (test/unit/deputy-wake.test.ts, capability.test.ts);
# what only a VM can answer is whether launch-then-determine really resolves the
# state prompt-free AND without taking the screen.
#
# Airgapped, clock pinned 2026-07-05 (the trial wall is 2026-07-18 and is NEVER
# rolled), one clone, destroyed on exit. Beep sentinel with THINGS_LAB_BEEPS_OK=1
# (accounting, never a mute).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-thwake1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
PIN="070512002026"   # 2026-07-05 12:00 — well inside the trial wall
TH_BUNDLE="com.culturedcode.ThingsMac"
# The shipped bound and interval for THIS target (src/deputy/wake.ts THINGS_TARGET).
WAKE_TIMEOUT_MS=10000
WAKE_INTERVAL_MS=50

note() { echo "[thwake1] $*" | tee -a "$REPORT"; }
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" "$@"; }
cleanup() {
  echo "[thwake1] teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

: > "$REPORT"
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }
tart list 2>/dev/null | sed 's/^/    /' | tee -a "$REPORT"
RUNNING=$(tart list 2>/dev/null | awk '$5=="running"{n++} END{print n+0}')
if [ "${RUNNING:-0}" -ge 2 ]; then note "FATAL: $RUNNING VMs already running (2-VM ceiling)"; exit 1; fi

note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
[ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run' </dev/null
scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null
bs()    { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh $*" </dev/null 2>&1; }
bmark() { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }

TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
note "env: macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / Things $TVER / golden $GOLDEN"

# --- the determination probe: deputy/src/tcc.swift, in ctypes -----------------
scpO lab/scripts/aedet.py "admin@$IP:/Users/admin/labh/aedet.py" >/dev/null

det()  { lab_ssh "$IP" "/usr/bin/python3 ~/labh/aedet.py $1" </dev/null 2>&1; }
poll() { lab_ssh "$IP" "/usr/bin/python3 ~/labh/aedet.py $1 poll $WAKE_TIMEOUT_MS $WAKE_INTERVAL_MS" </dev/null 2>&1; }
live() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo LIVE || echo DOWN' </dev/null 2>&1; }
oas()  { lab_ssh "$IP" "/usr/bin/osascript -e $(printf '%q' "$1") 2>&1" </dev/null 2>&1; }
front() { oas 'tell application "System Events" to get name of first process whose frontmost is true'; }
# Things' own window census. The disruption tiers give a launch a budget of 2
# (the main window plus a sometimes-present untitled companion) — anything more
# is a modal (docs/lab/harness.md).
thwin() { oas 'tell application "System Events" to if exists process "Things3" then return (count of windows of process "Things3") as text'; }
quit_app() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; for i in $(seq 1 40); do pgrep -x Things3 >/dev/null || break; sleep 0.5; done' </dev/null >/dev/null 2>&1; }
finder_front() { lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Finder" to activate'\'' >/dev/null 2>&1; sleep 1' </dev/null >/dev/null 2>&1; }
# A REAL foreground app to hold focus. APPRUN1 warned that a session containing
# only Finder and Things reads the just-launched app as frontmost with nothing
# competing for focus — so Finder alone is not an oracle, it is an absence of
# one. Calculator is a plain window app with no panels or documents.
HOLDER="Calculator"
holder_front() {
  lab_ssh "$IP" "open -a $HOLDER >/dev/null 2>&1; sleep 3; /usr/bin/osascript -e 'tell application \"$HOLDER\" to activate' >/dev/null 2>&1; sleep 2" </dev/null >/dev/null 2>&1
}

# THE DIALOG ORACLE (SEWAKE1's rig note: count WINDOWS, not processes —
# CoreServicesUIAgent is resident in every session, so its presence proves
# nothing; a prompt is a window).
dialogs() {
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events"
    set out to ""
    repeat with n in {"CoreServicesUIAgent", "UserNotificationCenter"}
      set pn to n as text
      if exists process pn then
        set out to out & pn & "=" & (count of windows of process pn) & " windows; "
      else
        set out to out & pn & "=not running; "
      end if
    end repeat
    return out
  end tell'\'' 2>&1' </dev/null 2>&1
}
ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# Sample frontmost + Things' window count across a launch window, in ONE guest
# round trip so the samples are not spaced by ssh latency.
sample() {
  lab_ssh "$IP" '/usr/bin/python3 - <<"PY"
import subprocess, time
def osa(s):
    try:
        return subprocess.run(["/usr/bin/osascript","-e",s],capture_output=True,text=True,timeout=10).stdout.strip()
    except Exception:
        return "?"
FRONT = "tell application \"System Events\" to get name of first process whose frontmost is true"
WIN = "tell application \"System Events\" to if exists process \"Things3\" then return (count of windows of process \"Things3\") as text"
out=[]
for i in range(8):
    out.append("%s/%s" % (osa(FRONT) or "?", osa(WIN) or "-"))
    time.sleep(0.75)
print(" ".join(out))
PY' </dev/null 2>&1
}

bs reset >/dev/null
bmark "thwake1 start"

note "############### THWAKE1-a: inventory ###############"
note "-- Things at boot: $(live)"
note "-- guest AppleEvents TCC rows (user db) --"
lab_ssh "$IP" 'sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" "SELECT client,indirect_object_identifier,auth_value FROM access WHERE service='\''kTCCServiceAppleEvents'\''" 2>&1' </dev/null | sed 's/^/    /' | tee -a "$REPORT"
note "-- warm the app once so a LIVE baseline exists --"
lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
note "-- liveness: $(live)   windows: $(thwin)   frontmost: $(front)"
BASE=$(det "$TH_BUNDLE"); note "-- determination (LIVE app): $BASE"
DLG_BEFORE=$(dialogs); note "-- dialog windows at baseline: $DLG_BEFORE"

note "############### THWAKE1-b: the dormant state ###############"
bmark "quit things"
quit_app
note "-- liveness after quit: $(live)"
DOWN=$(det "$TH_BUNDLE"); note "-- determination (DOWN app): $DOWN"
case "$DOWN" in
  -600\ not-running*) note "   OK — the determination reports LIVENESS, exactly as the deputy relays it";;
  *) note "   UNEXPECTED — the dormant determination is not -600; the premise does not hold here";;
esac
lab_ssh "$IP" 'sleep 5' </dev/null
note "-- after 5s idle: liveness $(live)  determination $(det "$TH_BUNDLE")"

note "############### THWAKE1-c: positive control — -600 tracks LIVENESS ###############"
lab_ssh "$IP" 'pgrep -x "Chess" >/dev/null && killall Chess; sleep 1' </dev/null >/dev/null 2>&1
note "-- determination for com.apple.Chess (not running): $(det com.apple.Chess)"

note "############### THWAKE1-d/e: THE WAKE (launch -g, THEN determine) ###############"
finder_front
FRONT_BEFORE=$(front); WIN_BEFORE=$(thwin)
note "-- frontmost before the wake: $FRONT_BEFORE   Things windows: ${WIN_BEFORE:-none}"
bmark "wake (background)"
LAUNCH_START=$(ms)
LAUNCH=$(lab_ssh "$IP" "open -g -b $TH_BUNDLE; echo \"[exit \$?]\"" </dev/null 2>&1)
note "-- launch: $LAUNCH"
RESOLVED=$(poll "$TH_BUNDLE")
LAUNCH_END=$(ms)
note "-- liveness after launch: $(live)"
note "-- determination after the wake: $RESOLVED"
note "-- whole sequence (host wall clock, ssh included): $((LAUNCH_END - LAUNCH_START))ms"
SAMPLES=$(sample)
note "-- frontmost/windows samples across the launch window: $SAMPLES"
FRONT_AFTER=$(front); WIN_AFTER=$(thwin)
note "-- frontmost after the wake: $FRONT_AFTER   Things windows: ${WIN_AFTER:-none}"

note "############### THWAKE1-e2: the wake with a REAL app holding focus ###############"
# The Finder-held pass above is the record of why this one exists: with only
# Finder and Things in the session, a just-launched app reads as frontmost
# whatever the launch flags said (APPRUN1). A third app that genuinely owns the
# foreground turns "frontmost" back into an oracle.
quit_app
holder_front
HOLD_BEFORE=$(front)
note "-- frontmost with the holder up: $HOLD_BEFORE (must be $HOLDER for the oracle to mean anything)"
bmark "wake (background, holder frontmost)"
lab_ssh "$IP" "open -g -b $TH_BUNDLE" </dev/null >/dev/null 2>&1
HELD=$(sample)
HOLD_AFTER=$(front)
note "-- BACKGROUND wake, frontmost/windows samples: $HELD"
note "-- frontmost after the background wake: $HOLD_AFTER"

note "############### THWAKE1-e3 (contrast): a FOREGROUND launch, same rig ###############"
# Calibrates the oracle: `open -a` MUST flip the foreground. If it does not,
# this session cannot tell the two launches apart and the backgroundedness
# claim is not certifiable here.
quit_app
holder_front
note "-- frontmost before the control launch: $(front)"
lab_ssh "$IP" 'open -a Things3' </dev/null >/dev/null 2>&1
CONTROL=$(sample)
CONTROL_AFTER=$(front)
note "-- CONTROL (open -a) frontmost/windows samples: $CONTROL"
note "-- frontmost after the control launch: $CONTROL_AFTER"

note "############### THWAKE1-f: zero dialogs ###############"
DLG_AFTER=$(dialogs); note "-- dialog windows after the sequence: $DLG_AFTER"
DLG=$(printf '%s' "$DLG_AFTER" | grep -Eo '=[0-9]+ windows' | grep -Ecv '^=0 windows$')
note "-- beep sentinel --"
bs assert --json /tmp/thwake1-beeps.json --name thwake1 | sed 's/^/    /' | tee -a "$REPORT"
BEEPS=$(lab_ssh "$IP" 'python3 -c "import json;print(json.load(open(\"/tmp/thwake1-beeps.json\"))[\"beeps\"])" 2>/dev/null || echo "?"' </dev/null)

note "################ VERDICT ################"
note "baseline (live)        : $BASE"
note "dormant                : $DOWN"
note "after the wake         : $RESOLVED"
note "frontmost before/after : $FRONT_BEFORE -> $FRONT_AFTER (Finder-held: no oracle, see APPRUN1)"
note "wake samples (Finder)  : $SAMPLES"
note "holder-held wake       : $HOLD_BEFORE -> $HOLD_AFTER"
note "holder-held samples    : $HELD"
note "control (open -a)      : $CONTROL_AFTER  [$CONTROL]"
note "Things windows after   : ${WIN_AFTER:-none} (launch budget 2)"
if [ "$HOLD_AFTER" = "$HOLDER" ] && [ "$CONTROL_AFTER" = "Things3" ]; then
  note "BACKGROUNDED — the wake left the foreground alone, and the control proves the oracle can see a flip"
elif [ "$CONTROL_AFTER" != "Things3" ]; then
  note "INCONCLUSIVE (backgroundedness) — the control did not flip the foreground either; no oracle in this session"
else
  note "RED (backgroundedness) — the background wake took the foreground"
fi
note "dialog windows before  : $DLG_BEFORE"
note "dialog windows after   : $DLG_AFTER"
note "agents holding a window: $DLG (must be 0)"
note "beeps                  : $BEEPS (must be 0)"
case "$RESOLVED" in
  -600\ *) note "RED — the wake did not take";;
  *) [ "$DLG" = "0" ] && note "GREEN (determination) — a dormant app is resolved to a real determination, prompt-free" \
       || note "RED — a consent-dialog agent held a window";;
esac
note "report: $REPORT"
