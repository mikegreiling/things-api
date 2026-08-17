#!/bin/bash
# APPRUN1 — launch-readiness law + closed-app auto-launch certification (issue #486).
#
# The report: with Things quit, `todo complete <uuid> --json` returns
# verify-failed:silent-noop (exit 3) — the write was dispatched into a not-running
# app and nothing landed. This campaign MEASURES what "ready to land a URL write"
# means after a background launch (the drop window + which signal coincides), then
# CERTIFIES the shipped behavior end-to-end through the production CLI:
#   (a) app quit + write  → auto-launch, readiness wait, write lands, ok + warning
#   (b) auto-launch off   → clean `blocked` (environment), ZERO dispatch, app stays quit
#   (d) launched app stays BACKGROUNDED (open -g; no window/focus steal)
#
# METHOD: ONE disposable clone of things-lab-golden-v3 (Things 3.22.14 — the
# reported version). Airgap (default route deleted), pin clock 2026-07-05 12:00
# before Things launches. Ship the PRODUCTION e2e bundle. Fixtures fully synthetic
# (APPRUN1-* titles). Ground truth = read-only guest SQLite. Teardown at the end.
# Write-up: docs/lab/apprun1-launch-readiness.md.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="apprun1-lab"
OUT="lab/artifacts/apprun1-lab"; mkdir -p "$OUT/drive"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[apprun1] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"
GOLDEN="${GOLDEN:-things-lab-golden-v3}"

# ---------------- preflight ----------------
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
node --version >/dev/null 2>&1 || { note "FATAL: no working node on PATH"; exit 1; }
note "toolchain: node $(node --version) @ $(command -v node)"
[ -d node_modules/commander ] || { note "npm ci…"; npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL npm ci"; exit 1; }; }

# ---------------- clone + boot ----------------
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
note "airgap: $AG"; [ "$AG" = "AIRGAP-OK" ] || { note "FATAL airgap"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

# ---------------- guest helpers ----------------
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# ---------------- build + ship production bundle ----------------
note "build + ship production bundle (HEAD of mg/486)"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL build"; exit 1; }
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node && ~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1 || { note "FATAL guest node"; exit 1; }
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
drive() { local l="$1"; shift; lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive/$l.log" 2>&1; cat "$OUT/drive/$l.log" | sed "s/^/  [$l] /" | tee -a "$REPORT"; }

TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
MVER=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
note "bundle shipped; Things $TVER / macOS $MVER / clock 2026-07-05"

warm() { lab_ssh "$IP" 'open -a Things3; sleep 12; osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
quit_app() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; for i in $(seq 1 30); do pgrep -x Things3 >/dev/null || break; sleep 0.5; done' </dev/null; }
running() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo RUNNING || echo DOWN' </dev/null; }

note "warm-up launch+quit for steady state"; warm

# ---------------- seed synthetic to-dos (app running) ----------------
note "seed: launch app, create synthetic APPRUN1-* to-dos via the production CLI"
lab_ssh "$IP" 'open -a Things3; sleep 10' </dev/null
for i in $(seq 1 15); do G todo add "APPRUN1-M-$i" >/dev/null 2>&1; done
G todo add "APPRUN1-A" >/dev/null 2>&1
G todo add "APPRUN1-B" >/dev/null 2>&1
sleep 3
: > "$OUT/uuids.txt"
for i in $(seq 1 15); do gq "SELECT uuid FROM TMTask WHERE title='APPRUN1-M-$i' AND trashed=0 LIMIT 1" >> "$OUT/uuids.txt"; done
UUID_A=$(gq "SELECT uuid FROM TMTask WHERE title='APPRUN1-A' AND trashed=0 LIMIT 1")
UUID_B=$(gq "SELECT uuid FROM TMTask WHERE title='APPRUN1-B' AND trashed=0 LIMIT 1")
NSEED=$(grep -c . "$OUT/uuids.txt")
note "seeded $NSEED measurement targets; A=$UUID_A B=$UUID_B"
[ "$NSEED" -ge 10 ] && [ -n "$UUID_A" ] && [ -n "$UUID_B" ] || { note "FATAL: seed incomplete"; exit 1; }

# ================= PHASE MEASURE: launch-readiness law =================
note "MEASURE: drop window + signal correlation (guest python, one clock)"
scpO "$OUT/uuids.txt" "admin@$IP:/Users/admin/labh/uuids.txt"
scpO lab/scripts/apprun1-measure.py "admin@$IP:/Users/admin/labh/apprun1-measure.py"
lab_ssh "$IP" 'cd ~/labh && python3 apprun1-measure.py uuids.txt measure.json' </dev/null | tee -a "$REPORT"
scpO "admin@$IP:/Users/admin/labh/measure.json" "$OUT/measure.json"
note "measurement pulled to $OUT/measure.json"
python3 - "$OUT/measure.json" <<'PY' | tee -a "$REPORT"
import json,sys
d=json.load(open(sys.argv[1]))
print("  [measure] first_landing_offset=%s s" % d["first_landing_offset"])
print("  [measure] signal_first_trip=%s" % json.dumps(d["signal_first_trip"]))
comp=[r["i"] for r in d["fired"] if r["completed"]]
drop=[r["i"] for r in d["fired"] if not r["completed"]]
print("  [measure] landed target idx=%s ; dropped idx=%s" % (comp, drop))
fe=set(x for x in d["frontmost_early"] if x)
print("  [measure] frontmost during launch window=%s" % sorted(fe))
PY

# ================= CELL A: auto-launch on (default) =================
note "CELL A: quit app, run production `todo complete APPRUN1-A --json` (auto-launch default)"
quit_app; note "  pre: app is $(running)"
drive cellA todo complete "$UUID_A" --json
A_STATUS=$(gq "SELECT status FROM TMTask WHERE uuid='$UUID_A'")
note "  CELL A: APPRUN1-A status=$A_STATUS (want 3=completed); app now $(running)"

# ================= CELL B: auto-launch off =================
note "CELL B: config set auto-launch false; quit app; complete APPRUN1-B (expect blocked, zero dispatch)"
G config set auto-launch false >/dev/null 2>&1
quit_app; note "  pre: app is $(running)"
drive cellB todo complete "$UUID_B" --json
B_STATUS=$(gq "SELECT status FROM TMTask WHERE uuid='$UUID_B'")
B_APP=$(running)
note "  CELL B: APPRUN1-B status=$B_STATUS (want 0=open, unchanged); app now $B_APP (want DOWN — zero dispatch/no launch)"
G config set auto-launch true >/dev/null 2>&1

# ---------------- verdicts ----------------
note "==== VERDICTS ===="
[ "$A_STATUS" = "3" ] && note "CELL A PASS: closed-app write auto-launched and LANDED" || note "CELL A FAIL: status=$A_STATUS"
{ [ "$B_STATUS" = "0" ] && [ "$B_APP" = "DOWN" ]; } && note "CELL B PASS: refused, zero dispatch, app stayed quit" || note "CELL B FAIL: status=$B_STATUS app=$B_APP"
note "done. artifacts in $OUT/"
