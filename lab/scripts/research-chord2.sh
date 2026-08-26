#!/bin/bash
# CHORD2 — the full law matrix for the ⌘-arrow reorder chords HEADORD1 found.
#
# BACKGROUND. HEADORD1 (docs/lab/headord1-heading-order.md) discovered that
# Things 3.23 still ships a first-class reordering affordance with no menu
# representation at all: ⌘↑ / ⌘↓ move the selected row ±1 slot and ⌘⌥↑ / ⌘⌥↓
# move it to the top / bottom. It measured the law for HEADINGS (single-row
# sparse-`index` rewrite, no sibling renumber, children follow the intact
# heading FK, a chord with nowhere to go is declined with one alert beep and
# zero delta), proved System Events keystrokes land frontmost-only while
# `CGEventPostToPid` lands with Things BACKGROUNDED, and noticed in passing that
# TO-DOS take the same chord family and that a headed child crosses buckets at
# its heading boundary.
#
# The maintainer has endorsed the chord vector and asked for the full matrix
# before anything is wired. CELLS, in the order they gate the build track:
#
#   1  bg        BACKGROUNDED END-TO-END — AX selection + CGEventPostToPid with
#                Things NOT frontmost, asserting BOTH the index delta AND zero
#                focus-steal signals on the disruption monitor. Heading + to-do.
#                This is the "are you sure?" cell; it runs first.
#   2  multi     MULTI-SELECTION semantics (contiguous / non-contiguous / mixed
#                heading+to-do / ⌘⌥↑), full 41-column row diffs.
#   3  bounds    BOUNDARY laws per row kind — first-heading top, project top and
#                bottom, ⌘⌥↑ on a headed child, loose row beside a heading block.
#   4  views     WHICH COLUMN per view (index / todayIndex) and view-scoped side
#                effects: project · Anytime · Someday · Today · Upcoming
#                day-group (reorder or RESCHEDULE?) · tag-FILTERED project.
#   5  tmpl      REPEATING TEMPLATES — the declared immovable objects (§9e
#                template order, ORD-19's day-block loss). Does a chord move one?
#   6  side      SIDE-EFFECT SWEEP — umd per chord, checklist/child integrity,
#                and the decline-beep 1:1 reliability.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (the trial wall is
# 2026-07-18 — docs/lab/harness.md). Fixtures fully synthetic. Clone destroyed on
# teardown. PROBE ONLY — no op is shipped from this campaign.
#
# Beeps: the sentinel runs per cell with THINGS_LAB_BEEPS_OK=1 (the probe opt-out
# — accounting, never a mute); every cell reports its count. A decline beep here
# is a MEASUREMENT, not a failure.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-chord2-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax" "$OUT/snap"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — well inside the trial wall (2026-07-18)
note() { echo "[chord2] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

# CGEvent modifier flag masks
FCMD=1048576        # ⌘
FCMDOPT=1572864     # ⌘⌥
KUP=126
KDOWN=125

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
show() { lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 3" </dev/null; }
front() { axq 'tell application "System Events" to return name of first process whose frontmost is true'; }
tofinder() { lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 3' </dev/null; }
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }

# ---- the beep sentinel (probe opt-out: counted, never failing) --------------
bs()    { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh $*" </dev/null 2>&1; }
bmark() { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }

# ---- the disruption monitor slice ------------------------------------------
# The golden runs the disruption-monitor LaunchAgent, which appends NDJSON to
# ~/things-lab/events.ndjson. mon_mark records the line count; mon_slice prints
# everything since, and mon_verdict classifies the tier the harness would compute.
mon_mark()  { MON_AT=$(lab_ssh "$IP" 'wc -l < ~/things-lab/events.ndjson 2>/dev/null || echo 0' </dev/null | tr -d ' '); }
mon_slice() {
  local n="${MON_AT:-0}"
  lab_ssh "$IP" "tail -n +$((n+1)) ~/things-lab/events.ndjson 2>/dev/null" </dev/null
}
mon_verdict() {
  local sl nl steal wins launch
  sl=$(mon_slice)
  nl=$(printf '%s' "$sl" | grep -c . )
  note "    monitor slice ($nl event(s)) for $1:"
  if [ "$nl" -gt 0 ]; then printf '%s\n' "$sl" | sed 's/^/      /' | tee -a "$REPORT"; fi
  steal=$(printf '%s' "$sl" | grep -c '"kind":"frontmost"\|"kind":"activate"')
  wins=$(printf '%s' "$sl" | grep -c '"kind":"window-new"\|"kind":"title-change"')
  launch=$(printf '%s' "$sl" | grep -c '"kind":"launch"')
  if [ "$steal" -eq 0 ] && [ "$wins" -eq 0 ]; then
    note "    DISRUPTION: tier $([ "$launch" -gt 0 ] && echo 1 || echo 0) — NO focus steal, NO new window  *** CLEAN ***"
  else
    note "    *** DISRUPTION: $steal focus/activate signal(s), $wins window signal(s) — NOT clean ***"
  fi
}

# ---- the DB oracles ---------------------------------------------------------
horder() { gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$1' AND type=2 AND trashed=0 ORDER BY \"index\" ASC)"; }
torder() { gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$1' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" ASC)"; }
korder() { gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE heading='$1' AND trashed=0 ORDER BY \"index\" ASC)"; }
pdump()  { gt "SELECT CASE type WHEN 2 THEN 'HEAD' ELSE 'todo' END AS kind, title, substr(uuid,1,8) AS uuid8, \"index\" AS idx, todayIndex AS tidx, COALESCE(substr(project,1,8),'-') AS proj, COALESCE(substr(heading,1,8),'-') AS head, start, startDate AS sd FROM TMTask WHERE trashed=0 AND (project='$1' OR heading IN (SELECT uuid FROM TMTask WHERE project='$1' AND type=2)) ORDER BY (heading IS NOT NULL), \"index\" ASC"; }
vdump()  { gt "SELECT title, substr(uuid,1,8) AS uuid8, \"index\" AS idx, todayIndex AS tidx, start, startDate AS sd, todayIndexReferenceDate AS tref, userModificationDate AS umd FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY todayIndex, \"index\""; }
vorder() { gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY $2 ASC)"; }
pid()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND trashed=0 LIMIT 1"; }
hid()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=2 AND trashed=0 LIMIT 1"; }

# ---- the modifier-aware row clicker ----------------------------------------
# REPX1 §1.2's CGEvent-at-the-AX-frame click, plus the CNCAC1 off-screen guard,
# plus THE FLAGS FIX: a synthesized CGEvent inherits the CURRENT global modifier
# state unless the flags are set EXPLICITLY, so a "plain" click issued after a
# shift-click is still a shift-click. The first pass of cell 2 was contaminated
# by exactly that (§2 rig note), so `CGEventSetFlags` is now called on EVERY
# event, zero included.
ship_clickrow() {
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
function scrollRect(el){ var p=el; for(var i=0;i<20;i++){ var o=Ref(); if($.AXUIElementCopyAttributeValue(p,$('AXParent'),o)!==0) return null;
    p=ObjC.castRefToObject(o[0]); if(!p) return null; if(sv(p,'AXRole')==='AXScrollArea') return frame(p) } return null }
function run(argv){
  // argv: <needle> <target: an AXDescription, "TITLE" for any element whose
  //       description mentions the needle, or "ROW" for the row body itself>
  //       [<modifier: shift|cmd>]
  var needle=argv[0], want=argv[1]||'TITLE', mod=argv[2]||''
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var all=[]; flat(app,all,0)
  var rows=all.filter(function(e){return sv(e,'AXSubrole')==='AXTableRow'})
  for(var i=0;i<rows.length;i++){
    var sub=[]; flat(rows[i],sub,0)
    if(!sub.some(function(e){return sv(e,'AXDescription').indexOf(needle)>=0})) continue
    var target
    if(want==='ROW') target=rows[i]
    else {
      var hits = want==='TITLE'
        ? sub.filter(function(e){return sv(e,'AXDescription').indexOf(needle)>=0})
        : sub.filter(function(e){return sv(e,'AXDescription')===want})
      if(!hits.length) continue   // keep scanning: a later row may carry it
      target=hits[0]
    }
    var f=frame(target); var x=f.x+f.w/2, y=f.y+f.h/2
    var sr=scrollRect(target)
    if(sr && sr.x!==null && (y < sr.y || y > sr.y+sr.h || x < sr.x || x > sr.x+sr.w))
      return 'OFF-SCREEN row '+(i+1)+' centre ('+x+','+y+') outside scroll area @['+sr.x+','+sr.y+' '+sr.w+'x'+sr.h+'] — nothing clicked'
    var pt=$.CGPointMake(x,y)
    var flags = mod==='shift' ? $.kCGEventFlagMaskShift : (mod==='cmd' ? $.kCGEventFlagMaskCommand : 0)
    function post(type){
      var ev=$.CGEventCreateMouseEvent($(), type, pt, $.kCGMouseButtonLeft)
      $.CGEventSetFlags(ev, flags)   // ALWAYS — zero included; see the note above
      $.CGEventPost($.kCGHIDEventTap, ev)
    }
    post($.kCGEventMouseMoved); delay(0.3)
    post($.kCGEventLeftMouseDown); delay(0.12)
    post($.kCGEventLeftMouseUp)
    return 'CLICKED'+(mod?'('+mod+')':'(no-mod)')+' '+want+' of the '+needle+' row at ('+x+','+y+') [row '+(i+1)+' of '+rows.length+']'
  }
  return 'no AXTableRow subtree mentions '+needle+' (rows scanned: '+rows.length+')'
}
EOF
}

# ==================================================================== reship
if [ "$CMD" = "reship" ]; then
  load_session
  ship_clickrow
  note "re-shipped clickrow.jxa (explicit-flags build)"
  exit 0
fi

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }
  note "preflight: VM table —"
  tart list 2>/dev/null | sed 's/^/    /' | tee -a "$REPORT"

  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }

  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"

  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (trial wall 2026-07-18 — never rolled)"

  lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null

  note "disruption monitor: $(lab_ssh "$IP" 'launchctl list 2>/dev/null | grep -i disrupt || echo "(not listed)"' </dev/null)"
  note "events.ndjson: $(lab_ssh "$IP" 'wc -l < ~/things-lab/events.ndjson 2>/dev/null || echo MISSING' </dev/null | tr -d " ") line(s)"

  note "warm-up launch/quit/relaunch"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14; osascript -e "tell application \"Things3\" to quit"; sleep 4; open -g -a Things3; sleep 12' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "IP=$IP" > "$SESSION"; echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"

  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"

  # ---- guest helpers ------------------------------------------------------
  lab_ssh "$IP" 'cat > ~/labh/tjson.sh && chmod +x ~/labh/tjson.sh' <<'EOF'
#!/bin/bash
URL=$(python3 -c 'import sys,urllib.parse; print("things:///json?auth-token="+sys.argv[1]+"&data="+urllib.parse.quote(sys.argv[2],safe=""))' "$1" "$2")
open -g "$URL"
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

  # a pid-targeted key poster — the BACKGROUND-capable chord vector
  lab_ssh "$IP" 'cat > ~/labh/keypid.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function run(argv){
  var pid=pidOf('Things3'), code=+argv[0], flags=+argv[1], n=argv[2]?+argv[2]:1, i;
  for(i=0;i<n;i++){
    var d=$.CGEventCreateKeyboardEvent($(),code,true), u=$.CGEventCreateKeyboardEvent($(),code,false);
    $.CGEventSetFlags(d,flags); $.CGEventSetFlags(u,flags);
    $.CGEventPostToPid(pid,d); sleepMs(70); $.CGEventPostToPid(pid,u); sleepMs(90);
  }
  return 'POSTED-TO-PID '+pid+' code='+code+' flags='+flags+' x'+n }
EOF

  lab_ssh "$IP" 'cat > ~/labh/hoax.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]) }
function sv(el,name){ var v=attr(el,name); try { return v? (''+v.js) : '' } catch(e){ return '' } }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function flat(el,acc,d){ acc.push(el); if(d>18) return acc; var ch=kids(el); for(var i=0;i<ch.length;i++) flat(ch[i],acc,d+1); return acc }
function frame(el){ var p=attr(el,'AXPosition'), z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=String(pd).match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=String(zd).match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null }
function appEl(){ return $.AXUIElementCreateApplication(pidOf('Things3')) }
var MOVED=5, DOWN=1, UP=2;
function mev(t,x,y){ return $.CGEventCreateMouseEvent($(),t,$.CGPointMake(x,y),0) }
function postHID(ev){ $.CGEventPost($.kCGHIDEventTap, ev) }
function click(x,y){ postHID(mev(MOVED,x,y)); sleepMs(60); postHID(mev(DOWN,x,y)); sleepMs(90); postHID(mev(UP,x,y)); sleepMs(60) }
function key(code){ var d=$.CGEventCreateKeyboardEvent($(),code,true), u=$.CGEventCreateKeyboardEvent($(),code,false); postHID(d); sleepMs(40); postHID(u); sleepMs(40) }
function keyMod(code,flags){ var d=$.CGEventCreateKeyboardEvent($(),code,true), u=$.CGEventCreateKeyboardEvent($(),code,false);
  $.CGEventSetFlags(d,flags); $.CGEventSetFlags(u,flags); postHID(d); sleepMs(70); postHID(u); sleepMs(70) }
function line(el,d,ix){
  var p=['['+ix+'] role='+sv(el,'AXRole')];
  var s=sv(el,'AXSubrole'); if(s) p.push('sub='+s);
  var t=sv(el,'AXTitle'); if(t) p.push('ttl='+t);
  var de=sv(el,'AXDescription'); if(de) p.push('desc='+de);
  var v=sv(el,'AXValue'); if(v) p.push('val='+String(v).slice(0,120));
  var id=sv(el,'AXIdentifier'); if(id) p.push('id='+id);
  var en=attr(el,'AXEnabled'); if(en!==null) p.push('ENABLED='+(''+en.js));
  var sel=attr(el,'AXSelected'); if(sel!==null) p.push('SELECTED='+(''+sel.js));
  var f=frame(el); if(f) p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']');
  return Array(d+1).join('  ')+p.join(' | ') }
function walk(el,d,acc,ix){ acc.push(line(el,d,ix)); if(d>16) return acc; var ch=kids(el); for(var i=0;i<ch.length;i++) walk(ch[i],d+1,acc,i+1); return acc }
function dumpAll(){
  var app=appEl(); var ws=kids(app); var acc=[];
  for(var i=0;i<ws.length;i++){
    var w=ws[i], f=frame(w), sub=sv(w,'AXSubrole'), r=sv(w,'AXRole');
    acc.push('=== CHILD '+(i+1)+' role='+r+' sub='+sub+' ttl='+sv(w,'AXTitle')+' id='+sv(w,'AXIdentifier')+(f?(' @['+f.x+','+f.y+' '+f.w+'x'+f.h+']'):'')+' ===');
    if(r==='AXMenuBar') continue;
    if(sub==='AXStandardWindow'){ walk(w,0,acc,i+1); }
  }
  if(!acc.length) acc.push('(nothing)');
  return acc.join('\n') }
function rowCensus(){
  var app=appEl(); var all=[]; flat(app,all,0);
  var rows=all.filter(function(e){ return sv(e,'AXSubrole')==='AXTableRow' });
  var acc=['rows='+rows.length];
  for(var i=0;i<rows.length;i++){
    var sel=attr(rows[i],'AXSelected'); var f=frame(rows[i]);
    var sub=[]; flat(rows[i],sub,0);
    var texts=[];
    for(var j=0;j<sub.length;j++){
      var d=sv(sub[j],'AXDescription'), v=sv(sub[j],'AXValue'), t=sv(sub[j],'AXTitle');
      if(d) texts.push('d:'+d); if(v) texts.push('v:'+String(v).slice(0,60)); if(t) texts.push('t:'+t);
    }
    acc.push('  ['+(i+1)+'] SELECTED='+(sel!==null?(''+sel.js):'?')+(f?(' @['+f.x+','+f.y+' '+f.w+'x'+f.h+']'):'')+' | '+texts.join(' ~ ').slice(0,300));
  }
  return acc.join('\n') }
function selRows(){
  var app=appEl(); var all=[]; flat(app,all,0);
  var rows=all.filter(function(e){ return sv(e,'AXSubrole')==='AXTableRow' });
  var out=[];
  for(var i=0;i<rows.length;i++){ var s=attr(rows[i],'AXSelected'); if(s!==null && (''+s.js)==='true') out.push(i+1) }
  return 'selected row ordinals of '+rows.length+': ['+out.join(',')+']' }
function run(argv){
  var cmd=argv[0];
  if(cmd==='dump') return dumpAll();
  if(cmd==='rows') return rowCensus();
  if(cmd==='sel')  return selRows();
  if(cmd==='click'){ click(+argv[1],+argv[2]); return 'CLICKED '+argv[1]+','+argv[2]; }
  if(cmd==='key'){ key(+argv[1]); return 'KEY '+argv[1]; }
  if(cmd==='keymod'){ keyMod(+argv[1], +argv[2]); return 'KEY '+argv[1]+' flags='+argv[2]; }
  return 'UNKNOWN_CMD' }
EOF

  ship_clickrow

  # ---- ship the production bundle ----------------------------------------
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "shipped dist; ui-enabled=true"

  note "setup DONE — session in $SESSION"
  exit 0
fi

# ------------------------------------------------ common to every measuring phase
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G()   { lab_ssh "$IP" "THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1 $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
AXM() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/hoax.js $*" </dev/null 2>&1; }
tj()  { lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null; sleep 4; }
TABLE='table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")'

# chord <code> <flags> [n]  — the BACKGROUND-capable vector (CGEventPostToPid)
chord() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/keypid.js $1 $2 ${3:-1}" </dev/null 2>&1; }

clickrow() {
  local m="${MOD:-}"
  lab_ssh "$IP" "osascript -l JavaScript ~/labh/clickrow.jxa $(printf '%q' "$1") $(printf '%q' "${2:-TITLE}") $(printf '%q' "$m")" </dev/null 2>&1
}

# the shipped positional heading selector
selh() {
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectHeadingRowScript(process.argv[1], $1)))" "$TABLE" > "$OUT/sel-h$1.applescript"
  lab_ssh "$IP" "cat > ~/labh/sel-h$1.applescript" < "$OUT/sel-h$1.applescript"
  lab_ssh "$IP" "osascript ~/labh/sel-h$1.applescript" </dev/null 2>&1
}
# the shipped title selector
selrow() {
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectRowScript(process.argv[1], process.argv[2])))" "$TABLE" "$1" > "$OUT/sel-row.applescript"
  lab_ssh "$IP" 'cat > ~/labh/sel-row.applescript' < "$OUT/sel-row.applescript"
  lab_ssh "$IP" 'osascript ~/labh/sel-row.applescript' </dev/null 2>&1
}

