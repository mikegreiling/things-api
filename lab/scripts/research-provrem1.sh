#!/bin/bash
# PROVREM1 — the PROVISIONAL occurrence of an after-completion series: what the
# app does to it, and what our writes claim it did (issue #699).
#
# THE FIELD REPORT (#699, Things 3.23.3, CLI 0.20.7-dev). An after-completion
# series (every 2 weeks, deadlined via a -6 day start offset) had a spawned
# current occurrence carrying a 12:00 reminder and reading
# `provisional: true` / `stage: anytime` / `when: today`. Four commands, four
# wrong answers:
#
#   1. update <occurrence> --when anytime --clear-reminder --exception
#        -> blocked:environment "this to-do is no longer a repeating series"
#   2. update <template>   --when anytime --clear-reminder --exception
#        -> blocked:environment "no upcoming occurrence ..." (true for an
#           after-completion series with no cursor) whose remediation points
#           back at the occurrence command 1 just refused
#   3. update <occurrence> --when anytime --clear-reminder
#        -> blocked:H-REMINDER-SCOPE "re-state when today|evening"
#   4. update <occurrence> --when today --clear-reminder   (the remediation)
#        -> verify-failed:mismatch — expected start=active, OBSERVED
#           start=someday + today=true, the reminder actually cleared
#
# WHAT IS ALREADY KNOWN, AND WHY THIS CAMPAIGN STILL RUNS. `start=2` plus an
# arrived `startDate` IS the app's own representation of an unmaterialized Today
# member (BANNER1 L1/L2(c): a repeat-instance spawn is born `start=2`), and SIT3
# BANNERACK measured `update?...&when=today` on such a row as a COMPLETE no-op.
# Both were measured on Things 3.22.11/3.22.12 (golden-v1/v2, schema v26),
# NEITHER on a repeating occurrence carrying a REMINDER, and the one question the
# whole fix turns on has never been probed at all:
#
#   *** does a bare `when=anytime` CLEAR `reminderTime`? ***
#
# Nothing in the corpus sends `when=anytime` (or `someday`) to a row with a
# non-NULL `reminderTime`. src/write/update-fields.ts `effectiveReminder`
# ASSUMES it does (it returns null for every non-schedulable `when`, and the
# reminder assertion then demands `reminderTime IS NULL`), and H-REMINDER-SCOPE
# refuses the one call that would have exposed the assumption. So the guard is
# hiding an untested branch behind a refusal, and the answer decides whether
# `--when anytime --clear-reminder` can be ONE call.
#
# METHOD: ONE disposable clone `provrem1-lab` of things-lab-golden-v4 (the
# golden is NEVER booted). Airgapped (default route deleted, ping asserted to
# fail), guest clock pinned to 2026-07-05 12:00 BEFORE Things launches, then
# rolled ONCE to 2026-07-08 — inside golden-v4's 2026-07-18 trial wall — so the
# app's own repeat engine SPAWNS the occurrence at midnight, exactly as the
# field's occurrence was born. Ground truth = read-only guest SQLite full-row
# snapshots; CLI exit 0 and `open` exit 0 prove nothing. Synthetic PROVREM1-*
# fixtures only. Teardown on EXIT (KEEP=1 holds the clone).
#
# ARMS: ARM=pre runs against the SHIPPED build (reproduces #699); ARM=post runs
# the identical cells against the FIXED build on a fresh clone. Same script,
# same fixtures, one clone at a time.
#
# Usage:  bash lab/scripts/research-provrem1.sh            # ARM=pre
#         ARM=post bash lab/scripts/research-provrem1.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

ARM="${ARM:-pre}"
VM="provrem1-lab"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM-$ARM"; mkdir -p "$OUT/snap" "$OUT/ax"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[provrem1/$ARM] $*" | tee -a "$REPORT"; }
notef() { echo "[provrem1/$ARM] $*" >>"$REPORT"; echo "[provrem1/$ARM] $*" >&2; }
KEEP="${KEEP:-0}"
DIST="${DIST:-dist}"

case "$VM" in things-lab-golden-*) echo "refusing to touch a golden" >&2; exit 1 ;; esac

# ---- the trial-wall guard (REPX3 section 5: refuse the roll, never trust the operator)
TRIAL_WALL="20260718"
note "golden: $GOLDEN - dist: $DIST - arm: $ARM - trial wall: $TRIAL_WALL"

