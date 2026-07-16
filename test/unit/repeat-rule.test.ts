/**
 * The full Repeat-rule vocabulary: the validation combination matrix (every
 * refusal) and the decode-rule -> inverse-params mapping the reschedule undo
 * rides (round-trips + the dialog-expressibility boundary).
 */
import { describe, expect, it } from "vitest";

import type { RepeatRule } from "../../src/model/recurrence.ts";
import type { RepeatRuleParams } from "../../src/write/operations.ts";
import { assertRepeatRule, ruleToInverseParams } from "../../src/write/repeat-rule.ts";

type Rule = Omit<RepeatRuleParams, "uuid">;
const ok = (r: Rule) => expect(() => assertRepeatRule(r)).not.toThrow();
const bad = (r: Rule, match: RegExp) => expect(() => assertRepeatRule(r)).toThrow(match);

describe("assertRepeatRule — base vocabulary (backward compatible)", () => {
  it("accepts a bare frequency + interval for every unit", () => {
    for (const frequency of ["daily", "weekly", "monthly", "yearly"] as const) {
      ok({ frequency, interval: 1 });
    }
    ok({ frequency: "daily", interval: 99 });
  });
  it("refuses a bad frequency or interval", () => {
    bad({ frequency: "hourly" as never, interval: 1 }, /invalid frequency/);
    bad({ frequency: "daily", interval: 0 }, /invalid interval/);
    bad({ frequency: "daily", interval: 100 }, /invalid interval/);
    bad({ frequency: "daily", interval: 1.5 }, /invalid interval/);
  });
});

describe("assertRepeatRule — weekly weekday set", () => {
  it("accepts a valid multi-day set", () => {
    ok({ frequency: "weekly", interval: 1, weekdays: ["monday", "wednesday", "friday"] });
  });
  it("refuses weekdays on a non-weekly rule", () => {
    bad(
      { frequency: "daily", interval: 1, weekdays: ["monday"] },
      /weekdays apply only to a weekly/,
    );
    bad(
      { frequency: "monthly", interval: 1, weekdays: ["monday"] },
      /weekdays apply only to a weekly/,
    );
  });
  it("refuses an empty, duplicate, or invalid weekday set", () => {
    bad({ frequency: "weekly", interval: 1, weekdays: [] }, /at least one day/);
    bad({ frequency: "weekly", interval: 1, weekdays: ["monday", "monday"] }, /repeats/);
    bad(
      { frequency: "weekly", interval: 1, weekdays: ["funday" as never] },
      /invalid weekdays weekday/,
    );
  });
});

describe("assertRepeatRule — monthly anchor (discriminated)", () => {
  it("accepts a day-of-month, last day, or nth-weekday anchor", () => {
    ok({ frequency: "monthly", interval: 1, monthly: { day: 15 } });
    ok({ frequency: "monthly", interval: 1, monthly: { day: "last" } });
    ok({ frequency: "monthly", interval: 1, monthly: { weekday: "tuesday", ordinal: 3 } });
    ok({ frequency: "monthly", interval: 1, monthly: { weekday: "friday", ordinal: "last" } });
  });
  it("refuses monthly on a non-monthly rule", () => {
    bad({ frequency: "weekly", interval: 1, monthly: { day: 1 } }, /monthly anchor applies only/);
  });
  it("refuses a contradictory anchor (both a day and a weekday)", () => {
    bad(
      { frequency: "monthly", interval: 1, monthly: { day: 1, weekday: "monday" } as never },
      /names both a day-of-month and a weekday/,
    );
  });
  it("refuses an out-of-range day or ordinal", () => {
    bad({ frequency: "monthly", interval: 1, monthly: { day: 0 } }, /invalid monthly day/);
    bad({ frequency: "monthly", interval: 1, monthly: { day: 32 } }, /invalid monthly day/);
    bad(
      { frequency: "monthly", interval: 1, monthly: { weekday: "monday", ordinal: 6 as never } },
      /invalid monthly ordinal/,
    );
  });
});

