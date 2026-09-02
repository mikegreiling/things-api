# SBCHV1 — the disclosure step's budget, its internals, and what a sidebar read actually costs (#676)

**Probed under:** `things-lab-golden-v4` · Things **3.23** (build 32300036) · macOS 15.7.7 (24G720) · DB v27 · clock pinned 2026-07-05 (trial wall 2026-07-18, never approached) · airgapped clone, destroyed at teardown · fixture 100% synthetic.

**Field evidence quoted throughout:** issue #676, a sanitized trace from the maintainer's **M1 MacBook Pro** — things-api 0.20.3, Things **3.23.2**, macOS **15.4.1** (24E263), arm64, helpers installed + granted. Counts and timings there are real; every name is a synthetic stand-in.

Driver: [`lab/scripts/research-sbchv1.sh`](../../lab/scripts/research-sbchv1.sh) · measurement rig: [`lab/scripts/sbchv1-helper.jxa.js`](../../lab/scripts/sbchv1-helper.jxa.js) · field instrument: [`lab/scripts/field-probe-sidebar.jxa.js`](../../lab/scripts/field-probe-sidebar.jxa.js).

> **Reproducibility, stated plainly.** The lab is **~25x faster per AX round-trip** than the field host. The 30-second timeout #676 reports is therefore **NOT lab-reproducible**, and no amount of fixture growth will reproduce it. What this campaign certifies is the LOGIC — that every sidebar-touching budget now scales, that the instrumentation emits, that the collapse still folds and restores at field row count — and it MEASURES the two quantities (AX call counts, fixed-timer totals) that let the field host's own numbers be projected. The projection instrument is the field probe, which the maintainer runs on his own machine.

---

## 0. The fixture

14 areas / 92 projects / **174 sidebar table rows** — the field's row count exactly. One section (`Theta`, 63 projects) renders **65 rows / 1552pt** against a 613pt viewport: a wall taller than any window, which is the #672/#676 shape. A second wall (`Eta`, 52 rows) exists after the top-up so the two-wall path is reachable.

Sidebar composition, measured (`rowkinds`):

| kind | count | height | constant? |
|---|---|---|---|
| area row | 14 | 24pt | **yes** |
| built-in list row (Inbox/Today/Upcoming/Anytime/Someday/Logbook/Trash) | 5 visible | 24pt | **yes** |
| project row | 96 | 24pt | **yes** |
| spacer row (no static text) | 17 | 16pt | **yes** |

**Row heights are constant per kind** — including an area with zero projects and a collapsed area — which is what makes an arithmetic row-position prediction possible at all (§6).

---

## 1. H1 — the budget audit. Which primitives were unscaled?

0.20.3 scaled the SNAPSHOT's budget (`rows × 400ms`, floor 30s, ceiling 90s) and nothing else. Every other sidebar primitive kept the flat `STEP_TIMEOUT_MS = 30_000`. The field trace is the audit's own evidence:

| primitive | field duration | field budget | outcome |
|---|---|---|---|
| `sidebar-snapshot` ×4 | 16033 / 18180 / 17874 ms | **69600 ms** (scaled) | ok |
| `sidebar-scroll` | 17460 ms | 30000 ms (flat) | ok — **by 12.5s** |
| `sidebar-chevron` | **30028 ms** | 30000 ms (flat) | **timedOut: true** |

Every one of these scripts opens by running the SAME `resolveSidebar` census the snapshot runs. `sidebar-scroll` survived on 12.5 seconds of margin; the chevron, which is a census **plus** a per-row harvest **plus** a chevron-subtree walk **plus** ~0.7s of click settles, did not.

**Unscaled primitives found:** `sidebar-scroll` (both the scrollbar and wheel spellings), `sidebar-chevron`, `sidebar-held-drag`. **Correctly flat:** `sidebar-drag` (posts ~28 CGEvents, reads nothing), `sidebar-visibility` (one View-menu click), `key` (one key event).

Fixed by expressing every budget in **census-equivalents** (`CENSUS_EQUIVALENTS` + `sidebarStepBudget` + `stepBudgetFor` in `src/write/vectors/ui-drag.ts`), from ONE place, so a future primitive that forgets to scale is a visible omission rather than a field timeout nobody can attribute. `sidebar-held-drag` additionally scales with its tick budget, because it re-reads the whole sidebar once per tick.

At 174 rows: snapshot/scroll **69.6s**, chevron **208.8s**, held drag **240s** (the absolute ceiling), drag/visibility/key **30s**.

---

## 2. H2 — where the disclosure step's time actually went

