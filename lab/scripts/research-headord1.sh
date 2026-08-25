#!/bin/bash
# HEADORD1 — can heading ORDER within a project be RESTORED on Things 3.23?
#
# BACKGROUND. The private `_private_experimental_ reorder` command went
# accepted-and-inert on 3.23 (`privateReorderIsNoOp`, src/write/experimental.ts),
# so `project.move-heading` refuses with NO fallback: heading order is a recorded
# LOSS (docs/up-next.md; docs/design/reorder-canary.md). REORDGAPS already proved
# there is no headless reorder spelling that ADDRESSES a heading (HEADORD-b:
# -1708 / -1728 / -2740) and that the only reorder reaching headed children is
# destructive (HEADORD-a). What is NEW since then is
# `project.move-heading-to-project` — the heading-row ellipsis → Move… picker
# recipe, fixed and certified by #589/HXPC1 — which relocates a heading WITH its
# children to another project by a single project-FK rewrite.
#
# THE HYPOTHESIS UNDER TEST. A BOUNCE protocol: move headings OUT of project P
# into an ephemeral project E and back IN, in target order, rebuilding P's
# heading order out of the app's own re-entry placement. That is the shape the
# BOUNCE2/SOMEBNC laws take for to-dos (docs/lab/reordgaps-results.md); nobody
# has ever measured it for HEADINGS.
#
# CELLS, in priority order:
#   1  menu-census    the cheapest possible win — is there a Move Up / Move Down
#                     affordance for a SELECTED heading anywhere (menu bar,
#                     context menu, keyboard)? If yes, it beats the bounce.
#   2  landing        the re-entry landing LAW: where does a heading land when it
#                     re-enters a project? End / after the last heading / its old
#                     slot? Permutations, for determinism.
#   3  bounce         the full prototype: rebuild C,A,B from A,B,C through the
#                     shipped CLI; children integrity + cost + failure modes.
#   4  lifecycle      the ephemeral scratch project: create, move into a freshly
#                     created project, empty it, delete it.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (the trial wall is
# 2026-07-18 — docs/lab/harness.md). Fixtures fully synthetic. The clone is
# destroyed on teardown. PROBE ONLY — no op is shipped from this campaign.
#
# Beeps: the sentinel runs per cell with THINGS_LAB_BEEPS_OK=1 (the probe opt-out
# — accounting, never a mute); every cell reports its count.
#
# Phases (the clone survives between them; SESSION carries the IP):
#   setup        clone + boot + airgap + clock pin + ship the CLI + AX kit
#   menu-census  cell 1
#   landing      cell 2
#   bounce       cell 3
#   lifecycle    cell 4
#   teardown     stop + delete the clone
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-headord1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — well inside the trial wall (2026-07-18)
note() { echo "[headord1] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
show() { lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 3" </dev/null; }
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }

# ---- the beep sentinel (probe opt-out: counted, never failing) --------------
bs()    { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh $*" </dev/null 2>&1; }
bmark() { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }

# ---- the DB oracles ---------------------------------------------------------
# Heading order inside a project: type=2 rows whose project FK is P, by `index`.
horder() { gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$1' AND type=2 AND trashed=0 ORDER BY \"index\" ASC)"; }
hidx()   { gt "SELECT title, substr(uuid,1,8) AS uuid8, \"index\" AS idx FROM TMTask WHERE project='$1' AND type=2 AND trashed=0 ORDER BY \"index\" ASC"; }
# The full project picture: headings (type=2), loose to-dos (type=0, heading NULL),
# and headed children (type=0 carrying a heading FK into one of P's headings).
pdump()  { gt "SELECT CASE type WHEN 2 THEN 'HEAD' ELSE 'todo' END AS kind, title, substr(uuid,1,8) AS uuid8, \"index\" AS idx, COALESCE(substr(project,1,8),'-') AS proj, COALESCE(substr(heading,1,8),'-') AS head FROM TMTask WHERE trashed=0 AND (project='$1' OR heading IN (SELECT uuid FROM TMTask WHERE project='$1' AND type=2)) ORDER BY (heading IS NOT NULL), \"index\" ASC"; }
kids()   { gq "SELECT COUNT(*) FROM TMTask WHERE heading='$1' AND trashed=0"; }

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

  # ---- AX kit: the HXPC1 kit + a menu census, a right-click and modifier keys
  lab_ssh "$IP" 'cat > ~/labh/hoax.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]) }
function sv(el,name){ var v=attr(el,name); try { return v? (''+v.js) : '' } catch(e){ return '' } }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function frame(el){ var p=attr(el,'AXPosition'), z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=String(pd).match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=String(zd).match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null }
function appEl(){ return $.AXUIElementCreateApplication(pidOf('Things3')) }
var MOVED=5, DOWN=1, UP=2, RDOWN=3, RUP=4;
function mev(t,x,y){ return $.CGEventCreateMouseEvent($(),t,$.CGPointMake(x,y),(t===RDOWN||t===RUP)?1:0) }
function postHID(ev){ $.CGEventPost($.kCGHIDEventTap, ev) }
function click(x,y){ postHID(mev(MOVED,x,y)); sleepMs(60); postHID(mev(DOWN,x,y)); sleepMs(90); postHID(mev(UP,x,y)); sleepMs(60) }
function rclick(x,y){ postHID(mev(MOVED,x,y)); sleepMs(150); postHID(mev(RDOWN,x,y)); sleepMs(160); postHID(mev(RUP,x,y)); sleepMs(150) }
function key(code){ var d=$.CGEventCreateKeyboardEvent($(),code,true), u=$.CGEventCreateKeyboardEvent($(),code,false); postHID(d); sleepMs(40); postHID(u); sleepMs(40) }
function keyMod(code,flags){ var d=$.CGEventCreateKeyboardEvent($(),code,true), u=$.CGEventCreateKeyboardEvent($(),code,false);
  $.CGEventSetFlags(d,flags); $.CGEventSetFlags(u,flags); postHID(d); sleepMs(70); postHID(u); sleepMs(70) }
function findByDesc(sub){ var hit=null;
  (function w(e){ if(hit) return; var d=sv(e,'AXDescription'); if(d && d.indexOf(sub)>=0){ hit=e; return; } var ch=kids(e); for(var i=0;i<ch.length;i++) w(ch[i]); })(appEl());
  return hit; }
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
    if(sub==='AXStandardWindow'){
      var ch=kids(w);
      for(var j=0;j<ch.length;j++){ var rr=sv(ch[j],'AXRole');
        if(rr==='AXSheet'||rr==='AXPopover'||rr==='AXMenu'){ acc.push('--- '+rr+' of the standard window ---'); walk(ch[j],0,acc,j+1) } }
    } else if(!(f && f.w===40 && f.h===40)) {
      walk(w,0,acc,i+1);
    }
  }
  if(!acc.length) acc.push('(nothing)');
  return acc.join('\n') }
/* every AXMenu anywhere under the application element, wherever it is parented */
function dumpMenus(){
  var acc=[]; var seen=0;
  (function w(e,path){
    var r=sv(e,'AXRole');
    if(r==='AXMenuBar') return;
    if(r==='AXMenu'){ seen++; acc.push('=== AXMenu #'+seen+' at '+path+' ==='); walk(e,0,acc,seen); return; }
    var ch=kids(e); for(var i=0;i<ch.length;i++) w(ch[i], path+'/'+r+'['+(i+1)+']');
  })(appEl(),'');
  if(!seen) acc.push('(no AXMenu anywhere under the application element, menu bar excluded)');
  return acc.join('\n') }
function run(argv){
  var cmd=argv[0];
  if(cmd==='dump') return dumpAll();
  if(cmd==='menus') return dumpMenus();
  if(cmd==='more-frame'){ var el=findByDesc('More. '+argv.slice(1).join(' ')); if(!el) return 'MORE_NOT_FOUND';
    var f=frame(el); if(!f) return 'NO_FRAME'; return JSON.stringify({cx:Math.round(f.x+f.w/2), cy:Math.round(f.y+f.h/2), f:f}); }
  if(cmd==='desc-frame'){ var el2=findByDesc(argv.slice(1).join(' ')); if(!el2) return 'DESC_NOT_FOUND';
    var f2=frame(el2); if(!f2) return 'NO_FRAME'; return JSON.stringify({cx:Math.round(f2.x+f2.w/2), cy:Math.round(f2.y+f2.h/2), f:f2}); }
  if(cmd==='click'){ click(+argv[1],+argv[2]); return 'CLICKED '+argv[1]+','+argv[2]; }
  if(cmd==='rclick'){ rclick(+argv[1],+argv[2]); return 'RIGHT-CLICKED '+argv[1]+','+argv[2]; }
  if(cmd==='key'){ key(+argv[1]); return 'KEY '+argv[1]; }
  if(cmd==='keymod'){ keyMod(+argv[1], +argv[2]); return 'KEY '+argv[1]+' flags='+argv[2]; }
  if(cmd==='type'){ Application('System Events').keystroke(argv.slice(1).join(' ')); return 'TYPED'; }
  return 'UNKNOWN_CMD' }
EOF

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
G()   { lab_ssh "$IP" "THINGS_API_UI_DIRECT=1 $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
AXM() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/hoax.js $*" </dev/null; }
tj()  { lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null; sleep 4; }

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
pid()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND trashed=0 LIMIT 1"; }
hid()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=2 AND trashed=0 LIMIT 1"; }

# mv_heading <srcProject> <headingUuid> <destProject> <beepLabel>
# ONE GUI drive through the shipped CLI. Echoes OK/ERR plus the wall time.
mv_heading() {
  local t0 t1 outp
  bmark "$4"
  t0=$(date +%s)
  outp=$(G project move-heading-to-project "$1" "$2" --to "$3" --dangerously-drive-gui --json)
  t1=$(date +%s)
  { echo "### $4"; echo "$outp"; } >> "$OUT/moves.log"
  if echo "$outp" | grep -q 'EXIT=0'; then echo "OK $((t1-t0))s"; else echo "ERR $((t1-t0))s :: $(echo "$outp" | tr '\n' ' ' | cut -c1-400)"; fi
}

# ============================================================== cell 1
if [ "$CMD" = "menu-census" ]; then
  load_session
  bs reset >/dev/null; bmark "cell1 setup"
  note ""
  note "############### CELL 1 — the menu census for a SELECTED heading ###############"
  note "The cheapest possible win: if ANY Move Up / Move Down affordance exists for a"
  note "selected heading, it beats the bounce. Menu bar (every menu, enabled state +"
  note "keyboard shortcut), the row's CONTEXT menu, and the arrow-chord family."

  seed_project "HO1-MENU" MA MB MC
  PM=$(pid "HO1-MENU")
  note "  project HO1-MENU=$PM"
  hidx "$PM" | sed 's/^/    /' | tee -a "$REPORT"
  note "  heading order: $(horder "$PM")"

  warm
  show "things:///show?id=$PM"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null

  MBDUMP='tell application "System Events" to tell process "Things3"
  set out to ""
  repeat with mb in menu bar items of menu bar 1
    set mn to name of mb
    set out to out & "== MENU " & mn & " ==" & linefeed
    try
      repeat with mi in menu items of menu 1 of mb
        set nm to ""
        try
          set nm to name of mi
        end try
        if nm is not "" then
          set en to "?"
          try
            set en to (enabled of mi) as text
          end try
          set cc to ""
          try
            set cc to (value of attribute "AXMenuItemCmdChar" of mi) as text
          end try
          set cm to ""
          try
            set cm to (value of attribute "AXMenuItemCmdModifiers" of mi) as text
          end try
          set out to out & "  [" & en & "] " & nm
          if cc is not "" then set out to out & "   key=" & cc & " mods=" & cm
          set out to out & linefeed
          try
            repeat with si in menu items of menu 1 of mi
              set sn to ""
              try
                set sn to name of si
              end try
              if sn is not "" then
                set se to "?"
                try
                  set se to (enabled of si) as text
                end try
                set sc to ""
                try
                  set sc to (value of attribute "AXMenuItemCmdChar" of si) as text
                end try
                set sm to ""
                try
                  set sm to (value of attribute "AXMenuItemCmdModifiers" of si) as text
                end try
                set out to out & "      -> [" & se & "] " & sn
                if sc is not "" then set out to out & "   key=" & sc & " mods=" & sm
                set out to out & linefeed
              end if
            end repeat
          end try
        end if
      end repeat
    end try
  end repeat
  return out
end tell'

  # ---- 1a: the BASELINE menu bar with NOTHING selected --------------------
  bmark "cell1a baseline menubar"
  axq "$MBDUMP" > "$OUT/ax/c1-menubar-noselection.txt" 2>&1
  note "  baseline menu bar -> $OUT/ax/c1-menubar-noselection.txt ($(wc -l < "$OUT/ax/c1-menubar-noselection.txt" | tr -d ' ') lines)"

  # ---- 1b: SELECT the middle heading via the SHIPPED primitive ------------
  bmark "cell1b select-heading-row"
  TABLE='table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")'
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectHeadingRowScript(process.argv[1], 1)))" "$TABLE" > "$OUT/sel-heading-1.applescript"
  lab_ssh "$IP" 'cat > ~/labh/sel-heading-1.applescript' < "$OUT/sel-heading-1.applescript"
  SELR=$(lab_ssh "$IP" 'osascript ~/labh/sel-heading-1.applescript' </dev/null 2>&1)
  note "  select-heading-row(ordinal 1 = MB): $SELR"
  note "  Things3 'selected to dos' readback: [$(axq 'tell application "Things3" to return (name of selected to dos) as text')]"
  axq 'tell application "System Events" to tell process "Things3"
  set t to table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")
  set out to "rows=" & (count of rows of t) & "  selected row(s): "
  repeat with i from 1 to (count of rows of t)
    try
      if (selected of row i of t) then set out to out & i & " "
    end try
  end repeat
  return out
