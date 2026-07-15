# AXDRAG1 — hardening sidebar-AREA drag-reorder (and scoping TAG reorder)

**Status: COMPLETE (2026-07-15).** All six probes AXDRAG1-a…f executed and DB-verified. Builds on [NATIVE1](native1-spike.md) (PR #142), which proved a single two-row area flip via synthesized HID-tap mouse events from JXA. AXDRAG1 hardens that into an *arbitrary rank placement* recipe, characterizes the `TMArea."index"` rewrite scheme, adds a scroll-then-drag recipe for off-viewport targets, probes mid-drag auto-scroll, catalogs drag hazards (accidental nesting / Escape-abort), and scopes TAG reorder + reversibility.

Things **3.22.11** / macOS **15.7.7** / DB **v26**, ONE disposable clone `axdrag1-lab` of `things-lab-golden-v1` (airgapped, clock-pinned 2026-07-05, SIP enabled), Accessibility granted via the AXVM1 rung-b VNC toggle, everything driven over SSH. Probe ids `AXDRAG1-a`…`AXDRAG1-f`. The reusable JXA driver (`axdrag.js`, verbatim at the end) is the deliverable — it is invoked `osascript -l JavaScript /tmp/axdrag.js <cmd> [args…]`.

## Setup (matches NATIVE1, deltas noted)

1. `tart clone things-lab-golden-v1 axdrag1-lab`; `tart run … --no-graphics --vnc-experimental`; airgap (`route delete default`), pin clock `070512002026`.
2. **Accessibility grant** — golden does NOT carry it (NATIVE1 finding reconfirmed): launch Things → provoke a denied AX op (auto-creates the disabled `kTCCServiceAccessibility | /usr/libexec/sshd-keygen-wrapper | 0` row) → open `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` → VNC toggle (framebuffer `1642 332`) → auth sheet (password field `1020 873`, Modify Settings `1020 966`, password `admin`) → `auth_value` 0→2. Re-probe `System Events … menu bar 1` returns the menu list at `exit 0`. **VNC discipline that mattered:** single-client RFB contends if you fire captures/clicks back-to-back in one process — run **one `vncdo` invocation per step, each `timeout`-wrapped**, with `sleep` between. Batching all steps into a single helper-loop produced silent no-ops (no PNGs, grant not applied); splitting into per-step invocations worked first try.
3. **Seed areas** — the Things URL scheme cannot create areas; AppleScript can: `tell application "Things3" … repeat … make new area with properties {name:"Area-NN"} …`. Seeded `Area-01`…`Area-15` on top of the golden's `LAB-AREA-A`/`LAB-AREA-B` → **17 areas**, enough that the sidebar scrolls at the VM window size (window `935×684` @ `44,25`; sidebar scroll-area viewport `240×610` @ `44,63`, visible bottom ≈ y 673pt; rows extend to y≈1072pt off-viewport).
4. Deploy the driver: pipe over SSH (`lab_ssh "$IP" 'cat > /tmp/axdrag.js' < axdrag.js`) — **`scp` flapped "Permission denied" on the fresh clone; the `cat >` pipe is reliable** (same trick as `gsql.sh`).

## AX structure of the sidebar table (AXDRAG1 addressing)

`winfo` + `rows` output (driver commands). The sidebar = the narrow (`w=240`) `AXTable` under the `AXStandardWindow`'s second `AXScrollArea`. Findings:

- **Row identity is NOT on the row's own `AXDescription`.** NATIVE1 reported sidebar rows carry an `AXDescription` (e.g. `d="LAB-AREA-A."`); on the AppleScript-seeded areas here **`AXDescription` is empty** on every row. The label is reachable instead by concatenating descendant `AXStaticText` `AXValue`s (driver `allText`): row text like `"Area-05.|Source Toggle Template|Area-05"`. So the robust addressing is **descendant-static-text match**, not row `AXDescription`. (Possible divergence: NATIVE1's areas may have been URL/other-seeded; worth noting for the op.)
- The table interleaves **h=24 entity rows** (areas, projects, built-ins) with **h=16 spacer rows** (empty text) — every area is followed by a spacer row that is itself a table row. Index arithmetic on rows must skip spacers.
- Built-ins occupy the first rows (Inbox, Today, Upcoming, Anytime, Someday, Logbook, Trash), then loose projects, then area/project groups.
- **Off-viewport rows still expose valid (virtualized) AX frames** — rows below the viewport bottom (y≈673) report real `AXPosition`/`AXSize` (down to y≈1072) even though not drawn. Frames alone don't tell you what's visible; cross-check against the scroll-area viewport rect from `winfo`.
- `AXSelected` **reads** on rows (`sel` field).

