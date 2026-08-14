#!/bin/bash
# SRCFATE — consolidated single-VM probe sweep (2026-08-13). ONE disposable clone
# of things-lab-golden-v2 (Things 3.22.12, baked L3-accessibility). Worklists:
#
#  P1 (SF)  source-fate reconciliation — the TRSHREP R8/R9 flag ("a terminal element
#           anywhere in the source triggers make-repeating source-PRESERVE"). Clean
#           matrix ×2 reps: project{one completed child}, project{one canceled child},
#           to-do{one CHECKED checklist item} vs to-do{one UNCHECKED item}, project{open
#           child carrying a checked checklist item}, bare to-do + bare project{open child}
#           controls (expect DELETE). Fixed daily make-repeating (ui vector).
#  P2 (CVT) plain (non-instance) todo convert-to-project — new row or in-place flip?
#           creationDate preserved or conversion wall-clock? FK/content fate. ×2.
#  P3 (UMD) umd micro-cells on the OWNING row: checklist add/check/uncheck/edit/delete;
#           reminder set/clear; heading dissolve (surviving children); move-heading-to-
#           project (the heading row); title=/notes= writes (per-field bump confirmation).
#  P4 (PHC) project.promote-heading — new project's creationDate VALUE (identity settled;
#           expect wall-clock).
#  P5 (RSTG) RESTAGE-lite — a logged dated to-do whose date PASSED while logged, then
#           reopened: where does it land? byte-capture start/startDate/todayIndex/tiRef.
#  P6 (MISC) future-scheduled PROJECT row representation (start=2 vs start=1 + future date).
#
# METHOD mirrors research-trshrep.sh. golden-v2 baked AX (auth_value=2) so the ui-vector
# ops (make-repeating / convert-to-project / promote-heading / dissolve-heading /
# move-heading-to-project) drive via System Events over SSH, no VNC. Airgap + pin clock
# 2026-07-05 12:00, advance in SMALL +1/+2-day steps for P5. Ground truth = read-only guest
# SQLite row deltas through the SHIPPED CLI (guest e2e bundle). Fixtures fully synthetic.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="srcfate-lab"
GOLDEN="things-lab-golden-v2"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps" "$OUT/reads"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[srcfate] $*" | tee -a "$REPORT"; }
cleanup() { echo "[srcfate] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---------------- preflight ----------------
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB (golden=$GOLDEN)"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free. Abort."; exit 1; }

# ---------------- host toolchain (self-contained node) ----------------
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

# ---------------- clone + boot ----------------
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
airgap_pin() {
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1' </dev/null
}
airgap_pin
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[srcfate] /'
lab_ssh "$IP" 'sudo date 070512002026 >/dev/null' </dev/null

GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "Accessibility auth_value=$GRANT (2=granted, baked in golden-v2)"
[ "$GRANT" != "2" ] && { note "FATAL: Accessibility grant missing on clone (auth_value=$GRANT). Abort."; exit 1; }

