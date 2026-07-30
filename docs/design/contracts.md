# CLI Contracts

These are the stable, agent-facing contracts of the `things` CLI. They bind from Phase 0 onward; breaking either requires a major version bump. Source of truth in code: [`src/cli/exit-codes.ts`](../../src/cli/exit-codes.ts) and [`src/cli/output.ts`](../../src/cli/output.ts), both covered by regression tests.

## Exit codes

| Code | Name | Meaning |
|---|---|---|
| 0 | Ok | Success. |
| 1 | Unexpected | Internal error (bug, unhandled condition). |
| 2 | Usage | Unknown command, bad flags, invalid arguments. |
| 3 | VerifyFailed | Mutation executed but read-after-write verification failed (timeout, mismatch, or silent no-op). |
| 4 | Blocked | Mutation refused **before** touching the app: hazard guard or disruption-tier policy. |
| 5 | DriftBlocked | Writes disabled: DB schema fingerprint deviates from the known baseline. |
| 6 | Unsupported | Operation not supported by any available write vector. |
| 7 | Environment | DB not found, Things not installed, permission problems. |

Codes are never renumbered; new codes append.

## `--json` envelope

Every command supports `--json`. Envelope JSON goes to **stdout**; all human/log chatter goes to **stderr**. `apiVersion` bumps only on breaking envelope-shape changes.

```jsonc
// success
{
  "apiVersion": 1,
  "ok": true,
  "kind": "today",              // payload discriminator per command
  "data": { /* command-specific */ },
  "meta": { "dbVersion": 26, "fingerprint": "ok", "elapsedMs": 12 }
}
// failure
{
  "apiVersion": 1,
  "ok": false,
  "kind": "error",
  "error": { "code": "blocked:drift", "message": "…", "remediation": "…", "detail": {} },
  "meta": { "dbVersion": 26, "fingerprint": "drift", "elapsedMs": 8 }
}
```

- `meta.fingerprint` ∈ `ok | drift | user-accepted | unknown`.
- `error.code` is drawn from the frozen `ErrorCode` registry (`src/contracts.ts`; enumerated in [docs/contract.md](../contract.md) § The error-code registry): the exit-code family (`usage`, `unsupported`, `environment`, `unexpected`, `bounce-aborted`, bare `verify-failed` / `blocked`), the reference-resolution codes `not-found` / `ambiguous`, and the two colon-namespaced families `verify-failed:<reason>` (`timeout` \| `mismatch` \| `silent-noop`) and `blocked:<suffix>` (a hazard id like `blocked:H-UNKNOWN-TAG`, or a block reason like `blocked:drift` — which alone maps to exit 5).
- `error.detail` is the SINGLE additive machine-readable failure-context object (the `detail`/`details` split was reconciled into one field in the 1.0 shape break): `candidates` / `suggestions` (self-correction), `expected` / `observed` (a verify-failed delta), `considered` (rejected vectors), and the bounce/move remnants. Each key is present only for the failure that produces it. **The MCP tool result still frames its error as `{code, message, remediation?, details}`** with `details.candidates`/`details.suggestions` (its framing sweep is phase 2) — a consumer of the MCP surface reads `details`, a consumer of the CLI envelope reads `detail`.

## List-view truncation metadata (`meta.truncation`)

List views are bounded by default and report exactly what was hidden — nothing is ever silently dropped. Since the 1.0 shape break there is ONE shape, `meta.truncation` (the former separate `meta.grouped` was folded into it as the optional `blocks` breakdown); `meta.truncation.truncated` is the universal completeness check. It is additive and never omit-empty-pruned.

**Flat / chronological views** (`inbox`, `today`, `upcoming`, `logbook`, `trash`, `search`, `changes`) carry the base shape:

```jsonc
{
  "shown": 50,          // rows returned
  "total": 75,          // rows that matched after all filters
  "limit": 50,          // effective cap; null = unbounded (--all / limit:null)
  "truncated": true,    // exactly shown < total
  // Split flat views only (currently `today`): the whole-view counts broken
  // down per render section, in render order. Absent on unsplit views.
  "sections": [
    { "key": "today",   "shown": 50, "total": 55 },
    { "key": "evening", "shown": 0,  "total": 20 }
  ]
}
```

