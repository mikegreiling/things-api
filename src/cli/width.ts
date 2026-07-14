/**
 * Width-aware TTY row fitting (docs/design/width-aware-tty.md). Terminal list
 * rows never wrap: like the Things GUI, an over-long row truncates its title
 * with a trailing `…` and folds its tags, keeping the always-present metadata
 * (uuid, box, chips, tail markers, the full deadline token) intact. Everything
 * here is pure and takes the target width explicitly, so it is unit-testable
 * without a TTY and byte-stable off one: fitting engages ONLY when the driver
 * resolves a positive width (setFitWidth) — the default is null (no fitting),
 * so pipes, grep, and `--json` are untouched by construction.
 *
 * No runtime dependency (guest e2e bundles ship node + dist + commander only),
 * so the display-width math is a small vendored wcwidth: SGR escapes strip to
 * zero, East-Asian-Wide + emoji-presentation codepoints count two cells, the
 * rest count one. ZWJ-sequence emoji can be off by a cell (accepted — worst
 * case a row runs a hair short); the glyph vocabulary (★ ⏾ ⚑ ↻ ⍾ ≡ ◷) is all
 * ambiguous/narrow class and counts one, so the layout math matches the render.
 */

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Drop every SGR (color/dim/bold/…) escape, leaving the visible characters. */
export function stripSgr(s: string): string {
  return s.replace(SGR, "");
}

// Codepoint ranges that occupy TWO terminal cells: the East-Asian Wide/Fullwidth
// core plus the default-emoji-presentation set (so "⭐️" counts 2 while the
// ambiguous-class "★" counts 1 — the property that keeps our glyph set narrow).
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals … Kangxi
  [0x3041, 0x33ff], // Hiragana … CJK compat
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compat Ideographs
  [0xfe30, 0xfe4f], // CJK Compat Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth signs
  // Emoji-presentation (default-wide) — the codepoints Unicode marks
  // Emoji_Presentation=Yes outside the SMP blocks below.
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50], // ⭐ WHITE MEDIUM STAR (Emoji_Presentation — 2 cells)
  [0x2b55, 0x2b55],
  [0x1f000, 0x1faff], // SMP emoji blocks (mahjong … symbols & pictographs ext)
  [0x20000, 0x3fffd], // CJK Ext B+ (SIP/TIP)
];

// Zero-width: combining marks, ZW(SP/NJ/J), and variation selectors. Treating
// VS16 (FE0F) as zero-width means an emoji-presentation base already counted 2
// stays 2 (rather than 3) — the "⭐️" case.
const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritics
  [0x200b, 0x200f], // ZWSP … RLM (incl. ZWJ 200d)
  [0xfe00, 0xfe0f], // variation selectors
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** Terminal cells a single codepoint occupies: 0 (combining/zero-width), 2 (wide), else 1. */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (inRanges(cp, ZERO_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

/** Visible terminal width of a string: SGR-stripped, summed per codepoint. */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripSgr(s)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/**
 * Truncate PLAIN text (no SGR) to at most `cols` terminal cells, never splitting
 * a wide codepoint across the boundary. Used to clip a raw title before its
 * styling wrappers are re-applied, so the ellipsis/clip boundary lands OUTSIDE
 * the SGR runs (the fitter never cuts an escape sequence).
 */
export function clipPlain(s: string, cols: number): string {
  if (cols <= 0) return "";
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > cols) break;
    out += ch;
    w += cw;
  }
  return out;
}

// ── Row fitting ─────────────────────────────────────────────────────────────

/**
 * TITLE : TAGS relative max-width ratio (tunable — ONE place). Both segments
 * divvy up the collapsible budget; while both are over their share the title
 * truncates and the tags fold from the end. 4:1 keeps the title dominant.
 */
const TITLE_RATIO = 4;
const TAGS_RATIO = 1;

