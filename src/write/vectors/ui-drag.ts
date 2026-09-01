/**
 * Sidebar AREA drag-reorder driver for the ui vector (the AXDRAG1/AXDRAG2 lab
 * campaigns). Moves an area to a new sidebar rank by synthesizing a real mouse
 * drag through the NATIVE1 JXA ObjC-bridge / HID-tap path.
 *
 * Doctrine (docs/design/ui-vector.md + ax-initiative.md standing constraints):
 * every click/drag anchor derives from AX-RESOLVED element frames read from the
 * live tree immediately before the gesture — never a guessed pixel. Slot-
 * boundary offsets computed FROM resolved frames are geometry, not guessing.
 * Scroll-wheel synthesis is positionless and allowed. Fail-closed: an
 * unresolvable sidebar/row refuses BEFORE any synthesis. NOTE: that scroll line
 * was WRONG and SBSCR1 measured it so — a synthesized wheel event is delivered
 * to the view under the POINTER and nowhere else (0px moved with the cursor off
 * the sidebar against 180px with it on). Scrolling is now done by setting the
 * sidebar scroll bar's own `AXValue`, which is genuinely positionless; the wheel
 * survives only as the fallback for a scroll area that exposes no bar, and it
 * moves the pointer first because it has to. Every hop is followed
 * by a database assert (order progressed as aimed; the area count and every
 * to-do/project area assignment are unchanged), and an assert failure triggers
 * one verified recovery drag back to the pre-op position before the op errors.
 *
 * The visibility LADDER (design rulings 2026-07-15, amended: edge-hover
 * auto-scroll is REJECTED for production — app-controlled scroll velocity is
 * too brittle; AXDRAG1-c stays lab evidence only):
 *  - Rung 1 (common case): pre-scroll until the source row and the drop
 *    boundary are simultaneously visible, then one certified AXDRAG1 drag.
 *  - Rung 2 (scroll-while-held): grab the source, synthesize SCROLL-WHEEL
 *    events while the drag is held so the list scrolls underneath the held
 *    item, re-resolve the target row's live frame, drop at the computed slot
 *    boundary. Gated on the AXDRAG2-a probe (mid-drag AX frame resolution AND
 *    mid-drag wheel delivery); not shipped unless both halves pass.
 *  - Rung 3 (multi-hop fallback, the correctness floor): move the area one
 *    viewport per hop — drop at the furthest visible slot toward the target,
 *    re-scroll, re-grab, repeat. The DB is asserted after EVERY hop, and an
 *    INFINITE-LOOP GUARD enforces termination: each hop must STRICTLY reduce
 *    the remaining distance to the target rank (one retry allowed, then the
 *    op aborts reporting where the area ended up — a partially-moved area is
 *    benign), under an absolute hop cap of ceil(areas / visible-slots) + 2.
 *
 * Load-bearing AXDRAG1 geometry — with NO hardcoded pixel geometry (design
 * amendment 2026-07-15): every aimed coordinate and distance is derived at
 * runtime from the live AX-resolved frames of the SAME snapshot generation
 * (the lab observed 24px rows / 16px spacers / 40px slots, but the driver
 * never assumes those numbers, so a text-size change only rescales it):
 *  - The drop boundary that inserts ABOVE a row is the midpoint of the region
 *    between it and the row above it — the spacer row's center when a spacer
 *    row sits between entity rows, the shared edge otherwise.
 *  - Slot pitch, where an estimate is needed (hop-cap sizing, span fallback),
 *    is the median adjacent y-delta of the resolved area rows.
 *  - Lifting the source collapses its slot (its whole group — nested project
 *    rows travel with it), so for DOWNWARD drags every static coordinate below
 *    the source shifts up by the source's group span. The span is computed
 *    from resolved frames (next area row top − source row top), so areas with
 *    visible nested projects stay correct.
 *  - Off-viewport rows still expose valid virtualized frames; visibility must
 *    be cross-checked against the scroll-area viewport rect.
 *  - Row identity: the AppleScript-seeded sidebar rows carry an EMPTY
 *    AXDescription — areas are identified by descendant AXStaticText segments.
 *  - Index semantics: TMArea."index" ascending == sidebar order; a drag may
 *    renumber a NEIGHBOR rather than the dragged row, so all asserts compare
 *    RELATIVE positions, never index values.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { trace } from "../../trace/tracer.ts";
import { createHeadingOrderReader, type HeadingOrderReader } from "./ui-chord.ts";
import type { UiCommand, UiRunner, UiRunResult } from "./ui.ts";

// ------------------------------------------------------------------- types

export type SidebarPlacement =
  | { kind: "before"; uuid: string; title: string }
  | { kind: "after"; uuid: string; title: string }
  | { kind: "first" }
  | { kind: "last" };

export interface SidebarDragSpec {
  targetUuid: string;
  targetTitle: string;
  placement: SidebarPlacement;
}

/** Ordered area state read from the database between hops (the assert seam). */
export interface AreaSidebarState {
  /** Areas ordered by TMArea."index" (== sidebar order once materialized). */
  areas: { uuid: string; title: string; index: number }[];
  /** Digest over every untrashed task's area assignment (invariance tripwire). */
  assignmentsDigest: string;
}

/**
 * Auxiliary seams the ui vector needs beyond osascript dispatch. Both ordering
 * drivers assert the database between gestures — the sidebar drag driver
 * through `areaState`, the heading-chord driver through `headingOrder` — and
 * the client wires each to the open connection. Absent (e.g. the capabilities
 * surface, which never executes), those ops refuse cleanly.
 */
export interface UiDriveAux {
  areaState?: () => AreaSidebarState;
  /** Heading order + child containment for one project (the chord driver's oracle). */
  headingOrder?: HeadingOrderReader;
}

/** The client-side default aux: reads area order + assignments from the DB. */
export function createUiDriveAux(db: DatabaseSync): UiDriveAux {
  return {
    headingOrder: createHeadingOrderReader(db),
    areaState(): AreaSidebarState {
      const areas = db
        .prepare(`SELECT uuid, title, "index" AS idx FROM TMArea ORDER BY "index", uuid`)
        .all() as unknown as { uuid: string; title: string; idx: number }[];
      const assignments = db
        .prepare("SELECT uuid, COALESCE(area, '') AS a FROM TMTask WHERE trashed = 0 ORDER BY uuid")
        .all() as unknown as { uuid: string; a: string }[];
      const hash = createHash("sha256");
      for (const row of assignments) hash.update(`${row.uuid}:${row.a}\n`);
      return {
        areas: areas.map((a) => ({ uuid: a.uuid, title: a.title, index: a.idx })),
        assignmentsDigest: hash.digest("hex"),
      };
    },
  };
}

export interface SidebarRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SidebarRowInfo extends SidebarRect {
  /** Concatenated descendant static-text segments, joined with "|". */
  text: string;
}

export interface SidebarSnapshot {
  /** The sidebar scroll-area viewport rect (the visible band). */
  viewport: SidebarRect | null;
  /** Vertical scroll fraction 0..1 from the AXScrollBar, when exposed. */
  scroll: number | null;
  rows: SidebarRowInfo[];
  /**
   * The row-text harvest depth this read actually used, and whether it had to
   * ESCALATE to reach it. The escalation used to be invisible — it doubles the
   * read's cost and nothing said so (#672 hit its 30s budget without a word
   * about which depth had been paid for).
   */
  depth?: number;
  escalated?: boolean;
  /** Area titles the harvest matched, against how many the database holds. */
  matched?: number;
  expected?: number;
}

// -------------------------------------------------- JXA command shapes
// One stable script shape per primitive (NATIVE1/AXDRAG1 incantations,
// verbatim where they are load-bearing). All dispatch through the injectable
// UiRunner seam, so ladder logic is unit-testable without a GUI.

const JXA_PRELUDE = `ObjC.import('AppKit');
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
  return std.length? std[0] : null }
var NODE_ATTRS=$(['AXValue','AXDescription','AXTitle','AXChildren','AXPosition','AXSize','AXRole']);
function node(el){ var out=Ref();
  if($.AXUIElementCopyMultipleAttributeValues(el,NODE_ATTRS,0,out)!==0) return null;
  var a=ObjC.castRefToObject(out[0]); if(!a||Number(a.count)<7) return null;
  function s(i){ var v=a.objectAtIndex(i); if(!v) return ''; var j; try{ j=v.js }catch(e){ return '' } return typeof j==='string'? j:'' }
  var ch=[], c=a.objectAtIndex(3);
  try{ var n=Number(c.count); for(var i=0;i<n;i++) ch.push(c.objectAtIndex(i)) }catch(e){ ch=[] }
  var f=null; try{ f=rectOf(a.objectAtIndex(4), a.objectAtIndex(5)) }catch(e){ f=null }
  return { value:s(0), desc:s(1), title:s(2), children:ch, frame:f, role:s(6) } }
/*
 * The depth guard is BEFORE the fetch, not after it (SBSCR1). The old shape
 * recursed into a generation whose own guard (\`depth<0\`) returned it before it
 * pushed any text — so an entire generation of \`node()\` calls was made and
 * thrown away. Each of those is a synchronous IPC round-trip into Things' main
 * thread, and the snapshot's cost is round-trips, not arithmetic. Same output,
 * one generation fewer calls.
 */
function textOf(n, acc, depth){ if(n===null) return acc;
  if(n.value) acc.push(n.value); if(n.desc) acc.push(n.desc); if(n.title) acc.push(n.title);
  if(depth<=0) return acc;
  for(var i=0;i<n.children.length;i++) textOf(node(n.children[i]), acc, depth-1); return acc }
function isList(role){ return role==='AXTable'||role==='AXOutline'||role==='AXList' }
function listPanes(el, depth, acc, sa){ if(depth<0) return acc; var ch=kids(el);
  for(var i=0;i<ch.length;i++){ var role=sv(ch[i],'AXRole');
    if(isList(role)){ acc.push({table:ch[i], scroll:sa}); continue }
    if(role==='AXRow'||role==='AXCell') continue;
    listPanes(ch[i], depth-1, acc, role==='AXScrollArea'? ch[i] : sa) }
  return acc }
function harvestRows(tableEl, depth){ var out=[], ch=kids(tableEl);
  for(var i=0;i<ch.length;i++){ var n=node(ch[i]); if(n===null) continue;
    if(n.role!=='AXRow'&&n.role!=='AXTableRow') continue;
    var f=n.frame;
    out.push({ text: textOf(n,[],depth).join('|'), x:f?f.x:null, y:f?f.y:null, w:f?f.w:null, h:f?f.h:null }) }
  return out }
function segMatch(text, title){ var segs=text.split('|');
  for(var j=0;j<segs.length;j++){ if(segs[j]===title||segs[j]===title+'.') return true } return false }
function countTitles(rows, titles){ var n=0;
  for(var t=0;t<titles.length;t++){ for(var r=0;r<rows.length;r++){ if(segMatch(rows[r].text,titles[t])){ n++; break } } }
  return n }
function overlapPx(a,b){ if(!a||!b) return 0; return Math.min(a.x+a.w,b.x+b.w) - Math.max(a.x,b.x) }
/*
 * The scroll bar is a DIRECT child of the scroll area (measured), so this reads
 * the children and stops. It used to be a findAll to depth 4, which walked the
 * whole table and every row underneath it — the last full-subtree enumeration
 * in the snapshot, and worth ~0.8s of its ~1.2s on an 85-row sidebar.
 */
function scrollBarOf(sa){ if(!sa) return null; var ch=kids(sa);
  for(var b=0;b<ch.length;b++){ if(sv(ch[b],'AXRole')==='AXScrollBar') return ch[b] }
  return null }
function barValue(bar){ if(!bar) return null; var v=attr(bar,'AXValue'); if(v===null) return null;
  var d=ObjC.castRefToObject($.CFCopyDescription(v)).js; var m=d.match(/value = ([+\\-0-9.]+)/);
  return m? +m[1] : null }
function scrollFraction(sa){ return barValue(scrollBarOf(sa)) }
/*
 * THE SIDEBAR LOCATOR (SBRES1). Structural + semantic, never geometric:
 *  - the window is the one carrying AXMain (measured: exactly one does, and it
 *    is the front one) — never the 40x40 untitled placeholder that always sits
 *    in the app's AXChildren beside the menu bar;
 *  - candidate lists are collected by a walk that STOPS at every list container
 *    and never enters a row, so its cost is a function of window chrome rather
 *    than of the user's data (measured 125 AX calls vs the old walk's ~3,900);
 *  - the sidebar is the candidate whose rows carry the caller's own AREA TITLES,
 *    which is what a sidebar IS. No width threshold: the old w < 400 test
 *    silently unresolved every sidebar dragged past 400pt (issues #665/#651).
 */
function resolveSidebar(titles, depth){
  var w = mainWindow();
  if (w === null) return { ok:false, why:'no-window' };
  var panes = listPanes(w, 8, [], null);
  if (panes.length === 0) return { ok:false, why:'no-list-candidates', windowFrame:frame(w) };
  var scored = [], i;
  for (i=0;i<panes.length;i++){
    var rows = harvestRows(panes[i].table, depth);
    scored.push({ pane:panes[i], rows:rows, hits:countTitles(rows,titles), frame:frame(panes[i].table) });
  }
  var best=null, tie=false;
  for (i=0;i<scored.length;i++){
    if (best===null || scored[i].hits>best.hits){ best=scored[i]; tie=false }
    else if (scored[i].hits===best.hits && best.hits>0) tie=true;
  }
  if (best===null || best.hits===0){
    var seen=[]; for(i=0;i<scored.length;i++) seen.push({frame:scored[i].frame, rows:scored[i].rows.length});
    return { ok:false, why:'no-title-match', searched:seen, titles:titles.length };
  }
  if (tie) return { ok:false, why:'ambiguous-sidebar', titles:titles.length };
  // HIDDEN-SIDEBAR SIGNATURE (measured): View > Hide Sidebar leaves the sidebar
  // scroll area in the tree with its old frame while the content pane slides
  // over it, so the two list panes OVERLAP horizontally by the sidebar's width.
  // Visible (and full-screen) states never overlap. No AX attribute marks it.
  var vp = best.pane.scroll===null? null : frame(best.pane.scroll);
  for (i=0;i<scored.length;i++){
    if (scored[i]===best || scored[i].pane.scroll===null) continue;
    if (overlapPx(vp, frame(scored[i].pane.scroll)) > 1) return { ok:false, why:'sidebar-hidden' };
  }
  if (vp === null) return { ok:false, why:'no-viewport' };
  if (best.rows.length === 0) return { ok:false, why:'no-rows' };
  return { ok:true, table:best.pane.table, scroll:best.pane.scroll, viewport:vp, rows:best.rows, hits:best.hits };
}
var MOVED=5, DOWN=1, UP=2, DRAG=6;
function mev(t,x,y,cs){ var e=$.CGEventCreateMouseEvent($(), t, $.CGPointMake(x,y), 0); if(cs) $.CGEventSetIntegerValueField(e,1,cs); return e }
function postHID(ev){ $.CGEventPost($.kCGHIDEventTap, ev) }`;

