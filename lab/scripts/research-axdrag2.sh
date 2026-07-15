#!/bin/bash
# AXDRAG2 — area.reorder-sidebar build probes + certification (2026-07-15).
# Full write-up: docs/lab/axdrag2-reorder-certification.md.
#
# Subcommand-driven so the session survives host-side iteration; ONE
# disposable clone `axdrag2-lab` lives across phases (explicit teardown):
#
#   research-axdrag2.sh setup      clone+boot+airgap+clock-pin+AX-grant+seed+bundle
#   research-axdrag2.sh rebundle   rebuild dist and re-ship the guest e2e bundle
#   research-axdrag2.sh probe-a    AXDRAG2-a mid-drag AX polling + mid-drag wheel
#   research-axdrag2.sh probe-b    AXDRAG2-b area-row hover chevron (record-only)
#   research-axdrag2.sh cert       AXDRAG2-c certification suite (production CLI)
#   research-axdrag2.sh tags       AXDRAG2-d tag.reorder scoping probes
#   research-axdrag2.sh teardown   stop + delete the clone
#
# VM discipline: --vnc-experimental single-client — one vncdo per step,
# timeout-wrapped, sleeps between; AXEnhancedUserInterface stays false.
# Requires $VNCDO (vncdotool venv) for the one-time AX grant (AXVM1 rung b).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

VM="axdrag2-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[axdrag2] $*" | tee -a "$REPORT"; }

CMD="${1:-}"

# ---------------------------------------------------------------- helpers
load_session() {
  [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }
  source "$SESSION"
}
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
AXR() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript /tmp/axdrag2.js $*" </dev/null; }
relaunch() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 3; open -a Things3; sleep 9' </dev/null; }
axeui_off() { lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true; }
area_order() { gq 'SELECT title FROM TMArea ORDER BY "index", uuid' | tr '\n' ' '; }

