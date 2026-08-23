#!/bin/bash
# SYNCX1 — the exception's SYNC behavior (docs/lab/syncx1-exception-sync.md).
#
# The hard precondition for ever shipping an exception-move op, and the one cell
# REPX2/REPX3 could not touch (all single-device). Occurrences materialize
# INDEPENDENTLY per device and dedupe by a DETERMINISTIC SLOT-DERIVED uuid
# (craft §4c, SYNC2B SY-3, SYNC3 SY-3b; REPX3 §4.1 proved the derivation is
# (template, slot), not the date the row ends up on). A `Make Exception` on
# device A consumes the slot by advancing A's cursor — ORDINARY merged data,
# byte-identical to what a clock spawn of that slot writes (REPX3 §1.3) — and
# mints the slot's row early with a re-dated startDate.
#
# So: device B, whose clock may reach the vacated slot before A's merge arrives,
# spawns the occurrence with THE SAME uuid. The merge must collapse the two.
#   CELL 1  MERGE-FIRST  — B receives the exception BEFORE its clock reaches the
#                          slot, then rolls onto it. Does B spawn anything?
#   CELL 2  SPAWN-FIRST  — B spawns the vacated slot BEFORE receiving A's
#                          changes; then both sync. One row or two? And WHICH
#                          startDate survives — A's exception date or B's rule
#                          date? (A's exception is umd-SILENT on the template,
#                          REPX3 §1.2 — so the per-attribute max-merge has to
#                          pick between two INSTANCE rows with the same uuid.)
#   CELL 3  RULE-CHANGE  — A's `Update Rule` re-anchor vs B's stale-cursor
#                          spawn. Same shape, coarser stakes (no row minted;
#                          the rule blob + both cursor columns move, umd bumps).
#   CELL 4  INTEGRITY    — relaunch both, twice, at two later clocks: no ghost,
#                          no duplicate resurrection on the next sweep.
#   CELL 5  §17 x-device — an exception parked on a LIVE rule slot double-books
#                          on ONE device (oddities §17). Does device B make it
#                          THREE? (the up-next rider on this campaign)
#
# ==== HARD RAILS ====
# * DURABLE account (no churn): creds live ONLY in the PRIMARY checkout's
#   gitignored lab/artifacts/sync-durable-account/, by ABSOLUTE path. LOGIN path
#   only — never re-register, never burn. The password never reaches a log: it
#   is piped over ssh STDIN into the guest's pbcopy and pasted with ⌘V.
# * NEVER touches the host Things app/container or Mike's real Things Cloud account.
# * TWO clones, but only ONE RUNNING AT A TIME (a sibling campaign holds the
#   other slot of the host's 2-VM ceiling). Every phase boots one clone, acts,
#   and stops it; `teardown` deletes both. The golden is never booted.
# * Deliberately network-enabled (overrides the harness airgap) — the documented
#   SYNC2/SYNCLAT/TOMB1 deviation, since these probes REQUIRE the sync server.
# * THE TRIAL WALL: golden-v4's Things is a 15-day trial expiring 2026-07-18
#   (REPX3 §5). setclock refuses any roll to 07-18 or later, and every boot
#   PINS THE CLOCK BEFORE Things is ever launched — a single launch at real time
#   (2026-08+) burns the clone, stickily.
#
# ==== SCHEDULE (all inside the wall) ====
#   fixtures: EVERY-2-DAYS seeded 2026-07-05 -> slots 07-07 / 07-09 / 07-11 / 07-13
#   p1  A @07-05  create C1..C4; exception C1 07-07->Jul 12 (a NON-slot day);
#                 exception C4 07-07->Jul 9 (a LIVE slot — cell 5)
#   p2  B @07-05  login, pull; go OFFLINE; roll 07-07; observe (cell 1 + spawns)
#   p3  A @07-05  exception C2 07-07->Jul 14 (non-slot); Update Rule C3 ->Jul 12
#   p4  B @07-07  reconnect, converge; measure cells 2/3 on B
#   p5  A @07-05  converge; measure cells 2/3 on A; then roll A to 07-07
#   p6  B @07-09  roll, converge; cell 5 + integrity
#   p7  A @07-09  roll, converge; cell 5 + integrity, final byte-level compare
#
# Usage: PHASE as $1 (p1|p2|p3|p4|p5|p6|p7|teardown|diag)
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v4}"
VMA="${VMA:-syncx1-a}"
VMB="${VMB:-syncx1-b}"
PHASE="${1:-diag}"
OUT="${OUT:-lab/artifacts/syncx1-lab}"; mkdir -p "$OUT/ax" "$OUT/snap" "$OUT/shot"
REPORT="$OUT/report.txt"
STATE="$OUT/state.env"        # carries uuids/dates between phases
note(){ echo "[syncx1:$PHASE] $*" | tee -a "$REPORT"; }
saveto(){ printf '%s=%s\n' "$1" "$2" >> "$STATE"; }
[ -f "$STATE" ] && source "$STATE"

# DURABLE artifacts MUST outlive the run -> PRIMARY checkout, ABSOLUTE path.
DURABLE_ENV="/Volumes/Workspace/Projects/things-api/lab/artifacts/sync-durable-account/account-credentials.env"
[ -f "$DURABLE_ENV" ] || { note "FATAL: durable account creds missing at $DURABLE_ENV — this campaign is LOGIN-ONLY (no minting)"; exit 1; }
source "$DURABLE_ENV"

PIN0="070512002026"   # 2026-07-05 12:00
PIN7="070712002026"
PIN9="070912002026"
TRIAL_WALL="20260718"

IP=""; VM=""

