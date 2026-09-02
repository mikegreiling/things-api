# VOPAT1 — read like a screen reader: hit-tests, visible sets, sparse content, and observer-driven settles (#676)

**Probed under:** `things-lab-golden-v4` · Things **3.23** (build 32300036) · macOS **15.7.7** (24G720) · DB v27 · clock pinned 2026-07-05 (trial wall 2026-07-18, never approached) · airgapped clone, destroyed at teardown · fixture 100 % synthetic (14 areas / 174 sidebar rows / 240×346 pt viewport — the #676 field shape exactly).

Driver: [`lab/scripts/research-vopat1.sh`](../../lab/scripts/research-vopat1.sh) (`setup` · `reship` · `seed` · `topup` · `shape` · `hittest` · `visset` · `notify` · `sheet` · `settle` · `teardown`) · measurement rig [`lab/scripts/vopat1-helper.jxa.js`](../../lab/scripts/vopat1-helper.jxa.js) · notification rig [`lab/scripts/vopat1-observer.py`](../../lab/scripts/vopat1-observer.py) · field instrument [`lab/scripts/field-probe-sidebar.jxa.js`](../../lab/scripts/field-probe-sidebar.jxa.js) cells 9–11.

**PROBE ONLY.** Nothing in `src/` changed. The redesign this campaign specifies (§8) is its own build campaign.

---

## The question

The maintainer's observation, and it is the right one: **our drivers read Things like a web crawler.** They SWEEP — harvesting the content of all 174 sidebar rows to find one — and they POLL, re-reading a surface until two reads agree. A screen reader does neither. VoiceOver reads one element on demand, asks a table for its VISIBLE set rather than its contents, is TOLD by a notification when something changed, and hit-tests a point to find what is under it.

Under the **field law** ([#676](https://github.com/mikegreiling/things-api/issues/676), measured on the maintainer's M1, 2026-09-02) that difference is the whole cost of the operation:

| | field (M1, Retina) | this lab |
|---|---:|---:|
| one AX round-trip (IPC) | 0.12 ms JXA / 0.05 ms native | ~0.13 ms |
| one **row realized** on content access | **~115 ms**, paid again on every sweep | 0.53 ms |
| geometry: `AXRows` + a frame per row, 174 rows | ~2 ms | 44–48 ms |

So the metric that transfers between hosts is neither wall time nor call count. It is **ROWS REALIZED** — the number of distinct elements whose content this code touched. Every cell below leads with it.

> **Reproducibility, stated plainly.** The lab is ~200× cheaper per row realized than the field, because a headless VM has no Retina display to realize a custom row view onto. **Lab wall times must never be extrapolated.** What this campaign measures is what each strategy COSTS IN ELEMENTS and WHAT THE APP ANNOUNCES — both of which are host-independent — and it ships the field-probe cells that price them on the maintainer's own machine.

---

## The answers, in one table

| Cell | Question | Verdict |
|---|---|---|
| **1 hittest** | does `AXUIElementCopyElementAtPosition` find a row? | **YES, and it is not worth using.** It reaches the row in 0.6–0.9 ms and confirms in one content read — but so does addressing the row by ordinal, for 7 fewer calls and without the band limit. Off-band it returns **AXError 0 and the wrong element**. |
| **2 visset** | `AXVisibleRows` or sparse? | **SPARSE.** `AXVisibleRows` is honest, cheap (44 calls / 16 rows) and **answers the wrong question** — it found 1 of 14 areas at the top boundary. The sparse read (geometry for all 174 + content on the 14 predicted rows) finds **14/14 while realizing 14 rows**. |
| **2d** | is ordinal addressing safe? | **YES.** `AXRows` and the table's `AXChildren` enumerate the same 174 rows in the same order, frames identical to **0.00 px**. |
| **3 notify** | do notifications replace the poll? | **YES, for every actuation we make.** Idle chatter is **zero**. A scroll announces `AXValueChanged` on the scroll bar in **6.5 ms**; a fold announces `AXRowCountChanged` ×65 on the table **62 ms after the click completes**; the Repeat sheet announces `AXSheetCreated`; a pop-up announces `AXMenuOpened` in **5 ms**; asking for focus announces `AXFocusedUIElementChanged` in **28 ms**; a keystroke into a focused field announces `AXValueChanged` in **79 ms**. |
| **3, silence** | which classes never fire? | `AXLayoutChanged` **never fired once, for any actuation** — including the cadence-group rebuild that tears down and re-creates nine controls. Nor did `AXCreated` for the rebuild. A settle may not wait on either. |
| **4 sheet** | minimum reads per recipe step? | **9 calls for the shell census, 4 for the cadence group, 1 for a single control by manifest path** — against 88 System Events round-trips for the whole drive today. |
| **5 rolecost** | does the ~115 ms/row law apply to sheet controls? | **The lab cannot tell you, and says so — but it rules out the role.** Every role reads in ~0.5 ms here (rows, checkboxes, pop-ups, fields alike). The discriminator is not the ROLE, it is whether the element's view must be REALIZED. §7 reconciles this with RDLAT2. |

---

## §1 — the fixture

14 areas (12 seeded + the golden's 2), 96 projects, **174 sidebar table rows** — the field's count exactly — in a 240 × 346 pt viewport, with one section (`Theta`, 65 rows) taller than any window. The shipped locator resolves it 14/14 at depth 2.

```
{"ok":true,"rows":174,"hits":14,"titles":14,
 "viewport":{"x":44,"y":63,"w":240,"h":346},"scroll":0,
 "axCalls":874,"realized":186}
```

`realized: 186` rather than 174 is the shipped locator's own shape, and worth noticing before anything else: `resolveSidebar` harvests **every candidate list pane**, so it realizes the 12 content-pane rows on the way past. Twelve rows of collateral is 1.4 seconds on the field host, spent to find out which pane is which.

DB-predicted area-row ordinals for this fixture: `13,16,81,88,92,94,99,105,107,109,117,119,121,123`.

---

## §2 — CELL 1: the hit-test works, and loses to arithmetic

Three routes to the same task — *find area X's row* — measured back to back on the same live table, three runs each.

**(A) the target is DRAWN** (ordinal 13, centre inside the band):

| route | AX calls | **rows realized** | lab ms | outcome |
|---|---:|---:|---:|---|
| **a** the shipped full sweep (`resolveSidebar`, depth 2) | 870 | **186** | 666 / 666 / 747 | row found |
| **b** geometry + hit-test + walk up + one content read | 359 | **1** | 48 / 50 / 48 | row found, title confirmed |
| **c** geometry + ONE content read at the predicted ordinal | 352 | **1** | 45 / 48 / 48 | row found, title confirmed |

The hit-test itself is cheap and it works: `AXUIElementCopyElementAtPosition(app, x, y)` returns **AXError 0 in 0.6–0.9 ms**, lands on an `AXUnknown` inside the row, and **two `AXParent` hops** reach the `AXRow`. One `AXUIElementCopyMultipleAttributeValues` on that row then confirms the title.

The geometry pass underneath both b and c — `AXRows` plus `AXPosition`/`AXSize` per row — is **349 calls / 44–48 ms for 174 rows** here, and ~2 ms in the field. It realizes nothing.

**(B) the target is OFF-SCREEN** (ordinal 16, whose centre sits 15 pt below the fold):

| route | rows realized | outcome |
|---|---:|---|
| **b** hit-test | 0 | **AXError 0**, `hitRole: "AXWindow"`, `reachedRow: false` |
| **c** ordinal | **1** | row found, title confirmed, `rowY` matches the geometry pass |

**LAW (VOPAT1-1).** *A hit-test answers about a PIXEL, not about a row.* Asked about a point the sidebar does not draw, `AXUIElementCopyElementAtPosition` does not fail — it succeeds and hands back whatever owns that point (here the window; in an earlier run, with the point outside the window, the menu bar). Any use of it must be guarded by a visible-band check, and the guard is the caller's job because the API will not raise one.

**LAW (VOPAT1-2).** *The hit-test buys addressing convenience, not cost.* Route c reaches the same row for **7 fewer AX calls**, realizes the same single row, and is not band-limited — so it works for the off-screen rows that are precisely the ones `area reorder` has to find. **The redesign does not need hit-testing.** (Recorded because the campaign was commissioned to test it: the answer is that it works and is the wrong tool.)

---

## §3 — CELL 2: the visible set answers the wrong question; the sparse read answers the right one

Three read strategies for one snapshot, same table, at the top boundary (`scroll = 0`) and again mid-list (`scroll = 0.5`).

| strategy | AX calls | **rows realized** | lab ms | areas found |
|---|---:|---:|---:|---:|
| **a** full sweep of the table, depth 2 (what ships) | 507 | **174** | 520 / 520 | **14 / 14** |
| **b** `AXVisibleRows` + depth-2 harvest of just those | 44 | **16** | 26 | **1 / 14** |
| **c** sparse: geometry for all 174 + content on the 14 predicted ordinals | 391 (349 geometry) | **14** | 87 / 90 | **14 / 14** |

Mid-list, b realizes 17 rows and finds **4 / 14**. c is unchanged: 14 / 14, 14 realized.

**LAW (VOPAT1-3).** *`AXVisibleRows` is a fast path to what is DRAWN, and the sidebar snapshot's consumers do not want what is drawn.* Every consumer — tall-section detection, drop-boundary geometry, `scrollableSpan`, the area-order confirmation — needs rows the user cannot see. At the top boundary the bounded read finds **one of fourteen areas**. SBCHV1 §3 already flagged this as constraint (a); this measures its size. `AXVisibleRows` remains exactly right for *"what is on screen right now"* and exactly wrong as a snapshot.

**LAW (VOPAT1-4).** *The sparse read is not an approximation — it is the same answer for 12× fewer realizations.* 14 rows realized against 174, and all 14 area titles matched. On the field host that is **1.6 s against 20 s**, for the identical consumer output.

### The safety property the sparse read rests on

| check | measured |
|---|---|
| `AXRows` count | 174 |
| table `AXChildren` row count | 174 |
| same order by `y` | **yes** |
| max frame delta between the two enumerations | **0.00 px** |

**LAW (VOPAT1-5).** *`AXRows` and the table's `AXChildren` are the same list.* Ordinal addressing is therefore sound: a row predicted at index *n* by the database is the row at `AXRows[n]`. This is the precondition for every sparse strategy below, and it is re-checkable in one geometry pass that costs nothing.

---

## §4 — CELL 3: the app talks. We have never listened.

An `AXObserver` registered on the application element, the sidebar table and the scroll area, for fifteen notification classes; one actuation performed at a recorded `t0`; every arrival timestamped. (JXA cannot do this at all — `AXObserverCreate` takes a C function pointer, which the ObjC bridge will not marshal — so the rig is stdlib `ctypes`, the same transport the field probe already uses for its native-latency cell.)

**Every registration succeeded** (`AXError 0`, 23 of 23) on the app element, the `AXTable`, the `AXScrollArea` and, later, the `AXSheet` and the cadence `AXGroup`.

### 4.1 The sidebar

| # | actuation | what fired | first arrival | went SILENT |
|---|---|---|---:|---|
| a | **nothing**, observer armed 3 s | — | — | **all 15 classes** |
| b | scroll bar `AXValue := 0.5` | `AXValueChanged` ×1 on **AXScrollBar** | **6.5 ms** (the write itself took 6.4) | RowCountChanged, LayoutChanged, Moved, Resized, and ValueChanged on the table and scroll area |
| c | geometry-only scroll loop onto an off-screen row | — | — | (landed in **1 iteration**, 700 calls, **0 rows realized**, 365 ms) |
| d | chevron click → **collapse** | `AXValueChanged` ×3 (AXImage, AXScrollBar) · `AXUIElementDestroyed` ×64 · **`AXRowCountChanged` ×65 on the AXTable** | 439.9 / 463.8 / **502.3 ms** | LayoutChanged, Created, SelectedRowsChanged, Resized, Moved, FocusedUIElementChanged |
| d′ | chevron click → **expand** | `AXUIElementDestroyed` ×1 · **`AXRowCountChanged` ×65** · `AXValueChanged` ×2 | 469.8 / **511.3** / 515.4 ms | as above |

The click actuation itself takes **439.7 ms** — the certified rig timers (300 ms MOVED settle + 90 ms press + release, REPX1 §1.2). So the fold's row storm begins **~62 ms after the gesture completes**, and the whole 65-notification storm lands inside ~10 ms.

**LAW (VOPAT1-6).** *Things is silent when nothing happens.* Zero notifications in three idle seconds, across all fifteen classes. Every arrival is attributable to the actuation, so an observer-driven settle needs no noise filter — only a debounce.

**LAW (VOPAT1-7).** *A scroll's only observable is the scroll bar's own `AXValueChanged`.* The table announces nothing when its rows move: no `AXLayoutChanged`, no `AXMoved`, no `AXRowCountChanged`. A scroll settle must watch the scroll bar — which is exactly the element SBSCR1 already writes.

**LAW (VOPAT1-8).** *A disclosure fold announces itself, one `AXRowCountChanged` per row.* 65 notifications for a 65-row section, on the `AXTable`, arriving in a burst ~500 ms after the click began. A settle waits for the first and then for ~50 ms of quiet; it reads **nothing**. The shipped step re-censuses the whole sidebar to confirm the fold (SBCOL1) — 174 rows realized, 20 s on the field host — to learn a number the app volunteered.

**LAW (VOPAT1-9).** *The scroll loop needs no content at all.* Closing the loop on row frames alone (`AXRows` + `AXPosition`/`AXSize`) landed the off-screen wall row in **one iteration with zero rows realized**. The shipped ladder re-runs the full title-matching census on every iteration of the same loop — 186 rows realized per iteration, up to 18 iterations.

### 4.2 The Repeat sheet

| # | actuation | what fired | first arrival | went SILENT |
|---|---|---|---:|---|
| e | `Items ▸ Repeat…` (System Events click) | `AXFocusedUIElementChanged` · **`AXCreated` + `AXSheetCreated` on the AXSheet** · `AXValueChanged` ×4 | 220.4 / **581.3 · 581.6** / 582.9 ms | AXWindowCreated, **AXMenuOpened**, **AXMenuClosed**, AXLayoutChanged |
| f | frequency pop-up, `AXPress` | **`AXMenuOpened` on the AXMenu** | **5.1 ms** (the press took 1.0) | ValueChanged, LayoutChanged, Created, Destroyed |
| g | a menu item `AXPress`d — **the group rebuild** | FocusedUIElementChanged ×4 · ValueChanged (AXStaticText) · **AXMenuClosed** · **`AXValueChanged` on the AXPopUpButton** · **`AXUIElementDestroyed` ×3** · ValueChanged (AXStaticText) | 3.4 / 169.1 / 348.3 / **535.1** / **535.2** / 535.4 ms | **AXLayoutChanged**, **AXCreated**, RowCountChanged, Resized, Moved |
| h | `AXFocused := true` on the numeric field | **`AXFocusedUIElementChanged` on the AXTextField** | **27.6 ms** (the write took 27.4) | everything else |
| i | one digit typed into the **focused** field | ValueChanged (AXStaticText) · **`AXValueChanged` on the AXTextField** | 72.2 / **78.6 ms** | FocusedUIElementChanged, Layout, Created, Destroyed |
| j | one digit typed with focus **not** on a field | — | — | **everything** |

The sheet-open cell shelled out to `osascript`, and the rig reports the spawn separately: **143.9 ms of the 581.6 ms was the process launch**, so **the app's own time to present the sheet is ≈ 438 ms** — within 4 % of the 455 ms RDLAT2 measured for that hop by stopwatch.

The rebuild's shape change is visible in the same run, and re-proves HXPC1's law from the other side: the cadence group went from **3 controls** (after-completion) to **9** (daily), and the numeric field's child-index path moved from `[1,29,2,2]` to `[1,29,2,7]`.

**LAW (VOPAT1-10).** *The dialog's arrival is a notification, not a poll.* `AXSheetCreated` fires on the `AXSheet`. The drive's `dialog-open` hop can wait on it and read nothing until it arrives.

**LAW (VOPAT1-11).** *A pop-up's menu announces itself in 5 ms.* The shipped drive polls `exists menu item` once per 50 ms for this, and those polls are most of the 26 round-trips the two pop-up hops spend (RDLAT2 §3).

**LAW (VOPAT1-12) — the important negative.** *`AXLayoutChanged` never fired. Not once, for any actuation, on any element.* Not for the fold that destroyed 64 rows, not for the rebuild that tore down three controls and built nine. Neither did `AXCreated` for the rebuild. **There is no single "this container is rebuilt" notification**, so a settle cannot wait for one. What the rebuild *does* announce is `AXValueChanged` on the pop-up whose value the step set, and a burst of `AXUIElementDestroyed`, both at ~535 ms. That pair — *the control I set now reports the value I set, and the old children are gone* — is the observable, and it is a strictly better gate than "two reads of the group agreed", because agreement is also what a group that has not started changing looks like (RDLAT2 §7c).

**LAW (VOPAT1-13).** *Asking for focus is a closed loop.* `AXUIElementSetAttributeValue(field, AXFocused, true)` returns `AXError 0` and `AXFocusedUIElementChanged` arrives on the `AXTextField` **27.6 ms** later. RDLAT2 §7c's fix — *ask for focus, look, and retry on the next attempt* — becomes *ask for focus and wait to be told*, with no read at all.

**LAW (VOPAT1-14).** *A keystroke announces itself only if it lands.* Typed into the focused field, `AXValueChanged` arrives on that field in 79 ms and the value reads back correct. Typed with focus elsewhere, **nothing fires** — which makes the silence itself a usable signal: a typing step that hears no `AXValueChanged` within its budget knows the character went somewhere else, without reading anything to find out.

No rule was committed by any of this: the sheet was dismissed with Escape and the target to-do carries `rt1_recurrenceRule IS NULL` (count 0).

---

## §5 — CELL 4: the Repeat sheet, one element at a time

With the shape manifest supplying the path, what does a step actually have to read?

| read | AX calls | elements realized | lab ms |
|---|---:|---:|---:|
| the shell census — `AXChildren` + one `AXRole` per child, 8 controls | **9** | 0 | 2 |
| the cadence group's whole inventory — one batched node per control, 3 controls | **4** | 3 | 3 |
| **ONE control, addressed by manifest path** | **1** | 1 | **0.46** |
| locating the sheet from the window down (once) | — | — | 16 |

Shell roles, in tree order: `AXCheckBox, AXCheckBox, AXGroup, AXStaticText, AXPopUpButton, AXButton, AXButton, AXImage` — the census `src/write/vectors/ui-shape.ts` asserts, re-proven live.

For scale: the shipped `make-repeating --frequency monthly --interval 1 --after-completion` costs **13 osascript hops / 88 System Events round-trips** (RDLAT2 §5). The same information, read as raw `AXUIElement` calls against a manifest, is **9 + 4 + a handful** — and the two things that dominate those 88 round-trips (the menu-open poll and the cadence settle's repeated scans) become **zero reads**, because §4 shows both have notifications.

---

## §6 — CELL 5: content cost by role

Median of 60 batched content reads per element (one `AXUIElementCopyMultipleAttributeValues` for value + description + title + children + position + size + role — the shipped `node()`):

| element | median ms | p95 ms |
|---|---:|---:|
| sidebar `AXRow` | **0.48** | 0.58 |
| sidebar `AXScrollArea` | 0.58 | 0.82 |
| sidebar `AXTable` | **5.84** | 7.99 |
| sheet `AXCheckBox` | 0.63 | 2.38 |
| sheet `AXGroup` | 0.61 | 1.25 |
| sheet `AXStaticText` | 0.50 | 0.64 |
| sheet `AXPopUpButton` | 0.50 | 0.63 |
| sheet `AXButton` | 0.49 | 0.63 |
| sheet `AXImage` | 0.48 | 1.19 |
| `AXSheet` | 0.86 | 2.04 |
| cadence-group `AXTextField` | 0.51 | 0.75 |

And the sweep shape, on rows never touched before versus the same rows immediately again:

| | rows | total ms | ms/row |
|---|---:|---:|---:|
| first touch of each of 174 rows | 174 | 95 | **0.55** |
| the same 174 rows, second sweep | 174 | 93 | **0.53** |

**LAW (VOPAT1-15).** *In the lab every role costs the same, and the `AXTable` is the only outlier* — 5.84 ms, because its `AXChildren` marshals a 174-element array in one call. The AX **protocol** cost is role-independent.

**LAW (VOPAT1-16).** *No caching, here either.* A second sweep of the same 174 rows costs the same as the first (0.53 vs 0.55 ms/row), which is the lab's own version of the field's "paid again on every sweep".

**What this does NOT tell you, said plainly.** The lab cannot measure the field's per-role multiplier, because the lab's number is the protocol cost and the field's 115 ms is not. §7 says what the lab's uniformity DOES rule out.

---

## §7 — Reconciling the two campaigns: realization cost vs transport cost

SBCHV1/#676 measured the sidebar at **~115 ms per row realized**. RDLAT2 fitted the Repeat dialog at **~47 ms per Apple event to System Events**. Those are not the same quantity, and this campaign is what separates them.

- The lab reads **every role in ~0.5 ms**, sidebar rows and sheet controls alike (§6). So the expensive thing in the field is not the role, and it is not the AX protocol.
- The field reads geometry for 174 rows in ~2 ms and content for the same 174 rows in ~20 s. So the expensive thing is **realizing a custom row view onto a real display** — which is why a headless VM has never reproduced it and never will.
- A Repeat-dialog control is a stock AppKit control that is **already on screen and already realized**. There is nothing left for a content read to realize.

**LAW (VOPAT1-17).** *The sidebar is realization-bound; the Repeat sheet is transport-bound.* The sidebar's cost is a function of how many ROWS are touched, and the fix is to touch fewer. The sheet's cost is a function of how many System Events ROUND-TRIPS are made — process spawn, AppleScript, host IPC — and the fix is to make fewer, which RDLAT2 began and §4's notifications finish. **They are different problems and they want different redesigns.**

**Stated as a prediction, not a measurement:** the field multiplier for sheet-control content reads should be near the per-call floor (~0.1 ms), not near 115 ms. This campaign cannot prove that. The field probe's cell 10 measures `msPerRowRealized` on the maintainer's machine for the sidebar; an equivalent sheet cell is left for the build campaign, because it would have to open a dialog on his real database.

---

## §8 — Recommendation: the read layer, redesigned

Four rules, in the order they pay.

### R1. Address by ORDINAL, confirm the one row you act on

Predict every row's position arithmetically — area order and per-area project counts from the database, the collapsed set from `collapsedAreaUUIDs` in the group-container prefs through the reader-routed access (SBCOL1 §3 / APDG1), row heights constant per kind (SBCHV1 §0) — then take **one geometry pass** (`AXRows` + frames, free) to check the prediction's shape, and spend a content read **only on the rows the step is about to act on**.

Safety: VOPAT1-5 (`AXRows` ≡ `AXChildren`, 0.00 px) makes the ordinal sound; the content read on the acted-upon row is the confirmation, and a mismatch escalates to the full sweep, which is retained as the oracle exactly as SBRES1 retained depth 6.

### R2. Settle on a NOTIFICATION, never on a re-read

| what the driver waits for today | the observable that replaces it | measured |
|---|---|---:|
| re-census after a chevron click (174 rows realized) | first `AXRowCountChanged` on the table, then ~50 ms of quiet | **502 ms**, 65 events |
| poll `exists menu item` every 50 ms | `AXMenuOpened` | **5 ms** |
| poll for the Repeat dialog | `AXSheetCreated` | **582 ms** (438 ms of it the app) |
| two agreeing reads of the cadence group | `AXValueChanged` on the pop-up the step set, plus the `AXUIElementDestroyed` burst | **535 ms** |
| "ask for focus, look, retry" | `AXFocusedUIElementChanged` on the field | **28 ms** |
| read back the typed value to see if it took | `AXValueChanged` on the field (and its **silence** if the key went elsewhere) | **79 ms** |
| scroll iteration re-census | `AXValueChanged` on the scroll bar | **6.5 ms** |

An AX notification **is** a closed-loop observable under the determinism doctrine — it is the app reporting a state change, not a clock. And it fixes the specific failure the doctrine was rewritten for: RDLAT2 §7c's settle was sized by how long its own reads took, and broke the moment the reads got cheap. A notification cannot be sized by the driver's speed.

Two riders, both from §4:
- **`AXLayoutChanged` is not available** (VOPAT1-12). No settle may be written against it.
- **A notification says WHEN, not WHAT.** The pre-commit audit (CGRD1) still reads every control it set. That is 4 calls on this dialog, and it is not negotiable.

### R3. Do not use `AXVisibleRows` for the snapshot, and do not use the hit-test at all

`AXVisibleRows` is correct, cheap and answers a question the snapshot's consumers are not asking (VOPAT1-3): 1 of 14 areas at the top boundary. Keep it for *"is this row drawn right now"* — which is exactly the band guard R4 and the hit-test both need. The hit-test is a working path with no advantage over the ordinal (VOPAT1-1/2).

### R4. Cut the fixed timers LAST, and only where a notification replaces them

SBCHV1 §5's ordering still holds, and §4 is what makes step two possible. The 300 ms MOVED settle before a press is a certified rig law (REPX1) and stays; the 600 ms post-click re-census settle is what a notification replaces.

### Predicted M1 numbers

Denominated in the field law: content **115 ms per row realized**, geometry **~2 ms per whole-sidebar pass**, one System Events round-trip **~47 ms** (RDLAT2's fitted rate).

**`area reorder`, collapse-the-walls, one wall, 174 rows, 14 areas**

Every row below is the field probe's own cell-8 arithmetic, evaluated at the M1's measured rates — so the numbers here and the numbers the maintainer's probe prints are the same numbers.

| | **rows realized** | content | geometry | settles | **predicted M1** |
|---|---:|---:|---:|---:|---:|
| **today**, full sweep, 6 reads (a floor) | **1,044** | 120.1 s | 0.3 s | 3.69 s | **~2 min** |
| **today**, at SBCHV1's measured read count (~44,000 AX calls ≈ 87 sweeps) | **15,138** | ~29 min | — | 3.69 s | **~29 min** |
| `AXVisibleRows`-bounded reads, 6 reads | 300 | 34.5 s | 0.1 s | 3.69 s | **~38 s** |
| sparse reads that still identify every area, 6 reads | 84 | 9.7 s | 0.3 s | 3.69 s | **~13.6 s** |
| **R1** — content only on the rows acted upon, today's settles | **13** | 1.50 s | 0.36 s | 3.69 s | **5.5 s** |
| **R1 + R2** — the same, with observer-driven fold settles | **13** | 1.50 s | 0.36 s | 2.62 s | **4.5 s** |

The 13 rows: **10** for the locator (content on the first rows of each candidate pane until the built-in `Source Inbox … Source Trash` image descriptions identify the sidebar — locale-independent, SBCHV1 §7 — read once and cached as a child-index path for the rest of the drive), **2** for the pre-flight (source row + anchor row), **1** for the post-drag confirmation. Every fold confirmation, every scroll iteration and every drop-boundary computation is geometry, which realizes nothing — that is the whole difference between 13 and 84.

The 2.62 s: two chevron gestures at 705 ms each (640 ms of certified rig timers — REPX1's 300 ms MOVED settle stays — plus the **measured** ~62 ms from the gesture completing to the first `AXRowCountChanged`), one drag at its unchanged 1,205 ms, and the scroll-bar settles, which are now the 6.5 ms notification.

Read the two bottom rows together, because they are the campaign's conclusion in two lines. **Fixing the reads alone does not clear the bar — 5.5 s, and 3.69 s of that is fixed timers.** Only the reads AND the settles together get under it, at **4.5 s**, and they get under it by half a second, on a model, for an operation whose every previous estimate has been wrong in the pessimistic direction. `experimental-area-reorder` stays off until the maintainer measures this path on the M1 itself.

(The four upper rows also correct a smaller error in the probe: its per-chevron settle constant read 950 ms while its own comment enumerated 1,240 ms of parts. SBCHV1 §5 counts the parts; the constant is now 1,240.)

**`todo make-repeating --frequency monthly --interval 1 --after-completion`**

| | round-trips | polls | app's own time | **predicted M1** |
|---|---:|---:|---:|---:|
| **today** (RDLAT2, shipped) | 88 System Events events | menu-open poll + 2 settles | — | **≈ 7.6 s** (RDLAT2's floor) |
| **R2 + a path manifest** | ~77 raw AX calls ≈ 9 ms | **none** | 1.79 s | **≈ 2.2 s** |

The 1.79 s is entirely the app, and every term of it was measured this campaign: sheet presentation 438 ms, two pop-up opens 5–16 ms, two group rebuilds 535 ms each, focus 28 ms, type-and-confirm 79 ms, commit ~150 ms (the one estimate). **The drive becomes app-bound**, which is the correct place for it to end up.

Caveat, per §7: this assumes sheet controls do not pay a realization cost in the field. If they do, add fifteen controls' worth.

### The safety story, under the AX-scrutiny doctrine

- **The settle's observable is the app's own notification** — a closed loop on a state change, not a timer and not the driver's read speed. It satisfies the determinism doctrine more strictly than what it replaces.
- **Content confirmation on the ONE element acted upon** stays mandatory: a row is not dragged, and a control is not typed into, until a content read has proved it is the row/control the step named. That is the HXPC1 rule, and the sparse read spends its entire budget on exactly that.
- **A full census is retained at two moments and nowhere else**: at dialog open (the shape manifest's shell assertion, 9 calls) and pre-commit (CGRD1's audit of every control the recipe set, 4 calls). Both are cheap on the sheet; neither is a sidebar sweep.
- **The full sweep survives as the oracle.** Any disagreement between the arithmetic prediction and the geometry pass — a row count that does not match, a frame that does not fall where predicted — escalates to the depth-2 sweep before the ladder sees anything, exactly as SBRES1's depth-6 escalation still backs the depth-2 harvest.
- **Fail direction is unchanged.** A notification that never arrives is a refusal with its own named reason, not a fall-through to "assume it worked".
- **A census change needs a cell that reads the census** (RDLAT2's law). The build campaign owes a cell that prints the snapshot's consumer output — section extents, row counts, `scrollableSpan`, boundary geometry — sparse against full, in every sidebar state, before the sparse path is allowed to be the default.

---

## §9 — What shipped in this PR, and what did not

**Shipped:** the probe rigs (`research-vopat1.sh`, `vopat1-helper.jxa.js`, `vopat1-observer.py`), and three new cells plus one correction in the field probe:

- **cell 9 hit-test** — geometry pass, `AXUIElementCopyElementAtPosition` at a predicted row centre, walk up to the row, one content read.
- **cell 10 read strategies** — full sweep vs `AXVisibleRows` vs sparse, reported in `rowsRealized` and `msPerRowRealized`; `--areas N` prices the sparse strategy at the maintainer's own area count.
- **cell 11 notifications** — an `AXObserver` (embedded ctypes) armed on the app, the table and the scroll area; the only actuation is a scroll-bar nudge that is written straight back, with a `restored` proof.
- **cell 8's cost model, corrected.** It priced 3,374 sweep calls at cell 5's 0.12 ms table-level latency and printed *"REACHABLE: 3,510 ms"*. Content is now priced **per row realized** and geometry **per call** — two rates that differ by three orders of magnitude on a real display — and cell 8 runs last so it can consume cells 9–11. Cell 2 also now reports `msPerRowRealized` beside `msPerAxCall`, with a comment saying which of the two means anything.

**Not shipped, deliberately:** any change to `src/`. §8 is a build campaign with its own consumer-contract certification, and the maintainer sees the numbers first.

---

## §10 — Run log

Cells as run: `setup` → `reship` → `seed` (14 areas / 89 projects) → `topup` (to exactly 174 rows) → `shape` → `hittest` → `visset` → `notify` → `sheet` → `settle` → `teardown`. Artifacts (gitignored): `lab/artifacts/vopat1-lab/`.

Three operator notes worth carrying forward.

**(a) SBCHV1's `node_modules/commander` note bit again, in a new way.** A fresh agent worktree has no `node_modules` at all, so `npm run build` in `setup` produced nothing and the guest bundle shipped a `dist` without its one runtime dependency — surfacing much later as `ERR_MODULE_NOT_FOUND` from a `things --version` whose output setup had already discarded. `reship` now copies `commander` beside `dist` and prints the guest CLI's version, so the failure is visible in the cell that caused it.

**(b) An off-band synthesized click is not a no-op — it is a click on something else.** The first `notify` run dispatched the chevron click at a point 27 pt below the fold, because the wall's row had not been scrolled into the band. It landed in the content pane, **opened a second Things window**, invalidated the `AXUIElement` every observer was registered on (`AXError -25212` on the next `AXChildren`), and left the sidebar unresolvable. The cell now refuses to dispatch a click whose target is not inside the viewport, and re-reads its paths between the collapsing and restoring clicks because the fold destroys and rebuilds the table element.

**(c) A settle cell must dismiss its own dialog.** The `settle` cell drives the Repeat dialog through a frequency change and a keystroke and then escapes twice, asserting `rt1_recurrenceRule IS NULL` on the target — a probe that leaves a rule behind has mutated the fixture every later cell reads.
