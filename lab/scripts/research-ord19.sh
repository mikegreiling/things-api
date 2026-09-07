#!/bin/bash
# ORD-19 — does a chord-set rank on a repeating template's PROJECTED row survive
# the next occurrence spawn?
#
# THE BACKGROUND. [CHORD2](../../docs/lab/chord2-reorder-laws.md) §5d measured
# the thing ORDFIN1 had ruled impossible: inside an Upcoming day-group a
# repeating TEMPLATE's projected row is addressable, selects back as the
# TEMPLATE's own uuid, and one ⌘-arrow rewrites `todayIndex` on that one row with
# `rt1_recurrenceRule`, `rt1_nextInstanceStartDate`, `startDate`, `start` and
# `index` all untouched. So a person CAN put tomorrow's occurrence where they
# want it — but a template row is not the row they will see tomorrow. Tomorrow
# the app SPAWNS a fresh instance with its own uuid, and the open question, the
# one that gates any day-group ordering op, is whether the position the person
# chose comes with it.
#
# THE CELL. One clone, clock pinned 2026-07-05. Seed a day-block on 2026-07-06:
# three ordinary dated rows plus a DAILY template whose next occurrence lands
# there. Chord the template's projected row DOWN inside the block (down, not up:
# `add-repeating` places a new series at the FRONT of its day-block, so a ⌘↑
# there is declined at the leading edge — measured on the first pass, 1 beep and
# zero delta — and would prove nothing about a rank the chord actually set) and
# record the whole block. Then roll the guest clock ONE day — to 2026-07-06,
# still far inside the trial wall (2026-07-18) — relaunch Things so it
# materializes, and read the block back. Two outcomes:
#
#   (i)  the spawned INSTANCE arrives at the chord-set slot — the rank is
#        carried, and a day-group ordering op is worth building;
#   (ii) it arrives at the app's default slot — the rank died with the
#        projection, and ordering a projected row is cosmetic until the spawn.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped. Fixtures fully synthetic, seeded through the SHIPPED CLI —
# never a direct SQLite write. Full 41-column diffs over every untrashed row.
# Clone destroyed on teardown. PROBE ONLY — nothing is wired from this file.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM_NAME:-gscr-ord19-$$}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snap"
REPORT="$OUT/report.txt"
PIN_D1="070512002026"   # 2026-07-05 12:00 — the planning day
PIN_D2="070612002026"   # 2026-07-06 12:00 — the spawn day (trial wall 2026-07-18)
PACKED_D2=132805376     # encodePackedDate(2026-07-06)
: > "$REPORT"
note() { echo "[ord19] $*" | tee -a "$REPORT"; }

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
bassert() { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh assert --name ord19" </dev/null 2>&1; }
breset()  { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh reset" </dev/null >/dev/null 2>&1; }
bmark()   { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }

# ============================================================ preflight
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 10 ] && { note "FATAL: <10GB free"; exit 1; }
tart list 2>/dev/null | sed 's/^/    /' | tee -a "$REPORT"
if tart list 2>/dev/null | awk 'NR>1 && ($NF=="running" || $0 ~ /gscr-|things-run-/)' | grep -q .; then
  note "FATAL: the VM slot is not free"
  exit 1
fi
if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
  npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
fi
[ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }

TABLE='table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")'

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
lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN_D1 >/dev/null" </dev/null
note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"
scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null

lab_ssh "$IP" 'cat > ~/labh/rowsnap.py' <<'EOF'
import sqlite3, glob, hashlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True); c.row_factory=sqlite3.Row
DATECOLS={'startDate','deadline','stopDate','rt1_nextInstanceStartDate','rt1_instanceCreationStartDate','todayIndexReferenceDate'}
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%s(%04d-%02d-%02d)"%(v,y,m,d) if 1<y<5000 else v
for r in c.execute("SELECT * FROM TMTask WHERE trashed=0 ORDER BY creationDate, uuid").fetchall():
    for k in r.keys():
        v=r[k]
        if isinstance(v,bytes): v='blob:sha256:'+hashlib.sha256(v).hexdigest()[:16]+':len'+str(len(v))
        elif k in DATECOLS: v=dpk(v)
        print("%s\t%s\t%s"%(r['uuid'],k,v))
