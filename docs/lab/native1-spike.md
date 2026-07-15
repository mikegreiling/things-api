# NATIVE1 — the row-selection / mouse-synthesis primitive (JXA ObjC bridge)

**Verdict (2026-07-15):** the mouse-synthesis primitive that gates `todo.stop-repeat` (card open) and `area.reorder-sidebar` (drag) **WORKS**, entirely from **JXA (`osascript -l JavaScript`) via the ObjC bridge — no compiled Swift helper needed (Tier 1 wins)**. AX element frames are resolved through `AXUIElementCopyAttributeValue` and mouse events are synthesized with `CGEventCreateMouseEvent`. The one hard correction to the brief: **`CGEventPostToPid` does NOT work** — synthetic mouse events posted to Things' pid never actuate its hit-testing (selection doesn't move, no card opens). The events must go through the **HID event tap** (`CGEventPost(kCGHIDEventTap, …)`), which lands. Because the working path is the global HID tap and not a process-targeted post, the primitive is **foreground-bound**: it does NOT operate backgrounded or under-lock (unlike the pure-AX menu path, AXVM1-d). It needs **only the Accessibility grant** — no second TCC consent class.

Things **3.22.11** / macOS **15.7.7** / DB **v26**, in ONE disposable clone `native1-lab` of `things-lab-golden-v1` (airgapped, clock-pinned 2026-07-05, SIP enabled), Accessibility granted via the AXVM1 rung-b user-path toggle, everything driven over SSH. Cross-linked from [ax-initiative.md](../design/ax-initiative.md) (executes its NATIVE1 section) and [axvm1-accessibility.md](axvm1-accessibility.md); working JXA in `lab/artifacts/` is reproduced verbatim below (the scripts ARE the deliverable).

## Setup deviation from the brief (NATIVE1-a)

