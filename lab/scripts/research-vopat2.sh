#!/bin/bash
# VOPAT2 — BUILD the screen-reader settle: the app tells us when it has changed.
#
# VOPAT1 (#676, docs/lab/vopat1-screen-reader-pattern.md) measured what Things
# announces through the Accessibility notification API and found an observable
# for every actuation the Repeat-dialog drive makes — plus the property that
# makes them usable: idle chatter is ZERO, so every arrival is attributable to
# the actuation before it. That campaign changed nothing in src/. This one is
# the build, and this driver is its certification.
#
# WHAT SHIPPED (src/write/vectors/ui-observer.ts): a python3 ctypes AXObserver
# SIDECAR, one process per drive, spawned from INSIDE an osascript hop so it
# inherits the Accessibility identity that already holds the grant. The driver
# marks a sequence before an actuation and awaits the observable after it — from
# node over a Unix socket for a cross-hop settle, and from the hop's own script
# with `nc -U` for a settle in the middle of a script.
#
# CELLS:
#   setup      clone + boot + airgap + clock pin + AX-grant check + warm-up
#   ship       node + dist + commander + ui-enabled + the sidecar, extracted
#              from the BUILT bundle so the guest runs the shipped bytes
#   spawn      THE PRODUCTION-SHAPE DECISION, measured: what one osascript
#              spawn costs, what one python3 spawn costs, what arming the
#              sidecar costs, and what ONE settle costs against it. This is
#              what says "one sidecar per drive" rather than "one per settle".
#   appreg     does registration on the APPLICATION element alone catch what
#              its DESCENDANTS post? The whole design rests on yes.
#   sidecar    the lifetime: handshake, token refusal, explicit stop, TTL reap,
#              no orphan, no socket left behind, no consent dialog.
#   states     the 5-state matrix through the production CLI, sidecar LIVE
#   fallback   the same drives with THINGS_API_AX_OBSERVER=0 — the polling
#              settle must still be certified, because it is the fallback
#   cells      the FGRD/MODALX guard cells (U 2x2 / C2 / S / T / X) + chord
#   census     the window/focus census printed in full, in all four quadrants
#   trace      one traced drive: per-hop durationMs + axOps + axElems + the
#              notification awaited and its latency
#   teardown   stop + delete the clone
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and never rolled (trial wall
# 2026-07-18). Fixtures fully synthetic (VOPAT2-*). Beep sentinel default-on.
# Clone destroyed at teardown.
#
# REPRODUCIBILITY: a clone is ~200x cheaper per element realized than the field
# and CANNOT reproduce field wall times (VOPAT1's own warning). What transfers is
# ROUND-TRIP and ELEMENT counts, which notifications fire, and how long THE APP
# takes to announce — the last of which is the term a settled drive is bound by.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-vopat2}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/trace"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — well inside the trial wall (2026-07-18)
note() { echo "[vopat2] $*" | tee -a "$REPORT"; }
# Research driver: beeps are COUNTED and reported, never fatal (harness.md opt-out).
export THINGS_LAB_BEEPS_OK=1

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
front() { lab_ssh "$IP" "osascript -e 'tell application \"$1\" to activate'; sleep 1" </dev/null; }
add() { lab_ssh "$IP" "open -g $(printf '%q' "things:///add?title=$1"); sleep 2" </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -g -a Things3; sleep 14' </dev/null; }
dismiss() {
  front Things3
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null
}
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
PY='/usr/bin/python3 ~/labh/ax-observer.py'
SOCK='/Users/admin/labh/probe.sock'
TOK='vopat2tokenvopat2tokenvopat2tok'

# One request/response against a running sidecar, exactly as the in-hop client
# does it (printf | nc -U), so the cell measures the shipped transport.
obs() { # obs <request-tail...>
  lab_ssh "$IP" "/usr/bin/printf '%s\\n' $(printf '%q' "$TOK $*") | /usr/bin/nc -U -w 20 $SOCK" </dev/null 2>&1
}
things_pid() { axq 'tell application "System Events" to return unix id of first application process whose name is "Things3"' | tr -d '\r'; }
# Arm a PROBE sidecar (the cells' own, not a drive's) and wait for its socket.
arm() { # arm [ttl-ms] [idle-ms]
  local ttl="${1:-120000}" idle="${2:-90000}" pid
  pid=$(things_pid)
  lab_ssh "$IP" "rm -f $SOCK; $PY --socket $SOCK --token $TOK --pid $pid --ttl-ms $ttl --idle-ms $idle >>~/labh/observer.log 2>&1 </dev/null & sleep 0.3; true" </dev/null >/dev/null 2>&1
  local i
  for i in $(seq 1 60); do
    case "$(obs hello)" in ok*) return 0 ;; esac
    sleep 0.2
  done
  return 1
}
disarm() { obs stop >/dev/null 2>&1; sleep 1; }
sidecar_pids() { lab_ssh "$IP" "pgrep -f ax-observer.py | tr '\\n' ' '" </dev/null 2>/dev/null; }

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "=== VOPAT2 setup — $(date) ==="
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free on /Volumes/Workspace"; exit 1; }
  RUNNING=$(tart list | awk 'NR>1 && $NF=="running" {print $2}' | tr '\n' ' ')
  [ -n "$RUNNING" ] && { note "FATAL: another VM is running ($RUNNING) — never a second concurrent clone"; exit 1; }

  if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }; fi
  [ -f dist/cli/main.js ] || { echo "no dist/cli/main.js" >&2; exit 1; }

  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || exit 1
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"

  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  note "airgap: $AG"; [ "$AG" = "AIRGAP-OK" ] || exit 1
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (trial wall 2026-07-18 — never rolled)"

  GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
  note "AX grant=$GRANT (want 2)"; [ "$GRANT" = "2" ] || { note "FATAL: AX grant"; exit 1; }
  # The sidecar's whole permissions story: python3 is present because the CLT
  # are, and the gate the shipped code uses is exactly this question.
  note "xcode-select -p: $(lab_ssh "$IP" 'xcode-select -p 2>&1' </dev/null)"
  note "python3: $(lab_ssh "$IP" '/usr/bin/python3 -V 2>&1' </dev/null)"

  lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  printf '%s\n' "$GSQL" | lab_ssh "$IP" 'cat > ~/labh/gsql.sh; chmod +x ~/labh/gsql.sh'
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null

  warm
  VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null | tr '\n' '/')
  OSV=$(lab_ssh "$IP" 'sw_vers -productVersion; sw_vers -buildVersion' </dev/null | tr '\n' '/')
  note "things: $VER  macos: $OSV  db: $(gq 'SELECT value FROM Meta WHERE key="databaseVersion"')"
  echo "IP=$IP" > "$SESSION"
  note "=== setup done ==="
  exit 0
