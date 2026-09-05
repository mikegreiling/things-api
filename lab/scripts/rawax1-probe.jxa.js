// RAWAX1 — the raw-AX equivalence and cost probe for the Repeat drive (#695).
//
// THE QUESTION. Every hop of the Repeat drive today speaks to the Accessibility
// tree through System Events: `osascript` sends an Apple event, System Events
// makes the AX call, the answer comes back the same way. RDLAT2 fitted that
// round-trip at ~47 ms on the maintainer's M1 (against ~8 ms on a clone), and
// the shipped `make-repeating` makes 88 of them — ~4.1 s of a ~6.9 s drive.
// The SAME AX calls made in-process through the ObjC bridge cost 0.12 ms apiece
// (VOPAT1 §field law, measured on that same M1). The transport is the cost, and
// this probe asks — primitive by primitive — whether the raw call can actually
// replace the System Events one, and what each costs.
//
// IT IS AN EQUIVALENCE PROBE, NOT A BENCHMARK. For every primitive the drive
// uses it runs BOTH forms against the SAME live control in the SAME dialog state
// and reports whether they agree. A primitive whose raw form does not agree is a
// FINDING (the port keeps System Events, or keystrokes, for that one) — never
// something to step over. The two that are expected to fail are named in the
// campaign doc up front, so a pass there is as interesting as a miss:
//
//   - SET VALUE ON A NUMERIC FIELD. System Events' `set value of <field>` writes
//     the displayed text WITHOUT firing the app's edit binding (UIC6), which is
//     why every numeric drive types. System Events' `set value` IS
//     `AXUIElementSetAttributeValue`, so the raw form is expected to behave
//     identically — but "expected" is not "measured", and if it DOES fire the
//     binding the whole typing loop (focus, keystroke, Tab, read-back, retry,
//     BEEP1's ⌘A history) collapses into one call. Cell `setvalue` decides it by
//     COMMITTING and reading the landed rule out of the database.
//   - MENU-BAR ENABLEMENT. `enabled of menu item "Repeat…"` may be answered only
//     because System Events provokes an AppKit menu update on the way past. Cell
//     `menubar` asks the raw tree the same question with the menu closed.
//
// THE SHAPE LAW (harness.md §AX-drive scrutiny). Cell `shape` dumps the FULL
// control inventory — role, subrole, title, description, value, identifier,
// actions, frame — of the dialog shell and its cadence group, and the driver
// runs it after EVERY input so the campaign doc can carry the shape trace for
// every state the recipe reaches.
//
// NOTHING HERE COMMITS unless the cell says so in its name (`setvalue` does, and
// says what it landed). Every other cell dismisses with the dialog's own Cancel.
//
// usage: osascript -l JavaScript rawax1-probe.jxa.js <cell> [arg…]
//   shape                 full shape dump of the open dialog (JSON)
//   prims  [reps]         the primitive equivalence + per-call timing matrix
//   menu                  pop-up menu: open, enumerate, cascade, press
//   setvalue <n>          AXValue on the interval field — does the binding fire?
//   dates                 localized menu-item titles parsed in JXA
//   menubar               AXEnabled of Items ▸ Repeat… with the menu closed
//   rowselect <title>     AXSelect / AXSelectedRows on a content-table row
//   drive  <freq>         the whole dialog entry, raw AX only, counted
//   open                  open the Repeat dialog (raw AX) and report the shell
//   cancel                press the open dialog's own Cancel
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");

// --------------------------------------------------------------- counters
//
// The two quantities that TRANSFER between hosts (RDLAT2 §E / harness.md §Cost
// law): raw AX calls made, and ELEMENTS whose CONTENT was touched. A clone's
// wall time transfers to nothing, so every cell reports both beside it.
var AXN = 0;
var AXR = 0;
var SEN = 0;

function now() {
  return $.NSDate.date.timeIntervalSince1970 * 1000;
}
function ms(t0) {
  return Math.round((now() - t0) * 1000) / 1000;
}

// ------------------------------------------------------- the raw AX layer

function attr(el, name) {
  AXN++;
  var out = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $(name), out) !== 0) return null;
  return ObjC.castRefToObject(out[0]);
}
/** A string attribute, or "" — the shape every discriminator here compares. */
function sv(el, name) {
  var v = attr(el, name);
  if (!v) return "";
  try {
    var j = v.js;
    return typeof j === "string" ? j : String(j);
  } catch (e) {
    return "";
  }
}
function bv(el, name) {
  var v = attr(el, name);
  if (v === null) return null;
  try {
    return v.js === true || String(v.js) === "true" || String(v.js) === "1";
  } catch (e) {
    return null;
  }
}
function kids(el) {
  var c = attr(el, "AXChildren");
  if (!c) return [];
  var a = [];
  try {
    var n = Number(c.count);
    for (var i = 0; i < n; i++) a.push(c.objectAtIndex(i));
  } catch (e) {
    return [];
  }
  return a;
}
/** Geometry — measured FREE on both hosts (VOPAT1: ~2 ms for 174 rows). */
function rectOf(p, z) {
  if (!p || !z) return null;
  var pd = ObjC.castRefToObject($.CFCopyDescription(p)).js;
  var zd = ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm = String(pd).match(/x:([-0-9.]+) y:([-0-9.]+)/);
  var zm = String(zd).match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return pm && zm ? { x: +pm[1], y: +pm[2], w: +zm[1], h: +zm[2] } : null;
}
function frame(el) {
  return rectOf(attr(el, "AXPosition"), attr(el, "AXSize"));
}
/**
 * ONE round-trip for a whole node (the ui-drag.ts `node()` shape). This is the
 * batched form the port would use everywhere a plural AppleScript read is used
 * today, so the probe times it beside the per-attribute form.
 */
