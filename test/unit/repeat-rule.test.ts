/**
 * The full Repeat-rule vocabulary: the validation combination matrix (every
 * refusal) and the decode-rule -> inverse-params mapping the reschedule undo
 * rides (round-trips + the dialog-expressibility boundary).
 */
import { describe, expect, it } from "vitest";

import type { RepeatRule } from "../../src/model/recurrence.ts";
import type {
  AddRepeatingRuleFields,
  RepeatFrequency,
  RepeatRuleParams,
  TodoAddRepeatingParams,
} from "../../src/write/operations.ts";
import {
  assertRepeatRule,
  ruleToInverseParams,
  splitAddRepeatingRule,
} from "../../src/write/repeat-rule.ts";

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
  it("refuses after-completion + ANY end bound — on-date OR after (issue #476 item 5)", () => {
    // Neither an end date nor an occurrence count can be driven in after-completion
    // mode (ANCH1-B FIX4: both fail — the Ends control isn't reachable there).
    bad(
      {
        frequency: "weekly",
        interval: 2,
        afterCompletion: true,
        ends: { kind: "on-date", date: "2026-12-30" },
      },
      /after-completion repeat can't be given an end bound/,
    );
    bad(
      {
        frequency: "weekly",
        interval: 2,
        afterCompletion: true,
        ends: { kind: "after", count: 5 },
      },
      /after-completion repeat can't be given an end bound/,
    );
  });
  it("allows after-completion with no end bound (never / absent)", () => {
    ok({ frequency: "weekly", interval: 2, afterCompletion: true, ends: { kind: "never" } });
    ok({ frequency: "weekly", interval: 2, afterCompletion: true });
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
  it("accepts a well-formed reminder time (ANCH2: the picker IS drivable with deterministic targeting)", () => {
    // UIC6-g's "undrivable" was a targeting artifact; a well-formed HH:mm is now
    // honored, a malformed one still refused.
    ok({ frequency: "daily", interval: 1, reminder: "09:30" });
    bad({ frequency: "daily", interval: 1, reminder: "9am" }, /invalid reminder/);
  });
  it("validates the first-occurrence date (next) and refuses it under after-completion", () => {
    ok({ frequency: "weekly", interval: 2, next: "2026-08-26" });
    bad({ frequency: "weekly", interval: 1, next: "8/26/2026" }, /invalid next/);
    bad(
      { frequency: "weekly", interval: 2, afterCompletion: true, next: "2026-08-26" },
      /does not apply to an after-completion repeat/,
    );
  });
  it("refuses a start offset without a deadline", () => {
    bad({ frequency: "daily", interval: 1, startDaysEarlier: -1 }, /invalid startDaysEarlier/);
    bad(
      { frequency: "daily", interval: 1, startDaysEarlier: 2, deadline: false },
      /startDaysEarlier requires a deadline/,
    );
  });
});