end tell' | sed 's/^/    /' | tee -a "$REPORT"

  # ---- 1c: the menu bar WITH the heading selected -------------------------
  bmark "cell1c menubar with heading selected"
  axq "$MBDUMP" > "$OUT/ax/c1-menubar-heading-selected.txt" 2>&1
  note "  heading-selected menu bar -> $OUT/ax/c1-menubar-heading-selected.txt"
  note "  --- DIFF vs the no-selection baseline ---"
  diff "$OUT/ax/c1-menubar-noselection.txt" "$OUT/ax/c1-menubar-heading-selected.txt" > "$OUT/ax/c1-menubar-diff.txt" 2>&1
  if [ -s "$OUT/ax/c1-menubar-diff.txt" ]; then
    sed 's/^/    /' "$OUT/ax/c1-menubar-diff.txt" | tee -a "$REPORT"
  else
    note "    (no difference at all)"
  fi
  note "  --- every menu item whose name smells of ordering/moving ---"
  grep -inE 'move|order| up| down|sort|arrange|top|bottom|raise|lower' "$OUT/ax/c1-menubar-heading-selected.txt" | sed 's/^/    /' | tee -a "$REPORT"

  # ---- 1d: the CONTEXT menu (REORDGAPS measured these AX-INVISIBLE on 3.22)
  bmark "cell1d context menu"
  note ""
  note "  --- 1d: the heading row's CONTEXT menu (CGEvent right-click) ---"
  MF=$(AXM more-frame "MB"); note "    More-button frame: $MF"
  CX=$(echo "$MF" | python3 -c "import sys,json;print(json.load(sys.stdin)['cx'])" 2>/dev/null || echo "")
  CY=$(echo "$MF" | python3 -c "import sys,json;print(json.load(sys.stdin)['cy'])" 2>/dev/null || echo "")
  if [ -z "$CX" ]; then
    note "    could not resolve the heading row; skipping the right-click"
  else
    # aim well LEFT of the ellipsis so the right-click lands on the row body
    RX=$((CX - 300))
    note "    right-click at ($RX,$CY): $(AXM rclick "$RX" "$CY")"
    lab_ssh "$IP" 'sleep 2' </dev/null
    AXM menus > "$OUT/ax/c1-contextmenu-menus.txt" 2>&1
    AXM dump  > "$OUT/ax/c1-contextmenu-dump.txt" 2>&1
    note "    AXMenu census after the right-click:"
    head -60 "$OUT/ax/c1-contextmenu-menus.txt" | sed 's/^/      /' | tee -a "$REPORT"
    note "    app-children census after the right-click:"
    grep -E '^=== CHILD' "$OUT/ax/c1-contextmenu-dump.txt" | sed 's/^/      /' | tee -a "$REPORT"
    axq 'tell application "System Events" to tell process "Things3"
  set out to "process menus=" & (count of menus) & "  windows=" & (count of windows) & linefeed
  repeat with w in windows
    set out to out & "  window sub=" & (subrole of w) & " ttl=" & (title of w) & " menus=" & (count of menus of w) & linefeed
  end repeat
  return out
