#!/bin/bash
# CLONE — evidence for the ratified "promote-via-clone" repeating direction.
# THREE worklists, ONE disposable clone of things-lab-golden-v2 (Things 3.22.12):
#   A  clone-fidelity matrix — which source fields reproduce onto a fresh item via
#      OFFICIAL write surfaces (json import / URL / AppleScript / existing CLI).
#      Verdict per field: CLONABLE / CLONABLE-WITH-CAVEAT / UNCLONABLE.
#   B  promote-fate determinism on MINTED (backdated) clone-shaped rows — confirm the
#      RSIM source-fate laws (RSIM-T deadline preserve; RSIM-R open-children delete;
#      RSIM-U all-terminal preserve; bare-todo delete) hold on rows WE minted with
#      backdated creationDate, and that the shipped template-uuid discovery binds.
#   C  trash-a-repeating-template semantics — mint fixed AND after-completion templates
#      (to-do AND project); trash the TEMPLATE via each official surface, observe the
#      rule/instance/series; restore; separately trash only the INSTANCE.
#
# METHOD mirrors research-rsim-r.sh. golden-v2 already carries L3-accessibility
# (auth_value=2, baked + reboot-verified) so there is NO VNC grant step — the ui
# vector (make-repeating / native promote) drives via System Events over SSH.
# Airgap + pin clock 2026-07-05 12:00. Ship the PRODUCTION e2e bundle; drive through
# the shipped CLI. Each case snapshots the guest Things DB (read-only, WAL-consistent)
# into host JSON; a host differ + a two-row fidelity comparator report the delta.
# make-repeating is a ui-vector op -> --dangerously-drive-gui. Fixtures fully synthetic.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="clone-lab"
GOLDEN="things-lab-golden-v2"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[clone] $*" | tee -a "$REPORT"; }
cleanup() { echo "[clone] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---------------- preflight ----------------
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB (golden=$GOLDEN)"
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

# ---------------- clone + boot (no VNC — golden-v2 has AX baked) ----------------
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[clone] /'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# verify the baked Accessibility grant survived the clone (ui vector needs it)
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

# subtree dumper (kids <projectUuid>)
lab_ssh "$IP" 'cat > /tmp/kids.py' <<'EOF'
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
print("PROJECT %s  %s  type=%s start=%s status=%s trashed=%s %s"%(p, row[0][0] if row else "MISSING", "?" , row[0][2] if row else "?", row[0][3] if row else "?", row[0][4] if row else "?", sh(p) if row else ""))
for hu,ht,hst,htr in q("SELECT uuid,title,status,trashed FROM TMTask WHERE type=2 AND project=? ORDER BY \"index\"",p):
    print("  HEADING %s '%s' status=%s trashed=%s [%s]"%(hu,ht,hst,htr,sh(hu)))
    for u,t,ty,stt,hd,pj,tr,sd in q("SELECT uuid,title,type,status,heading,project,trashed,stopDate FROM TMTask WHERE heading=? ORDER BY \"index\"",hu):
        print("    TODO(headed) %s '%s' type=%s status=%s trashed=%s chk=%d stop=%s [%s]"%(u,t,ty,stt,tr,cc(u),sd,sh(u)))
for u,t,ty,stt,hd,pj,tr,sd in q("SELECT uuid,title,type,status,heading,project,trashed,stopDate FROM TMTask WHERE project=? AND type=0 ORDER BY \"index\"",p):
    print("  TODO(direct) %s '%s' type=%s status=%s head=%s trashed=%s chk=%d stop=%s [%s]"%(u,t,ty,stt,(str(hd)[:8] if hd else None),tr,cc(u),sd,sh(u)))
EOF
kids() { lab_ssh "$IP" "python3 /tmp/kids.py $1" </dev/null | tee -a "$REPORT"; }

# ---------------- two-row FIDELITY comparator (worklist A) ----------------
lab_ssh "$IP" 'cat > /tmp/fidcmp.py' <<'EOF'
import sys, sqlite3, glob, plistlib, datetime
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
src,clone=sys.argv[1],sys.argv[2]
CONTENT=["title","type","status","trashed","start","startDate","startBucket",
         "reminderTime","deadline","t2_deadlineOffset","notes"]
STRUCT=["area","project","heading"]
EXPECTED=["uuid","\"index\"","todayIndex","userModificationDate"]
SHOWN=["creationDate","stopDate"]
DATEPK={"startDate","deadline"}
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
def cocoa(v):
    try: v=float(v)
    except: return v
    return datetime.datetime.utcfromtimestamp(v+978307200).strftime("%Y-%m-%dT%H:%M:%S")
def title_of(u):
    if u is None: return None
    r=c.execute("SELECT title FROM TMTask WHERE uuid=?",(u,)).fetchone()
    if r: return "task:"+r[0]
    r=c.execute("SELECT title FROM TMArea WHERE uuid=?",(u,)).fetchone()
    if r: return "area:"+r[0]
    return "?:"+str(u)[:8]
def rulesig(v):
    if v is None: return "NULL"
    try:
        pl=plistlib.loads(v); return "rule{%s}"%(",".join("%s=%s"%(k,(pl[k] if not isinstance(pl[k],(bytes,bytearray)) else "<blob>")) for k in sorted(pl)))
    except: return "rule(%dB unparsed)"%len(v)
allcols=CONTENT+STRUCT+SHOWN+["rt1_recurrenceRule","rt1_repeatingTemplate","rt1_instanceCreationCount"]
def row(u):
    q=",".join(('"index"' if x=="index" else x) for x in ["uuid"]+allcols)
    r=c.execute("SELECT %s FROM TMTask WHERE uuid=?"%q,(u,)).fetchone()
    if not r: return None
    return dict(zip(["uuid"]+allcols,r))
a=row(src); b=row(clone)
if not a: print("  SRC %s MISSING"%src); sys.exit()
if not b: print("  CLONE %s MISSING"%clone); sys.exit()
def fmt(col,v):
    if col in DATEPK: return dpk(v)
    if col in ("creationDate","stopDate"): return cocoa(v) if v is not None else None
    if col in STRUCT: return title_of(v)
    if col=="rt1_recurrenceRule": return rulesig(v)
    if col=="rt1_repeatingTemplate": return (title_of(v) if v else None)
    return v
diffs=[]; matches=[]
for col in CONTENT+["rt1_recurrenceRule","rt1_repeatingTemplate","rt1_instanceCreationCount"]:
    av,bv=fmt(col,a[col]),fmt(col,b[col])
    (diffs if av!=bv else matches).append((col,av,bv,"CONTENT"))
for col in STRUCT:
    av,bv=fmt(col,a[col]),fmt(col,b[col])
    (diffs if av!=bv else matches).append((col,av,bv,"STRUCT-title"))
print("  == FIDELITY  src=%s  clone=%s =="%(src[:8],clone[:8]))
if diffs:
    for col,av,bv,cls in diffs: print("  DIFF [%s] %s: %r -> %r"%(cls,col,av,bv))
else:
    print("  DIFF: (none — all content+structural fields byte/structure-identical)")
print("  content/struct MATCH cols: %s"%",".join(col for col,_,_,_ in matches))
for col in SHOWN:
    print("  SHOWN %s: src=%s clone=%s"%(col,fmt(col,a[col]),fmt(col,b[col])))
# tags
def tags(u):
    return sorted(t for (t,) in c.execute("SELECT tg.title FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid=tt.tags WHERE tt.tasks=?",(u,)))
ta,tb=tags(src),tags(clone)
print("  TAGS src=%s clone=%s %s"%(ta,tb,"MATCH" if ta==tb else "DIFF"))
# checklist (ordered title,status)
def chk(u):
    try: return [(ti,st) for (ti,st) in c.execute('SELECT title,status FROM TMChecklistItem WHERE task=? ORDER BY "index"',(u,))]
    except: return "ERR"
ca,cb=chk(src),chk(clone)
print("  CHECKLIST src=%s clone=%s %s"%(ca,cb,"MATCH" if ca==cb else "DIFF"))
EOF
fidcmp() { lab_ssh "$IP" "python3 /tmp/fidcmp.py $1 $2" </dev/null | tee -a "$REPORT"; }

# ---------------- host-side snapshot differ (before/after) ----------------
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
  { grep -m1 '"ok"' "$OUT/drive-$label.log" || grep -m1 '"error"\|error:\|"blocked"\|refus' "$OUT/drive-$label.log" || echo '(no ok/error line — see drive log)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive-$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}
G config set ui-enabled true >/dev/null 2>&1

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
env_line() { note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"; }

# uid resolvers
uidt()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
uidp()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
tmplt() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
tmplp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
instt() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NOT NULL AND trashed=0 LIMIT 1"; }
instp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_repeatingTemplate IS NOT NULL AND trashed=0 LIMIT 1"; }

# fate <uuid> — after conversion, DELETED vs PRESERVED-as-instance
fate() {
  local u="$1" row
  row=$(gq "SELECT (SELECT COUNT(*) FROM TMTask WHERE uuid='$u')||'|tmpl='||COALESCE((SELECT rt1_repeatingTemplate FROM TMTask WHERE uuid='$u'),'NULL')||'|trashed='||COALESCE((SELECT trashed FROM TMTask WHERE uuid='$u'),'-')||'|hasRule='||COALESCE((SELECT (rt1_recurrenceRule IS NOT NULL) FROM TMTask WHERE uuid='$u'),'-')")
  note "    >>> SOURCE-FATE src=$u  [exists|tmpl|trashed|hasRule] = $row  (exists=1&tmpl=<uuid> => PRESERVED-as-instance ; exists=0 => DELETED)"
}
# capture the template uuid the CLI returned in its JSON envelope
returned_tmpl() { python3 -c "import json,sys,re
try:
  txt=open(sys.argv[1]).read()
  m=re.search(r'\{.*\}', txt, re.S)
  d=json.loads(m.group(0)) if m else {}
except Exception as e:
  print('parse-err:%s'%e); sys.exit()
def find(o):
  out=[]
  if isinstance(o,dict):
    for k,v in o.items():
      if 'template' in k.lower() and isinstance(v,str): out.append('%s=%s'%(k,v))
      out+=find(v)
  elif isinstance(o,list):
    for v in o: out+=find(v)
  return out
print(' '.join(find(d)) or '(no template field in envelope)')" "$OUT/drive-$1.log"; }

env_line

# =====================================================================
# WORKLIST A — clone-fidelity matrix
# =====================================================================
note ""; note "################################################################"
note "# WORKLIST A — clone-fidelity matrix (official write surfaces only)"
note "################################################################"

# seed shared tags + area (referenced by clone/source pairs)
lab_ssh "$IP" "osascript -e 'tell application \"Things3\"' -e 'make new tag with properties {name:\"cltag1\"}' -e 'make new tag with properties {name:\"cltag2\"}' -e 'make new area with properties {name:\"CL-Area\"}' -e 'end tell'" </dev/null 2>&1 | sed 's/^/  [seed] /' | tee -a "$REPORT"

# --- A1: to-do content cluster (title, notes, tags, deadline, when=today, reminder) ---
note ""; note "### A1 — to-do content: title/notes/tags/deadline/when=today/reminder ###"
drive A1src  todo add \"CL-A1src\"   --notes \"clone-notes-body\" --tags \"cltag1,cltag2\" --deadline 2026-07-20 --when today --reminder 09:30 --json
drive A1clone todo add \"CL-A1clone\" --notes \"clone-notes-body\" --tags \"cltag1,cltag2\" --deadline 2026-07-20 --when today --reminder 09:30 --json
A1S=$(uidt "CL-A1src"); A1C=$(uidt "CL-A1clone"); note "  src=$A1S clone=$A1C"
fidcmp "$A1S" "$A1C"

# --- A1b: when=evening ---
note ""; note "### A1b — when=evening (startBucket=1) ###"
drive A1bsrc  todo add \"CL-A1bsrc\"   --when evening --json
drive A1bclone todo add \"CL-A1bclone\" --when evening --json
A1bS=$(uidt "CL-A1bsrc"); A1bC=$(uidt "CL-A1bclone"); fidcmp "$A1bS" "$A1bC"

# --- A1c: when=someday ---
note ""; note "### A1c — when=someday ###"
drive A1csrc  todo add \"CL-A1csrc\"   --when someday --json
drive A1cclone todo add \"CL-A1cclone\" --when someday --json
A1cS=$(uidt "CL-A1csrc"); A1cC=$(uidt "CL-A1cclone"); fidcmp "$A1cS" "$A1cC"

# --- A2: checklist WITH a completed item ---
note ""; note "### A2 — checklist items + a completed one (born-open vs post-check) ###"
drive A2src  todo add \"CL-A2src\"   --checklist-item a --checklist-item b --checklist-item c --json
A2S=$(uidt "CL-A2src")
drive A2srcchk todo checklist "$A2S" --check b --json
drive A2clone todo add \"CL-A2clone\" --checklist-item a --checklist-item b --checklist-item c --json
A2C=$(uidt "CL-A2clone")
note "  -- A2 fidelity BEFORE best-effort follow-up check (clone born all-open) --"; fidcmp "$A2S" "$A2C"
drive A2clonechk todo checklist "$A2C" --check b --json
note "  -- A2 fidelity AFTER best-effort follow-up 'checklist --check b' --"; fidcmp "$A2S" "$A2C"

# --- A3: backdated creation date (--created-at) ---
note ""; note "### A3 — backdated creationDate via --created-at ###"
drive A3src todo add \"CL-A3src\" --json
A3S=$(uidt "CL-A3src")
SRCCRE=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$A3S'")
SRCISO=$(python3 -c "import datetime,sys;print(datetime.datetime.utcfromtimestamp(float(sys.argv[1])+978307200).strftime('%Y-%m-%dT%H:%M'))" "$SRCCRE")
note "  src creationDate epoch=$SRCCRE -> iso(min-res)=$SRCISO"
drive A3clone todo add \"CL-A3clone\" --created-at "$SRCISO" --json
A3C=$(uidt "CL-A3clone")
fidcmp "$A3S" "$A3C"
note "  A3 raw creationDate: src=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$A3S'") clone=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$A3C'")  (match to the minute = CLONABLE at ISO resolution)"

# --- A4: project rich (headings, headed child, direct child, area, notes, deadline) ---
note ""; note "### A4 — project: headings + headed child + direct child + area + notes/deadline ###"
A4JSON_SRC='[{"type":"project","attributes":{"title":"CL-A4src","area":"CL-Area","notes":"proj-notes","deadline":"2026-07-25","items":[{"type":"heading","attributes":{"title":"CL-H1"}},{"type":"to-do","attributes":{"title":"CL-A4-headed","heading":"CL-H1"}},{"type":"to-do","attributes":{"title":"CL-A4-direct"}}]}}]'
A4JSON_CLN='[{"type":"project","attributes":{"title":"CL-A4clone","area":"CL-Area","notes":"proj-notes","deadline":"2026-07-25","items":[{"type":"heading","attributes":{"title":"CL-H1"}},{"type":"to-do","attributes":{"title":"CL-A4-headed","heading":"CL-H1"}},{"type":"to-do","attributes":{"title":"CL-A4-direct"}}]}}]'
enc() { python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$1"; }
lab_ssh "$IP" "open 'things:///json?data=$(enc "$A4JSON_SRC")'; sleep 3" </dev/null
lab_ssh "$IP" "open 'things:///json?data=$(enc "$A4JSON_CLN")'; sleep 3" </dev/null
A4S=$(uidp "CL-A4src"); A4C=$(uidp "CL-A4clone"); note "  src=$A4S clone=$A4C"
fidcmp "$A4S" "$A4C"
note "  -- A4 src subtree --"; kids "$A4S"
note "  -- A4 clone subtree --"; kids "$A4C"

# --- A5: project with LOGGED children (--completed-at) + a canceled child ---
note ""; note "### A5 — project: open + completed(--completed-at) + canceled children ###"
# source
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"CL-A5src","items":[{"type":"to-do","attributes":{"title":"CL-A5-open"}},{"type":"to-do","attributes":{"title":"CL-A5-done"}},{"type":"to-do","attributes":{"title":"CL-A5-cancel"}}]}}]')'; sleep 3" </dev/null
A5S=$(uidp "CL-A5src")
A5SDONE=$(gq "SELECT uuid FROM TMTask WHERE title='CL-A5-done' AND project='$A5S' LIMIT 1")
A5SCAN=$(gq "SELECT uuid FROM TMTask WHERE title='CL-A5-cancel' AND project='$A5S' LIMIT 1")
drive A5src-done   todo complete "$A5SDONE" --completed-at 2026-07-03T14:00 --json
drive A5src-cancel todo cancel   "$A5SCAN"  --completed-at 2026-07-04T14:00 --json
# clone — reproduce the same terminal states via the same multi-leg path
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"CL-A5clone","items":[{"type":"to-do","attributes":{"title":"CL-A5c-open"}},{"type":"to-do","attributes":{"title":"CL-A5c-done"}},{"type":"to-do","attributes":{"title":"CL-A5c-cancel"}}]}}]')'; sleep 3" </dev/null
A5C=$(uidp "CL-A5clone")
A5CDONE=$(gq "SELECT uuid FROM TMTask WHERE title='CL-A5c-done' AND project='$A5C' LIMIT 1")
A5CCAN=$(gq "SELECT uuid FROM TMTask WHERE title='CL-A5c-cancel' AND project='$A5C' LIMIT 1")
drive A5clone-done   todo complete "$A5CDONE" --completed-at 2026-07-03T14:00 --json
drive A5clone-cancel todo cancel   "$A5CCAN"  --completed-at 2026-07-04T14:00 --json
note "  -- A5 src subtree --"; kids "$A5S"
note "  -- A5 clone subtree --"; kids "$A5C"
note "  -- A5 per-child fidelity (done: status/stopDate) --"; fidcmp "$A5SDONE" "$A5CDONE"
note "  -- A5 per-child fidelity (cancel: status/stopDate) --"; fidcmp "$A5SCAN" "$A5CCAN"

