// field-probe-sidebar.jxa.js — a self-contained field instrument for issue #676.
//
// WHY THIS EXISTS
//   One full Accessibility sweep of a 174-row Things sidebar takes 16-18 SECONDS
//   on the reporter's M1 host, versus ~0.8s for the same shape in our lab VM.
//   This script measures WHERE that time goes on the real hardware, so we can
//   tell an app-main-thread bottleneck (nothing we build will help) from an
//   osascript/JXA bridge bottleneck (a native helper-side AX driver is the fix).
//
// HOW TO RUN
//   1. Copy this ONE file anywhere on the Mac (Desktop is fine). No checkout, no
//      npm install, no things-api install, no third-party libraries needed.
//   2. Open Things 3 and leave its main window frontmost and fully visible.
//   3. In Terminal (or iTerm / Ghostty):
//
//        osascript -l JavaScript field-probe-sidebar.jxa.js
//
//      Optional arguments (any order):
//        <number>        latency-loop iteration count for cell 5 (default 200)
//        --allow-click   ALSO run cell 7, the only cell that touches the UI
//
//      Examples:
//        osascript -l JavaScript field-probe-sidebar.jxa.js 400
//        osascript -l JavaScript field-probe-sidebar.jxa.js --allow-click
//
//   4. Paste the whole JSON output into the GitHub issue.
//
//   The app running the script (Terminal / iTerm / Ghostty) must hold
//   Accessibility permission: System Settings > Privacy & Security > Accessibility.
//   Cell 0 fails fast with that instruction if it does not.
//
// READ-ONLY / SAFETY
//   Every cell except cell 7 is a pure read: no clicks, no drags, no keystrokes,
//   no scrolling, no AX writes, no menu actuation, and no database access of any
//   kind. Cell 7 is OPT-IN (default OFF, requires --allow-click); it performs
//   exactly two option-clicks on one disclosure chevron, where the second click
//   undoes the first, and reports a row-count restore proof so you can confirm
//   the sidebar came back to its original shape.
//
// PRIVACY -- THE OUTPUT IS SAFE TO PASTE IN PUBLIC
//   The JSON contains ONLY counts, durations in milliseconds, geometry numbers
//   (x/y/width/height), AX role and attribute-name strings, and booleans. It
//   deliberately emits NO to-do titles, project names, area names, notes, tags,
//   or any other text from the database. Row text IS read internally (that read
//   is the cost being measured) but is counted and discarded, never reported.
//   The sidebar is located by structure -- row count and pane width -- precisely
//   so that no user-visible title ever has to be matched or printed.
//
// WHAT EACH CELL MEASURES
//   0 ENVIRONMENT      Things version+build, macOS version+build, arch, AX trust.
//   1 SIDEBAR LOCATION Which list pane was chosen and why: the pane inventory,
//                      the chosen pane's frame, its scroll area's frame, its row
//                      count, and the scroll bar's value. Plus the cost of that
//                      discovery walk.
//   2 FULL SWEEP       Wall time, AX round-trip count, rows and nodes visited,
//                      and ms-per-AX-call for a whole-sidebar text harvest at
//                      depth 2 and depth 6. Each depth runs TWICE: run 1 may
//                      include lazy-AX-tree warm-up, run 2 is the steady state.
//   3 PER-NODE COST    The cost of resolving ONE area row plus its disclosure
//                      chevron -- locating the row, finding the chevron image
//                      inside it, reading a single attribute -- and how many
//                      rows expose a chevron at all.
//   4 SCROLL BAR       Cost of locating the AXScrollBar and reading its value.
//   5 LATENCY, 2 PATHS THE DECISIVE CELL. The same single-attribute read on the
//                      same element, timed through the JXA/ObjC bridge (path A)
//                      and through a stdlib-only Python ctypes program with no
//                      bridge at all (path B). If both are slow, the app's main
//                      thread is the wall. If native is far faster, the bridge is.
//   6 BOUNDED READS    Does the table expose AXVisibleRows / AXRows /
//                      AXVisibleChildren? If so, a snapshot could read ~30 rows
//                      instead of 174 -- the single biggest available lever.
//   7 OPT-IN CLICK     Option-click collapse-all, then option-click again to
//                      restore. Three row counts and a restore proof.
//   8 COST MODEL       Predicted wall time for a "collapse-all, drag, restore"
//                      move using THIS host's measured numbers, with every model
//                      input printed so the arithmetic is auditable.

ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");

// ---------------------------------------------------------------- AX plumbing
// Every AX round trip goes through attr() or node(), so CALLS is an exact count
// of the IPC hops made -- the denominator for every ms-per-call figure below.

var CALLS = 0;
function resetCalls() {
  CALLS = 0;
}
function now() {
  return $.NSDate.date.timeIntervalSince1970 * 1000;
}
function sleep(ms) {
  $.NSThread.sleepForTimeInterval(ms / 1000);
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
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
  var pd, zd;
  try {
    pd = ObjC.castRefToObject($.CFCopyDescription(p)).js;
    zd = ObjC.castRefToObject($.CFCopyDescription(z)).js;
  } catch (e) {
    return null;
  }
  var pm = pd.match(/x:([-0-9.]+) y:([-0-9.]+)/);
  var zm = zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return pm && zm ? { x: +pm[1], y: +pm[2], w: +zm[1], h: +zm[2] } : null;
}
function frame(el) {
  return rectOf(attr(el, "AXPosition"), attr(el, "AXSize"));
}
function roundRect(f) {
  if (!f) return null;
  return { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) };
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

