/**
 * The JSON container-ref shape (PR `mg/json-ref-shape`): container refs flatten
 * to bare TITLE strings, and a flat `*Uuid` sibling rides alongside ONLY when the
 * round-trip law demands it — the bare title would not resolve back through its
 * OWN resolver, in its OWN scope, to this exact entity. The promotion predicate
 * is the resolver's own judgment (`makeRefPromoter`/`titleRoundTrips`,
 * src/read/queries.ts), exercised here against a real synthetic fixture DB so the
 * resolver quirks (the uuid-prefix-first tier of the project write-target
 * resolver, the live+open name pool, per-project heading scope) are the truth.
 * Also pins the `type` omission (absent `type` = to-do).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeRefPromoter } from "../../src/read/queries.ts";
import { shapeReadPayload, type RefPromoter } from "../../src/read/shape.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

type Obj = Record<string, unknown>;
const first = (out: unknown): Obj => (out as Obj[])[0]!;

/** A minimal shaped-item payload — enough for the stage/when derivation + refs. */
function todo(over: Obj = {}): Obj {
  return {
    uuid: "todo-x",
    type: "to-do",
    title: "a task",
    notes: "",
    status: "open",
    logged: false,
    trashed: false,
    start: "active",
    startDate: null,
    todaySection: null,
    deadline: null,
    reminder: null,
    area: null,
    project: null,
    heading: null,
    tags: [],
    repeating: { isTemplate: false, isInstance: false, templateUuid: null },
    checklistItemsCount: 0,
    openChecklistItemsCount: 0,
    created: new Date("2026-07-01T00:00:00.000Z"),
    modified: new Date("2026-07-01T00:00:00.000Z"),
    stopped: null,
    ...over,
  };
}

let fx: FixtureDb;
let promoter: RefPromoter;
beforeEach(() => {
  fx = buildFixtureDb();
  promoter = makeRefPromoter(fx.db);
});
afterEach(() => fx?.close());

describe("container-ref flattening — the round-trip promotion law (projects)", () => {
  it("a colliding LIVE pair promotes: the bare title is ambiguous → emit projectUuid", () => {
    const grocA = seedProject(fx.db, { title: "Groceries" });
    seedProject(fx.db, { title: "Groceries" }); // the colliding twin
    const row = first(
      shapeReadPayload(
        "search",
        [todo({ project: { uuid: grocA, title: "Groceries" } })],
        false,
        promoter,
      ),
    );
    expect(row["project"]).toBe("Groceries"); // bare title
    expect(row["projectUuid"]).toBe(grocA); // promoted — the title does not round-trip
  });

  it("a live project with LOGGED/completed same-titled twins does NOT promote (they never resolve by name)", () => {
    const live = seedProject(fx.db, { title: "Roadmap", status: "open" });
    seedProject(fx.db, { title: "Roadmap", status: "completed" }); // logged/completed twin
    seedProject(fx.db, { title: "Roadmap", trashed: true }); // trashed twin
    const row = first(
      shapeReadPayload(
        "search",
        [todo({ project: { uuid: live, title: "Roadmap" } })],
        false,
        promoter,
      ),
    );
    expect(row["project"]).toBe("Roadmap");
    // The sole LIVE+OPEN twin round-trips — the dead twins are invisible to the
    // write-target name pool, so no promotion.
    expect(row).not.toHaveProperty("projectUuid");
  });

  it("a uuid-lookalike title (a valid unique uuid-PREFIX of another task) promotes", () => {
    // The project write-target resolver runs the uuid-prefix tier FIRST, so a
    // bare title that is a valid unique prefix of ANOTHER task's uuid resolves to
    // THAT task, not this project — it must promote.
    seedTodo(fx.db, { uuid: "Ab3x9KmNpQrStUvWxYz012" }); // the task the title prefixes
    const look = seedProject(fx.db, { uuid: "zzLookalikeProj00001", title: "Ab3x9K" });
    const row = first(
      shapeReadPayload(
        "search",
        [todo({ project: { uuid: look, title: "Ab3x9K" } })],
        false,
        promoter,
      ),
    );
    expect(row["project"]).toBe("Ab3x9K");
    expect(row["projectUuid"]).toBe(look); // the prefix tier hijacks the title → promote
  });
});