/**
 * How deep the per-row text walk goes on the FAST path, and on the fallback.
 *
 * MEASURED (SBRES1, 84-row sidebar): the driver consumes a row's text in exactly
 * two ways — `text === ''` (spacer detection) and an exact segment match against
 * a known area title — and depth 2 agrees with the old depth-6 walk on BOTH for
 * every row, at 235 AX calls / 197ms instead of 3,376 / 1,675ms. Depth 4 and up
 * is byte-identical to the old output, so the escalation below can never lose
 * information the ladder used to have.
 */
const ROW_TEXT_DEPTH_FAST = 2;
const ROW_TEXT_DEPTH_FULL = 6;

/**
 * Snapshot: sidebar rows (text + frames), viewport rect, scroll fraction.
 *
 * `areaTitles` is what makes the locator semantic — the sidebar is identified as
 * the list that holds the caller's own areas. It is also the ESCALATION oracle:
 * every area always renders a sidebar row (AXDRAG1: even off-viewport rows
 * expose valid virtualized frames), so a shallow harvest that finds fewer titles
 * than the database holds is re-run at full depth before the ladder sees it.
 */
export function jxaSidebarSnapshotScript(
  areaTitles: readonly string[],
  depthHint?: number,
): string {
  const start = depthHint === ROW_TEXT_DEPTH_FULL ? ROW_TEXT_DEPTH_FULL : ROW_TEXT_DEPTH_FAST;
  return `${JXA_PRELUDE}
var TITLES = ${JSON.stringify([...areaTitles])};
var START = ${start};
var r = resolveSidebar(TITLES, START);
var out;
if (r.ok !== true) { out = { ok:false, why:r.why, searched:r.searched||null, titles:r.titles||null, windowFrame:r.windowFrame||null } }
else {
  /*
   * CONFINED ESCALATION (SBSCR1, #672). The escalation used to re-run
   * resolveSidebar outright — a second window walk plus a full re-harvest of
   * EVERY candidate list pane, including the content pane, at depth 6. The
   * sidebar has already been identified by this point, so the deep read is
   * confined to its own table and nothing else is touched twice.
   */
  var deep = START === ${ROW_TEXT_DEPTH_FULL};
  if (r.hits < TITLES.length && !deep) {
    var rows2 = harvestRows(r.table, ${ROW_TEXT_DEPTH_FULL});
    var hits2 = countTitles(rows2, TITLES);
    if (hits2 > r.hits) { r.rows = rows2; r.hits = hits2; deep = true }
  }
  out = { ok:true, viewport:r.viewport, scroll:scrollFraction(r.scroll), rows:r.rows,
          deep:deep, depth:(deep? ${ROW_TEXT_DEPTH_FULL} : START),
          matched:r.hits, expected:TITLES.length };
}
JSON.stringify(out)`;
}

/**
 * Show or hide the sidebar through Things' own View menu (SBRES1 normalization
 * rung). English-pinned and fail-closed: a menu without the item — a localized
 * app, or a Things update that moved it — refuses and names what it did find,
 * rather than clicking whatever sits in that position (UIC1 precedent).
 */
export function jxaSidebarVisibilityScript(want: "show" | "hide"): string {
  const wanted = want === "show" ? "Show Sidebar" : "Hide Sidebar";
  return `var se = Application('System Events');
var out = { clicked:false, why:'', items:[] };
try {
  var items = se.processes.byName('Things3').menuBars[0].menuBarItems.byName('View').menus[0].menuItems;
  for (var i = 0; i < items.length; i++) {
    var name = items[i].name();
    if (name) out.items.push(name);
    if (name === ${JSON.stringify(wanted)}) { items[i].click(); out.clicked = true }
  }
  if (!out.clicked) out.why = 'the View menu has no "${wanted}" item';
} catch (e) { out.why = 'the View menu did not respond: ' + e }
JSON.stringify(out)`;
}

/**
 * Scroll, POINTERLESSLY: set the sidebar scroll bar's own `AXValue` (SBSCR1).
 *
 * This is the primary scroll mechanism and it is deterministic in a way the
 * wheel never was. Measured on golden-v4/3.23: the sidebar's `AXScrollBar`
 * exposes a SETTABLE `AXValue`, the write returns `AXError = 0`, the mapping
 * from fraction to pixels is exactly linear over the full range, and the list
 * moves with the pointer parked in a screen corner throughout. It is also
 * present and settable under all three `AppleShowScrollBars` settings —
 * including `WhenScrolling`, the laptop default, where the bar is invisible on
 * screen but fully live in the AX tree.
 *
 * Why this replaces the wheel: a synthesized wheel event is delivered to the
 * view under the POINTER and nowhere else (SBSCR1 §1 — 0px moved with the
 * cursor off the sidebar against 180px with it on). That made every scroll
 * depend on hidden global state, and the wheel path could only learn its own
 * sign convention by MEASURING travel, so at a scroll boundary — where a
 * wrong-way scroll moves nothing — it could never learn it at all.
 *
 * Reports what it did, so the caller can tell a rejected write from an accepted
 * write that moved nothing (#672 wanted exactly this distinction).
 */
export function jxaSidebarScrollToScript(fraction: number, areaTitles: readonly string[]): string {
  const want = Math.max(0, Math.min(1, fraction));
  return `${JXA_PRELUDE}
var TITLES = ${JSON.stringify([...areaTitles])};
var r = resolveSidebar(TITLES, ${ROW_TEXT_DEPTH_FAST});
if (r.ok !== true) { JSON.stringify({ok:false, why:'no-sidebar', detail:r.why}) } else {
var bar = scrollBarOf(r.scroll);
if (bar === null) { JSON.stringify({ok:false, why:'no-scrollbar'}) } else {
var before = barValue(bar);
var err = $.AXUIElementSetAttributeValue(bar, $('AXValue'), $.NSNumber.numberWithDouble(${want}));
sleep(250);
JSON.stringify({ ok: err === 0, axError: err, wanted: ${want}, before: before, after: barValue(bar) })
}}`;
}

/**
 * Scroll by WHEEL — the fallback for a scroll area that exposes no
 * `AXScrollBar` at all. Moves the pointer over the sidebar center first,
 * because a wheel event goes to the view under the cursor and nowhere else
 * (SBSCR1 §1); this is not an optimization, it is the only reason the fallback
 * works. Positive clicks move the CONTENT down (earlier rows return, row y
 * grows); negative clicks reveal lower rows (row y shrinks) — AXDRAG1-b.
 */
export function jxaSidebarScrollScript(clicks: number, areaTitles: readonly string[]): string {
  const n = Math.trunc(clicks);
  return `${JXA_PRELUDE}
var TITLES = ${JSON.stringify([...areaTitles])};
var r = resolveSidebar(TITLES, ${ROW_TEXT_DEPTH_FAST});
var sb = r.ok === true ? r.viewport : null;
if (sb === null) { 'NO_SIDEBAR' } else {
  postHID(mev(MOVED, sb.x + sb.w/2, sb.y + sb.h/2, 0)); sleep(50);
  var n = ${n}, dir = n < 0 ? -1 : 1;
  for (var i = 0; i < Math.abs(n); i++) {
    var ev = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, dir * 3);
    postHID(ev); sleep(60);
  }
  'DONE'
}`;
}

/**
 * Drag: the NATIVE1 gesture verbatim — move, down, 3px wiggle to open the drag
 * session, ~25 interpolated drag events, a settle so the drop indicator locks,
 * then up. Coordinates are AX-resolved frames + slot-boundary geometry computed
 * by the caller in the SAME snapshot generation.
 */
export function jxaSidebarDragScript(sx: number, sy: number, tx: number, ty: number): string {
  const [a, b, c, d] = [sx, sy, tx, ty].map(Math.round) as [number, number, number, number];
  return `${JXA_PRELUDE}
var sx=${a}, sy=${b}, tx=${c}, ty=${d}, steps=25;
postHID(mev(MOVED, sx, sy, 0)); sleep(30);
postHID(mev(DOWN, sx, sy, 1)); sleep(120);
postHID(mev(DRAG, sx, sy - 3, 1)); sleep(30);
for (var i = 1; i <= steps; i++) { postHID(mev(DRAG, sx + (tx-sx)*i/steps, sy + (ty-sy)*i/steps, 1)); sleep(25) }
postHID(mev(DRAG, tx, ty, 1)); sleep(400);
postHID(mev(UP, tx, ty, 1));
'DONE'`;
}

function snapshotCommand(areaTitles: readonly string[], depthHint?: number): UiCommand {
  return {
    primitive: "sidebar-snapshot",
    label: "read the sidebar rows and viewport",
    lang: "javascript",
    script: jxaSidebarSnapshotScript(areaTitles, depthHint),
    ...(depthHint !== undefined && { meta: { depthHint } }),
  };
}

function sidebarVisibilityCommand(want: "show" | "hide"): UiCommand {
  return {
    primitive: "sidebar-visibility",
    label: want === "show" ? "show the sidebar (View menu)" : "hide the sidebar again (View menu)",
    lang: "javascript",
    script: jxaSidebarVisibilityScript(want),
  };
}

function scrollCommand(clicks: number, areaTitles: readonly string[]): UiCommand {
  return {
    primitive: "sidebar-scroll",
    label: `scroll the sidebar (${clicks} clicks)`,
    lang: "javascript",
    script: jxaSidebarScrollScript(clicks, areaTitles),
    meta: { mechanism: "wheel", clicks },
  };
}

function scrollToCommand(fraction: number, areaTitles: readonly string[]): UiCommand {
  return {
    primitive: "sidebar-scroll",
    label: `scroll the sidebar (to ${fraction.toFixed(3)} of its range)`,
    lang: "javascript",
    script: jxaSidebarScrollToScript(fraction, areaTitles),
    meta: { mechanism: "scrollbar", fraction },
  };
}

function dragCommand(sx: number, sy: number, tx: number, ty: number): UiCommand {
  return {
    primitive: "sidebar-drag",
    label: "drag the area row to the computed slot boundary",
    lang: "javascript",
    script: jxaSidebarDragScript(sx, sy, tx, ty),
  };
}

/**
 * Rung 2 — scroll-while-held (AXDRAG2-a: wheel events DO scroll the list while
 * a drag is held, and AX frames re-resolve fresh mid-drag). One atomic
 * gesture: grab the source, post wheel events until the anchor row's LIVE
 * frame enters the visible band (direction re-derived every tick from the
 * live frame), then move to the live-computed boundary and drop. No static
 * corrections are needed — the mid-drag layout already reflects the lifted
 * source. If the anchor never arrives within the tick budget, the script
 * Escape-aborts (AXDRAG1-d: byte-identical index vector) and reports it.
 */
export function jxaSidebarHeldScrollDragScript(
  sx: number,
  sy: number,
  anchorTitle: string | null, // null = drop below the last row (to-last)
  maxTicks: number,
  areaTitles: readonly string[],
): string {
  const [a, b] = [sx, sy].map(Math.round) as [number, number];
  const anchor = JSON.stringify(anchorTitle);
  return `${JXA_PRELUDE}
var TITLES = ${JSON.stringify([...areaTitles])};
function liveRows(){ var r=resolveSidebar(TITLES, ${ROW_TEXT_DEPTH_FAST}); if(r.ok!==true) return [];
  var out=[]; for(var i=0;i<r.rows.length;i++){ var w=r.rows[i];
    if(w.y===null||w.h===null) continue;
    out.push({text:w.text, f:{x:w.x,y:w.y,w:w.w,h:w.h}}) }
  out.sort(function(p,q){ return p.f.y-q.f.y }); return out }
function matches(text, title){ var segs=text.split('|');
  for(var j=0;j<segs.length;j++){ if(segs[j]===title||segs[j]===title+'.') return true } return false }
function viewportRect(){ var r=resolveSidebar(TITLES, ${ROW_TEXT_DEPTH_FAST}); return r.ok===true? r.viewport : null }
var sx=${a}, sy=${b}, anchorTitle=${anchor}, maxTicks=${Math.trunc(maxTicks)};
var vp = viewportRect();
if (vp === null) { JSON.stringify({aborted:true, why:'no sidebar viewport'}) } else {
var bandTop = vp.y + 6, bandBot = vp.y + vp.h - 6;
postHID(mev(MOVED, sx, sy, 0)); sleep(30);
postHID(mev(DOWN, sx, sy, 1)); sleep(120);
postHID(mev(DRAG, sx, sy - 3, 1)); sleep(30);
postHID(mev(DRAG, sx, sy, 1)); sleep(100);
function boundaryNow(){
  var rows = liveRows(); if (rows.length === 0) return null;
  if (anchorTitle === null) {
    var last = rows[rows.length - 1];
    var y = last.text === '' ? last.f.y + last.f.h/2 : last.f.y + last.f.h + last.f.h/4;
    return { y: y, ready: (y >= bandTop && y <= bandBot) ? 1 : 0, dir: y > bandBot ? -3 : 3 };
  }
  var anchor = null, above = null;
  for (var i = 0; i < rows.length; i++) {
    if (matches(rows[i].text, anchorTitle)) { anchor = rows[i]; above = i > 0 ? rows[i-1] : null; break }
  }
  if (anchor === null) return null;
  var y;
  if (above === null) y = anchor.f.y + anchor.f.h/4;
  else if (above.text === '') y = above.f.y + above.f.h/2;
  else y = (above.f.y + above.f.h + anchor.f.y) / 2;
  return { y: y, ready: (y >= bandTop && y <= bandBot) ? 1 : 0, dir: y > bandBot ? -3 : 3 };
}
var b0 = boundaryNow(), ticks = 0, result = null;
if (b0 === null) {
  var kd=$.CGEventCreateKeyboardEvent($(),53,true), ku=$.CGEventCreateKeyboardEvent($(),53,false);
  postHID(kd); sleep(20); postHID(ku); sleep(150); postHID(mev(UP, sx, sy, 1));
  result = {aborted:true, why:'anchor row did not resolve mid-drag'};
} else {
  while (b0 !== null && b0.ready === 0 && ticks < maxTicks) {
    var ev = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, b0.dir);
    postHID(ev); sleep(60);
    postHID(mev(DRAG, sx, sy, 1)); sleep(90);
    b0 = boundaryNow(); ticks++;
  }
  if (b0 === null || b0.ready === 0) {
    var kd2=$.CGEventCreateKeyboardEvent($(),53,true), ku2=$.CGEventCreateKeyboardEvent($(),53,false);
    postHID(kd2); sleep(20); postHID(ku2); sleep(150); postHID(mev(UP, sx, sy, 1));
    result = {aborted:true, why:'anchor never entered the band', ticks:ticks};
  } else {
    // Post-wheel SETTLE: the list can drift a few px after the last tick
    // (AXDRAG2-a saw ~8px). Wait until the live boundary is stable across
    // two consecutive reads before aiming.
    var stable = 0, lastY = null, settleTick = 0;
    for (settleTick = 0; settleTick < 12 && stable < 2; settleTick++) {
      postHID(mev(DRAG, sx, sy, 1)); sleep(140);
      var bs = boundaryNow(); if (bs === null) break;
      if (lastY !== null && Math.abs(bs.y - lastY) < 1) stable++;
      else stable = 0;
      lastY = bs.y; b0 = bs;
    }
    if (b0 === null || b0.ready === 0 || stable < 2) {
      var kd3=$.CGEventCreateKeyboardEvent($(),53,true), ku3=$.CGEventCreateKeyboardEvent($(),53,false);
      postHID(kd3); sleep(20); postHID(ku3); sleep(150); postHID(mev(UP, sx, sy, 1));
      result = {aborted:true, why:'boundary never stabilized in the band before the drop', ticks:ticks};
    } else {
      var ty = b0.y;
      for (var s = 1; s <= 15; s++) { postHID(mev(DRAG, sx, sy + (ty-sy)*s/15, 1)); sleep(25) }
      // Final re-resolve at the destination: aim the LAST event at the
      // freshest boundary in case anything shifted during the approach.
      var bf = boundaryNow();
      if (bf !== null && bf.ready === 1) ty = bf.y;
      postHID(mev(DRAG, sx, ty, 1)); sleep(400);
      postHID(mev(UP, sx, ty, 1));
      result = {dropped:true, ticks:ticks, dropY:ty};
    }
  }
}
JSON.stringify(result)
}`;
}

