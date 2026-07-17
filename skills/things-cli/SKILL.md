---
name: things-cli
description: Read and manage a user's tasks in the Things 3 app (macOS) through the `things` CLI — list views like Today/Inbox/Upcoming, search, and create, edit, schedule, complete, move, or organize to-dos, projects, areas, headings, and tags. Use whenever the user asks about their tasks, to-dos, projects, or anything in Things.
---

# Things CLI

`things` is a command-line interface to the user's Things 3 task database. Reads are instant SQL queries; writes go through the app itself and are verified after they land. Every command supports `--help`; `things --help` is a one-screen index and `things help <topic>` has guides (`filters`, `ids`, `output`, `writes`).

## Data model (read this first)

- **To-do** — the basic item: title, notes, an optional **checklist** (sub-steps), tags, schedule, deadline, reminder. Lives in exactly one place: the **Inbox** (unsorted), loose in an **area**, directly in a **project**, or under a **heading** inside a project.
- **Project** — a goal-sized container of to-dos, optionally divided by **headings** (section labels; a heading belongs to one project and cannot hold projects). Projects live in an area or stand alone. Projects can also have their own notes, tags, schedule, and deadline.
- **Area** — a top-level bucket (e.g. a sphere of responsibility) holding projects and loose to-dos. Areas have tags but no dates.
- **Tags** — form a hierarchy, and are **inherited downward**: a to-do effectively carries its own tags plus those of its project and area. Headings carry no tags, but inheritance flows through them from project to to-do.
- **Views** are queries over this model, matching the app's sidebar: `inbox` (unsorted), `today` (scheduled for today, incl. This Evening), `upcoming` (future-dated), `anytime` (all active), `someday` (kept without a date), `logbook` (completed/canceled), `trash`.
- **Scheduling vocabulary**: an item's *when* is `today | evening | anytime | someday | YYYY-MM-DD` — where the item sits/starts. A **deadline** is a separate due date. A **reminder** is a separate time-of-day alert parameter — never write `date@time` into *when*.

## Referring to items

Commands take a `<ref>`: a UUID, a unique UUID prefix, or a (unique) title. Ambiguous refs fail with the candidates listed — pick one and retry. Discover UUIDs via any read command; add `--json` for stable machine output.

## Reading

`things today` / `inbox` / `upcoming` / `anytime` / `someday` / `logbook` / `trash`; `things show <ref>` (details incl. notes + checklist), `things projects [ref]`, `things areas [ref]`, `things tags`, `things search <words>`, `things changes --since <when>`. Common filters: `--tag <name>`, `--untagged`, `--overdue`, `--limit N`. Always prefer `--json` when you will act on the output.

## Writing

Namespaced verbs: `things todo add|update|complete|cancel|reopen|move|delete|restore|tags|checklist ...`, `things project add|update|complete ...`, `things area ...`, `things tag ...`, `things heading add ...`, plus `things batch` (many changes from JSONL), `things undo`, `things reorder`. Rules that matter:

- Referenced containers/tags must already exist (create them first, or pass `--create-tags` where offered).
- `--dry-run` on any write shows the exact plan without executing — use it when unsure.
- Writes are verified; a nonzero exit means the change did NOT stick (exit 2 = usage error, exit 3 = verify failed). Read the error: it usually names the fix.
- `things capabilities` lists what each operation supports; `things undo` reverses recent changes made through this tool.

## Going deeper

- [references/data-model.md](references/data-model.md) — the full model and relationships
- [references/reads.md](references/reads.md) — views, filters, JSON output
- [references/writes.md](references/writes.md) — operation patterns, scheduling, tags, checklists
- [references/recurrence.md](references/recurrence.md) — repeating to-dos and projects, incl. multi-rule patterns
- [references/safety-and-recovery.md](references/safety-and-recovery.md) — dry-run, undo, errors, ambiguity
- [references/gui.md](references/gui.md) — how the user sees Things in the app (where results appear, what list rows show)
