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
import { assessOffRuleFirst } from "./repeat-anchor.ts";
import {
  WEEKDAYS,
  type AddRepeatingRuleFields,
  type MonthlyAnchor,
  type RepeatEnds,
  type RepeatFrequency,
  type RepeatRuleParams,
  type RescheduleRepeatParams,
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

/**
 * Validate a month/year day anchor (shared by monthly + yearly). Exported so the
 * per-op parameter schema (param-schema.ts) WRAPS this one validator instead of
 * restating the anchor grammar — the two would drift.
 */
export function assertMonthlyAnchor(anchor: unknown, where: string): void {
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

/**
 * Validate the "Ends" bound. Exported as {@link assertEndsBound} so the per-op
 * parameter schema wraps this validator rather than restating the grammar.
 */
export function assertEndsBound(ends: RepeatEnds): void {
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
 * EXHAUSTIVE over the calendar-anchor rule vocabulary an add-repeating params bag
 * carries INLINE alongside its add fields ({@link AddRepeatingRuleFields} — the
 * rule-level deadline pair is folded in later, by the caller's deadline geometry).
 * Adding a field there breaks compilation here until the splitter is told which
 * half of the bag it belongs to. (The assert-side map over the FULL rule
 * vocabulary lives in repeat-asserts.ts.)
 */
const ADD_RULE_KEYS: { [K in keyof AddRepeatingRuleFields]-?: true } = {
  frequency: true,
  interval: true,
  afterCompletion: true,
  weekdays: true,
  monthly: true,
  yearly: true,
  ends: true,
};

/**
 * Split an add-repeating params bag into its RULE half and its ADD half, by the
 * exhaustive key map rather than by hand — so a field added to either vocabulary
 * flows to the right leg instead of being dropped by an out-of-date literal.
 *
 * This is the #491 exhaustive-map doctrine applied to the promote orchestrators:
 * a hand-rebuilt bag here is how `project make-repeating` came to drop the
 * requested first occurrence (#549) and how a deadlined make-repeating came to
 * land a non-deadlined series (YANCH1 #493). Present-only: an `undefined` value
 * is omitted from both halves (the `exactOptionalPropertyTypes` contract the
 * downstream params types are written against).
 */
export function splitAddRepeatingRule<T extends AddRepeatingRuleFields>(
  params: T,
): { rule: AddRepeatingRuleFields; add: Omit<T, keyof AddRepeatingRuleFields> } {
  const rule: Record<string, unknown> = {};
  const add: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    (Object.hasOwn(ADD_RULE_KEYS, key) ? rule : add)[key] = value;
  }
  return {
    rule: rule as unknown as AddRepeatingRuleFields,
    add: add as Omit<T, keyof AddRepeatingRuleFields>,
  };
}

/**
 * Validate the full extended rule vocabulary. The base `{ frequency, interval }`
 * is always checked; every optional field is checked and REFUSED when it does
 * not apply to the chosen frequency (or contradicts another field). Throws a
 * RangeError with a behavioral message on any violation.
 */
/**
 * An AFTER-COMPLETION series' period in DAYS, or null when the rule is not
 * after-completion (a fixed cadence has no such cap — DEFAULTS2 §clamp measured a
 * 45-day offset landing verbatim under weekly, monthly and yearly).
 *
 * The unit conversion is the app's own, read off the clamp it applies: a month is
 * 30 days and a year is 365 (`every 1 month` caps at 29, `every 1 year` at 364).
 * They are calendar-naive numbers, and deliberately so — this is a reproduction
 * of the app's arithmetic, not an improvement on it.
 */
function afterCompletionPeriodDays(
  params: Pick<RepeatRuleParams, "afterCompletion" | "frequency" | "interval">,
): number | null {
  if (params.afterCompletion !== true) return null;
  const perUnit: Record<RepeatRuleParams["frequency"], number> = {
    daily: 1,
    weekly: 7,
    monthly: 30,
    yearly: 365,
  };
  return params.interval * perUnit[params.frequency];
}

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
    // ANCH1 (issue #476, golden-v2/3.22.12): an after-completion repeat can't be
    // given an end bound through this path — after-completion mode does not expose
    // the Ends control the fixed schedule does, so BOTH an end date and an
    // occurrence count fail to apply (an ends-on-date drive dies looking for the
    // "on date" option; an ends-after drive silently fails to set the count).
    // Refuse it BEFORE any mutation rather than letting the GUI drive die and roll
    // back. `never` (the default, no bound) is fine.
    if (params.ends !== undefined && params.ends.kind !== "never") {
      throw new RangeError(
        "an after-completion repeat can't be given an end bound through this command — create it " +
          "without an end (it repeats until you stop it), or use a fixed schedule (drop " +
          "afterCompletion) to end on a date or after a number of times",
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

  if (params.ends !== undefined) assertEndsBound(params.ends);

  if (params.reminder !== undefined) {
    if (!/^\d{1,2}:\d{2}$/.test(params.reminder)) {
      throw new RangeError(`invalid reminder ${JSON.stringify(params.reminder)} — expected HH:mm`);
    }
    // ANCH2 (docs/lab/anch2-next-field.md): the reminder-time AXDateTimeArea IS
    // drivable — UIC6-g's "ignores programmatic time entry" was a targeting
    // artifact (the old set-datetime primitive wrote into the "first" date area,
    // never the reminder). With deterministic targeting the picker commits the
    // requested time exactly (probes: 09:00, 14:30), so --reminder is honored.
  }

  if (params.next !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(params.next)) {
      throw new RangeError(`invalid next ${JSON.stringify(params.next)} — expected YYYY-MM-DD`);
    }
    if (params.afterCompletion === true) {
      throw new RangeError(
        "a first-occurrence date (next/--when) does not apply to an after-completion repeat — it has no calendar",
      );
    }
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
    // AN AFTER-COMPLETION OFFSET IS BOUNDED BY THE PERIOD (DEFAULTS2 §clamp,
    // MEASURED on Things 3.23 build 32300036). The dialog will not hold an offset
    // of P days or more for a series that repeats every P days: the start would
    // fall on or before the PREVIOUS occurrence's due date, and the app clamps the
    // field to P − 1. Measured across 3 seed offsets x 8 unit/interval pairs —
    // 1 day -> 0, 3 days -> 2, 10 days -> 9, 1 week -> 6, 2 weeks -> 13,
    // 1 month -> 29, 2 months -> 59, 1 year -> 364 — with a month taken as 30 days
    // and a year as 365.
    //
    // IT IS REFUSED HERE RATHER THAN DRIVEN, because the app's clamp is SILENT: a
    // typed value above it is replaced with no refusal and no visible sign (30
    // became 6 under `every 1 week`, and 0 under `every 3 days`), and the landed
    // rule carries the replacement (oddities §32). The drive would in fact catch
    // it — the pre-commit audit re-reads the field before the OK press, and the
    // post-drive oracle asserts the landed `startOffsetDays` against the requested
    // one — but both of those fail a drive that had no chance of succeeding. The
    // over-caution fail direction says refuse the request, and name the law.
    const period = afterCompletionPeriodDays(params);
    if (period !== null && params.startDaysEarlier >= period) {
      throw new RangeError(
        `an after-completion series repeating every ${period} day` +
          `${period === 1 ? "" : "s"} cannot start ${params.startDaysEarlier} days before its ` +
          `deadline — the start would fall on or before the previous occurrence's due date, and ` +
          `Things caps the offset at ${period - 1}. Use --start-days-earlier ` +
          `${period - 1} or less, lengthen the interval, or drop --after-completion for a fixed ` +
          "schedule (which has no such cap).",
      );
    }
  }

  // DACON1: an EXPLICIT calendar anchor that disagrees with `--when` requests an
  // OFF-RULE first occurrence (first on `--when`, the anchor thereafter). The app
  // HONORS this for weekly/yearly (allowed — disclosed at the call sites), but a
  // MONTHLY rule's dialog snaps the first occurrence to the anchor day, so that
  // shape is inexpressible and fail-closed here before any mutation. On-rule
  // requests and `--when`-only (derived-anchor) requests return null.
  const offRule = assessOffRuleFirst(params);
  if (offRule?.kind === "dishonored") throw new RangeError(offRule.refusal);
}

/**
 * The rule fields a bare RE-ANCHOR may NOT carry — everything in the vocabulary
 * except `next` (the date it moves the series to). Exhaustive by construction:
 * a field added to {@link RescheduleRepeatParams} breaks compilation here until
 * it is classified, so a new flag can never silently become "allowed on a
 * re-anchor" (the #491/UIC6-l doctrine).
 */
const REANCHOR_FORBIDDEN: {
  [K in Exclude<
    keyof RescheduleRepeatParams,
    "uuid" | "next" | "frequency" | "interval"
  >]-?: string;
} = {
  afterCompletion: "--after-completion",
  weekdays: "--weekdays",
  monthly: "--on-day/--on-weekday/--on-ordinal",
  yearly: "--yearly-month",
  ends: "--ends-after/--ends-on",
  reminder: "--reminder",
  deadline: "--deadline",
  startDaysEarlier: "--start-days-earlier",
};

/**
 * Validate a `reschedule-repeat` params bag, which has TWO legal shapes
 * ({@link RescheduleRepeatParams}):
 *
 *  - `{ uuid, next }` alone — the bare RE-ANCHOR. Moves the series' next
 *    occurrence without restating the rule; every other rule field is refused
 *    here, because the vector that carries it (one `things:///update?when=`
 *    dispatch, REANCH1) can express nothing else. A `deadline=` riding the SAME
 *    url additionally VOIDS the whole write on Things 3.23 — the re-anchor that
 *    lands alone lands nothing beside a deadline (REANCH2 cells D6/E1/E3/E4), so
 *    "nothing else" is a measured requirement, not tidiness.
 *  - the full rule — `frequency` + `interval` required, then
 *    {@link assertRepeatRule} exactly as before.
 *
 * Throws a RangeError with a behavioral message on any violation.
 */
export function assertRescheduleRule(params: Omit<RescheduleRepeatParams, "uuid">): void {
  if (params.frequency !== undefined || params.interval !== undefined) {
    if (params.frequency === undefined || params.interval === undefined) {
      throw new RangeError(
        "a rule change needs BOTH a frequency and an interval — or give only a date " +
          "(--when) to move the next occurrence and keep the rule",
      );
    }
    assertRepeatRule(params as Omit<RepeatRuleParams, "uuid">);
    return;
  }
  if (params.next === undefined) {
    throw new RangeError(
      "nothing to change — give a frequency and an interval to set the rule, or a date " +
        "(--when) to move the next occurrence",
    );
  }
  const extras = (Object.keys(REANCHOR_FORBIDDEN) as (keyof typeof REANCHOR_FORBIDDEN)[]).filter(
    (key) => params[key] !== undefined,
  );
  if (extras.length > 0) {
    throw new RangeError(
      `moving the next occurrence keeps the existing rule — ${extras
        .map((key) => REANCHOR_FORBIDDEN[key])
        .join(", ")} needs a frequency and an interval too (it restates the whole rule)`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.next)) {
    throw new RangeError(`invalid next ${JSON.stringify(params.next)} — expected YYYY-MM-DD`);
  }
}

/**
 * A reschedule bag in its RULE spelling, narrowed. Every consumer reaches this
 * only after {@link isRepeatReanchor} has answered false, and validation has
 * already refused a half-stated rule — so an absent frequency/interval here is a
 * programming error, not a user one.
 */
export function asRepeatRuleParams(params: RescheduleRepeatParams): RepeatRuleParams {
  const { frequency, interval } = params;
  if (frequency === undefined || interval === undefined) {
    throw new Error("reschedule: rule params without a frequency/interval (validation bug)");
  }
  return { ...params, frequency, interval };
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
  const hasCount = rule.occurrenceCount !== null;
  if (hasDate && hasCount) return null; // dialog's Ends is single-choice
  if (hasDate) return { ends: { kind: "on-date", date: rule.endDate as IsoDate } };
  if (hasCount) return { ends: { kind: "after", count: rule.occurrenceCount as number } };
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
