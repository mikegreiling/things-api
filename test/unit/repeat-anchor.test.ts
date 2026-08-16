/**
 * The fixed-recurrence DEFAULT-anchor helpers + weekly-weekday derivation (issue
 * #476). The pinned "today" is Sunday 2026-07-05 throughout: the next Wednesday
 * is 2026-07-08 and the next Sunday is today itself. The wrong-phase REFUSAL
 * these once fed was deleted (ANCH2: the Repeat dialog's "Next:" field is drivable
 * and honored, so the promote verbs DRIVE the first occurrence rather than refuse
 * — docs/lab/anch2-next-field.md); the helpers below remain as the DEFAULT spawn
 * model the simulator uses when no first occurrence is requested.
 */
import { describe, expect, it } from "vitest";

import type { RepeatRuleParams } from "../../src/write/operations.ts";
import {
  deriveWeeklyWeekdays,
  fixedFirstOccurrence,
  fixedSpawnPlan,
  nextFixedOccurrenceAfter,
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
