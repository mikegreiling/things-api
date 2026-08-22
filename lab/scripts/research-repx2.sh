#!/bin/bash
# REPX2 — the Things 3.23 Make-Exception chooser, JIT edge cases, and the
# template-`when` crash re-probe.
#
# The maintainer discovered the chooser's REAL trigger path: it is raised by a
# scheduling edit on a PROJECTION row (the template's pseudo-JIT row in
# Upcoming), driven from `Items ▸ When…` / `Items ▸ Deadline…` — NOT by any edit
# to a materialized INSTANCE, which is what REPX1's five vectors all hit.
#
#   A  the chooser for WHEN, both branches. A0 census (Items menu + the When
#      picker on a projection), A1 Make Exception (+ the KEY question: is the
#      rule slot consumed?), A2 Update Rule (vs the Edit Rule… shape),
#      A3 Cancel (must be inert).
#   B  the chooser for DEADLINE (B1) and REMINDER (B2).
#   C  projection edits that allegedly do nothing: title, notes, tag, checklist.
#   D  JIT chaining: D1 consecutive projection check-offs, D2 the sanctioned
#      Create Next Copy + complete approximation, D3 the app's own ⌘Z.
#   E  the template-`when` crash (oddities §1 / §7 C1, suite U12/R09/A21),
#      re-probed on 3.23 / golden-v4.
#   F  reminder + When-picker UI re-census (F1) and URL natural-language `when=`
#      acceptance (F2).
#
# METHOD: disposable clone(s) of things-lab-golden-v4 (Things 3.23, DB v27; the
# golden is never booted). Airgap, clock pinned 2026-07-05 (a Sunday); cells
# advance it. Fixtures fully synthetic (REPX2-*). DB oracle = FULL TMTask row
# snapshots (every column, packed dates decoded, blobs hashed) diffed either
# side of every gesture. Teardown on EXIT (KEEP=1 keeps it, REUSE=1 attaches).
#
# Usage:  CELLS="A0 A1 A2 A3" VM=repx2-lab lab/scripts/research-repx2.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-repx2-lab}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/ax" "$OUT/snap"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-A0 A1 A2 A3 B1 B2 C D1 D2 D3 E F1 F2}"
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[repx2] $*" | tee -a "$REPORT"; }
has_cell() { case " $CELLS " in *" $1 "*) return 0;; *) return 1;; esac; }

GOLDEN="${GOLDEN:-things-lab-golden-v4}"
IP=""
if [ "$REUSE" = "1" ]; then
  IP="$(tart ip "$VM" 2>/dev/null || true)"
  if [ -n "$IP" ] && lab_ssh "$IP" true 2>/dev/null; then
    note "REUSE=1 — attached to running $VM at $IP"
  else
    IP=""
  fi
fi

if [ -z "$IP" ]; then
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }
  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
  MUTED=$(lab_ssh "$IP" "osascript -e 'output muted of (get volume settings)'" </dev/null)
  note "guest audio muted = $MUTED (boot-helper verification)"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
  BOOTSTRAP=1
else
  BOOTSTRAP=0
fi

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM running at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------------------------------------------------------------- guest helpers
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }

# rule summary (decodes rt1_recurrenceRule) — the RDLG2/REPX1 helper
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, startDate, rt1_instanceCreationPaused, rt1_afterCompletionReferenceDate, reminderTime FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
if row[0] is None:
    print("NO-RULE next=%s icStart=%s icCount=%s deadline=%s startDate=%s rem=%s"%(dpk(row[1]),dpk(row[2]),row[3],dpk(row[4]),dpk(row[5]),row[8])); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] next=%s icStart=%s icCount=%s paused=%s deadline=%s acRef=%s rem=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),
    dpk(row[1]),dpk(row[2]),row[3],row[6],dpk(row[4]),row[7],row[8]))
EOF
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py $1" </dev/null 2>&1; }

# FULL-ROW snapshot: every TMTask column for the rows matching a title LIKE.
lab_ssh "$IP" 'cat > ~/labh/rowsnap.py' <<'EOF'
import sys, sqlite3, glob, hashlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True); c.row_factory=sqlite3.Row
DATECOLS={'startDate','deadline','stopDate','rt1_nextInstanceStartDate','rt1_instanceCreationStartDate','todayIndexReferenceDate'}
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%s(%04d-%02d-%02d)"%(v,y,m,d) if 1<y<5000 else v
rows=c.execute("SELECT * FROM TMTask WHERE title LIKE ? ORDER BY creationDate, uuid",(sys.argv[1],)).fetchall()
for r in rows:
    for k in r.keys():
        v=r[k]
        if isinstance(v,bytes): v='blob:sha256:'+hashlib.sha256(v).hexdigest()[:16]+':len'+str(len(v))
        elif k in DATECOLS: v=dpk(v)
        print("%s\t%s\t%s"%(r['uuid'],k,v))
EOF
snap() { # snap <name> <titleLike>
  lab_ssh "$IP" "python3 ~/labh/rowsnap.py $(printf '%q' "$2")" </dev/null > "$OUT/snap/$1.tsv" 2>&1
  note "  [snap $1: $(wc -l <"$OUT/snap/$1.tsv"|tr -d ' ') field-lines, $(cut -f1 "$OUT/snap/$1.tsv"|sort -u|wc -l|tr -d ' ') rows]"
}
snapdiff() { # snapdiff <before> <after> [label]
  note "  ---- ROW DELTA ${3:-$1 -> $2} ----"
  python3 - "$OUT/snap/$1.tsv" "$OUT/snap/$2.tsv" <<'PY' | tee -a "$REPORT"
import sys
NOISE={"None",""}
def load(p):
    d={}; order=[]
    for line in open(p):
        parts=line.rstrip("\n").split("\t")
        if len(parts)<3: continue
        k=(parts[0],parts[1])
        if k not in d: order.append(k)
        d[k]=parts[2]
    return d,order
b,_=load(sys.argv[1]); a,ao=load(sys.argv[2])
bu={k[0] for k in b}; au={k[0] for k in a}
for u in sorted(bu-au): print("    DELETED row %s"%u)
for u in sorted(au-bu):
    print("    INSERTED row %s:"%u)
    for k in ao:
        if k[0]==u and a[k] not in NOISE: print("      %s = %s"%(k[1],a[k]))
both=bu&au
ch=[(k,b[k],a[k]) for k in sorted(b) if k[0] in both and k in a and a[k]!=b[k]]
if not ch: print("    (no field changed on any surviving row)")
for (u,col),ov,nv in ch: print("    CHANGED %s.%s: %s -> %s"%(u[:8],col,ov,nv))
print("    (rows in both: %d; fields compared: %d)"%(len(both),len([k for k in b if k[0] in both])))
PY
}

# D2 needs a SHAPE comparison across two independently-built fixtures: same
# columns, different uuids/titles/timestamps. Normalize the identity + wall-clock
# columns away and diff what is left, row by row in creation order.
shapecmp() { # shapecmp <snapA> <snapB> <labelA> <labelB>
  note "  ---- SHAPE COMPARISON ${3:-$1} vs ${4:-$2} ----"
  python3 - "$OUT/snap/$1.tsv" "$OUT/snap/$2.tsv" <<'PY' | tee -a "$REPORT"
import sys
# identity + wall-clock columns cannot match across two fixtures by construction
SKIP={'uuid','title','creationDate','userModificationDate','stopDate','index',
      'todayIndex','rt1_repeatingTemplate','experimental','cachedTags'}
def load(p):
    rows={}; order=[]
    for line in open(p):
        parts=line.rstrip("\n").split("\t")
        if len(parts)<3: continue
        u,c,v=parts[0],parts[1],parts[2]
        if u not in rows: rows[u]={}; order.append(u)
        rows[u][c]=v
    return [rows[u] for u in order]
A=load(sys.argv[1]); B=load(sys.argv[2])
print("    rows: A=%d B=%d"%(len(A),len(B)))
if len(A)!=len(B) or not A:
    print("    DIFFERENT ROW COUNT — shapes are not equivalent"); sys.exit(0)
diffs=0
for i,(ra,rb) in enumerate(zip(A,B)):
    for c in sorted(set(ra)|set(rb)):
        if c in SKIP: continue
        va,vb=ra.get(c),rb.get(c)
        if va!=vb:
            diffs+=1
            print("    row%d.%s: A=%s  B=%s"%(i,c,va,vb))
print("    VERDICT: %s (%d comparable columns/row, %d differing)"%(
    "BYTE-EQUIVALENT (modulo identity + wall-clock columns)" if diffs==0 else "NOT equivalent",
    len(set(A[0])-SKIP), diffs))
PY
}

axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
relaunch() { lab_ssh "$IP" 'open -a Things3; sleep 22; true' </dev/null; }
quitapp() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 4; true' </dev/null; }
setclock() { # setclock MMDDhhmmYYYY  (quits the app first, relaunches after)
  quitapp
  lab_ssh "$IP" "sudo date $1 >/dev/null; date" </dev/null | sed 's/^/    clock now: /' | tee -a "$REPORT"
  relaunch
}
crashes() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3-*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }

# AX dumps ------------------------------------------------------------------
lab_ssh "$IP" 'cat > ~/labh/sheet.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function frame(el){var p=attr(el,'AXPosition'),z=attr(el,'AXSize');function d(x){if(!x)return null;return ObjC.castRefToObject($.CFCopyDescription(x)).js}
  var pp=d(p),zz=d(z);var mp=pp&&pp.match(/x:([-0-9.]+) y:([-0-9.]+)/);var mz=zz&&zz.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return {x:mp?+mp[1]:null,y:mp?+mp[2]:null,w:mz?+mz[1]:null,h:mz?+mz[2]:null}}
function line(el,d,ix){
  var p=['['+ix+'] role='+sv(el,'AXRole')]
  var s=sv(el,'AXSubrole'); if(s)p.push('sub='+s)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de)
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,120))
  var id=sv(el,'AXIdentifier'); if(id)p.push('id='+id)
  var en=sv(el,'AXEnabled'); if(en==='false')p.push('DISABLED')
  var f=frame(el); if(f.x!==null)p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']')
  return Array(d+1).join('  ')+p.join(' | ')}
function walk(el,d,acc,ix){acc.push(line(el,d,ix)); if(d>14)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc,i+1); return acc}
function run(){
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var ws=kids(app); var acc=[]
  for(var i=0;i<ws.length;i++){
    var w=ws[i], f=frame(w)
    var sub=sv(w,'AXSubrole')
    if(sub!=='AXStandardWindow' && !(f.w===40&&f.h===40)){acc.push('=== DETACHED WINDOW '+(i+1)+' sub='+sub+' ttl='+sv(w,'AXTitle')+' id='+sv(w,'AXIdentifier')+' @['+f.x+','+f.y+' '+f.w+'x'+f.h+'] ==='); walk(w,0,acc,i+1)}
    var ch=kids(w)
    for(var j=0;j<ch.length;j++){
      var r=sv(ch[j],'AXRole')
      if(r==='AXSheet'||r==='AXPopover'){acc.push('=== '+r+' (child '+(j+1)+' of window '+(i+1)+' "'+sv(w,'AXTitle')+'") ==='); walk(ch[j],0,acc,j+1)}
    }
  }
  if(!acc.length) acc.push('(no sheet / popover / detached dialog present)')
  return acc.join('\n')}
EOF

# Full main-window content walk with supported actions (REPX1's rowcensus).
lab_ssh "$IP" 'cat > ~/labh/rowcensus.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function acts(el){var o=Ref();if($.AXUIElementCopyActionNames(el,o)!==0)return [];var arr=ObjC.castRefToObject(o[0]);var a=[];for(var i=0;i<arr.count;i++)a.push(String(arr.objectAtIndex(i).js));return a}
function frame(el){var p=attr(el,'AXPosition'),z=attr(el,'AXSize');function d(x){if(!x)return null;return ObjC.castRefToObject($.CFCopyDescription(x)).js}
  var pp=d(p),zz=d(z);var mp=pp&&pp.match(/x:([-0-9.]+) y:([-0-9.]+)/);var mz=zz&&zz.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return {x:mp?+mp[1]:null,y:mp?+mp[2]:null,w:mz?+mz[1]:null,h:mz?+mz[2]:null}}
function line(el,d,ix){
  var p=['['+ix+'] role='+sv(el,'AXRole')]
  var s=sv(el,'AXSubrole'); if(s)p.push('sub='+s)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de.slice(0,120))
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,100))
  var id=sv(el,'AXIdentifier'); if(id)p.push('id='+id)
  var a=acts(el); if(a.length)p.push('ACTIONS='+a.join(','))
  var f=frame(el); if(f.x!==null)p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']')
  return Array(d+1).join('  ')+p.join(' | ')}
function walk(el,d,acc,ix){acc.push(line(el,d,ix)); if(d>18)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc,i+1); return acc}
function run(){
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var ws=kids(app); var acc=[]
  for(var i=0;i<ws.length;i++){
    var w=ws[i]
    if(sv(w,'AXSubrole')!=='AXStandardWindow') continue
    acc.push('=== MAIN WINDOW "'+sv(w,'AXTitle')+'" ==='); walk(w,0,acc,i+1)
  }
  if(!acc.length) acc.push('(no standard window)')
  return acc.join('\n')}
EOF

# REPX1's LIVE vector: a synthesized CGEvent click at an element's AX frame.
lab_ssh "$IP" 'cat > ~/labh/clickrow.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function flat(el,acc,d){acc.push(el); if(d>18)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)flat(ch[i],acc,d+1); return acc}
function frame(el){var p=attr(el,'AXPosition'),z=attr(el,'AXSize');function d(x){if(!x)return null;return ObjC.castRefToObject($.CFCopyDescription(x)).js}
  var pp=d(p),zz=d(z);var mp=pp&&pp.match(/x:([-0-9.]+) y:([-0-9.]+)/);var mz=zz&&zz.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return {x:mp?+mp[1]:null,y:mp?+mp[2]:null,w:mz?+mz[1]:null,h:mz?+mz[2]:null}}
function run(argv){
  var needle=argv[0], want=argv[1]||'Checkbox', mod=argv[2]||''
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var all=[]; flat(app,all,0)
  var rows=all.filter(function(e){return sv(e,'AXSubrole')==='AXTableRow'})
  for(var i=0;i<rows.length;i++){
    var sub=[]; flat(rows[i],sub,0)
    if(!sub.some(function(e){return sv(e,'AXDescription').indexOf(needle)>=0})) continue
    var hits = want==='TITLE'
      ? sub.filter(function(e){return sv(e,'AXDescription').indexOf(needle)>=0})
      : sub.filter(function(e){return sv(e,'AXDescription')===want})
    if(!hits.length) return 'row found ('+sub.length+' descendants), no element described '+want
    var f=frame(hits[0]); var x=f.x+f.w/2, y=f.y+f.h/2
    var pt=$.CGPointMake(x,y)
    var flags = mod==='shift' ? $.kCGEventFlagMaskShift : 0
    function post(type){
      var ev=$.CGEventCreateMouseEvent($(), type, pt, $.kCGMouseButtonLeft)
      if(flags) $.CGEventSetFlags(ev, flags)
      $.CGEventPost($.kCGHIDEventTap, ev)
    }
    post($.kCGEventMouseMoved); delay(0.3)
    post($.kCGEventLeftMouseDown); delay(0.12)
    post($.kCGEventLeftMouseUp)
    return 'CLICKED'+(mod?'('+mod+')':'')+' '+want+' of the '+needle+' row at ('+x+','+y+') [row '+(i+1)+' of '+rows.length+']'
  }
  return 'no AXTableRow subtree mentions '+needle+' (rows scanned: '+rows.length+')'
}
EOF
clickrow() {
  local m=""; [ "${SHIFT:-0}" = "1" ] && m="shift"
  lab_ssh "$IP" "osascript -l JavaScript ~/labh/clickrow.jxa $(printf '%q' "$1") $(printf '%q' "${2:-Checkbox}") $(printf '%q' "$m")" </dev/null 2>&1
}

