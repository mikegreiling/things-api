#!/bin/bash
# TMOV1 — can a repeating TEMPLATE change CONTAINER without touching its rule?
#
# THE PROBLEM (#655). `todo.move` and `project.move` sit in `REPEAT_SENSITIVE`
# (src/write/guards.ts) with the annotation "unvalidated on templates/repeating
# projects (E07/E14 probed plain rows)", so H-REPEAT-SCHEDULE refuses every
# container move aimed at a series — area ↔ project ↔ loose — and tells the
# caller to "edit the repeat rule in the Things app", which is not what a
# `--to-project` move asked for. That fence is a PLACEHOLDER over an unprobed
# cell, not a measured hazard. The measured walls nearby are narrower:
#   - URL *scheduling* writes on a template crash Things (T12/U12, oddities §1).
#     A `list-id` membership write carries no scheduling parameter.
#   - AppleScript `move … to list "Someday"/"Inbox"` on a template-side row
#     errors 301 — the built-in-LIST wall (RSIM-S §S4/§S-R3).
#   - Template-side CHILDREN move between projects cleanly via url-scheme, "no
#     guard, no residue" (RSIM-P P3).
# This campaign measures the template row itself, on the vectors the two ops
# actually compile to, and re-fences exactly what the app refuses.
#
# THE DIST SHIPPED HERE IS GUARD-LIFTED: `todo.move`/`project.move` removed from
# REPEAT_SENSITIVE in the working copy. Nothing else about the ops is changed, so
# every cell drives the SHIPPED verb through the real pipeline (pre-read, compile,
# dispatch, read-after-write verify, expectedDelta) — the only thing that can
# certify a lift.
#
# CELLS
#   A   FIXED weekly to-do template, the container CHAIN on the op's own vector
#       (url-scheme `update?list-id=`), one arm per transition:
#         A1 project→project · A2 project→area · A3 area→project
#         A4 container→LOOSE (`--loose`) · A5 loose→project
#   X   the ALTERNATE vector as a cross-check: the same project→project move on a
#       second fixed template with `--vector applescript`
#       (`set project of to do id … to project id …`).
#   C   CONTROL — the built-in-LIST wall. C1 drives the shipped `todo move
#       --inbox` (AppleScript `move … to list "Inbox"`); C2 sends raw AppleScript
#       `move … to list "Someday"`. Expect 301/302 or a silent no-op; whichever
#       it is, it is what the narrowed fence gets keyed on.
#   P   repeating PROJECT template: P1 area→area, P2 area→LOOSE (`--no-area`;
#       a project has no parent project, so those are the two transitions).
#   AC  AFTER-COMPLETION to-do template (tp=1, a different rule shape):
#       one project→project arm.
#   S   SPAWN-FOLLOWS: a FIXED DAILY template is moved to a new project, then the
#       next occurrence is minted headlessly — first through the shipped CNC
#       composite (`todo complete <template>`, template-mutation.ts), then by
#       rolling the guest clock onto the next slot so the app's OWN spawner
#       mints one. Does the newly minted occurrence land in the NEW container?
#       Also records whether the EXISTING occurrence followed the template.
#
# ORACLES, every arm: the container FKs (project/area/heading) before and after;
# the rule blob's sha256 (byte-identity); BOTH spawn cursors
# (rt1_nextInstanceStartDate, rt1_instanceCreationStartDate) plus
# rt1_instanceCreationCount, rt1_instanceCreationPaused and `start`; a FULL-ROW
# 41-column diff across every TMOV1-% row (so a change to the current occurrence
# shows up whether or not we predicted it); app liveness; crash-report count;
# beep accounting.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23 build
# 32300036 / dbv27; the golden is NEVER booted). Airgap, clock pinned
# 2026-07-05 12:00 (a Sunday). Cell S is the ONLY clock roll (→ 07-06 → 07-07),
# and it runs last; the 2026-07-18 trial wall is never approached. Fixtures fully
# synthetic (TMOV1-*). Beep sentinel armed per drive (report-only,
# THINGS_LAB_BEEPS_OK=1). Teardown on EXIT (KEEP=1 keeps the clone, REUSE=1
# attaches to a live one).
#
# Usage:  CELLS="A C" VM=tmov1-lab KEEP=1 lab/scripts/research-tmov1.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-tmov1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/snap" "$OUT/log"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-SEED A X C P AC S}"
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
# Cell S's daily fixture. Overridable so the cell can be RE-TAKEN on a clone whose
# clock has already been rolled (a fresh name gets a fresh, unresolved series).
SPNAME="${SPNAME:-TMOV1-SPN}"
export THINGS_LAB_BEEPS_OK=1
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[tmov1] $*" | tee -a "$REPORT"; }
has_cell() { case " $CELLS " in *" $1 "*) return 0;; *) return 1;; esac; }