# ---------------- guest helpers: reboot-surviving ~/things-lab/helpers ----------------
HELP='~/things-lab/helpers'
install_helpers() {
  lab_ssh "$IP" "mkdir -p $HELP" </dev/null
  lab_ssh "$IP" "cat > $HELP/gsql.sh && chmod +x $HELP/gsql.sh" <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
  lab_ssh "$IP" "cat > $HELP/rsnap.py" <<'EOF'
import sys, sqlite3, glob, plistlib, json
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
cols=["uuid","title","type","status","trashed","start","startDate","startBucket",
      "reminderTime","deadline","\"index\"","todayIndex","todayIndexReferenceDate","stopDate",
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
areas={}
for u,t in c.execute("SELECT uuid,title FROM TMArea"): areas[u]=t
checklist={}
try:
    for cu,tk,ti,st,ix in c.execute('SELECT uuid,task,title,status,"index" FROM TMChecklistItem'):
        checklist[cu]={"task":tk,"taskTitle":(tasks.get(tk) or {}).get("title"),
                       "title":ti,"status":st,"index":ix}
except Exception as e:
    checklist={"__error__":str(e)}
json.dump({"tasks":tasks,"areas":areas,"checklist":checklist},sys.stdout,default=str)
EOF
  lab_ssh "$IP" "cat > $HELP/kids.py" <<'EOF'
import sys, sqlite3, glob
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
p=sys.argv[1]
def q(sql,*a): return c.execute(sql,a).fetchall()
def cc(u):
    try: return q("SELECT COUNT(*) FROM TMChecklistItem WHERE task=?",u)[0][0]
    except: return -1
def rule(u): return q("SELECT (rt1_recurrenceRule IS NOT NULL) FROM TMTask WHERE uuid=?",u)[0][0]
def tmpl(u): return q("SELECT rt1_repeatingTemplate FROM TMTask WHERE uuid=?",u)[0][0]
def sh(u): return "rule=%s tmpl=%s"%(rule(u), (str(tmpl(u))[:8] if tmpl(u) else None))
row=q("SELECT title,type,start,status,trashed FROM TMTask WHERE uuid=?",p)
print("PROJECT %s  %s  start=%s status=%s trashed=%s %s"%(p, row[0][0] if row else "MISSING", row[0][2] if row else "?", row[0][3] if row else "?", row[0][4] if row else "?", sh(p) if row else ""))
for hu,ht,hst,htr in q("SELECT uuid,title,status,trashed FROM TMTask WHERE type=2 AND project=? ORDER BY \"index\"",p):
    print("  HEADING %s '%s' status=%s trashed=%s [%s]"%(hu,ht,hst,htr,sh(hu)))
    for u,t,ty,stt,hd,pj,tr,sd in q("SELECT uuid,title,type,status,heading,project,trashed,stopDate FROM TMTask WHERE heading=? ORDER BY \"index\"",hu):
        print("    TODO(headed) %s '%s' type=%s status=%s trashed=%s chk=%d stop=%s [%s]"%(u,t,ty,stt,tr,cc(u),sd,sh(u)))
for u,t,ty,stt,hd,pj,tr,sd in q("SELECT uuid,title,type,status,heading,project,trashed,stopDate FROM TMTask WHERE project=? AND type=0 ORDER BY \"index\"",p):
    print("  TODO(direct) %s '%s' type=%s status=%s head=%s trashed=%s chk=%d stop=%s [%s]"%(u,t,ty,stt,(str(hd)[:8] if hd else None),tr,cc(u),sd,sh(u)))
EOF
}
install_helpers
gq() { lab_ssh "$IP" "$HELP/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
snap() { lab_ssh "$IP" "python3 $HELP/rsnap.py" </dev/null > "$OUT/snaps/$1.json"; }
kids() { lab_ssh "$IP" "python3 $HELP/kids.py $1" </dev/null | tee -a "$REPORT"; }

# ---------------- host-side snapshot differ (before/after) ----------------
cat > "$OUT/diff_snaps.py" <<'EOF'
import sys, json
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d(%d)"%(y,m,d,v) if 1<y<5000 else v
def unixdate(v):
    try: v=float(v)
    except: return v
    import datetime
    return datetime.datetime.utcfromtimestamp(v).strftime("%Y-%m-%dT%H:%M:%S")
DATEF={"startDate","deadline","rt1_instanceCreationStartDate","rt1_afterCompletionReferenceDate","rt1_nextInstanceStartDate","todayIndexReferenceDate"}
UNIXF={"creationDate","userModificationDate","stopDate"}
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
    f.append("startDate=%s deadline=%s reminderTime=%s"%(dpk(d.get("startDate")),dpk(d.get("deadline")),d.get("reminderTime")))
    f.append("todayIndex=%s tiRef=%s creationDate=%s stopDate=%s"%(d.get("todayIndex"),dpk(d.get("todayIndexReferenceDate")),unixdate(d.get("creationDate")),unixdate(d.get("stopDate"))))
    f.append("tmpl=%s icCount=%s next=%s"%(ref(d.get("rt1_repeatingTemplate"),snap),d.get("rt1_instanceCreationCount"),dpk(d.get("rt1_nextInstanceStartDate"))))
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
ca=A.get("checklist",{}); cb=B.get("checklist",{})
def ckeep(d):
    if not stems: return True
    t=str((d or {}).get("taskTitle") or "")
    return any(t.startswith(s) for s in stems)
cins=[u for u in cb if u not in ca and isinstance(cb[u],dict) and ckeep(cb[u])]
cdel=[u for u in ca if u not in cb and isinstance(ca[u],dict) and ckeep(ca[u])]
cchg=[(u,ca[u],cb[u]) for u in cb if u in ca and isinstance(cb[u],dict) and ckeep(cb[u]) and ca[u]!=cb[u]]
print("  TMTask  INSERTED: %d  DELETED: %d  CHANGED: %d   | TMChecklistItem +%d/-%d/~%d"%(
    len(ins),len(dele),len(chg),len(cins),len(cdel),len(cchg)))
for u in ins:
    d=b[u]; print("  + INSERT %s  \"%s\"\n      %s"%(u,d.get("title"),line(d,B)))
for u in dele:
    d=a[u]; print("  - DELETE %s  \"%s\"  (was type=%s status=%s trashed=%s proj=%s head=%s stop=%s rule=%s)"%(u,d.get("title"),d.get("type"),d.get("status"),d.get("trashed"),ref(d.get("project"),A),ref(d.get("heading"),A),d.get("stopDate"),rr(d)))
for u,diffs in chg:
    print("  ~ CHANGE %s  \"%s\""%(u,b[u].get("title")))
    for k,(ov,nv) in sorted(diffs.items()):
        if k=="rt1_recurrenceRule": ov,nv=rr({"rt1_recurrenceRule":ov}),rr({"rt1_recurrenceRule":nv})
        elif k in ("project","heading","area","rt1_repeatingTemplate"): ov,nv=ref(ov,A),ref(nv,B)
        elif k in DATEF: ov,nv=dpk(ov),dpk(nv)
        elif k in UNIXF: ov,nv=unixdate(ov),unixdate(nv)
        print("      %s: %s -> %s"%(k,ov,nv))
for u in cins:
    d=cb[u]; print("  + CHK-INSERT '%s' status=%s task='%s'"%(d.get("title"),d.get("status"),d.get("taskTitle")))
for u in cdel:
    d=ca[u]; print("  - CHK-DELETE '%s' status=%s task='%s'"%(d.get("title"),d.get("status"),d.get("taskTitle")))
for u,ov,nv in cchg:
    print("  ~ CHK-CHANGE '%s' status %s->%s task='%s'"%(nv.get("title"),ov.get("status"),nv.get("status"),nv.get("taskTitle")))
EOF
diff_c() { python3 "$OUT/diff_snaps.py" "$OUT/snaps/$1.json" "$OUT/snaps/$2.json" "${3:-}" | tee -a "$REPORT"; }

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
lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1 || { note "FATAL: guest node not runnable after ship. Abort."; exit 1; }
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
drive() {
  local label="$1"; shift
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive-$label.log" 2>&1
  { grep -m1 '"ok"' "$OUT/drive-$label.log" || grep -m1 '"error"\|error:\|"blocked"\|refus' "$OUT/drive-$label.log" || echo '(no ok/error line — see drive log)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive-$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}
G config set ui-enabled true >/dev/null 2>&1
G config set allow-experimental true >/dev/null 2>&1

# native (destructive) make-repeating via `things batch` — the standalone
# `todo/project make-repeating` CLI now routes through PROMOTE-VIA-CLONE (2026-08-13:
# clone the source + trash the original + promote the clone), which HIDES the native
# source-fate behind a disposable clone. A `batch` line instead dispatches the NATIVE
# destructive promote (batch.ts §"batch make-repeating is the destructive native
# promote, not promote-via-clone"), so P1 observes the real app law on a source WE own.
mkrep_native() {  # <op> <uuid> <label>
  local op="$1" u="$2" label="$3"
  local jl="{\"op\":\"$op\",\"params\":{\"uuid\":\"$u\",\"frequency\":\"daily\",\"interval\":1},\"options\":{\"dangerouslyDriveGui\":true}}"
  lab_ssh "$IP" "printf '%s\n' '$jl' > /tmp/mk.jsonl" </dev/null
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js batch /tmp/mk.jsonl ; echo EXIT=\$?" </dev/null > "$OUT/drive-$label.log" 2>&1
  { grep -m1 'replacedUuid\|"kind":"mutation-result"\|"outcome"' "$OUT/drive-$label.log" || grep -m1 'error\|blocked\|invalid\|refus' "$OUT/drive-$label.log" || echo '(no result line — see drive log)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive-$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
env_line() { note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"; }

advance_to() {
  local dt="$1" label="$2"
  note ">>> advancing clock to $label ($dt) — quit, set date, warm relaunch, re-pin+reinstall helpers"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $dt >/dev/null" </dev/null
  note "    clock now: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
  lab_ssh "$IP" 'open -a Things3; sleep 16; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null
  airgap_pin
  lab_ssh "$IP" "test -f $HELP/gsql.sh && test -f $HELP/rsnap.py" </dev/null || { note "    helpers vanished — reinstalling"; install_helpers; }
  note "    post-relaunch clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
}

enc() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$1"; }

# resolvers
uidt()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
uidp()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
umd()   { gq "SELECT userModificationDate FROM TMTask WHERE uuid='$1'"; }
chkfor(){ gq "SELECT t.title||' | '||ci.title||' | status='||ci.status FROM TMChecklistItem ci JOIN TMTask t ON t.uuid=ci.task WHERE t.title LIKE '$1%' ORDER BY t.title, ci.\"index\"" | sed 's/^/    /' | tee -a "$REPORT"; }

env_line
note "packed dates: 07-05=132805248 07-06=132805376 07-07=132805504 07-08=132805632 07-09=132805760"

# =====================================================================
# P6 (MISC) — future-scheduled PROJECT row representation (start=2 vs 1?)
# =====================================================================
note ""; note "################################################################"
note "# P6 (MISC) — future-scheduled PROJECT row: start=2+future or start=1+future?"
note "################################################################"
lab_ssh "$IP" "open 'things:///add-project?title=MISC-FSP&when=2026-07-08'; sleep 3" </dev/null
note "  MISC-FSP row: $(gq "SELECT 'start='||start||' startDate='||COALESCE(startDate,'NULL')||' startBucket='||COALESCE(startBucket,'NULL')||' type='||type FROM TMTask WHERE title='MISC-FSP' AND type=1 LIMIT 1")   (to-do law = start=2 + future startDate; is a project the same?)"

# =====================================================================
# P1 (SF) — source-fate reconciliation matrix (×2 reps)
# =====================================================================
note ""; note "################################################################"
note "# P1 (SF) — make-repeating source-fate: terminal-element preserve trigger?"
note "################################################################"

# fixed make-repeating a to-do; report source fate (PRESERVE = row survives as instance;
# DELETE = row hard-deleted, fresh template+instance minted).
sf_todo_fate() {  # <uuid> <label> <expect>
  local u="$1" label="$2" expect="$3"
  local row; row=$(gq "SELECT 'exists='||COUNT(*)||' start='||COALESCE(MAX(start),'-')||' status='||COALESCE(MAX(status),'-')||' tmpl='||COALESCE(MAX(rt1_repeatingTemplate),'NULL')||' rule='||COALESCE(MAX(rt1_recurrenceRule IS NOT NULL),'-') FROM TMTask WHERE uuid='$u'")
  local verdict="?"; case "$row" in
    exists=0*) verdict="DELETE";;
    exists=1*tmpl=NULL*) verdict="AMBIGUOUS(row survives, no tmpl)";;
    exists=1*) verdict="PRESERVE";;
  esac
  note "  [SF $label] source $u -> $verdict   (expect $expect)   [$row]"
}

sf_case_todo() {  # <title> <expect> <build-fn>
  local title="$1" expect="$2" buildfn="$3"
  drive "$title-seed" todo add \"$title\" >/dev/null
  local u; u=$(uidt "$title")
  "$buildfn" "$u" "$title"
  warm
  mkrep_native todo.make-repeating "$u" "$title-mk"
  settle
  sf_todo_fate "$u" "$title" "$expect"
}

# build helpers for to-do cells
b_checked()   { drive "$2-ci" todo checklist "$1" --add ci1 >/dev/null; drive "$2-chk" todo checklist "$1" --check ci1 >/dev/null; note "    $2 checklist:"; chkfor "$2"; }
b_unchecked() { drive "$2-ci" todo checklist "$1" --add ci1 >/dev/null; note "    $2 unchecked checklist item added"; }
b_bare()      { : ; }

sf_proj_fate() {  # <uuid> <label> <expect>
  local u="$1" label="$2" expect="$3"
  local row; row=$(gq "SELECT 'exists='||COUNT(*)||' start='||COALESCE(MAX(start),'-')||' tmpl='||COALESCE(MAX(rt1_repeatingTemplate),'NULL')||' rule='||COALESCE(MAX(rt1_recurrenceRule IS NOT NULL),'-') FROM TMTask WHERE uuid='$u'")
  local verdict="?"; case "$row" in
    exists=0*) verdict="DELETE";;
    exists=1*tmpl=NULL*rule=1*) verdict="AMBIGUOUS(survives-as-template?)";;
    exists=1*) verdict="PRESERVE";;
  esac
  note "  [SF $label] source $u -> $verdict   (expect $expect)   [$row]"
}

sf_case_proj() {  # <title> <expect> <child-fate: complete|cancel|open|open-checked>
  local title="$1" expect="$2" cf="$3"
  lab_ssh "$IP" "open 'things:///json?data=$(enc "[{\"type\":\"project\",\"attributes\":{\"title\":\"$title\",\"items\":[{\"type\":\"to-do\",\"attributes\":{\"title\":\"$title-c\"}}]}}]")'; sleep 3" </dev/null
  local pj cu; pj=$(uidp "$title"); cu=$(gq "SELECT uuid FROM TMTask WHERE title='$title-c' AND project='$pj' LIMIT 1")
  case "$cf" in
    complete)     drive "$title-cc" todo complete "$cu" --completed-at 2026-07-04T10:00 >/dev/null;;
    cancel)       drive "$title-cx" todo cancel   "$cu" --completed-at 2026-07-04T11:00 >/dev/null;;
    open-checked) drive "$title-ci" todo checklist "$cu" --add cib >/dev/null; drive "$title-ck" todo checklist "$cu" --check cib >/dev/null; note "    $title child checklist:"; chkfor "$title-c";;
    open)         : ;;
  esac
  note "    $title subtree pre-convert:"; kids "$pj"
  warm
  mkrep_native project.make-repeating "$pj" "$title-mk"
  settle
  sf_proj_fate "$pj" "$title" "$expect"
}

