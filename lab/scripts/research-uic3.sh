#!/bin/bash
# UIC3 — the mouse-hybrid build certification (2026-07-15). Full write-up:
# docs/lab/uic3-build-certification.md.
#
# Two jobs, ONE disposable clone:
#  (a) UIC3-a micro-probe: does single-clicking a project ROW inside its parent
#      AREA's list view (HID click at the AX-resolved row center) make the Items
#      menu expose Repeat…? (decides whether project.make-repeating is doctrine-
#      clean). UIC2 found a SHOWN project's Items menu lacks Repeat.
#  (b) UIC3-b certification: run project.reschedule-repeat / pause-repeat /
#      resume-repeat END-TO-END through the production CLI (guest e2e bundle,
#      --dangerously-drive-gui) against the seeded repeating project, asserting
#      DB deltas; plus one fail-closed negative test on a NON-repeating project.
#
# The production driver's mouse clicks go through the JXA ObjC bridge / HID tap
# (NATIVE1). AX frames are resolved by the driver via System Events position/size
# — this script ALSO dumps the live AX tree (axkit.js) so the provisional recipe
# paths (repeat bar / popover) can be confirmed or corrected.
#
# VM discipline: --vnc-experimental single-client — one vncdo per step, ~3s
# settle; relaunch Things before each op; AXEnhancedUserInterface MUST stay false.
# Requires $VNCDO (vncdotool venv) for the one-time AX grant (rung b).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

WEEKLY_PROJ="759yS6xe6d3a3h2dfVxoMZ"        # LAB-REPEAT-WEEKLY-PROJ (repeating project)

VM="things-run-uic3-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
REPORT="$OUT/report.txt"
note() { echo "[uic3] $*" | tee -a "$REPORT"; }
cleanup() { echo "[uic3] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# read-only guest SQLite + recurrence decoder
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
lab_ssh "$IP" 'cat > /tmp/rrdump.sh && chmod +x /tmp/rrdump.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
HX=$(sqlite3 "file:$DB?mode=ro" "SELECT hex(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'")
[ -z "$HX" ] && { echo "NO-RULE"; exit 0; }
echo "$HX" | xxd -r -p | plutil -convert xml1 - -o - 2>/dev/null | tr -d '\n' | sed 's/></>\n</g' | grep -iA1 -E '<key>(fu|tp|ts)</key>' | tr '\n' ' '; echo
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# guest-side AX toolkit (NATIVE1 JXA ObjC bridge): walk the tree + synthesize HID clicks
lab_ssh "$IP" 'cat > /tmp/axkit.js' <<'EOF'
ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId(); }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]); }
function sv(el,name){ var v=attr(el,name); return v? v.js : ''; }
function frame(el){ var p=attr(el,'AXPosition'),z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null; }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a; }
function stdwin(app){ var ws=kids(app); for(var i=0;i<ws.length;i++){ if(sv(ws[i],'AXSubrole')==='AXStandardWindow') return ws[i]; } return null; }
function sleep(ms){ $.NSThread.sleepForTimeInterval(ms/1000); }
function mev(t,x,y){ return $.CGEventCreateMouseEvent($(), t, $.CGPointMake(x,y), 0); }
function click(x,y){ $.CGEventPost($.kCGHIDEventTap, mev(5,x,y)); sleep(30);
  $.CGEventPost($.kCGHIDEventTap, mev(1,x,y)); sleep(20); $.CGEventPost($.kCGHIDEventTap, mev(2,x,y)); }
function line(el,path){ var f=frame(el); var r=sv(el,'AXRole'), sr=sv(el,'AXSubrole'), d=sv(el,'AXDescription'), v=sv(el,'AXValue');
  return path+' '+r+(sr?('/'+sr):'')+(d?(' d="'+d+'"'):'')+(v?(' v="'+String(v).slice(0,30)+'"'):'')+(f?(' @'+Math.round(f.x)+','+Math.round(f.y)+' '+Math.round(f.w)+'x'+Math.round(f.h)):''); }
function walk(el,path,depth,out){ out.push(line(el,path)); if(depth<=0) return; var ks=kids(el);
  for(var i=0;i<ks.length;i++) walk(ks[i],path+'/'+i,depth-1,out); }
