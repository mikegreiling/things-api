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

  /**
   * CHORD2 cell 7a′ / CHORDMH2: an archived heading is invisible to the whole
   * vector — it renders no content row, takes no ordinal in the positional
   * `select-heading-row` walk, and a live heading's ±1 chord skips its slot.
   * A project holding one is therefore ORDINARY; the plan simply counts the live
   * headings, which is exactly what the walk it drives will count.
   */
  function seedWithArchived() {
    const project = seedProject(fixture.db, { title: "P" });
    const h1 = seedHeading(fixture.db, { title: "H1", project, index: 1 });
    const arch = seedHeading(fixture.db, {
      title: "H2arch",
      project,
      index: 2,
      status: "completed",
      stopDate: 1,
    });
    const h3 = seedHeading(fixture.db, { title: "H3", project, index: 3 });
    const h4 = seedHeading(fixture.db, { title: "H4", project, index: 4 });
    const proj = { resolved: { uuid: project, title: "P" }, matches: 1 };
    return { project, proj, h1, arch, h3, h4 };
  }

  it("CHORDMH2: an ARCHIVED heading takes NO ordinal — the plan counts the live rows only", () => {
    const { proj, h1, arch, h3, h4 } = seedWithArchived();
    const pre = computeHeadingMovePre(fixture.db, proj, [h4], { position: "first" });
    expect(pre.problems).toEqual([]);
    // `current` is the RENDERED order: the index order filtered to status = 0.
    expect(pre.current).toEqual([h1, h3, h4]);
    expect(pre.targetOrder).toEqual([h4, h1, h3]);
    // The archived row appears in NO set the op reasons about — not the walk, not
    // the movees, not the untouched-siblings assertion (its rank drifts among the
    // live rows over time and nothing renders it, so nothing may assert on it).
    expect(pre.current).not.toContain(arch);
    expect(pre.targetOrder).not.toContain(arch);
    expect(pre.untouched).not.toContain(arch);
  });

  it("CHORDMH2: the ±1 that SKIPS the archived slot leaves the rows above it untouched", () => {
    const { proj, h1, arch, h3, h4 } = seedWithArchived();
    // Live order H1 < H3 < H4 with the archived row sitting between H1 and H3.
    // Moving H4 up one lands it between H1 and H3 — one chord, and H1 (which the
    // move never passes over) is provably byte-identical.
    const pre = computeHeadingMovePre(fixture.db, proj, [h4], { before: h3 });
    expect(pre.problems).toEqual([]);
    expect(pre.targetOrder).toEqual([h1, h4, h3]);
    expect(pre.untouched).toEqual([h1]);
    expect(pre.untouched).not.toContain(arch);
  });

  it("CHORDMH2: an ARCHIVED heading is still refused as a MOVEE and as an ANCHOR", () => {
    const { proj, arch, h4 } = seedWithArchived();
    // It renders no row, so there is no ordinal to select it by…
    expect(
      computeHeadingMovePre(fixture.db, proj, [arch], { position: "first" }).problems.join(" "),
    ).toContain("completed/canceled heading");
    // …and no slot to place another heading against.
    const anchored = computeHeadingMovePre(fixture.db, proj, [h4], { before: arch });
    expect(anchored.problems.join(" ")).toContain("completed/canceled");
    expect(anchored.targetOrder).toEqual(anchored.current);
    expect(anchored.untouched).toEqual([]);
  });
});
