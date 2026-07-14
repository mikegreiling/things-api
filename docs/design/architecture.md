# things-api — Architecture Design

> Produced at project kickoff (2026-07-02) from the validated research in `../research/`. Runtime claims marked "verified" were checked live against the host's Things 3.22.11 / DB schema v26 during design. Amended per user decision: oxlint + oxfmt instead of Biome.

A macOS-only TypeScript package providing a typed library + agent-discoverable CLI over Things 3. Reads via direct SQLite; writes exclusively via official app surfaces (URL scheme now; AppleScript/Shortcuts as pluggable vectors pending lab probes); every mutation runs a verified pipeline with an audit trail.

## 0. Foundation decisions (runtime, SQLite driver, module posture, build)

**Node floor: `>=24` (LTS), and use `node:sqlite` — not better-sqlite3.**

- Verified live: `node:sqlite` on Node 24.14.1 opens the live Things WAL database with `readOnly: true` and queries it correctly while Things is running (21,501 TMTask rows read). It emits an `ExperimentalWarning` on 24.14.x; the module was promoted to Stability 1.2 (Release candidate), backported to Node 24.15.0 LTS (Feb 2026). API churn risk is effectively closed.
- Rationale over better-sqlite3: zero native dependencies means installs never hit node-gyp, prebuild matrices, or post-Node-upgrade rebuilds; the synchronous API shape is equivalent for our workload (small local reads); we need no extensions and no write features.
- WAL specifics (encode in `db/connection.ts` as policy):
  - Open with `readOnly: true` and a ~2s busy timeout. **Never use `immutable=1`** — it assumes the file cannot change, which is false while Things runs, and would poison the verification engine with stale snapshots.
  - WAL readers don't block on the Things writer; each statement executed outside an explicit transaction gets a fresh read snapshot — exactly what verification polling needs. The poller must NOT wrap polls in a long-lived transaction (that would pin one snapshot).
  - Read-only WAL open requires the `-shm`/`-wal` sidecars to be accessible (they exist whenever Things has run). If open fails with a WAL/shm error, `doctor` reports "launch Things once" as remediation. No copy-the-DB fallback in v1.
- DB discovery: glob `~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite` (suffix varies per account). If multiple match, pick most recently modified and warn. Overridable via `THINGS_DB` env / config / `openThings({ dbPath })` — this is also the primary test seam.

**Verified live during design:**
- `TMSettings.uriSchemeAuthenticationToken` holds the URL-scheme auth token (readable → zero-config write auth).
- Date encodings: `creationDate`/`stopDate`/`userModificationDate` are Unix-epoch REALs; `startDate`/`deadline` are packed integers `y<<16 | m<<12 | d<<7`.
- `Meta.databaseVersion` = 26 (stored as a plist blob; parse the `<integer>` out).

**Module posture: ESM-only, no dual build.** Node ≥22.12 supports `require(esm)`, so even CJS consumers can `require('things-api')`. Single `exports` entry, no CJS artifacts, no bundler.

**Build tooling: plain `tsc`.** With zero runtime deps beyond commander there is nothing to bundle. Author with `erasableSyntaxOnly: true` + `verbatimModuleSyntax: true` so source runs directly under Node 24's built-in type stripping during dev (`node src/cli/main.ts` — no tsx needed). No TS `enum`s (use `as const` unions — better API surface anyway). Publish `dist/` from `tsc`. Lint: **oxlint**; format: **oxfmt**.

CLI shebang: `#!/usr/bin/env -S node --disable-warning=ExperimentalWarning` (BSD `env -S` works; tool is macOS-only) so any residual sqlite warning never pollutes agent-visible stderr.

## 1. Package structure

