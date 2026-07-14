/**
 * The CLI's glyph language — the terminal analogue of the GUI's checkbox
 * iconography. Shape carries state so plain output (piped, NO_COLOR) stays
 * unambiguous; color, dim, and strike are enhancements on top. Alignment-
 * critical columns stay pure ASCII (`[ ]` / `( )`); the marks inside are
 * narrow-safe Unicode. The pie quarters and ★/⏾/◆ are ambiguous-width
 * codepoints — fine on macOS font stacks, the only place Things runs.
 * Every glyph lives here so a cross-terminal rendering audit
 * (docs/roadmap.md) can retune the language in one file.
 */
import type { Project, Todo } from "../model/entities.ts";
import { blue, bold, brightBlue, dim, green, red, strike, underline, yellow } from "./style.ts";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** `Jul 31` — the year is appended only when it differs from today's. */
export function shortDate(iso: string, todayIso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const label = `${MONTHS[(m ?? 1) - 1]} ${d}`;
  return String(y) === todayIso.slice(0, 4) ? label : `${label} ${y}`;
}

/**
 * `Fri, Aug 28` — the GUI's detail-header date form: weekday abbreviation +
 * month + day, the year appended only when it differs from today's (same
 * convention as {@link shortDate} / the ‹date› chip).
 */
export function weekdayDate(iso: string, todayIso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay()];
  return `${weekday}, ${shortDate(iso, todayIso)}`;
}

/** The GUI's grey schedule pill: `‹Jul 31›` on future-scheduled rows. */
export function dateChip(iso: string, todayIso: string): string {
  return dim(`‹${shortDate(iso, todayIso)}›`);
}

/** Completion date on logged rows (the GUI's blue date before the title). */
export function loggedDate(stopped: Date, todayIso: string): string {
  const iso = `${stopped.getFullYear()}-${String(stopped.getMonth() + 1).padStart(2, "0")}-${String(stopped.getDate()).padStart(2, "0")}`;
  return bold(blue(shortDate(iso, todayIso)));
}

/**
 * To-do checkbox: `[ ]` open, `[✓]` completed, `[×]` canceled, `[~]`
 * someday (undated — a dated someday row reads as scheduled and keeps the
 * plain box; its date chip carries the state).
 */
export function todoBox(item: Todo): string {
  if (item.status === "completed") return blue("[✓]");
  if (item.status === "canceled") return blue("[×]");
  // A repeating TEMPLATE is the rule itself, not a checkable instance — the
  // GUI shows only the ↻ glyph where a checkbox would be. We keep the
  // brackets (still a to-do) but seat ↻ INSIDE them so the row reads as
  // "the recurring one" at a glance, distinct from its spawned instances
  // (which are ordinary [ ] rows). Never someday, though the DB stores it so.
  // The box stays PLAIN — the GUI's repeat pseudo-checkbox is white, and the ↻
  // inside already marks the rule row (no muting).
  if (item.repeating.isTemplate) return "[↻]";
  if (item.start === "someday" && item.startDate === null) return dim("[~]");
  return "[ ]";
}

/**
 * Project circle — round where to-dos are square, same marks: `( )` open,
 * `(✓)` completed, `(×)` canceled, `(~)` someday. (The pie-fill progress
 * glyphs were tried and dropped — they render inconsistently at cell size;
 * progress lives in the ratio chip instead.)
 */
export function projectCircle(item: Project): string {
  if (item.status === "completed") return blue("(✓)");
  if (item.status === "canceled") return blue("(×)");
  // Repeating project template: ↻ inside the circle. A template is still a
  // project, so its circle keeps the blue accent — the GUI shows a solid blue
  // circle with the arrow, not a muted glyph.
  if (item.repeating.isTemplate) return blue("(↻)");
  // Someday projects are muted like someday to-dos — the GUI greys a someday
  // project the same way. Its type is still carried by the round bracket and
  // the bold title (projectTitleAccent), so the circle spends dim, not blue.
  if (item.start === "someday" && item.startDate === null) return dim("(~)");
  // Open projects render blue — GUI parity (the sidebar/list accent) and a
  // second, color-independent cue on top of the round bracket that this row
  // is a project, not a to-do.
  return blue("( )");
}

/**
 * THE SINGLE LAW for project-title WEIGHT and COLOR in list rows (ratified
 * 2026-07-13, docs/design/render-language.md).
 *
 * Project titles are BOLD and DEFAULT-colored (white) in every view and every
 * state. The round bracket plus this bold weight already carry "this row is a
 * project", so the row never spends the blue channel (reserved for the project
 * checkbox accent and the completed/canceled marks) merely restating its own
 * type. Every project-title call site routes through here — formatItem and the
 * hand-built project-header lines — so reverting to blue (or bold-blue) is a
 * one-line change to this function, nowhere else.
 */
export function projectTitleAccent(title: string): string {
  return bold(title);
}

