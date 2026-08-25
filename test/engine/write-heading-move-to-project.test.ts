/**
 * project.move-heading-to-project (HEADXPROJ / HXPC1). Covers
 * `classifyHeadingMoveToProject` — the source/heading/destination resolution and
 * every fail-closed refusal (the title-collision surfaces the ellipsis Move… drive
 * cannot disambiguate, plus the completed/canceled destination the Move… picker
 * does not list at all) — and the recipe shape (reveal source → activate → click
 * the "More. <title>" button → Move… → narrow the picker → CLICK the destination
 * row). Pure classifier + recipe assertions; no `open` / System Events call fires.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyHeadingMoveToProject } from "../../src/write/pre-state.ts";
import { moveHeadingToProjectRecipe } from "../../src/write/vectors/ui-recipes.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedHeading, seedProject } from "../fixtures/seed.ts";

let fixture: FixtureDb;
beforeEach(() => {
  fixture = buildFixtureDb();
});
afterEach(() => fixture.close());

describe("classifyHeadingMoveToProject (HEADXPROJ)", () => {
  it("resolves source project, heading (by title), and destination into the drive pre", () => {
    const src = seedProject(fixture.db, { title: "Src" });
    const dst = seedProject(fixture.db, { title: "Dst" });
    const h = seedHeading(fixture.db, { title: "Phase 1", project: src });
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: src }, "Phase 1", { uuid: dst });
    expect(tax).toEqual({
      kind: "ok",
      pre: {
        sourceProjectUuid: src,
        headingUuid: h,
        headingTitle: "Phase 1",
        destProjectUuid: dst,
        destProjectTitle: "Dst",
      },
    });
  });

  it("resolves the heading by uuid too", () => {
    const src = seedProject(fixture.db, { title: "Src" });
    const dst = seedProject(fixture.db, { title: "Dst" });
    const h = seedHeading(fixture.db, { title: "H", project: src });
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: src }, h, { uuid: dst });
    expect(tax.kind).toBe("ok");
  });

  it("refuses a missing source project", () => {
    const dst = seedProject(fixture.db, { title: "Dst" });
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: "nope" }, "H", { uuid: dst });
    expect(tax).toMatchObject({ kind: "refuse", refusal: "no-source" });
  });

  it("refuses a heading absent from the source project", () => {
    const src = seedProject(fixture.db, { title: "Src" });
    const dst = seedProject(fixture.db, { title: "Dst" });
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: src }, "Ghost", { uuid: dst });
    expect(tax).toMatchObject({ kind: "refuse", refusal: "heading-not-found" });
  });

  it("refuses a heading title shared by another heading in the SAME project (title-addressed drive)", () => {
    const src = seedProject(fixture.db, { title: "Src" });
    const dst = seedProject(fixture.db, { title: "Dst" });
    const h1 = seedHeading(fixture.db, { title: "Dup", project: src, index: -100 });
    seedHeading(fixture.db, { title: "Dup", project: src, index: 0 });
    // Even resolving BY UUID, the "More. Dup" node cannot pick one of the twins.
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: src }, h1, { uuid: dst });
    expect(tax).toMatchObject({ kind: "refuse", refusal: "heading-ambiguous" });
    if (tax.kind === "refuse") expect(tax.candidates?.length).toBe(2);
  });

  it("refuses a titleless heading (the 'More. ' description is not unique)", () => {
    const src = seedProject(fixture.db, { title: "Src" });
    const dst = seedProject(fixture.db, { title: "Dst" });
    const h = seedHeading(fixture.db, { title: "", project: src });
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: src }, h, { uuid: dst });
    expect(tax).toMatchObject({ kind: "refuse", refusal: "empty-heading-title" });
  });

  it("refuses a missing destination project", () => {
    const src = seedProject(fixture.db, { title: "Src" });
    seedHeading(fixture.db, { title: "H", project: src });
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: src }, "H", { uuid: "gone" });
    expect(tax).toMatchObject({ kind: "refuse", refusal: "no-dest" });
  });

  it("refuses moving to the heading's own project (a no-op — use move-heading to reorder)", () => {
    const src = seedProject(fixture.db, { title: "Src" });
    seedHeading(fixture.db, { title: "H", project: src });
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: src }, "H", { uuid: src });
    expect(tax).toMatchObject({ kind: "refuse", refusal: "same-project" });
  });

  it("refuses a destination title shared by another project (one picker row each, both by title)", () => {
    const src = seedProject(fixture.db, { title: "Src" });
    const dst = seedProject(fixture.db, { title: "Twin" });
    seedProject(fixture.db, { title: "Twin" }); // a second project with the destination's title
    seedHeading(fixture.db, { title: "H", project: src });
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: src }, "H", { uuid: dst });
    expect(tax).toMatchObject({ kind: "refuse", refusal: "dest-ambiguous" });
  });

  it("refuses a COMPLETED destination — the Move… picker lists open projects only (HXPC1 §B4)", () => {
    const src = seedProject(fixture.db, { title: "Src" });
    const dst = seedProject(fixture.db, { title: "Archive", status: "completed" });
    seedHeading(fixture.db, { title: "H", project: src });
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: src }, "H", { uuid: dst });
    expect(tax).toMatchObject({ kind: "refuse", refusal: "dest-not-open" });
    if (tax.kind === "refuse") expect(tax.detail).toContain("completed");
  });

  it("refuses a CANCELED destination for the same reason, naming it as canceled", () => {
    const src = seedProject(fixture.db, { title: "Src" });
    const dst = seedProject(fixture.db, { title: "Dropped", status: "canceled" });
    seedHeading(fixture.db, { title: "H", project: src });
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: src }, "H", { uuid: dst });
    expect(tax).toMatchObject({ kind: "refuse", refusal: "dest-not-open" });
    if (tax.kind === "refuse") expect(tax.detail).toContain("canceled");
  });

  it("ALLOWS a destination whose title is a prefix of another project's (HXPC1 §B3 — the row is addressed exactly)", () => {
    const src = seedProject(fixture.db, { title: "Src" });
    const dst = seedProject(fixture.db, { title: "Synthetic Work" });
    seedProject(fixture.db, { title: "Synthetic Work Stuff" });
    seedHeading(fixture.db, { title: "H", project: src });
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: src }, "H", { uuid: dst });
    expect(tax.kind).toBe("ok");
    if (tax.kind === "ok") expect(tax.pre.destProjectTitle).toBe("Synthetic Work");
  });
});

describe("moveHeadingToProjectRecipe", () => {
  it("reveals the source, foregrounds, clicks the titled More button + Move…, narrows, then CLICKS the row", () => {
    const recipe = moveHeadingToProjectRecipe("src-uuid", "Phase 1", "Dst");
    expect(recipe.op).toBe("project.move-heading-to-project");
    expect(recipe.targetUuid).toBe("src-uuid");
    const primitives = recipe.steps.map((s) => s.primitive);
    expect(primitives).toEqual([
      "reveal",
      "activate",
      "click-element",
      "click-element",
      "type-text",
      "click-picker-row",
    ]);
    // The heading's "More. <title>" node sits three levels below the content
    // table, so the table is addressed and the description matched by the walk.
    expect(recipe.steps[2]?.path).toContain("table 1 of scroll area 1");
    expect(recipe.steps[2]?.rowCellDescription).toBe("More. Phase 1");
    // The Move… popover item (a direct child of the popover's scroll area).
    expect(recipe.steps[3]?.path).toContain('description is "Move…"');
    // The destination narrows the picker, then names the row that is clicked —
    // no Return is ever pressed, so the `New Project "<typed>"` row is unreachable.
    expect(recipe.steps[4]?.value).toBe("Dst");
    expect(recipe.steps[5]?.value).toBe("Dst");
    // The commit step names the picker WINDOW: the resolver checks its identity
    // (an `AXIdentifier` beginning MovePopUpDialog-) before it reads any row.
    expect(recipe.steps[5]?.path).toContain('subrole is "AXUnknown"');
    expect(recipe.steps.some((s) => s.primitive === "key")).toBe(false);
  });
});
