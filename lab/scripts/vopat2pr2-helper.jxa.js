// VOPAT2 PR 2 — the two measurements the SBCHV1 rig does not make.
//
// Everything else this campaign needs (row census, scroll-bar write, pointer
// park, chevron click) is already in `sbchv1-helper.jxa.js` and is reused
// verbatim; a second copy would be a second thing to keep true. What is here:
//
//   ordinals  Is the ORDINAL SPACE the sparse census addresses rows in the same
//             one the sweep enumerates? `AXRows` and the table's `AXChildren`
//             must be the same list, in the same order, with the same frames
//             (VOPAT1-5 measured 0.00 px at 174 rows — re-checked here because
//             every ordinal-addressed primitive rests on it).
//   geomcost  What ONE ROW's geometry costs, three ways: a batched
//             AXPosition+AXSize (what shipped), two singular reads (what the
//             sweep does), and AXFrame (one call, if the row exposes it).
//
// READ-ONLY. Nothing here clicks, types, scrolls or moves the pointer.
//
// usage: osascript -l JavaScript vopat2pr2.jxa.js <verb> <titles-pipe-joined> [args]
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
function segMatch(text, title) {
  var segs = text.split("|");
  for (var j = 0; j < segs.length; j++) {
    if (segs[j] === title || segs[j] === title + ".") return true;
  }
  return false;
}
/** The sidebar is the candidate list whose rows carry the caller's areas. */
function findSidebar(titles) {
  var w = mainWindow();
  if (w === null) return null;
  var panes = listPanes(w, 8, [], null);
  var best = null,
    bestIdx = -1,
    bestHits = 0;
  for (var i = 0; i < panes.length; i++) {
    var ch = kids(panes[i].table),
      hits = 0;
    for (var r = 0; r < ch.length && hits < titles.length; r++) {
      var n = node(ch[r]);
      if (n === null) continue;
      var t = textOf(n, [], 2).join("|");
      for (var q = 0; q < titles.length; q++) {
        if (segMatch(t, titles[q])) {
          hits++;
          break;
        }
      }
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = panes[i];
      bestIdx = i;
    }
  }
  return best === null ? null : { pane: best, index: bestIdx, hits: bestHits, panes: panes.length };
}

function run(argv) {
  var verb = argv[0] || "";
  var titles = (argv[1] || "").split("|").filter(function (s) {
    return s.length > 0;
  });
  var sb = findSidebar(titles);
  if (sb === null) return JSON.stringify({ ok: false, why: "no-sidebar", verb: verb });

  // ---- ordinals: AXRows must BE the table's AXChildren (VOPAT1-5) ---------
  if (verb === "ordinals") {
    var t0 = now();
    resetCalls();
    var rowsAttr = attr(sb.pane.table, "AXRows");
    var byRows = [];
    if (rowsAttr) {
      for (var i = 0; i < rowsAttr.count; i++) byRows.push(rowsAttr.objectAtIndex(i));
    }
    var rowsCalls = CALLS,
      rowsMs = now() - t0;
    resetCalls();
    var t1 = now();
    var byChildren = [],
      ch = kids(sb.pane.table);
    for (var c = 0; c < ch.length; c++) {
      var role = sv(ch[c], "AXRole");
      if (role === "AXRow" || role === "AXTableRow") byChildren.push(ch[c]);
    }
    var childCalls = CALLS,
      childMs = now() - t1;
    // Compare the two enumerations FRAME BY FRAME: same count, same order, and
    // the maximum position delta between them.
    var maxDelta = 0,
      compared = 0;
    var n = Math.min(byRows.length, byChildren.length);
    for (var k = 0; k < n; k++) {
      var fa = rectOf(attr(byRows[k], "AXPosition"), attr(byRows[k], "AXSize"));
      var fb = rectOf(attr(byChildren[k], "AXPosition"), attr(byChildren[k], "AXSize"));
      if (fa === null || fb === null) continue;
      compared++;
      maxDelta = Math.max(maxDelta, Math.abs(fa.y - fb.y), Math.abs(fa.x - fb.x));
    }
    return JSON.stringify({
      ok: true,
      paneIndex: sb.index,
      panes: sb.panes,
      axRows: byRows.length,
      axChildrenRows: byChildren.length,
      sameCount: byRows.length === byChildren.length,
      compared: compared,
      maxFrameDeltaPx: maxDelta,
      cost: {
        axRowsCalls: rowsCalls,
        axRowsMs: Math.round(rowsMs),
        axChildrenCalls: childCalls,
        axChildrenMs: Math.round(childMs),
      },
    });
  }

  // ---- geomcost: what ONE row's geometry costs, three ways ---------------
  if (verb === "geomcost") {
    var reps = Math.max(1, Number(argv[2] || 3));
    var rowsA = attr(sb.pane.table, "AXRows");
    var els = [];
    if (rowsA) {
      for (var g = 0; g < rowsA.count; g++) els.push(rowsA.objectAtIndex(g));
    }
    var GEO = $(["AXPosition", "AXSize"]);
    function batched() {
      resetCalls();
      var t = now(),
        ok = 0;
      for (var i2 = 0; i2 < els.length; i2++) {
        CALLS++;
        var out = Ref();
        if ($.AXUIElementCopyMultipleAttributeValues(els[i2], GEO, 0, out) !== 0) continue;
        var a = ObjC.castRefToObject(out[0]);
        if (a && Number(a.count) >= 2 && rectOf(a.objectAtIndex(0), a.objectAtIndex(1))) ok++;
      }
      return { ms: Math.round(now() - t), calls: CALLS, resolved: ok };
    }
    function singular() {
      resetCalls();
      var t = now(),
        ok = 0;
      for (var i3 = 0; i3 < els.length; i3++) {
        if (rectOf(attr(els[i3], "AXPosition"), attr(els[i3], "AXSize"))) ok++;
      }
      return { ms: Math.round(now() - t), calls: CALLS, resolved: ok };
    }
    function axframe() {
      resetCalls();
      var t = now(),
        ok = 0;
      for (var i4 = 0; i4 < els.length; i4++) {
        if (attr(els[i4], "AXFrame") !== null) ok++;
      }
      return { ms: Math.round(now() - t), calls: CALLS, resolved: ok };
    }
    function content() {
      resetCalls();
      var t = now(),
        ok = 0;
      for (var i5 = 0; i5 < els.length; i5++) {
        var nn = node(els[i5]);
        if (nn === null) continue;
        textOf(nn, [], 2);
        ok++;
      }
      return { ms: Math.round(now() - t), calls: CALLS, realized: ok };
    }
    var runs = { batched: [], singular: [], axframe: [], content: [] };
    for (var rep = 0; rep < reps; rep++) {
      runs.batched.push(batched());
      runs.singular.push(singular());
      runs.axframe.push(axframe());
      runs.content.push(content());
    }
    return JSON.stringify({ ok: true, rows: els.length, runs: runs });
  }

  return JSON.stringify({ ok: false, why: "unknown verb: " + verb });
}