# --- A6: special — project containing a LIVE nested repeating to-do (expected UNCLONABLE) ---
note ""; note "### A6 — SPECIAL: project with a nested repeating to-do template (expected UNCLONABLE faithfully) ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"CL-A6src","items":[{"type":"to-do","attributes":{"title":"CL-A6-nested"}}]}}]')'; sleep 3" </dev/null
A6S=$(uidp "CL-A6src")
A6NEST=$(gq "SELECT uuid FROM TMTask WHERE title='CL-A6-nested' AND project='$A6S' LIMIT 1")
warm
drive A6-mkrep todo make-repeating "$A6NEST" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle
note "  -- A6 src subtree (nested to-do should now be/relink-as a template) --"; kids "$A6S"
note "  A6 nested-row recurrence rule bytes present?"
gq "SELECT uuid,title,type,(rt1_recurrenceRule IS NOT NULL) AS hasRule,rt1_repeatingTemplate FROM TMTask WHERE title LIKE 'CL-A6-nested%'" | sed 's/^/    /' | tee -a "$REPORT"
note "  best-effort clone via json import (cannot carry rt1_recurrenceRule — nested child born PLAIN):"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"CL-A6clone","items":[{"type":"to-do","attributes":{"title":"CL-A6c-nested"}}]}}]')'; sleep 3" </dev/null
A6C=$(uidp "CL-A6clone")
note "  -- A6 clone subtree (best-effort: nested child is a PLAIN to-do, recurrence LOST) --"; kids "$A6C"

