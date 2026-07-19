#!/bin/bash
# RSIM-S — SPAWN semantics (next-occurrence instance generation) + Quick Find
# visibility of template-side children. RSIM-P/RSIM-P2 characterized CONVERSION
# (template + instance minted at convert-time, subtree deep-copied). RSIM-S closes
# the parked boundary: what the app writes at the NEXT-OCCURRENCE SPAWN, using a
# DAILY fixed repeater (next occurrence = tomorrow) and SMALL (+1/+2 day) clock
# advances to beat the +15-day wedge that clobbered RSIM-P2 A4.
#
# Q1 SPAWN: author a daily fixed repeating PROJECT; prepare the TEMPLATE subtree with
#   completed / canceled / trashed / someday / scheduled / deadline / plain / heading
#   child states (all plain rows, CLI-settable); advance the clock +1 day, relaunch +
#   nudge Upcoming/Today; diff to observe the spawned occurrence's child handling.
# Q2 QUICK FIND: AX-drive Cmd-F, type a template-side child title, dump the results
#   list; edit a template child to a unique title and search that (zero results proves
#   Quick Find hides template children).
#
# METHOD mirrors research-rsim-p2.sh: ONE disposable --vnc-experimental clone
# `rsim-s-lab` of things-lab-golden-v1 (golden untouched). Airgap + pin clock
# 2026-07-05 12:00. Accessibility via AXVM1 rung-b VNC toggle. Ship the PRODUCTION
# e2e bundle. Guest helpers live in ~/things-lab/helpers (persist a reboot, unlike
# /tmp). make-repeating is a ui-vector op -> --dangerously-drive-gui. Fixtures fully
# synthetic. Ground truth = guest Things-DB row deltas driven through the SHIPPED CLI.
# NO teardown trap: the VM is LEFT RUNNING at the end for adaptive clock follow-up;
# tear down explicitly with `tart delete rsim-s-lab`.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

VM="rsim-s-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps" "$OUT/ax"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[rsims] $*" | tee -a "$REPORT"; }
STATE="$OUT/state.env"; : > "$STATE"
sav() { echo "$1=$2" >> "$STATE"; }

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
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"; sav IP "$IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[rsims] /'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock pinned: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

# ---------------- guest helpers (PERSISTENT ~/things-lab/helpers — survive a reboot) ----------------
HELP='~/things-lab/helpers'
lab_ssh "$IP" 'mkdir -p ~/things-lab/helpers' </dev/null
lab_ssh "$IP" 'cat > ~/things-lab/helpers/gsql.sh && chmod +x ~/things-lab/helpers/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# rsnap.py — TMTask (recurrence+containment+dates; rule decoded) + TMTaskTag + TMChecklistItem + TMArea
lab_ssh "$IP" "cat > ~/things-lab/helpers/rsnap.py" <<'EOF'
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
    tasktags.append({"task":tk,"taskTitle":(tasks.get(tk) or {}).get("title"),"tag":tg,"tagName":tagname.get(tg)})
checklist={}
try:
    for cu,tk,ti,st,ix in c.execute('SELECT uuid,task,title,status,"index" FROM TMChecklistItem'):
        checklist[cu]={"task":tk,"taskTitle":(tasks.get(tk) or {}).get("title"),"title":ti,"status":st,"index":ix}
except Exception as e:
    checklist={"__error__":str(e)}
json.dump({"tasks":tasks,"tasktags":tasktags,"checklist":checklist,"areas":areas},sys.stdout,default=str)
EOF
snap() { lab_ssh "$IP" 'python3 ~/things-lab/helpers/rsnap.py' </dev/null > "$OUT/snaps/$1.json"; note "  snap $1 ($(wc -c <"$OUT/snaps/$1.json"|tr -d ' ')B)"; }

# kids.py <project-uuid>: full containment subtree; per row type/status/start/trashed + (rule? tmpl)
lab_ssh "$IP" "cat > ~/things-lab/helpers/kids.py" <<'EOF'
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
def dts(u): return q("SELECT startBucket,startDate,deadline,status,start FROM TMTask WHERE uuid=?",u)[0]
def sh(u):
    sb,sd,dl,st,srt=dts(u)
    return "rule=%s tmpl=%s startBucket=%s startDate=%s deadline=%s"%(rule(u),(str(tmpl(u))[:8] if tmpl(u) else None),sb,sd,dl)
