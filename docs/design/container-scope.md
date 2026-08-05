# Container-scoped sandbox

Hard-limit a whole process's Things access to ONE container — an **area** ("this
coding agent may touch only the *Work* area") or a single **project**. Under a
scope: reads see only in-scope rows, writes are refused or redirected outside
it, and — the crux — an out-of-scope item is **byte-indistinguishable from a
nonexistent one** (the no-oracle guarantee). Requirements source: `docs/up-next.md`
§6 "Container-scoped sandbox mode".

It fits the existing architecture through two seams already present: the
transitive-membership post-filter (`src/read/area-filter.ts`, keyed on the
`EFFECTIVE_AREA` COALESCE chain), which generalizes directly to a scope
predicate; and the single write choke point (`runMutation` in
`src/write/pipeline.ts`), which every mutation — undo legs, reorder legs, batch
legs, the make-repeating orchestrators — already funnels through. Scope becomes
one resolved-once policy value on the client, one universal gate in the pipeline,
and one generalized predicate shared by reads, writes, and ref-resolution
(`src/read/scope.ts`).

## 1. Scope model

### Declaration and precedence

Follows the `THINGS_API_*` family and the `src/config.ts` policy-key pattern
(sibling to `profile`, `maxDisruption`, `ui.enabled`).

- **MCP spawn flag:** `things mcp --scope <ref>` → `McpServerOptions.scope` →
  `OpenOptions.scope`. **This is the real trust boundary.**
- **Env var:** `THINGS_API_SCOPE` — a ref string, resolved like every other ref.
- **Config key:** `scope` in `ConfigFile`, settable via `things config set scope
  <ref>`, surfaced with provenance by `describeConfig()` / `things config get scope`.
- **Precedence:** MCP `--scope` flag (`OpenOptions.scope`) **>** `THINGS_API_SCOPE`
  env **>** stored config `scope` **>** none (unscoped).

This deliberately **inverts** the usual `env > stored` ordering for the flag: the
spawn-time flag outranks env because it is the boundary set by whoever controls
the daemon launch, and an agent that could set env must not override the
launcher's flag (ratified open question Q5).

There is **no per-invocation CLI `--scope` flag** — Mike's framing is "I'm not
going to trust the AI to include a `--area` filter at all times," and a per-call
flag reintroduces exactly that footgun. The CLI reads env/config only; the
per-call convenience already exists as the `--area` view filter (a separate,
additive feature that *composes* with scope — see §5).

### What a scope resolves to