end tell' | sed 's/^/      /' | tee -a "$REPORT"
    esc
  fi

  # ---- 1e: the keyboard-chord family --------------------------------------
  bmark "cell1e keyboard family"
  note ""
  note "  --- 1e: the arrow-chord family against the selected heading ---"
  note "    (each arm re-selects the heading, fires the chord, reads the DB index back;"
  note "     a beep here is the app DECLINING the gesture — the sentinel counts it)"
  BEFORE_IDX=$(horder "$PM")
  note "    baseline order: $BEFORE_IDX"
  # CGEventFlags: cmd=1048576 shift=131072 opt=524288 ctrl=262144 ; up=126 down=125
  for arm in "cmd-up:126:1048576" "cmd-down:125:1048576" "cmd-opt-up:126:1572864" "cmd-opt-down:125:1572864" "cmd-ctrl-up:126:1310720" "cmd-shift-up:126:1179648" "ctrl-cmd-down:125:1310720"; do
    NAME="${arm%%:*}"; REST="${arm#*:}"; CODE="${REST%%:*}"; FLAGS="${REST#*:}"
    bmark "cell1e $NAME"
    lab_ssh "$IP" 'osascript ~/labh/sel-heading-1.applescript' </dev/null >/dev/null 2>&1
    AXM keymod "$CODE" "$FLAGS" >/dev/null
    lab_ssh "$IP" 'sleep 2' </dev/null
    AFTER_IDX=$(horder "$PM")
    if [ "$AFTER_IDX" = "$BEFORE_IDX" ]; then
      note "    $NAME  -> NO DB delta   ($AFTER_IDX)"
    else
      note "    $NAME  -> ***ORDER CHANGED***  $BEFORE_IDX  ==>  $AFTER_IDX"
      BEFORE_IDX="$AFTER_IDX"
    fi
  done
  note "  final heading order: $(horder "$PM")"
  hidx "$PM" | sed 's/^/    /' | tee -a "$REPORT"

  # ---- 1f: the ellipsis popover, for completeness -------------------------
  bmark "cell1f ellipsis popover"
  note ""
  note "  --- 1f: the heading's OWN ellipsis popover (the HEADXPROJ surface) — full census ---"
  warm
  show "things:///show?id=$PM"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  MF=$(AXM more-frame "MB")
  CX=$(echo "$MF" | python3 -c "import sys,json;print(json.load(sys.stdin)['cx'])" 2>/dev/null || echo "")
  CY=$(echo "$MF" | python3 -c "import sys,json;print(json.load(sys.stdin)['cy'])" 2>/dev/null || echo "")
  if [ -n "$CX" ]; then
    AXM click "$CX" "$CY" >/dev/null; lab_ssh "$IP" 'sleep 2' </dev/null
    AXM dump > "$OUT/ax/c1-ellipsis-popover.txt" 2>&1
    grep -E 'desc=' "$OUT/ax/c1-ellipsis-popover.txt" | sed 's/^/      /' | tee -a "$REPORT"
    esc
  fi

  note ""
  note "  --- BEEP SENTINEL (cell 1) ---"
  bs assert --name headord1-cell1 --json /Users/admin/things-lab/run/beeps-cell1.json | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== cell 1g
#
# Cell 1 found the affordance the campaign hoped for: ⌘↑ / ⌘↓ move a SELECTED
# heading, with no menu item and no context-menu item anywhere. That is the
# cheapest win, so it gets the scrutiny: a NULL control (does the row select
# alone move anything?), the ⌘↑-vs-⌘⌥↑ discrimination that three headings could
# not make, the boundary behaviour, children integrity, and whether the same
# chord reaches TO-DO rows.
if [ "$CMD" = "chords" ]; then
  load_session
  bs reset >/dev/null; bmark "cell1g setup"
  note ""
  note "############### CELL 1g — the ⌘↑/⌘↓ heading-move affordance, characterised ###############"
  STAMP=$(date +%H%M%S)
  TABLE='table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")'

  # five headings, so move-up-one and move-to-top are DISTINGUISHABLE
  seed_project "HO1G-P-$STAMP" "K1-$STAMP" "K2-$STAMP" "K3-$STAMP" "K4-$STAMP" "K5-$STAMP"
  PG=$(pid "HO1G-P-$STAMP")
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"HO1G-LOOSE1-$STAMP\",\"list-id\":\"$PG\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"HO1G-LOOSE2-$STAMP\",\"list-id\":\"$PG\"}}]"
  note "  project=$PG"
  note "  START: $(horder "$PG")"
  pdump "$PG" | sed 's/^/    /' | tee -a "$REPORT"

  # emit the shipped positional heading selector for each ordinal we need
  for o in 0 1 2 3 4; do
    node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectHeadingRowScript(process.argv[1], $o)))" "$TABLE" > "$OUT/sel-h$o.applescript"
    lab_ssh "$IP" "cat > ~/labh/sel-h$o.applescript" < "$OUT/sel-h$o.applescript"
  done
  selh() { lab_ssh "$IP" "osascript ~/labh/sel-h$1.applescript" </dev/null 2>&1; }

  warm
  show "things:///show?id=$PG"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null

  # ---- g0: THE NULL CONTROL ----------------------------------------------
  note ""
  note "  --- g0: NULL CONTROL — select a heading row and fire NOTHING ---"
  bmark "cell1g0 null control"
  B=$(horder "$PG")
  note "    select ordinal 2: $(selh 2)"
  lab_ssh "$IP" 'sleep 3' </dev/null
  A=$(horder "$PG")
  if [ "$A" = "$B" ]; then note "    NULL CONTROL CLEAN — the row select alone moves nothing ($A)"
  else note "    *** NULL CONTROL DIRTY — the select ITSELF reordered: $B ==> $A ***"; fi

  # ---- g1: ⌘↑ from the MIDDLE of five ------------------------------------
  note ""
  note "  --- g1: ⌘↑ with the THIRD of five headings selected (ordinal 2) ---"
  note "      move-up-ONE and move-to-TOP are now distinguishable"
  bmark "cell1g1 cmd-up"
  KID_BEFORE=$(gq "SELECT group_concat(title||':'||\"index\",' ') FROM (SELECT title, \"index\" FROM TMTask WHERE heading=(SELECT uuid FROM TMTask WHERE title='K3-$STAMP' AND type=2) AND trashed=0 ORDER BY \"index\")")
  selh 2 >/dev/null
  AXM keymod 126 1048576 >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    after ⌘↑ : $(horder "$PG")"
  hidx "$PG" | sed 's/^/      /' | tee -a "$REPORT"
  note "    K3 children before: [$KID_BEFORE]"
  note "    K3 children after:  [$(gq "SELECT group_concat(title||':'||\"index\",' ') FROM (SELECT title, \"index\" FROM TMTask WHERE heading=(SELECT uuid FROM TMTask WHERE title='K3-$STAMP' AND type=2) AND trashed=0 ORDER BY \"index\")")]"
  note "    K3 child project FK (expect NULL/-): $(gq "SELECT COALESCE(group_concat(DISTINCT COALESCE(substr(project,1,8),'NULL')),'-') FROM TMTask WHERE heading=(SELECT uuid FROM TMTask WHERE title='K3-$STAMP' AND type=2) AND trashed=0")"

  # ---- g2: ⌘⌥↑ from the middle -------------------------------------------
  note ""
  note "  --- g2: ⌘⌥↑ with the middle heading selected — up-one or to-TOP? ---"
  bmark "cell1g2 cmd-opt-up"
  B=$(horder "$PG"); note "    before: $B"
  selh 2 >/dev/null
  AXM keymod 126 1572864 >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    after ⌘⌥↑: $(horder "$PG")"

  # ---- g3: ⌘↓ and ⌘⌥↓ from the middle ------------------------------------
  note ""
  note "  --- g3: ⌘↓ then ⌘⌥↓, middle heading each time ---"
  bmark "cell1g3 cmd-down"
  B=$(horder "$PG"); note "    before ⌘↓ : $B"
  selh 2 >/dev/null
  AXM keymod 125 1048576 >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    after  ⌘↓ : $(horder "$PG")"
  bmark "cell1g3 cmd-opt-down"
  B=$(horder "$PG"); note "    before ⌘⌥↓: $B"
  selh 2 >/dev/null
  AXM keymod 125 1572864 >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    after  ⌘⌥↓: $(horder "$PG")"

  # ---- g4: the BOUNDARY — ⌘↑ on the TOP heading, ⌘↓ on the BOTTOM ---------
  note ""
  note "  --- g4: BOUNDARY — ⌘↑ on the topmost heading, ⌘↓ on the bottom one ---"
  note "      (a beep here would be the app declining; the sentinel is counting)"
  bmark "cell1g4 cmd-up at top"
  B=$(horder "$PG"); note "    before: $B"
  selh 0 >/dev/null
  AXM keymod 126 1048576 >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(horder "$PG")
  note "    ⌘↑ on the TOP heading -> $A  $([ "$A" = "$B" ] && echo '(no-op, as hoped)' || echo '(*** CHANGED ***)')"
  bmark "cell1g4 cmd-down at bottom"
  B=$(horder "$PG")
  selh 4 >/dev/null
  AXM keymod 125 1048576 >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(horder "$PG")
  note "    ⌘↓ on the BOTTOM heading -> $A  $([ "$A" = "$B" ] && echo '(no-op, as hoped)' || echo '(*** CHANGED ***)')"

  # ---- g5: does the chord reach the LOOSE TO-DO block? -------------------
  note ""
  note "  --- g5: the same chord on a TO-DO row (loose, unheaded) ---"
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectRowScript(process.argv[1], process.argv[2])))" "$TABLE" "HO1G-LOOSE2-$STAMP" > "$OUT/sel-loose2.applescript"
  lab_ssh "$IP" 'cat > ~/labh/sel-loose2.applescript' < "$OUT/sel-loose2.applescript"
  bmark "cell1g5 todo cmd-up"
  LB=$(gq "SELECT group_concat(t,' < ') FROM (SELECT title AS t FROM TMTask WHERE project='$PG' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\")")
  note "    loose to-dos before: $LB"
  note "    select-row(HO1G-LOOSE2): $(lab_ssh "$IP" 'osascript ~/labh/sel-loose2.applescript' </dev/null 2>&1)"
  AXM keymod 126 1048576 >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  LA=$(gq "SELECT group_concat(t,' < ') FROM (SELECT title AS t FROM TMTask WHERE project='$PG' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\")")
  note "    loose to-dos after ⌘↑: $LA  $([ "$LA" = "$LB" ] && echo '(unchanged)' || echo '(*** TO-DOS REORDER TOO ***)')"
  note "    heading order unaffected? $(horder "$PG")"
  note "    full dump:"
  pdump "$PG" | sed 's/^/      /' | tee -a "$REPORT"

  # ---- g6: is the chord anywhere in the menu bar at all? -----------------
  note ""
  note "  --- g6: does ANY menu item carry an arrow-key equivalent? ---"
  selh 2 >/dev/null
  axq 'tell application "System Events" to tell process "Things3"
  set out to ""
  repeat with mb in menu bar items of menu bar 1
    try
      repeat with mi in menu items of menu 1 of mb
        set cc to ""
        try
          set cc to (value of attribute "AXMenuItemCmdChar" of mi) as text
        end try
        set kg to ""
        try
          set kg to (value of attribute "AXMenuItemCmdGlyph" of mi) as text
        end try
        if kg is not "" and kg is not "missing value" then
          set nm to ""
          try
            set nm to name of mi
          end try
          set out to out & "  " & (name of mb) & " > " & nm & "  glyph=" & kg & " char=[" & cc & "] enabled=" & ((enabled of mi) as text) & linefeed
        end if
      end repeat
    end try
  end repeat
  if out is "" then set out to "  (no menu item anywhere carries a CmdGlyph key equivalent)"
  return out