PASS=0; FAIL=0
cell() { note ""; note "========== $1 =========="; }
verdict() { # verdict <name> <expected-substring> <actual>
  if echo "$3" | grep -qF -- "$2"; then note "  PASS $1"; PASS=$((PASS+1));
  else note "  FAIL $1 — expected to contain '$2', got: $3"; FAIL=$((FAIL+1)); fi
}
verdict_eq() { # verdict_eq <name> <expected> <actual>
  if [ "$(echo "$3" | tr -d '[:space:]')" = "$2" ]; then note "  PASS $1 (= $2)"; PASS=$((PASS+1));
  else note "  FAIL $1 — expected exactly '$2', got: '$3'"; FAIL=$((FAIL+1)); fi
}

# ---------------------------------------------------------------- clone + boot
IP=""
if [ "$REUSE" = "1" ]; then
  IP="$(tart ip "$VM" 2>/dev/null || true)"
  if [ -n "$IP" ] && lab_ssh "$IP" true 2>/dev/null; then note "REUSE=1 — attached to $VM at $IP"; else IP=""; fi
fi

if [ -z "$IP" ]; then
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js — npm run build first"; exit 1; }
  [ -d node_modules/commander ] || { note "FATAL: node_modules/commander missing — run npm ci"; exit 1; }
  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (a Sunday)"
  BOOTSTRAP=1
else
  BOOTSTRAP=0
fi

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM running at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done: $(tart list 2>/dev/null | grep -c "$VM" || true) row(s) named $VM remain"
}
trap cleanup EXIT

# ---------------------------------------------------------------- guest helpers
lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }

# rule summary + BOTH spawn cursors (CNCAC2's rsum.py, plus the rule-blob sha256
# that makes "byte-identical" checkable at a glance).
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib, hashlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, startDate, rt1_instanceCreationPaused, start, reminderTime FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
sha = 'NO-BLOB' if row[0] is None else hashlib.sha256(bytes(row[0])).hexdigest()[:16]
tail="next=%s icStart=%s icCount=%s paused=%s start=%s startDate=%s tmplDeadline=%s rem=%s ruleSha=%s"%(
    dpk(row[1]),dpk(row[2]),row[3],row[6],row[7],dpk(row[5]),dpk(row[4]),row[8],sha)
if row[0] is None:
    print("NO-RULE %s"%tail); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    bits=[]
    if 'wd' in o: bits.append("wd=%s(%s)"%(o['wd'], WD[o['wd']] if 0<=o['wd']<7 else "?"))
    for k in ('dy','mo','wdo'):
        if k in o: bits.append("%s=%s"%(k,o[k]))
    offs.append("{"+",".join(bits)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] %s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),tail))
EOF
rsum() { [ -n "${1:-}" ] || { echo "NO-UUID"; return; }; lab_ssh "$IP" "python3 ~/labh/rsum.py $1" </dev/null 2>&1; }

