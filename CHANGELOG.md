# Changelog

## Unreleased

- **`things setup shortcuts`** — installs the bundled Apple Shortcuts that enable the operations available on no other surface (creating a heading in an existing project, clearing a reminder from a date-scheduled item, permanently deleting a single item). The six signed `.shortcut` files ship with the package; the command opens an install sheet for each missing one (click "Add Shortcut", then "Always Allow" on each one's first run). `--check` reports without opening anything.
- **`things doctor` reports write-surface availability**: an `url scheme:` line with the on-disk "Enable Things URLs" state (read from the app's preferences, not inferred), and a `shortcuts:` line counting installed proxy shortcuts. The JSON report gains an `availability` section.
- **More accurate failure attribution when "Enable Things URLs" is off.** A URL write that never lands is now attributed to the disabled setting by reading its actual on-disk state; previously the attribution keyed on a missing authorization token, which stays populated while the feature is off and so could misattribute the failure.

## 0.6.0 — 2026-07-09

### Reference resolution & hidden internals (mildly breaking)

- **Things share links are accepted wherever a uuid or name is expected.** Right-click → Share → Copy Link in the app yields `things:///show?id=<uuid>`; paste it directly into any `--uuid`/`--area`/`--project`/`--tag` argument and it is stripped to the id automatically — no intermediate step.

- **Names resolve in tiers** (areas, tags, projects): exact uuid → exact title → case-insensitive title → normalized title (whitespace/dash-insensitive, NFC) → uuid prefix. The first tier with exactly one match wins definitively; several is an ambiguity error. `--area family` finds `Family` without tripping over `Family - Jennifer`; `on-hold` finds `On Hold`. **Leading emoji/symbols are significant** — a name beginning with an emoji must be typed with it (so an archived `🗄️errand` tag is never matched by a bare `errand`). See [docs/design/reference-resolution.md](docs/design/reference-resolution.md).
- **Area/tag references now accept a unique uuid prefix** too (≥6 chars), like task uuids.
- **Internal sort keys are no longer surfaced.** `index` and `todayIndex` are dropped from task/heading/area/tag responses; checklist items are now `{ title, status }` only (their uuid, index, owning-task, and timestamps were unstable implementation details — a checklist item's uuid is regenerated on every rewrite and was never addressable). Ordering is conveyed by array order; `--json` still carries full task uuids. **This changes read-response shapes.**
- **Checklist edits target by title OR 1-based index** (`--index` / MCP `index`). Duplicate titles resolve best-effort — `check` picks the first unchecked match, `uncheck` the first checked, others the first match — with `--index` as the exact override. Checklist items have `open`/`completed`/`canceled` states (canceled is read-only; the write path produces open/completed) and no trashed/logged state — they travel with their parent to-do.

- **Safety: project operations now reject wrong-type targets.** `project.update`, `project.complete`, `project.set-tags`, and `project.delete` previously accepted any task uuid — passing a to-do or heading uuid resolved cleanly and compiled a project-shaped command around the wrong row (undefined app behavior; a heading in a schedule-class specifier is known to crash Things). Every `project.*` op now verifies the target is a project and points a mis-typed uuid at the right command family, matching the existing guards on `todo.*` and `heading.*`. Cross-table uuids (an area passed to a task/project op) were already caught as not-found.

### Short uuids

- **Every uuid parameter accepts a unique PREFIX (minimum 6 characters)** — CLI, MCP, and library alike (`things todo complete Vwn2yoRP` instead of the full 22-character id). Resolution is an indexed range scan; an exact full uuid always wins (a 21-char uuid can prefix a 22-char one), unknown prefixes report not-found, and ambiguous prefixes fail with every candidate listed. `things undo` and audit records always carry full uuids.
- **List output shows shortened uuid prefixes** — the shortest length unique within the list, never below 8 characters so a copied prefix stays unique database-wide, not just list-wide. `--json` envelopes and detail-view headers carry full uuids unchanged.

### Heading operations + transactional undo

- **`things heading rename / archive / unarchive`** (ops `heading.rename`/`heading.archive`/`heading.unarchive`; MCP `rename_heading`/`archive_heading`/`unarchive_heading`) — AppleScript by-id addressing (lab P10/P10b/P11), no Shortcuts setup. Archive is the preferred way to retire a heading (row deletion exists only interactively behind a per-run consent dialog); it is reversible. With open children, `--children` is required: `complete` and `cancel` ride the app's own cascades (one atomic call each; already-resolved children are never touched); `reparent` moves children to the project root first, keeping them open. `unarchive --restore-children` reopens the children the cascade resolved (matching timestamps; a someday child comes back as someday — lab-verified).
- **Compound operations now undo as one unit.** Bounce reorders and reparent-archives group their steps under a transaction: the individual legs no longer appear as separate undo targets, and undoing the operation reverses the whole sequence (a bounce reorder inverts to a single reorder back to the recorded pre-order; a reparent-archive un-archives the heading and moves every child back under it).
- **Crash guard confirmed necessary**: the lab verified that AppleScript `schedule` on a heading row crashes Things (process death). All todo operations reject non-to-do targets.
- **`things area show <ref>`** (MCP: `get_area`): composite area view mirroring the native UI — the area's direct to-dos (active first), its projects in sidebar order, later (scheduled/repeating/someday), and logged items. Targets by uuid or unique name.
- **`--area` filters accept area names** (uuid or unique title, ambiguity errors) everywhere — `things projects --area Hobbies` now works; `--tag` already resolved titles.
- **Safety: every todo operation now rejects non-to-do targets.** Passing a HEADING uuid to a todo op previously reached the app unchecked; URL writes silently no-op on heading rows, and an AppleScript `schedule` on one is a suspected app crash (lab P10b). Projects are pointed at the project commands.
- **CLI colors**: tags render blue (matching the app's tag color), not cyan.
- **Area tag clearing is now a validated surface** (lab P10e): `things area update <ref> --tags ""` removes every tag.
- **`things reorder --scope someday` now also orders area-less SOMEDAY PROJECTS** (one kind per call — to-dos and projects never mix). Someday projects are sidebar rows, so this orders the sidebar's someday segment natively. The two row types stack in opposite directions inside the app's Someday handler (lab P8b vs P9e), so the compiler emits the matching validated two-call protocol per type.
- README refreshed: v0.5.0 status, the Shortcuts surface's lab-proven capabilities and roadmap position, and the full reorder scope list.

## 0.5.0 — 2026-07-09

### Backdating, logged import, and three new reorder scopes

- **`things todo backdate <uuid> --completed-on/--created-on`** (op `todo.backdate`, MCP `backdate_todo`): rewrites a to-do's completion and/or creation timestamp to local noon on the given date — AppleScript property writes, the only surface that can (lab scf2 P4b). Completion backdating requires an already-completed/canceled to-do; undo restores the previous dates at day precision.
- **`things todo add-logged <title> --completed-on [--created-on] [--notes]`** (op `todo.add-logged`, MCP `add_logged_todo`): creates a to-do directly in the Logbook with backdated timestamps via `things:///json` (lab scf2 P4d) — for importing history from another system. Undo deletes the created row.
- **`things reorder --scope headings`**: reorders a project's heading rows (children move with their heading) — the private reorder command accepts heading uuids (lab scf P1).
- **`things reorder --scope someday`**: reorders loose someday to-dos. The app's Someday handler stacks sent ids above the list's original top (lab P6h/P7e), so the compiler emits a validated two-call protocol that realizes the exact requested order (lab P8b). Someday projects are rejected until their behavior is characterized.
- **`things reorder --scope projects`**: orders the TOP-LEVEL sidebar projects — a capability with no native surface at all — by bouncing each project through a verified `when=someday → when=anytime` round-trip, which front-inserts it (lab P7c/P7d/P8e; exact order, schedule state preserved). Plain Anytime undated area-less projects only, max 10 per call; projects inside areas already reorder natively via `--scope area`.

## 0.4.0 — 2026-07-09

### Anytime/Someday view semantics + CLI list polish

- **Anytime container cascade (fix)**: children of projects that are not themselves anytime-visible (someday, future-scheduled, logged, or trashed) no longer appear in `anytime` — the project row represents them, matching the app. Heading-contained children resolve their project through the heading link.
- **Sidebar-grouped anytime/someday**: both views now return sidebar-ordered sections (area + items; the area-less block first, direct to-dos before each project block) — the same order the app shows in Anytime and the sidebar. The CLI renders one `── <area> ──` header per area; `--json` envelopes and the MCP `read_view` tool carry the new sectioned shape.
- **`things someday --active-project-items`** (MCP: `read_view {active_project_items}`): also lists someday to-dos inside active projects — the app's "Show items from active projects" toggle. By default someday shows only container-less members and someday project rows, as the app does.
- **CLI list rendering**: the uuid column pads to the longest uuid in the list (Things uuids vary 21–22 chars), token spacing after the `-`/`P` marker is uniform (previously the gap depended on whether dates/tags were present), and metadata is colorized when stdout is a TTY (deadline red, date yellow, tags cyan, uuid/context dim, area headers bold; `NO_COLOR`/`FORCE_COLOR` honored). Piped output contains no escape codes.


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
