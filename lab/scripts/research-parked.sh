#!/bin/bash
# PARKED-PROBES campaign — probes, on the LIVE clone left up by
# research-parked-smoke.sh (reads lab/artifacts/parked-probes-lab/state.env).
#
# PHASE A (headless — Shortcuts/AppleScript/URL, no Accessibility):
#   P4  — completion/creation-date backdating, all three surfaces (RE-VALIDATION
#         of scf2/scf3 on tart 2.34 + the genuine new AppleScript `date "…"`
#         string-literal spelling not previously tried).
#   P3a — reminder-time SET formats (re-validate DEAD) + the reminderTime BIT-
#         LAYOUT verification for schema-atlas OQ1 (hour<<26 | minute<<20).
#   P2b — set-detail Parent on a TO-DO (re-validate DESTRUCTIVE DETACH).
#   P6  — sidebar-order remaining spellings (AS move / set index / Anytime AREA
#         uuids / Someday reorder / sdef private-command grep).
# PHASE B (Accessibility granted via AXVM1 rung-b VNC toggle; make-repeating is a
#   ui-vector op → --dangerously-drive-gui):
#   RSIM-T — to-do content preserve-trigger isolation (bare vs deadline vs notes
#            vs tag vs checklist; deadline the leading candidate from RSIM-R B3).
#   RSIM-U — project edge-state-child preserve isolation (open vs completed vs
#            canceled vs both; the RSIM-S RS2 counterexample).
#
# Same TMTask+TMTaskTag+TMChecklistItem snapshot/differ as research-rsim-r.sh.
# Fixtures fully synthetic (public repo). Golden untouched. Tears down on exit.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

