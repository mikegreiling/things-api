/**
 * The full Repeat-dialog rule vocabulary: validation of the extended
 * `RepeatRuleParams` (UIC1 field map) and the decode-rule → inverse-params
 * mapping the reschedule undo rides. Kept separate from commands.ts so the
 * combination matrix is unit-testable in isolation and so the reversibility
 * inverse and the forward validator share ONE source of the weekday/offset
 * conventions.
 *
 * Refusals are behavioral (surface-copy rule 1/3): they name the field and the
 * frequency it belongs to, never a mechanism. The month anchor is a
 * DISCRIMINATED shape (day-of-month OR nth-weekday) — a bag that can hold both
 * a `day` and a `weekday` is refused rather than silently resolved.
 */
import type { IsoDate } from "../model/dates.ts";
import type { RepeatOffset, RepeatRule } from "../model/recurrence.ts";
import {
  WEEKDAYS,
  type MonthlyAnchor,
  type RepeatEnds,
  type RepeatFrequency,
  type RepeatRuleParams,
  type Weekday,
  type WeekdayOrdinal,
  type YearlyAnchor,
} from "./operations.ts";

const FREQUENCIES: readonly RepeatFrequency[] = ["daily", "weekly", "monthly", "yearly"];

/** Weekday name → rule encoding (wd 0 = Sunday). */
export const WEEKDAY_TO_WD: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Rule encoding (wd 0..6) → weekday name. */
export const WD_TO_WEEKDAY: Record<number, Weekday> = Object.fromEntries(
  (Object.entries(WEEKDAY_TO_WD) as [Weekday, number][]).map(([name, wd]) => [wd, name]),
) as Record<number, Weekday>;

// --------------------------------------------------------------- validation

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function assertOrdinal(ordinal: unknown, where: string): asserts ordinal is WeekdayOrdinal {
  if (ordinal === "last") return;
  if (!Number.isInteger(ordinal) || (ordinal as number) < 1 || (ordinal as number) > 5) {
    throw new RangeError(
      `invalid ${where} ordinal ${JSON.stringify(ordinal)} — expected 1–5 or "last"`,
    );
  }
}

function assertWeekday(day: unknown, where: string): asserts day is Weekday {
  if (typeof day !== "string" || !WEEKDAYS.includes(day as Weekday)) {
    throw new RangeError(
      `invalid ${where} weekday ${JSON.stringify(day)} — expected ${WEEKDAYS.join(" | ")}`,
    );
  }
}

/** Validate a month/year day anchor (shared by monthly + yearly). */
function assertMonthlyAnchor(anchor: unknown, where: string): void {
  if (!isRecord(anchor)) {
    throw new RangeError(`${where} must be a day-of-month or nth-weekday anchor`);
  }
  const hasDay = "day" in anchor;
  const hasWeekday = "weekday" in anchor || "ordinal" in anchor;
  if (hasDay && hasWeekday) {
    throw new RangeError(
      `${where} names both a day-of-month and a weekday — choose one (a day, OR a weekday + ordinal)`,
    );
  }
  if (hasDay) {
    const day = anchor["day"];
    if (day === "last") return;
    if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 31) {
      throw new RangeError(`invalid ${where} day ${JSON.stringify(day)} — expected 1–31 or "last"`);
    }
    return;
  }
  if (hasWeekday) {
    assertWeekday(anchor["weekday"], where);
    assertOrdinal(anchor["ordinal"], where);
    return;
  }
  throw new RangeError(`${where} must name a day-of-month or a weekday + ordinal`);
}

