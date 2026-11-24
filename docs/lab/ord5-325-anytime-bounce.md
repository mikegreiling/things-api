# ORD-5 on Things 3.25 — the bounce stops using the json collapse, and a reorder can no longer pass a wrong order

**Version stamp:** `things-lab-golden-v6` / `-v6h` (Things **3.25**, build 32500008, DB 30) against `things-lab-golden-v5` / `-v5h` (Things **3.24**, build 32400006, DB 29) · macOS 15.7.7 guests · guest clock pinned 2026-07-05 12:00 · run **2026-11-24** on a macOS 27.0 host. Immutable snapshot per the [harness](harness.md) version-stamping policy. Follows [gv6-325-campaign.md](gv6-325-campaign.md) §6, which recorded the flip and left it unfixed.

**VERDICT: Things 3.25 CERTIFIED on golden-v6 / -v6h** (see §6 for the gate). The anytime bounce lands the requested order on 3.24 and 3.25, every bounce class now checks the whole column before it reports success, and the two CHORD3 cells GV6 could not explain are explained: 11a was cell 9's wrong column, 18b was an undo defect 3.24 had been masking.

---

## 1. The ruling, and what the lab changed about it

Orchestrator ruling (2026-11-24, [decisions.md](../design/decisions.md)): the `anytime` bounce stops using the json collapse on every version; a bounce may never report success on a wrong order; lock both halves in the o-suite; keep the `heading` collapse unless 3.25 breaks it too, in which case apply the same ruling to it.

3.25 breaks it too (§2), so **no bounce class collapses to json any more**. And the 3.25 json behaviour is not the clean "back-insert" GV6 §6 described: it is **intermittent**, which changes what the canary can assert (§4, O40).

## 2. What 3.25 actually does to a json `[someday, anytime]` round-trip (ORD5J, ORD5J-T)

[`lab/guest/ord5-json-cells.sh`](../../lab/guest/ord5-json-cells.sh) dumps every `index` around each leg; [`lab/guest/ord5-json-trials.sh`](../../lab/guest/ord5-json-trials.sh) repeats each shape six times on a fresh column. Both ran through `stage5-rc-run.sh` on golden-v6h and golden-v5h (artifacts `lab/artifacts/ord5j-v6h`, `ord5t-v6h`, `ord5t-v5h`).

| trial set (×6 each) | 3.24 | 3.25 |
|---|---|---|
| TU loose, column seeded by URL `add`, json `[someday, anytime]` on the middle row | 6/6 front | 6/6 front |
| TC loose, column seeded by `things todo add` (GV6BNC's seeding), same json | 6/6 front | **3/6 LAST** (`index` -1000 each time) |
| TS loose, the same two updates as **sequential URL legs** | 6/6 front | 6/6 front |
| TH heading, anchored run `c5 --before c2` as ONE json array (c5, c2, c3, c4) | 6/6 `c1<c5<c2<c3<c4` | **3/6 wrong**: c5 at `index` 0, TIED with c1 |

The ORD5J dump shows the mechanism. A json `[someday]` element alone moves the row into the Someday bucket at that bucket's front (loose: `index` -1000 against a someday min of 0; heading child: 0). A json `[anytime]` element alone then re-inserts it correctly (loose: front, heading: back). Inside ONE array, on 3.25, the `anytime` element **sometimes does not re-insert at all**, so the row keeps its someday-leg index: -1000 for a loose to-do, which is the BOTTOM of a column of negative indices (GV6 §6.2's "index -1000" and both GV6BNC P1/P3 sightings), and 0 for a heading child, which ties it with the first child. On 3.24 the array behaves like the sequential legs every time. Also visible: 3.25 allocates new indices on exact 1000-steps (-6871, -5871, …; heading children 0, 1000, 2000, …), where 3.24 spaced them irregularly.

The sequential URL legs placed correctly in every trial on both versions (TS above, ORD5J L3/H2, o-suite O41–O44, §5).

Why the suites were green: O18 bounces the WHOLE heading block into an empty Someday sub-bucket, so the someday-leg indices alone already come out in array order, whether or not the anytime element re-inserts. Its pass never depended on the part 3.25 broke.

## 3. Why the engine said "ok" on a wrong order, and the fix

**Root cause.** Every bounce-class protocol ended with an `ordering` verify over the touched block alone (`evaluateDelta({ mode: "ordering", sequence: coBounce })` in the json path, the per-item `placed` prefix check in the sequential path, `verifyIndexOrder(coBounce)` in the flag-safe and fallback protocols). That asserts the moved items are in order **relative to each other**, and nothing about where they sit against the rest of the column. A one-item `--start` is a one-element sequence, which is trivially ordered, so P1/cell 9 passed while the item sat last. A multi-item block that kept its own order but landed at the wrong edge would have passed the same way.

