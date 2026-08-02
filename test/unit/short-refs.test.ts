/**
 * The short-ref (decorated-ref) convention (PR `mg/short-refs`): the shared
 * resolver core accepts a `Title [ref]` decorated ref as its LAST tier — the
 * bracketed segment resolves through the uuid/partial-uuid tier and the title
 * half is an ignored comment (a stale copy still resolves after a rename). Every
 * ref slot that flows through `resolveNamedRef` gains it (verified here on the
 * `--to-project`, `--area`-filter, and `--to-heading` cores). Plus the fused
 * render form `Title [8charPrefix]` (`fusedRef`) and the literal-title precedence.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fusedRef,
  resolveHeadingRef,
  resolveNamedRef,
  resolveProjectWriteTarget,
} from "../../src/read/queries.ts";
import { resolveAreaFilter } from "../../src/read/area-filter.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedHeading, seedProject } from "../fixtures/seed.ts";

let fx: FixtureDb;
beforeEach(() => (fx = buildFixtureDb()));
afterEach(() => fx?.close());

const AREA_UUID = "Zx9qWaBc2dEf4gHi6jKl8m"; // 22-char base62 (no dashes) so a prefix is base62
const resolveArea = (ref: string) => resolveNamedRef(fx.db, "TMArea", "1=1", [], ref);

describe("fusedRef — the render form", () => {
  it("renders `Title [8charPrefix]`; an empty title reads ` [prefix]`", () => {
    expect(fusedRef("Family", AREA_UUID)).toBe("Family [Zx9qWaBc]");
    expect(fusedRef("", AREA_UUID)).toBe(" [Zx9qWaBc]"); // titleless — round-trips as a decorated ref
  });
});

describe("decorated-ref input tier (shared resolver core)", () => {
  it("resolves `Title [prefix]` through the bracket; the title half is ignored", () => {
    seedArea(fx.db, "Finances", 0, AREA_UUID);
    // The title comment is deliberately WRONG (a stale copy after a rename).
    expect(resolveArea("Whatever Stale Name [Zx9qWaBc]").resolved?.uuid).toBe(AREA_UUID);
    // The bracket may also be the FULL uuid.
    expect(resolveArea(`Finances [${AREA_UUID}]`).resolved?.uuid).toBe(AREA_UUID);
  });

  it("the empty-title form ` [prefix]` is legal", () => {
    seedArea(fx.db, "Finances", 0, AREA_UUID);
    expect(resolveArea(" [Zx9qWaBc]").resolved?.uuid).toBe(AREA_UUID);
  });

  it("a literal title `Title [ref]` OUTRANKS the bracket parse (exact-title is an earlier tier)", () => {
    // An area LITERALLY titled "Family [Zx9qWaBc]" and a DIFFERENT area whose
    // uuid starts Zx9qWaBc — the literal exact-title match wins by construction.
    const literal = seedArea(fx.db, "Family [Zx9qWaBc]");
    seedArea(fx.db, "Other", 0, AREA_UUID);
    expect(resolveArea("Family [Zx9qWaBc]").resolved?.uuid).toBe(literal);
  });

  it("a too-short bracket (< 6 chars) parses the form but does not resolve", () => {
    seedArea(fx.db, "Finances", 0, AREA_UUID);
    // "Zx9q" is a valid decorated FORM (4-22) but below the partial-uuid floor.
    expect(resolveArea("Finances [Zx9q]").resolved).toBeNull();
    expect(resolveArea("Finances [Zx9q]").matches).toBe(0);
  });

  it("an ambiguous bracket prefix fails closed with candidates", () => {
    seedArea(fx.db, "A", 0, "PrfxCollide0000000001a");
    seedArea(fx.db, "B", 0, "PrfxCollide0000000002b");
    const r = resolveArea("anything [PrfxColl]");
    expect(r.resolved).toBeNull();
    expect(r.matches).toBe(2);
    expect(r.candidates).toHaveLength(2);
  });

  it("the trimmed titleless form (bare `[ref]`) resolves — the leading space is trimmed away", () => {
    // `fusedRef("", uuid)` renders " [prefix]"; stripThingsUri trims it to
    // "[prefix]", which must still resolve so the titleless fused form round-trips.
    seedArea(fx.db, "Finances", 0, AREA_UUID);
    expect(resolveArea("[Zx9qWaBc]").resolved?.uuid).toBe(AREA_UUID);
  });
});

describe("decorated ref flows through every shared-core slot", () => {
  it("--to-project (resolveProjectWriteTarget)", () => {
    const proj = seedProject(fx.db, { title: "Groceries", uuid: "Pr0jc7Ab2dEf4gHi6jKl8m" });
    // Even with a colliding same-title twin (name resolution would be ambiguous),
    // the decorated ref pins the exact project by its bracketed prefix.
    seedProject(fx.db, { title: "Groceries" });
    expect(resolveProjectWriteTarget(fx.db, "Groceries [Pr0jc7Ab]")).toBe(proj);
  });

  it("--area filter (resolveAreaFilter → resolveAreaUuid)", () => {
    seedArea(fx.db, "Health", 0, AREA_UUID);
    expect(resolveAreaFilter(fx.db, "stale [Zx9qWaBc]").uuid).toBe(AREA_UUID);
  });

  it("--to-heading (resolveHeadingRef, scoped to its project)", () => {
    const p1 = seedProject(fx.db, { title: "P1" });
    const p2 = seedProject(fx.db, { title: "P2" });
    const h1 = seedHeading(fx.db, {
      title: "Backlog",
      project: p1,
      uuid: "Head1Ab2dEf4gHi6jKl8mn",
    });
    // A same-titled heading in ANOTHER project — the bracket pins the exact one.
    seedHeading(fx.db, { title: "Backlog", project: p2 });
    expect(resolveHeadingRef(fx.db, p1, "Backlog [Head1Ab2]").resolved?.uuid).toBe(h1);
    // The heading tier is project-scoped: the same decorated ref against p2 (whose
    // heading uuid differs) does not resolve to h1.
    expect(resolveHeadingRef(fx.db, p2, "Backlog [Head1Ab2]").resolved).toBeNull();
  });
});
