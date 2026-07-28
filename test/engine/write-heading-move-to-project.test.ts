/**
 * project.move-heading-to-project (HEADXPROJ / HXPC1). Covers
 * `classifyHeadingMoveToProject` — the source/heading/destination resolution and
 * every fail-closed refusal (the two title-collision surfaces the ellipsis Move…
 * drive cannot disambiguate) — and the recipe shape (reveal source → activate →
 * click the "More. <title>" button → Move… → type the destination → Return). Pure
 * classifier + recipe assertions; no `open` / System Events call fires.
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

  it("refuses a destination title shared by another project (the picker searches by title)", () => {
    const src = seedProject(fixture.db, { title: "Src" });
    const dst = seedProject(fixture.db, { title: "Twin" });
    seedProject(fixture.db, { title: "Twin" }); // a second project with the destination's title
    seedHeading(fixture.db, { title: "H", project: src });
    const tax = classifyHeadingMoveToProject(fixture.db, { uuid: src }, "H", { uuid: dst });
    expect(tax).toMatchObject({ kind: "refuse", refusal: "dest-ambiguous" });
  });
});

describe("moveHeadingToProjectRecipe", () => {
  it("reveals the source, foregrounds, clicks the titled More button + Move…, types the dest, Returns", () => {
    const recipe = moveHeadingToProjectRecipe("src-uuid", "Phase 1", "Dst");
    expect(recipe.op).toBe("project.move-heading-to-project");
    expect(recipe.targetUuid).toBe("src-uuid");
    const primitives = recipe.steps.map((s) => s.primitive);
    expect(primitives).toEqual([
      "reveal",
      "activate",
      "click-element",
      "click-element",
      "set-value",
      "key",
    ]);
    // The heading is addressed by its title-carrying "More. <title>" node.
    expect(recipe.steps[2]?.path).toContain('description is "More. Phase 1"');
    // The Move… popover item.
    expect(recipe.steps[3]?.path).toContain('description is "Move…"');
    // The destination is typed into the picker; Return selects the filtered match.
    expect(recipe.steps[4]?.value).toBe("Dst");
    expect(recipe.steps[5]?.keys).toBe("return");
  });
});