The chevron script matched rows with a hand-rolled depth-6 walk making **three separate attribute reads per node** (`AXValue`, `AXDescription`, `AXTitle`) — while the snapshot beside it used one batched `AXUIElementCopyMultipleAttributeValues` per node, depth-guarded to 2. Measured head to head over the SAME live 174-row table, looking for the SAME title:

| matcher | AX round-trips | wall (lab) | hits | agree |
|---|---|---|---|---|
| old — hand-rolled, depth 6, 3 reads/node | **8,185** | 3,897 ms | 1 | — |
| new — batched `node()` + `textOf`, depth 2 | **506** | 517 ms | 1 | **yes** |

**16.2x fewer round-trips, 7.5x faster, byte-identical result.** The depth-2 harvest agreeing with depth 6 on an exact area-title segment match is SBRES1's measured law; this only stops re-deriving it badly. The deep walk survives as an **escalation** — taken only when the fast pass cannot satisfy the requested ordinal — so the matcher can never see less than it used to.

Projected onto the field host's own numbers (§4): the old chevron script was **~9,077 AX calls ≈ 169 seconds** on that Mac. It was never going to fit in 30s, and a budget increase alone would have needed 200s+ to hold it. The batched matcher takes the same script to **~1,400 calls ≈ 26s** — inside the scaled budget with room to spare, and the first change of the two that actually matters.

### The instrumentation, in production form

The shipped script now self-times and names its own stage. Measured on the fixture (`chevcost`, this DOES click):

```
run 1: {"clicked":true,"ms":{"sidebar":664,"rows":498,"rowsScanned":174,"rowDepth":2,
        "chevron":4,"click":686,"total":1852},"stage":"clicked"}
run 2: {"clicked":true,"ms":{"sidebar":486,"rows":308,"rowsScanned":111,"rowDepth":2,
        "chevron":3,"click":671,"total":1468},"stage":"clicked"}
```

`chevron: 4ms` is the answer to the report's open question about where a hang could hide: locating the chevron *within* the resolved row is free. The cost is the census and the row harvest, both of which now scale down.

On the TS side each internal step is a timed trace record (`phase: "sidebar-chevron-steps"`) — `scroll-into-view`, `census-before`, `click` (carrying the in-script split above), `settle`, `census-after`, `confirm` — and the failure copy carries a **terminal reason** beside the human sentence, the twin of SBSCR1's scroll reasons: `chevron-row-unscrollable`, `chevron-sidebar-unresolved`, `chevron-row-unresolved`, `chevron-unresolved`, `chevron-off-band`, `chevron-click-dispatch-failed`, `chevron-step-timeout`, `chevron-census-timeout`, `chevron-census-failed`, `collapse-not-confirmed`. The old copy — *"the disclosure arrow did not respond"* — described a Things behaviour that was not happening; a step that was **stopped after N seconds**, a step that **would not run**, and an arrow that **refused the click** now read as three different sentences.

---

## 3. H3 — bounded reads. `AXVisibleRows` exists and is honest

The sidebar's `AXTable` advertises:

```
AXFocused, AXChildrenInNavigationOrder, AXFrame, AXHeader, AXPosition, AXEnabled,
AXSelectedCells, AXSelectedColumns, AXHelp, AXChildren, AXRole, AXParent,
AXTopLevelUIElement, AXRows, AXVisibleRows, AXSelectedRows, AXColumns,
AXVisibleColumns, AXRoleDescription, AXSize, AXWindow
```

Measured at 174 rows in a 613pt viewport:

| read | elements | y range | AX calls (harvest) | wall (lab) |
|---|---|---|---|---|
| full `AXChildren` sweep, depth 2 | 174 | 80..4120 | **862** | 629 ms |
| `AXRows` | 174 | 80..4120 | 1 (+2/frame) | ~0 ms |
| **`AXVisibleRows` + depth-2 harvest** | **28** | 80..696 | **78** | **44 ms** |
| `AXVisibleChildren` | absent | — | — | — |

28 is exactly the count of rows whose centres lie in the band (27 by centre, 28 by intersection). **11x fewer round-trips, 14x faster, and O(viewport) rather than O(list)** — it does not degrade as the user's sidebar grows. Projected onto the field host: **~1.5s instead of ~16s.**

Two constraints on using it, both real:

