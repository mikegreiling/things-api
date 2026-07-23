# NOTESMD — what markdown does the Things notes field render?

Run `things-run-notesmd-anyord-20260723-135451` (offline pinned clone; `lab/scripts/research-notesmd.sh`), per up-next §6 NOTESMD step 1. Mike's live-GUI observations (notes render `_italic_`, `**bold**`, links show label+url, bare URLs auto-linkify, `- [ ]` presumably inert) needed to be evidence, not folklore.

**Method.** URL-scheme seeded ONE to-do (`NOTESMD-TODO`) and ONE project (`NOTESMD-PROJECT`), both with the same 593-byte synthetic note exercising the full plausible vocabulary, then opened each card and screenshotted the rendered note (VNC; framebuffer 2048×1536). Evidence (gitignored, synthetic): `lab/artifacts/things-run-notesmd-anyord-20260723-135451/nm-04-todo-open2.png` (to-do card) + `nm-06-project-view.png` (project header). **The to-do and project render the note identically** — one renderer.

## Headline: markdown FORMATTING renders, but the syntax markers stay VISIBLE

Things applies inline/block **styling** (bold, italic, heading size, monospace, code-block shading, link colour) while **leaving the literal markdown characters in place** — a source-preserving "live" render (like Obsidian live-preview / Bear), not a clean hidden-syntax render. Agents should not expect the markers to disappear. And **bare URLs auto-linkify**, so wrapping a URL in `[label](url)` is pure noise (the label stays literal and only the raw URL becomes a link).

## Construct → verdict table

| # | Construct | Input | Rendered result | Verdict |
|---|---|---|---|---|
| 1 | ATX heading | `# Heading One` / `## Heading Two` | bold + larger text; the `#`/`##` marker stays visible (dimmed) | **RENDERS** (marker kept) |
| 2 | Emphasis (underscore) | `_underscore italic_` | italic; `_` markers stay visible | **RENDERS** |
| 3 | Emphasis (asterisk) | `*asterisk italic*` | italic; `*` markers stay visible | **RENDERS** |
| 4 | Strong (double star) | `**double-star bold**` | bold; `**` stays visible | **RENDERS** |
| 5 | Strong (double underscore) | `__double-underscore bold__` | bold; `__` stays visible | **RENDERS** |
| 6 | Bare URL | `https://example.com/page` | auto-linkified (blue, clickable) | **RENDERS** (auto-link) |
| 7 | Markdown link | `[Example Label](https://example.com/page)` | `[Example Label](` stays **literal**; only the raw URL inside auto-linkifies; `)` literal | **INERT** (label not collapsed) |
| 8 | Angle-bracket URL | `<https://example.com/page>` | URL auto-linkified; `<`/`>` stay literal | **RENDERS** (auto-link; brackets kept) |
| 9 | Unordered list (`-`) | `- unordered dash one` (+ nested) | dash bullet; nesting (indent) preserved | **RENDERS** |
| 10 | Unordered list (`*`) | `* asterisk bullet` | asterisk stays **literal** (raised `*`), not a bullet | **INERT** |
| 11 | Ordered list | `1. ordered one` (+ nested `1.`) | number+`.` kept; list layout + nesting preserved | **RENDERS** (markers kept) |
| 12 | Code span | `` `inline code span` `` | monospace; backticks stay visible | **RENDERS** |
| 13 | Fenced code block | ` ```…``` ` | shaded gray monospace block; ` ``` ` fences stay visible | **RENDERS** (block) |
| 14 | Blockquote | `> blockquote line` | `>` stays visible; no distinct blockquote styling | **INERT** (literal `>`) |
| 15 | Thematic break | `---` | three literal dashes; **no** full-width rule line | **INERT** |
| 16 | Task checkbox (unchecked) | `- [ ] unchecked checkbox` | dash bullet + literal `[ ]`; not interactive | **INERT** |
| 17 | Task checkbox (checked) | `- [x] checked checkbox` | dash bullet + literal `[x]`; **whole line rendered DIMMED/gray** | **INERT + quirk** (see below) |
| 18 | Hard line break | trailing two spaces | normal line break | **N/A** — Things breaks on every newline natively |

## Quirk: `- [x]` dims the line, `- [ ]` does not (oddities candidate, minor)

`- [x] …` is rendered in a **dimmed gray** (completed-looking) style, while the sibling `- [ ] …` renders at normal weight — yet **neither** is an interactive checkbox and neither hides its `[ ]`/`[x]` literal. So Things half-recognises the checked-task marker (dims it as if done) but not the unchecked one, and implements neither as a real checkbox. Cosmetic inconsistency, not data-affecting → recorded in oddities as a minor rendering quirk.

## Guidance for the doc sweep (up-next §6 NOTESMD step 2 — NOT done here)

The verdict feeds the documentation sweep (skill references, `things help`, MCP tool descriptions) queued as step 2. Recommended phrasing (subject to surface-copy.md): *"The notes field is **markdown with multi-line support** — `**bold**`, `_italic_`, `` `code` ``, fenced code blocks, `#` headings, and `-` bullets render (the syntax characters remain visible); **bare URLs auto-linkify**, so do not wrap a URL in `[label](url)` (the label stays literal). `> blockquotes`, `---` rules, `*`-bullets, and `- [ ]`/`- [x]` checkboxes are inert literal text."* This also informs the §6 markdown-checkbox→checklist-import idea: checkbox syntax IS inert in the rendered note (a precondition that item wanted), though `- [x]` gets a cosmetic dim.

## Reproduce

```
TART_HOME=/Volumes/Workspace/tart \
VNCDO=/path/to/vncvenv/bin/vncdo \
  bash lab/scripts/research-notesmd.sh
```

Offline pinned clone; seeds the two items via URL scheme, opens each card (rapid double-click on the to-do row; `things:///show` for the project), screenshots. **Card-open note:** vncdo has no double-click primitive and a slow two-click just re-selects — a rapid `click 1 click 1` (no pause) in one invocation opens the card.
