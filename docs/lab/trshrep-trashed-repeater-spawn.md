# TRSHREP — repeating-template spawn/pause/catch-up while trashed (+ restore, relocation, empty-trash, mixed-promote, checklist-carry)

**Probed under: `things-lab-golden-v2` · Things 3.22.12 (build 32212016) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00, advanced in small +1/+2-day steps to 2026-07-09.** Ran in ONE disposable clone `trshrep-lab` of golden-v2 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched and advanced only in ≤2-day steps (SL2/RSIM-S proven; the RSIM-P2 A4 +15-day wedge avoided — helpers live in `~/things-lab/helpers` and were re-installed after every advance). golden-v2 carries the baked **L3-accessibility** grant, so the ui-vector (`make-repeating`) drove via System Events over SSH with no VNC step. Ground truth = read-only guest SQLite row deltas (every recurrence + trash + checklist + tombstone column captured) driven through the **production CLI** (guest e2e bundle: node + dist + commander). Branch `mg/trshrep-probes`. Script: [`lab/scripts/research-trshrep.sh`](../../lab/scripts/research-trshrep.sh). Artifacts (gitignored): `lab/artifacts/trshrep-lab/` (`report.txt`, `snaps/*.json`, `reads/*.json`, `drive-*.log`, `diff_snaps.py`).

**The question set (maintainer, 2026-08-12).** Does a repeating template stop spawning while it (or its containing project) sits in the Trash, and what happens on restore — including multi-period catch-up and restore-by-relocation? Plus three follow-ups: empty-trash cascade on a trashed project's logged children (R7), the flagged RSIM-U mixed open+logged native-promote cell (R8), and checklist checked-state across a template→occurrence spawn (R9).

This complements CLONE ([clone-fidelity-and-template-trash.md](clone-fidelity-and-template-trash.md)), which trashed the TEMPLATE row directly (C3/C4: cursor cleared, instance orphaned, non-restorable). TRSHREP covers the structurally different **child-of-trashed-container** case (the template row itself keeps `trashed=0`; only its project is trashed) plus the CLONE residual (raw-app trash of a TO-DO template, R5).

