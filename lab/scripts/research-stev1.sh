#!/bin/bash
# STEV1 — the STALE EVENING law: how the app renders, ranks, and (never) rewrites
# a `startBucket=1` row whose `startDate` has gone past, and what a Today-scope
# reorder of that row has to write. Write-up: docs/lab/stev1-stale-evening.md.
#
# Context (#657): a stale evening to-do is refused by BOTH reorder scopes —
# `--in today` calls it an evening-bucket item (O03), `--in evening` calls it a
# STALE evening item and says to re-schedule it first. The read side already
# treats it as Today-proper (mappers `todayMarkers` gates evening on
# `startDate == today`), so the view, the membership check and the reorder
# scopes disagree. SIT3 REMSTALE established the PRESENTATION half (the GUI
# collapses the row to plain Today and never cleans the bytes); this campaign
# measures the three things the fix needs and REMSTALE did not cover:
#
#   1  RENDERING — where the row actually sits in the Today window (daytime
#      section vs This Evening; does the Evening header appear at all), plus the
#      CLI's own rendering of the same row.
#   2  NORMALIZATION — does the app EVER rewrite the stale row (startBucket,
#      startDate, todayIndex, todayIndexReferenceDate) on a view visit, a
#      selection, or a relaunch? Full-row diffs.
#   3  RANK + WRITE SHAPE — where the stale row sorts among the daytime rows,
#      and what a reorder must write for the app to render a new order: the
#      one-leg `when=today`, or the shipped today bounce (when=evening ->
#      when=today).
#   4  REGRESSION CONTROLS — a CURRENT-day evening item must keep today's
#      behavior exactly, and the §9n reminder hazard must not regress.
#   5  POST-FIX — the patched build's `things reorder <stale> --in today
#      --start` end to end (run with REUSE=1 after shipping the fix).
#
# METHOD: ONE disposable clone `stev1-lab` of things-lab-golden-v4 (Things 3.23
# build 32300036; the golden is NEVER booted). Airgapped (default route
# deleted). Synthetic STEV1-* fixtures only. Ground truth = read-only guest
# SQLite + the AX tree; `open` exit 0 and CLI exit 0 both prove nothing alone.
#
# THE CLOCK. A stale evening row CANNOT be minted headlessly: TIMEZ-NODATE says
# no surface writes `startBucket=1` on any day but the app's current one, so the
# fixture is seeded on day D and the guest clock is advanced ONE day to D+1 —
# the ODDS1-D2 recipe (`07-05 -> 07-08`), bounded here to a single day. Base pin
# 2026-07-05, roll to 2026-07-06: twelve days short of golden-v4's sticky trial
# wall (2026-07-18, REPX3 §5), which `setclock` refuses to cross.
#
# Usage:  bash lab/scripts/research-stev1.sh [cell...]     # default: 1 2 3 4
#         KEEP=1 bash lab/scripts/research-stev1.sh        # hold the clone
#         REUSE=1 KEEP=1 bash lab/scripts/research-stev1.sh 5   # post-fix cell
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="stev1-lab"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
CELLS="${*:-1 2 3 4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT" "$OUT/ax" "$OUT/snap"
REPORT="$OUT/report.txt"
REUSE="${REUSE:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[stev1] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"
export THINGS_LAB_BEEPS_OK=1

case "$VM" in things-lab-golden-*) echo "refusing to touch a golden" >&2; exit 1 ;; esac

note "cells: $CELLS · golden: $GOLDEN · reuse=$REUSE"
if [ "$REUSE" = "1" ]; then
  IP=$(tart ip "$VM" 2>/dev/null) || { note "FATAL: $VM is not running"; exit 1; }
  [ -n "$IP" ] || { note "FATAL: no IP for $VM"; exit 1; }
  note "re-attached to $VM at $IP"
else
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 360) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
fi
cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — $VM left running at $IP"; return; fi
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done"
}
trap cleanup EXIT

if [ "$REUSE" != "1" ]; then
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  # The clock is pinned BEFORE Things is ever launched (harness.md).
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
fi
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null

# ---- guest helpers ---------------------------------------------------------
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-noheader -list); if [ "$1" = "-t" ]; then FMT=(-header -column); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