# --- A7: special — logged source item (standalone completed/canceled) born-logged ---
note ""; note "### A7 — SPECIAL: logged source item, born-logged via add --completed-at ###"
drive A7src   todo add \"CL-A7src\"   --completed-at 2026-07-02T10:00 --json
drive A7clone todo add \"CL-A7clone\" --completed-at 2026-07-02T10:00 --json
A7S=$(gq "SELECT uuid FROM TMTask WHERE title='CL-A7src' LIMIT 1"); A7C=$(gq "SELECT uuid FROM TMTask WHERE title='CL-A7clone' LIMIT 1")
fidcmp "$A7S" "$A7C"

# --- A8: special — source in the trash ---
note ""; note "### A8 — SPECIAL: source in the trash (trashed=1 reproduction) ###"
drive A8src todo add \"CL-A8src\" --notes trashed-src --json
A8S=$(uidt "CL-A8src")
drive A8src-del todo delete "$A8S" --json
drive A8clone todo add \"CL-A8clone\" --notes trashed-src --json
A8C=$(uidt "CL-A8clone")
drive A8clone-del todo delete "$A8C" --json
A8Sx=$(gq "SELECT uuid FROM TMTask WHERE title='CL-A8src' LIMIT 1"); A8Cx=$(gq "SELECT uuid FROM TMTask WHERE title='CL-A8clone' LIMIT 1")
fidcmp "$A8Sx" "$A8Cx"