# --- to-do cells ×2 ---
sf_case_todo SF-Tck1  PRESERVE b_checked
sf_case_todo SF-Tck2  PRESERVE b_checked
sf_case_todo SF-Tun1  DELETE   b_unchecked
sf_case_todo SF-Tun2  DELETE   b_unchecked
sf_case_todo SF-Tbr1  DELETE   b_bare
sf_case_todo SF-Tbr2  DELETE   b_bare
# --- project cells ×2 ---
sf_case_proj SF-Pcp1  PRESERVE complete
sf_case_proj SF-Pcp2  PRESERVE complete
sf_case_proj SF-Pcx1  PRESERVE cancel
sf_case_proj SF-Pcx2  PRESERVE cancel
sf_case_proj SF-Pok1  PRESERVE open-checked
sf_case_proj SF-Pok2  PRESERVE open-checked
sf_case_proj SF-Pbo1  DELETE   open
sf_case_proj SF-Pbo2  DELETE   open

# =====================================================================
# P2 (CVT) — plain to-do convert-to-project (×2)
# =====================================================================
note ""; note "################################################################"
note "# P2 (CVT) — plain (non-instance) todo convert-to-project"
note "################################################################"
cvt_case() {  # <n>
  local t="CVT$1"
  drive "$t-seed" todo add \"$t\" --notes \"cvt-notes-$1\" --checklist-item cvA --checklist-item cvB --json >/dev/null
  local u; u=$(uidt "$t")
  drive "$t-chk" todo checklist "$u" --check cvA >/dev/null
  local cd0; cd0=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$u'")
  note "  $t pre-convert: uuid=$u creationDate=$cd0 notes+2 checklist(1 checked)"
  warm; snap "$t-pre"
  drive "$t-cvt" todo convert-to-project "$u" --dangerously-drive-gui --json
  settle; snap "$t-post"
  note "  --- $t delta ---"; diff_c "$t-pre" "$t-post" "$t"
  note "  $t old-uuid fate: $(gq "SELECT 'exists='||COUNT(*)||' type='||COALESCE(MAX(type),'-') FROM TMTask WHERE uuid='$u'")"
  local np; np=$(gq "SELECT uuid FROM TMTask WHERE title='$t' AND type=1 ORDER BY creationDate DESC LIMIT 1")
  note "  $t new project uuid=$np creationDate=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$np'") (=wall-clock? vs preserved $cd0)  notes=$(gq "SELECT COALESCE(notes,'NULL') FROM TMTask WHERE uuid='$np'")  checklistCarried=$(gq "SELECT COUNT(*) FROM TMChecklistItem ci JOIN TMTask t ON t.uuid=ci.task WHERE t.title='$t'")"
  note "  $t new-project children: $(gq "SELECT COUNT(*) FROM TMTask WHERE project='$np'")"
}
cvt_case 1
cvt_case 2

