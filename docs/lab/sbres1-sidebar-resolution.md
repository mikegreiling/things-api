# SBRES1 — "the sidebar did not resolve": the locator, the state matrix, and the snapshot re-cut

**Probed under: `things-lab-golden-v4` · Things **3.23** (build 32300036) **and, in-clone, 3.23.1** (build 32301002) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`sbres1-lab`), upgraded in place to 3.23.1 for the parity arm, destroyed at the end. All fixtures synthetic. Driver: [`lab/scripts/research-sbres1.sh`](../../lab/scripts/research-sbres1.sh) + [`lab/scripts/sbres1-probe.jxa.js`](../../lab/scripts/sbres1-probe.jxa.js):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-sbres1.sh setup   # clone + boot + airgap + clock pin + shipped bundle
                                                            … seed        # 14 areas / 43 projects / an 85-row sidebar + a 400-item content list
                                                            … anatomy     # the AX tree above the sidebar table, at five geometries
                                                            … matrix      # every sidebar-state lever and the constraint it imposes
                                                            … cost        # where the 30s step budget goes
                                                            … certify     # the fixed driver against every measured state
                                                            … upgrade     # Things 3.23.1 INTO THE CLONE (the goldens are never touched)
                                                            … teardown
# focused cells
bash lab/scripts/sbres1-walkdepth.sh     # how deep the per-row text walk must go
bash lab/scripts/sbres1-deptheq.sh       # certify the batched harvest against the CONSUMER contract
bash lab/scripts/sbres1-phases.sh        # where the NEW snapshot's wall clock goes
bash lab/scripts/sbres1-snapcost.sh      # the shipped snapshot's wall clock, N runs
bash lab/scripts/sbres1-baseline.sh      # the osascript hop floor
bash lab/scripts/sbres1-multiwindow.sh   # a genuine second main window
bash lab/scripts/sbres1-widecert.sh      # the field bug, isolated
bash lab/scripts/sbres1-errors.sh        # message truthfulness after the fix
```

**Why.** Two field reports, two CLI versions, one machine, one message. `things area reorder <A> --first --dangerously-drive-gui` completed its `activate` step and then died with

> the sidebar did not resolve (is the window open and the sidebar visible?)

on a host where the maintainer confirmed Things was foreground with the sidebar plainly visible — under **0.19.4-dev** ([#651](https://github.com/mikegreiling/things-api/issues/651), 33.5 s, Things 3.23.1 / macOS 15.7.4) and again under **0.20.1** ([#665](https://github.com/mikegreiling/things-api/issues/665), repeatedly, including after a `rescue relaunch`). The same code had succeeded on the primary host days earlier.

---

## The answers, in one table

| Cell | Question | Verdict |
|---|---|---|
| **anatomy / matrix** | is the locator geometry-keyed? | **YES — H1 CONVICTED.** The sidebar is identified as *"the narrowest `AXTable` under 400pt"*. The divider drags to **at least 790pt**, and at any width ≥ 400 the locator returns **nothing** — reproducing the field message verbatim, instantly, on a fully visible sidebar. |
| **cost** | is the 30 s cliff the row walk? | **PARTLY — H2 is real but secondary.** One shipped snapshot = **~9,000 AX round-trips / 3.4–4.9 s** on an 85-row sidebar, of which **~55 % is the locator re-walking the whole window twice**. |
| **cost** | does the CONTENT view or `AXEnhancedUserInterface` drive it? | **NO — H4 REFUTED, both arms.** Things virtualizes the content list (a 400-item project exposes **1** AX row; Anytime, 27), and the flag changed nothing measurable. The lab was not hiding anything. |
| **upgrade** | does 3.23.1 expose a different tree? | **NO — H3 REFUTED.** Byte-for-byte the same shape, the same laws, all six certification cells green and *faster*. |
| **matrix** | can the sidebar be hidden, and what does the tree do? | **YES, and the tree LIES.** `View ▸ Hide Sidebar` (⌘/) leaves the sidebar in the AX tree with its old frame while the content pane slides over it. The old driver "resolved" a hidden sidebar and dragged at coordinates that had become the content list. |
| **matrix** | multiple windows? | **YES** (`File ▸ New Things Window`), each with its own sidebar and its own visibility. Exactly one window carries `AXMain`; `AXFocused` is false on all of them. |
| **certify** | does the fix hold across every measured state? | **YES.** Six states × two Things versions, every move landed, every invariant PASS. |

---

## §1 — the fixture (synthetic)

Fourteen areas (twelve seeded plus the golden's two), 43 projects, **85 sidebar rows** — the field shape. Plus a deliberate second variable no prior campaign varied: **`BIGLIST`, a project holding 400 to-dos**, so the content list could be made large independently of the sidebar.

## §2 — anatomy: what is actually above the sidebar table

The Things main window is **FLAT**. There is no `AXSplitGroup` and no `AXSplitter`: the sidebar and the content list are **sibling `AXScrollArea`s directly under the window**, and the divider is an `AXImage` described `"MainWindowSidebarResizeHandle "` (trailing space in the app's own string).

```
win AXWindow/AXStandardWindow [44,25 980x687] title="Today" id="MainWindow-B39F385F-…"  children=29
  win.1  AXScrollArea [284,63 740x613]        ← the CONTENT pane
    win.1.1 AXTable   [283,88 742x542]  12 rows
  win.9  AXScrollArea [44,63 240x613]         ← the SIDEBAR pane
    win.9.1 AXTable   [43,79 242x1899] 84 rows      (full height — rows virtualize their frames, AXDRAG1)
    win.9.2 AXScrollBar [267,62 18x615]             ← a DIRECT child
  win.15 AXImage desc="MainWindowSidebarResizeHandle "
