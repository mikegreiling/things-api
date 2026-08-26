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
import type { RepeatDialogShape, UiRecipe, UiStep } from "../../src/write/vectors/types.ts";

/**
 * Apply the driver's shape resolution (RDLG2) to a recipe: drop the steps that
 * belong to the OTHER dialog shape, and fold each step's per-shape override in —
 * exactly what `drive()` does once `probe-dialog-shape` has measured the dialog.
 */
function forShape(steps: UiStep[], shape: RepeatDialogShape): UiStep[] {
  const out: UiStep[] = [];
  for (const s of steps) {
    if (s.onlyShape !== undefined && s.onlyShape !== shape) continue;
    out.push(s.shaped === undefined ? s : Object.assign({}, s, s.shaped[shape]));
  }
  return out;
}

/** The dialog-entry steps (those addressed by pathCandidates), resolved for a shape. */
function dialogSteps(
  extras: RepeatRuleExtras,
  frequency: "daily" | "weekly" | "monthly" | "yearly" = "weekly",
  interval = 1,
  shape: RepeatDialogShape = "next-popup",
) {
  const recipe = makeRepeatingRecipe("T-1", frequency, interval, extras);
  return forShape(recipe.steps, shape).filter((s) => s.pathCandidates !== undefined);
}
const labels = (steps: UiStep[]) => steps.map((s) => s.label);

/** ALL dialog-entry steps (pop-ups/fields AND the role-addressed date pickers). */
function allDialogSteps(
  extras: RepeatRuleExtras,
  frequency: "daily" | "weekly" | "monthly" | "yearly" = "weekly",
  shape: RepeatDialogShape = "next-popup",
) {
  const steps = forShape(makeRepeatingRecipe("T-1", frequency, 1, extras).steps, shape);
  return steps.filter((s) => s.pathCandidates !== undefined || s.primitive === "set-datetime");
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
    expect(steps.map((s) => s.primitive)).toEqual([
      "wait",
      "select-popup",
      "set-group-number",
      "press",
    ]);
    expect(labels(steps)).toEqual([
      "the Repeat dialog",
      "frequency = weekly",
      "interval = 1",
      'press "OK"',
    ]);
  });
});

describe("repeat dialog recipe — per-control drive", () => {
  it("weekly multi-day: ONE closed-loop weekday converge, never a blind '+' ladder (RRD1)", () => {
    const steps = dialogSteps({ weekdays: ["monday", "wednesday", "friday"] });
    const converge = steps.filter((s) => s.primitive === "converge-weekdays");
    expect(converge).toHaveLength(1);
    expect(converge[0]?.label).toBe("weekdays = monday, wednesday, friday");
    // the whole target set rides ONE step (so a pre-populated dialog cannot keep
    // a stale row), and the blind add-then-redrive-the-same-index shape is gone
    expect(converge[0]?.value).toBe("3|Monday,Wednesday,Friday");
    expect(labels(steps).some((x) => x.startsWith("add weekday row"))).toBe(false);
  });

  it("the weekday converge carries the row base index for BOTH dialog shapes", () => {
    const raw = makeRepeatingRecipe("T-1", "weekly", 1, { weekdays: ["tuesday"] }).steps;
    const step = raw.find((s) => s.primitive === "converge-weekdays");
    // Ends is group pop-up 1 in both shapes; 3.23 slots its "Next:" pop-up in at
    // 2, so the first weekday row is 3 there and 2 on the legacy dialog.
    expect(step?.shaped?.["next-popup"]?.value).toBe("3|Tuesday");
    expect(step?.shaped?.legacy?.value).toBe("2|Tuesday");
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
    expect(steps.find((s) => s.value === "7")?.primitive).toBe("set-group-number");
  });

  it("the interval and the ends count are addressed as DIFFERENT fields (HXPC1 §A)", () => {
    // Both used to be `text field 1 of group 1`, which is the same control at
    // different moments: selecting the "after" bound inserts the count ahead of
    // the interval, so a PRE-POPULATED reschedule wrote the interval into the
    // count. Each now names the row it belongs to, and the driver resolves it.
    const steps = dialogSteps({ ends: { kind: "after", count: 5 } }, "weekly", 3);
    const numbers = steps.filter((s) => s.primitive === "set-group-number");
    expect(numbers).toHaveLength(2);
    expect(numbers.map((s) => [s.numberTarget, s.value])).toEqual([
      ["interval", "3"],
      ["ends-count", "5"],
    ]);
    // Both address the cadence GROUP; neither pins a text-field index.
    for (const s of numbers) {
      expect(s.pathCandidates?.every((p) => p.startsWith("group 1 of "))).toBe(true);
      expect(s.pathCandidates?.some((p) => p.includes("text field"))).toBe(false);
    }
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
    // CGRD1: the start-offset field is addressed by its "days earlier" label row,
    // not by `text field 1` of the shell.
    const offset = steps.find((s) => s.value === "3");
    expect(offset?.primitive).toBe("set-row-field");
    expect(offset?.rowLabel).toBe("days earlier");
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
    const offset = steps.find((s) => s.value === "21");
    expect(offset?.primitive).toBe("set-row-field");
    expect(offset?.rowLabel).toBe("days earlier");
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
    // Holds under BOTH dialog shapes — the first-occurrence control changed class
    // in 3.23 (a pop-up pick, not a date write) but not its place in the order.
    for (const shape of ["next-popup", "legacy"] as const) {
      const steps = allDialogSteps(
        { deadline: true, startDaysEarlier: 21, next: "2026-09-22" },
        "weekly",
        shape,
      );
      const deadlineIdx = steps.findIndex((s) => s.label === "Add deadlines");
      const nextIdx = steps.findIndex((s) => s.label.startsWith("Next "));
      expect(deadlineIdx).toBeGreaterThanOrEqual(0);
      expect(nextIdx).toBeGreaterThan(deadlineIdx);
    }
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
    const converge = recipe.steps.find((s) => s.primitive === "converge-weekdays");
    expect(converge?.label).toBe("weekdays = monday, thursday");
    expect(recipe.steps.some((s) => s.primitive === "probe-dialog-shape")).toBe(true);
  });

  it("reschedule offers BOTH menu spellings — Edit Rule… (3.23) and Reschedule… (≤3.22)", () => {
    const recipe = rescheduleRepeatRecipe("T-1", "daily", 1);
    const press = recipe.steps.find(
      (s) => s.primitive === "press" && s.pathCandidates !== undefined,
    );
    expect(press?.pathCandidates?.[0]).toContain('menu item "Edit Rule…"');
    expect(press?.pathCandidates?.[1]).toContain('menu item "Reschedule…"');
    // the submenu itself stays canaried (it only exists on a selected template)
    const anchor = recipe.steps.find((s) => s.primitive === "resolve");
    expect(anchor?.path).toContain('menu item "Repeat"');
    expect(anchor?.dynamic).not.toBe(true);
  });
});

