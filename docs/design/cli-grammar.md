# CLI grammar — one router, one precedence chain

How `things <argv>` becomes a dispatched command. This is the single specification for the read-side routing sugar that accreted across PRs #89/#93/#94 as three independent special cases; it is now one resolver (`src/cli/resolve-invocation.ts`) that normalizes every sugar form into one canonical grammar.

For the sibling concern — how a resolved view then STYLES its rows on a terminal (the glyph/color/weight/dim vocabulary) — see [render-language.md](render-language.md).

## What this replaced (the patchwork)

Before consolidation the routing lived in three unrelated places:

1. **`expandShorthand` in `main.ts`** — argv preprocessing that turned a bare first argument (not a registered command) into `show <ref>`, and separately rewrote `show <view-keyword>` into the view command. It injected a hidden `--via-shorthand` marker so the `show` action could later tell a bare-noun invocation from an explicit one.
2. **A hidden `--via-shorthand` option on `show`** — declared only to carry that marker, and read in the `show` action solely to pick the error message (`no command or item named "X"` for bare nouns vs. the plain resolution error for `things show X`).
3. **Per-command keyword rewrites** — `show` consulted `VIEW_KEYWORDS` in `main.ts` (rewrite to the view command); `open` consulted the *same* `VIEW_KEYWORDS` set in its own action (launch `things:///show?id=<kw>` directly). Two commands, two code paths, one shared set doing two different jobs — and the set was the seven URL-scheme ids, so `things show projects` was never a keyword at all (it fell through to name resolution).

It worked and was tested, but it was three special cases pretending to be a grammar. The behavior below is the same behavior, expressed once.

## Canonical grammar

There is **one canonical order**, and every sugar form normalizes into it:

| Form | Shape | Example | Canonical target |
|---|---|---|---|
| **List view** | `things <view>` | `things anytime` | the view command itself |
| **Typed command** | `things <type> <verb> <subject> [flags]` | `things area show Hobbies` | itself (already canonical) |
| **Namespace implied-show** (sugar) | `things <type> <subject>` | `things area Hobbies` | `things <type> show <subject>` |
| **Loose verb** (sugar) | `things <verb> <subject>` | `things show Hobbies` | `things <type> <verb> <subject>` |
| **Bare noun** (sugar) | `things <subject>` | `things Hobbies` | `things <type> show <subject>` |

`<type>` ∈ {`area`, `project`, `todo`}; `<verb>` ∈ {`show`, `open`}. The loose and bare forms are conveniences: they let a user paste any reference — a name, a uuid prefix, a `things:///show?id=…` share link — without first classifying it. The resolver + reference resolution together decide the `<type>`.

### Namespace implied-show (`things <type> <subject>`)

Inside a TYPE namespace whose `show` verb takes a reference — `area`, `project`, `todo` — the verb may be omitted: `things area hobbies` → `things area show hobbies`. The rule fires only when the token after the group name is **not** a registered subcommand of that group (registered verbs always win — the reserved-word rule), and is not a flag. `config` is deliberately excluded: it has a `show` subcommand but it takes no reference.

Because the `<type>` is fixed by the namespace, the type CONSTRAINS resolution: `things area <project-uuid>` produces a loud type-mismatch (`area not found: …`, exit 2) rather than silently falling back to a project — exactly like the typed `things area show <project-uuid>`. The canonical `things <type> show <subject>` rides the normalized-echo and `meta.resolvedCommand` like every other sugar.

### Plural collection views accept a ref (`things areas <ref>` / `things projects <ref>`)

The plural collection commands `areas` and `projects` are *list* views, but each also accepts an optional trailing reference: `things areas Hobbies` shows that one area and `things projects "Astro City"` shows that one project — byte-identical (in the rendered body) to `things area show <ref>` / `things project show <ref>`, delegating to the same action (a true synonym, not a reimplementation). The bare `things areas` / `things projects` still list. Like the sugar forms above it emits the normalized-echo (`≡ things project show <ref>`) and `meta.resolvedCommand`: the singular `area show` / `project show` is the canonical spelling, so the plural announces the normalization to it. This one is set in the resolver (a dedicated `projects`/`areas` branch), not filled in by the action, because the canonical is knowable from the argv alone — the plural + ref maps straight to the singular show, no database resolution needed. An explicit `show` verb is forgiven too (`things projects show <ref>` → `things project show <ref>`), dropped in the resolver so the plural command still sees a single ref positional. The show-only flags (`--show-later`, `--show-logged`, `--area-limit`, `--project-limit`) are accepted on the plural form and apply only when a ref is present. `tags` has no singular show view, so it stays list-only (a stray argument is an excess-argument usage error).

