/**
 * Shape of the new ui-driver osascript primitives introduced for the
 * reschedule-repeat cluster (0½ item 1). No GUI fires — these assert the
 * generated AppleScript source (one stable command shape per primitive).
 */
import { describe, expect, it } from "vitest";

import {
  axAssertEligibleScript,
  axConvergeWeekdaysScript,
  axEnsureCheckboxScript,
  axKeyScript,
  axPickerRowFrameScript,
  axProbeDialogShapeScript,
  axRowCellFrameScript,
  axSelectNextOccurrenceScript,
  axSelectPopupCandidatesScript,
  axSelectPopupScript,
  axSelectRowScript,
  axSetDateTimeScript,
  axSetGroupNumberScript,
  axSetValueScript,
  axSheetOpenScript,
  axTypeTextScript,
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

// RDLG2 — Things 3.23 redesigned the Repeat dialog. Three new primitives carry
// the fork: MEASURE the shape, pick the first occurrence out of the new bounded
// menu, and converge the weekday rows in a closed loop.
describe("axProbeDialogShapeScript — the STRUCTURAL version fork (RDLG2)", () => {
  const script = axProbeDialogShapeScript("group 1 of sheet 1");

  it("anchors on the Next: LABEL's row, not on the label's mere presence", () => {
    // RDLG2d measured 3.22.14: it carries the same "Next:" static text as 3.23 —
    // only the control beside it changed, so presence alone misreads 3.22 as 3.23.
    expect(script).toContain('if v is "Next:" then');
    expect(script).toContain("set nextY to item 2 of p");
    expect(script).toContain('if nextY is missing value then return "unknown"');
  });

  it("decides by the CONTROL CLASS sharing that row — both branches a positive match", () => {
    expect(script).toContain('if dy <= 8 then return "next-popup"');
    expect(script).toContain('whose role is "AXDateTimeArea"');
    expect(script).toContain('if dy <= 8 then return "legacy"');
  });

  it("falls through to an explicit unknown (the driver's fail-closed refusal)", () => {
    expect(script.trimEnd().endsWith('return "unknown"\nend tell')).toBe(true);
  });

  it("never reads the app version — the fork is decided by the tree alone", () => {
    expect(script).not.toMatch(/version/i);
  });
});

describe("axSelectNextOccurrenceScript — the 3.23 Next: occurrence menu", () => {
  const script = axSelectNextOccurrenceScript("pop up button 2 of group 1", "2026-09-22");

  it("self-heals the pop-up open, like every other pop-up drive", () => {
    expect(script).toContain("if (exists menu 1 of pu) then exit repeat");
  });

  it("matches by PARSING each localized item title, with a leading-weekday retry", () => {
    // titles read "Sun, Jul 12, 2026" — locale-shaped, so they are parsed, never rebuilt
    expect(script).toContain("on parsedYMD(t)");
    expect(script).toContain('set ofs to offset of ", " in s');
    expect(script).toContain("set wantY to 2026");
    expect(script).toContain("set wantM to 9");
    expect(script).toContain("set wantD to 22");
  });

  it("descends the More… cascade to a bounded depth", () => {
    expect(script).toContain("set deeper to menu 1 of menu item lastI of theMenu");
    expect(script).toContain("repeat 6 times");
  });

  it("has a today branch — the one option the rule need not produce", () => {
    expect(script).toContain("set isToday to");
    expect(script).toContain("click menu item 1 of theMenu");
  });

  it("FAILS CLOSED when the rule never produces the requested date", () => {
    expect(script).toContain("only the rule's own upcoming occurrences");
    expect(script).toContain("2026-09-22 is not one of them");
  });

  it("reads the pop-up back and refuses a value that is not the clicked item", () => {
    expect(script).toContain("set shown to (value of pu) as text");
    expect(script).toContain("if shown is not clickedTitle then");
  });
});

describe("axConvergeWeekdaysScript — closed-loop weekday rows (the RRD1 fix)", () => {
  const script = axConvergeWeekdaysScript("group 1 of sheet 1", 3, [
    "Tuesday",
    "Thursday",
    "Saturday",
  ]);

  it("counts the live rows from the shape's base index", () => {
    expect(script).toContain("set baseIx to 3");
    expect(script).toContain("set n to (count of pop up buttons of g) - baseIx + 1");
  });

  it("resolves the add button from live GEOMETRY (the row buttons enumerate unstably)", () => {
    // the position list is bound to a VARIABLE first: `item 1 of (position of …)`
    // inline builds an element specifier System Events rejects (-1700, live in RDLG2c)
    expect(script).toContain("set p to position of button i of g");
    expect(script).toContain("set px to item 1 of p");
    expect(script).toContain("if px < bestX then");
    expect(script).toContain("click button bestI of g");
  });

  it("assigns EVERY row from the target set, cycling — no stale row can survive", () => {
    expect(script).toContain("set wi to ((i - 1) mod k) + 1");
    expect(script).toContain('{"Tuesday", "Thursday", "Saturday"}');
  });

  it("reads every row back and errors on a missing OR an unexpected weekday", () => {
    expect(script).toContain("if not seen then set absent to absent & wantVal");
    expect(script).toContain("if wantList does not contain v then");
    expect(script).toContain("the weekday rows did not converge");
  });

  it("fails closed when the dialog will not grow, and when the app is not in English", () => {
    expect(script).toContain("the dialog would not grow to");
    expect(script).toContain("the weekday pop-up offers no item");
  });

  it("the legacy dialog's base index is 2 (no Next: pop-up in front of the rows)", () => {
    expect(axConvergeWeekdaysScript("group 1", 2, ["Monday"])).toContain("set baseIx to 2");
  });
});

describe("axSelectRowScript — the matched row must itself hold the selection (VMRES1)", () => {
  const script = axSelectRowScript("table 1 of scroll area 1 of window 1", "My Project");

  it("settles after the select before reading the title back", () => {
    // The readback LAGS the select action: with no settle, `name of selected to
    // dos` can still report the PREVIOUS iteration's row (VMRES1 §2).
    expect(script).toMatch(/select \(row i of theTable\)\s*\n\s*delay 0\.25/);
  });

  it("gates the title readback on `selected of (row i)` — the anti-lag guard", () => {
    // A blank spacer row's select lands NOTHING; without this gate the stale
    // readback matched the previous row's title, the loop returned OK one row
    // late, and the table was left with no selection at all — so the menu item
    // the next step waits for never materialized.
    const gateAt = script.indexOf("if (selected of (row i of theTable)) then");
    const readbackAt = script.indexOf("name of selected to dos");
    expect(gateAt).toBeGreaterThan(-1);
    expect(readbackAt).toBeGreaterThan(gateAt);
  });

  it("still returns OK on the title match and NOMATCH when no row selects to it", () => {
    expect(script).toContain('is "My Project" then');
    expect(script).toContain('return "OK"');
    expect(script).toContain('return "NOMATCH"');
  });
});

describe("axSetGroupNumberScript — interval and ends-count are DIFFERENT fields (HXPC1 §A)", () => {
  const interval = axSetGroupNumberScript("group 1 of sheet 1", "interval", "3");
  const endsCount = axSetGroupNumberScript("group 1 of sheet 1", "ends-count", "5");

  it("anchors on the `Ends:` label's row rather than a text-field index", () => {
    // Measured on 3.23: with an ends bound shown the cadence group holds TWO text
    // fields and the COUNT takes index 1, displacing the interval to 2 — so the
    // shared `text field 1 of group 1` spelling wrote the requested interval into
    // the count on any PRE-POPULATED (reschedule) dialog.
    for (const s of [interval, endsCount]) {
      expect(s).toContain('if sv is "Ends:" then');
      expect(s).toContain("set endsY to item 2 of labelPos");
      expect(s).not.toContain("text field 1 of g");
    }
  });

  it("selects the field ON the ends row for the count and OFF it for the interval", () => {
    expect(endsCount).toContain("if onEndsRow is true then");
    expect(interval).toContain("if onEndsRow is false then");
  });

  it("fails closed unless EXACTLY one field matches, reporting the field inventory", () => {
    for (const s of [interval, endsCount]) {
      expect(s).toContain("if (count of hits) is not 1 then");
      expect(s).toContain("expected exactly 1");
      expect(s).toContain("numeric fields:");
    }
  });

  it("drives with the same closed loop as set-value (type, Tab-commit, read back, retry)", () => {
    expect(interval).toContain("set focused of tf to true");
    expect(interval).toContain('keystroke "a" using command down');
    expect(interval).toContain('keystroke "3"');
    expect(interval).toContain("key code 48"); // Tab, never Return (the default button)
    expect(interval).toContain('if ((value of tf) as text) is "3" then return "OK"');
    expect(interval).toContain("did not hold value");
  });
});

describe("axRowCellFrameScript — the heading `…` button is three levels down (HXPC1 §B0)", () => {
  const script = axRowCellFrameScript("table 1 of scroll area 1 of window 1", "More. Phase 1");

  it("walks rows -> cells -> cell children instead of filtering the table's children", () => {
    // `first UI element of <table> whose description is …` searches the table's
    // DIRECT children — the rows, which carry no description — so the shipped
    // spelling matched nothing and every ellipsis drive died at frame resolution.
    expect(script).toContain("repeat with r in rows of t");
    expect(script).toContain("repeat with c in UI elements of r");
    expect(script).toContain("repeat with e in UI elements of c");
    expect(script).toContain('is "More. Phase 1" then');
  });

  it("returns the same 'x y w h' frame contract as axFrameScript", () => {
    expect(script).toContain("set _p to position of e");
    expect(script).toContain("set _s to size of e");
    expect(script).toContain("(item 1 of _p) as text");
  });

  it("fails closed by name when no row exposes it", () => {
    expect(script).toContain("error");
    expect(script).toContain("More. Phase 1");
  });
});

describe("axPickerRowFrameScript — the Move… commit is addressed, never blind (HXPC1 §B)", () => {
  const script = axPickerRowFrameScript('(first window whose subrole is "AXUnknown")', "Dest");

  it("verifies the window IS the Move… picker before anything is clicked", () => {
    expect(script).toContain('does not start with "MovePopUpDialog-"');
    expect(script).toContain("nothing was committed");
  });

  it("requires EXACTLY ONE row whose title matches exactly", () => {
    expect(script).toContain('if d is "Dest" then set end of hits to e');
    expect(script).toContain("if (count of hits) is 0 then");
    expect(script).toContain("if (count of hits) > 1 then");
  });

  it("names every row the picker offered, and why committing blind was unsafe", () => {
    // The `New Project "<typed>"` row is what the blind Return took whenever the
    // destination was absent from the picker — a completed/canceled project is.
    expect(script).toContain("it offered:");
    expect(script).toContain("would have created a new project");
    expect(script).toContain("completed or canceled project is not offered");
  });

  it("refuses a row scrolled outside the picker's own list (the CNCAC1 off-screen hazard)", () => {
    expect(script).toContain("if cy < saTop or cy > saBottom then");
    expect(script).toContain("scrolled out of the Move… picker's visible list");
  });
});

describe("axTypeTextScript — one keystroke, spaces intact (HXPC1)", () => {
  it("sends the whole string as ONE keystroke, unlike the whitespace-split key spec", () => {
    expect(axTypeTextScript("Synthetic Work")).toContain('keystroke "Synthetic Work"');
    // axKeyScript splits its spec on whitespace, which would drop the space.
    expect(axKeyScript("Synthetic Work")).toContain('keystroke "Synthetic"');
  });
});
