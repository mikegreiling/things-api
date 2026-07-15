#!/bin/bash
# UIC4 — project row-selection: the PURE-AX make-repeating path + UIC3-a correction.
# Full write-up: docs/lab/uic4-project-selection.md. PROBE-ONLY (no production ops).
#
# Establishes, in ONE disposable clone of things-lab-golden-v1:
#  (a) AXSelectedRows is SETTABLE purely via AX on the content table -> a project
#      selects with zero mouse input, and Items > Repeat... becomes enabled.
#  (b) projects render as selectable CONTENT ROWS in the area + Someday views
#      (falsifies UIC3-a); pure-AX make-repeating DB-verified (foreground + backgrounded).
#  (c) Someday is moot: make-repeating normalizes start=2 for any origin; area preserved.
#  (d) area-less ANYTIME project = a HEADER in Anytime (no row) -> coerce-to-someday
#      (quiet URL) is cleanup-free; repeating templates resist quiet-vector schedule edits.
#  (e) right-click = a real NSMenu with Repeat... but AX-opaque (keyboard-typeahead only).
#
# Mouse/right-click clicks go through the NATIVE1 JXA ObjC bridge / HID tap (foreground-
# bound). AX select/menu/sheet is pure System Events (backgroundable). Requires $VNCDO
# (vncdotool venv) for the one-time AX grant (rung b). AXEnhancedUserInterface MUST stay false.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

AREA_A="7Ck4hAXU36jyaBsy2Fkije"   # LAB-AREA-A (golden seed)

VM="uic4-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
REPORT="$OUT/report.txt"
note() { echo "[uic4] $*" | tee -a "$REPORT"; }
cleanup() { echo "[uic4] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
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
echo "$HX" | xxd -r -p | plutil -convert xml1 - -o - 2>/dev/null | tr -d '\n' | sed 's/></>\n</g' | grep -iA1 -E '<key>(fu|of|tp)</key>' | tr '\n' ' '; echo
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# guest AX toolkit (NATIVE1 JXA bridge): tree walk + settability probe + set-AXSelectedRows
# + HID left/right click. Full source lives inline in the campaign; see docs for the exact
# helpers (attr/settable/setattr/frame/kids/stdwin/contentTable + run modes:
#   dump N | windows | rows | selrows | setsel <idx> | click x y | rclick x y).
lab_ssh "$IP" 'cat > /tmp/axkit.js' <<'EOF'
ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId(); }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]); }
function setattr(el,name,val){ return $.AXUIElementSetAttributeValue(el,$(name),val); }
function settable(el,name){ var out=Ref(); if($.AXUIElementIsAttributeSettable(el,$(name),out)!==0) return 'ERR'; return out[0]?'YES':'NO'; }
function sv(el,name){ var v=attr(el,name); return v? v.js : ''; }
function frame(el){ var p=attr(el,'AXPosition'),z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null; }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a; }
function stdwin(app){ var ws=kids(app); for(var i=0;i<ws.length;i++){ if(sv(ws[i],'AXSubrole')==='AXStandardWindow') return ws[i]; } return null; }
function sleep(ms){ $.NSThread.sleepForTimeInterval(ms/1000); }
function mev(t,x,y,btn){ return $.CGEventCreateMouseEvent($(), t, $.CGPointMake(x,y), btn||0); }
function clickAt(x,y){ $.CGEventPost($.kCGHIDEventTap, mev(5,x,y,0)); sleep(40); $.CGEventPost($.kCGHIDEventTap, mev(1,x,y,0)); sleep(25); $.CGEventPost($.kCGHIDEventTap, mev(2,x,y,0)); }
function rclickAt(x,y){ $.CGEventPost($.kCGHIDEventTap, mev(5,x,y,0)); sleep(40); $.CGEventPost($.kCGHIDEventTap, mev(3,x,y,2)); sleep(25); $.CGEventPost($.kCGHIDEventTap, mev(4,x,y,2)); }
function txt(el){ var out=[]; (function rec(e,d){ var v=sv(e,'AXValue'), r=sv(e,'AXRole'); if((r==='AXStaticText'||r==='AXTextArea')&&v) out.push(v); if(d>0){ var ks=kids(e); for(var i=0;i<ks.length;i++) rec(ks[i],d-1); } })(el,4); return out.join(' | '); }
function line(el,path){ var f=frame(el); var r=sv(el,'AXRole'), sr=sv(el,'AXSubrole'), d=sv(el,'AXDescription'), v=sv(el,'AXValue'); return path+' '+r+(sr?('/'+sr):'')+(d?(' d="'+d+'"'):'')+(v?(' v="'+String(v).slice(0,40)+'"'):'')+(f?(' @'+Math.round(f.x)+','+Math.round(f.y)+' '+Math.round(f.w)+'x'+Math.round(f.h)):''); }
function walk(el,path,depth,out){ out.push(line(el,path)); if(depth<=0) return; var ks=kids(el); for(var i=0;i<ks.length;i++) walk(ks[i],path+'/'+i,depth-1,out); }
function contentTable(w){ var sas=[]; (function rec(e,d){ if(sv(e,'AXRole')==='AXScrollArea') sas.push(e); if(d>0){var ks=kids(e);for(var i=0;i<ks.length;i++)rec(ks[i],d-1);} })(w,6);
  for(var i=0;i<sas.length;i++){ var f=frame(sas[i]); if(f && f.w>400){ var found=null;(function rec(e,d){ if(!found&&sv(e,'AXRole')==='AXTable') found=e; if(d>0&&!found){var ks=kids(e);for(var k=0;k<ks.length;k++)rec(ks[k],d-1);}})(sas[i],4); if(found) return sas[i]; } } return null; }
