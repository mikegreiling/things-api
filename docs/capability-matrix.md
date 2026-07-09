# Capability matrix — CRUD across write surfaces

**This is a LIVING DOCUMENT and the project's feature wish-list.** Update it in the same change as: any operation-catalog edit (`src/write/operations.ts`), any vector-matrix edit, any new probe verdict, or any gap opened/closed. Its sibling [things-app-oddities.md](things-app-oddities.md) (the future Cultured Code report) has the same contract: record every newly discovered app bug/quirk when it's found, not later. Both reminders also live in the repo `CLAUDE.md`.

Every **read** is complete and vector-independent (direct SQLite): views, detail, tags/areas/projects, search, changes, repeat-rule decoding, occurrence projections. The one read caveat: **sidebar order** (areas, top-level projects) is provisional — AppleScript enumeration does not match the sidebar (P19), so `index`-based reads are best-effort. This matrix therefore tracks **writes**.

Legend: ✅ shipped & lab-validated · 🟡 works with caveats · 🧪 plausible but unprobed (**wish list**) · 🚫 validated dead end (revisit per Things release) · ⛔ the app has no such concept · ➖ not applicable. Probe ids cite [docs/lab/](lab/harness.md) evidence; the authoritative op×vector data is `things capabilities`.

The **Shortcuts** column is almost entirely 🧪: the S-campaign is blocked on the golden image's L5 sitting ([golden-runbook.md §5](lab/golden-runbook.md)).

## To-dos

| Capability | URL scheme | AppleScript | Shortcuts | Notes |
|---|---|---|---|---|
| Create | ✅ | ✅ | 🧪 | tags must pre-exist (app silently drops unknowns); reminder via `when=<list>@<time>` |
| Update title/notes | ✅ (+append/prepend) | 🟡 partial | 🧪 | notes modes newline-joined (E04/E05) |
| Schedule (today/evening/someday/date) | ✅ | 🟡 | 🧪 | 🚫 on repeating templates (crash — hard-blocked) |
| Set reminder | ✅ today/evening/date | ⛔ no property | 🧪 | deterministic time emitter routes around the bare-hour parser trap (oddity 2d) |
| Clear reminder | 🟡 today/evening only | ⛔ | 🧪 | dated reminders are STICKY (R20/R21, oddity 2e) — workaround: bounce via `when=today` first |
| Set/clear deadline | ✅ | 🟡 | 🧪 | |
| Complete / cancel / reopen | ✅ | ✅ | 🧪 | |
| Move to project/area (+existing heading) | ✅ | 🟡 no heading | 🧪 | unknown destinations guarded (app is a silent no-op) |
| Move to Inbox | 🚫 | ✅ | 🧪 | de-schedules (E06) |
| Detach from ALL containers (keep schedule) | ✅ empty `list-id=` (P21/P22) | 🚫 (all nil spellings fail) | 🧪 | |
| Tags: replace/clear | ✅ (empty set clears, P14) | ✅ `set tag names` | 🧪 | add/merge is a client-side read-merge-replace |
| Checklist: wholesale replace | ✅ (destroys item state — ack required; empty clears, P15) | 🚫 no access (A30) | 🧪 | |
| Checklist: granular + stateful edits | ✅ `things:///json` per-item `completed` (P18) | 🚫 | 🧪 | item uuids not stable across a rewrite; match by title |
| Duplicate | ✅ `duplicate=true` | 🚫 refuses (−1717) | 🧪 | |
| Delete (→ Trash) | 🚫 (tier-3 UI only) | ✅ | 🧪 | |
| Restore from Trash | 🚫 | 🟡 → Inbox, de-scheduled (E15) | 🧪 | prior container/schedule not restored |
| Permanently delete ONE item | 🧪 | 🚫 (all spellings fail, B0/A5) | 🧪 | `delete to do id` on a trashed row → −1728; `list "Trash"` addressings → silent no-op. Only `trash.empty` (all-or-nothing) hard-deletes |
| Convert to project | 🚫 (E16) | 🚫 | 🧪 | S-campaign candidate |

## Projects

| Capability | URL scheme | AppleScript | Shortcuts | Notes |
|---|---|---|---|---|
| Create (+area, +initial to-dos) | ✅ | ✅ | 🧪 | |
| Create WITH headings (json payload) | 🧪 | ⛔ | 🧪 | queued small win, independent of Shortcuts (gaps roadmap item 5) |
| Update title/notes/when/deadline | ✅ (+append/prepend, E18) | 🟡 | 🧪 | 🚫 schedule edits on repeating projects |
| Set reminder on a project | ✅ (`update-project?when=<list>@time`, A3) | ⛔ no property | 🧪 | reminderTime uses the to-do codec (`14<<26\|30<<20`); clear-on-project follows the to-do rules (dated = sticky) |
| Tags on a project | ✅ (`update-project?tags=`, A1) | ✅ (`set tag names of project id`, A2) | 🧪 | both vectors write `TMTaskTag`; tags must pre-exist (to-do rule presumed) |
| Complete (children policy) | ✅ cascades, policy mandatory | 🟡 cascade unvalidated | 🧪 | |
| Cancel (children policy) | ✅ (P01) | 🚫 | 🧪 | completed children untouched |
| Reopen (± restore cascade-resolved children) | ✅ (P02/P05; <2s window P03) | 🚫 | 🧪 | children resolved earlier never touched (P04) |
| Move to area | ✅ (P23) | ✅ (E14) | 🧪 | |
| Detach from area | ✅ empty `area-id=` (P24) — the ONLY surface | 🚫 (P08/P27) | 🧪 | |
| Duplicate (incl. children) | ✅ (E17) | 🚫 | 🧪 | |
| Delete (→ Trash) | 🚫 | ✅ shallow (children keep links) | 🧪 | |
| Restore IN PLACE | 🚫 | ✅ (P06) | 🧪 | schedule/area/children intact |
| Convert to to-do | 🚫 | 🚫 | 🧪 | |

