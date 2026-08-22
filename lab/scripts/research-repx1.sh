#!/bin/bash
# REPX1 — the Things 3.23 repeat-INSTANCE lifecycle: projection check-off,
# early-complete + next-mint timing, the programmatic "exception", Update Rule
# equivalence, and the queued rdlg2 §7 multi-selection cells.
#
#   A  a FUTURE projection row in Upcoming — is it checkable at all? (AX census;
#      if checkable, the just-in-time mint + cursor/count + current-instance fate)
#   B  early-complete of the CURRENT materialized instance — WHEN does the next
#      copy appear (immediately / logbook sweep / rule date)? fixed AND
#      after-completion templates.
#   C  the EXCEPTION, defined by measurement: full row diff of a programmatic
#      instance re-date (AS `schedule`, URL `update?when=`), the template's
#      byte-fate, the FK, and — the semantic heart — whether the rule still
#      spawns on the vacated slot / double-books an occupied one (clock roll).
#      Plus one cheap re-run of the When-picker chooser provocation on 3.23.
#   D  `Edit Rule…` reschedule = the `reschedule-repeat` DB shape (vocabulary tie).
#   E  Show Previous Copy + bulk pause/resume/stop on a MULTI-selection.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23, DB v27; the
# golden is never booted). Airgap, clock pinned 2026-07-05 (cells B/C advance it).
# Fixtures fully synthetic (REPX1-*). DB oracle = full TMTask row snapshots
# diffed either side of every gesture. Teardown on EXIT (KEEP=1 keeps it,
# REUSE=1 attaches to an already-running VM instead of re-cloning).
#
# Usage:  CELLS="A B C D E" lab/scripts/research-repx1.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-repx1-lab}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax" "$OUT/snap"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-A B C D E}"
KEEP="${KEEP:-0}"
RUNTAG="${RUNTAG:-}"
REUSE="${REUSE:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[repx1] $*" | tee -a "$REPORT"; }
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
  IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
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

# rule summary (decodes rt1_recurrenceRule) — the RDLG2/DBLSPAWN1 helper
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, startDate, rt1_instanceCreationPaused FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
if row[0] is None:
    print("NO-RULE next=%s icStart=%s icCount=%s deadline=%s startDate=%s"%(dpk(row[1]),dpk(row[2]),row[3],dpk(row[4]),dpk(row[5]))); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] next=%s icStart=%s icCount=%s paused=%s deadline=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),
    dpk(row[1]),dpk(row[2]),row[3],row[6],dpk(row[4])))
EOF
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py $1" </dev/null 2>&1; }

# FULL-ROW snapshot: every TMTask column for the rows matching a title LIKE,
# emitted as `uuid<TAB>col<TAB>value` so a host-side diff IS the row delta.
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
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,90))
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
    if(sub==='AXUnknown' && !(f.w===40&&f.h===40)){acc.push('=== DETACHED WINDOW '+(i+1)+' sub='+sub+' id='+sv(w,'AXIdentifier')+' @['+f.x+','+f.y+' '+f.w+'x'+f.h+'] ==='); walk(w,0,acc,i+1)}
    var ch=kids(w)
    for(var j=0;j<ch.length;j++){
      var r=sv(ch[j],'AXRole')
      if(r==='AXSheet'||r==='AXPopover'){acc.push('=== '+r+' (child '+(j+1)+' of window '+(i+1)+' "'+sv(w,'AXTitle')+'") ==='); walk(ch[j],0,acc,j+1)}
    }
  }
  if(!acc.length) acc.push('(no sheet / popover / detached dialog present)')
  return acc.join('\n')}
EOF

# Full main-window content walk, with each element's SUPPORTED ACTIONS — the
# census cell A needs (does a projection row carry an AXCheckBox / AXPress?).
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
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,80))
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
# Press the element described `Checkbox` inside the content row whose subtree
# mentions $1. Uses the RAW AX API (System Events' `entire contents` does not
# resolve Things' custom-drawn content rows — the RDLG2 §5.4 failure mode).
lab_ssh "$IP" 'cat > ~/labh/pressrow.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function flat(el,acc,d){acc.push(el); if(d>18)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)flat(ch[i],acc,d+1); return acc}
function run(argv){
  var needle=argv[0], want=argv[1]||'Checkbox'
  var app=$.AXUIElementCreateApplication(pidOf('Things3'))
  var all=[]; flat(app,all,0)
  // find the AXRow whose subtree mentions the needle
  var rows=all.filter(function(e){return sv(e,'AXSubrole')==='AXTableRow'})
  for(var i=0;i<rows.length;i++){
    var sub=[]; flat(rows[i],sub,0)
    var mine=sub.some(function(e){return sv(e,'AXDescription').indexOf(needle)>=0})
    if(!mine) continue
    var hits=sub.filter(function(e){return sv(e,'AXDescription')===want})
    if(!hits.length) return 'ROW FOUND ('+sub.length+' descendants) but no element described '+want
    var rc=$.AXUIElementPerformAction(hits[0],$('AXPress'))
    return 'PRESSED '+want+' in the '+needle+' row (AXError='+rc+', row '+(i+1)+' of '+rows.length+')'
  }
  return 'no AXTableRow subtree mentions '+needle+' (rows scanned: '+rows.length+')'
}
EOF
pressrow() { lab_ssh "$IP" "osascript -l JavaScript ~/labh/pressrow.jxa $(printf '%q' "$1") $(printf '%q' "${2:-Checkbox}")" </dev/null 2>&1; }

