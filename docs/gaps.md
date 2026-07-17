# Capability gaps — what the API cannot do (yet), and why

Living register of Things-app capabilities that are missing, thin, or janky in things-api, with evidence refs and the planned path (or the reason none exists). First assessed 2026-07-04 and kept current since: the Phase-8 reorder shipped that day, and later work — the Shortcuts write vector (§A.2) and the Phase-21 environment-awareness campaign among it — is documented in the body below.

> The full CRUD × vector picture (everything that works, not just the gaps) lives in **[capability-matrix.md](capability-matrix.md)** — the living wish-list/checklist. Keep both current in the same change (see repo `CLAUDE.md`).

## Headline gaps

### 0. Headings doctrine — DECIDED 2026-07-09: FIRST-CLASS, no flatten mode

**Final decision (see [docs/roadmap.md](roadmap.md) §E): headings are always first-class; there is NO flatten or dual mode.** The flatten plan was motivated by "headings barely work without Shortcuts" and "their index makes flat reads incoherent" — both premises are now false. AppleScript unblocked heading rename/archive/delete/reorder + placement (P10/P11, docs/lab/heading-research.md), leaving ONLY `heading.create`-in-an-existing-project Shortcuts-gated; and v0.6.0 HID `index`/`todayIndex`, removing the incoherence entirely. Reads stay heading-aware (free, SQLite); writes are capability-gated — `heading.create` reports `unsupported` + a `things setup shortcuts` remediation when Shortcuts is unconfigured (the `allow-experimental` pattern). No silent clobbering (O06 stays a guard). The prior flatten-by-default text is retired.

**§A/§B onboarding LANDED (2026-07-09):** the six proxies ship as signed `.shortcut` files in the npm package; `things setup shortcuts` installs them (one "Add Shortcut" click each); `things doctor` reports the on-disk "Enable Things URLs" state + proxy presence. The HX sweep (heading-research.md) exhaustively closed every non-Shortcuts create/relocate path.

**Shortcuts write vector WIRED (2026-07-11, §A.2):** `heading.create` is now a shipped pipeline op (`things heading add <project> <title>`, `create_heading` MCP) delivered through `things-proxy-create-heading`, capability-gated on the installed proxies — a missing proxy blocks with a `things setup shortcuts` remediation (not the old `unsupported`), and a first-run timeout is attributed to consent. No transactional undo (heading delete is interactive-only, −1728) — `things undo` reports it irreversible. Seam-tested only; live end-to-end proof deferred (Mike smoke-test / a future Shortcuts-capable lab runner).

### 1. Headings in existing projects — SOLVED via Shortcuts (L5 sitting, 2026-07-09)
- **Create / rename / delete a heading in an existing project all WORK via Shortcuts** (S02/S03/S04, [s-campaign-results.md](lab/s-campaign-results.md)) — `things-proxy-create-heading` / `-edit-title` / `-delete-items`. The sole capability Shortcuts uniquely provides, now proven.
- Still dead elsewhere: `heading=` never creates (T09/U09), json update op on headings errors (U10), AppleScript has no heading class (A31); native reorder RIPS headed children out (O06) so heading-*scoped ordering* stays unautomatable; heading *move* is DEAD on every surface (`set-detail` Parent is a silent no-op — scf P2, 2026-07-09); non-empty-heading delete (child re-parenting) unprobed. NEW (scf P1): **the headings THEMSELVES reorder natively** — the private reorder command accepts heading uuids as project children ([s-campaign-results.md](lab/s-campaign-results.md) follow-ups).
- **P10/P10b rewrite (2026-07-09, [heading-research.md](lab/heading-research.md)):** AppleScript addresses heading rows BY ID — rename (`set name`) and ARCHIVE/un-archive (`set status`) work with no Shortcuts at all; archive on a non-empty heading cascades to children. Delete stays impossible headlessly (AS −1728; Shortcuts delete-class consent), but empty-then-archive is a reversible, consent-free equivalent. Heading move: dead on four surfaces. SUSPECTED crash: `schedule` on a heading (oddities §6) — todo ops now hard-block non-to-do targets.
- ~~**Remaining path:** ship `heading.rename` / `heading.archive` (AppleScript, no setup) + `heading.add` via a Shortcuts WriteVector behind the availability interface~~ — **ALL SHIPPED.** `heading.rename`/`heading.archive`/`heading.unarchive` on AppleScript (v0.7.0); `heading.create` on the Shortcuts vector (`things heading add`, 2026-07-11) behind the proxy-availability gate. Consent caveat holds: create is headless after one Always-Allow grant, row-delete is tier-3 user-present (stays out).

