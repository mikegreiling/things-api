/**
 * Recipe shape for the full-vocabulary Repeat dialog: the make/reschedule
 * recipes must drive the right controls, via the right primitives, addressed in
 * BOTH dialog forms (attached sheet + detached AXUnknown window). No GUI fires —
 * these assert the compiled step list only.
 */
import { describe, expect, it } from "vitest";

import {
  makeRepeatingRecipe,
  projectMakeRepeatingRecipe,
  rescheduleRepeatRecipe,
  type RepeatRuleExtras,
} from "../../src/write/vectors/ui-recipes.ts";
import type { UiStep } from "../../src/write/vectors/types.ts";

/** The dialog-entry steps (those addressed by pathCandidates). */
function dialogSteps(
  extras: RepeatRuleExtras,
  frequency: "daily" | "weekly" | "monthly" | "yearly" = "weekly",
  interval = 1,
) {
  const recipe = makeRepeatingRecipe("T-1", frequency, interval, extras);
  return recipe.steps.filter((s) => s.pathCandidates !== undefined);
}
const labels = (steps: UiStep[]) => steps.map((s) => s.label);

/** ALL dialog-entry steps (pop-ups/fields AND the role-addressed date pickers). */
function allDialogSteps(
  extras: RepeatRuleExtras,
  frequency: "daily" | "weekly" | "monthly" | "yearly" = "weekly",
) {
  return makeRepeatingRecipe("T-1", frequency, 1, extras).steps.filter(
    (s) => s.pathCandidates !== undefined || s.primitive === "set-datetime",
  );
}

describe("repeat dialog recipe — dual-form addressing", () => {
  it("every dialog control is addressed in BOTH shapes (sheet [0], detached [1])", () => {
    const steps = dialogSteps({
      weekdays: ["monday", "wednesday"],
      ends: { kind: "after", count: 5 },
      reminder: "09:00",
    });
    expect(steps.length).toBeGreaterThan(3);
    for (const s of steps) {
      expect(s.pathCandidates).toHaveLength(2);
      expect(s.pathCandidates?.[0]).toContain("AXStandardWindow");
      expect(s.pathCandidates?.[1]).toContain("AXUnknown");
    }
  });

  it("base rule drives exactly wait -> frequency -> interval -> OK", () => {
    const steps = dialogSteps({});
    expect(steps.map((s) => s.primitive)).toEqual(["wait", "select-popup", "set-value", "press"]);
    expect(labels(steps)).toEqual([
      "the Repeat dialog",
      "frequency = weekly",
      "interval = 1",
      'press "OK"',
    ]);
  });
});

describe("repeat dialog recipe — per-control drive", () => {
  it("weekly multi-day: a weekday pop-up + a '+' add per extra day", () => {
    const steps = dialogSteps({ weekdays: ["monday", "wednesday", "friday"] });
    const l = labels(steps);
    expect(l).toContain("weekday = monday");
    expect(l.filter((x) => x.startsWith("add weekday row"))).toHaveLength(2);
    expect(l).toContain("weekday += wednesday");
    expect(l).toContain("weekday += friday");
  });

  it("monthly nth-weekday: mode + ordinal pop-ups", () => {
    const steps = dialogSteps({ monthly: { weekday: "friday", ordinal: "last" } }, "monthly");
    const l = labels(steps);
    expect(l).toContain("monthly weekday = friday");
    expect(l).toContain("monthly ordinal = last");
  });

  it("monthly day-of-month: mode=day + the day ordinal", () => {
    const steps = dialogSteps({ monthly: { day: 15 } }, "monthly");
    const select = steps.filter((s) => s.primitive === "select-popup");
    expect(select.map((s) => s.value)).toContain("day");
    expect(select.map((s) => s.value)).toContain("15th");
  });

  it("yearly: month + mode + ordinal pop-ups", () => {
    const steps = dialogSteps({ yearly: { month: 10, day: 8 } }, "yearly");
    const values = steps.filter((s) => s.primitive === "select-popup").map((s) => s.value);
    expect(values).toContain("October");
    expect(values).toContain("day");
    expect(values).toContain("8th");
  });

  it("after-completion: frequency = after completion + a SINGULAR unit pop-up", () => {
    const steps = dialogSteps({ afterCompletion: true });
    const values = steps.filter((s) => s.primitive === "select-popup").map((s) => s.value);
    expect(values).toContain("after completion");
    // the unit pop-up options are singular (day/week/month/year), not the frequency word
    expect(values).toContain("week");
    expect(values).not.toContain("weekly");
  });

  it("ends after N: an ends pop-up + a count field", () => {
    const steps = dialogSteps({ ends: { kind: "after", count: 7 } });
    expect(steps.find((s) => s.value === "after")?.primitive).toBe("select-popup");
    expect(steps.find((s) => s.value === "7")?.primitive).toBe("set-value");
  });

  it("ends on date: an ends pop-up + a set-datetime date picker (AXDateTimeArea, not a text field)", () => {
    const steps = allDialogSteps({ ends: { kind: "on-date", date: "2027-01-01" } });
    expect(steps.find((s) => s.value === "on date")?.primitive).toBe("select-popup");
    expect(steps.find((s) => s.value === "date:2027-01-01")?.primitive).toBe("set-datetime");
  });

  it("reminders: an Add-reminders checkbox press + a set-datetime time picker", () => {
    const steps = allDialogSteps({ reminder: "08:15" });
    expect(steps.find((s) => s.label === "check Add reminders")?.primitive).toBe("press");
    expect(steps.find((s) => s.value === "time:08:15")?.primitive).toBe("set-datetime");
  });

  it("deadline + start-earlier: an Add-deadlines checkbox press + an offset field", () => {
    const steps = dialogSteps({ deadline: true, startDaysEarlier: 3 });
    expect(steps.find((s) => s.label === "check Add deadlines")?.primitive).toBe("press");
    expect(steps.find((s) => s.value === "3")?.primitive).toBe("set-value");
  });

  it("OK is always the last dialog step", () => {
    const steps = dialogSteps({ weekdays: ["monday"], reminder: "09:00", deadline: true });
    expect(steps.at(-1)?.label).toBe('press "OK"');
  });
});

describe("repeat dialog recipe — shared by reschedule + project", () => {
  it("reschedule drives the same dialog controls", () => {
    const recipe = rescheduleRepeatRecipe("T-1", "monthly", 1, {
      monthly: { weekday: "tuesday", ordinal: 2 },
    });
    const values = recipe.steps.map((s) => s.value);
    expect(values).toContain("Tuesday");
    expect(values).toContain("2nd");
  });

  it("project make-repeating drives the same dialog controls", () => {
    const recipe = projectMakeRepeatingRecipe("AREA-1", "P-1", "Proj", "weekly", 2, {
      weekdays: ["monday", "thursday"],
    });
    const l = recipe.steps.map((s) => s.label);
    expect(l).toContain("weekday = monday");
    expect(l).toContain("weekday += thursday");
  });
});
