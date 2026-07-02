# Step 3 - Programmatic Capability Matrix (Things URL Scheme + things.py + things-mcp)

## Scope and Evidence Policy
- Scope: What can and cannot be automated in Things using:
  - Official Things URL scheme (authoritative mutation surface)
  - `things.py` (database read library + URL helpers)
  - `things-mcp` (agent-callable MCP tool layer)
- Excluded by request: AppleScript and Shortcuts.
- Exclusion rationale 1: those paths introduce external tool/process dependencies that may not fit a clean AI-agent pipeline.
- Exclusion rationale 2: no clearly required capability has been identified there that is absent from URL-driven mutation + database reads.
- Evidence policy: `Source-backed` claims only. Unknowns are explicitly marked and paired with tests.

## Read vs Write Posture (Decision)

1. Read posture:
- Working assumption is that Things resources are broadly readable through local database access (`things.py` and, if needed, raw SQL queries).
- Practical read gaps are usually query/view-shaping issues (for example recurring/task filters), not fundamental inability to read data.

2. Write posture:
- The hard constraints are in mutation surfaces (primarily URL scheme semantics and what wrappers expose).
- This document focuses on write/update/delete limits and mutation reliability.
- Direct SQL writes to Things DB are out of bounds: they are unofficial, risk sync drift/corruption, and bypass official app mutation pathways.

## Surface Definitions

1. `url_scheme`
- Official commands: `add`, `add-project`, `update`, `update-project`, `show`, `search`, `version`, `json`.
- No machine-readable read/list API.
- Updates to existing data require `auth-token`.

2. `things_py`
- Primary role is local database reads (`tasks`, `todos`, `projects`, `areas`, `tags`, etc.).
- Exposes URL construction helpers (`url`) and some URL-executing helpers (`show`, `complete`) that open `things:///...` links.
- Does not expose first-class `add_todo`, `update_todo`, or `update_project` helper APIs in the published docs.

3. `things_mcp`
- Exposes a bounded tool set (read + selected write operations) from `src/things_mcp/server.py`.
- Write tools are limited to: `add-todo`, `add-project`, `update-todo`, `update-project`, `show-item`, `search-items`.
- No MCP tools for heading lifecycle management, duplicate, delete, or area taxonomy edits.
- Practical interpretation: MCP is a subset wrapper over `things.py` + URL mutations, so source-of-truth capability analysis remains URL/database-first.

4. `ui`
- Full native behavior including taxonomy administration and drag-and-drop ordering.

## Capability Matrix Schema

Each row uses:
- `object`
- `operation`
- `surface` (`url_scheme | things_py | things_mcp | ui`)
- `support_level` (`yes | partial | no`)
- `evidence`
- `headless_safe` (`yes | no | unknown`)
- `manual_step_required` (`yes | no`)
- `test_id` (present for `partial` or unresolved assumptions)

## Detailed Matrix

