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
- What works: safe template edits (title/notes/checklist — U12B/T12), full editing of spawned instances (guards only block templates), reading rule presence + config via the private `json` property (A51).
- **Path:** none. Document; guard (done); revisit per Things release.

### 3. Reminders (time-of-day) — SHIPPED 2026-07-04 (Phase 9b)
- `--reminder HH:mm` on todo add/update (when today|evening only — H-REMINDER-SCOPE), auto-preserve on re-schedule, `--clear-reminder`; codec-verified read-after-write; e2e-validated. Remaining edge: reminders on date-scheduled items (`when=2026-07-08@time`) unprobed — guard rejects.

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

## Ordering (LANDED — Phase 8, `things reorder` / `write.reorder`)

- Shipped: Today (native, bucket-0 members incl. scheduled projects — O01/O12), project + area scopes (native, un-headed children only — O06), Evening via verified bounce (O07/O08). Native is experimental-gated (config `allow-experimental` + sdef canary); see [docs/lab/o-suite-results.md](lab/o-suite-results.md).
- Remaining gaps: heading-scoped ordering (unautomatable, O06); sidebar ordering (areas among areas; projects within an area) unprobed; checklist-item order (likely unautomatable — no granular checklist surface anywhere).

## Read-layer gaps

| Gap | Detail |
|---|---|
| Tag-filtered list reads | The UI filters any list by tag INCLUDING inherited; our `read.*` views take no tag parameter. Inheritance model itself is correct (direct `tags` + computed `inheritedTags`, T18/U18/A13) — this is query surface only. |
| Today ordering fidelity | `todayIndexReferenceDate` re-bucketing unresolved — our Today order can mismatch the UI for stale-referenceDate items. Matters more now that we WRITE order. |
| Upcoming repeat occurrences | Templates' future instances aren't synthesized into `upcoming` (the UI shows them). |
| Checklist state granularity | Read per-item state via private `json` (A51) not yet surfaced; writes stay wholesale-replace everywhere (app limitation, all surfaces). |

## Deliberately excluded (not gaps)

UI navigation (`show`, quick entry panel — tier 2–3, probed A53/A54); Things Cloud sync verification (out of scope); direct DB writes (forbidden, sync corruption); tombstone semantics with sync off (A25/A27 — sync artifact).

## Shortcuts verdict (for planning)

Fills: **headings in existing projects** (unique), maybe heading-archive + reminder property (S-probes). Does NOT fill: repeat rules, checklist granularity, area/tag editing (AppleScript already better at tier 0). Everything else it offers is redundant with validated tier-0 vectors.

## Roadmap (agreed 2026-07-04; tracked as tasks #23–#27)

1. **Phase 8 (DONE 2026-07-04)** — `write.reorder` landed: today/project/area native + evening bounce, experimental gate + sdef canary, H-REORDER-SCOPE guard, e2e-validated in the VM.
2. **Phase 9a (DONE 2026-07-04)** — R-suite (16 probes) + E-suite (12 probes) locked; reminderTime codec closed; parser trap pinned (oddity 2d).
3. **Phase 9b (DONE 2026-07-04)** — reminder vocabulary, area.update, tag.update, notes modes, inbox move, todo.duplicate; e2e 43/43.
4. **Phase 10** — read-layer batch, host-only: tag-filtered reads (incl. inherited), Today ordering fidelity (todayIndexReferenceDate), upcoming repeat occurrences, checklist per-item state. Task #26.
5. **Phase 11 (blocked on Mike's L5 sitting)** — S-campaign → Shortcuts vector → heading ops in existing projects; plus `project.add` json-payload headings (small win, independent of Shortcuts). Task #27.

Permanently out of reach (documented + guarded, revisit per Things release): repeat creation/rule-editing; checklist granular writes.