The brief stated the golden "carries" an Accessibility grant. **It does not.** A fresh clone of `things-lab-golden-v1` has only `kTCCServicePostEvent | com.apple.screensharing.agent | 2` (why VNC synthetic HID works) and **no** `kTCCServiceAccessibility` row. The full AXVM1 rung-b grant had to be applied: launch Things → provoke a denied AX op (auto-creates the disabled `kTCCServiceAccessibility | /usr/libexec/sshd-keygen-wrapper | 0` row) → open `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` → VNC-click the lone toggle (framebuffer `1642 332`) → authenticate `admin` at the sheet (password field `1021 873`, Modify Settings `1021 967`) → `auth_value` 0→2. After that, `osascript … System Events … menu bar 1` returns `exit 0` over SSH. (Golden-v2 could bake this per AXVM1's optional L3 layer; still not built.)

## The JXA ObjC bridge — bridging incantations that work (NATIVE1-b)

Half the spike's value. Establishing these took iteration; the exact forms that work:

```javascript
ObjC.import('AppKit')             // NSWorkspace / NSString
ObjC.import('ApplicationServices') // AXUIElement* + AXValue* (HIServices umbrella)
ObjC.import('CoreGraphics')        // CGEvent* (also reachable via ApplicationServices)

// pid: the cheapest handle is System Events' process object
function pidOf(name) { return Application('System Events').processes.byName(name).unixId() }

var app = $.AXUIElementCreateApplication(pid)   // AXUIElementRef for the app
```

Three non-obvious gotchas, each cost a probe:

1. **Attribute names MUST be NSStrings.** Passing a plain JS string `'AXRole'` returns `-25201` (kAXErrorIllegalArgument). Wrap it: `$('AXRole')`. (`$.NSString.stringWithString('AXRole')` also works; `$()` is the shorthand.)
2. **CF out-params come back as opaque `Ref` pointers** — `ObjC.unwrap` does nothing useful on them. Convert with **`ObjC.castRefToObject(ref)`**, then `.js` for a CFString → JS string, or `.count`/`.objectAtIndex(i)` for a CFArray.
3. **AXValue (position/size) has no clean struct-out path in JXA.** Instead of fighting `AXValueGetValue` + a CGPoint struct pointer, take the AXValue's **`CFCopyDescription` and regex it** — reliable and self-documenting.

Complete, working helpers (verbatim):

```javascript
function attr(el, name) {                       // returns ObjC object or null
  var out = Ref()
  if ($.AXUIElementCopyAttributeValue(el, $(name), out) !== 0) return null
  return ObjC.castRefToObject(out[0])
}
function sv(el, name) { var v = attr(el, name); return v ? v.js : '' }   // string attr

function frame(el) {                            // {x,y,w,h} in global screen POINTS
  var p = attr(el, 'AXPosition'), z = attr(el, 'AXSize')
  if (!p || !z) return null
  var pd = ObjC.castRefToObject($.CFCopyDescription(p)).js  // "...{value = x:164.0 y:436.0 type = kAXValueCGPointType}"
  var zd = ObjC.castRefToObject($.CFCopyDescription(z)).js  // "...{value = w:240.0 h:24.0 type = kAXValueCGSizeType}"
  var pm = pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm = zd.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return (pm && zm) ? { x: +pm[1], y: +pm[2], w: +zm[1], h: +zm[2] } : null
}
function kids(el) {
  var c = attr(el, 'AXChildren'); if (!c) return []
  var a = []; for (var i = 0; i < c.count; i++) a.push(c.objectAtIndex(i)); return a
}
```

**Coordinate space:** AX frames are global-screen top-left-origin **points**. The VM's display is 1024×768 pt (2048×1536 px, 2× retina). CGEvent mouse coordinates use the **same** point space, so an AX-resolved frame center maps 1:1 to a CGEvent location — no scaling. (Confirmed empirically: clicks/drops land exactly where the AX frame says.)

### AX tree shape (what's addressable)

The main standard window is `window whose AXSubrole = "AXStandardWindow"` (`window 1` is the 40×40 `AXUnknown` utility window — matches UIC1). Under it:

- **Main list** = the first `AXScrollArea` → `AXTable` (width ≈ 697) → `AXRow/AXTableRow` (each ≈ 28 pt tall) → one `AXCell`. To-do rows carry only `AXImage` children (checkbox at x≈319, template icons); the **title text is NOT exposed** on list rows (only the open card exposes an editable `AXTextArea`). Rows are addressable by **frame**, not by title.
- **Sidebar** = the second `AXScrollArea` → `AXTable` (width 240) → rows. **Sidebar area/project rows DO carry an `AXDescription`** (e.g. `d="LAB-AREA-A."`, `d="LAB-PROJ-MIXED."`), so a sidebar entity is locatable by description **and** frame — better than UIC1's blanket "rows aren't AX-addressable" (that holds for the main list; the sidebar exposes descriptions).
- **`AXSelectedRows` READS correctly** on both tables. After `things:///show?id=<uuid>` the selected to-do's row is returned by `attr(mainTable,'AXSelectedRows').objectAtIndex(0)` with a valid frame — the clean way to resolve the double-click target without title matching. (UIC1's "no AX selection handle" was about *setting* selection via AX; *reading* it works.)

## Double-click → the card opens (NATIVE1-c)

**Verdict: YES via the HID tap; NO via PostToPid.** Unblocks `todo.stop-repeat`.

First, the falsification. A single left-click posted with `CGEventPostToPid(pid, …)` at a resolved row center did **not** move `AXSelectedRows`; the same click posted with `CGEventPost($.kCGHIDEventTap, …)` **did** move selection to the clicked row. So PostToPid mouse events are inert for Things' hit-testing; the HID tap is the working mechanism. Re-tested for the double-click specifically (with a mouse-move preamble and Things frontmost): PostToPid double-click → 0 card elements; HID double-click → card opens. This is the central deviation from the brief.

Working synthesizer (verbatim):

