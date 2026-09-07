#!/bin/bash
# CHORD4 — the Today ENTRY-COHORT boundary, and the This Evening top edge.
#
# THE QUESTION. The Today view's displayed order is NOT `todayIndex` order.
# `todayOrderBy` (src/read/predicates.ts — shared by the reader, the view and
# TODWIRE's minimal wire) sorts
#
#     startBucket ASC, COALESCE(todayIndexReferenceDate, startDate, deadline) DESC,
#     todayIndex ASC, uuid ASC
#
# so the entry COHORT outranks the manual rank. The arrow chord moves a row one
# DISPLAYED slot and writes `todayIndex` (CHORD2 §4). So: what does ONE ⌘↑ do
# when it would carry a row ABOVE a row in a NEWER cohort? Three candidate
# outcomes, and the shipped op's shape differs under each:
#
#   (i)   DECLINED (beep, no write) — the cohort is a hard partition and the
#         chord reorders only WITHIN one.
#   (ii)  `todayIndexReferenceDate` RE-STAMPED — a cohort collapse, the exact
#         silent damage TODWIRE's minimal wire exists to avoid.
#   (iii) something else — e.g. the row moves ON SCREEN with no durable write
#         (a display/database divergence), recorded exactly.
#
# CHORD2 §4's Today arm measured `todayIndex` written and tiRef untouched, but
# that arm never crossed a cohort.
#
# CELLS
#   incohort — a ⌘↑ WITHIN the top cohort: the in-cohort baseline delta.
#   topedge  — a ⌘↑ from the very FIRST row of the view: the decline shape.
#   xdown    — ⌘↓ from the LAST row of the TOP cohort, into the older one.
#   xup      — ⌘↑ from the FIRST row of the SECOND cohort, into the newer one.
#              These two are the cells the build is gated on.
#   evening  — ⌘↑ from the first This Evening row (CHORD2 §4be2 predicts
#              `startBucket 1 -> 0` + a `umd` stamp), on a row CARRYING A
#              REMINDER, since the evening chord's whole prize over the bounce
#              is that it does not strip `reminderTime`.
#
# Each crossing cell is followed by a RELAUNCH read: a chord that moves a row on
# screen without a durable write shows up as an order that reverts when the app
# re-derives the list.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 (trial wall 2026-07-18 — never
# rolled). Fixtures fully synthetic, seeded through the SHIPPED CLI (URL scheme)
# — never a direct SQLite write; the OLDER cohort is the golden's own baked
# Today set, whose entry dates predate the clone. Every cell takes a FULL
# 41-column TMTask diff over EVERY untrashed row (a crossing cannot escape it),
# reads the displayed order back by AX, and counts beeps. Clone destroyed on
# teardown. PROBE ONLY — nothing is shipped from this file.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM_NAME:-gscr-chord4-$$}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snap" "$OUT/ax"
REPORT="$OUT/report.txt"
PIN="070512002026"   # 2026-07-05 12:00 — well inside the trial wall (2026-07-18)
PACKED_TODAY=132805248   # encodePackedDate(2026-07-05)
: > "$REPORT"
note() { echo "[chord4] $*" | tee -a "$REPORT"; }

# CGEvent modifier masks + arrow key codes (CHORD2's vector)
FCMD=1048576
KUP=126
KDOWN=125

IP=""
cleanup() {
  if [ "${KEEP_VM:-0}" = "1" ]; then note "KEEP_VM=1 — leaving $VM up"; return; fi
  note "teardown: stopping + deleting $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 2
  tart delete "$VM" >/dev/null 2>&1 || true
  tart list 2>/dev/null | sed 's/^/    /' | tee -a "$REPORT"
}

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
show() { lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 3" </dev/null; }
front() { axq 'tell application "System Events" to return name of first process whose frontmost is true'; }
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }

# The sentinel is POST-HOC: `reset` once, `mark` per cell, ONE `assert` at the
# end that attributes every beep in the window to the cell it fell inside.
bassert() { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh assert --name chord4 --json ~/labh/beeps.json" </dev/null 2>&1; }
breset()  { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh reset" </dev/null >/dev/null 2>&1; }
bmark()   { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }

# ============================================================ preflight
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 10 ] && { note "FATAL: <10GB free"; exit 1; }
note "preflight: VM table —"
tart list 2>/dev/null | sed 's/^/    /' | tee -a "$REPORT"
if tart list 2>/dev/null | awk 'NR>1 && ($NF=="running" || $0 ~ /gscr-|things-run-/)' | grep -q .; then
  note "FATAL: the VM slot is not free (a running VM, or a gscr-*/things-run-* clone exists)"
  exit 1
fi

if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
  note "building dist"
  npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
fi
[ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }

# The AX scripts the shipped op uses, rendered here so the probe drives the SAME
# selection primitive the vector will.
TABLE='table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")'
node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axVisibleRowTitlesScript(process.argv[1])))" "$TABLE" > "$OUT/vis.applescript"

