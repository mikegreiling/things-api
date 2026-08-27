#!/bin/bash
# TCCDUR1 — is the macOS app-data grant (kTCCServiceSystemPolicyAppData)
# DURABLE for a DEVELOPER-ID-signed responsible app, or is APDP1's
# instance-pinning universal?
#
# The contradiction this settles:
#   * APDP1 (golden-v4, macOS 15.7.7, responsible app = Apple-platform-signed
#     Terminal.app) measured INSTANCE pinning — quit+relaunch re-prompted and
#     the single TCC row was rewritten to the new pid/pid_version.
#   * A field observation on the maintainer's M1 (macOS 15.4.1, responsible app
#     = a Developer-ID-signed third-party app) saw the grant SURVIVE an
#     ordinary quit and relaunch.
# Unexplained axes: macOS minor version (NOT testable here — every golden is
# 15.7.7), SIGNING CLASS (testable, and this campaign's discriminator), and
# responsible-instance subtleties (a persistent helper carrying responsibility).
#
# Rig: ONE disposable golden-v4 clone, phases run as separate invocations
# against the same live clone so a late failure never costs the boot.
#
#   bash lab/scripts/research-tccdur1.sh boot       clone + boot + install
#   bash lab/scripts/research-tccdur1.sh devid      stage B (the discriminator)
#   bash lab/scripts/research-tccdur1.sh reboot     stage R
#   bash lab/scripts/research-tccdur1.sh launchd    stage L
#   bash lab/scripts/research-tccdur1.sh helper     stage A (shipped bundle)
#   bash lab/scripts/research-tccdur1.sh terminal   stage T (APDP1 control)
#   bash lab/scripts/research-tccdur1.sh down       teardown
#
# CLOCK NOTE (rig-critical): unlike every other campaign this one does NOT pin
# the guest clock to the golden's 2026-07-05. Things is never launched, so the
# trial wall is irrelevant — and the probe bundles are signed by a Developer ID
# certificate whose notBefore is 2026-08-20 with a secure timestamp in 2026-08.
# Under a 2026-07-05 clock that signature is not yet valid; the `boot` phase
# MEASURES that (both clocks, `codesign --verify`) and then leaves the guest on
# real time.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="tccdur1"
GOLDEN="things-lab-golden-v4"
OUT="lab/artifacts/$VM"
mkdir -p "$OUT/dlg" "$OUT/tcc"
REPORT="$OUT/report.txt"
IPFILE="$OUT/ip.txt"
D=/Users/admin/labh/tccdur1
PROBE_APP="TCCDUR1 Probe.app"
HELPER_APP="Things API Helper.app"
AGENT_LABEL="com.pixelcog.tccdur1-probe.agent"

note() { echo "[tccdur1] $*" | tee -a "$REPORT"; }
IP=""
load_ip() {
  IP=$(cat "$IPFILE" 2>/dev/null)
  [ -n "$IP" ] || { echo "no IP recorded — run the boot phase first" >&2; exit 1; }
}

# ── shared primitives ────────────────────────────────────────────────────────
dlgdump() { lab_ssh "$IP" "osascript -l JavaScript $D/axsys.jxa dump" </dev/null >"$OUT/dlg/$1.txt" 2>&1; }
press() { lab_ssh "$IP" "osascript -l JavaScript $D/axsys.jxa press $(printf '%q' "$1")" </dev/null 2>&1; }

tccdump() { # tccdump <stage-label>
  lab_ssh "$IP" "bash $D/tccdump.sh" </dev/null >"$OUT/tcc/$1.txt" 2>&1
  note "  [tcc $1] AppData rows: $(grep -c 'service = kTCCServiceSystemPolicyAppData' "$OUT/tcc/$1.txt")"
  # LC_ALL=C: the csreq column is a binary blob and a UTF-8 awk aborts on it.
  LC_ALL=C awk '/^ *service = kTCCServiceSystemPolicyAppData/,/^$/' "$OUT/tcc/$1.txt" |
    grep -E '^ *(service|client|client_type|auth_value|auth_reason|pid|pid_version|boot_uuid|last_modified) =' |
    sed 's/^/    /' | tee -a "$REPORT"
}