var NODE_ATTRS = $([
  "AXRole",
  "AXSubrole",
  "AXTitle",
  "AXDescription",
  "AXValue",
  "AXIdentifier",
  "AXEnabled",
  "AXFocused",
  "AXPosition",
  "AXSize",
]);
function node(el) {
  AXN++;
  AXR++;
  var out = Ref();
  if ($.AXUIElementCopyMultipleAttributeValues(el, NODE_ATTRS, 0, out) !== 0) return null;
  var a = ObjC.castRefToObject(out[0]);
  if (!a || Number(a.count) < 10) return null;
  function s(i) {
    var v = a.objectAtIndex(i);
    if (!v) return "";
    var j;
    try {
      j = v.js;
    } catch (e) {
      return "";
    }
    return j === null || j === undefined ? "" : typeof j === "string" ? j : String(j);
  }
  var f = null;
  try {
    f = rectOf(a.objectAtIndex(8), a.objectAtIndex(9));
  } catch (e) {
    f = null;
  }
  return {
    role: s(0),
    subrole: s(1),
    title: s(2),
    desc: s(3),
    value: s(4),
    id: s(5),
    enabled: s(6),
    focused: s(7),
    frame: f,
  };
}
function actionsOf(el) {
  AXN++;
  var out = Ref();
  if ($.AXUIElementCopyActionNames(el, out) !== 0) return [];
  var a = ObjC.castRefToObject(out[0]);
  var res = [];
  try {
    var n = Number(a.count);
    for (var i = 0; i < n; i++) res.push(String(a.objectAtIndex(i).js));
  } catch (e) {
    return [];
  }
  return res;
}
function press(el, action) {
  AXN++;
  return $.AXUIElementPerformAction(el, $(action || "AXPress"));
}
function setAttr(el, name, value) {
  AXN++;
  return $.AXUIElementSetAttributeValue(el, $(name), value);
}
function settable(el, name) {
  AXN++;
  var out = Ref();
  if ($.AXUIElementIsAttributeSettable(el, $(name), out) !== 0) return null;
  return out[0] === true || String(out[0]) === "true" || out[0] === 1;
}
/**
 * SETTING A BOOLEAN ATTRIBUTE FROM JXA — which encoding does the AX API take?
 *
 * The port needs exactly one of these to work (`AXFocused := true` is what the
 * typing loop asks for, VOPAT1-13 measured it landing in 27.6 ms) and the ObjC
 * bridge offers three plausible spellings with no documentation saying which
 * marshals to a `CFBooleanRef`. So the probe TRIES them and reports the first
 * that returns AXError 0 — a finding the port hard-codes rather than guesses.
 */
function boolEncodings(want) {
  var out = [];
  try {
    out.push({ how: "$.kCFBooleanTrue", v: want ? $.kCFBooleanTrue : $.kCFBooleanFalse });
  } catch (e) {
    out.push({ how: "$.kCFBooleanTrue", err: String(e) });
  }
  try {
    out.push({ how: "NSNumber.numberWithBool", v: $.NSNumber.numberWithBool(want) });
  } catch (e) {
    out.push({ how: "NSNumber.numberWithBool", err: String(e) });
  }
  try {
    out.push({ how: "bare js boolean", v: want });
  } catch (e) {
    out.push({ how: "bare js boolean", err: String(e) });
  }
  return out;
}
function trySetBool(el, name, want) {
  var tried = [];
  var encodings = boolEncodings(want);
  for (var i = 0; i < encodings.length; i++) {
    var enc = encodings[i];
    if (enc.err !== undefined) {
      tried.push(enc.how + "=THREW:" + enc.err);
      continue;
    }
    var err;
    try {
      err = setAttr(el, name, enc.v);
    } catch (e) {
      tried.push(enc.how + "=THREW:" + e);
      continue;
    }
    tried.push(enc.how + "=err" + err);
    if (err === 0) {
      sleep(60);
      return { ok: true, how: enc.how, tried: tried, readBack: String(bv(el, name)) };
    }
  }
  return { ok: false, tried: tried, readBack: String(bv(el, name)) };
}
function sleep(msec) {
  $.NSThread.sleepForTimeInterval(msec / 1000);
}

// --------------------------------------------------- the System Events arm
//
// The COMPARISON leg. Every `se()` call is one Apple event to System Events —
// the unit RDLAT2 counted and the unit this campaign is removing — so it is
// counted separately and never mixed into AXN.
var SEapp = Application("System Events");
function se(fn) {
  SEN++;
  try {
    return fn();
  } catch (e) {
    return "THREW " + e;
  }
}
function seProcess() {
  return SEapp.processes.byName("Things3");
}
function seSheet() {
  return seProcess().windows.whose({ subrole: "AXStandardWindow" })[0].sheets[0];
}

function pidOfThings() {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(
    "com.culturedcode.ThingsMac",
  );
  if (!apps || Number(apps.count) === 0) return 0;
  return Number(apps.objectAtIndex(0).processIdentifier);
}

var PID = pidOfThings();
var APP = PID > 0 ? $.AXUIElementCreateApplication(PID) : null;

