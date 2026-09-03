# VOPAT2 PR 2 — the sparse sidebar census, and the settles the app volunteers (#676)

**Probed under:** `things-lab-golden-v4` · Things **3.23** (build 32300036) · macOS **15.7.7** (24G720) · DB v27 · `python3` 3.9.6 with the Command Line Tools · clock pinned 2026-07-05 (trial wall 2026-07-18, never approached) · airgapped clone, destroyed at teardown · fixture 100 % synthetic (14 areas incl. a duplicate-title pair / 174 sidebar rows / two oversized sections / a live scroll bar).

Driver: [`lab/scripts/research-vopat2-pr2.sh`](../../lab/scripts/research-vopat2-pr2.sh) (`setup` · `seed` · `topup` · `shape` · `axrows` · `reads` · `dbpredict` · `notify` · `e2e` · `abort` · `hidden` · `teardown`) · rigs: [`vopat2pr2-helper.jxa.js`](../../lab/scripts/vopat2pr2-helper.jxa.js) (the ordinal space, the geometry-cost split), [`sbchv1-helper.jxa.js`](../../lab/scripts/sbchv1-helper.jxa.js) (reused verbatim), [`vopat2pr2-consumers.mjs`](../../lab/scripts/vopat2pr2-consumers.mjs) (the census's consumer contract), [`vopat2pr2-dbmodel.py`](../../lab/scripts/vopat2pr2-dbmodel.py), [`vopat2pr2-rowkinds.py`](../../lab/scripts/vopat2pr2-rowkinds.py), [`vopat2pr2-trace.py`](../../lab/scripts/vopat2pr2-trace.py).

This is the BUILD campaign for [VOPAT1](vopat1-screen-reader-pattern.md) §8 R1–R2 on the SIDEBAR — the surface VOPAT1 called *realization-bound*. [VOPAT2 PR 1](vopat2-screen-reader-build.md) built the settle observer and spent it on the Repeat sheet, which is *transport*-bound; this one spends it, and the sparse read, on the sidebar.

> **Reproducibility, stated plainly.** Lab wall times DO NOT TRANSFER: a clone has no Retina display to realize a custom row view onto, and is ~25× cheaper per AX round-trip than the maintainer's M1 (SBCHV1 §4) and ~200× cheaper per row realized (VOPAT1 §0). What this campaign measures is **AX round-trips**, **rows realized** and **which notifications fire** — all three host-independent — and prices them at the field's own measured constants. Every wall time below is a lab wall time and is labelled as one.

---

## The problem, measured before this PR

| | measured |
|---|---|
| one full-sweep census of a 174-row sidebar | **862 AX round-trips, 186 rows realized** (SBCHV1 §3, VOPAT1 §1) |
| the same census on the maintainer's M1 | **16–18 s**, four times per drive and rising ([#676](https://github.com/mikegreiling/things-api/issues/676)) |
| what the ladder did with it | a census before every scroll iteration, inside every chevron script, after every fold, before every hop |
| a one-wall move to the end, on the M1, v0.20.8, opt-in on (2026-09-03) | **436.5 s** — of which the gestures are ~5 s |

VOPAT1 §7 attributed the field's cost correctly: not the AX protocol (every role reads in ~0.5 ms in the lab, and the field reads *geometry* for 174 rows in ~2 ms), but **realizing a custom row view onto a real display** — ~115 ms per row realized, paid again on every sweep. So the metric that transfers is **ROWS REALIZED**, and the fix is to touch fewer.

---

## The answers, in one table

_(filled from the run log below)_

| Cell | Question | Verdict |
|---|---|---|
| **shape** | are row heights constant per kind, and is every area row a section start? | _pending_ |
| **axrows** | is `AXRows` the same list as the table's `AXChildren` at 174 rows? what does a row's geometry cost? | _pending_ |
| **reads** | does the sparse census give the consumers the same answers as the sweep, in every state? | _pending_ |
| **dbpredict** | does the database's arithmetic predict the ordinals — and does `collapsedAreaUUIDs` follow a live fold? | _pending_ |
| **notify** | does the scroll bar announce (VOPAT1-7, unconfirmed)? the fold (VOPAT1-8)? does a DROP announce anything? | _pending_ |
| **e2e** | do the certification moves land, with the disclosure state and the chrome restored? | _pending_ |
| **abort** | killed mid-ladder, is the sidebar put back? | _pending_ |
| **hidden** | does SBRES1's normalization rung still work on a sparse census? | _pending_ |

---

## §1 — What shipped

**[`src/write/vectors/ui-sidebar-map.ts`](../../src/write/vectors/ui-sidebar-map.ts)** (new) — the arithmetic half of the census: the spacer classification, the section-start candidate set, the database-order alignment, the carry-forward transform and the DB row model. Pure, and unit-tested for what each predictor SAYS when it is wrong, because that is the path the drive depends on.

**The census, in two halves.**

| | before | after |
|---|---|---|
| the snapshot | `resolveSidebar` harvests every candidate pane's rows at depth 2 — 862 round-trips, 186 rows realized | `AXRows` + one batched `AXPosition`+`AXSize` per row (realizes nothing) + content on the predicted area ordinals |
| which rows get content | all of them | the area rows — carried from the previous census, or the section starts the geometry exposes |
| when the prediction is wrong | — | the full depth-2 sweep, unchanged, and the miss is named in the trace |
| the pointerless scroll | opens with a full census to find the scroll bar | pane index + ONE realized row to re-confirm it |
| the wheel fallback | opens with a full census to find the viewport | the same |
| the disclosure click | harvests every row to find one by title | the row's ordinal + ONE realized row (the HXPC1 confirmation) |
| the fold's settle | `delay 0.6` | `AXRowCountChanged` on the table, then 120 ms of quiet (VOPAT1-8) |
| the scroll's settle | the write's own in-script 250 ms | unchanged, plus the scroll bar's `AXValueChanged` RECORDED |
| the drop's settle | straight into the database poll | the table's own observable first, then the same poll |

**Every fallback is the code that shipped before.** With no map — the first census, a mismatch, `THINGS_API_SIDEBAR_SPARSE=0` — each primitive generates its census-addressed script byte for byte, and a unit case asserts the identity rather than an equivalence. With no observer — a deputy-routed Mac, no Command Line Tools, `THINGS_API_AX_OBSERVER=0` — every settle is the fixed wait it always was. Both are SOFT: an unavailable mechanism is a fallback, never a refusal.

**The instrument.** Every sidebar script reports its own `axCalls` and rows `realized`; each census traces `sidebar-census` (source, escalation, miss); each settle traces `ui-settle`; and the drive closes with `sidebar-move-cost` — censuses (sparse vs sweep), escalations, round-trips, rows realized, gestures by kind, and settles by outcome. That record is what the fold-all re-pricing needs, and it is why this campaign can hand the next decision numbers instead of an opinion.

---

## §2 — The fixture

_(pending: the run log's `shape` output — row kinds, heights per kind, section starts, the scroll bar's presence)_

---

## §3 — The ordinal space (`axrows`)

_(pending)_

---

## §4 — The census, sparse against the sweep (`reads`)

_(pending)_

---

## §5 — The database's own arithmetic (`dbpredict`)

_(pending)_

---

## §6 — What the sidebar announces (`notify`)

_(pending)_

---

## §7 — Certification (`e2e`, `abort`, `hidden`)

_(pending)_

---

## §8 — The cost model, extended

SBCHV1 §6's table, with this PR's measured row and its field prediction.

_(pending)_

---

## §9 — Run log

_(pending)_
