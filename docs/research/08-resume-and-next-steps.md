# Step 8 - Resume Notes and Next Steps

Recovered on 2026-06-19 from the current `second-brain` project plus matching backups.

## Where the Work Lives

Canonical current copy:
- `/Volumes/Workspace/Projects/second-brain/docs/ai-gtd-things`

Matching backup copies:
- `/Users/mike/Projects-backup-2026-04-26/second-brain/docs/ai-gtd-things`
- `/Users/mike/Desktop/junk/stuff/jank/junk/junk/ai-gtd-things-backup-20260313-183252/ai-gtd-things`

Useful transcript/context sources:
- `/Users/mike/Desktop/pkm-reconstruction/transcripts/01_2026-03-01_second-brain-ai-2026.md`
- `/Users/mike/Desktop/pkm-reconstruction/transcripts/02_2026-03-02_task-management-discussion.md`
- `/Users/mike/Desktop/pkm-reconstruction/transcripts/03_2026-03-03_reverse-engineering-things-app.md`
- `/Users/mike/Desktop/pkm-reconstruction/transcripts/11_2026-03-11_obsidian-things-integration.md`
- `/Users/mike/Desktop/pkm-reconstruction/transcripts/16_2026-03-13_things-app-automation.md`
- `/Users/mike/Desktop/pkm-reconstruction/transcripts/17_2026-03-13_macos-virtualization-for-testing.md`
- `/Users/mike/Desktop/pkm-reconstruction/transcripts/30_2026-03-25_gtd-para-things-alignment.md`

Likely original Codex session:
- `/Users/mike/.codex/sessions/2026/03/02/rollout-2026-03-02T14-01-57-019cb024-a47d-7a91-a7ac-425c580fdb0f.jsonl`

Provenance note:
- On 2026-03-13, that session recorded a safety backup at `/Users/mike/Desktop/ai-gtd-things-backup-20260313-183252/ai-gtd-things`, removal of nested git metadata from `/Users/mike/Projects/second-brain/docs/ai-gtd-things/.git`, and top-level commit `004b9f9` (`Add AI GTD Things research docs`).
- The surviving Desktop backup currently found under `/Users/mike/Desktop/junk/stuff/jank/junk/junk/ai-gtd-things-backup-20260313-183252/ai-gtd-things` still has the nested repo's two commits: `190c412` and `d406674`.

Non-canonical artifact:
- `/Volumes/Workspace/Projects/test/src/things` appears to be a small throwaway test area, not the Things CLI/API implementation.

## Recovered Project Shape

Goal: build an agent-friendly interface over Cultured Code Things for GTD workflows, with Things remaining the execution/action store and Obsidian remaining the strategy/reference store.

Core posture:
- Read from Things through `things.py` and, where needed, targeted raw SQLite queries.
- Write through the official Things URL scheme or wrappers that ultimately call the URL scheme.
- Do not write directly to the Things database.
- Treat `things-mcp` as a useful adapter, not as the source of truth for capability.
- Prefer a custom TypeScript CLI/API layer if the surrounding agent stack is TypeScript-first.

Reliability rule:
- Every mutation must be scripted as `pre-read -> write -> verify -> reconcile -> audit log`.
- Silent no-ops must be treated as failures.
- Schema/version drift should disable writes until compatibility is revalidated.

## Important Findings to Preserve

- Existing-record URL mutations require an `auth-token`.
- Unknown tags are silently ignored rather than created.
- Area/tag taxonomy management is effectively UI-only.
- Direct delete and to-do-to-project promotion are not supported by the URL scheme.
- Project completion via URL can auto-complete unresolved child to-dos without the manual UI prompt.
- Adding an unresolved child to a completed, canceled, or logged project reopens the project.
- Repeating-item writes are hazardous: scheduling writes caused a Things crash in validation, while some non-scheduling writes worked.
- Native project views are composite: active items, scheduled/later items, Someday items, repeating items, logged items, and trash may require separate read paths.
- `things.py` does not materialize inherited area/project tags the same way the native UI filter does.
- `This Evening` is distinguishable in raw DB fields (`startBucket`) but not cleanly surfaced by `things.py`.
- Today/Evening ordering uses sparse order keys; synthetic reorder via Today/Evening bounce looked possible but remains experimental.

## Recommended Resume Path

1. Create a small CLI package, likely outside the Obsidian docs tree, named something like `thingsctl` or `things-agent-tools`.
2. Implement read-only commands first:
   - `doctor`
   - `snapshot`
   - `inbox`
   - `today`
   - `projects`
   - `project <id>`
   - `tags`
   - `areas`
3. Add a read model with explicit view comparators:
   - Today / This Evening
   - Inbox
   - Anytime
   - Upcoming
   - Project active items
   - Project later/logged/trash sections
4. Add mutation URL builders only after read-back by UUID is solid:
   - add/update to-do
   - add/update project
   - move to area/project/heading
   - complete/cancel/reopen
   - tag replace / add-tags
   - checklist replace/append/prepend
5. Require dry-run output and confirmation for high-risk operations:
   - project completion/cancelation
   - any repeating item mutation
   - checklist replacement
   - synthetic reorder experiments
6. Add an audit log format before allowing production writes:
   - timestamp
   - actor
   - UUID
   - operation
   - requested delta
   - observed delta
   - result
   - rollback/manual hint
7. Add an MCP adapter only after the CLI/API behavior is deterministic and tested.

## First Implementation Slice

Build a read-only `doctor + snapshot + today` CLI:

1. Locate the Things database.
2. Read schema/version/fingerprint.
3. Query areas, projects, tags, tasks, headings, checklist items, and task-tag joins.
4. Render Today grouped by Today vs This Evening using raw DB fields where needed.
5. Print UUIDs and stable metadata suitable for agent references.
6. Add no writes yet.

Success criteria:
- The CLI can produce a faithful Today digest without changing Things.
- The output includes enough stable IDs for a later write/verify loop.
- The implementation documents every raw table/column dependency.

## Safety Reminder

Production mutation support should not be exposed to an autonomous agent until the validation suite can create disposable `[AI-GTD-TEST]` records, mutate them, verify them, and cleanly report failures without relying on model memory or visual UI assumptions.
