#!/bin/bash
# RSIM-P — repeating-PROJECT CHILDREN semantics (probe-backlog §C follow-up to RSIM).
# RSIM characterized the template+instance pair for repeating to-dos AND projects,
# but said NOTHING about the CHILDREN (to-dos + headings) of a repeating project.
# This campaign answers: when `project make-repeating` REPLACES a project that has
# children, are those children DUPLICATED (template-side + instance-side), MOVED, or
# orphaned? Do template-side children carry rt1_repeatingTemplate/start=2/markers or
# are they plain rows tied to templatehood only by their project pointer? Are
# TMTaskTag / TMChecklistItem rows duplicated for the copies? And the after-completion
# variant, the escape hatch (move a child in/out of a template project), and the
# show-surface `repeating` blocks.
#
# METHOD (mirrors research-rsim.sh exactly): ONE disposable --vnc-experimental clone
# `rsim-p-lab` of things-lab-golden-v1 (golden untouched). Airgap + pin clock
# 2026-07-05 12:00. Grant Accessibility via the AXVM1 rung-b VNC toggle (make-repeating
# is a ui-vector drive). Ship the PRODUCTION e2e bundle, enable ui-enabled, run P1..P5.
# Each case snapshots the guest Things DB (read-only, WAL-consistent) into host JSON
# before/after; a host differ reports the full row-level delta across TMTask + TMTaskTag
# + TMChecklistItem. Ground truth = DB deltas driven through the SHIPPED CLI.
#
# FIXTURES are fully synthetic (public repo): area "Zone A", project "Proj Alpha" with
# heading "Phase 1", to-do "Task A1" (tag + notes + 2-item checklist) under the heading,
# to-do "Task A2" direct in the project; plus "Plain Proj"/"Loose T1" (P3) and
# "Beta Proj"/"Task B1"/"Task B2" (P4).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

