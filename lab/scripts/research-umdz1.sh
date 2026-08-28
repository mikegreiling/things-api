#!/bin/bash
# UMDZ1 — what does the Things GUI's own ⌘Z do to `userModificationDate`?
#
# THE QUESTION. Our `--preserve-modified` write flag captures a row's pre-write
# `umd` and restores it after the write verifies, so a bulk edit stays off the
# user's changes timeline. Its UNDO half was deferred pending one measurement:
# when the APP itself undoes an edit, does the row's `umd` come back to its
# pre-edit value, or is it re-stamped with a fresh now()? Whatever the app does
# is the native-parity target for our own undo.
#
# REPX3 §4.2 saw a `umd` REWIND on one gesture (Undo of `Update Rule` on a
# repeat TEMPLATE) but never isolated it: that row's whole point was the
# recurrence blob, the cell was about cursors, and a template is not an ordinary
# to-do. This campaign isolates `umd` on ORDINARY to-dos across three edit
# classes, plus the prerequisite nobody had measured either — whether a write we
# ship (the URL scheme) is even IN the app's undo stack.
#
#   U0  a URL-scheme `update` while the app is frontmost, then ⌘Z. Is our own
#       write undoable by the app at all? (Edit ▸ Undo state captured either
#       side.) If it is not, the app's undo can never BE our undo, and the only
#       thing the measurement gives us is a BEHAVIORAL TARGET to mirror.
#   U1  a FIELD edit: a GUI title rename (open the row, ⌘A, type, close), ⌘Z.
#   U1B the same rename, with ⌘Z pressed while the card is STILL OPEN — which
#       separates "a field edit is never registered as undoable" from "closing
#       the row discards a text-editor-local undo stack".
#   U2  a STRUCTURAL edit: complete via a checkbox click (REPX1's live vector),
#       ⌘Z.
#   U3  a second STRUCTURAL edit: Items ▸ Delete To-Do (move to trash), ⌘Z.
#
# Every cell is bracketed by FULL-ROW snapshots (every TMTask column, packed
# dates decoded, blobs hashed) diffed field by field, and each cell prints the
# three numbers the verdict rests on: `umd` before the edit, after the edit, and
# after the undo, beside the guest wall clock at each step. The fixture is aged
# (SETTLE seconds) before the edit and again before the undo, so RESTORED
# (umd_after_undo == umd_before) and RE-STAMPED (umd_after_undo ≈ now) can never
# be confused for one another.
#
# METHOD: one disposable clone of things-lab-golden-v4 (Things 3.23, DB v27; the
# golden is never booted). Airgapped, guest clock pinned 2026-07-05 12:00 and
# never rolled (nothing here needs a clock roll, so the trial wall is not in
# play). Fixtures fully synthetic (UMDZ1-*). Teardown on EXIT (KEEP=1 keeps the
# clone, REUSE=1 attaches to a live one).
#
# Usage:  CELLS="U1" VM=umdz1-lab KEEP=1 lab/scripts/research-umdz1.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-umdz1-lab}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/ax" "$OUT/snap"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-U0 U1 U1B U2 U3}"
FIX="${FIXTAG:-}"          # fixture-title suffix, so a retry cannot collide
SETTLE="${SETTLE:-25}"     # seconds of ageing either side of the edit
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[umdz1] $*" | tee -a "$REPORT"; }
has_cell() { case " $CELLS " in *" $1 "*) return 0;; *) return 1;; esac; }

GOLDEN="${GOLDEN:-things-lab-golden-v4}"
IP=""
if [ "$REUSE" = "1" ]; then
  IP="$(tart ip "$VM" 2>/dev/null || true)"
  if [ -n "$IP" ] && lab_ssh "$IP" true 2>/dev/null; then
    note "REUSE=1 — attached to running $VM at $IP"
  else
    IP=""
  fi
fi

if [ -z "$IP" ]; then
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }
  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
  MUTED=$(lab_ssh "$IP" "osascript -e 'output muted of (get volume settings)'" </dev/null)
  note "guest audio muted = $MUTED (boot-helper verification)"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
  BOOTSTRAP=1
