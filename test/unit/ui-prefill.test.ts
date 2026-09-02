/**
 * THE DEFAULTS LAW AS ARITHMETIC (DEFAULTS2) — the seed-derived pre-fill
 * predictions, and the recipe wiring that turns each of them into a READ.
 *
 * Every assertion here is a cell of DEFAULTS1's 70-cell matrix or one of its
 * measured ABSENCES (docs/lab/defaults1-repeat-dialog-defaults.md §3/§4/§5/§8),
 * plus the correction DEFAULTS2 measured on the after-completion deadline offset.
 * The absences matter as much as the presences: this module's whole safety is
 * that it nominates a control for verification and never authorizes a skip, so a
 * key it should NOT claim is the failure worth catching.
 *
 * No GUI fires. The app version is pinned by the shared setup (3.23), which is
 * the generation every one of these laws was measured against.
 */
import { describe, expect, it } from "vitest";

import { makeRepeatingRecipe, type RepeatRuleExtras } from "../../src/write/vectors/ui-recipes.ts";
import {
  prefillAnchorDate,
  type PrefillKey,
  type PrefillRule,
  provenPrefills,
  type SeedRowFacts,
  seedScheduleFor,
} from "../../src/write/vectors/ui-prefill.ts";
import { parsePrefillReport } from "../../src/write/vectors/ui.ts";
import type { UiStep } from "../../src/write/vectors/types.ts";

/** The pinned clock DEFAULTS1 probed under: 2026-07-05, a Sunday. */
const TODAY = "2026-07-05";
/** 2026-07-09, a Thursday — DEFAULTS1's S3 seed. */
const THU = "2026-07-09";

function seed(over: Partial<SeedRowFacts> = {}): SeedRowFacts {
  return { scheduled: THU, today: TODAY, deadline: null, reminder: null, ...over };
}

function keys(rule: PrefillRule, facts: SeedRowFacts = seed()): PrefillKey[] {
  return [...provenPrefills(rule, facts, "3.23")].toSorted();
}

describe("the anchor date (DEFAULTS1-1)", () => {
  it("is the row's scheduled date when that is today or later", () => {
    expect(prefillAnchorDate(seed({ scheduled: THU }))).toBe(THU);
    expect(prefillAnchorDate(seed({ scheduled: TODAY }))).toBe(TODAY);
    expect(prefillAnchorDate(seed({ scheduled: "2026-11-19" }))).toBe("2026-11-19");
  });

  it("takes the DEADLINE when the row carries one, because that re-anchors the row", () => {
    // DEFAULTS1 §4 cell S11: start 07-09 with a deadline 07-12 pre-fills Next:
    // Jul 12, weekly Sunday, monthly 12th — the deadline's geometry throughout.
    // `make-repeating` on a to-do that already has a deadline reaches this: the
    // clone inherits it.
    expect(prefillAnchorDate(seed({ scheduled: THU, deadline: "2026-07-12" }))).toBe("2026-07-12");
    // …and the flattened case (S12, oddities §31): a deadline BEFORE the start is
    // discarded by the dialog, which anchors on the start. One maximum, both cells.
    expect(prefillAnchorDate(seed({ scheduled: THU, deadline: "2026-07-06" }))).toBe(THU);
    expect(prefillAnchorDate(seed({ scheduled: THU, deadline: THU }))).toBe(THU);
  });

  it("proves NOTHING for a deadline with no scheduled date (§10.3 is unexplained)", () => {
    const k = keys(
      { frequency: "weekly", interval: 1, weekdays: ["thursday"], next: THU },
      seed({ scheduled: null, deadline: "2026-07-16" }),
    );
    expect(k).toEqual([]);
  });

  it("declines every anchor key when the seed's deadline moves the anchor off the request", () => {
    // The shape a deadlined SOURCE produces: the rule asks for the START's
    // geometry, the dialog will show the DUE date's. Nothing may be claimed.
    const k = keys(
      { frequency: "weekly", interval: 1, weekdays: ["thursday"], next: THU },
      seed({ scheduled: THU, deadline: "2026-07-12" }),
    );
    expect(k).not.toContain("next");
    expect(k).not.toContain("weekdays");
    expect(k).toContain("interval");
  });

  it("falls back to TODAY for every seed with no usable future date", () => {
    // Inbox / Someday / Anytime (S5/S6/S14) all read as no scheduled date, and
    // `evening` (S7) reads as today — one answer covers them.
    expect(prefillAnchorDate(seed({ scheduled: null }))).toBe(TODAY);
    // An overdue row is not a state the URL scheme can even produce (a past
    // `when` is clamped to today, §3.1) — but if one arrived, today is the answer
    // the dialog would give.
    expect(prefillAnchorDate(seed({ scheduled: "2026-06-20" }))).toBe(TODAY);
  });
});

