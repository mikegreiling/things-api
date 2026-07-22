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

## Recurrence (contract summary)

Full rule vocabulary and worked examples: **`things help repeating`**. The stable contract:

- Turning an item into a **fixed** repeater REPLACES it: the original becomes a hidden template plus a fresh first occurrence, so its UUID changes. The response returns a `repeating` block — `instanceUuid` (the visible current occurrence; use it to reach the item), `templateUuid` (the recurring rule; use it for `reschedule-repeat`), and `replacedUuid` (the original). Use these rather than re-finding the item by title.
- `--after-completion` schedules the next occurrence N units after you complete the current one, and KEEPS the item's UUID.
- Repeating operations require `--allow-disruptive` (including dry runs) and a required `--interval <n>` alongside `--frequency` (`--interval 1` for every unit).
- New repeater: add the item first (`things todo add "<title>" --json`), then `things todo make-repeating <returned-uuid> --frequency <f> --interval 1 [--weekdays …] --allow-disruptive`.
- Multiple weekdays go in ONE rule (`--weekdays monday,thursday,friday`) — never create two repeaters for "every Thursday and Friday".
- `things show <ref> --json` on an occurrence exposes `repeating.templateUuid` — use it as the `<ref>` for `reschedule-repeat`.
