# MOVPLC — the `todo move` placement-leg Today rewrite (native `list "Today"` reorder re-stamps the entry cohort)

**Probed under:** golden `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS 15.7.7 · DB schema v26 · guest clock pinned **2026-07-05 12:00**, then rolled forward to **07-06** and **07-07** to manufacture stale `todayIndexReferenceDate` cohorts (the [today-order-research](today-order-research.md) method). Campaign **2026-08-11**, one disposable clone (`lab/artifacts/movplc-lab/`, gitignored — `report.txt` + `final.sqlite`), no crash (Things ALIVE throughout, no DiagnosticReports). Discovery — **DB row deltas are ground truth**. Driver: [`lab/scripts/research-movplc.sh`](../../lab/scripts/research-movplc.sh) (subcommands `setup·loginterval·roll06·roll07·cancel·rawmove·nativereorder·dump`). Host compile-level companion: the wire-capture harness against a `computeReorderPre` fixture. The disposable-VM reproduction the field audit ([docs/research/today-canceled-grouping-audit.md](../research/today-canceled-grouping-audit.md)) called for (its "Assessment and required reproduction", 7 steps).

## The bug

A container-only `todo move` (e.g. `things todo move <uuid> --to-project <P>`) with NO explicit `--first/--last/--before/--after` silently fires its **default placement leg** — a native `_private_experimental_ reorder to dos in list "Today"` over ALL open Today members. The compiled wire is **moved row first, then every other open bucket-0 Today member by raw `todayIndex ASC`** (the `computeReorderPre` `today`-scope census), which is materially different from the user-VISIBLE Today order (the two-level comparator `startBucket ASC, todayIndexReferenceDate DESC, todayIndex ASC` — [atlas](../atlas/schema-v26.md) Today row). In production this rewrote a 277-row Today order that the user never asked to touch; the audit could not capture the native command's WRITE SET because it took no immediate before/after DB snapshot around that first reorder. This campaign captures it.

**Bottom line.** The native `list "Today"` reorder writes BOTH `todayIndex` (to the wire order) **AND re-stamps `todayIndexReferenceDate` → today on every named row**, while leaving `startDate`, `start`, `startBucket`, `status`, `stopDate`, and `userModificationDate` **byte-identical**. The `todayIndexReferenceDate` re-stamp is the mechanism the audit was missing: it **collapses every entry-date cohort into one "today" cohort**, so the visible order stops grouping by entry date and becomes pure `todayIndex` = the wire order. That is why a one-item move rewrote the visible order of hundreds of unrelated rows. The excluded classes behave exactly as predicted: unswept **canceled** rows (status ≠ 0) and stale **evening** (`startBucket=1`) rows are NOT named, keep their old `todayIndexReferenceDate`, and consequently sink below the freshly-collapsed open block (canceled) or to the bottom (evening) — the "regrouping" is a pure by-product, not a semantic rule. The census **leaks derived-trashed children** (own `trashed=0`, project `trashed=1`) into the wire and the native command DOES write their `todayIndex`/`todayIndexReferenceDate`, but they stay invisible in Today (reader derived-trash exclusion). This is the O03 / UPCDL-2a materialize law (`list "Today"` stamps `todayIndexReferenceDate→today` on touched rows) confirmed for the first time on EXISTING multi-cohort Today members, and it settles the audit's open write-set question.

## The wire under test

The undocumented sdef command behind the shipped `today` reorder scope (novel-paths #1), addressed by the `list "Today"` specifier the CLI placement leg compiles ([src/write/commands.ts](../../src/write/commands.ts) reorder spec; [src/write/reorder.ts](../../src/write/reorder.ts) native path):

```
tell application "Things3" to _private_experimental_ reorder to dos in list "Today" with ids "<movee>,<others by todayIndex ASC>"
```

The ids are ONE comma-joined string (the −1700 list-literal law). Every fire captured guest-side `EXIT=<code>`; the reorder returned **`EXIT=0`** (the wire ran; no −1700, no silent no-op).

**How the CLI reaches this wire with no position.** `runTodoMove` → membership leg (`update?id=<movee>&list-id=<P>`) → `finishPlacement` ([src/write/move.ts](../../src/write/move.ts)). With `position === undefined`, `buildReorderOrder` returns just `[movee]`; `runReorder` → `computeReorderPre({scope:"today", uuids:[movee]})` extends that to the full `wireList` = `[movee, …remaining open bucket-0 Today members in todayIndex ASC]` and the native command re-ranks the whole list. The design doc's ratified "destination + no position ⇒ `--first` implied per bucket" ([heading-demotion-and-move.md](../design/heading-demotion-and-move.md) §Bare invocations) is what routes a bare container move through this wire.

## Fixture

Three (in fact five) distinct `todayIndexReferenceDate` cohorts, manufactured by seeding items into Today under a rolled-forward pinned clock (the app never normalizes entry dates — atlas Today row). Golden pre-seeds contributed the 07-03/07-04 cohorts; the campaign added 07-05/07-06/07-07:

- **Open Today to-dos** per cohort: `C5a/b/c` (entered 07-05), `C6a/b/c` (07-06), `C7a/b/c` (07-07), plus a repeat-lineage stand-in `LIN-5`/`LIN-6`/`LIN-7` spread across the three days.
- **`MOVEE`** — a loose to-do scheduled today (07-07), the row that gets container-moved into project **`MOVPLC-DEST`**.
- **Canceled-unswept** rows: `C5b`, `C6b` canceled after `logInterval` was set to **Manually** (AX) so they stay unswept and keep rendering in Today.
- **Stale evening** (`startBucket=1`) rows: `EVE1` (seeded `when=evening` on 07-05) and the golden's `LAB-EVENING-1`.
- **Derived-trashed children**: project **`MOVPLC-TRASH`** over `DTC1`,`DTC2` (both scheduled today), then the PROJECT trashed — children keep own `trashed=0`, project `trashed=1`.

## Step-by-step (byte deltas)

Snapshot columns: `sb`=startBucket, `tIdx`=todayIndex, `tiRef`=todayIndexReferenceDate, `sd`=startDate, `st`=status (0 open / 2 canceled), `tr`=own trashed, `pTr`=project's trashed.

### Baseline (step 1) — the multi-cohort Today, comparator matches the GUI

The DB comparator (`startBucket, tiRef DESC, todayIndex`) reconstructs the GUI `to dos of list "Today"` order exactly for the open rows: cohort 07-07 (`MOVEE, LIN-7, C7c, C7b, C7a, …`), then 07-06, 07-05, 07-04, 07-03, then bucket-1 (`LAB-EVENING-1, EVE1`) at the bottom. The derived-trashed `DTC1/DTC2` (`tr=0 pTr=1`) sit in the DB census at the 07-07 top but are **absent from the GUI order** (reader derived-trash exclusion) — the census/visible split is visible from the first snapshot.

### Step 2 — cancel a subset does NOT reorder

Canceling `C5b` (status 0→2, `tiRef` 07-05, `tIdx=-823`) and `C6b` (0→2, `tiRef` 07-06, `tIdx=-945`): only `status`/`stopDate`/`userModificationDate` change on those two rows. **Every other row is byte-identical** (todayIndex, tiRef, umd). Both canceled rows remain in the Today view (unswept). Cancellation alone reorders nothing — CONFIRMED.

### Step 3 — raw membership move does NOT reorder Today (the control)

`things:///update?id=<MOVEE>&list-id=<MOVPLC-DEST>` (the exact CLI membership leg, no placement): `MOVEE` gains the DEST project FK and bumps `umd`, but **`tIdx=-2562`, `tiRef=07-07`, `sd=07-07`, `sb=0` are all unchanged**, and every other Today row is byte-identical. The GUI order is unchanged (`MOVEE` still at top, at its preserved slot). **The app itself never reorders Today on a container change** — so the placement leg, not the membership write, is the sole cause. (This is also the honest default the fix restores: the movee keeps its Today slot for free.)

