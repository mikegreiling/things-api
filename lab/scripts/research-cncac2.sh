#!/bin/bash
# CNCAC2 — the ONE guard-lifted cell: `todo add-repeating --after-completion`
# with a per-occurrence deadline, end to end through the SHIPPED verb.
#
# THE PROBLEM. `runAddRepeatingTodo` diverted its deadline geometry by RULE KIND
# on two beliefs, both of which CNCAC1 §9 falsified against the app itself:
#   (1) `--start-days-earlier` with `--after-completion` was REFUSED — "an
#       after-completion repeat has no calendar start to count back from";
#   (2) a concrete `--deadline` with `--after-completion` was left on the SEED
#       (the DBLSPAWN1-era belief that after-completion mints are deadline-free),
#       so the caller got ONE deadlined occurrence and a deadline-free series.
# CNCAC1 §9.1 measured the app's own Repeat dialog offering `Add deadlines` under
# `after completion`, the rule landing `ts = -N` + the 4001-01-01 deadline
# sentinel, the seed occurrence born with the derived deadline, and (§9.2) the
# CNC-minted successor carrying one too. That campaign built its fixture BY HAND
# (URL add + a direct AX drive of the dialog). This one drives the SHIPPED verb
# with the refusal lifted in the working copy, which is the only thing that can
# certify the lift: the recipe, the anchor derivation, the post-drive verify and
# the expectedDelta assertions all have to agree with the app.
#
# CELLS
#   CTRL  POSITIVE CONTROL — the same command shape MINUS --after-completion
#         (fixed weekly, --when 2026-07-05 --deadline 2026-07-08). A deadlined
#         drive that is already certified (DBLSPAWN1 cell E / YANCH1): if this
#         arm fails, nothing the AC arm says is readable.
#   AC    THE CELL — `--after-completion --deadline 2026-07-08` with --when
#         2026-07-05. Oracle: rule tp=1 ts=-3, template deadline = the 4001
#         sentinel, seed occurrence startDate 2026-07-05 / deadline 2026-07-08.
#   SDE   the SAME geometry named from the other end — `--start-days-earlier 3`,
#         the spelling the lifted refusal named explicitly. Must land the same
#         rule.
#   MINT  does the deadline RIDE the series? Complete the AC seed occurrence
#         (shipped URL-vector verb), read the derived cursor (anchor + interval
#         − ts), then drive `Items ▸ Repeat ▸ Create Next Copy` and check the
#         minted successor's own derived deadline. CNCAC1 §9.2's law, through
#         the shipped-built series.
#   REF   the refusals that must SURVIVE the lift — a keyword --when still needs
#         a concrete date; a --deadline/--start-days-earlier disagreement is
#         still refused. Zero-mutation, no drive.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23 / dbv27; the
# golden is NEVER booted). Airgap, clock pinned 2026-07-05 12:00 (a Sunday) — no
# clock roll, so the 2026-07-18 trial wall is never approached. Fixtures fully
# synthetic (CNCAC2-*). DB oracle = FULL TMTask row snapshots (every column,
# packed dates decoded, blobs hashed) diffed either side of every gesture.
# Beep sentinel armed per drive (report-only, THINGS_LAB_BEEPS_OK=1).
# Teardown on EXIT (KEEP=1 keeps the clone, REUSE=1 attaches to a live one).
#
# Usage:  CELLS="CTRL AC" VM=cncac2-lab KEEP=1 lab/scripts/research-cncac2.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-cncac2-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/snap" "$OUT/log"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-REF CTRL AC SDE MINT}"
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
export THINGS_LAB_BEEPS_OK=1
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[cncac2] $*" | tee -a "$REPORT"; }
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
  [ -d node_modules/commander ] || { note "FATAL: node_modules/commander missing"; exit 1; }
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

# rule summary (CNCAC1's rsum.py verbatim — the after-completion ANCHOR decoded).
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, startDate, rt1_instanceCreationPaused, rt1_afterCompletionReferenceDate, reminderTime FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
tail="next=%s icStart=%s icCount=%s paused=%s tmplDeadline=%s acRef=%s rem=%s"%(
    dpk(row[1]),dpk(row[2]),row[3],row[6],dpk(row[4]),dpk(row[7]),row[8])
