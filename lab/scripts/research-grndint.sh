#!/bin/bash
# GRNDINT — grand-interleave o-suite certification ground-truth + the
# reschedule-bounce rider (PR 2 of the template-sort arc). Full write-up:
# docs/lab/grndint-grand-interleave.md (authored from this capture).
#
# Subcommand-driven; ONE disposable clone `grndint-lab` of golden-v2 lives
# across phases (explicit teardown). golden-v2 bakes the AX grant, so the
# CLI/day-scope capture needs NO VNC; only the `rider` phase drives the UI.
#
#   research-grndint.sh setup      clone golden-v2 + boot(--vnc-experimental) + airgap + clock-pin + ship bundle
#   research-grndint.sh gt0706     seed the 07-06 grand-interleave fixture + capture real `things reorder` ground truth
#   research-grndint.sh gt0712     seed the 07-12 project-template suffix accept/refuse + experimental-off capture
#   research-grndint.sh rider      UIC1 reschedule-bounce two-fact rider (VNC Repeat dialog)
#   research-grndint.sh teardown   stop + delete the clone
#
# Rails: comma-text wires only; PID-watch template wires; NEVER the host DB;
# poll-in-place waits; worktree only.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

GOLDEN="things-lab-golden-v2"
VM="grndint-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[grndint] $*" | tee -a "$REPORT"; }

CMD="${1:-}"

load_session() {
  [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }
  source "$SESSION"
}
gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gqt() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
G()   { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
url() { lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; }
relaunch() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 3; open -g -a Things3; sleep 9' </dev/null; }

# uuid of a task by title (first match)
uuidof() { gq "SELECT uuid FROM TMTask WHERE title='$1' LIMIT 1"; }

# ================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
  # airgap (delete default route) + verify unroutable
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  # pin clock 07-05 12:00 BEFORE Things launches
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
  echo "IP=$IP" > "$SESSION"; echo "VNC_URL=$VNC_URL" >> "$SESSION"

  # read-only guest SQLite helper
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

  # warm-up launch so Today buckets + repeat instances recompute for 07-05
  note "warm-up launch"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\''; sleep 3' </dev/null

  # schema fingerprint sanity
  note "schema fingerprint: $(gq 'SELECT COUNT(*) FROM TMTask') tasks; templates: $(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL OR repeater IS NOT NULL")"
  note "baked templates:"
  gqt "SELECT title, type, rt1_nextInstanceStartDate AS proj, todayIndex FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL OR repeater IS NOT NULL" | tee -a "$REPORT"

  # ship node + dist + commander (guest e2e bundle)
  note "building + shipping guest bundle"
  npm run build >/dev/null
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/dist"
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  # relaunch so the app is live for URL/AS writes
  relaunch
  note "config (allow-experimental default):"
  G config get allow-experimental 2>&1 | tee -a "$REPORT"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ================================================================ rebundle
if [ "$CMD" = "rebundle" ]; then
  load_session
  npm run build >/dev/null || exit 1
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O -r dist "admin@$IP:/Users/admin/things-lab/things-api/dist"
  note "rebundled"
  exit 0
fi

# ================================================================ teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown DONE ($VM stopped + deleted)"
  exit 0
fi

echo "unknown subcommand: $CMD" >&2
exit 1