# FULL-ROW snapshot (CNCAC1/CNCAC2's rowsnap.py verbatim): every TMTask column
# for every row whose title matches, packed dates decoded, blobs hashed.
lab_ssh "$IP" 'cat > ~/labh/rowsnap.py' <<'EOF'
import sys, sqlite3, glob, hashlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True); c.row_factory=sqlite3.Row
DATECOLS={'startDate','deadline','stopDate','rt1_nextInstanceStartDate','rt1_instanceCreationStartDate','todayIndexReferenceDate','rt1_afterCompletionReferenceDate'}
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
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
crashes() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3-*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }

# ---- ship the production bundle (the GUARD-LIFTED working copy) -------------
if [ "$BOOTSTRAP" = "1" ]; then
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node ~/labh/beep-sentinel.sh' </dev/null
fi
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
CLIV=$(lab_ssh "$IP" "$CLI --version 2>&1 | tail -1" </dev/null)
case "$CLIV" in
  [0-9]*) note "guest CLI OK: things $CLIV" ;;
  *) note "FATAL: the guest CLI does not run — $CLIV"; exit 1 ;;
esac
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "shipped the guard-lifted dist; ui-enabled=true"

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" | grep -o '<integer>[0-9]*' | grep -o '[0-9]*')
note "env: Things $TVER ($TBLD) / dbv $DBV / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"
note "crash reports at start: $(crashes)"

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
quitapp() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 4; true' </dev/null; }
relaunch() { lab_ssh "$IP" 'open -a Things3; sleep 22; true' </dev/null; }
[ "$BOOTSTRAP" = "1" ] && { warm; note "warm-up done; app $(alive)"; }

# THE TRIAL WALL (REPX3 §5): golden-v4's Things expires 2026-07-18, STICKILY.
TRIAL_WALL="20260718"
setclock() { # setclock MMDDhhmmYYYY — quits the app first, relaunches after
  local d="$1" ymd="${1:8:4}${1:0:2}${1:2:2}"
  if [ "$ymd" -ge "$TRIAL_WALL" ]; then
    note "    REFUSED clock roll to $ymd — golden-v4's trial wall is $TRIAL_WALL (REPX3 §5)"
    return 1
  fi
  quitapp
  lab_ssh "$IP" "sudo date $d >/dev/null; date" </dev/null | sed 's/^/    clock now: /' | tee -a "$REPORT"
  relaunch
}

