#!/bin/bash
# CERTSWEEP1 — a CERTIFICATION-ONLY sweep: drive the SHIPPED CLI against a
# golden-v4 clone and close the queued guest-certification cells that landed
# simulator-covered only. NOTHING in src/ is changed by this campaign; a defect
# found here is REPORTED, never patched.
#
# CELLS
#   C1   `todo complete <series>` WITH an open materialized occurrence — the
#        existing occurrence is resolved, nothing is minted, the template is
#        byte-unchanged.
#   C2   `todo complete <series>` WITHOUT one — mint + complete + cursor advance
#        (the CNC1 §6 laws, through the composite this time).
#   C3   `todo cancel <series>` — the same shape, cancel arm.
#   C4   `todo update <series> --when <off-rule> --exception` — the REPX3 §1.2
#        template delta plus a moved occurrence.
#   R1   REFUSAL: an exception aimed at a LIVE SLOT of the same rule.
#   R2   REFUSAL: a cursor-less (paused) series, on both composites.
#   AC   `todo complete <after-completion series>` end to end — never driven.
#   RES  `resume-repeat` after a CNC'd pause (CNCAC1 §8 / oddities §19) — a
#        measurement cell: any outcome is the finding.
#   TS1  `project.dissolve-heading` — end-to-end certification (first drive
#        post-#589) AND the surviving-children `umd` cell (timestamps §2c).
#   TS2  `project.move-heading-to-project` — the heading `umd` cell (§2c).
#   P1   `project add-repeating --when <future date>` — the landed first
#        occurrence equals the requested date (ANCH2 next law, #549).
#   P1B  the blast radius of whatever P1 turns up: the same verb without a date,\n#        and the TO-DO twin with one.\n#   P2   `project make-repeating` on a DATED project — same assertion.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23 / dbv27; the
# golden is NEVER booted). Airgapped, clock pinned 2026-07-05 (a Sunday), NEVER
# rolled — no cell here needs a spawn, so the trial wall (2026-07-18) is never
# approached. Fixtures fully synthetic (CS1-*). DB oracle = FULL TMTask row
# snapshots diffed either side of every gesture. Repeating fixtures are built
# either through the shipped `make-repeating` (now that #597 landed the
# write-vector escape) or the REPX2/REPX3 dialog way, as each cell states.
#
# THE BEEP SENTINEL rides every gesture (BEEPSEN1): marks are reset per cell and
# the count is asserted at the end of it, in report-only mode — a research driver
# COUNTS beeps and reports them, it never silently swallows them.
#
# Usage: CELLS="C1 C4" VM=certsweep1-lab KEEP=1 lab/scripts/research-certsweep1.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-certsweep1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/ax" "$OUT/snap" "$OUT/log" "$OUT/beeps"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-C1 C2 C3 C4 R1 R2 AC RES TS1 TS2 P1 P1B P2}"
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[certsweep1] $*" | tee -a "$REPORT"; }
has_cell() { case " $CELLS " in *" $1 "*) return 0;; *) return 1;; esac; }

PASS=0; FAIL=0; BEEPS_TOTAL=0
cell() { note ""; note "========== $1 =========="; }
verdict() { # verdict <name> <expected-substring> <actual>
  if echo "$3" | grep -qF -- "$2"; then note "  PASS $1"; PASS=$((PASS+1));
  else note "  FAIL $1 — expected to contain '$2', got: $3"; FAIL=$((FAIL+1)); fi
}
verdict_not() {
  if echo "$3" | grep -qF -- "$2"; then note "  FAIL $1 — must NOT contain '$2', got: $3"; FAIL=$((FAIL+1));
  else note "  PASS $1"; PASS=$((PASS+1)); fi
}
verdict_eq() { # verdict_eq <name> <expected> <actual> — EXACT
  if [ "$(echo "$3" | tr -d '[:space:]')" = "$2" ]; then note "  PASS $1 (= $2)"; PASS=$((PASS+1));
  else note "  FAIL $1 — expected exactly '$2', got: '$3'"; FAIL=$((FAIL+1)); fi
}

# ---------------------------------------------------------------- clone + boot
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
  # THE 2-VM CEILING: another agent may hold the other slot. Refuse rather than
  # racing them for host resources.
  RUNNING=$(tart list 2>/dev/null | tail -n +2 | grep -v golden | grep -c running)
  note "preflight: $RUNNING non-golden VM(s) running"
  if [ "${RUNNING:-0}" -ge 2 ]; then
    note "FATAL: the 2-VM ceiling is already taken — $(tart list | grep running | tr '\n' ';')"
    exit 1
  fi
  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }
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
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (a Sunday; the clock is NEVER rolled)"
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

lab_ssh "$IP" 'cat > ~/labh/tjson.sh && chmod +x ~/labh/tjson.sh' <<'EOF'
#!/bin/bash
URL=$(python3 -c 'import sys,urllib.parse; print("things:///json?auth-token="+sys.argv[1]+"&data="+urllib.parse.quote(sys.argv[2],safe=""))' "$1" "$2")
open -g "$URL"
EOF

# rule summary (decodes rt1_recurrenceRule) — the RDLG2 / REPX1 / REPX3 helper
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib, hashlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, startDate, rt1_instanceCreationPaused, rt1_afterCompletionReferenceDate, reminderTime, userModificationDate FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
tail="next=%s icStart=%s icCount=%s paused=%s tmplDeadline=%s acRef=%s rem=%s umd=%s"%(
    dpk(row[1]),dpk(row[2]),row[3],row[6],dpk(row[4]),dpk(row[7]),row[8],row[9])
if row[0] is None:
    print("NO-RULE startDate=%s %s"%(dpk(row[5]),tail)); sys.exit(0)