function assertEnds(ends: RepeatEnds): void {
  switch (ends.kind) {
    case "never":
      return;
    case "on-date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ends.date)) {
        throw new RangeError(
          `invalid ends date ${JSON.stringify(ends.date)} — expected YYYY-MM-DD`,
        );
      }
      return;
    case "after":
      if (!Number.isInteger(ends.count) || ends.count < 1 || ends.count > 999) {
        throw new RangeError(`invalid ends count ${ends.count} — expected an integer 1–999`);
      }
      return;
    default: {
      const exhaustive: never = ends;
      throw new RangeError(`unknown ends bound ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Validate the full extended rule vocabulary. The base `{ frequency, interval }`
 * is always checked; every optional field is checked and REFUSED when it does
 * not apply to the chosen frequency (or contradicts another field). Throws a
 * RangeError with a behavioral message on any violation.
 */
export function assertRepeatRule(params: Omit<RepeatRuleParams, "uuid">): void {
  if (!FREQUENCIES.includes(params.frequency)) {
    throw new RangeError(
      `invalid frequency "${params.frequency}" — expected ${FREQUENCIES.join(" | ")}`,
    );
  }
  if (!Number.isInteger(params.interval) || params.interval < 1 || params.interval > 99) {
    throw new RangeError(`invalid interval ${params.interval} — expected an integer 1–99`);
  }

  // After-completion has no calendar anchor: the day-of-week / monthly / yearly
  // placements are meaningless when the next date is "N units after completion".
  if (params.afterCompletion === true) {
    if (
      params.weekdays !== undefined ||
      params.monthly !== undefined ||
      params.yearly !== undefined
    ) {
      throw new RangeError(
        "an after-completion rule has no calendar day — remove weekdays/monthly/yearly, or drop afterCompletion for a fixed schedule",
      );
    }
  }

  if (params.weekdays !== undefined) {
    if (params.frequency !== "weekly") {
      throw new RangeError("weekdays apply only to a weekly rule");
    }
    if (params.weekdays.length === 0) {
      throw new RangeError("weekdays must name at least one day");
    }
    const seen = new Set<Weekday>();
    for (const day of params.weekdays) {
      assertWeekday(day, "weekdays");
      if (seen.has(day)) throw new RangeError(`weekdays repeats "${day}"`);
      seen.add(day);
    }
  }

  if (params.monthly !== undefined) {
    if (params.frequency !== "monthly") {
      throw new RangeError("monthly anchor applies only to a monthly rule");
    }
    assertMonthlyAnchor(params.monthly, "monthly");
  }

  if (params.yearly !== undefined) {
    if (params.frequency !== "yearly") {
      throw new RangeError("yearly anchor applies only to a yearly rule");
    }
    const month = (params.yearly as { month?: unknown }).month;
    if (!Number.isInteger(month) || (month as number) < 1 || (month as number) > 12) {
      throw new RangeError(`invalid yearly month ${JSON.stringify(month)} — expected 1–12`);
    }
    assertMonthlyAnchor(params.yearly, "yearly");
  }

  if (params.ends !== undefined) assertEnds(params.ends);

  if (params.reminder !== undefined) {
    if (!/^\d{1,2}:\d{2}$/.test(params.reminder)) {
      throw new RangeError(`invalid reminder ${JSON.stringify(params.reminder)} — expected HH:mm`);
    }
    // UIC6-g: the Repeat dialog's reminder-time control is an AXDateTimeArea
    // whose committed time CANNOT be set through the Accessibility surface —
    // it ignores AXValue writes (unlike the "ends on date" picker, which
    // honors them) and silently commits its default instead. Rather than write
    // a WRONG reminder time, the op refuses. (Set the reminder in the app after
    // the series exists; every other rule field IS drivable.) See
    // docs/lab/uic6-rule-vocabulary.md and docs/things-app-oddities.md.
    throw new RangeError(
      "a repeat reminder time cannot be set through the GUI vector — Things' reminder picker " +
        "ignores programmatic time entry (UIC6-g); create the series without --reminder and set the " +
        "reminder in the app",
    );
  }

  if (params.startDaysEarlier !== undefined) {
    if (!Number.isInteger(params.startDaysEarlier) || params.startDaysEarlier < 0) {
      throw new RangeError(
        `invalid startDaysEarlier ${params.startDaysEarlier} — expected an integer ≥ 0`,
      );
    }
    if (params.startDaysEarlier > 0 && params.deadline === false) {
      throw new RangeError(
        "startDaysEarlier requires a deadline (it counts days before the deadline)",
      );
    }
  }
}

// ----------------------------------------------------- decode → inverse params
//
// The reschedule undo re-drives reschedule with the CAPTURED prior rule. To do
// that faithfully, the decoded prior rule (RepeatRule) + the template's
// deadline flag must map back onto the extended vocabulary. A rule the DIALOG
// itself cannot produce (simultaneous end-date + count; a monthly/yearly rule
// with MULTIPLE calendar anchors) is INEXPRESSIBLE — the mapping returns null
// and the undo stays irreversible for that record (documented in
// reversibility.ts). NB: an after-completion rule is ALWAYS expressible — the
// UIC6 sitting found it carries a nominal unit offset (of=[{wd:0}] etc.) that
// is not a user anchor and is ignored, so it is not an inexpressible shape.

export type InverseRuleFields = Omit<RepeatRuleParams, "uuid">;

/** The mutually-exclusive Ends bound of a decoded rule, or null if inexpressible. */
function endsOf(rule: RepeatRule): { ends: RepeatEnds } | null {
  const hasDate = rule.endDate !== null;
  const hasCount = rule.remainingCount !== null;
  if (hasDate && hasCount) return null; // dialog's Ends is single-choice
  if (hasDate) return { ends: { kind: "on-date", date: rule.endDate as IsoDate } };
  if (hasCount) return { ends: { kind: "after", count: rule.remainingCount as number } };
  return { ends: { kind: "never" } };
}

function monthlyAnchorOf(offset: RepeatOffset): MonthlyAnchor | null {
  if (offset.weekday !== undefined) {
    const weekday = WD_TO_WEEKDAY[offset.weekday];
    if (weekday === undefined) return null;
    const ord = offset.weekdayOrdinal ?? 1;
    const ordinal: WeekdayOrdinal = ord === -1 ? "last" : (ord as WeekdayOrdinal);
    if (ordinal !== "last" && (ordinal < 1 || ordinal > 5)) return null;
    return { weekday, ordinal };
  }
  if (offset.day !== undefined) {
    return { day: offset.day === -1 ? "last" : offset.day };
  }
  return null;
}

/**
 * Map a decoded prior rule (+ the template's deadline flag) back onto the
 * extended vocabulary, or return null when the rule falls OUTSIDE what the
 * Repeat dialog can express (the faithfulness boundary — see reversibility.ts).
 * `reminder` is NOT part of the rule blob, so it is never restored here (a
 * documented limitation of the reschedule inverse).
 */
export function ruleToInverseParams(
  rule: RepeatRule,
  deadlined: boolean,
): InverseRuleFields | null {
  const fields: InverseRuleFields = { frequency: rule.unit, interval: rule.interval };

  const ends = endsOf(rule);
  if (ends === null) return null;
  if (ends.ends.kind !== "never") fields.ends = ends.ends;

  const afterCompletion = rule.type === "after-completion";

  // Calendar anchors from the offsets.
  const meaningful = rule.offsets.filter(
    (o) => o.day !== undefined || o.weekday !== undefined || o.month !== undefined,
  );
  if (afterCompletion) {
    // After-completion has no calendar anchor in the dialog, so the user can
    // never set one — but Things still writes a NOMINAL offset for the unit
    // (UIC6-e: a weekly-unit after-completion rule carries of=[{wd:0}], a
    // monthly one of=[{dy:0}], etc.). That offset is not user-meaningful and is
    // never round-tripped, so it is IGNORED here (an earlier assumption that
    // after-completion rules carry no offsets was wrong — it would have made
    // every after-completion reschedule-undo spuriously irreversible).
    fields.afterCompletion = true;
  } else if (rule.unit === "weekly") {
    const weekdays: Weekday[] = [];
    for (const o of meaningful) {
      if (o.weekday === undefined) return null;
      const name = WD_TO_WEEKDAY[o.weekday];
      if (name === undefined) return null;
      weekdays.push(name);
    }
    if (weekdays.length > 0) fields.weekdays = weekdays;
  } else if (rule.unit === "monthly") {
    if (meaningful.length > 1) return null; // dialog sets ONE monthly anchor
    const only = meaningful[0];
    if (only !== undefined) {
      const anchor = monthlyAnchorOf(only);
      if (anchor === null) return null;
      fields.monthly = anchor;
    }
  } else if (rule.unit === "yearly") {
    if (meaningful.length > 1) return null;
    const only = meaningful[0];
    if (only !== undefined) {
      if (only.month === undefined) return null;
      const anchor = monthlyAnchorOf(only);
      if (anchor === null) return null;
      fields.yearly = { month: only.month, ...anchor } as YearlyAnchor;
    }
  }
  // daily: no offsets.

  // Deadline + start-earlier: ts ≤ 0 in the rule; deadline-ness from the column.
  if (deadlined) fields.deadline = true;
  if (rule.startOffsetDays < 0) {
    fields.deadline = true;
    fields.startDaysEarlier = -rule.startOffsetDays;
  }

  return fields;
}