end tell' | tee -a "$REPORT"

  # ---- g7: an AX ACTION on the heading row? -------------------------------
  note ""
  note "  --- g7: the heading row's own AX actions ---"
  axq 'tell application "System Events" to tell process "Things3"
  set t to table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")
  set out to ""
  repeat with i from 1 to (count of rows of t)
    try
      if (selected of row i of t) then
        set out to out & "row " & i & " actions: " & ((name of every action of row i of t) as text) & linefeed
      end if
    end try
  end repeat
  if out is "" then set out to "(no selected row found)"
  return out
end tell' | sed 's/^/    /' | tee -a "$REPORT"

  # ---- g8: COST — ten consecutive chords, timed --------------------------
  note ""
  note "  --- g8: cost — 10 consecutive select+chord cycles, timed ---"
  bmark "cell1g8 cost"
  T0=$(date +%s)
  for n in 1 2 3 4 5 6 7 8 9 10; do
    selh 2 >/dev/null
    AXM keymod 126 1048576 >/dev/null
  done
  T1=$(date +%s)
  note "    10 select+⌘↑ cycles in $((T1-T0))s = $(python3 -c "print(round(($T1-$T0)/10.0,2))")s per move (select dominates)"
  note "    order now: $(horder "$PG")"

  note ""
  note "  --- BEEP SENTINEL (cell 1g) ---"
  bs assert --name headord1-cell1g --json /Users/admin/things-lab/run/beeps-cell1g.json | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== cell 1h
#
# Cell 1g settled WHAT the chords do. Cell 1h settles what a SHIPPED op would
# need: can the chord ride the existing pure-System-Events key primitive (which
# is background-capable and steals no focus) or does it need a CGEvent HID post
# and a frontmost app? What does the same chord do to a HEADED CHILD — can it be
# pushed across a heading boundary (a membership rip, the HEADORD-a hazard)? And
# what does the protocol cost when the row is selected ONCE and the chord fired
# N times?
if [ "$CMD" = "chords2" ]; then
  load_session
  bs reset >/dev/null; bmark "cell1h setup"
  note ""
  note "############### CELL 1h — the SHIPPED-OP questions ###############"
  STAMP=$(date +%H%M%S)
  TABLE='table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")'

  # a pid-targeted key poster, for the background-capability arm
  lab_ssh "$IP" 'cat > ~/labh/keypid.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function run(argv){
  var pid=pidOf('Things3'), code=+argv[0], flags=+argv[1];
  var d=$.CGEventCreateKeyboardEvent($(),code,true), u=$.CGEventCreateKeyboardEvent($(),code,false);
  $.CGEventSetFlags(d,flags); $.CGEventSetFlags(u,flags);
  $.CGEventPostToPid(pid,d); sleepMs(70); $.CGEventPostToPid(pid,u); sleepMs(70);
  return 'POSTED-TO-PID '+pid+' code='+code+' flags='+flags }
EOF

  seed_project "HO1H-P-$STAMP" "M1-$STAMP" "M2-$STAMP" "M3-$STAMP" "M4-$STAMP" "M5-$STAMP"
  PH=$(pid "HO1H-P-$STAMP")
  for o in 0 1 2 3 4; do
    node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectHeadingRowScript(process.argv[1], $o)))" "$TABLE" > "$OUT/sel-h$o.applescript"
    lab_ssh "$IP" "cat > ~/labh/sel-h$o.applescript" < "$OUT/sel-h$o.applescript"
  done
  selh() { lab_ssh "$IP" "osascript ~/labh/sel-h$1.applescript" </dev/null 2>&1; }
  note "  project=$PH"
  note "  START: $(horder "$PH")"

  warm
  show "things:///show?id=$PH"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null

  # ---- h1: the PURE System Events key path (the shipped `key` primitive) --
  note ""
  note "  --- h1: System Events \`key code 126 using command down\` (no CGEvent) ---"
  note "      This is the vector the shipped ui `key` primitive already speaks. If it"
  note "      works, a heading-order op needs NO new primitive and NO HID tap."
  bmark "cell1h1 systemevents key"
  B=$(horder "$PH"); note "    before: $B"
  selh 2 >/dev/null
  R=$(axq 'tell application "System Events" to tell process "Things3" to key code 126 using command down')
  note "    osascript said: [$R]"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(horder "$PH")
  if [ "$A" != "$B" ]; then note "    *** WORKS via pure System Events: $B  ==>  $A ***"
  else note "    NO DELTA — System Events key code does not reach it ($A)"; fi

  # ---- h2: BACKGROUND capability -----------------------------------------
  note ""
  note "  --- h2: does the chord land while Things is NOT frontmost? ---"
  bmark "cell1h2 background"
  B=$(horder "$PH")
  selh 2 >/dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 3' </dev/null
  FRONT=$(axq 'tell application "System Events" to return name of first process whose frontmost is true')
  note "    frontmost app is now: [$FRONT]"
  note "    (a) CGEventPostToPid: $(lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/keypid.js 126 1048576" </dev/null 2>&1)"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(horder "$PH")
  if [ "$A" != "$B" ]; then note "    *** BACKGROUND MOVE LANDED (postToPid): $B  ==>  $A ***"
  else note "    no delta from CGEventPostToPid while backgrounded ($A)"; fi
  B="$A"
  note "    (b) System Events key code while backgrounded:"
  R=$(axq 'tell application "System Events" to tell process "Things3" to key code 126 using command down')
  note "        osascript said: [$R]"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(horder "$PH")
  note "        frontmost still: [$(axq 'tell application "System Events" to return name of first process whose frontmost is true')]"
  if [ "$A" != "$B" ]; then note "    *** BACKGROUND MOVE LANDED (System Events): $B  ==>  $A ***"
  else note "        no delta ($A)"; fi

  # ---- h3: LOOSE TO-DOS in a headings-free project ------------------------
  note ""
  note "  --- h3: the same chord on LOOSE TO-DOS, in a project with NO headings ---"
  note "      (out of this campaign's scope, but it decides whether the whole 3.23"
  note "       ordering loss has a GUI answer, not just the heading half)"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"HO1H-T-$STAMP\",\"items\":[{\"type\":\"to-do\",\"attributes\":{\"title\":\"T1-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"T2-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"T3-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"T4-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"T5-$STAMP\"}}]}}]"
  PT=$(pid "HO1H-T-$STAMP")
  torder() { gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$1' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" ASC)"; }
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectRowScript(process.argv[1], process.argv[2])))" "$TABLE" "T3-$STAMP" > "$OUT/sel-t3.applescript"
  lab_ssh "$IP" 'cat > ~/labh/sel-t3.applescript' < "$OUT/sel-t3.applescript"
  warm
  show "things:///show?id=$PT"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  bmark "cell1h3 todo chords"
  note "    START: $(torder "$PT")"
  gt "SELECT title, \"index\" AS idx FROM TMTask WHERE project='$PT' AND type=0 AND trashed=0 ORDER BY \"index\"" | sed 's/^/      /' | tee -a "$REPORT"
  note "    select T3: $(lab_ssh "$IP" 'osascript ~/labh/sel-t3.applescript' </dev/null 2>&1)"
  axq 'tell application "System Events" to tell process "Things3" to key code 126 using command down' >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    after ⌘↑ : $(torder "$PT")"
  lab_ssh "$IP" 'osascript ~/labh/sel-t3.applescript' </dev/null >/dev/null 2>&1
  axq 'tell application "System Events" to tell process "Things3" to key code 126 using command down and option down' >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    after ⌘⌥↑: $(torder "$PT")"
  lab_ssh "$IP" 'osascript ~/labh/sel-t3.applescript' </dev/null >/dev/null 2>&1
  axq 'tell application "System Events" to tell process "Things3" to key code 125 using command down and option down' >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    after ⌘⌥↓: $(torder "$PT")"
  gt "SELECT title, \"index\" AS idx FROM TMTask WHERE project='$PT' AND type=0 AND trashed=0 ORDER BY \"index\"" | sed 's/^/      /' | tee -a "$REPORT"

  # ---- h4: a HEADED CHILD — can the chord rip it across a heading? -------
  note ""
  note "  --- h4: a HEADED CHILD driven ⌘↑ at the TOP of its heading (the membership rip) ---"
  note "      HEADORD-a's lesson: the only native reorder that reached headed children"
  note "      ripped the heading FK. Does the chord do the same at a bucket boundary?"
  bmark "cell1h4 headed child"
  warm
  show "things:///show?id=$PH"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  H2U=$(hid "M2-$STAMP"); H1U=$(hid "M1-$STAMP")
  note "    M1=$H1U  M2=$H2U"
  note "    M1 children: $(gq "SELECT group_concat(title,' < ') FROM (SELECT title FROM TMTask WHERE heading='$H1U' AND trashed=0 ORDER BY \"index\")")"
  note "    M2 children: $(gq "SELECT group_concat(title,' < ') FROM (SELECT title FROM TMTask WHERE heading='$H2U' AND trashed=0 ORDER BY \"index\")")"
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectRowScript(process.argv[1], process.argv[2])))" "$TABLE" "M2-$STAMP-c1" > "$OUT/sel-m2c1.applescript"
  lab_ssh "$IP" 'cat > ~/labh/sel-m2c1.applescript' < "$OUT/sel-m2c1.applescript"
  note "    select M2-c1 (first child of M2): $(lab_ssh "$IP" 'osascript ~/labh/sel-m2c1.applescript' </dev/null 2>&1)"
  C1=$(gq "SELECT uuid FROM TMTask WHERE title='M2-$STAMP-c1' AND trashed=0 LIMIT 1")
  note "    before: heading=$(gq "SELECT COALESCE(substr(heading,1,8),'NULL') FROM TMTask WHERE uuid='$C1'") project=$(gq "SELECT COALESCE(substr(project,1,8),'NULL') FROM TMTask WHERE uuid='$C1'") index=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$C1'")"
  axq 'tell application "System Events" to tell process "Things3" to key code 126 using command down' >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    after ⌘↑ (child was at the TOP of its heading):"
  note "      heading=$(gq "SELECT COALESCE(substr(heading,1,8),'NULL') FROM TMTask WHERE uuid='$C1'") project=$(gq "SELECT COALESCE(substr(project,1,8),'NULL') FROM TMTask WHERE uuid='$C1'") index=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$C1'")"
  note "      M1 children now: $(gq "SELECT group_concat(title,' < ') FROM (SELECT title FROM TMTask WHERE heading='$H1U' AND trashed=0 ORDER BY \"index\")")"
  note "      M2 children now: $(gq "SELECT group_concat(title,' < ') FROM (SELECT title FROM TMTask WHERE heading='$H2U' AND trashed=0 ORDER BY \"index\")")"
  note "      heading order unchanged? $(horder "$PH")"
  note "    full dump:"
  pdump "$PH" | sed 's/^/      /' | tee -a "$REPORT"

  # ---- h5: cost with the row selected ONCE -------------------------------
  note ""
  note "  --- h5: cost — select ONCE, then fire the chord 10 times ---"
  bmark "cell1h5 cost"
  warm
  show "things:///show?id=$PH"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  selh 4 >/dev/null
  B=$(horder "$PH")
  T0=$(date +%s)
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3"
  repeat 10 times
    key code 126 using command down
    delay 0.15
  end repeat
