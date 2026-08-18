# DBLSPAWN1 — the double-booked preserved-instance (deadline on the seed)

**Probed under: `things-lab-golden-v3` · Things 3.22.14 (build 32214000) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00, advanced +1 day to 2026-07-06 for the spawn cell.** Disposable clones of golden-v3 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched. golden-v3 carries the baked L3-accessibility grant; the Repeat dialog was driven by the SHIPPED production CLI (`--dangerously-drive-gui`) over SSH. Ground truth = read-only guest SQLite (`~/labh/rsum.py` decodes the rule + cursor + icStart + icCount + deadline; `~/labh/rows.py` dumps every template/instance row). Fixtures fully synthetic (`DBS-*`). Drivers: [`lab/scripts/dblspawn1-repro.sh`](../../lab/scripts/dblspawn1-repro.sh) (repro + spawn, UNFIXED dist), [`lab/scripts/dblspawn1-recert.sh`](../../lab/scripts/dblspawn1-recert.sh) (FIXED re-cert). Artifacts (gitignored): `lab/artifacts/dblspawn1-lab/`, `lab/artifacts/dblspawn1-recert/`.

Packed dates decode `y<<16|m<<12|d<<7`; `of` day/month indices are 0-based (`dy=5,mo=6` = July 6); `ts` = the deadline-relative start offset (≤ 0). `icStart` = `rt1_instanceCreationStartDate`, `next` = `rt1_nextInstanceStartDate` (the cursor), `icCount` = `rt1_instanceCreationCount`.

## The live-discovered state (host, 2026-08-18 — ground truth; SYNTHETIC equivalents only committed)