describe("what a seed PROVES (DEFAULTS1 §3)", () => {
  it("claims the interval only at 1 — it is `1` in every cell of the matrix", () => {
    expect(keys({ frequency: "daily", interval: 1 })).toContain("interval");
    expect(keys({ frequency: "daily", interval: 3 })).not.toContain("interval");
  });

  it("claims `Next:` when the requested first occurrence IS the anchor", () => {
    expect(keys({ frequency: "daily", interval: 1, next: THU })).toContain("next");
    expect(keys({ frequency: "daily", interval: 1, next: "2026-07-10" })).not.toContain("next");
  });

  it("claims the weekly weekday only for a single weekday on the anchor's own day", () => {
    // 2026-07-09 is a Thursday.
    expect(keys({ frequency: "weekly", interval: 1, weekdays: ["thursday"] })).toContain(
      "weekdays",
    );
    expect(keys({ frequency: "weekly", interval: 1, weekdays: ["friday"] })).not.toContain(
      "weekdays",
    );
    // A weekday set is always exactly ONE row (§8), so a multi-weekday request
    // always converges — even when the anchor is one of its members.
    expect(
      keys({ frequency: "weekly", interval: 1, weekdays: ["thursday", "monday"] }),
    ).not.toContain("weekdays");
  });

  it("claims the monthly day-of-month anchor, and never `last` or an ordinal weekday", () => {
    const day9 = keys({ frequency: "monthly", interval: 1, monthly: { day: 9 } });
    expect(day9).toContain("monthly-mode");
    expect(day9).toContain("monthly-ordinal");
    expect(keys({ frequency: "monthly", interval: 1, monthly: { day: 12 } })).not.toContain(
      "monthly-ordinal",
    );
    // `last` is never selected (§8) even on a seed that IS the month's last day.
    expect(
      keys(
        { frequency: "monthly", interval: 1, monthly: { day: "last" } },
        seed({ scheduled: "2026-07-31" }),
      ),
    ).toEqual(["interval"]);
    // DEFAULTS1-2: a seed ON the first Monday pre-fills `3rd`, not `Monday`/`1st`.
    expect(
      keys(
        { frequency: "monthly", interval: 1, monthly: { weekday: "monday", ordinal: 1 } },
        seed({ scheduled: "2026-08-03" }),
      ),
    ).toEqual(["interval"]);
  });

  it("claims the yearly month and day independently", () => {
    const both = keys({ frequency: "yearly", interval: 1, yearly: { month: 7, day: 9 } });
    expect(both).toContain("yearly-month");
    expect(both).toContain("yearly-mode");
    expect(both).toContain("yearly-ordinal");
    // A right month with a wrong day keeps the ordinal actuation and nothing else.
    const monthOnly = keys({ frequency: "yearly", interval: 1, yearly: { month: 7, day: 12 } });
    expect(monthOnly).toContain("yearly-month");
    expect(monthOnly).not.toContain("yearly-ordinal");
  });

  it("claims the after-completion unit only for weekly — the opening default is `week`", () => {
    expect(keys({ frequency: "weekly", interval: 1, afterCompletion: true })).toEqual([
      "ac-unit",
      "interval",
    ]);
    expect(keys({ frequency: "monthly", interval: 1, afterCompletion: true })).toEqual([
      "interval",
    ]);
  });

  it("reaches no anchor at all under after-completion — that state has no Next: control", () => {
    const k = keys({
      frequency: "weekly",
      interval: 1,
      afterCompletion: true,
      next: THU,
      weekdays: ["thursday"],
    });
    expect(k).not.toContain("next");
    expect(k).not.toContain("weekdays");
  });
});