// ---------------------------------------------------------- shell locator
//
// The two shapes the Repeat editor presents (UIC4-a): an attached AXSheet when
// Things is frontmost, and a detached top-level AXUnknown window that is not the
// 40x40 utility window when it is not. Same priority order as the shipped
// pathCandidates, so the probe and the driver can never disagree about which
// dialog they are looking at.
function windowsOf(el) {
  var c = attr(el, "AXWindows");
  if (!c) return kids(el);
  var a = [];
  try {
    var n = Number(c.count);
    for (var i = 0; i < n; i++) a.push(c.objectAtIndex(i));
  } catch (e) {
    return kids(el);
  }
  return a;
}
function mainWindow() {
  var ws = windowsOf(APP);
  for (var i = 0; i < ws.length; i++)
    if (sv(ws[i], "AXSubrole") === "AXStandardWindow") return ws[i];
  return null;
}
function findShell() {
  var ws = windowsOf(APP);
  var i;
  for (i = 0; i < ws.length; i++) {
    if (sv(ws[i], "AXSubrole") !== "AXStandardWindow") continue;
    var ch = kids(ws[i]);
    for (var k = 0; k < ch.length; k++) {
      if (sv(ch[k], "AXRole") === "AXSheet") return { el: ch[k], form: "attached" };
    }
  }
  for (i = 0; i < ws.length; i++) {
    if (sv(ws[i], "AXSubrole") !== "AXUnknown") continue;
    var f = frame(ws[i]);
    if (!f || !(f.w === 40 && f.h === 40)) return { el: ws[i], form: "detached" };
  }
  return null;
}
function childrenByRole(el, role) {
  return kids(el).filter(function (c) {
    return sv(c, "AXRole") === role;
  });
}
function cadenceGroup(shellEl) {
  var g = childrenByRole(shellEl, "AXGroup");
  return g.length ? g[0] : null;
}

// ------------------------------------------------------------ menu access
//
// The menu bar is an AX child of the APPLICATION element, not of a window.
function menuBar() {
  return attr(APP, "AXMenuBar");
}
function menuNamed(bar, title) {
  var items = kids(bar);
  for (var i = 0; i < items.length; i++) if (sv(items[i], "AXTitle") === title) return items[i];
  return null;
}
/** The AXMenu hanging off an AXMenuBarItem / AXMenuItem, or null. */
function submenuOf(item) {
  var ch = kids(item);
  for (var i = 0; i < ch.length; i++) if (sv(ch[i], "AXRole") === "AXMenu") return ch[i];
  return null;
}
function menuItemNamed(menu, title) {
  var items = kids(menu);
  for (var i = 0; i < items.length; i++) if (sv(items[i], "AXTitle") === title) return items[i];
  return null;
}

// ----------------------------------------------------------------- output
function out(obj) {
  return JSON.stringify(obj, null, 2);
}
function counted(obj) {
  obj.axCalls = AXN;
  obj.axNodes = AXR;
  obj.seEvents = SEN;
  return obj;
}

// =========================================================== cell: shape
//
// THE FULL CONTROL INVENTORY of the open dialog — the shape trace the AX-drive
// scrutiny law requires after every input step. Roles, subroles, titles,
// descriptions, values, AXIdentifiers, ACTIONS and frames, for the shell's
// direct children and for every child of the cadence group.
function dumpElement(el) {
  var n = node(el);
  if (n === null) return { unreadable: true };
  return {
    role: n.role,
    subrole: n.subrole || undefined,
    title: n.title || undefined,
    desc: n.desc || undefined,
    value: n.value === "" ? undefined : n.value,
    id: n.id || undefined,
    enabled: n.enabled === "" ? undefined : n.enabled,
    focused: n.focused === "true" ? true : undefined,
    y: n.frame ? Math.round(n.frame.y) : undefined,
    x: n.frame ? Math.round(n.frame.x) : undefined,
    actions: actionsOf(el).join(","),
  };
}
function cellShape() {
  var sh = findShell();
  if (sh === null) return counted({ ok: false, why: "no dialog shell is open" });
  var g = cadenceGroup(sh.el);
  return counted({
    ok: true,
    form: sh.form,
    shell: dumpElement(sh.el),
    shellRoles: kids(sh.el).map(function (c) {
      return sv(c, "AXRole");
    }),
    shellChildren: kids(sh.el).map(dumpElement),
    group: g === null ? null : dumpElement(g),
    groupChildren: g === null ? [] : kids(g).map(dumpElement),
  });
}

// ============================================================ cell: open
//
// Open the Repeat dialog through the RAW menu path — the port's own first hop —
// so every later cell measures the dialog this code opened.
function openDialog(timeoutMs) {
  var bar = menuBar();
  if (bar === null) return { ok: false, why: "no AXMenuBar on the application element" };
  var items = menuNamed(bar, "Items");
  if (items === null) return { ok: false, why: "no Items menu" };
  var menu = submenuOf(items);
  if (menu === null) return { ok: false, why: "the Items menu bar item exposes no AXMenu child" };
  var repeat = menuItemNamed(menu, "Repeat…");
  if (repeat === null) {
    return {
      ok: false,
      why: "no Repeat… item",
      offered: kids(menu)
        .map(function (m) {
          return sv(m, "AXTitle");
        })
        .join(" | "),
    };
  }
  var enabled = bv(repeat, "AXEnabled");
  var t0 = now();
  var err = press(repeat);
  if (err !== 0) return { ok: false, why: "AXPress on Repeat… returned " + err, enabled: enabled };
  var deadline = now() + (timeoutMs || 8000);
  var sh = null;
  while (now() < deadline && sh === null) {
    sh = findShell();
    if (sh === null) sleep(25);
  }
  if (sh === null) return { ok: false, why: "the dialog never appeared", enabled: enabled };
  return { ok: true, enabled: enabled, form: sh.form, openMs: ms(t0) };
}
function cellOpen() {
  var r = openDialog(8000);
  if (r.ok) {
    var sh = findShell();
    r.shellRoles = kids(sh.el).map(function (c) {
      return sv(c, "AXRole");
    });
  }
  return counted(r);
}

