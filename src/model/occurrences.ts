/**
 * Occurrence generator for decoded repeat rules — pure host math, READ-ONLY
 * (nothing here ever touches the app; projections are for display).
 *
 * Generation is anchored on an APP-MATERIALIZED occurrence event date (from
 * rt1_nextInstanceStartDate, back-shifted by the rule's ts offset), so the
 * first generated date always agrees with the app; later dates extrapolate
 * the decoded rule (validated against a 91-rule live corpus for decoding;
 * projection semantics follow the calendar conventions below).
 *
 * FIXED rules only: after-completion rules have no future dates until the
 * prior instance resolves — asking for their projection throws.
 *
 * Calendar conventions (assumptions, documented — the app materializes only
 * one instance ahead, so multi-step projections cannot be lab-oracled):
 *  - "day 31" in a shorter month CLAMPS to the month's last day;
 *  - Feb 29 yearly rules clamp to Feb 28 off leap years;
 *  - a missing "5th <weekday>" month is SKIPPED (no such date exists);
 *  - weekly cohorts are Sunday-based (wd 0 = Sunday in the rule encoding).
 */
import type { IsoDate } from "./dates.ts";
import type { RepeatOffset, RepeatRule } from "./recurrence.ts";

export interface OccurrenceWindow {
  /** Maximum occurrences to return (≥ 1). */
  count: number;
  /** Inclusive upper bound on event dates. */
  until?: IsoDate;
}

/** Hard cap on calendar cells examined — a runaway-rule backstop. */
const MAX_ITERATIONS = 1000;

// ------------------------------------------------------------ date helpers
// UTC-midnight arithmetic: IsoDate ↔ epoch days, no timezone hazards.

