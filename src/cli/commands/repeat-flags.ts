/**
 * Shared CLI flags + mapper for the full Repeat-rule vocabulary (make-repeating
 * / reschedule-repeat, to-do AND project). The base `--frequency` / `--interval`
 * stay on each command; these OPTIONAL flags add the day-of-week set, the
 * monthly/yearly anchor, the end bound, reminders, and the deadline offset. A
 * command with none of them behaves exactly as before.
 */
import type { Command } from "commander";

import type {
  AddRepeatingRuleFields,
  MonthlyAnchor,
  RepeatFrequency,
  RepeatRuleParams,
  Weekday,
  WeekdayOrdinal,
  YearlyAnchor,
} from "../../index.ts";

/** The extended fields (everything a rule carries beyond uuid/frequency/interval). */
export type RepeatRuleFlagFields = Omit<RepeatRuleParams, "uuid" | "frequency" | "interval">;

/** Attach the full-vocabulary options to a repeat command. */
export function addRepeatRuleFlags(cmd: Command): Command {
  return cmd
    .option(
      "--after-completion",
      "repeat N units AFTER each occurrence is completed (not on a fixed schedule)",
    )
    .option(
      "--weekdays <days>",
      "weekly only: comma-separated weekdays, e.g. monday,wednesday,friday",
    )
    .option("--on-day <day>", "monthly/yearly only: a day of the month (1–31, or 'last')")
    .option(
      "--on-weekday <weekday>",
      "monthly/yearly only: a weekday for an nth-weekday rule (with --on-ordinal)",
    )
    .option(
      "--on-ordinal <n>",
      "monthly/yearly only: which weekday (1–5, or 'last') with --on-weekday",
    )
    .option("--yearly-month <n>", "yearly only: the month (1–12)")
    .option("--ends-after <n>", "stop after N occurrences (1–999)")
    .option("--ends-on <date>", "YYYY-MM-DD — stop after this date")
    .option(
      "--when <date>",
      "YYYY-MM-DD — the first occurrence (drives the Repeat dialog's Next field); " +
        "make-repeating defaults to the item's scheduled date",
    )
    .option("--reminder <time>", "HH:mm — a reminder time on each occurrence")
    .option("--deadline", "give each occurrence a deadline")
    .option(
      "--start-days-earlier <n>",
      "with --deadline: start each occurrence N days before its deadline",
    );
}

/**
 * The CALENDAR-ANCHOR subset of the rule flags — for the add-repeating
 * composites, whose base add already owns `--deadline <date>` / `--reminder`
 * (the item's own), so the rule-level `--deadline` / `--reminder` /
 * `--start-days-earlier` (which would collide) are intentionally absent. A
 * deadlined repeat is set with a follow-up `reschedule-repeat`.
 */
export function addRepeatCalendarFlags(cmd: Command): Command {
  return cmd
    .option(
      "--after-completion",
      "repeat N units AFTER each occurrence is completed (not on a fixed schedule)",
    )
    .option(
      "--weekdays <days>",
      "weekly only: comma-separated weekdays, e.g. monday,wednesday,friday",
    )
    .option("--on-day <day>", "monthly/yearly only: a day of the month (1–31, or 'last')")
    .option(
      "--on-weekday <weekday>",
      "monthly/yearly only: a weekday for an nth-weekday rule (with --on-ordinal)",
    )
    .option(
      "--on-ordinal <n>",
      "monthly/yearly only: which weekday (1–5, or 'last') with --on-weekday",
    )
    .option("--yearly-month <n>", "yearly only: the month (1–12)")
    .option("--ends-after <n>", "stop after N occurrences (1–999)")
    .option("--ends-on <date>", "YYYY-MM-DD — stop after this date");
}