// The batched multi-attribute fetch: one round trip for seven attributes. This
// is exactly what the shipped snapshot resolver does, so cell 2 measures the
// real production cost rather than a synthetic one.
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
  var ch = [];
  try {
    var c = a.objectAtIndex(3);
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

// Text harvest. The strings are counted and thrown away -- nothing derived from
// them reaches the output except `nodes` (a visit count) and `chars` (a total
// character LENGTH). No fragment of user text is ever emitted.
function harvestText(n, tally, depth) {
  if (n === null || depth < 0) return tally;
  tally.nodes++;
  if (n.value) tally.chars += n.value.length;
  if (n.desc) tally.chars += n.desc.length;
  if (n.title) tally.chars += n.title.length;
  for (var i = 0; i < n.children.length; i++) {
    harvestText(node(n.children[i]), tally, depth - 1);
  }
  return tally;
}

function isRowRole(r) {
  return r === "AXRow" || r === "AXTableRow";
}
function isListRole(r) {
  return r === "AXTable" || r === "AXOutline" || r === "AXList";
}

// ------------------------------------------------------------- app + windows

var stdApp = Application.currentApplication();
stdApp.includeStandardAdditions = true;

function shell(cmd) {
  try {
    return String(stdApp.doShellScript(cmd)).replace(/\s+$/, "");
  } catch (e) {
    return null;
  }
}
function q(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
// The pid comes from pgrep rather than System Events, so the probe never needs
// an Automation consent grant on top of the Accessibility one.
function thingsPid() {
  var p = shell("/usr/bin/pgrep -x Things3 | head -n 1");
  if (p === null || p === "") {
    p = shell("/usr/bin/pgrep -f 'Things3.app/Contents/MacOS/Things3' | head -n 1");
  }
  var n = Number(p);
  return p !== null && p !== "" && isFinite(n) && n > 0 ? n : null;
}

// Locate the main window AND remember its child index: cell 5's native path has
// to reach the very same element by a pure child-index route.
function mainWindow(appEl) {
  var ws = kids(appEl);
  var std = [];
  for (var i = 0; i < ws.length; i++) {
    if (sv(ws[i], "AXRole") === "AXWindow" && sv(ws[i], "AXSubrole") === "AXStandardWindow") {
      std.push({ el: ws[i], idx: i });
    }
  }
  for (var k = 0; k < std.length; k++) {
    if (sv(std[k].el, "AXMain") === true) return std[k];
  }
  return std.length ? std[0] : null;
}

// Collect every list pane in the window, carrying the child-index path to each,
// so cell 5 can rebuild the identical element from a bare pid.
function listPanes(el, depth, acc, sa, saPath, path) {
  if (depth < 0) return acc;
  var ch = kids(el);
  for (var i = 0; i < ch.length; i++) {
    var role = sv(ch[i], "AXRole");
    var p = path.concat([i]);
    if (isListRole(role)) {
      acc.push({ table: ch[i], tablePath: p, scroll: sa, scrollPath: saPath, role: role });
      continue;
    }
    if (isRowRole(role) || role === "AXCell") continue;
    var isSA = role === "AXScrollArea";
    listPanes(ch[i], depth - 1, acc, isSA ? ch[i] : sa, isSA ? p : saPath, p);
  }
  return acc;
}

function rowsOf(tableEl) {
  var ch = kids(tableEl);
  var out = [];
  for (var i = 0; i < ch.length; i++) {
    if (isRowRole(sv(ch[i], "AXRole"))) out.push({ el: ch[i], idx: i });
  }
  return out;
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
  var d;
  try {
    d = ObjC.castRefToObject($.CFCopyDescription(v)).js;
  } catch (e) {
    return null;
  }
  var m = d.match(/value = ([+\-0-9.]+)/);
  return m ? +m[1] : null;
}

// The disclosure chevron: an AXImage whose description mentions "Toggle". The
// description itself is read but never emitted -- only a found/not-found flag.
function chevronOf(el, depth) {
  if (depth < 0) return null;
  var ch = kids(el);
  for (var i = 0; i < ch.length; i++) {
    if (sv(ch[i], "AXRole") === "AXImage" && sv(ch[i], "AXDescription").indexOf("Toggle") >= 0) {
      return ch[i];
    }
    var r = chevronOf(ch[i], depth - 1);
    if (r) return r;
  }
  return null;
}

function stats(samples) {
  if (!samples.length) return { n: 0, medianMs: null, p95Ms: null };
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

// ------------------------------------------------------- cell 5 path B source
// A stdlib-only Python 3 ctypes driver. It reaches the SAME element by the same
// child-index path and times the same AXRole read, with no scripting bridge in
// the way. Emitted to a temp file, run once, then deleted.

var PY_SRC = [
  "import ctypes, json, sys, time",
  "from ctypes import c_void_p, c_int, c_long, c_char_p, c_uint32, byref",
  "",
  "UTF8 = 0x08000100  # kCFStringEncodingUTF8",
  "",
  "",
  "def main():",
  "    pid = int(sys.argv[1])",
  "    raw = sys.argv[2].strip()",
  "    path = [int(x) for x in raw.split(',') if x != ''] if raw else []",
  "    n = int(sys.argv[3])",
  "    AS = ctypes.CDLL(",
  "        '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')",
  "    CF = ctypes.CDLL(",
  "        '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')",
  "    # Every restype/argtype is declared. A missing restype on a 64-bit pointer",
  "    # return silently truncates to a 32-bit int -- the classic ctypes+AX bug.",
  "    AS.AXUIElementCreateApplication.restype = c_void_p",
  "    AS.AXUIElementCreateApplication.argtypes = [c_int]",
  "    AS.AXUIElementCopyAttributeValue.restype = c_int  # AXError",
  "    AS.AXUIElementCopyAttributeValue.argtypes = [c_void_p, c_void_p, ctypes.POINTER(c_void_p)]",
  "    CF.CFStringCreateWithCString.restype = c_void_p",
  "    CF.CFStringCreateWithCString.argtypes = [c_void_p, c_char_p, c_uint32]",
  "    CF.CFStringGetCString.restype = c_int",
  "    CF.CFStringGetCString.argtypes = [c_void_p, c_char_p, c_long, c_uint32]",
  "    CF.CFArrayGetCount.restype = c_long",
  "    CF.CFArrayGetCount.argtypes = [c_void_p]",
  "    CF.CFArrayGetValueAtIndex.restype = c_void_p",
  "    CF.CFArrayGetValueAtIndex.argtypes = [c_void_p, c_long]",
  "    CF.CFRelease.restype = None",
  "    CF.CFRelease.argtypes = [c_void_p]",
  "",
  "    def cfstr(s):",
  "        return c_void_p(CF.CFStringCreateWithCString(None, s.encode('utf-8'), UTF8))",
  "",
  "    k_children = cfstr('AXChildren')",
  "    k_role = cfstr('AXRole')",
  "",
  "    def copyattr(el, key):",
  "        out = c_void_p()",
  "        err = AS.AXUIElementCopyAttributeValue(el, key, byref(out))",
  "        return err, out",
  "",
  "    app = c_void_p(AS.AXUIElementCreateApplication(pid))",
  "    if not app.value:",
  "        return {'ok': False, 'why': 'AXUIElementCreateApplication returned NULL'}",
  "",
  "    # Child arrays are kept alive for the whole run: elements pulled out of them",
  "    # with CFArrayGetValueAtIndex are BORROWED, so releasing the array could free",
  "    # the element out from under us. Nothing borrowed is ever released here.",
  "    keep = []",
  "    el = app",
  "    for step, idx in enumerate(path):",
  "        err, arr = copyattr(el, k_children)",
  "        if err != 0 or not arr.value:",
  "            return {'ok': False,",
  "                    'why': 'AXChildren failed at step %d (AXError %d)' % (step, err)}",
  "        keep.append(arr)",
  "        cnt = CF.CFArrayGetCount(arr)",
  "        if idx < 0 or idx >= cnt:",
  "            return {'ok': False,",
  "                    'why': 'child index %d out of range %d at step %d' % (idx, cnt, step)}",
  "        el = c_void_p(CF.CFArrayGetValueAtIndex(arr, idx))",
  "        if not el.value:",
  "            return {'ok': False, 'why': 'NULL child at step %d' % step}",
  "",
  "    # Role read once, as proof the native walk landed on the element JXA used.",
  "    # A failing read here would otherwise be timed as if it were a real read,",
  "    # producing a bogus sub-millisecond median and a false 'bridge-bound'",
  "    # verdict, so a failure aborts rather than reporting numbers.",
  "    role = ''",
  "    err, rv = copyattr(el, k_role)",
  "    if err == 0 and rv.value:",
  "        buf = ctypes.create_string_buffer(256)",
  "        if CF.CFStringGetCString(rv, buf, 256, UTF8):",
  "            role = buf.value.decode('utf-8', 'replace')",
  "        CF.CFRelease(rv)",
  "    if err != 0 or role == '':",
  "        return {'ok': False,",
  "                'why': 'AXRole read failed on the target element (AXError %d); the native '",
  "                       'walk did not reach a live element, so no timings were taken' % err}",
  "",
  "    out = c_void_p()",
  "    samples = []",
  "    failed = 0",
  "    for _ in range(n):",
  "        out.value = None",
  "        t0 = time.perf_counter()",
  "        err = AS.AXUIElementCopyAttributeValue(el, k_role, byref(out))",
  "        t1 = time.perf_counter()",
  "        samples.append((t1 - t0) * 1000.0)",
  "        # Released OUTSIDE the timed span; the copy is ours, so it must go.",
  "        if err == 0 and out.value:",
  "            CF.CFRelease(out)",
  "        else:",
  "            failed += 1",
  "",
  "    s = sorted(samples)",
  "",
  "    def pct(p):",
  "        return s[int(round((len(s) - 1) * p))] if s else None",
  "",
  "    def r2(v):",
  "        return round(v, 2) if v is not None else None",
  "",
  "    return {",
  "        'ok': True,",
  "        'available': True,",
  "        'transport': 'python3 ctypes, no scripting bridge',",
  "        'python': sys.version.split()[0],",
  "        'elementRole': role,",
  "        'n': len(s),",
  "        'failedReads': failed,",
  "        'medianMs': r2(pct(0.5)),",
  "        'p95Ms': r2(pct(0.95)),",
  "        'minMs': r2(s[0]) if s else None,",
  "        'maxMs': r2(s[-1]) if s else None,",
  "        'totalMs': round(sum(s), 1) if s else None,",
  "    }",
  "",
  "",
  "try:",
  "    print(json.dumps(main()))",
  "except Exception as exc:",
  "    print(json.dumps({'ok': False, 'available': False,",
  "                      'why': '%s: %s' % (type(exc).__name__, exc)}))",
  "",
].join("\n");

function runNativeLatency(pid, indexPath, n) {
  // /usr/bin/python3 is a shim: on a Mac WITHOUT Command Line Tools it raises
  // the developer-tools installer dialog. This probe must never raise a dialog,
  // so the shim is only invoked once xcode-select confirms the tools are there.
  var haveCLT = shell("/usr/bin/xcode-select -p >/dev/null 2>&1 && echo yes || echo no");
  if (haveCLT !== "yes") {
    return {
      available: false,
      why:
        "Command Line Tools are not installed; invoking /usr/bin/python3 would raise an " +
        "installer dialog, so path B was skipped deliberately.",
    };
  }
  var dir = String($.NSTemporaryDirectory().js || "/tmp").replace(/\/$/, "");
  var file = dir + "/things-field-probe-" + Math.floor(now()) + ".py";
  var wrote = false;
  try {
    var errRef = Ref();
    wrote = $(PY_SRC).writeToFileAtomicallyEncodingError(
      file,
      true,
      $.NSUTF8StringEncoding,
      errRef,
    );
  } catch (e) {
    return { available: false, why: "could not write temp python file: " + e };
  }
  if (!wrote) return { available: false, why: "could not write temp python file at " + file };

  var res;
  try {
    var cmd =
      "/usr/bin/python3 " + q(file) + " " + pid + " " + q(indexPath.join(",")) + " " + n + " 2>&1";
    var raw = String(stdApp.doShellScript(cmd));
    try {
      res = JSON.parse(raw);
    } catch (e2) {
      res = {
        available: false,
        why: "python emitted non-JSON output (" + raw.length + " chars); check python3 health",
      };
    }
  } catch (e3) {
    res = { available: false, why: "python3 failed to run: " + e3 };
  }
  shell("/bin/rm -f " + q(file));
  if (res && res.available === undefined) res.available = res.ok === true;
  if (res) res.tempFileDeleted = true;
  return res;
}

// ------------------------------------------------------ mouse (cell 7 ONLY)
var MOVED = 5,
  DOWN = 1,
  UP = 2;
var ALT_FLAG = 0x00080000; // kCGEventFlagMaskAlternate
function mev(t, x, y, clickState) {
  var e = $.CGEventCreateMouseEvent($(), t, $.CGPointMake(x, y), 0);
  if (clickState) $.CGEventSetIntegerValueField(e, 1, clickState);
  return e;
}
function altClickAt(x, y) {
  var mv = mev(MOVED, x, y, 0);
  $.CGEventSetFlags(mv, 0);
  $.CGEventPost($.kCGHIDEventTap, mv);
  sleep(300);
  var dn = mev(DOWN, x, y, 1);
  $.CGEventSetFlags(dn, ALT_FLAG);
  $.CGEventPost($.kCGHIDEventTap, dn);
  sleep(90);
  var up = mev(UP, x, y, 1);
  $.CGEventSetFlags(up, ALT_FLAG);
  $.CGEventPost($.kCGHIDEventTap, up);
}

// ================================================================ ENTRY POINT

function run(argv) {
  argv = argv || [];
  var allowClick = false;
  var iterations = 200;
  for (var ai = 0; ai < argv.length; ai++) {
    var a = String(argv[ai]);
    if (a === "--allow-click") {
      allowClick = true;
      continue;
    }
    var num = Number(a);
    if (isFinite(num) && num > 0) iterations = Math.floor(num);
  }

  var out = {
    probe: "field-probe-sidebar",
    issue: 676,
    readOnly: !allowClick,
    args: { latencyIterations: iterations, clickCellEnabled: allowClick },
  };

  // ------------------------------------------------------------------ CELL 0
  // Environment. Host and app metadata only -- nothing from the database.
  var trusted = false;
  try {
    var t = $.AXIsProcessTrusted();
    trusted = t === true || t === 1;
  } catch (e) {
    trusted = false;
  }
  var plist = "/Applications/Things3.app/Contents/Info";
  out.cell0_env = {
    thingsVersion: shell("defaults read " + q(plist) + " CFBundleShortVersionString"),
    thingsBuild: shell("defaults read " + q(plist) + " CFBundleVersion"),
    macosProduct: shell("/usr/bin/sw_vers -productVersion"),
    macosBuild: shell("/usr/bin/sw_vers -buildVersion"),
    arch: shell("/usr/bin/uname -m"),
    axTrusted: trusted,
  };
  if (!trusted) {
    out.ok = false;
    out.why =
      "The Accessibility API is not trusted for the app running this script. Open System " +
      "Settings > Privacy & Security > Accessibility, add and enable the terminal app you ran " +
      "this from (Terminal, iTerm, or Ghostty), then run the probe again. Nothing else was " +
      "measured.";
    return JSON.stringify(out, null, 2);
  }

  var pid = thingsPid();
  if (pid === null) {
    out.ok = false;
    out.why = "Things 3 does not appear to be running. Launch it, open its main window, and retry.";
    return JSON.stringify(out, null, 2);
  }
  out.cell0_env.thingsPid = pid;

  var appEl = $.AXUIElementCreateApplication(pid);

  // ------------------------------------------------------------------ CELL 1
  // Sidebar location -- by STRUCTURE, never by title. Panes are ranked by direct
  // row count (descending) then by width (ascending): the sidebar is the long,
  // narrow one. The whole inventory is reported so a wrong pick is obvious.
  resetCalls();
  var tWin = now();
  var win = mainWindow(appEl);
  if (win === null) {
    out.ok = false;
    out.why = "No standard Things window found. Is the main window open (not just the menu bar)?";
    return JSON.stringify(out, null, 2);
  }
  var panes = listPanes(win.el, 8, [], null, null, [win.idx]);
  var inventory = [];
  for (var pi = 0; pi < panes.length; pi++) {
    var pf = frame(panes[pi].table);
    var pr = rowsOf(panes[pi].table);
    inventory.push({
      index: pi,
      role: panes[pi].role,
      rows: pr.length,
      frame: roundRect(pf),
      hasScrollArea: panes[pi].scroll !== null,
      width: pf ? Math.round(pf.w) : null,
      _pane: panes[pi],
      _rows: pr,
    });
  }
  var discoverMs = now() - tWin;
  var discoverCalls = CALLS;

  var ranked = inventory.slice().sort(function (a, b) {
    if (b.rows !== a.rows) return b.rows - a.rows;
    return (a.width === null ? 1e9 : a.width) - (b.width === null ? 1e9 : b.width);
  });
  var chosen = null;
  for (var ri = 0; ri < ranked.length; ri++) {
    if (ranked[ri].rows > 0 && ranked[ri]._pane.scroll !== null) {
      chosen = ranked[ri];
      break;
    }
  }
  var publicInventory = inventory.map(function (p) {
    return {
      index: p.index,
      role: p.role,
      rows: p.rows,
      frame: p.frame,
      hasScrollArea: p.hasScrollArea,
    };
  });
  if (chosen === null) {
    out.ok = false;
    out.cell1_sidebar = {
      listPanesFound: panes.length,
      panes: publicInventory,
      discoveryMs: Math.round(discoverMs),
      discoveryAxCalls: discoverCalls,
    };
    out.why =
      "No list pane with rows inside a scroll area was found, so there is nothing to measure. " +
      "Make sure the Things main window is open, frontmost, and that the sidebar is not hidden.";
    return JSON.stringify(out, null, 2);
  }

  var table = chosen._pane.table;
  var scrollArea = chosen._pane.scroll;
  var tablePath = chosen._pane.tablePath;
  var viewport = frame(scrollArea);
  var sidebarRows = chosen._rows;

  out.cell1_sidebar = {
    listPanesFound: panes.length,
    panes: publicInventory,
    chosenPaneIndex: chosen.index,
    chosenRole: chosen.role,
    chosenFrame: chosen.frame,
    scrollAreaFrame: roundRect(viewport),
    childRowCount: sidebarRows.length,
    scrollBarValue: barValue(scrollBarOf(scrollArea)),
    childIndexPathFromApp: tablePath,
    discoveryMs: Math.round(discoverMs),
    discoveryAxCalls: discoverCalls,
    note: "Pane chosen by structure only (most rows, then narrowest). No titles were compared.",
  };

  // ------------------------------------------------------------------ CELL 2
  // The full sweep -- the thing that takes 16-18s in the field. Depth 2 and
  // depth 6, each run twice: run 1 can include lazy AX-tree construction, run 2
  // is the steady-state cost. Harvested text is counted and discarded.
  function sweep(depth) {
    resetCalls();
    var t0 = now();
    var ch = kids(table);
    var rows = 0;
    var tally = { nodes: 0, chars: 0 };
    for (var i = 0; i < ch.length; i++) {
      var n = node(ch[i]);
      if (n === null || !isRowRole(n.role)) continue;
      rows++;
      harvestText(n, tally, depth);
    }
    var ms = now() - t0;
    return {
      depth: depth,
      ms: Math.round(ms),
      axCalls: CALLS,
      rowsVisited: rows,
      nodesVisited: tally.nodes,
      msPerAxCall: round2(ms / Math.max(1, CALLS)),
      harvestedChars: tally.chars,
    };
  }
  var sweeps = {};
  var depthList = [2, 6];
  for (var di = 0; di < depthList.length; di++) {
    var d = depthList[di];
    sweeps["depth" + d] = { run1: sweep(d), run2: sweep(d) };
  }
  out.cell2_fullSweep = {
    note:
      "run1 may include lazy AX-tree warm-up; run2 is the steady state. harvestedChars is a " +
      "character COUNT of the text read and discarded -- no text is emitted.",
    sweeps: sweeps,
  };

  // ------------------------------------------------------------------ CELL 3
  // One area row and its disclosure chevron: the unit of work a collapse-all
  // move repeats per area. Plus how many rows expose a chevron at all.
  var chevCell = { chevronFound: false };
  var chevRowIdx = -1;
  var chevRowOrder = -1;

  resetCalls();
  var tCensus = now();
  var orderedByY = [];
  for (var oi = 0; oi < sidebarRows.length; oi++) {
    orderedByY.push({
      el: sidebarRows[oi].el,
      idx: sidebarRows[oi].idx,
      f: frame(sidebarRows[oi].el),
    });
  }
  orderedByY.sort(function (a, b) {
    var ay = a.f ? a.f.y : 1e9;
    var by = b.f ? b.f.y : 1e9;
    return ay - by;
  });
  var chevronRows = 0;
  for (var ci = 0; ci < orderedByY.length; ci++) {
    if (chevronOf(orderedByY[ci].el, 5) !== null) {
      chevronRows++;
      if (chevRowOrder < 0) {
        chevRowOrder = ci;
        chevRowIdx = orderedByY[ci].idx;
      }
    }
  }
  chevCell.censusMs = Math.round(now() - tCensus);
  chevCell.censusAxCalls = CALLS;
  chevCell.rowsWithChevron = chevronRows;
  chevCell.firstChevronRowOrderFromTop = chevRowOrder;

  var chevronEl = null;
  var chevronFrame = null;
  if (chevRowIdx >= 0) {
    // (a) locate that row among the table's direct children
    resetCalls();
    var tA = now();
    var chA = kids(table);
    var targetRow = null;
    for (var ka = 0; ka < chA.length; ka++) {
      var nA = node(chA[ka]);
      if (nA === null || !isRowRole(nA.role)) continue;
      if (ka === chevRowIdx) {
        targetRow = chA[ka];
        break;
      }
    }
    chevCell.locateRowMs = Math.round(now() - tA);
    chevCell.locateRowAxCalls = CALLS;

    if (targetRow !== null) {
      // (b) find the chevron AXImage inside that row (recursive walk, depth <= 5)
      resetCalls();
      var tB = now();
      chevronEl = chevronOf(targetRow, 5);
      chevCell.findChevronMs = Math.round(now() - tB);
      chevCell.findChevronAxCalls = CALLS;
      chevCell.chevronFound = chevronEl !== null;

      // (c) a single AXValue read on the row
      resetCalls();
      var tC = now();
      attr(targetRow, "AXValue");
      chevCell.readOneAttrMs = round2(now() - tC);
      chevCell.readOneAttrAxCalls = CALLS;

      if (chevronEl !== null) {
        chevronFrame = frame(chevronEl);
        chevCell.chevronFrame = roundRect(chevronFrame);
      }
    } else {
      chevCell.why = "the row index went stale between the census and the timed lookup";
    }
  } else {
    chevCell.why = "no row in the sidebar exposes a disclosure chevron right now";
  }
  chevCell.note =
    "The chevron is identified by AXRole=AXImage plus an AXDescription containing 'Toggle'. " +
    "The description text itself is never emitted.";
  out.cell3_perNodeCost = chevCell;

  // ------------------------------------------------------------------ CELL 4
  // Scroll bar: about the cheapest useful read there is -- a per-call floor.
  resetCalls();
  var tSB = now();
  var bar = scrollBarOf(scrollArea);
  var bv = barValue(bar);
  out.cell4_scrollBar = {
    found: bar !== null,
    ms: Math.round(now() - tSB),
    axCalls: CALLS,
    value: bv,
  };

  // ------------------------------------------------------------------ CELL 5
  // THE DECISIVE CELL. Same element, same attribute, two transports.
  // Path A goes through JXA's ObjC bridge; path B is a bridge-free ctypes
  // program. If B is roughly as slow as A, Things' own main thread is servicing
  // these requests slowly and no client-side rewrite will help.
  var samplesA = [];
  var failedA = 0;
  for (var li = 0; li < iterations; li++) {
    var tL = now();
    var refA = Ref();
    var errA = $.AXUIElementCopyAttributeValue(table, $("AXRole"), refA);
    samplesA.push(now() - tL);
    if (errA !== 0) failedA++;
  }
  var pathA = stats(samplesA);
  pathA.transport = "JXA / osascript ObjC bridge";
  pathA.element = "sidebar table, AXRole read";
  pathA.childIndexPathFromApp = tablePath;
  pathA.failedReads = failedA;

  var pathB = runNativeLatency(pid, tablePath, iterations);

  // The comparison is only meaningful if BOTH paths actually completed their
  // reads on the SAME element. A failed read is fast and would otherwise fake a
  // "bridge-bound" verdict, so any mismatch downgrades the verdict to "mixed".
  var comparable =
    pathB !== null &&
    pathB.ok === true &&
    pathB.medianMs !== null &&
    pathB.failedReads === 0 &&
    failedA === 0 &&
    pathA.medianMs > 0 &&
    pathB.elementRole === chosen.role;

  var verdict;
  var ratio = null;
  if (comparable) {
    ratio = round2(pathB.medianMs / pathA.medianMs);
    if (ratio < 0.5) {
      verdict =
        "bridge-bound: a helper-side native AX driver is the fix (native/JXA median ratio " +
        ratio +
        ")";
    } else if (ratio <= 2) {
      verdict =
        "app-main-thread-bound: a native in-process AX driver will not help materially " +
        "(native/JXA median ratio " +
        ratio +
        ")";
    } else {
      verdict = "mixed - see numbers (native was slower than JXA; ratio " + ratio + ")";
    }
  } else {
    verdict =
      "mixed - see numbers (the two paths were not comparable: path B unavailable, a read " +
      "failed, or the two paths landed on different elements)";
  }
  out.cell5_perCallLatency = {
    iterations: iterations,
    comparable: comparable,
    pathA_jxa: pathA,
    pathB_native: pathB,
    nativeOverJxaMedianRatio: ratio,
    verdict: verdict,
    note:
      "Both paths read AXRole on the same element, reached natively by the child-index path " +
      "above. pathB.elementRole should match cell 1's chosenRole; if it does not, the two " +
      "paths hit different elements and the comparison is void.",
  };

  // ------------------------------------------------------------------ CELL 6
  // Bounded reads. If the table exposes a visible-row window, a snapshot could
  // read ~30 rows instead of the whole list -- the biggest available lever.
  function tryBounded(name) {
    resetCalls();
    var t0 = now();
    var v = attr(table, name);
    var ms = now() - t0;
    if (v === null) return { present: false, ms: round2(ms), axCalls: CALLS };
    var c = -1;
    try {
      c = Number(v.count);
    } catch (e) {
      c = -1;
    }
    var minY = null;
    var maxY = null;
    var framed = 0;
    if (c > 0) {
      for (var k = 0; k < c; k++) {
        var f = frame(v.objectAtIndex(k));
        if (!f) continue;
        framed++;
        if (minY === null || f.y < minY) minY = f.y;
        if (maxY === null || f.y + f.h > maxY) maxY = f.y + f.h;
      }
    }
    return {
      present: true,
      count: c,
      ms: round2(ms),
      axCallsIncludingFrames: CALLS,
      framesRead: framed,
      minY: minY === null ? null : Math.round(minY),
      maxY: maxY === null ? null : Math.round(maxY),
    };
  }
  // AX attribute NAMES are API constants, not user data -- safe to publish, and
  // they show at a glance what else this table would let us ask for.
  var attrNames = [];
  try {
    var anRef = Ref();
    if ($.AXUIElementCopyAttributeNames(table, anRef) === 0) {
      var arr = ObjC.castRefToObject(anRef[0]);
      for (var an = 0; an < Number(arr.count); an++) {
        attrNames.push(String(arr.objectAtIndex(an).js));
      }
    }
  } catch (e) {
    attrNames = [];
  }
  var inBand = 0;
  for (var vb = 0; vb < orderedByY.length; vb++) {
    var rf = orderedByY[vb].f;
    if (!rf || !viewport) continue;
    var cyv = rf.y + rf.h / 2;
    if (cyv >= viewport.y && cyv <= viewport.y + viewport.h) inBand++;
  }
  var visRows = tryBounded("AXVisibleRows");
  var allRows = tryBounded("AXRows");
  var visKids = tryBounded("AXVisibleChildren");
  var usable = null;
  if (visRows.present && visRows.count > 0 && visRows.count < sidebarRows.length) {
    usable = visRows.count;
  } else if (visKids.present && visKids.count > 0 && visKids.count < sidebarRows.length) {
    usable = visKids.count;
  }
  out.cell6_boundedReads = {
    tableAttributeNames: attrNames,
    totalRows: sidebarRows.length,
    rowsWithCentreInVisibleBand: inBand,
    scrollAreaFrame: roundRect(viewport),
    AXVisibleRows: visRows,
    AXRows: allRows,
    AXVisibleChildren: visKids,
    usableBoundedRowCount: usable,
  };

  // ------------------------------------------------------------------ CELL 7
  // OPT-IN ONLY. Two option-clicks on one chevron: collapse-all, then restore.
  // Refuses if the chevron is not inside the visible band, because an off-band
  // click would land somewhere unintended.
  if (!allowClick) {
    out.cell7_optionClick = { ran: false, why: "pass --allow-click to run this cell" };
  } else if (chevronEl === null || chevronFrame === null) {
    out.cell7_optionClick = { ran: false, why: "no chevron was located in cell 3" };
  } else {
    var cx = chevronFrame.x + chevronFrame.w / 2;
    var cy = chevronFrame.y + chevronFrame.h / 2;
    if (!viewport || cy < viewport.y + 6 || cy > viewport.y + viewport.h - 6) {
      out.cell7_optionClick = {
        ran: false,
        why: "refused: the chevron's centre is not inside the scroll area's visible band",
        chevronCentreY: Math.round(cy),
        band: roundRect(viewport),
      };
    } else {
      var before = rowsOf(table).length;
      altClickAt(cx, cy);
      sleep(800);
      var afterCollapse = rowsOf(table).length;
      altClickAt(cx, cy);
      sleep(800);
      var afterRestore = rowsOf(table).length;
      out.cell7_optionClick = {
        ran: true,
        clickedAt: [Math.round(cx), Math.round(cy)],
        rowsBefore: before,
        rowsAfterFirstOptionClick: afterCollapse,
        rowsAfterSecondOptionClick: afterRestore,
        restored: afterRestore === before,
        note:
          "Two identical option-clicks on one chevron; the second undoes the first. " +
          "'restored' true means the sidebar row count returned to its starting value.",
      };
    }
  }

  // ------------------------------------------------------------------ CELL 8
  // The five-second verdict: this host's measured numbers run through the cost
  // model of a real "collapse-all, drag, restore" move. Every input is printed
  // so the arithmetic can be checked by hand.
  var perCallMs = pathA.medianMs === null ? 0 : pathA.medianMs;
  var sweepCalls = sweeps.depth2.run2.axCalls;
  var areas = chevronRows;
  var CONST_CALLS = 200; // window/pane resolution, drag geometry, verification
  var SETTLE_MS_PER_CLICK = 950; // 300 pointer settle + 90 press + 250 release + 600 re-census
  var DRAG_SETTLE_MS = 1205; // one sidebar drag's own fixed timers

  // Two STRATEGIES, because the lab measured that they differ by more than the
  // read cost does (docs/lab/sbchv1-chevron-budget.md section 6):
  //   collapse-walls  what ships today: fold only the sections that block the
  //                   path. Two chevron actuations for the reported shape.
  //   collapse-all    fold every area, drag in the short list, restore all.
  //                   Fewer rows per read, but 2 actuations PER AREA -- and the
  //                   fixed settles per actuation are what the bar dies on.
  function model(strategy, clicks, sweepsCount, callsPerSweep, basis) {
    var axCalls = sweepsCount * callsPerSweep + CONST_CALLS;
    var axMs = axCalls * perCallMs;
    var settleMs = clicks * SETTLE_MS_PER_CLICK + DRAG_SETTLE_MS;
    var totalMs = axMs + settleMs;
    return {
      strategy: strategy,
      readBasis: basis,
      inputs: {
        perAxCallMs: perCallMs,
        axCallsPerSweep: callsPerSweep,
        sweeps: sweepsCount,
        areasWithChevrons: areas,
        chevronClicks: clicks,
        constantAxCalls: CONST_CALLS,
        settleMsPerClick: SETTLE_MS_PER_CLICK,
        dragSettleMs: DRAG_SETTLE_MS,
      },
      arithmetic:
        sweepsCount +
        " sweeps x " +
        callsPerSweep +
        " calls + " +
        CONST_CALLS +
        " const = " +
        axCalls +
        " AX calls; " +
        axCalls +
        " x " +
        perCallMs +
        " ms = " +
        Math.round(axMs) +
        " ms AX; plus " +
        clicks +
        " clicks x " +
        SETTLE_MS_PER_CLICK +
        " ms + " +
        DRAG_SETTLE_MS +
        " ms drag = " +
        settleMs +
        " ms fixed timers",
      estimatedAxCalls: axCalls,
      axMs: Math.round(axMs),
      fixedTimerMs: settleMs,
      predictedMoveMs: Math.round(totalMs),
      meetsFiveSecondBar: totalMs <= 5000,
    };
  }

  // Sweep counts: collapse-walls does ~6 reads (locate, pre-flight, scroll loop,
  // fold confirm, drag plan, restore confirm); collapse-all does 2 per area.
  function bothStrategies(callsPerSweep, basis) {
    return [
      model("collapse-walls (what ships today)", 2, 6, callsPerSweep, basis),
      model(
        "collapse-all (every area folded and restored)",
        areas * 2,
        areas * 2,
        callsPerSweep,
        basis,
      ),
    ];
  }

  var models = bothStrategies(sweepCalls, "cell 2 depth-2 run 2 (full sweep)");
  if (usable !== null && sidebarRows.length > 0) {
    // Same per-row cost, fewer rows: scale the measured sweep by the fraction of
    // rows a bounded read would actually touch.
    var scaled = Math.max(1, Math.round((sweepCalls * usable) / sidebarRows.length));
    var bounded = bothStrategies(
      scaled,
      "cell 2 depth-2 run 2 scaled by " +
        usable +
        "/" +
        sidebarRows.length +
        " rows (AXVisibleRows)",
    );
    for (var bi = 0; bi < bounded.length; bi++) {
      bounded[bi].boundedRowCount = usable;
      bounded[bi].totalRowCount = sidebarRows.length;
      models.push(bounded[bi]);
    }
  }
  var best = models[0];
  for (var mi = 1; mi < models.length; mi++) {
    if (models[mi].predictedMoveMs < best.predictedMoveMs) best = models[mi];
  }
  out.cell8_costModel = {
    note: "A prediction from THIS host's measured latency, not a measurement of the move itself.",
    fiveSecondBarMs: 5000,
    bestCase: {
      strategy: best.strategy,
      readBasis: best.readBasis,
      predictedMoveMs: best.predictedMoveMs,
      meetsFiveSecondBar: best.meetsFiveSecondBar,
    },
    verdict: best.meetsFiveSecondBar
      ? "REACHABLE on this host: " +
        best.strategy +
        " with " +
        best.readBasis +
        " predicts " +
        best.predictedMoveMs +
        " ms."
      : "NOT REACHABLE on this host with any modelled strategy: the cheapest is " +
        best.strategy +
        " at " +
        best.predictedMoveMs +
        " ms (" +
        best.fixedTimerMs +
        " ms of that is fixed timers that no read optimisation touches).",
    models: models,
  };

  out.ok = true;
  return JSON.stringify(out, null, 2);
}
