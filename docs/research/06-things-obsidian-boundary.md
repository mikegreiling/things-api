# Step 6 - Things vs Obsidian Boundary for GTD + PARA

## Boundary Decision
Use Things as the execution system for actionable work (GTD horizons 1-2 action layer), and Obsidian as the strategic/reference system for planning, knowledge, and higher horizons.

## System-of-Record Split

| Domain | System of record | Why |
|---|---|---|
| Next actions (atomic tasks) | Things | Fast capture, scheduling, and completion UX. |
| Active projects (action lists) | Things | Native project/task handling with daily execution views. |
| Areas of focus (operational grouping) | Things + Obsidian definition note | Things stores structure; Obsidian stores intent/rules. |
| Project support materials | Obsidian | Better for long-form notes, files, links, and planning context. |
| Meeting notes and research | Obsidian | Non-actionable/reference-heavy content. |
| Goals, vision, purpose (H3-H5) | Obsidian | Strategic narrative and review journals. |
| PARA Projects (execution view) | Things + Obsidian | Actions in Things, support in Obsidian. |
| PARA Areas | Obsidian primary, Things Area mapping secondary | Obsidian is richer for definitions; Things for execution grouping. |
| PARA Resources | Obsidian | Reference store. |
| PARA Archives | Obsidian + Things Logbook | Historical outcomes and references. |

## GTD Horizons Placement

1. Horizon 1 (current actions): Things.
2. Horizon 2 (areas of focus): Things area objects, governed by Obsidian policy note.
3. Horizons 3-5: Obsidian documents and review processes.

## Cross-link Architecture

### Link from Obsidian to Things
- Use Things item links in notes:
  - `things:///show?id=<THING_ID>`
  - `things:///show?query=<SEARCH_TEXT>` for query shortcuts.

### Link from Things to Obsidian
- Put an Obsidian deep link in Things project/to-do notes:
  - `obsidian://open?vault=<VAULT_NAME>&file=<ENCODED_PATH>`

### Recommended metadata fields in Obsidian project notes

```yaml
---
things_project_id: "<UUID>"
things_area: "<Area Name>"
gtd_outcome: "<Desired outcome statement>"
review_frequency: "weekly"
status: "active|someday|done|canceled"
---
```

### Recommended Things note footer format

```text
Support: obsidian://open?vault=<VAULT>&file=Projects%2F<NoteName>
Owner: <person/system>
Last Clarified: YYYY-MM-DD
```

## Governance Documents to Keep in Obsidian

1. `GTD/areas-of-focus.md`
- Defines each Things Area, inclusion/exclusion rules, examples.

2. `GTD/tag-taxonomy.md`
- Canonical tag vocabulary and usage rules (`context:*`, `energy:*`, `waiting-for`, etc.).

3. `GTD/weekly-review-checklist.md`
- Review checklist and thresholds.

4. `PARA/system-boundary.md`
- Explicit mapping of PARA classes across Things and Obsidian.

## Policy: Area-less Projects and To-dos

1. Area-less to-dos: allowed for short-lived/transient work.
2. Area-less projects: discouraged; allowed only when truly cross-area or temporary intake projects.
3. Review rule: any area-less project older than 7 days must be assigned an area or intentionally parked/canceled.

## Sync Rules (Single Source of Truth)

1. Action state truth lives in Things (open/completed/canceled, schedule, deadline).
2. Strategic meaning and support context live in Obsidian.
3. Never maintain duplicate task checklists in Obsidian for active projects.
4. Obsidian may hold milestone narrative, but executable next actions must be mirrored in Things.

## Operational Pattern: Dual-home Project

1. Create project in Things for actionable execution.
2. Create or link Obsidian project note for support.
3. Store reciprocal links in both systems.
4. During weekly review, update strategic note first, then reconcile next actions in Things.

## Sources
- Things capabilities and limits from Step 3 matrix.
- Things URL show/search links: https://culturedcode.com/things/support/articles/2803573/

_Last reviewed: 2026-03-02 (America/Chicago)_
