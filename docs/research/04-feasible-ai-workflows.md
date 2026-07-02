# Step 4 - Feasible AI-Enhanced GTD Workflows Under Things Constraints

## Design Principle
Build around operations that are reliably automatable today, and treat unsupported capabilities as explicit manual governance checkpoints.

## Implementation Posture (Decision)

1. Primary implementation path:
- Build a custom deterministic API/toolset around local Things DB reads plus official URL-scheme mutations.
- If the surrounding agent/tooling stack is TypeScript-first, implement this layer in TypeScript rather than treating `things.py` as the required runtime dependency.
- Use `things-mcp` as prior art and reference implementation, not as the required runtime interface.

2. Safety boundary:
- Do not write directly to the Things SQLite database.
- Reason: direct DB mutation bypasses official app sync/state machinery and risks corruption or cross-device drift.

3. Verification requirement:
- Every mutation workflow must use scripted `write -> verify` checks with UUID-level read-back assertions.
- Do not rely on an LLM's implicit follow-up behavior for correctness.

4. Heading handling policy:
- Treat headings as read-only human structure for the MVP.
- Preserve `heading` / `heading_title` metadata in read models when present.
- Do not require the agent to create, rename, reorder, or reason semantically over headings.
- Do not use `projects(..., include_items=True)` as the canonical flat child-task feed when headings may exist; use a deduplicated `tasks(type='to-do', project=...)` style read instead.

## Friction Model (System Design Lens)

1. Extremely low friction:
- Read/write operations directly supported by `things-mcp`.

2. Low friction:
- Read/write operations supported by `things.py` + official URL-scheme mutations.

3. Medium friction:
- Read access requiring custom SQL analysis/scripts against local Things DB (avoid unless needed for missing views/fields).

4. High friction:
- Writes not supported by official mutation paths (requires user manual action or GUI-driving automation).
- MVP policy: avoid high-friction GUI-driving approaches.

## Required Manual Setup Domains (Stable, Infrequent)

1. Area taxonomy (create/rename/delete in UI only).
2. Tag taxonomy (create/rename/delete/group in UI only).
3. Optional project heading architecture standards (if used heavily).
4. Auth token provisioning and secure storage for URL-based updates.

## Workflow Template (Canonical)

- `trigger`
- `inputs`
- `decision rules`
- `actions`
- `failure modes`
- `fallback/manual action`
- `audit log fields`

## Recommended Workflow Subset

### WF-1 Capture Intake (Inbox First)
- `trigger`: New inbound item from chat/email/voice/note.
- `inputs`: raw text, source channel, optional due/schedule hints.
- `decision rules`:
  1. If ambiguity is high, create inbox item first.
  2. If clearly actionable and short, create to-do directly with minimal metadata.
- `actions`:
  1. Create to-do in `Inbox` via `things:///add`.
  2. Attach source pointer in notes.
  3. Verify created item exists and fields match requested values.
- `failure modes`:
  1. URL call fails or Things not reachable.
- `fallback/manual action`:
  1. Queue item in Obsidian intake note for later import.
- `audit log fields`:
  1. `captured_at`, `source`, `todo_id`, `raw_text_hash`.

### WF-2 Clarify and Organize (Action vs Project)
- `trigger`: Scheduled clarification pass (e.g., 2-3x daily) or user request.
- `inputs`: inbox to-do IDs, existing project/area/tag dictionaries.
- `decision rules`:
  1. If result requires >1 action, create project and decompose.
  2. If delegated, apply `waiting-for` tag and owner/date note.
  3. If not now, move to `Someday`.
- `actions`:
  1. Update titles to verb-first next-action language.
  2. Create project and move/clone actions as needed.
  3. Assign existing area and tags.
  4. Set `When`/`Deadline` where appropriate.
  5. Verify each mutation (title/placement/tags/dates) via read-back before proceeding.
- `failure modes`:
  1. Required area/tag does not exist.
  2. Heading-dependent structure requested where heading ops are constrained.
- `fallback/manual action`:
  1. Flag `taxonomy-missing` for user UI fix.
  2. Continue without heading/reorder assumptions.
- `audit log fields`:
  1. `clarified_by`, `item_id`, `decision`, `project_id`, `tags_applied`, `scheduled_for`.

### WF-3 Project Planning (Actionable Layer Only)
- `trigger`: New project intake or project expansion request.
- `inputs`: project outcome, constraints, target date, support-note link.
- `decision rules`:
  1. Keep only executable next actions in Things.
  2. Move long-form planning to Obsidian project note.
- `actions`:
  1. Create/update Things project.
  2. Add actionable child to-dos.
  3. Optionally add headings only if automation path validated in your environment.
  4. If headings already exist, preserve heading metadata in reads but keep the workflow valid without heading-aware edits.
  5. Insert reciprocal links (Things ID in note, note URL in project notes).
  6. Verify project note link integrity and child-item creation after each batch.