```
things-api/
  package.json
  tsconfig.json
  .oxlintrc.json
  src/
    index.ts                      # library entry: openThings(), all public types
    client.ts                     # ThingsClient: wires db + read + write + audit + config
    config.ts                     # profiles (workstation | dedicated-server), env, path resolution
    paths.ts                      # XDG-style state/config dirs, THINGS_DB discovery glob
    db/
      locate.ts                   # find ThingsData-*/main.sqlite; multi-match policy
      connection.ts               # node:sqlite wrapper (readOnly, timeout, WAL policy notes)
      schema.ts                   # SINGLE SOURCE OF TRUTH: every table/column/enum we depend on
      fingerprint.ts              # compute normalized structure hash, compare vs baseline
      baselines/
        index.ts                  # registry: databaseVersion -> baseline
        db-v26.ts                 # typed baseline const (columns, hash, enum domains, app versions)
    model/
      entities.ts                 # Todo, Project, Area, Tag, Heading, ChecklistItem + enums
      dates.ts                    # packed-int date codec (y<<16|m<<12|d<<7), epoch-REAL codec
      mappers.ts                  # row -> entity (pure functions)
    read/
      queries.ts                  # parameterized SQL, explicit column lists (loud on drift)
      views.ts                    # today/inbox/anytime/upcoming/someday/logbook/trash
      project-view.ts             # composite project view (active/later/logged/trash segments)
      comparators.ts              # per-view ordering: (startBucket, todayIndex), index, etc.
      tags.ts                     # direct tags + inherited-tag resolution (area/project ancestry)
    write/
      operations.ts               # OperationKind catalog + param types
      commands.ts                 # CommandSpec definitions: hazards + expectedDelta + compile
      guards.ts                   # hazard guard implementations (H-* ids)
      planner.ts                  # vector selection under disruption policy
      pipeline.ts                 # pre-read -> guards -> execute -> verify -> audit
      vectors/
        types.ts                  # WriteVector interface, capability matrix types
        registry.ts               # vector registration (pluggable)
        url-scheme.ts             # things:/// compiler + `open` executor + token handling
        url-scheme.matrix.ts      # per-operation support/disruption/validation metadata
        applescript.ts            # stub: registered, matrix entries validation:'unvalidated'
        shortcuts.ts              # stub: same
      verify/
        delta.ts                  # DeltaSpec + assertion combinators
        poller.ts                 # polling loop, backoff, timeout classification
    audit/
      schema.ts                   # AuditRecord v1 (versioned)
      log.ts                      # JSONL append, monthly files, redaction
    cli/
      main.ts                     # commander program assembly (bin target)
      output.ts                   # human vs --json envelope rendering (stdout=data, stderr=logs)
      exit-codes.ts               # stable exit-code table
      commands/
        doctor.ts  today.ts  inbox.ts  anytime.ts  upcoming.ts  someday.ts
        logbook.ts  trash.ts  projects.ts  project.ts  areas.ts  tags.ts
        todo.ts     capabilities.ts  snapshot.ts  config.ts  search.ts
  test/
    fixtures/
      schema-v26.sql              # DDL snapshot of real Things schema (sanitized)
      seed.ts                     # typed row builders (makeTodo, makeProject, ...)
    unit/                         # mappers, dates, comparators, fingerprint, url compile, guards
    engine/                       # verification poller vs simulated-latency fixture DB
    cli/                          # commander programmatic runs, --json golden output
    live/                         # @live-tagged, THINGS_LIVE=1 gated (VM workstream runs these)
```

`package.json` shape:

```json
{
  "name": "things-api",
  "type": "module",
  "engines": { "node": ">=24" },
  "bin": { "things": "./dist/cli/main.js" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "dependencies": { "commander": "^14" },
  "devDependencies": { "typescript": "~5.x", "vitest": "^4", "@types/node": "^24", "oxlint": "^1", "oxfmt": "^0.57" }
}
```