# =====================================================================
# WORKLIST B — promote-fate determinism on MINTED (backdated) clone rows
# =====================================================================
note ""; note "################################################################"
note "# WORKLIST B — promote fate on minted (backdated) clone-shaped rows"
note "################################################################"
BACKDATE=2026-06-15T09:00   # a backdated creationDate, mimicking clone(X) faithfulness

# B1 — bare backdated to-do -> expect source DELETE
note ""; note "### B1 — bare backdated to-do: expect source DELETE (RSIM1) ###"
drive B1seed todo add \"CL-B1\" --created-at "$BACKDATE" --json
B1=$(uidt "CL-B1"); note "  seed CL-B1 uuid=$B1 creationDate=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$B1'")"
warm; snap b1-pre
drive B1 todo make-repeating "$B1" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap b1-post
note "  --- B1 delta ---"; diff_c b1-pre b1-post "CL-B1"
fate "$B1"; note "  returned-template: $(returned_tmpl B1)  actual-template-row: $(tmplt CL-B1)"

# B2 — deadline-carrying backdated to-do -> expect PRESERVE (RSIM-T)
note ""; note "### B2 — deadline-carrying backdated to-do: expect source PRESERVE (RSIM-T) ###"
drive B2seed todo add \"CL-B2\" --deadline 2026-07-30 --created-at "$BACKDATE" --json
B2=$(uidt "CL-B2"); note "  seed CL-B2 uuid=$B2 deadline=$(gq "SELECT deadline FROM TMTask WHERE uuid='$B2'")"
warm; snap b2-pre
drive B2 todo make-repeating "$B2" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap b2-post
note "  --- B2 delta ---"; diff_c b2-pre b2-post "CL-B2"
fate "$B2"; note "  returned-template: $(returned_tmpl B2)  actual-template-row: $(tmplt CL-B2)"

