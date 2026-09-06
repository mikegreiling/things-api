/**
 * RAWAX1 — the op-list EXECUTOR, rendered as one JXA script.
 *
 * {@link renderRawAxScript} emits three things concatenated: the primitive layer
 * ({@link RAWAX_HELPERS}), the program as a JSON literal, and the interpreter
 * below. Nothing about the program is generated TEXT — it is data the
 * interpreter walks — which is what leaves the door open for a deputy-side
 * executor to run the identical list without an `osascript` at all.
 *
 * EVERY CERTIFIED SEMANTIC IS PRESERVED, and each one is named where it lives:
 *
 *  - the CGRD1 §A label-row addressing law, and its fail-closed inventory;
 *  - the BEEP1 two-agreeing-reads settle, with RDLAT2 §E.4's positive
 *    expectation where the manifest can supply one;
 *  - the FGRD1 typing loop — ask for focus, PROVE focus, type, Tab-commit, read
 *    back, retry — which RAWAX1-2 measured must survive, because the attribute
 *    write is a repaint;
 *  - BEEP1's reason for sending no ⌘A (focusing a field selects its whole
 *    content, so typing replaces it);
 *  - the DEFAULTS2 read-back-first skip, two reads a settle apart;
 *  - the CGRD1 pre-commit audit, and RDLAT2 §4(d)'s folded commit;
 *  - the #620 keystroke frontmost law, asserted in the same script as the key.
 *
 * WHAT IS DELIBERATELY NARROWER THAN THE APPLESCRIPT IT REPLACES: the typing
 * loop types DIGITS ONLY. All three fields it can reach are numeric (the cadence
 * interval, the ends-after count, the start-days-earlier offset) and the Move…
 * picker's free-text filter is not part of this drive, so the executor refuses a
 * non-digit value rather than carrying a Unicode keyboard path it would never
 * use. A narrower surface that fails closed beats a general one that is never
 * exercised.
 */
import { POINTER_GUARD_JXA } from "./ui-pointer-guard.ts";
import { RAWAX_HELPERS, RAWAX_MARKER } from "./ui-rawax.ts";
import type { AxProgram } from "./ui-rawax-ops.ts";

/**
 * The digits' virtual key codes, and nothing else.
 *
 * See the module note: every field this executor can type into is numeric, so a
 * value carrying anything else is a compile-time impossibility that fails closed
 * at run time rather than a case to support.
 */
const DIGIT_KEY_CODES = "{'0':29,'1':18,'2':19,'3':20,'4':21,'5':23,'6':22,'7':26,'8':28,'9':25}";

/**
 * The commit-failure tag, character-for-character `ui.ts`'s `COMMIT_FAILED_TAG`.
 *
 * It is duplicated rather than imported because `ui.ts` imports THIS module, and
 * a cycle between the driver and its executor is worse than a literal. A drift
 * test pins the two together — the same idiom the deputy's banned-phrase list
 * uses across the TS/Swift seam, and for the same reason: two constants that can
 * disagree are how a refusal stops being recognized.
 */
export const RAWAX_COMMIT_FAILED_TAG = "#COMMITFAIL";

/** Tab commits a field without firing the dialog's default OK button (UIC6). */
const KEY_TAB = 48;

/**
 * THE INTERPRETER.
 *
 * One `runOp` per op kind, a driver loop that records each op, and an envelope
 * on stdout. Written as ES5 because that is what the JXA bridge accepts.
 */