fi

# ===================================================================== ship
if [ "$CMD" = "ship" ]; then
  load_session
  if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }; fi
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  MAIN_WT=$(dirname "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null || true)
  NM="$(pwd)/node_modules"; [ -d "$NM/commander" ] || NM="$MAIN_WT/node_modules"
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  # SBCHV1 operator note (a): commander must sit beside dist or every `things`
  # dies on ERR_MODULE_NOT_FOUND and it surfaces much later as "the GUI vector
  # is off". The version print below is the check that it did not.
  scpO -r "$NM/commander" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1

  # The sidecar the CELLS drive directly, extracted from the BUILT bundle: the
  # probe must exercise the shipped bytes, not a copy that could drift.
  node -e "import('./dist/write/vectors/ui-observer.js').then(m => process.stdout.write(m.OBSERVER_PY))" > "$OUT/ax-observer.py"
  python3 -m py_compile "$OUT/ax-observer.py" || { note "FATAL: extracted sidecar does not compile"; exit 1; }
  scpO "$OUT/ax-observer.py" "admin@$IP:/Users/admin/labh/ax-observer.py" >/dev/null
  # AND ON THE GUEST'S OWN INTERPRETER. macOS 15 ships python 3.9.6; a
  # development Mac runs something years newer, so a host-side compile check
  # cannot see a 3.10-only spelling. This is the one that matters, because 3.9
  # is what every shipped Mac has.
  GC=$(lab_ssh "$IP" '/usr/bin/python3 -m py_compile ~/labh/ax-observer.py 2>&1 && /usr/bin/python3 -V' </dev/null 2>&1)
  note "guest compile: $GC"
  case "$GC" in Python*) ;; *) note "FATAL: the sidecar does not compile on the guest interpreter"; exit 1 ;; esac
  note "shipped dist + sidecar ($(wc -c <"$OUT/ax-observer.py" | tr -d ' ') bytes); cli: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1 | tail -1)"
  exit 0
fi

# ===================================================================== spawn
# THE PRODUCTION-SHAPE DECISION, MEASURED (the brief's own instruction: decide
# by measuring spawn cost against the settle it replaces).
if [ "$CMD" = "spawn" ]; then
  load_session
  note "=============================================================="
  note "SPAWN — what each candidate shape costs"
  warm; front Things3
  PID=$(things_pid); note "  Things pid: $PID"

  note "  --- (a) one bare osascript spawn (the per-settle-helper baseline) ---"
  note "  $(lab_ssh "$IP" 'python3 - <<PY
import subprocess, time
ts=[]
for _ in range(5):
    t=time.perf_counter(); subprocess.run(["/usr/bin/osascript","-e","return 1"],capture_output=True); ts.append((time.perf_counter()-t)*1000)
print("osascript spawn ms:", " ".join("%.1f"%t for t in sorted(ts)), "median %.1f"%sorted(ts)[2])
PY' </dev/null 2>&1)"

  note "  --- (b) one bare python3 spawn ---"
  note "  $(lab_ssh "$IP" 'python3 - <<PY
import subprocess, time
ts=[]
for _ in range(5):
    t=time.perf_counter(); subprocess.run(["/usr/bin/python3","-c","import ctypes"],capture_output=True); ts.append((time.perf_counter()-t)*1000)