# ---------------------------------------------------------------- VM lifecycle
running_vms(){ tart list 2>/dev/null | awk 'NR>1 && $NF=="running"{print $2}'; }
vm_exists(){ tart list 2>/dev/null | awk -v v="$1" 'NR>1 && $2==v{f=1} END{exit !f}'; }
vm_state(){ tart list 2>/dev/null | awk -v v="$1" 'NR>1 && $2==v{print $NF}'; }
stop_vm(){ tart stop "$1" >/dev/null 2>&1; sleep 3; }
boot(){ # boot <vmname> <pindate> [tz]
  VM="$1"; local pin="$2" tz="${3:-}"
  local others; others=$(running_vms | grep -v "^$VM$" | grep -v vmres1-lab || true)
  [ -n "$others" ] && { note "FATAL: another campaign VM is running ($others) — the ceiling is one for us"; exit 1; }
  vm_exists "$VM" || { note "FATAL: $VM does not exist (run p1 first)"; exit 1; }
  if [ "$(vm_state "$VM")" != "running" ]; then
    (tart run "$VM" --no-graphics --vnc-experimental >>"$OUT/tart-run-$VM.log" 2>&1 &)
    sleep 4
  fi
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH on $VM"; exit 1; }
  # PIN THE CLOCK BEFORE ANYTHING CAN LAUNCH THINGS (the trial wall is sticky).
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $pin >/dev/null" </dev/null
  [ -n "$tz" ] && lab_ssh "$IP" "sudo systemsetup -settimezone $tz >/dev/null 2>&1" </dev/null
  note "$VM up at $IP — guest clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null), Things running=$(lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo YES || echo no' </dev/null)"
  grep -o 'vnc://[^ ]*' "$OUT/tart-run-$VM.log" | tail -1 > "$OUT/vnc-$VM.txt" 2>/dev/null || true
  install_helpers
}
KEEP="${KEEP:-0}"
cleanup(){ [ "$KEEP" = "1" ] && { note "KEEP=1 — leaving $VM running at $IP"; return; }
  [ -n "$VM" ] && { note "trap: stopping $VM (clones kept for the next phase; 'teardown' deletes them)"; stop_vm "$VM"; }; }
trap cleanup EXIT

# ---------------------------------------------------------------- guest helpers
install_helpers(){
  lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
  lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, startDate, rt1_instanceCreationPaused, userModificationDate FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
if row[0] is None:
    print("NO-RULE next=%s icStart=%s icCount=%s startDate=%s"%(dpk(row[1]),dpk(row[2]),row[3],dpk(row[5]))); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
import hashlib
print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] next=%s icStart=%s icCount=%s paused=%s umd=%s rule=sha256:%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),
    dpk(row[1]),dpk(row[2]),row[3],row[6],row[7],hashlib.sha256(row[0]).hexdigest()[:16]))
EOF
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
  # BSSyncronyMetadata last-sync signal (value-based nearest-to-now heuristic)
  lab_ssh "$IP" 'cat > ~/labh/sig.sh && chmod +x ~/labh/sig.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
sqlite3 -noheader -list "file:$DB?mode=ro" "SELECT quote(value) FROM BSSyncronyMetadata" | python3 -c "
import sys,plistlib,time
best=None; now2001=time.time()-978307200
for line in sys.stdin:
    line=line.strip()
    if not (line.startswith(chr(88)+chr(39)) and line.endswith(chr(39))): continue
    try: v=plistlib.loads(bytes.fromhex(line[2:-1]))
    except Exception: continue
    if isinstance(v,float) and v < now2001 + 5*365*86400:
        if best is None or v>best: best=v
print(f'{best:.3f}' if best is not None else 'NONE')
"
EOF
  # AX: full tree of EVERY window (Settings included), plus sheets/popovers.
  lab_ssh "$IP" 'cat > ~/labh/axtool.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function flat(el,acc,d){acc.push(el); if(d>20)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)flat(ch[i],acc,d+1); return acc}
function frame(el){var p=attr(el,'AXPosition'),z=attr(el,'AXSize');function d(x){if(!x)return null;return ObjC.castRefToObject($.CFCopyDescription(x)).js}
  var pp=d(p),zz=d(z);var mp=pp&&pp.match(/x:([-0-9.]+) y:([-0-9.]+)/);var mz=zz&&zz.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return {x:mp?+mp[1]:null,y:mp?+mp[2]:null,w:mz?+mz[1]:null,h:mz?+mz[2]:null}}
function label(el){return [sv(el,'AXTitle'),sv(el,'AXDescription'),sv(el,'AXValue'),sv(el,'AXIdentifier')].join(' ')}
function line(el,d,ix){
  var p=['['+ix+'] role='+sv(el,'AXRole')]
  var s=sv(el,'AXSubrole'); if(s)p.push('sub='+s)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de.slice(0,110))
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,110))
  var id=sv(el,'AXIdentifier'); if(id)p.push('id='+id)
  var en=sv(el,'AXEnabled'); if(en==='false')p.push('DISABLED')
  var f=frame(el); if(f.x!==null)p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']')
  return Array(d+1).join('  ')+p.join(' | ')}
function walk(el,d,acc,ix){acc.push(line(el,d,ix)); if(d>16)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc,i+1); return acc}
function clickPt(x,y){var pt=$.CGPointMake(x,y)
  function post(t){$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent($(),t,pt,$.kCGMouseButtonLeft))}
  post($.kCGEventMouseMoved); delay(0.3); post($.kCGEventLeftMouseDown); delay(0.12); post($.kCGEventLeftMouseUp)}
