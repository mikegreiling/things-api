# Novel working paths — the surprising capabilities the lab uncovered

The capabilities that exist NOWHERE in Cultured Code's documentation, discovered by probing. Each is lab-validated with the evidence id shown; the living [capability-matrix](../capability-matrix.md) tracks which are wired into shipped operations. Ordered roughly by how much product surface each unlocked.

## AppleScript

1. **`_private_experimental_ reorder to dos in <specifier> with ids "…"`** — the undocumented sdef command behind every native reorder scope. Accepts to-dos in `list "Today"` (A50) and `list "Inbox"` (21b A6, reversed wire list), un-headed children in project/area specifiers (O04/O05/O09/O10), **projects** in an area specifier (O14), **heading rows** in a project specifier (scf P1 — children follow their FK), and `list "Someday"` members (P6h) with a distinct anchor-stack model: the call's original top item never moves, to-dos stack ASCENDING (P8b two-call protocol), someday PROJECTS stack DESCENDING (P9e inverted protocol). Gated behind `allow-experimental` + the sdef canary.
2. **By-id addressing reaches rows list reads can't see.** Repeating templates (A12) AND heading rows (P10 — `to do id "<heading-uuid>"` resolves type=2 despite "no heading class") are fully addressable: `get properties`, `set name` (rename, P10d), `set status` (archive/unarchive, P10d/P10b — cascade semantics P11c/P11d). The entire shipped heading lifecycle rides this.
3. **`_private_experimental_ json of to do id …`** (A51) — full JSON document exposing checklist items and recurrence config invisible to every public read surface.
4. **Backdating existing items**: `set completion date` / `set creation date of to do id X` rewrite history (scf2 P4b) — dead on URL (oddity 2g) and Shortcuts (P4a). Ships as `todo.backdate`.
5. **`delete <property>` as the un-setter**: `delete parent tag of tag X` un-nests to root (P29); `delete keyboard shortcut of tag` clears the shortcut (21b A4) — where `set … to missing value`/`""` error out.
6. **`schedule to do id <PROJECT>` works** (P14-A3 — projects inherit the `to do` class); an unwired alternative to `update-project?when=` (decision: document-only, roadmap §D). Also `schedule … for (current date)+N*days` fills the Upcoming gap (A21B).
7. **`move <trashed to-do> to list "Inbox"` restores from Trash** (E15 — the UI's "Put Back", scriptable); `move <trashed project> to list "Anytime"` restores a project IN PLACE, restoration-faithful (P06/P07).

## URL scheme / TJSON

8. **The empty-parameter clear pattern**: `update?list-id=` detaches a to-do from its project/area (P21/P22); `update-project?area-id=` detaches a project (P24) — the ONLY container-clear on any surface (four-behaviors-for-one-intent, oddity 5g). Empty `tags=` / `checklist-items=` clear likewise (P14/P15).
9. **TJSON `{"type":"heading"}` items inside a NEW project's `items` create real type=2 rows** (HX0; used by the golden seeder and the e2e heading fixtures). The ONLY headless heading-create — but only at project creation; every relocation/append shape is dead (HX1–HX4b).
10. **At-creation backdating via TJSON attributes**: `{"completed":true,"creation-date":…,"completion-date":…}` honored exactly (scf2 P4d) — the logbook-import path. Ships as `todo.add-logged`.
11. **`update?duplicate=true` copies a to-do or a project INCLUDING children** (E07/E17) — AppleScript `duplicate` is refused (-1717).
12. **The `when=` bounce family**: front-insert on attach/round-trip powers the evening reorder (O08) and top-level sidebar-project ordering via a someday↔anytime round-trip (P7c/P8e) — the only write path to sidebar project order.

## Shortcuts (App Intents)

13. **`Create Heading` makes a heading in an EXISTING project** (S02) — the marquee capability, dead on both other vectors; exhaustively confirmed unique by the HX sweep.
14. **Single-item permanent delete** (S-delperm — `Delete` + Delete Immediately: row gone, no tombstone) — interactive-only (delete-class consent has no Always-Allow, oddity 5j).
15. **`Edit Items → Reminder Time ""` clears a DATED reminder** (scf P3b) — the one reminder edit no other surface can make (oddity 2e); it cannot SET (P3a).
16. **Output-class consent is inherited by VM clones** (scf) — grant Always-Allow once in the golden, every clone runs proxies headless.
17. **The proxies themselves are extractable and re-signable**: workflow blobs live verbatim in `Shortcuts.sqlite` (`ZSHORTCUTACTIONS.ZDATA`), wrap into old-format plists, and `shortcuts sign --mode anyone` mints importable signed files (SX2–SX4) — the distribution path for `shortcuts/*.shortcut` (no iCloud, no manual rebuild).
18. **Programmatic shortcut AUTHORING — no golden GUI sitting needed** (SX5, 2026-07-10). A hand-composed (never-GUI-touched) `WFActionParameterFilterTemplates` predicate runs CORRECTLY: the SX5 repair of `find-items` was written in Python (plistlib), injected, and returned real case-folded matches. Combined with #17, new proxies can be minted entirely in code: compose the `WFWorkflowActions` bplist → wrap in the old-format envelope → `shortcuts sign --mode anyone`. The action vocabulary comes free from the app bundle: `Things3.app/Contents/Frameworks/ThingsCommon.framework/…/Metadata.appintents/extract.actionsdata` lists every entity property identifier + per-property query comparators (that's how `title` was confirmed and `name` ruled out, host-side, before any VM run). Two supporting facts: **DB surgery on a consented shortcut preserves its consent** (swap `ZSHORTCUTACTIONS.ZDATA` after killing `siriactionsd`; identity, not content, keys the grant — the SX5 iteration loop), and predicate `Property`/`Operator` values must come from the metadata (unknown ones crash Things — oddity C4).

## Reads / environment

19. **`uriSchemeEnabled` on disk** (21b) — the group-container preferences plist carries the true "Enable Things URLs" state (the auth token does NOT track it); powers the availability layer + failure attribution.
20. **The Today comparator** (`startBucket, todayIndexReferenceDate DESC, todayIndex, uuid` + the deadline-pull membership rule with `deadlineSuppressionDate` re-arming) — UI-oracle-derived, exact 393/393 live reconciliation (today-order-research).
21. **Hidden lists** `list id "tomorrow"` and `list id "later-projects"` exist in the sdef enumeration (P9a) — unprobed as reorder specifiers (backlog).
