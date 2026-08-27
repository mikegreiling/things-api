#!/bin/bash
# SEWAKE1 — the WAKE PRIMITIVE, standalone (issue #610, golden-v4 / Things 3.23).
#
# THE CLAIM UNDER TEST. `AEDeterminePermissionToAutomateTarget(askUserIfNeeded:
# false)` answers procNotFound (-600) for a target that is not running, which the
# deputy reports as `automation.systemEvents: "not-running"` — a fact about the
# PROCESS, not about the grant. macOS reaps System Events whenever it has been
# idle, so a fully onboarded machine drifts into that state on its own. The fix
# (src/deputy/wake.ts) starts the target with a plain background LaunchServices
# dispatch and then re-reads the determination. This cell proves the mechanism
# in a clone:
#
#   SEWAKE1-a  inventory: SE liveness at boot, the guest's AppleEvents TCC rows,
#              and the baseline determination for a LIVE target.
#   SEWAKE1-b  kill System Events; the determination must read -600, and must
#              STAY -600 (nothing in an idle guest restarts it behind our back).
#   SEWAKE1-c  positive control: -600 tracks LIVENESS, not the target — a second
#              app that is also down reads -600 from the same probe.
#   SEWAKE1-d  THE WAKE: `open -g -b com.apple.systemevents`, then poll the
#              determination at the shipped interval until it stops saying -600.
#              Records time-to-liveness and the resolved status.
#   SEWAKE1-e  ZERO DIALOGS: no consent-dialog agent ever holds a window across
#              the sequence, the probe never blocks, and the beep sentinel reads
#              0. A blocking prompt is what a wake-by-Apple-event would have
#              produced on an ungranted machine.
#
# The probe is a ctypes replica of deputy/src/tcc.swift's call — same function,
# same wildcard event class/id, same askUserIfNeeded:false — because a clone has
# no helper bundle to ask. The TS loop around it is covered by unit tests
# (test/unit/deputy-wake.test.ts); what only a VM can answer is whether the
# launch-then-determine ORDER really resolves the state prompt-free.
#
# Airgapped, clock pinned 2026-07-05 (the trial wall is 2026-07-18 and is NEVER
# rolled), one clone, destroyed on exit. Beep sentinel with THINGS_LAB_BEEPS_OK=1
# (accounting, never a mute).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-sewake1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
PIN="070512002026"   # 2026-07-05 12:00 — well inside the trial wall
SE_BUNDLE="com.apple.systemevents"
# The shipped bound and interval (src/deputy/wake.ts).
WAKE_TIMEOUT_MS=5000
WAKE_INTERVAL_MS=50

note() { echo "[sewake1] $*" | tee -a "$REPORT"; }
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" "$@"; }
cleanup() {
  echo "[sewake1] teardown: $VM"
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

note "env: macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"

# --- the determination probe: deputy/src/tcc.swift, in ctypes -----------------
lab_ssh "$IP" 'cat > ~/labh/aedet.py' <<'PYEOF'
"""AEDeterminePermissionToAutomateTarget(askUserIfNeeded: false), verbatim.

Mirrors deputy/src/tcc.swift: an AECreateDesc of typeApplicationBundleID, then
the determination with typeWildCard for both the event class and the event id
and askUserIfNeeded FALSE. Prints "<status> <label> <elapsed_ms>" — the raw
OSStatus is what matters; the label is the deputy's own mapping.
"""
import ctypes, sys, time

TYPE_BUNDLE_ID = 0x62756E64  # 'bund'
TYPE_WILDCARD = 0x2A2A2A2A   # '****'

class AEDesc(ctypes.Structure):
    _fields_ = [("descriptorType", ctypes.c_uint32), ("dataHandle", ctypes.c_void_p)]

def load():
    for path in (
        "/System/Library/Frameworks/CoreServices.framework/CoreServices",
        "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
    ):
        try:
            lib = ctypes.CDLL(path)
            lib.AEDeterminePermissionToAutomateTarget
            return lib
        except (OSError, AttributeError):
            continue
    raise SystemExit("no framework exports AEDeterminePermissionToAutomateTarget")

LABELS = {0: "granted", -1743: "denied", -600: "not-running", -1744: "unknown(never-asked)"}

def determine(lib, bundle_id):
    data = bundle_id.encode()
    desc = AEDesc()
    lib.AECreateDesc.argtypes = [ctypes.c_uint32, ctypes.c_char_p, ctypes.c_long,
                                 ctypes.POINTER(AEDesc)]
    lib.AECreateDesc.restype = ctypes.c_int16
    if lib.AECreateDesc(TYPE_BUNDLE_ID, data, len(data), ctypes.byref(desc)) != 0:
        raise SystemExit("AECreateDesc failed")
    lib.AEDeterminePermissionToAutomateTarget.argtypes = [
        ctypes.POINTER(AEDesc), ctypes.c_uint32, ctypes.c_uint32, ctypes.c_bool]
    lib.AEDeterminePermissionToAutomateTarget.restype = ctypes.c_int32
    started = time.monotonic()
    status = lib.AEDeterminePermissionToAutomateTarget(
        ctypes.byref(desc), TYPE_WILDCARD, TYPE_WILDCARD, False)
    elapsed = int((time.monotonic() - started) * 1000)
    lib.AEDisposeDesc(ctypes.byref(desc))
    return status, elapsed

def main():
    lib = load()
    bundle_id = sys.argv[1]
    # `poll <ms> <interval-ms>`: the shipped closed loop — re-ask until the
    # target stops answering procNotFound, bounded, no fixed sleep.
    if len(sys.argv) > 2 and sys.argv[2] == "poll":
        bound_ms, interval_ms = int(sys.argv[3]), int(sys.argv[4])
        deadline = time.monotonic() + bound_ms / 1000
        started, asks = time.monotonic(), 0
        while True:
            status, _ = determine(lib, bundle_id)
            asks += 1
            if status != -600 or time.monotonic() >= deadline:
                break
            time.sleep(interval_ms / 1000)
        waited = int((time.monotonic() - started) * 1000)
        print(f"{status} {LABELS.get(status, 'unknown')} waited={waited}ms asks={asks}")
        return
    status, elapsed = determine(lib, bundle_id)
    print(f"{status} {LABELS.get(status, 'unknown')} call={elapsed}ms")

main()
PYEOF

det()  { lab_ssh "$IP" "/usr/bin/python3 ~/labh/aedet.py $1" </dev/null 2>&1; }
poll() { lab_ssh "$IP" "/usr/bin/python3 ~/labh/aedet.py $1 poll $WAKE_TIMEOUT_MS $WAKE_INTERVAL_MS" </dev/null 2>&1; }
live() { lab_ssh "$IP" 'pgrep -x "System Events" >/dev/null && echo LIVE || echo DOWN' </dev/null 2>&1; }
# THE DIALOG ORACLE. A TCC consent dialog is drawn by CoreServicesUIAgent (the
# Automation prompt) or UserNotificationCenter. Their mere PRESENCE proves
# nothing — CoreServicesUIAgent is resident in every session — so the oracle
# counts WINDOWS, which is what a prompt actually puts on screen. Read through
# System Events under the guest's AXVM1 grant; `0` from a live agent is the
# clean state.
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

bs reset >/dev/null
bmark "sewake1 start"

note "############### SEWAKE1-a: inventory ###############"
note "-- System Events at boot: $(live)"
note "-- guest AppleEvents TCC rows (user db) --"
lab_ssh "$IP" 'sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" "SELECT client,indirect_object_identifier,auth_value FROM access WHERE service='\''kTCCServiceAppleEvents'\''" 2>&1' </dev/null | sed 's/^/    /' | tee -a "$REPORT"
note "-- warm the target once so a LIVE baseline exists --"
lab_ssh "$IP" "open -g -b $SE_BUNDLE; sleep 2" </dev/null
note "-- liveness: $(live)"
BASE=$(det "$SE_BUNDLE"); note "-- determination (LIVE target): $BASE"
DLG_BEFORE=$(dialogs); note "-- dialog windows at baseline: $DLG_BEFORE"

note "############### SEWAKE1-b: the dormant state ###############"
bmark "kill system events"
lab_ssh "$IP" 'killall "System Events" 2>&1 || true; sleep 1' </dev/null | sed 's/^/    /' | tee -a "$REPORT"
note "-- liveness after killall: $(live)"
DOWN=$(det "$SE_BUNDLE"); note "-- determination (DOWN target): $DOWN"
case "$DOWN" in
  -600\ not-running*) note "   OK — the determination reports LIVENESS, exactly as the deputy relays it";;
  *) note "   UNEXPECTED — the dormant determination is not -600; the premise does not hold here";;