function run(argv){
  var cmd=argv[0]||'dump'
  var app=$.AXUIElementCreateApplication(pidOf('Things3'))
  if(cmd==='dump'){
    var ws=kids(app), acc=[]
    for(var i=0;i<ws.length;i++){var w=ws[i], f=frame(w)
      acc.push('=== WINDOW '+(i+1)+' sub='+sv(w,'AXSubrole')+' ttl='+sv(w,'AXTitle')+' id='+sv(w,'AXIdentifier')+' @['+f.x+','+f.y+' '+f.w+'x'+f.h+'] ===')
      walk(w,0,acc,i+1)}
    if(!acc.length)acc.push('(no windows)')
    return acc.join('\n')}
  var all=[]; flat(app,all,0)
  if(cmd==='find'){   // find <needle> — every element whose labels contain needle
    var nd=argv[1], out=[]
    for(var i=0;i<all.length;i++){ if(label(all[i]).toLowerCase().indexOf(nd.toLowerCase())>=0){var f=frame(all[i]); out.push(sv(all[i],'AXRole')+' | '+line(all[i],0,i))} }
    return out.length?out.join('\n'):'NO ELEMENT matching "'+nd+'"'}
  if(cmd==='press'){  // press <needle> — AXPress the first BUTTON titled/id'd needle
    var want=argv[1]
    var btns=all.filter(function(e){var r=sv(e,'AXRole');return r==='AXButton'||r==='AXRadioButton'||r==='AXCheckBox'})
    var names=btns.map(function(e){return sv(e,'AXRole')+':'+(sv(e,'AXTitle')||sv(e,'AXDescription')||'?')+'#'+sv(e,'AXIdentifier')})
    for(var i=0;i<btns.length;i++){
      if(sv(btns[i],'AXTitle')===want||sv(btns[i],'AXIdentifier')===want||sv(btns[i],'AXDescription')===want){
        var rc=$.AXUIElementPerformAction(btns[i],$('AXPress'))
        return 'PRESSED "'+want+'" (AXError='+rc+'); present: '+names.join(' | ')}}
    return 'NO BUTTON "'+want+'" — present: '+names.join(' | ')}
  if(cmd==='clicklabel'){ // clicklabel <needle> [nth] — CGEvent click the nth element whose labels contain needle
    var nd=argv[1], nth=parseInt(argv[2]||'1',10)
    var hits=all.filter(function(e){return label(e).toLowerCase().indexOf(nd.toLowerCase())>=0 && frame(e).w>2})
    if(hits.length<nth) return 'ONLY '+hits.length+' elements match "'+nd+'"'
    var el=hits[nth-1], f=frame(el); clickPt(f.x+f.w/2,f.y+f.h/2)
    return 'CLICKED '+sv(el,'AXRole')+' ('+nth+' of '+hits.length+') at ('+(f.x+f.w/2)+','+(f.y+f.h/2)+') label='+label(el).slice(0,90)}
  if(cmd==='clicktf'){ // clicktf <AXTitle> — CGEvent-click the TEXT FIELD with that title
    var t=argv[1]
    var tfs=all.filter(function(e){return sv(e,'AXRole')==='AXTextField' && sv(e,'AXTitle')===t})
    if(!tfs.length) return 'NO AXTextField titled "'+t+'" — fields: '+all.filter(function(e){return sv(e,'AXRole')==='AXTextField'}).map(function(e){return sv(e,'AXTitle')+'/'+sv(e,'AXSubrole')}).join(' | ')
    var f4=frame(tfs[0]); clickPt(f4.x+f4.w/2,f4.y+f4.h/2)
    return 'CLICKED text field "'+t+'" sub='+sv(tfs[0],'AXSubrole')+' at ('+(f4.x+f4.w/2)+','+(f4.y+f4.h/2)+')'}
  if(cmd==='clickrole'){ // clickrole <role> <nth>
    var role=argv[1], n=parseInt(argv[2]||'1',10)
    var hits=all.filter(function(e){return sv(e,'AXRole')===role})
    if(hits.length<n) return 'ONLY '+hits.length+' '+role
    var el2=hits[n-1], f2=frame(el2); clickPt(f2.x+f2.w/2,f2.y+f2.h/2)
    return 'CLICKED '+role+' '+n+'/'+hits.length+' at ('+(f2.x+f2.w/2)+','+(f2.y+f2.h/2)+') val='+sv(el2,'AXValue')}
  if(cmd==='firstval'){ // firstval <role> — the AXValue of the first element of that role
    var r5=argv[1]; var h5=all.filter(function(e){return sv(e,'AXRole')===r5})
    return h5.length?sv(h5[0],'AXValue'):'NONE'}
  if(cmd==='readrole'){
    var role3=argv[1]
    var hits3=all.filter(function(e){return sv(e,'AXRole')===role3})
    return hits3.map(function(e,i){return (i+1)+': '+line(e,0,i+1)}).join('\n')||'NO '+role3}
  return 'unknown cmd '+cmd}
EOF
  # The projection-row click (REPX1/REPX2/REPX3 recipe).
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
  var needle=argv[0], want=argv[1]||'Checkbox'
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
    function post(type){$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent($(),type,pt,$.kCGMouseButtonLeft))}
    post($.kCGEventMouseMoved); delay(0.3); post($.kCGEventLeftMouseDown); delay(0.12); post($.kCGEventLeftMouseUp)
    return 'CLICKED '+want+' of the '+needle+' row at ('+x+','+y+') [row '+(i+1)+' of '+rows.length+']'
  }
  return 'no AXTableRow subtree mentions '+needle+' (rows scanned: '+rows.length+')'
}
EOF
}

