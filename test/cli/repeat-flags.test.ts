/**
 * The CLI full-vocabulary flag mapper: option strings -> extended rule fields
 * (present keys only). Domain validity is enforced downstream (repeat-rule.ts),
 * so the mapper is tested purely for the shape it produces.
 */
import { describe, expect, it } from "vitest";

import {
  addRepeatingRuleFieldsFromOpts,
  repeatRuleFlagsFromOpts,
  type RepeatRuleFlagFields,
} from "../../src/cli/commands/repeat-flags.ts";
import type { RepeatFrequency } from "../../src/write/operations.ts";

describe("repeatRuleFlagsFromOpts", () => {
  it("maps nothing for a bare command", () => {
    expect(repeatRuleFlagsFromOpts({}, "weekly")).toEqual({});
  });

  it("splits --weekdays into a lowercased list", () => {
    expect(repeatRuleFlagsFromOpts({ weekdays: "Monday, Wednesday,friday" }, "weekly")).toEqual({
      weekdays: ["monday", "wednesday", "friday"],
    });
  });

  it("maps --on-day to a monthly day anchor (with 'last')", () => {
    expect(repeatRuleFlagsFromOpts({ onDay: "15" }, "monthly")).toEqual({ monthly: { day: 15 } });
    expect(repeatRuleFlagsFromOpts({ onDay: "last" }, "monthly")).toEqual({
      monthly: { day: "last" },
    });
  });

  it("maps --on-weekday + --on-ordinal to a monthly nth-weekday anchor", () => {
    expect(repeatRuleFlagsFromOpts({ onWeekday: "friday", onOrdinal: "last" }, "monthly")).toEqual({
      monthly: { weekday: "friday", ordinal: "last" },
    });
  });

  it("maps --yearly-month + anchor to a yearly anchor", () => {
    expect(repeatRuleFlagsFromOpts({ yearlyMonth: "10", onDay: "8" }, "yearly")).toEqual({
      yearly: { month: 10, day: 8 },
    });
  });

  it("REFUSES a wrong-frequency anchor rather than silently dropping it (UIC6-l)", () => {
    // Pre-#491 this returned {} — the anchor was silently dropped and a plain
    // weekly rule ran. Now every silently-droppable anchor flag on the wrong
    // frequency is a hard error naming the flag + the frequencies it belongs to.
    expect(() => repeatRuleFlagsFromOpts({ onDay: "15" }, "weekly")).toThrow(
      /--on-day applies only to a monthly or yearly rule/,
    );
    expect(() => repeatRuleFlagsFromOpts({ onWeekday: "friday" }, "daily")).toThrow(
      /--on-weekday applies only to a monthly or yearly rule/,
    );
    expect(() => repeatRuleFlagsFromOpts({ onOrdinal: "2" }, "weekly")).toThrow(
      /--on-ordinal applies only to a monthly or yearly rule/,
    );
    expect(() => repeatRuleFlagsFromOpts({ yearlyMonth: "10" }, "monthly")).toThrow(
      /--yearly-month applies only to a yearly rule/,
    );
  });

  // ---- mapper completeness (#491 amendment): no accepted-but-dropped flag -----
  //
  // Two directions, so a flag can never be silently dropped (the UIC6-l class) nor
  // a param field left unreachable from the CLI:
  //   (a) every rule PARAM field is produced by some flag input;
  //   (b) every declared repeat FLAG maps to a param (on a consuming frequency).

  it("(a) every rule param field is reachable from a flag", () => {
    // The Record type is EXHAUSTIVE over RepeatRuleFlagFields — a new param field
    // breaks compilation here until it earns a producing flag.
    const producers: Record<
      keyof RepeatRuleFlagFields,
      { opts: Record<string, unknown>; frequency: RepeatFrequency }
    > = {
      afterCompletion: { opts: { afterCompletion: true }, frequency: "daily" },
      weekdays: { opts: { weekdays: "monday" }, frequency: "weekly" },
      monthly: { opts: { onDay: "15" }, frequency: "monthly" },
      yearly: { opts: { yearlyMonth: "6", onDay: "1" }, frequency: "yearly" },
      ends: { opts: { endsAfter: "5" }, frequency: "daily" },
      reminder: { opts: { reminder: "09:00" }, frequency: "daily" },
      deadline: { opts: { deadline: true }, frequency: "daily" },
      startDaysEarlier: { opts: { startDaysEarlier: "3", deadline: true }, frequency: "daily" },
      next: { opts: { when: "2027-01-01" }, frequency: "daily" },
    };
    for (const [param, { opts, frequency }] of Object.entries(producers)) {
      const fields = repeatRuleFlagsFromOpts(opts, frequency);
      expect(Object.prototype.hasOwnProperty.call(fields, param), param).toBe(true);
    }
  });

  it("(b) every declared repeat flag maps to a param (or errors) — none silently dropped", () => {
    // The declared flag surface (mirrors addRepeatRuleFlags): each flag, supplied on
    // a CONSUMING frequency, must yield at least one mapped param — an accepted flag
    // that produced nothing would be a silent drop.
    const cases: { opts: Record<string, unknown>; frequency: RepeatFrequency }[] = [
      { opts: { afterCompletion: true }, frequency: "daily" },
      { opts: { weekdays: "monday" }, frequency: "weekly" },
      { opts: { onDay: "15" }, frequency: "monthly" },
      { opts: { onWeekday: "friday", onOrdinal: "last" }, frequency: "monthly" },
      { opts: { yearlyMonth: "6", onDay: "1" }, frequency: "yearly" },
      { opts: { endsAfter: "5" }, frequency: "daily" },
      { opts: { endsOn: "2027-01-01" }, frequency: "daily" },
      { opts: { when: "2027-01-01" }, frequency: "daily" },
      { opts: { reminder: "09:00" }, frequency: "daily" },
      { opts: { deadline: true }, frequency: "daily" },
      { opts: { startDaysEarlier: "3", deadline: true }, frequency: "daily" },
    ];
    for (const { opts, frequency } of cases) {
      const fields = repeatRuleFlagsFromOpts(opts, frequency);
      expect(Object.keys(fields).length, JSON.stringify(opts)).toBeGreaterThan(0);
    }
  });

  it("maps the ends bound (after / on-date), reminder, deadline, and offset", () => {
    expect(repeatRuleFlagsFromOpts({ endsAfter: "10" }, "daily")).toEqual({
      ends: { kind: "after", count: 10 },
    });
    expect(repeatRuleFlagsFromOpts({ endsOn: "2027-01-01" }, "daily")).toEqual({
      ends: { kind: "on-date", date: "2027-01-01" },
    });
    expect(
      repeatRuleFlagsFromOpts(
        { reminder: "09:00", deadline: true, startDaysEarlier: "3", afterCompletion: true },
        "daily",
      ),
    ).toEqual({
      reminder: "09:00",
      deadline: true,
      startDaysEarlier: 3,
      afterCompletion: true,
    });
  });
});

describe("addRepeatingRuleFieldsFromOpts (add-repeating calendar subset)", () => {
  // The add-repeating composites own `--deadline` / `--reminder` on the base add,
  // and the todo command threads `--start-days-earlier` explicitly, so the shared
  // calendar mapper must STRIP all three — otherwise the project add-repeating
  // command (which has no start-offset vocabulary) would inherit one, or the todo
  // path would double it and clobber the deadline/offset-agreement check.
  it("strips reminder / deadline / start-days-earlier, keeping only calendar anchors", () => {
    expect(
      addRepeatingRuleFieldsFromOpts(
        { weekdays: "monday", reminder: "09:00", deadline: true, startDaysEarlier: "3" },
        "weekly",
        1,
      ),
    ).toEqual({ frequency: "weekly", interval: 1, weekdays: ["monday"] });
  });
});
