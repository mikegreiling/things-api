/**
 * Recipe shape for the full-vocabulary Repeat dialog: the make/reschedule
 * recipes must drive the right controls, via the right primitives, addressed in
 * BOTH dialog forms (attached sheet + detached AXUnknown window). No GUI fires —
 * these assert the compiled step list only.
 */
import { describe, expect, it } from "vitest";

import {
  convertToProjectRecipe,
  headingConvertToProjectRecipe,
  makeRepeatingRecipe,
  moveHeadingToProjectRecipe,
  pauseRepeatRecipe,
  projectMakeRepeatingRecipe,
  projectPauseRepeatRecipe,
  projectRescheduleRepeatRecipe,
  rescheduleRepeatRecipe,
  resumeRepeatRecipe,
  type RepeatRuleExtras,
} from "../../src/write/vectors/ui-recipes.ts";
import type { UiRecipe, UiStep } from "../../src/write/vectors/types.ts";

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

  it("after-completion: frequency = after completion + a plural-safe unit pop-up (defect (c))", () => {
    const steps = dialogSteps({ afterCompletion: true });
    const selects = steps.filter((s) => s.primitive === "select-popup");
    expect(selects.map((s) => s.value)).toContain("after completion");
    // The unit pop-up is driven by a CANDIDATE list (singular AND plural), not a
    // single label: the app pluralizes by interval (week @1, weeks @>1) and a
    // reschedule opens pre-populated with the current interval, so the singular
    // form alone died in the field report (0½ (c)). Both must be offered.
    const unit = selects.find((s) => s.valueCandidates !== undefined);
    expect(unit?.valueCandidates).toEqual(["week", "weeks"]);
    // it is NOT the frequency word
    expect(unit?.valueCandidates).not.toContain("weekly");
  });

  it("after-completion unit candidates are singular+plural for every frequency", () => {
    const cases: ["daily" | "weekly" | "monthly" | "yearly", [string, string]][] = [
      ["daily", ["day", "days"]],
      ["weekly", ["week", "weeks"]],
      ["monthly", ["month", "months"]],
      ["yearly", ["year", "years"]],
    ];
    for (const [freq, expected] of cases) {
      const steps = dialogSteps({ afterCompletion: true }, freq);
      const unit = steps.find((s) => s.valueCandidates !== undefined);
      expect(unit?.valueCandidates).toEqual(expected);
    }
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

  it("reminders: an ensure-checkbox (target checked) + a set-datetime time picker", () => {
    const steps = allDialogSteps({ reminder: "08:15" });
    // RRD1: the "Add reminders" checkbox converges deterministically, never a
    // blind press — the pre-populated reschedule dialog would flip a correct box.
    const cb = steps.find((s) => s.label === "Add reminders");
    expect(cb?.primitive).toBe("ensure-checkbox");
    expect(cb?.checkboxTarget).toBe(true);
    expect(steps.find((s) => s.value === "time:08:15")?.primitive).toBe("set-datetime");
  });

  it("deadline + start-earlier: an ensure-checkbox (target checked) + an offset field", () => {
    const steps = dialogSteps({ deadline: true, startDaysEarlier: 3 });
    const cb = steps.find((s) => s.label === "Add deadlines");
    expect(cb?.primitive).toBe("ensure-checkbox");
    expect(cb?.checkboxTarget).toBe(true);
    expect(steps.find((s) => s.value === "3")?.primitive).toBe("set-value");
  });

  it("RRD1: no blind checkbox press survives — deadline/reminder go through ensure-checkbox", () => {
    const steps = allDialogSteps({ deadline: true, startDaysEarlier: 3, reminder: "08:15" });
    const checkboxPresses = steps.filter(
      (s) => s.primitive === "press" && /Add (deadlines|reminders)/.test(s.label),
    );
    expect(checkboxPresses).toHaveLength(0);
  });

  it("RRD1: deadline:false converges the box OFF (explicit un-deadline on reschedule)", () => {
    const steps = dialogSteps({ deadline: false });
    const cb = steps.find((s) => s.label === "Add deadlines");
    expect(cb?.primitive).toBe("ensure-checkbox");
    expect(cb?.checkboxTarget).toBe(false);
    // deadline:false ⇒ no start-earlier field driven.
    expect(steps.some((s) => s.label.startsWith("start "))).toBe(false);
  });

  it("RRD1: startDaysEarlier>0 alone implies a checked deadline box", () => {
    const steps = dialogSteps({ startDaysEarlier: 21 });
    const cb = steps.find((s) => s.label === "Add deadlines");
    expect(cb?.primitive).toBe("ensure-checkbox");
    expect(cb?.checkboxTarget).toBe(true);
    expect(steps.find((s) => s.value === "21")?.primitive).toBe("set-value");
  });

  it("RRD1 preserve-unspecified: no deadline/reminder step when neither is requested", () => {
    // A rule-only reschedule (e.g. interval change) must leave BOTH checkboxes
    // untouched so a pre-populated deadlined/remindered rule keeps its state (#492).
    const steps = allDialogSteps({ monthly: { day: 15 } }, "monthly");
    expect(steps.some((s) => s.label === "Add deadlines")).toBe(false);
    expect(steps.some((s) => s.label === "Add reminders")).toBe(false);
    // ...and a deadline requested WITHOUT an offset drives the box but not the field.
    const withDeadline = dialogSteps({ deadline: true });
    expect(withDeadline.find((s) => s.label === "Add deadlines")?.checkboxTarget).toBe(true);
    expect(withDeadline.some((s) => s.label.startsWith("start "))).toBe(false);
  });

  it("RRD1 ordering: the deadline checkbox converges BEFORE the Next field is driven", () => {
    // Deadline mode changes what "Next:" means (it becomes the deadline date, YANCH1
    // #493), so the checkbox must be converged before Next is driven with the shift.
    const steps = allDialogSteps({ deadline: true, startDaysEarlier: 21, next: "2026-09-22" });
    const deadlineIdx = steps.findIndex((s) => s.label === "Add deadlines");
    const nextIdx = steps.findIndex((s) => s.dtTarget === "next");
    expect(deadlineIdx).toBeGreaterThanOrEqual(0);
    expect(nextIdx).toBeGreaterThan(deadlineIdx);
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

// ADR1 (issue #480): before the to-do recipe presses Items ▸ Repeat…, it asserts
// the reveal actually landed an eligible selection — so a disabled-menu no-op
// (the row was not selected) fails early + named, never as a dialog-wait timeout.
describe("repeat dialog recipe — ADR1 eligibility assertion (#480)", () => {
  it("asserts eligibility BEFORE pressing Items ▸ Repeat…", () => {
    const steps = makeRepeatingRecipe("T-7", "weekly", 2).steps;
    const assertIdx = steps.findIndex((s) => s.primitive === "assert-eligible");
    const pressIdx = steps.findIndex(
      (s) => s.primitive === "press" && s.path?.includes('menu item "Repeat…"') === true,
    );
    expect(assertIdx).toBeGreaterThanOrEqual(0);
    expect(pressIdx).toBeGreaterThan(assertIdx);
  });

  it("the assertion carries the target uuid + the Repeat… menu path and is dynamic (uncanaried)", () => {
    const step = makeRepeatingRecipe("T-7", "weekly", 2).steps.find(
      (s) => s.primitive === "assert-eligible",
    );
    expect(step?.value).toBe("T-7");
    expect(step?.path).toContain('menu item "Repeat…"');
    expect(step?.dynamic).toBe(true);
  });
});

// SESSGATE (#480): a recipe that opens a SHEET on the main window is dialog-class
// and must carry `needsWindowReachability` so the driver gates it; a menu-only
// recipe (a pure menu-item press that works even under lock, AXVM1) must NOT.
describe("needsWindowReachability — dialog-class vs menu-only", () => {
  const dialogClass: [string, UiRecipe][] = [
    ["todo.make-repeating", makeRepeatingRecipe("T-1", "weekly", 1)],
    ["project.make-repeating", projectMakeRepeatingRecipe("AREA-1", "P-1", "Proj", "weekly", 1)],
    ["todo.reschedule-repeat", rescheduleRepeatRecipe("T-1", "weekly", 1)],
    ["project.reschedule-repeat", projectRescheduleRepeatRecipe("P-1", "weekly", 1)],
    ["todo.convert-to-project", convertToProjectRecipe("todo.convert-to-project", "T-1")],
    ["project.promote-heading", headingConvertToProjectRecipe("P-1", 0)],
    ["project.move-heading-to-project", moveHeadingToProjectRecipe("P-1", "H", "Dest")],
  ];
  const menuOnly: [string, UiRecipe][] = [
    ["todo.pause-repeat", pauseRepeatRecipe("T-1")],
    ["todo.resume-repeat", resumeRepeatRecipe("T-1")],
    ["project.pause-repeat", projectPauseRepeatRecipe("P-1")],
  ];

  it.each(dialogClass)("%s is gated (needsWindowReachability = true)", (_op, recipe) => {
    expect(recipe.needsWindowReachability).toBe(true);
  });

  it.each(menuOnly)("%s is NOT gated (no needsWindowReachability)", (_op, recipe) => {
    expect(recipe.needsWindowReachability).not.toBe(true);
  });
});
