# STEV1 — the stale-evening law: rendering, normalization, rank, and the write shape a reorder needs

STEV1 settles what a **stale evening** row is on every axis a caller can touch. A stale evening row carries `startBucket=1` (This Evening) with a `startDate` that has already passed — a shape the app produces by simply letting a day roll over, and then never cleans ([SIT3 REMSTALE](sit3-arrival-evening-lists.md), oddities §9n).

Motivating bug: **#657**. `things reorder <stale> --in today` refused it as an evening-bucket item, and `--in evening` refused it as a stale one and said to re-schedule it first. Both scopes refused; the item was unreorderable. The read side already called it a Today member, so the view, the membership check and the reorder scopes disagreed. Four cells were needed before any code could be written: what the app RENDERS, whether the app ever REWRITES the row, where it RANKS, and what a reorder has to WRITE.

ONE disposable Tart clone (`stev1-lab`, run 2026-08-31, **Things 3.23 build 32300036**, **DB schema v27**, golden `things-lab-golden-v4` UNTOUCHED; airgapped, no cloud account). Writes go exclusively through official surfaces (the URL scheme, via the shipped CLI and via direct `things:///update` dispatches). Ground truth = guest read-only SQLite (full-row diffs, every column) **plus the AX tree of the Today window** — the census walks every `AXTableRow` AND every `AXStaticText`, sorted by their y ordinate, because a section header is not an `AXTableRow` and a row-only oracle cannot see it ([URLEN1](urlen1-url-scheme-enable.md)'s blind-oracle law applied to sections). Fixtures fully synthetic (`STEV1-*`). Script: [`lab/scripts/research-stev1.sh`](../../lab/scripts/research-stev1.sh) (cells `1 2 3 4` pre-fix, `5 6` post-fix on the same held clone). Evidence (gitignored): `lab/artifacts/stev1-lab/` (`report.txt`, `ax/*.txt`, `snap/*.tsv`).

**The clock.** A stale evening row cannot be minted headlessly — TIMEZ-NODATE says no surface writes `startBucket=1` on any day but the app's current one, so evening and a non-today date are mutually exclusive at write time. The fixture is therefore seeded on day D and the guest clock advanced **one** day to D+1, the [ODDS1-D2](odds1-323-revalidation.md) recipe (`07-05 → 07-08`) bounded to a single step: base pin **2026-07-05 12:00**, roll to **2026-07-06 12:00** — twelve days short of golden-v4's sticky trial wall (2026-07-18, [REPX3](repx3-repeat-expiry.md) §5), which the driver's `setclock` refuses to cross. Date codec is the library's: `07-05`=132805248, `07-06`=132805376; reminder `18:00`=1207959552.

**Status: RAN + WIRED.** The fix is #657 (this same change): one shared placement law, `src/model/today-placement.ts`.

## Verdict table

| Cell | Question | Verdict |
|---|---|---|
| **1 RENDER** | Where does the app put a stale evening row in the Today window? | **Today PROPER, at the BOTTOM of the daytime section, ABOVE the "This Evening" header.** The header still appears (a live evening item was present); the stale rows sat at y=649/677/705 and the header at y=773, with the live evening item alone below it at y=812. The CLI's `things today` renders the same three rows in `★ Today` and the live one alone under `⏾ This Evening` — the reader was already right. |
| **2 NORMALIZE** | Does the app EVER rewrite the stale row? | **NEVER — staleness is a pure render-time derivation.** Full-row diffs across a day-rollover + relaunch, a Today-view visit, a `show?id=<uuid>` (which selects and scrolls the row into view), and a second quit + relaunch are all **byte-identical**. `startBucket`, `startDate`, `todayIndex`, `todayIndexReferenceDate` and the stale `reminderTime` are all left exactly as they were. This is the data half of REMSTALE, re-confirmed on 3.23, and it means any consumer MUST apply the gate itself. |
| **3 RANK + SHAPE** | Where does it sort, and what must a reorder write? | **Rank: last in the daytime section** — `startBucket ASC` leads the Today comparator, so a bucket-1 row sorts below every bucket-0 one; it also had the oldest entry cohort, so both orderings agree. **Shape: the shipped two-leg `today` bounce, and nothing less.** A one-leg `when=today` is a **de-evening only** — it writes `startBucket` 1→0 and `userModificationDate`, and touches neither `startDate`, `todayIndex` nor `todayIndexReferenceDate`, so the row does not move. The two-leg bounce lands the order: the `when=evening` away leg re-dates 07-05 → **07-06** and front-inserts on the evening `todayIndex` axis, then the `when=today` back leg clears the bucket, front-inserts at the **global Today `todayIndex` minimum** and stamps `todayIndexReferenceDate` → today. |
| **4 CONTROLS** | Is the same-day case untouched, and does §9n hold? | **Yes on both.** A current-day evening item reorders in the `evening` scope (`placementClass: guaranteed`) and is still refused by `--in today` — that refusal is CORRECT. The stale row's `reminderTime` byte survives every read (1207959552, never cleared), and the CLI's `todo show` reports the row as `when: "today"` with **no** `reminder` field: the live-gate suppresses the presentation-dead byte, so the reorder's `effectiveReminder` never resurrects it. |
| **5 POST-FIX** | Does the patched build close the catch-22? | **Yes** — `--in today --start` on the stale row succeeds through the `today` bounce, lands it first in the DB axis, on screen and in `things today`, and carries the new re-date warning; `--in evening` refuses it (the row is a today-bucket item now, and neither refusal mentions re-scheduling any more); both same-day controls are unchanged. |
| **6 OVERDUE CONTROL** | Is the re-dating specific to stale evening rows? | **No — the `today` bounce re-dates ANY past-dated movee**, evening flag or not: the away leg is `when=evening` and This Evening is definitionally the current day. Pre-existing behavior, now DISCLOSED. |

---

## Cell 1 — the rendering law

Fixtures at the measurement clock (2026-07-06): `D1`–`D3` daytime today rows seeded that day; `O1` a daytime row seeded on 07-05 (overdue, `startBucket=0`); `E1`–`E3` evening rows seeded on 07-05 (now **stale**, `startBucket=1`); `C1` an evening row seeded on 07-06 (**live**).

The Today window's AX census, rows and static text in visual (y) order:

```
[16] y=247 ROW | d:STEV1-…-D3-day
[18] y=275 ROW | d:STEV1-…-D2-day
[21] y=303 ROW | d:STEV1-…-D1-day
[28] y=397 ROW | d:STEV1-…-O1-day          ← overdue daytime row
[41] y=649 ROW | d:STEV1-…-E3-eve          ← STALE evening
[42] y=677 ROW | d:STEV1-…-E2-eve          ← STALE evening
[43] y=705 ROW | d:STEV1-…-E1-eve-rem      ← STALE evening
[45] y=773 ROW | d:This Evening ~ d:Source Evening    ← the SECTION HEADER
[46] y=812 ROW | d:STEV1-…-C1-eve-now      ← LIVE evening
```

Three things follow. (a) The **This Evening section still exists** — staleness does not suppress the header, it only empties the stale rows out of it. (b) The stale rows are **above** the header, i.e. in Today proper, exactly as REMSTALE said the presentation layer behaves. (c) They are at the **bottom** of Today proper, below both the current day's rows and the overdue daytime row.

The reader agrees on all three. `things today` on the same database:

```
── ★ Today ──
…D3-day / …D2-day / …D1-day / … / …O1-day / … / …E3-eve / …E2-eve / …E1-eve-rem

── ⏾ This Evening ──
…C1-eve-now
```

and `things todo show <stale>` reports `"when": "today"`. The read side needed **no change** — `mappers.todayMarkers` had gated evening on `startDate == today` all along, which is why the disagreement was a write-side one.

## Cell 2 — the app never normalizes

`rowsnap.py` dumps every column of every fixture row; each step below is a full-row diff against the previous one.

| Trigger | Diff |
|---|---|
| clock 07-05 → 07-06, app quit and relaunched, Today never visited | **byte-identical** |
| Today view visited (`things:///show?id=today`) | **byte-identical** |
| the stale row itself shown (`things:///show?id=<uuid>` — selects it and scrolls it into view) | **byte-identical** |
| a second quit + relaunch, then Today visited again | **byte-identical** |

Key columns after all four, unchanged from the seed:

```
STEV1-…-E1-eve-rem  bkt=1 sd=132805248(07-05) tIdx=-58  tRef=132804992 rem=1207959552
STEV1-…-E2-eve      bkt=1 sd=132805248(07-05) tIdx=-94  tRef=132804992 rem=NULL
STEV1-…-E3-eve      bkt=1 sd=132805248(07-05) tIdx=-133 tRef=132804992 rem=NULL
```

**Staleness is a pure derivation rule, not a state the app migrates.** There is no trigger to mirror and no cleanup to wait for: every consumer of `startBucket` has to apply the day gate itself, forever. (This is the flattering reading too — see [craft §1d](../things-app-craft.md): because placement is re-derived at render time, a wrong-day evening flag can never *present*, so the app has nothing to clean.)

Incidental: a `when=evening` add does **not** stamp `todayIndexReferenceDate` — all four evening rows kept `tRef=132804992` (2026-07-03, the golden's own baked cursor day), including `C1`, created on 07-06. Only the `when=today` leg stamps it (cell 3).

## Cell 3 — rank semantics and the write shape

**Rank.** The reader's Today comparator is `startBucket ASC, COALESCE(tiRef, startDate, deadline) DESC, todayIndex ASC, uuid ASC`. Re-running the axis with the `startBucket` key REMOVED produced the identical order, because the stale rows also carried the oldest entry cohort — so on this fixture the two candidate laws are indistinguishable, and the AX order matches both. The `startBucket`-first spelling is kept: it is the one already shared with the reader, and it is what puts a stale row at the bottom of Today proper, where the app draws it.

**Shape A — the one-leg `when=today`** (dispatched at `things:///update?id=<E2>&when=today`):

| col | before | after |
|---|---|---|
| startBucket | 1 | **0** |
| startDate | 132805248 (07-05) | 132805248 (07-05) — *unchanged* |
| todayIndex | −94 | −94 — *unchanged* |
| todayIndexReferenceDate | 132804992 | 132804992 — *unchanged* |
| userModificationDate | … | bumped |

The row de-evenings and **does not move**: it stays at the bottom of the daytime section (y=677 before and after). The same one-leg dispatch on the OVERDUE daytime row `O1` was a **total no-op** — not one column changed, `userModificationDate` included. This is the general law VMRES1 recorded for projects, now measured for to-dos: **`when=today` on a row that has already arrived in Today is inert; the row must leave the day before it can re-enter it**, which is exactly what the bounce's away leg is for.

**Shape B — the shipped `today` bounce** (`when=evening` then `when=today`, on stale `E3`):

| leg | startBucket | startDate | todayIndex | todayIndexReferenceDate |
|---|---|---|---|---|
| before | 1 | 132805248 (07-05) | −133 | 132804992 (07-03) |
| after `when=evening` | 1 | **132805376 (07-06)** | **−26** | 132804992 |
| after `when=today` | **0** | 132805376 (07-06) | **−1742** | **132805376 (07-06)** |

The away leg **re-dates the row to today** (This Evening is definitionally the device's current day, TIMEZ-NODATE) and front-inserts it on the evening `todayIndex` axis; the back leg clears the bucket, front-inserts at the **global Today minimum** (−1742, below the day's own −1375) and stamps the entry cohort to today. The row lands **first** in the DB axis and **first** on screen (y=247, above `D3`):

```
[16] y=247 ROW | d:STEV1-…-E3-eve      ← was last in Today proper, now first
[18] y=275 ROW | d:STEV1-…-D3-day
```

So the write shape a stale-row reorder needs is **exactly the shipped today bounce — no new machinery, no special leg, no de-evening pre-step.** A stale evening row is, for the bounce, an ordinary Today member.

**The cost, and cell 6.** The away leg's re-date is not specific to stale rows: any movee whose `startDate` has passed is re-dated to today by a `today`-scope reorder, evening flag or not. Cell 6 re-ran the two-leg bounce on `E2` — by then an overdue **`startBucket=0`** row still dated 07-05 — and measured the same normalization. For a stale evening row this IS the outcome #657 asks for ("normalized to Today"), and it is what the maintainer's own workaround (re-schedule, then reorder) did by hand. For an overdue daytime row it is a genuine side effect that was previously silent, so the fix adds a `reorder-today-redate` **warning** naming the affected rows.

## Cell 4 — the regression controls

| Control | Result |
|---|---|
| `reorder <C1> --in evening --start` on the LIVE evening row | `ok` — `placementClass: guaranteed`, `note: "reordered within the evening list (evening scope — placement guaranteed)"` |
| `reorder <C1> --in today --start` on the LIVE evening row | refused: `--in today but the items are in the evening bucket — they are not Today members`. **Correct, and preserved** — a same-day evening member reordered in the today scope would be silently de-eveninged (O03) |
| `reorder <E1> --in today --start` on the STALE row, pre-fix | refused with the SAME evening-bucket message — the bug's first half, raised by the move planner's axis check (`scheduleBucket`), not by the reorder census |
| `reorder <E1> --in evening --start` on the STALE row, pre-fix | refused: `is a STALE evening item (startDate in the past) — it renders in Today proper; re-schedule it before reordering` — the bug's second half |
| §9n reminder byte on the stale row | `reminderTime=1207959552` still present after every step; `things todo show` emits **no** `reminder` field and `when: "today"` — the live-gate suppresses it, so the bounce's `effectiveReminder` cannot resurrect it and asserts `null` either side |

The two pre-fix refusals came from **two different layers**, which is why the bug survived: the today half is the move planner's `--in` axis check, the evening half is the reorder scope census. That is the shape of the fix — see below.

## Cell 5 — the patched build

Re-shipped `dist` to the same held clone and re-ran against the stale row `E1`.

`things reorder <E1> --in today --start --json` → **ok** (`placementClass: guaranteed`, `note: "reordered within the today list"`), carrying the new warning:

> `1 row(s) whose day had already passed are now dated today — a Today-section reorder re-enters each row through This Evening, which is always the current day (STEV1): 4cc79mQp…`

Its full-row diff is the cell-3 shape B law, end to end through the shipped verb:

| col | before | after |
|---|---|---|
| startBucket | 1 | **0** |
| startDate | 132805248 (07-05) | **132805376 (07-06)** |
| todayIndex | −58 | **−2176** (below the previous minimum, −1742) |
| todayIndexReferenceDate | 132804992 (07-03) | **132805376 (07-06)** |
| reminderTime | 1207959552 | **NULL** |

The row is now **first** in the DB axis, **first** on screen (y=247), and **first** under `★ Today` in `things today`. The `reminderTime` clear is the app's own `when=` behavior on a stale byte (ODDS1-D3: rescheduling a stale row clears it); the value was already presentation-dead, the CLI reported it absent both before and after, and `effectiveReminder` asserted `null` either side — nothing regressed, and nothing was resurrected.

The remaining controls:

| Call | Result |
|---|---|
| `reorder <E1> --in evening --start` (stale) | refused — and the refusal now comes from the **planner's axis check**, which reaches the request first: `--in evening but the items are in the today bucket — they are not This Evening members`. (The library's `evening` scope, addressed directly, names `scope 'today'`.) Either way the "re-schedule it before reordering" workaround is gone |
| `reorder <C1> --in evening --start` (live evening) | **ok** — `placementClass: guaranteed`, unchanged |
| `reorder <C1> --in today --start` (live evening) | refused: `--in today but the items are in the evening bucket` — unchanged, and correct (O03) |

## Cell 6 — the overdue control

`E2` — de-eveninged by cell 3's shape A and still carrying its past 07-05 date, i.e. an ordinary **overdue `startBucket=0`** row — put through the same two legs:

| leg | startBucket | startDate | todayIndex | todayIndexReferenceDate |
|---|---|---|---|---|
| before | 0 | 132805248 (07-05) | −94 | 132804992 (07-03) |
| after `when=evening` | **1** | **132805376 (07-06)** | −94 | 132804992 |
| after `when=today` | **0** | 132805376 (07-06) | **−2526** | **132805376 (07-06)** |

Identical normalization: the re-date is a property of the **away leg**, not of the evening flag. So the `reorder-today-redate` warning is about every past-dated movee a `today`-scope reorder touches, which is why it names the rows rather than mentioning staleness. (Note also that the away leg did NOT move this row's `todayIndex` — a bucket-0 → evening re-entry left it at −94, where the stale row's evening re-entry front-inserted; only the back leg's global-min insert is load-bearing for the order.)

## What the fix changed

One law, one module: `src/model/today-placement.ts`. An ARRIVED row (`start IN (1,2)`, `startDate <= today`) is a Today member; it is a **This Evening** member only while `startBucket=1` **and** `startDate` is exactly today. Everything else consults it:

| Surface | Was | Now |
|---|---|---|
| `mappers.todayMarkers` (read) | its own inline gate (already correct) | `todayPlacement` |
| `computeReorderPre` today scope | `startBucket === 0` | `todayPlacement === "today"` — the stale row is a member |
| `computeReorderPre` evening scope | `startBucket === 1 && startDate === today`, refusal said "re-schedule it first" | `todayPlacement === "evening"`, refusal says `scope 'today'` |
| `computeReorderPre` native today wire | `AND startBucket = 0` | excludes only LIVE evening rows |
| `checkStillMember` (the bounce's concurrent-edit re-check) | `startBucket !== 0` ⇒ "moved to This Evening" | `todayPlacement !== "today"` — otherwise the today bounce tripped its own re-check on the movee it was handed |
| `move.scheduleBucket` (the `--in` axis check AND the scope router) | `startBucket === 1 ? "evening" : "today"` | `todayPlacement` — this is what made `--in today` refuse the stale row |
| `todayEveningFlagOf` | its own inline gate (already correct) | `todayPlacement` |

Plus the new `reorder-today-redate` warning for the measured side effect (cell 3 / cell 6).
