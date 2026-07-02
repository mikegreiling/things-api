# Step 5 - Core GTD Feasibility and Weekly Review Design

## Feasibility Verdict (Frank)
- GTD in Things is operationally feasible for Horizons 1-2 with strong discipline and explicit policies.
- AI-assisted weekly review is feasible with low manual touch for most actions.
- Full autonomy is constrained by URL-scheme limitations (taxonomy mutation, ordering, recurrence setup, and uncertain UI/headless edge behavior).

## GTD Loop Feasibility Matrix

| GTD loop | Feasibility | Automation level | Main constraints |
|---|---|---|---|
| Capture (collect) | High | High | Requires reliable URI execution path. |
| Clarify (process) | High | Medium-High | Depends on classification quality and existing taxonomy. |
| Organize | High | Medium | Area/tag creation is UI-only; order control limited. |
| Reflect (weekly review) | Medium-High | Medium | Cross-list synthesis and completion guardrails needed. |
| Engage (do) | High | Medium | Requires good next-action granularity and context tags. |

## Weekly Review Workflow (Low-manual-touch)

### WR-1 Weekly Review Runbook
- `trigger`: Scheduled weekly review (e.g., Friday afternoon or Sunday evening).
- `inputs`:
  1. Inbox items
  2. Open projects and stalled projects
  3. Waiting-for tagged items
  4. Upcoming (next 14 days)
  5. Deadlines
  6. Someday list
  7. Logbook (past 7 days)
- `decision rules`:
  1. Inbox zero is mandatory before project review.
  2. Every active project must have at least one clear next action.
  3. Waiting-for items require owner/date metadata.
  4. Any task older than threshold without movement gets re-decided (do/defer/drop).
- `actions`:
  1. Clarify inbox items into actions/projects.
  2. For each project, ensure one next action exists in active state.
  3. Attempt project closure where outcome achieved and prerequisites met.
  4. Refresh calendar-facing commitments (deadlines/upcoming).
  5. Groom Someday (promote/drop/retain).
- `failure modes`:
  1. Project closure auto-completes unresolved child to-dos if issued blindly.
  2. Missing taxonomy for new contexts.
  3. Batch updates interrupted by UI state.
- `fallback/manual action`:
  1. Switch risky project closures to explicit manual closure queue.
  2. User performs UI taxonomy updates (areas/tags).
  3. Re-run only failed operations.
- `audit log fields`:
  1. `review_date`, `inbox_count_before`, `inbox_count_after`, `projects_reviewed`, `projects_closed`, `waiting_for_count`, `someday_promoted`, `errors`.

## Headless Safety Analysis

1. URL scheme requires macOS app execution context
- Risk: `open "things:///..."` is a LaunchServices/Aqua-style app handoff, so a fully logged-out or truly headless host should not be assumed to receive URL actions at all. An SSH shell may work only when the same user already has an active GUI login session.
- Mitigation: run agent in a logged-in GUI user session or use a local automation daemon/launch agent under GUI context. Treat "SSH into a logged-out Mac" as unsupported unless explicitly validated.

2. Foreground/modal interaction uncertainty
- Risk: modal dialogs or blocked UI state can interrupt mutation flows.
- Mitigation: run a preflight probe (`version`, then one no-op-safe update) before batch operations.

3. Auth token dependency
- Risk: expired/missing token breaks updates.
- Mitigation: startup token check and explicit failure classification (`auth_failure`).

4. Project completion prerequisites
- Risk: `update-project completed=true` may auto-complete unresolved child to-dos instead of prompting, at least in the tested no-heading case.
- Mitigation: never issue project completion until child resolution intent is explicitly computed and approved by policy.

## Guardrail Policy for High-risk Operations

1. Bulk state changes require preview mode first (diff of intended updates).
2. Project completion/cancelation requires readiness check before issuing command.
3. Project completion must be treated as a bulk child-state mutation, not a project-only state flip.
4. Any operation affecting >20 records uses staged batches with checkpoint logging.
5. Unknown capability paths (from Step 3) require manual test confirmation before production use.

## Risk Register

| risk_id | risk | impact | likelihood | mitigation | escalation |
|---|---|---|---|---|---|
| R1 | Tag/area taxonomy mismatch | Medium | High | Maintain governance docs and validation checks | User manual taxonomy update |
| R2 | Headless URL execution failure | High | Medium | Run in GUI session; preflight probes | Pause automation; manual run |
| R3 | Project closure auto-completes unresolved children | High | High | Child-state readiness checks and explicit closure policy | Manual closure checklist |
| R4 | Lack of hard-delete API | Low-Medium | High | Use complete/cancel archive strategy | Periodic manual cleanup |
| R5 | Ordering/reordering unsupported | Low | High | Avoid ordering-dependent workflows | Manual ordering only when needed |
| R6 | Recurrence mutation unavailable | Medium | Medium | Recurrence setup maintained in UI | Recurrence admin cadence |

## Practical Expectation for Weekly Review

- Realistic target: `80-95%` of weekly review actions can be AI-assisted if taxonomy is stable and project support material is kept cleanly in Obsidian.
- Residual manual work: taxonomy administration, occasional structure fixes, and any unsupported/rejected mutations.

## Sources
- Capability constraints from Step 3 matrix.
- Things URL scheme behavior: https://culturedcode.com/things/support/articles/2803573/
- Things lists and workflow references: https://culturedcode.com/things/support/articles/2803564/ and https://culturedcode.com/things/guide/

_Last reviewed: 2026-03-02 (America/Chicago)_
