# Changelog

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