// ========================================================== cell: cancel
function cancelDialog() {
  var sh = findShell();
  if (sh === null) return { ok: true, why: "no dialog open" };
  var buttons = childrenByRole(sh.el, "AXButton");
  for (var i = 0; i < buttons.length; i++) {
    if (sv(buttons[i], "AXTitle") === "Cancel") {
      var err = press(buttons[i]);
      sleep(250);
      return { ok: err === 0 && findShell() === null, err: err };
    }
  }
  return { ok: false, why: "the open dialog has no Cancel button" };
}

// =========================================================== cell: prims
//
// THE EQUIVALENCE + TIMING MATRIX. Every primitive the drive uses, both ways,
// against the same live control. `reps` sets the timing sample; the AGREEMENT
// column is what decides whether the port may use the raw form at all.
function slope(reps, fn) {
  // Warm once (the first call into a fresh AXUIElement pays a connection), then
  // time the body. Reported as ms PER CALL, which is the unit the cost model
  // multiplies (RDLAT2 §8).
  fn();
  var t0 = now();
  for (var i = 0; i < reps; i++) fn();
  return Math.round(((now() - t0) / reps) * 1000) / 1000;
}
function cellPrims(reps) {
  reps = reps || 50;
  var sh = findShell();
  if (sh === null) return counted({ ok: false, why: "open the Repeat dialog first (cell `open`)" });
  var shellEl = sh.el;
  var g = cadenceGroup(shellEl);
  var freq = childrenByRole(shellEl, "AXPopUpButton")[0] || null;
  var boxes = childrenByRole(shellEl, "AXCheckBox");
  var deadlines = null;
  for (var b = 0; b < boxes.length; b++) {
    if (sv(boxes[b], "AXTitle") === "Add deadlines") deadlines = boxes[b];
  }
  var fields = g === null ? [] : childrenByRole(g, "AXTextField");
  var statics = g === null ? [] : childrenByRole(g, "AXStaticText");
  var rows = [];

  function row(id, what, rawFn, seFn, note) {
    var raw, seRes, rawMs, seMs;
    try {
      raw = rawFn();
    } catch (e) {
      raw = "THREW " + e;
    }
    try {
      seRes = seFn === null ? "(n/a)" : seFn();
    } catch (e) {
      seRes = "THREW " + e;
    }
    rawMs = slope(reps, rawFn);
    seMs = seFn === null ? null : slope(Math.min(reps, 20), seFn);
    rows.push({
      id: id,
      what: what,
      raw: String(raw),
      se: String(seRes),
      agree: seFn === null ? "n/a" : String(raw) === String(seRes) ? "YES" : "NO",
      rawMs: rawMs,
      seMs: seMs,
      speedup: seMs === null ? null : Math.round((seMs / Math.max(rawMs, 0.0001)) * 10) / 10,
      note: note || undefined,
    });
  }

  // P3 — one attribute read of one control.
  row(
    "P3",
    "value of the frequency pop-up",
    function () {
      return sv(freq, "AXValue");
    },
    function () {
      return se(function () {
        return seSheet().popUpButtons[0].value();
      });
    },
  );
  // P15 — enabled, the eligibility gate's own read.
  row(
    "P15",
    "enabled of the frequency pop-up",
    function () {
      return bv(freq, "AXEnabled");
    },
    function () {
      return se(function () {
        return seSheet().popUpButtons[0].enabled();
      });
    },
  );
  // P18 — the shell's direct-child role census (the dialog-open assertion).
  row(
    "P18",
    "the shell's direct-child role list",
    function () {
      return kids(shellEl)
        .map(function (c) {
          return sv(c, "AXRole");
        })
        .join(",");
    },
    function () {
      return se(function () {
        return seSheet().uiElements.role().join(",");
      });
    },
    "one plural AppleScript event against one AXChildren + one AXRole per child",
  );
  // P4 — the cadence group's whole inventory (cgSnap's four plural events).
  row(
    "P4",
    "cadence group: static-text values + y, field values + y",
    function () {
      var parts = [];
      var i;
      for (i = 0; i < statics.length; i++) {
        var n = node(statics[i]);
        parts.push("s:" + (n ? n.value : "?") + "@" + (n && n.frame ? Math.round(n.frame.y) : "?"));
      }
      for (i = 0; i < fields.length; i++) {
        var m = node(fields[i]);
        parts.push("f:" + (m ? m.value : "?") + "@" + (m && m.frame ? Math.round(m.frame.y) : "?"));
      }
      return parts.join("|");
    },
    function () {
      return se(function () {
        var grp = seSheet().groups[0];
        var sVals = grp.staticTexts.value();
        var sPos = grp.staticTexts.position();
        var fVals = grp.textFields.value();
        var fPos = grp.textFields.position();
        var parts = [];
        var i;
        for (i = 0; i < sVals.length; i++)
          parts.push("s:" + sVals[i] + "@" + Math.round(sPos[i][1]));
        for (i = 0; i < fVals.length; i++)
          parts.push("f:" + fVals[i] + "@" + Math.round(fPos[i][1]));
        return parts.join("|");
      });
    },
    "the HXPC1/CGRD1 label-row discrimination's whole input",
  );
  // P8 — focus, read (VOPAT1-13 measured the WRITE at AXError 0 / 27.6 ms).
  row(
    "P8",
    "focused of the first numeric field",
    function () {
      return fields.length ? bv(fields[0], "AXFocused") : "(no field)";
    },
    function () {
      return se(function () {
        return seSheet().groups[0].textFields[0].focused();
      });
    },
  );
  // P6 — geometry, the term both campaigns measured FREE.
  row(
    "P6",
    "position + size of the frequency pop-up",
    function () {
      var f = frame(freq);
      return f ? Math.round(f.x) + "," + Math.round(f.y) : "(none)";
    },
    function () {
      return se(function () {
        var p = seSheet().popUpButtons[0].position();
        return Math.round(p[0]) + "," + Math.round(p[1]);
      });
    },
  );
  // P17 — AXIdentifier, the picker's identity check.
  row(
    "P17",
    "AXIdentifier of the dialog shell",
    function () {
      return sv(shellEl, "AXIdentifier") || "(none)";
    },
    function () {
      return se(function () {
        return seSheet().attributes.byName("AXIdentifier").value();
      });
    },
  );
  // P5 — a child count by class (the census's five reads, and converge's).
  row(
    "P5",
    "count of the cadence group's pop-up buttons",
    function () {
      return g === null ? -1 : childrenByRole(g, "AXPopUpButton").length;
    },
    function () {
      return se(function () {
        return seSheet().groups[0].popUpButtons.length;
      });
    },
  );
  // P1 — existence, the candidate prelude's and the canary's whole vocabulary.
  row(
    "P1",
    "does the attached-sheet shell exist",
    function () {
      var w = mainWindow();
      return w !== null && childrenByRole(w, "AXSheet").length > 0;
    },
    function () {
      return se(function () {
        return seProcess().windows.whose({ subrole: "AXStandardWindow" })[0].sheets.length > 0;
      });
    },
  );

  // ------- settability, which is the port's licence to write an attribute
  var setRows = [];
  function settableRow(label, el, name) {
    if (el === null) {
      setRows.push({ what: label, settable: "(absent)" });
      return;
    }
    setRows.push({
      what: label,
      settable: String(settable(el, name)),
      actions: actionsOf(el).join(","),
    });
  }
  settableRow("numeric field AXValue", fields.length ? fields[0] : null, "AXValue");
  settableRow("numeric field AXFocused", fields.length ? fields[0] : null, "AXFocused");
  settableRow("frequency pop-up AXValue", freq, "AXValue");
  settableRow("Add deadlines AXValue", deadlines, "AXValue");

  // P7 — ASKING FOR FOCUS, which the typing loop cannot do without. Reported as
  // its own row because the answer the port needs is not "did it work" but
  // WHICH BOOLEAN ENCODING the bridge marshals (see trySetBool).
  var focusSet =
    fields.length === 0
      ? { ok: false, tried: ["(no field in this state)"] }
      : trySetBool(fields[0], "AXFocused", true);

  // THE RAW FLOOR — one attribute read of one control, nothing else, at the
  // sample size the cost model multiplies. This is the number that stands
  // against RDLAT2's fitted 47 ms per Apple event.
  var floorMs = slope(Math.max(reps, 200), function () {
    return sv(shellEl, "AXRole");
  });

  return counted({
    ok: true,
    form: sh.form,
    reps: reps,
    rows: rows,
    settable: setRows,
    focusSet: focusSet,
    rawFloorMsPerCall: floorMs,
    fieldCount: fields.length,
    staticCount: statics.length,
  });
}

