#!/bin/bash
# REPX3 — the residual cells of the Things 3.23 Make Exception / Update Rule
# chooser. REPX2 captured the chooser and drove both branches, but EVERY arm
# used a DAILY series — the one rule shape where the projection cursor
# (rt1_nextInstanceStartDate) and the scan watermark (rt1_instanceCreationStartDate)
# coincide (REPX1 §2.3). Four cells remain (REPX2 §8 items 2, 3, 5, 6):
#
#   G1  a NON-DAILY (fixed WEEKLY) rule: does Make Exception advance the cursor
#       to the next RULE date while the watermark goes to spawned-day+1? Both
#       columns measured pre/post, plus the minted instance row, plus a Cancel
#       control on the same clock rolls.
#   G1B the same, on an EVERY-2-DAYS rule — the arm that can also be watched
#       RESUME, because both of its slots fall inside golden-v4's trial wall.
#   G2A an exception MEETS a rule change: Update Rule after a Make Exception on
#       the same series — what happens to the exception instance and both cursors.
#   G2B a SECOND exception on a series that already holds one.
#   G3A two exceptions onto the SAME (already-occupied) free day — does the app
#       dedupe at the next clock arrival?
#   G3B the spawner-collision route: move the projection onto the rule's OWN next
#       slot, so the cursor lands on a day that already holds the occurrence.
#       Fresh route into the oddities §13 double-book class, or deduped?
#   G4A ⌘Z immediately after Make Exception — perfect inverse or partial?
#   G4B ⌘Z immediately after Update Rule.
#
# METHOD: one disposable clone of things-lab-golden-v4 (Things 3.23, DB v27; the
# golden is never booted). Airgap, clock pinned 2026-07-05 (a Sunday); cells
# advance it. Fixtures fully synthetic (REPX3-*). DB oracle = FULL TMTask row
# snapshots (every column, packed dates decoded, blobs hashed) diffed either side
# of every gesture. Teardown on EXIT (KEEP=1 keeps it, REUSE=1 attaches).
#
# Usage:  CELLS="G1" VM=repx3-lab KEEP=1 lab/scripts/research-repx3.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-repx3-lab}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/ax" "$OUT/snap"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-G1 G1B G2A G2B G3A G3B G4A G4B}"
FIX="${FIXTAG:-}"   # fixture-title suffix, so a retry on the same clone cannot collide
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[repx3] $*" | tee -a "$REPORT"; }
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
# THE TRIAL WALL (REPX3, measured the hard way). golden-v4's Things is a TRIAL
# build with firstAppLaunchDate = 2026-07-03 03:14 UTC and a 15-day window, so
# the guest clock may NEVER be rolled to 2026-07-18 or later: past the wall the
# app raises "Your Trial Period Has Ended" and goes read-only — it stops spawning
# repeat occurrences and silently drops every write, which reads exactly like an
# app behavior finding and is not one. Worse, the state is STICKY: rolling the
# clock back does NOT clear the dialog, so the clone is burned and the campaign
# restarts. setclock refuses the roll rather than producing false evidence.
TRIAL_WALL="20260718"
setclock() { # setclock MMDDhhmmYYYY  (quits the app first, relaunches after)
  local d="$1" ymd="${1:8:4}${1:0:2}${1:2:2}"
  if [ "$ymd" -ge "$TRIAL_WALL" ]; then
    note "    REFUSED clock roll to $ymd — golden-v4's trial wall is $TRIAL_WALL (see the TRIAL WALL note)"
    return 1
  fi
  quitapp
  lab_ssh "$IP" "sudo date $d >/dev/null; date" </dev/null | sed 's/^/    clock now: /' | tee -a "$REPORT"
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
# REPX3 refinement of REPX2's recipe. REPX2 clicked the projection row's title
# straight after opening Upcoming; with TWO fixtures whose projections sit on the
# same (far-down) day, the CGEvent click landed on the WRONG series' row — an
# off-screen row still reports an AX frame, and the click hits whatever is
# actually drawn at that point. Fix: `show?id=<uuid>` FIRST (it scrolls the list
# to the row and selects it), THEN click the now-visible row, and verify by uuid
# at every step. If the click still misses, the show?id= selection — which the
# A0 census proved is the SAME object as the projection row — is restored and
# used, with the path recorded in the report.
select_projection() { # select_projection <titleNeedle> <templateUuid>
  local needle="$1" tmpl="$2" sel
  lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  select_item "$tmpl" "$tmpl" >/dev/null
  clickrow "$needle" "TITLE" | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 2' </dev/null
  sel=$(axq 'tell application "Things3" to get id of selected to dos' 2>/dev/null)
  if [ "$sel" = "$tmpl" ]; then
    note "    PROJECTION selected — selection uuid == TEMPLATE uuid ($sel)"; return 0
  fi
  note "    WARN: the row click selected '$sel' (template is $tmpl) — restoring the show?id= selection"
  select_item "$tmpl" "$tmpl" && { note "    PROJECTION selected via show?id= (uuid-verified)"; return 0; }
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

# ---------------------------------------------------- REPX3 extras
# July-2026 packed-date helper and a per-day row census for a series.
pk() { echo $(( (2026<<16) | (7<<12) | ($1<<7) )); }
daycount() { gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 AND startDate=$(pk "$2")"; }

# mkrepeat, re-defined: REPX2 clicked a HARD-CODED frequency label. REPX3 needs
# `weekly`, so the drive ENUMERATES the pop-up's items, logs them, and clicks the
# first whose name contains the wanted word (AppleScript `contains` is
# case-insensitive) — failing loudly rather than silently promoting to daily.
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
    set nms to name of every menu item of menu 1 of p
    set hit to \"\"
    repeat with n in nms
      if hit is \"\" and ((n as text) contains \"$freq\") then set hit to (n as text)
    end repeat
    if hit is \"\" then
      key code 53
      return \"FREQ-NOT-FOUND wanted '$freq'; offered: \" & (nms as text)
    end if
    click menu item hit of menu 1 of p
    delay 1.5
    return \"frequency pop-up offered {\" & (nms as text) & \"} -> clicked '\" & hit & \"'\"
  end tell" | sed 's/^/    /' | tee -a "$REPORT"
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    click button "OK" of sh
    delay 2
    return "pressed OK"
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 6' </dev/null
}

# clickax — REPX1's CGEvent click, aimed by ROLE at any element in the app's AX
# tree (REPX1's clickrow only searches inside AXTableRows). `read` reports the
# first matching element's value instead of clicking it.
lab_ssh "$IP" 'cat > ~/labh/clickax.jxa' <<'EOF'
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
  var role=argv[0], mode=argv[1]||'click'
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var all=[]; flat(app,all,0)
  var hits=all.filter(function(e){return sv(e,'AXRole')===role})
  if(!hits.length) return 'NO '+role+' in the app AX tree'
  var el=hits[0], f=frame(el)
  if(mode==='read') return sv(el,'AXValue')+' (of '+hits.length+' '+role+')'
  var x=f.x+f.w/2, y=f.y+f.h/2, pt=$.CGPointMake(x,y)
  function post(t){$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent($(),t,pt,$.kCGMouseButtonLeft))}
  post($.kCGEventMouseMoved); delay(0.3)
  post($.kCGEventLeftMouseDown); delay(0.12)
  post($.kCGEventLeftMouseUp)
  return 'CLICKED '+role+' 1 of '+hits.length+' at ('+x+','+y+') value='+sv(el,'AXValue')
}
EOF
clickax() { lab_ssh "$IP" "osascript -l JavaScript ~/labh/clickax.jxa $(printf '%q' "$1") $(printf '%q' "${2:-click}")" </dev/null 2>&1; }

