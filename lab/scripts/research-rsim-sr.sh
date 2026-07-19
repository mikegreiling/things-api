#!/bin/bash
# RSIM-S / S-R addendum — trashed-child fate through a fixed conversion + RESTORE
# round-trips. (1) A plain project with a plain child + a child trashed WHILE PLAIN,
# then convert fixed: is the trashed row deleted with the source subtree, or does it
# survive in Trash — and what does its `project` column then hold (dead source uuid /
# NULL / template / instance)? (2) If it survives, restore it — where does it land, and
# what do OUR reads make of it (derived-trash walks the container chain)? (3) Trash a
# TEMPLATE-side child AFTER conversion and restore it — clean round-trip into template?
# Same rig as research-rsim-s.sh. Fresh clone, golden untouched. Fixtures synthetic.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"
VM="rsim-sr-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[rsimsr] $*" | tee -a "$REPORT"; }
cleanup() { echo "[rsimsr] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ -z "$VNCDO" ] || [ ! -x "$VNCDO" ]; then note "FATAL: \$VNCDO not set/executable."; exit 1; fi
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}'); note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 4 ] && { note "FATAL: <4GB free."; exit 1; }

MAIN_WT=$(dirname "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null || true)
NODE_VER=$(awk '/nodejs/{print $2}' "$MAIN_WT/.tool-versions" .tool-versions "$HOME/.tool-versions" 2>/dev/null | head -1 || true)
CANDS=("$HOME/.asdf/installs/nodejs/$NODE_VER/bin"); CANDS+=( $(ls -d "$HOME"/.asdf/installs/nodejs/*/bin 2>/dev/null | sort -t/ -k7 -V -r) ); CANDS+=(/opt/homebrew/bin)
for cand in "${CANDS[@]}"; do [ -x "$cand/node" ] || continue; otool -L "$cand/node" 2>/dev/null | grep -q '/opt/homebrew/' && continue; export PATH="$cand:$PATH"; break; done
node --version >/dev/null 2>&1 || { note "FATAL: no self-contained node."; exit 1; }
note "toolchain: node $(node --version) @ $(command -v node)"
[ -d node_modules/commander ] || npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL: npm ci."; exit 1; }

note "cloning golden -> $VM"; tart delete "$VM" >/dev/null 2>&1 || true; tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[rsimsr] /'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

lab_ssh "$IP" 'mkdir -p ~/things-lab/helpers' </dev/null
lab_ssh "$IP" 'cat > ~/things-lab/helpers/gsql.sh && chmod +x ~/things-lab/helpers/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
row() { gq "SELECT uuid,title,type,status,trashed,start,project,heading,rt1_repeatingTemplate,(rt1_recurrenceRule IS NOT NULL) FROM TMTask WHERE uuid='$1'"; }

# Accessibility grant (AXVM1 rung b)
note "### grant Accessibility ###"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
[ -z "$VNC_URL" ] && { note "FATAL: no VNC url."; exit 1; }
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"; PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 2; timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 12
V move 1642 332 click 1
V move 1018 869 click 1 pause 0.6 type admin pause 0.6 move 1018 963 click 1
sleep 3
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "grant auth_value=$GRANT"
lab_ssh "$IP" 'osascript -e '\''tell application "System Settings" to quit'\'' 2>/dev/null' </dev/null
[ "$GRANT" != "2" ] && { note "FATAL: grant did not land."; exit 1; }

note "### build + ship bundle ###"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build."; exit 1; }
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
drive() { local l="$1"; shift; lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive-$l.log" 2>&1; { grep -m1 '"ok"' "$OUT/drive-$l.log" || grep -m1 '"error"\|error:' "$OUT/drive-$l.log" || echo '(no ok/err)'; } | sed "s/^/  [$l] /" | tee -a "$REPORT"; grep -m1 'EXIT=' "$OUT/drive-$l.log" | sed "s/^/  [$l] /" | tee -a "$REPORT"; }
G config set ui-enabled true >/dev/null 2>&1
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 15; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
uidp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
uidt() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL LIMIT 1"; }
tmplp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
instp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_repeatingTemplate IS NOT NULL AND trashed=0 ORDER BY startDate LIMIT 1"; }

# =====================================================================
# S-R1 — trash a child WHILE PLAIN, then convert fixed; trace the trashed row.
# =====================================================================
note ""; note "############### S-R1: child trashed BEFORE conversion; fate through fixed convert ###############"
drive SRseed project add \"SR Proj\" --todo \"SR Keep\" --todo \"SR Gone\" --json
SP=$(uidp "SR Proj"); KEEP=$(uidt "SR Keep"); GONE=$(uidt "SR Gone")
note "  SR Proj=$SP  SR Keep=$KEEP  SR Gone=$GONE"
drive SRtrash todo delete "$GONE" --json
note "  SR Gone row after trash (pre-conversion):"; row "$GONE" | sed 's/^/    /' | tee -a "$REPORT"
note "  (project column above should = SR Proj source uuid=$SP)"
warm
drive SRconvert project make-repeating "$SP" --frequency daily --interval 1 --dangerously-drive-gui --json
settle
TPL=$(tmplp "SR Proj"); INS=$(instp "SR Proj")
note "  post-conversion: template=$TPL  instance=$INS  (source $SP still exists? $(gq "SELECT COUNT(*) FROM TMTask WHERE uuid='$SP'"))"
note "  *** SR Gone row AFTER conversion (deleted? survives? project=?) ***"; row "$GONE" | sed 's/^/    /' | tee -a "$REPORT"
note "  all SR Gone rows anywhere:"; gq "SELECT uuid,title,trashed,project,heading FROM TMTask WHERE title='SR Gone'" | sed 's/^/    /' | tee -a "$REPORT"
note "  SR Gone's project pointer resolves to: $(gq "SELECT COALESCE((SELECT title FROM TMTask WHERE uuid=(SELECT project FROM TMTask WHERE uuid='$GONE')),'<<DANGLING/NULL>>')")"
note "  all SR Keep rows (the plain child — copied to template+instance):"; gq "SELECT uuid,title,trashed,project,rt1_repeatingTemplate FROM TMTask WHERE title='SR Keep'" | sed 's/^/    /' | tee -a "$REPORT"

# what do OUR reads make of the trashed row + a possible dangling pointer?
note "  --- OUR reads of the post-conversion trash state ---"
G trash --json > "$OUT/read-trash-postconv.json" 2>&1; note "  things trash -> $OUT/read-trash-postconv.json"; grep -o '"title":"SR[^"]*"' "$OUT/read-trash-postconv.json" | sed 's/^/    /' | tee -a "$REPORT"
G show "$GONE" --json > "$OUT/read-show-gone.json" 2>&1; note "  things show SR Gone (exit shown in file):"; head -c 400 "$OUT/read-show-gone.json" | sed 's/^/    /' | tee -a "$REPORT"; echo | tee -a "$REPORT"

# =====================================================================
# S-R2 — restore the pre-conversion-trashed child; where does it land?
# =====================================================================
note ""; note "############### S-R2: restore SR Gone — where does it land? ###############"
if [ -n "$(gq "SELECT uuid FROM TMTask WHERE uuid='$GONE' AND trashed=1")" ]; then
  drive SRrestore todo restore "$GONE" --json
  settle
  note "  SR Gone row AFTER restore:"; row "$GONE" | sed 's/^/    /' | tee -a "$REPORT"
  note "  SR Gone lands where: project=$(gq "SELECT project FROM TMTask WHERE uuid='$GONE'") heading=$(gq "SELECT heading FROM TMTask WHERE uuid='$GONE'") trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$GONE'") start=$(gq "SELECT start FROM TMTask WHERE uuid='$GONE'")"
  note "  interpret: project resolves to $(gq "SELECT COALESCE((SELECT title FROM TMTask WHERE uuid=(SELECT project FROM TMTask WHERE uuid='$GONE')),'<<INBOX/loose or DANGLING>>')")  (template=$TPL instance=$INS source=$SP)"
  G show "$GONE" --json > "$OUT/read-show-gone-restored.json" 2>&1; note "  things show SR Gone after restore:"; head -c 400 "$OUT/read-show-gone-restored.json" | sed 's/^/    /' | tee -a "$REPORT"; echo | tee -a "$REPORT"
  G inbox --json > "$OUT/read-inbox.json" 2>&1; note "  in Inbox? $(grep -c '"title":"SR Gone"' "$OUT/read-inbox.json") match(es) in things inbox"
else
  note "  SR Gone did NOT survive conversion (hard-deleted) — nothing to restore. Restore probe N/A."
fi

# =====================================================================
# S-R3 — trash a TEMPLATE-side child AFTER conversion, then restore it.
# =====================================================================
note ""; note "############### S-R3: trash a TEMPLATE-side child, then restore — clean round-trip into template? ###############"
TKEEP=$(gq "SELECT uuid FROM TMTask WHERE title='SR Keep' AND project='$TPL' AND trashed=0 LIMIT 1")
note "  template-side SR Keep=$TKEEP  (project=$TPL)"
drive SRtrashTmpl todo delete "$TKEEP" --json
note "  template-side SR Keep after trash:"; row "$TKEEP" | sed 's/^/    /' | tee -a "$REPORT"
if [ -n "$(gq "SELECT uuid FROM TMTask WHERE uuid='$TKEEP' AND trashed=1")" ]; then
  drive SRrestoreTmpl todo restore "$TKEEP" --json
  settle
  note "  template-side SR Keep after restore:"; row "$TKEEP" | sed 's/^/    /' | tee -a "$REPORT"
  note "  round-trip check: project=$(gq "SELECT project FROM TMTask WHERE uuid='$TKEEP'") (template=$TPL) trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$TKEEP'") start=$(gq "SELECT start FROM TMTask WHERE uuid='$TKEEP'")"
  note "  -> back in template? $([ "$(gq "SELECT project FROM TMTask WHERE uuid='$TKEEP'")" = "$TPL" ] && echo YES || echo "NO — landed elsewhere")"
else
  note "  template-side trash did not land (trashed=0) — unexpected; check drive-SRtrashTmpl.log"
fi
note "  final template subtree (SR Keep present again?):"
gq "SELECT uuid,title,trashed,project FROM TMTask WHERE title='SR Keep'" | sed 's/^/    /' | tee -a "$REPORT"

note ""; note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"
note "DONE. report: $REPORT"
