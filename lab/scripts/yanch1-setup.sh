#!/bin/bash
# YANCH1 setup (issue #493) — bootstrap the running yanch1-lab clone (golden-v3 /
# Things 3.22.14): airgap, pin clock (Sun 2026-07-05 12:00), verify AX grant,
# install guest census helpers into ~/labh, ship the FIXED production dist bundle.
# Idempotent. Leaves the VM running.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="yanch1-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax" "$OUT/json"
REPORT="$OUT/setup.txt"; : > "$REPORT"
note() { echo "[yanch1-setup] $*" | tee -a "$REPORT"; }

IP=$(tart ip "$VM" 2>/dev/null || true)
[ -n "$IP" ] || { note "FATAL: no IP for $VM (is it running?)"; exit 1; }
note "IP=$IP"; echo "$IP" > "$OUT/ip.txt"

# airgap + clock pin (Sunday 2026-07-05 12:00) — before any Things use
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
note "airgap: $AG"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date' </dev/null)"
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "AX grant=$GRANT (want 2)"
[ "$GRANT" = "2" ] || { note "FATAL: AX grant missing"; exit 1; }

# ---- guest helpers into ~/labh (survive the /tmp cleaner on clock jumps) ----
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib, datetime
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
def uxd(v):
    try: v=float(v)
    except: return v
    return datetime.datetime.utcfromtimestamp(v).strftime("%Y-%m-%d")
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row or row[0] is None: print("NO-RULE"); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] ia=%s sr=%s next=%s icStart=%s icCount=%s deadline=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),
    uxd(d.get('ia')),uxd(d.get('sr')),dpk(row[1]),dpk(row[2]),row[3],row[4]))
EOF

# full-app AX tree dumper — walks every window, captures sheets + detached forms.
# Trailing INDEXED AXDateTimeArea inventory in DFS order with frame + role-desc +
# value + time-of-day — the crux for the deadline-mode date-area census.
lab_ssh "$IP" 'cat > ~/labh/axtree.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function tod(el){var v=attr(el,'AXValue');if(!v)return -1;try{var cal=$.NSCalendar.currentCalendar;return cal.componentFromDate($.NSCalendarUnitHour,v)*60+cal.componentFromDate($.NSCalendarUnitMinute,v)}catch(e){return -1}}
function frame(el){var p=attr(el,'AXPosition'),z=attr(el,'AXSize');function d(x){if(!x)return null;return ObjC.castRefToObject($.CFCopyDescription(x)).js}
  var pp=d(p),zz=d(z);var mp=pp&&pp.match(/x:([-0-9.]+) y:([-0-9.]+)/);var mz=zz&&zz.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return {x:mp?+mp[1]:null,y:mp?+mp[2]:null,w:mz?+mz[1]:null,h:mz?+mz[2]:null}}
function appEl(){return $.AXUIElementCreateApplication(pidOf('Things3'))}
var DT=[]
function line(el,d){
  var p=['role='+sv(el,'AXRole')]
  var sub=sv(el,'AXSubrole'); if(sub)p.push('sub='+sub)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de)
  var rd=sv(el,'AXRoleDescription'); if(rd)p.push('rdesc='+rd)
  var v=sv(el,'AXValue'); if(v)p.push('val='+v)
  var id=sv(el,'AXIdentifier'); if(id)p.push('id='+id)
  var f=frame(el); if(f.x!==null)p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']')
  return Array(d+1).join('  ')+p.join(' | ')
}
function walk(el,d,acc){
  var role=sv(el,'AXRole')
  if(role==='AXDateTimeArea'){var f=frame(el);DT.push('  DT#'+DT.length+' @['+f.x+','+f.y+'] rdesc='+sv(el,'AXRoleDescription')+' tod='+tod(el)+' val='+sv(el,'AXValue'))}
  acc.push(line(el,d)); if(d>16)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc); return acc
}
function run(){
  var app=appEl(); var ws=kids(app); var acc=['=== APP TREE (windows='+ws.length+') ===']
  for(var i=0;i<ws.length;i++){acc.push('--- window '+i+' role='+sv(ws[i],'AXRole')+' sub='+sv(ws[i],'AXSubrole')+' ttl='+sv(ws[i],'AXTitle')+' ---'); walk(ws[i],0,acc)}
  acc.push('=== AXDateTimeArea INVENTORY (DFS order) count='+DT.length+' ===')
  for(var k=0;k<DT.length;k++)acc.push(DT[k])
  return acc.join('\n')
}
EOF

note "guest helpers installed (~/labh/gsql.sh rsum.py axtree.jxa)"

# ---- build + ship the FIXED production e2e bundle ----
note "ship FIXED dist bundle"
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing (run npm run build)"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1 || { note "FATAL: guest node not runnable"; exit 1; }
lab_ssh "$IP" '~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js config set ui-enabled true' </dev/null >/dev/null 2>&1
note "bundle shipped; ui-enabled=true. Things version: $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)"
note "SETUP DONE."
