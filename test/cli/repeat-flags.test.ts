/**
 * The CLI full-vocabulary flag mapper: option strings -> extended rule fields
 * (present keys only). Domain validity is enforced downstream (repeat-rule.ts),
 * so the mapper is tested purely for the shape it produces.
 */
import { describe, expect, it } from "vitest";

import { repeatRuleFlagsFromOpts } from "../../src/cli/commands/repeat-flags.ts";

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

  it("does not attach a monthly anchor for a non-monthly frequency", () => {
    expect(repeatRuleFlagsFromOpts({ onDay: "15" }, "weekly")).toEqual({});
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
