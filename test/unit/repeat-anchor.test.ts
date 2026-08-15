/**
 * The fixed-recurrence anchor law helpers (issue #476, ANCH1). The pinned "today"
 * is Sunday 2026-07-05 throughout (the ANCH1 clock): the next Wednesday is
 * 2026-07-08 and the next Sunday is today itself. Evidence: docs/lab/anch1-repeat-anchor.md.
 */
import { describe, expect, it } from "vitest";

import type { RepeatRuleParams } from "../../src/write/operations.ts";
import {
  appAnchorDescription,
  deriveWeeklyWeekdays,
  fixedFirstOccurrence,
  fixedSpawnPlan,
  nextFixedOccurrenceAfter,
  requestedPhaseHonored,
  weekdayOfIso,
} from "../../src/write/repeat-anchor.ts";

const TODAY = "2026-07-05"; // a Sunday
type Rule = Pick<RepeatRuleParams, "frequency" | "interval" | "weekdays" | "afterCompletion">;
const weekly = (interval: number, weekdays?: Rule["weekdays"]): Rule => ({
  frequency: "weekly",
  interval,
  ...(weekdays !== undefined && { weekdays }),
});

describe("weekdayOfIso", () => {
  it("returns 0 for Sunday … 6 for Saturday", () => {
    expect(weekdayOfIso("2026-07-05")).toBe(0); // Sun
    expect(weekdayOfIso("2026-07-06")).toBe(1); // Mon
    expect(weekdayOfIso("2026-07-08")).toBe(3); // Wed
    expect(weekdayOfIso("2026-07-11")).toBe(6); // Sat
  });
});

describe("deriveWeeklyWeekdays — issue #476 item 3", () => {
  it("derives the weekday from a concrete anchor date when weekly omits weekdays", () => {
    expect(deriveWeeklyWeekdays(weekly(2), "2026-07-15")).toEqual(["wednesday"]);
    expect(deriveWeeklyWeekdays(weekly(1), "2026-07-05")).toEqual(["sunday"]);
  });
  it("does not override an explicit weekday set", () => {
    expect(deriveWeeklyWeekdays(weekly(2, ["monday"]), "2026-07-15")).toBeUndefined();
  });
  it("no derivation for non-weekly, after-completion, or a keyword/absent date", () => {
    expect(deriveWeeklyWeekdays({ frequency: "daily", interval: 1 }, "2026-07-15")).toBeUndefined();
    expect(
      deriveWeeklyWeekdays(
        { frequency: "weekly", interval: 1, afterCompletion: true },
        "2026-07-15",
      ),
    ).toBeUndefined();
    expect(deriveWeeklyWeekdays(weekly(2), "someday")).toBeUndefined();
    expect(deriveWeeklyWeekdays(weekly(2), null)).toBeUndefined();
  });
});

describe("fixedFirstOccurrence — next calendar match on/after today", () => {
  it("weekly Wednesday from a Sunday → the next Wednesday", () => {
    expect(fixedFirstOccurrence(weekly(2, ["wednesday"]), TODAY)).toBe("2026-07-08");
  });
  it("weekly Sunday from a Sunday → today", () => {
    expect(fixedFirstOccurrence(weekly(2, ["sunday"]), TODAY)).toBe("2026-07-05");
  });
  it("weekly with no weekdays defaults to Sunday", () => {
    expect(fixedFirstOccurrence(weekly(2), "2026-07-06")).toBe("2026-07-12"); // next Sun from Mon
  });
  it("daily → today; monthly/yearly unguarded → null", () => {
    expect(fixedFirstOccurrence({ frequency: "daily", interval: 3 }, TODAY)).toBe(TODAY);
    expect(fixedFirstOccurrence({ frequency: "monthly", interval: 2 }, TODAY)).toBeNull();
  });
});

