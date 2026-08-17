#!/bin/bash
# TRACE1 — per-step timing baseline for a make-repeating UI drive (issue #487).
#
# Drives ONE full-vocabulary `todo make-repeating` with the dev-mode trace ON
# and pulls the per-invocation JSONL back, so the `ui-dispatch` rows give a
# golden baseline for the in-CLI drive watchdog default. This is the airgapped
# lab number the watchdog default multiplies by a wide safety factor — a live
# production DB (large + Things-Cloud syncing) runs several times slower and is
# NOT reproduced here (that is the whole point of #487).
#
# METHOD: ONE disposable clone `trace1` of things-lab-golden-v3 (golden
# untouched). golden-v3 carries the baked L3-accessibility grant, so the ui
# vector drives over SSH — NO VNC. Airgap; pin clock 2026-07-05 12:00 before
# Things launches (so --when 2026-08-26 lands in Upcoming, matching the report).
# Ship the PRODUCTION bundle; force the trace on for the one make-repeating drive
# with THINGS_API_TRACE=true. Fixtures fully synthetic (TRACE1-* titles). Ground
# truth = the trace JSONL. Teardown at the end (single-VM courtesy).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="trace1"
OUT="lab/artifacts/trace1-lab"; mkdir -p "$OUT/drive" "$OUT/trace"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[trace1] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

# ---------------- preflight ----------------
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free. Abort."; exit 1; }

# self-contained node (avoid a homebrew-linked node)
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
if [ ! -d node_modules/commander ]; then
  note "npm ci (worktree has no node_modules)…"
  npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL: npm ci failed."; exit 1; }
fi

# ---------------- clone + boot ----------------
GOLDEN="${GOLDEN:-things-lab-golden-v3}"
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM running at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
note "airgap: $AG"
[ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "AX grant=$GRANT (want 2)"
[ "$GRANT" = "2" ] || { note "FATAL: AX grant missing"; exit 1; }

# ---------------- guest helpers ----------------
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# ---------------- build + ship bundle ----------------
note "build + ship production bundle (branch HEAD — includes the TRACE1 trace)"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL build (see build.log)"; exit 1; }
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1 || { note "FATAL: guest node broken"; exit 1; }

G()     { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
# Drive WITH the trace forced on (the shipped bundle is a published build, so
# `-dev` auto-detection is off; THINGS_API_TRACE=true turns it on for this run).
GT()    { lab_ssh "$IP" "THINGS_API_TRACE=true ~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
MVER=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
note "bundle shipped; ui-enabled=true; Things $TVER / macOS $MVER / DB v26 / clock 2026-07-05"

warm()   { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
plain_uuid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }

# =====================================================================
# Seed a plain to-do, then make-repeating it with the FULL #487 vocabulary,
# tracing the drive. Pull the trace JSONL and aggregate the ui-dispatch rows.
# =====================================================================
note ""; note "############### seed + traced make-repeating drive ###############"
warm
G todo add \"TRACE1 weekly\" --json >"$OUT/drive/seed.log" 2>&1
settle
UUID=$(plain_uuid 'TRACE1 weekly')
note "seed uuid=$UUID"
[ -n "$UUID" ] || { note "FATAL: seed not created"; exit 1; }

warm
note "-- traced: todo make-repeating (weekly / interval 2 / wednesday / when / reminder) --"
GT todo make-repeating "$UUID" --frequency weekly --interval 2 --weekdays wednesday --when 2026-08-26 --reminder 18:00 --dangerously-drive-gui --json >"$OUT/drive/make-repeating.log" 2>&1
note "  verdict: $(grep -m1 '"ok"\|verify-failed\|"error"\|blocked' "$OUT/drive/make-repeating.log" | head -c 200)"
settle

# Pull every trace file this run produced.
lab_ssh "$IP" 'cd ~/.local/state/things-api/trace 2>/dev/null && ls -1' </dev/null > "$OUT/trace/list.txt" 2>/dev/null || true
note "trace files in guest: $(tr '\n' ' ' < "$OUT/trace/list.txt")"
while read -r tf; do
  [ -n "$tf" ] || continue
  lab_ssh "$IP" "cat ~/.local/state/things-api/trace/$(printf '%q' "$tf")" </dev/null > "$OUT/trace/$tf" 2>/dev/null || true
done < "$OUT/trace/list.txt"

# Aggregate the newest trace's ui-dispatch rows into a per-step table.
NEWEST=$(ls -t "$OUT"/trace/*.jsonl 2>/dev/null | head -1 || true)
if [ -n "$NEWEST" ]; then
  note ""; note "PER-STEP TIMINGS (from $(basename "$NEWEST")):"
  node - "$NEWEST" <<'NODE' | tee -a "$REPORT"
const fs = require("fs");
const lines = fs.readFileSync(process.argv[2], "utf8").split("\n").filter((l) => l.trim());
const rows = lines.map((l) => JSON.parse(l));
const ends = rows.filter((r) => r.phase === "ui-dispatch" && r.event === "end");
const byLabel = new Map();
for (const r of ends) {
  const k = `${r.primitive}\t${r.label}`;
  const v = byLabel.get(k) || { ms: 0, n: 0 };
  v.ms += r.durationMs || 0;
  v.n += 1;
  byLabel.set(k, v);
}
let total = 0;
for (const [k, v] of byLabel) {
  const [primitive, label] = k.split("\t");
  total += v.ms;
  console.log(`| ${label} | ${primitive} | ${v.ms} | ${v.n} |`);
}
const inv = rows.find((r) => r.phase === "invocation-end");
console.log(`TOTAL ui-dispatch wall ms: ${total}`);
if (inv) console.log(`invocation elapsedMs (whole command): ${inv.elapsedMs}, exitCode ${inv.exitCode}`);
NODE
else
  note "NO trace file recovered — see drive/make-repeating.log"
fi

note ""; note "############### TRACE1 COMPLETE ###############"
note "env: Things $TVER / macOS $MVER / DB v26 / $GOLDEN / clock 2026-07-05"
note "artifacts under $OUT (report.txt, drive/*.log, trace/*.jsonl)"