procinfo() { # procinfo <label> <pid>
  [ -z "${2:-}" ] && { note "  [$1] no pid"; return; }
  lab_ssh "$IP" "sudo launchctl procinfo $2 2>&1 | head -60" </dev/null >"$OUT/dlg/$1-procinfo.txt" 2>&1
  note "  [$1] pid=$2 $(grep -iE 'responsible|program path' "$OUT/dlg/$1-procinfo.txt" | tr '\n' ' ' | tr -s ' ')"
}

apppid() { lab_ssh "$IP" "pgrep -x tccdur1-probe | head -1" </dev/null | tr -d '[:space:]'; }

# TCC dialogs QUEUE, and one SURVIVES its requester's death (APDP1 stage A).
# A cell whose requester was killed while blocked therefore leaves a dialog on
# screen that the NEXT cell's `press Allow` answers instead of its own — which
# reads exactly like "the new cell was allowed instantly" while the new
# requester is still blocked (measured on this campaign's first stage-T pass).
# Every phase drains the screen before it starts.
drain_dialogs() {
  local i left
  for i in 1 2 3 4 5 6; do
    dlgdump "drain-$1-$i"
    grep -qE 'ttl=Allow' "$OUT/dlg/drain-$1-$i.txt" || break
    note "  [drain $1] a stale consent dialog is on screen -> $(press Allow)"
    sleep 2
  done
  left=$(grep -c 'ttl=Allow' "$OUT/dlg/drain-$1-$i.txt" 2>/dev/null || echo 0)
  note "  [drain $1] dialogs left on screen: $left"
}

# runcell <label> [maxwait] — touch the go file, watch for the result, and if
# the app is still blocked after ~8 s, census the screen and press Allow.
MODAL=NO
runcell() {
  local L="$1" MAX="${2:-90}" t=0 handled=0
  MODAL=NO
  note "---- cell $L ----"
  lab_ssh "$IP" "$D/mark.sh 'cell $L'; rm -f $D/$L.json $D/$L.start; touch $D/go-$L" </dev/null >/dev/null 2>&1
  while [ "$t" -lt "$MAX" ]; do
    if lab_ssh "$IP" "test -s $D/$L.json" </dev/null; then break; fi
    sleep 2
    t=$((t + 2))
    if [ "$t" -ge 8 ] && [ "$handled" -eq 0 ]; then
      handled=1
      note "  [$L] still blocked after ~${t}s — dialog census + TCC row WHILE the modal is up"
      dlgdump "$L"
      grep -qE 'ttl=Allow' "$OUT/dlg/$L.txt" && MODAL=YES
      note "  [$L] Allow button present: $MODAL"
      grep -E 'val=.*(access data from other apps|would like)|ttl=(Allow|Don)' "$OUT/dlg/$L.txt" | head -6 | sed 's/^/    /' | tee -a "$REPORT"
      tccdump "$L-while-modal"
      procinfo "$L-blocked" "$(apppid)"
      note "  [$L] press Allow -> $(press Allow)"
    fi
  done
  if [ "$t" -ge "$MAX" ]; then note "  [$L] TIMEOUT after ${MAX}s"; fi
  note "  [$L] modal=$MODAL result: $(lab_ssh "$IP" "cat $D/$L.json 2>/dev/null || echo NO-RESULT" </dev/null)"
  if [ "$handled" -eq 0 ]; then
    dlgdump "$L-after"
    note "  [$L] post-cell: Allow button on screen: $(grep -qE 'ttl=Allow' "$OUT/dlg/$L-after.txt" && echo YES || echo NO)"
  fi
}