/**
 * SBCOL1 — actuate an area row's DISCLOSURE CHEVRON.
 *
 * The toggle is two nodes: an inert `AXImage d="Source Toggle Template"` (what
 * AXDRAG2-b measured and called "not actuatable") inside an `AXUnknown` wrapper
 * that DOES advertise `AXPress` — and that press is DECORATIVE, exactly as REPX1
 * §1.2 predicts for Things' custom rows (`AXError = 0`, zero census delta). What
 * actuates is a synthesized click at the image's OWN resolved frame; SBCOL1
 * toggled it both directions twice with zero beeps and zero focus steal.
 *
 * Fail-closed twice over: the chevron is resolved from the LIVE tree inside this
 * same script (never a frame carried over from an earlier snapshot generation),
 * and a chevron whose center lies outside the scroll-area band is REFUSED rather
 * than clicked — an off-viewport row still exposes a valid virtualized frame
 * (AXDRAG1), so clicking one would land somewhere else entirely.
 *
 * `ordinal` selects among same-titled rows in visual (y) order, the AXDRAG3
 * disambiguation the rest of the driver uses; -1 means "the only row with this
 * title", and an ambiguous match refuses.
 */
export function jxaSidebarChevronClickScript(
  title: string,
  ordinal: number,
  areaTitles: readonly string[],
): string {
  const want = JSON.stringify(title);
  const ord = Math.trunc(ordinal);
  return `${JXA_PRELUDE}
var TITLES = ${JSON.stringify([...areaTitles])};
function allText(el, acc, depth){ acc=acc||[]; depth=depth==null?6:depth; if(depth<0) return acc;
  var v=sv(el,'AXValue'); if(v) acc.push(v); var d=sv(el,'AXDescription'); if(d) acc.push(d);
  var t=sv(el,'AXTitle'); if(t) acc.push(t); var ch=kids(el); for(var i=0;i<ch.length;i++) allText(ch[i],acc,depth-1); return acc }
function matches(el, title){ var segs=allText(el,[],6);
  for(var j=0;j<segs.length;j++){ if(segs[j]===title||segs[j]===title+'.') return true } return false }
function chevronOf(el, depth){ if(depth<0) return null; var ch=kids(el);
  for(var i=0;i<ch.length;i++){
    if(sv(ch[i],'AXRole')==='AXImage' && sv(ch[i],'AXDescription').indexOf('Toggle')>=0) return ch[i];
    var r=chevronOf(ch[i], depth-1); if(r) return r }
  return null }
var want=${want}, ord=${ord};
var sb = resolveSidebar(TITLES, ${ROW_TEXT_DEPTH_FAST});
if (sb.ok !== true) { JSON.stringify({clicked:false, why:'the sidebar did not resolve (' + sb.why + ')'}) } else {
var t = sb.table, vp = sb.viewport;
if (vp === null) { JSON.stringify({clicked:false, why:'the sidebar viewport did not resolve'}) } else {
var ch = kids(t), hits = [];
for (var r=0;r<ch.length;r++){ var role=sv(ch[r],'AXRole');
  if (role!=='AXRow' && role!=='AXTableRow') continue;
  if (!matches(ch[r], want)) continue;
  var rf = frame(ch[r]); if (rf) hits.push({el:ch[r], f:rf}) }
hits.sort(function(p,q){ return p.f.y-q.f.y });
var pick = ord < 0 ? (hits.length === 1 ? hits[0] : null) : (hits[ord] || null);
if (pick === null) {
  JSON.stringify({clicked:false, why:'the area row did not resolve uniquely', rows:hits.length})
} else {
  var img = chevronOf(pick.el, 5);
  if (img === null) { JSON.stringify({clicked:false, why:'the row exposes no disclosure chevron'}) }
  else {
    var cf = frame(img);
    if (cf === null) { JSON.stringify({clicked:false, why:'the chevron exposed no frame'}) }
    else {
      var cx = cf.x + cf.w/2, cy = cf.y + cf.h/2;
      if (cy < vp.y + 6 || cy > vp.y + vp.h - 6) {
        JSON.stringify({clicked:false, why:'the chevron is outside the visible sidebar band', y:cy})
      } else {
        // REPX1 §1.2 rig law: flags set EXPLICITLY on EVERY synthetic event
        // (zero included), and a MOVED settle before the press.
        var mv=mev(MOVED,cx,cy,0); $.CGEventSetFlags(mv,0); postHID(mv); sleep(300);
        var dn=mev(DOWN,cx,cy,1); $.CGEventSetFlags(dn,0); postHID(dn); sleep(90);
        var up=mev(UP,cx,cy,1); $.CGEventSetFlags(up,0); postHID(up); sleep(250);
        JSON.stringify({clicked:true, x:cx, y:cy})
      }
    }
  }
}
}}`;
}

function chevronClickCommand(
  title: string,
  ordinal: number,
  areaTitles: readonly string[],
): UiCommand {
  return {
    primitive: "sidebar-chevron",
    label: `toggle the disclosure arrow on the area row "${title}"`,
    lang: "javascript",
    script: jxaSidebarChevronClickScript(title, ordinal, areaTitles),
    meta: { title, ordinal },
  };
}

function heldScrollDragCommand(
  sx: number,
  sy: number,
  anchorTitle: string | null,
  maxTicks: number,
  areaTitles: readonly string[],
): UiCommand {
  return {
    primitive: "sidebar-held-drag",
    label: "held-scroll drag toward the destination",
    lang: "javascript",
    script: jxaSidebarHeldScrollDragScript(sx, sy, anchorTitle, maxTicks, areaTitles),
    meta: { sx, sy, anchorTitle, maxTicks },
  };
}

// ---------------------------------------------------------- pure geometry
// NO hardcoded pixel geometry: aimed coordinates derive from resolved frames
// of the current snapshot (amendment 2026-07-15). The only fixed numbers are
// TOLERANCES (visibility margins), never aim points.

/** Visibility tolerance: keep grabs/drops at least this far inside the band. */
const BAND_PAD = 6;

/** Median of a non-empty number list (helper for frame-derived estimates). */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** Median height of the table's spacer rows (rows with no static text). */
export function medianSpacerHeight(rows: SidebarRowInfo[]): number | null {
  return median(rows.filter((r) => r.text === "").map((r) => r.h));
}

/**
 * Slot pitch estimate: the median y-delta between adjacent resolved area rows
 * (falls back to entity-row height + spacer height when fewer than two area
 * rows resolve).
 */
export function slotPitch(
  orderedAreaRows: { title: string; row: SidebarRowInfo }[],
  allRows: SidebarRowInfo[],
): number {
  const deltas: number[] = [];
  for (let i = 1; i < orderedAreaRows.length; i++) {
    const prev = orderedAreaRows[i - 1] as { row: SidebarRowInfo };
    const curr = orderedAreaRows[i] as { row: SidebarRowInfo };
    deltas.push(curr.row.y - prev.row.y);
  }
  const m = median(deltas);
  if (m !== null && m > 0) return m;
  const entityH = median(allRows.filter((r) => r.text !== "").map((r) => r.h)) ?? 24;
  const spacerH = medianSpacerHeight(allRows) ?? entityH / 2;
  return entityH + spacerH;
}

/**
 * The boundary Y that inserts ABOVE `ref`: the midpoint of the region between
 * `ref` and the row immediately above it (the spacer row's center when a
 * spacer sits there; the shared edge when rows are contiguous). With no row
 * above, half a spacer height above `ref` (derived, not assumed).
 */
export function boundaryAboveRow(allRows: SidebarRowInfo[], ref: SidebarRowInfo): number {
  const above = allRows.filter((r) => r !== ref && r.y < ref.y).toSorted((a, b) => b.y - a.y)[0];
  if (above === undefined) {
    // Nothing above (no gap exists): aim inside the row's TOP QUARTER — a
    // drop in a row's top half resolves to insert-BEFORE it (AXDRAG1-a/D1).
    return ref.y + ref.h / 4;
  }
  if (above.text === "") return above.y + above.h / 2; // spacer center
  return (above.y + above.h + ref.y) / 2; // shared-edge midpoint
}

/**
 * The boundary Y that drops BELOW the final table row (to-last). The drop
 * zone below the last entity IS the trailing spacer row when one exists
 * (AXDRAG1-b landed to-last inside it) — its center keeps the drop in the
 * scrollable band even when the list is pinned to the bottom.
 */
export function boundaryBelowLast(allRows: SidebarRowInfo[]): number | null {
  const last = allRows.toSorted((a, b) => a.y - b.y).at(-1);
  if (last === undefined) return null;
  if (last.text === "") return last.y + last.h / 2; // trailing spacer center
  const half = (medianSpacerHeight(allRows) ?? last.h / 2) / 2;
  return last.y + last.h + half;
}

/**
 * Why a snapshot did not come back. These were ONE sentence until SBRES1 — "the
 * sidebar did not resolve (is the window open and the sidebar visible?)" — which
 * is how a 30-second timeout, a locator that never matched, and a sidebar the
 * user had genuinely hidden all reached the field wearing the same words, none
 * of them true for two of the three cases (issues #665, #651).
 */
export type SnapshotFailure =
  | "timeout"
  | "dispatch-failed"
  | "unparsable"
  | "no-window"
  | "no-list-candidates"
  | "no-title-match"
  | "ambiguous-sidebar"
  | "sidebar-hidden"
  | "no-viewport"
  | "no-rows";

export interface SnapshotRefusal {
  ok: false;
  why: SnapshotFailure;
  /** What the locator looked at, when it has something to name. */
  searched?: { frame: SidebarRect | null; rows: number }[];
  /** How many area titles the locator was hunting for. */
  titles?: number;
  /** The dispatcher's own words, for `dispatch-failed`. */
  stderr?: string;
}

export type SnapshotOutcome = { ok: true; snapshot: SidebarSnapshot } | SnapshotRefusal;

const SNAPSHOT_FAILURES: ReadonlySet<string> = new Set<SnapshotFailure>([
  "no-window",
  "no-list-candidates",
  "no-title-match",
  "ambiguous-sidebar",
  "sidebar-hidden",
  "no-viewport",
  "no-rows",
]);

export function parseSidebarSnapshot(stdout: string): SnapshotOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, why: "unparsable" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, why: "unparsable" };
  const obj = parsed as Record<string, unknown>;
  if (obj["ok"] !== true) {
    const why =
      typeof obj["why"] === "string" && SNAPSHOT_FAILURES.has(obj["why"]) ? obj["why"] : null;
    if (why === null) return { ok: false, why: "unparsable" };
    return {
      ok: false,
      why: why as SnapshotFailure,
      ...(Array.isArray(obj["searched"]) && {
        searched: obj["searched"] as { frame: SidebarRect | null; rows: number }[],
      }),
      ...(typeof obj["titles"] === "number" && { titles: obj["titles"] }),
    };
  }
  if (!Array.isArray(obj["rows"])) return { ok: false, why: "unparsable" };
  const rows = (obj["rows"] as SidebarRowInfo[]).filter(
    (r) => typeof r.y === "number" && typeof r.x === "number" && typeof r.h === "number",
  );
  const viewport = (obj["viewport"] as SidebarRect | null) ?? null;
  if (viewport === null) return { ok: false, why: "no-viewport" };
  if (rows.length === 0) return { ok: false, why: "no-rows" };
  return {
    ok: true,
    snapshot: {
      viewport,
      scroll: (obj["scroll"] as number | null) ?? null,
      rows,
      ...(typeof obj["depth"] === "number" && { depth: obj["depth"] }),
      ...(typeof obj["deep"] === "boolean" && { escalated: obj["deep"] }),
      ...(typeof obj["matched"] === "number" && { matched: obj["matched"] }),
      ...(typeof obj["expected"] === "number" && { expected: obj["expected"] }),
    },
  };
}

/**
 * Does a row's static-text carry this exact title as a segment? Sidebar row
 * text concatenates descendant static texts with "|" (AXDRAG1: e.g.
 * "Area-05.|Source Toggle Template|Area-05") — an exact segment match avoids
 * substring collisions; the trailing-dot variant covers the AXDescription-like
 * first segment some rows carry.
 */
export function rowMatchesTitle(text: string, title: string): boolean {
  return text.split("|").some((seg) => seg === title || seg === `${title}.`);
}

/** All rows matching known area titles, in visual (y) order. */
export function areaRowsInOrder(
  rows: SidebarRowInfo[],
  titles: readonly string[],
): { title: string; row: SidebarRowInfo }[] {
  const out: { title: string; row: SidebarRowInfo }[] = [];
  for (const row of rows) {
    const title = titles.find((t) => rowMatchesTitle(row.text, t));
    if (title !== undefined) out.push({ title, row });
  }
  return out.toSorted((a, b) => a.row.y - b.row.y);
}

/** Find a single area row by title; ambiguous or missing → null. */
export function findAreaRow(rows: SidebarRowInfo[], title: string): SidebarRowInfo | null {
  const matches = rows.filter((r) => rowMatchesTitle(r.text, title));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * The Nth (0-based) sidebar row carrying `title`, in visual (y) order — the
 * positional disambiguation for DUPLICATE area titles (ORDFIN2 AXDRAG3: sidebar
 * rows render in `TMArea."index" ASC, uuid ASC`, so the Nth same-titled AX row
 * == the Nth same-titled DB area). Null when fewer than `ordinal + 1` rows carry
 * the title in the current snapshot (e.g. a same-titled row scrolled off).
 */
export function findAreaRowNth(
  rows: SidebarRowInfo[],
  title: string,
  ordinal: number,
): SidebarRowInfo | null {
  const matches = rows.filter((r) => rowMatchesTitle(r.text, title)).toSorted((a, b) => a.y - b.y);
  return matches[ordinal] ?? null;
}

/**
 * The rank (0-based) of `uuid` among all areas that share `title`, by the DB's
 * canonical `(index, uuid)` ASC order (AXDRAG3) — i.e. which same-titled sidebar
 * row IS this uuid. Returns -1 when the title is UNIQUE (no disambiguation
 * needed) or the uuid is not among the same-titled set. Recomputed from LIVE
 * state each hop so it stays correct as the dragged area crosses a same-titled
 * sibling (its rank shifts in lockstep with its visual row).
 */
export function areaTitleRank(
  areas: { uuid: string; title: string }[],
  uuid: string,
  title: string,
): number {
  const same = areas.filter((a) => a.title === title);
  if (same.length <= 1) return -1;
  return same.findIndex((a) => a.uuid === uuid);
}

/** Resolve an area's sidebar row by title, disambiguating duplicates by rank. */
function resolveAreaRow(
  rows: SidebarRowInfo[],
  title: string,
  rank: number,
): SidebarRowInfo | null {
  return rank < 0 ? findAreaRow(rows, title) : findAreaRowNth(rows, title, rank);
}

/** The Nth (0-based) entry carrying `title` in a visual-ordered area-row list. */
function nthByTitle(
  ordered: { title: string; row: SidebarRowInfo }[],
  title: string,
  ordinal: number,
): number {
  let seen = 0;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]?.title === title) {
      if (seen === ordinal) return i;
      seen += 1;
    }
  }
  return -1;
}