```

Three more things live in the application element's `AXChildren` beside the real window, and all three have bitten something:

| Node | What it is | Who it bit |
|---|---|---|
| `AXWindow/AXUnknown` **40×40** at `[0,728]`, no children | a placeholder Things always keeps | the shipped `stdWindow()` falls back to `ws[0]` when no `AXStandardWindow` is found — i.e. to this |
| `AXMenuBar` | the app's menu bar | it is a "window" as far as `AXChildren` is concerned |
| — | — | **System Events' `window 1` IS the placeholder**, with `scrollAreas = 0`: any positionally-addressed bulk read aims at the wrong window (§6) |

## §3 — THE FIELD BUG: the locator is a width threshold

```js
function sidebarTable(){ … var tables=findAll(w,'AXTable',12,[]); var best=null;
  for(…){ var f=frame(tables[i]); if(f.w<400){ if(!best||f.w<best.f.w) best={…} } }
  return best?best.el:null }
```

The viewport was found the same way (*the first `AXScrollArea` with `w < 400`*). Dragging the resize handle, measured:

| sidebar viewport | shipped locator |
|---|---|
| 190pt (the **minimum** — five further −40 drags were no-ops) | resolves |
| 230 / 310 / 390 | resolves |
| **430** | **`table: null`, `viewport: null`, `rows: 0`** |
| **610 / 790** | **nothing** |

Widening the sidebar grows the WINDOW rather than shrinking the content pane, so there is no natural stop: the handle went to 790pt and would have gone further. **A user who prefers a wide sidebar can never run `area reorder` — and the message they get tells them to check whether the sidebar is open.** Driven end to end through the shipped CLI at a 610pt sidebar:

```
verify-failed:silent-noop after 8s
  "the sidebar did not resolve (is the window open and the sidebar visible?).
   No sidebar change was left behind."
