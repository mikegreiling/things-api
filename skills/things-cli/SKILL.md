---
name: things-cli
description: Read and manage a user's tasks in the Things 3 app (macOS) through the `things` CLI — list views like Today/Inbox/Upcoming, search, and create, edit, schedule, complete, move, or organize to-dos, projects, areas, headings, and tags. Use whenever the user asks about their tasks, to-dos, projects, or anything in Things.
version: 0.0.0-dev
---

# Things CLI

`things` is a command-line interface to the user's Things 3 task database. Reads are instant SQL queries; writes go through the app itself and are checked after they land. Use `things` when it is on your PATH; otherwise — or when `things --version` reports below **0.12.0** — substitute `npx -y things-api@latest` in every command (identical subcommands and flags), which always pairs the current commands with their current help.

`things --help` is the one-screen index; `things <group> --help` lists a group's verbs and flags (always current for the binary you invoke); `things help <topic>` opens a contract guide — topics: `agent`, `filters`, `ids`, `move`, `output`, `repeating`, `writes`.

## Data model (read this first)

- **To-do** — the basic item: title, notes, an optional **checklist** (sub-steps), tags, schedule, deadline, reminder. Has at most ONE container — loose in an **area**, directly in a **project**, or under a **heading** inside a project — or **none at all** (standalone to-dos are normal, like standalone projects).
- **Inbox** — not a container but the *untriaged state*: an inbox to-do has no container and no schedule. Filing it into a container or scheduling it moves it out of the Inbox; moving something back TO the Inbox un-files AND un-schedules it.
- **Project** — a goal-sized container of to-dos, optionally divided by **headings** (section labels; a heading belongs to one project and cannot hold projects). Projects live in an area or stand alone. Projects can also have their own notes, tags, schedule, and deadline.
- **Area** — a top-level bucket (e.g. a sphere of responsibility) holding projects and loose to-dos. Areas have tags but no dates, and never go to the Trash — deleting one is permanent.
- **Tags** — form a hierarchy, and are **inherited downward**: a to-do effectively carries its own tags plus those of its project and area. Headings carry no tags, but inheritance flows through them from project to to-do.
- **Views** are queries over this model, matching the app's sidebar: `inbox` (unsorted), `today` (scheduled for today, incl. This Evening), `upcoming` (future-dated), `anytime` (all active), `someday` (kept without a date), `logbook` (completed/canceled), `trash`.
- **Scheduling vocabulary**: an item's *when* is `today | evening | anytime | someday | YYYY-MM-DD`. A **deadline** is a separate due date; a **reminder** is a separate time-of-day alert — never write `date@time` into *when*.

## Reading position from JSON: `stage` and `when`

Reads decompose an item's position onto two derived, presence-keyed words (they REPLACED the old `start`/`logged`/`trashed`/`todaySection` fields):

- **`stage`** — the sidebar BUCKET: `inbox | upcoming | anytime | someday | logbook | trash`. Read view membership off it directly (a completed row is `logbook`, a trashed row `trash`, regardless of any other hint). Dropped only where a view provably states it — the stage-pure flat views (`inbox`/`anytime`/`someday`/`logbook`/`trash`) and the `today` view; KEPT everywhere it is stage-mixed — `upcoming`, `search`, `changes`, the projects/areas listings, the project/area card `items` (and the project `logbook`), and `detail`.
- **`when`** — the TIME POSITION: `today | evening | a future ISO date`, or absent. `evening` implies today; someday is a bucket (→ `stage`), never a `when`. A due deadline pulls an undated row into Today (`when: "today"`); the app re-files it into Anytime, so it derives `stage: "anytime"` (it leaves the Inbox/Someday list).
- **`provisional: true`** marks a Today member the app has not yet materialized (the "N new to-dos" banner / `•` pip); see [references/banner.md](references/banner.md).

**Absence is meaningful.** In the compact list tier a field at its default is omitted (no `status` = open, no `when` = not in Today), and inside a single-container node an item omits ancestry the node already states (absent `project`/`area` there = inherited). Full rules and the compact/full tiers: [references/model.md](references/model.md).

## Referring to items

Commands take a `<ref>`: a UUID, a unique UUID prefix (≥ 6 chars), a Things share link, a (unique) title, or a **decorated ref `Title [ref]`** (the bracketed uuid/partial-uuid resolves; the title is an ignored comment, so a stale copy still works). Ambiguous refs fail with the candidates listed, each rendered in the fused `Title [8charPrefix]` form you can paste straight back — pick one and retry ([references/errors.md](references/errors.md) has the candidate/dead-row/hazard contract). Discover UUIDs via any read command; add `--json` for stable machine output (UUIDs are in `.uuid`; emitted UUIDs are always full).

**Container refs and the `type` shorthand in `--json`.** A row's container ref (`area`/`project`/`heading`) is a bare **title string**; a flat sibling `areaUuid` / `projectUuid` / `headingUuid` appears **only when that title alone would not resolve back** to the exact same item (a duplicate title, or a title that shadows a UUID). **To act on a ref, pass `.areaUuid // .area`** (same for project/heading) — the uuid when present, else the title. For unattended pipelines or stored refs, use `--full` and key on the uuids (the full tier always emits the `*Uuid` siblings). And **absent `type` = to-do** — a row omits `type` when it is a to-do; it is present for `project`, `heading`, `area`, and `tag`.

## Stable contracts

These hold regardless of the binary version; see [references/contracts.md](references/contracts.md) for the full text.