- **(a)** The snapshot's consumers need section EXTENTS and row COUNTS for rows outside the band — tall-section detection, drop-boundary geometry, `scrollableSpan`. A bounded read is a fast path that must be reconciled against arithmetic or a full sweep; it is never a silent replacement.
- **(b)** The arithmetic is available precisely because row heights are constant per kind (§0). Area order and per-area project counts come from the database; the collapsed set is `collapsedAreaUUIDs` in the group-container prefs (SBCOL1 §3), read through the reader-routed container access, never a direct touch (APDG1/#664).

**Not built in this PR.** It is the highest-leverage change identified and it is ready to specify, but it changes the read every rung depends on and belongs in its own campaign with its own consumer-contract certification, exactly as SBRES1 did for the locator.

---

## 4. The per-AX-call floor, and what it does to everything else

| host | per single-attribute read | per batched `node()` | depth-2 sweep @174 rows |
|---|---|---|---|
| golden-v4 clone (this campaign) | **0.076–0.099 ms** | 0.454–0.46 ms | 862 calls / **618–629 ms** |
| maintainer's M1 (#676 trace) | — | — | 862 calls / **16,033–18,180 ms** |

Dividing the field's own sweep by the call count the lab measured for the identical script gives **18.6–21.1 ms per AX round-trip on that host, against 0.73 ms here — a factor of ~25.** This is the number every prediction below is denominated in, and it is why a lab measurement of round-trip cost must never be treated as an upper bound.

The field probe ([`lab/scripts/field-probe-sidebar.jxa.js`](../../lab/scripts/field-probe-sidebar.jxa.js)) measures it directly on the maintainer's machine, and splits it two ways — the same N single-attribute reads through JXA and through a stdlib-only `python3` ctypes program addressing the same element — so the floor can be attributed to the osascript/JXA bridge or to Things' own main thread. That verdict decides whether a helper-side native AX driver (a deputy version bump, hence a reinstall ceremony) would buy anything at all.

---

## 5. The fixed-timer audit

Under the UI-automation determinism doctrine, time spent in fixed sleeps is time that cannot be reasoned about. Counted in `src/write/vectors/ui-drag.ts`:

| gesture | fixed timers | total |
|---|---|---|
| one chevron actuation | 300ms MOVED settle + 90ms press + 250ms release (in-script) + 600ms post-click settle (TS) | **1,240 ms** |
| one drag | 30 + 120 + 30 + 25×25 + 400 | **1,205 ms** |
| one scrollbar write | 250 | **250 ms** |
| one wheel burst (fallback) | 50 + 60 per click | 50 + 60n ms |

**No settle is cut in this change**, and the reason is a measurement rather than caution: against a 16-second census on the field host, 1.24s per actuation is **7%** of the step. Cutting it would buy almost nothing while risking a certified rig law (the 300ms MOVED settle before the press is REPX1 §1.2's, and the 600ms post-click settle is what SBCOL1's re-census was certified behind). The audit's real finding is the opposite one, and it lands in §6: **once the read cost is fixed, the fixed timers become the dominant term**, and at that point cutting them is the difference between meeting the five-second bar and missing it. The order matters — read first, timers second.

---

## 6. The collapse-all strategy, measured — and why it is the WRONG direction for the 5s bar

Three questions, all answered on the fixture.

**(a) Does ⌥-click collapse every sibling (the AppKit outline convention)? — NO.**

```
rows now: 174
⌥-click on the wall row: {"ok":true,"mods":"alt","rowsBefore":174,"rowsAfter":111}
rows now: 111
⌥-click again (restore):  {"ok":true,"mods":"alt","rowsBefore":111,"rowsAfter":174}
rows now: 174
```

The option-modified click toggles exactly the section it lands on — the same delta a plain click produces. Things' sidebar does not implement the sibling convention. (It does toggle cleanly and restore cleanly, so ⌥-click is at least harmless.)

**(b) Is there a View-menu collapse-all? — NO.** The View menu holds 9 items: `Hide Sidebar`, `Hide Toolbar`, `Go To`, `Enter Full Screen` and separators. No menu in the bar carries an item matching `/collaps|expand|fold|disclos/i`.

**(c) What does the top-down click loop cost?** It works — 9 iterations, every fold confirmed by re-census, 174 rows down to 40:

```
total: 12,418 ms   6,577 AX calls   final rows = 40   iterations = 9
  LAB-AREA-B 174→173 · wall 173→110 · LAB-AREA-A 110→108 · Beta 108→104
  Delta 104→98 · Lambda 98→93 · Mu 93→90 · Eta 90→40 · (no section left) done
```

Nine folds, and a move must also RESTORE all nine — **18 chevron actuations minimum**, plus the drag.

### The cost model

```
predictedMoveMs  =  (AX round-trips × per-call latency)  +  fixed-timer total
```

Anchored on a **measured** move rather than an estimated call budget. The acceptance run (§8) moved one area to the end across **two** walls at 174 rows in **39.5s in-lab**, of which ~7.2s is fixed timers (4 chevron actuations × 1.24s + one drag × 1.21s + scrolls). The remaining **~32s is AX round-trips at 0.73 ms**, i.e. **~44,000 of them** — the ladder re-reads the whole sidebar on every scroll iteration, every fold confirmation and every hop.

| | AX round-trips | fixed timers | lab @0.73 ms | **field @18.6 ms** |
|---|---|---|---|---|
| **A** — as shipped in 0.20.3 (depth-6 chevron matcher) | ~62,000 | 7.2 s | ~52 s | **~19 min** |
| **B** — this PR (batched matcher + scaled budgets) | **~44,000** (measured) | 7.2 s | **39.5 s** (measured) | **~14 min** |
| **C** — B + `AXVisibleRows`-bounded reads (§3, 11x) | ~4,000 | 7.2 s | ~10 s | **~82 s** |
| **D** — C + DB-derived sparse confirm (~30 calls/read) | ~1,200 | 7.2 s | ~8 s | **~30 s** |
| **E** — collapse-ALL, 14 areas (18 actuations), sparse reads | ~1,500 | **~23 s** | ~24 s | **~51 s** |

Two things fall out, and both are load-bearing.

**Collapse-all is strictly worse than collapse-the-walls against a five-second bar.** Eighteen chevron actuations cost **22.3 seconds of fixed timers alone**, before a single AX call — 4.5x the bar, and no read optimisation touches that number. The strategy's appeal is real (every read after the first is small) but it buys a term that was never the binding constraint and pays for it in a term that cannot be optimised away without weakening certified settles. The one-wall case the field reported needs **two** actuations, not eighteen.

**Nothing modelled reaches five seconds on the field host.** Even row D — bounded reads *and* a DB-derived sparse confirm — predicts ~30s, of which 7.2s is fixed timers. Reaching the bar would need the sparse read AND a settle programme AND, most likely, a native in-process AX driver in the helper. That is a plausible route, not a proven one, which is exactly why the operation is **experimental** rather than merely slow — and why the ruling names removal as the alternative.

**The binding constraints, in order:** (1) AX round-trips per read — fixable, ~11x available from `AXVisibleRows` alone; (2) round-trips per MOVE, i.e. how many times the ladder re-reads — the ladder currently re-reads on every scroll iteration and every confirmation, which is where the ~44,000 comes from; (3) fixed timers per gesture, which puts a floor under any strategy that makes many gestures.

## 7. Row identification — the discriminators that work

The collapse-all design wanted a cheap, title-free way to tell an area row from a project row. Measured across all 174 rows, by AXImage `AXDescription`:

| row kind | image descriptions found |
|---|---|
| area (14) | `Source Toggle Template` ×14 — **every area, including areas with zero projects** |
| project (96) | `Source Toggle Template` ×125, `Source Inbox` ×1, `Source Today` ×1 |
| built-in list (5) | `Source Upcoming`, `Source Anytime`, `Source Someday`, `Source Logbook`, `Source Trash` — **no toggle image** |
| spacer (17) | none |

So **"carries a disclosure-chevron image" is necessary but nowhere near sufficient** — 125 project rows carry one too. Area rows stay identified the SBRES1 way: the segment match against the caller's own area titles from the database, which the field trace confirms works at scale (matched 12/12 at depth 2 on the maintainer's host).

