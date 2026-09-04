# PTRGD1 — the pre-gesture guard on every synthesized pointer gesture (#676)

**Probed under:** `things-lab-golden-v4` · Things **3.23** (build 32300036) · macOS **15.7.7** (24G720) · DB **v27** · clock pinned 2026-07-05 (trial wall 2026-07-18, never approached) · airgapped clone, destroyed at teardown · fixture 100% synthetic · package built from the branch and shipped into the guest (`0.20.8` + this change).

**Fixture:** SBCHV1's — 14 areas, 137 projects, **174 sidebar table rows**, one section taller than any viewport. The guard's cost is therefore measured against a field-shaped read, not a toy sidebar.

Driver: [`lab/scripts/research-ptrgd1.sh`](../../lab/scripts/research-ptrgd1.sh) · leg probe: generated from the SHIPPED guard (`POINTER_GUARD_STANDALONE`) so the cells interrogate the same code the gestures carry · lab occluder: [`lab/scripts/ptrgd1-panel.jxa.js`](../../lab/scripts/ptrgd1-panel.jxa.js).

**Host-side measurement** (2026-09-03, the maintainer's Mac, read-only — `NSWorkspace`, `CGWindowListCopyWindowInfo` and one AX hit test, no synthesized events): §2 below. It is what settled the design.

---

## 0. The gap, stated exactly

Every keystroke this vector synthesizes has re-asserted, since #620, that Things owns the screen — in the SAME osascript hop that types (`AX_FOCUS_GUARD_HANDLERS`; folded into the acting script by DRVLAT1). The synthesized POINTER gestures had no equivalent, and they are the more dangerous half: a keystroke that leaks lands in a foreign text field, a drag that leaks moves a foreign application's files.

The hazard is structural. Every mouse event goes to `kCGHIDEventTap` at a SCREEN COORDINATE derived from an AX frame, and AX frames resolve perfectly well for a window that is backgrounded, half-covered, or on another Space. Between the census that reads the frame and the gesture that uses it, the user can ⌘-Tab, drag a window over the sidebar, take a notification banner, lock the screen, or simply scroll the sidebar. On the maintainer's M1 one sidebar census alone is 16–18 s (SBCHV1), so that window is seconds wide on every move.

**What HARDEN1 (#627) already does, and why it is not enough.** `guardedRun` runs a drive-level frontmost/focus census one hop ahead of every pointer-class primitive (`POINTER_CLASS` = `click-point`, `sidebar-drag`, `sidebar-held-drag`, `sidebar-scroll`, `sidebar-chevron`). That census STAYS — it is what produces the refusal a caller reads for the ordinary "you ⌘-Tabbed away before the command started" case, and it latches the dialog invariant. Four things it cannot do:

| | HARDEN1's census | PTRGD1 |
|---|---|---|
| **when** | a separate osascript hop, before the gesture | the same script, immediately before the first event |
| **occlusion** | not asked — frontmost is not "unoccluded at this point" | asked, at every point the gesture visits |
| **identity** | not asked — says nothing about WHICH element the coordinates hit | the app's own hit test must reach the planned row/control |
| **during** | never runs during a gesture | a held drag re-checks at the drop before releasing |

Also examined and found already covered: `abortPartial`'s Escape in `ui-drag.ts`. It dispatches `primitive: "key"`, which is in `KEYSTROKE_CLASS`, so `guardedRun` folds `axFocusGuardPrelude` in front of that very script. The brief's premise that it was unguarded was wrong; the code now says so in place, and the comment names the primitive as load-bearing so it does not get hand-rolled into JXA later.

---

## 1. The law

Asserted in the same script as the first HID event, before anything is posted:

1. **Frontmost** — the frontmost application's bundle identifier is `com.culturedcode.ThingsMac`. Same law and same refusal-sentence family as the keystroke guard.
2. **Containment** — Things' own window frame contains every point the gesture will visit (a straight-line drag visits its two endpoints; a click visits one). The AXMain standard window for the sidebar gestures; ANY Things window or sheet for `click-point`, because the Repeat dialog is presented as a detached editor window whenever Things is not frontmost (MODALX1/#629).
3. **Occlusion** — nothing of another application's is between the pointer and Things at that point. Two independent tests, §2.
4. **Identity** — the app-scoped hit test (`AXUIElementCopyElementAtPosition` on Things' application element) at the grab point must reach the very element that was planned against: for a sidebar drag, an `AXRow`/`AXTableRow` whose frame equals the planned row's (±2 pt); for the chevron, the arrow's own live frame; for `click-point`, a chain that reaches an `AXSheet` or `AXWindow`. VOPAT1 found hit-testing unreliable for READING content off-band; this is an in-band identity check, which is what it is good for.
5. **Drop-time re-check** — in both drag scripts, legs 1 and 3 again at the drop point before the button comes up. On failure: Escape while still held (AXDRAG1-d's byte-identical abort vector), then release, and report `{aborted:true, why}` instead of dropping.

**Fail direction: over-caution, ruled.** A false refusal from an always-on-top overlay names the culprit and costs a re-run; a false pass moves someone's files. Nothing is posted on any refusal.

**Prompt-free** (permissions doctrine). `NSWorkspace.frontmostApplication` and `CGWindowListCopyWindowInfo` need no authorization; the window list's only TCC-gated field is `kCGWindowName` (the window TITLE, silently redacted without Screen Recording, never prompted for) and the guard reads owner pid, owner NAME and bounds, none of which are gated. The hit tests ride the Accessibility grant the vector already requires.

---

## 2. Why occlusion is tested TWICE — the measurement that shaped the design

The obvious implementation is the one the brief specified: walk `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)` front to back and demand that the topmost window containing the point be owned by Things.

**Measured on the maintainer's Mac, that refuses every gesture on every Mac.** The on-screen list carries, above every ordinary window:

```
16 L20 a1 pid82034 Dock [0,0 2056x1329]      <- the whole display, alpha 1
```

The Dock owns a **full-screen window at layer 20**, alpha 1, and it is not a desktop element, so `kCGWindowListExcludeDesktopElements` keeps it. It is mouse-transparent, and the window list exposes no field that says so. The same window exists on the headless guest (`Dock [0,0 1024x768]`, layer 20). A naive topmost test names "Dock" at every point on the screen.

So the AUTHORITATIVE test is the window server's own hit test — `AXUIElementCopyElementAtPosition` on the system-wide element, plus `AXUIElementGetPid`. Measured through that same Dock window, on the maintainer's host:

| point | naive topmost (any layer) | banded topmost | system-wide hit test |
|---|---|---|---|
| over a Ghostty window | Dock | **Ghostty** | **Ghostty**, `AXTextArea` |
| over the real dock strip | Dock | (nothing) | **Dock**, `AXDockItem` |

The hit test respects z-order **and** mouse-transparency, which the raw window list cannot.

**The window scan is kept beside it with ONE named exemption — windows owned by the Dock — and NOT a layer band.** The first cut banded the scan to `kCGWindowLayer <= 0`, and cell B3 convicted that: an ordinary floating palette sits at layer 3, and the band made the scan blind to exactly the occluder class the guard exists for. With the Dock exemption instead, the scan names it (§4 B3).

**Both must agree.** The scan is asked first, because it is the leg that can NAME the culprit — cell B3 measured a case where the hit test resolves *nothing* (a foreign window whose owner has no accessibility tree) while the window list names the owner outright. Asking the hit test first threw that name away and refused with "nothing on screen answered", which is true and useless.

---

## 3. The cost

Measured on the 174-row fixture, on the guest (which is ~25x faster per AX round-trip than the maintainer's M1 — SBCHV1):

| measurement | value |
|---|---|
| `ptrGuard` alone, two endpoints, no identity leg (10 runs) | **4.3–4.8 ms, 14 counted reads per guard** |
| the whole `sidebar-drag` script's guard (2 endpoints + identity + drop-time re-check) | **28–38 ms, 52 reads** |
| the `sidebar-chevron` script's guard, inside a 1,828 ms step | **10–22 ms, 12–38 reads** |
| a refusal on the frontmost leg (short-circuits before any AX work) | **1 ms, 1 read** |

For scale: the census that same chevron step opens with costs 786 ms and scans 174 rows. The guard is a rounding error, and the cheapest refusals cost nothing at all. The counter is reported by the scripts themselves (`DONE ptrgd1=<n>ops/<n>ms`, and `ms.guard`/`ms.guardOps` in the chevron's own stage split), so the field can price it on the maintainer's host without a probe.

---

## 4. The cells

All verdicts below are from the certification pass; the driver is idempotent and was run four times over the campaign (the first three convicted the design decisions recorded in §2 and §5).

### A — baseline: the guarded reorder still works

The shipped `sidebar-drag` script, run alone against the fixture: `DONE ptrgd1=52ops/31ms`, the area order changed exactly as aimed, the assignment digest unchanged.

The FIELD-SHAPED path — `things area reorder <area> --first --dangerously-drive-gui` through the CLI, `experimental-area-reorder` on:

```json
{"ok":true,"kind":"mutation-result","data":{"op":"area.reorder","vector":"ui","tier":3,
 "steps":["bring Things to the foreground (the pointer must reach the sidebar)",
          "drag the area \"Mu\" to the top of the area list (moved with one drag (source and destination shared a viewport))"]},
 "meta":{"dbVersion":27,"fingerprint":"ok","elapsedMs":5532}}
```

The chevron script, also guarded, reports its own split: `{"clicked":true,"ms":{"sidebar":670,"rows":483,"rowsScanned":174,"chevron":3,"guard":11,"guardOps":35,"click":672,"total":1828}}`.

### B — a foreign window over the grab point

TextEdit opened and its window parked over the sidebar band, TextEdit left frontmost (opening a window and leaving it in front is one gesture in the field, not two).

Legs at the grab point: `L1_isThings: false`, `L3_topBanded: TextEdit`, `L3_hitPid: TextEdit`, chain `AXTextArea < AXScrollArea < AXWindow < AXApplication` — i.e. the occlusion leg would have refused on its own; the frontmost leg simply gets there first.

> `refused to drag the area row: TextEdit is frontmost, not Things — a pointer gesture goes to whatever owns the screen, so nothing was posted`

Sidebar order unchanged. TextEdit's document text empty and its `AXSelectedText` empty — nothing was dragged or selected in it.

### B2 — the legs, isolated

Things re-activated, the same point:

- **control** (Things frontmost, point inside the sidebar): `L1_isThings: true`, `L2_contains: true`, `L3_topBanded: Things`, `L3_hitPid: Things`, chain `AXUnknown < AXCell < AXRow < AXTable < AXScrollArea < AXWindow < AXApplication` with the `AXRow` frame `{40,435,240,24}`, `sentence_drag: null` — every leg passes and the guard says nothing.
- **positive** (Things frontmost, point over TextEdit's still-visible corner): outside Things' window, refused by the containment leg.

### B3 — a REAL above-Things occluder, with Things FRONTMOST

This is the cell that isolates occlusion from frontmost-ness, and it needed a surface that can sit above the frontmost application's own window. Neither obvious candidate works:

- **the Dock** owns one full-screen mouse-transparent window and no separate strip on a headless clone (§2);
- **Stickies** — Note ▸ Float on Top — is unreachable from System Events on macOS 15.7.7: `process "Stickies"` exposes no `Note` menu (`-1728`), so the note never floats.

What works, and what the field case actually is, is an opaque borderless window at `NSFloatingWindowLevel` (3) — the level an ordinary always-on-top palette uses — put up by a JXA process under the ACCESSORY activation policy so it never takes the front ([`ptrgd1-panel.jxa.js`](../../lab/scripts/ptrgd1-panel.jxa.js); it self-terminates and lives only inside the disposable clone).

Legs at the grab point, **Things frontmost** and the panel over it:

```
L1_isThings   : true                      <- Things IS in front
L2_contains   : true                      <- the point IS inside Things' window
L3_topBanded  : { pid: 1778, name: "osascript" }   <- the scan names the occluder
L3_hitPid     : null                      <- the hit test resolves NOTHING
```

> `refused to drag the area row: "osascript" owns the screen at (208, 503), not Things — a pointer gesture goes to whatever is under it, so nothing was posted`

and the chevron, from its own guard stage:

> `refused to click the disclosure arrow: "osascript" owns the screen at (254, 503), not Things — a pointer gesture goes to whatever is under it, so nothing was posted`

Order unchanged, assignment digest unchanged. **Then the cover is removed and the SAME drag runs again: `DONE ptrgd1=52ops/31ms`, and the order moves.** The guard is a gate, not a wall.

**Two findings this cell produced**, both folded back into the code before certification:

1. **`L3_hitPid: null`.** The system-wide hit test cannot resolve an element over a window whose owning process has no accessibility tree. It fails CLOSED, which is the right direction — but on its own it can only say "nothing answered".
2. **The layer band was wrong.** The first cut banded the window scan to `kCGWindowLayer <= 0` and would have reported `Things` here, i.e. would have PASSED the gesture into the panel. The scan is now Dock-exempt rather than layer-banded, and the legs are ordered scan-first so the sentence names the culprit.

### C — Things not frontmost

TextEdit moved off to the side (covering nothing) and activated. All three sidebar pointer primitives refuse, each in its own reporting shape:

- drag: `REFUSED {"refused":true,"why":"refused to drag the area row: TextEdit is frontmost, not Things — a pointer gesture goes to whatever owns the screen, so nothing was posted","ptrgd1":{"ops":1,"ms":1}}`
- chevron: `{"clicked":false,"reason":"ptrgd1-refused","why":"refused to click the disclosure arrow: TextEdit is frontmost, not Things — …","stage":"guard"}`
- wheel-scroll fallback: `execution error: Error: refused to scroll the sidebar with the wheel: TextEdit is frontmost, not Things — a pointer gesture goes to whatever owns the screen, so nothing was posted (-2700)`

Sidebar order unchanged.

### D — stale frames (the same-app class)

The drag script is compiled against a live snapshot; then, before it runs, the sidebar is scrolled **pointerlessly** through the scroll bar's own `AXValue` (SBSCR1): `{"ok":true,"axError":0,"wanted":0.45,"before":0,"after":0.45}`. The coordinates the drag holds now point at a different row.

> `refused to drag the area row: the sidebar row under the grab point is not the row this drag was planned against (the point sits in AXUnknown < AXCell < AXRow < AXTable < AXScrollArea < AXWindow < AXApplication), so the frames are stale — nothing was posted`

Guard cost on this path: 36 reads / 27–30 ms (the identity leg walks the chain). **Area order unchanged AND the assignment digest unchanged** — the second is the one that matters, because it is the invariant that would NOT have caught a to-do dragged into another list. Nothing was grabbed.

Every leg 1–3 passes here (Things frontmost, point inside, unoccluded, hit test says Things). Only the identity leg refuses, which is exactly the class it was added for.

### E — the drop-time re-check

The occluder covers the sidebar band from just below the grab row to the bottom of the viewport; the grab row itself is left clear. (An earlier pass covered only a spot at the *planned* drop point and the held drag, which re-resolves its boundary live, dropped somewhere else — a cell design error, not a guard failure, recorded here so it is not repeated.)

- **legs at the GRAB point:** every leg passes, `sentence_drag: null`.
- **legs at the DROP point:** the scan names the occluder, refusal sentence produced.
- **E1 — the plain drag** pre-checks BOTH endpoints, so it never presses: `REFUSED {…}`; order and digest unchanged.
- **E2 — the held drag** pre-checks the GRAB only, and computes its drop point mid-gesture: this is the drop-time re-check firing on a LIVE gesture — `{"aborted":true,"why":"refused to drop the area row: …"}`, Escape posted while held, order and digest unchanged.
- cover removed, the same held drag lands.

### F — the Repeat dialog's `click-point`

The dialog is opened the way the recipe reveals it (`things:///show?id=` then `Items ▸ Repeat…`, the menu item found by INDEX from the live menu — its title ends in a real U+2026 and the literal does not survive the ssh quoting round-trip) and left standing, so nothing races a live drive.

With nothing over the Cancel button, the legs pass. With the panel over it, `jxaClickScript` refuses, **the dialog is left standing**, and nothing is typed or clicked into the panel. Cover removed, the same `click-point` lands on Cancel and the sheet closes; the subject is still non-repeating. A dialog reopened and left standing is then cleared by the normal rung (`things rescue dismiss --dangerously-dismiss-dialog`).

**F2, and a finding worth recording.** Driving `todo make-repeating --frequency daily --interval 1 --dangerously-drive-gui` through the normal CLI with a panel over the WHOLE Things window **succeeds** (`ok:true`, tier 3, ~3.4 s). That is correct, not a gap: a to-do Repeat drive addresses every dialog control by ELEMENT — `AXPress` and `set-value` through System Events — and element-addressed automation is unaffected by what is drawn on top of it (and is HARDEN1's `element-addressed hops pass straight through` by design). The recipe's only pointer hops are the Cancel rung's fallback (F1, guarded) and the PROJECT verbs' repeat-bar popover (`click-element`, which compiles to the same guarded `click-point`). Anyone auditing this vector should know that covering the window is not a way to test it.

---

## 5. What this campaign changed in the design, and why

| the first cut | what convicted it | what shipped |
|---|---|---|
| window scan banded to `kCGWindowLayer <= 0` | B3: an ordinary floating palette is layer 3; the band reported `Things` and would have passed the gesture into it | the scan counts every layer, with ONE named exemption — Dock-owned windows — because the Dock's full-screen backstop is mouse-transparent and universal (§2) |
| hit test asked before the window scan | B3: over a window whose owner has no AX tree the hit test resolves nothing, so the refusal read "nothing on screen answered" while the scan knew the name | the scan is asked first and names the culprit; the hit test remains authoritative for transparency and z-order |
| `abortPartial`'s Escape assumed unguarded | reading `guardedRun`: `primitive: "key"` is in `KEYSTROKE_CLASS`, so the folded census already sits in front of that script | left alone, with a comment naming why the primitive must stay `key` |

---

## 6. The regression lock

`test/unit/pointer-gesture-guard.test.ts`, two locks that are hard to escape together:

1. **the census** — every line in `src/write/vectors/**` matching `kCGHIDEventTap`, `CGEventCreateMouseEvent`, `CGEventCreateScrollWheelEvent` or `postHID(` is enumerated from the SOURCE (comments stripped), mapped to its enclosing TypeScript declaration, and checked against a pinned allowlist. A new gesture in a new function fails with a message saying what to do. The allowlist is also checked for staleness, so an entry cannot outlive its site.
2. **the render** — every one of those builders is called and its output must carry a `ptrGuard(` invocation, positioned after the guard block's sentinel and before the first posting call, with the refusal branch present. A guard that is compiled in but never invoked passes lock 1 and fails this one.

Plus: the pointer scripts are now in the shared UI script catalog (`test/unit/helpers/ui-script-catalog.ts`), so `osacompile` parses every one of them on every `npm run check` and the deputy broker-safety suite (#695) scans them for banned phrases. The guard reaches all of its verdicts through the ObjC bridge and System Events — it shells out nowhere, so it is brokerable.

The keyboard tap is deliberately out of scope: `CGEventPostToPid` (`ui-chord.ts`) addresses a PROCESS rather than the screen, which is why HARDEN1 left it unguarded, and the census's marker set excludes it by construction.

---

## 7. What remains

- **The refusal's error CLASS.** A guard refusal surfaces through the drag driver's existing failure path, which the standing AXDRAG5/SBRES1 item says maps pre-flight refusals onto `verify-failed:silent-noop` ("transport failed") rather than a `blocked`-family refusal. The SENTENCE is now right and rides all the way to the caller; the class is the open item already queued in [up-next.md](../up-next.md), and this change adds one more producer to it.
- **A real-display arm.** Everything here is a headless clone. The release gate's real-display leg (`docs/reference/release-checklist.md`) is where the guard meets actual window-server compositing, a Dock that is visible rather than auto-hidden, and Stage Manager / multiple Spaces — none of which a `--no-graphics` guest reproduces.
- **A deputy-ROUTED arm.** Certified here by DIRECT execution. The guard shells out nowhere and the broker-safety suite covers the catalog, but the routed arm of the gate is still the maintainer's-host smoke until helpers-in-the-guest exists ([up-next.md](../up-next.md)).
- **Notification banners** were not exercised. They are a layer-25 window owned by `NotificationCenter` with a real AX tree, so both occlusion legs should name them; unmeasured.
