#!/bin/bash
# RSIM-R — RECONCILIATION: fixed-mode source fate + after-completion child links.
# Resolves two prior-law contradictions (RSIM/RSIM-P said DELETE-source / P4 per-child
# links; RSIM-P2 said PRESERVE-source-as-instance / A5 plain children) by running the
# confounded cross-terms on ONE clone, ONE clock, ONE build.
#
# C1 (source fate, FIXED make-repeating) — forensics isolated: schedule flips a TO-DO
#   (RSIM1 today->DELETE vs B3 inbox->PRESERVE) and area flips a PROJECT (P1/RSIM6
#   area->DELETE vs A1-3 area-less->PRESERVE), but the CROSS terms are untested:
#     R1 project, area-less, when=today   — does a concrete date delete a PROJECT?
#     R2 to-do,   in-area,  unscheduled   — does an area delete a TO-DO?
#   + same-clone anchors: R3 project area-less anytime (expect PRESERVE), R4 project
#     in-area anytime (expect DELETE), R5 to-do area-less today (expect DELETE),
#     R6 to-do area-less inbox (expect PRESERVE).
#   Unified hypothesis: DELETE iff (has area OR concrete scheduled date); else PRESERVE.
# C2 (after-completion PROJECT instance-side child links) — P4 (direct-only children)
#   linked, A5 (has a heading) plain; both deleted their source. Isolate heading-presence:
#     R7 after-completion project, 2 DIRECT children (replicate P4)
#     R8 after-completion project, heading+headed+direct (replicate A5)
#
# METHOD mirrors research-rsim-p2.sh: ONE disposable --vnc-experimental clone
# `rsim-r2-lab` of things-lab-golden-v1 (golden untouched). Airgap + pin clock
# 2026-07-05 12:00. Accessibility via AXVM1 rung-b VNC toggle. Ship the PRODUCTION
# e2e bundle, enable ui-enabled, run the cases. Each case snapshots the guest Things
# DB (read-only, WAL-consistent) into host JSON before/after; a host differ reports
# the full row-level delta. make-repeating is a ui-vector op -> --dangerously-drive-gui
# (NOT --allow-disruptive). Fixtures fully synthetic (public repo).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

VM="rsim-r2-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps" "$OUT/show"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[rsimr2] $*" | tee -a "$REPORT"; }
cleanup() { echo "[rsimr2] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---------------- preflight ----------------
if [ -z "$VNCDO" ] || [ ! -x "$VNCDO" ]; then note "FATAL: \$VNCDO (vncdotool) not set/executable. Abort."; exit 1; fi
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB, VNCDO=$VNCDO"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free. Abort."; exit 1; }

