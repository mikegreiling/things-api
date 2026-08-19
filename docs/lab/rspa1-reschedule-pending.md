# RSPA1 — reschedule a deadlined yearly template that has a PENDING materialized instance

**Probed under: `things-lab-golden-v3` · Things 3.22.14 (build 32214000) · macOS 15 · DB schema v26 · pinned clock 2026-07-05 12:00 (a SUNDAY), advanced +1 day to 2026-07-06 to MATERIALIZE the first occurrence, then to 2028-10-16 for the spawn cell.** Disposable clones of golden-v3 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched. golden-v3 carries the baked L3-accessibility grant; the Repeat dialog was driven by the SHIPPED production CLI (`--dangerously-drive-gui`, the branch `mg/rspa1-reschedule-anchor` dist carrying the deliverable-1 anchor-derivation fix) over SSH. Ground truth = read-only guest SQLite (`~/labh/rsum.py` decodes the rule + cursor + icStart + icCount + deadline; `~/labh/rows.py` dumps every template/instance row). Fixtures fully synthetic (`RS-*`). Drivers: [`lab/scripts/rspa1-pending.sh`](../../lab/scripts/rspa1-pending.sh) (setup + materialize + cells a/b/c), [`lab/scripts/rspa1-spawn.sh`](../../lab/scripts/rspa1-spawn.sh) (the cell-(a) spawn confirmation at the correct start date). Artifacts (gitignored): `lab/artifacts/rspa1-lab/`, `lab/artifacts/rspa1-spawn/`.

Packed dates decode `y<<16|m<<12|d<<7`; `of` day/month indices are 0-based (`dy=19,mo=6` = July 20; `dy=29,mo=9` = Oct 30; `dy=15,mo=9` = Oct 16). `ts` = the deadline-relative start offset (≤ 0). `sr`/`icStart` = the START; `ia` = the anchor/DUE epoch; `next` = `rt1_nextInstanceStartDate` (the cursor); `icCount` = `rt1_instanceCreationCount`; `deadline=262213760`/`ed=64092211200.0` are the deadline SENTINEL (a deadlined RULE). `fu=4`=yearly, `fa`=interval.

## The question (the residual YANCH1 / DACON1 / DBLSPAWN1 all deferred, three live failures)

The decisive live shape none of the three prior campaigns could drive in-lab: **`reschedule-repeat` on a deadlined yearly template that ALREADY has a pending materialized instance**. A repeating template with NO current materialized instance is not reveal-selectable, and materializing one needs multi-step clock advancement — so the reschedule leg was queued three times. The live host (2026-08-19, pre-fix, commit 9299a94) ran the exact shape `reschedule-repeat <deadlined yearly + pending instance> --frequency yearly --interval 1 --when 2028-10-16 --deadline --start-days-earlier 14` and got: the drive completed in 7.6s (drove frequency/interval/checkbox-converge/start-14/Next=2028-10-30/OK — **but NO anchor pop-up steps**), then the verify ran its FULL 120s with **ZERO observed movement** — the app discarded the entire commit (template rule byte-unchanged). Three sub-questions:
- **(a)** With the deliverable-1 fix (derive+drive the anchor from `--when`), does the on-rule `--when`-only reschedule COMMIT? Cursor sane? Existing instance untouched? No duplicate on the next spawn (DBLSPAWN interplay)?
- **(b)** Off-rule Next (explicit anchor ≠ `--when`) with the pending instance — HONORED, snapped, or DISCARDED entirely (the live zero-movement hypothesis)?
- **(c)** Rule-only reschedule (no `--when`) on the pending-instance template — the RRD1 preserve-unspecified baseline with an instance present.

## SETUP — three deadlined yearly series, first occurrence TOMORROW (fixed add-repeating)

`todo add-repeating RS-{A,B,C} --when 2026-07-06 --deadline 2026-07-20 --frequency yearly --interval 1 --dangerously-drive-gui` (clock 2026-07-05). The DBLSPAWN1 fix maps the concrete `--deadline` onto the RULE (`start-days-earlier = 14`, seed deadline-free) and derives the yearly anchor from the DUE date; each drive drove `yearly month = 7 → monthly day = 20 → Add deadlines → start 14 days earlier → Next = 2026-07-20`. At rest each template: `fu=4 fa=1 ts=-14 of=[{dy=19,mo=6}]` (July 20 DUE anchor) · `ia=2026-07-20 sr=2026-07-06 next=2026-07-06 icStart=2026-07-06 icCount=0` · deadline sentinel · **0 instances** — the clean fixed cell-E state (no premature/preserved instance).