```javascript
function post(tap, pid, ev) {
  if (tap === 'hid') $.CGEventPost($.kCGHIDEventTap, ev)  // WORKS
  else $.CGEventPostToPid(pid, ev)                        // inert for mouse — do not use
}
function mev(type, x, y, clickState) {
  var e = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), 0)  // $() = NULL source, 0 = kCGMouseButtonLeft
  if (clickState) $.CGEventSetIntegerValueField(e, 1, clickState)       // field 1 = kCGMouseEventClickState
  return e
}
// double-click at (x,y): move, then two down/up pairs; second pair carries clickState 2
var MOVED = 5, DOWN = 1, UP = 2   // kCGEventMouseMoved / LeftMouseDown / LeftMouseUp
post('hid', pid, mev(MOVED, x, y, 0)); sleep(20)
post('hid', pid, mev(DOWN, x, y, 1)); sleep(15); post('hid', pid, mev(UP, x, y, 1))
sleep(80)  // < system double-click interval
post('hid', pid, mev(DOWN, x, y, 2)); sleep(15); post('hid', pid, mev(UP, x, y, 2))
```
(`sleep(ms)` = `$.NSThread.sleepForTimeInterval(ms/1000)`.)

Target resolution: `open things:///show?id=<uuid>` (selects the row) → read `AXSelectedRows` → double-click at `row.x + 170, row.y + row.h/2` (x+170 lands in the title area, past the checkbox at x≈319, clear of the completion circle).

**Result:** double-clicking a plain to-do's row expands its **card** — the AX tree gains `AXTextArea v="<title>"` (title editor), an empty notes `AXTextArea`, and `AXImage d="TaskDetails Tags/Checklist/Deadline Template"` detail buttons. Double-clicking the **repeating** template `LAB-REPEAT-DAILY` additionally surfaces `AXImage d="TaskDetails RepeatSmall"` + `AXTextArea v="Repeat daily — Jul 6"` — **the repeat bar is reachable**, i.e. the card-only Stop popover path (double-click row → click the "↻ Repeat every …" bar → Stop) is now drivable. `todo.stop-repeat` is unblocked.

## Drag → an area actually reorders (NATIVE1-d)

**Verdict: YES via the HID tap.** Unblocks `area.reorder-sidebar`. **DB ordering column confirmed empirically: `TMArea."index"`.**

Two seeded areas, both `TMArea."index" = 0` (unmaterialized — Things writes the index only on a UI drag, per the O13 note). Sidebar display order before: **LAB-AREA-B** (row y=360) above **LAB-AREA-A** (y=424). Dragged LAB-AREA-A's row center (164, 436) up to just above B (164, 354): mouse-down, an initial 3-pt wiggle to open the drag session, ~25 interpolated `kCGEventLeftMouseDragged` (=6) steps at 25 ms each, a 400 ms settle on the target so the drop indicator locks, then mouse-up.

```javascript
var DRAG = 6  // kCGEventLeftMouseDragged
post('hid', pid, mev(MOVED, sx, sy, 0)); sleep(30)
post('hid', pid, mev(DOWN,  sx, sy, 1)); sleep(120)
post('hid', pid, mev(DRAG,  sx, sy - 3, 1)); sleep(30)          // wiggle → begin drag
for (var i = 1; i <= steps; i++) {                              // interpolate to target
  post('hid', pid, mev(DRAG, sx + (tx-sx)*i/steps, sy + (ty-sy)*i/steps, 1)); sleep(25)
}
post('hid', pid, mev(DRAG, tx, ty, 1)); sleep(400)             // settle so drop indicator locks
post('hid', pid, mev(UP,   tx, ty, 1))
```

**Result — landed in both UI and DB:**
- Sidebar display order after: **LAB-AREA-A** now on top (y=360), **LAB-AREA-B** below (y=448) — the nested projects moved with their areas.
- `TMArea."index"`: **LAB-AREA-A 0 → −448**, LAB-AREA-B stays 0. So `index` is the sort key, it is **mutable via drag**, and Things uses a **sparse/negative** scheme — a lower index sorts higher; the moved item was assigned a negative index to precede its new successor. Reversibility for the eventual op is straightforward via pre-rank capture (existing reorder-undo pattern), and the moved area now has a materialized index to restore to.

## Behavioral probes

