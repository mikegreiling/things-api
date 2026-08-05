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
import { seedHeading, seedProject } from "../fixtures/seed.ts";

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

  it("#V11: the wire is the MINIMAL front-cluster set, never the full order", () => {
    const { proj, h1, h2, h3 } = seedThree();
    // Moving h3 to the front is realized by front-clustering h3 alone — h1,h2 keep
    // their current relative order at the back. So the wire is just [h3].
    const pre = computeHeadingMovePre(fixture.db, proj, [h3], { position: "first" });
    expect(pre.targetOrder).toEqual([h3, h1, h2]);
    expect(pre.wire).toEqual([h3]);
    expect(pre.reopened).toEqual([]);
  });

  it("#V11: an archived heading that need not move stays OUT of the wire (archived-free, no reopen)", () => {
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
    // Front-cluster h3 → [h3, h1, H2arch]; H2arch keeps its slot at the back and is
    // never in the wire, so it is provably untouched (not reopened).
    const pre = computeHeadingMovePre(fixture.db, proj, [h3], { position: "first" });
    expect(pre.wire).toEqual([h3]);
    expect(pre.reopened).toEqual([]);
  });

  it("#V11: an archived heading FORCED into the wire is disclosed as reopened", () => {
    const project = seedProject(fixture.db, { title: "P" });
    const h1 = seedHeading(fixture.db, { title: "H1", project, index: 1 });
    const h2 = seedHeading(fixture.db, {
      title: "H2arch",
      project,
      index: 2,
      status: "completed",
      stopDate: 1,
    });
    const h3 = seedHeading(fixture.db, { title: "H3", project, index: 3 });
    const proj = { resolved: { uuid: project, title: "P" }, matches: 1 };
    // Sending h1 to the end forces H2arch (and h3) above it into the wire — H2arch
    // must move, so it reopens, and that is disclosed (never silent, never guarded).
    const pre = computeHeadingMovePre(fixture.db, proj, [h1], { position: "last" });
    expect(pre.targetOrder).toEqual([h2, h3, h1]);
    expect(pre.wire).toEqual([h2, h3]);
    expect(pre.reopened).toEqual([h2]);
  });
});
