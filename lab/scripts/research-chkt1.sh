#!/bin/bash
# CHKT1 — checklist writes on a repeating TO-DO template (issue #479).
#
# The report: `things todo checklist <template-uuid> --item …` on a repeating
# template exits verify-failed:silent-noop — the URL-scheme vector (the only one
# with a todo.replace-checklist matrix entry) accepts the write but the DB shows
# no change. The H-REPEAT-SCHEDULE guard currently lets checklist writes THROUGH
# to templates and its remediation claims "checklist replacement remain allowed
# on templates" — this issue falsifies that. This campaign: (Phase 0) reproduce
# under golden-v2/3.22.12; (Phase A) census EVERY vector against a template —
# AppleScript / Shortcuts (set-detail Checklist — the untested Detail) / URL
# (replace + append) / GUI; (Phase A5) propagation for any vector that sticks.
#
# METHOD: ONE disposable clone `chkt1-lab` of things-lab-golden-v2 (golden
# untouched; every write inside the clone). golden-v2 carries the baked
# L3-accessibility grant, so make-repeating + AX census drive over SSH via
# System Events — NO VNC. Airgap (default route deleted, ping fails); pin clock
# 2026-07-05 12:00 (Sunday) before Things launches. Ship the PRODUCTION e2e
# bundle. Fixtures fully synthetic (CHKT-* titles). Ground truth = read-only
# guest SQLite (TMChecklistItem rows keyed on task uuid). Teardown at the end
# (single-VM courtesy — the other delegate needs the 2nd slot).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="chkt1-lab"
OUT="lab/artifacts/chkt1-lab"; mkdir -p "$OUT/snaps" "$OUT/ax" "$OUT/drive"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[chkt1] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

# ---------------- preflight ----------------
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free. Abort."; exit 1; }

# self-contained node (rem1/rsim lesson: avoid a homebrew-linked node)
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
node --version >/dev/null 2>&1 || { note "FATAL: no working node on PATH"; exit 1; }
note "toolchain: node $(node --version) @ $(command -v node)"
if [ ! -d node_modules/commander ]; then
  note "npm ci (worktree has no node_modules)…"
  npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL: npm ci failed (see npm-ci.log)."; exit 1; }
fi

# ---------------- clone + boot (no VNC — golden AX baked) ----------------
GOLDEN="${GOLDEN:-things-lab-golden-v2}"
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM running at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
note "airgap: $AG"
[ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "AX grant=$GRANT (want 2)"
[ "$GRANT" = "2" ] || { note "FATAL: AX grant missing"; exit 1; }

# ---------------- guest helpers ----------------
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null   # persistent (survives a reboot; NOT /tmp — cleaner lesson)
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# checklist dumper: rows for a task uuid (title|status|index)
lab_ssh "$IP" 'cat > ~/labh/chk.py' <<'EOF'
import sys, sqlite3, glob
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
n=0
for ti,st,ix in c.execute('SELECT title,status,"index" FROM TMChecklistItem WHERE task=? ORDER BY "index"',(sys.argv[1],)):
    print("    chk[%s] '%s' status=%s"%(ix,ti,st)); n+=1
if n==0: print("    (no checklist items)")
EOF
chk() { lab_ssh "$IP" "python3 ~/labh/chk.py $1" </dev/null | tee -a "$REPORT"; }
chkcount() { gq "SELECT COUNT(*) FROM TMChecklistItem WHERE task='$1'"; }

# full-app AX tree dumper (windows + sheets; role/subrole/title/desc/value/id + frame)
lab_ssh "$IP" 'cat > ~/labh/axtree.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function frame(el){var p=attr(el,'AXPosition'),z=attr(el,'AXSize');function d(x){if(!x)return null;return ObjC.castRefToObject($.CFCopyDescription(x)).js}
  var pp=d(p),zz=d(z);var mp=pp&&pp.match(/x:([-0-9.]+) y:([-0-9.]+)/);var mz=zz&&zz.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return {x:mp?+mp[1]:null,y:mp?+mp[2]:null,w:mz?+mz[1]:null,h:mz?+mz[2]:null}}
function appEl(){return $.AXUIElementCreateApplication(pidOf('Things3'))}
function line(el,d){
  var p=['role='+sv(el,'AXRole')]
  var sub=sv(el,'AXSubrole'); if(sub)p.push('sub='+sub)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de)
  var rd=sv(el,'AXRoleDescription'); if(rd)p.push('rdesc='+rd)
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,60))
  var id=sv(el,'AXIdentifier'); if(id)p.push('id='+id)
  var f=frame(el); if(f.x!==null)p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']')
  return Array(d+1).join('  ')+p.join(' | ')
}
function walk(el,d,acc){acc.push(line(el,d)); if(d>18)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc); return acc}
function run(){
  var app=appEl(); var ws=kids(app); var acc=['=== APP TREE (windows='+ws.length+') ===']
  for(var i=0;i<ws.length;i++){acc.push('--- window '+i+' role='+sv(ws[i],'AXRole')+' sub='+sv(ws[i],'AXSubrole')+' ttl='+sv(ws[i],'AXTitle')+' ---'); walk(ws[i],0,acc)}
  return acc.join('\n')
}
EOF
axdump() { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/axtree.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; note "  ax dump $1 ($(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines)"; }