**Fix** (`src/write/reorder.ts`, `columnEvaluation` / `verifyColumn`). Each protocol now ends with ONE terminal column check: the touched block strictly in target order on the rank key, AND every untouched member of the planned column on the far side of it (below the block for a front-insert, above it for a back-insert). It is polled like every other verify, so a dispatch the app has not applied yet is waited for. A failure returns the existing `bounce-aborted` result (CLI exit 3, `verify-failed`), naming the untouched rows that sit on the wrong side; nothing reports `ok`. Applied to the sequential bounce, the (now unreachable) json path, heading-someday, and the six flag-safe / fallback move protocols (HEADMOVE, LOOSEPARK, PROJPARK, INBOXBACK, PROJROOT, AREABACK). Unit tests drive a simulated app that re-enters at the wrong edge: a one-item anytime `--start`, a three-item anytime block and a one-item heading `--end` each come back `bounce-aborted` (`test/engine/write-reorder.test.ts`, "ORD-5: a bounce never reports success…").

**Routing.** `BounceSpec.jsonCollapsible` is `false` for `anytime` and `heading`, with no version switch, so no class collapses any more. The json dispatch code path stays in the tree, unreachable; whether to delete it is flagged for a decision (§7).

## 4. New o-suite rows (all self-seeding, raw wire, run on golden-v6)

| id | operation | asserts | 3.25 result |
|---|---|---|---|
| **O40** | `order.bounce-json-collapse-canary` | the heading anchored json run ×12; ≤3.24: `wrong=0/12`; `expectFrom 3.25`: at least one bad run | green: **7/12 wrong** (`o-20261124-202108`), **4/12** in the regress run (`o-20261124-204944`) |
| **O41** | `order.anytime-bounce-single` | URL `someday` then `anytime` on the middle of five: FRONT of the WHOLE loose column | green |
| **O42** | `order.anytime-bounce-multi` | reverse dispatch of 3 into a 5-member column: top three of the whole column are exactly the target | green |
| **O43** | `order.anytime-bounce-anchored` | `O-LC1 --after O-LC4` planned off the live column, the minimal prefix co-bounced in reverse: whole column equals the plan (`run=3`) | green |
| **O44** | `order.heading-bounce-anchored` | heading `c5 --before c2` as sequential URL legs, forward: `c1<c5<c2<c3<c4`, c1 untouched, heading FK 5/5 | green |

O40 departs from the ruling's wording, which asked for "≤3.24 front, ≥3.25 back". 3.25 is not "back"; it is sometimes front and sometimes not. A single-trial back assertion would flake, and a front assertion would pass on a broken app. So the canary counts bad runs over twelve: ≤3.24 must show none (ORD5J-T: 24/24 clean), and 3.25 must show at least one (measured 3/6, 7/12 and 4/12; at a rate near ½, twelve clean runs in a row happen about once in 4000). When a release makes every run clean, the row goes red, and that is the signal to re-measure. The base expectation was not run through the suite on 3.24: the runner hard-codes the active golden. It rests on ORD5J-T's v5h trials.

## 5. The field-shaped path, through the deputy ([`lab/guest/ord5-anytime-cells.sh`](../../lab/guest/ord5-anytime-cells.sh))

Normal CLI syntax, routed guest, helpers installed and granted, every cell checked against the WHOLE loose Anytime column (seed rows included). Same build on both goldens.

| cell | 3.25 (v6h) | 3.24 (v5h) |
|---|---|---|
| dry-run plans `bounce ×1` (no json collapse) | ok | ok |
| GUI off, `--start` N=1 (audit `url-scheme ok`) | ok, 353 ms | ok, 372 ms |
| GUI off, `--start` N=3 | ok, 644 ms | ok, 637 ms |
| GUI off, `--after` anchored (2 siblings co-bounced) | ok, 643 ms | ok, 641 ms |
| GUI off, `--before` anchored | ok | ok |
| GUI off, `--start` N=5 | ok, 1112 ms | ok, 1035 ms |
| GUI off, heading `--end` N=1 | ok, 356 ms | ok, 246 ms |
| GUI off, heading `c5 --before c2` (4 re-entered) | ok, 1047 ms | ok, 1048 ms |
| GUI on (chord), `--start` N=1 (audit `ui ok`) | ok, 3581 ms | ok, 3559 ms |
| GUI on (chord), `--start` N=2 | ok, 6944 ms | ok, 6939 ms |

0 failures and 0 alert beeps on both (`lab/artifacts/ord5-cells-v6h`, `ord5-cells-v5h`).