# =====================================================================
# P4 (PHC) — project.promote-heading new-project creationDate value
# =====================================================================
note ""; note "################################################################"
note "# P4 (PHC) — promote-heading: new project's creationDate = wall-clock?"
note "################################################################"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"PHC-P","items":[{"type":"heading","attributes":{"title":"PHC-H"}},{"type":"to-do","attributes":{"title":"PHC-c"}}]}}]')'; sleep 3" </dev/null
PHCP=$(uidp "PHC-P")
PHCH=$(gq "SELECT uuid FROM TMTask WHERE title='PHC-H' AND type=2 LIMIT 1")
note "  PHC pre: project=$PHCP heading=$PHCH"; kids "$PHCP"
WALL0=$(gq "SELECT strftime('%s','now')")
warm; snap phc-pre
drive PHC-promote project promote-heading "$PHCP" PHC-H --dangerously-drive-gui --json
settle; snap phc-post
WALL1=$(gq "SELECT strftime('%s','now')")
note "  --- PHC delta ---"; diff_c phc-pre phc-post "PHC"
note "  PHC old heading fate: $(gq "SELECT 'exists='||COUNT(*)||' type='||COALESCE(MAX(type),'-') FROM TMTask WHERE uuid='$PHCH'")"
PHCNP=$(gq "SELECT uuid FROM TMTask WHERE title='PHC-H' AND type=1 ORDER BY creationDate DESC LIMIT 1")
note "  PHC new project uuid=$PHCNP creationDate=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$PHCNP'")   guest wall-clock window: [$WALL0 .. $WALL1]   (creationDate should fall in the window = conversion wall-clock)"

