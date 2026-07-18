# Writing: creating and changing items

Every write verb lives under its noun: `things todo <verb>`, `things project <verb>`, `things area <verb>`, `things tag <verb>`, `things heading <verb>`. Run `things <noun> --help` for the verb list and `things <noun> <verb> --help` for exact flags. Cross-cutting: `things batch` (JSONL script of many changes), `things undo`, `things reorder`.

## Patterns

- **Create**: `things todo add "<title>"` with optional `--notes`, `--when <today|evening|anytime|someday|YYYY-MM-DD>`, `--deadline YYYY-MM-DD`, `--reminder HH:MM`, `--tag <name>`, placement flags (project/area/heading). Same shape for `project add`, `area add`, `tag add`, `heading add`. Resolve relative weekdays to `YYYY-MM-DD` before invoking the CLI; weekday phrases are not `--when` or `--deadline` values.
- **Change**: `todo update <ref>` (title/notes/schedule), `todo tags <ref>` (retag), `todo checklist <ref>` (edit checklist items), `todo move <ref>` (re-container), `todo complete|cancel|reopen|delete|restore <ref>`. To file a to-do loose in an area, use `things todo move <ref> --area <area-ref>`.
- **Placement**: a to-do goes to the inbox by default; use the placement flags to land it in a project, under a heading, or loose in an area. The target must already exist — create nested structures outside-in: `things project add "<project>" --area <area-ref>`, then `things heading add "<heading>" --project <project-ref>`, then `things todo add "<title>" --heading <heading-ref>`. Prefer each newly returned UUID as the next reference so duplicate titles cannot redirect placement.
- **Tags**: referenced tags must exist unless the command offers `--create-tags`.
- **Scheduling**: *when*, *deadline*, and *reminder* are three separate parameters — see [data-model.md](data-model.md). Never combine date and time in one value.

## Contract

- `--dry-run` previews the exact plan without touching the app.
- Exit 0 = verified success. Exit 2 = usage error (fix the invocation). Exit 3 = the write did not verify — the change did NOT stick; the message explains why and usually names the remediation.
- Some operations are disruptive (may move focus in the app) and require `--allow-disruptive`; `things capabilities` shows each operation's support and hazard notes.
