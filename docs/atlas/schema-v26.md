# Things Database Atlas — schema v26 / v27

The living map of Things 3's SQLite database, annotated with how each field drives what the user sees in the app. Structure and enum values here were probed live (read-only) against a real, long-lived Things library; behavioral semantics come from the validated research in [`../research/`](../research/) (especially `validation-notes-step3.md`).

**One document, two generations.** The body below was captured at `Meta.databaseVersion` = **26** (Things 3.22.11, 2026-07-02) and every table/column/trigger statement in it is still exact under **27** (Things 3.23, 2026-08-22): the 26→27 migration has **zero** table/column/trigger delta, so the two generations share a schema fingerprint by construction ([`src/db/baselines/db-v27.ts`](../../src/db/baselines/db-v27.ts) reuses `DB_V26.fingerprint`). What DID move — three indexes and two data semantics — is in [§v27 delta](#v27-delta-things-323) below, and the individual rows in the tables carry the v27 note inline. The file is deliberately NOT renamed: ~15 documents link this path, and a rename would be churn, not information.

**Location:** `~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-<suffix>/Things Database.thingsdatabase/main.sqlite` (WAL mode; `-shm`/`-wal` sidecars present whenever Things has run). The `<suffix>` varies per account. Direct-download and MAS builds share this container (bundle-level parity verified; see `../../vendor/manifest.json`).

**Capture query** (regenerates [`test/fixtures/schema-v26.sql`](../../test/fixtures/schema-v26.sql)):
```sh
sqlite3 -readonly "<main.sqlite>" \
  "SELECT sql || ';' FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
   ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name;"
```
Run against a **3.23** library this emits a v27 capture — identical except for the three index lines in §v27 delta. That is the shape the checked-in fixture now carries (its `Meta.databaseVersion` stamp is **27**); the filename keeps the `v26` spelling for the same no-churn reason as this document.

## v27 delta (Things 3.23)

Measured twice: on the maintainer's live library against Things' own pre-update daily backup ([`../lab/dbv27-migration-diff.md`](../lab/dbv27-migration-diff.md)), then re-measured in a clock-pinned golden-v4 clone, which **corrected** two of the three original readings ([`../lab/gv4-323-campaign.md`](../lab/gv4-323-campaign.md) §2). The corrected version is what follows.

**DDL — index-only** (invisible to the fingerprint by design: the hash covers `PRAGMA table_info` for the depended tables, and indexes steer the query planner, not data semantics):

| change | statement |
|---|---|
| ADDED | `index_TMTask_id_where_recurrenceRuleNotNull ON TMTask (uuid) WHERE rt1_recurrenceRule IS NOT NULL` — a partial index over exactly the repeating templates |
| ADDED | `index_TMTask_repeatingTemplate_and_creationDate ON TMTask (rt1_repeatingTemplate, creationDate)` |
| REMOVED | `index_TMTask_repeatingTemplate ON TMTask (rt1_repeatingTemplate)` — superseded by the two-column form above |

**Data semantics — two changes, both real:**

1. **The counter sentinel is gone.** The migration back-fills the `-1` "uninitialised" sentinel with a computed **`0`** on the row classes that never carried a real count: `untrashedLeafActionsCount` / `openUntrashedLeafActionsCount` on `type = 0` (to-dos, which have no leaf children), `checklistItemsCount` / `openChecklistItemsCount` on `type = 1` and `type = 2` (projects and headings, which can hold no checklist). Rows that already carried a real count are **untouched**. Under 27 every row therefore carries all four counters and **`-1` no longer means "unknown"** — a consumer that read the sentinel that way now sees a genuine `0`. (This CORRECTS the first host reading, which framed the aggregate `-1 → 0` shift as leaf to-dos "counting themselves +1".)
2. **`rt1_nextInstanceStartDate` is scoped to templates, NOT retired.** The migration NULLs it on every non-template row and leaves every repeating template's cached value **byte-identical**; the set of rows keeping a value is exactly `rt1_recurrenceRule IS NOT NULL` — which is precisely what the new partial index is for. Verified read-only on the live host (0 of 21,962 non-templates carry one; **73 of 114 templates do**) and on a 3.23 lab corpus (8 of 10 templates, every calendar shape — [`../lab/rdlg2-323-recipe-cert.md`](../lab/rdlg2-323-recipe-cert.md) §6.1). The 3.23 app keeps maintaining the cache, so the projection day was **not** broken by the update; templates lacking a cached day (after-completion rules, paused series, and a live cohort that never had one) lacked it under 3.22 too, and are the cohort [`src/model/template-projection.ts`](../../src/model/template-projection.ts) derives for.

**What did NOT move:** `rt1_instanceCreationStartDate` was byte-unchanged on both lab templates (0 rows), so the strictly-forward cursor move seen on the host is best explained as a one-time catch-up to "now" on first launch, **not** a schema-driven rewrite — and is deliberately not modeled anywhere. `repeaterMigrationDate` untouched. Zero rows inserted or deleted; every other table's row count unchanged. Rule blobs still decode (`rrv` unaffected).

## Table inventory

| Table | Role | Depended on by things-api |
|---|---|---|
| `TMTask` | To-dos, projects, AND headings — discriminated by `type` | **Core** |
| `TMArea` | Areas | **Core** |
| `TMTag` | Tags (hierarchical via `parent`) | **Core** |
| `TMTaskTag` | Task↔tag join (`tasks`, `tags` uuid columns) | **Core** |
| `TMAreaTag` | Area↔tag join | **Core** |
| `TMChecklistItem` | Checklist items (children of a to-do via `task`) | **Core** |
| `TMSettings` | Singleton settings row — incl. `uriSchemeAuthenticationToken` (the URL-scheme auth token, readable → zero-config write auth) and `groupTodayByParent` | **Core** |
| `Meta` | Key/value: `databaseVersion` (plist blob wrapping an `<integer>`), `didCreateDefaultTags`, `didRemoveOrphanHeadings` | **Core** (drift keying) |
| `TMTombstone` | Deletion records (`deletedObjectUUID`, `deletionDate`) written ONLY for deleted rows with `leavesTombstone=1` (repeating-template lineage) — **NOT a general deletion log**; ordinary deletions propagate tombstone-lessly via the Syncrony change-log (TOMB1) | Read-informative (delete forensics); unsuitable as a `changes --since` deletion cursor |
| `TMSmartList` | Saved filters/smart lists (`definition` BLOB) | Not yet |
| `TMContact` | Contacts (AppleScript `contact` class / `add contact named`) | Not yet |
| `TMMetaItem`, `BSSyncronyMetadata` | Sync-engine internals (opaque BLOBs) | Never (do not touch) |
| `ThingsTouch_ExtensionCommandStore_{Commands,Meta}` | Command queue for app extensions (widgets/share/intents); observed empty (drained). **Not a sanctioned write vector** — reverse-engineering it would be direct-DB-write by another name | Never |

Indexes (v26): `index_TMTask_{area,project,heading,repeatingTemplate,stopDate}`, `index_TMTaskTag_tasks`, `index_TMAreaTag_areas`, `index_TMChecklistItem_task`, `index_TMTombstone_deletedObjectUUID`. **v27** replaces `index_TMTask_repeatingTemplate` with `index_TMTask_repeatingTemplate_and_creationDate` and adds the partial `index_TMTask_id_where_recurrenceRuleNotNull` — see [§v27 delta](#v27-delta-things-323).

## TMTask — the everything table

One row per to-do, project, or heading. Cultured Code's own DDL comments record the rename history (`heading` ← `actionGroup`, `deadline` ← `dueDate`, `contact` ← `delegate`, `rt1_*` ← unprefixed).

### Discriminators & lifecycle

| Column | Domain (verified live) | Meaning / UI effect |
|---|---|---|
| `type` | `0` to-do · `1` project · `2` heading | What kind of row this is. Headings observed only with `status=0`. |
| `status` | `0` open · `2` canceled · `3` completed | Canceled and completed both land in **Logbook** (with `stopDate`). There is no status `1`. |
| `stopDate` | epoch REAL or NULL | When completed/canceled. Logbook ordering key (indexed). Logbook *grouping* into days happens at render time. |
| `trashed` | `0` / `1` | **Trash is a flag, not a list.** Trashed rows keep their `project`/`area` links. **Project deletion is shallow** (lab A24B, 2026-07-03): only the project row gets `trashed=1`; its children keep `trashed=0` + the `project` link — children's Trash membership is *derived through the parent*. Any Trash mirror/restore must traverse, not just filter `trashed=1`. Area deletion is the inverse: the TMArea row is hard-deleted and contained to-dos get `trashed=1` (A25/A25B). No `TMTombstone` rows are written for any delete while sync is off (A25/A27) — tombstones are a sync artifact. |
| `creationDate`, `userModificationDate` | epoch REAL | `userModificationDate` is the verification engine's cheap "did anything happen" tripwire. |

### Scheduling — what puts a task in which list

| Column | Domain | Meaning |
|---|---|---|
| `start` | `0` Inbox · `1` Anytime/Today · `2` Someday | Coarse placement bucket. |
| `startDate` | packed int or NULL | The "When" date. **Packing: `y<<16 \| m<<12 \| d<<7`** (verified: `132803712` → 2026-06-25). |
| `startBucket` | `0` Today · `1` This Evening | Sub-placement within Today. things.py cannot see this; we expose it as `todaySection`. |
| `reminderTime` | packed int or NULL | Time-of-day for the reminder. **Packing: `hour<<26 \| minute<<20`** (i.e. `(hour*64 + minute) << 20`; verified against 13 known-time lab samples, R-suite 2026-07-04 — e.g. `1207959552` → 18:00, `434110464` → 06:30, `15728640` → 00:15). Set/cleared via URL `when=<list>@<time>`; a bare `when=today` on update CLEARS it (R07). |
| `deadline` | packed int or NULL | Hard due date, independent of `startDate`. Same packing. |
| `deadlineSuppressionDate` | packed int | Suppresses deadline nagging after user dismissal. |
| `todayIndexReferenceDate` | packed int | The day a `todayIndex` value is relative to (Today re-sorts daily). |

**View derivation rules** (from research, to be encoded as tested SQL in `src/read/views.ts`):

| UI list | Predicate (open, untrashed unless noted) |
|---|---|
| Inbox | `start=0` — items keep tags/deadline/checklist and stay in Inbox until area/project/when assigned (validated "Inbox exit semantics") |
| Today | `(start IN (1,2) AND startDate <= <today>) OR (deadline <= <today> AND startDate IS NULL AND NOT suppressed)` — **a due deadline pulls an item into Today even from the Inbox**, unless a FUTURE startDate wins or the nag was dismissed (`deadlineSuppressionDate` stores the dismissed deadline; suppression requires `>= deadline`). ORDER: `startBucket ASC, COALESCE(todayIndexReferenceDate, startDate, deadline) DESC, todayIndex ASC, uuid ASC` — newest-ENTRY cohorts on top; the app never normalizes reference dates at launch (live library spans 18 months of them). UI-oracle research 2026-07-04, exact live reconciliation 393=393 + top-10 10/10 — docs/lab/today-order-research.md. This CORRECTS the earlier "deadline alone does not put an item in Today" badge inference: all 12 live absentees were nag-dismissed. **This Evening expires daily**: an item renders in the Evening section only while `startBucket=1 AND startDate == <today>` exactly; overdue evening items roll back into Today proper (live-verified 2026-07-02). `start=2` rows with past dates are pending promotion. **Sidebar badge**: red count = deadline <= today among members, gray = the rest (270/122 reconciliation 2026-07-02). |
| Upcoming | future `startDate` (grouped by day at render) |
| Anytime | **All active items** — `start=1` (dated-current or undated) plus pending-promotion rows; **Today members render with a ★** (live-verified via screenshot 2026-07-02: starred = also in Today, unstarred = unscheduled). Sorted by `index` |
| Someday | `start=2` |
| Logbook | `status IN (2,3)`, ordered by `stopDate` DESC |
| Trash | `trashed=1` (any status) |
| Project view | Composite: active children + headings + "later" (future-dated, repeating, someday) + logged + trashed — see `../design/architecture.md` `projectView` |

### Containment

| Column | Meaning |
|---|---|
| `area` | uuid → TMArea. Projects and standalone to-dos. |
| `project` | uuid → TMTask(type=1). **Invariant (verified on 171/171 rows): a to-do under a heading has `project = NULL`** — the heading is the sole parent; the project is reached via `heading → its project`. Flat project-child queries MUST be `project = ? OR heading IN (SELECT uuid FROM TMTask WHERE type=2 AND project = ?)`. |
| `heading` | uuid → TMTask(type=2). |
| `contact` | uuid → TMContact ("delegated to" — the hidden contacts feature). |
| `untrashedLeafActionsCount`, `openUntrashedLeafActionsCount` | Materialized child counts on projects (drive progress pies in UI). **v27:** back-filled from the `-1` sentinel to a computed `0` on `type = 0` rows, so every row now carries a real value; `-1` no longer means "uninitialised". |
| `checklistItemsCount`, `openChecklistItemsCount` | Materialized checklist counts on to-dos. **v27:** same back-fill on `type = 1` / `type = 2` (projects and headings hold no checklist → computed `0`). |

### Ordering

| Column | Meaning |
|---|---|
| `index` | Sparse sortable rank within the structural context (project/area/list). Moving one item rewrites only that item (validated). Collision tie-break is view-specific and deliberately unmodeled. **Scope is the immediate container** (lab U17, 2026-07-03): heading rows order among themselves and to-dos order within their heading, but comparing across scopes is meaningless — a headed child's `index` can be lower than its own heading's (observed −609 under a −409 heading), and flat items don't share a scale with headings. Sort per scope when mirroring the project view. |
| `todayIndex` | Sparse rank within Today/This Evening sections, relative to `todayIndexReferenceDate`. Today order = `(startBucket, todayIndex)` (validated against UI). Independent of `index`. |

### Repeating (`rt1_*`)

| Column | Meaning |
|---|---|
| `rt1_recurrenceRule` | BLOB (**XML plist**, decoded READ-ONLY by `src/model/recurrence.ts`) on **templates**. `IS NOT NULL` ⇒ this row is a repeating template (91 observed). Keys (91-rule corpus + instance cross-validation, 2026-07-04): `tp` 0=fixed/1=after-completion · `fu` 16=daily/256=weekly/8=monthly/4=yearly · `fa` interval · `ts` start offset in days vs. the event date (≤0; **spawned instance deadline = startDate − ts**, held on every live instance) · `of` offsets: `dy` 0-based day (−1=last of month), `mo` 0-based month, `wd` weekday (0=Sunday), `wdo` nth weekday (−1=last) · `ed` end (unix seconds; ~year-4001 sentinel = forever) · `rc` remaining count (0=unlimited) · `rrv` version (4) · `sr`/`ia` anchors. NEVER write this blob. Templates are invisible in normal list views. Template rows may carry a `deadline` column sentinel (4001-01-01 observed) — ignore it; only the rule-derived deadline is real. |
| `rt1_repeatingTemplate` | uuid on **instances** pointing at their template (1,936 observed). |
| `rt1_instanceCreation*`, `rt1_nextInstanceStartDate`, `rt1_afterCompletionReferenceDate` | Instance-generation bookkeeping. `rt1_nextInstanceStartDate` uses the packed-date encoding (lab-verified: decodes to the configured next occurrence). **v27:** the column is **template-scoped** — NULL on every non-template row, byte-identical on every template that had a value, and still maintained by the 3.23 app. Under ≤3.22 a freshly minted INSTANCE carried an uninitialised junk `69760` there; the migration clears it. Only the TEMPLATE's value ever drove generation. |
| `repeater`, `repeaterMigrationDate` | Newer repeater representation (BLOB) + migration marker. **Lab-verified (3.22.11): new repeat rules are authored into `rt1_recurrenceRule`; `repeater` stays NULL.** Templates live in `start=2` (why list views never show them); spawned instances materialize as `start=2 + startDate=<occurrence>` and get promoted to `start=1` by app maintenance (same pending-promotion mechanics observed on live data). |

**Hazard tie-in:** scheduling writes against rows with recurrence fields are vector-dependent (lab, 2026-07-03): URL `when=` **crashes Things** (T12/U12, reproduced deterministically); AppleScript `schedule` is **guarded** — clean error `Cannot schedule to-do (302)`, zero DB delta (A21). Guard `H-REPEAT-SCHEDULE` keys off `rt1_recurrenceRule`/`rt1_repeatingTemplate`/`repeater`; the URL path stays hard-blocked, the AppleScript path can surface the app's own error. Templates are invisible to AppleScript list reads but directly addressable by id (A12); the private `_private_experimental_ json` property exposes their recurrence config (A51).

### Misc

`notes` TEXT (Markdown-ish), `notesSync` INTEGER, `cachedTags` BLOB (denormalized tag cache — do not parse; use `TMTaskTag`), `experimental` BLOB (opaque; also on TMArea/TMTag/TMChecklistItem/TMSettings/TMSmartList), `leavesTombstone` INTEGER (the tombstone GATE — deleting a row writes a `TMTombstone` iff this is 1; set only on repeating-template lineage, never on ordinary items; TOMB1).

## Other core tables

**TMArea:** `uuid, title, visible, index, cachedTags, experimental`. No status/trash — **areas are deleted permanently** (matches AppleScript docs: area delete skips Trash).

**TMTag:** `uuid, title, shortcut, usedDate, parent, index`. Hierarchy via `parent` (self-ref). Tag assignment matching is case-insensitive at the app layer (T04). **`index` is the CANONICAL tag order** (ratified 2026-07-14): the user-draggable rank from the app's Tags window (INTEGER, often negative), and the GUI renders every multi-tag pill row in ascending `index`. Live oracle: `Replace CPAP mask & air filter` shows `#recurring #home #housekeeping` matching its tags' indexes, NOT alphabetical order — so tag rendering sorts by `index` (title tiebreak), never by title. **Caveat — child indexes interleave globally with top-level ones** (a parent observed at −3281 with children at −12063), so a flat `index` sort of a multi-tag row can place a child before its parent. No live item pairs a nested tag with another tag, so there is no GUI oracle for the interleaved case; flat ascending `index` is the ratified comparator (`fetchTagsForTasks`), while the `things tags` hierarchy LISTING orders depth-first (child follows parent) where DFS is unambiguous.

**TMTaskTag / TMAreaTag:** bare joins (`tasks`/`areas`, `tags`). Direct tags only — **inherited tags (from area/project) are computed by the app at filter time**, never materialized here (T18). `TMAreaTag` had 0 rows on the probed library despite area tags having been used historically — treat area-tag reads as needing lab verification before reliance.

**TMChecklistItem:** `uuid, userModificationDate, creationDate, title, status (0/2/3), stopDate, index, task, leavesTombstone, experimental`. Status domain matches tasks. Checklist state does not bubble to the parent (T20).

**TMSettings:** singleton — `logInterval`, `manualLogDate` (the LOG-MOVE BOUNDARY: completion ≠ logged — a closed item joins the Logbook only once the sweep passes `stopDate`; no per-row column records it. `logInterval` 1 = daily, verified live 2026-07-10; 0 = immediately, 2 = weekly, 3 = monthly assumed — probe-backlog §C. `manualLogDate` = last explicit "log now", max()ed into the boundary. Model: `src/read/log-boundary.ts`), `groupTodayByParent` (Today view grouping toggle), `uriSchemeAuthenticationToken`.

## Encodings

| Encoding | Applies to | Rule |
|---|---|---|
| Epoch REAL | `creationDate`, `userModificationDate`, `stopDate`, `lastReminderInteractionDate`, `usedDate`, `deletionDate`, `manualLogDate`, `repeaterMigrationDate` | Unix seconds (fractional). |
| Packed date int | `startDate`, `deadline`, `deadlineSuppressionDate`, `todayIndexReferenceDate`, `rt1_*StartDate/*ReferenceDate` | `y<<16 \| m<<12 \| d<<7`; low 7 bits observed 0. Decode: `y = v>>16`, `m = (v>>12)&0xF`, `d = (v>>7)&0x1F`. |
| Packed time int | `reminderTime` | **`hour<<26 \| minute<<20`** (i.e. `(hour*64 + minute) << 20`). Verified: R-suite (13 known-time samples, 2026-07-04) + independently re-derived 4/4 in the parked-probe campaign (2026-07-22, `when=@HH:MM` fixtures: 09:00→603979776, 14:30→970981376, 00:15→15728640, 18:07→1215299584). |
| Plist BLOBs | `Meta.value`, `rt1_recurrenceRule`, `repeater`, `definition`, `experimental`, `cachedTags` | Parse only `Meta.databaseVersion` (extract the `<integer>`); treat the rest as opaque. |

## Open questions (lab probe backlog)

1. ~~`reminderTime` bit layout~~ **ANSWERED — `reminderTime = hour<<26 | minute<<20`** (R-suite 2026-07-04, 13 samples; re-derived 4/4 in the parked-probe campaign 2026-07-22 via `when=@HH:MM` fixtures — see the Scheduling table `reminderTime` row + the Encodings table). No sign/overflow surprises across 00:00–23:59.
2. ~~`repeater` BLOB vs `rt1_recurrenceRule`~~ **ANSWERED (lab, 2026-07-03): 3.22.11 authors `rt1_recurrenceRule`; `repeater` stays NULL.**
3. Heading `status` semantics when a heading is archived in UI — **PARTIALLY ANSWERED (2026-07-17, aggregate-only production shape survey for the bench world profile): non-open headings DO occur in the wild (two `type=2` rows with `status=3` observed), so archived/completed headings take completed status.** Remaining: whether UI "archive heading" is what writes `status=3` (vs project completion cascading) — lab probe still wanted.
4. ~~`TMAreaTag` population conditions~~ **PARTIALLY ANSWERED (lab): AppleScript `set tag names of area` populates `TMAreaTag` immediately. Why Mike's production table is empty despite historical area-tag use remains a curiosity.**
5. ~~Tombstone lifecycle: when exactly `leavesTombstone` rows produce `TMTombstone` entries (delete-to-trash vs empty-trash vs sync).~~ **ANSWERED — TOMB1 (2026-07-26, [../lab/tomb1-results.md](../lab/tomb1-results.md)):** a `TMTombstone` row is written iff the deleted row carried **`leavesTombstone=1`**, and the delete *path* is irrelevant (trash, empty-trash, area delete, or an applied remote delete all behave the same for a given row). `leavesTombstone=1` is set ONLY on repeating-template lineage (template + spawned instances) — NEVER on ordinary to-dos/projects/checklist items, and attaching a Cloud account does not flip it. So ordinary deletions leave NO tombstone (proven on the local deleter with sync off AND on, and on a remote receiver that applies the delete — the row vanishes tombstone-lessly; the deletion still propagates via the Syncrony change-log). `deletionDate` = the deleter's wall-clock at delete time (trustworthy epoch), but exists only for the narrow repeating-lineage population. **`TMTombstone` is not a general deletion log** — do not build `changes --since` deletion tracking on it.
6. Logbook timing: `logInterval`/`manualLogDate` interaction with when completed items visually move to Logbook (research "Logbook timing" ancillary finding).
