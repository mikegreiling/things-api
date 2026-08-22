# DBV27 — the Things 3.23 database migration, measured (live host, 2026-08-22)

**Version stamp:** Things **3.22.14 → 3.23** (auto-update on the maintainer's host, 2026-08-22), `Meta.databaseVersion` **26 → 27**. Pre-migration snapshot: Things' OWN daily backup `Backups/Things Database Backup 2026-08-22 (737).thingsdatabase` (databaseVersion 26, taken 00:00 the same day — the app keeps ~10 daily backups, so no Time Machine rescue was needed). Post: the live database (27). All reads read-only (`sqlite3 -readonly`, backup opened `immutable=1`); this doc carries **counts and column names only**, never content. Immutable snapshot per the version-stamping policy.

## DDL delta — index-only (invisible to the schema fingerprint BY DESIGN)

Full `sqlite_master` diff (tables, columns, triggers byte-identical; two index changes):

- **NEW partial index** `index_TMTask_id_where_recurrenceRuleNotNull ON TMTask (uuid) WHERE rt1_recurrenceRule IS NOT NULL`
- `index_TMTask_repeatingTemplate` **rebuilt** as `index_TMTask_repeatingTemplate_and_creationDate ON TMTask (rt1_repeatingTemplate, creationDate)`

The fingerprint hashes the depended tables/columns, so it is identical across the bump (`sha256:784bd2f6…d4c52b`) — correct behavior: indexes change the query planner, not data semantics. The v27 baseline (#518) therefore stands.

## Data migration (TMTask, joined on uuid; 22,074 shared rows)

| column | rows changed | transition shape |
|---|---|---|
| `rt1_nextInstanceStartDate` | **21,960** | value → **NULL** on every row that had one (plus 1 organic val→val) — the per-row next-instance cache is **RETIRED**, presumably superseded by the new partial index |
| `untrashedLeafActionsCount` / `openUntrashedLeafActionsCount` | **21,308** | **exactly +1**, every changed row is `type = 0` — leaf to-dos now count **themselves**; project rows measured UNCHANGED |
| `checklistItemsCount` / `openChecklistItemsCount` | 766 | recomputed on rows carrying checklists |
| `rt1_instanceCreationStartDate` | **94** (of 114 repeating templates) | strictly **FORWARD** — 0 backward, 0 null-transitions |
| `repeaterMigrationDate` | 0 | untouched in both (an older migration's marker; 0 non-null rows on this library) |
| everything else | ≤1 row | organic same-day edits |

## Engine impact (drives the 3.23 re-certification campaign — see up-next)

1. **Projection day broken:** `src/write/move.ts`, `src/write/reorder.ts`, and `src/write/pre-state.ts` read `rt1_nextInstanceStartDate` as a repeating template's projection day (TMPLSORT/PTMPL placement laws). It is now NULL library-wide, so template-adjacent move/reorder placement math has lost its input and must derive the projection day another way (rule decode + `rt1_instanceCreationStartDate` cursor). Until patched and lab-certified, template-adjacent moves/reorders on 3.23 are suspect — verify-per-write still fails closed, but expect refusals/verify-failures rather than correct placement.
2. **Cursor rewrite intersects the repeater laws:** 82% of templates had their spawn cursor moved forward by the migration — re-walk the spawn-shape / first-occurrence laws (and the #508 oracle) FIRST in the register walk. The strictly-forward pattern is consistent with the app re-anchoring cursors past already-materialized occurrences (possibly addressing the oddities §9ff double-spawn class — verify in the lab, do not assume).
3. **Counter semantics shift:** `src/read/shape.ts` consumes the leaf-action counters for container progress; only `type = 0` rows changed (+1 self-count), project rows unchanged, so shaped project progress is likely stable — confirm in `lab:regress`.
4. `rrv` decoding is UNAFFECTED: host doctor reports 114 templates / 0 undecodable under 27.

---

## CORRECTION (2026-08-22, GV4 in-lab re-measurement + live-host verification — [gv4-323-campaign.md](gv4-323-campaign.md))

The body above stands as the original snapshot; three of its readings were **corrected** by re-running the migration inside golden-v4 (clock-pinned, controlled) and verifying read-only against the live host:

1. **`rt1_nextInstanceStartDate` is NOT retired.** The migration nulls the cache on **non-template rows only** (live host: 0 of 21,962 non-templates carry one) and leaves every template's cached value byte-identical (73 of 114 templates still carry one). The template NULLs predate the migration — paused, trashed, or never-populated cohorts; the body's own arithmetic closes on ~42 pre-existing NULLs. The projection-day engine work (#520/#522) therefore fixes a **pre-existing** gap (~24% of live templates), not a 3.23 regression; its cache-first preference is correct on 3.23 too.
2. **The counter change is a `-1` sentinel → computed `0`** on row classes that never carried a real count — not a leaf self-count. Rows with real counts are untouched.
3. **The spawn-cursor rewrite did not reproduce** on a clock-pinned library (0 changed rows in-lab) — the 94 forward moves on the host are consistent with a one-time cursor **catch-up to "now"** at migration, not a rule re-anchor.