// ============================================================ cell: menu
//
// THE POP-UP. VOPAT1-11 measured `AXMenuOpened` 5.1 ms after an AXPress on the
// pop-up, so the open itself is known to work; what this cell establishes is
// WHERE the menu lands in the raw tree (System Events spells it `menu 1 of pu`),
// whether an AXMenuItem press selects, and whether the `More…` cascade the
// occurrence menu uses is reachable without a click.
function cellMenu() {
  var sh = findShell();
  if (sh === null) return counted({ ok: false, why: "open the Repeat dialog first" });
  var freq = childrenByRole(sh.el, "AXPopUpButton")[0];
  if (!freq) return counted({ ok: false, why: "no frequency pop-up" });

  var before = kids(freq).map(function (c) {
    return sv(c, "AXRole");
  });
  var acts = actionsOf(freq);
  var t0 = now();
  var err = press(freq);
  var menu = null;
  var deadline = now() + 2000;
  while (now() < deadline && menu === null) {
    var ch = kids(freq);
    for (var i = 0; i < ch.length; i++) if (sv(ch[i], "AXRole") === "AXMenu") menu = ch[i];
    if (menu === null) sleep(5);
  }
  var openMs = ms(t0);
  var items = menu === null ? [] : kids(menu);
  var titles = items.map(function (m) {
    return sv(m, "AXTitle");
  });
  // The cascade: does the LAST item expose an AXMenu child without being clicked?
  var cascade = null;
  if (items.length > 0) {
    var last = items[items.length - 1];
    cascade = {
      title: sv(last, "AXTitle"),
      hasSubmenuChild: submenuOf(last) !== null,
      actions: actionsOf(last).join(","),
    };
  }
  // Close it again without selecting. Escape would go through the pointer-class
  // frontmost law, so the cell presses the pop-up a second time instead.
  var closeErr = press(freq);
  sleep(150);
  var stillOpen = false;
  var ch2 = kids(freq);
  for (var k = 0; k < ch2.length; k++) if (sv(ch2[k], "AXRole") === "AXMenu") stillOpen = true;

  return counted({
    ok: menu !== null,
    popupActions: acts.join(","),
    childRolesBeforeOpen: before.join(","),
    pressErr: err,
    menuOpenMs: openMs,
    menuItemCount: items.length,
    itemTitles: titles,
    itemActions: items.length ? actionsOf(items[0]).join(",") : "",
    cascade: cascade,
    closeErr: closeErr,
    stillOpenAfterSecondPress: stillOpen,
  });
}

