#!/bin/bash
# CNC1 — certify "Create Next Copy, then mutate the instance" as the universal
# template-mutation primitive on Things 3.23.
#
# The problem: a repeating TEMPLATE refuses every schedule/status write we ship
# (H-REPEAT-SCHEDULE), and the app's own Make Exception chooser is unreachable
# headlessly (REPX1 §3.4, REPX2, REPX3). Things 3.23 added
# `Items ▸ Repeat ▸ Create Next Copy` (CNC), which materializes the pending
# occurrence and advances the cursor exactly as the clock spawner does (RDLG2
# §5.2). If CNC + an ordinary instance write is BYTE-EQUIVALENT to the chooser's
# Make Exception branch, then every template mutation we want has a sanctioned,
# fully-drivable composite.
#
# CELLS
#   A1  EQUIVALENCE, fixed WEEKLY: CNC then re-date the minted instance to an
#       OFF-RULE day; roll the clock onto the vacated slot (silent?) and diff the
#       end state against REPX3 §1.2's Make Exception on the identical fixture.
#   A1C the weekly control — same fixture, no gesture; must spawn at the slot.
#   A2  the same on a fixed DAILY rule (REPX3 §2.1 step 1 is the comparison).
#   A2C the daily control.
#   B   §17 HAZARD: re-date the minted instance ONTO the rule's OWN next slot —
#       double-book at clock arrival, as the chooser path does (REPX3 §3.2)?
#   C   DEADLINE CARRY: a per-occurrence-deadline rule — does the minted instance
#       carry the derived deadline, and does an instance-local deadline edit stick?
#   D   REMINDER: a rule-level reminder time — inherited by the minted instance?
#       Does an instance-local reminder edit land?
#   E   AFTER-COMPLETION rule: what does CNC do — mint, refuse, or crash?
#   F1  STATUS/complete: CNC then complete the minted instance (RDLG2 §5.3 on v4).
#   F2  STATUS/cancel: CNC then CANCEL the minted instance (UNMEASURED anywhere).
#   G   UNDO: `things undo` after the composite — what reverses, what cannot.
#   H   PROJECT: is Create Next Copy reachable for a repeating PROJECT template?
#   E0  the UI-VECTOR LAB ESCAPE, end to end: the same ui-vector CLI call WITHOUT
#       THINGS_API_UI_DIRECT=1 must fail closed naming `things helpers setup --gui`,
#       and WITH it must drive. (The queued verification of the Article IV escape.)
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23 / dbv27; the
# golden is NEVER booted). Airgap, clock pinned 2026-07-05 (a Sunday). Every
# gesture happens at the pinned date in PHASE 1; PHASE 2 rolls the clock forward
# MONOTONICALLY (07-06 → 07-07 → 07-12) with every arm measured in the same roll.
# Fixtures fully synthetic (CNC1-*). DB oracle = FULL TMTask row snapshots (every
# column, packed dates decoded, blobs hashed) diffed either side of every gesture.
# Teardown on EXIT (KEEP=1 keeps it, REUSE=1 attaches to a live clone).
#
# THE TRIAL WALL: golden-v4's Things is a 15-day TRIAL build expiring 2026-07-18;
# past it the app goes read-only STICKILY and the clone is burned (REPX3 §5).
# setclock refuses any roll to 2026-07-18 or later.
#
# Usage:  CELLS="A1 A2" VM=cnc1-lab KEEP=1 lab/scripts/research-cnc1.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-cnc1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/ax" "$OUT/snap" "$OUT/log"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-E0 A1 A2 B C D E F1 F2 G H ROLL}"
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[cnc1] $*" | tee -a "$REPORT"; }
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
  # The guest bundle ships node + dist + commander ONLY (AGENTS.md). A worktree
  # with no `npm ci` builds a dist that cannot RUN in the guest, and every cell
  # then fails for a rig reason that reads like an app finding — fail here instead.
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

