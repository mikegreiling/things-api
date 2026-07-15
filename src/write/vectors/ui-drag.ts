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
 * unresolvable sidebar/row refuses BEFORE any synthesis; every hop is followed
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
 * Auxiliary seams the ui vector needs beyond osascript dispatch. The sidebar
 * drag driver asserts the database between hops; the client wires `areaState`
 * to the open connection. Absent (e.g. the capabilities surface, which never
 * executes), a drag op refuses cleanly.
 */
export interface UiDriveAux {
  areaState?: () => AreaSidebarState;
}

/** The client-side default aux: reads area order + assignments from the DB. */
export function createUiDriveAux(db: DatabaseSync): UiDriveAux {
  return {
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
function frame(el){ var p=attr(el,'AXPosition'), z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function findAll(el, wantRole, depth, acc){ acc=acc||[]; if(depth<0) return acc; var ch=kids(el);
  for(var i=0;i<ch.length;i++){ if(sv(ch[i],'AXRole')===wantRole) acc.push(ch[i]); findAll(ch[i], wantRole, depth-1, acc) } return acc }
function appEl(){ return $.AXUIElementCreateApplication(pidOf('Things3')) }
function stdWindow(){ var ws=kids(appEl()); for(var i=0;i<ws.length;i++){ if(sv(ws[i],'AXSubrole')==='AXStandardWindow') return ws[i] } return ws.length?ws[0]:null }
function sidebarTable(){ var w=stdWindow(); if(!w) return null; var tables=findAll(w,'AXTable',12,[]); var best=null;
  for(var i=0;i<tables.length;i++){ var f=frame(tables[i]); if(!f) continue; if(f.w<400){ if(!best||f.w<best.f.w) best={el:tables[i],f:f} } }
  return best?best.el:null }
var MOVED=5, DOWN=1, UP=2, DRAG=6;
function mev(t,x,y,cs){ var e=$.CGEventCreateMouseEvent($(), t, $.CGPointMake(x,y), 0); if(cs) $.CGEventSetIntegerValueField(e,1,cs); return e }
function postHID(ev){ $.CGEventPost($.kCGHIDEventTap, ev) }`;

/** Snapshot: sidebar rows (text + frames), viewport rect, scroll fraction. */
export function jxaSidebarSnapshotScript(): string {
  return `${JXA_PRELUDE}
function allText(el, acc, depth){ acc=acc||[]; depth=depth==null?6:depth; if(depth<0) return acc;
  var v=sv(el,'AXValue'); if(v) acc.push(v); var d=sv(el,'AXDescription'); if(d) acc.push(d);
  var t=sv(el,'AXTitle'); if(t) acc.push(t); var ch=kids(el); for(var i=0;i<ch.length;i++) allText(ch[i],acc,depth-1); return acc }
var t = sidebarTable();
var out = { viewport: null, scroll: null, rows: [] };
if (t !== null) {
  var w = stdWindow();
  var areas = findAll(w,'AXScrollArea',12,[]);
  for (var i=0;i<areas.length;i++){ var f=frame(areas[i]); if(f && f.w<400){ out.viewport=f;
    var bars=findAll(areas[i],'AXScrollBar',4,[]);
    for (var b=0;b<bars.length;b++){ var v=attr(bars[b],'AXValue'); if(v===null) continue;
      var d=ObjC.castRefToObject($.CFCopyDescription(v)).js; var m=d.match(/value = ([+\\-0-9.]+)/);
      if(m){ out.scroll = +m[1]; break } }
    break } }
  var ch = kids(t);
  for (var r=0;r<ch.length;r++){ var role=sv(ch[r],'AXRole');
    if (role==='AXRow'||role==='AXTableRow'){ var rf=frame(ch[r]);
      out.rows.push({ text: allText(ch[r],[],6).join('|'), x: rf?rf.x:null, y: rf?rf.y:null, w: rf?rf.w:null, h: rf?rf.h:null }) } }
}
JSON.stringify(out)`;
}

/**
 * Scroll: move the pointer over the sidebar center (wheel events target the
 * surface under the cursor), then post `clicks` line-unit wheel events.
 * Positive clicks move the CONTENT down (earlier rows return, row y grows);
 * negative clicks reveal lower rows (row y shrinks) — AXDRAG1-b.
 */
export function jxaSidebarScrollScript(clicks: number): string {
  const n = Math.trunc(clicks);
  return `${JXA_PRELUDE}
var w = stdWindow();
var sb = null;
if (w !== null) { var sas = findAll(w,'AXScrollArea',12,[]);
  for (var i=0;i<sas.length;i++){ var f=frame(sas[i]); if(f && f.w<400){ sb=f; break } } }
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

function snapshotCommand(): UiCommand {
  return {
    primitive: "sidebar-snapshot",
    label: "read the sidebar rows and viewport",
    lang: "javascript",
    script: jxaSidebarSnapshotScript(),
  };
}

function scrollCommand(clicks: number): UiCommand {
  return {
    primitive: "sidebar-scroll",
    label: `scroll the sidebar (${clicks} clicks)`,
    lang: "javascript",
    script: jxaSidebarScrollScript(clicks),
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
): string {
  const [a, b] = [sx, sy].map(Math.round) as [number, number];
  const anchor = JSON.stringify(anchorTitle);
  return `${JXA_PRELUDE}
function allText(el, acc, depth){ acc=acc||[]; depth=depth==null?6:depth; if(depth<0) return acc;
  var v=sv(el,'AXValue'); if(v) acc.push(v); var d=sv(el,'AXDescription'); if(d) acc.push(d);
  var t=sv(el,'AXTitle'); if(t) acc.push(t); var ch=kids(el); for(var i=0;i<ch.length;i++) allText(ch[i],acc,depth-1); return acc }
function liveRows(){ var t=sidebarTable(); if(!t) return []; var out=[]; var ch=kids(t);
  for(var r=0;r<ch.length;r++){ var role=sv(ch[r],'AXRole');
    if(role==='AXRow'||role==='AXTableRow'){ var f=frame(ch[r]);
      if(f) out.push({text:allText(ch[r],[],6).join('|'), f:f}) } }
  out.sort(function(p,q){ return p.f.y-q.f.y }); return out }
function matches(text, title){ var segs=text.split('|');
  for(var j=0;j<segs.length;j++){ if(segs[j]===title||segs[j]===title+'.') return true } return false }
function viewportRect(){ var w=stdWindow(); if(!w) return null; var sas=findAll(w,'AXScrollArea',12,[]);
  for(var i=0;i<sas.length;i++){ var f=frame(sas[i]); if(f && f.w<400) return f } return null }
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
    var stable = 0, lastY = null, w = 0;
    for (w = 0; w < 12 && stable < 2; w++) {
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

function heldScrollDragCommand(
  sx: number,
  sy: number,
  anchorTitle: string | null,
  maxTicks: number,
): UiCommand {
  return {
    primitive: "sidebar-held-drag",
    label: "held-scroll drag toward the destination",
    lang: "javascript",
    script: jxaSidebarHeldScrollDragScript(sx, sy, anchorTitle, maxTicks),
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

export function parseSidebarSnapshot(stdout: string): SidebarSnapshot | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as SidebarSnapshot;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.rows)) return null;
    return {
      viewport: parsed.viewport ?? null,
      scroll: parsed.scroll ?? null,
      rows: parsed.rows.filter(
        (r) => typeof r.y === "number" && typeof r.x === "number" && typeof r.h === "number",
      ),
    };
  } catch {
    return null;
  }
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
): { y: number; anchor: string } | { error: string } {
  const others = orderedAreaRows.filter((a) => a.title !== sourceTitle);
  if (others.length === 0) return { error: "no other area rows resolved in the sidebar" };
  const belowLast = (): { y: number; anchor: string } | { error: string } => {
    const y = boundaryBelowLast(allRows);
    if (y === null) return { error: "no sidebar rows resolved" };
    return { y, anchor: "the end of the sidebar list" };
  };
  switch (placement.kind) {
    case "first": {
      const first = others[0] as { title: string; row: SidebarRowInfo };
      return { y: boundaryAboveRow(allRows, first.row), anchor: first.title };
    }
    case "last":
      return belowLast();
    case "before": {
      const ref = others.find((a) => a.title === placement.title);
      if (ref === undefined)
        return { error: `the sidebar row for "${placement.title}" did not resolve` };
      return { y: boundaryAboveRow(allRows, ref.row), anchor: ref.title };
    }
    case "after": {
      const refIdx = others.findIndex((a) => a.title === placement.title);
      if (refIdx < 0) return { error: `the sidebar row for "${placement.title}" did not resolve` };
      const next = others[refIdx + 1];
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

export interface DragDriveResult {
  ok: boolean;
  /** Human-readable outcome (hop count, rung) or the refusal reason. */
  detail: string;
  /** A gesture may have landed before the failure — recovery state, honestly. */
  recovered?: boolean;
}

interface DriveCtx {
  run: UiRunner;
  state: () => AreaSidebarState;
  sleep: (ms: number) => Promise<void>;
}

async function runCmd(ctx: DriveCtx, cmd: UiCommand): Promise<UiRunResult> {
  return ctx.run(cmd, STEP_TIMEOUT_MS);
}

async function takeSnapshot(ctx: DriveCtx): Promise<SidebarSnapshot | null> {
  const res = await runCmd(ctx, snapshotCommand());
  if (!res.ok) return null;
  const snap = parseSidebarSnapshot(res.stdout);
  if (snap === null || snap.viewport === null || snap.rows.length === 0) return null;
  return snap;
}

/**
 * Scroll until `wanted(snapshot)` returns a zero-ish error, re-resolving
 * frames after every scroll (AXDRAG1: frames must be re-read post-scroll).
 * `wanted` returns the pixel error to correct (positive = rows must move down)
 * or null when satisfied. Self-calibrating: if a scroll moves the rows the
 * wrong way, the direction factor flips once.
 */
async function scrollUntil(
  ctx: DriveCtx,
  wanted: (snap: SidebarSnapshot) => number | null,
  goodEnough?: (snap: SidebarSnapshot) => boolean,
): Promise<SidebarSnapshot | null> {
  let dirFactor = 1;
  let pxPerClick = PX_PER_CLICK_SEED; // replaced by measured travel after scroll 1
  let lastErr: number | null = null;
  let lastClicks = 0;
  let stalls = 0;
  for (let iter = 0; iter < MAX_SCROLL_ITER; iter++) {
    // oxlint-disable-next-line no-await-in-loop -- each scroll must observe the frames the previous scroll produced
    const snap = await takeSnapshot(ctx);
    if (snap === null) return null;
    const err = wanted(snap);
    if (err === null) return snap;
    if (lastErr !== null && lastClicks !== 0) {
      const moved = lastErr - err; // px the content actually travelled
      if (Math.abs(moved) < 2) {
        stalls += 1;
        if (stalls >= 2) {
          // Pinned at the end of the scroll range: settle for the achieved
          // state when the caller says it is workable.
          return goodEnough !== undefined && goodEnough(snap) ? snap : null;
        }
      } else {
        stalls = 0;
        // Calibrate from the MEASURED travel of the previous scroll.
        pxPerClick = Math.min(120, Math.max(4, Math.abs(moved / lastClicks)));
        // Moved the wrong way → the wheel sign convention is flipped here.
        if (Math.sign(moved) !== Math.sign(lastClicks)) dirFactor = -dirFactor;
      }
    }
    lastErr = err;
    const clicks =
      Math.max(-12, Math.min(12, Math.round(err / pxPerClick) || Math.sign(err))) * dirFactor;
    lastClicks = clicks;
    // oxlint-disable-next-line no-await-in-loop -- strictly sequential scroll-and-remeasure loop
    const res = await runCmd(ctx, scrollCommand(clicks));
    if (!res.ok) return null;
  }
  return null;
}

/** Poll the DB until `check` passes or the attempts run out. */
async function pollState(
  ctx: DriveCtx,
  check: (state: AreaSidebarState) => boolean,
): Promise<AreaSidebarState | null> {
  for (let i = 0; i < ASSERT_ATTEMPTS; i++) {
    const state = ctx.state();
    if (check(state)) return state;
    // oxlint-disable-next-line no-await-in-loop -- polling the same DB condition is inherently sequential
    await ctx.sleep(ASSERT_DELAY_MS);
  }
  return null;
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
): PlannedDrop | { error: string } {
  const source = findAreaRow(snap.rows, spec.targetTitle);
  if (source === null) {
    return {
      error:
        `the sidebar row for "${spec.targetTitle}" did not resolve uniquely by its visible ` +
        "name — after many drags in one app session a sidebar row can stop exposing its " +
        "name until Things is relaunched (AXDRAG2); quit and reopen Things, then retry",
    };
  }
  const ordered = areaRowsInOrder(snap.rows, areaTitles);
  const boundary = staticBoundaryY(ordered, snap.rows, spec.targetTitle, placement);
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
  const ctx: DriveCtx = { run, state: aux.areaState, sleep };
  const pre = ctx.state();
  const preTies = hasRankTies(pre);
  const areaTitles = pre.areas.map((a) => a.title);

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
    // oxlint-disable-next-line no-await-in-loop -- every hop depends on the layout the previous hop produced
    const snap = await takeSnapshot(ctx);
    if (snap === null) {
      return refuseOrRecover(
        ctx,
        pre,
        spec,
        hops,
        "the sidebar did not resolve (is the window open and the sidebar visible?)",
      );
    }
    const viewport = snap.viewport as SidebarRect;
    {
      // ceil(areas / visible-slots) + 2, from the frame-derived slot pitch.
      const pitch = slotPitch(areaRowsInOrder(snap.rows, areaTitles), snap.rows);
      const visibleSlots = Math.max(1, Math.floor(viewport.h / pitch) - 2);
      hopCap = Math.min(MAX_HOPS_CEILING, Math.ceil(pre.areas.length / visibleSlots) + 2);
    }
    const finalPlan = planDrop(snap, spec, areaTitles, spec.placement);
    if ("error" in finalPlan) {
      if (!resolveRetried) {
        resolveRetried = true;
        // oxlint-disable-next-line no-await-in-loop -- one settle pause before re-reading the tree
        await ctx.sleep(2000);
        continue;
      }
      return refuseOrRecover(ctx, pre, spec, hops, finalPlan.error);
    }
    resolveRetried = false;
    const grab = grabPoint(finalPlan.source);

    // Rung 1: both the grab point and the drop boundary visible (or scrollable
    // into simultaneous view) → one certified drag.
    const spanNeeded = Math.abs(grab.y - finalPlan.dropY);
    if (spanNeeded < viewport.h - 4 * BAND_PAD) {
      let ready: SidebarSnapshot | null = snap;
      if (!inBand(grab.y, viewport) || !inBand(finalPlan.dropY, viewport)) {
        // oxlint-disable-next-line no-await-in-loop -- pre-scroll must land before the drag
        ready = await scrollUntil(ctx, (s) => {
          const p = planDrop(s, spec, areaTitles, spec.placement);
          if ("error" in p || s.viewport === null) return null;
          const g = grabPoint(p.source);
          if (inBand(g.y, s.viewport) && inBand(p.dropY, s.viewport)) return null;
          const mid = (g.y + p.dropY) / 2;
          const bandMid = s.viewport.y + s.viewport.h / 2;
          return bandMid - mid;
        });
      }
      if (ready !== null) {
        const plan = planDrop(ready, spec, areaTitles, spec.placement);
        if (!("error" in plan) && ready.viewport !== null) {
          const g = grabPoint(plan.source);
          if (inBand(g.y, ready.viewport) && inBand(plan.dropY, ready.viewport)) {
            // oxlint-disable-next-line no-await-in-loop -- the gesture must land before the DB assert
            const landed = await performDrag(ctx, plan);
            if (!landed) {
              return refuseOrRecover(ctx, pre, spec, hops, "the drag gesture did not complete");
            }
            // oxlint-disable-next-line no-await-in-loop -- the final assert gates success
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
      // oxlint-disable-next-line no-await-in-loop -- the pre-grab scroll must land before the gesture
      const grabbable = await scrollUntil(
        ctx,
        (s) => {
          if (s.viewport === null) return null;
          const src = findAreaRow(s.rows, spec.targetTitle);
          if (src === null) return null;
          const g = grabPoint(src);
          if (inBand(g.y, s.viewport)) return null;
          return s.viewport.y + s.viewport.h / 2 - g.y;
        },
        (s) => {
          if (s.viewport === null) return false;
          const src = findAreaRow(s.rows, spec.targetTitle);
          return src !== null && inBand(grabPoint(src).y, s.viewport);
        },
      );
      if (grabbable !== null && grabbable.viewport !== null) {
        const src = findAreaRow(grabbable.rows, spec.targetTitle);
        const anchor = rung2AnchorTitle(
          grabbable.rows,
          areaTitles,
          spec.targetTitle,
          spec.placement,
        );
        if (src !== null && anchor !== undefined) {
          const g = grabPoint(src);
          const plan2 = planDrop(grabbable, spec, areaTitles, spec.placement);
          const travel = "error" in plan2 ? viewport.h * 4 : Math.abs(plan2.dropY - g.y);
          // TRAVEL CAP (AXDRAG2-c): held-scroll is proven up to ~1.5 viewport
          // heights; beyond that the app's AX mirror can lose row names for
          // the rest of the session (oddities: sidebar ghost rows), so far
          // moves go straight to the multi-hop floor.
          if (travel > viewport.h * 1.5) continue;
          const maxTicks = Math.min(400, Math.max(20, Math.ceil(travel / 15)));
          // oxlint-disable-next-line no-await-in-loop -- the held gesture must complete before its DB assert
          const res = await runCmd(ctx, heldScrollDragCommand(g.x, g.y, anchor, maxTicks));
          const parsed = parseHeldDragResult(res);
          if (parsed.dropped) {
            // oxlint-disable-next-line no-await-in-loop -- the final assert gates success
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
    // oxlint-disable-next-line no-await-in-loop -- the hop's park scroll must land before its gesture
    const parked = await scrollUntil(
      ctx,
      (s) => {
        if (s.viewport === null) return null;
        const src = findAreaRow(s.rows, spec.targetTitle);
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
        const src = findAreaRow(s.rows, spec.targetTitle);
        return src !== null && inBand(grabPoint(src).y, s.viewport);
      },
    );
    if (parked === null || parked.viewport === null) {
      return refuseOrRecover(ctx, pre, spec, hops, "could not scroll the area's row into view");
    }
    const ordered = areaRowsInOrder(parked.rows, areaTitles);
    const srcIdx = ordered.findIndex((a) => a.title === spec.targetTitle);
    const source = ordered[srcIdx];
    if (srcIdx < 0 || source === undefined) {
      return refuseOrRecover(ctx, pre, spec, hops, "the area's row vanished after scrolling");
    }
    const span = sourceGroupSpan(ordered, spec.targetTitle, parked.rows);
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
      const dropY = correctedDropY(boundaryAboveRow(parked.rows, cand.row), sourceCenter, span);
      if (!inBand(dropY, parked.viewport)) continue;
      const uuid = pre.areas.find((a) => a.title === cand.title)?.uuid ?? "";
      if (hopAnchor === null || visualDelta > hopAnchor.visualDelta) {
        hopAnchor = { title: cand.title, uuid, dropY, visualDelta };
      }
    }
    if (hopAnchor === null) {
      return refuseOrRecover(
        ctx,
        pre,
        spec,
        hops,
        "no drop slot toward the destination fits the visible sidebar — the viewport is too " +
          "small to make progress",
      );
    }
    const anchorUuid = hopAnchor.uuid;
    // oxlint-disable-next-line no-await-in-loop -- the hop gesture must land before its DB assert
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
    // oxlint-disable-next-line no-await-in-loop -- the hop assert gates the next hop
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
  const state = ctx.state();
  const pos = positionOf(state, spec.targetUuid);
  const where =
    pos < 0
      ? "the area no longer resolves in the database"
      : `the area now sits at sidebar position ${pos + 1} of ${state.areas.length}` +
        (pos > 0 ? `, below "${state.areas[pos - 1]?.title ?? "?"}"` : ", at the top");
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
  const moved =
    positionOf(now, spec.targetUuid) !== positionOf(pre, spec.targetUuid) ||
    now.areas.map((a) => a.uuid).join(",") !== pre.areas.map((a) => a.uuid).join(",");
  if (!moved || hasRankTies(pre)) {
    return {
      ok: false,
      detail: `${why}. No sidebar change was left behind${hops > 0 ? ` after ${hops} hop(s)` : ""}.`,
    };
  }
  const preIdx = positionOf(pre, spec.targetUuid);
  const successor = pre.areas[preIdx + 1];
  const placement: SidebarPlacement =
    successor !== undefined
      ? { kind: "before", uuid: successor.uuid, title: successor.title }
      : { kind: "last" };
  const areaTitles = pre.areas.map((a) => a.title);
  let recovered = false;
  // A bounded, single-pass recovery: same rung-1 mechanics, no hop budget.
  const snap = await scrollUntil(ctx, (s) => {
    const p = planDrop(s, spec, areaTitles, placement);
    if ("error" in p || s.viewport === null) return null;
    const g = grabPoint(p.source);
    if (inBand(g.y, s.viewport) && inBand(p.dropY, s.viewport)) return null;
    return s.viewport.y + s.viewport.h / 2 - (g.y + p.dropY) / 2;
  });
  if (snap !== null && snap.viewport !== null) {
    const plan = planDrop(snap, spec, areaTitles, placement);
    if (!("error" in plan)) {
      const g = grabPoint(plan.source);
      if (inBand(g.y, snap.viewport) && inBand(plan.dropY, snap.viewport)) {
        const landed = await performDrag(ctx, plan);
        if (landed) {
          const state = await pollState(ctx, (s) => positionOf(s, spec.targetUuid) === preIdx);
          recovered = state !== null;
        }
      }
    }
  }
  return {
    ok: false,
    recovered,
    detail: recovered
      ? `${why}. The area was dragged back to its previous position (verified).`
      : `${why}. RECOVERY DID NOT VERIFY: the area may be at an intermediate position after ` +
        `${hops} hop(s) — check the sidebar and re-run, or move it back in the app.`,
  };
}
