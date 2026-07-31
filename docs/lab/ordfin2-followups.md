# ORDFIN2 — three ordering follow-ups: project-row strand, the Tomorrow day-sort surface, and the Later Projects list (+ a duplicate-area tiebreaker)

Three arms close residual ordering questions left open after ORDFIN1 / PR #331: (1) where an untouched scheduled PROJECT row lands when a same-day to-do group is park-sorted, and the value-assignment law behind it (PRJMIX); (2) whether `list "Tomorrow"` is a clean one-call day-sort surface, projects included (TOMORROWLIST); (3) the exact membership + reorder semantics of the hidden Later Projects list (LATERPROJ), plus the GUI tiebreaker for duplicate-titled areas with tied `index` (AXDRAG3).

One offline Tart clone (`ordfin2-lab`, run 2026-07-31, Things 3.22.11, macOS 15.7.7 Sequoia, DB schema 26, pinned clock **2026-07-05 12:00**; ordering is local — no cloud account). Script: [`lab/scripts/research-ordfin2.sh`](../../lab/scripts/research-ordfin2.sh) (subcommands `setup` / `arm1` / `arm1var` / `arm2` / `arm3lp` / `grant` / `arm3ax` / `teardown`) + the AX sidebar dumper/drag [`lab/scripts/ordfin2-ax3.jxa`](../../lab/scripts/ordfin2-ax3.jxa). Arms **1 / 2 / 3-LATERPROJ are HEADLESS** (URL scheme + `things:///json` + AppleScript private reorder). **Arm 3-AXDRAG3 needs Accessibility** (granted per-clone via the AXVM1 rung-b VNC toggle). Test days: PRJMIX = **2026-07-19** (+14d); tomorrow = **2026-07-06**; LATERPROJ future-scheduled = **2026-07-25**. Dates seeded via URL `when=<ISO>` (the app packs `startDate`); preservation asserted by DB read comparison — **no hand-packed date integers**. All reorder wire lists use SCRAMBLED targets so a passing result proves array order CONTROLS placement, not a no-op.

**Status: RAN + BANKED.** Headlines:

1. **Arm 1 = an untouched same-day scheduled PROJECT row ALWAYS sinks below the park-sorted block — and the fresh todayIndex values are computed below the GLOBAL day-group minimum, not the scratch container's local minimum.** The park-sort-restore reorder assigns the touched to-dos fresh `todayIndex` values strictly below the most-negative `todayIndex` among ALL rows sharing that `startDate` (across containers), descending in reverse-target order. Untouched project rows keep their `todayIndex` byte-identical. So the sorted block lands at the TOP of the day (most-negative) and the untouched projects sort below it — **repeatable across 3 runs and independent of the projects' starting values** (a variant with the projects driven to the global minimum still had the sorted block land below them). Deterministic and modelable.
2. **Arm 2 = `list "Tomorrow"` is a clean one-call day-sort surface — projects included, `startDate` preserved, no §9g re-date.** `_private_experimental_ reorder to dos in list "Tomorrow" with ids "…"` re-ranks `todayIndex` to the sent order in ONE forward call, ACCEPTS a scheduled area-less PROJECT uuid inline (O12 analog) and re-ranks it too, and preserves `start`/`startBucket`/`startDate` on every row (unlike `list "Upcoming"`, §9g). `list id "tomorrow"` and `list "Tomorrow"` are equivalent spellings.
3. **Arm 3 = the Later Projects list contains area-less someday OR future-scheduled projects (maintainer law confirmed); its reorder re-ranks `todayIndex` forward in one call BUT destructively re-dates date-less someday projects (a §9g-style stamp), so it is NOT a clean compile-collapse.** AXDRAG3: the sidebar area order is `TMArea."index"` ASC with a **uuid-ASC** tie secondary key — so duplicate-titled areas are deterministically disambiguable (Nth-AX-row ↔ Nth-DB-row by `(index, uuid)`), and `area.reorder`'s duplicate-title refusal could be relaxed (law + feasibility only, not wired).

## Verdict table (observed)