/** Progress chip on project rows: `‹remaining/total›` (the GUI shows only the remaining count). */
export function countChip(item: Project): string {
  const total = item.untrashedLeafActionsCount;
  return dim(total === 0 ? "‹0›" : `‹${item.openUntrashedLeafActionsCount}/${total}›`);
}

/** Area marker (the GUI's green cube icon; a hexagon is a cube's silhouette). */
export const areaMark = (): string => green("⬡");

/** Whole-day difference between two ISO dates (positive = `to` is later). */
function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  return Math.round(
    (Date.UTC(ty ?? 0, (tm ?? 1) - 1, td ?? 1) - Date.UTC(fy ?? 0, (fm ?? 1) - 1, fd ?? 1)) /
      86_400_000,
  );
}

/**
 * Uncapped relative phrasing for the detail-card deadline hint, GUI wording:
 * `due today`, `46 days left`, `3 days overdue`.
 */
function deadlineRelative(iso: string, todayIso: string): string {
  const diff = daysBetween(todayIso, iso);
  if (diff === 0) return "due today";
  return diff > 0
    ? `${diff} day${diff === 1 ? "" : "s"} left`
    : `${-diff} day${diff === -1 ? "" : "s"} overdue`;
}

/**
 * Detail-card deadline line value (to-do / project / area cards). GUI parity:
 * the full `Fri, Aug 28` weekday date (year appended when not the current
 * year), then a muted relative hint — `(46 days left)` / `(due today)` /
 * `(3 days overdue)`. The date is bold red once due or overdue, bold otherwise;
 * the hint is always muted. LIST rows keep the compact {@link deadlineToken}.
 */
export function deadlineDetail(deadlineIso: string, todayIso: string): string {
  const date = weekdayDate(deadlineIso, todayIso);
  const styledDate = daysBetween(todayIso, deadlineIso) <= 0 ? bold(red(date)) : bold(date);
  return `${styledDate} ${dim(`(${deadlineRelative(deadlineIso, todayIso)})`)}`;
}

/** The share link the GUI's context menu copies — pasteable back into any ref argument. */
export function thingsLink(uuid: string): string {
  return dim(`things:///show?id=${uuid}`);
}

/**
 * The detail card's "when" value, GUI semantics: any past or current
 * schedule collapses to Today / This Evening (the data model keeps the real
 * date; the card does not), future dates show the date, undated someday
 * shows Someday. Appends the reminder time (clock glyph) when set.
 */
export function whenValue(
  item: Pick<Todo | Project, "startDate" | "todaySection" | "start" | "reminder">,
  todayIso: string,
): string | null {
  let label: string | null = null;
  if (item.startDate !== null) {
    label =
      item.startDate <= todayIso
        ? item.todaySection === "evening"
          ? `${eveningMoon()} This Evening`
          : `${todayStar()} Today`
        : shortDate(item.startDate, todayIso);
  } else if (item.start === "someday") {
    label = "Someday";
  }
  if (label === null) return null;
  return item.reminder === null ? label : `${label} ${dim(REMINDER_MARK)} ${item.reminder}`;
}

/**
 * Deadline token, mirroring the GUI's flag chip: relative phrasing near the
 * deadline (`⚑ 3 days left` up to 14 days out; `⚑ 4 days ago` up to 59 days
 * past; `⚑ today` on the day), then the date shorthand — `Sep 16` within
 * the current year, `Feb 2027` beyond it. Overdue and due-today render
 * bold red; upcoming renders bold dim (the GUI's gray).
 */
export function deadlineToken(deadlineIso: string, todayIso: string): string {
  const diff = daysBetween(todayIso, deadlineIso);
  let label: string;
  if (diff === 0) label = "today";
  else if (diff > 0 && diff <= 14) label = `${diff} day${diff === 1 ? "" : "s"} left`;
  else if (diff < 0 && diff >= -59) label = `${-diff} day${diff === -1 ? "" : "s"} ago`;
  else {
    const [y, m, d] = deadlineIso.split("-").map(Number);
    const month = MONTHS[(m ?? 1) - 1];
    label = String(y) === todayIso.slice(0, 4) ? `${month} ${d}` : `${month} ${y}`;
  }
  const chip = `⚑ ${label}`;
  return diff <= 0 ? bold(red(chip)) : bold(dim(chip));
}

/** Notes-present marker (the GUI's small document icon). */
export const NOTES_MARK = "≡";

/**
 * Reminder-set marker (the GUI's small bell icon; no Unicode bell renders
 * well — the clock-face quadrant won Mike's font test, accepted despite its
 * family resemblance to the project pies).
 */
export const REMINDER_MARK = "◷";

/** Checklist-present marker (the GUI's small list icon). */
export const CHECKLIST_MARK = "≔";

/** Today star / This-Evening crescent, rendered after the box in today-aware views. */
export const todayStar = (): string => yellow("★");
export const eveningMoon = (): string => brightBlue("⏾");