note "guest helpers installed (~/labh: gsql.sh chk.py axtree.jxa)"

# ---------------- build + ship bundle ----------------
note "build + ship production bundle"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL build (see build.log)"; exit 1; }
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1 || { note "FATAL: guest node broken"; exit 1; }
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
drive() {
  local label="$1"; shift
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive/$label.log" 2>&1
  { grep -m1 '"status": *"ok"\|"ok"' "$OUT/drive/$label.log" || grep -m1 'verify-failed\|unsupported\|blocked\|"error"\|error:' "$OUT/drive/$label.log" || echo '(no verdict line — see drive log)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive/$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}
G config set ui-enabled true >/dev/null 2>&1
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
MVER=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
note "bundle shipped; ui-enabled=true; Things $TVER / macOS $MVER / DB v26 / clock 2026-07-05"

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
note "auth token present: $([ -n "$TOKEN" ] && echo yes || echo NO)"

warm()   { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
nudge()  { lab_ssh "$IP" "open 'things:///show?id=upcoming'; sleep 4; open 'things:///show?id=today'; sleep 6" </dev/null; }
openurl(){ lab_ssh "$IP" "open -g '$1'; sleep 4" </dev/null; }

# =====================================================================
# SETUP — a plain to-do control + a daily repeating to-do template
# =====================================================================
note ""; note "############### SETUP: seed plain control + repeating template ###############"
warm
drive S_plain  todo add \"CHKT Plain\" --json
PLAIN=$(gq "SELECT uuid FROM TMTask WHERE title='CHKT Plain' AND type=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1")
note "  plain control uuid=$PLAIN"

# repeating to-do template via add-repeating (ui vector; first occurrence 07-06 so a +1-day advance spawns)
drive S_repeat todo add-repeating \"CHKT Repeat\" --when 2026-07-06 --frequency daily --interval 1 --dangerously-drive-gui --json
settle
TPL=$(gq "SELECT uuid FROM TMTask WHERE title='CHKT Repeat' AND type=0 AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1")
INS0=$(gq "SELECT uuid FROM TMTask WHERE title='CHKT Repeat' AND type=0 AND rt1_repeatingTemplate IS NOT NULL AND trashed=0 ORDER BY startDate LIMIT 1")
note "  repeating template uuid=$TPL"
note "  first instance uuid=$INS0"
[ -n "$TPL" ] || { note "FATAL: no repeating template row after add-repeating (see drive/S_repeat.log). VM left for inspection."; KEEP=1; exit 1; }
note "  template rule row:"
gq "SELECT title,type,status,trashed,(rt1_recurrenceRule IS NOT NULL) hasRule,rt1_repeatingTemplate FROM TMTask WHERE uuid='$TPL'" | sed 's/^/    /' | tee -a "$REPORT"

# reusable per-target checklist probe: dump before, run, dump after
show_chk() { note "  $1 checklist (task=$2):"; chk "$2"; }

# =====================================================================
# PHASE 0 — repro via production CLI (URL-scheme replace-checklist)
# =====================================================================
note ""; note "############### PHASE 0: production CLI todo checklist ###############"
note "-- control: plain to-do --"
drive P0_plain todo checklist "$PLAIN" --item \"Room A\" --item \"Room B\" --item \"Room C\" --item \"Room D\" --json
settle; show_chk "P0 plain (control)" "$PLAIN"
note "-- REPRO: repeating template --"
drive P0_tmpl  todo checklist "$TPL" --item \"Synthetic room A\" --item \"Synthetic room B\" --item \"Synthetic room C\" --item \"Synthetic room D\" --json
settle; show_chk "P0 template (repro)" "$TPL"

# =====================================================================
# PHASE A1 — AppleScript checklist access (A30 recheck) on the template
# =====================================================================
note ""; note "############### PHASE A1: AppleScript ###############"
lab_ssh "$IP" 'open -g -a Things3; sleep 5' </dev/null
note "-- read: get checklist items of the template --"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to get checklist items of to do id \"$TPL\"' 2>&1; echo EXIT=\$?" </dev/null | sed 's/^/  [A1-read] /' | tee -a "$REPORT"
note "-- write: make new checklist item at the template --"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to make new checklist item at end of to do id \"$TPL\" with properties {name:\"AS tmpl item\"}' 2>&1; echo EXIT=\$?" </dev/null | sed 's/^/  [A1-write] /' | tee -a "$REPORT"
note "-- write control: make new checklist item at the PLAIN to-do --"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to make new checklist item at end of to do id \"$PLAIN\" with properties {name:\"AS plain item\"}' 2>&1; echo EXIT=\$?" </dev/null | sed 's/^/  [A1-plain] /' | tee -a "$REPORT"
settle
show_chk "A1 template after AppleScript" "$TPL"

# =====================================================================
# PHASE A2 — Shortcuts set-detail Checklist (the untested Detail)
# =====================================================================
note ""; note "############### PHASE A2: Shortcuts set-detail Checklist ###############"
lab_ssh "$IP" 'open -g -a Things3; sleep 5' </dev/null
sc_setdetail() {
  # sc_setdetail <label> <uuid> <value>
  local label="$1" uuid="$2" value="$3"
  lab_ssh "$IP" "cat > ~/labh/sc-$label.json" <<JSON
{"id":"$uuid","detail":"Checklist","value":"$value"}
JSON
  lab_ssh "$IP" "rm -f ~/labh/sc-$label.out; shortcuts run things-proxy-set-detail --input-path ~/labh/sc-$label.json --output-path ~/labh/sc-$label.out 2>&1; echo EXIT=\$?; echo '---OUT---'; cat ~/labh/sc-$label.out 2>/dev/null" </dev/null | sed "s/^/  [A2-$label] /" | tee -a "$REPORT"
}
note "-- control: plain to-do (does set-detail Checklist work at all?) --"
sc_setdetail plain "$PLAIN" "SC plain 1\nSC plain 2\nSC plain 3"
note "-- template --"
sc_setdetail tmpl "$TPL" "SC tmpl 1\nSC tmpl 2\nSC tmpl 3"
settle
show_chk "A2 plain after Shortcuts" "$PLAIN"
show_chk "A2 template after Shortcuts" "$TPL"

# =====================================================================
# PHASE A3 — URL scheme raw: replace (checklist-items) + append (append-checklist-items)
# =====================================================================
note ""; note "############### PHASE A3: URL scheme raw ###############"
lab_ssh "$IP" 'open -g -a Things3; sleep 5' </dev/null
note "-- replace via checklist-items on template (confirm CLI faithfully reproduces) --"
openurl "things:///update?auth-token=$TOKEN&id=$TPL&checklist-items=URLrep%20A%0AURLrep%20B"
settle; show_chk "A3 template after URL replace" "$TPL"
note "-- append via append-checklist-items on template (the untested param) --"
lab_ssh "$IP" 'open -g -a Things3; sleep 5' </dev/null
openurl "things:///update?auth-token=$TOKEN&id=$TPL&append-checklist-items=URLapp%20A%0AURLapp%20B"
settle; show_chk "A3 template after URL append" "$TPL"
note "-- append control on PLAIN to-do --"
lab_ssh "$IP" 'open -g -a Things3; sleep 5' </dev/null
openurl "things:///update?auth-token=$TOKEN&id=$PLAIN&append-checklist-items=URLapp%20P1%0AURLapp%20P2"
settle; show_chk "A3 plain after URL append" "$PLAIN"

# =====================================================================
# PHASE A4 — GUI census: how does a GUI user reach a template's checklist?
# =====================================================================
note ""; note "############### PHASE A4: GUI census ###############"
warm
note "-- show?id=<template> then AX-dump --"
lab_ssh "$IP" "open 'things:///show?id=$TPL'; sleep 5" </dev/null
axdump "template-show"
note "-- open first instance card (Upcoming projection) then AX-dump --"
lab_ssh "$IP" "open 'things:///show?id=$INS0'; sleep 5" </dev/null
axdump "instance-show"
note "  (AX dumps saved under $OUT/ax/ — inspect for a checklist affordance on template vs instance)"

# =====================================================================
# PHASE A5 — propagation: only if the template checklist is non-empty
# =====================================================================
note ""; note "############### PHASE A5: propagation (clock-advance +1 day) ###############"
TCHK=$(chkcount "$TPL")
note "  template checklist item count = $TCHK"
if [ "${TCHK:-0}" -gt 0 ]; then
  note "  template HAS checklist items — advancing clock to spawn a fresh instance (INS0=07-06 pre-spawned; advance to 07-07)"
  settle
  lab_ssh "$IP" 'sudo date 070712002026 >/dev/null' </dev/null
  note "  clock now: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
  warm; nudge; settle
  NEWINS=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TPL' AND type=0 AND trashed=0 AND uuid!='$INS0' ORDER BY startDate DESC LIMIT 1")
  note "  newest instance (!=INS0) = ${NEWINS:-<none>}"
  [ -n "$NEWINS" ] && show_chk "A5 spawned instance" "$NEWINS"
else
  note "  template checklist EMPTY — no vector landed items; propagation N/A (branch 3 territory)."
fi

# =====================================================================
note ""; note "############### CHKT1 COMPLETE ###############"
note "env: Things $TVER / macOS $MVER / DB v26 / $GOLDEN / clock start 2026-07-05"
note "template=$TPL  instance0=$INS0  plain=$PLAIN"
note "artifacts under $OUT (report.txt, drive/*.log, ax/*.txt)"