describe("deadlines (DEFAULTS1 §4, corrected by DEFAULTS2 §clamp)", () => {
  it("claims nothing on the SHIPPED seed shaping — the seed stays deadline-free", () => {
    // Option B: the seed is scheduled ON the due date and carries no deadline, so
    // `Add deadlines` comes up UNticked and both deadline controls are driven.
    const k = keys(
      { frequency: "weekly", interval: 1, deadline: true, startDaysEarlier: 3, next: THU },
      seed({ scheduled: THU, deadline: null }),
    );
    expect(k).not.toContain("add-deadlines");
    expect(k).not.toContain("start-earlier");
    // What the shaping DOES buy is the anchor.
    expect(k).toContain("next");
  });

  it("claims the offset only when the seed's own two dates produce it", () => {
    const k = keys(
      { frequency: "weekly", interval: 1, deadline: true, startDaysEarlier: 3 },
      seed({ scheduled: "2026-07-09", deadline: "2026-07-12" }),
    );
    expect(k).toContain("add-deadlines");
    expect(k).toContain("start-earlier");
    // A seed whose gap disagrees with the request keeps the offset actuation.
    const off = keys(
      { frequency: "weekly", interval: 1, deadline: true, startDaysEarlier: 5 },
      seed({ scheduled: "2026-07-09", deadline: "2026-07-12" }),
    );
    expect(off).toContain("add-deadlines");
    expect(off).not.toContain("start-earlier");
  });

  it("never claims the offset under after-completion — the pre-fill is CLAMPED there", () => {
    // DEFAULTS2's correction to DEFAULTS1 §4: with a far-future deadline on the
    // row the fixed cadences pre-fill the full offset while `after completion`
    // shows a much smaller number, so the fixed-cadence arithmetic is simply not
    // the after-completion value and must never be claimed as it.
    const k = keys(
      {
        frequency: "weekly",
        interval: 1,
        afterCompletion: true,
        deadline: true,
        startDaysEarlier: 30,
      },
      seed({ scheduled: "2026-07-09", deadline: "2026-08-08" }),
    );
    expect(k).toContain("add-deadlines");
    expect(k).not.toContain("start-earlier");
  });

  it("claims the unticked box when the rule asks for no deadline and the seed has none", () => {
    expect(
      keys({ frequency: "weekly", interval: 1, deadline: false }, seed({ deadline: null })),
    ).toContain("add-deadlines");
  });
});

describe("reminders (DEFAULTS1-3)", () => {
  it("claims the tick from the row's byte and the time only when it matches", () => {
    const both = keys(
      { frequency: "daily", interval: 1, reminder: "09:30" },
      seed({ reminder: "09:30" }),
    );
    expect(both).toContain("add-reminders");
    expect(both).toContain("reminder-time");
    const tickOnly = keys(
      { frequency: "daily", interval: 1, reminder: "18:00" },
      seed({ reminder: "09:30" }),
    );
    expect(tickOnly).toContain("add-reminders");
    expect(tickOnly).not.toContain("reminder-time");
  });

  it("claims neither when the seed carries no reminder at all", () => {
    const k = keys(
      { frequency: "daily", interval: 1, reminder: "09:30" },
      seed({ reminder: null }),
    );
    expect(k).not.toContain("add-reminders");
    expect(k).not.toContain("reminder-time");
  });
});

describe("the gates", () => {
  it("claims NOTHING on an app generation the manifest was never sat with", () => {
    const rule: PrefillRule = { frequency: "weekly", interval: 1, weekdays: ["thursday"] };
    expect([...provenPrefills(rule, seed(), "3.24")]).toEqual([]);
    expect([...provenPrefills(rule, seed(), null)]).toEqual([]);
    // And the generation it WAS sat with, plus its point releases.
    expect([...provenPrefills(rule, seed(), "3.23.2")].length).toBeGreaterThan(0);
  });
});

describe("the seed-shaping date (DEFAULTS1 §9.3 option B)", () => {
  it("is the DUE date for a deadlined rule and null for everything else", () => {
    expect(seedScheduleFor("2026-07-09", 3, TODAY)).toBe("2026-07-12");
    // Undeadlined: the requested start already IS the anchor.
    expect(seedScheduleFor("2026-07-09", 0, TODAY)).toBe("2026-07-09");
    expect(seedScheduleFor(undefined, 3, TODAY)).toBeNull();
    expect(seedScheduleFor("someday", 3, TODAY)).toBeNull();
  });

  it("refuses a date the URL scheme would clamp to today (§3.1)", () => {
    // A due date already past cannot be held by the seed at all, so claiming its
    // pre-fill would be claiming an anchor of today.
    expect(seedScheduleFor("2026-06-01", 3, TODAY)).toBeNull();
  });
});

/* ------------------------------------------------ the recipe wiring */