blob=hashlib.sha256(row[0]).hexdigest()[:12]
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    bits=[]
    if 'wd' in o: bits.append("wd=%s(%s)"%(o['wd'], WD[o['wd']] if 0<=o['wd']<7 else "?"))
    for k in ('dy','mo','wdo'):
        if k in o: bits.append("%s=%s"%(k,o[k]))
    offs.append("{"+",".join(bits)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] blob=%s %s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),blob,tail))
EOF
rsum() {
  [ -n "${1:-}" ] || { echo "NO-UUID"; return; }
  lab_ssh "$IP" "python3 ~/labh/rsum.py $1" </dev/null 2>&1
}

# FULL-ROW snapshot: every TMTask column for the rows matching a title LIKE.
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
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }

# ---- THE BEEP SENTINEL (BEEPSEN1) -----------------------------------------
# Report-only: a research driver COUNTS beeps and prints every offending line,
# it never fails on them (harness.md §The beep sentinel, THINGS_LAB_BEEPS_OK).
beep_reset() { lab_ssh "$IP" 'bash ~/things-lab/beep-sentinel.sh reset' </dev/null >/dev/null 2>&1; }
beep_mark()  { lab_ssh "$IP" "bash ~/things-lab/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }
beep_count() { # beep_count <cellName>
  local n="$1" o c
  o=$(lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 bash ~/things-lab/beep-sentinel.sh assert --name $(printf '%q' "$n") --json ~/things-lab/run/beeps-$n.json" </dev/null 2>&1)
  echo "$o" | sed 's/^/  /' | tee -a "$REPORT"
  c=$(echo "$o" | grep -o '[0-9]\{1,\} alert beep(s)' | head -1 | grep -o '^[0-9]\{1,\}')
  [ -n "$c" ] || c=ORACLE-FAIL
  case "$c" in ''|*[!0-9]*) note "  BEEP ORACLE FAILED for $n"; ;; *) BEEPS_TOTAL=$((BEEPS_TOTAL+c)); BEEP_LINES="${BEEP_LINES:-}$n=$c ";; esac
  lab_ssh "$IP" "cat ~/things-lab/run/beeps-$n.json" </dev/null > "$OUT/beeps/$n.json" 2>/dev/null || true
}

# ---- ship the production bundle + the sentinel ------------------------------
if [ "$BOOTSTRAP" = "1" ]; then
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node ~/things-lab/beep-sentinel.sh' </dev/null
fi
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
# G  = a plain CLI call (no escape).  GD = both lab escapes (harness.md §escapes).
G()  { lab_ssh "$IP" "$CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
GD() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
CLIV=$(lab_ssh "$IP" "$CLI --version 2>&1 | tail -1" </dev/null)
case "$CLIV" in
  [0-9]*) note "guest CLI OK: things $CLIV" ;;
  *) note "FATAL: the guest CLI does not run — $CLIV"; exit 1 ;;
esac
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "shipped dist + beep sentinel; ui-enabled=true"

