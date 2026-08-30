#!/bin/bash
# SBCOL1 — the sidebar disclosure chevron: can the driver COLLAPSE an area
# section, cross it with the certified drag, and put the sidebar back?
#
# BACKGROUND. AXDRAG5 (#658/#659) proved the tall-section WALL: an area's sidebar
# section is its row plus every project row Things renders under it, and both
# shipped drag rungs need the grab point and the drop boundary visible AT ONCE,
# so a section taller than one drag's usable span can never be crossed. The
# shipped pre-flight now refuses honestly and tells the USER to collapse the
# blocking area by clicking its disclosure chevron. This campaign asks whether
# the DRIVER can do that itself.
#
# The chevron is already on record: AXDRAG2-b found a persistent 18x18
# `AXImage d="Source Toggle Template"` child on every area row, present before
# and after hover, with an EMPTY AXUIElementCopyActionNames on the row — i.e.
# frame-resolvable but (on that evidence) not AXPress-able. REPX1 §1.2 is the
# governing rig lesson: AXPress on Things' custom rows is DECORATIVE (AXError=0,
# zero delta), while a frame-targeted CGEvent click at the element's own AX frame
# actuates it. Set flags EXPLICITLY on every synthetic event (zero included).
#
# CELLS:
#   axdump   harvest the area row's descendant AX nodes: role/subrole/desc/frame/
#            actions, before AND after a real pointer hover over the row (does the
#            chevron only materialize on hover?). Also: the row's own actions.
#   chevron  CGEvent-click the chevron frame. Oracle: the rendered row census
#            before/after (do the area's project rows disappear/reappear?), toggled
#            BOTH directions, TWICE. Plus the cheap alternatives: a plain click on
#            the row body, and a double-click.
#   where    WHERE does the collapse state live? Full-table DB diff (every table's
#            row count + a content digest), the app's prefs domain, and the group
#            container's plists, captured expanded -> collapsed -> expanded.
#   persist  does a collapse survive an app relaunch?
#   assisted the AXDRAG5 wall move, run MANUALLY collapse-first: collapse the wall
#            area with the measured gesture, run the SHIPPED CLI drag across it,
#            verify placement + invariants, restore the disclosure state, and
#            assert the restored census matches the pre-drive census byte-for-byte.
#   multi    two tall areas on the travel span: collapse both, drag, restore both.
#   auto     the CODE LEG's acceptance cell: the same wall move with NO manual
#            collapse — the shipped driver must do it and put it back.
#   reship   rebuild + redeploy dist (re-run `auto` against the new driver).
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (trial wall
# 2026-07-18). Fixtures fully synthetic. Clone destroyed on teardown.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-sbcol1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)
note() { echo "[sbcol1] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
front() { axq 'tell application "System Events" to return name of first process whose frontmost is true'; }
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; true' </dev/null; }

# ---- the beep sentinel (probe opt-out: counted, never failing) --------------
bs()    { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh $*" </dev/null 2>&1; }
bmark() { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }

# ---- the disruption monitor slice ------------------------------------------
mon_mark()  { MON_AT=$(lab_ssh "$IP" 'wc -l < ~/things-lab/events.ndjson 2>/dev/null || echo 0' </dev/null | tr -d ' '); }
mon_slice() { lab_ssh "$IP" "tail -n +$(( ${MON_AT:-0} + 1 )) ~/things-lab/events.ndjson 2>/dev/null" </dev/null; }
mon_verdict() {
  local sl nl steal wins launch
  sl=$(mon_slice); nl=$(printf '%s' "$sl" | grep -c . )
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

# ---- the sidebar oracles ----------------------------------------------------
area_order()  { gq 'SELECT COALESCE(group_concat(t," < "),"(none)") FROM (SELECT title AS t FROM TMArea ORDER BY "index", uuid)'; }
area_vector() { gq 'SELECT title||"="||"index" FROM TMArea ORDER BY "index", uuid' | tr '\n' ' '; }
assign_digest() { gq "SELECT uuid||':'||COALESCE(area,'') FROM TMTask WHERE trashed=0 ORDER BY uuid" | shasum | cut -c1-12; }
areacount()   { gq 'SELECT COUNT(*) FROM TMArea'; }
# every user-data table, digested — the umd-silence oracle for a pure-UI gesture
db_digest()   { lab_ssh "$IP" '~/labh/dbdigest.sh' </dev/null 2>&1; }

snapjson() { lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/sidebar-snap.js' </dev/null 2>/dev/null; }
rowdump()  { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/rowdump.js $(printf '%q' "$1") ${2:-0}" </dev/null 2>&1; }
clickat()  { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/click.js $1 $2 ${3:-1}" </dev/null 2>&1; }
scrollby() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/scroll.js $1" </dev/null 2>&1; }
pressch()  { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/press.js $(printf '%q' "$1") ${2:-AXPress}" </dev/null 2>&1; }
hoverat()  { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/hover.js $1 $2" </dev/null 2>&1; }
setwin() { lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set size of (first window whose subrole is \"AXStandardWindow\") to {$1, $2}'" </dev/null 2>&1; }

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }

# The chevron point for an area row, from the LIVE tree: "<chevX> <chevY> <rowX>
# <rowY> <OK|OFFBAND|NOCHEVRON|MISSING>". An OFF-VIEWPORT row still exposes a
# valid virtualized frame (AXDRAG1) — clicking one would land outside the
# sidebar entirely, so band membership is part of the verdict, never assumed.
chev_pt() { # <title>
  rowdump "$1" 0 > "$OUT/ax/ch-$1.json"
  python3 - "$OUT/ax/ch-$1.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if 'error' in d:
    print("0 0 0 0 MISSING"); raise SystemExit
vp = d.get('viewport') or {}
row = (d['nodes'][0]['frame'] or {}) if d.get('nodes') else {}
chev = None
for n in d.get('nodes', [])[1:]:
    f = n['frame']
    if f and n['role'] == 'AXImage' and 'Toggle' in (n['desc'] or ''):
        chev = f; break
if chev is None:
    for n in d.get('nodes', [])[1:]:
        f = n['frame']
        if not f or n['role'] != 'AXImage': continue
        if f['w'] <= 24 and (chev is None or f['x'] > chev['x']): chev = f
rx = round(row.get('x', 0) + row.get('w', 0) * 0.5)
ry = round(row.get('y', 0) + row.get('h', 0) / 2)
if chev is None:
    print("0 0 %d %d NOCHEVRON" % (rx, ry)); raise SystemExit
cx = round(chev['x'] + chev['w'] / 2); cy = round(chev['y'] + chev['h'] / 2)
inband = bool(vp) and (vp['y'] + 6 <= cy <= vp['y'] + vp['h'] - 6)
print("%d %d %d %d %s" % (cx, cy, rx, ry, "OK" if inband else "OFFBAND"))
PY
}

# Scroll the sidebar until the area's chevron is inside the visible band, then
# echo the (re-resolved) point. Every scroll is followed by a re-read — the
# frames a scroll produced are the only ones worth aiming at.
chev_pt_in_band() { # <title>
  local title="$1" pt state i err vy vh cy
  for i in $(seq 1 12); do
    pt=$(chev_pt "$title"); state=$(echo "$pt" | awk '{print $5}')
    [ "$state" = "OK" ] && { echo "$pt"; return 0; }
    [ "$state" = "MISSING" ] || [ "$state" = "NOCHEVRON" ] && { echo "$pt"; return 1; }
    cy=$(echo "$pt" | awk '{print $2}')
    vy=$(python3 -c "import json;d=json.load(open('$OUT/ax/ch-$title.json'));v=d.get('viewport') or {};print(int(v.get('y',0)))")
    vh=$(python3 -c "import json;d=json.load(open('$OUT/ax/ch-$title.json'));v=d.get('viewport') or {};print(int(v.get('h',0)))")
    # positive wheel clicks move the content DOWN (row y grows) — AXDRAG1-b
    err=$(( vy + vh / 2 - cy ))
    scrollby "$(( err > 0 ? (err > 240 ? 8 : 3) : (err < -240 ? -8 : -3) ))" >/dev/null
    sleep 1
  done
  chev_pt "$title"; return 1
}

# The section census: one line per area — top / height / rendered rows.
# This IS the collapse oracle (a collapsed area renders its own row and nothing
# else) and the RESTORE oracle (byte-for-byte comparison of the whole block).
census() { # <label> [outfile]
  local label="$1" f="${2:-$OUT/census-$1.txt}"
  snapjson > "$OUT/snap-$label.json"
  local titles; titles=$(gq 'SELECT group_concat(title, "|") FROM (SELECT title FROM TMArea ORDER BY "index", uuid)')
  python3 - "$OUT/snap-$label.json" "$titles" > "$f" <<'PY'
import json, sys
snap = json.load(open(sys.argv[1]))
titles = [t for t in sys.argv[2].split('|') if t]
vp = snap.get('viewport') or {}
rows = [r for r in snap['rows'] if r.get('y') is not None]
rows.sort(key=lambda r: r['y'])
def is_area(r):
    segs = (r.get('text') or '').split('|')
    for t in titles:
        if t in segs or (t + '.') in segs:
            return t
    return None
areas = [(t, r) for (t, r) in ((is_area(r), r) for r in rows) if t]
bottom = max((r['y'] + r['h']) for r in rows) if rows else 0
usable = (vp.get('h') or 0) - 24
print("viewport y=%s h=%s usable=%s  table-rows=%d  area-rows=%d/%d"
      % (vp.get('y'), vp.get('h'), usable, len(rows), len(areas), len(titles)))
for i, (t, r) in enumerate(areas):
    nxt = areas[i+1][1]['y'] if i + 1 < len(areas) else bottom
    h = nxt - r['y']
    n = len([x for x in rows if r['y'] <= x['y'] < nxt])
    print("%-12s top=%-7.0f height=%-6.0f rows=%-3d %s"
          % (t, r['y'], h, n, "WALL" if h > usable else "fits"))
PY
  cat "$f"
}

# ============================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "=== SBCOL1 setup — $(date) ==="
  df -g /Volumes/Workspace | tail -1 | tee -a "$REPORT"
  if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }; fi
  [ -f dist/cli/main.js ] || { echo "no dist/cli/main.js" >&2; exit 1; }

  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || exit 1
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "guest ip: $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  note "airgap: $AG"; [ "$AG" = "AIRGAP-OK" ] || exit 1
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "clock: $(lab_ssh "$IP" 'date' </dev/null)"

  lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  printf '%s\n' "$GSQL" | lab_ssh "$IP" 'cat > ~/labh/gsql.sh; chmod +x ~/labh/gsql.sh'
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null 2>&1
  lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null
  note "monitor: $(lab_ssh "$IP" 'launchctl list | grep -i disrupt || echo none' </dev/null)"

  # --- guest helper: full-table DB digest (the umd-silence oracle) -----------
  lab_ssh "$IP" 'cat > ~/labh/dbdigest.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
for T in $(sqlite3 "file:$DB?mode=ro" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"); do
  N=$(sqlite3 "file:$DB?mode=ro" "SELECT COUNT(*) FROM \"$T\"" 2>/dev/null)
  D=$(sqlite3 "file:$DB?mode=ro" ".mode list" "SELECT * FROM \"$T\"" 2>/dev/null | shasum | cut -c1-12)
  echo "$T rows=$N digest=$D"
done
EOF
  lab_ssh "$IP" 'chmod +x ~/labh/dbdigest.sh' </dev/null

  # --- guest helper: dump an area row's descendant AX nodes ------------------
  # argv: <area title> [hoverFirst]  — role/subrole/desc/title/frame/actions per
  # descendant, plus the ROW's own action names. REPX1 §1.2: actions may be
  # decorative, so the FRAME is what matters.
  lab_ssh "$IP" 'cat > ~/labh/rowdump.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]) }
function sv(el,name){ var v=attr(el,name); return v? v.js : '' }
function frame(el){ var p=attr(el,'AXPosition'), z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function acts(el){ var out=Ref(); if($.AXUIElementCopyActionNames(el,out)!==0) return '(err)';
  var a=ObjC.castRefToObject(out[0]); if(!a) return '(none)'; var s=[]; for(var i=0;i<a.count;i++) s.push(a.objectAtIndex(i).js);
  return s.length? s.join(',') : '(none)' }
function findAll(el, wantRole, depth, acc){ acc=acc||[]; if(depth<0) return acc; var ch=kids(el);
  for(var i=0;i<ch.length;i++){ if(sv(ch[i],'AXRole')===wantRole) acc.push(ch[i]); findAll(ch[i], wantRole, depth-1, acc) } return acc }
function appEl(){ return $.AXUIElementCreateApplication(pidOf('Things3')) }
function stdWindow(){ var ws=kids(appEl()); for(var i=0;i<ws.length;i++){ if(sv(ws[i],'AXSubrole')==='AXStandardWindow') return ws[i] } return ws.length?ws[0]:null }
function sidebarTable(){ var w=stdWindow(); if(!w) return null; var tables=findAll(w,'AXTable',12,[]); var best=null;
  for(var i=0;i<tables.length;i++){ var f=frame(tables[i]); if(!f) continue; if(f.w<400){ if(!best||f.w<best.f.w) best={el:tables[i],f:f} } }
  return best?best.el:null }
function allText(el, acc, depth){ acc=acc||[]; depth=depth==null?6:depth; if(depth<0) return acc;
  var v=sv(el,'AXValue'); if(v) acc.push(v); var d=sv(el,'AXDescription'); if(d) acc.push(d);
  var t=sv(el,'AXTitle'); if(t) acc.push(t); var ch=kids(el); for(var i=0;i<ch.length;i++) allText(ch[i],acc,depth-1); return acc }
function walk(el, depth, path, out){
  var f=frame(el);
  out.push({ path: path, role: sv(el,'AXRole'), sub: sv(el,'AXSubrole'), desc: sv(el,'AXDescription'),
             title: sv(el,'AXTitle'), value: sv(el,'AXValue'), frame: f, actions: acts(el) });
  if (depth<=0) return out;
  var ch=kids(el); for (var i=0;i<ch.length;i++) walk(ch[i], depth-1, path+'/'+i, out); return out }
function run(argv){
  var want=argv[0], hover=argv[1]==='1';
  var t=sidebarTable(); if(!t) return JSON.stringify({error:'no sidebar table'});
  var ch=kids(t), row=null;
  for(var i=0;i<ch.length;i++){ var r=sv(ch[i],'AXRole'); if(r!=='AXRow'&&r!=='AXTableRow') continue;
    var segs=allText(ch[i],[],6); for(var j=0;j<segs.length;j++){ if(segs[j]===want||segs[j]===want+'.'){ row=ch[i]; break } }
    if(row) break }
  if(!row) return JSON.stringify({error:'row not found for '+want});
  if (hover) { var rf=frame(row);
    if (rf) { var e=$.CGEventCreateMouseEvent($(), 5, $.CGPointMake(rf.x+rf.w*0.5, rf.y+rf.h/2), 0);
      $.CGEventSetFlags(e, 0); $.CGEventPost($.kCGHIDEventTap, e); sleepMs(900) } }
  var vp=null, w=stdWindow();
  if (w) { var sas=findAll(w,'AXScrollArea',12,[]);
    for (var k=0;k<sas.length;k++){ var vf=frame(sas[k]); if(vf && vf.w<400){ vp=vf; break } } }
  return JSON.stringify({ hovered: hover, viewport: vp, rowActions: acts(row), nodes: walk(row, 4, '', []) }) }
EOF

  # --- guest helper: positionless wheel scroll over the sidebar --------------
  lab_ssh "$IP" 'cat > ~/labh/scroll.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]) }
function sv(el,name){ var v=attr(el,name); return v? v.js : '' }
function frame(el){ var p=attr(el,'AXPosition'), z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function findAll(el, wantRole, depth, acc){ acc=acc||[]; if(depth<0) return acc; var ch=kids(el);
  for(var i=0;i<ch.length;i++){ if(sv(ch[i],'AXRole')===wantRole) acc.push(ch[i]); findAll(ch[i], wantRole, depth-1, acc) } return acc }
function appEl(){ return $.AXUIElementCreateApplication(pidOf('Things3')) }
function stdWindow(){ var ws=kids(appEl()); for(var i=0;i<ws.length;i++){ if(sv(ws[i],'AXSubrole')==='AXStandardWindow') return ws[i] } return ws.length?ws[0]:null }
function run(argv){
  var n=+argv[0], w=stdWindow(), sb=null;
  if (w) { var sas=findAll(w,'AXScrollArea',12,[]);
    for (var i=0;i<sas.length;i++){ var f=frame(sas[i]); if(f && f.w<400){ sb=f; break } } }
  if (!sb) return 'NO_SIDEBAR';
  var mv=$.CGEventCreateMouseEvent($(), 5, $.CGPointMake(sb.x+sb.w/2, sb.y+sb.h/2), 0);
  $.CGEventSetFlags(mv, 0); $.CGEventPost($.kCGHIDEventTap, mv); sleepMs(60);
  var dir = n < 0 ? -1 : 1;
  for (var i=0; i<Math.abs(n); i++){
    var ev=$.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, dir*3);
    $.CGEventPost($.kCGHIDEventTap, ev); sleepMs(60) }
  return 'SCROLLED '+n }
EOF

  # --- guest helper: AXPress the chevron's actionable WRAPPER ----------------
  # axdump found the toggle is TWO nodes: an inert `AXImage d="Source Toggle
  # Template"` (what AXDRAG2-b measured) inside an `AXUnknown` wrapper that DOES
  # advertise AXPress. REPX1 §1.2 says AXPress on Things' custom rows is
  # decorative, so this arm exists to be falsified — a press that works is a
  # pointerless, focus-free collapse and beats the click outright.
  lab_ssh "$IP" 'cat > ~/labh/press.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]) }
function sv(el,name){ var v=attr(el,name); return v? v.js : '' }
function frame(el){ var p=attr(el,'AXPosition'), z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function findAll(el, wantRole, depth, acc){ acc=acc||[]; if(depth<0) return acc; var ch=kids(el);
  for(var i=0;i<ch.length;i++){ if(sv(ch[i],'AXRole')===wantRole) acc.push(ch[i]); findAll(ch[i], wantRole, depth-1, acc) } return acc }
function appEl(){ return $.AXUIElementCreateApplication(pidOf('Things3')) }
function stdWindow(){ var ws=kids(appEl()); for(var i=0;i<ws.length;i++){ if(sv(ws[i],'AXSubrole')==='AXStandardWindow') return ws[i] } return ws.length?ws[0]:null }
function sidebarTable(){ var w=stdWindow(); if(!w) return null; var tables=findAll(w,'AXTable',12,[]); var best=null;
  for(var i=0;i<tables.length;i++){ var f=frame(tables[i]); if(!f) continue; if(f.w<400){ if(!best||f.w<best.f.w) best={el:tables[i],f:f} } }
  return best?best.el:null }
function allText(el, acc, depth){ acc=acc||[]; depth=depth==null?6:depth; if(depth<0) return acc;
  var v=sv(el,'AXValue'); if(v) acc.push(v); var d=sv(el,'AXDescription'); if(d) acc.push(d);
  var t=sv(el,'AXTitle'); if(t) acc.push(t); var ch=kids(el); for(var i=0;i<ch.length;i++) allText(ch[i],acc,depth-1); return acc }
// The chevron WRAPPER: the ancestor of the "Source Toggle Template" image.
function toggleWrapper(el, depth){
  var ch=kids(el);
  for (var i=0;i<ch.length;i++){
    if (sv(ch[i],'AXRole')==='AXImage' && sv(ch[i],'AXDescription').indexOf('Toggle')>=0) return el;
    if (depth>0) { var r=toggleWrapper(ch[i], depth-1); if(r) return r }
  }
  return null }
function run(argv){
  var want=argv[0], action=argv[1]||'AXPress';
  var t=sidebarTable(); if(!t) return 'NO_SIDEBAR';
  var ch=kids(t), row=null;
  for(var i=0;i<ch.length;i++){ var r=sv(ch[i],'AXRole'); if(r!=='AXRow'&&r!=='AXTableRow') continue;
    var segs=allText(ch[i],[],6); for(var j=0;j<segs.length;j++){ if(segs[j]===want||segs[j]===want+'.'){ row=ch[i]; break } }
    if(row) break }
  if(!row) return 'ROW_NOT_FOUND';
  var wrap=toggleWrapper(row, 5);
  if(!wrap) return 'NO_TOGGLE_WRAPPER';
  var err=$.AXUIElementPerformAction(wrap, $(action));
  return 'AXError='+err+' action='+action+' wrapperFrame='+JSON.stringify(frame(wrap)) }
EOF

  # --- guest helper: an explicit-flag CGEvent click (REPX1 §1.2 rig law) -----
  # argv: <x> <y> [clickCount]. Flags set EXPLICITLY (zero included) on EVERY
  # event; a MOVED settle first, because a click without a preceding move can
  # land against a stale hover state.
  lab_ssh "$IP" 'cat > ~/labh/click.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function run(argv){
  var x=+argv[0], y=+argv[1], n=argv[2]?+argv[2]:1;
  function post(t, cc){ var e=$.CGEventCreateMouseEvent($(), t, $.CGPointMake(x,y), 0);
    $.CGEventSetFlags(e, 0);
    if (cc) $.CGEventSetIntegerValueField(e, 1, cc);   // kCGMouseEventClickState
    $.CGEventPost($.kCGHIDEventTap, e) }
  post(5, 0); sleepMs(350);
  for (var i=1; i<=n; i++) { post(1, i); sleepMs(90); post(2, i); sleepMs(i<n?90:250) }
  return 'CLICKED '+x+','+y+' x'+n }
EOF

  # --- guest helper: a bare pointer move (hover) -----------------------------
  lab_ssh "$IP" 'cat > ~/labh/hover.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function run(argv){
  var x=+argv[0], y=+argv[1];
  var e=$.CGEventCreateMouseEvent($(), 5, $.CGPointMake(x,y), 0);
  $.CGEventSetFlags(e, 0); $.CGEventPost($.kCGHIDEventTap, e); sleepMs(900);
  return 'HOVER '+x+','+y }
EOF

  # the SHIPPED sidebar snapshot script (the exact one the driver runs)
  node -e "import('./dist/write/vectors/ui-drag.js').then(m=>process.stdout.write(m.jxaSidebarSnapshotScript()))" > "$OUT/sidebar-snap.js"
  lab_ssh "$IP" 'cat > ~/labh/sidebar-snap.js' < "$OUT/sidebar-snap.js"

  warm
  VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null | tr '\n' '/')
  OSV=$(lab_ssh "$IP" 'sw_vers -productVersion; sw_vers -buildVersion' </dev/null | tr '\n' '/')
  note "things: $VER  macos: $OSV  db: $(gq 'SELECT value FROM Meta WHERE key="databaseVersion"' 2>/dev/null)"

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "cli: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1)"

  echo "IP=$IP" > "$SESSION"
  note "=== setup done ==="
  exit 0
fi

# ============================================================== reship
if [ "$CMD" = "reship" ]; then
  load_session
  npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  node -e "import('./dist/write/vectors/ui-drag.js').then(m=>process.stdout.write(m.jxaSidebarSnapshotScript()))" > "$OUT/sidebar-snap.js"
  lab_ssh "$IP" 'cat > ~/labh/sidebar-snap.js' < "$OUT/sidebar-snap.js"
  note "reshipped dist ($(date))"
  exit 0
fi

# ============================================================== seed
# The AXDRAG5 field shape plus a SECOND wall (Sigma) for the multi-wall cell.
if [ "$CMD" = "seed" ]; then
  load_session
  note "=== seed — two-wall sidebar ==="
  AREAS="Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Sigma Tau"
  for A in $AREAS; do
    lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to make new area with properties {name:\"$A\"}'" </dev/null >/dev/null 2>&1
    sleep 1
  done
  note "areas seeded: $(areacount)"
  seed_projects() { # <area> <count>
    local a="$1" n="$2" i
    for i in $(seq -w 1 "$n"); do
      lab_ssh "$IP" "open -g 'things:///add-project?title=$a-P$i&area=$a'" </dev/null >/dev/null 2>&1
      sleep 0.7
    done
  }
  seed_projects Alpha 2
  seed_projects Epsilon 3
  seed_projects Zeta 4
  seed_projects Eta "${ETA_PROJECTS:-24}"
  seed_projects Sigma "${SIGMA_PROJECTS:-20}"
  seed_projects Lambda 3
  seed_projects Mu 1
  sleep 3
  note "project census per area:"
  gt 'SELECT a.title AS area, COUNT(t.uuid) AS projects FROM TMArea a LEFT JOIN TMTask t ON t.area=a.uuid AND t.type=1 AND t.trashed=0 AND t.status=0 GROUP BY a.uuid ORDER BY a."index", a.uuid' | tee -a "$REPORT"
  note "area order: $(area_order)"
  note "index vector: $(area_vector)"
  exit 0
fi

# ============================================================== axdump
if [ "$CMD" = "axdump" ]; then
  load_session
  TARGET="${TARGET:-Eta}"
  note "=== axdump — the AX shape of area row \"$TARGET\" ==="
  warm
  W="${WIN_W:-935}"; H="${WIN_H:-420}"
  setwin "$W" "$H" >/dev/null; sleep 2
  note "  window ${W}x${H}"
  for HOVER in 0 1; do
    note "  --- descendants (hoverFirst=$HOVER) ---"
    rowdump "$TARGET" "$HOVER" > "$OUT/ax/rowdump-$TARGET-hover$HOVER.json"
    python3 - "$OUT/ax/rowdump-$TARGET-hover$HOVER.json" <<'PY' | tee -a "$REPORT"
import json, sys
d = json.load(open(sys.argv[1]))
if 'error' in d:
    print("  ERROR:", d['error']); raise SystemExit
print("  row actions: %s" % d['rowActions'])
for n in d['nodes']:
    f = n['frame'] or {}
    print("  %-10s %-14s %-12s d=%-26s t=%-12s v=%-10s frame=(%s,%s %sx%s) actions=%s" % (
        n['path'] or '(row)', n['role'], n['sub'], (n['desc'] or '')[:26], (n['title'] or '')[:12],
        (n['value'] or '')[:10], f.get('x'), f.get('y'), f.get('w'), f.get('h'), n['actions']))
PY
  done
  note "  --- diff between the two dumps (does hover materialize anything?) ---"
  if diff -q "$OUT/ax/rowdump-$TARGET-hover0.json" "$OUT/ax/rowdump-$TARGET-hover1.json" >/dev/null 2>&1; then
    note "  IDENTICAL node sets (modulo the hovered flag) — the chevron is NOT hover-drawn"
  else
    note "  node sets DIFFER — see the two dumps"
    diff <(python3 -c "import json,sys;print('\n'.join(sorted(n['role']+'|'+n['desc'] for n in json.load(open(sys.argv[1]))['nodes'])))" "$OUT/ax/rowdump-$TARGET-hover0.json") \
         <(python3 -c "import json,sys;print('\n'.join(sorted(n['role']+'|'+n['desc'] for n in json.load(open(sys.argv[1]))['nodes'])))" "$OUT/ax/rowdump-$TARGET-hover1.json") | sed 's/^/    /' | tee -a "$REPORT"
  fi
  exit 0
fi

# ============================================================== chevron
# THE CELL. CGEvent-click the chevron's own AX frame; census before/after.
# Then the cheap alternatives on the row BODY: single click, double click.
if [ "$CMD" = "chevron" ]; then
  load_session
  TARGET="${TARGET:-Eta}"
  note "=== chevron — actuating the disclosure toggle on \"$TARGET\" ==="
  warm
  W="${WIN_W:-935}"; H="${WIN_H:-420}"
  setwin "$W" "$H" >/dev/null; sleep 2
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "  frontmost: [$(front)]"

  # harvest the chevron frame from the LIVE tree (scrolled into the band first)
  PT=$(chev_pt_in_band "$TARGET")
  set -- $PT; CHX="$1"; CHY="$2"; ROWX="$3"; ROWY="$4"; STATE="$5"
  note "  chevron point: ($CHX,$CHY)   row-body point: ($ROWX,$ROWY)   [$STATE]"

  census "chev-pre" >/dev/null
  note "  --- census BEFORE ---"; sed 's/^/    /' "$OUT/census-chev-pre.txt" | tee -a "$REPORT"

  # ARM 0 — AXPress the chevron's actionable wrapper (the cheapest vector: no
  # pointer, no focus). REPX1 §1.2 predicts decorative; measure, do not assume.
  note "  --- arm 0: AXPress on the chevron wrapper ---"
  note "  $(pressch "$TARGET" AXPress)"; sleep 2
  census "chev-axpress" >/dev/null; sed 's/^/    /' "$OUT/census-chev-axpress.txt" | tee -a "$REPORT"
  note "  AXPress changed the census? $(diff -q "$OUT/census-chev-pre.txt" "$OUT/census-chev-axpress.txt" >/dev/null && echo 'NO — decorative (REPX1 §1.2 holds)' || echo '*** YES — AXPress ACTUATES ***')"

  if [ "$STATE" = "OK" ]; then
    for PASS in 1 2; do
      for DIR in collapse expand; do
        bs reset >/dev/null; bmark "chevron $DIR pass$PASS"
        mon_mark
        # RE-RESOLVE before every input step (scrutiny doctrine): the previous
        # toggle reflowed the list, so the frame from before it is stale.
        set -- $(chev_pt_in_band "$TARGET"); CHX="$1"; CHY="$2"
        note "  --- pass $PASS: $DIR click at ($CHX,$CHY): $(clickat "$CHX" "$CHY" 1)"
        sleep 2
        census "chev-p${PASS}-$DIR" >/dev/null
        sed 's/^/      /' "$OUT/census-chev-p${PASS}-$DIR.txt" | tee -a "$REPORT"
        ROWS=$(grep "^$TARGET " "$OUT/census-chev-p${PASS}-$DIR.txt" | grep -o 'rows=[0-9]*' | head -1)
        note "      \"$TARGET\" section: $ROWS"
        bs assert --allow 99 --name "sbcol1-chevron-$DIR" | sed 's/^/      /' | tee -a "$REPORT"
        mon_verdict "the $DIR click"
      done
    done
  else
    note "  *** chevron frame not resolved — skipping the chevron arm ***"
  fi

  note "  --- alternative A: single click on the row BODY ($ROWX,$ROWY) ---"
  census "body-pre" >/dev/null
  note "  $(clickat "$ROWX" "$ROWY" 1)"; sleep 2
  census "body-single" >/dev/null; sed 's/^/    /' "$OUT/census-body-single.txt" | tee -a "$REPORT"
  note "  --- alternative B: DOUBLE click on the row BODY ---"
  note "  $(clickat "$ROWX" "$ROWY" 2)"; sleep 2
  census "body-double" >/dev/null; sed 's/^/    /' "$OUT/census-body-double.txt" | tee -a "$REPORT"
  note "  body-single vs body-pre: $(diff -q "$OUT/census-body-pre.txt" "$OUT/census-body-single.txt" >/dev/null && echo IDENTICAL || echo DIFFERS)"
  note "  body-double vs body-single: $(diff -q "$OUT/census-body-single.txt" "$OUT/census-body-double.txt" >/dev/null && echo IDENTICAL || echo DIFFERS)"
  exit 0
fi

# ============================================================== where
# WHERE does the collapse state live, and is the gesture umd-silent?
if [ "$CMD" = "where" ]; then
  load_session
  TARGET="${TARGET:-Eta}"
  note "=== where — the home of the disclosure state (target \"$TARGET\") ==="
  warm
  setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null

  snapshot_state() { # <label>
    db_digest > "$OUT/db-$1.txt"
    lab_ssh "$IP" 'defaults read com.culturedcode.ThingsMac 2>/dev/null' </dev/null > "$OUT/prefs-$1.txt"
    lab_ssh "$IP" 'ls -l ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/*.plist ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/*.plist 2>/dev/null; for P in ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/*.plist; do echo "--- $P"; plutil -p "$P" 2>/dev/null; done' </dev/null > "$OUT/gc-$1.txt"
  }

  set -- $(chev_pt_in_band "$TARGET"); CHX="$1"; CHY="$2"; STATE="$5"
  note "  chevron point: ($CHX,$CHY) [$STATE]"
  [ "$STATE" = "OK" ] || { note "  *** chevron not resolvable in the band — cell aborted ***"; exit 1; }

  snapshot_state expanded
  note "  collapse: $(clickat "$CHX" "$CHY" 1)"; sleep 3
  snapshot_state collapsed
  set -- $(chev_pt_in_band "$TARGET"); CHX="$1"; CHY="$2"
  note "  expand:   $(clickat "$CHX" "$CHY" 1)"; sleep 3
  snapshot_state reexpanded

  note "  --- DB (every table, rows + digest): expanded -> collapsed ---"
  if diff "$OUT/db-expanded.txt" "$OUT/db-collapsed.txt" > "$OUT/db-diff.txt" 2>&1; then
    note "  *** DB IDENTICAL — the collapse is umd-SILENT (no table touched) ***"
  else
    note "  *** DB CHANGED ***"; sed 's/^/    /' "$OUT/db-diff.txt" | tee -a "$REPORT"
  fi
  note "  --- app prefs domain: expanded -> collapsed ---"
  if diff "$OUT/prefs-expanded.txt" "$OUT/prefs-collapsed.txt" > "$OUT/prefs-diff.txt" 2>&1; then
    note "  prefs IDENTICAL"
  else
    note "  *** prefs CHANGED ***"; head -60 "$OUT/prefs-diff.txt" | sed 's/^/    /' | tee -a "$REPORT"
  fi
  note "  --- group-container plists: expanded -> collapsed ---"
  if diff "$OUT/gc-expanded.txt" "$OUT/gc-collapsed.txt" > "$OUT/gc-diff.txt" 2>&1; then
    note "  container plists IDENTICAL"
  else
    note "  *** container plists CHANGED ***"; head -80 "$OUT/gc-diff.txt" | sed 's/^/    /' | tee -a "$REPORT"
  fi
  note "  --- round trip: expanded -> reexpanded ---"
  note "  DB:     $(diff -q "$OUT/db-expanded.txt" "$OUT/db-reexpanded.txt" >/dev/null && echo IDENTICAL || echo DIFFERS)"
  note "  prefs:  $(diff -q "$OUT/prefs-expanded.txt" "$OUT/prefs-reexpanded.txt" >/dev/null && echo IDENTICAL || echo DIFFERS)"
  note "  gc:     $(diff -q "$OUT/gc-expanded.txt" "$OUT/gc-reexpanded.txt" >/dev/null && echo IDENTICAL || echo DIFFERS)"
  exit 0
fi

# ============================================================== persist
if [ "$CMD" = "persist" ]; then
  load_session
  TARGET="${TARGET:-Eta}"
  note "=== persist — does a collapse survive a relaunch? ==="
  warm
  setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  set -- $(chev_pt_in_band "$TARGET"); CHX="$1"; CHY="$2"; STATE="$5"
  [ "$STATE" = "OK" ] || { note "  *** chevron not resolvable in the band — cell aborted ***"; exit 1; }
  census "persist-pre" >/dev/null
  note "  collapse: $(clickat "$CHX" "$CHY" 1)"; sleep 3
  census "persist-collapsed" >/dev/null; sed 's/^/    /' "$OUT/census-persist-collapsed.txt" | tee -a "$REPORT"
  warm
  setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2
  census "persist-relaunch" >/dev/null; sed 's/^/    /' "$OUT/census-persist-relaunch.txt" | tee -a "$REPORT"
  # Compare SECTION ROW COUNTS only: a relaunch resets the scroll offset, so the
  # `top=` column differs even when every disclosure state is identical.
  note "  collapsed state survived the relaunch? $(
    diff <(awk '{print $1, $4}' "$OUT/census-persist-collapsed.txt") <(awk '{print $1, $4}' "$OUT/census-persist-relaunch.txt") >/dev/null \
      && echo 'YES — persistent across relaunch' || echo 'NO — in-memory only (see the two censuses)')"
  exit 0
fi

# ============================================================== toggle
# Fixture hygiene: flip one area's disclosure by hand (the collapse is
# PERSISTENT, so a cell that leaves one collapsed has changed the fixture).
if [ "$CMD" = "toggle" ]; then
  load_session
  TARGET="${TARGET:-Sigma}"
  warm
  setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  set -- $(chev_pt_in_band "$TARGET")
  note "=== toggle \"$TARGET\" at ($1,$2) [$5]: $(clickat "$1" "$2" 1) ==="
  sleep 2
  census "toggle-$TARGET" >/dev/null; sed 's/^/    /' "$OUT/census-toggle-$TARGET.txt" | tee -a "$REPORT"
  exit 0
fi

# ============================================================== assisted / multi
# The wall move, MANUALLY collapse-assisted (the mechanic the code leg automates).
#   assisted: one wall (Eta) on the travel span.
#   multi:    two walls (Eta + Sigma).
if [ "$CMD" = "assisted" ] || [ "$CMD" = "multi" ]; then
  load_session
  if [ "$CMD" = "assisted" ]; then WALLS="${WALLS:-Eta}"; SUBJ="${SUBJ:-Zeta}"; ANCHOR="${ANCHOR:-Gamma}";
  else WALLS="${WALLS:-Eta Sigma}"; SUBJ="${SUBJ:-Tau}"; ANCHOR="${ANCHOR:-Gamma}"; fi
  note "=== $CMD — collapse [$WALLS], move \"$SUBJ\" --before \"$ANCHOR\", restore ==="
  warm
  setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null

  census "$CMD-pre" >/dev/null
  note "  --- PRE-DRIVE census ---"; sed 's/^/    /' "$OUT/census-$CMD-pre.txt" | tee -a "$REPORT"
  BEFORE_ORDER=$(area_order); BEFORE_DIG=$(assign_digest); BEFORE_N=$(areacount)
  note "  before: $BEFORE_ORDER"

  for W in $WALLS; do
    set -- $(chev_pt_in_band "$W")
    note "  collapse \"$W\" at ($1,$2) [$5]: $(clickat "$1" "$2" 1)"; sleep 2
  done
  census "$CMD-collapsed" >/dev/null
  note "  --- COLLAPSED census ---"; sed 's/^/    /' "$OUT/census-$CMD-collapsed.txt" | tee -a "$REPORT"

  bs reset >/dev/null; bmark "$CMD drive"; mon_mark
  T0=$(date +%s)
  G area reorder "$SUBJ" --before "$ANCHOR" --dangerously-drive-gui --json > "$OUT/$CMD.json" 2>&1
  T1=$(date +%s)
  note "  wall clock: $((T1-T0))s"
  head -c 2200 "$OUT/$CMD.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  mon_verdict "the $CMD drive"
  bs assert --allow 99 --name "sbcol1-$CMD" | sed 's/^/    /' | tee -a "$REPORT"

  AFTER_ORDER=$(area_order); AFTER_DIG=$(assign_digest); AFTER_N=$(areacount)
  note "  after:  $AFTER_ORDER"
  note "  area count invariant:  $([ "$BEFORE_N" = "$AFTER_N" ] && echo PASS || echo "FAIL ($BEFORE_N -> $AFTER_N)")"
  note "  assignments invariant: $([ "$BEFORE_DIG" = "$AFTER_DIG" ] && echo PASS || echo "FAIL")"
  note "  placement reached? $(gq "SELECT CASE WHEN (SELECT COUNT(*) FROM TMArea x, TMArea y WHERE x.title='$SUBJ' AND y.title='$ANCHOR' AND (SELECT COUNT(*) FROM TMArea z WHERE (z.\"index\",z.uuid) > (x.\"index\",x.uuid) AND (z.\"index\",z.uuid) < (y.\"index\",y.uuid))=0 AND (x.\"index\",x.uuid) < (y.\"index\",y.uuid)) > 0 THEN 'YES' ELSE 'no' END")"

  # RESTORE (reverse order — the last collapsed is the first restored)
  REV=""; for W in $WALLS; do REV="$W $REV"; done
  for W in $REV; do
    set -- $(chev_pt_in_band "$W")
    note "  restore \"$W\" at ($1,$2) [$5]: $(clickat "$1" "$2" 1)"; sleep 2
  done
  census "$CMD-restored" >/dev/null
  note "  --- RESTORED census ---"; sed 's/^/    /' "$OUT/census-$CMD-restored.txt" | tee -a "$REPORT"
  # SORTED section row counts: the move itself reorders the census lines, and a
  # scroll offset shifts every `top=` — neither is a disclosure-state change.
  note "  disclosure state restored (section ROW COUNTS match pre-drive)? $(
    diff <(awk '{print $1, $4}' "$OUT/census-$CMD-pre.txt" | sort) <(awk '{print $1, $4}' "$OUT/census-$CMD-restored.txt" | sort) >/dev/null \
      && echo 'YES' || echo 'NO — see the two censuses')"
  exit 0
fi

# ============================================================== auto
# The CODE LEG's acceptance cell: the wall move with NO manual collapse.
if [ "$CMD" = "auto" ]; then
  load_session
  SUBJ="${SUBJ:-Zeta}"; ANCHOR="${ANCHOR:-Gamma}"
  note "=== auto — \"$SUBJ\" --before \"$ANCHOR\" with NO manual collapse (the driver must do it) ==="
  warm
  setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2
  census "auto-pre" >/dev/null
  note "  --- PRE-DRIVE census ---"; sed 's/^/    /' "$OUT/census-auto-pre.txt" | tee -a "$REPORT"
  BEFORE_ORDER=$(area_order); BEFORE_DIG=$(assign_digest); BEFORE_N=$(areacount)
  DBPRE=$(db_digest | shasum | cut -c1-12)
  note "  before: $BEFORE_ORDER"
  bs reset >/dev/null; bmark "auto drive"; mon_mark
  T0=$(date +%s)
  G area reorder "$SUBJ" --before "$ANCHOR" --dangerously-drive-gui --json --verbose > "$OUT/auto.json" 2>&1
  T1=$(date +%s)
  note "  wall clock: $((T1-T0))s"
  head -c 3000 "$OUT/auto.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  mon_verdict "the auto drive"
  bs assert --allow 99 --name "sbcol1-auto" | sed 's/^/    /' | tee -a "$REPORT"
  AFTER_ORDER=$(area_order); AFTER_DIG=$(assign_digest); AFTER_N=$(areacount)
  note "  after:  $AFTER_ORDER"
  note "  area count invariant:  $([ "$BEFORE_N" = "$AFTER_N" ] && echo PASS || echo "FAIL ($BEFORE_N -> $AFTER_N)")"
  note "  assignments invariant: $([ "$BEFORE_DIG" = "$AFTER_DIG" ] && echo PASS || echo "FAIL")"
  note "  placement reached? $(gq "SELECT CASE WHEN (SELECT COUNT(*) FROM TMArea x, TMArea y WHERE x.title='$SUBJ' AND y.title='$ANCHOR' AND (SELECT COUNT(*) FROM TMArea z WHERE (z.\"index\",z.uuid) > (x.\"index\",x.uuid) AND (z.\"index\",z.uuid) < (y.\"index\",y.uuid))=0 AND (x.\"index\",x.uuid) < (y.\"index\",y.uuid)) > 0 THEN 'YES' ELSE 'no' END")"
  sleep 2
  census "auto-post" >/dev/null
  note "  --- POST-DRIVE census ---"; sed 's/^/    /' "$OUT/census-auto-post.txt" | tee -a "$REPORT"
  note "  disclosure state restored (section ROW COUNTS match pre-drive)? $(
    diff <(awk '{print $1, $4}' "$OUT/census-auto-pre.txt" | sort) <(awk '{print $1, $4}' "$OUT/census-auto-post.txt" | sort) >/dev/null \
      && echo 'YES' || echo 'NO — see the two censuses')"
  exit 0
fi

# ============================================================== abort
# THE RESTORE-ON-FAILURE CELL. The epilogue's whole claim is that the sidebar is
# put back on EVERY exit, not just the happy one — so this cell makes a drive
# fail AFTER it has folded a wall away.
#
# The forcing function is the app itself: start the drive in the background,
# watch `collapsedAreaUUIDs` in Things' own preferences until the collapse has
# actually landed, then QUIT Things. Every later AX step fails, the ladder
# refuses — and the epilogue still has to answer for the fold it made. Either it
# re-expands (the app is gone, so it cannot) or it REPORTS the area it could not
# restore. Silence is the only wrong answer.
collapsed_uuids() {
  lab_ssh "$IP" 'plutil -extract collapsedAreaUUIDs raw -o - ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist 2>/dev/null || echo 0' </dev/null | tr -d ' \n'
}
if [ "$CMD" = "abort" ]; then
  load_session
  SUBJ="${SUBJ:-Alpha}"; ANCHOR="${ANCHOR:-Lambda}"
  note "=== abort — restore-on-failure: quit Things once the fold has landed ==="
  warm
  setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2
  census "abort-pre" >/dev/null
  note "  --- PRE-DRIVE census ---"; sed 's/^/    /' "$OUT/census-abort-pre.txt" | tee -a "$REPORT"
  note "  collapsedAreaUUIDs before: [$(collapsed_uuids)]"
  bs reset >/dev/null; bmark "abort drive"
  T0=$(date +%s)
  lab_ssh "$IP" "$LAB_DIRECT $CLI area reorder $SUBJ --before $ANCHOR --dangerously-drive-gui --json > /tmp/abort.json 2>&1; echo EXIT=\$? >> /tmp/abort.json" </dev/null &
  DRIVE_PID=$!
  # wait for the FOLD, then pull the rug
  FOLDED=no
  for i in $(seq 1 60); do
    C=$(collapsed_uuids)
    if [ -n "$C" ] && [ "$C" != "0" ]; then FOLDED=yes; note "  fold landed after ${i}s: collapsedAreaUUIDs=[$C]"; break; fi
    sleep 1
  done
  if [ "$FOLDED" = "yes" ]; then
    note "  quitting Things mid-drive: $(lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; echo QUIT-SENT' </dev/null)"
  else
    note "  *** the fold never landed — the cell proves nothing; not killing the app ***"
  fi
  wait $DRIVE_PID
  T1=$(date +%s)
  note "  wall clock: $((T1-T0))s"
  lab_ssh "$IP" 'cat /tmp/abort.json' </dev/null > "$OUT/abort.json" 2>&1
  head -c 2600 "$OUT/abort.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "  collapsedAreaUUIDs after the aborted drive: [$(collapsed_uuids)]"
  warm
  setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2
  census "abort-post" >/dev/null
  note "  --- POST-DRIVE census (after a relaunch) ---"; sed 's/^/    /' "$OUT/census-abort-post.txt" | tee -a "$REPORT"
  # The verdict has TWO acceptable shapes, and exactly one unacceptable one.
  # Restoring is best; when the app is gone the fold cannot be undone, and then
  # the ONLY correct behaviour is to name it. Silence is the failure mode.
  if diff <(awk '{print $1, $4}' "$OUT/census-abort-pre.txt" | sort) <(awk '{print $1, $4}' "$OUT/census-abort-post.txt" | sort) >/dev/null; then
    note "  VERDICT: the sidebar was RESTORED after the failure"
  elif grep -q "could not be expanded again" "$OUT/abort.json"; then
    note "  VERDICT: the fold outlived the drive (the app was killed under it) and the failure"
    note "           detail NAMES the area it could not expand — honest, not silent  *** PASS ***"
  else
    note "  *** VERDICT: the fold outlived the drive AND went unmentioned — SILENT DAMAGE ***"
  fi
  exit 0
fi

# ============================================================== teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true; sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  note "=== teardown: $VM destroyed ==="
  exit 0
fi

cat >&2 <<USAGE
usage: TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-sbcol1.sh <cmd>
  setup     clone golden-v4 + airgap + clock pin + helpers + shipped bundle
  seed      the two-wall sidebar (14 areas; Eta and Sigma oversized)
  axdump    the area row's AX descendants, with and without a pointer hover
  chevron   CGEvent-click the chevron frame; census both directions, twice
  where     where the collapse state lives (DB / prefs / container plists)
  persist   does a collapse survive an app relaunch?
  assisted  manual collapse -> SHIPPED drag across the wall -> restore
  multi     the same across TWO walls
  auto      the same move with NO manual collapse (the code leg's acceptance)
  abort     restore-on-failure: clip the drive budget, assert the restore anyway
  reship    rebuild + redeploy dist
  teardown  destroy the clone
USAGE
exit 2
