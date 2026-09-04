/**
 * PTRGD1 — THE PRE-GESTURE POINTER GUARD.
 *
 * Every keystroke this vector synthesizes re-asserts, in the same osascript hop
 * that will do the typing, that Things owns the screen ({@link
 * AX_FOCUS_GUARD_HANDLERS}, issue #620). The synthesized POINTER gestures did
 * not, and they are the more dangerous half: a keystroke that leaks lands in a
 * foreign text field, while a leaked drag moves a foreign application's files.
 *
 * The hazard is structural, not hypothetical. Every mouse event this package
 * posts goes to `kCGHIDEventTap` at a SCREEN COORDINATE derived from an
 * AX-resolved frame, and AX frames resolve perfectly well for a window that is
 * in the background, half-covered, or on another Space. So between the census
 * that read the frame and the gesture that uses it, the user can ⌘-Tab away,
 * drag a window over the sidebar, take a notification banner, or lock the
 * screen — and the gesture then lands in whatever is under the pointer: a text
 * drag-select in another app, a Finder file move, a torn-off browser tab. On the
 * maintainer's M1 one sidebar census takes 16–18 s, so that window is seconds
 * wide, every time.
 *
 * THE LAW, asserted in the SAME script as the first HID event (never a second
 * osascript hop — the hop boundary is the gap being closed):
 *
 *  1. FRONTMOST. Things is the frontmost application, by bundle identifier. Same
 *     law and same refusal-sentence family as the keystroke guard: fail closed,
 *     and name the application that owns the screen instead — never the contents
 *     of its window.
 *  2. CONTAINMENT. Things' own window frame contains every point the gesture
 *     will visit. A straight-line drag visits its two endpoints; a click visits
 *     one.
 *  3. OCCLUSION. Nothing of another application's is between the pointer and
 *     Things at any of those points, established two ways that must BOTH agree
 *     (see the measurement note below).
 *  4. IDENTITY. The element under the grab point still belongs to the surface
 *     the caller aimed at — the same-app half, which occlusion cannot see: after
 *     a user scroll the sidebar row at those coordinates is a DIFFERENT row, and
 *     the drag driver's own invariants (area count + assignment digest) do not
 *     notice a to-do being dragged into another list.
 *
 * Plus, for a held drag, the same assertion again at DROP time — the gesture
 * itself takes seconds, and a window can arrive during it. A failed re-check
 * Escape-aborts the held drag (AXDRAG1-d's byte-identical abort vector) rather
 * than dropping.
 *
 * FAIL DIRECTION: over-caution, deliberately. A false refusal from an
 * always-on-top overlay names the culprit and costs a re-run; a false pass moves
 * someone's files. Nothing is posted on refusal.
 *
 * WHAT THIS IS *NOT* — the HARDEN1 line (#627). Every pointer-class hop already
 * runs a drive-level frontmost/focus census one hop earlier (`POINTER_CLASS` in
 * {@link guardedRun}), and that census stays: it is what produces the refusal a
 * caller reads for the ordinary "you ⌘-Tabbed away before the command started"
 * case, and it is what latches the dialog invariant. Four things it cannot do,
 * which are exactly this guard's four:
 *
 *   - it runs in a SEPARATE osascript hop, so its verdict is already stale by
 *     the time the gesture goes out — on the maintainer's M1 a sidebar census
 *     alone is 16–18 s, and the gesture is planned against frames from it;
 *   - "Things is frontmost" is not "this point is not covered" — a frontmost
 *     window can still be under a floating panel, a notification banner or
 *     another Space's overlay at the exact pixel being aimed at;
 *   - it says nothing about WHICH element the coordinates now hit, and a
 *     same-app mis-target is invisible to the drag driver's own invariants;
 *   - it happens before the gesture, never during it, so a held drag that runs
 *     for seconds has no drop-time check at all.
 *
 * PROMPT-FREE (permissions doctrine). `NSWorkspace.frontmostApplication` and
 * `CGWindowListCopyWindowInfo` need no authorization at all — the window list's
 * only TCC-gated field is `kCGWindowName` (the window TITLE, redacted without
 * Screen Recording, never prompted for), and this guard reads owner pid, owner
 * NAME and bounds, none of which are gated. The AX hit tests ride the
 * Accessibility grant the vector already requires.
 *
 * ---------------------------------------------------------------------------
 * WHY OCCLUSION IS TESTED TWICE (measured on the maintainer's host, 2026-09-03).
 *
 * The obvious test — walk `CGWindowListCopyWindowInfo`'s front-to-back list and
 * demand that the topmost window containing the point be Things' — REFUSES EVERY
 * GESTURE ON EVERY MAC. The Dock owns a full-screen window at layer 20 (measured
 * `Dock [0,0 2056x1329]`, alpha 1, above every ordinary window), and it is not a
 * desktop element, so `kCGWindowListExcludeDesktopElements` keeps it. It is
 * mouse-transparent, and the window list exposes no field that says so.
 *
 * So the authoritative test is the window server's OWN hit test:
 * `AXUIElementCopyElementAtPosition` on the system-wide element, whose answer is
 * exactly "what would a click here reach". Measured through that same Dock
 * window: over a Ghostty window it answers Ghostty (`AXTextArea`), and over the
 * real dock strip it answers Dock (`AXDockItem`) — it respects z-order AND
 * mouse-transparency, which the raw window list cannot.
 *
 * The window-list scan is kept beside it, with ONE named exemption — windows
 * owned by the Dock — rather than a layer band: an ordinary floating panel over
 * the sidebar sits at layer 3 and must be caught by the scan too, not left to
 * the hit test alone. The scan is the second opinion, and it is what NAMES the
 * occluding application in the refusal.
 */