# The LIVE vector (A3 control 3): AXPress on Things' custom-drawn row elements
# is decorative — a synthesized CGEvent click at the element's own frame is what
# actually actuates it, and it works in the headless clone under the AXVM1 grant.
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
  // argv: <needle> <target: an AXDescription, or "TITLE" for the row's own
  //       title element> [<modifier: "shift">]
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

sheetdump() { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; note "  [dump $1: $(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines]"; }
windump()  { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/rowcensus.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; note "  [windump $1: $(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines]"; }

select_item() {
  local uuid="$1" want="$2" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get name of selected to dos' 2>/dev/null)
    if [ "$sel" = "$want" ]; then note "  selection OK on attempt $i: '$sel'"; return 0; fi
    note "  selection attempt $i -> '$sel' (want '$want')"
  done
  return 1
}

# mkrepeat <uuid> <title> <frequency> [nextOccurrenceTitleSubstring]
# Promotes an existing to-do to a repeating series through Items ▸ Repeat….
mkrepeat() {
  local uuid="$1" title="$2" freq="$3" nextpick="${4:-}"
  select_item "$uuid" "$title" || note "  WARN: selection never confirmed for $title"
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
  if [ -n "$nextpick" ]; then
    axq "tell application \"System Events\" to tell process \"Things3\"
      set sh to sheet 1 of (first window whose subrole is \"AXStandardWindow\")
      set p to pop up button 2 of group 1 of sh
      repeat 20 times
        if (exists menu 1 of p) then exit repeat
        click p
        delay 0.3
      end repeat
      set hit to \"\"
      repeat with mi in (menu items of menu 1 of p)
        try
          if (name of mi) contains \"$nextpick\" then
            click mi
            set hit to (name of mi)
            exit repeat
          end if
        end try
      end repeat
      delay 1.5
      if hit is \"\" then
        return \"NEXT-PICK MISS for '$nextpick' — offered: \" & ((name of every menu item of menu 1 of p) as text)
      end if
      return \"Next: = \" & hit
    end tell" | sed 's/^/    /' | tee -a "$REPORT"
  fi
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    click button "OK" of sh
    delay 2
    return "pressed OK"
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 6' </dev/null
}

seriesrows() { # seriesrows <templateUuid>
  gt "SELECT substr(uuid,1,8) AS uuid8, title, status, trashed, start, startDate, stopDate IS NOT NULL AS stopped, rt1_repeatingTemplate IS NOT NULL AS isinst FROM TMTask WHERE uuid='$1' OR rt1_repeatingTemplate='$1' ORDER BY creationDate" | sed 's/^/    /' | tee -a "$REPORT"
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

[ "$BOOTSTRAP" = "1" ] && warm

# =====================================================================
if has_cell A; then
note ""; note "########## CELL A — is a FUTURE projection row checkable on 3.23? ##########"
warm
A_SEED=$(mkurl "REPX1-A-DAILY" "2026-07-05")
note "  seed REPX1-A-DAILY uuid=$A_SEED"
mkrepeat "$A_SEED" "REPX1-A-DAILY" "daily"
A_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-A-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  template=$A_TMPL rule: $(rsum "$A_TMPL")"
note "  series rows:"; seriesrows "$A_TMPL"
snap "a-before" "REPX1-A-%"

note ""; note "  --- Upcoming AX census: what does a PROJECTION row expose? ---"
lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
windump "a-upcoming"
note "  rows mentioning REPX1-A-DAILY in the Upcoming window (role/actions census):"
grep -n "REPX1-A-DAILY" "$OUT/ax/a-upcoming.txt" | sed 's/^/    /' | tee -a "$REPORT"
note "  every AXCheckBox in the Upcoming window:"
grep -n "role=AXCheckBox" "$OUT/ax/a-upcoming.txt" | sed 's/^/    /' | head -40 | tee -a "$REPORT"
note "  AppleScript's view of Upcoming (does it even enumerate projections?):"
axq 'tell application "Things3" to get name of to dos of list "Upcoming"' | sed 's/^/    /' | tee -a "$REPORT"

note ""; note "  --- attempting to CHECK a future projection row ---"
# Address the projection row by its AXDescription containing the title, on a row
# dated AFTER today. Press its checkbox if one exists; else press the row itself.
axq 'tell application "System Events" to tell process "Things3"
  set w to (first window whose subrole is "AXStandardWindow")
  set found to {}
  repeat with e in (entire contents of w)
    try
      if (role of e) is "AXCheckBox" then
        set end of found to ("CB desc=" & (description of e) & " val=" & (value of e) & " pos=" & (position of e as text))
      end if
    end try
  end repeat
  if (count of found) is 0 then return "no AXCheckBox anywhere in the Upcoming window"
  return (found as text)
end tell' | sed 's/^/    /' | tee -a "$REPORT"
snap "a-after-census" "REPX1-A-%"
snapdiff "a-before" "a-after-census" "cell A — census only (must be inert)"
note "  app alive: $(alive)"
fi

# ---------------------------------------------------------------------
# A2 — PRESS the projection row's checkbox. Split from A so it can be re-run
# against the fixtures A already built (REUSE=1 CELLS=A2).
if has_cell A2; then
note ""; note "########## CELL A2 — pressing the Upcoming PROJECTION row's checkbox ##########"
A_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-A-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  template=$A_TMPL rule: $(rsum "$A_TMPL")"
note "  series rows BEFORE:"; seriesrows "$A_TMPL"
note "  ALL untrashed rows of the series (count): $(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$A_TMPL' AND trashed=0")"
lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
snap "a2-0-before" "REPX1-A-%"
note "  --- AXPress the 'Checkbox' element inside the REPX1-A-DAILY projection row ---"
pressrow "REPX1-A-DAILY" "Checkbox" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 6' </dev/null
snap "a2-1-pressed" "REPX1-A-%"
snapdiff "a2-0-before" "a2-1-pressed" "A2 — checkbox press on a FUTURE projection row"
note "  template after: $(rsum "$A_TMPL")"
note "  series rows AFTER:"; seriesrows "$A_TMPL"
note "  app alive: $(alive)"
sheetdump "a2-after-press"
note "  AX containers present after the press: $(grep -cE '^=== ' "$OUT/ax/a2-after-press.txt")"
note "  --- +25s re-settle (the app animates a completion before committing) ---"
lab_ssh "$IP" 'sleep 25' </dev/null
snap "a2-2-settle" "REPX1-A-%"
snapdiff "a2-1-pressed" "a2-2-settle" "A2 — +25s settle"
note "  template: $(rsum "$A_TMPL")"
note "  series rows:"; seriesrows "$A_TMPL"
note "  --- and after a relaunch (does the completion survive?) ---"
quitapp; relaunch
snap "a2-3-relaunch" "REPX1-A-%"
snapdiff "a2-2-settle" "a2-3-relaunch" "A2 — across a relaunch"
note "  template: $(rsum "$A_TMPL")"
note "  series rows:"; seriesrows "$A_TMPL"
fi

# ---------------------------------------------------------------------
# A3 — the CONTROL for A2. An AXPress that returns AXError=0 and changes nothing
# proves nothing about projections unless the SAME press completes an ordinary
# row. Two controls: a plain future-dated to-do in Upcoming (LAB-UPCOMING-1) and
# the series' own MATERIALIZED instance in Today.
if has_cell A3; then
note ""; note "########## CELL A3 — the CONTROL: is AXPress-on-Checkbox a live vector at all? ##########"
note "  --- control 1: a plain materialized future-dated to-do in Upcoming (LAB-UPCOMING-1) ---"
lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
snap "a3-0-before" "LAB-UPCOMING-1%"
note "    before: $(gt "SELECT substr(uuid,1,8), title, status, startDate, stopDate FROM TMTask WHERE title='LAB-UPCOMING-1'" | tr '\n' ' ')"
pressrow "LAB-UPCOMING-1" "Checkbox" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
snap "a3-1-after" "LAB-UPCOMING-1%"
snapdiff "a3-0-before" "a3-1-after" "A3 control 1 — AXPress Checkbox on an ORDINARY Upcoming row"

note ""; note "  --- control 2: the series' own MATERIALIZED instance, in Today ---"
A_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-A-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
lab_ssh "$IP" "open -g 'things:///show?id=today'; sleep 4" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
snap "a3-2-before" "REPX1-A-%"
pressrow "REPX1-A-DAILY" "Checkbox" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
snap "a3-3-after" "REPX1-A-%"
snapdiff "a3-2-before" "a3-3-after" "A3 control 2 — AXPress Checkbox on the MATERIALIZED instance (Today)"
note "  template after: $(rsum "$A_TMPL")"
note "  series rows:"; seriesrows "$A_TMPL"

note ""; note "  --- control 3: same row, a synthesized CLICK at the checkbox's screen point ---"
# If AXPress is decorative, a real mouse click at the element's frame is the
# next-strongest vector the headless clone can synthesize (AXVM1 grant).
snap "a3-4-before" "REPX1-A-%"
clickrow "REPX1-A-DAILY" "Checkbox" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 10' </dev/null
snap "a3-5-after" "REPX1-A-%"
snapdiff "a3-4-before" "a3-5-after" "A3 control 3 — synthesized CLICK on the materialized instance's checkbox"
note "  template after: $(rsum "$A_TMPL")"
note "  series rows:"; seriesrows "$A_TMPL"
fi

# ---------------------------------------------------------------------
# A4 — the cell A question, asked with the vector A3 proved LIVE: click the
# checkbox of a FUTURE (non-materialized) projection row on a fresh series.
if has_cell A4; then
note ""; note "########## CELL A4 — CLICKING a FUTURE projection row's checkbox ##########"
warm
A4_SEED=$(mkurl "REPX1-A4-DAILY" "2026-07-05")
note "  seed uuid=$A4_SEED"
mkrepeat "$A4_SEED" "REPX1-A4-DAILY" "daily"
A4_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-A4-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
A4_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$A4_TMPL' AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
note "  template=$A4_TMPL rule: $(rsum "$A4_TMPL")"
note "  current materialized instance=$A4_INST (dated today 2026-07-05)"
note "  series rows BEFORE:"; seriesrows "$A4_TMPL"
lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
windump "a4-upcoming-before"
note "  Upcoming rows naming the series (should be ONE — the 07-06 projection):"
grep -n "REPX1-A4-DAILY" "$OUT/ax/a4-upcoming-before.txt" | sed 's/^/    /' | tee -a "$REPORT"
snap "a4-0-before" "REPX1-A4-%"
note "  --- CLICK the projection row's checkbox ---"
clickrow "REPX1-A4-DAILY" "Checkbox" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 10' </dev/null
snap "a4-1-clicked" "REPX1-A4-%"
snapdiff "a4-0-before" "a4-1-clicked" "A4 — CLICK on a FUTURE projection row's checkbox"
note "  template after: $(rsum "$A4_TMPL")"
note "  series rows AFTER:"; seriesrows "$A4_TMPL"
note "  app alive: $(alive)"
note "  --- +25s settle, then a relaunch (durability) ---"
lab_ssh "$IP" 'sleep 25' </dev/null
snap "a4-2-settle" "REPX1-A4-%"
snapdiff "a4-1-clicked" "a4-2-settle" "A4 — +25s settle"
quitapp; relaunch
snap "a4-3-relaunch" "REPX1-A4-%"
snapdiff "a4-2-settle" "a4-3-relaunch" "A4 — across a relaunch"
note "  template: $(rsum "$A4_TMPL")"
note "  series rows:"; seriesrows "$A4_TMPL"
note "  Upcoming after the click:"
lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
windump "a4-upcoming-after"
grep -n "REPX1-A4-DAILY" "$OUT/ax/a4-upcoming-after.txt" | sed 's/^/    /' | tee -a "$REPORT"
fi

# =====================================================================
if has_cell B; then
note ""; note "########## CELL B — early-complete + the next-mint TIMING ##########"
warm
# --- B1: a FIXED WEEKLY series, current instance materialized TODAY (Sun 07-05).
B_SEED=$(mkurl "REPX1-B-WEEKLY" "2026-07-05")
note "  seed REPX1-B-WEEKLY uuid=$B_SEED"
mkrepeat "$B_SEED" "REPX1-B-WEEKLY" "weekly"
B_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-B-WEEKLY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
B_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$B_TMPL' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
note "  template=$B_TMPL rule: $(rsum "$B_TMPL")"
note "  instance=$B_INST"
note "  series rows:"; seriesrows "$B_TMPL"
snap "b-0-before" "REPX1-B-WEEKLY%"

note ""; note "  --- B1a: complete the current instance EARLY (7 days before the next slot) ---"
axq "tell application \"Things3\" to set status of to do id \"$B_INST\" to completed" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
snap "b-1-completed" "REPX1-B-WEEKLY%"
snapdiff "b-0-before" "b-1-completed" "B1a — early completion"
note "  template after: $(rsum "$B_TMPL")"
note "  series rows:"; seriesrows "$B_TMPL"

note ""; note "  --- B1b: does the next copy appear IMMEDIATELY? (+30s settle, same clock) ---"
lab_ssh "$IP" 'sleep 30' </dev/null
snap "b-2-settle30" "REPX1-B-WEEKLY%"
snapdiff "b-1-completed" "b-2-settle30" "B1b — +30s at the same clock"

note ""; note "  --- B1c: the LOGBOOK SWEEP (AS 'log completed now', what CLI log-now emits) ---"
note "    manualLogDate before: $(gq "SELECT manualLogDate FROM TMSettings")"
note "    logInterval: $(gq "SELECT logInterval FROM TMSettings")"
axq 'tell application "Things3" to log completed now' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
note "    manualLogDate after:  $(gq "SELECT manualLogDate FROM TMSettings")"
snap "b-3-logswept" "REPX1-B-WEEKLY%"
snapdiff "b-2-settle30" "b-3-logswept" "B1c — log completed now"
note "  template after the sweep: $(rsum "$B_TMPL")"

note ""; note "  --- B1d: roll the clock forward ONE DAY AT A TIME to the rule date (Sun 07-12) ---"
for D in 06 07 08 09 10 11 12; do
  note "    ---- advancing to 2026-07-$D ----"
  setclock "07${D}12002026"
  snap "b-day$D" "REPX1-B-WEEKLY%"
  note "      template: $(rsum "$B_TMPL")"
  note "      untrashed instances: $(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$B_TMPL' AND trashed=0")"
  seriesrows "$B_TMPL"