### 2. Repeating items — no HEADLESS surface; the ui write vector now drives the GUI for the make/edit/pause/resume family

- No **headless** surface creates a repeating item or edits a repeat rule: URL crashes on schedule-writes (the bug report), AppleScript refuses (error 302), Shortcuts actions expose no repeat parameters, and the rule plist must never be written directly.
- The clone-and-rename workaround is DISPROVEN (E13, 2026-07-05): `duplicate=true` on a template duplicates nothing and opens windows (tier 3) — oddity 5d.
- What works headlessly: safe template edits (title/notes/checklist — U12B/T12), full editing of spawned instances (guards only block templates), reading rule presence + config via the private `json` property (A51).
- **Path — the ui write vector (tier-3, two-key gated, certification-tracked; NOT headless).** Making an existing item repeat and editing/pausing/resuming its rule now ship by driving the real Things GUI through the Accessibility API for BOTH to-dos and projects: `todo.make-repeating` / `todo.reschedule-repeat` / `todo.pause-repeat` / `todo.resume-repeat`, `project.make-repeating` / `project.reschedule-repeat` / `project.pause-repeat` / `project.resume-repeat`, plus the `project.create-repeating` composite (a brand-new repeating project). **[capability-matrix.md](capability-matrix.md) (Repeating-items rows) carries the authoritative per-op status** — most are lab-certified; each is fail-closed behind `ui.enabled` + `--dangerously-drive-gui`. Remaining caveats: **`todo.stop-repeat` was DROPPED** (Stop is card-only, opens only on a mouse double-click) and there is **no `project.stop-repeat`** (the stop-then-select crash, oddities §7 C5); brand-new *repeating to-do* creation (`File → New Repeating To-Do`) is not a shipped op; per-instance reminder times in the repeat dialog are refused fail-closed (§8l). Document; guard the headless surfaces (done); revisit per Things release.

### 3. Reminders (time-of-day) — SHIPPED (Phase 9b + 12b)
- `--reminder HH:mm` on todo add/update with when today|evening|YYYY-MM-DD (R17/R18); auto-preserve on re-schedule; `--clear-reminder` on today|evening. **Dated reminders are STICKY on the URL scheme** (R20/R21): no URL clear path exists — the URL-based `--clear-reminder` guard rejects dated whens with the bounce-via-today remediation (oddity 2e). Bare-hour parser trap is today/evening-only (R19). **UPDATE 2026-07-11: dated-reminder clear now SHIPS via the Shortcuts vector** — `things todo clear-reminder <uuid>` (`clear_reminder` MCP, op `todo.clear-dated-reminder`) clears the reminder while keeping the scheduled date (`things-proxy-set-detail` Reminder Time="", scf P3b); capability-gated behind `things setup shortcuts`, headless after one Always-Allow. Setting a dated reminder is still dead everywhere (scf2 P3a).

## Editing-completeness gaps — SHIPPED 2026-07-04 (Phase 9b: area update, tag update, notes append/prepend, move-to-inbox, todo duplicate; `log completed now` still unexposed — DB delta unclear, low value)

| Gap | Evidence (see [docs/lab/e-suite-results.md](lab/e-suite-results.md)) |
|---|---|
| `area.update` — rename | `set name of area` works (E01). |
| `tag.update` — rename, re-parent, keyboard shortcut | All three work; assignments survive rename (E02/E03/E10). |
| Notes append/prepend | URL params work, newline separator (E04/E05). |
| Move to Inbox | AppleScript `move to list "Inbox"` de-schedules cleanly (E06). |
| Duplicate to-do | URL `duplicate=true` works (E07); AppleScript duplicate REFUSED by the app (E08) — URL is the only path. |
| `log completed now` | Probed (A28), trivial to expose. |
| Project scheduling evidence | `update-project?when=<date>` firm (E09). |

## Tier-2 verdicts (Phase 14, 2026-07-06) — four ops shipped, three dead ends locked

**Shipped (Phase 14b):**