# FULL-row dump for one title pattern (the diff substrate — every column).
lab_ssh "$IP" 'cat > ~/labh/rowsnap.py' <<'EOF'
import sys, sqlite3, glob, hashlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True); c.row_factory=sqlite3.Row
DATECOLS={'startDate','deadline','stopDate','rt1_nextInstanceStartDate','rt1_instanceCreationStartDate','todayIndexReferenceDate'}
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%s(%04d-%02d-%02d)"%(v,y,m,d) if 1<y<5000 else v
rows=c.execute("SELECT * FROM TMTask WHERE title LIKE ? ORDER BY title, uuid",(sys.argv[1],)).fetchall()
for r in rows:
    for k in r.keys():
        v=r[k]
        if isinstance(v,bytes): v='blob:sha256:'+hashlib.sha256(v).hexdigest()[:16]+':len'+str(len(v))
        elif k in DATECOLS: v=dpk(v)
        print("%s\t%s\t%s"%(r['title'],k,v))
EOF

# The Today axis in the READER's own comparator order (src/read/predicates.ts
# todayOrderBy): startBucket ASC, COALESCE(tiRef,startDate,deadline) DESC,
# todayIndex ASC, uuid ASC. `nobucket` drops the startBucket key, to show what
# the order would be if the stale row ranked as a plain Today member.
lab_ssh "$IP" 'cat > ~/labh/today.py' <<'EOF'
import sys, sqlite3, glob
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v is None or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
pat = sys.argv[1] if len(sys.argv)>1 else '%'
mode = sys.argv[2] if len(sys.argv)>2 else 'bucket'
order = ('startBucket ASC, ' if mode=='bucket' else '') + \
        'COALESCE(todayIndexReferenceDate,startDate,deadline) DESC, todayIndex ASC, uuid ASC'
rows=c.execute("""SELECT uuid,title,type,start,startBucket,startDate,todayIndex,todayIndexReferenceDate,reminderTime
  FROM TMTask WHERE trashed=0 AND status=0 AND startDate IS NOT NULL AND start IN (1,2)
  AND title LIKE ? ORDER BY """+order,(pat,)).fetchall()
for i,r in enumerate(rows):
    print("%2d. %-9s %-24s kind=%s bkt=%s sd=%-10s tIdx=%-8s tRef=%-10s rem=%s" % (
        i+1, r[0][:8], (r[1] or '')[:24], 'P' if r[2]==1 else 'T', r[4], dpk(r[5]), r[6], dpk(r[7]), r[8]))
EOF

# The AX oracle — `dump` (whole standard window, in tree order) and `rows` (every
# AXTableRow AND every AXStaticText in the window, sorted by y: a section HEADER
# is not an AXTableRow, so a row-only census cannot see it — URLEN1's
# blind-oracle law applied to sections).
lab_ssh "$IP" 'cat > ~/labh/hoax.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]) }
function sv(el,name){ var v=attr(el,name); try { return v? (''+v.js) : '' } catch(e){ return '' } }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function flat(el,acc,d){ acc.push(el); if(d>18) return acc; var ch=kids(el); for(var i=0;i<ch.length;i++) flat(ch[i],acc,d+1); return acc }
function frame(el){ var p=attr(el,'AXPosition'), z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=String(pd).match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=String(zd).match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null }
function appEl(){ return $.AXUIElementCreateApplication(pidOf('Things3')) }
function line(el,d,ix){
  var p=['['+ix+'] role='+sv(el,'AXRole')];
  var s=sv(el,'AXSubrole'); if(s) p.push('sub='+s);
  var t=sv(el,'AXTitle'); if(t) p.push('ttl='+t);
  var de=sv(el,'AXDescription'); if(de) p.push('desc='+de);
  var v=sv(el,'AXValue'); if(v) p.push('val='+String(v).slice(0,120));
  var id=sv(el,'AXIdentifier'); if(id) p.push('id='+id);
  var f=frame(el); if(f) p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']');
  return Array(d+1).join('  ')+p.join(' | ') }