# ---- wait politely for a VM slot (2-VM ceiling)
for attempt in $(seq 1 60); do
  RUNNING=$(tart list 2>/dev/null | awk '$NF=="running"' | grep -cv "^$" || true)
  [ "${RUNNING:-2}" -lt 2 ] && break
  note "  $RUNNING/2 VM slots busy — waiting (attempt $attempt/60)"
  sleep 30
done
RUNNING=$(tart list 2>/dev/null | awk '$NF=="running"' | grep -cv "^$" || true)
[ "${RUNNING:-2}" -lt 2 ] || { note "FATAL: no VM slot after 30min"; exit 1; }

# The teardown trap is armed BEFORE the boot, not after: the first attempt at
# this campaign lost 6 minutes of boot to a `lab_wait_for_ssh` timeout and left
# the clone RUNNING, because the trap had not been installed yet (an orphaned
# `tart run` holding a 50 GB VM on a thin disk is the incident the harness
# forbids). Arm first, then boot — every exit path tears down.
cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — $VM left running at ${IP:-?}"; return; fi
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done"
}

if [ -n "${REUSE_IP:-}" ]; then
  # An already-booted clone of this campaign's own VM name (a re-run after a
  # slow boot). Still a disposable clone, still airgapped and clock-pinned
  # below, and Things has not been launched on it.
  trap cleanup EXIT
  IP="$REUSE_IP"
  note "REUSE_IP: reusing the booted clone at $IP"
else
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  trap cleanup EXIT
  tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &
  TART_PID=$!
  note "tart run pid $TART_PID (owned by this shell)"
  IP=$(lab_wait_for_ssh "$VM" 900) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
fi

# ---- airgap + clock pin, BEFORE Things is ever launched -----------------------
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AIRGAP=$(lab_ssh "$IP" 'ping -c1 -t3 1.1.1.1 >/dev/null 2>&1 && echo REACHABLE || echo UNREACHABLE' </dev/null)
note "airgap: 1.1.1.1 is $AIRGAP"
[ "$AIRGAP" = "UNREACHABLE" ] || { note "FATAL: clone still reaches the internet"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
note "clock pinned: $(lab_ssh "$IP" date </dev/null)"

# ---- guest helpers ------------------------------------------------------------
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-noheader -list); if [ "$1" = "-t" ]; then FMT=(-header -column); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

# rsum.py — the series decoder (REPX2's, plus reminderTime + placement columns).
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
def dtm(v):
    if not isinstance(v,int): return v
    return "%02d:%02d"%((v>>26)&0x3F,(v>>20)&0x3F)
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, startDate, rt1_instanceCreationPaused, rt1_afterCompletionReferenceDate, reminderTime, start, startBucket, todayIndex, todayIndexReferenceDate, status FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
tail="start=%s sd=%s sb=%s rem=%s tIdx=%s tIdxRef=%s deadline=%s status=%s"%(
    row[9],dpk(row[5]),row[10],dtm(row[8]),row[11],dpk(row[12]),dpk(row[4]),row[13])
if row[0] is None:
    print("NO-RULE next=%s icStart=%s icCount=%s %s"%(dpk(row[1]),dpk(row[2]),row[3],tail)); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] next=%s icStart=%s icCount=%s paused=%s acRef=%s %s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),
    dpk(row[1]),dpk(row[2]),row[3],row[6],dpk(row[7]),tail))
EOF
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1' 2>&1" </dev/null; }

# FULL-ROW snapshot (REPX2's): every TMTask column of every PROVREM1-* row.
lab_ssh "$IP" 'cat > ~/labh/rowsnap.py' <<'EOF'
import sys, sqlite3, glob, hashlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True); c.row_factory=sqlite3.Row
DATECOLS={'startDate','deadline','stopDate','rt1_nextInstanceStartDate','rt1_instanceCreationStartDate','rt1_afterCompletionReferenceDate','todayIndexReferenceDate','deadlineSuppressionDate'}
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%s(%04d-%02d-%02d)"%(v,y,m,d) if 1<y<5000 else v
def dtm(v):
    if not isinstance(v,int): return v
    return "%s(%02d:%02d)"%(v,(v>>26)&0x3F,(v>>20)&0x3F)
rows=c.execute("SELECT * FROM TMTask WHERE title LIKE ? ORDER BY creationDate, uuid",(sys.argv[1],)).fetchall()
for r in rows:
    for k in r.keys():
        v=r[k]
        if isinstance(v,bytes): v='blob:sha256:'+hashlib.sha256(v).hexdigest()[:16]+':len'+str(len(v))
        elif k=='reminderTime': v=dtm(v)
        elif k in DATECOLS: v=dpk(v)
        print("%s\t%s\t%s"%(r['uuid'],k,v))
