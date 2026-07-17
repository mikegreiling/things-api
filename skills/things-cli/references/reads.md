# Reading: views, filters, output

## Views

`things inbox|today|upcoming|anytime|someday|logbook|trash` mirror the app's sidebar views (see [data-model.md](data-model.md) for what qualifies for each). `things today` includes the This Evening section. `things projects`/`areas`/`tags` list containers; `things projects <ref>` / `things areas <ref>` / `things show <ref>` show one item's full detail — notes, checklist, effective tags — which list rows do NOT display.

## Filters (compose with AND)

- `--tag <name>` (repeatable), `--untagged`, `--exact-tag` — tag matching; in single-container views (`project show` / `area show`) `--tag` matches the row's own tags, in flat views it includes inherited tags.
- `--overdue` — open items whose deadline is before today.
- `--limit N`, `--since/--until` where offered.

## Search & change tracking

- `things search <words>` — title/notes match over open items; widen with `--all`, `--logged`, `--trashed`; narrow with `--type project` etc.
- `things changes --since <moment>` — what was created/changed since then (the pull-based substitute for a watch mode).

## Output

Human output is a formatted list (symbols legend: `things legend`). For machine use ALWAYS pass `--json`: a stable envelope `{ ok, data, meta }` with truncation metadata (`meta.truncation` / `meta.grouped`) — if `shown < total`, there are more rows; raise `--limit` or narrow the filter rather than assuming you saw everything.