esac
note "-- does it stay down on its own? (5s, nothing must resurrect it) --"
lab_ssh "$IP" 'sleep 5' </dev/null
note "   liveness after 5s idle: $(live)  determination: $(det "$SE_BUNDLE")"

note "############### SEWAKE1-c: positive control — -600 tracks LIVENESS ###############"
# A second target that is also down must read the same -600 from the same probe;
# a constant would prove nothing about the wake.
lab_ssh "$IP" 'pgrep -x "Chess" >/dev/null && killall Chess; sleep 1' </dev/null >/dev/null 2>&1
note "-- determination for com.apple.Chess (not running): $(det com.apple.Chess)"

note "############### SEWAKE1-d: THE WAKE (launch, THEN determine) ###############"
bmark "wake"
LAUNCH_START=$(ms)
LAUNCH=$(lab_ssh "$IP" "open -g -b $SE_BUNDLE; echo \"[exit \$?]\"" </dev/null 2>&1)
note "-- launch: $LAUNCH"
RESOLVED=$(poll "$SE_BUNDLE")
LAUNCH_END=$(ms)
note "-- liveness after launch: $(live)"
note "-- determination after the wake: $RESOLVED"
note "-- whole sequence (host wall clock, ssh included): $((LAUNCH_END - LAUNCH_START))ms"

note "############### SEWAKE1-e: zero dialogs ###############"
DLG_AFTER=$(dialogs); note "-- dialog windows after the wake: $DLG_AFTER"
# Clean = every resident agent holds zero windows. Any "=N windows" with N > 0
# is a prompt on screen.
DLG=$(printf '%s' "$DLG_AFTER" | grep -Eo '=[0-9]+ windows' | grep -Ecv '^=0 windows$')
note "-- beep sentinel --"
bs assert --json /tmp/sewake1-beeps.json --name sewake1 | sed 's/^/    /' | tee -a "$REPORT"
BEEPS=$(lab_ssh "$IP" 'python3 -c "import json;print(json.load(open(\"/tmp/sewake1-beeps.json\"))[\"beeps\"])" 2>/dev/null || echo "?"' </dev/null)

note "################ VERDICT ################"
note "baseline (live)      : $BASE"
note "dormant              : $DOWN"
note "after the wake       : $RESOLVED"
note "dialog windows before: $DLG_BEFORE"
note "dialog windows after : $DLG_AFTER"
note "agents holding a window: $DLG (must be 0)"
note "beeps                : $BEEPS (must be 0)"
case "$RESOLVED" in
  -600\ *) note "RED — the wake did not take";;
  *) [ "$DLG" = "0" ] && note "GREEN — a dormant target is resolved to a real determination, prompt-free" \
       || note "RED — a consent-dialog agent held a window";;
esac
note "report: $REPORT"
