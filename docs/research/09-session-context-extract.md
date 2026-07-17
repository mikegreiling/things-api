# Step 9 - Original Codex Session Context Extract

Source session:
- `~/.codex/sessions/2026/03/02/rollout-2026-03-02T14-01-57-019cb024-a47d-7a91-a7ac-425c580fdb0f.jsonl`

Extraction date:
- 2026-06-19

## How to Use This Extract

Use this file as the handoff context for future work. Do not ingest the raw JSONL into an agent as primary context unless you are searching for a specific missing detail.

Why:
- The raw session contains old system/developer instructions, tool outputs, web-search artifacts, repeated state, encrypted reasoning blobs, and obsolete paths.
- The raw session may contain historical local identifiers, Things record IDs, and auth-token-bearing command text; treat it as sensitive.
- The high-value content is the sequence of decisions, validation results, and architecture constraints, which are distilled here and in Steps 1-8.
- The raw JSONL is still useful as a searchable archive when a specific provenance question arises.

Recommended future-agent prompt:
- Read `docs/ai-gtd-things/README.md`, then `08-resume-and-next-steps.md`, then this file.
- Treat `03-automation-capability-matrix.md` and `validation-notes-step3.md` as source of truth for Things capability.
- Use the JSONL only to audit or recover rationale not present in the Markdown docs.

## Session Timeline

### 2026-03-02 - Plan and Initial Artifacts

Initial user goal:
- Systematize GTD with an AI agent using Things by Cultured Code for actions and Obsidian for project/reference context.
- Build a staged, evidence-first plan covering Things data model, GTD mapping, automation capability, feasible workflows, weekly review, Things/Obsidian boundary, and the final operating model.

Initial implementation outcome:
- The workspace was empty.
- Seven Markdown artifacts were created under `~/Projects/second-brain/docs/ai-gtd-things`.
- Sources included Cultured Code support docs, official Things URL scheme docs, `things.py` docs/source, and `things-mcp`.

Important framing from the first pass:
- Things remains the action execution system.
- Obsidian remains the strategy/reference/project-support system.
- Mutations should use official Things URL scheme paths.
- Reads can use `things.py` and, if needed, raw SQLite queries.
- Direct SQLite writes to Things are out of bounds.

### 2026-03-03 - Step 1 and Step 2 Refinement

Step 1, Things data model canon:
- Added projects with notes and tags.
- Clarified project notes as visible first-class UI content above child to-dos.
- Added area/project tag inheritance as a native UI behavior.
- Added heading behavior and the need to preserve ordering/context.
- Added richer repeating-task semantics.
- Added ambiguity markers for ordering metadata, read API fidelity, and repeating items in third-party APIs.

Step 2, GTD-to-Things mapping:
- Added normative "linting" rules for task/project quality.
- Treated notes as first-class execution context, not incidental metadata.
- Established a Things-first policy for small project/to-do context.
- Established an Obsidian handoff threshold when notes become too large, reference-heavy, or strategy-like.
- Clarified completion/cancel annotation expectations.
- Clarified Someday/Maybe and Incubated distinctions.
- Added parent-tag namespace convention and dual-home linking policies.

### 2026-03-03 - Step 3 Architecture Framing

Key correction:
- Read access is assumed to be a solvable problem, not necessarily a place to spend unlimited time.
- The hard constraints are write/update/delete behaviors and mutation reliability.

AppleScript and Shortcuts exclusion rationale:
- They may involve external tools/processes that do not mesh cleanly with the desired AI-agent workflow.
- No required capability had been identified there that was absent from URL-based mutation plus DB reads.

Mutation reliability rule:
- Production writes must be scripted, not model-memory-based.
- Required pipeline: `pre-read -> write -> verify -> reconcile -> audit log`.
- Silent no-ops must be treated as failures.
- Direct database writes remain prohibited.

