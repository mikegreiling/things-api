/**
 * RAWAX1 — the Repeat drive's Accessibility primitives, spoken directly.
 *
 * WHAT THIS REPLACES, AND WHY. Every hop of the Repeat drive has always reached
 * the Accessibility tree through System Events: `osascript` sends an Apple
 * event, System Events makes the AX call, the answer comes back the same way.
 * RDLAT2 fitted that round-trip at **~47 ms on the maintainer's M1** and the
 * drive makes 88 of them, which is ~4.1 s of a measured 6.9 s. The SAME calls
 * made in-process through the ObjC bridge cost **0.12 ms** there (VOPAT1's field
 * law) — and the dialog is 12–22 controls wide with content reads costing what
 * geometry reads cost, so there is no realization term hiding behind the
 * transport (RDLAT2 §E.2). The drive is not slow because it asks too much. It is
 * slow because of who it asks through.
 *
 * WHAT IS NOT RE-DERIVED. Every certified address survives the change of
 * transport unaltered, which RAWAX1 §5.1 measured rather than assumed:
 *
 *  - the role-filtered `AXChildren` ordinal IS System Events' `<class> N` index,
 *    in all five dialog states (**RAWAX1-1**) — so `DIALOG_ENDS` is still group
 *    pop-up 1, `DIALOG_NEXT_POPUP` still 2, the weekday base still 3, and the
 *    monthly/yearly anchors still 3/4 and 3/4/5;
 *  - the HXPC1/CGRD1 label-row discrimination reproduces on the DELTA between a
 *    label's y and its field's, not on the absolute y — which differs with the
 *    sheet's origin (the start-offset field read 439 against labels at 443 where
 *    CGRD1 §B published 409/413). {@link ROW_TOLERANCE_DEFAULT} is that delta's
 *    fence and is unchanged.
 *
 * WHAT DOES NOT PORT, MEASURED. Two primitives, and they are the two the
 * campaign predicted would fail:
 *
 *  - **a numeric field's `AXValue` write is a REPAINT** (**RAWAX1-2**). The API
 *    reports the attribute settable, the write returns `AXError 0`, the control
 *    displays the new number, the occurrence preview never recomputes and the
 *    COMMITTED rule is the one the field held before. So UIC6's finding is a
 *    property of the AX write itself rather than of System Events' spelling of
 *    it, and the typing loop survives entire — focus, prove focus, keystroke,
 *    Tab-commit, read back, retry, and BEEP1's reason for sending no ⌘A.
 *  - **a row's `AXSelected` write is refused** (`-25201`), so `select-row` keeps
 *    System Events' `select` ACTION, which is a different verb and the one
 *    UIC4-a certified.
 *
 * THE COUNTERS ARE THE SAME TWO (RDLAT2 §E / harness.md §Cost law): raw AX calls
 * made, and ELEMENTS whose CONTENT was touched. A clone's wall time transfers to
 * nothing; those two transfer to every host.
 */
import { POINTER_GUARD_AX_HELPERS } from "./ui-pointer-guard.ts";

/**
 * Row tolerance in points for every LABEL-ANCHORED address — how far a control's
 * y may sit from its label's y and still count as the same row.
 *
 * Deliberately the same 8 as `ui.ts`'s `ROW_TOLERANCE`, and for the same measured
 * reason: CGRD1 §A found a 3–4 pt baseline offset (`Every`@286 / interval@283,
 * `Ends:`@375 / count@372, `days earlier`@413 / offset@409) against a ~45 pt row
 * pitch. RAWAX1 §5.1 re-measured the same deltas through the raw API on a sheet
 * at a different origin, which is what makes the DELTA the invariant and the
 * absolute y not one.
 */
export const ROW_TOLERANCE_DEFAULT = 8;

/**
 * The marker every rendered raw-AX script carries, so a test can assert a script
 * came out of this generator rather than pattern-matching its body.
 */
export const RAWAX_MARKER = "rawAxRun";

/**
 * What a refused op raises, so node can tell an op's own fail-closed refusal
 * from a script that died. The same discipline as `GUARD_REFUSED_TAG` and
 * `COMMIT_FAILED_TAG`: a machine tag in the script, the SENTENCE in TypeScript,
 * so there is exactly one wording of every refusal and it cannot drift.
 */