One runtime dependency total (commander). Bin name `things` — reads naturally in agent transcripts (`things today --json`); verified no collision (no PATH binary, no brew formula, npm's `things` package ships no bin).

## 2. Core TypeScript API shape

### Entities (`model/entities.ts`) — enums verified against live DB

```ts
export type TaskStatus   = 'open' | 'canceled' | 'completed';   // status 0 | 2 | 3
export type StartState   = 'inbox' | 'active' | 'someday';      // start 0 | 1 | 2
export type TodaySection = 'today' | 'evening';                 // startBucket 0 | 1
export type TaskType     = 'to-do' | 'project' | 'heading';     // type 0 | 1 | 2

export interface Todo {
  uuid: string; type: 'to-do';
  title: string; notes: string;
  status: TaskStatus; trashed: boolean;
  start: StartState;
  startDate: string | null;          // ISO yyyy-mm-dd, decoded from packed int
  todaySection: TodaySection | null; // only meaningful when scheduled today
  deadline: string | null;
  area: Ref | null; project: Ref | null; heading: Ref | null;  // Ref = { uuid, title }
  tags: Ref[];                       // DIRECT tags only — mirrors DB truth
  inheritedTags?: Ref[];             // opt-in computed ancestry tags (area/project)
  repeating: { isTemplate: boolean; isInstance: boolean; templateUuid: string | null };
  checklist?: ChecklistItem[];       // opt-in include
  index: number; todayIndex: number; // sparse rank keys; expose raw, never renumber
  created: Date; modified: Date; stopped: Date | null;
}
// Project = Todo-like + counts; Area, Tag (parent hierarchy), Heading, ChecklistItem similar.
```

Design rules baked in: direct vs inherited tags are separate fields (T18); repeating flags are first-class (T12/T16 hazards key off them); order keys are exposed raw as sparse ranks (validated sparse-key behavior); `todaySection` decodes `startBucket` (the thing things.py cannot do).

### Read API (`ThingsClient.read`)

```ts
read.today(): { today: Todo[]; evening: Todo[] }          // each sorted by todayIndex (validated comparator)
read.inbox(): Todo[]                                       // start='inbox', sorted by index
read.anytime() / read.someday() / read.upcoming({ days? })
read.logbook({ limit?, since? }) / read.trash()
read.projects({ area? }): Project[]
read.projectView(uuid): ProjectView                        // THE composite view:
// { project, active: Todo[], headings: { heading, items }[],
//   later: { scheduled: { date, items }[], repeating: Todo[], someday: Todo[] },
//   logged: Todo[], trashed: Todo[] }
read.areas({ includeItems? }) / read.tags()
read.byUuid(uuid): Todo | Project | Heading | null         // includes repeating templates (raw SQL, unlike things.py)
read.search(query, { in? })
read.snapshot(): Snapshot                                  // full normalized dump for diffing/backup
```

`projectView` deliberately mirrors validated UI composition (T17 / "later items" findings) instead of a flat `include_items` feed, and dedupes heading children (the things.py double-listing trap). Flat child feeds use a `tasks WHERE project=? OR heading IN (project's headings)` query.

### Mutation API — command → vector → verification

```ts
// Public surface
write.addTodo(params, opts?): Promise<MutationResult<Todo>>
write.updateTodo(uuid, patch, opts?)
write.completeTodo(uuid, opts?) / cancelTodo / reopenTodo
write.moveTodo(uuid, dest: { project?, area?, heading?, list? }, opts?)
write.setTags(uuid, tags: string[], opts?)      // full replacement (validated semantics)
write.addTags(uuid, tags: string[], opts?)
write.replaceChecklist(uuid, items, { acknowledgeChecklistReset: true }, opts?)  // typed ack required
write.addProject(params, opts?) / updateProject(uuid, patch, opts?)
write.completeProject(uuid, { children: 'require-resolved' | 'auto-complete' }, opts?)  // no default

interface WriteOptions {
  maxDisruption?: DisruptionTier;   // caps vector selection; default from profile
  vector?: VectorId;                // force a specific backend
  verifyTimeoutMs?: number;
  dryRun?: boolean;                 // returns plan (compiled invocation token-redacted, tier, guards, expected delta)
  actor?: string;                   // audit attribution
}
```

Internal command abstraction (what makes vectors pluggable):

```ts
type DisruptionTier = 0 | 1 | 2 | 3;   // 0 none | 1 app launch | 2 focus steal | 3 UI nav/modal risk

interface CommandSpec<P> {
  op: OperationKind;                              // 'todo.add' | 'todo.update' | 'project.complete' | ...
  hazards: HazardId[];                            // evaluated against pre-read snapshot
  expectedDelta(pre: PreState | null, p: P): DeltaSpec;
  compile(p: P, target: VectorId, ctx: CompileCtx): CompiledInvocation; // e.g. things:/// URL
}

interface WriteVector {
  id: VectorId;                                   // 'url-scheme' | 'applescript' | 'shortcuts'
  matrix: Record<OperationKind, VectorSupport>;   // data, not code — lab workstream ships new matrices
  preflight(ctx): Promise<Preflight>;             // app running? token present? os handler ok?
  execute(inv: CompiledInvocation): Promise<void>;
}

interface VectorSupport {
  support: 'yes' | 'partial' | 'no';
  disruption: DisruptionTier;                     // worst-case observed
  disruptionWhenRunning?: DisruptionTier;         // e.g. url-scheme lower if app already running
  validation: 'validated' | 'assumed' | 'unvalidated';
  constraints?: ConstraintId[];                   // e.g. 'not-on-repeating', 'requires-auth-token'
  notes?: string;
}
```

The planner filters vectors by `support !== 'no'`, constraint predicates against the pre-read (e.g. `not-on-repeating` checks recurrence fields), `validation === 'validated'` (unless config `allowUnvalidatedCapabilities`), and `disruption <= maxDisruption`; then picks lowest tier, tie-broken by registry priority. URL-scheme matrix entries encode validated reality: baseline tier 2 (T01 observed focus change), with an `open -g` variant entry marked tier 1 / `validation: 'unvalidated'` for the lab to confirm. Nothing about AppleScript/Shortcuts is hardcoded — they register with all-`unvalidated` matrices.

### Result types (discriminated unions)

```ts
type MutationResult<T> =
  | { kind: 'ok';            uuid: string; observed: T; audit: AuditRecord }
  | { kind: 'verify-failed'; reason: 'timeout' | 'mismatch' | 'silent-noop';
      expected: DeltaSpec; observed: DeltaObservation | null; audit: AuditRecord }
  | { kind: 'blocked';       reason: 'hazard' | 'disruption-tier' | 'drift' | 'preflight';
      hazard?: HazardId; detail: string; remediation: string }
  | { kind: 'unsupported';   op: OperationKind; considered: Array<{ vector: VectorId; why: string }> };
```

Silent no-op is a first-class failure (`verify-failed/silent-noop`), per T03/T06. `blocked` results never touched the app; `verify-failed` results did, and the audit record says exactly what was observed.

### Hazard guards (data-driven, from validated findings)

| Id | Trigger (pre-read) | Policy |
|---|---|---|
| `H-REPEAT-SCHEDULE` | `when`/`deadline`/status/duplicate write on item with recurrence fields | Hard block, no override in v1 (T12 crash) |
| `H-PROJECT-COMPLETE-CHILDREN` | `project.complete` with open untrashed children | Require explicit `children` policy (T08) |
| `H-CHECKLIST-REPLACE` | checklist write over existing items with state | Require `acknowledgeChecklistReset` (T07) |
| `H-REOPEN-RESOLVED-PROJECT` | adding open child to completed/canceled/logged project | Require explicit ack (T19) |
| `H-UNKNOWN-TAG` | requested tag absent from `TMTag` (case-insensitive) | Fail fast pre-write (silently ignored otherwise, T03/T04) |
| `H-UNKNOWN-DESTINATION` | target area/project/heading not found by pre-read | Fail fast pre-write (silent no-op otherwise, T06) |
| `H-AMBIGUOUS-HEADING` | heading targeted by name with duplicate names in project | Fail fast; require unambiguous target |

## 3. CLI framework: commander

**commander v14.** Zero dependencies (keeps the whole package at one runtime dep); mature nested-subcommand support for noun-verb layout; conventional, complete `--help` output that agents parse reliably; `exitOverride()` + programmatic parsing make CLI tests trivial; TypeScript types bundled. Rejected: oclif (framework + plugin machinery + many transitive deps), clipanion (class-per-command API, less conventional help text), citty (younger, weaker long-term guarantees).

Command surface (nouns then verbs, reads are top-level for ergonomics):

```
things doctor [--json]                    # env/db/fingerprint/app/token/audit health + remediation
things today | inbox | anytime | upcoming | someday | logbook | trash [--json]
things projects [--area <x>] [--json]
things project show <uuid> [--json]       # composite view
things areas | tags [--json]
things search <query> [--json]
things snapshot [--json]
things capabilities [--op <op>] [--json]  # dumps vector support matrix — agents discover what's possible
things todo add|update|complete|cancel|reopen|move|tags|checklist ...
things project add|update|complete ...
things config show|set ...
```

Agent-discoverability rules:
- Global `--json`: stable versioned envelope `{ apiVersion: 1, ok, kind, data|error, meta: { dbVersion, fingerprint: 'ok'|'drift'|'unknown', elapsedMs } }` on stdout; all human/log chatter to stderr.
- Every write command's `--help` states: disruption tier, vector used by default, hazards that may block it, and the exact ack flag names. Top-level help ends with an "AGENT NOTES" epilog (help text is the API contract for agents; treat it as tested output).
- No interactive prompts ever. High-risk confirmation is expressed as explicit flags (`--children auto-complete`, `--acknowledge-checklist-reset`), so non-TTY agents are first-class.
- Stable exit codes: 0 ok; 1 unexpected; 2 usage; 3 verify-failed; 4 blocked (hazard/tier); 5 drift-blocked; 6 unsupported; 7 environment (db/app missing).
- `--allow-disruptive` raises `maxDisruption` to 2, `--allow-very-disruptive` to 3; defaults come from the config profile.

Config profiles (`~/.config/things-api/config.json`, `THINGS_API_*` env overrides): `workstation` (default): `maxDisruption: 1` — background app launch acceptable, focus steal requires the flag; `dedicated-server`: `maxDisruption: 2` default. Profile also sets default verify timeouts and audit actor.

## 4. Verification engine

**Expected delta.** Each `CommandSpec` produces a `DeltaSpec` from (pre-state, params):

```ts
type DeltaSpec =
  | { mode: 'update'; uuid: string; assert: FieldAssertion[] }        // updates: post-state field predicates
  | { mode: 'create'; probe: CreateProbe }                            // creates: find-the-new-row predicate
  | { mode: 'state';  uuid: string; assert: FieldAssertion[]; cascade?: FieldAssertion[][] }; // complete/cancel + child effects
```

- Updates assert against a fresh by-UUID read; assertions compare decoded entity fields, not raw rows, so one codebase serves all vectors.
- Creates can't know the UUID up front via URL scheme (IDs only via x-callback, which a CLI can't receive). `CreateProbe` = `creationDate >= t0 - 2s` AND title equality AND expected container/list, newest first; on match, capture the discovered UUID into the result and audit record. AppleScript `make` returns IDs directly — prefer once validated.
- `state` mode covers completion cascades: `project.complete` with `children: 'auto-complete'` asserts the project status AND that previously-open children became completed while canceled children stayed canceled (T08 semantics), making the hazard's outcome verified, not assumed.