describe("assertRepeatRule — yearly anchor", () => {
  it("accepts a month + day or nth-weekday anchor", () => {
    ok({ frequency: "yearly", interval: 1, yearly: { month: 10, day: 8 } });
    ok({
      frequency: "yearly",
      interval: 1,
      yearly: { month: 12, weekday: "sunday", ordinal: "last" },
    });
  });
  it("refuses yearly on a non-yearly rule and a bad month", () => {
    bad(
      { frequency: "monthly", interval: 1, yearly: { month: 1, day: 1 } },
      /yearly anchor applies only/,
    );
    bad({ frequency: "yearly", interval: 1, yearly: { month: 0, day: 1 } }, /invalid yearly month/);
    bad(
      { frequency: "yearly", interval: 1, yearly: { month: 13, day: 1 } },
      /invalid yearly month/,
    );
  });
});

describe("assertRepeatRule — after-completion", () => {
  it("accepts after-completion with a unit + interval", () => {
    ok({ frequency: "weekly", interval: 2, afterCompletion: true });
  });
  it("refuses after-completion with any calendar anchor", () => {
    bad(
      { frequency: "weekly", interval: 1, afterCompletion: true, weekdays: ["monday"] },
      /after-completion rule has no calendar day/,
    );
    bad(
      { frequency: "monthly", interval: 1, afterCompletion: true, monthly: { day: 1 } },
      /after-completion rule has no calendar day/,
    );
  });
});

describe("assertRepeatRule — ends bound", () => {
  it("accepts never / after N / on date", () => {
    ok({ frequency: "daily", interval: 1, ends: { kind: "never" } });
    ok({ frequency: "daily", interval: 1, ends: { kind: "after", count: 10 } });
    ok({ frequency: "daily", interval: 1, ends: { kind: "on-date", date: "2027-01-01" } });
  });
  it("refuses a bad count or date", () => {
    bad(
      { frequency: "daily", interval: 1, ends: { kind: "after", count: 0 } },
      /invalid ends count/,
    );
    bad(
      { frequency: "daily", interval: 1, ends: { kind: "on-date", date: "nope" } },
      /invalid ends date/,
    );
  });
});

describe("assertRepeatRule — reminders + deadline offset", () => {
  it("accepts a deadline start offset", () => {
    ok({ frequency: "daily", interval: 1, deadline: true, startDaysEarlier: 3 });
    ok({ frequency: "daily", interval: 1, startDaysEarlier: 0 });
  });
  it("refuses a reminder time — the GUI reminder picker is undrivable (UIC6-g)", () => {
    // Even a well-formed HH:mm is refused: the Repeat dialog's reminder-time
    // control ignores programmatic writes and would commit a WRONG time.
    bad({ frequency: "daily", interval: 1, reminder: "09:30" }, /reminder time cannot be set/);
    bad({ frequency: "daily", interval: 1, reminder: "9am" }, /invalid reminder/);
  });
  it("refuses a start offset without a deadline", () => {
    bad({ frequency: "daily", interval: 1, startDaysEarlier: -1 }, /invalid startDaysEarlier/);
    bad(
      { frequency: "daily", interval: 1, startDaysEarlier: 2, deadline: false },
      /startDaysEarlier requires a deadline/,
    );
  });
});

// --------------------------------------------------------- inverse mapping

function rule(partial: Partial<RepeatRule>): RepeatRule {
  return {
    type: "fixed",
    unit: "daily",
    interval: 1,
    startOffsetDays: 0,
    offsets: [],
    endDate: null,
    remainingCount: null,
    version: 4,
    ...partial,
  };
}