Interface strategy:
- MCP-first is acceptable for exploration, but MCP is only an adapter.
- Capability truth comes from URL scheme behavior plus database read behavior.
- A custom TypeScript API/CLI is a reasonable target if the agent stack is TypeScript-first.

### 2026-03-12 to 2026-03-13 - Step 3 Manual Validation

Core validation results:
- `T01`: `things:///version` launches Things if closed and brings it to foreground, but does not necessarily open a window or visibly navigate.
- `T02`: Existing-record update without `auth-token` fails with a Things URL Scheme modal; no mutation should be assumed.
- `T03`: `things:///add` creates an Inbox to-do; unknown tags are silently ignored and no tag taxonomy entry is created.
- `T04`: Tags can be replaced by sending the full desired tag list; unknown tags in a mixed list are ignored rather than failing the whole update.
- `T06`: Moving a to-do to an existing area/list works; unknown destinations can silently no-op, making post-write verification mandatory.
- `T07`: Checklist writes work as whole-list/append/prepend operations, but direct item-id mutation was not available.
- `T08`: URL-based project completion does not mirror manual UI prompting; it can auto-complete unresolved child to-dos.
- `T12`: Scheduling writes against repeating items are hazardous; `when=today` caused Things to crash and left the item unchanged, while some non-scheduling writes worked.
- `T15`: To-do-to-project promotion is a UI-only flow for this system.
- `T16`: Repeating items can be read directly by UUID, but normal `things.py` list-view helpers may omit them and do not expose full recurrence metadata.
- `T17`: Ordering metadata is readable, but full project views require compositing multiple sources.
- `T18`: `things.py` exposes direct tags, not native UI-style inherited area/project tag filtering.
- `T19`: Adding an unresolved child to a completed, canceled, or logged project reopens that project.
- `T20`: Adding checklist items to a completed to-do does not reopen the parent to-do.

Additional operational hazards:
- URL-scheme modals can stack and must be dismissed before batch work.
- A successful `open "things:///..."` only proves macOS handed off the URL; it does not prove Things executed the intended mutation.
- Mutations can be visually invisible if Things has no open window or is focused elsewhere.

### 2026-03-13 - Headings and Project Read Model

Important implementation detail:
- Headings are real containers in the UI and data model, not only visual separators.
- To-dos under headings carry `heading` / `heading_title` metadata.
- `things.projects(..., include_items=True)` can duplicate heading-contained to-dos: once in the flat project list and again nested under the heading object.

Project read-model rule:
- Do not build the canonical agent-facing project-task feed from `project.items` when headings may exist.
- Prefer a flat task query such as `tasks(type='to-do', project=...)`, preserving heading metadata separately.
- Treat the native project view as segmented/composite: active items, headings, scheduled/later items, Someday items, repeating items, logged items, and trash may need separate read paths.

### 2026-03-13 - Today / This Evening / Ordering

`This Evening` finding:
- It is represented distinctly in raw DB fields.
- Observed fields included `start = 1`, `startDate = today`, and `startBucket = 1`.
- `things.py` flattens This Evening into ordinary `today()` output and does not expose a clean evening flag.

Ordering findings:
- `Today` and `This Evening` ordering can be validated from SQLite using section/group fields and `todayIndex`.
- `todayIndex` and general `index` behave like sparse rank keys, not dense sequential counters.
- Moving an item from `Today` to `This Evening` prepended it to the target section.
- Moving an item from `This Evening` to `Today` prepended it to the target section.
- Bouncing an item through the opposite section can front-insert it back into its original section.
- Repeating bounce operations can construct a deliberate Today order by applying operations in reverse target order.

Ordering caveats:
- This reorder primitive is promising but should remain experimental until encoded and tested as a controlled algorithm.
- Ordering-key collisions exist.
- The universal tiebreaker is unknown and likely view-specific.
- Do not invent a global fallback such as UUID or title until controlled same-context tests justify it.
- Collision behavior can remain undefined for MVP.