EOF
snap() { # snap <name> [titleLike]
  lab_ssh "$IP" "python3 ~/labh/rowsnap.py $(printf '%q' "${2:-PROVREM1-%}")" </dev/null > "$OUT/snap/$1.tsv" 2>&1
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

# ---- AX dumps (REPX2's sheet census, verbatim) --------------------------------
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
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
sheetdump() {
  lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1
  note "  [sheet census $1: $(grep -cE '^=== ' "$OUT/ax/$1.txt") containers]"
  grep -E '^=== |AXButton|AXStaticText|no sheet' "$OUT/ax/$1.txt" | sed 's/^/      /' | head -20 | tee -a "$REPORT"
}

# the beep sentinel (harness section The beep sentinel) — post-hoc, no live listener
lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null
beep_reset() { lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null 2>&1; }
beep_mark()  { lab_ssh "$IP" "~/labh/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }
beep_assert() {
  lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/labh/beep-sentinel.sh assert --name $(printf '%q' "$1")" \
    </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
}
note "helpers installed"

# ---- ship the shipped CLI (node + dist + commander) --------------------------
[ -f "$DIST/cli/main.js" ] || { note "FATAL: $DIST/cli/main.js missing (npm run build)"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { local a c; for a in 1 2 3 4 5; do sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; c=$?; [ "$c" -eq 0 ] && return 0; sleep 3; done; return "$c"; }
lab_ssh "$IP" true </dev/null; sleep 2
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "FATAL node scp"; exit 1; }
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r "$DIST" "admin@$IP:/Users/admin/things-lab/things-api/dist" >/dev/null
COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "FATAL commander scp"; exit 1; }
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
CLI="$LAB_DIRECT ~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1

VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
BLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
TRIAL=$(lab_ssh "$IP" 'defaults read com.culturedcode.ThingsMac firstAppLaunchDate 2>/dev/null || echo "?"' </dev/null)
launch_things() { lab_ssh "$IP" 'open -a Things3; sleep 16; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
kill_things() { lab_ssh "$IP" 'pkill -x Things3; sleep 4' </dev/null; }
launch_things
gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
note "env: Things $VER ($BLD) - dbv $(gq 'SELECT databaseVersion FROM Meta') - macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)"
note "trial firstAppLaunchDate: $TRIAL"

settle() { lab_ssh "$IP" "sleep ${1:-3}" </dev/null; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
ips_count() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }
cli() { # cli <tag> <argv...>  -> echoes the exit code
  local tag="$1"; shift
  lab_ssh "$IP" "$CLI $*" </dev/null >"$OUT/cli-$tag.out" 2>&1
  local rc=$?
  notef "    \$ things $* -> exit $rc"
  echo "$rc"
}
clitail() { sed 's/^/      | /' "$OUT/cli-$1.out" | head -"${2:-14}" | tee -a "$REPORT"; }
url() { # url <tag> <query-after-things:///>
  lab_ssh "$IP" "open -g 'things:///$2'" </dev/null >/dev/null 2>&1
  notef "    open -g things:///$2"
  settle 4
}
tmplid() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
plainid() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
instid() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 AND status=0 ORDER BY startDate, creationDate LIMIT 1\"" </dev/null; }

# select_item — REPX2's uuid-verified selection (show?id= then read back).
select_item() {
  local uuid="$1" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get id of selected to dos' 2>/dev/null)
    [ "$sel" = "$uuid" ] && { note "    selection OK by UUID on attempt $i"; return 0; }
    note "    selection attempt $i -> '$sel' (want '$uuid')"
  done
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
clickitem() { # clickitem <menu item name> — by NAME, never by index
  axq "tell application \"System Events\" to tell process \"Things3\" to click menu item \"$1\" of menu \"Items\" of menu bar 1" 2>&1
  settle 4
}
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
typetext() { lab_ssh "$IP" "osascript -e $(printf '%q' "tell application \"System Events\" to keystroke \"$1\"")" </dev/null 2>&1; settle 2; }
keyret() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 36'\''; sleep 4' </dev/null; }

# THE MODAL-SHEET PREFLIGHT. The first arm of this campaign sent its URL cells
# with an EMPTY auth token; the app answered each one with a modal "Things URL
# Scheme … requires an authentication token" sheet, and that sheet then
# swallowed every later gesture — the Items-menu census came back with all 18
# items `enabled=false` and both GUI cells drove nothing while reporting a clean
# empty row delta. A blocked app looks exactly like an app that declined, so a
# GUI cell states whether a sheet is up BEFORE it drives, and refuses if one is.
sheets_open() {
  lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa' </dev/null 2>&1 | grep -cE '^=== AXSheet' || true
}
require_no_sheet() { # require_no_sheet <cell> -> 0 clean, 1 blocked
  local n; n=$(sheets_open)
  [ "$n" = "0" ] && { note "    preflight: no sheet open"; return 0; }
  note "    preflight: $n sheet(s) OPEN — dismissing before $1"
  axq 'tell application "System Events" to tell process "Things3" to click button "OK" of sheet 1 of window 1' >/dev/null 2>&1
  esc
  n=$(sheets_open)
  [ "$n" = "0" ] && { note "    preflight: dismissed, clean"; return 0; }
  note "    preflight: FAILED — $n sheet(s) still open; $1 is VOID"
  return 1
}

# The 3.23 When picker is a natural-language search field: type, then READ BACK
# the resolved row before committing (REPX2's pickdate law — never commit blind).
whenpick() { # whenpick <phrase> <expected-substring-of-a-resolved-row>
  local phrase="$1" want="$2"
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "a" using command down'\''; sleep 1' </dev/null
  typetext "$phrase" >/dev/null
  lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa' </dev/null > "$OUT/ax/pick-last.txt" 2>&1
  if grep -qi "$want" "$OUT/ax/pick-last.txt"; then
    note "    picker RESOLVED '$phrase' -> $(grep -io "[^|]*$want[^|]*" "$OUT/ax/pick-last.txt" | head -1 | tr -s ' ')"
    return 0
  fi
  note "    picker did NOT resolve '$phrase' (nothing matched '$want'); offered: $(grep -o 'desc=[^|]*' "$OUT/ax/pick-last.txt" | head -8 | tr '\n' ' ')"
  return 1
}

# gui_anytime <uuid> <label> — the ORACLE gesture: select the row, open
# Items > When..., resolve "Anytime" in the picker, commit, then census whatever
# the app put on screen (the exception chooser is what REPX2 saw on a
# PROJECTION; a materialized instance has never raised one — REPX1 section 3).
gui_anytime() {
  local uuid="$1" label="$2"
  require_no_sheet "$label" || return 1
  select_item "$uuid" || { note "    $label VOID: selection never confirmed"; return 1; }
  note "    Items menu with the row selected:"
  itemsmenu | tee -a "$REPORT"
  clickitem "When…" | sed 's/^/      /' | tee -a "$REPORT"
  sheetdump "$label-picker"
  if ! whenpick "anytime" "anytime"; then esc; note "    $label VOID: picker never resolved"; return 1; fi
  keyret
  sheetdump "$label-after-commit"
  esc
  return 0
}

########################################################################
# BUILD @ 2026-07-05 — the field shape, minus the roll
########################################################################
beep_reset; beep_mark "build"
note ""
note "################ BUILD (clock 2026-07-05, a Sunday) ################"
note "  P/Q: after-completion - every 2 weeks - --when 2026-07-08 - --start-days-earlier 6"
note "       (deadline 07-14) - --reminder 12:00   [the #699 rule shape]"

for f in P Q; do
  beep_mark "build $f"
  rc=$(cli "b-$f" todo add-repeating "'PROVREM1-$f'" --after-completion --frequency weekly \
        --interval 2 --when 2026-07-08 --start-days-earlier 6 --reminder 12:00 \
        --dangerously-drive-gui --verify-timeout 90000)
  clitail "b-$f" 16
  eval "T_$f=\$(tmplid PROVREM1-$f)"
  eval "note \"  $f template=\$T_$f exit=$rc  \$(rsum \$T_$f)\""
done

# S1..S5 — plain scheduled arrivals with a reminder. Same PROVISIONAL shape
# (BANNER1 class (b): start=2 + startDate, arriving on its own), minus the
# repeat FK — the control that separates "provisional" from "repeating".
for n in 1 2 3 4 5; do
  rc=$(cli "b-S$n" todo add "'PROVREM1-S$n'" --when 2026-07-08 --reminder 12:00)
  eval "S$n=\$(plainid PROVREM1-S$n)"
  eval "note \"  S$n=\$S$n exit=$rc  \$(rsum \$S$n)\""
done
settle 4
snap at-rest-0705
beep_assert build

########################################################################
# ROLL -> 2026-07-08 — the app's own repeat engine spawns the occurrence
########################################################################
note ""
note "################ ROLL -> 2026-07-08 (the cursor day) ################"
if [ "20260708" -ge "$TRIAL_WALL" ]; then note "FATAL: roll refused (trial wall)"; exit 1; fi
kill_things
lab_ssh "$IP" 'sudo date 070812002026 >/dev/null' </dev/null
note "  clock -> $(lab_ssh "$IP" date </dev/null)"
beep_reset; beep_mark "roll"
launch_things
settle 12
OCC_P=$(instid "$T_P"); OCC_Q=$(instid "$T_Q")
note "  P occurrence=$OCC_P"
note "  Q occurrence=$OCC_Q"
note "    P template   $(rsum "$T_P")"
note "    P occurrence $(rsum "$OCC_P")"
note "    Q occurrence $(rsum "$OCC_Q")"
for n in 1 2 3 4 5; do eval "note \"    S$n \$(rsum \$S$n)\""; done
note "    app=$(alive) ips=$(ips_count)"
snap spawned
snapdiff at-rest-0705 spawned "the clock roll + relaunch"
beep_assert roll

########################################################################
# CELL B — what the shipped READ says about the spawned occurrence
########################################################################
note ""
note "########## CELL B — the read model on the spawned occurrence ##########"
rc=$(cli b-show todo show "$OCC_P" --json); clitail b-show 4
rc=$(cli b-today today --json); clitail b-today 4
note "  provisional markers in the show output: $(grep -c 'provisional' "$OUT/cli-b-show.out" || true)"

########################################################################
# CELLS X1-X3 — the three refusals of #699, dry-run (nothing may change)
########################################################################
note ""
note "########## CELLS X1-X3 — the refusals (dry-run) ##########"
snap pre-dry
note "  X1 — --exception against the OCCURRENCE uuid (#699 step 2)"
rc=$(cli x1 todo update "$OCC_P" --when anytime --clear-reminder --exception --dry-run --json); clitail x1 4
note "  X2 — --exception against the TEMPLATE uuid (#699 step 3)"
rc=$(cli x2 todo update "$T_P" --when anytime --clear-reminder --exception --dry-run --json); clitail x2 4
note "  X3 — plain occurrence update, anytime + clear-reminder (#699 step 4)"
rc=$(cli x3 todo update "$OCC_P" --when anytime --clear-reminder --dry-run --json); clitail x3 4
snap post-dry
snapdiff pre-dry post-dry "X1-X3 (dry runs — MUST be empty)"

########################################################################
# CELL G1 — THE GUI ORACLE, plain provisional row: When... > Anytime
#
# The GUI cells run BEFORE any URL cell: a URL error sheet is modal and would
# make the whole GUI arm read as "nothing happened" (see require_no_sheet).
########################################################################
note ""
note "########## CELL G1 — GUI: move a provisional row (reminder 12:00) to Anytime ##########"
beep_reset; beep_mark "g1"
snap pre-g1
gui_anytime "$S5" g1 || note "  G1 is VOID (see above)"
settle 4
snap post-g1
snapdiff pre-g1 post-g1 "G1 (GUI When... > Anytime on a provisional row)"
note "  S5 after G1: $(rsum "$S5")"
note "    app=$(alive) ips=$(ips_count)"
beep_assert g1

########################################################################
# CELL G2 — THE GUI ORACLE, repeating occurrence: When... > Anytime
# Does the exception chooser appear? (REPX1 section 3: it never has on a
# materialized instance — five vectors. This is the sixth, on a PROVISIONAL
# after-completion occurrence, which REPX1/2/3 never had.)
########################################################################
note ""
note "########## CELL G2 — GUI: the SPAWNED occurrence to Anytime ##########"
beep_reset; beep_mark "g2"
snap pre-g2
gui_anytime "$OCC_Q" g2 || note "  G2 is VOID (see above)"
settle 4
snap post-g2
snapdiff pre-g2 post-g2 "G2 (GUI When... > Anytime on the spawned occurrence)"
note "  Q occurrence after G2: $(rsum "$OCC_Q")"
note "  Q template after G2:   $(rsum "$T_Q")"
note "    app=$(alive) ips=$(ips_count)"
beep_assert g2

########################################################################
# CELL X4 — the remediation the CLI itself printed (#699 step 5), FOR REAL
########################################################################
note ""
note "########## CELL X4 — update <occurrence> --when today --clear-reminder ##########"
beep_reset; beep_mark "x4"
snap pre-x4
rc=$(cli x4 todo update "$OCC_P" --when today --clear-reminder --json); clitail x4 6
settle 3
snap post-x4
snapdiff pre-x4 post-x4 "X4"
note "  occurrence after X4: $(rsum "$OCC_P")"
beep_assert x4

########################################################################
# CELL X5 — and then the move the user actually wanted
########################################################################
note ""
note "########## CELL X5 — update <occurrence> --when anytime (reminder now gone) ##########"
beep_reset; beep_mark "x5"
snap pre-x5
rc=$(cli x5 todo update "$OCC_P" --when anytime --json); clitail x5 6
settle 3
snap post-x5
snapdiff pre-x5 post-x5 "X5"
note "  occurrence after X5: $(rsum "$OCC_P")"
rc=$(cli x5-show todo show "$OCC_P" --json); clitail x5-show 4
beep_assert x5

########################################################################
# CELL X6 — one call, reminder STILL SET: does our anytime write verify?
#
# The shipped reminder assertion demands `reminderTime IS NULL` after ANY
# when-write whose `when` is not schedulable (update-fields.ts
# effectiveReminder). Nothing ever measured that for `anytime`. S4 still has
# its 12:00 reminder, so this cell asks our own engine the question end to end.
########################################################################
note ""
note "########## CELL X6 — update S4 --when anytime with a LIVE reminder ##########"
beep_reset; beep_mark "x6"
snap pre-x6
rc=$(cli x6 todo update "$S4" --when anytime --json); clitail x6 8
settle 3
snap post-x6
snapdiff pre-x6 post-x6 "X6"
note "  S4 after X6: $(rsum "$S4")"
beep_assert x6

########################################################################
# CELL X7 — the EVENING leg of the same guard remediation
#
# H-REMINDER-SCOPE offers `today|evening` for a reminder clear, so the evening
# half of its own remediation gets the same cell as the today half (X4). S3 is
# still provisional with its 12:00 reminder.
########################################################################
note ""
note "########## CELL X7 — update S3 --when evening --clear-reminder ##########"
beep_reset; beep_mark "x7"
snap pre-x7
rc=$(cli x7 todo update "$S3" --when evening --clear-reminder --json); clitail x7 8
settle 3
snap post-x7
snapdiff pre-x7 post-x7 "X7"
note "  S3 after X7: $(rsum "$S3")"
beep_assert x7

########################################################################
# CELLS U1-U3 — the APP's own URL surface on a provisional row
# (the oracle for what our expected delta should say)
########################################################################
note ""
note "########## CELLS U1-U3 — raw URL writes on a provisional row ##########"
# The URL-scheme token lives in the DATABASE, not in the app's defaults
# (`TMSettings.uriSchemeAuthenticationToken` — the column src/write/pipeline.ts
# reads). The first arm of this campaign asked `defaults` for it, got an empty
# string, and every U cell came back "no field changed" — an unauthorized
# `update?` is a silent no-op, which is indistinguishable from the app declining
# the write. Read it where the engine reads it.
TOKEN=$(gq 'SELECT uriSchemeAuthenticationToken FROM TMSettings')
note "  auth-token len ${#TOKEN}"
[ -n "$TOKEN" ] || note "  WARN: no auth token — the U cells below cannot write and prove NOTHING"
for cell in "U1:S1:when=today" "U2:S2:when=anytime" "U3:S3:when=evening"; do
  IFS=: read -r tag fix q <<<"$cell"
  eval "uid=\$$fix"
  note "  $tag — update?id=<$fix>&$q   (provisional, reminder 12:00)"
  snap "pre-$tag"
  url "$tag" "update?id=$uid&auth-token=$TOKEN&$q"
  settle 3
  snap "post-$tag"
  snapdiff "pre-$tag" "post-$tag" "$tag ($q)"
  note "    $fix after $tag: $(rsum "$uid")"
done
note "    app=$(alive) ips=$(ips_count)"

########################################################################
# FINAL — everything, one place
########################################################################
note ""
note "################ FINAL STATE ################"
note "  P template   $(rsum "$T_P")"
note "  P occurrence $(rsum "$OCC_P")"
note "  Q template   $(rsum "$T_Q")"
note "  Q occurrence $(rsum "$OCC_Q")"
for n in 1 2 3 4 5; do eval "note \"  S$n \$(rsum \$S$n)\""; done
note "  app=$(alive) ips=$(ips_count)"
snap final
note ""
note "==== DONE ($ARM) — report: $REPORT ===="