/**
 * The title's protected minimum, in columns. NOT a per-row clamp: it is the
 * input to the single derived floor (render.ts MIN_FIT_WIDTH = worst-case
 * furniture + TITLE_MIN) and the threshold the sacrifice order protects the
 * title down to. Because the driver fits every row to max(width, MIN_FIT_WIDTH),
 * the worst-furniture row's title lands at exactly TITLE_MIN and every lighter
 * row's title is automatically wider — so this floor is always satisfiable and
 * there is no sub-floor clip (below the floor the terminal wraps, losing nothing).
 */
export const TITLE_MIN = 16;

/**
 * The named, ordered stages of a row's collapse — the ratified sacrifice order
 * (docs/design/width-aware-tty.md, GUI-measured oracle + the CLI-only container
 * rule). Reordering the sacrifice is editing this list plus {@link fitRow}.
 */
export type FitStage =
  | "full" // nothing dropped
  | "both-shrink" // title truncates + tags fold from the end, container kept (4:1)
  | "container-drop" // CLI-only container dropped WHOLE, tags hold at `#first #…`
  | "tags-bare"; // last tag folds to bare `#…`, container already gone

/**
 * The segments of a row the fitter composes. Fixed parts are pre-styled strings
 * (measured, never altered); the two collapsible parts arrive as raw material
 * plus their styling closures so truncation happens on plain text and the SGR
 * wraps the result:
 *  - `left`     uuid column + box + meta chips (measured; the space before the
 *               title is added by the fitter)
 *  - `rawTitle` + `styleTitle` — the plain title text and its wrapper
 *  - `tail`     trailing markers (count chip, ◷ ≡ ≔) — pre-styled incl. its
 *               leading space, or ""
 *  - `tagNames` raw tag names (no `#`) + `styleTags` wrapping a `#a #b` form
 *               (incl. the leading space) — the fitter folds the list
 *  - `context`  the ` (container)` suffix — pre-styled incl. leading space, or ""
 *  - `deadline` the full ⚑ token — pre-styled incl. leading space, or ""
 *  - `full`     the fully-composed row (the byte-identical no-fit output)
 */
export interface RowSegments {
  left: string;
  rawTitle: string;
  styleTitle: (text: string) => string;
  tail: string;
  tagNames: string[];
  styleTags: (form: string) => string;
  context: string;
  deadline: string;
  full: string;
}

/** Overflow marker for folded tags (dim styling applied by the row's styleTags). */
const TAG_OVERFLOW = "#…";

/**
 * Plain form (no styling, no leading space) of the tag run showing the first `k`
 * real tags; when `k` is below the total, the dropped tags fold into the dim
 * `#…` marker. `k === 0` is the bare marker.
 */
function tagForm(names: string[], k: number): string {
  const shown = names.slice(0, k).map((n) => `#${n}`);
  if (k < names.length) shown.push(TAG_OVERFLOW);
  return shown.join(" ");
}

/** Visible width of the rendered tag run at level `k` (its leading space + form). */
function tagWidth(names: string[], k: number): number {
  if (names.length === 0) return 0;
  return 1 + visibleWidth(tagForm(names, k));
}

/** Widest tag level (most real tags) whose render fits `cap`, floored at `floorK`. */
function pickTagLevel(names: string[], cap: number, floorK: number): number {
  for (let k = names.length; k >= floorK; k--) {
    if (tagWidth(names, k) <= cap) return k;
  }
  return floorK;
}

/**
 * Fit one row into `width` terminal cells per the ratified collapse order. The
 * always-present parts (uuid, box, meta chips, tail markers, full deadline)
 * never shrink; title and tags divvy up what remains (4:1), then the CLI-only
 * container is sacrificed WHOLE (before the last tag folds), then the last tag
 * folds to bare `#…`, and the title bottoms at TITLE_MIN. `width` is the
 * caller's effective width (already max'd with MIN_FIT_WIDTH), so the final
 * stage always satisfies the floor; a sub-floor width would simply let the
 * terminal wrap (the title is kept whole rather than clipped). A row that
 * already fits returns its full form unchanged (byte-identical).
 */