function stepsOf(extras: Parameters<typeof makeRepeatingRecipe>[3]): UiStep[] {
  return makeRepeatingRecipe("T-1", "weekly", 1, extras).steps;
}

const SEEDED: RepeatRuleExtras = {
  weekdays: ["thursday"],
  next: THU,
  reminder: "09:30",
  seed: seed({ reminder: "09:30" }),
};

/** The same vocabulary with no seed — the shape every reschedule compiles. */
const UNSEEDED: RepeatRuleExtras = { weekdays: ["thursday"], next: THU, reminder: "09:30" };

describe("the recipe turns each proven pre-fill into a read (DEFAULTS2)", () => {
  it("emits ONE verify-prefill hop, after the shape probe and before every setter", () => {
    const steps = stepsOf(SEEDED);
    const verify = steps.findIndex((s) => s.primitive === "verify-prefill");
    const probe = steps.findIndex((s) => s.primitive === "probe-dialog-shape");
    const interval = steps.findIndex((s) => s.primitive === "set-group-number");
    expect(steps.filter((s) => s.primitive === "verify-prefill")).toHaveLength(1);
    expect(probe).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(probe);
    expect(verify).toBeLessThan(interval);
  });

  it("tags the interval setter, so the hop that types nothing can disappear", () => {
    const tagged = stepsOf(SEEDED).find((s) => s.primitive === "set-group-number");
    expect(tagged?.unlessPrefilled).toBe("interval");
    // At interval > 1 the field really is typed and the tag must be absent.
    const typed = makeRepeatingRecipe("T-1", "weekly", 3, SEEDED).steps.find(
      (s) => s.primitive === "set-group-number",
    );
    expect(typed?.unlessPrefilled).toBeUndefined();
  });

  it("keeps EVERY setter in the step list, so the pre-commit audit is unchanged", () => {
    const audit = (seeded: boolean) => {
      const steps = seeded ? stepsOf(SEEDED) : stepsOf(UNSEEDED);
      const step = steps.find((s) => s.primitive === "audit-dialog");
      return (step?.audit?.controls ?? []).map((c) => c.label).toSorted();
    };
    // The seeded recipe skips actuations; it audits exactly the same controls.
    expect(audit(true)).toEqual(audit(false));
    expect(audit(true).length).toBeGreaterThan(3);
  });

  it("gives the verify hop a control for every tagged setter, and only those", () => {
    const steps = stepsOf(SEEDED);
    const tagged = steps
      .filter((s) => s.unlessPrefilled !== undefined)
      .map((s) => s.unlessPrefilled)
      .toSorted();
    const read = (steps.find((s) => s.primitive === "verify-prefill")?.audit?.controls ?? [])
      .map((c) => c.prefillKey)
      .toSorted();
    expect(read).toEqual(tagged);
    expect(read.length).toBeGreaterThan(0);
    // It never commits: a hop that can only read cannot land a rule.
    expect(steps.find((s) => s.primitive === "verify-prefill")?.audit?.commits).toBeUndefined();
  });

  it("emits no verify hop, and no tag, without a seed — every reschedule", () => {
    const steps = stepsOf(UNSEEDED);
    expect(steps.some((s) => s.primitive === "verify-prefill")).toBe(false);
    expect(steps.some((s) => s.unlessPrefilled !== undefined)).toBe(false);
  });

  it("emits no verify hop when the seed proves nothing", () => {
    // An interval > 1 with an anchor the seed does not produce: nothing to read.
    const steps = makeRepeatingRecipe("T-1", "weekly", 4, {
      weekdays: ["monday"],
      next: "2026-07-13",
      seed: seed(),
    }).steps;
    expect(steps.some((s) => s.primitive === "verify-prefill")).toBe(false);
  });
});

describe("the verify hop's report", () => {
  it("confirms only what said ok, and never guesses from junk", () => {
    const r = parsePrefillReport(
      "interval|ok~next|miss|Sun, Jul 12, 2026 = 2026-07-12~weekdays|ok",
    );
    expect(r.confirmed.toSorted()).toEqual(["interval", "weekdays"]);
    expect(r.missed).toEqual([{ key: "next", observed: "Sun, Jul 12, 2026 = 2026-07-12" }]);
    // Unparseable output confirms nothing — every setter then runs.
    expect(parsePrefillReport("").confirmed).toEqual([]);
    expect(parsePrefillReport("what?").confirmed).toEqual([]);
  });
});