/**
 * EXHAUSTIVE over the rule-flag fields an add-repeating params bag does NOT
 * carry — every key of the full flag vocabulary that is absent from
 * {@link AddRepeatingRuleFields}. The bag the composites accept is the
 * calendar-anchor subset: the item's own `--when` / `--deadline` / `--reminder`
 * belong to the base add, and the rule-level `next` is DERIVED from `--when`
 * downstream rather than passed.
 *
 * The type is what makes this safe: adding a field to `RepeatRuleParams` that is
 * not also in `AddRepeatingRuleFields` breaks compilation here until it is
 * classified, so a flag can never again leak into the composite's params bag.
 * That leak was real — the old hand-written destructure forgot `next` (the
 * `--when` mapping), and the composite passed `next` straight through to its
 * `todo.add` leg, which since #584 REFUSES an unknown parameter: every
 * `things todo add-repeating --when <date>` (and the project verb) exited 2 with
 * `params.next: not a parameter of "todo.add"` before anything was created
 * (measured in-lab, NEXTPOP1).
 */
const NON_ADD_RULE_FLAGS: {
  [K in Exclude<keyof RepeatRuleFlagFields, keyof AddRepeatingRuleFields>]-?: true;
} = {
  reminder: true,
  deadline: true,
  startDaysEarlier: true,
  next: true,
};

/** Map the calendar-anchor rule flags (add-repeating), excluding the base-add-owned fields. */
export function addRepeatingRuleFieldsFromOpts(
  opts: Record<string, unknown>,
  frequency: RepeatFrequency,
  interval: number,
): AddRepeatingRuleFields {
  const flags = repeatRuleFlagsFromOpts(opts, frequency) as Record<string, unknown>;
  const fields: Record<string, unknown> = { frequency, interval };
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined) continue;
    if (Object.hasOwn(NON_ADD_RULE_FLAGS, key)) continue;
    fields[key] = value;
  }
  return fields as unknown as AddRepeatingRuleFields;
}

// The raw CLI strings are cast to the vocabulary types WITHOUT validation here —
// assertRepeatRule downstream refuses a bad day/ordinal/weekday with a clear
// message, so the CLI never has to duplicate the domain checks.
function dayAnchor(opts: Record<string, unknown>): MonthlyAnchor | undefined {
  const onDay = opts["onDay"] as string | undefined;
  const onWeekday = opts["onWeekday"] as string | undefined;
  const onOrdinal = opts["onOrdinal"] as string | undefined;
  if (onDay !== undefined) {
    return { day: onDay === "last" ? "last" : Number(onDay) };
  }
  if (onWeekday !== undefined || onOrdinal !== undefined) {
    return {
      weekday: onWeekday as Weekday,
      ordinal: (onOrdinal === "last" ? "last" : Number(onOrdinal)) as WeekdayOrdinal,
    };
  }
  return undefined;
}

/**
 * The CALENDAR-ANCHOR flags that apply only to a SUBSET of frequencies, and the
 * frequencies that consume each. A present anchor flag on any other frequency is
 * a hard error — never a silent drop (UIC6-l). Exhaustive over the anchor flag
 * set; a new anchor flag must earn a row here (and the mapper below consumes it).
 * `weekdays` is intentionally ABSENT: it is mapped unconditionally and refused
 * downstream by assertRepeatRule ("weekdays apply only to a weekly rule"), the
 * mapped-contradiction path — this table is only for the SILENTLY-dropped anchors.
 */
const ANCHOR_FLAG_FREQUENCIES: Record<string, RepeatFrequency[]> = {
  onDay: ["monthly", "yearly"],
  onWeekday: ["monthly", "yearly"],
  onOrdinal: ["monthly", "yearly"],
  yearlyMonth: ["yearly"],
};

/** The user-facing flag spelling for a camelCase option key (error messages). */
const ANCHOR_FLAG_SPELLING: Record<string, string> = {
  onDay: "--on-day",
  onWeekday: "--on-weekday",
  onOrdinal: "--on-ordinal",
  yearlyMonth: "--yearly-month",
};

/**
 * Refuse a calendar-anchor flag supplied on a frequency that does not consume it
 * (UIC6-l): `--frequency weekly --on-day 15` errors instead of silently running a
 * plain weekly rule. Behavioral message — names the flag + the frequency it
 * belongs to, never a mechanism.
 */