print("python3 spawn ms:", " ".join("%.1f"%t for t in sorted(ts)), "median %.1f"%sorted(ts)[2])
PY' </dev/null 2>&1)"

  note "  --- (c) arming the sidecar: spawn -> socket answers hello ---"
  for _ in 1 2 3; do
    T0=$(date +%s%N)
    if arm 60000 45000; then
      T1=$(date +%s%N)
      note "  arm ms: $(( (T1 - T0) / 1000000 ))   hello: $(obs hello)"
    else
      note "  arm FAILED — log: $(lab_ssh "$IP" 'tail -3 ~/labh/observer.log' </dev/null 2>&1)"
    fi
    disarm
  done

  note "  --- (d) ONE settle against a live sidecar, both transports ---"
  arm 60000 45000 || { note "  FATAL: cannot arm"; exit 1; }
  # Written to the guest as files: the two transports nest shell inside
  # AppleScript inside ssh, and measuring them is not worth guessing at quoting.
  lab_ssh "$IP" 'cat > ~/labh/t-node.py' <<PYEOF
import socket, time
ts = []
for _ in range(10):
    t = time.perf_counter()
    s = socket.socket(socket.AF_UNIX)
    s.connect("$SOCK")
    s.sendall(b"$TOK mark\n")
    s.recv(256)
    s.close()
    ts.append((time.perf_counter() - t) * 1000)