# ============================================================ clone + boot
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM" || { note "FATAL: clone failed"; exit 1; }
trap cleanup EXIT
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 600) || { note "FATAL: no SSH"; exit 1; }
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
lab_scp "$OUT/vis.applescript" "admin@$IP:/Users/admin/labh/vis.applescript" >/dev/null

# the full-row snapshotter (CHORD2's rowsnap.py, widened to EVERY untrashed row
# — a cohort re-stamp on a bystander must not be able to escape the diff)
lab_ssh "$IP" 'cat > ~/labh/rowsnap.py' <<'EOF'
import sqlite3, glob, hashlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True); c.row_factory=sqlite3.Row
DATECOLS={'startDate','deadline','stopDate','rt1_nextInstanceStartDate','rt1_instanceCreationStartDate','todayIndexReferenceDate'}
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%s(%04d-%02d-%02d)"%(v,y,m,d) if 1<y<5000 else v
rows=c.execute("SELECT * FROM TMTask WHERE trashed=0 ORDER BY creationDate, uuid").fetchall()
for r in rows:
    for k in r.keys():
        v=r[k]
        if isinstance(v,bytes): v='blob:sha256:'+hashlib.sha256(v).hexdigest()[:16]+':len'+str(len(v))
        elif k in DATECOLS: v=dpk(v)
        print("%s\t%s\t%s"%(r['uuid'],k,v))
EOF

# the pid-targeted key poster — the BACKGROUND-capable chord vector
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

# the AX row census — the DISPLAYED order, section headers left in
lab_ssh "$IP" 'cat > ~/labh/rows.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]) }
function sv(el,name){ var v=attr(el,name); try { return v? (''+v.js) : '' } catch(e){ return '' } }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function flat(el,acc,d){ acc.push(el); if(d>18) return acc; var ch=kids(el); for(var i=0;i<ch.length;i++) flat(ch[i],acc,d+1); return acc }
function run(){
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var all=[]; flat(app,all,0);
  var rows=all.filter(function(e){ return sv(e,'AXSubrole')==='AXTableRow' });
  var acc=[];
  for(var i=0;i<rows.length;i++){
    var sel=attr(rows[i],'AXSelected');
    var sub=[]; flat(rows[i],sub,0); var texts=[];
    for(var j=0;j<sub.length;j++){ var d=sv(sub[j],'AXDescription'); if(d) texts.push(d) }
    var label=texts.length?texts[0]:'';
    if(label==='') continue;
    acc.push('['+(i+1)+']'+((sel!==null&&(''+sel.js)==='true')?'*':' ')+' '+label);
  }
  return acc.join('\n') }
EOF

# ============================================================ ship the CLI
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
scpO -r "$(lab_commander_dir)" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }

note "warm-up launch/quit/relaunch"
lab_ssh "$IP" 'open -g -a Things3; sleep 14; osascript -e "tell application \"Things3\" to quit"; sleep 4; open -g -a Things3; sleep 12' </dev/null

TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"

# ============================================================ helpers
chord() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/keypid.js $1 $2 ${3:-1}" </dev/null 2>&1; }
axrows() { lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/rows.js' </dev/null 2>&1; }
axvis() { lab_ssh "$IP" 'osascript ~/labh/vis.applescript' </dev/null 2>&1; }

selrow() {
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectRowByIdScript(process.argv[1], process.argv[2])))" \
    "$TABLE" "$1" > "$OUT/sel.applescript"
  lab_scp "$OUT/sel.applescript" "admin@$IP:/Users/admin/labh/sel.applescript" >/dev/null
  lab_ssh "$IP" 'osascript ~/labh/sel.applescript' </dev/null 2>&1
}

titleOf() { gq "SELECT title FROM TMTask WHERE uuid='$1'"; }

# THE TODAY MEMBERSHIP the reader uses, and the comparator that orders it.
TODAY_WHERE="trashed=0 AND status=0 AND type IN (0,1) AND rt1_recurrenceRule IS NULL AND startDate IS NOT NULL AND startDate <= $PACKED_TODAY AND start IN (1,2)"
TODAY_ORDER="startBucket ASC, COALESCE(todayIndexReferenceDate, startDate, deadline) DESC, todayIndex ASC, uuid ASC"

