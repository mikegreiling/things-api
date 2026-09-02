// VOPAT1 — the measurement rig for "read like a screen reader" (#676).
//
// The shipped drivers read Things like a web crawler: they SWEEP, harvesting the
// content of every row in the sidebar, and they POLL, re-reading a surface until
// two reads agree. A screen reader does neither. It reads one element on demand,
// asks the table for its VISIBLE set, is told by a notification when something
// changed, and hit-tests a point when it wants the thing under the cursor.
//
// The field law (#676, measured on the maintainer's M1 2026-09-02) is why that
// distinction is worth money: an AX round-trip costs ~0.1 ms, but the FIRST
// content-bearing touch of a sidebar row costs ~115 ms there, paid again on
// every sweep because nothing caches it. Geometry is free (AXRows + AXFrame for
// 174 rows ~= 2 ms). So the metric that transfers between hosts is not calls and
// not wall time -- it is ROWS REALIZED: the number of distinct elements whose
// CONTENT this code touched.
//
// Every verb therefore reports three numbers:
//   axCalls   every Accessibility round-trip, content or geometry
//   realized  distinct elements a CONTENT attribute was read on (the field cost)
//   ms        wall time on THIS host, which is ~20x faster than the field for
//             content reads and must never be extrapolated
//
// usage: osascript -l JavaScript vopat1.jxa.js <verb> <titles-pipe-joined> [args...]
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");