done
snapdiff "b-3-logswept" "b-day12" "B1d — the whole 07-05 -> 07-12 roll"

note ""; note "  --- B2: an AFTER-COMPLETION template — complete its instance, watch the anchor ---"
setclock "070512002026"
warm
B2_SEED=$(mkurl "REPX1-B-AC" "2026-07-05")
note "  seed REPX1-B-AC uuid=$B2_SEED"
mkrepeat "$B2_SEED" "REPX1-B-AC" "after completion"
B2_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-B-AC' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
B2_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$B2_TMPL' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
note "  template=$B2_TMPL rule: $(rsum "$B2_TMPL")"
note "  series rows:"; seriesrows "$B2_TMPL"
snap "b2-0-before" "REPX1-B-AC%"
if [ -n "$B2_INST" ]; then
  axq "tell application \"Things3\" to set status of to do id \"$B2_INST\" to completed" | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 10' </dev/null
  snap "b2-1-completed" "REPX1-B-AC%"
  snapdiff "b2-0-before" "b2-1-completed" "B2 — after-completion instance completed"
  note "  template after: $(rsum "$B2_TMPL")"
  note "  series rows:"; seriesrows "$B2_TMPL"
  note "  --- B2b: +1 day (2026-07-06) — does the successor mint on the clock? ---"
  setclock "070612002026"
  snap "b2-2-day06" "REPX1-B-AC%"
  snapdiff "b2-1-completed" "b2-2-day06" "B2b — clock 07-06"
  note "  template: $(rsum "$B2_TMPL")"
  note "  series rows:"; seriesrows "$B2_TMPL"