**Polling strategy.** After `execute()`: immediate check at t+0, then every 100ms for 2s, then every 300ms until deadline. Each poll is a discrete auto-commit read (fresh WAL snapshot). Classification: all assertions pass → `ok`; deadline with zero observed field movement (including `userModificationDate` unchanged) → `silent-noop`; deadline with partial/other movement → `timeout` with the observed diff; a stable contradictory post-state (e.g. moved to the wrong list) reports at deadline as `mismatch`. `userModificationDate` doubles as a cheap "did anything happen" tripwire.

**Timeout defaults.** Preflight checks whether Things is running (`pgrep -x Things3` — tier 0): running → 6s total; not running (vector must launch it) → 25s. Both overridable per call and per profile.

**Concurrency:** an advisory lockfile serializes mutations across concurrent CLI invocations (protects create-probe verification from ambiguity).

## 5. Audit log

**Location.** XDG-style state dir: `~/.local/state/things-api/audit/YYYY-MM.jsonl` (respect `XDG_STATE_HOME`; `THINGS_API_STATE_DIR` override). Config lives separately in `~/.config/things-api/`.

**Rotation.** Monthly files by name; never auto-delete (an audit trail you prune automatically is not an audit trail; volume is trivial). `doctor` warns when the directory exceeds 50 MB.

