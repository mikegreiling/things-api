# Width-aware TTY rendering — parked design space

Status: **PARKED, not ratified** (2026-07-13). Mike deferred this after the ideation round; pick it back up from here. Nothing below is implemented.

## Problem

List rows are flat strings; anything longer than the terminal hard-wraps at the edge, which reads badly and misaligns the uuid column. The GUI never wraps: it truncates the title with a trailing ellipsis and keeps the right-side metadata (tags, deadline flag) visible — see any long row in the app ("Re-assess patreon subscriptions, and look through recent patreon-exclusi…").

Note the `--help` contrast: commander *reflows prose* to terminal width. List rows want the opposite — **truncate, never wrap**. Both are TTY-aware; they are different operations.

## Design space (with leans, none ratified)

### a. Architecture — where the width knowledge lives

Two candidates:

- **Post-pass clip**: one choke point in `runRead` — when stdout is a TTY, map every line through an ANSI-aware `clip(line, columns)`. Nearly free, zero per-view work. But `formatItem` puts `(container) #tags ⚑ deadline` at the line END, so an end-clip eats the deadline flag and tags first while preserving the title — backwards from the GUI, which sacrifices the title middle and keeps the right-side metadata.
- **Segment-aware fitting**: `formatItem` (src/cli/render.ts — already the single row factory) returns `{left, title, right}` segments and a fitter squeezes only the title to fit. GUI-faithful; the diff is one function plus a fitter, but every caller signature moves.

Lean: segment-aware for item rows, with the dumb end-clip kept as a safety net for non-item lines (headers, hints) and pathological widths.

### b. Squeeze priority

Title ellipsizes first, with a reserved floor (~20 cols). If still over: drop `(container)` context, then truncate tags to `#first +2`. The uuid column (the copy-paste affordance) and the deadline flag never drop. Trailing `…`, matching the GUI's truncation style.

Open call: is the tiering worth it for v1, or is "title-only ellipsis, keep everything else, end-clip as fallback" enough?

### c. Width math (the real risk)

Visible width ≠ string length: ANSI SGR sequences, double-width emoji ("⭐️ Habit Tracking System"), VS16 selectors, and the glyph set (★ ⏾ ⚑ ↻ ⍾ ≡ — narrow but ambiguous-class East Asian width). No new runtime dep (guest e2e bundles ship node + dist + commander only), so: a vendored ~40-line wcwidth — strip SGR, treat East-Asian-Wide + emoji-presentation ranges as 2 cells. ZWJ-sequence emoji will occasionally be off by a cell; acceptable (worst case a row runs a hair short).

### d. Right-pinned deadline gutter

The GUI pins flags right-aligned at the window edge. The terminal analog (pad titles so deadlines align at the right margin) is visually excellent but a second, bigger step: column alignment across rows, raggedness when only some rows carry flags, interaction with day-group sections. Lean: phase 2 — ship no-wrap truncation first, evaluate the gutter after living with it.

### e. Scope

List rows only. `todo show` notes and detail cards stay untouched — content fidelity beats prettiness there, and those are the outputs people pipe.

### f. Gates and escape hatches

Engages only when `process.stdout.isTTY && columns` is known — pipes, grep, and `--json` are untouched by construction, so existing snapshots/tests and agent behavior stay byte-stable. Escape hatch lean: respect a `THINGS_WIDTH` env override (`0` = off) rather than mint a new universal flag (keeps the universal-flag charter small); revisit if demand appears. The fitter takes width as an explicit parameter, so unit tests exercise 40/80/120 deterministically without TTY simulation.

## Open calls for Mike before implementation

1. Title floor + tag-truncation tiering (b), or the simpler title-only v1?
2. Right-pinned deadline gutter now or phase 2?
3. `THINGS_WIDTH` env-only escape hatch OK, or do you want a `--no-fit`-style flag?