row=q("SELECT title,type,start,status,trashed FROM TMTask WHERE uuid=?",p)
print("PROJECT %s  %s  start=%s status=%s %s"%(p, row[0][0] if row else "MISSING", row[0][2] if row else "?", row[0][3] if row else "?", sh(p) if row else ""))
for hu,ht,hst,htr in q("SELECT uuid,title,status,trashed FROM TMTask WHERE type=2 AND project=? ORDER BY \"index\"",p):
    print("  HEADING %s '%s' status=%s trashed=%s [%s]"%(hu,ht,hst,htr,sh(hu)))
    for u,t,ty,stt,tr in q("SELECT uuid,title,type,status,trashed FROM TMTask WHERE heading=? ORDER BY \"index\"",hu):
        print("    TODO(headed) %s '%s' type=%s status=%s trashed=%s tags=%d chk=%d [%s]"%(u,t,ty,stt,tr,tc(u),cc(u),sh(u)))
for u,t,ty,stt,hd,tr in q("SELECT uuid,title,type,status,heading,trashed FROM TMTask WHERE project=? AND type=0 ORDER BY \"index\"",p):
    print("  TODO(direct) %s '%s' type=%s status=%s head=%s trashed=%s tags=%d chk=%d [%s]"%(u,t,ty,stt,(str(hd)[:8] if hd else None),tr,tc(u),cc(u),sh(u)))
# include trashed children whose project pointer still targets p (trash keeps the link)
for u,t,ty,stt,hd,tr in q("SELECT uuid,title,type,status,heading,trashed FROM TMTask WHERE project=? AND type=0 AND trashed=1",p):
    print("  TODO(trashed-still-linked) %s '%s' status=%s [%s]"%(u,t,stt,sh(u)))
EOF
kids() { lab_ssh "$IP" "python3 ~/things-lab/helpers/kids.py $1" </dev/null | tee -a "$REPORT"; }

# ---------------- host-side differ (same shape as rsim-p2) ----------------
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
    f.append("type=%s status=%s trashed=%s start=%s startBucket=%s"%(d.get("type"),d.get("status"),d.get("trashed"),d.get("start"),d.get("startBucket")))
    f.append("area=%s project=%s heading=%s"%(ref(d.get("area"),snap),ref(d.get("project"),snap),ref(d.get("heading"),snap)))
    f.append("startDate=%s deadline=%s creationDate=%s"%(dpk(d.get("startDate")),dpk(d.get("deadline")),cocoa(d.get("creationDate"))))
    f.append("tmpl=%s"%ref(d.get("rt1_repeatingTemplate"),snap))
    f.append("icCount=%s next=%s acRef=%s icStart=%s"%(d.get("rt1_instanceCreationCount"),dpk(d.get("rt1_nextInstanceStartDate")),dpk(d.get("rt1_afterCompletionReferenceDate")),dpk(d.get("rt1_instanceCreationStartDate"))))
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
diff_c() { python3 "$OUT/diff_snaps.py" "$OUT/snaps/$1.json" "$OUT/snaps/$2.json" "${3:-}" | tee -a "$REPORT"; }

# ---------------- AXVM1 rung-b: grant Accessibility via VNC ----------------
note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
if [ -z "$VNC_URL" ]; then note "FATAL: no VNC url in tart-run.log. Abort."; exit 1; fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
sav SERVER "$SERVER"; sav PASS "$PASS"; sav VNC_URL "$VNC_URL"
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
nudge() { lab_ssh "$IP" "open 'things:///show?id=upcoming'; sleep 4; open 'things:///show?id=today'; sleep 6" </dev/null; }
tmplp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
instp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_repeatingTemplate IS NOT NULL AND trashed=0 ORDER BY startDate LIMIT 1"; }
uidp()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
childu(){ gq "SELECT uuid FROM TMTask WHERE title='$1' AND project='$2' AND trashed=0 LIMIT 1"; }
env_line() { note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"; }
alive() { lab_ssh "$IP" 'test -f ~/things-lab/helpers/rsnap.py && echo HELPERS-OK && uptime' </dev/null; }

# =====================================================================
# S-SETUP — daily fixed repeating PROJECT with a rich child set, then prepare
#           the TEMPLATE-side subtree with the 8 target child states.
# =====================================================================
note ""; note "############### S-SETUP: seed plain project + heading + children ###############"
# heading requires a new-project json payload (headings only mint inside a project payload)
PJSON='[{"type":"project","attributes":{"title":"RS Daily","items":[{"type":"heading","attributes":{"title":"RS Head"}}]}}]'
lab_ssh "$IP" "open 'things:///json?data=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$PJSON")'; sleep 3" </dev/null
PD=$(uidp "RS Daily"); note "  seed RS Daily uuid=$PD"; sav PD "$PD"
drive S_headed  todo add \"RS Headed\"  --project \"RS Daily\" --heading \"RS Head\" --json
drive S_done    todo add \"RS Done\"    --project \"RS Daily\" --json
drive S_cancel  todo add \"RS Cancel\"  --project \"RS Daily\" --json
drive S_trash   todo add \"RS Trash\"   --project \"RS Daily\" --json
drive S_someday todo add \"RS Someday\" --project \"RS Daily\" --json
drive S_sched   todo add \"RS Sched\"   --project \"RS Daily\" --json
drive S_deadln  todo add \"RS Deadline\" --project \"RS Daily\" --json
drive S_plain   todo add \"RS Plain\"   --project \"RS Daily\" --json
settle; snap seed-pre
note "  --- seed subtree (plain project, before conversion) ---"; kids "$PD"