# mkrepeat with an INTERVAL: the Repeat dialog's cadence group is
# "every <N> <unit>", where N is an editable text field. Driven like a user
# (focus, select-all, type, Tab) rather than by setting AXValue, which an
# NSTextField binding can swallow. The dialog is dumped once for the record, and
# the caller ASSERTS the resulting rule (`fa`) rather than trusting the drive.
mkrepeat_iv() { # mkrepeat_iv <uuid> <title> <freq> <interval>
  local uuid="$1" title="$2" freq="$3" iv="$4"
  select_item "$uuid" "$uuid" || note "  WARN: selection never confirmed for $title"
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  sheetdump "repeat-dialog-census"
  axq "tell application \"System Events\" to tell process \"Things3\"
    set sh to sheet 1 of (first window whose subrole is \"AXStandardWindow\")
    set p to pop up button 1 of sh
    repeat 20 times
      if (exists menu 1 of p) then exit repeat
      click p
      delay 0.3
    end repeat
    set nms to name of every menu item of menu 1 of p
    set hit to \"\"
    repeat with n in nms
      if hit is \"\" and ((n as text) contains \"$freq\") then set hit to (n as text)
    end repeat
    if hit is \"\" then
      key code 53
      return \"FREQ-NOT-FOUND wanted '$freq'; offered: \" & (nms as text)
    end if
    click menu item hit of menu 1 of p
    delay 1.5
    return \"frequency = \" & hit
  end tell" | sed 's/^/    /' | tee -a "$REPORT"
  # The interval field is NOT a direct child of the sheet — it lives inside the
  # cadence GROUP ("every [1] [day]"), and System Events cannot see it at all:
  # neither `text field 1 of sh` nor a walk of `entire contents` finds it, though
  # the raw AX API shows a plain `AXTextField val=1 id=_NS:43` in the group. So
  # it is driven the REPX1 way — a CGEvent click at its AX-resolved frame, then
  # ordinary keystrokes.
  # The field is `text field 1 of GROUP 1` — the path the shipped ui recipe uses
  # (`ui-recipes.ts` DIALOG_INTERVAL). Three wrong addressings were measured
  # first: `text field 1 of sh` (not a direct child), a walk of `entire contents`
  # (System Events reports no text field at all), and a CGEvent click at the
  # element's raw-AX frame (the click lands and typing shows in the AX value, but
  # the caret sits at 0 so the digit PREPENDS — "1" + "2" = "21" — and ⌘A, End
  # and Backspace all do nothing to it). The shipped `set focused` + ⌘A + type +
  # Tab mechanic is what actually commits.
  axq "tell application \"System Events\" to tell process \"Things3\"
    set sh to sheet 1 of (first window whose subrole is \"AXStandardWindow\")
    set tf to (text field 1 of group 1 of sh)
    set focused of tf to true
    delay 0.2
    keystroke \"a\" using command down
    delay 0.15
    keystroke \"$iv\"
    delay 0.15
    key code 48
    delay 1
    return \"interval field reads: \" & (value of tf as text)
  end tell" | sed 's/^/    /' | tee -a "$REPORT"
  # Fallback: the CGEvent click at the raw-AX frame, typing at the caret (which
  # sits at 0) and FORWARD-deleting (117) the old digits. Measured to commit.
  IVNOW=$(clickax "AXTextField" read | sed 's/ .*//')
  if [ "$IVNOW" != "$iv" ]; then
    note "    interval still reads '$IVNOW' — falling back to the click+type+forward-delete drive"
    clickax "AXTextField" | sed 's/^/    /' | tee -a "$REPORT"
    typetext "$iv" >/dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to repeat 3 times
      key code 117
      delay 0.2
    end repeat'\''; sleep 1' </dev/null
    note "    interval field now reads: $(clickax "AXTextField" read)"
  fi
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 48'\''; sleep 1' </dev/null
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    click button "OK" of sh
    delay 2
    return "pressed OK"
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 6' </dev/null
}

mkseries_iv() { # mkseries_iv <name> <freq> <interval> -> template uuid
  local nm="$1" freq="$2" iv="$3" seed tmpl
  seed=$(mkurl "$nm" "2026-07-05")
  mkrepeat_iv "$seed" "$nm" "$freq" "$iv" >/dev/null
  tmpl=$(gq "SELECT uuid FROM TMTask WHERE title='$nm' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  echo "$tmpl"
}

# Dump the chooser and report its shape (REPX2 §2.3: the button SET varies, so a
# recipe must read it back — and so must this campaign, on every arm).
chooser() { # chooser <dumpname>
  sheetdump "$1"
  note "    chooser containers: $(grep -cE '^=== ' "$OUT/ax/$1.txt")   action-buttons: $(grep -c 'id=action-button' "$OUT/ax/$1.txt")"
  grep -E "role=AXStaticText|id=action-button" "$OUT/ax/$1.txt" | sed 's/^/      /' | tee -a "$REPORT"
}

# The app's own ⌘Z, with the Edit menu's state captured first.
appundo() {
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
  end tell' | head -6 | tee -a "$REPORT"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2; osascript -e '\''tell application "System Events" to keystroke "z" using command down'\''; sleep 8' </dev/null
}

# One chooser gesture end to end: select the projection, open the picker, resolve
# the phrase closed-loop, commit, read the chooser back, press a branch.
# gesture <titleNeedle> <templateUuid> <menuItem> <wantRow> <phrase> <branch> <dumpname>
gesture() {
  local needle="$1" tmpl="$2" item="$3" want="$4" phrase="$5" branch="$6" dump="$7"
  select_projection "$needle" "$tmpl"
  clickitem "$item" | sed 's/^/    /' | tee -a "$REPORT"
  pickdate "$want" "$phrase" "$want" "${want/July /july }" || { note "    ABORT gesture: picker never resolved"; esc; esc; return 1; }
  keyret
  chooser "$dump"
  note "    --- pressing $branch ---"
  pressbtn "$branch" | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 8' </dev/null
  esc >/dev/null
}

# =====================================================================
# G1 — the load-bearing cell: a NON-DAILY rule, where the cursor and the
# watermark are different columns (REPX1 §2.3).
if has_cell G1; then
note ""; note "########## CELL G1 — Make Exception on a fixed WEEKLY rule ##########"
setclock "070512002026"; warm
G1T=$(mkseries "REPX3-G1$FIX-WEEKLY" weekly)
G1CT=$(mkseries "REPX3-G1C$FIX-WEEKLY" weekly)
note "  exception arm template=$G1T   rule: $(rsum "$G1T")"
note "  control   arm template=$G1CT  rule: $(rsum "$G1CT")"
note "  series rows (exception arm):"; seriesrows "$G1T"
note "  packed refs: 07-12=$(pk 12) 07-13=$(pk 13) 07-15=$(pk 15) 07-16=$(pk 16) 07-19=$(pk 19)"
note "  TARGET 2026-07-15 (Wed) splits the three candidate watermarks:"
note "    slot+1 = 07-13   chosen-day+1 = 07-16   next RULE date = 07-19"
snap "g1-0-before" "REPX3-G1$FIX-WEEKLY%"
snap "g1c-0-before" "REPX3-G1C$FIX-WEEKLY%"

gesture "REPX3-G1$FIX-WEEKLY" "$G1T" "When…" "July 15" "July 15, 2026" "Make Exception" "g1-chooser"
snap "g1-1-exception" "REPX3-G1$FIX-WEEKLY%"
snapdiff "g1-0-before" "g1-1-exception" "G1 — Make Exception on a WEEKLY series (projection 07-12 -> 07-15)"
note "  template after: $(rsum "$G1T")"
note "  series rows:"; seriesrows "$G1T"
note "  app alive: $(alive)"
note "  --- durability: relaunch ---"
quitapp; relaunch
snap "g1-2-relaunch" "REPX3-G1$FIX-WEEKLY%"
snapdiff "g1-1-exception" "g1-2-relaunch" "G1 — across a relaunch"

note ""; note "  --- the CONTROL arm: the same gesture, branch = Cancel (must be inert) ---"
gesture "REPX3-G1C$FIX-WEEKLY" "$G1CT" "When…" "July 15" "July 15, 2026" "Cancel" "g1c-chooser"
snap "g1c-1-cancel" "REPX3-G1C$FIX-WEEKLY%"
snapdiff "g1c-0-before" "g1c-1-cancel" "G1 control — Cancel"
note "  control template: $(rsum "$G1CT")"

note ""; note "  ===== clock reaches the ORIGINAL weekly slot 2026-07-12 ====="
setclock "071212002026"
snap "g1-3-day12" "REPX3-G1$FIX-WEEKLY%"
snapdiff "g1-2-relaunch" "g1-3-day12" "G1 exception arm — clock 2026-07-12 (the vacated slot)"
snap "g1c-2-day12" "REPX3-G1C$FIX-WEEKLY%"
snapdiff "g1c-1-cancel" "g1c-2-day12" "G1 control arm — clock 2026-07-12 (must spawn normally)"
note "  exception arm: $(rsum "$G1T")    rows on 07-12 = $(daycount "$G1T" 12)"
note "  control   arm: $(rsum "$G1CT")   rows on 07-12 = $(daycount "$G1CT" 12)"
note "  series rows (exception arm):"; seriesrows "$G1T"

note ""; note "  NOT ROLLED to the weekly rule's next date (2026-07-19): it is PAST the trial"
note "  wall (2026-07-18), so a weekly series cannot be watched resume on this golden."
note "  Cell G1B measures the resumption on an every-2-days rule instead — same"
note "  cursor/watermark divergence, both slots inside the wall."
setclock "070512002026"
fi

# =====================================================================
# G1B — the same question on an EVERY-2-DAYS rule. Weekly splits the two columns
# widest, but its next rule date (07-19) is past golden-v4's trial wall, so the
# RESUMPTION half of the cell needs a non-daily rule with two slots inside the
# window. Every-2-days from a 07-05 seed lands slots on 07-07, 07-09, 07-11 —
# and a 07-07 -> 07-10 exception splits the candidates by one day each:
#   slot+1 = 07-08 (the watermark)   next RULE date = 07-09 (the cursor)
#   chosen-day+1 = 07-11 (neither)
if has_cell G1B; then
note ""; note "########## CELL G1B — Make Exception on an EVERY-2-DAYS rule (resumption included) ##########"
setclock "070512002026"; warm
G1BT=$(mkseries_iv "REPX3-G1B$FIX-EVERY2" daily 2)
G1BCT=$(mkseries_iv "REPX3-G1BC$FIX-EVERY2" daily 2)
note "  exception arm template=$G1BT   rule: $(rsum "$G1BT")"
note "  control   arm template=$G1BCT  rule: $(rsum "$G1BCT")"
FA=$(rsum "$G1BT" | sed -n 's/.*fa=\([0-9]*\).*/\1/p')
if [ "$FA" != "2" ]; then
  note "  FATAL for G1B: the interval field did not take (fa=$FA, wanted 2) — no evidence produced"
else
note "  series rows (exception arm):"; seriesrows "$G1BT"
snap "g1b-0-before" "REPX3-G1B$FIX-EVERY2%"
snap "g1bc-0-before" "REPX3-G1BC$FIX-EVERY2%"
gesture "REPX3-G1B$FIX-EVERY2" "$G1BT" "When…" "July 10" "July 10, 2026" "Make Exception" "g1b-chooser"
snap "g1b-1-exception" "REPX3-G1B$FIX-EVERY2%"
snapdiff "g1b-0-before" "g1b-1-exception" "G1B — Make Exception on an every-2-days series (projection 07-07 -> 07-10)"
note "  template after: $(rsum "$G1BT")"
note "  series rows:"; seriesrows "$G1BT"
note ""; note "  --- the CONTROL arm: same gesture, branch = Cancel ---"
gesture "REPX3-G1BC$FIX-EVERY2" "$G1BCT" "When…" "July 10" "July 10, 2026" "Cancel" "g1bc-chooser"
snap "g1bc-1-cancel" "REPX3-G1BC$FIX-EVERY2%"
snapdiff "g1bc-0-before" "g1bc-1-cancel" "G1B control — Cancel"
note ""; note "  ===== clock reaches the VACATED slot 2026-07-07 ====="
setclock "070712002026"
snap "g1b-2-day07" "REPX3-G1B$FIX-EVERY2%"
snapdiff "g1b-1-exception" "g1b-2-day07" "G1B exception arm — clock 2026-07-07 (the vacated slot)"
snap "g1bc-2-day07" "REPX3-G1BC$FIX-EVERY2%"
snapdiff "g1bc-1-cancel" "g1bc-2-day07" "G1B control arm — clock 2026-07-07 (must spawn)"
note "  exception arm: $(rsum "$G1BT")   rows on 07-07 = $(daycount "$G1BT" 7)"
note "  control   arm: $(rsum "$G1BCT")  rows on 07-07 = $(daycount "$G1BCT" 7)"
note ""; note "  ===== clock reaches the NEXT RULE date 2026-07-09 — does the series RESUME? ====="
setclock "070912002026"
snap "g1b-3-day09" "REPX3-G1B$FIX-EVERY2%"
snapdiff "g1b-2-day07" "g1b-3-day09" "G1B exception arm — clock 2026-07-09"
snap "g1bc-3-day09" "REPX3-G1BC$FIX-EVERY2%"
snapdiff "g1bc-2-day07" "g1bc-3-day09" "G1B control arm — clock 2026-07-09"
note "  exception arm: $(rsum "$G1BT")   rows on 07-09 = $(daycount "$G1BT" 9)"
note "  control   arm: $(rsum "$G1BCT")  rows on 07-09 = $(daycount "$G1BCT" 9)"
note "  series rows (exception arm):"; seriesrows "$G1BT"
setclock "070512002026"
fi
fi

# =====================================================================
# G2A — an exception MEETS a rule change.
if has_cell G2A; then
note ""; note "########## CELL G2A — Update Rule AFTER a Make Exception on the same series ##########"
setclock "070512002026"; warm
G2AT=$(mkseries "REPX3-G2A$FIX-DAILY")
note "  template=$G2AT rule: $(rsum "$G2AT")"
snap "g2a-0-before" "REPX3-G2A$FIX-DAILY%"
note ""; note "  --- step 1: Make Exception, projection 07-06 -> Jul 9 ---"
gesture "REPX3-G2A$FIX-DAILY" "$G2AT" "When…" "July 9" "July 9, 2026" "Make Exception" "g2a-chooser1"
snap "g2a-1-exception" "REPX3-G2A$FIX-DAILY%"
snapdiff "g2a-0-before" "g2a-1-exception" "G2A step 1 — Make Exception"
note "  template: $(rsum "$G2AT")"
G2A_EXC=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$G2AT' AND trashed=0 AND startDate=$(pk 9) ORDER BY creationDate DESC LIMIT 1")
note "  the exception instance = $G2A_EXC (dated 2026-07-09)"
note "  series rows:"; seriesrows "$G2AT"

note ""; note "  --- step 2: Update Rule on the NEXT projection (07-07) -> Jul 11 ---"
gesture "REPX3-G2A$FIX-DAILY" "$G2AT" "When…" "July 11" "July 11, 2026" "Update Rule" "g2a-chooser2"
snap "g2a-2-updaterule" "REPX3-G2A$FIX-DAILY%"
snapdiff "g2a-1-exception" "g2a-2-updaterule" "G2A step 2 — Update Rule on a series that HOLDS an exception"
note "  template: $(rsum "$G2AT")"
note "  the exception instance survives? $(gq "SELECT COUNT(*) FROM TMTask WHERE uuid='$G2A_EXC' AND trashed=0") (1 = yes, untrashed)"
note "  series rows:"; seriesrows "$G2AT"
note "  app alive: $(alive)"

note ""; note "  --- clock 2026-07-09 (the exception's own day) ---"
setclock "070912002026"
snap "g2a-3-day09" "REPX3-G2A$FIX-DAILY%"
snapdiff "g2a-2-updaterule" "g2a-3-day09" "G2A — clock 2026-07-09"
note "  template: $(rsum "$G2AT")   rows on 07-09 = $(daycount "$G2AT" 9)"
note "  --- clock 2026-07-11 (the re-anchored rule's first date) ---"
setclock "071112002026"
snap "g2a-4-day11" "REPX3-G2A$FIX-DAILY%"
snapdiff "g2a-3-day09" "g2a-4-day11" "G2A — clock 2026-07-11"
note "  template: $(rsum "$G2AT")   rows on 07-11 = $(daycount "$G2AT" 11)"
note "  series rows:"; seriesrows "$G2AT"
setclock "070512002026"
fi

# =====================================================================
# G2B — a SECOND exception on a series that already holds one.
if has_cell G2B; then
note ""; note "########## CELL G2B — a SECOND exception on a series already holding one ##########"
setclock "070512002026"; warm
G2BT=$(mkseries "REPX3-G2B$FIX-DAILY")
note "  template=$G2BT rule: $(rsum "$G2BT")"
snap "g2b-0-before" "REPX3-G2B$FIX-DAILY%"
note ""; note "  --- exception #1: projection 07-06 -> Jul 9 ---"
gesture "REPX3-G2B$FIX-DAILY" "$G2BT" "When…" "July 9" "July 9, 2026" "Make Exception" "g2b-chooser1"
snap "g2b-1-exc1" "REPX3-G2B$FIX-DAILY%"
snapdiff "g2b-0-before" "g2b-1-exc1" "G2B — exception #1"
note "  template: $(rsum "$G2BT")"
note ""; note "  --- exception #2: the NEXT projection (07-07) -> Jul 10 ---"
gesture "REPX3-G2B$FIX-DAILY" "$G2BT" "When…" "July 10" "July 10, 2026" "Make Exception" "g2b-chooser2"
snap "g2b-2-exc2" "REPX3-G2B$FIX-DAILY%"
snapdiff "g2b-1-exc1" "g2b-2-exc2" "G2B — exception #2 on a series that already holds one"
note "  template: $(rsum "$G2BT")"
note "  series rows:"; seriesrows "$G2BT"
note "  app alive: $(alive)"
note ""; note "  --- clock 2026-07-07: BOTH 07-06 and 07-07 slots should be consumed ---"
setclock "070712002026"
snap "g2b-3-day07" "REPX3-G2B$FIX-DAILY%"
snapdiff "g2b-2-exc2" "g2b-3-day07" "G2B — clock 2026-07-07 (both vacated slots)"
note "  template: $(rsum "$G2BT")   rows on 07-06 = $(daycount "$G2BT" 6)   rows on 07-07 = $(daycount "$G2BT" 7)"
note "  --- clock 2026-07-08: the first UNCONSUMED slot, must spawn ---"
setclock "070812002026"
snap "g2b-4-day08" "REPX3-G2B$FIX-DAILY%"
snapdiff "g2b-3-day07" "g2b-4-day08" "G2B — clock 2026-07-08 (control spawn)"
note "  template: $(rsum "$G2BT")   rows on 07-08 = $(daycount "$G2BT" 8)"
note "  series rows:"; seriesrows "$G2BT"
setclock "070512002026"
fi

# =====================================================================
# G3A — two exceptions onto the SAME day: does the app dedupe?
if has_cell G3A; then
note ""; note "########## CELL G3A — an exception onto a day that ALREADY holds an occurrence ##########"
setclock "070512002026"; warm
G3AT=$(mkseries "REPX3-G3A$FIX-DAILY")
note "  template=$G3AT rule: $(rsum "$G3AT")"
snap "g3a-0-before" "REPX3-G3A$FIX-DAILY%"
note ""; note "  --- exception #1: projection 07-06 -> Jul 9 (occupies the day) ---"
gesture "REPX3-G3A$FIX-DAILY" "$G3AT" "When…" "July 9" "July 9, 2026" "Make Exception" "g3a-chooser1"
snap "g3a-1-exc1" "REPX3-G3A$FIX-DAILY%"
snapdiff "g3a-0-before" "g3a-1-exc1" "G3A — exception #1 onto the free day 07-09"
note "  rows on 07-09 = $(daycount "$G3AT" 9)   template: $(rsum "$G3AT")"
note ""; note "  --- exception #2: the NEXT projection (07-07) onto the SAME day, Jul 9 ---"
gesture "REPX3-G3A$FIX-DAILY" "$G3AT" "When…" "July 9" "July 9, 2026" "Make Exception" "g3a-chooser2"
snap "g3a-2-exc2" "REPX3-G3A$FIX-DAILY%"
snapdiff "g3a-1-exc1" "g3a-2-exc2" "G3A — exception #2 onto the OCCUPIED day 07-09"
note "  rows on 07-09 = $(daycount "$G3AT" 9)  (2 = the app stacked them; 1 = deduped)"
note "  template: $(rsum "$G3AT")"
note "  series rows:"; seriesrows "$G3AT"
note "  app alive: $(alive)"
note ""; note "  --- clock 2026-07-08 (the first unconsumed slot) ---"
setclock "070812002026"
snap "g3a-3-day08" "REPX3-G3A$FIX-DAILY%"
snapdiff "g3a-2-exc2" "g3a-3-day08" "G3A — clock 2026-07-08"
note "  template: $(rsum "$G3AT")   rows on 07-08 = $(daycount "$G3AT" 8)"
note "  --- clock 2026-07-09: the spawner ARRIVES at the occupied day ---"
setclock "070912002026"
snap "g3a-4-day09" "REPX3-G3A$FIX-DAILY%"
snapdiff "g3a-3-day08" "g3a-4-day09" "G3A — clock 2026-07-09 (arrival at a day holding two exception rows)"
note "  template: $(rsum "$G3AT")   rows on 07-09 = $(daycount "$G3AT" 9)"
note "  series rows:"; seriesrows "$G3AT"
setclock "070512002026"
fi

# =====================================================================
# G3B — the spawner-collision route: park the exception ON the rule's own next
# slot, so the cursor comes to rest on a day that already holds the occurrence.
if has_cell G3B; then
note ""; note "########## CELL G3B — an exception parked ON the rule's OWN next slot ##########"
setclock "070512002026"; warm
G3BT=$(mkseries "REPX3-G3B$FIX-DAILY")
note "  template=$G3BT rule: $(rsum "$G3BT")"
note "  moving the 07-06 projection onto 07-07 — the slot the cursor will advance to."
snap "g3b-0-before" "REPX3-G3B$FIX-DAILY%"
gesture "REPX3-G3B$FIX-DAILY" "$G3BT" "When…" "July 7" "July 7, 2026" "Make Exception" "g3b-chooser"
snap "g3b-1-exception" "REPX3-G3B$FIX-DAILY%"
snapdiff "g3b-0-before" "g3b-1-exception" "G3B — Make Exception onto the rule's own next slot"
note "  template: $(rsum "$G3BT")   rows on 07-07 = $(daycount "$G3BT" 7)"
note "  series rows:"; seriesrows "$G3BT"
note ""; note "  ===== clock 2026-07-07: does the spawner DOUBLE-BOOK the day? ====="
setclock "070712002026"
snap "g3b-2-day07" "REPX3-G3B$FIX-DAILY%"
snapdiff "g3b-1-exception" "g3b-2-day07" "G3B — clock 2026-07-07 (cursor day == the exception's day)"
note "  template: $(rsum "$G3BT")"
note "  VERDICT INPUT: untrashed series rows dated 2026-07-07 = $(daycount "$G3BT" 7)  (1 = deduped/no spawn; 2 = DOUBLE-BOOKED)"
note "  series rows:"; seriesrows "$G3BT"
note "  --- one more day (07-08), for the ordinary cadence ---"
setclock "070812002026"
snap "g3b-3-day08" "REPX3-G3B$FIX-DAILY%"
snapdiff "g3b-2-day07" "g3b-3-day08" "G3B — clock 2026-07-08"
note "  template: $(rsum "$G3BT")   rows on 07-08 = $(daycount "$G3BT" 8)"
setclock "070512002026"
fi

# =====================================================================
# G4A — ⌘Z against the Make Exception branch.
if has_cell G4A; then
note ""; note "########## CELL G4A — the app's own ⌘Z immediately after MAKE EXCEPTION ##########"
setclock "070512002026"; warm
G4AT=$(mkseries "REPX3-G4A$FIX-DAILY")
note "  template=$G4AT rule: $(rsum "$G4AT")"
snap "g4a-0-before" "REPX3-G4A$FIX-DAILY%"
gesture "REPX3-G4A$FIX-DAILY" "$G4AT" "When…" "July 9" "July 9, 2026" "Make Exception" "g4a-chooser"
snap "g4a-1-exception" "REPX3-G4A$FIX-DAILY%"
snapdiff "g4a-0-before" "g4a-1-exception" "G4A — Make Exception"
note "  template: $(rsum "$G4AT")"
note ""; note "  --- the Edit menu, then ⌘Z ---"
appundo
snap "g4a-2-undone" "REPX3-G4A$FIX-DAILY%"
snapdiff "g4a-1-exception" "g4a-2-undone" "G4A — ⌘Z after Make Exception"
note "  template: $(rsum "$G4AT")"
note "  series rows:"; seriesrows "$G4AT"
note "  --- durability across a relaunch ---"
quitapp; relaunch
snap "g4a-3-relaunch" "REPX3-G4A$FIX-DAILY%"
snapdiff "g4a-2-undone" "g4a-3-relaunch" "G4A — across a relaunch"
note "  NET effect vs the pre-gesture state:"
snapdiff "g4a-0-before" "g4a-3-relaunch" "G4A — Make Exception + ⌘Z, NET"
note ""; note "  --- clock 2026-07-06: is the slot UN-consumed (does it spawn again)? ---"
setclock "070612002026"
snap "g4a-4-day06" "REPX3-G4A$FIX-DAILY%"
snapdiff "g4a-3-relaunch" "g4a-4-day06" "G4A — clock 2026-07-06 after the undo"
note "  template: $(rsum "$G4AT")   rows on 07-06 = $(daycount "$G4AT" 6)   rows on 07-09 = $(daycount "$G4AT" 9)"
note "  series rows:"; seriesrows "$G4AT"
setclock "070512002026"
fi

# =====================================================================
# G4B — ⌘Z against the Update Rule branch.
if has_cell G4B; then
note ""; note "########## CELL G4B — the app's own ⌘Z immediately after UPDATE RULE ##########"
setclock "070512002026"; warm
G4BT=$(mkseries "REPX3-G4B$FIX-DAILY")
note "  template=$G4BT rule: $(rsum "$G4BT")"
snap "g4b-0-before" "REPX3-G4B$FIX-DAILY%"
note "  rule blob before: $(awk -F'\t' -v u="$G4BT" '$1==u && $2=="rt1_recurrenceRule"{print $3}' "$OUT/snap/g4b-0-before.tsv")"
gesture "REPX3-G4B$FIX-DAILY" "$G4BT" "When…" "July 9" "July 9, 2026" "Update Rule" "g4b-chooser"
snap "g4b-1-updaterule" "REPX3-G4B$FIX-DAILY%"
snapdiff "g4b-0-before" "g4b-1-updaterule" "G4B — Update Rule"
note "  template: $(rsum "$G4BT")"
note ""; note "  --- the Edit menu, then ⌘Z ---"
appundo
snap "g4b-2-undone" "REPX3-G4B$FIX-DAILY%"
snapdiff "g4b-1-updaterule" "g4b-2-undone" "G4B — ⌘Z after Update Rule"
note "  template: $(rsum "$G4BT")"
note "  --- durability across a relaunch ---"
quitapp; relaunch
snap "g4b-3-relaunch" "REPX3-G4B$FIX-DAILY%"
snapdiff "g4b-2-undone" "g4b-3-relaunch" "G4B — across a relaunch"
note "  NET effect vs the pre-gesture state:"
snapdiff "g4b-0-before" "g4b-3-relaunch" "G4B — Update Rule + ⌘Z, NET"
note ""; note "  --- clock 2026-07-06: is the ORIGINAL phase restored (does it spawn)? ---"
setclock "070612002026"
snap "g4b-4-day06" "REPX3-G4B$FIX-DAILY%"
snapdiff "g4b-3-relaunch" "g4b-4-day06" "G4B — clock 2026-07-06 after the undo"
note "  template: $(rsum "$G4BT")   rows on 07-06 = $(daycount "$G4BT" 6)"
note "  series rows:"; seriesrows "$G4BT"
setclock "070512002026"
fi

note ""; note "REPX3 complete — artifacts in $OUT"