ship_probe_kit() {
  # Guest-side probe toolkit (NATIVE1/AXDRAG1 incantations) — used by the
  # micro-probes only; the certification path uses the PRODUCTION driver.
  lab_ssh "$IP" 'cat > /tmp/axdrag2.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleep(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
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
function rowsOf(t){ var out=[]; var ch=kids(t);
  for(var r=0;r<ch.length;r++){ var role=sv(ch[r],'AXRole');
    if(role==='AXRow'||role==='AXTableRow'){ out.push({el:ch[r], text:allText(ch[r],[],6).join('|'), f:frame(ch[r])}) } }
  return out }
function rowByTitle(sub){ var t=sidebarTable(); if(!t) return null; var rs=rowsOf(t);
  for(var i=0;i<rs.length;i++){ var segs=rs[i].text.split('|');
    for(var j=0;j<segs.length;j++){ if(segs[j]===sub||segs[j]===sub+'.') return rs[i] } } return null }
function scrollFrac(){ var w=stdWindow(); var sas=findAll(w,'AXScrollArea',12,[]);
  for(var i=0;i<sas.length;i++){ var f=frame(sas[i]); if(!f||f.w>=400) continue;
    var bars=findAll(sas[i],'AXScrollBar',4,[]);
    for(var b=0;b<bars.length;b++){ var v=attr(bars[b],'AXValue'); if(v===null) continue;
      var d=ObjC.castRefToObject($.CFCopyDescription(v)).js; var m=d.match(/value = ([+\-0-9.]+)/); if(m) return +m[1] } }
  return null }
var MOVED=5, DOWN=1, UP=2, DRAG=6;
function mev(t,x,y,cs){ var e=$.CGEventCreateMouseEvent($(), t, $.CGPointMake(x,y), 0); if(cs) $.CGEventSetIntegerValueField(e,1,cs); return e }
function postHID(ev){ $.CGEventPost($.kCGHIDEventTap, ev) }
function esc(){ var kd=$.CGEventCreateKeyboardEvent($(),53,true), ku=$.CGEventCreateKeyboardEvent($(),53,false);
  postHID(kd); sleep(20); postHID(ku); }
function run(argv){
  var cmd=argv[0];
  if(cmd==='middrag'){
    // middrag <srcTitle> <watchTitle> <wheelDelta> <ticks>
    // Grab src, hold the drag, then each tick: post ONE wheel event (pointer
    // stays at the grab point over the sidebar) and re-resolve the watch
    // row's frame + scrollbar fraction. Escape-abort at the end (no drop).
    var src=rowByTitle(argv[1]); if(!src||!src.f) return 'SRC_NOT_FOUND';
    var watch=argv[2], delta=+argv[3], ticks=+argv[4];
    var sx=src.f.x+src.f.w*0.7, sy=src.f.y+src.f.h/2;
    var pre=rowByTitle(watch); var preY=(pre&&pre.f)?pre.f.y:null;
    postHID(mev(MOVED,sx,sy,0)); sleep(30);
    postHID(mev(DOWN,sx,sy,1)); sleep(120);
    postHID(mev(DRAG,sx,sy-3,1)); sleep(30);
    postHID(mev(DRAG,sx,sy,1)); sleep(100);
    var samples=[{t:0, frac:scrollFrac(), watchY:preY, phase:'held-pre-wheel'}];
    for(var i=1;i<=ticks;i++){
      var ev=$.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, delta);
      postHID(ev); sleep(60);
      postHID(mev(DRAG,sx,sy,1)); sleep(90);           // keep the drag session alive
      var r=rowByTitle(watch); var f=scrollFrac();
      samples.push({t:i, frac:f, watchY:(r&&r.f)?r.f.y:null});
    }
    esc(); sleep(150); postHID(mev(UP,sx,sy,1)); sleep(300);
    var post=rowByTitle(watch);
    return JSON.stringify({grab:{x:sx,y:sy}, samples:samples, postAbortWatchY:(post&&post.f)?post.f.y:null});
  }
  if(cmd==='hoverdump'){
    // hoverdump <areaTitle> — dump row descendants before hover, hover the
    // pointer over the row, dump again (chevron probe; record-only).
    var row=rowByTitle(argv[1]); if(!row||!row.f) return 'ROW_NOT_FOUND';
    function dump(el){ var out=[]; (function walk(e,p,d){
      var f=frame(e); out.push(p+' '+sv(e,'AXRole')+(sv(e,'AXSubrole')?'/'+sv(e,'AXSubrole'):'')
        +(sv(e,'AXDescription')?' d="'+sv(e,'AXDescription')+'"':'')
        +(sv(e,'AXValue')?' v="'+String(sv(e,'AXValue')).slice(0,24)+'"':'')
        +(f?(' @'+Math.round(f.x)+','+Math.round(f.y)+' '+Math.round(f.w)+'x'+Math.round(f.h)):''));
      if(d<=0) return; var ks=kids(e); for(var i=0;i<ks.length;i++) walk(ks[i],p+'/'+i,d-1) })(el,'r',5); return out }
    var beforeD=dump(row.el);
    var acts=Ref(); var actList='none';
    if($.AXUIElementCopyActionNames(row.el, acts)===0){ var a=ObjC.castRefToObject(acts[0]); var l=[];
      for(var i=0;i<a.count;i++) l.push(a.objectAtIndex(i).js); actList=l.join(',')||'empty' }
    postHID(mev(MOVED,row.f.x+row.f.w*0.5,row.f.y+row.f.h/2,0)); sleep(800);
    var row2=rowByTitle(argv[1]);
    var afterD=row2?dump(row2.el):['ROW_GONE'];
    return JSON.stringify({actions:actList, before:beforeD, after:afterD});
  }
  if(cmd==='tagsopen'){
    // Open Window ▸ Tags via the pure-AX menu press (AXDRAG1-e path).
    var se=Application('System Events');
    se.processes.byName('Things3').menuBars[0].menuBarItems.byName('Window').menus[0].menuItems.byName('Tags').click();
    sleep(1500); return 'OK';
  }
  if(cmd==='tagsrows'){
    var ws=kids(appEl());
    for(var i=0;i<ws.length;i++){ var title=sv(ws[i],'AXTitle');
      if(title && title.indexOf('Tag')>=0){
        var tables=findAll(ws[i],'AXTable',12,[]).concat(findAll(ws[i],'AXOutline',12,[]));
        var out=[];
        for(var t=0;t<tables.length;t++){ var rs=rowsOf(tables[t]);
          for(var j=0;j<rs.length;j++) out.push({i:out.length, text:rs[j].text, f:rs[j].f}) }
        return JSON.stringify({window:title, rows:out});
      } }
    return 'NO_TAGS_WINDOW';
  }
  if(cmd==='tagdrag'){
    // tagdrag <rowIdx> <ty> — drag the Tags-window row (by index) to y.
    var ws=kids(appEl()); var rows=null;
    for(var i=0;i<ws.length;i++){ var title=sv(ws[i],'AXTitle');
      if(title && title.indexOf('Tag')>=0){
        var tables=findAll(ws[i],'AXTable',12,[]).concat(findAll(ws[i],'AXOutline',12,[]));
        if(tables.length) rows=rowsOf(tables[0]); break } }
    if(!rows) return 'NO_TAGS_WINDOW';
    var r=rows[+argv[1]]; if(!r||!r.f) return 'ROW_NOT_FOUND';
    var sx=r.f.x+r.f.w*0.5, sy=r.f.y+r.f.h/2, ty=+argv[2];
    postHID(mev(MOVED,sx,sy,0)); sleep(30);
    postHID(mev(DOWN,sx,sy,1)); sleep(120);
    postHID(mev(DRAG,sx,sy-3,1)); sleep(30);
    for(var s=1;s<=20;s++){ postHID(mev(DRAG,sx,sy+(ty-sy)*s/20,1)); sleep(25) }
    postHID(mev(DRAG,sx,ty,1)); sleep(400);
    postHID(mev(UP,sx,ty,1));
    return 'DONE';
  }
  if(cmd==='winsize'){
    // winsize <w> <h> — resize the standard window via AX (certification
    // uses it to force multi-hop with a small viewport).
    var w=stdWindow(); if(!w) return 'NO_WIN';
    var out=Ref();
    var sz=$.AXValueCreate($.kAXValueCGSizeType, Ref()); // not usable from JXA; use System Events instead
    return 'USE_SE';
  }
  return 'UNKNOWN_CMD';
}
EOF
}

