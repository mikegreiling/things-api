# things-api — repo instructions

## Living documents — keep them current (part of every change)

- **[docs/capability-matrix.md](docs/capability-matrix.md)** — the CRUD × vector wish-list/checklist. Update it in the SAME change as: any operation-catalog edit (`src/write/operations.ts`), any vector-matrix edit, any new probe verdict, or any gap opened/closed.
- **[docs/things-app-oddities.md](docs/things-app-oddities.md)** — the future Cultured Code bug report. Record every newly discovered app bug/quirk THE MOMENT it is found, with probe evidence.
- **[docs/gaps.md](docs/gaps.md)** — roadmap: one entry per phase, updated when a phase lands.
- **[docs/roadmap.md](docs/roadmap.md)** — durable parked-work plan (survives compaction): decided-but-unbuilt items, distribution/onboarding, doctrine decisions. Update when a parked item lands or a new one is deferred.
- **CHANGELOG.md** — every user-visible change goes under `## Unreleased`.

## Safety rails (non-negotiable)

- Production Things DB (this host): READS ONLY, and only via `scripts/prod-read.sh` (one stable command shape — ad-hoc shapes re-trigger macOS consent). NEVER write to production; never point new binary shapes at the prod container (even `doctor`).
- Writes go exclusively through official app surfaces (URL scheme / AppleScript / Shortcuts) — never direct SQLite writes. All write probing happens in disposable Tart VMs (`docs/lab/`).

## Conventions

- Verify `npm run check` by EXIT CODE, never by grepping piped output. Run `npm run fmt` before committing (oxfmt also formats committed JSON).
- Feature branches (`mg/<topic>`), PRs for the audit trail, self-merge after CI is fine.
- All consumer-facing copy (CLI `--help`, MCP tool descriptions, exported JSDoc) follows [docs/design/surface-copy.md](docs/design/surface-copy.md) — behavior and side effects only; banned-vocabulary regression tests enforce it.
- Guest e2e bundles ship node + dist + commander ONLY — heavyweight deps (MCP SDK, zod) must stay lazily imported from CLI actions.
