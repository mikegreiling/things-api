# things-api

A typed TypeScript library + CLI (`things`) for programmatic interaction with [Things 3](https://culturedcode.com/things/) by Cultured Code.

**Status: read + write + MCP layers live and published to npm (v0.10.0 — see [CHANGELOG.md](CHANGELOG.md)).** Reads go straight to the local SQLite database (UI-exact Today ordering, sidebar-grouped Anytime/Someday with container-status cascade, decoded repeat rules, occurrence projections); writes run a verified pipeline over four write vectors — two lab-validated headless surfaces (the URL scheme + AppleScript) and two opt-in surfaces (Apple Shortcuts and an Accessibility-driven GUI vector) — with hazard guards, disruption-tier policy, a JSONL audit trail, batch mode, audit-replay undo (transactional across compound operations), full project lifecycle (complete/cancel/reopen/restore), heading rename/archive/unarchive with children policies, container detach, granular stateful checklists, tag hierarchy management incl. un-nesting, completion/creation backdating, Logbook imports, tiered fuzzy name resolution (uuid prefixes, `things:///show?id=` share links), and ordering across eight scopes (incl. a project's headings and the top-level sidebar projects). The Apple Shortcuts surface is wired for the two headless capabilities nothing else can do: creating a heading in an existing project (`things heading add`) and clearing a reminder from a date-scheduled item (`things todo clear-reminder`). Both run through bundled proxy shortcuts (`things setup shortcuts`) and are gated on their presence. The fourth vector — the Accessibility-driven GUI vector — is off by default and drives the local Things app to reach transforms that exist on no scriptable surface (repeat-rule editing on existing to-dos and projects, convert-to-project, sidebar area reorder); see [Accessibility GUI vector](#accessibility-gui-vector-optional-off-by-default) below. Single-item permanent delete stays interactive-only (its macOS consent has no always-allow) and is out of the headless pipeline. See [docs/design/](docs/design/) for the architecture and VM-lab design, [docs/lab/](docs/lab/harness.md) for the probe harness and campaign results the write layer is grounded in, and [docs/atlas/](docs/atlas/schema-v26.md) for the database↔UI map.

```sh
things today --json                # read: your Today list, Evening split, UI order
things legend                      # the symbols & colors the list views use
things upcoming --horizon 5       # date plan incl. projected repeat occurrences
things todo add "Buy milk" --when today --tags errands --dry-run   # plan without executing
things undo --dry-run              # inverse plan for the last mutation (audit replay)
things capabilities --op todo.delete   # what's possible, per vector, with evidence
```

## Requirements & first-run setup

Things 3 installed and launched once, Node ≥ 24, and a handful of one-time macOS consents / Things settings depending on what you use (file-access consent for reads; "Enable Things URLs" + Automation consents for writes; an Accessibility grant for the optional GUI vector). **See [docs/setup.md](docs/setup.md)** — including the dedicated-automation-Mac checklist. `things doctor` validates your setup and prints remediation for anything missing.

### Shortcuts setup (optional)

A few operations exist on no other app surface: creating a heading in an **existing** project, clearing a reminder from a date-scheduled item, and permanently deleting a single item. These run through six bundled Apple Shortcuts (signed `.shortcut` files shipped with the package). Install them with:

```sh
things setup shortcuts   # opens an install sheet per missing shortcut — click "Add Shortcut"
```

On each shortcut's first run macOS asks for permission — choose **Always Allow** so later runs are unattended (the two delete shortcuts re-ask on every run by design; Apple offers no always-allow for deletion). `things setup shortcuts --check` and `things doctor` report installation state.

Once installed, these Shortcuts-only operations become available as ordinary commands: `things heading add <project> <title>` (create a heading in an existing project) and `things todo clear-reminder <uuid>` (clear a date-scheduled to-do's reminder while keeping its date). Both are also exposed over MCP (`create_heading`, `clear_reminder`). If a required shortcut is missing, the command is blocked up front with a pointer back to `things setup shortcuts` — nothing is dispatched.

### Accessibility GUI vector (optional, off by default)

A handful of transforms exist on **no scriptable surface at all** — the URL scheme, AppleScript, and Shortcuts cannot express them. The fourth write vector (the "ui" vector) reaches them by driving the local Things app's real interface through macOS Accessibility. It unlocks: making an existing to-do or project repeat and rescheduling/pausing/resuming its rule; converting a to-do into a project; and moving an area to a new position in the global area order (the sidebar). See [docs/design/ui-vector.md](docs/design/ui-vector.md) for the full model.

Because it drives the live GUI it is **fail-closed and two-key gated**: enable it once with `things config set ui-enabled true`, then acknowledge each individual call with `--dangerously-drive-gui` (`dangerously_drive_gui` over MCP). It carries the `H-UI-DRIVE` hazard, sits at the top disruption tier (3), and is intended for a dedicated, always-on Mac pinned to the English app language (a non-English UI fails the vector closed). Its recipes are **fragile** — an app-layout change can break them — so each op carries a per-op certification status (`uncertified` → `lab-certified` → on-device `certified`) recorded in the manifest at [src/write/vectors/ui-certification.ts](src/write/vectors/ui-certification.ts) and surfaced by `things capabilities` and the `things doctor` ui-vector section; a successful drive of a not-yet-`certified` op returns a note saying so.

Setup — granting Accessibility to the driving process and verifying it with `things doctor --probe-accessibility` — is in [docs/setup.md](docs/setup.md).

### Development install

To get a global `things` command that runs the live TypeScript source (no build step — Node ≥ 24 strips types natively):

```sh
npm link            # symlink this checkout as the global things-api package
asdf reshim nodejs  # once, if you use asdf: expose the new `things` shim
```

Edits under `src/` take effect immediately. The bin launcher ([bin/things.js](bin/things.js)) prefers `src/` when present and falls back to `dist/`, so published installs (`npm i -g things-api`, `npx things-api`) run the compiled output with identical behavior.

## Core principles

- **Reads** go directly to Things' local SQLite database (read-only, WAL-aware). **Writes** go exclusively through official app surfaces — URL scheme, AppleScript, Shortcuts, and (opt-in) the Accessibility-driven GUI — never direct DB writes (sync corruption).
- **Every mutation is verified**: pre-read → hazard guards → execute → poll re-read until the expected delta appears. Silent no-ops are failures.
- **Every mutation is audited**: JSONL trail (`~/.local/state/things-api/audit/`) with requested vs. observed deltas; auth tokens structurally redacted.
- **Schema drift is detected**: table/column fingerprints keyed by Things' database version; writes hard-block on mismatch, and reads surface a non-blocking `meta.warnings` note rather than failing ([drift runbook](docs/lab/drift-runbook.md)).
- **Disruption is explicit**: every operation×vector combination carries a disruption tier (0 = invisible → 3 = drives the live UI); disruptive operations require explicit opt-in flags.
- **Nothing is developed against production data**: probing and integration tests run in disposable Tart macOS VMs.

## For agents

The CLI is designed to be driven by coding agents with no out-of-band knowledge. The contract:

1. **Discovery**: `things --help` (a grouped one-line-per-command index; orientation detail lives behind `things help <topic>` — `agent`, `filters`, `ids`, `output`, `writes`), per-command `things <command> --help` (behavior, side effects, and the exact acknowledgement flag names a write needs — regression-tested as API; by design it does **not** carry vector/tier/hazard vocabulary, which is banned from help text by [docs/design/surface-copy.md](docs/design/surface-copy.md) — that classification lives in `capabilities`), and `things capabilities [--op <op>] --json` (the lab-validated operation × vector support matrix with disruption tiers, hazards, per-op certification status, and probe-evidence ids). Command invocation follows one grammar (`things <view>` · `things <type> <verb> <subject>` · loose `things <verb> <subject>` · bare `things <subject>`) with a single precedence chain — registered command/alias → view keyword → reference resolution — specified in [docs/design/cli-grammar.md](docs/design/cli-grammar.md).
2. **Structured output**: every command takes `--json` → versioned envelope `{ apiVersion, ok, kind, data|error, meta }` on stdout; human chatter goes to stderr only. List views are **bounded by default**: the flat/chronological views (`inbox`, `today`, `upcoming`, `logbook`, `trash`, `search`, `changes`) return at most 50 items — raise with `--limit <n>` or lift with `--all` — and carry exact truncation counts in `meta.truncation { shown, total, limit, truncated }` (the split `today` view also breaks the counts down per render section under `sections`). The grouped catalogues (`anytime`, `someday`) always show every area and project row and cap per block instead (no `--limit`): `--area-limit <n>` (default 30) per area block on both, `--project-limit <n>` (default 3) per project block on anytime, `--show-active-project-items [n]` for someday's trailing active-projects section — reporting `meta.grouped { truncated, blocks[] }`, where each block is identity-carrying (`kind`, `ref`, `title`, `shown`, `total`) and project blocks nest inside their area block under `children`. A read whose database schema no longer matches this build's validated fingerprint carries a non-blocking `meta.warnings` note (the read still returns best-effort; the same drift hard-blocks writes). Same defaults and metadata apply over MCP.
3. **Stable exit codes**: `0` ok · `2` usage · `3` verify-failed (mutation executed, expected delta never appeared) · `4` blocked (hazard guard or disruption policy; error carries `remediation`) · `5` drift-blocked · `6` unsupported (op has no supported vector — `things batch` also aggregates to 6 when its only failures are unsupported ops) · `7` environment.
4. **Plan before executing**: every write supports `--dry-run` — compiled invocation (token-redacted), chosen vector, tier, hazards checked, expected delta. Nothing runs, nothing is audited.
5. **No prompts, ever**: risky semantics are explicit flags — `--children require-resolved|auto-complete` (project completion cascades), `--acknowledge-checklist-reset` (checklist replacement destroys per-item state), `--acknowledge-project-reopen` (open child reopens a resolved project), `--dangerously-permanent` (area/tag delete and empty-trash skip the Trash), `--dangerously-drive-gui` (each Accessibility GUI-vector call).
6. **Experimental surfaces are opt-in**: `things reorder` (ordering within Today, the Inbox, Someday, a project's to-dos, a project's headings, or an area) rides an undocumented AppleScript command that any Things update may remove. It requires `things config set allow-experimental true` and re-checks the app's sdef declaration before every dispatch; `things doctor` reports both gates. Two scopes never touch it: This Evening and the top-level sidebar projects use verified `when=` round-trips (the "bounce", ≤10 items) instead. Reordering the areas themselves (the sidebar order) is a separate operation on the Accessibility GUI vector (`things area reorder`, MCP `reorder_area`).

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

The server instructions carry the user's live inventory (areas, tag hierarchy, open projects — read at server start) plus the reference/scheduling vocabulary, so models can name real destinations without a discovery round-trip. Tools mirror the client surface, grouped by area:

- **Reads**: `read_view` (today / inbox / anytime / upcoming with occurrence horizon / someday / logbook / trash), `search`, `changes_since`, `get_item`, `get_project`, `get_area`, `list_collections`.
- **To-do writes**: `add_todo`, `update_todo`, `set_todo_status`, `move_todo`, `set_tags`, `edit_checklist`, plus completion/creation backdating (`backdate_todo`) and Logbook import (`add_logged_todo`).
- **Project writes**: `add_project`, `update_project`, `set_project_status`, `move_project`.
- **To-dos and projects alike**: `delete_item`, `restore_item`, `duplicate_item`.
- **Areas & tags**: `add_area`, `update_area`, `delete_area`, `add_tag`, `update_tag`, `delete_tag` (tag CRUD incl. un-nesting and guarded subtree deletion).
- **Headings & reminders** (Shortcuts-backed where headless-impossible): `create_heading`, `rename_heading`, `archive_heading`, `unarchive_heading`, `clear_reminder`.
- **Accessibility GUI ("ui") vector** (two-key gated — `ui-enabled` config + `dangerously_drive_gui` per call): `make_repeating`, `reschedule_repeat`, `set_repeat_state`, `convert_to_project`, `make_project_repeating`, `create_repeating_project`, `reschedule_project_repeat`, `set_project_repeat_state`, `reorder_area`.
- **Generic & discovery**: `run_operation` (the full 49-op catalog), `batch`, `reorder`, `undo`, `capabilities`, `doctor`.

Every write tool takes `dry_run`; the ui-vector tools additionally require `dangerously_drive_gui`; tools carry read-only/destructive annotations; hazard blocks come back as structured tool errors carrying the same remediation text the CLI prints. Tool descriptions follow the consumer-voice contract in [docs/design/surface-copy.md](docs/design/surface-copy.md).
