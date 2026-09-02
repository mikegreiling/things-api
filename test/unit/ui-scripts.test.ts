/**
 * Shape of the new ui-driver osascript primitives introduced for the
 * reschedule-repeat cluster (0½ item 1). No GUI fires — these assert the
 * generated AppleScript source (one stable command shape per primitive).
 */
import { describe, expect, it } from "vitest";

import {
  axAssertEligibleScript,
  axAuditDateAreasScript,
  axAuditDialogScript,
  axDialogOpenScript,
  splitAeDebug,
  parseElemLog,
  AX_ELEMS_LOG_PREFIX,
  COMMIT_FAILED_TAG,
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
  axSetRowFieldScript,
  axSettleOccurrencesScript,
  axSetValueScript,
  axSheetOpenScript,
  axTypeTextScript,
  axCandidatePrelude,
  axWaitAnyScript,
  commandForStep,
  judgeFocusGuard,
  CANDIDATES_MISSED,
  STEP_ELEMENT_REF,
} from "../../src/write/vectors/ui.ts";
import {
  axFocusGuardPrelude,
  axUiStateScript,
  GUARD_LOG_PREFIX,
  GUARD_LOG_SEP,
  GUARD_REFUSED_TAG,
  parseGuardLog,
} from "../../src/write/vectors/ui-state.ts";

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

  // BEEP1 (docs/lab/beep1-numeric-field-beep.md): the ⌘A that used to precede the
  // typing was the audible macOS alert beep every numeric-field drive fired — a
  // DISABLED `Edit ▸ Select All` menu item swallows the key equivalent while the
  // Repeat sheet is up, so nothing handles it and AppKit beeps. It was redundant
  // too: focusing the field selects its whole content, so typing replaces it.
  it("sends NO select-all keystroke (the ⌘A that beeped)", () => {
    expect(script).not.toContain("using command down");
    expect(script).not.toContain('keystroke "a"');
  });

  it("still opens each attempt by focusing the field (which is what selects the old value)", () => {
    expect(script).toContain("set focused of tf to true");
    // focus precedes the typing in every attempt
    expect(script.indexOf("set focused of tf to true")).toBeLessThan(
      script.indexOf('keystroke "2"'),
    );
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
    // The check itself still ends on the single positive verdict …
    expect(script).toContain('  return "OK"\nend aeCheck');
  });

  it("POLLS the check until it holds, and returns the LAST verdict when it never does", () => {
    // DRVLAT1 (#633): the menu bar repopulates around the new selection a beat
    // after the reveal. That beat used to be a fixed 1000ms settle in the driver,
    // paid by every drive; it is now waited out HERE, in the assertion's own hop,
    // which returns the moment the selection is eligible.
    expect(script).toContain('repeat until verdict is "OK"');
    expect(script.trimEnd()).toContain("return verdict");
    // …and a bounded deadline, not an unbounded spin.
    expect(script).toMatch(/is greater than or equal to \d+ then exit repeat/);
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

  // NEXTPOP1: "not one of them" is ambiguous on its own — it reads the same
  // whether the rule genuinely cannot produce the date or the menu belonged to a
  // DIFFERENT rule (a recompute the drive cancelled). The refusal therefore names
  // the pop-up's own value and the head of the list it searched.
  it("reports the menu it actually searched, so a miss is self-diagnosing", () => {
    expect(script).toContain("set opener to (value of pu) as text");
    expect(script).toContain('which opened on \\"" & opener & "\\" and led with: " & sample');
  });
});