# B3 — project, plain OPEN children -> expect source DELETE (RSIM-R)
note ""; note "### B3 — project w/ plain OPEN children: expect source DELETE (RSIM-R) ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"CL-B3","items":[{"type":"to-do","attributes":{"title":"CL-B3-k1"}},{"type":"to-do","attributes":{"title":"CL-B3-k2"}}]}}]')'; sleep 3" </dev/null
B3=$(uidp "CL-B3")
drive B3backdate project update "$B3" --created-at "$BACKDATE" --json
note "  seed CL-B3 uuid=$B3 creationDate=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$B3'")"
warm; snap b3-pre
drive B3 project make-repeating "$B3" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap b3-post
note "  --- B3 delta ---"; diff_c b3-pre b3-post "CL-B3"
fate "$B3"; note "  returned-template: $(returned_tmpl B3)  actual-template-row: $(tmplp CL-B3)"

# B4 — project, all-TERMINAL children (completed+canceled) -> expect source PRESERVE (RSIM-U)
note ""; note "### B4 — project w/ all-terminal children: expect source PRESERVE (RSIM-U) ###"
lab_ssh "$IP" "open 'things:///json?data=$(enc '[{"type":"project","attributes":{"title":"CL-B4","items":[{"type":"to-do","attributes":{"title":"CL-B4-done"}},{"type":"to-do","attributes":{"title":"CL-B4-cancel"}}]}}]')'; sleep 3" </dev/null
B4=$(uidp "CL-B4")
B4D=$(gq "SELECT uuid FROM TMTask WHERE title='CL-B4-done' AND project='$B4' LIMIT 1")
B4X=$(gq "SELECT uuid FROM TMTask WHERE title='CL-B4-cancel' AND project='$B4' LIMIT 1")
drive B4done   todo complete "$B4D" --completed-at 2026-07-01T10:00 --json
drive B4cancel todo cancel   "$B4X" --completed-at 2026-07-01T11:00 --json
drive B4backdate project update "$B4" --created-at "$BACKDATE" --json
note "  seed CL-B4 uuid=$B4 (children terminal)"; kids "$B4"
warm; snap b4-pre
drive B4 project make-repeating "$B4" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap b4-post
note "  --- B4 delta ---"; diff_c b4-pre b4-post "CL-B4"
fate "$B4"; note "  returned-template: $(returned_tmpl B4)  actual-template-row: $(tmplp CL-B4)"

