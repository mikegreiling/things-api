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

Not covered by this contract (own shapes, unchanged): the **error envelope** (`error.code` / `error.details.candidates` / `error.details.suggestions` — a candidate entity is NOT pruned), **mutation results / plans** (`kind: "mutation-result"`, dry-run plans), and the non-entity diagnostic payloads (`doctor`, `capabilities`, `config`, `legend`, `setup`). The envelope `meta` (including `pagination.limit: null`, which means "unbounded") is never pruned.

Source of truth in code: [`src/model/serialize.ts`](../../src/model/serialize.ts) (`omitEmpty`), applied at the two emit boundaries — [`src/cli/read-driver.ts`](../../src/cli/read-driver.ts) (`runRead`) and [`src/mcp/server.ts`](../../src/mcp/server.ts) (`readResult` / the paginated + grouped read results). Covered by `test/unit/serialize.test.ts` and the read-shape assertions in `test/cli/e2e.test.ts` / `test/mcp/server.test.ts`.

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
