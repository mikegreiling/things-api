# The one-vocabulary layer-collapse audit

Status: **EXECUTED (Batches 1–3), 2026-08-05 (Batches 1–2 PR #423; Batch 3 PR #<PR>).** Batch 1 (R-1 day-block `date`→`when` in `shape.ts` + R-1b `IsoDateGroup<T>.date`→`when`) and Batch 2 (the `derived` substrate bag per Option B + the wire-key-inventory lock test) SHIPPED. `src/read/shape.ts` now performs no vocabulary translation, and the seven entity substrate fields live in the nested `TaskCommon.derived` bag (`start`/`logged`/`trashed`/`todaySection`/`today`/`evening`/`reminderLive`); `startDate` stays flat; `entityStage`/`entityWhen`/`entityProvisional` are the exported entity-level derivation helpers. `todaySection` was MOVED into `derived` (not deleted): the write-verify schedule delta still depends on it, so the audit's deletion caveat did not clear. **Batch 3 (R-3) SHIPPED, MAINTAINER-APPROVED 2026-08-05:** the `set-dates` op params `creationDate`/`completionDate` were renamed to `createdAt`/`completedAt`, unifying the write input surface on ONE spelling per concept (the add-path already used `createdAt`/`completedAt`). CLI/MCP wire unchanged (they were already `--created-at`/`--completed-at` and `created_at`/`completed_at`); reads keep `created`/`stopped` (distinct concept-role); the DB column `creationDate` is untouched. This document remains the classification of record for [docs/up-next.md](../up-next.md) §7 item 1.

**The maintainer's principle** (the ruling this audit serves): *one name per concept, normalized at the DB boundary; downstream layers may only DROP, GROUP, or PROMOTE — never RENAME.* The success end-state: `src/read/shape.ts` selects / drops / promotes / presence-keys attributes, but performs no vocabulary TRANSLATION (no `internalName → wireName` renaming at the emit boundary).

**The explicit caveat carried from §7.1** (Fable's ruling): the goal is vocabulary UNIFICATION, not layer DELETION. The TTY-projection layer (`src/cli/render.ts`) and the emission tiers (compact/full, ref round-trip promotion, JSON serialization, presence-keying) earn their keep — they are legitimately emission-time and stay.

## The layer topology (what maps to what)

Four layers, DB → consumer:

1. **DB row** — `TaskRow` / `ChecklistRow` (`src/model/mappers.ts`). The raw SQLite columns: packed-date ints, integer enums, `startBucket`, `index`, `todayIndex`, the `rt1_*` recurrence columns, `deadlineSuppressionDate`, `effectiveArea`. This interface is a **cleanly-segregated substrate layer** — it is a distinct type, never exported, never a consumer surface.
2. **Internal entity** — `Todo` / `Project` / `Heading` / `Area` (`src/model/entities.ts`), produced by the mappers. This is where DB columns are decoded and **normalized to the consumer vocabulary at the DB boundary** (the doctrine's normalization point): DB `creationDate → created`, `userModificationDate → modified`, `stopDate → stopped`, packed `startDate → IsoDate startDate`, integer enums → string unions. The entity is ALSO the shape the **programmatic TS API** (`src/client.ts`, re-exported via `src/index.ts`) hands back — so under ALPHA-CONTRACT it is itself a consumer surface, and the only one that sees the un-shaped vocabulary.
3. **Wire shaping** — `src/read/shape.ts` (`shapeReadPayload`), applied ONLY at the two thin consumer boundaries (`src/cli/read-driver.ts` and `src/mcp/server.ts`), never in `client.ts`. This is where the R1–R13 doctrine ([read-shape-doctrine-v2.md](read-shape-doctrine-v2.md)) derives `stage`/`when`/`provisional`, groups counts into `checklist`/`todos`, presence-keys `repeating`/`instanceOf`/`archived`, flattens refs to bare titles + `*Uuid` siblings, and applies the compact/full tier drops.
4. **TTY render** — `src/cli/render.ts` consumes the un-shaped entities (NOT the wire) for the human view. Legitimately separate (surface-copy + width-fitting); out of scope for unification per the §7.1 caveat.

**The load-bearing finding up front:** the R1–R13 read-shape doctrine has ALREADY unified the overwhelming majority of the vocabulary. The DB→entity boundary normalization is correct and complete (no DB column name leaks past the mapper). The entity→wire divergences are almost entirely legitimate emission-time derivations (`stage`/`when`/`provisional`/`hasNotes`/`checklist`/`todos`/`repeating`/`instanceOf`/`archived`/ref-flatten) or already SAME-NAME. **The genuine rename surface is thin.** The real structural win §7.1 is reaching for is not a pile of renames — it is (a) removing the ONE surviving translation in `shape.ts` (the day-block `date`→`when`), and (b) making the entity-level internal substrate fields VISIBLY DISTINCT from the consumer vocabulary they currently sit intermixed with. The audit's value is that this classification is TRUE, not that the rename count is high.

## 1. The audit table

Every consumer-facing key, its internal representation(s), and its classification. Legend: **SAME** = already unified (consumer name == internal name, normalized at the DB boundary); **RENAME** = internal name differs from the ratified consumer name with no semantic difference (migrate inward); **COMPUTED** = legitimately emission-time (derived / grouped / promoted / presence-keyed — allowed to stay); **SUBSTRATE** = write/derivation machinery that stays internal (flagged segregated vs intermixed).

### 1a. Read wire — to-do / project item keys

| Wire key | Internal representation | Class | Notes |
|---|---|---|---|
| `uuid` | `entity.uuid` (DB `uuid`) | SAME | |
| `title` | `entity.title` (DB `title`) | SAME | |
| `notes` (full) / `hasNotes` (compact) | `entity.notes` (DB `notes`) | SAME + COMPUTED | `notes` SAME on full; compact drops it for the presence-keyed `hasNotes` (token-economy, R7). |
| `status` | `entity.status` (DB `status` int via `TASK_STATUS_FROM_DB`) | SAME | Enum decoded at mapper; compact omits when `open` (absence=default, R7). |
| `stage` | derived from `entity.start` + `logged` + `trashed` via `deriveStage` | COMPUTED | Response-clock-dependent (needs today + logbook boundary); cannot be pre-baked on the entity. NOT a rename of any single field — it replaces three. |
| `when` | derived from `startDate` + `today`/`evening` markers + `repeating.nextOccurrence` via `deriveWhen` | COMPUTED | R12. Semantically distinct from raw `startDate` (position vs stored value) — the honesty case: this is NOT a `startDate` rename. |
| `provisional` | derived from the same Today markers + `start`/`startDate` via `whenIsProvisional` | COMPUTED | R13/BANNER1; presence-keyed, never dropped. |
| `startDate` (full/detail only) | `entity.startDate` (DB packed `startDate` → `IsoDate`) | SAME | The raw substrate behind `when`, kept on full tier under its own name. Compact drops it. |
| `deadline` | `entity.deadline` (DB packed `deadline`; nulled for templates) | SAME | Template `deadline` sentinel handled at mapper → `repeating.deadlined`. |
| `reminder` | `entity.reminder` (DB `reminderTime` → `ReminderTime`), gated by `reminderLive` | SAME + COMPUTED | Name SAME; emit gated by the internal `reminderLive` marker (§9n stale-bell rule). |
| `area` + `areaUuid` | `entity.area: Ref {uuid,title}` (DB `effectiveArea` → resolved Ref) | COMPUTED | Ref flattened to bare title; `areaUuid` sibling added iff the title does not round-trip (live-DB oracle). Promote, not rename. |
| `project` + `projectUuid` | `entity.project: Ref` **merged with** `entity.headingProject` | COMPUTED (promote) | `headingProject` is PROMOTED into `project` when `project` is null (a headed to-do's owning project). Allowed group/promote — not a rename. |
| `projectIsTemplate` | `entity.project.isRepeatingTemplate?: true` (on the Ref) | COMPUTED (promote) | Re-emitted as a flat row sibling because the ref flattens to a string; presence-keyed. |
| `heading` + `headingUuid` | `entity.heading: Ref` | COMPUTED | Ref flatten; compact-dropped outside project views (R7). |
| `tags` / `inheritedTags` | `entity.tags: TagRef[] {title}` / `inheritedTags` | COMPUTED (drop wrapper) | Flattened to `string[]` of names (tag uuids were never on the wire). Key name unchanged; the `{title}` wrapper is dropped. |
| `repeating` `{paused?,deadlined?,rule?,latestInstance?}` | `entity.repeating: RepeatingInfo` (`isTemplate`/`isInstance`/`templateUuid`/`nextOccurrence`/…) | COMPUTED (R11 reshape) | Presence MEANS template; `isTemplate`/`isInstance` discriminators dropped; `nextOccurrence`→`when` (R12). |
| `instanceOf` | `entity.repeating.templateUuid` (when `isInstance`) | COMPUTED (promote+presence-key) | Lifted out of `repeating` and presence-keyed. Contains a rename (`templateUuid`→`instanceOf`) folded into the R11 reshape — classified COMPUTED, not a pure rename (the reshape is load-bearing). |
| `checklist` `{open,total,items?}` | `checklistItemsCount` + `openChecklistItemsCount` (+ `checklist[]` on detail) | COMPUTED (group) | R9 count-grouping. |
| `todos` `{open,total}` | `untrashedLeafActionsCount` + `openUntrashedLeafActionsCount` | COMPUTED (group) | R9 count-grouping. |
| `created` / `modified` (full only) | `entity.created` / `entity.modified` (DB `creationDate` / `userModificationDate`) | SAME | DB→entity normalization is the doctrine working correctly. Compact drops both. |
| `stopped` | `entity.stopped` (DB `stopDate` → `Date`) | SAME | **The suspected `stopDate`-vs-`stopped` divergence does NOT exist as a rename** — the DB column is normalized to `stopped` at the mapper, and `stopped` is the wire name. Already unified. (Honesty check per the brief: this is a resolved case, not a candidate.) |
| `type` | `entity.type` (DB `type` int via `TASK_TYPE_FROM_DB`) | SAME | Absent `type` = to-do (presence convention, R7). |

### 1b. Read wire — grouping / container structures

| Wire key | Internal representation | Class | Notes |
|---|---|---|---|
| day-block `when` (project/area `upcoming[]`) | `WireDateGroup.date` (built in `shape.ts` `rebucketChildren`) → `{when: g.date}` in `shapeContainerChildren` / `shapeAreaChildren` | **RENAME** | **The one genuine translation surviving in `shape.ts`.** The day-block key IS an ISO date and the wire deliberately calls it `when` (it doubles as the `--in <when>` reorder token). `rebucketChildren` internally names it `date`, then the two shapers rename `date`→`when` at emission. See migration note R-1. |
| day-block `when` (global `upcoming` sections) | built directly as `{when, items}` in `shapeUpcomingView` | SAME | Already uses `when` — no `date` intermediary. Confirms `when` is the ratified name. |
| section `area` (anytime/someday) | `SidebarSection.area: Ref \| null` | COMPUTED | Ancestry-drop context; area folded to name via `shapeArea`. |
| `children` buckets `{anytime,upcoming,someday,logbook}` | `bodyChildren` / `headingContainers[].children` (flat `Todo[]`), re-bucketed by derived stage | COMPUTED (group) | R1–R6 stage bucketing. The wire path does NOT consume the render-internal `IsoDateGroup` — it re-buckets from flat lists. |
| heading node `archived` | `Heading.status` (`completed`) + `Heading.stopped` (DB `stopDate`) | COMPUTED (promote+presence-key) | Fuses the archive boolean (status) + timestamp (stopped) into one presence-keyed field. Not a rename — a two-field collapse. |
| `IsoDateGroup.date` (render-internal `scheduled` groups) | `entity.IsoDateGroup<T>.date` | **RENAME** (consistency) | Publicly re-exported (`src/index.ts`) but consumed only by `render.ts` + the project/area view builders — never translated to the wire (the wire re-buckets from flat lists). Renaming to `when` is a consistency nicety, not required for the `shape.ts` criterion. See R-1b. |

### 1c. MCP tool params / results

| Surface | Internal representation | Class | Notes |
|---|---|---|---|
| view-tool results (`read_view`, `get_area`, `search`, `changes`, detail) | run through the SAME `shapeReadPayload` | — | MCP inherits the CLI wire vocabulary verbatim (`src/mcp/server.ts` calls `shapeReadPayload` per kind). No independent MCP read vocabulary to unify. |
| MCP arg `tz` / `full` / `area` / `tag` / `scope` | `THINGS_TZ` / tier / `--area` / `--tag` / container scope | SAME | Match the CLI flag + wire names. |
| MCP mutation content block | `mutationWireData` (strips the internal `kind` discriminator) | COMPUTED (drop) | Phase-2 framing alignment (2026-07-31); already unified with the CLI. |
| MCP `op_id` | audit `opId` | SAME | snake_case is the MCP arg convention; same concept, same word. |

### 1d. CLI flags that name data fields

| CLI flag | Internal / wire representation | Class | Notes |
|---|---|---|---|
| `--area` / `--tag` (read filters) | wire `area` / `tags` | SAME | |
| `--when` (write scheduling input) | `WhenValue` → app When control | SAME-name, DISTINCT concept | The write `--when` is the INPUT control (accepts `someday`); the read `when` is the DERIVED time-position (no `someday`). Documented read/write asymmetry (contract.md glossary). They share one word for two related-but-distinct concepts — ratified, NOT a rename to resolve. |
| `--deadline` / `--reminder` / `--notes` / `--tag` (write) | op params `deadline` / `reminder` / `notes` / `tags` | SAME | |
| `--created-at` / `--completed-at` (add + set-dates) | `TodoAddParams.createdAt`/`completedAt` AND `SetDatesParams.createdAt`/`completedAt` | RESOLVED (Batch 3) | Formerly spelled two ways (`createdAt`/`completedAt` on add vs `creationDate`/`completionDate` on set-dates); unified to `createdAt`/`completedAt` throughout (R-3, 2026-08-05). Reads keep `created`/`stopped` (distinct concept-role). |

### 1e. Write-side param names (operations.ts) vs entity/wire vocabulary

| Write param | Concept | Read/entity name | Class | Notes |
|---|---|---|---|---|
| `title` / `notes` / `deadline` / `reminder` / `tags` / `project` / `area` / `heading` | same fields | `title`/`notes`/`deadline`/`reminder`/`tags`/`project`/`area`/`heading` | SAME | Write inputs already share the consumer vocabulary. |
| `when` (`WhenValue`) | scheduling input | read `when` (derived) | SAME-name, DISTINCT concept | See §1d. |
| `createdAt` (`TodoAddParams`/`ProjectAddParams`/`SetDatesParams`) | creation timestamp | read `created`; DB `creationDate` | RESOLVED (Batch 3) | Unified across add + set-dates (R-3, 2026-08-05). |
| `completedAt` (add + set-dates) | completion timestamp | read `stopped`; DB `stopDate` | RESOLVED (Batch 3) | Unified across add + set-dates (R-3, 2026-08-05). |

### 1f. Entity-level SUBSTRATE (internal, stripped at emission) — segregation flag

These live on `TaskCommon` / subtypes, INTERMIXED with the consumer-facing fields above, and are deleted by `shape.ts` (or feed a derivation and are then deleted). None is on the wire.

| Entity field | Role | Segregated today? | Notes |
|---|---|---|---|
| `start: StartState` | raw lifecycle; feeds `stage`/`when` | **INTERMIXED** | Also handed to the programmatic-API consumer. Cannot be renamed to `stage` (raw vs clock-derived). |
| `logged: boolean` | raw lifecycle (refined by `markLogged`); feeds `stage` | **INTERMIXED** | |
| `trashed: boolean` | raw lifecycle; feeds `stage` | **INTERMIXED** | |
| `todaySection: TodaySection \| null` | R10.1-retired; feeds render (evening styling) + write-verify delta | **INTERMIXED** | Redundant with the `evening` marker + raw `startBucket` — a candidate for outright DELETION (not just segregation). |
| `today?: true` | derived marker; feeds `when`/`stage`/`provisional` | **INTERMIXED** | Presence-keyed; looks like a wire field, is not. |
| `evening?: true` | derived marker; feeds `when` | **INTERMIXED** | |
| `reminderLive?: true` | derived marker; gates `reminder` emit + render bell | **INTERMIXED** | |

| DB-row substrate (`TaskRow`) | Role | Segregated today? |
|---|---|---|
| `index`, `todayIndex`, `startBucket` | write/read ordering keys | **SEGREGATED** (TaskRow only; never on the entity) |
| raw `status`/`start`/`startDate`/`deadline` ints, `deadlineSuppressionDate`, `rt1_*`, `effectiveArea`, `repeater` | DB substrate | **SEGREGATED** (TaskRow only) |

**Substrate verdict:** the DB-row substrate the brief names (`index`, `todayIndex`, `startBucket`, raw enums, raw `startDate`) is ALREADY cleanly segregated into `TaskRow` — a distinct, non-exported interface. The segregation gap is at the ENTITY level: seven internal fields (`start`, `logged`, `trashed`, `todaySection`, `today`, `evening`, `reminderLive`) sit on `TaskCommon` intermixed with consumer vocabulary, distinguishable only by JSDoc and by `shape.ts`'s explicit per-field delete list. That is the substrate-segregation target (§3).

## 2. Per-RENAME migration notes

### R-1 — `shape.ts` day-block `date` → `when` (the one true translation) — MECHANICAL

- **What:** in `rebucketChildren`, name the built day-group key `when` instead of `date` (change `WireDateGroup` `{date}` → `{when}`, and the local `datedByKey` block builder). Then `shapeContainerChildren` and `shapeAreaChildren` pass the group through unchanged instead of `map((g) => ({ when: g.date, items: g.items }))`. The `when === date` drop logic inside `rebucketChildren` (already comparing the shaped row's `when` to the group date) is unaffected.
- **Blast radius:** `src/read/shape.ts` ONLY (`rebucketChildren`, `WireDateGroup`, `shapeContainerChildren`, `shapeAreaChildren`, the `flattenGroups` doc comment). Zero external files. Wire output is BYTE-IDENTICAL (the emitted key was already `when`) — this is a pure internal-name cleanup that removes the translation.
- **Risk:** VERY LOW. No wire change, no test-fixture change expected (the emitted JSON is unchanged). The unit tests in `test/unit/` that assert shaped output already expect `when`.
- **Rename or semantic?** MECHANICAL. Same concept (the ISO date a day-block groups under), same emitted name; only the `shape.ts`-internal intermediate is renamed.

### R-1b — public `IsoDateGroup<T>.date` → `when` (consistency) — MECHANICAL, wider

- **What:** rename the field on the exported `IsoDateGroup<T>` (`src/model/entities.ts`) so the render-internal `scheduled` day-groups speak the same word.
- **Blast radius:** `entities.ts` (definition + `src/index.ts` re-export = a programmatic-API break, acceptable pre-1.0), `src/read/project-view.ts` (`groupByDate`, `scheduled`, `ProjectHeadingGroup.scheduled`), `src/read/area-view.ts` (`scheduled` builder), `src/cli/render.ts` (consumers of `scheduled` groups), and any test reading `.date` off a `scheduled` group.
- **Risk:** LOW-MEDIUM — mechanical but touches render + two view builders + tests. NOT required for the `shape.ts`-no-translation criterion (this structure never reaches the wire; the wire re-buckets from flat `Todo[]`). Purely a "one name per concept" consistency win.
- **Trade-off:** couples a generically-named helper (`IsoDateGroup`) to the Things time-axis word `when`. Acceptable because `IsoDateGroup` is used ONLY for scheduled/upcoming day-groups (all time-axis). Optional; can be deferred without blocking R-1.

### R-3 — write timestamp param vocabulary (`createdAt`/`completedAt` vs `creationDate`/`completionDate`) — EXECUTED 2026-08-05 (Batch 3)

- **What:** the "creation timestamp" concept is spelled `createdAt` (add), `creationDate` (set-dates), `created` (read wire), `creationDate` (DB). "Completion timestamp": `completedAt` (add), `completionDate` (set-dates), `stopped` (read wire), `stopDate` (DB). The two WRITE spellings for the SAME concept (`createdAt` vs `creationDate`) are a one-name-per-concept violation on the input surface.
- **This is NOT the same kind of debt as §7.1's core.** §7.1 targets the INTERNAL projection layers (entity → wire). R-3 is a consumer-vs-consumer inconsistency on the write input surface, with no internal-vs-consumer divergence to collapse (both compile to the same AppleScript / `things:///json` writes). It is recorded here for completeness and because the brief asked the write params be traced — but it is a SEPARATE CLI-vocabulary decision, not a `shape.ts` cleanup.
- **Recommendation (TAKEN):** pick ONE consumer spelling per concept. `createdAt` / `completedAt` (instant-style, matches the ISO-datetime values they accept and reads naturally as `--created-at`) was the pick; `SetDatesParams` was aligned to it. Maintainer-approved 2026-08-05.
- **What shipped:** `SetDatesParams.creationDate`→`createdAt`, `completionDate`→`completedAt` throughout the write surface — the op-param type (`operations.ts`), the compile spec + guard message (`commands.ts` `setDatesSpec`), the `H-BACKDATE-OPEN` guard's `params["completedAt"]` presence check (`guards.ts`), the resolution orchestrators' `setDatesLeg` + its callers (`resolution-timestamps.ts`), and the undo replay patch keys (`undo.ts`). NOT touched: the CLI flags (`--created-at`/`--completed-at`) and the client resolution surface (`ResolutionDates.createdAt`/`completedAt`) — already this spelling; the MCP params (`created_at`/`completed_at`) — already this spelling and mapping to `createdAt`/`completedAt`, so the MCP wire is byte-stable; the DB column `creationDate` and the delta assertion field names (`stoppedDate`/`createdDate`) — different layers; the AppleScript app-property names (`set creation date`/`set completion date`).
- **Audit-record implication (ALPHA):** the op params surface in audit records only under `requested`. `set-dates` undo reconstructs the inverse from the captured pre-state DELTA fields (`stoppedDate`/`createdDate`), NOT from `requested`, so pre-rename `set-dates` records stay fully undoable — no readers/shims added.
- **Risk:** LOW mechanically (rename params + tests). Wire-stable on CLI + MCP; a programmatic-API-only op-param break (ALPHA — no compat machinery).

### Non-renames confirmed by the audit (honesty rules)

- **`stopDate` vs `stopped`:** NOT a rename — already normalized at the mapper; `stopped` is both the entity and wire name. Resolved.
- **`startDate` vs `when`:** NOT a rename — `when` is a CLOCK-DERIVED position (R12), `startDate` is the stored substrate; different facts, both correctly named. Marking `startDate`→`when` a rename would be false.
- **`status` (int) vs `stage`:** NOT a rename — `stage` is derived from `start`/`logged`/`trashed` (three fields), not from `status`; `status` stays `status`. Different axes.
- **`todaySection` vs `evening`:** NOT a live rename — `todaySection` is already RETIRED from the wire (R10.1); it survives only as internal substrate. It is a SEGREGATION (and possibly DELETION) target, not a rename.
- **`start`/`logged`/`trashed`:** NOT renames — they are the raw substrate the wire replaces with the clock-derived `stage`/`when`; they cannot be pre-baked as `stage`/`when` without a response clock. SUBSTRATE.
- **read `when` vs write `--when`:** NOT a rename to resolve — a ratified, documented shared name for two related concepts (derived position vs input control).

## 3. Proposed batches

Three PRs, ordered. Batch 1 is the direct success-criterion work; Batch 2 is the structural segregation; Batch 3 is the adjacent write-vocab decision (optional / deferrable).

### Batch 1 — remove the surviving `shape.ts` translation (tiny, mechanical)

- R-1 (`shape.ts` day-block `date`→`when`). Optionally R-1b (public `IsoDateGroup.date`→`when`) in the same PR or a follow-up.
- After this PR, `shape.ts` performs NO vocabulary translation on the day-block key — the last `internalName → wireName` rename in the file is gone.
- Wire output unchanged (R-1) → near-zero regression risk. Do R-1 first even if R-1b is deferred.

### Batch 2 — entity substrate segregation + the leak-lock test (the structural win)

- Introduce a nested, clearly-named internal bag on `TaskCommon` holding the emission/render-only fields, and collapse `shape.ts`'s per-field delete list to a single drop (see the recommendation below).
- Add the enforcement test (§4) so the boundary is a lock, not a discipline.
- This is the larger PR (churns the mappers, `stage.ts` derivation inputs, `shape.ts` reads, `render.ts`, and the write-verify schedule delta) but it is mechanical and one-time (ALPHA-CONTRACT permits the entity-shape break).
- Consider folding the `todaySection` DELETION into this PR (it is redundant with the `evening` marker + raw `startBucket`; verify the write-verify delta can read `evening` + `startBucket` instead before removing it).

### Batch 3 — write timestamp vocabulary unification — EXECUTED 2026-08-05

- R-3. Maintainer-approved and shipped: `SetDatesParams` op params `creationDate`/`completionDate` → `createdAt`/`completedAt`, unifying the write input surface. Kept separate from Batches 1/2 (a write-input-surface break, not a read-projection collapse); CLI + MCP wire byte-stable (they were already this spelling).

### The substrate-segregation proposal (Batch 2 detail)

The gap: seven internal fields (`start`, `logged`, `trashed`, `todaySection`, `today`, `evening`, `reminderLive`) sit on `TaskCommon` intermixed with consumer vocabulary. `shape.ts` distinguishes them today only by a hand-maintained list of seven `delete o[...]` statements.

**Option A — `_`-prefix naming convention** (`_start`, `_logged`, …). Pro: `shape.ts` could drop them generically (`for (const k of Object.keys(o)) if (k.startsWith("_")) delete o[k]`). Con: unidiomatic public field names on the programmatic API; churns every read site; `startDate` cannot be `_startDate` (it is a genuine full-tier consumer field), so the convention is not uniform; generic-delete risks over-deletion if a future consumer field ever starts with `_`. **Not recommended.**

**Option B — nested `derived` sub-object** — RECOMMENDED. Add `TaskCommon.derived: { start; logged; trashed; todaySection; today?; evening?; reminderLive? }` (final name Mike's call — `derived` / `internal` / `substrate`). Then:
- `shape.ts`'s seven deletes collapse to one: `delete o.derived` (after the derivations read `o.derived.*`).
- The entity type is self-documenting: everything outside `derived` is consumer vocabulary; everything inside never reaches the wire.
- `deriveStage`/`deriveWhen`/`whenIsProvisional`/`stageOf`/`whenOf`/`todayMarkers` read from the bag; `render.ts` (evening styling, reminder bell) and the write-verify schedule delta rekey to `entity.derived.*`.
- **What the TTY/write layers touch:** `src/model/mappers.ts` (build the `derived` bag), `src/read/stage.ts` (derivation input shapes), `src/read/shape.ts` (`stageOf`/`whenOf` read `derived`, single drop), `src/cli/render.ts` (evening + bell), and the write-verify schedule-delta reader that consumes `todaySection`.
- **Trade-off:** burying `start`/`logged`/`trashed` inside `derived` slightly reduces programmatic-API ergonomics (a TS consumer wanting the raw lifecycle now reaches `entity.derived.start`). Mitigation: `stage`/`when` are the intended consumer axes anyway; export a `deriveStage(entity)` / `deriveWhen(entity)` helper from `src/index.ts` so a programmatic consumer gets the wire word directly with a clock. `startDate` stays FLAT (dual-role consumer field, full-tier).

**Option C — keep flat, enforce by test only** (no restructuring; add the §4 lock test over the current flat shape). Pro: zero churn; keeps `start`/`logged`/`trashed` first-class. Con: does not make substrate "visibly distinct" structurally (the brief's explicit ask) — the boundary stays a discipline, not a shape.

**Recommendation:** Option B, with `startDate` kept flat and a `deriveStage`/`deriveWhen` helper exported to offset the ergonomics cost, and the redundant `todaySection` DELETED rather than moved (verify the write-verify path first). This is the change that makes `shape.ts` demonstrably "drop/promote only" — the substrate leaves in one `delete o.derived`, and any NEW internal field is forced into `derived` by the type, where the lock test (below) guarantees it never leaks.

## 4. Success criterion, restated measurably + the lock

**Restated:** after execution, `src/read/shape.ts` contains no vocabulary TRANSLATION — every operation on a key is one of {select, drop, presence-key, group into a nested object, promote a nested value up, flatten a ref}, and NO expression renames `internalName → differentWireName`. Concretely: (a) the day-block `date`→`when` translation is gone (R-1); (b) every entity field that reaches the wire does so under its OWN name; (c) every wire-only key is a registered emission-derived key (`stage`, `when`, `provisional`, `hasNotes`, `checklist`, `todos`, `repeating`, `instanceOf`, `archived`, `projectIsTemplate`, the `*Uuid` siblings) built from clearly-sourced inputs; (d) all internal substrate leaves via a single structural drop (`delete o.derived`, post-Batch-2).

**The lock — a wire-key inventory test (practical, recommended).** TS types are not trivially enumerable at runtime, so a pure "type vs contract table" parity check is impractical as a hard gate. Instead:

1. Build a maximally-populated entity of each kind (to-do, project, heading node, area) — every optional field set.
2. Run it through `shapeReadPayload` at BOTH tiers (compact + full) for each view kind.
3. Assert the emitted key set ⊆ `WIRE_KEYS` (a frozen allow-list) ∪ `EMISSION_DERIVED` (the registered derived keys). **Any new entity field that leaks to the wire, or any translation that introduces an unexpected key, fails the test** with the offending key named.
4. Symmetric direction: assert every non-`derived` entity field name appears in `WIRE_KEYS` (catches a consumer field that is NOT the wire name — i.e. a latent RENAME) EXCEPT the documented tier-drops.

This is a golden key-inventory lock: it enforces (b)+(c) directly, and after Batch 2 the stricter structural guarantee (all substrate under `derived`, one drop) makes leaks nearly impossible by construction. A companion assertion — a source-level test that `shapeItem`'s only key-CREATING assignments target registered derived keys — is possible but brittle (parses `shape.ts`); the key-inventory golden is the pragmatic primary lock. Cross-check the `WIRE_KEYS` allow-list against the [contract.md](../contract.md) glossary + "Read views" table in the same PR so the doc and the lock cannot drift.

## 5. Cross-references

- Scope of record: [docs/up-next.md](../up-next.md) §7.1.
- Wire doctrine this audit is measured against: [read-shape-doctrine-v2.md](read-shape-doctrine-v2.md) (R1–R13), [read-shape-doctrine.md](read-shape-doctrine.md).
- Ratified consumer vocabulary: [../contract.md](../contract.md) (the glossary + "Read views — shapes and orderings").
- Entity + layer topology: [architecture.md](architecture.md) §2 (Entities, Read API, Consumer boundary).
- ALPHA-CONTRACT (why the inward renames + entity break carry no compat machinery): [architecture.md](architecture.md) §Alpha contract; [../../AGENTS.md](../../AGENTS.md) Conventions.