function run(argv){
  var app=$.AXUIElementCreateApplication(pidOf('Things3'));
  var mode=argv[0];
  if(mode==='click'){ click(+argv[1],+argv[2]); return 'clicked '+argv[1]+','+argv[2]; }
  var w=stdwin(app); if(!w) return 'NO-STDWIN';
  if(mode==='dump'){ var out=[]; walk(w,'w',(argv[1]?+argv[1]:6),out); return out.join('\n'); }
  if(mode==='windows'){ var ws=kids(app),o=[]; for(var i=0;i<ws.length;i++) o.push(i+' '+sv(ws[i],'AXRole')+'/'+sv(ws[i],'AXSubrole')+' '+JSON.stringify(frame(ws[i]))); return o.join('\n'); }
  return 'unknown mode';
}
EOF
AX() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript -e 'ObjC.import(\"stdlib\")' /tmp/axkit.js $*" </dev/null; }
# axkit.js has run(argv); invoke via osascript run handler:
AXR() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript /tmp/axkit.js $*" </dev/null; }

# ---------- AXVM1 grant (rung b) ----------
note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then note "VNCDO/VNC_URL missing — grant needs VNC. Abort."; exit 1; fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
V capture "$OUT/screens/11-ax-pane.png"
V move 1642 332 click 1; sleep 3; V capture "$OUT/screens/12-auth.png"
V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3
V capture "$OUT/screens/13-after-auth.png"
note "-- AX rows after grant (expect ...|2) --"
lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT service,client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null | tee -a "$REPORT"
# keep AXEnhancedUserInterface false
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true

# ---------- ship the guest e2e bundle + enable ui config ----------
note "############### ship bundle + enable ui.enabled ###############"
npm run build >/dev/null
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/dist"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1
relaunch() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 3; open -a Things3; sleep 9' </dev/null; }

# ================= UIC3-a: row-selection Items-menu probe =================
note "############### UIC3-a: project-ROW selection -> Items ▸ Repeat? ###############"
# Seed a plain project inside an area, view the AREA, single-click the project ROW.
AREA_UUID=$(gq "SELECT uuid FROM TMArea LIMIT 1"); AREA_NAME=$(gq "SELECT title FROM TMArea WHERE uuid='$AREA_UUID'")
note "area for probe: $AREA_NAME ($AREA_UUID)"
lab_ssh "$IP" "open 'things:///add-project?title=UIC3-ROWPROBE&area=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$AREA_NAME")'; sleep 3" </dev/null
ROWPROJ=$(gq "SELECT uuid FROM TMTask WHERE title='UIC3-ROWPROBE'")
note "row-probe project = $ROWPROJ (area=$(gq "SELECT area FROM TMTask WHERE uuid='$ROWPROJ'"))"
relaunch
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$AREA_UUID'; sleep 3" </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true
note "-- area-view AX dump (find the project row) --"
AXR dump 7 > "$OUT/area-dump.txt" 2>>"$OUT/vnc.log"; sed -n '1,60p' "$OUT/area-dump.txt" | tee -a "$REPORT"
# pick the first list ROW frame from the dump (AXRow with a reasonable width)
ROWLINE=$(grep -E 'AXRow|Row' "$OUT/area-dump.txt" | grep -oE '@[-0-9]+,[-0-9]+ [0-9]+x[0-9]+' | head -1)
note "first row frame: $ROWLINE"
if [ -n "$ROWLINE" ]; then
  RX=$(echo "$ROWLINE" | sed -E 's/@([-0-9]+),([-0-9]+) ([0-9]+)x([0-9]+)/\1 \2 \3 \4/')
  set -- $RX; CX=$(( $1 + $3/2 )); CY=$(( $2 + $4/2 ))
  note "HID single-click project row center ~$CX,$CY"
  AXR click "$CX" "$CY"; sleep 2
  SELROW=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get name of selected to dos'\''' </dev/null)
  note "selected-as-row = $SELROW (expect UIC3-ROWPROBE if row-click selected it)"
  REPEAT_IN_ITEMS=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to return exists (menu item "Repeat…" of menu "Items" of menu bar 1)'\'' 2>&1' </dev/null)
  ITEMS_LIST=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to return name of every menu item of menu "Items" of menu bar 1'\'' 2>&1' </dev/null)
  note "UIC3-a VERDICT: Items has 'Repeat…' = $REPEAT_IN_ITEMS"
  note "Items menu items: $ITEMS_LIST"