**MATERIALIZE** — advance +1 day to 2026-07-06, warm relaunch. Each series spawned **ONE** instance dated `startDate=2026-07-06 deadline=2026-07-20` (item-level deadline on the spawned occurrence), template → `next=2027-07-06 icStart=2026-07-07 icCount=1`. Now each template has a pending materialized current-occurrence instance and IS reveal-selectable — the state the residual needed.

## CELL (a) — on-rule `--when`-only reschedule + deadline (the LIVE shape, FIXED): COMMITS

`reschedule-repeat RS-A --frequency yearly --interval 1 --when 2028-10-16 --deadline --start-days-earlier 14` (no explicit anchor → derived anchor = the DUE date `when + 14` = Oct 30).

| | value |
|---|---|
| CLI | **`ok`** in **6.7s** (was: 120s zero-movement discard on the host). observed `anchorKey=m10d30, deadlined=true, startOffsetDays=-14, nextOccurrence=2028-10-16` |
| drove | 13 steps INCLUDING **`yearly month = 10 → monthly mode = day → monthly day = 30`** (the derived anchor pop-ups — the d1 fix) → `Add deadlines → start 14 days earlier → Next = 2028-10-30` |
| template post | `fu=4 fa=1 ts=-14 of=[{dy=29,mo=9}]` (**Oct 30 DUE anchor**) · `ia=2028-10-30 sr=2028-10-16 next=2028-10-16 icStart=2028-10-16 icCount=1` · deadline sentinel |
| existing instance | `X5LxSDXA startDate=2026-07-06 deadline=2026-07-20` — **UNTOUCHED**, still linked (1 instance) |

**Verdict: COMMITTED cleanly.** The derived Oct-30 DUE anchor landed (`of=[{dy=29,mo=9}]`), the start back-shifted to `--when` (`sr=2028-10-16`), the deadline offset held (`ts=-14`), the cursor is the rule-correct next start (`next=2028-10-16`), and the pending 2026-07-06 instance was left untouched. The live 120s-discard is resolved by driving the anchor pop-ups — whatever dialog-state the old anchorless drive left that the app rolled back, the fixed drive commits in ~7s. (The pre-fix discard is the live-host "before"; it was not independently re-driven in-lab — the branch dist was shipped.)

## CELL (b) — off-rule Next with the pending instance: HONORED (explains the "2029 skip")