- **JSON envelope**: every `--json` response is `{ apiVersion, ok, kind, data, meta }`. Read results from `.data` (`.data.items`/`.data.sections`/`.data.item`/`.data.view` per `kind`), never `.items`; UUIDs are `.uuid`, not `.id`. Check `meta.truncation.truncated` before concluding "no match" or "that's everything". List/search rows are compact summaries whose `tags` may be incomplete — use `things show <ref> --json` for effective tags, checklist, notes, and placement.
- **Exit codes**: `0` landed and checked · `2` usage · `3` verify-failed · `4` blocked · `5` drift-blocked · `6` unsupported · `7` environment (`1` is an internal bug). Nonzero means the change did NOT stick; the message names the fix.
- **Previews, undo & idempotency**: `--dry-run` is universal — accepted by every command, it guarantees nothing changes: on a read it returns the normal output unchanged, on a write it shows the exact plan without executing; `things undo` reverses recent changes made through this tool (each reversible write returns an `undoToken`); a single mutation may carry `--op-id <key>` so an ambiguous resubmission is recognized as already applied (the variadic `move`/`reorder` refuse it — use `things batch` with a per-line `opId`).
- **Preconditions**: referenced containers and tags must already exist — create nested structures outside-in and reuse each returned UUID.
- If the user requests a JSON reply schema, return exactly that object after the read or checked write.

## Reading

Views and lookups — pass `--json` whenever you will act on the output: `things today | inbox | upcoming | anytime | someday | logbook | trash`, `things show <ref>` (full detail incl. notes + checklist + effective tags), `things projects [ref]`, `things areas [ref]`, `things tags`, `things search <words>`, `things changes --since <moment>`. Compact rows carry `hasNotes`, `checklist:{open,total}` (to-dos), and `todos:{open,total}` (projects); `--full` (or `show`) adds the full `notes`, `startDate`, and checklist `items`. A `search` hit carries `match:{field,text}` provenance when it matched something other than the title. Filters (`--tag`, `--untagged`, `--overdue`, `--limit N`, `--all`, …) compose with AND — see `things help filters`. The reserved read-only ref `loose` addresses the area-less items as a pseudo-area (`areas loose`, `area show loose`, `--area loose`) and wins over any real area named "Loose"; every write verb refuses it.

## Writing

Namespaced verb families — run `things <group> --help` for the verbs and `things <group> <verb> --help` for exact flags: `things todo …` (add/update/complete/cancel/reopen/move/delete/restore/tags/checklist/make-repeating), `things project …` (add/update/move/complete/… plus the heading verbs), `things area …`, `things tag …`, plus `things batch` (JSONL — chain created uuids across lines with `tempId`/`$ref`, retry safely with `opId`, undo the whole run with its `undoToken`), `things undo`, and `things reorder`.

**Scheduling is an update, not a move**: `things todo update <ref> --when today|evening|anytime|someday|YYYY-MM-DD` schedules or parks an item; `move` changes its CONTAINER only.

**Move vs reorder — keep them apart** (`things help move`). MOVE changes WHAT an item belongs to: `things todo move <refs…> --to-project|--to-heading|--to-area <ref>`, or the detach family `--no-heading` / `--loose` / `--inbox`; `things project move <refs…> --to-area <ref>|--no-area`. REORDER changes only ARRANGEMENT in place, never membership: `things reorder <refs…> [--first|--last|--before <ref>|--after <ref>] [--in <target>]`. Both are variadic (selection order = landing order). An anchor POSITIONS but never MIGRATES — a cross-container/bucket anchor fails closed. A Today/Evening member sits on two axes (its Today slot and its container slot); a set coherent on both is REFUSED until you pass `--in` (`today|evening|anytime|someday|inbox`, or a project/area/heading ref). Every non-template item is sortable; the axes, gates, and automatic fallbacks are in [references/ordering.md](references/ordering.md). (MCP exposes these as the `reorder` and `reorder_areas` tools.)

**Guarded writes** surface their consequence and require an explicit flag: deleting a NON-EMPTY area needs `--allow-non-empty`, a permanent delete needs `--dangerously-permanent`, and a UI-driving op (e.g. `area reorder`) needs `--dangerously-drive-gui` plus `things config set ui-enabled true`. The full acknowledgment contract is in [references/errors.md](references/errors.md).

**Quick skeletons**: `things todo add "T1" "T2" "T3" [shared flags]` creates several to-dos in one call (every shared flag — `--project`/`--area`/`--when`/`--tags`/… — applies to each; `--id-only` prints the new uuids one per line for chaining; one `undoToken` removes the set). To stand up a new project with children, `things project add "<title>" --todo "T1" --todo "T2" …` (repeatable). For richer per-item metadata or cross-item references, use `things batch`.

## Going deeper

- [references/model.md](references/model.md) — the full data model, `stage`/`when` derivation, the compact/full tiers, view membership, and filters.
- [references/contracts.md](references/contracts.md) — the JSON envelope, exit codes, safety/undo/idempotency, batch chaining, and recurrence.
- [references/ordering.md](references/ordering.md) — move vs reorder in depth: axes, gates, caps, automatic fallbacks, placement guarantees, and the one dead class (templates).
- [references/errors.md](references/errors.md) — the error contract: the candidate shape, dead-row hints, hazard acknowledgments, and the error-code registry.
- [references/banner.md](references/banner.md) — the Today "new to-dos" banner, the provisional `•` pip, reminder/evening liveness, and what a watcher sees.
- [references/gui.md](references/gui.md) — how the user sees Things in the app (where results appear, what list rows show).
