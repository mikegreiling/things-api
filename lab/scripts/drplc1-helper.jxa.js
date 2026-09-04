// DRPLC1 guest helper — does lifting a sidebar row COLLAPSE its slot, or does
// Things leave a PLACEHOLDER gap where it was? (#729)
//
// usage: osascript -l JavaScript drplc1-helper.js <verb> <titles-pipe-joined> [args...]
//
// The AX prelude is SBSCR1's verbatim (the semantic sidebar locator, SBRES1) so
// this measures the sidebar the shipped driver reads. The verbs are new: they
// hold a drag open and census the WHOLE row table mid-gesture, which is the one
// measurement that separates the two layout laws — and the static drop-Y
// correction in `ui-drag.ts` planDrop() is valid under exactly one of them.
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");

function pidOf(n) {
  return Application("System Events").processes.byName(n).unixId();
}
function sleepMs(ms) {
  $.NSThread.sleepForTimeInterval(ms / 1000);
}
function attr(el, name) {
  var out = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $(name), out) !== 0) return null;
  return ObjC.castRefToObject(out[0]);
}
function sv(el, name) {
  var v = attr(el, name);
  return v ? v.js : "";
}
function rectOf(p, z) {
  if (!p || !z) return null;
  var pd = ObjC.castRefToObject($.CFCopyDescription(p)).js,
    zd = ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm = pd.match(/x:([-0-9.]+) y:([-0-9.]+)/),
    zm = zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return pm && zm ? { x: +pm[1], y: +pm[2], w: +zm[1], h: +zm[2] } : null;
}
function frame(el) {
  return rectOf(attr(el, "AXPosition"), attr(el, "AXSize"));
}
function kids(el) {
  var c = attr(el, "AXChildren");
  if (!c) return [];
  var a = [];
  for (var i = 0; i < c.count; i++) a.push(c.objectAtIndex(i));
  return a;
}
function attrNames(el) {
  var out = Ref();
  if ($.AXUIElementCopyAttributeNames(el, out) !== 0) return [];
  var a = ObjC.castRefToObject(out[0]);
  if (!a) return [];
  var s = [];
  for (var i = 0; i < a.count; i++) s.push(a.objectAtIndex(i).js);
  return s;
}
function settable(el, name) {
  var out = Ref();
  if ($.AXUIElementIsAttributeSettable(el, $(name), out) !== 0) return "err";
  return out[0] ? "YES" : "no";
}
function acts(el) {
  var out = Ref();
  if ($.AXUIElementCopyActionNames(el, out) !== 0) return "(err)";
  var a = ObjC.castRefToObject(out[0]);
  if (!a) return "(none)";
  var s = [];
  for (var i = 0; i < a.count; i++) s.push(a.objectAtIndex(i).js);
  return s.length ? s.join(",") : "(none)";
}
function appEl() {
  return $.AXUIElementCreateApplication(pidOf("Things3"));
}
function mainWindow() {
  var ws = kids(appEl()),
    std = [];
  for (var i = 0; i < ws.length; i++) {
    if (sv(ws[i], "AXRole") === "AXWindow" && sv(ws[i], "AXSubrole") === "AXStandardWindow")
      std.push(ws[i]);
  }
  for (var k = 0; k < std.length; k++) {
    if (sv(std[k], "AXMain") === true) return std[k];
  }
  return std.length ? std[0] : null;
}
function isList(role) {
  return role === "AXTable" || role === "AXOutline" || role === "AXList";
}
function listPanes(el, depth, acc, sa) {
  if (depth < 0) return acc;
  var ch = kids(el);
  for (var i = 0; i < ch.length; i++) {
    var role = sv(ch[i], "AXRole");
    if (isList(role)) {
      acc.push({ table: ch[i], scroll: sa });
      continue;
    }
    if (role === "AXRow" || role === "AXCell") continue;
    listPanes(ch[i], depth - 1, acc, role === "AXScrollArea" ? ch[i] : sa);
  }
  return acc;
}
function textOf(el, acc, depth) {
  if (depth < 0) return acc;
  var v = sv(el, "AXValue");
  if (v) acc.push(v);
  var d = sv(el, "AXDescription");
  if (d) acc.push(d);
  var t = sv(el, "AXTitle");
  if (t) acc.push(t);
  var ch = kids(el);
  for (var i = 0; i < ch.length; i++) textOf(ch[i], acc, depth - 1);
  return acc;
}
function rowEls(tableEl) {
  var out = [],
    ch = kids(tableEl);
  for (var i = 0; i < ch.length; i++) {
    var r = sv(ch[i], "AXRole");
    if (r === "AXRow" || r === "AXTableRow") out.push(ch[i]);
  }
  return out;
}
function segMatch(text, title) {
  var segs = text.split("|");
  for (var j = 0; j < segs.length; j++) {
    if (segs[j] === title || segs[j] === title + ".") return true;
  }
  return false;
}

