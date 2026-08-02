# Reference resolution — names, uuids, and checklist items

How the API turns a user-supplied reference into a concrete entity. Two families, deliberately different because their stakes differ.

## Area / tag / project name references (strict, tiered)

A `--area` / `--tag` / project-container reference is resolved by walking tiers in order; **the first tier with exactly one match wins and is definitive** (lower tiers are never consulted). A tier with two-or-more matches is an ambiguity error listing the candidates. Falling off the end is not-found.

| Tier | Rule | Example that resolves here |
|---|---|---|
| 0. UUID | ref equals a row's full uuid | `7Ck4hAXU…` |
| 1. Exact | byte-for-byte, case-sensitive `title = ref` | `Family` when `Family` and `FaMiLy` both exist — exact casing disambiguates |
| 2. Case-insensitive | `title = ref COLLATE NOCASE` | `family` → `Family` (when no other case-variant exists) |
| 3. Normalized | NFC + case-fold + strip all whitespace and dashes/hyphens; **nothing else removed** | `on-hold` → `On Hold`; `familyjennifer` → `Family - Jennifer` |
| 4. UUID prefix | ref is ≥6 base-62 chars and a unique uuid prefix | `7Ck4hA` |
| 5. Decorated ref | `Title [ref]` — the bracketed segment (`[0-9A-Za-z]{4,22}`) resolves through the uuid/partial-uuid tier; the title half is an ignored comment | `Groceries [7Ck4hA12]` |

**Decorated ref (tier 5, LAST).** The fused form every TTY candidate renders (`Title [8charPrefix]`) is itself a valid input ref, so a copied candidate pastes straight back. The bracket is the machine-stable ref; the title is a *comment* (ignored), so a stale copy still resolves after a rename. It runs LAST — a *literal* title like `Family [7Ck4hA12]` wins at tier 1 by construction, so the decoration is never mistaken for a real bracketed title. The empty-title form `[prefix]` (a titleless heading — its fused form ` [prefix]` trims the leading space) is legal. A bracket below the 6-char partial-uuid floor parses as the form but does not resolve. This tier lives in the shared `resolveNamedRef` core, so EVERY ref slot inherits it (CLI flags, `--to-project`/`--to-heading`/`--area`, MCP args, library refs), independent of whether a given slot enables the bare uuid-prefix tier.