**Record schema (v1, one JSON object per line).**

```jsonc
{
  "v": 1,
  "ts": "2026-07-02T14:31:22.114Z",
  "actor": "claude-code",                  // from opts/config/env, default "$USER@cli"
  "host": "mikes-mbp.local",
  "op": "todo.update",
  "uuid": "THTv7PTB...",                   // null until discovered for creates
  "vector": "url-scheme",
  "disruption": 1,
  "invocation": "things:///update?id=...&title=...&auth-token=REDACTED",
  "requested": { "title": "New title" },   // normalized requested delta
  "pre": { "title": "Old", "status": "open", "modified": "..." },  // asserted-field subset only
  "observed": { "title": "New title" },    // post-verify subset (or best-effort on failure)
  "result": "ok",                          // ok | verify-failed:{timeout|mismatch|silent-noop} | blocked:<reason> | unsupported
  "verify": { "attempts": 3, "elapsedMs": 412 },
  "durationMs": 745,
  "rollbackHint": "things:///update?id=...&title=Old%20title&auth-token=<token>",  // token placeholder, never the secret
  "env": { "pkg": "0.3.0", "dbVersion": 26, "thingsApp": "3.22.x", "fingerprint": "ok" }
}
```

Redaction is structural: the writer refuses to serialize any string matching the loaded auth token. `blocked` results are logged too (decisions worth auditing), with `invocation: null`.