# POSITIVE CONTROL for the beep oracle (BEEP1: an oracle that cannot see a
# deliberate beep proves nothing about a drive). Three beeps must read 3.
beep_reset; beep_mark "oracle-positive-control"
lab_ssh "$IP" 'osascript -e beep -e beep -e beep; sleep 2' </dev/null >/dev/null 2>&1
BC=$(lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 bash ~/things-lab/beep-sentinel.sh assert --name oracle-ctrl" </dev/null 2>&1)
note "beep oracle control: $(echo "$BC" | head -1)"
verdict "beep oracle sees 3 deliberate beeps" "3 alert beep(s)" "$BC"

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" | grep -o '<integer>[0-9]*' | grep -o '[0-9]*')
note "env: Things $TVER ($TBLD) / dbv $DBV / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"
note "crash reports at start: $(crashes)"

# ---------------------------------------------------------------- primitives
tjson() { lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null; sleep 4; }
mktodo() {  # mktodo <title> [extra query] -> uuid
  lab_ssh "$IP" "open -g 'things:///add?title=$1${2:-}&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1"
}
tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1"; }
openinst() { # openinst <templateUuid> — the open materialized occurrence, if any
  gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 AND status=0 ORDER BY startDate, creationDate LIMIT 1"
}
newest_instance() { gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
serieslist() {
  gt "SELECT substr(uuid,1,8) uuid, status, trashed, startDate, stopDate, userModificationDate FROM TMTask WHERE rt1_repeatingTemplate='$1' ORDER BY creationDate"
}
umd() { gq "SELECT COALESCE(userModificationDate,'NULL') FROM TMTask WHERE uuid='$1'"; }

select_item() { # reveal + activate + verify the selection BY UUID (REPX3)
  local uuid="$1" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get id of selected to dos' 2>/dev/null)
    [ "$sel" = "$uuid" ] && { echo "$sel"; return 0; }
  done
  echo "$sel"; return 1
}
repeatmenu() {
  axq 'tell application "System Events" to tell process "Things3" to return name of every menu item of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1'
}
# Items ▸ Repeat ▸ Create Next Copy, driven directly (cell RES only — every other
# cell reaches CNC through the shipped composite, which is the point).
cnc_menu() {
  local sel; sel=$(select_item "$1")
  note "    selection = $sel  (want $1)"
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Create Next Copy" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    cnc: /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 6' </dev/null
}

# mkrepeat_dialog <uuid> <frequency> [interval] — the REPX2/REPX3 fixture path,
# kept as the FALLBACK for a shape `make-repeating` refuses.
mkrepeat_dialog() {
  local uuid="$1" freq="$2" iv="${3:-1}"
  select_item "$uuid" >/dev/null || note "    WARN: selection never confirmed for $uuid"
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  axq "tell application \"System Events\" to tell process \"Things3\"
    set sh to sheet 1 of (first window whose subrole is \"AXStandardWindow\")
    set p to pop up button 1 of sh
    repeat 20 times
      if (exists menu 1 of p) then exit repeat
      click p
      delay 0.3
    end repeat
    set nms to name of every menu item of menu 1 of p
    set hit to \"\"
    repeat with n in nms
      if hit is \"\" and ((n as text) contains \"$freq\") then set hit to (n as text)
    end repeat
    if hit is \"\" then
      key code 53
      return \"FREQ-NOT-FOUND wanted '$freq'; offered: \" & (nms as text)
    end if
    click menu item hit of menu 1 of p
    delay 1.5
    return \"frequency -> '\" & hit & \"'\"
  end tell" | sed 's/^/    /' | tee -a "$REPORT"
  if [ "$iv" != "1" ]; then
    axq "tell application \"System Events\" to tell process \"Things3\"
      set sh to sheet 1 of (first window whose subrole is \"AXStandardWindow\")
      set f to text field 1 of group 1 of sh
      set focused of f to true
      delay 0.3
      keystroke \"a\" using command down
      delay 0.2
      keystroke \"$iv\"
      delay 0.3
      key code 48
      delay 0.5
      return \"interval read back = \" & (value of f as text)
    end tell" | sed 's/^/    /' | tee -a "$REPORT"
  fi
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    click button "OK" of sh
    delay 2
    return "pressed OK"
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 7' </dev/null
}

# mkseries_dialog <TITLE> <when> <dialogFrequency> -> templateUuid
#
# The FIXED-rule fixtures are built the REPX2/REPX3/CNC1 way — a URL-scheme add
# plus a direct Repeat-dialog drive — DELIBERATELY, not because the shipped
# promote is unavailable (it is, since #597). The composites' expected values
# here are CNC1 §6 / REPX3 §1.2's, measured on a fixture of exactly this shape;
# `make-repeating` is promote-via-CLONE (a new row, the original trashed, a
# preserved future instance sometimes dropped), so a promote-built fixture would
# not be byte-comparable with the evidence being certified against.
mkseries_dialog() {
  local title="$1" when="$2" freq="$3"
  local u t
  u=$(mktodo "$title" "&when=$when")
  note "  seed $title = $u" >&2
  mkrepeat_dialog "$u" "$freq" 1 >&2
  t=$(tmpl "$title")
  [ -n "$t" ] || note "  RIG FAILURE: no template minted for $title" >&2
  echo "$t"
}

# mkseries_ac <TITLE> <when> -> templateUuid
#
# The AFTER-COMPLETION fixture, through the SHIPPED promote first (the queued
# question: does validation refuse a plain `--after-completion` promote, or only
# the deadline COMBINATION of CNCAC1 §9.1?). Records the refusal verbatim and
# falls back to the REPX2 dialog way, which is how CNCAC1 built the same shape.
AC_FIXTURE_PATH=""
mkseries_ac() {
  local title="$1" when="$2"
  local u t o
  u=$(mktodo "$title" "&when=$when")
  note "  seed $title = $u" >&2
  o=$(GD todo make-repeating "$u" --frequency weekly --interval 1 --after-completion --dangerously-drive-gui --json)
  echo "$o" > "$OUT/log/mk-$title.log"
  note "  make-repeating --after-completion: $(echo "$o" | tail -2 | tr '\n' ' ' | cut -c1-300)" >&2
  t=$(tmpl "$title")
  if [ -n "$t" ]; then
    echo "shipped make-repeating --after-completion" > "$OUT/ac-fixture-path.txt"
  else
    note "  >>> the SHIPPED --after-completion promote did not mint a template — falling back to the REPX2 dialog path (standing refusal REPORTED, not lifted)" >&2
    echo "REPX2 dialog fallback (shipped promote refused)" > "$OUT/ac-fixture-path.txt"
    u=$(gq "SELECT uuid FROM TMTask WHERE title='$title' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1")
    [ -n "$u" ] || u=$(mktodo "$title" "&when=$when")
    mkrepeat_dialog "$u" "after completion" 1 >&2
    t=$(tmpl "$title")
  fi
  [ -n "$t" ] || note "  RIG FAILURE: no after-completion template minted for $title" >&2
  echo "$t"
}
need() { [ -n "${1:-}" ] && return 0; note "FATAL: the $2 fixture did not mint — aborting"; exit 1; }

[ "$BOOTSTRAP" = "1" ] && warm

# ============================================================ C1 — complete, open occurrence
if has_cell C1; then
  cell "C1 — \`todo complete <series>\` WITH an open materialized occurrence"
  beep_reset; beep_mark "C1 fixture"
  T=$(mkseries_dialog CS1-C1-OPEN 2026-07-05 weekly); need "$T" C1
  note "  template=$T rule: $(rsum "$T")"
  OI=$(openinst "$T"); note "  open materialized occurrence = $OI ($(gq "SELECT startDate FROM TMTask WHERE uuid='$OI'"))"
  verdict_eq "C1 the fixture HAS exactly one open occurrence" "1" "$(gq "SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$T' AND trashed=0 AND status=0")"
  snap c1-0 'CS1-C1-OPEN'
  RB=$(rsum "$T")
  beep_mark "C1 gesture: todo complete <series>"
  O=$(G todo complete "$T" --json); echo "$O" > "$OUT/log/c1.log"
  note "  $(echo "$O" | tail -2)"
  snap c1-1 'CS1-C1-OPEN'; snapdiff c1-0 c1-1 "C1 — complete the series"
  RA=$(rsum "$T")
  note "  rule before: $RB"
  note "  rule after : $RA"
  verdict "C1 exit 0" "EXIT=0" "$O"
  verdict "C1 nothing was minted" '"minted":false' "$O"
  verdict "C1 the occurrence named is the pre-existing one" "\"occurrenceUuid\":\"$OI\"" "$O"
  verdict "C1 the template is named as the series" "\"templateUuid\":\"$T\"" "$O"
  verdict_eq "C1 the template row is BYTE-UNCHANGED" "$(echo "$RB" | tr -d '[:space:]')" "$RA"
  verdict_eq "C1 the occurrence is completed" "3" "$(gq "SELECT status FROM TMTask WHERE uuid='$OI'")"
  note "  series:"; serieslist "$T" | sed 's/^/    /' | tee -a "$REPORT"
  beep_count C1
fi

# ============================================================ C2 — complete, mint
if has_cell C2; then
  cell "C2 — \`todo complete <series>\` WITHOUT an open occurrence (mint + complete + advance)"
  beep_reset; beep_mark "C2 fixture"
  T=$(mkseries_dialog CS1-C2-MINT 2026-07-05 weekly); need "$T" C2
  SEED=$(openinst "$T"); note "  seed occurrence = $SEED"
  O=$(G todo complete "$SEED" --json); note "  seed resolved directly: $(echo "$O" | tail -1 | cut -c1-160)"
  verdict_eq "C2 the fixture now has NO open occurrence" "" "$(openinst "$T")"
  snap c2-0 'CS1-C2-MINT'
  RB=$(rsum "$T"); note "  rule before: $RB"
  beep_mark "C2 gesture: todo complete <series>"
  O=$(GD todo complete "$T" --json); echo "$O" > "$OUT/log/c2.log"
  note "  $(echo "$O" | tail -2)"
  snap c2-1 'CS1-C2-MINT'; snapdiff c2-0 c2-1 "C2 — complete the series (mint arm)"
  RA=$(rsum "$T"); note "  rule after : $RA"
  MU=$(echo "$O" | grep -o '"occurrenceUuid":"[^"]*"' | head -1 | cut -d'"' -f4)
  note "  occurrence named by the result = $MU"
  verdict "C2 exit 0" "EXIT=0" "$O"
  verdict "C2 the occurrence WAS minted" '"minted":true' "$O"
  verdict "C2 the result dates the occurrence at the cursor" '"date":"2026-07-12"' "$O"
  verdict "C2 cursor advances to the next rule date" "next=2026-07-19" "$RA"
  verdict "C2 watermark advances to consumed slot + 1" "icStart=2026-07-13" "$RA"
  verdict "C2 icCount 1 -> 2" "icCount=2" "$RA"
  verdict_eq "C2 the minted occurrence is completed" "3" "$(gq "SELECT status FROM TMTask WHERE uuid='$MU'")"
  verdict_eq "C2 the template umd did NOT move" "$(echo "$RB" | grep -o 'umd=[^ ]*')" "$(echo "$RA" | grep -o 'umd=[^ ]*')"
  verdict_eq "C2 the rule blob is byte-untouched" "$(echo "$RB" | grep -o 'blob=[^ ]*')" "$(echo "$RA" | grep -o 'blob=[^ ]*')"
  note "  series:"; serieslist "$T" | sed 's/^/    /' | tee -a "$REPORT"
  beep_count C2
fi

# ============================================================ C3 — cancel
if has_cell C3; then
  cell "C3 — \`todo cancel <series>\` (the cancel arm of the same composite)"
  beep_reset; beep_mark "C3 fixture"
  T=$(mkseries_dialog CS1-C3-CANX 2026-07-05 weekly); need "$T" C3
  SEED=$(openinst "$T")
  G todo complete "$SEED" --json >/dev/null
  snap c3-0 'CS1-C3-CANX'
  RB=$(rsum "$T"); note "  rule before: $RB"
  beep_mark "C3 gesture: todo cancel <series>"
  O=$(GD todo cancel "$T" --json); echo "$O" > "$OUT/log/c3.log"
  note "  $(echo "$O" | tail -2)"
  snap c3-1 'CS1-C3-CANX'; snapdiff c3-0 c3-1 "C3 — cancel the series"
  RA=$(rsum "$T"); note "  rule after : $RA"
  MU=$(echo "$O" | grep -o '"occurrenceUuid":"[^"]*"' | head -1 | cut -d'"' -f4)
  verdict "C3 exit 0" "EXIT=0" "$O"
  verdict "C3 the occurrence WAS minted" '"minted":true' "$O"
  verdict "C3 cursor advances to the next rule date" "next=2026-07-19" "$RA"
  verdict "C3 icCount 1 -> 2" "icCount=2" "$RA"
  verdict_eq "C3 the minted occurrence is CANCELED (status 2)" "2" "$(gq "SELECT status FROM TMTask WHERE uuid='$MU'")"
  verdict_eq "C3 the rule blob is byte-untouched" "$(echo "$RB" | grep -o 'blob=[^ ]*')" "$(echo "$RA" | grep -o 'blob=[^ ]*')"
  note "  series:"; serieslist "$T" | sed 's/^/    /' | tee -a "$REPORT"
  beep_count C3
fi

# ============================================================ C4 — exception
if has_cell C4; then
  cell "C4 — \`todo update <series> --when 2026-07-15 --exception\` (REPX3 §1.2)"
  beep_reset; beep_mark "C4 fixture"
  T=$(mkseries_dialog CS1-C4-EXC 2026-07-05 weekly); need "$T" C4
  snap c4-0 'CS1-C4-EXC'
  RB=$(rsum "$T"); note "  rule before: $RB"
  beep_mark "C4 gesture: todo update --exception"
  O=$(GD todo update "$T" --when 2026-07-15 --exception --json); echo "$O" > "$OUT/log/c4.log"
  note "  $(echo "$O" | tail -2)"
  snap c4-1 'CS1-C4-EXC'; snapdiff c4-0 c4-1 "C4 — the exception"
  RA=$(rsum "$T"); note "  rule after : $RA"
  MU=$(echo "$O" | grep -o '"occurrenceUuid":"[^"]*"' | head -1 | cut -d'"' -f4)
  verdict "C4 exit 0" "EXIT=0" "$O"
  verdict "C4 the exception always mints" '"minted":true' "$O"
  verdict "C4 cursor -> the next RULE date (07-19), not the chosen day" "next=2026-07-19" "$RA"
  verdict "C4 watermark -> consumed slot + 1 (07-13)" "icStart=2026-07-13" "$RA"
  verdict "C4 icCount 1 -> 2" "icCount=2" "$RA"
  verdict_eq "C4 the moved occurrence sits on the CHOSEN day" "1" \
    "$(gq "SELECT count(*) FROM TMTask WHERE uuid='$MU' AND (startDate>>16)=2026 AND ((startDate>>12)&15)=7 AND ((startDate>>7)&31)=15")"
  verdict_eq "C4 the template umd did NOT move" "$(echo "$RB" | grep -o 'umd=[^ ]*')" "$(echo "$RA" | grep -o 'umd=[^ ]*')"
  verdict_eq "C4 the rule blob is byte-untouched" "$(echo "$RB" | grep -o 'blob=[^ ]*')" "$(echo "$RA" | grep -o 'blob=[^ ]*')"
  note "  series:"; serieslist "$T" | sed 's/^/    /' | tee -a "$REPORT"
  beep_count C4
fi

# ============================================================ R1 — live-slot refusal
if has_cell R1; then
  cell "R1 — REFUSAL: an exception aimed at a LIVE SLOT of the same rule"
  beep_reset; beep_mark "R1 fixture"
  T=$(mkseries_dialog CS1-R1-SLOT 2026-07-05 weekly); need "$T" R1
  snap r1-0 'CS1-R1-SLOT'
  RB=$(rsum "$T"); note "  rule before: $RB  (cursor 07-12; 07-19 is the NEXT live slot)"
  beep_mark "R1 gesture: exception onto 2026-07-19"
  O=$(G todo update "$T" --when 2026-07-19 --exception --json); echo "$O" > "$OUT/log/r1.log"
  note "  $(echo "$O" | tail -2)"
  snap r1-1 'CS1-R1-SLOT'; snapdiff r1-0 r1-1 "R1 — after the refused exception"
  RA=$(rsum "$T")
  verdict "R1 the drive is REFUSED, exit 4" "EXIT=4" "$O"
  verdict "R1 the refusal names the collision" "already lands on 2026-07-19" "$O"
  verdict_eq "R1 ZERO mutation — the template is byte-unchanged" "$(echo "$RB" | tr -d '[:space:]')" "$RA"
  verdict_eq "R1 no occurrence was minted" "1" "$(gq "SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$T' AND trashed=0")"
  beep_count R1
fi

# ============================================================ R2 — cursor-less refusal
if has_cell R2; then
  cell "R2 — REFUSAL: a cursor-less (PAUSED) series, on both composites"
  beep_reset; beep_mark "R2 fixture"
  T=$(mkseries_dialog CS1-R2-PAUSE 2026-07-05 weekly); need "$T" R2
  SEED=$(openinst "$T")
  G todo complete "$SEED" --json >/dev/null
  beep_mark "R2 pause-repeat"
  O=$(GD todo pause-repeat "$T" --dangerously-drive-gui --json); echo "$O" > "$OUT/log/r2-pause.log"
  note "  pause: $(echo "$O" | tail -1 | cut -c1-180)"
  RB=$(rsum "$T"); note "  rule after the pause: $RB"
  verdict "R2 the pause landed" "paused=1" "$RB"
  verdict "R2 the pause CLEARED the cursor" "next=None" "$RB"
  snap r2-0 'CS1-R2-PAUSE'

  beep_mark "R2 gesture: todo complete <paused series>"
  O=$(G todo complete "$T" --json); echo "$O" > "$OUT/log/r2-complete.log"
  note "  complete: $(echo "$O" | tail -2)"
  verdict "R2 complete is REFUSED, exit 4" "EXIT=4" "$O"
  verdict "R2 the refusal says the series is paused" "is paused" "$O"
  verdict "R2 the refusal names resume-repeat" "resume-repeat" "$O"

  beep_mark "R2 gesture: todo update --exception <paused series>"
  O=$(G todo update "$T" --when 2026-07-15 --exception --json); echo "$O" > "$OUT/log/r2-exception.log"
  note "  exception: $(echo "$O" | tail -2)"
  verdict "R2 the exception is REFUSED, exit 4" "EXIT=4" "$O"
  verdict "R2 the exception refusal names resume-repeat" "resume-repeat" "$O"

  snap r2-1 'CS1-R2-PAUSE'; snapdiff r2-0 r2-1 "R2 — after BOTH refusals"
  RA=$(rsum "$T")
  verdict_eq "R2 ZERO mutation across both refusals" "$(echo "$RB" | tr -d '[:space:]')" "$RA"
  beep_count R2
fi

# ============================================================ AC — after-completion
if has_cell AC; then
  cell "AC — \`todo complete <after-completion series>\` end to end (never driven)"
  beep_reset; beep_mark "AC fixture"
  # The shipped promote FIRST — the queued question is whether validation refuses
  # a plain --after-completion promote (CNCAC1 §9.1 refuses only the deadline
  # COMBINATION). mkseries_ac records the refusal and falls back to the dialog.
  T=$(mkseries_ac CS1-AC 2026-07-05); need "$T" AC
  note "  fixture path: $(cat "$OUT/ac-fixture-path.txt" 2>/dev/null)"
  note "  template=$T rule at birth: $(rsum "$T")"
  SEED=$(openinst "$T"); note "  seed occurrence = $SEED"
  beep_mark "AC anchor the series (complete the seed occurrence)"
  O=$(G todo complete "$SEED" --json); note "  anchored: $(echo "$O" | tail -1 | cut -c1-160)"
  RB=$(rsum "$T"); note "  rule with history: $RB"
  verdict "AC the completed history gave the series a cursor" "next=2026-07-12" "$RB"
  verdict "AC the completion anchored the series" "acRef=2026-07-05" "$RB"
  verdict_eq "AC there is NO open occurrence (the composite must mint)" "" "$(openinst "$T")"
  snap ac-0 'CS1-AC'
  beep_mark "AC gesture: todo complete <after-completion series>"
  O=$(GD todo complete "$T" --json); echo "$O" > "$OUT/log/ac.log"
  note "  $(echo "$O" | tail -3)"
  snap ac-1 'CS1-AC'; snapdiff ac-0 ac-1 "AC — complete the after-completion series"
  RA=$(rsum "$T"); note "  rule after : $RA"
  MU=$(echo "$O" | grep -o '"occurrenceUuid":"[^"]*"' | head -1 | cut -d'"' -f4)
  verdict "AC exit 0" "EXIT=0" "$O"
  verdict "AC the occurrence WAS minted" '"minted":true' "$O"
  verdict "AC the disclosure names the from-completion semantics" "counts from each completion" "$O"
  verdict_eq "AC the minted occurrence is completed" "3" "$(gq "SELECT status FROM TMTask WHERE uuid='$MU'")"
  note "  series:"; serieslist "$T" | sed 's/^/    /' | tee -a "$REPORT"
  note "  app: $(alive); crash reports: $(crashes)"
  beep_count AC
fi

# ============================================================ RES — resume after a CNC'd pause
if has_cell RES; then
  cell "RES — \`resume-repeat\` after a CNC'd pause (CNCAC1 §8 / oddities §19). MEASUREMENT cell."
  beep_reset; beep_mark "RES fixture"
  T=$(mkseries_ac CS1-RES 2026-07-05); need "$T" RES
  SEED=$(openinst "$T")
  G todo complete "$SEED" --json >/dev/null
  note "  with history: $(rsum "$T")"
  beep_mark "RES pause-repeat"
  O=$(GD todo pause-repeat "$T" --dangerously-drive-gui --json); note "  pause: $(echo "$O" | tail -1 | cut -c1-160)"
  R1S=$(rsum "$T"); note "  after pause : $R1S"
  snap res-0 'CS1-RES'
  note "  Items ▸ Repeat on the paused template: $(repeatmenu)"
  beep_mark "RES Items > Repeat > Create Next Copy on a PAUSED series"
  cnc_menu "$T"
  snap res-1 'CS1-RES'; snapdiff res-0 res-1 "RES — CNC on the paused series"
  R2S=$(rsum "$T"); note "  after CNC   : $R2S"
  verdict "RES the CNC cleared the anchor (oddities §19)" "acRef=None" "$R2S"
  verdict "RES the series is still flagged paused" "paused=1" "$R2S"
  verdict "RES it has neither anchor nor cursor" "next=None" "$R2S"
  beep_mark "RES gesture: todo resume-repeat"
  O=$(GD todo resume-repeat "$T" --dangerously-drive-gui --json); echo "$O" > "$OUT/log/res.log"
  note "  $(echo "$O" | tail -3)"
  snap res-2 'CS1-RES'; snapdiff res-1 res-2 "RES — resume-repeat from the anchorless paused state"
  R3S=$(rsum "$T"); note "  after resume: $R3S"
  note "  VERDICT (measurement): the resumed state is >>> $R3S <<<"
  note "  series:"; serieslist "$T" | sed 's/^/    /' | tee -a "$REPORT"
  note "  app: $(alive); crash reports: $(crashes)"
  beep_count RES
fi

# ============================================================ TS1 — dissolve-heading
if has_cell TS1; then
  cell "TS1 — \`project dissolve-heading\` end-to-end certification + the surviving-children umd cell"
  beep_reset; beep_mark "TS1 fixture"
  tjson '[{"type":"project","attributes":{"title":"CS1-DISS-PROJ","items":[{"type":"heading","attributes":{"title":"CS1-DISS-HEAD"}},{"type":"to-do","attributes":{"title":"CS1-DISS-K1"}},{"type":"to-do","attributes":{"title":"CS1-DISS-K2"}},{"type":"to-do","attributes":{"title":"CS1-DISS-K3"}}]}}]'
  PJ=$(gq "SELECT uuid FROM TMTask WHERE title='CS1-DISS-PROJ' AND type=1 AND trashed=0 LIMIT 1")
  HD=$(gq "SELECT uuid FROM TMTask WHERE title='CS1-DISS-HEAD' AND type=2 AND trashed=0 LIMIT 1")
  note "  project=$PJ heading=$HD"
  need "$PJ" TS1; need "$HD" TS1
  note "  --- BEFORE ---"
  gt "SELECT title, substr(uuid,1,8) u, type, status, trashed, \"index\", COALESCE(substr(project,1,8),'-') proj, COALESCE(substr(heading,1,8),'-') head, COALESCE(userModificationDate,'NULL') umd FROM TMTask WHERE title LIKE 'CS1-DISS-%' ORDER BY type DESC, \"index\"" | sed 's/^/    /' | tee -a "$REPORT"
  K1=$(gq "SELECT uuid FROM TMTask WHERE title='CS1-DISS-K1' LIMIT 1")
  K2=$(gq "SELECT uuid FROM TMTask WHERE title='CS1-DISS-K2' LIMIT 1")
  K3=$(gq "SELECT uuid FROM TMTask WHERE title='CS1-DISS-K3' LIMIT 1")
  U1B=$(umd "$K1"); U2B=$(umd "$K2"); U3B=$(umd "$K3")
  note "  child umd BEFORE: K1=$U1B K2=$U2B K3=$U3B"
  ORDB=$(gq "SELECT group_concat(title,',') FROM (SELECT title FROM TMTask WHERE title LIKE 'CS1-DISS-K%' AND trashed=0 ORDER BY \"index\")")
  note "  child order BEFORE (by index): $ORDB"
  snap ts1-0 'CS1-DISS-%'
  beep_mark "TS1 gesture: project dissolve-heading"
  O=$(GD project dissolve-heading "$PJ" "$HD" --dangerously-drive-gui --json); echo "$O" > "$OUT/log/ts1.log"
  note "  $(echo "$O" | tail -3)"
  snap ts1-1 'CS1-DISS-%'; snapdiff ts1-0 ts1-1 "TS1 — dissolve-heading"
  note "  --- AFTER ---"
  gt "SELECT title, substr(uuid,1,8) u, type, status, trashed, \"index\", COALESCE(substr(project,1,8),'-') proj, COALESCE(substr(heading,1,8),'-') head, COALESCE(userModificationDate,'NULL') umd FROM TMTask WHERE title LIKE 'CS1-DISS-%' ORDER BY type DESC, \"index\"" | sed 's/^/    /' | tee -a "$REPORT"
  U1A=$(umd "$K1"); U2A=$(umd "$K2"); U3A=$(umd "$K3")
  note "  child umd AFTER : K1=$U1A K2=$U2A K3=$U3A"
  ORDA=$(gq "SELECT group_concat(title,',') FROM (SELECT title FROM TMTask WHERE title LIKE 'CS1-DISS-K%' AND trashed=0 ORDER BY \"index\")")
  note "  child order AFTER (by index): $ORDA"
  verdict "TS1 exit 0" "EXIT=0" "$O"
  verdict_eq "TS1 the heading is GONE (untrashed count 0)" "0" "$(gq "SELECT count(*) FROM TMTask WHERE uuid='$HD' AND trashed=0")"
  verdict_eq "TS1 all three children survive untrashed" "3" "$(gq "SELECT count(*) FROM TMTask WHERE title LIKE 'CS1-DISS-K%' AND trashed=0")"
  verdict_eq "TS1 the children re-parent to the project" "3" "$(gq "SELECT count(*) FROM TMTask WHERE title LIKE 'CS1-DISS-K%' AND trashed=0 AND project='$PJ'")"
  verdict_eq "TS1 no child still points at the heading" "0" "$(gq "SELECT count(*) FROM TMTask WHERE title LIKE 'CS1-DISS-K%' AND heading='$HD'")"
  verdict_eq "TS1 the children's ORDER is preserved" "$ORDB" "$ORDA"
  note "  >>> UMD CELL (timestamps §2c): K1 $U1B -> $U1A"
  note "  >>>                            K2 $U2B -> $U2A"
  note "  >>>                            K3 $U3B -> $U3A"
  if [ "$U1B" = "$U1A" ] && [ "$U2B" = "$U2A" ] && [ "$U3B" = "$U3A" ]; then
    note "  >>> VERDICT: dissolve-heading is umd-SILENT on the surviving children (the reparent-bump law's prediction is FALSIFIED)"
  else
    note "  >>> VERDICT: dissolve-heading BUMPS the surviving children's umd (the reparent-bump law's prediction HOLDS)"
  fi
  beep_count TS1
fi

# ============================================================ TS2 — move-heading-to-project umd
if has_cell TS2; then
  cell "TS2 — \`project move-heading-to-project\` heading umd (timestamps §2c)"
  beep_reset; beep_mark "TS2 fixture"
  tjson '[{"type":"project","attributes":{"title":"CS1-MHP-SRC","items":[{"type":"heading","attributes":{"title":"CS1-MHP-HEAD"}},{"type":"to-do","attributes":{"title":"CS1-MHP-CHILD"}}]}}]'
  tjson '[{"type":"project","attributes":{"title":"CS1-MHP-DEST","items":[]}}]'
  PS=$(gq "SELECT uuid FROM TMTask WHERE title='CS1-MHP-SRC' AND type=1 AND trashed=0 LIMIT 1")
  PD=$(gq "SELECT uuid FROM TMTask WHERE title='CS1-MHP-DEST' AND type=1 AND trashed=0 LIMIT 1")
  HH=$(gq "SELECT uuid FROM TMTask WHERE title='CS1-MHP-HEAD' AND type=2 AND trashed=0 LIMIT 1")
  CH=$(gq "SELECT uuid FROM TMTask WHERE title='CS1-MHP-CHILD' AND trashed=0 LIMIT 1")
  note "  src=$PS dest=$PD heading=$HH child=$CH"
  need "$PS" TS2; need "$PD" TS2; need "$HH" TS2
  HB=$(umd "$HH"); CB=$(umd "$CH")
  note "  heading umd BEFORE: $HB    child umd BEFORE: $CB"
  note "  heading project BEFORE: $(gq "SELECT COALESCE(substr(project,1,8),'-') FROM TMTask WHERE uuid='$HH'")"
  snap ts2-0 'CS1-MHP-%'
  beep_mark "TS2 gesture: project move-heading-to-project"
  O=$(GD project move-heading-to-project "$PS" "$HH" --to "$PD" --dangerously-drive-gui --json); echo "$O" > "$OUT/log/ts2.log"
  note "  $(echo "$O" | tail -3)"
  snap ts2-1 'CS1-MHP-%'; snapdiff ts2-0 ts2-1 "TS2 — move-heading-to-project"
  HA=$(umd "$HH"); CA=$(umd "$CH")
  note "  heading umd AFTER : $HA    child umd AFTER : $CA"
  verdict "TS2 exit 0" "EXIT=0" "$O"
  verdict_eq "TS2 the heading landed in the destination project" "$PD" "$(gq "SELECT COALESCE(project,'-') FROM TMTask WHERE uuid='$HH'")"
  verdict_eq "TS2 the child follows via the heading FK" "1" "$(gq "SELECT count(*) FROM TMTask WHERE uuid='$CH' AND heading='$HH'")"
  note "  >>> UMD CELL (timestamps §2c): heading $HB -> $HA"
  if [ "$HB" = "$HA" ]; then
    note "  >>> VERDICT: move-heading-to-project is umd-SILENT on the heading (prediction FALSIFIED)"
  else
    note "  >>> VERDICT: move-heading-to-project BUMPS the heading's umd (prediction HOLDS)"
  fi
  beep_count TS2
fi

# ============================================================ P1 — project add-repeating --when
if has_cell P1; then
  cell "P1 — \`project add-repeating --when 2026-07-10\` lands its FIRST occurrence on the requested date"
  beep_reset; beep_mark "P1 gesture: project add-repeating --when"
  O=$(GD project add-repeating CS1-P1-ADD --when 2026-07-10 --frequency weekly --interval 1 --dangerously-drive-gui --json)
  echo "$O" > "$OUT/log/p1.log"
  note "  $(echo "$O" | tail -3)"
  T=$(gq "SELECT uuid FROM TMTask WHERE title='CS1-P1-ADD' AND type=1 AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  note "  project template = $T"
  note "  rule: $(rsum "$T")"
  note "  series rows:"
  gt "SELECT substr(uuid,1,8) u, type, status, trashed, startDate, COALESCE(substr(rt1_repeatingTemplate,1,8),'-') tmpl FROM TMTask WHERE title='CS1-P1-ADD' ORDER BY creationDate" | sed 's/^/    /' | tee -a "$REPORT"
  verdict "P1 exit 0" "EXIT=0" "$O"
  verdict_not "P1 no silent-noop verify failure" "verify-failed" "$O"
  R=$(rsum "$T")
  verdict "P1 the first occurrence is the REQUESTED date (cursor 2026-07-10)" "next=2026-07-10" "$R"
  note "  (informational) watermark: $(echo "$R" | grep -o 'icStart=[^ ]*')"
  beep_count P1
fi

# ============================================================ P1B — the blast radius of the P1 usage error
if has_cell P1B; then
  cell "P1B — is the P1 refusal keyed on \`--when\`? The same verb WITHOUT a date, and the to-do twin WITH one"
  beep_reset; beep_mark "P1B project add-repeating with NO --when"
  O=$(GD project add-repeating CS1-P1B-NODATE --frequency weekly --interval 1 --dangerously-drive-gui --json)
  echo "$O" > "$OUT/log/p1b-project-nowhen.log"
  note "  project add-repeating (no --when): $(echo "$O" | tail -2 | tr '\n' ' ' | cut -c1-300)"
  verdict "P1B the SAME verb succeeds with no --when" "EXIT=0" "$O"
  note "  rule: $(rsum "$(gq "SELECT uuid FROM TMTask WHERE title='CS1-P1B-NODATE' AND type=1 AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1")")"

  beep_mark "P1B todo add-repeating WITH --when"
  O=$(GD todo add-repeating CS1-P1B-TODO --when 2026-07-10 --frequency weekly --interval 1 --dangerously-drive-gui --json)
  echo "$O" > "$OUT/log/p1b-todo-when.log"
  note "  todo add-repeating --when: $(echo "$O" | tail -2 | tr '\n' ' ' | cut -c1-300)"
  note "  >>> the to-do twin of the P1 defect: $(echo "$O" | grep -o '"code":"[^"]*"' | head -1) $(echo "$O" | grep -o 'params.next[^"]*' | head -1)"
  verdict "P1B the to-do verb reproduces the same usage error (SAME defect, both verbs)" "params.next" "$O"
  verdict_eq "P1B nothing was created by the refused to-do call" "0" "$(gq "SELECT count(*) FROM TMTask WHERE title='CS1-P1B-TODO'")"

  beep_mark "P1B todo add-repeating with NO --when"
  O=$(GD todo add-repeating CS1-P1B-TODO2 --frequency weekly --interval 1 --dangerously-drive-gui --json)
  echo "$O" > "$OUT/log/p1b-todo-nowhen.log"
  note "  todo add-repeating (no --when): $(echo "$O" | tail -2 | tr '\n' ' ' | cut -c1-300)"
  verdict "P1B the to-do verb succeeds with no --when" "EXIT=0" "$O"
  beep_count P1B
fi

# ============================================================ P2 — project make-repeating on a dated project
if has_cell P2; then
  cell "P2 — \`project make-repeating\` on a DATED project lands its first occurrence on that date"
  beep_reset; beep_mark "P2 fixture"
  lab_ssh "$IP" "open -g 'things:///add-project?title=CS1-P2-MAKE&when=2026-07-14&auth-token=$TOKEN'; sleep 5" </dev/null
  PJ=$(gq "SELECT uuid FROM TMTask WHERE title='CS1-P2-MAKE' AND type=1 AND trashed=0 LIMIT 1")
  note "  seed project = $PJ  startDate=$(gq "SELECT startDate FROM TMTask WHERE uuid='$PJ'")"
  need "$PJ" P2
  beep_mark "P2 gesture: project make-repeating"
  O=$(GD project make-repeating "$PJ" --frequency weekly --interval 1 --dangerously-drive-gui --json)
  echo "$O" > "$OUT/log/p2.log"
  note "  $(echo "$O" | tail -3)"
  T=$(gq "SELECT uuid FROM TMTask WHERE title='CS1-P2-MAKE' AND type=1 AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  note "  project template = $T"
  note "  series rows:"
  gt "SELECT substr(uuid,1,8) u, type, status, trashed, startDate, COALESCE(substr(rt1_repeatingTemplate,1,8),'-') tmpl FROM TMTask WHERE title='CS1-P2-MAKE' ORDER BY creationDate" | sed 's/^/    /' | tee -a "$REPORT"
  R=$(rsum "$T"); note "  rule: $R"
  verdict "P2 exit 0" "EXIT=0" "$O"
  verdict_not "P2 no silent-noop verify failure" "verify-failed" "$O"
  verdict "P2 the first occurrence is the project's own date (cursor 2026-07-14)" "next=2026-07-14" "$R"
  note "  (informational) watermark: $(echo "$R" | grep -o 'icStart=[^ ]*')"
  beep_count P2
fi

note ""
note "================= SUMMARY: $PASS pass / $FAIL fail ================="
note "BEEPS: total $BEEPS_TOTAL — per cell: ${BEEP_LINES:-(none)}"
note "app: $(alive); crash reports: $(crashes)"
note "artifacts in $OUT"