export function fitRow(seg: RowSegments, width: number): string {
  const names = seg.tagNames;
  const wLeft = visibleWidth(seg.left) + 1; // + the space before the title
  const wTail = visibleWidth(seg.tail);
  const wCtx = visibleWidth(seg.context);
  const wDead = visibleWidth(seg.deadline);
  const wTitle = visibleWidth(seg.rawTitle);
  // A naturally short title never floors at TITLE_MIN — it simply fits whole.
  const titleNeed = Math.min(TITLE_MIN, wTitle);

  const fixed = (ctx: boolean): number => wLeft + wTail + wDead + (ctx ? wCtx : 0);
  const fitTitle = (budget: number): string =>
    wTitle <= budget
      ? seg.styleTitle(seg.rawTitle)
      : seg.styleTitle(`${clipPlain(seg.rawTitle, budget - 1)}…`);
  const renderRow = (title: string, k: number, ctx: boolean): string => {
    const tags = names.length > 0 ? seg.styleTags(tagForm(names, k)) : "";
    return `${seg.left} ${title}${seg.tail}${tags}${ctx ? seg.context : ""}${seg.deadline}`;
  };

  // Stage "full": everything fits with tags whole and the container present.
  const budgetFull = width - fixed(true);
  if (wTitle + tagWidth(names, names.length) <= budgetFull) return seg.full;

  // Stage "both-shrink": tags fold from the end toward `#first #…` under their
  // 1/(4+1) budget cap while the title truncates; the container stays put.
  const tagCap = Math.floor((budgetFull * TAGS_RATIO) / (TITLE_RATIO + TAGS_RATIO));
  const k = pickTagLevel(names, tagCap, 1);
  const titleBudgetB = budgetFull - tagWidth(names, k);
  if (titleBudgetB >= titleNeed) return renderRow(fitTitle(titleBudgetB), k, true);

  // Stage "container-drop": the CLI-only container yields WHOLE (a truncated
  // parenthetical is worse than none) BEFORE the last tag folds — tags hold at
  // `#first #…`, the reclaimed width goes to the title.
  const budgetNoCtx = width - fixed(false);
  const titleBudgetC = budgetNoCtx - tagWidth(names, 1);
  if (titleBudgetC >= titleNeed) return renderRow(fitTitle(titleBudgetC), 1, false);

  // Stage "tags-bare": the last tag folds to the bare `#…` marker (container
  // already gone), the title floors at TITLE_MIN. No end-clip: at an effective
  // width this budget clears the floor; a sub-floor width keeps the title whole
  // and lets the terminal wrap (never dropping the deadline).
  const titleBudgetD = budgetNoCtx - tagWidth(names, 0);
  const dTitle = titleBudgetD >= 1 ? fitTitle(titleBudgetD) : seg.styleTitle(seg.rawTitle);
  return renderRow(dTitle, 0, false);
}

// ── Width resolution + the module-level fit width ────────────────────────────

let fitWidth: number | null = null;

/**
 * Set the process-wide fit width (columns), resolved ONCE by the CLI driver at
 * startup. `null` disables fitting (the default — every non-TTY path stays
 * byte-stable). Tests set this explicitly and reset it afterward.
 */
export function setFitWidth(width: number | null): void {
  fitWidth = width;
}

/** The current fit width, or null when fitting is disabled. */
export function getFitWidth(): number | null {
  return fitWidth;
}

/**
 * Resolve the fit width from the environment and stdout: `THINGS_WIDTH` wins
 * when set (a positive integer forces that width; `0` disables fitting), else
 * the terminal's column count when stdout is a TTY, else null (pipes, grep,
 * captured output — no fitting, byte-stable). A malformed `THINGS_WIDTH` is
 * ignored (falls through to the TTY/null resolution).
 */
export function resolveWidth(opts: {
  env: Record<string, string | undefined>;
  columns: number | undefined;
  isTTY: boolean;
}): number | null {
  const raw = opts.env["THINGS_WIDTH"];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n === 0 ? null : n;
    // malformed — fall through to the TTY resolution
  }
  if (opts.isTTY && typeof opts.columns === "number" && opts.columns > 0) return opts.columns;
  return null;
}
