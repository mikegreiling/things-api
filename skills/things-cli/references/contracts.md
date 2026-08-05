# Stable contracts: envelope, exit codes, safety, recurrence

The apiVersion-stable contracts that hold regardless of which binary version you invoke. Mechanics — verbs, flags, per-operation preconditions — live in `things <group> --help` and `things help <topic>` and version with the binary; the contracts here do not.

## JSON envelope

Every `--json` response is an envelope `{ apiVersion, ok, kind, data, meta }`:

- Results are in `.data`, in exactly one of five wrappers named by `kind`: `.data.item` (one entity), `.data.view` (an area/project card), `.data.items` (a flat list), `.data.sections` (a list split into named sections), or `.data.children` (the `today` view's two keyed buckets `{ today: {items, total?}, evening: {items, total?} }`). Never `.items` at the top level. Item UUIDs are in `.uuid`, not `.id`; emitted UUIDs are always full. The `today` view's whole-view count rides `meta.counts` (`{dueOrOverdue, other}`), not `data`.
- **Container refs and `type`.** A row's `area`/`project`/`heading` is a bare **title string**; a flat sibling `areaUuid`/`projectUuid`/`headingUuid` appears **only when that title would not resolve back** to the exact same item. **To act on a ref, pass `.areaUuid // .area`** (same for project/heading). For unattended pipelines or stored refs, use `--full` and key on uuids (the full tier always emits the `*Uuid` siblings). **Absent `type` = to-do** — `type` is present only for a `project`, `heading`, `area`, or `tag` ROW/candidate (a `project show` `headings[]` entry drops it — its slot already states it is a heading, and it emits a presence-keyed **`archived`** — the archive timestamp, present iff archived — instead of any status/stage; a heading is archive/unarchive only, never completed/canceled). **A `project show` view is `data.view = { project, children, headings[] }`** (read-shape v2): `children` is the un-headed body's stage buckets `{ anytime: {items, total?}, upcoming: [{when, items, total?} …], someday: {items, total?}, logbook: {items, total?} }` (the `upcoming` day-block array ends with a `{when: null, items}` resting block when a container holds date-less recurring templates); `headings[]` is EVERY heading in order — open, archived-unswept, AND archived-swept — each `{ uuid, title, archived?, children }` with the same recursive `children`. A swept heading's logged children ride ITS `children.logbook`; there is no `logbookHeadings` and no root `logbook` (the GUI's merged logbook region is TTY-only).
- Check `meta.truncation.truncated` before concluding "no match" or "that's everything": it is `true` exactly when any row was hidden (`shown < total`, or any grouped block capped). Raise `--limit`/`--all` or narrow the filter rather than assuming you saw everything.
- List/search rows are compact **summaries**: their `tags` field is not necessarily the complete effective set, and placement can be partial. Use `things show <ref> --json` when notes, checklist, placement, or inherited/effective tags matter.

## Exit codes (writes are verified after they land)

A value once assigned keeps its meaning forever — the codes are never renumbered.

- `0` — the change landed and was verified.
- `1` — unexpected (an internal error / bug): stop and report.
- `2` — usage error: fix your invocation and retry.
- `3` — verify-failed: the change did NOT stick; the message carries the reason and usually the remediation.
- `4` — blocked: refused before it touched the app (a guard/hazard, scope, lock, …); the message names the flag or fix.
- `5` — drift-blocked: the database schema fingerprint no longer matches; writes are held until re-certified.
- `6` — unsupported: no available write surface performs this operation.
- `7` — environment: database not found, Things not installed, or a permission problem.

A nonzero exit is informative, not a dead end — it means the write did not silently half-apply, so you are never left guessing whether it took. Read the message; it usually names the fix. The error `code`, the candidate/dead-row contract, and the hazard acknowledgments are in [errors.md](errors.md).

## Safety & recovery

- `--dry-run` previews the exact plan (operation, target, expected change) for ANY write without executing — use it for anything destructive, bulk, or unfamiliar.
- `things undo` reverses recent changes made through this tool (its own audit trail, not arbitrary app history). Prefer a targeted fix when you know it; undo is the safety net.
- To-do/project deletes are TRASHES: `todo delete` moves to Trash and is restorable (`todo restore`). Emptying the trash is permanent and requires explicit user intent — don't do it unless asked. AREAS are the exception — an area does not go to the Trash, so deleting one is permanent (`--dangerously-permanent`), and a non-empty area also needs `--allow-non-empty` (see [errors.md](errors.md)).
- Ambiguous refs FAIL with the candidates listed — retry with a UUID or a unique prefix. Never guess between candidates for a destructive action; inspect details or ask. The full candidate shape and dead-row hints are in [errors.md](errors.md).
- Referenced containers and tags must already exist. Create nested structures **outside-in** (area → project → heading → to-do), and prefer each newly returned UUID as the next reference so duplicate titles cannot redirect placement.
- Some operations are disruptive and require an explicit flag, **including their dry runs**: `--allow-disruptive` permits an op that briefly steals window focus; an op that visibly DRIVES the Things UI needs both `--allow-disruptive` and `--allow-very-disruptive` (the two-key gate). `things capabilities` lists each operation's support and any preconditions.
- If a request needs a capability the tool reports as unsupported, say so plainly rather than improvising through unrelated commands.