/**
 * The source's group span: lifting an area collapses its row AND its visible
 * nested project rows. Computed from resolved frames as the distance from the
 * source area row's top to the NEXT area row's top (falls back to the median
 * slot pitch when the source is the last area).
 */
export function sourceGroupSpan(
  orderedAreaRows: { title: string; row: SidebarRowInfo }[],
  sourceTitle: string,
  allRows: SidebarRowInfo[],
): number {
  const pitch = slotPitch(orderedAreaRows, allRows);
  const idx = orderedAreaRows.findIndex((a) => a.title === sourceTitle);
  if (idx < 0) return pitch;
  const source = orderedAreaRows[idx];
  const next = orderedAreaRows[idx + 1];
  if (source === undefined || next === undefined) return pitch;
  const span = next.row.y - source.row.y;
  return span > 0 ? span : pitch;
}

/**
 * Static drop boundary Y for the requested placement, computed against the
 * CURRENT snapshot. Every placement reduces to "insert above area R" (the
 * mid-gap above R's row) except to-last, which drops below the final table row.
 */
export function staticBoundaryY(
  orderedAreaRows: { title: string; row: SidebarRowInfo }[],
  allRows: SidebarRowInfo[],
  sourceTitle: string,
  placement: SidebarPlacement,
  // Rank (0-based) of a DUPLICATE-titled anchor among its same-titled set, or -1
  // when the anchor title is unique. Disambiguates which same-titled anchor row
  // to drop against (ORDFIN2 AXDRAG3); indexed into the full ordered list, not
  // `others`, so it is correct even when the source shares the anchor's title.
  anchorRank = -1,
): { y: number; anchor: string } | { error: string } {
  const others = orderedAreaRows.filter((a) => a.title !== sourceTitle);
  if (others.length === 0) return { error: "no other area rows resolved in the sidebar" };
  const belowLast = (): { y: number; anchor: string } | { error: string } => {
    const y = boundaryBelowLast(allRows);
    if (y === null) return { error: "no sidebar rows resolved" };
    return { y, anchor: "the end of the sidebar list" };
  };
  // Locate the anchor row in the full ordered list (rank-aware for duplicates).
  const anchorIndexInOrdered = (title: string): number =>
    anchorRank >= 0
      ? nthByTitle(orderedAreaRows, title, anchorRank)
      : orderedAreaRows.findIndex((a) => a.title === title);
  switch (placement.kind) {
    case "first": {
      const first = others[0] as { title: string; row: SidebarRowInfo };
      return { y: boundaryAboveRow(allRows, first.row), anchor: first.title };
    }
    case "last":
      return belowLast();
    case "before": {
      const i = anchorIndexInOrdered(placement.title);
      const ref = i >= 0 ? orderedAreaRows[i] : undefined;
      if (ref === undefined)
        return { error: `the sidebar row for "${placement.title}" did not resolve` };
      return { y: boundaryAboveRow(allRows, ref.row), anchor: ref.title };
    }
    case "after": {
      const i = anchorIndexInOrdered(placement.title);
      if (i < 0) return { error: `the sidebar row for "${placement.title}" did not resolve` };
      const next = orderedAreaRows[i + 1];
      if (next === undefined) return belowLast();
      return { y: boundaryAboveRow(allRows, next.row), anchor: next.title };
    }
  }
}

/**
 * Correct a static boundary for the mid-drag layout: a DOWNWARD drag (boundary
 * below the source) sees everything below the source shift up by the source's
 * group span the instant it is picked up (AXDRAG1-a). Upward drags use static
 * coordinates unchanged.
 */
export function correctedDropY(staticY: number, sourceCenterY: number, span: number): number {
  return staticY > sourceCenterY ? staticY - span : staticY;
}

export function inBand(y: number, viewport: SidebarRect, pad = BAND_PAD): boolean {
  return y >= viewport.y + pad && y <= viewport.y + viewport.h - pad;
}

/**
 * The travel a single certified drag can cover inside this viewport: the band
 * minus the grab/drop margins at both ends. The rung-1 shared-viewport test and
 * the tall-section pre-flight both measure against this ONE number.
 */
export function usableDragSpan(viewport: SidebarRect): number {
  return viewport.h - 4 * BAND_PAD;
}

/**
 * A sidebar SECTION is an area row plus every row Things renders under it (its
 * projects, and its "Later Projects" row). `bottom` is the next area row's top —
 * the last section runs to the bottom of the table.
 */
export interface SidebarSectionSpan {
  title: string;
  /** Section height in points (area row top → next area row top). */
  height: number;
  /** How many table rows the section contains (its own row included). */
  rows: number;
  /**
   * Which same-titled sidebar row this section belongs to, in visual order
   * (AXDRAG3); -1 when the title is unique. The collapse rung needs it to
   * actuate the right chevron when two areas share a name.
   */
  ordinal: number;
}

/**
 * The TALLEST section the gesture would have to climb over, or null when every
 * one of them fits. #658: an area's projects render beneath it, so a section can
 * be taller than the whole sidebar viewport — and BOTH shipped rungs need the
 * source row and the drop boundary visible AT ONCE, so such a section is a wall
 * no amount of scrolling gets around. Measured over the travel span between the
 * grab point and the aimed boundary; the source's OWN section is excluded (
 * lifting it collapses it) and a section is only counted when the snapshot
 * actually resolved rows inside it, so a partially-materialized AX tree cannot
 * fabricate a wall out of a gap between two distant rows.
 */
export function sectionsInSpan(
  orderedAreaRows: { title: string; row: SidebarRowInfo }[],
  allRows: SidebarRowInfo[],
  fromY: number,
  toY: number,
  sourceTitle: string,
): SidebarSectionSpan[] {
  const lo = Math.min(fromY, toY);
  const hi = Math.max(fromY, toY);
  const tableBottom = allRows.reduce((max, r) => Math.max(max, r.y + r.h), -Infinity);
  const out: SidebarSectionSpan[] = [];
  for (let i = 0; i < orderedAreaRows.length; i++) {
    const section = orderedAreaRows[i];
    if (section === undefined || section.title === sourceTitle) continue;
    const top = section.row.y;
    const bottom = orderedAreaRows[i + 1]?.row.y ?? tableBottom;
    if (bottom <= lo || top >= hi) continue; // outside the travel span
    const rows = allRows.filter((r) => r.y >= top && r.y < bottom).length;
    // Which same-titled row IS this one, in visual order (AXDRAG3) — the
    // chevron primitive needs it to click the right one.
    const ordinal = orderedAreaRows
      .filter((a) => a.title === section.title)
      .findIndex((a) => a.row === section.row);
    out.push({
      title: section.title,
      height: bottom - top,
      rows,
      ordinal: orderedAreaRows.filter((a) => a.title === section.title).length > 1 ? ordinal : -1,
    });
  }
  return out;
}

/** The tallest section in the travel span, or null when every one of them fits. */
export function tallestSectionInSpan(
  orderedAreaRows: { title: string; row: SidebarRowInfo }[],
  allRows: SidebarRowInfo[],
  fromY: number,
  toY: number,
  sourceTitle: string,
): SidebarSectionSpan | null {
  let worst: SidebarSectionSpan | null = null;
  for (const s of sectionsInSpan(orderedAreaRows, allRows, fromY, toY, sourceTitle)) {
    if (worst === null || s.height > worst.height) worst = s;
  }
  return worst;
}

/**
 * Every section in the travel span the ladder cannot climb — tallest FIRST, so
 * the collapse rung clears the worst obstruction before spending a gesture on a
 * marginal one. SBCOL1 §4 measured a two-wall span: collapsing both turned a
 * ten-position move into an ordinary multi-hop.
 */
export function blockingSectionsInSpan(
  orderedAreaRows: { title: string; row: SidebarRowInfo }[],
  allRows: SidebarRowInfo[],
  fromY: number,
  toY: number,
  sourceTitle: string,
  viewport: SidebarRect,
): SidebarSectionSpan[] {
  return sectionsInSpan(orderedAreaRows, allRows, fromY, toY, sourceTitle)
    .filter((s) => sectionBlocks(s, viewport))
    .toSorted((a, b) => b.height - a.height);
}

/**
 * Is this section a WALL for the shipped ladder (rung 1 + the multi-hop floor)?
 * A section taller than one drag's usable span can never be crossed, because
 * every hop must land the source on the far side of it in ONE gesture.
 */
export function sectionBlocks(section: SidebarSectionSpan, viewport: SidebarRect): boolean {
  return section.height > usableDragSpan(viewport) && section.rows >= 2;
}

/**
 * The refusal an unclimbable section earns once the COLLAPSE RUNG has failed on
 * it (SBCOL1) — the honest twin of the old "the viewport is too small to make
 * progress" copy, which blamed the window size for a geometry no window size
 * fixes (#658). `whyCollapseFailed` names what stopped the driver from folding
 * the section away itself, so the advice to do it by hand is not offered blind.
 */
export function blockedSectionDetail(
  section: SidebarSectionSpan,
  viewport: SidebarRect,
  destination: string,
  whyCollapseFailed?: string,
): string {
  return (
    `the area "${section.title}" and the ${section.rows - 1} row(s) Things renders under it ` +
    `stand between this area and ${destination}, and that block is taller than the sidebar ` +
    `shows at once (about ${Math.round(section.height)}pt of rows against ${Math.round(viewport.h)}pt ` +
    "of visible list) — a drag has to see where it starts and where it lands at the same time, " +
    `so no gesture can cross it. Collapsing "${section.title}" out of the way did not work` +
    `${whyCollapseFailed === undefined ? "" : ` (${whyCollapseFailed})`}. Collapse it in the ` +
    "sidebar with the arrow on its row, or make the Things window taller, then re-run — or drag " +
    "the area by hand"
  );
}

/**
 * Grab/drop x: a fixed FRACTION of the row's resolved width (≈ the label area
 * NATIVE1 clicked at x+170 on a 240px row), clear of the leading icon and the
 * trailing counters — derived from the frame, not a pixel offset.
 */
export function grabPoint(row: SidebarRowInfo): { x: number; y: number } {
  return { x: row.x + row.w * 0.7, y: row.y + row.h / 2 };
}

// ------------------------------------------------------------ DB position

function positionOf(state: AreaSidebarState, uuid: string): number {
  return state.areas.findIndex((a) => a.uuid === uuid);
}

function hasRankTies(state: AreaSidebarState): boolean {
  const seen = new Set<number>();
  for (const a of state.areas) {
    if (seen.has(a.index)) return true;
    seen.add(a.index);
  }
  return false;
}

/** Is the requested placement already satisfied in this DB state? */
export function placementSatisfied(
  state: AreaSidebarState,
  targetUuid: string,
  placement: SidebarPlacement,
): boolean {
  const pos = positionOf(state, targetUuid);
  if (pos < 0) return false;
  switch (placement.kind) {
    case "first":
      return pos === 0;
    case "last":
      return pos === state.areas.length - 1;
    case "before":
      return positionOf(state, placement.uuid) === pos + 1;
    case "after":
      return positionOf(state, placement.uuid) === pos - 1;
  }
}

// ---------------------------------------------------------------- driver

/** Absolute ceiling on hops regardless of the computed cap (safety net). */
const MAX_HOPS_CEILING = 40;
const MAX_SCROLL_ITER = 18;
/**
 * Seed for the FIRST scroll's travel-per-click estimate only; every later
 * scroll uses the travel MEASURED from the frames the previous scroll moved
 * (no assumed pixel distances — amendment 2026-07-15).
 */
const PX_PER_CLICK_SEED = 30;
/** DB assert poll: attempts × delay (Things writes the index on drop). */
const ASSERT_ATTEMPTS = 12;
const ASSERT_DELAY_MS = 250;
const STEP_TIMEOUT_MS = 30_000;
/**
 * The sidebar read's budget scales with the sidebar (see `snapshotTimeoutMs`).
 * MEASURED (SBSCR1, golden-v4): a 178-row sidebar reads in ~2.1s in a VM, so
 * 400ms/row is ~34x headroom for a busy Mac — and the ceiling still stops a
 * genuinely wedged read well inside the drive's own watchdog.
 */
const SNAPSHOT_MS_PER_ROW = 400;
const SNAPSHOT_TIMEOUT_CEILING_MS = 90_000;

export interface DragDriveResult {
  ok: boolean;
  /** Human-readable outcome (hop count, rung) or the refusal reason. */
  detail: string;
  /** A gesture may have landed before the failure — recovery state, honestly. */
  recovered?: boolean;
  /**
   * The collapse rung folded these sidebar areas away to clear the path, and put
   * every one of them back. Present only when the rung actually ran, so an
   * ordinary move carries nothing (SBCOL1).
   */
  collapsed?: string[];
  /**
   * A collapsed area the driver could NOT re-expand. The disclosure state lives
   * in the app's own preferences and SURVIVES a relaunch (SBCOL1 §3), so a
   * failed restore is a durable change to the user's sidebar and is never
   * silent — even on an otherwise successful move.
   */
  restoreFailed?: string[];
}

/** One area the collapse rung folded away, with what it looked like beforehand. */
interface CollapsedArea {
  title: string;
  /** Which same-titled row (visual order), or -1 when the title is unique. */
  ordinal: number;
  /**
   * Rows the section rendered while expanded — the re-expansion oracle. Null
   * when the fold's own re-census never answered: the click went out, so the
   * area must still be put back, but there is no measured "before" to aim at.
   */
  rowsExpanded: number | null;
}

/**
 * What one chevron actuation did. `clicked` and `ok` are DELIBERATELY separate:
 * a click that went out but could not be verified has still changed the app,
 * and the ledger keys off `clicked` so such a fold is never forgotten.
 */
type ToggleOutcome =
  | { clicked: true; ok: true; rowsBefore: number; rowsAfter: number }
  | { clicked: boolean; ok: false; why: string };

interface DriveCtx {
  run: UiRunner;
  state: () => AreaSidebarState;
  sleep: (ms: number) => Promise<void>;
  /**
   * The caller's own area titles — what makes the sidebar locator SEMANTIC
   * rather than geometric (SBRES1). Read once per drive from the pre-state.
   */
  areaTitles: readonly string[];
  /**
   * Live per-drive read state, carried so a cost paid once is not paid again.
   * `depth` is the harvest depth the last read had to escalate to (see
   * SNAPSHOT_TIMEOUT_MS); `rows` is the sidebar's measured size, which is what
   * the snapshot budget scales from.
   */
  read: { depth?: number; rows?: number; scrollbar?: boolean };
}

