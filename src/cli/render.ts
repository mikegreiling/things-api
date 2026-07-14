/**
 * The pure human-rendering family for the read views: the glyph-language item
 * formatter, the flat and grouped list renderers, the sidebar/upcoming/logbook
 * layouts, the anytime/someday previews, and the legend. No commander and no
 * database access — every function maps already-fetched data to output lines,
 * so the whole module is unit-testable in isolation. UUIDs are always shown
 * (agents and humans both need stable references); colors engage on a TTY only
 * (../cli/style.ts).
 */
import {
  isTodayMember,
  type ListItem,
  type SidebarSection,
  type TodayView,
} from "../read/views.ts";
import { localToday } from "../model/dates.ts";
import { templateStatus } from "../model/recurrence.ts";
import { bold, dim, strike, underline } from "./style.ts";
import {
  areaMark,
  CHECKLIST_MARK,
  countChip,
  dateChip,
  deadlineToken,
  eveningMoon,
  LEGEND,
  LEGEND_GROUPS,
  loggedDate,
  NOTES_MARK,
  projectCircle,
  projectTitleAccent,
  REMINDER_MARK,
  todayStar,
  todoBox,
} from "./glyphs.ts";
import {
  partitionSomedaySection,
  splitSectionBlocks,
  type GroupedLimits,
} from "../read/pagination.ts";
import { FULL_MONTHS, upcomingBucket } from "./period.ts";

/**
 * A view's TTY-only title preamble: bold view name + its dim Things deep link,
 * then a blank line — e.g. `Anytime (things:///show?id=anytime)`. The id is the
 * app's documented show id (identical to the command name for these views).
 * Suppressed off a TTY so `things inbox | grep …` stays clean, and never part
 * of `--json`; the caller gates on both.
 */
