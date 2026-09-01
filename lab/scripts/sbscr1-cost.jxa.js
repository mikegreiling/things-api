// SBSCR1 — an INSTRUMENTED copy of the shipped sidebar-snapshot resolver.
//
// The functions below are the ui-drag.ts JXA prelude verbatim except that every
// AX call is counted, so the cost can be attributed to a PANE and a DEPTH rather
// than guessed at. This is the rig for #672's field failure: the snapshot blew
// through its 30s step budget against a 174-row sidebar.
//
// usage: osascript -l JavaScript sbscr1-cost.js <titles-pipe-joined> [depths csv]
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");

var CALLS = 0;
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
  if (n === null || depth < 0) return acc;
  if (n.value) acc.push(n.value);
  if (n.desc) acc.push(n.desc);
  if (n.title) acc.push(n.title);
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
function now() {
  return $.NSDate.date.timeIntervalSince1970 * 1000;
}

// Where do a row's depth-2 node visits actually GO? Histogram by role and level,
// plus which level first yields a title match. The evidence for any early-out.
function composition(tableEl, titles) {
  var ch = kids(tableEl),
    hist = {},
    textLevel = {},
    rows = 0,
    visits = 0;
  function walk(n, level, rowRec) {
    if (n === null || level > 2) return;
    visits++;
    var key = "L" + level + ":" + (n.role || "?");
    hist[key] = (hist[key] || 0) + 1;
    var txt = [n.value, n.desc, n.title].filter(Boolean);
    for (var t = 0; t < titles.length; t++) {
      for (var s = 0; s < txt.length; s++) {
        if (txt[s] === titles[t] || txt[s] === titles[t] + ".") {
          if (rowRec.hitLevel === null || level < rowRec.hitLevel) rowRec.hitLevel = level;
        }
      }
    }
    if (txt.length) rowRec.textLevels[level] = (rowRec.textLevels[level] || 0) + 1;
    for (var i = 0; i < n.children.length; i++) walk(node(n.children[i]), level + 1, rowRec);
  }
  for (var i = 0; i < ch.length; i++) {
    var n0 = node(ch[i]);
    if (n0 === null) continue;
    if (n0.role !== "AXRow" && n0.role !== "AXTableRow") continue;
    rows++;
    var rec = { hitLevel: null, textLevels: {} };
    walk(n0, 0, rec);
    var k = rec.hitLevel === null ? "no-title-match" : "title-at-L" + rec.hitLevel;
    textLevel[k] = (textLevel[k] || 0) + 1;
  }
  return {
    rows: rows,
    visitsPerRow: Math.round((visits / Math.max(1, rows)) * 10) / 10,
    roleHistogram: hist,
    titleDepth: textLevel,
  };
}

function run(argv) {
  var titles = (argv[0] || "").split("|").filter(function (s) {
    return s.length > 0;
  });
  var depths = (argv[1] || "1,2,3,4,6").split(",").map(Number);
  if (argv[1] === "composition") {
    var w0 = mainWindow();
    if (w0 === null) return JSON.stringify({ ok: false, why: "no-window" });
    var panes0 = listPanes(w0, 8, [], null),
      out0 = [];
    for (var p = 0; p < panes0.length; p++) {
      var t0 = now(),
        c0 = CALLS;
      var comp = composition(panes0[p].table, titles);
      comp.pane = p;
      comp.ms = Math.round(now() - t0);
      comp.calls = CALLS - c0;
      out0.push(comp);
    }
    return JSON.stringify({ ok: true, panes: out0 });
  }

  var t0 = now(),
    c0 = CALLS;
  var w = mainWindow();
  if (w === null) return JSON.stringify({ ok: false, why: "no-window" });
  var panes = listPanes(w, 8, [], null);
  var walkMs = now() - t0,
    walkCalls = CALLS - c0;

  var out = {
    ok: true,
    titles: titles.length,
    paneCount: panes.length,
    paneWalkMs: Math.round(walkMs),
    paneWalkCalls: walkCalls,
    depths: [],
  };

  for (var d = 0; d < depths.length; d++) {
    var depth = depths[d],
      perPane = [],
      td = now(),
      cd = CALLS,
      totalRows = 0,
      bestHits = 0;
    for (var i = 0; i < panes.length; i++) {
      var tp = now(),
        cp = CALLS;
      var rows = harvestRows(panes[i].table, depth);
      var hits = countTitles(rows, titles);
      var f = frame(panes[i].table);
      totalRows += rows.length;
      if (hits > bestHits) bestHits = hits;
      perPane.push({
        pane: i,
        rows: rows.length,
        hits: hits,
        ms: Math.round(now() - tp),
        calls: CALLS - cp,
        w: f ? Math.round(f.w) : null,
        h: f ? Math.round(f.h) : null,
        sample: rows.length ? rows[Math.min(1, rows.length - 1)].text.slice(0, 90) : "",
      });
    }
    out.depths.push({
      depth: depth,
      ms: Math.round(now() - td),
      calls: CALLS - cd,
      rows: totalRows,
      bestHits: bestHits,
      of: titles.length,
      escalates: bestHits < titles.length,
      perPane: perPane,
    });
  }
  return JSON.stringify(out);
}
