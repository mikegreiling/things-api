# Stable contracts: envelope, exit codes, safety, recurrence

The apiVersion-stable contracts that hold regardless of which binary version you invoke. Mechanics — verbs, flags, per-operation preconditions — live in `things <group> --help` and `things help <topic>` and version with the binary; the contracts here do not.

## JSON envelope

Every `--json` response is an envelope `{ ok, data, meta }`:

- Results are in `.data` (usually `.data[]`), **never** `.items`. Item UUIDs are in `.uuid`, not `.id`.
- Check `meta.truncation` (and `meta.grouped`) before concluding "no match" or "that's everything": if `shown < total`, raise `--limit` or narrow the filter rather than assuming you saw everything.
- List/search rows are **summaries**: their `tags` field is not necessarily the complete effective set, and placement can be partial. Use `things show <ref> --json` when notes, checklist, placement, or inherited/effective tags matter.

## Exit codes (writes are verified after they land)

- `0` — the change landed and was verified.
- `2` — usage error: fix your invocation and retry.
- `3` — verify-failed: the change did NOT stick; the message carries the reason and usually the remediation.
- other — unexpected; stop and report.

A nonzero exit is informative, not a dead end — it means the write did not silently half-apply, so you are never left guessing whether it took. Read the message; it usually names the fix.

## Safety & recovery

- `--dry-run` previews the exact plan (operation, target, expected change) for ANY write without executing — use it for anything destructive, bulk, or unfamiliar.
- `things undo` reverses recent changes made through this tool (its own audit trail, not arbitrary app history). Prefer a targeted fix when you know it; undo is the safety net.
- Deletes are TRASHES: `todo delete` moves to Trash and is restorable (`todo restore`). Emptying the trash is permanent and requires explicit user intent — don't do it unless asked.
- Ambiguous refs FAIL with the candidates listed — retry with a UUID or a unique prefix. Never guess between candidates for a destructive action; inspect details or ask.
- Referenced containers and tags must already exist. Create nested structures **outside-in** (area → project → heading → to-do), and prefer each newly returned UUID as the next reference so duplicate titles cannot redirect placement.
- Some operations are disruptive (may move focus in the app) and require `--allow-disruptive`, **including their dry runs**. `things capabilities` lists each operation's support and any preconditions.
- If a request needs a capability the tool reports as unsupported, say so plainly rather than improvising through unrelated commands.

## Bulk creation (contract summary)

- **Several to-dos at once**: `things todo add "T1" "T2" "T3" [shared flags]`. Every shared flag (`--project`/`--area`/`--heading`/`--when`/`--tags`/`--deadline`/…) applies to each title; titles land in argument order. `--stdin` reads newline-delimited titles from stdin (blank lines skipped) instead of positional args (the two are mutually exclusive). `--id-only` prints exactly one uuid per line in creation order — pipe it to chain follow-up commands (mutually exclusive with `--json`).
- **One undo for the whole set**: a multi-title add runs as one unit. `--json` streams a per-line result plus a trailing `summary` line carrying a single `undoToken`; `things undo --txn <undoToken>` removes the whole skeleton at once. A single-title `add` is unchanged — it still returns the ordinary single mutation-result envelope.
- **New project with children**: `things project add "<title>" --todo "T1" --todo "T2" …` (`--todo` repeatable) seeds a project skeleton in one call.
- **Richer batches**: for per-item metadata that differs, or cross-item references (`tempId`/`$ref`), use `things batch` (JSONL) — same one-`undoToken` undo semantics.

## Batch (many changes at once)

`things batch` runs a JSONL script (one `{"op","params",…}` per line) sequentially and independently — no transactions; a failure does not roll back earlier lines. Three fields make multi-step work reliable:

- **`tempId` (chaining):** a line that CREATES something (a to-do, project, area, heading, repeater — never `tag.add`) can carry `"tempId":"proj1"`; a LATER line references that new uuid as `"$proj1"` in any id/container field. Dotted forms reach a repeater's parts: `"$proj1.instance"` (the visible occurrence), `"$proj1.replaced"` (the original). This is how you "create a project, then file to-dos into it" in one submission without knowing the uuid up front. Handles are `[A-Za-z0-9_-]{1,32}` and unique per batch; an unknown or forward `$ref` fails just that line.
- **`opId` (safe retry):** carry a stable `"opId"` per line so resubmitting a batch after an ambiguous failure does not double-create — a line matching an earlier success is reported `already-applied`, not re-run.
- **Undo the whole batch:** the trailing summary line returns `tempIdMapping` (handle → uuid) and `undoToken`; `things undo --txn <undoToken>` reverses the entire submission as one unit.

## Recurrence (contract summary)

Full rule vocabulary and worked examples: **`things help repeating`**. The stable contract:

- Turning an item into a **fixed** repeater REPLACES it: the original becomes a hidden template plus a fresh first occurrence, so its UUID changes. The response returns a `repeating` block — `instanceUuid` (the visible current occurrence; use it to reach the item), `templateUuid` (the recurring rule; use it for `reschedule-repeat`), and `replacedUuid` (the original). Use these rather than re-finding the item by title.
- `--after-completion` schedules the next occurrence N units after you complete the current one, and KEEPS the item's UUID.
- Repeating operations require `--allow-disruptive` (including dry runs) and a required `--interval <n>` alongside `--frequency` (`--interval 1` for every unit).
- New repeater: add the item first (`things todo add "<title>" --json`), then `things todo make-repeating <returned-uuid> --frequency <f> --interval 1 [--weekdays …] --allow-disruptive`.
- Multiple weekdays go in ONE rule (`--weekdays monday,thursday,friday`) — never create two repeaters for "every Thursday and Friday".
- `things show <ref> --json` on an occurrence exposes `repeating.templateUuid` — use it as the `<ref>` for `reschedule-repeat`.