if row[0] is None:
    print("NO-RULE startDate=%s %s"%(dpk(row[5]),tail)); sys.exit(0)
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

# raw rule blob bytes, verbatim (the plist the app wrote).
lab_ssh "$IP" 'cat > ~/labh/rblob.py' <<'EOF'
import sys, sqlite3, glob
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
b=c.execute("SELECT rt1_recurrenceRule FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not b or b[0] is None: print("NO-BLOB"); sys.exit(0)
raw=bytes(b[0]); print("bytes=%d"%len(raw)); sys.stdout.write(raw.decode('utf-8','replace'))
EOF
rblob() { lab_ssh "$IP" "python3 ~/labh/rblob.py $1" </dev/null 2>&1; }

# FULL-ROW snapshot (CNCAC1's rowsnap.py verbatim).
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

TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" | grep -o '<integer>[0-9]*' | grep -o '[0-9]*')
note "env: Things $TVER ($TBLD) / dbv $DBV / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"
note "crash reports at start: $(crashes)"

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
[ "$BOOTSTRAP" = "1" ] && { warm; note "warm-up done; app $(alive)"; }

# ---------------------------------------------------------------- primitives
tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL ORDER BY creationDate DESC LIMIT 1"; }
open_instance() { gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 AND status=0 ORDER BY startDate, creationDate LIMIT 1"; }
serieslist() { gt "SELECT substr(uuid,1,8) uuid, status, trashed, startDate, deadline, stopDate FROM TMTask WHERE rt1_repeatingTemplate='$1' ORDER BY creationDate"; }
instrow() { # instrow <uuid> -> "startDate|deadline|status"
  gq "SELECT startDate||'|'||coalesce(deadline,'null')||'|'||status FROM TMTask WHERE uuid='$1'"
}
dpk() { python3 - "$1" <<'PY'
import sys
v=int(sys.argv[1]) if sys.argv[1].lstrip('-').isdigit() else 0
print("%04d-%02d-%02d"%(v>>16,(v>>12)&0xF,(v>>7)&0x1F) if v else "None")
PY
}
instdates() { # instdates <uuid> -> "start=YYYY-MM-DD deadline=YYYY-MM-DD status=N"
  local raw; raw=$(instrow "$1")
  [ -n "$raw" ] || { echo "NO-ROW"; return; }
  local s="${raw%%|*}" rest="${raw#*|}"; local d="${rest%%|*}" st="${rest##*|}"
  echo "start=$(dpk "$s") deadline=$([ "$d" = "null" ] && echo None || dpk "$d") status=$st"
}
beep_reset() { lab_ssh "$IP" 'BEEP_MARKS=~/things-lab/run/beep-marks.tsv ~/labh/beep-sentinel.sh reset' </dev/null >/dev/null 2>&1; }
beep_mark()  { lab_ssh "$IP" "BEEP_MARKS=~/things-lab/run/beep-marks.tsv ~/labh/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }
beep_assert(){ lab_ssh "$IP" 'THINGS_LAB_BEEPS_OK=1 BEEP_MARKS=~/things-lab/run/beep-marks.tsv ~/labh/beep-sentinel.sh assert' </dev/null 2>&1 | sed 's/^/    beeps: /' | tee -a "$REPORT"; }

# drive <label> <title> <cli args...> — run the SHIPPED add-repeating verb.
drive() {
  local label="$1" title="$2"; shift 2
  beep_reset; beep_mark "$label"
  snap "${label}-before" "CNCAC2-%"
  note "  cmd: things todo add-repeating '$title' $*"
  lab_ssh "$IP" "$LAB_DIRECT $CLI todo add-repeating '$title' $* --dangerously-drive-gui --verify-timeout 90000; echo EXIT=\$?" \
    </dev/null >"$OUT/log/$label.out" 2>&1
  sed 's/^/    /' "$OUT/log/$label.out" | tee -a "$REPORT" >/dev/null
  note "  --- CLI output ($label) ---"; sed 's/^/    | /' "$OUT/log/$label.out" | tee -a "$REPORT"
  sleep 3
  snap "${label}-after" "CNCAC2-%"
  snapdiff "${label}-before" "${label}-after" "$label"
  beep_assert
}

# =============================================================== CELL REF
if has_cell REF; then
  cell "REF — the refusals that must SURVIVE the lift (zero mutation, no drive)"
  R1=$(lab_ssh "$IP" "$LAB_DIRECT $CLI todo add-repeating 'CNCAC2-REF1' --when someday --deadline 2026-07-08 --after-completion --frequency weekly --interval 1 --dangerously-drive-gui; echo EXIT=\$?" </dev/null 2>&1 | tail -4)
  note "  keyword --when + --deadline + --after-completion:"; echo "$R1" | sed 's/^/    | /' | tee -a "$REPORT"
  verdict "a keyword --when is still refused (needs a concrete date)" "concrete --when" "$R1"
  R2=$(lab_ssh "$IP" "$LAB_DIRECT $CLI todo add-repeating 'CNCAC2-REF2' --when 2026-07-05 --deadline 2026-07-08 --start-days-earlier 5 --after-completion --frequency weekly --interval 1 --dangerously-drive-gui; echo EXIT=\$?" </dev/null 2>&1 | tail -4)
  note "  --deadline disagreeing with --start-days-earlier:"; echo "$R2" | sed 's/^/    | /' | tee -a "$REPORT"
  verdict "a disagreeing deadline/offset pair is still refused" "disagree" "$R2"
  verdict_eq "REF cells created NOTHING" "0" "$(gq "SELECT count(*) FROM TMTask WHERE title LIKE 'CNCAC2-REF%'")"
fi

# =============================================================== CELL CTRL
if has_cell CTRL; then
  cell "CTRL — the POSITIVE CONTROL: the same shape, FIXED (no --after-completion)"
  drive CTRL CNCAC2-CTRL --when 2026-07-05 --deadline 2026-07-08 --frequency weekly --interval 1
  T=$(tmpl CNCAC2-CTRL); note "  template = ${T:-<none>}"
  RS=$(rsum "$T"); note "  rule: $RS"
  verdict "CLI exit 0" "EXIT=0" "$(cat "$OUT/log/CTRL.out")"
  verdict "the rule is FIXED (tp=0)" "tp=0" "$RS"
  verdict "the start offset landed (ts=-3)" "ts=-3" "$RS"
  verdict "the template carries the 4001 deadline sentinel" "tmplDeadline=4001-01-01" "$RS"
  I=$(open_instance "$T"); note "  occurrence $I: $(instdates "$I")"
  verdict "the occurrence starts on --when" "start=2026-07-05" "$(instdates "$I")"
  verdict "the occurrence is due --when + 3" "deadline=2026-07-08" "$(instdates "$I")"
fi

# =============================================================== CELL AC
if has_cell AC; then
  cell "AC — THE GUARD-LIFTED CELL: --after-completion with a concrete --deadline"
  drive AC CNCAC2-AC --when 2026-07-05 --deadline 2026-07-08 --after-completion --frequency weekly --interval 1
  TAC=$(tmpl CNCAC2-AC); note "  template = ${TAC:-<none>}"
  RS=$(rsum "$TAC"); note "  rule: $RS"
  note "  ---- the rule blob VERBATIM ----"; rblob "$TAC" | sed 's/^/    /' | tee -a "$REPORT"
  verdict "CLI exit 0" "EXIT=0" "$(cat "$OUT/log/AC.out")"
  verdict "the rule is AFTER-COMPLETION (tp=1)" "tp=1" "$RS"
  verdict "the cadence is weekly/1 (fu=256 fa=1)" "fu=256 fa=1" "$RS"
  verdict "the start offset landed on the RULE (ts=-3)" "ts=-3" "$RS"
  verdict "the template carries the 4001 deadline sentinel" "tmplDeadline=4001-01-01" "$RS"
  verdict "the template is born cursor-less (CNC1 §5 birth shape)" "next=None" "$RS"
  IAC=$(open_instance "$TAC"); note "  occurrence $IAC: $(instdates "$IAC")"
  verdict "the seed occurrence starts on --when" "start=2026-07-05" "$(instdates "$IAC")"
  verdict "the seed occurrence carries the DERIVED deadline" "deadline=2026-07-08" "$(instdates "$IAC")"
  verdict_eq "exactly ONE live occurrence (no double-book)" "1" "$(gq "SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$TAC' AND trashed=0")"
  note "  series rows:"; serieslist "$TAC" | sed 's/^/    /' | tee -a "$REPORT"
fi

# =============================================================== CELL SDE
if has_cell SDE; then
  cell "SDE — the same geometry named from the other end: --start-days-earlier 3"
  drive SDE CNCAC2-SDE --when 2026-07-05 --start-days-earlier 3 --after-completion --frequency weekly --interval 1
  TS=$(tmpl CNCAC2-SDE); note "  template = ${TS:-<none>}"
  RS=$(rsum "$TS"); note "  rule: $RS"
  verdict "CLI exit 0" "EXIT=0" "$(cat "$OUT/log/SDE.out")"
  verdict "the rule is AFTER-COMPLETION (tp=1)" "tp=1" "$RS"
  verdict "the start offset landed (ts=-3)" "ts=-3" "$RS"
  verdict "the template carries the 4001 deadline sentinel" "tmplDeadline=4001-01-01" "$RS"
  IS=$(open_instance "$TS"); note "  occurrence $IS: $(instdates "$IS")"
  verdict "the occurrence starts on --when" "start=2026-07-05" "$(instdates "$IS")"
  verdict "the occurrence is due --when + 3" "deadline=2026-07-08" "$(instdates "$IS")"
fi

# =============================================================== CELL MINT
if has_cell MINT; then
  cell "MINT — does the deadline RIDE the series? complete the seed, then CNC"
  TAC=$(tmpl CNCAC2-AC)
  if [ -z "$TAC" ]; then note "  SKIPPED — no CNCAC2-AC template (run the AC cell first)"; else
    IAC=$(open_instance "$TAC")
    snap MINT-before "CNCAC2-AC"
    note "  completing the seed occurrence $IAC (shipped verb, URL vector)"
    lab_ssh "$IP" "$LAB_DIRECT $CLI todo complete $IAC; echo EXIT=\$?" </dev/null >"$OUT/log/MINT-complete.out" 2>&1
    sed 's/^/    | /' "$OUT/log/MINT-complete.out" | tee -a "$REPORT"
    sleep 4
    snap MINT-completed "CNCAC2-AC"
    snapdiff MINT-before MINT-completed "complete the seed occurrence"
    RS=$(rsum "$TAC"); note "  rule after the completion: $RS"
    verdict "the completion ANCHORED the series (acRef = the completion day)" "acRef=2026-07-05" "$RS"
    verdict "the derived cursor is anchor + interval - ts (07-05 + 7 - 3)" "next=2026-07-09" "$RS"

    note "  driving Items > Repeat > Create Next Copy on the template"
    lab_ssh "$IP" "open -g 'things:///show?id=$TAC'; sleep 3" </dev/null
    lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
    SEL=$(axq 'tell application "Things3" to return id of selected to dos'); note "    selection = $SEL (want $TAC)"
    axq 'tell application "System Events" to tell process "Things3" to click menu item "Create Next Copy" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    cnc: /' | tee -a "$REPORT"
    lab_ssh "$IP" 'sleep 6' </dev/null
    snap MINT-cnc "CNCAC2-AC"
    snapdiff MINT-completed MINT-cnc "Create Next Copy"
    MI=$(open_instance "$TAC"); note "  minted occurrence $MI: $(instdates "$MI")"
    verdict "the mint lands on the derived cursor" "start=2026-07-09" "$(instdates "$MI")"
    verdict "the mint carries its OWN derived deadline (start + 3)" "deadline=2026-07-12" "$(instdates "$MI")"
    note "  series rows:"; serieslist "$TAC" | sed 's/^/    /' | tee -a "$REPORT"
  fi
fi

note ""
note "app $(alive); crash reports at end: $(crashes)"
note "=============================================="
note "CNCAC2: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
