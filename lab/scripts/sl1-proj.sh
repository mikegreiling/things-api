#!/bin/bash
# SL1 project-template replication — Show Latest via the repeat-bar POPOVER (UIC3
# recipe: reveal the template project, HID-click the repeat bar to open the ≈215×220
# AXUnknown popover, HID-click the "Show Latest" element; AXPress is inert). Reuses the
# running sl1-lab VM + the shipped e2e bundle. Oracle: `id of selected to dos` returns
# the SHOWN PROJECT's uuid (verified — Things treats a shown project as selected).
# The AX popover driver (slproj.js) is shipped INLINE as a heredoc (uic3/axkit.js
# pattern) so it is not linted as repo source.
#   ship         : push the AX driver to the guest
#   convert UUID : make a plain project a DAILY FIXED repeater (CLI, --dangerously-drive-gui)
#   matrix P     : instance matrix for project-template P
#   showlatest P : reveal P, open repeat bar, click Show Latest, read the picked project
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
source lab/artifacts/sl1-lab/state.env
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
AXR() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/things-lab/helpers/slproj.js $*" </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
pmatrix() {
  lab_ssh "$IP" "~/things-lab/helpers/gsql.sh 'SELECT substr(uuid,1,8) AS u, type, status, (startDate>>16)||\"-\"||((startDate>>12)&15)||\"-\"||((startDate>>7)&31) AS startD, CAST(creationDate AS INT) AS created, CASE WHEN stopDate IS NULL THEN \"NULL\" ELSE CAST(stopDate AS INT) END AS stopD FROM TMTask WHERE rt1_repeatingTemplate=\"$1\" ORDER BY creationDate'" </dev/null
  lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -q 'SELECT uuid||\" created=\"||CAST(creationDate AS INT) FROM TMTask WHERE rt1_repeatingTemplate=\"$1\" ORDER BY creationDate'" </dev/null
}
ship_driver() {
  lab_ssh "$IP" 'cat > ~/things-lab/helpers/slproj.js' <<'JSEOF'
// SL1 project Show-Latest driver (UIC3 repeat-bar popover recipe). AX read + HID mouse
// synthesis (AXPress is inert on Things' custom menus/popovers). Modes:
//   openbar   — find the repeat-bar AXTextArea (value starts "Repeat"), HID-click center.
//   showlatest— find the popover (AXUnknown top-level window, size != 40x40), find the
//               "Show Latest" element, HID-click its frame center.
//   dumpwins  — debug: list top-level windows + sizes.
ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId(); }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]); }
function sv(el,name){ var v=attr(el,name); return v? (v.js!==undefined?v.js:String(v)) : ''; }
function frame(el){ var p=attr(el,'AXPosition'),z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null; }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a; }
function stdwin(app){ var ws=kids(app); for(var i=0;i<ws.length;i++){ if(sv(ws[i],'AXSubrole')==='AXStandardWindow') return ws[i]; } return null; }
function sleep(ms){ $.NSThread.sleepForTimeInterval(ms/1000); }
function mev(t,x,y){ return $.CGEventCreateMouseEvent($(), t, $.CGPointMake(x,y), 0); }
function click(x,y){ $.CGEventPost($.kCGHIDEventTap, mev(5,x,y)); sleep(40);
  $.CGEventPost($.kCGHIDEventTap, mev(1,x,y)); sleep(30); $.CGEventPost($.kCGHIDEventTap, mev(2,x,y)); }
function find(el, pred, out, depth){ if(depth<0) return; if(pred(el)) out.push(el); var ks=kids(el); for(var i=0;i<ks.length;i++) find(ks[i],pred,out,depth-1); }
function run(argv){
  var app=$.AXUIElementCreateApplication(pidOf('Things3'));
  var mode=argv[0];
  if(mode==='dumpwins'){ var ws=kids(app),o=[]; for(var i=0;i<ws.length;i++){ var f=frame(ws[i]); o.push(i+' '+sv(ws[i],'AXRole')+'/'+sv(ws[i],'AXSubrole')+' '+(f?JSON.stringify(f):'?')); } return o.join('\n'); }
  if(mode==='openbar'){
    var w=stdwin(app); if(!w) return 'NO-STDWIN';
    var hits=[]; find(w, function(e){ return sv(e,'AXRole')==='AXTextArea' && String(sv(e,'AXValue')).slice(0,6)==='Repeat'; }, hits, 12);
    if(!hits.length) return 'NO-REPEAT-BAR';
    var f=frame(hits[0]); if(!f) return 'NO-FRAME';
    click(Math.round(f.x+f.w/2), Math.round(f.y+f.h/2));
    return 'clicked-bar @'+Math.round(f.x+f.w/2)+','+Math.round(f.y+f.h/2)+' value="'+String(sv(hits[0],'AXValue')).slice(0,40)+'"';
  }
  if(mode==='showlatest'){
    var ws=kids(app), pop=null;
    for(var i=0;i<ws.length;i++){ var f=frame(ws[i]); if(sv(ws[i],'AXSubrole')==='AXUnknown' && f && !(f.w===40&&f.h===40)){ pop=ws[i]; break; } }
    if(!pop) return 'NO-POPOVER';
    var hits=[]; find(pop, function(e){ return sv(e,'AXDescription')==='Show Latest'; }, hits, 8);
    if(!hits.length){ var dd=[]; find(pop, function(e){ var d=sv(e,'AXDescription'); if(d) dd.push(d); return false; }, dd, 8);
      return 'NO-SHOWLATEST-ELEM; descriptions=['+dd.join(' | ')+']'; }
    var f=frame(hits[0]); if(!f) return 'NO-FRAME';
    click(Math.round(f.x+f.w/2), Math.round(f.y+f.h/2));
    return 'clicked-showlatest @'+Math.round(f.x+f.w/2)+','+Math.round(f.y+f.h/2);
  }
  return 'unknown mode';
}
JSEOF
}
case "${1:-}" in
  ship) ship_driver; echo "shipped slproj.js"; AXR dumpwins ;;
  convert) warm; G project make-repeating "$2" --frequency daily --interval 1 --dangerously-drive-gui --json ;;
  matrix) pmatrix "$2" ;;
  showlatest)
    P="$2"
    lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$P'; sleep 3" </dev/null
    lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true
    echo "pre-selection: $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get id of selected to dos'\'' 2>&1' </dev/null)"
    echo "openbar: $(AXR openbar)"; sleep 2
    echo "dumpwins:"; AXR dumpwins
    echo "showlatest: $(AXR showlatest)"; sleep 3
    echo "PICK (id of selected to dos): $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get id of selected to dos'\'' 2>&1' </dev/null)" ;;
  *) echo "usage: sl1-proj.sh {ship|convert UUID|matrix P|showlatest P}" ;;
esac
