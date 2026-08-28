#!/bin/bash
# REANCH2 — `deadline=` on a repeating TEMPLATE via the URL scheme, and a
# re-verification of REANCH1's reminder + bare-`when=` laws in one cell.
#
# REANCH1 (docs/lab/reanch1-url-reanchor.md) measured that a STRICTLY-FUTURE
# dated `when=` on a repeating template re-anchors the whole series on Things
# 3.23 — five columns plus the rule blob's own anchor — and that the `@<time>`
# component writes a rule-level reminder every later spawn inherits. It left two
# questions open that a build on that path has to answer first:
#
#   (a) does `deadline=<date>` on a template behave the same way — accepted,
#       crash, or silent no-op — and does it disturb the rule's own deadline mode
#       (the year-4001 sentinel + `ts` start offset, REANCH1 §7)?
#   (b) the `@<time>` reminder: re-verify the SET path on this clone.
#
# Cells (ONE clone, clock PINNED 2026-07-05 12:00 — nothing is rolled, so the
# golden-v4 trial wall of 2026-07-18 is never approached):
#
#   S   setup — mint the synthetic REANCH2-* fixtures
#   P   POSITIVE CONTROL — `update?deadline=<date>` on a PLAIN (non-repeating)
#       to-do must land. A negative result from an oracle that has never been
#       shown a positive is not evidence (CNCAC1/URLEN1 law).
#   A   REANCH1 RE-VERIFY — bare `update?when=2026-07-09` on a fresh daily
#       template seeded 2026-07-05 must reproduce REANCH1 §2.1 exactly, blob hash
#       included (sha256:b9a58999d5b4072c), and `when=2026-07-09@18:00` must set
#       reminderTime = 1207959552 with the SAME blob delta (REANCH1 §3).
#   D   the DEADLINE matrix on templates:
#       D1 future deadline on a plain (non-deadlined) daily template
#       D2 deadline == today          — is the FUTURE-vs-NOT boundary shared?
#       D3 deadline in the past       — ditto
#       D4 future deadline on a RULE-DEADLINED template (the 4001 sentinel + ts)
#       D5 the CLEAR spelling (`deadline=`) on that same template
#       D6 `when=` and `deadline=` together in ONE url
#       D7 the PROJECT route — `update-project?deadline=<date>`
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23, DB v27; the
# golden is NEVER booted). Airgapped (default route deleted), guest audio muted
# at boot, clock pinned 2026-07-05 12:00 (a Sunday) BEFORE Things is launched.
# Fixtures fully synthetic (REANCH2-*); the golden's own LAB-REPEAT-WEEKLY-PROJ
# seed is the project arm. DB oracle = FULL TMTask row snapshots (every column,
# packed dates decoded, blobs hashed) diffed either side of every gesture, plus a
# decoded rule summary. Beep sentinel per cell (research driver: BEEPS_OK=1, so
# beeps are COUNTED and printed, never fatal). Teardown on EXIT (KEEP=1 keeps
# it, REUSE=1 attaches to a live clone).
#
# Usage:  lab/scripts/research-reanch2.sh
#         CELLS="S P" KEEP=1 lab/scripts/research-reanch2.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-reanch2-lab}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/snap"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-S P A D}"
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[reanch2] $*" | tee -a "$REPORT"; }
has_cell() { case " $CELLS " in *" $1 "*) return 0;; *) return 1;; esac; }

UUIDS="$OUT/uuids.env"
[ -f "$UUIDS" ] && source "$UUIDS"
remember() { echo "$1=\"$2\"" >> "$UUIDS"; }

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
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (PINNED — no cell rolls it)"
  BOOTSTRAP=1
else
  BOOTSTRAP=0
fi

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM running at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done"
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

# rule summary (decodes rt1_recurrenceRule) — REANCH1's helper verbatim, so the
# two campaigns' evidence lines are directly comparable.
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib, hashlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
def rem(v):
    if not isinstance(v,int): return v
    return "%02d:%02d"%(v>>26,(v>>20)&0x3F)
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, startDate, rt1_instanceCreationPaused, rt1_afterCompletionReferenceDate, reminderTime, start, todayIndexReferenceDate FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
blob=row[0]
h = "none" if blob is None else "sha256:%s(%dB)"%(hashlib.sha256(blob).hexdigest()[:16],len(blob))
if blob is None:
    print("NO-RULE start=%s next=%s icStart=%s icCount=%s deadline=%s startDate=%s rem=%s"%(row[9],dpk(row[1]),dpk(row[2]),row[3],dpk(row[4]),dpk(row[5]),rem(row[8]))); sys.exit(0)