> **Date decode.** Packed dates (`startDate`/`nextInstanceStartDate`/`icStartDate`, `y<<16|m<<12|d<<7`) decode correctly: `132805248`=07-05, `132805376`=07-06, `132805504`=07-07, `132805632`=07-08, `132805760`=07-09, `132805888`=07-10, `132806144`=07-12. `creationDate`/`stopDate` are UNIX-epoch seconds (schema v26); the differ decodes them as such (no Cocoa-2001 double-offset — the "2057" CLONE artifact is not present here). The junk instance sentinel `rt1_nextInstanceStartDate=69760` on instance rows is ignored (only the TEMPLATE's cursor drives generation).

---

## HEADLINE VERDICTS

1. **Spawning is CONTAINER-TRASH-BLIND (R1).** A fixed repeating template whose *container project* is trashed keeps its cursor and **keeps spawning new instances INTO the trashed project on schedule**, one per elapsed period, catching up multiple missed periods in a single relaunch. The maintenance scheduler keys on the template ROW's own `trashed` flag (still 0) + its cursor, NOT on the container-derived trash. (Contrast CLONE C3, where trashing the template ROW cleared the cursor and stopped generation.)
2. **"Restore catch-up" is a MISNOMER for the container case (R2).** Because generation never paused, there are **no missed periods to replay** on restore — restore merely UN-HIDES the back-dated occurrences that already accumulated in the trash. A daily repeater trashed for N days floods **N back-dated occurrences** into Today/Anytime at once on restore. The cursor does NOT re-anchor to today; it continued the original phase (already advanced by the trashed-period spawns).
3. **The shipped `todo move` REFUSES to relocate a template out of trash (R3)** — the `H-REPEAT-SCHEDULE` template guard fires on `todo.move` (WG-8 extends to move), before any app drive. So restore-by-relocation is not reachable through the shipped CLI (independent of container-trash).
4. **After-completion is dormant while trashed but its successor DOES spawn into the trash (R4).** Nothing spawns on the clock (AC is completion-driven); completing the AC instance *while its container is trashed* works (url-scheme, unguarded — the instance's own `trashed=0`) and the successor materializes INTO the trashed project on the next tick.
5. **Emptying the Trash SILENTLY DESTROYS a trashed project's LOGGED history (R7).** `empty trash` cascades through the trashed container and hard-deletes its container-derived-trashed children — **including completed (`status=3`) and canceled (`status=2`) rows whose own `trashed=0`** — leaving **no tombstone** for the plain rows (TOMB1). Completed-task history under a trashed project is destroyed without a trace.
6. **Raw-AS trash of a TO-DO template matches the project-template pattern (R5, closes the CLONE residual):** cursor CLEARED, instance ORPHANED-but-live; and `todo restore` REFUSES it (guard), so it is non-resumable via the shipped CLI.
7. **The flagged RSIM-U cell resolves to PRESERVE (R8):** a fixed `project make-repeating` on a project holding one open + one completed child **preserves the source** (2/2) — a terminal child among open siblings flips fate to preserve — so the completed history rides the preserved instance and is **not** destroyed by the promote.
8. **Checklist checked-state does NOT carry to a spawned occurrence (R9):** a spawned occurrence's checklist items are born all-UNCHECKED regardless of the template's stored checked-state (extends the RSIM-S "pristine occurrence" law to `TMChecklistItem`).

---

## R1 — fixed DAILY repeater as a child of a trashed project

**Fixture.** Project `TR-P1` holding a fixed-daily repeating to-do (made via `todo make-repeating` on the child; the child's uuid was replaced, leaving a `rt1_recurrenceRule` template + one instance, both `project=TR-P1`, per CLONE A6). `project delete TR-P1` (shipped) trashed the project — **no guard interfered** (the deleted target is a plain project, not the template; WG-8's `project.delete` gap is about deleting the template itself). Delta = the project row `trashed 0→1` ONLY — the child template + instance keep `trashed=0` (container-derived trash, SHALLOW delete, A24B).

| step (clock) | template `next` (cursor) | `icCount` | live instances of the template | note |
|---|---|---|---|---|
| post-convert (07-05) | 07-06 | 1 | 1 (07-05) | baseline |
| **after `project delete TR-P1`** (07-05) | **07-06 (SURVIVES)** | 1 | 1 | **cursor intact — contrast CLONE C3 (direct template-trash CLEARS it)** |
| +1 day → 07-06, relaunch | 07-07 | 2 | 2 (07-05, **07-06 NEW, `project=TR-P1`**) | **a new instance SPAWNED into the trashed project** |
| +2 days → 07-08, relaunch | 07-09 | 4 | 4 (…, 07-07, 07-08 both NEW) | **MULTI-PERIOD catch-up: one instance per elapsed day, all in the trash** |

Each spawned occurrence is `start=2`, `project=TR-P1` (the trashed project), `creationDate` = the occurrence-day midnight (e.g. 07-06 → `2026-07-06T00:00:00`). So a trashed container is **not** a pause: the template row's own `trashed=0` + a due cursor is sufficient for the launch-time maintenance pass to generate, and it generates **into the trash**, backfilling every missed period.

**Guard/coverage note.** `project delete` on a *plain container* is correct and unguarded here. The WG-8 gap (a `project.delete` on a *template project* being unguarded) is unrelated — this fixture never deletes a template.

## R2 — restore after multiple missed periods

`project restore TR-P1` at 07-08 (after 4 occurrences had accumulated in the trash). Immediate delta = the project row `trashed 1→0` ONLY. A subsequent warm relaunch produced **ZERO** new inserts/changes (`INSERTED 0 / CHANGED 0`).

- **ONE vs MULTIPLE:** neither — **no fresh materialization on restore.** All four occurrences (07-05/06/07/08) already existed in the trash; restore just un-hides them, so the user sees **all four back-dated occurrences appear at once** (they are `start=2` anytime rows; the reader lists them in `today`/`upcoming`/`anytime` after restore). This is the practical "catch-up," but it happened *while trashed*, not on restore.
- **Cursor re-anchor?** No. `next` stayed at 07-09 (advanced by the trashed-period spawns), `icCount=4`. The series **continued its original phase** rather than re-basing on the restore day. On the next tick (07-09) it spawned the 5th occurrence normally (`icCount 4→5`), confirming the restored series is fully live and in-phase.

**Surprise (oddity-worthy).** Restoring a project that held a fixed repeater while trashed dumps every accumulated back-occurrence into the live views simultaneously — the number is proportional to how long it sat in the Trash. There is no "collapse to one current occurrence."

## R3 — restore by relocation

At 07-08, with `TR-P3` (identical fixed-daily fixture) trashed and its template having likewise accumulated 4 in-trash occurrences, `todo move <template> --to-area TR-Area` (shipped) **REFUSED**:

```
blocked:H-REPEAT-SCHEDULE — target is a repeating template: … status/move/delete on templates are unvalidated
```

So the `H-REPEAT-SCHEDULE` template guard covers **`todo.move`** as well as delete (WG-8 is broader than the register's "schedule/status/move/delete" list implied for the *derived-trashed* case — the guard fires on template-ness regardless of container-trash). The move never reached the app; the template stayed `project=TR-P3` (trashed). **No shipped surface relocates a repeating template out of a trashed container.**

- **Residual (not chased — single-clone budget):** a *raw AppleScript* `move to do id <template> to area …` was not attempted (the CLI guard blocked first). The template's own `trashed=0` (unlike CLONE C3's row-trashed template that 301'd on move), so a raw-AS move MIGHT succeed where CLONE's did not — an open probe. Practically moot for spawning, which never paused (P3's template spawned into the trash exactly like P1: `icCount=4` at 07-08, `icCount=5` at 07-09).

## R4 — after-completion cadence in a trashed project

**Fixture.** Project `TR-P2` holding an after-completion-daily repeating to-do (the source to-do reused as the sole instance, RSIM2; template `next=NULL`, `icCount=1`). Trash `TR-P2`.

- **Dormant on the clock (07-06, 07-08):** `next=NULL`, `icCount=1`, no new instance — AC is completion-driven, and a trashed container does not change that.
- **Complete the AC instance WHILE trashed (07-08):** `todo complete` on the derived-trashed instance **SUCCEEDED** (`vector=url-scheme`, tier 0 — the instance's own `trashed=0`, so the URL write lands): `status 0→3`, `start 2→1`, `stopDate` stamped. The template's `next` cursor was stamped to the following day (completion 07-08 + 1 = 07-09).
- **Successor spawns INTO the trash (07-09):** on the next relaunch a fresh AC occurrence materialized, `project=TR-P2` (trashed), `startDate=07-09`, `icCount 1→2`. So an after-completion successor also spawns into the trash once its (completion-stamped) date arrives.
- **Restore `TR-P2`:** clean (`trashed 1→0`); the series is intact with its instance set (the completed original + the spawned 07-09 successor become visible). No extra spawn on restore.

## R5 — raw trash of a TO-DO template (CLONE residual closed)

- **Shipped `todo delete <template>`:** REFUSED `blocked:H-REPEAT-SCHEDULE` (WG-8, to-do template delete guard — reconfirmed under golden-v2).
- **GUI delete-dialog capture (best-effort AX):** did not surface a capturable sheet headlessly (`show to do id` + `key code 51` raised no enumerable dialog; `buttons`/`static text of every sheet` came back empty). **The exact dialog wording (delete-all-future vs this-occurrence) remains a documented residual** — it needs an eyes-on GUI sitting, not a headless AX drive.
- **Raw AppleScript `delete to do id <template>` (the unguarded surface):** **SUCCEEDED** and matches the **project-template pattern (CLONE C3)** exactly:

```
~ CHANGE  TR-R5 (template)   trashed 0→1   rt1_nextInstanceStartDate 07-06 → None (CLEARED)
   instance TR-R5 (WScCrkd8…)   trashed=0, rt1_repeatingTemplate INTACT → ORPHANED but live
```

So the **raw-app fate of trashing a TO-DO template = cursor CLEARED + instance ORPHANED**, identical to the project-template row-trash (C3/C4). This closes the CLONE-noted "to-do-template raw-app trash fate remains unprobed" residual: it does NOT differ from the project-template pattern.
- **Restore via shipped `todo restore <template>`:** REFUSED `blocked:H-REPEAT-SCHEDULE` (the template guard also covers `todo.restore`). The trashed template stays trashed; the series is **not resumable through the shipped CLI**. (The instance remains orphaned-live; its dangling FK is only repaired to `None` when the template is hard-deleted — see R7.)

## R6 — reader honesty (woven through)

The shipped CLI reads were captured at every state (`lab/artifacts/trshrep-lab/reads/`). The derived-trash model ([`CONTAINER_UNTRASHED`](../../src/read/predicates.ts) / [`pre-state.ts`](../../src/write/pre-state.ts)) is **honest** for the container case:

- While `TR-P1` is trashed, its child template + all in-trash occurrences are correctly HIDDEN from `today`/`upcoming`/`anytime`/`inbox`; only `trash` shows the project row. No derived-trashed instance leaked into a live view.
- After restore, the (formerly derived-trashed) occurrences correctly appear in `today`/`upcoming`/`anytime`.
- **Two reader observations (not misreads, but worth noting):**
  1. **An orphaned instance whose template is trashed reads as LIVE** (`today`/`anytime` show `TR-R5` after R5's raw template-trash). The instance's own `trashed=0` and it is a genuine open to-do, so this is arguably correct — but it is an orphan pointing at a trashed/absent template (GUI parity: CLONE C3 noted the app also counts it live). Flag only.
  2. **A trashed TEMPLATE never appears in the `trash` view** (templates are `start=2`/someday and list-invisible everywhere, including Trash). So `trash` shows trashed *projects* but not trashed *templates* — consistent with the app (templates render only in area/Show-Latest surfaces), not a bug.

No coverage GAP was opened: nothing read as live that the container-trash model should hide.

## R7 — empty-trash cascade on a trashed project's LOGGED children

**Fixture.** Project `TR-R7` with an open child, a completed child (`status=3`, real `stopDate`), and a canceled child (`status=2`, real `stopDate`). `project delete TR-R7` (shallow: only the project row `trashed=1`; the three children keep their own `trashed=0`). Then `trash empty --dangerously-permanent` (GLOBAL — sequenced LAST per the SL2 discipline; the full trash census was recorded first).

**Result — the container-derived-trashed children were HARD-DELETED:**

```
- DELETE TR-R7            (project, trashed=1)
- DELETE TR-R7-open       (status=0, OWN trashed=0)   → gone
- DELETE TR-R7-done       (status=3, OWN trashed=0, stopDate 07-08) → gone   ← completed history DESTROYED
- DELETE TR-R7-cancel     (status=2, OWN trashed=0, stopDate 07-08) → gone
```

So **`empty trash` cascades through a trashed container and permanently deletes its logged children even though their own `trashed=0`.** A27 ("empty-trash hard-deletes `trashed=1` rows") is therefore INCOMPLETE: emptying also destroys the container-derived-trashed subtree. **Consequence: emptying the Trash silently destroys completed/canceled task history that lived under a trashed project.**

- **Tombstones:** 13→18 (+5). The +5 are exactly the repeating-lineage rows co-emptied in this global sweep (the `TR-R5` template + the `TR-P3` template + its in-trash instances). The PLAIN logged children (`TR-R7-done`/`-cancel`/`-open`, plain projects) left **NO tombstone** — TOMB1 confirmed (`leavesTombstone=1` only on repeating lineage). So the destroyed completed history leaves **no trace** in `TMTombstone`.
- **Bonus (dangling-FK repair):** the R5 orphaned instance (`WScCrkd8…`), whose template was hard-deleted in the same empty, had its dangling `rt1_repeatingTemplate` FK **cleared to `None`** by the empty — the app repairs the orphan rather than leaving a pointer to a dead row.
- **Open child fate (contrast):** the OPEN child was hard-deleted just like the logged ones (it was container-derived-trashed and had no independent life), confirming the cascade is by containment, not by status.

## R8 — MIXED open+completed native fixed `project make-repeating` (the flagged RSIM-U cell)

**Fixture (×2 for determinism).** A plain project holding exactly one OPEN + one COMPLETED child (real `stopDate`), converted via fixed `project make-repeating` (ui vector, weekly). **Both runs PRESERVED the source (2/2):**

```
~ CHANGE  TR-R8a (source project)   start 1→2, startDate→07-05, rt1_repeatingTemplate→<new template>   (becomes the INSTANCE)
+ INSERT  <new template project>    start=2, rule(fu=256,tp=0), icCount=1, next=07-12
+ INSERT  TR-R8a-open  (template-side copy, status=0)
+ INSERT  TR-R8a-done  (template-side copy, status=0 — REOPENED)
   SOURCE-FATE: proj-exists=1, tmpl=<template>   (PRESERVED-as-instance, replacedUuid=null, childrenReplaced=0)
   completed child 7PGSLTgs…: exists=1, trashed=0, status=3   (history INTACT on the preserved instance side)
```

- **(a) source fate:** RSIM-U's "any open child → DELETE" is TOO STRONG. A **completed child among open siblings flips the fate to PRESERVE** — deterministically (2/2), and distinct from CLONE B3 (golden-v2, plain-open-children-only → DELETE). This resolves the RSIM-U "unisolated cell" ([rsim-results.md](rsim-results.md) §RSIM-U): a single terminal child suffices to preserve even with an open sibling.
- **(b) history destruction:** because the source PRESERVES, the completed child's history row **survives** (it rides the preserved instance side, `status=3`+`stopDate` intact); the template side gets a **reopened** copy (`status=0`, RSIM-S pristine law). So native promote on a mixed open+completed project does **NOT** destroy logged history — the anticipated headline oddity does not occur *precisely because* the terminal child triggers source-preserve. (The S-R1 whole-subtree-hard-delete concern applies only to the DELETE branch, which this configuration does not take.)

> **Flag, do NOT fold — a broader preserve-trigger under golden-v2/3.22.12.** R8 (completed child) preserves, and **R9a (a to-do with a CHECKED checklist item, no deadline) and R9b (a project whose open child carries a checked checklist item) ALSO preserved their sources** — both contradicting the golden-v1 laws RSIM-T ("only a deadline preserves a to-do; checklist does not") and RSIM-R ("a plain project with an open child deletes"). A coherent hypothesis: **a terminal/completed element anywhere in the source — a completed/canceled child OR a checked checklist item — triggers source-PRESERVE** (generalizing RSIM-U's terminal-child trigger), on top of the known deadline (to-do) and nested-repeater (project) triggers. This is either a genuine v1→v2 behavioral drift or coverage of cells CLONE's B-series never exercised. It bears on the promote-via-clone source-fate assumptions — **recommend a targeted reconciliation re-run** (bare vs checked-checklist to-do; plain-open vs open+checked-checklist project; ×N) before folding into the simulator's source-fate appliers. Not folded here.

## R9 — checklist CHECKED-state across template→occurrence spawn

**(a) repeating TO-DO** `TR-R9a` with a checklist `{CIdone (checked), CIopen}`, converted fixed-daily (source PRESERVED — see the R8 flag):
- **At conversion:** the TEMPLATE-side checklist copy **RESET** the checked item (`CIdone status 3→0`); the preserved-source instance kept it checked (`status=3`).
- **At the 07-06 spawn:** the new occurrence's `CIdone` is born **UNCHECKED** (`status=0`).

**(b) checked item inside a repeating PROJECT template** `TR-R9b` (child `TR-R9b-k1` with `{CIbdone (checked), CIbopen}`), converted fixed-daily (source PRESERVED):
- **At conversion:** BOTH the template-side and instance-side child copies **RETAINED** the checked item (`CIbdone status=3`) — the project conversion did NOT reset it, unlike the to-do conversion.
- **At the 07-06 spawn:** the newly-materialized occurrence child's `CIbdone` is nonetheless born **UNCHECKED** (`status=0`), even though the template-side child still shows `status=3`.

**Law.** A spawned occurrence's `TMChecklistItem` rows are born **all-unchecked**, regardless of the template's stored checked-state — the spawn NORMALIZES checklist checked-state to open, exactly as it normalizes child status/schedule (RSIM-S "pristine occurrence"). Checked-state does not propagate to occurrences. (Conversion itself is asymmetric — a to-do conversion resets the template's checklist to unchecked, a project conversion preserves the child's checked-state on both copies — but the SPAWN normalizes either way.)

---

## Reproduction notes

- One clone, ~7 min end to end (10 GUI `make-repeating` drives + 3 clock advances). Same lifecycle/toolchain guards as CLONE (self-contained node, worktree `npm ci`, golden-v2 baked AX grant, VM-limit orphan recovery). Guest helpers in `~/things-lab/helpers` (reboot-surviving) and re-installed after each advance; no reboot occurred (all steps ≤2 days).
- Clock advances quit the app, `sudo date`, then warm-relaunch so the launch-time maintenance pass runs at the new date (the RSIM-S deterministic-spawn technique). Every advance re-asserted airgap + clock + helpers.
- `make-repeating` is a ui-vector op (`--dangerously-drive-gui` + `ui-enabled`). Fixtures fully synthetic (`TR-*` titles). Every verdict re-derived from the raw before/after snapshots.
- **Residuals:** the R5 GUI delete-dialog wording (needs an eyes-on sitting); the R3 raw-AS move of a derived-trashed template (single-clone budget); the R8/R9 broader-preserve-trigger reconciliation (flagged above).
