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
  assessOffRuleFirst,
  deadlineDriveNext,
  deriveFixedAnchor,
  deriveMonthlyAnchor,
  deriveWeeklyWeekdays,
  deriveYearlyAnchor,
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

describe("deriveMonthlyAnchor / deriveYearlyAnchor — YANCH1 #493 (completes the family)", () => {
  it("monthly: derives the day-of-month from a concrete date when no anchor given", () => {
    expect(deriveMonthlyAnchor({ frequency: "monthly" }, "2027-10-16")).toEqual({ day: 16 });
    expect(deriveMonthlyAnchor({ frequency: "monthly" }, "2026-07-31")).toEqual({ day: 31 });
  });
  it("yearly: derives month + day from a concrete date when no anchor given", () => {
    expect(deriveYearlyAnchor({ frequency: "yearly" }, "2027-10-16")).toEqual({
      month: 10,
      day: 16,
    });
  });
  it("does not override an explicit anchor", () => {
    expect(
      deriveMonthlyAnchor({ frequency: "monthly", monthly: { day: "last" } }, "2027-10-16"),
    ).toBeUndefined();
    expect(
      deriveYearlyAnchor({ frequency: "yearly", yearly: { month: 3, day: 1 } }, "2027-10-16"),
    ).toBeUndefined();
  });
  it("no derivation for the wrong frequency, after-completion, or a non-concrete date", () => {
    expect(deriveMonthlyAnchor({ frequency: "yearly" }, "2027-10-16")).toBeUndefined();
    expect(deriveYearlyAnchor({ frequency: "monthly" }, "2027-10-16")).toBeUndefined();
    expect(
      deriveMonthlyAnchor({ frequency: "monthly", afterCompletion: true }, "2027-10-16"),
    ).toBeUndefined();
    expect(deriveYearlyAnchor({ frequency: "yearly" }, "someday")).toBeUndefined();
    expect(deriveMonthlyAnchor({ frequency: "monthly" }, null)).toBeUndefined();
  });
});

describe("deriveFixedAnchor — the unified weekly/monthly/yearly patch (YANCH1 #493)", () => {
  it("yearly with a concrete date and no anchor → drives the derived month+day", () => {
    expect(deriveFixedAnchor({ frequency: "yearly", interval: 1 }, "2027-10-16")).toEqual({
      yearly: { month: 10, day: 16 },
    });
  });
  it("monthly → derived day; weekly → derived weekday", () => {
    expect(deriveFixedAnchor({ frequency: "monthly", interval: 1 }, "2027-10-16")).toEqual({
      monthly: { day: 16 },
    });
    expect(deriveFixedAnchor({ frequency: "weekly", interval: 2 }, "2026-07-15")).toEqual({
      weekdays: ["wednesday"],
    });
  });
  it("empty patch for daily, an explicit anchor, after-completion, or no date", () => {
    expect(deriveFixedAnchor({ frequency: "daily", interval: 1 }, "2027-10-16")).toEqual({});
    expect(
      deriveFixedAnchor(
        { frequency: "yearly", interval: 1, yearly: { month: 1, day: 1 } },
        "2027-10-16",
      ),
    ).toEqual({});
    expect(
      deriveFixedAnchor({ frequency: "yearly", interval: 1, afterCompletion: true }, "2027-10-16"),
    ).toEqual({});
    expect(deriveFixedAnchor({ frequency: "yearly", interval: 1 }, null)).toEqual({});
  });
});

describe("deadlineDriveNext — deadline-mode Next shift (YANCH1 #493)", () => {
  it("shifts the drive date forward by startDaysEarlier for a deadlined rule", () => {
    // --when is the scheduled START; the dialog anchors on the DEADLINE (start + N),
    // so the "Next:" field is driven with when + N and the app back-shifts the start.
    expect(deadlineDriveNext({ next: "2027-10-16", deadline: true, startDaysEarlier: 14 })).toBe(
      "2027-10-30",
    );
    expect(deadlineDriveNext({ next: "2026-09-22", deadline: true, startDaysEarlier: 21 })).toBe(
      "2026-10-13",
    );
  });
  it("drives --when verbatim when not deadlined (or start-offset 0)", () => {
    expect(deadlineDriveNext({ next: "2027-10-16" })).toBe("2027-10-16");
    expect(deadlineDriveNext({ next: "2027-10-16", deadline: true })).toBe("2027-10-16");
  });
  it("undefined when there is no concrete first-occurrence date", () => {
    expect(deadlineDriveNext({ deadline: true, startDaysEarlier: 14 })).toBeUndefined();
  });
});

