#!/bin/bash
# UIC3 discovery: capture the repeat-bar POPOVER structure after a synthetic
# click, so the provisional recipe paths can be corrected. Grant + axkit only
# (no production bundle). Prints windows + subtrees before and after the click.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"
WEEKLY_PROJ="759yS6xe6d3a3h2dfVxoMZ"
VM="things-run-uic3d-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
note() { echo "[uic3d] $*"; }
cleanup() { tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

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
function sleep(ms){ $.NSThread.sleepForTimeInterval(ms/1000); }
function mev(t,x,y){ return $.CGEventCreateMouseEvent($(), t, $.CGPointMake(x,y), 0); }
function click(x,y){ $.CGEventPost($.kCGHIDEventTap, mev(5,x,y)); sleep(30);
  $.CGEventPost($.kCGHIDEventTap, mev(1,x,y)); sleep(20); $.CGEventPost($.kCGHIDEventTap, mev(2,x,y)); }
function line(el,path){ var f=frame(el),r=sv(el,'AXRole'),sr=sv(el,'AXSubrole'),d=sv(el,'AXDescription'),v=sv(el,'AXValue');
  return path+' '+r+(sr?('/'+sr):'')+(d?(' d="'+d+'"'):'')+(v?(' v="'+String(v).slice(0,34)+'"'):'')+(f?(' @'+Math.round(f.x)+','+Math.round(f.y)+' '+Math.round(f.w)+'x'+Math.round(f.h)):''); }
function walk(el,path,depth,out){ out.push(line(el,path)); if(depth<=0) return; var ks=kids(el); for(var i=0;i<ks.length;i++) walk(ks[i],path+'/'+i,depth-1,out); }
function run(argv){
  var app=$.AXUIElementCreateApplication(pidOf('Things3'));
  if(argv[0]==='click'){ click(+argv[1],+argv[2]); return 'clicked '+argv[1]+','+argv[2]; }
  var ws=kids(app),out=[];
  for(var i=0;i<ws.length;i++){ out.push('== window '+i+' '+sv(ws[i],'AXRole')+'/'+sv(ws[i],'AXSubrole')+' '+JSON.stringify(frame(ws[i]))); walk(ws[i],'w'+i,(argv[1]?+argv[1]:9),out); }
  return out.join('\n');
}
EOF
AXR() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript /tmp/axkit.js $*" </dev/null; }

# grant AX (rung b)
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
[ -z "$VNCDO" ] && { note "no VNCDO"; exit 1; }
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
V move 1642 332 click 1; sleep 3
V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3
note "grant: $(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)"

# reveal the repeating project, foreground, keep AXEnhanced off
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$WEEKLY_PROJ'; sleep 3" </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true

# The repeat bar frame (from the earlier dump): @343,136 400x18. Click LEFT (on the
# text, like UIC2's ~425,145) AND record windows after.
note "clicking repeat bar at 383,145 (left-of-text)"
AXR click 383 145; sleep 2
V capture "$OUT/screens/after-barclick.png"
AXR 10 > "$OUT/after-barclick-tree.txt" 2>>"$OUT/vnc.log"
note "=== windows + tree after bar click (head) ==="
grep -nE '^== window|AXUnknown|pop|AXPopover|Change|Pause|Resume|Stop|Show Latest|AXTextArea v=' "$OUT/after-barclick-tree.txt" | head -60
note "full tree: $OUT/after-barclick-tree.txt ($(wc -l < "$OUT/after-barclick-tree.txt") lines)"
note "DONE-DISC"
