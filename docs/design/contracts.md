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
  "error": { "code": "drift-blocked", "message": "…", "remediation": "…", "detail": {} },
  "meta": { "dbVersion": 26, "fingerprint": "drift", "elapsedMs": 8 }
}
```

- `meta.fingerprint` ∈ `ok | drift | user-accepted | unknown`.
- `error.code` mirrors the exit-code family (`verify-failed`, `blocked`, `drift-blocked`, `unsupported`, `environment`, `usage`, `unexpected`) plus finer-grained sub-codes where useful (e.g. `verify-failed/silent-noop`, `blocked:H-UNKNOWN-TAG`), and the reference-resolution codes `not-found` / `ambiguous`.
- `error.details` is the additive machine-readable failure context: `candidates` (disambiguation entities) and/or `suggestions` (concrete commands to run). Present wherever a failure is self-correctable.

## List-view truncation metadata (`meta.truncation` / `meta.grouped`)

List views are bounded by default and report exactly what was hidden — nothing is ever silently dropped. Two shapes, additive and never omit-empty-pruned:

**`meta.truncation`** — the flat / chronological views (`inbox`, `today`, `upcoming`, `logbook`, `trash`, `search`, `changes`):

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

**`meta.grouped`** — the grouped catalogues (`anytime`, `someday`) and the sectioned detail views (`area show`, and `get_area` / `list_collections` over MCP). Every header/section is always rendered; only the innermost item lists are capped:

```jsonc
{
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

**Breaking (pre-v1.0):** `meta.grouped.blocks` grew identity + nesting (`ref` replaced the former `uuid`; project blocks moved under `children`), and `meta.truncation` grew the optional `sections`. Same defaults and metadata apply over MCP.

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

## Omit-empty (entity payloads)

**Contract:** in the `data` of every read (`--json` reads AND the MCP read tools), an entity omits any optional field whose value is empty — `null`, an empty string `""`, or an empty array `[]`. **A consumer MUST read an absent key as unset / empty / default, and MUST NOT distinguish absent from empty.** This is the whole point: `deadline` absent and `deadline: null` mean the identical thing; a consumer that branches on which one it got is wrong. Guard every access (`item.tags ?? []`, `item.deadline == null`).

Motivation: token economy and one canonical shape (no `null`/`[]` noise). Applies to the *entity/data* payload only. It is a **breaking change** for any consumer that previously tested for an empty-array or `null` presence.

Kept even when "empty" (absence would be lossy, so these are always present on the entity that has them):

- **Identity keys** — always present: `uuid`, `type`, and the name (`title`). An untitled to-do still carries `title: ""`.
- **Booleans** — a real `false` is meaningful, never omitted: `logged`, `trashed`, `repeating.isTemplate`, `repeating.isInstance`, `repeating.paused`, `repeating.deadlined`, an area's `visible`.
- **Numeric counts** — a `0` is meaningful, never omitted: `checklistItemsCount`, `openChecklistItemsCount`, `untrashedLeafActionsCount`, `openUntrashedLeafActionsCount`, `openChildrenWhileResolved`, the `badge` counts.
- **Structural scaffolding** — the view shape that *carries* entities is not itself an entity and is never pruned, so its lists/markers survive empty: the `today` / `evening` split (a fixed two-section shape), the `project`/`area` card sections (`active`, `headings`, `later.{scheduled,repeating,someday}`, `logged`, `trashed`, `projects`), and a sidebar section's `area: null` — the load-bearing "top-level / loose block" marker. Only the entities *inside* the scaffolding are pruned. (This is why omit-empty is scoped to recognized entity shapes, not a blanket deep prune: a to-do's `area: null` means "no area" and is dropped, but a section's `area: null` is a discriminant and is kept — same key, opposite meaning.)

Omitted when empty, per entity:

| Entity | Always present (identity + meaningful false/0) | Omitted when empty |
|---|---|---|
| to-do (`type: "to-do"`) | `uuid`, `type`, `title`, `status`, `start`, `logged`, `trashed`, `repeating`, `checklistItemsCount`, `openChecklistItemsCount`, `created`, `modified` | `notes` (`""`), `startDate`, `todaySection`, `deadline`, `reminder`, `area`, `project`, `heading`, `headingProject`, `stopped`, `tags` (`[]`), `inheritedTags` (`[]`), `checklist` (`[]`) |
| project (`type: "project"`) | `uuid`, `type`, `title`, `status`, `start`, `logged`, `trashed`, `repeating`, `untrashedLeafActionsCount`, `openUntrashedLeafActionsCount`, `created`, `modified` | `notes`, `startDate`, `todaySection`, `deadline`, `reminder`, `area`, `stopped`, `tags`, `inheritedTags` |
| heading (`type: "heading"`) | `uuid`, `type`, `title`, `status` | `project` (null) |
| area | `uuid`, `title`, `visible` | `tags` (`[]`) |
| tag (taxonomy listing) | `title` | `shortcut` (null), `parent` (null — a root tag has no `parent` key) |
| checklist item | `title`, `status` | — (no optional fields) |

`inheritedTags` is present ONLY on the detail reads (`todo show` / `project show` / `get_item` / `get_project`) and follows omit-empty — **absent when empty, present when non-empty.** It is a **plain array of tag names** (`TagRef` — `{ title }`), parallel to `tags`; the container-provenance `source` object it once carried was **removed 2026-07-16** (there is no `‹project X›`/`‹area Y›` chip). A machine consumer keys on presence, and `item.inheritedTags ?? []` is the correct read.

The `area` field reports the **EFFECTIVE** area (revised 2026-07-16): a to-do's own `area`, else its project's area, else its heading's project's area — so a to-do nested in a project-in-an-area now emits `area: <that area>` instead of being absent (a project's `area` is its own; areas are not inherited). Whether the area is direct vs inherited stays derivable from whether `project`/`heading` is set. This is a **behavior change** to the `area` field's meaning (previously the raw `t.area` column only).

`repeating` is always present (it carries the `isTemplate` / `isInstance` booleans); inside it, `templateUuid` (null), `nextOccurrence`, `paused`, `deadlined`, and `rule` follow omit-empty.

Not covered by this contract (own shapes, unchanged): the **error envelope** (`error.code` / `error.details.candidates` / `error.details.suggestions` — a candidate entity is NOT pruned), **mutation results / plans** (`kind: "mutation-result"`, dry-run plans), and the non-entity diagnostic payloads (`doctor`, `capabilities`, `config`, `legend`, `setup`). The envelope `meta` (including `truncation.limit: null`, which means "unbounded") is never pruned.

Source of truth in code: [`src/model/serialize.ts`](../../src/model/serialize.ts) (`omitEmpty`), applied at the two emit boundaries — [`src/cli/read-driver.ts`](../../src/cli/read-driver.ts) (`runRead`) and [`src/mcp/server.ts`](../../src/mcp/server.ts) (`readResult` / the truncated + grouped read results). Covered by `test/unit/serialize.test.ts` and the read-shape assertions in `test/cli/e2e.test.ts` / `test/mcp/server.test.ts`.

## Error-path universality (every refusal honors `--json`)

**Contract:** *every* error and refusal exit — not just mutation outcomes — respects `--json`. Under `--json` the `{ok:false, error}` envelope goes to **stdout** and nothing prose goes to stderr; without it, the `error:` prose line goes to **stderr**. Flag/argument usage errors route through one shared emitter (`usageError`, `src/cli/read-driver.ts`) so this holds uniformly; there is a single envelope shape (`error.details.candidates` / `error.details.suggestions`) — never a second one.

Machine-readable `error.details` is emitted wherever disambiguation is actionable:

| Error path | `error.code` | exit | `error.details` |
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

## Interaction rules

- **No interactive prompts, ever.** Risky operations require explicit acknowledgement flags (e.g. `--children auto-complete`, `--acknowledge-checklist-reset`), documented in each command's `--help`.
- Every write command's `--help` states its disruption tier, default vector, applicable hazard guards, and exact ack flag names.
- `--help` text is regression-tested output — it is the API contract agents discover the tool through.
