# Capability gaps — what the API cannot do (yet), and why

Living register of Things-app capabilities that are missing, thin, or janky in things-api, with evidence refs and the planned path (or the reason none exists). Assessed 2026-07-04, post-Phase-7, mid-Phase-8 (reorder in flight on `mg/phase8-reorder`).

## Headline gaps

### 1. Headings in existing projects — the big one; Shortcuts is the only path
- Create works ONLY inside a brand-new project via the `things:///json` add-project payload — and `project.add` doesn't expose even that yet (small win available).
- In an existing project: no create/rename/archive/delete on any validated surface (`heading=` never creates, T09/U09; json update op on headings errors, U10; AppleScript has no heading class, A31).
- Native reorder RIPS headed children out of their headings (O06) — heading-scoped ordering is unautomatable.
- **Path:** finish the L5 golden sitting (Find→act chain proxies, golden-runbook §5) → S-campaign → Shortcuts vector for `heading.add/rename/delete` (+ probe archive). This is the sole capability Shortcuts uniquely provides.

### 2. Repeating items — creation and rule-editing are UI-only, permanently (until CC ships an API)
- No surface creates a repeating item or edits a repeat rule: URL crashes on schedule-writes (the bug report), AppleScript refuses (error 302), Shortcuts actions expose no repeat parameters, and the rule plist must never be written directly.
- The clone-and-rename workaround is DISPROVEN (E13, 2026-07-05): `duplicate=true` on a template duplicates nothing and opens windows (tier 3) — oddity 5d.
- What works: safe template edits (title/notes/checklist — U12B/T12), full editing of spawned instances (guards only block templates), reading rule presence + config via the private `json` property (A51).
- **Path:** none. Document; guard (done); revisit per Things release.

### 3. Reminders (time-of-day) — SHIPPED (Phase 9b + 12b)
- `--reminder HH:mm` on todo add/update with when today|evening|YYYY-MM-DD (R17/R18); auto-preserve on re-schedule; `--clear-reminder` on today|evening. **Dated reminders are STICKY** (R20/R21): no URL clear path exists — the guard rejects `--clear-reminder` on dated whens with the bounce-via-today remediation (oddity 2e). Bare-hour parser trap is today/evening-only (R19).

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
| Convert to-do ↔ project | `move to do ... to list "Projects"` errors: `Can't get list "Projects"` — the sidebar entry isn't a scriptable list (E16). No other surface known. |
| Un-nest a tag to root | `set parent tag ... to missing value` errors (−1700): the property accepts only a tag specifier (E19). Workaround: re-parent under a scratch root tag, or fix in the app. |
| Sidebar AREA ordering | `move area ... to before area ...` errors (location specifier unsupported, O13); the private reorder command has no area-of-areas form. Areas order by their `"index"` — UI-only. |

## Ordering (LANDED — Phase 8, `things reorder` / `write.reorder`)

- Shipped: Today (native, bucket-0 members incl. scheduled projects — O01/O12), project + area scopes (native, un-headed children only — O06), Evening via verified bounce (O07/O08). Native is experimental-gated (config `allow-experimental` + sdef canary); see [docs/lab/o-suite-results.md](lab/o-suite-results.md).
- Remaining gaps: heading-scoped ordering (unautomatable, O06); sidebar area-among-areas ordering (DEAD — O13, see Tier-2 verdicts); checklist-item order (likely unautomatable — no granular checklist surface anywhere). Projects WITHIN an area now reorder natively (O14, Phase 14b).

## Read-layer gaps

| Gap | Detail |
|---|---|
| ~~Tag-filtered list reads~~ | **SHIPPED 2026-07-04 (Phase 10a)**: `--tag <ref>` on today/inbox/anytime/upcoming/someday/logbook — direct OR inherited via the heading→project→area chain (single SQL predicate mirroring `inheritedTagsFor`). Tag-HIERARCHY descendant matching (filter by parent matches child-tagged items, as the UI does) is unvalidated — not offered yet. |
| ~~Today ordering fidelity~~ | **SHIPPED 2026-07-04 (Phase 10c)**: UI-oracle research cracked both the comparator (`bucket, referenceDate DESC, todayIndex, uuid` — newest-entry cohorts on top; the app never normalizes at launch) AND a membership rule nobody had: **due deadlines pull items into Today** (even from Inbox) unless a future startDate or a dismissed nag (`deadlineSuppressionDate`) suppresses. Exact live reconciliation: 393=393 members, top-10 10/10. See [docs/lab/today-order-research.md](lab/today-order-research.md). |
| ~~Upcoming repeat occurrences~~ | **SHIPPED 2026-07-04 (Phase 10b)**: `upcoming` now synthesizes each fixed template's next occurrence from `rt1_nextInstanceStartDate` (paused/after-completion excluded), with the deadline derived from the decoded rule (`deadline = start − ts`, instance-validated). Rule plist fully decoded READ-ONLY (`src/model/recurrence.ts`; schema in the atlas); `byUuid` exposes `repeating.rule`/`nextOccurrence`/`paused`. Not yet done: occurrences BEYOND the next one (needs a full occurrence generator — evidence exists in the rule model if ever needed). |
| ~~Checklist state granularity~~ | **Already covered** — `byUuid` returns the checklist with per-item `status` from TMChecklistItem (the old register entry was stale). Writes stay wholesale-replace everywhere (app limitation, all surfaces). |

## Deliberately excluded (not gaps)

UI navigation (`show`, quick entry panel — tier 2–3, probed A53/A54); Things Cloud sync verification (out of scope); direct DB writes (forbidden, sync corruption); tombstone semantics with sync off (A25/A27 — sync artifact).

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

Permanently out of reach (documented + guarded, revisit per Things release): repeat creation/rule-editing; checklist granular writes; to-do↔project conversion; tag un-nest to root; sidebar area ordering.