| object | operation | surface | support_level | evidence | headless_safe | manual_step_required | test_id |
|---|---|---|---|---|---|---|---|
| to_do | create | url_scheme | yes | `add` command | unknown | yes | |
| to_do | create | things_py | partial | No dedicated create helper; can build URL via `things.url(...)` and run externally | unknown | yes | T03 |
| to_do | create | things_mcp | yes | `add-todo` tool in README/server | unknown | no | |
| to_do | read | url_scheme | no | No read/list endpoint in URL scheme | n/a | n/a | |
| to_do | read | things_py | yes | `things.todos()` / `things.tasks(type='to-do')` | yes | no | |
| to_do | read | things_mcp | yes | `get-todos`, list-view tools | yes | no | |
| to_do | update title/notes | url_scheme | yes | `update` supports `title`, `notes`, prepend/append variants; user confirmed `title` update succeeds on a repeating to-do | unknown | yes | |
| to_do | update title/notes | things_py | partial | No dedicated update helper; URL construction via `things.url(command='update', ...)` | unknown | yes | T03 |
| to_do | update title/notes | things_mcp | yes | `update-todo` supports `title`, `notes` | unknown | no | |
| to_do | append/prepend notes | url_scheme | yes | `append-notes`, `prepend-notes` params | unknown | yes | |
| to_do | append/prepend notes | things_py | partial | Possible through manual URL parameters | unknown | yes | T03 |
| to_do | append/prepend notes | things_mcp | no | `update-todo` tool does not expose append/prepend note params | n/a | n/a | |
| to_do | schedule (`when`) / deadline | url_scheme | partial | Supported on normal to-dos; on repeating to-dos, `when` write reproducibly crashed Things in T12 while leaving the item unchanged. Deadline on repeating items remains unvalidated. | unknown | yes | T12 |
| to_do | schedule (`when`) / deadline | things_py | partial | URL-driven; inherits repeating-item scheduling crash risk observed in T12 | unknown | yes | T12 |
| to_do | schedule (`when`) / deadline | things_mcp | partial | `update-todo` supports these fields, but repeating-item scheduling writes are hazardous given T12 crash observation | unknown | no | T12 |
| to_do | move to area/project/list | url_scheme | yes | `list` / `list-id` on `update` | unknown | yes | |
| to_do | move to area/project/list | things_py | partial | URL-based update path only | unknown | yes | T03 |
| to_do | move to area/project/list | things_mcp | yes | `update-todo` exposes `list` / `list_id` | unknown | no | |
| to_do | move under heading | url_scheme | yes | `heading` / `heading-id` on `update` | unknown | yes | |
| to_do | move under heading | things_py | partial | URL-based update path only | unknown | yes | T03 |
| to_do | move under heading | things_mcp | yes | `update-todo` exposes `heading` / `heading_id` | unknown | no | |
| to_do | tag assignment (existing tags) | url_scheme | yes | `tags`, `add-tags`; non-existent tags ignored | unknown | yes | |
| to_do | tag assignment (existing tags) | things_py | partial | URL-based update path only | unknown | yes | T03 |
| to_do | tag assignment (existing tags) | things_mcp | yes | `update-todo` exposes `tags` list | unknown | no | |
| to_do | remove one tag | url_scheme | partial | No remove-one param; use full replacement via `tags=` set | unknown | yes | T04 |
| to_do | remove one tag | things_py | partial | Requires read-then-replace strategy | unknown | yes | T04 |
| to_do | remove one tag | things_mcp | partial | Requires read-then-replace through `update-todo tags` | unknown | no | T04 |
| to_do | complete/cancel/reopen | url_scheme | partial | Supported, but status fields cannot be updated on repeating to-dos | unknown | yes | T12 |
| to_do | complete/cancel/reopen | things_py | partial | `things.complete(uuid)` exists; cancel/reopen require manual URL update | unknown | yes | T03 |
| to_do | complete/cancel/reopen | things_mcp | partial | Supported by `update-todo` booleans, but repeating limitations apply | unknown | no | T12 |
| to_do | duplicate | url_scheme | partial | `duplicate=true` supported except repeating to-dos | unknown | yes | T12 |
| to_do | duplicate | things_py | partial | URL-based only | unknown | yes | T03 |
| to_do | duplicate | things_mcp | no | No duplicate argument/tool exposed | n/a | n/a | |
| to_do | delete/permanent delete | url_scheme | no | No delete command; JSON update allows only to-do/project update ops | n/a | n/a | T14 |
| to_do | delete/permanent delete | things_py | no | No delete API documented | n/a | n/a | T14 |
| to_do | delete/permanent delete | things_mcp | no | No delete tool exposed | n/a | n/a | |
| to_do | promote to project | url_scheme | no | No command documented for to-do -> project conversion | n/a | n/a | T15 |
| to_do | promote to project | things_py | no | No API documented | n/a | n/a | T15 |
| to_do | promote to project | things_mcp | no | No MCP tool exposed | n/a | n/a | |
| project | create | url_scheme | yes | `add-project`, `json` project objects | unknown | yes | |
| project | create | things_py | partial | No dedicated create helper; URL generation possible | unknown | yes | T03 |
| project | create | things_mcp | yes | `add-project` tool | unknown | no | |
| project | create with seeded to-dos | url_scheme | yes | `to-dos` parameter, JSON `items` | unknown | yes | |
| project | create with seeded to-dos | things_mcp | yes | `add-project` has `todos` titles list | unknown | no | |
| project | read | url_scheme | no | No read/list endpoint | n/a | n/a | |
| project | read | things_py | yes | `things.projects()` / `things.tasks(type='project')` | yes | no | |
| project | read | things_mcp | yes | `get-projects` | yes | no | |
| project | update title/notes/when/deadline/tags | url_scheme | partial | Supported, except repeating project restrictions on several fields | unknown | yes | T12 |
| project | update title/notes/when/deadline/tags | things_py | partial | URL-driven only | unknown | yes | T03 |
| project | update title/notes/when/deadline/tags | things_mcp | partial | `update-project` supports these fields, repeating limitations apply | unknown | no | T12 |
| project | move to area | url_scheme | yes | `area` / `area-id` on `update-project` | unknown | yes | |
| project | move to area | things_py | partial | URL-driven only | unknown | yes | T03 |
| project | move to area | things_mcp | no | `update-project` tool has no `area`/`area_id` args in current server | n/a | n/a | |
| project | complete/cancel/reopen | url_scheme | partial | Observed via T08: `completed=true` auto-completes unresolved child to-dos and completes the project in the tested no-heading case; canceled children stay canceled; heading/logged edge cases still unresolved | unknown | yes | T08 |
| project | complete/cancel/reopen | things_py | partial | URL-driven; inherits observed T08 side effects and remaining unknowns | unknown | yes | T08 |
| project | complete/cancel/reopen | things_mcp | partial | `update-project` booleans available; inherits observed T08 side effects and remaining unknowns | unknown | no | T08 |
| project | add child to completed/logged project | url_scheme | partial | Not yet validated; important follow-up for post-completion mutation behavior | unknown | yes | T19 |
| project | add child to completed/logged project | things_py | partial | Likely URL-driven create path targeting existing project; behavior unresolved | unknown | yes | T19 |
| to_do | add checklist items to completed/logged to-do | url_scheme | partial | Observed via T20: checklist items can be added to a completed to-do without reopening it; completed/logged distinction remains unresolved | unknown | yes | T20 |
| to_do | add checklist items to completed/logged to-do | things_py | partial | URL-driven path; inherits observed T20 behavior and remaining logged-item unknowns | unknown | yes | T20 |
| project | duplicate | url_scheme | partial | `duplicate=true`; repeating projects cannot be duplicated | unknown | yes | T12 |
| project | duplicate | things_py | partial | URL-driven only | unknown | yes | T03 |
| project | duplicate | things_mcp | no | No duplicate argument/tool exposed | n/a | n/a | |
| project | delete/permanent delete | url_scheme | no | No delete command documented | n/a | n/a | T14 |
| project | delete/permanent delete | things_py | no | No delete API documented | n/a | n/a | T14 |
| project | delete/permanent delete | things_mcp | no | No delete tool exposed | n/a | n/a | |
| heading | read | url_scheme | no | URL scheme has no read/list endpoint | n/a | n/a | |
| heading | read | things_py | yes | `things.tasks(type='heading')` | yes | no | |
| heading | read | things_mcp | yes | `get-headings` tool in server source | yes | no | |
| heading | create in new project payload | url_scheme | yes | JSON `project.attributes.items` can contain `heading` objects | unknown | yes | |
| heading | create in existing project | url_scheme | no | JSON updates only support to-do/project objects; no heading update/create op for existing project | n/a | n/a | T09 |
| heading | create in existing project | things_py | no | No documented API | n/a | n/a | T09 |
| heading | create in existing project | things_mcp | no | No add-heading tool exposed in current server | n/a | n/a | |
| heading | update/archive/delete | url_scheme | no | JSON update supports only to-do/project; no heading update op | n/a | n/a | T10 |
| heading | update/archive/delete | things_py | no | No documented API | n/a | n/a | T10 |
| heading | update/archive/delete | things_mcp | no | No heading mutation tools exposed | n/a | n/a | |
| checklist_item | add/create | url_scheme | yes | `checklist-items`, `prepend-checklist-items`, `append-checklist-items`; JSON checklist-item objects; user confirmed checklist add succeeds on a repeating to-do | unknown | yes | |
| checklist_item | add/create | things_py | partial | URL-driven only | unknown | yes | T03 |
| checklist_item | add/create | things_mcp | partial | Supported in `add-todo` via `checklist_items`, not full lifecycle tooling | unknown | no | T07 |
| checklist_item | update/complete/cancel individual item | url_scheme | partial | Supported via replacing full `checklist-items` list in update/JSON; no direct item-id mutation command; checklist state does not control parent to-do resolution | unknown | yes | T07 |
| checklist_item | update/complete/cancel individual item | things_py | partial | URL-driven replace-list strategy; checklist state does not control parent to-do resolution | unknown | yes | T07 |
| checklist_item | update/complete/cancel individual item | things_mcp | no | `update-todo` tool has no checklist-item mutation args in current server | n/a | n/a | |
| checklist_item | reorder | url_scheme | no | No ordering/index parameters for checklist item positions | n/a | n/a | T11 |
| checklist_item | reorder | things_py | no | No reorder API documented | n/a | n/a | T11 |
| checklist_item | reorder | things_mcp | no | No reorder tool exposed | n/a | n/a | |
| area | read | url_scheme | no | No area read endpoint | n/a | n/a | |
| area | read | things_py | yes | `things.areas()` supports tags and include_items | yes | no | |
| area | read | things_mcp | yes | `get-areas` | yes | no | |
| area | assign existing area to to-do | url_scheme | yes | Move to area via `list`/`list-id` in `update` | unknown | yes | |
| area | assign existing area to to-do | things_mcp | yes | `update-todo` with list/list_id | unknown | no | |
| area | assign existing area to project | url_scheme | yes | `update-project area/area-id` | unknown | yes | |
| area | assign existing area to project | things_mcp | no | `update-project` tool lacks area args | n/a | n/a | |
| area | create/rename/delete/reorder taxonomy | url_scheme | no | No area taxonomy commands in URL docs | n/a | n/a | T05 |
| area | create/rename/delete/reorder taxonomy | things_py | no | Read-only area APIs documented | n/a | n/a | T05 |
| area | create/rename/delete/reorder taxonomy | things_mcp | no | No area taxonomy tools exposed | n/a | n/a | |
| tag | read | url_scheme | no | No tag read endpoint | n/a | n/a | |
| tag | read | things_py | yes | `things.tags()` | yes | no | |
| tag | read | things_mcp | yes | `get-tags` | yes | no | |
| tag | inherited area-tag visibility on child items | things_py | no | T18: child payloads exposed only direct tags; inherited area/project tags were not materialized onto child records | yes | no | T18 |
| tag | inherited area-tag visibility on child items | things_mcp | no | Inherits `things.py` task-tag visibility behavior; no evidence of enrichment layer adding inherited tags | yes | no | T18 |
| tag | inherited tag filtering equivalent to native UI | things_py | no | T18: `things.py` tag-filtered reads matched direct tags only; child to-do did not appear under inherited project/area tag filters even though native UI filtering includes it | yes | no | T18 |
| tag | inherited tag filtering equivalent to native UI | things_mcp | no | Inherits `things.py` direct-tag filtering behavior unless custom enrichment is added | yes | no | T18 |
| tag | create/rename/delete/group taxonomy | url_scheme | no | URL docs only assign existing tags; missing tags are ignored | n/a | n/a | T03 |
| tag | create/rename/delete/group taxonomy | things_py | no | No tag taxonomy mutation APIs documented | n/a | n/a | T03 |
| tag | create/rename/delete/group taxonomy | things_mcp | no | No tag taxonomy mutation tools exposed | n/a | n/a | |
| recurring | create repeating to-do/project template | url_scheme | no | No repeat-rule create/edit params in URL commands | n/a | n/a | T12 |
| recurring | create repeating to-do/project template | things_py | no | No repeat-rule mutation APIs documented | n/a | n/a | T12 |
| recurring | create repeating to-do/project template | things_mcp | no | No repeating-rule tool exposed | n/a | n/a | |
| recurring | read recurring templates/instances | things_py | partial | Direct UUID lookup works, but tested repeating item did not appear in normal list-view helpers and returned dict omitted explicit recurrence metadata even though raw SQLite had repeat fields | yes | no | T16 |
| recurring | read recurring templates/instances | things_mcp | partial | Inherits `things.py` read behavior; repeating visibility is likely incomplete in list-style outputs | yes | no | T16 |
| ordering | reorder items | url_scheme | no | No index/position mutation params | n/a | n/a | T11 |
| ordering | read ordering metadata | things_py | yes | Returns `index` / `today_index`; supports ordering by `index` or `todayIndex` | yes | no | T17 |
| ordering | preserve UI-equivalent ordering in MCP outputs | things_mcp | partial | Depends on `things.py` ordering + MCP formatter behavior | yes | no | T17 |
| global | mutate existing records without auth token | url_scheme | no | `auth-token` required for existing-record mutations | n/a | n/a | T02 |
| global | URL action execution when app closed | url_scheme | yes | Opening `things:///...` launches app and executes command inside a logged-in GUI session; `open` is a LaunchServices/Aqua-style handoff, not a direct headless IPC channel | no (fully headless / logged-out) | no | T01 |
| global | URL actions under modal/background conditions | url_scheme | partial | Behavior not fully specified by docs | unknown | yes | T13 |