async function runCmd(ctx: DriveCtx, cmd: UiCommand): Promise<UiRunResult> {
  return ctx.run(cmd, STEP_TIMEOUT_MS);
}

/**
 * The sidebar read's own budget, scaled by the sidebar's MEASURED size.
 *
 * A flat 30s was the #672 field failure: a 174-row sidebar on real hardware
 * blew through it and the drive died before a single gesture, with copy that
 * blamed the machine. The read's cost is dominated by synchronous AX
 * round-trips into Things' main thread, so it scales with row count — and a
 * budget that does not scale with the same thing is a budget that fails on
 * exactly the large sidebars this rung exists to serve.
 *
 * The first read has nothing measured yet and gets the ceiling; every later one
 * is sized from what the first actually found. Raising a budget is the weaker
 * half of the fix — the confined escalation and the `textOf` depth guard are
 * what made the read fast — but a large sidebar on a busy Mac still deserves
 * headroom rather than a refusal.
 */
export function snapshotTimeoutMs(rows: number | undefined): number {
  if (rows === undefined) return SNAPSHOT_TIMEOUT_CEILING_MS;
  return Math.min(
    SNAPSHOT_TIMEOUT_CEILING_MS,
    Math.max(STEP_TIMEOUT_MS, Math.round(rows * SNAPSHOT_MS_PER_ROW)),
  );
}

async function takeSnapshot(ctx: DriveCtx): Promise<SnapshotOutcome> {
  const res = await ctx.run(
    snapshotCommand(ctx.areaTitles, ctx.read.depth),
    snapshotTimeoutMs(ctx.read.rows),
  );
  if (res.timedOut === true) return { ok: false, why: "timeout" };
  if (!res.ok) {
    return { ok: false, why: "dispatch-failed", ...(res.stderr.trim() && { stderr: res.stderr }) };
  }
  const out = parseSidebarSnapshot(res.stdout);
  if (out.ok) {
    // Remember what this read cost so the next one does not rediscover it.
    ctx.read.rows = out.snapshot.rows.length;
    if (out.snapshot.escalated === true && out.snapshot.depth !== undefined) {
      ctx.read.depth = out.snapshot.depth;
    }
    if (out.snapshot.scroll !== null) ctx.read.scrollbar = true;
    trace(() => ({
      phase: "sidebar-snapshot",
      rows: out.snapshot.rows.length,
      depth: out.snapshot.depth ?? null,
      escalated: out.snapshot.escalated ?? false,
      matched: out.snapshot.matched ?? null,
      expected: out.snapshot.expected ?? null,
      scroll: out.snapshot.scroll,
      budgetMs: snapshotTimeoutMs(ctx.read.rows),
    }));
  }
  return out;
}

/** The snapshot when only its presence matters (scroll loops, re-censuses). */
async function snapshotOrNull(ctx: DriveCtx): Promise<SidebarSnapshot | null> {
  const out = await takeSnapshot(ctx);
  return out.ok ? out.snapshot : null;
}

/**
 * One honest sentence per real cause, each naming the thing to change. The
 * remediation matters as much as the diagnosis: the old copy told a user with a
 * plainly-open sidebar to check whether the sidebar was open.
 */
export function describeSnapshotFailure(refusal: SnapshotRefusal): string {
  switch (refusal.why) {
    case "timeout":
      return (
        `reading the sidebar took longer than ${Math.round(STEP_TIMEOUT_MS / 1000)}s and was ` +
        "stopped — nothing was dragged. This is a very large sidebar, a busy Mac, or both; " +
        "collapse some areas or close other windows and re-run"
      );
    case "dispatch-failed":
      return `the sidebar read did not run${refusal.stderr ? `: ${refusal.stderr.trim()}` : ""}`;
    case "unparsable":
      return "the sidebar read returned output this version cannot read";
    case "no-window":
      return (
        "Things is running but has no open window — only the placeholder it keeps in the " +
        "background. Open the Things window (click its Dock icon) and re-run"
      );
    case "no-list-candidates":
      return (
        "the Things window exposes no list at all — it may still be opening. Wait for it to " +
        "finish drawing and re-run"
      );
    case "sidebar-hidden":
      return (
        "the sidebar is hidden in this Things window — show it with View ▸ Show Sidebar (⌘/) " +
        "and re-run"
      );
    case "no-title-match": {
      const where =
        refusal.searched === undefined
          ? ""
          : ` (searched ${refusal.searched.length} list(s): ${refusal.searched
              .map((s) => `${s.rows} row(s)${s.frame ? ` at ${Math.round(s.frame.w)}pt wide` : ""}`)
              .join(", ")})`;
      return (
        `none of the lists in the Things window holds a row for any of your ${refusal.titles ?? 0} ` +
        `area(s)${where} — the sidebar may be scrolled inside a different window, or a Things ` +
        "update may have changed how it exposes rows"
      );
    }
    case "ambiguous-sidebar":
      return (
        "two lists in the Things window both look like the sidebar, so nothing was dragged — " +
        "close the extra Things window (File ▸ Close) and re-run"
      );
    case "no-viewport":
      return "the sidebar's scrolling container did not resolve";
    case "no-rows":
      return "the sidebar resolved but exposed no rows — quit and reopen Things, then retry";
  }
}

/**
 * Why a scroll loop stopped. These were ONE sentence until SBSCR1 — every one
 * of them reached the field as `"X"'s row could not be scrolled into view`,
 * which is how #672 could not say whether the wheel had been rejected, accepted
 * and ignored, or never sent at all. `reached` is the success case.
 */
export type ScrollStop =
  | "reached"
  | "snapshot-failed"
  | "scroll-dispatch-failed"
  | "scroll-no-effect"
  | "pinned-at-boundary"
  | "iteration-limit";

/** One turn of the scroll loop, recorded whether or not anyone is listening. */
export interface ScrollIteration {
  iteration: number;
  /** The frame the loop was aiming at, and the band it was aiming into. */
  targetRow: SidebarRect | null;
  viewport: SidebarRect;
  pixelError: number;
  mechanism: "scrollbar" | "wheel";
  /** Scrollbar: the fraction asked for. Wheel: the signed click count. */
  requested: number;
  direction: 1 | -1;
  dispatch: "ok" | "failed" | "timeout";
  /** The dispatcher's own words when it refused. */
  dispatchDetail?: string;
  targetRowAfter?: SidebarRect | null;
  /** Pixels the content actually travelled since the previous turn. */
  measuredMovement: number | null;
  scrollBefore: number | null;
  scrollAfter: number | null;
  /** First/last row index inside the visible band, before and after. */
  visibleRowsBefore: [number, number] | null;
  visibleRowsAfter: [number, number] | null;
  stalls: number;
}

export interface ScrollOutcome {
  /** The satisfied snapshot, or null on every terminal reason but `reached`. */
  snapshot: SidebarSnapshot | null;
  reason: ScrollStop;
  iterations: ScrollIteration[];
}

/** Index range of the rows whose centers lie inside the band. */
function visibleRowRange(snap: SidebarSnapshot): [number, number] | null {
  if (snap.viewport === null) return null;
  const ordered = snap.rows.toSorted((a, b) => a.y - b.y);
  let first = -1;
  let last = -1;
  for (const [i, row] of ordered.entries()) {
    if (!inBand(row.y + row.h / 2, snap.viewport, 0)) continue;
    if (first < 0) first = i;
    last = i;
  }
  return first < 0 ? null : [first, last];
}

/** The scrollable travel this snapshot implies, in pixels (never below 1). */
function scrollableSpan(snap: SidebarSnapshot): number {
  if (snap.viewport === null || snap.rows.length === 0) return 1;
  const top = Math.min(...snap.rows.map((r) => r.y));
  const bottom = Math.max(...snap.rows.map((r) => r.y + r.h));
  return Math.max(1, bottom - top - snap.viewport.h);
}

/**
 * Scroll until `wanted(snapshot)` returns a zero-ish error, re-resolving frames
 * after every scroll (AXDRAG1: frames must be re-read post-scroll). `wanted`
 * returns the pixel error to correct (positive = rows must move down) or null
 * when satisfied.
 *
 * The mechanism is the scroll bar's own `AXValue` when the sidebar exposes one
 * (SBSCR1 §2) — deterministic, linear, and independent of where the pointer
 * happens to be. The wheel remains as the fallback for a scroll area with no
 * bar, and it keeps the self-calibration it always had, plus the fix for the
 * trap that calibration contained: the loop could only learn its sign
 * convention from MEASURED travel, so a wrong-way scroll into a boundary moved
 * nothing, taught it nothing, and was declared "pinned" after two turns. A
 * stall now flips the direction and tries the other way before giving up.
 */
async function scrollUntil(
  ctx: DriveCtx,
  wanted: (snap: SidebarSnapshot) => number | null,
  goodEnough?: (snap: SidebarSnapshot) => boolean,
): Promise<ScrollOutcome> {
  const iterations: ScrollIteration[] = [];
  const done = (snapshot: SidebarSnapshot | null, reason: ScrollStop): ScrollOutcome => {
    const outcome: ScrollOutcome = { snapshot, reason, iterations };
    trace(() => ({ phase: "sidebar-scroll-loop", reason, iterations }));
    return outcome;
  };

  let dirFactor: 1 | -1 = 1;
  let pxPerClick = PX_PER_CLICK_SEED; // replaced by measured travel after scroll 1
  let lastErr: number | null = null;
  let lastRequest = 0;
  let stalls = 0;
  let flipped = false;

  for (let iter = 0; iter < MAX_SCROLL_ITER; iter++) {
    // each scroll must observe the frames the previous scroll produced
    const snap = await snapshotOrNull(ctx);
    if (snap === null) return done(null, "snapshot-failed");
    const err = wanted(snap);
    if (err === null) return done(snap, "reached");
    if (snap.viewport === null) return done(null, "snapshot-failed");

    const useBar = snap.scroll !== null;
    const before = visibleRowRange(snap);
    const rec: ScrollIteration = {
      iteration: iter,
      targetRow: null,
      viewport: snap.viewport,
      pixelError: err,
      mechanism: useBar ? "scrollbar" : "wheel",
      requested: 0,
      direction: err < 0 ? -1 : 1,
      dispatch: "ok",
      measuredMovement: null,
      scrollBefore: snap.scroll,
      scrollAfter: null,
      visibleRowsBefore: before,
      visibleRowsAfter: null,
      stalls,
    };

    if (lastErr !== null && lastRequest !== 0) {
      const moved = lastErr - err; // px the content actually travelled
      rec.measuredMovement = moved;
      if (Math.abs(moved) < 2) {
        stalls += 1;
        rec.stalls = stalls;
        // A wheel scroll that moved nothing teaches the calibration nothing —
        // including whether it was pushing the right way. Try the other way
        // ONCE before concluding the list is pinned (SBSCR1 §7).
        if (!useBar && !flipped) {
          flipped = true;
          dirFactor = dirFactor === 1 ? -1 : 1;
        } else if (stalls >= 2) {
          // Two distinct facts wear one word unless they are separated. The
          // scroll POSITION either moved or it did not: a bar that accepted a
          // new value while the rows stayed put is a surface that ignored us
          // (`scroll-no-effect`); a bar that would not leave its value is a list
          // already at the end of its range (`pinned-at-boundary`). Settle for
          // the achieved state either way when the caller says it is workable.
          const ok = goodEnough !== undefined && goodEnough(snap);
          const positionMoved =
            rec.scrollBefore !== null &&
            iterations.at(-1)?.scrollBefore !== null &&
            iterations.at(-1)?.scrollBefore !== rec.scrollBefore;
          iterations.push(rec);
          if (ok) return done(snap, "reached");
          return done(null, positionMoved ? "scroll-no-effect" : "pinned-at-boundary");
        }
      } else {
        stalls = 0;
        rec.stalls = 0;
        if (useBar) {
          pxPerClick = Math.max(1, Math.abs(moved / lastRequest));
        } else {
          // Calibrate from the MEASURED travel of the previous scroll.
          pxPerClick = Math.min(120, Math.max(4, Math.abs(moved / lastRequest)));
          // Moved the wrong way → the wheel sign convention is flipped here.
          if (Math.sign(moved) !== Math.sign(lastRequest)) dirFactor = dirFactor === 1 ? -1 : 1;
        }
      }
    }
    lastErr = err;

    let res: UiRunResult;
    if (useBar) {
      // The scroll bar is an ABSOLUTE position, so there is no sign convention
      // to learn and no direction to get wrong: compute the fraction the error
      // asks for and write it. `pxPerClick` here is px per unit of fraction,
      // seeded from the snapshot's own geometry and then measured.
      if (lastRequest === 0) pxPerClick = scrollableSpan(snap);
      const delta = -err / pxPerClick;
      const current = snap.scroll ?? 0;
      const target = Math.max(0, Math.min(1, current + delta));
      lastRequest = target - current;
      rec.requested = target;
      rec.direction = lastRequest < 0 ? -1 : 1;
      if (Math.abs(lastRequest) < 1e-6) {
        // Already at the boundary the error points toward — no write can help.
        iterations.push(rec);
        const ok = goodEnough !== undefined && goodEnough(snap);
        return done(ok ? snap : null, ok ? "reached" : "pinned-at-boundary");
      }
      res = await runCmd(ctx, scrollToCommand(target, ctx.areaTitles));
    } else {
      // A wheel click is a QUANTUM: below half of one, the smallest step
      // available overshoots and the loop can only oscillate around the aim
      // until its budget runs out. Stop and say so — an 18-iteration burn that
      // ends in `iteration-limit` describes the budget, not the geometry.
      if (lastRequest !== 0 && Math.abs(err) < pxPerClick / 2) {
        iterations.push(rec);
        const ok = goodEnough !== undefined && goodEnough(snap);
        return done(ok ? snap : null, ok ? "reached" : "scroll-no-effect");
      }
      const clicks =
        Math.max(-12, Math.min(12, Math.round(err / pxPerClick) || Math.sign(err))) * dirFactor;
      lastRequest = clicks;
      rec.requested = clicks;
      rec.direction = clicks < 0 ? -1 : 1;
      res = await runCmd(ctx, scrollCommand(clicks, ctx.areaTitles));
    }

    if (res.timedOut === true) {
      rec.dispatch = "timeout";
      iterations.push(rec);
      return done(null, "scroll-dispatch-failed");
    }
    if (!res.ok) {
      rec.dispatch = "failed";
      if (res.stderr.trim()) rec.dispatchDetail = res.stderr.trim();
      iterations.push(rec);
      return done(null, "scroll-dispatch-failed");
    }
    // The scrollbar primitive REPORTS its own write. An accepted command whose
    // AX write was refused is a different failure from a wheel event that went
    // nowhere, and the field must be able to tell them apart (#672).
    if (useBar) {
      const said = readScrollReport(res.stdout);
      if (said !== null) {
        rec.scrollAfter = said.after;
        if (!said.ok) {
          rec.dispatch = "failed";
          rec.dispatchDetail = said.detail;
          iterations.push(rec);
          return done(null, "scroll-dispatch-failed");
        }
      }
    }
    iterations.push(rec);
  }
  return done(null, "iteration-limit");
}

