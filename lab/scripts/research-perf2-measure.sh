#!/bin/bash
# PERF2 measurement campaign — set-datetime collect scoping + settle-delay audit
# + animation-settings doctrine, on golden-v3.
#
# Sections:
#   S4  RAW WALK — the set-datetime AXDateTimeArea collect timed app-root (OLD)
#       vs dialog-shell-scoped (NEW) on the SAME live open Repeat dialog, N reps.
#       This is the pure per-hop cost the drive's set-datetime step pays; the
#       busy-host 4.4s magnitude is NOT reproducible on the near-empty golden
#       (same limitation PERF1/TRACE1 hit), but the traversal-cost delta is.
#   S5a REVEAL→MENU-READY — how long after the reveal+activate preamble the
#       Items ▸ Repeat menu path becomes enabled (the gap SETTLE_AFTER_REVEAL_MS
#       = 1500 guards). Measured on a warm running app (the host's normal state).
#   S5b MODE-SWITCH→CONTROL-READY — after switching the frequency pop-up, how long
#       until the revealed control appears (the gap WAIT_POLL_MS / the candidate
#       poll guard, UIC6 ~250ms).
#   S6  ANIMATION — menu-press→sheet-present+settle under DEFAULT macOS animation
#       settings vs Reduce Motion + NSAutomaticWindowAnimationsEnabled false.
#       CERT-PARITY: the trims in S5 are certified under DEFAULT settings only;
#       S6 quantifies the reduced-motion effect for the standing-config doctrine.
#
# METHOD: ONE disposable clone `perf2m` of things-lab-golden-v3 (golden
# untouched). golden-v3 carries the baked L3-accessibility grant, so AX
# enumeration runs over SSH. Airgap; pin clock 2026-07-05. Synthetic fixtures.
# Ships the NEW production bundle for the reveal helper only; S4 times both walk
# shapes in ONE probe (no OLD bundle needed). Teardown at the end.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="perf2m"
OUT="lab/artifacts/perf2-measure"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[perf2m] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"
REPS="${REPS:-10}"
BUNDLE_NEW="${BUNDLE_NEW:-/tmp/claude-503/-Volumes-Workspace-Projects-things-api/47c2c59d-13f5-4a26-a415-b9c5b748c288/scratchpad/perf2-bundles/dist-new}"

FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB; bundle-new=$BUNDLE_NEW"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free."; exit 1; }
[ -f "$BUNDLE_NEW/cli/main.js" ] || { note "FATAL: NEW bundle missing at $BUNDLE_NEW"; exit 1; }

# self-contained node
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
note "toolchain: node $(node --version)"