else
  note "  NO after-completion instance minted — B2 measures that negative instead"
fi
setclock "070512002026"
fi

# ---------------------------------------------------------------------
# B3 — the sweep arm, done HONESTLY. B1c ran at the golden's `logInterval = 0`
# ("Immediately"), where a completion is logged at completion and
# `log completed now` has nothing left to do — so its zero delta proves nothing
# about the sweep. Flip the preference to "Manually" (RESID1 R-AXRETRY recipe:
# quit+relaunch first, target the popup by enumeration index 3), complete an
# instance so a genuinely PENDING completion exists, THEN sweep.
if has_cell B3; then
note ""; note "########## CELL B3 — the Logbook sweep with a genuinely PENDING completion ##########"
setclock "070512002026"
warm
note "  logInterval before: $(gq "SELECT logInterval FROM TMSettings")  manualLogDate: $(gq "SELECT manualLogDate FROM TMSettings")"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 12; true' </dev/null
axq 'tell application "System Events" to tell process "Things3"
  keystroke "," using command down
  delay 3
  set w to window "General"
  set p to pop up button 3 of w
  set was to value of p
  click p
  delay 1
  click menu item "Manually" of menu 1 of p
  delay 2
  return "logInterval popup " & was & " -> " & (value of p)
end tell' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "w" using command down'\''; sleep 2' </dev/null
note "  logInterval after the flip: $(gq "SELECT logInterval FROM TMSettings")  manualLogDate: $(gq "SELECT manualLogDate FROM TMSettings")"

