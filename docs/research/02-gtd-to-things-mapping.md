# Step 2 - GTD Taxonomy Mapping to Things

## Scope and Policy
- Goal: map David Allen GTD constructs onto Things objects/lists with minimal semantic drift.
- Terminology policy: GTD-first language where practical, with explicit Things adaptations.
- Preference applied: hybrid pragmatic model, leaning GTD.
- This document defines normative operating rules for mapping quality and consistency.

## GTD to Things Mapping Table

| GTD concept | Things mapping | Fit | Caveats and policy |
|---|---|---|---|
| Capture bucket (inbox) | `Inbox` list + `add` URL command | High | Direct fit. Inbound items may be ambiguous at capture time. |
| Clarify (next action?) | `To-do` as atomic action | High | Enforce action-linting: verb-first, physically visible action. Exception: Inbox and incubator placeholders. |
| Project (>=2 actions) | `Project` + child to-dos | High | Direct structural fit. Every project note must include "what done looks like" (acceptance criteria). |
| Project support material | Conditional: Things-only for simple projects, dual-home for complex projects | High | Prefer keeping context in Things notes when practical; externalize to Obsidian only when support material exceeds concise-note limits. |
| Areas of focus/responsibility (Horizon 2) | `Area` | High | Direct fit if areas stay stable and manually governed. |
| Contexts (@home, @calls, @errands) | `Tag` taxonomy | High | Requires manual upfront tag architecture; URL automation can assign existing tags but not create taxonomy. |
| Time/energy filters | `Tag` taxonomy (e.g., `energy:low`, `duration:15m`) | Medium-High | Works when tags are governed and consistently applied. |
| Waiting For | Tag (`waiting-for`) + owner/date in note + optional follow-up date | Medium-High | No dedicated waiting-for object; use note convention and review queries. |
| Calendar hard landscape | External calendar is source of truth; Things holds preparation actions | High | Do not duplicate fixed-time events as to-dos. Example: "Meeting" in calendar, "prepare for meeting" in Things. |
| Tickler/deferral | `When` future date and `Upcoming` | High | Use `When` for "not before" constraints and intentional day placement. |
| Deadline management | `Deadline` date field | Medium-High | Use for true due constraints; can surface urgency without necessarily removing item from Anytime. |
| Someday/Maybe | Split policy: Things `Someday` for inactive commitments; Obsidian incubator for undeveloped ideas | Medium-High | Separates paused commitments from speculative ideas to reduce list ambiguity. |
| Review system | `Today`, `Upcoming`, `Anytime`, `Someday`, `Logbook`, project lists | Medium-High | Works well when weekly review has strict checklist and link-integrity checks. |
| Reference (non-actionable) | Obsidian reference notes | High | Non-actionable material should not live as active tasks in Things. |
| Horizons 3-5 (goals/vision/purpose) | Obsidian strategic notes | Low in Things / High in Obsidian | Things lacks sufficient structure for higher-horizon narrative planning. |

## Horizon Mapping (GTD)

| Horizon | Recommended system of record | Rationale |
|---|---|---|
| H1 - Current actions | Things | Native action execution model. |
| H2 - Areas of focus | Things (Area objects) + Obsidian governance note | Things supports grouping; Obsidian stores intent, boundaries, and criteria. |
| H3 - Goals (1-2 years) | Obsidian | Requires narrative planning and review context. |
| H4 - Vision (3-5 years) | Obsidian | Strategic and reflective, not task-list native. |
| H5 - Purpose/principles | Obsidian | Long-form doctrinal content. |

## Canonical Terms for This Program

1. Use `Action` for GTD atomic task; implementation object is Things `To-do`.
2. Use `Project` for GTD outcome; implementation object is Things `Project`.
3. Use `Area of Focus` for GTD responsibility domain; implementation object is Things `Area`.
4. Use `Context` for filter dimension; implementation object is Things `Tag`.
5. Use `Inactive Project` for paused but still-committed projects; implementation state is Things `Someday`.
6. Use `Incubator Idea` for speculative/non-committed items; implementation system is Obsidian (optionally mirrored as a lightweight Things Someday to-do).
7. Use `Project Support` for non-actionable notes/material; implementation system is Obsidian when beyond concise note scope.

## Normative Linting and Quality Rules

1. Action phrasing rule:
- To-do titles must be verb-first and directly actionable.
- Exception: Inbox captures and incubator placeholders may be rough until clarification.

2. Project note minimum rule:
- Every active project must include a concise done-state statement in Things notes.
- Default cap: `<= 120 words` or `<= 6 lines` to keep project notes scannable.

3. Dual-home threshold rule:
- If a project needs substantial support material (research, plans, references), it must have an Obsidian project folder with an index note.
- The first line of the Things project note must contain the Obsidian foreign-key link.
- The done-state statement still remains in Things notes (link is additive, not a replacement).
- Keep concise mission/context in Things even when dual-home is active.