# =====================================================================
# P3 (UMD) — umd micro-cells on the OWNING row
# =====================================================================
note ""; note "################################################################"
note "# P3 (UMD) — userModificationDate bump/silent per micro-op (owning row)"
note "################################################################"
warm
umd_op() {  # <label> <owning-uuid> <cmd...>
  local label="$1" u="$2"; shift 2
  local b; b=$(umd "$u")
  drive "umd-$label" "$@" >/dev/null
  sleep 1
  local a; a=$(umd "$u")
  local verdict="SILENT"; [ "$b" != "$a" ] && verdict="BUMP"
  note "  [UMD $label] owning=$u  umd $b -> $a  => $verdict"
}
# checklist family
drive UMD-chk-seed todo add \"UMD-chk\" --json >/dev/null
UCHK=$(uidt "UMD-chk")
umd_op chk-add    "$UCHK" todo checklist "$UCHK" --add ci1
umd_op chk-check  "$UCHK" todo checklist "$UCHK" --check ci1
umd_op chk-uncheck "$UCHK" todo checklist "$UCHK" --uncheck ci1
umd_op chk-rename "$UCHK" todo checklist "$UCHK" --rename ci1 --to ci1x
umd_op chk-remove "$UCHK" todo checklist "$UCHK" --remove ci1x
# reminder set/clear
drive UMD-rem-seed todo add \"UMD-rem\" --json >/dev/null
UREM=$(uidt "UMD-rem")
note "  UMD-rem before: $(gq "SELECT 'reminderTime='||COALESCE(reminderTime,'NULL')||' startDate='||COALESCE(startDate,'NULL')||' start='||start FROM TMTask WHERE uuid='$UREM'")"
umd_op rem-set   "$UREM" todo update "$UREM" --when 2026-07-05 --reminder 14:30
note "  UMD-rem after set: $(gq "SELECT 'reminderTime='||COALESCE(reminderTime,'NULL')||' startDate='||COALESCE(startDate,'NULL')||' start='||start FROM TMTask WHERE uuid='$UREM'")"
umd_op rem-clear "$UREM" todo update "$UREM" --clear-reminder
note "  UMD-rem after clear: $(gq "SELECT 'reminderTime='||COALESCE(reminderTime,'NULL')||' startDate='||COALESCE(startDate,'NULL')||' start='||start FROM TMTask WHERE uuid='$UREM'")"
# title / notes
drive UMD-tn-seed todo add \"UMD-tn\" --json >/dev/null
UTN=$(uidt "UMD-tn")
umd_op title "$UTN" todo update "$UTN" --title \"UMD-tn2\"
umd_op notes "$UTN" todo update "$UTN" --notes \"hello-notes\"

