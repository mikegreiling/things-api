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
- **Every mutation is audited**: JSONL trail with requested vs. observed deltas and rollback hints.
- **Schema drift is detected**: table/column fingerprints keyed by Things' database version; writes hard-block on mismatch.
- **Disruption is explicit**: every operation×vector combination carries a disruption tier (0 = invisible → 3 = navigates UI/modals); disruptive operations require explicit opt-in flags.
- **Nothing is developed against production data**: probing and integration tests run in disposable Tart macOS VMs.
