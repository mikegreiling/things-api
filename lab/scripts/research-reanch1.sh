#!/bin/bash
# REANCH1 — the dated `when=` on a repeating template as a SERIES RE-ANCHOR.
#
# ODDS1 §3.1 measured that `things:///update?id=<template>&when=<ISO-date>` does
# NOT crash (only the bucket keywords do) and silently rewrites BOTH
# `rt1_nextInstanceStartDate` and `rt1_instanceCreationStartDate` to the supplied
# date. What it could NOT say: does the next SPAWN actually land on the
# re-anchored date, does it work on projects / after-completion templates, and is
# this new in 3.23. This campaign answers those.
#
#   S    setup — mint the synthetic fixtures (UI `Items ▸ Repeat…` promotes)
#   C1   SPAWN LANDING — re-anchor a fixed DAILY and a fixed WEEKLY, roll the
#        clock, confirm the minted instance lands ON the re-anchored date (the
#        weekly off its old weekday phase = a true re-anchor, REPX2 §1.4)
#   C2   REMINDER INHERITANCE — `when=<date>@<time>`: does the spawn inherit it,
#        and does a later bare dated re-anchor leave it (ODDS1 §8b at spawn level)
#   C3   PROJECT template — `update-project?when=<date>` on a repeating project
#   C4   AFTER-COMPLETION template — accepted? what does it rewrite?
#   C6   SAFETY EDGES — dated-vs-bucket on the SAME template (crash contrast) and
#        a re-anchor onto TODAY (immediate mint / double-book? oddities §13)
#   R9   clock roll to 2026-07-09 — the spawn oracle for C1/C2/C3
#   R10  clock roll to 2026-07-10 — the second spawn (reminder persistence)
#
# C5 (version provenance on the 3.22 line) runs SEPARATELY against golden-v3 via
#   GOLDEN=things-lab-golden-v3 VM=reanch1-v3 CELLS="V3" lab/scripts/research-reanch1.sh
# because only ONE VM may be held at a time.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23, DB v27; the
# golden is NEVER booted). Airgapped (default route deleted), guest audio muted at
# boot, clock pinned 2026-07-05 12:00 (a Sunday). Fixtures fully synthetic
# (REANCH1-*); the golden's own LAB-REPEAT-WEEKLY-PROJ seed is the project arm.
# DB oracle = FULL TMTask row snapshots (every column, packed dates decoded, blobs
# hashed) diffed either side of every gesture. Teardown on EXIT (KEEP=1 keeps it,
# REUSE=1 attaches to a live clone).
#
# Usage:  lab/scripts/research-reanch1.sh
#         CELLS="S C1" KEEP=1 lab/scripts/research-reanch1.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-reanch1-lab}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/ax" "$OUT/snap"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-S C1 C2 C6 C4 C3 R9 R10}"
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[reanch1] $*" | tee -a "$REPORT"; }
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

# rule summary (decodes rt1_recurrenceRule) — the RDLG2/REPX1/REPX2 helper, with
# the rule BLOB HASH added: the URL re-anchor's key question is whether it
# rewrites the rule's own start anchor (REPX2 §1.4's Update Rule does) or only
# the two cursor columns.
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

axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
crashes() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 16; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
relaunch() { lab_ssh "$IP" 'pkill -x Things3 >/dev/null 2>&1; sleep 4; open -a Things3; sleep 20; true' </dev/null; }
quitapp() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 4; pkill -x Things3 >/dev/null 2>&1; sleep 2; true' </dev/null; }
setclock() { # setclock MMDDhhmmYYYY  (quits the app first, relaunches after)
  quitapp
  lab_ssh "$IP" "sudo date $1 >/dev/null; date" </dev/null | sed 's/^/    clock now: /' | tee -a "$REPORT"
  lab_ssh "$IP" 'open -a Things3; sleep 24; true' </dev/null
}

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

