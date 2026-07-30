#!/bin/bash
# SL1 — what criterion does the Things GUI "Show Latest" action (Repeat submenu /
# repeat-bar popover, on a repeating TEMPLATE) use to pick "the latest instance"?
# Candidates: creationDate / userModificationDate / startDate / stopDate; and does
# it prefer the OPEN pre-spawned occurrence or the most-recently-COMPLETED one?
# The verdict feeds a planned `latestInstance` read-layer derivation that must match
# the GUI meaning exactly.
#
# SETUP PHASE (this script):
#  - clone golden -> sl1-lab, airgap, pin clock 2026-07-05 12:00
#  - AXVM1 rung-b Accessibility grant via VNC (menu clicking needs it)
#  - ship the production e2e bundle (make-repeating is a ui-vector op)
#  - ORACLE VERIFICATION: select a KNOWN seed item via things:///show?id=<uuid>;
#    confirm both candidate oracles resolve to that uuid:
#      (o1) Things AppleScript `id of selected to dos`  (Things' own selection model)
#      (o2) Copy Link -> pasteboard `things:///show?id=<uuid>`  (the brief's oracle)
#  - MENU DISCOVERY: enumerate Items menu, its Repeat submenu (Show Latest), and the
#    Share/Copy Link path — record exact names for the driver.
#  - seed a plain TO-DO "SL Daily"; convert to a DAILY FIXED repeater
#    (next occurrence = tomorrow); snapshot.
# Then LEAVES THE VM RUNNING for the clock-advance phase (sl1-clock.sh, +1 day x3 to
# accumulate instances 07-05..07-08) and the Show-Latest disambiguation rounds
# (sl1-round.sh). Tear down explicitly with `tart delete sl1-lab`.
#
# METHOD mirrors research-rsim-s.sh: ONE disposable --vnc-experimental clone of
# things-lab-golden-v1 (golden UNTOUCHED). Fixtures fully synthetic. Ground truth =
# guest Things-DB row reads (read-only SQLite) + the clipboard/selection oracle.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"
AUTH="9dFi9fY-QBuqFq59yAUxOg"   # golden uriSchemeAuthToken (metadata)

