#!/bin/bash
# RAWAX1 §5c.8 — the state the drive is actually in, dumped both ways.
#
# The direct arm's raw shape probe refuses on every probing cell while the
# AppleScript arm passes them all. Two hypotheses are already refuted by
# measurement (the login session, and AXEnhancedUserInterface — see the campaign
# doc), and neither earlier census could have answered the question, because both
# dumped a FRESHLY OPENED dialog: that one is in its after-completion default and
# legitimately has no `Next:` row at all.
#
# So this one reproduces the drive's own state — open the dialog, SELECT A
# FREQUENCY, and only then read — and dumps the sheet twice: raw, and through
# System Events, in that order, because a System Events read attaches and would
# contaminate the raw one if it went first.
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
function byRole(el, role){ var ch = kids(el), out = [];
  for (var i = 0; i < ch.length; i++) if (sv(ch[i], 'AXRole') === role) out.push(ch[i]); return out; }
function press(el){ return $.AXUIElementPerformAction(el, $('AXPress')); }
function sleep(s){ $.NSThread.sleepForTimeInterval(s); }
function appEl(){
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.culturedcode.ThingsMac');
  if (!apps || Number(apps.count) === 0) return null;
  return $.AXUIElementCreateApplication(Number(apps.objectAtIndex(0).processIdentifier)); }

// The sheet, addressed every way the drive knows how.
function shellOf(app){
  var ws = kids(app, 'AXWindows'), i, j;
  for (i = 0; i < ws.length; i++){
    var sh = kids(ws[i], 'AXSheets');
    for (j = 0; j < sh.length; j++) return sh[j]; }
  for (i = 0; i < ws.length; i++)
    if (sv(ws[i], 'AXSubrole') === 'AXUnknown' && kids(ws[i]).length > 0) return ws[i];
  return null; }

function dump(el, depth, lines, max){
  var ch = kids(el);
  for (var i = 0; i < ch.length; i++){
    lines.push(Array(depth + 1).join('  ') + sv(ch[i], 'AXRole') +
      '/' + sv(ch[i], 'AXSubrole') + ' "' + sv(ch[i], 'AXTitle') + '" val="' + sv(ch[i], 'AXValue') + '"');
    if (depth < max) dump(ch[i], depth + 1, lines, max); } }

var app = appEl(), r = { trusted: $.AXIsProcessTrusted() };
r.enhAtStart = sv(app, 'AXEnhancedUserInterface');

// 1. Open the dialog through the RAW menu press — the drive's own path, and the
//    one that does not attach System Events on the way in.
var mb = attr(app, 'AXMenuBar'), items = kids(mb), i, itemsMenu = null;
for (i = 0; i < items.length; i++) if (sv(items[i], 'AXTitle') === 'Items') itemsMenu = items[i];
if (itemsMenu !== null){
  press(itemsMenu); sleep(0.8);
  var menu = kids(itemsMenu)[0], mis = menu ? kids(menu) : [], rep = null;
  for (i = 0; i < mis.length; i++) if (sv(mis[i], 'AXTitle').indexOf('Repeat') === 0) rep = mis[i];
  if (rep !== null){ press(rep); sleep(2.5); } }

var shell = shellOf(app);
r.sheetFound = shell !== null;
if (shell === null) { console.log(JSON.stringify(r, null, 1)); }
else {
  r.shellRoles = [];
  var sk = kids(shell);
  for (i = 0; i < sk.length; i++) r.shellRoles.push(sv(sk[i], 'AXRole'));

  // 2. SELECT A FREQUENCY — the step that makes a `Next:` row exist at all, and
  //    the reason every earlier census dumped a dialog that could not answer.
  var pops = byRole(shell, 'AXPopUpButton');
  r.shellPopUps = pops.length;
  r.freqBefore = pops.length ? sv(pops[0], 'AXValue') : '(none)';
  if (pops.length){
    press(pops[0]); sleep(0.8);
    var fmenu = kids(pops[0])[0], fitems = fmenu ? kids(fmenu) : [], weekly = null;
    r.freqMenuItems = [];
    for (i = 0; i < fitems.length; i++){
      var t = sv(fitems[i], 'AXTitle');
      r.freqMenuItems.push(t);
      if (t.toLowerCase() === 'weekly') weekly = fitems[i]; }
    if (weekly !== null){ press(weekly); sleep(2.0); }
    r.freqAfter = sv(pops[0], 'AXValue'); }

  // 3. THE READ THE PROBE MAKES, in the state the drive makes it.
  shell = shellOf(app);
  r.afterRoles = [];
  sk = kids(shell);
  for (i = 0; i < sk.length; i++) r.afterRoles.push(sv(sk[i], 'AXRole'));
  var groups = byRole(shell, 'AXGroup');
  r.groupCount = groups.length;
  r.groupDump = [];
  if (groups.length) dump(groups[0], 0, r.groupDump, 1);
  r.groupPopUps = groups.length ? byRole(groups[0], 'AXPopUpButton').length : 0;
  r.groupStaticTexts = groups.length ? byRole(groups[0], 'AXStaticText').length : 0;
  r.enhAtEnd = sv(app, 'AXEnhancedUserInterface');
  console.log(JSON.stringify(r, null, 1));
}
JXA

echo "===== RAW: the sheet after a frequency has been selected ====="
osascript -l JavaScript "$HOME/things-lab/census.js" 2>&1 | tee "$OUT/census.json"

echo ""
echo "===== SYSTEM EVENTS: the same sheet, the same moment ====="
osascript -e 'tell application "System Events" to tell process "Things3" to tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to get role of UI elements' 2>&1 | head -c 400
echo ""
osascript -e 'tell application "System Events" to tell process "Things3" to tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to tell group 1 to get {name, value} of pop up buttons' 2>&1 | head -c 600
echo ""
osascript -e 'tell application "System Events" to tell process "Things3" to tell (first window whose subrole is "AXStandardWindow") to tell sheet 1 to tell group 1 to get value of static texts' 2>&1 | head -c 600
echo ""

osascript -e 'tell application "System Events" to key code 53' >/dev/null 2>&1
sleep 1
osascript -e 'tell application "System Events" to key code 53' >/dev/null 2>&1
exit 0
