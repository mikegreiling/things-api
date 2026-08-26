/**
 * The heading-selector resolver (spec §2) and the project.move-heading order
 * computation. The resolver is the ONE shared core every heading-consuming
 * surface uses: exact title OR uuid, empty-string literal legal, duplicates
 * fail closed with uuid candidates, no ordinal form.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReferenceResolutionError, resolveHeadingUuid } from "../../src/read/queries.ts";
import { computeHeadingMovePre } from "../../src/write/pre-state.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

let fixture: FixtureDb;
beforeEach(() => {
  fixture = buildFixtureDb();
});
afterEach(() => {
  fixture.close();
});

describe("resolveHeadingUuid (heading selector)", () => {
  it("resolves an exact title within the project", () => {
    const project = seedProject(fixture.db, { title: "P" });
    const h = seedHeading(fixture.db, { title: "Phase 1", project });
    expect(resolveHeadingUuid(fixture.db, project, "Phase 1").uuid).toBe(h);
  });

  it("resolves a uuid", () => {
    const project = seedProject(fixture.db, { title: "P" });
    const h = seedHeading(fixture.db, { title: "Phase 1", project });
    expect(resolveHeadingUuid(fixture.db, project, h).uuid).toBe(h);
  });

  it("resolves an EMPTY-STRING title as a legal literal query", () => {
    const project = seedProject(fixture.db, { title: "P" });
    const titleless = seedHeading(fixture.db, { title: "", project });
    seedHeading(fixture.db, { title: "Named", project });
    expect(resolveHeadingUuid(fixture.db, project, "").uuid).toBe(titleless);
  });

  it("fails closed on a DUPLICATE title with uuid-bearing candidates", () => {
    const project = seedProject(fixture.db, { title: "P" });
    const a = seedHeading(fixture.db, { title: "Dup", project, index: 1 });
    const b = seedHeading(fixture.db, { title: "Dup", project, index: 2 });
    try {
      resolveHeadingUuid(fixture.db, project, "Dup");
      throw new Error("expected a ReferenceResolutionError");
    } catch (err) {
      expect(err).toBeInstanceOf(ReferenceResolutionError);
      const e = err as ReferenceResolutionError;
      expect(e.code).toBe("ambiguous");
      expect(e.candidates.map((c) => c.uuid).toSorted()).toEqual([a, b].toSorted());
    }
  });

  it("fails closed on a not-found selector (scoped to the project)", () => {
    const project = seedProject(fixture.db, { title: "P" });
    const other = seedProject(fixture.db, { title: "Other" });
    const foreign = seedHeading(fixture.db, { title: "Elsewhere", project: other });
    // A heading in a DIFFERENT project is not found here (fail closed).
    expect(() => resolveHeadingUuid(fixture.db, project, "Elsewhere")).toThrow(
      ReferenceResolutionError,
    );
    expect(() => resolveHeadingUuid(fixture.db, project, foreign)).toThrow(
      ReferenceResolutionError,
    );
  });
});

describe("computeHeadingMovePre (project.move-heading order)", () => {
  function seedThree() {
    const project = seedProject(fixture.db, { title: "P" });
    const h1 = seedHeading(fixture.db, { title: "H1", project, index: 1 });
    const h2 = seedHeading(fixture.db, { title: "H2", project, index: 2 });
    const h3 = seedHeading(fixture.db, { title: "H3", project, index: 3 });
    const proj = { resolved: { uuid: project, title: "P" }, matches: 1 };
    return { project, proj, h1, h2, h3 };
  }

  it("--first / --last place a single heading at the ends", () => {
    const { proj, h1, h2, h3 } = seedThree();
    expect(
      computeHeadingMovePre(fixture.db, proj, [h3], { position: "first" }).targetOrder,
    ).toEqual([h3, h1, h2]);
    expect(computeHeadingMovePre(fixture.db, proj, [h1], { position: "last" }).targetOrder).toEqual(
      [h2, h3, h1],
    );
  });

  it("VARIADIC block: selection order is the resulting order, inserted at the anchor", () => {
    const { proj, h1, h2, h3 } = seedThree();
    // Move [h3, h1] as a block before h2 → h3, h1 land contiguously in that order.
    expect(computeHeadingMovePre(fixture.db, proj, [h3, h1], { before: h2 }).targetOrder).toEqual([
      h3,
      h1,
      h2,
    ]);
    // …and --after the anchor.
    expect(computeHeadingMovePre(fixture.db, proj, [h1, h3], { after: h2 }).targetOrder).toEqual([
      h2,
      h1,
      h3,
    ]);
  });

  it("rejects an anchor that is one of the moved headings", () => {
    const { proj, h1, h2 } = seedThree();
    const pre = computeHeadingMovePre(fixture.db, proj, [h1, h2], { before: h1 });
    expect(pre.problems.join(" ")).toContain("anchor heading cannot also be one of the moved");
  });

  it("rejects a movee that is not a heading of this project, and duplicates", () => {
    const { proj, h1 } = seedThree();
    const other = seedProject(fixture.db, { title: "Other" });
    const foreign = seedHeading(fixture.db, { title: "X", project: other });
    expect(
      computeHeadingMovePre(fixture.db, proj, [foreign], { position: "first" }).problems.join(" "),
    ).toContain("not a heading of this project");
    expect(
      computeHeadingMovePre(fixture.db, proj, [h1, h1], { position: "first" }).problems.join(" "),
    ).toContain("listed more than once");
  });

  it("CHORDMH1: `untouched` fences the headings the move never passes over", () => {
    const { proj, h1, h2, h3 } = seedThree();
    // Move h3 to the front: h1 and h2 both shift down a slot, and a chord may
    // renumber a row it passes (moving DOWN rewrites the passed sibling, not the
    // mover — CHORDMH1 arm 2), so neither may be asserted byte-identical.
    expect(computeHeadingMovePre(fixture.db, proj, [h3], { position: "first" }).untouched).toEqual(
      [],
    );
    // Move h3 up one slot: h1 keeps position 0 and is provably untouched.
    const pre = computeHeadingMovePre(fixture.db, proj, [h3], { before: h2 });
    expect(pre.targetOrder).toEqual([h1, h3, h2]);
    expect(pre.untouched).toEqual([h1]);
    expect(pre.children).toEqual([]);
  });

  it("CHORDMH1: `children` carries every non-trashed child of a MOVED heading, with its FK", () => {
    const { proj, h1, h3 } = seedThree();
    const kept = seedTodo(fixture.db, { title: "k", heading: h3 });
    seedTodo(fixture.db, { title: "elsewhere", heading: h1 });
    const trashed = seedTodo(fixture.db, { title: "gone", heading: h3 });
    fixture.db.prepare("UPDATE TMTask SET trashed = 1 WHERE uuid = ?").run(trashed);
    const pre = computeHeadingMovePre(fixture.db, proj, [h3], { position: "first" });
    expect(pre.children).toEqual([{ uuid: kept, heading: h3 }]);
  });

  it("CHORDMH1: an ARCHIVED heading anywhere in the project refuses the whole move", () => {
    const project = seedProject(fixture.db, { title: "P" });
    seedHeading(fixture.db, { title: "H1", project, index: 1 });
    seedHeading(fixture.db, {
      title: "H2arch",
      project,
      index: 2,
      status: "completed",
      stopDate: 1,
    });
    const h3 = seedHeading(fixture.db, { title: "H3", project, index: 3 });
    const proj = { resolved: { uuid: project, title: "P" }, matches: 1 };
    // The chord vector addresses heading rows POSITIONALLY in the rendered project
    // view, and whether Things renders an archived heading there is unmeasured —
    // so one anywhere in the project makes every ordinal unvouchable. Refuse.
    const pre = computeHeadingMovePre(fixture.db, proj, [h3], { position: "first" });
    expect(pre.problems.join(" ")).toContain("completed/canceled heading");
    expect(pre.untouched).toEqual([]);
    expect(pre.children).toEqual([]);
  });
});