function tblOf(sa){ var t=null;(function rec(e,d){ if(!t&&sv(e,'AXRole')==='AXTable') t=e; if(d>0&&!t){var ks=kids(e);for(var k=0;k<ks.length;k++)rec(ks[k],d-1);}})(sa,4); return t; }
function run(argv){
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var mode=argv[0];
  if(mode==='click'){ clickAt(+argv[1],+argv[2]); return 'clicked '+argv[1]+','+argv[2]; }
  if(mode==='rclick'){ rclickAt(+argv[1],+argv[2]); return 'rclicked '+argv[1]+','+argv[2]; }
  var w=stdwin(app); if(!w) return 'NO-STDWIN';
  if(mode==='dump'){ var out=[]; walk(w,'w',(argv[1]?+argv[1]:7),out); return out.join('\n'); }
  if(mode==='windows'){ var ws=kids(app),o=[]; for(var i=0;i<ws.length;i++) o.push(i+' '+sv(ws[i],'AXRole')+'/'+sv(ws[i],'AXSubrole')+' '+JSON.stringify(frame(ws[i]))); return o.join('\n'); }
  var sa=contentTable(w); if(!sa) return 'NO-CONTENT-TABLE'; var tbl=tblOf(sa); if(!tbl) return 'NO-TABLE'; var rows=kids(tbl);
  if(mode==='rows'){ var o=[]; for(var i=0;i<rows.length;i++){ var f=frame(rows[i]); o.push('row '+i+' '+sv(rows[i],'AXRole')+'/'+sv(rows[i],'AXSubrole')+(f?(' @'+Math.round(f.x)+','+Math.round(f.y)+' '+Math.round(f.w)+'x'+Math.round(f.h)):'')+'  txt=['+txt(rows[i])+']'); } return o.join('\n'); }
  if(mode==='selrows'){ var st=settable(tbl,'AXSelectedRows'); var sr=attr(tbl,'AXSelectedRows'); var n=sr?sr.count:0; return 'AXSelectedRows settable='+st+' count='+n+' firstFrame='+JSON.stringify((n>0)?frame(sr.objectAtIndex(0)):null); }
  if(mode==='setsel'){ var idx=+argv[1]; if(idx>=rows.length) return 'IDX-OOR'; var e1=setattr(tbl,'AXSelectedRows',$.NSArray.arrayWithObject(rows[idx])); sleep(300); var sr=attr(tbl,'AXSelectedRows'); return 'setsel idx='+idx+' settable='+settable(tbl,'AXSelectedRows')+' setErr='+e1+' nowCount='+(sr?sr.count:0); }
  return 'unknown mode';
}
EOF
AXR() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript /tmp/axkit.js $*" </dev/null; }
SE()  { lab_ssh "$IP" "/usr/bin/osascript -e $(printf '%q' "$1")" </dev/null; }
noenh() { lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true; }
relaunch() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 3; open -a Things3; sleep 9' </dev/null; }
reveal() { lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$1'; sleep 3" </dev/null; noenh; }
selname() { lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get name of selected to dos'\''' </dev/null; }

# ---------- AXVM1 grant (rung b) ----------
note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then note "VNCDO/VNC_URL missing — grant needs VNC. Abort."; exit 1; fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"; PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
V move 1642 332 click 1; sleep 3
V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3
lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT service,client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null | tee -a "$REPORT"
noenh

# ---------- seed the taxonomy ----------
note "############### seed P1(area,anytime) P2(area-less,someday) P3/P4(area-less,anytime) ###############"
lab_ssh "$IP" "open 'things:///add-project?title=UIC4-P1&area-id=$AREA_A&to-dos=P1-a%0aP1-b'; sleep 3" </dev/null
lab_ssh "$IP" "open 'things:///add-project?title=UIC4-P2&when=someday&to-dos=P2-a%0aP2-b'; sleep 3" </dev/null
lab_ssh "$IP" "open 'things:///add-project?title=UIC4-P3&to-dos=P3-a%0aP3-b'; sleep 3" </dev/null
lab_ssh "$IP" "open 'things:///add-project?title=UIC4-P4&to-dos=P4-a'; sleep 3" </dev/null
note "seeded: $(gq "SELECT group_concat(title||'='||uuid||'/start'||start) FROM TMTask WHERE title LIKE 'UIC4-P%' AND type=1")"

# helpers to drive the Repeat sheet by pure AX (foreground = attached AXSheet)
drive_sheet_fg() { lab_ssh "$IP" '/usr/bin/osascript' </dev/null <<'OSA'
tell application "System Events" to tell process "Things3"
  set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  set freq to (first pop up button of sh whose value of attribute "AXValue" is "after completion")
  click freq
  delay 0.6
  click menu item "weekly" of menu 1 of freq
  delay 0.6
  click button "OK" of sh
end tell
OSA
}
press_repeat() { lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1'\''' </dev/null; }
setsel_by_name() { # $1=view uuid, $2=target name -> echoes row idx
  reveal "$1" >/dev/null
  for i in 1 2 3 4 5 6; do AXR setsel $i >/dev/null; [ "$(selname)" = "$2" ] && { echo "$i"; return; }; done; }

# ================= UIC4-a: settability =================
note "############### UIC4-a: AXSelectedRows settable? ###############"
relaunch; reveal "$AREA_A" >/dev/null
note "content rows (row0=area header, rows>=2 = PROJECTS):"; AXR rows | tee -a "$REPORT"
note "selrows (expect settable=YES): $(AXR selrows)"
IDX=$(setsel_by_name "$AREA_A" "UIC4-P1")
note "UIC4-P1 row idx=$IDX ; after pure-AX set -> selname=$(selname)"
note "Items has Repeat…: $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to return {exists (menu item "Repeat…" of menu "Items" of menu bar 1), enabled of menu item "Repeat…" of menu "Items" of menu bar 1}'\'' 2>&1' </dev/null)"

# ================= UIC4-b: pure-AX make-repeating (foreground) + click-select =================
note "############### UIC4-b: pure-AX make-repeating on P1 (foreground) ###############"
AXR setsel "$IDX" >/dev/null; press_repeat >/dev/null; sleep 2; drive_sheet_fg; sleep 3
note "P1 orig present(expect 0)=$(gq "SELECT count(*) FROM TMTask WHERE uuid IN (SELECT uuid FROM TMTask WHERE title='UIC4-P1' AND type=1) AND rt1_recurrenceRule IS NULL AND uuid='9TanMNTBcZgQaCP38dRc62'")"
note "P1 rows now: $(gq "SELECT group_concat(uuid||'/area='||coalesce(area,'-')||'/start'||start||'/rule='||(CASE WHEN rt1_recurrenceRule IS NULL THEN 'NO' ELSE 'YES' END)) FROM TMTask WHERE title='UIC4-P1'")"
# click-select confirmation on LAB-PROJ-HEADINGS (foreground -> selects; background -> only raises)
relaunch; reveal "$AREA_A" >/dev/null; HIDX=$(setsel_by_name "$AREA_A" "LAB-PROJ-HEADINGS")
RY=$(AXR rows | sed -n "s/^row $HIDX .*@284,\([0-9]*\) .*/\1/p"); CY=$((RY+14))
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''' </dev/null; AXR click 631 "$CY" >/dev/null; sleep 1
note "FG click -> selname=$(selname) (expect LAB-PROJ-HEADINGS), Repeat=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to return exists (menu item "Repeat…" of menu "Items" of menu bar 1)'\''' </dev/null)"

# ================= UIC4-c: SOMEDAY view (P2) + someday question =================
note "############### UIC4-c: pure-AX make-repeating on P2 (Someday) ###############"
relaunch; PIDX=$(setsel_by_name someday "UIC4-P2"); AXR setsel "$PIDX" >/dev/null
press_repeat >/dev/null; sleep 2; drive_sheet_fg; sleep 3
note "P2 rows: $(gq "SELECT group_concat(uuid||'/area='||coalesce(area,'-')||'/start'||start||'/rule='||(CASE WHEN rt1_recurrenceRule IS NULL THEN 'NO' ELSE 'YES' END)) FROM TMTask WHERE title='UIC4-P2'")"
note "start bucket of ALL repeating results (expect all start=2 regardless of origin):"
gq "SELECT title||' start='||start||' rule='||(CASE WHEN rt1_recurrenceRule IS NULL THEN 'inst' ELSE 'TMPL' END) FROM TMTask WHERE title IN ('UIC4-P1','UIC4-P2','LAB-REPEAT-WEEKLY-PROJ')" | tee -a "$REPORT"

# ================= UIC4-d: area-less anytime coercion (P3) =================
note "############### UIC4-d: P3 has no Anytime row -> coerce someday -> pure-AX ###############"
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
P3=$(gq "SELECT uuid FROM TMTask WHERE title='UIC4-P3'")
lab_ssh "$IP" "open 'things:///update-project?id=$P3&when=someday&auth-token=$TOKEN'; sleep 3" </dev/null
note "P3 start after coerce (expect 2): $(gq "SELECT start FROM TMTask WHERE uuid='$P3'")"
relaunch; P3IDX=$(setsel_by_name someday "UIC4-P3"); AXR setsel "$P3IDX" >/dev/null
press_repeat >/dev/null; sleep 2; drive_sheet_fg; sleep 3
TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='UIC4-P3' AND rt1_recurrenceRule IS NOT NULL")
note "P3 template=$TMPL start=$(gq "SELECT start FROM TMTask WHERE uuid='$TMPL'") area=$(gq "SELECT coalesce(area,'-') FROM TMTask WHERE uuid='$TMPL'")"
note "-- template resists quiet-vector schedule edits? --"
lab_ssh "$IP" "open 'things:///update-project?id=$TMPL&when=anytime&auth-token=$TOKEN'; sleep 3" </dev/null
note "URL when=anytime on template -> start=$(gq "SELECT start FROM TMTask WHERE uuid='$TMPL'") (expect still 2 = no-op)"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to move (to do id \"$TMPL\") to list \"Anytime\"' 2>&1" </dev/null | tee -a "$REPORT"   # expect error 301

# ================= UIC4-e: right-click NSMenu =================
note "############### UIC4-e: right-click context menu (real NSMenu, AX-opaque) ###############"
relaunch; HIDX=$(setsel_by_name "$AREA_A" "LAB-PROJ-HEADINGS")
RY=$(AXR rows | sed -n "s/^row $HIDX .*@284,\([0-9]*\) .*/\1/p"); CY=$((RY+14))
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''' </dev/null
AXR click 631 "$CY" >/dev/null; sleep 1; AXR rclick 631 "$CY" >/dev/null; sleep 1
note "app children while menu open (expect NO AXMenu node -> not AX-exposed):"; AXR windows | tee -a "$REPORT"
# dismiss + drive via keyboard typeahead (the only path that works)
lab_ssh "$IP" '/usr/bin/osascript -l JavaScript -e '\''ObjC.import("CoreGraphics"); var d=$.CGEventCreateKeyboardEvent($(),53,true),u=$.CGEventCreateKeyboardEvent($(),53,false); $.CGEventPost($.kCGHIDEventTap,d); $.CGEventPost($.kCGHIDEventTap,u);'\''' </dev/null
AXR rclick 631 "$CY" >/dev/null; sleep 1
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to keystroke "repeat"'\'' -e '\''delay 0.4'\'' -e '\''tell application "System Events" to key code 36'\''' </dev/null
sleep 2; drive_sheet_fg; sleep 3
note "LAB-PROJ-HEADINGS via right-click path: $(gq "SELECT group_concat(uuid||'/rule='||(CASE WHEN rt1_recurrenceRule IS NULL THEN 'NO' ELSE 'YES' END)) FROM TMTask WHERE title='LAB-PROJ-HEADINGS'")"

note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 --"
note "DONE. report: $REPORT"