## Classification Summary

### Automatable (reliable, source-backed)
1. Create/update most non-repeating to-dos and projects.
2. Assign existing tags and areas (with MCP caveat for project area reassignment).
3. Append/replace notes and checklist content through URL scheme.
4. Read areas/projects/to-dos/tags via `things.py` and `things-mcp`.

### Partially automatable (policy/tests required)
1. Project completion/cancelation has high-risk side effects; tested URL completion auto-completed unresolved child to-dos in the no-heading case.
2. Any operation touching repeating items (field-level write restrictions, read gaps, and a crash observed during scheduling writes in T12).
3. Selective tag removal (requires read-then-replace strategy).
4. Whether inherited area tags appear in child item payloads (`things.py`/MCP) requires validation.
5. Ordering-sensitive workflows (read order metadata exists, write reorder not available).
6. Checklist item lifecycle beyond simple add/replace.
7. Logged-item mutation behavior remains open for completed/logged to-dos and projects.

### UI-only (current evidence)
1. Area taxonomy management (create/rename/delete/reorder).
2. Tag taxonomy management (create/rename/delete/group hierarchy management).
3. Heading lifecycle in existing projects (create/update/archive/delete).
4. Repeating rule creation and editing.
5. To-do -> project promotion flow.

## Friction Tiers (Operational Priority)

