# DBV29 — the Things 3.24 database migration, measured (live host, 2026-09-14)

**Version stamp:** Things **3.23.4 → 3.24** (auto-update on the maintainer's host, 2026-09-14; MAS build **32400506**, direct-download build **32400006**), `Meta.databaseVersion` **27 → 29** — a TWO-step jump in one hop. A "28" was never observed on this host: the prior install was 3.23.4, whose databaseVersion was 27 (doctor's `lastVerifiedWrite` was recorded under it). Host OS: macOS **27.0** (26A5425a).

Measured **read-only**, in two passes. The DDL/fingerprint half was measured on the live host through the deputy's `sql` facade (`observeSchema` + `compareToBaseline`, plus a full `sqlite_master` dump), against the banked `v27-first — live snapshot 2026-08-22T0245`. The DATA half was measured later the same day, once the maintainer banked the pre-update daily backup from a Full-Disk-Access terminal, against that true pre-update pair (§Data migration below, which independently reproduces the DDL verdict). Both snapshots live in `/Volumes/Workspace/things-db-archive/` (personal data: chmod 700, never committed). This doc carries **counts, column names and DDL only**, never content. Immutable snapshot per the version-stamping policy.

Release notes (App Store, 3.24): *"Things is ready for macOS 27 Golden Gate, with great new system integrations: Full integration with the new Siri. Full integration with Spotlight, your device's built-in search. More snoozing options for notifications. A new extra-tall widget. Various other compatibility improvements for the new OS."*

## DDL delta — two new tables + two new indexes (invisible to the schema fingerprint BY DESIGN)

Full `sqlite_master` diff, live v29 against the banked v27 snapshot. **Every existing table, column and trigger is byte-identical.** The whole delta:

| kind | statement |
|---|---|
| NEW TABLE | `CREATE TABLE BSSpotlightDirtyEntity ("entityType" INTEGER NOT NULL, "id" BLOB NOT NULL, "changeToken" BLOB NOT NULL, "expansionCursor" BLOB, PRIMARY KEY ("entityType","id")) WITHOUT ROWID` |
| NEW INDEX | `CREATE INDEX "index_BSSpotlightDirtyEntity_expansionCursor" ON BSSpotlightDirtyEntity ("entityType","id") WHERE "expansionCursor" IS NOT NULL` |
| NEW TABLE | `CREATE TABLE BSSpotlightIndexState ("id" INTEGER PRIMARY KEY CHECK ("id" = 1), "updateState" INTEGER NOT NULL, "isEnabled" INTEGER NOT NULL DEFAULT 0, "wholeIndexUpdateToken" BLOB NOT NULL, "wholeIndexExpansionCursor" BLOB, "staticEntitiesUpdateToken" BLOB, "lastCheckpointID" BLOB)` |
| NEW INDEX | `CREATE INDEX index_TMTask_userModificationDate ON TMTask(userModificationDate)` |

Nothing was removed and nothing was rebuilt.

## Fingerprint verdict — BYTE-IDENTICAL to v27