visorder() {
  gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (
        SELECT title AS t FROM TMTask WHERE $TODAY_WHERE ORDER BY $TODAY_ORDER)"
}
rankdump() {
  gt "SELECT title, substr(uuid,1,8) AS uuid8, startBucket AS sb, startDate AS sd,
             todayIndexReferenceDate AS tiRef,
             COALESCE(todayIndexReferenceDate, startDate, deadline) AS cohort,
             todayIndex AS tidx, start, reminderTime AS rem, userModificationDate AS umd
      FROM TMTask WHERE $TODAY_WHERE ORDER BY $TODAY_ORDER"
}
TOPCOHORT() { gq "SELECT MAX(COALESCE(todayIndexReferenceDate, startDate, deadline)) FROM TMTask WHERE $TODAY_WHERE AND startBucket=0"; }
# the LAST row of the TOP (newest) cohort — its ⌘↓ neighbour is an older cohort
boundary_last_of_top() {
  gq "SELECT uuid FROM TMTask WHERE $TODAY_WHERE AND startBucket=0
      AND COALESCE(todayIndexReferenceDate, startDate, deadline) = $(TOPCOHORT)
      ORDER BY todayIndex DESC, uuid DESC LIMIT 1"
}
# the FIRST row of the SECOND cohort — its ⌘↑ neighbour is a newer cohort
boundary_first_of_2nd() {
  gq "SELECT uuid FROM TMTask WHERE $TODAY_WHERE AND startBucket=0
      AND COALESCE(todayIndexReferenceDate, startDate, deadline) < $(TOPCOHORT)
      ORDER BY COALESCE(todayIndexReferenceDate, startDate, deadline) DESC, todayIndex ASC, uuid ASC LIMIT 1"
}
first_row_of_view() {
  gq "SELECT uuid FROM TMTask WHERE $TODAY_WHERE ORDER BY $TODAY_ORDER LIMIT 1"
}
second_row_of_view() {
  gq "SELECT uuid FROM TMTask WHERE $TODAY_WHERE ORDER BY $TODAY_ORDER LIMIT 1 OFFSET 1"
}
# The LIVE This Evening rows only. `startBucket = 1` alone is not evening
# membership: evening expires daily, so a STALE bucket-1 row (its day passed) is
# rendered in Today PROPER (STEV1 / todayPlacement) and its ⌘↑ crosses nothing.
live_evening_nth() {
  gq "SELECT uuid FROM TMTask WHERE $TODAY_WHERE AND startBucket=1 AND startDate = $PACKED_TODAY
      ORDER BY todayIndex ASC, uuid ASC LIMIT 1 OFFSET ${1:-0}"
}
# A `start = 2` (someday-stage) row pinned into Today, sitting INSIDE the top
# cohort with room above it. Isolates whether the `start 2 -> 1` rewrite the
# crossing performs belongs to the crossing or to any chord on such a row.
start2_inside_top_cohort() {
  gq "SELECT uuid FROM TMTask WHERE $TODAY_WHERE AND startBucket=0 AND start=2
      AND COALESCE(todayIndexReferenceDate, startDate, deadline) = $(TOPCOHORT)
      ORDER BY todayIndex DESC, uuid DESC LIMIT 1"
}

relaunch() {
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 5; open -g -a Things3; sleep 16' </dev/null
  show "things:///show?id=today"
  lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 2' </dev/null
}

snap() { lab_ssh "$IP" "python3 ~/labh/rowsnap.py" </dev/null > "$OUT/snap/$1.tsv" 2>&1
  note "  [snap $1: $(cut -f1 "$OUT/snap/$1.tsv"|sort -u|wc -l|tr -d ' ') rows x $(awk -F'\t' 'NR==1{u=$1} $1==u{c++} END{print c+0}' "$OUT/snap/$1.tsv") cols]"; }
snapdiff() {
  note "  ---- FULL-ROW DELTA over EVERY untrashed row: ${3:-$1 -> $2} ----"
  python3 - "$OUT/snap/$1.tsv" "$OUT/snap/$2.tsv" <<'PY' | tee -a "$REPORT"
import sys
def load(p):
    d={}
    for line in open(p):
        parts=line.rstrip("\n").split("\t")
        if len(parts)<3: continue
        d[(parts[0],parts[1])]=parts[2]
    return d
b=load(sys.argv[1]); a=load(sys.argv[2])
bu={k[0] for k in b}; au={k[0] for k in a}
for u in sorted(bu-au): print("    DELETED row %s"%u)
for u in sorted(au-bu): print("    INSERTED row %s"%u)
both=bu&au
ch=[(k,b[k],a[k]) for k in sorted(b) if k[0] in both and k in a and a[k]!=b[k]]
if not ch: print("    (no field changed on ANY untrashed row)")
for (u,col),ov,nv in ch: print("    CHANGED %s.%s: %s -> %s"%(u[:8],col,ov,nv))
print("    (rows in both: %d; fields compared: %d)"%(len(both),len([k for k in b if k[0] in both])))
PY
}