**Grouped catalogues** (`anytime`, `someday`) and the sectioned detail views (`area show`, and `get_area` / `list_collections` over MCP) put their per-block nesting under `meta.truncation.blocks` (the base `shown`/`total` aggregate the blocks; `limit` is `null`). Every header/section is always rendered; only the innermost item lists are capped:

```jsonc
// meta.truncation on a grouped view
{
  "shown": 12, "total": 23, "limit": null,
  "truncated": true,          // any block hid items
  "blocks": [                 // one identity-carrying block per capped list
    { "kind": "loose", "ref": null, "title": null, "shown": 5, "total": 5, "limit": 30 },
    {
      "kind": "area", "ref": "<area-uuid>", "title": "Hobbies",
      "shown": 4, "total": 10, "limit": 30,
      // Project blocks NEST inside their area/loose block (anytime item-lists;
      // someday's active-project child groups). area-show's projects/area
      // blocks are siblings of one area and stay top-level.
      "children": [
        { "kind": "project", "ref": "<project-uuid>", "title": "Firmware",
          "shown": 3, "total": 8, "limit": 3 }
      ]
    }
  ]
}
```

- `kind` ∈ `loose | area | project | projects` (`projects` = `area show`'s active project-ROWS section). `ref` is the container uuid (`null` for the loose block); `title` its name.
- `shown`/`total`/`limit` are per block; the dropped remainder is `total - shown`. A block whose rows were ALL dropped still appears with `shown: 0` (so no truncated header is untraceable); a genuinely empty block (`total: 0`) is omitted.
- Someday's mixed area/loose blocks additionally carry `totalProjects` / `totalTodos` (project rows list first, so the hidden split is derivable).
- **Honesty note (area view):** an `area-view` `blocks[kind=area]` count is "direct to-dos hidden", NOT a per-wire-bucket count. It counts the area's internal `active` set, whereas since R10 the wire splits those same rows across the `anytime` and arrived-`upcoming` buckets — so `total` there is the completeness figure for the direct-to-do section as a whole, not the size of any one emitted bucket. Reconciling block counts with the stage buckets is queued (`docs/up-next.md`).

**Shape history (pre-1.0 breaks):** the block breakdown grew identity + nesting (`ref` replaced the former `uuid`; project blocks moved under `children`), `meta.truncation` grew the optional `sections`, and the 1.0 shape break folded the former standalone `meta.grouped` into `meta.truncation.blocks` so there is one completeness shape. Same defaults and metadata apply over MCP. The full consumer-facing contract — the envelope grammar, the compatibility covenant, the glossary, and the error-code registry — is in [docs/contract.md](../contract.md).

## Consumer clock (`meta.clock`, timezone / pinned now)

Things view membership is DERIVED from stored calendar dates vs. an evaluation instant, so it is coherent under any evaluation clock (it is why two synced devices in different zones legitimately disagree about Today). By default every date boundary — today / evening / upcoming grouping and `--since`/`--until` clipping / `--overdue` / the logbook sweep / `changes --since` / inbox created-date bounds — evaluates in the **host** zone. Two environment knobs, read by both the CLI and the MCP server process, shift that:

- **`THINGS_TZ`** — an IANA zone (e.g. `Asia/Tokyo`) so those boundaries evaluate for the CONSUMER'S calendar (an MCP endpoint hosted on one machine, queried from three zones away). Over MCP the date-sensitive tools (`read_view`, `search`, `changes_since`, `get_project`, `get_area`, `list_collections`, and the write tools that take `when`) also accept a per-call `tz` that overrides `THINGS_TZ` for that call.
- **`THINGS_NOW`** — an ISO-8601 instant pinning "now" (a determinism knob for tests/lab).

**Precedence:** per-call `tz` > `THINGS_TZ` > host zone. Effective clock = `{ now: THINGS_NOW ?? real now, zone: resolved zone ?? host }`. Invalid values **fail closed** — an unknown zone or unparseable instant is a usage error (exit 2 / MCP `usage`) naming the expected form, never a silent host fallback.

**Additive honesty field.** When a consumer zone OR a pinned now is in effect, `--json` envelopes and MCP responses carry:

```jsonc
"meta": { "clock": { "timezone": "Asia/Tokyo", "today": "2026-07-03" } }
```

It is **absent on the host clock**, so the wire shape is unchanged for existing consumers (a machine consumer keys on presence, exactly like every other additive `meta.*` field).

### Writes — normalize-before-dispatch

The write grammar's only clock-relative tokens are `when: today` and `when: evening` (everything else is an explicit `YYYY-MM-DD` / `HH:mm`). Sent raw, the app would interpret the word on its OWN (host) clock, so when a consumer zone is in effect the pipeline normalizes BEFORE dispatch:

- **`when: today`** → resolved to the consumer-zone calendar date and dispatched as the explicit `when=YYYY-MM-DD` (the reminder token rides along as `<date>@<time>`). Verification then agrees by construction (it compares the stored packed date against the same precomputed date). A consumer-today that is host-yesterday yields a past `startDate` — that is coherent Things semantics (the item lands in Today with overdue-start), documented, not special-cased.
- **`when: evening`** → This Evening exists ONLY for the app machine's own current day (it is the `startBucket=1` rows whose `startDate` is exactly the app's today; an "evening of another day" is not representable in Things' model, not even in the GUI). So it is expressible only when the consumer's today equals the app's today, and is otherwise **refused fail-closed** (`blocked:clock`, exit 4) with a remediation.
- **Reminder times (`HH:mm`)** are wall-clock and tz-less in Things' own model — they are NEVER translated.

Internal machinery (undo inverse scheduling, reorder bounce legs) converses with app-written host state and is deliberately left on the host clock — only consumer-provided `when` tokens normalize.

### Deployment note — host timezone alignment

Changing the host's system **timezone** is safe: it relabels wall clocks but leaves absolute instants (and therefore Things Cloud's edit-timestamp sync ordering) unchanged. Changing the host's **clock** is NOT — Things Cloud merges are edit-timestamp-ordered (3-way merge, not last-writer-wins; see `docs/lab/headless-research.md` SYNC2), so clock skew corrupts merge ordering on a sync-live library. For a dedicated single-consumer host, aligning the system timezone with the consumer's (`sudo systemsetup -settimezone <zone>`) makes app-today ≡ consumer-today, so `when: evening` works natively and this consumer-timezone feature is only needed to serve OTHER zones.