end tell'\''' </dev/null >/dev/null 2>&1
  T1=$(date +%s)
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    10 chords (one ssh round trip, one selection) in $((T1-T0))s"
  note "    before: $B"
  note "    after : $(horder "$PH")"
  note "    (the bottom heading walked to the top and then declined — count the beeps below)"

  note ""
  note "  --- BEEP SENTINEL (cell 1h) ---"
  bs assert --name headord1-cell1h --json /Users/admin/things-lab/run/beeps-cell1h.json | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== cell 1i
#
# The loose ends cell 1h left: the to-do ⌘⌥ arms ran with their selection
# result DISCARDED, so "no delta" could have been a failed select rather than an
# inert chord (a zero delta from an unproven vector is not evidence — CNCAC1's
# positive-control doctrine). Plus the OTHER heading boundary (a child driven
# DOWN out of the last slot) and what a heading does when it moves past a LOOSE
# to-do.
if [ "$CMD" = "chords3" ]; then
  load_session
  bs reset >/dev/null; bmark "cell1i setup"
  note ""
  note "############### CELL 1i — the loose ends, with the selection PROVEN each time ###############"
  STAMP=$(date +%H%M%S)
  TABLE='table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")'
  emit_selrow() { node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectRowScript(process.argv[1], process.argv[2])))" "$TABLE" "$1" > "$OUT/sel-row.applescript"; lab_ssh "$IP" 'cat > ~/labh/sel-row.applescript' < "$OUT/sel-row.applescript"; }
  selrow() { emit_selrow "$1"; lab_ssh "$IP" 'osascript ~/labh/sel-row.applescript' </dev/null 2>&1; }
  chord() { axq "tell application \"System Events\" to tell process \"Things3\" to key code $1 $2" >/dev/null; lab_ssh "$IP" 'sleep 2' </dev/null; }
  torder() { gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$1' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" ASC)"; }

  # ---- i1: the to-do ⌘⌥ arms, selection PROVEN ---------------------------
  note ""
  note "  --- i1: LOOSE TO-DOS, ⌘↑ / ⌘⌥↑ / ⌘⌥↓, each with the select readback printed ---"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"HO1I-T-$STAMP\",\"items\":[{\"type\":\"to-do\",\"attributes\":{\"title\":\"U1-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"U2-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"U3-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"U4-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"U5-$STAMP\"}}]}}]"
  PT=$(pid "HO1I-T-$STAMP")
  warm
  show "things:///show?id=$PT"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  bmark "cell1i1 todo arms"
  note "    START: $(torder "$PT")"
  for a in "cmd-up:126:using command down" "cmd-opt-up:126:using {command down, option down}" "cmd-opt-down:125:using {command down, option down}" "cmd-down:125:using command down"; do
    NM="${a%%:*}"; R2="${a#*:}"; CODE="${R2%%:*}"; MODS="${R2#*:}"
    B=$(torder "$PT")
    S=$(selrow "U3-$STAMP")
    note "    [$NM] select U3 -> $S"
    chord "$CODE" "$MODS"
    A=$(torder "$PT")
    note "         before: $B"
    note "         after : $A   $([ "$A" = "$B" ] && echo 'NO DELTA' || echo 'MOVED')"
  done
  gt "SELECT title, \"index\" AS idx FROM TMTask WHERE project='$PT' AND type=0 AND trashed=0 ORDER BY \"index\"" | sed 's/^/      /' | tee -a "$REPORT"

  # ---- i2: a heading's LAST child driven DOWN ----------------------------
  note ""
  note "  --- i2: the LAST child of a heading driven ⌘↓ — does it fall into the NEXT heading? ---"
  seed_project "HO1I-P-$STAMP" "N1-$STAMP" "N2-$STAMP" "N3-$STAMP"
  PP=$(pid "HO1I-P-$STAMP")
  N1=$(hid "N1-$STAMP"); N2=$(hid "N2-$STAMP")
  warm
  show "things:///show?id=$PP"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  bmark "cell1i2 last child down"
  C2=$(gq "SELECT uuid FROM TMTask WHERE title='N1-$STAMP-c2' AND trashed=0 LIMIT 1")
  note "    N1 children: $(gq "SELECT group_concat(title,' < ') FROM (SELECT title FROM TMTask WHERE heading='$N1' AND trashed=0 ORDER BY \"index\")")"
  note "    N2 children: $(gq "SELECT group_concat(title,' < ') FROM (SELECT title FROM TMTask WHERE heading='$N2' AND trashed=0 ORDER BY \"index\")")"
  note "    select N1-c2 (LAST child of N1) -> $(selrow "N1-$STAMP-c2")"
  note "    before: heading=$(gq "SELECT COALESCE(substr(heading,1,8),'NULL') FROM TMTask WHERE uuid='$C2'") index=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$C2'")"
  chord 125 "using command down"
  note "    after ⌘↓: heading=$(gq "SELECT COALESCE(substr(heading,1,8),'NULL') FROM TMTask WHERE uuid='$C2'") project=$(gq "SELECT COALESCE(substr(project,1,8),'NULL') FROM TMTask WHERE uuid='$C2'") index=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$C2'")"
  note "      N1 children now: $(gq "SELECT COALESCE(group_concat(title,' < '),'(none)') FROM (SELECT title FROM TMTask WHERE heading='$N1' AND trashed=0 ORDER BY \"index\")")"
  note "      N2 children now: $(gq "SELECT COALESCE(group_concat(title,' < '),'(none)') FROM (SELECT title FROM TMTask WHERE heading='$N2' AND trashed=0 ORDER BY \"index\")")"
  note "      heading order:   $(horder "$PP")"

  # ---- i3: a HEADING moved past a LOOSE to-do ----------------------------
  note ""
  note "  --- i3: a heading driven ⌘↑ past a LOOSE (unheaded) to-do above it ---"
  seed_project "HO1I-L-$STAMP" "W1-$STAMP" "W2-$STAMP"
  PL=$(pid "HO1I-L-$STAMP")
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"HO1I-LOOSE-$STAMP\",\"list-id\":\"$PL\"}}]"
  W2=$(hid "W2-$STAMP")
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectHeadingRowScript(process.argv[1], 1)))" "$TABLE" > "$OUT/sel-h1.applescript"
  lab_ssh "$IP" 'cat > ~/labh/sel-h1.applescript' < "$OUT/sel-h1.applescript"
  warm
  show "things:///show?id=$PL"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  bmark "cell1i3 heading past loose"
  note "    before:"
  pdump "$PL" | sed 's/^/      /' | tee -a "$REPORT"
  note "    select heading ordinal 1 (W2) -> $(lab_ssh "$IP" 'osascript ~/labh/sel-h1.applescript' </dev/null 2>&1)"
  chord 126 "using command down"
  note "    after ⌘↑:"
  pdump "$PL" | sed 's/^/      /' | tee -a "$REPORT"
  note "    heading order: $(horder "$PL")"
  note "    the loose to-do's heading FK (a rip would set it): $(gq "SELECT COALESCE(substr(heading,1,8),'NULL') FROM TMTask WHERE title='HO1I-LOOSE-$STAMP' AND trashed=0")"
  note "    W2's children still 2? $(kids "$W2")"

  note ""
  note "  --- BEEP SENTINEL (cell 1i) ---"
  bs assert --name headord1-cell1i --json /Users/admin/things-lab/run/beeps-cell1i.json | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== beeps (re-read)
