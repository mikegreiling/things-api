/**
 * UIFIX1 (2026-11-24, golden-v5 / Things 3.24 and golden-v6 / Things 3.25): the
 * four GUI-driven repeat and heading operations GV6 §5.3 found refusing on every
 * version, rebuilt from an AX census. No GUI fires — these assert the compiled
 * step lists and the scripts the steps compile to.
 *
 *   - `todo pause-repeat` / `resume-repeat`: the Items ▸ Repeat toggle's title
 *     lags the database by up to ~0.8 s, so the press waits for the item first.
 *   - `project pause-repeat` / `resume-repeat` / `reschedule-repeat`: the repeat
 *     bar is no longer `text area 2` of row 1; it is resolved by the `Repeat `
 *     description of its label, the popover item is asserted before it is
 *     clicked, and Change… is Edit Rule….
 *   - `project move-heading-to-project`: the Move… click declares the picker as
 *     the dialog it opens; the picker's rows are AXStaticText on 3.25.
 */
import { describe, expect, it } from "vitest";

import {
  moveHeadingToProjectRecipe,
  pauseRepeatRecipe,
  projectPauseRepeatRecipe,
  projectRescheduleRepeatRecipe,
  projectResumeRepeatRecipe,
  resumeRepeatRecipe,
} from "../../src/write/vectors/ui-recipes.ts";
import {
  axPickerRowFrameScript,
  axRowCellFrameScript,
  commandForStep,
} from "../../src/write/vectors/ui.ts";

describe("todo pause/resume — a closed-loop wait for the toggle's title before the press", () => {
  it.each([
    ["Pause", pauseRepeatRecipe("T-1")],
    ["Resume", resumeRepeatRecipe("T-1")],
  ] as const)("%s: waits for that item, then presses it", (verb, recipe) => {
    const item = `menu item "${verb}" of menu 1 of menu item "Repeat"`;
    const waitIdx = recipe.steps.findIndex((s) => s.primitive === "wait");
    const pressIdx = recipe.steps.findIndex((s) => s.primitive === "press");
    expect(waitIdx).toBeGreaterThan(-1);
    expect(pressIdx).toBe(waitIdx + 1);
    expect(recipe.steps[waitIdx]?.path).toContain(item);
    expect(recipe.steps[waitIdx]?.timeoutMs).toBe(5000);
    expect(recipe.steps[pressIdx]?.path).toContain(item);
    // The canary still resolves the SUBMENU up front (a selected template), not the
    // toggling item, which may legitimately carry the other title at that moment.
    expect(recipe.steps[pressIdx]?.canaryPath).toBe(
      'menu item "Repeat" of menu "Items" of menu bar 1',
    );
  });
});

describe("project pause/resume/reschedule — the repeat bar, the popover item, Edit Rule…", () => {
  const cases = [
    ["Pause", projectPauseRepeatRecipe("P-1")],
    ["Resume", projectResumeRepeatRecipe("P-1")],
    ["Edit Rule…", projectRescheduleRepeatRecipe("P-1", "weekly", 2)],
  ] as const;

  it.each(cases)(
    "%s: the bar is resolved by its 'Repeat ' label, never by text-area index",
    (item, recipe) => {
      const open = recipe.steps.find((s) => s.label.startsWith("open the project's repeat menu"));
      expect(open?.primitive).toBe("click-element");
      expect(open?.path).toContain("table 1 of scroll area 1");
      expect(open?.rowCellDescription).toBe("Repeat ");
      expect(open?.rowCellMatch).toBe("prefix");
      expect(open?.dynamic).toBe(true);
      // The post-click assert names the ONE item the next step clicks.
      expect(open?.assertPath).toContain(`whose description is "${item}"`);
      expect(JSON.stringify(recipe.steps)).not.toContain("text area 2");
      expect(JSON.stringify(recipe.steps)).not.toContain("Change…");
    },
  );

  it("reschedule clicks Edit Rule… and declares the Repeat sheet as the dialog it drives", () => {
    const recipe = projectRescheduleRepeatRecipe("P-1", "weekly", 2);
    const click = recipe.steps.find((s) => s.label === "repeat menu ▸ Edit Rule…");
    expect(click?.path).toContain('whose description is "Edit Rule…"');
    expect(click?.assertPath).toContain("sheet 1 of");
    expect(click?.opensDialog).toBe("repeat");
  });

  it("pause and resume click their item and open no dialog", () => {
    for (const recipe of [projectPauseRepeatRecipe("P-1"), projectResumeRepeatRecipe("P-1")]) {
      const last = recipe.steps.at(-1);
      expect(last?.primitive).toBe("click-element");
      expect(last?.opensDialog).toBeUndefined();
    }
  });

  it("the bar's resolve-frame script walks to the FIRST row with a match and refuses an ambiguous cell", () => {
    const step = projectPauseRepeatRecipe("P-1").steps.find((s) => s.rowCellMatch === "prefix");
    const cmd = commandForStep(step!, "P-1");
    expect(cmd.primitive).toBe("resolve-frame");
    expect(cmd.script).toContain('starts with "Repeat "');
    expect(cmd.script).toContain("is ambiguous");
    expect(cmd.script).not.toContain('is "Repeat "');
  });

  it("the exact walk (the heading `…` button) is unchanged", () => {
    const script = axRowCellFrameScript("table 1", "More. Phase 1");
    expect(script).toContain('is "More. Phase 1"');
    expect(script).not.toContain("starts with");
  });
});

describe("move-heading-to-project — the picker is the declared dialog; rows of either role", () => {
  it("the Move… click declares the picker", () => {
    const recipe = moveHeadingToProjectRecipe("P-1", "Phase 1", "Dest");
    const click = recipe.steps.find((s) => s.label === "ellipsis menu ▸ Move…");
    expect(click?.opensDialog).toBe("move-picker");
    // Only that click declares one: the ellipsis click opens a popover, not a dialog.
    expect(recipe.steps.filter((s) => s.opensDialog !== undefined).length).toBe(1);
  });

  it("the row resolver accepts any non-image described child (AXUnknown ≤3.24, AXStaticText 3.25)", () => {
    const script = axPickerRowFrameScript("window 1", "Dest");
    expect(script).toContain('(role of e) is not "AXImage"');
    expect(script).not.toContain('(role of e) is "AXUnknown"');
    // Identity, exactness and on-screen checks all remain.
    expect(script).toContain('does not start with "MovePopUpDialog-"');
    expect(script).toContain('if d is "Dest" then');
    expect(script).toContain("scrolled out of the Move… picker's visible list");
  });
});