## Detail tiers and no-redundant-ancestry (R6/R7)

Two shaping rules run at the read emit boundary — the CLI `--json` reads AND the MCP read tools — in [`src/read/shape.ts`](../../src/read/shape.ts), BEFORE omit-empty (below). They are deterministic BY VIEW KIND, never per-item heuristics, so both surfaces inherit the identical shape; the human render keeps the full unshaped entities.

**R6 — no-redundant-ancestry.** An item never states a fact its enclosing node already states. In a **project-view** every child (in any bucket, incl. heading-group members) drops `project` and `area`; a heading-group member additionally drops `heading` (the card and the group state them). In an **area-view** every child item and project card drops `area`; project-child items keep `project`. In an **anytime/someday** section (`{area, items}`) items drop `area` (including the explicit `area: null` section), keeping `project`/`heading`. **Mixed-provenance lists keep every ref** — `inbox`, `today`, `upcoming`, `logbook`, `trash`, `search`, `changes`, `projects` — since those pull from many containers (in the COMPACT tier the `heading` ref is additionally dropped from these, per R7 below). The invariant that makes the drop lossless: the entity `area` is the EFFECTIVE area, and a project/heading child carries `area = NULL` in the DB, so its effective area resolves THROUGH its container to exactly the card's area (the sidebar grouper buckets by the same effective area). **Reading rule: absence of a container field INSIDE a container view = inherited from the enclosing node**, the opposite of its meaning in a mixed list (where absence means "no container").

**R7 — named detail tiers (compact | full).** Every list context — `items`, `sections`, and the collection arrays inside a `view` — returns a COMPACT line-item; `detail`/`show` and a `--full` (CLI) / `full: true` (MCP `read_view` / `search` / `changes_since` / `get_project` / `get_area` / `list_collections`) request return the FULL record. Compact = identity + structural facts + non-default facts: `status` (omit when `open`), `created`/`modified` (always dropped — get them from `detail`), the full `notes` string dropped for a presence-keyed `hasNotes: true` marker (absent = no notes), and the `heading` ref dropped everywhere (the GUI shows the project, never the heading, outside a project view). `--full` restores per-row density (incl. full `notes` and `heading`) but R6 still applies (ancestry redundancy is not tier-dependent). **Compact reading rule: absence = the default.**

