#!/bin/bash
# RSIM-P2 — nested repeaters + uuid-discovery adversarial traps (RSIM-P follow-up).
# Two worklists:
#   A. NESTED repeaters — a repeating project whose child subtree itself contains a
#      repeating to-do (fixed A1 / after-completion A2), plus edge-state children
#      (completed/trashed/external-instance A3), an after-completion project WITH a
#      heading (A5 — coordinator addendum: do instance-side copied HEADING rows carry
#      rt1_repeatingTemplate links?), and a clock-advance re-duplication probe (A4).
#   B. UUID-discovery traps — same-title gauntlet (B1), mid-write insertion (B2),
#      source-fingerprint viability (B3), rt1_repeatingTemplate FK integrity (B4).
#
# METHOD mirrors research-rsim-p.sh: ONE disposable --vnc-experimental clone
# `rsim-p2-lab` of things-lab-golden-v1 (golden untouched). Airgap + pin clock
# 2026-07-05 12:00. Accessibility via AXVM1 rung-b VNC toggle. Ship the PRODUCTION
# e2e bundle, enable ui-enabled, run the cases. Each case snapshots the guest Things
# DB (read-only, WAL-consistent) into host JSON before/after; a host differ reports
# the full row-level delta across TMTask + TMTaskTag + TMChecklistItem. make-repeating
# is a ui-vector op → --dangerously-drive-gui (NOT --allow-disruptive). Fixtures fully
# synthetic (public repo). Ground truth = DB deltas driven through the SHIPPED CLI.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

VM="rsim-p2-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps" "$OUT/show"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[rsimp2] $*" | tee -a "$REPORT"; }
cleanup() { echo "[rsimp2] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
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
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[rsimp2] /'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# ---------------- guest helpers: read-only SQLite + snapshot dumper ----------------
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# rsnap.py: TMTask (recurrence + containment + creationDate/userModificationDate;
# rule blob decoded), TMTaskTag, TMChecklistItem, TMArea name map -> ONE JSON.
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

# kids.py <project-uuid>: full containment subtree; each row shows type/status/start/
# trashed + (rule? tmpl) so a NESTED repeater child is visible.
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

# fk <template-uuid>: the rt1_repeatingTemplate FK lookup (B4) — every row pointing at it.
fk() {
  note "  FK: rows with rt1_repeatingTemplate=$1"
  gq "SELECT uuid,title,type,status,trashed,project,heading FROM TMTask WHERE rt1_repeatingTemplate='$1'" | sed 's/^/    /' | tee -a "$REPORT"
}

# ---------------- host-side differ ----------------
cat > "$OUT/diff_snaps.py" <<'EOF'
import sys, json
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d(%d)"%(y,m,d,v) if 1<y<5000 else v
def cocoa(v):  # creationDate/userModificationDate are Cocoa secs since 2001-01-01
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
def ttkey(x): return "%s|%s"%(x["task"],x["tag"])
at={ttkey(x):x for x in A["tasktags"]}; bt={ttkey(x):x for x in B["tasktags"]}
tt_ins=[k for k in bt if k not in at]; tt_del=[k for k in at if k not in bt]
if tt_ins or tt_del:
    print("  TMTaskTag  ADDED: %d  REMOVED: %d"%(len(tt_ins),len(tt_del)))
    for k in tt_ins: x=bt[k]; print("  + TAG  task=\"%s\"[%s] tag=%s"%(x["taskTitle"],str(x["task"])[:8],x["tagName"]))
    for k in tt_del: x=at[k]; print("  - TAG  task=\"%s\"[%s] tag=%s"%(x["taskTitle"],str(x["task"])[:8],x["tagName"]))
ac=A["checklist"] if isinstance(A["checklist"],dict) else {}
bc=B["checklist"] if isinstance(B["checklist"],dict) else {}
ci_ins=[u for u in bc if u not in ac and u!="__error__"]; ci_del=[u for u in ac if u not in bc and u!="__error__"]
if ci_ins or ci_del:
    print("  TMChecklistItem  INSERTED: %d  DELETED: %d"%(len(ci_ins),len(ci_del)))
    for u in ci_ins: x=bc[u]; print("  + CHK  %s '%s' task=\"%s\"[%s] status=%s"%(u,x.get("title"),x.get("taskTitle"),str(x.get("task"))[:8],x.get("status")))
    for u in ci_del: x=ac[u]; print("  - CHK  %s '%s' task=\"%s\"[%s]"%(u,x.get("title"),x.get("taskTitle"),str(x.get("task"))[:8]))
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
showj() { G show "$1" --json > "$OUT/show/$2.json" 2>&1; note "  show $2 -> $OUT/show/$2.json ($(wc -c <"$OUT/show/$2.json" | tr -d ' ')B)"; }

STEMS="Proj Nest|Task N|Daily N|Proj NestAC|Task M|Daily M|Proj Edge|Done C|Trash C|Ext Rep|Proj Head|Head H|Headed T|Direct T|Ditto|Intruder"

# =====================================================================
# A1 — NESTED FIXED repeater: project w/ a fixed repeating to-do child, then
#      make the PROJECT repeating. The recursion question.
# =====================================================================
note ""; note "############### A1: nested FIXED repeater (todo make-repeating inside a project, then project make-repeating) ###############"
drive A1seedProj project add \"Proj Nest\" --todo \"Task N1\" --json
PN=$(uidp "Proj Nest"); note "  seed Proj Nest uuid=$PN"
drive A1seedN2 todo add \"Daily N2\" --project \"Proj Nest\" --json
N2=$(uidt "Daily N2"); note "  seed Daily N2 (plain, in project) uuid=$N2"
warm
drive A1mkN2 todo make-repeating "$N2" --frequency daily --interval 1 --dangerously-drive-gui --json
settle; snap a1-pre
note "  --- A1 pre-conversion subtree (Proj Nest) — where does the Daily N2 template live? ---"; kids "$PN"
N2TMPL=$(tmplt "Daily N2"); note "  Daily N2 template=$N2TMPL  instances=[$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$N2TMPL' AND trashed=0" | tr '\n' ' ')]"
warm
drive A1 project make-repeating "$PN" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap a1-post
note "  --- A1 delta pre -> post (project conversion) ---"; diff_c a1-pre a1-post "$STEMS"
PNTPL=$(tmplp "Proj Nest"); PNINS=$(instp "Proj Nest")
note "  A1 project template=$PNTPL  instance=$PNINS"
note "  --- A1 TEMPLATE-side subtree ---"; [ -n "$PNTPL" ] && kids "$PNTPL"
note "  --- A1 INSTANCE-side subtree ---"; [ -n "$PNINS" ] && kids "$PNINS"
note "  A1 nested-template inventory (Daily N2 rows now):"
gq "SELECT uuid,title,type,start,trashed,project,heading,(rt1_recurrenceRule IS NOT NULL) AS hasRule,rt1_repeatingTemplate FROM TMTask WHERE title='Daily N2'" | sed 's/^/    /' | tee -a "$REPORT"