# ================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning golden -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone things-lab-golden-v1 "$VM"
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
  echo "IP=$IP" > "$SESSION"; echo "VNC_URL=$VNC_URL" >> "$SESSION"

  # read-only guest SQLite
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

  # -------- AX grant (AXVM1 rung b, VNC single-client discipline) --------
  note "granting Accessibility (AXVM1 rung b)"
  lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
  if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then note "VNCDO/VNC_URL missing — abort"; exit 1; fi
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
  lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
  V capture "$OUT/screens/01-ax-pane.png"
  V move 1642 332 click 1; sleep 3; V capture "$OUT/screens/02-auth.png"
  V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3
  V capture "$OUT/screens/03-after-auth.png"
  note "-- AX rows after grant (expect auth_value 2) --"
  lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT service,client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null | tee -a "$REPORT"
  axeui_off

  # -------- seed: Area-01..Area-23 + projects under a few areas --------
  note "seeding 23 areas + nested projects"
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3"
    repeat with i from 1 to 23
      set nm to "Area-" & text -2 thru -1 of ("0" & i)
      make new area with properties {name:nm}
    end repeat
  end tell'\''' </dev/null
  for A in Area-03 Area-08 Area-15; do
    lab_ssh "$IP" "open 'things:///add-project?title=Proj-under-$A&area=$A'; sleep 2" </dev/null
  done
  sleep 2
  note "areas ($(gq 'SELECT COUNT(*) FROM TMArea')): $(area_order)"

  # -------- guest e2e bundle --------
  note "building + shipping the guest e2e bundle"
  npm run build >/dev/null
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/dist"
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  G config set ui-enabled true >/dev/null 2>&1
  ship_probe_kit
  relaunch; axeui_off
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ================================================================ rebundle
if [ "$CMD" = "rebundle" ]; then
  load_session
  npm run build >/dev/null || exit 1
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O -r dist "admin@$IP:/Users/admin/things-lab/things-api/dist"
  note "rebundled"
  exit 0
fi

# ================================================================= probe-a
if [ "$CMD" = "probe-a" ]; then
  load_session; ship_probe_kit; axeui_off
  note "############### AXDRAG2-a: mid-drag AX polling + mid-drag wheel ###############"
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  # The tie-break sidebar order puts Area-13 at the TOP (visible) and Area-04
  # LAST (virtual y≈1476, off-viewport). Grab the visible row, wheel DOWN
  # (delta −3 reveals lower rows), watch the off-viewport row's frame.
  AXR middrag Area-13 Area-04 -3 12 | tee "$OUT/probe-a-down.json" | head -c 1200; echo
  sleep 2
  # Reverse: the list is left scrolled down by the aborted run; grab Area-04
  # (now visible), wheel UP (+3), watch Area-13 coming back.
  AXR middrag Area-04 Area-13 3 12 | tee "$OUT/probe-a-up.json" | head -c 1200; echo
  note "probe-a raw in $OUT/probe-a-{down,up}.json"
  note "index vector after (expect UNCHANGED — Escape aborts):"
  gq 'SELECT title||"="||"index" FROM TMArea LIMIT 3' >/dev/null 2>&1
  note "areas: $(area_order)"
  exit 0
fi

# ================================================================= probe-b
if [ "$CMD" = "probe-b" ]; then
  load_session; ship_probe_kit; axeui_off
  note "############### AXDRAG2-b: hover chevron (record-only) ###############"
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  AXR hoverdump Area-03 > "$OUT/probe-b-hover.json"
  head -c 1500 "$OUT/probe-b-hover.json"; echo
  note "probe-b raw in $OUT/probe-b-hover.json"
  exit 0
fi