/** What the pointerless scroll primitive said about its own write. */
function readScrollReport(
  stdout: string,
): { ok: boolean; after: number | null; detail: string } | null {
  try {
    const p = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const why = typeof p["why"] === "string" ? p["why"] : null;
    const ax = typeof p["axError"] === "number" ? p["axError"] : null;
    return {
      ok: p["ok"] === true,
      after: typeof p["after"] === "number" ? p["after"] : null,
      detail: why ?? (ax === null ? "the scroll bar refused the write" : `AXError ${ax}`),
    };
  } catch {
    return null;
  }
}

/**
 * The scroll loop's own account, in one clause: what stopped it, how far it
 * got, and what the last turn measured. This rides the FAILURE payload
 * unconditionally (the diagnostic ladder's middle rung), so a field report
 * never again has to guess which of five causes it hit.
 */
export function describeScrollStop(outcome: ScrollOutcome): string {
  const last = outcome.iterations.at(-1);
  const parts = [`scroll-stop=${outcome.reason}`, `${outcome.iterations.length} iteration(s)`];
  if (last !== undefined) {
    parts.push(
      `mechanism ${last.mechanism}`,
      `last error ${Math.round(last.pixelError)}pt`,
      `last movement ${last.measuredMovement === null ? "n/a" : `${Math.round(last.measuredMovement)}pt`}`,
      `dispatch ${last.dispatch}`,
      `scroll ${last.scrollBefore === null ? "n/a" : last.scrollBefore.toFixed(3)}`,
    );
    if (last.dispatchDetail !== undefined) parts.push(last.dispatchDetail);
  }
  return parts.join("; ");
}

/** Poll the DB until `check` passes or the attempts run out. */
async function pollState(
  ctx: DriveCtx,
  check: (state: AreaSidebarState) => boolean,
): Promise<AreaSidebarState | null> {
  for (let i = 0; i < ASSERT_ATTEMPTS; i++) {
    const state = ctx.state();
    if (check(state)) return state;
    // polling the same DB condition is inherently sequential
    await ctx.sleep(ASSERT_DELAY_MS);
  }
  return null;
}

// ------------------------------------------------- the collapse rung (SBCOL1)

/** How many table rows a titled section currently renders (its own row included). */
function sectionRowCount(
  snap: SidebarSnapshot,
  areaTitles: readonly string[],
  title: string,
  ordinal: number,
): number | null {
  const ordered = areaRowsInOrder(snap.rows, areaTitles);
  const i =
    ordinal < 0 ? ordered.findIndex((a) => a.title === title) : nthByTitle(ordered, title, ordinal);
  const section = ordered[i];
  if (i < 0 || section === undefined) return null;
  const tableBottom = snap.rows.reduce((max, r) => Math.max(max, r.y + r.h), -Infinity);
  const bottom = ordered[i + 1]?.row.y ?? tableBottom;
  return snap.rows.filter((r) => r.y >= section.row.y && r.y < bottom).length;
}

/**
 * Scroll the named area's row into the visible band, then actuate its chevron
 * and CONFIRM the section changed size.
 *
 * The scrutiny doctrine's probe law in production form: a re-census follows the
 * one input step, and a click that did not move the section fast-fails — the
 * ladder must never proceed on the assumption that a gesture worked. `want`
 * says which direction counts as success, so the same primitive collapses and
 * re-expands.
 */
async function toggleDisclosure(
  ctx: DriveCtx,
  areaTitles: readonly string[],
  title: string,
  ordinal: number,
  want: "fewer" | "more",
): Promise<ToggleOutcome> {
  // The row must be inside the band before the chevron can be clicked: an
  // off-viewport row still exposes a valid virtualized frame (AXDRAG1), so an
  // unscrolled click would land outside the sidebar entirely.
  const scrolled = await scrollUntil(ctx, (s) => {
    if (s.viewport === null) return null;
    const row = resolveAreaRow(s.rows, title, ordinal);
    if (row === null) return null;
    const center = row.y + row.h / 2;
    if (inBand(center, s.viewport)) return null;
    return s.viewport.y + s.viewport.h / 2 - center;
  });
  const ready = scrolled.snapshot;
  if (ready === null) {
    // The human sentence stays; the STRUCTURED reason rides beside it, because
    // five distinct causes wearing one sentence is what made #672 unanswerable.
    return {
      clicked: false,
      ok: false,
      why: `"${title}"'s row could not be scrolled into view (${describeScrollStop(scrolled)})`,
    };
  }
  const rowsBefore = sectionRowCount(ready, areaTitles, title, ordinal);
  if (rowsBefore === null) {
    return { clicked: false, ok: false, why: `"${title}"'s row did not resolve` };
  }
  // the gesture must land before the re-census that judges it
  const res = await runCmd(ctx, chevronClickCommand(title, ordinal, ctx.areaTitles));
  let clicked = false;
  let why = "the disclosure arrow did not respond";
  if (res.ok) {
    try {
      const parsed = JSON.parse(res.stdout.trim()) as { clicked?: boolean; why?: string };
      clicked = parsed.clicked === true;
      if (typeof parsed.why === "string") why = parsed.why;
    } catch {
      /* keep the default reason */
    }
  }
  if (!clicked) return { clicked: false, ok: false, why };
  // The click WENT OUT. Everything below reports `clicked: true` even when it
  // fails, because the app has already changed its state and a verification
  // that could not run is not evidence that nothing happened. SBCOL1 §6 found
  // this the hard way: quitting Things during the re-census left the area
  // collapsed on disk while the ledger — written only on success — held
  // nothing, so a durable change to the sidebar went unmentioned. The ledger
  // records what the driver DID, not what it managed to confirm.
  //
  // RE-CENSUS after the input step — a gesture whose effect we cannot see is
  // still never allowed to carry the ladder forward.
  await ctx.sleep(600);
  const after = await takeSnapshot(ctx);
  if (!after.ok) {
    return { clicked: true, ok: false, why: describeSnapshotFailure(after) };
  }
  const rowsAfter = sectionRowCount(after.snapshot, areaTitles, title, ordinal);
  if (rowsAfter === null) {
    return { clicked: true, ok: false, why: `"${title}"'s row did not resolve after the click` };
  }
  const moved = want === "fewer" ? rowsAfter < rowsBefore : rowsAfter > rowsBefore;
  if (!moved) {
    return {
      clicked: true,
      ok: false,
      why: `the click left "${title}" rendering ${rowsAfter} row(s) — the section did not ${
        want === "fewer" ? "collapse" : "re-expand"
      }`,
    };
  }
  return { clicked: true, ok: true, rowsBefore, rowsAfter };
}

/**
 * Fold every blocking section away, recording what to put back. Stops at the
 * FIRST section it cannot collapse — a half-cleared path is not a path, and the
 * caller falls through to the honest refusal (with the already-collapsed areas
 * restored by the epilogue like any other exit).
 */
async function collapseWalls(
  ctx: DriveCtx,
  walls: SidebarSectionSpan[],
  areaTitles: readonly string[],
  collapsed: CollapsedArea[],
): Promise<{ ok: boolean; why?: string }> {
  for (const wall of walls) {
    // Already folded and STILL measuring as a wall: the gesture is not working
    // on this section, so stop rather than clicking at it again.
    if (collapsed.some((c) => c.title === wall.title && c.ordinal === wall.ordinal)) {
      return { ok: false, why: `"${wall.title}" stayed oversized after it was collapsed` };
    }
    // each collapse must be verified before the next one is attempted
    const outcome = await toggleDisclosure(ctx, areaTitles, wall.title, wall.ordinal, "fewer");
    // Ledger on the CLICK, not on the confirmation (SBCOL1 §6): a fold that
    // went out and could not be verified is still a fold to answer for.
    if (outcome.clicked) {
      collapsed.push({
        title: wall.title,
        ordinal: wall.ordinal,
        rowsExpanded: outcome.ok ? outcome.rowsBefore : null,
      });
    }
    if (!outcome.ok) return { ok: false, why: outcome.why };
  }
  return { ok: true };
}

/**
 * Put the sidebar back — in REVERSE order, so the list reflows the way it was
 * folded. Runs on EVERY exit path (success, refusal, abort, throw): the
 * disclosure state lives in the app's preferences and survives a relaunch
 * (SBCOL1 §3), so an unrestored collapse is a durable change to the user's
 * sidebar that they never asked for.
 */
async function restoreDisclosure(
  ctx: DriveCtx,
  areaTitles: readonly string[],
  collapsed: CollapsedArea[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const entry of collapsed.toReversed()) {
    // each re-expansion must be verified before the next one is attempted
    const outcome = await toggleDisclosure(ctx, areaTitles, entry.title, entry.ordinal, "more");
    if (!outcome.ok) failed.push(entry.title);
  }
  return failed;
}

/** Append the collapse rung's own account to whatever the ladder concluded. */
function withCollapseOutcome(
  result: DragDriveResult,
  collapsed: CollapsedArea[],
  restoreFailed: string[],
): DragDriveResult {
  if (collapsed.length === 0) return result;
  const names = collapsed.map((c) => `"${c.title}"`).join(", ");
  const restored =
    restoreFailed.length === 0
      ? "and expanded again afterwards"
      : `but ${restoreFailed.map((t) => `"${t}"`).join(", ")} could not be expanded again — ` +
        "the sidebar is left collapsed there until you click the arrow (or Things is relaunched, " +
        "which keeps it collapsed)";
  return {
    ...result,
    detail: `${result.detail} (${names} collapsed to clear the path, ${restored})`,
    collapsed: collapsed.map((c) => c.title),
    ...(restoreFailed.length > 0 && { restoreFailed }),
  };
}

interface PlannedDrop {
  source: SidebarRowInfo;
  dropY: number;
  anchor: string;
}

/** Resolve source row + corrected drop Y against ONE snapshot generation. */
function planDrop(
  snap: SidebarSnapshot,
  spec: SidebarDragSpec,
  areaTitles: readonly string[],
  placement: SidebarPlacement,
  // DUPLICATE-title disambiguation (ORDFIN2 AXDRAG3), recomputed from live state
  // by the driver each hop: `sourceRank` = which same-titled row is the target,
  // `anchorRank` = which same-titled row is the before/after anchor; -1 = unique.
  ranks: { sourceRank: number; anchorRank: number } = { sourceRank: -1, anchorRank: -1 },
): PlannedDrop | { error: string } {
  const source = resolveAreaRow(snap.rows, spec.targetTitle, ranks.sourceRank);
  if (source === null) {
    return {
      error:
        `the sidebar row for "${spec.targetTitle}" did not resolve uniquely by its visible ` +
        "name — after many drags in one app session a sidebar row can stop exposing its " +
        "name until Things is relaunched (AXDRAG2); quit and reopen Things, then retry",
    };
  }
  const ordered = areaRowsInOrder(snap.rows, areaTitles);
  const boundary = staticBoundaryY(
    ordered,
    snap.rows,
    spec.targetTitle,
    placement,
    ranks.anchorRank,
  );
  if ("error" in boundary) return boundary;
  const span = sourceGroupSpan(ordered, spec.targetTitle, snap.rows);
  const sourceCenter = source.y + source.h / 2;
  return {
    source,
    dropY: correctedDropY(boundary.y, sourceCenter, span),
    anchor: boundary.anchor,
  };
}

/** One drag gesture from the source row to the corrected boundary. */
async function performDrag(ctx: DriveCtx, drop: PlannedDrop): Promise<boolean> {
  const grab = grabPoint(drop.source);
  const res = await runCmd(ctx, dragCommand(grab.x, grab.y, grab.x, drop.dropY));
  return res.ok && res.stdout.includes("DONE");
}

/**
 * The rung-2 anchor: every placement reduces to "drop above this area row"
 * (title) or "drop below the last row" (null). `undefined` = unresolvable.
 */
export function rung2AnchorTitle(
  rows: SidebarRowInfo[],
  areaTitles: readonly string[],
  sourceTitle: string,
  placement: SidebarPlacement,
): string | null | undefined {
  const others = areaRowsInOrder(rows, areaTitles).filter((a) => a.title !== sourceTitle);
  if (others.length === 0) return undefined;
  switch (placement.kind) {
    case "first":
      return (others[0] as { title: string }).title;
    case "last":
      return null;
    case "before":
      return others.some((a) => a.title === placement.title) ? placement.title : undefined;
    case "after": {
      const i = others.findIndex((a) => a.title === placement.title);
      if (i < 0) return undefined;
      const next = others[i + 1];
      return next === undefined ? null : next.title;
    }
  }
}

function parseHeldDragResult(res: UiRunResult): { dropped: boolean; ticks?: number } {
  if (!res.ok) return { dropped: false };
  try {
    const parsed = JSON.parse(res.stdout.trim()) as { dropped?: boolean; ticks?: number };
    return parsed.dropped === true
      ? { dropped: true, ...(typeof parsed.ticks === "number" && { ticks: parsed.ticks }) }
      : { dropped: false };
  } catch {
    return { dropped: false };
  }
}

function invariantsHold(pre: AreaSidebarState, now: AreaSidebarState): boolean {
  return now.areas.length === pre.areas.length && now.assignmentsDigest === pre.assignmentsDigest;
}

/**
 * Drive the full ladder. `preState` is captured ONCE up front for the whole
 * move (recovery + the caller's undo capture both key off it, not per hop).
 */