// ------------------------------------------------------------ accounting
var CALLS = 0;
var REALIZED = 0;
function reset() {
  CALLS = 0;
  REALIZED = 0;
}
function now() {
  return $.NSDate.date.timeIntervalSince1970 * 1000;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function pidOf(n) {
  return Application("System Events").processes.byName(n).unixId();
}
function sleep(ms) {
  $.NSThread.sleepForTimeInterval(ms / 1000);
}

function attr(el, name) {
  CALLS++;
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
function arrayOf(v) {
  if (!v) return [];
  var a = [];
  try {
    var n = Number(v.count);
    for (var i = 0; i < n; i++) a.push(v.objectAtIndex(i));
  } catch (e) {
    return [];
  }
  return a;
}
function appEl() {
  return $.AXUIElementCreateApplication(pidOf("Things3"));
}
function mainWindowIdx() {
  var ws = kids(appEl()),
    std = [];
  for (var i = 0; i < ws.length; i++) {
    if (sv(ws[i], "AXRole") === "AXWindow" && sv(ws[i], "AXSubrole") === "AXStandardWindow")
      std.push({ el: ws[i], idx: i });
  }
  for (var k = 0; k < std.length; k++) {
    if (sv(std[k].el, "AXMain") === true) return std[k];
  }
  return std.length ? std[0] : null;
}
function mainWindow() {
  var m = mainWindowIdx();
  return m === null ? null : m.el;
}

var NODE_ATTRS = $([
  "AXValue",
  "AXDescription",
  "AXTitle",
  "AXChildren",
  "AXPosition",
  "AXSize",
  "AXRole",
]);
// THE CONTENT TOUCH. One batched round-trip that asks for value/description/
// title/children -- exactly what the shipped snapshot's node() asks for, and
// exactly the access the field law prices at ~115 ms per row realized. Every
// call site that reaches a row through this is counted in REALIZED.
function node(el, isRealizingTouch) {
  CALLS++;
  if (isRealizingTouch) REALIZED++;
  var out = Ref();
  if ($.AXUIElementCopyMultipleAttributeValues(el, NODE_ATTRS, 0, out) !== 0) return null;
  var a = ObjC.castRefToObject(out[0]);
  if (!a || Number(a.count) < 7) return null;
  function s(i) {
    var v = a.objectAtIndex(i);
    if (!v) return "";
    var j;
    try {
      j = v.js;
    } catch (e) {
      return "";
    }
    return typeof j === "string" ? j : "";
  }
  var ch = [],
    c = a.objectAtIndex(3);
  try {
    var n = Number(c.count);
    for (var i = 0; i < n; i++) ch.push(c.objectAtIndex(i));
  } catch (e) {
    ch = [];
  }
  var f = null;
  try {
    f = rectOf(a.objectAtIndex(4), a.objectAtIndex(5));
  } catch (e) {
    f = null;
  }
  return { value: s(0), desc: s(1), title: s(2), children: ch, frame: f, role: s(6) };
}

// The shipped depth-2 text harvest. `depth` generations BELOW the row are also
// content touches, but they are touches on the SAME row's view: the field law is
// per ROW REALIZED, so only the row itself increments REALIZED.
function textOf(n, acc, depth) {
  if (n === null) return acc;
  if (n.value) acc.push(n.value);
  if (n.desc) acc.push(n.desc);
  if (n.title) acc.push(n.title);
  if (depth <= 0) return acc;
  for (var i = 0; i < n.children.length; i++) textOf(node(n.children[i], false), acc, depth - 1);
  return acc;
}
function segMatch(text, title) {
  var segs = text.split("|");
  for (var j = 0; j < segs.length; j++) {
    if (segs[j] === title || segs[j] === title + ".") return true;
  }
  return false;
}
function isRowRole(r) {
  return r === "AXRow" || r === "AXTableRow";
}
function isList(role) {
  return role === "AXTable" || role === "AXOutline" || role === "AXList";
}
function listPanes(el, depth, acc, sa, saPath, path) {
  if (depth < 0) return acc;
  var ch = kids(el);
  for (var i = 0; i < ch.length; i++) {
    var role = sv(ch[i], "AXRole");
    var p = path.concat([i]);
    if (isList(role)) {
      acc.push({ table: ch[i], tablePath: p, scroll: sa, scrollPath: saPath });
      continue;
    }
    if (isRowRole(role) || role === "AXCell") continue;
    listPanes(
      ch[i],
      depth - 1,
      acc,
      role === "AXScrollArea" ? ch[i] : sa,
      role === "AXScrollArea" ? p : saPath,
      p,
    );
  }
  return acc;
}
function harvestRows(tableEl, depth) {
  var out = [],
    ch = kids(tableEl);
  for (var i = 0; i < ch.length; i++) {
    var n = node(ch[i], true);
    if (n === null) continue;
    if (!isRowRole(n.role)) {
      REALIZED--; // not a row; do not charge it to the row budget
      continue;
    }
    var f = n.frame;
    out.push({
      el: ch[i],
      text: textOf(n, [], depth).join("|"),
      x: f ? f.x : null,
      y: f ? f.y : null,
      w: f ? f.w : null,
      h: f ? f.h : null,
    });
  }
  return out;
}
function countTitles(rows, titles) {
  var n = 0;
  for (var t = 0; t < titles.length; t++) {
    for (var r = 0; r < rows.length; r++) {
      if (segMatch(rows[r].text, titles[t])) {
        n++;
        break;
      }
    }
  }
  return n;
}
function overlapPx(a, b) {
  if (!a || !b) return 0;
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
}
function scrollBarOf(sa) {
  if (!sa) return null;
  var ch = kids(sa);
  for (var b = 0; b < ch.length; b++) {
    if (sv(ch[b], "AXRole") === "AXScrollBar") return { el: ch[b], idx: b };
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

// The shipped locator, verbatim in behaviour, with the child-index path to the
// table and the scroll area carried along so the observer can address them.
function resolveSidebar(titles, depth) {
  var mw = mainWindowIdx();
  if (mw === null) return { ok: false, why: "no-window" };
  var panes = listPanes(mw.el, 8, [], null, null, [mw.idx]);
  if (panes.length === 0) return { ok: false, why: "no-list-candidates" };
  var scored = [],
    i;
  for (i = 0; i < panes.length; i++) {
    var rows = harvestRows(panes[i].table, depth);
    scored.push({ pane: panes[i], rows: rows, hits: countTitles(rows, titles) });
  }
  var best = null,
    tie = false;
  for (i = 0; i < scored.length; i++) {
    if (best === null || scored[i].hits > best.hits) {
      best = scored[i];
      tie = false;
    } else if (scored[i].hits === best.hits && best.hits > 0) tie = true;
  }
  if (best === null || best.hits === 0) return { ok: false, why: "no-title-match" };
  if (tie) return { ok: false, why: "ambiguous-sidebar" };
  var vp = best.pane.scroll === null ? null : frame(best.pane.scroll);
  for (i = 0; i < scored.length; i++) {
    if (scored[i] === best || scored[i].pane.scroll === null) continue;
    if (overlapPx(vp, frame(scored[i].pane.scroll)) > 1)
      return { ok: false, why: "sidebar-hidden" };
  }
  if (vp === null) return { ok: false, why: "no-viewport" };
  if (best.rows.length === 0) return { ok: false, why: "no-rows" };
  return {
    ok: true,
    table: best.pane.table,
    tablePath: best.pane.tablePath,
    scroll: best.pane.scroll,
    scrollPath: best.pane.scrollPath,
    viewport: vp,
    rows: best.rows,
    hits: best.hits,
  };
}

// A GEOMETRY-ONLY row list: AXRows (one call) plus a frame per row (two). This
// is the read the field measured at ~2 ms for 174 rows, and it realizes NOTHING.
function geomRows(table) {
  var rows = arrayOf(attr(table, "AXRows"));
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var f = frame(rows[i]);
    out.push({
      el: rows[i],
      i: i,
      y: f ? f.y : null,
      h: f ? f.h : null,
      x: f ? f.x : null,
      w: f ? f.w : null,
    });
  }
  return out;
}

var MOVED = 5,
  DOWN = 1,
  UP = 2;
function mev(t, x, y, cs) {
  var e = $.CGEventCreateMouseEvent($(), t, $.CGPointMake(x, y), 0);
  if (cs) $.CGEventSetIntegerValueField(e, 1, cs);
  return e;
}
function postHID(ev) {
  $.CGEventPost($.kCGHIDEventTap, ev);
}

function stats(samples) {
  if (!samples.length) return { n: 0 };
  var s = samples.slice().sort(function (a, b) {
    return a - b;
  });
  function pct(p) {
    return s[Math.round((s.length - 1) * p)];
  }
  var total = 0;
  for (var i = 0; i < s.length; i++) total += s[i];
  return {
    n: s.length,
    medianMs: round2(pct(0.5)),
    p95Ms: round2(pct(0.95)),
    minMs: round2(s[0]),
    maxMs: round2(s[s.length - 1]),
    totalMs: round1(total),
  };
}

// ================================================================== entry
function run(argv) {
  var verb = argv[0] || "";
  var titles = (argv[1] || "").split("|").filter(function (s) {
    return s.length > 0;
  });
  var a2 = argv[2],
    a3 = argv[3];

  if (verb === "park") {
    postHID(mev(MOVED, Number(a2), Number(a3), 0));
    sleep(120);
    return JSON.stringify({ parked: [Number(a2), Number(a3)] });
  }

  // ---------------------------------------------------------------- CELL 0
  // Where things are, and the child-index paths the observer addresses by.
  if (verb === "paths") {
    reset();
    var r0 = resolveSidebar(titles, 2);
    if (r0.ok !== true) return JSON.stringify({ ok: false, why: r0.why });
    var bar0 = scrollBarOf(r0.scroll);
    return JSON.stringify({
      ok: true,
      pid: pidOf("Things3"),
      tablePath: r0.tablePath,
      scrollAreaPath: r0.scrollPath,
      scrollBarPath: bar0 === null ? null : r0.scrollPath.concat([bar0.idx]),
      windowPath: [r0.tablePath[0]],
      rows: r0.rows.length,
      viewport: r0.viewport,
      scroll: barValue(bar0 === null ? null : bar0.el),
    });
  }

  if (verb === "state") {
    reset();
    var rs = resolveSidebar(titles, 2);
    if (rs.ok !== true) return JSON.stringify({ ok: false, why: rs.why });
    return JSON.stringify({
      ok: true,
      rows: rs.rows.length,
      hits: rs.hits,
      titles: titles.length,
      viewport: rs.viewport,
      scroll: barValue((scrollBarOf(rs.scroll) || {}).el),
      axCalls: CALLS,
      realized: REALIZED,
    });
  }

  if (verb === "setbar") {
    var rb = resolveSidebar(titles, 2);
    if (rb.ok !== true) return JSON.stringify({ ok: false, why: rb.why });
    var b = scrollBarOf(rb.scroll);
    if (b === null) return JSON.stringify({ ok: false, why: "no-scrollbar" });
    var before = barValue(b.el);
    var err = $.AXUIElementSetAttributeValue(
      b.el,
      $("AXValue"),
      $.NSNumber.numberWithDouble(Number(a2)),
    );
    sleep(250);
    return JSON.stringify({ ok: err === 0, before: before, after: barValue(b.el) });
  }

  // ---------------------------------------------------------------- CELL 1
  // HIT-TEST. A screen reader asks "what is under this point?" rather than
  // enumerating everything. `a2` is the area title to find; `a3` is the row
  // ORDINAL the database predicts for it (0-based, among the table's rows).
  //
  // Three strategies for the SAME task -- "find area X's row" -- each reported
  // in calls, rows realized and ms.
  if (verb === "hittest") {
    var want = a2;
    var predicted = Number(a3);
    var app = appEl();
    var out = { ok: true, want: "(title withheld)", predictedOrdinal: predicted };

    // (a) TODAY: the full sweep. resolveSidebar realizes every row.
    reset();
    var tA = now();
    var full = resolveSidebar(titles, 2);
    var foundA = null;
    if (full.ok === true) {
      for (var i = 0; i < full.rows.length; i++) {
        if (segMatch(full.rows[i].text, want)) {
          foundA = full.rows[i];
          break;
        }
      }
    }
    out.a_fullSweep = {
      ms: Math.round(now() - tA),
      axCalls: CALLS,
      realized: REALIZED,
      found: foundA !== null,
      rowY: foundA ? Math.round(foundA.y) : null,
    };
    if (full.ok !== true) return JSON.stringify({ ok: false, why: full.why });

    var table = full.table;
    var vp = full.viewport;

    // (b) GEOMETRY + HIT-TEST. AXRows + a frame per row costs nothing in the
    // field; the predicted row's centre is then hit-tested, the result walked up
    // to its AXRow, and ONE content read confirms the title.
    reset();
    var tB = now();
    var g = geomRows(table);
    var geomCalls = CALLS;
    var geomMs = now() - tB;
    var target = predicted >= 0 && predicted < g.length ? g[predicted] : null;
    var hit = { attempted: false };
    if (target !== null && target.y !== null) {
      var cx = target.x + Math.min(120, target.w / 2);
      var cy = target.y + target.h / 2;
      var inBand = vp && cy >= vp.y && cy <= vp.y + vp.h;
      hit.attempted = true;
      hit.point = [Math.round(cx), Math.round(cy)];
      hit.inVisibleBand = !!inBand;
      var elRef = Ref();
      var tHit = now();
      CALLS++;
      var errHit = $.AXUIElementCopyElementAtPosition(app, cx, cy, elRef);
      hit.hitMs = round2(now() - tHit);
      hit.axError = errHit;
      if (errHit === 0) {
        var el = ObjC.castRefToObject(elRef[0]);
        hit.hitRole = sv(el, "AXRole");
        // Walk UP to the row. Each hop is one AXParent + one AXRole read.
        var hops = 0,
          cur = el,
          rowEl = null;
        while (cur && hops < 8) {
          var rl = sv(cur, "AXRole");
          if (isRowRole(rl)) {
            rowEl = cur;
            break;
          }
          cur = attr(cur, "AXParent");
          hops++;
        }
        hit.parentHops = hops;
        hit.reachedRow = rowEl !== null;
        if (rowEl !== null) {
          // THE ONE CONTENT READ. This is the only element realized.
          var n1 = node(rowEl, true);
          hit.titleMatches = n1 !== null && segMatch(textOf(n1, [], 2).join("|"), want);
          var fr = n1 && n1.frame;
          hit.rowY = fr ? Math.round(fr.y) : null;
        }
      }
    }
    out.b_geometryHitTest = {
      ms: Math.round(now() - tB),
      geometryMs: Math.round(geomMs),
      geometryAxCalls: geomCalls,
      axCalls: CALLS,
      realized: REALIZED,
      rowsSeenGeometrically: g.length,
      hit: hit,
    };

    // (c) SPARSE CONFIRM. No hit-test at all: geometry for every row, then ONE
    // content read on the predicted ordinal. The hit-test's honest control --
    // if (c) works, the hit-test buys addressing convenience, not cost.
    reset();
    var tC = now();
    var g2 = geomRows(table);
    var direct = { ok: false };
    if (predicted >= 0 && predicted < g2.length) {
      var n2 = node(g2[predicted].el, true);
      direct.ok = n2 !== null;
      direct.titleMatches = n2 !== null && segMatch(textOf(n2, [], 2).join("|"), want);
      direct.rowY = n2 && n2.frame ? Math.round(n2.frame.y) : null;
    }
    out.c_sparseDirect = {
      ms: Math.round(now() - tC),
      axCalls: CALLS,
      realized: REALIZED,
      direct: direct,
    };
    return JSON.stringify(out);
  }

  // A closed-loop scroll onto a row ORDINAL, driven entirely on GEOMETRY: the
  // scroll bar's AXValue is the actuator, row frames are the observable, and not
  // one row's content is touched. The shipped ladder re-runs the whole
  // title-matching census on every iteration of this same loop.
  if (verb === "seekord") {
    reset();
    var rk = resolveSidebar(titles, 2);
    if (rk.ok !== true) return JSON.stringify({ ok: false, why: rk.why });
    var resolveCalls = CALLS,
      resolveRealized = REALIZED;
    var bar3o = scrollBarOf(rk.scroll);
    if (bar3o === null) return JSON.stringify({ ok: false, why: "no-scrollbar" });
    var bar3 = bar3o.el;
    var wantOrd = Number(a2),
      maxIter = Number(a3 || 12);
    var vpk = rk.viewport;
    reset();
    var tk = now();
    var iter = 0,
      landed = false,
      rowY = null;
    for (; iter < maxIter; iter++) {
      var gk2 = geomRows(rk.table);
      if (!(wantOrd >= 0 && wantOrd < gk2.length)) break;
      var row3 = gk2[wantOrd];
      if (row3.y === null) break;
      rowY = row3.y;
      var c3 = row3.y + row3.h / 2;
      if (c3 >= vpk.y + 8 && c3 <= vpk.y + vpk.h - 8) {
        landed = true;
        break;
      }
      var top = Infinity,
        bot = -Infinity;
      for (var z = 0; z < gk2.length; z++) {
        if (gk2[z].y === null) continue;
        top = Math.min(top, gk2[z].y);
        bot = Math.max(bot, gk2[z].y + gk2[z].h);
      }
      var span3 = Math.max(1, bot - top - vpk.h);
      var err3 = vpk.y + vpk.h / 2 - c3;
      var cur3 = barValue(bar3) || 0;
      var tgt3 = Math.max(0, Math.min(1, cur3 + -err3 / span3));
      $.AXUIElementSetAttributeValue(bar3, $("AXValue"), $.NSNumber.numberWithDouble(tgt3));
      sleep(250);
    }
    return JSON.stringify({
      ok: landed,
      ordinal: wantOrd,
      iterations: iter,
      rowY: rowY === null ? null : Math.round(rowY),
      scroll: barValue(bar3),
      loopMs: Math.round(now() - tk),
      loopAxCalls: CALLS,
      loopRealized: REALIZED,
      locatorAxCalls: resolveCalls,
      locatorRealized: resolveRealized,
    });
  }

  // The disclosure chevron's screen point for one area row, found the SPARSE
  // way: geometry for every row, one content read on the predicted ordinal, then
  // the AXImage inside that row. Feeds the observer cell's chevron actuation.
  if (verb === "chevpoint") {
    reset();
    var rc = resolveSidebar(titles, 2);
    if (rc.ok !== true) return JSON.stringify({ ok: false, why: rc.why });
    var gc = geomRows(rc.table);
    var ord = Number(a3);
    if (!(ord >= 0 && ord < gc.length))
      return JSON.stringify({ ok: false, why: "ordinal-out-of-range", rows: gc.length });
    var rowEl2 = gc[ord].el;
    var nc = node(rowEl2, true);
    var matches = nc !== null && segMatch(textOf(nc, [], 2).join("|"), a2);
    function chevIn(el, depth) {
      if (depth < 0) return null;
      var ch = kids(el);
      for (var i = 0; i < ch.length; i++) {
        if (sv(ch[i], "AXRole") === "AXImage" && sv(ch[i], "AXDescription").indexOf("Toggle") >= 0)
          return ch[i];
        var r = chevIn(ch[i], depth - 1);
        if (r) return r;
      }
      return null;
    }
    var cev = chevIn(rowEl2, 5);
    var cf = cev === null ? null : frame(cev);
    var vpc = rc.viewport;
    return JSON.stringify({
      ok: cf !== null,
      titleMatches: matches,
      ordinal: ord,
      point: cf === null ? null : [Math.round(cf.x + cf.w / 2), Math.round(cf.y + cf.h / 2)],
      inBand:
        cf !== null &&
        vpc !== null &&
        cf.y + cf.h / 2 >= vpc.y + 6 &&
        cf.y + cf.h / 2 <= vpc.y + vpc.h - 6,
      axCalls: CALLS,
      realized: REALIZED,
      tableRows: gc.length,
    });
  }

  // ---------------------------------------------------------------- CELL 2
  // VISIBLE-SET AND SPARSE READS, against the full sweep, on the same table.
  // `a2` is a comma-separated list of DB-predicted area-row ordinals.
  if (verb === "visset") {
    var ordinals = String(a2 || "")
      .split(",")
      .filter(function (s) {
        return s !== "";
      })
      .map(Number);
    reset();
    var r = resolveSidebar(titles, 2);
    if (r.ok !== true) return JSON.stringify({ ok: false, why: r.why });
    var tbl = r.table,
      vport = r.viewport;
    var res = {
      ok: true,
      totalRows: r.rows.length,
      viewport: vport,
      predictedOrdinals: ordinals.length,
    };

    // (a) the full sweep, as shipped
    reset();
    var t1 = now();
    var rowsFull = harvestRows(tbl, 2);
    res.a_fullSweep = {
      ms: Math.round(now() - t1),
      axCalls: CALLS,
      realized: REALIZED,
      rows: rowsFull.length,
      areaHits: countTitles(rowsFull, titles),
    };

    // (b) AXVisibleRows + a depth-2 harvest of ONLY those rows
    reset();
    var t2 = now();
    var vis = arrayOf(attr(tbl, "AXVisibleRows"));
    var visRows = [];
    for (var vi = 0; vi < vis.length; vi++) {
      var nv = node(vis[vi], true);
      if (nv === null) continue;
      visRows.push({ text: textOf(nv, [], 2).join("|"), y: nv.frame ? nv.frame.y : null });
    }
    res.b_visibleRows = {
      present: vis.length > 0,
      ms: Math.round(now() - t2),
      axCalls: CALLS,
      realized: REALIZED,
      rows: visRows.length,
      areaHits: countTitles(visRows, titles),
    };

    // (c) SPARSE: geometry for EVERY row (free in the field) + content on only
    // the DB-predicted area ordinals.
    reset();
    var t3 = now();
    var gg = geomRows(tbl);
    var sparseCalls = CALLS;
    var sparseRows = [];
    for (var si = 0; si < ordinals.length; si++) {
      var o = ordinals[si];
      if (o < 0 || o >= gg.length) continue;
      var ns = node(gg[o].el, true);
      if (ns === null) continue;
      sparseRows.push({ text: textOf(ns, [], 2).join("|"), y: ns.frame ? ns.frame.y : null });
    }
    res.c_sparse = {
      ms: Math.round(now() - t3),
      geometryAxCalls: sparseCalls,
      axCalls: CALLS,
      realized: REALIZED,
      rowsSeenGeometrically: gg.length,
      contentRows: sparseRows.length,
      areaHits: countTitles(sparseRows, titles),
      allAreasFound: countTitles(sparseRows, titles) === titles.length,
    };

    // (d) does the geometry-only row list AGREE with the swept one? The sparse
    // strategy is only safe if AXRows and AXChildren enumerate the same rows in
    // the same order -- otherwise a predicted ordinal addresses the wrong row.
    var agree = gg.length === rowsFull.length;
    var maxDy = 0;
    if (agree) {
      for (var k = 0; k < gg.length; k++) {
        if (gg[k].y === null || rowsFull[k].y === null) {
          agree = false;
          break;
        }
        maxDy = Math.max(maxDy, Math.abs(gg[k].y - rowsFull[k].y));
      }
    }
    res.d_orderAgreement = {
      axRowsCount: gg.length,
      axChildrenRowCount: rowsFull.length,
      sameCount: gg.length === rowsFull.length,
      sameOrderByY: agree && maxDy < 0.5,
      maxFrameDeltaPx: round2(maxDy),
    };
    return JSON.stringify(res);
  }

  // ---------------------------------------------------------------- CELL 5
  // PER-ROLE CONTENT COST. Does the ~115 ms/row law apply to sheet controls the
  // same way? Measured as N repeated content reads on ONE element of each role,
  // plus a FIRST-TOUCH measurement on rows never touched before (the field law
  // says the cost is paid on realization and again on every sweep -- so a
  // repeated read of the SAME element is the wrong measurement unless it also
  // costs; both are reported).
  if (verb === "rolecost") {
    var n = Number(a2 || 60);
    reset();
    var rr = resolveSidebar(titles, 2);
    if (rr.ok !== true) return JSON.stringify({ ok: false, why: rr.why });
    var probes = [];

    function timeReads(label, el, count) {
      if (!el) return { label: label, present: false };
      var samples = [];
      for (var i = 0; i < count; i++) {
        var t = now();
        node(el, false);
        samples.push(now() - t);
      }
      var s = stats(samples);
      s.label = label;
      s.present = true;
      s.role = sv(el, "AXRole");
      return s;
    }

    // a sidebar row -- the element the field law was measured on
    var gr = geomRows(rr.table);
    probes.push(timeReads("sidebar-row", gr.length ? gr[Math.floor(gr.length / 2)].el : null, n));
    probes.push(timeReads("sidebar-table", rr.table, n));
    probes.push(timeReads("sidebar-scrollarea", rr.scroll, n));

    // EVERY row, first touch only: the sweep's real shape.
    reset();
    var tf = now();
    for (var q = 0; q < gr.length; q++) node(gr[q].el, true);
    var firstTouchMs = now() - tf;
    probes.push({
      label: "sidebar-rows-first-touch-each",
      present: true,
      rows: gr.length,
      totalMs: Math.round(firstTouchMs),
      msPerRow: round2(firstTouchMs / Math.max(1, gr.length)),
      axCalls: CALLS,
      realized: REALIZED,
    });

    // The SAME rows again, immediately: is a second sweep cheaper (cached) or
    // the same price (realized again)? The field says the same price.
    reset();
    var ts = now();
    for (var q2 = 0; q2 < gr.length; q2++) node(gr[q2].el, true);
    var secondMs = now() - ts;
    probes.push({
      label: "sidebar-rows-second-sweep",
      present: true,
      rows: gr.length,
      totalMs: Math.round(secondMs),
      msPerRow: round2(secondMs / Math.max(1, gr.length)),
      axCalls: CALLS,
      realized: REALIZED,
    });

    // Sheet controls, if a sheet is open.
    var w = mainWindow();
    var sheet = null;
    if (w !== null) {
      var wk = kids(w);
      for (var wi = 0; wi < wk.length; wi++) {
        if (sv(wk[wi], "AXRole") === "AXSheet") {
          sheet = wk[wi];
          break;
        }
      }
    }
    if (sheet !== null) {
      var sk = kids(sheet);
      var byRole = {};
      for (var ski = 0; ski < sk.length; ski++) {
        var rl2 = sv(sk[ski], "AXRole");
        if (!byRole[rl2]) byRole[rl2] = sk[ski];
      }
      for (var rn in byRole) probes.push(timeReads("sheet:" + rn, byRole[rn], n));
      probes.push(timeReads("sheet", sheet, n));
      // one control INSIDE the cadence group, the deepest thing the recipe drives
      if (byRole.AXGroup) {
        var gk = kids(byRole.AXGroup);
        var seen = {};
        for (var gi = 0; gi < gk.length; gi++) {
          var rl3 = sv(gk[gi], "AXRole");
          if (seen[rl3]) continue;
          seen[rl3] = 1;
          probes.push(timeReads("group:" + rl3, gk[gi], n));
        }
      }
    }
    return JSON.stringify({ ok: true, iterations: n, sheetOpen: sheet !== null, probes: probes });
  }

  // ---------------------------------------------------------------- CELL 4
  // THE REPEAT SHEET, one element at a time. What is the MINIMUM number of
  // distinct elements whose content a recipe step must read, when a manifest
  // supplies the path? Reported beside the shipped drive's own round-trip count.
  if (verb === "sheet") {
    var w2 = mainWindow();
    if (w2 === null) return JSON.stringify({ ok: false, why: "no-window" });
    reset();
    var t0s = now();
    var wk2 = kids(w2);
    var sh = null,
      shIdx = -1;
    for (var i2 = 0; i2 < wk2.length; i2++) {
      if (sv(wk2[i2], "AXRole") === "AXSheet") {
        sh = wk2[i2];
        shIdx = i2;
        break;
      }
    }
    if (sh === null) return JSON.stringify({ ok: false, why: "no-sheet-open" });

    // (a) THE SHELL CENSUS -- the shape manifest's gate. One AXChildren read
    // plus one AXRole per child.
    reset();
    var ta = now();
    var shellKids = kids(sh);
    var roles = [];
    for (var a = 0; a < shellKids.length; a++) roles.push(sv(shellKids[a], "AXRole"));
    var censusCalls = CALLS;
    var censusMs = now() - ta;

    // (b) THE CADENCE GROUP, as one batched read per control.
    var grp = null,
      grpIdx = -1;
    for (var b2 = 0; b2 < roles.length; b2++) {
      if (roles[b2] === "AXGroup") {
        grp = shellKids[b2];
        grpIdx = b2;
        break;
      }
    }
    reset();
    var tb = now();
    var gkids = grp === null ? [] : kids(grp);
    var inv = [];
    for (var c2 = 0; c2 < gkids.length; c2++) {
      var nn = node(gkids[c2], true);
      if (nn === null) continue;
      inv.push({
        role: nn.role,
        hasValue: nn.value !== "",
        y: nn.frame ? Math.round(nn.frame.y) : null,
        x: nn.frame ? Math.round(nn.frame.x) : null,
      });
    }
    var groupCalls = CALLS,
      groupRealized = REALIZED;
    var groupMs = now() - tb;

    // (c) ONE CONTROL, addressed by manifest path: the minimum a step needs.
    reset();
    var tc = now();
    var oneOk = false;
    if (grp !== null && gkids.length > 0) {
      var one = node(gkids[Math.min(1, gkids.length - 1)], true);
      oneOk = one !== null;
    }
    var oneCalls = CALLS,
      oneRealized = REALIZED,
      oneMs = now() - tc;

    var mwi = mainWindowIdx();
    var winIdx = mwi === null ? -1 : mwi.idx;
    var controlPaths = [];
    for (var pi2 = 0; pi2 < roles.length; pi2++) {
      controlPaths.push({ role: roles[pi2], path: [winIdx, shIdx, pi2] });
    }
    return JSON.stringify({
      ok: true,
      windowChildIndex: winIdx,
      sheetChildIndex: shIdx,
      sheetPath: [winIdx, shIdx],
      shellRoles: roles,
      controlPaths: controlPaths,
      groupChildIndex: grpIdx,
      groupPath: grpIdx < 0 ? null : [winIdx, shIdx, grpIdx],
      a_shellCensus: { ms: Math.round(censusMs), axCalls: censusCalls, controls: roles.length },
      b_groupInventory: {
        ms: Math.round(groupMs),
        axCalls: groupCalls,
        realized: groupRealized,
        controls: inv.length,
        inventory: inv,
      },
      c_oneControl: { ms: round2(oneMs), axCalls: oneCalls, realized: oneRealized, ok: oneOk },
      discoveryMs: Math.round(now() - t0s),
    });
  }

  // The frequency pop-up's menu, enumerated by child-index path so the observer
  // can press ONE item natively -- no System Events, no spawn, so the measured
  // latency is the app's own and not a process launch's.
  //
  // It presses the pop-up, reads the menu, and presses Escape. Titles ARE read
  // here (a menu item's title is app chrome, not user data) because the point is
  // to pick an item that differs from the pop-up's current value.
  if (verb === "menuitems") {
    var wm = mainWindowIdx();
    if (wm === null) return JSON.stringify({ ok: false, why: "no-window" });
    var wkm = kids(wm.el);
    var shm = null,
      shmIdx = -1;
    for (var mi2 = 0; mi2 < wkm.length; mi2++) {
      if (sv(wkm[mi2], "AXRole") === "AXSheet") {
        shm = wkm[mi2];
        shmIdx = mi2;
        break;
      }
    }
    if (shm === null) return JSON.stringify({ ok: false, why: "no-sheet-open" });
    var skm = kids(shm);
    var puIdx = -1;
    for (var mj = 0; mj < skm.length; mj++) {
      if (sv(skm[mj], "AXRole") === "AXPopUpButton") {
        puIdx = mj;
        break;
      }
    }
    if (puIdx < 0) return JSON.stringify({ ok: false, why: "no-popup-on-shell" });
    var pu = skm[puIdx];
    var current = sv(pu, "AXValue");
    $.AXUIElementPerformAction(pu, $("AXPress"));
    sleep(500);
    var menuEl = null,
      menuIdx = -1;
    var pk = kids(pu);
    for (var mk = 0; mk < pk.length; mk++) {
      if (sv(pk[mk], "AXRole") === "AXMenu") {
        menuEl = pk[mk];
        menuIdx = mk;
        break;
      }
    }
    var items = [];
    if (menuEl !== null) {
      var ik = kids(menuEl);
      for (var mn = 0; mn < ik.length; mn++) {
        items.push({
          index: mn,
          role: sv(ik[mn], "AXRole"),
          title: sv(ik[mn], "AXTitle"),
          path: [wm.idx, shmIdx, puIdx, menuIdx, mn],
        });
      }
    }
    // Escape, so the cell leaves the sheet exactly as it found it.
    var esc = $.CGEventCreateKeyboardEvent($(), 53, true);
    $.CGEventPost($.kCGHIDEventTap, esc);
    var escUp = $.CGEventCreateKeyboardEvent($(), 53, false);
    $.CGEventPost($.kCGHIDEventTap, escUp);
    sleep(400);
    return JSON.stringify({
      ok: menuEl !== null,
      currentValue: current,
      popUpPath: [wm.idx, shmIdx, puIdx],
      menuChildIndex: menuIdx,
      items: items,
    });
  }

  // The cadence group's numeric field, by path -- what a typing step addresses.
  if (verb === "fieldpath") {
    var wf = mainWindowIdx();
    if (wf === null) return JSON.stringify({ ok: false, why: "no-window" });
    var wkf = kids(wf.el);
    var shf = null,
      shfIdx = -1;
    for (var fi = 0; fi < wkf.length; fi++) {
      if (sv(wkf[fi], "AXRole") === "AXSheet") {
        shf = wkf[fi];
        shfIdx = fi;
        break;
      }
    }
    if (shf === null) return JSON.stringify({ ok: false, why: "no-sheet-open" });
    var skf = kids(shf);
    var gIdx = -1;
    for (var fj = 0; fj < skf.length; fj++) {
      if (sv(skf[fj], "AXRole") === "AXGroup") {
        gIdx = fj;
        break;
      }
    }
    if (gIdx < 0) return JSON.stringify({ ok: false, why: "no-group-on-shell" });
    var gkf = kids(skf[gIdx]);
    var tfIdx = -1;
    for (var fk = 0; fk < gkf.length; fk++) {
      if (sv(gkf[fk], "AXRole") === "AXTextField") {
        tfIdx = fk;
        break;
      }
    }
    return JSON.stringify({
      ok: tfIdx >= 0,
      sheetPath: [wf.idx, shfIdx],
      groupPath: [wf.idx, shfIdx, gIdx],
      fieldPath: tfIdx < 0 ? null : [wf.idx, shfIdx, gIdx, tfIdx],
      fieldValue: tfIdx < 0 ? null : sv(gkf[tfIdx], "AXValue"),
      groupControls: gkf.length,
    });
  }

  return JSON.stringify({ ok: false, why: "unknown verb: " + verb });
}