The clean finding is the complement: the built-in top rows carry **locale-independent** image descriptions (`Source Inbox` … `Source Trash`) and no toggle image, so the fixed rows above the area list can be identified without reading a single localized title. Recorded in [things-app-craft.md](../things-app-craft.md).

---

## 8. Certification under the new budgets

Run at **174 rows**, `--dangerously-drive-gui`, the #676 command shape verbatim, with the source area (`Alpha`) above **two** oversized sections (`Theta` 65 rows / 1552pt and `Eta` 52 rows / 1240pt) in a 346pt viewport.

### 8.1 The maturity gate — refuses, names the reason, drives nothing

```console
$ THINGS_API_EXPERIMENTAL_AREA_REORDER=false things reorder Alpha --end --dangerously-drive-gui --json
{"apiVersion":1,"ok":false,"kind":"error","error":{"code":"blocked",
 "message":"reordering sidebar areas drives the Things window through the Accessibility API — it
  synthesizes a drag, reads the sidebar between gestures, and can collapse and re-expand areas to
  clear a path. On a large sidebar those reads have measured 16–18s each on an M1, so a single move
  can take minutes and can leave an area collapsed if it stops part-way. It is off until it
  completes inside five seconds on real hardware",
 "remediation":"run `things config set experimental-area-reorder true` to use it anyway, or drag the
  area in Things"},"meta":{...,"elapsedMs":17}}
```

