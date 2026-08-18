/**
 * The FIXED-recurrence DEFAULT-anchor law + the weekly-weekday derivation the
 * promote verbs use (issue #476; evidence: docs/lab/anch2-next-field.md +
 * anch1-repeat-anchor.md, golden-v2 / Things 3.22.12).
 *
 * DEFAULT LAW (ANCH1, still valid as the DEFAULT). Left untouched, the Repeat
 * dialog's "Next:" field defaults the first occurrence to the next calendar match
 * ON OR AFTER TODAY (interval-independent), and a weekday-less weekly rule
 * defaults to SUNDAY. ANCH2 then showed the "Next:" field is EDITABLE and honored
 * (docs/lab/anch2-next-field.md) — so the promote verbs DRIVE it with the item's
 * scheduled date rather than refuse a wrong-phase series. This module no longer
 * carries a phase-refusal (the ANCH1 `H-REPEAT-ANCHOR` premise — "no drivable
 * first-occurrence control" — was false).
 *
 * What it still provides:
 *  1. {@link deriveWeeklyWeekdays} — when a weekly rule omits `weekdays` but a
 *     concrete anchor date is known, derive the recurring weekday FROM that date
 *     so the series fires on the intended weekday (not the app's Sunday default).
 *     Driving "Next:" fixes the FIRST occurrence; this fixes the recurring day.
 *  2. {@link fixedSpawnPlan} — the DEFAULT spawn shape (used by the simulator
 *     when no explicit first occurrence is requested): first occurrence = next
 *     match ≥ today, an instance spawns only when today is itself an occurrence.
 *
 * Daily/weekly follow the probed default law; monthly/yearly keep the caller's
 * today+interval model for the default (their default-anchor law is unprobed).
 */
import { addDaysIso, type IsoDate } from "../model/dates.ts";
import type {
  MonthlyAnchor,
  RepeatRuleParams,
  Weekday,
  WeekdayOrdinal,
  YearlyAnchor,
} from "./operations.ts";
import { WD_TO_WEEKDAY, WEEKDAY_TO_WD } from "./repeat-rule.ts";

