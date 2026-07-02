# Things Database Atlas — schema v26

The living map of Things 3's SQLite database (`Meta.databaseVersion` = 26, observed with Things 3.22.11 on 2026-07-02), annotated with how each field drives what the user sees in the app. Structure and enum values here were probed live (read-only) against a real, long-lived Things library; behavioral semantics come from the validated research in [`../research/`](../research/) (especially `validation-notes-step3.md`).

**Location:** `~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-<suffix>/Things Database.thingsdatabase/main.sqlite` (WAL mode; `-shm`/`-wal` sidecars present whenever Things has run). The `<suffix>` varies per account. Direct-download and MAS builds share this container (bundle-level parity verified; see `../../vendor/manifest.json`).

**Capture query** (regenerates [`test/fixtures/schema-v26.sql`](../../test/fixtures/schema-v26.sql)):
```sh
sqlite3 -readonly "<main.sqlite>" \
  "SELECT sql || ';' FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
   ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name;"
```

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
| `TMTombstone` | Sync deletion records (`deletedObjectUUID`, `deletionDate`) — how deletions propagate; `leavesTombstone` on TMTask/TMChecklistItem opts records in | Read-informative (delete forensics) |
| `TMSmartList` | Saved filters/smart lists (`definition` BLOB) | Not yet |
| `TMContact` | Contacts (AppleScript `contact` class / `add contact named`) | Not yet |
| `TMMetaItem`, `BSSyncronyMetadata` | Sync-engine internals (opaque BLOBs) | Never (do not touch) |
| `ThingsTouch_ExtensionCommandStore_{Commands,Meta}` | Command queue for app extensions (widgets/share/intents); observed empty (drained). **Not a sanctioned write vector** — reverse-engineering it would be direct-DB-write by another name | Never |

Indexes: `index_TMTask_{area,project,heading,repeatingTemplate,stopDate}`, `index_TMTaskTag_tasks`, `index_TMAreaTag_areas`, `index_TMChecklistItem_task`, `index_TMTombstone_deletedObjectUUID`.

## TMTask — the everything table

One row per to-do, project, or heading. Cultured Code's own DDL comments record the rename history (`heading` ← `actionGroup`, `deadline` ← `dueDate`, `contact` ← `delegate`, `rt1_*` ← unprefixed).

### Discriminators & lifecycle

| Column | Domain (verified live) | Meaning / UI effect |
|---|---|---|
| `type` | `0` to-do · `1` project · `2` heading | What kind of row this is. Headings observed only with `status=0`. |
| `status` | `0` open · `2` canceled · `3` completed | Canceled and completed both land in **Logbook** (with `stopDate`). There is no status `1`. |
| `stopDate` | epoch REAL or NULL | When completed/canceled. Logbook ordering key (indexed). Logbook *grouping* into days happens at render time. |
| `trashed` | `0` / `1` | **Trash is a flag, not a list.** Trashed rows keep their `project`/`area` links. |
| `creationDate`, `userModificationDate` | epoch REAL | `userModificationDate` is the verification engine's cheap "did anything happen" tripwire. |

### Scheduling — what puts a task in which list

| Column | Domain | Meaning |
|---|---|---|
| `start` | `0` Inbox · `1` Anytime/Today · `2` Someday | Coarse placement bucket. |
| `startDate` | packed int or NULL | The "When" date. **Packing: `y<<16 \| m<<12 \| d<<7`** (verified: `132803712` → 2026-06-25). |
| `startBucket` | `0` Today · `1` This Evening | Sub-placement within Today. things.py cannot see this; we expose it as `todaySection`. |
| `reminderTime` | packed int or NULL | Time-of-day for the reminder. Bit layout TBD — samples (557842432, 589299712, …) suggest hour/minute in high bits. **Phase-1 codec TODO.** |
| `deadline` | packed int or NULL | Hard due date, independent of `startDate`. Same packing. |
| `deadlineSuppressionDate` | packed int | Suppresses deadline nagging after user dismissal. |
| `todayIndexReferenceDate` | packed int | The day a `todayIndex` value is relative to (Today re-sorts daily). |

**View derivation rules** (from research, to be encoded as tested SQL in `src/read/views.ts`):

| UI list | Predicate (open, untrashed unless noted) |
|---|---|
| Inbox | `start=0` — items keep tags/deadline/checklist and stay in Inbox until area/project/when assigned (validated "Inbox exit semantics") |
| Today | `start IN (1,2) AND startDate <= <today>` — sorted by `todayIndex` ASC. **This Evening expires daily**: an item renders in the Evening section only while `startBucket=1 AND startDate == <today>` exactly; overdue evening items roll back into Today proper (live-verified 2026-07-02 against a UI screenshot — six 2025-01-13 `startBucket=1` stragglers rendered in Today proper, Evening empty). `start=2` rows with past dates are pending promotion; Things promoted them to `start=1` during observation. **Sidebar badge**: red count = Today items with `deadline <= today`, gray = the rest (exact 270/122 reconciliation). **Deadline alone does NOT put an item in Today** — proven by badge-sum reconciliation (12 open deadline-overdue-but-unscheduled items were excluded from the badge total). |
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
| `untrashedLeafActionsCount`, `openUntrashedLeafActionsCount` | Materialized child counts on projects (drive progress pies in UI). |
| `checklistItemsCount`, `openChecklistItemsCount` | Materialized checklist counts on to-dos. |