function toUtc(iso: IsoDate): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function toIso(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: IsoDate, days: number): IsoDate {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

function weekdayOf(iso: IsoDate): number {
  return toUtc(iso).getUTCDay(); // 0 = Sunday, matching the rule encoding
}

function lastDayOfMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function isoFor(year: number, month1: number, day: number): IsoDate {
  return `${String(year).padStart(4, "0")}-${String(month1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Resolve a monthly/yearly day offset within a month; null = no such date. */
function dayInMonth(year: number, month1: number, offset: RepeatOffset): IsoDate | null {
  const last = lastDayOfMonth(year, month1);
  if (offset.weekday !== undefined) {
    // nth weekday (weekdayOrdinal 1..5, -1 = last)
    const ordinal = offset.weekdayOrdinal ?? 1;
    if (ordinal === -1) {
      for (let day = last; day >= last - 6; day--) {
        const iso = isoFor(year, month1, day);
        if (weekdayOf(iso) === offset.weekday) return iso;
      }
      return null;
    }
    const firstWeekday = weekdayOf(isoFor(year, month1, 1));
    const day = 1 + ((offset.weekday - firstWeekday + 7) % 7) + (ordinal - 1) * 7;
    return day <= last ? isoFor(year, month1, day) : null; // missing 5th → skip
  }
  const day = offset.day ?? 1;
  if (day === -1) return isoFor(year, month1, last);
  return isoFor(year, month1, Math.min(day, last)); // clamp (see header)
}

// ------------------------------------------------------------- generation

/**
 * Event dates of a FIXED rule from `anchor` (an app-materialized event date,
 * INCLUDED as the first result), honoring the rule's endDate/remainingCount
 * bounds and the window's count/until. Throws on after-completion rules.
 */
export function generateEventDates(
  rule: RepeatRule,
  anchor: IsoDate,
  window: OccurrenceWindow,
): IsoDate[] {
  if (rule.type !== "fixed") {
    throw new RangeError(
      "after-completion rules cannot be projected — the next date depends on when the " +
        "prior instance resolves",
    );
  }
  // remainingCount counts occurrences the rule will still produce; the
  // anchor is the first of them.
  const cap = Math.min(
    Math.max(1, window.count),
    rule.remainingCount === null ? Number.POSITIVE_INFINITY : rule.remainingCount,
  );
  const inBounds = (iso: IsoDate): boolean =>
    (window.until === undefined || iso <= window.until) &&
    (rule.endDate === null || iso <= rule.endDate);

  // Every unit generates in ascending date order, so the first out-of-bounds
  // date terminates the walk. Returns "keep generating".
  const out: IsoDate[] = [];
  const push = (iso: IsoDate): boolean => {
    if (iso < anchor) return true; // pre-anchor cell (same week/month) — skip
    if (!inBounds(iso)) return false; // past until/endDate — done
    if (out.at(-1) !== iso) out.push(iso);
    return out.length < cap;
  };

  switch (rule.unit) {
    case "daily": {
      let date = anchor;
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (!push(date)) break;
        date = addDays(date, rule.interval);
      }
      break;
    }
    case "weekly": {
      const weekdays = [
        ...new Set(
          rule.offsets
            .map((o) => o.weekday)
            .filter((w): w is number => w !== undefined)
            .toSorted((a, b) => a - b),
        ),
      ];
      const days = weekdays.length > 0 ? weekdays : [weekdayOf(anchor)];
      const cohortStart = addDays(anchor, -weekdayOf(anchor)); // Sunday of the anchor's week
      outer: for (let week = 0; week < MAX_ITERATIONS; week++) {
        const weekStart = addDays(cohortStart, week * rule.interval * 7);
        for (const wd of days) {
          if (!push(addDays(weekStart, wd))) break outer;
        }
      }
      break;
    }
    case "monthly": {
      const offsets =
        rule.offsets.length > 0
          ? rule.offsets
          : [{ day: Number(anchor.slice(8, 10)) } satisfies RepeatOffset];
      const anchorYear = Number(anchor.slice(0, 4));
      const anchorMonth = Number(anchor.slice(5, 7));
      outer: for (let step = 0; step < MAX_ITERATIONS; step++) {
        const monthIndex = anchorMonth - 1 + step * rule.interval;
        const year = anchorYear + Math.floor(monthIndex / 12);
        const month1 = (monthIndex % 12) + 1;
        const dates = offsets
          .map((o) => dayInMonth(year, month1, o))
          .filter((d): d is IsoDate => d !== null)
          .toSorted();
        for (const date of dates) {
          if (!push(date)) break outer;
        }
      }
      break;
    }
    case "yearly": {
      const offsets =
        rule.offsets.length > 0
          ? rule.offsets
          : [
              {
                month: Number(anchor.slice(5, 7)),
                day: Number(anchor.slice(8, 10)),
              } satisfies RepeatOffset,
            ];
      const anchorYear = Number(anchor.slice(0, 4));
      outer: for (let step = 0; step < MAX_ITERATIONS; step++) {
        const year = anchorYear + step * rule.interval;
        const dates = offsets
          .map((o) => dayInMonth(year, o.month ?? Number(anchor.slice(5, 7)), o))
          .filter((d): d is IsoDate => d !== null)
          .toSorted();
        for (const date of dates) {
          if (!push(date)) break outer;
        }
      }
      break;
    }
  }
  return out;
}

/** One projected occurrence in instance terms (start/deadline split by ts). */
export interface ProjectedOccurrence {
  startDate: IsoDate;
  deadline: IsoDate | null;
}

/**
 * Project a template's next occurrences in INSTANCE terms. The anchor is the
 * app-materialized next instance START date (rt1_nextInstanceStartDate);
 * the rule's ts offset splits each event into startDate/deadline exactly as
 * the app does when spawning (deadline = start − ts, validated live).
 */
export function projectOccurrences(
  rule: RepeatRule,
  nextInstanceStartDate: IsoDate,
  window: OccurrenceWindow,
): ProjectedOccurrence[] {
  const anchorEvent = addDays(nextInstanceStartDate, -rule.startOffsetDays);
  return generateEventDates(rule, anchorEvent, window).map((event) => ({
    startDate: addDays(event, rule.startOffsetDays),
    deadline: rule.startOffsetDays < 0 ? event : null,
  }));
}
