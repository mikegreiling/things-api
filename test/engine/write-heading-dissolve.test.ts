/**
 * project.dissolve-heading (DISS1). Covers `classifyHeadingDissolve` (parent
 * reveal + title-addressed drive + its refusals), the recipe shape (reveal →
 * activate → click "More. <title>" → Delete, a TERMINAL click since DISS1 found
 * no confirm sheet), and the task-`gone` verify mode the op relies on (the
 * heading row is hard-deleted). Pure classifier + recipe + delta assertions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { byUuid } from "../../src/read/detail.ts";
import { classifyHeadingDissolve } from "../../src/write/pre-state.ts";
import { createDbReader, evaluateDelta } from "../../src/write/verify/delta.ts";
import { dissolveHeadingRecipe } from "../../src/write/vectors/ui-recipes.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

let fixture: FixtureDb;
beforeEach(() => {
  fixture = buildFixtureDb();
});
afterEach(() => fixture.close());

describe("classifyHeadingDissolve (DISS1)", () => {
  it("returns the parent reveal, heading title, and its OPEN children in index order", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const h = seedHeading(fixture.db, { title: "Phase 1", project: proj });
    const c1 = seedTodo(fixture.db, { title: "c1", heading: h, index: -300 });
    const c2 = seedTodo(fixture.db, { title: "c2", heading: h, index: 0 });
    expect(classifyHeadingDissolve(fixture.db, byUuid(fixture.db, h))).toEqual({
      kind: "ok",
      pre: { projectReveal: proj, headingUuid: h, headingTitle: "Phase 1", childUuids: [c1, c2] },
    });
  });

  it("is fine with a childless heading (children list empty)", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const h = seedHeading(fixture.db, { title: "Empty", project: proj });
    expect(classifyHeadingDissolve(fixture.db, byUuid(fixture.db, h))).toMatchObject({
      kind: "ok",
      pre: { childUuids: [] },
    });
  });

  it("refuses a non-heading target", () => {
    expect(classifyHeadingDissolve(fixture.db, null)).toMatchObject({
      kind: "refuse",
      refusal: "not-a-heading",
    });
  });

  it("refuses a heading title shared by another heading in the SAME project", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const h1 = seedHeading(fixture.db, { title: "Dup", project: proj, index: -100 });
    seedHeading(fixture.db, { title: "Dup", project: proj, index: 0 });
    const tax = classifyHeadingDissolve(fixture.db, byUuid(fixture.db, h1));
    expect(tax).toMatchObject({ kind: "refuse", refusal: "title-ambiguous" });
    if (tax.kind === "refuse") expect(tax.candidates?.length).toBe(2);
  });

  it("refuses a titleless heading", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const h = seedHeading(fixture.db, { title: "", project: proj });
    expect(classifyHeadingDissolve(fixture.db, byUuid(fixture.db, h))).toMatchObject({
      kind: "refuse",
      refusal: "empty-title",
    });
  });
});

describe("dissolveHeadingRecipe", () => {
  it("reveals, foregrounds, clicks the titled More button, then Delete (terminal — no confirm)", () => {
    const recipe = dissolveHeadingRecipe("proj-uuid", "Phase 1");
    expect(recipe.op).toBe("project.dissolve-heading");
    expect(recipe.steps.map((s) => s.primitive)).toEqual([
      "reveal",
      "activate",
      "click-element",
      "click-element",
    ]);
    // The "More. <title>" node sits three levels below the content table, so the
    // table is addressed and the description is matched by the row/cell walk
    // (HXPC1 §B0 — a `whose` clause on the table reaches only its rows).
    expect(recipe.steps[2]?.path).toContain("table 1 of scroll area 1");
    expect(recipe.steps[2]?.rowCellDescription).toBe("More. Phase 1");
    expect(recipe.steps[3]?.path).toContain('description is "Delete"');
    // The Delete click is TERMINAL: no successor element is asserted (DISS1 — no
    // confirmation sheet; the read-after-write verifies the heading is gone).
    expect(recipe.steps[3]?.assertPath).toBeUndefined();
  });
});

describe("verify: task `gone` mode (the hard-deleted heading)", () => {
  it("is satisfied only once the heading row is absent from TMTask", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const h = seedHeading(fixture.db, { title: "H", project: proj });
    const reader = createDbReader(fixture.db);
    const spec = { mode: "gone" as const, entity: "task" as const, uuid: h };
    // Present → not satisfied.
    expect(evaluateDelta(spec, reader, { modDates: {}, fields: {} }).satisfied).toBe(false);
    // Hard-delete the row (what the ellipsis Delete does, DISS1) → satisfied.
    fixture.db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(h);
    expect(evaluateDelta(spec, reader, { modDates: {}, fields: {} }).satisfied).toBe(true);
  });
});