### Baseline DB ordering

All 17 areas start at **`TMArea."index" = 0`** (unmaterialized — Things writes `index` only on a UI drag, per NATIVE1 / the O13 note). The sidebar's displayed area order under an all-zero index is a stable tiebreaker (observed: Area-05, 02, 15, 07, 09, 04, 08, 13, 06, 03, 10, 11, 12, 14, 01 — not creation order). The first drag materializes indices.

## AXDRAG1-a — precision placement + drop geometry + index-rewrite scheme

**Verdict: arbitrary rank placement WORKS in both directions** (adjacent, multi-slot, to-first all confirmed via DB `TMArea."index"` sort). Source frames re-resolved by descendant-static-text (driver `dragname`; click point `row.x+170, row.y+row.h/2`, NATIVE1's label x). Three moves, each DB-verified:

| # | Move | Aimed drop | Result (visual order) | Index delta |
|---|---|---|---|---|
| 1 | Area-05 (1st NN) ↓ below Area-15 | (164, 620) | landed after Area-07 | **first drag materialized ALL 17 indices** |
| 2 | Area-07 → to-first (above LAB-AREA-B) | (164, 354), upward | Area-07 now rank 0 | only Area-07 changed: −44 → **−1155** |
| 3 | Area-15 ↓ past Area-05 | (164, 618), downward | Area-05, Area-15, Area-09 | only **Area-05** changed: −22 → −107 (the *neighbor*, not the dragged row) |

### Drop-point geometry (the load-bearing finding)

The sidebar table interleaves **h=24 entity rows with h=16 spacer rows → 40px per area "slot"** (area centers 40px apart). Drop placement is decided against the **live, mid-drag layout**, and **lifting the source collapses its slot**:

- **Upward drags: aim at STATIC (pre-drag) coordinates.** Targets above the source do not move when the source is lifted. NATIVE1's upward flip and Move 2's to-first both landed using raw pre-drag frames. To insert *before* a reference row, aim ~6px above its top (e.g. y=354 to precede a row at y=360).
- **Downward drags: subtract ONE slot-height (40px) from the static target.** Everything below the source's original position shifts **up by 40px** the instant the source is picked up, so a target computed from the static dump overshoots by one slot. Move 1 aimed at y=620 (≈12px above Area-07's *static* top 632) and landed *after* Area-07 — because live Area-07 had shifted to ~592 and y=620 fell in its bottom half.
- **Before-vs-after within a row is decided by which half the pointer lands in** (top half → insert before that row, bottom half → after), evaluated against the live layout.
- Practical op recipe: dump rows, pick the destination neighbor, and for a downward move use `neighborStaticY − 40`; for an upward move use `neighborStaticY`. Re-dump and re-verify after each move (indices/positions change).

### Index-rewrite characterization (`TMArea."index"`)

- **Lower index sorts higher; DB order by `"index"` == sidebar visual order** (reconfirmed at 17 areas — NATIVE1 saw it at 2).
- **First materializing drag renumbers the WHOLE list** into a sparse, *irregular* ranking (observed: −639, −401, −166, −76, −44, −22, −9, −4, −3, −2, −1, 0, 456, 1032, 1372, 1725, 2143 — not evenly spaced). Before any drag all areas sit at `index=0`.
- **Every subsequent drag reassigns exactly ONE row's index** to a value that slots it into place — an intermediate value strictly between the new neighbors (Move 3: −107 into the (−166, −76) gap — *between* them but **not** the exact midpoint −121), or an extrapolation beyond the current min/max for to-first/to-last (Move 2: −1155, below the −639 minimum).
- **Quirk — Things may renumber the NEIGHBOR instead of the dragged row** (Move 3: dragged Area-15 kept −76; its neighbor Area-05 was rewritten −22 → −107 to sit above it). Things picks whichever single reassignment realizes the requested order. **Consequence for undo (feeds AXDRAG1-f): you cannot restore by rewriting only the moved area's index — capture the full `TMArea."index"` vector pre-drag.**
- The sparse gaps mean many future single-value insertions before a full renumber is forced.