# Press a button by TITLE anywhere in the app's AX tree (sheets, popovers and
# detached windows all included) — the chooser's container is unknown a priori.
lab_ssh "$IP" 'cat > ~/labh/pressbtn.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function flat(el,acc,d){acc.push(el); if(d>18)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)flat(ch[i],acc,d+1); return acc}
function run(argv){
  var want=argv[0]
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var all=[]; flat(app,all,0)
  var btns=all.filter(function(e){return sv(e,'AXRole')==='AXButton'})
  var names=btns.map(function(e){return (sv(e,'AXTitle')||sv(e,'AXDescription')||'?')+'#'+sv(e,'AXIdentifier')})
  for(var i=0;i<btns.length;i++){
    if(sv(btns[i],'AXTitle')===want || sv(btns[i],'AXIdentifier')===want){
      var rc=$.AXUIElementPerformAction(btns[i],$('AXPress'))
      return 'PRESSED "'+want+'" (AXError='+rc+'); buttons present: '+names.join(' | ')
    }
  }
  return 'NO BUTTON "'+want+'" — buttons present: '+names.join(' | ')
}
EOF
pressbtn() { lab_ssh "$IP" "osascript -l JavaScript ~/labh/pressbtn.jxa $(printf '%q' "$1")" </dev/null 2>&1; }

sheetdump() { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; note "  [dump $1: $(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines, $(grep -cE '^=== ' "$OUT/ax/$1.txt") containers]"; }
sheetshow() { sed 's/^/      /' "$OUT/ax/$1.txt" | tee -a "$REPORT" >/dev/null; grep -E '^=== |AXButton|AXStaticText|AXTextField|AXPopUpButton|AXCheckBox' "$OUT/ax/$1.txt" | sed 's/^/      /' | head -50 | tee -a "$REPORT"; }
windump()  { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/rowcensus.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; note "  [windump $1: $(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines]"; }

