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
