# Changelog

## Unreleased

### New write capabilities (Phase 21b)

Grounded in the Phase 21b lab probe campaign ([docs/lab/phase21b-research.md](docs/lab/phase21b-research.md)).

- **Project tags** — `things project tags <uuid> --set/--add` and MCP `set_tags` now accept a project (dispatches on the item type). Full-replacement semantics mirror to-do tags; tags must name existing tags.
- **Project reminders** — `things project update --reminder HH:mm` / `--clear-reminder` and MCP `update_project`'s `reminder`/`clear_reminder`. Projects carry the same reminder codec and scope rules as to-dos (requires `--when today|evening|YYYY-MM-DD`; an existing reminder is auto-preserved on re-schedule; dated reminders are sticky).
- **Clear a tag's keyboard shortcut** — `things tag update --clear-shortcut` and MCP `update_tag`'s `clear_shortcut` (the property-delete form; `undo` now restores a cleared shortcut symmetrically).
- **Inbox reordering** — `things reorder --scope inbox` and MCP `reorder` scope `inbox` order unscheduled Inbox to-dos (native/experimental, same gate as today/project/area).

### Environment awareness & failure attribution (Phase 21a)

- **Failure attribution**: mutation failures carry an advisory `likelyCause` + hint when the signals point somewhere — AppleEvent `-1743` → `permission-denied`; a transport hang/deadline kill → `permission-pending` (the shape of an unanswered macOS consent dialog); a URL silent no-op without an authorization token → `feature-disabled` (Enable Things URLs); a Things version change since the last verified write → `app-updated`; drift blocks → `schema-drift`; residual silent no-ops → `app-behavior-change`. Surfaced in CLI stderr, `--json` envelopes (`error.likelyCause`, hint as `remediation`), and MCP tool errors.
- **Environment tuple tracking**: the Things version, macOS version, things-api version, and resolved node binary are recorded at `~/.local/state/things-api/environment.json` after every verified mutation. A successful write after a change carries a warning (a changed tuple is the classic consent re-prompt trigger), and `things doctor` reports the tuple, the last-recorded one, and the diff.
- **`things doctor --probe-automation`** (MCP: `doctor {probe_automation}`): opt-in active Automation-consent check — granted / denied (`-1743`) / pending (unanswered dialog) / app-not-running (never launches the app). Opt-in because the probe itself can summon the consent prompt; that is its onboarding use.
- **docs/setup.md**: new "Hardening against consent prompts" ladder for headless setups — the responsible-process model, FDA-to-host, the sshd identity trick, signed-binary roadmap, MDM/PPPC, and the SIP-off CI pattern.

### MCP v2 (Phase 20)

- The tool surface grows from 16 to 31 grouped semantic tools: `set_todo_status` / `set_project_status` (status + children policy + restore-children fold), promoted `move_todo` (project/area/heading/inbox/detach) and `move_project` (area/detach), `set_tags` (replace/add), `edit_checklist` (granular add/remove/check/uncheck/rename/move + stateful replace), type-generic `delete_item`/`restore_item`/`duplicate_item`, and full area/tag CRUD (`update_tag` incl. un-nest, `delete_tag` with subtree confirmation). `run_operation` + `capabilities` remain the escape hatch for the long tail.
- Server `instructions` now carry a live inventory read at server start — areas, tag hierarchy (`parent > child`), open project titles (capped at 100) — plus the reference and scheduling vocabulary, degrading to conventions-only when the database is unreadable.
- Tools carry MCP annotations (`readOnlyHint` on reads/capabilities/doctor, `destructiveHint` on permanent deletes and the generic mutation entries).
- New surface-copy contract ([docs/design/surface-copy.md](docs/design/surface-copy.md)): tool descriptions state consumer-visible behavior and side effects only — pipeline/audit/lab vocabulary is banned (regression-tested) and lives in `docs/` and the `capabilities` output. Shared parameter vocabulary moved to `src/surface-copy.ts` so CLI help and MCP schemas cannot drift apart.
- The same contract now governs the CLI and the library JSDoc: every `--help` string, the AGENT NOTES block, and the exported `ThingsClient`/operation-params docs were rewritten in consumer voice (hazard ids, probe-evidence ids, vector/tier framing, and audit/verification mechanics replaced with the behavior they imply); a help-wide banned-vocabulary test locks it in. The lab evidence remains in `docs/lab/`, the write-layer internals, and the `capabilities` output.