# dissolve-heading — surviving children umd
note ""; note "### UMD dissolve-heading — surviving children umd ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"UMD-DHP","items":[{"type":"heading","attributes":{"title":"UMD-DH"}},{"type":"to-do","attributes":{"title":"UMD-DH-c1"}},{"type":"to-do","attributes":{"title":"UMD-DH-c2"}}]}}]')'; sleep 3" </dev/null
DHP=$(uidp "UMD-DHP")
DC1=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-DH-c1' LIMIT 1"); DC2=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-DH-c2' LIMIT 1")
DC1B=$(umd "$DC1"); DC2B=$(umd "$DC2")
note "  children umd before: c1=$DC1B c2=$DC2B"
warm; snap dh-pre
drive UMD-dissolve project dissolve-heading "$DHP" UMD-DH --dangerously-drive-gui --json
settle; snap dh-post
note "  --- dissolve delta ---"; diff_c dh-pre dh-post "UMD-DH"
DC1A=$(umd "$DC1"); DC2A=$(umd "$DC2")
note "  [UMD dissolve-children] c1 umd $DC1B -> $DC1A ($([ "$DC1B" != "$DC1A" ] && echo BUMP || echo SILENT))   c2 umd $DC2B -> $DC2A ($([ "$DC2B" != "$DC2A" ] && echo BUMP || echo SILENT))"