`todo add-repeating "<title>" --when <future> --deadline <concrete date> --frequency yearly …` — the seed carried a CONCRETE item-level deadline. On promote, [SRCFATE](srcfate-reconciliation-sweep.md)'s to-do preserve trigger (a deadline is the sole to-do preserve trigger, RSIM-T) fired: the seed SURVIVED as a linked instance (`rt1_repeatingTemplate` set) dated at the future first occurrence — a future-dated MATERIALIZED instance, a state normal spawning never creates. The template ended with `rt1_nextInstanceStartDate` = that SAME occurrence and `rt1_instanceCreationCount = 0` — the cursor does not know the occurrence is already materialized. Because `add-repeating`'s promote leg drops the rule-level deadline ([AddRepeatingRuleFields](../../src/write/operations.ts)), the concrete `--deadline <date>` also produced NO rule-level deadline (the series' spawned occurrences carry none), which is why the live agent had to follow up with a `reschedule-repeat --deadline --start-days-earlier`.

## The question

1. **Reproduce** the double-booked state (preserved future instance + cursor at the same occurrence + icCount=0) from the composite AND establish it is the app's native law, not our orchestration.
2. **Spawn (decisive):** when the occurrence date ARRIVES, does the app spawn a SECOND instance alongside the preserved one (a duplicate factory), or reconcile/skip (cosmetic double-display that self-heals)?
3. **Fix re-cert:** does the fixed composite produce a single clean series (rule-level deadline, correct start offset, no preserved instance, single spawn on the date)?

## CELL A — reproduce (composite `add-repeating`, UNFIXED dist, golden-v3)

`todo add-repeating 'DBS-A' --when 2026-07-06 --deadline 2026-07-20 --frequency yearly --interval 1 --yearly-month 7 --on-day 6 --dangerously-drive-gui` (clock pinned 2026-07-05; the CLI logged the native drive: "Items ▸ Repeat… → … → Next (first occurrence) = 2026-07-06 → OK"). Landed state (DB-read):

| Row | shape |
|---|---|
| **TEMPLATE** `3D1k4aD3` | `start=2 startDate=None`, rule `tp=0 fu=4 (yearly) of=[{dy=5,mo=6}]` (July 6), **`next=2026-07-06 icStart=2026-07-06 icCount=0` deadline=None** |
| **INSTANCE** `NmCgHnSi` | `start=2` **`startDate=2026-07-06` (future)** `deadline=2026-07-20` (item-level, preserved) `tmplLink=3D1k4aD3` |
| instances linked (non-trashed) | **1** |

The seed was **PRESERVED** (deadline trigger) and relinked as a **future-dated** materialized instance; the template cursor points at the **SAME** date (`next == icStart == 2026-07-06`) with **`icCount = 0`** — the double-booking. The template carries **no** rule deadline (`deadline=None`, `ts=0`): the concrete `--deadline 2026-07-20` did not map to the rule, confirming the second half of the live report.

## GUI-parity — genuine app-created state

The promote leg IS the native Repeat dialog (AX-driven, identical to a human clicking **Items ▸ Repeat…**). [SRCFATE](srcfate-reconciliation-sweep.md) established DETERMINISTICALLY (2/2 every cell, golden-v2, native dialog) that a to-do carrying a deadline is PRESERVED by `make-repeating` (RSIM-T; SF-Tck the checked-checklist sibling). Cell A applies that native dialog to a deadlined, **future-scheduled** seed and observes the novel consequence (future-dated instance + `icCount=0` cursor collision). So a pure-GUI user who creates a to-do with a future `when` + a deadline and then opens **Items ▸ Repeat…** reaches the SAME state — it is app-created, not an artifact of our orchestration. (A separately-driven pure-GUI cell cannot be isolated through the current CLI: the raw destructive native `make-repeating` was deleted per ALPHA-CONTRACT, and `batch` refuses the promote compounds; the composite's promote leg + the SRCFATE law are the parity evidence.)

## CELL C — the decisive spawn cell: DUPLICATE FACTORY

Advanced the clock +1 day (2026-07-05 → **2026-07-06**, the occurrence), quit + warm-relaunched Things, re-read DBS-A:

| Row | POST-advance |
|---|---|
| TEMPLATE `3D1k4aD3` | rule unchanged, **`next=2027-07-06` icStart=2026-07-07 `icCount=1`** |
| INSTANCE `NmCgHnSi` | still present — `startDate=2026-07-06 deadline=2026-07-20` (the preserved one) |
| **INSTANCE `9RPqZjG9`** | **NEWLY SPAWNED** — `start=2 startDate=2026-07-06 deadline=None` (no deadline — a fresh rule spawn) |
| instances linked (non-trashed) | **2** (both dated 2026-07-06) |

**Verdict: a genuine DUPLICATE FACTORY, not cosmetic.** When the date arrived the app spawned a SECOND instance (`icCount` 0→1, cursor advanced to 2027-07-06) ALONGSIDE the preserved one — TWO rows for the same day, one carrying the item deadline and one not. The double-booking is NOT self-healing; it materializes a real duplicate. (Re-read after +8 s settle: identical, 2 instances — stable, not a transient.)

## Why the double-book arises (reconciled with DACON1)

The anomaly is specifically a SEED item-deadline WITHOUT a matching RULE deadline. Contrast [DACON1](dacon1-deadline-contradiction.md) DC3/DC4 (future-first, NO seed preserve): `icStart` = the first occurrence, `next` = the SECOND occurrence (the cursor advanced past the first), no materialized instance, no double-book. Cell A's cursor instead stays at the first occurrence (`next == icStart`) with `icCount=0` because the app relinked the seed as that occurrence as a side-effect of the item-deadline preserve, while the plain rule "does not know" it has been materialized. When the date arrives the rule spawns it again. A properly deadlined RULE (DC4) advances the cursor correctly and never double-books.

## CELL D — boundary (not run; generalization by evidence)

The double-booking is (any SRCFATE preserve trigger) + (future first occurrence). SRCFATE proved the preserve GENERALIZES beyond a deadline to a terminal element (a checked checklist item / completed child, SF-Tck/SF-Pcp). A dedicated future-preserve cell for the checked-checklist trigger was not run: the composites cannot cheaply produce a checked-checklist seed (`add-repeating` births unchecked items; the promote-via-clone `make-repeating` does not reproduce per-item checked state — a CLONE residual — so it would fail to preserve for the wrong reason). The fix's post-promote trash is trigger-agnostic (it keys on the preserve fate + a future instance date, not on WHICH trigger fired), so it covers the terminal-element case without a dedicated cell.

## The fix (branch `mg/dblspawn-preserved-instance`)

1. **`add-repeating` maps a concrete `--deadline <date>` to the RULE** (`runAddRepeatingTodo`): derive `start-days-earlier = deadline − when` and drive the dialog's "Add deadlines" + start-offset, and **strip the deadline from the seed**. The seed is then deadline-free → NOT SRCFATE-preserved → no double-booked future instance, AND the series' occurrences carry the deadline the caller intended (the two-command dance is eliminated). Refused fail-closed: a deadline with a keyword `--when` (no concrete start to offset from) or a deadline before `--when`. The deadline-mode drive mirrors `make-repeating` (Next + anchor from the DUE date `when + N`; verify the START lands on `--when`). After-completion is out of scope (no calendar; the seed keeps its one-off deadline).
2. **`make-repeating` trashes the redundant preserved FUTURE instance post-promote** (`trashRedundantFuturePreservedInstance`, shared by both composites): when the promote PRESERVED the source (`replacedUuid === null`) as a FUTURE-dated instance, trash it inside the txn and disclose in `warnings[]` — the cursor mints the single real occurrence when the date arrives. A today/past-dated preserved instance is the legitimate current occurrence and is left untouched. This is the path for a genuinely item-deadlined (or terminal-element) source the caller owns, where the deadline cannot simply be stripped.
3. **Simulator reconciled** (`applyMakeRepeatingFixed`): the template `instanceCreationCount` follows the plan (1 iff today is the occurrence, else 0) rather than being forced to 1 on any preserve — so a future preserve models `icCount=0` + a materialized future instance (the double-book), matching cell A; and the template's `instanceCreationStartDate`/`nextInstanceStartDate` store the START (deadlined rules back-shift the driven due date), matching DACON1 DC4 (`sr=icStart=`the start).

## CELL E / CELL F — FIXED re-cert (golden-v3, one clone)

**CELL E — fixed `add-repeating` with a concrete `--deadline`.** `todo add-repeating 'DBS-E' --when 2026-07-06 --deadline 2026-07-20 --frequency yearly --interval 1 --dangerously-drive-gui` (NO explicit anchor — derived). At rest (clock 2026-07-05):

| Row | shape |
|---|---|
| **TEMPLATE** `G3BWcaZJ` | rule `tp=0 fu=4 (yearly) **ts=-14** of=[{dy=19,mo=6}]` (July 20 = the DUE anchor, derived from `when + 14`), `next=2026-07-06 icStart=2026-07-06 icCount=0`, **`deadline=4001-01-01`** (the deadline SENTINEL — the RULE is deadlined) |
| instances linked (non-trashed) | **0** — no preserved instance, no double-book |

The concrete `--deadline 2026-07-20` mapped to the RULE (`ts=-14` → start 14 days before the July-20 due anchor = July 6 = `--when`; deadline sentinel set), the seed was deadline-free (deleted, not preserved), and NO materialized future instance exists. **After advancing +1 day to 2026-07-06:** ONE instance `7emJqC2E` (`startDate=2026-07-06 deadline=2026-07-20` — the deadline correctly carried), template `next=2027-07-06 icStart=2026-07-07 icCount=1`. **Exactly ONE occurrence — no duplicate**, and it carries its deadline (contrast cell C's two instances, one deadline-less).

**CELL F — fixed `make-repeating` on a genuinely item-deadlined future source.** `todo add 'DBS-F' --when 2026-07-06 --deadline 2026-07-20` then `todo make-repeating <F> --frequency yearly --interval 1 --dangerously-drive-gui`. The promote (via clone) preserved the deadlined clone as a future instance; the composite trashed it and disclosed:

> _"the source to-do was kept by the app as a pre-materialized first occurrence dated 2026-07-06; because that date is in the future the series would have spawned a DUPLICATE there, so the redundant occurrence was moved to the Trash — the series mints a single occurrence when 2026-07-06 arrives."_

At rest: TEMPLATE `QSR197ai` (plain rule — `make-repeating` carried no `--deadline`), the preserved instance `VrjxF9ks` **trashed** (by the fix), the original `Ei635sr8` **trashed** (by promote-via-clone), **0** non-trashed instances. **After advancing +1 day:** ONE fresh instance `9NPzW7fx` (`startDate=2026-07-06`), template `next=2027-07-06 icCount=1`. **Exactly ONE occurrence — no duplicate.**

## Verdict

The unfixed composite creates a genuine DUPLICATE FACTORY (cell A → cell C: two instances on the date). The fix — `add-repeating` maps the concrete deadline to the RULE (deadline-free seed, no preserve) and `make-repeating` trashes the redundant preserved future instance — makes both paths land a single clean series that spawns exactly ONE occurrence on the date (cells E/F). The app-level duplicate spawn (which a pure-GUI user also hits) is recorded in [things-app-oddities.md §9ff](../things-app-oddities.md); the composite now avoids ever producing the state.