export async function driveSidebarAreaReorder(
  spec: SidebarDragSpec,
  run: UiRunner,
  aux: UiDriveAux,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<DragDriveResult> {
  if (aux.areaState === undefined) {
    return {
      ok: false,
      detail:
        "the sidebar drag driver has no database seam on this surface — this operation can " +
        "only run through the full client",
    };
  }
  const areaTitlesForRestore = aux.areaState().areas.map((a) => a.title);
  const ctx: DriveCtx = {
    run,
    state: aux.areaState,
    sleep,
    areaTitles: areaTitlesForRestore,
    read: {},
  };
  // The collapse rung's ledger, owned OUT HERE so the restore epilogue covers
  // every way the ladder can end — including a throw (FGRD2 cleanup shape).
  const collapsed: CollapsedArea[] = [];
  // The chrome ledger, same shape and for the same reason: a sidebar this drive
  // revealed is hidden again on EVERY exit path. The user's window chrome is
  // theirs; a move must not silently leave it changed (SBCOL1 precedent).
  const chrome: ChromeLedger = { revealedSidebar: false };
  try {
    const result = await runDragLadder(ctx, spec, collapsed, chrome);
    // the ladder (and any recovery drag inside it) must finish before the
    // sidebar is folded back — the recovery needs the cleared path too
    const restoreFailed = await restoreDisclosure(ctx, areaTitlesForRestore, collapsed);
    const chromeNote = await restoreChrome(ctx, chrome);
    return withChromeOutcome(withCollapseOutcome(result, collapsed, restoreFailed), chromeNote);
  } catch (err) {
    // the sidebar is put back even when the ladder blew up
    await restoreDisclosure(ctx, areaTitlesForRestore, collapsed);
    await restoreChrome(ctx, chrome);
    throw err;
  }
}

/** Window chrome this drive changed to make the sidebar drivable (SBRES1). */
interface ChromeLedger {
  /** The drive ran View ▸ Show Sidebar; the epilogue must hide it again. */
  revealedSidebar: boolean;
}

/**
 * NORMALIZATION RUNG (SBRES1): a hidden sidebar is not a dead end.
 *
 * Things' View ▸ Show Sidebar is a real, documented command, so the drive uses
 * it — and then CLOSES THE LOOP, exactly as the determinism doctrine requires:
 * the reveal only counts once a fresh snapshot resolves. A click that went out
 * is ledgered whether or not it verified, because the app has already changed.
 */
async function revealSidebar(
  ctx: DriveCtx,
  chrome: ChromeLedger,
): Promise<{ ok: true; snapshot: SidebarSnapshot } | { ok: false; why: string }> {
  const res = await runCmd(ctx, sidebarVisibilityCommand("show"));
  let clicked = false;
  let why = "the View menu did not respond";
  if (res.ok) {
    try {
      const parsed = JSON.parse(res.stdout.trim()) as { clicked?: boolean; why?: string };
      clicked = parsed.clicked === true;
      if (typeof parsed.why === "string" && parsed.why !== "") why = parsed.why;
    } catch {
      /* keep the default reason */
    }
  }
  if (!clicked) return { ok: false, why };
  chrome.revealedSidebar = true;
  await ctx.sleep(600);
  const after = await takeSnapshot(ctx);
  if (after.ok) return { ok: true, snapshot: after.snapshot };
  return { ok: false, why: describeSnapshotFailure(after) };
}

/** Put the window chrome back. Runs on every exit path. */
async function restoreChrome(ctx: DriveCtx, chrome: ChromeLedger): Promise<string | null> {
  if (!chrome.revealedSidebar) return null;
  const res = await runCmd(ctx, sidebarVisibilityCommand("hide"));
  let clicked = false;
  if (res.ok) {
    try {
      clicked = (JSON.parse(res.stdout.trim()) as { clicked?: boolean }).clicked === true;
    } catch {
      clicked = false;
    }
  }
  return clicked
    ? "the sidebar was shown to run the move and hidden again afterwards"
    : "the sidebar was shown to run the move and could NOT be hidden again — hide it with " +
        "View ▸ Hide Sidebar (⌘/)";
}

function withChromeOutcome(result: DragDriveResult, note: string | null): DragDriveResult {
  return note === null ? result : { ...result, detail: `${result.detail} (${note})` };
}

/** The ladder proper. Its caller owns the collapse ledger and the restore. */
async function runDragLadder(
  ctx: DriveCtx,
  spec: SidebarDragSpec,
  collapsed: CollapsedArea[],
  chrome: ChromeLedger,
): Promise<DragDriveResult> {
  const pre = ctx.state();
  const preTies = hasRankTies(pre);
  const areaTitles = pre.areas.map((a) => a.title);

  // DUPLICATE-title positional disambiguation (ORDFIN2 AXDRAG3). Recomputed from
  // LIVE state each hop so the target's rank among its same-titled siblings stays
  // correct as it drags past one (its `(index, uuid)` rank and its visual row
  // shift together). -1 on both = a unique-titled move (the ordinary path).
  const ranksNow = (): { sourceRank: number; anchorRank: number } => {
    const areas = ctx.state().areas;
    const p = spec.placement;
    return {
      sourceRank: areaTitleRank(areas, spec.targetUuid, spec.targetTitle),
      anchorRank:
        p.kind === "before" || p.kind === "after" ? areaTitleRank(areas, p.uuid, p.title) : -1,
    };
  };
  const isDuplicateMove = ranksNow().sourceRank >= 0 || ranksNow().anchorRank >= 0;

  if (positionOf(pre, spec.targetUuid) < 0) {
    return { ok: false, detail: `area ${spec.targetUuid} no longer exists` };
  }
  if (!preTies && placementSatisfied(pre, spec.targetUuid, spec.placement)) {
    return { ok: true, detail: "already in the requested position — nothing to move" };
  }

  // Remaining-distance metric for the infinite-loop guard (design amendment
  // 2026-07-15): the number of area positions between the target's current
  // slot and its destination slot, DB-read after every hop. Each hop must
  // STRICTLY reduce it; one retry is allowed, then the op aborts reporting
  // where the area ended up (a partially-moved area is benign).
  const distanceIn = (state: AreaSidebarState): number | null => {
    const placement = spec.placement;
    const others = state.areas.filter((a) => a.uuid !== spec.targetUuid);
    const cur = positionOf(state, spec.targetUuid);
    if (cur < 0) return null;
    let want: number;
    switch (placement.kind) {
      case "first":
        want = 0;
        break;
      case "last":
        want = others.length;
        break;
      case "before": {
        const i = others.findIndex((a) => a.uuid === placement.uuid);
        if (i < 0) return null;
        want = i;
        break;
      }
      case "after": {
        const i = others.findIndex((a) => a.uuid === placement.uuid);
        if (i < 0) return null;
        want = i + 1;
        break;
      }
    }
    return Math.abs(want - cur);
  };

  let hops = 0;
  let remaining: number | null = preTies ? null : distanceIn(pre);
  let retried = false;
  // Rung 2 (scroll-while-held) is BUILT and probe-certified (AXDRAG2-a) but
  // ships DISABLED: production certification exposed an app-side instability
  // — after drag+scroll churn the sidebar's AX mirror can drop or blank row
  // elements until Things is relaunched (AXDRAG2-c / oddities), and held
  // travel beyond ~1.5 viewports is the strongest trigger. The certified
  // ladder is rung 1 + the multi-hop floor; THINGS_UI_DRAG_LADDER=held-scroll
  // re-enables rung 2 for lab work. Attempted at most ONCE per move; a clean
  // abort falls through to the floor.
  let heldScrollTried = process.env["THINGS_UI_DRAG_LADDER"] !== "held-scroll";
  // Transient-render tolerance: the first unresolved snapshot gets one
  // settle-and-retry before the drive refuses (the app may still be
  // materializing sidebar rows right after launch/navigation).
  let resolveRetried = false;
  // A benign off-slot landing (invariants intact) lets the ladder CONTINUE
  // from wherever the drop ended — one retry of the final placement, then an
  // honest positional abort. Only invariant damage recovers-and-refuses.
  let finalRetried = false;
  // Absolute backstop: ceil(areas / visible-slots) + 2, refined from the first
  // snapshot's viewport height (each hop covers roughly one viewport).
  let hopCap = Math.min(MAX_HOPS_CEILING, pre.areas.length + 2);

  for (let attempt = 0; attempt <= MAX_HOPS_CEILING; attempt++) {
    // every hop depends on the layout the previous hop produced
    let snapOutcome = await takeSnapshot(ctx);
    // A HIDDEN sidebar is normalized, not refused: Things' own View menu shows
    // it, the epilogue hides it again, and the refusal below is reached only
    // when that fails. Everything else is reported as the cause it actually is.
    if (!snapOutcome.ok && snapOutcome.why === "sidebar-hidden") {
      const revealed = await revealSidebar(ctx, chrome);
      snapOutcome = revealed.ok
        ? { ok: true, snapshot: revealed.snapshot }
        : {
            ok: false,
            why: "sidebar-hidden",
            ...({ stderr: revealed.why } as { stderr: string }),
          };
    }
    if (!snapOutcome.ok) {
      const why =
        snapOutcome.why === "sidebar-hidden" && snapOutcome.stderr !== undefined
          ? `the sidebar is hidden in this Things window and showing it did not work (${snapOutcome.stderr})`
          : describeSnapshotFailure(snapOutcome);
      return refuseOrRecover(ctx, pre, spec, hops, why);
    }
    const snap = snapOutcome.snapshot;
    const viewport = snap.viewport as SidebarRect;
    {
      // ceil(areas / visible-slots) + 2, from the frame-derived slot pitch.
      const pitch = slotPitch(areaRowsInOrder(snap.rows, areaTitles), snap.rows);
      const visibleSlots = Math.max(1, Math.floor(viewport.h / pitch) - 2);
      hopCap = Math.min(MAX_HOPS_CEILING, Math.ceil(pre.areas.length / visibleSlots) + 2);
    }
    // Recompute duplicate-title ranks from live state for THIS hop's planning.
    const ranks = ranksNow();
    const finalPlan = planDrop(snap, spec, areaTitles, spec.placement, ranks);
    if ("error" in finalPlan) {
      if (!resolveRetried) {
        resolveRetried = true;
        // one settle pause before re-reading the tree
        await ctx.sleep(2000);
        continue;
      }
      return refuseOrRecover(ctx, pre, spec, hops, finalPlan.error);
    }
    resolveRetried = false;
    const grab = grabPoint(finalPlan.source);
    const spanNeeded = Math.abs(grab.y - finalPlan.dropY);

    // PRE-FLIGHT (#658, AXDRAG5): every shipped rung needs the grab point and
    // the drop boundary inside the viewport AT ONCE, so a sidebar SECTION taller
    // than one drag's usable span can never be crossed — not by rung 1, and not
    // one hop at a time. Detect it from the geometry BEFORE any gesture and
    // refuse honestly; the old behavior was to hop until no anchor fit and then
    // blame the window size after minutes of AX round-trips.
    if (spanNeeded >= usableDragSpan(viewport)) {
      const orderedNow = areaRowsInOrder(snap.rows, areaTitles);
      const walls = blockingSectionsInSpan(
        orderedNow,
        snap.rows,
        grab.y,
        finalPlan.dropY,
        spec.targetTitle,
        viewport,
      );
      if (walls.length > 0) {
        // COLLAPSE RUNG (SBCOL1). A wall is not a dead end: fold the blocking
        // section(s) away with their disclosure chevrons — each collapse
        // verified by a re-census — and re-plan against the shorter sidebar.
        // The epilogue puts every one of them back.
        // the sidebar must actually fold before the ladder re-plans against it
        const folded = await collapseWalls(ctx, walls, areaTitles, collapsed);
        if (folded.ok) continue; // re-plan from a fresh snapshot
        const wall = walls[0] as SidebarSectionSpan;
        const detail = blockedSectionDetail(
          wall,
          viewport,
          describeAnchor(finalPlan.anchor),
          folded.why,
        );
        return hops === 0
          ? { ok: false, detail }
          : abortPartial(ctx, spec, hops, `${detail} — so the move stopped part-way`);
      }
    }

    // Rung 1: both the grab point and the drop boundary visible (or scrollable
    // into simultaneous view) → one certified drag.
    if (spanNeeded < usableDragSpan(viewport)) {
      let ready: SidebarSnapshot | null = snap;
      if (!inBand(grab.y, viewport) || !inBand(finalPlan.dropY, viewport)) {
        // pre-scroll must land before the drag
        ready = (
          await scrollUntil(ctx, (s) => {
            const p = planDrop(s, spec, areaTitles, spec.placement, ranks);
            if ("error" in p || s.viewport === null) return null;
            const g = grabPoint(p.source);
            if (inBand(g.y, s.viewport) && inBand(p.dropY, s.viewport)) return null;
            const mid = (g.y + p.dropY) / 2;
            const bandMid = s.viewport.y + s.viewport.h / 2;
            return bandMid - mid;
          })
        ).snapshot;
      }
      if (ready !== null) {
        const plan = planDrop(ready, spec, areaTitles, spec.placement, ranks);
        if (!("error" in plan) && ready.viewport !== null) {
          const g = grabPoint(plan.source);
          if (inBand(g.y, ready.viewport) && inBand(plan.dropY, ready.viewport)) {
            // the gesture must land before the DB assert
            const landed = await performDrag(ctx, plan);
            if (!landed) {
              return refuseOrRecover(ctx, pre, spec, hops, "the drag gesture did not complete");
            }
            // the final assert gates success
            const finalState = await pollState(
              ctx,
              (s) =>
                invariantsHold(pre, s) && placementSatisfied(s, spec.targetUuid, spec.placement),
            );
            if (finalState === null) {
              const latest = ctx.state();
              if (!invariantsHold(pre, latest)) {
                return refuseOrRecover(
                  ctx,
                  pre,
                  spec,
                  hops,
                  "the drop changed the area count or an area assignment (it should never)",
                );
              }
              // Benign off-slot landing: let the ladder re-aim once from the
              // new position before giving up.
              if (!finalRetried) {
                finalRetried = true;
                continue;
              }
              // A DUPLICATE-title move that never reached the INTENDED uuid's slot
              // may have dragged the WRONG same-titled area — self-invert (the
              // existing recovery drags the sidebar back to the pre-op order) and
              // report honestly, rather than leaving a mystery move behind.
              if (isDuplicateMove) {
                return refuseOrRecover(
                  ctx,
                  pre,
                  spec,
                  hops,
                  `the drop never reached the intended area's slot — with a duplicate area title ` +
                    `the positional grab may have moved a same-titled sibling`,
                );
              }
              return abortPartial(
                ctx,
                spec,
                hops,
                "the drop kept landing off the requested slot (retried once)",
              );
            }
            return {
              ok: true,
              detail:
                hops === 0
                  ? "moved with one drag (source and destination shared a viewport)"
                  : `moved with ${hops} intermediate hop(s) + the final drag (multi-hop fallback)`,
            };
          }
        }
      }
      // fall through to a hop if simultaneous visibility could not be arranged
    }

    // Rung 2: scroll-while-held (AXDRAG2-a GO) — one atomic gesture that
    // scrolls the list under the held item and drops at the LIVE-resolved
    // boundary. A clean abort (Escape, no drop) falls through to rung 3.
    if (!heldScrollTried) {
      heldScrollTried = true;
      // The source must be grabbable first.
      // the pre-grab scroll must land before the gesture
      const grabbable = (
        await scrollUntil(
          ctx,
          (s) => {
            if (s.viewport === null) return null;
            const src = resolveAreaRow(s.rows, spec.targetTitle, ranks.sourceRank);
            if (src === null) return null;
            const g = grabPoint(src);
            if (inBand(g.y, s.viewport)) return null;
            return s.viewport.y + s.viewport.h / 2 - g.y;
          },
          (s) => {
            if (s.viewport === null) return false;
            const src = resolveAreaRow(s.rows, spec.targetTitle, ranks.sourceRank);
            return src !== null && inBand(grabPoint(src).y, s.viewport);
          },
        )
      ).snapshot;
      if (grabbable !== null && grabbable.viewport !== null) {
        const src = resolveAreaRow(grabbable.rows, spec.targetTitle, ranks.sourceRank);
        const anchor = rung2AnchorTitle(
          grabbable.rows,
          areaTitles,
          spec.targetTitle,
          spec.placement,
        );
        if (src !== null && anchor !== undefined) {
          const g = grabPoint(src);
          const plan2 = planDrop(grabbable, spec, areaTitles, spec.placement, ranks);
          const travel = "error" in plan2 ? viewport.h * 4 : Math.abs(plan2.dropY - g.y);
          // TRAVEL CAP (AXDRAG2-c): held-scroll is proven up to ~1.5 viewport
          // heights; beyond that the app's AX mirror can lose row names for
          // the rest of the session (oddities: sidebar ghost rows), so far
          // moves go straight to the multi-hop floor.
          if (travel > viewport.h * 1.5) continue;
          const maxTicks = Math.min(400, Math.max(20, Math.ceil(travel / 15)));
          // the held gesture must complete before its DB assert
          const res = await runCmd(
            ctx,
            heldScrollDragCommand(g.x, g.y, anchor, maxTicks, ctx.areaTitles),
          );
          const parsed = parseHeldDragResult(res);
          if (parsed.dropped) {
            // the final assert gates success
            const finalState = await pollState(
              ctx,
              (s) =>
                invariantsHold(pre, s) && placementSatisfied(s, spec.targetUuid, spec.placement),
            );
            if (finalState !== null) {
              return {
                ok: true,
                detail:
                  `moved with one scroll-while-held drag (${parsed.ticks ?? "?"} wheel ticks` +
                  `${hops > 0 ? `, after ${hops} hop(s)` : ""})`,
              };
            }
            const latest = ctx.state();
            if (!invariantsHold(pre, latest)) {
              return refuseOrRecover(
                ctx,
                pre,
                spec,
                hops,
                "the scroll-while-held drop changed the area count or an area assignment " +
                  "(it should never)",
              );
            }
            // Benign off-slot landing: rungs 1/3 finish the move from here.
            continue;
          }
          // Clean abort (Escape, nothing dropped) → the multi-hop floor.
        }
      }
      continue;
    }

    // Rung 3: hop one viewport toward the target.
    hops += 1;
    if (hops > hopCap) {
      return abortPartial(
        ctx,
        spec,
        hops - 1,
        `exceeded the hop cap (${hopCap}) without converging`,
      );
    }
    const down = finalPlan.dropY > grab.y;
    // Bring the source into the band, parked toward the trailing edge so the
    // viewport ahead of it is maximal.
    // the hop's park scroll must land before its gesture
    const parked = await scrollUntil(
      ctx,
      (s) => {
        if (s.viewport === null) return null;
        const src = resolveAreaRow(s.rows, spec.targetTitle, ranks.sourceRank);
        if (src === null) return null;
        const g = grabPoint(src);
        const edge = s.viewport.h * 0.15; // park near the trailing edge (frame fraction)
        const desired = down ? s.viewport.y + edge : s.viewport.y + s.viewport.h - edge;
        const err = desired - g.y;
        const tolerance = s.viewport.h * 0.05;
        return Math.abs(err) <= tolerance && inBand(g.y, s.viewport) ? null : err;
      },
      // Scroll pinned before reaching the parking spot: grabbable is enough.
      (s) => {
        if (s.viewport === null) return false;
        const src = resolveAreaRow(s.rows, spec.targetTitle, ranks.sourceRank);
        return src !== null && inBand(grabPoint(src).y, s.viewport);
      },
    );
    const parkedSnap = parked.snapshot;
    if (parkedSnap === null || parkedSnap.viewport === null) {
      // The structured reason rides here too: this is the OTHER site a
      // #672-shaped failure exits from, and a flattened sentence at either one
      // leaves the field guessing exactly as it did before.
      return refuseOrRecover(
        ctx,
        pre,
        spec,
        hops,
        `could not scroll the area's row into view (${describeScrollStop(parked)})`,
      );
    }
    const ordered = areaRowsInOrder(parkedSnap.rows, areaTitles);
    const srcIdx =
      ranks.sourceRank < 0
        ? ordered.findIndex((a) => a.title === spec.targetTitle)
        : nthByTitle(ordered, spec.targetTitle, ranks.sourceRank);
    const source = ordered[srcIdx];
    if (srcIdx < 0 || source === undefined) {
      return refuseOrRecover(ctx, pre, spec, hops, "the area's row vanished after scrolling");
    }
    const span = sourceGroupSpan(ordered, spec.targetTitle, parkedSnap.rows);
    const sourceCenter = source.row.y + source.row.h / 2;
    // Candidate anchors: area rows toward the target whose corrected boundary
    // stays inside the visible band; take the furthest for maximum progress.
    let hopAnchor: { title: string; uuid: string; dropY: number; visualDelta: number } | null =
      null;
    for (let i = 0; i < ordered.length; i++) {
      if (i === srcIdx) continue;
      const cand = ordered[i] as { title: string; row: SidebarRowInfo };
      const isDownCand = i > srcIdx;
      if (isDownCand !== down) continue;
      const visualDelta = Math.abs(i - srcIdx);
      // Dropping ABOVE the anchor: downward needs ≥2 rows of travel to be a
      // real move; upward ≥1.
      if (down && visualDelta < 2) continue;
      const dropY = correctedDropY(boundaryAboveRow(parkedSnap.rows, cand.row), sourceCenter, span);
      if (!inBand(dropY, parkedSnap.viewport)) continue;
      const uuid = pre.areas.find((a) => a.title === cand.title)?.uuid ?? "";
      if (hopAnchor === null || visualDelta > hopAnchor.visualDelta) {
        hopAnchor = { title: cand.title, uuid, dropY, visualDelta };
      }
    }
    if (hopAnchor === null) {
      // Name the real cause (#658): normally the next area toward the
      // destination begins a section taller than the visible list, which no
      // window size fixes. Only fall back to the generic sentence when the
      // geometry does NOT show such a section.
      const planNow = planDrop(parkedSnap, spec, areaTitles, spec.placement, ranks);
      const wallsHere =
        "error" in planNow
          ? []
          : blockingSectionsInSpan(
              ordered,
              parkedSnap.rows,
              grabPoint(planNow.source).y,
              planNow.dropY,
              spec.targetTitle,
              parkedSnap.viewport,
            );
      if (wallsHere.length > 0) {
        // The same collapse rung, reached from the hop side: the next area
        // toward the destination begins a section taller than the visible list.
        // the fold must land before the ladder re-plans
        const folded = await collapseWalls(ctx, wallsHere, areaTitles, collapsed);
        if (folded.ok) {
          hops -= 1; // the fold is not a hop; the re-plan gets the slot back
          continue;
        }
        return refuseOrRecover(
          ctx,
          pre,
          spec,
          hops,
          blockedSectionDetail(
            wallsHere[0] as SidebarSectionSpan,
            parkedSnap.viewport,
            describeAnchor("error" in planNow ? "the requested position" : planNow.anchor),
            folded.why,
          ),
        );
      }
      return refuseOrRecover(
        ctx,
        pre,
        spec,
        hops,
        "no drop slot toward the destination fits the visible sidebar — the nearest area row " +
          "toward it sits more than one drag away, so the gesture has nowhere to land",
      );
    }
    const anchorUuid = hopAnchor.uuid;
    // the hop gesture must land before its DB assert
    const landed = await performDrag(ctx, {
      source: source.row,
      dropY: hopAnchor.dropY,
      anchor: hopAnchor.title,
    });
    if (!landed) {
      return refuseOrRecover(ctx, pre, spec, hops, "a hop drag gesture did not complete");
    }
    // DB assert after EVERY hop: the source should now sit immediately above
    // the anchor, with the count + assignments invariant.
    // the hop assert gates the next hop
    const hopState = await pollState(
      ctx,
      (s) =>
        invariantsHold(pre, s) &&
        positionOf(s, spec.targetUuid) >= 0 &&
        positionOf(s, spec.targetUuid) + 1 === positionOf(s, anchorUuid),
    );
    if (hopState !== null) {
      // Landed as aimed. Infinite-loop guard: the remaining distance must
      // STRICTLY shrink hop over hop.
      const d = distanceIn(hopState);
      if (remaining !== null && d !== null && d >= remaining) {
        if (retried) {
          return abortPartial(ctx, spec, hops, "two consecutive hops made no progress");
        }
        retried = true;
      } else {
        retried = false;
        if (d !== null) remaining = d;
      }
      continue;
    }
    // The aimed adjacency never showed. Damage (count/assignment change) gets
    // a recovery drag; a benign off-by-slots landing that still progressed is
    // accepted; anything else burns the single retry, then aborts.
    const latest = ctx.state();
    if (!invariantsHold(pre, latest)) {
      return refuseOrRecover(
        ctx,
        pre,
        spec,
        hops,
        `hop ${hops} changed the area count or an area assignment (it should never) `,
      );
    }
    const d = distanceIn(latest);
    if (d !== null && (remaining === null || d < remaining)) {
      remaining = d;
      retried = false;
      continue;
    }
    if (!retried) {
      retried = true;
      continue;
    }
    return abortPartial(
      ctx,
      spec,
      hops,
      `hop ${hops} did not land immediately above "${hopAnchor.title}" and made no progress ` +
        "(retried once)",
    );
  }
  return abortPartial(ctx, spec, hops, "exceeded the hop budget without converging");
}

/** The destination, as the refusal copy names it. */
function describeAnchor(anchor: string): string {
  return anchor === "the end of the sidebar list" || anchor === "the requested position"
    ? anchor
    : `"${anchor}"`;
}

/** Where the area sits RIGHT NOW, for a report that never has to guess. */
function describePosition(state: AreaSidebarState, uuid: string): string {
  const pos = positionOf(state, uuid);
  if (pos < 0) return "the area no longer resolves in the database";
  return (
    `the area now sits at sidebar position ${pos + 1} of ${state.areas.length}` +
    (pos > 0 ? `, below "${state.areas[pos - 1]?.title ?? "?"}"` : ", at the top")
  );
}

/**
 * Abort mid-ladder WITHOUT recovery (design amendment: a partially-moved area
 * is benign) — send Escape as a safety valve and report exactly where the
 * area ended up so the caller can re-run or finish by hand.
 */
async function abortPartial(
  ctx: DriveCtx,
  spec: SidebarDragSpec,
  hops: number,
  why: string,
): Promise<DragDriveResult> {
  await runCmd(ctx, {
    primitive: "key",
    label: "abort (Escape)",
    script: `tell application "System Events" to key code 53`,
  });
  const where = describePosition(ctx.state(), spec.targetUuid);
  return {
    ok: false,
    detail:
      `${why} after ${hops} hop(s); ${where}. Its to-dos and projects are untouched — ` +
      "re-run the move or finish it in the app.",
  };
}

/**
 * One verified recovery attempt: put the area back where the pre-op capture
 * says it was (before its old successor, or to-last), then report the original
 * failure with the recovery outcome appended. Never recurses.
 */
async function refuseOrRecover(
  ctx: DriveCtx,
  pre: AreaSidebarState,
  spec: SidebarDragSpec,
  hops: number,
  why: string,
): Promise<DragDriveResult> {
  const now = ctx.state();
  const orderChanged =
    now.areas.map((a) => a.uuid).join(",") !== pre.areas.map((a) => a.uuid).join(",");
  if (!orderChanged) {
    return {
      ok: false,
      detail: `${why}. No sidebar change was left behind${hops > 0 ? ` after ${hops} hop(s)` : ""}.`,
    };
  }
  // The order DID change. Tied pre-op ranks (every never-dragged area sits at
  // `index` 0, so ties are the norm on real data) make the restore anchor
  // ambiguous, so no recovery drag is attempted — but #658: the change must be
  // REPORTED, never claimed away. The old code short-circuited on the tie and
  // emitted "No sidebar change was left behind" over a move that had landed,
  // was visible in the sidebar, and was syncing to the user's other devices.
  if (hasRankTies(pre)) {
    return {
      ok: false,
      detail:
        `${why}. The sidebar order DID change${hops > 0 ? ` over ${hops} hop(s)` : ""} and was ` +
        `left in place: ${describePosition(now, spec.targetUuid)}. Several areas share the same ` +
        "stored rank, so putting it back automatically could move the wrong one — re-run the " +
        "move, or drag it back in the app.",
    };
  }
  // Which area was actually displaced? Normally the target; but a DUPLICATE-title
  // positional grab may have moved a SAME-TITLED SIBLING instead (the target's
  // own slot is unchanged). Restore whichever uuid drifted farthest from its
  // pre-op slot — that is the one the erroneous drag moved (ORDFIN2 AXDRAG3
  // self-invert). Its title equals the target's when it is a mis-grabbed sibling.
  const preIndex = (uuid: string): number => positionOf(pre, uuid);
  let displaced = spec.targetUuid;
  let worstDrift = Math.abs(positionOf(now, spec.targetUuid) - preIndex(spec.targetUuid));
  if (worstDrift === 0) {
    for (const a of pre.areas) {
      const drift = Math.abs(positionOf(now, a.uuid) - preIndex(a.uuid));
      if (drift > worstDrift) {
        worstDrift = drift;
        displaced = a.uuid;
      }
    }
  }
  const displacedRow = pre.areas.find((a) => a.uuid === displaced);
  const preIdx = preIndex(displaced);
  const successor = pre.areas[preIdx + 1];
  const placement: SidebarPlacement =
    successor !== undefined
      ? { kind: "before", uuid: successor.uuid, title: successor.title }
      : { kind: "last" };
  // A restore spec addressing the DISPLACED area (target or mis-grabbed sibling).
  const restoreSpec: SidebarDragSpec = {
    targetUuid: displaced,
    targetTitle: displacedRow?.title ?? spec.targetTitle,
    placement,
  };
  const restoreRanks = (): { sourceRank: number; anchorRank: number } => {
    const areas = ctx.state().areas;
    return {
      sourceRank: areaTitleRank(areas, restoreSpec.targetUuid, restoreSpec.targetTitle),
      anchorRank:
        successor !== undefined ? areaTitleRank(pre.areas, successor.uuid, successor.title) : -1,
    };
  };
  const areaTitles = pre.areas.map((a) => a.title);
  let recovered = false;
  // A bounded, single-pass recovery: same rung-1 mechanics, no hop budget.
  const snap = (
    await scrollUntil(ctx, (s) => {
      const p = planDrop(s, restoreSpec, areaTitles, placement, restoreRanks());
      if ("error" in p || s.viewport === null) return null;
      const g = grabPoint(p.source);
      if (inBand(g.y, s.viewport) && inBand(p.dropY, s.viewport)) return null;
      return s.viewport.y + s.viewport.h / 2 - (g.y + p.dropY) / 2;
    })
  ).snapshot;
  if (snap !== null && snap.viewport !== null) {
    const plan = planDrop(snap, restoreSpec, areaTitles, placement, restoreRanks());
    if (!("error" in plan)) {
      const g = grabPoint(plan.source);
      if (inBand(g.y, snap.viewport) && inBand(plan.dropY, snap.viewport)) {
        const landed = await performDrag(ctx, plan);
        if (landed) {
          const state = await pollState(ctx, (s) => positionOf(s, displaced) === preIdx);
          recovered = state !== null;
        }
      }
    }
  }
  const which = displaced === spec.targetUuid ? "area" : "same-titled area the drag actually moved";
  return {
    ok: false,
    recovered,
    detail: recovered
      ? `${why}. The ${which} was dragged back to its previous position (verified).`
      : `${why}. RECOVERY DID NOT VERIFY: the ${which} may be at an intermediate position after ` +
        `${hops} hop(s) — check the sidebar and re-run, or move it back in the app.`,
  };
}