else
  BOOTSTRAP=0
fi

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM running at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------------------------------------------------------------- guest helpers
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }

# FULL-ROW snapshot: every TMTask column for the rows matching a title LIKE.
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
snap() { # snap <name> <titleLike>
  lab_ssh "$IP" "python3 ~/labh/rowsnap.py $(printf '%q' "$2")" </dev/null > "$OUT/snap/$1.tsv" 2>&1
  note "  [snap $1: $(wc -l <"$OUT/snap/$1.tsv"|tr -d ' ') field-lines, $(cut -f1 "$OUT/snap/$1.tsv"|sort -u|wc -l|tr -d ' ') rows]"
}
snapdiff() { # snapdiff <before> <after> [label]
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

axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
relaunch() { lab_ssh "$IP" 'open -a Things3; sleep 22; true' </dev/null; }
quitapp() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 4; true' </dev/null; }
crashes() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3-*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }

# ---------------------------------------------------------------- AX dumps
lab_ssh "$IP" 'cat > ~/labh/rowcensus.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function acts(el){var o=Ref();if($.AXUIElementCopyActionNames(el,o)!==0)return [];var arr=ObjC.castRefToObject(o[0]);var a=[];for(var i=0;i<arr.count;i++)a.push(String(arr.objectAtIndex(i).js));return a}
function frame(el){var p=attr(el,'AXPosition'),z=attr(el,'AXSize');function d(x){if(!x)return null;return ObjC.castRefToObject($.CFCopyDescription(x)).js}
  var pp=d(p),zz=d(z);var mp=pp&&pp.match(/x:([-0-9.]+) y:([-0-9.]+)/);var mz=zz&&zz.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return {x:mp?+mp[1]:null,y:mp?+mp[2]:null,w:mz?+mz[1]:null,h:mz?+mz[2]:null}}
function line(el,d,ix){
  var p=['['+ix+'] role='+sv(el,'AXRole')]
  var s=sv(el,'AXSubrole'); if(s)p.push('sub='+s)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de.slice(0,120))
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,100))
  var id=sv(el,'AXIdentifier'); if(id)p.push('id='+id)
  var fo=sv(el,'AXFocused'); if(fo==='true')p.push('FOCUSED')
  var a=acts(el); if(a.length)p.push('ACTIONS='+a.join(','))
  var f=frame(el); if(f.x!==null)p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']')
  return Array(d+1).join('  ')+p.join(' | ')}
function walk(el,d,acc,ix){acc.push(line(el,d,ix)); if(d>18)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc,i+1); return acc}
function run(){
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var ws=kids(app); var acc=[]
  for(var i=0;i<ws.length;i++){
    var w=ws[i]
    acc.push('=== WINDOW '+(i+1)+' sub='+sv(w,'AXSubrole')+' ttl="'+sv(w,'AXTitle')+'" ===')
    walk(w,0,acc,i+1)
  }
  if(!acc.length) acc.push('(no window)')
  return acc.join('\n')}
EOF
windump()  { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/rowcensus.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; note "  [windump $1: $(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines, $(grep -cE '^=== ' "$OUT/ax/$1.txt") windows]"; }

# AX-scrutiny doctrine (harness.md): re-audit the shape after EVERY input step
# and diff it against the prior dump — a shape change is a FINDING, never
# something to step over silently.
axdiff() { # axdiff <dumpA> <dumpB> [label]
  local n
  n=$(diff <(sed 's/@\[[^]]*\]//' "$OUT/ax/$1.txt") <(sed 's/@\[[^]]*\]//' "$OUT/ax/$2.txt") | grep -c '^[<>]')
  note "    [AX shape ${3:-$1 -> $2}: $n changed lines (frames normalised out)]"
  if [ "$n" -gt 0 ]; then
    diff <(sed 's/@\[[^]]*\]//' "$OUT/ax/$1.txt") <(sed 's/@\[[^]]*\]//' "$OUT/ax/$2.txt") | grep '^[<>]' | head -12 | sed 's/^/      /' | tee -a "$REPORT"
  fi
}

