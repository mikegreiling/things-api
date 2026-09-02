// RDLAT2 §E — does the REPEAT SHEET realize per element, the way the sidebar does?
//
// The maintainer's sidebar probe (M1, 2026-09-02) found the cost of an AX sweep
// is not the IPC (0.12 ms per read through this same bridge) and not the call
// count (1,841 calls and 2,081 calls both took ~20 s) but the app REALIZING each
// custom row's content on the first content-bearing touch — ~115 ms per row on a
// Retina display, and paid again on a repeat sweep because the app discards it.
//
// The Repeat dialog is a different kind of surface: ordinary AppKit controls in a
// sheet, not a custom cell view per row. Whether it realizes the same way is the
// question this probe answers on the clone. It CANNOT answer it for the field —
// the whole point of the finding is that the VM is where realization is cheap —
// so it reports the ratio between geometry and content here, and the maintainer's
// own trace supplies the multiplier.
//
// usage: osascript -l JavaScript rdlat2-elem.jxa.js
ObjC.import("Foundation");
ObjC.import("ApplicationServices");

var CALLS = 0;
function attr(el, name) {
  CALLS++;
  var out = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $(name), out) !== 0) return null;
  return ObjC.castRefToObject(out[0]);
}
function sv(el, name) {
  var v = attr(el, name);
  if (!v) return "";
  try {
    return String(v.js);
  } catch (e) {
    return "";
  }
}
function kids(el) {
  var c = attr(el, "AXChildren");
  if (!c) return [];
  var a = [];
  for (var i = 0; i < c.count; i++) a.push(c.objectAtIndex(i));
  return a;
}
function pidOf(n) {
  return Application("System Events").processes.byName(n).unixId();
}
function now() {
  return $.NSDate.date.timeIntervalSince1970 * 1000;
}
function ms(t0) {
  return Math.round((now() - t0) * 10) / 10;
}

var app = $.AXUIElementCreateApplication(pidOf("Things3"));

// The dialog shell: the standard window's sheet, or the detached editor.
function shell() {
  var ws = kids(app);
  for (var i = 0; i < ws.length; i++) {
    if (sv(ws[i], "AXSubrole") === "AXStandardWindow") {
      var sheets = kids(ws[i]).filter(function (c) {
        return sv(c, "AXRole") === "AXSheet";
      });
      if (sheets.length) return sheets[0];
    }
  }
  for (var j = 0; j < ws.length; j++) {
    if (sv(ws[j], "AXSubrole") === "AXUnknown") return ws[j];
  }
  return null;
}

var sh = shell();
if (sh === null) {
  console.log("FATAL: no Repeat dialog shell found");
} else {
  // Collect every element in the sheet, to a generous depth — this is the
  // ENUMERATION cost, reported separately from reading anything out of them.
  var t = now();
  CALLS = 0;
  var all = [];
  (function walk(el, d) {
    all.push(el);
    if (d < 0) return;
    var ks = kids(el);
    for (var i = 0; i < ks.length; i++) walk(ks[i], d - 1);
  })(sh, 6);
  var enumMs = ms(t);
  var enumCalls = CALLS;
  console.log("ENUM      elements=" + all.length + " calls=" + enumCalls + " ms=" + enumMs);

  function sweep(label, names) {
    var t0 = now();
    CALLS = 0;
    for (var i = 0; i < all.length; i++) {
      for (var n = 0; n < names.length; n++) attr(all[i], names[n]);
    }
    var d = ms(t0);
    console.log(
      label +
        " elements=" +
        all.length +
        " calls=" +
        CALLS +
        " ms=" +
        d +
        " per-element=" +
        Math.round((d / all.length) * 100) / 100,
    );
    return d;
  }

  // GEOMETRY: answered out of the layout the app already holds. Free on the M1.
  var g1 = sweep("GEOM-1   ", ["AXPosition", "AXSize"]);
  var g2 = sweep("GEOM-2   ", ["AXPosition", "AXSize"]);
  // CONTENT: the touches the sidebar paid ~115 ms/element for.
  var c1 = sweep("CONTENT-1", ["AXValue", "AXTitle", "AXDescription"]);
  // REPEAT: the sidebar paid AGAIN here, because the app discards what it
  // realized. If the sheet caches, this is much cheaper than CONTENT-1.
  var c2 = sweep("CONTENT-2", ["AXValue", "AXTitle", "AXDescription"]);
  var c3 = sweep("CONTENT-3", ["AXValue", "AXTitle", "AXDescription"]);

  console.log(
    "RATIO     content/geometry=" +
      Math.round((c1 / Math.max(g1, 0.01)) * 100) / 100 +
      "  repeat/first=" +
      Math.round((c2 / Math.max(c1, 0.01)) * 100) / 100 +
      "  (geom-2/geom-1=" +
      Math.round((g2 / Math.max(g1, 0.01)) * 100) / 100 +
      ", content-3/first=" +
      Math.round((c3 / Math.max(c1, 0.01)) * 100) / 100 +
      ")",
  );

  // The inventory the drive actually touches, so the count in the campaign doc
  // is the dialog's own and not a guess.
  var byRole = {};
  for (var k = 0; k < all.length; k++) {
    var r = sv(all[k], "AXRole");
    byRole[r] = (byRole[r] || 0) + 1;
  }
  var parts = [];
  for (var key in byRole) parts.push(key + "=" + byRole[key]);
  console.log("INVENTORY " + parts.sort().join(" "));

  var grp = kids(sh).filter(function (c) {
    return sv(c, "AXRole") === "AXGroup";
  })[0];
  if (grp) {
    var gk = kids(grp);
    var gRole = {};
    for (var m = 0; m < gk.length; m++) {
      var rr = sv(gk[m], "AXRole");
      gRole[rr] = (gRole[rr] || 0) + 1;
    }
    var gp = [];
    for (var kk in gRole) gp.push(kk + "=" + gRole[kk]);
    console.log("GROUP     children=" + gk.length + " " + gp.sort().join(" "));
  }
}
