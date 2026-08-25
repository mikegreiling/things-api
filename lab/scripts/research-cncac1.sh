#!/bin/bash
# CNCAC1 — what does the GUI's checkbox do on an AFTER-COMPLETION series'
# projection row, and is there a headless equivalent?
#
# THE PROBLEM. #573 ships `todo complete|cancel <repeating>` as a composite over
# `Items ▸ Repeat ▸ Create Next Copy` (CNC1), and REFUSES an after-completion
# series outright on the strength of CNC1 §5 — which measured CNC on an
# after-completion template that had NEVER been completed (cursor NULL) and
# found it DUPLICATES the current occurrence (oddities §18). The refusal copy
# says the series "has no upcoming occurrence to work on until the current one
# is done".
#
# That is fail-closed GUESSWORK for the shape the maintainer actually owns: an
# after-completion series WITH a completed history. REPX1 §2.5 measured that
# completing an after-completion occurrence ANCHORS the series
# (rt1_afterCompletionReferenceDate := the completion day) and DERIVES a real
# cursor from it — so such a template carries a live rt1_nextInstanceStartDate,
# Upcoming renders a projection for it, and the GUI happily checks that
# projection off. The refusal fires on exactly the state whose text it
# misdescribes. This campaign replaces the guess with measurement.
#
# CELLS
#   DLC  DIALOG CENSUS: what does `Items ▸ Repeat…` offer when the frequency is
#        "after completion"? (Is a per-occurrence deadline even expressible?)
#   G    GUI CHECK-OFF (load-bearing). An after-completion series with a
#        materialized-completed history, so a projection exists. Check off the
#        projection row exactly as REPX1 did for fixed rules (Upcoming, CGEvent
#        click at the checkbox's own AX frame). Full byte-level delta. Does it
#        (a) JIT-mint a COMPLETED instance at the gesture wall-clock AND
#        re-anchor the next spawn to completion+interval; (b) relocate/complete
#        some existing row; (c) something else?
#   C    CNC + COMPLETE THE MINT. Identical fixture; drive CNC, then complete
#        the minted copy via the shipped URL-vector verb. Diff field by field
#        against G. Does a §18 twin appear at all when a cursor EXISTS, and if
#        one does, does completing the mint reconcile it?
#   X    the CANCEL sub-cell of C — CNC then `todo cancel` the mint.
#   UZ   UNDO/app-side: ⌘Z immediately after G's GUI check-off.
#   UT   UNDO/ours: `things undo` after C's composite.
#   N    NO-HISTORY ARM: an after-completion template that has NEVER spawned a
#        completion — cursor NULL, one live seed instance. Does Upcoming even
#        render a projection? What do G's and C's gestures do there?
#   E    the EMPTY corner: the same template with its live instance TRASHED —
#        no open occurrence AND no cursor. This is the only state the shipped
#        refusal copy actually describes; is it even reachable in normal use?
#   P    the PAUSED corner: pause clears the cursor, so a paused after-completion
#        series with a resolved occurrence has NEITHER a cursor NOR an occurrence.
#        What does CNC do there? (Also closes the standing "CNC on a PAUSED
#        template" cell.)
#   EXC  the EXCEPTION arm: CNC then RE-DATE the mint — `update --exception`'s
#        shape, which shares the one after-completion refusal with the status verbs.
#   N2   is oddities §18's duplicate dated TODAY or dated THE CURRENT OCCURRENCE?
#        CNC1 §5's fixture made the two coincide; re-dating the occurrence splits them.
#   DL2  the maintainer's actual shape: after-completion + a per-occurrence deadline.
#   CTRL the POSITIVE CONTROL for the click vector, on a fixed-rule projection.
#   WAIT the GUI counterpart of the cursor-less duplicate: Upcoming files a
#        cursor-less series under "Repeating To-Dos" and labels it "Waiting";
#        what does checking THAT row off do?
#   SH   the RE-ANCHOR discriminator: gesture on a day that is NOT the anchor, so
#        "re-anchors to the completion" and "never re-anchored" stop predicting
#        the same numbers. Runs the GUI arm and the composite arm in one roll.
#   ROLL PHASE 2: roll the clock to 2026-07-12 (every arm's derived cursor) and
#        watch each series continue — or not.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23 / dbv27; the
# golden is NEVER booted). Airgap, clock pinned 2026-07-05 (a Sunday). Every
# gesture happens at the pinned date in PHASE 1; PHASE 2 rolls forward once.
# Fixtures fully synthetic (CNCAC1-*), each title chosen so that no title is a
# PREFIX of another (clickrow matches an AXDescription by substring). DB oracle
# = FULL TMTask row snapshots (every column, packed dates decoded, blobs hashed)
# diffed either side of every gesture. Teardown on EXIT (KEEP=1 keeps it,
# REUSE=1 attaches to a live clone).
#
# THE TRIAL WALL: golden-v4's Things is a 15-day TRIAL build expiring 2026-07-18;
# past it the app goes read-only STICKILY and the clone is burned (REPX3 §5).
# setclock refuses any roll to 2026-07-18 or later. Every after-completion
# cadence here is the dialog's own default (1 week), so completion on 07-05
# derives a 07-12 cursor — comfortably inside the wall.
#
# Usage:  CELLS="G C" VM=cncac1-lab KEEP=1 lab/scripts/research-cncac1.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-cncac1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/ax" "$OUT/snap" "$OUT/log"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-CTRL DLC G C X UZ UT N E P EXC N2 DL2 WAIT SH ROLL}"
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[cncac1] $*" | tee -a "$REPORT"; }
has_cell() { case " $CELLS " in *" $1 "*) return 0;; *) return 1;; esac; }

PASS=0; FAIL=0
cell() { note ""; note "========== $1 =========="; }
verdict() { # verdict <name> <expected-substring> <actual>
  if echo "$3" | grep -qF -- "$2"; then note "  PASS $1"; PASS=$((PASS+1));
  else note "  FAIL $1 — expected to contain '$2', got: $3"; FAIL=$((FAIL+1)); fi
}
verdict_not() { # verdict_not <name> <forbidden-substring> <actual>
  if echo "$3" | grep -qF -- "$2"; then note "  FAIL $1 — must NOT contain '$2', got: $3"; FAIL=$((FAIL+1));
  else note "  PASS $1"; PASS=$((PASS+1)); fi
}
verdict_eq() { # verdict_eq <name> <expected> <actual> — EXACT, for row counts
  if [ "$(echo "$3" | tr -d '[:space:]')" = "$2" ]; then note "  PASS $1 (= $2)"; PASS=$((PASS+1));
  else note "  FAIL $1 — expected exactly '$2', got: '$3'"; FAIL=$((FAIL+1)); fi
}

