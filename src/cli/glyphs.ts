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
import { blue, bold, cyan, dim, yellow } from "./style.ts";

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
  if (item.start === "someday" && item.startDate === null) return dim("[~]");
  return "[ ]";
}

/**
 * Project circle — round where to-dos are square. `( )` nothing done yet,
 * quarter-quantized pie (◔ ◑ ◕) in progress, ◉ every child done but the
 * project itself still open, `(✓)`/`(×)` project completed/canceled, `(~)`
 * someday.
 */
export function projectCircle(item: Project): string {
  if (item.status === "completed") return blue("(✓)");
  if (item.status === "canceled") return blue("(×)");
  if (item.start === "someday" && item.startDate === null) return dim("(~)");
  const total = item.untrashedLeafActionsCount;
  const open = item.openUntrashedLeafActionsCount;
  if (total <= 0 || open >= total) return "( )";
  if (open <= 0) return blue("(◉)");
  const done = (total - open) / total;
  return blue(`(${done < 0.375 ? "◔" : done < 0.625 ? "◑" : "◕"})`);
}

/** The GUI's remaining-count chip on project rows: `‹12›`. */
export function countChip(item: Project): string {
  return dim(`‹${item.openUntrashedLeafActionsCount}›`);
}

/** Notes-present marker (the GUI's small document icon). */
export const NOTES_MARK = "≡";

/** Today star / This-Evening crescent, as row prefixes in today-aware views. */
export const todayStar = (): string => yellow("★");
export const eveningMoon = (): string => cyan("⏾");