launch_probe_app() {
  lab_ssh "$IP" "open -a '$D/$PROBE_APP' --args --dir $D" </dev/null
  sleep 4
  local p
  p=$(apppid)
  note "  probe app launched pid=$p"
  procinfo "applaunch-$(date +%s)" "$p"
  lab_ssh "$IP" "tail -3 $D/launches.log" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
}

beeps() { # beeps <name>
  lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 bash $D/beep-sentinel.sh assert --name $1" </dev/null 2>&1 |
    tail -5 | sed 's/^/    /' | tee -a "$REPORT"
}

# ── phases ───────────────────────────────────────────────────────────────────
phase_boot() {
  : >"$REPORT"
  note "==== BOOT ===="
  tart delete "$VM" >/dev/null 2>&1 || true
  note "clone $GOLDEN -> $VM"
  tart clone "$GOLDEN" "$VM" || exit 1
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 360) || { note "FATAL: no ssh"; exit 1; }
  echo "$IP" >"$IPFILE"
  note "ssh up at $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  note "airgap: $(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo FAIL || echo OK' </dev/null)"
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1' </dev/null
  note "macOS: $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) ($(lab_ssh "$IP" 'sw_vers -buildVersion' </dev/null))  Things: $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)"

  lab_ssh "$IP" "rm -rf $D; mkdir -p $D" </dev/null
  note "copying the two SIGNED bundles into the guest"
  lab_scp -r "lab/artifacts/tccdur1/build/$PROBE_APP" "$LAB_SSH_USER@$IP:$D/" >/dev/null
  lab_scp -r "deputy/build/$HELPER_APP" "$LAB_SSH_USER@$IP:$D/" >/dev/null
  lab_scp lab/guest/beep-sentinel.sh "$LAB_SSH_USER@$IP:$D/" >/dev/null

  # THE CLOCK/SIGNATURE MEASUREMENT — see the header note.
  note "---- signature validity vs guest clock ----"
  local GUEST_NOW
  GUEST_NOW=$(lab_ssh "$IP" 'date +%m%d%H%M%Y' </dev/null | tr -d '[:space:]')
  lab_ssh "$IP" "sudo date 070512002026 >/dev/null; date" </dev/null | sed 's/^/    pinned-clock: /' | tee -a "$REPORT"
  note "  codesign --verify under the 2026-07-05 pin: $(lab_ssh "$IP" "codesign --verify --verbose=1 '$D/$PROBE_APP' 2>&1 | tr '\n' ' '" </dev/null)"
  note "  spctl assess under the pin: $(lab_ssh "$IP" "spctl -a -vv '$D/$PROBE_APP' 2>&1 | tr '\n' ' '" </dev/null)"
  lab_ssh "$IP" "sudo date $GUEST_NOW >/dev/null; date" </dev/null | sed 's/^/    real-clock: /' | tee -a "$REPORT"
  note "  codesign --verify on real time: $(lab_ssh "$IP" "codesign --verify --verbose=1 '$D/$PROBE_APP' 2>&1 | tr '\n' ' '" </dev/null)"
  note "  helper bundle on real time: $(lab_ssh "$IP" "codesign --verify --verbose=1 '$D/$HELPER_APP' 2>&1 | tr '\n' ' '" </dev/null)"
  note "  probe identity: $(lab_ssh "$IP" "codesign -dvvv '$D/$PROBE_APP' 2>&1 | grep -E 'Identifier=|Authority=Developer' | tr '\n' ' '" </dev/null)"

  # Guest helpers.
  lab_ssh "$IP" "cat > $D/tryopen.py" <<'EOF'
import json, os, sys, time
label, path = sys.argv[1], sys.argv[2]
D = os.path.dirname(os.path.abspath(__file__))
rec = {"label": label, "pid": os.getpid(), "ppid": os.getppid()}
with open(os.path.join(D, label + ".childstart"), "w") as f:
    f.write(json.dumps(rec) + "\n")
t0 = time.time()
try:
    fd = os.open(path, os.O_RDONLY)
    head = os.read(fd, 16)
    os.close(fd)
    rec.update(ok=True, head=head.decode("latin-1").rstrip("\x00"))
except OSError as e:
    rec.update(ok=False, errno=e.errno, msg=str(e))
rec["elapsedSec"] = round(time.time() - t0, 3)
print(json.dumps(rec))
EOF

  lab_ssh "$IP" "cat > $D/tccdump.sh && chmod +x $D/tccdump.sh" <<'EOF'
#!/bin/bash
UDB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
SDB="/Library/Application Support/com.apple.TCC/TCC.db"
echo "=== boot_uuid now: $(sysctl -n kern.bootsessionuuid) ==="
echo "--- USER TCC.db: every AppData row (all columns) ---"
sqlite3 -line "file:$UDB?mode=ro" "SELECT * FROM access WHERE service='kTCCServiceSystemPolicyAppData';" 2>&1
echo "--- USER TCC.db: row census ---"
sqlite3 -noheader -list "file:$UDB?mode=ro" "SELECT service||' | '||client||' | type='||client_type||' | auth='||auth_value||' | reason='||auth_reason FROM access ORDER BY service;" 2>&1
echo "--- SYSTEM TCC.db: row census ---"
sudo sqlite3 -noheader -list "file:$SDB?mode=ro" "SELECT service||' | '||client||' | type='||client_type||' | auth='||auth_value FROM access ORDER BY service;" 2>&1
EOF

  lab_ssh "$IP" "cat > $D/mark.sh && chmod +x $D/mark.sh" <<EOF
#!/bin/bash
bash $D/beep-sentinel.sh mark "\$1" >/dev/null 2>&1 || true
EOF

  # The system-wide AX tool (APDP1): the TCC modal belongs to
  # UserNotificationCenter, so a per-app dump cannot see it.
  lab_scp lab/scripts/tccdur1-probe/axsys.jxa "$LAB_SSH_USER@$IP:$D/axsys.jxa" >/dev/null

  DBPATH=$(lab_ssh "$IP" 'ls "$HOME/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/"ThingsData-*/"Things Database.thingsdatabase/main.sqlite"' </dev/null)
  note "container db: $DBPATH"
  lab_ssh "$IP" "printf '%s' '$DBPATH' > $D/dbpath.txt" </dev/null
  lab_ssh "$IP" "bash $D/beep-sentinel.sh reset" </dev/null
  note "install complete"
  tccdump 00-baseline
}