# ---------------------------------------------------------------- clone + boot
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
  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }
  [ -d node_modules/commander ] || { note "FATAL: node_modules/commander missing — run npm ci"; exit 1; }

  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (a Sunday)"
  BOOTSTRAP=1
else
  BOOTSTRAP=0
fi

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM running at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done: $(tart list 2>/dev/null | grep -c "$VM" || true) row(s) named $VM remain"
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

# rule summary — the RDLG2 / REPX1 / REPX3 / CNC1 helper, with the
# after-completion ANCHOR (rt1_afterCompletionReferenceDate) DECODED, because
# this campaign is about that column.
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, startDate, rt1_instanceCreationPaused, rt1_afterCompletionReferenceDate, reminderTime FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
tail="next=%s icStart=%s icCount=%s paused=%s tmplDeadline=%s acRef=%s rem=%s"%(
    dpk(row[1]),dpk(row[2]),row[3],row[6],dpk(row[4]),dpk(row[7]),row[8])
if row[0] is None:
    print("NO-RULE startDate=%s %s"%(dpk(row[5]),tail)); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    bits=[]
    if 'wd' in o: bits.append("wd=%s(%s)"%(o['wd'], WD[o['wd']] if 0<=o['wd']<7 else "?"))
    for k in ('dy','mo','wdo'):
        if k in o: bits.append("%s=%s"%(k,o[k]))
    offs.append("{"+",".join(bits)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] %s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),tail))
EOF
rsum() {
  [ -n "${1:-}" ] || { echo "NO-UUID"; return; }
  lab_ssh "$IP" "python3 ~/labh/rsum.py $1" </dev/null 2>&1
}

# FULL-ROW snapshot: every TMTask column for the rows matching a title LIKE.
lab_ssh "$IP" 'cat > ~/labh/rowsnap.py' <<'EOF'
import sys, sqlite3, glob, hashlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True); c.row_factory=sqlite3.Row
DATECOLS={'startDate','deadline','stopDate','rt1_nextInstanceStartDate','rt1_instanceCreationStartDate','todayIndexReferenceDate','rt1_afterCompletionReferenceDate'}
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
crashes() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3-*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
relaunch() { lab_ssh "$IP" 'open -a Things3; sleep 22; true' </dev/null; }
quitapp() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 4; true' </dev/null; }

# THE TRIAL WALL (REPX3 §5) — golden-v4's Things expires 2026-07-18, stickily.
TRIAL_WALL="20260718"
setclock() { # setclock MMDDhhmmYYYY  (quits the app first, relaunches after)
  local d="$1" ymd="${1:8:4}${1:0:2}${1:2:2}"
  if [ "$ymd" -ge "$TRIAL_WALL" ]; then
    note "    REFUSED clock roll to $ymd — golden-v4's trial wall is $TRIAL_WALL (REPX3 §5)"
    return 1
  fi
  quitapp
  lab_ssh "$IP" "sudo date $d >/dev/null; date" </dev/null | sed 's/^/    clock now: /' | tee -a "$REPORT"
  relaunch
}

# ---- the AX sheet/menu dumps (CNC1) ----------------------------------------
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
    var w=ws[i], f=frame(w), sub=sv(w,'AXSubrole')
    if(sub!=='AXStandardWindow' && !(f.w===40&&f.h===40)){acc.push('=== DETACHED WINDOW '+(i+1)+' sub='+sub+' ttl='+sv(w,'AXTitle')+' @['+f.x+','+f.y+' '+f.w+'x'+f.h+'] ==='); walk(w,0,acc,i+1)}
    var ch=kids(w)
    for(var j=0;j<ch.length;j++){var r=sv(ch[j],'AXRole'); if(r==='AXSheet'||r==='AXPopover'){acc.push('=== '+r+' (child '+(j+1)+' of window '+(i+1)+') ==='); walk(ch[j],0,acc,j+1)}}
  }
  if(!acc.length) acc.push('(no sheet / popover / detached dialog present)')
  return acc.join('\n')}
EOF
sheetdump() { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; note "  [ax $1: $(head -1 "$OUT/ax/$1.txt")]"; }

# ---- the main-window content walk + the LIVE click vector (REPX1 §1.2) ------
# AXPress on Things' custom-drawn content rows is DECORATIVE (AXError=0, zero
# delta, on projections AND ordinary rows alike). A synthesized CGEvent click at
# the element's own AX frame is what actuates it, and it works headlessly under
# the AXVM1 grant. Both helpers are lifted verbatim from research-repx1.sh.
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
windump() { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/rowcensus.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; note "  [windump $1: $(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines]"; }

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
// THE VIEWPORT GUARD (CNCAC1 pass 1, the hard way). A row scrolled OUT of the
// list still resolves a perfectly good AX frame, so a blind CGEventPost at that
// frame lands on the DESKTOP and the gesture reads as "the app did nothing" —
// a false negative indistinguishable from an app finding. Walk up to the row's
// own AXScrollArea and refuse rather than click outside it.
function ancestorScrollFrame(el){
  var cur=el
  for(var d=0; d<20; d++){
    var p=attr(cur,'AXParent'); if(!p) return null
    if(sv(p,'AXRole')==='AXScrollArea') return frame(p)
    cur=p
  }
  return null
}
function run(argv){
  // argv: <needle> <target: an AXDescription, or "TITLE"> [<modifier: "shift">]
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
    var vw=ancestorScrollFrame(rows[i])
    if(vw && vw.x!==null && (y<vw.y || y>vw.y+vw.h || x<vw.x || x>vw.x+vw.w))
      return 'OFF-SCREEN: '+want+' of the '+needle+' row resolves at ('+x+','+y+
             ') but its visible list is ['+vw.x+','+vw.y+' '+vw.w+'x'+vw.h+
             '] — reveal the row first (things:///show?id=…); NOTHING was clicked'
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

# revealclick <uuid> <needle> [target] — the SAFE click primitive.
#
# `things:///show?id=` both SELECTS the row and SCROLLS it into view, which is
# the whole point: pass 1 of this campaign clicked a projection whose AX frame
# resolved 145pt BELOW the list's visible rect, so the CGEvent went to the
# desktop and the cell reported a confident zero delta. Reveal first, click
# second, and treat an OFF-SCREEN verdict as a hard rig failure rather than a
# result.
revealclick() {
  local uuid="$1" needle="$2" want="${3:-Checkbox}" out
  lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 4" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  out=$(clickrow "$needle" "$want")
  case "$out" in
    OFF-SCREEN*|"no AXTableRow"*|"row found"*)
      note "    RIG: $out"; note "    retrying after a page scroll…"
      axq 'tell application "System Events" to tell process "Things3" to key code 121' >/dev/null
      lab_ssh "$IP" 'sleep 2' </dev/null
      out=$(clickrow "$needle" "$want") ;;
  esac
  note "    $out"
  case "$out" in
    CLICKED*) return 0 ;;
    *) note "    *** NOTHING WAS CLICKED — this cell's delta is a RIG artifact, not a finding ***"; return 1 ;;
  esac
}