VM="sl1-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[sl1] $*" | tee -a "$REPORT"; }
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
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[sl1] /'
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
gq() { lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# imatrix.sh <template-uuid>: the instance disambiguation matrix. Prints one row per
# instance of the template (to-do type=0) with the four candidate ordering keys +
# status, dates decoded to human form. This is the ground-truth read taken BEFORE each
# Show Latest invocation.
lab_ssh "$IP" 'cat > ~/things-lab/helpers/imatrix.sh && chmod +x ~/things-lab/helpers/imatrix.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
TPL="$1"
sqlite3 -header -column "file:$DB?mode=ro" "
SELECT substr(uuid,1,8) AS uuid8,
       status AS st,
       CASE WHEN startDate IS NULL THEN 'NULL'
            ELSE (startDate>>16)||'-'||((startDate>>12)&15)||'-'||((startDate>>7)&31) END AS startD,
       startBucket AS sb,
       CASE WHEN stopDate IS NULL THEN 'NULL' ELSE strftime('%Y-%m-%dT%H:%M', stopDate+978307200,'unixepoch') END AS stopD,
       strftime('%Y-%m-%dT%H:%M:%S', creationDate+978307200,'unixepoch') AS created,
       strftime('%Y-%m-%dT%H:%M:%S', userModificationDate+978307200,'unixepoch') AS usermod,
       CASE WHEN rt1_repeatingTemplate IS NULL THEN 'NULL' ELSE substr(rt1_repeatingTemplate,1,8) END AS tmpl8
FROM TMTask WHERE rt1_repeatingTemplate='$TPL' AND type=0
ORDER BY startDate;"
echo "--- full uuids (title-agnostic; all instances share the same title) ---"
sqlite3 "file:$DB?mode=ro" "SELECT uuid||'  start='||CASE WHEN startDate IS NULL THEN 'NULL' ELSE (startDate>>16)||'-'||((startDate>>12)&15)||'-'||((startDate>>7)&31) END||'  status='||status FROM TMTask WHERE rt1_repeatingTemplate='$TPL' AND type=0 ORDER BY startDate;"
EOF
imatrix() { lab_ssh "$IP" "~/things-lab/helpers/imatrix.sh $1" </dev/null | tee -a "$REPORT"; }
snap() { lab_ssh "$IP" "~/things-lab/helpers/gsql.sh 'SELECT uuid,type,status,start,startBucket,startDate,stopDate,creationDate,userModificationDate,rt1_repeatingTemplate,(rt1_recurrenceRule IS NOT NULL) AS hasRule FROM TMTask WHERE title=\"SL Daily\" ORDER BY startDate'" </dev/null > "$OUT/snaps/$1.txt"; note "  snap $1 -> $OUT/snaps/$1.txt"; }

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
drive() {
  local label="$1"; shift
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive-$label.log" 2>&1
  { grep -m1 '"ok"' "$OUT/drive-$label.log" || grep -m1 '"error"\|error:' "$OUT/drive-$label.log" || echo '(no ok/error line — see drive log)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive-$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}
G config set ui-enabled true >/dev/null 2>&1

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
env_line() { note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"; }
uidp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
tmplp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }

# =====================================================================
# ORACLE VERIFICATION — pick a KNOWN item, confirm both oracles resolve to it.
# =====================================================================
note ""; note "############### ORACLE VERIFICATION (known selection) ###############"
warm
KNOWN="95tovetAyq9R58hp5714D6"   # seed LAB-P-1 (synthetic seed to-do)
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$KNOWN'; sleep 3" </dev/null
note "  known uuid selected via things:///show?id= : $KNOWN"
# oracle o1 — Things AppleScript selection model
O1=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get id of selected to dos'\'' 2>&1' </dev/null)
note "  o1 (AppleScript id of selected to dos): $O1"
O1NAME=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get name of selected to dos'\'' 2>&1' </dev/null)
note "  o1 name of selected to dos: $O1NAME"
# oracle o2 — Copy Link -> pasteboard. First discover the menu path.
note "  Items menu items: $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application \"System Events\" to tell process \"Things3\" to get name of every menu item of menu \"Items\" of menu bar 1'\'' 2>&1' </dev/null)"
# Try to enumerate a Share submenu (name may carry an ellipsis …)
note "  Share submenu (menu 1 of Share…): $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application \"System Events\" to tell process \"Things3\" to get name of every menu item of menu 1 of menu item \"Share…\" of menu \"Items\" of menu bar 1'\'' 2>&1' </dev/null)"
lab_ssh "$IP" 'printf "SENTINEL-CLEAR" | pbcopy' </dev/null
# Attempt Copy Link via Items ▸ Share… ▸ Copy Link
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to click menu item "Copy Link" of menu 1 of menu item "Share…" of menu "Items" of menu bar 1'\'' 2>&1' </dev/null | sed 's/^/  [copylink-attempt] /' | tee -a "$REPORT"
sleep 2
O2=$(lab_ssh "$IP" 'pbpaste' </dev/null)
note "  o2 (pasteboard after Copy Link): $O2"
echo "O1=$O1" >> "$STATE"; echo "O2=$O2" >> "$STATE"
note "  ORACLE CHECK: known=$KNOWN  o1=$O1  o2=$O2"

# =====================================================================
# SEED — a plain TO-DO, converted to a DAILY FIXED repeater.
# =====================================================================
note ""; note "############### SEED: plain to-do -> DAILY FIXED repeating ###############"
lab_ssh "$IP" "open 'things:///add?title=SL%20Daily&auth-token=$AUTH'; sleep 3" </dev/null
SD=$(uidp "SL Daily"); note "  seed SL Daily uuid=$SD"; sav SD "$SD"
[ -z "$SD" ] && { note "FATAL: seed to-do not created. VM left up."; exit 1; }
warm
drive S_convert todo make-repeating "$SD" --frequency daily --interval 1 --dangerously-drive-gui --json
settle
TPL=$(tmplp "SL Daily"); note "  SL Daily template=$TPL"; sav TPL "$TPL"
[ -z "$TPL" ] && { note "FATAL: no template row after conversion. VM left up."; exit 1; }
note "  template recurrence + next-occurrence fields:"
gq "SELECT uuid,rt1_instanceCreationCount,rt1_nextInstanceStartDate,rt1_instanceCreationStartDate FROM TMTask WHERE uuid='$TPL'" | sed 's/^/    /' | tee -a "$REPORT"
INS0=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TPL' AND type=0 ORDER BY startDate LIMIT 1")
note "  first instance (07-05) = $INS0"; sav INS0 "$INS0"
note "  --- instance matrix (post-convert, expect 1 open instance) ---"; imatrix "$TPL"
snap seed

# ---- Repeat submenu discovery (needs a repeating item selected: the template) ----
note ""; note "############### MENU DISCOVERY: Repeat submenu (Show Latest) on the TEMPLATE ###############"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$TPL'; sleep 3" </dev/null
note "  template selected? id of selected to dos = $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application \"Things3\" to get id of selected to dos'\'' 2>&1' </dev/null)"
note "  Repeat submenu items: $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application \"System Events\" to tell process \"Things3\" to get name of every menu item of menu 1 of menu item \"Repeat\" of menu \"Items\" of menu bar 1'\'' 2>&1' </dev/null)"

note ""; note "############### SL1 SETUP COMPLETE — VM LEFT RUNNING ###############"
note "  state: $STATE"; cat "$STATE" | sed 's/^/    /'
env_line
note "NEXT: sl1-clock.sh <DAY> <LABEL> to accumulate instances (07-06/07/08); then sl1-round.sh."
