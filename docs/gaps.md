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

### 3. Reminders (time-of-day) — documented URL feature, never probed, unexposed
- `when=today@18:00` style reminders exist in the URL docs; `TMTask.reminderTime` codec is an open atlas item.
- **Path:** probe suite (encoding + set/clear semantics + repeating hazard interaction) → extend `when` vocabulary. Probably the most user-visible gap after headings. Check whether Shortcuts' Edit Items exposes a Reminder property while S-probing.

## Editing-completeness gaps (all cheap: AppleScript setters + one probe suite)

| Gap | Evidence/path |
|---|---|
| `area.update` — rename; change tags post-creation | `set name of area` unprobed (standard setter); `set tag names of area` already validated (seeding). |
| `tag.update` — rename, re-parent existing, keyboard shortcut | `set parent tag` validated at creation (A05); rename unprobed. |
| Notes append/prepend | URL `append-notes`/`prepend-notes` params documented, unprobed; we only replace. |
| Move to Inbox | `todo.move` covers project/area/heading only; AppleScript `move to list "Inbox"` unprobed. |
| Duplicate to-do/project | Exists on all three surfaces (URL `duplicate=true`, AppleScript `duplicate`, Shortcuts); never probed. |
| `log completed now` | Probed (A28), trivial to expose. |
| Project scheduling evidence | `project update --when` compiles but only `completed=true` was specifically probed (U08) — firm up with one probe. |

## Ordering (Phase 8, in flight)

- Landing now: Today (native, bucket-0 members only — O03: evening members get silently de-eveninged), project + area scopes (native, un-headed children only — O06), Evening via verified bounce (O07/O08).
- Still unprobed: sidebar ordering (areas among areas; projects within an area), checklist-item order (likely unautomatable — no granular checklist surface anywhere).

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