GOLDEN="${GOLDEN:-things-lab-golden-v3}"
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"
cleanup() { [ "$KEEP" = "1" ] && { note "KEEP=1 — leaving $VM at $IP"; return; }; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo FAIL || echo OK' </dev/null)
note "airgap: $AG"; [ "$AG" = "OK" ] || { note "FATAL airgap"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "AX grant=$GRANT (want 2)"; [ "$GRANT" = "2" ] || { note "FATAL AX grant"; exit 1; }
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
MVER=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)

# ---------------- guest helpers ----------------
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# ship NEW bundle (used only to seed a plain to-do via the CLI)
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r "$BUNDLE_NEW" "admin@$IP:/Users/admin/things-lab/things-api/dist"
NODE_MODULES_DIR="$MAIN_WT/node_modules"; [ -d node_modules/commander ] && NODE_MODULES_DIR="$(pwd)/node_modules"
scpO -r "$NODE_MODULES_DIR/commander" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1
note "bundle shipped; Things $TVER / macOS $MVER / $GOLDEN / clock 2026-07-05"

warm()   { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
plain_uuid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }

# median/min/max over a whitespace/newline list of integers
stats() { sort -n | awk '{a[NR]=$1} END{ if(NR==0){print "n=0"; exit} printf "n=%d min=%d median=%d max=%d\n", NR, a[1], a[int((NR+1)/2)], a[NR] }'; }

# ---------------- seed a plain to-do ----------------
warm
G todo add \"PERF2 seed\" --json >"$OUT/seed.log" 2>&1
settle
UUID=$(plain_uuid "PERF2 seed")
note "seed uuid=$UUID"
[ -n "$UUID" ] || { note "FATAL: seed not created"; exit 1; }

# =====================================================================
# S4 — RAW WALK: app-root vs shell-scoped AXDateTimeArea collect
# =====================================================================
# ship the walk probe (attr/collect/findShell copied verbatim from ui.ts)
lab_ssh "$IP" 'cat > ~/labh/perf2-walk.jxa' <<'EOF'
ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('ApplicationServices');
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]); }
function rolestr(el){ var v=attr(el,'AXRole'); return v? v.js : ''; }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a; }
function collect(el,role,depth,out){ if(depth<0) return; if(rolestr(el)===role) out.push(el); var ks=kids(el); for(var i=0;i<ks.length;i++) collect(ks[i],role,depth-1,out); }
function subrole(el){ var v=attr(el,'AXSubrole'); return v? v.js : ''; }
function windowsOf(el){ var c=attr(el,'AXWindows'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a; }
function sizeWH(el){ var s=attr(el,'AXSize'); if(!s) return null; var d=ObjC.castRefToObject($.CFCopyDescription(s)).js; var mw=String(d).match(/w:([-0-9.]+)/); var mh=String(d).match(/h:([-0-9.]+)/); return (mw&&mh)? {w:+mw[1], h:+mh[1]} : null; }
function findShell(app){ var wins=windowsOf(app); for(var i=0;i<wins.length;i++){ if(subrole(wins[i])==='AXStandardWindow'){ var sh=[]; collect(wins[i],'AXSheet',3,sh); if(sh.length) return sh[0]; } } for(var i=0;i<wins.length;i++){ if(subrole(wins[i])==='AXUnknown'){ var wh=sizeWH(wins[i]); if(!wh || !(wh.w===40 && wh.h===40)) return wins[i]; } } return null; }
function run(){
  var apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.culturedcode.ThingsMac');
  if(!apps || apps.count===0) return 'ERR no-things';
  var app=$.AXUIElementCreateApplication(apps.objectAtIndex(0).processIdentifier);
  var t0=Date.now(); var a=[]; try{ collect(app,'AXDateTimeArea',16,a); }catch(e){} var appMs=Date.now()-t0;
  var t1=Date.now(); var shell=findShell(app); var b=[]; try{ if(shell) collect(shell,'AXDateTimeArea',16,b); }catch(e){} var shMs=Date.now()-t1;
  return appMs+'\t'+a.length+'\t'+shMs+'\t'+b.length+'\t'+(shell?'shell':'noshell');
}
run();
EOF

note ""; note "############### S4: RAW WALK (app-root vs shell) ###############"
# open the Repeat dialog and switch Ends -> on date to force a real date area present
warm
lab_ssh "$IP" "open 'things:///show?id=$UUID'; sleep 3; osascript -e 'tell application \"Things3\" to activate' >/dev/null 2>&1; sleep 1; osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"Repeat…\" of menu \"Items\" of menu bar 1' 2>&1; sleep 3" </dev/null | sed 's/^/  [open-dialog] /' | tee -a "$REPORT"
SHEET=$(lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to return (exists sheet 1 of (first window whose subrole is "AXStandardWindow"))'\''' </dev/null)
note "  sheet present after menu press? $SHEET"
: > "$OUT/s4-app.tsv"; : > "$OUT/s4-shell.tsv"
note "  per-rep [appMs appN shellMs shellN shellFound]:"
for i in $(seq 1 "$REPS"); do
  LINE=$(lab_ssh "$IP" 'osascript -l JavaScript ~/labh/perf2-walk.jxa' </dev/null | tr -d '\r')
  echo "    rep$i: $LINE" | tee -a "$REPORT"
  echo "$LINE" | awk -F'\t' '{print $1}' >> "$OUT/s4-app.tsv"
  echo "$LINE" | awk -F'\t' '{print $3}' >> "$OUT/s4-shell.tsv"
done
note "  APP-ROOT walk ms:  $(stats < "$OUT/s4-app.tsv")"
note "  SHELL-SCOPED walk ms: $(stats < "$OUT/s4-shell.tsv")"
# dismiss dialog
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' 2>/dev/null' </dev/null
settle

# =====================================================================
# S5a — REVEAL+ACTIVATE -> MENU-READY convergence (SETTLE_AFTER_REVEAL_MS)
# =====================================================================
lab_ssh "$IP" 'cat > ~/labh/reveal-settle.sh && chmod +x ~/labh/reveal-settle.sh' <<'EOF'
#!/bin/bash
# reveal-settle.sh <uuid> — reveal+activate, then poll until Items>Repeat… is
# enabled; print ms from post-activate to menu-ready. Navigate away first so the
# selection genuinely changes (representative of a repeated drive on a running app).
UUID="$1"
osascript -e 'tell application "Things3" to show list "Logbook"' >/dev/null 2>&1 || open "things:///show?id=logbook" >/dev/null 2>&1
sleep 1
open "things:///show?id=$UUID"
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1
perl -MTime::HiRes=time -e '
  my $t0=time;
  for(my $i=0;$i<300;$i++){
    my $r=`osascript -e '\''tell application "System Events" to tell process "Things3" to try
      return (enabled of menu item "Repeat…" of menu "Items" of menu bar 1)
    on error
      return "err"
    end try'\'' 2>/dev/null`;
    chomp $r;
    if($r eq "true"){ printf "%.0f\n", (time-$t0)*1000; exit 0; }
    select(undef,undef,undef,0.02);
  }
  print "TIMEOUT\n";
'
EOF
note ""; note "############### S5a: REVEAL->MENU-READY (SETTLE_AFTER_REVEAL_MS=1500) ###############"
warm
: > "$OUT/s5a.tsv"
for i in $(seq 1 "$REPS"); do
  MS=$(lab_ssh "$IP" "~/labh/reveal-settle.sh $UUID" </dev/null | tr -d '\r' | tail -1)
  echo "    rep$i: ${MS}ms" | tee -a "$REPORT"
  echo "$MS" | grep -qE '^[0-9]+$' && echo "$MS" >> "$OUT/s5a.tsv"
done
note "  reveal->menu-ready ms: $(stats < "$OUT/s5a.tsv")"
settle

# =====================================================================
# S5b — MODE-SWITCH -> CONTROL-READY convergence (WAIT_POLL_MS / candidate poll)
# =====================================================================
lab_ssh "$IP" 'cat > ~/labh/modeswitch.sh && chmod +x ~/labh/modeswitch.sh' <<'EOF'
#!/bin/bash
# modeswitch.sh — with the Repeat dialog open (default daily/weekly), switch the
# frequency pop-up to Weekly, then time until the weekday pop-up (pop up button 2
# of group 1) appears. Prints ms.
SH='sheet 1 of (first window whose subrole is "AXStandardWindow")'
osascript -e "tell application \"System Events\" to tell process \"Things3\"
  set pu to pop up button 1 of $SH
  click pu
  delay 0.3
  try
    click menu item \"Weekly\" of menu 1 of pu
  end try
end tell" >/dev/null 2>&1
perl -MTime::HiRes=time -e '
  my $t0=time;
  for(my $i=0;$i<300;$i++){
    my $r=`osascript -e '\''tell application "System Events" to tell process "Things3" to try
      return (exists pop up button 2 of group 1 of sheet 1 of (first window whose subrole is "AXStandardWindow"))
    on error
      return "err"
    end try'\'' 2>/dev/null`;
    chomp $r;
    if($r eq "true"){ printf "%.0f\n", (time-$t0)*1000; exit 0; }
    select(undef,undef,undef,0.02);
  }
  print "TIMEOUT\n";
'
EOF
note ""; note "############### S5b: MODE-SWITCH->CONTROL-READY (WAIT_POLL_MS=300, UIC6 ~250ms) ###############"
: > "$OUT/s5b.tsv"
MODEREPS=$(( REPS < 6 ? REPS : 6 ))
for i in $(seq 1 "$MODEREPS"); do
  warm
  lab_ssh "$IP" "open 'things:///show?id=$UUID'; sleep 3; osascript -e 'tell application \"Things3\" to activate' >/dev/null 2>&1; sleep 1; osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"Repeat…\" of menu \"Items\" of menu bar 1' >/dev/null 2>&1; sleep 3" </dev/null
  MS=$(lab_ssh "$IP" "~/labh/modeswitch.sh" </dev/null | tr -d '\r' | tail -1)
  echo "    rep$i: ${MS}ms" | tee -a "$REPORT"
  echo "$MS" | grep -qE '^[0-9]+$' && echo "$MS" >> "$OUT/s5b.tsv"
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' 2>/dev/null' </dev/null
done
note "  mode-switch->control-ready ms: $(stats < "$OUT/s5b.tsv")"
settle

# =====================================================================
# S6 — ANIMATION: menu-press -> sheet-present+settle, default vs reduced motion
# =====================================================================
lab_ssh "$IP" 'cat > ~/labh/sheet-present.sh && chmod +x ~/labh/sheet-present.sh' <<'EOF'
#!/bin/bash
# sheet-present.sh <uuid> — reveal, then click Items>Repeat… and time from the
# click to the sheet being present AND its frequency pop-up resolvable (present+
# settle). Prints ms.
UUID="$1"
open "things:///show?id=$UUID"
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1
sleep 2
perl -MTime::HiRes=time -e '
  my $t0=time;
  system("osascript -e '\''tell application \"System Events\" to tell process \"Things3\" to click menu item \"Repeat…\" of menu \"Items\" of menu bar 1'\'' >/dev/null 2>&1");
  for(my $i=0;$i<400;$i++){
    my $r=`osascript -e '\''tell application "System Events" to tell process "Things3" to try
      return (exists pop up button 1 of sheet 1 of (first window whose subrole is "AXStandardWindow"))
    on error
      return "err"
    end try'\'' 2>/dev/null`;
    chomp $r;
    if($r eq "true"){ printf "%.0f\n", (time-$t0)*1000; exit 0; }
    select(undef,undef,undef,0.01);
  }
  print "TIMEOUT\n";
'
EOF
measure_sheet() { # <label> <tsvfile>
  local label="$1" f="$2"; : > "$f"
  local n=$(( REPS < 8 ? REPS : 8 ))
  for i in $(seq 1 "$n"); do
    warm
    local MS=$(lab_ssh "$IP" "~/labh/sheet-present.sh $UUID" </dev/null | tr -d '\r' | tail -1)
    echo "    [$label] rep$i: ${MS}ms" | tee -a "$REPORT"
    echo "$MS" | grep -qE '^[0-9]+$' && echo "$MS" >> "$f"
    lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' 2>/dev/null' </dev/null
    settle
  done
}
note ""; note "############### S6: ANIMATION (menu-press -> sheet present+settle) ###############"
note "-- DEFAULT animation settings --"
DEF_RM=$(lab_ssh "$IP" 'defaults read com.apple.universalaccess reduceMotion 2>/dev/null || echo unset' </dev/null)
DEF_WA=$(lab_ssh "$IP" 'defaults read -g NSAutomaticWindowAnimationsEnabled 2>/dev/null || echo unset' </dev/null)
note "  baseline defaults: reduceMotion=$DEF_RM NSAutomaticWindowAnimationsEnabled=$DEF_WA"
measure_sheet default "$OUT/s6-default.tsv"
note "  DEFAULT sheet present+settle ms: $(stats < "$OUT/s6-default.tsv")"

note "-- REDUCED MOTION + NSAutomaticWindowAnimationsEnabled false --"
lab_ssh "$IP" 'defaults write com.apple.universalaccess reduceMotion -bool true; defaults write -g NSAutomaticWindowAnimationsEnabled -bool false; killall cfprefsd 2>/dev/null || true' </dev/null
note "  set reduceMotion=$(lab_ssh "$IP" 'defaults read com.apple.universalaccess reduceMotion' </dev/null) NSAutomaticWindowAnimationsEnabled=$(lab_ssh "$IP" 'defaults read -g NSAutomaticWindowAnimationsEnabled' </dev/null)"
measure_sheet reduced "$OUT/s6-reduced.tsv"
note "  REDUCED-MOTION sheet present+settle ms: $(stats < "$OUT/s6-reduced.tsv")"

note ""; note "############### PERF2 MEASURE COMPLETE ###############"
note "env: Things $TVER / macOS $MVER / $GOLDEN / clock 2026-07-05"
note "artifacts under $OUT"