d=plistlib.loads(blob); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
extra=" ".join("%s=%s"%(k,d[k]) for k in sorted(d) if k not in ('tp','fu','fa','ts','rc','of'))
print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] %s | blob=%s | start=%s next=%s icStart=%s icCount=%s paused=%s deadline=%s acRef=%s rem=%s tiRef=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),extra,h,
    row[9],dpk(row[1]),dpk(row[2]),row[3],row[6],dpk(row[4]),row[7],rem(row[8]),dpk(row[10])))
EOF
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py $1" </dev/null 2>&1; }

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

# the beep sentinel (harness §The beep sentinel) — post-hoc, no live listener.
# BEEPS_OK=1: a research driver COUNTS and prints beeps, it does not fail on them.
lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null
beep_reset() { lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null 2>&1; }
beep_mark()  { lab_ssh "$IP" "~/labh/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }
beep_assert() {
  lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/labh/beep-sentinel.sh assert --name $(printf '%q' "$1")" \
    </dev/null 2>&1 | sed 's/^/    [beeps] /' | tee -a "$REPORT"
}

axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
crashes() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 16; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
relaunch() { lab_ssh "$IP" 'pkill -x Things3 >/dev/null 2>&1; sleep 4; open -a Things3; sleep 20; true' </dev/null; }

ourl() { # ourl <url>  — background-open, echo the exit code
  lab_ssh "$IP" "open -g $(printf '%q' "$1") >/dev/null 2>&1; echo EXIT=\$?" </dev/null
}

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" 2>/dev/null || gq "SELECT databaseVersion FROM Meta")
note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) ($(lab_ssh "$IP" 'sw_vers -buildVersion' </dev/null)) / golden $GOLDEN / dbv $DBV"
note "cells: $CELLS"

# ------------------------------------------------------------- fixture minting
select_item() { # select_item <uuid> — show + verify the selection by uuid
  local uuid="$1" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get id of selected to dos' 2>/dev/null)
    [ "$sel" = "$uuid" ] && return 0
    note "    selection attempt $i -> '$sel' (want '$uuid')"
  done
  return 1
}

mkurl() { # mkurl <title> <when>
  lab_ssh "$IP" "open -g 'things:///add?title=$1&when=$2&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"
}

# mkrepeat <uuid> <frequency> [deadlines] — promote to a series via Items ▸ Repeat….
# With a third argument the rule's "Add deadlines" checkbox is ticked (REANCH1's
# mkrepeat_dl), which is what puts the year-4001 deadline sentinel + the `ts`
# start offset on the template.
mkrepeat() {
  local uuid="$1" freq="$2" dl="${3:-}"
  select_item "$uuid" || note "    WARN: selection never confirmed for $uuid"
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
    click menu item \"$freq\" of menu 1 of p
    delay 1.5
    if \"$dl\" is not \"\" then
      click checkbox \"Add deadlines\" of sh
      delay 1.5
    end if
    return \"frequency = $freq${dl:+ + Add deadlines}\"
  end tell" | sed 's/^/      /' | tee -a "$REPORT"
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    click button "OK" of sh
    delay 2
    return "pressed OK"
  end tell' | sed 's/^/      /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 7' </dev/null
}

# mkseries <title> <freq> [deadlines] -> echoes the TEMPLATE uuid (the promote
# replaces the to-do's identity, ANCH2 A2, so it is re-resolved by title).
mkseries() {
  local nm="$1" freq="${2:-daily}" dl="${3:-}" seed tmpl
  seed=$(mkurl "$nm" "2026-07-05")
  mkrepeat "$seed" "$freq" "$dl" >/dev/null
  tmpl=$(gq "SELECT uuid FROM TMTask WHERE title='$nm' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  echo "$tmpl"
}

seriesrows() { # seriesrows <templateUuid>
  gt "SELECT substr(uuid,1,8) AS uuid8, title, status, trashed, start, startDate, deadline, reminderTime AS rem, rt1_recurrenceRule IS NOT NULL AS istmpl, rt1_repeatingTemplate IS NOT NULL AS isinst FROM TMTask WHERE uuid='$1' OR rt1_repeatingTemplate='$1' ORDER BY creationDate" | sed 's/^/      /' | tee -a "$REPORT"
}

# urlwrite <label> <route> <uuid> <query> — the campaign's one write shape,
# bracketed by a pid oracle and an .ips count (REANCH1's crash discipline).
urlwrite() {
  local label="$1" route="$2" uuid="$3" query="$4"
  local ips0 pid0 ips1 pid1 ex
  ips0=$(crashes); pid0=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null)
  ex=$(ourl "things:///$route?id=$uuid&auth-token=$TOKEN&$query")
  lab_ssh "$IP" 'sleep 9' </dev/null
  ips1=$(crashes); pid1=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null)
  note "    [$label] $route?$query  transport $ex  pid $pid0->$pid1  ips $ips0->$ips1  app=$(alive)"
}

