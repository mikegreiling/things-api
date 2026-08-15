#!/bin/bash
# ANCH1-B — Phase B re-certification of the issue #476 fix (the FIXED dist).
# ONE fresh clone of things-lab-golden-v2 (AX baked, airgapped, clock pinned
# 2026-07-05 Sunday). Verifies, through the PRODUCTION CLI:
#   FIX1  the issue's wrong-phase repro now REFUSES fail-closed (H-REPEAT-ANCHOR),
#         zero mutation (make-repeating + add-repeating).
#   FIX2  an ON-PHASE request (--when = the app anchor 2026-07-08) SUCCEEDS: first
#         occurrence = requested; +clock-advance shows the interval-2 cadence (+14).
#   FIX3  weekday DERIVATION: weekly/1 with a Wednesday --when and NO --weekdays
#         drives Wednesday (of=[{wd:3}]), not the app's Sunday default.
#   FIX4  after-completion + --ends-after N SUCCEEDS (rc=N); after-completion +
#         --ends-on <date> is REFUSED before any mutation (assertRepeatRule).
#   CEN   best-effort dialog census (detached-window aware): fixed-weekly control
#         inventory (any first-occurrence date control?) + after-completion Ends items.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="anch1b-lab"
GOLDEN="things-lab-golden-v2"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/json" "$OUT/ax"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[anch1b] $*" | tee -a "$REPORT"; }
cleanup() { echo "[anch1b] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"; [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL <5GB"; exit 1; }

MAIN_WT=$(dirname "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null || true)
NODE_VER=$(awk '/nodejs/{print $2}' "$MAIN_WT/.tool-versions" .tool-versions "$HOME/.tool-versions" 2>/dev/null | head -1 || true)
CANDS=("$HOME/.asdf/installs/nodejs/$NODE_VER/bin"); CANDS+=( $(ls -d "$HOME"/.asdf/installs/nodejs/*/bin 2>/dev/null | sort -t/ -k7 -V -r) ); CANDS+=(/opt/homebrew/bin)
for cand in "${CANDS[@]}"; do [ -x "$cand/node" ] || continue; otool -L "$cand/node" 2>/dev/null | grep -q '/opt/homebrew/' && continue; export PATH="$cand:$PATH"; break; done
node --version >/dev/null 2>&1 || { note "FATAL no node"; exit 1; }
note "toolchain: node $(node --version)"
[ -d node_modules/commander ] || npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL npm ci"; exit 1; }

note "cloning $GOLDEN -> $VM"; tart delete "$VM" >/dev/null 2>&1 || true; tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
[ "$GRANT" = "2" ] || { note "FATAL AX grant=$GRANT"; exit 1; }

lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
lab_ssh "$IP" 'cat > /tmp/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib, datetime
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationCount FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row or row[0] is None: print("NO-RULE"); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]): offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s rc=%s of=[%s] next=%s icCount=%s"%(d.get('tp'),d.get('fu'),d.get('fa'),d.get('rc'),",".join(offs),dpk(row[1]),row[2]))
EOF
rsum() { lab_ssh "$IP" "python3 /tmp/rsum.py $1" </dev/null; }
liveinst(){ gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0"; }

# detached-window-aware AX dumper (headless: the dialog is an AXUnknown top window)
lab_ssh "$IP" 'cat > /tmp/axdump.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function sz(el){var z=attr(el,'AXSize');if(!z)return[0,0];var d=ObjC.castRefToObject($.CFCopyDescription(z)).js;var m=d.match(/w:([-0-9.]+) h:([-0-9.]+)/);return m?[+m[1],+m[2]]:[0,0]}
function appEl(){return $.AXUIElementCreateApplication(pidOf('Things3'))}
function line(el,d){var p=['role='+sv(el,'AXRole'),'sub='+sv(el,'AXSubrole')];var t=sv(el,'AXTitle');if(t)p.push('ttl='+t);var de=sv(el,'AXDescription');if(de)p.push('desc='+de);var rd=sv(el,'AXRoleDescription');if(rd)p.push('rdesc='+rd);var v=sv(el,'AXValue');if(v)p.push('val='+v);return Array(d+1).join('  ')+p.join(' | ')}
function walk(el,d,acc){acc.push(line(el,d));if(d>12)return acc;var ch=kids(el);for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc);return acc}
function findDialog(){
  var ws=kids(appEl())
  // 1) an attached AXSheet
  for(var i=0;i<ws.length;i++){var s=kids(ws[i]);for(var j=0;j<s.length;j++){if(sv(s[j],'AXRole')==='AXSheet')return s[j]}}
  // 2) a detached AXUnknown top window that is not the 40x40 utility window
  for(var i=0;i<ws.length;i++){if(sv(ws[i],'AXSubrole')==='AXUnknown'){var z=sz(ws[i]);if(!(z[0]===40&&z[1]===40))return ws[i]}}
  return null
}
function run(){var dg=findDialog();if(!dg)return 'NO-DIALOG';return walk(dg,0,[]).join('\n')}
EOF
axdump() { lab_ssh "$IP" 'osascript -l JavaScript /tmp/axdump.jxa' </dev/null; }

note "############### build + ship FIXED bundle ###############"
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
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$CLI $*" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1
uidt() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
warm()   { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 15; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
clock_to() { settle; lab_ssh "$IP" "sudo date $1 >/dev/null" </dev/null; note "  clock -> $(lab_ssh "$IP" 'date +%Y-%m-%d' </dev/null)"; warm; }
jd() { local n="$1"; shift; lab_ssh "$IP" "$CLI $* --json" </dev/null >"$OUT/json/$n.json" 2>"$OUT/json/$n.err"; echo "$?" >"$OUT/json/$n.exit"; note "  [$n] exit=$(cat "$OUT/json/$n.exit")  $(tr ',' '\n' <"$OUT/json/$n.json" | grep -m1 -iE '"code"|"templateUuid"' | head -c 90)"; }
jerr() { python3 - "$OUT/json/$1.json" "$2" <<'PY'
import json,sys
try: objs=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
except Exception: print(""); sys.exit()
d=objs[-1] if objs else {}
print((d.get("error",{}) or {}).get(sys.argv[2],""))
PY
}
jval() { python3 - "$OUT/json/$1.json" "$2" <<'PY'
import json,sys
try: objs=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
except Exception: print(""); sys.exit()
d=objs[-1] if objs else {}; cur=d.get("data",{})
for k in sys.argv[2].split('.'): cur=cur.get(k) if isinstance(cur,dict) else None
print(cur if cur is not None else "")
PY
}
note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"

# =================================================================== FIX1
note ""; note "### FIX1 — wrong-phase repro now REFUSES (make-repeating + add-repeating) ###"
G todo add \"AB-F1\" --when 2026-07-15 >/dev/null 2>&1; sleep 1
XF1=$(uidt "AB-F1")
warm
jd f1-make todo make-repeating "$XF1" --frequency weekly --interval 2 --weekdays wednesday
settle
note "  F1 make: code=$(jerr f1-make code)  X trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$XF1'") (want 0)  X hasRule=$(gq "SELECT (rt1_recurrenceRule IS NOT NULL) FROM TMTask WHERE uuid='$XF1'") (want 0)"
warm
jd f1-add todo add-repeating \"AB-F1b\" --when 2026-07-15 --frequency weekly --interval 2 --weekdays wednesday
settle
note "  F1 add: code=$(jerr f1-add code)  AB-F1b created? $(gq "SELECT COUNT(*) FROM TMTask WHERE title='AB-F1b'") (want 0)"

# =================================================================== FIX2
note ""; note "### FIX2 — ON-PHASE request (--when = app anchor 2026-07-08) SUCCEEDS; cadence +14 ###"
warm
jd f2 todo add-repeating \"AB-F2\" --when 2026-07-08 --frequency weekly --interval 2 --weekdays wednesday --dangerously-drive-gui
settle
TF2=$(jval f2 repeating.templateUuid)
note "  F2 template=$TF2  rule: $(rsum "$TF2")  (want next=2026-07-08 = requested)"
note "  F2 advance to 07-08 → instance spawns, cursor advances by +14 (07-22):"
clock_to 070612002026; clock_to 070712002026; clock_to 070812002026
note "  F2 @07-08 rule: $(rsum "$TF2")  liveInstances=$(liveinst "$TF2")"
clock_to 070512002026

# =================================================================== FIX3
note ""; note "### FIX3 — weekday DERIVED from --when (weekly/1, no --weekdays) → Wednesday, not Sunday ###"
warm
jd f3 todo add-repeating \"AB-F3\" --when 2026-07-15 --frequency weekly --interval 1 --dangerously-drive-gui
settle
TF3=$(jval f3 repeating.templateUuid)
note "  F3 template=$TF3  rule: $(rsum "$TF3")  (want of=[{wd=3}] Wednesday, next=2026-07-08)"

# =================================================================== FIX4
note ""; note "### FIX4 — after-completion Ends: --ends-after N OK; --ends-on <date> REFUSED pre-mutation ###"
G todo add \"AB-F4a\" >/dev/null 2>&1; sleep 1; XF4A=$(uidt "AB-F4a")
warm
jd f4-after todo make-repeating "$XF4A" --frequency weekly --interval 2 --after-completion --ends-after 5 --dangerously-drive-gui
settle
TF4A=$(jval f4-after repeating.templateUuid)
note "  F4 after-completion + ends-after 5: exit=$(cat "$OUT/json/f4-after.exit")  rule: $(rsum "$TF4A")  (want tp=1 rc=5)"
G todo add \"AB-F4b\" >/dev/null 2>&1; sleep 1; XF4B=$(uidt "AB-F4b")
warm
jd f4-ondate todo make-repeating "$XF4B" --frequency weekly --interval 2 --after-completion --ends-on 2026-12-30 --dangerously-drive-gui
settle
note "  F4 after-completion + ends-on: exit=$(cat "$OUT/json/f4-ondate.exit") (want !=0)  msg=$(jerr f4-ondate message | head -c 90)"
note "  F4 X (AB-F4b) untouched? trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$XF4B'") hasRule=$(gq "SELECT (rt1_recurrenceRule IS NOT NULL) FROM TMTask WHERE uuid='$XF4B'") (want 0/0)"

# =================================================================== CENSUS (best-effort)
note ""; note "### CEN — dialog census (best-effort, detached-window aware) ###"
G todo add \"AB-CEN\" --when 2026-07-15 >/dev/null 2>&1; sleep 1; XCEN=$(uidt "AB-CEN")
warm
lab_ssh "$IP" "open 'things:///show?id=$XCEN'; sleep 2" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\'' 2>/dev/null; sleep 1' </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu 1 of menu bar item "Items" of menu bar 1'\'' 2>>'"$OUT"'/ax/cen.err' </dev/null; sleep 2
note "  --- default-mode dialog census (as opened) ---"
axdump | tee "$OUT/ax/cen-default.txt" | sed 's/^/  /' | tee -a "$REPORT"
DT=$(grep -c 'AXDateTimeArea' "$OUT/ax/cen-default.txt" 2>/dev/null || echo "?")
note "  CEN: AXDateTimeArea controls in the default dialog = $DT (a first-occurrence date control would be a date/AXDateTimeArea beyond reminder/ends)"
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' 2>/dev/null' </dev/null; sleep 1
settle

note ""; note "### DONE. report: $REPORT  json: $OUT/json/  ax: $OUT/ax/"