ts.sort()
print("socket mark ms: median %.2f  max %.2f" % (ts[len(ts) // 2], ts[-1]))
PYEOF
  note "  node-side round-trip (what a cross-hop settle pays):"
  note "  $(lab_ssh "$IP" '/usr/bin/python3 ~/labh/t-node.py' </dev/null 2>&1)"

  # The SHIPPED in-hop client's exact shape: one osascript hop whose script does
  # `tell current application to do shell script "printf … | nc -U …"`.
  lab_ssh "$IP" 'cat > ~/labh/t-hop.applescript' <<ASEOF
set payload to "$TOK mark"
set shellCmd to "/usr/bin/printf '%s\n' " & quoted form of payload & " | /usr/bin/nc -U -w 5 " & quoted form of "$SOCK"
tell current application to return do shell script shellCmd
ASEOF
  lab_ssh "$IP" 'cat > ~/labh/t-hop.py' <<'PYEOF'
import subprocess, time
ts = []
for _ in range(5):
    t = time.perf_counter()
    r = subprocess.run(["/usr/bin/osascript", "/Users/admin/labh/t-hop.applescript"],
                       capture_output=True, text=True)
    ts.append((time.perf_counter() - t) * 1000)
ts.sort()
print("osascript+nc mark ms: median %.1f  max %.1f  reply=%r" % (ts[len(ts) // 2], ts[-1], r.stdout.strip()))
PYEOF
  note "  in-hop transport (one osascript hop, printf | nc -U):"
  note "  $(lab_ssh "$IP" '/usr/bin/python3 ~/labh/t-hop.py' </dev/null 2>&1)"
  disarm
  note "SPAWN done"
  exit 0
fi

# ==================================================================== appreg
# THE DESIGN'S LOAD-BEARING ASSUMPTION: the sidecar registers on the APPLICATION
# element ONLY, once, for the whole drive. That is sound only if the app element
# receives what its DESCENDANTS post. VOPAT1 saw AXValueChanged arrive tagged
# AXScrollBar and AXImage from a registration naming neither, which is strong
# evidence; this cell makes it the campaign's own measurement, against the
# SHIPPED sidecar and the three surfaces the drive touches.
if [ "$CMD" = "appreg" ]; then
  load_session
  note "=============================================================="
  note "APPREG — does app-element registration catch what descendants post?"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset; ~/labh/beep-sentinel.sh mark "appreg"' </dev/null >/dev/null
  warm; front Things3
  add "VOPAT2%20appreg"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='VOPAT2 appreg' AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  arm 120000 90000 || { note "FATAL: cannot arm"; exit 1; }
  note "  hello: $(obs hello)"

  note "  --- (a) three idle seconds: is the app silent? (VOPAT1-6) ---"
  S=$(obs mark); sleep 3
  note "  idle: mark=$S now=$(obs mark)   (equal == silent)"

  note "  --- (b) the sidebar scroll bar: AXValueChanged on an AXScrollBar ---"
  # An UNSEEDED golden sidebar may not scroll at all, so the WRITE's own result
  # is printed first: a settle law must never be read off an actuation that did
  # not happen (VOPAT1 operator note b, from the other direction).
  note "  scroll bars in the window: $(axq 'tell application "System Events" to tell process "Things3" to return (count of scroll bars of scroll area 1 of (first window whose subrole is "AXStandardWindow"))')"
  note "  bar value before: $(axq 'tell application "System Events" to tell process "Things3" to return value of scroll bar 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")')"
  S=$(obs mark | sed 's/.*seq=//')
  ( lab_ssh "$IP" "sleep 0.4; osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set value of scroll bar 1 of scroll area 1 of (first window whose subrole is \"AXStandardWindow\") to 0.4'" </dev/null >>"$OUT/scrollwrite.txt" 2>&1 & )
  note "  await: $(obs await since="$S" want=AXValueChanged:AXScrollBar timeout=4000)"
  note "  any AXValueChanged at all: $(obs await since="$S" want=AXValueChanged timeout=800)"
  note "  bar value after:  $(axq 'tell application "System Events" to tell process "Things3" to return value of scroll bar 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")')"
  note "  write said: $(tail -2 "$OUT/scrollwrite.txt" 2>/dev/null | tr '\n' ' ')"
  lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set value of scroll bar 1 of scroll area 1 of (first window whose subrole is \"AXStandardWindow\") to 0'" </dev/null >/dev/null 2>&1

  note "  --- (c) the Repeat sheet: AXSheetCreated ---"
  lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 3" </dev/null
  front Things3
  S=$(obs mark | sed 's/.*seq=//')
  ( lab_ssh "$IP" "sleep 0.4; osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"Repeat…\" of menu \"Items\" of menu bar 1'" </dev/null >/dev/null 2>&1 & )
  note "  $(obs await since="$S" want=AXSheetCreated,AXCreated:AXSheet,AXWindowCreated timeout=9000)"
  sleep 1

  note "  --- (d) the frequency pop-up: AXMenuOpened on an AXMenu ---"
  S=$(obs mark | sed 's/.*seq=//')
  ( lab_ssh "$IP" "sleep 0.4; osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click pop up button 1 of sheet 1 of (first window whose subrole is \"AXStandardWindow\")'" </dev/null >/dev/null 2>&1 & )
  note "  $(obs await since="$S" want=AXMenuOpened timeout=4000)"

  note "  --- (e) the selection: AXValueChanged on the AXPopUpButton it set ---"
  S=$(obs mark | sed 's/.*seq=//')
  ( lab_ssh "$IP" "sleep 0.4; osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"monthly\" of menu 1 of pop up button 1 of sheet 1 of (first window whose subrole is \"AXStandardWindow\")'" </dev/null >/dev/null 2>&1 & )
  note "  value:    $(obs await since="$S" want=AXValueChanged:AXPopUpButton timeout=4000 quiet=80)"
  note "  +burst:   $(obs await since="$S" want=AXValueChanged:AXPopUpButton require=AXValueChanged:AXPopUpButton,AXUIElementDestroyed timeout=2000)"

  note "  --- (f) LAYOUT: the class that never fires (VOPAT1-12) ---"
  note "  $(obs await since=0 want=AXLayoutChanged timeout=1200)"

  note "  --- closing the sheet without committing ---"
  dismiss; dismiss
  note "  rule left behind (expect 0): $(gq "SELECT COUNT(*) FROM TMTask WHERE uuid='$U' AND rt1_recurrenceRule IS NOT NULL")"
  disarm
  lab_ssh "$IP" 'THINGS_LAB_BEEPS_OK=1 ~/labh/beep-sentinel.sh assert --json ~/labh/beeps-appreg.json --name vopat2-appreg' </dev/null >"$OUT/beeps-appreg.txt" 2>&1
  note "BEEPS(appreg): $(tail -6 "$OUT/beeps-appreg.txt" | tr '\n' ' ')"
  note "APPREG done"
  exit 0
fi

# =================================================================== sidecar
# THE LIFETIME. An observing process that outlives what it observed is a bug, so
# every bounded exit is asserted here rather than reasoned about.
if [ "$CMD" = "sidecar" ]; then
  load_session
  note "=============================================================="
  note "SIDECAR — handshake, authority, and every bounded exit"
  warm; front Things3
  note "  stray sidecars before: [$(sidecar_pids)] (expect empty)"

  note "  --- (a) handshake + authority ---"
  arm 120000 90000 || { note "FATAL: cannot arm"; exit 1; }
  note "  hello:        $(obs hello)"
  note "  wrong token:  $(lab_ssh "$IP" "/usr/bin/printf '%s\\n' 'not-the-token mark' | /usr/bin/nc -U -w 5 $SOCK" </dev/null 2>&1)"
  note "  unknown op:   $(obs frobnicate)"
  note "  no matcher:   $(obs await since=0 timeout=100)"
  note "  socket mode:  $(lab_ssh "$IP" "stat -f '%Sp %Su' $SOCK" </dev/null 2>&1)"

  note "  --- (b) explicit stop reaps the process and unlinks the socket ---"
  note "  stop: $(obs stop)"
  sleep 2
  note "  sidecars after stop: [$(sidecar_pids)] (expect empty)"
  note "  socket after stop:   $(lab_ssh "$IP" "test -e $SOCK && echo PRESENT || echo GONE" </dev/null)"

  note "  --- (c) TTL reaps a sidecar nobody stops ---"
  arm 4000 90000 || note "  arm(short TTL) failed"
  note "  alive at t+1s: [$(sidecar_pids)]"
  sleep 6
  note "  alive at t+7s: [$(sidecar_pids)] (expect empty — TTL 4s)"
  note "  socket:        $(lab_ssh "$IP" "test -e $SOCK && echo PRESENT || echo GONE" </dev/null)"

  note "  --- (d) the IDLE timeout reaps one nobody talks to ---"
  arm 120000 3000 || note "  arm(short idle) failed"
  sleep 7
  note "  alive after 7s idle (idle-ms 3000): [$(sidecar_pids)] (expect empty)"

  note "  --- (e) the availability gate the shipped code uses ---"
  note "  xcode-select -p: $(lab_ssh "$IP" 'xcode-select -p 2>&1; echo exit=$?' </dev/null | tr '\n' ' ')"
  note "  ctypes import:   $(lab_ssh "$IP" '/usr/bin/python3 -c "import ctypes,socketserver" 2>&1; echo exit=$?' </dev/null | tr '\n' ' ')"

  note "  --- (f) no consent dialog, no extra window (permissions doctrine) ---"
  note "  window census: $(lab_ssh "$IP" "$CLI doctor --ui-state --json" </dev/null 2>/dev/null | tail -1 | head -c 300)"
  note "SIDECAR done"
  exit 0
fi

# ==================================================================== states
# THE STATE MATRIX, exactly as RDLAT2 §9 certified it: every dialog state the
# shape manifest describes, driven end to end through the production CLI against
# the guest SQLite oracle. TAG=obs (sidecar live) or TAG=poll (observer off).
if [ "$CMD" = "states" ]; then
  load_session
  TAG="${TAG:-obs}"
  case "$TAG" in obs) OBSENV="" ;; poll) OBSENV="THINGS_API_AX_OBSERVER=0" ;; *) echo "TAG must be obs|poll" >&2; exit 1 ;; esac
  cli() { lab_ssh "$IP" "$LAB_DIRECT $OBSENV $CLI $*" </dev/null; }
  note "=============================================================="
  note "STATES ($TAG) start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  # UNIQUE PER RUN. A fixed prefix made a re-run's `tmpl s1` resolve the PREVIOUS
  # run's template (which S4 had already rescheduled), so the rule the report
  # printed was not the rule the drive had just landed. The drives were fine; the
  # ORACLE was reading the wrong row, which is the kind of thing that quietly
  # certifies nothing.
  P="VOPAT2S-$TAG-$$"

  seed() { add "${P}%20$1"; gq "SELECT uuid FROM TMTask WHERE title='$P $1' AND type=0 AND rt1_recurrenceRule IS NULL AND trashed=0 ORDER BY rowid DESC LIMIT 1"; }
  tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$P $1' AND rt1_recurrenceRule IS NOT NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
  rule() { gq "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'"; }

  # (1) FIXED — the "Every" label row with the monthly cadence group.
  lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'S1 fixed'" </dev/null >/dev/null
  warm; front Things3
  S1=$(seed s1); note "  S1 seed=$S1"
  cli todo make-repeating "$S1" --frequency monthly --interval 2 --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/st1-$TAG.json" 2>&1
  note "  S1 exit=$? out: $(head -c 400 "$OUT/st1-$TAG.json")"
  note "  S1 rule: $(rule "$(tmpl s1)")"
  dismiss

  # (2) AFTER COMPLETION — the one-field group that falls to the uniqueness rule.
  lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'S2 after-completion'" </dev/null >/dev/null
  warm; front Things3
  S2=$(seed s2); note "  S2 seed=$S2"
  cli todo make-repeating "$S2" --frequency weekly --interval 3 --after-completion --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/st2-$TAG.json" 2>&1
  note "  S2 exit=$? out: $(head -c 400 "$OUT/st2-$TAG.json")"
  note "  S2 rule: $(rule "$(tmpl s2)")"
  dismiss

  # (3) DEADLINES — the #646 shape (the checkbox mints a shell-level field).
  lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'S3 deadlines'" </dev/null >/dev/null
  warm; front Things3
  S3=$(seed s3); note "  S3 seed=$S3"
  cli todo make-repeating "$S3" --frequency weekly --interval 1 --deadline --start-days-earlier 2 --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/st3-$TAG.json" 2>&1
  note "  S3 exit=$? out: $(head -c 400 "$OUT/st3-$TAG.json")"
  note "  S3 rule: $(rule "$(tmpl s3)")  deadline: $(gq "SELECT deadline FROM TMTask WHERE uuid='$(tmpl s3)'")"
  dismiss

  # (4) ENDS-COUNT — HXPC1: the ends bound INSERTS a field ahead of the interval.
  lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'S4 ends-count'" </dev/null >/dev/null
  warm; front Things3
  T1=$(tmpl s1); note "  S4 target=$T1"
  cli todo reschedule-repeat "$T1" --frequency daily --interval 3 --ends-after 4 --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/st4-$TAG.json" 2>&1
  note "  S4 exit=$? out: $(head -c 400 "$OUT/st4-$TAG.json")"
  note "  S4 rule: $(rule "$T1")"
  dismiss

  # (5) PAUSED — the pause/resume pair through a different menu path.
  lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'S5 paused'" </dev/null >/dev/null
  warm; front Things3
  cli todo pause-repeat "$T1" --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/st5-$TAG.json" 2>&1
  note "  S5 pause exit=$? out: $(head -c 300 "$OUT/st5-$TAG.json")"
  note "  S5 rule after pause: $(rule "$T1")"
  cli todo resume-repeat "$T1" --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/st5b-$TAG.json" 2>&1
  note "  S5 resume exit=$? out: $(head -c 300 "$OUT/st5b-$TAG.json")"
  note "  S5 rule after resume: $(rule "$T1")"
  dismiss

  note "  stray sidecars after the matrix: [$(sidecar_pids)] (expect empty)"
  lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/labh/beep-sentinel.sh assert --json ~/labh/beeps-states-$TAG.json --name vopat2-states-$TAG" </dev/null >"$OUT/beeps-states-$TAG.txt" 2>&1
  note "BEEPS(states $TAG): $(tail -8 "$OUT/beeps-states-$TAG.txt" | tr '\n' ' ')"
  note "STATES ($TAG) done $(date +%H:%M:%S)"
  exit 0
fi

# ===================================================================== cells
# The guard cells the change must not have weakened (FGRD1 U/C2/S/T + MODALX1 X).
if [ "$CMD" = "cells" ]; then
  load_session
  TAG="${TAG:-obs}"
  case "$TAG" in obs) OBSENV="" ;; poll) OBSENV="THINGS_API_AX_OBSERVER=0" ;; *) echo "TAG must be obs|poll" >&2; exit 1 ;; esac
  cli() { lab_ssh "$IP" "$LAB_DIRECT $OBSENV $CLI $*" </dev/null; }
  note "=============================================================="
  note "CELLS ($TAG) start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null

  cdismiss() { dismiss; note "  dismiss → $(cli doctor --ui-state --json 2>/dev/null | tail -1 | head -c 200)"; }

  P="VOPAT2C-$TAG-$$"
  add "${P}%20alpha"; add "${P}%20bravo"; add "${P}%20charlie"; add "${P}%20delta"
  ALPHA=$(gq "SELECT uuid FROM TMTask WHERE title='$P alpha' AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  BRAVO=$(gq "SELECT uuid FROM TMTask WHERE title='$P bravo' AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  CHARLIE=$(gq "SELECT uuid FROM TMTask WHERE title='$P charlie' AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  DELTA=$(gq "SELECT uuid FROM TMTask WHERE title='$P delta' AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  note "fixtures: alpha=$ALPHA bravo=$BRAVO charlie=$CHARLIE delta=$DELTA"

  # U: the census 2x2 — a change to what the driver READS needs a cell that
  #    reads it back (RDLAT2's census law).
  lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'U ui-state'" </dev/null >/dev/null
  warm; front Things3
  note "U1 (no dialog, Things frontmost): $(cli doctor --ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  front Finder
  note "U2 (no dialog, Finder frontmost): $(cli doctor --ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$ALPHA'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  note "U3 (Repeat dialog open, Things frontmost): $(cli doctor --ui-state --json 2>/dev/null | tail -1 | head -c 300)"
  front Finder
  note "U4 (Repeat dialog open, Finder frontmost): $(cli doctor --ui-state --json 2>/dev/null | tail -1 | head -c 300)"

  # C2: a drive started with a STRANDED dialog refuses and commits nothing.
  lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'C cleanup'" </dev/null >/dev/null
  cli todo make-repeating "$BRAVO" --frequency weekly --interval 2 --dangerously-drive-gui --verify-timeout 60000 --json >"$OUT/c2-$TAG.json" 2>"$OUT/c2-$TAG.err"
  note "C2 exit=$? stdout: $(head -c 500 "$OUT/c2-$TAG.json")"
  note "C2 stderr: $(head -c 700 "$OUT/c2-$TAG.err")"
  note "C2 bravo repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='$P bravo' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
  cdismiss

  # S: an already-set rule discloses the skip and types nothing.
  lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'S skip'" </dev/null >/dev/null
  warm; front Things3
  cli todo make-repeating "$ALPHA" --frequency daily --interval 1 --after-completion --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/s1-$TAG.json" 2>&1
  note "S1 exit=$? out: $(head -c 700 "$OUT/s1-$TAG.json")"
  note "S1 template? $(gq "SELECT count(*) FROM TMTask WHERE title='$P alpha' AND rt1_recurrenceRule IS NOT NULL") (expect 1)"
  cdismiss

  # T: focus theft mid-drive REFUSES with nothing typed — and the wording must
  #    be the wording it always had, sidecar or not.
  lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'T theft'" </dev/null >/dev/null
  lab_ssh "$IP" 'cat > ~/labh/theft.sh && chmod +x ~/labh/theft.sh' <<EOF
#!/bin/bash
CLI="\$HOME/things-lab/bin/node \$HOME/things-lab/things-api/dist/cli/main.js"
export THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1 ${OBSENV:+$OBSENV}
\$CLI todo make-repeating "\$1" --frequency weekly --interval 3 --dangerously-drive-gui \\
  --verify-timeout 60000 --json >"\$HOME/labh/theft-out.json" 2>"\$HOME/labh/theft-err.txt" &
DRIVE=\$!
SAW=no
for _ in \$(seq 1 400); do
  OPEN=\$(osascript -e 'tell application "System Events" to tell process "Things3" to return ((exists sheet 1 of (first window whose subrole is "AXStandardWindow")) or ((count of (windows whose subrole is "AXUnknown" and size is not {40, 40})) > 0))' 2>/dev/null)
  if [ "\$OPEN" = "true" ]; then SAW=yes; break; fi
  sleep 0.1
done
osascript -e 'tell application "Finder" to activate' >/dev/null 2>&1
echo "sheet-seen=\$SAW"
wait \$DRIVE
echo "drive-exit=\$?"
EOF
  warm; front Things3
  note "T1 $(lab_ssh "$IP" "~/labh/theft.sh $CHARLIE" </dev/null 2>&1 | tr '\n' ' ')"
  note "T1 stdout: $(lab_ssh "$IP" 'head -c 900 ~/labh/theft-out.json' </dev/null)"
  note "T1 stderr: $(lab_ssh "$IP" 'head -c 900 ~/labh/theft-err.txt' </dev/null)"
  note "T1 charlie repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='$P charlie' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
  cdismiss

  # X: the MODALX1 open-dialog preflight refuses before anything is pressed.
  lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'X preflight'" </dev/null >/dev/null
  warm; front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$DELTA'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  cli todo make-repeating "$DELTA" --frequency weekly --interval 2 --dangerously-drive-gui --verify-timeout 60000 --json >"$OUT/x1-$TAG.json" 2>"$OUT/x1-$TAG.err"
  note "X1 exit=$? stderr: $(head -c 600 "$OUT/x1-$TAG.err")"
  note "X1 delta repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='$P delta' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
  cdismiss

  # chord: the shared dispatch seam is unmoved (#606 family).
  lab_ssh "$IP" "~/labh/beep-sentinel.sh mark 'chord reorder'" </dev/null >/dev/null
  PRJ="VOPAT2 chord $TAG"
  cli project add "'$PRJ'" --json >"$OUT/chord-proj-$TAG.json" 2>&1
  PU=$(gq "SELECT uuid FROM TMTask WHERE title='$PRJ' AND type=1 AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  for h in Alpha Bravo Charlie; do cli project add-heading "$PU" "'$h'" --json >/dev/null 2>&1; done
  note "  headings before: $(gq "SELECT group_concat(title,' | ') FROM (SELECT title FROM TMTask WHERE project='$PU' AND type=2 AND trashed=0 ORDER BY \"index\")")"
  cli project move-heading "$PU" "'Charlie'" --first --dangerously-drive-gui --json >"$OUT/chord-$TAG.json" 2>&1
  note "  move exit=$? out: $(head -c 400 "$OUT/chord-$TAG.json")"
  note "  headings after:  $(gq "SELECT group_concat(title,' | ') FROM (SELECT title FROM TMTask WHERE project='$PU' AND type=2 AND trashed=0 ORDER BY \"index\")")"

  note "  stray sidecars after the cells: [$(sidecar_pids)] (expect empty)"
  lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/labh/beep-sentinel.sh assert --json ~/labh/beeps-cells-$TAG.json --name vopat2-cells-$TAG" </dev/null >"$OUT/beeps-cells-$TAG.txt" 2>&1
  note "BEEPS(cells $TAG): $(tail -8 "$OUT/beeps-cells-$TAG.txt" | tr '\n' ' ')"
  note "CELLS ($TAG) done $(date +%H:%M:%S)"
  exit 0
fi

# ==================================================================== census
# THE CENSUS LAW (RDLAT2): a change to what the driver READS is certified by a
# cell that PRINTS the census in every quadrant, never by the drives that ride
# it. The settle records travel on the same stderr channel as the focus guard's
# census log (`#AXSETTLE` beside `#FGCENSUS`) and are stripped by the same seam,
# so "the census still reads identically" is exactly the property at risk.
if [ "$CMD" = "census" ]; then
  load_session
  TAG="${TAG:-obs}"
  case "$TAG" in obs) OBSENV="" ;; poll) OBSENV="THINGS_API_AX_OBSERVER=0" ;; esac
  note "=============================================================="
  note "CENSUS ($TAG) — the 2x2, printed in full"
  ui() { lab_ssh "$IP" "$LAB_DIRECT $OBSENV $CLI doctor --ui-state --json" </dev/null 2>/dev/null \
    | tail -1 | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]["uiState"]; print(json.dumps({k:d[k] for k in sorted(d)}))' 2>/dev/null; }
  warm; front Things3
  add "VOPAT2%20census-$TAG"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='VOPAT2 census-$TAG' AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  note "  Q1 no dialog / Things front : $(ui)"
  front Finder
  note "  Q2 no dialog / Finder front : $(ui)"
  front Things3
  lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 3" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  note "  Q3 dialog open / Things front: $(ui)"
  front Finder
  note "  Q4 dialog open / Finder front: $(ui)"
  dismiss; dismiss
  note "CENSUS ($TAG) done"
  exit 0
fi

# ===================================================================== trace
# THE PER-HOP RECORD, both ways: durationMs + axOps + axElems + the notification
# awaited and its latency. The counts are what transfer to the field; the
# notification latencies are the app's own time, which is the floor.
if [ "$CMD" = "trace" ]; then
  load_session
  TAG="${TAG:-obs}"
  case "$TAG" in obs) OBSENV="" ;; poll) OBSENV="THINGS_API_AX_OBSERVER=0" ;; esac
  note "=============================================================="
  note "TRACE ($TAG) — the field's own command shape, hop by hop"
  warm; front Things3
  P="VOPAT2T-$TAG-$$"
  # SHAPE=next needs a SCHEDULED to-do: `make-repeating` defaults its first
  # occurrence to the item's own scheduled date (`--when`, repeat-flags.ts), and
  # that default is what makes the `Next:` pop-up, the shape probe and the
  # occurrence settle part of EVERY real drive — which is the field's 10.5 s
  # command, not an exotic one.
  if [ "${SHAPE:-field}" = "next" ]; then
    lab_ssh "$IP" "open -g 'things:///add?title=${P}%20t1&when=today'; sleep 2" </dev/null
  else
    add "${P}%20t1"
  fi
  U=$(gq "SELECT uuid FROM TMTask WHERE title='$P t1' AND trashed=0 ORDER BY rowid DESC LIMIT 1")
  lab_ssh "$IP" 'rm -rf ~/.local/state/things-api/trace' </dev/null
  # SHAPE=field is the maintainer's own command (the interval field already holds
  # 1, so the read-back-first skip applies and NOTHING is typed). SHAPE=types is
  # the shape that exercises the typing loop's two settles, which is where the
  # fixed delays live — the two shapes answer different questions and both are
  # traced.
  case "${SHAPE:-field}" in
    field) ARGS="--frequency monthly --interval 1 --after-completion" ;;
    types) ARGS="--frequency monthly --interval 3" ;;
    next) ARGS="--frequency weekly --interval 1" ;;
    *) echo "SHAPE must be field|types|next" >&2; exit 1 ;;
  esac
  note "  shape: ${SHAPE:-field} ($ARGS)"
  lab_ssh "$IP" "$LAB_DIRECT $OBSENV THINGS_API_TRACE=1 THINGS_API_AX_COUNT=1 $CLI todo make-repeating $U $ARGS --dangerously-drive-gui --verify-timeout 90000 --json" </dev/null >"$OUT/trace-$TAG.json" 2>&1
  note "  exit=$? out: $(head -c 400 "$OUT/trace-$TAG.json")"
  lab_ssh "$IP" 'cat ~/.local/state/things-api/trace/*.jsonl' </dev/null >"$OUT/trace/trace-${SHAPE:-field}-$TAG.jsonl" 2>/dev/null
  note "  trace lines: $(wc -l <"$OUT/trace/trace-${SHAPE:-field}-$TAG.jsonl" | tr -d ' ')"
  python3 - "$OUT/trace/trace-${SHAPE:-field}-$TAG.jsonl" "$TAG" <<'PY' | tee -a "$REPORT"