# move-heading-to-project — heading row umd
note ""; note "### UMD move-heading-to-project — heading row umd ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"UMD-MHS","items":[{"type":"heading","attributes":{"title":"UMD-MH"}},{"type":"to-do","attributes":{"title":"UMD-MH-c1"}}]}},{"type":"project","attributes":{"title":"UMD-MHD","items":[]}}]')'; sleep 3" </dev/null
MHS=$(uidp "UMD-MHS"); MHD=$(uidp "UMD-MHD")
MH=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-MH' AND type=2 LIMIT 1")
MHC=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-MH-c1' LIMIT 1")
MHB=$(umd "$MH"); MHCB=$(umd "$MHC")
note "  heading umd before: $MHB  child umd before: $MHCB  (heading project=$(gq "SELECT COALESCE(project,'NULL') FROM TMTask WHERE uuid='$MH'"))"
warm; snap mh-pre
drive UMD-move-heading project move-heading-to-project "$MHS" UMD-MH --to UMD-MHD --dangerously-drive-gui --json
settle; snap mh-post
note "  --- move-heading-to-project delta ---"; diff_c mh-pre mh-post "UMD-MH"
MHA=$(umd "$MH"); MHCA=$(umd "$MHC")
note "  [UMD move-heading] heading umd $MHB -> $MHA ($([ "$MHB" != "$MHA" ] && echo BUMP || echo SILENT))   child umd $MHCB -> $MHCA ($([ "$MHCB" != "$MHCA" ] && echo BUMP || echo SILENT))"
note "  heading after: project=$(gq "SELECT COALESCE(project,'NULL') FROM TMTask WHERE uuid='$MH'") (dest=$MHD)"