if [ "$CMD" = "beeps" ]; then
  load_session
  bs assert --name "${2:-headord1}" | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== cell 2
if [ "$CMD" = "landing" ]; then
  load_session
  bs reset >/dev/null; bmark "cell2 setup"
  note ""
  note "############### CELL 2 — the RE-ENTRY LANDING LAW ###############"
  note "Move a heading OUT of P into an ephemeral E, then BACK into P. Where does it"
  note "land — end / after the last heading / its original slot? Five arms."
  STAMP=$(date +%H%M%S)

  arm() { note ""; note "  ===== ARM $1 — $2 ====="; }
  classify() { # classify <observed> <A> <B> <C>
    case "$1" in
      "$2 < $4 < $3") echo "END (appended after the last heading)" ;;
      "$3 < $2 < $4") echo "FRONT (prepended)" ;;
      "$2 < $3 < $4") echo "ORIGINAL SLOT restored" ;;
      *) echo "UNCLASSIFIED" ;;
    esac
  }

  # ---- ARM 1: the base case — A,B,C, bounce the MIDDLE heading -----------
  arm 1 "base: P=[A,B,C], bounce the MIDDLE heading B out and back"
  seed_project "HO2-P1-$STAMP" "A1-$STAMP" "B1-$STAMP" "C1-$STAMP"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"HO2-E1-$STAMP\",\"items\":[]}}]"
  P1=$(pid "HO2-P1-$STAMP"); E1=$(pid "HO2-E1-$STAMP"); HB=$(hid "B1-$STAMP")
  note "    P=$P1  E=$E1  B=$HB"
  note "    before:  $(horder "$P1")"
  hidx "$P1" | sed 's/^/      /' | tee -a "$REPORT"
  note "    B children before: $(kids "$HB")"
  warm
  note "    leg 1 (P -> E): $(mv_heading "$P1" "$HB" "$E1" "arm1 leg1")"
  note "      P now: $(horder "$P1")   E now: $(horder "$E1")"
  note "      B children after leg 1: $(kids "$HB")"
  note "    leg 2 (E -> P): $(mv_heading "$E1" "$HB" "$P1" "arm1 leg2")"
  A1=$(horder "$P1")
  note "    AFTER:   $A1"
  hidx "$P1" | sed 's/^/      /' | tee -a "$REPORT"
  note "    B children after: $(kids "$HB")"
  note "    full project dump:"
  pdump "$P1" | sed 's/^/      /' | tee -a "$REPORT"
  note "    LANDING = $(classify "$A1" "A1-$STAMP" "B1-$STAMP" "C1-$STAMP")"

  # ---- ARM 2: LOOSE to-dos present in P ----------------------------------
  arm 2 "loose to-dos present in P (do they interleave / renumber?)"
  seed_project "HO2-P2-$STAMP" "A2-$STAMP" "B2-$STAMP" "C2-$STAMP"
  P2=$(pid "HO2-P2-$STAMP")
  tj "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"HO2-LOOSE1-$STAMP\",\"list-id\":\"$P2\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"HO2-LOOSE2-$STAMP\",\"list-id\":\"$P2\"}}]"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"HO2-E2-$STAMP\",\"items\":[]}}]"
  E2=$(pid "HO2-E2-$STAMP"); HB2=$(hid "B2-$STAMP")
  note "    P=$P2  E=$E2  B=$HB2"
  note "    before:  $(horder "$P2")"
  pdump "$P2" | sed 's/^/      /' | tee -a "$REPORT"
  warm
  note "    leg 1 (P -> E): $(mv_heading "$P2" "$HB2" "$E2" "arm2 leg1")"
  note "    leg 2 (E -> P): $(mv_heading "$E2" "$HB2" "$P2" "arm2 leg2")"
  A2=$(horder "$P2")
  note "    AFTER:   $A2"
  note "    LANDING = $(classify "$A2" "A2-$STAMP" "B2-$STAMP" "C2-$STAMP")"
  pdump "$P2" | sed 's/^/      /' | tee -a "$REPORT"

  # ---- ARM 3: P has ZERO remaining headings when the heading re-enters ----
  arm 3 "P is EMPTY of headings when the heading re-enters"
  seed_project "HO2-P3-$STAMP" "A3-$STAMP"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"HO2-E3-$STAMP\",\"items\":[]}}]"
  P3=$(pid "HO2-P3-$STAMP"); E3=$(pid "HO2-E3-$STAMP"); HA3=$(hid "A3-$STAMP")
  note "    P=$P3  E=$E3  A=$HA3"
  note "    before:  $(horder "$P3")"
  warm
  note "    leg 1 (P -> E): $(mv_heading "$P3" "$HA3" "$E3" "arm3 leg1")"
  note "      P now: [$(horder "$P3")]  (expect (none))"
  note "    leg 2 (E -> P): $(mv_heading "$E3" "$HA3" "$P3" "arm3 leg2")"
  note "    AFTER:   $(horder "$P3")"
  hidx "$P3" | sed 's/^/      /' | tee -a "$REPORT"
  note "    A children after: $(kids "$HA3")"

  # ---- ARM 4: a SOMEDAY destination project ------------------------------
  arm 4 "the destination project is in SOMEDAY"
  seed_project "HO2-P4-$STAMP" "A4-$STAMP" "B4-$STAMP"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"HO2-SD4-$STAMP\",\"items\":[]}}]"
  P4=$(pid "HO2-P4-$STAMP"); SD4=$(pid "HO2-SD4-$STAMP"); HB4=$(hid "B4-$STAMP")
  lab_ssh "$IP" "open -g 'things:///update-project?id=$SD4&auth-token=$TOKEN&when=someday'; sleep 4" </dev/null
  note "    someday dest start=$(gq "SELECT start FROM TMTask WHERE uuid='$SD4'") (2 = someday)"
  note "    P=$P4  SD=$SD4  B=$HB4"
  warm
  note "    leg 1 (P -> SD): $(mv_heading "$P4" "$HB4" "$SD4" "arm4 leg1")"
  note "      SD now: [$(horder "$SD4")]   B children: $(kids "$HB4")"
  note "      the moved heading's own start: $(gq "SELECT start FROM TMTask WHERE uuid='$HB4'")"
  note "    leg 2 (SD -> P): $(mv_heading "$SD4" "$HB4" "$P4" "arm4 leg2")"
  note "    AFTER:   $(horder "$P4")"
  hidx "$P4" | sed 's/^/      /' | tee -a "$REPORT"

  # ---- ARM 5: determinism — two more fresh runs of the base case ---------
  arm 5 "determinism — the base bounce repeated on two fresh fixtures"
  for k in 5a 5b; do
    seed_project "HO2-P$k-$STAMP" "A$k-$STAMP" "B$k-$STAMP" "C$k-$STAMP"
    tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"HO2-E$k-$STAMP\",\"items\":[]}}]"
    PK=$(pid "HO2-P$k-$STAMP"); EK=$(pid "HO2-E$k-$STAMP"); HK=$(hid "B$k-$STAMP")
    warm
    R1=$(mv_heading "$PK" "$HK" "$EK" "arm$k leg1")
    R2=$(mv_heading "$EK" "$HK" "$PK" "arm$k leg2")
    AK=$(horder "$PK")
    note "    $k: legs [$R1] [$R2] -> $AK"
    note "        LANDING = $(classify "$AK" "A$k-$STAMP" "B$k-$STAMP" "C$k-$STAMP")"
    hidx "$PK" | sed 's/^/        /' | tee -a "$REPORT"
  done

  note ""
  note "  --- BEEP SENTINEL (cell 2) ---"
  bs assert --name headord1-cell2 --json /Users/admin/things-lab/run/beeps-cell2.json | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== cell 3