export const RAWAX_REFUSED_TAG = "#RAWAXREFUSE";

/**
 * THE PRIMITIVE LAYER, as JXA source.
 *
 * It builds on {@link POINTER_GUARD_AX_HELPERS} rather than restating it — that
 * block already defines `attr`, `sv`, `rectOf`, `frame`, `kids`, `sleep` and the
 * `AXN`/`AXR` counters, and two copies of a frame reader is how two copies drift
 * (its own comment says so; `ui-drag.ts` is the precedent).
 *
 * ONE THING IT DELIBERATELY DOES NOT REUSE: the helpers' `appEl()`, which
 * resolves Things' pid through `Application('System Events').processes` — one
 * Apple event to System Events, which is the exact cost this module exists to
 * remove. `rawAppEl()` resolves the same pid through `NSRunningApplication`,
 * in-process, for zero events.
 */
export const RAWAX_HELPERS = `${POINTER_GUARD_AX_HELPERS}
/*
 * THE APPLICATION ELEMENT, WITHOUT AN APPLE EVENT. The shared helpers reach it
 * through System Events' process list; this reaches it through
 * NSRunningApplication, which is in-process and free. Everything hangs off it.
 */
var RAWAX_BUNDLE = 'com.culturedcode.ThingsMac';
function rawAppEl(){
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(RAWAX_BUNDLE);
  if (!apps || Number(apps.count) === 0) return null;
  return $.AXUIElementCreateApplication(Number(apps.objectAtIndex(0).processIdentifier)) }

/*
 * ABSENT READS AS "" — AND THIS IS NOT COSMETIC (RAWAX1 §6.2, and a ruling).
 *
 * A batched AXUIElementCopyMultipleAttributeValues returns an ERROR PLACEHOLDER
 * object in the slot of every attribute the element does not have, and a naive
 * String() renders that "[object NSObject]". AppleScript's cgTexts maps
 * \`missing value\` to "", so the settle's shape SIGNATURE — which BEEP1
 * certified and which the two-agreeing-reads gate compares — is byte-identical
 * only if this does the same. Numbers and booleans DO stringify: a checkbox's
 * value is 0/1 and the signature carries it.
 */
function rawStr(j){
  if (j === null || j === undefined) return '';
  if (typeof j === 'string') return j;
  if (typeof j === 'number' || typeof j === 'boolean') return String(j);
  return '' }
function rawSv(el, name){ var v = attr(el, name); if (!v) return '';
  try { return rawStr(v.js) } catch(e){ return '' } }
function rawBool(el, name){ var v = attr(el, name); if (v === null) return null;
  try { return v.js === true || String(v.js) === 'true' || String(v.js) === '1' } catch(e){ return null } }

/*
 * ONE ROUND-TRIP PER NODE. The batched read is the raw form of the plural
 * AppleScript property RDLAT2 §4(a) reduced the cadence scan to — same
 * information, one call, and here it costs 0.09 ms rather than 6. Content
 * attributes count as REALIZED (AXR); geometry and role do not, because the app
 * answers those out of the layout it already holds.
 */
var RAWAX_NODE_ATTRS = $(['AXRole','AXSubrole','AXTitle','AXDescription','AXValue',
  'AXIdentifier','AXEnabled','AXFocused','AXPosition','AXSize']);
function rawNode(el){ AXN++; AXR++;
  var out = Ref();
  if ($.AXUIElementCopyMultipleAttributeValues(el, RAWAX_NODE_ATTRS, 0, out) !== 0) return null;
  var a = ObjC.castRefToObject(out[0]);
  if (!a || Number(a.count) < 10) return null;
  function s(i){ var v = a.objectAtIndex(i); if (!v) return '';
    try { return rawStr(v.js) } catch(e){ return '' } }
  var f = null; try { f = rectOf(a.objectAtIndex(8), a.objectAtIndex(9)) } catch(e){ f = null }
  return { role:s(0), subrole:s(1), title:s(2), desc:s(3), value:s(4),
           id:s(5), enabled:s(6), focused:s(7), frame:f } }

/* GEOMETRY ONLY — free on both hosts, and it realizes nothing. */
function rawGeom(el){ return frame(el) }

function rawActions(el){ AXN++;
  var out = Ref();
  if ($.AXUIElementCopyActionNames(el, out) !== 0) return [];
  var a = ObjC.castRefToObject(out[0]), res = [];
  try { var n = Number(a.count); for (var i=0;i<n;i++) res.push(String(a.objectAtIndex(i).js)) }
  catch(e){ return [] }
  return res }
function rawPress(el, action){ AXN++;
  return $.AXUIElementPerformAction(el, $(action || 'AXPress')) }
function rawSet(el, name, value){ AXN++;
  return $.AXUIElementSetAttributeValue(el, $(name), value) }
/*
 * A BOOLEAN, ENCODED AS ONE — and AXError 0 does not prove that it was.
 *
 * \`$.kCFBooleanTrue\` is exposed by the JXA bridge as a FUNCTION, not a value
 * (measured: \`typeof $.kCFBooleanTrue === 'function'\`, String() gives
 * '[object Ref]'). Passing it to AXUIElementSetAttributeValue marshals a
 * function object, the call returns **AXError 0**, and the app does nothing —
 * which is how RAWAX1 phase 0 recorded it as the working encoding and phase 2's
 * routed arm found that no drive could ever type. The read-back was saying so
 * the whole time; a zero return code was believed over it.
 *
 * \`$(true)\` and NSNumber.numberWithBool both give a real __NSCFBoolean, which
 * is what a CFBooleanRef attribute wants. The lesson is worth more than the
 * line: on this bridge a success code proves the CALL was made, never that the
 * VALUE arrived, so an attribute write is only believed once something reads it
 * back.
 */
function rawSetBool(el, name, want){
  return rawSet(el, name, $(want ? true : false)) }

function rawKidsByRole(el, role){ var out = [], ch = kids(el);
  for (var i=0;i<ch.length;i++) if (rawSv(ch[i],'AXRole') === role) out.push(ch[i]);
  return out }

/*
 * THE DIALOG SHELL, in the SAME priority order the shipped pathCandidates use
 * (UIC4-a): the attached AXSheet on the standard window when Things is
 * frontmost, then the detached top-level AXUnknown window that is not the 40x40
 * utility window. It returns the shell's INDEX in that order, which is the same
 * number the \`dialog-open\` snapshot banks as \`shellIndex\`.
 */
function rawWindows(app){ var c = attr(app,'AXWindows'); if (!c) return kids(app);
  var a = []; try { var n = Number(c.count); for (var i=0;i<n;i++) a.push(c.objectAtIndex(i)) }
  catch(e){ return kids(app) }
  return a }
function rawMainWindow(app){ var ws = rawWindows(app);
  for (var i=0;i<ws.length;i++) if (rawSv(ws[i],'AXSubrole') === 'AXStandardWindow') return ws[i];
  return null }
function rawShell(app){ var ws = rawWindows(app), i, k;
  for (i=0;i<ws.length;i++){
    if (rawSv(ws[i],'AXSubrole') !== 'AXStandardWindow') continue;
    var ch = kids(ws[i]);
    for (k=0;k<ch.length;k++) if (rawSv(ch[k],'AXRole') === 'AXSheet')
      return { el: ch[k], form: 'attached', index: 0 } }
  for (i=0;i<ws.length;i++){
    if (rawSv(ws[i],'AXSubrole') !== 'AXUnknown') continue;
    var f = rawGeom(ws[i]);
    if (!f || !(f.w === 40 && f.h === 40)) return { el: ws[i], form: 'detached', index: 1 } }
  return null }
function rawGroup(shellEl){ var g = rawKidsByRole(shellEl,'AXGroup'); return g.length ? g[0] : null }

/*
 * THE CADENCE SNAPSHOT — the input to every label-row discrimination the drive
 * makes (AX_CADENCE_HANDLERS' cgSnap, in raw form). One AXChildren plus one
 * batched node per child, against four plural Apple events; measured 1.4 ms
 * against 24 ms on the clone, and the field pays each of those four ~47 ms.
 */
function rawSnap(container){
  var ch = kids(container), statics = [], fields = [], i;
  for (i=0;i<ch.length;i++){
    var role = rawSv(ch[i],'AXRole');
    if (role !== 'AXStaticText' && role !== 'AXTextField') continue;
    var n = rawNode(ch[i]);
    if (n === null) continue;
    var rec = { el: ch[i], value: n.value, y: n.frame ? n.frame.y : -1000000 };
    if (role === 'AXStaticText') statics.push(rec); else fields.push(rec) }
  return { statics: statics, fields: fields, reads: statics.length + fields.length } }

/* The y of the LAST static text whose value is exactly \`want\` — cgLabelY's rule,
 * last-wins included, so a signature built here matches one built there. */
function rawLabelY(snap, want){ var y = null;
  for (var i=0;i<snap.statics.length;i++) if (snap.statics[i].value === want) y = snap.statics[i].y;
  return y }
/* The INDEXES of the numeric fields that do (or do not) share row \`y\` — cgOnRow. */
function rawOnRow(snap, y, tol, want){ var hits = [];
  for (var i=0;i<snap.fields.length;i++){
    var dy = snap.fields[i].y - y; if (dy < 0) dy = -dy;
    if ((dy <= tol) === want) hits.push(i) }
  return hits }
function rawInventory(snap){ var inv = '';
  for (var i=0;i<snap.fields.length;i++)
    inv += ' #' + (i+1) + '(y=' + snap.fields[i].y + ',shows=' + snap.fields[i].value + ')';
  return inv === '' ? ' (none)' : inv }
/* cgSig — the shape signature the settle compares, in cgSig's own format, which
 * is what makes the settle's behavior unchanged across the transport. */
function rawSig(snap){ var s = '', i;
  for (i=0;i<snap.statics.length;i++) s += '|s:' + snap.statics[i].value;
  for (i=0;i<snap.fields.length;i++) s += '|f:' + snap.fields[i].y;
  return s }
/* cgMatches — the shape manifest's advisory check, unchanged. */
function rawMatches(snap, wantFields, need, forbid){
  var i;
  if (wantFields < -1) return false;
  if (wantFields > -1 && snap.fields.length !== wantFields) return false;
  for (i=0;i<need.length;i++) if (rawLabelY(snap, need[i]) === null) return false;
  for (i=0;i<forbid.length;i++) if (rawLabelY(snap, forbid[i]) !== null) return false;
  return true }

/*
 * cgField — the HXPC1/CGRD1 addressing law, unchanged, computed off the snapshot:
 * the ends count REQUIRES the \`Ends:\` label; the interval is matched POSITIVELY
 * on the \`Every\` row wherever the app offers one; an after-completion group
 * carries NEITHER label and falls to a uniqueness check, which is not an index.
 * Anything else fails closed reporting the whole numeric-field inventory.
 */
function rawField(snap, target, tol){
  var endsY = rawLabelY(snap, 'Ends:'), everyY = rawLabelY(snap, 'Every'), hits;
  if (target === 'ends-count'){
    if (endsY === null) throw new Error('the Repeat dialog\\'s cadence group carries no "Ends:" label, so the ends-after count field cannot be identified — numeric fields:' + rawInventory(snap));
    hits = rawOnRow(snap, endsY, tol, true);
    if (hits.length !== 1) throw new Error('the Repeat dialog offers ' + hits.length + ' field(s) on the "Ends:" row, expected exactly 1 — numeric fields:' + rawInventory(snap));
    return snap.fields[hits[0]] }
  if (everyY !== null){
    hits = rawOnRow(snap, everyY, tol, true);
    if (hits.length !== 1) throw new Error('the Repeat dialog offers ' + hits.length + ' field(s) on the "Every" row, expected exactly 1 — numeric fields:' + rawInventory(snap));
    return snap.fields[hits[0]] }
  if (endsY !== null){
    hits = rawOnRow(snap, endsY, tol, false);
    if (hits.length !== 1) throw new Error('the Repeat dialog offers ' + hits.length + ' field(s) off the "Ends:" row, expected exactly 1 — numeric fields:' + rawInventory(snap));
    return snap.fields[hits[0]] }
  if (snap.fields.length !== 1) throw new Error('the Repeat dialog\\'s cadence group carries neither an "Every" nor an "Ends:" label and offers ' + snap.fields.length + ' numeric field(s), so the interval cannot be identified — numeric fields:' + rawInventory(snap));
  /* Reached ONLY past the uniqueness proof above, so this is a statement about
   * the group holding exactly one field and not an index (CGRD1 §A law 2). */
  return snap.fields[0] }

/* rfField — the same law for a field on the dialog SHELL (the start-offset). */
function rawRowField(snap, rowLabel, tol){
  var y = rawLabelY(snap, rowLabel);
  if (y === null) throw new Error('the Repeat dialog shows no "' + rowLabel + '" label, so the field beside it cannot be identified — text fields:' + rawInventory(snap));
  var hits = rawOnRow(snap, y, tol, true);
  if (hits.length !== 1) throw new Error('the Repeat dialog offers ' + hits.length + ' field(s) on the "' + rowLabel + '" row, expected exactly 1 — text fields:' + rawInventory(snap));
  return snap.fields[hits[0]] }

/*
 * A POP-UP'S MENU is a CHILD of the pop-up, and a closed pop-up has NO children
 * at all (RAWAX1 §5.3) — so "is the menu open" is one AXChildren read and needs
 * no title match, where the shipped script asks \`exists menu 1\` once per 50 ms
 * round. AXPress opens it in 12.4 ms, measured.
 */
function rawMenuOf(pu){ var ch = kids(pu);
  for (var i=0;i<ch.length;i++) if (rawSv(ch[i],'AXRole') === 'AXMenu') return ch[i];
  return null }
function rawMenuItem(menu, title){
  /* An EXACT match, and never a wildcard: the frequency menu carries an
   * empty-titled SEPARATOR (measured), so "" must match nothing. */
  if (title === '') return null;
  var items = kids(menu);
  for (var i=0;i<items.length;i++) if (rawSv(items[i],'AXTitle') === title) return items[i];
  return null }
function rawMenuTitles(menu){ var items = kids(menu), out = [];
  for (var i=0;i<items.length;i++) out.push(rawSv(items[i],'AXTitle'));
  return out }
/* The \`More…\` cascade is ALREADY POPULATED — an AXChildren AXMenu with 102
 * items, no click needed (RAWAX1 §5.8), which removes the shipped script's
 * try-then-click-then-wait-0.5 s ladder outright. */
function rawSubmenu(item){ return rawMenuOf(item) }

/*
 * THE MENU BAR answers with the menu CLOSED (RAWAX1 §5.6): the Items menu's
 * items are populated in the raw tree and AXEnabled is truthful, so nothing
 * needs provoking and the eligibility assert's menu half is one read.
 */
function rawMenuBarItem(app, path){
  var bar = attr(app,'AXMenuBar'); if (!bar) return null;
  var cur = bar, i, k;
  for (i=0;i<path.length;i++){
    var items = kids(cur), hit = null;
    for (k=0;k<items.length && hit === null;k++) if (rawSv(items[k],'AXTitle') === path[i]) hit = items[k];
    if (hit === null) return null;
    if (i === path.length - 1) return hit;
    var sub = rawMenuOf(hit); if (sub === null) return null;
    cur = sub }
  return null }

/*
 * THE DATE AREAS, and the SAME deterministic discriminator the shipped bridge
 * uses (ANCH2, shared with axSetDateTimeScript so the write and the read can
 * never disagree about which area is which): \`reminder\` is the only area
 * carrying a time-of-day, \`next\` is the top midnight picker, \`ends\` the bottom.
 */
function rawCollect(el, role, depth, out){ if (depth < 0) return;
  if (rawSv(el,'AXRole') === role) out.push(el);
  var ch = kids(el); for (var i=0;i<ch.length;i++) rawCollect(ch[i], role, depth-1, out) }
function rawTimeOfDay(el){ var v = attr(el,'AXValue'); if (!v) return -1;
  var cal = $.NSCalendar.currentCalendar;
  return cal.componentFromDate($.NSCalendarUnitHour, v) * 60 + cal.componentFromDate($.NSCalendarUnitMinute, v) }
function rawPosY(el){ var f = rawGeom(el); return f ? f.y : 0 }
function rawPickArea(areas, target){
  if (areas.length === 0) return null;
  var sorted = areas.slice().sort(function(a,b){ return rawPosY(a) - rawPosY(b) });
  if (target === 'reminder'){
    var timed = sorted.filter(function(a){ return rawTimeOfDay(a) > 0 });
    return timed.length ? timed[timed.length-1] : sorted[sorted.length-1] }
  var midnight = sorted.filter(function(a){ return rawTimeOfDay(a) === 0 });
  if (midnight.length === 0) midnight = sorted;
  return target === 'ends' ? midnight[midnight.length-1] : midnight[0] }
function rawAreaInv(areas){ var s = [];
  for (var i=0;i<areas.length;i++) s.push('#'+i+'(y='+Math.round(rawPosY(areas[i]))+',tod='+rawTimeOfDay(areas[i])+')');
  return areas.length ? s.join(' ') : '(none)' }
function rawStampOf(d){ var cal = $.NSCalendar.currentCalendar;
  return cal.componentFromDate($.NSCalendarUnitYear, d) + '-' +
    ('0' + cal.componentFromDate($.NSCalendarUnitMonth, d)).slice(-2) + '-' +
    ('0' + cal.componentFromDate($.NSCalendarUnitDay, d)).slice(-2) }
function rawYmd(el){ var v = attr(el,'AXValue'); if (!v) return null; return rawStampOf(v) }
function rawHm(el){ var v = attr(el,'AXValue'); if (!v) return null;
  var cal = $.NSCalendar.currentCalendar;
  return cal.componentFromDate($.NSCalendarUnitHour, v) + ':' +
    ('0' + cal.componentFromDate($.NSCalendarUnitMinute, v)).slice(-2) }

/*
 * LOCALIZED TITLES, PARSED THE WAY APPLESCRIPT'S \`date\` OPERATOR PARSES THEM.
 *
 * The occurrence menu renders dates localized ("Sun, Jul 12, 2026") and near
 * dates relatively ("Today"), and a first occurrence that parses differently is
 * a series that starts on the wrong day (#625). RAWAX1 §5.8 ran four candidates
 * against fifteen of the app's OWN live menu titles: this format bank agrees
 * with AppleScript's \`date\` on every one of them and on the synthetic corpus;
 * NSDataDetector matches none of them in either spelling; NSAppleScript agrees
 * but costs 2.4x and would put OSA execution inside a brokered script.
 *
 * A title no format matches returns null, which is the RELATIVE-word case the
 * caller resolves against the app's own clock exactly as \`aqRelative\` does —
 * never a best-effort parse.
 */
var RAWAX_DATE_FORMATS = ['EEE, MMM d, yyyy','MMM d, yyyy','MMMM d, yyyy','M/d/yy'];
function rawParseYmd(s){
  if (typeof s !== 'string' || s === '') return null;
  for (var i=0;i<RAWAX_DATE_FORMATS.length;i++){
    var f = $.NSDateFormatter.alloc.init;
    f.locale = $.NSLocale.alloc.initWithLocaleIdentifier('en_US_POSIX');
    f.dateFormat = RAWAX_DATE_FORMATS[i];
    var d = f.dateFromString($(s));
    if (d && !d.isNil()) return rawStampOf(d) }
  return null }
/* aqRelative's rule, resolved against the app's own clock rather than by
 * rebuilding the app's display string. */
var RAWAX_WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function rawRelativeYmd(s){
  var day = 86400;
  if (s === 'Today') return rawStampOf($.NSDate.date);
  if (s === 'Tomorrow') return rawStampOf($.NSDate.dateWithTimeIntervalSinceNow(day));
  if (s === 'Yesterday') return rawStampOf($.NSDate.dateWithTimeIntervalSinceNow(-day));
  for (var i=0;i<7;i++){
    if (s !== RAWAX_WEEKDAYS[i]) continue;
    var cal = $.NSCalendar.currentCalendar;
    for (var k=1;k<=7;k++){
      var cand = $.NSDate.dateWithTimeIntervalSinceNow(k*day);
      /* NSCalendar's weekday is 1-based from Sunday, which is this array's order. */
      if (cal.componentFromDate($.NSCalendarUnitWeekday, cand) === i+1) return rawStampOf(cand) } }
  return null }
function rawTitleYmd(s){ var rel = rawRelativeYmd(s); if (rel !== null) return rel;
  return rawParseYmd(s) }`;
