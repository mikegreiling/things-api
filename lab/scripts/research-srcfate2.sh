#!/bin/bash
# SRCFATE-2 — completion clone for the SRCFATE sweep. ONE disposable clone of
# things-lab-golden-v2 (Things 3.22.12, baked AX). Closes the three cells clone-1
# could not measure with the right invocation:
#   P1b (SF-P) — the 8 PROJECT source-fate cells. The native `things batch`
#        make-repeating REFUSED area-less Anytime projects (H-PROJECT-REPEAT: no
#        selectable row, UIC4-d), so clone-1's project verdicts were false. Here the
#        projects are placed in an AREA (RSIM-R: area is IRRELEVANT to source-fate),
#        which gives the native pure-AX drive a selectable row.
#   P3b (UMD dissolve / move-heading) — clone-1 passed `--dangerously-drive-gui`,
#        which `project dissolve-heading` / `project move-heading-to-project` REJECT
#        ("unknown option"; they gate on `ui.enabled` config alone — a help/runtime
#        mismatch captured to up-next). Here they drive with NO per-call flag.
#   P3c (UMD reminder-clear) — clone-1's `--clear-reminder` was BLOCKED
#        (H-REMINDER-SCOPE: must re-state --when). Here: `--when today --clear-reminder`.
# Same harness as research-srcfate.sh / research-trshrep.sh. Fixtures fully synthetic.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="srcfate2-lab"
GOLDEN="things-lab-golden-v2"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[srcfate2] $*" | tee -a "$REPORT"; }
cleanup() { echo "[srcfate2] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB (golden=$GOLDEN)"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free. Abort."; exit 1; }

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
node --version >/dev/null 2>&1 || { note "FATAL: no node"; exit 1; }
note "toolchain: node $(node --version) @ $(command -v node)"
[ -d node_modules/commander ] || npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL npm ci"; exit 1; }

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
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[srcfate2] /'
lab_ssh "$IP" 'sudo date 070512002026 >/dev/null' </dev/null
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "Accessibility auth_value=$GRANT"
[ "$GRANT" != "2" ] && { note "FATAL: AX grant missing"; exit 1; }

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
import sys, sqlite3, glob, json
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
cols=["uuid","title","type","status","trashed","start","startDate","reminderTime","deadline","\"index\"","todayIndex","todayIndexReferenceDate","stopDate","area","project","heading","notes","creationDate","userModificationDate","rt1_recurrenceRule","rt1_repeatingTemplate","rt1_instanceCreationCount","rt1_nextInstanceStartDate"]
names=[x.strip('"') for x in cols]
def safe(v):
    if isinstance(v,(bytes,bytearray)): return "<%dB>"%len(v)
    return v
tasks={}
for r in c.execute("SELECT %s FROM TMTask"%",".join(cols)):
    d=dict(zip(names,[safe(x) for x in r]))
    if isinstance(d.get("notes"),str): d["notes"]=d["notes"][:40]
    tasks[d["uuid"]]=d
areas={}
for u,t in c.execute("SELECT uuid,title FROM TMArea"): areas[u]=t
checklist={}
for cu,tk,ti,st,ix in c.execute('SELECT uuid,task,title,status,"index" FROM TMChecklistItem'):
    checklist[cu]={"task":tk,"taskTitle":(tasks.get(tk) or {}).get("title"),"title":ti,"status":st,"index":ix}
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
row=q("SELECT title,type,start,status,trashed,area FROM TMTask WHERE uuid=?",p)
print("PROJECT %s %s start=%s status=%s trashed=%s area=%s"%(p, row[0][0] if row else "MISSING", row[0][2] if row else "?", row[0][3] if row else "?", row[0][4] if row else "?", (str(row[0][5])[:8] if row and row[0][5] else None)))
for hu,ht,hst in q("SELECT uuid,title,status FROM TMTask WHERE type=2 AND project=? ORDER BY \"index\"",p):
    print("  HEADING %s '%s' status=%s"%(hu,ht,hst))
    for u,t,stt,sd in q("SELECT uuid,title,status,stopDate FROM TMTask WHERE heading=? ORDER BY \"index\"",hu):
        print("    TODO(headed) %s '%s' status=%s chk=%d stop=%s"%(u,t,stt,cc(u),sd))
for u,t,stt,hd,sd in q("SELECT uuid,title,status,heading,stopDate FROM TMTask WHERE project=? AND type=0 ORDER BY \"index\"",p):
    print("  TODO(direct) %s '%s' status=%s head=%s chk=%d stop=%s"%(u,t,stt,(str(hd)[:8] if hd else None),cc(u),sd))
EOF
}
install_helpers
gq() { lab_ssh "$IP" "$HELP/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
snap() { lab_ssh "$IP" "python3 $HELP/rsnap.py" </dev/null > "$OUT/snaps/$1.json"; }
kids() { lab_ssh "$IP" "python3 $HELP/kids.py $1" </dev/null | tee -a "$REPORT"; }

cat > "$OUT/diff_snaps.py" <<'EOF'
import sys, json
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d(%d)"%(y,m,d,v) if 1<y<5000 else v
def ud(v):
    try: v=float(v)
    except: return v
    import datetime
    return datetime.datetime.utcfromtimestamp(v).strftime("%Y-%m-%dT%H:%M:%S")
DATEF={"startDate","deadline","rt1_nextInstanceStartDate","todayIndexReferenceDate"}
UNIXF={"creationDate","userModificationDate","stopDate"}
def ref(u,snap):
    if not u: return u
    t=(snap.get("tasks",{}).get(u) or {}).get("title"); a=snap.get("areas",{}).get(u)
    return "%s[%s]"%(t if t is not None else (a if a is not None else "?"),str(u)[:8])
A=json.load(open(sys.argv[1])); B=json.load(open(sys.argv[2]))
a=A["tasks"]; b=B["tasks"]
stems=[s for s in (sys.argv[3].split("|") if len(sys.argv)>3 and sys.argv[3] else []) if s]
def keep(d):
    if not stems: return True
    return any(str(d.get("title","")).startswith(s) for s in stems)
ins=[u for u in b if u not in a and keep(b[u])]; dele=[u for u in a if u not in b and keep(a[u])]
chg=[]
for u in b:
    if u in a and keep(b[u]):
        diffs={k:(a[u].get(k),b[u].get(k)) for k in b[u] if a[u].get(k)!=b[u].get(k)}
        if diffs: chg.append((u,diffs))
print("  TMTask INSERTED:%d DELETED:%d CHANGED:%d"%(len(ins),len(dele),len(chg)))
for u in ins:
    d=b[u]; print("  + INSERT %s \"%s\" type=%s start=%s proj=%s head=%s creationDate=%s"%(u,d.get("title"),d.get("type"),d.get("start"),ref(d.get("project"),B),ref(d.get("heading"),B),ud(d.get("creationDate"))))
for u in dele:
    d=a[u]; print("  - DELETE %s \"%s\" type=%s"%(u,d.get("title"),d.get("type")))
for u,diffs in chg:
    print("  ~ CHANGE %s \"%s\""%(u,b[u].get("title")))
    for k,(ov,nv) in sorted(diffs.items()):
        if k in ("project","heading","area","rt1_repeatingTemplate"): ov,nv=ref(ov,A),ref(nv,B)
        elif k in DATEF: ov,nv=dpk(ov),dpk(nv)
        elif k in UNIXF: ov,nv=ud(ov),ud(nv)
        print("      %s: %s -> %s"%(k,ov,nv))
EOF
diff_c() { python3 "$OUT/diff_snaps.py" "$OUT/snaps/$1.json" "$OUT/snaps/$2.json" "${3:-}" | tee -a "$REPORT"; }

note "############### build + ship bundle ###############"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL build"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
drive() {
  local label="$1"; shift
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive-$label.log" 2>&1
  { grep -m1 '"ok"\|^ok \|"kind":"mutation-result"\|"outcome"\|replacedUuid' "$OUT/drive-$label.log" || grep -m1 'error\|BLOCKED\|blocked\|invalid\|refus' "$OUT/drive-$label.log" || echo '(no result line)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive-$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}
G config set ui-enabled true >/dev/null 2>&1
G config set allow-experimental true >/dev/null 2>&1
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
enc() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$1"; }
uidt()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
uidp()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
umd()   { gq "SELECT userModificationDate FROM TMTask WHERE uuid='$1'"; }
chkfor(){ gq "SELECT t.title||' | '||ci.title||' | status='||ci.status FROM TMChecklistItem ci JOIN TMTask t ON t.uuid=ci.task WHERE t.title LIKE '$1%' ORDER BY t.title, ci.\"index\"" | sed 's/^/    /' | tee -a "$REPORT"; }
note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"

# native destructive make-repeating via `things batch` (NOT promote-via-clone)
mkrep_native() {  # <op> <uuid> <label>
  local op="$1" u="$2" label="$3"
  local jl="{\"op\":\"$op\",\"params\":{\"uuid\":\"$u\",\"frequency\":\"daily\",\"interval\":1},\"options\":{\"dangerouslyDriveGui\":true}}"
  lab_ssh "$IP" "printf '%s\n' '$jl' > /tmp/mk.jsonl" </dev/null
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js batch /tmp/mk.jsonl ; echo EXIT=\$?" </dev/null > "$OUT/drive-$label.log" 2>&1
  { grep -m1 'replacedUuid\|"outcome"\|blocked\|error' "$OUT/drive-$label.log" || echo '(no result)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive-$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}

# =====================================================================
# P1b (SF-P) — the 8 PROJECT source-fate cells, projects placed in an AREA
# =====================================================================
note ""; note "################################################################"
note "# P1b (SF-P) — project make-repeating source-fate (native, AREA-placed)"
note "################################################################"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\"' -e 'make new area with properties {name:\"SF-Area\"}' -e 'end tell'" </dev/null 2>&1 | sed 's/^/  [seed] /' | tee -a "$REPORT"
AREA=$(gq "SELECT uuid FROM TMArea WHERE title='SF-Area' LIMIT 1")
note "  SF-Area uuid=$AREA"

sf_proj_fate() {  # <uuid> <label> <expect>
  local u="$1" label="$2" expect="$3"
  local row; row=$(gq "SELECT 'exists='||COUNT(*)||' start='||COALESCE(MAX(start),'-')||' tmpl='||COALESCE(MAX(rt1_repeatingTemplate),'NULL')||' rule='||COALESCE(MAX(rt1_recurrenceRule IS NOT NULL),'-') FROM TMTask WHERE uuid='$u'")
  local verdict="?"; case "$row" in
    exists=0*) verdict="DELETE";;
    exists=1*tmpl=NULL*rule=1*) verdict="AMBIGUOUS(survives-as-template)";;
    exists=1*rule=1*) verdict="PRESERVE(as-instance)";;
    exists=1*) verdict="AMBIGUOUS(row survives, no rule/tmpl — did the op run?)";;
  esac
  note "  [SF-P $label] source $u -> $verdict   (expect $expect)   [$row]"
}
sf_case_proj() {  # <title> <expect> <child-fate>
  local title="$1" expect="$2" cf="$3"
  lab_ssh "$IP" "open 'things:///json?data=$(enc "[{\"type\":\"project\",\"attributes\":{\"title\":\"$title\",\"area-id\":\"$AREA\",\"items\":[{\"type\":\"to-do\",\"attributes\":{\"title\":\"$title-c\"}}]}}]")'; sleep 3" </dev/null
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
sf_case_proj SF-Pcp1  PRESERVE complete
sf_case_proj SF-Pcp2  PRESERVE complete
sf_case_proj SF-Pcx1  PRESERVE cancel
sf_case_proj SF-Pcx2  PRESERVE cancel
sf_case_proj SF-Pok1  PRESERVE open-checked
sf_case_proj SF-Pok2  PRESERVE open-checked
sf_case_proj SF-Pbo1  DELETE   open
sf_case_proj SF-Pbo2  DELETE   open

# =====================================================================
# P3b (UMD) — dissolve-heading / move-heading-to-project (NO --dangerously-drive-gui)
# =====================================================================
note ""; note "################################################################"
note "# P3b (UMD) — dissolve-heading + move-heading-to-project (ui.enabled gate only)"
note "################################################################"
warm
note "### dissolve-heading — surviving children umd ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"UMD-DHP","items":[{"type":"heading","attributes":{"title":"UMD-DH"}},{"type":"to-do","attributes":{"title":"UMD-DH-c1"}},{"type":"to-do","attributes":{"title":"UMD-DH-c2"}}]}}]')'; sleep 3" </dev/null
DHP=$(uidp "UMD-DHP")
DC1=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-DH-c1' LIMIT 1"); DC2=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-DH-c2' LIMIT 1")
DC1B=$(umd "$DC1"); DC2B=$(umd "$DC2")
note "  children umd before: c1=$DC1B c2=$DC2B"
warm; snap dh-pre
drive UMD-dissolve project dissolve-heading "$DHP" UMD-DH --json
settle; snap dh-post
note "  --- dissolve delta ---"; diff_c dh-pre dh-post "UMD-DH"
DC1A=$(umd "$DC1"); DC2A=$(umd "$DC2")
note "  [UMD dissolve-children] c1 umd $DC1B -> $DC1A ($([ "$DC1B" != "$DC1A" ] && echo BUMP || echo SILENT))   c2 umd $DC2B -> $DC2A ($([ "$DC2B" != "$DC2A" ] && echo BUMP || echo SILENT))"
note "  children after: c1 heading=$(gq "SELECT COALESCE(heading,'NULL') FROM TMTask WHERE uuid='$DC1'") project=$(gq "SELECT COALESCE(project,'NULL') FROM TMTask WHERE uuid='$DC1'")"

note ""; note "### move-heading-to-project — heading row umd ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"UMD-MHS","items":[{"type":"heading","attributes":{"title":"UMD-MH"}},{"type":"to-do","attributes":{"title":"UMD-MH-c1"}}]}},{"type":"project","attributes":{"title":"UMD-MHD","items":[]}}]')'; sleep 3" </dev/null
MHS=$(uidp "UMD-MHS"); MHD=$(uidp "UMD-MHD")
MH=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-MH' AND type=2 LIMIT 1"); MHC=$(gq "SELECT uuid FROM TMTask WHERE title='UMD-MH-c1' LIMIT 1")
MHB=$(umd "$MH"); MHCB=$(umd "$MHC")
note "  heading umd before: $MHB  child umd before: $MHCB  (heading project=$(gq "SELECT COALESCE(project,'NULL') FROM TMTask WHERE uuid='$MH'"))"
warm; snap mh-pre
drive UMD-move-heading project move-heading-to-project "$MHS" UMD-MH --to UMD-MHD --json
settle; snap mh-post
note "  --- move-heading-to-project delta ---"; diff_c mh-pre mh-post "UMD-MH"
MHA=$(umd "$MH"); MHCA=$(umd "$MHC")
note "  [UMD move-heading] heading umd $MHB -> $MHA ($([ "$MHB" != "$MHA" ] && echo BUMP || echo SILENT))   child umd $MHCB -> $MHCA ($([ "$MHCB" != "$MHCA" ] && echo BUMP || echo SILENT))"
note "  heading after: project=$(gq "SELECT COALESCE(project,'NULL') FROM TMTask WHERE uuid='$MH'") (dest=$MHD)"

# =====================================================================
# P3c (UMD) — reminder set/clear (clear with --when restated)
# =====================================================================
note ""; note "################################################################"
note "# P3c (UMD) — reminder set + clear (clear re-states --when per H-REMINDER-SCOPE)"
note "################################################################"
drive UMD-rem-seed todo add \"UMD-rem\" --json >/dev/null
UREM=$(uidt "UMD-rem")
RB=$(umd "$UREM")
drive umd-rem-set todo update "$UREM" --when 2026-07-05 --reminder 14:30 >/dev/null
RS=$(umd "$UREM")
note "  [UMD rem-set] umd $RB -> $RS ($([ "$RB" != "$RS" ] && echo BUMP || echo SILENT))   after: $(gq "SELECT 'reminderTime='||COALESCE(reminderTime,'NULL')||' startDate='||COALESCE(startDate,'NULL')||' start='||start FROM TMTask WHERE uuid='$UREM'")"
drive umd-rem-clear todo update "$UREM" --when today --clear-reminder >/dev/null
RC=$(umd "$UREM")
note "  [UMD rem-clear] umd $RS -> $RC ($([ "$RS" != "$RC" ] && echo BUMP || echo SILENT))   after: $(gq "SELECT 'reminderTime='||COALESCE(reminderTime,'NULL')||' startDate='||COALESCE(startDate,'NULL')||' start='||start FROM TMTask WHERE uuid='$UREM'")"

note ""; note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"
note "DONE. report: $REPORT"