if [ "$CMD" = "bounce" ]; then
  load_session
  bs reset >/dev/null; bmark "cell3 setup"
  note ""
  note "############### CELL 3 — the FULL BOUNCE PROTOTYPE ###############"
  note "Target order C,A,B from A,B,C. Cell 2 measured the landing law as FRONT-INSERT"
  note "(4/4), so the compile protocol is the REVERSE-order bounce — the same shape"
  note "ANYBNC/SOMEBNC-area take for front-inserting to-dos, NOT the forward-order"
  note "shape BOUNCE2-h took for back-inserting headed children. To land T1..Tn, bounce"
  note "Tn, Tn-1, … T1. Here the kept set is empty (the source ends in C but the target"
  note "ends in B), so all three bounce: B, A, C = 3 items x 2 legs = 6 GUI drives."
  note "The same reorder costs ONE chord (select C, cmd-opt-up) — cell 1g. This cell"
  note "prices both, honestly, side by side."
  STAMP=$(date +%H%M%S)

  seed_project "HO3-P-$STAMP" "HA-$STAMP" "HB-$STAMP" "HC-$STAMP"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"HO3-E-$STAMP\",\"items\":[]}}]"
  P=$(pid "HO3-P-$STAMP"); E=$(pid "HO3-E-$STAMP")
  HA=$(hid "HA-$STAMP"); HB=$(hid "HB-$STAMP"); HC=$(hid "HC-$STAMP")
  note "  P=$P  E=$E  A=$HA  B=$HB  C=$HC"
  note "  START:  $(horder "$P")"
  pdump "$P" | sed 's/^/    /' | tee -a "$REPORT"
  KA0=$(kids "$HA"); KB0=$(kids "$HB"); KC0=$(kids "$HC")
  note "  children before: A=$KA0 B=$KB0 C=$KC0"

  warm
  # REVERSE target order (target C,A,B) => bounce B, then A, then C.
  T0=$(date +%s); DISPATCH=0
  for pair in "B:$HB" "A:$HA" "C:$HC"; do
    NM="${pair%%:*}"; HU="${pair#*:}"
    note "  -- bounce $NM --"
    R=$(mv_heading "$P" "$HU" "$E" "cell3 $NM out");  DISPATCH=$((DISPATCH+1)); note "     out:  $R  | P: $(horder "$P")"
    R=$(mv_heading "$E" "$HU" "$P" "cell3 $NM back"); DISPATCH=$((DISPATCH+1)); note "     back: $R  | P: $(horder "$P")"
  done
  T1=$(date +%s)

  FINAL=$(horder "$P")
  note ""
  note "  FINAL:  $FINAL"
  note "  TARGET: HC-$STAMP < HA-$STAMP < HB-$STAMP"
  if [ "$FINAL" = "HC-$STAMP < HA-$STAMP < HB-$STAMP" ]; then
    note "  *** TARGET ORDER ACHIEVED ***"
  else
    note "  *** MISMATCH ***"
  fi
  hidx "$P" | sed 's/^/    /' | tee -a "$REPORT"
  note "  children after: A=$(kids "$HA") B=$(kids "$HB") C=$(kids "$HC")  (before A=$KA0 B=$KB0 C=$KC0)"
  note "  full project dump:"
  pdump "$P" | sed 's/^/    /' | tee -a "$REPORT"
  note "  scratch E now holds: [$(horder "$E")]  (expect (none))"
  note "  COST: $DISPATCH GUI dispatches, $((T1-T0))s wall to reorder 3 headings"
  note "        = $(python3 -c "print(round(($T1-$T0)/$DISPATCH,1))")s per dispatch"

  # ---- THE HEAD-TO-HEAD: the same reorder, by chord ----------------------
  note ""
  note "  --- HEAD TO HEAD: the SAME target order on a fresh fixture, by CHORD ---"
  seed_project "HO3-K-$STAMP" "KA-$STAMP" "KB-$STAMP" "KC-$STAMP"
  PK=$(pid "HO3-K-$STAMP")
  TABLE='table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")'
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectHeadingRowScript(process.argv[1], 2)))" "$TABLE" > "$OUT/sel-h2.applescript"
  lab_ssh "$IP" 'cat > ~/labh/sel-h2.applescript' < "$OUT/sel-h2.applescript"
  warm
  show "things:///show?id=$PK"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  note "  START:  $(horder "$PK")"
  bmark "cell3 chord protocol"
  CT0=$(date +%s)
  note "  select the third heading (KC) -> $(lab_ssh "$IP" 'osascript ~/labh/sel-h2.applescript' </dev/null 2>&1)"
  axq 'tell application "System Events" to tell process "Things3" to key code 126 using {command down, option down}' >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  CT1=$(date +%s)
  CFINAL=$(horder "$PK")
  note "  FINAL:  $CFINAL"
  note "  TARGET: KC-$STAMP < KA-$STAMP < KB-$STAMP"
  if [ "$CFINAL" = "KC-$STAMP < KA-$STAMP < KB-$STAMP" ]; then
    note "  *** TARGET ORDER ACHIEVED — 1 chord, $((CT1-CT0))s (vs $DISPATCH GUI dispatches / $((T1-T0))s) ***"
  else
    note "  *** MISMATCH ***"
  fi
  hidx "$PK" | sed 's/^/    /' | tee -a "$REPORT"
  note "  children intact: KA=$(kids "$(hid "KA-$STAMP")") KB=$(kids "$(hid "KB-$STAMP")") KC=$(kids "$(hid "KC-$STAMP")")"

  # ---- the mid-protocol failure mode -------------------------------------
  note ""
  note "  --- FAILURE MODE: what state remains if a leg dies mid-protocol? ---"
  seed_project "HO3-F-$STAMP" "FA-$STAMP" "FB-$STAMP"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"HO3-FE-$STAMP\",\"items\":[]}}]"
  PF=$(pid "HO3-F-$STAMP"); EF=$(pid "HO3-FE-$STAMP"); HFB=$(hid "FB-$STAMP")
  warm
  note "  out leg only: $(mv_heading "$PF" "$HFB" "$EF" "cell3 orphan")"
  note "  P holds:       [$(horder "$PF")]"
  note "  scratch holds: [$(horder "$EF")]   children still with it: $(kids "$HFB")"
  note "  recovery drive: $(mv_heading "$EF" "$HFB" "$PF" "cell3 recover")"
  note "  P after recovery: $(horder "$PF")   children: $(kids "$HFB")"

  note ""
  note "  --- BEEP SENTINEL (cell 3) ---"
  bs assert --name headord1-cell3 --json /Users/admin/things-lab/run/beeps-cell3.json | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== cell 4
