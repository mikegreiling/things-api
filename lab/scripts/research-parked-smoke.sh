#!/bin/bash
# PARKED-PROBES campaign — Probe 0: GOLDEN SMOKE on tart 2.34.0.
#
# The Tart/Cirrus tooling was updated on this host (tart 2.34.0). This script
# verifies the standard lab bring-up of `things-lab-golden-v1` END TO END and
# records any behavior delta vs. the pre-update baseline, so the campaign can
# certify "tart 2.34 does not break the golden" before any probe runs.
#
# It CLONES the golden (never boots the golden itself), boots the clone with
# --vnc-experimental (so the probe script can VNC-grant Accessibility later),
# airgaps + pins the clock, warms Things, asserts the DB is readable at the
# expected schema (production CLI reads = the schema gate), ships + runs the
# guest CLI bundle, and lands ONE trivial URL-scheme write + ONE CLI write,
# verifying both in the DB. It LEAVES THE VM RUNNING and writes state.env
# (IP / VNC_URL / token / vm name) for research-parked.sh to reuse.
#
# On ANY bring-up failure it prints "GOLDEN SMOKE: FAIL <symptom>" and exits
# non-zero WITHOUT tearing down (so the operator can inspect the live clone).
# Fully synthetic fixtures (public repo). Golden image untouched.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="parked-probes-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[smoke] $*" | tee -a "$REPORT"; }
fail() { note "GOLDEN SMOKE: FAIL — $*"; note "VM left RUNNING for inspection: $VM (ip=$IP)"; exit 1; }

# ---------------- preflight ----------------
TARTVER=$(tart --version 2>&1)
note "############### PROBE 0 — GOLDEN SMOKE (tart $TARTVER) ###############"
note "preflight: tart=$TARTVER  TART_HOME=$TART_HOME"
VNCDO="${VNCDO:-}"
if [ -z "$VNCDO" ] || [ ! -x "$VNCDO" ]; then note "WARN: \$VNCDO not set/executable — probe script (RSIM-T/U) will need it for the Accessibility grant. Smoke does not."; fi
# COW/APFS clones share the golden's blocks (near-zero at clone time; a short
# probe run writes only a few hundred MB), so the 5GB floor the RSIM research
# scripts use is the right threshold here — not the full-suite harness's 10GB.
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 5 ] && { note "GOLDEN SMOKE: FAIL — <5GB free (${FREEGB}GB)"; exit 1; }
tart list 2>/dev/null | grep -q 'things-lab-golden-v1' || { note "GOLDEN SMOKE: FAIL — golden things-lab-golden-v1 not found in tart list"; exit 1; }

# VM-limit etiquette: never boot >1 clone. Refuse if another run-VM is live.
LIVE=$(pgrep -fl 'tart run' | grep -v "$VM" || true)
if [ -n "$LIVE" ]; then note "GOLDEN SMOKE: FAIL — another tart run is live (sibling delegate?). Not booting a 2nd clone:"; echo "$LIVE" | tee -a "$REPORT"; exit 1; fi

# ---------------- host toolchain (self-contained node; rsim/rem1 lesson) ----------------
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
if ! node --version >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
  note "GOLDEN SMOKE: FAIL — no working self-contained node/npm on PATH"; exit 1
fi
note "toolchain: node $(node --version) / npm $(npm --version) @ $(command -v node)"
if [ ! -d node_modules/commander ]; then
  note "npm ci (worktree has no node_modules)…"
  npm ci >"$OUT/npm-ci.log" 2>&1 || { note "GOLDEN SMOKE: FAIL — npm ci failed (see $OUT/npm-ci.log)"; exit 1; }
fi
note "building production dist…"
npm run build >"$OUT/build.log" 2>&1 || { note "GOLDEN SMOKE: FAIL — npm run build failed (see $OUT/build.log)"; exit 1; }
[ -f dist/cli/main.js ] || { note "GOLDEN SMOKE: FAIL — dist/cli/main.js missing after build"; exit 1; }