phase_devid() {
  load_ip
  note "==== STAGE B — Developer-ID app, OWN-CODE SQLite read ===="
  lab_ssh "$IP" "tccutil reset SystemPolicyAppData com.pixelcog.tccdur1-probe" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "pkill -x tccdur1-probe; rm -f $D/b*.json $D/b*.start $D/go-*; true" </dev/null
  tccdump b00-baseline

  note "-- instance #1 (open -a) --"
  launch_probe_app
  runcell b1 120
  tccdump b01-after-b1
  runcell b2 40
  runcell b3-child 40
  tccdump b02-after-siblings

  note "-- ORDINARY QUIT (go-quit, exit 0) then relaunch --"
  lab_ssh "$IP" "touch $D/go-quit" </dev/null
  sleep 4
  note "  probe running after graceful quit: $(lab_ssh "$IP" 'pgrep -x tccdur1-probe >/dev/null && echo STILL-RUNNING || echo QUIT' </dev/null)"
  tccdump b03-after-graceful-quit
  launch_probe_app
  runcell b4 120
  tccdump b04-after-b4-relaunch

  note "-- SIGKILL then relaunch --"
  lab_ssh "$IP" "pkill -9 -x tccdur1-probe; sleep 3; pgrep -x tccdur1-probe >/dev/null && echo STILL-RUNNING || echo KILLED" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
  tccdump b05-after-sigkill
  launch_probe_app
  runcell b5 120
  tccdump b06-after-b5-relaunch
  beeps stage-b
}