## Bulk creation (contract summary)

- **Several to-dos at once**: `things todo add "T1" "T2" "T3" [shared flags]`. Every shared flag (`--project`/`--area`/`--heading`/`--when`/`--tags`/`--deadline`/…) applies to each title; titles land in argument order. `--stdin` reads newline-delimited titles from stdin (blank lines skipped) instead of positional args (the two are mutually exclusive). `--id-only` prints exactly one uuid per line in creation order — pipe it to chain follow-up commands (mutually exclusive with `--json`).
- **One undo for the whole set**: a multi-title add runs as one unit. `--json` streams a per-line result plus a trailing `summary` line carrying a single `undoToken`; `things undo --txn <undoToken>` removes the whole skeleton at once. A single-title `add` is unchanged — it still returns the ordinary single mutation-result envelope.
- **New project with children**: `things project add "<title>" --todo "T1" --todo "T2" …` (`--todo` repeatable) seeds a project skeleton in one call.
- **Richer batches**: for per-item metadata that differs, or cross-item references (`tempId`/`$ref`), use `things batch` (JSONL) — same one-`undoToken` undo semantics.

## Batch (many changes at once)

`things batch` runs a JSONL script (one `{"op","params",…}` per line) sequentially and independently — no transactions; a failure does not roll back earlier lines. Three fields make multi-step work reliable:

- **`tempId` (chaining):** a line that CREATES something (a to-do, project, area, heading, repeater — never `tag.add`) can carry `"tempId":"proj1"`; a LATER line references that new uuid as `"$proj1"` in any id/container field. Dotted forms reach a repeater's parts: `"$proj1.instance"` (the visible occurrence), `"$proj1.replaced"` (the original). This is how you "create a project, then file to-dos into it" in one submission without knowing the uuid up front. Handles are `[A-Za-z0-9_-]{1,32}` and unique per batch; an unknown or forward `$ref` fails just that line.
- **`opId` (safe retry):** carry a stable `"opId"` per line so resubmitting a batch after an ambiguous failure does not double-create — a line matching an earlier success is reported `already-applied`, not re-run. The single-op analogue is `--op-id <key>` (MCP `op_id`) on ONE mutation: a resubmission with a matched key returns the original success (`alreadyApplied: true`, the original `uuid`/`undoToken`) instead of running again. The variadic `move`/`reorder` are multi-leg compounds and REFUSE `--op-id` — express their idempotency as `things batch` with a per-line `opId`.
- **Undo the whole batch:** the trailing summary line returns `tempIdMapping` (handle → uuid) and `undoToken`; `things undo --txn <undoToken>` reverses the entire submission as one unit.

## Recurrence (contract summary)

Full rule vocabulary and worked examples: **`things help repeating`**. The stable contract:

- Turning an item into a **fixed** repeater REPLACES it: the original becomes a hidden template plus a fresh first occurrence, so its UUID changes. The response returns a `repeating` block — `instanceUuid` (the visible current occurrence; use it to reach the item), `templateUuid` (the recurring rule; use it for `reschedule-repeat`), and `replacedUuid` (the original). Use these rather than re-finding the item by title.
- `--after-completion` schedules the next occurrence N units after you complete the current one, and KEEPS the item's UUID.
- Repeating operations require `--allow-disruptive` (including dry runs) and a required `--interval <n>` alongside `--frequency` (`--interval 1` for every unit).
- New repeater: add the item first (`things todo add "<title>" --json`), then `things todo make-repeating <returned-uuid> --frequency <f> --interval 1 [--weekdays …] --allow-disruptive`.
- Multiple weekdays go in ONE rule (`--weekdays monday,thursday,friday`) — never create two repeaters for "every Thursday and Friday".
- `things show <ref> --json` on an occurrence exposes `repeating.templateUuid` — use it as the `<ref>` for `reschedule-repeat`.