function assertAnchorFlagsMatchFrequency(
  opts: Record<string, unknown>,
  frequency: RepeatFrequency,
): void {
  for (const [key, allowed] of Object.entries(ANCHOR_FLAG_FREQUENCIES)) {
    if (opts[key] === undefined) continue;
    if (!allowed.includes(frequency)) {
      const flag = ANCHOR_FLAG_SPELLING[key] ?? key;
      throw new RangeError(
        `${flag} applies only to a ${allowed.join(" or ")} rule — this rule is ${frequency}`,
      );
    }
  }
}

/**
 * EXHAUSTIVE over every field of {@link RepeatRuleFlagFields}: each rule param is
 * derived from the CLI options by exactly one entry, so a new param added to
 * RepeatRuleParams breaks compilation here until it earns a flag mapping. This is
 * what makes an accepted-but-dropped flag impossible for this vocabulary (the
 * UIC6-l class) — the wrong-frequency guard above catches the inverse (a flag
 * with no consuming frequency). Each entry returns the mapped value or
 * `undefined` (absent — exactOptionalPropertyTypes).
 */
const FLAG_MAP: {
  [K in keyof RepeatRuleFlagFields]-?: (
    opts: Record<string, unknown>,
    frequency: RepeatFrequency,
    anchor: MonthlyAnchor | undefined,
  ) => RepeatRuleFlagFields[K] | undefined;
} = {
  afterCompletion: (opts) => (opts["afterCompletion"] === true ? true : undefined),
  weekdays: (opts) =>
    typeof opts["weekdays"] === "string"
      ? (opts["weekdays"]
          .split(",")
          .map((d) => d.trim().toLowerCase())
          .filter((d) => d.length > 0) as Weekday[])
      : undefined,
  monthly: (_opts, frequency, anchor) =>
    frequency === "monthly" && anchor !== undefined ? anchor : undefined,
  yearly: (opts, frequency, anchor) => {
    if (frequency !== "yearly") return undefined;
    const month = opts["yearlyMonth"];
    if (month === undefined && anchor === undefined) return undefined;
    const base = { month: Number(month) };
    return (anchor === undefined ? base : { ...base, ...anchor }) as YearlyAnchor;
  },
  ends: (opts) => {
    if (opts["endsAfter"] !== undefined) return { kind: "after", count: Number(opts["endsAfter"]) };
    if (typeof opts["endsOn"] === "string") return { kind: "on-date", date: opts["endsOn"] };
    return undefined;
  },
  reminder: (opts) => (typeof opts["reminder"] === "string" ? opts["reminder"] : undefined),
  next: (opts) => (typeof opts["when"] === "string" ? opts["when"] : undefined),
  deadline: (opts) => (opts["deadline"] === true ? true : undefined),
  startDaysEarlier: (opts) =>
    opts["startDaysEarlier"] !== undefined ? Number(opts["startDaysEarlier"]) : undefined,
};

/**
 * Build the extended rule fields from CLI options (present keys only —
 * exactOptionalPropertyTypes). A wrong-frequency anchor flag is REFUSED here
 * (UIC6-l), never silently dropped; other combination validity (e.g. weekdays on
 * a non-weekly rule) is enforced downstream by assertRepeatRule.
 */
export function repeatRuleFlagsFromOpts(
  opts: Record<string, unknown>,
  frequency: RepeatFrequency,
): RepeatRuleFlagFields {
  assertAnchorFlagsMatchFrequency(opts, frequency);
  const anchor = dayAnchor(opts);
  const fields: RepeatRuleFlagFields = {};
  for (const key of Object.keys(FLAG_MAP) as (keyof RepeatRuleFlagFields)[]) {
    const value = FLAG_MAP[key](opts, frequency, anchor);
    if (value !== undefined) {
      // The map's per-key return type is exactly RepeatRuleFlagFields[K]; the
      // index write is safe but TS cannot narrow K across the loop.
      (fields as Record<string, unknown>)[key] = value;
    }
  }
  return fields;
}