EOF

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
    if(!texts.length) continue;
    acc.push('['+(i+1)+']'+((sel!==null&&(''+sel.js)==='true')?'*':' ')+' '+texts[0]);
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
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / golden $GOLDEN"

# ============================================================ helpers
chord() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/keypid.js $1 $2 ${3:-1}" </dev/null 2>&1; }
axrows() { lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/rows.js' </dev/null 2>&1; }
selrow() {
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectRowByIdScript(process.argv[1], process.argv[2])))" \
    "$TABLE" "$1" > "$OUT/sel.applescript"
  lab_scp "$OUT/sel.applescript" "admin@$IP:/Users/admin/labh/sel.applescript" >/dev/null
  lab_ssh "$IP" 'osascript ~/labh/sel.applescript' </dev/null 2>&1
}
uidOf() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY rt1_recurrenceRule IS NULL LIMIT 1"; }

# The 2026-07-06 day-block, in the axis the block is ordered on. Templates are
# ADMITTED here (TMPLSORT/PTMPL): a template projecting onto the day is a
# first-class member of the block.
block() {
  gt "SELECT title, substr(uuid,1,8) AS uuid8,
             CASE WHEN rt1_recurrenceRule IS NOT NULL THEN 'TMPL' ELSE 'row' END AS kind,
             todayIndex AS tidx, startDate AS sd, rt1_nextInstanceStartDate AS nextI,
             rt1_instanceCreationStartDate AS icStart, rt1_instanceCreationCount AS icCount,
             COALESCE(substr(rt1_repeatingTemplate,1,8),'-') AS fromTmpl,
             userModificationDate AS umd
      FROM TMTask WHERE trashed=0 AND status=0 AND title LIKE 'O19-%'
      ORDER BY todayIndex, uuid"
}
blockorder() {
  gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (
        SELECT title || CASE WHEN rt1_recurrenceRule IS NOT NULL THEN '[T]' ELSE '' END AS t
        FROM TMTask WHERE trashed=0 AND status=0 AND title LIKE 'O19-%'
          AND (startDate = $PACKED_D2 OR rt1_nextInstanceStartDate = $PACKED_D2)
        ORDER BY todayIndex, uuid)"
}
snap() { lab_ssh "$IP" "python3 ~/labh/rowsnap.py" </dev/null > "$OUT/snap/$1.tsv" 2>&1
  note "  [snap $1: $(cut -f1 "$OUT/snap/$1.tsv"|sort -u|wc -l|tr -d ' ') rows]"; }
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
for u in sorted(au-bu):
    print("    INSERTED row %s:"%u)
    for k,v in sorted(a.items()):
        if k[0]==u and v not in ("None",""): print("        %s = %s"%(k[1],v))
both=bu&au
ch=[(k,b[k],a[k]) for k in sorted(b) if k[0] in both and k in a and a[k]!=b[k]]
if not ch: print("    (no field changed on ANY surviving row)")
for (u,col),ov,nv in ch: print("    CHANGED %s.%s: %s -> %s"%(u[:8],col,ov,nv))
PY
}

# ============================================================ seed
note ""
note "==== SEED — a 2026-07-06 day-block: three dated rows + a DAILY template ===="
for n in 1 2 3; do
  note "  seed O19-R$n: $(G "todo add O19-R$n --when 2026-07-06" | tail -1)"
done
note "  seed O19-TMPL: $(G "todo add-repeating O19-TMPL --frequency daily --interval 1 --when 2026-07-06 --dangerously-drive-gui --verify-timeout 120000" | tail -2 | tr '\n' ' ')"
sleep 4
TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='O19-TMPL' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1")
if [ -z "$TMPL" ]; then
  note "FATAL: no template minted — the repeat drive did not land; nothing to measure"
  gt "SELECT title, substr(uuid,1,8), start, startDate, rt1_recurrenceRule IS NOT NULL AS isTmpl FROM TMTask WHERE title LIKE 'O19-%' AND trashed=0" | sed 's/^/    /' | tee -a "$REPORT"
  exit 1