phase_reboot() {
  load_ip
  note "==== STAGE R — reboot durability ===="
  tccdump r00-pre-reboot
  lab_ssh "$IP" "sudo shutdown -r now" </dev/null >/dev/null 2>&1 || true
  sleep 25
  IP=$(lab_wait_for_ssh "$VM" 360) || { note "FATAL: no ssh after reboot"; exit 1; }
  echo "$IP" >"$IPFILE"
  note "rebooted; ssh up at $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1' </dev/null
  lab_ssh "$IP" "bash $D/beep-sentinel.sh reset" </dev/null
  note "  clock: $(lab_ssh "$IP" 'date' </dev/null)"
  tccdump r01-post-reboot
  launch_probe_app
  runcell r1 120
  tccdump r02-after-r1
  beeps stage-r
}

phase_launchd() {
  load_ip
  note "==== STAGE L — the SAME signed binary, launchd-hosted ===="
  lab_ssh "$IP" "pkill -x tccdur1-probe; tccutil reset SystemPolicyAppData com.pixelcog.tccdur1-probe; rm -f $D/l*.json $D/l*.start $D/go-*; true" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
  local UID_G
  UID_G=$(lab_ssh "$IP" 'id -u' </dev/null | tr -d '[:space:]')
  lab_ssh "$IP" "mkdir -p ~/Library/LaunchAgents; cat > ~/Library/LaunchAgents/$AGENT_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$D/$PROBE_APP/Contents/MacOS/tccdur1-probe</string>
    <string>--dir</string>
    <string>$D</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
EOF
  lab_ssh "$IP" "launchctl bootout gui/$UID_G/$AGENT_LABEL 2>/dev/null; launchctl bootstrap gui/$UID_G ~/Library/LaunchAgents/$AGENT_LABEL.plist 2>&1; sleep 3; launchctl print gui/$UID_G/$AGENT_LABEL 2>&1 | grep -E 'state|pid ' | head -4" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
  procinfo "launchd-instance1" "$(apppid)"
  tccdump l00-baseline
  runcell l1 120
  tccdump l01-after-l1
  runcell l2 40

  local k
  for k in 1 2 3; do
    note "-- launchctl kickstart -k (restart #$k) --"
    lab_ssh "$IP" "launchctl kickstart -k gui/$UID_G/$AGENT_LABEL 2>&1; sleep 4; pgrep -x tccdur1-probe | head -1" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
    procinfo "launchd-restart$k" "$(apppid)"
    runcell "l3-r$k" 90
    tccdump "l0$((1 + k))-after-restart$k"
  done
  lab_ssh "$IP" "launchctl bootout gui/$UID_G/$AGENT_LABEL 2>/dev/null; true" </dev/null
  beeps stage-l
}

