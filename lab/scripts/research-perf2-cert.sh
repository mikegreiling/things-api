#!/bin/bash
# PERF2 re-baseline + no-regression cert — golden-v3.
#
#   S7  TRACE pre/post: a full-vocabulary `todo make-repeating` (weekly/2/
#       wednesday/when/reminder, the TRACE1 shape) driven with the trace ON on the
#       OLD (app-root collect) and NEW (shell-scoped collect) bundles. Per-step
#       ui-dispatch table for each; the set-datetime step's before/after is the
#       drive-level headline. DB rule bytes of both drives must match.
#   S8  CERT cells (byte-identical DB, no regression):
#       A. ADR1 full combo — add-repeating area+tag+when+reminder weekly/2/wed;
#          OLD vs NEW rt1_recurrenceRule + reminderTime + icStart byte-identical.
#       B. Next+ends-on coexistence (RRD1/DACON1 lineage) — make-repeating --when
#          + --ends-on (two date areas present, the scoping-sensitive path);
#          OLD vs NEW rt1_recurrenceRule byte-identical.
#
# METHOD: ONE disposable clone `perf2c` of things-lab-golden-v3 (golden
# untouched). Ships BOTH pre-staged bundles. Airgap; pin clock 2026-07-05.
# Synthetic fixtures. Teardown at the end.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="perf2c"
OUT="lab/artifacts/perf2-cert"; mkdir -p "$OUT/drive" "$OUT/trace"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[perf2c] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"
STAGE="${STAGE:-/tmp/claude-503/-Volumes-Workspace-Projects-things-api/47c2c59d-13f5-4a26-a415-b9c5b748c288/scratchpad/perf2-bundles}"
BUNDLE_OLD="${BUNDLE_OLD:-$STAGE/dist-old}"
BUNDLE_NEW="${BUNDLE_NEW:-$STAGE/dist-new}"

FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB; old=$BUNDLE_OLD new=$BUNDLE_NEW"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free."; exit 1; }
[ -f "$BUNDLE_OLD/cli/main.js" ] || { note "FATAL: OLD bundle missing"; exit 1; }
[ -f "$BUNDLE_NEW/cli/main.js" ] || { note "FATAL: NEW bundle missing"; exit 1; }

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
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "AX grant=$GRANT (want 2)"; [ "$GRANT" = "2" ] || { note "FATAL AX grant"; exit 1; }
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
MVER=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)

lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# ship BOTH bundles
NODE_BIN=$(node -e 'console.log(process.execPath)')
# dist-old / dist-new live directly under ~/things-lab, so `commander` and the
# type:module package.json must resolve from there (node walks up node_modules
# and package.json from dist-*/cli/main.js): ship them to ~/things-lab, NOT a
# things-api/ subdir (the sibling-dir layout the single-bundle scripts use).
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/dist-old ~/things-lab/dist-new' </dev/null
scpO -r "$BUNDLE_OLD" "admin@$IP:/Users/admin/things-lab/dist-old"
scpO -r "$BUNDLE_NEW" "admin@$IP:/Users/admin/things-lab/dist-new"
NODE_MODULES_DIR="$(pwd)/node_modules"; [ -d "$NODE_MODULES_DIR/commander" ] || NODE_MODULES_DIR="$MAIN_WT/node_modules"
scpO -r "$NODE_MODULES_DIR/commander" "admin@$IP:/Users/admin/things-lab/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
# config lives per-home; set once with either bundle
lab_ssh "$IP" '~/things-lab/bin/node ~/things-lab/dist-new/cli/main.js config set ui-enabled true' </dev/null >/dev/null 2>&1
note "both bundles shipped; Things $TVER / macOS $MVER / $GOLDEN / clock 2026-07-05"