// ======================================================== cell: setvalue
//
// THE DECISIVE ONE. `AXUIElementSetAttributeValue(field, AXValue, "<n>")` — does
// the app's binding fire, or does it only repaint the text the way System Events'
// `set value` does (UIC6)? A read-back cannot answer it: the field SHOWS the new
// number either way. So the cell writes, reads back, and leaves the driver to
// commit and read the landed rule out of the database — the only oracle that can
// tell a repainted field from an edited one.
function cellSetValue(want) {
  var sh = findShell();
  if (sh === null) return counted({ ok: false, why: "open the Repeat dialog first" });
  var g = cadenceGroup(sh.el);
  if (g === null) return counted({ ok: false, why: "no cadence group" });
  var fields = childrenByRole(g, "AXTextField");
  if (fields.length === 0)
    return counted({ ok: false, why: "the cadence group offers no text field" });
  // ONE field only: this cell is deliberately run in a state whose group has
  // exactly one, so there is no addressing question mixed into the answer.
  var tf = fields[0];
  var was = sv(tf, "AXValue");
  var canSet = settable(tf, "AXValue");
  var err = setAttr(tf, "AXValue", $(String(want)));
  sleep(300);
  var shown = sv(tf, "AXValue");
  // The occurrence preview recomputes on a REAL edit and not on a repaint, so it
  // is the in-dialog tell — reported beside the database verdict, never instead.
  var preview = childrenByRole(g, "AXStaticText")
    .map(function (s) {
      return sv(s, "AXValue");
    })
    .join(" | ");
  return counted({
    ok: err === 0,
    settable: String(canSet),
    setErr: err,
    was: was,
    requested: String(want),
    shown: shown,
    heldTheText: shown === String(want),
    groupStatics: preview,
    note: "the driver commits and reads the landed rule — a held text is not a fired binding",
  });
}