```

The field message, verbatim, at a geometry the user would describe as "the sidebar is visible".

## §4 — the state matrix: every lever, and the constraint it imposes

| Lever | How | Measured law | Constraint on the driver |
|---|---|---|---|
| **Hide the sidebar** | `View ▸ Hide Sidebar`, **⌘/**; the item is a TOGGLE (its title flips to `Show Sidebar`) | The sidebar scroll area **stays in the tree with its old frame** (190×566); the content pane moves to the same origin, so the two panes **overlap horizontally by exactly the sidebar's width**. `AXHidden` / `AXEnabled` / `AXFocused` are empty or false in BOTH states — **no attribute marks it** | The overlap IS the signature. Without it the driver drags at a phantom frame (measured: 27 s, `verify-failed:silent-noop`, *"could not scroll the area's row into view"* — a wrong message, and a gesture into the content list) |
| **Resize the sidebar** | drag the `AXImage` `"MainWindowSidebarResizeHandle "` | **min 190pt**, **max ≥ 790pt** (the window grows to accommodate); row exposure and drag targets are unaffected at every width | No width may appear in the locator (§3). Nothing needs normalizing — every width works once the locator is structural |
| **Multiple windows** | `File ▸ New Things Window` | Each main window has its **own sidebar** (all 85 rows) and its **own** visibility state — hiding in one leaves the other alone. Exactly one carries **`AXMain = true`**; `AXFocused` is **false on all of them** | Pick by `AXMain`, never by position in `AXChildren`. HID synthesis lands on the front window, so this is the only correct choice |
| **Window size** | System Events `set size` | Things clamps its own floor at **590×400**; requests below that are ignored. At the floor the sidebar viewport is still 326pt with all rows exposed | Nothing to normalize — the app enforces a usable minimum. The tall-section wall (AXDRAG5/SBCOL1) remains the real geometric limit, and its collapse rung still applies |
| **Full screen** | `View ▸ Enter Full Screen` (⌃⌘F) | Sidebar present, leftmost, no overlap, locator resolves; only the toolbar buttons disappear | None |

## §5 — cost: where the 30-second budget went

Wall clock and **AX round-trip counts** for one shipped `sidebar-snapshot`, 85-row sidebar, measured inside the clone:

| Phase | ms | AX calls |
|---|---:|---:|
| `sidebarTable()` — `findAll(window,'AXTable',12)` | 785–1,496 | 1,892–2,796 |
| `viewport` — `findAll(window,'AXScrollArea',12)` (a SECOND full walk) | 817–1,554 | 1,892–2,838 |
| the per-row text walk (depth 6, 4 single-attribute reads per node) | 1,478–1,823 | 3,376–3,618 |
| **total** | **3.1–4.9 s** | **~9,000** |

**More than half the cost was finding the sidebar, twice.** And it is not paid once: the ladder takes one snapshot per hop plus up to `MAX_SCROLL_ITER = 18` per `scrollUntil`, two of those per hop.

**H4, tested and refuted.** The suspicion was that `findAll` over the whole window made the cost scale with the user's CONTENT list, and that the lab's habit of clearing `AXEnhancedUserInterface` was hiding it. Neither holds:

| content view | `AXEnhancedUserInterface` | content rows exposed | snapshot |
|---|---|---:|---:|
| a small area (Kappa) | off / on | 4 | 3.68 s / 3.85 s |
| the 400-item `BIGLIST` project | off / on | **1** | 4.16 s / 3.75 s |
| Anytime (everything) | off / on | 27 | 4.95 s / 4.44 s |

Things **virtualizes the content list** — a 400-item project exposes one AX row — while the SIDEBAR exposes every row including the off-viewport ones (AXDRAG1, reconfirmed). So the cost tracks the sidebar, not the data, and the flag is irrelevant. This is app craft, not an app bug: see [things-app-craft](../things-app-craft.md).

## §6 — the re-cut, measured three ways

### The row walk: one batched round-trip per node

`AXUIElementCopyMultipleAttributeValues` fetches `AXValue`, `AXDescription`, `AXTitle`, `AXChildren`, `AXPosition`, `AXSize` and `AXRole` in **one** call instead of six or seven:

| harvest | ms | AX calls | spacer rows agree | area-title matches agree | byte-identical |
|---|---:|---:|---|---|---|
| shipped: depth-6, single-attribute | 1,675 | 3,376 | — | — | — |
| batched depth-2 | **197** | **235** | ✅ | ✅ | no |
| batched depth-3 | 564 | 738 | ✅ | ✅ | no |
| batched depth-4/5/6 | 600–694 | 844 | ✅ | ✅ | **yes** |

The certification is against the **consumer contract**, not the string: the driver reads a row's text in exactly two ways — `text === ''` (spacer detection) and an exact `|`-segment match against a known area title — and every depth from 2 up agrees with the old walk on both, for all 85 rows and all 14 titles. Depth 4 and up is additionally byte-identical, so nothing above depth 4 exists to lose. **Shipped: depth 2 on the fast path, with an automatic escalation to depth 6 whenever fewer area titles match than the database holds** (every area always renders a row, so that count is a sound oracle).

> **Gotcha, measured.** The attribute-name array MUST be built as `$(['AXValue', …])`. `$.NSArray.arrayWithArray([$('AXValue'), …])` compiles, returns `AXError 0`, and fills every slot with `kAXErrorNoValue (-25212)` — a silent, total blank that reads exactly like an app that exposes nothing.

### The locator: structural + semantic, never geometric

Candidates are collected by a walk that **stops at every list container and never enters a row**, so its cost is a function of the window's chrome rather than of the user's data — **125 AX calls / 14–20 ms**, against the old pair of full walks at ~4,700 calls / ~1.8–3.0 s. The sidebar is then picked as *the candidate whose rows carry the caller's own area titles*, which is what a sidebar **is**. Ties refuse; a zero match refuses and names what was searched.

### The System Events bulk route, priced

The maintainer's proposal — one addressed Apple event building parallel lists — was measured: **840 ms for 4 Apple events**, and it returns only the grandchild-description layer (the depth-2 equivalent). It also **cannot be addressed without an ordinal**, and the ordinal is wrong: System Events' `window 1` of Things is the 40×40 placeholder with zero scroll areas, so the first attempt died with `Invalid index`. The AX-API batch matches its speed, keeps full fidelity, and needs no positional address, so that is what shipped.

### The result

| | shipped 0.20.1 | after |
|---|---:|---:|
| snapshot wall clock (85-row sidebar) | **3.68 s** | **0.75 s** |
| AX round-trips per snapshot | ~9,000 | **~430** |
| in-script AX time | ~3.3 s | **272 ms** |
| an `area reorder --first` end to end | 22–48 s | 12–29 s |

Phase breakdown of the new snapshot: window `49 ms / 3 calls` · list-pane walk `18 ms / 125 calls` · content-pane harvest `23 ms / 63 calls` · sidebar harvest `182 ms / 240 calls`. The remaining ~0.4 s of the 0.75 s is **per-hop `osascript` overhead** (the bare floor for an `osascript -l JavaScript` hop that imports the frameworks and resolves Things' pid is 70 ms; the rest is process and bridge setup that every primitive pays). **That is now the dominant term**: further gains need FEWER HOPS, not a cheaper walk — an AX snapshot inside the helper daemon would collapse it, and is worth doing only if 0.75 s ever becomes a problem. At a 30 s step budget it is 40× headroom, so no escalation is proposed.

> One full-subtree walk survived the first draft and cost 0.4 s of the 1.16 s that draft measured: the scroll fraction was read with `findAll(scrollArea,'AXScrollBar',4)`, which descends through the table and every row. The scroll bar is a **direct child**. Enumerations hide in the places nobody profiles.

## §7 — certification, in-clone, both versions

Every state §4 found, driven end to end through the SHIPPED CLI, database asserted before and after:

| Cell | 3.23 | 3.23.1 | invariants |
|---|---|---|---|
| control (ordinary visible sidebar) | ok, 22 s | ok, 14 s | PASS |
| **a sidebar past 400pt** (the field bug) | **ok, 25–29 s** | ok, 12 s | PASS |
| **a hidden sidebar** (normalization rung) | **ok, 27 s — and hidden again afterwards** | ok, 15 s — restored | PASS |
| two main windows (the `AXMain` rule) | ok, 24 s | ok, 16 s | PASS |
| full screen | ok, 16 s | ok, 12 s | PASS |
| the SBCOL1 collapse rung (tall section, 935×420) | ok, 48 s | ok, 20 s | PASS |

Message truthfulness after the fix, for the one cause that cannot be normalized away:

```
no Things window open (⌘W):  2s   (was: 30s+)
  "Things is running but has no open window — only the placeholder it keeps in
   the background. Open the Things window (click its Dock icon) and re-run.
   No sidebar change was left behind."
  order unchanged: PASS
```

## App laws filed

- [oddities §30 — hiding the sidebar leaves it in the Accessibility tree](../things-app-oddities.md), overlapping the content pane, with no attribute to distinguish the two states; plus the 40×40 placeholder window that makes System Events' `window 1` the wrong window.
- [craft — the content list virtualizes, the sidebar does not](../things-app-craft.md): a 400-item project exposes one AX row, so an automation's cost tracks the sidebar rather than the user's data.

## What remains

- **On-device confirmation.** The whole matrix is certified in-clone on both 3.23 and 3.23.1; the maintainer's own re-run of the original `#665` command on the second machine is the real-hardware confirmation ([ui-certification-runbook](ui-certification-runbook.md)).
- **The error CLASS, not its copy.** A pre-flight refusal still surfaces as `verify-failed:silent-noop` / "transport failed" even though zero gestures ran — the AXDRAG5 residue (a) already on the queue. The *words* are honest now; the code is not yet.
- **Rung 2 stays dark**, unchanged by any of this (oddities §9).