**Undo selection (actor-scoping).** `things undo` replays inverse mutations off this trail. Three selection layers sit on top of the reversibility machinery: (1) **`--by <actor>`** (MCP `by`) filters targets to an exact recorded actor (or `*` for all) — `--by mcp` never matches an `undo:mcp` record, since inverse mutations are their own actor and are never themselves undo targets; (2) **asymmetric defaults** — the MCP undo tool defaults to `by: "mcp"` (an agent must pass `by: "*"` to touch the human owner's edits), while the CLI stays GLOBAL (the owner's Cmd+Z), with `--by mcp` available to clean up after an agent; (3) **undo tokens** — every mutation result carries an `undoToken` (a compound op's shared txn id, or, for a single op, a content-addressed id derived from the record's `ts+op+actor+host+uuid`; see `undoToken` in `audit/schema.ts`), and `things undo --txn <token>` (MCP `txn`) inverts exactly that record, immune to interleaving. `--txn` is mutually exclusive with `--last`/`--by`. Inverse mutations carry an additive `undoOf: <token>` back-reference so an already-undone `--txn` request fails loudly rather than re-running.

## 6. Schema fingerprint and drift detection

**What gets hashed.** Not raw `CREATE TABLE` SQL (comments/whitespace churn). Instead, a canonical JSON structure derived from `PRAGMA table_info` for exactly the tables we depend on (`TMTask`, `TMArea`, `TMTag`, `TMTaskTag`, `TMAreaTag`, `TMChecklistItem`, `TMSettings`, `Meta`): per table, the ordered list of `(name, declaredType, notnull, pk)` restricted to columns declared in `db/schema.ts`, plus a `presentExtraColumns` list (additions are recorded but only warn). SHA-256 over that canonical JSON = the fingerprint. Enum domains (`type ⊆ {0,1,2}`, `status ⊆ {0,2,3}`, `start ⊆ {0,1,2}`, `startBucket ⊆ {0,1}`) are NOT hashed (data-dependent); they are runtime probes — `SELECT DISTINCT` checks that flag out-of-domain values as drift warnings.

**Baselines.** Typed TS consts shipped in the package (`src/db/baselines/db-v26.ts`), keyed by `Meta.databaseVersion`. Each baseline: `{ databaseVersion, fingerprint, tables, enumDomains, knownThingsAppVersions }`. Things.app version read from `/Applications/Things3.app/Contents/Info.plist` (informational mapping — the DB version is the contract).

**Startup policy.** Compute fingerprint on first connection, cache per process. Exact baseline match → normal. Known `databaseVersion`, hash mismatch → drift: block all writes (`blocked/drift`), reads proceed with a stderr warning (reads also fail loudly by construction: every query names explicit columns, so removed columns throw immediately). Unknown (newer) `databaseVersion` → same as drift + "update things-api" remediation. `doctor` prints the full comparison; `things doctor dump-schema --json` emits the observed structure.

