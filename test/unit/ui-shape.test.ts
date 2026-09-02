/**
 * The Repeat dialog's SHAPE MANIFEST (RDLAT2, docs/lab/rdlat2-repeat-dialog-latency.md).
 *
 * Two very different jobs live in this module and the cells below keep them
 * apart. The SHELL match is an assertion — a dialog that does not present the
 * measured control census is not the one this driver knows, and the drive
 * refuses. The CADENCE expectation is advisory — it lets a settle stop the
 * moment the group demonstrably shows the state the step was meant to produce,
 * and its absence costs nothing but a few milliseconds.
 */
import { describe, expect, it } from "vitest";

import {
  cadenceExpectationFor,
  matchRepeatShell,
  parseDialogOpenSnapshot,
  shapeManifestCoversVersion,
  shellRoleCensus,
} from "../../src/write/vectors/ui-shape.ts";

/** The role list measured on Things 3.23 (build 32300036), attached sheet. */
const REPEAT_ROLES = [
  "AXCheckBox",
  "AXCheckBox",
  "AXGroup",
  "AXStaticText",
  "AXPopUpButton",
  "AXButton",
  "AXButton",
  "AXImage",
];

describe("matchRepeatShell — the dialog's control census, asserted at the open", () => {
  it("accepts the measured 3.23 shell, and counts it the way the census does", () => {
    const verdict = matchRepeatShell(REPEAT_ROLES);
    expect(verdict.ok).toBe(true);
    const census = shellRoleCensus(REPEAT_ROLES);
    // The same five numbers the window/focus census reports as `cb:2 pu:1 bt:2
    // gp:1 tf:0` — which is what makes reading them from one role list, rather
    // than five `count of <class>` round-trips, a pure economy.
    expect(census).toMatchObject({
      checkBoxes: 2,
      popUps: 1,
      buttons: 2,
      groups: 1,
      textFields: 0,
    });
  });

  it("accepts the DEADLINES-TICKED shape, which mints a direct text field (#646/CNCAC2)", () => {
    // Ticking "Add deadlines" reveals the "and start N days earlier" offset as a
    // DIRECT child of the shell. A census that insisted on zero text fields
    // re-classified the drive's own sheet mid-drive; the manifest permits 0 or 1.
    expect(matchRepeatShell([...REPEAT_ROLES, "AXTextField"]).ok).toBe(true);
  });

  it("accepts the DETACHED editor, whose census is identical (DRVLAT1 §5)", () => {
    expect(matchRepeatShell(REPEAT_ROLES.toReversed()).ok).toBe(true);
  });

  it("REFUSES a shell whose census has moved, naming every difference", () => {
    const verdict = matchRepeatShell(["AXCheckBox", "AXGroup", "AXButton", "AXTextField"]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain("1 checkboxes (expected 2)");
    expect(verdict.why).toContain("0 pop-up buttons (expected 1)");
    expect(verdict.why).toContain("1 buttons (expected 2)");
  });

  it("REFUSES a second text field — the shape #589 would have written into", () => {
    const verdict = matchRepeatShell([...REPEAT_ROLES, "AXTextField", "AXTextField"]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain("2 text fields (expected 0 or 1)");
  });

  it("REFUSES an empty census — an unreadable shell is not a matching one", () => {
    expect(matchRepeatShell([]).ok).toBe(false);
  });
});

describe("shapeManifestCoversVersion — the invalidation key", () => {
  it("covers the generation the expectations were measured against, and its point releases", () => {
    for (const v of ["3.23", "3.23.1", "3.23.2"]) {
      expect(shapeManifestCoversVersion(v)).toBe(true);
    }
  });

  it("does NOT cover a different generation, or an unreadable version", () => {
    // An AX surface is an undocumented private API: a build nobody has sat the
    // lab with gets the full per-step discrimination, not a remembered shape.
    for (const v of ["3.22", "3.22.14", "3.24", "4.0", "232", null]) {
      expect(shapeManifestCoversVersion(v)).toBe(false);
    }
  });

  it("does not match a version that merely STARTS with the prefix's digits", () => {
    expect(shapeManifestCoversVersion("3.230")).toBe(false);
  });
});

describe("cadenceExpectationFor — advisory, and only where it discriminates", () => {
  it("after completion: one field, and NEITHER anchor label (CGRD1 §A law 2)", () => {
    const e = cadenceExpectationFor({ afterCompletion: true, endsAfter: false }, "3.23");
    expect(e).toEqual({ fields: 1, requiredLabels: [], forbiddenLabels: ["Every", "Ends:"] });
  });

  it("ends-after: TWO fields, because the bound inserts the count (CGRD1 §A law 3)", () => {
    const e = cadenceExpectationFor({ afterCompletion: false, endsAfter: true }, "3.23");
    expect(e).toEqual({ fields: 2, requiredLabels: ["Every", "Ends:"], forbiddenLabels: [] });
  });

  it("a plain fixed frequency asserts the LABELS but not the field count", () => {
    // The count is not something this step can know — a reschedule opens the
    // dialog pre-populated, so a rule that already ends after N shows two fields
    // before anything is touched, and asserting one would refuse a good drive.
    // The labels ARE knowable, and they are what makes this a real transition
    // detector: `make-repeating` opens on the dialog's after-completion default,
    // which carries neither label, so waiting for them is waiting for the
    // frequency switch to have actually rebuilt the group. Against a group that
    // was already fixed it matches at once, giving back exactly the guarantee
    // the agreement rule gave alone.
    expect(cadenceExpectationFor({ afterCompletion: false, endsAfter: false }, "3.23")).toEqual({
      fields: null,
      requiredLabels: ["Every", "Ends:"],
      forbiddenLabels: [],
    });
  });

  it("says nothing at all on an app generation it was not measured against", () => {
    expect(cadenceExpectationFor({ afterCompletion: true, endsAfter: false }, "3.22")).toBeNull();
    expect(cadenceExpectationFor({ afterCompletion: false, endsAfter: true }, null)).toBeNull();
  });
});

describe("parseDialogOpenSnapshot — the open hop's report", () => {
  it("reads the shell index and its roles", () => {
    expect(parseDialogOpenSnapshot("idx=2 roles=AXCheckBox,AXGroup,AXButton\n")).toEqual({
      index: 2,
      roles: ["AXCheckBox", "AXGroup", "AXButton"],
    });
  });

  it("reads a shell that reported NO roles as a match candidate with none", () => {
    expect(parseDialogOpenSnapshot("idx=1 roles=")).toEqual({ index: 1, roles: [] });
  });

  it("returns null for the hop's own timeout verdict and for anything unrecognized", () => {
    for (const s of ["none", "", "true", "idx=0 roles=AXGroup", "roles=AXGroup"]) {
      expect(parseDialogOpenSnapshot(s)).toBeNull();
    }
  });
});