| Capability | Evidence |
|---|---|
| `project move --area` — move a project between areas | `set area of project id X to area id Y` works; status/schedule untouched (E14). |
| `todo restore` — un-trash a to-do (the UI's Put Back, scripted) | `move <trashed to-do> to list "Inbox"` flips trashed→0; lands in the Inbox DE-SCHEDULED — prior list/schedule not restored (E15). To-dos only: project restore is unprobed (move-project-to-Inbox is nonsensical), guard restricts. Unlocks the delete-undo path (Phase 15). |
| `project duplicate` — copy a project INCLUDING children | `update-project?duplicate=true` (E17); create-probe discovery like todo.duplicate. |
| `project update --append-notes/--prepend-notes` | Newline-joined, same semantics as to-dos (E18). |
| `reorder --scope area` now accepts PROJECT members | The private command takes project uuids in an area specifier (O14). Same-type requests only — mixed to-do+project wire lists are unprobed and H-REORDER-SCOPE rejects them. |

**Dead ends (regression-locked unsupported — revisit per Things release):**

| Capability | Why it's dead |
|---|---|
| Convert to-do ↔ project | `move to do ... to list "Projects"` errors: `Can't get list "Projects"` — the sidebar entry isn't a scriptable list (E16). Dead on every HEADLESS surface, but NO LONGER a flat gap: **`todo.convert-to-project` ships via the ui write vector** (tier-3, gated, LAB-CERTIFIED — see [capability-matrix.md](capability-matrix.md) To-dos "Convert to project" row for the authoritative status). `heading.convert-to-project` ships on the same vector and is **now LAB-CERTIFIED too** (HEADCERT1, 2026-07-17 — reveal the heading's PARENT PROJECT, then select the heading as a content-table row by position via the pure-AX `select` action). Project→to-do conversion is still unbuilt. |
| Un-nest a tag to root | **SHIPPED 2026-07-07**: `tag update --unnest` via AppleScript's property-DELETE form (P29). The set-form still errors (E19/P28), and the old scratch-parent workaround idea was dead anyway (P16 cascade delete). |
| Sidebar AREA ordering | `move area ... to before area ...` errors (location specifier unsupported, O13); the private reorder command has no area-of-areas form. Areas order by their `"index"`. No HEADLESS path, but CLOSED: **`area.reorder` (né `area.reorder-sidebar`, renamed #166) ships via the ui write vector** (tier-3, gated, LAB-CERTIFIED — [capability-matrix.md](capability-matrix.md) Ordering ▸ "Sidebar: areas"). |

## Ordering (LANDED — Phase 8, `things reorder` / `write.reorder`)

- Shipped: Today (native, bucket-0 members incl. scheduled projects — O01/O12), project + area scopes (native, un-headed children only — O06), Evening via verified bounce (O07/O08). Native is experimental-gated (config `allow-experimental` + sdef canary); see [docs/lab/o-suite-results.md](lab/o-suite-results.md).
- Remaining gaps: heading-scoped ordering (unautomatable, O06); checklist-item order (likely unautomatable). Sidebar AREAS among areas were exhaustively dead on every HEADLESS surface (O13 + scf2 P6e/f/g + P9b/c: every sdef-admissible specifier no-ops, creation appends at 0, no list contains areas) — now CLOSED via the ui write vector (`area.reorder`, tier-3, gated, LAB-CERTIFIED; see [capability-matrix.md](capability-matrix.md)). SOLVED 2026-07-09 and SHIPPED: heading reorder (`--scope headings`, scf P1); someday loose to-dos AND area-less someday projects (`--scope someday`, per-type two-call protocols — P8b ascending, P9e descending); **top-level sidebar PROJECT order via Mike's bounce insight** (`--scope projects`, when= round-trips — P8e; native stays dead, re-confirmed P9d). Anytime loose-to-do ordering is CLOSED (P13: the write is non-deterministic — identical inputs give different orders — because Anytime is a computed aggregate, not a flat index list; will not ship).

## Read-layer gaps

| Gap | Detail |
|---|---|
| ~~Tag-filtered list reads~~ | **SHIPPED 2026-07-04 (Phase 10a)**: `--tag <ref>` on today/inbox/anytime/upcoming/someday/logbook — direct OR inherited via the heading→project→area chain (single SQL predicate mirroring `inheritedTagsFor`). Tag-HIERARCHY descendant matching (filter by parent matches child-tagged items, as the UI does) is unvalidated — not offered yet. |
| ~~Today ordering fidelity~~ | **SHIPPED 2026-07-04 (Phase 10c)**: UI-oracle research cracked both the comparator (`bucket, referenceDate DESC, todayIndex, uuid` — newest-entry cohorts on top; the app never normalizes at launch) AND a membership rule nobody had: **due deadlines pull items into Today** (even from Inbox) unless a future startDate or a dismissed nag (`deadlineSuppressionDate`) suppresses. Exact live reconciliation: 393=393 members, top-10 10/10. See [docs/lab/today-order-research.md](lab/today-order-research.md). |
| ~~Upcoming repeat occurrences~~ | **SHIPPED 2026-07-04 (Phase 10b)**: `upcoming` now synthesizes each fixed template's next occurrence from `rt1_nextInstanceStartDate` (paused/after-completion excluded), with the deadline derived from the decoded rule (`deadline = start − ts`, instance-validated). Rule plist fully decoded READ-ONLY (`src/model/recurrence.ts`; schema in the atlas); `byUuid` exposes `repeating.rule`/`nextOccurrence`/`paused`. **Occurrences beyond the next one SHIPPED 2026-07-06 (Phase 16)**: `upcoming --horizon <n>` projects up to 10 per template from the decoded rule (fixed rules only; honors ed/rc; calendar conventions documented in src/model/occurrences.ts; 56-template live sanity pass). |
| ~~Checklist state granularity~~ | **Already covered** — `byUuid` returns the checklist with per-item `status` from TMChecklistItem (the old register entry was stale). Writes stay wholesale-replace everywhere (app limitation, all surfaces). |

## Deliberately excluded (not gaps)

UI navigation (`show`, quick entry panel — tier 2–3, probed A53/A54); Things Cloud sync verification (out of scope); direct DB writes (forbidden, sync corruption); tombstone semantics with sync off (A25/A27 — sync artifact).

## Acknowledged absences (real gaps the rest of the docs never name)

Surfaced in the 2026-07-16 drift review — genuine limits with no register entry anywhere else. Recorded here so they are not mistaken for oversights:

- **File / image attachments** — Things stores note attachments, but no write vector exposes them and no probe has ever targeted them (the only mention is a probe-hunt TODO in [lab/l5-build-cards.md](lab/l5-build-cards.md)). There is no add/read/remove-attachment capability, by omission rather than by decision.
- **Full-database export / backup-restore** — `things batch` (JSONL through the pipeline) and `things changes --since` (incremental delta scan) exist, but there is **no whole-library snapshot, export, or restore story**. Backup is the app's / iCloud's concern; we offer no dump-and-reload path and make no durability promise.
- **English-locale-only doctrine (ui vector)** — every ui-vector recipe pins **English element titles** and refuses fail-closed under a non-English app locale ([design/ui-vector.md](design/ui-vector.md) "Localization pinning"). The GUI-driven ops are therefore unavailable on a localized Things install until (and unless) AXIdentifier-based addressing replaces the title-pinned steps.
- **No watch / subscribe mode** — there is no push, long-poll, or event-stream surface. `things changes --since <timestamp>` is the **pull-based substitute**: a consumer polls for what changed since it last looked (README example). A live "notify me when the DB changes" mode is not offered.

## Shortcuts verdict (for planning)

Fills: **headings in existing projects** (unique), maybe heading-archive + reminder property (S-probes). Does NOT fill: repeat rules, checklist granularity, area/tag editing (AppleScript already better at tier 0). Everything else it offers is redundant with validated tier-0 vectors.

## Roadmap (agreed 2026-07-04; tracked as tasks #23–#27)

1. **Phase 8 (DONE 2026-07-04)** — `write.reorder` landed: today/project/area native + evening bounce, experimental gate + sdef canary, H-REORDER-SCOPE guard, e2e-validated in the VM.
2. **Phase 9a (DONE 2026-07-04)** — R-suite (16 probes) + E-suite (12 probes) locked; reminderTime codec closed; parser trap pinned (oddity 2d).
3. **Phase 9b (DONE 2026-07-04)** — reminder vocabulary, area.update, tag.update, notes modes, inbox move, todo.duplicate; e2e 43/43.
4. **Phase 10 (DONE 2026-07-04, all of it)** — 10a tag-filtered reads; 10b recurrence decode + upcoming occurrence synthesis; 10c Today fidelity (UI-oracle comparator + deadline-driven membership incl. nag suppression, exact 393=393 live reconciliation). The read layer is now UI-faithful.
5. **Phase 11 (blocked on Mike's L5 sitting)** — S-campaign → Shortcuts vector → heading ops in existing projects; plus `project.add` json-payload headings (small win, independent of Shortcuts). Task #27.
6. **Phase 12 (DONE 2026-07-05)** — search ergonomics (open+untrashed default, scoping flags, `--exact-tag`), tag-hierarchy descendants on `--tag`, dated reminders, template-duplication verdict (E13: DISPROVEN).
7. **Phase 13 (DONE 2026-07-06)** — `things batch` (JSONL through the full pipeline) + `things changes --since` (userModificationDate scan).
8. **Phase 14 (DONE 2026-07-06)** — Tier-2 probe campaign (E14–E19, O13–O14) + ops: project move/duplicate, todo restore, project notes modes, area-scope project reorder; dead ends locked (convert, tag un-nest, sidebar area order). Tasks #32–#33.
9. **Phase 15 (DONE 2026-07-06)** — `things undo [--last N]`: inverse mutations replayed from the audit trail's pre-values (status flips, field restores, delete→restore via E15, tag/checklist sets, native-reorder rank restore). Every inverse runs the full guarded+verified pipeline; irreversible ops (permanent deletes, project complete/delete, uncaptured pre-state) are reported honestly, never guessed. Task #34.
10. **Phase 16 (DONE 2026-07-06)** — occurrence generator over decoded repeat rules + `upcoming --horizon <n>`; v0.2.0 release (changelog, pack-smoke, README refresh). Task #35.
11. **Phase 17 (DONE 2026-07-06)** — seam hygiene (contracts into core, diagnose()/capabilitiesTable() as library functions) + `things mcp` stdio MCP server (16 tools over the same ThingsClient). Task #36.
12. **Phase 18 (DONE 2026-07-06)** — P-suite (18 probes, [docs/lab/p-suite-results.md](lab/p-suite-results.md)): project cancel/reopen/restore all WORK; granular checklist states via things:///json WORKS; un-schedule + clear-container semantics pinned; empty-replacement clears validated. Closed permanently: project/todo area removal, tag un-nest (parent-delete CASCADE-DELETES children — new tag.delete hazard needed), top-level sidebar ordering. Task #37.
13. **Phase 19 (DONE 2026-07-06)** — the P-suite verdicts shipped: `project cancel/reopen/restore` (reopen composite with the P03 cascade-window `--restore-children`; undo now reverses project complete/cancel/delete), one-step container detach (`todo move --detach`, `project move --detach`; URL empty params), URL vector for project moves, granular checklist ops (`todo checklist --check/--uncheck/--add/--remove/--rename/--move-item` over things:///json with per-item states preserved), empty-set tag/checklist clears, H-TAG-SUBTREE-DELETE guard. Task #38.
14. **P-suite third sweep (2026-07-07)** — P28–P30: tag un-nest UNLOCKED via the AppleScript property-DELETE form (P29 — `delete parent tag of tag X`); shipped as `tag update --unnest` (undo re-nests / un-nests symmetrically). Empty-string and move-verb spellings rejected (P28/P30). Suite locked at 30 probes.
15. **Phase 20 (DONE 2026-07-07)** — MCP v2: 31 grouped semantic tools, live-inventory server instructions, tool annotations; surface-copy contract ([docs/design/surface-copy.md](design/surface-copy.md)) applied across MCP descriptions, CLI help, and exported JSDoc, locked by banned-vocabulary regression tests. PRs #34/#35.
16. **Phase 21 (IN PROGRESS; task #3)** — environment awareness + failure attribution. Shipped in 21a (host-only): `likelyCause` failure hints (consent signatures −1743/−1712/deadline-kill, token-less URL no-ops, app-update theory), environment tuple tracking (`environment.json`; doctor reports the diff; post-change successful writes warn), `doctor --probe-automation`, and the setup.md consent-hardening ladder. **Phase 21b probes DONE (2026-07-09, [docs/lab/phase21b-research.md](lab/phase21b-research.md))** — lab-grounded verdicts: (a) all four TCC signatures reproduced in-VM (granted / pending via deadline-kill / pending via `-1712` AppleEvent-timeout / denied via `-1743`, instant-fail on retry); (b) **the enabled/disabled state is `uriSchemeEnabled` (int-bool) in the group-container plist** — NOT the standard defaults domain, NOT a TMSettings column; token PERSISTS while disabled and does NOT rotate, so Phase 21a's "null-token ⇒ feature-disabled" heuristic must be **corrected** to key on `uriSchemeEnabled=0` and/or the non-landing-write + enable-modal; (c) piggyback wish-list closed — project tags (URL+AS), project reminders, tag-shortcut clear all WORK; inbox reorder WORKS; single-item permanent delete DEAD. **Remaining (task #4):** implement the newly-opened ops, correct the feature-disabled classifier, and build the advisory vector-availability layer in the planner (doctor reads `uriSchemeEnabled`; Shortcuts slots into the same interface when Phase 11 lands).

Permanently out of reach (documented + guarded, revisit per Things release): repeat creation/rule-editing; to-do↔project conversion; project/to-do area-removal via AppleScript or json (URL empty-param is the sole path — shipped); sidebar (area + top-level project) ordering. Formerly listed, since CLOSED: checklist granular writes (P18, Phase 19), tag un-nest (P29).