B3_SEED=$(mkurl "REPX1-B3-WEEKLY" "2026-07-05")
mkrepeat "$B3_SEED" "REPX1-B3-WEEKLY" "weekly"
B3_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-B3-WEEKLY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
B3_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$B3_TMPL' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
note "  template=$B3_TMPL rule: $(rsum "$B3_TMPL")"
snap "b3-0-before" "REPX1-B3-%"
note "  --- complete the instance EARLY (it will now sit UNSWEPT) ---"
axq "tell application \"Things3\" to set status of to do id \"$B3_INST\" to completed" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
snap "b3-1-completed" "REPX1-B3-%"
snapdiff "b3-0-before" "b3-1-completed" "B3 — early completion under logInterval=Manually"
note "  template after: $(rsum "$B3_TMPL")"
note "  pending (resolved-but-unlogged) census: $(gq "SELECT COUNT(*) FROM TMTask WHERE status IN (2,3) AND trashed=0 AND (stopDate IS NOT NULL)")"
note "  --- now the SWEEP ---"
note "    manualLogDate before: $(gq "SELECT manualLogDate FROM TMSettings")"
axq 'tell application "Things3" to log completed now' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
note "    manualLogDate after:  $(gq "SELECT manualLogDate FROM TMSettings")"
snap "b3-2-swept" "REPX1-B3-%"
snapdiff "b3-1-completed" "b3-2-swept" "B3 — log completed now with a PENDING completion"
note "  template after the sweep: $(rsum "$B3_TMPL")"
note "  series rows:"; seriesrows "$B3_TMPL"
fi

# =====================================================================
if has_cell C; then
note ""; note "########## CELL C — the EXCEPTION, defined by measurement ##########"
setclock "070512002026"
warm

# --- C1/C2: full row diff of a programmatic instance re-date -----------------
C_SEED=$(mkurl "REPX1-C-DAILY" "2026-07-05")
note "  seed REPX1-C-DAILY uuid=$C_SEED"
mkrepeat "$C_SEED" "REPX1-C-DAILY" "daily"
C_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-C-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
C_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$C_TMPL' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
note "  template=$C_TMPL rule: $(rsum "$C_TMPL")"
note "  instance=$C_INST"
note "  series rows:"; seriesrows "$C_TMPL"
snap "c-0-before" "REPX1-C-DAILY%"

note ""; note "  --- C1: AppleScript 'schedule' the instance 2026-07-05 -> 2026-07-08 ---"
axq "tell application \"Things3\" to schedule to do id \"$C_INST\" for (date \"July 8, 2026\")" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 5' </dev/null
snap "c-1-as-schedule" "REPX1-C-DAILY%"
snapdiff "c-0-before" "c-1-as-schedule" "C1 — AS schedule on an INSTANCE"
note "  template after: $(rsum "$C_TMPL")"
note "  instance FK still set? $(gq "SELECT rt1_repeatingTemplate FROM TMTask WHERE uuid='$C_INST'")"
note "  app alive: $(alive)"
sheetdump "c1-after-as-schedule"
note "  AX containers present after the re-date (chooser check): $(grep -cE '^=== ' "$OUT/ax/c1-after-as-schedule.txt")"

note ""; note "  --- C2: URL update?when= the same instance 2026-07-08 -> 2026-07-09 ---"
lab_ssh "$IP" "open -g 'things:///update?id=$C_INST&when=2026-07-09&auth-token=$TOKEN'; sleep 6" </dev/null
snap "c-2-url-when" "REPX1-C-DAILY%"
snapdiff "c-1-as-schedule" "c-2-url-when" "C2 — URL update?when= on an INSTANCE"
note "  app alive: $(alive)"
note "  template after: $(rsum "$C_TMPL")"
sheetdump "c2-after-url-when"
note "  AX containers present (chooser check): $(grep -cE '^=== ' "$OUT/ax/c2-after-url-when.txt")"

note ""; note "  --- C3a: does the rule still spawn on 2026-07-06 (the cursor slot) with the instance moved to 07-09? ---"
setclock "070612002026"
snap "c-3-day06" "REPX1-C-DAILY%"
snapdiff "c-2-url-when" "c-3-day06" "C3a — clock 07-06 with the instance parked on 07-09"
note "  template: $(rsum "$C_TMPL")"
note "  series rows:"; seriesrows "$C_TMPL"

