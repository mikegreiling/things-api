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

Worked examples (Mike's cases):

- Areas `Family` and `Family - Jennifer`, ref `family`: tier 2 matches **only** `Family` (the other is a different string, not a case-variant) → resolves to `Family`. It does **not** fail, because `Family - Jennifer` never enters the running.
- Areas `Family` and `FaMiLy`, ref `family`: tier 0/1 miss; tier 2 matches **both** → ambiguity error.
- Same areas, ref `Family`: tier 1 (exact) matches only `Family` → resolves, definitively, ignoring `FaMiLy`. "Get the casing exactly right and it always wins."

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