// =========================================================== cell: dates
//
// The occurrence menu's item titles are LOCALIZED ("Sun, Jul 12, 2026") and, for
// near dates, RELATIVE ("Today"). AppleScript resolves them with `date "<s>"`,
// which is the system parser; JXA has no such operator, so the port needs a
// spelling that agrees with it on every title the menu can produce. This cell
// runs both against the live menu's own titles.
function parseJXA(s) {
  // Candidate A: NSDataDetector, the same CoreServices date parser the system
  // uses for data detection — locale-aware, and needs no format string.
  try {
    // NSTextCheckingTypeDate is `1 << 4`; the bridged constant is not reliably
    // exposed, so the literal is the fallback and the comment is the reference.
    var kDate = 16;
    try {
      if (typeof $.NSTextCheckingTypeDate === "number") kDate = $.NSTextCheckingTypeDate;
    } catch (e) {
      kDate = 16;
    }
    var det = $.NSDataDetector.dataDetectorWithTypesError(kDate, $());
    if (det && !det.isNil()) {
      var str = $(s);
      var m = det.firstMatchInStringOptionsRange(str, 0, $.NSMakeRange(0, str.length));
      if (m && !m.isNil() && m.date && !m.date.isNil()) {
        var cal = $.NSCalendar.currentCalendar;
        return (
          cal.componentFromDate($.NSCalendarUnitYear, m.date) +
          "-" +
          ("0" + cal.componentFromDate($.NSCalendarUnitMonth, m.date)).slice(-2) +
          "-" +
          ("0" + cal.componentFromDate($.NSCalendarUnitDay, m.date)).slice(-2)
        );
      }
    }
  } catch (e) {
    return "THREW " + e;
  }
  return null;
}
function parseSE(s) {
  // AppleScript's own `date "<s>"`, reached from JXA the only way there is: a
  // scripting component. This is the arm the port must MATCH.
  SEN++;
  try {
    var src =
      'on run\n try\n set d to date "' +
      String(s).replace(/"/g, '\\"') +
      '"\n return ((year of d) as text) & "-" & (text -2 thru -1 of ("0" & ((month of d) as integer))) & "-" & (text -2 thru -1 of ("0" & (day of d)))\n on error\n return "NOPARSE"\n end try\nend run';
    var scr = $.NSAppleScript.alloc.initWithSource($(src));
    var errRef = Ref();
    var res = scr.executeAndReturnError(errRef);
    if (!res || res.isNil()) return "ERR";
    return String(res.stringValue.js);
  } catch (e) {
    return "THREW " + e;
  }
}
function cellDates() {
  var sh = findShell();
  var titles = [];
  if (sh !== null) {
    var g = cadenceGroup(sh.el);
    var pus = g === null ? [] : childrenByRole(g, "AXPopUpButton");
    // The `Next:` occurrence pop-up is the one whose items are dates; open each
    // in turn and take the first menu that offers any.
    for (var i = 0; i < pus.length && titles.length === 0; i++) {
      press(pus[i]);
      var deadline = now() + 1500;
      var menu = null;
      while (now() < deadline && menu === null) {
        var ch = kids(pus[i]);
        for (var k = 0; k < ch.length; k++) if (sv(ch[k], "AXRole") === "AXMenu") menu = ch[k];
        if (menu === null) sleep(5);
      }
      if (menu !== null) {
        var got = kids(menu).map(function (m) {
          return sv(m, "AXTitle");
        });
        if (got.length > 1 && /\d{4}/.test(got.join(" "))) titles = got;
      }
      press(pus[i]);
      sleep(120);
    }
  }
  // Plus the synthetic corpus, so the cell reports even with no dialog open.
  var corpus = titles.concat([
    "Today",
    "Tomorrow",
    "Sun, Jul 12, 2026",
    "Mon, Aug 3, 2026",
    "Jan 1, 2027",
    "Wednesday",
  ]);
  var seen = {};
  var rows = [];
  for (var t = 0; t < corpus.length; t++) {
    var s = corpus[t];
    if (s === "" || seen[s]) continue;
    seen[s] = true;
    var a = parseJXA(s);
    var b = parseSE(s);
    rows.push({
      title: s,
      jxa: a === null ? "(no match)" : a,
      applescript: b,
      agree: String(a) === String(b),
    });
  }
  return counted({ ok: true, fromLiveMenu: titles, rows: rows });
}

// ========================================================= cell: menubar
//
// Can the raw tree answer `enabled of menu item "Repeat…"` with the menu CLOSED?
// System Events may be provoking an AppKit menu update on the way past, in which
// case the raw read is stale (or absent) and the eligibility assert has to keep
// its Apple event. Asked three ways: cold, while open, and cold again.
function readRepeatItem() {
  var bar = menuBar();
  if (bar === null) return { ok: false, why: "no AXMenuBar" };
  var items = menuNamed(bar, "Items");
  if (items === null) return { ok: false, why: "no Items menu bar item" };
  var menu = submenuOf(items);
  if (menu === null)
    return { ok: false, why: "no AXMenu under Items", childCount: kids(items).length };
  var all = kids(menu);
  var rep = menuItemNamed(menu, "Repeat…");
  return {
    ok: true,
    itemCount: all.length,
    titles: all.map(function (m) {
      return sv(m, "AXTitle");
    }),
    repeatPresent: rep !== null,
    repeatEnabled: rep === null ? null : bv(rep, "AXEnabled"),
  };
}
function cellMenuBar() {
  var cold = readRepeatItem();
  var seCold = se(function () {
    var mi = seProcess()
      .menuBars[0].menuBarItems.byName("Items")
      .menus[0].menuItems.byName("Repeat…");
    return mi.exists() ? "enabled=" + mi.enabled() : "absent";
  });
  // Open the menu (AXPress on the bar item), re-read, close it again.
  var bar = menuBar();
  var items = bar === null ? null : menuNamed(bar, "Items");
  var opened = null;
  var closeAction = null;
  if (items !== null) {
    press(items);
    sleep(250);
    opened = readRepeatItem();
    closeAction = actionsOf(items).join(",");
    if (actionsOf(items).indexOf("AXCancel") >= 0) press(items, "AXCancel");
    else press(items);
    sleep(250);
  }
  var coldAgain = readRepeatItem();
  return counted({
    ok: true,
    cold: cold,
    systemEvents: String(seCold),
    whileOpen: opened,
    barItemActions: closeAction,
    coldAgain: coldAgain,
  });
}

// ======================================================= cell: rowselect
//
// The PROJECT arm of make-repeating selects its target as a content-table ROW
// (UIC4-a), and today does it with System Events' `select (row i)` — which UIC5
// measured as the ONLY working spelling (setting the table's AXSelectedRows was
// a silent no-op through System Events). The raw API is a different door on the
// same attribute, so this asks both: the row's own actions, and AXSelected.
function contentTable() {
  var w = mainWindow();
  if (w === null) return null;
  var sas = childrenByRole(w, "AXScrollArea");
  for (var i = 0; i < sas.length; i++) {
    var t = childrenByRole(sas[i], "AXTable");
    if (t.length) return t[0];
  }
  return null;
}
function cellRowSelect(wantTitle) {
  var t = contentTable();
  if (t === null) return counted({ ok: false, why: "no content table" });
  var rowsAttr = attr(t, "AXRows");
  var rows = [];
  try {
    var n = Number(rowsAttr.count);
    for (var i = 0; i < n; i++) rows.push(rowsAttr.objectAtIndex(i));
  } catch (e) {
    rows = kids(t);
  }
  if (rows.length === 0) return counted({ ok: false, why: "the content table has no rows" });
  var probe = rows[Math.min(1, rows.length - 1)];
  var acts = actionsOf(probe);
  var canSelect = settable(probe, "AXSelected");
  var tableSettable = settable(t, "AXSelectedRows");
  var setErr = setAttr(probe, "AXSelected", $.YES);
  sleep(250);
  var selected = bv(probe, "AXSelected");
  var seNames = se(function () {
    return Application("Things3")
      .selectedToDos()
      .map(function (x) {
        return x.name();
      })
      .join(" | ");
  });
  return counted({
    ok: true,
    wanted: wantTitle || "(none)",
    rowCount: rows.length,
    rowActions: acts.join(","),
    rowAXSelectedSettable: String(canSelect),
    tableAXSelectedRowsSettable: String(tableSettable),
    setSelectedErr: setErr,
    rowReportsSelected: selected,
    thingsSelection: String(seNames),
  });
}

// =========================================================== cell: drive
//
// The whole dialog entry, raw AX only, counted — the number the campaign's cost
// table is built on. It selects a frequency, censuses the rebuilt group, reads
// every control the audit would read, and CANCELS. It commits nothing.
function cellDrive(freqLabel) {
  freqLabel = freqLabel || "weekly";
  var t0 = now();
  var timeline = [];
  function stamp(what) {
    timeline.push({ what: what, atMs: ms(t0), axCalls: AXN });
  }

  var sh = findShell();
  if (sh === null) return counted({ ok: false, why: "open the Repeat dialog first" });
  stamp("shell resolved");

  // 1. the shell census (the dialog-open assertion)
  var roles = kids(sh.el).map(function (c) {
    return sv(c, "AXRole");
  });
  stamp("shell census");

  // 2. the frequency selection
  var freq = childrenByRole(sh.el, "AXPopUpButton")[0];
  var wasFreq = sv(freq, "AXValue");
  press(freq);
  var menu = null;
  var dl = now() + 2000;
  while (now() < dl && menu === null) {
    var ch = kids(freq);
    for (var i = 0; i < ch.length; i++) if (sv(ch[i], "AXRole") === "AXMenu") menu = ch[i];
    if (menu === null) sleep(5);
  }
  stamp("menu open");
  var item = menu === null ? null : menuItemNamed(menu, freqLabel);
  if (item === null) {
    if (menu !== null) press(freq);
    return counted({
      ok: false,
      why: "no menu item " + freqLabel,
      offered:
        menu === null
          ? []
          : kids(menu).map(function (m) {
              return sv(m, "AXTitle");
            }),
    });
  }
  press(item);
  stamp("item pressed");

  // 3. the rebuild settle, polled on the group's own shape (the cgSettle rule)
  var g = null;
  var sig = "";
  var prev = "<none>";
  var rounds = 0;
  var settled = false;
  var dl2 = now() + 4000;
  while (now() < dl2 && !settled) {
    rounds++;
    g = cadenceGroup(sh.el);
    if (g !== null) {
      var parts = [];
      var st = childrenByRole(g, "AXStaticText");
      var tf = childrenByRole(g, "AXTextField");
      for (var s = 0; s < st.length; s++) {
        var n = node(st[s]);
        parts.push("s:" + (n ? n.value : "?"));
      }
      for (var f = 0; f < tf.length; f++) {
        var m = node(tf[f]);
        parts.push("f@" + (m && m.frame ? Math.round(m.frame.y) : "?"));
      }
      sig = parts.join("|");
      var hasEvery = parts.indexOf("s:Every") >= 0;
      if (hasEvery && sig === prev) settled = true;
      prev = sig;
    }
    if (!settled) sleep(50);
  }
  stamp("group settled (" + rounds + " rounds)");

  // 4. the pre-commit audit's whole read — every control, once
  var audit = [];
  var gg = cadenceGroup(sh.el);
  if (gg !== null) {
    kids(gg).forEach(function (c) {
      var n = node(c);
      if (n === null) return;
      audit.push(
        n.role + (n.value ? "=" + n.value : "") + "@" + (n.frame ? Math.round(n.frame.y) : "?"),
      );
    });
  }
  kids(sh.el).forEach(function (c) {
    var n = node(c);
    if (n === null) return;
    if (n.role === "AXGroup") return;
    audit.push(n.role + (n.title ? '"' + n.title + '"' : "") + (n.value ? "=" + n.value : ""));
  });
  stamp("audit read");

  var cancelled = cancelDialog();
  stamp("cancelled");

  return counted({
    ok: true,
    frequency: freqLabel,
    wasFrequency: wasFreq,
    shellRoles: roles,
    settleRounds: rounds,
    settledSignature: sig,
    auditInventory: audit,
    cancelled: cancelled.ok,
    totalMs: ms(t0),
    timeline: timeline,
  });
}

// ============================================================== dispatch
function run(argv) {
  var cell = argv.length ? String(argv[0]) : "shape";
  if (APP === null) return out({ ok: false, why: "Things3 is not running" });
  var res;
  switch (cell) {
    case "shape":
      res = cellShape();
      break;
    case "open":
      res = cellOpen();
      break;
    case "cancel":
      res = counted(cancelDialog());
      break;
    case "prims":
      res = cellPrims(argv.length > 1 ? Number(argv[1]) : 50);
      break;
    case "menu":
      res = cellMenu();
      break;
    case "setvalue":
      res = cellSetValue(argv.length > 1 ? argv[1] : "3");
      break;
    case "dates":
      res = cellDates();
      break;
    case "menubar":
      res = cellMenuBar();
      break;
    case "rowselect":
      res = cellRowSelect(argv.length > 1 ? argv[1] : "");
      break;
    case "drive":
      res = cellDrive(argv.length > 1 ? String(argv[1]) : "weekly");
      break;
    default:
      res = { ok: false, why: "unknown cell " + cell };
  }
  return out(res);
}