4. `When` vs `Deadline` rule:
- Do not assign `When` just to increase visibility when the action is already doable now.
- Use `When` for true "not before" constraints or intentional day placement (for example, Today focus).
- Use `Deadline` for hard due pressure while preserving Anytime eligibility when appropriate.

5. Calendar landscape rule:
- Fixed-time commitments live in calendar only.
- Related prep/follow-up actions live in Things.

6. Tag namespace rule:
- Parent tags used as namespaces (for example `priority`) should usually not be assigned directly to tasks.
- Prefer assigning concrete child tags (for example `priority/high`, `priority/normal`, `priority/low`).

7. Notes-first execution detail rule:
- Treat to-do and project notes as first-class, frequently-used fields for operational context.
- In practical UI usage, note editing is continuous with title editing (cursor flow between title and note), so short contextual updates should be cheap and routine.
- To-do notes should include concrete execution details needed to complete the action (location instructions, access codes, handoff constraints, etc.).
- Project notes should include: done-state statement, brief commitment rationale, and any key context needed for execution.
- Notes support Markdown formatting and clickable links; use this to store durable Obsidian links and compact structured context.

8. Resolution annotation rule (complete/cancel):
- Before marking a to-do or project complete/canceled, append a short factual resolution note when that context will matter later.
- Completion examples: timestamp, amount, payment method, recipient, handoff details, deviations from plan.
- Cancelation examples: reason for cancelation and replacement path (if any).
- Keep entries concise and audit-focused.

9. Things-first context retention rule:
- If notes remain concise and readable, keep support context entirely in Things.
- Externalize to Obsidian when notes become too long/noisy or require richer structure.
- Default externalization trigger: note exceeds about `200 words` or `12 lines`, or requires embedded reference sets.

## Someday/Maybe Precision Policy

1. `Things Someday` is for inactive commitments:
- Work you intend to do, just not now.
- Preserve partially completed/canceled action history in Things.

2. `Obsidian Incubator` is for speculative ideas:
- Ideas not yet committed enough to merit project/action decomposition.
- Optional mirror into Things as a single Someday to-do only if you want it in weekly tactical scans.

3. Promotion path:
- Incubator idea -> committed project: create Things project, write done-state note, and seed at least one next action.

4. Demotion path:
- Active project -> inactive: move to Things Someday, keep history and links intact.

## Link Drift and Self-healing Policy

1. Reciprocal keys:
- Things project note first line stores Obsidian link.
- Obsidian project index frontmatter stores `things_project_id`.

2. Weekly reconciliation checks:
- Detect Things projects missing Obsidian link where dual-home is required.
- Detect Obsidian project notes whose `things_project_id` no longer resolves.

3. Repair strategy:
- Attempt deterministic relink by ID first.
- If ID missing, attempt candidate match by normalized title + area + recent activity.
- If multiple candidates, flag for manual review.

## Policy Defaults for Subjective Cases

1. Area-less to-dos are allowed for transient work.
2. Area-less projects are discouraged and must be justified during weekly review.
3. `Waiting For` always requires owner/date note metadata.
4. If a project is simple and self-contained, Things note-only support is acceptable.

## Non-perfect Mapping Notes

1. GTD calendar landscape is richer than Things date fields; maintain calendar as authoritative for appointments.
2. GTD weekly review expects strategic reflection beyond Things; Obsidian must carry higher-horizon reflection.
3. Things can host both inactive and incubated items unless policy separates them; this design deliberately separates speculative incubation into Obsidian to reduce ambiguity.

## Carry-forward Ideas for Later Steps

1. Audit trail format:
- Single action per line, include item UUIDs for grep-friendly history lookup.

2. Completion annotation pattern:
- Optionally append a short factual completion note (for example amount/date/payment method) before marking a task complete, so Logbook entries retain useful context.

3. Recurring-task handoff pattern:
- If a recurring rule cannot be created programmatically, the agent may create a seed to-do and provide exact UI cadence instructions for a one-time manual conversion to repeating.

4. Post-completion interview pattern:
- When a user manually marks an item complete/canceled and context is likely valuable, the agent can prompt for a short after-action note and append it to Things notes for Logbook auditability.

## Sources
- GTD concepts are based on David Allen framework terminology (industry-standard interpretation).
- Things behavior references:
  - Writing notes in Things: https://culturedcode.com/things/support/articles/4438545
  - Markdown guide: https://culturedcode.com/things/help/markdown/
  - Guide: https://culturedcode.com/things/guide/
  - Lists model: https://culturedcode.com/things/support/articles/2803564/
  - Tags (hierarchy/filter behavior): https://culturedcode.com/things/support/articles/2803574/
  - Scheduling / When / Deadline: https://culturedcode.com/things/support/articles/2803571/

_Last reviewed: 2026-03-03 (America/Chicago)_
