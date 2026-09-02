// SBCHV1 — the measurement rig for #676.
//
// The prelude below is the shipped ui-drag.ts JXA prelude verbatim EXCEPT that
// every AX round-trip is counted, so a cost can be attributed to a stage, a
// depth and a matcher rather than guessed at. Read-only apart from the two
// deliberate actuation verbs (`park`, `setbar`), which move the pointer and the
// scroll bar and nothing else.
//
// usage: osascript -l JavaScript sbchv1.jxa.js <verb> <titles-pipe-joined> [args...]
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");

var CALLS = 0;
function resetCalls() {
  CALLS = 0;
}
function now() {
  return $.NSDate.date.timeIntervalSince1970 * 1000;
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
var NODE_ATTRS = $([
  "AXValue",
  "AXDescription",
  "AXTitle",
  "AXChildren",
  "AXPosition",
  "AXSize",
  "AXRole",
]);
function node(el) {
  CALLS++;
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
function textOf(n, acc, depth) {
  if (n === null) return acc;
  if (n.value) acc.push(n.value);
  if (n.desc) acc.push(n.desc);
  if (n.title) acc.push(n.title);
  if (depth <= 0) return acc;
  for (var i = 0; i < n.children.length; i++) textOf(node(n.children[i]), acc, depth - 1);
  return acc;
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
function harvestRows(tableEl, depth) {
  var out = [],
    ch = kids(tableEl);
  for (var i = 0; i < ch.length; i++) {
    var n = node(ch[i]);
    if (n === null) continue;
    if (n.role !== "AXRow" && n.role !== "AXTableRow") continue;
    var f = n.frame;
    out.push({
      text: textOf(n, [], depth).join("|"),
      x: f ? f.x : null,
      y: f ? f.y : null,
      w: f ? f.w : null,
      h: f ? f.h : null,
    });
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
function resolveSidebar(titles, depth) {
  var w = mainWindow();
  if (w === null) return { ok: false, why: "no-window" };
  var panes = listPanes(w, 8, [], null);
  if (panes.length === 0) return { ok: false, why: "no-list-candidates" };
  var scored = [],
    i;
  for (i = 0; i < panes.length; i++) {
    var rows = harvestRows(panes[i].table, depth);
    scored.push({
      pane: panes[i],
      rows: rows,
      hits: countTitles(rows, titles),
      frame: frame(panes[i].table),
    });
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
    scroll: best.pane.scroll,
    viewport: vp,
    rows: best.rows,
    hits: best.hits,
  };
}
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

// ---------------------------------------------------------------- verbs

var FIXED_LISTS = ["Inbox", "Today", "Upcoming", "Anytime", "Someday", "Logbook", "Trash"];

function chevronOf(el, depth) {
  if (depth < 0) return null;
  var ch = kids(el);
  for (var i = 0; i < ch.length; i++) {
    if (sv(ch[i], "AXRole") === "AXImage" && sv(ch[i], "AXDescription").indexOf("Toggle") >= 0)
      return ch[i];
    var r = chevronOf(ch[i], depth - 1);
    if (r) return r;
  }
  return null;
}

// The OLD matcher the shipped chevron script used: a hand-rolled depth-6 walk
// with three separate attribute reads per node.
function allTextOld(el, acc, depth) {
  acc = acc || [];
  depth = depth == null ? 6 : depth;
  if (depth < 0) return acc;
  var v = sv(el, "AXValue");
  if (v) acc.push(v);
  var d = sv(el, "AXDescription");
  if (d) acc.push(d);
  var t = sv(el, "AXTitle");
  if (t) acc.push(t);
  var ch = kids(el);
  for (var i = 0; i < ch.length; i++) allTextOld(ch[i], acc, depth - 1);
  return acc;
}
function matchesOld(el, title) {
  var segs = allTextOld(el, [], 6);
  for (var j = 0; j < segs.length; j++) {
    if (segs[j] === title || segs[j] === title + ".") return true;
  }
  return false;
}

function classify(text, titles) {
  if (text === "") return "spacer";
  for (var i = 0; i < titles.length; i++) if (segMatch(text, titles[i])) return "area";
  for (var j = 0; j < FIXED_LISTS.length; j++) if (segMatch(text, FIXED_LISTS[j])) return "fixed";
  return "project";
}

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
    var p = $.CGEventGetLocation($.CGEventCreate($()));
    return JSON.stringify({ parked: [Number(a2), Number(a3)], at: [p.x, p.y] });
  }

  var sb = resolveSidebar(titles, 2);
  if (sb.ok !== true) return JSON.stringify({ ok: false, why: sb.why, verb: verb });

  if (verb === "state") {
    return JSON.stringify({
      ok: true,
      rows: sb.rows.length,
      hits: sb.hits,
      titles: titles.length,
      viewport: sb.viewport,
      scroll: barValue(scrollBarOf(sb.scroll)),
    });
  }

  if (verb === "geom") {
    var p2 = $.CGEventGetLocation($.CGEventCreate($()));
    return JSON.stringify({
      ok: true,
      viewport: sb.viewport,
      rows: sb.rows.length,
      scroll: barValue(scrollBarOf(sb.scroll)),
      pointer: [Math.round(p2.x), Math.round(p2.y)],
    });
  }

  if (verb === "setbar") {
    var bar = scrollBarOf(sb.scroll);
    if (bar === null) return JSON.stringify({ ok: false, why: "no-scrollbar" });
    var before = barValue(bar);
    var err = $.AXUIElementSetAttributeValue(
      bar,
      $("AXValue"),
      $.NSNumber.numberWithDouble(Number(a2)),
    );
    sleep(250);
    return JSON.stringify({ ok: err === 0, before: before, after: barValue(bar) });
  }

  // Closed-loop scroll onto a named row using the scroll bar alone.
  if (verb === "seek") {
    var want = a2,
      maxIter = Number(a3 || 12),
      bar2 = scrollBarOf(sb.scroll);
    if (bar2 === null) return JSON.stringify({ ok: false, why: "no-scrollbar" });
    for (var it = 0; it < maxIter; it++) {
      var snap = resolveSidebar(titles, 2);
      if (snap.ok !== true) return JSON.stringify({ ok: false, why: snap.why, iter: it });
      var row = null;
      for (var r = 0; r < snap.rows.length; r++) {
        if (snap.rows[r].y !== null && segMatch(snap.rows[r].text, want)) {
          row = snap.rows[r];
          break;
        }
      }
      if (row === null) return JSON.stringify({ ok: false, why: "row-not-found", iter: it });
      var vp = snap.viewport,
        c = row.y + row.h / 2;
      if (c >= vp.y + 6 && c <= vp.y + vp.h - 6)
        return JSON.stringify({ ok: true, iter: it, rowY: row.y });
      var top = Infinity,
        bot = -Infinity;
      for (var q = 0; q < snap.rows.length; q++) {
        if (snap.rows[q].y === null) continue;
        top = Math.min(top, snap.rows[q].y);
        bot = Math.max(bot, snap.rows[q].y + snap.rows[q].h);
      }
      var span = Math.max(1, bot - top - vp.h);
      var err2 = vp.y + vp.h / 2 - c;
      var cur = barValue(scrollBarOf(snap.scroll)) || 0;
      var target = Math.max(0, Math.min(1, cur + -err2 / span));
      $.AXUIElementSetAttributeValue(
        scrollBarOf(snap.scroll),
        $("AXValue"),
        $.NSNumber.numberWithDouble(target),
      );
      sleep(300);
    }
    return JSON.stringify({ ok: false, why: "iteration-limit" });
  }

  // Per-AX-call latency on THIS host: N single-attribute reads and N batched
  // multi-attribute reads against the same live element.
  if (verb === "latency") {
    var n = Number(a2 || 400);
    var rowsK = kids(sb.table);
    var probe = rowsK.length > 0 ? rowsK[0] : sb.table;
    resetCalls();
    var t0 = now();
    for (var i2 = 0; i2 < n; i2++) sv(probe, "AXRole");
    var singleMs = now() - t0;
    resetCalls();
    var t1 = now();
    for (var i3 = 0; i3 < n; i3++) node(probe);
    var batchMs = now() - t1;
    return JSON.stringify({
      ok: true,
      n: n,
      singleAttrTotalMs: Math.round(singleMs),
      singleAttrPerCallMs: Math.round((singleMs / n) * 1000) / 1000,
      batchedNodeTotalMs: Math.round(batchMs),
      batchedNodePerCallMs: Math.round((batchMs / n) * 1000) / 1000,
      tableChildren: rowsK.length,
    });
  }

  // The two row matchers, head to head, over the SAME live table.
  if (verb === "matchcost") {
    var want2 = a2;
    var ch2 = kids(sb.table);
    resetCalls();
    var tA = now(),
      hitsOld = 0;
    for (var x = 0; x < ch2.length; x++) {
      var role = sv(ch2[x], "AXRole");
      if (role !== "AXRow" && role !== "AXTableRow") continue;
      if (!matchesOld(ch2[x], want2)) continue;
      if (frame(ch2[x])) hitsOld++;
    }
    var oldMs = now() - tA,
      oldCalls = CALLS;
    resetCalls();
    var tB = now(),
      hitsNew = 0,
      scanned = 0;
    for (var y = 0; y < ch2.length; y++) {
      var nn = node(ch2[y]);
      if (nn === null) continue;
      if (nn.role !== "AXRow" && nn.role !== "AXTableRow") continue;
      scanned++;
      if (!segMatch(textOf(nn, [], 2).join("|"), want2)) continue;
      if (nn.frame) hitsNew++;
    }
    var newMs = now() - tB,
      newCalls = CALLS;
    return JSON.stringify({
      ok: true,
      want: want2,
      tableChildren: ch2.length,
      rowsScanned: scanned,
      old: { ms: Math.round(oldMs), calls: oldCalls, hits: hitsOld },
      new: { ms: Math.round(newMs), calls: newCalls, hits: hitsNew },
      agree: hitsOld === hitsNew,
      speedup: Math.round((oldMs / Math.max(1, newMs)) * 10) / 10,
    });
  }

  // Every row in the table, in CHILD-INDEX order, with its kind, height and
  // whether it exposes a disclosure chevron. The ground truth for the row-kind
  // law, the height-constancy question, and the ordinal prediction.
  if (verb === "rowkinds") {
    var ch3 = kids(sb.table),
      out = [];
    for (var z = 0; z < ch3.length; z++) {
      var n3 = node(ch3[z]);
      if (n3 === null) continue;
      if (n3.role !== "AXRow" && n3.role !== "AXTableRow") continue;
      var txt = textOf(n3, [], 2).join("|");
      var f3 = n3.frame;
      out.push({
        i: z,
        role: n3.role,
        text: txt,
        kind: classify(txt, titles),
        chevron: chevronOf(ch3[z], 5) !== null,
        x: f3 ? f3.x : null,
        y: f3 ? f3.y : null,
        w: f3 ? f3.w : null,
        h: f3 ? f3.h : null,
      });
    }
    return JSON.stringify({ ok: true, viewport: sb.viewport, rows: out });
  }

  // THE SPARSE PROTOTYPE. `pred` (argv[2]) is the host's DB-derived prediction:
  //   {"rowCount":N,"areas":[{"ordinal":i,"title":"…"}, …]}
  // The confirmation is ONE AXChildren read plus one batched node() per
  // predicted area ordinal. Compared against a full sweep in the same pass.
  if (verb === "sparse") {
    var pred = JSON.parse(a2 || "{}");
    resetCalls();
    var tF = now();
    var full = resolveSidebar(titles, 2);
    var fullMs = now() - tF,
      fullCalls = CALLS;
    resetCalls();
    var tS = now();
    var chS = kids(sb.table);
    var confirmed = 0,
      mismatches = [];
    if (typeof pred.rowCount === "number" && pred.rowCount !== chS.length) {
      mismatches.push("row-count predicted=" + pred.rowCount + " actual=" + chS.length);
    }
    var predAreas = pred.areas || [];
    var sparseRows = [];
    for (var s = 0; s < predAreas.length; s++) {
      var idx = predAreas[s].ordinal;
      var el = chS[idx];
      if (!el) {
        mismatches.push("ordinal " + idx + " does not exist");
        continue;
      }
      var ns = node(el);
      if (ns === null) {
        mismatches.push("ordinal " + idx + " did not resolve");
        continue;
      }
      var ts = textOf(ns, [], 2).join("|");
      if (!segMatch(ts, predAreas[s].title)) {
        mismatches.push("ordinal " + idx + " title mismatch");
        continue;
      }
      confirmed++;
      sparseRows.push({ i: idx, title: predAreas[s].title, frame: ns.frame });
    }
    var sparseMs = now() - tS,
      sparseCalls = CALLS;
    return JSON.stringify({
      ok: true,
      full: {
        ms: Math.round(fullMs),
        calls: fullCalls,
        rows: full.ok === true ? full.rows.length : -1,
      },
      sparse: {
        ms: Math.round(sparseMs),
        calls: sparseCalls,
        rows: chS.length,
        confirmed: confirmed,
      },
      agree: mismatches.length === 0 && confirmed === predAreas.length,
      diff: mismatches,
      areaFrames: sparseRows,
    });
  }

  // The AXImage descriptions each row kind exposes. App-authored strings, never
  // user data — this is what decides whether "carries a Toggle image" can serve
  // as an area-row discriminator on its own.
  if (verb === "imgdesc") {
    var chI = kids(sb.table),
      byKind = {};
    function imagesOf(el, depth, acc) {
      if (depth < 0) return acc;
      var c = kids(el);
      for (var i6 = 0; i6 < c.length; i6++) {
        if (sv(c[i6], "AXRole") === "AXImage") acc.push(sv(c[i6], "AXDescription"));
        imagesOf(c[i6], depth - 1, acc);
      }
      return acc;
    }
    for (var w2 = 0; w2 < chI.length; w2++) {
      var nI = node(chI[w2]);
      if (nI === null) continue;
      if (nI.role !== "AXRow" && nI.role !== "AXTableRow") continue;
      var kI = classify(textOf(nI, [], 2).join("|"), titles);
      var imgs = imagesOf(chI[w2], 5, []);
      if (!byKind[kI]) byKind[kI] = {};
      for (var d6 = 0; d6 < imgs.length; d6++) {
        byKind[kI][imgs[d6]] = (byKind[kI][imgs[d6]] || 0) + 1;
      }
    }
    return JSON.stringify({ ok: true, imageDescriptionsByRowKind: byKind });
  }

  // The full depth-2 sweep's own cost and AX-call count — the denominator of
  // every cost-model prediction. Run twice; the first can include warm-up.
  if (verb === "sweepcost") {
    var runs = [];
    for (var rr2 = 0; rr2 < 2; rr2++) {
      resetCalls();
      var tS2 = now();
      var res2 = resolveSidebar(titles, 2);
      runs.push({
        ms: Math.round(now() - tS2),
        calls: CALLS,
        rows: res2.ok === true ? res2.rows.length : -1,
      });
    }
    // The same table read through AXRows / AXVisibleRows instead of AXChildren.
    resetCalls();
    var tV = now();
    var vr = attr(sb.table, "AXVisibleRows");
    var vrCount = vr === null ? -1 : Number(vr.count);
    var vrHarvest = [];
    if (vrCount > 0) {
      for (var v2 = 0; v2 < vrCount; v2++) {
        var nv = node(vr.objectAtIndex(v2));
        if (nv === null) continue;
        vrHarvest.push({ text: textOf(nv, [], 2).join("|"), frame: nv.frame });
      }
    }
    var vrMs = now() - tV,
      vrCalls = CALLS;
    return JSON.stringify({
      ok: true,
      tableRows: sb.rows.length,
      fullSweep: runs,
      visibleRowSweep: {
        count: vrCount,
        ms: Math.round(vrMs),
        calls: vrCalls,
        harvested: vrHarvest.length,
      },
    });
  }

  // ------------------------------------------------ BOUNDED READS (AXVisibleRows)
  // Does the sidebar table expose an NSTableView-style visible-row window? If it
  // does, every snapshot can read ~30 rows instead of 174 regardless of how tall
  // the list is — the single biggest lever on the field host's 16s read.
  if (verb === "visrows") {
    var names = attr(sb.table, "AXAttributeNames" /* not an AX attr; see below */);
    var attrNames = [];
    var outRef = Ref();
    if ($.AXUIElementCopyAttributeNames(sb.table, outRef) === 0) {
      var arr = ObjC.castRefToObject(outRef[0]);
      for (var an = 0; an < arr.count; an++) attrNames.push(arr.objectAtIndex(an).js);
    }
    function tryRows(name) {
      resetCalls();
      var t = now();
      var v = attr(sb.table, name);
      var ms = now() - t;
      if (v === null) return { present: false, ms: Math.round(ms) };
      var c = -1;
      try {
        c = Number(v.count);
      } catch (e) {
        c = -1;
      }
      var frames = [];
      if (c > 0) {
        for (var k = 0; k < c; k++) {
          var f = frame(v.objectAtIndex(k));
          if (f) frames.push({ y: f.y, h: f.h });
        }
      }
      return {
        present: true,
        count: c,
        ms: Math.round(ms),
        callsIncludingFrames: CALLS,
        frames: frames.length,
        minY: frames.length
          ? Math.min.apply(
              null,
              frames.map(function (q) {
                return q.y;
              }),
            )
          : null,
        maxY: frames.length
          ? Math.max.apply(
              null,
              frames.map(function (q) {
                return q.y + q.h;
              }),
            )
          : null,
      };
    }
    // How many rows actually have their centre inside the viewport right now?
    var inBand = 0;
    for (var vb = 0; vb < sb.rows.length; vb++) {
      var rr = sb.rows[vb];
      if (rr.y === null) continue;
      var cy = rr.y + rr.h / 2;
      if (cy >= sb.viewport.y && cy <= sb.viewport.y + sb.viewport.h) inBand++;
    }
    return JSON.stringify({
      ok: true,
      attributeNames: attrNames,
      tableRows: sb.rows.length,
      rowsWithCentreInViewport: inBand,
      viewport: sb.viewport,
      AXVisibleRows: tryRows("AXVisibleRows"),
      AXRows: tryRows("AXRows"),
      AXVisibleChildren: tryRows("AXVisibleChildren"),
    });
  }

  // ------------------------------------------------ SHORTCUTS TO COLLAPSE-ALL
  // The View menu, enumerated. Is there a "collapse all" item at all?
  if (verb === "viewmenu") {
    var se = Application("System Events");
    var items = [];
    try {
      var mi = se.processes.byName("Things3").menuBars[0].menuBarItems;
      for (var m = 0; m < mi.length; m++) {
        var sub = [];
        try {
          var mis = mi[m].menus[0].menuItems;
          for (var q2 = 0; q2 < mis.length; q2++) sub.push(mis[q2].name());
        } catch (e) {
          /* menu did not open */
        }
        items.push({ menu: mi[m].name(), items: sub });
      }
    } catch (e) {
      return JSON.stringify({ ok: false, why: "menu enumeration failed: " + e });
    }
    return JSON.stringify({ ok: true, menus: items });
  }

  // Click a named area row's chevron, optionally with a modifier held.
  // mods: "" (plain) | "alt" | "cmd" | "shift". Reports the row count before and
  // after, so a collapse-all shortcut is visible as a multi-section delta.
  if (verb === "chevclick") {
    var wantC = a2,
      mods = a3 || "";
    var chC = kids(sb.table),
      pick = null;
    for (var c2 = 0; c2 < chC.length; c2++) {
      var nC = node(chC[c2]);
      if (nC === null) continue;
      if (nC.role !== "AXRow" && nC.role !== "AXTableRow") continue;
      if (!segMatch(textOf(nC, [], 2).join("|"), wantC)) continue;
      pick = { el: chC[c2], f: nC.frame };
      break;
    }
    if (pick === null) return JSON.stringify({ ok: false, why: "row-not-found" });
    var imgC = chevronOf(pick.el, 5);
    if (imgC === null) return JSON.stringify({ ok: false, why: "no-chevron" });
    var cfC = frame(imgC);
    if (cfC === null) return JSON.stringify({ ok: false, why: "no-chevron-frame" });
    var cxC = cfC.x + cfC.w / 2,
      cyC = cfC.y + cfC.h / 2;
    if (cyC < sb.viewport.y + 6 || cyC > sb.viewport.y + sb.viewport.h - 6) {
      return JSON.stringify({ ok: false, why: "chevron-off-band", y: cyC });
    }
    var FLAG = 0;
    if (mods === "alt") FLAG = 0x00080000; // kCGEventFlagMaskAlternate
    if (mods === "cmd") FLAG = 0x00100000; // kCGEventFlagMaskCommand
    if (mods === "shift") FLAG = 0x00020000; // kCGEventFlagMaskShift
    var before = sb.rows.length;
    var mvC = mev(MOVED, cxC, cyC, 0);
    $.CGEventSetFlags(mvC, 0);
    postHID(mvC);
    sleep(300);
    var dnC = mev(DOWN, cxC, cyC, 1);
    $.CGEventSetFlags(dnC, FLAG);
    postHID(dnC);
    sleep(90);
    var upC = mev(UP, cxC, cyC, 1);
    $.CGEventSetFlags(upC, FLAG);
    postHID(upC);
    sleep(700);
    var afterSnap = resolveSidebar(titles, 2);
    return JSON.stringify({
      ok: true,
      mods: mods,
      at: [Math.round(cxC), Math.round(cyC)],
      rowsBefore: before,
      rowsAfter: afterSnap.ok === true ? afterSnap.rows.length : -1,
    });
  }

  // THE COLLAPSE-ALL PROTOTYPE. Top-down: find the first area row that still
  // renders children, click its chevron, re-read, repeat. Counts every AX call
  // and every millisecond, so the whole strategy's cost is one number.
  if (verb === "collapseall") {
    var maxIter = Number(a2 || 30);
    resetCalls();
    var tCA = now(),
      iters = [],
      snapCA = sb;
    function areaRowsOf(snap) {
      var ordered = snap.rows
        .filter(function (r) {
          return r.y !== null;
        })
        .slice()
        .sort(function (p, q) {
          return p.y - q.y;
        });
      var out2 = [];
      for (var i5 = 0; i5 < ordered.length; i5++) {
        for (var t5 = 0; t5 < titles.length; t5++) {
          if (segMatch(ordered[i5].text, titles[t5])) {
            out2.push({ title: titles[t5], row: ordered[i5], idx: i5 });
            break;
          }
        }
      }
      return { ordered: ordered, areas: out2 };
    }
    for (var it2 = 0; it2 < maxIter; it2++) {
      var ar = areaRowsOf(snapCA);
      // The first area whose section still renders more than its own row.
      var targetA = null;
      for (var a5 = 0; a5 < ar.areas.length; a5++) {
        var nextTop = a5 + 1 < ar.areas.length ? ar.areas[a5 + 1].idx : ar.ordered.length;
        var count = nextTop - ar.areas[a5].idx;
        if (count > 2) {
          targetA = ar.areas[a5];
          break;
        }
      }
      if (targetA === null) {
        iters.push({ iteration: it2, done: true, rows: snapCA.rows.length });
        break;
      }
      // The row must be in the band; scroll it there with the bar if not.
      var cyA = targetA.row.y + targetA.row.h / 2;
      if (cyA < snapCA.viewport.y + 6 || cyA > snapCA.viewport.y + snapCA.viewport.h - 6) {
        var topA = Infinity,
          botA = -Infinity;
        for (var q5 = 0; q5 < snapCA.rows.length; q5++) {
          if (snapCA.rows[q5].y === null) continue;
          topA = Math.min(topA, snapCA.rows[q5].y);
          botA = Math.max(botA, snapCA.rows[q5].y + snapCA.rows[q5].h);
        }
        var spanA = Math.max(1, botA - topA - snapCA.viewport.h);
        var curA = barValue(scrollBarOf(snapCA.scroll)) || 0;
        var errA = snapCA.viewport.y + snapCA.viewport.h / 2 - cyA;
        $.AXUIElementSetAttributeValue(
          scrollBarOf(snapCA.scroll),
          $("AXValue"),
          $.NSNumber.numberWithDouble(Math.max(0, Math.min(1, curA + -errA / spanA))),
        );
        sleep(300);
        snapCA = resolveSidebar(titles, 2);
        if (snapCA.ok !== true) {
          iters.push({ iteration: it2, why: "snapshot-failed" });
          break;
        }
        continue;
      }
      var chevA = null,
        chA = kids(snapCA.table);
      for (var k5 = 0; k5 < chA.length; k5++) {
        var nA = node(chA[k5]);
        if (nA === null) continue;
        if (nA.role !== "AXRow" && nA.role !== "AXTableRow") continue;
        if (!segMatch(textOf(nA, [], 2).join("|"), targetA.title)) continue;
        chevA = chevronOf(chA[k5], 5);
        break;
      }
      if (chevA === null) {
        iters.push({ iteration: it2, title: targetA.title, why: "no-chevron" });
        break;
      }
      var cfA = frame(chevA);
      if (cfA === null) {
        iters.push({ iteration: it2, title: targetA.title, why: "no-chevron-frame" });
        break;
      }
      var cxA2 = cfA.x + cfA.w / 2,
        cyA2 = cfA.y + cfA.h / 2;
      var mvA = mev(MOVED, cxA2, cyA2, 0);
      $.CGEventSetFlags(mvA, 0);
      postHID(mvA);
      sleep(250);
      var dnA = mev(DOWN, cxA2, cyA2, 1);
      $.CGEventSetFlags(dnA, 0);
      postHID(dnA);
      sleep(90);
      var upA = mev(UP, cxA2, cyA2, 1);
      $.CGEventSetFlags(upA, 0);
      postHID(upA);
      sleep(600);
      var before2 = snapCA.rows.length;
      snapCA = resolveSidebar(titles, 2);
      if (snapCA.ok !== true) {
        iters.push({ iteration: it2, why: "snapshot-failed-after-click" });
        break;
      }
      iters.push({
        iteration: it2,
        title: targetA.title,
        rowsBefore: before2,
        rowsAfter: snapCA.rows.length,
      });
    }
    return JSON.stringify({
      ok: true,
      totalMs: Math.round(now() - tCA),
      totalCalls: CALLS,
      finalRows: snapCA.ok === true ? snapCA.rows.length : -1,
      iterations: iters,
    });
  }

  return JSON.stringify({ ok: false, why: "unknown verb: " + verb });
}