# mkrepeat <uuid> <frequency> — promote to a series via Items ▸ Repeat….
mkrepeat() {
  local uuid="$1" freq="$2"
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
    return \"frequency = $freq\"
  end tell" | sed 's/^/      /' | tee -a "$REPORT"
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    click button "OK" of sh
    delay 2
    return "pressed OK"
  end tell' | sed 's/^/      /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 7' </dev/null
}

# mkseries <title> <freq> -> echoes the TEMPLATE uuid (the promote replaces the
# to-do's identity, ANCH2 A2, so the template is re-resolved by title).
mkseries() {
  local nm="$1" freq="${2:-daily}" seed tmpl
  seed=$(mkurl "$nm" "2026-07-05")
  mkrepeat "$seed" "$freq" >/dev/null
  tmpl=$(gq "SELECT uuid FROM TMTask WHERE title='$nm' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  echo "$tmpl"
}

seriesrows() { # seriesrows <templateUuid>
  gt "SELECT substr(uuid,1,8) AS uuid8, title, status, trashed, start, startDate, reminderTime AS rem, rt1_recurrenceRule IS NOT NULL AS istmpl, rt1_repeatingTemplate IS NOT NULL AS isinst FROM TMTask WHERE uuid='$1' OR rt1_repeatingTemplate='$1' ORDER BY creationDate" | sed 's/^/      /' | tee -a "$REPORT"
}

# reanchor <label> <route> <uuid> <whenValue> — the campaign's one write shape.
reanchor() { # echoes nothing; notes everything
  local label="$1" route="$2" uuid="$3" when="$4"
  local ips0 pid0 ips1 pid1 ex
  ips0=$(crashes); pid0=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null)
  ex=$(ourl "things:///$route?id=$uuid&auth-token=$TOKEN&when=$when")
  lab_ssh "$IP" 'sleep 9' </dev/null
  ips1=$(crashes); pid1=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null)
  note "    [$label] $route?when=$when  transport $ex  pid $pid0->$pid1  ips $ips0->$ips1  app=$(alive)"
}

########################################################################
if has_cell S; then
note ""; note "########## CELL S — mint the synthetic fixtures ##########"
[ "$BOOTSTRAP" = "1" ] && warm
: > "$UUIDS"
for spec in "REANCH1-DAILY:daily" "REANCH1-WEEKLY:weekly" "REANCH1-REM:daily" \
            "REANCH1-AC:after completion" "REANCH1-EDGE:daily" "REANCH1-TODAY:daily"; do
  nm="${spec%%:*}"; fq="${spec#*:}"
  note "  minting $nm ($fq)"
  u=$(mkseries "$nm" "$fq")
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
snap "s-baseline" "REANCH1-%"
fi
source "$UUIDS" 2>/dev/null || true

########################################################################
if has_cell C1; then
note ""; note "########## CELL C1 — the two-column rewrite on DAILY + WEEKLY ##########"
note "  DAILY  before: $(rsum "$T_REANCH1_DAILY")"
note "  WEEKLY before: $(rsum "$T_REANCH1_WEEKLY")"
snap "c1-before" "REANCH1-DAILY%"
snap "c1w-before" "REANCH1-WEEKLY%"
reanchor "C1-daily"  "update" "$T_REANCH1_DAILY"  "2026-07-09"
reanchor "C1-weekly" "update" "$T_REANCH1_WEEKLY" "2026-07-09"
note "  DAILY  after : $(rsum "$T_REANCH1_DAILY")"
note "  WEEKLY after : $(rsum "$T_REANCH1_WEEKLY")"
snap "c1-after" "REANCH1-DAILY%"
snap "c1w-after" "REANCH1-WEEKLY%"
snapdiff "c1-before" "c1-after" "DAILY template, update?when=2026-07-09"
snapdiff "c1w-before" "c1w-after" "WEEKLY template (Sunday phase), update?when=2026-07-09 (a THURSDAY)"
fi