# REPX1's LIVE vector: a synthesized CGEvent click at an element's AX frame,
# with CNCAC1's guard — walk AXParent up to the row's own AXScrollArea and
# REFUSE an off-screen target rather than clicking the desktop.
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
function scrollRect(el){var p=el; for(var i=0;i<20;i++){var o=Ref(); if($.AXUIElementCopyAttributeValue(p,$('AXParent'),o)!==0) return null;
    p=ObjC.castRefToObject(o[0]); if(!p) return null; if(sv(p,'AXRole')==='AXScrollArea') return frame(p)} return null}
function run(argv){
  var needle=argv[0], want=argv[1]||'Checkbox'
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var all=[]; flat(app,all,0)
  var rows=all.filter(function(e){return sv(e,'AXSubrole')==='AXTableRow'})
  for(var i=0;i<rows.length;i++){
    var sub=[]; flat(rows[i],sub,0)
    if(!sub.some(function(e){return sv(e,'AXDescription').indexOf(needle)>=0})) continue
    var hits = want==='TITLE'
      ? sub.filter(function(e){return sv(e,'AXDescription').indexOf(needle)>=0})
      : sub.filter(function(e){return sv(e,'AXDescription')===want})
    if(!hits.length) return 'row found ('+sub.length+' descendants), no element described '+want
    var f=frame(hits[0]); var x=f.x+f.w/2, y=f.y+f.h/2
    var sr=scrollRect(hits[0])
    if(sr && (y<sr.y || y>sr.y+sr.h || x<sr.x || x>sr.x+sr.w))
      return 'OFF-SCREEN: target @'+x+','+y+' is outside its scroll area ['+sr.x+','+sr.y+' '+sr.w+'x'+sr.h+'] — clicked NOTHING'
    var pt=$.CGPointMake(x,y)
    function post(type){var ev=$.CGEventCreateMouseEvent($(), type, pt, 0); $.CGEventPost($.kCGHIDEventTap, ev)}
    post($.kCGEventMouseMoved); delay(0.2)
    post($.kCGEventLeftMouseDown); delay(0.08); post($.kCGEventLeftMouseUp)
    return 'clicked '+want+' @'+x+','+y
  }
  return 'no AXTableRow contains an element described "'+needle+'"'}
EOF
clickrow() { lab_ssh "$IP" "osascript -l JavaScript ~/labh/clickrow.jxa $(printf '%q' "$1") $(printf '%q' "${2:-Checkbox}")" </dev/null 2>&1; }

select_item() { # select_item <uuid> <wantUuid>
  local uuid="$1" want="$2" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get id of selected to dos' 2>/dev/null)
    if [ "$sel" = "$want" ]; then note "    selection OK by UUID on attempt $i"; return 0; fi
    note "    selection attempt $i -> '$sel' (want '$want')"
  done
  return 1
}

# The Edit menu's own state — the prompt-free oracle for whether the app
# considers a gesture undoable, and for what it CALLS the pending undo.
editmenu() { # editmenu <label>
  note "    Edit menu ($1):"
  axq 'tell application "System Events" to tell process "Things3"
    click menu bar item "Edit" of menu bar 1
    delay 1
    set out to ""
    repeat with mi in (menu items of menu "Edit" of menu bar 1)
      try
        set nm to name of mi
        if nm is missing value then set nm to "(separator)"
        set out to out & "      " & nm & "  enabled=" & (enabled of mi) & linefeed
      end try
    end repeat
    key code 53
    return out
  end tell' | head -4 | tee -a "$REPORT"
}

