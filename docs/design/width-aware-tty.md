# Width-aware TTY rendering

Status: **SHIPPED** (2026-07-13). Segment-aware row fitting for list rows: `src/cli/width.ts` (the fitter + vendored wcwidth) and `src/cli/render.ts` (`formatItem` composes named segments). Ratified by Mike's GUI-measured collapse oracle (below). The right-pinned deadline gutter is now **shipped (experimental)** (§ Deadline gutter).

## Problem

List rows are flat strings; anything longer than the terminal hard-wraps at the edge, which reads badly and misaligns the uuid column. The GUI never wraps: it truncates the title with a trailing ellipsis and keeps the right-side metadata (tags, deadline flag) visible — see any long row in the app ("Re-assess patreon subscriptions, and look through recent patreon-exclusi…").

Note the `--help` contrast: commander *reflows prose* to terminal width. List rows want the opposite — **truncate, never wrap**. Both are TTY-aware; they are different operations.

## The collapse oracle (Mike's GUI measurements, 2026-07-13)

Canon. Measured from the Things app; the fitter reproduces it.

- **The always-present parts NEVER shrink or drop**: the uuid column, the checkbox glyph, the meta chips (`‹date›` / `‹waiting›` …), the tail markers (`◷ ≡ ≔`, the project count chip), and the deadline token (`⚑ Aug 28` / `⚑ 2 days left`). (The deadline token never *drops*, but a narrow width may switch it to a shorter iOS-oracle FORM — see § Compact deadline forms — without ever removing it.)
- **TITLE and TAGS divvy up the remaining collapsible space** with a **lazy fold**, not a hard cap. Tags render at the **WIDEST progressive level that fits their available budget** — all tags → `#a #b #…` → `#first #…` → bare `#…` — dropped tags collapsing into a dim `#…` marker, and the **title truncates with a trailing `…`** only when it must. The **4:1 ratio (`TITLE_RATIO`/`TAGS_RATIO` in `width.ts`) arbitrates ONLY under contention** — when BOTH natural widths exceed their shares of the collapsible budget. Otherwise:
  - if `title_nat ≤ its 4/5 share`, the title keeps its natural width and the tags get everything left (their widest fitting level);
  - if `tags_nat ≤ their 1/5 share`, the tags stay whole and the title gets the rest.
  - Either way, **slack that a discrete tag level does not use flows BACK to the title**, and neither side is ever shrunk below what the budget actually forces. (This is the lazy-fold fix: a row losing one column drops one tag, `#home #recurring #housekeeping` → `#home #recurring #…`, not straight to `#home #…`.)
- **Threshold 2** — under contention, tags floor at `#first #…` (one tag always visible + the overflow marker); from here only the title shrinks.
- **Threshold 3** — all tags collapse to the bare `#…`; the title keeps shrinking toward its protected minimum (`TITLE_MIN = 16`).

### The ratified sacrifice order (with the CLI-only container rule)

Container placement is OURS, not from the GUI oracle — the GUI puts the container on a second subtitle line, paying no row width. The governing principle Mike ratified:

> **The inline container is a CLI-only bonus element; no-oracle elements are sacrificed before oracle-protected ones.** (Governs any future inline extras too.)

So the container dies WHOLE (never ellipsized — a truncated dim parenthetical is worse than nothing) one stage **before** the last tag folds to bare. Full order, widest → narrowest:

1. **`both-shrink`** — tags fold LAZILY to their widest fitting level while the title truncates; the 4:1 split arbitrates only under contention (otherwise the under-share side keeps its natural width and the slack flows to the other). Container kept.
2. Tags reach `#first #…` — only the title shrinks. Container kept.
3. **`container-drop`** — the container drops whole; tags hold at `#first #…`; the reclaimed width goes to the title.
4. **`tags-bare`** — the last tag folds to bare `#…` (container already gone); the title floors at `TITLE_MIN`.

This container-drop stage is a named stage (`FitStage` in `width.ts`) so the ordering is easy to re-order, and **Mike may veto it** (fold back to dropping container at threshold 3, or keeping it).

## The derived floors — `FULL_FIT_FLOOR` and `COMPACT_FIT_FLOOR`

There is **no per-row title clamp**. `TITLE_MIN = 16` is an *input*, not a per-row constraint: it derives the global floors.