########################################################################
if has_cell C2; then
note ""; note "########## CELL C2 — reminder inheritance (when=<date>@<time>) ##########"
note "  REM before: $(rsum "$T_REANCH1_REM")"
snap "c2-before" "REANCH1-REM%"
reanchor "C2-dated@time" "update" "$T_REANCH1_REM" "2026-07-09@18%3A00"
note "  REM after : $(rsum "$T_REANCH1_REM")"
snap "c2-after" "REANCH1-REM%"
snapdiff "c2-before" "c2-after" "REM template, update?when=2026-07-09@18:00"
fi

########################################################################
if has_cell C6; then
note ""; note "########## CELL C6 — safety edges ##########"
note "  --- C6a: the BUCKET spelling on REANCH1-EDGE must still CRASH (control)"
snap "c6-before" "REANCH1-EDGE%"
note "    EDGE before: $(rsum "$T_REANCH1_EDGE")"
reanchor "C6a-bucket" "update" "$T_REANCH1_EDGE" "today"
snap "c6-afterbucket" "REANCH1-EDGE%"
snapdiff "c6-before" "c6-afterbucket" "EDGE template, update?when=today (bucket)"
relaunch
note "    app after relaunch: $(alive)"
note "  --- C6b: the DATED spelling on the SAME template must SURVIVE"
snap "c6b-before" "REANCH1-EDGE%"
reanchor "C6b-dated" "update" "$T_REANCH1_EDGE" "2026-07-09"
note "    EDGE after : $(rsum "$T_REANCH1_EDGE")"
snap "c6b-after" "REANCH1-EDGE%"
snapdiff "c6b-before" "c6b-after" "EDGE template, update?when=2026-07-09 (dated, same row)"
note "  --- C6c: re-anchor onto TODAY's date (2026-07-05) — immediate mint / double-book?"
note "    TODAY before: $(rsum "$T_REANCH1_TODAY")"
snap "c6c-before" "REANCH1-TODAY%"
reanchor "C6c-todaydate" "update" "$T_REANCH1_TODAY" "2026-07-05"
note "    TODAY after (t+9s): $(rsum "$T_REANCH1_TODAY")"
snap "c6c-after" "REANCH1-TODAY%"
snapdiff "c6c-before" "c6c-after" "TODAY template, update?when=2026-07-05 (== the pinned today)"
note "    --- and after a relaunch (the clock-arrival spawner's own trigger)"
relaunch
note "    TODAY after relaunch: $(rsum "$T_REANCH1_TODAY")"
snap "c6c-relaunch" "REANCH1-TODAY%"
snapdiff "c6c-after" "c6c-relaunch" "TODAY template, after relaunch"
seriesrows "$T_REANCH1_TODAY"
fi

########################################################################
if has_cell C4; then
note ""; note "########## CELL C4 — an AFTER-COMPLETION template ##########"
note "  AC before: $(rsum "$T_REANCH1_AC")"
snap "c4-before" "REANCH1-AC%"
reanchor "C4-dated" "update" "$T_REANCH1_AC" "2026-07-09"
note "  AC after : $(rsum "$T_REANCH1_AC")"
snap "c4-after" "REANCH1-AC%"
snapdiff "c4-before" "c4-after" "AFTER-COMPLETION template, update?when=2026-07-09"
if [ "$(alive)" = "DEAD" ]; then relaunch; note "  relaunched: $(alive)"; fi
note "  --- and the @time spelling on the same after-completion template"
snap "c4b-before" "REANCH1-AC%"
reanchor "C4b-dated@time" "update" "$T_REANCH1_AC" "2026-07-11@07%3A30"
snap "c4b-after" "REANCH1-AC%"
snapdiff "c4b-before" "c4b-after" "AFTER-COMPLETION template, update?when=2026-07-11@07:30"
if [ "$(alive)" = "DEAD" ]; then relaunch; note "  relaunched: $(alive)"; fi
fi

