# things-api

A typed TypeScript library + CLI (`things`) for programmatic interaction with [Things 3](https://culturedcode.com/things/) by Cultured Code.

**Status: read + write + MCP layers live and published to npm (v0.7.0 — see [CHANGELOG.md](CHANGELOG.md)).** Reads go straight to the local SQLite database (UI-exact Today ordering, sidebar-grouped Anytime/Someday with container-status cascade, decoded repeat rules, occurrence projections); writes run a verified pipeline over two lab-validated write vectors (URL scheme + AppleScript) with hazard guards, disruption-tier policy, a JSONL audit trail, batch mode, audit-replay undo (transactional across compound operations), full project lifecycle (complete/cancel/reopen/restore), heading rename/archive/unarchive with children policies, container detach, granular stateful checklists, tag hierarchy management incl. un-nesting, completion/creation backdating, Logbook imports, tiered fuzzy name resolution (uuid prefixes, `things:///show?id=` share links), and ordering across eight scopes (incl. a project's headings and the top-level sidebar projects). A third surface — Apple Shortcuts — is now wired for the two headless capabilities nothing else can do: creating a heading in an existing project (`things heading add`) and clearing a reminder from a date-scheduled item (`things todo clear-reminder`). Both run through bundled proxy shortcuts (`things setup shortcuts`) and are gated on their presence. Single-item permanent delete stays interactive-only (its macOS consent has no always-allow) and is out of the headless pipeline. See [docs/design/](docs/design/) for the architecture and VM-lab design, [docs/lab/](docs/lab/harness.md) for the probe harness and campaign results the write layer is grounded in, and [docs/atlas/](docs/atlas/schema-v26.md) for the database↔UI map.

```sh
things today --json                # read: your Today list, Evening split, UI order
things legend                      # the symbols & colors the list views use
things upcoming --horizon 5       # date plan incl. projected repeat occurrences
things todo add "Buy milk" --when today --tags errands --dry-run   # plan without executing
things undo --dry-run              # inverse plan for the last mutation (audit replay)
things capabilities --op todo.delete   # what's possible, per vector, with evidence
```

## Requirements & first-run setup

Things 3 installed and launched once, Node ≥ 24, and a handful of one-time macOS consents / Things settings depending on what you use (file-access consent for reads; "Enable Things URLs" + Automation consents for writes). **See [docs/setup.md](docs/setup.md)** — including the dedicated-automation-Mac checklist. `things doctor` validates your setup and prints remediation for anything missing.

### Shortcuts setup (optional)

A few operations exist on no other app surface: creating a heading in an **existing** project, clearing a reminder from a date-scheduled item, and permanently deleting a single item. These run through six bundled Apple Shortcuts (signed `.shortcut` files shipped with the package). Install them with:

```sh
things setup shortcuts   # opens an install sheet per missing shortcut — click "Add Shortcut"
```

On each shortcut's first run macOS asks for permission — choose **Always Allow** so later runs are unattended (the two delete shortcuts re-ask on every run by design; Apple offers no always-allow for deletion). `things setup shortcuts --check` and `things doctor` report installation state.

Once installed, these Shortcuts-only operations become available as ordinary commands: `things heading add <project> <title>` (create a heading in an existing project) and `things todo clear-reminder <uuid>` (clear a date-scheduled to-do's reminder while keeping its date). Both are also exposed over MCP (`create_heading`, `clear_reminder`). If a required shortcut is missing, the command is blocked up front with a pointer back to `things setup shortcuts` — nothing is dispatched.

### Development install

To get a global `things` command that runs the live TypeScript source (no build step — Node ≥ 24 strips types natively):

```sh
npm link            # symlink this checkout as the global things-api package
asdf reshim nodejs  # once, if you use asdf: expose the new `things` shim
```

Edits under `src/` take effect immediately. The bin launcher ([bin/things.js](bin/things.js)) prefers `src/` when present and falls back to `dist/`, so published installs (`npm i -g things-api`, `npx things-api`) run the compiled output with identical behavior.

## Core principles

- **Reads** go directly to Things' local SQLite database (read-only, WAL-aware). **Writes** go exclusively through official app surfaces — URL scheme, AppleScript, Shortcuts — never direct DB writes (sync corruption).
- **Every mutation is verified**: pre-read → hazard guards → execute → poll re-read until the expected delta appears. Silent no-ops are failures.
- **Every mutation is audited**: JSONL trail (`~/.local/state/things-api/audit/`) with requested vs. observed deltas; auth tokens structurally redacted.
- **Schema drift is detected**: table/column fingerprints keyed by Things' database version; writes hard-block on mismatch ([drift runbook](docs/lab/drift-runbook.md)).
- **Disruption is explicit**: every operation×vector combination carries a disruption tier (0 = invisible → 3 = navigates UI/modals); disruptive operations require explicit opt-in flags.
- **Nothing is developed against production data**: probing and integration tests run in disposable Tart macOS VMs.

## For agents

The CLI is designed to be driven by coding agents with no out-of-band knowledge. The contract:

1. **Discovery**: `things --help` (ends with AGENT NOTES), per-command `--help` (states each write's vector, disruption tier, hazards, and exact acknowledgement flag names — regression-tested as API), and `things capabilities [--op <op>] --json` (the lab-validated operation × vector support matrix, with probe-evidence ids).
2. **Structured output**: every command takes `--json` → versioned envelope `{ apiVersion, ok, kind, data|error, meta }` on stdout; human chatter goes to stderr only. List views are **bounded by default**: the flat/chronological views (`inbox`, `today`, `upcoming`, `logbook`, `trash`, `search`, `changes`) return at most 50 items — raise with `--limit <n>` or lift with `--all` — and carry exact truncation counts in `meta.pagination { shown, total, limit, truncated }`. The grouped catalogues (`anytime`, `someday`) always show every area and project row and cap per block instead (no `--limit`): `--area-limit <n>` (default 30) per area block on both, `--project-limit <n>` (default 3) per project block on anytime, `--show-active-project-items [n]` for someday's trailing active-projects section — reporting `meta.grouped { truncated, blocks[] }` with per-block counts. Same defaults and metadata apply over MCP.
3. **Stable exit codes**: `0` ok · `2` usage · `3` verify-failed (mutation executed, expected delta never appeared) · `4` blocked (hazard guard or disruption policy; error carries `remediation`) · `5` drift-blocked · `6` unsupported · `7` environment.
4. **Plan before executing**: every write supports `--dry-run` — compiled invocation (token-redacted), chosen vector, tier, hazards checked, expected delta. Nothing runs, nothing is audited.
5. **No prompts, ever**: risky semantics are explicit flags — `--children require-resolved|auto-complete` (project completion cascades), `--acknowledge-checklist-reset` (checklist replacement destroys per-item state), `--acknowledge-project-reopen` (open child reopens a resolved project), `--dangerously-permanent` (area/tag delete and empty-trash skip the Trash).
6. **Experimental surfaces are opt-in**: `things reorder` (ordering within Today, the Inbox, Someday, a project's to-dos, a project's headings, or an area) rides an undocumented AppleScript command that any Things update may remove. It requires `things config set allow-experimental true` and re-checks the app's sdef declaration before every dispatch; `things doctor` reports both gates. Two scopes never touch it: This Evening and the top-level sidebar projects use verified `when=` round-trips (the "bounce", ≤10 items) instead.

A typical mutation flow:

```sh
things capabilities --op todo.move --json      # is it possible, which vector, what tier?
things search "Buy milk" --json                # resolve the uuid (open items; scope with --project/--area/--tag, widen with --logged/--trashed/--all)
things todo move <uuid> --project "Errands" --dry-run --json   # inspect the plan
things todo move <uuid> --project "Errands" --json             # execute, verified
things changes --since 2026-07-05T08:00 --json # what changed since the agent last looked
things batch inbox-triage.jsonl                # N ops, each guarded+verified, JSONL results
things undo --dry-run                          # inverse plan for the last mutation (audit replay)
things undo                                    # execute it — verified like any mutation
```

Failure modes are first-class: a `verify-failed:silent-noop` means the app accepted the command and did nothing (a real Things behavior the guards mostly prevent — see [docs/things-app-oddities.md](docs/things-app-oddities.md)); `blocked:*` responses include machine-readable remediation.

## Architecture: one library, thin surfaces

The TypeScript library (`import { openThings } from "things-api"`) is the product; the CLI and the MCP server are thin presentation layers over the same `ThingsClient` — every read view and every verified mutation is a client method first. Shared machine contracts (JSON envelope, exit codes) live in the core (`contracts.ts`), and `diagnose()` / `capabilitiesTable()` are library functions the surfaces merely render.

### MCP server

`things mcp` serves the Model Context Protocol over stdio. Configure it in any MCP client:

```json
{ "mcpServers": { "things": { "command": "things", "args": ["mcp"] } } }
```

The server instructions carry the user's live inventory (areas, tag hierarchy, open projects — read at server start) plus the reference/scheduling vocabulary, so models can name real destinations without a discovery round-trip. Tools mirror the client surface: reads (`read_view` — today/inbox/anytime/upcoming with occurrence horizon/someday/logbook/trash — `search`, `changes_since`, `get_item`, `get_project`, `list_collections`) and grouped semantic mutations (`add_todo`, `update_todo`, `set_todo_status`, `move_todo`, `set_tags`, `edit_checklist`; `delete_item`/`restore_item`/`duplicate_item` for to-dos and projects alike; `add_project`, `update_project`, `set_project_status`, `move_project`; area and tag CRUD incl. tag un-nesting and guarded subtree deletion; plus generic `run_operation` for the full 28-op catalog, `batch`, `reorder`, `undo`, `capabilities`, `doctor`). Every write tool takes `dry_run`; tools carry read-only/destructive annotations; hazard blocks come back as structured tool errors carrying the same remediation text the CLI prints. Tool descriptions follow the consumer-voice contract in [docs/design/surface-copy.md](docs/design/surface-copy.md).