gq(){ lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt(){ lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
rsum(){ lab_ssh "$IP" "python3 ~/labh/rsum.py $1" </dev/null 2>&1; }
sig(){ lab_ssh "$IP" 'bash ~/labh/sig.sh' </dev/null; }
ax(){ lab_ssh "$IP" "osascript -l JavaScript ~/labh/axtool.jxa $(printf '%q' "${1:-dump}") $(printf '%q' "${2:-}") $(printf '%q' "${3:-}")" </dev/null 2>&1; }
axdump(){ ax dump > "$OUT/ax/$1.txt"; note "  [axdump $1: $(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines, $(grep -c '^=== WINDOW' "$OUT/ax/$1.txt") windows]"; }
axq(){ lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
clickrow(){ lab_ssh "$IP" "osascript -l JavaScript ~/labh/clickrow.jxa $(printf '%q' "$1") $(printf '%q' "${2:-Checkbox}")" </dev/null 2>&1; }
alive(){ lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
crashes(){ lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -c "^Things3-.*\.ips$" | tr -d " "' </dev/null; }

launch_things(){ lab_ssh "$IP" 'open -a Things3; sleep 20; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 3; true' </dev/null; }
quitapp(){ lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 5; true' </dev/null; }
relaunch(){ quitapp; launch_things; }
esc(){ lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }

setclock(){ # setclock MMDDhhmmYYYY — quits the app first, relaunches after
  local d="$1" ymd="${1:8:4}${1:0:2}${1:2:2}"
  if [ "$ymd" -ge "$TRIAL_WALL" ]; then
    note "    REFUSED clock roll to $ymd — golden-v4's trial wall is $TRIAL_WALL"; return 1
  fi
  quitapp
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $d >/dev/null; date" </dev/null | sed 's/^/    clock now: /' | tee -a "$REPORT"
  launch_things
}
go_offline(){ lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit" 2>/dev/null; sleep 3
  sudo route -n delete -inet default >/dev/null 2>&1; sudo route -n delete -inet6 default >/dev/null 2>&1; sleep 1
  curl -s -m6 -o /dev/null -w "cloud=%{http_code}\n" https://cloud.culturedcode.com 2>&1 || echo cloud=000' </dev/null | sed 's/^/    /' | tee -a "$REPORT"; }
cloud_reach(){ lab_ssh "$IP" 'curl -s -m8 -o /dev/null -w "%{http_code}" https://cloud.culturedcode.com' </dev/null; }

snap(){ # snap <name> <titleLike>
  lab_ssh "$IP" "python3 ~/labh/rowsnap.py $(printf '%q' "$2")" </dev/null > "$OUT/snap/$1.tsv" 2>&1
  note "  [snap $1: $(wc -l <"$OUT/snap/$1.tsv"|tr -d ' ') field-lines, $(cut -f1 "$OUT/snap/$1.tsv"|sort -u|wc -l|tr -d ' ') rows]"
}
snapdiff(){ note "  ---- ROW DELTA ${3:-$1 -> $2} ----"
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
# Cross-DEVICE byte compare: the same rows pulled from A and from B.
devcmp(){ note "  ---- CROSS-DEVICE COMPARE ${1} (A) vs ${2} (B) ----"
  python3 - "$OUT/snap/$1.tsv" "$OUT/snap/$2.tsv" <<'PY' | tee -a "$REPORT"
import sys
def load(p):
    d={}
    for line in open(p):
        parts=line.rstrip("\n").split("\t")
        if len(parts)<3: continue
        d[(parts[0],parts[1])]=parts[2]
    return d
a=load(sys.argv[1]); b=load(sys.argv[2])
ua={k[0] for k in a}; ub={k[0] for k in b}
for u in sorted(ua-ub): print("    ONLY ON A: %s"%u)
for u in sorted(ub-ua): print("    ONLY ON B: %s"%u)
common=ua&ub
# columns that legitimately differ per device (local ranks / device-local index)
LOCAL={'index','todayIndex','experimental'}
diffs=[(k,a[k],b[k]) for k in sorted(a) if k[0] in common and k in b and a[k]!=b[k] and k[1] not in LOCAL]
if not diffs: print("    IDENTICAL on both devices (%d rows, %d fields, ignoring %s)"%(len(common),len([k for k in a if k[0] in common]),sorted(LOCAL)))
for (u,c),va,vb in diffs: print("    DIFFER %s.%s: A=%s  B=%s"%(u[:8],c,va,vb))
PY
}

pk(){ echo $(( (2026<<16) | (7<<12) | ($1<<7) )); }
daycount(){ gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 AND startDate=$(pk "$2")"; }
seriesrows(){ gt "SELECT substr(uuid,1,8) AS uuid8, status, trashed, start, startDate, creationDate, userModificationDate AS umd, notes, rt1_repeatingTemplate IS NOT NULL AS isinst FROM TMTask WHERE uuid='$1' OR rt1_repeatingTemplate='$1' ORDER BY creationDate" | sed 's/^/    /' | tee -a "$REPORT"; }

# ---------------------------------------------------------------- account login
# AX-driven (no VNC): the AXVM1 grant is baked into golden-v4, so System Events
# and CGEventPost reach the Settings window. The password is piped over ssh
# STDIN into the guest's pbcopy and pasted with ⌘V — it never enters an argv,
# a log or this report.
paste_secret(){ # paste_secret <value>   (field must already be focused)
  lab_ssh "$IP" 'cat > /tmp/.s && printf "%s" "$(cat /tmp/.s)" | pbcopy && rm -f /tmp/.s' <<<"$1"
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "a" using command down'\''; sleep 1' </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "v" using command down'\''; sleep 1' </dev/null
}
# The Things Cloud login form is a WEB VIEW: on a cold clone the sheet shows an
# AXBusyIndicator for several seconds before any control exists, and a fixed
# sleep raced it (device B's first attempt drove an empty sheet). Poll instead.
wait_ax(){ # wait_ax <needle> <timeout-seconds>
  local needle="$1" t="${2:-90}" start=$SECONDS
  while [ $((SECONDS-start)) -lt "$t" ]; do
    ax find "$needle" 2>/dev/null | grep -q "^NO ELEMENT" || { note "    [wait_ax] '$needle' present after $((SECONDS-start))s"; return 0; }
    sleep 3
  done
  note "    [wait_ax] TIMEOUT after ${t}s waiting for '$needle'"; return 1
}
open_settings(){
  # RESID1: quit+relaunch first — a stale window state makes ⌘, return -1728.
  relaunch
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2; osascript -e '\''tell application "System Events" to keystroke "," using command down'\''; sleep 4' </dev/null
}
# The 3.23 Things Cloud pane: the enable button is an UNTITLED AXButton
# (id=_NS:35) beside the cloud logo; the login form arrives as a sheet.
login_account(){ # login_account <A|B>
  local tag="$1"
  note "== attaching the DURABLE account to $tag (login path; creds never logged) =="
  local rows; rows=$(gq 'SELECT COUNT(*) FROM BSSyncronyMetadata')
  if [ "${rows:-0}" -gt 0 ]; then note "  already attached (BSSyncronyMetadata rows=$rows) — skipping"; return 0; fi
  open_settings
  axdump "$tag-login-01-settings"
  ax press "Things Cloud" | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
  ax clicklabel "_NS:35" 1 | sed 's/^/    /' | tee -a "$REPORT"
  wait_ax "Create Account" 120 || { note "  FATAL: the account sheet never loaded"; axdump "$tag-login-FAIL"; exit 1; }
  axdump "$tag-login-02-enabled"
  # The pane now offers "Log In" / "Create Account"; take the LOGIN path only.
  ax press "Log In" | sed 's/^/    /' | tee -a "$REPORT"
  wait_ax "Email Address" 120 || { note "  FATAL: the login form never loaded"; axdump "$tag-login-FAIL"; exit 1; }
  axdump "$tag-login-03-form"
  # The form is a WEB AREA: "Email Address" is an AXTextField and "Password" an
  # AXTextField with sub=AXSecureTextField — address them by TITLE (a role-index
  # addressing hit the email field twice and concatenated the two secrets).
  # Each paste selects-all first so a retry cannot append.
  ax clicktf "Email Address" | sed 's/^/    /' | tee -a "$REPORT"
  paste_secret "$MAILTM_EMAIL"
  ax clicktf "Password" | sed 's/^/    /' | tee -a "$REPORT"
  paste_secret "$THINGS_CLOUD_PASS"
  axdump "$tag-login-04-filled"
  ax press "Log In" | sed 's/^/    /' | tee -a "$REPORT"
  wait_ax "Keep only the to-dos from Things Cloud" 180 || { note "  FATAL: no merge choice appeared (bad credentials, or the submit never went)"; axdump "$tag-login-FAIL"; exit 1; }
  axdump "$tag-login-05-submitted"
  # merge choice: "Keep only the to-dos from Things Cloud" (both clones carry the
  # identical golden seed; "Keep all" would duplicate it), then Continue.
  ax clicklabel "Keep only the to-dos from Things Cloud" 1 | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 2' </dev/null
  ax press "Continue" | sed 's/^/    /' | tee -a "$REPORT"
  local start=$SECONDS
  while [ $((SECONDS-start)) -lt 240 ]; do
    [ "$(gq 'SELECT COUNT(*) FROM BSSyncronyMetadata')" != "0" ] && break
    sleep 5
  done
  lab_ssh "$IP" 'sleep 15' </dev/null
  axdump "$tag-login-06-merged"
  local n2; n2=$(gq 'SELECT COUNT(*) FROM BSSyncronyMetadata')
  note "  BSSyncronyMetadata rows after attach: $n2 (after $((SECONDS-start))s)"
  [ "${n2:-0}" = "0" ] && { note "  FATAL: the account never attached"; exit 1; }
  return 0
}

# ---------------------------------------------------------------- fixtures
TOKEN=""
mkurl(){ lab_ssh "$IP" "open -g 'things:///add?title=$1&when=$2&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
select_item(){ local uuid="$1" want="$2" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get id of selected to dos' 2>/dev/null)
    [ "$sel" = "$want" ] && { note "    selection OK by UUID on attempt $i"; return 0; }
  done
  return 1; }
select_projection(){ local needle="$1" tmpl="$2" sel
  lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  select_item "$tmpl" "$tmpl" >/dev/null
  clickrow "$needle" "TITLE" | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 2' </dev/null
  sel=$(axq 'tell application "Things3" to get id of selected to dos' 2>/dev/null)
  [ "$sel" = "$tmpl" ] && { note "    PROJECTION selected — uuid == template ($sel)"; return 0; }
  note "    WARN: row click selected '$sel' — restoring the show?id= selection"
  select_item "$tmpl" "$tmpl" && return 0
  return 1; }
clickitem(){ axq "tell application \"System Events\" to tell process \"Things3\" to click menu item \"$1\" of menu \"Items\" of menu bar 1" 2>&1; lab_ssh "$IP" 'sleep 3' </dev/null; }
typetext(){ lab_ssh "$IP" "osascript -e $(printf '%q' "tell application \"System Events\" to keystroke \"$1\"")" </dev/null 2>&1; lab_ssh "$IP" 'sleep 2' </dev/null; }
keyret(){ lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 36'\''; sleep 4' </dev/null; }
sheetdump(){ ax dump > "$OUT/ax/$1.txt" 2>&1; }
pickdate(){ local want="$1"; shift; local p
  for p in "$@"; do
    lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "a" using command down'\''; sleep 1' </dev/null
    typetext "$p" >/dev/null
    ax dump > "$OUT/ax/pick-last.txt" 2>&1
    if grep -q "desc=$want" "$OUT/ax/pick-last.txt"; then
      note "    picker RESOLVED '$p' -> $(grep -o "desc=$want[^|]*" "$OUT/ax/pick-last.txt" | head -1)"; return 0
    fi
    note "    picker did NOT resolve '$p'; offered: $(grep -o 'desc=[^|]*' "$OUT/ax/pick-last.txt" | head -6 | tr '\n' ' ')"
  done
  note "    FATAL for this cell: no phrase resolved to '$want'"; return 1; }
chooser(){ ax dump > "$OUT/ax/$1.txt" 2>&1
  note "    action-buttons: $(grep -c 'id=action-button' "$OUT/ax/$1.txt")"
  grep -E "id=action-button|Repeating To-Do|one-time exception" "$OUT/ax/$1.txt" | sed 's/^/      /' | tee -a "$REPORT"; }
gesture(){ # gesture <titleNeedle> <tmpl> <menuItem> <wantRow> <phrase> <branch> <dump>
  local needle="$1" tmpl="$2" item="$3" want="$4" phrase="$5" branch="$6" dump="$7"
  select_projection "$needle" "$tmpl"
  clickitem "$item" | sed 's/^/    /' | tee -a "$REPORT"
  pickdate "$want" "$phrase" "$want" || { note "    ABORT gesture"; esc; esc; return 1; }
  keyret
  chooser "$dump"
  note "    --- pressing $branch ---"
  ax press "$branch" | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 8' </dev/null
  esc >/dev/null; }
mkrepeat_iv(){ # mkrepeat_iv <uuid> <title> <freq> <interval>
  local uuid="$1" title="$2" freq="$3" iv="$4"
  select_item "$uuid" "$uuid" || note "  WARN: selection unconfirmed for $title"
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
      return \"FREQ-NOT-FOUND\"
    end if
    click menu item hit of menu 1 of p
    delay 1.5
    return \"frequency = \" & hit
  end tell" | sed 's/^/    /' | tee -a "$REPORT"
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
  # Fallback (REPX3 §6): the shipped `set focused`+⌘A+type+Tab mechanic does not
  # always commit on a cloud-attached clone. A CGEvent click at the field's own
  # AX frame puts the caret at position 0, so the digit PREPENDS — type first,
  # then FORWARD-delete (key code 117) the stale digits.
  local ivnow; ivnow=$(ax firstval AXTextField)
  if [ "$ivnow" != "$iv" ]; then
    note "    interval still reads '$ivnow' — falling back to click+type+forward-delete"
    ax clickrole AXTextField 1 | sed 's/^/    /' | tee -a "$REPORT"
    typetext "$iv" >/dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to repeat 3 times
      key code 117
      delay 0.2
    end repeat'\''; sleep 1' </dev/null
    note "    interval field now reads: $(ax firstval AXTextField)"
    lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 48'\''; sleep 1' </dev/null
  fi
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    click button "OK" of sh
    delay 2
    return "pressed OK"
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 6' </dev/null; }
mkseries_iv(){ local nm="$1" freq="$2" iv="$3" seed tmpl
  seed=$(mkurl "$nm" "2026-07-05")
  mkrepeat_iv "$seed" "$nm" "$freq" "$iv" >/dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$nm' AND rt1_recurrenceRule IS NOT NULL LIMIT 1"; }

close_settings(){ axq 'tell application "System Events" to tell process "Things3"
    try
      click (first button of (first window whose title is "Things Cloud") whose subrole is "AXCloseButton")
    end try
    return "settings closed"
  end tell' >/dev/null 2>&1; lab_ssh "$IP" 'sleep 2' </dev/null; }
read_token(){ TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings"); }
# p1 must be re-runnable: a half-built fixture (an interval drive that did not
# take) would otherwise ride into the evidence. Trash every SYNCX1 row and empty
# the trash so the corpus starts genuinely empty on BOTH the device and the cloud.
purge_fixtures(){
  local u n; n=$(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'SYNCX1-%'")
  [ "${n:-0}" = "0" ] && return 0
  note "  purging $n pre-existing SYNCX1 rows"
  for u in $(gq "SELECT uuid FROM TMTask WHERE title LIKE 'SYNCX1-%'"); do
    axq "tell application \"Things3\" to delete to do id \"$u\"" >/dev/null 2>&1
  done
  lab_ssh "$IP" 'sleep 3' </dev/null
  axq 'tell application "Things3" to empty trash' >/dev/null 2>&1
  lab_ssh "$IP" 'sleep 8' </dev/null
  note "  after purge: $(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'SYNCX1-%'") SYNCX1 rows remain"
}
flush_sync(){ # give the writer time to push, then force a pull with a relaunch
  note "  [sync] signal before flush: $(sig)"
  lab_ssh "$IP" 'sleep 10' </dev/null
  relaunch; lab_ssh "$IP" 'sleep 12' </dev/null
  note "  [sync] signal after relaunch: $(sig)  cloud=$(cloud_reach)"; }
converge(){ # two relaunch rounds — APNs is unavailable in the VM, so a receiver
  # pulls only on relaunch / things:///show (SYNCLAT); two rounds settle a merge.
  relaunch; lab_ssh "$IP" 'sleep 15' </dev/null
  relaunch; lab_ssh "$IP" 'sleep 15' </dev/null
  note "  [sync] converged; signal=$(sig) cloud=$(cloud_reach) app=$(alive)"; }

CELLS_NAMES=(C1 C2 C3 C4)
census(){ # census <label> — the whole SYNCX1 corpus, per series
  note "  ===== CENSUS $1 ====="
  local n t
  for n in "${CELLS_NAMES[@]}"; do
    eval "t=\${${n}T:-}"
    [ -z "$t" ] && continue
    note "  -- SYNCX1-$n (template $t)"
    note "     rule: $(rsum "$t")"
    local d out=""
    for d in 5 6 7 8 9 10 11 12 13 14; do out="$out 07-$(printf %02d "$d")=$(daycount "$t" "$d")"; done
    note "     rows/day:$out"
    seriesrows "$t"
  done
  note "  total untrashed SYNCX1 rows: $(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'SYNCX1-%' AND trashed=0")"
}

note ""
note "################ SYNCX1 phase=$PHASE  golden=$GOLDEN ################"
case "$PHASE" in
  p1)
    # ---- device A: fixtures + the two MERGE-FIRST-arm gestures --------------
    vm_exists "$VMA" || { note "cloning $GOLDEN -> $VMA"; tart clone "$GOLDEN" "$VMA"; }
    boot "$VMA" "$PIN0"
    note "env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) ($(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / dbv $(gq "SELECT databaseVersion FROM Meta")"
    note "cloud reachable: $(cloud_reach)   crashes: $(crashes)"
    launch_things
    login_account A
    close_settings
    read_token
    note "auth token read: ${#TOKEN} chars"
    purge_fixtures
    note "== building four EVERY-2-DAYS series seeded 2026-07-05 (slots 07-07/09/11/13) =="
    for n in "${CELLS_NAMES[@]}"; do
      t=$(mkseries_iv "SYNCX1-$n" daily 2)
      note "  SYNCX1-$n template=$t  rule: $(rsum "$t")"
      fa=$(rsum "$t" | sed -n 's/.*fa=\([0-9]*\).*/\1/p')
      [ "$fa" = "2" ] || { note "  FATAL: SYNCX1-$n interval did not take (fa=$fa)"; exit 1; }
      saveto "${n}T" "$t"; eval "${n}T=$t"
    done
    snap "p1-0-before" "SYNCX1-%"
    note ""; note "== CELL 1 arm — exception on SYNCX1-C1: projection 07-07 -> Jul 12 (a NON-slot day) =="
    gesture "SYNCX1-C1" "$C1T" "When…" "July 12" "July 12, 2026" "Make Exception" "p1-c1-chooser"
    C1EXC=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$C1T' AND trashed=0 AND startDate=$(pk 12) LIMIT 1")
    note "  C1 exception row = $C1EXC (dated 2026-07-12)"; saveto C1EXC "$C1EXC"
    note ""; note "== CELL 5 arm — exception on SYNCX1-C4: projection 07-07 -> Jul 9 (a LIVE rule slot) =="
    gesture "SYNCX1-C4" "$C4T" "When…" "July 9" "July 9, 2026" "Make Exception" "p1-c4-chooser"
    C4EXC=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$C4T' AND trashed=0 AND startDate=$(pk 9) LIMIT 1")
    note "  C4 exception row = $C4EXC (dated 2026-07-09, a live slot)"; saveto C4EXC "$C4EXC"
    snap "p1-1-after" "SYNCX1-%"
    snapdiff "p1-0-before" "p1-1-after" "p1 — two Make Exception gestures on A"
    census "A after p1 (clock 07-05)"
    flush_sync
    snap "p1-2-A-pushed" "SYNCX1-%"
    note "  app alive: $(alive)  crashes: $(crashes)"
    ;;

  p2)
    # ---- device B: pull, go offline, roll onto the vacated slot -------------
    vm_exists "$VMB" || { note "cloning $GOLDEN -> $VMB"; tart clone "$GOLDEN" "$VMB"; }
    boot "$VMB" "$PIN0"
    note "cloud reachable: $(cloud_reach)"
    launch_things
    login_account B
    close_settings
    read_token
    converge
    note "== B's view of the corpus after the first pull =="
    census "B after login+pull (clock 07-05)"
    note "  >>> lineage check — templates must carry A's uuids:"
    for n in "${CELLS_NAMES[@]}"; do
      eval "t=\${${n}T}"
      note "     SYNCX1-$n template on B: $(gq "SELECT COUNT(*) FROM TMTask WHERE uuid='$t' AND rt1_recurrenceRule IS NOT NULL") (1 = same uuid synced down)"
    done
    note "  >>> C1's exception row present on B? $(gq "SELECT COUNT(*) FROM TMTask WHERE uuid='$C1EXC'")   C4's? $(gq "SELECT COUNT(*) FROM TMTask WHERE uuid='$C4EXC'")"
    snap "p2-0-B-pulled" "SYNCX1-%"
    note ""; note "== B goes TRULY OFFLINE (routes deleted; the merge cannot reach it) =="
    go_offline
    note "== roll B to 2026-07-07 — the slot every series' cursor is sitting on =="
    setclock "$PIN7"
    lab_ssh "$IP" 'sleep 20' </dev/null
    snap "p2-1-B-day07" "SYNCX1-%"
    snapdiff "p2-0-B-pulled" "p2-1-B-day07" "p2 — B alone at 2026-07-07 (offline)"
    census "B at 07-07, offline"
    note ""; note "  >>> CELL 1 (MERGE-FIRST) verdict input: rows dated 07-07 on C1 = $(daycount "$C1T" 7)  (0 = the merged cursor advance suppressed B's spawn)"
    note "  >>> CELL 5 arm:                             rows dated 07-07 on C4 = $(daycount "$C4T" 7)  (expect 0 — its slot was consumed too)"
    note "  >>> SPAWN-FIRST rows: C2 07-07 = $(daycount "$C2T" 7)   C3 07-07 = $(daycount "$C3T" 7)  (expect 1 each — B's independent materialization)"
    B2SPAWN=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$C2T' AND trashed=0 AND startDate=$(pk 7) LIMIT 1")
    B3SPAWN=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$C3T' AND trashed=0 AND startDate=$(pk 7) LIMIT 1")
    note "  B's C2 spawn uuid = $B2SPAWN"; saveto B2SPAWN "$B2SPAWN"
    note "  B's C3 spawn uuid = $B3SPAWN"; saveto B3SPAWN "$B3SPAWN"
    note "  B's C2 spawn row:"; gt "SELECT uuid, status, start, startDate, creationDate, userModificationDate FROM TMTask WHERE uuid='$B2SPAWN'" | sed 's/^/    /' | tee -a "$REPORT"
    note "  app alive: $(alive)  crashes: $(crashes)  cloud (must be unreachable): $(cloud_reach)"
    ;;

  p3)
    # ---- device A: the SPAWN-FIRST gestures, made while B holds its spawn ---
    boot "$VMA" "$PIN0"
    launch_things
    read_token
    note "cloud reachable: $(cloud_reach)"
    converge
    snap "p3-0-A-before" "SYNCX1-%"
    census "A before the p3 gestures (clock 07-05)"
    note ""; note "== CELL 2 — exception on SYNCX1-C2: projection 07-07 -> Jul 14 (a NON-slot day) =="
    gesture "SYNCX1-C2" "$C2T" "When…" "July 14" "July 14, 2026" "Make Exception" "p3-c2-chooser"
    C2EXC=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$C2T' AND trashed=0 AND startDate=$(pk 14) LIMIT 1")
    note "  C2 exception row on A = $C2EXC (dated 2026-07-14)"; saveto C2EXC "$C2EXC"
    note "  >>> IS IT THE SAME UUID B MINTED FOR THE SLOT? B's spawn was ${B2SPAWN:-?}"
    [ "$C2EXC" = "${B2SPAWN:-}" ] && note "  >>> SAME UUID — the slot-derived-uuid law holds across devices" || note "  >>> DIFFERENT UUIDS — the two rows are independent records"
    note ""; note "== CELL 3 — Update Rule on SYNCX1-C3: projection 07-07 -> Jul 12 (re-anchor) =="
    gesture "SYNCX1-C3" "$C3T" "When…" "July 12" "July 12, 2026" "Update Rule" "p3-c3-chooser"
    snap "p3-1-A-after" "SYNCX1-%"
    snapdiff "p3-0-A-before" "p3-1-A-after" "p3 — Make Exception (C2) + Update Rule (C3) on A"
    census "A after p3 (clock 07-05)"
    flush_sync
    snap "p3-2-A-pushed" "SYNCX1-%"
    note "  app alive: $(alive)  crashes: $(crashes)"
    ;;

  p4)
    # ---- device B reconnects: THE MERGE ------------------------------------
    boot "$VMB" "$PIN7"
    note "cloud reachable after the reboot's clean DHCP: $(cloud_reach)"
    launch_things
    read_token
    snap "p4-0-B-prejoin" "SYNCX1-%"
    converge
    snap "p4-1-B-merged" "SYNCX1-%"
    snapdiff "p4-0-B-prejoin" "p4-1-B-merged" "p4 — B rejoins the cloud (THE MERGE), clock 07-07"
    census "B after the merge (clock 07-07)"
    note ""; note "  ##### CELL 2 VERDICT INPUT (device B) #####"
    note "  rows on C2 dated 07-07 (B's rule date) = $(daycount "$C2T" 7)"
    note "  rows on C2 dated 07-14 (A's exception)  = $(daycount "$C2T" 14)"
    note "  C2 series row inventory:"; seriesrows "$C2T"
    note "  the contested uuid ${B2SPAWN:-?} on B now:"
    gt "SELECT uuid, status, start, startDate, creationDate, userModificationDate, trashed FROM TMTask WHERE uuid='${B2SPAWN:-x}'" | sed 's/^/    /' | tee -a "$REPORT"
    note ""; note "  ##### CELL 3 VERDICT INPUT (device B) #####"
    note "  rows on C3 dated 07-07 = $(daycount "$C3T" 7)   template: $(rsum "$C3T")"
    note "  C3 series row inventory:"; seriesrows "$C3T"
    note ""; note "  ##### CELL 1 re-check after the merge #####"
    note "  rows on C1 dated 07-07 = $(daycount "$C1T" 7)   dated 07-12 = $(daycount "$C1T" 12)"
    note "  app alive: $(alive)  crashes: $(crashes)"
    ;;

  p5)
    # ---- device A sees the merge -------------------------------------------
    boot "$VMA" "$PIN0"
    launch_things
    read_token
    snap "p5-0-A-prejoin" "SYNCX1-%"
    converge
    snap "p5-1-A-merged" "SYNCX1-%"
    snapdiff "p5-0-A-prejoin" "p5-1-A-merged" "p5 — A pulls the merge (clock still 07-05)"
    census "A after the merge (clock 07-05)"
    note ""; note "  ##### CELL 2 VERDICT INPUT (device A) #####"
    note "  rows on C2 dated 07-07 = $(daycount "$C2T" 7)   dated 07-14 = $(daycount "$C2T" 14)"
    note "  the contested uuid ${B2SPAWN:-?} on A now:"
    gt "SELECT uuid, status, start, startDate, creationDate, userModificationDate, trashed FROM TMTask WHERE uuid='${B2SPAWN:-x}'" | sed 's/^/    /' | tee -a "$REPORT"
    devcmp "p5-1-A-merged" "p4-1-B-merged"
    note ""; note "== now roll A onto 07-07 as well (its own spawner must not double-book) =="
    setclock "$PIN7"
    lab_ssh "$IP" 'sleep 20' </dev/null
    snap "p5-2-A-day07" "SYNCX1-%"
    snapdiff "p5-1-A-merged" "p5-2-A-day07" "p5 — A rolled to 2026-07-07 after the merge"
    census "A at 07-07"
    flush_sync
    snap "p5-3-A-pushed" "SYNCX1-%"
    note "  app alive: $(alive)  crashes: $(crashes)"
    ;;

  p6)
    # ---- device B at 07-09: cell 5 (the §17 live-slot arm) + integrity ------
    boot "$VMB" "$PIN7"
    launch_things
    read_token
    converge
    snap "p6-0-B-at07" "SYNCX1-%"
    note "== roll B to 2026-07-09 — C4's exception is parked on this LIVE slot =="
    setclock "$PIN9"
    lab_ssh "$IP" 'sleep 20' </dev/null
    snap "p6-1-B-day09" "SYNCX1-%"
    snapdiff "p6-0-B-at07" "p6-1-B-day09" "p6 — B at 2026-07-09"
    converge
    snap "p6-2-B-day09-converged" "SYNCX1-%"
    snapdiff "p6-1-B-day09" "p6-2-B-day09-converged" "p6 — B after two more sync rounds"
    census "B at 07-09"
    note "  ##### CELL 5 VERDICT INPUT (device B): rows on C4 dated 07-09 = $(daycount "$C4T" 9) (1 = reconciled, 2 = the §17 double-book, 3+ = worse across devices)"
    note "  app alive: $(alive)  crashes: $(crashes)"
    ;;

  p7)
    # ---- device A at 07-09: cell 5 + the final both-device byte compare -----
    boot "$VMA" "$PIN7"
    launch_things
    read_token
    converge
    snap "p7-0-A-at07" "SYNCX1-%"
    note "== roll A to 2026-07-09 =="
    setclock "$PIN9"
    lab_ssh "$IP" 'sleep 20' </dev/null
    snap "p7-1-A-day09" "SYNCX1-%"
    snapdiff "p7-0-A-at07" "p7-1-A-day09" "p7 — A at 2026-07-09"
    converge
    snap "p7-2-A-day09-converged" "SYNCX1-%"
    snapdiff "p7-1-A-day09" "p7-2-A-day09-converged" "p7 — A after two more sync rounds (ghost check)"
    census "A at 07-09"
    note "  ##### CELL 5 VERDICT INPUT (device A): rows on C4 dated 07-09 = $(daycount "$C4T" 9)"
    note "  ##### CELL 4 (integrity): a third relaunch must change nothing"
    relaunch; lab_ssh "$IP" 'sleep 15' </dev/null
    snap "p7-3-A-relaunch3" "SYNCX1-%"
    snapdiff "p7-2-A-day09-converged" "p7-3-A-relaunch3" "p7 — A third relaunch (must be inert)"
    note "  app alive: $(alive)  crashes: $(crashes)"
    ;;

  p8)
    # ---- device B, final integrity sweep + the cross-device byte compare ----
    boot "$VMB" "$PIN9"
    launch_things
    read_token
    converge
    snap "p8-0-B-final" "SYNCX1-%"
    relaunch; lab_ssh "$IP" 'sleep 15' </dev/null
    snap "p8-1-B-relaunch3" "SYNCX1-%"
    snapdiff "p8-0-B-final" "p8-1-B-relaunch3" "p8 — B third relaunch (must be inert)"
    census "B final (07-09)"
    devcmp "p7-3-A-relaunch3" "p8-1-B-relaunch3"
    note "  app alive: $(alive)  crashes: $(crashes)"
    ;;

  diag)
    vm_exists "$VMA" || { note "cloning $GOLDEN -> $VMA"; tart clone "$GOLDEN" "$VMA"; }
    boot "$VMA" "$PIN0"
    note "env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) ($(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)"
    note "cloud reachable: $(cloud_reach)"
    note "BSSyncronyMetadata rows (pre-account): $(gq 'SELECT COUNT(*) FROM BSSyncronyMetadata')"
    launch_things
    note "app alive: $(alive)"
    login_account A
    note "DIAG done — inspect $OUT/ax/*login-*.txt"
    ;;
  login)
    VM="${VMX:-$VMA}"; IP=$(tart ip "$VM" 2>/dev/null); install_helpers; KEEP=1
    note "attached to $VM at $IP (guest clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null))"
    login_account "${2:-A}"
    ;;
  axcmd)
    VM="${VMX:-$VMA}"; IP=$(tart ip "$VM" 2>/dev/null); install_helpers
    ax "${2:-dump}" "${3:-}" "${4:-}"
    KEEP=1
    ;;
  axdumpto)
    VM="${VMX:-$VMA}"; IP=$(tart ip "$VM" 2>/dev/null); install_helpers
    axdump "${2:-adhoc}"; KEEP=1
    ;;
  cmpsnap)   # cmpsnap <before> <after> [label] — offline snapshot diff, no VM
    VM=""; snapdiff "$2" "$3" "${4:-$2 -> $3}"
    ;;
  devcmp)    # devcmp <A-snap> <B-snap> — offline cross-device compare, no VM
    VM=""; devcmp "$2" "$3"
    ;;
  teardown)
    for v in "$VMA" "$VMB"; do tart stop "$v" >/dev/null 2>&1; tart delete "$v" >/dev/null 2>&1; done
    VM=""
    note "clones deleted; durable account KEPT ALIVE (no churn)"
    ;;
  *) note "phase '$PHASE' not implemented yet"; exit 1 ;;
esac
note "phase $PHASE complete — artifacts in $OUT"