import json, sys
path, tag = sys.argv[1], sys.argv[2]
hops, settles, obs = [], [], []
for line in open(path):
    line = line.strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
    except ValueError:
        continue
    if rec.get("phase") == "ui-dispatch" and rec.get("event") == "end":
        hops.append(rec)
    if rec.get("phase") == "ui-settle":
        settles.append(rec)
    if rec.get("phase") == "ui-observer":
        obs.append(rec)
print("[vopat2]   observer records: " + "; ".join("%s %s" % (r.get("event"), r.get("why") or r.get("registered") or "") for r in obs))
print("[vopat2]   %-46s %7s %6s %6s  %s" % ("hop", "ms", "axOps", "elems", "settles"))
tot = ops = els = 0
for h in hops:
    tot += h.get("durationMs", 0) or 0
    ops += h.get("axOps", 0) or 0
    els += h.get("axElems", 0) or 0
    print("[vopat2]   %-46s %7s %6s %6s  %s" % (
        (h.get("label") or "")[:46], h.get("durationMs"), h.get("axOps", "-"),
        h.get("axElems", "-"), " | ".join(h.get("settles", []))[:110]))
print("[vopat2]   TOTAL hops=%d ms=%d axOps=%s axElems=%s" % (len(hops), tot, ops, els))
for s in settles:
    print("[vopat2]   settle(node): %s" % json.dumps(s))
PY
  dismiss
  note "  rule: $(gq "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE title='$P t1' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")"
  note "TRACE ($TAG) done"
  exit 0
fi

# ================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "=== teardown — destroying $VM ==="
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  rm -f "$SESSION"
  note "  remaining VMs: $(tart list | tail -n +2 | awk '{print $2}' | tr '\n' ' ')"
  exit 0
fi

echo "usage: $0 {setup|ship|spawn|appreg|sidecar|states|cells|census|trace|teardown}" >&2
exit 2