# --- C3b: an instance re-dated ONTO the cursor's own next slot ---------------
note ""; note "  --- C3b: re-date an instance ONTO the next cursor slot — double-book or dedupe? ---"
setclock "070512002026"
warm
C2_SEED=$(mkurl "REPX1-C-SLOT" "2026-07-05")
mkrepeat "$C2_SEED" "REPX1-C-SLOT" "daily"
C2_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-C-SLOT' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
C2_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$C2_TMPL' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
note "  template=$C2_TMPL rule: $(rsum "$C2_TMPL")  instance=$C2_INST"
snap "c3b-0-before" "REPX1-C-SLOT%"
axq "tell application \"Things3\" to schedule to do id \"$C2_INST\" for (date \"July 6, 2026\")" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 5' </dev/null
snap "c3b-1-moved" "REPX1-C-SLOT%"
snapdiff "c3b-0-before" "c3b-1-moved" "C3b — instance moved onto the cursor slot 07-06"
note "  template: $(rsum "$C2_TMPL")"
note "  --- advancing to 2026-07-06: does the cursor spawn a SECOND 07-06 row? ---"
setclock "070612002026"
snap "c3b-2-day06" "REPX1-C-SLOT%"
snapdiff "c3b-1-moved" "c3b-2-day06" "C3b — clock reaches the occupied slot"
note "  template: $(rsum "$C2_TMPL")"
note "  series rows:"; seriesrows "$C2_TMPL"
note "  VERDICT INPUT: rows dated 2026-07-06 in this series = $(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$C2_TMPL' AND trashed=0 AND startDate=$(( (2026<<16) | (7<<12) | (6<<7) ))")"

# --- C4: the chooser provocation, re-run once on golden-v4 -------------------
note ""; note "  --- C4: the When-picker chooser provocation, re-run on 3.23/golden-v4 ---"
setclock "070512002026"
warm
C4_SEED=$(mkurl "REPX1-C-CHOOSE" "2026-07-05")
mkrepeat "$C4_SEED" "REPX1-C-CHOOSE" "daily"
C4_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-C-CHOOSE' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
C4_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$C4_TMPL' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
C4_TITLE=$(gq "SELECT title FROM TMTask WHERE uuid='$C4_INST'")
note "  instance=$C4_INST title='$C4_TITLE'"
snap "c4-0-before" "REPX1-C-CHOOSE%"
select_item "$C4_INST" "$C4_TITLE" || note "  WARN: selection never confirmed"
axq 'tell application "System Events" to tell process "Things3" to click menu item "When…" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 3' </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "tomorrow"'\''; sleep 2' </dev/null
sheetdump "c4-when-typed"
note "  the When picker after the filter:"
axq 'tell application "System Events" to tell process "Things3"
  set w to (first window whose value of attribute "AXIdentifier" starts with "WhenPopUpDialog-")
  set out to ""
  repeat with e in (entire contents of w)
    try
      set d to (description of e) as text
      if d is not "" then set out to out & "      " & (role of e) & " desc=" & d & linefeed
    end try
  end repeat
  return out
end tell' | tee -a "$REPORT"
note "  committing with RETURN (the keyboard path, not AXPress):"
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 36'\''; sleep 4' </dev/null
sheetdump "c4-after-return"
note "  CHOOSER present? AX containers = $(grep -cE '^=== ' "$OUT/ax/c4-after-return.txt")"
sed 's/^/      /' "$OUT/ax/c4-after-return.txt" | tee -a "$REPORT" >/dev/null
snap "c4-1-after" "REPX1-C-CHOOSE%"
snapdiff "c4-0-before" "c4-1-after" "C4 — When picker + Return on an instance"
note "  template: $(rsum "$C4_TMPL")"
esc; esc
fi

# =====================================================================
if has_cell D; then
note ""; note "########## CELL D — Edit Rule… reschedule == the reschedule-repeat DB shape ##########"
setclock "070512002026"
warm
D_SEED=$(mkurl "REPX1-D${RUNTAG}-RULE" "2026-07-05")
mkrepeat "$D_SEED" "REPX1-D${RUNTAG}-RULE" "daily"
D_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-D${RUNTAG}-RULE' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  template=$D_TMPL rule BEFORE: $(rsum "$D_TMPL")"
snap "d-0-before" "REPX1-D${RUNTAG}-RULE%"
select_item "$D_TMPL" "REPX1-D${RUNTAG}-RULE" || note "  WARN: selection never confirmed"
note "  Items ▸ Repeat submenu items:"
axq 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1) as text' | sed 's/^/    /' | tee -a "$REPORT"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Edit Rule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 3' </dev/null
sheetdump "d-editrule-open"
note "  driving interval 1 -> 4 (the C10 shape) and OK — with a READ-BACK before the commit:"
axq 'tell application "System Events" to tell process "Things3"
  set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  set tf to text field 1 of group 1 of sh
  set v0 to value of tf
  set focused of tf to true
  delay 0.5
  keystroke "a" using command down
  delay 0.3
  keystroke "4"
  delay 0.5
  keystroke tab
  delay 1
  set v1 to value of (text field 1 of group 1 of sh)
  return "interval field " & v0 & " -> " & v1
end tell' | sed 's/^/    /' | tee -a "$REPORT"
axq 'tell application "System Events" to tell process "Things3"
  set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  click button "OK" of sh
  delay 2
  return "pressed OK"
end tell' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 6' </dev/null
snap "d-1-after" "REPX1-D${RUNTAG}-RULE%"
snapdiff "d-0-before" "d-1-after" "D — Edit Rule… interval 1 -> 4"
note "  template rule AFTER: $(rsum "$D_TMPL")"
note "  series rows:"; seriesrows "$D_TMPL"
fi

# =====================================================================
if has_cell E; then
note ""; note "########## CELL E — Show Previous Copy + bulk pause/resume/stop ##########"
setclock "070512002026"
warm
# Build three daily series so the multi-selection has something to act on.
for N in 1 2 3; do
  S=$(mkurl "REPX1-E-$N" "2026-07-05")
  note "  seed REPX1-E-$N uuid=$S"
  mkrepeat "$S" "REPX1-E-$N" "daily"
done
E1=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-E-1' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
E2=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-E-2' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
E3=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-E-3' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  templates: $E1 / $E2 / $E3"
for T in "$E1" "$E2" "$E3"; do note "    $(rsum "$T")"; done
snap "e-0-before" "REPX1-E-%"

