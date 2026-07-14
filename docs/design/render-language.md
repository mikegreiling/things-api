# The TTY render design language

Ratified by Mike, 2026-07-13. This is the canon for how the read views style a row on a terminal — the doctrine behind `src/cli/glyphs.ts` (the glyph vocabulary + the `LEGEND` table) and `src/cli/render.ts` (`formatItem` and the view renderers). Plain-text output (piped, `NO_COLOR`, `--json`) is unaffected by everything here: shape carries state, color/weight/dim are enhancements on top, and the tests that assert styling force color on deliberately (`test/unit/render-styling.test.ts`).

**Width-aware fitting is an orthogonal layer UNDER this canon** ([width-aware-tty.md](width-aware-tty.md), SHIPPED 2026-07-13). The channels here decide *what a segment carries and how it is styled*; the fitter decides *how much of the collapsible segments (title, tags) survives a narrow terminal*, never altering the always-present, meaning-bearing parts (uuid, box, chips, tail markers, deadline). It engages only when a TTY width is resolved; `width: null` (pipes, `--json`) is byte-identical to the composition below.

## The principle

**A row never re-states what its container already says; a row marks only its deviations from the container's normal.**

- **Corollary 1 — no redundant per-row markers.** If a section header already says "Today", its rows drop the per-row `★`. If a day header already carries the date, its rows drop the `‹date›` chip. If a view IS the Logbook, its rows drop the "this is resolved" dim.
- **Corollary 2 — styling is contextual by design.** The same item renders differently in different views. A resolved item is plain in the Logbook (resolved is the norm there) but dim among open items in a project view (there it deviates). A project is an underlined heading where it heads a to-do group (anytime) but a plain bold row where it is just one row among peers (the projects sidebar, area detail).

## The channels

Each visual channel carries **one** kind of meaning. Reading a row means decoding independent channels, not memorizing combinations.

| Channel | Carries | Rule |
|---|---|---|
| **Bracket shape** | type | `[ ]` to-do, `( )` project — never altered, survives color-strip, the primary type cue |
| **Weight (bold)** | type | project titles are **bold** everywhere, every state (the single law `projectTitleAccent`); to-dos are regular weight |
| **Color (one meaning per hue)** | — | **blue** = the project checkbox accent + the resolved `✓`/`×` marks; **yellow** `★` = Today; **bright-blue** `⏾` = This Evening; **red** = overdue/due deadline; **green** = area mark + tags |
| **Glyph interior** | state | `✓` completed, `×` canceled, `↻` repeating template, `~` someday |
| **Dim** | secondary metadata + corollary-2 deviations | uuid prefix, tags, chips, container suffixes — plus a resolved row that deviates from its list's norm |
| **Underline** | heading ROLE only | a project (or heading) that heads the group beneath it; never a plain row |

The blue channel is deliberately *not* spent on project titles: the round bracket plus the bold weight already say "project", so blue is freed to mean the checkbox accent and the resolved marks alone.

## Per-view roles

Two contextual decisions drive `formatItem` options. "Project role" is whether a project row heads its own to-do group (underlined heading) or is just a row (plain bold). "Resolved" is whether completed/canceled rows are the view's norm (plain / strike-only) or a deviation (dim / dim+strike).

| View / renderer | Project role | Resolved rows | Notes |
|---|---|---|---|
| `today` | row | deviation | flat open list; `★`/`⏾` live in the section headers |
| `inbox` | row | deviation | |
| `upcoming` | row | deviation | repeat templates carry the `‹waiting/paused/ended›` chip |
| `anytime` (`renderSections`, `renderAnytimePreview`) | **heading** (underline) | deviation | projects head their to-do groups |
| `someday` (`renderSomedayPreview`) | **row** in the groups; **heading** in the trailing "From active projects" section | deviation | someday projects list as plain rows flush with the to-dos |
| `projects` sidebar | row | deviation | every row is a project — bold, no underline |
| `logbook` | row | **normal** (`resolvedNormal`) | completed plain, canceled strike-only, no dim |
| `trash` | row | deviation | mixed content keeps dim / dim+strike |
| `search` (incl. `--logged`/`--trashed`) | row | deviation | mixed content keeps dim / dim+strike |
| `project show` member rows | row | deviation | checked-unswept completions dim inline; headings render dim+underline |
| `area show` top projects | **row** (bold, no underline) | deviation | they do NOT head to-do groups in this view |
| detail-card **headers** (`project show` / `area show` title line) | heading (bold+underline / bold) | — | the opened resource's own header, untouched |

Only the **Logbook** treats resolved as normal. Only **anytime**, the **anytime preview**, and **someday**'s "From active projects" section treat list-row projects as headings; detail-card title lines are headers (a separate, untouched role).

## The single law (delta 1)

`projectTitleAccent(title)` in `glyphs.ts` is the ONE place project-title weight/color is decided. It returns `bold(title)` — bold, default color. Every project-title call site routes through it: `formatItem`'s title composition and the hand-built project-header lines (`someday` preview). Reverting to blue, or bold-blue, is a one-line change to that function and nowhere else.

## The nine deltas (the 2026-07-13 change)

1. **Project titles bold + default (white), never blue, in all list rows** — via the single law `projectTitleAccent`.
2. **Repeating project template circle** `dim("(↻)")` → `blue("(↻)")` — a template is still a project (GUI shows a solid blue circle with the arrow).
3. **Repeating to-do template box** `dim("[↻]")` → plain `"[↻]"` — the GUI's repeat pseudo-checkbox is white.
4. **Someday project circle** `blue("(~)")` → `dim("(~)")` — the GUI mutes someday projects like someday to-dos; type is carried by the parens + bold title.
5. **Someday project titles** — no special case; bold white via the delta-1 law.
6. **Logbook: resolved-is-normal** — completed titles plain (not dim), canceled titles keep the strikethrough but drop the dim; project rows bold via delta 1; the blue `[✓]`/`[×]`/`(✓)`/`(×)` marks stay. Mechanism: the `resolvedNormal` `formatItem` option, passed only by the logbook renderer; global status styling is unchanged.
7. **Mixed contexts unchanged** — `project`/`area` show (checked-unswept rows) and `search --logged`/`--trashed` keep the current dim (completed) and dim+strike (canceled); they do NOT pass `resolvedNormal`.
8. **Area detail top projects** — plain rows, not headings: underline removed (bold arrives via delta 1). Anytime keeps bold+underline (projects genuinely head their groups there). Detail-card headers keep their header styling.
9. **Repeating-state words** — `waiting`/`paused`/`ended` (the `statusWord` option, from `templateStatus`) render as dim chevron chips `‹waiting›` etc., matching the `‹date›` chip form, wrapped at the single `formatItem` meta slot so all list callers inherit. The to-do detail card's prose repeat state is NOT chipped.