## Precedence chain (single, documented)

Every invocation is classified by walking this chain in order; the first rule that matches wins:

1. **Registered command / alias** — if the first token names a command or alias, it dispatches to that command. Command names are RESERVED and always win, so `things inbox`, `things areas`, `things today` are the commands, never a lookup of an item so named. (Escape hatch: reach a shadowed item by uuid, or via the typed command — `things area show Anytime`.) Inside a `area`/`project`/`todo` namespace, a non-subcommand next token triggers the **namespace implied-show** rewrite (above) — the group's registered subcommands still win here too.
2. **View keyword** — inside `show`/`open` only, a first argument that is a view keyword (tables below) routes by keyword rather than by reference. A keyword beats a same-named project or area (mirrors the URL scheme).
3. **Reference resolution** — anything else is a reference. The tiers differ by path:
   - **Typed / namespaced paths** (`things area show <ref>`, `things area <ref>`) keep the full [reference-resolution.md](reference-resolution.md) tiers: **uuid (full) → uuid prefix (≥6 base-62 chars) → tiered name match (exact → case-insensitive → normalized → uuid-prefix)**, scoped to the named type.
   - **Loose / bare-noun sugar** (`things show <ref>`, `things <ref>`) resolves through `classifyShowTarget` and is deliberately NARROWER: a task uuid / ≥6-char prefix / `things:///show?id=…` share link resolves first; then a NAME resolves against AREAS and PROJECTS only, tiers **exact → case-insensitive → normalized** — **no uuid-prefix tier** (the did-you-mean substring fallback supersedes prefix guessing). On a name tie, **area beats project**. A heading reference resolves to its containing project. Tags and checklist items have no show view and are rejected.

Two consequences of the narrower sugar path (Mike-approved rulings):

- **To-do TITLES never route.** `things "Read Thread on Astro City Restoration"` never opens a to-do card even on an exact title match — to-dos are reachable only by uuid/prefix/share-link, or picked from the did-you-mean list (where they appear WITH their uuids). Only area/project names route.
- **Dash + case forgiveness, quote-free.** The normalized tier folds case, whitespace, and dashes, so `things restore-astro-city-cabinet` resolves to the project "Restore Astro City Cabinet" with no shell quoting — a deliberate ergonomic, not an accident.

Steps 1–2 run in the resolver (`resolveInvocation`, pre-commander, argv-level). Step 3 runs at action time in `classifyShowTarget` (it needs the database). The resolver never touches the database.

**Leading global flags.** Classification skips over leading global read flags to find the token it classifies, so `things --json Hobbies` routes exactly like `things Hobbies --json` (this fixes a bug the old `expandShorthand` had: any flag-led argv silently skipped routing). Only the global read options are recognized — `--json` (boolean) and `--db <path>` / `--db=<path>` (value-taking; the value is skipped too, never misread as the subject). An **unknown** leading flag keeps the plain fall-through to commander (which reports it) rather than guessing whether the next token is that flag's value or the subject; a flags-only argv (`things --json` alone) likewise stays commander's to error on; and a registered command reached through leading flags is left untouched (program-level flags before a command were an error before and stay one).

## Keyword vocabularies (deliberately asymmetric)

The two verbs accept different keyword sets, on purpose: `show` renders our own views, so it accepts every list-view command name; `open` hands an id to the app's URL scheme, so it accepts only ids the app itself understands.

### `show` keywords → dispatch to the identical list command

`things show <kw>` IS `things <kw>` (same flags, same output). The vocabulary is **every list-view command name**:

