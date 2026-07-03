# things-api

A typed TypeScript library + CLI (`things`) for programmatic interaction with [Things 3](https://culturedcode.com/things/) by Cultured Code.

**Status: read layer live; write layer in development.** See [docs/design/](docs/design/) for the architecture and VM-lab design, [docs/research/](docs/research/) for the validated capability research this project is grounded in, and [docs/atlas/](docs/atlas/schema-v26.md) for the database↔UI map.

## Requirements & first-run setup

Things 3 installed and launched once, Node ≥ 24, and a handful of one-time macOS consents / Things settings depending on what you use (file-access consent for reads; "Enable Things URLs" + Automation consents for writes). **See [docs/setup.md](docs/setup.md)** — including the dedicated-automation-Mac checklist. `things doctor` validates your setup and prints remediation for anything missing.

## Core principles

- **Reads** go directly to Things' local SQLite database (read-only, WAL-aware). **Writes** go exclusively through official app surfaces — URL scheme, AppleScript, Shortcuts — never direct DB writes (sync corruption).
- **Every mutation is verified**: pre-read → hazard guards → execute → poll re-read until the expected delta appears. Silent no-ops are failures.
- **Every mutation is audited**: JSONL trail with requested vs. observed deltas and rollback hints.
- **Schema drift is detected**: table/column fingerprints keyed by Things' database version; writes hard-block on mismatch.
- **Disruption is explicit**: every operation×vector combination carries a disruption tier (0 = invisible → 3 = navigates UI/modals); disruptive operations require explicit opt-in flags.
- **Nothing is developed against production data**: probing and integration tests run in disposable Tart macOS VMs.