# =====================================================================
# WORKLIST C — trash a repeating TEMPLATE (fixed + after-completion; to-do + project)
# =====================================================================
note ""; note "################################################################"
note "# WORKLIST C — trash-a-repeating-template semantics"
note "################################################################"

# helper: mint a template of a given kind/mode, then run the trash/restore/instance probes.
# args: label kind(todo|project) mode(fixed|ac) baseTitle
mint_template() {
  local kind="$1" mode="$2" title="$3" extra=""
  [ "$mode" = "ac" ] && extra="--after-completion"
  if [ "$kind" = "todo" ]; then
    drive "$title-seed" todo add \""$title"\" --json
    local u; u=$(uidt "$title")
    warm
    drive "$title-mk" todo make-repeating "$u" --frequency weekly --interval 1 $extra --dangerously-drive-gui --json
    settle
  else
    drive "$title-seed" project add \""$title"\" --todo \""$title-k1"\" --json
    local u; u=$(uidp "$title")
    warm
    drive "$title-mk" project make-repeating "$u" --frequency weekly --interval 1 $extra --dangerously-drive-gui --json
    settle
  fi
}

# probe a minted template: identify template + instance, trash the TEMPLATE via CLI(=AS delete),
# observe rule/instance/series, then restore, then (fresh mint) trash only the instance.
probe_template_trash() {
  local kind="$1" mode="$2" title="$3"
  local TPL INST
  if [ "$kind" = "todo" ]; then TPL=$(tmplt "$title"); INST=$(instt "$title"); else TPL=$(tmplp "$title"); INST=$(instp "$title"); fi
  note "  [$title] kind=$kind mode=$mode  template=$TPL  instance=$INST"
  note "  template row:"; gq "SELECT uuid,title,type,status,trashed,(rt1_recurrenceRule IS NOT NULL) hasRule,rt1_instanceCreationCount ic,rt1_nextInstanceStartDate nxt FROM TMTask WHERE uuid='$TPL'" | sed 's/^/    /' | tee -a "$REPORT"
  note "  instance row:"; gq "SELECT uuid,title,type,status,trashed,rt1_repeatingTemplate FROM TMTask WHERE uuid='$INST'" | sed 's/^/    /' | tee -a "$REPORT"
  snap "$title-pre"
  # --- CLI trash of the TEMPLATE (routes to AppleScript delete; the CLI trash + AS-delete surfaces are the same op) ---
  if [ "$kind" = "todo" ]; then drive "$title-trashTPL" todo delete "$TPL" --json; else drive "$title-trashTPL" project delete "$TPL" --json; fi
  settle; snap "$title-postTrash"
  note "  --- delta: trash TEMPLATE $TPL ---"; diff_c "$title-pre" "$title-postTrash" "$title"
  note "  template after trash: $(gq "SELECT 'exists='||COUNT(*)||' trashed='||COALESCE(MAX(trashed),'-')||' hasRule='||COALESCE(MAX(rt1_recurrenceRule IS NOT NULL),'-') FROM TMTask WHERE uuid='$TPL'")"
  note "  instance after trash: $(gq "SELECT 'exists='||COUNT(*)||' trashed='||COALESCE(MAX(trashed),'-')||' tmpl='||COALESCE(MAX(rt1_repeatingTemplate),'NULL') FROM TMTask WHERE uuid='$INST'")"
  # --- RAW AppleScript delete on a template (independent surface check) is the same primitive; note it ---
  # --- restore the trashed template ---
  if [ "$kind" = "todo" ]; then drive "$title-restoreTPL" todo restore "$TPL" --json; else drive "$title-restoreTPL" project restore "$TPL" --json; fi
  settle; snap "$title-postRestore"
  note "  --- delta: restore TEMPLATE $TPL ---"; diff_c "$title-postTrash" "$title-postRestore" "$title"
  note "  template after restore: $(gq "SELECT 'exists='||COUNT(*)||' trashed='||COALESCE(MAX(trashed),'-')||' hasRule='||COALESCE(MAX(rt1_recurrenceRule IS NOT NULL),'-')||' ic='||COALESCE(MAX(rt1_instanceCreationCount),'-') FROM TMTask WHERE uuid='$TPL'")"
  note "  instance after restore: $(gq "SELECT 'exists='||COUNT(*)||' trashed='||COALESCE(MAX(trashed),'-') FROM TMTask WHERE uuid='$INST'")"
}