1. Extremely low friction:
- Read/write operations already implemented in `things-mcp`.

2. Low friction:
- Read/write operations using `things.py` reads plus official URL-scheme mutations.

3. Medium friction:
- Read paths requiring targeted raw SQL query development against the local Things database.

4. High friction:
- Writes not supported by official mutation surfaces (requires user UI intervention or GUI-driving automation).
- MVP direction: avoid high-friction write automation.

## Important Quirks and Constraints

1. URL scheme commands can launch/foreground Things.
2. URL updates to existing records require `auth-token`.
3. Tag assignment silently ignores unknown tags.
4. URL supports `duplicate` for to-dos/projects, but not for repeating items.
5. `things.py` reads local database state; if Things has not been opened recently, computed views (especially Today) can drift.
6. URL-based project completion does not mimic the manual UI prompt; in the tested case it auto-completed unresolved child to-dos without prompting.
7. `things.py` task query path includes `IS_NOT_RECURRING`, so recurring visibility is constrained.
8. Current `things-mcp` server intentionally filters Someday-project tasks out of Today/Upcoming/Anytime tools and compensates in `get-someday`.
9. Checklist items are structurally different from project child to-dos: unresolved checklist items do not reopen or block completion of the parent to-do in tested flows.
10. Repeating-item writes are field-sensitive: non-scheduling writes may work, but scheduling writes (`when` in T12) caused Things to crash and left the item unchanged.
11. `open` behaves like a normal macOS LaunchServices handoff ("as if double-clicked"), so URL mutations should be treated as GUI-session actions. A remote SSH shell can plausibly trigger them only when a logged-in GUI session for that user already exists; a fully logged-out/headless host should be treated as unsupported until proven otherwise.
12. The native project view is a composite: active items, later items (future-dated, repeating, Someday), and logged items. `things.py` can expose most of these through separate helpers (`projects/include_items`, `upcoming`, `someday`, `logbook`, `trash`), but the tested repeating project item was only visible through raw SQLite, not the normal `things.py` project/list helpers.
13. Native tag inheritance/filtering semantics are richer than `things.py`: UI filtering can surface child items through ancestor area/project tags, but `things.py` payloads and tag-filtered reads expose direct tags only.
14. When headings exist, `things.projects(..., include_items=True)` is not a canonical flat child-task feed: heading-contained to-dos appear both as flat entries in `project.items` and again nested inside the heading object's `items`. Use `tasks(type='to-do', project=...)` for a flat deduplicated read model and preserve `heading` / `heading_title` as metadata.
15. No direct reorder API has been validated. Any future "reorder by moving items out and back in" workflow should be treated as experimental and high-risk until it is proven against each relevant list context (`Today`, `This Evening`, project active items, later-item date groups, headings).
16. `This Evening` is represented distinctly in the database (`startBucket=1` in the live probe), but `things.py` currently surfaces such items as ordinary `today()` entries without an explicit evening flag. A custom read layer will need to inspect raw DB fields if it wants to preserve the Today-vs-Evening distinction.
17. In live probes, `Today` / `This Evening` ordering was recoverable directly from the database as `(startBucket, todayIndex)`, while the general `index` field remained unchanged across Today/Evening moves. This indicates Today-section order is separate from project/area/general list order.
18. Both `todayIndex` and the general `index` behave like sparse sortable rank keys rather than dense counters. In observed reorder probes, moving one item changed only that item's order key; neighbors were not renumbered.
19. Ordering-key collisions do occur, but the universal fallback rule is still unresolved. Current evidence suggests `todayIndex` is context-specific (relevant to Today-style views, not obviously to Anytime), and the correct tie-breaker likely depends on the rendered view.