# =====================================================================
# A2 — NESTED AFTER-COMPLETION repeater in a project, then convert the project.
# =====================================================================
note ""; note "############### A2: nested AFTER-COMPLETION repeater (todo make-repeating --after-completion inside a project, then project make-repeating) ###############"
drive A2seedProj project add \"Proj NestAC\" --todo \"Task M1\" --json
PM=$(uidp "Proj NestAC"); note "  seed Proj NestAC uuid=$PM"
drive A2seedM2 todo add \"Daily M2\" --project \"Proj NestAC\" --json
M2=$(uidt "Daily M2"); note "  seed Daily M2 (plain, in project) uuid=$M2"
warm
drive A2mkM2 todo make-repeating "$M2" --frequency daily --interval 1 --after-completion --dangerously-drive-gui --json
settle; snap a2-pre
note "  --- A2 pre-conversion subtree (Proj NestAC) ---"; kids "$PM"
M2TMPL=$(tmplt "Daily M2"); note "  Daily M2 template=$M2TMPL  instances=[$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$M2TMPL' AND trashed=0" | tr '\n' ' ')]"
warm
drive A2 project make-repeating "$PM" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap a2-post
note "  --- A2 delta pre -> post (project conversion) ---"; diff_c a2-pre a2-post "$STEMS"
PMTPL=$(tmplp "Proj NestAC"); PMINS=$(instp "Proj NestAC")
note "  A2 project template=$PMTPL  instance=$PMINS"
note "  --- A2 TEMPLATE-side subtree ---"; [ -n "$PMTPL" ] && kids "$PMTPL"
note "  --- A2 INSTANCE-side subtree ---"; [ -n "$PMINS" ] && kids "$PMINS"
note "  A2 nested-template inventory (Daily M2 rows now):"
gq "SELECT uuid,title,type,start,trashed,project,heading,(rt1_recurrenceRule IS NOT NULL) AS hasRule,rt1_repeatingTemplate FROM TMTask WHERE title='Daily M2'" | sed 's/^/    /' | tee -a "$REPORT"

