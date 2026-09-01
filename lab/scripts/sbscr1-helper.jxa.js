// SBSCR1 guest helper — one verb set for every sidebar-scroll hypothesis.
//
// usage: osascript -l JavaScript sbscr1-helper.js <verb> <titles-pipe-joined> [args...]
//
// The sidebar is located SEMANTICALLY (SBRES1): the list whose rows carry the
// caller's own area titles. Never by width.
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

function run(argv) {
  var verb = argv[0];
  var titles = (argv[1] || "").split("|").filter(function (s) {
    return s.length > 0;
  });

  if (verb === "state") return JSON.stringify(probeState(titles));

  if (verb === "geom") {
    var sb = resolveSidebar(titles);
    if (sb.ok !== true) return JSON.stringify({ ok: false, why: sb.why });
    return JSON.stringify({
      ok: true,
      viewport: sb.viewport,
      content: contentPane(titles),
      mouse: mouseLoc(),
    });
  }

  if (verb === "park") {
    moveTo(+argv[2], +argv[3]);
    sleepMs(250);
    return JSON.stringify({ parked: mouseLoc() });
  }

  // wheel <n> <moveFirst 0|1> — the shipped primitive with the pointer move
  // made OPTIONAL, so the routing law can be measured both ways.
  if (verb === "wheel") {
    var n = +argv[2],
      moveFirst = argv[3] === "1";
    var before = probeState(titles);
    var at = mouseLoc();
    if (moveFirst) {
      var sb2 = resolveSidebar(titles);
      if (sb2.ok === true) {
        moveTo(sb2.viewport.x + sb2.viewport.w / 2, sb2.viewport.y + sb2.viewport.h / 2);
        sleepMs(50);
      }
      at = mouseLoc();
    }
    wheel(n);
    sleepMs(400);
    var after = probeState(titles);
    return JSON.stringify({
      n: n,
      moveFirst: moveFirst,
      pointerAtDispatch: at,
      beforeTopY: before.topRowY,
      afterTopY: after.topRowY,
      moved:
        before.ok && after.ok && before.topRowY !== null && after.topRowY !== null
          ? after.topRowY - before.topRowY
          : null,
      beforeScroll: before.scroll,
      afterScroll: after.scroll,
    });
  }

  // sbinfo — the H2 census: what the scroll area / bar / rows actually expose.
  if (verb === "sbinfo") {
    var sb3 = resolveSidebar(titles);
    if (sb3.ok !== true) return JSON.stringify({ ok: false, why: sb3.why });
    var bar = scrollBarOf(sb3.scroll);
    var saAttrs = attrNames(sb3.scroll),
      saSet = {};
    for (var i = 0; i < saAttrs.length; i++) saSet[saAttrs[i]] = settable(sb3.scroll, saAttrs[i]);
    var barAttrs = bar ? attrNames(bar) : [],
      barSet = {};
    for (i = 0; i < barAttrs.length; i++) barSet[barAttrs[i]] = settable(bar, barAttrs[i]);
    var tblAttrs = attrNames(sb3.table),
      tblSet = {};
    for (i = 0; i < tblAttrs.length; i++) tblSet[tblAttrs[i]] = settable(sb3.table, tblAttrs[i]);
    var row0 = sb3.rows.length ? sb3.rows[0].el : null;
    var rowAttrs = row0 ? attrNames(row0) : [],
      rowSet = {};
    for (i = 0; i < rowAttrs.length; i++) rowSet[rowAttrs[i]] = settable(row0, rowAttrs[i]);
    return JSON.stringify({
      ok: true,
      viewport: sb3.viewport,
      scrollArea: { role: sv(sb3.scroll, "AXRole"), actions: acts(sb3.scroll), attrs: saSet },
      scrollBar: bar
        ? {
            role: sv(bar, "AXRole"),
            sub: sv(bar, "AXSubrole"),
            orient: sv(bar, "AXOrientation"),
            value: barValue(bar),
            actions: acts(bar),
            attrs: barSet,
          }
        : null,
      table: { role: sv(sb3.table, "AXRole"), actions: acts(sb3.table), attrs: tblSet },
      row0: row0 ? { actions: acts(row0), attrs: rowSet } : null,
    });
  }

  // setbar <fraction> — THE POINTERLESS CANDIDATE. Set the vertical scroll
  // bar's AXValue and measure what the list did.
  if (verb === "setbar") {
    var want = +argv[2];
    var sb4 = resolveSidebar(titles);
    if (sb4.ok !== true) return JSON.stringify({ ok: false, why: sb4.why });
    var bar4 = scrollBarOf(sb4.scroll);
    if (bar4 === null) return JSON.stringify({ ok: false, why: "no-scrollbar" });
    var before4 = probeState(titles);
    // CFNumberCreate through the bridge is fussy; NSNumber bridges cleanly.
    var err = $.AXUIElementSetAttributeValue(bar4, $("AXValue"), $.NSNumber.numberWithDouble(want));
    sleepMs(500);
    var after4 = probeState(titles);
    return JSON.stringify({
      ok: err === 0,
      axError: err,
      want: want,
      beforeTopY: before4.topRowY,
      afterTopY: after4.topRowY,
      moved:
        before4.topRowY !== null && after4.topRowY !== null
          ? after4.topRowY - before4.topRowY
          : null,
      beforeScroll: before4.scroll,
      afterScroll: after4.scroll,
      pointer: mouseLoc(),
    });
  }

  // rowaction <title> <action> — AXScrollToVisible & friends on a row.
  if (verb === "rowaction") {
    var want5 = argv[2],
      action = argv[3] || "AXScrollToVisible";
    var hit = rowByTitle(titles, want5);
    if (hit === null) return JSON.stringify({ ok: false, why: "row-not-found" });
    var before5 = probeState(titles);
    var err5 = $.AXUIElementPerformAction(hit.row.el, $(action));
    sleepMs(500);
    var after5 = probeState(titles);
    var hit2 = rowByTitle(titles, want5);
    return JSON.stringify({
      ok: err5 === 0,
      axError: err5,
      action: action,
      actions: acts(hit.row.el),
      rowYBefore: hit.row.f ? hit.row.f.y : null,
      rowYAfter: hit2 && hit2.row.f ? hit2.row.f.y : null,
      beforeTopY: before5.topRowY,
      afterTopY: after5.topRowY,
      moved:
        before5.topRowY !== null && after5.topRowY !== null
          ? after5.topRowY - before5.topRowY
          : null,
      beforeScroll: before5.scroll,
      afterScroll: after5.scroll,
      pointer: mouseLoc(),
    });
  }

  // seek <title> [maxIter] — THE FIX PROTOTYPE. Drive the named row into the
  // viewport band using ONLY the scrollbar's AXValue: no pointer, no wheel.
  // Self-calibrating exactly like the shipped loop (measured travel per unit of
  // fraction replaces the geometric seed), and it emits the per-iteration
  // telemetry record #672 asks for.
  if (verb === "seek") {
    var want7 = argv[2],
      maxIter = +(argv[3] || 12),
      pad = 6;
    var iters = [],
      reason = "iteration-limit";
    var sb7 = resolveSidebar(titles);
    if (sb7.ok !== true)
      return JSON.stringify({ reason: "snapshot-failed", why: sb7.why, iterations: [] });
    var bar7 = scrollBarOf(sb7.scroll);
    if (bar7 === null) return JSON.stringify({ reason: "no-scrollbar", iterations: [] });
    // Geometric SEED for px-per-fraction: the content span beyond the viewport.
    var span = sb7.rows.length ? 0 : 0,
      lo = null,
      hi = null;
    for (var q = 0; q < sb7.rows.length; q++) {
      var rf = sb7.rows[q].f;
      if (!rf) continue;
      if (lo === null || rf.y < lo) lo = rf.y;
      if (hi === null || rf.y + rf.h > hi) hi = rf.y + rf.h;
    }
    var pxPerFraction = Math.max(1, hi - lo - sb7.viewport.h);
    var lastErr = null,
      lastDelta = 0,
      stalls = 0;
    for (var it = 0; it < maxIter; it++) {
      var hit7 = rowByTitle(titles, want7);
      if (hit7 === null) {
        reason = "snapshot-failed";
        break;
      }
      var vp7 = hit7.sb.viewport,
        f7 = hit7.row.f;
      var bar8 = scrollBarOf(hit7.sb.scroll);
      var cur = barValue(bar8);
      var center = f7.y + f7.h / 2;
      var inBand = center >= vp7.y + pad && center <= vp7.y + vp7.h - pad;
      var err = inBand ? 0 : vp7.y + vp7.h / 2 - center;
      var rec = {
        iter: it,
        rowFrame: f7,
        viewport: vp7,
        err: err,
        scrollBefore: cur,
        pxPerFraction: Math.round(pxPerFraction),
      };
      if (inBand) {
        iters.push(rec);
        reason = "reached";
        break;
      }
      if (lastErr !== null && lastDelta !== 0) {
        var moved = lastErr - err;
        rec.measuredMovement = moved;
        if (Math.abs(moved) < 2) {
          stalls++;
          if (stalls >= 2) {
            iters.push(rec);
            reason = "pinned-at-boundary";
            break;
          }
        } else {
          stalls = 0;
          pxPerFraction = Math.min(1e6, Math.max(1, Math.abs(moved / lastDelta)));
        }
      }
      lastErr = err;
      var delta = -err / pxPerFraction;
      var target = Math.max(0, Math.min(1, cur + delta));
      lastDelta = target - cur;
      rec.requestedDelta = delta;
      rec.targetValue = target;
      var e7 = $.AXUIElementSetAttributeValue(
        bar8,
        $("AXValue"),
        $.NSNumber.numberWithDouble(target),
      );
      rec.axError = e7;
      if (e7 !== 0) {
        iters.push(rec);
        reason = "scroll-dispatch-failed";
        break;
      }
      sleepMs(300);
      var after7 = rowByTitle(titles, want7);
      rec.rowFrameAfter = after7 ? after7.row.f : null;
      rec.scrollAfter = after7 ? barValue(scrollBarOf(after7.sb.scroll)) : null;
      iters.push(rec);
    }
    return JSON.stringify({ reason: reason, pointer: mouseLoc(), iterations: iters });
  }

  // rowy <title> — where a named row's frame sits right now.
  if (verb === "rowy") {
    var hit6 = rowByTitle(titles, argv[2]);
    if (hit6 === null) return JSON.stringify({ ok: false, why: "row-not-found" });
    return JSON.stringify({
      ok: true,
      frame: hit6.row.f,
      viewport: hit6.sb.viewport,
      scroll: barValue(scrollBarOf(hit6.sb.scroll)),
    });
  }

  return JSON.stringify({ ok: false, why: "unknown verb " + verb });
}