## Required Mutation Reliability Pattern (Scripted, Not Agent-Memory-Based)

All production mutations should use a scripted `write -> verify -> reconcile` pipeline, regardless of whether calls are made through MCP or custom `things.py`/URL tooling.

1. Pre-read:
- Read current record state by UUID and capture relevant fields.

2. Write:
- Execute exactly one mutation command/tool call.

3. Verify:
- Re-read the same UUID and assert expected field deltas.
- Treat silent no-op outcomes (for example missing destination list/area or unsupported parameters) as explicit failures, not success.

4. Reconcile:
- If verify fails, run deterministic prerequisite actions and retry once.
- If retry still fails, emit a manual intervention event with reason code.

5. Audit log:
- Persist one action per line with: timestamp, actor, UUID, operation, requested delta, observed delta, result.
6. Drift detection:
- On startup, capture the Things DB version and a fingerprint of the small set of tables/columns the tool depends on.
- Refuse writes if that fingerprint changes unexpectedly until compatibility is revalidated.

## Interface Strategy Decision (MCP vs Custom)

1. MCP-first is acceptable for fast implementation, but only as an interface convenience layer.
2. Capability truth comes from URL scheme + database behavior; MCP should be treated as a subset adapter.
3. If MCP lacks required arguments/flows, implement custom scripted wrappers around URL + read-back verification rather than relying on ad hoc agent follow-up.
4. A custom API layer in TypeScript is reasonable if the surrounding agent stack is TypeScript-first. The required properties are: DB reads, official URL-scheme writes, mandatory post-write verification, and loud failure on mismatch.
5. The local schema is readable enough for this: plain table names (`TMTask`, `TMArea`, `TMChecklistItem`, `TMTag`, `TMTaskTag`, `TMAreaTag`) and plain column names, plus an explicit database version.

