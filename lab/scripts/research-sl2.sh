#!/bin/bash
# SL2 — trash / empty-trash / restore dynamics of repeating-TEMPLATE instances.
# Extends SL1 (docs/lab/sl1-show-latest.md): Show Latest = max(creationDate), no
# status filter — but SL1 NEVER tested a TRASHED instance. SL2 answers:
#  Q1 Show Latest vs a TRASHED max-creationDate instance (+ empty-trash resolve;
#     + zero-instance menu behavior).
#  Q2 after-completion template, LIVE instance TRASHED → dormant? self-pause?
#  Q3 fixed template, LIVE instance TRASHED → next occurrence still spawns?
#  Q4 RESTORE collision — trashed instance restored while a replacement exists →
#     two live instances? Show Latest pick? FK/columns?
#  Q5 hard-DELETE (trash+empty) the live after-completion instance → tombstone?
#
# SETUP PHASE (this script): clone golden -> sl2-lab, airgap, pin clock
# 2026-07-05 12:00, AXVM1 rung-b Accessibility grant, ship the production e2e
# bundle (make-repeating is a ui-vector op), install guest helpers, verify the
# `id of selected to dos` oracle against a known seed. LEAVES THE VM RUNNING.
# Drive the questions with lab/scripts/sl2.sh. Tear down: tart delete sl2-lab.
#
# METHOD mirrors research-sl1.sh. ONE disposable --vnc-experimental clone
# (golden UNTOUCHED). Fixtures fully synthetic. Ground truth = guest Things-DB
# row reads (read-only SQLite) + the AppleScript selection oracle. Writes go
# only through official surfaces: URL scheme (add/update/complete), AppleScript
# (delete=trash, move-to-Inbox=Put Back, empty trash), and the CLI ui-vector
# (make-repeating). RSIM-S clock law: +1-day increments on a daily repeater.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"
AUTH="9dFi9fY-QBuqFq59yAUxOg"   # golden uriSchemeAuthToken (metadata)

VM="sl2-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[sl2] $*" | tee -a "$REPORT"; }
STATE="$OUT/state.env"; : > "$STATE"
sav() { echo "$1=$2" >> "$STATE"; }

# ---------------- preflight ----------------
if [ -z "$VNCDO" ] || [ ! -x "$VNCDO" ]; then note "FATAL: \$VNCDO (vncdotool) not set/executable. Abort."; exit 1; fi
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB, VNCDO=$VNCDO"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free. Abort."; exit 1; }

# ---------------- host toolchain (self-contained node; rsim lesson) ----------------
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
  note "FATAL: no working self-contained node/npm on PATH. Abort."; exit 1
fi
note "toolchain: node $(node --version) / npm $(npm --version) @ $(command -v node)"
if [ ! -d node_modules/commander ]; then
  note "npm ci (worktree has no node_modules)…"
  npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL: npm ci failed (see $OUT/npm-ci.log)."; exit 1; }
fi

note "cloning golden -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"; sav IP "$IP"
sav AUTH "$AUTH"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[sl2] /'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock pinned: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

# ---------------- guest helpers (PERSISTENT ~/things-lab/helpers) ----------------
lab_ssh "$IP" 'mkdir -p ~/things-lab/helpers' </dev/null
lab_ssh "$IP" 'cat > ~/things-lab/helpers/gsql.sh && chmod +x ~/things-lab/helpers/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

# imatrix.sh <template-uuid>: instance disambiguation matrix — one row per instance
# of the template (BOTH type=0 and type=1), with trashed + status + creationDate
# (the SL1 pick key) + startDate, ordered by creationDate. The ground-truth read
# taken BEFORE each Show Latest invocation. Prints full uuids too (title-agnostic).
lab_ssh "$IP" 'cat > ~/things-lab/helpers/imatrix.sh && chmod +x ~/things-lab/helpers/imatrix.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
TPL="$1"
sqlite3 -header -column "file:$DB?mode=ro" "
SELECT substr(uuid,1,8) AS uuid8,
       type AS ty, status AS st, trashed AS tr, start AS s,
       CASE WHEN startDate IS NULL THEN 'NULL'
            ELSE (startDate>>16)||'-'||((startDate>>12)&15)||'-'||((startDate>>7)&31) END AS startD,
       CAST(creationDate AS INT) AS created,
       strftime('%m-%dT%H:%M', creationDate+978307200,'unixepoch') AS createdH,
       CASE WHEN stopDate IS NULL THEN 'NULL' ELSE strftime('%m-%dT%H:%M', stopDate+978307200,'unixepoch') END AS stopD,
       CASE WHEN rt1_repeatingTemplate IS NULL THEN 'NULL' ELSE substr(rt1_repeatingTemplate,1,8) END AS tmpl8
