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
- A heading is a section label inside one project — not a task. It cannot be scheduled or tagged, and its lifecycle is **archive/unarchive ONLY** — a heading is never completed or canceled (it has no canceled state). In a `project show` view every heading (live and archived) is an entry in the flat `headings` catalog `{uuid, title, archived?}` — it carries no `status`/`stage`, and emits a presence-keyed **`archived`** (the ISO archive timestamp) when archived, absent when open. A heading's members are not nested under it: they ride the flat `items` (live children) and `logbook` (logged children) rows as a `heading` ref, so you reconstruct a heading's contents by filtering those lists on the ref. Deleting/archiving a heading affects only the label, per the operation's contract.
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

### Reading view membership from JSON — `stage` and `when`

Reads decompose an item's position onto two derived, presence-keyed words (they REPLACED the old `start`/`startDate`/`logged`/`trashed`/`todaySection` wire fields, which no longer appear):

- **`stage`** — the sidebar BUCKET: `inbox | upcoming | anytime | someday | logbook | trash`. Read view membership off it directly. It is dropped inside a section/catalogue that provably states it (the stage-pure `inbox`/`anytime`/`someday`/`logbook`/`trash` lists and the `today` view) and kept everywhere it is stage-mixed (the mixed `upcoming` catalogue, `search`, `changes`, the projects/areas listings, the project/area card `items` and the project `logbook`, and `detail`).
- **`when`** — the TIME POSITION: `today | evening | a future ISO date`, or absent (unscheduled and not in Today). `evening` implies today. Someday is a bucket, never a `when`. The `today` view is one flat `data.items` list (no `sections`); each row's `when` marks Today-proper vs This-Evening, and the whole-view count rides `meta.counts` (`{dueOrOverdue, other}`).
- The two are DIFFERENT facts. A due deadline pulls an UNDATED row into Today: it reads `when: "today"` and derives `stage: "anytime"` — the app re-files a deadline-pulled Inbox/Someday row into Anytime at pull time (R13/BANNER1b), so it drops out of the Inbox/Someday lists and joins Anytime while its `when` reads `today`. Completed/canceled → `stage: "logbook"`, trashed → `stage: "trash"`, regardless of any other hint.
- `provisional: true` marks a Today member the app has not yet materialized — see [banner.md](banner.md).

## Tiers — compact vs full (absence is meaningful)

Every row comes back at one of two densities, selected by view kind + flag, never by a caller-supplied field list:

- **Compact** (the list default) keeps identity + structural + non-default facts. A field at its default is OMITTED, so absence = the default: no `status` = open, no `checklist` = none, no `todos` = no child to-dos, no `when` = not in Today and unscheduled, no `provisional` = materialized. The full `notes` string is dropped and replaced by presence-keyed `hasNotes: true`; `startDate`, `created`, and `modified` are dropped.
- **Full** (`show`/`detail`, or a list forced with `--full`) is the whole record — the complete `notes`, the raw `startDate` substrate behind `when`, the checklist `items` array, and timestamps.
- Compact rows still carry the useful summaries: `checklist:{open,total}` on a to-do, `todos:{open,total}` on a project (app-maintained leaf-action counts — never headings, checklist items, or trashed rows), and `match:{field,text}` on a `search` hit whose match was NOT the title (`field` ∈ `heading | notes | checklist`).
- **Container absence rule:** inside a single-container node (a project/area card, an `anytime`/`someday` section) an item omits any ancestry the node already states, so absent `project`/`area` there means *inherited from the enclosing node*. A mixed list (`inbox`/`today`/`search`/`changes`) still names each row's own `project`/`area` (the `heading` ref is compact-dropped outside a project view; `--full` keeps it). **The project view is the exception where a `heading` ref is self-describing state:** a project-view row (the flat `items`, and a `logbook` row) that lives under a heading KEEPS its `heading` ref even in compact, because membership is a per-row attribute, not a bucket — so a swept child of an ARCHIVED heading is a flat `logbook` row carrying its `heading` ref (no more nested group). **Two-view sublabel asymmetry:** that in-project `logbook` row's `heading` labels the HEADING, while the same row in the GLOBAL `logbook` view is labeled by its PROJECT instead.
- **Container ref shape:** a container ref is a bare **title string** (`"area": "Family"`, `"project": "Groceries"`, `"heading": "Backlog"`). A flat sibling `areaUuid` / `projectUuid` / `headingUuid` (the full uuid) rides alongside **only when the bare title would not resolve back** to that exact item — a duplicate title in the same resolution scope, or a title that is itself a valid uuid prefix. **To act on a ref, pass `.areaUuid // .area`** (same for project/heading): the uuid when present, else the title. For unattended pipelines or stored refs, use `--full` and key on the uuids — the full tier emits every `*Uuid` sibling unconditionally. A row whose container project is a repeating template carries a flat `projectIsTemplate: true` (the JSON twin of the TTY `↻` glyph) — acting on such a row edits the blueprint, affecting future occurrences, so target the intended copy via `projectUuid` (a same-titled occurrence exists alongside the hidden template).
- **`type` is presence-keyed:** **absent `type` = to-do.** A row omits `type` when it is a to-do; `type` is present for a `project`, `heading`, `area`, or `tag` ROW (including in the error `candidates` shape). This is scoped to ROWS/candidates — a positional keyed sub-object whose kind is fixed by its slot (a `project show` heading GROUP node) drops `type` too, since its position already states it is a heading.

## Filters over views

Read filters compose with AND: `--tag <name>` (repeatable) / `--untagged` / `--exact-tag` for tags (in single-container `project show` / `area show` these match the row's own tags; in flat views they include inherited tags), `--overdue` (open items whose deadline is before today), `--limit N`, and `--since`/`--until` where offered. `things search <words>` matches title/notes over open items — widen with `--all`, `--logged`, `--trashed`; narrow with `--type project`. `things changes --since <moment>` is the pull-based substitute for a watch mode. Exact flags per command: `things <group> --help` and `things help filters`.