VM="rsim-p-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps" "$OUT/show"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[rsimp] $*" | tee -a "$REPORT"; }
cleanup() { echo "[rsimp] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---------------- preflight ----------------
if [ -z "$VNCDO" ] || [ ! -x "$VNCDO" ]; then note "FATAL: \$VNCDO (vncdotool) not set/executable. Abort."; exit 1; fi
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB, VNCDO=$VNCDO"
[ "${FREEGB:-0}" -lt 7 ] && { note "FATAL: <7GB free. Abort."; exit 1; }

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
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[rsimp] /'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# ---------------- guest helpers: read-only SQLite + snapshot dumper ----------------
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# rsnap.py: dump TMTask (all recurrence + containment cols; rule blob decoded),
# TMTaskTag (task,tag pairs with names resolved), TMChecklistItem, and a TMArea
# name map — as ONE uuid-addressable JSON. Read-only, WAL-consistent.
lab_ssh "$IP" 'cat > /tmp/rsnap.py' <<'EOF'
import sys, sqlite3, glob, plistlib, json
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
cols=["uuid","title","type","status","trashed","start","startDate","startBucket",
      "reminderTime","deadline","t2_deadlineOffset","\"index\"","todayIndex",
      "area","project","heading","notes","rt1_recurrenceRule","rt1_repeatingTemplate",
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
# tag name map
tagname={}
for u,t in c.execute("SELECT uuid,title FROM TMTag"): tagname[u]=t
# area name map
areas={}
for u,t in c.execute("SELECT uuid,title FROM TMArea"): areas[u]=t
# TMTaskTag pairs
tasktags=[]
for tk,tg in c.execute("SELECT tasks,tags FROM TMTaskTag"):
    tasktags.append({"task":tk,"taskTitle":(tasks.get(tk) or {}).get("title"),
                     "tag":tg,"tagName":tagname.get(tg)})
# TMChecklistItem
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

# kids.py <project-uuid>: print the full containment subtree of a project
# (headings + direct to-dos + headed to-dos), each with tag + checklist counts.
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
def m(u):
    r=q("SELECT (rt1_recurrenceRule IS NOT NULL),rt1_repeatingTemplate,start,status,trashed FROM TMTask WHERE uuid=?",u)
    return r[0] if r else None
row=q("SELECT title,type,start,status,trashed,rt1_repeatingTemplate,(rt1_recurrenceRule IS NOT NULL) FROM TMTask WHERE uuid=?",p)
print("PROJECT %s  %s"%(p,row[0] if row else "MISSING"))
for hu,ht,htr in q("SELECT uuid,title,trashed FROM TMTask WHERE type=2 AND project=? ORDER BY \"index\"",p):
    print("  HEADING %s '%s' trashed=%s tags=%d"%(hu,ht,htr,tc(hu)))
    for u,t,ty,stt,hd,pj,tr in q("SELECT uuid,title,type,status,heading,project,trashed FROM TMTask WHERE heading=? ORDER BY \"index\"",hu):
        print("    TODO(headed) %s '%s' type=%s status=%s proj=%s head=%s trashed=%s tags=%d chk=%d"%(u,t,ty,stt,pj,hd,tr,tc(u),cc(u)))
for u,t,ty,stt,hd,pj,tr in q("SELECT uuid,title,type,status,heading,project,trashed FROM TMTask WHERE project=? AND type=0 ORDER BY \"index\"",p):
    print("  TODO(direct) %s '%s' type=%s status=%s proj=%s head=%s trashed=%s tags=%d chk=%d"%(u,t,ty,stt,pj,hd,tr,tc(u),cc(u)))
EOF
kids() { lab_ssh "$IP" "python3 /tmp/kids.py $1" </dev/null | tee -a "$REPORT"; }

# ---------------- host-side differ ----------------
cat > "$OUT/diff_snaps.py" <<'EOF'
import sys, json
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d(%d)"%(y,m,d,v) if 1<y<5000 else v
DATEF={"startDate","deadline","rt1_instanceCreationStartDate","rt1_afterCompletionReferenceDate","rt1_nextInstanceStartDate"}
def rr(d):
    v=d.get("rt1_recurrenceRule")
    if v is None: return "NULL"
    if isinstance(v,dict) and "keys" in v: return "rule(%dB){%s}"%(v["size"],", ".join("%s=%s"%(k,v["keys"][k]) for k in v["keys"]))
    return str(v)
def ref(u,snap):  # resolve a uuid pointer to title(uuid8)
    if not u: return u
    t=(snap.get("tasks",{}).get(u) or {}).get("title")
    a=snap.get("areas",{}).get(u)
    lbl=t if t is not None else (a if a is not None else "?")
    return "%s[%s]"%(lbl,str(u)[:8])
def line(d,snap):
    f=[]
    f.append("type=%s status=%s trashed=%s start=%s"%(d.get("type"),d.get("status"),d.get("trashed"),d.get("start")))
    f.append("area=%s project=%s heading=%s"%(ref(d.get("area"),snap),ref(d.get("project"),snap),ref(d.get("heading"),snap)))
    f.append("startDate=%s deadline=%s"%(dpk(d.get("startDate")),dpk(d.get("deadline"))))
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
    d=a[u]; print("  - DELETE %s  \"%s\"  (was type=%s status=%s proj=%s head=%s rule=%s)"%(u,d.get("title"),d.get("type"),d.get("status"),ref(d.get("project"),A),ref(d.get("heading"),A),rr(d)))
for u,diffs in chg:
    print("  ~ CHANGE %s  \"%s\""%(u,b[u].get("title")))
    for k,(ov,nv) in sorted(diffs.items()):
        if k=="rt1_recurrenceRule": ov,nv=rr({"rt1_recurrenceRule":ov}),rr({"rt1_recurrenceRule":nv})
        elif k in ("project","heading","area","rt1_repeatingTemplate"): ov,nv=ref(ov,A),ref(nv,B)
        elif k in DATEF: ov,nv=dpk(ov),dpk(nv)
        print("      %s: %s -> %s"%(k,ov,nv))
# ----- TMTaskTag delta -----
def ttkey(x): return "%s|%s"%(x["task"],x["tag"])
at={ttkey(x):x for x in A["tasktags"]}; bt={ttkey(x):x for x in B["tasktags"]}
tt_ins=[k for k in bt if k not in at]; tt_del=[k for k in at if k not in bt]
if tt_ins or tt_del:
    print("  TMTaskTag  ADDED: %d  REMOVED: %d"%(len(tt_ins),len(tt_del)))
    for k in tt_ins: x=bt[k]; print("  + TAG  task=\"%s\"[%s] tag=%s"%(x["taskTitle"],str(x["task"])[:8],x["tagName"]))
    for k in tt_del: x=at[k]; print("  - TAG  task=\"%s\"[%s] tag=%s"%(x["taskTitle"],str(x["task"])[:8],x["tagName"]))
# ----- TMChecklistItem delta -----
ac=A["checklist"] if isinstance(A["checklist"],dict) else {}
bc=B["checklist"] if isinstance(B["checklist"],dict) else {}
ci_ins=[u for u in bc if u not in ac and u!="__error__"]; ci_del=[u for u in ac if u not in bc and u!="__error__"]
if ci_ins or ci_del:
    print("  TMChecklistItem  INSERTED: %d  DELETED: %d"%(len(ci_ins),len(ci_del)))
    for u in ci_ins: x=bc[u]; print("  + CHK  %s '%s' task=\"%s\"[%s] status=%s"%(u,x.get("title"),x.get("taskTitle"),str(x.get("task"))[:8],x.get("status")))
    for u in ci_del: x=ac[u]; print("  - CHK  %s '%s' task=\"%s\"[%s]"%(u,x.get("title"),x.get("taskTitle"),str(x.get("task"))[:8]))
EOF
diff_c() {  # diff_c <before> <after> [title-stems piped: "Proj Alpha|Phase 1|Task A"]
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
# G: run the CLI, return stdout (used to capture uuids). drive: run + log fully.
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
uidp()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }  # plain project
uidt()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }  # plain to-do
tmplp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }  # template project
instp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_repeatingTemplate IS NOT NULL AND trashed=0 LIMIT 1"; } # instance project
env_line() { note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"; }
showj() { G show "$1" --json > "$OUT/show/$2.json" 2>&1; note "  show $2 -> $OUT/show/$2.json ($(wc -c <"$OUT/show/$2.json" | tr -d ' ')B)"; }

STEMS="Proj Alpha|Phase 1|Task A|Task B|Beta Proj|Plain Proj|Loose T"

# =====================================================================
# P1 — conversion cascade: make an existing PROJECT-with-children repeating
# =====================================================================
note ""; note "############### P1: project make-repeating (project w/ heading + tagged/checklisted children) ###############"
G area add \"Zone A\" >"$OUT/mk-area.log" 2>&1; note "  area add Zone A: $(grep -m1 'ok\|error' "$OUT/mk-area.log" || echo done)"
# project + heading via things:///json (seed path — headings only mint inside a new-project payload)
PJSON='[{"type":"project","attributes":{"title":"Proj Alpha","area":"Zone A","items":[{"type":"heading","attributes":{"title":"Phase 1"}}]}}]'
lab_ssh "$IP" "open 'things:///json?data=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$PJSON")'; sleep 3" </dev/null
PA=$(uidp "Proj Alpha"); note "  seed Proj Alpha uuid=$PA"
drive P1seedA1 todo add \"Task A1\" --project \"Proj Alpha\" --heading \"Phase 1\" --notes \"alpha notes\" --tags AlphaTag --create-tags --checklist-item \"Sub 1\" --checklist-item \"Sub 2\" --json
drive P1seedA2 todo add \"Task A2\" --project \"Proj Alpha\" --json
settle; snap p1-A
note "  --- P1 pre-state subtree (Proj Alpha=$PA) ---"; kids "$PA"
warm
drive P1 project make-repeating "$PA" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap p1-Bimm
note "  --- P1 delta A -> B(immediate) ---"; diff_c p1-A p1-Bimm "$STEMS"
warm; settle; snap p1-Bwarm
note "  --- P1 delta B(immediate) -> B(after warm/maintenance) ---"; diff_c p1-Bimm p1-Bwarm "$STEMS"
TPL=$(tmplp "Proj Alpha"); INS=$(instp "Proj Alpha")
note "  P1 template project=$TPL  instance project=$INS"
note "  --- P1 TEMPLATE-side subtree ---"; kids "$TPL"
note "  --- P1 INSTANCE-side subtree ---"; kids "$INS"

