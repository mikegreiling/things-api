#!/bin/bash
# BANNER1 — the Today "You have N new to-dos" banner + per-row yellow pip law.
# Extends UPC1 §8d (deadline-pulled overlay members materialize start->1,
# startDate:=deadline on banner OK). This campaign characterizes the FULL banner:
#   Q1 pip/banner MEMBERSHIP CLASSES — manufacture newcomers of each class between
#      app sessions (advance clock +1 day with app CLOSED, then launch) and read
#      the banner count N + pip'd rows + per-row DB state:
#        (a) deadline-pull (undated someday + deadline arrives)          [control]
#        (b) SCHEDULED arrival (start=2, startDate arrives)
#        (c) repeat-instance spawn (daily fixed template)
#        (d) pushed into Today from outside (URL update when=today) while closed
#        (e) EVENING arrival (scheduled evening)
#   Q2 PERSISTENCE + the DISCRIMINATOR — where does "reviewed" state live? Relaunch
#      WITHOUT OK (persist?), OK + relaunch (gone?), then diff the DB (ALL tables)
#      and the app container files (defaults/plists) BEFORE vs AFTER OK.
#   Q3 what OK MUTATES per class — full-row DB diff pre/post-OK for b/c/d/e.
#   Q4 STAMP TIMING — app CLOSED across the deadline day, launched TWO days later:
#      is todayIndexReferenceDate = the deadline date or = first-launch date?
#
# SETUP PHASE (this script): clone golden -> banner1-lab, airgap, pin clock
# 2026-07-05 12:00, AXVM1 rung-b Accessibility grant, ship the production e2e
# bundle (make-repeating is a ui-vector op, RSIM/SL2 recipe), install guest
# helpers, verify the AppleScript oracle. LEAVES THE VM RUNNING. Drive questions
# with lab/scripts/banner1.sh. Tear down: tart delete banner1-lab.
#
# METHOD mirrors research-sl2.sh. ONE disposable --vnc-experimental clone
# (golden UNTOUCHED). Fixtures fully synthetic. Ground truth = guest Things-DB
# reads (read-only SQLite) + container-file dumps + the AppleScript list oracle;
# pip state (yellow markers) is NOT AS-readable → VNC screenshots. Writes go only
# through official surfaces: URL scheme (add/update), AppleScript, the CLI
# ui-vector (make-repeating). RSIM-S clock law: +1-day increments only.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"
AUTH="9dFi9fY-QBuqFq59yAUxOg"   # golden uriSchemeAuthToken (metadata, not a secret)

VM="banner1-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[banner1] $*" | tee -a "$REPORT"; }
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
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[banner1] /'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock pinned: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

# ---------------- guest helpers (PERSISTENT ~/things-lab/helpers) ----------------
lab_ssh "$IP" 'mkdir -p ~/things-lab/helpers ~/things-lab/dumps' </dev/null
lab_ssh "$IP" 'cat > ~/things-lab/helpers/gsql.sh && chmod +x ~/things-lab/helpers/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

# tmatrix-ish per-row Today-relevant dump for a title glob (decoded dates)
lab_ssh "$IP" 'cat > ~/things-lab/helpers/rows.sh && chmod +x ~/things-lab/helpers/rows.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
GLOB="${1:-BAN-%}"
sqlite3 -header -column "file:$DB?mode=ro" "
SELECT substr(title,1,16) AS title, type AS ty, start AS s, status AS st,
       CASE WHEN startDate IS NULL THEN 'NULL' ELSE (startDate>>16)||'-'||printf('%02d',(startDate>>12)&15)||'-'||printf('%02d',(startDate>>7)&31) END AS startD,
       CASE WHEN deadline  IS NULL THEN 'NULL' ELSE (deadline>>16)||'-'||printf('%02d',(deadline>>12)&15)||'-'||printf('%02d',(deadline>>7)&31)  END AS deadl,
       CASE WHEN todayIndexReferenceDate IS NULL THEN 'NULL' ELSE (todayIndexReferenceDate>>16)||'-'||printf('%02d',(todayIndexReferenceDate>>12)&15)||'-'||printf('%02d',(todayIndexReferenceDate>>7)&31) END AS tiRefD,
       CASE WHEN deadlineSuppressionDate IS NULL THEN 'NULL' ELSE 'supp' END AS supp,
       todayIndex AS ti
FROM TMTask WHERE title LIKE '$GLOB' ORDER BY title;"
EOF

# full-DB snapshot (schema-stable .dump minus volatile) for before/after-OK diff
lab_ssh "$IP" 'cat > ~/things-lab/helpers/dbdump.sh && chmod +x ~/things-lab/helpers/dbdump.sh' <<'EOF'
#!/bin/bash
# dbdump.sh <label> : writes ~/things-lab/dumps/<label>.dump (full SQL dump, ro copy)
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
L="$1"
cp "$DB" /tmp/snap.sqlite 2>/dev/null
sqlite3 /tmp/snap.sqlite ".dump" > ~/things-lab/dumps/"$L".dump
# also a compact TMSettings/TMMeta row (the prefs-ish rows most likely to hold a marker)
{ echo "== TMSettings =="; sqlite3 -line "file:$DB?mode=ro" "SELECT * FROM TMSettings;"
  echo "== TMMeta (if present) =="; sqlite3 "file:$DB?mode=ro" "SELECT * FROM TMMeta;" 2>&1; } > ~/things-lab/dumps/"$L".settings
EOF

# container-file snapshot: file list + mtimes + hashes + defaults, for the before/after-OK diff
lab_ssh "$IP" 'cat > ~/things-lab/helpers/cdump.sh && chmod +x ~/things-lab/helpers/cdump.sh' <<'EOF'
#!/bin/bash
# cdump.sh <label> : container-file inventory + defaults, for before/after-OK diff
L="$1"; GC=~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac
D=~/things-lab/dumps
{ echo "== find (path size mtime) =="
  find $GC -type f -not -path '*/main.sqlite*' -exec stat -f '%N %z %m' {} \; 2>/dev/null | sort
  echo "== md5 of non-sqlite container files =="
  find $GC -type f \( -name '*.plist' -o -name '*.json' -o -name '*.data' -o -name 'Backups*' -prune -o -type f \) -not -path '*main.sqlite*' -exec md5 {} \; 2>/dev/null | sort
} > "$D/$L.container"
defaults read com.culturedcode.ThingsMac > "$D/$L.defaults" 2>&1 || echo "(no defaults domain)" > "$D/$L.defaults"
# any prefs plist under the container root
ls -la $GC/*.plist 2>/dev/null >> "$D/$L.defaults" || true
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

# ---------------- ship the production e2e bundle + enable ui (make-repeating) ----------------
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

# ---------------- oracle verification (SL1/SL2 recipe) ----------------
note ""; note "############### ORACLE VERIFICATION (known selection) ###############"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14' </dev/null
KNOWN="95tovetAyq9R58hp5714D6"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$KNOWN'; sleep 3" </dev/null
O1=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get id of selected to dos'\'' 2>&1' </dev/null)
note "  known=$KNOWN  o1(id of selected to dos)=$O1"
[ "$O1" = "$KNOWN" ] || note "  WARN: oracle did not resolve known uuid — investigate before trusting."

note ""; note "############### BANNER1 SETUP COMPLETE — VM LEFT RUNNING ###############"
note "  state: $STATE"; cat "$STATE" | sed 's/^/    /'
note "  env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
note "NEXT: drive with lab/scripts/banner1.sh (seed/repeater/advance/launch/banner/shot/ok/rows/dbdump/cdump/diff)."