########################################################################
if has_cell C3; then
note ""; note "########## CELL C3 — a repeating PROJECT template ##########"
note "  PROJ before: $(rsum "$T_PROJ")"
gt "SELECT substr(uuid,1,8) AS uuid8, title, type, status, trashed, start, startDate FROM TMTask WHERE uuid='$T_PROJ' OR rt1_repeatingTemplate='$T_PROJ' ORDER BY creationDate" | sed 's/^/      /' | tee -a "$REPORT"
snap "c3-before" "LAB-REPEAT-WEEKLY-PROJ%"
note "  --- C3a: the update-project route"
reanchor "C3a-project" "update-project" "$T_PROJ" "2026-07-13"
note "  PROJ after : $(rsum "$T_PROJ")"
snap "c3-after" "LAB-REPEAT-WEEKLY-PROJ%"
snapdiff "c3-before" "c3-after" "PROJECT template, update-project?when=2026-07-13"
if [ "$(alive)" = "DEAD" ]; then relaunch; note "  relaunched: $(alive)"; fi
note "  --- C3b: the plain to-do update route aimed at the same PROJECT row"
snap "c3b-before" "LAB-REPEAT-WEEKLY-PROJ%"
reanchor "C3b-update-on-project" "update" "$T_PROJ" "2026-07-11"
note "  PROJ after : $(rsum "$T_PROJ")"
snap "c3b-after" "LAB-REPEAT-WEEKLY-PROJ%"
snapdiff "c3b-before" "c3b-after" "PROJECT template, update?when=2026-07-11"
if [ "$(alive)" = "DEAD" ]; then relaunch; note "  relaunched: $(alive)"; fi
note "  --- C3c: re-anchor onto the roll date so R9 can test the project SPAWN"
snap "c3c-before" "LAB-REPEAT-WEEKLY-PROJ%"
reanchor "C3c-project-rolldate" "update-project" "$T_PROJ" "2026-07-09"
note "  PROJ after : $(rsum "$T_PROJ")"
snap "c3c-after" "LAB-REPEAT-WEEKLY-PROJ%"
snapdiff "c3c-before" "c3c-after" "PROJECT template, update-project?when=2026-07-09"
if [ "$(alive)" = "DEAD" ]; then relaunch; note "  relaunched: $(alive)"; fi
fi

########################################################################
if has_cell R9; then
note ""; note "########## ROLL to 2026-07-09 — the SPAWN oracle ##########"
snap "r9-before" "REANCH1-%"
snap "r9p-before" "LAB-REPEAT-WEEKLY-PROJ%"
setclock 070912002026
lab_ssh "$IP" 'sleep 10' </dev/null
snap "r9-after" "REANCH1-%"
snap "r9p-after" "LAB-REPEAT-WEEKLY-PROJ%"
snapdiff "r9-before" "r9-after" "clock 2026-07-05 -> 2026-07-09, all REANCH1 fixtures"
snapdiff "r9p-before" "r9p-after" "clock roll, the PROJECT series"
for v in DAILY WEEKLY REM AC EDGE TODAY; do
  eval "u=\$T_REANCH1_$v"
  note "  $v template: $(rsum "$u")"
  note "  $v series rows:"; seriesrows "$u"
done
note "  PROJECT template: $(rsum "$T_PROJ")"
gt "SELECT substr(uuid,1,8) AS uuid8, title, type, status, trashed, start, startDate FROM TMTask WHERE uuid='$T_PROJ' OR rt1_repeatingTemplate='$T_PROJ' ORDER BY creationDate" | sed 's/^/      /' | tee -a "$REPORT"
fi