# cell <label> <route> <uuid> <query> <titleLike> <prose>
cell() {
  local lbl="$1" route="$2" u="$3" q="$4" tl="$5"
  note ""; note "  --- $lbl: $6"
  note "    before: $(rsum "$u")"
  snap "$lbl-before" "$tl"
  beep_mark "$lbl"
  urlwrite "$lbl" "$route" "$u" "$q"
  note "    after : $(rsum "$u")"
  snap "$lbl-after" "$tl"
  snapdiff "$lbl-before" "$lbl-after" "$lbl ($q)"
  if [ "$(alive)" = "DEAD" ]; then relaunch; note "    relaunched: $(alive)"; fi
}

########################################################################
if has_cell S; then
note ""; note "########## CELL S — mint the synthetic fixtures ##########"
[ "$BOOTSTRAP" = "1" ] && warm
beep_reset; beep_mark "S mint"
: > "$UUIDS"
note "  minting REANCH2-PLAIN (a NON-repeating to-do — the positive control)"
u=$(mkurl "REANCH2-PLAIN" "2026-07-05")
note "    to-do=$u  row: $(rsum "$u")"
remember "T_REANCH2_PLAIN" "$u"
for spec in "REANCH2-CTRL:daily:" "REANCH2-REM:daily:" "REANCH2-DLF:daily:" \
            "REANCH2-DLT:daily:" "REANCH2-DLP:daily:" "REANCH2-DLR:daily:dl" \
            "REANCH2-BOTH:daily:"; do
  nm="${spec%%:*}"; rest="${spec#*:}"; fq="${rest%%:*}"; dl="${rest#*:}"
  note "  minting $nm ($fq${dl:+ + Add deadlines})"
  u=$(mkseries "$nm" "$fq" "$dl")
  note "    template=$u"
  note "    rule: $(rsum "$u")"
  seriesrows "$u"
  remember "T_${nm//-/_}" "$u"
done
PROJ=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-WEEKLY-PROJ' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  golden project template LAB-REPEAT-WEEKLY-PROJ = $PROJ"
note "    rule: $(rsum "$PROJ")"
remember "T_PROJ" "$PROJ"
source "$UUIDS"
snap "s-baseline" "REANCH2-%"
beep_assert S
fi
source "$UUIDS" 2>/dev/null || true

########################################################################
if has_cell P; then
note ""; note "########## CELL P — POSITIVE CONTROL: deadline= on a PLAIN to-do ##########"
note "  (a negative from an oracle never shown a positive is not evidence — CNCAC1)"
beep_reset
cell "P1-plain-deadline" "update" "$T_REANCH2_PLAIN" "deadline=2026-09-01" "REANCH2-PLAIN%" \
  "update?deadline=2026-09-01 on a non-repeating to-do — the param must LAND"
cell "P2-plain-clear" "update" "$T_REANCH2_PLAIN" "deadline=" "REANCH2-PLAIN%" \
  "update?deadline= (empty) on the same to-do — the CLEAR spelling"
beep_assert P
fi

########################################################################
if has_cell A; then
note ""; note "########## CELL A — REANCH1 RE-VERIFY (bare when=, and the @time reminder) ##########"
beep_reset
cell "A1-bare-when" "update" "$T_REANCH2_CTRL" "when=2026-07-09" "REANCH2-CTRL%" \
  "REANCH1 §2.1: five columns + rule blob; expect blob sha256:b9a58999d5b4072c(627B), ia -> 2026-07-09"
cell "A2-when-at-time" "update" "$T_REANCH2_REM" "when=2026-07-09@18%3A00" "REANCH2-REM%" \
  "REANCH1 §3: the same five-column delta PLUS reminderTime None -> 1207959552 (18:00)"
note "  series rows after A2:"; seriesrows "$T_REANCH2_REM"
beep_assert A
fi

########################################################################
if has_cell D; then
note ""; note "########## CELL D — deadline= on a repeating TEMPLATE ##########"
beep_reset
cell "D1-future-deadline" "update" "$T_REANCH2_DLF" "deadline=2026-09-01" "REANCH2-DLF%" \
  "a STRICTLY FUTURE deadline on a plain daily template — accepted, crash, or no-op?"
