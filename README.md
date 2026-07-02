# things-api

A typed TypeScript library + CLI (`things`) for programmatic interaction with [Things 3](https://culturedcode.com/things/) by Cultured Code.

**Status: Phase 0 (bootstrap).** See [docs/design/](docs/design/) for the architecture and VM-lab design, and [docs/research/](docs/research/) for the validated capability research this project is grounded in.

## Core principles

- **Reads** go directly to Things' local SQLite database (read-only, WAL-aware). **Writes** go exclusively through official app surfaces — URL scheme, AppleScript, Shortcuts — never direct DB writes (sync corruption).
- **Every mutation is verified**: pre-read → hazard guards → execute → poll re-read until the expected delta appears. Silent no-ops are failures.
- **Every mutation is audited**: JSONL trail with requested vs. observed deltas and rollback hints.
- **Schema drift is detected**: table/column fingerprints keyed by Things' database version; writes hard-block on mismatch.
- **Disruption is explicit**: every operation×vector combination carries a disruption tier (0 = invisible → 3 = navigates UI/modals); disruptive operations require explicit opt-in flags.
- **Nothing is developed against production data**: probing and integration tests run in disposable Tart macOS VMs.
