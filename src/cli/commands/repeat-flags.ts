/**
 * Shared CLI flags + mapper for the full Repeat-rule vocabulary (make-repeating
 * / reschedule-repeat, to-do AND project). The base `--frequency` / `--interval`
 * stay on each command; these OPTIONAL flags add the day-of-week set, the
 * monthly/yearly anchor, the end bound, reminders, and the deadline offset. A
 * command with none of them behaves exactly as before.
 */
import type { Command } from "commander";

import type {
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
    .option("--reminder <time>", "HH:mm — a reminder time on each occurrence")
    .option("--deadline", "give each occurrence a deadline")
    .option(
      "--start-days-earlier <n>",
      "with --deadline: start each occurrence N days before its deadline",
    );
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
 * Build the extended rule fields from CLI options (present keys only —
 * exactOptionalPropertyTypes). Combination validity is enforced downstream
 * (the same refusals the library raises), so a wrong-frequency flag surfaces a
 * clear error rather than being silently applied.
 */
export function repeatRuleFlagsFromOpts(
  opts: Record<string, unknown>,
  frequency: RepeatFrequency,
): RepeatRuleFlagFields {
  const fields: RepeatRuleFlagFields = {};

  if (opts["afterCompletion"] === true) fields.afterCompletion = true;

  if (typeof opts["weekdays"] === "string") {
    fields.weekdays = opts["weekdays"]
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0) as Weekday[];
  }

  const anchor = dayAnchor(opts);
  if (frequency === "monthly" && anchor !== undefined) {
    fields.monthly = anchor;
  }
  if (frequency === "yearly") {
    const month = opts["yearlyMonth"];
    if (month !== undefined || anchor !== undefined) {
      const base = { month: Number(month) };
      fields.yearly = (anchor === undefined ? base : { ...base, ...anchor }) as YearlyAnchor;
    }
  }

  if (opts["endsAfter"] !== undefined) {
    fields.ends = { kind: "after", count: Number(opts["endsAfter"]) };
  } else if (typeof opts["endsOn"] === "string") {
    fields.ends = { kind: "on-date", date: opts["endsOn"] };
  }

  if (typeof opts["reminder"] === "string") fields.reminder = opts["reminder"];
  if (opts["deadline"] === true) fields.deadline = true;
  if (opts["startDaysEarlier"] !== undefined) {
    fields.startDaysEarlier = Number(opts["startDaysEarlier"]);
  }

  return fields;
}