describe("assessOffRuleFirst — off-rule-first classification (DACON1, golden-v3 evidence)", () => {
  it("null when there is no off-rule first (on-rule, --when-only, after-completion, daily, no --when)", () => {
    // on-rule weekly (Oct 18 2028 IS a Wednesday)
    expect(
      assessOffRuleFirst({
        frequency: "weekly",
        interval: 1,
        next: "2028-10-18",
        weekdays: ["wednesday"],
      }),
    ).toBeNull();
    // --when only (no explicit anchor → derived, never off-rule)
    expect(assessOffRuleFirst({ frequency: "yearly", interval: 1, next: "2028-10-16" })).toBeNull();
    // no --when
    expect(
      assessOffRuleFirst({ frequency: "monthly", interval: 1, monthly: { day: 1 } }),
    ).toBeNull();
    // after-completion + daily
    expect(
      assessOffRuleFirst({
        frequency: "weekly",
        interval: 1,
        next: "2028-10-19",
        weekdays: ["wednesday"],
        afterCompletion: true,
      }),
    ).toBeNull();
    expect(
      assessOffRuleFirst({
        frequency: "daily",
        interval: 1,
        next: "2028-10-16",
        deadline: true,
        startDaysEarlier: 14,
      }),
    ).toBeNull();
  });

  it("weekly off-rule first is HONORED — discloses both halves (appears when; thereafter the weekdays)", () => {
    // Oct 19 2028 is a Thursday; anchor is Wednesday.
    const a = assessOffRuleFirst({
      frequency: "weekly",
      interval: 1,
      next: "2028-10-19",
      weekdays: ["wednesday"],
    });
    expect(a?.kind).toBe("honored");
    if (a?.kind === "honored") {
      expect(a.disclosure.appearsIso).toBe("2028-10-19");
      expect(a.disclosure.dueIso).toBeNull();
      expect(a.disclosure.message).toMatch(/appears 2028-10-19.*thereafter.*wednesday/s);
    }
  });

  it("yearly off-rule first under a deadline is HONORED — the live-host CREATE shape", () => {
    // --when Oct 16 + 14 ⇒ due Oct 30; anchor names the Oct-16 due date → off-rule first.
    const a = assessOffRuleFirst({
      frequency: "yearly",
      interval: 1,
      next: "2028-10-16",
      yearly: { month: 10, day: 16 },
      deadline: true,
      startDaysEarlier: 14,
    });
    expect(a?.kind).toBe("honored");
    if (a?.kind === "honored") {
      expect(a.disclosure.appearsIso).toBe("2028-10-16");
      expect(a.disclosure.dueIso).toBe("2028-10-30");
      expect(a.disclosure.message).toMatch(
        /appears 2028-10-16, due 2028-10-30.*thereafter.*14 days earlier/s,
      );
    }
  });

  it("RSPA1-D: a PRESERVED deadline (no --deadline flag) makes --when the DUE date — appears offset days earlier", () => {
    // The exact RSPA1 cell (b) shape: reschedule an already-deadlined (ts=-14) yearly
    // template with an explicit Oct-16 anchor + --when 2028-11-05 and NO --deadline. The
    // request carries no shift (params shift 0), so the drive sets Next=2028-11-05 verbatim;
    // the app reads that as the DUE date of the still-deadlined rule and back-shifts the
    // START to 2028-10-22 (Nov 5 − 14). Threading the template's preserved -14 offset makes
    // the disclosure state the TRUE appear (Oct 22) / due (Nov 5), not the old "appears Nov 5".
    const a = assessOffRuleFirst(
      {
        frequency: "yearly",
        interval: 1,
        next: "2028-11-05",
        yearly: { month: 10, day: 16 },
      },
      -14,
    );
    expect(a?.kind).toBe("honored");
    if (a?.kind === "honored") {
      expect(a.disclosure.appearsIso).toBe("2028-10-22");
      expect(a.disclosure.dueIso).toBe("2028-11-05");
      expect(a.disclosure.message).toMatch(
        /appears 2028-10-22, due 2028-11-05.*thereafter.*month 10 on day 16.*14 days earlier/s,
      );
    }
  });

  it("RSPA1-D: no preserved offset (or a non-deadlined template) keeps the plain --when appear date", () => {
    // Without a preserved offset the disclosure is unchanged: appears --when, no due.
    const noOffset = assessOffRuleFirst({
      frequency: "yearly",
      interval: 1,
      next: "2028-11-05",
      yearly: { month: 10, day: 16 },
    });
    expect(noOffset?.kind).toBe("honored");
    if (noOffset?.kind === "honored") {
      expect(noOffset.disclosure.appearsIso).toBe("2028-11-05");
      expect(noOffset.disclosure.dueIso).toBeNull();
    }
    // An EXPLICIT deadline still wins over a (redundant) preserved offset: --when is the start.
    const explicit = assessOffRuleFirst(
      {
        frequency: "yearly",
        interval: 1,
        next: "2028-10-16",
        yearly: { month: 10, day: 16 },
        deadline: true,
        startDaysEarlier: 14,
      },
      -14,
    );
    expect(explicit?.kind).toBe("honored");
    if (explicit?.kind === "honored") {
      expect(explicit.disclosure.appearsIso).toBe("2028-10-16");
      expect(explicit.disclosure.dueIso).toBe("2028-10-30");
    }
  });

  it("monthly off-rule first is DISHONORED — fail-closed refusal naming the alternatives", () => {
    const a = assessOffRuleFirst({
      frequency: "monthly",
      interval: 1,
      next: "2028-10-16",
      monthly: { day: 1 },
    });
    expect(a?.kind).toBe("dishonored");
    if (a?.kind === "dishonored") {
      expect(a.refusal).toMatch(
        /monthly rule cannot start off its anchor.*day 1.*omit the monthly anchor/s,
      );
    }
    // on-rule monthly (day 16 = --when) → null
    expect(
      assessOffRuleFirst({
        frequency: "monthly",
        interval: 1,
        next: "2028-10-16",
        monthly: { day: 16 },
      }),
    ).toBeNull();
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