itemsmenu() {
  axq 'tell application "System Events" to tell process "Things3"
    click menu bar item "Items" of menu bar 1
    delay 1
    set out to ""
    repeat with mi in (menu items of menu "Items" of menu bar 1)
      try
        set nm to name of mi
        if nm is missing value then set nm to "(separator)"
        set out to out & nm & "  enabled=" & (enabled of mi) & linefeed
      end try
    end repeat
    key code 53
    return out
  end tell'
}
clickitem() { # clickitem <menu> <menu item name>
  axq "tell application \"System Events\" to tell process \"Things3\" to click menu item \"$2\" of menu \"$1\" of menu bar 1" 2>&1
  lab_ssh "$IP" 'sleep 4' </dev/null
}

# Enumerate a menu and echo the FIRST item whose name contains a needle, with its
# enabled state — so a cell drives a menu item it has positively identified
# rather than a hard-coded label (the harness AX-scrutiny law). Prints nothing
# when the menu holds no such item, which the caller must treat as fatal.
menuitem() { # menuitem <menu> <needle>
  axq "tell application \"System Events\" to tell process \"Things3\"
    click menu bar item \"$1\" of menu bar 1
    delay 1
    set out to \"\"
    repeat with mi in (menu items of menu \"$1\" of menu bar 1)
      try
        set nm to name of mi
        if nm is not missing value and nm contains \"$2\" and out is \"\" then
          set out to nm & \"\\t\" & (enabled of mi)
        end if
      end try
    end repeat
    key code 53
    return out
  end tell"
}

appundo() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2; osascript -e '\''tell application "System Events" to keystroke "z" using command down'\''; sleep 8' </dev/null; }

typetext() { lab_ssh "$IP" "osascript -e $(printf '%q' "tell application \"System Events\" to keystroke \"$1\"")" </dev/null 2>&1; lab_ssh "$IP" 'sleep 2' </dev/null; }

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
mkurl() { # mkurl <title> <when>
  lab_ssh "$IP" "open -g 'things:///add?title=$1&when=$2&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"
}

# ---------------------------------------------------------------- the oracle
# `umd` beside the guest wall clock, so RESTORED and RE-STAMPED can be told
# apart by inspection rather than by arithmetic on two similar-looking floats.
# NB: this function's VALUE is captured by `$(...)`, so its human-readable line
# must NOT go to stdout — it goes to the report and to stderr (the run log).
umd() { # umd <uuid> <label>
  local u="$1" lbl="$2" v now
  v=$(gq "SELECT printf('%.6f', userModificationDate) FROM TMTask WHERE uuid='$u'")
  now=$(lab_ssh "$IP" 'python3 -c "import time;print(\"%.6f\"%time.time())"' </dev/null)
  echo "[umdz1]     UMD [$lbl] = $v   (guest now = $now, delta = $(python3 -c "print('%+.1fs'%($v-$now))" 2>/dev/null))" \
    | tee -a "$REPORT" >&2
  echo "$v"
}
verdict() { # verdict <umd_before> <umd_after_edit> <umd_after_undo>
  python3 - "$1" "$2" "$3" <<'PY' | tee -a "$REPORT"
import sys
b,e,u=(float(x) for x in sys.argv[1:4])
print("    UMD TRIPLE  before=%.6f  after-edit=%.6f  after-undo=%.6f"%(b,e,u))
print("               the edit moved umd by %+.1fs; the undo moved it by %+.1fs"%(e-b,u-e))
if abs(u-b)<0.0005:   print("    VERDICT: RESTORED — the undo rewound umd to its exact pre-edit value")
elif abs(u-e)<0.0005: print("    VERDICT: UNTOUCHED — the undo left the edit's umd in place")
elif u>e:             print("    VERDICT: RE-STAMPED — the undo wrote a FRESH umd (%.1fs past the edit's)"%(u-e))
else:                 print("    VERDICT: OTHER — u=%.6f is neither b, e, nor later than e"%u)
PY
}

TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" 2>/dev/null)
note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN / dbv $DBV"
note "cells: $CELLS   settle: ${SETTLE}s   crashes at start: $(crashes)"

[ "$BOOTSTRAP" = "1" ] && warm

# =====================================================================
# U0 — is a write WE ship (the URL scheme) in the app's undo stack at all?
# Run on a freshly relaunched app, so the stack is empty and Edit ▸ Undo's
# state before the gesture is a known-negative control.
if has_cell U0; then
note ""; note "########## CELL U0 — is a URL-scheme update in the app's undo stack? ##########"
quitapp; relaunch
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null
editmenu "fresh launch, before any gesture — the negative control"
U0=$(mkurl "UMDZ1-U0$FIX-URL" "2026-07-05")
note "  fixture uuid=$U0"
lab_ssh "$IP" "sleep $SETTLE" </dev/null
snap "u0-0-before" "UMDZ1-U0$FIX%"
U0B=$(umd "$U0" "before the URL edit")
lab_ssh "$IP" "open -g 'things:///update?id=$U0&title=UMDZ1-U0${FIX}-URL-EDITED&auth-token=$TOKEN'; sleep 6" </dev/null
snap "u0-1-edited" "UMDZ1-U0$FIX%"
snapdiff "u0-0-before" "u0-1-edited" "U0 — the URL-scheme update"
U0E=$(umd "$U0" "after the URL edit")
editmenu "after the URL-scheme update"
lab_ssh "$IP" "sleep $SETTLE" </dev/null
note "  --- ⌘Z ---"
appundo
snap "u0-2-undone" "UMDZ1-U0$FIX%"
snapdiff "u0-1-edited" "u0-2-undone" "U0 — ⌘Z after the URL-scheme update"
U0U=$(umd "$U0" "after ⌘Z")
verdict "$U0B" "$U0E" "$U0U"
note "  title now: $(gq "SELECT title FROM TMTask WHERE uuid='$U0'")"
fi

# =====================================================================
# U1 — a FIELD edit performed BY THE APP: a GUI title rename, then ⌘Z.
if has_cell U1; then
note ""; note "########## CELL U1 — GUI title rename, then ⌘Z ##########"
quitapp; relaunch
U1=$(mkurl "UMDZ1-U1$FIX-TITLE" "2026-07-05")
note "  fixture uuid=$U1"
# A fresh relaunch AFTER the fixture exists, so nothing the URL add did can be
# what ⌘Z reaches for, and the ageing below is real elapsed time.
quitapp; relaunch
lab_ssh "$IP" "sleep $SETTLE" </dev/null
snap "u1-0-before" "UMDZ1-U1$FIX%"
U1B=$(umd "$U1" "before the rename")
select_item "$U1" "$U1" || note "  WARN: selection never confirmed"
windump "u1-a-selected"
note "  --- open the row for editing (Return) ---"
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 36'\''; sleep 3' </dev/null
windump "u1-b-opened"; axdiff "u1-a-selected" "u1-b-opened" "after Return (open editor)"
note "  --- ⌘A, type the new title ---"
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "a" using command down'\''; sleep 1' </dev/null
typetext "UMDZ1-U1$FIX-RENAMED" >/dev/null
windump "u1-c-typed"; axdiff "u1-b-opened" "u1-c-typed" "after ⌘A + type"
note "  --- close the editor (Escape) ---"
esc
lab_ssh "$IP" 'sleep 4' </dev/null
windump "u1-d-closed"; axdiff "u1-c-typed" "u1-d-closed" "after Escape (close editor)"
snap "u1-1-edited" "UMDZ1-U1$FIX%"
snapdiff "u1-0-before" "u1-1-edited" "U1 — the GUI rename"
U1E=$(umd "$U1" "after the rename")
note "  title now: $(gq "SELECT title FROM TMTask WHERE uuid='$U1'")"
editmenu "after the rename"
lab_ssh "$IP" "sleep $SETTLE" </dev/null
note "  --- ⌘Z ---"
appundo
snap "u1-2-undone" "UMDZ1-U1$FIX%"
snapdiff "u1-1-edited" "u1-2-undone" "U1 — ⌘Z after the rename"
U1U=$(umd "$U1" "after ⌘Z")
verdict "$U1B" "$U1E" "$U1U"
note "  title now: $(gq "SELECT title FROM TMTask WHERE uuid='$U1'")"
note "  --- durability across a relaunch ---"
quitapp; relaunch
snap "u1-3-relaunch" "UMDZ1-U1$FIX%"
snapdiff "u1-2-undone" "u1-3-relaunch" "U1 — across a relaunch"
snapdiff "u1-0-before" "u1-3-relaunch" "U1 — rename + ⌘Z, NET vs the pre-gesture state"
fi

# =====================================================================
# U1B — the same rename, but ⌘Z is pressed while the card is STILL OPEN and the
# title's field editor still has focus. U1 measured the rename as un-undoable
# once the row is closed (Edit ▸ Undo reads disabled); this cell separates "the
# app never registers a field edit as undoable" from "closing the row discards a
# text-editor-local undo stack", which are different facts about the same key.
if has_cell U1B; then
note ""; note "########## CELL U1B — GUI title rename, ⌘Z with the card STILL OPEN ##########"
quitapp; relaunch
U1B=$(mkurl "UMDZ1-U1B$FIX-OPEN" "2026-07-05")
note "  fixture uuid=$U1B"
quitapp; relaunch
lab_ssh "$IP" "sleep $SETTLE" </dev/null
snap "u1b-0-before" "UMDZ1-U1B$FIX%"
U1BB=$(umd "$U1B" "before the rename")
select_item "$U1B" "$U1B" || note "  WARN: selection never confirmed"
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 36'\''; sleep 3' </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "a" using command down'\''; sleep 1' </dev/null
typetext "UMDZ1-U1B$FIX-OPENRENAMED" >/dev/null
windump "u1b-a-typed"
note "  title in the DB while the card is open: $(gq "SELECT title FROM TMTask WHERE uuid='$U1B'")"
U1BE=$(umd "$U1B" "after typing, card still open")
editmenu "card open, title edited"
note "  --- ⌘Z with the card still open ---"
appundo
windump "u1b-b-undone"; axdiff "u1b-a-typed" "u1b-b-undone" "after ⌘Z (card open)"
note "  title in the DB after ⌘Z: $(gq "SELECT title FROM TMTask WHERE uuid='$U1B'")"
note "  --- close the card (Escape) and settle ---"
esc
lab_ssh "$IP" 'sleep 6' </dev/null
snap "u1b-1-after" "UMDZ1-U1B$FIX%"
snapdiff "u1b-0-before" "u1b-1-after" "U1B — rename + ⌘Z (card open), NET vs the pre-gesture state"
U1BU=$(umd "$U1B" "after ⌘Z + close")
verdict "$U1BB" "$U1BE" "$U1BU"
note "  title now: $(gq "SELECT title FROM TMTask WHERE uuid='$U1B'")"
fi

# =====================================================================
# U2 — a STRUCTURAL edit: complete via the checkbox, then ⌘Z.
if has_cell U2; then
note ""; note "########## CELL U2 — complete (checkbox click), then ⌘Z ##########"
quitapp; relaunch
U2=$(mkurl "UMDZ1-U2$FIX-DONE" "2026-07-05")
note "  fixture uuid=$U2"
quitapp; relaunch
lab_ssh "$IP" "sleep $SETTLE" </dev/null
snap "u2-0-before" "UMDZ1-U2$FIX%"
U2B=$(umd "$U2" "before the completion")
select_item "$U2" "$U2" || note "  WARN: selection never confirmed"
windump "u2-a-selected"
note "  --- click the checkbox (the DB delta below is the only truth) ---"
clickrow "UMDZ1-U2$FIX-DONE" "Checkbox" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 8' </dev/null
windump "u2-b-completed"; axdiff "u2-a-selected" "u2-b-completed" "after the checkbox click"
snap "u2-1-edited" "UMDZ1-U2$FIX%"
snapdiff "u2-0-before" "u2-1-edited" "U2 — the completion"
U2E=$(umd "$U2" "after the completion")
note "  status/stopDate now: $(gq "SELECT status||' / '||COALESCE(stopDate,'NULL') FROM TMTask WHERE uuid='$U2'")"
editmenu "after the completion"
lab_ssh "$IP" "sleep $SETTLE" </dev/null
note "  --- ⌘Z ---"
appundo
snap "u2-2-undone" "UMDZ1-U2$FIX%"
snapdiff "u2-1-edited" "u2-2-undone" "U2 — ⌘Z after the completion"
U2U=$(umd "$U2" "after ⌘Z")
verdict "$U2B" "$U2E" "$U2U"
note "  status/stopDate now: $(gq "SELECT status||' / '||COALESCE(stopDate,'NULL') FROM TMTask WHERE uuid='$U2'")"
note "  --- durability across a relaunch ---"
quitapp; relaunch
snap "u2-3-relaunch" "UMDZ1-U2$FIX%"
snapdiff "u2-2-undone" "u2-3-relaunch" "U2 — across a relaunch"
snapdiff "u2-0-before" "u2-3-relaunch" "U2 — complete + ⌘Z, NET vs the pre-gesture state"
fi

# =====================================================================
# U3 — a second STRUCTURAL edit: move to trash via the Items menu, then ⌘Z.
if has_cell U3; then
note ""; note "########## CELL U3 — move to trash (Items menu), then ⌘Z ##########"
quitapp; relaunch
U3=$(mkurl "UMDZ1-U3$FIX-TRASH" "2026-07-05")
note "  fixture uuid=$U3"
quitapp; relaunch
lab_ssh "$IP" "sleep $SETTLE" </dev/null
snap "u3-0-before" "UMDZ1-U3$FIX%"
U3B=$(umd "$U3" "before the trash")
select_item "$U3" "$U3" || note "  WARN: selection never confirmed"
note "    Items menu (for the record — the delete-class item is NOT here):"
itemsmenu | sed 's/^/      /' | tee -a "$REPORT"
# Things 3.23 files move-to-trash under EDIT, not Items (measured — the Items
# menu holds When…/Move…/Tags…/Deadline…/Complete/Repeat…/Get Info/Convert to
# Project…/Share… and no delete-class item at all). Identify it positively.
DELROW=$(menuitem Edit Delete)
DELITEM="${DELROW%%$'\t'*}"
note "  Edit ▸ delete-class item resolves to: '$DELROW'"
[ -n "$DELITEM" ] || { note "  FATAL for U3: no Delete item in the Edit menu"; DELITEM="Delete"; }
clickitem Edit "$DELITEM" | sed 's/^/    /' | tee -a "$REPORT"
snap "u3-1-edited" "UMDZ1-U3$FIX%"
snapdiff "u3-0-before" "u3-1-edited" "U3 — the trash"
U3E=$(umd "$U3" "after the trash")
note "  trashed now: $(gq "SELECT trashed FROM TMTask WHERE uuid='$U3'")"
editmenu "after the trash"
lab_ssh "$IP" "sleep $SETTLE" </dev/null
note "  --- ⌘Z ---"
appundo
snap "u3-2-undone" "UMDZ1-U3$FIX%"
snapdiff "u3-1-edited" "u3-2-undone" "U3 — ⌘Z after the trash"
U3U=$(umd "$U3" "after ⌘Z")
verdict "$U3B" "$U3E" "$U3U"
note "  trashed now: $(gq "SELECT trashed FROM TMTask WHERE uuid='$U3'")"
note "  --- durability across a relaunch ---"
quitapp; relaunch
snap "u3-3-relaunch" "UMDZ1-U3$FIX%"
snapdiff "u3-2-undone" "u3-3-relaunch" "U3 — across a relaunch"
snapdiff "u3-0-before" "u3-3-relaunch" "U3 — trash + ⌘Z, NET vs the pre-gesture state"
fi

note ""
note "crashes at end: $(crashes)   report: $REPORT"