describe("ruleToInverseParams — round-trips (validates its own output)", () => {
  const roundTrips = (r: RepeatRule, deadlined = false) => {
    const inverse = ruleToInverseParams(r, deadlined);
    expect(inverse).not.toBeNull();
    // The reconstructed vocabulary must itself pass validation.
    expect(() => assertRepeatRule(inverse as Rule)).not.toThrow();
    return inverse as Rule;
  };

  it("daily", () => {
    expect(roundTrips(rule({ unit: "daily", interval: 3 }))).toMatchObject({
      frequency: "daily",
      interval: 3,
    });
  });
  it("weekly multi-day", () => {
    const inv = roundTrips(
      rule({
        unit: "weekly",
        interval: 2,
        offsets: [{ weekday: 1 }, { weekday: 3 }, { weekday: 5 }],
      }),
    );
    expect(inv).toMatchObject({ frequency: "weekly", weekdays: ["monday", "wednesday", "friday"] });
  });
  it("monthly nth-weekday", () => {
    const inv = roundTrips(
      rule({ unit: "monthly", offsets: [{ weekday: 5, weekdayOrdinal: -1 }] }),
    );
    expect(inv).toMatchObject({
      frequency: "monthly",
      monthly: { weekday: "friday", ordinal: "last" },
    });
  });
  it("monthly last day of month", () => {
    const inv = roundTrips(rule({ unit: "monthly", offsets: [{ day: -1 }] }));
    expect(inv).toMatchObject({ frequency: "monthly", monthly: { day: "last" } });
  });
  it("yearly month + day", () => {
    const inv = roundTrips(rule({ unit: "yearly", offsets: [{ month: 10, day: 8 }] }));
    expect(inv).toMatchObject({ frequency: "yearly", yearly: { month: 10, day: 8 } });
  });
  it("after-completion (nominal unit offset ignored)", () => {
    // UIC6-e: Things writes a NOMINAL offset for the unit even in after-completion
    // mode (of=[{wd:0}] for a weekly-unit rule) — the dialog exposes no anchor
    // there, so it round-trips as a plain after-completion rule, offset dropped.
    const inv = roundTrips(
      rule({ type: "after-completion", unit: "weekly", interval: 2, offsets: [{ weekday: 0 }] }),
    );
    expect(inv).toMatchObject({ frequency: "weekly", interval: 2, afterCompletion: true });
    expect(inv.weekdays).toBeUndefined();
  });
  it("ends after N", () => {
    expect(roundTrips(rule({ remainingCount: 5 }))).toMatchObject({
      ends: { kind: "after", count: 5 },
    });
  });
  it("ends on date", () => {
    expect(roundTrips(rule({ endDate: "2027-03-01" }))).toMatchObject({
      ends: { kind: "on-date", date: "2027-03-01" },
    });
  });
  it("deadline + start-earlier from a negative ts", () => {
    const inv = roundTrips(rule({ startOffsetDays: -3 }), true);
    expect(inv).toMatchObject({ deadline: true, startDaysEarlier: 3 });
  });
});

describe("ruleToInverseParams — inexpressible shapes (dialog cannot produce)", () => {
  it("null for a rule with BOTH an end date and a remaining count", () => {
    expect(
      ruleToInverseParams(rule({ endDate: "2027-01-01", remainingCount: 5 }), false),
    ).toBeNull();
  });
  it("null for a monthly rule with multiple anchors", () => {
    expect(
      ruleToInverseParams(rule({ unit: "monthly", offsets: [{ day: 1 }, { day: 15 }] }), false),
    ).toBeNull();
  });
  it("after-completion with a nominal offset is EXPRESSIBLE (offset ignored, UIC6-e)", () => {
    // Corrected at the UIC6 sitting: after-completion rules always carry a
    // nominal unit offset, so this must NOT be null — otherwise every
    // after-completion reschedule-undo would wrongly report irreversible.
    const inv = ruleToInverseParams(
      rule({ type: "after-completion", unit: "weekly", offsets: [{ weekday: 1 }] }),
      false,
    );
    expect(inv).toMatchObject({ afterCompletion: true, frequency: "weekly" });
  });
});
