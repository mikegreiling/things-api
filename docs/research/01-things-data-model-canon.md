# Step 1 - Things Data Model Canon

## Scope and Confidence
- Scope: Things 3 terminology, entities, relationships, list semantics, and official workflow guidance.
- Confidence model: claims are either `Source-backed`, `Inferred`, or `Unknown`.
- Automation scope note: this document is product/data-model oriented; mutation limits are detailed in Step 3.

## Canonical Glossary

| Things term | Type | Definition | Relationships | Primary UI location(s) | Confidence |
|---|---|---|---|---|---|
| Inbox | System list | Unprocessed capture list for new to-dos. | Holds to-dos before clarification. | Sidebar > `Inbox` | Source-backed |
| Today | System list | Focus list for work intended today. Includes items manually added to Today and scheduled items due today. | Draws from to-dos/projects across areas/lists. | Sidebar > `Today` | Source-backed |
| This Evening | Today subgroup | Optional section at the bottom of Today for tasks intended for later in the day. | Subset of Today items; assigned via the same `When` picker/URL `when=evening`. | `Today` view | Source-backed |
| Upcoming | System list | Timeline/calendar-style view of scheduled items in future days. | Includes to-dos/projects with future `When` dates. | Sidebar > `Upcoming` | Source-backed |
| Anytime | System list/state | Active unscheduled work (not in Today, not future-dated, not Someday). | Default home for actionable but unscheduled tasks/projects. | Sidebar > `Anytime` | Source-backed |
| Someday | System list/state | Deferred incubator list for not-now tasks/projects. | Used for incubated actions/projects; may later be activated. | Sidebar > `Someday` | Source-backed |
| Later items | Project-view subgroup | Project-specific UI section for non-current child items below the active task list. | In observed UI, includes future-dated/scheduled items, repeating items, and Someday items; can be collapsed with `Hide later items`. | Project detail view | Inferred |
| Logbook | System list | Completed/canceled history. | Contains closed to-dos/projects after completion/cancelation. | Sidebar > `Logbook` | Source-backed |
| Tomorrow | System list shortcut | Filter/list for tomorrow's scheduled work. | Derived from `When` date. | URL list ID and UI list shortcuts | Source-backed |
| Deadlines | System list shortcut | Filter for items with deadlines. | Independent from `When`; used for hard due constraints. | URL list ID and UI smart list | Source-backed |
| Repeating | System list shortcut | View of repeating to-dos templates/instances. | Tied to recurring to-dos behavior. | URL list ID and UI smart list | Source-backed |
| All Projects | System list shortcut | Collection of active projects. | Project-level aggregation. | URL list ID and UI smart list | Source-backed |
| Logged Projects | System list shortcut | Completed/canceled projects in history. | Subset of Logbook for projects. | URL list ID and UI smart list | Source-backed |
| Area | Container | Top-level grouping for projects/to-dos, typically life/work responsibility domains. | Can contain projects and standalone to-dos; can have tags that are inherited by child projects/to-dos. | Sidebar user-defined areas | Source-backed |
| Project | Container + outcome | Multi-step outcome container. | May belong to an Area; contains to-dos and headings; supports tags and project notes/description context. | Sidebar within Area or root; project view | Source-backed |
| To-do | Action item | Atomic executable task. | Can be standalone, in Area, in Project, optionally under Heading; can include checklist items and tags. | Most lists/views and project views | Source-backed |
| Heading | In-project section | Structural section inside a project for grouping to-dos by phase/theme. | Lives inside Project; contains ordered to-dos. | Project detail view | Source-backed |
| Checklist | Sub-item list | Lightweight sub-steps inside a to-do. | Child list on a single to-do (not full to-dos). | To-do detail pane/card | Source-backed |
| Checklist item | Sub-item | Individual line item in checklist. | Child of a to-do checklist. | To-do detail pane/card | Source-backed |
| Tag | Metadata label | User-defined context labels (people/place/energy/etc.). | Applied to areas/projects/to-dos; supports parent-child hierarchy and inherited tags from area membership. | Tag browser/filter + item metadata | Source-backed |
| Deadline | Date field | Hard due-by date independent of schedule date. | On to-dos/projects; can coexist with `When`. | Item details and deadline-focused views | Source-backed |
| When | Date/state field | Scheduling field controlling visibility timing/state (`today`, `tomorrow`, specific date, `someday`, etc.). | Determines list placement across Today/Upcoming/Anytime/Someday. | Item details and date pickers | Source-backed |
| Start date | Alias/concept | Practical interpretation of `When` as the date work becomes active. | Same underlying field as `When`. | Not separately named in most UI copy | Inferred |
| Notes | Rich text field | Supporting details attached to to-dos/projects. | Child content on action/container records. | Item details | Source-backed |
| Repeating to-do | To-do subtype | Recurring action template/series that generates new instances over time. | Can repeat on fixed cadence or after completion/cancelation of previous instance; can include relative deadlines. | Repeating list, to-do scheduling UI | Source-backed |
| Status: open | State | Active, not completed/canceled. | Default lifecycle state. | Item visual state | Inferred |
| Status: completed | State | Finished work. | Moved to Logbook; used by repeating logic. | Item state + Logbook | Source-backed |
| Status: canceled | State | Explicitly dropped work. | Also appears in Logbook; can satisfy project closure rules with completed siblings. | Item state + Logbook | Source-backed |
| Label | Nomenclature alias | Not a first-class Things term in Things; equivalent concept in this system is `Tag`. | Local vocabulary alias only. | N/A | Inferred |

## Entity Relationships and Containment Rules