phase_helper() {
  load_ip
  note "==== STAGE A — the SHIPPED helper bundle (com.pixelcog.things-api-helper) ===="
  lab_ssh "$IP" "tccutil reset SystemPolicyAppData com.pixelcog.things-api-helper" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "pkill -x things-deputy; rm -rf $D/dstate; mkdir -p $D/dstate; true" </dev/null
  lab_ssh "$IP" "cat > $D/deputyread.py" <<'PYEOF'
# One `osascript` request to the deputy whose script performs a real content
# read of the Things DB. The child (osascript) is Apple-signed; its RESPONSIBLE
# app is the Developer-ID helper bundle that spawned it.
import json, os, socket, sys, time
D = os.path.dirname(os.path.abspath(__file__))
label = sys.argv[1]
state = os.path.join(D, "dstate")
db = open(os.path.join(D, "dbpath.txt")).read().strip()
tok = open(os.path.join(state, "token")).read().strip()
script = (
    'set p to POSIX file "%s"\n'
    "set f to open for access p\n"
    "set d to read f for 16\n"
    "close access f\n"
    "return d" % db
)
req = {"v": 1, "id": label, "token": tok, "verb": "osascript", "script": script, "timeoutMs": 180000}
with open(os.path.join(D, label + ".start"), "w") as fh:
    fh.write(json.dumps({"label": label, "pid": os.getpid()}) + "\n")
t0 = time.time()
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(200)
s.connect(os.path.join(state, "deputy.sock"))
s.sendall((json.dumps(req) + "\n").encode())
buf = b""
while not buf.endswith(b"\n"):
    chunk = s.recv(65536)
    if not chunk:
        break
    buf += chunk
resp = json.loads(buf.decode())
resp["label"] = label
resp["elapsedSec"] = round(time.time() - t0, 3)
with open(os.path.join(D, label + ".json"), "w") as fh:
    fh.write(json.dumps(resp) + "\n")
print(json.dumps(resp))
PYEOF

  lab_ssh "$IP" "cat > $D/dread.command && chmod +x $D/dread.command" <<EOF
#!/bin/bash
exec >>"$D/dread.log" 2>&1
LBL="\$(cat $D/dlabel.txt)"
echo "=== DREAD \$LBL pid=\$\$ ts=\$(date +%s) ==="
/usr/bin/python3 $D/deputyread.py "\$LBL"
echo "DREAD-DONE \$LBL ts=\$(date +%s)"
EOF

  launch_helper() {
    lab_ssh "$IP" "open -a '$D/$HELPER_APP' --args --state-dir $D/dstate" </dev/null
    sleep 4
    local p
    p=$(lab_ssh "$IP" "pgrep -x things-deputy | head -1" </dev/null | tr -d '[:space:]')
    note "  helper launched pid=$p"
    procinfo "helper-$(date +%s)" "$p"
  }

  helpercell() { # helpercell <label>
    local L="$1" t=0 handled=0
    MODAL=NO
    note "---- cell $L (deputy osascript child read) ----"
    # The client BLOCKS while the deputy's osascript child sits in the gated
    # open(2), so it cannot run in the foreground of this driver's ssh call —
    # and it is never nohup'd either (no orphans). It rides a Terminal-hosted
    # .command, the same self-reaping shape APDP1 used. The client only speaks
    # to a socket; it never touches the container, so Terminal's own TCC
    # standing is irrelevant to what is being measured.
    lab_ssh "$IP" "$D/mark.sh 'cell $L'; rm -f $D/$L.json; printf '%s' '$L' > $D/dlabel.txt; open -a Terminal $D/dread.command" </dev/null >/dev/null 2>&1
    while [ "$t" -lt 120 ]; do
      if lab_ssh "$IP" "test -s $D/$L.json" </dev/null; then break; fi
      sleep 2
      t=$((t + 2))
      if [ "$t" -ge 8 ] && [ "$handled" -eq 0 ]; then
        handled=1
        dlgdump "$L"
        grep -qE 'ttl=Allow' "$OUT/dlg/$L.txt" && MODAL=YES
        note "  [$L] blocked ~${t}s; Allow button present: $MODAL"
        grep -E 'val=.*(access data from other apps|would like)|ttl=(Allow|Don)' "$OUT/dlg/$L.txt" | head -6 | sed 's/^/    /' | tee -a "$REPORT"
        tccdump "$L-while-modal"
        note "  [$L] press Allow -> $(press Allow)"
      fi
    done
    note "  [$L] modal=$MODAL result: $(lab_ssh "$IP" "cat $D/$L.json 2>/dev/null || echo NO-RESULT" </dev/null)"
  }

  tccdump a00-baseline
  launch_helper
  helpercell a1
  tccdump a01-after-a1
  helpercell a2
  note "-- graceful quit (SIGTERM: the deputy drains and exits 0) then relaunch --"
  lab_ssh "$IP" "pkill -x things-deputy; sleep 4; pgrep -x things-deputy >/dev/null && echo STILL-RUNNING || echo QUIT" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
  tccdump a02-after-quit
  launch_helper
  helpercell a3
  tccdump a03-after-relaunch
  lab_ssh "$IP" "pkill -x things-deputy; true" </dev/null
  beeps stage-a
}

