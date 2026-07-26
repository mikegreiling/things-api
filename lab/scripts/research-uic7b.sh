#!/bin/bash
# UIC7b — make-repeating interval-guard + driver mitigation (follow-up to UIC7).
# Full write-up: docs/lab/uic7-reschedule-cluster.md (§ make-repeating interval guard).
#
# Proves the "ZERO silent-wrong" invariant for make-repeating across units, and
# whether the closed-loop interval read-back retry (axSetValueScript) actually
# lands interval>1 live, or only the create-probe expectedRule guard fires
# (honest verify-failed). Also exercises the PLURAL after-completion unit label
# live (rescheduling an interval-2 rule opens the dialog in plural state),
# closing the UIC7 (c) validation gap.
#
# Per-case verdict (the invariant): ok=true AND landed rule == requested →
# HONEST-SUCCESS; ok=false → HONEST-FAILCLOSED (acceptable); ok=true AND landed
# rule != requested → SILENT-WRONG (the unacceptable outcome this task kills).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

VM="uic7b-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/json"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[uic7b] $*" | tee -a "$REPORT"; }
cleanup() { echo "[uic7b] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
lab_ssh "$IP" 'cat > /tmp/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
row=c.execute("SELECT rt1_recurrenceRule FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row or row[0] is None: print("NO-RULE"); sys.exit(0)
d=plistlib.loads(row[0])
print("tp=%s fu=%s fa=%s"%(d.get('tp'),d.get('fu'),d.get('fa')))
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
rsum() { lab_ssh "$IP" "python3 /tmp/rsum.py $1" </dev/null; }

# ---------- AXVM1 grant (rung b) ----------
note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
[ -z "$VNCDO" ] || [ -z "$VNC_URL" ] && { note "VNCDO/VNC_URL missing — grant needs VNC. Abort."; exit 1; }
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 2; timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 12
V move 1642 332 click 1
V move 1018 869 click 1 pause 0.6 type admin pause 0.6 move 1018 963 click 1
sleep 3
note "grant: $(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)"
lab_ssh "$IP" 'osascript -e '\''tell application "System Settings" to quit'\'' 2>/dev/null' </dev/null

# ---------- ship bundle + enable ui ----------
note "############### build + ship bundle + enable ui.enabled ###############"
npm run build >/dev/null
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
G config set ui-enabled true >/dev/null 2>&1
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }

uid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1"; }
tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
okflag() { python3 -c 'import sys,json
raw=open(sys.argv[1]).read().strip()
try:
 objs=[json.loads(l) for l in raw.splitlines() if l.strip()]
 print(objs[-1].get("ok"))
except Exception as e: print("NON-JSON")' "$1"; }

# verdict <name> <expected_fu> <expected_fa> <json-file> <template-uuid>
verdict() {
  local name="$1" efu="$2" efa="$3" f="$4" t="$5"
  local ok rule afu afa
  ok=$(okflag "$f")
  rule=$(rsum "$t" 2>/dev/null || echo NO-RULE)
  afu=$(echo "$rule" | sed -n 's/.*fu=\([0-9]*\).*/\1/p'); afa=$(echo "$rule" | sed -n 's/.*fa=\([0-9]*\).*/\1/p')
  local v="?"
  if [ "$ok" = "True" ]; then
    if [ "$afu" = "$efu" ] && [ "$afa" = "$efa" ]; then v="HONEST-SUCCESS"; else v="*** SILENT-WRONG ***"; fi
  elif [ "$ok" = "False" ]; then v="HONEST-FAILCLOSED"; else v="NON-JSON(bad)"; fi
  note "  [$name] ok=$ok requested=fu$efu/fa$efa landed=($rule) => $v"
}

# ================= seed subjects =================
note "############### seed subjects ###############"
for t in A B C D; do lab_ssh "$IP" "open 'things:///add?title=UIC7B-$t'; sleep 0.6" </dev/null; done

# ================= make-repeating interval guard (the core) =================
note "############### MR1: make FIXED weekly interval 1 (baseline) ###############"
warm; G todo make-repeating "$(uid UIC7B-A)" --frequency weekly --interval 1 --dangerously-drive-gui --json >"$OUT/json/mr1.json" 2>/dev/null || true
verdict MR1 256 1 "$OUT/json/mr1.json" "$(tmpl UIC7B-A)"

note "############### MR2: make FIXED weekly interval 2 (the interval-race unit) ###############"
warm; G todo make-repeating "$(uid UIC7B-B)" --frequency weekly --interval 2 --dangerously-drive-gui --json >"$OUT/json/mr2.json" 2>/dev/null || true
verdict MR2 256 2 "$OUT/json/mr2.json" "$(tmpl UIC7B-B)"

note "############### MR3: make FIXED monthly interval 3 (second unit) ###############"
warm; G todo make-repeating "$(uid UIC7B-C)" --frequency monthly --interval 3 --dangerously-drive-gui --json >"$OUT/json/mr3.json" 2>/dev/null || true
verdict MR3 8 3 "$OUT/json/mr3.json" "$(tmpl UIC7B-C)"

# ================= PLURAL after-completion unit label, LIVE (closes UIC7 (c) gap) =================
note "############### MR4a: make AFTER-COMPLETION weekly interval 2 (→ an interval-2 template) ###############"
warm; G todo make-repeating "$(uid UIC7B-D)" --after-completion --frequency weekly --interval 2 --dangerously-drive-gui --json >"$OUT/json/mr4a.json" 2>/dev/null || true
DT=$(tmpl UIC7B-D); verdict MR4a 256 2 "$OUT/json/mr4a.json" "$DT"
note "############### MR4b: reschedule that interval-2 AC rule -> AC MONTHLY interval 3 — dialog opens at interval 2, so the unit pop-up is PLURAL ('months') ###############"
warm; G todo reschedule-repeat "$DT" --after-completion --frequency monthly --interval 3 --dangerously-drive-gui --json >"$OUT/json/mr4b.json" 2>/dev/null || true
verdict MR4b 8 3 "$OUT/json/mr4b.json" "$DT"

note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 --"
note "INVARIANT: zero '*** SILENT-WRONG ***' lines above = PASS."
note "DONE. report: $REPORT ; json: $OUT/json/"