**Universal reshapes (both tiers, and `detail`).** (1) The flat `checklistItemsCount` / `openChecklistItemsCount` are gone from the wire — a to-do with a checklist carries `checklist: {open, total}` (a `detail` read nests the items at `checklist.items`), and a to-do without one carries no `checklist` key. (2) A project's flat `untrashedLeafActionsCount` / `openUntrashedLeafActionsCount` are gone from the wire — a project with to-do children carries `todos: {open, total}` (same presence-keyed shape as `checklist`; absent when `total` is 0), the app-maintained leaf-action counts that count to-do children only (headings and checklist items are excluded by construction — and the counts never include trashed items). (3) `tags` (and `inheritedTags`) are a plain array of tag NAMES — the per-tag object wrapper is gone (tag uuids were never on the wire). (4) An item whose membership routes through a heading carries its owning project under the single key `project` — the former `headingProject` is merged in and never appears on the wire (the two could never coexist or disagree). (5) The all-false `repeating` block is dropped entirely; a template/instance keeps a minimal truthful object (only its true booleans and non-null values, incl. `rule` on a detail).

**R10 — the `stage` lifecycle taxonomy.** The three former wire fields `start` / `logged` / `trashed` are DELETED from every item and replaced by ONE derived `stage` ∈ `inbox | upcoming | anytime | someday | logbook | trash` (`src/read/stage.ts` `deriveStage` — the single pure derivation, reused by the card bucketing so `stage` can never disagree with the bucket a view puts an item in). Precedence: trashed → `trash` (wins over everything, incl. logged); logged (past the logbook boundary) → `logbook`; else `inbox`; else `upcoming` (a repeating template, OR any `startDate` — Upcoming is a SUPERSET of Today); else `someday`; else `anytime`. A completed/canceled row not yet past the logbook boundary keeps its live stage. Today/evening membership is a SEPARATE presence-keyed axis — `today: true` / `evening: true` (evening implies today) — derived with the Today view's own two-arm predicate (a scheduled `startDate <= today`, OR an undated due/overdue deadline that is not suppressed; so an undated deadline-today item reads `stage: "anytime"` + `today: true`).

**R10 dropping (bucket/section-implied).** `stage` is dropped where the enclosing view/section STATES it — the stage-scoped flat catalogues (`inbox`, `upcoming`, `logbook`, `trash`, and the `anytime`/`someday` sections) and the stage-named card sub-buckets (`anytime`/`upcoming`/`someday`/`logbook`/`trash`) — and KEPT on the mixed/derived surfaces (`search`, `changes`, `today`, the projects/areas listings, the card NODE, detail). The `today`/`evening` markers are dropped inside the `today` view's own sections (the section key states it) and kept everywhere else (a logbook/trash row is never a Today member, so its markers drop with it).

**R10 view-card rename/reshape.** The area/project cards and heading groups now name their sub-buckets in the same six words: the former `active` becomes **`anytime`**; the former `scheduled` date-groups and the separate `repeating` array MERGE into **`upcoming`** — a `[{date, items}]` list, date ASC (a dated row under its `startDate`, a template under its `nextOccurrence`), with a trailing **`{date: null, items}`** group for the date-less resting templates (after-completion / paused; explicit `null` per the `area: null` section precedent); `someday` stays; the former `logged` becomes **`logbook`**; the former `trashed` becomes **`trash`**. A heading group is `{heading, anytime, upcoming, someday}`; the area card keeps its `projects` list (a mixed listing that keeps `stage`).

The omit-empty contract below then runs on whatever the tier left, and the table describes the entity at the FULL tier (a `detail` read, or any list under `--full`); a compact list prunes further per R7.

## Search match provenance (R8)