# Convert RS Daily to a DAILY FIXED repeater (next occurrence = 2026-07-06).
note ""; note "############### S-SETUP: convert RS Daily -> DAILY FIXED repeating ###############"
warm
drive S_convert project make-repeating "$PD" --frequency daily --interval 1 --dangerously-drive-gui --json
settle; snap convert-post
note "  --- convert delta (seed-pre -> convert-post) ---"; diff_c seed-pre convert-post ""
TPL=$(tmplp "RS Daily"); INS0=$(instp "RS Daily")
note "  RS Daily template=$TPL  first-instance(07-05)=$INS0"; sav TPL "$TPL"; sav INS0 "$INS0"
[ -z "$TPL" ] && { note "FATAL: no template row found after conversion. VM left up for inspection."; exit 1; }
note "  --- TEMPLATE subtree (pre-mutation) ---"; kids "$TPL"
note "  --- first INSTANCE(07-05) subtree ---"; [ -n "$INS0" ] && kids "$INS0"

# =====================================================================
# S-PREP — mutate the TEMPLATE-side children into the 8 target states.
#          (all are plain rows: moves/writes unguarded — verify each landed)
# =====================================================================
note ""; note "############### S-PREP: set template-side child states ###############"
T_DONE=$(childu "RS Done" "$TPL");     note "  tmpl RS Done=$T_DONE"
T_CANC=$(childu "RS Cancel" "$TPL");   note "  tmpl RS Cancel=$T_CANC"
T_TRSH=$(childu "RS Trash" "$TPL");    note "  tmpl RS Trash=$T_TRSH"
T_SMDY=$(childu "RS Someday" "$TPL");  note "  tmpl RS Someday=$T_SMDY"
T_SCHD=$(childu "RS Sched" "$TPL");    note "  tmpl RS Sched=$T_SCHD"
T_DEAD=$(childu "RS Deadline" "$TPL"); note "  tmpl RS Deadline=$T_DEAD"
for v in T_DONE T_CANC T_TRSH T_SMDY T_SCHD T_DEAD; do sav "$v" "${!v}"; done

drive P_done   todo complete "$T_DONE" --json
drive P_cancel todo cancel   "$T_CANC" --json
drive P_trash  todo delete   "$T_TRSH" --json
drive P_someday todo update  "$T_SMDY" --when someday --json
drive P_sched   todo update  "$T_SCHD" --when 2026-07-20 --json
drive P_deadln  todo update  "$T_DEAD" --deadline 2026-07-25 --json
settle
note "  --- verify each template-child write landed (status/trashed/startBucket/startDate/deadline) ---"
gq "SELECT title,status,trashed,startBucket,startDate,deadline FROM TMTask WHERE project='$TPL' AND type=0 ORDER BY title" | sed 's/^/    /' | tee -a "$REPORT"
snap prepared
note "  --- PREPARED template subtree (the spawn source) ---"; kids "$TPL"
note "  template next-occurrence fields:"
gq "SELECT title,rt1_instanceCreationCount,rt1_nextInstanceStartDate,rt1_instanceCreationStartDate FROM TMTask WHERE uuid='$TPL'" | sed 's/^/    /' | tee -a "$REPORT"

note ""; note "############### S-SETUP COMPLETE — VM LEFT RUNNING for clock phase ###############"
note "  state saved: $STATE"; cat "$STATE" | sed 's/^/    /'
env_line
note "  helpers alive check: $(alive | tr '\n' ' ')"
note "NEXT: clock-advance phase (S1) runs in the follow-up driver against IP=$IP."
