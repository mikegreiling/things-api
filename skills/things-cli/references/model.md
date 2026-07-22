# The Things data model (deep reference)

Entities, relationships, and how the sidebar views are computed over them, as exposed by the `things` CLI. The SKILL.md "Data model" section is the summary; this is the full version.

## Entities

| Entity | Container | Can contain | Dates | Tags |
| --- | --- | --- | --- | --- |
| To-do | area, project, heading, or NONE (standalone) | checklist items | when, deadline, reminder | own + inherited |
| Checklist item | its to-do | — | — | — |
| Heading | its project | to-dos | — | none (inheritance passes through) |
| Project | area or standalone | headings, to-dos | when, deadline | own + inherited from area |
| Area | top level | projects, loose to-dos | — | own |
| Tag | tag hierarchy (may nest) | child tags | — | — |

## Rules

- A to-do has at most ONE container, and may have none — standalone to-dos (no project, no area) are normal and appear at the top level of Anytime/Someday/Upcoming. Moving changes the container; completing or trashing does not.
- The **Inbox is a state, not a container**: "in the Inbox" means untriaged — no container AND no schedule. Filing or scheduling an inbox to-do moves it out (filing promotes it to Anytime); moving a to-do TO the Inbox clears both its container and its schedule.
- A heading is a section label inside one project — not a task. It cannot be scheduled, tagged, or completed; deleting/archiving it affects only the label, per the operation's contract.
- Tag inheritance flows downward: area → project → (through heading) → to-do. A to-do's *effective* tags = own tags ∪ project tags ∪ area tags. List output distinguishes own vs inherited tags.
- **Status**: open → completed or canceled (both land in the Logbook) or trashed (Trash; restorable until emptied). Reopen brings a logged item back.
- **when** (`today | evening | anytime | someday | YYYY-MM-DD`) controls which view an item appears in; **deadline** is an independent due date shown alongside the item; **reminder** is a time-of-day alert attached to a dated when.
- "Overdue" = open with a deadline strictly before today (a deadline of today is "due", not overdue).

## Views (queries over the model)

`things inbox|today|upcoming|anytime|someday|logbook|trash` mirror the app's sidebar. Each is a query over the rules above, not a stored list:

- **inbox** — untriaged to-dos (no container, no schedule).
- **today** — items scheduled for today, with the **This Evening** section beneath.
- **upcoming** — future-dated items, forward-ordered by date.
- **anytime** — all active items kept without a specific date (standalone or filed).
- **someday** — items deliberately kept without a date.
- **logbook** — completed/canceled items.
- **trash** — trashed items (restorable until the trash is emptied).

`things projects`/`areas`/`tags` list containers; `things projects <ref>` / `things areas <ref>` / `things show <ref>` show one item's full detail — notes, checklist, effective tags — which the compact list rows do NOT display.

### Reading view membership from JSON

When reasoning about which view an item belongs to from `--json`, key on the fields together, not on a single hint:

- `start: "inbox"` → Inbox; `start: "someday"` → Someday; `start: "active"` with no `startDate` → Anytime.
- A dated open item belongs to **Today** when dated for `meta.clock.today`, otherwise **Upcoming** when future-dated.
- `todaySection` only describes placement WITHIN Today (e.g. `evening`); it is NOT evidence that an undated item is in Today.
- Completed/canceled items are in the Logbook and trashed items in Trash, regardless of a stale-looking `logged` field.

## Filters over views

Read filters compose with AND: `--tag <name>` (repeatable) / `--untagged` / `--exact-tag` for tags (in single-container `project show` / `area show` these match the row's own tags; in flat views they include inherited tags), `--overdue` (open items whose deadline is before today), `--limit N`, and `--since`/`--until` where offered. `things search <words>` matches title/notes over open items — widen with `--all`, `--logged`, `--trashed`; narrow with `--type project`. `things changes --since <moment>` is the pull-based substitute for a watch mode. Exact flags per command: `things <group> --help` and `things help filters`.