// The semantic locator, returning ELEMENTS (the shipped one returns plain data).
function resolveSidebar(titles) {
  var w = mainWindow();
  if (w === null) return { ok: false, why: "no-window" };
  var panes = listPanes(w, 8, [], null);
  var scored = [],
    i;
  for (i = 0; i < panes.length; i++) {
    var els = rowEls(panes[i].table),
      rows = [];
    for (var j = 0; j < els.length; j++)
      rows.push({ el: els[j], text: textOf(els[j], [], 2).join("|"), f: frame(els[j]) });
    var hits = 0;
    for (var t = 0; t < titles.length; t++) {
      for (var r = 0; r < rows.length; r++) {
        if (segMatch(rows[r].text, titles[t])) {
          hits++;
          break;
        }
      }
    }
    scored.push({ pane: panes[i], rows: rows, hits: hits });
  }
  var best = null;
  for (i = 0; i < scored.length; i++) {
    if (best === null || scored[i].hits > best.hits) best = scored[i];
  }
  if (best === null || best.hits === 0) return { ok: false, why: "no-title-match" };
  var vp = best.pane.scroll === null ? null : frame(best.pane.scroll);
  if (vp === null) return { ok: false, why: "no-viewport" };
  return {
    ok: true,
    table: best.pane.table,
    scroll: best.pane.scroll,
    viewport: vp,
    rows: best.rows,
  };
}

function contentPane(titles) {
  // The list pane that is NOT the sidebar — where a "pointer parked over the
  // content" park lands.
  var w = mainWindow();
  if (w === null) return null;
  var sb = resolveSidebar(titles);
  if (sb.ok !== true) return null;
  var panes = listPanes(w, 8, [], null);
  for (var i = 0; i < panes.length; i++) {
    if (panes[i].scroll === null) continue;
    var f = frame(panes[i].scroll);
    if (f && Math.abs(f.x - sb.viewport.x) > 5) return f;
  }
  return frame(w);
}

function scrollBarOf(sa) {
  if (!sa) return null;
  var ch = kids(sa);
  for (var b = 0; b < ch.length; b++) {
    if (sv(ch[b], "AXRole") === "AXScrollBar") return ch[b];
  }
  return null;
}
function barValue(bar) {
  if (!bar) return null;
  var v = attr(bar, "AXValue");
  if (v === null) return null;
  var d = ObjC.castRefToObject($.CFCopyDescription(v)).js;
  var m = d.match(/value = ([+\-0-9.]+)/);
  return m ? +m[1] : null;
}

function mouseLoc() {
  // CGPoint is a plain struct, NOT a CF type — CFCopyDescription cannot read it.
  // NSEvent.mouseLocation is the reliable bridge read, but its origin is the
  // BOTTOM-left of the main screen while AX frames use the TOP-left, so flip it.
  try {
    var p = $.NSEvent.mouseLocation;
    var h = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
    return { x: Math.round(p.x), y: Math.round(h - p.y) };
  } catch (e) {
    return null;
  }
}
function moveTo(x, y) {
  var e = $.CGEventCreateMouseEvent($(), 5, $.CGPointMake(x, y), 0);
  $.CGEventSetFlags(e, 0);
  $.CGEventPost($.kCGHIDEventTap, e);
}
function wheel(n) {
  var dir = n < 0 ? -1 : 1;
  for (var i = 0; i < Math.abs(n); i++) {
    var ev = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, dir * 3);
    $.CGEventPost($.kCGHIDEventTap, ev);
    sleepMs(60);
  }
}