# =====================================================================
# A3 — edge-state children: completed + trashed + external-instance. Convert.
# =====================================================================
note ""; note "############### A3: edge-state children (completed / trashed / external-repeating-instance), then project make-repeating ###############"
drive A3seedProj project add \"Proj Edge\" --todo \"Done C1\" --todo \"Trash C2\" --json
PE=$(uidp "Proj Edge"); note "  seed Proj Edge uuid=$PE"
DC1=$(uidt "Done C1"); TC2=$(uidt "Trash C2")
drive A3complete todo complete "$DC1" --json
note "  Done C1 status now=$(gq "SELECT status FROM TMTask WHERE uuid='$DC1'")"
# trash Trash C2 via the app's AppleScript surface (delete = move to Trash, trashed=1)
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to delete to do id \"$TC2\"'" </dev/null 2>&1 | sed 's/^/  [A3trash-as] /' | tee -a "$REPORT"
note "  Trash C2 trashed now=$(gq "SELECT trashed FROM TMTask WHERE uuid='$TC2'")"
# external repeating to-do (fixed daily) OUTSIDE the project, then MOVE its instance INTO Proj Edge
drive A3extSeed todo add \"Ext Rep\" --json
ER=$(uidt "Ext Rep")
warm
drive A3extMk todo make-repeating "$ER" --frequency daily --interval 1 --dangerously-drive-gui --json
settle
ERTMPL=$(tmplt "Ext Rep"); ERINST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$ERTMPL' AND trashed=0 LIMIT 1")
note "  Ext Rep template=$ERTMPL  external instance=$ERINST"
drive A3extMove todo move "$ERINST" --project \"Proj Edge\" --json
note "  Ext Rep instance now proj=$(gq "SELECT project FROM TMTask WHERE uuid='$ERINST'") (should be Proj Edge=$PE)"
settle; snap a3-pre
note "  --- A3 pre-conversion subtree (Proj Edge) ---"; kids "$PE"
warm
drive A3 project make-repeating "$PE" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap a3-post
note "  --- A3 delta pre -> post ---"; diff_c a3-pre a3-post "$STEMS"
PETPL=$(tmplp "Proj Edge"); PEINS=$(instp "Proj Edge")
note "  A3 project template=$PETPL  instance=$PEINS"
note "  --- A3 TEMPLATE-side subtree ---"; [ -n "$PETPL" ] && kids "$PETPL"
note "  --- A3 INSTANCE-side subtree ---"; [ -n "$PEINS" ] && kids "$PEINS"
note "  A3 external-template FK after conversion (does a duplicated copy still point at Ext Rep template?):"; fk "$ERTMPL"
note "  A3 Done C1 / Trash C2 rows now:"
gq "SELECT uuid,title,status,trashed,project,heading FROM TMTask WHERE title IN ('Done C1','Trash C2')" | sed 's/^/    /' | tee -a "$REPORT"

# =====================================================================
# A5 — after-completion PROJECT WITH A HEADING (coordinator addendum): do the
#      instance-side copied HEADING rows carry rt1_repeatingTemplate links?
# =====================================================================
note ""; note "############### A5: after-completion project WITH a heading — do instance-side HEADING rows get FK links? ###############"
PJSON='[{"type":"project","attributes":{"title":"Proj Head","items":[{"type":"heading","attributes":{"title":"Head H1"}}]}}]'
lab_ssh "$IP" "open 'things:///json?data=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$PJSON")'; sleep 3" </dev/null
PH=$(uidp "Proj Head"); note "  seed Proj Head uuid=$PH"
drive A5seedHeaded todo add \"Headed T1\" --project \"Proj Head\" --heading \"Head H1\" --json
drive A5seedDirect todo add \"Direct T2\" --project \"Proj Head\" --json
settle; snap a5-pre
note "  --- A5 pre-conversion subtree (Proj Head) ---"; kids "$PH"
warm
drive A5 project make-repeating "$PH" --frequency weekly --interval 1 --after-completion --dangerously-drive-gui --json
settle; snap a5-post
note "  --- A5 delta pre -> post ---"; diff_c a5-pre a5-post "$STEMS"
PHTPL=$(tmplp "Proj Head"); PHINS=$(instp "Proj Head")
note "  A5 project template=$PHTPL  instance=$PHINS"
note "  --- A5 TEMPLATE-side subtree ---"; [ -n "$PHTPL" ] && kids "$PHTPL"
note "  --- A5 INSTANCE-side subtree ---"; [ -n "$PHINS" ] && kids "$PHINS"
note "  A5 all Head H1 / Headed T1 / Direct T2 rows (type + tmpl link):"
gq "SELECT uuid,title,type,project,heading,rt1_repeatingTemplate FROM TMTask WHERE title IN ('Head H1','Headed T1','Direct T2') ORDER BY title" | sed 's/^/    /' | tee -a "$REPORT"