## AXDRAG1-b — scrolled sidebar / off-viewport target (scroll-then-drag recipe)

**Verdict: reliable scroll-then-drag recipe established.** Off-viewport rows are brought into view with synthesized scroll-wheel `CGEvent`s, frames re-resolved, then dragged normally.

### AX scroll position IS exposed (compute, don't guess)

The sidebar `AXScrollArea` carries an `AXScrollBar` child (`AXOrientation = AXVerticalOrientation`) whose **`AXValue` is a Float64 scroll fraction 0.0 → 1.0** (driver `scrollinfo`): `0.0` at top, `0.3409…` mid, `+1.0` at bottom. So the recipe can **compute** how far to scroll instead of scroll-and-check. Combined with `winfo` (viewport rect `240×610` @ y 63, visible band y∈[63, 673]) and the target row's virtual frame from `rows`, the required scroll delta is derivable. (In practice a scroll-until-`row.y ∈ visibleBand` loop is simplest and equally robust.)

### Scroll-wheel synthesis works (HID tap)

`CGEventCreateScrollWheelEvent($(), kCGScrollEventUnitLine, 1, delta)` posted to `kCGHIDEventTap`, with the pointer first moved over the sidebar centre (scroll events target the surface under the cursor). Measured **≈30px content travel per click at `delta=3` lines (~10px/line)**. Negative delta scrolls content up (reveals lower rows). Positionless — allowed by the doctrine. Example: 13 clicks took the scrollbar `AXValue` 0.0 → +1.0 and moved `Area-01` from a virtual y≈1072 (off-viewport) to y=632 (in the visible band).

### Payoff — to-last via scroll-then-drag

With the bottom scrolled into view, dragged `Area-14` **below** the (previously off-viewport) last row `Area-01`. First attempt aimed y=608 ≈ the dragged row's own live centre → **4px no-op** (drop landed back in the source slot). Corrected: aim **below the destination neighbour's *live* (post-pickup) position** — Area-01 shifts 632→~592 when Area-14 is lifted, so y=632 lands clearly below it. Result: `Area-14` now sorts **last** (index 1725 = max), its neighbour `Area-01` renumbered 2143 → 1541 to sit above it (same *neighbour-renumber* quirk as AXDRAG1-a Move 3). **to-last confirmed.**

### Simultaneous-visibility caveat (feeds AXDRAG1-c)

At the VM window height the full area list (17 areas + built-ins + loose projects) does **not** fit one viewport. When scrolled to the bottom to expose `Area-01`, the top of the list (where "to-first" would drop) is scrolled off. So **source and a far target are not always simultaneously visible** — a plain pre-scroll+drag cannot cover an arbitrary far move in one gesture; it needs either a taller window or mid-drag auto-scroll (next probe).

## AXDRAG1-c — mid-drag auto-scroll

**Verdict: Things auto-scrolls mid-drag, bidirectionally, exactly like a native drag.** Holding a drag with the pointer parked near the sidebar's top or bottom edge scrolls the list continuously toward that edge (driver `autoscroll` samples the scrollbar `AXValue` before/after a timed hold):

- **Bottom edge** (hover y=668, viewport bottom 673), 2.5s hold: scrollbar `AXValue` 0.036 → **1.0** (list ran fully to the bottom; former top rows pushed to negative y).
- **Top edge** (hover y=72, viewport top 63), 2.0s hold: `AXValue` 0.942 → **0.0** (ran fully to the top).

So auto-scroll is **reliable** and needs no scroll-wheel synthesis during the gesture — just keep the drag alive (periodic `kCGEventLeftMouseDragged` at the edge point) and hover.