// A stable geometric fingerprint of the scroll position: the y of the FIRST
// area row plus the scrollbar fraction. Movement is the delta of the first.
function probeState(titles) {
  var sb = resolveSidebar(titles);
  if (sb.ok !== true) return { ok: false, why: sb.why };
  var ys = [],
    first = null;
  for (var i = 0; i < sb.rows.length; i++) {
    var r = sb.rows[i];
    if (!r.f) continue;
    ys.push(r.f.y);
    for (var t = 0; t < titles.length; t++) {
      if (segMatch(r.text, titles[t]) && (first === null || r.f.y < first.y))
        first = { title: titles[t], y: r.f.y };
    }
  }
  ys.sort(function (a, b) {
    return a - b;
  });
  var bar = scrollBarOf(sb.scroll);
  return {
    ok: true,
    viewport: sb.viewport,
    topRowY: ys.length ? ys[0] : null,
    bottomRowY: ys.length ? ys[ys.length - 1] : null,
    rows: ys.length,
    firstArea: first,
    scroll: barValue(bar),
    hasBar: bar !== null,
  };
}

function rowByTitle(titles, want) {
  var sb = resolveSidebar(titles);
  if (sb.ok !== true) return null;
  for (var i = 0; i < sb.rows.length; i++) {
    if (segMatch(sb.rows[i].text, want)) return { sb: sb, row: sb.rows[i] };
  }
  return null;
}

// ------------------------------------------------------------- gesture bits
var MOVED = 5,
  DOWN = 1,
  UP = 2,
  DRAG = 6;
function mev(t, x, y, cs) {
  var e = $.CGEventCreateMouseEvent($(), t, $.CGPointMake(x, y), 0);
  if (cs) $.CGEventSetIntegerValueField(e, 1, cs);
  return e;
}
function postHID(ev) {
  $.CGEventPost($.kCGHIDEventTap, ev);
}
function postEscape() {
  var kd = $.CGEventCreateKeyboardEvent($(), 53, true),
    ku = $.CGEventCreateKeyboardEvent($(), 53, false);
  postHID(kd);
  sleepMs(20);
  postHID(ku);
}

/**
 * One full row census: every table row's frame, in visual order, tagged with
 * the area title it carries (null for spacers / built-ins / project rows).
 * Content is read at depth 2 — the shipped harvest depth (SBRES1).
 */
function census(titles) {
  var sb = resolveSidebar(titles);
  if (sb.ok !== true) return { ok: false, why: sb.why };
  var rows = [];
  for (var i = 0; i < sb.rows.length; i++) {
    var r = sb.rows[i];
    if (!r.f) continue;
    var title = null;
    for (var t = 0; t < titles.length; t++) {
      if (segMatch(r.text, titles[t])) {
        title = titles[t];
        break;
      }
    }
    rows.push({
      y: Math.round(r.f.y * 10) / 10,
      h: Math.round(r.f.h * 10) / 10,
      x: Math.round(r.f.x * 10) / 10,
      w: Math.round(r.f.w * 10) / 10,
      area: title,
      text: r.text.slice(0, 60),
    });
  }
  rows.sort(function (a, b) {
    return a.y - b.y;
  });
  var bar = scrollBarOf(sb.scroll);
  var bottom = rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : null;
  return {
    ok: true,
    viewport: sb.viewport,
    scroll: barValue(bar),
    count: rows.length,
    bottom: bottom,
    rows: rows,
  };
}

function areaRows(c) {
  var out = [];
  for (var i = 0; i < c.rows.length; i++) if (c.rows[i].area !== null) out.push(c.rows[i]);
  return out;
}