# =====================================================================
# B1 — same-title gauntlet: 3 "Ditto" to-dos (standalone / in-project /
#      already-repeating), then make the STANDALONE one repeating via the CLI.
# =====================================================================
note ""; note "############### B1: same-title 'Ditto' gauntlet — discovery correctness ###############"
drive B1seedStand todo add \"Ditto\" --json
DSTAND=$(gq "SELECT uuid FROM TMTask WHERE title='Ditto' AND type=0 AND project IS NULL AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
note "  standalone Ditto uuid=$DSTAND"
drive B1seedProjHost project add \"Ditto Host\" --json
drive B1seedInProj todo add \"Ditto\" --project \"Ditto Host\" --json
DINPROJ=$(gq "SELECT uuid FROM TMTask WHERE title='Ditto' AND type=0 AND project IS NOT NULL AND trashed=0 LIMIT 1")
note "  in-project Ditto uuid=$DINPROJ"
# a third Ditto made repeating first -> its own template+instance both titled Ditto
drive B1seedRepSrc todo add \"Ditto\" --json
DREPSRC=$(gq "SELECT uuid FROM TMTask WHERE title='Ditto' AND type=0 AND project IS NULL AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 AND uuid!='$DSTAND' ORDER BY creationDate DESC LIMIT 1")
note "  soon-to-repeat Ditto uuid=$DREPSRC"
warm
drive B1mkRep todo make-repeating "$DREPSRC" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle
DREPTPL=$(gq "SELECT uuid FROM TMTask WHERE title='Ditto' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1")
note "  pre-existing Ditto template=$DREPTPL  its instance=[$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$DREPTPL' AND trashed=0" | tr '\n' ' ')]"
note "  --- B1 all Ditto rows BEFORE the standalone conversion ---"
gq "SELECT uuid,title,type,project,trashed,(rt1_recurrenceRule IS NOT NULL) AS rule,rt1_repeatingTemplate FROM TMTask WHERE title='Ditto'" | sed 's/^/    /' | tee -a "$REPORT"
snap b1-pre
warm
# THE test: make the STANDALONE Ditto repeating — does the CLI return the CORRECT new template uuid?
drive B1 todo make-repeating "$DSTAND" --frequency monthly --interval 1 --dangerously-drive-gui --json
settle; snap b1-post
note "  --- B1 delta pre -> post (only the standalone conversion) ---"; diff_c b1-pre b1-post "Ditto"
note "  --- B1 FULL CLI --json output (drive-B1.log) ---"; sed 's/^/    /' "$OUT/drive-B1.log" | tee -a "$REPORT"
# DB ground truth: the NEW template is the monthly one (fu=8); the pre-existing is weekly (fu=256)
note "  --- B1 all Ditto templates now (ground truth; new = monthly fu=8) ---"
gq "SELECT uuid,title,(rt1_recurrenceRule IS NOT NULL) AS rule,trashed FROM TMTask WHERE title='Ditto' AND rt1_recurrenceRule IS NOT NULL" | sed 's/^/    /' | tee -a "$REPORT"
note "  --- B1 decoded rules per Ditto template (host differ can't; dump raw fu via plist) ---"
lab_ssh "$IP" 'cat > /tmp/frule.py' <<'PYEOF'
import sqlite3,glob,plistlib,sys
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db,uri=True)
for u,rr in c.execute("SELECT uuid,rt1_recurrenceRule FROM TMTask WHERE title='Ditto' AND rt1_recurrenceRule IS NOT NULL AND trashed=0"):
    pl=plistlib.loads(rr); print("%s fu=%s fa=%s tp=%s"%(u,pl.get('fu'),pl.get('fa'),pl.get('tp')))
PYEOF
lab_ssh "$IP" 'python3 /tmp/frule.py' </dev/null | sed 's/^/    /' | tee -a "$REPORT"