Exit **4**. Area order byte-identical afterwards — **PASS**. 17ms, so the refusal costs nothing.

### 8.2 With the opt-in on — the move lands

```
wall clock: 40s   elapsedMs: 39492   exit 0
notes: "applied via GUI drive (tier 3)"
       "\"Theta\", \"Eta\" in the sidebar was collapsed to clear the drag path and expanded
        again afterwards; the sidebar looks as it did"
before: LAB-AREA-B < Zeta < Alpha < Theta < LAB-AREA-A < … < Iota
after:  LAB-AREA-B < Zeta < Theta < LAB-AREA-A < … < Iota < Alpha
```

| assertion | result |
|---|---|
| placement reached (`Alpha` is last) | **YES** |
| `TMArea` count invariant | **PASS** |
| assignments digest invariant | **PASS** |
| both walls folded and re-expanded | **YES** — post-drive section row counts `Theta` 65, `Eta` 52, identical to pre-drive |

*(The driver's own census-diff line reads NO because the crude pre/post comparison keys on `(area, rows)` pairs and `Alpha` moved — the last area's row count is computed against the table bottom, so `Iota` and `Alpha` swap counts. Every section's own row count is unchanged; the disclosure state was restored.)*

### 8.3 Controls, under the new budgets

| control | result |
|---|---|
| **SBRES1** — semantic sidebar resolution at 174 rows | `{"ok":true,"rows":174,"hits":14,"titles":14}` — **14/14** |
| **SBSCR1** — pointerless scrollbar with the pointer parked at (5,5) | `{"ok":true,"before":0,"after":0.5}` — **PASS**, pointer never moved |
| **SBCOL1** — auto-collapse + restore across two walls (§8.2) | **PASS** |
| rung-1 in-viewport move (`Gamma --before Kappa`, no wall) | **5.5s**, invariants PASS, disclosure restored — **PASS** |

**No beeps** were expected or counted as failures (`THINGS_LAB_BEEPS_OK=1`, research-driver opt-out).

---

## 9. Run log

Artifacts: `lab/artifacts/sbchv1-lab/` (gitignored) — `report.txt`, `ax/*.json`, per-cell censuses, `e2e.json`, `cert.json`.

Cell order as run: `setup` → `seed` (12 named areas + the golden's 2 = 14; 92 projects) → `topup` (to exactly 174 rows) → `shape` → `visrows` (+ `sweepcost`, `imgdesc`) → `latency` → `rowkinds` → `chevcost` → `collapseall` → `expandall` → `e2e` → `cert` → `teardown`.

Two operator notes worth carrying forward. **(a)** The guest bundle needs `node_modules/commander` copied alongside `dist/`; a setup that ships `dist` alone leaves every `things` invocation dying on `ERR_MODULE_NOT_FOUND`, and because setup pipes `config set` to `/dev/null` the failure surfaces much later as a puzzling *"the Accessibility GUI vector is off on this machine"*. **(b)** The `collapseall` cell leaves eight areas folded and the state survives a relaunch — always run `expandall` before any cell that depends on the fixture's shape.

## 10. Recommendation

1. **Ship the budget parity and the batched chevron matcher** (this PR). Together they take the disclosure step from ~169s to ~26s on the field host and stop it being stopped mid-work. They do not make the operation fast; they make it honest.
2. **Adopt `AXVisibleRows` for the snapshot's fast path** — its own campaign, with the consumer contract certified the way SBRES1 certified the locator, and the full sweep retained as the oracle whenever the bounded read and the arithmetic disagree. ~11x on round-trips, and it stops the cost scaling with the user's data.
3. **Do NOT adopt collapse-all.** §6 measures it as strictly worse against the five-second bar than the collapse-the-walls rung already shipped: it multiplies the gesture count, and gesture count is the term that cannot be optimised. ⌥-click and the View menu offer no shortcut on 3.23.
4. **Native helper-side AX driver: decide from the field probe, not from here.** If the probe's two-path cell reports native ≈ JXA, Things' main thread is the floor and a deputy bump buys nothing — the answer is fewer calls, which is (2). If it reports native ≪ JXA, the bridge is the floor and a native driver is worth the reinstall ceremony. The lab cannot answer this: at 0.076 ms/call there is nothing here to attribute.
5. **The settle programme is the LAST step, not the first** (§5), and it only becomes worth its risk once (2) has landed.