export function viewHeaderLines(view: string): string[] {
  const title = view.charAt(0).toUpperCase() + view.slice(1);
  return [`${bold(title)} ${dim(`(things:///show?id=${view})`)}`, ""];
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
export const stripAnsi = (s: string): string => s.replace(ANSI, "");
const visibleWidth = (s: string): number => [...stripAnsi(s)].length;

/** Left-column width for the legend's glyph samples (short marks align; long textual samples overflow). */
const LEGEND_GUTTER = 10;

/**
 * The `things legend` layout: the visual language grouped into sections
 * (`── To-dos ──`, …), each row the glyph as it actually renders (color on a
 * TTY) followed by its meaning. Content comes straight from glyphs.ts's LEGEND
 * table, so it can never drift from what the list renderers emit.
 */
export function renderLegend(): string[] {
  const lines: string[] = [];
  for (const group of LEGEND_GROUPS) {
    const entries = LEGEND.filter((e) => e.group === group);
    if (entries.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(bold(`── ${group} ──`));
    for (const e of entries) {
      const pad = " ".repeat(Math.max(0, LEGEND_GUTTER - visibleWidth(e.glyph)));
      lines.push(`${e.glyph}${pad}  ${e.meaning}`);
    }
  }
  return lines;
}

export interface FormatOpts {
  /**
   * Render this project as a group HEADING: underline the title (its heading
   * ROLE — the project heads the to-do group beneath it, anytime/someday).
   * Bold is UNIVERSAL for project titles (projectTitleAccent, the render-
   * language delta-1 law), so this adds ONLY the underline; the circle glyph
   * and count chip still apply. A plain project ROW (e.g. area-detail's top
   * projects, the projects sidebar) omits this — bold without underline.
   */
  projectTitle?: boolean;
  /** Container uuids already implied by surrounding output — their context suffix is dropped. */
  suppressProject?: string | null;
  suppressArea?: string | null;
  /** Reference instant for date-relative tokens (tests pin this; defaults to now). */
  now?: Date;
  /** Pre-styled Today/Evening mark (★/⏾), rendered right after the box — GUI position. */
  mark?: string | null;
  /** Repeating-template scheduling word (waiting/paused/ended), rendered as a dim ‹chevron› chip after the box — matches the ‹date› chip form. */
  statusWord?: string;
  /** Suppress the ‹date› chip (rows under a day header already carry the date). */
  hideDateChip?: boolean;
  /**
   * The container's normal IS the resolved state (the Logbook): completed rows
   * render plain and canceled rows keep their strikethrough but drop the dim —
   * a row marks only its DEVIATIONS from the container. Mixed contexts
   * (project/area show, search --logged/--trashed) omit this, so a resolved row
   * among open ones stays dim/dim-strike. Never changes the status GLYPHS.
   */
  resolvedNormal?: boolean;
}

/**
 * One item line:
 * `<uuid-prefix>  <box> [★|⏾] [logged-date] [‹chip›] <title> [‹n›] [⍾] [≡] [≔] (container) #tags [⚑ deadline]`.
 * Repeating templates seat ↻ INSIDE the box (`[↻]`/`(↻)`) rather than as a
 * separate mark; open project circles render blue, and project TITLES render
 * bold + default-colored in every state (projectTitleAccent — the render-
 * language law). The box is the glyph-language state carrier (../glyphs.ts):
 * `[ ]`-family for to-dos, `( )`-family for projects — state survives with
 * color stripped. Completed titles dim; canceled titles dim+strike (the `[×]`
 * mark keeps the state when strike/ANSI is unavailable) — except where a view
 * declares resolved its norm (Logbook, `resolvedNormal`), where completed is
 * plain and canceled keeps only its strike. Human output shows
 * a SHORTENED uuid prefix (every command accepts unique prefixes >= 6
 * chars); `uuidWidth` is the display length from uuidDisplayWidth — never
 * below 8 so a copied prefix stays unique across the whole database, not
 * just the rendered list. Tags follow the title (`#`-prefixed, green — GUI
 * color), after the count chip (projects), notes marker, and container.
 * Heading-nested to-dos label their parent PROJECT (via headingProject),
 * never the heading — GUI behavior. Colors engage on a TTY only
 * (../style.ts); `--json` always carries full uuids.
 */
export function formatItem(item: ListItem, uuidWidth = 0, opts: FormatOpts = {}): string {
  const todayIso = localToday(opts.now);
  const asTitle = opts.projectTitle === true && item.type === "project";
  const box = item.type === "project" ? projectCircle(item) : todoBox(item);
  const meta: string[] = [];
  if (opts.mark != null) meta.push(opts.mark);
  // ↻ now lives INSIDE the box for templates (glyphs.ts) — no separate mark.
  // The repeat scheduling word renders as a ‹chevron› chip matching the ‹date›
  // chip's form; wrapping it at this single meta slot means every list caller
  // inherits it. (The detail card's prose repeat state is NOT chipped.)
  if (opts.statusWord !== undefined) meta.push(dim(`‹${opts.statusWord}›`));
  if (item.status !== "open" && item.stopped !== null)
    meta.push(loggedDate(item.stopped, todayIso));
  if (opts.hideDateChip === true) {
    // rows under a day header — the header carries the date
  } else if (item.status === "open" && item.startDate !== null && item.startDate > todayIso)
    meta.push(dateChip(item.startDate, todayIso));
  // Repeating templates chip their app-materialized next occurrence.
  else if (item.repeating.isTemplate && item.repeating.nextOccurrence != null)
    meta.push(dateChip(item.repeating.nextOccurrence, todayIso));
  // List rows mute their tags (the GUI's gray pills); tags go green only on
  // the opened resource (todo show / the project|area header row).
  const tags =
    item.tags.length > 0 ? ` ${dim(`#${item.tags.map((t) => t.title).join(" #")}`)}` : "";
  // Closed rows drop the deadline flag — a months-old red "n days ago" on a
  // logged item is noise (the GUI doesn't flag logbook rows either). Raw
  // template rows drop it via the sentinel guard: their deadline column
  // carries app-internal 4001-01-01 sentinels (upcoming's synthesized
  // occurrences carry REAL rule-derived deadlines and must keep the flag).
  const rule = item.repeating.rule;
  const deadline =
    item.status === "open" && item.deadline !== null && item.deadline < "4000"
      ? ` ${deadlineToken(item.deadline, todayIso)}`
      : // The GUI's bare flag on no-date repeating templates: the rule WILL
        // assign each occurrence a deadline (fixed rules always do; after-
        // completion only with a start offset), date unknown until spawned.
        item.repeating.isTemplate &&
          rule !== undefined &&
          (rule.type === "fixed" || rule.startOffsetDays < 0)
        ? ` ${bold(dim("⚑"))}`
        : "";
  const container = item.type === "to-do" ? (item.project ?? item.headingProject ?? null) : null;
  const context =
    container !== null
      ? container.uuid === opts.suppressProject
        ? ""
        : ` (${container.title})`
      : item.area
        ? item.area.uuid === opts.suppressArea
          ? ""
          : ` (${item.area.title})`
        : "";
  // width 0 (the default) means "no column" — show the full uuid untouched.
  const shownUuid = uuidWidth > 0 ? uuidCol(item.uuid, uuidWidth) : item.uuid;
  // Title styling composes four independent channels (docs/design/render-
  // language.md) — a row marks only its deviations from the container's normal:
  //   strike    — a canceled item (kept in EVERY context, GUI parity)
  //   dim       — a resolved row DEVIATING from its list's norm (completed/
  //               canceled among open rows); dropped where resolved IS the norm
  //               (the Logbook passes resolvedNormal)
  //   bold      — the project TYPE weight, every project row and every state,
  //               routed through the single law projectTitleAccent (glyphs.ts)
  //   underline — heading ROLE only (asTitle): a project that heads its own
  //               to-do group, never a plain project row
  let title = item.title;
  const resolved = item.status === "completed" || item.status === "canceled";
  if (item.status === "canceled") title = strike(title);
  if (resolved && opts.resolvedNormal !== true) title = dim(title);
  if (item.type === "project") title = projectTitleAccent(title);
  if (asTitle) title = underline(title);
  // GUI indicator order after the title: bell, document, checklist.
  const tail = [
    ...(item.type === "project" ? [countChip(item)] : []),
    ...(item.reminder !== null ? [dim(REMINDER_MARK)] : []),
    ...(item.notes !== "" ? [dim(NOTES_MARK)] : []),
    ...(item.type === "to-do" && item.checklistItemsCount > 0 ? [dim(CHECKLIST_MARK)] : []),
  ];
  return [
    `${dim(shownUuid)} `,
    box,
    ...meta,
    `${title}${tail.length > 0 ? ` ${tail.join(" ")}` : ""}${tags}${context === "" ? "" : dim(context)}${deadline}`,
  ].join(" ");
}

/**
 * Row prefix in today-aware views: yellow ★ for Today members, cyan ⏾ for
 * effective This-Evening members (raw evening assignment counts only while
 * startDate is exactly today — the UI's daily expiry), null otherwise.
 */
export function todayMark(item: ListItem, now?: Date): string | null {
  if (!isTodayMember(item, now)) return null;
  const evening = item.todaySection === "evening" && item.startDate === localToday(now);
  return evening ? eveningMoon() : todayStar();
}

/** Minimum displayed-prefix length: shorter prefixes collide across the DB. */
const UUID_DISPLAY_MIN = 8;

/**
 * Display width for a list's uuid column: the shortest prefix that is
 * unique WITHIN the list, floored at UUID_DISPLAY_MIN (list-local
 * uniqueness at 2–3 chars would still collide database-wide).
 */
export function uuidDisplayWidth(items: Array<{ uuid: string }>): number {
  if (items.length === 0) return UUID_DISPLAY_MIN;
  const sorted = items.map((i) => i.uuid).toSorted();
  let needed = 1;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1] ?? "";
    const b = sorted[i] ?? "";
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    needed = Math.max(needed, common + 1);
  }
  return Math.max(UUID_DISPLAY_MIN, needed);
}

/**
 * Fit a uuid into the shared id column: truncate to `width` when longer, pad
 * to it when shorter, so ids line up under one another regardless of prefix
 * length. `width` is the value from uuidDisplayWidth.
 */
export function uuidCol(uuid: string, width: number): string {
  return uuid.length > width ? uuid.slice(0, width) : uuid.padEnd(width);
}

export function renderList(items: ListItem[]): string[] {
  const w = uuidDisplayWidth(items);
  return items.length === 0 ? ["(empty)"] : items.map((i) => formatItem(i, w));
}

/**
 * The `things today` split. The membership glyph lives in the SECTION HEADER,
 * not on every row — a yellow ★ in the Today header (which also carries the
 * sidebar badge split) and a blue ⏾ in the This Evening header — so the rows
 * drop the redundant per-item marker (the same convention that suppresses a
 * `(project)` context inside that project's own view). Every OTHER view keeps
 * the per-row ★/⏾, where the marker still carries information.
 *
 * This Evening mirrors the GUI: it renders ONLY when evening items exist —
 * a truly-empty evening has no header at all. `full` is the pre-cap view and
 * `shown` the rows that survived the global `--limit`; the split lets the
 * section stay honest under truncation. When the cap hid some or all evening
 * rows, an honest muted hint counts the hidden ones and names the `--limit`
 * that reveals them — never the misleading `(empty)` a truncated evening used
 * to show. `base` is the user's own invocation (flags echoed). The global
 * footer (row driver) still reports the whole-view remainder separately.
 *
 * `options.eveningOnly` (the `--evening` section filter) renders ONLY the This
 * Evening block — the Today header and its `(empty)` placeholder are suppressed
 * because that section is deliberately filtered out, not merely empty.
 */
export function renderToday(
  full: TodayView,
  shown: TodayView,
  base: string,
  options?: { eveningOnly?: boolean },
): string[] {
  const w = uuidDisplayWidth([...shown.today, ...shown.evening]);
  const eveningOnly = options?.eveningOnly === true;
  const lines: string[] = eveningOnly
    ? []
    : [
        `${bold("──")} ${todayStar()} ${bold(`Today (badge: ${full.badge.dueOrOverdue} due/overdue · ${full.badge.other} other) ──`)}`,
        ...(shown.today.length === 0 ? ["(empty)"] : shown.today.map((i) => formatItem(i, w))),
      ];
  if (full.evening.length > 0) {
    lines.push(`${bold("──")} ${eveningMoon()} ${bold("This Evening ──")}`);
    for (const i of shown.evening) lines.push(formatItem(i, w));
    const hidden = full.evening.length - shown.evening.length;
    if (hidden > 0) {
      const total = full.today.length + full.evening.length;
      const more = shown.evening.length > 0 ? "more " : "";
      lines.push(
        dim(
          `… ${hidden} ${more}evening item${hidden === 1 ? "" : "s"} — \`${base} --limit ${total}\` · all: \`${base} --all\``,
        ),
      );
    }
  } else if (eveningOnly) {
    // Evening filter with no evening members: the section is genuinely empty
    // (nothing was filtered out here), so an honest `(empty)` is correct.
    lines.push("(empty)");
  }
  return lines;
}

/**
 * Search rows: a standard list row, plus — for a project surfaced by a HEADING
 * title match — a muted `(via heading "…")` suffix crediting the heading whose
 * text matched (the parent project row stands in for the heading; the GUI has
 * no bare heading row). Ordinary title/notes matches render as plain rows.
 */
export function renderSearch(items: ListItem[]): string[] {
  if (items.length === 0) return ["(empty)"];
  const w = uuidDisplayWidth(items);
  return items.map((i) => {
    const via = (i as { matchedVia?: { kind: "heading"; title: string } }).matchedVia;
    const row = formatItem(i, w);
    return via === undefined ? row : `${row} ${dim(`(via heading "${via.title}")`)}`;
  });
}

/** Hidden-later counts per sidebar group (null area = the loose block). */
export interface LaterHints {
  /** Sidebar-ordered, INCLUDING groups whose every project is later. */
  groups: Array<{ area: { uuid: string; title: string } | null; hidden: number }>;
}

/**
 * The sidebar mirror for `things projects`: loose projects first (the GUI
 * lists them above the areas), then a `── ⬡ Area ──` header per area with
 * its projects beneath (the redundant `(Area)` suffix suppressed). Items
 * arrive from projectsView already in sidebar order — this only inserts the
 * headers. Denser than renderSections on purpose: no title styling and no
 * blank line per project (every row here IS a project). With `hints`,
 * default-hidden later projects are never silent: each group trails a muted
 * `…n later projects` count (a later-only area still gets its header), and
 * the output ends with the flag that reveals them.
 */
export function renderProjectsSidebar(items: ListItem[], hints?: LaterHints): string[] {
  const total = hints?.groups.reduce((n, g) => n + g.hidden, 0) ?? 0;
  if (items.length === 0 && total === 0 && (hints === undefined || hints.groups.length === 0))
    return ["(empty)"];
  const w = uuidDisplayWidth(items);
  const byGroup = new Map<string | null, ListItem[]>();
  for (const item of items) {
    const key = item.area?.uuid ?? null;
    byGroup.set(key, [...(byGroup.get(key) ?? []), item]);
  }
  // hints (when present) carry the full sidebar group order, including
  // later-only groups the visible items can't reveal.
  const groups =
    hints?.groups ??
    [...byGroup.keys()].map((key) => ({
      area: key === null ? null : (items.find((i) => i.area?.uuid === key)?.area ?? null),
      hidden: 0,
    }));
  const lines: string[] = [];
  for (const group of groups) {
    const rows = byGroup.get(group.area?.uuid ?? null) ?? [];
    // The loose block only exists when it has content; areas mirror the
    // sidebar and render even when empty.
    if (group.area === null && rows.length === 0 && group.hidden === 0) continue;
    if (group.area !== null) {
      if (lines.length > 0) lines.push("");
      lines.push(`${bold("──")} ${areaMark()} ${bold(`${group.area.title} ──`)}`);
    }
    lines.push(
      ...rows.map((item) => formatItem(item, w, { suppressArea: group.area?.uuid ?? null })),
    );
    if (group.hidden > 0)
      lines.push(dim(`…${group.hidden} later project${group.hidden === 1 ? "" : "s"}`));
    else if (group.area !== null && rows.length === 0) lines.push(dim("(no projects)"));
  }
  if (total > 0)
    lines.push(
      "",
      dim(
        `(${total} later project${total === 1 ? "" : "s"} — visible with \`things projects --show-later\`)`,
      ),
    );
  return lines;
}

/**
 * Upcoming rows under GUI-style date headers (empty periods are simply
 * absent), with the trailing Repeating To-Dos section: templates with no
 * set next occurrence, carrying their waiting/paused/ended status word and
 * the bare ⚑ when the rule will assign a deadline per occurrence.
 *
 * Deadline-forecast rows (UPC1) keep startDate=null but carry a real future
 * deadline; they group under their DEADLINE date via COALESCE(startDate,
 * deadline) — no when-date pill (the header carries the date; formatItem's
 * chip keys on startDate, so a null-startDate row shows only the ⚑ deadline
 * flag, mirroring the GUI's bare-flag anatomy).
 */
export function renderUpcoming(items: ListItem[], now?: Date): string[] {
  if (items.length === 0) return ["(empty)"];
  const todayIso = localToday(now);
  const w = uuidDisplayWidth(items);
  const fmtOpts = now === undefined ? {} : { now };
  const groupDate = (i: ListItem): string | null =>
    i.startDate ?? (i.repeating.isTemplate ? null : i.deadline);
  const dated = items.filter((i) => groupDate(i) !== null);
  const resting = items.filter((i) => i.startDate === null && i.repeating.isTemplate);
  const lines: string[] = [];
  let openHeader: string | null = null;
  for (const item of dated) {
    const bucket = upcomingBucket(groupDate(item) ?? "", todayIso);
    if (bucket.label !== openHeader) {
      if (lines.length > 0) lines.push("");
      lines.push(bold(`── ${bucket.label} ──`));
      openHeader = bucket.label;
    }
    lines.push(formatItem(item, w, { ...fmtOpts, hideDateChip: bucket.isDay }));
  }
  if (resting.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(bold("── Repeating To-Dos ──"));
    for (const item of resting) {
      lines.push(
        formatItem(item, w, { ...fmtOpts, statusWord: templateStatus(item.repeating, todayIso) }),
      );
    }
  }
  return lines;
}

/**
 * Logbook rows under GUI-style date headings, month granularity throughout
 * — `── July ──` within the current year, `── March 2025 ──` beyond (finer
 * than the GUI's bare per-year buckets, deliberately). Truncation past the
 * row limit is reported by the shared hint the command appends, not here.
 * Resolved is the Logbook's NORM, so rows pass `resolvedNormal`: completed
 * titles render plain and canceled titles keep their strikethrough but drop
 * the dim (the blue `[✓]`/`[×]` marks and logged date are unchanged).
 */
export function renderLogbook(items: ListItem[], now?: Date): string[] {
  if (items.length === 0) return ["(empty)"];
  const w = uuidDisplayWidth(items);
  const currentYear = localToday(now).slice(0, 4);
  const lines: string[] = [];
  let openHeading: string | null = null;
  for (const item of items) {
    const s = item.stopped;
    const heading =
      s === null
        ? "no logged date"
        : `${FULL_MONTHS[s.getMonth()]}${String(s.getFullYear()) === currentYear ? "" : ` ${s.getFullYear()}`}`;
    if (heading !== openHeading) {
      if (lines.length > 0) lines.push("");
      lines.push(bold(`── ${heading} ──`));
      openHeading = heading;
    }
    // The Logbook's normal IS the resolved state — rows render plain
    // (completed) / strike-only (canceled), never dim (render-language delta 6).
    lines.push(
      formatItem(item, w, { resolvedNormal: true, ...(now === undefined ? {} : { now }) }),
    );
  }
  return lines;
}

/**
 * Sidebar-grouped views (anytime/someday), rendered the way the GUI reads:
 * the area-less block headerless first, then one `── <area> ──` header per
 * area; inside a section, loose to-dos first, then each project GROUP — a
 * blank line, the project's bold+underlined title row, then its members.
 * Container names implied by the grouping are not repeated on member rows
 * (an area header covers its rows; a project title row covers the to-dos
 * beneath it — a clustered child whose project row is absent, e.g. under a
 * tag filter, keeps its `(project)` suffix). `star` prefixes each item line
 * with the Today-membership mark (★, or ⏾ for This-Evening members).
 */
export function renderSections(sections: SidebarSection[], star = false): string[] {
  const all = sections.flatMap((s) => s.items);
  if (all.length === 0) return ["(empty)"];
  const w = uuidDisplayWidth(all);
  const lines: string[] = [];
  const blank = () => {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
  };
  for (const section of sections) {
    if (section.area !== null) {
      blank();
      lines.push(`${bold("──")} ${areaMark()} ${bold(`${section.area.title} ──`)}`);
    }
    // The uuid of the project whose title row is directly above (its member
    // rows drop their redundant `(project)` suffix).
    let openProject: string | null = null;
    for (const item of section.items) {
      const mark = star ? todayMark(item) : null;
      if (item.type === "project") {
        openProject = item.uuid;
        blank();
        lines.push(
          formatItem(item, w, {
            projectTitle: true,
            suppressArea: section.area?.uuid ?? null,
            mark,
          }),
        );
      } else {
        lines.push(
          formatItem(item, w, {
            suppressProject: openProject,
            suppressArea: section.area?.uuid ?? null,
            mark,
          }),
        );
      }
    }
  }
  return lines;
}

/** Single-quote a title for a copy-pasteable drill-down command. */
function quoteTitle(title: string): string {
  return `'${title.replace(/'/g, "'\\''")}'`;
}

const takeUpTo = <T>(items: T[], limit: number | null): T[] =>
  limit === null ? items : items.slice(0, limit);

/** Muted per-block truncation line: `… N more — \`drill-down\``. */
function blockMoreLine(total: number, shown: number, drill: string | null): string {
  return dim(`  … ${total - shown} more${drill === null ? "" : ` — \`${drill}\``}`);
}

/**
 * Type-aware variant for blocks that mix project rows and to-dos (someday's
 * loose/area blocks): the hidden remainder is split by type — `… 5 more
 * projects, 14 more to-dos` — omitting a type with nothing hidden and
 * pluralizing per count.
 */
function mixedMoreLine(hidden: ListItem[], drill: string | null): string {
  const projects = hidden.filter((i) => i.type === "project").length;
  const todos = hidden.length - projects;
  const parts = [
    ...(projects > 0 ? [`${projects} more project${projects === 1 ? "" : "s"}`] : []),
    ...(todos > 0 ? [`${todos} more to-do${todos === 1 ? "" : "s"}`] : []),
  ];
  return dim(`  … ${parts.join(", ")}${drill === null ? "" : ` — \`${drill}\``}`);
}

/**
 * Muted bottom line for a truncated grouped view: `── more per group — see
 * more: \`<base> <bigger flags>\` · all: \`<base> --all\` ──`, where the
 * bigger-flags command doubles exactly the caps that actually truncated.
 */
function groupedBottomLine(base: string, escalations: string[], allBase = base): string {
  const seeMore = escalations.length > 0 ? `see more: \`${base} ${escalations.join(" ")}\` · ` : "";
  return dim(`── more per group — ${seeMore}all: \`${allBase} --all\` ──`);
}

/**
 * The anytime preview: the FULL block skeleton — every area header and every
 * project row — always renders; `limits.area` caps the loose block and each
 * area's direct to-dos, `limits.project` each project's to-dos. A truncated
 * block trails a muted `… N more — \`things (project|area) show '…'\``
 * drill-down (the loose block has no container, so it shows only the count),
 * and the view ends with one line escalating the caps that hit. Today members
 * are starred. Mirrors renderSections' layout exactly.
 */
export function renderAnytimePreview(
  sections: SidebarSection[],
  limits: GroupedLimits,
  base: string,
): string[] {
  const all = sections.flatMap((s) => s.items);
  if (all.length === 0) return ["(empty)"];
  const w = uuidDisplayWidth(all);
  const lines: string[] = [];
  let areaHit = false;
  let projectHit = false;
  const blank = () => {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
  };
  for (const section of sections) {
    if (section.area !== null) {
      blank();
      lines.push(`${bold("──")} ${areaMark()} ${bold(`${section.area.title} ──`)}`);
    }
    const { direct, projects } = splitSectionBlocks(section);
    const suppressArea = section.area?.uuid ?? null;
    const shownDirect = takeUpTo(direct, limits.area);
    for (const item of shownDirect) {
      lines.push(formatItem(item, w, { suppressArea, mark: todayMark(item) }));
    }
    if (direct.length > shownDirect.length) {
      areaHit = true;
      const drill =
        section.area === null ? null : `things area show ${quoteTitle(section.area.title)}`;
      lines.push(blockMoreLine(direct.length, shownDirect.length, drill));
    }
    for (const { project, items: children } of projects) {
      blank();
      lines.push(
        formatItem(project, w, { projectTitle: true, suppressArea, mark: todayMark(project) }),
      );
      const shownChildren = takeUpTo(children, limits.project);
      for (const item of shownChildren) {
        lines.push(
          formatItem(item, w, {
            suppressProject: project.uuid,
            suppressArea,
            mark: todayMark(item),
          }),
        );
      }
      if (children.length > shownChildren.length) {
        projectHit = true;
        lines.push(
          blockMoreLine(
            children.length,
            shownChildren.length,
            `things project show ${quoteTitle(project.title)}`,
          ),
        );
      }
    }
  }
  if (areaHit || projectHit) {
    const escalations = [
      ...(areaHit && limits.area !== null ? [`--area-limit ${limits.area * 2}`] : []),
      ...(projectHit && limits.project !== null ? [`--project-limit ${limits.project * 2}`] : []),
    ];
    lines.push("", groupedBottomLine(base, escalations));
  }
  return lines;
}

/**
 * The someday preview, mirroring the GUI (side-by-side, 2026-07-12): inside
 * each group the project rows render as PLAIN items — `(~)` circle, count
 * chip, no header styling, no surrounding blank lines — listed before the
 * direct to-dos; `limits.area` caps each group's combined list. With
 * `showActive` (the --show-active-project-items toggle) the someday to-dos
 * living inside active projects append as a separate trailing
 * `── From active projects ──` section — a flat run of project-header blocks
 * (no area grouping), each capped at `limits.project` (null = every item).
 * When the toggle is off and such items exist, a muted bottom hint counts
 * them and names the flag.
 */
export function renderSomedayPreview(
  sections: SidebarSection[],
  limits: GroupedLimits,
  base: string,
  showActive: boolean,
  hiddenActiveItems: number,
): string[] {
  const all = sections.flatMap((s) => s.items);
  const lines: string[] = [];
  let areaHit = false;
  let projectHit = false;
  const blank = () => {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
  };
  if (all.length === 0) {
    lines.push("(empty)");
  } else {
    const w = uuidDisplayWidth(all);
    const trailing: Array<{ project: { uuid: string; title: string }; items: ListItem[] }> = [];
    for (const section of sections) {
      const { own, children } = partitionSomedaySection(section);
      trailing.push(...children);
      if (section.area !== null) {
        blank();
        lines.push(`${bold("──")} ${areaMark()} ${bold(`${section.area.title} ──`)}`);
      }
      const suppressArea = section.area?.uuid ?? null;
      const shownOwn = takeUpTo(own, limits.area);
      for (const item of shownOwn) lines.push(formatItem(item, w, { suppressArea }));
      if (own.length > shownOwn.length) {
        areaHit = true;
        const drill =
          section.area === null ? null : `things area show ${quoteTitle(section.area.title)}`;
        lines.push(mixedMoreLine(own.slice(shownOwn.length), drill));
      }
    }
    if (trailing.length > 0) {
      blank();
      lines.push(bold("── From active projects ──"));
      for (const group of trailing) {
        blank();
        lines.push(
          `${dim(uuidCol(group.project.uuid, w))}  ${underline(projectTitleAccent(group.project.title))}`,
        );
        const shown = takeUpTo(group.items, limits.project);
        for (const item of shown) {
          lines.push(formatItem(item, w, { suppressProject: group.project.uuid }));
        }
        if (group.items.length > shown.length) {
          projectHit = true;
          lines.push(
            blockMoreLine(
              group.items.length,
              shown.length,
              `things project show ${quoteTitle(group.project.title)}`,
            ),
          );
        }
      }
    }
  }
  if (areaHit || projectHit) {
    const escalations = [
      ...(areaHit && limits.area !== null ? [`--area-limit ${limits.area * 2}`] : []),
      ...(projectHit && limits.project !== null
        ? [`--show-active-project-items ${limits.project * 2}`]
        : []),
    ];
    // The bare flag keeps the active-projects section visible under --all.
    const allBase = showActive ? `${base} --show-active-project-items` : base;
    lines.push("", groupedBottomLine(base, escalations, allBase));
  }
  if (!showActive && hiddenActiveItems > 0) {
    blank();
    lines.push(
      dim(
        `(${hiddenActiveItems} someday to-do${hiddenActiveItems === 1 ? "" : "s"} inside active projects — visible with \`things someday --show-active-project-items\`)`,
      ),
    );
  }
  return lines;
}