# ---------------- host toolchain (self-contained node; rem1/rsim lesson) ----------------
MAIN_WT=$(dirname "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null || true)
NODE_VER=$(awk '/nodejs/{print $2}' "$MAIN_WT/.tool-versions" .tool-versions "$HOME/.tool-versions" 2>/dev/null | head -1 || true)
CANDS=("$HOME/.asdf/installs/nodejs/$NODE_VER/bin")
CANDS+=( $(ls -d "$HOME"/.asdf/installs/nodejs/*/bin 2>/dev/null | sort -t/ -k7 -V -r) )
CANDS+=(/opt/homebrew/bin)
for cand in "${CANDS[@]}"; do
  [ -x "$cand/node" ] || continue
  otool -L "$cand/node" 2>/dev/null | grep -q '/opt/homebrew/' && continue
  export PATH="$cand:$PATH"; break
done
if ! node --version >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
  note "FATAL: no working self-contained node/npm on PATH. Abort."; exit 1
fi
note "toolchain: node $(node --version) / npm $(npm --version) @ $(command -v node)"
if [ ! -d node_modules/commander ]; then
  note "npm ci (worktree has no node_modules)…"
  npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL: npm ci failed (see $OUT/npm-ci.log)."; exit 1; }
fi

note "cloning golden -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[rsimr2] /'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# ---------------- guest helpers: read-only SQLite + snapshot dumper ----------------
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

lab_ssh "$IP" 'cat > /tmp/rsnap.py' <<'EOF'
import sys, sqlite3, glob, plistlib, json
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
cols=["uuid","title","type","status","trashed","start","startDate","startBucket",
      "reminderTime","deadline","t2_deadlineOffset","\"index\"","todayIndex",
      "area","project","heading","notes","creationDate","userModificationDate",
      "rt1_recurrenceRule","rt1_repeatingTemplate",
      "rt1_instanceCreationStartDate","rt1_instanceCreationPaused",
      "rt1_instanceCreationCount","rt1_afterCompletionReferenceDate",
      "rt1_nextInstanceStartDate"]
names=[x.strip('"') for x in cols]
def safe(v):
    if isinstance(v,(bytes,bytearray)): return "<%dB>"%len(v)
    return v
tasks={}
for r in c.execute("SELECT %s FROM TMTask"%",".join(cols)):
    d=dict(zip(names,[safe(x) for x in r]))
    if isinstance(d.get("notes"),str): d["notes"]=d["notes"][:40]
    rr=r[names.index("rt1_recurrenceRule")]
    if rr is not None:
        try:
            pl=plistlib.loads(rr)
            d["rt1_recurrenceRule"]={"size":len(rr),"keys":{k:(pl[k] if not isinstance(pl[k],(bytes,bytearray)) else "<blob>") for k in sorted(pl)}}
        except Exception as e:
            d["rt1_recurrenceRule"]={"size":len(rr),"error":str(e)}
    tasks[d["uuid"]]=d
tagname={}
for u,t in c.execute("SELECT uuid,title FROM TMTag"): tagname[u]=t
areas={}
for u,t in c.execute("SELECT uuid,title FROM TMArea"): areas[u]=t
tasktags=[]
for tk,tg in c.execute("SELECT tasks,tags FROM TMTaskTag"):
    tasktags.append({"task":tk,"taskTitle":(tasks.get(tk) or {}).get("title"),
                     "tag":tg,"tagName":tagname.get(tg)})
checklist={}
try:
    for cu,tk,ti,st,ix in c.execute('SELECT uuid,task,title,status,"index" FROM TMChecklistItem'):
        checklist[cu]={"task":tk,"taskTitle":(tasks.get(tk) or {}).get("title"),
                       "title":ti,"status":st,"index":ix}
except Exception as e:
    checklist={"__error__":str(e)}
json.dump({"tasks":tasks,"tasktags":tasktags,"checklist":checklist,"areas":areas},sys.stdout,default=str)
EOF
snap() { lab_ssh "$IP" 'python3 /tmp/rsnap.py' </dev/null > "$OUT/snaps/$1.json"; }

lab_ssh "$IP" 'cat > /tmp/kids.py' <<'EOF'
import sys, sqlite3, glob
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
p=sys.argv[1]
def q(sql,*a): return c.execute(sql,a).fetchall()
def tc(u): return q("SELECT COUNT(*) FROM TMTaskTag WHERE tasks=?",u)[0][0]
def cc(u):
    try: return q("SELECT COUNT(*) FROM TMChecklistItem WHERE task=?",u)[0][0]
    except: return -1
def rule(u): return q("SELECT (rt1_recurrenceRule IS NOT NULL) FROM TMTask WHERE uuid=?",u)[0][0]
def tmpl(u): return q("SELECT rt1_repeatingTemplate FROM TMTask WHERE uuid=?",u)[0][0]
def sh(u): return "rule=%s tmpl=%s"%(rule(u), (str(tmpl(u))[:8] if tmpl(u) else None))
row=q("SELECT title,type,start,status,trashed,rt1_repeatingTemplate,(rt1_recurrenceRule IS NOT NULL) FROM TMTask WHERE uuid=?",p)
print("PROJECT %s  %s  start=%s status=%s %s"%(p, row[0][0] if row else "MISSING", row[0][2] if row else "?", row[0][3] if row else "?", sh(p) if row else ""))
for hu,ht,hst,htr in q("SELECT uuid,title,status,trashed FROM TMTask WHERE type=2 AND project=? ORDER BY \"index\"",p):
    print("  HEADING %s '%s' status=%s trashed=%s tags=%d [%s]"%(hu,ht,hst,htr,tc(hu),sh(hu)))
    for u,t,ty,stt,hd,pj,tr in q("SELECT uuid,title,type,status,heading,project,trashed FROM TMTask WHERE heading=? ORDER BY \"index\"",hu):
        print("    TODO(headed) %s '%s' type=%s status=%s proj=%s trashed=%s tags=%d chk=%d [%s]"%(u,t,ty,stt,(str(pj)[:8] if pj else None),tr,tc(u),cc(u),sh(u)))
for u,t,ty,stt,hd,pj,tr in q("SELECT uuid,title,type,status,heading,project,trashed FROM TMTask WHERE project=? AND type=0 ORDER BY \"index\"",p):
    print("  TODO(direct) %s '%s' type=%s status=%s head=%s trashed=%s tags=%d chk=%d [%s]"%(u,t,ty,stt,(str(hd)[:8] if hd else None),tr,tc(u),cc(u),sh(u)))
EOF
kids() { lab_ssh "$IP" "python3 /tmp/kids.py $1" </dev/null | tee -a "$REPORT"; }

fk() {
  note "  FK: rows with rt1_repeatingTemplate=$1"
  gq "SELECT uuid,title,type,status,trashed,project,heading FROM TMTask WHERE rt1_repeatingTemplate='$1'" | sed 's/^/    /' | tee -a "$REPORT"
}

# SOURCE-FATE: after a fixed conversion, is the source uuid gone (DELETE) or present
# and relinked as the instance (PRESERVE)?  Prints [exists,rt1_repeatingTemplate,start,startDate,rule?].
fate() {
  local u="$1"
  local row
  row=$(gq "SELECT (SELECT COUNT(*) FROM TMTask WHERE uuid='$u')||'|'||COALESCE((SELECT rt1_repeatingTemplate FROM TMTask WHERE uuid='$u'),'NULL')||'|start='||COALESCE((SELECT start FROM TMTask WHERE uuid='$u'),'-')||'|startDate='||COALESCE((SELECT startDate FROM TMTask WHERE uuid='$u'),'-')||'|hasRule='||COALESCE((SELECT (rt1_recurrenceRule IS NOT NULL) FROM TMTask WHERE uuid='$u'),'-')")
  note "    >>> SOURCE-FATE src=$u  [exists|tmpl|start|startDate|hasRule] = $row"
  note "        (exists=1 & tmpl=<uuid> => PRESERVED-as-instance ; exists=0 => DELETED)"
}

# ---------------- host-side differ ----------------
cat > "$OUT/diff_snaps.py" <<'EOF'
import sys, json
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d(%d)"%(y,m,d,v) if 1<y<5000 else v
def cocoa(v):
    try: v=float(v)
    except: return v
    import datetime
    return datetime.datetime.utcfromtimestamp(v+978307200).strftime("%Y-%m-%dT%H:%M:%S")
DATEF={"startDate","deadline","rt1_instanceCreationStartDate","rt1_afterCompletionReferenceDate","rt1_nextInstanceStartDate"}
COCOAF={"creationDate","userModificationDate"}
def rr(d):
    v=d.get("rt1_recurrenceRule")
    if v is None: return "NULL"
    if isinstance(v,dict) and "keys" in v: return "rule(%dB){%s}"%(v["size"],", ".join("%s=%s"%(k,v["keys"][k]) for k in v["keys"]))
    return str(v)
def ref(u,snap):
    if not u: return u
    t=(snap.get("tasks",{}).get(u) or {}).get("title")
    a=snap.get("areas",{}).get(u)
    lbl=t if t is not None else (a if a is not None else "?")
    return "%s[%s]"%(lbl,str(u)[:8])
def line(d,snap):
    f=[]
    f.append("type=%s status=%s trashed=%s start=%s"%(d.get("type"),d.get("status"),d.get("trashed"),d.get("start")))
    f.append("area=%s project=%s heading=%s"%(ref(d.get("area"),snap),ref(d.get("project"),snap),ref(d.get("heading"),snap)))
    f.append("startDate=%s deadline=%s creationDate=%s"%(dpk(d.get("startDate")),dpk(d.get("deadline")),cocoa(d.get("creationDate"))))
    f.append("tmpl=%s"%ref(d.get("rt1_repeatingTemplate"),snap))
    f.append("icCount=%s next=%s acRef=%s"%(d.get("rt1_instanceCreationCount"),dpk(d.get("rt1_nextInstanceStartDate")),dpk(d.get("rt1_afterCompletionReferenceDate"))))
    f.append("rule=%s"%rr(d))
    return "\n      ".join(f)
A=json.load(open(sys.argv[1])); B=json.load(open(sys.argv[2]))
a=A["tasks"]; b=B["tasks"]
stems=[s for s in (sys.argv[3].split("|") if len(sys.argv)>3 and sys.argv[3] else []) if s]
def keep(d):
    if not stems: return True
    t=str(d.get("title",""))
    return any(t.startswith(s) for s in stems)
ins=[u for u in b if u not in a and keep(b[u])]
dele=[u for u in a if u not in b and keep(a[u])]
chg=[]
for u in b:
    if u in a and keep(b[u]):
        diffs={k:(a[u].get(k),b[u].get(k)) for k in b[u] if a[u].get(k)!=b[u].get(k)}
        if diffs: chg.append((u,diffs))
print("  TMTask  INSERTED: %d  DELETED: %d  CHANGED: %d"%(len(ins),len(dele),len(chg)))
for u in ins:
    d=b[u]; print("  + INSERT %s  \"%s\"\n      %s"%(u,d.get("title"),line(d,B)))
for u in dele:
    d=a[u]; print("  - DELETE %s  \"%s\"  (was type=%s status=%s trashed=%s proj=%s head=%s rule=%s)"%(u,d.get("title"),d.get("type"),d.get("status"),d.get("trashed"),ref(d.get("project"),A),ref(d.get("heading"),A),rr(d)))
for u,diffs in chg:
    print("  ~ CHANGE %s  \"%s\""%(u,b[u].get("title")))
    for k,(ov,nv) in sorted(diffs.items()):
        if k=="rt1_recurrenceRule": ov,nv=rr({"rt1_recurrenceRule":ov}),rr({"rt1_recurrenceRule":nv})
        elif k in ("project","heading","area","rt1_repeatingTemplate"): ov,nv=ref(ov,A),ref(nv,B)
        elif k in DATEF: ov,nv=dpk(ov),dpk(nv)
        elif k in COCOAF: ov,nv=cocoa(ov),cocoa(nv)
        print("      %s: %s -> %s"%(k,ov,nv))
EOF
diff_c() {
  python3 "$OUT/diff_snaps.py" "$OUT/snaps/$1.json" "$OUT/snaps/$2.json" "${3:-}" | tee -a "$REPORT"
}

# ---------------- AXVM1 rung-b: grant Accessibility via VNC ----------------
note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
if [ -z "$VNC_URL" ]; then note "FATAL: no VNC url in tart-run.log. Abort."; exit 1; fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 2; timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 12
V move 1642 332 click 1
V move 1018 869 click 1 pause 0.6 type admin pause 0.6 move 1018 963 click 1
sleep 3
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "grant auth_value=$GRANT (2=granted)"
lab_ssh "$IP" 'osascript -e '\''tell application "System Settings" to quit'\'' 2>/dev/null' </dev/null
if [ "$GRANT" != "2" ]; then note "FATAL: Accessibility grant did not land (auth_value=$GRANT). Abort."; exit 1; fi

# ---------------- ship the production e2e bundle + enable ui ----------------
note "############### build + ship bundle + ui-enabled ###############"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: npm run build failed (see $OUT/build.log)."; exit 1; }
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing after build. Abort."; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
if ! lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1; then
  note "FATAL: guest node not runnable after ship — bundle ship failed. Abort."; exit 1
fi
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
drive() {
  local label="$1"; shift
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive-$label.log" 2>&1
  { grep -m1 '"ok"' "$OUT/drive-$label.log" || grep -m1 '"error"\|error:' "$OUT/drive-$label.log" || echo '(no ok/error line — see drive log)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive-$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}
G config set ui-enabled true >/dev/null 2>&1

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
uidp()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
uidt()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
tmplp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
instp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_repeatingTemplate IS NOT NULL AND trashed=0 LIMIT 1"; }
tmplt() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
env_line() { note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"; }


STEMS="S-"

# =====================================================================
# RSIM-R2 — isolate the FIXED source-preserve trigger (area/schedule already
# FALSIFIED by RSIM-R: all bare items DELETE). The preserve cases (A1/A2/A3
# nested-repeater projects; B3 checklisted to-do) all had SUBSTRUCTURE. Test:
#   S1  fixed area-less project, 2 PLAIN children (no nested repeater)
#   S2  fixed area-less project, 1 NESTED-repeater child (A1 replica / control)
#   S2b SAME as S2 again (determinism check — is preserve reproducible?)
#   S3  fixed area-less to-do, CHECKLIST only (B3 driver, no deadline/tags)
# fate()==PRESERVE  => source kept + relinked (tmpl set) ; ==DELETE => gone.
# =====================================================================

# S1 — fixed area-less PROJECT with 2 PLAIN children
note ""; note "############### S1: fixed PROJECT, area-less, 2 PLAIN children — preserve or delete? ###############"
drive S1seed project add \"S-ProjPlain\" --todo \"S-C1\" --todo \"S-C2\" --json
S1=$(uidp "S-ProjPlain"); note "  seed S-ProjPlain uuid=$S1 (pre-state:)"
gq "SELECT uuid,type,start,startDate,area FROM TMTask WHERE uuid='$S1'" | sed 's/^/    /' | tee -a "$REPORT"
warm; snap s1-pre
note "  --- S1 pre subtree ---"; kids "$S1"
drive S1 project make-repeating "$S1" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap s1-post
note "  --- S1 delta ---"; diff_c s1-pre s1-post "$STEMS"; fate "$S1"

# S2 — fixed area-less PROJECT with a NESTED repeater child (A1 replica)
note ""; note "############### S2: fixed PROJECT, area-less, NESTED-repeater child (A1 replica) — preserve or delete? ###############"
drive S2seed project add \"S-ProjNest\" --todo \"S-N1\" --json
S2=$(uidp "S-ProjNest"); note "  seed S-ProjNest uuid=$S2"
drive S2seedDaily todo add \"S-Daily\" --project \"S-ProjNest\" --json
S2D=$(uidt "S-Daily"); note "  seed S-Daily (plain, in project) uuid=$S2D"
warm
drive S2mkDaily todo make-repeating "$S2D" --frequency daily --interval 1 --dangerously-drive-gui --json
settle; snap s2-pre
note "  --- S2 pre subtree (nested repeater present?) ---"; kids "$S2"
warm
drive S2 project make-repeating "$S2" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap s2-post
note "  --- S2 delta ---"; diff_c s2-pre s2-post "$STEMS"; fate "$S2"

# S2b — SAME config again (determinism check)
note ""; note "############### S2b: fixed PROJECT, area-less, NESTED-repeater child (REPEAT of S2 — determinism) ###############"
drive S2bseed project add \"S-ProjNestB\" --todo \"S-M1\" --json
S2B=$(uidp "S-ProjNestB"); note "  seed S-ProjNestB uuid=$S2B"
drive S2bseedDaily todo add \"S-DailyB\" --project \"S-ProjNestB\" --json
S2BD=$(uidt "S-DailyB"); note "  seed S-DailyB uuid=$S2BD"
warm
drive S2bmkDaily todo make-repeating "$S2BD" --frequency daily --interval 1 --dangerously-drive-gui --json
settle; snap s2b-pre
note "  --- S2b pre subtree ---"; kids "$S2B"
warm
drive S2b project make-repeating "$S2B" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap s2b-post
note "  --- S2b delta ---"; diff_c s2b-pre s2b-post "$STEMS"; fate "$S2B"

# S3 — fixed area-less TO-DO with a CHECKLIST only (B3 driver)
note ""; note "############### S3: fixed TO-DO, area-less, CHECKLIST only (no deadline/tags) — preserve or delete? ###############"
drive S3seed todo add \"S-TodoChk\" --checklist-item \"S-Sub1\" --checklist-item \"S-Sub2\" --json
S3=$(uidt "S-TodoChk"); note "  seed S-TodoChk uuid=$S3 (pre-state:)"
gq "SELECT uuid,type,start,startDate,area FROM TMTask WHERE uuid='$S3'" | sed 's/^/    /' | tee -a "$REPORT"
note "  S3 checklist count=$(gq "SELECT COUNT(*) FROM TMChecklistItem WHERE task='$S3'")"
warm; snap s3-pre
drive S3 todo make-repeating "$S3" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap s3-post
note "  --- S3 delta ---"; diff_c s3-pre s3-post "$STEMS"; fate "$S3"

note ""; env_line
note "DONE. report: $REPORT   snapshots: $OUT/snaps/"