# =====================================================================
# P2 — instance-spawn cascade: complete the INSTANCE project
# =====================================================================
note ""; note "############### P2: complete the instance project (spawn cascade) ###############"
if [ -z "$INS" ]; then
  note "  P2: no instance project captured — skipping"
else
  settle; snap p2-A
  drive P2 project complete "$INS" --children auto-complete --json
  ST=$(gq "SELECT status FROM TMTask WHERE uuid='$INS'")
  if [ "$ST" != "3" ]; then
    note "  P2: CLI did not complete the instance (status=$ST) — trying the app's own surface (AppleScript)"
    lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to set status of project id \"$INS\" to completed'" </dev/null 2>&1 | sed 's/^/  [P2-as] /' | tee -a "$REPORT"
    ST=$(gq "SELECT status FROM TMTask WHERE uuid='$INS'"); note "  P2: instance status after AppleScript=$ST"
  fi
  settle; snap p2-Bimm
  note "  --- P2 delta A -> B(immediate) ---"; diff_c p2-A p2-Bimm "$STEMS"
  warm; settle; snap p2-Bwarm
  note "  --- P2 delta B(immediate) -> B(after warm/maintenance) ---"; diff_c p2-Bimm p2-Bwarm "$STEMS"
  note "  P2 template project still=$(tmplp "Proj Alpha")  live instances now:"
  gq "SELECT uuid,title,status,start FROM TMTask WHERE type=1 AND rt1_repeatingTemplate='$TPL'" | sed 's/^/    /' | tee -a "$REPORT"
  NEWINS=$(instp "Proj Alpha")
  [ -n "$NEWINS" ] && { note "  --- P2 spawned/updated instance subtree ($NEWINS) ---"; kids "$NEWINS"; }
fi