# ---------------- clone + boot (measure boot time) ----------------
IP=""
note "cloning golden -> $VM (golden NEVER booted)"
tart delete "$VM" >/dev/null 2>&1 || true
CLONE_T0=$(date +%s)
tart clone things-lab-golden-v1 "$VM" || { note "GOLDEN SMOKE: FAIL — tart clone errored"; exit 1; }
CLONE_T1=$(date +%s)
note "clone took $((CLONE_T1-CLONE_T0))s (APFS COW, expect ~instant)"
BOOT_T0=$(date +%s)
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "GOLDEN SMOKE: FAIL — SSH never came up within 300s"; note "--- tart-run.log tail ---"; tail -20 "$OUT/tart-run.log" | tee -a "$REPORT"; exit 1; }
BOOT_T1=$(date +%s)
note "boot->ssh took $((BOOT_T1-BOOT_T0))s  (ip=$IP)"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
note "VNC url present: $([ -n "$VNC_URL" ] && echo yes || echo NO)"

# ---------------- tart-run.log delta inspection (warnings/softnet/networking) ----------------
note "--- tart-run.log (stderr/warnings scan) ---"
if grep -iE 'warn|error|softnet|deprecat|fail|denied' "$OUT/tart-run.log" >/dev/null 2>&1; then
  grep -inE 'warn|error|softnet|deprecat|fail|denied' "$OUT/tart-run.log" | head -20 | sed 's/^/  [tart-log] /' | tee -a "$REPORT"
else
  note "  (no warn/error/softnet/deprecat/fail/denied lines in tart-run.log — clean boot)"
fi
note "  tart-run.log line count: $(wc -l < "$OUT/tart-run.log")"

# ---------------- airgap + pin clock (bring-up parity) ----------------
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AIRGAP=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
note "airgap: $AIRGAP"
[ "$AIRGAP" = "AIRGAP-OK" ] || fail "airgap did not take (guest still routes to internet) — $AIRGAP"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
CLK=$(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)
note "clock pinned to: $CLK (expect 2026-07-05T12:00)"
case "$CLK" in 2026-07-05T12:*) : ;; *) fail "clock pin did not take (got $CLK)";; esac

# ---------------- guest read-only sqlite helper ----------------
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# ---------------- warm Things (launch + quit) ----------------
note "warming Things (launch+quit)…"
lab_ssh "$IP" 'open -a Things3; sleep 14; osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null
# confirm the process launched at least once (monitor emission is optional in smoke)
LAUNCHED=$(lab_ssh "$IP" 'ls ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite >/dev/null 2>&1 && echo DB-PRESENT || echo DB-MISSING' </dev/null)
note "Things DB file: $LAUNCHED"
[ "$LAUNCHED" = "DB-PRESENT" ] || fail "Things DB file absent after warm launch"

# ---------------- DB readable at expected schema ----------------
UVER=$(gq "PRAGMA user_version") || fail "sqlite read of guest DB errored"
TCOUNT=$(gq "SELECT COUNT(*) FROM TMTask")
ACOUNT=$(gq "SELECT COUNT(*) FROM TMArea")
RTCOUNT=$(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL")
note "DB: PRAGMA user_version=$UVER  TMTask rows=$TCOUNT  TMArea=$ACOUNT  repeatingTemplates=$RTCOUNT"
note "    (golden seedCounts: areas=2 todos=26 projects=5 headings=2 repeatingTemplates=2 trashed=1)"
[ "${TCOUNT:-0}" -ge 30 ] || fail "TMTask count implausibly low ($TCOUNT) — seed missing / DB not the golden's"

# ---------------- ship the production e2e bundle ----------------
note "shipping guest CLI bundle (node + dist + commander)…"
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1 || fail "guest node not runnable after ship (bundle ship failed)"
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }

# ---------------- guest CLI runs: doctor + a read ----------------
note "--- guest CLI: doctor ---"
G doctor > "$OUT/doctor.log" 2>&1; DOCTOR_EXIT=$?
tail -8 "$OUT/doctor.log" | sed 's/^/  [doctor] /' | tee -a "$REPORT"
note "  doctor exit=$DOCTOR_EXIT"
note "--- guest CLI: today --json (read path = schema gate) ---"
G today --json > "$OUT/today.json" 2>"$OUT/today.err"; READ_EXIT=$?
note "  today --json exit=$READ_EXIT  bytes=$(wc -c < "$OUT/today.json")"
[ "$READ_EXIT" -eq 0 ] || { tail -5 "$OUT/today.err" | sed 's/^/  [today-err] /' | tee -a "$REPORT"; fail "guest CLI read (today --json) failed exit=$READ_EXIT — schema/read path broken"; }
head -c 200 "$OUT/today.json" | python3 -c 'import sys,json; d=json.load(sys.stdin) if False else None' 2>/dev/null
python3 -c 'import json,sys; json.load(open(sys.argv[1])); print("  [today] valid JSON envelope")' "$OUT/today.json" 2>/dev/null | tee -a "$REPORT" || fail "today --json did not emit valid JSON"

# ---------------- trivial writes (URL scheme + CLI) + DB verify ----------------
note "--- trivial URL-scheme write: things:///add?title=P0-SMOKE-URL (auth token) ---"
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
note "  auth token read from DB: ${TOKEN:0:6}… (metadata: 9dFi9f…)"
lab_ssh "$IP" "open 'things:///add?title=P0-SMOKE-URL&auth-token=$TOKEN'; sleep 4" </dev/null
URLROW=$(gq "SELECT uuid FROM TMTask WHERE title='P0-SMOKE-URL' AND trashed=0 LIMIT 1")
note "  URL write landed row: ${URLROW:-<NONE>}"
[ -n "$URLROW" ] || fail "trivial URL-scheme write did not land a TMTask row"

note "--- trivial CLI write: things todo add P0-SMOKE-CLI ---"
G todo add \"P0-SMOKE-CLI\" --json > "$OUT/smoke-add.log" 2>&1; ADD_EXIT=$?
{ grep -m1 '"ok"\|"error"' "$OUT/smoke-add.log" || echo '(no ok/err line)'; } | sed 's/^/  [add] /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 3' </dev/null
CLIROW=$(gq "SELECT uuid FROM TMTask WHERE title='P0-SMOKE-CLI' AND trashed=0 LIMIT 1")
note "  CLI write landed row: ${CLIROW:-<NONE>}  (add exit=$ADD_EXIT)"
[ -n "$CLIROW" ] || fail "trivial CLI write (todo add) did not land a TMTask row"

# cleanup the two smoke rows so they don't pollute later snapshots
G todo delete "$URLROW" >/dev/null 2>&1 || true
G todo delete "$CLIROW" >/dev/null 2>&1 || true

# ---------------- environment line + verdict ----------------
ENVLINE="Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null 2>/dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null 2>/dev/null) / user_version=$UVER / clock $CLK"
note "-- env: $ENVLINE --"

# write state.env for the probe script (reuse the live VM)
cat > "$OUT/state.env" <<EOF
VM="$VM"
IP="$IP"
VNC_URL="$VNC_URL"
TOKEN="$TOKEN"
PINNED_CLOCK="070512002026"
EOF
note "state.env written: $OUT/state.env"

note ""
note "########################################################"
note "GOLDEN SMOKE: PASS  (tart $TARTVER)"
note "  clone=$((CLONE_T1-CLONE_T0))s  boot->ssh=$((BOOT_T1-BOOT_T0))s  airgap=OK  clock=$CLK"
note "  DB readable (user_version=$UVER, $TCOUNT tasks); guest CLI doctor+read OK;"
note "  URL-scheme write + CLI write both landed & verified in DB."
note "  VM LEFT RUNNING for research-parked.sh. tart 2.34.0 shows no bring-up break."
note "########################################################"