### Steps 4–7 — the placement wire, and the write set (the crux)

Compiled wire (movee first, then open bucket-0 members by raw `todayIndex ASC`, INCLUDING the derived-trashed leak):

```
MOVEE, DTC2, DTC1, LIN-6, LIN-7, LIN-5, C6c, C5c, C7c, C7b, LAB-TODAY-1, C6a, C7a, C5a,
LAB-REPEAT-DAILY(07-03), LAB-REPEAT-WEEKLY-PROJ, LAB-REPEAT-DAILY(07-05), LAB-PINNED-TODAY,
LAB-REPEAT-DAILY(07-04), LAB-REPEAT-DAILY(07-06), LAB-REPEAT-DAILY(07-07)
```

Excluded (not named): `C5b`, `C6b` (canceled, status ≠ 0); `EVE1`, `LAB-EVENING-1` (bucket-1, O03). The wire's raw-`todayIndex` order **interleaves the cohorts** (`LIN-6` 07-06, `LIN-7` 07-07, `LIN-5` 07-05 land adjacent) — nothing like the visible cohort order. This IS claim (a).

After firing (`EXIT=0`), per NAMED row:

| Row | tiRef before → after | tIdx before → after | sd | st | umd |
| --- | --- | --- | --- | --- | --- |
| MOVEE | 07-07 → **07-07** | −2562 → −11593 | 07-07 (kept) | 0 | kept |
| LIN-6 | **07-06 → 07-07** | −1966 → −11231 | 07-06 (kept) | 0 | **kept** |
| LIN-5 | **07-05 → 07-07** | −1840 → −10183 | 07-05 (kept) | 0 | **kept** |
| LAB-TODAY-1 | **07-03 → 07-07** | −619 → −7694 | 07-03 (kept) | 0 | **kept** |
| LAB-REPEAT-DAILY | **07-03 → 07-07** | −317 → −6071 | 07-03 (kept) | 0 | kept |
| … (all 21 named) | **→ 07-07** | rewritten to wire order | kept | 0 | kept |