**Upgrade workflow.** Things updates → `things doctor` shows drift + dump instructions → validate against the new version (lab harness) and ship a new baseline in a package release. Escape hatch: `things config set accepted-fingerprint <hash>` writes a user-local acceptance into the state dir; re-enables writes with a persistent loud warning, recorded in every audit record (`fingerprint: 'user-accepted'`). No silent auto-acceptance, ever.

## 7. Testing strategy

**Runner: vitest.**

- **Fixtures: generated, not binary.** Check in `test/fixtures/schema-v26.sql` (sanitized DDL snapshot of the real DB) plus typed seed builders (`makeTodo(...)` inserting rows with correct packed dates/epochs). Each test builds a temp SQLite file (WAL mode for realism) via `node:sqlite` itself. Diffable, composable, no opaque binaries in git. The DDL snapshot also regenerates fingerprint baselines.
- **Unit targets:** date codecs, mappers, view comparators (`(startBucket, todayIndex)` ordering reproduced from validation-notes examples), inherited-tag resolution, fingerprint compute/compare (mutated-DDL cases), URL compilation goldens (percent-encoding, token redaction), guard evaluation against seeded pre-states.
- **Verification engine tests:** a `FakeVector` implementing `WriteVector` whose `execute` schedules direct writes into the fixture DB after a configurable delay (fine — the no-direct-writes rule protects the real Things DB, not our fixtures). Exercises ok/timeout/mismatch/silent-noop classification and polling cadence deterministically (inject a fake clock).
- **CLI tests:** build the commander program in-process with `exitOverride()`, run against a fixture DB via `THINGS_DB`, snapshot the `--json` envelopes and `--help` text (help output is agent API — regression-test it).
- **Live/VM seam:** (1) `openThings({ dbPath })` and env override; (2) the vector registry accepts injected vectors and matrices; (3) all timing behind an injectable clock/sleeper; (4) live tests tagged and gated by `THINGS_LIVE=1`, operating only on `LAB-`/`[AI-GTD-TEST]`-prefixed records, and every live assertion routes through the same public read API. The lab workstream runs the identical suite plus probe suites that emit updated `*.matrix.ts` data files — no code redesign.

## 8. Phased build order (read-only first, per prior research)

**P0 — Scaffold.** Repo, tsconfig (erasable syntax), oxlint/oxfmt, vitest, CI (typecheck+lint+test), package.json exports/bin, exit-code and JSON-envelope contracts written down.

**P1 — Read-only core.** `db/locate` + `connection`; `db/schema.ts` dependency manifest; fingerprint + `db-v26` baseline; date codecs + mappers; views: `today` (Today vs Evening via `startBucket`, ordered by `todayIndex`), `inbox`, `anytime`, `upcoming`, `someday`, `logbook`, `trash`; composite `projectView`; tags incl. inherited resolution; CLI: `doctor`, all read commands, `snapshot`, `--json` everywhere. Acceptance: faithful Today digest incl. Evening section, UUIDs in all output, zero writes, every raw column dependency documented in `schema.ts`.

**P2 — Write core (low-risk ops).** Auth token discovery; operations catalog + command specs; url-scheme vector + validated matrix; pipeline (pre-read → guards → execute → verify → audit); audit writer. Ops: `todo.add`, `todo.update` (title/notes/append), `todo.move`, `todo.setTags/addTags`, `todo.complete/cancel/reopen`, `project.add`, `project.update`. All guarded, all with `--dry-run`.

**P3 — Guarded high-risk ops + agent polish.** `project.complete` with child policy + cascade verification; `replaceChecklist` with ack; reopen-resolved-project ack path; `capabilities` command; disruption profiles + `--allow-disruptive`; help-text audit pass; README with agent usage recipes.

**P4 — Vector expansion (feeds from lab workstream).** AppleScript/Shortcuts matrices land as data; `open -g` tier-1 probe result folded in; Today/Evening synthetic reorder behind `experimental` config; MCP adapter as a separate thin package consuming the library; baseline additions for new Things versions.

## References

- Node.js SQLite docs (Stability 1.2 — Release candidate): https://nodejs.org/api/sqlite.html
- Node.js 24.15.0 LTS release (sqlite marked RC): https://nodejs.org/en/blog/release/v24.15.0
- node:sqlite stabilization tracking: https://github.com/nodejs/node/issues/57445