fi
note "template: $TMPL"
note "the day-block:"; block | sed 's/^/    /' | tee -a "$REPORT"
note "block order: $(blockorder)"

show "things:///show?id=upcoming"
lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 2' </dev/null
note "frontmost: $(front)"
note "AX census of Upcoming:"; axrows | sed 's/^/    /' | tee -a "$REPORT"
breset

# ============================================================ cell 1 — the chord
note ""
note "==== CELL 1 — chord the TEMPLATE's projected row DOWN inside the block ===="
snap "pre-chord"
bmark "chord"
note "  select the template's projected row: $(selrow "$TMPL")"
# DOWN, not up: `add-repeating` places the new series at the FRONT of its
# day-block, so a ⌘↑ there is declined at the block's leading edge (measured on
# the first pass: 1 beep, zero delta) and the cell would prove nothing about a
# rank the chord actually set. Two ⌘↓ put the projection third of four.
note "  chord: $(chord "$KDOWN" "$FCMD" 2)"
sleep 3
snap "post-chord"
snapdiff "pre-chord" "post-chord" "the chord"
note "  block after: $(blockorder)"
note "  the day-block:"; block | sed 's/^/    /' | tee -a "$REPORT"
CHORDED_ORDER=$(blockorder)
TMPL_TIDX=$(gq "SELECT todayIndex FROM TMTask WHERE uuid='$TMPL'")
note "  the template's chord-set todayIndex: $TMPL_TIDX"

# ============================================================ cell 2 — the spawn
note ""
note "==== CELL 2 — roll the clock ONE day and let the occurrence spawn ===="
bmark "spawn"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 5' </dev/null
lab_ssh "$IP" "sudo date $PIN_D2 >/dev/null" </dev/null
note "  guest clock now $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (trial wall 2026-07-18)"
lab_ssh "$IP" 'open -g -a Things3; sleep 30' </dev/null
show "things:///show?id=today"
lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 2' </dev/null
snap "post-spawn"
snapdiff "post-chord" "post-spawn" "the spawn"
note "  the O19 rows after the spawn:"; block | sed 's/^/    /' | tee -a "$REPORT"
note "  AX census of Today:"; axrows | sed 's/^/    /' | tee -a "$REPORT"

INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TMPL' AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
note ""
note "==== THE VERDICT ===="
note "  chord-set template todayIndex (before the spawn): $TMPL_TIDX"
note "  block order before the spawn: $CHORDED_ORDER"
if [ -z "$INST" ]; then
  note "  NO INSTANCE SPAWNED — the roll did not materialize the occurrence; the cell is INCONCLUSIVE"
else
  INST_TIDX=$(gq "SELECT todayIndex FROM TMTask WHERE uuid='$INST'")
  note "  spawned instance: $INST  todayIndex=$INST_TIDX"
  note "  template todayIndex now: $(gq "SELECT todayIndex FROM TMTask WHERE uuid='$TMPL'")"
  if [ "$INST_TIDX" = "$TMPL_TIDX" ]; then
    note "  *** (i) THE RANK IS CARRIED — the instance inherited the projection's todayIndex ***"
  else
    note "  *** (ii) THE RANK DID NOT SURVIVE — the instance arrived at $INST_TIDX, not $TMPL_TIDX ***"
  fi
  note "  the Today list, in the reader's comparator order:"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, todayIndex AS tidx, startDate AS sd,
             todayIndexReferenceDate AS tiRef, COALESCE(substr(rt1_repeatingTemplate,1,8),'-') AS fromTmpl
      FROM TMTask WHERE trashed=0 AND status=0 AND startDate IS NOT NULL AND startDate <= $PACKED_D2
        AND start IN (1,2) AND rt1_recurrenceRule IS NULL
      ORDER BY startBucket ASC, COALESCE(todayIndexReferenceDate, startDate, deadline) DESC, todayIndex ASC, uuid ASC" \
    | sed 's/^/    /' | tee -a "$REPORT"
fi

note ""
note "==== BEEPS ===="
bassert | sed 's/^/    /' | tee -a "$REPORT"
note "artifacts in $OUT"