function walk(el,d,acc,ix){ acc.push(line(el,d,ix)); if(d>16) return acc; var ch=kids(el); for(var i=0;i<ch.length;i++) walk(ch[i],d+1,acc,i+1); return acc }
function dumpAll(){
  var app=appEl(); var ws=kids(app); var acc=[];
  for(var i=0;i<ws.length;i++){
    var w=ws[i], f=frame(w), sub=sv(w,'AXSubrole'), r=sv(w,'AXRole');
    if(r==='AXMenuBar') continue;
    acc.push('=== CHILD '+(i+1)+' role='+r+' sub='+sub+' ttl='+sv(w,'AXTitle')+(f?(' @['+f.x+','+f.y+' '+f.w+'x'+f.h+']'):'')+' ===');
    if(sub==='AXStandardWindow') walk(w,0,acc,i+1);
  }
  if(!acc.length) acc.push('(nothing)');
  return acc.join('\n') }
function rowCensus(){
  var app=appEl(); var all=[]; flat(app,all,0);
  var out=[];
  for(var i=0;i<all.length;i++){
    var e=all[i], sub=sv(e,'AXSubrole'), role=sv(e,'AXRole');
    var isRow = sub==='AXTableRow';
    var isText = role==='AXStaticText';
    if(!isRow && !isText) continue;
    var f=frame(e); if(!f) continue;
    var texts=[];
    if(isRow){ var s=[]; flat(e,s,0);
      for(var j=0;j<s.length;j++){ var d=sv(s[j],'AXDescription'), v=sv(s[j],'AXValue'), t=sv(s[j],'AXTitle');
        if(d) texts.push('d:'+d); if(v) texts.push('v:'+String(v).slice(0,60)); if(t) texts.push('t:'+t) } }
    else { texts.push('TEXT:'+sv(e,'AXValue')) }
    out.push({y:f.y, s:'y='+f.y+' '+(isRow?'ROW':'TXT')+' | '+texts.join(' ~ ').slice(0,220)})
  }
  out.sort(function(a,b){ return a.y-b.y });
  var acc=['entries='+out.length];
  for(var k=0;k<out.length;k++) acc.push('  ['+(k+1)+'] '+out[k].s);
  return acc.join('\n') }
function run(argv){
  var cmd=argv[0];
  if(cmd==='dump') return dumpAll();
  if(cmd==='rows') return rowCensus();
  return 'UNKNOWN_CMD' }
EOF

lab_ssh "$IP" 'cat > ~/labh/ourl.sh && chmod +x ~/labh/ourl.sh' <<'EOF'
#!/bin/bash
u=$(printf %s "$1" | base64 --decode)
open -g "$u"; echo "EXIT=$?"
EOF
note "helpers installed"

# ---- ship the CLI under test (node + dist + commander) ---------------------
[ -f dist/cli/main.js ] || { note "FATAL: dist missing — run npm run build"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { local a c; for a in 1 2 3 4 5; do sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; c=$?; [ "$c" -eq 0 ] && return 0; sleep 3; done; return "$c"; }
lab_ssh "$IP" true </dev/null; sleep 2
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "FATAL node scp"; exit 1; }
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "FATAL commander scp"; exit 1; }
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "shipped dist"

