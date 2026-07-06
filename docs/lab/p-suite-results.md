# P-suite results — gap-closure campaign (Phase 18)

Probed 2026-07-06 against `things-lab-golden-v1` (Things 3.22.11, DB v26, pinned clock 2026-07-05). Discovery runs `p-20260706-221842` (P01–P18) and `p-20260706-223231` (P19–P27 extension); expectations locked; final acceptance ×2 on the full 27-probe suite with identical verdicts (`lab:compare`). All probes tier 0, no crashes.

Campaign motivation: Mike's CRUD-enumeration questions (project cancel/reopen and cascade semantics, trash-restore for projects, container/area removal, granular checklists, tag un-nesting) — see docs/gaps.md.

## Project lifecycle (P01–P07)

| Probe | Finding | Verdict |
|---|---|---|
| P01 | **`update-project?canceled=true` works and cascades natively**: open children → canceled; an already-completed child keeps its status AND stopDate. Mirror of the T08/U08 complete cascade. | supported |
| P02 | **`update-project?completed=false` REOPENS a completed project.** Cascaded children STAY completed — reopening restores only the project row. | supported |
| P03 | **Cascade stopDate timing**: children are stamped within <2s of the project row (sub-second REAL precision observed). This is the heuristic window for detecting cascade-resolved children of app-made completions; things-api's own completions need no heuristic (the audit record lists the pre-open children exactly). | supported |
| P04 | **A child resolved long before the project survives complete→reopen untouched** (status and stopDate both unchanged) — the "previously logged" edge is safe. | supported |
| P05 | **`update-project?canceled=false` reopens a canceled project**; cascade-canceled child stays canceled (P02 analog). | supported |
| P06 | **Trashed-project RESTORE: `move project id X to list "Anytime"` flips `trashed 1→0 IN PLACE`** — nothing else changes: schedule, area link, children all keep their state. Strictly better than the to-do restore (E15 relocates to the Inbox). | supported |
| P07 | Same restore via `list "Someday"` — also works, and additionally sets `start=2`. `"Anytime"` is the restoration-faithful choice. | supported |

## Container/area removal (P08–P13)

| Probe | Finding | Verdict |
|---|---|---|
| P08 | `set area of project … to missing value` — rejected (E19 pattern). | unsupported |
| P09 | `move project … to list "Anytime"` on an UNTRASHED project — **complete silent no-op, zero delta**. With P08: **project area removal is impossible** via URL/AppleScript. | silent-noop |
| P10 | `set project of to do … to missing value` — rejected. | unsupported |
| P11 | `set area of to do … to missing value` — rejected. | unsupported |
| P12 | **`move to do … to list "Anytime"` de-schedules (start 2→1, startDate/todayIndexReferenceDate cleared) but the AREA LINK SURVIVES.** A clean "un-schedule, keep container" primitive. | supported |
| P13 | **The deadline survives a move-to-Inbox** (E06 asserted only start/startDate) — required by the clear-container-keep-schedule composite. | supported |

## Container removal, second sweep — the unturned stones (P19–P27)

Follow-up probes after Mike's "no stone unturned" review: URL empty params, `update-project?area-id` (never probed at all), json `null`, AppleScript `""`, the ephemeral-area chain, and a sidebar-order read oracle.

| Probe | Finding | Verdict |
|---|---|---|
| P19 | New top-level projects FRONT-INSERT on `"index"`; AppleScript `projects` enumeration is NOT sidebar-ordered (internal order) — index sort stays the *provisional* read of top-level sidebar order. | supported |
| P20 | **Deleting an AREA does not trash its projects** — the project survives with `area=NULL` (only to-dos are trashed on area delete, A25). The ephemeral-area chain works but is superseded by P24. | supported |
| P21 | **`update?list-id=` (EMPTY) clears a to-do's AREA** — one step, clean single-field delta. | supported |
| P22 | **`update?list-id=` (EMPTY) clears a to-do's PROJECT.** | supported |
| P23 | **`update-project?area-id=<uuid>` MOVES a project between areas** — project.move gains a tier-0 URL vector (E14's AppleScript path is no longer the only one). | supported |
| P24 | **`update-project?area-id=` (EMPTY) clears a project's area** — THE one-step area removal. | supported |
| P25 | json `{"area-id": null}` on a project — complete silent no-op (zero delta). | silent-noop |
| P26 | json `{"list-id": null}` on a to-do — complete silent no-op (zero delta). | silent-noop |
| P27 | AppleScript `set area … to ""` — rejected like `missing value`. | unsupported |

The empty-URL-parameter replacement pattern (first seen for `tags=`/`checklist-items=`, P14/P15) turns out to generalize to CONTAINERS — undocumented but consistent. Three surfaces now exhibit three behaviors for the same intent (AppleScript errors, json silently ignores, URL empty clears) — oddities §5g.

To-do "remove all containers keeping the schedule": **one URL write** (`update?list-id=`) per P21/P22 — the two-step Inbox-bounce composite is no longer needed for container clearing (it remains the documented pattern only for clearing a DATED reminder, R20/R21).

## Empty replacements (P14–P15)

| Probe | Finding | Verdict |
|---|---|---|
| P14 | `update?tags=` (empty) clears ALL tags — empty replacement works. | supported |
| P15 | `update?checklist-items=` (empty) deletes the whole checklist. | supported |

## Tags (P16)

| Probe | Finding | Verdict |
|---|---|---|
| P16 | **Deleting a parent tag CASCADE-DELETES its child tags** (both rows gone). Two consequences: (1) the un-nest-via-sacrificial-parent idea is dead — un-nesting to root remains impossible (E19); (2) **`tag.delete` on a tag with children is a subtree-destroying footgun** → Phase 19 adds a hazard (block unless the children are acknowledged). | supported |

## Ordering (P17)

| Probe | Finding | Verdict |
|---|---|---|
| P17 | Private reorder with a `list "Anytime"` specifier does NOT order top-level (area-less) projects — no error path found either. With O13 (areas) this closes sidebar ordering: **top-level sidebar order is UI-only**. | unsupported |

## Granular checklists (P18, hazard-quarantined)

| Probe | Finding | Verdict |
|---|---|---|
| P18 | **`things:///json` to-do update with `checklist-items` carrying per-item `completed` attributes WORKS, tier 0, no crash/modal.** The items are REPLACED (fresh uuids; `openChecklistItemsCount` recomputed) with the states applied. This is the granular-checklist unlock: read titles+states from the DB, apply an add/edit/delete/check/reorder in memory, write the full list back with states preserved. Caveat: checklist-item uuids are NOT stable across a rewrite — consumers must key on title/position. | supported |

## Verdict summary for Phase 19

**Buildable:** `project.cancel` (cascade policy like complete, P01), `project.reopen` (completed & canceled, P02/P05; undo upgrade — audit-exact child restore for our own mutations, <2s stopDate window per P03 for app-made ones; pre-resolved children safe per P04), `project.restore` (in-place un-trash via Anytime list-move, P06/P07), **one-step container removal** (`todo` clear project/area via empty `list-id=`, P21/P22; `project` clear area via empty `area-id=`, P24), `project.move` URL vector (P23), `todo.unschedule` (P12, area survives), empty tag/checklist clears (P14/P15), granular checklist ops over json with per-item completed states (P18).

**Closed permanently (documented):** AppleScript/json container removal (P08–P11, P25–P27 — the URL empty-param path is the sole surface); tag un-nest (P16 kills the last workaround: parent-tag delete CASCADE-DELETES children); top-level sidebar ordering writes (P17 + O13; reads provisional via `"index"`, P19). New guard required: tag-subtree deletion (P16).
