/**
 * The `loose` pseudo-area at the library layer: the reserved-word predicate,
 * the shadow lookup, the NULL-area composite `areaView`, the `projects --area
 * loose` filter, and `classifyShowTarget`.
 */
import { afterEach, describe, expect, it } from "vitest";

import { areaView } from "../../src/read/area-view.ts";
import { projectsView } from "../../src/read/views.ts";
import { classifyShowTarget } from "../../src/read/show-target.ts";
import { isLooseRef, LOOSE_REF, shadowingLooseArea } from "../../src/read/pseudo-area.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-31T12:00:00Z");

let fx: FixtureDb | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

describe("isLooseRef (reserved word, case-insensitive, trimmed)", () => {
  it("matches the reserved word in any case, rejects everything else", () => {
    for (const s of ["loose", "Loose", "LOOSE", " loose ", "LoOsE"])
      expect(isLooseRef(s)).toBe(true);
    for (const s of ["looser", "loos", "", "area", "loose-proj"]) expect(isLooseRef(s)).toBe(false);
  });
});

describe("shadowingLooseArea", () => {
  it("finds a real area named Loose (case-insensitive), else undefined", () => {
    fx = buildFixtureDb();
    expect(shadowingLooseArea(fx.db)).toBeUndefined();
    const uuid = seedArea(fx.db, "LOOSE", 0);
    expect(shadowingLooseArea(fx.db)).toBe(uuid);
  });
});

describe("areaView(loose) — the NULL-area composite", () => {
  it("returns area:null and buckets the area-less rows, excluding inbox and nested", () => {
    fx = buildFixtureDb();
    const work = seedArea(fx.db, "Work", 0);
    const pWork = seedProject(fx.db, { title: "work-proj", area: work });
    seedProject(fx.db, { title: "loose-proj", index: 2 });
    seedTodo(fx.db, { title: "loose-active", index: 1 });
    seedTodo(fx.db, { title: "loose-someday", start: "someday" });
    seedTodo(fx.db, { title: "loose-sched", start: "someday", startDate: "2099-01-01" });
    seedTodo(fx.db, { title: "inbox-capture", start: "inbox" });
    seedTodo(fx.db, { title: "work-loose", area: work });
    seedTodo(fx.db, { title: "work-child", project: pWork });

    const view = areaView(fx.db, "loose", NOW);
    expect(view.area).toBeNull();
    expect(view.projects.map((p) => p.title)).toEqual(["loose-proj"]);
    expect(view.active.map((t) => t.title)).toEqual(["loose-active"]);
    expect(view.someday.map((t) => t.title)).toEqual(["loose-someday"]);
    expect(view.scheduled.flatMap((g) => g.items.map((t) => t.title))).toEqual(["loose-sched"]);
    // Inbox capture, real-area rows, and project-nested rows never surface.
    const all = [
      ...view.active,
      ...view.someday,
      ...view.scheduled.flatMap((g) => g.items),
      ...view.projects,
    ].map((i) => i.title);
    expect(all).not.toContain("inbox-capture");
    expect(all).not.toContain("work-loose");
    expect(all).not.toContain("work-child");
  });
});

describe("projectsView --area loose", () => {
  it("lists only area-less projects", () => {
    fx = buildFixtureDb();
    const work = seedArea(fx.db, "Work", 0);
    seedProject(fx.db, { title: "work-proj", area: work });
    seedProject(fx.db, { title: "loose-proj" });
    const projects = projectsView(fx.db, { areaUuid: "loose", now: NOW });
    expect(projects.map((p) => p.title)).toEqual(["loose-proj"]);
  });
});

describe("classifyShowTarget(loose)", () => {
  it("resolves the reserved word to the area pseudo-target (no scope)", () => {
    fx = buildFixtureDb();
    expect(classifyShowTarget(fx.db, "Loose")).toEqual({ kind: "area", uuid: LOOSE_REF });
  });
});