Worked examples (Mike's cases):

- Areas `Family` and `Family - Jennifer`, ref `family`: tier 2 matches **only** `Family` (the other is a different string, not a case-variant) → resolves to `Family`. It does **not** fail, because `Family - Jennifer` never enters the running.
- Areas `Family` and `FaMiLy`, ref `family`: tier 0/1 miss; tier 2 matches **both** → ambiguity error.
- Same areas, ref `Family`: tier 1 (exact) matches only `Family` → resolves, definitively, ignoring `FaMiLy`. "Get the casing exactly right and it always wins."

### Read-side liveness law (names resolve against LIVE rows only)

One law governs the trash dimension on the read side, so the bare-ref shorthand (`things "X"`) and the canonical `things project show X` can never disagree, and an ambiguity's count can never diverge from the candidate list it renders:

- **Name tiers resolve against LIVE (untrashed) rows only.** An explicit **uuid / partial-uuid** (explicit intent) still reaches a trashed project — viewing a trashed project by id is unchanged — but a **name** never resolves to, nor is shadowed by, a dead same-name twin. Mechanically this is `resolveNamedRef`'s `nameExtraWhere` narrowing the name tiers to `trashed = 0` while the uuid tiers keep the wide pool (the same split `resolveProjectWriteTarget` uses on the write side). Projects are the only read-side name-resolvable kind with a trash dimension (areas cannot be trashed; to-do titles do not resolve on the read side at all).
- **Reads-only ergonomic fallback.** When a name matches **zero live rows but exactly one trashed project**, a read surface resolves to it (so a uniquely-named trashed project stays viewable by name) and the render discloses it — the card's `(trashed)` marker, or the JSON node's `stage: "trash"`. **Several** trashed-only twins → not-found with the honest dead-row hint (`… trashed items match this name — see \`things trash\``), never a dead candidate. The write side is unaffected: a write target still refuses a trashed-only name.
- **Count / list coherence.** An ambiguity's `matches N` counts the **same live pool** its candidate list renders (equal by construction). Additional trashed twins in the uuid-reachable pool are **disclosed** — `… also matched: N in the trash — \`things trash\` lists them, a uuid reaches one directly` — rather than inflating the count.
- **Bare-shorthand cross-kind candidates.** `classifyShowTarget`'s namespace spans to-dos, areas, and projects. Precedence for a UNIQUE winner is the documented chain (uuid → area → project). But when a name is **ambiguous at one kind while another kind also has live name matches**, the refusal MERGES the live candidates across kinds (each carries its `type`), naming the split: `"X" matches 2 areas and 3 projects — use \`things area show\` / \`things project show\`, or a ref below`. The shorthand thus never shows fewer options than the narrower namespaced command would.

The CLI read surfaces route an ambiguity by the resolution error's `code === "ambiguous"` (not a message-word match), so the resolver's own candidate list surfaces verbatim under error `code: "ambiguous"`; only a genuine not-found falls through to the did-you-mean title search.

### Leading emoji / symbols are significant (by design, unopinionated)

Normalization folds only **case, whitespace, and dashes** — it never strips emoji, symbols, or other punctuation. Consequence: a name that begins with an emoji must be typed *with* that emoji to match. This is not an opinion about what a leading emoji *means*; it is simply "we fold equivalent spellings, we do not delete characters."

It happens to serve a common convention cleanly: a retired tag prefixed with an emoji (e.g. `🗄️errand`) is automatically excluded from a bare `errand` reference — `errand` resolves to an active `errand` tag, or to nothing, but never to the archived one. (An opt-in `resolve.stripLeadingSymbols` config for users who *want* emoji-insensitive matching is a possible future addition; it is intentionally not the default.)

## Checklist-item references (best-effort, low-stakes)

Checklist items are addressed within a single to-do's list, where duplicate titles are common and the stakes are low (checking a sub-item). Unlike area/tag resolution, this is **best-effort, not strict**:

- **By 1-based index** (`index`): exact and unambiguous — `index: 2` is the second item. 1-based because both humans and agents count list positions from 1 ("the 2nd item"), and it matches the existing `add --at` / `move --to` positions.
- **By title** (`item`): if one item has the title, use it. If several do, target the **first item on which the action is meaningful** — `check` → the first *unchecked* match, `uncheck` → the first *checked* match, `rename`/`remove` → the first match. If every match is already in the target state, the first match. Precise disambiguation is the caller's job, via `index`.

An `index` always overrides a title. This trades the project's usual loud-on-ambiguity stance for ergonomics *only here*, because "check off get milk" almost always means the obvious one, and the cost of a wrong guess is a re-check.

### Checklist item states

Checklist items have `status` ∈ `open` | `completed` | `canceled` (canceled exists in real data, with a `stopDate`). They have **no** trashed/logged state — they live and move with their parent to-do. The write surface only produces `open`/`completed` (check/uncheck); `canceled` is read-only (the app offers no create/set path we can drive, and the json rewrite carries a boolean). A checklist rewrite therefore cannot preserve a pre-existing `canceled` item's state — documented in [things-app-oddities.md](../things-app-oddities.md).

## Hidden internal identifiers

These columns are Things-internal implementation details and are **not** surfaced in API responses (they are unstable, non-addressable, or meaningless to a consumer): `index` and `todayIndex` on tasks; `uuid`, `index`, `task`, `created`, `modified`, `stopped` on checklist items (a checklist item's uuid is regenerated on every rewrite and is never a valid mutation target). Ordering is conveyed by array order; reorder operations take uuid sequences; the audit log captures ranks directly from SQL. `--json` still carries full task uuids (the one stable, addressable identifier).