/**
 * The stable marker every guarded pointer script carries. A regression test
 * (test/unit/pointer-gesture-guard.test.ts) requires it in every script string
 * that posts a synthesized mouse event, so a future HID gesture cannot ship
 * unguarded.
 */
export const PTRGD1_MARKER = "ptrGuard";

/**
 * The sentinel comment that closes the guard block. Everything after it in a
 * rendered script is the gesture's own body, which is what lets a test say "the
 * guard's verdict comes before the first event" without confusing the posting
 * helpers' DEFINITIONS (which sit in the prelude, ahead of it) for a post.
 */
export const PTRGD1_GUARD_END = "PTRGD1-GUARD-END";

/** Things' bundle identifier — the frontmost assertion's subject. */
export const THINGS_BUNDLE_ID = "com.culturedcode.ThingsMac";

/**
 * The generic AX/ObjC helper block, single-sourced here because the guard and
 * the drag driver's prelude both need it (two copies is how the two drift).
 * Byte-identical to the block that used to open `ui-drag.ts`'s JXA prelude.
 */
export const POINTER_GUARD_AX_HELPERS = `ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleep(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]) }
function sv(el,name){ var v=attr(el,name); return v? v.js : '' }
function rectOf(p,z){ if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null }
function frame(el){ return rectOf(attr(el,'AXPosition'), attr(el,'AXSize')) }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function findAll(el, wantRole, depth, acc){ acc=acc||[]; if(depth<0) return acc; var ch=kids(el);
  for(var i=0;i<ch.length;i++){ if(sv(ch[i],'AXRole')===wantRole) acc.push(ch[i]); findAll(ch[i], wantRole, depth-1, acc) } return acc }
function appEl(){ return $.AXUIElementCreateApplication(pidOf('Things3')) }
function mainWindow(){ var ws=kids(appEl()), std=[];
  for(var i=0;i<ws.length;i++){ if(sv(ws[i],'AXRole')==='AXWindow' && sv(ws[i],'AXSubrole')==='AXStandardWindow') std.push(ws[i]) }
  for(var k=0;k<std.length;k++){ if(sv(std[k],'AXMain')===true) return std[k] }
  return std.length? std[0] : null }`;