| Arm | Question | Verdict |
|---|---|---|
| **1** — PRJMIX strand + value law | where does an untouched same-day scheduled PROJECT row land when the day's to-dos are park-sorted, and are fresh values below scratch-min or global-min? | **Untouched project rows ALWAYS sink below the sorted block (list order); fresh values land below the GLOBAL day-group min.** Repeatable across 3 runs (projects byte-identical each time). A variant that drove the 3 projects to the global minimum (−13591…−12785, below the to-do min −9620) still had the reordered to-dos land at −15432…−14028 (below −13591) → the fresh-value computation references the most-negative `todayIndex` among ALL same-day rows, NOT the scratch container's own contents. Deterministic + modelable → #331's contamination refusal COULD be relaxed to a disclosed-strand (projects sort after the block); **NOT wired.** |
| **2** — `list "Tomorrow"` day-sort | is Tomorrow a clean one-call day-sort surface, projects included, non-destructive? | **YES — clean one-call surface.** `reorder to dos in list "Tomorrow" with ids "TM-A,TM-PRJ,TM-L,TM-C"` re-ranked `todayIndex` to the exact sent order (−3983, −3609, −3259, −2751), ACCEPTED the scheduled area-less PROJECT uuid inline and re-ranked it in position (O12 analog), and preserved `startDate` / `start=2` / `startBucket=0` / area FK / project FK on every row — NO §9g-style re-date. `list id "tomorrow"` (target TM-C,TM-L,TM-PRJ,TM-A → −5614, −5129, −4533, −3983) is byte-for-byte the same surface. Like the container reorder, each call re-bases the touched rows below the day min (block floats to top). One day out only. |
| **3lp** — Later Projects list | membership = area-less someday OR future-scheduled? forward one-call reorder or anchor-stack? which axis? state-preserving? | **Membership law CONFIRMED; reorder is forward one-call on `todayIndex` but DESTRUCTIVE (de-somedays).** Membership = area-less projects that are someday OR future-scheduled (LP-SOME + LP-SCHED in; area'd-someday LP-AREASOME and active-anytime LP-ACTIVE out). `reorder to dos in list id "later-projects" with ids "…"` re-ranks the **`todayIndex`** axis (NOT `index`) in ONE forward call — container semantics, not the two-call anchor-stack of `list "Someday"` — BUT it **STAMPS a `startDate` on the date-less someday projects** (sd NULL → 132805376 = the first upcoming day), a §9g-style destructive re-date that converts date-less someday into scheduled. `index` preserved, `start=2` preserved. An already-scheduled member on a DIFFERENT day (LP-SCHED @07-25) is left inert (date preserved, not re-ranked into the ex-someday group). **So the collapse is NOT clean** — the state-preserving surface for someday-project order remains `list "Someday"` (`index` axis, two-call anchor-stack, P9e). New oddity filed. |
| **3ax** — duplicate-area tiebreaker | with tied `index`, what orders the sidebar rows; is Nth-row↔Nth-DB-row sound? | **Sidebar order = `TMArea.index` ASC (primary), uuid ASC (tie secondary). Nth-AX-row ↔ Nth-DB-row is SOUND.** Separate `make new area` calls assign DISTINCT sparse indexes (no tie); a single AppleScript BATCH leaves them tied at `index=0`. With ties, the display order is uuid-lexicographic: forcing a renumber (a drag) materialized the tied set as Qf4SGm3Z=0 < Uybysu=1220 < VTPQSA=1826 = uuid-ASC (Q<U<V), NOT rowid/creation order (U,V,Q). A genuine one-area drag moved the intended DUPE (uuid 6Nu, the AX-1st dupe) from `index`=−277 to 645 and the post-drag AX order maps position-for-position to DB `ORDER BY "index"` (neighbour-renumber per oddity 8i). So a driver can sort a duplicate-titled set by `(index, uuid)` ASC, map the Nth AX row → Nth uuid, drag, and DB-assert the intended uuid moved (self-invert on mismatch). Closed-loop disambiguation is feasible → the `area.reorder` duplicate-title refusal COULD be relaxed. Law + feasibility only — driver NOT modified. |

## Per-arm detail

### Arm 1 — PRJMIX: the project-row strand + the value-assignment law

**Seed (day 2026-07-19, `startDate`=132807040), 7 dated rows + 1 anytime container.** Three area-less scheduled PROJECT rows (`type=1`, `PM-PRJ1/2/3`), two loose to-dos (`PM-L1/2`), two project children of an anytime container `PM-CONT` (`PM-C1/2`). Seed order front-inserts each new same-day row below the current group min, so the seed order (PRJ1, PRJ2, PRJ3, L1, L2, C1, C2) produced ascending-negative `todayIndex`:

| row | type | todayIndex (seed) |
|---|---|---|
| PM-C2 | 0 (child) | −3227 |
| PM-C1 | 0 (child) | −2662 |
| PM-L2 | 0 (loose) | −2173 |
| PM-L1 | 0 (loose) | −1513 |
| PM-PRJ3 | 1 (project) | −1043 |
| PM-PRJ2 | 1 (project) | −609 |
| PM-PRJ1 | 1 (project) | 0 |

So at seed the 4 to-dos were the *most* negative (sort above) and the 3 projects the least (sort below). Global day min = −3227 (a to-do).

**(b) The raw upcoming-day protocol on the 4 to-dos only** (park all four into a scratch PROJECT `PM-SCRATCH` via URL `update?list-id=<scratch>` → `reorder to dos in project id <scratch>` with a scrambled target → restore each to origin: loose←empty `list-id`, child←`PM-CONT`). The 3 project rows were NEVER touched.

| run | scrambled target | fresh to-do todayIndex (ascending) | projects (untouched) | block vs projects |
|---|---|---|---|---|
| 1 | C2,L1,C1,L2 | C2=−5617, L1=−5003, C1=−4378, L2=−3788 | −1043, −609, 0 | block ABOVE projects |
| 2 | L2,C2,L1,C1 | L2=−8115, C2=−7480, L1=−6872, C1=−6235 | −1043, −609, 0 | block ABOVE projects |
| 3 | C1,C2,L1,L2 | C1=−9620, C2=−9009, L1=−8454, L2=−8115 | −1043, −609, 0 | block ABOVE projects |

Every run: the fresh values land in the exact scrambled target order (ascending `todayIndex` = sent order), strictly below the prior block minimum, and the 3 project rows keep their `todayIndex` **byte-identical**. So the sorted block always sits at the top of the day and the untouched projects strand below it. **Strand position is repeatable.** `startDate` / `start=2` preserved on every touched row every leg; the restore leg re-homes the FK (child `project`→`PM-CONT`, loose→NULL) without moving `todayIndex`.

**(c) The disambiguation variant — projects driven to the GLOBAL minimum.** After the 3 runs the to-dos sat at −9620…−8115. Three rounds of a `someday→day` re-front-insert on the 3 projects drove them below the to-dos:

- round 1: PRJ3=−11089, PRJ2=−10648, PRJ1=−10055 (toDoMin −9620)
- round 2: PRJ3=−12427, PRJ2=−12063, PRJ1=−11501
- round 3: PRJ3=−13591, PRJ2=−13226, PRJ1=−12785

Now project min (−13591) < to-do min (−9620): the projects are the GLOBAL day min. Parking the 4 to-dos (scratch container min −9620) and reordering (target C2,L1,C1,L2) produced:

| row | todayIndex after variant reorder |
|---|---|
| PM-C2 | **−15432** |
| PM-L1 | **−14953** |
| PM-C1 | **−14444** |
| PM-L2 | **−14028** |
| PM-PRJ3 | −13591 (untouched) |
| PM-PRJ2 | −13226 (untouched) |
| PM-PRJ1 | −12785 (untouched) |

**Decisive:** the fresh to-do values (−15432…−14028) landed below the project/global min (−13591), NOT merely below the scratch container's own min (−9620). Since the projects live in a *different* container (they are area-less day-scheduled project rows, not members of the scratch project), the reorder could only have chosen values below −13591 by reading the GLOBAL day-group minimum. **The fresh-value assignment references the most-negative `todayIndex` among ALL rows sharing that `startDate`, across containers — not the scratch container's local contents.** The block therefore ALWAYS sinks to the very top of the day regardless of where the untouched projects sit in value.

**(d) Verdict.** The strand law is deterministic and modelable: **an untouched same-day scheduled PROJECT row keeps its `todayIndex` byte-identical and always ends up below the park-sorted block in list order, because the block is re-based below the global day-group minimum.** #331 currently refuses the `upcoming-day` protocol fail-closed when a scheduled PROJECT row shares the day (a project cannot be parked into the scratch project — projects nest only in areas). With the strand now pinned, that refusal *could* be relaxed to a **disclosed-strand** mode ("the day's to-dos are sorted; any same-day scheduled project(s) land below the sorted block") in a follow-up. Per the ORDFIN2 brief this is **evidence only — NOT wired.**

### Arm 2 — TOMORROWLIST: `list "Tomorrow"` as a day-sort surface

**Seed (tomorrow 2026-07-06, `startDate`=132805376).** Three to-dos in mixed containers — `TM-L` loose, `TM-C` child of an anytime project, `TM-A` direct child of LAB-AREA-A — plus one area-less scheduled PROJECT row `TM-PRJ` (`type=1`). All four are startBucket=0 (scheduled) with `todayIndex` assigned; the day-group before: TM-PRJ=−2210, TM-A=−1733, TM-C=−1114, TM-L=−646.

**(b) One-call reorder over the list, scrambled target incl. the project uuid** — `reorder to dos in list "Tomorrow" with ids "TM-A,TM-PRJ,TM-L,TM-C"`:

| row | type | todayIndex after | startDate | start / startBucket | container FK |
|---|---|---|---|---|---|
| TM-A | 0 | −3983 | 132805376 (kept) | 2 / 0 | area 7Ck4hAXU (kept) |
| TM-PRJ | **1** | −3609 | 132805376 (kept) | 2 / 0 | — |
| TM-L | 0 | −3259 | 132805376 (kept) | 2 / 0 | — |
| TM-C | 0 | −2751 | 132805376 (kept) | 2 / 0 | project E3xRuNt4 (kept) |

The ascending `todayIndex` == the exact sent order. The **scheduled PROJECT row was accepted inline and re-ranked** to position 2 (O12 analog: `project` inherits from `to do` in the sdef, so project uuids pass the `ids` filter). **No re-date** — every `startDate` is byte-identical (contrast `list "Upcoming"`, which re-dates destructively, §9g). `start`/`startBucket`/area/project FKs all preserved.

**(c) Spelling equivalence** — `reorder to dos in list id "tomorrow" with ids "TM-C,TM-L,TM-PRJ,TM-A"` → TM-C=−5614, TM-L=−5129, TM-PRJ=−4533, TM-A=−3983 (ascending == sent order), `startDate` preserved again. `list id "tomorrow"` and `list "Tomorrow"` are the same surface.

**(d) Verdict.** **Tomorrow is a clean one-call cross-container day-sort surface** — a single AppleScript reorder re-ranks the whole next-day group (loose + project child + area child + scheduled project) on `todayIndex`, projects included, with no scratch-park and no destructive re-date. It reaches exactly one day out (the `tomorrow` list). This is the direct-surface counterpart to the `upcoming-day` scratch-park protocol for the single tomorrow case. Evidence only — NOT wired.

### Arm 3 — LATERPROJ: the Later Projects list

**(a) Membership.** Four projects seeded and read:

| project | type | start | startDate | area | Later Projects member? |
|---|---|---|---|---|---|
| LP-SOME (area-less someday) | 1 | 2 | — | — | **YES** |
| LP-SCHED (area-less future-scheduled @07-25) | 1 | 2 | 132807808 | — | **YES** |
| LP-AREASOME (area'd someday) | 1 | 2 | — | 7Ck4hAXU | NO (Someday view) |
| LP-ACTIVE (active anytime area-less) | 1 | 1 | — | — | NO (sidebar row) |

The area-less someday-OR-future-scheduled predicate (`area IS NULL AND (start=2 OR startDate IS NOT NULL)`) selects exactly the projects the maintainer observed in the Later Projects sidebar view (2026-07-31, GUI) — confirming that the sidebar section is the **non-active remainder of the loose (area-less) project block**: someday + future-scheduled. Active anytime area-less projects (LP-ACTIVE, `start=1`, no date) are sidebar rows in their own right, not list members; area'd someday projects (LP-AREASOME) live under their area / in the Someday view. (The golden's repeating weekly project template + instance are also area-less start=2 rows, matching the predicate.)

**(b) The reorder — forward one-call on `todayIndex`, but a destructive re-date.** Three area-less someday projects (LP-SOME, LP-SOME2, LP-SOME3, all `start=2`, `startDate` NULL, `todayIndex=0`, distinct `index`) reordered via `reorder to dos in list id "later-projects" with ids "LP-SOME3,LP-SOME,LP-SOME2"`:

| row | todayIndex before → after | index (before=after) | startDate before → after |
|---|---|---|---|
| LP-SOME3 | 0 → **−7018** | −1001 | NULL → **132805376** |
| LP-SOME | 0 → **−6457** | 0 | NULL → **132805376** |
| LP-SOME2 | 0 → **−5980** | −339 | NULL → **132805376** |

The ascending `todayIndex` == the forward sent order (LP-SOME3, LP-SOME, LP-SOME2) in ONE call — **container semantics, not the two-call anchor-stack** `list "Someday"` needs for descending project rows (P9e). BUT the reorder **stamped `startDate`=132805376 (the first upcoming day, 2026-07-06) onto all three** — a §9g-style destructive re-date (the private later-projects reorder routes through the same `todayIndex`/schedule path as `list "Upcoming"`). `index` and `start=2` are preserved, but the date-less someday state is destroyed (the projects are now scheduled for tomorrow). So `list id "later-projects"` is **NOT** a state-preserving someday-order surface.

**(b2) Mixed request including the already-scheduled project.** `reorder … with ids "LP-SCHED,LP-SOME3,LP-SOME2,LP-SOME"` (LP-SCHED is future-scheduled @07-25, a different day-group): the three ex-someday rows re-ranked on the 07-06 group (LP-SOME3=−8356, LP-SOME2=−7967, LP-SOME=−7486, forward order) while **LP-SCHED stayed inert** — `todayIndex=0`, `index=0`, `startDate`=132807808 all unchanged. A member already anchored on a different day is neither re-dated nor pulled into the ex-someday group's `todayIndex` ranking (cross-day-group `todayIndex` cannot interleave).

**(c) Verdict.** Forward one-call re-rank works on the `todayIndex` axis, but it is destructive for the someday case (de-somedays via a `startDate` stamp), so it is **NOT a viable compile-collapse** for someday-project ordering — the clean surface stays `list "Someday"` (the `index` axis, two-call anchor-stack). The membership correction (area-less someday AND future-scheduled surface in the Later Projects sidebar view) is folded into the capability matrix. The destructive re-date is filed as a new oddity. Evidence only — NOT wired.

### Arm 3 — AXDRAG3: the duplicate-titled-area tiebreaker

Requires Accessibility (granted per-clone via the AXVM1 rung-b VNC toggle; `auth_value` 0→2, the AX menu-bar read then returns exit 0). AX sidebar rows read + area drag via [`lab/scripts/ordfin2-ax3.jxa`](../../lab/scripts/ordfin2-ax3.jxa) (NATIVE1 / AXDRAG1 mouse-synthesis primitives). The golden's only seed areas are LAB-AREA-A (uuid `7Ck4hAXU…`) and LAB-AREA-B (`2piYxp6U…`).

**(d) Do duplicate-titled areas share a tied `index`? Depends on the create path.** Three areas titled `DUPE-AREA` created by THREE separate `make new area` osascript calls got **distinct** sparse indexes (6Nu=−277, B3C=−65, Hyc=0) — each separate transaction reindexes. Three areas titled `TIE-AREA` created in ONE AppleScript `repeat` batch stayed **tied at `index=0`** (matching the AXDRAG2-d observation that batch-made tags sit tied at 0). So the "all zero" premise holds only for batch creation.

**Primary sort key = `TMArea."index"` ASC.** With the distinct-index DUPE set, the full sidebar area order read via AX was **LAB-AREA-B, DUPE(6Nu), LAB-AREA-A, DUPE(B3C), DUPE(Hyc)** — exactly `ORDER BY "index"` (−529, −277, −122, −65, 0). Note a *brand-new* area (DUPE 6Nu, index −277) sorts BETWEEN the older B (−529) and A (−122): the order is the `index` column, not creation order.

**Tie secondary key = uuid ASC.** For the batch `TIE-AREA` set the three uuids sort DIFFERENTLY by rowid (creation: Uybysu, VTPQSA, Qf4SGm3Z) vs by uuid (Qf4SGm3Z, Uybysu, VTPQSA). A drag elsewhere in the sidebar forced a global sparse renumber that broke the ties into distinct indexes **preserving the tied display order** → Qf4SGm3Z=0 < Uybysu=1220 < VTPQSA=1826, i.e. **uuid ASC** (Q<U<V), NOT rowid/creation order. Independently, the four areas tied at 0 before the drag (Hyc + the 3 TIE) renumbered to Hyc(−43) < Qf4(0) < Uyb(1220) < VTP(1826) = uuid-ASC (H<Q<U<V). Decisive: **tied-index areas display in uuid-lexicographic order.**

**(e) The genuine drag — Nth-row ↔ Nth-DB soundness.** Dragging DUPE `6Nu` (the AX-1st/topmost dupe, `index`=−277) down to the bottom of the area block moved its `index` to 645 (and renumbered the two other dupes, oddity 8i's neighbour-renumber). The post-drag AX sidebar area sequence — B, A, DUPE, DUPE, TIE, DUPE, TIE, TIE — maps **position-for-position** to the DB `ORDER BY "index"` sequence B(−529), A(−122), B3C(−65), Hyc(−43), Qf4-TIE(0), 6Nu-DUPE(645), Uyb-TIE(1220), VTP-TIE(1826). The intended uuid (6Nu) is exactly the one whose `index` jumped. So Nth-AX-row == Nth-DB-row under `(index, uuid)` ASC.

**Verdict.** The sidebar sort law is fully pinned: **`ORDER BY "index" ASC, uuid ASC`**. With it, duplicate-titled areas ARE disambiguable — a driver sorts the duplicate-titled uuids by `(index, uuid)` ASC, maps the Nth same-title AX row to the Nth uuid, drags, and DB-asserts that the intended uuid's `index` moved (self-invert on mismatch = a sound closed loop). So `area.reorder`'s current up-front refusal on duplicate area titles COULD be relaxed to positional disambiguation. **Law + feasibility only — the `area.reorder` driver is NOT modified** (per the ORDFIN2 brief). This refines the AXDRAG2-d claim that "the DB→row mapping breaks whenever `index` ties exist": the mapping does not break — tied rows are ordered deterministically by uuid.

## App oddities filed

- **New oddity — the private `reorder to dos in list id "later-projects"` RE-DATES date-less someday projects to the first upcoming day** (stamps `startDate`, `start` stays 2), the §9g mechanism applied to the Later Projects aggregate. It re-ranks the `todayIndex` axis forward in one call but is destructive for the someday case, so it is not a state-preserving someday-order surface. Filed in [things-app-oddities.md](../things-app-oddities.md) §9m. (Refines novel-paths #21, which noted the `todayIndex` rewrite but not the re-date.)
- **Note (not a bug) — area `index` assignment depends on the create path:** separate `make new area` calls each reindex (distinct sparse indexes); a single AppleScript batch leaves the new areas tied at `index=0`. The tied display order is uuid-ASC; a subsequent drag/reindex breaks ties in that same uuid order. Recorded here (Arm 3ax) and folded into the AXDRAG2-d matrix note; not a Cultured Code bug.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart VNCDO=<path-to-vncdo> \
  bash lab/scripts/research-ordfin2.sh setup      # clone+boot(+vnc)+airgap+clock-pin+warm+seed(all arms)
  bash lab/scripts/research-ordfin2.sh arm1        # PRJMIX strand + value law
  bash lab/scripts/research-ordfin2.sh arm1var     # PRJMIX disambiguation (projects driven to global min)
  bash lab/scripts/research-ordfin2.sh arm2        # TOMORROWLIST one-call day-sort
  bash lab/scripts/research-ordfin2.sh arm3lp      # LATERPROJ membership + reorder
  bash lab/scripts/research-ordfin2.sh grant        # AXVM1 rung-b Accessibility toggle (AXDRAG3 only, needs $VNCDO)
  bash lab/scripts/research-ordfin2.sh arm3ax       # AXDRAG3 duplicate-area tiebreaker
  bash lab/scripts/research-ordfin2.sh teardown
```

Arms 1/2/3lp are headless (no Accessibility, no VNC); AXDRAG3 needs the `grant` step (`$VNCDO` = a `vncdotool` CLI). All reorder wire lists use SCRAMBLED targets. Evidence (gitignored, synthetic): `lab/artifacts/ordfin2-lab/report.txt`, `ax3-rows-*.json`, `screens/`.