/** The sections the legend groups its entries under, in render order. */
export type LegendGroup =
  | "To-dos"
  | "Projects"
  | "Markers & chips"
  | "Colors & styles"
  | "Sections & hints";

export const LEGEND_GROUPS: readonly LegendGroup[] = [
  "To-dos",
  "Projects",
  "Markers & chips",
  "Colors & styles",
  "Sections & hints",
] as const;

/** One legend row: a sample of the glyph as it renders, and what it means. */
export interface LegendEntry {
  /** The glyph styled exactly as it renders in a list (color on a TTY). */
  glyph: string;
  meaning: string;
  group: LegendGroup;
}

/**
 * The rendered visual language, derived from the glyph helpers above so it
 * documents what actually renders — never a hand-kept copy that can drift.
 * Each `glyph` is a real sample built from the same styling the list rows use;
 * `things legend` groups these for humans and `--json` emits them ANSI-stripped.
 */
export const LEGEND: readonly LegendEntry[] = [
  // To-dos — the [ ]-family box carries state with color stripped.
  { glyph: "[ ]", meaning: "to-do, open", group: "To-dos" },
  { glyph: blue("[✓]"), meaning: "to-do, completed", group: "To-dos" },
  { glyph: blue("[×]"), meaning: "to-do, canceled (title struck through)", group: "To-dos" },
  { glyph: dim("[~]"), meaning: "to-do, someday (undated)", group: "To-dos" },
  {
    glyph: "[↻]",
    meaning: "repeating to-do — the rule itself (instances are ordinary [ ])",
    group: "To-dos",
  },
  // Projects — round where to-dos are square; open rows render blue.
  { glyph: blue("( )"), meaning: "project, open", group: "Projects" },
  { glyph: blue("(✓)"), meaning: "project, completed", group: "Projects" },
  { glyph: blue("(×)"), meaning: "project, canceled", group: "Projects" },
  { glyph: dim("(~)"), meaning: "project, someday (undated)", group: "Projects" },
  {
    glyph: blue("(↻)"),
    meaning: "repeating project — the recurring rule itself",
    group: "Projects",
  },
  {
    glyph: dim("‹2/5›"),
    meaning: "project progress: remaining/total to-dos (‹0› when it has none)",
    group: "Projects",
  },
  // Markers & chips — trail the title (bell, notes, checklist) or precede it.
  { glyph: todayStar(), meaning: "Today member", group: "Markers & chips" },
  { glyph: eveningMoon(), meaning: "This Evening member", group: "Markers & chips" },
  {
    glyph: bold(dim("⚑")),
    meaning: "deadline — bold gray while upcoming, bold red once due or overdue",
    group: "Markers & chips",
  },
  { glyph: dim(NOTES_MARK), meaning: "has notes", group: "Markers & chips" },
  { glyph: dim(REMINDER_MARK), meaning: "has a reminder time", group: "Markers & chips" },
  { glyph: dim(CHECKLIST_MARK), meaning: "has a checklist", group: "Markers & chips" },
  { glyph: areaMark(), meaning: "area", group: "Markers & chips" },
  {
    glyph: dim("‹Jul 31›"),
    meaning: "scheduled date, or ‹waiting›/‹paused›/‹ended› on a repeat template",
    group: "Markers & chips",
  },
  {
    glyph: green("#tag"),
    meaning: "tag — muted on list rows, green on the opened item",
    group: "Markers & chips",
  },
  // Colors & styles — enhancements on top of the shape; never the only cue.
  {
    glyph: dim("a1b2c3d4"),
    meaning: "item id prefix (8+ chars; full id in --json) — pass to any command",
    group: "Colors & styles",
  },
  {
    glyph: dim("dim text"),
    meaning: "later, hidden, inactive, or a resolved row out of place",
    group: "Colors & styles",
  },
  {
    glyph: strike("struck"),
    meaning: "canceled item title (kept even in the Logbook)",
    group: "Colors & styles",
  },
  {
    glyph: blue("blue"),
    meaning: "project checkbox accent, and the completed/canceled ✓ × marks",
    group: "Colors & styles",
  },
  {
    glyph: bold("bold"),
    meaning: "project title — every row, every state",
    group: "Colors & styles",
  },
  {
    glyph: bold(underline("bold underline")),
    meaning: "heading — a project heading its to-dos, or a section header",
    group: "Colors & styles",
  },
  // Sections & hints — structure and the never-silent truncation notices.
  {
    glyph: bold("──"),
    meaning: "section divider (area, Upcoming date bucket, Logbook month heading)",
    group: "Sections & hints",
  },
  {
    glyph: dim("… 14 more"),
    meaning: "a block was truncated; a drill-down command follows",
    group: "Sections & hints",
  },
  {
    glyph: dim("(23 later — --show-later)"),
    meaning: "default-hidden rows, and the flag that reveals them",
    group: "Sections & hints",
  },
] as const;