describe("container-ref flattening — areas", () => {
  it("colliding live areas promote; a unique area round-trips (no areaUuid)", () => {
    const finA = seedArea(fx.db, "Finances");
    seedArea(fx.db, "Finances"); // twin
    const health = seedArea(fx.db, "Health");
    const collide = first(
      shapeReadPayload(
        "search",
        [todo({ area: { uuid: finA, title: "Finances" } })],
        false,
        promoter,
      ),
    );
    expect(collide["area"]).toBe("Finances");
    expect(collide["areaUuid"]).toBe(finA);
    const unique = first(
      shapeReadPayload(
        "search",
        [todo({ area: { uuid: health, title: "Health" } })],
        false,
        promoter,
      ),
    );
    expect(unique["area"]).toBe("Health");
    expect(unique).not.toHaveProperty("areaUuid");
  });
});

describe("heading round-trip — per-project scope (the shared predicate)", () => {
  it("a heading dup within one project does NOT round-trip; an identically-titled heading in another project does", () => {
    const p1 = seedProject(fx.db, { title: "Alpha" });
    const p2 = seedProject(fx.db, { title: "Beta" });
    const backA = seedHeading(fx.db, { title: "Backlog", project: p1 });
    seedHeading(fx.db, { title: "Backlog", project: p1 }); // dup within p1
    const backC = seedHeading(fx.db, { title: "Backlog", project: p2 }); // sole in p2
    // Dup within p1 → ambiguous within its project scope → promote.
    expect(promoter.roundTrips("heading", "Backlog", backA, p1)).toBe(false);
    // Unique within p2 → resolves back → no promotion. Same title, different scope.
    expect(promoter.roundTrips("heading", "Backlog", backC, p2)).toBe(true);
  });

  it("the FULL tier emits the headingUuid sibling unconditionally (even when it round-trips)", () => {
    const p2 = seedProject(fx.db, { title: "Beta" });
    const backC = seedHeading(fx.db, { title: "Backlog", project: p2 });
    const full = first(
      shapeReadPayload(
        "search",
        [
          todo({
            project: { uuid: p2, title: "Beta" },
            heading: { uuid: backC, title: "Backlog" },
          }),
        ],
        true,
        promoter,
      ),
    );
    expect(full["heading"]).toBe("Backlog");
    expect(full["headingUuid"]).toBe(backC); // FULL forces it
    expect(full["project"]).toBe("Beta");
    expect(full["projectUuid"]).toBe(p2); // FULL forces the project sibling too
  });
});

describe("`type` omission — absent type = to-do", () => {
  it("a to-do row omits `type`; a project row keeps it", () => {
    const todoRow = first(shapeReadPayload("search", [todo()], false, promoter));
    expect(todoRow).not.toHaveProperty("type");
    const projRow = first(
      shapeReadPayload(
        "projects",
        [
          {
            uuid: "p-1",
            type: "project",
            title: "Q3",
            notes: "",
            status: "open",
            logged: false,
            trashed: false,
            start: "active",
            startDate: null,
            todaySection: null,
            deadline: null,
            reminder: null,
            area: null,
            tags: [],
            repeating: { isTemplate: false, isInstance: false, templateUuid: null },
            untrashedLeafActionsCount: 0,
            openUntrashedLeafActionsCount: 0,
            created: new Date(),
            modified: new Date(),
            stopped: null,
          },
        ],
        false,
        promoter,
      ),
    );
    expect(projRow["type"]).toBe("project");
  });
});

describe("the DB-less default (no promoter) — assume round-trips", () => {
  it("flattens to bare titles with NO uuid siblings on the compact tier", () => {
    const row = first(
      shapeReadPayload(
        "search",
        [todo({ area: { uuid: "a", title: "Work" }, project: { uuid: "p", title: "Q3" } })],
        false,
      ),
    );
    expect(row["area"]).toBe("Work");
    expect(row["project"]).toBe("Q3");
    expect(row).not.toHaveProperty("areaUuid");
    expect(row).not.toHaveProperty("projectUuid");
  });
});