A `ResolvedScope = { kind: "area" | "project"; uuid; title; source; areaUuid }`.
Resolution (`resolveScope`) tries `resolveAreaUuid` then `resolveProjectUuid`
(areas win over a same-named project, mirroring `classifyShowTarget`) and
**rejects a to-do / heading / tag ref** — only an area or a project can be a
container. `areaUuid` is the relevant area context (an area scope: itself; a
project scope: the project's own area, or null for an area-less project), used to
scope the `areas` view and area-ref resolution.

### When resolution happens; deleted-mid-process behavior

- **Resolved exactly once, at `openThings()`**, and pinned on `client.scope`. The
  MCP server's single lazily-opened client means one resolution per daemon
  lifetime — matching the disruption-ceiling model (fixed at spawn).
- **Unresolvable at open → fail closed.** `openThings` throws `ScopeResolutionError`
  (a subclass of `ReferenceResolutionError`), so `things mcp --scope <bogus>`
  refuses to start and a CLI invocation errors as usage. Never start unscoped when
  a scope was requested.
- **Container deleted mid-process → a safe empty jail.** The uuid is pinned at
  open and never re-resolved, so a later deletion means every read returns empty
  and every write is refused (no target or destination can be in scope) —
  fail-closed by construction. Re-resolving per call would reopen TOCTOU and could
  silently re-bind a recreated same-named container.

## 2. The single membership relation (`src/read/scope.ts`)

One relation, two forms, both derived from the same rule (mirroring how
`area-filter.ts` keeps `EFFECTIVE_AREA` as its single source):

- `inScopeItem(item, scope)` — the entity predicate for an already-shaped view
  row. Area scope: the row's effective `area` Ref equals the scope. Project
  scope: the row IS the project, is a direct child (`project`), or is
  heading-nested under one of the project's headings (`headingProject`).
- `scopeMembershipSql(scope)` — the SQL fragment on alias `t`. Area:
  `${EFFECTIVE_AREA} = ?`. Project: `(t.uuid = ? OR t.project = ? OR t.heading IN
  (SELECT uuid FROM TMTask WHERE type = 2 AND project = ?))`. This single source
  is shared by the leak-critical query paths (via `isUuidInScope`) and the
  scope-aware resolvers (via `taskMembershipClause` / `namedProjectClause` /
  `namedAreaClause`, opaque `{where, binds}` clauses threaded into `queries.ts` so
  no runtime import cycle forms).

## 3. Read enforcement

Every read reaches the consumer through `client.read.*`; the filter is applied at
the seam `area-filter` already established — **after the view is shaped, before
the row cap** — so `limit`/per-block caps size the filtered result and truncation
totals stay honest. Single-row / candidate paths apply the SQL membership so a
null/empty answer is produced without a second pass.

| Command | Under scope |
|---|---|
| `today` | `filterTodayByScope` before cap; badge recomputed over in-scope OPEN survivors. |
| `anytime` / `someday` | `filterSectionsByScope`: each section filtered, empty sections dropped. |
| `upcoming` | `filterListByScope` before cap. |
| `logbook` | Post-filter to in-scope logged/resolved rows (linkage survives logging). |
| `inbox` | **Empty under any scope** — captures have no area/project → outside every container. Pairs with the add-redirect. |
| `trash` | Post-filter; a trashed row keeps its linkage until emptied, so membership resolves. Out-of-scope trash invisible. |
| `search` | Post-filter by `inScopeItem`; truncation total recomputed over survivors (a title search is the classic oracle). |
| `changes --since` | Filtered by `inScopeItem` — no out-of-scope uuid may leak into the delta feed. |
| `byUuid` | Resolve scope-aware → an out-of-scope uuid is **null**, exactly like a nonexistent one. |
| `showTarget` | Every tier resolves scope-aware → out-of-scope falls through to the SAME not-found a nonexistent ref throws. |
| `projectView` | Scope-aware resolve → out-of-scope project = not-found parity; in-scope children are in scope by construction. |
| `areaView` | Area scope → only the scope area viewable, else not-found. Project scope → an area is broader than the jail, so **any** areaView is not-found. |
| `areas` | Area scope → the single scope area. Project scope → the project's own containing area only (its own context, not an oracle for siblings — ratified Q2). |
| `projects` | Filtered to in-scope projects. |
| `tags` | **Exempt (unfiltered)** — tags are a global cross-cutting vocabulary, not a container (ratified Q4). |
| `liteTitleSearch` | Did-you-mean candidates filtered to in-scope tasks / the scope's own area. |
| `snapshot` | **Refuses under scope** — a silently partial whole-library dump is misleading; a scoped-dump variant is deferred (ratified Q3). |

MCP mirror: the read tools already thread `area` and call `client.read.*`, so
they inherit scope automatically. The one MCP-specific fix is
`buildInstructions()` — see §5, leak surface 9.

## 4. Write enforcement

Two enforcement points in `runMutation`, plus a documented default rule:

1. **Target-in-scope, as not-found parity, at uuid RESOLUTION.** The pipeline
   threads the scope clauses into `resolveProjectWriteTarget` /
   `resolveTaskUuidPrefix`, so an out-of-scope target resolves to "not found"
   through the IDENTICAL code path a nonexistent one does — byte-identical error,
   before pre-read/guards ever run.
2. **The universal scope gate, after pre-read, BEFORE `evaluateGuards`**
   (`evaluateScope`, `src/write/scope-guard.ts`). It runs for EVERY op (unlike
   hazards, which run only when a spec lists them), so a scope refusal precedes
   any hazard copy — no hazard prompt (e.g. a reopen-ack) may ever fire for an
   out-of-scope target (that would be an oracle). It applies the add-redirect
   defaulting, the structural refusals, and the destination gate.

**Ordering (amendment 6):** target-parity at resolution → pre-read →
`evaluateScope` → `evaluateGuards`.

### Add-redirect defaulting

A bare create with no destination defaults into the scope container:
`todo.add` / `project.add` (area scope → `area = scope`; project scope, `todo.add`
→ `project = scope`). Implemented by mutating the resolved `pre` destination so
the compile places it in-scope and the delta asserts the placement. Never lands
in the Inbox.

### Destination gate (result-stays-in-scope)

Any resolved destination (`pre.destProject` / `destHeading` / `destArea`) that is
out of scope is **nullified** so the normal `H-UNKNOWN-DESTINATION` guard fires —
byte-identical to a nonexistent destination. This closes the "would leave scope"
leak without threading scope through every command's `preRead`.

### Per-op matrix

- **Creates:** `todo.add` / `project.add` bare → redirect (above); explicit dest
  gated. `project.add` under a **project scope** → refuse (a new project would be a
  sibling outside the jail). `area.add` → refuse (top-level). `tag.add` → allowed
  (additive global vocabulary — ratified Q4). A `todo.add --completed-at` (the
  folded Logbook-import path) with no container leaves scope like any container-less
  add — the bare-add redirect / explicit-dest gating above governs it (the bespoke
  `todo.add-logged` op and its dedicated scope refusal are retired).
- **Updates / completes (no container change):** allowed iff target in scope
  (target-parity handles it). Includes `todo.update/complete/cancel/reopen/
  set-tags/set-dates/clear-dated-reminder/replace-checklist/edit-checklist-item`,
  the project equivalents, `heading.rename/archive/unarchive`.
- **`todo.duplicate` / `project.duplicate`:** allowed iff source in scope — the
  copy inherits the source's container, so it stays in scope (amendment 3).
- **Moves:** `todo.move` destination gated; `--inbox` / `--detach` → structural
  refuse. `project.move` under an **area scope**: destination area == the scope
  area is allowed (idempotent — amendment 5); any other → nullified (parity);
  `--detach` → refuse. Under a **project scope** → refuse.
- **Delete / restore:** `todo.delete` / `project.delete` allowed iff target in
  scope (trashes in place). `todo.restore` → **refuse** (returns to the Inbox,
  outside scope — structural). `project.restore` restores in place → allowed iff
  target in scope (an in-scope trashed project; a project scope may restore its
  own container).
- **`trash.empty`** → refuse (global hard-delete of ALL trashed rows).
- **`reorder`:** container-bound scopes (`project`/`area`/`headings`) with an
  in-scope container → allowed; global-view scopes (`today`/`evening`/`inbox`/
  `someday`/`projects`) → refuse (the anchor-stack/bounce wire protocols reorder a
  cross-container list). `area.reorder` → refuse (sidebar order is global).
- **Tags:** `tag.add` allowed; `tag.update` / `tag.delete` refused (rename /
  re-nest / cascade are library-wide shared-state mutations). Tag reads exempt.
- **Identity-replacement:** `todo.make-repeating` — area scope keeps the area,
  project scope keeps the project → allowed iff target in scope.
  `project.make-repeating` / `project.add-repeating` / `todo.convert-to-project`
  / `heading.convert-to-project` under a **project scope** → refuse (the successor
  gets a new uuid the pinned scope won't recognize, or becomes a project that
  can't live in a project jail). Under an **area scope** → allowed (the successor
  inherits the area).
- **Undo / batch:** every inverse and every batch leg runs through `runMutation`,
  so the universal gate refuses any out-of-scope leg for free (defense in depth).

### Default rule (amendment 4)

Any op NOT explicitly in the matrix — `heading.archive`/`unarchive`, future ops —
is allowed iff **target-in-scope AND result-stays-in-scope**, else refused. This
is exactly what the `evaluateScope` fallback enforces (target parity at
resolution + destination gate), so new ops are scope-safe by default: a structural
refusal only when no specific hidden item is referenced; not-found parity when
keyed to one.

## 5. No-oracle guarantee — leak surfaces and parity rules

| Surface | Parity rule |
|---|---|
| Ref-resolution candidates | Resolvers restrict every tier by the scope clause; an out-of-scope-only match → not-found (identical to nonexistent). |
| Error copy | A refusal keyed to a specific out-of-scope uuid/name uses EXACTLY the shared `noUuidMatch(entity, ref)` / not-found path. Only *structural* refusals (empty-trash, restore→Inbox, detach, area reorder) state a reason — none reference a specific hidden item. |
| `byUuid` / `showTarget` / `projectView` / `areaView` | Out-of-scope → `null` (byUuid) or the identical not-found throw (views). |
| `search` / `liteTitleSearch` | Post-filter; truncation total recomputed over survivors. |
| `changes --since` | Filtered by `inScopeItem`. |
| Counts / badges / truncation totals | Today badge recomputed over in-scope survivors; every total computed after the scope filter, before the cap. |
| Undo trail (`runUndo`) | **Closed.** The selection path filters the WHOLE trail to in-scope records BEFORE any listing, selection, or `--txn` check (`filterRecordsByScope`). Rule: **a record qualifies only if its target uuid CURRENTLY resolves in scope** (the same `inScopeItem` / `scopeMembershipSql` relation); an UNRESOLVABLE target — uuid absent, or the row hard-deleted so membership can't be verified — is EXCLUDED under a scope (its record still carries out-of-scope titles; fail-closed is the honest reading). So default/`--by` selection never sees an out-of-scope record ("nothing to undo" when none qualify, identical to an empty trail), and a `--txn` token naming an out-of-scope record fails BYTE-IDENTICALLY to an unknown token (its inverse record is filtered too, so the already-undone branch can't fire and expose it). The full trail is still handed to `planUndo` for the qualifying records' compound-leg / prior-rule reconstruction. Every inverse ALSO runs through the write gate (per-leg refusal) — defense in depth. |
| Audit records | The blocked *result* over the wire follows the parity rules; the host-side audit *file* (never agent-visible over MCP) may record the requested params — it is the owner's log. |
| **9. MCP `buildInstructions()` inventory** | The instructions embed the live area/tag/project inventory. Because they are built via the SCOPED client, `areas()`/`projects()` are already filtered to in-scope containers — out-of-scope names are never embedded. A plain scope note states the bounds. |