# ==================================================================== cert
if [ "$CMD" = "cert" ]; then
  load_session; axeui_off
  note "############### AXDRAG2-c: certification through the production CLI ###############"
  note "start order: $(area_order)"

  note "-- c1 rung-1 DOWN: Area-02 --after Area-05 --"
  relaunch; axeui_off
  G area reorder-sidebar Area-02 --after Area-05 --dangerously-drive-gui --json 2>&1 | tee "$OUT/c1.json" | head -c 600; echo
  note "order: $(area_order)"

  note "-- c2 rung-1 UP: Area-06 --before Area-01 --"
  G area reorder-sidebar Area-06 --before Area-01 --dangerously-drive-gui --json 2>&1 | tee "$OUT/c2.json" | head -c 600; echo
  note "order: $(area_order)"

  note "-- c3 undo round-trip of c2 --"
  TXN=$(python3 -c "import json;print(json.load(open('$OUT/c2.json'))['data'].get('undoToken',''))" 2>/dev/null || true)
  note "undo token: $TXN"
  if [ -n "$TXN" ]; then
    G undo --txn "$TXN" --dangerously-drive-gui --json 2>&1 | tee "$OUT/c3-undo.json" | head -c 600; echo
  fi
  note "order after undo: $(area_order)"

  note "-- c4 multi-hop: shrink window, Area-01 --last (off-viewport target) --"
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set size of (first window whose subrole is "AXStandardWindow") to {935, 420}'\''' </dev/null
  sleep 2
  G area reorder-sidebar Area-01 --last --dangerously-drive-gui --json 2>&1 | tee "$OUT/c4.json" | head -c 800; echo
  note "order: $(area_order)"

  note "-- c5 multi-hop UP: Area-22 --first (still small window) --"
  G area reorder-sidebar Area-22 --first --dangerously-drive-gui --json 2>&1 | tee "$OUT/c5.json" | head -c 800; echo
  note "order: $(area_order)"
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set size of (first window whose subrole is "AXStandardWindow") to {935, 684}'\''' </dev/null

  note "-- c6 negative: gating (no ack -> blocked exit 4; order unchanged) --"
  BEFORE=$(area_order)
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js area reorder-sidebar Area-05 --first 2>&1 >/dev/null | head -2; echo exit=\${PIPESTATUS[0]}" </dev/null | tee -a "$REPORT"
  AFTER=$(area_order)
  [ "$BEFORE" = "$AFTER" ] && note "c6 PASS: order unchanged" || note "c6 FAIL: order moved"

  note "-- c7 negative: duplicate visible name refuses before any gesture --"
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to make new area with properties {name:"Area-05"}'\''' </dev/null
  sleep 1
  BEFORE=$(area_order)
  G area reorder-sidebar Area-05 --first --dangerously-drive-gui --json 2>&1 | tee "$OUT/c7.json" | head -c 400; echo
  AFTER=$(area_order)
  [ "$BEFORE" = "$AFTER" ] && note "c7 PASS: refused, order unchanged" || note "c7 FAIL: order moved"
  # remove the duplicate (delete via CLI is permanent + fine in the lab)
  DUP=$(gq "SELECT uuid FROM TMArea WHERE title='Area-05' ORDER BY \"index\" DESC LIMIT 1")
  G area delete "$DUP" --dangerously-permanent --json >/dev/null 2>&1

  note "-- c8 text-size robustness: large sidebar rows, rung-1 move re-derives geometry --"
  lab_ssh "$IP" 'defaults write -g NSTableViewDefaultSizeMode -int 3' </dev/null
  relaunch; axeui_off
  G area reorder-sidebar Area-04 --after Area-07 --dangerously-drive-gui --json 2>&1 | tee "$OUT/c8.json" | head -c 600; echo
  note "order: $(area_order)"
  lab_ssh "$IP" 'defaults write -g NSTableViewDefaultSizeMode -int 2' </dev/null

  note "-- invariants: TMArea count + assignments --"
  note "area count: $(gq 'SELECT COUNT(*) FROM TMArea')"
  note "project->area: $(gq 'SELECT title||">"||COALESCE(area,"-") FROM TMTask WHERE type=1 AND trashed=0 ORDER BY title' | tr '\n' ' ')"
  note "cert DONE — envelopes in $OUT/c*.json"
  exit 0
fi

# ==================================================================== tags
if [ "$CMD" = "tags" ]; then
  load_session; ship_probe_kit; axeui_off
  note "############### AXDRAG2-d: tag.reorder scoping ###############"
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  note "-- DB canonical tag order --"
  gq 'SELECT title||" idx="||"index"||" parent="||COALESCE(parent,"-") FROM TMTag ORDER BY "index"' | tee -a "$REPORT"
  AXR tagsopen | tee -a "$REPORT"
  AXR tagsrows > "$OUT/tags-rows.json"; head -c 1200 "$OUT/tags-rows.json"; echo
  note "rows dumped to $OUT/tags-rows.json — compare mapping, then boundary/centre drops manually via tagdrag"
  exit 0
fi

# ================================================================ teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|rebundle|probe-a|probe-b|cert|tags|teardown" >&2
exit 1