/**
 * The guard itself. Depends on {@link POINTER_GUARD_AX_HELPERS} being compiled
 * ahead of it; contributes `ptrGuard(what, points, opts)`, which returns the
 * refusal SENTENCE (a string) or `null` when the gesture may proceed.
 *
 * Every caller shape is a one-liner over that: a script that already speaks JSON
 * puts the sentence in its own refusal record, and one that does not throws it,
 * so the sentence reaches the caller through stderr either way.
 *
 * COST: no Apple events at all beyond the AX reads. The frontmost read and the
 * window list are in-process (`deepUnwrap` of a 29-window list measured 0 ms);
 * Things' pid comes from the frontmost record, so the guard never pays
 * `pidOf`'s System Events round-trip; the window enumeration is one AXChildren
 * plus three attribute reads per window, and each gesture point costs one
 * system-wide hit test plus, where an identity is asserted, one app-scoped hit
 * test and a short AXParent walk. `PTR_OPS` counts them so a caller can report
 * the guard's own price.
 */
export const POINTER_GUARD_JXA = `var PTRGD1_BUNDLE = '${THINGS_BUNDLE_ID}';
/* CGWindow.h list options; kCGNullWindowID is not bridged, and it is 0. */
var PTRGD1_LIST_OPTS = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
var PTRGD1_NULL_WINDOW = 0;
/* Frame-equality tolerance, in points: AX frames are fractional. */
var PTRGD1_TOL = 2;
/* How far up the AXParent chain an identity check looks. */
var PTRGD1_HOPS = 12;
var PTR_OPS = 0;

function ptrFrontApp(){ PTR_OPS++;
  var a = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!a) return null;
  function s(v){ try { var j = ObjC.unwrap(v); return typeof j === 'string' ? j : '' } catch(e){ return '' } }
  var pid = 0; try { pid = Number(a.processIdentifier) } catch(e){ return null }
  if (!(pid > 0)) return null;
  return { bundleId: s(a.bundleIdentifier), name: s(a.localizedName), pid: pid } }

/* The on-screen windows, front to back. null = the list could not be read. */
function ptrWindowList(){ PTR_OPS++;
  try {
    var ref = $.CGWindowListCopyWindowInfo(PTRGD1_LIST_OPTS, PTRGD1_NULL_WINDOW);
    if (!ref) return null;
    var arr = ObjC.castRefToObject(ref);
    if (!arr) return null;
    var list = ObjC.deepUnwrap(arr);
    if (!list || typeof list.length !== 'number') return null;
    return list;
  } catch(e){ return null } }

/*
 * The topmost window containing the point, at ANY layer, with ONE named
 * exemption: windows owned by the Dock.
 *
 * The exemption is measured, not defensive. The Dock owns a full-screen
 * layer-20 window on every Mac (host: Dock [0,0 2056x1329]; guest:
 * [0,0 1024x768]), alpha 1, above every ordinary window and kept by
 * kCGWindowListExcludeDesktopElements. It is mouse-transparent and the window
 * list exposes no field that says so, so counting it refuses every gesture on
 * every Mac. The Dock's REAL surfaces -- the strip, Mission Control -- are what
 * the system-wide hit test catches instead, measured answering AXDockItem
 * over the strip while answering the app underneath everywhere else.
 *
 * Everything else counts, at every layer, so an ordinary floating panel over
 * the sidebar is named here rather than left to the hit test alone.
 */
function ptrTopWindowAt(list, x, y){
  for (var i = 0; i < list.length; i++){
    var w = list[i], b = w['kCGWindowBounds'];
    if (!b) continue;
    var name = w['kCGWindowOwnerName'];
    if (Number(w['kCGWindowLayer']) > 0 && name === 'Dock') continue;
    if (x < b.X || y < b.Y || x >= b.X + b.Width || y >= b.Y + b.Height) continue;
    return { pid: Number(w['kCGWindowOwnerPID']),
             name: (typeof name === 'string' && name !== '') ? name : 'an unnamed window' } }
  return null }

/*
 * The name of a running application by pid — how an occluder the BANDED window
 * scan cannot see still gets named. The Dock is the case that needs it: its
 * strip sits above every ordinary window, so the hit test catches a point over
 * it while the layer<=0 scan honestly reports Things' own window underneath.
 */
function ptrAppName(pid){
  try { var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    if (!a) return null;
    var n = ObjC.unwrap(a.localizedName);
    return (typeof n === 'string' && n !== '') ? n : null } catch(e){ return null } }

/* What a click at this point would actually reach, per the window server. */
function ptrHitPidAt(x, y){ PTR_OPS++;
  var out = Ref();
  if ($.AXUIElementCopyElementAtPosition($.AXUIElementCreateSystemWide(), x, y, out) !== 0) return null;
  var el = ObjC.castRefToObject(out[0]);
  if (!el) return null;
  var p = Ref();
  if ($.AXUIElementGetPid(el, p) !== 0) return null;
  var pid = Number(p[0]);
  return pid > 0 ? pid : null }

/* Things' own windows and sheets, for the containment test. */
function ptrThingsWindows(pid, wantMain){ PTR_OPS++;
  var app = $.AXUIElementCreateApplication(pid), out = [], ws = kids(app), i;
  for (i = 0; i < ws.length; i++){ PTR_OPS += 3;
    var role = sv(ws[i],'AXRole');
    if (role !== 'AXWindow' && role !== 'AXSheet') continue;
    if (wantMain && sv(ws[i],'AXSubrole') !== 'AXStandardWindow') continue;
    var f = frame(ws[i]); if (f === null) continue;
    out.push({ f:f, main: sv(ws[i],'AXMain') === true }) }
  if (!wantMain) return out;
  for (i = 0; i < out.length; i++) if (out[i].main) return [out[i]];
  return out.length ? [out[0]] : [] }

function ptrRectHas(r, x, y){ return r !== null && x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h }
function ptrSameRect(a, b){ return !!a && !!b &&
  Math.abs(a.x-b.x) <= PTRGD1_TOL && Math.abs(a.y-b.y) <= PTRGD1_TOL &&
  Math.abs(a.w-b.w) <= PTRGD1_TOL && Math.abs(a.h-b.h) <= PTRGD1_TOL }
function ptrXOverlap(a, b){ if(!a||!b) return 0; return Math.min(a.x+a.w,b.x+b.w) - Math.max(a.x,b.x) }

/*
 * The AXParent chain from the element under the point, INSIDE Things (the app
 * element scopes the hit test, so a point outside Things resolves nothing).
 * Identity is compared by role + frame rather than CFEqual, which is awkward
 * to reach from JXA — the same disambiguation the rest of the driver uses.
 */
function ptrChainAt(pid, x, y){ PTR_OPS++;
  var out = Ref();
  if ($.AXUIElementCopyElementAtPosition($.AXUIElementCreateApplication(pid), x, y, out) !== 0) return [];
  var el = ObjC.castRefToObject(out[0]), chain = [], n = 0;
  while (el && n < PTRGD1_HOPS){ PTR_OPS += 3;
    chain.push({ role: sv(el,'AXRole'), sub: sv(el,'AXSubrole'), f: frame(el) });
    el = attr(el,'AXParent'); n++ }
  return chain }

/* Identity: the chain passes through an element of this role with this frame. */
function ptrChainHasFrame(chain, roles, rect){
  for (var i = 0; i < chain.length; i++){
    if (roles !== null && roles.indexOf(chain[i].role) < 0) continue;
    if (ptrSameRect(chain[i].f, rect)) return true }
  return false }

/* Identity: the chain passes through an element of one of these roles. */
function ptrChainHasRole(chain, roles){
  for (var i = 0; i < chain.length; i++) if (roles.indexOf(chain[i].role) >= 0) return true;
  return false }

function ptrChainRoles(chain){
  var out = [];
  for (var i = 0; i < chain.length; i++) out.push(chain[i].role || '?');
  return out.length ? out.join(' < ') : 'nothing' }

/*
 * THE GUARD. \`what\` completes the sentence "refused to <what>: ...".
 * \`points\` is every screen point the gesture will visit. \`opts.anyWindow\`
 * accepts any Things window or sheet for containment rather than only the AXMain
 * one (the Repeat dialog is presented as a DETACHED editor window when Things is
 * not frontmost, MODALX1/#629). \`opts.identity\` is called with the chain under
 * the FIRST point and returns a clause naming what is wrong, or null.
 * Returns the refusal sentence, or null when the gesture may proceed.
 */
function ptrGuard(what, points, opts){
  opts = opts || {};
  /* Two tails, exactly as the keystroke law has two (AX_FOCUS_GUARD_HANDLERS). */
  var lead = 'refused to ' + what + ': ', DASH = ' — nothing was posted', SO = ', so nothing was posted';
  var front = ptrFrontApp();
  if (front === null) return lead + 'the frontmost application could not be read, so there is no proof the gesture would reach Things' + DASH;
  if (front.bundleId !== PTRGD1_BUNDLE) {
    var who = front.name || front.bundleId || 'an unidentified application';
    return lead + who + ' is frontmost, not Things — a pointer gesture goes to whatever owns the screen' + SO }
  var wins = ptrThingsWindows(front.pid, opts.anyWindow !== true);
  if (wins.length === 0) return lead + "Things' window did not resolve a frame, so there is no proof the gesture would land inside it" + DASH;
  var list = ptrWindowList();
  if (list === null) return lead + 'the on-screen window list could not be read, so nothing rules out another window covering the point' + DASH;
  for (var i = 0; i < points.length; i++){
    var px = points[i].x, py = points[i].y, at = '(' + Math.round(px) + ', ' + Math.round(py) + ')';
    var inside = false;
    for (var k = 0; k < wins.length; k++) if (ptrRectHas(wins[k].f, px, py)) { inside = true; break }
    if (!inside) return lead + at + " is outside Things' window, so the gesture would land somewhere else" + DASH;
    /*
     * THE SCAN IS ASKED FIRST, because it is the leg that can NAME the culprit.
     * Measured (PTRGD1 cell B3): over an opaque floating panel belonging to a
     * process with no accessibility tree, the window server's hit test resolves
     * NOTHING while the window list names the owner outright. Asking the hit
     * test first threw that name away and refused with "nothing answered",
     * which is true and useless.
     */
    var owner = function(name){ return lead + (name === null ? 'another application' : '"' + name + '"') +
      ' owns the screen at ' + at + ', not Things — a pointer gesture goes to whatever is under it' + SO };
    var top = ptrTopWindowAt(list, px, py);
    if (top !== null && top.pid !== front.pid) return owner(top.name);
    var hit = ptrHitPidAt(px, py);
    if (hit === null) return lead + 'nothing on screen answered for ' + at + ', so there is no proof the gesture would reach Things' + DASH;
    if (hit !== front.pid) return owner(ptrAppName(hit));
    if (top === null) return lead + 'no on-screen window owns ' + at + ', so there is no proof the gesture would reach Things' + DASH }
  if (typeof opts.identity === 'function' && points.length > 0) {
    var bad = opts.identity(ptrChainAt(front.pid, points[0].x, points[0].y));
    if (bad) return lead + bad + DASH }
  return null }
/* ${PTRGD1_GUARD_END} */`;

/** The guard block plus the helpers it needs, for a script that has neither. */
export const POINTER_GUARD_STANDALONE = `${POINTER_GUARD_AX_HELPERS}
${POINTER_GUARD_JXA}`;
