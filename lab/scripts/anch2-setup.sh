#!/bin/bash
# ANCH2 setup — connect to the already-running anch2-lab VM, airgap, pin clock,
# verify AX grant, install guest helpers, build+ship the production e2e bundle.
# Idempotent: safe to re-run. Leaves the VM running.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="anch2-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax" "$OUT/json"
REPORT="$OUT/setup.txt"; : > "$REPORT"
note() { echo "[anch2-setup] $*" | tee -a "$REPORT"; }

IP=$(tart ip "$VM" 2>/dev/null || true)
[ -n "$IP" ] || { note "FATAL: no IP for $VM (is it running?)"; exit 1; }
note "IP=$IP"
echo "$IP" > "$OUT/ip.txt"

# airgap + clock pin (Sunday 2026-07-05 12:00) — clock set before any Things use
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
note "airgap: $AG"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date' </dev/null)"
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "AX grant=$GRANT (want 2)"
[ "$GRANT" = "2" ] || { note "FATAL: AX grant missing"; exit 1; }

# ---- guest helpers ----
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

# decoded-rule dumper — fu/fa/tp/of + cursor + ia/sr(dates) + icStart/icCount + ed
lab_ssh "$IP" 'cat > /tmp/rsum.py' <<'EOF'
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
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] ia=%s sr=%s next=%s icStart=%s icCount=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),
    uxd(d.get('ia')),uxd(d.get('sr')),dpk(row[1]),dpk(row[2]),row[3]))
EOF

# live (non-trashed) instances of a template
lab_ssh "$IP" 'cat > /tmp/inst.py' <<'EOF'
import sys, sqlite3, glob
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
for u,sd,st,tr in c.execute("SELECT uuid,startDate,status,trashed FROM TMTask WHERE rt1_repeatingTemplate=? ORDER BY startDate",(sys.argv[1],)):
    print("  inst %s startDate=%s status=%s trashed=%s"%(u[:8],dpk(sd),st,tr))
EOF

# full-app AX tree dumper (walks EVERY window; captures sheets + detached AXUnknown).
# Prints role/subrole/title/desc/rdesc/value/id + position/size, and a trailing
# INDEXED list of every AXDateTimeArea in DFS order with its frame — the crux for
# determining which date control the by-role set-datetime primitive would target.
lab_ssh "$IP" 'cat > /tmp/axtree.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
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
  if(role==='AXDateTimeArea'){var f=frame(el);DT.push('  DT#'+DT.length+' @['+f.x+','+f.y+'] val='+sv(el,'AXValue')+' rdesc='+sv(el,'AXRoleDescription'))}
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

# set the Nth AXDateTimeArea (DFS order) in the front dialog — deterministic
# targeting probe. argv: <index> <spec>  spec = time:HH:mm | date:YYYY-MM-DD
lab_ssh "$IP" 'cat > /tmp/axsetdt.jxa' <<'EOF'
ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function rolestr(el){var v=attr(el,'AXRole');return v?v.js:''}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
var found=[]
function collect(el,d){if(d<0)return;if(rolestr(el)==='AXDateTimeArea')found.push(el);var ks=kids(el);for(var i=0;i<ks.length;i++)collect(ks[i],d-1)}
function run(argv){
  var idx=+argv[0]; var spec=argv[1]
  var apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.culturedcode.ThingsMac')
  if(!apps||apps.count===0)throw new Error('Things not running')
  var app=$.AXUIElementCreateApplication(apps.objectAtIndex(0).processIdentifier)
  for(var t=0;t<20 && found.length<=idx;t++){found=[];collect(app,16);if(found.length<=idx)$.NSThread.sleepForTimeInterval(0.1)}
  if(found.length<=idx)throw new Error('only '+found.length+' AXDateTimeArea found (need index '+idx+')')
  var dt=found[idx]; var cal=$.NSCalendar.currentCalendar; var d
  if(spec.indexOf('time:')===0){var cur=attr(dt,'AXValue');if(!cur)throw new Error('no value');var hm=spec.slice(5).split(':');d=cal.dateBySettingHourMinuteSecondOfDateOptions(+hm[0],+hm[1],0,cur,0)}
  else if(spec.indexOf('date:')===0){var ymd=spec.slice(5).split('-');var comps=$.NSDateComponents.alloc.init;comps.year=+ymd[0];comps.month=+ymd[1];comps.day=+ymd[2];comps.hour=0;comps.minute=0;comps.second=0;d=cal.dateFromComponents(comps)}
  else throw new Error('bad spec '+spec)
  if(!d)throw new Error('bad date')
  var err=$.AXUIElementSetAttributeValue(dt,$('AXValue'),d)
  if(err!==0)throw new Error('AXValue set err='+err)
  $.NSThread.sleepForTimeInterval(0.2)
  return 'OK set DT#'+idx+' of '+found.length+' to '+spec+' (readback='+String(attr(dt,'AXValue').js)+')'
}
EOF

note "guest helpers installed (/tmp/gsql.sh rsum.py inst.py axtree.jxa axsetdt.jxa)"

# ---- build + ship the production e2e bundle ----
note "build + ship bundle"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL build"; exit 1; }
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing"; exit 1; }
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
