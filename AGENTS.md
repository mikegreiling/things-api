# things-api — repo instructions

## Living documents — keep them current (part of every change)

- **[docs/capability-matrix.md](docs/capability-matrix.md)** — the CRUD × vector wish-list/checklist. Update it in the SAME change as: any operation-catalog edit (`src/write/operations.ts`), any vector-matrix edit, any new probe verdict, or any gap opened/closed.
- **[docs/things-app-oddities.md](docs/things-app-oddities.md)** — the future Cultured Code bug report. Record every newly discovered app bug/quirk THE MOMENT it is found, with probe evidence.
- **[docs/gaps.md](docs/gaps.md)** — roadmap: one entry per phase, updated when a phase lands.
- **[docs/roadmap.md](docs/roadmap.md)** — durable parked-work plan (survives compaction): decided-but-unbuilt items, distribution/onboarding, doctrine decisions. Update when a parked item lands or a new one is deferred.
- **[docs/reference/](docs/reference/README.md)** — the evidence compendium: probe-id index ([README](docs/reference/README.md)), [novel-paths.md](docs/reference/novel-paths.md) (add each newly discovered working path), [suite-audit.md](docs/reference/suite-audit.md) (update when ops or suites change).
- **[bench/](bench/README.md)** — the AGENTBENCH mini-project: [bench/ROADMAP.md](bench/ROADMAP.md) (state + round history — update in the SAME change as any bench work) and [bench/CONSTITUTION.md](bench/CONSTITUTION.md) (invariants — changes require Mike's explicit sign-off).
- **CHANGELOG.md** — every user-visible change goes under `## Unreleased`.

## Safety rails (non-negotiable)

- **This is a PUBLIC repository.** Everything committed — code, docs, probe evidence, test fixtures, git history — is visible to anyone who cares to look. Never commit: PII; personal task-manager data (no task titles, project names, notes, or any other content derived from Mike's production Things DB — this includes "example" data and test fixtures, which must be fully synthetic, never copied or paraphrased from the real database); account credentials of ANY kind, ephemeral or otherwise (throwaway lab accounts, disposable inboxes, one-time codes included — record those only in gitignored `lab/artifacts/`). Remember that git history is public too: redacting a file later does not unpublish it, so get it right before committing.
- Production Things DB (this host): READS ONLY, and only via `scripts/prod-read.sh` (one stable command shape — ad-hoc shapes re-trigger macOS consent). NEVER write to production; never point new binary shapes at the prod container (even `doctor`).
- Writes go exclusively through official app surfaces (URL scheme / AppleScript / Shortcuts) — never direct SQLite writes. All write probing happens in disposable Tart VMs (`docs/lab/`).

## Conventions

- Verify `npm run check` by EXIT CODE, never by grepping piped output. Run `npm run fmt` before committing (oxfmt also formats committed JSON).
- Feature branches (`mg/<topic>`), PRs for the audit trail, self-merge after CI is fine.
- All consumer-facing copy (CLI `--help`, MCP tool descriptions, exported JSDoc) follows [docs/design/surface-copy.md](docs/design/surface-copy.md) — behavior and side effects only; banned-vocabulary regression tests enforce it.
- Guest e2e bundles ship node + dist + commander ONLY — heavyweight deps (MCP SDK, zod) must stay lazily imported from CLI actions.
- **Consumer boundary (air gap):** `src/cli/**` and `src/mcp/**` are pure consumers of the library through the single entry point `src/index.ts` — never import a library internal directly (intra-surface presentation imports are fine). Enforced by `test/unit/import-boundary.test.ts`; see [docs/design/architecture.md](docs/design/architecture.md) (Consumer boundary).