typetext() { lab_ssh "$IP" "osascript -e $(printf '%q' "tell application \"System Events\" to keystroke \"$1\"")" </dev/null 2>&1; lab_ssh "$IP" 'sleep 2' </dev/null; }
keyret()   { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 36'\''; sleep 4' </dev/null; }

# The 3.23 When/Deadline pickers are natural-language search fields: typing
# filters to ONE resolved row. Never commit blind — type, READ BACK the resolved
# row, and only then let the caller press Return. Tries phrases in order.
#   pickdate <expected-substring-of-the-resolved-row> <phrase> [<phrase> …]
pickdate() {
  local want="$1"; shift
  local p
  for p in "$@"; do
    lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "a" using command down'\''; sleep 1' </dev/null
    typetext "$p" >/dev/null
    lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa' </dev/null > "$OUT/ax/pick-last.txt" 2>&1
    if grep -q "desc=$want" "$OUT/ax/pick-last.txt"; then
      note "    picker RESOLVED '$p' -> $(grep -o "desc=$want[^|]*" "$OUT/ax/pick-last.txt" | head -1)"
      return 0
    fi
    note "    picker did NOT resolve '$p' (no row described '$want'); offered: $(grep -o 'desc=[^|]*' "$OUT/ax/pick-last.txt" | head -6 | tr '\n' ' ')"
  done
  note "    FATAL for this cell: no phrase resolved to '$want'"
  return 1
}

select_item() {
  local uuid="$1" want="$2" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get id of selected to dos' 2>/dev/null)
    if [ "$sel" = "$want" ]; then note "  selection OK by UUID on attempt $i"; return 0; fi
    note "  selection attempt $i -> '$sel' (want '$want')"
  done
  return 1
}

# Select the PROJECTION row of a template by clicking its title in Upcoming,
# then VERIFY by uuid (REPX1 §5.1's lesson: titles are shared across a series).
select_projection() { # select_projection <titleNeedle> <templateUuid>
  local needle="$1" tmpl="$2" sel
  lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  clickrow "$needle" "TITLE" | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 2' </dev/null
  sel=$(axq 'tell application "Things3" to get id of selected to dos' 2>/dev/null)
  if [ "$sel" = "$tmpl" ]; then
    note "    PROJECTION selected — selection uuid == TEMPLATE uuid ($sel)"; return 0
  fi
  note "    WARN: selection uuid = '$sel' (template is $tmpl) — falling back to show?id="
  select_item "$tmpl" "$tmpl" && return 0
  return 1
}

itemsmenu() {
  axq 'tell application "System Events" to tell process "Things3"
    click menu bar item "Items" of menu bar 1
    delay 1
    set out to ""
    repeat with mi in (menu items of menu "Items" of menu bar 1)
      try
        set nm to name of mi
        if nm is missing value then set nm to "(separator)"
        set out to out & "      " & nm & "  enabled=" & (enabled of mi) & "  submenu=" & (exists menu 1 of mi) & linefeed
      end try
    end repeat
    key code 53
    return out
  end tell'
}

clickitem() { # clickitem <menu item name>
  axq "tell application \"System Events\" to tell process \"Things3\" to click menu item \"$1\" of menu \"Items\" of menu bar 1" 2>&1
  lab_ssh "$IP" 'sleep 3' </dev/null
}

# mkrepeat <uuid> <title> <frequency> — promote to a series via Items ▸ Repeat….
mkrepeat() {
  local uuid="$1" title="$2" freq="$3"
  select_item "$uuid" "$uuid" || note "  WARN: selection never confirmed for $title"
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  axq "tell application \"System Events\" to tell process \"Things3\"
    set sh to sheet 1 of (first window whose subrole is \"AXStandardWindow\")
    set p to pop up button 1 of sh
    repeat 20 times
      if (exists menu 1 of p) then exit repeat
      click p
      delay 0.3
    end repeat
    click menu item \"$freq\" of menu 1 of p
    delay 1.5
    return \"frequency = $freq\"
  end tell" | sed 's/^/    /' | tee -a "$REPORT"
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    click button "OK" of sh
    delay 2
    return "pressed OK"
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 6' </dev/null
}

seriesrows() { # seriesrows <templateUuid>
  gt "SELECT substr(uuid,1,8) AS uuid8, title, status, trashed, start, startDate, deadline, reminderTime AS rem, stopDate IS NOT NULL AS stopped, rt1_repeatingTemplate IS NOT NULL AS isinst FROM TMTask WHERE uuid='$1' OR rt1_repeatingTemplate='$1' ORDER BY creationDate" | sed 's/^/    /' | tee -a "$REPORT"
}

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" 2>/dev/null || gq "SELECT databaseVersion FROM Meta")
note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN / dbv $DBV"
note "cells: $CELLS"

mkurl() { # mkurl <title> <when>
  lab_ssh "$IP" "open -g 'things:///add?title=$1&when=$2&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"
}

# mkseries <name> [freq] -> echoes the template uuid; leaves a daily series with
# an instance dated today (07-05) and the projection cursor on 07-06.
mkseries() {
  local nm="$1" freq="${2:-daily}" seed tmpl
  seed=$(mkurl "$nm" "2026-07-05")
  mkrepeat "$seed" "$nm" "$freq" >/dev/null
  tmpl=$(gq "SELECT uuid FROM TMTask WHERE title='$nm' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  echo "$tmpl"
}

[ "$BOOTSTRAP" = "1" ] && warm

# =====================================================================
# A0 — the CENSUS the whole campaign rests on: what does a PROJECTION row's
# selection offer, and what do the When / Deadline pickers look like on 3.23?
if has_cell A0; then
note ""; note "########## CELL A0 — the projection-row selection census ##########"
warm
A0_TMPL=$(mkseries "REPX2-A0-DAILY")
note "  template=$A0_TMPL rule: $(rsum "$A0_TMPL")"
note "  series rows:"; seriesrows "$A0_TMPL"

note ""; note "  --- Upcoming: the projection row, with actions ---"
lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
windump "a0-upcoming"
grep -n "REPX2-A0-DAILY" "$OUT/ax/a0-upcoming.txt" | sed 's/^/    /' | tee -a "$REPORT"

note ""; note "  --- census 1: the Items menu with the PROJECTION highlighted ---"
select_projection "REPX2-A0-DAILY" "$A0_TMPL"
itemsmenu | tee -a "$REPORT"

note ""; note "  --- census 2: the Items menu with an ORDINARY to-do selected (control) ---"
A0_PLAIN=$(mkurl "REPX2-A0-PLAIN" "2026-07-08")
select_item "$A0_PLAIN" "$A0_PLAIN" >/dev/null
itemsmenu | tee -a "$REPORT"

note ""; note "  --- census 3: the When picker on an ORDINARY to-do (unfiltered) — F1 input ---"
clickitem "When…" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "a0-when-ordinary"
sheetshow "a0-when-ordinary"
note "  --- and after typing a natural-language phrase ---"
typetext "next thursday" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "a0-when-ordinary-nl"
sheetshow "a0-when-ordinary-nl"
esc; esc
note "  ordinary to-do after ESC (must be unmoved): $(gt "SELECT start, startDate, reminderTime FROM TMTask WHERE uuid='$A0_PLAIN'" | tr '\n' ' ')"

note ""; note "  --- census 4: the When picker on the PROJECTION ---"
select_projection "REPX2-A0-DAILY" "$A0_TMPL"
snap "a0-0-before" "REPX2-A0-DAILY%"
clickitem "When…" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "a0-when-projection"
sheetshow "a0-when-projection"
esc; esc
snap "a0-1-after" "REPX2-A0-DAILY%"
snapdiff "a0-0-before" "a0-1-after" "A0 — opening and ESCAPING the When picker on a projection (must be inert)"
note "  app alive: $(alive)"

note ""; note "  --- census 5: the Deadline picker on the PROJECTION ---"
select_projection "REPX2-A0-DAILY" "$A0_TMPL"
clickitem "Deadline…" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "a0-deadline-projection"
sheetshow "a0-deadline-projection"
esc; esc
snap "a0-2-after-dl" "REPX2-A0-DAILY%"
snapdiff "a0-1-after" "a0-2-after-dl" "A0 — opening and ESCAPING the Deadline picker on a projection (must be inert)"
note "  app alive: $(alive)"
fi

# =====================================================================
# A1 — the chooser, WHEN, "Make Exception". THE key cell: does the exception
# CONSUME the rule slot?
if has_cell A1; then
note ""; note "########## CELL A1 — Items ▸ When… on a PROJECTION, branch = Make Exception ##########"
setclock "070512002026"; warm
A1_TMPL=$(mkseries "REPX2-A1-DAILY")
A1_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$A1_TMPL' AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
note "  template=$A1_TMPL  current instance=$A1_INST (dated 07-05)"
note "  rule: $(rsum "$A1_TMPL")   <- the projection cursor is the slot we will move"
note "  series rows:"; seriesrows "$A1_TMPL"
snap "a1-0-before" "REPX2-A1-DAILY%"

select_projection "REPX2-A1-DAILY" "$A1_TMPL"
clickitem "When…" | sed 's/^/    /' | tee -a "$REPORT"
note "  typing the target date (2026-07-09 — a FREE day, 3 slots past the cursor):"
pickdate "Thu, Jul 9" "July 9, 2026" "in 4 days" "july 9" "9 jul 2026"
sheetdump "a1-when-typed"
note "  committing with RETURN:"
keyret
sheetdump "a1-chooser"
note "  ===== THE CHOOSER ====="
sed 's/^/      /' "$OUT/ax/a1-chooser.txt" | tee -a "$REPORT"
snap "a1-1-chooser-open" "REPX2-A1-DAILY%"
snapdiff "a1-0-before" "a1-1-chooser-open" "A1 — with the chooser OPEN, before any branch is taken"

note ""; note "  --- pressing MAKE EXCEPTION ---"
pressbtn "Make Exception" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
snap "a1-2-exception" "REPX2-A1-DAILY%"
snapdiff "a1-1-chooser-open" "a1-2-exception" "A1 — Make Exception"
note "  template after: $(rsum "$A1_TMPL")"
note "  series rows:"; seriesrows "$A1_TMPL"
note "  app alive: $(alive)"
sheetdump "a1-after-exception"
note "  --- durability: +20s then a relaunch ---"
lab_ssh "$IP" 'sleep 20' </dev/null
quitapp; relaunch
snap "a1-3-relaunch" "REPX2-A1-DAILY%"
snapdiff "a1-2-exception" "a1-3-relaunch" "A1 — across a relaunch"
note "  template: $(rsum "$A1_TMPL")"
note "  series rows:"; seriesrows "$A1_TMPL"

note ""; note "  ===== THE KEY QUESTION: is the ORIGINAL slot (07-06) consumed? ====="
setclock "070612002026"
snap "a1-4-day06" "REPX2-A1-DAILY%"
snapdiff "a1-3-relaunch" "a1-4-day06" "A1 — clock reaches the ORIGINAL slot 2026-07-06"
note "  template: $(rsum "$A1_TMPL")"
note "  series rows:"; seriesrows "$A1_TMPL"
note "  VERDICT INPUT: untrashed series rows dated 2026-07-06 = $(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$A1_TMPL' AND trashed=0 AND startDate=$(( (2026<<16) | (7<<12) | (6<<7) ))")"
note "  --- and one more day (07-07), to see the cursor's ordinary cadence ---"
setclock "070712002026"
snap "a1-5-day07" "REPX2-A1-DAILY%"
snapdiff "a1-4-day06" "a1-5-day07" "A1 — clock 2026-07-07"
note "  template: $(rsum "$A1_TMPL")"
note "  series rows:"; seriesrows "$A1_TMPL"
setclock "070512002026"
fi

# =====================================================================
if has_cell A2; then
note ""; note "########## CELL A2 — the same gesture, branch = Update Rule ##########"
setclock "070512002026"; warm
A2_TMPL=$(mkseries "REPX2-A2-DAILY")
note "  template=$A2_TMPL rule BEFORE: $(rsum "$A2_TMPL")"
note "  series rows:"; seriesrows "$A2_TMPL"
snap "a2-0-before" "REPX2-A2-DAILY%"

select_projection "REPX2-A2-DAILY" "$A2_TMPL"
clickitem "When…" | sed 's/^/    /' | tee -a "$REPORT"
pickdate "Thu, Jul 9" "July 9, 2026" "in 4 days" "july 9" "9 jul 2026"
sheetdump "a2-when-typed"
keyret
sheetdump "a2-chooser"
sed 's/^/      /' "$OUT/ax/a2-chooser.txt" | tee -a "$REPORT"
note ""; note "  --- pressing UPDATE RULE ---"
pressbtn "Update Rule" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
snap "a2-1-updaterule" "REPX2-A2-DAILY%"
snapdiff "a2-0-before" "a2-1-updaterule" "A2 — Update Rule"
note "  template AFTER: $(rsum "$A2_TMPL")"
note "  series rows:"; seriesrows "$A2_TMPL"
note "  app alive: $(alive)"
note ""; note "  --- does Update Rule RE-ANCHOR the cursor? (Edit Rule… does NOT — REPX1 §4) ---"
note "  packed refs: 07-06=$(( (2026<<16) | (7<<12) | (6<<7) ))  07-09=$(( (2026<<16) | (7<<12) | (9<<7) ))  07-10=$(( (2026<<16) | (7<<12) | (10<<7) ))"
note "  --- clock 07-06: does the OLD phase still spawn? ---"
setclock "070612002026"
snap "a2-2-day06" "REPX2-A2-DAILY%"
snapdiff "a2-1-updaterule" "a2-2-day06" "A2 — clock 2026-07-06 after Update Rule"
note "  template: $(rsum "$A2_TMPL")"
note "  series rows:"; seriesrows "$A2_TMPL"
setclock "070512002026"
fi

# =====================================================================
if has_cell A3; then
note ""; note "########## CELL A3 — the same gesture, branch = Cancel (must be inert) ##########"
setclock "070512002026"; warm
A3_TMPL=$(mkseries "REPX2-A3-DAILY")
note "  template=$A3_TMPL rule: $(rsum "$A3_TMPL")"
snap "a3-0-before" "REPX2-A3-DAILY%"
select_projection "REPX2-A3-DAILY" "$A3_TMPL"
clickitem "When…" | sed 's/^/    /' | tee -a "$REPORT"
pickdate "Thu, Jul 9" "July 9, 2026" "in 4 days" "july 9" "9 jul 2026"
keyret
sheetdump "a3-chooser"
note "  --- pressing CANCEL ---"
pressbtn "Cancel" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 6' </dev/null
esc; esc
snap "a3-1-cancel" "REPX2-A3-DAILY%"
snapdiff "a3-0-before" "a3-1-cancel" "A3 — Cancel"
note "  template: $(rsum "$A3_TMPL")"
note "  app alive: $(alive)"
note "  --- clock 07-06: the untouched control — the rule spawns normally ---"
setclock "070612002026"
snap "a3-2-day06" "REPX2-A3-DAILY%"
snapdiff "a3-1-cancel" "a3-2-day06" "A3 — clock 2026-07-06 (control spawn)"
note "  template: $(rsum "$A3_TMPL")"
note "  series rows:"; seriesrows "$A3_TMPL"
setclock "070512002026"
fi

# =====================================================================
if has_cell B1; then
note ""; note "########## CELL B1 — the chooser for a DEADLINE edit on a projection ##########"
setclock "070512002026"; warm
B1_TMPL=$(mkseries "REPX2-B1-DAILY")
note "  template=$B1_TMPL rule: $(rsum "$B1_TMPL")"
note "  series rows:"; seriesrows "$B1_TMPL"
snap "b1-0-before" "REPX2-B1-DAILY%"
select_projection "REPX2-B1-DAILY" "$B1_TMPL"
clickitem "Deadline…" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "b1-deadline-open"
sheetshow "b1-deadline-open"
pickdate "Mon, Jul 20" "July 20, 2026" "in 15 days" "july 20"
sheetdump "b1-deadline-typed"
keyret
sheetdump "b1-chooser"
note "  ===== chooser after a DEADLINE commit ====="
sed 's/^/      /' "$OUT/ax/b1-chooser.txt" | tee -a "$REPORT"
snap "b1-1-chooser" "REPX2-B1-DAILY%"
snapdiff "b1-0-before" "b1-1-chooser" "B1 — with the deadline chooser open"
note "  --- MAKE EXCEPTION on a deadline ---"
pressbtn "Make Exception" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
snap "b1-2-exception" "REPX2-B1-DAILY%"
snapdiff "b1-1-chooser" "b1-2-exception" "B1 — deadline Make Exception"
note "  template: $(rsum "$B1_TMPL")"
note "  series rows:"; seriesrows "$B1_TMPL"
note "  app alive: $(alive)"
esc; esc

note ""; note "  --- B1b: the UPDATE RULE branch on a deadline, fresh series ---"
setclock "070512002026"; warm
B1B_TMPL=$(mkseries "REPX2-B1B-DAILY")
note "  template=$B1B_TMPL rule: $(rsum "$B1B_TMPL")"
snap "b1b-0-before" "REPX2-B1B-DAILY%"
select_projection "REPX2-B1B-DAILY" "$B1B_TMPL"
clickitem "Deadline…" | sed 's/^/    /' | tee -a "$REPORT"
pickdate "Mon, Jul 20" "July 20, 2026" "in 15 days" "july 20"
keyret
sheetdump "b1b-chooser"
pressbtn "Update Rule" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
snap "b1b-1-updaterule" "REPX2-B1B-DAILY%"
snapdiff "b1b-0-before" "b1b-1-updaterule" "B1b — deadline Update Rule"
note "  template: $(rsum "$B1B_TMPL")"
note "  series rows:"; seriesrows "$B1B_TMPL"
note "  (a RULE deadline shows as ts=<offset> in rsum; an ITEM deadline shows in the deadline column)"
esc; esc
fi

# =====================================================================
if has_cell B2; then
note ""; note "########## CELL B2 — the chooser for a REMINDER edit on a projection ##########"
setclock "070512002026"; warm
B2_TMPL=$(mkseries "REPX2-B2-DAILY")
note "  template=$B2_TMPL rule: $(rsum "$B2_TMPL")"
snap "b2-0-before" "REPX2-B2-DAILY%"
select_projection "REPX2-B2-DAILY" "$B2_TMPL"
clickitem "When…" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "b2-when-open"
sheetshow "b2-when-open"
note "  --- typing a TIME (the 3.23 reminder affordance census + drive) ---"
pickdate "Add Reminder" "6pm" "today at 6pm" "18:00" || pickdate "Reminder" "6pm"
sheetdump "b2-when-time-typed"
sheetshow "b2-when-time-typed"
keyret
sheetdump "b2-chooser"
note "  ===== chooser after a REMINDER commit ====="
sed 's/^/      /' "$OUT/ax/b2-chooser.txt" | tee -a "$REPORT"
snap "b2-1-chooser" "REPX2-B2-DAILY%"
snapdiff "b2-0-before" "b2-1-chooser" "B2 — with the reminder chooser open"
pressbtn "Make Exception" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
snap "b2-2-exception" "REPX2-B2-DAILY%"
snapdiff "b2-1-chooser" "b2-2-exception" "B2 — reminder Make Exception"
note "  template: $(rsum "$B2_TMPL")"
note "  reminderTime across the series:"
gt "SELECT substr(uuid,1,8), title, startDate, reminderTime, rt1_recurrenceRule IS NOT NULL AS tmpl FROM TMTask WHERE uuid='$B2_TMPL' OR rt1_repeatingTemplate='$B2_TMPL'" | sed 's/^/    /' | tee -a "$REPORT"
note "  app alive: $(alive)"
esc; esc
fi

# =====================================================================
if has_cell C; then
note ""; note "########## CELL C — projection edits that allegedly do NOTHING ##########"
setclock "070512002026"; warm
C_TMPL=$(mkseries "REPX2-C-DAILY")
note "  template=$C_TMPL rule: $(rsum "$C_TMPL")"
note "  series rows:"; seriesrows "$C_TMPL"

note ""; note "  --- C1: TITLE edit on a highlighted projection (Return → type → Return) ---"
snap "c-0-before" "REPX2-C-%"
select_projection "REPX2-C-DAILY" "$C_TMPL"
note "    pressing RETURN to open the row editor:"
keyret
sheetdump "c1-after-return"
windump "c1-editor-open"
note "    AXTextArea / AXTextField in the main window while 'editing':"
grep -nE "role=AXTextArea|role=AXTextField" "$OUT/ax/c1-editor-open.txt" | sed 's/^/      /' | head -20 | tee -a "$REPORT"
typetext " EDITED" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "c1-chooser-check"
keyret
lab_ssh "$IP" 'sleep 4' </dev/null
sheetdump "c1-after-commit"
sed 's/^/      /' "$OUT/ax/c1-after-commit.txt" | tee -a "$REPORT" >/dev/null
esc; esc
snap "c-1-title" "REPX2-C-%"
snapdiff "c-0-before" "c-1-title" "C1 — TITLE edit on a projection"
note "    titles now: $(gq "SELECT group_concat(title,' | ') FROM TMTask WHERE uuid='$C_TMPL' OR rt1_repeatingTemplate='$C_TMPL'")"
note "    app alive: $(alive)"

note ""; note "  --- C2: NOTES edit on a highlighted projection (Return → Tab → type) ---"
snap "c-2-before-notes" "REPX2-C-%"
select_projection "REPX2-C" "$C_TMPL"
keyret
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 48'\''; sleep 2' </dev/null
typetext "note-from-projection" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "c2-chooser-check"
keyret
lab_ssh "$IP" 'sleep 4' </dev/null
esc; esc
snap "c-3-notes" "REPX2-C-%"
snapdiff "c-2-before-notes" "c-3-notes" "C2 — NOTES edit on a projection"
note "    app alive: $(alive)"

note ""; note "  --- C3: TAG on a highlighted projection (Items ▸ Add Tags…) ---"
note "    tags in the golden: $(gq "SELECT group_concat(title,',') FROM TMTag" | cut -c1-200)"
snap "c-4-before-tag" "REPX2-C-%"
select_projection "REPX2-C" "$C_TMPL"
itemsmenu | tee -a "$REPORT"
clickitem "Add Tags…" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "c3-tagpopover"
sheetshow "c3-tagpopover"
TAG1=$(gq "SELECT title FROM TMTag ORDER BY rowid LIMIT 1")
note "    typing tag '$TAG1':"
typetext "$TAG1" | sed 's/^/    /' | tee -a "$REPORT"
keyret
lab_ssh "$IP" 'sleep 3' </dev/null
sheetdump "c3-after-tag"
esc; esc
snap "c-5-tag" "REPX2-C-%"
snapdiff "c-4-before-tag" "c-5-tag" "C3 — TAG on a projection"
note "    TMTaskTag rows for the series: $(gq "SELECT COUNT(*) FROM TMTaskTag WHERE tasks IN (SELECT uuid FROM TMTask WHERE uuid='$C_TMPL' OR rt1_repeatingTemplate='$C_TMPL')")"
note "    app alive: $(alive)"

note ""; note "  --- C4: CHECKLIST item on a highlighted projection ---"
snap "c-6-before-chk" "REPX2-C-%"
select_projection "REPX2-C" "$C_TMPL"
note "    Items menu (looking for a checklist verb):"
itemsmenu | tee -a "$REPORT"
keyret
lab_ssh "$IP" 'sleep 2' </dev/null
note "    ⌘⇧C (the app's add-checklist shortcut) inside the open row editor:"
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "c" using {command down, shift down}'\''; sleep 2' </dev/null
windump "c4-editor"
grep -nE "role=AXTextArea|role=AXTextField|Checklist" "$OUT/ax/c4-editor.txt" | sed 's/^/      /' | head -20 | tee -a "$REPORT"
typetext "chk-from-projection" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "c4-chooser-check"
keyret
lab_ssh "$IP" 'sleep 4' </dev/null
esc; esc
snap "c-7-chk" "REPX2-C-%"
snapdiff "c-6-before-chk" "c-7-chk" "C4 — CHECKLIST item on a projection"
note "    TMChecklistItem rows for the series: $(gq "SELECT COUNT(*) FROM TMChecklistItem WHERE task IN (SELECT uuid FROM TMTask WHERE uuid='$C_TMPL' OR rt1_repeatingTemplate='$C_TMPL')")"
note "    app alive: $(alive)"
note ""; note "  --- C summary: the whole series after every C edit ---"
seriesrows "$C_TMPL"
note "  template: $(rsum "$C_TMPL")"
snapdiff "c-0-before" "c-7-chk" "C — NET effect of all four projection edits"
fi

# =====================================================================
if has_cell D1; then
note ""; note "########## CELL D1 — JIT chaining: consecutive projection check-offs ##########"
setclock "070512002026"; warm
D1_TMPL=$(mkseries "REPX2-D1-DAILY")
note "  template=$D1_TMPL rule: $(rsum "$D1_TMPL")"
note "  series rows:"; seriesrows "$D1_TMPL"
snap "d1-0-before" "REPX2-D1-DAILY%"
PREVNAME="d1-0-before"
for N in 1 2 3 4; do
  note ""; note "  --- check-off #$N of the CURRENT projection row ---"
  lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  clickrow "REPX2-D1-DAILY" "Checkbox" | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 10' </dev/null
  snap "d1-$N" "REPX2-D1-DAILY%"
  snapdiff "$PREVNAME" "d1-$N" "D1 — projection check-off #$N"
  PREVNAME="d1-$N"
  note "    template: $(rsum "$D1_TMPL")"
  note "    untrashed series rows: $(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$D1_TMPL' AND trashed=0")   completed: $(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$D1_TMPL' AND trashed=0 AND status=3")"
  note "    app alive: $(alive)"
done
note ""; note "  --- the whole chain, end to end ---"
snapdiff "d1-0-before" "d1-4" "D1 — four consecutive projection check-offs"
seriesrows "$D1_TMPL"
note "  guest clock never moved: $(lab_ssh "$IP" 'date +%Y-%m-%d' </dev/null)"
fi

# =====================================================================
if has_cell D2; then
note ""; note "########## CELL D2 — the SANCTIONED approximation: Create Next Copy + complete ##########"
setclock "070512002026"; warm
DX_TMPL=$(mkseries "REPX2-D2X-DAILY")
note "  arm X template=$DX_TMPL rule: $(rsum "$DX_TMPL")"
lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
clickrow "REPX2-D2X-DAILY" "Checkbox" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 10' </dev/null
snap "d2-x-final" "REPX2-D2X-DAILY%"
note "  arm X template after: $(rsum "$DX_TMPL")"
seriesrows "$DX_TMPL"

DY_TMPL=$(mkseries "REPX2-D2Y-DAILY")
note ""; note "  arm Y template=$DY_TMPL rule: $(rsum "$DY_TMPL")"
snap "d2-y-0" "REPX2-D2Y-DAILY%"
select_item "$DY_TMPL" "$DY_TMPL" || note "  WARN: template selection unconfirmed"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Create Next Copy" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
snap "d2-y-1-nextcopy" "REPX2-D2Y-DAILY%"
snapdiff "d2-y-0" "d2-y-1-nextcopy" "D2 arm Y — Create Next Copy (its creationDate is REPX1 §7 open cell 2)"
note "  arm Y template after Create Next Copy: $(rsum "$DY_TMPL")"
DY_NEW=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$DY_TMPL' AND trashed=0 AND startDate=$(( (2026<<16) | (7<<12) | (6<<7) )) ORDER BY creationDate DESC LIMIT 1")
note "  minted instance = $DY_NEW  creationDate = $(gq "SELECT creationDate FROM TMTask WHERE uuid='$DY_NEW'")"
note "  (occurrence midnight 2026-07-06 UTC = 1783296000.0; a gesture stamp is the wall clock ~1783252800+)"
axq "tell application \"Things3\" to set status of to do id \"$DY_NEW\" to completed" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
snap "d2-y-final" "REPX2-D2Y-DAILY%"
snapdiff "d2-y-1-nextcopy" "d2-y-final" "D2 arm Y — completing the minted instance"
note "  arm Y template after: $(rsum "$DY_TMPL")"
seriesrows "$DY_TMPL"
note ""; note "  --- is arm Y byte-equivalent to arm X? ---"
shapecmp "d2-x-final" "d2-y-final" "X = direct projection check-off" "Y = Create Next Copy + complete"
fi

# =====================================================================
if has_cell D3; then
note ""; note "########## CELL D3 — UNDO (the app's own ⌘Z) after a projection check-off ##########"
setclock "070512002026"; warm
D3_TMPL=$(mkseries "REPX2-D3-DAILY")
note "  template=$D3_TMPL rule: $(rsum "$D3_TMPL")"
snap "d3-0-before" "REPX2-D3-DAILY%"
lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
clickrow "REPX2-D3-DAILY" "Checkbox" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 10' </dev/null
snap "d3-1-checked" "REPX2-D3-DAILY%"
snapdiff "d3-0-before" "d3-1-checked" "D3 — the projection check-off"
note "  template: $(rsum "$D3_TMPL")"
note ""; note "  --- the Edit menu: is Undo enabled, and what does it name? ---"
axq 'tell application "System Events" to tell process "Things3"
  click menu bar item "Edit" of menu bar 1
  delay 1
  set out to ""
  repeat with mi in (menu items of menu "Edit" of menu bar 1)
    try
      set nm to name of mi
      if nm is missing value then set nm to "(separator)"
      set out to out & "      " & nm & "  enabled=" & (enabled of mi) & linefeed
    end try
  end repeat
  key code 53
  return out
end tell' | head -8 | tee -a "$REPORT"
note "  --- ⌘Z ---"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2; osascript -e '\''tell application "System Events" to keystroke "z" using command down'\''; sleep 8' </dev/null
snap "d3-2-undone" "REPX2-D3-DAILY%"
snapdiff "d3-1-checked" "d3-2-undone" "D3 — the app's own ⌘Z"
note "  template: $(rsum "$D3_TMPL")"
note "  series rows:"; seriesrows "$D3_TMPL"
note "  --- durability of the undo across a relaunch ---"
quitapp; relaunch
snap "d3-3-relaunch" "REPX2-D3-DAILY%"
snapdiff "d3-2-undone" "d3-3-relaunch" "D3 — across a relaunch"
note "  template: $(rsum "$D3_TMPL")"
note "  net effect vs the pre-gesture state:"
snapdiff "d3-0-before" "d3-3-relaunch" "D3 — check-off + undo, NET"
fi

# =====================================================================
if has_cell E; then
note ""; note "########## CELL E — the template-'when' CRASH, re-probed on 3.23 ##########"
setclock "070512002026"; warm
note "  historical cells: oddities §1 / §7 C1 (URL update?when= on a repeating TO-DO);"
note "  suites: u-suite U12 (when=today), r-suite R09 (when=today@18:00), a-suite A21 (AS schedule, guarded 302)."
IPS0=$(crashes)
note "  .ips files before: $IPS0"
E_TMPL=$(mkseries "REPX2-E-DAILY")
note "  template=$E_TMPL rule: $(rsum "$E_TMPL")"
note "  series rows:"; seriesrows "$E_TMPL"
snap "e-0-before" "REPX2-E-DAILY%"

note ""; note "  --- E1: AppleScript 'schedule' on the TEMPLATE (A21's shape — expect a guarded 302) ---"
axq "tell application \"Things3\" to schedule to do id \"$E_TMPL\" for (date \"July 8, 2026\")" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 5' </dev/null
note "    app alive: $(alive)   .ips now: $(crashes)"
snap "e-1-as" "REPX2-E-DAILY%"
snapdiff "e-0-before" "e-1-as" "E1 — AppleScript schedule on a TEMPLATE"
note "    template: $(rsum "$E_TMPL")"

note ""; note "  --- E2: URL update?when=today on the TEMPLATE (U12's shape — historically a CRASH) ---"
PID0=$(lab_ssh "$IP" 'pgrep -x Things3 || echo NONE' </dev/null)
note "    Things3 pid before: $PID0"
lab_ssh "$IP" "open -g 'things:///update?id=$E_TMPL&when=today&auth-token=$TOKEN'; sleep 10" </dev/null
PID1=$(lab_ssh "$IP" 'pgrep -x Things3 || echo NONE' </dev/null)
IPS2=$(crashes)
note "    Things3 pid after:  $PID1     (same pid = survived; NONE/different = died)"
note "    .ips files now: $IPS2 (was $IPS0)"
if [ "${IPS2:-0}" -gt "${IPS0:-0}" ]; then
  note "    NEWEST .ips head:"
  lab_ssh "$IP" 'ls -t ~/Library/Logs/DiagnosticReports/Things3-*.ips | head -1 | xargs head -c 300' </dev/null | sed 's/^/      /' | tee -a "$REPORT"
  note ""
  note "    crash signature: $(lab_ssh "$IP" 'ls -t ~/Library/Logs/DiagnosticReports/Things3-*.ips | head -1 | xargs grep -o "EXC_[A-Z_]*" | head -1' </dev/null)"
  note "    newest .ips name: $(lab_ssh "$IP" 'ls -t ~/Library/Logs/DiagnosticReports/Things3-*.ips | head -1 | xargs basename' </dev/null)"
fi
[ "$PID1" = "NONE" ] && relaunch
snap "e-2-url-when" "REPX2-E-DAILY%"
snapdiff "e-1-as" "e-2-url-when" "E2 — URL update?when=today on a TEMPLATE"
note "    template: $(rsum "$E_TMPL")"
note "    series rows:"; seriesrows "$E_TMPL"

note ""; note "  --- E3: the reminder-flavored twin (R09's shape) ---"
IPS3=$(crashes)
PID2=$(lab_ssh "$IP" 'pgrep -x Things3 || echo NONE' </dev/null)
snap "e-3-before-r09" "REPX2-E-DAILY%"
lab_ssh "$IP" "open -g 'things:///update?id=$E_TMPL&when=today@18:00&auth-token=$TOKEN'; sleep 10" </dev/null
PID3=$(lab_ssh "$IP" 'pgrep -x Things3 || echo NONE' </dev/null)
note "    pid $PID2 -> $PID3 ; .ips $IPS3 -> $(crashes)"
[ "$PID3" = "NONE" ] && relaunch
snap "e-4-after-r09" "REPX2-E-DAILY%"
snapdiff "e-3-before-r09" "e-4-after-r09" "E3 — URL update?when=today@18:00 on a TEMPLATE"
note "    template: $(rsum "$E_TMPL")"

note ""; note "  --- E4: the DEADLINE twin (oddities §2i — silently dropped, not a crash) ---"
snap "e-5-before-dl" "REPX2-E-DAILY%"
lab_ssh "$IP" "open -g 'things:///update?id=$E_TMPL&deadline=2026-07-20&auth-token=$TOKEN'; sleep 8" </dev/null
note "    app alive: $(alive)"
snap "e-6-after-dl" "REPX2-E-DAILY%"
snapdiff "e-5-before-dl" "e-6-after-dl" "E4 — URL update?deadline= on a TEMPLATE"
note "    template: $(rsum "$E_TMPL")"

note ""; note "  --- E5: the same URL when= against a template's INSTANCE (the REPX1 §3.1 control) ---"
E_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$E_TMPL' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
note "    instance=$E_INST"
snap "e-7-before-inst" "REPX2-E-DAILY%"
lab_ssh "$IP" "open -g 'things:///update?id=$E_INST&when=2026-07-09&auth-token=$TOKEN'; sleep 8" </dev/null
note "    app alive: $(alive)  .ips: $(crashes)"
snap "e-8-after-inst" "REPX2-E-DAILY%"
snapdiff "e-7-before-inst" "e-8-after-inst" "E5 — URL update?when= on an INSTANCE (control: no crash expected)"
note "    final .ips count: $(crashes) (started $IPS0)"
note "    app alive: $(alive)"
fi

# =====================================================================
if has_cell F1; then
note ""; note "########## CELL F1 — the 3.23 When-picker / reminder UI re-census ##########"
setclock "070512002026"; warm
F1U=$(mkurl "REPX2-F1-PLAIN" "2026-07-06")
note "  ordinary to-do $F1U: $(gt "SELECT start, startDate, reminderTime FROM TMTask WHERE uuid='$F1U'" | tr '\n' ' ')"
select_item "$F1U" "$F1U" >/dev/null
note "  --- the When picker, UNFILTERED, full AX tree ---"
clickitem "When…" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "f1-when-unfiltered"
sed 's/^/      /' "$OUT/ax/f1-when-unfiltered.txt" | tee -a "$REPORT"
note "  reminder affordance hits (remind / checkbox):"
grep -inE "remind|checkbox" "$OUT/ax/f1-when-unfiltered.txt" | sed 's/^/      /' | tee -a "$REPORT"
esc; esc

note ""; note "  --- F1b: the URL reminder SET leg (when=<date>@<time>) ---"
snap "f1-0-before" "REPX2-F1-%"
lab_ssh "$IP" "open -g 'things:///update?id=$F1U&when=2026-07-05@18:00&auth-token=$TOKEN'; sleep 6" </dev/null
snap "f1-1-reminder" "REPX2-F1-%"
snapdiff "f1-0-before" "f1-1-reminder" "F1b — URL when=<date>@<time> reminder SET"
note "    reminderTime now: $(gq "SELECT reminderTime FROM TMTask WHERE uuid='$F1U'")  (18:00 codec = $(( (18<<26) )))"
note "    suite coverage: r-suite R01/R02 (set), R17/R18 (undo re-set), R20/R21 (bare same-date stickiness)."

note ""; note "  --- F1c: the reminder CLEAR bounce (RC01/RC02 — when=today then re-date) ---"
snap "f1-2-before-clear" "REPX2-F1-%"
lab_ssh "$IP" "open -g 'things:///update?id=$F1U&when=today&auth-token=$TOKEN'; sleep 5" </dev/null
note "    after when=today: reminderTime=$(gq "SELECT reminderTime FROM TMTask WHERE uuid='$F1U'") startDate=$(gq "SELECT startDate FROM TMTask WHERE uuid='$F1U'")"
lab_ssh "$IP" "open -g 'things:///update?id=$F1U&when=2026-07-06&auth-token=$TOKEN'; sleep 5" </dev/null
snap "f1-3-cleared" "REPX2-F1-%"
snapdiff "f1-2-before-clear" "f1-3-cleared" "F1c — the reminder-clear bounce"
note "    reminderTime after the bounce: $(gq "SELECT reminderTime FROM TMTask WHERE uuid='$F1U'")"

note ""; note "  --- F1d: the Repeat dialog's reminder affordance on 3.23 ---"
F1T=$(mkseries "REPX2-F1-DAILY")
note "    template=$F1T reminderTime=$(gq "SELECT reminderTime FROM TMTask WHERE uuid='$F1T'")"
select_item "$F1T" "$F1T" >/dev/null
axq 'tell application "System Events" to tell process "Things3" to click menu item "Edit Rule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 3' </dev/null
sheetdump "f1-editrule-reminder"
sed 's/^/      /' "$OUT/ax/f1-editrule-reminder.txt" | tee -a "$REPORT"
note "    reminder affordance hits:"
grep -inE "remind|checkbox" "$OUT/ax/f1-editrule-reminder.txt" | sed 's/^/      /' | tee -a "$REPORT"
esc; esc
fi

# =====================================================================
if has_cell F2; then
note ""; note "########## CELL F2 — URL-scheme natural-language when= acceptance ##########"
setclock "070512002026"; warm
note "  guest clock: $(lab_ssh "$IP" 'date "+%Y-%m-%d %A"' </dev/null)   (07-05 is a Sunday)"
i=0
for PHRASE in "next thursday" "tomorrow" "second tuesday in november" "in 3 days" "july 9" "next week"; do
  i=$((i+1))
  T="REPX2-F2-$i"
  ENC=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$PHRASE")
  lab_ssh "$IP" "open -g 'things:///add?title=$T&when=$ENC&auth-token=$TOKEN'; sleep 5" </dev/null
  note "  when='$PHRASE' (enc=$ENC)"
done
note ""; note "  results:"
lab_ssh "$IP" 'python3 -c "
import sqlite3,glob
db=glob.glob(\"/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite\")[0]
c=sqlite3.connect(\"file:%s?mode=ro\"%db,uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return \"%04d-%02d-%02d\"%(y,m,d)
for t,s,sb,sd,rt in c.execute(\"SELECT title,start,startBucket,startDate,reminderTime FROM TMTask WHERE title LIKE ? ORDER BY title\",(\"REPX2-F2-%\",)):
    print(\"  %-14s start=%s bucket=%s startDate=%s reminder=%s\"%(t,s,sb,dpk(sd) if sd else None,rt))
"' </dev/null | tee -a "$REPORT"
note "  (start: 0=inbox/anytime-unscheduled 1=today/evening 2=scheduled 3=someday)"
note "  rows CREATED at all: $(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'REPX2-F2-%'") of 6"
fi

# =====================================================================
# B3 — B2 measured a TWO-button chooser, but the row it committed was
# "Today · 6:00 PM": that conflates "the edit carries a reminder TIME" with
# "the target is the TODAY list". Five fresh series separate them. Every arm
# ends in Cancel, so the fixtures stay pristine and the census IS the product.
if has_cell B3; then
note ""; note "########## CELL B3 — what makes the chooser 2-button vs 3-button? ##########"
setclock "070512002026"; warm
b3arm() { # b3arm <suffix> <label> <phrase> <expected-row-substring>
  local sfx="$1" label="$2" phrase="$3" want="$4" tmpl
  note ""; note "  --- B3$sfx: $label ---"
  tmpl=$(mkseries "REPX2-B3$sfx-DAILY")
  note "    template=$tmpl rule: $(rsum "$tmpl")"
  snap "b3$sfx-0" "REPX2-B3$sfx-DAILY%"
  select_projection "REPX2-B3$sfx-DAILY" "$tmpl"
  clickitem "When…" >/dev/null
  pickdate "$want" "$phrase"
  keyret
  sheetdump "b3$sfx-chooser"
  note "    chooser copy + buttons:"
  grep -E "role=AXStaticText|role=AXButton" "$OUT/ax/b3$sfx-chooser.txt" | grep -E "action-button|Repeating To-Do|editing a repeating" | sed 's/^/      /' | tee -a "$REPORT"
  note "    button count: $(grep -c 'id=action-button' "$OUT/ax/b3$sfx-chooser.txt")"
  pressbtn "Cancel" | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 5' </dev/null
  esc; esc
  snap "b3$sfx-1" "REPX2-B3$sfx-DAILY%"
  snapdiff "b3$sfx-0" "b3$sfx-1" "B3$sfx — cancelled, must be inert"
  note "    template: $(rsum "$tmpl")"
}
b3arm "A" "a plain FUTURE DATE (A1's shape, re-confirmed)" "in 4 days" "July 9"
b3arm "B" "the TODAY keyword, no time"                     "today"     "Today"
b3arm "C" "a future DATE plus a TIME"                      "in 4 days 6pm" "6:00 PM"
b3arm "D" "TODAY plus a TIME (B2's shape)"                 "today 6pm" "6:00 PM"
b3arm "E" "SOMEDAY (a bucket, not a date)"                 "someday"   "Someday"
fi

# =====================================================================
# C3B — cell C's tag arm drove a menu item that does not exist. The A0 census
# names the real one: `Items ▸ Tags…`. Re-run the tag edit properly, and add the
# Move… arm (the other container-class edit) while the fixture is up.
if has_cell C3B; then
note ""; note "########## CELL C3B — TAG (and Move) on a projection, driven correctly ##########"
setclock "070512002026"; warm
C3_TMPL=$(mkseries "REPX2-C3B-DAILY")
note "  template=$C3_TMPL rule: $(rsum "$C3_TMPL")"
note "  series rows:"; seriesrows "$C3_TMPL"
TAG1=$(gq "SELECT title FROM TMTag ORDER BY rowid LIMIT 1")
note "  tag to apply: '$TAG1'   template uuid8: $(echo "$C3_TMPL" | cut -c1-8)"
snap "c3b-0-before" "REPX2-C3B-DAILY%"
select_projection "REPX2-C3B-DAILY" "$C3_TMPL"
clickitem "Tags…" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "c3b-tagpopover"
note "  the tag popover:"
grep -E "^=== |role=AXTextField|role=AXRow|desc=" "$OUT/ax/c3b-tagpopover.txt" | head -25 | sed 's/^/      /' | tee -a "$REPORT"
typetext "$TAG1" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "c3b-tag-typed"
keyret
lab_ssh "$IP" 'sleep 3' </dev/null
sheetdump "c3b-after-tag"
note "  chooser after committing the tag? containers = $(grep -cE '^=== ' "$OUT/ax/c3b-after-tag.txt")"
grep -E "action-button|Repeating To-Do" "$OUT/ax/c3b-after-tag.txt" | sed 's/^/      /' | tee -a "$REPORT"
esc; esc
snap "c3b-1-tag" "REPX2-C3B-DAILY%"
snapdiff "c3b-0-before" "c3b-1-tag" "C3B — TAG on a projection via Items ▸ Tags…"
note "  TMTaskTag rows for the series: $(gq "SELECT COUNT(*) FROM TMTaskTag WHERE tasks IN (SELECT uuid FROM TMTask WHERE uuid='$C3_TMPL' OR rt1_repeatingTemplate='$C3_TMPL')")"
note "  which row carries it: $(gq "SELECT group_concat(substr(tasks,1,8),',') FROM TMTaskTag WHERE tasks IN (SELECT uuid FROM TMTask WHERE uuid='$C3_TMPL' OR rt1_repeatingTemplate='$C3_TMPL')")"
note "  app alive: $(alive)"

note ""; note "  --- C3B-b: Items ▸ Move… on the same projection (the container-class edit) ---"
snap "c3b-2-before-move" "REPX2-C3B-DAILY%"
select_projection "REPX2-C3B-DAILY" "$C3_TMPL"
clickitem "Move…" | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "c3b-movepopover"
grep -E "^=== |role=AXTextField|desc=" "$OUT/ax/c3b-movepopover.txt" | head -20 | sed 's/^/      /' | tee -a "$REPORT"
esc; esc
snap "c3b-3-after-move" "REPX2-C3B-DAILY%"
snapdiff "c3b-2-before-move" "c3b-3-after-move" "C3B-b — Move… opened and ESCAPED (census only)"
note "  app alive: $(alive)"
fi

note ""; note "REPX2 complete — artifacts in $OUT"
