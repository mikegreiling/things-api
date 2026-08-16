/**
 * Shape of the new ui-driver osascript primitives introduced for the
 * reschedule-repeat cluster (0½ item 1). No GUI fires — these assert the
 * generated AppleScript source (one stable command shape per primitive).
 */
import { describe, expect, it } from "vitest";

import {
  axAssertEligibleScript,
  axSelectPopupCandidatesScript,
  axSelectPopupScript,
  axSetValueScript,
  axSheetOpenScript,
} from "../../src/write/vectors/ui.ts";

describe("axSelectPopupCandidatesScript — plural-safe menu-item resolution (defect (c))", () => {
  const script = axSelectPopupCandidatesScript("pop up button 1 of group 1", ["week", "weeks"]);

  it("self-heals the pop-up open (re-clicks only while its menu is absent)", () => {
    expect(script).toContain("if (exists menu 1 of pu) then exit repeat");
    expect(script).toContain("click pu");
  });

  it("tries every candidate label IN ORDER and clicks the first that exists", () => {
    // singular tried before plural (interval-1 / make-repeating default)
    expect(script).toContain(`{"week", "weeks"}`);
    expect(script).toContain("if (exists menu item candidate of menu 1 of pu) then");
    expect(script).toContain("click menu item candidate of menu 1 of pu");
    expect(script.indexOf('"week"')).toBeLessThan(script.indexOf('"weeks"'));
  });

  it("fails closed (errors) when NONE of the candidates exist", () => {
    expect(script).toContain("error");
    expect(script).toContain("none of the candidate menu items exist");
  });

  it("the single-value select-popup is the one-candidate case of the same shape", () => {
    const one = axSelectPopupScript("pop up button 1", "weekly");
    expect(one).toContain(`{"weekly"}`);
    expect(one).toContain("click menu item candidate of menu 1 of pu");
  });

  it("escapes candidate labels", () => {
    const s = axSelectPopupCandidatesScript("pu", ['we"ek']);
    expect(s).toContain('we\\"ek');
  });
});

describe("axSetValueScript — closed-loop read-back retry (interval-field race, §8l)", () => {
  const script = axSetValueScript("text field 1 of group 1", "2");

  it("types, Tab-commits, then READS THE FIELD BACK and returns OK only when it holds", () => {
    expect(script).toContain('keystroke "2"');
    expect(script).toContain("key code 48"); // Tab commit
    expect(script).toContain('if ((value of tf) as text) is "2" then return "OK"');
  });

  it("retries a bounded number of times, then FAILS CLOSED (errors) if it never holds", () => {
    expect(script).toContain("repeat 3 times"); // default attempts
    expect(script).toContain("error");
    expect(script).toContain("did not hold value");
  });

  it("honors a custom attempt count", () => {
    expect(axSetValueScript("f", "5", 1)).toContain("repeat 1 times");
  });
});

describe("axSheetOpenScript — verified-abort / preflight sheet probe (defects (d)/(e))", () => {
  const script = axSheetOpenScript();

  it("returns a boolean over BOTH the attached sheet and the detached editor window", () => {
    expect(script).toContain(`sheet 1 of (first window whose subrole is "AXStandardWindow")`);
    expect(script).toContain(`windows whose subrole is "AXUnknown" and size is not {40, 40}`);
    expect(script).toContain("return sheetOpen");
  });

  it("wraps each probe in try so a missing window reads as 'no sheet', not an error", () => {
    expect(script.match(/end try/g)?.length).toBe(2);
  });
});

describe("axAssertEligibleScript — reveal-landed-eligible check (ADR1, #480)", () => {
  const script = axAssertEligibleScript(
    "UUID-9",
    `menu item "Repeat…" of menu "Items" of menu bar 1`,
  );

  it("reads the selection uuid-precisely (never a fuzzy title match)", () => {
    expect(script).toContain("id of selected to dos");
    expect(script).not.toContain("name of selected to dos");
  });

  it("distinguishes NOTSEL / WRONGSEL / DISABLED and only says OK when all hold", () => {
    expect(script).toContain("NOTSEL");
    expect(script).toContain("WRONGSEL");
    expect(script).toContain("DISABLED");
    expect(script.trimEnd().endsWith('return "OK"')).toBe(true);
  });

  it("requires EXACTLY the target selected (count checks) and the menu item enabled", () => {
    expect(script).toContain("(count of selIds) is 0");
    expect(script).toContain("(count of selIds) is greater than 1");
    expect(script).toContain('enabled of menu item "Repeat…" of menu "Items" of menu bar 1');
    expect(script).toContain("UUID-9");
  });

  it("escapes the target uuid into the AppleScript string literals", () => {
    const s = axAssertEligibleScript('u"x', "menu item 1");
    expect(s).toContain('u\\"x');
  });
});