### Ordering

| Column | Meaning |
|---|---|
| `index` | Sparse sortable rank within the structural context (project/area/list). Moving one item rewrites only that item (validated). Collision tie-break is view-specific and deliberately unmodeled. |
| `todayIndex` | Sparse rank within Today/This Evening sections, relative to `todayIndexReferenceDate`. Today order = `(startBucket, todayIndex)` (validated against UI). Independent of `index`. |

### Repeating (`rt1_*`)

| Column | Meaning |
|---|---|
| `rt1_recurrenceRule` | BLOB (plist) on **templates**. `IS NOT NULL` ⇒ this row is a repeating template (91 observed). Templates are invisible in normal list views. |
| `rt1_repeatingTemplate` | uuid on **instances** pointing at their template (1,936 observed). |
| `rt1_instanceCreation*`, `rt1_nextInstanceStartDate`, `rt1_afterCompletionReferenceDate` | Instance-generation bookkeeping. |
| `repeater`, `repeaterMigrationDate` | Newer repeater representation (BLOB) + migration marker. Relationship to `rt1_*` is a lab probe topic. |

**Hazard tie-in:** scheduling writes (`when`) against rows with recurrence fields crash Things (T12). Guard `H-REPEAT-SCHEDULE` keys off `rt1_recurrenceRule`/`rt1_repeatingTemplate`/`repeater`.

### Misc

`notes` TEXT (Markdown-ish), `notesSync` INTEGER, `cachedTags` BLOB (denormalized tag cache — do not parse; use `TMTaskTag`), `experimental` BLOB (opaque; also on TMArea/TMTag/TMChecklistItem/TMSettings/TMSmartList), `leavesTombstone` INTEGER (sync deletion opt-in).

## Other core tables

**TMArea:** `uuid, title, visible, index, cachedTags, experimental`. No status/trash — **areas are deleted permanently** (matches AppleScript docs: area delete skips Trash).

**TMTag:** `uuid, title, shortcut, usedDate, parent, index`. Hierarchy via `parent` (self-ref). Tag assignment matching is case-insensitive at the app layer (T04).

**TMTaskTag / TMAreaTag:** bare joins (`tasks`/`areas`, `tags`). Direct tags only — **inherited tags (from area/project) are computed by the app at filter time**, never materialized here (T18). `TMAreaTag` had 0 rows on the probed library despite area tags having been used historically — treat area-tag reads as needing lab verification before reliance.

**TMChecklistItem:** `uuid, userModificationDate, creationDate, title, status (0/2/3), stopDate, index, task, leavesTombstone, experimental`. Status domain matches tasks. Checklist state does not bubble to the parent (T20).

**TMSettings:** singleton — `logInterval`, `manualLogDate` (Logbook timing behavior), `groupTodayByParent` (Today view grouping toggle), `uriSchemeAuthenticationToken`.

## Encodings

| Encoding | Applies to | Rule |
|---|---|---|
| Epoch REAL | `creationDate`, `userModificationDate`, `stopDate`, `lastReminderInteractionDate`, `usedDate`, `deletionDate`, `manualLogDate`, `repeaterMigrationDate` | Unix seconds (fractional). |
| Packed date int | `startDate`, `deadline`, `deadlineSuppressionDate`, `todayIndexReferenceDate`, `rt1_*StartDate/*ReferenceDate` | `y<<16 \| m<<12 \| d<<7`; low 7 bits observed 0. Decode: `y = v>>16`, `m = (v>>12)&0xF`, `d = (v>>7)&0x1F`. |
| Packed time int | `reminderTime` | TBD (Phase-1 codec test; hour/minute in high bits). |
| Plist BLOBs | `Meta.value`, `rt1_recurrenceRule`, `repeater`, `definition`, `experimental`, `cachedTags` | Parse only `Meta.databaseVersion` (extract the `<integer>`); treat the rest as opaque. |

## Open questions (lab probe backlog)

1. `reminderTime` bit layout (safe to derive from fixtures: set reminders at known times in the lab VM, read back).
2. `repeater` BLOB vs `rt1_recurrenceRule` — which does 3.22.x actually author? (`repeaterMigrationDate` suggests a migration.)
3. Heading `status` semantics when a heading is archived in UI (no non-open headings existed in the probed library).
4. `TMAreaTag` population conditions (0 rows despite historical area-tag use).
5. Tombstone lifecycle: when exactly `leavesTombstone` rows produce `TMTombstone` entries (delete-to-trash vs empty-trash vs sync).
6. Logbook timing: `logInterval`/`manualLogDate` interaction with when completed items visually move to Logbook (research "Logbook timing" ancillary finding).
