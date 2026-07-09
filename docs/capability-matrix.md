# Capability matrix — CRUD across write surfaces

**This is a LIVING DOCUMENT and the project's feature wish-list.** Update it in the same change as: any operation-catalog edit (`src/write/operations.ts`), any vector-matrix edit, any new probe verdict, or any gap opened/closed. Its sibling [things-app-oddities.md](things-app-oddities.md) (the future Cultured Code report) has the same contract: record every newly discovered app bug/quirk when it's found, not later. Both reminders also live in the repo `CLAUDE.md`.

Every **read** is complete and vector-independent (direct SQLite): views, detail, tags/areas/projects, search, changes, repeat-rule decoding, occurrence projections. The one read caveat: **sidebar order** (areas, top-level projects) is provisional — AppleScript enumeration does not match the sidebar (P19), so `index`-based reads are best-effort. This matrix therefore tracks **writes**.

Legend: ✅ shipped & lab-validated · 🟡 works with caveats · 🧪 plausible but unprobed (**wish list**) · 🚫 validated dead end (revisit per Things release) · ⛔ the app has no such concept · ➖ not applicable. Probe ids cite [docs/lab/](lab/harness.md) evidence; the authoritative op×vector data is `things capabilities`.

The **Shortcuts** column: the L5 golden sitting is DONE (2026-07-09) and the first S-campaign verdicts are in ([s-campaign-results.md](lab/s-campaign-results.md)) — the heading lifecycle and single-item permanent delete are proven. Remaining 🧪 Shortcuts cells await clone-based S-suite runs.

## To-dos

| Capability | URL scheme | AppleScript | Shortcuts | Notes |
|---|---|---|---|---|
| Create | ✅ | ✅ | 🧪 | tags must pre-exist (app silently drops unknowns); reminder via `when=<list>@<time>` |
| Update title/notes | ✅ (+append/prepend) | 🟡 partial | 🧪 | notes modes newline-joined (E04/E05) |
| Schedule (today/evening/someday/date) | ✅ | 🟡 | 🧪 | 🚫 on repeating templates (crash — hard-blocked) |
| Set reminder | ✅ today/evening/date | ⛔ no property | 🚫 (scf2 P3a — every format no-ops; `Edit Items → Reminder Time` can only CLEAR) | deterministic time emitter routes around the bare-hour parser trap (oddity 2d) |
| Clear reminder | 🟡 today/evening only | ⛔ | ✅ **incl. DATED** (scf P3b, `set-detail` Reminder Time = `""`) | dated reminders are STICKY on URL (R20/R21, oddity 2e) — Shortcuts is the ONLY surface that clears them, and it's headless (output-class consent) |
| Set/clear deadline | ✅ | 🟡 | 🧪 | |
| Complete / cancel / reopen | ✅ | ✅ | 🧪 | |
| Move to project/area (+existing heading) | ✅ | 🟡 no heading | 🚫 text value (scf2 P2b — `set-detail` Parent with a uuid string DETACHES the item instead of moving it, oddity 5l); entity-typed variant 🧪 | unknown destinations guarded (app is a silent no-op) |
| Move to Inbox | 🚫 | ✅ | 🧪 | de-schedules (E06) |
| Detach from ALL containers (keep schedule) | ✅ empty `list-id=` (P21/P22) | 🚫 (all nil spellings fail) | 🧪 | |
| Tags: replace/clear | ✅ (empty set clears, P14) | ✅ `set tag names` | 🧪 | add/merge is a client-side read-merge-replace |
| Checklist: wholesale replace | ✅ (destroys item state — ack required; empty clears, P15) | 🚫 no access (A30) | 🧪 | |
| Checklist: granular + stateful edits | ✅ `things:///json` per-item `completed` (P18) | 🚫 | 🧪 | item uuids not stable across a rewrite; match by title |
| Duplicate | ✅ `duplicate=true` | 🚫 refuses (−1717) | 🧪 | |
| Delete (→ Trash) | 🚫 (tier-3 UI only) | ✅ | 🧪 | |
| Restore from Trash | 🚫 | 🟡 → Inbox, de-scheduled (E15) | 🧪 | prior container/schedule not restored |
| Permanently delete ONE item | 🚫 | 🚫 (all spellings fail, B0/A5) | ✅ interactive (S-delperm, Delete Immediately) | Shortcuts hard-deletes one row (no tombstone) — but the delete consent has NO "Always Allow", so it's tier-3 user-present, never headless. `trash.empty` is the only autonomous hard-delete (all-or-nothing) |
| Convert to project | 🚫 (E16) | 🚫 | 🚫 (no Convert action exists) | dead on every surface (catalog sweep, L5) |
| Backdate Completion/Creation Date (existing item) | 🚫 (`update?completion-date=`/`creation-date=` silent no-ops, scf2 P4c — oddity 2g) | ✅ **shipped** (`todo.backdate` / `things todo backdate`, scf2 P4b) | 🚫 (`set-detail` dead in every format, scf2 P4a) | AppleScript is the ONLY surface; completion requires an already-resolved to-do (H-BACKDATE-OPEN) |
| Backdated import (completed at creation) | ✅ **shipped** (`todo.add-logged` / `things todo add-logged`, scf2 P4d) | 🧪 (make-then-set two-step, untested) | 🚫 | the logbook-import / GTD-migration path |

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