########################################################################
if has_cell R10; then
note ""; note "########## C2 follow-up + ROLL to 2026-07-10 ##########"
note "  --- does a BARE dated re-anchor clear the reminder the @time form wrote? (§8b)"
note "  REM before: $(rsum "$T_REANCH1_REM")"
snap "r10-c2-before" "REANCH1-REM%"
reanchor "C2b-bare-dated" "update" "$T_REANCH1_REM" "2026-07-10"
note "  REM after : $(rsum "$T_REANCH1_REM")"
snap "r10-c2-after" "REANCH1-REM%"
snapdiff "r10-c2-before" "r10-c2-after" "REM template, bare update?when=2026-07-10 after a reminder was set"
note "  --- also re-anchor DAILY forward one more day, to confirm repeatability"
snap "r10-d-before" "REANCH1-DAILY%"
reanchor "C1b-daily-again" "update" "$T_REANCH1_DAILY" "2026-07-10"
snap "r10-d-after" "REANCH1-DAILY%"
snapdiff "r10-d-before" "r10-d-after" "DAILY template, second re-anchor to 2026-07-10"
note ""; note "  --- roll to 2026-07-10"
snap "r10-before" "REANCH1-%"
setclock 071012002026
lab_ssh "$IP" 'sleep 10' </dev/null
snap "r10-after" "REANCH1-%"
snapdiff "r10-before" "r10-after" "clock 2026-07-09 -> 2026-07-10"
for v in DAILY WEEKLY REM; do
  eval "u=\$T_REANCH1_$v"
  note "  $v template: $(rsum "$u")"
  note "  $v series rows:"; seriesrows "$u"
done
fi

########################################################################
# W — what the re-anchor does to a rule's CALENDAR ANCHOR on the frequencies the
# first pass did not carry. C1 showed a single-weekday weekly rule's `of` offset
# REWRITTEN from Sunday to the target's weekday — so the write is not a pure
# cursor move, and any op built on it has to know whether a multi-weekday set, a
# monthly day/nth-weekday anchor, a yearly anchor or a rule deadline survives it.
#
# mkrepeat_wd converges the 3.23 dialog's weekday rows the way the shipped
# recipe does (group 1, pop-ups from index 3, grow with the leftmost button).
mkrepeat_wd() { # mkrepeat_wd <uuid> <comma-separated weekday titles>
  local uuid="$1" want="$2"
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
    click menu item \"weekly\" of menu 1 of p
    delay 1.5
    set AppleScript's text item delimiters to \",\"
    set wantList to every text item of \"$want\"
    set AppleScript's text item delimiters to \"\"
    set g to group 1 of sh
    set k to (count of wantList)
    repeat 14 times
      set n to (count of pop up buttons of g) - 3 + 1
      if n >= k then exit repeat
      set nb to (count of buttons of g)
      if nb is 0 then error \"no weekday row button\"
      set bestI to 0
      set bestX to 1000000
      repeat with i from 1 to nb
        set pp to position of button i of g
        set px to item 1 of pp
        if px < bestX then
          set bestX to px
          set bestI to i
        end if
      end repeat
      click button bestI of g
      delay 0.5
    end repeat
    set n to (count of pop up buttons of g) - 3 + 1
    repeat with i from 1 to n
      set wi to ((i - 1) mod k) + 1
      set wantVal to item wi of wantList
      set pu to pop up button (3 + i - 1) of g
      if ((value of pu) as text) is not wantVal then
        repeat 20 times
          if (exists menu 1 of pu) then exit repeat
          click pu
          delay 0.3
        end repeat
        click menu item wantVal of menu 1 of pu
        delay 0.4
      end if
    end repeat
    set out to \"weekday rows: \"
    repeat with i from 1 to n
      set out to out & ((value of pop up button (3 + i - 1) of g) as text) & \" \"
    end repeat
    click button \"OK\" of sh
    delay 2
    return out
  end tell" | sed 's/^/      /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 7' </dev/null
}

