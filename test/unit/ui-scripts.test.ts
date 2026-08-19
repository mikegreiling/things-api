/**
 * Shape of the new ui-driver osascript primitives introduced for the
 * reschedule-repeat cluster (0½ item 1). No GUI fires — these assert the
 * generated AppleScript source (one stable command shape per primitive).
 */
import { describe, expect, it } from "vitest";

import {
  axAssertEligibleScript,
  axEnsureCheckboxScript,
  axSelectPopupCandidatesScript,
  axSelectPopupScript,
  axSetDateTimeScript,
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

describe("axEnsureCheckboxScript — deterministic closed-loop convergence (RRD1)", () => {
  const check = axEnsureCheckboxScript(`checkbox "Add deadlines"`, true);
  const uncheck = axEnsureCheckboxScript(`checkbox "Add deadlines"`, false);

  it("READS the checkbox value first and no-ops (returns OK) when it already matches", () => {
    expect(check).toContain("set cur to (value of cb) as integer");
    expect(check).toContain('if cur is 1 then return "OK"');
    // the read precedes the click — an already-correct box is never toggled
    expect(check.indexOf("value of cb")).toBeLessThan(check.indexOf("click cb"));
  });

  it("presses ONLY on a mismatch, then re-reads to confirm convergence", () => {
    expect(check).toContain("click cb");
    // a second read after the retry loop is the convergence confirmation
    expect(check.split("value of cb").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("targets 0 when the requested state is unchecked", () => {
    expect(uncheck).toContain('if cur is 0 then return "OK"');
    expect(uncheck).toContain("did not converge to 0");
  });

  it("retries a bounded number of times, then FAILS CLOSED (errors) if it never converges", () => {
    expect(check).toContain("repeat 3 times");
    expect(check).toContain("error");
    expect(check).toContain("did not converge to 1");
  });

  it("honors a custom attempt count", () => {
    expect(axEnsureCheckboxScript("cb", true, 1)).toContain("repeat 1 times");
  });
});

describe("axSetDateTimeScript — named-error + read-back rejection detection (YANCH1 #493)", () => {
  const dateScript = axSetDateTimeScript("date:2027-10-30", "next");
  const timeScript = axSetDateTimeScript("time:18:00", "reminder");

  it("guards the empty date-area set so an absent control cannot bubble as a raw -2700", () => {
    // The collect walk is wrapped in try/catch and pick() guards the empty set, so
    // a missing control yields a NAMED error, never `-[__NSArray0 objectAtIndex:]`.
    expect(dateScript).toContain(
      "try{ var shell=findShell(app); if(shell) collect(shell,'AXDateTimeArea',16,areas); }catch(e){",
    );
    expect(dateScript).toContain("this Repeat-dialog state presents ");
    expect(dateScript).toContain("date area(s)"); // reports the inventory
  });

  it("scopes the AXDateTimeArea walk to the resolved dialog shell, not the app root (PERF2)", () => {
    // The collect must start from the shell findShell resolves — never the app
    // element — so the walk avoids the main window's large list content (the ~4.4s
    // app-root descent). The app is still the argument to findShell, never to collect.
    expect(dateScript).toContain("collect(shell,'AXDateTimeArea',16,areas)");
    expect(dateScript).not.toContain("collect(app,");
    expect(dateScript).toContain("function findShell(app)");
  });

  it("resolves the shell in DIALOG_SHELLS priority order: attached sheet, then detached AXUnknown window", () => {
    // Sheet first (Things frontmost), then the detached editor (backgrounded) that
    // is not the 40x40 utility window — matching the ui-recipes pathCandidates order.
    const sheetIdx = dateScript.indexOf("'AXStandardWindow'");
    const detachedIdx = dateScript.indexOf("'AXUnknown'");
    expect(sheetIdx).toBeGreaterThan(-1);
    expect(detachedIdx).toBeGreaterThan(sheetIdx);
    expect(dateScript).toContain("collect(wins[i],'AXSheet',3,sh)");
    expect(dateScript).toContain("wh.w===40 && wh.h===40");
  });

  it("falls through to the SAME named error when no shell resolves (dialog absent)", () => {
    // findShell null → areas stays empty → pick returns null → the named error
    // reports "presents 0 date area(s)" — byte-identical to the app-root miss shape.
    expect(dateScript).toContain("if(shell) collect(shell,'AXDateTimeArea',16,areas)");
    expect(dateScript).toContain("but none is the '+target+' control");
  });

  it("reads the control back after a date write and fails loudly on a rejected value", () => {
    expect(dateScript).toContain("ymdStr(dt,cal)");
    expect(dateScript).toContain("rejected: the control committed");
    expect(dateScript).toContain("the write did not take");
  });

  it("reads the control back after a time write (reminder) and fails on a mismatch", () => {
    expect(timeScript).toContain("hmStr(dt,cal)");
    expect(timeScript).toContain("rejected: the control committed");
  });

  it("names the target in every failure path", () => {
    expect(dateScript).toContain("set-datetime '+target+'");
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