Doctrine: headings were treated as nonexistent (flatten) until the S-campaign settled their fate — [gaps.md §0](gaps.md). **The L5 sitting proved the full heading lifecycle works via Shortcuts (S02–S04)**, so the dual-mode shape (first-class when a Shortcuts vector is configured, flattened otherwise) is now a live path — implementation is Mike's call.

| Capability | URL scheme | AppleScript | Shortcuts | Notes |
|---|---|---|---|---|
| Place a to-do under an EXISTING heading | ✅ (add + move) | 🚫 | ✅ (Create To-Do `Heading` field) | |
| Create heading at project creation | 🧪 json payload | ⛔ | ✅ (Create To-Do/Project) | |
| Create heading in an EXISTING project | 🚫 | 🚫 | ✅ (S02, `Create Heading`) | **only Shortcuts delivers this** — the marquee gap, now closed |
| Rename a heading | 🚫 | 🚫 | ✅ (S03, `Edit Items → Set Title`) | |
| Delete a heading | 🚫 | 🚫 | ✅ (S04, removes the row) | non-empty-heading child re-parenting unprobed |
| Move a heading | 🚫 | 🚫 | 🚫 (scf P2 — `set-detail` Parent is an exit-0 silent no-op) | dead on every surface |
| Reorder headings within a project | 🚫 | ✅ **shipped** (`reorder --scope headings`, scf P1) | ➖ | children follow their heading (FK intact); the command is misleadingly named "reorder to dos" |

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
| Project headings (the headings themselves) | ✅ native (experimental) | heading uuids accepted (scf P1); heading-*scoped* child order still unautomatable (O06) |
| Area members (to-dos OR projects) | ✅ native (experimental) | never mixed in one request (O14) |
| Inbox | ✅ native (experimental) | full reversed wire list re-ranked exactly (A6); joins today/project/area as a validated scope |
| Someday (loose to-dos) | ✅ **shipped** (`reorder --scope someday`) | the list handler STACKS ids above the call's original top (anchor model, P6h/P7e/P8b) — the compile emits the validated two-call protocol (P8b: exact). Someday PROJECTS moved inconsistently (P7a vs P8c) — rejected until locked |
| Checklist items | ✅ | granular move via stateful rewrite |
| Sidebar: areas | 🚫 (O13 + scf2 P6e/f/g) | exhaustively closed 2026-07-09: move-to-location errors (−1700), `set index` read-only (−10006), private reorder no-ops on area uuids; sdef has no other command. The LAST unautomatable ordering |
| Sidebar: top-level projects | ✅ **shipped — BOUNCE** (`reorder --scope projects`, P7c/P7d/P8e) | native writes stay dead (P17 + scf2 P6a–d), but a when=someday→anytime round-trip FRONT-INSERTS (P8e: 3-project sequence exact, state preserved). Plain anytime undated area-less projects only; ≤10/call. Within-area projects: native area scope (O14) |
| Anytime aggregate view (loose to-dos) | 🧪 | the list scope MOVES loose to-dos (P7b — P17 was projects-only) but its convention is unlocked (P7b vs P8d disagree); grouped blocks derive from container order |

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