phase_terminal() {
  load_ip
  note "==== STAGE T — APDP1 control: Apple-platform-signed Terminal.app, SAME clone ===="
  lab_ssh "$IP" "killall -9 Terminal 2>/dev/null; true" </dev/null
  drain_dialogs t
  lab_ssh "$IP" "tccutil reset SystemPolicyAppData com.apple.Terminal; killall -9 Terminal 2>/dev/null; defaults write com.apple.Terminal NSQuitAlwaysKeepsWindows -bool false; rm -f $D/t*.json $D/t*.tmp $D/t*.childstart $D/term.log; true" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "cat > $D/term.command && chmod +x $D/term.command" <<EOF
#!/bin/bash
D=$D
DB="\$(cat \$D/dbpath.txt)"
exec >>"\$D/term.log" 2>&1
echo "=== TERM pid=\$\$ ppid=\$PPID ts=\$(date +%s) ==="
LBL="\$(cat \$D/termlabel.txt)"
# Write through a temp and rename: a shell redirect creates the result file
# EMPTY the instant the cell starts, and a host-side existence poll would then
# call a still-blocked cell "finished with no result" (measured, first pass).
/usr/bin/python3 "\$D/tryopen.py" "\$LBL" "\$DB" > "\$D/\$LBL.tmp"
mv "\$D/\$LBL.tmp" "\$D/\$LBL.json"
echo "TERM-DONE \$LBL ts=\$(date +%s)"
EOF
  termcell() { # termcell <label>
    local L="$1" t=0 handled=0
    MODAL=NO
    note "---- cell $L (Terminal-attributed child read) ----"
    lab_ssh "$IP" "$D/mark.sh 'cell $L'; rm -f $D/$L.json; printf '%s' '$L' > $D/termlabel.txt; open -a Terminal $D/term.command" </dev/null >/dev/null 2>&1
    while [ "$t" -lt 120 ]; do
      if lab_ssh "$IP" "test -s $D/$L.json" </dev/null; then break; fi
      sleep 2
      t=$((t + 2))
      if [ "$t" -ge 10 ] && [ "$handled" -eq 0 ]; then
        handled=1
        dlgdump "$L"
        grep -qE 'ttl=Allow' "$OUT/dlg/$L.txt" && MODAL=YES
        note "  [$L] blocked ~${t}s; Allow button present: $MODAL"
        grep -E 'val=.*(access data from other apps|would like)|ttl=(Allow|Don)' "$OUT/dlg/$L.txt" | head -6 | sed 's/^/    /' | tee -a "$REPORT"
        tccdump "$L-while-modal"
        note "  [$L] press Allow -> $(press Allow)"
      fi
    done
    note "  [$L] modal=$MODAL result: $(lab_ssh "$IP" "cat $D/$L.json 2>/dev/null || echo NO-RESULT" </dev/null)"
  }
  tccdump t00-baseline
  termcell t1
  tccdump t01-after-t1
  note "-- Terminal QUIT + relaunch --"
  lab_ssh "$IP" "killall -9 Terminal; sleep 4; pgrep -x Terminal >/dev/null && echo STILL-RUNNING || echo QUIT" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
  termcell t2
  tccdump t02-after-t2
  beeps stage-t
}

phase_down() {
  note "==== TEARDOWN ===="
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  rm -f "$IPFILE"
  note "  $VM stopped + deleted; remaining VMs:"
  tart list | sed 's/^/    /' | tee -a "$REPORT"
}

case "${1:-}" in
boot) phase_boot ;;
devid) phase_devid ;;
reboot) phase_reboot ;;
launchd) phase_launchd ;;
helper) phase_helper ;;
terminal) phase_terminal ;;
down) phase_down ;;
*)
  echo "usage: research-tccdur1.sh boot|devid|reboot|launchd|helper|terminal|down" >&2
  exit 2
  ;;
esac
