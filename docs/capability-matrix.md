# Capability matrix — CRUD across write surfaces

**This is a LIVING DOCUMENT and the project's feature wish-list.** Update it in the same change as: any operation-catalog edit (`src/write/operations.ts`), any vector-matrix edit, any new probe verdict, or any gap opened/closed. Its sibling [things-app-oddities.md](things-app-oddities.md) (the future Cultured Code report) has the same contract: record every newly discovered app bug/quirk when it's found, not later. Both reminders also live in the repo `CLAUDE.md`.

Every **read** is complete and vector-independent (direct SQLite): views, detail, tags/areas/projects, search, changes, repeat-rule decoding, occurrence projections. The one read caveat: **sidebar order** (areas, top-level projects) is provisional — AppleScript enumeration does not match the sidebar (P19), so `index`-based reads are best-effort. This matrix therefore tracks **writes**.

Legend: ✅ shipped & lab-validated · 🟡 works with caveats · 🧪 plausible but unprobed (**wish list**) · 🚫 validated dead end (revisit per Things release) · ⛔ the app has no such concept · ➖ not applicable. Probe ids cite [docs/lab/](lab/harness.md) evidence; the authoritative op×vector data is `things capabilities`.

The **Shortcuts** column: the L5 golden sitting is DONE (2026-07-09) and the first S-campaign verdicts are in ([s-campaign-results.md](lab/s-campaign-results.md)) — the heading lifecycle and single-item permanent delete are proven. Remaining 🧪 Shortcuts cells await clone-based S-suite runs. **Distribution solved (2026-07-09)**: the six proxies ship as signed `.shortcut` files in the npm package; `things setup shortcuts` installs them and `things doctor` reports presence + the on-disk "Enable Things URLs" state. **The Shortcuts WRITE VECTOR is now wired into the pipeline (roadmap §A.2, 2026-07-11)** for the two headless output-class ops that exist on no other surface — `heading.create` (`things heading add`) and `todo.clear-dated-reminder` (`things todo clear-reminder`); both are capability-gated behind the installed proxies (a missing proxy blocks with a `things setup shortcuts` remediation) and are seam-tested only (live end-to-end proof deferred — the lab runner has no Shortcuts arm yet, probe-backlog §C). Single-item permanent delete stays OUT (its delete-class consent has no Always-Allow → never headless).

## To-dos

