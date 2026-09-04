# VOPAT2 PR 2 — the sparse sidebar census, and the settles the app volunteers (#676)

**Probed under:** `things-lab-golden-v4` (direct arm) and **`things-lab-golden-v4h`** (ROUTED arm, helpers 1.4.0 installed + granted + routing enabled) · Things **3.23** (build 32300036) · macOS **15.7.7** (24G720) · DB v27 · `python3` 3.9.6 with the Command Line Tools · package **0.20.9** · clock pinned 2026-07-05 (trial wall 2026-07-18, never approached) · airgapped clones, both destroyed at teardown · fixture 100 % synthetic (16 areas including a duplicate-title pair / **178 sidebar rows** / two oversized sections / a live scroll bar).

Driver: [`lab/scripts/research-vopat2-pr2.sh`](../../lab/scripts/research-vopat2-pr2.sh) (`setup` · `seed` · `topup` · `shape` · `axrows` · `reads` · `dbpredict` · `notify` · `e2e` · `abort` · `hidden` · `teardown`; `ROUTED=1` selects the field-shaped arm) · rigs: [`vopat2pr2-helper.jxa.js`](../../lab/scripts/vopat2pr2-helper.jxa.js), [`sbchv1-helper.jxa.js`](../../lab/scripts/sbchv1-helper.jxa.js) (reused verbatim), [`vopat2pr2-consumers.mjs`](../../lab/scripts/vopat2pr2-consumers.mjs), [`vopat2pr2-dbmodel.py`](../../lab/scripts/vopat2pr2-dbmodel.py), [`vopat2pr2-rowkinds.py`](../../lab/scripts/vopat2pr2-rowkinds.py), [`vopat2pr2-trace.py`](../../lab/scripts/vopat2pr2-trace.py).

This is the BUILD campaign for [VOPAT1](vopat1-screen-reader-pattern.md) §8 R1–R2 on the SIDEBAR — the surface VOPAT1 called *realization-bound*. [PR 1](vopat2-screen-reader-build.md) built the settle observer and spent it on the Repeat sheet, which is *transport*-bound; this one spends it, and the sparse read, on the sidebar.

> **Reproducibility, stated plainly.** Lab wall times DO NOT TRANSFER: a clone has no Retina display to realize a custom row view onto, and is ~25× cheaper per AX round-trip than the maintainer's M1 (SBCHV1 §4) and ~200× cheaper per row realized (VOPAT1 §0). What this campaign measures is **AX round-trips**, **rows realized** and **which notifications fire** — all three host-independent — and prices them at the field's own measured constants. Every wall time below is a lab wall time and is labelled as one.

---

## The problem, measured before this PR

| | measured |
|---|---|
| one full-sweep census of a 174-row sidebar | **862 AX round-trips, 186 rows realized** (SBCHV1 §3, VOPAT1 §1) |
| the same census on the maintainer's M1 | **16–18 s**, four times per drive and rising ([#676](https://github.com/mikegreiling/things-api/issues/676)) |
| what the ladder did with it | a census before every scroll iteration, inside every chevron script, after every fold, before every hop |
| a one-wall move to the end, M1, v0.20.8, opt-in on (2026-09-03) | **436.5 s** — of which the gestures are ~5 s |

VOPAT1 §7 attributed the field's cost correctly: not the AX protocol (every role reads in ~0.5 ms in the lab, and the field reads *geometry* for 174 rows in ~2 ms) but **realizing a custom row view onto a real display** — ~115 ms per row realized, paid again on every sweep. So the metric that transfers is **ROWS REALIZED**, and the fix is to touch fewer.

---

## The answers, in one table