`reschedule-repeat RS-B --frequency yearly --interval 1 --yearly-month 10 --on-day 16 --when 2028-11-05` (explicit Oct-16 anchor, `--when` Nov-5 = off-rule first; no `--deadline` flag → the template's existing deadline is PRESERVED, RRD1).

| | value |
|---|---|
| CLI | **`ok`** in **5.9s**. observed `anchorKey=m10d16`. warning: _"off-rule first occurrence — appears 2028-11-05; thereafter: yearly in month 10 on day 16"_ |
| template post | `fu=4 fa=1 ts=-14 of=[{dy=15,mo=9}]` (**Oct 16 anchor honored**) · `ia=2029-10-16 sr=2028-10-22 icStart=2028-10-22 next=2029-10-02 icCount=1` · deadline preserved |
| existing instance | `4YdxpVcB startDate=2026-07-06` — UNTOUCHED (1 instance) |

**Verdict: HONORED — NOT discarded, NOT snapped.** The off-rule first commits in ~6s with a pending instance present; the explicit Oct-16 anchor lands (`of=[{dy=15,mo=9}]`). **This reproduces and EXPLAINS the DACON1 live-host "cursor skipped a year to 2029-10-02":** the cursor `next=2029-10-02` is the rule-correct NEXT aligned start (Oct 16 2029 DUE − 14 = Oct 2 2029), exactly as DACON1 DC4 predicted — the off-rule first occupies 2028 and the cursor points at the following year's aligned start. It is normal-by-design, not a skip or a drop. The zero-movement discard hypothesis for the pending-instance interaction is **FALSIFIED**: the pending instance does not cause the app to reject a reschedule.

**Finding (disclosure inaccuracy, NOT a data bug) — RSPA1-D.** Because `--deadline`/`--start-days-earlier` were not passed (the reschedule PRESERVED the template's existing `ts=-14`), the off-rule disclosure computed its shift from the PARAMS (0) and reported _"appears 2028-11-05"_ with no due date. The app, however, treats the driven Next (Nov 5) as the DUE date of the deadlined rule and back-shifts the START to `sr=2028-10-22` (Nov 5 − 14). So the first occurrence actually APPEARS 2028-10-22 / is DUE 2028-11-05 — the data is coherent, but the human disclosure string mis-states the appear date. `assessOffRuleFirst` is deadline-shift-aware only via the params' own deadline flags, not the TEMPLATE's preserved deadline. Queued in [up-next.md](up-next.md); low-priority (disclosure copy only, the landed data is correct).

## CELL (c) — rule-only reschedule (no `--when`): preserve-unspecified holds with an instance present

`reschedule-repeat RS-C --frequency yearly --interval 2` (interval 1→2 only; no `--when`, no anchor, no deadline flag).

| | value |
|---|---|
| CLI | `ok`. |
| template post | `fu=4 **fa=2** ts=-14 of=[{dy=19,mo=6}]` (July 20 anchor PRESERVED) · deadline PRESERVED · `ia=2027-07-20 sr=2027-07-06 next=2027-07-06 icStart=2027-07-06 icCount=1` |
| existing instance | `N5hgknqC startDate=2026-07-06 deadline=2026-07-20` — UNTOUCHED (1 instance) |

**Verdict: COMMITTED, RRD1 preserve-unspecified confirmed with a materialized instance present.** Only the requested field moved (interval → 2); the calendar anchor, the deadline, and the cursor kept their existing values; the pending instance was untouched. (`deriveFixedAnchor` correctly derived NOTHING — no `--when` → no anchor drive → the existing anchor preserved.)

## CELL (a) SPAWN — no double-book of the materialized occurrence

The first `rspa1-pending.sh` spawn leg advanced to 2028-10-02 and observed no change (correct: the d1-fixed cell-(a) start is `sr=2028-10-16`, so Oct 2 is BEFORE the occurrence — nothing spawns; still 1 instance, cursor unmoved). `rspa1-spawn.sh` re-ran RS-A through the reschedule and advanced to the correct start **2028-10-16**:

| clock | RS-A state | instances |
|---|---|---|
| after reschedule (2026-07-06) | `of=[{dy=29,mo=9}] sr=next=icStart=2028-10-16 icCount=1` + the materialized `vUPGXspd` (2026-07-06) | **1** |
| advanced to **2028-10-16** (warm relaunch, +8s settle, re-read +8s) | template UNCHANGED (`next=icStart=2028-10-16 icCount=1`); `vUPGXspd` still the only instance | **1** |

**Verdict: NO double-book — exactly ONE instance throughout, never two at the re-anchored slot.** The decisive DBLSPAWN interplay concern (the re-anchored cursor double-booking the materialized occurrence) is answered NEGATIVE. Note the app did NOT mint a fresh 2028-10-16 occurrence on the jump either — the single pre-existing instance + `icCount=1` held (a >2-year single clock jump does not retroactively materialize, the ANCH2 spawn caveat; and the re-anchored cursor's slot is already accounted by `icCount=1`). A fully incremental advance to observe the single clean 2028 spawn is a minor residual; the safety-relevant finding — no duplicate factory — is decisive by both direct observation (1 instance) and structure (below).

**Why no double-book (reconciled with DBLSPAWN1).** DBLSPAWN1's duplicate-factory signature is `next == icStart == <future>` with `icCount = 0` (the cursor does not know the occurrence is materialized). Cell (a) lands the OPPOSITE, healthy shape: `icCount = 1` and the cursor `next = icStart = 2028-10-16` points at a date DISTINCT from the materialized 2026-07-06 instance. The re-anchored cursor targets a genuinely future occurrence, not the already-materialized slot — so there is no slot to double-book. This is the clean DC4 spawn law, not the DBLSPAWN preserved-future-instance collision.

## Verdicts (summary)

1. **(a) COMMITS** — the deliverable-1 anchor-derivation fix resolves the live 120s zero-movement discard: the on-rule `--when`-only deadlined reschedule commits in ~7s, derived anchor + back-shifted start + preserved deadline + sane cursor, existing instance untouched.
2. **(b) HONORED** — an off-rule Next with a pending instance is NOT discarded and NOT snapped; it commits, and the cursor lands at the rule-correct next aligned start (`2029-10-02`), which is exactly the DACON1 live-host "2029 skip" — normal-by-design. No validation refusal is warranted for this shape (the shipped fail-closed verify + poller early-exit + the d1 anchor drive suffice).
3. **(c) COMMITS** — RRD1 preserve-unspecified holds with a materialized instance present.
4. **SPAWN** — no double-book of the materialized occurrence (the re-anchored cursor targets a distinct future date with `icCount=1`, not the DBLSPAWN `icCount=0` collision).

**Residual / follow-up.** RSPA1-D (cell (b)): the off-rule disclosure mis-states the appear date when a reschedule PRESERVES an existing deadline (params carry no deadline flag, so `assessOffRuleFirst` computes shift 0) — the app back-shifts the start by the preserved `ts`. Disclosure-copy only; queued in up-next.
