#!/bin/bash
# HEADCERT1 — certify heading.convert-to-project (the LAST uncertified ui op).
# Full write-up: docs/lab/headcert1-certification.md.
#
# The UIC1 blocker: things:///show?id=<heading> does not select a heading, so
# Convert to Project… stayed disabled and the drive no-oped. The fix reuses the
# UIC5 row `select` action on the heading's PARENT-PROJECT view: a heading row
# IS selectable (AXSelected lands, `name of selected to dos` reads back empty),
# and with it selected Convert to Project… enables. Heading rows expose no stable
# AX title (only a hover-dependent "More" affordance), so the target is addressed
# POSITIONALLY — the Nth selectable-empty-readback row = the Nth heading by DB
# `index` order (classifyHeadingConvert). UI2-d already proved the transform.
#
# ONE disposable clone: grant Accessibility (AXVM1 rung b), ship the production
# e2e bundle, enable ui.enabled, seed a 2-heading project via things:///json,
# then convert ordinal 1 (proves the walk counts past heading 0 and leaves it
# untouched) then ordinal 0 THROUGH THE PRODUCTION CLI, asserting guest DB deltas
# + gating.
#
# VM discipline: --vnc-experimental single-client — ONE vncdo per grant step.
# Requires $VNCDO (vncdotool venv): python3 -m venv <dir>/vncenv &&
#   <dir>/vncenv/bin/pip install vncdotool ; export VNCDO=<dir>/vncenv/bin/vncdo.
# Drive Things WARM (~15s after relaunch). Ground truth = guest DB row deltas.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"
AREA_A="7Ck4hAXU36jyaBsy2Fkije"        # LAB-AREA-A (golden seed)

VM="things-run-headcert1-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[headcert1] $*" | tee -a "$REPORT"; }
cleanup() { echo "[headcert1] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
relaunch_warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 15' </dev/null; }

# ---------- AXVM1 grant (rung b) ----------
note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then note "VNCDO/VNC_URL missing — grant needs VNC. Abort."; exit 1; fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
V move 1642 332 click 1; sleep 3
V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3
lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT service,client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true

# ---------- ship the guest e2e bundle + enable ui config ----------
note "############### build + ship bundle + enable ui.enabled ###############"
npm run build >/dev/null
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules; rm -rf ~/things-lab/things-api/dist' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/dist"   # NOTE: rm -rf'd above so no nested dist/dist
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1

# ---------- seed a fresh 2-heading project via json (HX0) ----------
note "############### seed HCERT2 (2 headings + children) via things:///json ###############"
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
JSON='[{"type":"project","attributes":{"title":"HCERT2","area-id":"'$AREA_A'","items":[{"type":"heading","attributes":{"title":"Hx1"}},{"type":"to-do","attributes":{"title":"x1c"}},{"type":"heading","attributes":{"title":"Hx2"}},{"type":"to-do","attributes":{"title":"x2c"}}]}}]'
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$JSON")
lab_ssh "$IP" "open 'things:///json?data=$ENC&auth-token=$TOKEN'; sleep 3" </dev/null
HX1=$(gq "SELECT uuid FROM TMTask WHERE title='Hx1' AND type=2 AND trashed=0")   # index -563 -> ordinal 0
HX2=$(gq "SELECT uuid FROM TMTask WHERE title='Hx2' AND type=2 AND trashed=0")   # index 0    -> ordinal 1
X1C=$(gq "SELECT uuid FROM TMTask WHERE title='x1c'"); X2C=$(gq "SELECT uuid FROM TMTask WHERE title='x2c'")
note "Hx1(ord0)=$HX1  Hx2(ord1)=$HX2"

conv() { G heading convert-to-project "$1" --dangerously-drive-gui --json 2>/dev/null; }

# ---------- HEADCERT1-c1: ordinal 1 (Hx2) — walk counts past Hx1, leaves it untouched ----------
note "############### c1: convert Hx2 (ordinal 1) via production CLI ###############"; relaunch_warm
conv "$HX2" | tee -a "$REPORT" >/dev/null
note "  Hx2 present(0): $(gq "SELECT count(*) FROM TMTask WHERE uuid='$HX2' AND trashed=0")  Hx1 UNTOUCHED(1): $(gq "SELECT count(*) FROM TMTask WHERE uuid='$HX1' AND trashed=0")"
note "  new Hx2 project(area=AREA_A): $(gq "SELECT uuid||' area='||coalesce(area,'-') FROM TMTask WHERE title='Hx2' AND type=1 AND trashed=0")"
note "  x2c reparented (heading NULL): $(gq "SELECT coalesce(project,'-')||' heading='||coalesce(heading,'-') FROM TMTask WHERE uuid='$X2C'")  x1c untouched: $(gq "SELECT 'heading='||coalesce(heading,'-') FROM TMTask WHERE uuid='$X1C'")"

# ---------- HEADCERT1-c2: ordinal 0 (Hx1) ----------
note "############### c2: convert Hx1 (now ordinal 0) via production CLI ###############"; relaunch_warm
conv "$HX1" | tee -a "$REPORT" >/dev/null
note "  Hx1 present(0): $(gq "SELECT count(*) FROM TMTask WHERE uuid='$HX1' AND trashed=0")  new Hx1 project: $(gq "SELECT uuid||' area='||coalesce(area,'-') FROM TMTask WHERE title='Hx1' AND type=1 AND trashed=0")  x1c reparented: $(gq "SELECT coalesce(project,'-')||' heading='||coalesce(heading,'-') FROM TMTask WHERE uuid='$X1C'")"

# ---------- HEADCERT1-c3/c4: gating ----------
note "############### c3/c4: gating ###############"
JSON2='[{"type":"project","attributes":{"title":"HGATE","area-id":"'$AREA_A'","items":[{"type":"heading","attributes":{"title":"Hg1"}},{"type":"to-do","attributes":{"title":"g1c"}}]}}]'
ENC2=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$JSON2")
lab_ssh "$IP" "open 'things:///json?data=$ENC2&auth-token=$TOKEN'; sleep 3" </dev/null
HG1=$(gq "SELECT uuid FROM TMTask WHERE title='Hg1' AND type=2 AND trashed=0"); relaunch_warm
note "  no --dangerously-drive-gui -> H-UI-DRIVE exit 4:"; G heading convert-to-project "$HG1" 2>/dev/null; echo "  exit=$?" | tee -a "$REPORT"
G config set ui-enabled false >/dev/null 2>&1
note "  ui disabled -> unsupported exit 6:"; G heading convert-to-project "$HG1" --dangerously-drive-gui 2>/dev/null; echo "  exit=$?" | tee -a "$REPORT"
G config set ui-enabled true >/dev/null 2>&1
note "  Hg1 untouched by gating(1): $(gq "SELECT count(*) FROM TMTask WHERE uuid='$HG1' AND trashed=0")"

note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 --"
note "DONE. report: $REPORT"
