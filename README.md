# things-api

A typed TypeScript library + CLI (`things`) for programmatic interaction with [Things 3](https://culturedcode.com/things/) by Cultured Code.

**Status: read + write layers live.** Reads go straight to the local SQLite database; writes run a verified pipeline over two lab-validated vectors (URL scheme + AppleScript) with hazard guards, disruption-tier policy, and a JSONL audit trail. See [docs/design/](docs/design/) for the architecture and VM-lab design, [docs/lab/](docs/lab/harness.md) for the probe harness and campaign results the write layer is grounded in, and [docs/atlas/](docs/atlas/schema-v26.md) for the database↔UI map.

```sh
things today --json                # read: your Today list, Evening split, UI order
things todo add "Buy milk" --when today --tags errands --dry-run   # plan without executing
things capabilities --op todo.delete   # what's possible, per vector, with evidence
```

## Requirements & first-run setup

Things 3 installed and launched once, Node ≥ 24, and a handful of one-time macOS consents / Things settings depending on what you use (file-access consent for reads; "Enable Things URLs" + Automation consents for writes). **See [docs/setup.md](docs/setup.md)** — including the dedicated-automation-Mac checklist. `things doctor` validates your setup and prints remediation for anything missing.

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
2. **Structured output**: every command takes `--json` → versioned envelope `{ apiVersion, ok, kind, data|error, meta }` on stdout; human chatter goes to stderr only.
3. **Stable exit codes**: `0` ok · `2` usage · `3` verify-failed (mutation executed, expected delta never appeared) · `4` blocked (hazard guard or disruption policy; error carries `remediation`) · `5` drift-blocked · `6` unsupported · `7` environment.
4. **Plan before executing**: every write supports `--dry-run` — compiled invocation (token-redacted), chosen vector, tier, hazards checked, expected delta. Nothing runs, nothing is audited.
5. **No prompts, ever**: risky semantics are explicit flags — `--children require-resolved|auto-complete` (project completion cascades), `--acknowledge-checklist-reset` (checklist replacement destroys per-item state), `--acknowledge-project-reopen` (open child reopens a resolved project), `--dangerously-permanent` (area/tag delete and empty-trash skip the Trash).
6. **Experimental surfaces are opt-in**: `things reorder` (ordering within Today/a project/an area) rides an undocumented AppleScript command that any Things update may remove. It requires `things config set allow-experimental true` and re-checks the app's sdef declaration before every dispatch; `things doctor` reports both gates. Evening reorders never touch it — they use verified `when=` round-trips (the "bounce", ≤10 items) instead.

A typical mutation flow:

```sh
things capabilities --op todo.move --json      # is it possible, which vector, what tier?
things search "Buy milk" --json                # resolve the uuid (open items; scope with --project/--area/--tag, widen with --logged/--trashed/--all)
things todo move <uuid> --project "Errands" --dry-run --json   # inspect the plan
things todo move <uuid> --project "Errands" --json             # execute, verified
```

Failure modes are first-class: a `verify-failed:silent-noop` means the app accepted the command and did nothing (a real Things behavior the guards mostly prevent — see [docs/things-app-oddities.md](docs/things-app-oddities.md)); `blocked:*` responses include machine-readable remediation.