OUT="lab/artifacts/parked-probes-lab"
REPORT="$OUT/report.txt"
[ -f "$OUT/state.env" ] || { echo "FATAL: no $OUT/state.env — run research-parked-smoke.sh first"; exit 1; }
source "$OUT/state.env"
mkdir -p "$OUT/snaps" "$OUT/vnc"
note() { echo "[parked] $*" | tee -a "$REPORT"; }
cleanup() { echo "[parked] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note ""; note "################## PARKED PROBES (live clone $VM @ $IP) ##################"

# ---------------- host toolchain (self-contained node for the differ) ----------------
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

# sanity: live VM still answers
lab_ssh "$IP" 'true' </dev/null || { note "FATAL: live VM $VM @ $IP not reachable"; exit 1; }

# ---------------- guest helpers ----------------
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# osascript runner (avoids nested-quote hell over ssh)
lab_ssh "$IP" 'cat > /tmp/asrun.sh && chmod +x /tmp/asrun.sh' <<'EOF'
#!/bin/bash
out=$(osascript -e "$1" 2>&1); code=$?
echo "$out"; echo "AS-EXIT=$code"
EOF
asrun() { lab_ssh "$IP" "/tmp/asrun.sh $(printf '%q' "$1")" </dev/null; }

# Shortcuts proxy runner (clears stale output — scf lesson)
lab_ssh "$IP" 'cat > /tmp/runproxy.sh && chmod +x /tmp/runproxy.sh' <<'EOF'
#!/bin/bash
# runproxy.sh <shortcut> <json-input>
rm -f /tmp/proxy-out.txt
printf '%s' "$2" > /tmp/proxy-in.json
shortcuts run "$1" --input-path /tmp/proxy-in.json --output-path /tmp/proxy-out.txt >/tmp/proxy-run.log 2>&1
echo "EXIT=$?"
cat /tmp/proxy-out.txt 2>/dev/null
EOF
runproxy() { lab_ssh "$IP" "/tmp/runproxy.sh $(printf '%q' "$1") $(printf '%q' "$2")" </dev/null; }

# rsnap.py — full TMTask/TMTaskTag/TMChecklistItem snapshot (RSIM-R verbatim)
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
    tasktags.append({"task":tk,"taskTitle":(tasks.get(tk) or {}).get("title"),"tag":tg,"tagName":tagname.get(tg)})
checklist={}
try:
    for cu,tk,ti,st,ix in c.execute('SELECT uuid,task,title,status,"index" FROM TMChecklistItem'):
        checklist[cu]={"task":tk,"taskTitle":(tasks.get(tk) or {}).get("title"),"title":ti,"status":st,"index":ix}
except Exception as e:
    checklist={"__error__":str(e)}
json.dump({"tasks":tasks,"tasktags":tasktags,"checklist":checklist,"areas":areas},sys.stdout,default=str)
EOF
snap() { lab_ssh "$IP" 'python3 /tmp/rsnap.py' </dev/null > "$OUT/snaps/$1.json"; }

# host differ (RSIM-R verbatim)
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
diff_c() { python3 "$OUT/diff_snaps.py" "$OUT/snaps/$1.json" "$OUT/snaps/$2.json" "${3:-}" | tee -a "$REPORT"; }

G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
drive() {
  local label="$1"; shift
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive-$label.log" 2>&1
  { grep -m1 '"ok"' "$OUT/drive-$label.log" || grep -m1 '"error"\|error:' "$OUT/drive-$label.log" || echo '(no ok/error line — see drive log)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive-$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 16; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
uidt()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
uidp()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
tmplp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
fate() {
  local u="$1"
  local row
  row=$(gq "SELECT (SELECT COUNT(*) FROM TMTask WHERE uuid='$u')||'|'||COALESCE((SELECT rt1_repeatingTemplate FROM TMTask WHERE uuid='$u'),'NULL')||'|start='||COALESCE((SELECT start FROM TMTask WHERE uuid='$u'),'-')||'|startDate='||COALESCE((SELECT startDate FROM TMTask WHERE uuid='$u'),'-')||'|hasRule='||COALESCE((SELECT (rt1_recurrenceRule IS NOT NULL) FROM TMTask WHERE uuid='$u'),'-')")
  note "    >>> SOURCE-FATE src=$u  [exists|tmpl|start|startDate|hasRule] = $row"
  note "        (exists=1 & tmpl=<uuid> => PRESERVED-as-instance ; exists=0 => DELETED)"
}
env_line() { note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) / tart $(tart --version) --"; }

# =====================================================================
# PHASE A — P-series (headless)
# =====================================================================
note ""; note "@@@@@@@@@@@@@@@@ PHASE A — P-series re-validation + residuals @@@@@@@@@@@@@@@@"

# ---- P4: completion/creation-date backdating ----
note ""; note "########## P4 — completion-date backdating (verify complete FIRST) ##########"
drive P4seed todo add \"P4-Comp\" --json
P4C=$(uidt "P4-Comp"); note "  seed P4-Comp uuid=$P4C"
note "  complete via AppleScript (set status ... to completed):"
asrun "tell application \"Things3\" to set status of to do id \"$P4C\" to completed" | sed 's/^/    [as-complete] /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 2' </dev/null
COMPST=$(gq "SELECT status||'|stopDate='||COALESCE(stopDate,'NULL') FROM TMTask WHERE uuid='$P4C'")
note "  VERIFY completed: status|stopDate = $COMPST  (need status=3 + stopDate non-null)"
case "$COMPST" in 3\|*) note "  ✓ fixture properly completed" ;; *) note "  ✗ WARN: fixture not completed (status!=3) — P4 completion-date arms may be invalid"; esac

note "  -- P4a Shortcuts set-detail Completion Date (expect DEAD/no-op) --"
for v in "2025-01-15" "1/15/2025" "January 15, 2025"; do
  BEFORE=$(gq "SELECT COALESCE(stopDate,'NULL') FROM TMTask WHERE uuid='$P4C'")
  runproxy "things-proxy-set-detail" "{\"id\":\"$P4C\",\"detail\":\"Completion Date\",\"value\":\"$v\"}" > "$OUT/p4a-$(echo "$v"|tr ' /' '__').log" 2>&1
  lab_ssh "$IP" 'sleep 1' </dev/null
  AFTER=$(gq "SELECT COALESCE(stopDate,'NULL') FROM TMTask WHERE uuid='$P4C'")
  note "    Shortcuts Completion='$v': stopDate $BEFORE -> $AFTER  $([ "$BEFORE" = "$AFTER" ] && echo NO-OP || echo CHANGED)"
done

note "  -- P4b AppleScript set completion date (TWO spellings) --"
B1=$(gq "SELECT COALESCE(stopDate,'NULL') FROM TMTask WHERE uuid='$P4C'")
asrun "tell application \"Things3\" to set completion date of to do id \"$P4C\" to ((current date) - (200 * days))" | sed 's/^/    [as-arith] /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 1' </dev/null
A1=$(gq "SELECT COALESCE(stopDate,'NULL') FROM TMTask WHERE uuid='$P4C'")
note "    AppleScript arith (current date - 200 days): stopDate $B1 -> $A1  $([ "$B1" = "$A1" ] && echo NO-OP || echo CHANGED)"
B2=$A1
asrun "tell application \"Things3\" to set completion date of to do id \"$P4C\" to date \"1/15/2025\"" | sed 's/^/    [as-datelit] /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 1' </dev/null
A2=$(gq "SELECT COALESCE(stopDate,'NULL') FROM TMTask WHERE uuid='$P4C'")
note "    AppleScript date \"1/15/2025\" (NEW spelling): stopDate $B2 -> $A2  $([ "$B2" = "$A2" ] && echo NO-OP || echo CHANGED)"

note "  -- P4c URL update?completion-date= (+auth token) (expect NO-OP) --"
B3=$(gq "SELECT COALESCE(stopDate,'NULL') FROM TMTask WHERE uuid='$P4C'")
lab_ssh "$IP" "open 'things:///update?id=$P4C&completion-date=2025-01-15&auth-token=$TOKEN'; sleep 3" </dev/null
A3=$(gq "SELECT COALESCE(stopDate,'NULL') FROM TMTask WHERE uuid='$P4C'")
note "    URL completion-date=2025-01-15: stopDate $B3 -> $A3  $([ "$B3" = "$A3" ] && echo NO-OP || echo CHANGED)"

note ""; note "########## P4 — creation-date backdating ##########"
drive P4rseed todo add \"P4-Crea\" --json
P4R=$(uidt "P4-Crea"); note "  seed P4-Crea uuid=$P4R"
note "  -- Shortcuts set-detail Creation Date (expect DEAD) --"
for v in "2024-06-01" "6/1/2024"; do
  BEFORE=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$P4R'")
  runproxy "things-proxy-set-detail" "{\"id\":\"$P4R\",\"detail\":\"Creation Date\",\"value\":\"$v\"}" >/dev/null 2>&1
  lab_ssh "$IP" 'sleep 1' </dev/null
  AFTER=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$P4R'")
  note "    Shortcuts Creation='$v': creationDate $BEFORE -> $AFTER  $([ "$BEFORE" = "$AFTER" ] && echo NO-OP || echo CHANGED)"
done
note "  -- AppleScript set creation date (arith + date literal) --"
CB=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$P4R'")
asrun "tell application \"Things3\" to set creation date of to do id \"$P4R\" to ((current date) - (400 * days))" | sed 's/^/    [as-arith] /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 1' </dev/null
CA=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$P4R'")
note "    AppleScript arith: creationDate $CB -> $CA  $([ "$CB" = "$CA" ] && echo NO-OP || echo CHANGED)"
CB2=$CA
asrun "tell application \"Things3\" to set creation date of to do id \"$P4R\" to date \"6/1/2024\"" | sed 's/^/    [as-datelit] /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 1' </dev/null
CA2=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$P4R'")
note "    AppleScript date \"6/1/2024\" (NEW spelling): creationDate $CB2 -> $CA2  $([ "$CB2" = "$CA2" ] && echo NO-OP || echo CHANGED)"
note "  -- URL update?creation-date= (+token) (expect NO-OP) --"
CB3=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$P4R'")
lab_ssh "$IP" "open 'things:///update?id=$P4R&creation-date=2024-06-01&auth-token=$TOKEN'; sleep 3" </dev/null
CA3=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$P4R'")
note "    URL creation-date=2024-06-01: creationDate $CB3 -> $CA3  $([ "$CB3" = "$CA3" ] && echo NO-OP || echo CHANGED)"

# ---- P3a: reminder-time set formats + bit-layout verification ----
note ""; note "########## P3a — reminder-time SET formats (expect DEAD) ##########"
lab_ssh "$IP" "open 'things:///add?title=P3a-Sched&when=today'; sleep 3" </dev/null
P3A=$(uidt "P3a-Sched"); note "  seed P3a-Sched (when=today) uuid=$P3A"
gq "SELECT 'start='||start||' startDate='||COALESCE(startDate,'NULL')||' reminderTime='||COALESCE(reminderTime,'NULL') FROM TMTask WHERE uuid='$P3A'" | sed 's/^/    pre: /' | tee -a "$REPORT"
for v in "2:30 PM" "14:30" "7/5/2026 2:30 PM"; do
  BEFORE=$(gq "SELECT COALESCE(reminderTime,'NULL') FROM TMTask WHERE uuid='$P3A'")
  runproxy "things-proxy-set-detail" "{\"id\":\"$P3A\",\"detail\":\"Reminder Time\",\"value\":\"$v\"}" >/dev/null 2>&1
  lab_ssh "$IP" 'sleep 1' </dev/null
  AFTER=$(gq "SELECT COALESCE(reminderTime,'NULL') FROM TMTask WHERE uuid='$P3A'")
  note "    Shortcuts Reminder='$v': reminderTime $BEFORE -> $AFTER  $([ "$BEFORE" = "$AFTER" ] && echo NO-OP || echo CHANGED)"
done

note ""; note "########## P3a BITS — reminderTime bit-layout (schema atlas OQ1) ##########"
note "  claim: reminderTime = hour<<26 | minute<<20 . Create dated reminders via URL when=@HH:MM and decode."
# rows: title|whenstr|hour|min
for row in "P3a-B0900|2026-07-15@09:00|9|0" "P3a-B1430|2026-07-15@14:30|14|30" "P3a-B0015|2026-07-15@00:15|0|15" "P3a-B1807|2026-07-15@18:07|18|7"; do
  IFS='|' read -r ttl whenstr hh mm <<< "$row"
  lab_ssh "$IP" "open 'things:///add?title=$ttl&when=$whenstr'; sleep 2" </dev/null
  RT=$(gq "SELECT COALESCE(reminderTime,'NULL') FROM TMTask WHERE title='$ttl' AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
  EXPECT=$(( (hh<<26) | (mm<<20) ))
  note "    $ttl ($whenstr): reminderTime=$RT  expected hour<<26|min<<20 = ($hh<<26|$mm<<20) = $EXPECT  $([ "$RT" = "$EXPECT" ] && echo '✓ MATCH' || echo '✗ MISMATCH')"
done

# ---- P2b: set-detail Parent on a TO-DO ----
note ""; note "########## P2b — set-detail Parent on a TO-DO (expect DESTRUCTIVE DETACH) ##########"
drive P2bA project add \"P2b-ProjA\" --json
drive P2bB project add \"P2b-ProjB\" --json
PA=$(uidp "P2b-ProjA"); PB=$(uidp "P2b-ProjB")
drive P2bTodo todo add \"P2b-Todo\" --project \"P2b-ProjA\" --json
P2T=$(uidt "P2b-Todo")
note "  seed: P2b-Todo=$P2T in ProjA=$PA ; target ProjB=$PB"
BP=$(gq "SELECT COALESCE(project,'NULL') FROM TMTask WHERE uuid='$P2T'")
note "  pre: P2b-Todo.project = $BP (should = ProjA $PA)"
runproxy "things-proxy-set-detail" "{\"id\":\"$P2T\",\"detail\":\"Parent\",\"value\":\"$PB\"}" | sed 's/^/    [proxy] /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 2' </dev/null
AP=$(gq "SELECT COALESCE(project,'NULL') FROM TMTask WHERE uuid='$P2T'")
note "  post: P2b-Todo.project = $AP"
if [ "$AP" = "$PB" ]; then note "  => MOVED to ProjB (works!)"; elif [ "$AP" = "NULL" ]; then note "  => DETACHED (project NULL) — DESTRUCTIVE FOOTGUN reconfirmed (oddity 5l)"; else note "  => unchanged ($AP)"; fi

# ---- P6: sidebar-order spellings ----
note ""; note "########## P6 — sidebar-order remaining spellings ##########"
drive P6X project add \"P6-ProjX\" --json
drive P6Y project add \"P6-ProjY\" --json
P6X=$(uidp "P6-ProjX"); P6Y=$(uidp "P6-ProjY")
note "  seed: P6-ProjX=$P6X  P6-ProjY=$P6Y"
note "  (a) AppleScript move project id X to before project id Y:"
asrun "tell application \"Things3\" to move project id \"$P6X\" to before project id \"$P6Y\"" | sed 's/^/    [P6a] /' | tee -a "$REPORT"
note "  (b) set index of project X to 0:"
asrun "tell application \"Things3\" to set index of project id \"$P6X\" to 0" | sed 's/^/    [P6b-proj] /' | tee -a "$REPORT"
AREA1=$(gq "SELECT uuid FROM TMArea LIMIT 1")
note "  (b) set index of area (uuid=$AREA1) to 0:"
asrun "tell application \"Things3\" to set index of area id \"$AREA1\" to 0" | sed 's/^/    [P6b-area] /' | tee -a "$REPORT"
note "  (c) private reorder in list \"Anytime\" with AREA uuids:"
BIDX=$(gq "SELECT COALESCE(\"index\",'NULL') FROM TMArea WHERE uuid='$AREA1'")
asrun "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Anytime\" with ids \"$AREA1\"" | sed 's/^/    [P6c] /' | tee -a "$REPORT"
AIDX=$(gq "SELECT COALESCE(\"index\",'NULL') FROM TMArea WHERE uuid='$AREA1'")
note "    area index: $BIDX -> $AIDX  $([ "$BIDX" = "$AIDX" ] && echo NO-OP || echo CHANGED)"
note "  (d) private reorder in list \"Someday\" with top-level project uuids (expect WORKS, P6h):"
# seed two dedicated someday projects via URL (robust; area-less someday)
lab_ssh "$IP" "open 'things:///add-project?title=P6-Some1&when=someday'; sleep 2; open 'things:///add-project?title=P6-Some2&when=someday'; sleep 2" </dev/null
S1=$(uidp "P6-Some1"); S2=$(uidp "P6-Some2")
note "    seeded someday projects: P6-Some1=$S1  P6-Some2=$S2"
BXI=$(gq "SELECT COALESCE(\"index\",'NULL') FROM TMTask WHERE uuid='$S1'")
asrun "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Someday\" with ids \"$S2,$S1\"" | sed 's/^/    [P6d] /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 1' </dev/null
AXI=$(gq "SELECT COALESCE(\"index\",'NULL') FROM TMTask WHERE uuid='$S1'")
note "    P6-Some1 index (in Someday): $BXI -> $AXI  $([ "$BXI" = "$AXI" ] && echo NO-OP || echo CHANGED)"
note "  (e) sdef private-command inventory (grep the bundle's Things.sdef):"
lab_ssh "$IP" 'grep -o "_private_[a-zA-Z_ ]*" /Applications/Things3.app/Contents/Resources/Things.sdef 2>/dev/null | sort -u' </dev/null | sed 's/^/    [P6e] /' | tee -a "$REPORT"

# =====================================================================
# GRANT ACCESSIBILITY (AXVM1 rung-b) for the make-repeating ui-drive
# =====================================================================
note ""; note "@@@@@@@@@@@@@@@@ PHASE B setup — grant Accessibility (AXVM1 rung b) @@@@@@@@@@@@@@@@"
if [ -z "$VNCDO" ] || [ ! -x "$VNCDO" ]; then note "FATAL: \$VNCDO not set/executable — cannot grant Accessibility → RSIM-T/U BLOCKED."; env_line; exit 1; fi
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
if [ -z "$VNC_URL" ]; then note "FATAL: no VNC url in state.env. Abort."; exit 1; fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 2; timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 12
V move 1642 332 click 1
V move 1018 869 click 1 pause 0.6 type admin pause 0.6 move 1018 963 click 1
sleep 3
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "  grant auth_value=$GRANT (2=granted)"
lab_ssh "$IP" 'osascript -e '\''tell application "System Settings" to quit'\'' 2>/dev/null' </dev/null
if [ "$GRANT" != "2" ]; then note "FATAL: Accessibility grant did not land (auth_value=$GRANT) → RSIM-T/U BLOCKED."; env_line; exit 1; fi
G config set ui-enabled true >/dev/null 2>&1

# =====================================================================
# RSIM-T — to-do content preserve-trigger isolation (fixed make-repeating)
# =====================================================================
note ""; note "@@@@@@@@@@@@@@@@ RSIM-T — to-do content preserve-trigger @@@@@@@@@@@@@@@@"
note "  RSIM-R: bare/checklist-only to-do DELETES; rich B3 (notes+tag+deadline+checklist) PRESERVED; deadline the leading candidate. Isolate ONE axis."
tcell() {  # tcell <label> <title> <seed-fn>
  local label="$1" title="$2"; shift 2
  note ""; note "  --- RSIM-T $label: '$title' ---"
  "$@"
  local u; u=$(uidt "$title"); note "    seed uuid=$u"
  gq "SELECT 'deadline='||COALESCE(deadline,'NULL')||' notes='||(notes IS NOT NULL AND notes!='')||' start='||start FROM TMTask WHERE uuid='$u'" | sed 's/^/      /' | tee -a "$REPORT"
  gq "SELECT '      tags='||COUNT(*) FROM TMTaskTag WHERE tasks='$u'" | tee -a "$REPORT"
  gq "SELECT '      checklist='||COUNT(*) FROM TMChecklistItem WHERE task='$u'" 2>/dev/null | tee -a "$REPORT"
  warm; snap "t-$label-pre"
  drive "t-$label" todo make-repeating "$u" --frequency weekly --interval 1 --dangerously-drive-gui --json
  settle; snap "t-$label-post"
  note "    --- RSIM-T $label delta ---"; diff_c "t-$label-pre" "t-$label-post" "PT-"
  fate "$u"
}
seed_bare()  { drive t-bare-seed  todo add \"PT-Bare\" --json; }
seed_dl()    { drive t-dl-seed    todo add \"PT-Deadline\" --deadline 2026-08-01 --json; }
seed_notes() { drive t-notes-seed todo add \"PT-Notes\" --notes \"content preserve-trigger probe\" --json; }
seed_chk()   { drive t-chk-seed   todo add \"PT-Checklist\" --checklist-item \"c1\" --checklist-item \"c2\" --json; }
seed_tag()   { local j='[{"type":"to-do","attributes":{"title":"PT-Tag","tags":["PT-TagName"]}}]'; lab_ssh "$IP" "open 'things:///json?data='$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$j")''; sleep 3" </dev/null; }
tcell bare      "PT-Bare"      seed_bare
tcell deadline  "PT-Deadline"  seed_dl
tcell notes     "PT-Notes"     seed_notes
tcell tag       "PT-Tag"       seed_tag
tcell checklist "PT-Checklist" seed_chk

# =====================================================================
# RSIM-U — project edge-state-child preserve isolation (fixed make-repeating)
# =====================================================================
note ""; note "@@@@@@@@@@@@@@@@ RSIM-U — project edge-state-child preserve @@@@@@@@@@@@@@@@"
note "  RSIM-S RS2 counterexample: a plain project (no nested repeater) with a live completed+canceled child PRESERVED its source. Isolate which child STATE flips the fate."
ucell() {  # ucell <label> <projtitle>  (children seeded + states set by the caller before calling; pass a fn)
  local label="$1" title="$2"; shift 2
  note ""; note "  --- RSIM-U $label: project '$title' ---"
  "$@"
  local p; p=$(uidp "$title"); note "    project uuid=$p"
  note "    child states (while PLAIN):"
  gq "SELECT '      '||title||' status='||status FROM TMTask WHERE project='$p' AND type=0 ORDER BY title" | tee -a "$REPORT"
  warm; snap "u-$label-pre"
  drive "u-$label" project make-repeating "$p" --frequency weekly --interval 1 --dangerously-drive-gui --json
  settle; snap "u-$label-post"
  note "    --- RSIM-U $label delta ---"; diff_c "u-$label-pre" "u-$label-post" "PU-"
  fate "$p"
}
seed_uopen() { drive u-open-seed project add \"PU-Open\" --todo \"PU-O-child\" --json; }
seed_ucomp() { drive u-comp-seed project add \"PU-Comp\" --todo \"PU-C-child\" --json; local c; c=$(uidt "PU-C-child"); drive u-comp-do todo complete "$c" --json; }
seed_ucanc() { drive u-canc-seed project add \"PU-Canc\" --todo \"PU-X-child\" --json; local c; c=$(uidt "PU-X-child"); drive u-canc-do todo cancel "$c" --json; }
seed_uboth() { drive u-both-seed project add \"PU-Both\" --todo \"PU-B-done\" --todo \"PU-B-cancel\" --json; local d x; d=$(uidt "PU-B-done"); x=$(uidt "PU-B-cancel"); drive u-both-c todo complete "$d" --json; drive u-both-x todo cancel "$x" --json; }
ucell open  "PU-Open" seed_uopen
ucell comp  "PU-Comp" seed_ucomp
ucell canc  "PU-Canc" seed_ucanc
ucell both  "PU-Both" seed_uboth

note ""; env_line
note "DONE. report: $REPORT   snapshots: $OUT/snaps/"