note ""; note "  --- E1: Show Previous Copy on a series with ONE prior copy ---"
# give REPX1-E-1 a completed previous copy: complete today's instance, roll +1 day
E1_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$E1' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
axq "tell application \"Things3\" to set status of to do id \"$E1_INST\" to completed" >/dev/null
lab_ssh "$IP" 'sleep 6' </dev/null
setclock "070612002026"
note "  series rows after the +1 day roll:"; seriesrows "$E1"
E1_CUR=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$E1' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
E1_CURT=$(gq "SELECT title FROM TMTask WHERE uuid='$E1_CUR'")
snap "e-1-before-showprev" "REPX1-E-%"
select_item "$E1_CUR" "$E1_CURT" || note "  WARN: selection never confirmed"
note "  Items ▸ Repeat submenu on an INSTANCE:"
axq 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1) as text' | sed 's/^/    /' | tee -a "$REPORT"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Show Previous Copy" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 4' </dev/null
note "  selection after Show Previous Copy: $(axq 'tell application "Things3" to get name of selected to dos')"
note "  window title now: $(axq 'tell application "System Events" to tell process "Things3" to get title of (first window whose subrole is "AXStandardWindow")')"
windump "e-showprev"
snap "e-2-after-showprev" "REPX1-E-%"
snapdiff "e-1-before-showprev" "e-2-after-showprev" "E1 — Show Previous Copy (navigation or mutation?)"

note ""; note "  --- E2: BULK pause on a multi-selection (E-2 + E-3 templates) ---"
snap "e-3-before-bulk" "REPX1-E-%"
note "  selecting both templates via AppleScript-driven multi-select in a search view:"
lab_ssh "$IP" "open -g 'things:///search?query=REPX1-E-'; sleep 4" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
windump "e-bulk-view"
axq 'tell application "System Events" to tell process "Things3"
  set w to (first window whose subrole is "AXStandardWindow")
  set n to 0
  repeat with e in (entire contents of w)
    try
      if (role of e) is "AXRow" then set n to n + 1
    end try
  end repeat
  return "AXRow count in the search view: " & n
end tell' | sed 's/^/    /' | tee -a "$REPORT"
note "  select-all in the list, then Items ▸ Repeat ▸ Pause:"
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "a" using command down'\''; sleep 2' </dev/null
note "  selected to dos after ⌘A: $(axq 'tell application "Things3" to get name of selected to dos')"
axq 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1) as text' | sed 's/^/    /' | tee -a "$REPORT"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Pause" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 6' </dev/null
snap "e-4-after-bulkpause" "REPX1-E-%"
snapdiff "e-3-before-bulk" "e-4-after-bulkpause" "E2 — bulk Pause on a multi-selection"
for T in "$E1" "$E2" "$E3"; do note "    $(rsum "$T")"; done

note ""; note "  --- E3: BULK resume on the same multi-selection ---"
snap "e-5-before-resume" "REPX1-E-%"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Resume" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 6' </dev/null
snap "e-6-after-bulkresume" "REPX1-E-%"
snapdiff "e-5-before-resume" "e-6-after-bulkresume" "E3 — bulk Resume"
for T in "$E1" "$E2" "$E3"; do note "    $(rsum "$T")"; done
fi

# =====================================================================
# E4 — cell E, retried. The first attempt failed on two MECHANICS, not on the
# app: `Items ▸ Repeat` did not resolve with an INSTANCE selected (census it
# properly), and `things:///search` produced a view with zero addressable rows
# (so ⌘A selected nothing). This arm censuses the menu per selection kind and
# builds the multi-selection by CGEvent click + shift-click in Upcoming, where
# all three templates render as projection rows on the same day.
if has_cell E4; then
note ""; note "########## CELL E4 — Items ▸ Repeat per selection kind, and a REAL multi-selection ##########"
E1=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-E-1' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
E2=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-E-2' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
E3=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-E-3' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
E1_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$E1' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
note "  templates: $E1 / $E2 / $E3 ; E-1 current instance: $E1_INST"
warm

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
note ""; note "  --- census 1: the Items menu with an INSTANCE selected ---"
select_item "$E1_INST" "REPX1-E-1" || note "    WARN: selection never confirmed"
itemsmenu | tee -a "$REPORT"
note "  --- census 2: the Items menu with the TEMPLATE selected ---"
select_item "$E1" "REPX1-E-1" || note "    WARN: selection never confirmed"
itemsmenu | tee -a "$REPORT"

note ""; note "  --- E4a: Show Previous Copy, driven from the TEMPLATE selection ---"
snap "e4-0-before" "REPX1-E-%"
note "    series rows before:"; seriesrows "$E1"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Show Previous Copy" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 5' </dev/null
note "    selection after: $(axq 'tell application "Things3" to get name of selected to dos')"
note "    window title after: $(axq 'tell application "System Events" to tell process "Things3" to get title of (first window whose subrole is "AXStandardWindow")')"
snap "e4-1-showprev" "REPX1-E-%"
snapdiff "e4-0-before" "e4-1-showprev" "E4a — Show Previous Copy"
note "    series rows after:"; seriesrows "$E1"

note ""; note "  --- E4b: build a REAL 3-template multi-selection in Upcoming (click + shift-click) ---"
lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
clickrow "REPX1-E-1" "TITLE" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 2' </dev/null
note "    after the plain click: $(axq 'tell application "Things3" to get name of selected to dos')"
SHIFT=1 clickrow "REPX1-E-3" "TITLE" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 2' </dev/null
note "    after the shift-click: $(axq 'tell application "Things3" to get name of selected to dos')"