**But it is continuous / time-based, not positional** — while the pointer sits in the edge zone the list keeps scrolling to the end of its range; there is no built-in "scroll exactly one row" from a hover. For a *deterministic* op that must land at a specific rank, the controllable path is **AXDRAG1-b's pre-scroll** (compute from `AXValue`, bring the target row into the visible band, then a same-viewport drag). Auto-scroll's role is to cover the **simultaneous-visibility gap**: because the full list exceeds the viewport (AXDRAG1-b caveat), a far move (e.g. bottom row → to-first) cannot be done in one static gesture. Recommended op recipe for far moves: **pre-scroll the destination into view and drag from a re-resolved source**, or use edge auto-scroll to traverse and release when the destination neighbour enters the visible band (re-resolve + micro-adjust). Auto-scroll alone (drop-while-still-scrolling) is too imprecise to trust for the final landing.

## AXDRAG1-d — drag hazards + Escape-abort

**Verdict: structural nesting is NOT a hazard for area reorder — areas are top-level and cannot be nested; the only failure mode is landing at an unintended rank. Escape mid-drag aborts cleanly.**

Hazard probes drop the dragged area **squarely on another row's centre** (the worst case for an accidental "nest into" indicator), checking the project→area mapping (`TMTask.area`/`.project` for `type=1`) and the area count before/after:

- **D1 — area dropped ON another area's row centre** (Area-05 onto LAB-AREA-A, y=476): **no nesting.** proj→area map unchanged, area count stayed 17, Area-05 stayed an area — it simply reordered to just above LAB-AREA-A (dropping on a centre resolves to *insert-before*).
- **D2 — area dropped ON a project row centre** (Area-09 onto LAB-PROJ-MIXED, a project nested under LAB-AREA-B, y=436): **no nesting, no reparenting.** proj→area/project map byte-identical, count 17. Area-09 took a rank adjacent to the project but remained a top-level area (Things never reparents an area under a project or another area).