| Cell | Question | Verdict |
|---|---|---|
| **shape** | are row heights constant per kind, and is every area row a section start? | **YES to both.** Entity rows 24 pt and spacers 16 pt, CONSTANT across all 178 (SBCHV1 §0 re-confirmed). All 16 area rows are section starts; the geometry offers 20 candidates for 16 areas. |
| **axrows** | is `AXRows` the table's `AXChildren`? what does a row's geometry cost? | **THE SAME LIST, 0.00 px apart, at 178 rows** — and `AXRows` is **1 round-trip** against `AXChildren`+role-filter's **180**. Geometry: batched position+size **178 calls / 40 ms**, `AXFrame` **178 / 13 ms**, content **515 / 525 ms and 178 rows realized**. |
| **reads** | does the sparse census answer the consumers as the sweep does? | **IDENTICAL, in all four states, in both prediction modes, on both arms** — 16/16 areas, same pitch, spacer height, boundaries, section extents and `scrollableSpan`, zero classification disagreements. |
| **dbpredict** | does the database's arithmetic predict the ordinals? does `collapsedAreaUUIDs` follow a live fold? | **EXACTLY, in both states** (`headerRows=12, spacerPerSection=true` → 16/16), and the preference **does** follow a fold. No systematic miss. |
| **notify** | scroll (VOPAT1-7, unconfirmed)? fold (VOPAT1-8)? does a DROP announce anything? | **CONFIRMED, CONFIRMED, and YES.** The scroll bar posts its own `AXValueChanged`; a fold posts `AXRowCountChanged` ×65 (one per row); a drop is LOUD — `AXRowCountChanged` ×350. `AXSelectedRowsChanged` and `AXLayoutChanged` never fire. |
| **e2e** | do the certification moves land, restored, on both arms? | **PASS ×6 per arm.** Invariants PASS, disclosure restored, **0 alert beeps**, every settle observed. |
| **abort** | killed mid-ladder, what happens? | **The fold survives, visibly — and that is the contract.** A later drive works on the folded sidebar and leaves the residue alone. |
| **hidden** | SBRES1's normalization rung under a sparse census? | **PASS on both arms** — shown, driven, folded, restored, hidden again. |

---

## §1 — What shipped

**[`src/write/vectors/ui-sidebar-map.ts`](../../src/write/vectors/ui-sidebar-map.ts)** (new) — the arithmetic half of the census: spacer classification, the section-start candidate set, database-order alignment, the carry-forward transform, and the DB row model. Pure, and unit-tested for what each predictor SAYS when it is wrong, because that is the path the drive depends on.

| | before | after |
|---|---|---|
| the snapshot | `resolveSidebar` harvests every candidate pane's rows at depth 2 | `AXRows` + one batched `AXPosition`+`AXSize` per row (realizes nothing) + content on the predicted area ordinals |
| which rows get content | all of them | the area rows — carried from the previous census, or the section starts the geometry exposes |
| when the prediction is wrong | — | the full depth-2 sweep, unchanged, and the miss named in the trace |
| the pointerless scroll | opens with a full census to find the scroll bar | pane index + ONE realized row to re-confirm it |
| the wheel fallback | opens with a full census to find the viewport | the same, and the same PTRGD1 guard |
| the disclosure click | harvests every row to find one by title | the row's ordinal + ONE realized row (the HXPC1 confirmation), and the same PTRGD1 guard against the census's row frame |
| the fold's settle | `delay 0.6` | `AXRowCountChanged` on the table, then 120 ms of quiet |
| the drop's settle | straight into the database poll | the table's own observable first, then the same poll |

**Every fallback is the code that shipped before.** With no map — the first census, a mismatch, `THINGS_API_SIDEBAR_SPARSE=0` — each primitive generates its census-addressed script byte for byte, and a unit case asserts the identity rather than an equivalence. With no observer, every settle is the fixed wait it always was. Both are SOFT: an unavailable mechanism is a fallback, never a refusal.

**The pointer guard is not optional on the cheap path.** A cheaper way to FIND the sidebar is not a cheaper way to be sure of a pixel, so the ordinal-addressed chevron and wheel scripts carry [PTRGD1](ptrgd1-pointer-guards.md)'s `ptrGuard` block verbatim, and both are registered in the mouse-post census (`test/unit/pointer-gesture-guard.test.ts`) — the guard's own allowlist is what would otherwise have let a new posting site ship unguarded.

---

## §2 — The fixture (`shape`)