describe("assertRepeatRule — DACON1 off-rule first occurrence (empirical boundary)", () => {
  // An explicit anchor disagreeing with `--when` (deadline-shift-aware) requests an
  // OFF-RULE first occurrence. The app HONORS this for weekly/yearly (allowed,
  // disclosed at the call site) but SNAPS it for monthly (fail-closed here). Evidence:
  // docs/lab/dacon1-deadline-contradiction.md (golden-v3 / Things 3.22.14).

  it("ALLOWS a weekly off-rule first (Thursday --when, Wednesday anchor — the maintainer's shape)", () => {
    ok({ frequency: "weekly", interval: 1, next: "2028-10-19", weekdays: ["wednesday"] }); // Oct 19 2028 is a Thursday
  });
  it("ALLOWS a weekly off-rule first under a deadline shift (weekday of when + N not in the set)", () => {
    ok({
      frequency: "weekly",
      interval: 1,
      next: "2028-10-18",
      weekdays: ["monday", "friday"],
      deadline: true,
      startDaysEarlier: 7,
    });
  });
  it("ALLOWS a yearly off-rule first (the live-host CREATE shape — honored on create)", () => {
    // --when Oct 16 + 14 ⇒ due Oct 30; anchor names the Oct-16 due date — off-rule first, honored.
    ok({
      frequency: "yearly",
      interval: 1,
      next: "2028-10-16",
      yearly: { month: 10, day: 16 },
      deadline: true,
      startDaysEarlier: 14,
    });
  });
  it("ALLOWS an on-rule anchor and a --when-only rule (no disagreement)", () => {
    ok({ frequency: "yearly", interval: 1, next: "2028-10-16", yearly: { month: 10, day: 16 } });
    ok({
      frequency: "yearly",
      interval: 1,
      next: "2028-10-16",
      deadline: true,
      startDaysEarlier: 14,
    });
    ok({ frequency: "weekly", interval: 1, next: "2028-10-18", weekdays: ["wednesday"] }); // Oct 18 is a Wednesday
  });

  it("REFUSES a monthly off-rule first (the dialog snaps to the anchor day)", () => {
    bad(
      { frequency: "monthly", interval: 1, next: "2028-10-16", monthly: { day: 1 } },
      /monthly rule cannot start off its anchor.*snaps.*day 1.*first occurrence on 2028-10-16/s,
    );
  });
  it("REFUSES a monthly off-rule first under a deadline shift", () => {
    bad(
      {
        frequency: "monthly",
        interval: 1,
        next: "2028-10-16",
        monthly: { day: 1 },
        deadline: true,
        startDaysEarlier: 5,
      },
      /monthly rule cannot start off its anchor/s,
    );
  });
  it("REFUSES a monthly nth-weekday off-rule first", () => {
    // 2028-10-16 is the 3rd Monday; a 2nd-Monday anchor disagrees.
    bad(
      {
        frequency: "monthly",
        interval: 1,
        next: "2028-10-16",
        monthly: { weekday: "monday", ordinal: 2 },
      },
      /monthly rule cannot start off its anchor.*the 2nd monday/s,
    );
  });
  it("ALLOWS a monthly ON-rule anchor (no off-rule first)", () => {
    ok({ frequency: "monthly", interval: 1, next: "2028-10-16", monthly: { day: 16 } });
    // 2028-10-16 IS the 3rd Monday.
    ok({
      frequency: "monthly",
      interval: 1,
      next: "2028-10-16",
      monthly: { weekday: "monday", ordinal: 3 },
    });
    ok({ frequency: "monthly", interval: 1, next: "2028-10-31", monthly: { day: "last" } });
  });

  it("does not fire without a concrete --when, nor for after-completion, nor daily", () => {
    ok({ frequency: "monthly", interval: 1, monthly: { day: 1 } }); // no --when
    ok({
      frequency: "daily",
      interval: 1,
      next: "2028-10-16",
      deadline: true,
      startDaysEarlier: 14,
    });
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
    occurrenceCount: null,
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
    expect(roundTrips(rule({ occurrenceCount: 5 }))).toMatchObject({
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
      ruleToInverseParams(rule({ endDate: "2027-01-01", occurrenceCount: 5 }), false),
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

describe("splitAddRepeatingRule — the exhaustive rule/add split (#491 doctrine)", () => {
  // The promote orchestrators used to destructure the rule fields by hand and
  // rebuild both halves field by field, which is how `project make-repeating`
  // dropped the requested first occurrence (#549) and how a deadlined
  // make-repeating landed a non-deadlined series (YANCH1 #493). The split is now
  // key-map driven; this pins that EVERY rule field goes left and everything else
  // goes right, with the map's own exhaustiveness enforced at compile time.
  const RULE_KEYS: Record<keyof AddRepeatingRuleFields, true> = {
    frequency: true,
    interval: true,
    afterCompletion: true,
    weekdays: true,
    monthly: true,
    yearly: true,
    ends: true,
  };

  it("routes every rule field to the rule half and every add field to the add half", () => {
    const params: TodoAddRepeatingParams = {
      frequency: "weekly",
      interval: 2,
      afterCompletion: false,
      weekdays: ["monday"],
      ends: { kind: "after", count: 5 },
      title: "seed",
      notes: "body",
      when: "2026-08-01",
      reminder: "09:00",
      deadline: "2026-08-05",
      startDaysEarlier: 4,
      tags: ["t"],
      checklistItems: ["c"],
      heading: "H",
      createdAt: "2026-01-01",
    };
    const { rule: ruleHalf, add } = splitAddRepeatingRule(params);
    for (const key of Object.keys(ruleHalf)) expect(RULE_KEYS).toHaveProperty(key);
    for (const key of Object.keys(add)) expect(RULE_KEYS).not.toHaveProperty(key);
    // Nothing falls between the halves — the split is a partition.
    expect([...Object.keys(ruleHalf), ...Object.keys(add)].toSorted()).toEqual(
      Object.keys(params).toSorted(),
    );
    // ...and the rule half is a valid rule on its own.
    expect(() => assertRepeatRule(ruleHalf)).not.toThrow();
  });

  it("omits absent fields rather than carrying an explicit undefined", () => {
    const { rule: ruleHalf, add } = splitAddRepeatingRule({
      frequency: "daily",
      interval: 1,
      title: "seed",
    } as TodoAddRepeatingParams);
    expect(ruleHalf).toEqual({ frequency: "daily", interval: 1 });
    expect(add).toEqual({ title: "seed" });
  });
});

/**
 * THE AFTER-COMPLETION OFFSET CAP (DEFAULTS2 §clamp) — measured on Things 3.23
 * build 32300036 across 3 seed offsets x 8 unit/interval pairs.
 *
 * The dialog will not hold an offset of P days or more for a series that repeats
 * every P days: the start would fall on or before the PREVIOUS occurrence's due
 * date. It applies the cap SILENTLY — a typed 30 became 6 under `every 1 week`
 * and 0 under `every 3 days`, with no refusal, and the landed rule carried the
 * replacement (oddities §32) — so the request is refused before dispatch instead.
 * A FIXED cadence has no cap at all: 30- and 45-day offsets landed verbatim.
 */
describe("assertRepeatRule — the after-completion offset cap (DEFAULTS2)", () => {
  const base = { afterCompletion: true, deadline: true } as const;
  const cap = (frequency: RepeatFrequency, interval: number, startDaysEarlier: number) => () =>
    assertRepeatRule({ ...base, frequency, interval, startDaysEarlier });

  it("accepts every offset strictly inside the period", () => {
    // 1 day -> 0 · 3 days -> 2 · 1 week -> 6 · 2 weeks -> 13 · 1 month -> 29 ·
    // 1 year -> 364, exactly as the dialog pre-fills them.
    expect(cap("daily", 1, 0)).not.toThrow();
    expect(cap("daily", 3, 2)).not.toThrow();
    expect(cap("weekly", 1, 6)).not.toThrow();
    expect(cap("weekly", 2, 13)).not.toThrow();
    expect(cap("monthly", 1, 29)).not.toThrow();
    expect(cap("yearly", 1, 364)).not.toThrow();
  });

  it("refuses an offset AT the period, naming the cap", () => {
    expect(cap("weekly", 1, 7)).toThrow(/caps the offset at 6/);
    expect(cap("daily", 1, 1)).toThrow(/caps the offset at 0/);
    expect(cap("daily", 3, 3)).toThrow(/caps the offset at 2/);
    expect(cap("monthly", 1, 30)).toThrow(/caps the offset at 29/);
  });

  it("refuses an offset above it, and says what would go wrong", () => {
    expect(cap("weekly", 1, 30)).toThrow(
      /the start would fall on or before the previous occurrence's due date/,
    );
    expect(cap("weekly", 1, 30)).toThrow(/drop --after-completion/);
  });

  it("does not cap a FIXED cadence at all", () => {
    for (const f of ["daily", "weekly", "monthly", "yearly"] as RepeatFrequency[]) {
      expect(() =>
        assertRepeatRule({
          frequency: f,
          interval: 1,
          deadline: true,
          startDaysEarlier: 45,
        }),
      ).not.toThrow();
    }
  });

  it("scales with the interval, because the cap is the PERIOD", () => {
    expect(cap("weekly", 1, 7)).toThrow();
    expect(cap("weekly", 2, 7)).not.toThrow();
    expect(cap("daily", 10, 9)).not.toThrow();
    expect(cap("daily", 10, 10)).toThrow(/caps the offset at 9/);
  });
});