# ---- ship the production bundle -------------------------------------------
if [ "$BOOTSTRAP" = "1" ]; then
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
fi
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G()  { lab_ssh "$IP" "$CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
GU() { lab_ssh "$IP" "$LAB_UI_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
CLIV=$(lab_ssh "$IP" "$CLI --version 2>&1 | tail -1" </dev/null)
case "$CLIV" in
  [0-9]*) note "guest CLI OK: things $CLIV" ;;
  *) note "FATAL: the guest CLI does not run — $CLIV"; exit 1 ;;
esac
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "shipped dist; ui-enabled=true"

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" | grep -o '<integer>[0-9]*' | grep -o '[0-9]*')
note "env: Things $TVER ($TBLD) / dbv $DBV / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"
note "crash reports at start: $(crashes)"

# ---------------------------------------------------------------- primitives
mktodo() {  # mktodo <title> [extra query] -> uuid
  lab_ssh "$IP" "open -g 'things:///add?title=$1${2:-}&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1"
}
tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1"; }
newest_instance() { gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
open_instance()   { gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 AND status=0 ORDER BY startDate, creationDate LIMIT 1"; }
open_count()      { gq "SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 AND status=0"; }
live_count()      { gq "SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0"; }
# rowson <templateUuid> <YYYY-MM-DD> — UNTRASHED series rows dated that day.
rowson() {
  local y=$((10#${2:0:4})) m=$((10#${2:5:2})) d=$((10#${2:8:2}))
  gq "SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 \
AND (startDate>>16)=$y AND ((startDate>>12)&15)=$m AND ((startDate>>7)&31)=$d"
}
serieslist() {
  gt "SELECT substr(uuid,1,8) uuid, status, trashed, startDate, deadline, stopDate, creationDate FROM TMTask WHERE rt1_repeatingTemplate='$1' ORDER BY creationDate"
}

selectrow() { # selectrow <uuid> -> echoes the verified selection
  lab_ssh "$IP" "open -g 'things:///show?id=$1'; sleep 3" </dev/null
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  axq 'tell application "Things3" to return id of selected to dos'
}
repeatmenu() {
  axq 'tell application "System Events" to tell process "Things3" to return name of every menu item of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1'
}
cnc() { # cnc <templateUuid> — THE HEADLESS GESTURE UNDER TEST
  if [ -z "${1:-}" ]; then note "    SKIPPED — no template uuid (rig failure upstream)"; return 1; fi
  local sel; sel=$(selectrow "$1")
  note "    selection = $sel  (want $1)"
  case "$sel" in *"$1"*) : ;; *) note "    WARN: selection did not verify"; ;; esac
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Create Next Copy" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    cnc: /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 6' </dev/null
}
upcoming() { # show Upcoming and bring the app forward
  lab_ssh "$IP" "open -g 'things:///show?id=upcoming'; sleep 4" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
}
cmdz() { # the APP's own undo
  axq 'tell application "System Events" to tell process "Things3" to keystroke "z" using command down' | sed 's/^/    cmdz: /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 8' </dev/null
}

select_item() { # reveal + activate + verify the selection BY UUID (REPX3)
  local uuid="$1" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get id of selected to dos' 2>/dev/null)
    [ "$sel" = "$uuid" ] && { echo "$sel"; return 0; }
  done
  echo "$sel"; return 1
}

# ------------------------------------------------------------- fixture builder
#
# Fixtures are NOT built with `things todo make-repeating`: the Wave A write gate
# refuses the AppleScript vector whenever the process has no bundle id, which is
# every sshd-descended guest shell (CNC1 §9.2). So a URL-scheme add plus a direct
# AX drive of the Repeat dialog — the REPX2/REPX3/CNC1 way.
mkrepeat() {
  local uuid="$1" freq="$2" iv="${3:-1}" extras="${4:-}"
  select_item "$uuid" >/dev/null || note "    WARN: selection never confirmed for $uuid"
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
    return \"frequency -> '\" & hit & \"'\"
  end tell" | sed 's/^/    /' | tee -a "$REPORT"
  if [ "$iv" != "1" ]; then
    axq "tell application \"System Events\" to tell process \"Things3\"
      set sh to sheet 1 of (first window whose subrole is \"AXStandardWindow\")
      set f to text field 1 of group 1 of sh
      set focused of f to true
      delay 0.3
      keystroke \"a\" using command down
      delay 0.2
      keystroke \"$iv\"
      delay 0.3
      key code 48
      delay 0.5
      return \"interval read back = \" & (value of f as text)
    end tell" | sed 's/^/    /' | tee -a "$REPORT"
  fi
  case " $extras " in
    *" census "*)
      note "    -- DIALOG CENSUS under frequency '$freq' --"
      axq 'tell application "System Events" to tell process "Things3"
        set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
        return "checkboxes: " & (name of every checkbox of sh as text) & " || popups: " & (count of pop up buttons of sh) & " || textfields(sheet): " & (count of text fields of sh) & " || groups: " & (count of groups of sh)
      end tell' | sed 's/^/      /' | tee -a "$REPORT"
      sheetdump "repeat-dialog-$(echo "$freq" | tr -cd '[:alnum:]')" ;;
  esac
  case " $extras " in
    *" deadline:"*)
      local dn="${extras##*deadline:}"; dn="${dn%% *}"
      axq 'tell application "System Events" to tell process "Things3"
        set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
        repeat with cb in (checkboxes of sh)
          if (name of cb as text) contains "eadline" then
            click cb
            delay 1
            return "ticked " & (name of cb as text)
          end if
        end repeat
        return "NO-DEADLINE-CHECKBOX: " & (name of every checkbox of sh as text)
      end tell' | sed 's/^/    /' | tee -a "$REPORT"
      axq "tell application \"System Events\" to tell process \"Things3\"
        set sh to sheet 1 of (first window whose subrole is \"AXStandardWindow\")
        try
          set f to text field 1 of sh
          set focused of f to true
          delay 0.3
          keystroke \"a\" using command down
          delay 0.2
          keystroke \"$dn\"
          delay 0.3
          key code 48
          delay 0.5
          return \"start-days-earlier read back = \" & (value of f as text)
        on error e
          return \"NO start-days-earlier field: \" & e
        end try
      end tell" | sed 's/^/    /' | tee -a "$REPORT" ;;
  esac
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    click button "OK" of sh
    delay 2
    return "pressed OK"
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 7' </dev/null
}

# mkseries <TITLE> <when> <frequency> [interval] [extras] -> templateUuid
mkseries() {
  local title="$1" when="$2" freq="$3" iv="${4:-1}" extras="${5:-}"
  local u; u=$(mktodo "$title" "&when=$when")
  note "  seed $title = $u" >&2
  mkrepeat "$u" "$freq" "$iv" "$extras" >&2
  local t; t=$(tmpl "$title")
  [ -n "$t" ] || note "  RIG FAILURE: no template minted for $title" >&2
  echo "$t"
}
need() { [ -n "${1:-}" ] && return 0; note "FATAL: the $2 fixture did not mint — aborting"; exit 1; }

# THE FIXTURE THIS CAMPAIGN IS ABOUT: an after-completion series with a
# MATERIALIZED-COMPLETED history, so the template carries a real cursor and
# Upcoming has a projection to render. Mirrors the maintainer's live shape.
#   mkac <TITLE> [extras] -> templateUuid  (and completes the seed occurrence)
mkac() {
  local title="$1" extras="${2:-}"
  local t; t=$(mkseries "$title" 2026-07-05 "after completion" 1 "$extras")
  # A `need` here would `exit` only this command substitution's subshell, so the
  # guard is a bare return and the CALLER's `need` is what aborts the run.
  [ -n "$t" ] || { note "  RIG FAILURE: $title has no template" >&2; echo ""; return 1; }
  local inst; inst=$(open_instance "$t")
  note "  $title template=$t  seed occurrence=$inst" >&2
  [ -n "$inst" ] || { note "  RIG FAILURE: $title minted no seed occurrence" >&2; echo ""; return 1; }
  note "  $title at birth: $(rsum "$t")" >&2
  # Complete the seed occurrence through the shipped URL-vector verb (tier 0).
  # REPX1 §2.5: this ANCHORS the series and DERIVES the cursor from the anchor.
  local o; o=$(G todo complete "$inst" --json)
  echo "$o" > "$OUT/log/$title-seed-complete.log"
  note "  $title seed completed: $(echo "$o" | tail -1)" >&2
  note "  $title with history: $(rsum "$t")" >&2
  echo "$t"
}

[ "$BOOTSTRAP" = "1" ] && warm

# ================================================ CTRL — is the click vector LIVE?
# Pass 1 of cell G reported a confident zero delta from a click that never landed
# (the row's AX frame resolved below the list's visible rect). A zero delta is
# worthless without a positive control, so this cell proves the vector actuates a
# projection checkbox IN THIS CLONE, IN THIS WINDOW, before G is believed. Fixed
# DAILY rule, so REPX1 §1.3 is the expectation: a JIT mint born COMPLETE.
if has_cell CTRL; then
  cell "CTRL — the click vector, proven live on a FIXED-rule projection (REPX1 §1.3)"
  TK=$(mkseries CNCAC1-CONTROL 2026-07-05 daily)
  need "$TK" CTRL
  RK=$(rsum "$TK"); note "  rule: $RK"
  warm
  upcoming
  snap ctrl-0 'CNCAC1-CONTROL'
  note "  -- reveal, then click the 07-06 projection's checkbox --"
  revealclick "$TK" "CNCAC1-CONTROL" "Checkbox"
  lab_ssh "$IP" 'sleep 10' </dev/null
  snap ctrl-1 'CNCAC1-CONTROL'; snapdiff ctrl-0 ctrl-1 "CTRL — click a FIXED-rule projection checkbox"
  RK=$(rsum "$TK"); note "  rule after: $RK"
  verdict "CTRL the click MINTED an occurrence (icCount 1 -> 2)" "icCount=2" "$RK"
  verdict "CTRL the cursor advanced one day" "next=2026-07-07" "$RK"
  note "  series:"; serieslist "$TK" | sed 's/^/    /' | tee -a "$REPORT"
fi

# ============================================================ DLC — the dialog
if has_cell DLC; then
  cell "DLC — what does Items ▸ Repeat… offer under 'after completion'?"
  note "  (is a per-occurrence deadline expressible on an after-completion rule at all?)"
  UD=$(mktodo CNCAC1-DIALOG "&when=2026-07-05")
  note "  seed=$UD"
  mkrepeat "$UD" "after completion" 1 "census deadline:3"
  TD=$(tmpl CNCAC1-DIALOG)
  note "  template=$TD"
  note "  rule: $(rsum "$TD")"
  note "  series rows:"; serieslist "$TD" | sed 's/^/    /' | tee -a "$REPORT"
fi

# ====================================================== G — THE GUI CHECK-OFF
if has_cell G; then
  cell "G — GUI CHECK-OFF of an after-completion series' PROJECTION row"
  CR0=$(crashes)
  TG=$(mkac CNCAC1-GUI)
  need "$TG" G
  RG=$(rsum "$TG"); note "  fixture state: $RG"
  verdict "G the completed history gave the series a real cursor" "next=2026-07-12" "$RG"
  verdict "G the completion anchored the series to the completion day" "acRef=2026-07-05" "$RG"
  verdict_eq "G there is NO open occurrence (the #573 refusal's trigger)" "0" "$(open_count "$TG")"

  warm
  upcoming
  windump g-upcoming-before
  note "  Upcoming rows naming the series (is there a PROJECTION at all?):"
  grep -n "CNCAC1-GUI" "$OUT/ax/g-upcoming-before.txt" | sed 's/^/    /' | tee -a "$REPORT"
  note "  AppleScript's view of Upcoming:"
  axq 'tell application "Things3" to get name of to dos of list "Upcoming"' | sed 's/^/    /' | tee -a "$REPORT"

  snap g-0 'CNCAC1-GUI'
  note "  -- THE GESTURE: reveal, then CGEvent click on the projection's checkbox --"
  revealclick "$TG" "CNCAC1-GUI" "Checkbox"
  lab_ssh "$IP" 'sleep 10' </dev/null
  snap g-1 'CNCAC1-GUI'; snapdiff g-0 g-1 "G — GUI check-off of the after-completion projection"
  note "  rule after: $(rsum "$TG")"
  note "  series:"; serieslist "$TG" | sed 's/^/    /' | tee -a "$REPORT"
  note "  app: $(alive); crash reports $CR0 -> $(crashes)"
  sheetdump g-after-click

  note "  -- durability: +25s settle, then a relaunch --"
  lab_ssh "$IP" 'sleep 25' </dev/null
  snap g-2 'CNCAC1-GUI'; snapdiff g-1 g-2 "G — +25s settle"
  quitapp; relaunch
  snap g-3 'CNCAC1-GUI'; snapdiff g-2 g-3 "G — across a relaunch"
  note "  rule after relaunch: $(rsum "$TG")"
  note "  open occurrences now: $(open_count "$TG")   live rows: $(live_count "$TG")"
  upcoming
  windump g-upcoming-after
  note "  Upcoming rows naming the series AFTER the gesture:"
  grep -n "CNCAC1-GUI" "$OUT/ax/g-upcoming-after.txt" | sed 's/^/    /' | tee -a "$REPORT"
fi

# =============================================== C — the HEADLESS EQUIVALENT
if has_cell C; then
  cell "C — CNC then COMPLETE the mint, on an IDENTICAL fixture"
  CR0=$(crashes)
  TC=$(mkac CNCAC1-CNC)
  need "$TC" C
  RC=$(rsum "$TC"); note "  fixture state: $RC"
  verdict "C the fixture matches G's (cursor 07-12)" "next=2026-07-12" "$RC"
  snap c-0 'CNCAC1-CNC'
  note "  Items ▸ Repeat submenu on an after-completion template WITH a cursor:"
  SEL=$(selectrow "$TC"); note "    selection=$SEL (want $TC)"
  note "    $(repeatmenu)"
  note "  -- gesture 1: Items ▸ Repeat ▸ Create Next Copy --"
  cnc "$TC"
  sheetdump c-after-cnc
  snap c-1 'CNCAC1-CNC'; snapdiff c-0 c-1 "C — Create Next Copy (cursor EXISTS, unlike CNC1 §5)"
  note "  rule after CNC: $(rsum "$TC")"
  MC=$(newest_instance "$TC"); note "  minted instance = $MC"
  note "  THE §18 TWIN CHECK — open occurrences after the mint: $(open_count "$TC") (a twin would be 2)"
  note "  rows dated 07-12: $(rowson "$TC" 2026-07-12)   rows dated 07-05: $(rowson "$TC" 2026-07-05)"
  note "  series:"; serieslist "$TC" | sed 's/^/    /' | tee -a "$REPORT"

  note "  -- gesture 2: complete the minted copy (URL vector, tier 0) --"
  O=$(G todo complete "$MC" --json); echo "$O" > "$OUT/log/c-complete.log"
  note "  $(echo "$O" | tail -3)"
  snap c-2 'CNCAC1-CNC'; snapdiff c-1 c-2 "C — complete the minted copy"
  note "  rule after: $(rsum "$TC")"
  note "  open occurrences after completing the mint: $(open_count "$TC")   live rows: $(live_count "$TC")"
  note "  series:"; serieslist "$TC" | sed 's/^/    /' | tee -a "$REPORT"

  note "  -- durability --"
  quitapp; relaunch
  snap c-3 'CNCAC1-CNC'; snapdiff c-2 c-3 "C — across a relaunch"
  note "  rule after relaunch: $(rsum "$TC")"
fi

# ================================================= X — the CANCEL sub-cell of C
if has_cell X; then
  cell "X — CNC then CANCEL the mint (the cancel variant of the composite)"
  TX=$(mkac CNCAC1-CANX)
  need "$TX" X
  note "  fixture state: $(rsum "$TX")"
  snap x-0 'CNCAC1-CANX'
  cnc "$TX"
  snap x-1 'CNCAC1-CANX'; snapdiff x-0 x-1 "X — Create Next Copy"
  MX=$(newest_instance "$TX"); note "  minted instance = $MX; rule: $(rsum "$TX")"
  O=$(G todo cancel "$MX" --json); echo "$O" > "$OUT/log/x-cancel.log"
  note "  $(echo "$O" | tail -3)"
  snap x-2 'CNCAC1-CANX'; snapdiff x-1 x-2 "X — cancel the minted copy"
  note "  rule after: $(rsum "$TX")"
  note "  open occurrences: $(open_count "$TX")"
  note "  series:"; serieslist "$TX" | sed 's/^/    /' | tee -a "$REPORT"
fi

# ============================================== UZ — the APP's own undo (⌘Z)
if has_cell UZ; then
  cell "UZ — ⌘Z immediately after the GUI check-off"
  TU=$(mkac CNCAC1-UNDOZ)
  need "$TU" UZ
  note "  fixture state: $(rsum "$TU")"
  warm
  upcoming
  snap uz-0 'CNCAC1-UNDOZ'
  revealclick "$TU" "CNCAC1-UNDOZ" "Checkbox"
  lab_ssh "$IP" 'sleep 10' </dev/null
  snap uz-1 'CNCAC1-UNDOZ'; snapdiff uz-0 uz-1 "UZ — the GUI check-off"
  note "  rule after the gesture: $(rsum "$TU")"
  note "  -- ⌘Z --"
  cmdz
  snap uz-2 'CNCAC1-UNDOZ'; snapdiff uz-1 uz-2 "UZ — after ⌘Z"
  snapdiff uz-0 uz-2 "UZ — NET of ⌘Z against the PRE-GESTURE state"
  note "  rule after undo: $(rsum "$TU")"
  note "  open occurrences: $(open_count "$TU")  live rows: $(live_count "$TU")"
fi

# ============================================== UT — `things undo` after C
if has_cell UT; then
  cell "UT — \`things undo\` after the CNC+complete composite"
  TT=$(mkac CNCAC1-UNDOT)
  need "$TT" UT
  note "  fixture state: $(rsum "$TT")"
  snap ut-0 'CNCAC1-UNDOT'
  cnc "$TT"
  snap ut-1 'CNCAC1-UNDOT'; snapdiff ut-0 ut-1 "UT — Create Next Copy"
  MT=$(newest_instance "$TT"); note "  minted instance = $MT"
  O=$(G todo complete "$MT" --json); echo "$O" > "$OUT/log/ut-complete.log"
  note "  $(echo "$O" | tail -2)"
  snap ut-2 'CNCAC1-UNDOT'; snapdiff ut-1 ut-2 "UT — complete the mint"
  note "  rule: $(rsum "$TT")"
  note "  -- things undo --"
  O=$(G undo --json); echo "$O" > "$OUT/log/ut-undo.log"
  note "  $(echo "$O" | tail -6)"
  snap ut-3 'CNCAC1-UNDOT'; snapdiff ut-2 ut-3 "UT — after \`things undo\`"
  snapdiff ut-1 ut-3 "UT — NET of the undo vs the POST-CNC state"
  snapdiff ut-0 ut-3 "UT — NET of the undo vs the PRE-GESTURE state"
  note "  rule after undo: $(rsum "$TT")"
  note "  open occurrences: $(open_count "$TT")  live rows: $(live_count "$TT")"
fi

# ====================================== N — the NO-HISTORY arm (cursor NULL)
if has_cell N; then
  cell "N — an after-completion template that has NEVER been completed"
  CR0=$(crashes)
  TN=$(mkseries CNCAC1-FRESH 2026-07-05 "after completion" 1)
  need "$TN" N
  RN=$(rsum "$TN"); note "  rule: $RN"
  verdict "N a never-completed after-completion template has NO cursor" "next=None" "$RN"
  note "  open occurrences: $(open_count "$TN")  live rows: $(live_count "$TN")"
  warm
  upcoming
  windump n-upcoming
  note "  Upcoming rows naming the series (expect NONE — there is no cursor):"
  grep -n "CNCAC1-FRESH" "$OUT/ax/n-upcoming.txt" | sed 's/^/    /' | tee -a "$REPORT" || note "    (none)"
  note "  AppleScript's view of Upcoming:"
  axq 'tell application "Things3" to get name of to dos of list "Upcoming"' | sed 's/^/    /' | tee -a "$REPORT"
  note "  Today rows naming the series (the LIVE occurrence, checkable as any row):"
  lab_ssh "$IP" "open -g 'things:///show?id=today'; sleep 4" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  windump n-today
  grep -n "CNCAC1-FRESH" "$OUT/ax/n-today.txt" | sed 's/^/    /' | tee -a "$REPORT" || note "    (none)"

  snap n-0 'CNCAC1-FRESH'
  note "  -- CNC here (CNC1 §5's cell, re-run as the control for cell C) --"
  cnc "$TN"
  snap n-1 'CNCAC1-FRESH'; snapdiff n-0 n-1 "N — Create Next Copy with NO cursor (CNC1 §5)"
  note "  rule after: $(rsum "$TN")"
  note "  open occurrences after CNC: $(open_count "$TN") (CNC1 §18: expect a TWIN, i.e. 2)"
  note "  rows dated 07-05: $(rowson "$TN" 2026-07-05)"
  note "  series:"; serieslist "$TN" | sed 's/^/    /' | tee -a "$REPORT"
  note "  app: $(alive); crash reports $CR0 -> $(crashes)"
fi

# ======================================== E — the EMPTY corner (no cursor, no row)
if has_cell E; then
  cell "E — the corner the shipped refusal copy describes: no cursor AND no occurrence"
  TE=$(mkseries CNCAC1-EMPTY 2026-07-05 "after completion" 1)
  need "$TE" E
  note "  rule: $(rsum "$TE")"
  IE=$(open_instance "$TE"); note "  live occurrence = $IE"
  snap e-0 'CNCAC1-EMPTY'
  # `todo delete` is an AppleScript-vector verb and is gated in a guest (CNC1
  # §9.2), so the occurrence is trashed through the GUI: select it, ⌘⌫.
  note "  -- trash the live occurrence via the GUI (⌘⌫) --"
  select_item "$IE" >/dev/null
  axq 'tell application "System Events" to tell process "Things3" to key code 51 using command down' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 6' </dev/null
  snap e-1 'CNCAC1-EMPTY'; snapdiff e-0 e-1 "E — trash the only occurrence"
  RE=$(rsum "$TE"); note "  rule: $RE"
  note "  open occurrences: $(open_count "$TE")  live rows: $(live_count "$TE")"
  warm
  upcoming
  windump e-upcoming
  note "  Upcoming rows naming the series:"
  grep -n "CNCAC1-EMPTY" "$OUT/ax/e-upcoming.txt" | sed 's/^/    /' | tee -a "$REPORT" || note "    (none)"
  note "  is the series reachable in the GUI at all? Today:"
  lab_ssh "$IP" "open -g 'things:///show?id=today'; sleep 4" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  windump e-today
  grep -n "CNCAC1-EMPTY" "$OUT/ax/e-today.txt" | sed 's/^/    /' | tee -a "$REPORT" || note "    (none)"
fi

# ================================= P — the PAUSED corner (no cursor, no occurrence)
# Cell E measured that TRASHING the live occurrence ANCHORS the series, so
# "after-completion with no cursor AND no open occurrence" is not reachable that
# way. PAUSE is the route that reaches it: pause clears rt1_nextInstanceStartDate
# (REPX1 §5.3), so a paused series whose occurrence is already resolved has
# neither. This is the state a shipped guard must actually refuse — and it also
# closes the "CNC on a PAUSED template" cell up-next has been carrying.
if has_cell P; then
  cell "P — CNC on a PAUSED after-completion series (no cursor, no occurrence)"
  TP=$(mkac CNCAC1-PAUSED)
  need "$TP" P
  note "  fixture state: $(rsum "$TP")"
  snap p-0 'CNCAC1-PAUSED'
  O=$(GU todo pause-repeat "$TP" --dangerously-drive-gui --json)
  echo "$O" > "$OUT/log/p-pause.log"; note "  pause: $(echo "$O" | tail -1)"
  RP=$(rsum "$TP"); note "  rule after pause: $RP"
  verdict "P pausing CLEARS the cursor" "next=None" "$RP"
  verdict_eq "P and there is no open occurrence" "0" "$(open_count "$TP")"
  note "  Items ▸ Repeat submenu while PAUSED:"
  SEL=$(selectrow "$TP"); note "    selection=$SEL"
  note "    $(repeatmenu)"
  snap p-1 'CNCAC1-PAUSED'; snapdiff p-0 p-1 "P — pause"
  note "  -- CNC on the paused, cursor-less series --"
  cnc "$TP"
  sheetdump p-after-cnc
  snap p-2 'CNCAC1-PAUSED'; snapdiff p-1 p-2 "P — Create Next Copy while paused"
  note "  rule after: $(rsum "$TP")"
  note "  open occurrences: $(open_count "$TP")  live rows: $(live_count "$TP")"
  note "  series:"; serieslist "$TP" | sed 's/^/    /' | tee -a "$REPORT"
  note "  app: $(alive); crash reports: $(crashes)"
fi

# ===================================== EXC — the EXCEPTION arm of the composite
# `update --exception` is the composite's other consumer, and it shares the one
# after-completion refusal constant with the status verbs. Measure it rather than
# lift half a guard: CNC, then an ordinary re-date of the row it mints.
if has_cell EXC; then
  cell "EXC — CNC then RE-DATE the mint (the \`update --exception\` shape)"
  TX2=$(mkac CNCAC1-EXCEPT)
  need "$TX2" EXC
  note "  fixture state: $(rsum "$TX2")"
  snap exc-0 'CNCAC1-EXCEPT'
  cnc "$TX2"
  snap exc-1 'CNCAC1-EXCEPT'; snapdiff exc-0 exc-1 "EXC — Create Next Copy"
  MX2=$(newest_instance "$TX2"); note "  minted instance = $MX2; rule: $(rsum "$TX2")"
  O=$(G todo update "$MX2" --when 2026-07-09 --json); echo "$O" > "$OUT/log/exc-redate.log"
  note "  $(echo "$O" | tail -2)"
  snap exc-2 'CNCAC1-EXCEPT'; snapdiff exc-1 exc-2 "EXC — re-date the mint to 2026-07-09"
  note "  rule after: $(rsum "$TX2")"
  note "  open occurrences: $(open_count "$TX2")  rows dated 07-09: $(rowson "$TX2" 2026-07-09)"
  note "  series:"; serieslist "$TX2" | sed 's/^/    /' | tee -a "$REPORT"
fi

# ============== N2 — is §18's duplicate dated TODAY, or dated THE OCCURRENCE?
# CNC1 §5 could not separate the two (its live occurrence sat on the pinned
# today). Re-date the occurrence OFF today first and the two hypotheses split.
if has_cell N2; then
  cell "N2 — §18's duplicate: dated TODAY or dated the CURRENT OCCURRENCE?"
  TN2=$(mkseries CNCAC1-OFFDAY 2026-07-05 "after completion" 1)
  need "$TN2" N2
  IN2=$(open_instance "$TN2"); note "  live occurrence = $IN2; rule: $(rsum "$TN2")"
  O=$(G todo update "$IN2" --when 2026-07-09 --json); echo "$O" > "$OUT/log/n2-redate.log"
  note "  re-dated the occurrence off today: $(echo "$O" | tail -1)"
  snap n2-0 'CNCAC1-OFFDAY'
  note "  series before CNC:"; serieslist "$TN2" | sed 's/^/    /' | tee -a "$REPORT"
  cnc "$TN2"
  snap n2-1 'CNCAC1-OFFDAY'; snapdiff n2-0 n2-1 "N2 — Create Next Copy, occurrence parked on 07-09"
  note "  rule after: $(rsum "$TN2")"
  note "  rows dated 07-05 (TODAY): $(rowson "$TN2" 2026-07-05)   rows dated 07-09 (the OCCURRENCE): $(rowson "$TN2" 2026-07-09)"
  note "  series:"; serieslist "$TN2" | sed 's/^/    /' | tee -a "$REPORT"
fi

# =========================== DL2 — the maintainer's actual shape, with a deadline
if has_cell DL2; then
  cell "DL2 — after-completion + a per-occurrence DEADLINE, through the composite"
  TDL=$(mkac CNCAC1-DEADLINED "deadline:3")
  need "$TDL" DL2
  note "  fixture state: $(rsum "$TDL")"
  note "  series:"; serieslist "$TDL" | sed 's/^/    /' | tee -a "$REPORT"
  snap dl2-0 'CNCAC1-DEADLINED'
  cnc "$TDL"
  snap dl2-1 'CNCAC1-DEADLINED'; snapdiff dl2-0 dl2-1 "DL2 — Create Next Copy on a deadlined after-completion rule"
  MDL=$(newest_instance "$TDL"); note "  minted instance = $MDL"
  note "  minted row: $(gt "SELECT substr(uuid,1,8) u, startDate, deadline, status FROM TMTask WHERE uuid='$MDL'")"
  O=$(G todo complete "$MDL" --json); echo "$O" > "$OUT/log/dl2-complete.log"
  note "  $(echo "$O" | tail -2)"
  snap dl2-2 'CNCAC1-DEADLINED'; snapdiff dl2-1 dl2-2 "DL2 — complete the mint"
  note "  rule after: $(rsum "$TDL")"
  note "  series:"; serieslist "$TDL" | sed 's/^/    /' | tee -a "$REPORT"
fi

# ================== WAIT — the GUI counterpart of the cursor-less CNC duplicate
#
# Pass 1 found how Upcoming draws the two states apart: a series WITH a cursor
# gets an ordinary row under its day header ("12. Sunday"), while a cursor-less
# after-completion series is parked in a trailing "Repeating To-Dos" section and
# labelled "Waiting" — the app's own rendering of "no next date". That row still
# carries a checkbox. Clicking it is the GUI's version of the gesture that CNC
# turns into oddities §18's duplicate, so measure what the app itself does.
if has_cell WAIT; then
  cell "WAIT — checking off a cursor-less series' \"Waiting\" row in Upcoming"
  TW=$(mkseries CNCAC1-WAITING 2026-07-05 "after completion" 1)
  need "$TW" WAIT
  note "  rule: $(rsum "$TW")"
  note "  open occurrences: $(open_count "$TW")  live rows: $(live_count "$TW")"
  warm
  upcoming
  windump wait-upcoming
  note "  where Upcoming files it:"
  grep -n -B2 "CNCAC1-WAITING" "$OUT/ax/wait-upcoming.txt" | sed 's/^/    /' | head -12 | tee -a "$REPORT"
  snap wait-0 'CNCAC1-WAITING'
  revealclick "$TW" "CNCAC1-WAITING" "Checkbox"
  lab_ssh "$IP" 'sleep 10' </dev/null
  snap wait-1 'CNCAC1-WAITING'; snapdiff wait-0 wait-1 "WAIT — check off a \"Waiting\" row"
  note "  rule after: $(rsum "$TW")"
  note "  open occurrences: $(open_count "$TW")  live rows: $(live_count "$TW")"
  note "  rows dated 07-05: $(rowson "$TW" 2026-07-05)"
  note "  series:"; serieslist "$TW" | sed 's/^/    /' | tee -a "$REPORT"
  note "  app: $(alive); crash reports: $(crashes)"
fi

# ====================== SH — the RE-ANCHOR discriminator (gesture day ≠ anchor)
#
# Passes 1–2 built every fixture at the pinned 2026-07-05 and gestured on the
# same day, so "the series re-anchors to the completion" and "the series was
# never re-anchored" predict the SAME numbers (anchor 07-05 either way). That
# confound is fatal to the equivalence claim: if the GUI check-off does not
# re-anchor and the composite does, the two paths agree only on the anchor's own
# day and diverge on every other one. Roll to 07-08 FIRST, then gesture — the
# two hypotheses now differ (acRef 07-08 + cursor 07-15, vs acRef 07-05 +
# cursor 07-12) — and run both arms in the same roll.
if has_cell SH; then
  cell "SH — does the check-off RE-ANCHOR? (gestured on a day that is not the anchor)"
  TSG=$(mkac CNCAC1-SHIFTGUI)
  need "$TSG" SH
  TSC=$(mkac CNCAC1-SHIFTCNC)
  need "$TSC" SH
  note "  GUI arm before: $(rsum "$TSG")"
  note "  CNC arm before: $(rsum "$TSC")"
  snap sh-g0 'CNCAC1-SHIFTGUI'; snap sh-c0 'CNCAC1-SHIFTCNC'
  note "  ---- roll to 2026-07-08 (neither arm's cursor — nothing should spawn) ----"
  setclock 070812002026 || { note "FATAL: refused roll"; exit 1; }
  snap sh-g1 'CNCAC1-SHIFTGUI'; snapdiff sh-g0 sh-g1 "SH/GUI — the roll itself (expect SILENT)"
  snap sh-c1 'CNCAC1-SHIFTCNC'; snapdiff sh-c0 sh-c1 "SH/CNC — the roll itself (expect SILENT)"
  note "  GUI arm after the roll: $(rsum "$TSG")"

  note "  ---- arm 1: the GUI check-off, now on 07-08 ----"
  warm
  upcoming
  revealclick "$TSG" "CNCAC1-SHIFTGUI" "Checkbox"
  lab_ssh "$IP" 'sleep 10' </dev/null
  snap sh-g2 'CNCAC1-SHIFTGUI'; snapdiff sh-g1 sh-g2 "SH/GUI — check off the projection on 07-08"
  RSG=$(rsum "$TSG"); note "  GUI arm after: $RSG"

  note "  ---- arm 2: CNC + complete, in the same roll ----"
  cnc "$TSC"
  snap sh-c2 'CNCAC1-SHIFTCNC'; snapdiff sh-c1 sh-c2 "SH/CNC — Create Next Copy on 07-08"
  MSC=$(newest_instance "$TSC"); note "  minted = $MSC; rule: $(rsum "$TSC")"
  O=$(G todo complete "$MSC" --json); echo "$O" > "$OUT/log/sh-complete.log"
  note "  $(echo "$O" | tail -2)"
  snap sh-c3 'CNCAC1-SHIFTCNC'; snapdiff sh-c2 sh-c3 "SH/CNC — complete the mint on 07-08"
  RSC=$(rsum "$TSC"); note "  CNC arm after: $RSC"

  note "  ---- THE DISCRIMINATION ----"
  note "  GUI: $RSG"
  note "  CNC: $RSC"
  verdict "SH/GUI re-anchors to the GESTURE day" "acRef=2026-07-08" "$RSG"
  verdict "SH/GUI derives the cursor from the new anchor" "next=2026-07-15" "$RSG"
  verdict "SH/CNC re-anchors to the GESTURE day" "acRef=2026-07-08" "$RSC"
  verdict "SH/CNC derives the cursor from the new anchor" "next=2026-07-15" "$RSC"
  note "  GUI series:"; serieslist "$TSG" | sed 's/^/    /' | tee -a "$REPORT"
  note "  CNC series:"; serieslist "$TSC" | sed 's/^/    /' | tee -a "$REPORT"
fi

# ============================================================ PHASE 2 — the roll
if has_cell ROLL; then
  cell "PHASE 2 — roll to 2026-07-12 (every arm's derived cursor)"
  TG=${TG:-$(tmpl CNCAC1-GUI)}; TC=${TC:-$(tmpl CNCAC1-CNC)}
  TX=${TX:-$(tmpl CNCAC1-CANX)}; TN=${TN:-$(tmpl CNCAC1-FRESH)}
  TU=${TU:-$(tmpl CNCAC1-UNDOZ)}; TT=${TT:-$(tmpl CNCAC1-UNDOT)}
  # arm : the baseline snapshot to diff the roll against
  ARMS="GUI:g-3 CNC:c-3 CANX:x-2 FRESH:n-1 UNDOZ:uz-2 UNDOT:ut-3 \
CONTROL:ctrl-1 PAUSED:p-2 EXCEPT:exc-2 OFFDAY:n2-1 DEADLINED:dl2-2"
  note "  cursors before the roll:"
  for a in $ARMS; do
    n="${a%%:*}"; T=$(tmpl "CNCAC1-$n")
    [ -n "$T" ] && note "    $n: $(rsum "$T")"
  done
  setclock 071212002026 || { note "FATAL: refused roll"; exit 1; }
  for a in $ARMS; do
    n="${a%%:*}"; B="${a#*:}"; T=$(tmpl "CNCAC1-$n")
    [ -n "$T" ] || continue
    [ -f "$OUT/snap/$B.tsv" ] || { note "  (no baseline snap $B for $n — skipping diff)"; continue; }
    snap "roll-$n" "CNCAC1-$n"
    snapdiff "$B" "roll-$n" "$n @07-12"
    note "  $n rows dated 07-12: $(rowson "$T" 2026-07-12)  open: $(open_count "$T")  rule: $(rsum "$T")"
  done
fi

note ""
note "================= SUMMARY: $PASS pass / $FAIL fail ================="
note "app: $(alive); crash reports: $(crashes)"
note "artifacts in $OUT"