# =====================================================================
# B2 — mid-write insertion: inject a same-title row the pre-read never saw.
#   (a) inject a PLAIN same-title to-do right AFTER invoking the CLI (during the
#       GUI drive), (b) inject a same-title TEMPLATE-shaped row is impractical to
#       time; approximate by racing a plain add. Document the realistic window.
# =====================================================================
note ""; note "############### B2: mid-write insertion (same-title row unseen by pre-read) ###############"
for TRY in 1 2 3; do
  drive B2seed$TRY todo add \"Intruder\" --json
  ISUB=$(gq "SELECT uuid FROM TMTask WHERE title='Intruder' AND type=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
  note "  try$TRY subject Intruder uuid=$ISUB"
  warm
  # fire the CLI in the background, then race an injected same-title add mid-drive
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js todo make-repeating $ISUB --frequency weekly --interval 1 --dangerously-drive-gui --json ; echo EXIT=\$?" </dev/null > "$OUT/drive-B2try$TRY.log" 2>&1 &
  DRV=$!
  sleep 2
  # inject a NEW plain same-title row the pre-read never captured (approximates the race)
  lab_ssh "$IP" "open 'things:///add?title=Intruder'" </dev/null 2>&1 | sed "s/^/  [B2try$TRY-inject] /"
  INJ=$(gq "SELECT uuid FROM TMTask WHERE title='Intruder' AND type=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 AND uuid!='$ISUB' ORDER BY creationDate DESC LIMIT 1")
  wait $DRV
  { grep -m1 '"ok"\|"error"' "$OUT/drive-B2try$TRY.log" || echo '(no ok/error)'; } | sed "s/^/  [B2try$TRY] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive-B2try$TRY.log" | sed "s/^/  [B2try$TRY] /" | tee -a "$REPORT"
  settle
  ITMPL=$(gq "SELECT uuid FROM TMTask WHERE title='Intruder' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
  note "  try$TRY: injected plain row=$INJ  minted template=$ITMPL"
  note "  try$TRY: all Intruder rows:"
  gq "SELECT uuid,title,(rt1_recurrenceRule IS NOT NULL) AS rule,rt1_repeatingTemplate,trashed FROM TMTask WHERE title='Intruder'" | sed 's/^/    /' | tee -a "$REPORT"
  # clean up Intruder rows so the next try starts fresh-ish (trash them via AS)
  for U in $(gq "SELECT uuid FROM TMTask WHERE title='Intruder' AND trashed=0"); do
    lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to delete to do id \"$U\"'" </dev/null 2>&1 >/dev/null || true
  done
  settle
done
note "  B2 note: the injected row is PLAIN (not a template) — discovery asserts repeating.isTemplate, so a plain same-title racer is filtered. The dangerous window is a same-title TEMPLATE minted after the pre-read; see the writeup analysis."

# =====================================================================
# B3 — source-fingerprint viability: which source fields the minted template +
#      instance inherit verbatim (reuses A1 fixed todo Daily N2, plus a dedicated
#      rich standalone todo with notes+tag+deadline+checklist).
# =====================================================================
note ""; note "############### B3: source-fingerprint viability (rich to-do -> fixed repeating) ###############"
drive B3seed todo add \"Fingerprint Src\" --notes \"fp notes body\" --tags FPTag --create-tags --deadline 2026-08-15 --checklist-item \"FP Sub1\" --checklist-item \"FP Sub2\" --json
FS=$(uidt "Fingerprint Src")
note "  Fingerprint Src uuid=$FS"
note "  --- B3 source row (pre-conversion) ---"
gq "SELECT uuid,title,notes,deadline,project,heading FROM TMTask WHERE uuid='$FS'" | sed 's/^/    /' | tee -a "$REPORT"
snap b3-pre
warm
drive B3 todo make-repeating "$FS" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap b3-post
note "  --- B3 delta pre -> post ---"; diff_c b3-pre b3-post "Fingerprint"
FSTPL=$(tmplt "Fingerprint Src"); FSINST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$FSTPL' AND trashed=0 LIMIT 1")
note "  B3 template=$FSTPL  instance=$FSINST"
note "  --- B3 template vs instance field inheritance (notes/deadline/tags/checklist) ---"
gq "SELECT uuid,title,notes,deadline,t2_deadlineOffset,reminderTime,project,heading FROM TMTask WHERE uuid IN ('$FSTPL','$FSINST')" | sed 's/^/    /' | tee -a "$REPORT"
note "  B3 tags on template/instance:"
gq "SELECT tt.tasks,t.title FROM TMTaskTag tt JOIN TMTag t ON tt.tags=t.uuid WHERE tt.tasks IN ('$FSTPL','$FSINST')" | sed 's/^/    /' | tee -a "$REPORT"
note "  B3 checklist on template/instance:"
gq "SELECT task,title FROM TMChecklistItem WHERE task IN ('$FSTPL','$FSINST')" | sed 's/^/    /' | tee -a "$REPORT"

# =====================================================================
# B4 — FK integrity: for every template minted this campaign, does
#      SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate=<tmpl> yield exactly
#      the instance(s)? Plus the after-completion project child-sibling pollution.
# =====================================================================
note ""; note "############### B4: rt1_repeatingTemplate FK integrity across all minted templates ###############"
note "  -- fixed to-do (B3 Fingerprint Src) --"; [ -n "$FSTPL" ] && fk "$FSTPL"
note "  -- fixed to-do (A1 nested Daily N2 template=$N2TMPL) --"; [ -n "$N2TMPL" ] && fk "$N2TMPL"
note "  -- after-completion to-do (A2 nested Daily M2 template=$M2TMPL) --"; [ -n "$M2TMPL" ] && fk "$M2TMPL"
note "  -- fixed PROJECT (A1 Proj Nest template=$PNTPL) --"; [ -n "$PNTPL" ] && fk "$PNTPL"
note "  -- fixed PROJECT (A2->but A2 project is FIXED conversion; template=$PMTPL) --"; [ -n "$PMTPL" ] && fk "$PMTPL"
note "  -- after-completion PROJECT (A5 Proj Head template=$PHTPL) — watch for child-sibling links polluting the project-level lookup --"; [ -n "$PHTPL" ] && fk "$PHTPL"
note "  B4 disambiguation probe: for the A5 after-completion project template, which FK rows are the PROJECT instance (type=1) vs child links (type=0/2)?"
[ -n "$PHTPL" ] && gq "SELECT uuid,title,type,project,heading FROM TMTask WHERE rt1_repeatingTemplate='$PHTPL' ORDER BY type" | sed 's/^/    /' | tee -a "$REPORT"

# =====================================================================
# A4 — clock-advance re-duplication probe (LAST — mutates the global clock).
# =====================================================================
note ""; note "############### A4: clock-advance past the next fixed occurrence (re-duplication?) ###############"
note "  A1 Proj Nest instance ($PNINS) next occurrence + nested Daily template next dates BEFORE advance:"
[ -n "$PNTPL" ] && gq "SELECT uuid,title,type,rt1_nextInstanceStartDate,rt1_instanceCreationStartDate FROM TMTask WHERE uuid='$PNTPL'" | sed 's/^/    /' | tee -a "$REPORT"
snap a4-pre
# advance to 2026-07-20 (past a weekly next of 2026-07-12 AND a second week 2026-07-19)
lab_ssh "$IP" 'sudo date 072012002026 >/dev/null' </dev/null
note "  clock advanced to $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
warm; settle; snap a4-mid
note "  --- A4 delta pre -> after 1st warm (clock=2026-07-20) ---"; diff_c a4-pre a4-mid "$STEMS"
warm; settle; snap a4-post
note "  --- A4 delta mid -> after 2nd warm ---"; diff_c a4-mid a4-post "$STEMS"
note "  A4 Proj Nest inventory after advance (new instances? fresh nested repeater?):"
gq "SELECT uuid,title,type,start,status,trashed,rt1_repeatingTemplate,(rt1_recurrenceRule IS NOT NULL) AS rule FROM TMTask WHERE title='Proj Nest'" | sed 's/^/    /' | tee -a "$REPORT"
gq "SELECT uuid,title,type,start,status,trashed,rt1_repeatingTemplate,(rt1_recurrenceRule IS NOT NULL) AS rule FROM TMTask WHERE title='Daily N2'" | sed 's/^/    /' | tee -a "$REPORT"
NEWPNINS=$(gq "SELECT uuid FROM TMTask WHERE title='Proj Nest' AND type=1 AND rt1_repeatingTemplate IS NOT NULL AND trashed=0 ORDER BY startDate DESC LIMIT 1")
[ -n "$NEWPNINS" ] && { note "  --- A4 newest Proj Nest instance subtree ($NEWPNINS) ---"; kids "$NEWPNINS"; }

note ""; env_line
note "DONE. report: $REPORT   snapshots: $OUT/snaps/   show: $OUT/show/"