### 2026-03-13 - Git / Provenance

The docs were accidentally created as a nested git repo under:
- `~/Projects/second-brain/docs/ai-gtd-things/.git`

Nested repo commits:
- `190c412` - initial docs
- `d406674` - refined Things capability findings and ordering model

User requested removing the nested git repo and committing at top level.

Recorded outcome:
- Safety backup created at `~/Desktop/ai-gtd-things-backup-20260313-183252/ai-gtd-things`.
- Nested `.git` removed from `docs/ai-gtd-things`.
- Docs committed in the top-level `second-brain` repo.
- Top-level commit: `004b9f9` (`Add AI GTD Things research docs`).

Current recovered location differs by path mount:
- Original session path: `~/Projects/second-brain`
- Current canonical path: `/Volumes/Workspace/Projects/second-brain`

## Final Step 3 Closure

The old session concluded that Step 3 was complete enough for MVP architecture.

Settled for MVP:
- Reads are broadly solvable, but `things.py` has real gaps.
- Official writes must go through the URL scheme.
- Delete is unsupported.
- Area/tag taxonomy mutation is unsupported.
- Heading lifecycle automation is effectively unsupported, but heading placement works.
- Project completion has dangerous side effects.
- Repeating-item scheduling writes are hazardous.
- `Today` / `This Evening` have a viable reorder primitive and a DB representation that can be verified.

Deferred or optional:
- Project-scope reorder by bounce.
- Later-item reorder inside a project.
- Logged-out or truly headless behavior.
- Additional repeating-item mutations.
- Trash targeting.
- Ordering collision tiebreakers.

Recommended next architectural move from the old session:
- Stop probing broad URL capability for now.
- Tighten implementation around a custom read layer over SQLite.
- Use URL-only writes.
- Require mandatory read-after-write verification.
- Add hard guards around repeating scheduling and project completion.
- Limit reorder automation to explicit, tested Today / This Evening behavior.

## Implementation Guidance for the Next Agent

Start with read-only tooling:
- `doctor`
- `snapshot`
- `today`
- `inbox`
- `projects`
- `project <id>`
- `areas`
- `tags`

Do not start with writes.

First slice acceptance criteria:
- Locate the Things database.
- Read schema/version/fingerprint.
- Query tasks, projects, areas, tags, headings, checklist items, and joins needed for tags/containment.
- Render Today grouped into Today vs This Evening using raw DB fields where needed.
- Include stable UUIDs in output.
- Change nothing in Things.

Write support comes later:
- Build URL constructors.
- Pre-read target state by UUID.
- Execute one mutation.
- Re-read and assert expected deltas.
- Log the request, observed result, and rollback/manual intervention hint.

Guardrails:
- No direct DB writes.
- No autonomous project completion unless child-resolution policy is explicit.
- No repeating-item scheduling writes in MVP.
- No delete in MVP.
- No area/tag taxonomy mutation in MVP.
- No heading lifecycle mutation in MVP.
- No synthetic reorder outside Today / This Evening until separately validated.

## Raw JSONL Mining Recipe

Use these patterns if more provenance is needed:

```sh
jq -r 'select(.type=="response_item" and .payload.type=="message") | [.timestamp, .payload.role, ((.payload.content[0].text // .payload.content[0].content // "") | gsub("\n"; " ") | .[0:220])] | @tsv' ~/.codex/sessions/2026/03/02/rollout-2026-03-02T14-01-57-019cb024-a47d-7a91-a7ac-425c580fdb0f.jsonl
```

Useful search terms:
- `Step 3`
- `phase 3`
- `validation-notes-step3`
- `things.py`
- `things-mcp`
- `auth-token`
- `This Evening`
- `todayIndex`
- `repeating`
- `project completion`
- `include_items`
- `004b9f9`

Avoid extracting:
- `developer` messages
- `turn_context`
- encrypted reasoning
- raw tool-call output unless it contains a missing observation not already captured in the docs