## Manual Validation Protocol (User-run)

### Safety setup
1. Create test area: `AI-GTD-TEST`.
2. Create test tags: `ai-test`, `ai-test-2`, `waiting-for`, `priority/high`, `priority/low`.
3. Use disposable naming prefix: `[AI-GTD-TEST]`.
4. Capture observations in `docs/ai-gtd-things/validation-notes-step3.md`.

### URI execution method
- Terminal: `open "<URI>"`
- Browser: paste URI directly.

### Test Cases

| test_id | purpose | URI / action | expected result |
|---|---|---|---|
| T01 | App launch behavior | `things:///version` | Things launches (if closed) and returns callback metadata if provided. |
| T02 | Auth required for existing-record updates | `things:///update?id=<TODO_ID>&title=NoTokenUpdate` | Update ignored/fails without `auth-token`. |
| T03 | Non-existent tag behavior | `things:///add?title=TagProbe&tags=tag-does-not-exist` | Tag is not auto-created/applied. |
| T04 | Remove one tag via replacement | `things:///update?id=<TODO_ID>&tags=ai-test,ai-test-2&auth-token=<AUTH>` then `...&tags=ai-test...` | Second call effectively removes `ai-test-2`. |
| T05 | Area taxonomy mutation absence | `things:///add-area?title=ShouldFail` | Unsupported command/no-op. |
| T06 | MCP to-do move support | Run `update-todo` via MCP with `list_id=<AREA_OR_PROJECT_ID>` | To-do moves to destination list successfully. |
| T07 | Checklist lifecycle granularity | `things:///update?id=<TODO_ID>&checklist-items=A%0AB%0AC&auth-token=<AUTH>` then prepend/append variants | Full-list replace and prepend/append work; no direct item-id edit path. |
| T08 | Project completion side effects | `things:///update-project?id=<PROJECT_ID>&completed=true&auth-token=<AUTH>` with open child items | In tested no-heading case, project completes and unresolved child to-dos are implicitly marked completed; canceled children remain canceled. |
| T09 | Heading creation in existing project | `things:///json?auth-token=<AUTH>&data=%7B%22items%22%3A%5B%7B%22type%22%3A%22project%22%2C%22id%22%3A%22<PROJECT_ID>%22%2C%22operation%22%3A%22update%22%2C%22attributes%22%3A%7B%22items%22%3A%5B%7B%22type%22%3A%22heading%22%2C%22attributes%22%3A%7B%22title%22%3A%22Injected%20Heading%22%7D%7D%5D%7D%7D%5D%7D` | Should fail/ignore; heading creation for existing project unsupported. |
| T10 | Heading update/archive via JSON | `things:///json?auth-token=<AUTH>&data=%7B%22items%22%3A%5B%7B%22type%22%3A%22heading%22%2C%22operation%22%3A%22update%22%2C%22id%22%3A%22<HEADING_ID>%22%2C%22attributes%22%3A%7B%22archived%22%3Atrue%7D%7D%5D%7D` | Should fail/ignore because JSON updates only support to-do/project. |
| T11 | Reorder parameter absence | `things:///update?id=<TODO_ID>&list=<PROJECT_ID>&index=1&auth-token=<AUTH>` | Position should not be controlled by this unsupported param. |
| T12 | Repeating item mutation constraints | Run updates against a known repeating template/item: set `when`, `deadline`, `completed`, `duplicate=true` | `when=today` reproducibly crashed Things and left the item unchanged. Non-scheduling writes (for example `title`, checklist items) still worked on the same repeating item. Further scheduling/date probes remain hazardous and optional. |
| T13 | Modal/background robustness | Run a normal update while modal is open and while app is hidden | Record whether command executes, queues, fails, or steals focus. |
| T14 | Delete command absence | `things:///delete?id=<TODO_ID>&auth-token=<AUTH>` and JSON `operation:"delete"` attempt | Unsupported/ignored. |
| T15 | To-do -> project promotion automation gap | Search URL docs + run candidate commands (none documented) | Confirm no URL command for promotion; UI-only flow. |
| T16 | Repeating read visibility in things.py/MCP | Create repeating template in UI, then query via `things.py`/MCP lists | Validate missing/partial visibility due non-recurring query behavior. |
| T17 | Ordering metadata fidelity | Query same list via `things.py` (`index` / `today_index`) and compare to UI order | Determine if returned order tracks visible order for your workflow. |
| T18 | Area-tag inheritance visibility in APIs | Create area tag in UI, assign untagged child to-do in that area, then inspect task tags via `things.py`/MCP | Confirm whether returned tags include inherited tags or only directly assigned tags. |
| T19 | Add to-do to completed/logged project | `things:///add?title=%5BAI-GTD-TEST%5D%20PostCompleteChild&list-id=<PROJECT_ID>&auth-token=<AUTH>` against a completed project, then again after it is logged if possible | Determine whether adding a child reopens the project, is rejected, or mutates a completed/logged project in place. |
| T20 | Add checklist items to completed/logged to-do | `things:///update?id=<TODO_ID>&checklist-items=Post%20Complete%20Check&auth-token=<AUTH>` against a completed to-do, then again after it is logged if possible | In completed-state test, checklist mutation succeeds and does not reopen the to-do; logged-item behavior still needs confirmation if important. |

## Sources
- Things URL scheme reference: https://culturedcode.com/things/support/articles/2803573/
- Things URL scheme help alias: https://culturedcode.com/things/help/url-scheme/
- Using Tags (inheritance, list-tag behavior): https://culturedcode.com/things/support/articles/2803581/
- Moving items/reordering UI behavior: https://culturedcode.com/things/support/articles/9651894/
- Creating repeating to-dos/projects (UI model): https://culturedcode.com/things/support/articles/2803564/
- things.py API docs: https://thingsapi.github.io/things.py/things/api.html
- things.py database docs: https://thingsapi.github.io/things.py/things/database.html
- things-mcp README: https://github.com/hald/things-mcp
- things-mcp server source: https://raw.githubusercontent.com/hald/things-mcp/master/src/things_mcp/server.py

_Last reviewed: 2026-03-03 (America/Chicago)_