// RDLG2: Things 3.23 redesigned the Repeat dialog — a new "Next:" occurrence
// pop-up sits between Ends and every per-frequency control (shifting them +1) and
// REPLACES the first-occurrence date area. The recipe carries both shapes and the
// driver measures which one is open; nothing keys off the app version.
/** Where the NEXTPOP1 settle sits in a step list (-1 when the recipe omits it). */
const settleAt = (steps: UiStep[]) => steps.findIndex((s) => s.primitive === "settle-occurrences");

describe("repeat dialog recipe — the 3.23 shape fork (RDLG2)", () => {
  it("probes the dialog's shape BEFORE any control the redesign moved", () => {
    for (const extras of [
      { weekdays: ["monday"] } as RepeatRuleExtras,
      { monthly: { day: 4 } } as RepeatRuleExtras,
      { yearly: { month: 3, day: 1 } } as RepeatRuleExtras,
      { next: "2026-09-22" } as RepeatRuleExtras,
    ]) {
      const steps = makeRepeatingRecipe("T-1", "weekly", 1, extras).steps;
      const probeIdx = steps.findIndex((s) => s.primitive === "probe-dialog-shape");
      const firstShaped = steps.findIndex(
        (s) => s.shaped !== undefined || s.onlyShape !== undefined,
      );
      expect(probeIdx).toBeGreaterThanOrEqual(0);
      expect(firstShaped).toBeGreaterThan(probeIdx);
    }
  });

  it("does NOT probe when no control depends on the shape (the certified two-control path)", () => {
    expect(makeRepeatingRecipe("T-1", "daily", 3).steps).not.toContainEqual(
      expect.objectContaining({ primitive: "probe-dialog-shape" }),
    );
    // after-completion has no calendar at all — no Ends, no Next, nothing to measure
    expect(
      makeRepeatingRecipe("T-1", "weekly", 2, { afterCompletion: true, next: "2026-09-22" }).steps,
    ).not.toContainEqual(expect.objectContaining({ primitive: "probe-dialog-shape" }));
  });

  it("per-frequency pop-ups shift +1 under the 3.23 shape, and only there", () => {
    const monthly = (shape: RepeatDialogShape) =>
      dialogSteps({ monthly: { day: 15 } }, "monthly", 1, shape)
        .filter((s) => s.primitive === "select-popup")
        .map((s) => s.pathCandidates?.[0]);
    expect(monthly("next-popup")).toEqual([
      expect.stringContaining("pop up button 1 of"), // frequency (sheet-level)
      expect.stringContaining("pop up button 3 of group 1"), // monthly mode
      expect.stringContaining("pop up button 4 of group 1"), // ordinal
    ]);
    expect(monthly("legacy")).toEqual([
      expect.stringContaining("pop up button 1 of"),
      expect.stringContaining("pop up button 2 of group 1"),
      expect.stringContaining("pop up button 3 of group 1"),
    ]);
  });

  it("yearly month/mode/ordinal are 3/4/5 on 3.23 and 2/3/4 on the legacy dialog", () => {
    const yearly = (shape: RepeatDialogShape) =>
      dialogSteps({ yearly: { month: 10, day: 8 } }, "yearly", 1, shape)
        .filter((s) => s.primitive === "select-popup")
        .slice(1) // drop the sheet-level frequency pop-up
        .map((s) => s.pathCandidates?.[0]);
    expect(yearly("next-popup")).toEqual([
      expect.stringContaining("pop up button 3 of group 1"),
      expect.stringContaining("pop up button 4 of group 1"),
      expect.stringContaining("pop up button 5 of group 1"),
    ]);
    expect(yearly("legacy")).toEqual([
      expect.stringContaining("pop up button 2 of group 1"),
      expect.stringContaining("pop up button 3 of group 1"),
      expect.stringContaining("pop up button 4 of group 1"),
    ]);
  });

  it("the first occurrence is a MENU pick on 3.23 and a date-area write on ≤3.22", () => {
    const raw = makeRepeatingRecipe("T-1", "weekly", 1, { next: "2026-09-22" }).steps;
    const modern = forShape(raw, "next-popup").filter((s) => s.label.startsWith("Next "));
    const legacy = forShape(raw, "legacy").filter((s) => s.label.startsWith("Next "));
    expect(modern).toHaveLength(1);
    expect(modern[0]?.primitive).toBe("select-next-occurrence");
    expect(modern[0]?.value).toBe("2026-09-22");
    expect(modern[0]?.pathCandidates?.[0]).toContain("pop up button 2 of group 1");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.primitive).toBe("set-datetime");
    expect(legacy[0]?.dtTarget).toBe("next");
  });

  // NEXTPOP1 (golden-v4 / Things 3.23): the dialog recomputes its first-occurrence
  // pop-up ~0.4s after a calendar-anchor change, and an input inside that window
  // CANCELS the recompute for good — the control (and its menu of occurrences) goes
  // on describing the previous rule. The deadline checkbox is the very next thing
  // this recipe drives, which is why every deadlined monthly/yearly promote used to
  // fail closed on a date its own rule produces.
  describe("the Next: pop-up gets a settle before any further input (NEXTPOP1)", () => {
    it("sits between the calendar anchor and the deadline checkbox", () => {
      const steps = forShape(
        makeRepeatingRecipe("T-1", "yearly", 1, {
          yearly: { month: 8, day: 20 },
          deadline: true,
          startDaysEarlier: 14,
          next: "2026-08-20",
        }).steps,
        "next-popup",
      );
      const settle = settleAt(steps);
      const anchor = steps.findIndex((s) => s.label === "monthly day = 20");
      const checkbox = steps.findIndex((s) => s.label === "Add deadlines");
      const next = steps.findIndex((s) => s.primitive === "select-next-occurrence");
      expect(anchor).toBeGreaterThan(-1);
      expect(settle).toBeGreaterThan(anchor);
      expect(settle).toBeLessThan(checkbox);
      expect(settle).toBeLessThan(next);
      expect(steps[settle]?.pathCandidates?.[0]).toContain("pop up button 2 of group 1");
    });

    it("is emitted for the 3.23 pop-up only — the ≤3.22 date area has no menu to recompute", () => {
      const raw = makeRepeatingRecipe("T-1", "yearly", 1, { next: "2026-08-20" }).steps;
      expect(settleAt(forShape(raw, "next-popup"))).toBeGreaterThan(-1);
      expect(settleAt(forShape(raw, "legacy"))).toBe(-1);
    });

    it("is emitted even when no first occurrence is requested (a stale pop-up commits itself)", () => {
      const steps = forShape(
        makeRepeatingRecipe("T-1", "monthly", 1, { monthly: { day: 20 } }).steps,
        "next-popup",
      );
      expect(settleAt(steps)).toBeGreaterThan(-1);
      expect(steps.some((s) => s.primitive === "select-next-occurrence")).toBe(false);
    });

    it("is NOT emitted for an after-completion rule (no first-occurrence control at all)", () => {
      const steps = forShape(
        makeRepeatingRecipe("T-1", "weekly", 1, { afterCompletion: true }).steps,
        "next-popup",
      );
      expect(settleAt(steps)).toBe(-1);
    });

    it("contributes no control to the pre-commit audit (it sets nothing)", () => {
      const steps = forShape(
        makeRepeatingRecipe("T-1", "yearly", 1, {
          yearly: { month: 8, day: 20 },
          next: "2026-08-20",
        }).steps,
        "next-popup",
      );
      const audit = steps.find((s) => s.primitive === "audit-dialog");
      expect(audit?.audit?.controls.some((c) => c.label.includes("absorb"))).toBe(false);
    });
  });

  it("Ends / interval / checkbox controls are shape-INDEPENDENT (they did not move)", () => {
    const shared = (shape: RepeatDialogShape) =>
      dialogSteps({ ends: { kind: "after", count: 5 }, deadline: true }, "daily", 2, shape).map(
        (s) => [s.label, s.pathCandidates?.[0]],
      );
    expect(shared("next-popup")).toEqual(shared("legacy"));
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