# ---------------------------------------------------------------- primitives
tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL ORDER BY creationDate DESC LIMIT 1"; }
projuuid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
areauuid() { gq "SELECT uuid FROM TMArea WHERE title='$1' LIMIT 1"; }
open_instance() { gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 AND status=0 ORDER BY startDate, creationDate LIMIT 1"; }
newest_instance() { gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
serieslist() { gt "SELECT substr(uuid,1,8) uuid, status, trashed, start, startDate, substr(coalesce(project,'-'),1,8) proj, substr(coalesce(area,'-'),1,8) area, substr(coalesce(heading,'-'),1,8) head FROM TMTask WHERE uuid='$1' OR rt1_repeatingTemplate='$1' ORDER BY creationDate"; }

# ctr <uuid> — the CONTAINER oracle, in one line. Names are resolved so an arm's
# verdict reads without cross-referencing uuids.
ctr() {
  [ -n "${1:-}" ] || { echo "NO-UUID"; return; }
  gq "SELECT 'project='||coalesce((SELECT title FROM TMTask p WHERE p.uuid=t.project),'NULL')
   ||' area='||coalesce((SELECT title FROM TMArea a WHERE a.uuid=t.area),'NULL')
   ||' heading='||coalesce((SELECT title FROM TMTask h WHERE h.uuid=t.heading),'NULL')
   ||' start='||t.start FROM TMTask t WHERE t.uuid='$1'"
}

beep_reset() { lab_ssh "$IP" 'BEEP_MARKS=~/things-lab/run/beep-marks.tsv ~/labh/beep-sentinel.sh reset' </dev/null >/dev/null 2>&1; }
beep_mark()  { lab_ssh "$IP" "BEEP_MARKS=~/things-lab/run/beep-marks.tsv ~/labh/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }
beep_assert(){ lab_ssh "$IP" 'THINGS_LAB_BEEPS_OK=1 BEEP_MARKS=~/things-lab/run/beep-marks.tsv ~/labh/beep-sentinel.sh assert' </dev/null 2>&1 | sed 's/^/    beeps: /' | tee -a "$REPORT"; }

# arm <label> <templateUuid> <cli args…> — the whole per-arm protocol in one
# call: snapshot + rule + container BEFORE, run the SHIPPED verb, snapshot +
# rule + container AFTER, full-row diff, liveness, crashes, beeps.
BEFORE_CTR=""; AFTER_CTR=""; BEFORE_RSUM=""; AFTER_RSUM=""; ARM_OUT=""
arm() {
  local label="$1" t="$2"; shift 2
  beep_reset; beep_mark "$label"
  snap "${label}-before" "TMOV1-%"
  BEFORE_CTR=$(ctr "$t"); BEFORE_RSUM=$(rsum "$t")
  note "  before: $BEFORE_CTR"
  note "  before rule: $BEFORE_RSUM"
  note "  cmd: things $*"
  lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null >"$OUT/log/$label.out" 2>&1
  ARM_OUT=$(cat "$OUT/log/$label.out")
  note "  --- CLI output ($label) ---"; sed 's/^/    | /' "$OUT/log/$label.out" | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
  snap "${label}-after" "TMOV1-%"
  AFTER_CTR=$(ctr "$t"); AFTER_RSUM=$(rsum "$t")
  note "  after:  $AFTER_CTR"
  note "  after rule: $AFTER_RSUM"
  snapdiff "${label}-before" "${label}-after" "$label"
  note "  app=$(alive) crashes=$(crashes)"
  beep_assert
}

# rulesafe <label> — the rule/cursor half of every arm's oracle: the rule blob's
# sha256 and BOTH cursors, the tally, paused and `start`, must be unchanged.
rulesafe() {
  local b a
  b=$(echo "$BEFORE_RSUM" | tr ' ' '\n' | grep -E '^(ruleSha|next|icStart|icCount|paused|start)=' | sort | tr '\n' ' ')
  a=$(echo "$AFTER_RSUM"  | tr ' ' '\n' | grep -E '^(ruleSha|next|icStart|icCount|paused|start)=' | sort | tr '\n' ' ')
  if [ "$b" = "$a" ]; then note "  PASS $1 rule+cursors untouched ($a)"; PASS=$((PASS+1));
  else note "  FAIL $1 rule/cursor MOVED: before[$b] after[$a]"; FAIL=$((FAIL+1)); fi
}

# =============================================================== SEED
if has_cell SEED; then
  cell "SEED — synthetic containers + the five templates"
  lab_ssh "$IP" "$LAB_DIRECT $CLI area add 'TMOV1-AreaAlpha'; $LAB_DIRECT $CLI area add 'TMOV1-AreaBeta'" </dev/null >"$OUT/log/seed-areas.out" 2>&1
  sed 's/^/    | /' "$OUT/log/seed-areas.out" | tee -a "$REPORT"
  lab_ssh "$IP" "$LAB_DIRECT $CLI project add 'TMOV1-ProjOne' --area 'TMOV1-AreaAlpha'; $LAB_DIRECT $CLI project add 'TMOV1-ProjTwo' --area 'TMOV1-AreaBeta'" </dev/null >"$OUT/log/seed-projects.out" 2>&1
  sed 's/^/    | /' "$OUT/log/seed-projects.out" | tee -a "$REPORT"
  AREA_A=$(areauuid 'TMOV1-AreaAlpha'); AREA_B=$(areauuid 'TMOV1-AreaBeta')
  PROJ1=$(projuuid 'TMOV1-ProjOne'); PROJ2=$(projuuid 'TMOV1-ProjTwo')
  note "  AreaAlpha=$AREA_A AreaBeta=$AREA_B ProjOne=$PROJ1 ProjTwo=$PROJ2"
  verdict_eq "the four containers exist" "4" "$(gq "SELECT (SELECT count(*) FROM TMArea WHERE title LIKE 'TMOV1-%')+(SELECT count(*) FROM TMTask WHERE title LIKE 'TMOV1-Proj%' AND trashed=0)")"

  mkfix() { # mkfix <title> <extra add-repeating flags…>
    local title="$1"; shift
    note "  minting $title: things todo add-repeating '$title' $*"
    lab_ssh "$IP" "$LAB_DIRECT $CLI todo add-repeating '$title' $* --dangerously-drive-gui --verify-timeout 120000; echo EXIT=\$?" \
      </dev/null >"$OUT/log/seed-$title.out" 2>&1
    sed 's/^/    | /' "$OUT/log/seed-$title.out" | tee -a "$REPORT"
  }
  # A/C/X/AC fixtures all start in ProjOne; the daily SPAWN fixture too.
  mkfix "TMOV1-FIX" --when 2026-07-05 --project "'TMOV1-ProjOne'" --frequency weekly --interval 1
  mkfix "TMOV1-XAS" --when 2026-07-05 --project "'TMOV1-ProjOne'" --frequency weekly --interval 1
  mkfix "TMOV1-CTL" --when 2026-07-05 --project "'TMOV1-ProjOne'" --frequency weekly --interval 1
  mkfix "TMOV1-AC"  --when 2026-07-05 --project "'TMOV1-ProjOne'" --after-completion --frequency weekly --interval 1
  note "  minting TMOV1-PRJ (repeating PROJECT) in AreaAlpha"
  lab_ssh "$IP" "$LAB_DIRECT $CLI project add-repeating 'TMOV1-PRJ' --area 'TMOV1-AreaAlpha' --frequency weekly --interval 1 --dangerously-drive-gui --verify-timeout 120000; echo EXIT=\$?" \
    </dev/null >"$OUT/log/seed-TMOV1-PRJ.out" 2>&1
  sed 's/^/    | /' "$OUT/log/seed-TMOV1-PRJ.out" | tee -a "$REPORT"

  note "  --- seeded templates ---"
  gt "SELECT title, substr(uuid,1,8) uuid, type, start, startDate, substr(coalesce(project,'-'),1,8) proj, substr(coalesce(area,'-'),1,8) area FROM TMTask WHERE title LIKE 'TMOV1-%' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate" | sed 's/^/    /' | tee -a "$REPORT"
  verdict_eq "five templates minted" "5" "$(gq "SELECT count(*) FROM TMTask WHERE title LIKE 'TMOV1-%' AND rt1_recurrenceRule IS NOT NULL AND trashed=0")"
  note "  app=$(alive) crashes=$(crashes)"
fi

FIX=$(tmpl 'TMOV1-FIX'); XAS=$(tmpl 'TMOV1-XAS'); CTL=$(tmpl 'TMOV1-CTL')
ACT=$(tmpl 'TMOV1-AC');  SPN=$(tmpl "$SPNAME")
PRJ=$(gq "SELECT uuid FROM TMTask WHERE title='TMOV1-PRJ' AND type=1 AND trashed=0 AND rt1_recurrenceRule IS NOT NULL ORDER BY creationDate DESC LIMIT 1")
note "templates: FIX=$FIX XAS=$XAS CTL=$CTL AC=$ACT PRJ=$PRJ SPN($SPNAME)=$SPN"

# =============================================================== CELL A
if has_cell A; then
  cell "A — FIXED weekly to-do template: the container CHAIN on the op's own vector"
  [ -n "$FIX" ] || { note "  SKIPPED — no TMOV1-FIX template (seed failed)"; FAIL=$((FAIL+1)); }
  if [ -n "$FIX" ]; then
    note "  series before the chain:"; serieslist "$FIX" | sed 's/^/    /' | tee -a "$REPORT"

    note ""; note "--- A1 project -> project ---"
    arm A1 "$FIX" "todo move $FIX --to-project 'TMOV1-ProjTwo' --json"
    verdict "A1 the move landed" '"ok":true' "$ARM_OUT"
    verdict "A1 container = ProjTwo" "project=TMOV1-ProjTwo" "$AFTER_CTR"
    rulesafe A1

    note ""; note "--- A2 project -> area ---"
    arm A2 "$FIX" "todo move $FIX --to-area 'TMOV1-AreaBeta' --json"
    verdict "A2 the move landed" '"ok":true' "$ARM_OUT"
    verdict "A2 container = AreaBeta" "area=TMOV1-AreaBeta" "$AFTER_CTR"
    verdict "A2 the project link cleared" "project=NULL" "$AFTER_CTR"
    rulesafe A2

    note ""; note "--- A3 area -> project ---"
    arm A3 "$FIX" "todo move $FIX --to-project 'TMOV1-ProjOne' --json"
    verdict "A3 the move landed" '"ok":true' "$ARM_OUT"
    verdict "A3 container = ProjOne" "project=TMOV1-ProjOne" "$AFTER_CTR"
    rulesafe A3

    note ""; note "--- A4 container -> LOOSE ---"
    arm A4 "$FIX" "todo move $FIX --loose --json"
    verdict "A4 the move landed" '"ok":true' "$ARM_OUT"
    verdict "A4 no project" "project=NULL" "$AFTER_CTR"
    verdict "A4 no area" "area=NULL" "$AFTER_CTR"
    rulesafe A4

    note ""; note "--- A5 loose -> project ---"
    arm A5 "$FIX" "todo move $FIX --to-project 'TMOV1-ProjTwo' --json"
    verdict "A5 the move landed" '"ok":true' "$ARM_OUT"
    verdict "A5 container = ProjTwo" "project=TMOV1-ProjTwo" "$AFTER_CTR"
    rulesafe A5

    note "  series after the chain:"; serieslist "$FIX" | sed 's/^/    /' | tee -a "$REPORT"
  fi
fi

# =============================================================== CELL X
if has_cell X; then
  cell "X — the ALTERNATE vector: project->project pinned to applescript"
  if [ -z "$XAS" ]; then note "  SKIPPED — no TMOV1-XAS template"; FAIL=$((FAIL+1)); else
    arm X1 "$XAS" "todo move $XAS --to-project 'TMOV1-ProjTwo' --vector applescript --json"
    verdict "X1 the move landed" '"ok":true' "$ARM_OUT"
    verdict "X1 container = ProjTwo" "project=TMOV1-ProjTwo" "$AFTER_CTR"
    rulesafe X1
  fi
fi

# =============================================================== CELL C
if has_cell C; then
  cell "C — CONTROL: the built-in-LIST wall (RSIM-S §S4/§S-R3 on a template CHILD; here the TEMPLATE)"
  if [ -z "$CTL" ]; then note "  SKIPPED — no TMOV1-CTL template"; FAIL=$((FAIL+1)); else
    note ""; note "--- C1 shipped \`todo move --inbox\` (AppleScript \`move … to list \"Inbox\"\`) ---"
    arm C1 "$CTL" "todo move $CTL --inbox --json"
    note "  C1 verdict is DESCRIPTIVE — record what the app did, do not presume"
    note "  C1 exit/JSON: $(echo "$ARM_OUT" | tail -2 | tr '\n' ' ')"
    verdict "C1 the template did NOT leave its project" "project=TMOV1-ProjOne" "$AFTER_CTR"
    rulesafe C1

    note ""; note "--- C2 raw AppleScript \`move … to list \"Someday\"\` (the S4 spelling) ---"
    beep_reset; beep_mark C2
    snap C2-before "TMOV1-%"
    C2OUT=$(axq "tell application \"Things3\" to move to do id \"$CTL\" to list \"Someday\"")
    note "  raw AS result: $C2OUT"
    lab_ssh "$IP" 'sleep 3' </dev/null
    snap C2-after "TMOV1-%"
    snapdiff C2-before C2-after C2
    note "  after:  $(ctr "$CTL")"
    note "  after rule: $(rsum "$CTL")"
    note "  app=$(alive) crashes=$(crashes)"
    beep_assert

    note ""; note "--- C3 raw AppleScript \`move … to list \"Inbox\"\` (the S-R3 spelling) ---"
    beep_reset; beep_mark C3
    snap C3-before "TMOV1-%"
    C3OUT=$(axq "tell application \"Things3\" to move to do id \"$CTL\" to list \"Inbox\"")
    note "  raw AS result: $C3OUT"
    lab_ssh "$IP" 'sleep 3' </dev/null
    snap C3-after "TMOV1-%"
    snapdiff C3-before C3-after C3
    note "  after:  $(ctr "$CTL")"
    note "  app=$(alive) crashes=$(crashes)"
    beep_assert
  fi
fi

# =============================================================== CELL P
if has_cell P; then
  cell "P — repeating PROJECT template: area->area, area->LOOSE"
  if [ -z "$PRJ" ]; then note "  SKIPPED — no TMOV1-PRJ repeating project"; FAIL=$((FAIL+1)); else
    note ""; note "--- P1 area -> area ---"
    arm P1 "$PRJ" "project move $PRJ --to-area 'TMOV1-AreaBeta' --json"
    verdict "P1 the move landed" '"ok":true' "$ARM_OUT"
    verdict "P1 container = AreaBeta" "area=TMOV1-AreaBeta" "$AFTER_CTR"
    rulesafe P1

    note ""; note "--- P2 area -> LOOSE (--no-area) ---"
    arm P2 "$PRJ" "project move $PRJ --no-area --json"
    verdict "P2 the move landed" '"ok":true' "$ARM_OUT"
    verdict "P2 no area" "area=NULL" "$AFTER_CTR"
    rulesafe P2
  fi
fi

# =============================================================== CELL AC
if has_cell AC; then
  cell "AC — AFTER-COMPLETION template (tp=1): one project->project arm"
  if [ -z "$ACT" ]; then note "  SKIPPED — no TMOV1-AC template"; FAIL=$((FAIL+1)); else
    arm AC1 "$ACT" "todo move $ACT --to-project 'TMOV1-ProjTwo' --json"
    verdict "AC1 the move landed" '"ok":true' "$ARM_OUT"
    verdict "AC1 container = ProjTwo" "project=TMOV1-ProjTwo" "$AFTER_CTR"
    rulesafe AC1
  fi
fi

# =============================================================== CELL S
if has_cell S; then
  cell "S — SPAWN-FOLLOWS: does the NEXT occurrence land in the NEW container?"
  # The cell mints its OWN daily fixture, dated the guest's CURRENT day, so it can
  # be re-taken on a clone whose clock has already moved (pass SPNAME=… for a
  # fresh name). A daily rule is used so the app's own spawner can be reached with
  # a single one-day roll, well inside the trial wall.
  if [ -z "$SPN" ]; then
    GTODAY=$(lab_ssh "$IP" 'date +%Y-%m-%d' </dev/null)
    note "  minting $SPNAME (daily, --when $GTODAY, in ProjOne)"
    lab_ssh "$IP" "$LAB_DIRECT $CLI todo add-repeating '$SPNAME' --when $GTODAY --project 'TMOV1-ProjOne' --frequency daily --interval 1 --dangerously-drive-gui --verify-timeout 120000; echo EXIT=\$?" \
      </dev/null >"$OUT/log/S-seed.out" 2>&1
    sed 's/^/    | /' "$OUT/log/S-seed.out" | tee -a "$REPORT"
    SPN=$(tmpl "$SPNAME")
  fi
  if [ -z "$SPN" ]; then note "  SKIPPED — no $SPNAME daily template"; FAIL=$((FAIL+1)); else
    note "  daily template $SPNAME = $SPN"
    OCC0=$(open_instance "$SPN")
    note "  the existing occurrence before the move: $OCC0 -> $(ctr "$OCC0")"

    note ""; note "--- S1 move the daily template ProjOne -> ProjTwo ---"
    arm S1 "$SPN" "todo move $SPN --to-project 'TMOV1-ProjTwo' --json"
    verdict "S1 the move landed" '"ok":true' "$ARM_OUT"
    verdict "S1 template container = ProjTwo" "project=TMOV1-ProjTwo" "$AFTER_CTR"
    rulesafe S1
    note "  DOES THE EXISTING OCCURRENCE FOLLOW? $OCC0 -> $(ctr "$OCC0")"
    note "  series now:"; serieslist "$SPN" | sed 's/^/    /' | tee -a "$REPORT"

    note ""; note "--- S2 resolve the current occurrence through the shipped CNC composite ---"
    beep_reset; beep_mark S2
    snap S2-before "TMOV1-%"
    lab_ssh "$IP" "$LAB_DIRECT $CLI todo complete $SPN --verify-timeout 120000 --json; echo EXIT=\$?" </dev/null >"$OUT/log/S2.out" 2>&1
    sed 's/^/    | /' "$OUT/log/S2.out" | tee -a "$REPORT"
    lab_ssh "$IP" 'sleep 4' </dev/null
    snap S2-after "TMOV1-%"; snapdiff S2-before S2-after S2
    note "  template rule after S2: $(rsum "$SPN")"
    note "  app=$(alive) crashes=$(crashes)"; beep_assert

    note ""; note "--- S3 mint the NEXT occurrence (a second composite call) and read its container ---"
    beep_reset; beep_mark S3
    snap S3-before "TMOV1-%"
    lab_ssh "$IP" "$LAB_DIRECT $CLI todo complete $SPN --verify-timeout 120000 --json; echo EXIT=\$?" </dev/null >"$OUT/log/S3.out" 2>&1
    sed 's/^/    | /' "$OUT/log/S3.out" | tee -a "$REPORT"
    lab_ssh "$IP" 'sleep 4' </dev/null
    snap S3-after "TMOV1-%"; snapdiff S3-before S3-after S3
    MINTED=$(newest_instance "$SPN")
    note "  newest occurrence after the composite: $MINTED -> $(ctr "$MINTED")"
    verdict "S3 the minted occurrence is in the NEW container" "project=TMOV1-ProjTwo" "$(ctr "$MINTED")"
    note "  template rule after S3: $(rsum "$SPN")"
    note "  app=$(alive) crashes=$(crashes)"; beep_assert

    note ""; note "--- S4 the app's OWN spawner: roll the clock onto the next slot ---"
    snap S4-before "TMOV1-%"
    if setclock "$(lab_ssh "$IP" 'date -v+1d +%m%d1200%Y' </dev/null)"; then
      lab_ssh "$IP" 'sleep 20' </dev/null
      snap S4-after "TMOV1-%"; snapdiff S4-before S4-after S4
      SPAWNED=$(newest_instance "$SPN")
      note "  newest occurrence after the clock roll: $SPAWNED -> $(ctr "$SPAWNED")"
      verdict "S4 the clock-spawned occurrence is in the NEW container" "project=TMOV1-ProjTwo" "$(ctr "$SPAWNED")"
      note "  series at the end:"; serieslist "$SPN" | sed 's/^/    /' | tee -a "$REPORT"
      note "  app=$(alive) crashes=$(crashes)"
    else
      note "  S4 SKIPPED — the clock roll was refused"
    fi
  fi
fi

# =============================================================== SUMMARY
note ""
note "=============== TMOV1 SUMMARY ==============="
note "PASS=$PASS FAIL=$FAIL"
note "app=$(alive)  crash reports=$(crashes)"
note "artifacts: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
