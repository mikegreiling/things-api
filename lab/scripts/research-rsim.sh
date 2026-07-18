#!/bin/bash
# RSIM — recurrence-creation mutation shapes (probe-backlog §C).
# Characterize EXACTLY which rows the app writes when a repeating to-do/project
# is created (fixed-schedule AND after-completion), rescheduled, and when an
# after-completion instance is completed. Prereq for the AGENTBENCH simulator
# recurrence appliers + the tier-3 catalog decision.
#
# METHOD: ONE disposable `--vnc-experimental` clone `rsim-lab` of
# things-lab-golden-v1 (golden untouched). Airgap + pin clock 2026-07-05 12:00.
# Grant Accessibility via the AXVM1 rung-b VNC toggle (the ui vector needs it),
# ship the PRODUCTION e2e bundle, enable ui-enabled, then run six cases. Each
# case snapshots the guest Things DB (read-only, WAL-consistent point read) into
# a host JSON before/after, and a host differ reports the full row-level delta
# (inserted/deleted/changed TMTask rows, every recurrence column, the decoded
# rt1_recurrenceRule plist keys, startDate/deadline derivation). Ground truth =
# DB deltas driven through the SHIPPED CLI (`todo/project make-repeating`,
# `create-repeating`, `reschedule-repeat`, `--dangerously-drive-gui`).
#
# CASES:
#   RSIM1  todo make-repeating FIXED weekly       — instance spawn on create?
#   RSIM2  todo make-repeating AFTER-COMPLETION   — instance spawn on create?
#   RSIM3  project create-repeating FIXED weekly  — template-from-scratch shape
#   RSIM4  complete the RSIM2 after-completion instance — next-spawn shape
#   RSIM5  reschedule-repeat the RSIM1 template   — mutation shape (identity kept)
#   RSIM6  project make-repeating FIXED weekly on an existing area project
#
# VM discipline: --vnc-experimental single-client; space VNC calls; issue each as
# a sole command. Requires $VNCDO (throwaway vncdotool venv). Drive Things WARM
# (~14s after relaunch); relaunch before each GUI drive (menu health).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