# ============================================================ seed
# The NEWER cohort: two synthetic rows entered into Today TODAY, through the
# shipped CLI's URL-scheme vector. The OLDER cohort is the golden's own baked
# Today set (entered before the clone's pinned day) — no direct SQLite write
# anywhere. Both evening rows carry a reminder: the evening chord's prize over
# the bounce is that it does not strip `reminderTime` (§9n/R07).
note ""
note "==== SEED (through the shipped CLI / URL scheme) ===="
note "  seed C4-N1: $(G "todo add C4-N1 --when today" | tail -2 | tr '\n' ' ')"
note "  seed C4-N2: $(G "todo add C4-N2 --when today" | tail -2 | tr '\n' ' ')"
note "  seed C4-E1: $(G "todo add C4-E1 --when evening --reminder 20:00" | tail -2 | tr '\n' ' ')"
note "  seed C4-E2: $(G "todo add C4-E2 --when evening --reminder 21:30" | tail -2 | tr '\n' ' ')"
sleep 3

show "things:///show?id=today"
lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 2' </dev/null
note "frontmost before any drive: $(front)"
note "the WHOLE Today view, in comparator order:"; rankdump | sed 's/^/    /' | tee -a "$REPORT"
note "displayed (comparator) order: $(visorder)"
note "top cohort key: $(TOPCOHORT)"
note "AX census of the Today view:"; axrows | sed 's/^/    /' | tee -a "$REPORT"
breset

# a cell: <name> <uuid-to-select> <keycode> <label>
cell() {
  local name="$1" uuid="$2" code="$3" label="$4"
  note ""
  note "==== CELL $name — $label ===="
  note "  target: $(titleOf "$uuid") (${uuid:0:8})"
  note "  displayed BEFORE: $(visorder)"
  snap "${name}-pre"
  bmark "$name"
  note "  select: $(selrow "$uuid")"
  local T0 T1; T0=$(date +%s)
  note "  chord:  $(chord "$code" "$FCMD" 1)"
  sleep 3
  T1=$(date +%s)
  snap "${name}-post"
  snapdiff "${name}-pre" "${name}-post" "$name"
  note "  displayed AFTER:  $(visorder)"
  note "  wall for chord+settle: $((T1 - T0))s"
  note "  AX census AFTER:"; axrows | sed 's/^/      /' | tee -a "$REPORT"
  note "  frontmost: $(front)"
}

# the durability read — does the ON-SCREEN order survive the app re-deriving it?
durability() {
  note "  ---- RELAUNCH (does the on-screen order survive a re-derive?) ----"
  relaunch
  note "  AX census AFTER RELAUNCH:"; axrows | sed 's/^/      /' | tee -a "$REPORT"
  note "  comparator order AFTER RELAUNCH: $(visorder)"
}

# ---- the in-cohort baseline -------------------------------------------------
cell incohort "$(second_row_of_view)" "$KUP" "the SECOND row of the view, one slot up — INSIDE the top cohort"

# ---- the top-of-view decline ------------------------------------------------
cell topedge "$(first_row_of_view)" "$KUP" "the FIRST row of the whole view, one slot up — nowhere to go"

# ---- the `start = 2` isolation, INSIDE one cohort ---------------------------
cell s2chord "$(start2_inside_top_cohort)" "$KUP" "a start=2 (someday-stage) row pinned into Today, one slot up INSIDE its cohort"

# ---- the boundary, downward (the gate) --------------------------------------
cell xdown "$(boundary_last_of_top)" "$KDOWN" "the LAST row of the TOP cohort, one slot DOWN — ACROSS the entry-cohort boundary"
durability

# ---- the boundary, upward (the gate) ----------------------------------------
cell xup "$(boundary_first_of_2nd)" "$KUP" "the FIRST row of the SECOND cohort, one slot UP — ACROSS the entry-cohort boundary"
durability

# ---- WITHIN This Evening, on a reminder-carrying row ------------------------
cell evein "$(live_evening_nth 1)" "$KUP" "the SECOND live This Evening row (reminder-carrying), one slot up INSIDE the section"

# ---- the This Evening TOP edge (CHORD2 §4be2 on this build) -----------------
cell evetop "$(live_evening_nth 0)" "$KUP" "the FIRST live This Evening row (reminder-carrying), one slot up — the section boundary"
durability

note ""
note "==== BEEPS (attributed per cell) ===="
bassert | sed 's/^/    /' | tee -a "$REPORT"
note "artifacts in $OUT"