FROM TMTask WHERE rt1_repeatingTemplate='$TPL'
ORDER BY creationDate;"
echo "--- full uuids (title-agnostic) ---"
sqlite3 "file:$DB?mode=ro" "SELECT uuid||'  tr='||trashed||' st='||status||' created='||CAST(creationDate AS INT) FROM TMTask WHERE rt1_repeatingTemplate='$TPL' ORDER BY creationDate;"
EOF

# tmatrix.sh <template-uuid>: TEMPLATE row rt1_* snapshot (generation bookkeeping).
# Q2/Q3/Q5 need before/after diffs of these columns to answer "does the template
# pause ITSELF" (any column mutation) vs. dormancy = mere absence of a trigger.
lab_ssh "$IP" 'cat > ~/things-lab/helpers/tmatrix.sh && chmod +x ~/things-lab/helpers/tmatrix.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
TPL="$1"
sqlite3 -list "file:$DB?mode=ro" "
SELECT 'trashed='||trashed
     ||' status='||status
     ||' hasRule='||(rt1_recurrenceRule IS NOT NULL)
     ||' paused='||COALESCE(rt1_instanceCreationPaused,'NULL')
     ||' icCount='||COALESCE(rt1_instanceCreationCount,'NULL')
     ||' icStartD='||COALESCE((rt1_instanceCreationStartDate>>16)||'-'||((rt1_instanceCreationStartDate>>12)&15)||'-'||((rt1_instanceCreationStartDate>>7)&31),'NULL')
     ||' nextStartD='||COALESCE((rt1_nextInstanceStartDate>>16)||'-'||((rt1_nextInstanceStartDate>>12)&15)||'-'||((rt1_nextInstanceStartDate>>7)&31),'NULL')
     ||' nextRaw='||COALESCE(rt1_nextInstanceStartDate,'NULL')
     ||' afterComplRefD='||COALESCE((rt1_afterCompletionReferenceDate>>16)||'-'||((rt1_afterCompletionReferenceDate>>12)&15)||'-'||((rt1_afterCompletionReferenceDate>>7)&31),'NULL')
FROM TMTask WHERE uuid='$TPL';"
EOF

gq() { lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# ---------------- AXVM1 rung-b: grant Accessibility via VNC ----------------
note ""; note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
if [ -z "$VNC_URL" ]; then note "FATAL: no VNC url in tart-run.log. Abort."; exit 1; fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
sav SERVER "$SERVER"; sav PASS "$PASS"; sav VNC_URL "$VNC_URL"
V() { sleep 2; timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 12
V move 1642 332 click 1
V move 1018 869 click 1 pause 0.6 type admin pause 0.6 move 1018 963 click 1
sleep 3
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "grant auth_value=$GRANT (2=granted)"
lab_ssh "$IP" 'osascript -e '\''tell application "System Settings" to quit'\'' 2>/dev/null' </dev/null
if [ "$GRANT" != "2" ]; then note "FATAL: Accessibility grant did not land (auth_value=$GRANT). Abort."; exit 1; fi

# ---------------- ship the production e2e bundle + enable ui ----------------
note ""; note "############### build + ship bundle + ui-enabled ###############"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: npm run build failed (see $OUT/build.log)."; exit 1; }
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing after build. Abort."; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
if ! lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1; then
  note "FATAL: guest node not runnable after ship — bundle ship failed. Abort."; exit 1
fi
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
env_line() { note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"; }

# ---------------- ORACLE VERIFICATION (SL1 recipe) ----------------
note ""; note "############### ORACLE VERIFICATION (known selection) ###############"
warm
KNOWN="95tovetAyq9R58hp5714D6"   # seed LAB-P-1 (synthetic seed to-do)
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$KNOWN'; sleep 3" </dev/null
O1=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get id of selected to dos'\'' 2>&1' </dev/null)
note "  known=$KNOWN  o1(id of selected to dos)=$O1"
[ "$O1" = "$KNOWN" ] || note "  WARN: oracle did not resolve known uuid — investigate before trusting picks."

# ---------------- rt1_* column discovery (confirm exact names) ----------------
note ""; note "############### rt1_* columns present in TMTask ###############"
lab_ssh "$IP" '~/things-lab/helpers/gsql.sh -q "SELECT name FROM pragma_table_info('\''TMTask'\'') WHERE name LIKE '\''rt1_%'\'' OR name LIKE '\''%aused%'\''"' </dev/null | sed 's/^/  col: /' | tee -a "$REPORT"

note ""; note "############### SL2 SETUP COMPLETE — VM LEFT RUNNING ###############"
note "  state: $STATE"; cat "$STATE" | sed 's/^/    /'
env_line
note "NEXT: drive questions with lab/scripts/sl2.sh (convert/imatrix/tmatrix/trash/restore/empty/complete/clock/showlatest)."
