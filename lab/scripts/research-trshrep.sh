#!/bin/bash
# TRSHREP — does a repeating template keep spawning while it (or its containing
# project) sits in the Trash, and what happens on restore (catch-up? relocation?).
# ONE disposable clone of things-lab-golden-v2 (Things 3.22.12). Nine worklists:
#   R1  fixed DAILY repeater CHILD of a project P1; trash P1 via shipped `project delete`;
#       does the child template's cursor survive the CONTAINER trash (contrast CLONE C3
#       DIRECT template-trash which clears the cursor)? advance +1 then +2 more days
#       (relaunch each) — does it spawn into the trash, and how many on multi-period?
#   R2  restore P1 after multiple missed periods (shipped `project restore`) — ONE
#       occurrence or MULTIPLE (catch-up)? where do they land? does the cursor re-anchor?
#   R3  restore-by-RELOCATION — trash P3, advance a period, then `todo move` the repeating
#       template OUT of the trashed project into an area; does spawning resume? catch-up?
#   R4  after-completion project P2; trash; advance (nothing spawns on the clock); complete
#       the AC instance WHILE trashed — does a successor spawn INTO the trash? restore P2.
#   R5  raw GUI/AS direct-trash of a to-do TEMPLATE (CLONE residual — CLI guard refuses);
#       row fate (cursor cleared / instance orphaned?) + GUI dialog + restore/resume.
#   R6  reader honesty — for each state, what the shipped CLI reads report.
#   R7  empty-trash cascade on a trashed project's LOGGED children (A27 says trashed=1 rows
#       hard-delete; logged children carry trashed=0 — container-derived). Do they survive?
#   R8  MIXED open+logged native fixed `project make-repeating` (the flagged RSIM-U
#       unisolated cell) — source fate + whether the completed child's history row is
#       hard-deleted with the subtree (S-R1 whole-subtree law). ×2 for nondeterminism.
#   R9  checklist CHECKED-state across template->occurrence spawn (unprobed; RSIM-S only
#       exercised titles). (a) repeating TO-DO w/ checked+unchecked checklist; (b) checked
#       item inside a repeating PROJECT template. Advance a period, capture the occurrence.
#
# METHOD mirrors research-clone.sh. golden-v2 carries baked L3-accessibility (auth_value=2)
# so make-repeating (ui vector) drives via System Events over SSH, no VNC. Airgap + pin
# clock 2026-07-05 12:00, advance in SMALL +1/+2-day steps (SL2/RSIM-S proven; the A4
# +15-day wedge is avoided). Guest helpers live in ~/things-lab/helpers (reboot-survive)
# and are RE-INSTALLED after every advance. Snapshot before each advance. Ground truth =
# read-only guest SQLite row deltas driven through the SHIPPED CLI. Fixtures fully synthetic.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="trshrep-lab"
GOLDEN="things-lab-golden-v2"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps" "$OUT/reads"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[trshrep] $*" | tee -a "$REPORT"; }
cleanup() { echo "[trshrep] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
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

# ---------------- clone + boot (golden-v2 has AX baked; no VNC) ----------------
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
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[trshrep] /'
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
      "reminderTime","deadline","\"index\"","todayIndex","stopDate",
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
tomb=[]
try:
    for r in c.execute("SELECT * FROM TMTombstone"): tomb.append([str(x) for x in r])
except Exception as e:
    tomb=[["__error__",str(e)]]
json.dump({"tasks":tasks,"areas":areas,"checklist":checklist,"tombstones":tomb},sys.stdout,default=str)
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
DATEF={"startDate","deadline","rt1_instanceCreationStartDate","rt1_afterCompletionReferenceDate","rt1_nextInstanceStartDate"}
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
    f.append("startDate=%s deadline=%s creationDate=%s stopDate=%s"%(dpk(d.get("startDate")),dpk(d.get("deadline")),unixdate(d.get("creationDate")),unixdate(d.get("stopDate"))))
    f.append("tmpl=%s"%ref(d.get("rt1_repeatingTemplate"),snap))
    f.append("icCount=%s next=%s acRef=%s paused=%s"%(d.get("rt1_instanceCreationCount"),dpk(d.get("rt1_nextInstanceStartDate")),dpk(d.get("rt1_afterCompletionReferenceDate")),d.get("rt1_instanceCreationPaused")))
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
print("  TMTask  INSERTED: %d  DELETED: %d  CHANGED: %d   | TMChecklistItem +%d/-%d/~%d | tombstones %d->%d"%(
    len(ins),len(dele),len(chg),len(cins),len(cdel),len(cchg),len(A.get("tombstones",[])),len(B.get("tombstones",[]))))
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

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
env_line() { note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"; }

# advance_to <MMDDhhmmYYYY> <label> : quit app -> set+verify clock -> warm relaunch (runs
# launch-time maintenance at the new date) -> re-airgap + RE-INSTALL helpers + verify.
advance_to() {
  local dt="$1" label="$2"
  note ">>> advancing clock to $label ($dt) — quit, set date, warm relaunch, re-pin+reinstall helpers"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $dt >/dev/null" </dev/null
  local now; now=$(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)
  note "    clock now: $now"
  lab_ssh "$IP" 'open -a Things3; sleep 16; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null
  airgap_pin
  lab_ssh "$IP" "test -f $HELP/gsql.sh && test -f $HELP/rsnap.py" </dev/null || { note "    helpers vanished — reinstalling"; install_helpers; }
  local nowck; nowck=$(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)
  note "    post-relaunch clock: $nowck   helpers: $(lab_ssh "$IP" "ls $HELP 2>/dev/null | tr '\n' ' '" </dev/null)"
}

# resolvers
uidt()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
uidp()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
tmplt() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1"; }
tmplp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NOT NULL LIMIT 1"; }

# series state for a template uuid: template bookkeeping + instance census by trashed-state
series() {
  local t="$1" label="$2"
  note "  [series $label] template=$t"
  gq "SELECT 'TMPL exists='||COUNT(*)||' trashed='||COALESCE(MAX(trashed),'-')||' status='||COALESCE(MAX(status),'-')||' hasRule='||COALESCE(MAX(rt1_recurrenceRule IS NOT NULL),'-')||' paused='||COALESCE(MAX(rt1_instanceCreationPaused),'-')||' icCount='||COALESCE(MAX(rt1_instanceCreationCount),'-')||' next='||COALESCE(MAX(rt1_nextInstanceStartDate),'-')||' acRef='||COALESCE(MAX(rt1_afterCompletionReferenceDate),'-') FROM TMTask WHERE uuid='$t'" | sed 's/^/    /' | tee -a "$REPORT"
  note "    instances (rt1_repeatingTemplate=$t), all trashed-states:"
  gq "SELECT uuid,title,status,trashed,start,startDate,project FROM TMTask WHERE rt1_repeatingTemplate='$t' ORDER BY startDate" | sed 's/^/      /' | tee -a "$REPORT"
  note "    live-instance count (trashed=0): $(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$t' AND trashed=0")   total: $(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$t'")"
}

# checklist rows for a task title-prefix
chkfor() { gq "SELECT t.title||' | '||ci.title||' | status='||ci.status FROM TMChecklistItem ci JOIN TMTask t ON t.uuid=ci.task WHERE t.title LIKE '$1%' ORDER BY t.title, ci.\"index\"" | sed 's/^/    /' | tee -a "$REPORT"; }

# R6 reader-honesty probe: run shipped CLI reads, save raw, grep the fixture prefix.
read_probe() {
  local label="$1"; shift
  local titles="$1"; shift
  note "  [R6 read_probe: $label] shipped CLI reads (grep for /$titles/)"
  for view in today upcoming trash inbox anytime; do
    G "$view" --json > "$OUT/reads/${label}-${view}.json" 2>/dev/null || true
    local hits; hits=$(grep -oE "\"title\":\"($titles)[^\"]*\"" "$OUT/reads/${label}-${view}.json" 2>/dev/null | sort -u | tr '\n' ' ')
    note "    $view: ${hits:-<none>}"
  done
}

env_line
note "packed dates: 07-05=132805248 07-06=132805376 07-07=132805504 07-08=132805632 07-09=132805760"

# =====================================================================
# PHASE 0 (clock 2026-07-05) — build every fixture, convert, trash containers
# =====================================================================
note ""; note "################################################################"
note "# PHASE 0 (2026-07-05) — fixtures + conversions + container trashes"
note "################################################################"

lab_ssh "$IP" "osascript -e 'tell application \"Things3\"' -e 'make new area with properties {name:\"TR-Area\"}' -e 'end tell'" </dev/null 2>&1 | sed 's/^/  [seed] /' | tee -a "$REPORT"

enc() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$1"; }

mk_project_child_repeater() {  # <projTitle> <childTitle> <mode fixed|ac>
  local pt="$1" ct="$2" mode="$3" extra=""
  [ "$mode" = "ac" ] && extra="--after-completion"
  lab_ssh "$IP" "open 'things:///json?data=$(enc "[{\"type\":\"project\",\"attributes\":{\"title\":\"$pt\",\"items\":[{\"type\":\"to-do\",\"attributes\":{\"title\":\"$ct\"}}]}}]")'; sleep 3" </dev/null
  local child; child=$(gq "SELECT uuid FROM TMTask WHERE title='$ct' AND type=0 LIMIT 1")
  warm
  drive "$ct-mk" todo make-repeating "$child" --frequency daily --interval 1 $extra --dangerously-drive-gui --json
  settle
}

note ""; note "### R1/R2 fixture — project TR-P1 { fixed-daily repeating child } ###"
mk_project_child_repeater "TR-P1" "TR-P1-rep" fixed
P1=$(uidp "TR-P1"); P1T=$(tmplt "TR-P1-rep")
note "  P1=$P1  template=$P1T"; kids "$P1"; series "$P1T" "P1 post-convert (07-05)"

note ""; note "### R3 fixture — project TR-P3 { fixed-daily repeating child } ###"
mk_project_child_repeater "TR-P3" "TR-P3-rep" fixed
P3=$(uidp "TR-P3"); P3T=$(tmplt "TR-P3-rep")
note "  P3=$P3  template=$P3T"; kids "$P3"

note ""; note "### R4 fixture — project TR-P2 { after-completion-daily repeating child } ###"
mk_project_child_repeater "TR-P2" "TR-P2-rep" ac
P2=$(uidp "TR-P2"); P2T=$(tmplt "TR-P2-rep")
note "  P2=$P2  template=$P2T"; kids "$P2"; series "$P2T" "P2 post-convert AC (07-05)"

note ""; note "### R5 fixture — standalone fixed-daily to-do template TR-R5 ###"
drive R5-seed todo add \"TR-R5\" --json
R5U=$(uidt "TR-R5")
warm
drive R5-mk todo make-repeating "$R5U" --frequency daily --interval 1 --dangerously-drive-gui --json
settle
R5T=$(tmplt "TR-R5"); series "$R5T" "R5 standalone post-convert (07-05)"

note ""; note "### R9a fixture — to-do TR-R9a { chk:done(checked), chk:open } -> fixed-daily ###"
drive R9a-seed todo add \"TR-R9a\" --checklist-item CIdone --checklist-item CIopen --json
R9AU=$(uidt "TR-R9a")
drive R9a-check todo checklist "$R9AU" --check CIdone --json
note "  R9a checklist BEFORE conversion (expect CIdone status=3, CIopen status=0):"; chkfor "TR-R9a"
warm
drive R9a-mk todo make-repeating "$R9AU" --frequency daily --interval 1 --dangerously-drive-gui --json
settle
R9AT=$(tmplt "TR-R9a")
note "  R9a template=$R9AT  — checklist ON THE TEMPLATE after conversion (did checked-state survive the mint?):"; chkfor "TR-R9a"
series "$R9AT" "R9a post-convert (07-05)"

note ""; note "### R9b fixture — project TR-R9b { child TR-R9b-k1 w/ checked checklist } -> fixed-daily project ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"TR-R9b","items":[]}}]')'; sleep 3" </dev/null
drive R9b-child todo add \"TR-R9b-k1\" --project TR-R9b --checklist-item CIbdone --checklist-item CIbopen --json
R9BK=$(gq "SELECT uuid FROM TMTask WHERE title='TR-R9b-k1' AND type=0 LIMIT 1")
drive R9b-check todo checklist "$R9BK" --check CIbdone --json
note "  R9b child checklist BEFORE conversion:"; chkfor "TR-R9b-k1"
R9B=$(uidp "TR-R9b")
warm
drive R9b-mk project make-repeating "$R9B" --frequency daily --interval 1 --dangerously-drive-gui --json
settle
R9BT=$(tmplp "TR-R9b")
note "  R9b project template=$R9BT"; kids "$R9BT"
note "  R9b checklist on BOTH template-side and instance-side child copies after conversion:"; chkfor "TR-R9b-k1"

note ""; note "### R8 fixtures — mixed open+completed native fixed project make-repeating (x2) ###"
r8_case() {  # <n>
  local n="$1"; local pt="TR-R8$n"
  lab_ssh "$IP" "open 'things:///json?data=$(enc "[{\"type\":\"project\",\"attributes\":{\"title\":\"$pt\",\"items\":[{\"type\":\"to-do\",\"attributes\":{\"title\":\"$pt-open\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"$pt-done\"}}]}}]")'; sleep 3" </dev/null
  local pj done_uid; pj=$(uidp "$pt"); done_uid=$(gq "SELECT uuid FROM TMTask WHERE title='$pt-done' AND project='$pj' LIMIT 1")
  drive "$pt-complete" todo complete "$done_uid" --completed-at 2026-07-04T10:00 --json
  note "  $pt pre-conversion subtree (1 open + 1 completed w/ real stopDate):"; kids "$pj"
  local done_stop; done_stop=$(gq "SELECT stopDate FROM TMTask WHERE uuid='$done_uid'")
  note "  $pt completed-child uuid=$done_uid stopDate=$done_stop"
  warm; snap "$pt-pre"
  drive "$pt-mk" project make-repeating "$pj" --frequency weekly --interval 1 --dangerously-drive-gui --json
  settle; snap "$pt-post"
  note "  --- $pt delta (source fate + does the completed history row survive?) ---"; diff_c "$pt-pre" "$pt-post" "$pt"
  note "  $pt SOURCE-FATE: $(gq "SELECT 'proj-exists='||COUNT(*)||' tmpl='||COALESCE(MAX(rt1_repeatingTemplate),'NULL') FROM TMTask WHERE uuid='$pj'")"
  note "  $pt completed-child $done_uid fate: $(gq "SELECT 'exists='||COUNT(*)||' trashed='||COALESCE(MAX(trashed),'-')||' status='||COALESCE(MAX(status),'-') FROM TMTask WHERE uuid='$done_uid'")   (gone => native promote DESTROYED logged history)"
  note "  $pt tombstone for completed-child: $(gq "SELECT COUNT(*) FROM TMTombstone WHERE uuid='$done_uid'" 2>/dev/null || echo 'n/a')"
}
r8_case a
r8_case b

note ""; note "### R5 — raw trash of the to-do TEMPLATE (CLI guard refuses; use raw AS + best-effort GUI dialog) ###"
note "  R5a — confirm the shipped CLI guard refuses todo delete on a template (WG-8):"
drive R5-cli-delete todo delete "$R5T" --json
snap r5-pre
note "  R5b — best-effort GUI delete-dialog capture (AX):"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to show to do id \"$R5T\"' 2>&1; sleep 2" </dev/null | sed 's/^/    [show] /' | tee -a "$REPORT"
lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to tell process \"Things3\" to key code 51' 2>&1; sleep 2" </dev/null | sed 's/^/    [delete-key] /' | tee -a "$REPORT"
lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to tell process \"Things3\" to get {name, description} of every button of every sheet of every window' 2>&1" </dev/null | sed 's/^/    [dialog-buttons] /' | tee -a "$REPORT"
lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to tell process \"Things3\" to get value of every static text of every sheet of every window' 2>&1" </dev/null | sed 's/^/    [dialog-text] /' | tee -a "$REPORT"
lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to tell process \"Things3\" to key code 53' 2>/dev/null" </dev/null
note "  R5c — deterministic raw AppleScript trash of the template row (delete to do id = move to Trash):"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to delete to do id \"$R5T\"' 2>&1; sleep 2" </dev/null | sed 's/^/    [as-delete] /' | tee -a "$REPORT"
settle; snap r5-post
note "  --- R5 delta: raw trash of to-do template $R5T ---"; diff_c r5-pre r5-post "TR-R5"
series "$R5T" "R5 after raw trash"
read_probe "R5-post-trash" "TR-R5"
drive R5-restore todo restore "$R5T" --json
settle; snap r5-restore
note "  --- R5 delta: restore template $R5T ---"; diff_c r5-post r5-restore "TR-R5"
series "$R5T" "R5 after restore"

note ""; note "### Trash containers P1/P2/P3 (shipped project delete) — cursor-survival capture ###"
note "  P1 template cursor BEFORE container trash: $(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$P1T'")"
snap pretrash-P1
drive P1-del project delete "$P1" --json
settle; snap posttrash-P1
note "  --- delta: trash container P1 ---"; diff_c pretrash-P1 posttrash-P1 "TR-P1"
note "  R1 KEY — P1 child template cursor AFTER container trash (survives? contrast CLONE C3 clear): $(gq "SELECT 'trashed='||trashed||' cursor(next)='||COALESCE(rt1_nextInstanceStartDate,'NULL')||' icCount='||rt1_instanceCreationCount||' paused='||rt1_instanceCreationPaused FROM TMTask WHERE uuid='$P1T'")"
series "$P1T" "P1 template after container trash (07-05)"
read_probe "after-P1-trash" "TR-P1"

drive P3-del project delete "$P3" --json
settle
note "  P3 template cursor after container trash: $(gq "SELECT 'trashed='||trashed||' next='||COALESCE(rt1_nextInstanceStartDate,'NULL') FROM TMTask WHERE uuid='$P3T'")"

drive P2-del project delete "$P2" --json
settle
note "  P2(AC) template after container trash: $(gq "SELECT 'trashed='||trashed||' next='||COALESCE(rt1_nextInstanceStartDate,'NULL')||' icCount='||rt1_instanceCreationCount FROM TMTask WHERE uuid='$P2T'")"
series "$P2T" "P2(AC) template after container trash (07-05)"

snap phase0-end

# =====================================================================
# PHASE 1 (advance to 2026-07-06, +1 day)
# =====================================================================
advance_to 070612002026 "2026-07-06"
snap p1-0706
note ""; note "### R1 @07-06 — did a new instance spawn INTO the trashed P1? ###"
diff_c phase0-end p1-0706 "TR-P1"
series "$P1T" "P1 template @07-06 (still trashed container)"
note ""; note "### R4 @07-06 — AC series in trashed P2 should NOT spawn on the clock ###"
series "$P2T" "P2(AC) template @07-06"
note ""; note "### R9a/R9b @07-06 — first spawned occurrence; checklist CHECKED-state carry? ###"
series "$R9AT" "R9a @07-06 (live to-do template)"
note "  R9a occurrence checklist rows (did CIdone spawn CHECKED or reset to open?):"; chkfor "TR-R9a"
kids "$R9BT"
note "  R9b instance-side occurrence checklist rows:"; chkfor "TR-R9b-k1"
read_probe "at-0706" "TR-P1|TR-R9a"

# =====================================================================
# PHASE 2 (advance to 2026-07-08, +2 days = MULTI-PERIOD) then RESTORES
# =====================================================================
advance_to 070812002026 "2026-07-08"
snap p2-0708
note ""; note "### R1 @07-08 — MULTI-PERIOD: how many instances now inside trashed P1? ###"
diff_c p1-0706 p2-0708 "TR-P1"
series "$P1T" "P1 template @07-08 (multi-period, still trashed)"
read_probe "at-0708-P1trashed" "TR-P1"

note ""; note "### R2 — restore P1 from trash after multiple missed periods ###"
snap pre-restoreP1
drive P1-restore project restore "$P1" --json
settle; snap post-restoreP1-immediate
note "  --- R2 delta: restore P1 (IMMEDIATE, no relaunch) ---"; diff_c pre-restoreP1 post-restoreP1-immediate "TR-P1"
series "$P1T" "P1 template immediately after restore (no relaunch)"
warm; snap post-restoreP1-warm
note "  --- R2 delta: restore P1 (after a warm relaunch — catch-up materialization?) ---"; diff_c post-restoreP1-immediate post-restoreP1-warm "TR-P1"
series "$P1T" "P1 template after restore + relaunch (ONE occurrence or catch-up MULTIPLE?)"
note "  R2 — where did occurrences land / cursor re-anchor? full instance list:"
gq "SELECT uuid,title,status,trashed,start,startDate,creationDate FROM TMTask WHERE rt1_repeatingTemplate='$P1T' ORDER BY startDate" | sed 's/^/    /' | tee -a "$REPORT"
read_probe "after-restoreP1" "TR-P1"

note ""; note "### R3 — restore by RELOCATION: move P3's template OUT of trashed P3 into TR-Area ###"
note "  P3 template BEFORE move: $(gq "SELECT 'trashed='||trashed||' project='||COALESCE(project,'NULL')||' next='||COALESCE(rt1_nextInstanceStartDate,'NULL') FROM TMTask WHERE uuid='$P3T'")"
snap pre-relocateP3
drive P3-move todo move "$P3T" --to-area TR-Area --json
settle; snap post-relocateP3
note "  --- R3 delta: relocate template out of trashed container ---"; diff_c pre-relocateP3 post-relocateP3 "TR-P3"
note "  P3 template AFTER move: $(gq "SELECT 'trashed='||trashed||' project='||COALESCE(project,'NULL')||' area='||COALESCE(area,'NULL')||' next='||COALESCE(rt1_nextInstanceStartDate,'NULL') FROM TMTask WHERE uuid='$P3T'")"
warm; snap post-relocateP3-warm
note "  --- R3 delta: after relaunch (spawning resume? catch-up?) ---"; diff_c post-relocateP3 post-relocateP3-warm "TR-P3"
series "$P3T" "P3 template after relocation + relaunch"
read_probe "after-relocateP3" "TR-P3"

note ""; note "### R4 — complete the AC instance WHILE P2 is trashed (does a successor spawn INTO trash?) ###"
P2INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$P2T' AND status=0 ORDER BY startDate DESC LIMIT 1")
note "  AC live instance to complete (derived-trashed via P2): $P2INST  $(gq "SELECT 'trashed='||trashed||' status='||status||' project='||COALESCE(project,'NULL') FROM TMTask WHERE uuid='$P2INST'")"
snap pre-completeAC
drive P2-complete-trashed todo complete "$P2INST" --json
settle; snap post-completeAC
note "  --- R4 delta: complete AC instance while trashed ---"; diff_c pre-completeAC post-completeAC "TR-P2"
series "$P2T" "P2(AC) template after completing the trashed instance (acRef/next stamped?)"

# =====================================================================
# PHASE 3 (advance to 2026-07-09, +1 day) — AC successor + restore P2
# =====================================================================
advance_to 070912002026 "2026-07-09"
snap p3-0709
note ""; note "### R4 @07-09 — did the AC successor spawn INTO the trashed P2? ###"
diff_c post-completeAC p3-0709 "TR-P2"
series "$P2T" "P2(AC) template @07-09 (successor into trash?)"
note ""; note "### R1/R3 @07-09 — restored/relocated series keep spawning normally? ###"
series "$P1T" "P1 (restored) @07-09"
series "$P3T" "P3 (relocated) @07-09"
read_probe "at-0709" "TR-P1|TR-P2|TR-P3"

note ""; note "### R4 — restore P2 (is the AC series simply intact with its instance?) ###"
snap pre-restoreP2
drive P2-restore project restore "$P2" --json
settle; snap post-restoreP2
note "  --- R4 delta: restore P2 ---"; diff_c pre-restoreP2 post-restoreP2 "TR-P2"
series "$P2T" "P2(AC) template after restore"
read_probe "after-restoreP2" "TR-P2"

# =====================================================================
# R7 (TERMINAL) — empty-trash cascade on a trashed project's LOGGED children.
# empty trash is GLOBAL: sequence LAST, snapshot full trash contents first.
# =====================================================================
note ""; note "################################################################"
note "# R7 (TERMINAL) — empty-trash cascade on a trashed project's logged children"
note "################################################################"
note "### R7 fixture — project TR-R7 { open + completed + canceled children } then trash the project ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"TR-R7","items":[{"type":"to-do","attributes":{"title":"TR-R7-open"}},{"type":"to-do","attributes":{"title":"TR-R7-done"}},{"type":"to-do","attributes":{"title":"TR-R7-cancel"}}]}}]')'; sleep 3" </dev/null
R7=$(uidp "TR-R7")
R7DONE=$(gq "SELECT uuid FROM TMTask WHERE title='TR-R7-done' AND project='$R7' LIMIT 1")
R7CAN=$(gq "SELECT uuid FROM TMTask WHERE title='TR-R7-cancel' AND project='$R7' LIMIT 1")
R7OPEN=$(gq "SELECT uuid FROM TMTask WHERE title='TR-R7-open' AND project='$R7' LIMIT 1")
drive R7-complete todo complete "$R7DONE" --completed-at 2026-07-08T10:00 --json
drive R7-cancel   todo cancel   "$R7CAN"  --completed-at 2026-07-08T11:00 --json
note "  R7 subtree before trashing the project:"; kids "$R7"
drive R7-del project delete "$R7" --json
settle
note "  R7 subtree after trashing the project (children carry OWN trashed=0, container-derived trash):"; kids "$R7"
note "  R7 rows just before empty — own trashed flags: open=$(gq "SELECT trashed FROM TMTask WHERE uuid='$R7OPEN'") done=$(gq "SELECT trashed FROM TMTask WHERE uuid='$R7DONE'") cancel=$(gq "SELECT trashed FROM TMTask WHERE uuid='$R7CAN'") project=$(gq "SELECT trashed FROM TMTask WHERE uuid='$R7'")"
read_probe "R7-pre-empty" "TR-R7"
note "  FULL trash census right before the GLOBAL empty (attributable collateral):"
gq "SELECT uuid,title,type,status,trashed FROM TMTask WHERE trashed=1 ORDER BY title" | sed 's/^/    trashed=1: /' | tee -a "$REPORT"
note "  tombstone count before empty: $(gq "SELECT COUNT(*) FROM TMTombstone" 2>/dev/null)"
snap pre-empty
drive R7-empty trash empty --dangerously-permanent --json
settle; snap post-empty
note "  --- R7 delta: empty trash (GLOBAL) ---"; diff_c pre-empty post-empty ""
note "  R7 KEY — logged children fate after empty:"
note "    open   TR-R7-open   : $(gq "SELECT 'exists='||COUNT(*)||' trashed='||COALESCE(MAX(trashed),'-') FROM TMTask WHERE uuid='$R7OPEN'")"
note "    done   TR-R7-done   : $(gq "SELECT 'exists='||COUNT(*)||' status='||COALESCE(MAX(status),'-')||' project='||COALESCE(MAX(project),'NULL') FROM TMTask WHERE uuid='$R7DONE'")   (gone => empty-trash DESTROYED completed history)"
note "    cancel TR-R7-cancel : $(gq "SELECT 'exists='||COUNT(*)||' status='||COALESCE(MAX(status),'-')||' project='||COALESCE(MAX(project),'NULL') FROM TMTask WHERE uuid='$R7CAN'")"
note "    project TR-R7       : $(gq "SELECT 'exists='||COUNT(*) FROM TMTask WHERE uuid='$R7'")"
note "  tombstone count after empty: $(gq "SELECT COUNT(*) FROM TMTombstone" 2>/dev/null)  (expect no new plain-row tombstones per TOMB1)"
read_probe "R7-post-empty" "TR-R7"

note ""; env_line
note "DONE. report: $REPORT   snapshots: $OUT/snaps/   reads: $OUT/reads/"
