# CLI grammar — one router, one precedence chain

How `things <argv>` becomes a dispatched command. This is the single specification for the read-side routing sugar that accreted across PRs #89/#93/#94 as three independent special cases; it is now one resolver (`src/cli/resolve-invocation.ts`) that normalizes every sugar form into one canonical grammar.

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
| **Loose verb** (sugar) | `things <verb> <subject>` | `things show Hobbies` | `things <type> <verb> <subject>` |
| **Bare noun** (sugar) | `things <subject>` | `things Hobbies` | `things <type> show <subject>` |

`<type>` ∈ {`area`, `project`, `todo`}; `<verb>` ∈ {`show`, `open`}. The loose and bare forms are conveniences: they let a user paste any reference — a name, a uuid prefix, a `things:///show?id=…` share link — without first classifying it. The resolver + reference resolution together decide the `<type>`.

## Precedence chain (single, documented)

Every invocation is classified by walking this chain in order; the first rule that matches wins:

1. **Registered command / alias** — if the first token names a command or alias, it dispatches to that command. Command names are RESERVED and always win, so `things inbox`, `things areas`, `things today` are the commands, never a lookup of an item so named. (Escape hatch: reach a shadowed item by uuid, or via the typed command — `things area show Anytime`.)
2. **View keyword** — inside `show`/`open` only, a first argument that is a view keyword (tables below) routes by keyword rather than by reference. A keyword beats a same-named project or area (mirrors the URL scheme).
3. **Reference resolution** — anything else is a reference, resolved by [reference-resolution.md](reference-resolution.md)'s tiers: **uuid (full) → uuid prefix (≥6 base-62 chars) → `things:///show?id=…` share link (stripped to its id) → tiered name match (exact → case-insensitive → normalized → uuid-prefix)**. On a name tie, **area beats project** (`classifyShowTarget` tries area before project). A heading reference resolves to its containing project. Tags and checklist items have no show view and are rejected.

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

Ten keywords, all of them real commands. `things show projects` → `things projects`.

### `open` keywords → launch `things:///show?id=<kw>` directly

`open`'s vocabulary belongs to the app. It accepts **only the seven verified URL-scheme ids**:

`inbox` `today` `anytime` `upcoming` `someday` `logbook` `trash`

The plurals are deliberately **not** openable — the app has no such list screen. `things open projects` (or `areas`/`tags`) errors with copy naming the fix:

```
the app has no projects list to open — open a specific project: `things open <ref>`
```

A non-keyword `open` reference (`things open Hobbies`, `things open <uuid>`) resolves like `show` and foregrounds that resource in the GUI.

## Normalized-form echo

When — and only when — an invocation arrives via a sugar form, the TTY renderer emits one dim line showing the canonical runnable command it normalized to, adjacent to the view/entity header:

```
≡ things area show "Website redesign"
```

The subject is rendered with the same shell-safe quoting as the truncation footers (`shellQuote`): a plain word is left bare (`≡ things area show Hobbies`), a name with spaces or shell metacharacters is quoted. It fires for the four routing sugars:

- **bare noun** — `things Hobbies` → `≡ things area show Hobbies`
- **keyword-in-show** — `things show anytime` → `≡ things anytime`
- **uuid routing** — `things <uuid>` / `things show <uuid>` → `≡ things todo show <uuid>`
- **share-link** — `things things:///show?id=<uuid>` → `≡ things todo show <uuid>`

It does **not** fire for canonical invocations (`things inbox`, `things area show Hobbies` — nothing was normalized), nor for a loose `show` given a plain **name** (`things show Hobbies` — the verb was already typed and the name is already visible; only bare-noun promotes a name). The echo is strictly an interactive affordance: **never on non-TTY output** (so `things Hobbies | grep` stays clean) and **never in `--json`**.

## `meta.resolvedCommand` (`--json`, additive)

The same canonical string rides the `--json` envelope of a routed read as `meta.resolvedCommand` — present exactly when the echo would have fired, absent otherwise. It is additive (no `apiVersion` bump). Example: `things show anytime --json` carries `meta.resolvedCommand: "things anytime"`.

**MCP does not carry it.** The MCP read tools do not route through this path — `read_view` takes a `view` enum and `get_item`/`get_project` take a uuid directly, so there is no loose reference to normalize and nothing to echo.

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
