/**
 * The `--area` view filter (src/read/area-filter.ts): a pure POST-FILTER on a
 * shaped view, restricting it to one area by the transitive effective-area
 * keep-rule. Exercised through the client read methods (where the filter is
 * applied, before bounding) for `anytime` (grouped) and `today` (the split).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openThings, ReferenceResolutionError, type ThingsClient } from "../../src/index.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date(2026, 6, 2, 12, 0); // local 2026-07-02

let fx: FixtureDb;
let stateDir: string;

function client(): ThingsClient {
  return openThings({
    dbPath: fx.path,
    now: () => NOW,
    env: {
      ...process.env,
      THINGS_DB: fx.path,
      THINGS_API_STATE_DIR: stateDir,
      THINGS_API_CONFIG_DIR: join(stateDir, "config"),
    },
  });
}

/**
 * A shared world: two areas, a project + heading in Alpha with children, a
 * loose Alpha to-do, plus everything the filter must DROP (a Beta to-do, an
 * area-less loose to-do, and an area-less project with a child).
 */
function seedWorld(): { alpha: string; beta: string } {
  const alpha = seedArea(fx.db, "Alpha", 0);
  const beta = seedArea(fx.db, "Beta", 1);
  const pAlpha = seedProject(fx.db, { title: "p-alpha", area: alpha });
  const headAlpha = seedHeading(fx.db, { title: "h-alpha", project: pAlpha });
  // Alpha rows (all KEPT): loose to-do, the project row, a direct child, a
  // heading-nested child.
  seedTodo(fx.db, { title: "a-loose", area: alpha });
  seedTodo(fx.db, { title: "p-alpha-child", project: pAlpha });
  seedTodo(fx.db, { title: "p-alpha-headed", project: pAlpha, heading: headAlpha });
  // Rows that must DROP: another area, area-less loose, area-less project + child.
  seedTodo(fx.db, { title: "b-loose", area: beta });
  seedTodo(fx.db, { title: "orphan-loose" });
  const pOrphan = seedProject(fx.db, { title: "p-orphan" });
  seedTodo(fx.db, { title: "p-orphan-child", project: pOrphan });
  return { alpha, beta };
}

beforeEach(() => {
  fx = buildFixtureDb();
  stateDir = mkdtempSync(join(tmpdir(), "things-api-area-filter-"));
});
afterEach(() => fx?.close());

describe("anytime --area", () => {
  it("keeps only rows whose effective area is the target; drops the rest", () => {
    seedWorld();
    const { view, filter } = client().read.anytime({ area: "Alpha" });
    const titles = view.flatMap((s) => s.items.map((i) => i.title)).toSorted();
    expect(titles).toEqual(["a-loose", "p-alpha", "p-alpha-child", "p-alpha-headed"]);
    // Every surviving section is the target area — the loose/other-area blocks drop.
    expect(view.every((s) => s.area?.title === "Alpha")).toBe(true);
    // The additive meta.filter names the resolved area.
    expect(filter?.area.title).toBe("Alpha");
    expect(filter?.area.uuid).toBeTypeOf("string");
  });

  it("resolves the area by uuid too", () => {
    const { alpha } = seedWorld();
    const { view, filter } = client().read.anytime({ area: alpha });
    expect(view.flatMap((s) => s.items.map((i) => i.title)).toSorted()).toEqual([
      "a-loose",
      "p-alpha",
      "p-alpha-child",
      "p-alpha-headed",
    ]);
    expect(filter?.area.uuid).toBe(alpha);
  });

  it("emits no filter annotation when unscoped", () => {
    seedWorld();
    const { filter } = client().read.anytime();
    expect(filter).toBeUndefined();
  });

  it("fails closed on an unresolvable area ref", () => {
    seedWorld();
    expect(() => client().read.anytime({ area: "Nonexistent" })).toThrow(ReferenceResolutionError);
  });

  it("fails closed on an ambiguous area name", () => {
    seedArea(fx.db, "Dup", 0);
    seedArea(fx.db, "Dup", 1);
    seedTodo(fx.db, { title: "x" });
    let err: unknown;
    try {
      client().read.anytime({ area: "Dup" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReferenceResolutionError);
    expect((err as ReferenceResolutionError).code).toBe("ambiguous");
  });
});

describe("today --area", () => {
  it("keeps Today members in the target area (incl. project children); drops others", () => {
    const alpha = seedArea(fx.db, "Alpha", 0);
    const beta = seedArea(fx.db, "Beta", 1);
    const pAlpha = seedProject(fx.db, { title: "tp-alpha", area: alpha, startDate: "2026-07-02" });
    seedTodo(fx.db, { title: "t-alpha", area: alpha, startDate: "2026-07-02" });
    seedTodo(fx.db, { title: "tp-child", project: pAlpha, startDate: "2026-07-02" });
    seedTodo(fx.db, { title: "t-beta", area: beta, startDate: "2026-07-02" });
    seedTodo(fx.db, { title: "t-orphan", startDate: "2026-07-02" });

    const { view, filter } = client().read.today({ area: "Alpha" });
    const titles = [...view.today, ...view.evening].map((i) => i.title).toSorted();
    expect(titles).toEqual(["t-alpha", "tp-alpha", "tp-child"]);
    expect(filter?.area.title).toBe("Alpha");
  });

  it("recomputes the counts over the surviving members", () => {
    const alpha = seedArea(fx.db, "Alpha", 0);
    const beta = seedArea(fx.db, "Beta", 1);
    // One overdue-deadline Alpha member (counts: dueOrOverdue), one plain Alpha
    // member, and a Beta overdue member that must NOT move the filtered counts.
    seedTodo(fx.db, {
      title: "a-due",
      area: alpha,
      startDate: "2026-07-02",
      deadline: "2026-07-01",
    });
    seedTodo(fx.db, { title: "a-plain", area: alpha, startDate: "2026-07-02" });
    seedTodo(fx.db, {
      title: "b-due",
      area: beta,
      startDate: "2026-07-02",
      deadline: "2026-07-01",
    });

    const { view } = client().read.today({ area: "Alpha" });
    expect(view.counts).toEqual({ dueOrOverdue: 1, other: 1 });
  });

  it("emits no filter annotation when unscoped", () => {
    seedArea(fx.db, "Alpha", 0);
    seedTodo(fx.db, { title: "t", startDate: "2026-07-02" });
    expect(client().read.today().filter).toBeUndefined();
  });

  it("fails closed on an unresolvable area ref", () => {
    seedArea(fx.db, "Alpha", 0);
    expect(() => client().read.today({ area: "Nope" })).toThrow(ReferenceResolutionError);
  });
});