describe("requestedPhaseHonored — the wrong-phase refusal predicate (issue #476 item 2)", () => {
  it("interval-2 weekly: DROPS a source date one week off the app's phase", () => {
    // App anchors Wed 07-08; the interval-2 grid is {07-08, 07-22, …}. 07-15 is off-phase.
    expect(requestedPhaseHonored(weekly(2, ["wednesday"]), TODAY, "2026-07-15")).toBe(false);
    expect(requestedPhaseHonored(weekly(2, ["wednesday"]), TODAY, "2026-07-29")).toBe(false);
  });
  it("interval-2 weekly: HONORS a source date ON the app's phase", () => {
    expect(requestedPhaseHonored(weekly(2, ["wednesday"]), TODAY, "2026-07-08")).toBe(true); // the anchor
    expect(requestedPhaseHonored(weekly(2, ["wednesday"]), TODAY, "2026-07-22")).toBe(true); // +1 cycle
  });
  it("source date that IS the target weekday but the app's own anchor → honored", () => {
    // The classic issue-item-2 case: the source is scheduled on the target weekday.
    // When that date equals the app anchor phase it is honored (07-08), else dropped (07-15).
    expect(requestedPhaseHonored(weekly(2, ["wednesday"]), TODAY, "2026-07-08")).toBe(true);
    expect(requestedPhaseHonored(weekly(2, ["wednesday"]), TODAY, "2026-07-15")).toBe(false);
  });
  it("interval-1 weekly: phase is irrelevant — always honored", () => {
    expect(requestedPhaseHonored(weekly(1, ["wednesday"]), TODAY, "2026-07-15")).toBe(true);
    expect(requestedPhaseHonored(weekly(1, ["wednesday"]), TODAY, "2026-07-22")).toBe(true);
  });
  it("a source date on a DIFFERENT weekday than the rule is no phase claim → honored", () => {
    // Source on a Thursday but the rule fires Wednesday: not a pattern match.
    expect(requestedPhaseHonored(weekly(2, ["wednesday"]), TODAY, "2026-07-16")).toBe(true);
  });
  it("interval-2 daily: honors an even-day offset, drops an odd one", () => {
    const daily2: Rule = { frequency: "daily", interval: 2 };
    expect(requestedPhaseHonored(daily2, TODAY, "2026-07-07")).toBe(true); // +2
    expect(requestedPhaseHonored(daily2, TODAY, "2026-07-08")).toBe(false); // +3
  });
  it("after-completion, keyword when, and monthly/yearly are never refused", () => {
    expect(
      requestedPhaseHonored(
        { frequency: "weekly", interval: 2, afterCompletion: true },
        TODAY,
        "2026-07-15",
      ),
    ).toBe(true);
    expect(requestedPhaseHonored(weekly(2, ["wednesday"]), TODAY, "someday")).toBe(true);
    expect(requestedPhaseHonored({ frequency: "monthly", interval: 2 }, TODAY, "2026-09-15")).toBe(
      true,
    );
  });
  it("multi-weekday interval-2: active-week grid decides membership", () => {
    const r = weekly(2, ["monday", "wednesday"]);
    // App anchor = Mon 07-06 (week 0). Week 0 active: 07-06(Mon), 07-08(Wed) honored.
    expect(requestedPhaseHonored(r, TODAY, "2026-07-06")).toBe(true);
    expect(requestedPhaseHonored(r, TODAY, "2026-07-08")).toBe(true);
    // Week 1 (07-13/07-15) inactive; week 2 (07-20/07-22) active.
    expect(requestedPhaseHonored(r, TODAY, "2026-07-15")).toBe(false);
    expect(requestedPhaseHonored(r, TODAY, "2026-07-20")).toBe(true);
  });
});

describe("nextFixedOccurrenceAfter + fixedSpawnPlan — the app spawn shape", () => {
  it("weekly Wednesday from Sunday: future first occ → no instance, cursor = the first occ", () => {
    const plan = fixedSpawnPlan(weekly(2, ["wednesday"]), TODAY);
    expect(plan.refIso).toBe("2026-07-08");
    expect(plan.instanceStartIso).toBeNull(); // today (Sun) is not an occurrence
    expect(plan.cursorIso).toBe("2026-07-08");
    expect(plan.instanceCount).toBe(0);
  });
  it("weekly Sunday from Sunday: today IS an occurrence → instance today, cursor next cycle", () => {
    const plan = fixedSpawnPlan(weekly(2, ["sunday"]), TODAY);
    expect(plan.instanceStartIso).toBe("2026-07-05");
    expect(plan.cursorIso).toBe("2026-07-19"); // +2 weeks
    expect(plan.instanceCount).toBe(1);
  });
  it("daily/2: instance today, cursor +2 days", () => {
    const plan = fixedSpawnPlan({ frequency: "daily", interval: 2 }, TODAY);
    expect(plan.instanceStartIso).toBe(TODAY);
    expect(plan.cursorIso).toBe("2026-07-07");
    expect(nextFixedOccurrenceAfter({ frequency: "daily", interval: 2 }, TODAY)).toBe("2026-07-07");
  });
});

describe("appAnchorDescription", () => {
  it("names the app's first occurrence and its weekday", () => {
    expect(appAnchorDescription(weekly(2, ["wednesday"]), TODAY)).toBe(
      "2026-07-08 (the next wednesday on or after today)",
    );
  });
});