/** True iff `v` is a concrete `YYYY-MM-DD` date (not a list keyword / undefined). */
export function isIsoDate(v: unknown): v is IsoDate {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** Weekday of an ISO date, 0 = Sunday … 6 = Saturday (evaluated at UTC noon, tz-invariant). */
export function weekdayOfIso(iso: IsoDate): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/** Whole days from `a` to `b` (b − a); negative when b precedes a. */
function daysBetweenIso(a: IsoDate, b: IsoDate): number {
  const [ay, am, ad] = a.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = b.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** The smallest date on or after `todayIso` whose weekday is `wd` (0 = Sunday). */
function nextWeekdayOnOrAfter(todayIso: IsoDate, wd: number): IsoDate {
  const delta = (((wd - weekdayOfIso(todayIso)) % 7) + 7) % 7;
  return addDaysIso(todayIso, delta);
}

/** The Sunday that starts the week containing `iso` (the app's weeks start Sunday). */
function weekAnchorSunday(iso: IsoDate): IsoDate {
  return addDaysIso(iso, -weekdayOfIso(iso));
}

/** A true modulo (result always in [0, n)). */
function mod(x: number, n: number): number {
  return ((x % n) + n) % n;
}

/** The rule's effective weekday numbers (explicit set, else the app's Sunday default). */
function effectiveWds(rule: Pick<RepeatRuleParams, "weekdays">): number[] {
  return rule.weekdays !== undefined && rule.weekdays.length > 0
    ? rule.weekdays.map((w) => WEEKDAY_TO_WD[w])
    : [0];
}

/**
 * Whether `d` is on the active-week grid of a weekly rule anchored at `firstOcc`
 * (weeks fire every `interval` weeks from the anchor's Sunday-week). Weekday match
 * is checked separately.
 */
function weeklyActiveWeek(firstOcc: IsoDate, d: IsoDate, interval: number): boolean {
  const weeks = daysBetweenIso(weekAnchorSunday(firstOcc), weekAnchorSunday(d)) / 7;
  return mod(weeks, interval) === 0;
}

/**
 * When a WEEKLY rule omits its weekday set but a concrete anchor date is known,
 * the weekday to drive explicitly (so the series fires on the anchor date's
 * weekday, not the app's Sunday default). Returns `undefined` when nothing should
 * change (non-weekly, weekdays already given, or no concrete anchor date).
 */
export function deriveWeeklyWeekdays(
  rule: Pick<RepeatRuleParams, "frequency" | "interval" | "weekdays" | "afterCompletion">,
  anchorIso: IsoDate | null | undefined,
): Weekday[] | undefined {
  if (rule.afterCompletion === true) return undefined;
  if (rule.frequency !== "weekly") return undefined;
  if (rule.weekdays !== undefined) return undefined;
  if (!isIsoDate(anchorIso)) return undefined;
  return [WD_TO_WEEKDAY[weekdayOfIso(anchorIso)] as Weekday];
}

/** The 1-based day-of-month of an ISO date. */
function dayOfMonthIso(iso: IsoDate): number {
  return Number(iso.split("-")[2]);
}
/** The 1-based month of an ISO date. */
function monthOfIso(iso: IsoDate): number {
  return Number(iso.split("-")[1]);
}

/**
 * When a MONTHLY rule omits its day anchor but a concrete first-occurrence date
 * is known, the day-of-month anchor to drive EXPLICITLY (so the series recurs on
 * that day, not the Repeat dialog's untouched default). Returns `undefined` when
 * nothing should change (non-monthly, an explicit anchor already given, or no
 * concrete date). Mirrors {@link deriveWeeklyWeekdays} for the monthly unit —
 * the same day-of-month the read-path decoder / composeOffsets derives from the
 * occurrence date, so the derived anchor is byte-consistent with the rule blob.
 */
export function deriveMonthlyAnchor(
  rule: Pick<RepeatRuleParams, "frequency" | "monthly" | "afterCompletion">,
  anchorIso: IsoDate | null | undefined,
): MonthlyAnchor | undefined {
  if (rule.afterCompletion === true) return undefined;
  if (rule.frequency !== "monthly") return undefined;
  if (rule.monthly !== undefined) return undefined;
  if (!isIsoDate(anchorIso)) return undefined;
  return { day: dayOfMonthIso(anchorIso) };
}

/**
 * When a YEARLY rule omits its month+day anchor but a concrete first-occurrence
 * date is known, the {month, day} anchor to drive EXPLICITLY (so the series recurs
 * on that month/day, not the dialog's untouched January-1 default — the ANCH2-c /
 * issue #493 anchor-drop). Returns `undefined` when nothing should change
 * (non-yearly, an explicit anchor already given, or no concrete date).
 */
export function deriveYearlyAnchor(
  rule: Pick<RepeatRuleParams, "frequency" | "yearly" | "afterCompletion">,
  anchorIso: IsoDate | null | undefined,
): YearlyAnchor | undefined {
  if (rule.afterCompletion === true) return undefined;
  if (rule.frequency !== "yearly") return undefined;
  if (rule.yearly !== undefined) return undefined;
  if (!isIsoDate(anchorIso)) return undefined;
  return { month: monthOfIso(anchorIso), day: dayOfMonthIso(anchorIso) };
}

/**
 * The date to drive into the Repeat dialog's "Next:" field for a rule whose
 * `next` is the scheduled START (`--when`). A DEADLINED rule anchors on the
 * DEADLINE — the dialog's "Next:" is the next deadline and the instance START =
 * deadline − startDaysEarlier — so it is driven with `next + startDaysEarlier` and
 * the app back-shifts the start to `next` (YANCH1 #493, golden-v3 probe: Next
 * driven to a date with start-N lands the instance start N days earlier). A
 * non-deadlined rule (or one with no concrete `next`) drives `next` verbatim.
 * Returns `undefined` when `next` is absent/non-concrete.
 */
export function deadlineDriveNext(
  p: Pick<RepeatRuleParams, "next" | "deadline" | "startDaysEarlier">,
): IsoDate | undefined {
  if (!isIsoDate(p.next)) return undefined;
  const shift =
    p.deadline === true || (p.startDaysEarlier ?? 0) > 0 ? (p.startDaysEarlier ?? 0) : 0;
  return addDaysIso(p.next, shift);
}

/**
 * The calendar-anchor fields to drive EXPLICITLY for a fixed weekly/monthly/yearly
 * rule when the caller supplied a concrete first-occurrence date but NO explicit
 * anchor — each derived from that date by the SAME refIso law composeOffsets uses
 * (weekly → weekday, monthly → day-of-month, yearly → month+day). Driving the
 * anchor pop-ups makes the series RECUR on the intended calendar placement;
 * leaving the anchor to the "Next:" first-occurrence field alone fixes only the
 * FIRST occurrence and leaves the dialog's untouched default as the recurring rule
 * (weekly → Sunday, monthly → 1st, yearly → January 1 — ANCH2 cell c / issue
 * #493). Returns only the fields that need driving; an explicit anchor, an
 * after-completion rule, daily, or no concrete date yields an empty patch. This
 * completes the derive-and-drive family the weekly weekday-derivation began
 * post-ANCH1 (decisions.md).
 */
export function deriveFixedAnchor(
  rule: Pick<
    RepeatRuleParams,
    "frequency" | "interval" | "weekdays" | "monthly" | "yearly" | "afterCompletion"
  >,
  anchorIso: IsoDate | null | undefined,
): Partial<Pick<RepeatRuleParams, "weekdays" | "monthly" | "yearly">> {
  const weekdays = deriveWeeklyWeekdays(rule, anchorIso);
  const monthly = deriveMonthlyAnchor(rule, anchorIso);
  const yearly = deriveYearlyAnchor(rule, anchorIso);
  return {
    ...(weekdays !== undefined && { weekdays }),
    ...(monthly !== undefined && { monthly }),
    ...(yearly !== undefined && { yearly }),
  };
}

// ------------------------------------------------ off-rule first occurrence (DACON1)
//
// A concrete `--when` together with an EXPLICIT calendar anchor
// (weekdays/monthly/yearly) can DISAGREE — the first occurrence lands off the
// rule's grid. This is NOT an error by default: the Repeat dialog's "Next:" field
// accepts an off-schedule first occurrence, so the series appears on `--when` the
// first time and follows the anchor thereafter (e.g. `--weekdays wednesday --when
// <a thursday>` = Thursday first, Wednesdays after). In DEADLINE mode `--when` is
// the START and each occurrence is DUE `startDaysEarlier` days later; the anchor
// names the DUE date, so the off-rule test compares the anchor against
// `deadlineDriveNext` (= when + N, the deadline). `deriveFixedAnchor` covers the
// NO-explicit-anchor case (anchor derived from `--when`, never off-rule).
//
// EMPIRICAL boundary (docs/lab/dacon1-deadline-contradiction.md, golden-v3 /
// Things 3.22.14). The app HONORS an off-rule first for WEEKLY and YEARLY (cells
// DC1/DC5, DC3/DC4: the typed `--when` lands verbatim as the first instance start,
// the anchor drives the recurring grid). It does NOT for MONTHLY: the month row's
// "Next:" field SNAPS to the anchor day (cell DC2: Next 08-10 with a day-20 anchor
// committed 08-20, then the CLI's read-back rejected it, -2700). So an off-rule
// first is EXPRESSIBLE for weekly/yearly (allowed + disclosed) and INEXPRESSIBLE
// for monthly (fail-closed at validation rather than mid-drive).

/** Days in the calendar month containing `iso`. */
function daysInMonthOf(iso: IsoDate): number {
  const [y, m] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of month m+1 = last day of m
}

/** True iff `iso` is the last calendar day of its month. */
function isLastDayOfMonth(iso: IsoDate): boolean {
  return dayOfMonthIso(iso) === daysInMonthOf(iso);
}

/** Which occurrence (1-based) of its own weekday `iso` is within its month. */
function weekdayOrdinalInMonth(iso: IsoDate): number {
  return Math.floor((dayOfMonthIso(iso) - 1) / 7) + 1;
}

/** True iff `iso` is the LAST occurrence of its weekday in its month. */
function isLastWeekdayInMonth(iso: IsoDate): boolean {
  return dayOfMonthIso(iso) + 7 > daysInMonthOf(iso);
}

/** Whether date `iso` lands on the monthly/yearly day-or-nth-weekday `anchor`. */
function dateSatisfiesDayAnchor(iso: IsoDate, anchor: MonthlyAnchor): boolean {
  if ("day" in anchor) {
    return anchor.day === "last" ? isLastDayOfMonth(iso) : dayOfMonthIso(iso) === anchor.day;
  }
  if (WEEKDAY_TO_WD[anchor.weekday] !== weekdayOfIso(iso)) return false;
  return anchor.ordinal === "last"
    ? isLastWeekdayInMonth(iso)
    : weekdayOrdinalInMonth(iso) === anchor.ordinal;
}

/** "1st" | "2nd" | … | "5th" | "last" for an nth-weekday ordinal. */
function ordinalWord(ordinal: WeekdayOrdinal): string {
  if (ordinal === "last") return "last";
  return `${ordinal}${["th", "st", "nd", "rd", "th"][ordinal] ?? "th"}`;
}

/** Human phrase for a monthly/yearly day-or-nth-weekday anchor (surface copy). */
function describeDayAnchor(anchor: MonthlyAnchor): string {
  if ("day" in anchor)
    return anchor.day === "last" ? "the last day of the month" : `day ${anchor.day}`;
  return `the ${ordinalWord(anchor.ordinal)} ${anchor.weekday}`;
}

/** The effective deadline back-shift (days) for the given params, mirroring {@link deadlineDriveNext}. */
function anchorShiftDays(p: Pick<RepeatRuleParams, "deadline" | "startDaysEarlier">): number {
  return p.deadline === true || (p.startDaysEarlier ?? 0) > 0 ? (p.startDaysEarlier ?? 0) : 0;
}

/** Whether `driveIso` lands on the explicit anchor of these params (deadline-shift date already applied). */
function driveDateOnAnchor(
  p: Pick<AnchorParams, "frequency" | "weekdays" | "monthly" | "yearly">,
  driveIso: IsoDate,
): boolean {
  if (p.frequency === "weekly" && p.weekdays !== undefined && p.weekdays.length > 0) {
    return p.weekdays.includes(WD_TO_WEEKDAY[weekdayOfIso(driveIso)] as Weekday);
  }
  if (p.frequency === "monthly" && p.monthly !== undefined) {
    return dateSatisfiesDayAnchor(driveIso, p.monthly);
  }
  if (p.frequency === "yearly" && p.yearly !== undefined) {
    return monthOfIso(driveIso) === p.yearly.month && dateSatisfiesDayAnchor(driveIso, p.yearly);
  }
  return true; // no explicit anchor for this frequency ⇒ never off-rule (derived from --when)
}

/** The recurring-pattern phrase for the explicit anchor (the "thereafter" half of the disclosure). */
function describeRulePattern(
  p: Pick<AnchorParams, "frequency" | "weekdays" | "monthly" | "yearly">,
): string {
  if (p.frequency === "weekly" && p.weekdays !== undefined) {
    return `every ${p.weekdays.join(", ")}`;
  }
  if (p.frequency === "monthly" && p.monthly !== undefined) {
    return `monthly on ${describeDayAnchor(p.monthly)}`;
  }
  if (p.frequency === "yearly" && p.yearly !== undefined) {
    return `yearly in month ${p.yearly.month} on ${describeDayAnchor(p.yearly)}`;
  }
  return "the rule";
}

type AnchorParams = Pick<
  RepeatRuleParams,
  | "frequency"
  | "interval"
  | "weekdays"
  | "monthly"
  | "yearly"
  | "afterCompletion"
  | "deadline"
  | "startDaysEarlier"
  | "next"
>;

/** The disclosure of a HONORED off-rule first occurrence (both halves of the landed pattern). */
export interface OffRuleFirstDisclosure {
  /** The date the first occurrence APPEARS (the start = `--when`). */
  appearsIso: IsoDate;
  /** The first occurrence's DUE date (`--when + startDaysEarlier`), or null when not deadlined. */
  dueIso: IsoDate | null;
  /** Behavioral one-line summary of both halves (warning + echo copy). */
  message: string;
}

/**
 * Assess a rule request's off-rule-first status (DACON1). Returns:
 *  - `null` — no off-rule first (on-rule, no explicit anchor, no concrete `--when`,
 *    after-completion, or daily): nothing to disclose or refuse.
 *  - `{ kind: "honored", disclosure }` — the app honors this off-rule first
 *    (weekly/yearly): allow + disclose both halves of the landed pattern.
 *  - `{ kind: "dishonored", refusal }` — the app snaps/skips instead of honoring it
 *    (monthly): a behavioral fail-closed refusal naming the expressible alternatives.
 */
export type OffRuleFirstAssessment =
  | { kind: "honored"; disclosure: OffRuleFirstDisclosure }
  | { kind: "dishonored"; refusal: string };

export function assessOffRuleFirst(p: AnchorParams): OffRuleFirstAssessment | null {
  if (p.afterCompletion === true) return null;
  if (!isIsoDate(p.next)) return null;
  const driveIso = deadlineDriveNext(p);
  if (driveIso === undefined) return null;
  if (driveDateOnAnchor(p, driveIso)) return null; // on-rule — the common case

  const shift = anchorShiftDays(p);
  const dueIso = shift > 0 ? addDaysIso(p.next, shift) : null;
  const pattern = describeRulePattern(p);

  // MONTHLY off-rule first is INEXPRESSIBLE — the month row's "Next:" field snaps
  // to the anchor day (dacon1-deadline-contradiction.md cell DC2). Fail closed at
  // validation with the two nearest expressible alternatives.
  if (p.frequency === "monthly") {
    const onRuleHint =
      shift > 0
        ? `set --when so that --when + ${shift} lands on ${describeDayAnchor(p.monthly as MonthlyAnchor)}`
        : `set --when to a date on ${describeDayAnchor(p.monthly as MonthlyAnchor)}`;
    return {
      kind: "dishonored",
      refusal:
        `a monthly rule cannot start off its anchor: the Repeat dialog snaps the first ` +
        `occurrence to ${describeDayAnchor(p.monthly as MonthlyAnchor)}, so a first occurrence on ` +
        `${p.next} would not hold. Either ${onRuleHint}, or omit the monthly anchor to take it ` +
        `from --when.`,
    };
  }

  // WEEKLY / YEARLY off-rule first is HONORED — allow + disclose both halves.
  const dueClause = dueIso !== null ? `, due ${dueIso}` : "";
  const ongoing =
    dueIso !== null
      ? `thereafter: ${pattern}, appearing ${shift} day${shift === 1 ? "" : "s"} earlier`
      : `thereafter: ${pattern}`;
  return {
    kind: "honored",
    disclosure: {
      appearsIso: p.next,
      dueIso,
      message: `off-rule first occurrence — appears ${p.next}${dueClause}; ${ongoing}`,
    },
  };
}

/**
 * The app's first occurrence of a FIXED daily/weekly rule = the next calendar
 * match on or after today. `null` for after-completion (no calendar) or an
 * unguarded frequency (monthly/yearly). Weekly uses `weekdays` (caller should
 * pass the DERIVED set); with no weekdays it falls back to the app's Sunday default.
 */
export function fixedFirstOccurrence(
  rule: Pick<RepeatRuleParams, "frequency" | "interval" | "weekdays" | "afterCompletion">,
  todayIso: IsoDate,
): IsoDate | null {
  if (rule.afterCompletion === true) return null;
  if (rule.frequency === "daily") return todayIso; // every day is an occurrence
  if (rule.frequency === "weekly") {
    let best: IsoDate | null = null;
    for (const wd of effectiveWds(rule)) {
      const cand = nextWeekdayOnOrAfter(todayIso, wd);
      if (best === null || daysBetweenIso(cand, best) > 0) best = cand;
    }
    return best;
  }
  return null; // monthly/yearly: default anchor law unprobed — not guarded
}

/**
 * The smallest occurrence STRICTLY AFTER today (the template's cursor,
 * rt1_nextInstanceStartDate). Daily/weekly only. Returns `null` for other
 * frequencies / after-completion.
 */
export function nextFixedOccurrenceAfter(
  rule: Pick<RepeatRuleParams, "frequency" | "interval" | "weekdays" | "afterCompletion">,
  todayIso: IsoDate,
): IsoDate | null {
  if (rule.afterCompletion === true) return null;
  if (rule.frequency === "daily") return addDaysIso(todayIso, Math.max(1, rule.interval));
  if (rule.frequency === "weekly") {
    const first = fixedFirstOccurrence(rule, todayIso);
    if (first === null) return null;
    const wds = effectiveWds(rule);
    const interval = Math.max(1, rule.interval);
    let d = addDaysIso(todayIso, 1);
    for (let i = 0; i < (interval + 2) * 7; i++) {
      if (wds.includes(weekdayOfIso(d)) && weeklyActiveWeek(first, d, interval)) return d;
      d = addDaysIso(d, 1);
    }
    return first; // unreachable in practice
  }
  return null;
}

/**
 * The spawn shape a FIXED daily/weekly `make-repeating` produces under the ANCH1
 * law: the calendar-offset reference date, the current-occurrence instance start
 * (null when today is not an occurrence → no instance spawns), the template
 * cursor (next occurrence strictly after today), and the instance-creation count.
 * MONTHLY/YEARLY are unprobed — callers keep their prior today+interval model.
 */
export interface FixedSpawnPlan {
  refIso: IsoDate;
  instanceStartIso: IsoDate | null;
  cursorIso: IsoDate;
  instanceCount: 0 | 1;
}

export function fixedSpawnPlan(
  rule: Pick<RepeatRuleParams, "frequency" | "interval" | "weekdays" | "afterCompletion">,
  todayIso: IsoDate,
): FixedSpawnPlan {
  const first = fixedFirstOccurrence(rule, todayIso);
  if (first === null) {
    // Not a guarded frequency — degenerate plan (caller handles monthly/yearly).
    return { refIso: todayIso, instanceStartIso: todayIso, cursorIso: todayIso, instanceCount: 1 };
  }
  const isToday = first === todayIso;
  const cursor = isToday ? (nextFixedOccurrenceAfter(rule, todayIso) ?? first) : first;
  return {
    refIso: first,
    instanceStartIso: isToday ? todayIso : null,
    cursorIso: cursor,
    instanceCount: isToday ? 1 : 0,
  };
}