`search` treats a project's HEADING titles and a to-do's CHECKLIST-item titles as searchable properties of the parent — the way it already treats notes — so a match on either surfaces the PARENT (a project for a heading, a to-do for a checklist item), never a bare heading/checklist row (the GUI has none). Every hit that matched on something OTHER than its own title carries a `match: {field, text}` annotation (`src/read/views.ts` `searchView`), shared by CLI `--json` + the MCP `search` tool + the human TTY render:

- **`field`** ∈ `"heading"` | `"notes"` | `"checklist"`. **`text`** is the matched heading title, a bounded notes snippet (~80 chars, whitespace-collapsed, centered on the first occurrence with `…` elision), or the matched checklist item's title.
- **Presence-keyed.** A TITLE match carries NO `match` (absence = matched where you'd expect). At most one annotation per hit; when several fields match, precedence is **title (none) > heading > notes > checklist** (a project matched by BOTH its notes and a child heading shows the heading annotation, though it keeps its notes RANK — the rank order is unchanged: title > notes > heading > checklist).
- **Checklist arm — dedup + no uuids.** A to-do appears ONCE no matter how many of its checklist rows match, annotated with the FIRST matching row's title (by checklist index). **Checklist-item uuids appear on NO surface** (an implementation detail, like tag uuids — the join reads titles only); a regression test asserts the payload carries none. The arm is skipped for a `--type project` search; the heading arm is skipped for a `--type to-do` search.
- **Compact-tier fact.** `match` rides compact rows (a non-default fact, per the compact rule) and passes through the shape/omit-empty boundary untouched. The TTY render adds an indented muted matched-on line under an annotated hit (`  ⤷ heading: "…"` / `  ⤷ notes: "…snippet…"` / `  ⤷ checklist: "…"`); a title hit renders as a plain row.

(This replaces the earlier `matchedVia: {kind, title}` heading-only annotation with the one converged `match: {field, text}` shape across all three arms.)

## Omit-empty (entity payloads)

**Contract:** in the `data` of every read (`--json` reads AND the MCP read tools), an entity omits any optional field whose value is empty — `null`, an empty string `""`, or an empty array `[]`. **A consumer MUST read an absent key as unset / empty / default, and MUST NOT distinguish absent from empty.** This is the whole point: `deadline` absent and `deadline: null` mean the identical thing; a consumer that branches on which one it got is wrong. Guard every access (`item.tags ?? []`, `item.deadline == null`).

Motivation: token economy and one canonical shape (no `null`/`[]` noise). Applies to the *entity/data* payload only. It is a **breaking change** for any consumer that previously tested for an empty-array or `null` presence.

Kept even when "empty" (absence would be lossy, so these are always present on the entity that has them):

- **Identity keys** — always present: `uuid`, `type`, and the name (`title`). An untitled to-do still carries `title: ""`.
- **Booleans** — a real `false` is meaningful, never omitted where a value is emitted: `repeating.isTemplate`, `repeating.isInstance`, `repeating.paused`, `repeating.deadlined`, an area's `visible`. (The former `logged`/`trashed` item booleans are gone — R10 folds them into the one derived `stage`; the `today`/`evening` markers are PRESENCE-keyed, set only when true.)
- **Numeric counts** — a `0` is meaningful, never omitted by omit-empty: `openChildrenWhileResolved`, the `badge` counts. (The checklist counters and the project leaf-action counters are no longer flat wire fields — the reshapes fold them into the presence-keyed `checklist` and `todos` objects above, each absent when its total is 0.)
- **Structural scaffolding** — the view shape that *carries* entities is not itself an entity and is never pruned, so its lists/markers survive empty: the `today` / `evening` split (a fixed two-section shape), the `project`/`area` card sections (`anytime`, `headings`, `upcoming`, `someday`, `logbook`, `trash`, `projects`), and a sidebar section's `area: null` — the load-bearing "top-level / loose block" marker. Only the entities *inside* the scaffolding are pruned. (This is why omit-empty is scoped to recognized entity shapes, not a blanket deep prune: a to-do's `area: null` means "no area" and is dropped, but a section's `area: null` is a discriminant and is kept — same key, opposite meaning.)

Omitted when empty, per entity:

| Entity | Always present (identity + meaningful false/0) | Omitted when empty |
|---|---|---|
| to-do (`type: "to-do"`) | `uuid`, `type`, `title`, `status`, `stage` (dropped only where a view/section provably states it — R6/R10.1: the stage-pure `inbox`/`someday`/`logbook`/`trash` views and the card sub-buckets; KEPT on the stage-mixed `anytime`/`upcoming` catalogues), `created`, `modified` | `notes` (`""`), `startDate`, `today`/`evening` (presence-keyed markers — `todaySection` was retired from the wire in R10.1 as redundant with `evening`), `deadline`, `reminder`, `area`, `project` (a headed child's owning project rides here — `headingProject` is merged in, never a separate wire key), `heading` (full tier only — compact drops it), `stopped`, `tags` (`[]`, a string-name array), `inheritedTags` (`[]`, a string-name array), `checklist` (the `{open, total}` object — absent when there is no checklist), `repeating` (absent when not repeating-involved — R7) |
| project (`type: "project"`) | `uuid`, `type`, `title`, `status`, `stage` (R10), `created`, `modified` | `notes`, `startDate`, `today`/`evening` (markers — `todaySection` retired in R10.1), `deadline`, `reminder`, `area`, `stopped`, `tags` (string-name array), `inheritedTags` (string-name array), `todos` (the `{open, total}` child-to-do summary — absent when the project has no to-do children), `repeating` (absent when not repeating-involved — R7) |
| heading (`type: "heading"`) | `uuid`, `type`, `title`, `status` | `project` (null) |
| area | `uuid`, `title`, `visible` | `tags` (`[]`) |
| tag (taxonomy listing) | `title` | `shortcut` (null), `parent` (null — a root tag has no `parent` key) |
| checklist item | `title`, `status` | — (no optional fields) |

`inheritedTags` is present ONLY on the detail reads (`todo show` / `project show` / `get_item` / `get_project`) and follows omit-empty — **absent when empty, present when non-empty.** It is a **plain array of tag NAMES** (`string[]`), parallel to `tags` (which is also a string-name array); the container-provenance `source` object it once carried was **removed 2026-07-16** (there is no `‹project X›`/`‹area Y›` chip). A machine consumer keys on presence, and `item.inheritedTags ?? []` is the correct read.

The `area` field reports the **EFFECTIVE** area (revised 2026-07-16): a to-do's own `area`, else its project's area, else its heading's project's area — so a to-do nested in a project-in-an-area now emits `area: <that area>` instead of being absent (a project's `area` is its own; areas are not inherited). Whether the area is direct vs inherited stays derivable from whether `project`/`heading` is set. This is a **behavior change** to the `area` field's meaning (previously the raw `t.area` column only).

`repeating` follows the R7 reshape (above): the all-false block (a normal, non-repeating row) is ABSENT; a template/instance carries a minimal object of only its true booleans and non-null values (`isTemplate`/`isInstance`, `templateUuid`, `nextOccurrence`, `paused`, `deadlined`, and `rule` on a detail read). Absence therefore means "not repeating-involved."

Not covered by this contract (own shapes, unchanged): the **error envelope** (`error.code` / `error.detail.candidates` / `error.detail.suggestions` — a candidate entity is NOT pruned), **mutation results / plans** (`kind: "mutation-result"`, dry-run plans), and the non-entity diagnostic payloads (`doctor`, `capabilities`, `config`, `legend`, `setup`). The envelope `meta` (including `truncation.limit: null`, which means "unbounded") is never pruned.

Source of truth in code: [`src/read/shape.ts`](../../src/read/shape.ts) (`shapeReadPayload` — R6/R7 + the checklist/repeating reshapes) then [`src/model/serialize.ts`](../../src/model/serialize.ts) (`omitEmpty`), composed at the two emit boundaries — [`src/cli/read-driver.ts`](../../src/cli/read-driver.ts) (`runRead`) and [`src/mcp/server.ts`](../../src/mcp/server.ts) (`readResult` / the truncated + grouped read results). Covered by `test/unit/shape.test.ts`, `test/unit/serialize.test.ts`, and the read-shape assertions in `test/cli/e2e.test.ts` / `test/mcp/server.test.ts`.

## Error-path universality (every refusal honors `--json`)

**Contract:** *every* error and refusal exit — not just mutation outcomes — respects `--json`. Under `--json` the `{ok:false, error}` envelope goes to **stdout** and nothing prose goes to stderr; without it, the `error:` prose line goes to **stderr**. Flag/argument usage errors route through one shared emitter (`usageError`, `src/cli/read-driver.ts`) so this holds uniformly; there is a single envelope shape (the one merged `error.detail` object with `candidates` / `suggestions`) — never a second one.

Machine-readable `error.detail` is emitted wherever disambiguation is actionable (the CLI envelope; the MCP tool result carries the same data under `details` pending its phase-2 framing sweep):

| Error path | `error.code` | exit | `error.detail` |
|---|---|---|---|
| Ambiguous write/read target — project/area/tag **name** or **partial-uuid** (`resolveProjectWriteTarget`, `resolveUuidOrThrow`, `resolveTaskUuidPrefix`) | `ambiguous` | 2 | `candidates: [{uuid, title, context?}]` |
| Not-found target (name/uuid/partial-uuid) | `not-found` | 2 | — (`candidates: []`) |
| Unknown tag (H-UNKNOWN-TAG) | `blocked:H-UNKNOWN-TAG` | 4 | — (missing names listed in `message`) |
| Unknown/ambiguous destination (H-UNKNOWN-DESTINATION) | `blocked:H-UNKNOWN-DESTINATION` | 4 | — (`matches`-count phrasing in `message`/`remediation`; candidate rows not threaded through the container resolver) |
| Bare mutation verb hint | `usage` | 2 | `suggestions: [string]` |
| Unresolved show/bare-noun subject (did-you-mean) | `not-found` | 2 | `candidates: [entity]` |
| Flag/argument usage errors (exclusive flags, bad `--limit`, unparseable dates, `--type`, empty `--db`, etc.) | `usage` | 2 | — |

The same structured detail rides the MCP tool result: mutation errors and reference-resolution errors return `{code, message, remediation?, details}` in the tool result's `isError` text block (`src/mcp/server.ts` `errorResult`/`guard`), so MCP consumers get candidates as data, not prose. MCP inherits the name / partial-uuid reference sugar automatically (shared write pipeline).

Batch/undo use a JSONL streaming contract (not the single envelope); their pre-flight flag errors emit the usage envelope, and their per-item outcomes stream as data.

## Batch chaining, idempotency, and undo (`batch` / MCP `batch`)

A batch line is `{"op", "params", "options"?, "tempId"?, "opId"?}` (MCP: `temp_id` / `op_id`). Ops run sequentially and independently — no transactions. Three additive features ride the same submission; the per-line outcome shape and the trailing summary line are otherwise unchanged.

**`tempId` — chaining across legs.** A line that CREATES a uuid may declare a `tempId` handle; a LATER line references the created uuid as `"$name"` in any ref-accepting param (`uuid`, `uuids[]`, `target`, `before`/`after`, and the `uuid` of a `project`/`area`/`container` ref; also `heading`). Dotted access reaches an identity-replacement op's other discovered uuids: `"$name.instance"` (the spawned occurrence of a make-repeating) and `"$name.replaced"` (the destroyed source). The handle binds to the leg's PRIMARY result uuid (the successor template / new project for identity-replacement ops) once — and only once — the leg VERIFIES OK; a failed leg (including a rule-mismatch that surfaces discovery uuids in its error) binds nothing.

- **Eligibility:** `tempId` is valid ONLY on a uuid-minting op — `todo.add`, `todo.add-logged`, `project.add`, `project.add-repeating`, `area.add`, `heading.add`, `todo.duplicate`, `project.duplicate`, `todo.make-repeating`, `project.make-repeating`, `todo.convert-to-project`, `heading.convert-to-project`. It is a usage error on `tag.add` (tags have no uuid — reference a tag by its title) and on any non-minting op.
- **Charset / uniqueness:** `[A-Za-z0-9_-]{1,32}`; a duplicate declaration in one batch is a usage error. All declaration errors (bad charset, duplicate, wrong op) are pre-flight — they reject the WHOLE batch before any leg runs (the offending line reports `invalid`; the rest report `skipped`; nothing executes or is audited).
- **Strict, fail-closed `$` resolution (per line, as legs land):** a `$`-prefixed value in a ref-accepting param is ALWAYS a temp reference, never a literal. A value naming no declared tempId fails that line with `unresolved-temp-ref`; a forward reference (declared on a later line) or a reference to a leg that bound nothing (failed/skipped) fails that line BEFORE dispatch. Independent later legs still run (the batch's per-line failure semantics). Consequence to document: a real title/value that begins with `$` cannot be used in a ref-accepting param — address that item by uuid instead.

**`opId` — idempotency (safe resubmission).** A line may carry a client `opId` (`[A-Za-z0-9_-]{1,64}`), recorded on the audit record. Before dispatch it is matched against the recent change history (the last 1000 records AND the last 7 days, whichever is smaller) for an `ok` record with the same `opId`; on a hit the leg is SKIPPED and reported `already-applied` with the original record's uuid — and that uuid is bound to the line's `tempId` so later `$refs` still resolve. This makes resubmitting an ambiguously-failed batch safe against double-creates. `already-applied` counts as success (not a failure for `--fail-fast` / exit codes).

**Single-op idempotency (`--op-id` / MCP `op_id`) — the same key on ONE mutation.** Every single-invocation write command that runs the write pipeline (mutations, single moves, heading ops — the commands whose result is ONE recorded ok record) takes an `--op-id <key>` flag (MCP: `op_id` on the single-mutation write tools), the same charset as a batch line. It reuses the SAME lookback machinery (`src/write/opid.ts`, shared with `batch`) over the SAME trail — the id namespace is shared, so a batch leg and a single op with the same key match each other. Before dispatch, a match against a recent VERIFIED-OK record SKIPS execution entirely and returns the command's normal success envelope with the ORIGINAL result's identity (`op`, `uuid`, `undoToken`, `title` when the record stored one — from `requested.title`) plus presence-keyed `alreadyApplied: true`; no new audit record is written. On no match the mutation runs normally and its record stores the `opId` (the batch machinery already does this — reused, not forked). A malformed key is a usage error (exit 2 / MCP `usage`). The idempotency CHECK runs in the client's single-op entry, so the batch and compound-orchestrator paths are unaffected. **Phase 1 matches ok records only** — reconciling a resubmission against a `verify-failed:timeout` original is queued as phase 2 (`docs/up-next.md`). The **variadic/compound verbs** (multi-item `move`/`reorder`, granular checklist edits, clear-reminder, project make/add-repeating, archive/unarchive-heading, project reopen) REFUSE `--op-id` with a teaching usage error — they are multi-leg compounds whose idempotency is the batch-shaped per-line `opId`. **Audit-record note:** the record has no dedicated title field, so a replayed `title` is `requested.title` (present for create/rename ops, absent otherwise); the `undoToken` is re-derived from the record under the same reversibility rule the executor uses (absent for an irreversible op or a batch-leg record).

**Batch undo token.** Every leg records under one shared transaction (`txn.role: "leg"`); when at least one leg reaches the pipeline, the batch writes a summary audit record (`op: "batch"`, `txn.role: "summary"`) whose undo token IS the batch token. `things undo --txn <token>` (MCP `undo` `txn`) reverses the WHOLE submission as one unit, replaying each ok leg's inverse in REVERSE leg order through the existing compound-summary machinery (a leg with no validated inverse is skipped with a note, exactly as for any compound). A batch LEG is not an independent undo target — the summary is the single undoable unit (consistent with every compound op).

**Result additions (additive; existing shapes untouched).** Each per-line outcome additionally echoes `tempId` (when declared) and `boundUuid` (the uuid bound to it), and `opId` (when supplied). The trailing CLI summary line gains `tempIdMapping` (`{name: uuid}`) and `undoToken`; the MCP `batch` result gains a SECOND content block carrying `{tempIdMapping, undoToken}` (the first block — the per-op results array — is unchanged). `--dry-run` mints nothing, so it resolves no temp refs: a ref-using line is previewed as `skipped`, and no summary/undo token is emitted.

## Interaction rules

- **No interactive prompts, ever.** Risky operations require explicit acknowledgement flags (e.g. `--children auto-complete`, `--acknowledge-checklist-reset`), documented in each command's `--help`.
- Every write command's `--help` states its disruption tier, default vector, applicable hazard guards, and exact ack flag names.
- `--help` text is regression-tested output — it is the API contract agents discover the tool through.
