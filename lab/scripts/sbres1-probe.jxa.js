// SBRES1 probe — the AX-tree anatomy and cost decomposition behind
// "the sidebar did not resolve" (issues #665 / #651).
//
// Verbs (osascript -l JavaScript sbres1.js <verb> [args]):
//   tree <depth>      dump the window's AX tree, pruned at table/outline rows
//   locate            what the SHIPPED sidebarTable()/viewport heuristics resolve
//   cost              wall clock + AX-call counts: shipped locator vs row walk
//                     vs a PRUNED locator that never enters a list's rows
//   enhanced <0|1>    set AXEnhancedUserInterface on the Things process
//   split <dx>        drag the window's split divider by dx points
//   menu <name>       census a menu-bar menu's items (looking for hide-sidebar)
//
// Everything here is READ-ONLY except `enhanced` and `split`, which move the
// app's own window chrome and nothing in the database.
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");

var CALLS = 0;

function pidOf(n) {
  return Application("System Events").processes.byName(n).unixId();
}
function sleepMs(ms) {
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
function frame(el) {
  var p = attr(el, "AXPosition"),
    z = attr(el, "AXSize");
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
function stdWindow() {
  var ws = kids(appEl());
  for (var i = 0; i < ws.length; i++)
    if (sv(ws[i], "AXSubrole") === "AXStandardWindow") return ws[i];
  return ws.length ? ws[0] : null;
}

// ---- the SHIPPED heuristics, verbatim from src/write/vectors/ui-drag.ts -----
function findAll(el, wantRole, depth, acc) {
  acc = acc || [];
  if (depth < 0) return acc;
  var ch = kids(el);
  for (var i = 0; i < ch.length; i++) {
    if (sv(ch[i], "AXRole") === wantRole) acc.push(ch[i]);
    findAll(ch[i], wantRole, depth - 1, acc);
  }
  return acc;
}
function shippedTable() {
  var w = stdWindow();
  if (!w) return null;
  var tables = findAll(w, "AXTable", 12, []),
    best = null;
  for (var i = 0; i < tables.length; i++) {
    var f = frame(tables[i]);
    if (!f) continue;
    if (f.w < 400) {
      if (!best || f.w < best.f.w) best = { el: tables[i], f: f };
    }
  }
  return best ? best.el : null;
}
function shippedViewport() {
  var w = stdWindow();
  if (!w) return null;
  var sas = findAll(w, "AXScrollArea", 12, []);
  for (var i = 0; i < sas.length; i++) {
    var f = frame(sas[i]);
    if (f && f.w < 400) return f;
  }
  return null;
}
function allText(el, acc, depth) {
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
  for (var i = 0; i < ch.length; i++) allText(ch[i], acc, depth - 1);
  return acc;
}
function harvest(t) {
  var out = [],
    ch = kids(t);
  for (var r = 0; r < ch.length; r++) {
    var role = sv(ch[r], "AXRole");
    if (role === "AXRow" || role === "AXTableRow") {
      var rf = frame(ch[r]);
      out.push({
        text: allText(ch[r], [], 6).join("|"),
        y: rf ? rf.y : null,
        h: rf ? rf.h : null,
        w: rf ? rf.w : null,
      });
    }
  }
  return out;
}

// ---- the PRUNED locator: never descends into a list's rows -----------------
// The whole point: a sidebar lives in the window's CHROME, so a search for it
// has no business walking the content list's rows and their static text. This
// stops at every AXTable/AXOutline/AXList it finds (recording it as a
// candidate) and at every AXRow, so its cost is a function of the window's
// structure rather than of the user's data.
var CONTAINERS = { AXTable: 1, AXOutline: 1, AXList: 1 };
function prunedCandidates(el, depth, acc) {
  acc = acc || [];
  if (depth < 0) return acc;
  var ch = kids(el);
  for (var i = 0; i < ch.length; i++) {
    var role = sv(ch[i], "AXRole");
    if (CONTAINERS[role]) {
      acc.push(ch[i]);
      continue;
    } // candidate — do NOT enter
    if (role === "AXRow" || role === "AXCell") continue; // never enter row content
    prunedCandidates(ch[i], depth - 1, acc);
  }
  return acc;
}

function ms(fn) {
  var t0 = $.NSDate.date;
  var r = fn();
  return { ms: Math.round($.NSDate.date.timeIntervalSinceDate(t0) * 1000), value: r };
}

function fmt(f) {
  return f
    ? "[" +
        Math.round(f.x) +
        "," +
        Math.round(f.y) +
        " " +
        Math.round(f.w) +
        "x" +
        Math.round(f.h) +
        "]"
    : "(no frame)";
}

// ------------------------------------------------------------------ verbs
function vTree(maxDepth) {
  var w = stdWindow();
  if (!w) return "NO WINDOW";
  var lines = [];
  function walk(el, d, path) {
    var role = sv(el, "AXRole"),
      sub = sv(el, "AXSubrole"),
      desc = sv(el, "AXDescription"),
      title = sv(el, "AXTitle"),
      ident = sv(el, "AXIdentifier");
    var ch = kids(el);
    var pad = new Array(d + 1).join("  ");
    lines.push(
      pad +
        path +
        " " +
        role +
        (sub ? "/" + sub : "") +
        " " +
        fmt(frame(el)) +
        " children=" +
        ch.length +
        (title ? ' title="' + title + '"' : "") +
        (desc ? ' desc="' + desc + '"' : "") +
        (ident ? ' id="' + ident + '"' : ""),
    );
    if (CONTAINERS[role]) {
      // summarize instead of descending: the row count is the interesting part
      var rows = 0;
      for (var k = 0; k < ch.length; k++) {
        var r = sv(ch[k], "AXRole");
        if (r === "AXRow" || r === "AXTableRow") rows++;
      }
      lines.push(pad + "  └─ " + rows + " row(s) [not descended]");
      return;
    }
    if (d >= maxDepth) {
      if (ch.length) lines.push(pad + "  └─ [depth limit]");
      return;
    }
    for (var i = 0; i < ch.length; i++) walk(ch[i], d + 1, path + "." + (i + 1));
  }
  walk(w, 0, "win");
  return lines.join("\n");
}

function vLocate() {
  var w = stdWindow();
  if (!w) return JSON.stringify({ window: false });
  var wf = frame(w);
  var t = shippedTable(),
    vp = shippedViewport();
  var tf = t ? frame(t) : null;
  var rows = t ? harvest(t) : [];
  var cands = prunedCandidates(w, 8, []).map(function (c) {
    var f = frame(c),
      n = 0,
      ch = kids(c);
    for (var i = 0; i < ch.length; i++) {
      var r = sv(ch[i], "AXRole");
      if (r === "AXRow" || r === "AXTableRow") n++;
    }
    return { role: sv(c, "AXRole"), frame: f, rows: n };
  });
  return JSON.stringify({
    window: true,
    windowFrame: wf,
    shippedTable: tf,
    shippedViewport: vp,
    shippedRows: rows.length,
    resolves: !!(t && vp && rows.length > 0),
    candidates: cands,
  });
}

function vCost() {
  var w = stdWindow();
  if (!w) return JSON.stringify({ window: false });
  CALLS = 0;
  var a = ms(function () {
    return shippedTable();
  });
  var locateCalls = CALLS;
  var t = a.value;
  CALLS = 0;
  var b = ms(function () {
    return shippedViewport();
  });
  var vpCalls = CALLS;
  CALLS = 0;
  var c = ms(function () {
    return t ? harvest(t) : [];
  });
  var walkCalls = CALLS;
  CALLS = 0;
  var d = ms(function () {
    return prunedCandidates(w, 8, []);
  });
  var prunedCalls = CALLS;
  // the content list's size, for attribution
  var contentRows = 0,
    sidebarRows = c.value.length;
  var cands = d.value;
  for (var i = 0; i < cands.length; i++) {
    var f = frame(cands[i]);
    if (!f) continue;
    var ch = kids(cands[i]),
      n = 0;
    for (var k = 0; k < ch.length; k++) {
      var r = sv(ch[k], "AXRole");
      if (r === "AXRow" || r === "AXTableRow") n++;
    }
    if (f.w >= 400) contentRows += n;
  }
  return JSON.stringify({
    shippedLocatorMs: a.ms,
    shippedLocatorCalls: locateCalls,
    shippedViewportMs: b.ms,
    shippedViewportCalls: vpCalls,
    rowWalkMs: c.ms,
    rowWalkCalls: walkCalls,
    prunedLocatorMs: d.ms,
    prunedLocatorCalls: prunedCalls,
    prunedCandidates: cands.length,
    sidebarRows: sidebarRows,
    contentRows: contentRows,
    totalShippedMs: a.ms + b.ms + c.ms,
  });
}

// How DEEP does the row walk actually have to go? The shipped snapshot
// concatenates descendant static text to depth 6 per row, which is 40+ AX
// round-trips per row. If the segments the driver matches on are present at a
// shallower depth, the walk collapses.
function vWalkDepth(titlesCsv) {
  var t = shippedTable();
  if (!t) return JSON.stringify({ table: false });
  var titles = (titlesCsv || "").split("|").filter(function (s) {
    return s !== "";
  });
  var out = [];
  for (var d = 0; d <= 6; d++) {
    CALLS = 0;
    var r = ms(
      (function (dd) {
        return function () {
          var rows = [],
            ch = kids(t);
          for (var i = 0; i < ch.length; i++) {
            var role = sv(ch[i], "AXRole");
            if (role === "AXRow" || role === "AXTableRow")
              rows.push(allText(ch[i], [], dd).join("|"));
          }
          return rows;
        };
      })(d),
    );
    var rows = r.value;
    var matched = 0;
    for (var k = 0; k < titles.length; k++) {
      for (var j = 0; j < rows.length; j++) {
        var segs = rows[j].split("|");
        if (segs.indexOf(titles[k]) >= 0 || segs.indexOf(titles[k] + ".") >= 0) {
          matched++;
          break;
        }
      }
    }
    var blank = 0;
    for (var b = 0; b < rows.length; b++) if (rows[b] === "") blank++;
    out.push({
      depth: d,
      ms: r.ms,
      calls: CALLS,
      rows: rows.length,
      blankRows: blank,
      titlesMatched: matched,
      of: titles.length,
      sample: rows.slice(2, 5),
    });
  }
  return JSON.stringify(out);
}

// Can the four per-node attribute reads (AXValue, AXDescription, AXTitle,
// AXChildren) be fetched in ONE AX round-trip? AXUIElementCopyMultipleAttribute-
// Values exists precisely for this. If the harvested text comes back
// BYTE-IDENTICAL to the shipped depth-6 walk, the re-cut preserves AXDRAG1
// semantics by construction.
// MEASURED (SBRES1): the attribute-name array MUST be built with `$([…strings])`.
// `$.NSArray.arrayWithArray([$('AXValue'), …])` compiles and returns AXError 0,
// but every slot comes back kAXErrorNoValue (-25212) — a silent, total blank.
var BATCH_ATTRS = $(["AXValue", "AXDescription", "AXTitle", "AXChildren"]);
function batchRead(el) {
  CALLS++;
  var out = Ref();
  if ($.AXUIElementCopyMultipleAttributeValues(el, BATCH_ATTRS, 0, out) !== 0) return null;
  var arr = ObjC.castRefToObject(out[0]);
  if (!arr || Number(arr.count) < 4) return null;
  function str(i) {
    var v = arr.objectAtIndex(i);
    if (!v) return "";
    var js;
    try {
      js = v.js;
    } catch (e) {
      return "";
    }
    return typeof js === "string" ? js : "";
  }
  var ch = [],
    c = arr.objectAtIndex(3);
  try {
    var n = Number(c.count);
    for (var i = 0; i < n; i++) ch.push(c.objectAtIndex(i));
  } catch (e) {
    ch = [];
  }
  return { value: str(0), desc: str(1), title: str(2), children: ch };
}
function allTextBatch(el, acc, depth) {
  acc = acc || [];
  depth = depth == null ? 6 : depth;
  if (depth < 0) return acc;
  var n = batchRead(el);
  if (n === null) return acc;
  if (n.value) acc.push(n.value);
  if (n.desc) acc.push(n.desc);
  if (n.title) acc.push(n.title);
  for (var i = 0; i < n.children.length; i++) allTextBatch(n.children[i], acc, depth - 1);
  return acc;
}
// The full candidate snapshot: pruned structural locator + one batched
// round-trip per node (text AND frame in the same call).
var ROW_ATTRS = $(["AXValue", "AXDescription", "AXTitle", "AXChildren", "AXPosition", "AXSize"]);
function batchRow(el) {
  CALLS++;
  var out = Ref();
  if ($.AXUIElementCopyMultipleAttributeValues(el, ROW_ATTRS, 0, out) !== 0) return null;
  var arr = ObjC.castRefToObject(out[0]);
  if (!arr || Number(arr.count) < 6) return null;
  function str(i) {
    var v = arr.objectAtIndex(i);
    if (!v) return "";
    var js;
    try {
      js = v.js;
    } catch (e) {
      return "";
    }
    return typeof js === "string" ? js : "";
  }
  var ch = [],
    c = arr.objectAtIndex(3);
  try {
    var n = Number(c.count);
    for (var i = 0; i < n; i++) ch.push(c.objectAtIndex(i));
  } catch (e) {
    ch = [];
  }
  var f = null;
  try {
    var pd = ObjC.castRefToObject($.CFCopyDescription(arr.objectAtIndex(4))).js;
    var zd = ObjC.castRefToObject($.CFCopyDescription(arr.objectAtIndex(5))).js;
    var pm = pd.match(/x:([-0-9.]+) y:([-0-9.]+)/),
      zm = zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
    if (pm && zm) f = { x: +pm[1], y: +pm[2], w: +zm[1], h: +zm[2] };
  } catch (e) {
    f = null;
  }
  return { value: str(0), desc: str(1), title: str(2), children: ch, frame: f };
}
function vCandidate() {
  var w = stdWindow();
  if (!w) return JSON.stringify({ window: false });
  CALLS = 0;
  var r = ms(function () {
    var cands = prunedCandidates(w, 8, []);
    var picked = null;
    for (var i = 0; i < cands.length; i++) {
      var f = frame(cands[i]);
      if (f && (!picked || f.w < picked.f.w)) picked = { el: cands[i], f: f };
    }
    if (!picked) return null;
    var rows = [],
      ch = kids(picked.el);
    for (var k = 0; k < ch.length; k++) {
      var n = batchRow(ch[k]);
      if (!n || n.frame === null) continue;
      var acc = [];
      if (n.value) acc.push(n.value);
      if (n.desc) acc.push(n.desc);
      if (n.title) acc.push(n.title);
      for (var j = 0; j < n.children.length; j++) allTextBatch(n.children[j], acc, 5);
      rows.push({ text: acc.join("|"), f: n.frame });
    }
    return rows;
  });
  return JSON.stringify({
    ms: r.ms,
    calls: CALLS,
    rows: r.value ? r.value.length : 0,
    sample: r.value ? r.value.slice(0, 3) : [],
  });
}

// The maintainer's proposed alternative: ONE addressed System Events call
// building parallel lists. Measured for the record — note that it can only be
// addressed POSITIONALLY (`scroll area 2`), which is exactly the CGRD1-fenced
// shape the locator fix exists to remove.
function vBulkSE() {
  var se = Application("System Events");
  var p = se.processes.byName("Things3");
  var out = {};
  try {
    // MEASURED: System Events' `window 1` of Things is a 40x40 untitled
    // companion with ZERO scroll areas, so a positionally-addressed bulk read
    // aims at the wrong window. Pick the first with scroll areas.
    var w = null,
      sizes = [];
    out.windows = p.windows.length;
    for (var z = 0; z < p.windows.length; z++) {
      var n = 0;
      try {
        n = p.windows[z].scrollAreas.length;
      } catch (e) {
        n = 0;
      }
      sizes.push("win" + z + ":scrollAreas=" + n);
      if (n >= 2 && w === null) {
        w = p.windows[z];
        out.pickedWindow = z;
      }
    }
    out.scan = sizes.join(" ; ");
    if (w === null) {
      out.error = "no window with 2 scroll areas";
      return JSON.stringify(out);
    }
    var t0 = $.NSDate.date;
    // positional-ok: MEASUREMENT ONLY — this probe exists to price the
    // positional System Events route against the structural AX one; nothing
    // here ships.
    var tbl = w.scrollAreas[1].tables[0];
    var descs = tbl.rows.uiElements.uiElements.description();
    var vals = tbl.rows.uiElements.uiElements.value();
    var pos = tbl.rows.position();
    var siz = tbl.rows.size();
    out.ms = Math.round($.NSDate.date.timeIntervalSinceDate(t0) * 1000);
    out.rows = pos.length;
    out.descSample = JSON.stringify(descs.slice(0, 3));
    out.valSample = JSON.stringify(vals.slice(0, 3));
    out.appleEvents = 4;
  } catch (e) {
    out.error = String(e);
  }
  return JSON.stringify(out);
}

// The WINDOW census — raw AX and the System Events view side by side. Things
// keeps more than one window around, so "which window does the driver address?"
// is a real question with a measurable answer.
function vWindows() {
  var ws = kids(appEl());
  var lines = ["raw AX: " + ws.length + " window(s)"];
  for (var i = 0; i < ws.length; i++) {
    var f = frame(ws[i]);
    var ch = kids(ws[i]);
    var roles = {};
    for (var k = 0; k < ch.length; k++) {
      var r = sv(ch[k], "AXRole");
      roles[r] = (roles[r] || 0) + 1;
    }
    var rs = [];
    for (var r2 in roles) rs.push(r2 + "×" + roles[r2]);
    var cands = prunedCandidates(ws[i], 8, []);
    var cdesc = [];
    for (var c = 0; c < cands.length; c++) {
      var cf = frame(cands[c]);
      var n = 0,
        cc = kids(cands[c]);
      for (var q = 0; q < cc.length; q++) {
        var rr = sv(cc[q], "AXRole");
        if (rr === "AXRow" || rr === "AXTableRow") n++;
      }
      cdesc.push(sv(cands[c], "AXRole") + " " + fmt(cf) + " rows=" + n);
    }
    lines.push(
      "  [" +
        i +
        "] role=" +
        sv(ws[i], "AXRole") +
        "/" +
        sv(ws[i], "AXSubrole") +
        ' title="' +
        sv(ws[i], "AXTitle") +
        '" ' +
        fmt(f) +
        " main=" +
        sv(ws[i], "AXMain") +
        " focused=" +
        sv(ws[i], "AXFocused") +
        " minimized=" +
        sv(ws[i], "AXMinimized") +
        ' id="' +
        sv(ws[i], "AXIdentifier") +
        '"',
    );
    lines.push("       children: " + rs.join(" "));
    lines.push("       list candidates: " + (cdesc.length ? cdesc.join(" | ") : "(none)"));
  }
  try {
    var se = Application("System Events");
    var p = se.processes.byName("Things3");
    lines.push("System Events: " + p.windows.length + " window(s)");
    for (var j = 0; j < p.windows.length; j++) {
      var sa = 0;
      try {
        sa = p.windows[j].scrollAreas.length;
      } catch (e) {
        sa = -1;
      }
      lines.push(
        "  [" +
          j +
          '] name="' +
          p.windows[j].name() +
          '" scrollAreas=' +
          sa +
          " subrole=" +
          p.windows[j].subrole(),
      );
    }
  } catch (e) {
    lines.push("System Events census failed: " + e);
  }
  return lines.join("\n");
}

// Is a SHALLOWER batched harvest equivalent for every consumer? The driver
// consumes a row's text in exactly two ways: (a) `text === ''` (spacer-row
// detection) and (b) an exact segment match against a known AREA TITLE. Byte
// identity of the joined string is NOT the contract — this cell certifies the
// contract itself, per depth.
function vDepthEq(titlesCsv) {
  var t = shippedTable();
  if (!t) return JSON.stringify({ table: false });
  var titles = (titlesCsv || "").split("|").filter(function (s) {
    return s !== "";
  });
  var rowsEl = [],
    ch = kids(t);
  for (var i = 0; i < ch.length; i++) {
    var r = sv(ch[i], "AXRole");
    if (r === "AXRow" || r === "AXTableRow") rowsEl.push(ch[i]);
  }
  function matchSet(texts, title) {
    var idx = [];
    for (var j = 0; j < texts.length; j++) {
      var segs = texts[j].split("|");
      if (segs.indexOf(title) >= 0 || segs.indexOf(title + ".") >= 0) idx.push(j);
    }
    return idx.join(",");
  }
  CALLS = 0;
  var base = ms(function () {
    var o = [];
    for (var i = 0; i < rowsEl.length; i++) o.push(allText(rowsEl[i], [], 6).join("|"));
    return o;
  });
  var baseCalls = CALLS;
  var out = [{ label: "shipped depth-6 single-attr", ms: base.ms, calls: baseCalls }];
  for (var d = 2; d <= 6; d++) {
    CALLS = 0;
    var r = ms(
      (function (dd) {
        return function () {
          var o = [];
          for (var i = 0; i < rowsEl.length; i++) o.push(allTextBatch(rowsEl[i], [], dd).join("|"));
          return o;
        };
      })(d),
    );
    var texts = r.value;
    var blankOk = true;
    for (var b = 0; b < texts.length; b++) {
      if ((texts[b] === "") !== (base.value[b] === "")) {
        blankOk = false;
        break;
      }
    }
    var matchOk = true,
      firstBad = null;
    for (var k = 0; k < titles.length; k++) {
      var a = matchSet(base.value, titles[k]),
        c = matchSet(texts, titles[k]);
      if (a !== c) {
        matchOk = false;
        firstBad = { title: titles[k], depth6: a, shallow: c };
        break;
      }
    }
    out.push({
      label: "batched depth-" + d,
      ms: r.ms,
      calls: CALLS,
      spacerRowsAgree: blankOk,
      areaTitleMatchesAgree: matchOk,
      byteIdentical: texts.join("\n") === base.value.join("\n"),
      firstDisagreement: firstBad,
    });
  }
  return JSON.stringify(out);
}

// The SIDEBAR-STATE signature: everything a driver could key on to tell a
// visible sidebar from a hidden one, in whichever state the app is in now.
function vState() {
  var w = stdWindow();
  if (!w) return JSON.stringify({ window: false });
  var wf = frame(w);
  var sas = findAll(w, "AXScrollArea", 12, []);
  var lists = [];
  for (var i = 0; i < sas.length; i++) {
    var f = frame(sas[i]);
    var tb = null,
      ch = kids(sas[i]);
    for (var k = 0; k < ch.length; k++) {
      var r = sv(ch[k], "AXRole");
      if (CONTAINERS[r]) {
        tb = ch[k];
        break;
      }
    }
    var rows = 0;
    if (tb) {
      var tc = kids(tb);
      for (var q = 0; q < tc.length; q++) {
        var rr = sv(tc[q], "AXRole");
        if (rr === "AXRow" || rr === "AXTableRow") rows++;
      }
    }
    lists.push({
      frame: f,
      rows: rows,
      hidden: sv(sas[i], "AXHidden"),
      enabled: sv(sas[i], "AXEnabled"),
      focused: sv(sas[i], "AXFocused"),
      ident: sv(sas[i], "AXIdentifier"),
    });
  }
  // do any two list panes OVERLAP horizontally? (the hidden-sidebar signature)
  var overlaps = [];
  for (var a = 0; a < lists.length; a++) {
    for (var b = a + 1; b < lists.length; b++) {
      var fa = lists[a].frame,
        fb = lists[b].frame;
      if (!fa || !fb) continue;
      var ox = Math.min(fa.x + fa.w, fb.x + fb.w) - Math.max(fa.x, fb.x);
      if (ox > 0) overlaps.push({ a: a, b: b, overlapPx: Math.round(ox) });
    }
  }
  var handle = findImageByDesc(w, "MainWindowSidebarResizeHandle", 6);
  var menuTitle = null,
    menuKey = null;
  try {
    var items = Application("System Events")
      .processes.byName("Things3")
      .menuBars[0].menuBarItems.byName("View").menus[0].menuItems;
    for (var m = 0; m < items.length; m++) {
      var nm = items[m].name();
      if (nm === "Hide Sidebar" || nm === "Show Sidebar") {
        menuTitle = nm;
        try {
          menuKey = String(items[m].menuItemCmdChar ? items[m].menuItemCmdChar() : "");
        } catch (e) {
          menuKey = "";
        }
        try {
          menuKey =
            items[m].attributes.byName("AXMenuItemCmdChar").value() +
            " mods=" +
            items[m].attributes.byName("AXMenuItemCmdModifiers").value();
        } catch (e) {}
      }
    }
  } catch (e) {
    menuTitle = "census failed: " + e;
  }
  return JSON.stringify({
    window: true,
    windowFrame: wf,
    windowTitle: sv(w, "AXTitle"),
    lists: lists,
    horizontalOverlaps: overlaps,
    resizeHandle: handle ? frame(handle) : null,
    viewMenuItem: menuTitle,
    viewMenuShortcut: menuKey,
    shippedResolves: !!(shippedTable() && shippedViewport()),
  });
}

// Where does the NEW snapshot's remaining wall clock go? Same phases as the
// shipped implementation, timed individually, on a cold AX connection (this is
// the first verb the script runs, so nothing has warmed the tree).
function vPhases(titlesCsv) {
  var titles = (titlesCsv || "").split("|").filter(function (s) {
    return s !== "";
  });
  var out = {};
  CALLS = 0;
  var w = ms(function () {
    return stdWindow();
  });
  out.window = { ms: w.ms, calls: CALLS };
  CALLS = 0;
  var p = ms(function () {
    return prunedCandidates(w.value, 8, []);
  });
  out.listPanes = { ms: p.ms, calls: CALLS, panes: p.value.length };
  var panes = p.value;
  out.harvest = [];
  for (var i = 0; i < panes.length; i++) {
    CALLS = 0;
    var h = ms(
      (function (el) {
        return function () {
          var rows = [],
            ch = kids(el);
          for (var k = 0; k < ch.length; k++) {
            var n = batchRow(ch[k]);
            if (!n || n.frame === null) continue;
            var acc = [];
            if (n.value) acc.push(n.value);
            if (n.desc) acc.push(n.desc);
            if (n.title) acc.push(n.title);
            for (var j = 0; j < n.children.length; j++) allTextBatch(n.children[j], acc, 1);
            rows.push(acc.join("|"));
          }
          return rows;
        };
      })(panes[i]),
    );
    out.harvest.push({
      ms: h.ms,
      calls: CALLS,
      rows: h.value.length,
      hits: (function () {
        var n = 0;
        for (var t = 0; t < titles.length; t++) {
          for (var r = 0; r < h.value.length; r++) {
            var segs = h.value[r].split("|");
            if (segs.indexOf(titles[t]) >= 0 || segs.indexOf(titles[t] + ".") >= 0) {
              n++;
              break;
            }
          }
        }
        return n;
      })(),
    });
  }
  return JSON.stringify(out);
}

function vBatchDbg() {
  var t = shippedTable();
  if (!t) return "no table";
  var ch = kids(t),
    row = null;
  for (var i = 0; i < ch.length; i++) {
    var r = sv(ch[i], "AXRole");
    if (r === "AXRow" || r === "AXTableRow") {
      row = ch[i];
      break;
    }
  }
  if (!row) return "no row";
  var lines = [];
  var forms = {
    "NSArray.arrayWithArray($-strings)": BATCH_ATTRS,
    "$(js-array-of-strings)": $(["AXValue", "AXDescription", "AXTitle", "AXChildren"]),
    "single AXChildren": $(["AXChildren"]),
  };
  for (var name in forms) {
    var o = Ref();
    var e = $.AXUIElementCopyMultipleAttributeValues(row, forms[name], 0, o);
    var summary = "err=" + e;
    if (e === 0) {
      var a = ObjC.castRefToObject(o[0]);
      var descs = [];
      for (var q = 0; q < a.count; q++) {
        try {
          descs.push(
            ObjC.castRefToObject($.CFCopyDescription(a.objectAtIndex(q)))
              .js.slice(0, 60)
              .replace(/\n/g, " "),
          );
        } catch (x) {
          descs.push("?");
        }
      }
      summary += " count=" + a.count + " [" + descs.join(" ; ") + "]";
    }
    lines.push("  " + name + ": " + summary);
  }
  // how does the CHILDREN slot bridge back?
  var co = Ref();
  if ($.AXUIElementCopyMultipleAttributeValues(row, BATCH_ATTRS, 0, co) === 0) {
    var ca = ObjC.castRefToObject(co[0]);
    var c = ca.objectAtIndex(3);
    var probe = [];
    try {
      probe.push("count=" + c.count);
    } catch (e) {
      probe.push("count threw");
    }
    try {
      probe.push("countFn=" + c.count());
    } catch (e) {
      probe.push("count() threw");
    }
    try {
      probe.push("jsType=" + typeof c.js + " jsLen=" + (c.js ? c.js.length : "n/a"));
    } catch (e) {
      probe.push("js threw");
    }
    try {
      probe.push("cast.count=" + ObjC.castRefToObject(c).count);
    } catch (e) {
      probe.push("cast threw");
    }
    try {
      probe.push("unwrap.count=" + $(c).count);
    } catch (e) {
      probe.push("$() threw");
    }
    lines.push("  children slot: " + probe.join(" | "));
  }
  var out = Ref();
  var err = $.AXUIElementCopyMultipleAttributeValues(row, BATCH_ATTRS, 0, out);
  lines.push("AXError=" + err);
  if (err !== 0) return lines.join("\n");
  var arr = ObjC.castRefToObject(out[0]);
  lines.push(
    "array class=" +
      (arr ? ObjC.castRefToObject($.CFCopyDescription(arr)).js.slice(0, 120) : "null"),
  );
  lines.push("count=" + arr.count);
  for (var k = 0; k < arr.count; k++) {
    var v = arr.objectAtIndex(k);
    var d = "(null)";
    try {
      d = ObjC.castRefToObject($.CFCopyDescription(v)).js.slice(0, 160);
    } catch (e) {
      d = "desc-failed " + e;
    }
    var jsType = "n/a";
    try {
      jsType = typeof v.js;
    } catch (e) {
      jsType = "js-threw";
    }
    var cnt = "n/a";
    try {
      cnt = String(v.count);
    } catch (e) {
      cnt = "count-threw";
    }
    lines.push("  [" + k + "] js=" + jsType + " count=" + cnt + " desc=" + d.replace(/\n/g, " "));
  }
  // the direct comparison: what does the plain AXChildren read give?
  lines.push("plain kids(row).length=" + kids(row).length);
  return lines.join("\n");
}

function vBatch() {
  var t = shippedTable();
  if (!t) return JSON.stringify({ table: false });
  var rowsEl = [],
    ch = kids(t);
  for (var i = 0; i < ch.length; i++) {
    var role = sv(ch[i], "AXRole");
    if (role === "AXRow" || role === "AXTableRow") rowsEl.push(ch[i]);
  }
  CALLS = 0;
  var a = ms(function () {
    var o = [];
    for (var i = 0; i < rowsEl.length; i++) o.push(allText(rowsEl[i], [], 6).join("|"));
    return o;
  });
  var aCalls = CALLS;
  CALLS = 0;
  var b = ms(function () {
    var o = [];
    for (var i = 0; i < rowsEl.length; i++) o.push(allTextBatch(rowsEl[i], [], 6).join("|"));
    return o;
  });
  var bCalls = CALLS;
  var same = a.value.join("\n") === b.value.join("\n");
  var firstDiff = null;
  for (var k = 0; k < Math.max(a.value.length, b.value.length); k++) {
    if (a.value[k] !== b.value[k]) {
      firstDiff = { row: k, shipped: a.value[k], batched: b.value[k] };
      break;
    }
  }
  return JSON.stringify({
    rows: rowsEl.length,
    shippedMs: a.ms,
    shippedCalls: aCalls,
    batchedMs: b.ms,
    batchedCalls: bCalls,
    identical: same,
    firstDiff: firstDiff,
  });
}

function vEnhanced(on) {
  var se = Application("System Events");
  var p = se.processes.byName("Things3");
  try {
    p.attributes.byName("AXEnhancedUserInterface").value = on === "1";
  } catch (e) {
    return "SET FAILED: " + e;
  }
  sleepMs(800);
  var now;
  try {
    now = p.attributes.byName("AXEnhancedUserInterface").value();
  } catch (e) {
    now = "(unreadable)";
  }
  return "AXEnhancedUserInterface=" + now;
}

function findImageByDesc(el, needle, depth) {
  if (depth < 0) return null;
  var ch = kids(el);
  for (var i = 0; i < ch.length; i++) {
    if (sv(ch[i], "AXRole") === "AXImage" && sv(ch[i], "AXDescription").indexOf(needle) >= 0)
      return ch[i];
    var r = findImageByDesc(ch[i], needle, depth - 1);
    if (r) return r;
  }
  return null;
}

function vSplit(dx) {
  // MEASURED (SBRES1 §1): the Things main window has NO AXSplitGroup and NO
  // AXSplitter — the sidebar and the content list are SIBLING scroll areas
  // directly under the window, and the divider is an AXImage described
  // "MainWindowSidebarResizeHandle". Drag that. Things must be frontmost for
  // HID synthesis to land (NATIVE1-e), which `warm()` guarantees.
  var w = stdWindow();
  if (!w) return "NO WINDOW";
  var handle = findImageByDesc(w, "MainWindowSidebarResizeHandle", 6);
  if (!handle) return "NO RESIZE HANDLE";
  var f = frame(handle);
  if (!f) return "HANDLE HAS NO FRAME";
  var sx = f.x + f.w / 2,
    sy = f.y + f.h / 2,
    tx = sx + +dx;
  var MOVED = 5,
    DOWN = 1,
    UP = 2,
    DRAG = 6;
  function mev(t, x, y, cs) {
    var e = $.CGEventCreateMouseEvent($(), t, $.CGPointMake(x, y), 0);
    if (cs) $.CGEventSetIntegerValueField(e, 1, cs);
    return e;
  }
  function post(e) {
    $.CGEventPost($.kCGHIDEventTap, e);
  }
  post(mev(MOVED, sx, sy, 0));
  sleepMs(60);
  post(mev(DOWN, sx, sy, 1));
  sleepMs(140);
  for (var i = 1; i <= 20; i++) {
    post(mev(DRAG, sx + ((tx - sx) * i) / 20, sy, 1));
    sleepMs(20);
  }
  post(mev(DRAG, tx, sy, 1));
  sleepMs(250);
  post(mev(UP, tx, sy, 1));
  sleepMs(500);
  var after = frame(handle);
  var vp = shippedViewport();
  return "handle " + fmt(f) + " -> " + fmt(after) + "   shipped-viewport " + fmt(vp);
}

// Things' own View ▸ Hide/Show Sidebar command — the supported way a user makes
// the sidebar go away, and therefore the case the driver's error copy has to
// tell the truth about.
function vSidebar(want) {
  var se = Application("System Events");
  var p = se.processes.byName("Things3");
  var wanted = want === "hide" ? "Hide Sidebar" : "Show Sidebar";
  try {
    var items = p.menuBars[0].menuBarItems.byName("View").menus[0].menuItems;
    for (var i = 0; i < items.length; i++) {
      if (items[i].name() === wanted) {
        items[i].click();
        sleepMs(1200);
        return 'clicked "' + wanted + '"';
      }
    }
    var have = [];
    for (var k = 0; k < items.length; k++) have.push(items[k].name());
    return 'no "' + wanted + '" item (View has: ' + have.join(", ") + ")";
  } catch (e) {
    return "sidebar toggle failed: " + e;
  }
}

function vMenu(name) {
  var se = Application("System Events");
  var p = se.processes.byName("Things3");
  try {
    var items = p.menuBars[0].menuBarItems.byName(name).menus[0].menuItems;
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var t = items[i].name();
      if (t) out.push("  " + t);
    }
    return 'menu "' + name + '":\n' + out.join("\n");
  } catch (e) {
    return "menu census failed: " + e;
  }
}

function run(argv) {
  var verb = argv[0] || "locate";
  if (verb === "tree") return vTree(+(argv[1] || 6));
  if (verb === "locate") return vLocate();
  if (verb === "cost") return vCost();
  if (verb === "walkdepth") return vWalkDepth(argv[1] || "");
  if (verb === "batch") return vBatch();
  if (verb === "batchdbg") return vBatchDbg();
  if (verb === "candidate") return vCandidate();
  if (verb === "windows") return vWindows();
  if (verb === "deptheq") return vDepthEq(argv[1] || "");
  if (verb === "state") return vState();
  if (verb === "phases") return vPhases(argv[1] || "");
  if (verb === "bulkse") return vBulkSE();
  if (verb === "enhanced") return vEnhanced(argv[1] || "0");
  if (verb === "split") return vSplit(argv[1] || "0");
  if (verb === "sidebar") return vSidebar(argv[1] || "hide");
  if (verb === "menu") return vMenu(argv[1] || "View");
  return "unknown verb: " + verb;
}