1. `Area` can contain `Project` and standalone `To-do` records.
2. `Project` can contain `To-do` and `Heading` records.
3. `Heading` can contain `To-do` records (within one project).
4. `To-do` can contain `Checklist item` records and can reference `Tag`, `When`, `Deadline`, and `Notes`.
5. `Tag` supports hierarchy (parent/child). Filtering by a parent tag includes items tagged with child tags.
6. Areas can carry tags, and area tags are inherited by child projects/to-dos.
7. Projects and to-dos can have direct tags in addition to inherited area tags.
8. Assignment to `Area` is optional for projects and to-dos (area-less records are allowed).

## UI Behavior and Lifecycle

### List placement model (`When` + state)
1. New items without future scheduling usually land in `Inbox` or `Anytime` based on capture path.
2. Setting `When` to `today` places item in `Today`.
3. Setting `When` to `evening` places the item in `Today`, but inside the separate `This Evening` section at the bottom of the list.
4. Setting a future `When` date places item in `Upcoming` until it becomes current.
5. Setting `When` to `someday` places item in `Someday`.
6. Completion or cancelation moves item to `Logbook`.
7. Within a project view, future-dated items, repeating items, and Someday items may appear together under a collapsible `later items` section rather than only through the global sidebar lists (`Inferred` from Step 3 validation).

### Project closure behavior
1. In the manual UI, completing a project with unresolved child to-dos prompts for how those children should be resolved.
2. In Step 3 validation, URL-based project completion auto-completed unresolved child to-dos in the tested no-heading case and preserved already-canceled children; heading/logged edge cases remain open.
3. Projects can carry notes that function as project-level context/description; in typical UI layout these notes appear above project to-dos (`Inferred` UI placement detail).

### Tag display and inheritance behavior
1. In observed UI behavior, tag badges shown directly next to a project or to-do represent only tags assigned directly to that record.
2. Inherited tags from ancestor areas/projects still affect native filtering behavior even when they are not rendered as badges on the child record.
3. Direct project tags do not automatically render next to child to-dos in list/project views.

### To-do promotion workflow
1. A to-do can be converted to a project in the UI.
2. When converted, checklist items on that to-do become to-dos in the new project.
3. Programmatic support for this conversion flow via URL scheme is `Unknown` (no dedicated conversion command is documented).

### Repeating behavior (conceptual)
1. Repeating to-dos can repeat on a fixed schedule or based on completion/cancelation of the previous instance.
2. Repeating to-dos support rich cadence options (for example, every N days/weeks/months, weekday-relative patterns).
3. Repeating to-dos can use relative deadlines (for example, due X days after the new instance appears).
4. Editing one instance can optionally propagate to future instances (UI-controlled behavior).
5. URL-scheme mutation for creating/editing recurrence rules remains unsupported in current docs (see Step 3).

### Ordering and organizing behavior
1. In the UI, areas, projects, to-dos, headings, and checklist items can be drag-and-drop reordered in their relevant views.
2. To-dos and projects are reorderable in key list contexts (Inbox, Today, Anytime, Someday, project views).
3. `This Evening` behaves as a distinct ordered subsection within `Today`, not as a heading or standalone list. Items can be moved between Today proper and This Evening through scheduling actions.
4. Headings are ordered sub-containers inside a project. A heading has its own position in the project, and its child to-dos have their own order within that heading.
5. In the observed project UI, scheduled/later items are grouped by day and appear sortable within their day grouping, but not freely draggable into the active anytime section.
6. Repeating items can appear interleaved with other later items inside the same date grouping in project views.
7. Programmatic reordering controls are not documented in URL scheme; this system should remain order-agnostic unless manual tests prove a reliable workaround.

### Checklist behavior
1. Checklist items are lightweight substeps, not full child tasks.
2. In Step 3 validation, unresolved checklist items did not control parent to-do resolution state.
3. Completed/canceled to-dos can contain unresolved checklist items without reopening.

## Official Workflow Guidance (Condensed)

1. Capture quickly into `Inbox`.
2. Clarify captured items into actionable to-dos or project outcomes.
3. Organize with Areas/Projects/Tags and date fields (`When`, `Deadline`).
4. Use `Today` for daily focus and `Upcoming` for forward visibility.
5. Keep incubated work in `Someday`.
6. Review in `Logbook` and project/list views for maintenance.

## Ambiguities and Unknowns

1. Programmatic support for to-do -> project conversion is not documented in URL scheme.
2. Exact internal ordering metadata and whether read APIs preserve full UI order semantics require validation against `things.py` and `things-mcp`.
3. When ordering keys (`index`, `todayIndex`) collide among peer items, the UI tie-break behavior remains explicitly unknown and may be view-specific.
4. Full object schema exposed by Things internal database is not officially documented by Cultured Code; third-party tooling infers it.
5. Operational behavior for repeating to-dos in third-party read APIs (`things.py`, MCP) requires verification in Step 3.

## Sources
- Cultured Code docs index: https://culturedcode.com/things/support/articles/
- Using tags: https://culturedcode.com/things/support/articles/2803574/
- Moving and organizing to-dos/projects: https://culturedcode.com/things/support/articles/2803577/
- Using headings: https://culturedcode.com/things/support/articles/2803575/
- Scheduling to-dos: https://culturedcode.com/things/support/articles/2803571/
- Repeating to-dos: https://culturedcode.com/things/support/articles/2803572/
- In-depth: Things Lists and default list IDs: https://culturedcode.com/things/support/articles/2803564/
- Guide (capture/organize workflow context): https://culturedcode.com/things/guide/
- URL scheme reference (for lifecycle constraints): https://culturedcode.com/things/support/articles/2803573/

_Last reviewed: 2026-03-03 (America/Chicago)_