const RAWAX_INTERPRETER = `
/*
 * THE KEYSTROKE FRONTMOST LAW (#620), in-process.
 *
 * A synthesized key is not addressed at an element — it goes to whatever
 * application owns the screen — so every script that types re-asserts, in the
 * SAME script that will do the typing, that Things is still frontmost. This is
 * \`fgAssertFront\`'s law and its wording; what changes is that the read is
 * NSWorkspace rather than an Apple event to System Events, which is prompt-free
 * and costs nothing (PTRGD1 measured the same read at 0 events).
 */
function rawAssertFront(what){
  var front = ptrFrontApp();
  if (front === null)
    throw new Error('refused to ' + what + ': the frontmost application could not be read, so there is no proof the keystrokes would reach Things — nothing was typed');
  if (front.bundleId !== PTRGD1_BUNDLE){
    var who = front.name || front.bundleId || 'an unidentified application';
    throw new Error('refused to ' + what + ': ' + who + ' is frontmost, not Things — a keystroke goes to whatever owns the screen, so nothing was typed') } }

var RAWAX_DIGITS = ${DIGIT_KEY_CODES};
function rawKey(code){
  var d = $.CGEventCreateKeyboardEvent($(), code, true);
  var u = $.CGEventCreateKeyboardEvent($(), code, false);
  $.CGEventPost($.kCGHIDEventTap, d); sleep(8);
  $.CGEventPost($.kCGHIDEventTap, u); sleep(8) }
/*
 * DIGITS ONLY, and it refuses rather than improvising. A value that is not all
 * digits cannot be typed by this path, and typing PART of it would be worse than
 * refusing — the field would hold a number nobody asked for and the read-back
 * would faithfully confirm it.
 */
function rawType(value, what){
  var i;
  for (i=0;i<value.length;i++) if (RAWAX_DIGITS[value.charAt(i)] === undefined)
    throw new Error('refused to ' + what + ': "' + value + '" is not a number, and this field takes only digits — nothing was typed');
  rawAssertFront(what);
  for (i=0;i<value.length;i++) rawKey(RAWAX_DIGITS[value.charAt(i)]) }

/*
 * ASKING A FIELD FOR FOCUS, AND PROVING IT TOOK.
 *
 * MEASURED, and it is the defect the routed arm caught (RAWAX1 phase 2, first
 * run): writing the ELEMENT's own AXFocused returns AXError 0 and then reads
 * back FALSE — every attempt, every dialog state — so a loop that proves focus
 * by that flag alone never types and the drive refuses with FGRD1's sentence.
 * Phase 0 §5.2 had already seen the read-back come back false and recorded it as
 * the reason to keep the retry loop; what the field-shaped arm added is that the
 * loop can never succeed, because the flag is not how this app reports focus.
 *
 * System Events' set-focused-of-field does work, so the difference
 * is in HOW the request is made rather than in whether the app accepts one. The
 * canonical Accessibility spelling is the APPLICATION's kAXFocusedUIElement, so
 * that is asked first and the element flag second — belt and braces, both of
 * them genuine requests.
 *
 * And focus is PROVEN the way the app is willing to report it: either the
 * element says it is focused, or the application says this element is its
 * focused one. The second is not a weaker check — it is the stronger one, since
 * it is the app naming the element rather than the element naming itself. They
 * are compared by ROLE and FRAME, which is the same disambiguation the drag
 * driver and the pointer guard use, because comparing AXUIElementRefs for
 * identity is not reachable from this bridge.
 *
 * Nothing is typed without one of those two answering yes; that property is
 * unchanged, and it is what makes the retry safe.
 */
function rawSameElement(a, b){
  if (!a || !b) return false;
  if (rawSv(a,'AXRole') !== rawSv(b,'AXRole')) return false;
  var fa = rawGeom(a), fb = rawGeom(b);
  if (fa === null || fb === null) return false;
  var T = 1;
  return Math.abs(fa.x-fb.x) <= T && Math.abs(fa.y-fb.y) <= T &&
         Math.abs(fa.w-fb.w) <= T && Math.abs(fa.h-fb.h) <= T }

function rawAskFocus(el){
  /* The canonical request: the APPLICATION's focused element. */
  var err = rawSet(RAWAX_APP, 'AXFocusedUIElement', el);
  /* And the element's own flag, which some controls honour and this one does
   * not — asked anyway, because it costs one call and it is what the certified
   * AppleScript loop asks for. */
  rawSetBool(el, 'AXFocused', true);
  return err }

function rawFocusProven(el){
  if (rawBool(el, 'AXFocused') === true) return true;
  var focused = attr(RAWAX_APP, 'AXFocusedUIElement');
  return rawSameElement(focused, el) }

/* ------------------------------------------------------------- addressing */

var RAWAX_APP = null, RAWAX_SHELL = null, RAWAX_SHELL_FORM = '';
function rawShellEl(){
  if (RAWAX_SHELL !== null) return RAWAX_SHELL;
  var found = rawShell(RAWAX_APP);
  if (found === null) throw new Error('the Repeat dialog could not be re-read (neither the attached sheet nor the detached repeat editor window resolved)');
  RAWAX_SHELL = found.el; RAWAX_SHELL_FORM = found.form;
  return RAWAX_SHELL }
function rawGroupEl(){
  var g = rawGroup(rawShellEl());
  if (g === null) throw new Error("the Repeat dialog's cadence group did not resolve");
  return g }
function rawContainer(which){ return which === 'group' ? rawGroupEl() : rawShellEl() }

/*
 * RESOLVE AN ElementRef. Every branch is a measured law (ui-rawax-ops.ts), and
 * every one fails closed with the same sentence its AppleScript twin used.
 */
function rawResolve(ref){
  if (ref.at === 'shell') return rawShellEl();
  if (ref.at === 'group') return rawGroupEl();
  if (ref.at === 'menu'){
    var mi = rawMenuBarItem(RAWAX_APP, ref.path);
    if (mi === null) throw new Error('the menu item ' + ref.path.join(' > ') + ' did not resolve');
    return mi }
  if (ref.dateArea !== undefined){
    var areas = [];
    rawCollect(rawShellEl(), 'AXDateTimeArea', 16, areas);
    var dt = rawPickArea(areas, ref.dateArea);
    if (dt === null) throw new Error('set-datetime ' + ref.dateArea + ': this Repeat-dialog state presents ' + areas.length + ' date area(s) [' + rawAreaInv(areas) + '] but none is the ' + ref.dateArea + ' control — the requested first occurrence / bound cannot be set in this dialog shape');
    return dt }
  if (ref.field === 'group'){
    var snap = rawSnap(rawGroupEl());
    RAWAX_ELEMS += snap.reads;
    return rawField(snap, ref.target, ref.tolerance).el }
  if (ref.field === 'shell'){
    var ssnap = rawSnap(rawShellEl());
    RAWAX_ELEMS += ssnap.reads;
    return rawRowField(ssnap, ref.rowLabel, ref.tolerance).el }
  var pool = rawKidsByRole(rawContainer(ref['in']), ref.role);
  if (ref.title !== undefined){
    for (var i=0;i<pool.length;i++) if (rawSv(pool[i],'AXTitle') === ref.title) return pool[i];
    throw new Error('the Repeat dialog offers no ' + ref.role + ' titled "' + ref.title + '"') }
  /* THE ORDINAL (RAWAX1-1): the role-filtered AXChildren index IS System Events'
   * \`<class> N\`, measured in all five dialog states. \`because\` travels with the
   * ref so a refusal can quote the evidence for the index it used. */
  if (pool.length < ref.ordinal)
    throw new Error('the Repeat dialog offers ' + pool.length + ' ' + ref.role + '(s), so #' + ref.ordinal + ' does not exist (' + ref.because + ')');
  return pool[ref.ordinal - 1] }

/*
 * THE SHAPE FORK, APPLIED IN-SCRIPT.
 *
 * A shaped op carries BOTH addresses and the interpreter picks with the verdict
 * \`probe-shape\` just produced. That is what keeps the probe inside the merged
 * hop: the decision is made from a read the executor itself took, so node is
 * not needed BETWEEN the two operations — and node still learns everything,
 * because the verdict rides the envelope and every skipped op reports itself.
 *
 * An op that needs a shape and finds none fails closed with the driver's own
 * sentence, never a guessed index: the two shapes address DIFFERENT controls at
 * the same ordinal, which is the whole reason the probe exists.
 */
var RAWAX_SHAPE_UNPROBED = "the Repeat dialog's shape was never measured, so this control's address is unknown (recipe bug)";
function rawOpRef(o){
  if (o.shapedRef === undefined) return o.ref;
  if (RAWAX_SHAPE === null) throw new Error(RAWAX_SHAPE_UNPROBED);
  var picked = o.shapedRef[RAWAX_SHAPE];
  if (picked === undefined) throw new Error('this step has no drive for the "' + RAWAX_SHAPE + '" Repeat dialog (recipe bug)');
  return picked }
function rawOpBase(o){
  if (o.shapedBase === undefined) return o.base;
  if (RAWAX_SHAPE === null) throw new Error(RAWAX_SHAPE_UNPROBED);
  var picked = o.shapedBase[RAWAX_SHAPE];
  if (picked === undefined) throw new Error('this step has no drive for the "' + RAWAX_SHAPE + '" Repeat dialog (recipe bug)');
  return picked }

/* --------------------------------------------------------------- the ops */

var RAWAX_ELEMS = 0;
var RAWAX_CONFIRMED = {};
var RAWAX_SHAPE = null;
var RAWAX_COMMITTED = false;

/* The BEEP1 settle, and RDLAT2 §E.4's positive expectation where one exists. */
function opSettleGroup(o){
  var sig = '', prev = '<none>', snap = null, matched = false, i;
  var want = o.expect === null ? -2 : (o.expect.fields === null ? -1 : o.expect.fields);
  var need = o.expect === null ? [] : o.expect.requiredLabels;
  var forbid = o.expect === null ? [] : o.expect.forbiddenLabels;
  for (i=0;i<o.reads;i++){
    prev = sig;
    snap = rawSnap(rawGroupEl());
    RAWAX_ELEMS += snap.reads;
    sig = rawSig(snap);
    matched = rawMatches(snap, want, need, forbid);
    if (sig === prev && (want < -1 || matched)) return { verdict:'ok' };
    sleep(o.pollMs) }
  if (want > -2) throw new Error("the Repeat dialog's cadence group never took the shape this step expects — the control the step was about to drive is not the one the dialog is showing; numeric fields:" + rawInventory(snap));
  throw new Error("the Repeat dialog's cadence group is still re-laying out — its shape changed on every read; last seen" + sig) }

/*
 * probe-dialog-shape (RDLG2), and DEFAULTS3's polling form.
 *
 * \`poll\` false is the single round a live sidecar has always generated — and
 * since DEPOBS3 (#736) also what a ROUTED host generates when node absorbed the
 * cadence rebuild over the deputy-hosted ledger. The polling form keeps
 * DEFAULTS3's two-part rule: a POSITIVE verdict, held across two reads a tick
 * apart, and a budget that expires with the shape still moving says \`unsettled\`
 * rather than blaming a redesign.
 */
function shapeVerdictOnce(tol){
  var g = rawGroupEl(), snap = rawSnap(g);
  RAWAX_ELEMS += snap.reads;
  var nextY = rawLabelY(snap, 'Next:'), sig = rawSig(snap), i;
  var pops = rawKidsByRole(g, 'AXPopUpButton');
  for (i=0;i<pops.length;i++){ var pf = rawGeom(pops[i]); sig += '|p:' + (pf ? pf.y : '?') }
  if (nextY === null) return { verdict:'unknown', sig:sig };
  for (i=0;i<pops.length;i++){
    var f = rawGeom(pops[i]); if (!f) continue;
    var dy = f.y - nextY; if (dy < 0) dy = -dy;
    if (dy <= tol) return { verdict:'next-popup', sig:sig } }
  var areas = []; rawCollect(g, 'AXDateTimeArea', 4, areas);
  for (i=0;i<areas.length;i++){
    var af = rawGeom(areas[i]); if (!af) continue;
    var ady = af.y - nextY; if (ady < 0) ady = -ady;
    if (ady <= tol) return { verdict:'legacy', sig:sig } }
  return { verdict:'unknown', sig:sig } }
function opProbeShape(o){
  var res;
  if (!o.poll){
    res = shapeVerdictOnce(o.tolerance);
    if (res.verdict !== 'unknown'){ RAWAX_SHAPE = res.verdict; return { verdict:'ok', shape:res.verdict } }
    throw new Error('its first-occurrence row ("Next:") holds neither an occurrence pop-up nor a date field, so the dialog matched neither known shape — a Things update has redesigned it again; nothing was entered into the rule') }
  var prev = '<none>';
  for (var i=0;i<${40};i++){
    res = shapeVerdictOnce(o.tolerance);
    if (res.verdict !== 'unknown' && res.sig === prev){ RAWAX_SHAPE = res.verdict; return { verdict:'ok', shape:res.verdict } }
    prev = res.sig;
    sleep(100) }
  if (res.verdict === 'unknown')
    throw new Error('its first-occurrence row ("Next:") holds neither an occurrence pop-up nor a date field, so the dialog matched neither known shape — a Things update has redesigned it again; nothing was entered into the rule');
  throw new Error("the Repeat dialog's cadence group never stopped re-laying out, so which control shares its first-occurrence row (\\"Next:\\") could not be measured; nothing was entered into the rule") }

/*
 * select-popup. The pop-up has NO children while closed (RAWAX1 §5.3), so "is
 * the menu open" is one AXChildren read and needs no title match; BEEP1's
 * one-press-per-round cadence is unchanged, and a second press never goes into
 * a menu that is already opening.
 */
function opSelectPopup(o){
  var pu = rawResolve(rawOpRef(o)), menu = null, i;
  for (i=0;i<20 && menu === null;i++){
    menu = rawMenuOf(pu);
    if (menu !== null) break;
    rawPress(pu);
    var dl = Date.now() + 300;
    while (Date.now() < dl && menu === null){ menu = rawMenuOf(pu); if (menu === null) sleep(10) } }
  if (menu === null) throw new Error('the pop-up would not open, so none of the candidate menu items could be reached: ' + o.titles.join(', '));
  /* The menu's items are realized by the title search below, so the whole menu
   * is content-touched however early the match hits (RDLAT2's counting law). */
  var titles = rawMenuTitles(menu);
  RAWAX_ELEMS += titles.length;
  for (i=0;i<o.titles.length;i++){
    var item = rawMenuItem(menu, o.titles[i]);
    if (item === null) continue;
    rawPress(item);
    return { verdict:'ok' } }
  throw new Error('none of the candidate menu items exist: ' + o.titles.join(', ')) }

/* ensure-checkbox (RRD1): read, press ONLY on a mismatch, re-read to confirm. */
function opEnsureCheckbox(o){
  var cb = rawResolve(rawOpRef(o)), want = o.target ? '1' : '0', cur;
  for (var i=0;i<o.attempts;i++){
    cur = rawSv(cb, 'AXValue'); RAWAX_ELEMS += 1;
    if (cur === want) return { verdict: i === 0 ? 'skipped' : 'ok', detail: i === 0 ? 'already ' + (o.target ? 'checked' : 'unchecked') : undefined };
    rawPress(cb);
    sleep(200) }
  cur = rawSv(cb, 'AXValue'); RAWAX_ELEMS += 1;
  if (cur === want) return { verdict:'ok' };
  throw new Error('checkbox did not converge to ' + want + ' after ' + o.attempts + ' attempt(s); still ' + cur) }

/*
 * THE TYPING LOOP (FGRD1 / UIC7 / BEEP1), entire.
 *
 * READ-BACK FIRST (#620 item 7): a field already holding the requested value is
 * left alone and the op reports \`skipped\`. The skip is proven by TWO reads a
 * settle apart, because the one way a matching value can go stale is the UIC7
 * re-layout revert, which lands inside that window — and the pre-commit audit
 * re-reads every control regardless, so a wrongly-skipped field cannot commit.
 *
 * NO SELECT-ALL (BEEP1): asking the field for focus installs the field editor
 * with the whole value selected, so typing replaces it — and the ⌘A that used to
 * open this loop was the macOS alert beep every numeric drive fired.
 *
 * FOCUS IS PROVEN, NOT ASSUMED, and it is waited for POSITIVELY across attempts
 * rather than refused on the first miss (RDLAT2 §7c). RAWAX1 §5.2 measured why
 * that matters here: the raw \`AXFocused\` write returns AXError 0 and reads back
 * FALSE moments later, so a one-shot ask-and-type would have shipped.
 */
function opTypeInto(o){
  var tf = rawResolve(rawOpRef(o)), v = o.value;
  var v0 = rawSv(tf, 'AXValue'); RAWAX_ELEMS += 1;
  if (v0 === v){
    sleep(300);
    var v1 = rawSv(tf, 'AXValue'); RAWAX_ELEMS += 1;
    if (v1 === v) return { verdict:'skipped', detail:'the field already held "' + v + '"' } }
  var gotFocus = false;
  for (var i=0;i<o.attempts;i++){
    rawAssertFront(o.what);
    rawAskFocus(tf);
    sleep(150);
    gotFocus = rawFocusProven(tf);
    if (gotFocus){
      rawType(v, o.what);
      sleep(100);
      rawKey(${KEY_TAB});
      sleep(200);
      var shown = rawSv(tf, 'AXValue'); RAWAX_ELEMS += 1;
      if (shown === v) return { verdict:'ok' } }
    sleep(300) }
  if (!gotFocus) throw new Error('refused to type "' + v + '": the field did not take keyboard focus, so the keystrokes would have gone somewhere else');
  throw new Error('the field did not hold value "' + v + '" after ' + o.attempts + ' attempt(s); last shown: ' + rawSv(tf, 'AXValue')) }

/*
 * converge-weekdays (RRD1): grow the rows to the target count, assign EVERY row
 * from the target set cycling (so a surplus row duplicates rather than keeping a
 * stale weekday — the app stores a SET, so duplicates collapse), then read every
 * row back and require exact set equality.
 */
function opConvergeWeekdays(o){
  var g = rawGroupEl(), k = o.titles.length, base = rawOpBase(o), i, n;
  for (i=0;i<14;i++){
    n = rawKidsByRole(g,'AXPopUpButton').length - base + 1;
    if (n >= k) break;
    var buttons = rawKidsByRole(g,'AXButton');
    if (buttons.length === 0) throw new Error('converge-weekdays: the dialog exposes no weekday row button, so a second weekday cannot be added');
    /* The row-add button is the smaller-x button of a weekday row, resolved from
     * LIVE GEOMETRY rather than a pinned index, because the row buttons
     * enumerate in an unstable order — and RAWAX1 §5.1 measured that its AXTitle
     * is not a string at all, so geometry is the only thing that could work. */
    var best = null, bestX = 1000000;
    for (var b=0;b<buttons.length;b++){
      var bf = rawGeom(buttons[b]);
      if (bf && bf.x < bestX){ bestX = bf.x; best = buttons[b] } }
    if (best === null) throw new Error('converge-weekdays: no weekday row button resolved a frame');
    rawPress(best);
    sleep(500) }
  n = rawKidsByRole(g,'AXPopUpButton').length - base + 1;
  if (n < k) throw new Error('converge-weekdays: the dialog would not grow to ' + k + ' weekday row(s) — it stopped at ' + n);
  for (i=0;i<n;i++){
    var want = o.titles[i % k];
    var pu = rawKidsByRole(g,'AXPopUpButton')[base + i - 1];
    var cur = rawSv(pu,'AXValue'); RAWAX_ELEMS += 1;
    if (cur === want) continue;
    var menu = null;
    for (var t=0;t<20 && menu === null;t++){
      menu = rawMenuOf(pu);
      if (menu !== null) break;
      rawPress(pu);
      var dl = Date.now() + 300;
      while (Date.now() < dl && menu === null){ menu = rawMenuOf(pu); if (menu === null) sleep(10) } }
    if (menu === null) throw new Error('converge-weekdays: the weekday pop-up would not open');
    var item = rawMenuItem(menu, want);
    if (item === null){
      /* No Escape here (#620): a keystroke reaches whatever owns the screen, and
       * this error path is exactly when that is least certain. The open menu is
       * left for the driver's audited cleanup, which is the ONE place an Escape
       * is decided. */
      throw new Error('converge-weekdays: the weekday pop-up offers no item "' + want + '" (the app may not be in English)') }
    rawPress(item);
    sleep(400) }
  var absent = '', strays = '', got = [];
  for (i=0;i<n;i++){
    got.push(rawSv(rawKidsByRole(g,'AXPopUpButton')[base + i - 1],'AXValue'));
    RAWAX_ELEMS += 1 }
  for (i=0;i<k;i++) if (got.indexOf(o.titles[i]) < 0) absent += o.titles[i] + ' ';
  for (i=0;i<got.length;i++) if (o.titles.indexOf(got[i]) < 0) strays += got[i] + ' ';
  if (absent !== '' || strays !== '')
    throw new Error('converge-weekdays: the weekday rows did not converge — missing: ' + absent + '| unexpected: ' + strays);
  return { verdict:'ok' } }

/*
 * set-datetime. Things' date/time controls hold an NSDate that System Events
 * cannot write (UIC6 -10000), so this write was ALWAYS raw — it is the one
 * primitive the port does not change, only relocate. It keeps its read-back: a
 * control can accept the write (err 0) and reject the value.
 */
function opSetDateTime(o){
  var dt = rawResolve({ dateArea:o.target }), cal = $.NSCalendar.currentCalendar, d;
  if (o.spec.indexOf('time:') === 0){
    var cur = attr(dt,'AXValue');
    if (!cur) throw new Error('set-datetime ' + o.target + ': the date/time control has no value to anchor the time on');
    var hm = o.spec.slice(5).split(':');
    d = cal.dateBySettingHourMinuteSecondOfDateOptions(+hm[0], +hm[1], 0, cur, 0) }
  else if (o.spec.indexOf('date:') === 0){
    var ymd = o.spec.slice(5).split('-');
    var comps = $.NSDateComponents.alloc.init;
    comps.year = +ymd[0]; comps.month = +ymd[1]; comps.day = +ymd[2];
    comps.hour = 0; comps.minute = 0; comps.second = 0;
    d = cal.dateFromComponents(comps) }
  else throw new Error('bad datetime spec: ' + o.spec);
  if (!d) throw new Error('could not build date from ' + o.spec);
  var err = rawSet(dt, 'AXValue', d);
  if (err !== 0) throw new Error('set-datetime ' + o.target + ': the control refused the write (AX err=' + err + ')');
  sleep(200);
  RAWAX_ELEMS += 1;
  if (o.spec.indexOf('date:') === 0){
    var got = rawYmd(dt), want = o.spec.slice(5);
    if (got !== want) throw new Error('set-datetime ' + o.target + ' rejected: the control committed ' + (got || '(no value)') + ', not the requested ' + want + ' — the write did not take') }
  else {
    var gott = rawHm(dt), p = o.spec.slice(5).split(':'), wantt = (+p[0]) + ':' + ('0' + (+p[1])).slice(-2);
    if (gott !== wantt) throw new Error('set-datetime ' + o.target + ' rejected: the control committed ' + (gott || '(no value)') + ', not the requested ' + wantt + ' — the write did not take') }
  return { verdict:'ok' } }

/*
 * select-next-occurrence (RDLG2 / NEXTPOP1). Two things the raw tree changes,
 * both measured: the pop-up's value is read FIRST so a first occurrence the rule
 * already produces costs one read rather than a whole menu walk (#620 item 7's
 * discipline, and the field's commonest case), and the \`More…\` CASCADE is
 * already an AXChildren AXMenu — 102 items, no click — which removes the shipped
 * script's try-then-click-then-wait-0.5 s ladder entirely (RAWAX1 §5.8).
 */
function opSelectOccurrence(o){
  var pu = rawResolve(rawOpRef(o));
  var already = rawSv(pu,'AXValue'); RAWAX_ELEMS += 1;
  if (rawTitleYmd(already) === o.iso) return { verdict:'skipped', detail:'the Next: pop-up already showed ' + o.iso };
  var menu = null, i;
  for (i=0;i<20 && menu === null;i++){
    menu = rawMenuOf(pu);
    if (menu !== null) break;
    rawPress(pu);
    var dl = Date.now() + 300;
    while (Date.now() < dl && menu === null){ menu = rawMenuOf(pu); if (menu === null) sleep(10) } }
  if (menu === null) throw new Error('select-next-occurrence: the Next: pop-up would not open');
  var sample = [], levels = 0, cur = menu;
  for (var lvl=0; lvl<o.levels; lvl++){
    levels++;
    var items = kids(cur), titles = rawMenuTitles(cur);
    RAWAX_ELEMS += titles.length;
    for (i=0;i<titles.length;i++){
      if (sample.length < o.sampleItems && titles[i] !== '') sample.push(titles[i]);
      if (rawTitleYmd(titles[i]) === o.iso){
        rawPress(items[i]);
        sleep(400);
        var shown = rawSv(pu,'AXValue'); RAWAX_ELEMS += 1;
        if (shown !== titles[i])
          throw new Error('select-next-occurrence: the Next: pop-up committed "' + shown + '", not the requested "' + titles[i] + '" — the selection did not take');
        return { verdict:'ok' } } }
    if (items.length === 0) break;
    var deeper = rawSubmenu(items[items.length - 1]);
    if (deeper === null) break;
    cur = deeper }
  throw new Error('select-next-occurrence: this Repeat dialog offers only the rule\\'s own upcoming occurrences (and today) as the first occurrence, and ' + o.iso + ' is not one of them — searched ' + levels + ' level(s) of the Next: menu, which opened on "' + already + '" and led with: ' + sample.join(', ') + '. Ask for a date the rule actually produces, or change the rule.') }

/* ------------------------------------------- reading controls back (audit) */

function readControl(c){
  if (c.kind === 'weekdays'){
    var g = rawGroupEl(), pops = rawKidsByRole(g,'AXPopUpButton'), got = [];
    var wbase = c.shapedBase === undefined ? c.weekdayBase : rawOpBase(c);
    for (var i=(wbase - 1); i<pops.length; i++){ got.push(rawSv(pops[i],'AXValue')); RAWAX_ELEMS += 1 }
    return got.join(',') }
  if (c.kind === 'date-area'){
    var dt = rawResolve(c.ref); RAWAX_ELEMS += 1;
    return c.spec.indexOf('date:') === 0 ? rawYmd(dt) : rawHm(dt) }
  var el = rawResolve(rawOpRef(c)); RAWAX_ELEMS += 1;
  var v = rawSv(el,'AXValue');
  if (c.kind === 'occurrence') return rawTitleYmd(v);
  return v }

function controlAgrees(c, observed){
  if (c.kind === 'weekdays'){
    var got = observed === '' ? [] : observed.split(','), i;
    if (got.length === 0) return false;
    for (i=0;i<c.expected.length;i++) if (got.indexOf(c.expected[i]) < 0) return false;
    for (i=0;i<got.length;i++) if (c.expected.indexOf(got[i]) < 0) return false;
    return true }
  return c.expected.indexOf(observed) >= 0 }

function intendedText(c){
  if (c.expectedLabel !== undefined) return c.expectedLabel;
  var out = [];
  for (var i=0;i<c.expected.length;i++) out.push('"' + c.expected[i] + '"');
  return out.join(' or ') }

/*
 * verify-prefill (DEFAULTS2). The arithmetic NOMINATES; this READS and decides.
 * Every failure path confirms NOTHING, which is the safe direction: the setter
 * then runs exactly as it did before this op existed.
 */
/*
 * A control the measured shape excludes is not checked, and not counted — the
 * driver's own onlyShape filter, applied where the verdict actually lives.
 */
function rawControlApplies(c){
  if (c.onlyShape === undefined) return true;
  if (RAWAX_SHAPE === null) throw new Error(RAWAX_SHAPE_UNPROBED);
  return c.onlyShape === RAWAX_SHAPE }

function opVerifyPrefill(o){
  var confirmed = [], missed = [];
  for (var i=0;i<o.controls.length;i++){
    var c = o.controls[i], observed = null;
    if (!rawControlApplies(c)) continue;
    try { observed = readControl(c) } catch(e){ observed = null }
    if (observed !== null && controlAgrees(c, observed)){ confirmed.push(c.prefillKey); RAWAX_CONFIRMED[c.prefillKey] = true }
    else missed.push(c.prefillKey + '=' + (observed === null ? '(unreadable)' : observed)) }
  return { verdict:'ok', confirmed:confirmed, missed:missed } }

/*
 * THE PRE-COMMIT AUDIT (CGRD1), and RDLAT2 §4(d)'s folded commit. Every control
 * is re-read through its OWN discriminated address — the same address its setter
 * wrote through and the same the verify op read through — so the three can never
 * disagree about which control is which. A mismatch names EVERY differing
 * control with both values and commits nothing.
 */
function opAudit(o){
  if (o.expect !== null) opSettleGroup({ expect:o.expect, reads:${40}, pollMs:100 });
  var bad = [];
  for (var i=0;i<o.controls.length;i++){
    var c = o.controls[i], observed = null;
    if (!rawControlApplies(c)) continue;
    try { observed = readControl(c) } catch(e){ observed = '(unreadable)' }
    if (observed === null) observed = '(unreadable)';
    if (!controlAgrees(c, observed))
      bad.push(c.label + ' (intended ' + intendedText(c) + ', dialog shows "' + observed + '")') }
  if (bad.length !== 0)
    throw new Error('the Repeat dialog does not hold what this drive entered — ' + bad.length + ' control(s) differ: ' + bad.join('; '));
  if (o.commit !== null){
    var ok = rawResolve(o.commit);
    var err = rawPress(ok);
    if (err !== 0) throw new Error('${RAWAX_COMMIT_FAILED_TAG} the OK button would not press (AX err=' + err + ')');
    RAWAX_COMMITTED = true }
  return { verdict:'ok' } }

/* ------------------------------------------------------------ the driver */

function runOp(o){
  switch (o.op){
    case 'census-shell': {
      var shellEl = rawShellEl(), roles = [], ch = kids(shellEl);
      for (var i=0;i<ch.length;i++) roles.push(rawSv(ch[i],'AXRole'));
      return { verdict:'ok', detail:roles.join(',') } }
    case 'probe-shape': return opProbeShape(o);
    case 'settle-group': return opSettleGroup(o);
    case 'select-popup': return opSelectPopup(o);
    case 'ensure-checkbox': return opEnsureCheckbox(o);
    case 'type-into': return opTypeInto(o);
    case 'converge-weekdays': return opConvergeWeekdays(o);
    case 'set-datetime': return opSetDateTime(o);
    case 'select-occurrence': return opSelectOccurrence(o);
    case 'verify-prefill': return opVerifyPrefill(o);
    case 'audit': return opAudit(o);
  }
  throw new Error('unknown op: ' + o.op) }

function ${RAWAX_MARKER}(){
  RAWAX_APP = rawAppEl();
  if (RAWAX_APP === null) return { ok:false, detail:'Things is not running', ops:[], axCalls:0, axElems:0 };
  /*
   * THE SHAPE NODE ALREADY MEASURED (RAWAX1 phase 2, second defect).
   *
   * A merged hop that contains no probe still ADDRESSES shape-forked controls —
   * the committing tail holds the occurrence pick and the audit — and the fork
   * is resolved against RAWAX_SHAPE. That variable is per-SCRIPT, so a tail hop
   * started it at null and every onlyShape op refused with the recipe-bug
   * sentence, which is a true statement about this script and a false one about
   * the drive: node measured the shape one hop earlier and passed it in.
   *
   * So the program's own field seeds it. A hop that probes overwrites it with
   * what it measured; a hop that does not inherits what node knew. Null still
   * means genuinely unmeasured, and still refuses.
   */
  if (RAWAX_PROGRAM.shape === 'next-popup' || RAWAX_PROGRAM.shape === 'legacy') {
    RAWAX_SHAPE = RAWAX_PROGRAM.shape }
  /*
   * AND THE PRE-FILL VERDICTS IT ALREADY HOLDS (DEFAULTS2), for the same reason
   * and by the same route. RAWAX_CONFIRMED is per-SCRIPT too, so a tagged setter
   * that lands in a LATER hop than the verify op that confirmed it would run
   * anyway — measured on run 4's daily cell, where the occurrence step dispatched
   * in the committing tail and only its own idempotence guard stopped it. Every
   * such op is self-guarding, so nothing wrong was ever driven; but the drive
   * paid for a decision it had already made, and the AppleScript transport
   * skipped what this one ran. Seeding closes both gaps.
   */
  if (RAWAX_PROGRAM.confirmed) {
    for (var ci=0;ci<RAWAX_PROGRAM.confirmed.length;ci++) RAWAX_CONFIRMED[RAWAX_PROGRAM.confirmed[ci]] = true }
  var records = [], i;
  for (i=0;i<RAWAX_PROGRAM.ops.length;i++){
    var o = RAWAX_PROGRAM.ops[i];
    /* ALREADY PRE-FILLED, AND READ BACK TO PROVE IT (DEFAULTS2). The op stays in
     * the list — it still contributes its control to the audit — but its
     * ACTUATION is unnecessary, because the verify op read this very control
     * through this very address and found the value. */
    if (o.unlessPrefilled !== undefined && RAWAX_CONFIRMED[o.unlessPrefilled] === true){
      records.push({ label:o.label, op:o.op, durationMs:0, axCalls:0, axElems:0,
                     verdict:'skipped', detail:'pre-filled' });
      continue }
    /* SHAPE-GATED (RDLG2): the recipe emits BOTH the legacy and the 3.23 drive
     * for a control whose CLASS changed, and only the matching one runs. With
     * the probe inside this hop the verdict is already in hand. */
    if (o.onlyShape !== undefined){
      if (RAWAX_SHAPE === null){
        records.push({ label:o.label, op:o.op, durationMs:0, axCalls:0, axElems:0,
                       verdict:'refused', detail:RAWAX_SHAPE_UNPROBED });
        return { ok:false, failedAt:o.label, detail:RAWAX_SHAPE_UNPROBED, ops:records,
                 axCalls:AXN, axElems:RAWAX_ELEMS, shape:RAWAX_SHAPE, committed:RAWAX_COMMITTED } }
      if (o.onlyShape !== RAWAX_SHAPE){
        records.push({ label:o.label, op:o.op, durationMs:0, axCalls:0, axElems:0,
                       verdict:'skipped', detail:'not this dialog shape' });
        continue } }
    var t0 = Date.now(), c0 = AXN, e0 = RAWAX_ELEMS, res;
    try { res = runOp(o) }
    catch (err) {
      records.push({ label:o.label, op:o.op, durationMs:Date.now()-t0,
                     axCalls:AXN-c0, axElems:RAWAX_ELEMS-e0, verdict:'refused',
                     detail:String(err && err.message ? err.message : err) });
      return { ok:false, failedAt:o.label,
               detail:String(err && err.message ? err.message : err),
               ops:records, axCalls:AXN, axElems:RAWAX_ELEMS,
               shape:RAWAX_SHAPE, committed:RAWAX_COMMITTED } }
    var rec = { label:o.label, op:o.op, durationMs:Date.now()-t0,
                axCalls:AXN-c0, axElems:RAWAX_ELEMS-e0, verdict:res.verdict };
    if (res.detail !== undefined) rec.detail = res.detail;
    if (res.shape !== undefined) rec.shape = res.shape;
    if (res.confirmed !== undefined) rec.confirmed = res.confirmed;
    if (res.missed !== undefined && res.missed.length) rec.missed = res.missed;
    records.push(rec) }
  var confirmed = [];
  for (var k in RAWAX_CONFIRMED) if (RAWAX_CONFIRMED[k] === true) confirmed.push(k);
  return { ok:true, ops:records, axCalls:AXN, axElems:RAWAX_ELEMS,
           shape:RAWAX_SHAPE, confirmed:confirmed, committed:RAWAX_COMMITTED } }

JSON.stringify(${RAWAX_MARKER}())`;

/**
 * Render one raw-AX hop: the primitives, the pointer/keystroke guard, the
 * program as data, and the interpreter.
 *
 * The program is `JSON.stringify`d rather than templated into code, which is
 * what makes "the recipe layer is transport-agnostic" true rather than
 * aspirational — the same bytes could be handed to a Swift executor.
 */
export function renderRawAxScript(program: AxProgram): string {
  return `${RAWAX_HELPERS}
${POINTER_GUARD_JXA}
var RAWAX_PROGRAM = ${JSON.stringify(program)};
${RAWAX_INTERPRETER}`;
}
