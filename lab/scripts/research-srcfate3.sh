#!/bin/bash
# SRCFATE-3 — final completion clone. ONE disposable clone of things-lab-golden-v2.
# Closes the two heading-op umd cells that clone-2 could not reach through the CLI
# (project dissolve-heading / move-heading-to-project are CLI-UNINVOKABLE: they reject
# --dangerously-drive-gui as unknown yet H-UI-DRIVE-block without it — captured to
# up-next). Both ARE pipeline-registered, so `things batch` with dangerouslyDriveGui
# reaches them, bypassing the missing CLI flag. Measures the OWNING-row umd:
#   UMD dissolve-heading  → surviving children umd (bump or silent?)
#   UMD move-heading-to-project → the heading row umd + child umd
# Same harness as research-srcfate2.sh. Fixtures fully synthetic.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VM="srcfate3-lab"; GOLDEN="things-lab-golden-v2"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[srcfate3] $*" | tee -a "$REPORT"; }
cleanup() { echo "[srcfate3] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}'); note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL <5GB"; exit 1; }
MAIN_WT=$(dirname "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null || true)
NODE_VER=$(awk '/nodejs/{print $2}' "$MAIN_WT/.tool-versions" .tool-versions "$HOME/.tool-versions" 2>/dev/null | head -1 || true)
CANDS=("$HOME/.asdf/installs/nodejs/$NODE_VER/bin"); CANDS+=( $(ls -d "$HOME"/.asdf/installs/nodejs/*/bin 2>/dev/null | sort -t/ -k7 -V -r) ); CANDS+=(/opt/homebrew/bin)
for cand in "${CANDS[@]}"; do [ -x "$cand/node" ] || continue; otool -L "$cand/node" 2>/dev/null | grep -q '/opt/homebrew/' && continue; export PATH="$cand:$PATH"; break; done
node --version >/dev/null 2>&1 || { note "FATAL no node"; exit 1; }
[ -d node_modules/commander ] || npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL npm ci"; exit 1; }
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
airgap_pin() { lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null; lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1' </dev/null; }
airgap_pin
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[srcfate3] /'
lab_ssh "$IP" 'sudo date 070512002026 >/dev/null' </dev/null
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "AX auth_value=$GRANT"; [ "$GRANT" != "2" ] && { note "FATAL AX"; exit 1; }
HELP='~/things-lab/helpers'
lab_ssh "$IP" "mkdir -p $HELP" </dev/null
lab_ssh "$IP" "cat > $HELP/gsql.sh && chmod +x $HELP/gsql.sh" <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "$HELP/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
note "############### build + ship bundle ###############"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL build"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
enc() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$1"; }
uidp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
umd()  { gq "SELECT userModificationDate FROM TMTask WHERE uuid='$1'"; }
G config set ui-enabled true >/dev/null 2>&1
G config set allow-experimental true >/dev/null 2>&1
batch_drive() {  # <label> <jsonl>
  local label="$1" jl="$2"
  lab_ssh "$IP" "printf '%s\n' '$jl' > /tmp/b.jsonl" </dev/null
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js batch /tmp/b.jsonl ; echo EXIT=\$?" </dev/null > "$OUT/drive-$label.log" 2>&1
  { grep -m1 '"outcome"\|blocked\|error\|invalid' "$OUT/drive-$label.log" || echo '(no result)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive-$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}
note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"

# =====================================================================
# UMD dissolve-heading — surviving children umd (via batch, dangerouslyDriveGui)
# =====================================================================
note ""; note "### UMD dissolve-heading — surviving children umd (batch/dangerouslyDriveGui) ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"UMD-DHP","items":[{"type":"heading","attributes":{"title":"UMD-DH"}},{"type":"to-do","attributes":{"title":"UMD-DH-c1"}},{"type":"to-do","attributes":{"title":"UMD-DH-c2"}}]}}]')'; sleep 3" </dev/null
DHP=$(uidp "UMD-DHP")
DH=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-DH' AND type=2 LIMIT 1")
DC1=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-DH-c1' LIMIT 1"); DC2=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-DH-c2' LIMIT 1")
DC1B=$(umd "$DC1"); DC2B=$(umd "$DC2")
note "  project=$DHP heading=$DH children umd before: c1=$DC1B c2=$DC2B"
warm
batch_drive UMD-dissolve "{\"op\":\"project.dissolve-heading\",\"params\":{\"uuid\":\"$DH\"},\"options\":{\"dangerouslyDriveGui\":true}}"
settle
DC1A=$(umd "$DC1"); DC2A=$(umd "$DC2")
note "  heading fate: $(gq "SELECT 'exists='||COUNT(*) FROM TMTask WHERE uuid='$DH'")   c1 after: heading=$(gq "SELECT COALESCE(heading,'NULL') FROM TMTask WHERE uuid='$DC1'") project=$(gq "SELECT COALESCE(project,'NULL') FROM TMTask WHERE uuid='$DC1'")"
note "  [UMD dissolve-children] c1 umd $DC1B -> $DC1A ($([ "$DC1B" != "$DC1A" ] && echo BUMP || echo SILENT))   c2 umd $DC2B -> $DC2A ($([ "$DC2B" != "$DC2A" ] && echo BUMP || echo SILENT))"

# =====================================================================
# UMD move-heading-to-project — heading row umd (via batch, dangerouslyDriveGui)
# =====================================================================
note ""; note "### UMD move-heading-to-project — heading row umd (batch/dangerouslyDriveGui) ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"UMD-MHS","items":[{"type":"heading","attributes":{"title":"UMD-MH"}},{"type":"to-do","attributes":{"title":"UMD-MH-c1"}}]}},{"type":"project","attributes":{"title":"UMD-MHD","items":[]}}]')'; sleep 3" </dev/null
MHS=$(uidp "UMD-MHS"); MHD=$(uidp "UMD-MHD")
MH=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-MH' AND type=2 LIMIT 1"); MHC=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-MH-c1' LIMIT 1")
MHB=$(umd "$MH"); MHCB=$(umd "$MHC")
note "  src=$MHS dest=$MHD heading=$MH heading umd before: $MHB  child umd before: $MHCB (heading project=$(gq "SELECT COALESCE(project,'NULL') FROM TMTask WHERE uuid='$MH'"))"
warm
batch_drive UMD-move-heading "{\"op\":\"project.move-heading-to-project\",\"params\":{\"project\":{\"uuid\":\"$MHS\"},\"heading\":\"UMD-MH\",\"toProject\":{\"uuid\":\"$MHD\"}},\"options\":{\"dangerouslyDriveGui\":true}}"
settle
MHA=$(umd "$MH"); MHCA=$(umd "$MHC")
note "  heading after: project=$(gq "SELECT COALESCE(project,'NULL') FROM TMTask WHERE uuid='$MH'") (dest=$MHD)  child after: heading=$(gq "SELECT COALESCE(heading,'NULL') FROM TMTask WHERE uuid='$MHC'") project=$(gq "SELECT COALESCE(project,'NULL') FROM TMTask WHERE uuid='$MHC'")"
note "  [UMD move-heading] heading umd $MHB -> $MHA ($([ "$MHB" != "$MHA" ] && echo BUMP || echo SILENT))   child umd $MHCB -> $MHCA ($([ "$MHCB" != "$MHCA" ] && echo BUMP || echo SILENT))"

note ""; note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"
note "DONE. report: $REPORT"
