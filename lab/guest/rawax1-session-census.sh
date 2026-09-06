#!/bin/bash
# RAWAX1 §5c.8 — WHAT the raw client cannot see, and under which condition.
#
# The direct arm's raw shape probe refuses on every probing cell; the AppleScript
# arm passes them all in the same dialog on the same boot, and origin/main's dist
# shows zero such refusals in the same rig. Two hypotheses have already been
# refuted by measurement rather than by argument:
#
#   - the LOGIN SESSION. A `launchctl asuser` shim moved the whole cell run into
#     the console session's bootstrap namespace and changed nothing (16 refusals
#     before, 16 after), and a paired tree census in and out of the session is
#     identical to within one element (86 vs 87 three levels down).
#   - AXEnhancedUserInterface as a WRITE from the executor: asking for it once per
#     hop moved the failure count from 32 to 34.
#
# So this probe stops inferring and dumps the thing itself: the Repeat dialog's
# own sheet, opened through the RAW menu press the drive uses (never through
# System Events, which would set the flag as a side effect and contaminate the
# reading), in three states.
#
# Usage: rawax1-session-census.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
things() { "$NODE" "$APP" "$@"; }

things config set ui-enabled true >/dev/null 2>&1
things todo add "RAWAX1-CENSUS" --when 2026-07-09 --json >/dev/null 2>&1
sleep 3
UUID=$(python3 -c "
import glob, os, sqlite3
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
r = c.execute(\"SELECT uuid FROM TMTask WHERE title='RAWAX1-CENSUS' AND trashed=0 ORDER BY creationDate DESC LIMIT 1\").fetchone()
print(r[0] if r else '')
")
echo "     seed: $UUID"
open "things:///show?id=$UUID" >/dev/null 2>&1
sleep 2
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1
sleep 2

cat >"$HOME/things-lab/census.js" <<'JXA'
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');
function attr(el, name){
  var out = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $(name), out) !== 0) return null;
  return ObjC.castRefToObject(out[0]); }
function sv(el, name){ var v = attr(el, name); if (!v) return ''; try { return String(v.js) } catch(e){ return '' } }
function kids(el, name){ var c = attr(el, name || 'AXChildren'); if (!c) return [];
  var a = [], n = Number(c.count); for (var i = 0; i < n; i++) a.push(c.objectAtIndex(i)); return a; }
function press(el){ return $.AXUIElementPerformAction(el, $('AXPress')); }
function appEl(){
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.culturedcode.ThingsMac');
  if (!apps || Number(apps.count) === 0) return null;
  return $.AXUIElementCreateApplication(Number(apps.objectAtIndex(0).processIdentifier)); }
function sleep(s){ $.NSThread.sleepForTimeInterval(s); }

// The sheet, addressed the way the drive addresses it.
function shellOf(app){
  var ws = kids(app, 'AXWindows'), i;
  for (i = 0; i < ws.length; i++){
    var sh = kids(ws[i], 'AXSheets');
    if (sh.length > 0) return sh[0]; }
  for (i = 0; i < ws.length; i++)
    if (sv(ws[i], 'AXSubrole') === 'AXUnknown' && sv(ws[i], 'AXTitle') === '') {
      var k = kids(ws[i]); if (k.length > 0) return ws[i]; }
  return null; }

function dump(el, depth, lines, max){
  var ch = kids(el);
  for (var i = 0; i < ch.length; i++){
    lines.push(Array(depth + 1).join('  ') + sv(ch[i], 'AXRole') +
      '/' + sv(ch[i], 'AXSubrole') + ' "' + sv(ch[i], 'AXTitle') + '" val="' + sv(ch[i], 'AXValue') + '"');
    if (depth < max) dump(ch[i], depth + 1, lines, max); } }

var app = appEl(), r = { trusted: $.AXIsProcessTrusted() };
if (app === null) { console.log(JSON.stringify({ app: 'NOT-RUNNING' })); }
else {
  r.enhRaw = sv(app, 'AXEnhancedUserInterface');
  // OPEN THE DIALOG THROUGH THE RAW MENU PRESS — the drive's own path, and the
  // one that does not attach System Events and set the flag on the way in.
  var mb = attr(app, 'AXMenuBar'), items = kids(mb), i, itemsMenu = null;
  for (i = 0; i < items.length; i++) if (sv(items[i], 'AXTitle') === 'Items') itemsMenu = items[i];
  r.menuFound = itemsMenu !== null;
  if (itemsMenu !== null){
    press(itemsMenu); sleep(0.8);
    var menu = kids(itemsMenu)[0], mis = menu ? kids(menu) : [], rep = null;
    for (i = 0; i < mis.length; i++) if (sv(mis[i], 'AXTitle').indexOf('Repeat') === 0) rep = mis[i];
    r.repeatItemFound = rep !== null;
    if (rep !== null){ press(rep); sleep(2.5); } }

  var shell = shellOf(app);
  r.sheetFound = shell !== null;
  r.stateA = [];
  if (shell !== null) dump(shell, 0, r.stateA, 2);

  // STATE B: ask for the enhanced tree from THIS process, and report the code.
  r.writeErr = $.AXUIElementSetAttributeValue(app, $('AXEnhancedUserInterface'), $(true));
  r.enhAfterWrite = sv(app, 'AXEnhancedUserInterface');
  sleep(1.0);
  r.stateB = [];
  var shellB = shellOf(app);
  if (shellB !== null) dump(shellB, 0, r.stateB, 2);
  console.log(JSON.stringify(r, null, 1));
}
JXA

echo "===== states A (as the drive finds it) and B (after a raw enhanced-UI write) ====="
osascript -l JavaScript "$HOME/things-lab/census.js" 2>&1 | tee "$OUT/census.json"

echo "===== state C: after System Events attaches (which sets the flag itself) ====="
osascript -e 'tell application "System Events" to tell process "Things3" to get value of attribute "AXEnhancedUserInterface"' 2>&1
osascript -e 'tell application "System Events" to tell process "Things3" to tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to get role of UI elements' 2>&1 | head -c 400
echo ""
osascript -e 'tell application "System Events" to tell process "Things3" to tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to tell group 1 to get {name, value} of pop up buttons' 2>&1 | head -c 600
echo ""

# Tear down through the ladder.
osascript -e 'tell application "System Events" to key code 53' >/dev/null 2>&1
sleep 1
osascript -e 'tell application "System Events" to key code 53' >/dev/null 2>&1
exit 0