**STEP 5 (the crux, ANSWERED): the native `list "Today"` reorder writes `todayIndex` (to the wire order) AND re-stamps `todayIndexReferenceDate` → today (07-07) on EVERY named row; `startDate`, `start`, `startBucket`, `status`, `stopDate`, and `userModificationDate` are byte-untouched.** The `tiRef` normalization is not incidental — it is the whole visible-order-rewrite mechanism: with every open row now on the 07-07 cohort, the comparator's cohort tier is degenerate and the visible order becomes pure `todayIndex` = the wire order. The GUI after confirms it: `MOVEE, LIN-6, LIN-7, LIN-5, C6c, C5c, C7c, C7b, LAB-TODAY-1, C6a, C7a, C5a, …` — cohorts fully interleaved, the repeat-lineage `LIN-*` now contiguous (the "grouping" the user saw = a by-product of the raw-index population, not a planner rule).

**STEP 6 (invariant violated): a one-item container move rewrote the `todayIndex` + `todayIndexReferenceDate` of all 21 open Today members**, changing the visible position of every unrelated row. The desired invariant — a container-only move must not alter unrelated rows' visible order — is broken by the default placement leg.

**STEP 7:**
- **Stale bucket-1** `EVE1` (`tIdx=0`) and `LAB-EVENING-1` (`tIdx=-149`): excluded, **byte-untouched** (tiRef 07-03, sd, sb, umd all unchanged), sort at the bottom (bucket 1 > bucket 0). Claim (c) CONFIRMED.
- **Canceled** `C5b`, `C6b`: excluded, **byte-untouched** (tIdx −823/−945, tiRef 07-05/07-06). Because their `tiRef` stayed on the OLD cohorts while every open row jumped to 07-07, they now sort BELOW the entire open block (older tiRef → lower in DESC) but above bucket-1 — one near-contiguous canceled band near the bottom. This is exactly the audit's "canceled regrouped into a near-bottom block": claim (b) CONFIRMED, and it is a pure consequence of the open rows' cohort collapse, not a status rule.
- **Derived-trashed** `DTC1`,`DTC2`: **entered the wire** (own `trashed=0` passes the census's own-row-only trashed filter), and the native command **wrote them** (tIdx → −11655/−11768, tiRef → 07-07). They remain **absent from the GUI Today order** (reader derived-trash exclusion), so they do not affect the visible order — but the census leaks them and the app spuriously mutates their bytes. Claim (d) CONFIRMED.

### Host compile-level confirmation (claims a, b, c, d)

A fixture `computeReorderPre({scope:"today", uuids:[MOVEE]})` over a multi-cohort Today with a derived-trashed child returns `wireList = [MOVEE, DTC, C6a, C7a, C5a]` — movee first, then open bucket-0 members by raw `todayIndex ASC` (interleaving cohorts); the derived-trashed `DTC` IS in the wire; the canceled and bucket-1 rows are NOT. The compile-level census leak (d) is deterministic and testable on the host, independent of the app.

## Verdicts against the audit's claims

- **(a) — CONFIRMED (compile + write-effect).** The placement wire is `[movee, …open bucket-0 Today members by raw todayIndex ASC]`, materially different from the visible cohort order; the native command enforces it.
- **(b) — CONFIRMED.** Unswept canceled rows are excluded (status ≠ 0), keep their old `tiRef`, and sink below the collapsed open block; regrouping is a by-product.
- **(c) — CONFIRMED.** Stale `startBucket=1` rows are excluded (O03), stay byte-untouched, and sort last.
- **(d) — CONFIRMED.** The census leaks derived-trashed children (own `trashed=0` only); the native command writes them; the reader still hides them.
- **STEP 5 write set — ANSWERED.** `todayIndex` rewritten to wire order AND `todayIndexReferenceDate` re-stamped → today; `startDate` and all other columns preserved. This is the O03/UPCDL-2a materialize law on existing multi-cohort members, and it is the visible-order-rewrite mechanism.

## Remedy (the fix this evidence gates)

Step 3 proves position preservation is **free**: a container move that skips the placement leg leaves the movee at its existing Today slot and touches nothing else. So the audit's **remedy 1** — a container-only move with no explicit position emits no Today placement reorder — is minimal and intent-matching, and strictly better than remedy 2 (a full VISIBLE-order wire would preserve order but still re-stamp every row's `tiRef`→today, permanently collapsing the cohort structure for a write nobody requested). The fix (PR 2): `finishPlacement` skips the placement reorder when `position` is undefined and the landing is the **today/evening view axis** (the `todayIndex` cohort-collapsing scopes); explicit `--first/--last/--before/--after` are unchanged, and index/day-scope landings keep their documented top-placement (non-damaging, honors the ratified rule where it does no harm). Separately and unconditionally, `computeReorderPre` gains the reader's derived-trash container exclusion (`CONTAINER_UNTRASHED`) so the census stops leaking children of trashed projects on every scope. The all-scopes generalization of remedy 1 (a bare `todo move` never reorders anything) is the honest maximal alternative; it is deferred because it revises the ratified "--first implied" default for non-damaging index buckets too, beyond this bug's evidence.