describe("axSettleOccurrencesScript — the Next: pop-up's async recompute (NEXTPOP1)", () => {
  const script = axSettleOccurrencesScript("pop up button 2 of group 1");

  it("samples the control first, then waits for it to MOVE", () => {
    expect(script).toContain("set wasValue to (value of pop up button 2 of group 1) as text");
    expect(script).toContain("if curValue is not wasValue then return");
  });

  it("exits early on the change and is BOUNDED when there is nothing to absorb", () => {
    // 1200ms budget at a 100ms poll — ~3x the 0.4s recompute measured on 3.23
    expect(script).toContain("repeat 12 times");
    expect(script).toContain("delay 0.1");
    expect(script).toContain('return "unchanged: " & wasValue');
  });

  it("touches nothing — it is a wait, not a setter", () => {
    expect(script).not.toContain("click");
    expect(script).not.toContain("keystroke");
  });

  // `before`/`after`/`now` are AppleScript's own keywords: the first cut of this
  // step used `set before to …` and did not COMPILE, which surfaces only as a
  // mid-dialog drive failure. test/unit/ui-script-syntax.test.ts osacompiles every
  // generated script on macOS; this keeps the specific trap named where the script
  // is written.
  it("avoids AppleScript's reserved positional keywords as variable names", () => {
    expect(script).not.toMatch(/\bset (before|after|now) to\b/);
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

  it("anchors on a LABEL's row rather than a text-field index", () => {
    // Measured on 3.23: with an ends bound shown the cadence group holds TWO text
    // fields and the COUNT takes index 1, displacing the interval to 2 — so the
    // shared `text field 1 of group 1` spelling wrote the requested interval into
    // the count on any PRE-POPULATED (reschedule) dialog.
    for (const s of [interval, endsCount]) {
      expect(s).toContain('my cgLabelY(snap, "Ends:")');
      expect(s).toContain("set outY to (item i of ys)");
    }
  });

  it("matches the interval POSITIVELY on the `Every` row, not merely off the Ends row", () => {
    // CGRD1 §A: every fixed frequency carries an `Every` label at y=286 with the
    // interval at y=283. Preferring that positive match means a group whose shape
    // we do not recognize refuses rather than falling back on "the other field".
    for (const s of [interval, endsCount]) {
      expect(s).toContain('my cgLabelY(snap, "Every")');
      expect(s).toContain('on the \\"Every\\" row');
    }
    // The after-completion group carries NEITHER label (its only static text is
    // "after previous item is checked off.") and offers exactly one field, so that
    // shape is reached through a UNIQUENESS check, never an index.
    expect(interval).toContain('carries neither an \\"Every\\" nor an \\"Ends:\\" label');
    expect(interval).toContain("if nf is not 1 then error");
  });

  it("the ends-count REQUIRES the `Ends:` label — it is never inferred", () => {
    expect(endsCount).toContain('carries no \\"Ends:\\" label');
    expect(endsCount).toContain("my cgOnRow(snap, endsY, tol, true)");
    expect(endsCount).toContain('my cgField(g, cgSnapshot, "ends-count", 8)');
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
    expect(interval).toContain('keystroke "3"');
    expect(interval).toContain("key code 48"); // Tab, never Return (the default button)
    expect(interval).toContain('if ((value of tf) as text) is "3" then return "OK"');
    expect(interval).toContain("did not hold value");
  });

  // BEEP1: the select-all keystroke is the beep, and it is redundant — see the
  // axSetValueScript block above. Both numeric primitives must stay free of it.
  it("sends NO select-all keystroke either (BEEP1)", () => {
    for (const s of [interval, endsCount]) {
      expect(s).not.toContain("using command down");
      expect(s).not.toContain('keystroke "a"');
    }
  });

  // BEEP1 §5: a frequency switch REBUILDS the cadence group, and this primitive
  // is the step that follows it — so it settles on the group's own shape (two
  // consecutive identical reads) before addressing a field, rather than reading
  // positions off controls that are still moving and typing into a field being
  // torn down (which is unhandled, i.e. a second alert beep).
  it("settles on the group's own shape before addressing a field, and fails closed", () => {
    for (const s of [interval, endsCount]) {
      // the signature is the labels plus the field y-positions, read twice
      expect(s).toContain("set prevSig to sig");
      expect(s).toContain("if (sig is prevSig) and (my cgValid(snap)) then");
      expect(s).toContain("still re-laying out");
      // the settle precedes the row discrimination it protects — and HANDS it the
      // inventory it just proved stable, rather than leaving it to read again.
      expect(s.indexOf("my cgSettle(g,")).toBeLessThan(s.indexOf("my cgField(g, cgSnapshot,"));
    }
  });
});

describe("axSetRowFieldScript — the start-offset field is label-anchored (CGRD1 §B)", () => {
  const script = axSetRowFieldScript("sheet 1 of window 1", "days earlier", "3");

  it("finds the field by the label sharing its row, not by index in the shell", () => {
    // The old spelling was `text field 1` of the dialog shell — right on 3.23 by
    // luck (0 direct text fields with deadlines off, exactly 1 with them on) but
    // never provably so. Now the anchor is the `days earlier` static text at y=413
    // against the field's y=409.
    expect(script).toContain('my rfField(c, rfSnapshot, "days earlier", 8)');
    expect(script).toContain("my cgLabelY(snap, rowLabel)");
  });

  it("fails closed on a missing label or a non-unique row, naming the inventory", () => {
    expect(script).toContain('shows no \\"" & rowLabel & "\\" label');
    expect(script).toContain("expected exactly 1");
    expect(script).toContain("text fields:");
  });

  it("drives with the same closed loop as set-value, and no select-all (BEEP1)", () => {
    expect(script).toContain("set focused of tf to true");
    expect(script).toContain('keystroke "3"');
    expect(script).toContain("key code 48");
    expect(script).toContain('if ((value of tf) as text) is "3" then return "OK"');
    expect(script).not.toContain("using command down");
  });
});

describe("axAuditDialogScript — the pre-commit full-dialog audit (CGRD1 guard 2)", () => {
  const SHELL = "sheet 1 of window 1";
  const spec = {
    shell: SHELL,
    group: `group 1 of ${SHELL}`,
    controls: [
      {
        label: "frequency = daily",
        kind: "popup" as const,
        path: `pop up button 1 of ${SHELL}`,
        expected: ["daily"],
      },
      {
        label: "interval = 3",
        kind: "group-number" as const,
        numberTarget: "interval" as const,
        expected: ["3"],
      },
      {
        label: "ends after = 4",
        kind: "group-number" as const,
        numberTarget: "ends-count" as const,
        expected: ["4"],
      },
      {
        label: "Add deadlines",
        kind: "checkbox" as const,
        path: `checkbox "Add deadlines" of ${SHELL}`,
        expected: ["1"],
        expectedLabel: "checked",
      },
      {
        label: "start 2 days earlier",
        kind: "row-field" as const,
        rowLabel: "days earlier",
        expected: ["2"],
      },
      {
        label: "weekdays = monday, thursday",
        kind: "weekdays" as const,
        weekdayBase: 3,
        expected: ["Monday", "Thursday"],
        expectedLabel: "Monday + Thursday",
      },
      {
        label: "Next (first occurrence) = 2026-07-12",
        kind: "occurrence-popup" as const,
        path: `pop up button 2 of group 1 of ${SHELL}`,
        expected: ["2026-07-12"],
      },
    ],
  };
  const script = axAuditDialogScript(spec);

  it("re-reads EVERY driven control, each through its own discriminated address", () => {
    // The whole point: not one of these is re-read through the index the step
    // wrote — the numbers go back through the label-row handlers, so a wrong
    // ADDRESS (the #589 shape) is visible here in a way a per-step read-back
    // structurally cannot be.
    expect(script).toContain('my cgField(g, cgSnapshot, "interval", 8)');
    expect(script).toContain('my cgField(g, cgSnapshot, "ends-count", 8)');
    expect(script).toContain('my rfField(sh, rfSnapshot, "days earlier", 8)');
    expect(script).toContain(`pop up button 1 of ${SHELL}`);
    expect(script).toContain(`checkbox "Add deadlines" of ${SHELL}`);
    expect(script).toContain("repeat with k from 3 to (count of pop up buttons of g)");
  });

  it("settles the cadence group before reading anything (no sleeps)", () => {
    expect(script).toContain("my cgSettle(g,");
    expect(script.indexOf("my cgSettle(g,")).toBeLessThan(
      script.indexOf('my cgField(g, cgSnapshot, "interval"'),
    );
  });

  it("returns OK only when nothing differs, and otherwise names every mismatch", () => {
    expect(script).toContain("if (count of bad) is not 0 then error");
    expect(script).toContain("does not hold what this drive entered");
    expect(script).toContain("control(s) differ");
    // Both values ride the message, so the operator can see what the app did.
    expect(script).toContain("intended");
    expect(script).toContain("dialog shows");
  });

  it("reads a checkbox as checked/unchecked rather than 1/0", () => {
    expect(script).toContain("on aqTick(v)");
    expect(script).toContain('return "checked"');
    expect(script).toContain('return "unchecked"');
  });

  it("compares the occurrence pop-up by PARSED DATE, never by display string", () => {
    // Its titles are localized ("Sun, Jul 12, 2026"), so rebuilding the app's
    // display string would be a locale bet — the audit parses instead.
    expect(script).toContain("on aqYMD(t)");
    expect(script).toContain("set d to date s");
    expect(script).toContain("2026-07-12");
  });

  it("compares the weekday rows as a SET, both directions", () => {
    // The converge law assigns every row from the target set cycling, so a
    // surplus row duplicates a target weekday; set equality is the exact check.
    expect(script).toContain("Monday");
    expect(script).toContain("Thursday");
    expect(script).toMatch(/repeat with w in \{"Monday", "Thursday"\}/);
    expect(script).toContain("repeat with w in got5");
  });
});

describe("axAuditDateAreasScript — the audit's date-area leg (CGRD1 guard 2)", () => {
  const script = axAuditDateAreasScript([
    { label: "ends on = 2026-12-01", target: "ends", spec: "date:2026-12-01" },
    { label: "reminder = 08:15", target: "reminder", spec: "time:08:15" },
  ]);

  it("uses the same shell walk and target discriminator the WRITE uses", () => {
    // If the reader and the writer disagreed about which area is "ends", the
    // audit would be checking a different control than the one that was set.
    expect(script).toContain("function findShell(app)");
    expect(script).toContain("function pick(areas,target)");
    expect(script).toContain("collect(shell,'AXDateTimeArea',16,found)");
  });

  it("reports a missing control with the dialog's whole date-area inventory", () => {
    expect(script).toContain("presents no ");
    expect(script).toContain("inv(found)");
  });

  it("names the intended and observed value on a mismatch, and OK otherwise", () => {
    expect(script).toContain("dialog shows");
    expect(script).toContain("does not hold what this drive entered");
    expect(script).toContain("return 'OK'");
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

// ===========================================================================
// DRVLAT1 (issue #633) — the hop COLLAPSE. A step used to dispatch its guard,
// its element resolution and its action as separate osascript processes; each
// of those is now a prelude of the ONE script that acts. These pin the shapes,
// their ORDER (a guard that ran after the input would prove nothing), and the
// bounded closed loops that replaced the fixed settles.
// ===========================================================================

describe("axCandidatePrelude — in-script element resolution (DRVLAT1)", () => {
  const script = axCandidatePrelude(["pop up button 1 of sheet 1", "pop up button 1 of window 2"]);

  it("probes the candidates IN PRIORITY ORDER and binds the first that exists", () => {
    expect(script.indexOf("sheet 1")).toBeLessThan(script.indexOf("window 2"));
    expect(script).toContain(`set ${STEP_ELEMENT_REF} to (pop up button 1 of sheet 1)`);
    expect(script).toContain(`if ${STEP_ELEMENT_REF} is not missing value then exit repeat`);
  });

  it("POLLS on a bounded deadline (the revealed control lands a beat later, UIC6)", () => {
    expect(script).toContain("set fgT0 to (current date)");
    expect(script).toMatch(/is greater than or equal to \d+ then exit repeat/);
    expect(script).toContain("delay 0.05");
  });

  it("fails closed with the driver's own wording when none of them appear", () => {
    expect(script).toContain(`if ${STEP_ELEMENT_REF} is missing value then error`);
    expect(script).toContain(CANDIDATES_MISSED);
  });
});

describe("axWaitAnyScript — the whole wait in one hop (DRVLAT1)", () => {
  const script = axWaitAnyScript(["sheet 1 of window 1", "window 2"], 5000);

  it("answers true/false rather than erroring — the driver's abort path is unchanged", () => {
    expect(script).toContain('return "true"');
    expect(script).toContain('return "false"');
  });

  it("polls every shape each round, on a bounded deadline", () => {
    expect(script).toContain("exists (sheet 1 of window 1)");
    expect(script).toContain("exists (window 2)");
    expect(script).toContain("is greater than or equal to 5 then");
  });
});

describe("commandForStep — a candidate-addressed step compiles to ONE script (DRVLAT1)", () => {
  const cmd = commandForStep(
    {
      primitive: "select-popup",
      label: "frequency = daily",
      pathCandidates: ["pop up button 1 of sheet 1", "pop up button 1 of window 2"],
      value: "daily",
      dynamic: true,
      addressing: "title",
    },
    "TODO-1",
  );

  it("resolves BEFORE it acts, in the same script, on the bound reference", () => {
    const script = cmd.script ?? "";
    expect(script).toContain(`set pu to (${STEP_ELEMENT_REF})`);
    expect(script.indexOf(`set ${STEP_ELEMENT_REF} to missing value`)).toBeLessThan(
      script.indexOf(`set pu to (${STEP_ELEMENT_REF})`),
    );
    expect(cmd.primitive).toBe("select-popup");
  });

  it("a wait step compiles to the polled multi-shape existence read", () => {
    const wait = commandForStep(
      {
        primitive: "wait",
        label: "the Repeat dialog",
        pathCandidates: ["sheet 1 of window 1", "window 2"],
        timeoutMs: 5000,
        dynamic: true,
      },
      "TODO-1",
    );
    expect(wait.primitive).toBe("wait");
    expect(wait.script).toContain('return "false"');
    expect(wait.script).not.toContain(STEP_ELEMENT_REF);
  });

  it("leaves a JXA step alone (an AppleScript prelude cannot ride a JXA script)", () => {
    const dt = commandForStep(
      {
        primitive: "set-datetime",
        label: "reminder = 09:00",
        value: "time:09:00",
        dtTarget: "reminder",
        pathCandidates: ["sheet 1 of window 1"],
        dynamic: true,
      },
      "TODO-1",
    );
    expect(dt.lang).toBe("javascript");
    expect(dt.script).not.toContain(STEP_ELEMENT_REF);
  });
});

describe("axFocusGuardPrelude — the census as the keystroke's own prelude (DRVLAT1)", () => {
  const prelude = axFocusGuardPrelude(null);

  it("runs the SAME census the stand-alone script does", () => {
    const census = axUiStateScript();
    for (const probe of ["-- P1 running", "-- P2 frontmost", "-- P3 dialog", "-- P5 focus"]) {
      expect(census).toContain(probe);
      expect(prelude).toContain(probe);
    }
  });

  it("LOGS the census record on one line, so the driver can re-judge it for the message", () => {
    expect(prelude).toContain(`log "${GUARD_LOG_PREFIX}"`);
    expect(prelude).toContain(`"${GUARD_LOG_SEP}"`);
    expect(prelude).not.toContain("linefeed");
  });

  it("refuses in-script with a bare TAG — never a sentence (one wording, in TypeScript)", () => {
    expect(prelude).toContain(`if fgBad then error "${GUARD_REFUSED_TAG}"`);
    expect(prelude).not.toContain("nothing was sent");
  });

  it("judges every branch judgeFocusGuard judges: critical probes, inspectable, frontmost", () => {
    for (const p of ["running", "frontmost", "dialog"]) {
      expect(prelude).toContain(`if stalled contains "${p} " then set fgBad to true`);
      expect(prelude).toContain(`if failed contains "${p} " then set fgBad to true`);
    }
    expect(prelude).toContain("if not canInspect then set fgBad to true");
    expect(prelude).toContain("if not frontIsThings then set fgBad to true");
  });

  it("adds the dialog invariant only once a sheet is latched", () => {
    expect(prelude).not.toContain("sheetKind is not");
    expect(axFocusGuardPrelude("repeat")).toContain(
      'if sheetKind is not "repeat" then set fgBad to true',
    );
  });
});

describe("parseGuardLog — recovering the folded census (DRVLAT1)", () => {
  it("parses the logged record and strips it out of the message", () => {
    const record = [
      "front=Finder",
      "isfront=false",
      "running=true",
      "form=none",
      "depth=0",
      "kind=none",
      "census=",
      "role=AXList",
      "subrole=",
      "inspectable=true",
      "stalled=",
      "failed=",
    ].join(GUARD_LOG_SEP);
    const { state, stderr } = parseGuardLog(
      `${GUARD_LOG_PREFIX}${record}\nexecution error: ${GUARD_REFUSED_TAG} (-2700)`,
    );
    expect(state?.frontmostApp).toBe("Finder");
    expect(state?.thingsFrontmost).toBe(false);
    expect(stderr).toContain(GUARD_REFUSED_TAG);
    expect(stderr).not.toContain(GUARD_LOG_PREFIX);
    expect(judgeFocusGuard(state, null, 'type "3" into the field')).toContain(
      "Finder is frontmost",
    );
  });

  it("reports no state at all when nothing was logged (fail-closed for the caller)", () => {
    expect(parseGuardLog("execution error: boom (-1728)").state).toBeNull();
  });
});

describe("axDialogOpenScript — the dialog wait and its census, in one hop (RDLAT2)", () => {
  const script = axDialogOpenScript(
    ['sheet 1 of (first window whose subrole is "AXStandardWindow")', "window 9"],
    5000,
  );

  it("polls the shells in priority order and reports WHICH one answered", () => {
    // The attached sheet is probed before the detached editor, and the index it
    // returns is what every later step addresses — so no hop after this one has
    // to ask about the shell that is demonstrably not there.
    expect(script.indexOf("AXStandardWindow")).toBeLessThan(script.indexOf("window 9"));
    expect(script).toContain("set dlgIdx to 1");
    expect(script).toContain("set dlgIdx to 2");
    expect(script).toContain('set out to "idx=" & dlgIdx & " roles="');
  });

  it("reads the shell's roles as ONE list, not a count per control class", () => {
    expect(script).toContain("set dlgRoles to (role of UI elements of dlgShell)");
    expect(script).not.toContain("count of checkboxes");
  });

  it("answers 'none' when the window elapses, leaving the abort path unchanged", () => {
    expect(script).toContain('return "none"');
  });
});

describe("axAuditDialogScript — the folded commit (RDLAT2)", () => {
  const controls = [
    {
      label: "frequency = weekly",
      kind: "popup" as const,
      path: "pop up button 1",
      expected: ["weekly"],
    },
  ];

  it("presses OK inside its own script, and only PAST the mismatch check", () => {
    // The audit and the press used to be two hops with a driver round trip in
    // between — a window in which the thing just audited can change. Folded,
    // what is committed is the state the audit read.
    const s = axAuditDialogScript({
      shell: "sheet 1",
      group: "group 1",
      controls,
      commit: 'button "OK" of sheet 1',
    });
    expect(s.indexOf("does not hold what this drive entered")).toBeLessThan(
      s.indexOf('click (button "OK" of sheet 1)'),
    );
    expect(s).toContain("if (count of bad) is not 0 then error");
  });

  it("tags a commit failure so it is never reported as an audit failure", () => {
    const s = axAuditDialogScript({
      shell: "sheet 1",
      group: "group 1",
      controls,
      commit: 'button "OK" of sheet 1',
    });
    expect(s).toContain(COMMIT_FAILED_TAG);
  });

  it("omits the press entirely when the recipe supplied no commit", () => {
    const s = axAuditDialogScript({ shell: "sheet 1", group: "group 1", controls });
    expect(s).not.toContain("click (");
    expect(s).toContain('return "OK"');
  });

  it("reads the SHELL's own field inventory only when a control needs it", () => {
    const withoutRowField = axAuditDialogScript({ shell: "sh", group: "g", controls });
    expect(withoutRowField).not.toContain("set rfSnapshot to");
    const withRowField = axAuditDialogScript({
      shell: "sh",
      group: "g",
      controls: [
        ...controls,
        {
          label: "start 2 days earlier",
          kind: "row-field" as const,
          rowLabel: "days earlier",
          expected: ["2"],
        },
      ],
    });
    expect(withRowField).toContain("set rfSnapshot to my cgSnap(sh)");
  });

  it("carries the manifest's expectation into the settle, or the -1 sentinel", () => {
    const advised = axAuditDialogScript({
      shell: "sh",
      group: "g",
      controls,
      expectation: { fields: 2, requiredLabels: ["Every", "Ends:"], forbiddenLabels: [] },
    });
    expect(advised).toContain('my cgSettle(g, 2, {"Every", "Ends:"}, {})');
    const unadvised = axAuditDialogScript({ shell: "sh", group: "g", controls });
    expect(unadvised).toContain("my cgSettle(g, -2, {}, {})");
    // -1 is the LABELS-ONLY sentinel: assert the anchor labels, leave the field
    // count alone (a pre-populated dialog may already show the ends field).
    const labelsOnly = axAuditDialogScript({
      shell: "sh",
      group: "g",
      controls,
      expectation: { fields: null, requiredLabels: ["Every", "Ends:"], forbiddenLabels: [] },
    });
    expect(labelsOnly).toContain('my cgSettle(g, -1, {"Every", "Ends:"}, {})');
  });
});

describe("the cadence group is read as ONE inventory (RDLAT2)", () => {
  it("asks for each property in the PLURAL — four events, whatever the control count", () => {
    const s = axSetGroupNumberScript("group 1 of sheet 1", "interval", "3");
    expect(s).toContain("set sv to (value of static texts of c)");
    expect(s).toContain("set sp to (position of static texts of c)");
    expect(s).toContain("set fv to (value of text fields of c)");
    expect(s).toContain("set fp to (position of text fields of c)");
    // …and never one control at a time, which is what made a scan cost a
    // round-trip per label.
    expect(s).not.toContain("value of static text i of");
    expect(s).not.toContain("position of text field i of");
  });

  it("treats a mismatched pair of plural reads as NOT-YET-SETTLED, never as a shape", () => {
    // The two reads of a class are two events, so a tree that changes between
    // them can answer different lengths. That is a snapshot to discard, not a
    // picture to reason from.
    const s = axSetGroupNumberScript("group 1 of sheet 1", "interval", "3");
    expect(s).toContain(
      "set ok to ((count of sv) is (count of sp)) and ((count of fv) is (count of fp))",
    );
    expect(s).toContain('if not (my cgValid(snap)) then return ""');
  });

  it("WAITS for the expected shape when the manifest supplied one, and refuses if it never comes", () => {
    const s = axSetGroupNumberScript(
      "group 1 of sheet 1",
      "ends-count",
      "4",
      undefined,
      undefined,
      {
        fields: 2,
        requiredLabels: ["Every", "Ends:"],
        forbiddenLabels: [],
      },
    );
    expect(s).toContain('my cgSettle(g, 2, {"Every", "Ends:"}, {})');
    expect(s).toContain("never took the shape this step expects");
  });
});

describe("the typing loop waits for focus rather than refusing on the first miss (RDLAT2)", () => {
  for (const [name, script] of [
    ["set-value", axSetValueScript("text field 1", "3")],
    ["set-group-number", axSetGroupNumberScript("group 1", "interval", "3")],
    ["set-row-field", axSetRowFieldScript("sheet 1", "days earlier", "3")],
  ] as const) {
    it(`${name}: types only with proven focus, and refuses once the attempts are spent`, () => {
      // The property that matters is unchanged — nothing is typed unless the
      // field is observed focused. What changed is that a field which is not
      // ready YET gets another attempt instead of an immediate refusal, so the
      // guard stops depending on how long the driver's own reads happen to take.
      expect(script).toContain("if gotFocus then");
      expect(script.indexOf("if gotFocus then")).toBeLessThan(script.indexOf('keystroke "3"'));
      expect(script).toContain(
        'if not gotFocus then error "refused to type \\"3\\": the field did not take keyboard focus',
      );
      expect(script.indexOf('keystroke "3"')).toBeLessThan(script.indexOf("if not gotFocus then"));
    });
  }
});

describe("splitAeDebug — the AX round-trip counter (RDLAT2)", () => {
  it("counts one per logged Apple event and REMOVES every diagnostic line", () => {
    // The diagnostic writes to stdout, interleaved ahead of the script's own
    // result — which is the stream every step's verdict is parsed from. An armed
    // count must not change a single verdict.
    const raw =
      "{core,cnte target='psn '[System Events] {kocl=cwin} returnID=-1}\n" +
      "{core,getd target='psn '[System Events] {} returnID=-2}\n" +
      "true";
    const { axOps, text } = splitAeDebug(raw);
    expect(axOps).toBe(2);
    expect(text.trim()).toBe("true");
  });

  it("leaves ordinary output and refusal text untouched", () => {
    const msg = 'execution error: refused to type "3": the field did not take keyboard focus';
    expect(splitAeDebug(msg)).toEqual({ axOps: 0, text: msg });
    expect(splitAeDebug("")).toEqual({ axOps: 0, text: "" });
  });
});

describe("parseElemLog — the element-realization counter (RDLAT2 §E)", () => {
  it("SUMS every line and removes them all", () => {
    // A hop reports once per container it read, so a guard-folded keystroke hop
    // logs the shell, the group, and each snapshot the settle took.
    const raw = `${AX_ELEMS_LOG_PREFIX}8\n${AX_ELEMS_LOG_PREFIX}3\n${AX_ELEMS_LOG_PREFIX}2`;
    expect(parseElemLog(raw)).toEqual({ axElems: 13, stderr: "" });
  });

  it("leaves a refusal sentence intact, and reports null when nothing was logged", () => {
    const msg = 'execution error: refused to type "3": the field did not take keyboard focus';
    expect(parseElemLog(msg)).toEqual({ axElems: null, stderr: msg });
    expect(parseElemLog("")).toEqual({ axElems: null, stderr: "" });
  });

  it("keeps the surrounding stderr when a count rides alongside it", () => {
    const { axElems, stderr } = parseElemLog(`${AX_ELEMS_LOG_PREFIX}4\nexecution error: boom`);
    expect(axElems).toBe(4);
    expect(stderr).toBe("execution error: boom");
  });

  it("ignores a line whose count is not a number rather than counting it as zero", () => {
    expect(parseElemLog(`${AX_ELEMS_LOG_PREFIX}oops`).axElems).toBeNull();
  });
});

describe("the scripts report what they realized (RDLAT2 §E)", () => {
  it("the group inventory reports its statics and fields — never its positions", () => {
    const s = axSetGroupNumberScript("group 1 of sheet 1", "interval", "3");
    // Values realize; positions are answered out of the layout the app already
    // holds, so the reported count is the two VALUE reads and neither position
    // read — even though the snapshot takes all four.
    expect(s).toContain(`log "${AX_ELEMS_LOG_PREFIX}" & ((count of sv) + (count of fv))`);
    expect(s).not.toContain(`${AX_ELEMS_LOG_PREFIX}" & ((count of sv) + (count of sp))`);
  });

  it("the pre-commit audit reports one realization per control it re-reads", () => {
    const s = axAuditDialogScript({
      shell: "sh",
      group: "g",
      controls: [
        { label: "frequency", kind: "popup", path: "pop up button 1", expected: ["weekly"] },
        { label: "interval", kind: "group-number", numberTarget: "interval", expected: ["3"] },
      ],
    });
    expect(s).toContain(`log "${AX_ELEMS_LOG_PREFIX}2"`);
  });

  it("a pop-up reports the menu items its title search realizes", () => {
    const s = axSelectPopupCandidatesScript("pop up button 1", ["month", "months"]);
    expect(s).toContain(`log "${AX_ELEMS_LOG_PREFIX}" & (count of menu items of menu 1 of pu)`);
  });
});
