#!/bin/bash
# TAGLAB — tag-ordering (TAGORD1) + tag-inheritance (TAGINH1) knowledge probes.
# Disposable clone `taglab-lab` (golden things-lab-golden-v1). Read-heavy,
# minimal mutation. NOT an automation-unblock campaign — knowledge only.
#
#   research-taglab.sh setup      clone+boot+airgap+clock-pin+AX-grant+seed+kit
#   research-taglab.sh tagord     TAGORD1: tie-break oracle + nested-index + ties
#   research-taglab.sh taginh     TAGINH1-a: heading tagging (URL/AS/AX) + inherit
#   research-taglab.sh shot <name>  one VNC screenshot to artifacts/<name>.png
#   research-taglab.sh teardown   stop + delete the clone
#
# VM discipline: --vnc-experimental single-client — one vncdo per step, timeouts.
# Requires $VNCDO (vncdotool venv) for the AX grant (AXVM1 rung b) + screenshots.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/env.sh"
VM="taglab-lab"; CMD="${1:-}"; shift || true
OUT="$HERE/../artifacts/taglab-lab"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"; REPORT="$OUT/report.txt"
VNCDO="${VNCDO:-}"
AUTH="9dFi9fY-QBuqFq59yAUxOg"   # golden's Enable-Things-URLs token (golden-v1-metadata.json)

note() { echo "[taglab] $*" | tee -a "$REPORT"; }
load_session() { [ -f "$SESSION" ] && source "$SESSION"; : "${IP:?run setup first}"; }
gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gqh() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
AS()  { lab_ssh "$IP" "/usr/bin/osascript -e $(printf '%q' "$1")" </dev/null; }
URL() { lab_ssh "$IP" "open $(printf '%q' "$1"); sleep 2" </dev/null; }
AXR() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript /tmp/taglab.js $*" </dev/null; }
relaunch() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 3; open -a Things3; sleep 9' </dev/null; }

vnc_setup() {
  [ -z "$VNCDO" ] && { note "VNCDO unset — abort"; exit 1; }
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
}
V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }

ship_kit() {
  lab_ssh "$IP" 'cat > /tmp/taglab.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]) }
function sv(el,name){ var v=attr(el,name); return v? v.js : '' }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function frame(el){ var p=attr(el,'AXPosition'), z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null }
function findAll(el, wantRole, depth, acc){ acc=acc||[]; if(depth<0) return acc; var ch=kids(el);
  for(var i=0;i<ch.length;i++){ if(sv(ch[i],'AXRole')===wantRole) acc.push(ch[i]); findAll(ch[i], wantRole, depth-1, acc) } return acc }
function appEl(){ return $.AXUIElementCreateApplication(pidOf('Things3')) }
function allText(el, acc, depth){ acc=acc||[]; depth=depth==null?6:depth; if(depth<0) return acc;
  var v=sv(el,'AXValue'); if(v) acc.push('V:'+v); var d=sv(el,'AXDescription'); if(d) acc.push('D:'+d);
  var t=sv(el,'AXTitle'); if(t) acc.push('T:'+t); var ph=sv(el,'AXPlaceholderValue'); if(ph) acc.push('P:'+ph);
  var ch=kids(el); for(var i=0;i<ch.length;i++) allText(ch[i],acc,depth-1); return acc }
function rowsOf(t){ var out=[]; var ch=kids(t);
  for(var r=0;r<ch.length;r++){ var role=sv(ch[r],'AXRole');
    if(role==='AXRow'||role==='AXTableRow'){ var f=frame(ch[r]); out.push({text:allText(ch[r],[],6).join(' | '), y:f?Math.round(f.y):null}) } }
  return out }
function run(argv){
  var cmd=argv[0];
  if(cmd==='tagsopen'){
    var se=Application('System Events');
    se.processes.byName('Things3').menuBars[0].menuBarItems.byName('Window').menus[0].menuItems.byName('Tags').click();
    $.NSThread.sleepForTimeInterval(1.5); return 'OK';
  }
  if(cmd==='tagsrows'){
    var ws=kids(appEl());
    for(var i=0;i<ws.length;i++){ var title=sv(ws[i],'AXTitle');
      if(title && title.indexOf('Tag')>=0){
        var tabs=findAll(ws[i],'AXTable',12,[]).concat(findAll(ws[i],'AXOutline',12,[]));
        var out=[];
        for(var t=0;t<tabs.length;t++){ var rs=rowsOf(tabs[t]);
          for(var j=0;j<rs.length;j++) out.push({i:out.length, y:rs[j].y, text:rs[j].text}) }
        return JSON.stringify({window:title, rows:out});
      } }
    return 'NO_TAGS_WINDOW';
  }
  if(cmd==='menudump'){
    // menudump <TopMenuName> — list menu item titles + enabled of a menu-bar menu
    var se=Application('System Events'); var proc=se.processes.byName('Things3');
    try{ var m=proc.menuBars[0].menuBarItems.byName(argv[1]).menus[0];
      var items=m.menuItems(); var out=[];
      for(var i=0;i<items.length;i++){ out.push({t:items[i].name()||'', en:items[i].enabled()}); }
      return JSON.stringify(out);
    }catch(e){ return 'ERR '+e; }
  }
  if(cmd==='sidebartext'){
    // dump the main window sidebar + filter-bar text (to find tag pills / order)
    var ws=kids(appEl()); var w=null;
    for(var i=0;i<ws.length;i++){ if(sv(ws[i],'AXSubrole')==='AXStandardWindow'){ w=ws[i]; break } }
    if(!w) return 'NO_WIN';
    return JSON.stringify(allText(w,[],10));
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

  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

  note "granting Accessibility (AXVM1 rung b)"
  lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
  vnc_setup
  lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
  V capture "$OUT/screens/01-ax-pane.png"
  V move 1642 332 click 1; sleep 3; V capture "$OUT/screens/02-auth.png"
  V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3
  V capture "$OUT/screens/03-after-auth.png"
  note "-- AX rows after grant (expect auth_value 2) --"
  lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT service,client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null | tee -a "$REPORT"

  note "seeding tags (roots reverse-alpha creation order + a nested triad)"
  # roots: created Zeta first ... Alfa last. title-asc = Alfa..Zeta; creation = Zeta..Alfa.
  AS 'tell application "Things3"
    repeat with nm in {"Zeta","Yankee","Xray","Whiskey","Victor","Uniform","Tango","Alfa"}
      make new tag with properties {name:(nm as string)}
      delay 0.3
    end repeat
    make new tag with properties {name:"Nest-Parent"}
    delay 0.3
    make new tag with properties {name:"Nest-Child-A"}
    delay 0.3
    make new tag with properties {name:"Nest-Child-B"}
    delay 0.3
  end tell'
  # nest the two children under Nest-Parent
  AS 'tell application "Things3" to set parent tag of tag "Nest-Child-A" to tag "Nest-Parent"' | tee -a "$REPORT"
  AS 'tell application "Things3" to set parent tag of tag "Nest-Child-B" to tag "Nest-Parent"' | tee -a "$REPORT"

  note "seeding inheritance fixtures (area+tag, project+tag, heading+children)"
  AS 'tell application "Things3" to make new area with properties {name:"InhArea"}'
  AS 'tell application "Things3" to set tag names of area "InhArea" to "Alfa"'
  # project WITH a heading + children via the json vector (HX0). ChildUnderHeading
  # follows the heading in items[] (should nest under it); DirectChild is a plain row.
  JSON='[{"type":"project","attributes":{"title":"InhProj","area":"InhArea","items":[{"type":"heading","attributes":{"title":"InhHeading"}},{"type":"to-do","attributes":{"title":"ChildUnderHeading"}},{"type":"to-do","attributes":{"title":"DirectChild"}}]}}]'
  ENC=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$JSON")
  URL "things:///json?auth-token=$AUTH&data=$ENC"
  sleep 2
  AS 'tell application "Things3" to set tag names of project "InhProj" to "Tango"'
  sleep 1
  ship_kit
  relaunch
  note "setup DONE. tags/areas/projects seeded. session in $SESSION"
  gqh 'SELECT title, "index", parent, substr(uuid,1,8) uuid FROM TMTag ORDER BY "index", title' | tee -a "$REPORT"
  exit 0
fi

# ============================================================ tagord (TAGORD1)
if [ "$CMD" = "tagord" ]; then
  load_session; ship_kit
  note "=== TAGORD1: tag DB state (index/parent/creation) ==="
  gqh 'SELECT title, "index" AS idx, substr(uuid,1,8) uuid, substr(parent,1,8) parent, cast(creationDate as int) created FROM TMTag ORDER BY "index", title' | tee -a "$REPORT"
  note "=== index tie histogram (how many tags share each index) ==="
  gqh 'SELECT "index" AS idx, COUNT(*) n, group_concat(title, ", ") titles FROM TMTag GROUP BY "index" ORDER BY "index"' | tee -a "$REPORT"
  note "=== creation-order of the 8 roots (does title-asc != creation) ==="
  gqh 'SELECT title, cast(creationDate as int) created, "index" idx FROM TMTag WHERE title IN ("Zeta","Yankee","Xray","Whiskey","Victor","Uniform","Tango","Alfa") ORDER BY creationDate' | tee -a "$REPORT"
  note "=== nested triad indexes (are child indexes in the same numeric space as roots?) ==="
  gqh 'SELECT t.title, t."index" idx, p.title parent FROM TMTag t LEFT JOIN TMTag p ON p.uuid=t.parent WHERE t.title LIKE "Nest-%" OR t.parent IS NOT NULL ORDER BY t."index"' | tee -a "$REPORT"

  note "=== AX: open Tags window + dump rows (are names AX-exposed?) ==="
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  AXR tagsopen | tee -a "$REPORT"; sleep 1
  AXR tagsrows | tee -a "$OUT/tagsrows.json"; note "tagsrows -> $OUT/tagsrows.json"
  cat "$OUT/tagsrows.json" | tee -a "$REPORT"
  note "=== VNC screenshot of the Tags window (visual display order = tie-break oracle) ==="
  vnc_setup
  V capture "$OUT/screens/tagord-tags-window.png"
  note "tagord DONE"
  exit 0
fi

# ============================================================ taginh (TAGINH1-a)
if [ "$CMD" = "taginh" ]; then
  load_session; ship_kit
  HEAD=$(gq 'SELECT uuid FROM TMTask WHERE title="InhHeading" AND type=2 LIMIT 1')
  PROJ=$(gq 'SELECT uuid FROM TMTask WHERE title="InhProj" AND type=1 LIMIT 1')
  note "heading uuid=$HEAD  project uuid=$PROJ"
  note "=== fixture task tree (type: 0=todo 1=project 2=heading) ==="
  gqh 'SELECT substr(uuid,1,8) uuid, title, type, substr(project,1,8) project, substr(heading,1,8) heading, substr(area,1,8) area FROM TMTask WHERE title IN ("InhProj","InhHeading","ChildUnderHeading","DirectChild") ORDER BY type DESC' | tee -a "$REPORT"

  note "=== (a1) URL update tags on a HEADING uuid ==="
  URL "things:///update?auth-token=$AUTH&id=$HEAD&tags=Victor"
  sleep 2
  note "TMTaskTag rows for the heading after URL update:"
  gqh "SELECT substr(tt.tasks,1,8) task, tg.title tag FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid=tt.tags WHERE tt.tasks='$HEAD'" | tee -a "$REPORT"

  note "=== (a2) AppleScript set tag names on a HEADING uuid ==="
  AS "tell application \"Things3\" to set tag names of to do id \"$HEAD\" to \"Whiskey\"" 2>&1 | tee -a "$REPORT"
  sleep 1
  gqh "SELECT substr(tt.tasks,1,8) task, tg.title tag FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid=tt.tags WHERE tt.tasks='$HEAD'" | tee -a "$REPORT"

  note "=== (a3) does the heading appear as a taggable 'to do' in AppleScript at all? ==="
  AS "tell application \"Things3\" to get class of to do id \"$HEAD\"" 2>&1 | tee -a "$REPORT"

  note "=== whole TMTaskTag for the fixture (heading? project? children?) ==="
  gqh 'SELECT substr(tt.tasks,1,8) task, tk.title item, tk.type, tg.title tag FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid=tt.tags JOIN TMTask tk ON tk.uuid=tt.tasks WHERE tk.title IN ("InhProj","InhHeading","ChildUnderHeading","DirectChild")' | tee -a "$REPORT"

  note "=== Items menu contents (is there a Tags... item?) ==="
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  AXR menudump Items 2>&1 | tee -a "$REPORT"
  note "taginh DONE"
  exit 0
fi

# ================================================================ shot
if [ "$CMD" = "shot" ]; then
  load_session; vnc_setup; NAME="${1:-shot}"
  V capture "$OUT/screens/$NAME.png"; note "captured $OUT/screens/$NAME.png"
  exit 0
fi

# ================================================================ teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "torn down $VM"
  exit 0
fi

echo "usage: research-taglab.sh {setup|tagord|taginh|shot <name>|teardown}" >&2
exit 2