cell "D2-today-deadline" "update" "$T_REANCH2_DLT" "deadline=2026-07-05" "REANCH2-DLT%" \
  "deadline == the device's today — is the FUTURE-vs-NOT boundary (REANCH1 §5) shared?"
cell "D3-past-deadline" "update" "$T_REANCH2_DLP" "deadline=2026-07-01" "REANCH2-DLP%" \
  "a PAST deadline"
note ""; note "  --- the RULE-DEADLINED template (Add deadlines: 4001-01-01 sentinel + ts offset)"
cell "D4-deadlined-tmpl" "update" "$T_REANCH2_DLR" "deadline=2026-09-01" "REANCH2-DLR%" \
  "a future deadline on a template whose RULE deadlines its instances — does the sentinel survive?"
cell "D5-deadlined-clear" "update" "$T_REANCH2_DLR" "deadline=" "REANCH2-DLR%" \
  "the CLEAR spelling on that same rule-deadlined template"
note "  DLR series rows:"; seriesrows "$T_REANCH2_DLR"
note ""; note "  --- both params in ONE url"
cell "D6-when-and-deadline" "update" "$T_REANCH2_BOTH" "when=2026-07-09&deadline=2026-09-01" "REANCH2-BOTH%" \
  "when= (a re-anchor) and deadline= together — does the pair land, and in what order?"
note "  BOTH series rows:"; seriesrows "$T_REANCH2_BOTH"
note ""; note "  --- the PROJECT route"
cell "D7-project-deadline" "update-project" "$T_PROJ" "deadline=2026-09-01" "LAB-REPEAT-WEEKLY-PROJ%" \
  "update-project?deadline=2026-09-01 on a repeating PROJECT template"
beep_assert D
fi

########################################################################
# E — the D6 DISCRIMINATOR block (a second clone). Cell D found that
# `update?when=<future date>&deadline=<date>` on a template lands NOTHING — not
# even the `when=` re-anchor that works on its own. A single zero delta is not a
# law: it needs a repeat, a POSITIVE CONTROL on the same row (CNCAC1: a negative
# from an oracle never shown a positive is not evidence), and a non-template
# contrast that says the PAIR itself is fine on an ordinary row.
if has_cell E; then
note ""; note "########## CELL E — is a `deadline=` companion what VOIDS the re-anchor? ##########"
[ "$BOOTSTRAP" = "1" ] && warm
beep_reset; beep_mark "E mint"
: > "$UUIDS"
note "  minting REANCH2-EPLAIN (a NON-repeating to-do — the pair's control)"
u=$(mkurl "REANCH2-EPLAIN" "2026-07-05")
note "    to-do=$u  row: $(rsum "$u")"
remember "T_REANCH2_EPLAIN" "$u"
for nm in REANCH2-EPAIR REANCH2-EREV REANCH2-ECLR; do
  note "  minting $nm (daily)"
  u=$(mkseries "$nm" "daily")
  note "    template=$u  rule: $(rsum "$u")"
  remember "T_${nm//-/_}" "$u"
done
source "$UUIDS"
beep_assert "E mint"

beep_reset
cell "E1-pair-again" "update" "$T_REANCH2_EPAIR" "when=2026-07-09&deadline=2026-09-01" "REANCH2-EPAIR%" \
  "D6 again on a fresh template — the pair, 2/2"
cell "E2-bare-control" "update" "$T_REANCH2_EPAIR" "when=2026-07-09" "REANCH2-EPAIR%" \
  "POSITIVE CONTROL on the SAME row: the bare when= must re-anchor it"
cell "E3-reversed" "update" "$T_REANCH2_EREV" "deadline=2026-09-01&when=2026-07-09" "REANCH2-EREV%" \
  "the same pair with the params REVERSED — is the void order-sensitive?"
cell "E4-empty-deadline" "update" "$T_REANCH2_ECLR" "when=2026-07-09&deadline=" "REANCH2-ECLR%" \
  "when= plus an EMPTY deadline= (the clear spelling) — does an inert companion void it too?"
cell "E5-pair-on-plain" "update" "$T_REANCH2_EPLAIN" "when=2026-07-09&deadline=2026-09-01" "REANCH2-EPLAIN%" \
  "the SAME pair on a NON-repeating to-do — both params must land (the pair is fine off a template)"
beep_assert E
fi

note ""
note "final: app=$(alive) ips=$(crashes) clock=$(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
note "REANCH2 done"