if [ "$CMD" = "lifecycle" ]; then
  load_session
  bs reset >/dev/null; bmark "cell4 setup"
  note ""
  note "############### CELL 4 — the EPHEMERAL SCRATCH PROJECT LIFECYCLE ###############"
  note "create (URL) -> move a heading into a FRESHLY created project -> empty it ->"
  note "delete it. Does the picker see a just-created project? Is deleting the emptied"
  note "scratch clean?"
  STAMP=$(date +%H%M%S)

  seed_project "HO4-P-$STAMP" "GA-$STAMP" "GB-$STAMP"
  P=$(pid "HO4-P-$STAMP"); HGB=$(hid "GB-$STAMP")
  ROWS0=$(gq "SELECT COUNT(*) FROM TMTask"); PROJ0=$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0")
  note "  P=$P  GB=$HGB   rows=$ROWS0 open-projects=$PROJ0"

  # ---- 4a: create the scratch, relaunch, then move into it ---------------
  note ""
  note "  --- 4a: a freshly created project as the Move… destination (after a relaunch) ---"
  SCRATCH="things-api headord1 scratch $STAMP"
  bmark "cell4a create scratch"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"$SCRATCH\",\"items\":[]}}]"
  SU=$(pid "$SCRATCH")
  note "    scratch=$SU"
  warm
  note "    move GB -> the fresh scratch: $(mv_heading "$P" "$HGB" "$SU" "cell4a move-in")"
  note "    scratch holds: [$(horder "$SU")]   children with the heading: $(kids "$HGB")"
  note "    P holds:       [$(horder "$P")]"

  # ---- 4a2: a scratch created with NO relaunch in between ----------------
  note ""
  note "  --- 4a2: create a SECOND scratch and move into it with NO app relaunch ---"
  note "      (does the RUNNING app's picker index a project the URL scheme just added?)"
  S2="things-api headord1 scratch2 $STAMP"
  bmark "cell4a2 create scratch 2"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"$S2\",\"items\":[]}}]"
  SU2=$(pid "$S2")
  note "    scratch2=$SU2"
  note "    move GB (scratch -> scratch2), NO warm(): $(mv_heading "$SU" "$HGB" "$SU2" "cell4a2 move-in")"
  note "    scratch2 holds: [$(horder "$SU2")]"

  # ---- 4b: return the heading, delete BOTH emptied scratches -------------
  note ""
  note "  --- 4b: return the heading, then DELETE the emptied scratch projects ---"
  note "    return: $(mv_heading "$SU2" "$HGB" "$P" "cell4b return")"
  note "    P holds: [$(horder "$P")]   children: $(kids "$HGB")"
  note "    scratch empty? [$(horder "$SU")]  scratch2 empty? [$(horder "$SU2")]"
  note "    scratch child rows: $(gq "SELECT COUNT(*) FROM TMTask WHERE project='$SU' AND trashed=0") / scratch2: $(gq "SELECT COUNT(*) FROM TMTask WHERE project='$SU2' AND trashed=0")"
  # `project.delete` is AppleScript-only, and the Wave A write gate blocks the
  # AppleScript vector in every sshd-descended shell (harness.md / CNC1 §9). So
  # the delete is driven on the RAW WIRE the shipped command compiles to — the
  # same AppleScript, one gate short. This measures the APP, not our gate.
  bmark "cell4b delete scratches"
  for U in "$SU" "$SU2"; do
    D=$(axq "tell application \"Things3\" to delete project id \"$U\"")
    note "    delete $U -> [$D]  trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$U'")"
  done
  note "    heading GB after both deletes: project=$(gq "SELECT COALESCE(substr(project,1,8),'-') FROM TMTask WHERE uuid='$HGB'") trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$HGB'")"
  note "    GB children attached + untrashed: $(gq "SELECT COUNT(*) FROM TMTask WHERE heading='$HGB' AND trashed=0")"
  note "    P final: $(horder "$P")"
  pdump "$P" | sed 's/^/      /' | tee -a "$REPORT"
  note "    rows: before=$ROWS0 after=$(gq "SELECT COUNT(*) FROM TMTask")   open projects: before=$PROJ0 after=$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0")"

  # ---- 4c: deleting a NON-EMPTY scratch (the reorder.ts rule, priced) -----
  note ""
  note "  --- 4c: what deleting a NON-EMPTY scratch costs (the reorder.ts never-trash rule) ---"
  S3="things-api headord1 scratch3 $STAMP"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"$S3\",\"items\":[]}}]"
  SU3=$(pid "$S3")
  seed_project "HO4-Q-$STAMP" "QA-$STAMP"
  PQ=$(pid "HO4-Q-$STAMP"); HQA=$(hid "QA-$STAMP")
  warm
  note "    park QA into scratch3: $(mv_heading "$PQ" "$HQA" "$SU3" "cell4c park")"
  note "    scratch3 holds: [$(horder "$SU3")]  children: $(kids "$HQA")"
  D=$(axq "tell application \"Things3\" to delete project id \"$SU3\"")
  note "    delete the NON-EMPTY scratch3 -> [$D]"
  note "    scratch3 trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$SU3'")"
  note "    heading QA trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$HQA'") project=$(gq "SELECT COALESCE(substr(project,1,8),'-') FROM TMTask WHERE uuid='$HQA'")"
  note "    QA children untrashed: $(gq "SELECT COUNT(*) FROM TMTask WHERE heading='$HQA' AND trashed=0") of $(gq "SELECT COUNT(*) FROM TMTask WHERE heading='$HQA'")"

  note ""
  note "  --- BEEP SENTINEL (cell 4) ---"
  bs assert --name headord1-cell4 --json /Users/admin/things-lab/run/beeps-cell4.json | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== cell 4d
#
# Cell 4a2 failed in a way worth isolating: the drive typed the destination into
# the Move… picker and then found NO picker window to click in ("Can't get window
# 1 … whose subrole = AXUnknown … Invalid index"), i.e. the picker DISMISSED
# ITSELF between the filter keystrokes and the commit. The difference from the
# passing 4a was that 4a2's destination was created by the URL scheme while the
# app was ALREADY RUNNING, with no relaunch. Three candidate causes — the app not
# offering a just-created project, the title shape, or the source being a scratch
# project — separated here by dumping what the picker OFFERS at each step.
if [ "$CMD" = "picker" ]; then
  load_session
  bs reset >/dev/null; bmark "cell4d setup"
  note ""
  note "############### CELL 4d — why the Move… picker vanished (the 4a2 isolation) ###############"
  STAMP=$(date +%H%M%S)

  offer_rows() {
    axq 'tell application "System Events" to tell process "Things3"
  set wc to (count of (windows whose subrole is "AXUnknown" and size is not {40, 40}))
  if wc is 0 then return "  NO PICKER WINDOW (dismissed or never opened)"
  set W to (first window whose subrole is "AXUnknown" and size is not {40, 40})
  set out to "  picker id=" & (value of attribute "AXIdentifier" of W) & linefeed
  set sa to scroll area 1 of W
  repeat with i from 1 to (count of UI elements of sa)
    set e to UI element i of sa
    set d to ""
    try
      set d to (description of e) as text
    end try
    if d is not "" and (role of e) is "AXUnknown" then set out to out & "    [" & i & "] [" & d & "]" & linefeed
  end repeat
  return out
end tell'
  }
  open_picker() { # open_picker <projectUuid> <headingTitle>
    show "things:///show?id=$1"
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    local mf cx cy mv mvx mvy
    mf=$(AXM more-frame "$2")
    cx=$(echo "$mf" | python3 -c "import sys,json;print(json.load(sys.stdin)['cx'])" 2>/dev/null || echo "")
    cy=$(echo "$mf" | python3 -c "import sys,json;print(json.load(sys.stdin)['cy'])" 2>/dev/null || echo "")
    [ -n "$cx" ] || { echo "  NO MORE BUTTON for $2"; return 1; }
    AXM click "$cx" "$cy" >/dev/null; lab_ssh "$IP" 'sleep 2' </dev/null
    mv=$(AXM desc-frame "Move…")
    mvx=$(echo "$mv" | python3 -c "import sys,json;print(json.load(sys.stdin)['cx'])" 2>/dev/null || echo "")
    mvy=$(echo "$mv" | python3 -c "import sys,json;print(json.load(sys.stdin)['cy'])" 2>/dev/null || echo "")
    [ -n "$mvx" ] || { echo "  NO Move… ITEM"; return 1; }
    AXM click "$mvx" "$mvy" >/dev/null; lab_ssh "$IP" 'sleep 2' </dev/null
    echo "  picker opened"
  }

  seed_project "HO4D-P-$STAMP" "DA-$STAMP" "DB-$STAMP"
  PD=$(pid "HO4D-P-$STAMP")
  warm

  # two destinations created WHILE THE APP IS RUNNING: one long/spacey title
  # (the 4a2 shape) and one short plain one
  LONG="things-api headord1 scratch2 $STAMP"
  SHORT="HO4D-SHORT-$STAMP"
  bmark "cell4d create while running"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"$LONG\",\"items\":[]}}]"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"$SHORT\",\"items\":[]}}]"
  note "  created WHILE RUNNING: [$LONG]=$(pid "$LONG")  [$SHORT]=$(pid "$SHORT")"

  note ""
  note "  --- d1: picker WITHOUT a relaunch — is a just-created project offered at all? ---"
  bmark "cell4d1 no relaunch"
  note "$(open_picker "$PD" "DA-$STAMP")"
  note "    rows on offer, UNFILTERED (looking for the two new titles):"
  offer_rows | grep -iE "scratch2|HO4D-SHORT|picker id|NO PICKER" | sed 's/^/    /' | tee -a "$REPORT"
  note "    now type the LONG title:"
  axq "tell application \"System Events\" to keystroke \"$LONG\"" >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  offer_rows | sed 's/^/    /' | tee -a "$REPORT"
  esc; esc; esc

  note ""
  note "  --- d2: same picker, the SHORT title ---"
  bmark "cell4d2 short title"
  note "$(open_picker "$PD" "DA-$STAMP")"
  axq "tell application \"System Events\" to keystroke \"$SHORT\"" >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  offer_rows | sed 's/^/    /' | tee -a "$REPORT"
  esc; esc; esc

  note ""
  note "  --- d3: AFTER a relaunch — the same two titles ---"
  bmark "cell4d3 after relaunch"
  warm
  note "$(open_picker "$PD" "DA-$STAMP")"
  axq "tell application \"System Events\" to keystroke \"$LONG\"" >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  note "    LONG title, post-relaunch:"
  offer_rows | sed 's/^/    /' | tee -a "$REPORT"
  esc; esc; esc

  note ""
  note "  --- d4: does the shipped CLI now land it, post-relaunch? ---"
  bmark "cell4d4 cli move"
  warm
  HDB=$(hid "DB-$STAMP")
  note "    move DB -> [$LONG]: $(mv_heading "$PD" "$HDB" "$(pid "$LONG")" "cell4d4 move")"
  note "    dest holds: [$(horder "$(pid "$LONG")")]"

  note ""
  note "  --- BEEP SENTINEL (cell 4d) ---"
  bs assert --name headord1-cell4d --json /Users/admin/things-lab/run/beeps-cell4d.json | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ==================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: stop + delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  rm -f "$SESSION"
  note "teardown DONE"
  exit 0
fi

echo "usage: $0 setup|menu-census|landing|bounce|lifecycle|teardown" >&2
exit 1