Both floors (computed once in `render.ts` `computeFitFloors`, with a comment enumerating the parts, and re-derived independently by `width.test.ts` so they cannot silently drift when glyphs change) = the **worst-case fixed furniture** a row can carry + a 16-column title. The ONLY part that differs between them is the deadline token:

- the id column (never shrinks) + its two-space separator
- the checkbox glyph
- a space + the widest meta chip (a future `‹date›` with a year)
- a space + the tail: project count chip + all three marks `◷ ≡ ≔` (a **conservative superset** — the count chip and checklist never truly co-occur on one row, but budgeting both keeps the floor safe)
- a space + the bare `#…` marker
- a space + the longest deadline token — **full worst case `⚑ 14 days left` (14 cells) for `FULL_FIT_FLOOR`; compact worst case (10 cells) for `COMPACT_FIT_FLOOR`**
- a space + a `TITLE_MIN`-column title

The compact deadline worst case is the widest token that can appear IN compact mode: either the narrow relative `⚑ 14d left` or a year-bearing far date `⚑ Feb 2001` (kept full even when compact — see § Compact deadline forms), both 10 cells. So the two floors today are `FULL_FIT_FLOOR = 78` and `COMPACT_FIT_FLOOR = 74` — a 4-column gap that compaction buys back.

**Effective width = `max(terminalWidth, COMPACT_FIT_FLOOR)`** (the lower floor is the hard minimum). Every row fits to the effective width via the sacrifice order. Because the floor budgets the worst-case furniture, the heaviest row's title lands at exactly 16 at whichever floor is active, and every lighter-furnitured row's title is automatically ≥ 16 (less furniture = more budget) — this eliminates the per-row raggedness where heavy rows bottom out and overflow at widths where light rows still fit.

**Below the compact floor there is NO end-clip.** The row renders at `COMPACT_FIT_FLOOR` and the terminal wraps naturally — end-clipping would cut the deadline (violating the never-disappears rule); wrapping is ugly but loses nothing. This mirrors the GUI exactly: its minimum WINDOW width is the same worst-case derivation (that is what Mike measured), and below-floor is unreachable in the GUI, so terminals get the wrap-honestly fallback.

## Compact deadline forms — the two-floor model (Things iOS oracle, 2026-07-14)