note ""; note "  --- E4c: bulk PAUSE on that multi-selection ---"
snap "e4-2-before-pause" "REPX1-E-%"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Pause" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 6' </dev/null
snap "e4-3-after-pause" "REPX1-E-%"
snapdiff "e4-2-before-pause" "e4-3-after-pause" "E4c — bulk Pause"
for T in "$E1" "$E2" "$E3"; do note "    $(rsum "$T")"; done

note ""; note "  --- E4d: bulk RESUME on the same multi-selection ---"
snap "e4-4-before-resume" "REPX1-E-%"
note "    selection still: $(axq 'tell application "Things3" to get name of selected to dos')"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Resume" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 6' </dev/null
snap "e4-5-after-resume" "REPX1-E-%"
snapdiff "e4-4-before-resume" "e4-5-after-resume" "E4d — bulk Resume"
for T in "$E1" "$E2" "$E3"; do note "    $(rsum "$T")"; done

note ""; note "  --- E4e: bulk STOP on the same multi-selection ---"
snap "e4-6-before-stop" "REPX1-E-%"
note "    selection still: $(axq 'tell application "Things3" to get name of selected to dos')"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Stop" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 6' </dev/null
sheetdump "e4-after-stop"
note "    confirmation sheet? AX containers = $(grep -cE '^=== ' "$OUT/ax/e4-after-stop.txt")"
snap "e4-7-after-stop" "REPX1-E-%"
snapdiff "e4-6-before-stop" "e4-7-after-stop" "E4e — bulk Stop"
for T in "$E1" "$E2" "$E3"; do note "    $(rsum "$T")"; done
note "    all REPX1-E-* rows:"
gt "SELECT substr(uuid,1,8) AS uuid8, title, status, trashed, start, startDate, rt1_recurrenceRule IS NOT NULL AS tmpl, rt1_repeatingTemplate IS NOT NULL AS isinst FROM TMTask WHERE title LIKE 'REPX1-E-%' ORDER BY title, creationDate" | sed 's/^/    /' | tee -a "$REPORT"
fi

# =====================================================================
# E5 — two loose ends E4 left: (a) the Items-menu census claim rests on WHICH
# row was actually selected, so re-run it reading the selection's uuid, not its
# (shared) title; (b) bulk Stop raised a confirmation sheet and E4 stopped at the
# census — drive "Stop Them" and measure what the series becomes.
if has_cell E5; then
note ""; note "########## CELL E5 — selection identity, and driving the bulk-Stop confirmation ##########"
esc; esc
E1=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-E-1' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
E2=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-E-2' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
E3=$(gq "SELECT uuid FROM TMTask WHERE title='REPX1-E-3' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
E1_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$E1' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
warm
note "  template uuid=$E1   instance uuid=$E1_INST"
selid() { axq 'tell application "Things3" to get id of selected to dos'; }
hasrepeat() { axq 'tell application "System Events" to tell process "Things3"
  click menu bar item "Items" of menu bar 1
  delay 1
  set r to (exists menu item "Repeat" of menu "Items" of menu bar 1)
  key code 53
  return "Items has a Repeat item: " & r
end tell'; }
note ""; note "  --- selection = the INSTANCE ---"
select_item "$E1_INST" "REPX1-E-1" >/dev/null
note "    selected uuid(s): $(selid)   (instance is $E1_INST)"
note "    $(hasrepeat)"
note "  --- selection = the TEMPLATE ---"
select_item "$E1" "REPX1-E-1" >/dev/null
note "    selected uuid(s): $(selid)   (template is $E1)"
note "    $(hasrepeat)"

note ""; note "  --- E5b: rebuild the 3-template multi-selection and drive Stop ▸ 'Stop Them' ---"
lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
clickrow "REPX1-E-1" "TITLE" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 2' </dev/null
SHIFT=1 clickrow "REPX1-E-3" "TITLE" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 2' </dev/null
note "    selection: $(axq 'tell application "Things3" to get name of selected to dos')"
snap "e5-0-before-stop" "REPX1-E-%"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Stop" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' >/dev/null
lab_ssh "$IP" 'sleep 4' </dev/null
sheetdump "e5-stop-sheet"
sed 's/^/      /' "$OUT/ax/e5-stop-sheet.txt" | tee -a "$REPORT" >/dev/null
note "    pressing 'Stop Them' (action-button-1):"
axq 'tell application "System Events" to tell process "Things3"
  set sh to (first sheet of (first window whose subrole is "AXStandardWindow"))
  click button "Stop Them" of sh
  delay 3
  return "pressed Stop Them"
end tell' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
snap "e5-1-after-stop" "REPX1-E-%"
snapdiff "e5-0-before-stop" "e5-1-after-stop" "E5b — bulk Stop CONFIRMED"
for T in "$E1" "$E2" "$E3"; do note "    $(rsum "$T")"; done
note "    all REPX1-E-* rows:"
gt "SELECT substr(uuid,1,8) AS uuid8, title, status, trashed, start, startDate, rt1_recurrenceRule IS NOT NULL AS tmpl, rt1_repeatingTemplate IS NOT NULL AS isinst FROM TMTask WHERE title LIKE 'REPX1-E-%' ORDER BY title, creationDate" | sed 's/^/    /' | tee -a "$REPORT"
note "    --- +1 day (2026-07-07): does a stopped series still spawn? ---"
setclock "070712002026"
snap "e5-2-day07" "REPX1-E-%"
snapdiff "e5-1-after-stop" "e5-2-day07" "E5b — clock 07-07 after Stop"
for T in "$E1" "$E2" "$E3"; do note "    $(rsum "$T")"; done
fi

note ""; note "REPX1 complete — artifacts in $OUT"