16 areas (12 named + a duplicate-title `Twin` pair + the golden's 2), 138 project rows, **178 sidebar rows** in a 240 × 346 pt viewport — the #676 field shape (174) within four rows. Two oversized sections: `Theta` 65 rows and `Eta` 52, so the two-wall path is reachable. **A scroll bar is present** (`scroll = 0`), which is what the unseeded golden lacks and why VOPAT2 §2 could not confirm VOPAT1-7.

| kind | count | height | constant? |
|---|---:|---:|---|
| area row | 16 | 24 pt | **yes** |
| built-in list row | 5 | 24 pt | **yes** |
| project row | 138 | 24 pt | **yes** |
| spacer row | 19 | 16 pt | **yes** |

**LAW (VOPAT2PR2-1).** *Row heights are constant per KIND at field scale, so a geometry-only pass can tell a spacer from an entity row without realizing either.* This is what lets the sparse census answer `medianSpacerHeight`, `boundaryAboveRow` and `boundaryBelowLast` for rows nobody read. The classification is cross-checked on every realized row against the text rule the driver has always used, and a single disagreement escalates the whole census — measured at **zero disagreements** in every state, on both arms.

**LAW (VOPAT2PR2-2).** *Every area row is a SECTION START.* 20 geometry candidates for 16 areas: the built-in block plus three collateral starts. So a census with no prediction at all costs **22 rows realized**, against the sweep's 190 — the first census of a drive does not need the database's arithmetic to be cheap.

The built-ins' locale-independent image descriptions are re-confirmed (SBCHV1 §7): `Source Upcoming/Anytime/Someday/Logbook/Trash` on the fixed rows, `Source Inbox`/`Source Today` above them, `Source Toggle Template` on all 16 area rows **and** on 126 project rows — necessary, nowhere near sufficient, exactly as SBCHV1 measured.

---

## §3 — The ordinal space (`axrows`)

```
{"axRows":178,"axChildrenRows":178,"sameCount":true,"compared":178,"maxFrameDeltaPx":0,
 "cost":{"axRowsCalls":1,"axRowsMs":9,"axChildrenCalls":180,"axChildrenMs":24}}
```

**LAW (VOPAT2PR2-3).** *`AXRows` IS the table's row list, and it is one round-trip.* VOPAT1-5 measured this at 174 rows on an unseeded sidebar; here it holds at 178 with frames identical to **0.00 px** across all 178 comparisons. Ordinal addressing — which every primitive in this PR rests on — is sound, and the enumeration that supports it costs **1 call instead of 180**.

What a row's geometry costs, three ways, 178 rows, three runs each (lab ms):

| | AX calls | lab ms | realizes |
|---|---:|---:|---|
| one batched `AXPosition`+`AXSize` (**shipped**) | 178 | 37 / 42 / 41 | nothing |
| two singular reads (what the sweep does) | 356 | 36 / 38 / 38 | nothing |
| `AXFrame` | 178 | **13 / 14 / 13** | nothing |
| the depth-2 content harvest | 515 | 516 / 527 / 532 | **178 rows** |

**`AXFrame` is 3× faster than the batched pair for the same call count — and it is NOT adopted, deliberately.** The geometry term is what the field does not pay: VOPAT1 measured geometry for 174 rows at **~2 ms** on the M1 against 44–48 ms in a clone. Optimising a term that is already ~2 ms in the field, by adding a second CGRect-parsing path to a certified script, buys nothing where it matters and adds a shape to get wrong. Recorded so the next campaign does not re-derive it.

---

## §4 — The census, sparse against the sweep (`reads`)

The SHIPPED sweep and the SHIPPED sparse census, dispatched back to back against the SAME live state, with the consumer output compared through the shipped consumer functions (`areaRowsInOrder`, `slotPitch`, `sectionsInSpan`, `boundaryAboveRow`, `boundaryBelowLast`, `sourceGroupSpan`, `medianSpacerHeight`, `scrollableSpan`).

| state | sweep | sparse (section starts) | sparse (carried) | consumer output |
|---|---|---|---|---|
| top boundary | 888 calls / **190 realized** | 431 / **22** | 373 / **16** | **IDENTICAL** |
| mid-scroll | 888 / 190 | 431 / 22 | 373 / 16 | **IDENTICAL** |
| bottom boundary | 888 / 190 | 431 / 22 | 373 / 16 | **IDENTICAL** |
| one wall folded (115 rows) | 699 / 127 | 368 / 22 | 310 / 16 | **IDENTICAL** |

Identical on the ROUTED arm too, state for state.

**LAW (VOPAT2PR2-4).** *The sparse census is not an approximation — it is the same answer for **11.9× fewer rows realized** and **2.4× fewer round-trips**.* 16 realized against 190, 16/16 areas found, every derived quantity byte-identical, in every state the ladder meets. On the field's rates that is **1.8 s of reads against 21.9 s**, per census.

**LAW (VOPAT2PR2-5).** *A census with NO prediction is already most of the win.* The section-start candidate set costs 22 realized rows against the carried prediction's 16 — a 27 % premium on a term that is 11× smaller than it was. The database's arithmetic is worth having (§5) but the geometry alone gets the first census of a drive to within a few rows of the best case.

---

## §5 — The database's own arithmetic (`dbpredict`)

VOPAT1 §8 R1's model: `headerRows` fixed rows, then per area in `TMArea."index", uuid` order an optional spacer, the area's row, and — unless folded — one row per rendered project. Fitted against a live sweep:

| state | `collapsedAreaUUIDs` | fit | verdict |
|---|---|---|---|
| all expanded, 178 rows | *(empty)* | `headerRows=12, spacerPerSection=true` | **16/16 ordinals EXACT** |
| `Theta` folded, 115 rows | 1 uuid (`Theta`) | the same fit | **16/16 ordinals EXACT** |

**LAW (VOPAT2PR2-6).** *`collapsedAreaUUIDs` reflects LIVE state, and the database's arithmetic reproduces the sidebar exactly once it is consulted.* The brief's stop-condition — "the collapse preference does not reflect live state" — is answered NO. The model is sound and the preference is faithful.

**…but it LAGS, and that has bitten this campaign twice.** Things writes the key lazily: after a drive that folded and re-expanded two sections, the sidebar rendered all 178 rows immediately while the preference still held a uuid **more than two seconds later**, and was empty when the read was repeated. So the preference is where a fold LIVES and the row count is what says whether one is live NOW. Both cells that watch a fold were rewritten around that: the restoration check polls the preference behind the row count, and the abort cell triggers on the row count alone.

**Why the production census predicts from GEOMETRY rather than from this model, and why the model still ships.** The geometry route needs no `headerRows` constant, no per-area project-count query, and no preference read at all — three fewer things a Things update can silently change — and §4 measures it at 22 realized rows against the model's 16. `predictAreaOrdinalsFromDb` ships as a tested pure function with every build-dependent term as a parameter, because it is the predictor that survives a sidebar whose spacers move; it is not on the drive's hot path today, and this cell is what would notice if the geometry route ever stopped being enough.

---

## §6 — What the sidebar announces (`notify`)

An `AXObserver` armed on the application element, one actuation per cell at a recorded mark.

| # | actuation | fired | hits |
|---|---|---|---:|
| a | **nothing**, 2 s | — (`reason=timeout`, `seen=0`) | 0 |
| b | scroll bar `AXValue := 0.4`, and back | **`AXValueChanged:AXScrollBar`** | 1, 1 |
| c | chevron click → collapse | **`AXRowCountChanged:AXTable`** | **65** |
| c′ | chevron click → expand | **`AXRowCountChanged:AXTable`** | **65** |
| d | a whole `area reorder` drive (the DROP) | **`AXRowCountChanged:AXTable`** | **350** |
| d | " | `AXValueChanged:AXScrollBar` | 81 |
| d | " | `AXUIElementDestroyed` | 199 |
| d | " | `AXCreated:AXWindow` | 5 |
| d | " | `AXSelectedRowsChanged` | **never** |
| d | " | `AXLayoutChanged` | **never** |

**LAW (VOPAT1-7, CONFIRMED at last).** *A scroll's only observable is the scroll bar's own `AXValueChanged`.* VOPAT2 §2 could not test it — the unseeded golden's sidebar has no scroll bar and the write failed with AXError −1719, so the silence that followed was the silence of an actuation that never happened. Seeded, it fires, once per write, both directions.

**LAW (VOPAT1-8, CONFIRMED at field scale).** *A fold announces itself once per row* — 65 arrivals for a 65-row section, both directions.

**LAW (VOPAT2PR2-7) — the drop, measured for the first time.** *A drop is loud, and two plausible observables are silent.* The table's `AXRowCountChanged` is the usable one. `AXSelectedRowsChanged` never fires (a reorder selects nothing) and `AXLayoutChanged` never fires — **VOPAT1-12 for the third campaign running**. Neither is named in the shipped settle: an observable a settle waits on that the app never posts is what VOPAT2 §5.1 spent a 2 s budget learning, and the fix is not to write it down again.

---

## §7 — Certification (`e2e`, `abort`, `hidden`)

Through the production CLI, against the guest SQLite oracle, with `THINGS_API_TRACE=1` read back per move. **Every cell run on BOTH arms**: direct execution on `golden-v4`, and DEPUTY-ROUTED on `golden-v4h` with the helpers installed, granted and `helpers-enabled true`. The pointer is parked adversarially — off the sidebar at (5,5) for the first three cells, on it at (120,200) for the rest.

### The moves (routed arm shown; the direct arm is in the run log and agrees)

| cell | command | censuses (sparse/sweep) | round-trips | rows realized | settles | verdict |
|---|---|---|---:|---:|---|---|
| to-last, two walls | `reorder Alpha --end` | 3 (3/0) | 1,177 | 54 | 2 observed | **PASS** |
| to-first | `reorder Mu --end` | 9 (8/1) | 3,605 | 282 | 5 observed | **PASS** |
| mid, before | `area reorder Beta --before Iota` | 7 (7/0) | 2,506 | 126 | 4 observed | **PASS** |
| mid, after | `area reorder Kappa --after Eta` | 22 (22/0) | 6,586 | 374 | 14 observed | **PASS** |
| duplicate NAME | `area reorder Twin --first` | — | — | — | — | **REFUSED**, exit 4, `blocked:H-UNKNOWN-DESTINATION`, nothing driven |
| duplicate pair by UUID | `area reorder <uuid> --last` | 27 (26/1) | 8,174 | 515 | 17 observed | **PASS** |

Every cell: `TMArea` count invariant **PASS**, assignments digest invariant **PASS**, disclosure restored **YES** (178 rows and an empty `collapsedAreaUUIDs`), **0 alert beeps**. **Every settle on every cell of both arms: observed. Zero missed, zero timers.**

**The routed arm gets the notifications too, and that is new.** `transport: deputy`, `registered 16/16`, `armMs 112` — [DEPOBS1](depobs1-deputy-observer.md) landed first, so the field-shaped host class no longer falls back to fixed waits for the settles node makes. This is the first campaign in which the maintainer's own host class is certified with the observer live rather than standing down (#695/#698).

### The escalation fired in a real drive, twice, and worked

```
carried  ok=False esc=True  miss=only 15 of 16 area row(s) were identified
sweep    ok=True  esc=False rows=65 realized=77 calls=551 areas=16
```

**LAW (VOPAT2PR2-8).** *The correctness floor is not theoretical — it was exercised by the certification itself.* Two of the twelve certified moves hit a prediction that did not confirm mid-drive (both while a duplicate-titled area was crossing its sibling), escalated to the full depth-2 sweep in the same census slot, re-established the map and landed the move with every invariant intact. The miss is named in the trace; nothing was assumed.

### `abort` — a killed drive, and what the contract actually says

The fold lands in 2 s (rows 178 → 115); the drive is SIGKILLed; the sidebar stays folded and `collapsedAreaUUIDs` holds the uuid. **That is expected and is the contract**: no `finally` runs in a process that is gone, which is exactly why the disclosure state is DISCLOSED in the result rather than assumed (SBCOL1 §6). What must hold, and does: the residue is real and visible, and a later drive on the folded sidebar works normally (`Alpha --last`, landed, invariants PASS) and leaves the residue alone rather than adopting it.

### `hidden` — SBRES1 under a sparse census

The sidebar is hidden through the View menu; the sweep reports `sidebar-hidden`; the drive shows it, moves the area, folds and restores the wall, and hides it again. **PASS on both arms** — the sparse census detects the hidden state from the same pane-overlap geometry the sweep does, because that check never needed content.

---

## §8 — The cost model, extended

SBCHV1 §6's table with this PR's **measured** row. The lab column is this campaign's measured move (`reorder <area> --end` across two walls, 178 rows); the field column prices the same move's own counts at the M1's measured rates.

| | AX round-trips | rows realized | fixed timers | lab | **field @18.6 ms/call** | **field @115 ms/row realized** |
|---|---:|---:|---:|---:|---:|---:|
| **A** — 0.20.3 (depth-6 chevron matcher) | ~62,000 | — | 7.2 s | ~52 s | **~19 min** | — |
| **B** — SBCHV1 (batched matcher + scaled budgets) | ~44,000 | — | 7.2 s | 39.5 s | **~14 min** | — |
| **C** — B + `AXVisibleRows`-bounded reads | ~4,000 | ~300 | 7.2 s | ~10 s | ~82 s | ~35 s |
| **D** — C + DB-derived sparse confirm | ~1,200 | ~84 | 7.2 s | ~8 s | ~30 s | ~10 s |
| **E** — collapse-ALL, 18 actuations, sparse reads | ~1,500 | ~84 | ~23 s | ~24 s | ~51 s | ~33 s |
| **F — THIS PR, sweep census (the A/B control)** | **2,664** (measured) | **570** (measured) | ~4.4 s | **5.3 s** (measured) | 49.6 s | **65.5 s** |
| **F′ — THIS PR, sparse census + observer settles** | **1,177** (measured) | **54** (measured) | ~1.2 s | **3.0 s** (measured) | **21.9 s** | **6.2 s** |

Read the last two rows together: they are the SAME move, on the SAME fixture, minutes apart, with one environment variable between them.

- **Round-trips per move: 2,664 → 1,177 (2.3×). Rows realized per move: 570 → 54 (10.6×).**
- **Per census: 888 → 392 round-trips, 190 → 18 rows realized.**
- The field estimate for the whole move's reads is **6.2 s** by the rows-realized law and **21.9 s** by the round-trip law. The two laws disagree by 3.5× and VOPAT1 §7 says which one is measuring the real thing: geometry calls are ~free on the M1 (174 rows in ~2 ms), so the round-trip figure is a **pessimistic bound** that prices free calls as if they cost 18.6 ms. The honest estimate is the rows-realized one.
- A harder move — the 22-census `mid-after` — measures **6,584 round-trips / 374 rows realized**, i.e. **43 s** of field reads by the rows law. Against the field's own **436.5 s** for a comparable one-wall move on 0.20.8, that is the shape of the win: **an order of magnitude, not a constant factor** — and it is a floor set by how many times the LADDER censuses, not by what a census costs.

**What this does NOT reach.** VOPAT1 modelled 4.5 s for a whole move on the assumption of **13 rows realized per MOVE**. This PR realizes 16–19 rows per **CENSUS** and the ladder takes 3–27 of them, so the move-level term is 54–515 rows. The remaining factor is not read cost — it is **census count**, and every one of those censuses is the ladder re-reading after a gesture it already knows the shape of. That is the term the next decision is about, and §9 prices it.

---

## §9 — The number the next decision needs

Mike's proposal (up-next, 2026-09-03) is **fold every area first, then one drag**. SBCHV1 §6 rejected collapse-all because 18 chevron actuations cost 22.3 s of FIXED 1.24 s timers. Two of that model's inputs are now measured differently:

- **A fold's settle is no longer a fixed 1.24 s.** Measured this campaign: 300 + 90 + 250 ms of certified in-script rig timers, then the app's own `AXRowCountChanged` at **~670 ms** (lab) instead of a 600 ms blind wait. The fixed-timer term per actuation is ~640 ms, not 1,240 ms, and the settle is a closed loop rather than a clock.
- **A census is 18 rows realized, not 190.**

At the field's rates, for a 16-area sidebar:

| | gestures | censuses | rows realized | **field reads** | fixed timers | **field total** |
|---|---:|---:|---:|---:|---:|---:|
| **F′ measured, one wall, to-end** | 1 drag + 2 chevrons + 1 scroll | 3 | 54 | 6.2 s | ~1.2 s | **~7.4 s** |
| **F′ measured, worst cell (mid-after)** | 3 drags + 4 chevrons + 7 scrolls | 22 | 374 | 43.0 s | ~5.5 s | **~48 s** |
| **fold-all then one drag** (modelled) | 15 folds + 1 drag + 15 restores | ~5 | ~90 | **10.4 s** | 31 × 0.64 s ≈ **19.8 s** | **~30 s** |

**The model still says no, and now it says so for a different reason.** Collapse-all's read term is genuinely small — the fully folded sidebar is ~21 rows and the move degenerates to rung 1 — but 31 actuations at a REPX1-certified 640 ms of in-script rig timers is ~20 s that no observer can remove, because those timers are the press/release/MOVED settles the gesture itself is made of. It beats the worst measured cell (~48 s) and loses badly to the common one (~7.4 s), so adopting it would make the typical move four times slower to make the rare one faster.

**The lever that is left is census COUNT.** The ladder censuses 3 times for a rung-1 move and 22–27 for a multi-hop one, and every census after a gesture re-reads a layout whose delta is already known (a fold's row count, a drop's new database order). This PR carries the map through a reorder and invalidates it on a fold; carrying it through a fold as well — the delta is measured by the census that confirms the fold — is the next honest cut, and it is worth about 40 % of the remaining reads on the multi-hop cells. **Recommended over collapse-all; the maintainer's call, and the numbers are above.**

---

## §10 — Operator notes

**(a) `plutil -extract <array> raw` prints the element COUNT, not the elements.** The first cut of `dbpredict` fed the string `1` to the model as a uuid and reported a MISMATCH the model had not made — the folded-state fit went from 16/16 to 7/16, with the deltas all exactly −63 (Theta's project count), which is what a correct model with a missing collapse set looks like. `xml1` plus the `<string>` bodies is the set. **A rig that mis-reads its own oracle produces a finding shaped exactly like a real defect.**

**(b) The preference lags the sidebar, in both directions.** See §5. Any cell that watches a fold must watch the ROW COUNT.

**(c) A restoration check that compares per-section row counts is wrong, and SBCHV1 §8.2 already said so.** The last area's section runs to the table bottom, so a move that reorders areas swaps neighbouring counts and the check reports NO for a sidebar that is perfectly restored. Total row count plus an empty `collapsedAreaUUIDs` is the honest oracle.

**(d) Toggling every chevron is not "expand all" — it is "invert".** The deterministic fixture reset is to empty `collapsedAreaUUIDs` in the GROUP CONTAINER plist with Things closed and relaunch. The `defaults` user domain of the same name is a different file and deleting the key there does nothing.

**(e) A cell whose move is already satisfied certifies nothing.** Four cells of the second e2e run reported a 1 ms move with zero censuses, because the previous run had left those areas where the command aimed them. The cells now read the live order and aim at the end the area is not at.

**(f) A backtick in a JXA comment inside a TypeScript template literal terminates the literal.** VOPAT2 §9(a) recorded this and it bit again here, in a comment naming a function. `npm run typecheck` catches it.

---

## §11 — Run log

Direct arm (`vopat2pr2-lab`, golden-v4): `setup` → `seed` (16 areas / 138 project rows / 178 sidebar rows) → `shape` → `axrows` → `reads` → `dbpredict` → `notify` → `e2e` (×3, the first two exposing operator notes (a)/(c)/(e)) → `e2e` with `SPARSE=0` (the A/B control) → `abort` → `hidden` → `teardown`.

Routed arm (`vopat2pr2-routed`, golden-v4h, helpers 1.4.0 granted + routing enabled): `setup` → `seed` → `shape` → `reads` → `e2e` → `hidden` → `teardown`.

Both clones destroyed; `tart list` holds goldens only. Artifacts (gitignored): `lab/artifacts/vopat2pr2-lab/`, `lab/artifacts/vopat2pr2-routed/`.