So no drop can convert an area into a child or move a project into an area *via an area drag* — `TMArea` count and every `TMTask.area` were invariant across both worst-case drops. (This is safer than the general drag surface, where dropping a *to-do* onto a project/area *does* nest — but that is not the area-reorder op's gesture.) The residual risk is purely **imprecise rank** (wrong slot), mitigated by the AXDRAG1-a geometry rules + DB re-verify.

- **Escape-abort primitive** (driver `escdragname` / `doEscDrag`): begin the drag (mouse-down + wiggle + interpolate toward a new slot), then post a **Key 53 (Escape) down/up via `CGEventCreateKeyboardEvent` to the HID tap**, then mouse-up. A real reordering move (Area-09 dragged from y=476 toward the top, y=360) was **fully aborted — the `TMArea."index"` vector was byte-identical before and after**, and the trailing mouse-up did not re-drop. This is the clean **abort primitive** for the future op (e.g. bail out if re-resolved geometry looks wrong mid-gesture).

## AXDRAG1-f — reversibility

**Verdict: reorder is REVERSIBLE via pre-rank capture + drag-back — relative order restores exactly, though absolute index values do not.**

Captured the full ordered area list `O0`, applied Move A (Area-07 ↓ below LAB-AREA-B → `LAB-AREA-B, Area-07, …`), then the inverse Move B (Area-07 ↑ above LAB-AREA-B). Result: the ordered UUID/name sequence returned **byte-identical to `O0`** (diff empty). But the underlying `TMArea."index"` *values* were **not** restored (Area-07 −1155 → −2171, LAB-AREA-B −639 → −1815) — each drag extrapolates fresh sparse values.

**Undo classification for the op:** reversible, but the undo cannot be "re-write the moved area's old index" — both because writes are UI-only (no direct SQLite) *and* because the AXDRAG1-a neighbour-renumber quirk means the moved area's index may not have changed at all. The correct pattern is the existing **reorder-undo pattern: capture the full ordered list of area UUIDs pre-op, and to undo, drag to reproduce that exact sequence** (order is the invariant that faithfully round-trips; index values are disposable). This matches the pre-rank-capture reorder-undo already used elsewhere.

## AXDRAG1-e — TAG reorder scoping (feasibility + addressing)

**Verdict: TAG reorder is FEASIBLE via the same HID-drag primitive, with a critical extra dimension — the Tags window overloads drag for BOTH reorder and re-parent, distinguished by drop geometry.**

- **Window open** — `Window ▸ Tags` via an **AX menu-item press** (`click menu item "Tags" of menu 1 of menu bar item "Window"`), the backgrounded-capable pure-AX path. Opens a separate window, `AXTitle="Tags"`, **subrole `AXDialog`** (dark sheet: tag rows + right-hand checkboxes; "New Tag"/"Delete" footer). HID drags actuate in it normally (Things frontmost).
- **Addressing — WEAKER than the sidebar.** Tag rows are `AXRow`s in an `AXTable`, **h=22, contiguous (no spacer rows)**, frame-addressable. But the **tag name is NOT exposed to AX** — descendant text is only the placeholder `"Dialog Tag Template"` (and `"Dialog Chevron Template"` on rows that are parents, i.e. have children). So a row cannot be matched by name via AX; identify rows by **position** (correlate to `TMTag` order) or by the **chevron marker** for parent tags. Collapsed children are absent from the row list (they appear only when the parent is expanded).
- **DB columns:** `TMTag."index"` (order, same sparse/negative scheme as areas — lower sorts higher) and `TMTag.parent` (nesting; NULL = top-level).

### Drop geometry: reorder vs re-parent (the load-bearing tag finding)

| Drop point | Effect | Evidence |
|---|---|---|
| **On a row's CENTRE** | **NESTS** (re-parent) | dropped `lab-tag-2` on `lab-tag-1`'s centre → `lab-tag-2.parent` NULL → `9sGML65o…` (lab-tag-1's uuid); no index reorder |
| **On the BOUNDARY between two rows** | **REORDERS** (index only) | dropped `Pending` on the Errand/Home row boundary → `Pending."index"` 0 → **−327** (slotted between Errand −498 and Home −180), `parent` stayed NULL |
| Above/below the list (dead zone) | no-op | drop at y=102 above row 0 changed nothing |

The **same neighbour-renumber quirk as areas** applies (the reorder that moved Pending also rewrote neighbour `lab-tag-1` 0 → −19). **Hazard for a future `tag.reorder`:** a slightly-off drop that lands on a row centre **silently NESTS the tag instead of reordering it** — so the op must target inter-row boundaries precisely and DB-verify `parent` is unchanged after each move. Nested-tag mechanics: drag-onto-centre re-parents; the tree collapses the child under the new parent (chevron appears). Feasibility confirmed; full recipe/hardening is a follow-up build, not this probe.

## The reusable JXA driver (`axdrag.js`, verbatim — the deliverable)

Invoke `osascript -l JavaScript /tmp/axdrag.js <cmd> [args…]`. Deploy via `lab_ssh "$IP" 'cat > /tmp/axdrag.js' < axdrag.js`. Commands: `rows`, `winfo`, `scrollinfo`, `tags-rows`, `dragname <sub> <tx> <ty> [steps] [settle]`, `escdragname`, `drag <sx> <sy> <tx> <ty> [steps] [settle]`, `scroll <clicks> [dyPerClick]`, `autoscroll <sub> <hx> <hy> [holdMs]`. All ObjC-bridge incantations (NSString attrs via `$()`, `ObjC.castRefToObject`, `CFCopyDescription` frame regex, HID-tap `CGEventPost`) are NATIVE1's, verbatim.

```javascript
#!/usr/bin/osascript -l JavaScript
// AXDRAG1 reusable driver — NATIVE1 ObjC-bridge incantations verbatim.
// Usage: osascript -l JavaScript axdrag.js <cmd> [args...]
//   rows                       -> JSON array of sidebar rows {i,d,x,y,w,h}
//   scrollinfo                 -> JSON scroll-area/bar geometry + AXValue
//   drag sx sy tx ty [steps] [settleMs] -> synth drag, prints DONE
//   scroll clicks [dyPerClick] -> synth scroll-wheel over sidebar center (neg=down content)
//   tags-rows                  -> JSON rows of the Tags window table
//   esc-drag sx sy tx ty [steps] -> begin drag, then press Escape mid-drag, release
ObjC.import('AppKit')
ObjC.import('ApplicationServices')
ObjC.import('CoreGraphics')

function pidOf(name) { return Application('System Events').processes.byName(name).unixId() }
function sleep(ms) { $.NSThread.sleepForTimeInterval(ms/1000) }
function attr(el, name) {
  var out = Ref()
  if ($.AXUIElementCopyAttributeValue(el, $(name), out) !== 0) return null
  return ObjC.castRefToObject(out[0])
}
function sv(el, name) { var v = attr(el, name); return v ? v.js : '' }
function nv(el, name) { // numeric AXValue-ish -> via description regex fallback
  var v = attr(el, name); if (v === null) return null
  try { var d = ObjC.castRefToObject($.CFCopyDescription(v)).js; return d } catch(e) { return null }
}
function role(el) { return sv(el, 'AXRole') }
function subrole(el) { return sv(el, 'AXSubrole') }
function frame(el) {
  var p = attr(el, 'AXPosition'), z = attr(el, 'AXSize')
  if (!p || !z) return null
  var pd = ObjC.castRefToObject($.CFCopyDescription(p)).js
  var zd = ObjC.castRefToObject($.CFCopyDescription(z)).js
  var pm = pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm = zd.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return (pm && zm) ? { x: +pm[1], y: +pm[2], w: +zm[1], h: +zm[2] } : null
}
function kids(el) {
  var c = attr(el, 'AXChildren'); if (!c) return []
  var a = []; for (var i = 0; i < c.count; i++) a.push(c.objectAtIndex(i)); return a
}
function appEl() { return $.AXUIElementCreateApplication(pidOf('Things3')) }
function stdWindow() {
  var ws = kids(appEl())
  for (var i = 0; i < ws.length; i++) { if (subrole(ws[i]) === 'AXStandardWindow') return ws[i] }
  return ws.length ? ws[0] : null
}
// find all descendants matching a role, up to a depth
function findAll(el, wantRole, depth, acc) {
  acc = acc || []; if (depth < 0) return acc
  var ch = kids(el)
  for (var i = 0; i < ch.length; i++) {
    if (role(ch[i]) === wantRole) acc.push(ch[i])
    findAll(ch[i], wantRole, depth - 1, acc)
  }
  return acc
}
function sidebarTable() {
  var w = stdWindow(); if (!w) return null
  var tables = findAll(w, 'AXTable', 12, [])
  // sidebar table is the narrow one (width ~240); main list ~697
  var best = null
  for (var i = 0; i < tables.length; i++) {
    var f = frame(tables[i]); if (!f) continue
    if (f.w < 400) { if (!best || f.w < best.w) { best = { el: tables[i], f: f } } }
  }
  return best ? best.el : (tables.length ? tables[0] : null)
}
function allText(el, acc, depth) {
  acc = acc || []; depth = depth==null?6:depth; if (depth<0) return acc
  var v = sv(el, 'AXValue'); if (v) acc.push(v)
  var d = sv(el, 'AXDescription'); if (d) acc.push(d)
  var ttl = sv(el, 'AXTitle'); if (ttl) acc.push(ttl)
  var ch = kids(el)
  for (var i=0;i<ch.length;i++) allText(ch[i], acc, depth-1)
  return acc
}
function sidebarRows() {
  var t = sidebarTable(); if (!t) return []
  var out = []
  var ch = kids(t)
  for (var i = 0; i < ch.length; i++) {
    var r = role(ch[i])
    if (r === 'AXRow' || r === 'AXTableRow') {
      var f = frame(ch[i])
      var txt = allText(ch[i], [], 6)
      out.push({ i: out.length, d: sv(ch[i], 'AXDescription'), t: txt.join('|'), sel: sv(ch[i],'AXSelected'), r: r, x: f?f.x:null, y: f?f.y:null, w: f?f.w:null, h: f?f.h:null })
    }
  }
  return out
}
function winfo() {
  var w = stdWindow(); var wf = w?frame(w):null
  var areas = w?findAll(w,'AXScrollArea',12,[]):[]
  var sb = null
  for (var i=0;i<areas.length;i++){ var f=frame(areas[i]); if(f&&f.w<400){sb={frame:f}; break} }
  return { window: wf, sidebarArea: sb }
}

// ---- mouse synthesis (HID tap; NATIVE1) ----
var MOVED = 5, DOWN = 1, UP = 2, DRAG = 6
function mev(type, x, y, clickState) {
  var e = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), 0)
  if (clickState) $.CGEventSetIntegerValueField(e, 1, clickState)
  return e
}
function postHID(ev) { $.CGEventPost($.kCGHIDEventTap, ev) }
function doDrag(sx, sy, tx, ty, steps, settleMs) {
  steps = steps || 25; settleMs = settleMs || 400
  postHID(mev(MOVED, sx, sy, 0)); sleep(30)
  postHID(mev(DOWN, sx, sy, 1)); sleep(120)
  postHID(mev(DRAG, sx, sy - 3, 1)); sleep(30)          // wiggle -> begin drag
  for (var i = 1; i <= steps; i++) {
    postHID(mev(DRAG, sx + (tx-sx)*i/steps, sy + (ty-sy)*i/steps, 1)); sleep(25)
  }
  postHID(mev(DRAG, tx, ty, 1)); sleep(settleMs)
  postHID(mev(UP, tx, ty, 1))
}
function doEscDrag(sx, sy, tx, ty, steps) {
  steps = steps || 25
  postHID(mev(MOVED, sx, sy, 0)); sleep(30)
  postHID(mev(DOWN, sx, sy, 1)); sleep(120)
  postHID(mev(DRAG, sx, sy - 3, 1)); sleep(30)
  for (var i = 1; i <= steps; i++) {
    postHID(mev(DRAG, sx + (tx-sx)*i/steps, sy + (ty-sy)*i/steps, 1)); sleep(25)
  }
  sleep(200)
  // press Escape (key code 53) via keyboard event to abort the drag
  var kd = $.CGEventCreateKeyboardEvent($(), 53, true)
  var ku = $.CGEventCreateKeyboardEvent($(), 53, false)
  postHID(kd); sleep(20); postHID(ku); sleep(200)
  postHID(mev(UP, tx, ty, 1))
}
function doScroll(clicks, dyPerClick) {
  // move pointer over sidebar center, then post line-unit scroll events
  var t = sidebarTable(); var f = t ? frame(t) : null
  if (f) { postHID(mev(MOVED, f.x + f.w/2, f.y + f.h/2, 0)); sleep(50) }
  dyPerClick = dyPerClick || 3
  var n = Math.abs(clicks), dir = clicks < 0 ? -1 : 1
  for (var i = 0; i < n; i++) {
    var ev = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, dir * dyPerClick)
    postHID(ev); sleep(60)
  }
}
function scrollInfo() {
  var w = stdWindow(); if (!w) return {}
  var areas = findAll(w, 'AXScrollArea', 12, [])
  var res = []
  for (var i = 0; i < areas.length; i++) {
    var f = frame(areas[i])
    if (!f || f.w >= 400) continue // sidebar scroll area only
    var bars = findAll(areas[i], 'AXScrollBar', 4, [])
    var barInfo = []
    for (var b = 0; b < bars.length; b++) {
      barInfo.push({ orient: sv(bars[b], 'AXOrientation'), value: nv(bars[b], 'AXValue'), frame: frame(bars[b]) })
    }
    res.push({ area: f, bars: barInfo })
  }
  return res
}
function tagsRows() {
  // Tags window: separate window titled "Tags"
  var ws = kids(appEl())
  for (var i = 0; i < ws.length; i++) {
    var title = sv(ws[i], 'AXTitle')
    if (title && title.indexOf('Tag') >= 0) {
      var tables = findAll(ws[i], 'AXTable', 12, []).concat(findAll(ws[i], 'AXOutline', 12, []))
      var out = []
      for (var t = 0; t < tables.length; t++) {
        var ch = kids(tables[t])
        for (var j = 0; j < ch.length; j++) {
          var r = role(ch[j])
          if (r === 'AXRow' || r === 'AXTableRow') {
            var f = frame(ch[j])
            out.push({ table: t, txt: allText(ch[j],[],6).join('|'),
              dl: sv(ch[j],'AXDisclosureLevel'), dc: sv(ch[j],'AXDisclosing'), da: sv(ch[j],'AXDisclosedByRow'),
              x:f?f.x:null,y:f?f.y:null,w:f?f.w:null,h:f?f.h:null })
          }
        }
      }
      return { window: title, rows: out }
    }
  }
  return { window: null, rows: [] }
}

function rowByName(sub) {
  var rs = sidebarRows()
  for (var i=0;i<rs.length;i++){ if (rs[i].t && rs[i].t.indexOf(sub) === 0) return rs[i] }
  for (var i=0;i<rs.length;i++){ if (rs[i].t && rs[i].t.indexOf(sub) >= 0) return rs[i] }
  return null
}
function scrollFrac() {
  var info = scrollInfo()
  if (!info.length || !info[0].bars.length) return null
  var d = info[0].bars[0].value
  if (!d) return null
  var m = d.match(/value = ([+\-0-9.]+)/)
  return m ? +m[1] : null
}
function autoScrollTest(srcSub, hx, hy, holdMs) {
  var r = rowByName(srcSub); if (!r) return 'SRC_NOT_FOUND'
  var sx = r.x + 170, sy = r.y + r.h/2
  postHID(mev(MOVED, sx, sy, 0)); sleep(30)
  postHID(mev(DOWN, sx, sy, 1)); sleep(120)
  postHID(mev(DRAG, sx, sy - 3, 1)); sleep(30)
  // move to hover point in ~15 steps
  for (var i = 1; i <= 15; i++) { postHID(mev(DRAG, sx + (hx-sx)*i/15, sy + (hy-sy)*i/15, 1)); sleep(20) }
  var v0 = scrollFrac()
  var iters = Math.max(1, Math.round((holdMs||1500)/100))
  for (var j = 0; j < iters; j++) { postHID(mev(DRAG, hx, hy, 1)); sleep(100) }
  var v1 = scrollFrac()
  postHID(mev(UP, hx, hy, 1))
  return JSON.stringify({ src: srcSub, hover:{x:hx,y:hy}, v0:v0, v1:v1, moved: (v0!=null&&v1!=null)?(v1-v0):null })
}
function run(argv) {
  var cmd = argv[0]
  if (cmd === 'autoscroll') { return autoScrollTest(argv[1], +argv[2], +argv[3], argv[4]?+argv[4]:1500) }
  if (cmd === 'dragname') {
    // dragname <srcSub> <tx> <ty> [steps] [settle]  -> resolves src center fresh, drags to (tx,ty)
    var r = rowByName(argv[1]); if (!r) return 'SRC_NOT_FOUND'
    var sx = r.x + 170, sy = r.y + r.h/2   // x+170 into the label area (NATIVE1 double-click x)
    doDrag(sx, sy, +argv[2], +argv[3], argv[4]?+argv[4]:0, argv[5]?+argv[5]:0)
    return JSON.stringify({src:argv[1], from:{x:sx,y:sy}, to:{x:+argv[2],y:+argv[3]}})
  }
  if (cmd === 'escdragname') {
    var r = rowByName(argv[1]); if (!r) return 'SRC_NOT_FOUND'
    var sx = r.x + 170, sy = r.y + r.h/2
    doEscDrag(sx, sy, +argv[2], +argv[3], argv[4]?+argv[4]:0)
    return JSON.stringify({src:argv[1], from:{x:sx,y:sy}, to:{x:+argv[2],y:+argv[3]}})
  }
  if (cmd === 'rows') return JSON.stringify(sidebarRows())
  if (cmd === 'winfo') return JSON.stringify(winfo())
  if (cmd === 'scrollinfo') return JSON.stringify(scrollInfo())
  if (cmd === 'tags-rows') return JSON.stringify(tagsRows())
  if (cmd === 'drag') { doDrag(+argv[1], +argv[2], +argv[3], +argv[4], argv[5]?+argv[5]:0, argv[6]?+argv[6]:0); return 'DONE' }
  if (cmd === 'esc-drag') { doEscDrag(+argv[1], +argv[2], +argv[3], +argv[4], argv[5]?+argv[5]:0); return 'DONE' }
  if (cmd === 'scroll') { doScroll(+argv[1], argv[2]?+argv[2]:0); return 'DONE' }
  return 'UNKNOWN_CMD'
}
```
