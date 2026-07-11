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
import { blue, bold, brightBlue, dim, green, red, yellow } from "./style.ts";

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

/** `Jul 31` — the year is appended only when it differs from today's. */
export function shortDate(iso: string, todayIso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const label = `${MONTHS[(m ?? 1) - 1]} ${d}`;
  return String(y) === todayIso.slice(0, 4) ? label : `${label} ${y}`;
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
  // Repeating templates read as scheduled (↻ + next-occurrence chip carry
  // the state), never as someday, even though the DB stores start=someday.
  if (item.repeating.isTemplate) return "[ ]";
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
  if (item.start === "someday" && item.startDate === null) return dim("(~)");
  return "( )";
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

/** Uncapped relative phrasing: `today`, `3 days left`, `253 days ago`. */
export function relativeDays(iso: string, todayIso: string): string {
  const diff = daysBetween(todayIso, iso);
  if (diff === 0) return "today";
  return diff > 0
    ? `${diff} day${diff === 1 ? "" : "s"} left`
    : `${-diff} day${diff === -1 ? "" : "s"} ago`;
}

/**
 * Detail-card deadline line value (the GUI's "Deadline: Oct 30, 2025 —
 * 253 days ago" row): exact date plus uncapped relative phrasing. Bold red
 * once due; bold dim while upcoming.
 */
export function deadlineDetail(deadlineIso: string, todayIso: string): string {
  const text = `⚑ ${shortDate(deadlineIso, todayIso)} (${relativeDays(deadlineIso, todayIso)})`;
  return daysBetween(todayIso, deadlineIso) <= 0 ? bold(red(text)) : bold(dim(text));
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
