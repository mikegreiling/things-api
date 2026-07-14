# Width-aware TTY rendering

Status: **SHIPPED** (2026-07-13). Segment-aware row fitting for list rows: `src/cli/width.ts` (the fitter + vendored wcwidth) and `src/cli/render.ts` (`formatItem` composes named segments). Ratified by Mike's GUI-measured collapse oracle (below). The right-pinned deadline gutter is now **shipped (experimental)** (§ Deadline gutter).

## Problem

List rows are flat strings; anything longer than the terminal hard-wraps at the edge, which reads badly and misaligns the uuid column. The GUI never wraps: it truncates the title with a trailing ellipsis and keeps the right-side metadata (tags, deadline flag) visible — see any long row in the app ("Re-assess patreon subscriptions, and look through recent patreon-exclusi…").

Note the `--help` contrast: commander *reflows prose* to terminal width. List rows want the opposite — **truncate, never wrap**. Both are TTY-aware; they are different operations.

## The collapse oracle (Mike's GUI measurements, 2026-07-13)

Canon. Measured from the Things app; the fitter reproduces it.

- **The always-present parts NEVER shrink or drop**: the uuid column, the checkbox glyph, the meta chips (`‹date›` / `‹waiting›` …), the tail markers (`◷ ≡ ≔`, the project count chip), and the FULL deadline token (`⚑ Aug 28` / `⚑ 2 days left`).
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

## The single derived floor — `MIN_FIT_WIDTH`

There is **no per-row title clamp**. `TITLE_MIN = 16` is an *input*, not a per-row constraint: it derives one global floor.

`MIN_FIT_WIDTH` (computed once in `render.ts` `computeMinFitWidth`, with a comment enumerating the parts, and re-derived independently by `width.test.ts` so it cannot silently drift when glyphs change) = the **worst-case fixed furniture** a row can carry + a 16-column title:

- the id column (never shrinks) + its two-space separator
- the checkbox glyph
- a space + the widest meta chip (a future `‹date›` with a year)
- a space + the tail: project count chip + all three marks `◷ ≡ ≔` (a **conservative superset** — the count chip and checklist never truly co-occur on one row, but budgeting both keeps the floor safe)
- a space + the bare `#…` marker
- a space + the longest deadline token (`⚑ NN days left`)
- a space + a `TITLE_MIN`-column title

**Effective width = `max(terminalWidth, MIN_FIT_WIDTH)`.** Every row fits to the effective width via the sacrifice order. Because the floor budgets the worst-case furniture, the heaviest row's title lands at exactly 16 and every lighter-furnitured row's title is automatically ≥ 16 (less furniture = more budget) — this eliminates the per-row raggedness where heavy rows bottom out and overflow at widths where light rows still fit.

**Below the floor there is NO end-clip.** The row renders at `MIN_FIT_WIDTH` and the terminal wraps naturally — end-clipping would cut the deadline (violating the never-disappears rule); wrapping is ugly but loses nothing. This mirrors the GUI exactly: its minimum WINDOW width is the same worst-case derivation (that is what Mike measured), and below-floor is unreachable in the GUI, so terminals get the wrap-honestly fallback.

## Architecture (as built)

- **`src/cli/width.ts`** — pure, no DB, no commander:
  - a vendored ~wcwidth: `stripSgr` (drop SGR escapes), `charWidth` (East-Asian-Wide + emoji-presentation ranges = 2 cells, combining/ZWJ/VS = 0, else 1 — ZWJ-sequence imperfection accepted), `visibleWidth`, `clipPlain` (width-aware plain truncation that never splits a wide codepoint);
  - `fitRow(segments, width)` implementing the sacrifice order over `RowSegments`;
  - `TITLE_MIN`, the `TITLE_RATIO`/`TAGS_RATIO` pair, and the module-level fit width (`setFitWidth`/`getFitWidth`) + `resolveWidth`.
  - There is **no `clipAnsi` end-clip** — refinement removed the sub-floor clip stage, so nothing needs it. Truncation happens on the PLAIN title (`clipPlain`) which is then re-styled, so a clip/ellipsis boundary always lands OUTSIDE the SGR runs (an escape is never split).
- **`src/cli/render.ts`** — `formatItem` builds named segments (`left` = uuid + box + meta chips; `rawTitle` + `styleTitle`; `tail`; `tagNames` + `styleTags`; `context`; `deadline`) and composes them. **`width: null` (the default) returns the fully-composed row, byte-identical to before this feature** — the hard compatibility contract, proven by the unchanged test suite. When a positive fit width is set, it clamps to `MIN_FIT_WIDTH` and calls `fitRow`.
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