### Backgrounded — NO (NATIVE1-e)
With **Finder** activated frontmost, an HID double-click posted at Things' resolved row coordinates did **not** open the card and frontmost **stayed Finder** (the global HID event went to the frontmost/topmost surface, not Things). PostToPid backgrounded is likewise inert. So the mouse-synthesis primitive is **foreground-bound** — Things must be frontmost. This is the decisive contrast with the pure-AX menu path (AXVM1-d: menu presses actuate backgrounded with no focus steal). The mouse tier sits with VNC synthetic HID (UI2-e), not with AX.

### Under-lock — NO (NATIVE1-f)
Gate enabled via `sudo sysadminctl -screenLock immediate -password admin`, then locked with `SACLockScreenImmediate` (launchctl asuser, rc=0; framebuffer blanked to the lock/asleep state). An HID double-click at Things' coordinates under lock did **not** open the card (AX read over SSH — which still works under lock — shows no card elements). The HID event hits the lock screen, exactly like VNC arm (f) in LOCK1. Again the opposite of the AX menu path, which works under lock (AXVM1-d).

### TCC — only Accessibility is required (NATIVE1-g)
After all the `CGEventPost(kCGHIDEventTap, …)` calls, the system `TCC.db` shows **no new `kTCCServicePostEvent` or `kTCCServiceListenEvent` (Input Monitoring) row**. Our driving process (responsible process `sshd-keygen-wrapper`) has **no** PostEvent grant, yet HID posting landed — so **CGEvent posting is authorized by the Accessibility grant alone**; no second consent class (Input Monitoring / PostEvent) is needed to POST. (The pre-existing `kTCCServicePostEvent | com.apple.screensharing.agent | 2` is the *screensharing* HID path, unrelated to our process. Input Monitoring / `kTCCServiceListenEvent` gates *listening* to events, not posting.) PostToPid's failure is therefore **architectural, not a TCC denial** — no denial row was created for it, and CGEventPost (same-or-stricter permission) succeeded.

### AXScrollToVisible on sidebar rows — NOT available (NATIVE1-h; feeds AXDRAG1)
`AXUIElementCopyActionNames` on both main-list and sidebar rows (and their cells) returns an **empty** action list, and `AXUIElementPerformAction(row, $('AXScrollToVisible'))` returns **−25206** (kAXErrorActionUnsupported). Rows expose zero AX actions, so an off-viewport drop target **cannot** be scrolled into view via `AXScrollToVisible` on the row. The AXDRAG1 scrolled-sidebar edge case will need **synthesized scroll-wheel CGEvents** (`CGEventCreateScrollWheelEvent`) or an auto-scroll-by-drag-to-edge approach instead. (Quick yes/no as scoped; full edge-case work is AXDRAG1's.)

## What this means for the roadmap

- **Tier 1 (JXA ObjC bridge) is sufficient** — no Swift helper. The compiled-helper distribution doctrine question (ax-initiative "compiled-helper distribution is a doctrine question for later") can stay parked; a v1 driver can synthesize mouse input from `osascript -l JavaScript` alone, same as the existing AX menu path.
- **`todo.stop-repeat` is unblockable** (card open + repeat bar reachable). Whether to build it or drop it remains Mike's ruling #3 / the CRASH1 decision — NATIVE1 only removes the technical blocker.
- **`area.reorder-sidebar` is feasible** (drag lands, `TMArea."index"` is the column). Ready for the AXDRAG1 build, modulo the scroll edge case (scroll-wheel synthesis, above).
- **Disruption tier:** the mouse-synthesis vector is **foreground + unlocked only** (focus-steal tier), strictly more disruptive than the AX menu path. On a dedicated/headless host that's acceptable for the rare card/drag ops but should be documented in the ui-vector disruption profile alongside VNC.

## Deviations from the brief (summary)
1. Golden does **not** carry the Accessibility grant — applied AXVM1 rung-b (VNC) as part of setup.
2. **`CGEventPostToPid` does not work** for driving Things (the brief's prescribed mechanism); the **HID event tap** does. Consequently the "PostToPid posts to a process, so background is plausible" hypothesis is **falsified** — the working path is global and foreground-bound.
