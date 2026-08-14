#!/bin/bash
# UIC8 — VM lab certification of the promote-via-clone compounds shipped in #464
# (src/write/promote-clone.ts: the REWIRED todo/project make-repeating =
# clone(X,--preserve-created) → trash(X) → native-promote(clone), the new
# todo/project add-repeating = add → native-promote, and the automated trash-both
# + restore undo). CI has no app, so these ship with leg-command-sequence + undo-
# record unit coverage ONLY. This drives them END-TO-END through the PRODUCTION
# CLI against a live Things app in ONE disposable clone of things-lab-golden-v2
# (Things 3.22.12), asserting the full DB byte-effect + JSON result shapes.
#
# Worklists (docs/lab/uic8-promote-clone-cert.md):
#   C1  todo make-repeating (fixed + after-completion) on bare / deadline /
#       content-rich to-dos — X in Trash byte-intact incl. creationDate; template
#       + instance minted; result {uuid=template, repeating{templateUuid,
#       instanceUuid, replacedUuid}}; warnings disclose trashed original + placement.
#   C2  project make-repeating on plain-children / headings+completed-child /
#       area'd projects; the nested-repeater project REFUSES (H-CLONE-SOURCE),
#       X untouched.
#   C3  UNDO round-trip (ratified trash-both) for a to-do + a project case:
#       template+instance trashed (cursor cleared), X restored live byte-intact;
#       internalSeriesRemoval fired ONLY via undo (a direct `todo delete <tmpl>`
#       still refuses H-REPEAT-SCHEDULE); +2-day clock advance = zero spawns.
#   C4  todo/project add-repeating (fixed + after-completion): one-instance-on-
#       create shape, rule bytes via decoded rt1_recurrenceRule, undo removes the
#       series cleanly (no original to restore).
#   C6  symmetric umd-undo smoke: a C1 case with --preserve-modified, then undo.
#   C5  failure rollback (LAST — revokes Accessibility): force a promote failure
#       mid-compound → X rolled back OUT of the Trash, honest error.
#
# METHOD mirrors research-clone.sh. golden-v2 carries the baked L3-accessibility
# grant (auth_value=2, reboot-verified) so there is NO VNC grant step — the ui
# vector drives via System Events over SSH. Airgap + pin clock 2026-07-05 12:00,
# advanced in +1-day steps (RSIM-S). Ship the PRODUCTION e2e bundle; drive through
# the shipped CLI. Ground truth = read-only guest SQLite row deltas. Fixtures
# fully synthetic (U8* titles). Branch mg/promote-clone-cert.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="uic8-lab"
GOLDEN="things-lab-golden-v2"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps" "$OUT/json"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[uic8] $*" | tee -a "$REPORT"; }
cleanup() { echo "[uic8] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
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

# ---------------- clone + boot (golden-v2 has AX baked) ----------------
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[uic8] /'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "Accessibility auth_value=$GRANT (2=granted, baked in golden-v2)"
if [ "$GRANT" != "2" ]; then note "FATAL: Accessibility grant missing on clone (auth_value=$GRANT). Abort."; exit 1; fi

# ---------------- guest helpers: read-only SQLite + snapshot dumper ----------------
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# full-table snapshot (from research-clone.sh)
lab_ssh "$IP" 'cat > /tmp/rsnap.py' <<'EOF'
import sys, sqlite3, glob, plistlib, json
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
cols=["uuid","title","type","status","trashed","start","startDate","startBucket",
      "reminderTime","deadline","t2_deadlineOffset","\"index\"","todayIndex","stopDate",
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
    tasktags.append({"task":tk,"tag":tg,"tagName":tagname.get(tg)})
checklist={}
try:
    for cu,tk,ti,st,ix in c.execute('SELECT uuid,task,title,status,"index" FROM TMChecklistItem'):
        checklist[cu]={"task":tk,"title":ti,"status":st,"index":ix}
except Exception as e:
    checklist={"__error__":str(e)}
json.dump({"tasks":tasks,"tasktags":tasktags,"checklist":checklist,"areas":areas},sys.stdout,default=str)
EOF
snap() { lab_ssh "$IP" 'python3 /tmp/rsnap.py' </dev/null > "$OUT/snaps/$1.json"; }

# decoded-rule dumper (from research-uic7.sh) — for C4 rule-byte assertions
lab_ssh "$IP" 'cat > /tmp/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
row=c.execute("SELECT rt1_recurrenceRule, deadline, rt1_nextInstanceStartDate FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row or row[0] is None: print("NO-RULE"); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] next=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),row[2]))
EOF
rsum() { lab_ssh "$IP" "python3 /tmp/rsum.py $1" </dev/null; }

# subtree dumper (from research-clone.sh)
lab_ssh "$IP" 'cat > /tmp/kids.py' <<'EOF'
import sys, sqlite3, glob
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
p=sys.argv[1]
def q(sql,*a): return c.execute(sql,a).fetchall()
def rule(u): return q("SELECT (rt1_recurrenceRule IS NOT NULL) FROM TMTask WHERE uuid=?",u)[0][0]
def tmpl(u): return q("SELECT rt1_repeatingTemplate FROM TMTask WHERE uuid=?",u)[0][0]
def sh(u): return "rule=%s tmpl=%s"%(rule(u), (str(tmpl(u))[:8] if tmpl(u) else None))
row=q("SELECT title,status,trashed FROM TMTask WHERE uuid=?",p)
print("PROJECT %s  %s  status=%s trashed=%s %s"%(p, row[0][0] if row else "MISSING", row[0][1] if row else "?", row[0][2] if row else "?", sh(p) if row else ""))
for hu,ht,hst,htr in q("SELECT uuid,title,status,trashed FROM TMTask WHERE type=2 AND project=? ORDER BY \"index\"",p):
    print("  HEADING %s '%s' status=%s trashed=%s [%s]"%(hu,ht,hst,htr,sh(hu)))
    for u,t,ty,stt,tr,sd in q("SELECT uuid,title,type,status,trashed,stopDate FROM TMTask WHERE heading=? ORDER BY \"index\"",hu):
        print("    TODO(headed) %s '%s' type=%s status=%s trashed=%s stop=%s [%s]"%(u,t,ty,stt,tr,sd,sh(u)))
for u,t,ty,stt,tr,sd in q("SELECT uuid,title,type,status,trashed,stopDate FROM TMTask WHERE project=? AND type=0 ORDER BY \"index\"",p):
    print("  TODO(direct) %s '%s' type=%s status=%s trashed=%s stop=%s [%s]"%(u,t,ty,stt,tr,sd,sh(u)))
EOF
kids() { lab_ssh "$IP" "python3 /tmp/kids.py $1" </dev/null | tee -a "$REPORT"; }

# ---------------- host-side snapshot differ (from research-clone.sh) ----------------
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
COCOAF={"creationDate","userModificationDate","stopDate"}
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
    f.append("startDate=%s deadline=%s creationDate=%s stopDate=%s"%(dpk(d.get("startDate")),dpk(d.get("deadline")),cocoa(d.get("creationDate")),cocoa(d.get("stopDate"))))
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
print("  TMTask  INSERTED: %d  DELETED: %d  CHANGED: %d"%(len(ins),len(dele),len(chg)))
for u in ins:
    d=b[u]; print("  + INSERT %s  \"%s\"\n      %s"%(u,d.get("title"),line(d,B)))
for u in dele:
    d=a[u]; print("  - DELETE %s  \"%s\"  (was trashed=%s rule=%s tmpl=%s)"%(u,d.get("title"),d.get("trashed"),rr(d),ref(d.get("rt1_repeatingTemplate"),A)))
for u,diffs in chg:
    print("  ~ CHANGE %s  \"%s\""%(u,b[u].get("title")))
    for k,(ov,nv) in sorted(diffs.items()):
        if k=="rt1_recurrenceRule": ov,nv=rr({"rt1_recurrenceRule":ov}),rr({"rt1_recurrenceRule":nv})
        elif k in ("project","heading","area","rt1_repeatingTemplate"): ov,nv=ref(ov,A),ref(nv,B)
        elif k in DATEF: ov,nv=dpk(ov),dpk(nv)
        elif k in COCOAF: ov,nv=cocoa(ov),cocoa(nv)
        print("      %s: %s -> %s"%(k,ov,nv))
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
if ! lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1; then
  note "FATAL: guest node not runnable after ship — bundle ship failed. Abort."; exit 1
fi
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$CLI $*" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1
# seed tags referenced by the content-rich C1c case (URL --tags attaches EXISTING tags only)
lab_ssh "$IP" "osascript -e 'tell application \"Things3\"' -e 'make new tag with properties {name:\"cltag1\"}' -e 'make new tag with properties {name:\"cltag2\"}' -e 'end tell'" </dev/null >/dev/null 2>&1 || true

# jd <name> <cli args...> — drive the CLI; stdout(json)->.json  stderr(warnings)->.err
# exit code -> .exit ; append a compact verdict line to the report.
jd() {
  local name="$1"; shift
  lab_ssh "$IP" "$CLI $* --json" </dev/null > "$OUT/json/$name.json" 2> "$OUT/json/$name.err"
  echo "$?" > "$OUT/json/$name.exit"
  local ex; ex=$(cat "$OUT/json/$name.exit")
  local verdict
  verdict=$(python3 - "$OUT/json/$name.json" <<'PY'
import sys,json
objs=[]
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    try: objs.append(json.loads(line))
    except Exception: pass
if not objs: print("NON-JSON/empty"); sys.exit()
d=objs[-1]  # undo emits JSONL: per-item lines + a trailing summary — take the last
if d.get("ok"):
    da=d.get("data",{}); rp=da.get("repeating") or {}
    print("ok uuid=%s tmpl=%s inst=%s repl=%s"%(str(da.get("uuid"))[:8], str(rp.get("templateUuid"))[:8], str(rp.get("instanceUuid"))[:8], str(rp.get("replacedUuid"))[:8]))
else:
    er=d.get("error",{}); print("ERR code=%s msg=%s"%(er.get("code"), str(er.get("message"))[:80]))
PY
)
  note "  [$name] exit=$ex $verdict"
}
# jval <name> <dotted-path under data> -> value (empty if absent)
jval() {
  python3 - "$OUT/json/$1.json" "$2" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print(""); sys.exit()
cur=d.get("data",{})
for k in sys.argv[2].split('.'):
    cur=cur.get(k) if isinstance(cur,dict) else None
print(cur if cur is not None else "")
PY
}
jerr() { # jerr <name> <error-field>  (code|message|remediation)
  python3 - "$OUT/json/$1.json" "$2" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print(""); sys.exit()
print((d.get("error",{}) or {}).get(sys.argv[2],""))
PY
}

# ---------------- assertion helpers ----------------
PASS=0; FAIL=0
ok()  { note "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { note "  [FAIL] $1"; FAIL=$((FAIL+1)); }
assert_eq()   { if [ "$2" = "$3" ]; then ok "$1 (=$3)"; else bad "$1: expected '$2' got '$3'"; fi; }
assert_ne()   { if [ "$2" != "$3" ]; then ok "$1 ($2 != $3)"; else bad "$1: both '$2'"; fi; }
assert_ntmt() { if [ -n "$2" ]; then ok "$1 ($2)"; else bad "$1: empty"; fi; }
assert_grep() { if grep -qF "$2" "$3" 2>/dev/null; then ok "$1"; else bad "$1: '$2' not in $(basename "$3")"; fi; }

# row-state getters
rtrash() { gq "SELECT COALESCE((SELECT trashed FROM TMTask WHERE uuid='$1'),'ABSENT')"; }
rexists(){ gq "SELECT COUNT(*) FROM TMTask WHERE uuid='$1'"; }
rrule()  { gq "SELECT COALESCE((SELECT (rt1_recurrenceRule IS NOT NULL) FROM TMTask WHERE uuid='$1'),'ABSENT')"; }
rtfk()   { gq "SELECT COALESCE((SELECT rt1_repeatingTemplate FROM TMTask WHERE uuid='$1'),'NULL')"; }
rtitle() { gq "SELECT COALESCE((SELECT title FROM TMTask WHERE uuid='$1'),'ABSENT')"; }
rnotes() { gq "SELECT COALESCE((SELECT notes FROM TMTask WHERE uuid='$1'),'NULL')"; }
rcre()   { gq "SELECT COALESCE((SELECT creationDate FROM TMTask WHERE uuid='$1'),'NULL')"; }
rumd()   { gq "SELECT COALESCE((SELECT userModificationDate FROM TMTask WHERE uuid='$1'),'NULL')"; }
rnext()  { gq "SELECT COALESCE((SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$1'),'NULL')"; }
rowfull(){ gq "SELECT uuid,title,type,status,trashed,(rt1_recurrenceRule IS NOT NULL) hasRule,rt1_repeatingTemplate tmpl,creationDate cre FROM TMTask WHERE uuid='$1'" | sed 's/^/    /' | tee -a "$REPORT"; }
# live (non-trashed) instances of a template
liveinst(){ gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0"; }

# uid resolvers (plain items by title)
uidt() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
uidp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }

warm()   { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 15; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
env_line() { note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"; }
clock_to() { settle; lab_ssh "$IP" "sudo date $1 >/dev/null" </dev/null; note "  clock -> $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"; warm; }

env_line

# =====================================================================
# Common per-case checker for a successful make-repeating (X trashed byte-intact,
# template + instance minted, result contract). Args: label origUuid jsonName
#   preCre preNotes preTitle
# =====================================================================
check_make_repeating() {
  local label="$1" X="$2" jn="$3" preCre="$4" preNotes="$5" preTitle="$6"
  local TPL INST REPL ex
  ex=$(cat "$OUT/json/$jn.exit"); TPL=$(jval "$jn" repeating.templateUuid); INST=$(jval "$jn" repeating.instanceUuid); REPL=$(jval "$jn" repeating.replacedUuid)
  assert_eq "$label: exit 0" "0" "$ex"
  assert_eq "$label: result.uuid == templateUuid" "$(jval "$jn" uuid)" "$TPL"
  assert_ntmt "$label: templateUuid present" "$TPL"
  assert_ntmt "$label: instanceUuid present" "$INST"
  assert_ntmt "$label: replacedUuid present" "$REPL"
  # X (original) trashed byte-intact
  assert_eq "$label: X trashed=1" "1" "$(rtrash "$X")"
  assert_eq "$label: X title intact" "$preTitle" "$(rtitle "$X")"
  assert_eq "$label: X notes intact" "$preNotes" "$(rnotes "$X")"
  assert_eq "$label: X creationDate intact" "$preCre" "$(rcre "$X")"
  # template row live with a rule
  assert_eq "$label: template hasRule=1" "1" "$(rrule "$TPL")"
  assert_eq "$label: template trashed=0" "0" "$(rtrash "$TPL")"
  assert_eq "$label: template title == X" "$preTitle" "$(rtitle "$TPL")"
  # instance points at template, live
  assert_eq "$label: instance tmpl-FK == template" "$TPL" "$(rtfk "$INST")"
  assert_eq "$label: instance trashed=0" "0" "$(rtrash "$INST")"
  # warnings disclose trashed original + placement
  assert_grep "$label: warns trashed original" "moved to the Trash" "$OUT/json/$jn.err"
  assert_grep "$label: warns placement" "default position" "$OUT/json/$jn.err"
  note "    template row:"; rowfull "$TPL"
  note "    instance row:"; rowfull "$INST"
}

# =====================================================================
# WORKLIST C1 — todo make-repeating (fixed + after-completion)
# =====================================================================
note ""; note "################################################################"
note "# C1 — todo make-repeating  (X→Trash byte-intact; template+instance minted)"
note "################################################################"

# --- C1a: bare to-do, FIXED weekly/1 ---
note ""; note "### C1a — bare to-do, FIXED weekly/1 ###"
G todo add \"U8-C1a\" >/dev/null 2>&1; sleep 1
XA=$(uidt "U8-C1a"); CREA=$(rcre "$XA"); NOTA=$(rnotes "$XA"); note "  seed X=$XA cre=$CREA"
snap c1a-pre; warm
jd c1a todo make-repeating "$XA" --frequency weekly --interval 1 --dangerously-drive-gui
settle; snap c1a-post
note "  --- C1a delta ---"; diff_c c1a-pre c1a-post "U8-C1a"
check_make_repeating "C1a" "$XA" c1a "$CREA" "$NOTA" "U8-C1a"

# --- C1b: deadline to-do, AFTER-COMPLETION weekly/1 ---
note ""; note "### C1b — deadline to-do, AFTER-COMPLETION weekly/1 ###"
G todo add \"U8-C1b\" --deadline 2026-07-20 >/dev/null 2>&1; sleep 1
XB=$(uidt "U8-C1b"); CREB=$(rcre "$XB"); NOTB=$(rnotes "$XB"); note "  seed X=$XB cre=$CREB deadline=$(gq "SELECT deadline FROM TMTask WHERE uuid='$XB'")"
snap c1b-pre; warm
jd c1b todo make-repeating "$XB" --frequency weekly --interval 1 --after-completion --dangerously-drive-gui
settle; snap c1b-post
note "  --- C1b delta ---"; diff_c c1b-pre c1b-post "U8-C1b"
check_make_repeating "C1b" "$XB" c1b "$CREB" "$NOTB" "U8-C1b"
note "  C1b template decoded rule (expect fa=2 after-completion): $(rsum "$(jval c1b repeating.templateUuid)")"

# --- C1c: content-rich to-do (notes/tags/checklist+checked/reminder/when=date + backdated created-at), FIXED ---
rrem() { gq "SELECT COALESCE((SELECT reminderTime FROM TMTask WHERE uuid='$1'),'NULL')"; }
chkstate() { gq "SELECT group_concat(title||':'||status,',') FROM (SELECT title,status FROM TMChecklistItem WHERE task='$1' ORDER BY \"index\")"; }

# NB: the CLI refuses --reminder together with --created-at (a backdated item cannot
# also carry a reminder — intentional guard), so the content-rich case is split into
# a REMINDER sub-case (C1c) and a BACKDATED --created-at sub-case (C1c2); together they
# cover notes/tags/checklist-with-a-checked-item/reminder/when=date + a backdated creationDate.

note ""; note "### C1c — content-rich to-do: notes/tags/checklist(+checked)/reminder/when=today, FIXED daily/1 ###"
G todo add \"U8-C1c\" --notes \"rich-body\" --tags \"cltag1,cltag2\" --create-tags --checklist-item ck1 --checklist-item ck2 --when today --reminder 09:30 > "$OUT/json/c1c-seed.log" 2>&1
sleep 1
XC=$(uidt "U8-C1c"); note "  seed X=$XC ($([ -z "$XC" ] && echo "SEED FAILED: $(tail -1 "$OUT/json/c1c-seed.log")" || echo ok))"
G todo checklist "$XC" --check ck1 >/dev/null 2>&1; sleep 1
CREC=$(rcre "$XC"); NOTC=$(rnotes "$XC"); REMC=$(rrem "$XC"); CHKC=$(chkstate "$XC")
note "  X pre-state:"; rowfull "$XC"
note "  X reminderTime=$REMC  checklist=$CHKC"
snap c1c-pre; warm
jd c1c todo make-repeating "$XC" --frequency daily --interval 1 --dangerously-drive-gui
settle; snap c1c-post
note "  --- C1c delta (FINDING: expect NO change — the clone leg refuses) ---"; diff_c c1c-pre c1c-post "U8-C1c"
# FINDING (captured, up-next): make-repeating on a reminder-bearing dated-`when` to-do
# currently FAILS — clone(X, --preserve-created) reproduces the source reminder AND a
# createdAt in ONE base add (clone.ts todoAddParams), which commands.ts:325 forbids
# ("--reminder is not available with --created-at"). The compound aborts at the clone
# leg (before trashing X), so X is left completely untouched — the honest fail-safe.
assert_eq "C1c: reminder+dated-when make-repeating fails at the clone leg (exit 1)" "1" "$(cat "$OUT/json/c1c.exit")"
assert_grep "C1c: error IS the clone reminder+createdAt collision" "reminder is not available with --created-at" "$OUT/json/c1c.json"
assert_eq "C1c: X left UNTOUCHED (not trashed)" "0" "$(rtrash "$XC")"
assert_eq "C1c: X reminderTime intact (untouched)" "$REMC" "$(rrem "$XC")"
assert_eq "C1c: X checklist intact (untouched)" "$CHKC" "$(chkstate "$XC")"
assert_eq "C1c: X still a plain to-do (no rule minted)" "0" "$(rrule "$XC")"
note "  [FINDING] C1c: reminder-bearing make-repeating is BLOCKED by the clone reminder+createdAt collision (up-next). The content-rich HAPPY path is certified by C1c2; the reminder byte is confirmed intact on the untouched source here."

note ""; note "### C1c2 — content-rich to-do: notes/tags/checklist(+checked)/when=date + backdated --created-at, FIXED daily/1 ###"
G todo add \"U8-C1c2\" --notes \"rich-body2\" --tags \"cltag1,cltag2\" --create-tags --checklist-item ck1 --checklist-item ck2 --when 2026-07-10 --created-at 2026-06-01T08:00 > "$OUT/json/c1c2-seed.log" 2>&1
sleep 1
XC2=$(uidt "U8-C1c2"); note "  seed X=$XC2 ($([ -z "$XC2" ] && echo "SEED FAILED: $(tail -1 "$OUT/json/c1c2-seed.log")" || echo ok))"
G todo checklist "$XC2" --check ck1 >/dev/null 2>&1; sleep 1
CREC2=$(rcre "$XC2"); NOTC2=$(rnotes "$XC2"); CHKC2=$(chkstate "$XC2")
note "  X pre-state (backdated creationDate=$CREC2):"; rowfull "$XC2"
snap c1c2-pre; warm
jd c1c2 todo make-repeating "$XC2" --frequency daily --interval 1 --dangerously-drive-gui
settle; snap c1c2-post
note "  --- C1c2 delta ---"; diff_c c1c2-pre c1c2-post "U8-C1c2"
check_make_repeating "C1c2" "$XC2" c1c2 "$CREC2" "$NOTC2" "U8-C1c2"
assert_eq "C1c2: X backdated creationDate byte-intact in Trash" "$CREC2" "$(rcre "$XC2")"
assert_eq "C1c2: X checklist byte-intact (ck1 checked) in Trash" "$CHKC2" "$(chkstate "$XC2")"

# --- C1d: bare to-do, AFTER-COMPLETION (after-completion on a bare) ---
note ""; note "### C1d — bare to-do, AFTER-COMPLETION daily/1 ###"
G todo add \"U8-C1d\" >/dev/null 2>&1; sleep 1
XD=$(uidt "U8-C1d"); CRED=$(rcre "$XD"); NOTD=$(rnotes "$XD"); note "  seed X=$XD"
snap c1d-pre; warm
jd c1d todo make-repeating "$XD" --frequency daily --interval 1 --after-completion --dangerously-drive-gui
settle; snap c1d-post
note "  --- C1d delta ---"; diff_c c1d-pre c1d-post "U8-C1d"
check_make_repeating "C1d" "$XD" c1d "$CRED" "$NOTD" "U8-C1d"

# =====================================================================
# WORKLIST C2 — project make-repeating + nested-repeater refusal
# =====================================================================
note ""; note "################################################################"
note "# C2 — project make-repeating  (+ nested-repeater H-CLONE-SOURCE refusal)"
note "################################################################"
enc() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$1"; }

# --- C2a: plain-children project, FIXED weekly/1 ---
note ""; note "### C2a — plain-children project, FIXED weekly/1 ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"U8-C2a","items":[{"type":"to-do","attributes":{"title":"U8-C2a-k1"}},{"type":"to-do","attributes":{"title":"U8-C2a-k2"}}]}}]')'; sleep 3" </dev/null
PA=$(uidp "U8-C2a"); CREPA=$(rcre "$PA"); NOTPA=$(rnotes "$PA"); note "  seed P=$PA"; kids "$PA"
snap c2a-pre; warm
jd c2a project make-repeating "$PA" --frequency weekly --interval 1 --dangerously-drive-gui
settle; snap c2a-post
note "  --- C2a delta ---"; diff_c c2a-pre c2a-post "U8-C2a"
check_make_repeating "C2a" "$PA" c2a "$CREPA" "$NOTPA" "U8-C2a"
note "  C2a template subtree:"; kids "$(jval c2a repeating.templateUuid)"

# --- C2b: project with a heading + a completed child, AFTER-COMPLETION ---
note ""; note "### C2b — project w/ heading + completed child, AFTER-COMPLETION weekly/1 ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"U8-C2b","items":[{"type":"heading","attributes":{"title":"U8-C2b-H"}},{"type":"to-do","attributes":{"title":"U8-C2b-done","heading":"U8-C2b-H"}},{"type":"to-do","attributes":{"title":"U8-C2b-open"}}]}}]')'; sleep 3" </dev/null
PB=$(uidp "U8-C2b")
PBDONE=$(gq "SELECT uuid FROM TMTask WHERE title='U8-C2b-done' AND project='$PB' LIMIT 1")
G todo complete "$PBDONE" --completed-at 2026-07-03T14:00 >/dev/null 2>&1; sleep 1
CREPB=$(rcre "$PB"); NOTPB=$(rnotes "$PB"); note "  seed P=$PB (heading + completed child)"; kids "$PB"
snap c2b-pre; warm
jd c2b project make-repeating "$PB" --frequency weekly --interval 1 --after-completion --dangerously-drive-gui
settle; snap c2b-post
note "  --- C2b delta ---"; diff_c c2b-pre c2b-post "U8-C2b"
check_make_repeating "C2b" "$PB" c2b "$CREPB" "$NOTPB" "U8-C2b"
note "  C2b template subtree (heading + completed-child fate on the clone-promote):"; kids "$(jval c2b repeating.templateUuid)"

# --- C2c: area'd project, FIXED weekly/1 ---
note ""; note "### C2c — area'd project, FIXED weekly/1 ###"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\"' -e 'make new area with properties {name:\"U8-Area\"}' -e 'end tell'" </dev/null 2>&1 | sed 's/^/  [seed] /' | tee -a "$REPORT"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"U8-C2c","area":"U8-Area","items":[{"type":"to-do","attributes":{"title":"U8-C2c-k1"}}]}}]')'; sleep 3" </dev/null
PC=$(uidp "U8-C2c"); CREPC=$(rcre "$PC"); NOTPC=$(rnotes "$PC")
AREAFK=$(gq "SELECT area FROM TMTask WHERE uuid='$PC'"); note "  seed P=$PC area-FK=$AREAFK"; kids "$PC"
snap c2c-pre; warm
jd c2c project make-repeating "$PC" --frequency weekly --interval 1 --dangerously-drive-gui
settle; snap c2c-post
note "  --- C2c delta ---"; diff_c c2c-pre c2c-post "U8-C2c"
check_make_repeating "C2c" "$PC" c2c "$CREPC" "$NOTPC" "U8-C2c"
TPLC=$(jval c2c repeating.templateUuid)
note "  C2c template area-FK (expect area preserved on clone-promote): $(gq "SELECT area FROM TMTask WHERE uuid='$TPLC'") (src area=$AREAFK)"

# --- C2d: nested-repeater project REFUSES (H-CLONE-SOURCE), X untouched ---
note ""; note "### C2d — nested-repeater project REFUSES H-CLONE-SOURCE (X untouched) ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"U8-C2d","items":[{"type":"to-do","attributes":{"title":"U8-C2d-nested"}}]}}]')'; sleep 3" </dev/null
PD=$(uidp "U8-C2d")
NEST=$(gq "SELECT uuid FROM TMTask WHERE title='U8-C2d-nested' AND project='$PD' LIMIT 1")
warm
jd c2d-mknest todo make-repeating "$NEST" --frequency weekly --interval 1 --dangerously-drive-gui
settle
note "  nested to-do now a template? $(gq "SELECT uuid,(rt1_recurrenceRule IS NOT NULL) hasRule FROM TMTask WHERE title LIKE 'U8-C2d-nested%'")"
PDCRE=$(rcre "$PD"); PDTRASH=$(rtrash "$PD")
snap c2d-pre
jd c2d project make-repeating "$PD" --frequency weekly --interval 1 --dangerously-drive-gui
snap c2d-post
assert_eq "C2d: refusal exit 4 (blocked)" "4" "$(cat "$OUT/json/c2d.exit")"
assert_eq "C2d: code blocked:H-CLONE-SOURCE" "blocked:H-CLONE-SOURCE" "$(jerr c2d code)"
assert_eq "C2d: X (project) NOT trashed" "$PDTRASH" "$(rtrash "$PD")"
assert_eq "C2d: X creationDate untouched" "$PDCRE" "$(rcre "$PD")"
assert_eq "C2d: X still a plain project (no rule)" "0" "$(rrule "$PD")"
note "  --- C2d delta (expect no U8-C2d rows created) ---"; diff_c c2d-pre c2d-post "U8-C2d"
note "  C2d refusal message: $(jerr c2d message | head -c 200)"

# =====================================================================
# WORKLIST C3 — UNDO round-trip (ratified trash-both + restore)
# =====================================================================
note ""; note "################################################################"
note "# C3 — undo round-trip: trash-both + restore; internal-only template delete"
note "################################################################"

# --- C3-todo: fresh to-do make-repeating, then undo ---
note ""; note "### C3-todo — to-do make-repeating → undo (trash-both + restore) ###"
G todo add \"U8-C3t\" --notes \"c3t-body\" >/dev/null 2>&1; sleep 1
X3=$(uidt "U8-C3t"); CRE3=$(rcre "$X3"); NOT3=$(rnotes "$X3"); note "  seed X=$X3 cre=$CRE3"
warm
jd c3t todo make-repeating "$X3" --frequency weekly --interval 1 --dangerously-drive-gui
settle
TPL3=$(jval c3t repeating.templateUuid); INST3=$(jval c3t repeating.instanceUuid); TOK3=$(jval c3t undoToken)
note "  minted template=$TPL3 instance=$INST3 undoToken=$TOK3"
# internalSeriesRemoval fires ONLY via undo: a direct template delete must refuse
jd c3t-directdel todo delete "$TPL3"
assert_eq "C3t: direct template delete refuses (exit 4)" "4" "$(cat "$OUT/json/c3t-directdel.exit")"
assert_eq "C3t: direct template delete code H-REPEAT-SCHEDULE" "blocked:H-REPEAT-SCHEDULE" "$(jerr c3t-directdel code)"
assert_eq "C3t: template still live after refused direct delete" "0" "$(rtrash "$TPL3")"
# now undo by exact token
snap c3t-preundo
jd c3t-undo undo --txn "$TOK3"
snap c3t-postundo
assert_eq "C3t: undo exit 0" "0" "$(cat "$OUT/json/c3t-undo.exit")"
assert_eq "C3t: template trashed by undo" "1" "$(rtrash "$TPL3")"
assert_eq "C3t: template cursor cleared (next NULL)" "NULL" "$(rnext "$TPL3")"
assert_eq "C3t: instance trashed by undo" "1" "$(rtrash "$INST3")"
assert_eq "C3t: X restored live (trashed=0)" "0" "$(rtrash "$X3")"
assert_eq "C3t: X content intact after restore" "$NOT3" "$(rnotes "$X3")"
assert_eq "C3t: X creationDate intact after restore" "$CRE3" "$(rcre "$X3")"
note "  --- C3t undo delta ---"; diff_c c3t-preundo c3t-postundo "U8-C3t"
assert_eq "C3t: zero live instances of the undone series (post-undo)" "0" "$(liveinst "$TPL3")"

# --- C3-project: fresh project make-repeating, then undo ---
note ""; note "### C3-project — project make-repeating → undo (trash-both + restore in place) ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"U8-C3p","items":[{"type":"to-do","attributes":{"title":"U8-C3p-k1"}}]}}]')'; sleep 3" </dev/null
X3P=$(uidp "U8-C3p"); CRE3P=$(rcre "$X3P"); note "  seed X=$X3P"
warm
jd c3p project make-repeating "$X3P" --frequency weekly --interval 1 --dangerously-drive-gui
settle
TPL3P=$(jval c3p repeating.templateUuid); INST3P=$(jval c3p repeating.instanceUuid); TOK3P=$(jval c3p undoToken)
note "  minted template=$TPL3P instance=$INST3P undoToken=$TOK3P"
jd c3p-directdel project delete "$TPL3P"
assert_eq "C3p: direct template delete refuses (exit 4)" "4" "$(cat "$OUT/json/c3p-directdel.exit")"
assert_eq "C3p: direct template delete code H-REPEAT-SCHEDULE" "blocked:H-REPEAT-SCHEDULE" "$(jerr c3p-directdel code)"
snap c3p-preundo
jd c3p-undo undo --txn "$TOK3P"
snap c3p-postundo
assert_eq "C3p: undo exit 0" "0" "$(cat "$OUT/json/c3p-undo.exit")"
assert_eq "C3p: template trashed by undo" "1" "$(rtrash "$TPL3P")"
assert_eq "C3p: template cursor cleared (next NULL)" "NULL" "$(rnext "$TPL3P")"
assert_eq "C3p: instance trashed by undo" "1" "$(rtrash "$INST3P")"
assert_eq "C3p: X (project) restored live (trashed=0)" "0" "$(rtrash "$X3P")"
assert_eq "C3p: X creationDate intact after restore" "$CRE3P" "$(rcre "$X3P")"
note "  --- C3p undo delta ---"; diff_c c3p-preundo c3p-postundo "U8-C3p"
assert_eq "C3p: zero live instances of the undone project series (post-undo)" "0" "$(liveinst "$TPL3P")"

# +2-day advance (RSIM-S, +1-day steps): NEITHER undone series may spawn anything
note ""; note "### C3-advance — +2-day clock roll: both undone series must spawn ZERO ###"
clock_to 070612002026; clock_to 070712002026
assert_eq "C3t: zero spawns from the undone to-do series after +2 days" "0" "$(liveinst "$TPL3")"
assert_eq "C3p: zero spawns from the undone project series after +2 days" "0" "$(liveinst "$TPL3P")"

# =====================================================================
# WORKLIST C4 — todo/project add-repeating (fixed + after-completion)
# =====================================================================
note ""; note "################################################################"
note "# C4 — add-repeating: one-instance-on-create; rule bytes; clean undo (no original)"
note "################################################################"

# --- C4a: todo add-repeating, FIXED weekly/1 ---
note ""; note "### C4a — todo add-repeating, FIXED weekly/1 ###"
snap c4a-pre; warm
jd c4a todo add-repeating \"U8-C4a\" --frequency weekly --interval 1 --dangerously-drive-gui
settle; snap c4a-post
note "  --- C4a delta ---"; diff_c c4a-pre c4a-post "U8-C4a"
T4A=$(jval c4a repeating.templateUuid); I4A=$(jval c4a repeating.instanceUuid); TOK4A=$(jval c4a undoToken)
assert_eq "C4a: exit 0" "0" "$(cat "$OUT/json/c4a.exit")"
assert_eq "C4a: template hasRule=1" "1" "$(rrule "$T4A")"
# FIXED-schedule add-repeating whose first occurrence is in the future materializes
# ONLY the template + a future cursor (RSIM spawn law) — no immediate instance.
# (Contrast after-completion, C4b/C4d, which spawn one immediately.)
assert_eq "C4a: no immediate instance for a future-dated fixed occurrence (instanceUuid null)" "" "$I4A"
assert_eq "C4a: zero live instances on create (future fixed cursor)" "0" "$(liveinst "$T4A")"
assert_ne "C4a: template carries a future cursor (next set)" "NULL" "$(rnext "$T4A")"
note "  C4a decoded rule (expect tp=0 fu=256 fixed weekly): $(rsum "$T4A")"
assert_grep "C4a: placement disclosure present" "default position" "$OUT/json/c4a.err"
if grep -qF "moved to the Trash" "$OUT/json/c4a.err"; then bad "C4a: add-repeating must NOT disclose a trashed original"; else ok "C4a: no trashed-original disclosure (no original)"; fi
# undo removes the series cleanly (no original to restore)
jd c4a-undo undo --txn "$TOK4A"
assert_eq "C4a: undo exit 0" "0" "$(cat "$OUT/json/c4a-undo.exit")"
assert_eq "C4a: undo trashed template" "1" "$(rtrash "$T4A")"

# --- C4b: todo add-repeating, AFTER-COMPLETION daily/1 ---
note ""; note "### C4b — todo add-repeating, AFTER-COMPLETION daily/1 ###"
warm
jd c4b todo add-repeating \"U8-C4b\" --frequency daily --interval 1 --after-completion --dangerously-drive-gui
settle
T4B=$(jval c4b repeating.templateUuid)
assert_eq "C4b: exit 0" "0" "$(cat "$OUT/json/c4b.exit")"
assert_eq "C4b: exactly ONE live instance on create" "1" "$(liveinst "$T4B")"
note "  C4b decoded rule (expect tp=1 fu=16 fa after-completion): $(rsum "$T4B")"

# --- C4c: project add-repeating, FIXED weekly/1 (flat --todo children) ---
note ""; note "### C4c — project add-repeating, FIXED weekly/1 ###"
warm
jd c4c project add-repeating \"U8-C4c\" --todo \"U8-C4c-k1\" --frequency weekly --interval 1 --dangerously-drive-gui
settle
T4C=$(jval c4c repeating.templateUuid); I4C=$(jval c4c repeating.instanceUuid); TOK4C=$(jval c4c undoToken)
assert_eq "C4c: exit 0" "0" "$(cat "$OUT/json/c4c.exit")"
assert_eq "C4c: template hasRule=1" "1" "$(rrule "$T4C")"
# FIXED-schedule project add-repeating: future cursor, no immediate instance (as C4a)
assert_eq "C4c: no immediate instance for a future-dated fixed occurrence (instanceUuid null)" "" "$I4C"
assert_eq "C4c: zero live instances on create (future fixed cursor)" "0" "$(liveinst "$T4C")"
assert_ne "C4c: template carries a future cursor (next set)" "NULL" "$(rnext "$T4C")"
note "  C4c decoded rule: $(rsum "$T4C")"
note "  C4c template subtree (child carried):"; kids "$T4C"
jd c4c-undo undo --txn "$TOK4C"
assert_eq "C4c: undo exit 0" "0" "$(cat "$OUT/json/c4c-undo.exit")"
assert_eq "C4c: undo trashed template" "1" "$(rtrash "$T4C")"

# --- C4d: project add-repeating, AFTER-COMPLETION weekly/1 ---
note ""; note "### C4d — project add-repeating, AFTER-COMPLETION weekly/1 ###"
warm
jd c4d project add-repeating \"U8-C4d\" --todo \"U8-C4d-k1\" --frequency weekly --interval 1 --after-completion --dangerously-drive-gui
settle
T4D=$(jval c4d repeating.templateUuid)
assert_eq "C4d: exit 0" "0" "$(cat "$OUT/json/c4d.exit")"
assert_eq "C4d: exactly ONE live instance on create" "1" "$(liveinst "$T4D")"
note "  C4d decoded rule (expect fa after-completion): $(rsum "$T4D")"

# =====================================================================
# WORKLIST C6 — symmetric umd-undo smoke (--preserve-modified)
# =====================================================================
note ""; note "################################################################"
note "# C6 — --preserve-modified make-repeating then undo (symmetric umd smoke)"
note "################################################################"
G todo add \"U8-C6\" --notes \"c6-body\" >/dev/null 2>&1; sleep 1
X6=$(uidt "U8-C6"); UMD0=$(rumd "$X6"); CRE6=$(rcre "$X6"); note "  seed X=$X6 umd0=$UMD0"
warm
jd c6 todo make-repeating "$X6" --frequency weekly --interval 1 --preserve-modified --dangerously-drive-gui
settle
UMD1=$(rumd "$X6"); TOK6=$(jval c6 undoToken)
note "  after make-repeating --preserve-modified: X trashed=$(rtrash "$X6") umd1=$UMD1 (umd0=$UMD0)"
PREMOD=$(lab_ssh "$IP" "grep -l preModDates ~/.local/state/things-api/audit/*.jsonl 2>/dev/null | head -1" </dev/null || true)
note "  audit files carrying preModDates: ${PREMOD:-NONE}"
jd c6-undo undo --txn "$TOK6"
UMD2=$(rumd "$X6")
note "  after undo: X trashed=$(rtrash "$X6") umd2=$UMD2  (umd0=$UMD0 umd1=$UMD1)"
assert_eq "C6: X restored live by undo" "0" "$(rtrash "$X6")"
assert_eq "C6: X creationDate intact" "$CRE6" "$(rcre "$X6")"
if [ "$UMD2" = "$UMD0" ]; then
  ok "C6: symmetric umd-restore WORKS (umd2==umd0)"
else
  note "  [FINDING] C6: umd NOT restored to pre-write (umd2=$UMD2 != umd0=$UMD0) — --preserve-modified appears not threaded through the promote compound (legOptions omits it; the summary record carries no preModDates). Captured for up-next, not a make-repeating contract regression."
fi

# =====================================================================
# WORKLIST C5 — failure rollback (LAST: revokes Accessibility)
# =====================================================================
note ""; note "################################################################"
note "# C5 — failure rollback: break the promote precondition mid-compound"
note "################################################################"
G todo add \"U8-C5\" --notes \"c5-body\" >/dev/null 2>&1; sleep 1
X5=$(uidt "U8-C5"); CRE5=$(rcre "$X5"); NOT5=$(rnotes "$X5"); note "  seed X=$X5"
note "  revoking Accessibility (tccutil reset) to break the promote leg…"
lab_ssh "$IP" 'tccutil reset Accessibility >/dev/null 2>&1; sudo tccutil reset Accessibility >/dev/null 2>&1 || true' </dev/null
note "  Accessibility auth_value now: $(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT COALESCE(MAX(auth_value),0) FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)"
note "  AX probe post-revoke: $(lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' 2>&1 | head -c 60' </dev/null)"
snap c5-pre; warm
jd c5 todo make-repeating "$X5" --frequency weekly --interval 1 --dangerously-drive-gui
settle; snap c5-post
note "  --- C5 delta ---"; diff_c c5-pre c5-post "U8-C5"
C5EXIT=$(cat "$OUT/json/c5.exit")
assert_ne "C5: compound did NOT succeed (exit != 0)" "0" "$C5EXIT"
assert_eq "C5: X rolled OUT of the Trash (trashed=0)" "0" "$(rtrash "$X5")"
assert_eq "C5: X content intact after rollback" "$NOT5" "$(rnotes "$X5")"
assert_eq "C5: X creationDate intact after rollback" "$CRE5" "$(rcre "$X5")"
assert_eq "C5: X still a plain to-do (no rule)" "0" "$(rrule "$X5")"
note "  C5 error message (honest, names the leftover clone): $(jerr c5 message | head -c 300)"
CLONE5=$(gq "SELECT COUNT(*) FROM TMTask WHERE title='U8-C5' AND uuid!='$X5' AND type=0")
note "  C5 leftover clone rows (design leaves the un-promoted clone; error says 'trash the clone and retry'): $CLONE5"

# =====================================================================
note ""; note "################################################################"
note "# SUMMARY"
note "################################################################"
note "  PASS=$PASS  FAIL=$FAIL"
env_line
note "DONE. report: $REPORT   snapshots: $OUT/snaps/   json: $OUT/json/"