- `failure modes`:
  1. Cannot programmatically realize requested project structure (e.g., reorder semantics).
- `fallback/manual action`:
  1. Keep flat task list in Things; preserve phase detail in Obsidian note.
- `audit log fields`:
  1. `project_id`, `obsidian_note`, `actions_added`, `structure_mode`.

### WF-4 Daily Execution Assist (Today + Context)
- `trigger`: Morning planning and intra-day replans.
- `inputs`: Today list, available time window, context tags, energy level.
- `decision rules`:
  1. Prefer true next actions with matching context.
  2. Cap WIP for Today to avoid overload.
- `actions`:
  1. Promote selected tasks to Today (`when=today`).
  2. Defer low-priority tasks to future date/Someday.
  3. Generate execution shortlist and rationale.
  4. Verify post-mutation list membership to catch ignored updates.
- `failure modes`:
  1. Over-scheduling caused by stale priorities.
- `fallback/manual action`:
  1. Ask for manual confirm before bulk date moves.
- `audit log fields`:
  1. `date`, `today_count_before`, `today_count_after`, `promoted`, `deferred`.

### WF-5 Waiting-For and Follow-up
- `trigger`: Daily follow-up check and weekly review.
- `inputs`: tasks/projects tagged `waiting-for`, due/follow-up dates, owners.
- `decision rules`:
  1. Any waiting item without owner/date note is invalid and must be repaired.
  2. Escalate items older than policy threshold (e.g., 7 days).
- `actions`:
  1. Filter by `waiting-for` tag.
  2. Propose follow-up actions or conversion to active next action.
  3. Verify tag/date/note mutations when updates are applied.
- `failure modes`:
  1. Missing metadata in notes.
- `fallback/manual action`:
  1. Add owner/date note manually if agent context is insufficient.
- `audit log fields`:
  1. `item_id`, `owner`, `waiting_since`, `next_followup_date`, `escalation_state`.

### WF-6 Someday/Maybe Grooming
- `trigger`: Weekly or monthly incubator review.
- `inputs`: Someday list entries, strategic fit, energy/capacity limits.
- `decision rules`:
  1. Promote only items with clear next action and current relevance.
  2. Cancel/archive stale incubations intentionally.
- `actions`:
  1. Move selected items from Someday to Anytime/Today.
  2. Create a next action for promoted projects.
  3. Verify move state and next-action presence before closing workflow.
- `failure modes`:
  1. Promotion without concrete next action.
- `fallback/manual action`:
  1. Keep in Someday and add review date note.
- `audit log fields`:
  1. `item_id`, `decision`, `promotion_target_date`, `reason`.

## Unsupported-Operation Design Decisions

1. No dependence on programmatic area/tag taxonomy mutation.
2. No workflow requires item reordering as correctness condition.
3. No workflow requires recurring-rule creation via URL scheme.
4. No workflow requires hard delete; use complete/cancel plus periodic manual cleanup policy.
5. No direct SQL writes to Things database under any circumstances.
6. SQL reads are fallback only for unresolved read gaps (for example recurring visibility or ordering metadata edge cases).
7. Existing headings may be preserved as passive structure, but the workflow must remain correct even if the agent ignores them operationally.

## Edge-Case Playbook

1. Missing area/tag during automation:
- Behavior: keep item unassigned or minimally tagged.
- Recovery: emit explicit `manual-taxonomy-action-required` event.

2. Project close attempt fails due child state:
- Behavior: auto-close child open tasks only if policy allows; otherwise request confirmation.
- Recovery: retry project completion after prerequisites are met.

3. App/UI state interference (modal/focus/headless):
- Behavior: mark operation as `uncertain`, stop bulk mutation chain.
- Recovery: run a single-item probe before resuming batch operations.

4. Partial write in batch:
- Behavior: log successful IDs and failed IDs.
- Recovery: idempotent retry only for failed IDs.

5. Read gap discovered in implementation:
- Behavior: classify as `medium-friction-read-gap` and keep workflow functional with best available query/tool output.
- Recovery: decide whether to add targeted SQL read helper or relax workflow dependency on that field.

6. Reordering workflow experiment:
- Behavior: treat any move-out/move-back sequencing hack for reordering as experimental only.
- Recovery: keep the MVP functionally order-agnostic until each target context (`Today`, `This Evening`, project active items, later-item date groups, headings) has a validated reorder algorithm and read-back verifier.

## Recommended Minimal Viable Workflow Set

1. Capture -> Clarify -> Organize (WF-1, WF-2).
2. Daily execution planning (WF-4).
3. Waiting-for hygiene (WF-5).
4. Weekly Someday grooming (WF-6).
5. Project support in Obsidian via lightweight cross-linking from WF-3.

## Sources
- Capability constraints from Step 3 matrix.
- Things guide/workflow docs: https://culturedcode.com/things/guide/

_Last reviewed: 2026-03-03 (America/Chicago)_