| Keyword | Dispatches to |
|---|---|
| `inbox` `today` `anytime` `upcoming` `someday` `logbook` `trash` | the seven singular view ids (the app's `show?id=` vocabulary) |
| `projects` `areas` `tags` | the plural collection commands |
| `evening` | a **section sugar** — expands to `things today --evening` (the This Evening slice of Today) |

Eleven keywords. Ten are real commands (`things show projects` → `things projects`); `evening` is the lone **section sugar** — it is not its own command but expands to a command plus a flag (`things today --evening`). The section sugars are the one case where a keyword that is NOT a registered command still routes at the **bare** level too, so `things evening` and `things show evening` both run `things today --evening`.

### `open` keywords → launch `things:///show?id=<kw>` directly

`open`'s vocabulary belongs to the app. It accepts **only the seven verified URL-scheme ids**:

`inbox` `today` `anytime` `upcoming` `someday` `logbook` `trash`

The plurals are deliberately **not** openable — the app has no such list screen. `things open projects` (or `areas`/`tags`) errors with copy naming the fix:

```
the app has no projects list to open — open a specific project: `things open <ref>`
```

`evening` is not openable either — it is not a valid `things:///show?id=` id (the app has no This Evening screen). `things open evening` errors with copy pointing at the CLI section filter:

```
the app has no This Evening screen to open — use `things today --evening`
```

A non-keyword `open` reference (`things open Hobbies`, `things open <uuid>`) resolves like `show` and foregrounds that resource in the GUI.

## Normalized-form echo

When — and only when — an invocation arrives via a sugar form, the TTY renderer emits one dim line showing the canonical runnable command it normalized to, adjacent to the view/entity header:

```
≡ things area show "Website redesign"
```

The subject is rendered with the same shell-safe quoting as the truncation footers (`shellQuote`): a plain word is left bare (`≡ things area show Hobbies`), a name with spaces or shell metacharacters is quoted. It fires for the routing sugars:

- **bare noun** — `things Hobbies` → `≡ things area show Hobbies`
- **namespace implied-show** — `things area Hobbies` → `≡ things area show Hobbies`
- **plural collection synonym** — `things areas Hobbies` / `things areas show Hobbies` → `≡ things area show Hobbies`
- **keyword-in-show** — `things show anytime` → `≡ things anytime`
- **section sugar** — `things evening` / `things show evening` → `≡ things today --evening`
- **uuid routing** — `things <uuid>` / `things show <uuid>` → `≡ things todo show <uuid>`
- **share-link** — `things things:///show?id=<uuid>` → `≡ things todo show <uuid>`

It does **not** fire for canonical invocations (`things inbox`, `things area show Hobbies` — nothing was normalized), nor for a loose `show` given a plain **name** (`things show Hobbies` — the verb was already typed and the name is already visible; only bare-noun promotes a name). The echo is strictly an interactive affordance: **never on non-TTY output** (so `things Hobbies | grep` stays clean) and **never in `--json`**.

## `meta.resolvedCommand` (`--json`, additive)

The same canonical string rides the `--json` envelope of a routed read as `meta.resolvedCommand` — present exactly when the echo would have fired, absent otherwise. It is additive (no `apiVersion` bump). Example: `things show anytime --json` carries `meta.resolvedCommand: "things anytime"`.

**MCP does not carry it.** The MCP read tools do not route through this path — `read_view` takes a `view` enum and `get_item`/`get_project` take a uuid directly, so there is no loose reference to normalize and nothing to echo.

## Universal flags

Three flags are accepted by **every list and detail view**, so an agent can append them without checking per-command support:

- **`--json`** — the versioned envelope on stdout (logs/errors on stderr).
- **`--db <path>`** — an explicit database path.
- **`--all`** — lift the view's own default restrictions.

### `--all` doctrine (Mike-approved)

`--all` removes every default RESTRICTION on the view's **own content** — row/block caps, date bounds, later-hidden sections — but NEVER pulls in a different content CLASS. Logged and trashed items stay behind their own explicit flags (`--show-logged`, `--trashed`), because they are separate classes, not a restricted slice of the current view.

| View | What `--all` lifts |
|---|---|
| `today` `inbox` `upcoming` `logbook` `trash` `changes` | the row cap (`--limit`) |
| `anytime` `someday` `area show` | every per-block cap (`--area-limit` / `--project-limit`) |
| `upcoming` | the date bound too (full horizon) |
| `projects` | the hidden later block — exactly `--show-later` |
| `project show` | the hidden later rows — exactly `--show-later` (logged still needs `--show-logged`) |
| `areas` `tags` `todo show` | nothing — no default restriction exists; `--all` is an accepted no-op for uniformity |

**Legacy outlier — `search --all`.** `search` keeps its historical meaning: `--all` is the include-EVERYTHING scope (open + logged + trashed, unbounded). That is broader than the charter (it does cross content classes), preserved for backward compatibility and documented as the one exception.

The `--plain` / `--pretty` output pair joins this universal set when roadmap §H lands.

A help-contract test enforces the charter mechanically: every registered list/detail command's `--help` must offer `--json`, `--db`, and `--all`.

### Bounds & defaults doctrine (Mike-approved)

The optional flags on a read view fall into four classes:

- **Volume caps** — `--limit`, `--area-limit`, `--project-limit`. How many rows/blocks to show.
- **Range bounds** — `--since`, `--until`. The time window the view covers.
- **Content scopes** — `--tag`, `--untagged` (its inversion — the GUI's "No Tag", mutually exclusive with `--tag`/`--exact-tag`), `--overdue` (open items past their deadline — see below), `--area`, `--project`, `--type`, the search query, a bare subject. *Which* items qualify.
- **Visibility toggles** — `--show-later`, `--logged`, `--trashed`, `--evening`. Whether an otherwise-hidden class is folded in.

`--all` is its own thing: it removes restrictions (see the `--all` doctrine above) and conflicts with an explicit cap/bound exactly as before.

**The lift rule.** Defaults for volume caps and range bounds exist ONLY for the bare invocation. Passing ANY explicit optional flag from those two classes disables the remaining DEFAULTS of both classes. Explicit values are always honored and compose as an intersection. Content scopes and visibility toggles never lift a default.

Worked examples on `upcoming` (default window `--until 1m`, default cap `--limit 50`):

- `things upcoming` → both defaults apply: the next month, first 50 rows.
- `things upcoming --limit 100` → the window default drops; "the next 100 scheduled items" over an unbounded horizon.
- `things upcoming --until 2m` → the row-cap default drops; every item through two months out.
- `things upcoming --until 2m --limit 100` → both stated, both honored (intersection).
- `things upcoming --tag work` → a content scope, so both defaults still apply (next month, 50 rows, tagged `work`).

`logbook` follows the same rule for its `--since`/`--until` bounds against the `--limit 50` default.

**Range bounds key each view's own natural timeline.** `--since`/`--until` do not name one universal clock — they filter whatever timeline the view is *about*: `logbook` = the logged (stop) date, `upcoming` = the scheduled-appearance date, `changes` = the modification date. `inbox`'s natural timeline is ARRIVAL, proxied by the item's **creation date** (`inbox --since 2w` = captures created in the last two weeks). Two caveats are recorded and accepted: a re-inboxed item (demoted back from a project/area) keeps its ORIGINAL creation date, so this is arrival-into-Things, not strictly arrival-into-the-Inbox; and "untouched since" — modification-keyed stale-backlog filtering — was considered and deliberately NOT overloaded onto `inbox --since` (that is `things changes --since` territory, or a future explicitly-named flag). Because `inbox`'s presentation order stays the manual `ORDER BY index`, the creation bound is an invisible axis in the rows, so a bound-active human run appends a dim footer note naming the effective window (`(created since Jun 29)`) — never in `--json`.

**Required-flag exception.** A REQUIRED bound carries no lift signal, because the user had no choice about stating it. `things changes` requires `--since`, so its presence does NOT lift the default `--limit 50`; `changes` behavior is unchanged.

Rationale: defaults exist to keep the bare invocation small; once the user states any explicit bound they have taken over output sizing, so a stale second default must not silently re-clamp the result.

### The `--overdue` content scope (Mike-approved)

`--overdue` restricts a view to OPEN items whose `deadline` is strictly BEFORE today. It is a **content scope**, so it obeys the doctrine above: it never lifts a `--limit`/`--since`/`--until` default and composes as an intersection (`AND`) with `--tag`/`--untagged` and every other scope.

**Due-today is NOT overdue** (`deadline < today`, not `<=`). This mirrors the app's own Today sidebar badge, which splits the red count into "due" (a deadline EQUAL to today) and "overdue" (an EARLIER deadline) — `--overdue` names only the latter. The boundary is the same injected clock every dated view uses (`localToday(now)` → packed date); it is never a hardcoded date. The scope also re-asserts open-ness (`status = 0`): on `today`/`anytime` (whose membership is `OPEN_OR_UNSWEPT`) a checked-but-unswept row that happens to sit past a deadline is dropped — overdue is *remaining* work.

**Where it applies.** `--overdue` is offered on the current-work views where `--tag` applies and the scope is coherent: `today`, `inbox`, `anytime`, `someday`, and `search`. On `search` it lists open items, so it is refused together with the status-widening `--logged`/`--trashed`/`--all` (the same fail-closed style as `--untagged` with `--tag`).

**Where it is deliberately excluded (per view):**
- `upcoming` — a forward-looking, future-time-bounded view: every cohort requires a future `startDate` or a future `deadline` (the deadline-forecast cohort is exactly `deadline > today`, the negation of overdue). A past deadline contradicts the view's own frame, so the flag is not offered; the rare future-scheduled-yet-past-deadline row is better surfaced by `anytime --overdue`.
- `logbook` / `trash` — closed / trashed items. "Open items past a deadline" is definitionally empty there, so the flag is not offered.
- `area show` / `project show` — the composite card views accept no content scopes today (no `--tag` either), so `--overdue` is out of scope for them.

The MCP `read_view` and `search` tools carry `overdue` with the identical guards (rejected on `upcoming`/`logbook`/`trash`, and against `logged`/`trashed`/`all` on search).

## Did-you-mean fallback (unresolved subjects)

When a show / bare-noun subject fails resolution at every tier (a not-found, distinct from an *ambiguous* reference — those still list their candidates verbatim), the CLI does not stop at the bare error. It runs a **lite title-search** and offers candidates:

- Case-insensitive SUBSTRING match on **titles only** — to-dos, projects, areas. Never notes, headings, or checklist items. Open + untrashed only.
- Ordered: containers (areas, then projects) first, then to-dos; within a group active before someday, then most-recently-modified. Capped at ~10 with a `… n more — \`things search '…'\`` tail.
- Human output (stderr): the exit-2 error line, the candidate rows (to-dos carry their dim `(container)` context), and always a closing `` or try: `things search '…'` `` suggestion. An empty lite-search still prints the error + suggestion.
- `--json`: the error envelope gains additive `error.details.candidates` (standard item shapes, capped the same) so an agent can self-correct in one round-trip. `error.code` is `not-found`; exit code 2.

**Type scoping.** When the failed subject came through a TYPE namespace — `things project "x"` (implied-show) or the explicit `things project show x` — the candidate list is scoped to THAT type. Untyped forms (`things "x"`, `things show x`) keep the mixed list.

## Search ranking (deterministic composite)

`things search` ranks matches by a pure composite comparator (`src/read/search-rank.ts`), replacing plain recency. First differing key wins:

1. **match field** — title > notes > heading-via-project > checklist
2. **type** — projects/areas above to-dos
3. **status** — active above someday; logged/trashed last (and only when a flag includes them)
4. **tiebreak** — most-recently-modified

Consequence (deliberate): a someday TITLE match outranks an active NOTES match — field trumps status. Ranking runs BEFORE the row cap, so `--limit`/pagination semantics are unchanged.

**Heading doctrine.** A HEADING-title match surfaces the **parent PROJECT** row (never a bare heading row), annotated `via heading "…"` in human output and carrying additive `matchedVia: { kind: "heading", title }` in `--json`. Heading text is treated exactly as if it lived in the parent project's notes, ranked just below a real notes match. A project matched by its own title/notes never carries the redundant annotation. (Checklist-item text is NOT searched today; the checklist field rank is reserved.)

## Write ergonomics (targets & bare verbs)

Writes stay the rigid `things <type> <verb> <target> --flags` form (see Non-goals). Two ergonomics meet the reader halfway without loosening that grammar.

### Project write targets accept names

`things project <verb> <ref>` — `update`, `move`, `complete`, `cancel`, `reopen`, `restore`, `duplicate`, `delete`, `tags`, and the repeat verbs — resolves `<ref>` the SAME tiered, case- and dash-forgiving way the read side does (the shared `resolveNamedRef` core behind `resolveProjectUuid`, reused not forked). A uuid / unique uuid-prefix resolves FIRST over every task, so a wrong-TYPE id — a to-do uuid handed to a project verb — still reaches the op's own guard, which reports it with a targeted "that is a to-do, not a project" message rather than a misleading not-found. Otherwise the ref resolves as a unique project NAME (trashed included, so `project restore <name>` works).

Project titles CAN be duplicated, so an ambiguous NAME is REFUSED fail-closed — the error lists the candidates with short uuids and area context so the caller disambiguates by uuid, never a silent guess:

```
"Website redesign" matches 2 projects — disambiguate with a uuid or partial-uuid:
  7Ck4hA2b — Website redesign (in Work)
  Qp91mF3d — Website redesign
```

Areas and tags already accept names (`things area update <ref>`, `things tag update <ref>`). **To-do and heading write targets STAY uuid-only** — routinely duplicated titles, and writes are identity-addressed — differing only in the entity noun their not-found copy names (`no to-do matching uuid or partial-uuid "…"`).

### Mutation verbs are reserved in bare-noun position

A bare `things <verb> …` whose first token is a write verb — every registered `todo`/`project`/`area`/`heading`/`tag` subcommand (`update`, `add`, `delete`, `complete`, `cancel`, `move`, `duplicate`, `restore`, `rename`, `archive`, `make-repeating`, …) plus the synonym `create` — no longer falls into the show-sugar (which emitted a confusing `things show` usage error). Instead it is answered with a namespaced-write suggestion:

- a following ref that uniquely resolves as an **area/project/to-do** → one CONCRETE suggestion echoing the remaining args, e.g. `did you mean: things area update health --tags test`. The mutation is **NEVER auto-run** — the suggestion is the deliberate keystroke;
- **`add`/`create`** with a title-like arg → `things todo add "<arg>"` first (the common intent), then the container namespaces;
- **no ref, an unresolvable ref, or an ambiguous ref** → a hint listing the namespaced forms (`things todo|project|area|tag|heading <verb> …`) and pointing at `things help writes`.

This makes those verbs **RESERVED WORDS** in bare-noun sugar position: an area literally named "update" can no longer be shown via bare `things update` (the full `things area show update` is unaffected) — a Mike-accepted trade-off, the write-side twin of the precedence-1 command reservation. Exit class is **Usage** (exit 2), consistent with the other resolver errors; under `--json` the suggestion(s) ride `error.details.suggestions` (additive, the did-you-mean `details` shape).

## Non-goals (with reasoning)

- **No sentence-like write grammar.** Writes stay one rigid `things <type> <verb> … --flags` form. A flexible, natural-language-ish parser in front of the mutation pipeline is a misparse risk exactly where the stakes are highest, and agents *prefer* one rigid, predictable form over a forgiving one. Sugar is a read-side convenience only.
- **No dual canonical orders / full type-verb transposition.** We will not also accept `things show area Hobbies`. One order keeps the name/verb collision surface small and the grammar teachable.
- **No stateful context (`things cd`).** No "current project" a subsequent command inherits. Statelessness is a safety feature: every write names its full target, so nothing depends on invisible session state that a script or agent could get wrong.

## Phase 2 (specified, NOT built) — resource-scoped closed-enum verbs

The honest home for heading ergonomics and other subordinate-resource actions is a gh-style, fixed-slot form:

```
things project <ref> add-heading <title>
things project <ref> add-todo <title>
```

Fixed slots: **position 2 = the resource ref**, **position 3 = a verb from a closed enum** (`add-heading`, `add-todo`, …), everything else via flags. The closed enum is the key discipline — it keeps this from drifting into the free-form write grammar ruled out above, and the fixed ref slot means no ambiguity about what the action targets.

This is where heading creation *belongs* ergonomically: headings are subordinate resources of a project, so `things project <ref> add-heading` reads correctly. The type-consistent `things heading create` stays (so heading is a first-class type like every other), but the scoped verb is the natural way to reach it.

Not built here. This document specifies the shape so the Phase-2 implementation has a target.