The observed fingerprint is `sha256:d2b7e98c6d384ef1ecd256b1410a11652e80c5860cc48370ec9b4d6956c7d4df` — exactly `DB_V27.fingerprint` (itself `DB_V26.fingerprint`, shared by construction since #518/#525). Correct behavior in both directions:

- the hash covers `PRAGMA table_info` over the **depended tables** named in `src/db/schema.ts`, and not one depended column moved;
- the two NEW tables are outside the depended-table manifest, so the fingerprint ignores them by design — a table the engine never reads cannot change what a read or a write means.

Before the baseline shipped, `things doctor` on the host reported `fingerprint: unknown-version` and `writes: DISABLED — unknown databaseVersion`. That is the gate working: an unrecognized stamp blocks writes even when the schema underneath is identical, and it is the version REGISTRY, not the hash, that unblocks it.

## Extra-column verdict — no new extras

The extra-column set (columns present in the live DB that the depended manifest does not name; recorded warn-only, excluded from the hash) is the SAME set v26/v27 already carried and `test/fixtures/schema-v26.sql` already reproduces:

| table | extra columns |
|---|---|
| TMTask | `cachedTags`, `contact`, `experimental`, `lastReminderInteractionDate`, `leavesTombstone`, `notesSync`, `repeaterMigrationDate`, `rt1_afterCompletionReferenceDate`, `t2_deadlineOffset` |
| TMArea | `cachedTags`, `experimental` |
| TMTag | `experimental` |
| TMChecklistItem | `experimental`, `leavesTombstone` |
| TMSettings | `experimental` |

Zero additions, zero removals.

## sdef parity — zero AppleScript surface delta

`Things.sdef` sha256 is `1b6752334207f68cdcb7e71dfc34a21407095bd239afe5df6b3cdd8e2c70cde0` — identical in the direct-download 3.24 zip and the host MAS bundle, and **unchanged since 3.22.11**. `_private_experimental_` is still declared (so the sdef canary's reading is unchanged; the ≥3.23 behavioral version gate from #525 still governs whether the native reorder is dispatched). `LSMinimumSystemVersion` is unchanged at 13.3.

The bundle was built with Xcode 27 / the macOS 27 SDK (`DTPlatformVersion` 26.0 → 27.0), and the main binary newly links **CoreSpotlight, GeoToolbox, _AppIntents_SwiftUI, _GeoToolbox_AppIntents** — consistent with the release notes' Siri/Spotlight/App-Intents framing and with a scripting dictionary that did not move.

## What the new tables plausibly are

**Plausibly** (inferred from shape and row counts; nothing here inspects their contents): the persistence layer for the 3.24 Spotlight semantic index. At observation `BSSpotlightDirtyEntity` holds **0** rows and `BSSpotlightIndexState` holds exactly the one row its `CHECK ("id" = 1)` permits, with `isEnabled = 1` and `updateState = 0` — indexing on, queue drained.

- `BSSpotlightDirtyEntity` reads as a **dirty-set / work queue**: one row per (entity type, entity id) awaiting indexing, carrying a `changeToken` and an optional `expansionCursor`. The partial index over rows `WHERE "expansionCursor" IS NOT NULL` is exactly the shape of "find me the entities whose expansion is part-done and must be resumed".
- `BSSpotlightIndexState` reads as the **singleton index checkpoint** (`CHECK ("id" = 1)`): an enable flag, an update state, whole-index and static-entity update tokens, an expansion cursor, and a last-checkpoint id — i.e. enough to resume a whole-library reindex across launches.

The `BS` prefix matches Cultured Code's existing internal prefix (`BSSyncronyMetadata`), so this is app-side plumbing, not an OS-managed table.

## Engine impact — none (expected, then confirmed)

No depended column moved, no trigger moved, no table the engine reads changed shape. Reads, writes, the verify loop, the repeat-rule decoder and the projection helpers all address the same columns they addressed under v27.

- **Repeat-rule canary is clean:** host doctor reports **128 templates / 0 undecodable** under v29 — `rrv` decoding is unaffected by 3.24.
- **One thing worth remembering:** `index_TMTask_userModificationDate ON TMTask(userModificationDate)` suggests the Spotlight indexer keys its change feed on `userModificationDate` — i.e. the app now has a *consumer* of that column that did not exist before. That is directly relevant to the `--preserve-modified` line of work (a write that deliberately restores an older `umd`): a restored-backwards `umd` may now also determine whether and when the row is re-indexed for Spotlight. The migration itself did NOT touch the column (§Data migration: 2 changed rows, both organic), so this is purely a forward question — a hypothesis to probe in the 3.24 recertification campaign, and the first time `umd` has had a non-sync consumer inside the app.

## Baseline decision

Per the **2026-08-22 identical-schema ruling** (`docs/design/decisions.md`; first applied to `db-v27.ts`): fingerprint byte-identical **and** no new extra columns ⇒ ship the new-version baseline same-day reusing the prior hash. Writes re-enable honestly — the schema gate measures DDL, and none of the depended DDL moved — and the `accepted-fingerprint` escape hatch is NOT used. `certified-app-version` stays **3.23**; doctor's passive behavioral notice is the standing reminder until the full drift-runbook recertification (golden-v5/v5h, `lab:regress` both arms, assumption-register walk) lands.

Shipped as `src/db/baselines/db-v29.ts`, with the fixture (`test/fixtures/schema-v26.sql`, now stamped 29 and carrying the v29 table/index set) and `SIMULATED_DATABASE_VERSION = 29` moved in lockstep (drift-runbook step 5).

---

## Data migration — MEASURED (2026-09-14, later the same day)

The pre/post pair was banked from an FDA terminal after the DDL half above was written, so this section is a measurement, not a projection. Method: the DBV27 method — the old database ATTACHed with the `file:…?immutable=1` URI, per-column changed-row counts joined on `uuid`, transition shapes for every changed column. Counts and column names only.

**Pair:**

| side | snapshot | stamp |
|---|---|---|
| pre | Things' own daily backup `… 2026-09-11 (757).thingsdatabase` | 27 |
| post | `v29-first — live snapshot 2026-09-14T1318.sqlite` | 29 |

**⚠ CAVEAT — the pre snapshot is THREE DAYS old, not same-day.** Things made no daily backup on 09-12 or 09-13, so the newest pre-update backup is 09-11 and every count below includes ~3 days of ORGANIC edits on a live library. (Visible directly: 15 TMTask rows and 10 TMChecklistItem rows exist only on the new side, 0 rows disappeared.) This is weaker evidence than DBV27's same-day pair, and it is why the counts are read here as *migration-shaped mass change* vs *organic noise* rather than taken at face value. **The clean re-measurement comes from the golden-v5 in-lab swap** — pre/post copies taken either side of the first post-swap warm-up launch, with no organic traffic at all — and that measurement SUPERSEDES this section when it lands.

### Shared-row population

| table | pre | post | shared |
|---|---|---|---|
| TMTask | 22,323 | 22,338 | 22,323 |
| TMChecklistItem | 1,047 | 1,057 | 1,047 |
| TMArea | 12 | 12 | 12 |
| TMTag | 49 | 49 | 49 |
| TMSettings | 1 | 1 | 1 |

Column sets are identical on every table, both sides — an independent confirmation of the DDL verdict above, this time against the real pre-update database rather than the August snapshot. The `sqlite_master` delta computed across this pair is EXACTLY the four objects listed in the DDL section (`BSSpotlightDirtyEntity`, `index_BSSpotlightDirtyEntity_expansionCursor`, `BSSpotlightIndexState`, `index_TMTask_userModificationDate`) with **zero** removals.

### Per-column changed-row counts (TMTask; 22,323 shared rows)

Every column not listed changed on **0** rows. `TMChecklistItem`, `TMArea`, `TMTag` and `TMSettings` have **no changed column at all** across the pair.

| column | rows changed | transition shape | reading |
|---|---|---|---|
| `rt1_instanceCreationStartDate` | **96** (of 128 templates) | 96 val→val, **96 forward / 0 backward**; every changed row is a template (`rt1_recurrenceRule IS NOT NULL`) | the ONLY mass change — see below |
| `todayIndexReferenceDate` | 8 | 5 val→val, 3 val→null | organic |
| `rt1_nextInstanceStartDate` | 8 | 5 val→val, 3 val→null | organic |
| `rt1_instanceCreationCount` | 8 | 8 val→val | organic |
| `start` | 7 | 7 val→val | organic |
| `todayIndex` | 4 | 4 val→val | organic |
| `openUntrashedLeafActionsCount` | 3 | 3 val→val | organic |
| `rt1_afterCompletionReferenceDate` | 3 | 3 val→null | organic |
| `userModificationDate` | **2** | 2 val→val | **NOT touched by the migration** |
| `status` / `stopDate` / `startDate` / `untrashedLeafActionsCount` | 2 each | completions (`stopDate`/`startDate` null→val) | organic |

Everything at ≤8 rows on a 22,323-row library over three live days is ordinary use — completions, a couple of Today reorders, a handful of repeating instances spawning. None of it has a migration shape (no row class moves together, no fixed delta, no library-wide null→value).

### The four readings that were flagged in advance

1. **`userModificationDate` was NOT rewritten.** Two changed rows, both ordinary edits. The new `index_TMTask_userModificationDate` was therefore built over the EXISTING column values — the migration added an index, not a timestamp rewrite. This is the reassuring answer for `--preserve-modified`: nothing about existing `umd` values was normalized, clamped or re-stamped by 3.24. (It does NOT settle the forward question — whether the Spotlight indexer now CONSUMES `umd` as a change feed, and what a deliberately-backdated `umd` therefore does to indexing — which stays a probe cell for the 3.24 recertification campaign.)
2. **The `rt1_*` cursor/cache columns held.** `rt1_nextInstanceStartDate` is still template-scoped exactly as GV4 established: **0** non-template rows carry one on either side of the pair (so the v27 scoping survived the 27→29 migration untouched), and the 8 changed rows are template-side organic movement. `templateProjectionDay`'s cache-first-then-derive shape is right on 3.24 too.
3. **The counters were not re-migrated.** 2–3 changed rows, and **zero `-1` sentinels remain** in any of the four counter columns post-migration — the v27 back-fill stands, and 3.24 did nothing further to them.
4. **No column is NULL→value on nearly all rows.** The largest null→val count anywhere in the pair is 2.

### The one mass change: the spawn cursor, again

`rt1_instanceCreationStartDate` moved on **96 of 128 repeating templates**, every move **strictly forward** (96 forward, 0 backward, 0 null transitions), every changed row a template. This is the SAME shape DBV27 saw on the host across the 26→27 migration (94 of 114, strictly forward) — and GV4 §2.3 showed that shape **did not reproduce** in a clock-pinned in-lab migration (0 changed rows), which is what established the reading: it is the app catching each template's spawn cursor up to "now" on first launch, not a schema-driven rewrite.

Recurring on this pair is consistent with that reading and not with a migration rewrite: three days of stale cursors is exactly what a first-launch catch-up would move, and a three-day-old pre snapshot cannot distinguish "the update migrated it" from "the app caught up when it next launched" — only the clock-pinned lab swap can. **Nothing is modeled from it** (the simulator deliberately does not model a migration-time cursor rewrite), and the golden-v5 swap is where it gets settled for 3.24.

### Verdict

**3.24's database migration is, on this evidence, DDL-only: two Spotlight-plumbing tables, two indexes, and no data rewrite at all.** That is a materially quieter migration than 3.23's, and it is consistent with the release's framing (an OS-integration release, not a data-model release). The three-day caveat means "no data rewrite" is a strong reading rather than a proof; the golden-v5 in-lab swap supersedes it.

The new tables are effectively empty at observation: `BSSpotlightDirtyEntity` has **0** rows and `BSSpotlightIndexState` has exactly the one row its `CHECK ("id" = 1)` allows, with `isEnabled = 1` and `updateState = 0` — i.e. indexing enabled and the dirty queue drained, which supports the dirty-set/checkpoint reading above.

### Reconciliation

Nothing measured here moves a column the engine reads, so runbook step 8 (the dependency sweep) closes with no code change, and the simulator appliers need no re-reading for 3.24 — `SIMULATED_DATABASE_VERSION = 29` rests on the stamp with the data semantics confirmed unmoved. SIMFID applier fidelity is still to be re-certified under 3.24; that rides the recertification campaign along with the clean in-lab re-measurement.

---

## In-lab re-measurement (GV5, 2026-09-14) — the clean pair, and it is ZERO

**Version stamp:** `things-lab-golden-v5` (minted from a `things-lab-golden-v4` clone the same day) · Things **3.23 → 3.24** (direct-download build **32400006**) · macOS **15.7.7 (24G720)** · guest clock pinned **2026-07-05 12:00**, airgapped, **before Things was ever launched** · `Meta.databaseVersion` **27 → 29**.

This is the clean pair the §Data-migration caveat above promised, and it **SUPERSEDES that section's data half**. The pre/post copies are `golden-inplace-swap.sh`'s own, taken either side of the single post-swap warm-up launch on a 37-row synthetic fixture with no organic traffic, no sync, and a frozen clock — so there is nothing for a migration-shaped change to hide behind. The DDL half above needed no correction and is independently reproduced here. Method as before: the two copies ATTACHed, per-column changed-row counts joined on `uuid`, transition shapes for anything that moved. Counts and column names only. Full campaign: [gv5-324-campaign.md](gv5-324-campaign.md).

### DDL — reproduced exactly, additive only

The full `sqlite_master` **text** diff across the pair is precisely the four objects the host measurement named, with **zero removals** and every pre-existing table, column, index and trigger byte-identical:

```
NEW TABLE  BSSpotlightDirtyEntity  (WITHOUT ROWID, PK (entityType, id))
NEW INDEX  index_BSSpotlightDirtyEntity_expansionCursor
             ON BSSpotlightDirtyEntity ("entityType","id") WHERE "expansionCursor" IS NOT NULL
NEW TABLE  BSSpotlightIndexState   (singleton, CHECK ("id" = 1))
NEW INDEX  index_TMTask_userModificationDate ON TMTask(userModificationDate)
```

`observeSchema()` over both copies returns the SAME fingerprint — `sha256:d2b7e98c6d384ef1ecd256b1410a11652e80c5860cc48370ec9b4d6956c7d4df` — with `databaseVersion` reading **27** on the pre side and **29** on the post side, and **zero extra columns** on either. The two-step 27 → 29 jump with no 28 reproduces in the lab exactly as it did on the host.

### Data — ZERO changed rows, on every table

| table | pre | post | shared | inserted | deleted | columns changed |
|---|---|---|---|---|---|---|
| `TMTask` | 37 | 37 | 37 | 0 | 0 | **0** |
| `TMChecklistItem` | 3 | 3 | 3 | 0 | 0 | **0** |
| `TMArea` | 2 | 2 | 2 | 0 | 0 | **0** |
| `TMTag` | 10 | 10 | 10 | 0 | 0 | **0** |
| `TMSettings` | 1 | 1 | 1 | 0 | 0 | **0** |
| `TMTombstone`, `TMContact`, `TMSmartList`, `BSSyncronyMetadata`, `ThingsTouch_*` | — | — | — | 0 | 0 | **0** |

Not one column moved on one row. This is a materially stronger statement than the host pair could make, and it converts that section's "strong reading" into a measurement: **3.24's migration is DDL-only.** Against 3.23's — which cleared a sentinel on 35 of 37 rows and back-filled four counter columns — 3.24 does nothing to the data at all.

### The spawn cursor: SETTLED

`rt1_instanceCreationStartDate` moved on **96 of 128 templates, strictly forward**, on the host pair, and the reading offered above was that this is first-launch catch-up rather than a migration rewrite — the same shape DBV27 saw, which GV4 §2.3 could not distinguish because the lab clock is pinned.

Under the pinned clock here it moves on **0 rows**, on a pair whose only event between the two copies is the 3.24 warm-up launch. That is the discriminator the host pair lacked, and it lands on the catch-up reading:

- if the MIGRATION rewrote the cursor, it would have rewritten it here too — the migration demonstrably ran (27 → 29, new tables present);
- it did not, so the mass forward move on the host is the app advancing each stale cursor to "now" on first launch, and a clock that is already at "now" gives it nothing to advance.

**The conclusion GV4 §2.3 called "a cell worth designing" is now answered for 3.24 without designing it, and the simulator is right not to model a migration-time cursor rewrite.** Two caveats, stated so the claim is not over-read: the golden holds only two templates, and both sit at the pin — so this shows the migration does not rewrite a CURRENT cursor, not that it would leave a STALE one alone. Distinguishing those still needs a clone pinned forward by months, which no golden's trial wall currently affords.

### The other pre-flagged readings, re-checked

- **`userModificationDate` was not rewritten** — 0 changed rows (the host saw 2, both organic). The new index over it was built on the existing values. The forward question the host section raised — whether the Spotlight indexer now CONSUMES `umd` as a change feed, and what a deliberately-backdated `umd` does to indexing — is **untouched by this campaign and stays open**, and is now known to be unanswerable on a macOS 15 guest for the reason below.
- **`rt1_nextInstanceStartDate` scoping held exactly.** Both sides: 35 non-template rows with no value, 2 templates with one. The v27 template-scoping survives 27 → 29 untouched, so `templateProjectionDay`'s cache-first-then-derive shape is right on 3.24.
- **The counters were not re-migrated.** Zero `-1` sentinels on either side of the pair, in all four counter columns — the v27 back-fill stands and 3.24 did nothing further to them.

### The Spotlight tables are created EMPTY, and stay empty here

Post-migration, `BSSpotlightDirtyEntity` holds **0** rows — and so does `BSSpotlightIndexState`, which on the maintainer's macOS 27 host carries the one row its `CHECK ("id" = 1)` permits (`isEnabled = 1`, `updateState = 0`). So the migration creates the plumbing unconditionally on **every** OS, and the singleton state row is written by the macOS-27-only Spotlight integration when it first runs, not by the migration. That is consistent with the release's framing and with [ai324-app-intents-catalog.md](ai324-app-intents-catalog.md): on a macOS 15 guest the Spotlight/App-Intents epicenter is inert, and **the lab cannot observe it at all** — which bounds what any 3.24 lab campaign can certify.