snap() { lab_ssh "$IP" "python3 ~/labh/rowsnap.py $(printf '%q' "$2")" </dev/null > "$OUT/snap/$1.tsv" 2>&1
  note "  [snap $1: $(cut -f1 "$OUT/snap/$1.tsv"|sort -u|wc -l|tr -d ' ') rows x $(awk -F'\t' 'NR==1{u=$1} $1==u{c++} END{print c+0}' "$OUT/snap/$1.tsv") cols]"; }
snapdiff() {
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

# seed_project <title> <headingTitle…> — each heading gets 2 synthetic children
seed_project() {
  local title="$1"; shift
  local items="" h c
  for h in "$@"; do
    items="$items{\"type\":\"heading\",\"attributes\":{\"title\":\"$h\"}},"
    for c in 1 2; do items="$items{\"type\":\"to-do\",\"attributes\":{\"title\":\"$h-c$c\"}},"; done
  done
  items="${items%,}"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"$title\",\"items\":[$items]}}]"
}
# seed_todos <projectTitle> <todoTitle…>
seed_todos() {
  local title="$1"; shift
  local items="" t
  for t in "$@"; do items="$items{\"type\":\"to-do\",\"attributes\":{\"title\":\"$t\"}},"; done
  items="${items%,}"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"$title\",\"items\":[$items]}}]"
}

# ============================================================== CELL 1 — bg
if [ "$CMD" = "bg" ]; then
  load_session
  bs reset >/dev/null; bmark "cell1 setup"
  note ""
  note "############### CELL 1 — BACKGROUNDED END-TO-END (the gate) ###############"
  note "  AX selection + CGEventPostToPid chord with Things NOT frontmost."
  note "  Asserting BOTH halves: the index delta lands AND the disruption monitor"
  note "  shows no focus steal (no frontmost/activate/window-new)."
  STAMP=$(date +%H%M%S)

  seed_project "C2BG-H-$STAMP" "BH1-$STAMP" "BH2-$STAMP" "BH3-$STAMP" "BH4-$STAMP" "BH5-$STAMP"
  PH=$(pid "C2BG-H-$STAMP")
  seed_todos "C2BG-T-$STAMP" "BT1-$STAMP" "BT2-$STAMP" "BT3-$STAMP" "BT4-$STAMP" "BT5-$STAMP"
  PT=$(pid "C2BG-T-$STAMP")
  note "  heading project=$PH   to-do project=$PT"

  warm

  # ---------- arm A: the HEADING, fully backgrounded ----------
  note ""
  note "  --- 1A: HEADING — reveal with open -g, Finder frontmost, AX select, chord to pid ---"
  show "things:///show?id=$PH"
  tofinder
  note "    frontmost before anything: [$(front)]"
  note "    START headings: $(horder "$PH")"
  bmark "cell1A select"
  mon_mark
  SEL=$(selh 2)
  note "    select-heading-row(ordinal 2 = the 3rd heading) -> [$SEL]"
  note "    frontmost after the SELECT: [$(front)]"
  note "    AX selection readback: $(AXM sel)"
  mon_verdict "the SELECTION half"
  B=$(horder "$PH")
  bmark "cell1A chord"
  mon_mark
  note "    chord: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(horder "$PH")
  note "    frontmost after the CHORD: [$(front)]"
  mon_verdict "the CHORD half"
  if [ "$A" != "$B" ]; then note "    *** 1A HEADING: DELTA LANDED BACKGROUNDED — $B  ==>  $A ***"
  else note "    *** 1A HEADING: NO DELTA — $A (the chord half FAILED) ***"; fi
  gt "SELECT title, substr(uuid,1,8) AS uuid8, \"index\" AS idx FROM TMTask WHERE project='$PH' AND type=2 AND trashed=0 ORDER BY \"index\"" | sed 's/^/      /' | tee -a "$REPORT"

  # ---------- arm B: the TO-DO, fully backgrounded ----------
  note ""
  note "  --- 1B: TO-DO — same shape ---"
  show "things:///show?id=$PT"
  tofinder
  note "    frontmost before anything: [$(front)]"
  note "    START to-dos: $(torder "$PT")"
  bmark "cell1B select"
  mon_mark
  SEL=$(selrow "BT3-$STAMP")
  note "    select-row(BT3) -> [$SEL]"
  note "    frontmost after the SELECT: [$(front)]"
  note "    Things selection readback: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  mon_verdict "the SELECTION half"
  B=$(torder "$PT")
  bmark "cell1B chord"
  mon_mark
  note "    chord: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(torder "$PT")
  note "    frontmost after the CHORD: [$(front)]"
  mon_verdict "the CHORD half"
  if [ "$A" != "$B" ]; then note "    *** 1B TO-DO: DELTA LANDED BACKGROUNDED — $B  ==>  $A ***"
  else note "    *** 1B TO-DO: NO DELTA — $A (the chord half FAILED) ***"; fi

  # ---------- arm C: the ⌘⌥ family backgrounded ----------
  note ""
  note "  --- 1C: ⌘⌥↓ (to bottom) backgrounded, to-do ---"
  B=$(torder "$PT")
  bmark "cell1C chord"
  mon_mark
  note "    re-select BT3: $(selrow "BT3-$STAMP")"
  note "    chord ⌘⌥↓: $(chord $KDOWN $FCMDOPT)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(torder "$PT")
  note "    $B  ==>  $A"
  note "    frontmost: [$(front)]"
  mon_verdict "1C"

  note ""
  note "  --- 1D: the CONTROL — is the guest's frontmost app still Finder end to end? ---"
  note "    frontmost: [$(front)]"
  note "    Things is running: $(lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null)"

  note ""
  note "  --- cell 1 beeps ---"
  bs assert --allow 0 --name chord2-cell1 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 2 — multi
if [ "$CMD" = "multi" ]; then
  load_session
  bs reset >/dev/null; bmark "cell2 setup"
  note ""
  note "############### CELL 2 — MULTI-SELECTION SEMANTICS ###############"
  STAMP=$(date +%H%M%S)
  seed_todos "C2MS-P-$STAMP" "V1-$STAMP" "V2-$STAMP" "V3-$STAMP" "V4-$STAMP" "V5-$STAMP" "V6-$STAMP"
  PV=$(pid "C2MS-P-$STAMP")
  note "  project=$PV"
  warm
  show "things:///show?id=$PV"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "  START: $(torder "$PV")"
  note "  the row census (does a project-list row expose its title to AX?):"
  AXM rows > "$OUT/ax/multi-rows.txt" 2>&1
  head -30 "$OUT/ax/multi-rows.txt" | sed 's/^/    /' | tee -a "$REPORT"

  # ---- (a) CONTIGUOUS block of three, ⌘↑ ----------------------------------
  note ""
  note "  --- 2a: CONTIGUOUS block V2..V4 (click V2, shift-click V4), then ⌘↑ ---"
  bmark "cell2a build selection"
  note "    click V2:       $(clickrow "V2-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    shift-click V4: $(MOD=shift clickrow "V4-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    Things says selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    AX says: $(AXM sel)"
  snap m2a-before "%$STAMP%"
  bmark "cell2a chord"
  B=$(torder "$PV")
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(torder "$PV")
  note "    $B  ==>  $A"
  snap m2a-after "%$STAMP%"
  snapdiff m2a-before m2a-after "2a contiguous block ⌘↑"

  # ---- (a2) the same block, ⌘↓ --------------------------------------------
  note ""
  note "  --- 2a2: the SAME block, ⌘↓ ---"
  bmark "cell2a2 chord"
  note "    click V2:       $(clickrow "V2-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    shift-click V4: $(MOD=shift clickrow "V4-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  snap m2a2-before "%$STAMP%"
  B=$(torder "$PV")
  note "    chord ⌘↓: $(chord $KDOWN $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(torder "$PV")
  note "    $B  ==>  $A"
  snap m2a2-after "%$STAMP%"
  snapdiff m2a2-before m2a2-after "2a2 contiguous block ⌘↓"

  # ---- (b) NON-CONTIGUOUS selection ---------------------------------------
  note ""
  note "  --- 2b: NON-CONTIGUOUS (click V2, cmd-click V5), then ⌘↑ ---"
  note "      the question: what is the ANCHOR, do the rows coalesce, which rows are written?"
  bmark "cell2b build selection"
  note "    click V2:     $(clickrow "V2-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    cmd-click V5: $(MOD=cmd clickrow "V5-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    AX says: $(AXM sel)"
  snap m2b-before "%$STAMP%"
  bmark "cell2b chord"
  B=$(torder "$PV")
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(torder "$PV")
  note "    $B  ==>  $A"
  snap m2b-after "%$STAMP%"
  snapdiff m2b-before m2b-after "2b non-contiguous ⌘↑"

  # ---- (d) ⌘⌥↑ on a multi-selection ---------------------------------------
  note ""
  note "  --- 2d: ⌘⌥↑ (to top) on a CONTIGUOUS block ---"
  bmark "cell2d build selection"
  note "    click V4:       $(clickrow "V4-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    shift-click V5: $(MOD=shift clickrow "V5-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  snap m2d-before "%$STAMP%"
  bmark "cell2d chord"
  B=$(torder "$PV")
  note "    chord ⌘⌥↑: $(chord $KUP $FCMDOPT)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(torder "$PV")
  note "    $B  ==>  $A"
  snap m2d-after "%$STAMP%"
  snapdiff m2d-before m2d-after "2d block ⌘⌥↑"

  # ---- (c) MIXED heading + to-do ------------------------------------------
  note ""
  note "  --- 2c: MIXED selection — a HEADING plus a to-do, then ⌘↑ ---"
  seed_project "C2MX-P-$STAMP" "XH1-$STAMP" "XH2-$STAMP" "XH3-$STAMP"
  PX=$(pid "C2MX-P-$STAMP")
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"XL1-$STAMP\",\"list-id\":\"$PX\"}}]"
  note "    project=$PX"
  warm
  show "things:///show?id=$PX"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "    heading order: $(horder "$PX")"
  note "    loose:         $(torder "$PX")"
  note "    row census:"
  AXM rows > "$OUT/ax/mixed-rows.txt" 2>&1
  head -25 "$OUT/ax/mixed-rows.txt" | sed 's/^/      /' | tee -a "$REPORT"
  bmark "cell2c build selection"
  note "    select heading ordinal 1 (XH2): $(selh 1)"
  note "    AX says: $(AXM sel)"
  note "    cmd-click XH2's first child:    $(MOD=cmd clickrow "XH2-$STAMP-c1" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    Things selected to dos: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    AX says: $(AXM sel)"
  snap m2c-before "%$STAMP%"
  bmark "cell2c chord"
  BH=$(horder "$PX"); BK=$(korder "$(hid "XH2-$STAMP")")
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    headings: $BH  ==>  $(horder "$PX")"
  note "    XH2 kids: $BK  ==>  $(korder "$(hid "XH2-$STAMP")")"
  snap m2c-after "%$STAMP%"
  snapdiff m2c-before m2c-after "2c mixed heading+to-do ⌘↑"
  note "    full project picture:"
  pdump "$PX" | sed 's/^/      /' | tee -a "$REPORT"

  note ""
  note "  --- cell 2 beeps ---"
  bs assert --allow 0 --name chord2-cell2 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 2b — multi2
#
# The first multi pass hit an app behaviour that invalidated two of its arms: a
# plain click on a row that is ALREADY part of a multi-selection does not
# collapse the selection to that row. So "click V2, cmd-click V5" produced the
# CONTIGUOUS V2..V5 (the stale block plus V5), never the intended
# non-contiguous pair; and the ⌘⌥↑ arm ran on a block that was already at the
# top, which cannot distinguish "declined because multi" from "declined because
# already at the top". Both are re-run here from a KNOWN-CLEAN selection, and
# the collapse behaviour itself is isolated as arm 0.
if [ "$CMD" = "multi2" ]; then
  load_session
  bs reset >/dev/null; bmark "cell2b setup"
  note ""
  note "############### CELL 2b — the corrected non-contiguous / ⌘⌥ arms ###############"
  STAMP=$(date +%H%M%S)
  seed_todos "C2M2-P-$STAMP" "N1-$STAMP" "N2-$STAMP" "N3-$STAMP" "N4-$STAMP" "N5-$STAMP" "N6-$STAMP"
  PN=$(pid "C2M2-P-$STAMP")
  note "  project=$PN"
  warm
  show "things:///show?id=$PN"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "  START: $(torder "$PN")"

  # ---- 2b0: does a plain click COLLAPSE an existing multi-selection? -------
  note ""
  note "  --- 2b0: build N2..N4, then plain-click N3 (a row INSIDE the block) ---"
  bmark "cell2b0 collapse test"
  note "    click N2:       $(clickrow "N2-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    shift-click N4: $(MOD=shift clickrow "N4-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    plain-click N3 (already selected): $(clickrow "N3-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected AFTER the plain click: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    now plain-click N6 (NOT selected):  $(clickrow "N6-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"

  # ---- 2b1: a TRUE non-contiguous selection --------------------------------
  note ""
  note "  --- 2b1: TRUE non-contiguous — reset on N6, click N2, cmd-click N5, then ⌘↑ ---"
  bmark "cell2b1 build"
  note "    click N2 (from a clean single selection on N6): $(clickrow "N2-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    cmd-click N5: $(MOD=cmd clickrow "N5-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    AX says: $(AXM sel)"
  snap n2b1-before "N_-$STAMP"
  bmark "cell2b1 chord"
  B=$(torder "$PN")
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(torder "$PN")
  note "    $B  ==>  $A"
  snap n2b1-after "N_-$STAMP"
  snapdiff n2b1-before n2b1-after "2b1 TRUE non-contiguous {N2,N5} ⌘↑"

  # ---- 2b2: the same non-contiguous pair, ⌘↓ -------------------------------
  note ""
  note "  --- 2b2: the same non-contiguous pair, ⌘↓ ---"
  bmark "cell2b2 build"
  note "    click N6 (reset): $(clickrow "N6-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  FIRSTN=$(gq "SELECT title FROM TMTask WHERE project='$PN' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" LIMIT 1")
  THIRDN=$(gq "SELECT title FROM TMTask WHERE project='$PN' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" LIMIT 1 OFFSET 2")
  note "    click $FIRSTN:     $(clickrow "$FIRSTN" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    cmd-click $THIRDN: $(MOD=cmd clickrow "$THIRDN" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  snap n2b2-before "N_-$STAMP"
  bmark "cell2b2 chord"
  B=$(torder "$PN")
  note "    chord ⌘↓: $(chord $KDOWN $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(torder "$PN")
  note "    $B  ==>  $A"
  snap n2b2-after "N_-$STAMP"
  snapdiff n2b2-before n2b2-after "2b2 non-contiguous ⌘↓"

  # ---- 2b3: ⌘⌥↑ on a MID-LIST contiguous block ----------------------------
  note ""
  note "  --- 2b3: ⌘⌥↑ on a contiguous block that is NOT at the top ---"
  bmark "cell2b3 build"
  note "    click N1 (reset to a single row): $(clickrow "N1-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  ROW3=$(gq "SELECT title FROM TMTask WHERE project='$PN' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" LIMIT 1 OFFSET 2")
  ROW4=$(gq "SELECT title FROM TMTask WHERE project='$PN' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" LIMIT 1 OFFSET 3")
  note "    click $ROW3:       $(clickrow "$ROW3" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    shift-click $ROW4: $(MOD=shift clickrow "$ROW4" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  snap n2b3-before "N_-$STAMP"
  bmark "cell2b3 chord"
  B=$(torder "$PN")
  note "    chord ⌘⌥↑: $(chord $KUP $FCMDOPT)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(torder "$PN")
  note "    $B  ==>  $A"
  snap n2b3-after "N_-$STAMP"
  snapdiff n2b3-before n2b3-after "2b3 mid-list block ⌘⌥↑"

  # ---- 2b4: ⌘⌥↓ on the same block ------------------------------------------
  note ""
  note "  --- 2b4: ⌘⌥↓ on a contiguous block that is NOT at the bottom ---"
  bmark "cell2b4 build"
  note "    click N1 (reset): $(clickrow "N1-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  ROW2=$(gq "SELECT title FROM TMTask WHERE project='$PN' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" LIMIT 1 OFFSET 1")
  ROW3=$(gq "SELECT title FROM TMTask WHERE project='$PN' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" LIMIT 1 OFFSET 2")
  note "    click $ROW2:       $(clickrow "$ROW2" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    shift-click $ROW3: $(MOD=shift clickrow "$ROW3" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  snap n2b4-before "N_-$STAMP"
  bmark "cell2b4 chord"
  B=$(torder "$PN")
  note "    chord ⌘⌥↓: $(chord $KDOWN $FCMDOPT)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(torder "$PN")
  note "    $B  ==>  $A"
  snap n2b4-after "N_-$STAMP"
  snapdiff n2b4-before n2b4-after "2b4 mid-list block ⌘⌥↓"

  # ---- 2b5: a 2-row block driven to the TOP by repeated ⌘↑ -----------------
  note ""
  note "  --- 2b5: repeated ⌘↑ on a block — how many rows are written per step? ---"
  bmark "cell2b5 build"
  note "    click N1 (reset): $(clickrow "N1-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  LASTN=$(gq "SELECT title FROM TMTask WHERE project='$PN' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" DESC LIMIT 1")
  PENN=$(gq "SELECT title FROM TMTask WHERE project='$PN' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" DESC LIMIT 1 OFFSET 1")
  note "    click $PENN:       $(clickrow "$PENN" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    shift-click $LASTN: $(MOD=shift clickrow "$LASTN" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  snap n2b5-before "N_-$STAMP"
  bmark "cell2b5 chord burst"
  B=$(torder "$PN")
  note "    chord ⌘↑ x4: $(chord $KUP $FCMD 4)"
  lab_ssh "$IP" 'sleep 3' </dev/null
  A=$(torder "$PN")
  note "    $B  ==>  $A"
  snap n2b5-after "N_-$STAMP"
  snapdiff n2b5-before n2b5-after "2b5 block ⌘↑ x4 to the top"

  note ""
  note "  --- cell 2b beeps ---"
  bs assert --allow 0 --name chord2-cell2b | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 2c — multi3
#
# The clean-flags re-run: every arm below issues its clicks through the fixed
# clicker (explicit CGEventSetFlags on every event), and every arm prints the
# selection readback it actually got before the chord is fired.
if [ "$CMD" = "multi3" ]; then
  load_session
  bs reset >/dev/null; bmark "cell2c setup"
  note ""
  note "############### CELL 2c — the CLEAN-FLAGS multi-selection re-run ###############"
  STAMP=$(date +%H%M%S)
  seed_todos "C2M3-P-$STAMP" "G1-$STAMP" "G2-$STAMP" "G3-$STAMP" "G4-$STAMP" "G5-$STAMP" "G6-$STAMP"
  PG=$(pid "C2M3-P-$STAMP")
  note "  project=$PG"
  warm
  show "things:///show?id=$PG"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "  START: $(torder "$PG")"

  # ---- 2c0: the clicker's own control — do plain clicks reset now? ---------
  note ""
  note "  --- 2c0: RIG CONTROL — the fixed clicker's plain click must COLLAPSE a block ---"
  bmark "cell2c0 rig control"
  note "    click G2:        $(clickrow "G2-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    shift-click G4:  $(MOD=shift clickrow "G4-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    plain-click G6:  $(clickrow "G6-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]  <- must be G6 alone"
  note "    plain-click G3 (inside no block now): $(clickrow "G3-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"

  # ---- 2c1: a TRUE non-contiguous pair, ⌘↑ --------------------------------
  note ""
  note "  --- 2c1: non-contiguous {G2,G5} (one gap either side), ⌘↑ ---"
  bmark "cell2c1 build"
  note "    click G2:     $(clickrow "G2-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    cmd-click G5: $(MOD=cmd clickrow "G5-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    AX says: $(AXM sel)"
  snap g2c1-before "G_-$STAMP"
  bmark "cell2c1 chord"
  B=$(torder "$PG")
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(torder "$PG")
  note "    $B  ==>  $A"
  snap g2c1-after "G_-$STAMP"
  snapdiff g2c1-before g2c1-after "2c1 non-contiguous {G2,G5} ⌘↑"

  # ---- 2c2: the coalescing question, second chord --------------------------
  note ""
  note "  --- 2c2: fire ⌘↑ AGAIN on the same (now-coalesced?) selection ---"
  note "    selected still: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  snap g2c2-before "G_-$STAMP"
  bmark "cell2c2 chord"
  B=$(torder "$PG")
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(torder "$PG")
  note "    $B  ==>  $A"
  snap g2c2-after "G_-$STAMP"
  snapdiff g2c2-before g2c2-after "2c2 second ⌘↑ on the same selection"

  # ---- 2c3: MIXED heading + to-do ------------------------------------------
  note ""
  note "  --- 2c3: MIXED selection — a HEADING plus one of its children ---"
  seed_project "C2M3X-P-$STAMP" "GH1-$STAMP" "GH2-$STAMP" "GH3-$STAMP"
  PGX=$(pid "C2M3X-P-$STAMP")
  note "    project=$PGX"
  warm
  show "things:///show?id=$PGX"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "    heading order: $(horder "$PGX")"
  bmark "cell2c3 mixed"
  note "    select heading ordinal 1 (GH2): $(selh 1)"
  note "    AX says: $(AXM sel)"
  note "    cmd-click GH2-c1: $(MOD=cmd clickrow "GH2-$STAMP-c1" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    Things selected to dos: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    AX says: $(AXM sel)"
  snap g2c3-before "%$STAMP%"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    headings: $(horder "$PGX")"
  snap g2c3-after "%$STAMP%"
  snapdiff g2c3-before g2c3-after "2c3 mixed heading+child ⌘↑"

  note ""
  note "  --- 2c4: the same mixed selection, ⌘↓ ---"
  note "    Things selected to dos: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    AX says: $(AXM sel)"
  snap g2c4-before "%$STAMP%"
  bmark "cell2c4 mixed down"
  note "    chord ⌘↓: $(chord $KDOWN $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap g2c4-after "%$STAMP%"
  snapdiff g2c4-before g2c4-after "2c4 mixed heading+child ⌘↓"
  pdump "$PGX" | sed 's/^/      /' | tee -a "$REPORT"

  # ---- 2c5: TWO HEADINGS selected ------------------------------------------
  note ""
  note "  --- 2c5: a HEADING-ONLY multi-selection (two heading rows), ⌘↑ ---"
  bmark "cell2c5 two headings"
  note "    select heading ordinal 1: $(selh 1)"
  note "    AX says: $(AXM sel)"
  note "    cmd-click the GH3 heading row: $(MOD=cmd clickrow "GH3-$STAMP" "Heading More Template")"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    AX says: $(AXM sel)"
  note "    Things selected to dos: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  snap g2c5-before "%$STAMP%"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    headings: $(horder "$PGX")"
  snap g2c5-after "%$STAMP%"
  snapdiff g2c5-before g2c5-after "2c5 two-heading selection ⌘↑"

  note ""
  note "  --- cell 2c beeps ---"
  bs assert --allow 0 --name chord2-cell2c | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 3 — bounds
if [ "$CMD" = "bounds" ]; then
  load_session
  bs reset >/dev/null; bmark "cell3 setup"
  note ""
  note "############### CELL 3 — BOUNDARY LAWS PER ROW KIND ###############"
  STAMP=$(date +%H%M%S)
  seed_project "C2BD-P-$STAMP" "DH1-$STAMP" "DH2-$STAMP"
  PB=$(pid "C2BD-P-$STAMP")
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"DL1-$STAMP\",\"list-id\":\"$PB\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"DL2-$STAMP\",\"list-id\":\"$PB\"}}]"
  note "  project=$PB"
  warm
  show "things:///show?id=$PB"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "  START:"
  pdump "$PB" | sed 's/^/    /' | tee -a "$REPORT"
  note "  row census:"
  AXM rows > "$OUT/ax/bounds-rows.txt" 2>&1
  head -30 "$OUT/ax/bounds-rows.txt" | sed 's/^/    /' | tee -a "$REPORT"

  H1=$(hid "DH1-$STAMP"); H2=$(hid "DH2-$STAMP")

  # ---- 3a: the FIRST child of the FIRST heading, ⌘↑ ------------------------
  note ""
  note "  --- 3a: to-do at the TOP of the FIRST heading, ⌘↑ ---"
  note "      (loose? out of the project? declined? HEADORD1 h4 crossed into the"
  note "       PREVIOUS heading — there is none here)"
  snap b3a-before "%$STAMP%"
  bmark "cell3a"
  note "    select DH1-c1: $(selrow "DH1-$STAMP-c1")"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap b3a-after "%$STAMP%"
  snapdiff b3a-before b3a-after "3a first-heading first-child ⌘↑"
  pdump "$PB" | sed 's/^/    /' | tee -a "$REPORT"

  # ---- 3b: absolute TOP of the project (first loose row), ⌘↑ ---------------
  note ""
  note "  --- 3b: the to-do at the ABSOLUTE TOP of the project, ⌘↑ ---"
  snap b3b-before "%$STAMP%"
  bmark "cell3b"
  FIRST=$(gq "SELECT title FROM TMTask WHERE project='$PB' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" LIMIT 1")
  note "    the top loose row is [$FIRST]"
  note "    select: $(selrow "$FIRST")"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap b3b-after "%$STAMP%"
  snapdiff b3b-before b3b-after "3b project-top ⌘↑"

  # ---- 3c: absolute BOTTOM of the project, ⌘↓ ------------------------------
  note ""
  note "  --- 3c: the LAST row of the LAST heading, ⌘↓ (absolute project bottom) ---"
  snap b3c-before "%$STAMP%"
  bmark "cell3c"
  LAST=$(gq "SELECT title FROM TMTask WHERE heading='$H2' AND trashed=0 ORDER BY \"index\" DESC LIMIT 1")
  note "    the bottom row is [$LAST]"
  note "    select: $(selrow "$LAST")"
  note "    chord ⌘↓: $(chord $KDOWN $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap b3c-after "%$STAMP%"
  snapdiff b3c-before b3c-after "3c project-bottom ⌘↓"

  # ---- 3d: ⌘⌥↑ on a HEADED to-do — top of the bucket, or of the project? ---
  note ""
  note "  --- 3d: ⌘⌥↑ on the LAST child of the SECOND heading ---"
  note "      does it go to the top of its BUCKET or the top of the PROJECT?"
  snap b3d-before "%$STAMP%"
  bmark "cell3d"
  T=$(gq "SELECT title FROM TMTask WHERE heading='$H2' AND trashed=0 ORDER BY \"index\" DESC LIMIT 1")
  note "    target [$T] (last child of DH2)"
  note "    select: $(selrow "$T")"
  note "    chord ⌘⌥↑: $(chord $KUP $FCMDOPT)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap b3d-after "%$STAMP%"
  snapdiff b3d-before b3d-after "3d headed child ⌘⌥↑"
  note "    DH1 kids: $(korder "$H1")"
  note "    DH2 kids: $(korder "$H2")"
  note "    loose:    $(torder "$PB")"
  pdump "$PB" | sed 's/^/    /' | tee -a "$REPORT"

  # ---- 3e: ⌘⌥↓ on a headed to-do ------------------------------------------
  note ""
  note "  --- 3e: ⌘⌥↓ on the FIRST child of the FIRST heading ---"
  snap b3e-before "%$STAMP%"
  bmark "cell3e"
  T=$(gq "SELECT title FROM TMTask WHERE heading='$H1' AND trashed=0 ORDER BY \"index\" ASC LIMIT 1")
  note "    target [$T]"
  note "    select: $(selrow "$T")"
  note "    chord ⌘⌥↓: $(chord $KDOWN $FCMDOPT)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap b3e-after "%$STAMP%"
  snapdiff b3e-before b3e-after "3e headed child ⌘⌥↓"
  note "    DH1 kids: $(korder "$H1")"
  note "    DH2 kids: $(korder "$H2")"
  note "    loose:    $(torder "$PB")"

  # ---- 3f: a LOOSE to-do driven DOWN into the heading block ----------------
  note ""
  note "  --- 3f: the LAST LOOSE to-do, ⌘↓ — does it enter the first heading? ---"
  snap b3f-before "%$STAMP%"
  bmark "cell3f"
  T=$(gq "SELECT title FROM TMTask WHERE project='$PB' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" DESC LIMIT 1")
  note "    the bottom LOOSE row is [$T]"
  note "    select: $(selrow "$T")"
  note "    chord ⌘↓: $(chord $KDOWN $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap b3f-after "%$STAMP%"
  snapdiff b3f-before b3f-after "3f loose row ⌘↓ into the heading block"
  pdump "$PB" | sed 's/^/    /' | tee -a "$REPORT"

  # ---- 3g: the HEADING decline CONTROL ------------------------------------
  note ""
  note "  --- 3g: CONTROL — the TOP heading, ⌘↑ (HEADORD1's decline law) ---"
  snap b3g-before "%$STAMP%"
  bmark "cell3g heading decline"
  note "    select heading ordinal 0: $(selh 0)"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap b3g-after "%$STAMP%"
  snapdiff b3g-before b3g-after "3g top heading ⌘↑ (expect: nothing + 1 beep)"

  note ""
  note "  --- cell 3 beeps ---"
  bs assert --allow 0 --name chord2-cell3 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 4 — views
if [ "$CMD" = "views" ]; then
  load_session
  bs reset >/dev/null; bmark "cell4 setup"
  note ""
  note "############### CELL 4 — WHICH COLUMN PER VIEW, AND VIEW-SCOPED SIDE EFFECTS ###############"
  STAMP=$(date +%H%M%S)
  seed_todos "C2VW-P-$STAMP" "W1-$STAMP" "W2-$STAMP" "W3-$STAMP" "W4-$STAMP"
  PW=$(pid "C2VW-P-$STAMP")
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"Y1-$STAMP\",\"when\":\"today\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"Y2-$STAMP\",\"when\":\"today\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"Y3-$STAMP\",\"when\":\"today\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"Y4-$STAMP\",\"when\":\"today\"}}]"
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"Z1-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"Z2-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"Z3-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"Z4-$STAMP\"}}]"
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"S1-$STAMP\",\"when\":\"someday\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"S2-$STAMP\",\"when\":\"someday\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"S3-$STAMP\",\"when\":\"someday\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"S4-$STAMP\",\"when\":\"someday\"}}]"
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"U1-$STAMP\",\"when\":\"2026-07-08\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"U2-$STAMP\",\"when\":\"2026-07-08\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"U3-$STAMP\",\"when\":\"2026-07-08\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"U4-$STAMP\",\"when\":\"2026-07-08\"}}]"
  note "  seeded; project=$PW"
  warm

  # view_cell <label> <showUrl> <titleGlob> <selectTitle> <keycode> <flags>
  view_cell() {
    local label="$1" url="$2" glob="$3" target="$4" code="$5" flags="$6"
    note ""
    note "  --- $label ---"
    note "    view: $url    target: $target"
    show "$url"
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    note "    by index:      $(vorder "$glob" '"index"')"
    note "    by todayIndex: $(vorder "$glob" 'todayIndex')"
    vdump "$glob" | sed 's/^/      /' | tee -a "$REPORT"
    snap "v-$label-before" "$glob"
    bmark "cell4 $label"
    note "    select: $(selrow "$target")"
    note "    Things selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
    note "    chord: $(chord "$code" "$flags")"
    lab_ssh "$IP" 'sleep 2' </dev/null
    note "    AFTER by index:      $(vorder "$glob" '"index"')"
    note "    AFTER by todayIndex: $(vorder "$glob" 'todayIndex')"
    vdump "$glob" | sed 's/^/      /' | tee -a "$REPORT"
    snap "v-$label-after" "$glob"
    snapdiff "v-$label-before" "v-$label-after" "$label"
  }

  view_cell "4a-project"  "things:///show?id=$PW"      "W_-$STAMP" "W3-$STAMP" $KUP $FCMD
  view_cell "4b-today"    "things:///show?id=today"    "Y_-$STAMP" "Y3-$STAMP" $KUP $FCMD
  view_cell "4c-anytime"  "things:///show?id=anytime"  "Z_-$STAMP" "Z3-$STAMP" $KUP $FCMD
  view_cell "4d-someday"  "things:///show?id=someday"  "S_-$STAMP" "S3-$STAMP" $KUP $FCMD
  view_cell "4e-upcoming" "things:///show?id=upcoming" "U_-$STAMP" "U3-$STAMP" $KUP $FCMD

  # ---- 4e2: the Upcoming RESCHEDULE question, driven to the group EDGE -----
  note ""
  note "  --- 4e2: Upcoming — ⌘↑ x3 on the FIRST row of the day-group (does it cross days?) ---"
  show "things:///show?id=upcoming"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  FIRSTU=$(gq "SELECT title FROM TMTask WHERE title LIKE 'U_-$STAMP' AND trashed=0 ORDER BY todayIndex ASC LIMIT 1")
  note "    the group's first row by todayIndex: [$FIRSTU]"
  snap v-4e2-before "U_-$STAMP"
  bmark "cell4e2 upcoming group edge"
  note "    select: $(selrow "$FIRSTU")"
  note "    chord ⌘↑ x3: $(chord $KUP $FCMD 3)"
  lab_ssh "$IP" 'sleep 3' </dev/null
  snap v-4e2-after "U_-$STAMP"
  snapdiff v-4e2-before v-4e2-after "4e2 upcoming group-edge ⌘↑ x3 — a startDate delta here is a RESCHEDULE"
  vdump "U_-$STAMP" | sed 's/^/      /' | tee -a "$REPORT"

  # ---- 4f: a TAG-FILTERED project view ------------------------------------
  note ""
  note "  --- 4f: a TAG-FILTERED project view — does ±1 land on the FILTERED neighbour or the TRUE sibling? ---"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"C2TAG-P-$STAMP\",\"items\":[{\"type\":\"to-do\",\"attributes\":{\"title\":\"F1-$STAMP\",\"tags\":[\"c2flag\"]}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"F2-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"F3-$STAMP\",\"tags\":[\"c2flag\"]}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"F4-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"F5-$STAMP\",\"tags\":[\"c2flag\"]}}]}}]"
  PF=$(pid "C2TAG-P-$STAMP")
  note "    project=$PF  (F1,F3,F5 tagged c2flag; F2,F4 untagged)"
  note "    unfiltered order: $(torder "$PF")"
  show "things:///show?id=$PF&filter=c2flag"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "    row census in the FILTERED view:"
  AXM rows > "$OUT/ax/tagfilter-rows.txt" 2>&1
  head -20 "$OUT/ax/tagfilter-rows.txt" | sed 's/^/      /' | tee -a "$REPORT"
  snap v-4f-before "F_-$STAMP"
  bmark "cell4f tag filter"
  note "    select F3 (middle FILTERED row; its true predecessor F2 is hidden): $(selrow "F3-$STAMP")"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER unfiltered order: $(torder "$PF")"
  snap v-4f-after "F_-$STAMP"
  snapdiff v-4f-before v-4f-after "4f tag-filtered ⌘↑ on F3"

  # ---- 4g: Logbook read-only control --------------------------------------
  note ""
  note "  --- 4g: read-only control — the Logbook ---"
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"L1-$STAMP\",\"completed\":true}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"L2-$STAMP\",\"completed\":true}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"L3-$STAMP\",\"completed\":true}}]"
  show "things:///show?id=logbook"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  snap v-4g-before "L_-$STAMP"
  bmark "cell4g logbook"
  note "    select L2: $(selrow "L2-$STAMP")"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap v-4g-after "L_-$STAMP"
  snapdiff v-4g-before v-4g-after "4g logbook ⌘↑"

  note ""
  note "  --- cell 4 beeps ---"
  bs assert --allow 0 --name chord2-cell4 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 4b — views2
#
# Two arms of the views pass did not measure what they claimed and are re-run
# here: the Anytime arm's positional title selector returned NOMATCH (Anytime is
# a GROUPED view — its content table is not the flat project table the shipped
# `select-row` walk assumes), and the tag-filter arm's `&filter=` reveal left
# every row visible (the tags never landed: the JSON `tags` attribute APPLIES
# tags, it does not CREATE them). Plus the two views the first pass skipped.
if [ "$CMD" = "views2" ]; then
  load_session
  bs reset >/dev/null; bmark "cell4b setup"
  note ""
  note "############### CELL 4b — the corrected Anytime + tag-filter arms ###############"
  STAMP=$(date +%H%M%S)

  # ---- 4b-c: ANYTIME, selected by CGEvent click (not the positional walk) --
  note ""
  note "  --- 4bc: the ANYTIME grouped view, row selected by CLICK ---"
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"AZ1-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"AZ2-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"AZ3-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"AZ4-$STAMP\"}}]"
  warm
  show "things:///show?id=anytime"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  note "    by index:      $(vorder "AZ_-$STAMP" '"index"')"
  note "    by todayIndex: $(vorder "AZ_-$STAMP" 'todayIndex')"
  vdump "AZ_-$STAMP" | sed 's/^/      /' | tee -a "$REPORT"
  snap w4bc-before "AZ%$STAMP%"
  bmark "cell4bc anytime"
  note "    click AZ3: $(clickrow "AZ3-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    Things selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER by index:      $(vorder "AZ_-$STAMP" '"index"')"
  note "    AFTER by todayIndex: $(vorder "AZ_-$STAMP" 'todayIndex')"
  snap w4bc-after "AZ%$STAMP%"
  snapdiff w4bc-before w4bc-after "4bc anytime ⌘↑ (click-selected)"

  # ---- 4b-i: the INBOX ----------------------------------------------------
  note ""
  note "  --- 4bi: the INBOX ---"
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"IB1-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"IB2-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"IB3-$STAMP\"}}]"
  warm
  show "things:///show?id=inbox"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  note "    by index:      $(vorder "IB_-$STAMP" '"index"')"
  note "    by todayIndex: $(vorder "IB_-$STAMP" 'todayIndex')"
  snap w4bi-before "IB%$STAMP%"
  bmark "cell4bi inbox"
  note "    click IB3: $(clickrow "IB3-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    Things selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER by index:      $(vorder "IB_-$STAMP" '"index"')"
  note "    AFTER by todayIndex: $(vorder "IB_-$STAMP" 'todayIndex')"
  snap w4bi-after "IB%$STAMP%"
  snapdiff w4bi-before w4bi-after "4bi inbox ⌘↑"

  # ---- 4b-e: the EVENING section of Today ---------------------------------
  note ""
  note "  --- 4be: the EVENING section of Today ---"
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"EV1-$STAMP\",\"when\":\"evening\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"EV2-$STAMP\",\"when\":\"evening\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"EV3-$STAMP\",\"when\":\"evening\"}}]"
  warm
  show "things:///show?id=today"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  note "    by index:      $(vorder "EV_-$STAMP" '"index"')"
  note "    by todayIndex: $(vorder "EV_-$STAMP" 'todayIndex')"
  vdump "EV_-$STAMP" | sed 's/^/      /' | tee -a "$REPORT"
  snap w4be-before "EV%$STAMP%"
  bmark "cell4be evening"
  note "    click EV3: $(clickrow "EV3-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    Things selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER by index:      $(vorder "EV_-$STAMP" '"index"')"
  note "    AFTER by todayIndex: $(vorder "EV_-$STAMP" 'todayIndex')"
  snap w4be-after "EV%$STAMP%"
  snapdiff w4be-before w4be-after "4be evening ⌘↑"

  note ""
  note "  --- 4be2: EVENING ⌘↑ at the section's TOP — does it cross into the daytime section? ---"
  FIRSTE=$(gq "SELECT title FROM TMTask WHERE title LIKE 'EV_-$STAMP' AND trashed=0 ORDER BY todayIndex ASC LIMIT 1")
  note "    the evening group's first row: [$FIRSTE]"
  snap w4be2-before "%$STAMP%"
  bmark "cell4be2 evening top"
  note "    click: $(clickrow "$FIRSTE" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    Things selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    chord ⌘↑ x2: $(chord $KUP $FCMD 2)"
  lab_ssh "$IP" 'sleep 3' </dev/null
  snap w4be2-after "%$STAMP%"
  snapdiff w4be2-before w4be2-after "4be2 evening top ⌘↑ x2 (an evening-flag or startBucket delta = a section crossing)"

  # ---- 4b-f: a REAL tag-filtered project view ------------------------------
  note ""
  note "  --- 4bf: a genuinely TAG-FILTERED project view ---"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"C2TG2-P-$STAMP\",\"items\":[{\"type\":\"to-do\",\"attributes\":{\"title\":\"T1-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"T2-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"T3-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"T4-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"T5-$STAMP\"}}]}}]"
  PT2=$(pid "C2TG2-P-$STAMP")
  note "    project=$PT2"
  for t in T1 T3 T5; do
    U=$(gq "SELECT uuid FROM TMTask WHERE title='$t-$STAMP' AND trashed=0 LIMIT 1")
    note "    tag $t: $(G todo tags "$U" --add c2flag2 --create-tags --json | tr '\n' ' ' | cut -c1-160)"
  done
  note "    tag rows in TMTag: $(gq "SELECT COALESCE(group_concat(title,','),'(none)') FROM TMTag WHERE title LIKE 'c2flag%'")"
  note "    tagged rows: $(gq "SELECT COALESCE(group_concat(t.title,','),'(none)') FROM TMTask t JOIN TMTaskTag tt ON tt.tasks=t.uuid JOIN TMTag g ON g.uuid=tt.tags WHERE g.title='c2flag2'")"
  note "    unfiltered order: $(torder "$PT2")"
  warm
  show "things:///show?id=$PT2&filter=c2flag2"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  note "    row census in the FILTERED view (must show 3 content rows, not 5):"
  AXM rows > "$OUT/ax/tagfilter2-rows.txt" 2>&1
  head -12 "$OUT/ax/tagfilter2-rows.txt" | sed 's/^/      /' | tee -a "$REPORT"
  snap w4bf-before "T%$STAMP%"
  bmark "cell4bf tag filter"
  note "    click T3 (middle FILTERED row; its TRUE predecessor T2 is hidden): $(clickrow "T3-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    Things selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER unfiltered order: $(torder "$PT2")"
  note "      (T3 above T2 = the TRUE sibling — a VISUAL NO-OP in the filtered view)"
  note "      (T3 above T1 = the FILTERED neighbour — what the user sees)"
  snap w4bf-after "T%$STAMP%"
  snapdiff w4bf-before w4bf-after "4bf tag-filtered ⌘↑ on T3"

  note ""
  note "  --- cell 4b beeps ---"
  bs assert --allow 0 --name chord2-cell4b | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 4c — views3
#
# Anytime and the Today/Evening section both hold enough golden-seeded rows that
# a freshly-added fixture lands BELOW THE FOLD, where the CNCAC1 rule refuses to
# click. Both are re-reached here by TAG-FILTERING the view down to the fixture —
# which 4bf just proved is safe for the COLUMN question (the chord re-ranks
# against what is displayed, so a filtered view still writes the view's own
# rank column).
if [ "$CMD" = "views3" ]; then
  load_session
  bs reset >/dev/null; bmark "cell4c setup"
  note ""
  note "############### CELL 4c — Anytime and Evening, reached through a tag filter ###############"
  STAMP=$(date +%H%M%S)

  tag_them() {
    local t
    for t in "$@"; do
      U=$(gq "SELECT uuid FROM TMTask WHERE title='$t' AND trashed=0 LIMIT 1")
      G todo tags "$U" --add "$TAGN" --create-tags >/dev/null 2>&1
    done
  }

  # ---- 4ca: ANYTIME --------------------------------------------------------
  TAGN="c2any$STAMP"
  note ""
  note "  --- 4ca: the ANYTIME view, filtered to the fixture ---"
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"XA1-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"XA2-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"XA3-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"XA4-$STAMP\"}}]"
  tag_them "XA1-$STAMP" "XA2-$STAMP" "XA3-$STAMP" "XA4-$STAMP"
  note "    tagged: $(gq "SELECT COALESCE(group_concat(t.title,','),'(none)') FROM TMTask t JOIN TMTaskTag tt ON tt.tasks=t.uuid JOIN TMTag g ON g.uuid=tt.tags WHERE g.title='$TAGN'")"
  warm
  show "things:///show?id=anytime&filter=$TAGN"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  note "    row census (must be down to the fixture):"
  AXM rows > "$OUT/ax/anytime-filtered.txt" 2>&1
  head -10 "$OUT/ax/anytime-filtered.txt" | sed 's/^/      /' | tee -a "$REPORT"
  note "    by index:      $(vorder "XA_-$STAMP" '"index"')"
  note "    by todayIndex: $(vorder "XA_-$STAMP" 'todayIndex')"
  vdump "XA_-$STAMP" | sed 's/^/      /' | tee -a "$REPORT"
  snap x4ca-before "XA%$STAMP%"
  bmark "cell4ca anytime"
  note "    click XA3: $(clickrow "XA3-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    Things selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER by index:      $(vorder "XA_-$STAMP" '"index"')"
  note "    AFTER by todayIndex: $(vorder "XA_-$STAMP" 'todayIndex')"
  snap x4ca-after "XA%$STAMP%"
  snapdiff x4ca-before x4ca-after "4ca anytime ⌘↑"

  # ---- 4cb: the EVENING section, within-section ---------------------------
  TAGN="c2eve$STAMP"
  note ""
  note "  --- 4cb: the EVENING section of Today, filtered to the fixture ---"
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"XE1-$STAMP\",\"when\":\"evening\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"XE2-$STAMP\",\"when\":\"evening\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"XE3-$STAMP\",\"when\":\"evening\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"XE4-$STAMP\",\"when\":\"evening\"}}]"
  tag_them "XE1-$STAMP" "XE2-$STAMP" "XE3-$STAMP" "XE4-$STAMP"
  warm
  show "things:///show?id=today&filter=$TAGN"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  note "    row census:"
  AXM rows > "$OUT/ax/today-filtered.txt" 2>&1
  head -10 "$OUT/ax/today-filtered.txt" | sed 's/^/      /' | tee -a "$REPORT"
  note "    by index:      $(vorder "XE_-$STAMP" '"index"')"
  note "    by todayIndex: $(vorder "XE_-$STAMP" 'todayIndex')"
  vdump "XE_-$STAMP" | sed 's/^/      /' | tee -a "$REPORT"
  note "    startBucket: $(gq "SELECT group_concat(title||'='||startBucket,' ') FROM (SELECT title, startBucket FROM TMTask WHERE title LIKE 'XE_-$STAMP' AND trashed=0 ORDER BY todayIndex)")"
  snap x4cb-before "XE%$STAMP%"
  bmark "cell4cb evening within"
  note "    click XE3: $(clickrow "XE3-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    Things selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER by todayIndex: $(vorder "XE_-$STAMP" 'todayIndex')"
  note "    AFTER startBucket: $(gq "SELECT group_concat(title||'='||startBucket,' ') FROM (SELECT title, startBucket FROM TMTask WHERE title LIKE 'XE_-$STAMP' AND trashed=0 ORDER BY todayIndex)")"
  snap x4cb-after "XE%$STAMP%"
  snapdiff x4cb-before x4cb-after "4cb within-evening ⌘↑"

  note ""
  note "  --- cell 4c beeps ---"
  bs assert --allow 0 --name chord2-cell4c | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 4d — views4
#
# Third attempt at Anytime. The first two both seeded LOOSE to-dos, which the
# JSON add drops in the INBOX — and the Inbox is not in Anytime, so the view was
# genuinely empty of the fixture both times (34 rows, none of them content). The
# Anytime population is project and AREA members, so the fixture is seeded
# AREA-DIRECT here.
if [ "$CMD" = "views4" ]; then
  load_session
  bs reset >/dev/null; bmark "cell4d setup"
  note ""
  note "############### CELL 4d — Anytime, seeded AREA-DIRECT ###############"
  STAMP=$(date +%H%M%S)
  AREA=$(gq "SELECT uuid FROM TMArea WHERE title='LAB-AREA-A' LIMIT 1")
  note "  area LAB-AREA-A = [$AREA]"
  [ -n "$AREA" ] || { note "  FATAL: no such area"; exit 1; }
  TAGN="c2ar$STAMP"
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"YA1-$STAMP\",\"list-id\":\"$AREA\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"YA2-$STAMP\",\"list-id\":\"$AREA\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"YA3-$STAMP\",\"list-id\":\"$AREA\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"YA4-$STAMP\",\"list-id\":\"$AREA\"}}]"
  for t in YA1 YA2 YA3 YA4; do
    U=$(gq "SELECT uuid FROM TMTask WHERE title='$t-$STAMP' AND trashed=0 LIMIT 1")
    G todo tags "$U" --add "$TAGN" --create-tags >/dev/null 2>&1
  done
  note "  rows: $(gt "SELECT title, substr(uuid,1,8) AS uuid8, \"index\" AS idx, todayIndex AS tidx, start, COALESCE(substr(area,1,8),'-') AS area FROM TMTask WHERE title LIKE 'YA_-$STAMP' AND trashed=0 ORDER BY \"index\"" | tr '\n' '|')"
  warm
  show "things:///show?id=anytime&filter=$TAGN"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  note "  row census:"
  AXM rows > "$OUT/ax/anytime-area.txt" 2>&1
  head -10 "$OUT/ax/anytime-area.txt" | sed 's/^/    /' | tee -a "$REPORT"
  note "  by index:      $(vorder "YA_-$STAMP" '"index"')"
  note "  by todayIndex: $(vorder "YA_-$STAMP" 'todayIndex')"
  snap y4d-before "YA%$STAMP%"
  bmark "cell4d anytime area-direct"
  note "  click YA3: $(clickrow "YA3-$STAMP" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "  Things selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "  chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "  AFTER by index:      $(vorder "YA_-$STAMP" '"index"')"
  note "  AFTER by todayIndex: $(vorder "YA_-$STAMP" 'todayIndex')"
  snap y4d-after "YA%$STAMP%"
  snapdiff y4d-before y4d-after "4d anytime (area-direct) ⌘↑"

  note ""
  note "  --- cell 4d beeps ---"
  bs assert --allow 0 --name chord2-cell4d | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 5 — tmpl
if [ "$CMD" = "tmpl" ]; then
  load_session
  bs reset >/dev/null; bmark "cell5 setup"
  note ""
  note "############### CELL 5 — REPEATING TEMPLATES, THE IMMOVABLE OBJECTS ###############"
  note "  §9e recorded resting-template order as URL-inert and drag-inert; ORD-19 records"
  note "  a repeating template's day-block position as unreachable by EVERY surface."
  note "  If a chord moves either, a declared app-impossibility reopens."
  STAMP=$(date +%H%M%S)

  seed_todos "C2TM-P-$STAMP" "R1-$STAMP" "R2-$STAMP" "R3-$STAMP"
  PR=$(pid "C2TM-P-$STAMP")
  note "  project=$PR"
  note "  building a DAILY repeating template inside it (Repeat-dialog drive)…"
  OUTP=$(G todo add-repeating "\"RT-$STAMP\"" --project "$PR" --frequency daily --interval 1 --dangerously-drive-gui --json)
  printf '%s\n' "$OUTP" | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 4' </dev/null
  note "  rows now present:"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, type, \"index\" AS idx, todayIndex AS tidx, start, startDate AS sd, CASE WHEN rt1_recurrenceRule IS NULL THEN 'plain' ELSE 'TEMPLATE' END AS kind, rt1_nextInstanceStartDate AS nextd FROM TMTask WHERE title LIKE 'R%-$STAMP' AND trashed=0 ORDER BY \"index\"" | sed 's/^/    /' | tee -a "$REPORT"

  TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='RT-$STAMP' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1")
  note "  template uuid: [$TMPL]"

  # ---- 5a: the TEMPLATE row in the PROJECT list ---------------------------
  note ""
  note "  --- 5a: the repeating TEMPLATE row in a project list, ⌘↑ ---"
  warm
  show "things:///show?id=$PR"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "    row census:"
  AXM rows > "$OUT/ax/tmpl-rows.txt" 2>&1
  head -25 "$OUT/ax/tmpl-rows.txt" | sed 's/^/      /' | tee -a "$REPORT"
  note "    order by index: $(vorder "R%-$STAMP" '"index"')"
  snap t5a-before "R%$STAMP%"
  bmark "cell5a template in project"
  note "    select RT: $(selrow "RT-$STAMP")"
  note "    Things selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    Things selected ids: [$(axq 'tell application "Things3" to get id of selected to dos')]"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER order by index: $(vorder "R%-$STAMP" '"index"')"
  snap t5a-after "R%$STAMP%"
  snapdiff t5a-before t5a-after "5a template row ⌘↑ in a project list"

  # ---- 5a2: ⌘⌥↑ on the template -------------------------------------------
  note ""
  note "  --- 5a2: ⌘⌥↑ on the same template row ---"
  snap t5a2-before "R%$STAMP%"
  bmark "cell5a2 template to top"
  note "    select RT: $(selrow "RT-$STAMP")"
  note "    chord ⌘⌥↑: $(chord $KUP $FCMDOPT)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER order by index: $(vorder "R%-$STAMP" '"index"')"
  snap t5a2-after "R%$STAMP%"
  snapdiff t5a2-before t5a2-after "5a2 template row ⌘⌥↑"

  # ---- 5b: the day-group PROJECTION in Upcoming ---------------------------
  note ""
  note "  --- 5b: the template's PROJECTION in an Upcoming day-group (the ORD-19 loss) ---"
  NEXTD=$(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TMPL'")
  note "    the template's next occurrence packs as: $NEXTD"
  NEXTISO=$(python3 -c "v=int('${NEXTD:-0}' or 0); print('%04d-%02d-%02d'%(v>>16,(v>>12)&0xF,(v>>7)&0x1F))" 2>/dev/null || echo 2026-07-06)
  note "    == $NEXTISO"
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"Q1-$STAMP\",\"when\":\"$NEXTISO\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"Q2-$STAMP\",\"when\":\"$NEXTISO\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"Q3-$STAMP\",\"when\":\"$NEXTISO\"}}]"
  warm
  show "things:///show?id=upcoming"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  note "    Upcoming row census (looking for the projection):"
  AXM rows > "$OUT/ax/upcoming-rows.txt" 2>&1
  head -40 "$OUT/ax/upcoming-rows.txt" | sed 's/^/      /' | tee -a "$REPORT"
  note "    the day-group by todayIndex: $(vorder "Q_-$STAMP" 'todayIndex')"
  vdump "Q_-$STAMP" | sed 's/^/      /' | tee -a "$REPORT"
  snap t5b-before "%$STAMP%"

  bmark "cell5b1 select the projection"
  note "    attempt to select the projection by title: $(selrow "RT-$STAMP")"
  note "    Things selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    Things selected ids: [$(axq 'tell application "Things3" to get id of selected to dos')]"
  note "    (the template uuid is $TMPL)"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap t5b-after "%$STAMP%"
  snapdiff t5b-before t5b-after "5b1 chord on the Upcoming projection"
  note "    the day-group by todayIndex: $(vorder "Q_-$STAMP" 'todayIndex')"

  note ""
  note "  --- 5b2: chord a PLAIN row in the SAME day-group (does the block move around the template?) ---"
  snap t5b2-before "%$STAMP%"
  bmark "cell5b2 plain row in the template's group"
  LASTQ=$(gq "SELECT title FROM TMTask WHERE title LIKE 'Q_-$STAMP' AND trashed=0 ORDER BY todayIndex DESC LIMIT 1")
  note "    target [$LASTQ] (last of the plain group)"
  note "    select: $(selrow "$LASTQ")"
  note "    chord ⌘↑ x4: $(chord $KUP $FCMD 4)"
  lab_ssh "$IP" 'sleep 3' </dev/null
  snap t5b2-after "%$STAMP%"
  snapdiff t5b2-before t5b2-after "5b2 plain row ⌘↑ x4 inside the template's day-group"
  note "    the day-group by todayIndex: $(vorder "Q_-$STAMP" 'todayIndex')"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, \"index\" AS idx, todayIndex AS tidx, startDate AS sd, rt1_nextInstanceStartDate AS nextd FROM TMTask WHERE title LIKE '%-$STAMP' AND trashed=0 ORDER BY todayIndex" | sed 's/^/      /' | tee -a "$REPORT"

  note ""
  note "  --- cell 5 beeps ---"
  bs assert --allow 0 --name chord2-cell5 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 5b — tmpl2
#
# The first template pass built no template (`add-repeating --list` is not a
# flag; the destination is `--project`) so 5a never ran, and its 5b arm drove a
# row that was ABOVE the projection and so never crossed it. Both are redone
# here — and the Upcoming census from that run turned up something ORD-19 rests
# on: on 3.23 the projected template row DOES carry its title as an
# AXDescription (`d:‎LAB-REPEAT-DAILY`), and `Things3 → id of selected to dos`
# reads the uuid back, so the row is both addressable AND verifiable. ORDFIN1
# §1c/1d declared exactly that impossible on 3.22. So the arms are:
#   5c  a template inside a PROJECT list — does the chord move it? (§9e)
#   5d  the projected template row in an Upcoming day-group — can it be selected
#       with a VERIFIED uuid, and does the chord move it? (ORD-19)
#   5e  a plain row driven UP PAST the projection — does the block reorder
#       around the immovable row, and does the template's rank move?
if [ "$CMD" = "tmpl2" ]; then
  load_session
  bs reset >/dev/null; bmark "cell5b setup"
  note ""
  note "############### CELL 5b — the repeating templates, properly reached ###############"
  STAMP=$(date +%H%M%S)

  # ---- 5c: a template inside a PROJECT list --------------------------------
  note ""
  note "  --- 5c: a repeating TEMPLATE row inside a project list ---"
  seed_todos "C2T2-P-$STAMP" "P1-$STAMP" "P2-$STAMP" "P3-$STAMP"
  PR=$(pid "C2T2-P-$STAMP")
  note "    project=$PR"
  OUTP=$(G todo add-repeating "\"PT-$STAMP\"" --project "$PR" --frequency daily --interval 1 --dangerously-drive-gui --json)
  printf '%s\n' "$OUTP" | tail -4 | sed 's/^/      /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 4' </dev/null
  gt "SELECT title, substr(uuid,1,8) AS uuid8, type, \"index\" AS idx, todayIndex AS tidx, start, startDate AS sd, CASE WHEN rt1_recurrenceRule IS NULL THEN 'plain' ELSE 'TEMPLATE' END AS kind, rt1_nextInstanceStartDate AS nextd, COALESCE(substr(project,1,8),'-') AS proj FROM TMTask WHERE title LIKE '%$STAMP%' AND trashed=0 ORDER BY \"index\"" | sed 's/^/      /' | tee -a "$REPORT"
  TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='PT-$STAMP' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1")
  note "    template uuid: [$TMPL]"
  if [ -z "$TMPL" ]; then note "    *** no template was built — 5c cannot run ***"; else
    warm
    show "things:///show?id=$PR"
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
    note "    row census:"
    AXM rows > "$OUT/ax/tmpl2-project.txt" 2>&1
    head -8 "$OUT/ax/tmpl2-project.txt" | sed 's/^/      /' | tee -a "$REPORT"
    note "    order by index: $(vorder "%$STAMP%" '"index"')"
    snap z5c-before "%$STAMP%"
    bmark "cell5c template in project"
    note "    click the template row: $(clickrow "PT-$STAMP" TITLE)"
    lab_ssh "$IP" 'sleep 1' </dev/null
    note "    selected names: [$(axq 'tell application "Things3" to get name of selected to dos')]"
    SELID=$(axq 'tell application "Things3" to get id of selected to dos')
    note "    selected ids:   [$SELID]   (template is $TMPL)"
    note "    chord ⌘↑: $(chord $KUP $FCMD)"
    lab_ssh "$IP" 'sleep 2' </dev/null
    note "    AFTER order by index: $(vorder "%$STAMP%" '"index"')"
    snap z5c-after "%$STAMP%"
    snapdiff z5c-before z5c-after "5c template row ⌘↑ in a project list"

    note ""
    note "  --- 5c2: ⌘⌥↓ on the same template row ---"
    snap z5c2-before "%$STAMP%"
    bmark "cell5c2 template to bottom"
    note "    click the template row: $(clickrow "PT-$STAMP" TITLE)"
    lab_ssh "$IP" 'sleep 1' </dev/null
    note "    selected ids: [$(axq 'tell application "Things3" to get id of selected to dos')]"
    note "    chord ⌘⌥↓: $(chord $KDOWN $FCMDOPT)"
    lab_ssh "$IP" 'sleep 2' </dev/null
    note "    AFTER order by index: $(vorder "%$STAMP%" '"index"')"
    snap z5c2-after "%$STAMP%"
    snapdiff z5c2-before z5c2-after "5c2 template row ⌘⌥↓"
  fi

  # ---- 5d/5e: the projected template in an Upcoming day-group -------------
  note ""
  note "  --- 5d: the golden's LAB-REPEAT-DAILY projection in an Upcoming day-group ---"
  LRD=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1")
  note "    LAB-REPEAT-DAILY template uuid: [$LRD]"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, \"index\" AS idx, todayIndex AS tidx, start, startDate AS sd, rt1_nextInstanceStartDate AS nextd FROM TMTask WHERE uuid='$LRD'" | sed 's/^/      /' | tee -a "$REPORT"
  NEXTD=$(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$LRD'")
  NEXTISO=$(python3 -c "v=int('${NEXTD:-0}'); print('%04d-%02d-%02d'%(v>>16,(v>>12)&0xF,(v>>7)&0x1F))")
  note "    its next occurrence day: $NEXTISO (packed $NEXTD)"
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"KQ1-$STAMP\",\"when\":\"$NEXTISO\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"KQ2-$STAMP\",\"when\":\"$NEXTISO\"}}]"
  warm
  show "things:///show?id=upcoming"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 4' </dev/null
  note "    Upcoming census, first 14 rows:"
  AXM rows > "$OUT/ax/tmpl2-upcoming.txt" 2>&1
  head -14 "$OUT/ax/tmpl2-upcoming.txt" | sed 's/^/      /' | tee -a "$REPORT"
  note "    the day-group rows by todayIndex:"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, todayIndex AS tidx, startDate AS sd, CASE WHEN rt1_recurrenceRule IS NULL THEN 'plain' ELSE 'TEMPLATE' END AS kind FROM TMTask WHERE (startDate=$NEXTD OR rt1_nextInstanceStartDate=$NEXTD) AND trashed=0 AND status=0 ORDER BY todayIndex" | sed 's/^/      /' | tee -a "$REPORT"

  snap z5d-before "%" ; note "    (5d snapshots the WHOLE table — the projection's row is golden-seeded)"
  bmark "cell5d select the projection"
  note "    click the LAB-REPEAT-DAILY row: $(clickrow "LAB-REPEAT-DAILY" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected names: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  SELID=$(axq 'tell application "Things3" to get id of selected to dos')
  note "    selected ids:   [$SELID]"
  if [ "$SELID" = "$LRD" ]; then note "    *** IDENTITY VERIFIED — the projection selects as the TEMPLATE uuid ***"
  else note "    (the selected id is NOT the template uuid — $SELID vs $LRD)"; fi
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap z5d-after "%"
  snapdiff z5d-before z5d-after "5d chord ⌘↑ on the projected template row"

  note ""
  note "  --- 5d2: ⌘↓ on the same projection ---"
  snap z5d2-before "%"
  bmark "cell5d2 projection down"
  note "    click the LAB-REPEAT-DAILY row: $(clickrow "LAB-REPEAT-DAILY" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected ids: [$(axq 'tell application "Things3" to get id of selected to dos')]"
  note "    chord ⌘↓: $(chord $KDOWN $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap z5d2-after "%"
  snapdiff z5d2-before z5d2-after "5d2 chord ⌘↓ on the projected template row"

  note ""
  note "  --- 5e: a PLAIN row driven UP PAST the projection ---"
  LASTK=$(gq "SELECT title FROM TMTask WHERE (startDate=$NEXTD) AND trashed=0 AND status=0 ORDER BY todayIndex DESC LIMIT 1")
  note "    the day-group's LAST plain row: [$LASTK]"
  snap z5e-before "%"
  bmark "cell5e plain past the template"
  note "    click: $(clickrow "$LASTK" TITLE)"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    chord ⌘↑ x6: $(chord $KUP $FCMD 6)"
  lab_ssh "$IP" 'sleep 3' </dev/null
  snap z5e-after "%"
  snapdiff z5e-before z5e-after "5e plain row ⌘↑ x6 past the projection"
  note "    the day-group after:"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, todayIndex AS tidx, startDate AS sd, CASE WHEN rt1_recurrenceRule IS NULL THEN 'plain' ELSE 'TEMPLATE' END AS kind FROM TMTask WHERE (startDate=$NEXTD OR rt1_nextInstanceStartDate=$NEXTD) AND trashed=0 AND status=0 ORDER BY todayIndex" | sed 's/^/      /' | tee -a "$REPORT"

  note ""
  note "  --- cell 5b beeps ---"
  bs assert --allow 0 --name chord2-cell5b | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 7a' — arch
#
# The archived-heading render question, retaken: the first attempt's archive was
# correctly REFUSED (`blocked:H-HEADING-CHILDREN` — the heading had two open
# children), so no heading was ever archived and 7a measured a plain project.
# Here the children are reparented first, exactly as the refusal's remediation
# says, and the project also carries a CHILDLESS heading so both shapes are
# covered.
if [ "$CMD" = "arch" ]; then
  load_session
  bs reset >/dev/null; bmark "cell7a2 setup"
  note ""
  note "############### CELL 7a' — does an ARCHIVED heading render as a row? ###############"
  STAMP=$(date +%H%M%S)
  # BH2 gets no children (seeded then emptied), so its archive needs no policy.
  seed_project "C2AR2-P-$STAMP" "BH1-$STAMP" "BH2-$STAMP" "BH3-$STAMP" "BH4-$STAMP"
  PA=$(pid "C2AR2-P-$STAMP")
  note "  project=$PA"
  note "  heading order: $(horder "$PA")"
  H2=$(hid "BH2-$STAMP")
  warm
  show "things:///show?id=$PA"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  AXM rows > "$OUT/ax/arch2-before.txt" 2>&1
  NB=$(grep -c "Heading More Template" "$OUT/ax/arch2-before.txt")
  note "  heading rows rendered BEFORE: $NB"
  note "  content rows BEFORE: $(head -1 "$OUT/ax/arch2-before.txt")"
  grep "Heading More Template" "$OUT/ax/arch2-before.txt" | sed 's/^/    /' | tee -a "$REPORT"

  bmark "cell7a2 archive"
  note "  archive BH2 ($H2) with --children reparent:"
  G project archive-heading "$PA" "$H2" --children reparent --json 2>&1 | tail -2 | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
  note "  DB heading rows after the archive:"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, status, \"index\" AS idx, trashed FROM TMTask WHERE project='$PA' AND type=2 ORDER BY \"index\"" | sed 's/^/    /' | tee -a "$REPORT"

  warm
  show "things:///show?id=$PA"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  AXM rows > "$OUT/ax/arch2-after.txt" 2>&1
  NA=$(grep -c "Heading More Template" "$OUT/ax/arch2-after.txt")
  note "  heading rows rendered AFTER: $NA  (was $NB)"
  note "  content rows AFTER: $(head -1 "$OUT/ax/arch2-after.txt")"
  grep "Heading More Template" "$OUT/ax/arch2-after.txt" | sed 's/^/    /' | tee -a "$REPORT"
  note "  the archived heading's title anywhere in the tree: $(grep -c "BH2-$STAMP" "$OUT/ax/arch2-after.txt") element(s)"
  if [ "$NA" -lt "$NB" ]; then note "  *** VERDICT: an ARCHIVED heading does NOT render as a content row ***"
  else note "  *** VERDICT: an ARCHIVED heading STILL renders as a content row ***"; fi

  # ---- does the positional walk see it, and does ±1 count its slot? -------
  note ""
  note "  --- the SHIPPED positional walk over the post-archive table ---"
  note "    select-heading-row ordinal 0: $(selh 0)"; note "      AX: $(AXM sel)"
  note "    select-heading-row ordinal 1: $(selh 1)"; note "      AX: $(AXM sel)"
  note "    select-heading-row ordinal 2: $(selh 2)"; note "      AX: $(AXM sel)"
  note "    select-heading-row ordinal 3: $(selh 3)"; note "      AX: $(AXM sel)"

  note ""
  note "  --- chord the heading that sits just BELOW the archived slot, ⌘↑ ---"
  note "    live headings (status=0): $(gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$PA' AND type=2 AND trashed=0 AND status=0 ORDER BY \"index\" ASC)")"
  note "    ALL headings:             $(horder "$PA")"
  snap c7a-before "%$STAMP%"
  bmark "cell7a2 chord below the archived slot"
  note "    select ordinal 1 (the 2nd heading the walk can reach): $(selh 1)"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER live headings: $(gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$PA' AND type=2 AND trashed=0 AND status=0 ORDER BY \"index\" ASC)")"
  note "    AFTER ALL headings:  $(horder "$PA")"
  snap c7a-after "%$STAMP%"
  snapdiff c7a-before c7a-after "7a' ⌘↑ on the heading below the archived slot"

  note ""
  note "  --- and again, to drive it THROUGH the archived slot ---"
  snap c7a2-before "%$STAMP%"
  bmark "cell7a2 second chord"
  note "    select ordinal 1: $(selh 1)"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER ALL headings: $(horder "$PA")"
  snap c7a2-after "%$STAMP%"
  snapdiff c7a2-before c7a2-after "7a' second ⌘↑"

  note ""
  note "  --- cell 7a' beeps ---"
  bs assert --allow 0 --name chord2-cell7a2 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 7 — extra
#
# Two late additions.
#   7a  THE ARCHIVED-HEADING RENDER QUESTION (asked by the #606 build track).
#       `project.move-heading` refuses in any project holding an archived
#       heading because its row addressing is POSITIONAL. If an archived heading
#       does not render as a content row at all, that fence can be lifted — so:
#       does it render, and does the chord's ±1 count or skip its slot?
#   7b  the TRUE template row in a project list (§9e). Cell 5c clicked the first
#       row bearing the title, which is the visible OCCURRENCE, not the rule row
#       — `add-repeating` leaves BOTH in the project and they share a title. The
#       rule row is the one carrying the repeat-day badge.
if [ "$CMD" = "extra" ]; then
  load_session
  bs reset >/dev/null; bmark "cell7 setup"
  note ""
  note "############### CELL 7 — the archived heading, and the TRUE template row ###############"
  STAMP=$(date +%H%M%S)

  # ---- 7a: does an ARCHIVED heading render as a row? ----------------------
  note ""
  note "  --- 7a: an ARCHIVED heading — does it render, and does ±1 count its slot? ---"
  seed_project "C2AR-P-$STAMP" "AH1-$STAMP" "AH2-$STAMP" "AH3-$STAMP" "AH4-$STAMP"
  PA=$(pid "C2AR-P-$STAMP")
  note "    project=$PA"
  note "    BEFORE the archive — heading order: $(horder "$PA")"
  warm
  show "things:///show?id=$PA"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  note "    row census BEFORE the archive:"
  AXM rows > "$OUT/ax/arch-before.txt" 2>&1
  head -14 "$OUT/ax/arch-before.txt" | sed 's/^/      /' | tee -a "$REPORT"
  NB=$(grep -c "Heading More Template" "$OUT/ax/arch-before.txt")
  note "    heading rows visible BEFORE: $NB"

  bmark "cell7a archive"
  H2=$(hid "AH2-$STAMP")
  note "    archive AH2 ($H2):"
  G project archive-heading "$PA" "$H2" --json 2>&1 | tail -3 | sed 's/^/      /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
  note "    DB after the archive:"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, type, status, \"index\" AS idx, trashed FROM TMTask WHERE project='$PA' AND type=2 ORDER BY \"index\"" | sed 's/^/      /' | tee -a "$REPORT"
  warm
  show "things:///show?id=$PA"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  note "    row census AFTER the archive:"
  AXM rows > "$OUT/ax/arch-after.txt" 2>&1
  head -14 "$OUT/ax/arch-after.txt" | sed 's/^/      /' | tee -a "$REPORT"
  NA=$(grep -c "Heading More Template" "$OUT/ax/arch-after.txt")
  note "    heading rows visible AFTER: $NA  (was $NB)"
  note "    does the archived heading's title still appear anywhere in the tree? $(grep -c "AH2-$STAMP" "$OUT/ax/arch-after.txt")"
  if [ "$NA" -lt "$NB" ]; then note "    *** the ARCHIVED heading does NOT render as a content row ***"
  else note "    *** the ARCHIVED heading STILL renders as a content row ***"; fi

  note ""
  note "  --- 7a2: chord the heading BELOW the archived slot ⌘↑ — does it skip or count it? ---"
  note "    live heading order (status=0): $(gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$PA' AND type=2 AND trashed=0 AND status=0 ORDER BY \"index\" ASC)")"
  note "    ALL headings incl. archived:   $(horder "$PA")"
  snap a7a-before "%$STAMP%"
  bmark "cell7a2 chord past the archived slot"
  note "    select heading ordinal 1 by the SHIPPED positional walk: $(selh 1)"
  note "    Things selected to dos (empty == a heading): [$(axq 'tell application "Things3" to get name of selected to dos')]"
  note "    AX says: $(AXM sel)"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER live heading order: $(gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$PA' AND type=2 AND trashed=0 AND status=0 ORDER BY \"index\" ASC)")"
  note "    AFTER all headings:       $(horder "$PA")"
  snap a7a-after "%$STAMP%"
  snapdiff a7a-before a7a-after "7a2 chord ⌘↑ on a heading adjacent to an archived one"

  note ""
  note "  --- 7a3: ⌘↑ again — can a live heading be driven THROUGH the archived slot? ---"
  snap a7a3-before "%$STAMP%"
  bmark "cell7a3 second chord"
  note "    select heading ordinal 0: $(selh 0)"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER all headings: $(horder "$PA")"
  snap a7a3-after "%$STAMP%"
  snapdiff a7a3-before a7a3-after "7a3 second ⌘↑"

  # ---- 7b: the TRUE template row (the rule row, not the occurrence) -------
  note ""
  note "  --- 7b: the TRUE repeating-TEMPLATE row in a project list (§9e) ---"
  seed_todos "C2T3-P-$STAMP" "S1-$STAMP" "S2-$STAMP" "S3-$STAMP"
  PS=$(pid "C2T3-P-$STAMP")
  G todo add-repeating "\"ST-$STAMP\"" --project "$PS" --frequency daily --interval 1 --dangerously-drive-gui --json >/dev/null 2>&1
  lab_ssh "$IP" 'sleep 4' </dev/null
  TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='ST-$STAMP' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1")
  INST=$(gq "SELECT uuid FROM TMTask WHERE title='ST-$STAMP' AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1")
  note "    project=$PS  template=[$TMPL]  occurrence=[$INST]"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, \"index\" AS idx, todayIndex AS tidx, start, startDate AS sd, CASE WHEN rt1_recurrenceRule IS NULL THEN 'plain' ELSE 'TEMPLATE' END AS kind FROM TMTask WHERE title LIKE 'S%$STAMP%' AND trashed=0 ORDER BY \"index\"" | sed 's/^/      /' | tee -a "$REPORT"
  warm
  show "things:///show?id=$PS"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
  note "    row census:"
  AXM rows > "$OUT/ax/tmpl3-project.txt" 2>&1
  head -9 "$OUT/ax/tmpl3-project.txt" | sed 's/^/      /' | tee -a "$REPORT"
  note "    order by index: $(vorder "S%$STAMP%" '"index"')"
  snap b7b-before "S%$STAMP%"
  bmark "cell7b true template row"
  note "    click the row carrying the repeat-day badge (Mon): $(clickrow "ST-$STAMP" "Mon")"
  lab_ssh "$IP" 'sleep 1' </dev/null
  SELID=$(axq 'tell application "Things3" to get id of selected to dos')
  note "    selected ids: [$SELID]"
  if [ "$SELID" = "$TMPL" ]; then note "    *** the TEMPLATE (rule) row is selected ***"
  else note "    (selected $SELID — template is $TMPL, occurrence is $INST)"; fi
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER order by index: $(vorder "S%$STAMP%" '"index"')"
  snap b7b-after "S%$STAMP%"
  snapdiff b7b-before b7b-after "7b TRUE template row ⌘↑ in a project list"

  note ""
  note "  --- 7b2: ⌘⌥↑ on the TRUE template row ---"
  snap b7b2-before "S%$STAMP%"
  bmark "cell7b2 true template to top"
  note "    click: $(clickrow "ST-$STAMP" "Mon")"
  lab_ssh "$IP" 'sleep 1' </dev/null
  note "    selected ids: [$(axq 'tell application "Things3" to get id of selected to dos')]"
  note "    chord ⌘⌥↑: $(chord $KUP $FCMDOPT)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    AFTER order by index: $(vorder "S%$STAMP%" '"index"')"
  snap b7b2-after "S%$STAMP%"
  snapdiff b7b2-before b7b2-after "7b2 TRUE template row ⌘⌥↑"

  note ""
  note "  --- cell 7 beeps ---"
  bs assert --allow 0 --name chord2-cell7 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== CELL 6 — side
if [ "$CMD" = "side" ]; then
  load_session
  bs reset >/dev/null; bmark "cell6 setup"
  note ""
  note "############### CELL 6 — SIDE-EFFECT SWEEP ###############"
  STAMP=$(date +%H%M%S)
  # The checklist-bearing row is built through the CLI: a `things:///json` add
  # carrying `checklist-items` silently rejected the WHOLE payload (first pass —
  # the project never appeared), so the checklist is attached on its own leg.
  seed_todos "C2SD-P-$STAMP" "E1-$STAMP" "E3-$STAMP" "E4-$STAMP"
  PE=$(pid "C2SD-P-$STAMP")
  note "  project=$PE — adding the checklist-bearing row through the CLI"
  G todo add "\"E2-$STAMP\"" --project "$PE" --notes "\"synthetic note\"" \
     --checklist-item ck-a --checklist-item ck-b --checklist-item ck-c --json 2>&1 | tail -2 | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
  note "  project=$PE"
  note "  checklist rows on E2: $(gq "SELECT COUNT(*) FROM TMChecklistItem WHERE task=(SELECT uuid FROM TMTask WHERE title='E2-$STAMP' AND trashed=0)")"
  warm
  show "things:///show?id=$PE"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "  START: $(torder "$PE")"

  # ---- 6a: umd on a plain to-do chord -------------------------------------
  note ""
  note "  --- 6a: does a to-do chord stamp userModificationDate? ---"
  snap s6a-before "E_-$STAMP"
  bmark "cell6a umd"
  note "    select E3: $(selrow "E3-$STAMP")"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap s6a-after "E_-$STAMP"
  snapdiff s6a-before s6a-after "6a to-do ⌘↑ (umd?)"

  # ---- 6b: the checklist-bearing row --------------------------------------
  note ""
  note "  --- 6b: chord the CHECKLIST-bearing row — do its children survive? ---"
  CKB=$(gq "SELECT group_concat(title||':'||\"index\",' ') FROM (SELECT title, \"index\" FROM TMChecklistItem WHERE task=(SELECT uuid FROM TMTask WHERE title='E2-$STAMP' AND trashed=0) ORDER BY \"index\")")
  note "    checklist before: [$CKB]"
  snap s6b-before "E_-$STAMP"
  bmark "cell6b checklist"
  note "    select E2: $(selrow "E2-$STAMP")"
  note "    chord ⌘⌥↓: $(chord $KDOWN $FCMDOPT)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    checklist after:  [$(gq "SELECT group_concat(title||':'||\"index\",' ') FROM (SELECT title, \"index\" FROM TMChecklistItem WHERE task=(SELECT uuid FROM TMTask WHERE title='E2-$STAMP' AND trashed=0) ORDER BY \"index\")")]"
  note "    order: $(torder "$PE")"
  snap s6b-after "E_-$STAMP"
  snapdiff s6b-before s6b-after "6b checklist row ⌘⌥↓"

  # ---- 6c: the beep 1:1 reliability ---------------------------------------
  note ""
  note "  --- 6c: is a DECLINE always exactly one beep + zero delta? ---"
  bs reset >/dev/null
  bmark "cell6c burst"
  LAST=$(gq "SELECT title FROM TMTask WHERE project='$PE' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" DESC LIMIT 1")
  NROWS=$(gq "SELECT COUNT(*) FROM TMTask WHERE project='$PE' AND type=0 AND heading IS NULL AND trashed=0")
  note "    bottom row [$LAST]; the project has $NROWS loose rows"
  note "    select: $(selrow "$LAST")"
  B=$(torder "$PE"); note "    before: $B"
  note "    10 x ⌘↑ in ONE round trip: $(chord $KUP $FCMD 10)"
  lab_ssh "$IP" 'sleep 3' </dev/null
  note "    after : $(torder "$PE")"
  note "    expected: $((NROWS-1)) productive chords, $((10-NROWS+1)) declines => that many beeps"
  bs assert --allow 0 --name chord2-cell6c | sed 's/^/    /' | tee -a "$REPORT"

  # ---- 6d: the ⌘⌥ decline (already at the top) ----------------------------
  note ""
  note "  --- 6d: ⌘⌥↑ on a row ALREADY at the top — decline, or a silent no-op? ---"
  bs reset >/dev/null
  bmark "cell6d cmd-opt-up at top"
  FIRST=$(gq "SELECT title FROM TMTask WHERE project='$PE' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" ASC LIMIT 1")
  note "    top row [$FIRST]"
  snap s6d-before "E_-$STAMP"
  note "    select: $(selrow "$FIRST")"
  note "    chord ⌘⌥↑: $(chord $KUP $FCMDOPT)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap s6d-after "E_-$STAMP"
  snapdiff s6d-before s6d-after "6d ⌘⌥↑ on the top row"
  bs assert --allow 0 --name chord2-cell6d | sed 's/^/    /' | tee -a "$REPORT"

  # ---- 6e: NO selection at all --------------------------------------------
  note ""
  note "  --- 6e: the chord with NOTHING selected ---"
  bs reset >/dev/null
  bmark "cell6e no selection"
  warm
  show "things:///show?id=$PE"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "    selected: [$(axq 'tell application "Things3" to get name of selected to dos')]"
  snap s6e-before "E_-$STAMP"
  note "    chord ⌘↑: $(chord $KUP $FCMD)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  snap s6e-after "E_-$STAMP"
  snapdiff s6e-before s6e-after "6e chord with no selection"
  bs assert --allow 0 --name chord2-cell6e | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ==================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "stopping + deleting $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  note "VM table now —"
  tart list 2>/dev/null | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

echo "usage: $0 {setup|bg|multi|bounds|views|tmpl|side|teardown}" >&2
exit 2