# mkrepeat_dl <uuid> <freq> — promote with the rule's "Add deadlines" checkbox on.
mkrepeat_dl() {
  local uuid="$1" freq="$2"
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
    click checkbox \"Add deadlines\" of sh
    delay 1.5
    click button \"OK\" of sh
    delay 2
    return \"frequency = $freq + Add deadlines\"
  end tell" | sed 's/^/      /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 7' </dev/null
}

if has_cell W; then
note ""; note "########## CELL W — the rule's CALENDAR ANCHOR under a re-anchor ##########"
[ "$BOOTSTRAP" = "1" ] && warm
: > "$UUIDS"
for spec in "REANCH1-WMON:monthly" "REANCH1-WYEAR:yearly"; do
  nm="${spec%%:*}"; fq="${spec#*:}"
  note "  minting $nm ($fq)"
  u=$(mkseries "$nm" "$fq")
  note "    template=$u  rule: $(rsum "$u")"
  remember "T_${nm//-/_}" "$u"
done
note "  minting REANCH1-WMULTI (weekly, Monday+Wednesday+Friday)"
relaunch
s=$(mkurl "REANCH1-WMULTI" "2026-07-05")
mkrepeat_wd "$s" "Monday,Wednesday,Friday"
u=$(gq "SELECT uuid FROM TMTask WHERE title='REANCH1-WMULTI' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "    template=$u  rule: $(rsum "$u")"
remember "T_REANCH1_WMULTI" "$u"
note "  minting REANCH1-WDL (daily + Add deadlines)"
relaunch
s=$(mkurl "REANCH1-WDL" "2026-07-05")
mkrepeat_dl "$s" "daily"
u=$(gq "SELECT uuid FROM TMTask WHERE title='REANCH1-WDL' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "    template=$u  rule: $(rsum "$u")"
remember "T_REANCH1_WDL" "$u"
source "$UUIDS"

wcell() { # wcell <label> <uuid> <when> <titleLike> <note>
  note ""; note "  --- $1: $5"
  note "    before: $(rsum "$2")"
  snap "w-$1-before" "$4"
  reanchor "$1" "update" "$2" "$3"
  note "    after : $(rsum "$2")"
  snap "w-$1-after" "$4"
  snapdiff "w-$1-before" "w-$1-after" "$1 ($3)"
  if [ "$(alive)" = "DEAD" ]; then relaunch; note "    relaunched: $(alive)"; fi
}

# 2026-09-17 is a THURSDAY, day-of-month 17, month 9 — different from every
# fixture's seeded anchor (Sunday, day 5, July).
wcell "W1-monthly"  "$T_REANCH1_WMON"   "2026-09-17" "REANCH1-WMON%"   "a MONTHLY rule (day-of-month anchor) re-anchored to 2026-09-17"
wcell "W2-yearly"   "$T_REANCH1_WYEAR"  "2026-09-17" "REANCH1-WYEAR%"  "a YEARLY rule (month+day anchor) re-anchored to 2026-09-17"
wcell "W3-multiwd"  "$T_REANCH1_WMULTI" "2026-09-17" "REANCH1-WMULTI%" "a MULTI-WEEKDAY weekly rule re-anchored to a Thursday — is the set COLLAPSED?"
wcell "W4-deadline" "$T_REANCH1_WDL"    "2026-09-17" "REANCH1-WDL%"    "a DEADLINED rule — do the deadline sentinel and start offset survive?"

note ""; note "  --- roll to 2026-09-17: what does each series actually spawn?"
snap "w-roll-before" "REANCH1-W%"
setclock 091712002026
lab_ssh "$IP" 'sleep 10' </dev/null
snap "w-roll-after" "REANCH1-W%"
snapdiff "w-roll-before" "w-roll-after" "clock 2026-07-05 -> 2026-09-17, all W fixtures"
for v in WMON WYEAR WMULTI WDL; do
  eval "u=\$T_REANCH1_$v"
  note "  $v template: $(rsum "$u")"
  note "  $v series rows:"; seriesrows "$u"
done
fi

########################################################################
# B — the CRASH-BOUNDARY discriminator block (second v4 clone). The first pass
# found that `when=2026-07-05` at clock 2026-07-05 (cursor 07-06) KILLS the app,
# while `when=2026-07-10` at clock 2026-07-10 (cursor 07-10) is an inert no-op.
# Two hypotheses survive that pair:
#   (b) a BACKWARDS move (target < the current cursor) is fatal
#   (d) a target that COLLIDES with an existing instance's startDate is fatal
# B1 and B3 discriminate them; B5/B6 take the crash observations to 2/2.
if has_cell B; then
note ""; note "########## CELL B — the crash boundary ##########"
[ "$BOOTSTRAP" = "1" ] && warm
: > "$UUIDS"
for nm in REANCH1-B1 REANCH1-B2 REANCH1-B3 REANCH1-B4 REANCH1-B5; do
  note "  minting $nm (daily)"
  u=$(mkseries "$nm" "daily")
  note "    template=$u  rule: $(rsum "$u")"
  remember "T_${nm//-/_}" "$u"
done
note "  minting REANCH1-BAC (after completion)"
u=$(mkseries "REANCH1-BAC" "after completion")
note "    template=$u  rule: $(rsum "$u")"
remember "T_REANCH1_BAC" "$u"
source "$UUIDS"

bcell() { # bcell <label> <uuid> <when> <titleLike> <note>
  local lbl="$1" u="$2" w="$3" tl="$4"
  note ""; note "  --- $lbl: $5"
  note "    before: $(rsum "$u")"
  snap "b-$lbl-before" "$tl"
  reanchor "$lbl" "update" "$u" "$w"
  note "    after : $(rsum "$u")"
  snap "b-$lbl-after" "$tl"
  snapdiff "b-$lbl-before" "b-$lbl-after" "$lbl ($w)"
  if [ "$(alive)" = "DEAD" ]; then relaunch; note "    relaunched: $(alive)"; fi
}

bcell "B2-equal-cursor" "$T_REANCH1_B2" "2026-07-06" "REANCH1-B2%" \
  "target == the current cursor (07-06), which is in the FUTURE"
bcell "B3a-forward" "$T_REANCH1_B3" "2026-07-20" "REANCH1-B3%" \
  "forward re-anchor to 07-20 (sets up B3b)"
bcell "B3b-backwards-future" "$T_REANCH1_B3" "2026-07-10" "REANCH1-B3%" \
  "BACKWARDS vs the cursor (07-20 -> 07-10) but still in the FUTURE, no instance collision"
bcell "B4a-dated-time" "$T_REANCH1_B4" "2026-07-09@18%3A00" "REANCH1-B4%" \
  "set a rule-level reminder with the @time spelling"
bcell "B4b-bare-later" "$T_REANCH1_B4" "2026-07-12" "REANCH1-B4%" \
  "a BARE dated re-anchor to a LATER date — does it CLEAR the reminder? (oddities §8b)"
bcell "B1-past-date" "$T_REANCH1_B1" "2026-07-04" "REANCH1-B1%" \
  "a PAST date (07-04): behind the cursor AND behind today, no instance collision"
bcell "B5-today-again" "$T_REANCH1_B5" "2026-07-05" "REANCH1-B5%" \
  "re-confirm C6c 2/2 — target == today (07-05), behind the cursor, COLLIDES with the 07-05 instance"
bcell "B6-aftercompletion-again" "$T_REANCH1_BAC" "2026-07-09" "REANCH1-BAC%" \
  "re-confirm C4 2/2 — a dated when= on an AFTER-COMPLETION template"

note ""; note "  --- roll to 2026-07-12: does the B4 spawn still carry the reminder?"
snap "b-roll-before" "REANCH1-B%"
setclock 071212002026
lab_ssh "$IP" 'sleep 10' </dev/null
snap "b-roll-after" "REANCH1-B%"
snapdiff "b-roll-before" "b-roll-after" "clock 2026-07-05 -> 2026-07-12, all B fixtures"
for v in B1 B2 B3 B4 B5 BAC; do
  eval "u=\$T_REANCH1_$v"
  note "  $v template: $(rsum "$u")"
  note "  $v series rows:"; seriesrows "$u"
done
fi

########################################################################
# C5 — VERSION PROVENANCE. Runs against golden-v3 (Things 3.22.14) in its own
# clone: the MINIMAL cell only (dated when= on a fixed daily template →
# two-column rewrite?), plus the bucket-spelling crash control.
if has_cell V3; then
note ""; note "########## CELL C5/V3 — the same minimal cell on the 3.22 line ##########"
[ "$BOOTSTRAP" = "1" ] && warm
SEED=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  golden seed LAB-REPEAT-DAILY template = $SEED"
note "  before: $(rsum "$SEED")"
snap "v3-before" "LAB-REPEAT-DAILY%"
reanchor "V3-dated" "update" "$SEED" "2026-07-09"
note "  after : $(rsum "$SEED")"
snap "v3-after" "LAB-REPEAT-DAILY%"
snapdiff "v3-before" "v3-after" "3.22 line: LAB-REPEAT-DAILY template, update?when=2026-07-09"
note "  --- @time spelling"
snap "v3b-before" "LAB-REPEAT-DAILY%"
reanchor "V3b-dated@time" "update" "$SEED" "2026-07-11@18%3A00"
note "  after : $(rsum "$SEED")"
snap "v3b-after" "LAB-REPEAT-DAILY%"
snapdiff "v3b-before" "v3b-after" "3.22 line: update?when=2026-07-11@18:00"
note "  --- is the FUTURE-DATE boundary the same on the 3.22 line? a PAST date"
snap "v3p-before" "LAB-REPEAT-DAILY%"
reanchor "V3p-past-date" "update" "$SEED" "2026-07-04"
snap "v3p-after" "LAB-REPEAT-DAILY%"
snapdiff "v3p-before" "v3p-after" "3.22 line: update?when=2026-07-04 (a PAST date)"
if [ "$(alive)" = "DEAD" ]; then relaunch; note "  relaunched: $(alive)"; fi
note "  --- … and TODAY's own date"
snap "v3t-before" "LAB-REPEAT-DAILY%"
reanchor "V3t-today-date" "update" "$SEED" "2026-07-05"
snap "v3t-after" "LAB-REPEAT-DAILY%"
snapdiff "v3t-before" "v3t-after" "3.22 line: update?when=2026-07-05 (== today)"
if [ "$(alive)" = "DEAD" ]; then relaunch; note "  relaunched: $(alive)"; fi
note "  --- bucket-spelling control (expect CRASH on the 3.22 line too)"
snap "v3c-before" "LAB-REPEAT-DAILY%"
reanchor "V3c-bucket" "update" "$SEED" "today"
snap "v3c-after" "LAB-REPEAT-DAILY%"
snapdiff "v3c-before" "v3c-after" "3.22 line: update?when=today (bucket)"
relaunch
note "  --- and the state the roll will read: $(rsum "$SEED")"
note "  --- spawn oracle: roll to 2026-07-11 (the last re-anchored date)"
snap "v3d-before" "LAB-REPEAT-DAILY%"
setclock 071112002026
lab_ssh "$IP" 'sleep 10' </dev/null
snap "v3d-after" "LAB-REPEAT-DAILY%"
snapdiff "v3d-before" "v3d-after" "3.22 line: clock roll to the re-anchored date"
note "  after roll: $(rsum "$SEED")"
seriesrows "$SEED"
fi

note ""
note "final: app=$(alive) ips=$(crashes)"
note "REANCH1 done"