## 0.3.0 — 2026-07-07

The operation catalog grows from 25 to 28 kinds; every new capability is grounded in the 30-probe P-suite campaign ([docs/lab/p-suite-results.md](docs/lab/p-suite-results.md)).

### MCP server (Phase 17)

- `things mcp` serves the Model Context Protocol over stdio — 16 tools mirroring the library surface (read views incl. occurrence horizon, search, changes, item/project detail, verified mutations via dedicated tools + generic `run_operation`, batch, reorder, undo, capabilities, doctor). Hazard blocks return as structured tool errors carrying the guards' remediation text. Exposed from the library as `createThingsMcpServer()`. The SDK loads lazily — every other CLI command boots with a minimal dependency set.
- Seam hygiene: machine contracts (JSON envelope, exit codes) moved from `src/cli/` into core (`contracts.ts`); `diagnose()` and `capabilitiesTable()` promoted to library functions (the CLI `doctor`/`capabilities` commands are now thin renderers); `saveConfigKey` and the batch/undo/reorder/view option types exported from the package index.

### Project lifecycle (Phases 18–19)

- `things project cancel --children require-resolved|auto-cancel` — the URL write cascades natively (open children → canceled; completed children untouched, P01); the policy is mandatory and the cascade is verified per child, mirroring `project complete`.
- `things project reopen [--restore-children]` — reopens completed AND canceled projects (P02/P05). The bare op reopens only the project row (exactly the app's behavior — cascade-resolved children stay resolved); `--restore-children` adds verified per-child reopen legs, detecting cascade-resolved children by the <2s stopDate window (P03). Children resolved before the project are never touched (P04).
- `things project restore` — un-trashes a project IN PLACE (P06): schedule, area link, and children all keep their state.
- `undo` now reverses project complete/cancel (audit-exact child restore), project delete, and project restore.

### Container detach (Phases 18–19)

- `things todo move <uuid> --detach` — one write clears project/area/heading while the schedule is pinned unchanged (URL empty `list-id=`, P21/P22).
- `things project move <uuid> --detach` — clears the area (empty `area-id=`, P24); `project move` also gains a URL vector for regular moves (P23). Detach moves are undo-invertible from the captured prior container.

### Granular checklists (Phases 18–19)

- `things todo checklist` gains `--check/--uncheck/--add [--at N]/--remove/--rename/--to`: reads the current items+states from the DB, applies the edit in memory, and writes back through `things:///json` with per-item completed states (P18) — the only surface that recreates items pre-checked. State-preserving edits skip the H-CHECKLIST-REPLACE acknowledgement (nothing is destroyed). Checklist-item uuids are not stable across rewrites; key on title/position.
- Empty-set clears validated: `todo tags --set ""` and an empty checklist replacement (P14/P15).

### Tags (Phases 18–19)

- `things tag update --unnest` — un-nests a tag to the root of the hierarchy via AppleScript's property-delete form (`delete parent tag of tag X`, P29 — the one spelling that works; `set … to missing value` and `""` error, json `null` silently no-ops). Undo re-nests/un-nests symmetrically.
- **New hazard `H-TAG-SUBTREE-DELETE`**: deleting a tag that has child tags silently cascade-deletes the whole subtree, permanently (P16) — `tag delete` now blocks unless `--acknowledge-subtree` accompanies `--dangerously-permanent`.

### Closed permanently (documented, guarded)

Container/area removal via AppleScript `missing value`/`""` or json `null` (the URL empty-param is the sole surface); to-do↔project conversion; sidebar ordering (areas, top-level projects — reads stay available via the provisional `"index"` sort); deleting an area orphans its projects to no-area while trashing only its to-dos (P20). The app-oddities catalog (§2f, §5f, §5g) documents the report-worthy inconsistencies for Cultured Code.

## 0.2.0 — 2026-07-06

Everything in this release is grounded in lab evidence (probe ids cite the suites under [docs/lab/](docs/lab/)); reads were additionally reconciled against the live UI.

### Ordering (Phase 8)

- `things reorder` / `write.reorder`: Today, This Evening, project, and area ordering. Native strategy rides a private AppleScript command — experimental-gated (`things config set allow-experimental true`) with a per-dispatch sdef canary; Evening uses verified `when=` round-trips ("bounce", ≤10 items) because the native command silently de-evenings items (O03).

### Editing completeness (Phases 9, 12, 14)

- Reminders: `--reminder HH:mm` on todo add/update for `--when today|evening|YYYY-MM-DD`, auto-preserved on re-schedule, `--clear-reminder` on today/evening. Dated reminders are sticky in the app (R20/R21) — the guard explains the bounce-via-today workaround. Times compile through a deterministic emitter that routes around the app's bare-hour 12-hour parser trap (oddity 2d).
- Notes modes on to-dos AND projects: `--append-notes` / `--prepend-notes` (newline-joined, E04/E05/E11/E12/E18).
- `things todo duplicate` (E07) and `things project duplicate` — the project copy includes its children (E17).
- `things todo restore` — un-trash a to-do, the UI's "Put Back" scripted (E15).
- `things project move --area` — move projects between areas (E14).
- `things area update` (rename/retag), `things tag update` (rename/re-parent/shortcut), `things todo move --inbox`.
- Area-scope reorder accepts projects (O14); mixed to-do+project requests are rejected (unprobed).
- Dead ends documented and regression-locked: to-do↔project conversion (E16), tag un-nest to root (E19), sidebar area ordering (O13), repeat-rule creation/editing (template `duplicate=true` disproven, E13).

### Read fidelity (Phase 10)

- Today view reconciles the live UI exactly (393/393 members, top-10 order): comparator `startBucket, todayIndexReferenceDate DESC, todayIndex, uuid`, plus the corrected membership rule — a due deadline pulls items into Today even from the Inbox unless suppressed (`deadlineSuppressionDate`).
- Repeat rules decoded read-only from the `rt1_recurrenceRule` plist; `byUuid` exposes `repeating.rule` / `nextOccurrence` / `paused`; Upcoming surfaces each fixed template's next occurrence with the rule-derived deadline (`deadline = start − ts`, instance-validated).

### Search & tags (Phase 12)

- `things search` defaults to open+untrashed with `--logged/--trashed/--all` widening and `--project/--area/--tag/--type/--limit` scoping; unknown refs fail loudly.
- Every `--tag` filter matches hierarchy descendants (UI parity) with `--exact-tag` to opt out; direct + inherited (heading→project→area) membership throughout.

### Batch, changes, undo (Phases 13, 15)

- `things batch` — JSONL mutations through the full per-op pipeline (guards, verified read-after-write, audit); streaming results, `--dry-run`, `--fail-fast`, worst-severity exit codes.
- `things changes --since <when>` — created/modified rows including trashed/logged/templates (tag/area/checklist-item edits are invisible to `userModificationDate`; documented).
- `things undo [--last N]` — inverse mutations replayed from the audit trail's recorded pre-values, each through the full verified pipeline. Irreversible operations (permanent deletes, project complete/delete, uncaptured pre-state) are reported honestly; created areas/tags require `--dangerously-permanent` to reverse-delete.

### Occurrence projections (Phase 16)

- `things upcoming --horizon <n>` — projects up to n occurrences per repeating item from its decoded rule (fixed rules only), anchored on the app's own materialized next instance. Calendar conventions documented in `src/model/occurrences.ts` (day-31 clamps, missing 5th-weekday skips, Sunday-based weekly cohorts); honors rule end dates and remaining counts. Sanity-checked read-only against a 56-template live corpus.

### Infrastructure

- Six lab probe suites (u/a/x/o/r/e) double-green-locked; `npm run lab:regress` runs them plus a 70-step guest e2e write smoke as the merge gate.
- macOS TCC field notes for headless operation ([docs/setup.md](docs/setup.md)); `scripts/prod-read.sh` for stable-shape read-only production queries.
- App-oddities catalog ([docs/things-app-oddities.md](docs/things-app-oddities.md)) ready for a Cultured Code bug report: repeating `when=` URL crash, silent-failure family, bare-hour reminder parser, asymmetric reminder clearing, template-duplicate window spam.

## 0.1.0 — 2026-07-04

Initial release: read layer (Today/Inbox/Anytime/Upcoming/Someday/Logbook/Trash/projects/areas/tags/search/byUuid, direct SQLite, WAL-aware), write layer (18 operations over URL-scheme + AppleScript vectors as lab-validated matrices; drift gate, mutation lock, hazard guards, disruption tiers, verified read-after-write, JSONL audit), `things` CLI with agent-oriented help/exit-code/envelope contracts, capabilities matrix, doctor, and the Tart VM probe lab (u/a/x suites).