| Capability | URL scheme | AppleScript | Shortcuts | Notes |
|---|---|---|---|---|
| Create | ✅ | ✅ | 🧪 | tags must pre-exist (app silently drops unknowns); reminder via `when=<list>@<time>` |
| Update title/notes | ✅ (+append/prepend) | 🟡 partial | 🧪 | notes modes newline-joined (E04/E05) |
| Schedule (today/evening/someday/date) | ✅ | 🟡 | 🧪 | 🚫 on repeating templates (crash — hard-blocked) |
| Set reminder | ✅ today/evening/date | ⛔ no property | 🚫 (scf2 P3a — every format no-ops; `Edit Items → Reminder Time` can only CLEAR) | deterministic time emitter routes around the bare-hour parser trap (oddity 2d) |
| Clear reminder | 🟡 today/evening only | ⛔ | ✅ **shipped, incl. DATED** (`todo.clear-dated-reminder`, `things todo clear-reminder`; scf P3b, `set-detail` Reminder Time = `""`) | dated reminders are STICKY on URL (R20/R21, oddity 2e) — Shortcuts is the ONLY surface that clears them, and it's headless (output-class consent). Wired 2026-07-11; capability-gated behind `things setup shortcuts` |
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
| Create WITH headings (json payload) | ✅ (HX0 — `{"type":"heading"}` items in a NEW project's `items` produce real type=2 rows) | ⛔ | 🧪 | validated 2026-07-09; wiring into `project.add` still open |
| Update title/notes/when/deadline | ✅ (+append/prepend, E18) | 🟡 (schedule via `schedule ... project id`, P14-A3) | 🧪 | 🚫 schedule edits on repeating projects — URL when= CRASHES the app (oddity §1/§7) |
| Set reminder on a project | ✅ (`update-project?when=<list>@time`, A3) | ⛔ no property | 🧪 | reminderTime uses the to-do codec (`14<<26\|30<<20`); clear-on-project follows the to-do rules (dated = sticky) |
| Tags on a project | ✅ (`update-project?tags=`, A1) | ✅ (`set tag names of project id`, A2) | 🧪 | both vectors write `TMTaskTag`; tags must pre-exist (to-do rule presumed) |
| Complete (children policy) | ✅ cascades, policy mandatory | 🟡 cascade unvalidated | 🧪 | |
| Cancel (children policy) | ✅ (P01) | 🚫 | 🧪 | completed children untouched |
| Reopen (± restore cascade-resolved children) | ✅ (P02/P05; <2s window P03) | 🚫 | 🧪 | children resolved earlier never touched (P04) |
| Move to area | ✅ (P23) | ✅ (E14) | 🧪 | |
| Detach from area | ✅ empty `area-id=` (P24) — the ONLY surface | 🚫 (P08/P27) | 🧪 | |
| Duplicate (incl. children) | ✅ (E17) | 🚫 | 🧪 | |
| Delete (→ Trash) | 🚫 | ✅ shallow (children keep links) | ✅ interactive, SHALLOW (P12 — project → Trash, children keep their links, untrashed; matches AppleScript) | delete-class consent, tier-3 |
| Restore IN PLACE | 🚫 | ✅ (P06) | 🧪 | schedule/area/children intact |
| Convert to to-do | 🚫 | 🚫 | 🧪 | |

## Headings

Doctrine — **DECIDED 2026-07-09 (roadmap §E / gaps §0): headings are always first-class; there is NO flatten/dual mode.** Only `heading.create` in an existing project is capability-gated (Shortcuts vector); everything else works via AppleScript/URL. The HX sweep ([heading-research.md](lab/heading-research.md)) closed every non-Shortcuts create/relocate escape hatch.

| Capability | URL scheme | AppleScript | Shortcuts | Notes |
|---|---|---|---|---|
| Place a to-do under an EXISTING heading | ✅ (add + move) | 🚫 | ✅ (Create To-Do `Heading` field) | |
| Create heading at project creation | ✅ json payload (HX0) | ⛔ | ✅ (Create To-Do/Project) | |
| Create heading in an EXISTING project | 🚫 (T09/U09; json top-level heading + project-update `items` append both silently ignored, HX1/HX1b) | 🚫 (`make` A31; move/duplicate refusals HX2/HX3) | ✅ **shipped** (`heading.create`, `things heading add`; S02, `Create Heading`) | **only Shortcuts delivers this** — exhaustively confirmed by the HX sweep (2026-07-09); wired into the pipeline 2026-07-11, capability-gated behind `things setup shortcuts`. No transactional undo (heading delete is interactive-only, −1728 on AppleScript) — undo reports irreversible |
| Rename a heading | 🚫 silent no-op (P10c) | ✅ **shipped** (`heading.rename`, `things heading rename`) | ✅ (S03) | by-id addressing; works on archived headings; no Shortcuts setup |
| Delete a heading | 🚫 | 🚫 `delete to do id` → −1728 (P10b-b3) | ✅ interactive (S04/P12), CASCADES | Trash: heading row VANISHES, children reparented to project root + trashed (P12); permanent: heading + children hard-deleted, no tombstone (P12). Unlike a project delete (shallow). HEADLESS equivalent: empty it (P9f) + ARCHIVE it — reversible, no consent |
| **Archive / un-archive a heading** | 🚫 `completed=` no-op (P10b) | ✅ **shipped** (`heading.archive`/`heading.unarchive`, `things heading archive`) | 🚫 Status detail exit-0 no-op (P10a) | children policy required when open children exist: complete/cancel = the app's cascades (P10b-b1/P11c; pre-resolved children untouched, P11d), reparent = compound with transactional undo. `--restore-children` reopens cascade-resolved children (<2s window; someday survives, P11a) |
| Move a heading | 🚫 (U10); json update `list-id` silent no-op (HX4) | 🚫 `set project of` silent no-op (P10b-b4); `move → project id` error 301, `→ list id` −1728, `duplicate` −1717 (HX2/2b/3) | 🚫 (scf P2 — `set-detail` Parent is an exit-0 silent no-op) | **conclusively dead — model-layer refusal on a resolved subject (HX sweep)** |
| Reorder headings within a project | 🚫 | ✅ **shipped** (`reorder --scope headings`, scf P1) | ➖ | children follow their heading (FK intact); the command is misleadingly named "reorder to dos" |

## Areas

| Capability | URL scheme | AppleScript | Shortcuts | Notes |
|---|---|---|---|---|
| Create (+tags) | 🚫 | ✅ | 🧪 | |
| Rename / replace tags / CLEAR tags | 🚫 | ✅ (E01; empty-set clear P10e) | 🧪 | `set tag names of area id X to ""` removes every TMAreaTag row |
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
| Someday (loose to-dos OR area-less someday projects) | ✅ **shipped** (`reorder --scope someday`, one kind per call) | anchor-stack handler with OPPOSITE stack directions by row type: to-dos ascend (P6h/P7e/P8b), projects descend (P9e incl. predicted-failure control) — the compile emits the matching two-call protocol. NOTE: someday projects do NOT appear in the sidebar — this order is visible in the Someday view only |
| Checklist items | ✅ | granular move via stateful rewrite |
| Sidebar: areas | 🚫 (O13 + scf2 P6e/f/g + P9b/c) | exhaustively closed 2026-07-09, twice: move-to-location errors (−1700), `set index` read-only (−10006), private reorder no-ops on area uuids in EVERY specifier the sdef admits (named lists, application, area); creation appends at index 0 (the app writes TMArea."index" only on UI drag); no list contains areas. The LAST unautomatable ordering |
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
| Permanently delete one item | 🚫 | AppleScript spellings all fail (B0/A5); only all-or-nothing `trash.empty`. Shortcuts hard-deletes ONE to-do/project/heading interactively (P12) but has NO area support (Find Items surfaces only to-dos/projects) |
| Enable-Things-URLs introspection | ✅ read (`uriSchemeEnabled` in the group-container plist) | **RESOLVED (Phase 21b):** state = `uriSchemeEnabled` int-bool in `~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist` (read via `plutil -p`, not `defaults`). Token PERSISTS while disabled and does NOT rotate across off/on. Disabled write → tier-3 enable-modal (write held, no DB row). See [phase21b-research.md](lab/phase21b-research.md). |