# =====================================================================
# P5 (RSTG) — reactivate a logged dated to-do whose date passed while logged
# =====================================================================
note ""; note "################################################################"
note "# P5 (RSTG) — RESTAGE-lite: logged dated to-do, date passes, then reopen"
note "################################################################"
drive RSTG-seed todo add \"RSTG-T\" --when 2026-07-05 --json >/dev/null
RSTG=$(uidt "RSTG-T")
note "  RSTG-T after schedule(07-05): $(gq "SELECT 'start='||start||' startDate='||COALESCE(startDate,'NULL')||' todayIndex='||COALESCE(todayIndex,'NULL')||' tiRef='||COALESCE(todayIndexReferenceDate,'NULL') FROM TMTask WHERE uuid='$RSTG'")"
drive RSTG-complete todo complete "$RSTG" --json >/dev/null
note "  RSTG-T after complete (logged): $(gq "SELECT 'status='||status||' start='||start||' startDate='||COALESCE(startDate,'NULL')||' stopDate='||COALESCE(stopDate,'NULL')||' todayIndex='||COALESCE(todayIndex,'NULL')||' tiRef='||COALESCE(todayIndexReferenceDate,'NULL') FROM TMTask WHERE uuid='$RSTG'")"
snap rstg-pre-advance

advance_to 070812002026 "2026-07-08"
note "  RSTG-T @07-08 while still logged (date 07-05 now in the PAST): $(gq "SELECT 'status='||status||' start='||start||' startDate='||COALESCE(startDate,'NULL')||' todayIndex='||COALESCE(todayIndex,'NULL')||' tiRef='||COALESCE(todayIndexReferenceDate,'NULL') FROM TMTask WHERE uuid='$RSTG'")"
snap rstg-pre-reopen
drive RSTG-reopen todo reopen "$RSTG" --json
settle; snap rstg-post-reopen
note "  --- RSTG reopen delta ---"; diff_c rstg-pre-reopen rstg-post-reopen "RSTG"
note "  RSTG-T after reopen @07-08 (where does it land? Today/original-date/re-derived): $(gq "SELECT 'status='||status||' start='||start||' startDate='||COALESCE(startDate,'NULL')||' startBucket='||COALESCE(startBucket,'NULL')||' todayIndex='||COALESCE(todayIndex,'NULL')||' tiRef='||COALESCE(todayIndexReferenceDate,'NULL')||' stopDate='||COALESCE(stopDate,'NULL') FROM TMTask WHERE uuid='$RSTG'")"
note "  RSTG reader views:"
for v in today upcoming anytime inbox; do
  h=$(G "$v" --json 2>/dev/null | grep -oE '"title":"RSTG-T"' | head -1)
  note "    $v: ${h:-<none>}"
done

note ""; env_line
note "DONE. report: $REPORT   snapshots: $OUT/snaps/   drives: $OUT/drive-*.log"
