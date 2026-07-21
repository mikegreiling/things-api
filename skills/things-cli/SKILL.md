---
name: things-cli
description: Read and manage a user's tasks in the Things 3 app (macOS) through the `things` CLI — list views like Today/Inbox/Upcoming, search, and create, edit, schedule, complete, move, or organize to-dos, projects, areas, headings, and tags. Use whenever the user asks about their tasks, to-dos, projects, or anything in Things.
---

# Things CLI

`things` is a command-line interface to the user's Things 3 task database. Reads are instant SQL queries; writes go through the app itself and are verified after they land.

**Invoking it:** use `things` when it is on your PATH; otherwise substitute `npx -y things-api@latest` for `things` in every command below (identical subcommands and flags).

**Discovering commands:** `things --help` is the one-screen index. `things <group> --help` lists a group's verbs and their flags (the up-to-date mechanics for the binary you actually invoke). `things help <topic>` opens a contract guide — topics: `agent`, `filters`, `ids`, `output`, `repeating`, `writes`.

This skill carries the slow-moving truth — the data model, how to refer to items, and the stable contracts. Verbs, flags, and per-operation details live in `--help` and the topics above, so they stay correct even when the binary is newer than this skill.

## Data model (read this first)

- **To-do** — the basic item: title, notes, an optional **checklist** (sub-steps), tags, schedule, deadline, reminder. Has at most ONE container — loose in an **area**, directly in a **project**, or under a **heading** inside a project — or **none at all** (standalone to-dos are normal, like standalone projects).
- **Inbox** — not a container but the *untriaged state*: an inbox to-do has no container and no schedule. Filing it into a container or scheduling it moves it out of the Inbox; moving something back TO the Inbox un-files AND un-schedules it.
- **Project** — a goal-sized container of to-dos, optionally divided by **headings** (section labels; a heading belongs to one project and cannot hold projects). Projects live in an area or stand alone. Projects can also have their own notes, tags, schedule, and deadline.
- **Area** — a top-level bucket (e.g. a sphere of responsibility) holding projects and loose to-dos. Areas have tags but no dates.
- **Tags** — form a hierarchy, and are **inherited downward**: a to-do effectively carries its own tags plus those of its project and area. Headings carry no tags, but inheritance flows through them from project to to-do.
- **Views** are queries over this model, matching the app's sidebar: `inbox` (unsorted), `today` (scheduled for today, incl. This Evening), `upcoming` (future-dated), `anytime` (all active), `someday` (kept without a date), `logbook` (completed/canceled), `trash`.
- **Scheduling vocabulary**: an item's *when* is `today | evening | anytime | someday | YYYY-MM-DD` — where the item sits/starts. A **deadline** is a separate due date. A **reminder** is a separate time-of-day alert parameter — never write `date@time` into *when*.

## Referring to items

Commands take a `<ref>`: a UUID, a unique UUID prefix, or a (unique) title. Ambiguous refs fail with the candidates listed — pick one and retry. Discover UUIDs via any read command; add `--json` for stable machine output (UUIDs are in `.uuid`).

## Stable contracts

These hold regardless of the binary version; see [references/contracts.md](references/contracts.md) for the full text.

- **JSON envelope**: every `--json` response is `{ ok, data, meta }`. Read results from `.data` (usually `.data[]`), never `.items`; UUIDs are `.uuid`, not `.id`. Check `meta.truncation` before concluding "no match" or "that's everything". List/search rows are summaries whose `tags` may be incomplete — use `things show <ref> --json` for effective tags, checklist, and placement.
- **Exit codes**: `0` landed and verified · `2` usage error · `3` verify-failed (the change did NOT stick). A nonzero exit means the write did not silently take — read the message, it usually names the fix; you are not stuck.
- **Previews & reversal**: `--dry-run` shows the exact plan for any write without executing it; `things undo` reverses recent changes made through this tool.
- **Disruptive gate**: repeating and other disruptive operations require `--allow-disruptive`, INCLUDING their dry runs.
- **Preconditions**: referenced containers and tags must already exist — create nested structures outside-in and reuse each returned UUID.
- **Recurrence**: converting to a *fixed* repeater REPLACES the item, returning a `repeating` block — use `instanceUuid` to reach the visible occurrence and `templateUuid` for `reschedule-repeat`. Full vocabulary: `things help repeating`.
- **View reasoning from JSON**: `start:"inbox"`→Inbox, `start:"someday"`→Someday, `start:"active"` with no `startDate`→Anytime; a dated open item is Today when dated for `meta.clock.today`, else Upcoming. `todaySection` only marks placement within Today and is NOT evidence an undated item is in Today. Completed/canceled → Logbook, trashed → Trash, regardless of a stale `logged` field.
- If the user requests a JSON reply schema, return exactly that object after the read or verified write.

## Reading

Views and lookups — pass `--json` whenever you will act on the output: `things today | inbox | upcoming | anytime | someday | logbook | trash`, `things show <ref>` (full detail incl. notes + checklist + effective tags), `things projects [ref]`, `things areas [ref]`, `things tags`, `things search <words>`, `things changes --since <moment>`. Filters (`--tag`, `--untagged`, `--overdue`, `--limit N`, …) compose with AND — see `things help filters` and [references/model.md](references/model.md).

## Writing

Namespaced verb families — run `things <group> --help` for the verbs and `things <group> <verb> --help` for exact flags: `things todo …` (add/update/complete/cancel/reopen/move/delete/restore/tags/checklist/make-repeating), `things project …`, `things area …`, `things heading …`, `things tag …`, plus `things batch` (JSONL of many changes), `things undo`, and `things reorder`. The gating model, scheduling parameters, and per-verb preconditions are in `things help writes`, `things help repeating`, and [references/contracts.md](references/contracts.md).

## Going deeper

- [references/model.md](references/model.md) — the full data model, view-membership semantics, and filters.
- [references/contracts.md](references/contracts.md) — the JSON envelope, exit codes, safety/undo/ambiguity recovery, and the recurrence contract.
- [references/gui.md](references/gui.md) — how the user sees Things in the app (where results appear, what list rows show).