**What the ruling cost in speed.** Guest-local walls, so not the maintainer's hardware: the json collapse ran CHORD3 cell 9 (N=1) in **172 ms** on 3.25 in GV6 (`gv6-s5-chord`), the sequential bounce runs it in **345 ms** (`ord5-chord3-v6h`; 338 ms on v5h), and 353 ms in the cell above. N=5 is about 1.1 s. That is roughly ×2 at N=1, below the ~7× BOUNCEJSON claimed for larger N.

**GV6BNC P1 re-run** (`lab/guest/gv6-bounce-cells.sh`, fresh clones, this build): **front on both** (`ord5-bnc-v6h`, `ord5-bnc-v5h`). P3, the raw json probe, still lands LAST on 3.25 and front on 3.24.

## 6. Cells 11a and 18b, and the gate

**CHORD3/4 batch** (`lab/guest/stage5-cells-chord.sh`): **63 ok, 0 failures on golden-v6h** (`ord5-chord3-v6h`) and **63 ok on golden-v5h** (`ord5-chord3-v5h`).

- **11a was cell 9's wrong column, verified.** In GV6's red run (`gv6-s5-chord`), cell 9 left `CH3-A3` at `index` -1000: the json someday-leg index, directly below the three seed rows at -999, -997 and -995. Cell 11a then moved `CH3-A2` one slot down past it, Things renumbered a seed row to make room, and the chord driver's single-row-move guard refused (*"⌘↓ … also renumbered to-do 87tz…, which the move never passed over"*). With the fix, cell 9 puts A3 at the front and 11a passes (4146 ms). Nothing in the engine changed for 11a.
- **18b was an undo defect that 3.24 had been masking.** It still failed after the cell 9 fix (`ord5-chord-v6h`, `ord5-chord2-v6h`). The forward Today chord recorded pre-ranks for 7 rows, three of them older-cohort seed rows tied at `todayIndex` 0. The undo named all seven, and its verify demanded a strict `todayIndex` order across the three tied ones. On 3.24 the chord renumbers those rows in passing (-265, -163, 0), so the demand happened to be met. On 3.25 the chord leaves untouched rows alone (0, 0, 0), so the verify failed although the visible order was restored. **Fix** (`src/write/undo.ts`): the inverse leaves out rows whose pre-rank is tied, that the forward op did not name as movees and did not move, and that sort after every row it keeps. Those rows had no order to restore and keep their place, which is what the plan's own note already says. Unit tests in `test/unit/undo-plan.test.ts`. 18b now passes on both (2691 ms on v6h).

**`npm run lab:regress`** with the five new o-suite rows: see §6.1.

### 6.1 Regression sweep

`npm run lab:regress` on golden-v6 / -v6h with this change's code and suites: **ALL GREEN**, exit 0.

| leg | result | run id |
|---|---|---|
| u | 23/23 ok | `u-20261124-204303` |
| a | 39/39 ok | `a-20261124-204535` |
| x | 3/3 ok | `x-20261124-204858` |
| o | **43/43 ok**, including O40 (`wrong=4/12`, the `>=3.25` override) and O41–O44 | `o-20261124-204944` |
| r | 21/21 ok | `r-20261124-205807` |
| e | 19/19 ok | `e-20261124-210008` |
| p | 30/30 ok | `p-20261124-210202` |
| s | 4/4 ok (+2 interactive skipped) | `s-20261124-210515` |
| e2e DIRECT arm (golden-v6) | 133 steps, 0 failures | `things-run-e2e-direct-20261124-150608` |
| e2e ROUTED arm (golden-v6h) | 136 steps, 0 failures + routed GUI smoke 2 steps, 0 failures | `things-run-e2e-routed-20261124-150727` |

0 alert beeps on every leg. With the GV6 sweep (§3 there), the ORD-5 re-route, the routed field-shaped cells on both goldens (§5) and both chord batches green (§6), 3.25 meets the release-gate conditions the lab can certify. Real-hardware latency stays the maintainer's own measurement.

## 7. Flagged for a decision

- **The json collapse path is now unreachable.** `runBounceJsonCollapse` and the `jsonCollapsible` flag remain in `reorder.ts` with no class eligible. Deleting them is a clean-up the ruling did not ask for. Keeping them costs one unexercised branch. Recommendation: delete them, keeping O40 as the canary that would justify bringing them back.
- **O40 is a statistical canary.** Its false-red rate is estimated, not known (three samples: 3/6, 7/12, 4/12, so 14/30 overall).
- **The loose json misplacement depends on how the column was made** (TC 3/6 vs TU 0/6). Not investigated further: the engine no longer sends that wire.

## 8. Operational notes

- Hook refusal: the first probe-generation command carried `things:///` text inside a shell heredoc and was refused by `.claude/hooks/prod-things-guard.sh` (nothing ran). The probes and cell scripts were written with the file editor instead.
- Every clone was torn down by its runner; `tart list` at the end shows exactly v4, v4h, v5, v5h, v6, v6h, all stopped.