Canon. A SECOND oracle, measured from the Things **iOS** app (Mike's screenshots): at narrow width iOS shortens the deadline flag rather than dropping it. Absolute deadlines render `5/11`-style — M/D with **NO zero-padding** (`5/4`, `5/10`, `8/12`) — instead of `May 11`; day-relative deadlines render `58d ago` / `41d left` instead of `58 days ago` / `41 days left`. The flag glyph is unchanged. This is the CLI's cue for what to do in the width band between "everything fits full" and "must wrap".

**Two floors, compaction fills the gap.** The full-form floor (`FULL_FIT_FLOOR`) is the same worst-case derivation as before. `COMPACT_FIT_FLOOR` is the same furniture with the compact deadline worst case, and sits strictly below it. Behavior by effective width:

```
       ← narrower                                        wider →
   │            │                          │
   │  wrap      │   COMPACT deadlines      │   FULL deadlines
   │  (clamp)   │   (5/4, 41d left)        │   (May 4, 41 days left)
   ┼────────────┼──────────────────────────┼─────────────────────►  width
   0      COMPACT_FIT_FLOOR (74)     FULL_FIT_FLOOR (78)

  width < compact floor  → clamp to the compact floor + wrap (sub-floor rule)
  compact ≤ width < full → ALL deadlines compact; rows fit via the sacrifice order
  width ≥ full floor      → FULL forms (today's behavior, byte-identical)
```

**Per-view uniformity.** The full-vs-compact switch is decided ONCE from the effective width (`resolveFit` in `width.ts`, fed the two floor values from `render.ts`), **never per row**, so the right-aligned deadline gutter stays visually consistent — a view never mixes `Aug 12` and `8/12`. `render.ts` builds every row's `⚑` token in the resolved form, so `alignDeadline` measures the COMPACT token when compact is active and the gutter lines up.

**Scope of the compact forms — the two COMMON shapes only:**

- month-day absolutes (`Aug 12` → `8/12`) and day-relatives (`N days ago/left` → `Nd ago` / `Nd left`). iOS shows `1d` with no pluralization, so no singular special-casing is needed.
- **Year-bearing far dates (`Oct 2020`, `Feb 2027`) KEEP their current rendering even in compact mode.** This is a deliberate judgment: `10/20` would be ambiguous with an M/D date, and the iOS oracle doesn't cover year-bearing dates. Because such a date can still appear in a compact view, `COMPACT_FIT_FLOOR` budgets it as (a co-)worst case.
- `⚑ today` is already minimal and is unchanged.

**`width === null`** (non-TTY, `--json`, `THINGS_WIDTH=0`) is byte-identical to today — always full forms, the compatibility contract stands. `‹date›` chips, logged dates, and detail cards are OUT of scope (deadline token only).

## Architecture (as built)

- **`src/cli/width.ts`** — pure, no DB, no commander:
  - a vendored ~wcwidth: `stripSgr` (drop SGR escapes), `charWidth` (East-Asian-Wide + emoji-presentation ranges = 2 cells, combining/ZWJ/VS = 0, else 1 — ZWJ-sequence imperfection accepted), `visibleWidth`, `clipPlain` (width-aware plain truncation that never splits a wide codepoint);
  - `fitRow(segments, width)` implementing the sacrifice order over `RowSegments`;
  - `TITLE_MIN`, the `TITLE_RATIO`/`TAGS_RATIO` pair, and the module-level fit width (`setFitWidth`/`getFitWidth`) + `resolveWidth`.
  - There is **no `clipAnsi` end-clip** — refinement removed the sub-floor clip stage, so nothing needs it. Truncation happens on the PLAIN title (`clipPlain`) which is then re-styled, so a clip/ellipsis boundary always lands OUTSIDE the SGR runs (an escape is never split).
- **`src/cli/render.ts`** — `formatItem` builds named segments (`left` = uuid + box + meta chips; `rawTitle` + `styleTitle`; `tail`; `tagNames` + `styleTags`; `context`; `deadline`) and composes them. **`width: null` (the default) returns the fully-composed row, byte-identical to before this feature** — the hard compatibility contract, proven by the unchanged test suite. When a positive fit width is set, `resolveFit` clamps it to `COMPACT_FIT_FLOOR` and decides the deadline form (full above `FULL_FIT_FLOOR`, else compact), then `fitRow` runs.
- **Width resolution happens ONCE** in the driver (`runCli`, `src/cli/main.ts`): `THINGS_WIDTH` env override (positive integer forces width; `0` disables fitting entirely) else `process.stdout.columns` when `process.stdout.isTTY`, else null. Threaded to the renderers via the module-level fit width in `width.ts`, so every human list path inherits it and MCP / `--json` never touch it (byte-stable by construction). Tests set it explicitly with `setFitWidth`.

## Scope

**Item rows only** — every renderer that calls `formatItem`. Headers, hints, footers, detail cards, and notes are NOT fitted and NOT clipped in v1 (a wrapped hint keeps its copy-paste command intact — deliberate). Multi-tag rendering stays space-separated dim `#a #b`; the overflow marker is dim `#…`. Pipes, grep, and `--json` are untouched by construction.

## Deadline gutter (shipped — experimental, revert is one place)

The GUI pins flags right-aligned at the window edge. The terminal analog is now shipped as an **experiment** (Mike: "let's see how we like it"): when fitting is ACTIVE (a non-null fit width), every fitted row's deadline token is pushed flush to the effective width, so all deadlines in a view line up in one gutter — exactly like the app's flag column.

Rules:

- **Only when fitting is active.** When the fit width is null (non-TTY, `--json`, `THINGS_WIDTH=0`), there is **NO gutter** — the deadline stays inline at line end and the row is byte-identical to before this feature. The #120 byte-stability contract is unchanged; the gutter exists only in fitted TTY output.
- **Rows without a deadline end where they end** (ragged right is correct — the GUI leaves flag-less rows ragged too).
- **Minimum one space** between content and the gutter. A row that already fills the width keeps its single inline space (byte-identical to the un-guttered inline form). The fitter already treats the deadline as fixed budget; only its PLACEMENT changes.
- **Padding goes OUTSIDE the styled runs** (plain spaces between the row body and the pre-styled `⚑ …` token).

Isolated as a single named function `alignDeadline` in `width.ts`, called from the two `fitRow` return paths (the full-fit fast path and `renderRow`). **Reverting the experiment is deleting that function and its two call sites** — one place, by design.