## Headings

Doctrine: treat headings as nonexistent in the API surface (flatten) until the S-campaign settles their fate — documented in [gaps.md §0](gaps.md); dual-mode (first-class with Shortcuts, flattened otherwise) is the candidate shape.

| Capability | URL scheme | AppleScript | Shortcuts | Notes |
|---|---|---|---|---|
| Place a to-do under an EXISTING heading | ✅ (add + move) | 🚫 | 🧪 | |
| Create heading at project creation | 🧪 json payload | ⛔ | 🧪 | queued |
| Create heading in an EXISTING project | 🚫 | 🚫 | 🧪 | **the S-campaign's primary target** |
| Rename / move / delete a heading | 🚫 | 🚫 | 🧪 | |

## Areas

| Capability | URL scheme | AppleScript | Shortcuts | Notes |
|---|---|---|---|---|
| Create (+tags) | 🚫 | ✅ | 🧪 | |
| Rename / replace tags | 🚫 | ✅ (E01) | 🧪 | empty-set tag clear on areas unprobed |
| Delete | 🚫 | ✅ PERMANENT | 🧪 | no Trash for areas; to-dos → Trash, projects orphan to no-area (P20) |
| Restore | ⛔ | ⛔ | ⛔ | deletion is permanent by app design |
| Sidebar reorder | 🚫 | 🚫 (O13) | 🧪 | |

## Tags

| Capability | URL scheme | AppleScript | Shortcuts | Notes |
|---|---|---|---|---|
| Create (+parent) | 🚫 (no command exists) | ✅ | 🧪 | |
| Rename | 🚫 | ✅ assignments survive (E02) | 🧪 | |
| Nest under an existing tag | 🚫 | ✅ (E03) | 🧪 | |
| Un-nest to root | 🚫 | ✅ property-delete form (P29) | 🧪 | the ONE spelling that works |
| Set keyboard shortcut | 🚫 | ✅ (E10) | 🧪 | |
| Clear keyboard shortcut | 🚫 | ✅ `delete keyboard shortcut of tag` (A4) | 🧪 | the P29 property-delete form generalizes to `shortcut` |
| Delete | 🚫 | ✅ PERMANENT, subtree cascades (P16 — ack flag) | 🧪 | |

## Ordering

| Scope | Status | Notes |
|---|---|---|
| Today | ✅ native (experimental gate) or bounce ≤10 | |
| This Evening | ✅ bounce only | native silently de-evenings (O03) |
| Project children (un-headed) | ✅ native (experimental) | headed children rejected (O06) |
| Area members (to-dos OR projects) | ✅ native (experimental) | never mixed in one request (O14) |
| Inbox | ✅ native (experimental) | full reversed wire list re-ranked exactly (A6); joins today/project/area as a validated scope |
| Checklist items | ✅ | granular move via stateful rewrite |
| Sidebar: areas | 🚫 (O13) | |
| Sidebar: top-level projects | 🚫 (P17) | reads provisional too (P19) |
| Anytime/Someday aggregate views | ⛔ | no independent order — derived from container order |

## Repeating items

| Capability | URL scheme | AppleScript | Shortcuts | Notes |
|---|---|---|---|---|
| Create a repeating to-do/project | 🚫 (E13 disproven) | 🚫 (error 302) | 🚫 per docs (no repeat parameters in the actions) | re-verify empirically during the S-campaign; permanently UI-only until Cultured Code ships an API |
| Edit / pause / resume a repeat rule | 🚫 | 🚫 | 🚫 per docs | `rt1_instanceCreationPaused` is DB-only today |
| Skip / advance the next occurrence | 🧪 | 🧪 | 🧪 | wish list — likely dead, unprobed |
| Complete a materialized occurrence | ✅ | ✅ | 🧪 | occurrences are normal to-dos |
| Read rules + project occurrences | ✅ | ➖ | ➖ | decoded read-only; `upcoming --horizon` |
| Schedule/deadline edits on templates | 🚫 hard-blocked | 🚫 | 🧪 | the URL write crashes Things (oddity §1) |

## Trash & system

| Capability | Status | Notes |
|---|---|---|
| Empty Trash (everything) | ✅ AppleScript, PERMANENT | requires the permanent acknowledgement |
| Permanently delete one item | 🚫 | AppleScript spellings all fail (B0/A5); only all-or-nothing `trash.empty` |
| Enable-Things-URLs introspection | ✅ read (`uriSchemeEnabled` in the group-container plist) | **RESOLVED (Phase 21b):** state = `uriSchemeEnabled` int-bool in `~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist` (read via `plutil -p`, not `defaults`). Token PERSISTS while disabled and does NOT rotate across off/on. Disabled write → tier-3 enable-modal (write held, no DB row). See [phase21b-research.md](lab/phase21b-research.md). |