# =====================================================================
# P3 — escape hatch: move a TEMPLATE-side child out to a plain project; and a
#      plain to-do INTO the template project
# =====================================================================
note ""; note "############### P3: escape hatch (move child out of / into template project) ###############"
G area add \"Zone A\" >/dev/null 2>&1 || true
drive P3seedProj project add \"Plain Proj\" --json
drive P3seedTodo todo add \"Loose T1\" --project \"Plain Proj\" --json
PP=$(uidp "Plain Proj"); LT=$(uidt "Loose T1"); note "  Plain Proj=$PP  Loose T1=$LT"
# forward: a template-side child (project=TPL or heading in TPL's headings) -> Plain Proj
TCHILD=$(gq "SELECT uuid FROM TMTask WHERE type=0 AND trashed=0 AND (project='$TPL' OR heading IN (SELECT uuid FROM TMTask WHERE type=2 AND project='$TPL')) LIMIT 1")
if [ -z "$TCHILD" ]; then
  note "  P3-forward: NO template-side child to-do exists (template has no own children copies) — premise falsified; documenting"
else
  note "  P3-forward: moving template-side child $TCHILD -> Plain Proj"
  settle; snap p3f-A
  drive P3fwd todo move "$TCHILD" --project \"Plain Proj\" --json
  settle; snap p3f-B
  note "  --- P3-forward delta ---"; diff_c p3f-A p3f-B "$STEMS"
  note "  moved child now:"; gq "SELECT uuid,title,type,status,start,project,heading,rt1_repeatingTemplate FROM TMTask WHERE uuid='$TCHILD'" | sed 's/^/    /' | tee -a "$REPORT"
fi
# reverse: plain Loose T1 -> INTO the template project (by template uuid)
if [ -n "$LT" ] && [ -n "$TPL" ]; then
  note "  P3-reverse: moving plain Loose T1 ($LT) INTO template project ($TPL)"
  settle; snap p3r-A
  drive P3rev todo move "$LT" --project "$TPL" --json
  settle; snap p3r-B
  note "  --- P3-reverse delta ---"; diff_c p3r-A p3r-B "$STEMS"
  note "  Loose T1 now:"; gq "SELECT uuid,title,type,status,start,project,heading,rt1_repeatingTemplate FROM TMTask WHERE uuid='$LT'" | sed 's/^/    /' | tee -a "$REPORT"
fi

# =====================================================================
# P4 — after-completion project with 2 children (original preserved?)
# =====================================================================
note ""; note "############### P4: project make-repeating AFTER-COMPLETION (2 children) ###############"
drive P4seed project add \"Beta Proj\" --todo \"Task B1\" --todo \"Task B2\" --json
BP=$(uidp "Beta Proj"); note "  seed Beta Proj uuid=$BP"
settle; snap p4-A
note "  --- P4 pre-state subtree (Beta Proj=$BP) ---"; kids "$BP"
warm
drive P4 project make-repeating "$BP" --frequency weekly --interval 1 --after-completion --dangerously-drive-gui --json
settle; snap p4-Bimm
note "  --- P4 delta A -> B(immediate) ---"; diff_c p4-A p4-Bimm "$STEMS"
warm; settle; snap p4-Bwarm
note "  --- P4 delta B(immediate) -> B(after warm/maintenance) ---"; diff_c p4-Bimm p4-Bwarm "$STEMS"
BTPL=$(tmplp "Beta Proj"); BINS=$(instp "Beta Proj")
note "  P4 template=$BTPL  instance=$BINS  (BP preserved-as-instance if BINS==$BP)"
[ -n "$BINS" ] && { note "  --- P4 instance subtree ($BINS) ---"; kids "$BINS"; }
[ -n "$BTPL" ] && { note "  --- P4 template subtree ($BTPL) ---"; kids "$BTPL"; }

# =====================================================================
# P5 — show-surface evidence: repeating blocks on 4 refs
# =====================================================================
note ""; note "############### P5: things show --json on template/instance project + children ###############"
[ -n "$TPL" ] && showj "$TPL" template-project
[ -n "$INS" ] && showj "$INS" instance-project
# a template-side child (if any) and an instance-side child
ICHILD=$(gq "SELECT uuid FROM TMTask WHERE type=0 AND trashed=0 AND (project='$INS' OR heading IN (SELECT uuid FROM TMTask WHERE type=2 AND project='$INS')) LIMIT 1")
TCHILD2=$(gq "SELECT uuid FROM TMTask WHERE type=0 AND trashed=0 AND (project='$TPL' OR heading IN (SELECT uuid FROM TMTask WHERE type=2 AND project='$TPL')) LIMIT 1")
[ -n "$TCHILD2" ] && showj "$TCHILD2" template-child
[ -n "$ICHILD" ] && showj "$ICHILD" instance-child
note "  (P5 also emits per-child show JSON; repeating blocks quoted in the writeup)"

note ""; env_line
note "DONE. report: $REPORT   snapshots: $OUT/snaps/   show: $OUT/show/"