# ---- common verbs ----------------------------------------------------------
G()    { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
AX()   { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/hoax.js $*" </dev/null 2>&1; }
gq()   { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
snap() { lab_ssh "$IP" "python3 ~/labh/rowsnap.py 'STEV1-$STAMP%'" </dev/null > "$OUT/snap/$1.tsv"; }
axis() { lab_ssh "$IP" "python3 ~/labh/today.py 'STEV1-$STAMP%' ${1:-bucket}" </dev/null; }
url()  { lab_ssh "$IP" "~/labh/ourl.sh $(printf %s "$1" | base64)" </dev/null; sleep 4; }
uuidof() { gq "SELECT uuid FROM TMTask WHERE title='$1'"; }
quitapp()  { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 4; true' </dev/null; }
relaunch() { lab_ssh "$IP" 'open -a Things3; sleep 20; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; true' </dev/null; }
showtoday() { lab_ssh "$IP" 'open -g "things:///show?id=today"; sleep 4; true' </dev/null; }
diffsnap() { # diffsnap <a> <b> — the CHANGED cells only
  local d
  d=$(diff <(sort "$OUT/snap/$1.tsv") <(sort "$OUT/snap/$2.tsv") | grep -E '^[<>]')
  [ -n "$d" ] && echo "$d" || echo "(byte-identical)"
}

# THE TRIAL WALL (REPX3 §5) — golden-v4's Things expires 2026-07-18, stickily.
TRIAL_WALL="20260718"
setclock() { # setclock MMDDhhmmYYYY — quits the app first, relaunches after
  local d="$1" ymd="${1:8:4}${1:0:2}${1:2:2}"
  if [ "$ymd" -ge "$TRIAL_WALL" ]; then
    note "    REFUSED clock roll to $ymd — golden-v4's trial wall is $TRIAL_WALL (REPX3 §5)"
    return 1
  fi
  quitapp
  lab_ssh "$IP" "sudo date $d >/dev/null; date" </dev/null | sed 's/^/    clock now: /' | tee -a "$REPORT"
  relaunch
}

STAMPFILE="$OUT/stamp"
if [ "$REUSE" = "1" ] && [ -f "$STAMPFILE" ]; then STAMP=$(cat "$STAMPFILE"); else STAMP=$(date +%H%M%S); echo "$STAMP" > "$STAMPFILE"; fi
note "fixture stamp: $STAMP"

if [ "$REUSE" != "1" ]; then
  lab_ssh "$IP" 'open -a Things3; sleep 18; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null
fi
VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
BLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
note "env: Things $VER ($BLD) · dbv $(gq 'SELECT databaseVersion FROM Meta') · clock $(lab_ssh "$IP" date </dev/null)"

has() { case " $CELLS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# =========================================================================== #
# SEED — day D = 2026-07-05: the rows that will go stale.
# =========================================================================== #
if [ "$REUSE" != "1" ]; then
  note ""
  note "=== SEED (clock 2026-07-05) — the rows that will go stale ==============="
  # E1 carries a reminder: the §9n control (a stale reminder byte must not be
  # resurrected, and must not fail a later reorder's verification).
  note "  add E1 (evening + 18:00 reminder): $(G "todo add 'STEV1-$STAMP-E1-eve-rem' --when evening --reminder 18:00" | tail -3 | tr '\n' ' ')"
  note "  add E2 (evening, no reminder):     $(G "todo add 'STEV1-$STAMP-E2-eve' --when evening" | tail -3 | tr '\n' ' ')"
  note "  add E3 (evening, no reminder):     $(G "todo add 'STEV1-$STAMP-E3-eve' --when evening" | tail -3 | tr '\n' ' ')"
  note "  add O1 (daytime today):            $(G "todo add 'STEV1-$STAMP-O1-day' --when today" | tail -3 | tr '\n' ' ')"
  snap seed-D
  note "  axis on day D:"
  axis | sed 's/^/    /' | tee -a "$REPORT"

  note ""
  note "  --- roll the clock ONE day: 2026-07-05 -> 2026-07-06 (ODDS1-D2 recipe) ---"
  setclock 070612002026 || { note "FATAL: clock roll refused"; exit 1; }
  snap post-roll-nolaunch
  note "  full-row diff across the roll + relaunch (BEFORE any Today visit):"
  diffsnap seed-D post-roll-nolaunch | sed 's/^/    /' | tee -a "$REPORT"

  note ""
  note "  --- seed day D+1 (2026-07-06) fixtures ---"
  note "  add D1: $(G "todo add 'STEV1-$STAMP-D1-day' --when today" | tail -3 | tr '\n' ' ')"
  note "  add D2: $(G "todo add 'STEV1-$STAMP-D2-day' --when today" | tail -3 | tr '\n' ' ')"
  note "  add D3: $(G "todo add 'STEV1-$STAMP-D3-day' --when today" | tail -3 | tr '\n' ' ')"
  note "  add C1 (CURRENT-day evening — the regression control): $(G "todo add 'STEV1-$STAMP-C1-eve-now' --when evening" | tail -3 | tr '\n' ' ')"
  snap seeded-D1
fi

E1=$(uuidof "STEV1-$STAMP-E1-eve-rem"); E2=$(uuidof "STEV1-$STAMP-E2-eve"); E3=$(uuidof "STEV1-$STAMP-E3-eve")
O1=$(uuidof "STEV1-$STAMP-O1-day");     C1=$(uuidof "STEV1-$STAMP-C1-eve-now")
D1=$(uuidof "STEV1-$STAMP-D1-day");     D2=$(uuidof "STEV1-$STAMP-D2-day"); D3=$(uuidof "STEV1-$STAMP-D3-day")
note "uuids: E1=${E1:0:8} E2=${E2:0:8} E3=${E3:0:8} O1=${O1:0:8} C1=${C1:0:8} D1=${D1:0:8} D2=${D2:0:8} D3=${D3:0:8}"

# =========================================================================== #
# CELL 1 — the rendering law
# =========================================================================== #
if has 1; then
  note ""
  note "=== CELL 1 — where does a STALE evening row RENDER? ====================="
  showtoday
  AX dump > "$OUT/ax/today-dump.txt" 2>&1
  AX rows > "$OUT/ax/today-rows.txt" 2>&1
  note "  'This Evening' occurrences in the AX tree: $(grep -c 'This Evening' "$OUT/ax/today-dump.txt")"
  note "  the Today window, rows + static text in VISUAL (y) order:"
  grep -E "STEV1-$STAMP|This Evening" "$OUT/ax/today-rows.txt" | head -30 | sed 's/^/    /' | tee -a "$REPORT"
  note ""
  note "  the DB axis (reader comparator, startBucket first):"
  axis | sed 's/^/    /' | tee -a "$REPORT"
  note "  the DB axis WITHOUT the startBucket key (stale row ranked as a plain Today member):"
  axis nobucket | sed 's/^/    /' | tee -a "$REPORT"
  note ""
  note "  the CLI's own rendering (things today):"
  G "today" | sed 's/^/    /' | tee -a "$REPORT"
  note "  the CLI wire (things today --json), STEV1 rows only:"
  lab_ssh "$IP" "$CLI today --json" </dev/null 2>&1 | python3 -c '
import sys,json
try: d=json.load(sys.stdin)
except Exception as e: print("    (json parse failed: %s)"%e); raise SystemExit
def rows(o,sect):
    if isinstance(o,dict):
        t=o.get("title","")
        if isinstance(t,str) and t.startswith("STEV1"):
            print("    %-26s bucket=%-8s evening=%s startDate=%s reminder=%s" % (t, sect, o.get("evening"), o.get("startDate"), o.get("reminder")))
        for k,v in o.items():
            rows(v, k if k in ("today","evening") else sect)
    elif isinstance(o,list):
        for v in o: rows(v,sect)
rows(d,"?")
' | tee -a "$REPORT"
fi

# =========================================================================== #
# CELL 2 — does the app EVER normalize the stale row?
# =========================================================================== #
if has 2; then
  note ""
  note "=== CELL 2 — does the app REWRITE the stale row? ========================"
  snap n0
  note "  (a) after a Today-view VISIT:"
  showtoday; lab_ssh "$IP" 'sleep 3' </dev/null; snap n1
  diffsnap n0 n1 | sed 's/^/    /' | tee -a "$REPORT"
  note "  (b) after a SHOW of the stale row itself (selects + scrolls it into view):"
  lab_ssh "$IP" "open -g 'things:///show?id=$E1'; sleep 4; true" </dev/null
  snap n2; diffsnap n1 n2 | sed 's/^/    /' | tee -a "$REPORT"
  note "  (c) after a QUIT + RELAUNCH:"
  quitapp; relaunch; showtoday
  snap n3; diffsnap n2 n3 | sed 's/^/    /' | tee -a "$REPORT"
  note "  (d) the STEV1 rows' key columns now:"
  gq "SELECT title||' bkt='||startBucket||' sd='||startDate||' tIdx='||todayIndex||' tRef='||COALESCE(todayIndexReferenceDate,'NULL')||' rem='||COALESCE(reminderTime,'NULL') FROM TMTask WHERE title LIKE 'STEV1-$STAMP%' ORDER BY title" | sed 's/^/    /' | tee -a "$REPORT"
fi

# =========================================================================== #
# CELL 3 — rank semantics + the write shape a stale-row reorder needs
# =========================================================================== #
if has 3; then
  note ""
  note "=== CELL 3 — rank + write shape ========================================"
  note "  BASELINE axis:"
  axis | sed 's/^/    /' | tee -a "$REPORT"
  showtoday; AX rows > "$OUT/ax/c3-before.txt" 2>&1
  note "  BASELINE visual order:"
  grep -E "STEV1-$STAMP|This Evening" "$OUT/ax/c3-before.txt" | sed 's/^/    /' | tee -a "$REPORT"
  snap c3-0

  note ""
  note "  --- shape A: the ONE-LEG when=today on stale E2 ---"
  url "things:///update?auth-token=$TOKEN&id=$E2&when=today"
  snap c3-a
  note "  E2 row diff:"
  diffsnap c3-0 c3-a | grep -E "E2-eve" | sed 's/^/    /' | tee -a "$REPORT" || note "    (no E2 change)"
  note "  axis after shape A:"
  axis | sed 's/^/    /' | tee -a "$REPORT"
  showtoday; AX rows > "$OUT/ax/c3-a.txt" 2>&1
  note "  visual order after shape A:"
  grep -E "STEV1-$STAMP|This Evening" "$OUT/ax/c3-a.txt" | sed 's/^/    /' | tee -a "$REPORT"

  note ""
  note "  --- shape B: the shipped TODAY BOUNCE (when=evening -> when=today) on stale E3 ---"
  url "things:///update?auth-token=$TOKEN&id=$E3&when=evening"
  snap c3-b1
  note "  E3 after the AWAY leg (when=evening):"
  diffsnap c3-a c3-b1 | grep -E "E3-eve" | sed 's/^/    /' | tee -a "$REPORT" || note "    (no E3 change)"
  url "things:///update?auth-token=$TOKEN&id=$E3&when=today"
  snap c3-b2
  note "  E3 after the BACK leg (when=today):"
  diffsnap c3-b1 c3-b2 | grep -E "E3-eve" | sed 's/^/    /' | tee -a "$REPORT" || note "    (no E3 change)"
  note "  axis after shape B:"
  axis | sed 's/^/    /' | tee -a "$REPORT"
  showtoday; AX rows > "$OUT/ax/c3-b.txt" 2>&1
  note "  visual order after shape B:"
  grep -E "STEV1-$STAMP|This Evening" "$OUT/ax/c3-b.txt" | sed 's/^/    /' | tee -a "$REPORT"

  note ""
  note "  --- control: the same one-leg when=today on the OVERDUE daytime row O1 ---"
  snap c3-c0
  url "things:///update?auth-token=$TOKEN&id=$O1&when=today"
  snap c3-c1
  diffsnap c3-c0 c3-c1 | grep -E "O1-day" | sed 's/^/    /' | tee -a "$REPORT" || note "    (no O1 change)"
  note "  axis after the O1 control:"
  axis | sed 's/^/    /' | tee -a "$REPORT"
fi

# =========================================================================== #
# CELL 4 — regression controls (current-day evening; the §9n reminder)
# =========================================================================== #
if has 4; then
  note ""
  note "=== CELL 4 — regression controls ======================================="
  note "  C1 is a CURRENT-day evening item (startDate == today, startBucket=1):"
  gq "SELECT title||' bkt='||startBucket||' sd='||startDate||' tIdx='||todayIndex FROM TMTask WHERE uuid='$C1'" | sed 's/^/    /' | tee -a "$REPORT"
  note "  shipped CLI, evening scope on C1 (must WORK):"
  G "reorder $C1 --in evening --start --json" | tail -8 | sed 's/^/    /' | tee -a "$REPORT"
  note "  shipped CLI, today scope on C1 (must REFUSE — a same-day evening member):"
  G "reorder $C1 --in today --start --json" | tail -8 | sed 's/^/    /' | tee -a "$REPORT"
  note ""
  note "  THE BUG (#657) on the shipped build — stale E1, both scopes:"
  note "  today scope:"
  G "reorder $E1 --in today --start --json" | tail -8 | sed 's/^/    /' | tee -a "$REPORT"
  note "  evening scope:"
  G "reorder $E1 --in evening --start --json" | tail -8 | sed 's/^/    /' | tee -a "$REPORT"
  note ""
  note "  §9n control — E1's raw reminderTime byte (stale, must still be present):"
  gq "SELECT title||' rem='||COALESCE(reminderTime,'NULL')||' sd='||startDate FROM TMTask WHERE uuid='$E1'" | sed 's/^/    /' | tee -a "$REPORT"
  note "  and what the CLI reports for it (live-gated — expect null):"
  G "show $E1 --json" | sed 's/^/    /' | tail -20 | tee -a "$REPORT"
fi

# =========================================================================== #
# CELL 5 — POST-FIX end to end (run with REUSE=1 after re-shipping dist)
# =========================================================================== #
if has 5; then
  note ""
  note "=== CELL 5 — POST-FIX: the patched build on the stale row =============="
  snap c5-0
  note "  axis before:"
  axis | sed 's/^/    /' | tee -a "$REPORT"
  note "  patched CLI, TODAY scope on stale E1 --start (must SUCCEED):"
  G "reorder $E1 --in today --start --json" | tail -12 | sed 's/^/    /' | tee -a "$REPORT"
  snap c5-1
  note "  E1 full-row diff across the reorder:"
  diffsnap c5-0 c5-1 | grep -E "E1-eve" | sed 's/^/    /' | tee -a "$REPORT" || note "    (no E1 change)"
  note "  axis after:"
  axis | sed 's/^/    /' | tee -a "$REPORT"
  showtoday; AX rows > "$OUT/ax/c5-after.txt" 2>&1
  note "  visual order after:"
  grep -E "STEV1-$STAMP|This Evening" "$OUT/ax/c5-after.txt" | sed 's/^/    /' | tee -a "$REPORT"
  note "  the CLI's Today rendering after:"
  G "today" | sed 's/^/    /' | tee -a "$REPORT"
  note ""
  note "  patched CLI, EVENING scope on stale E1 (must refuse, pointing at --in today):"
  G "reorder $E1 --in evening --start --json" | tail -8 | sed 's/^/    /' | tee -a "$REPORT"
  note "  patched CLI, EVENING scope on current-day C1 (must still WORK):"
  G "reorder $C1 --in evening --start --json" | tail -8 | sed 's/^/    /' | tee -a "$REPORT"
  note "  patched CLI, TODAY scope on current-day C1 (must still REFUSE):"
  G "reorder $C1 --in today --start --json" | tail -8 | sed 's/^/    /' | tee -a "$REPORT"
  note "  §9n: E1's reminderTime byte after the reorder:"
  gq "SELECT title||' rem='||COALESCE(reminderTime,'NULL')||' sd='||startDate||' bkt='||startBucket FROM TMTask WHERE uuid='$E1'" | sed 's/^/    /' | tee -a "$REPORT"
fi

# =========================================================================== #
# CELL 6 — the OVERDUE bucket-0 control for the same two-leg bounce
# =========================================================================== #
if has 6; then
  note ""
  note "=== CELL 6 — the two-leg today bounce on an OVERDUE bucket-0 row ========"
  note "  (E2 was de-eveninged in cell 3 shape A and still carries its past 07-05 date)"
  gq "SELECT title||' bkt='||startBucket||' sd='||startDate||' tIdx='||todayIndex||' tRef='||COALESCE(todayIndexReferenceDate,'NULL') FROM TMTask WHERE uuid='$E2'" | sed 's/^/    /' | tee -a "$REPORT"
  snap c6-0
  url "things:///update?auth-token=$TOKEN&id=$E2&when=evening"
  snap c6-1
  note "  after the AWAY leg (when=evening):"
  diffsnap c6-0 c6-1 | grep -E "E2-eve" | sed 's/^/    /' | tee -a "$REPORT" || note "    (no change)"
  url "things:///update?auth-token=$TOKEN&id=$E2&when=today"
  snap c6-2
  note "  after the BACK leg (when=today):"
  diffsnap c6-1 c6-2 | grep -E "E2-eve" | sed 's/^/    /' | tee -a "$REPORT" || note "    (no change)"
  note "  axis after:"
  axis | sed 's/^/    /' | tee -a "$REPORT"
fi

note ""
note "DONE — report: $REPORT"
