# Step 7 - AI-Assisted GTD Operating Model (Things + Obsidian)

## Executive Summary
This operating model uses Things as the action execution engine and Obsidian as the strategy/reference brain. It is GTD-aligned, automation-aware, and resilient to Things URL-scheme constraints.

## Canonical Term Dictionary

| Canonical term | Meaning | Implementation |
|---|---|---|
| Capture | Intake of potential commitments | Things Inbox (`to-do`) |
| Clarify | Decide actionable outcome and next action | Agent triage + Things updates |
| Organize | Place actions/projects in trusted structure | Things Areas/Projects/Tags/When/Deadline |
| Reflect | Review and recalibrate commitments | Weekly review workflow + Obsidian strategic notes |
| Engage | Execute trusted next actions | Things Today/Anytime with context tags |
| Action | Atomic executable work | Things To-do |
| Project | Outcome requiring multiple actions | Things Project + Obsidian support note |
| Area of Focus | Responsibility domain | Things Area + Obsidian definition |
| Context | Situational filter (person/place/tool/energy) | Things Tag taxonomy |
| Someday/Maybe | Incubated non-active commitments | Things Someday |
| Waiting For | Delegated/external dependency | Tag + owner/date note convention |
| Project Support | Non-action planning/materials | Obsidian project note |

## End-to-End Blueprint (GTD Flow)

### 1) Capture / Collect
- Entry channels: chat, voice transcript, email summary, quick note.
- Agent action: create Inbox to-do unless fully clarified.
- Data written: title, source pointer, optional rough date.

### 2) Clarify / Process
- Agent asks/infers: actionable? if yes, next action phrasing; if no, trash/reference/someday.
- If multi-step: create project, then seed next actions.
- If delegated: add `waiting-for` tag and owner/date note.

### 3) Organize
- Assign area (if clear), tags, `When`, and deadline.
- Link project to Obsidian support note.
- Avoid workflows that require unsupported reordering or taxonomy creation.

### 4) Reflect (Daily + Weekly + Monthly)
- Daily: Today shaping and quick waiting-for checks.
- Weekly: inbox zero, project-by-project sweep, upcoming/deadline scan, someday grooming.
- Monthly/quarterly: taxonomy and strategic alignment checks in Obsidian.

### 5) Engage / Do
- Agent proposes context-aware execution shortlist from Today/Anytime.
- User executes; agent updates completion/cancelation state.

## Operational Roles

1. Agent responsibilities
- Intake normalization.
- Clarification suggestions.
- Safe mutation execution for supported operations.
- Review report generation and exception handling.

2. User responsibilities
- Own final commitment decisions where ambiguity/risk is high.
- Maintain Area/Tag taxonomy in UI.
- Resolve edge cases requiring UI-only operations.

## User Stories

### US-1 Inbox to Next Action
1. User forwards an email summary.
2. Agent creates Inbox to-do.
3. During clarification, agent rewrites it as a verb-first next action, assigns area/tag/date.
4. Task appears in Today when appropriate.

### US-2 Inbox Item Becomes Project
1. User captures: "Launch new personal site."
2. Agent classifies as project and creates Things project.
3. Agent creates first 3 next actions in project and links Obsidian support note.
4. Weekly review verifies project always has at least one next action.

### US-3 Delegated Item (Waiting For)
1. User says: "Waiting on Alex for contract redlines."
2. Agent creates to-do tagged `waiting-for`, adds owner/date in notes.
3. Agent schedules follow-up date.
4. On review date, agent proposes follow-up action.

### US-4 Project Completion Safety
1. User requests project completion.
2. Agent inspects all child to-dos/headings and computes the intended resolution for each unresolved child.
3. Agent only issues project completion after that child-resolution plan is explicit, because URL completion may auto-complete unresolved children.
4. If intent is not clear, the agent presents blocking child items and proposes resolution instead of completing the project.

### US-5 Someday Promotion
1. Weekly review surfaces Someday project with renewed relevance.
2. Agent moves project to active state and creates concrete next action.
3. Agent updates project support note status in Obsidian.

### US-6 Headless Execution Guardrail
1. Agent running through remote session attempts mutation preflight.
2. If URL actions fail or uncertain, agent switches to read/report mode.
3. User executes pending mutation queue from GUI session.

## Housekeeping Cadence

### Daily (10-20 min)
1. Inbox quick-triage.
2. Today shaping (promote/defer).
3. Waiting-for quick scan.

### Weekly (45-90 min)
1. Full inbox zero.
2. Review all active projects.
3. Deadline/upcoming horizon check (next 14 days).
4. Someday grooming.
5. Obsidian project support refresh for major projects.

### Monthly (30-60 min)
1. Tag/area hygiene review.
2. Stale project cleanup.
3. PARA archive and reference cleanup.

### Quarterly (60-120 min)
1. Horizon 2-3 alignment check.
2. Goal refresh in Obsidian.
3. Taxonomy refactor decisions.

## Automation Boundaries (Explicit)

### Reliable automation
1. Create/update/complete/cancel most to-dos and projects.
2. Assign existing tags/areas.
3. Add checklist items and basic structural metadata.
4. Query data through `things.py` / `things-mcp`.

### Constrained automation
1. Project completion is high risk because it may implicitly complete unresolved child to-dos.
2. Selective tag removal requires read-then-replace strategy.
3. Heading lifecycle operations are partially constrained.
4. Headless reliability depends on GUI session realities.

### UI-only or effectively manual
1. Area taxonomy create/rename/delete.
2. Tag taxonomy create/rename/delete.
3. Reordering semantics.
4. Recurrence rule authoring/editing.

## Workaround Strategy vs Open API Task Managers

1. Treat Things taxonomy as stable infrastructure, not dynamic runtime data.
2. Use Obsidian for all high-entropy planning context.
3. Build agent logic around idempotent, append/update-safe operations.
4. Add explicit manual checkpoints for unsupported operations.
5. Prefer policy-driven behavior over brittle automation hacks.

## Implementation Notes for Agent Builders

1. Keep a local cache of area/tag IDs and refresh periodically.
2. Add preflight checks: app reachable, token valid, dry-run diff generation.
3. Log every mutation with request URI/tool call, response, and rollback hint.
4. Batch writes conservatively with checkpoint retries.
5. Separate `proposal mode` and `execute mode` for high-impact updates.

## Overall Assessment
- This system is workable and durable if designed around Things constraints instead of fighting them.
- Compared to open APIs, you lose dynamic schema control and some structural automation, but you retain excellent day-to-day UX and can still achieve a high-automation GTD practice through careful boundary design.

## Source Backbone
- Things docs and URL scheme (see Steps 1 and 3 references).
- `things.py` and `things-mcp` repositories/docs (see Step 3 references).

_Last reviewed: 2026-03-02 (America/Chicago)_