# rule summary (decodes rt1_recurrenceRule) — the RDLG2 / REPX1 / REPX3 helper
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
    dpk(row[1]),dpk(row[2]),row[3],row[6],dpk(row[4]),row[7],row[8])
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

# ---- the AX sheet/menu dumps ----------------------------------------------
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
# G  = a plain (non-ui) CLI call.   GU = a ui-vector call, carrying the escape.
G()  { lab_ssh "$IP" "$CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
GU() { lab_ssh "$IP" "$LAB_UI_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
# RIG GATE: the guest CLI must actually RUN before a single cell is judged.
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
# Meta.value is a plist document, not a scalar — pull the integer out of it.
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" | grep -o '<integer>[0-9]*' | grep -o '[0-9]*')
note "env: Things $TVER ($TBLD) / dbv $DBV / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"
note "crash reports at start: $(crashes)"

# ---------------------------------------------------------------- primitives
mktodo() {  # mktodo <title> [extra query] -> uuid
  lab_ssh "$IP" "open -g 'things:///add?title=$1${2:-}&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1"
}
tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1"; }
# the series' rows, newest first
newest_instance() { # newest_instance <templateUuid>
  gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"
}
# rowson <templateUuid> <YYYY-MM-DD> — UNTRASHED series rows dated that day.
# The packed date carries sub-day bits, so match the y/m/d FIELDS, never equality.
rowson() {
  local y=$((10#${2:0:4})) m=$((10#${2:5:2})) d=$((10#${2:8:2}))
  gq "SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 \
AND (startDate>>16)=$y AND ((startDate>>12)&15)=$m AND ((startDate>>7)&31)=$d"
}
serieslist() { # serieslist <templateUuid>
  gt "SELECT substr(uuid,1,8) uuid, status, trashed, startDate, deadline, reminderTime, stopDate, creationDate FROM TMTask WHERE rt1_repeatingTemplate='$1' ORDER BY creationDate"
}

# select a template row and census the Items ▸ Repeat submenu
selectrow() { # selectrow <uuid> -> echoes the verified selection
  lab_ssh "$IP" "open -g 'things:///show?id=$1'; sleep 3" </dev/null
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  axq 'tell application "Things3" to return id of selected to dos'
}
repeatmenu() {
  axq 'tell application "System Events" to tell process "Things3" to return name of every menu item of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1'
}
# THE GESTURE UNDER TEST
cnc() { # cnc <templateUuid>
  if [ -z "${1:-}" ]; then note "    SKIPPED — no template uuid (rig failure upstream)"; return 1; fi
  local sel; sel=$(selectrow "$1")
  note "    selection = $sel  (want $1)"
  case "$sel" in *"$1"*) : ;; *) note "    WARN: selection did not verify"; ;; esac
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Create Next Copy" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    cnc: /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 6' </dev/null
}

# ------------------------------------------------------------- fixture builder
#
# WHY THE FIXTURES ARE NOT BUILT WITH `things todo make-repeating` (as RDLG2c did):
# the permissions doctrine's Wave A write gate (2026-08-24) refuses the AppleScript
# vector whenever the process has no bundle id, which is exactly an sshd-descended
# guest shell — `doctor` in the clone reads `applescript direct-unknown`. The
# make-repeating composite's clone + trash legs are AppleScript, so the whole verb
# now blocks in the lab. `THINGS_API_UI_DIRECT=1` is the UI vector's escape and does
# NOT cover the write vector; there is no write-vector escape (cell E0 records this).
# So fixtures are built the REPX2/REPX3 way — a URL-scheme add, then the Repeat
# dialog driven directly by Accessibility — which has the happy side effect of making
# the A1/A2 fixtures byte-comparable with REPX3's, since those were built identically.

# select_item <uuid> — reveal + activate + verify the selection BY UUID (REPX3).
select_item() {
  local uuid="$1" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get id of selected to dos' 2>/dev/null)
    [ "$sel" = "$uuid" ] && { echo "$sel"; return 0; }
  done
  echo "$sel"; return 1
}

# mkrepeat <uuid> <frequency> [interval] [extras…] — promote a to-do to a series
# through `Items ▸ Repeat…`. The frequency pop-up is ENUMERATED and matched by
# substring (REPX3's fix), so a missing label fails loudly instead of silently
# promoting to daily. `extras` is a space-separated set of: `deadline:<n>` (tick
# "Add deadlines" and type n into the start-days-earlier field) and `reminder`
# (tick "Add reminders", accepting the dialog's own 12:00 default).
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
  # The interval field is `text field 1 of group 1` and must be driven closed-loop
  # (REPX3 §6: a raw click leaves the caret at 0 and digits PREPEND).
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
    *" reminder "*)
      axq 'tell application "System Events" to tell process "Things3"
        set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
        repeat with cb in (checkboxes of sh)
          if (name of cb as text) contains "eminder" then
            click cb
            delay 1
            return "ticked " & (name of cb as text)
          end if
        end repeat
        return "NO-REMINDER-CHECKBOX: " & (name of every checkbox of sh as text)
      end tell' | sed 's/^/    /' | tee -a "$REPORT" ;;
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
      # RDLG2 §1.3: ticking "Add deadlines" reveals start-days-earlier as
      # `text field 1` of the SHEET (value 0) — not of the cadence group.
      axq "tell application \"System Events\" to tell process \"Things3\"
        set sh to sheet 1 of (first window whose subrole is \"AXStandardWindow\")
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

# mkseries <TITLE> <when> <frequency> [interval] [extras] -> templateUuid ("" = rig failure)
mkseries() {
  local title="$1" when="$2" freq="$3" iv="${4:-1}" extras="${5:-}"
  local u; u=$(mktodo "$title" "&when=$when")
  note "  seed $title = $u" >&2
  mkrepeat "$u" "$freq" "$iv" "$extras" >&2
  local t; t=$(tmpl "$title")
  [ -n "$t" ] || note "  RIG FAILURE: no template minted for $title" >&2
  echo "$t"
}
# A fixture that did not mint is a RIG failure, not a finding — abort rather than
# let a dozen cells report phantom verdicts against an absent template.
need() { [ -n "${1:-}" ] && return 0; note "FATAL: the $2 fixture did not mint — aborting"; exit 1; }

# One warm launch+quit before the first AX drive: it recomputes Today buckets and
# repeat projections for the pinned date, so every gesture sees steady state.
[ "$BOOTSTRAP" = "1" ] && warm

# ================================================================= E0 — the escape
# The probe must be a PURE-ui op: `make-repeating` would have done, but its clone +
# trash legs send Apple Events, and the Wave A write gate blocks those in a guest
# with no bundle id (see the fixture-builder note). `pause-repeat` is menu-only, so
# the ONLY gate it can trip is Article IV's.
if has_cell E0; then
  cell "E0 — the UI-vector lab escape (Article IV), end to end"
  TE0=$(mkseries CNC1-E0 2026-07-05 daily)
  need "$TE0" E0
  note "  template=$TE0 rule: $(rsum "$TE0")"
  note "  -- the WRITE gate, for the record (an AppleScript-vector verb) --"
  O=$(GU todo make-repeating "$TE0" --frequency daily --interval 3 --dangerously-drive-gui --json)
  echo "$O" > "$OUT/log/e0-writegate.log"; note "  $(echo "$O" | tail -2)"
  verdict "E0 the AppleScript write vector is gated even WITH the ui escape" "blocked:environment" "$O"

  note "  -- a PURE-ui op WITHOUT THINGS_API_UI_DIRECT (must fail closed) --"
  O=$(G todo pause-repeat "$TE0" --dangerously-drive-gui --json)
  echo "$O" > "$OUT/log/e0-noescape.log"; note "  $(echo "$O" | tail -2)"
  verdict "E0 refuses without the escape" "helpers setup --gui" "$O"
  verdict "E0 the refusal is a clean block, not a hang" "EXIT=4" "$O"
  verdict "E0 nothing was driven without the escape" "paused=0" "$(rsum "$TE0")"

  note "  -- the SAME op WITH THINGS_API_UI_DIRECT=1 (must drive) --"
  O=$(GU todo pause-repeat "$TE0" --dangerously-drive-gui --json)
  echo "$O" > "$OUT/log/e0-escape.log"; note "  $(echo "$O" | tail -2)"
  verdict "E0 drives with the escape" "EXIT=0" "$O"
  verdict "E0 the pause landed in the database" "paused=1" "$(rsum "$TE0")"
  O=$(GU todo resume-repeat "$TE0" --dangerously-drive-gui --json)
  note "  resumed: $(echo "$O" | tail -1)"; note "  rule: $(rsum "$TE0")"
fi

# ================================================================= A1 — WEEKLY
if has_cell A1; then
  cell "A1 — EQUIVALENCE on a fixed WEEKLY rule (REPX3 §1.2 is the comparison)"
  TA1=$(mkseries CNC1-A1-WEEKLY 2026-07-05 weekly)
  need "$TA1" A1
  note "  template=$TA1"; note "  rule: $(rsum "$TA1")"
  snap a1-0 'CNC1-A1-WEEKLY'
  note "  -- gesture: Items ▸ Repeat ▸ Create Next Copy --"
  cnc "$TA1"
  snap a1-1 'CNC1-A1-WEEKLY'; snapdiff a1-0 a1-1 "A1 — Create Next Copy"
  note "  rule after CNC: $(rsum "$TA1")"
  MA1=$(newest_instance "$TA1"); note "  minted instance = $MA1"
  R=$(rsum "$TA1")
  verdict "A1 cursor -> next RULE date 07-19" "next=2026-07-19" "$R"
  verdict "A1 watermark -> consumed slot + 1 (07-13)" "icStart=2026-07-13" "$R"
  verdict "A1 icCount 1 -> 2" "icCount=2" "$R"
  note "  -- second write: re-date the minted instance to the OFF-RULE 2026-07-15 --"
  O=$(G todo update "$MA1" --when 2026-07-15 --json); echo "$O" > "$OUT/log/a1-redate.log"
  note "  $(echo "$O" | tail -3)"
  snap a1-2 'CNC1-A1-WEEKLY'; snapdiff a1-1 a1-2 "A1 — instance re-date to 07-15"
  note "  rule after re-date: $(rsum "$TA1")"
  note "  series now:"; serieslist "$TA1" | sed 's/^/    /' | tee -a "$REPORT"
  # the CONTROL — same fixture shape, no gesture at all
  TA1C=$(mkseries CNC1-A1C-WEEKLY 2026-07-05 weekly)
  need "$TA1C" A1C
  note "  control template=$TA1C rule: $(rsum "$TA1C")"
  snap a1c-0 'CNC1-A1C-WEEKLY'
fi

# ================================================================= A2 — DAILY
if has_cell A2; then
  cell "A2 — EQUIVALENCE on a fixed DAILY rule (REPX3 §2.1 step 1 is the comparison)"
  TA2=$(mkseries CNC1-A2-DAILY 2026-07-05 daily)
  need "$TA2" A2
  note "  template=$TA2 rule: $(rsum "$TA2")"
  snap a2-0 'CNC1-A2-DAILY'
  cnc "$TA2"
  snap a2-1 'CNC1-A2-DAILY'; snapdiff a2-0 a2-1 "A2 — Create Next Copy"
  R=$(rsum "$TA2"); note "  rule after CNC: $R"
  MA2=$(newest_instance "$TA2"); note "  minted instance = $MA2"
  verdict "A2 cursor -> 07-07" "next=2026-07-07" "$R"
  verdict "A2 watermark -> 07-07" "icStart=2026-07-07" "$R"
  verdict "A2 icCount 1 -> 2" "icCount=2" "$R"
  O=$(G todo update "$MA2" --when 2026-07-09 --json); echo "$O" > "$OUT/log/a2-redate.log"
  note "  $(echo "$O" | tail -3)"
  snap a2-2 'CNC1-A2-DAILY'; snapdiff a2-1 a2-2 "A2 — instance re-date to 07-09"
  note "  rule after re-date: $(rsum "$TA2")"
  TA2C=$(mkseries CNC1-A2C-DAILY 2026-07-05 daily)
  need "$TA2C" A2C
  note "  control template=$TA2C rule: $(rsum "$TA2C")"
  snap a2c-0 'CNC1-A2C-DAILY'
fi

# ================================================================= B — §17 hazard
if has_cell B; then
  cell "B — §17 HAZARD: re-date the minted instance ONTO the rule's OWN next slot"
  TB=$(mkseries CNC1-B-SLOT 2026-07-05 daily)
  need "$TB" B
  note "  template=$TB rule: $(rsum "$TB")"
  snap b-0 'CNC1-B-SLOT'
  cnc "$TB"
  snap b-1 'CNC1-B-SLOT'; snapdiff b-0 b-1 "B — Create Next Copy"
  MB=$(newest_instance "$TB"); note "  minted instance = $MB; cursor now $(rsum "$TB")"
  note "  -- re-date the minted instance ONTO 2026-07-07, the cursor's own slot --"
  O=$(G todo update "$MB" --when 2026-07-07 --json); echo "$O" > "$OUT/log/b-redate.log"
  note "  $(echo "$O" | tail -3)"
  snap b-2 'CNC1-B-SLOT'; snapdiff b-1 b-2 "B — instance re-date onto the live slot"
  note "  rule after: $(rsum "$TB")"
  note "  rows dated 2026-07-07 BEFORE the clock arrives: $(rowson "$TB" 2026-07-07)"
fi

# ================================================================= C — deadline
if has_cell C; then
  cell "C — DEADLINE CARRY on a per-occurrence-deadline rule"
  TC=$(mkseries CNC1-C-DL 2026-07-05 daily 1 "deadline:3")
  need "$TC" C
  note "  template=$TC rule: $(rsum "$TC")"
  snap c-0 'CNC1-C-DL'
  cnc "$TC"
  snap c-1 'CNC1-C-DL'; snapdiff c-0 c-1 "C — Create Next Copy on a deadlined rule"
  MC=$(newest_instance "$TC"); note "  minted instance = $MC"
  note "  minted row: $(gt "SELECT substr(uuid,1,8) u, startDate, deadline, status FROM TMTask WHERE uuid='$MC'")"
  note "  -- instance-local deadline edit --"
  O=$(G todo update "$MC" --deadline 2026-07-16 --json); echo "$O" > "$OUT/log/c-deadline.log"
  note "  $(echo "$O" | tail -3)"
  snap c-2 'CNC1-C-DL'; snapdiff c-1 c-2 "C — instance-local deadline edit"
  note "  rule after: $(rsum "$TC")"
fi

# ================================================================= D — reminder
if has_cell D; then
  cell "D — REMINDER inheritance and an instance-local reminder edit"
  TD=$(mkseries CNC1-D-REM 2026-07-05 daily 1 "reminder")
  need "$TD" D
  note "  template=$TD rule: $(rsum "$TD")"
  snap d-0 'CNC1-D-REM'
  cnc "$TD"
  snap d-1 'CNC1-D-REM'; snapdiff d-0 d-1 "D — Create Next Copy on a reminder rule"
  MD=$(newest_instance "$TD"); note "  minted instance = $MD"
  note "  minted row: $(gt "SELECT substr(uuid,1,8) u, startDate, reminderTime, status FROM TMTask WHERE uuid='$MD'")"
  note "  -- instance-local reminder edit (when + @time) --"
  O=$(G todo update "$MD" --when 2026-07-08 --reminder 14:30 --json); echo "$O" > "$OUT/log/d-reminder.log"
  note "  $(echo "$O" | tail -3)"
  snap d-2 'CNC1-D-REM'; snapdiff d-1 d-2 "D — instance-local reminder edit"
  note "  rule after: $(rsum "$TD")"
fi

# ================================================================= E — after-completion
if has_cell E; then
  cell "E — CNC on an AFTER-COMPLETION rule: mint, refuse, or crash?"
  CR0=$(crashes)
  TE=$(mkseries CNC1-E-AC 2026-07-05 "after completion" 2)
  need "$TE" E
  note "  template=$TE rule: $(rsum "$TE")"
  snap e-0 'CNC1-E-AC'
  SEL=$(selectrow "$TE"); note "    selection=$SEL (want $TE)"
  note "    Items ▸ Repeat submenu on an after-completion template: $(repeatmenu)"
  cnc "$TE"
  sheetdump e-after-cnc
  snap e-1 'CNC1-E-AC'; snapdiff e-0 e-1 "E — Create Next Copy on an after-completion rule"
  note "  rule after: $(rsum "$TE")"
  note "  app: $(alive); crash reports $CR0 -> $(crashes)"
fi

# ================================================================= F1/F2 — status
if has_cell F1; then
  cell "F1 — CNC then COMPLETE the minted instance (RDLG2 §5.3 on golden-v4)"
  TF1=$(mkseries CNC1-F1-DONE 2026-07-05 daily)
  need "$TF1" F1
  note "  template=$TF1 rule: $(rsum "$TF1")"
  cnc "$TF1"
  snap f1-1 'CNC1-F1-DONE'
  MF1=$(newest_instance "$TF1"); note "  minted instance = $MF1; rule: $(rsum "$TF1")"
  O=$(G todo complete "$MF1" --json); echo "$O" > "$OUT/log/f1-complete.log"
  note "  $(echo "$O" | tail -3)"
  snap f1-2 'CNC1-F1-DONE'; snapdiff f1-1 f1-2 "F1 — complete the minted instance"
  R=$(rsum "$TF1"); note "  rule after: $R"
  verdict "F1 template unmoved by the completion (cursor still 07-07)" "next=2026-07-07" "$R"
  verdict "F1 icCount still 2" "icCount=2" "$R"
  note "  series:"; serieslist "$TF1" | sed 's/^/    /' | tee -a "$REPORT"
fi

if has_cell F2; then
  cell "F2 — CNC then CANCEL the minted instance (unmeasured anywhere)"
  TF2=$(mkseries CNC1-F2-CANX 2026-07-05 daily)
  need "$TF2" F2
  note "  template=$TF2 rule: $(rsum "$TF2")"
  cnc "$TF2"
  snap f2-1 'CNC1-F2-CANX'
  MF2=$(newest_instance "$TF2"); note "  minted instance = $MF2; rule: $(rsum "$TF2")"
  O=$(G todo cancel "$MF2" --json); echo "$O" > "$OUT/log/f2-cancel.log"
  note "  $(echo "$O" | tail -3)"
  snap f2-2 'CNC1-F2-CANX'; snapdiff f2-1 f2-2 "F2 — cancel the minted instance"
  R=$(rsum "$TF2"); note "  rule after: $R"
  verdict "F2 template unmoved by the cancel (cursor still 07-07)" "next=2026-07-07" "$R"
  note "  series:"; serieslist "$TF2" | sed 's/^/    /' | tee -a "$REPORT"
  note "  logbook view (status/stopDate):"
  gt "SELECT substr(uuid,1,8) u, status, stopDate, startDate FROM TMTask WHERE rt1_repeatingTemplate='$TF2'" | sed 's/^/    /' | tee -a "$REPORT"
fi

# ================================================================= G — undo
if has_cell G; then
  cell "G — \`things undo\` after the composite"
  TG=$(mkseries CNC1-G-UNDO 2026-07-05 daily)
  need "$TG" G
  note "  template=$TG rule: $(rsum "$TG")"
  cnc "$TG"
  snap g-1 'CNC1-G-UNDO'
  MG=$(newest_instance "$TG"); note "  minted instance = $MG; rule: $(rsum "$TG")"
  O=$(G todo update "$MG" --when 2026-07-10 --json); echo "$O" > "$OUT/log/g-redate.log"
  note "  $(echo "$O" | tail -3)"
  snap g-2 'CNC1-G-UNDO'; snapdiff g-1 g-2 "G — the instance write"
  note "  -- things undo --"
  O=$(G undo --json); echo "$O" > "$OUT/log/g-undo.log"
  note "  $(echo "$O" | tail -6)"
  snap g-3 'CNC1-G-UNDO'; snapdiff g-2 g-3 "G — after \`things undo\`"
  snapdiff g-1 g-3 "G — NET of the undo vs the post-CNC state"
  note "  rule after undo: $(rsum "$TG")"
fi

# ================================================================= H — project
if has_cell H; then
  cell "H — is Create Next Copy reachable for a repeating PROJECT template?"
  # `project add-repeating` is AppleScript-gated in the guest (see E0), so the
  # project is created through the URL scheme and promoted through the project
  # view's own repeat surface. Best effort: RDLG2 §7 cell 3 records the 3.23
  # project REVEAL as un-recertified (it needs the repeat-bar popover HID click).
  lab_ssh "$IP" "open -g 'things:///add-project?title=CNC1-H-PROJ&when=2026-07-05&auth-token=$TOKEN'; sleep 5" </dev/null
  PH=$(gq "SELECT uuid FROM TMTask WHERE title='CNC1-H-PROJ' AND type=1 AND trashed=0 LIMIT 1")
  note "  project seed=$PH"
  if [ -z "$PH" ]; then
    note "  RIG-BLOCKED: the project seed was not created"
  else
    snap h-0 'CNC1-H-PROJ'
    lab_ssh "$IP" "open -g 'things:///show?id=$PH'; sleep 3" </dev/null
    lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
    note "  selected projects: $(axq 'tell application "Things3" to return id of selected to dos')"
    note "  Items menu with the PROJECT open: $(axq 'tell application "System Events" to tell process "Things3" to return name of every menu item of menu "Items" of menu bar 1')"
    RM=$(repeatmenu); note "  Items ▸ Repeat submenu: $RM"
    if echo "$RM" | grep -q "Create Next Copy"; then
      cnc "$PH"
      snap h-1 'CNC1-H-PROJ'; snapdiff h-0 h-1 "H — Create Next Copy on a project"
    else
      note "  VERDICT: Items ▸ Repeat carries no Create Next Copy for this selection"
      note "  (a project is not a 'to do', so the to-do reveal does not select it as one —"
      note "   the project repeat surface is the always-visible repeat BAR, whose reveal is"
      note "   the HID-click cell RDLG2 §7 left open. Recorded as RIG-BLOCKED, best effort.)"
    fi
  fi
fi

# ================================================================= PHASE 2 — the rolls
if has_cell ROLL; then
  cell "PHASE 2 — monotonic clock rolls, every arm measured in the same roll"
  TA1=${TA1:-$(tmpl CNC1-A1-WEEKLY)}; TA1C=${TA1C:-$(tmpl CNC1-A1C-WEEKLY)}
  TA2=${TA2:-$(tmpl CNC1-A2-DAILY)};  TA2C=${TA2C:-$(tmpl CNC1-A2C-DAILY)}
  TB=${TB:-$(tmpl CNC1-B-SLOT)};      TF1=${TF1:-$(tmpl CNC1-F1-DONE)}
  TF2=${TF2:-$(tmpl CNC1-F2-CANX)};   TE=${TE:-$(tmpl CNC1-E-AC)}

  note ""; note "---- roll to 2026-07-06 (the DAILY arms' vacated slot) ----"
  setclock 070612002026 || { note "FATAL: refused roll"; exit 1; }
  snap a2-r6 'CNC1-A2-DAILY';  snapdiff a2-2 a2-r6 "A2 @07-06 — the vacated slot (expect SILENT)"
  snap a2c-r6 'CNC1-A2C-DAILY'; snapdiff a2c-0 a2c-r6 "A2C control @07-06 (expect a normal spawn)"
  snap b-r6 'CNC1-B-SLOT';     snapdiff b-2 b-r6 "B @07-06 (cursor is 07-07 — expect SILENT)"
  note "  A2  rows dated 07-06: $(rowson "$TA2" 2026-07-06)   rule: $(rsum "$TA2")"
  note "  A2C rows dated 07-06: $(rowson "$TA2C" 2026-07-06)  rule: $(rsum "$TA2C")"
  verdict_eq "A2 vacated slot is SILENT" "0" "$(rowson "$TA2" 2026-07-06)"
  verdict_eq "A2C control spawns at its slot" "1" "$(rowson "$TA2C" 2026-07-06)"

  note ""; note "---- roll to 2026-07-07 (cell B's collision day) ----"
  setclock 070712002026 || { note "FATAL: refused roll"; exit 1; }
  snap b-r7 'CNC1-B-SLOT'; snapdiff b-r6 b-r7 "B @07-07 — the collision"
  note "  B rows dated 07-07: $(rowson "$TB" 2026-07-07)   rule: $(rsum "$TB")"
  note "  B series:"; serieslist "$TB" | sed 's/^/    /' | tee -a "$REPORT"
  snap f1-r7 'CNC1-F1-DONE'; snapdiff f1-2 f1-r7 "F1 @07-07 — does the completed series continue?"
  snap f2-r7 'CNC1-F2-CANX'; snapdiff f2-2 f2-r7 "F2 @07-07 — does the CANCELED series continue?"
  note "  F1 rows dated 07-07: $(rowson "$TF1" 2026-07-07)  rule: $(rsum "$TF1")"
  note "  F2 rows dated 07-07: $(rowson "$TF2" 2026-07-07)  rule: $(rsum "$TF2")"
  snap e-r7 'CNC1-E-AC'; snapdiff e-1 e-r7 "E @07-07 — the after-completion arm"

  note ""; note "---- roll to 2026-07-12 (the WEEKLY arms' slot) ----"
  setclock 071212002026 || { note "FATAL: refused roll"; exit 1; }
  snap a1-r12 'CNC1-A1-WEEKLY';  snapdiff a1-2 a1-r12 "A1 @07-12 — the vacated weekly slot (expect SILENT)"
  snap a1c-r12 'CNC1-A1C-WEEKLY'; snapdiff a1c-0 a1c-r12 "A1C control @07-12 (expect a normal spawn)"
  note "  A1  rows dated 07-12: $(rowson "$TA1" 2026-07-12)   rule: $(rsum "$TA1")"
  note "  A1C rows dated 07-12: $(rowson "$TA1C" 2026-07-12)  rule: $(rsum "$TA1C")"
  verdict_eq "A1 vacated weekly slot is SILENT" "0" "$(rowson "$TA1" 2026-07-12)"
  verdict_eq "A1C control spawns at its weekly slot" "1" "$(rowson "$TA1C" 2026-07-12)"
  note "  A1 series end state:"; serieslist "$TA1" | sed 's/^/    /' | tee -a "$REPORT"
  note "  (informational) B rows dated 07-07 at end: $(rowson "$TB" 2026-07-07)"
fi

note ""
note "================= SUMMARY: $PASS pass / $FAIL fail ================="
note "app: $(alive); crash reports: $(crashes)"
note "artifacts in $OUT"