function run(argv) {
  var verb = argv[0];
  var titles = (argv[1] || "").split("|").filter(function (s) {
    return s.length > 0;
  });

  // census — the whole row table right now (the "before" and "after" reads).
  if (verb === "census") return JSON.stringify(census(titles));

  /*
   * liftread <srcTitle> [samples] [abort]
   *
   * THE MEASUREMENT. Grab the source area row exactly the way the shipped
   * rung-1 gesture grabs it (MOVED, DOWN, a 3px wiggle to open the drag
   * session, a DRAG back to the grab point), then — with the button still
   * held — take `samples` full row censuses. Escape-abort and release
   * (AXDRAG1-d: a byte-identical index vector), then census once more.
   *
   * Collapse law  → mid-drag row count drops by the source group's rows AND
   *                 every row below the source shifts UP by the group span.
   * Placeholder law → the slot stays open: rows below keep their static y
   *                 (a gap, or a placeholder row, sits where the source was).
   */
  if (verb === "liftread") {
    var want = argv[2];
    var samples = argv[3] ? +argv[3] : 3;
    var doAbort = argv[4] === "0" ? false : true;
    var hit = rowByTitle(titles, want);
    if (hit === null) return JSON.stringify({ ok: false, why: "source-row-not-found" });
    var f = hit.row.f;
    // the shipped grab point (ui-drag.ts grabPoint): 70% across the row
    var sx = Math.round(f.x + f.w * 0.7),
      sy = Math.round(f.y + f.h / 2);
    var before = census(titles);
    postHID(mev(MOVED, sx, sy, 0));
    sleepMs(30);
    postHID(mev(DOWN, sx, sy, 1));
    sleepMs(120);
    postHID(mev(DRAG, sx, sy - 3, 1));
    sleepMs(30);
    postHID(mev(DRAG, sx, sy, 1));
    sleepMs(150);
    var mid = [];
    for (var s = 0; s < samples; s++) {
      mid.push(census(titles));
      postHID(mev(DRAG, sx, sy, 1)); // keep the drag session alive
      sleepMs(120);
    }
    var aborted = false;
    if (doAbort) {
      postEscape();
      sleepMs(150);
      aborted = true;
    }
    postHID(mev(UP, sx, sy, 1));
    sleepMs(400);
    var after = census(titles);
    return JSON.stringify({
      ok: true,
      source: want,
      grab: { x: sx, y: sy },
      sourceFrame: f,
      aborted: aborted,
      before: before,
      mid: mid,
      after: after,
    });
  }

  /*
   * liftmove <srcTitle> <dy> [samples]
   *
   * Same as liftread, but the pointer is walked DOWN by `dy` before the
   * censuses — because a layout law can be a function of where the drag has
   * travelled to, not merely of the pickup. Escape-aborts.
   */
  if (verb === "liftmove") {
    var want2 = argv[2];
    var dy = +argv[3];
    var samples2 = argv[4] ? +argv[4] : 2;
    var hit2 = rowByTitle(titles, want2);
    if (hit2 === null) return JSON.stringify({ ok: false, why: "source-row-not-found" });
    var f2 = hit2.row.f;
    var sx2 = Math.round(f2.x + f2.w * 0.7),
      sy2 = Math.round(f2.y + f2.h / 2);
    var before2 = census(titles);
    postHID(mev(MOVED, sx2, sy2, 0));
    sleepMs(30);
    postHID(mev(DOWN, sx2, sy2, 1));
    sleepMs(120);
    postHID(mev(DRAG, sx2, sy2 - 3, 1));
    sleepMs(30);
    for (var k = 1; k <= 15; k++) {
      postHID(mev(DRAG, sx2, sy2 + (dy * k) / 15, 1));
      sleepMs(25);
    }
    postHID(mev(DRAG, sx2, sy2 + dy, 1));
    sleepMs(250);
    var mid2 = [];
    for (var s2 = 0; s2 < samples2; s2++) {
      mid2.push(census(titles));
      postHID(mev(DRAG, sx2, sy2 + dy, 1));
      sleepMs(120);
    }
    postEscape();
    sleepMs(150);
    postHID(mev(UP, sx2, sy2 + dy, 1));
    sleepMs(400);
    return JSON.stringify({
      ok: true,
      source: want2,
      grab: { x: sx2, y: sy2 },
      pointer: { x: sx2, y: sy2 + dy },
      before: before2,
      mid: mid2,
      after: census(titles),
    });
  }

  /*
   * dropat <srcTitle> <ty>
   *
   * Grab the source and actually DROP it at absolute y `ty` — the raw gesture,
   * no correction, no guard, so a cell can bisect which y lands which slot.
   */
  if (verb === "dropat") {
    var want3 = argv[2];
    var ty = +argv[3];
    var hit3 = rowByTitle(titles, want3);
    if (hit3 === null) return JSON.stringify({ ok: false, why: "source-row-not-found" });
    var f3 = hit3.row.f;
    var sx3 = Math.round(f3.x + f3.w * 0.7),
      sy3 = Math.round(f3.y + f3.h / 2);
    postHID(mev(MOVED, sx3, sy3, 0));
    sleepMs(30);
    postHID(mev(DOWN, sx3, sy3, 1));
    sleepMs(120);
    postHID(mev(DRAG, sx3, sy3 - 3, 1));
    sleepMs(30);
    for (var i3 = 1; i3 <= 25; i3++) {
      postHID(mev(DRAG, sx3, sy3 + ((ty - sy3) * i3) / 25, 1));
      sleepMs(25);
    }
    postHID(mev(DRAG, sx3, ty, 1));
    sleepMs(400);
    var liveAtDrop = census(titles);
    postHID(mev(UP, sx3, ty, 1));
    sleepMs(600);
    return JSON.stringify({
      ok: true,
      source: want3,
      grab: { x: sx3, y: sy3 },
      dropY: ty,
      liveAtDrop: liveAtDrop,
      after: census(titles),
    });
  }

  /*
   * jump <srcTitle> <ty> <parkOffset> <settleMs>
   *
   * THE HYSTERESIS CELL. The shipped aim sits a few points inside the trailing
   * gap of ONE of two self-consistent mid-drag layouts (the landing gap below
   * the last row); in the OTHER (gap still above it) the very same point falls
   * in the last row's top half, which inserts ABOVE it. This verb reaches the
   * SAME y two ways: approach to `ty - parkOffset`, let the app settle there,
   * then jump to `ty` in ONE event and release after only `settleMs`. It
   * censuses the layout at the moment of release, so the cell can say WHICH
   * layout took the drop rather than only what the order became.
   */
  if (verb === "jump") {
    var w4 = argv[2];
    var ty4 = +argv[3];
    var park = +argv[4];
    var settle = argv[5] ? +argv[5] : 60;
    var hit4 = rowByTitle(titles, w4);
    if (hit4 === null) return JSON.stringify({ ok: false, why: "source-row-not-found" });
    var f4 = hit4.row.f;
    var sx4 = Math.round(f4.x + f4.w * 0.7),
      sy4 = Math.round(f4.y + f4.h / 2);
    var parkY = ty4 - park;
    postHID(mev(MOVED, sx4, sy4, 0));
    sleepMs(30);
    postHID(mev(DOWN, sx4, sy4, 1));
    sleepMs(120);
    postHID(mev(DRAG, sx4, sy4 - 3, 1));
    sleepMs(30);
    for (var j4 = 1; j4 <= 25; j4++) {
      postHID(mev(DRAG, sx4, sy4 + ((parkY - sy4) * j4) / 25, 1));
      sleepMs(25);
    }
    postHID(mev(DRAG, sx4, parkY, 1));
    sleepMs(400);
    var atPark = census(titles);
    postHID(mev(DRAG, sx4, ty4, 1));
    sleepMs(settle);
    var atDrop = census(titles);
    postHID(mev(UP, sx4, ty4, 1));
    sleepMs(600);
    return JSON.stringify({
      ok: true,
      source: w4,
      grab: { x: sx4, y: sy4 },
      parkY: parkY,
      dropY: ty4,
      settleMs: settle,
      atPark: atPark,
      atDrop: atDrop,
      after: census(titles),
    });
  }

  return JSON.stringify({ ok: false, why: "unknown verb " + verb });
}