### Composition with `--area` (amendment 7)

The per-call `--area` view filter intersects with the scope: it is resolved
scope-aware, so an out-of-scope `--area` ref is not-found (parity), and an
in-scope one narrows within the jail.

## 6. Trust model

- **MCP `--scope` flag = a real boundary.** The agent talks only through the
  tools; the scope is fixed at daemon spawn by whoever controls the launch config
  (like `McpServerOptions.maxDisruption`). No tool can unscope: MCP exposes no
  config-mutation tool and no per-call vector override, and the scoped server
  exposes no unscope path. A genuine sandbox.
- **CLI `THINGS_API_SCOPE` env / config = advisory.** A CLI agent with shell
  access can unset the env or edit the config unless the harness pins the
  environment. Env-scope protects against accidental out-of-scope actions and
  honest agents, not a determined one with a shell — stated plainly in help/skill
  copy, never overclaimed.
- **A stored `scope` config key is a FOOTGUN (amendment 2).** It jails EVERY
  process on the host — including the owner's own terminal — until cleared. The
  key is kept (spec'd), but `things config set scope` prints a loud warning
  pointing at `things mcp --scope` / `THINGS_API_SCOPE` for per-process scoping,
  and `doctor` reports the active ambient scope so the jail is never silent.
- **Composition with the two-key gates.** Scope is an orthogonal, additional
  gate: a ui-drive op still needs `ui.enabled` + `dangerouslyDriveGui` AND must be
  in scope; `maxDisruption` still caps vector selection independently. A scope
  refusal precedes hazard/tier evaluation.
- **Fail closed.** `openThings` refuses to start on an unresolvable requested
  scope; the active scope is logged at MCP startup (stderr), carried on every CLI
  envelope as `meta.scope`, printed as a one-line "scoped to …" banner on TTY
  reads, and reported in `doctor`.

### `meta.scope` and the banner (amendment 1)

Every CLI envelope emitted under an active scope carries an additive
`meta.scope = { kind, uuid, title, source }` (the `meta.clock` / `meta.filter`
precedent). Human/TTY reads print one dim banner line (`scoped to area "Work"`) —
the agent must know its own jail (that is not an oracle), and a stored-config
scope must never be a mystery jail. MCP includes the scope in the (filtered)
`buildInstructions` text.

## 7. Deferred (with rationale)

- **Multi-container / allow-list scopes** — one container keeps the predicate a
  single comparison. Defer until a named need.
- **Scoped `snapshot` content** (vs refuse) — a scoped-dump is a separate design
  (backup/restore expectations).
- **Per-scope Inbox remap** (showing the container as "the inbox") — inbox=empty
  is correct and matches the invisibility rule.
- **`things watch` scoped watcher** — a separate feature; a scoped process yields
  a scoped watcher for free once both land.
- **`changes --since` DELETION rows (tombstones) under a scope (amendment 8).**
  When the queued deletion feature lands (tombstones, up-next §6), tombstone rows
  carry **no container ancestry** — the deleted row is gone, so `inScopeItem`
  cannot resolve its container. Under a scope, deletion rows must therefore be
  **OMITTED** from the delta with an honest one-line note in the payload, never
  emitted (a uuid leak) and never silently dropped (a correctness gap the consumer
  can't see). Recorded here so the two features don't collide.

## 8. Deviations from the original plan

- **~~`todo.add-logged` is REFUSED under scope~~ — RETIRED.** The bespoke
  `todo.add-logged` op was deleted (resolution-timestamp surface, plan PR A); the
  Logbook-import path folds into `todo.add --completed-at`, which DOES carry the
  full container vocabulary (`--project`/`--area`/`--heading`), so it takes the
  ordinary scoped-add redirect/gate path instead of a dedicated refusal. A
  container-less timestamped add leaves scope exactly like any container-less add.
- **The post-verify in-scope assertion (plan §4.3, belt-and-braces) is not
  implemented.** The pre-dispatch gate (target parity + destination gate + default
  rule) is the guarantee; a post-verify re-read that downgrades to
  `verify-failed:mismatch` on an unpredicted app reparent is defense-in-depth that
  risks false positives on legitimate new-uuid ops (make-repeating) and was kept
  out to honor the "surgical pipeline.ts" constraint. Can be added later if a real
  app-reparent case is found.

## 9. Tests

`test/engine/scope.test.ts` (resolution, the read matrix via a scoped
`openThings`, the write matrix via `runMutation`, the byte-identical uuid-parity
golden, candidate parity, add-redirect, project-scope refusals, duplicate,
`--area` composition), `test/mcp/scope-instructions.test.ts` (the buildInstructions
inventory assertion — out-of-scope names absent), `test/cli/scope-cli.test.ts`
(`meta.scope` emission + hiding), `test/engine/scope-undo.test.ts` (the undo
trail filter — out-of-scope records invisible, the `--txn` parity golden incl.
the already-undone case), `test/cli/config-get-cli.test.ts` (the `scope`
config key).