# C-todo-fixed
note ""; note "### C1 — TO-DO / FIXED template ###"
mint_template todo fixed "CL-CtdF"
probe_template_trash todo fixed "CL-CtdF"

# C-todo-ac
note ""; note "### C2 — TO-DO / AFTER-COMPLETION template ###"
mint_template todo ac "CL-CtdA"
probe_template_trash todo ac "CL-CtdA"

# C-project-fixed
note ""; note "### C3 — PROJECT / FIXED template ###"
mint_template project fixed "CL-CpjF"
probe_template_trash project fixed "CL-CpjF"

# C-project-ac
note ""; note "### C4 — PROJECT / AFTER-COMPLETION template ###"
mint_template project ac "CL-CpjA"
probe_template_trash project ac "CL-CpjA"

# C5 — trash only the INSTANCE (use a fresh fixed to-do template)
note ""; note "### C5 — trash only the INSTANCE (fresh fixed to-do template) ###"
mint_template todo fixed "CL-CInst"
CI_TPL=$(tmplt "CL-CInst"); CI_INST=$(instt "CL-CInst")
note "  template=$CI_TPL instance=$CI_INST"
snap c5-pre
drive C5-trashInst todo delete "$CI_INST" --json
settle; snap c5-post
note "  --- delta: trash INSTANCE $CI_INST ---"; diff_c c5-pre c5-post "CL-CInst"
note "  template after instance-trash: $(gq "SELECT 'exists='||COUNT(*)||' trashed='||COALESCE(MAX(trashed),'-')||' ic='||COALESCE(MAX(rt1_instanceCreationCount),'-')||' hasRule='||COALESCE(MAX(rt1_recurrenceRule IS NOT NULL),'-') FROM TMTask WHERE uuid='$CI_TPL'")"
note "  instance after instance-trash: $(gq "SELECT 'exists='||COUNT(*)||' trashed='||COALESCE(MAX(trashed),'-') FROM TMTask WHERE uuid='$CI_INST'")"
note "  Show-Latest live instances for this template: $(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$CI_TPL' AND trashed=0")"

note ""; env_line
note "DONE. report: $REPORT   snapshots: $OUT/snaps/"