VM="rsim-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[rsim] $*" | tee -a "$REPORT"; }
cleanup() { echo "[rsim] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---------------- preflight ----------------
if [ -z "$VNCDO" ] || [ ! -x "$VNCDO" ]; then note "FATAL: \$VNCDO (vncdotool) not set/executable. Abort."; exit 1; fi
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB, VNCDO=$VNCDO"
[ "${FREEGB:-0}" -lt 8 ] && { note "FATAL: <8GB free. Abort."; exit 1; }

# ---------------- host toolchain (asdf shims fail in a non-interactive shell) ----------------
# node/npm are asdf shims that need `asdf` on PATH; a detached run may not have it.
# MUST use a SELF-CONTAINED node (the shipped guest binary has none of the host's
# dylibs): the .tool-versions asdf install links no /opt/homebrew libs, whereas a
# homebrew node pulls in libicu/libuv/etc. that don't exist in the guest and would
# dyld-fail there. Prefer the asdf install; only accept a fallback whose node carries
# no /opt/homebrew dylib deps. (asdf's `npm` is a symlink to a non-exec .js — check
# node's exec bit only, then verify npm runs after PATH is set.)
# .tool-versions is gitignored (absent from the worktree), so glob every asdf nodejs
# install (the pinned one first if resolvable) and take the first SELF-CONTAINED node;
# homebrew is a last resort and is rejected by the dylib check anyway.
# Resolve the repo's pinned version from the MAIN worktree's .tool-versions (via the
# shared git dir), then list every asdf nodejs install NEWEST-FIRST so we never pick a
# too-old node (the build needs node's built-in SQLite ⇒ node 22+).
MAIN_WT=$(dirname "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null || true)
NODE_VER=$(awk '/nodejs/{print $2}' "$MAIN_WT/.tool-versions" .tool-versions "$HOME/.tool-versions" 2>/dev/null | head -1 || true)
CANDS=("$HOME/.asdf/installs/nodejs/$NODE_VER/bin")
CANDS+=( $(ls -d "$HOME"/.asdf/installs/nodejs/*/bin 2>/dev/null | sort -t/ -k7 -V -r) )
CANDS+=(/opt/homebrew/bin)
for cand in "${CANDS[@]}"; do
  [ -x "$cand/node" ] || continue
  otool -L "$cand/node" 2>/dev/null | grep -q '/opt/homebrew/' && continue   # not guest-shippable
  export PATH="$cand:$PATH"; break
done
if ! node --version >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
  note "FATAL: no working self-contained node/npm on PATH. Abort."; exit 1
fi
note "toolchain: node $(node --version) / npm $(npm --version) @ $(command -v node)"
# The git WORKTREE has its own node_modules (not shared with the primary checkout);
# the build + the shipped commander both need it (rem1 lesson).
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
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[rsim] /'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# ---------------- guest helpers: read-only SQLite + snapshot dumper ----------------
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# rsnap.py: dump EVERY TMTask row (incl. trashed — make-repeating hard-deletes the
# original) as a uuid-keyed JSON with all recurrence-relevant columns; the
# rt1_recurrenceRule blob is decoded to {size, keys}. Read-only, WAL-consistent.
lab_ssh "$IP" 'cat > /tmp/rsnap.py' <<'EOF'
import sys, sqlite3, glob, plistlib, json
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
cols=["uuid","title","type","status","trashed","start","startDate","startBucket",
      "reminderTime","deadline","t2_deadlineOffset","\"index\"","todayIndex",
      "area","project","heading","rt1_recurrenceRule","rt1_repeatingTemplate",
      "rt1_instanceCreationStartDate","rt1_instanceCreationPaused",
      "rt1_instanceCreationCount","rt1_afterCompletionReferenceDate",
      "rt1_nextInstanceStartDate"]
names=[x.strip('"') for x in cols]
def safe(v):
    if isinstance(v,(bytes,bytearray)): return "<%dB>"%len(v)
    return v
rows={}
for r in c.execute("SELECT %s FROM TMTask"%",".join(cols)):
    d=dict(zip(names,[safe(x) for x in r]))
    rr=r[names.index("rt1_recurrenceRule")]
    if rr is not None:
        try:
            pl=plistlib.loads(rr)
            d["rt1_recurrenceRule"]={"size":len(rr),"keys":{k:(pl[k] if not isinstance(pl[k],(bytes,bytearray)) else "<blob>") for k in sorted(pl)}}
        except Exception as e:
            d["rt1_recurrenceRule"]={"size":len(rr),"error":str(e)}
    rows[d["uuid"]]=d
json.dump(rows,sys.stdout,default=str)
EOF
# snap <label> -> writes host JSON snaps/<label>.json
snap() { lab_ssh "$IP" 'python3 /tmp/rsnap.py' </dev/null > "$OUT/snaps/$1.json"; }

# ---------------- host-side differ ----------------
cat > "$OUT/diff_snaps.py" <<'EOF'
import sys, json
def dpk(v):  # decode packed date int  y<<16 | m<<12 | d<<7
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d(%d)"%(y,m,d,v) if 1<y<5000 else v
DATEF={"startDate","deadline","rt1_instanceCreationStartDate","rt1_afterCompletionReferenceDate","rt1_nextInstanceStartDate"}
def rr(d):  # compact recurrence-rule repr
    v=d.get("rt1_recurrenceRule")
    if v is None: return "NULL"
    if isinstance(v,dict) and "keys" in v: return "rule(%dB){%s}"%(v["size"],", ".join("%s=%s"%(k,v["keys"][k]) for k in v["keys"]))
    return str(v)
def line(d):
    f=[]
    f.append("type=%s status=%s trashed=%s start=%s"%(d.get("type"),d.get("status"),d.get("trashed"),d.get("start")))
    f.append("startDate=%s startBucket=%s deadline=%s t2off=%s"%(dpk(d.get("startDate")),d.get("startBucket"),dpk(d.get("deadline")),d.get("t2_deadlineOffset")))
    f.append("reminderTime=%s"%d.get("reminderTime"))
    f.append("tmpl=%s"%d.get("rt1_repeatingTemplate"))
    f.append("icStart=%s icPaused=%s icCount=%s"%(dpk(d.get("rt1_instanceCreationStartDate")),d.get("rt1_instanceCreationPaused"),d.get("rt1_instanceCreationCount")))
    f.append("acRef=%s nextStart=%s"%(dpk(d.get("rt1_afterCompletionReferenceDate")),dpk(d.get("rt1_nextInstanceStartDate"))))
    f.append("rule=%s"%rr(d))
    return "\n      ".join(f)
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
onlytitle=sys.argv[3] if len(sys.argv)>3 else None
def keep(d): return (onlytitle is None) or (str(d.get("title","")).startswith(onlytitle))
ins=[u for u in b if u not in a and keep(b[u])]
dele=[u for u in a if u not in b and keep(a[u])]
chg=[]
for u in b:
    if u in a and keep(b[u]):
        diffs={k:(a[u].get(k),b[u].get(k)) for k in b[u] if a[u].get(k)!=b[u].get(k)}
        if diffs: chg.append((u,diffs))
print("  INSERTED: %d   DELETED: %d   CHANGED: %d"%(len(ins),len(dele),len(chg)))
for u in ins:
    d=b[u]; print("  + INSERT %s  \"%s\"\n      %s"%(u,d.get("title"),line(d)))
for u in dele:
    d=a[u]; print("  - DELETE %s  \"%s\"  (was type=%s status=%s rule=%s)"%(u,d.get("title"),d.get("type"),d.get("status"),rr(d)))
for u,diffs in chg:
    print("  ~ CHANGE %s  \"%s\""%(u,b[u].get("title")))
    for k,(ov,nv) in sorted(diffs.items()):
        if k=="rt1_recurrenceRule": ov,nv=rr({"rt1_recurrenceRule":ov}),rr({"rt1_recurrenceRule":nv})
        elif k in DATEF: ov,nv=dpk(ov),dpk(nv)
        print("      %s: %s -> %s"%(k,ov,nv))
EOF
diff_c() {  # diff_c <before-label> <after-label> [title-prefix]
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
V move 1642 332 click 1                                                        # the lone sshd-keygen-wrapper toggle
V move 1018 869 click 1 pause 0.6 type admin pause 0.6 move 1018 963 click 1   # admin auth sheet
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
G()  { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
# drive <label> <cli args…> — runs the CLI, captures FULL stdout+stderr to a per-case
# log (never discarded — the RSIM1 wasted-run lesson), echoes the ok line + exit to the
# report. The DB delta is still the ground truth; this just makes a no-op/blocked drive
# VISIBLE instead of silent.
drive() {
  local label="$1"; shift
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive-$label.log" 2>&1
  { grep -m1 '"ok"' "$OUT/drive-$label.log" || echo '(no ok line — drive failed/blocked; see drive log)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive-$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}
if ! lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1; then
  note "FATAL: guest node not runnable after ship — bundle ship failed. Abort."; exit 1
fi
G config set ui-enabled true >/dev/null 2>&1

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }

uid()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL LIMIT 1"; }
tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
insts(){ gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0"; }
env_line() { note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"; }

# =====================================================================
# RSIM1 — todo make-repeating FIXED weekly
# =====================================================================
note ""; note "############### RSIM1: todo make-repeating FIXED weekly ###############"
lab_ssh "$IP" "open 'things:///add?title=RSIM-1&when=today'; sleep 1" </dev/null
U1=$(uid RSIM-1); note "  seed RSIM-1 uuid=$U1"
settle; snap rsim1-A
warm
drive RSIM1 todo make-repeating "$U1" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap rsim1-Bimm         # immediate: right after the drive, before any maintenance relaunch
note "  --- RSIM1 delta A -> B(immediate) [RSIM-1 rows] ---"; diff_c rsim1-A rsim1-Bimm RSIM-1
warm; settle; snap rsim1-Bwarm  # after a maintenance relaunch cycle
note "  --- RSIM1 delta B(immediate) -> B(after warm/maintenance) [RSIM-1 rows] ---"; diff_c rsim1-Bimm rsim1-Bwarm RSIM-1
T1=$(tmpl RSIM-1); note "  RSIM1 template=$T1  instances=[$(insts "$T1" | tr '\n' ' ')]"

# =====================================================================
# RSIM2 — todo make-repeating AFTER-COMPLETION weekly
# =====================================================================
note ""; note "############### RSIM2: todo make-repeating AFTER-COMPLETION weekly ###############"
lab_ssh "$IP" "open 'things:///add?title=RSIM-2&when=today'; sleep 1" </dev/null
U2=$(uid RSIM-2); note "  seed RSIM-2 uuid=$U2"
settle; snap rsim2-A
warm
drive RSIM2 todo make-repeating "$U2" --frequency weekly --interval 1 --after-completion --dangerously-drive-gui --json
settle; snap rsim2-Bimm
note "  --- RSIM2 delta A -> B(immediate) [RSIM-2 rows] ---"; diff_c rsim2-A rsim2-Bimm RSIM-2
warm; settle; snap rsim2-Bwarm
note "  --- RSIM2 delta B(immediate) -> B(after warm/maintenance) [RSIM-2 rows] ---"; diff_c rsim2-Bimm rsim2-Bwarm RSIM-2
T2=$(tmpl RSIM-2); note "  RSIM2 template=$T2  instances=[$(insts "$T2" | tr '\n' ' ')]"

# =====================================================================
# RSIM3 — project create-repeating FIXED weekly (template-from-scratch)
#   (the CLI has NO todo create-repeating; only project.create-repeating.)
# =====================================================================
note ""; note "############### RSIM3: project create-repeating FIXED weekly ###############"
note "  (note: CLI exposes create-repeating for PROJECT only; no todo create-repeating verb)"
settle; snap rsim3-A
warm
drive RSIM3 project create-repeating "RSIM-3" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap rsim3-Bimm
note "  --- RSIM3 delta A -> B(immediate) [RSIM-3 rows] ---"; diff_c rsim3-A rsim3-Bimm RSIM-3
warm; settle; snap rsim3-Bwarm
note "  --- RSIM3 delta B(immediate) -> B(after warm/maintenance) [RSIM-3 rows] ---"; diff_c rsim3-Bimm rsim3-Bwarm RSIM-3
T3=$(tmpl RSIM-3); note "  RSIM3 template=$T3  instances=[$(insts "$T3" | tr '\n' ' ')]"

# =====================================================================
# RSIM4 — complete the RSIM2 after-completion instance -> next-spawn shape
# =====================================================================
note ""; note "############### RSIM4: complete the RSIM2 after-completion instance ###############"
INST2=$(insts "$T2" | head -1)
if [ -z "$INST2" ]; then
  note "  RSIM4: no live RSIM2 instance to complete (after-completion spawned none at create) — see RSIM2 verdict"
else
  note "  completing RSIM2 instance uuid=$INST2"
  settle; snap rsim4-A
  drive RSIM4 todo complete "$INST2" --json
  warm; settle; snap rsim4-B     # next instance materializes via maintenance relaunch
  note "  --- RSIM4 delta A -> B [RSIM-2 rows] ---"; diff_c rsim4-A rsim4-B RSIM-2
  note "  RSIM2 instances after completion=[$(insts "$T2" | tr '\n' ' ')]"
fi

# =====================================================================
# RSIM5 — reschedule-repeat the RSIM1 template (identity kept)
# =====================================================================
note ""; note "############### RSIM5: reschedule-repeat RSIM1 template weekly->daily/2 ###############"
if [ -z "$T1" ]; then
  note "  RSIM5: no RSIM1 template captured — skipping"
else
  note "  rescheduling template uuid=$T1"
  settle; snap rsim5-A
  warm
  drive RSIM5 todo reschedule-repeat "$T1" --frequency daily --interval 2 --dangerously-drive-gui --json
  settle; snap rsim5-Bimm
  note "  --- RSIM5 delta A -> B(immediate) [RSIM-1 rows] ---"; diff_c rsim5-A rsim5-Bimm RSIM-1
  warm; settle; snap rsim5-Bwarm
  note "  --- RSIM5 delta B(immediate) -> B(after warm/maintenance) [RSIM-1 rows] ---"; diff_c rsim5-Bimm rsim5-Bwarm RSIM-1
  note "  RSIM1 template still=$(tmpl RSIM-1)  (identity kept if == $T1)"
fi

# =====================================================================
# RSIM6 — project make-repeating FIXED weekly on an existing AREA project
# =====================================================================
note ""; note "############### RSIM6: project make-repeating FIXED weekly (area project) ###############"
lab_ssh "$IP" "open 'things:///add-project?title=RSIM-6&area=LAB-AREA-A'; sleep 2" </dev/null
P6=$(gq "SELECT uuid FROM TMTask WHERE title='RSIM-6' AND type=1 AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1")
note "  seed project RSIM-6 uuid=$P6"
settle; snap rsim6-A
warm
drive RSIM6 project make-repeating "$P6" --frequency weekly --interval 1 --dangerously-drive-gui --json
settle; snap rsim6-Bimm
note "  --- RSIM6 delta A -> B(immediate) [RSIM-6 rows] ---"; diff_c rsim6-A rsim6-Bimm RSIM-6
warm; settle; snap rsim6-Bwarm
note "  --- RSIM6 delta B(immediate) -> B(after warm/maintenance) [RSIM-6 rows] ---"; diff_c rsim6-Bimm rsim6-Bwarm RSIM-6
T6=$(tmpl RSIM-6); note "  RSIM6 template=$T6  instances=[$(insts "$T6" | tr '\n' ' ')]"

note ""; env_line
note "DONE. report: $REPORT   snapshots: $OUT/snaps/"