# runners: G_OLD/G_NEW plain, GT_OLD/GT_NEW traced
G_OLD() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/dist-old/cli/main.js $*" </dev/null; }
G_NEW() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/dist-new/cli/main.js $*" </dev/null; }
warm()   { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
tpl_uuid()   { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NOT NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
plain_uuid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
rule_hex()   { gq "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'"; }

# aggregate the newest guest trace into a per-step table -> prints table + set-datetime rows
pull_trace() { # <tag>
  local tag="$1"
  lab_ssh "$IP" 'cd ~/.local/state/things-api/trace 2>/dev/null && ls -t | head -1' </dev/null > "$OUT/trace/$tag.name" 2>/dev/null || true
  local tf; tf=$(tr -d '\r\n' < "$OUT/trace/$tag.name")
  [ -n "$tf" ] || { note "  NO trace file for $tag"; return; }
  lab_ssh "$IP" "cat ~/.local/state/things-api/trace/$(printf '%q' "$tf")" </dev/null > "$OUT/trace/$tag.jsonl" 2>/dev/null || true
  node - "$OUT/trace/$tag.jsonl" "$tag" <<'NODE' | tee -a "$REPORT"
const fs=require("fs");
const rows=fs.readFileSync(process.argv[2],"utf8").split("\n").filter(l=>l.trim()).map(l=>JSON.parse(l));
const ends=rows.filter(r=>r.phase==="ui-dispatch"&&r.event==="end");
const byLabel=new Map();
for(const r of ends){ const k=`${r.primitive}\t${r.label}`; const v=byLabel.get(k)||{ms:0,n:0}; v.ms+=r.durationMs||0; v.n+=1; byLabel.set(k,v); }
let total=0;
console.log(`  --- ${process.argv[3]} per-step ---`);
for(const [k,v] of byLabel){ const [p,l]=k.split("\t"); total+=v.ms; console.log(`  | ${l} | ${p} | ${v.ms} | ${v.n} |`); }
const inv=rows.find(r=>r.phase==="invocation-end");
console.log(`  ${process.argv[3]} TOTAL ui-dispatch ms: ${total}${inv?`; invocation elapsedMs ${inv.elapsedMs}, exit ${inv.exitCode}`:""}`);
const dt=ends.filter(r=>r.primitive==="set-datetime");
for(const r of dt) console.log(`  ${process.argv[3]} set-datetime "${r.label}": ${r.durationMs}ms (ok=${r.ok})`);
NODE
}

# =====================================================================
# S7 — TRACE pre/post (make-repeating full vocab)
# =====================================================================
RULE="--frequency weekly --interval 2 --weekdays wednesday --when 2026-08-26 --reminder 18:00 --dangerously-drive-gui --json"
note ""; note "############### S7: TRACE make-repeating full vocab (OLD then NEW) ###############"

# OLD
warm
G_OLD todo add \"PERF2 trace old\" --json >"$OUT/drive/trace-old-seed.log" 2>&1
settle
UOLD=$(plain_uuid "PERF2 trace old")
note "  OLD seed uuid=$UOLD"
warm
lab_ssh "$IP" "THINGS_API_TRACE=true ~/things-lab/bin/node ~/things-lab/dist-old/cli/main.js todo make-repeating $UOLD $RULE" </dev/null >"$OUT/drive/trace-old.log" 2>&1
note "  OLD verdict: $(grep -m1 '"ok"\|verify-failed\|"error"\|blocked' "$OUT/drive/trace-old.log" | head -c 160)"
settle
pull_trace old
TOLD=$(tpl_uuid "PERF2 trace old"); note "  OLD template uuid=$TOLD"
HOLD=$(rule_hex "$TOLD"); note "  OLD rt1_recurrenceRule=$HOLD"

# NEW
warm
G_NEW todo add \"PERF2 trace new\" --json >"$OUT/drive/trace-new-seed.log" 2>&1
settle
UNEW=$(plain_uuid "PERF2 trace new")
note "  NEW seed uuid=$UNEW"
warm
lab_ssh "$IP" "THINGS_API_TRACE=true ~/things-lab/bin/node ~/things-lab/dist-new/cli/main.js todo make-repeating $UNEW $RULE" </dev/null >"$OUT/drive/trace-new.log" 2>&1
note "  NEW verdict: $(grep -m1 '"ok"\|verify-failed\|"error"\|blocked' "$OUT/drive/trace-new.log" | head -c 160)"
settle
pull_trace new
TNEW=$(tpl_uuid "PERF2 trace new"); note "  NEW template uuid=$TNEW"
HNEW=$(rule_hex "$TNEW"); note "  NEW rt1_recurrenceRule=$HNEW"
note "  S7 rule bytes OLD==NEW? $([ -n "$HOLD" ] && [ "$HOLD" = "$HNEW" ] && echo YES || echo "NO ($HOLD vs $HNEW)")"

# =====================================================================
# S8 — CERT cells (byte-identical DB)
# =====================================================================
note ""; note "############### S8: CERT cells ###############"
G_NEW area add \"Synthetic Area\" --json >/dev/null 2>&1
G_NEW tag add recurring --json >/dev/null 2>&1
settle
ADRRULE="--frequency weekly --interval 2 --weekdays wednesday --when 2026-08-26 --dangerously-drive-gui --json"

# --- A. ADR1 full combo (add-repeating) ---
note "-- A. ADR1 full combo: add-repeating area+tag+when+reminder weekly/2/wed --"
warm
lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/dist-old/cli/main.js todo add-repeating 'PERF2 ADR1 old' --area 'Synthetic Area' --tag recurring --reminder 18:00 $ADRRULE" </dev/null >"$OUT/drive/adr1-old.log" 2>&1
settle
AOLD=$(tpl_uuid "PERF2 ADR1 old")
AOLD_RULE=$(rule_hex "$AOLD"); AOLD_REM=$(gq "SELECT reminderTime FROM TMTask WHERE uuid='$AOLD'"); AOLD_IC=$(gq "SELECT rt1_instanceCreationStartDate FROM TMTask WHERE uuid='$AOLD'")
note "  OLD tpl=$AOLD rule=$AOLD_RULE reminderTime=$AOLD_REM icStart=$AOLD_IC"
warm
lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/dist-new/cli/main.js todo add-repeating 'PERF2 ADR1 new' --area 'Synthetic Area' --tag recurring --reminder 18:00 $ADRRULE" </dev/null >"$OUT/drive/adr1-new.log" 2>&1
settle
ANEW=$(tpl_uuid "PERF2 ADR1 new")
ANEW_RULE=$(rule_hex "$ANEW"); ANEW_REM=$(gq "SELECT reminderTime FROM TMTask WHERE uuid='$ANEW'"); ANEW_IC=$(gq "SELECT rt1_instanceCreationStartDate FROM TMTask WHERE uuid='$ANEW'")
note "  NEW tpl=$ANEW rule=$ANEW_RULE reminderTime=$ANEW_REM icStart=$ANEW_IC"
if [ -n "$ANEW" ] && [ "$AOLD_RULE" = "$ANEW_RULE" ] && [ "$AOLD_REM" = "$ANEW_REM" ] && [ "$AOLD_IC" = "$ANEW_IC" ]; then
  note "  A VERDICT: PASS — byte-identical (rule+reminderTime+icStart)"
else
  note "  A VERDICT: FAIL — mismatch or no template. VM kept."; KEEP=1
fi

# --- B. Next + ends-on coexistence (make-repeating) ---
note "-- B. Next+ends-on coexistence: make-repeating --when + --ends-on --"
warm
G_OLD todo add \"PERF2 ends old\" --json >/dev/null 2>&1
settle
EOLD_SEED=$(plain_uuid "PERF2 ends old")
warm
lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/dist-old/cli/main.js todo make-repeating $EOLD_SEED --frequency weekly --interval 1 --weekdays wednesday --when 2026-08-26 --ends-on 2027-01-01 --dangerously-drive-gui --json" </dev/null >"$OUT/drive/ends-old.log" 2>&1
note "  OLD verdict: $(grep -m1 '"ok"\|verify-failed\|"error"\|blocked' "$OUT/drive/ends-old.log" | head -c 140)"
settle
EOLD=$(tpl_uuid "PERF2 ends old"); EOLD_RULE=$(rule_hex "$EOLD")
note "  OLD tpl=$EOLD rule=$EOLD_RULE"
warm
G_NEW todo add \"PERF2 ends new\" --json >/dev/null 2>&1
settle
ENEW_SEED=$(plain_uuid "PERF2 ends new")
warm
lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/dist-new/cli/main.js todo make-repeating $ENEW_SEED --frequency weekly --interval 1 --weekdays wednesday --when 2026-08-26 --ends-on 2027-01-01 --dangerously-drive-gui --json" </dev/null >"$OUT/drive/ends-new.log" 2>&1
note "  NEW verdict: $(grep -m1 '"ok"\|verify-failed\|"error"\|blocked' "$OUT/drive/ends-new.log" | head -c 140)"
settle
ENEW=$(tpl_uuid "PERF2 ends new"); ENEW_RULE=$(rule_hex "$ENEW")
note "  NEW tpl=$ENEW rule=$ENEW_RULE"
if [ -n "$ENEW" ] && [ "$EOLD_RULE" = "$ENEW_RULE" ]; then
  note "  B VERDICT: PASS — byte-identical rule (Next + ends-on both landed)"
else
  note "  B VERDICT: FAIL — mismatch or no template. VM kept."; KEEP=1
fi

note ""; note "############### PERF2 CERT COMPLETE ###############"
note "env: Things $TVER / macOS $MVER / $GOLDEN / clock 2026-07-05"
note "artifacts under $OUT"