else
  note "UIC3-a: no row frame found in area dump — inspect $OUT/area-dump.txt"
fi

# ================= UIC3-b: certify the 3 project ops =================
note "############### UIC3-b: discovery dump of the repeating-project view ###############"
relaunch
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$WEEKLY_PROJ'; sleep 3" </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true
AXR dump 8 > "$OUT/proj-dump.txt" 2>>"$OUT/vnc.log"
note "repeating-project view dump -> $OUT/proj-dump.txt (head):"; sed -n '1,50p' "$OUT/proj-dump.txt" | tee -a "$REPORT"
note "-- windows list --"; AXR windows | tee -a "$REPORT"

note "############### UIC3-b: run the 3 ops through the production CLI ###############"
note "-- project.pause-repeat (expect paused 0->1, next cleared) --"
relaunch
G project pause-repeat "$WEEKLY_PROJ" --dangerously-drive-gui --json 2>/dev/null | tee -a "$REPORT" >/dev/null
note "paused|next = $(gq "SELECT rt1_instanceCreationPaused||'|'||coalesce(rt1_nextInstanceStartDate,'NULL') FROM TMTask WHERE uuid='$WEEKLY_PROJ'")"

note "-- project.resume-repeat (expect paused 1->0) --"
relaunch
G project resume-repeat "$WEEKLY_PROJ" --dangerously-drive-gui --json 2>/dev/null >/dev/null
note "paused = $(gq "SELECT rt1_instanceCreationPaused FROM TMTask WHERE uuid='$WEEKLY_PROJ'")"

note "-- project.reschedule-repeat weekly->monthly (identity preserved, fu 256->8) --"
note "before: $(lab_ssh "$IP" "/tmp/rrdump.sh $WEEKLY_PROJ" </dev/null)"
relaunch
G project reschedule-repeat "$WEEKLY_PROJ" --frequency monthly --interval 1 --dangerously-drive-gui --json 2>/dev/null | tee -a "$REPORT" >/dev/null
note "same uuid present=$(gq "SELECT count(*) FROM TMTask WHERE uuid='$WEEKLY_PROJ'") after: $(lab_ssh "$IP" "/tmp/rrdump.sh $WEEKLY_PROJ" </dev/null)"

# ---------- negative test: fail-closed on a NON-repeating project ----------
note "############### UIC3-b negative: pause-repeat on a NON-repeating project (expect fail-closed) ###############"
lab_ssh "$IP" "open 'things:///add-project?title=UIC3-PLAIN'; sleep 2" </dev/null
PLAIN=$(gq "SELECT uuid FROM TMTask WHERE title='UIC3-PLAIN'")
relaunch
NEG=$(G project pause-repeat "$PLAIN" --dangerously-drive-gui --json 2>/dev/null | python3 -c "import json,sys
try:
  d=json.load(sys.stdin); print('ok=',d.get('ok'),'kind=',d.get('data',{}).get('kind') if isinstance(d.get('data'),dict) else d.get('kind'))
except Exception as e: print('parse-fail',e)" 2>&1)
note "negative pause on plain project: $NEG (expect ok=False, no mutation)"
note "plain project paused col = $(gq "SELECT coalesce(rt1_instanceCreationPaused,'NULL') FROM TMTask WHERE uuid='$PLAIN'") (expect NULL/0, untouched)"

# ---------- gating sanity ----------
note "############### gating ###############"
lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js project pause-repeat $WEEKLY_PROJ 2>&1 >/dev/null | head -1; echo exit=\${PIPESTATUS[0]}" </dev/null | tee -a "$REPORT" # expect blocked (4)

note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 --"
note "DONE. report: $REPORT ; artifacts in $OUT"
