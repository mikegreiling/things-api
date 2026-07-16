/**
 * Isolated unit suite for the write-verification core: evaluateDelta and
 * createDbReader (src/write/verify/delta.ts). This module is the literal
 * implementation of the package's "verified writes" claim, so every DeltaSpec
 * discriminant, every reader method, and every getField computed path is
 * exercised DIRECTLY against fixture DBs here — a regression in any single mode
 * fails a named test rather than relying on an engine round-trip to cross it.
 */
import { describe, expect, it } from "vitest";

import {
  createDbReader,
  evaluateDelta,
  getField,
  type DeltaSpec,
  type PreModDates,
} from "../../src/write/verify/delta.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import {
  seedArea,
  seedChecklistItem,
  seedProject,
  seedTag,
  seedTodo,
  tagArea,
  tagTask,
} from "../fixtures/seed.ts";

type Db = FixtureDb["db"];

function withDb<T>(fn: (db: Db) => T): T {
  const fx = buildFixtureDb();
  try {
    return fn(fx.db);
  } finally {
    fx.close();
  }
}

/** The pre-read bundle evaluateDelta consumes; overridable per test. */
function pre(opts: {
  modDates?: PreModDates;
  fields?: Record<string, Record<string, unknown>>;
  trashedCount?: number;
}) {
  return {
    modDates: opts.modDates ?? {},
    fields: opts.fields ?? {},
    ...(opts.trashedCount !== undefined && { trashedCount: opts.trashedCount }),
  };
}

const EMPTY_PRE = pre({});

// ---------------------------------------------------------------- createDbReader

describe("createDbReader", () => {
  it("taskByUuid decodes a row and returns null for a missing uuid", () => {
    withDb((db) => {
      const uuid = seedTodo(db, { title: "Read me" });
      const reader = createDbReader(db);
      expect(reader.taskByUuid(uuid)?.title).toBe("Read me");
      expect(reader.taskByUuid("nope")).toBeNull();
    });
  });

  it("areaExists / tagExists reflect row presence", () => {
    withDb((db) => {
      const area = seedArea(db, "Home");
      const tag = seedTag(db, "urgent");
      const reader = createDbReader(db);
      expect(reader.areaExists(area)).toBe(true);
      expect(reader.areaExists("ghost")).toBe(false);
      expect(reader.tagExists(tag)).toBe(true);
      expect(reader.tagExists("ghost")).toBe(false);
    });
  });

  it("areasByTitle / tagsByTitle match case-insensitively and expose the parent", () => {
    withDb((db) => {
      const area = seedArea(db, "Home");
      const parent = seedTag(db, "work");
      const child = seedTag(db, "deep", parent);
      const reader = createDbReader(db);
      expect(reader.areasByTitle("home")).toEqual([{ uuid: area }]);
      expect(reader.tagsByTitle("DEEP")).toEqual([{ uuid: child, parent }]);
      expect(reader.tagsByTitle("work")).toEqual([{ uuid: parent, parent: null }]);
    });
  });

  it("rankOf reads index, todayIndex, and area-index; null when the row is absent", () => {
    withDb((db) => {
      const todo = seedTodo(db, { index: 5, todayIndex: 3 });
      const area = seedArea(db, "A", 2);
      const reader = createDbReader(db);
      expect(reader.rankOf(todo, "index")).toBe(5);
      expect(reader.rankOf(todo, "todayIndex")).toBe(3);
      expect(reader.rankOf(area, "area-index")).toBe(2);
      expect(reader.rankOf("ghost", "index")).toBeNull();
    });
  });

  it("trashedCount counts only trashed rows", () => {
    withDb((db) => {
      seedTodo(db, { trashed: true });
      seedTodo(db, { trashed: true });
      seedTodo(db, { trashed: false });
      expect(createDbReader(db).trashedCount()).toBe(2);
    });
  });

  it("modDateOf returns userModificationDate; null for a missing row", () => {
    withDb((db) => {
      const uuid = seedTodo(db, { modificationDate: 1_784_000_123 });
      const reader = createDbReader(db);
      expect(reader.modDateOf(uuid)).toBe(1_784_000_123);
      expect(reader.modDateOf("ghost")).toBeNull();
    });
  });

  it("findCreated honors the sinceEpoch window when no excludeUuids are given", () => {
    withDb((db) => {
      seedTodo(db, { title: "Dup", creationDate: 1000 });
      const fresh = seedTodo(db, { title: "Dup", creationDate: 5000 });
      const found = createDbReader(db).findCreated({
        title: "Dup",
        type: "to-do",
        sinceEpoch: 4000,
      });
      expect(found.map((t) => t.uuid)).toEqual([fresh]);
    });
  });

  it("findCreated ignores sinceEpoch but honors excludeUuids when they are present", () => {
    withDb((db) => {
      const old = seedTodo(db, { title: "Dup", creationDate: 1000 });
      const fresh = seedTodo(db, { title: "Dup", creationDate: 5000 });
      const found = createDbReader(db).findCreated({
        title: "Dup",
        type: "to-do",
        sinceEpoch: 9999, // would exclude BOTH on time — proves it is ignored here
        excludeUuids: [old],
      });
      expect(found.map((t) => t.uuid)).toEqual([fresh]);
    });
  });

  it("findCreated maps probe.type to the right TMTask type int", () => {
    withDb((db) => {
      seedTodo(db, { title: "Same", creationDate: 5000 });
      const proj = seedProject(db, { title: "Same", creationDate: 5000 });
      const found = createDbReader(db).findCreated({
        title: "Same",
        type: "project",
        sinceEpoch: 0,
      });
      expect(found.map((t) => t.uuid)).toEqual([proj]);
    });
  });

  it("entityFields returns area title + sorted tags, tag parent/shortcut, or null", () => {
    withDb((db) => {
      const area = seedArea(db, "Home");
      const tZeta = seedTag(db, "zeta");
      const tAlpha = seedTag(db, "alpha");
      tagArea(db, area, tZeta);
      tagArea(db, area, tAlpha);
      const parent = seedTag(db, "parent");
      const tag = seedTag(db, "leaf", parent);
      db.prepare("UPDATE TMTag SET shortcut = 'ctrl-l' WHERE uuid = ?").run(tag);
      const reader = createDbReader(db);
      expect(reader.entityFields("area", area)).toEqual({
        title: "Home",
        tags: ["alpha", "zeta"],
      });
      expect(reader.entityFields("tag", tag)).toEqual({
        title: "leaf",
        parent,
        shortcut: "ctrl-l",
      });
      expect(reader.entityFields("area", "ghost")).toBeNull();
      expect(reader.entityFields("tag", "ghost")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------- getField

describe("getField computed paths", () => {
  it("resolves `tags` to sorted direct-tag titles", () => {
    withDb((db) => {
      const todo = seedTodo(db);
      tagTask(db, todo, seedTag(db, "zeta"));
      tagTask(db, todo, seedTag(db, "alpha"));
      const entity = createDbReader(db).taskByUuid(todo);
      expect(entity && getField(entity, "tags")).toEqual(["alpha", "zeta"]);
    });
  });

  it("resolves `checklistTitles` and `checklistStates` in order", () => {
    withDb((db) => {
      const todo = seedTodo(db);
      seedChecklistItem(db, todo, "first", { index: 0 });
      seedChecklistItem(db, todo, "second", { index: 1, status: "completed" });
      const entity = createDbReader(db).taskByUuid(todo);
      expect(entity && getField(entity, "checklistTitles")).toEqual(["first", "second"]);
      expect(entity && getField(entity, "checklistStates")).toEqual(["open", "completed"]);
    });
  });

  it("resolves `stoppedDate` / `createdDate` to a local YYYY-MM-DD string", () => {
    withDb((db) => {
      const createdEpoch = 1_780_000_000;
      const stoppedEpoch = 1_781_500_000;
      const todo = seedTodo(db, {
        status: "completed",
        creationDate: createdEpoch,
        stopDate: stoppedEpoch,
      });
      const entity = createDbReader(db).taskByUuid(todo);
      expect(entity && getField(entity, "createdDate")).toBe(localIso(createdEpoch));
      expect(entity && getField(entity, "stoppedDate")).toBe(localIso(stoppedEpoch));
    });
  });

  it("`stoppedDate` is null when the row was never stopped", () => {
    withDb((db) => {
      const todo = seedTodo(db);
      const entity = createDbReader(db).taskByUuid(todo);
      expect(entity && getField(entity, "stoppedDate")).toBeNull();
    });
  });

  it("walks a dotted path (`area.uuid`) and returns undefined off the end", () => {
    withDb((db) => {
      const area = seedArea(db, "Home");
      const todo = seedTodo(db, { area });
      const entity = createDbReader(db).taskByUuid(todo);
      expect(entity && getField(entity, "area.uuid")).toBe(area);
      expect(entity && getField(entity, "area.nope")).toBeUndefined();
      expect(entity && getField(entity, "does.not.exist")).toBeUndefined();
    });
  });

  it("`checklistTitles` on a non-to-do falls through to undefined", () => {
    withDb((db) => {
      const proj = seedProject(db);
      const entity = createDbReader(db).taskByUuid(proj);
      expect(entity && getField(entity, "checklistTitles")).toBeUndefined();
    });
  });
});

// ------------------------------------------------------------------- update mode

describe("evaluateDelta — update", () => {
  it("satisfied when the asserted field reads back the target value", () => {
    withDb((db) => {
      const uuid = seedTodo(db, { title: "B", modificationDate: 200 });
      const spec: DeltaSpec = { mode: "update", uuid, assert: [{ field: "title", equals: "B" }] };
      const result = evaluateDelta(
        spec,
        createDbReader(db),
        pre({ modDates: { [uuid]: 100 }, fields: { [uuid]: { title: "A" } } }),
      );
      expect(result.satisfied).toBe(true);
      expect(result.movement).toBe(true);
      expect(result.assertedMovement).toBe(true);
      expect(result.observed).toEqual({ title: "B" });
    });
  });

  it("mismatch: an asserted field MOVED but not to the target value", () => {
    withDb((db) => {
      const uuid = seedTodo(db, { title: "C", modificationDate: 200 });
      const spec: DeltaSpec = { mode: "update", uuid, assert: [{ field: "title", equals: "B" }] };
      const result = evaluateDelta(
        spec,
        createDbReader(db),
        pre({ modDates: { [uuid]: 100 }, fields: { [uuid]: { title: "A" } } }),
      );
      expect(result.satisfied).toBe(false);
      expect(result.movement).toBe(true);
      expect(result.assertedMovement).toBe(true); // distinguishes a contrary write
    });
  });

  it("silent no-op: nothing moved, so assertedMovement stays false", () => {
    withDb((db) => {
      const uuid = seedTodo(db, { title: "A", modificationDate: 100 });
      const spec: DeltaSpec = { mode: "update", uuid, assert: [{ field: "title", equals: "B" }] };
      const result = evaluateDelta(
        spec,
        createDbReader(db),
        pre({ modDates: { [uuid]: 100 }, fields: { [uuid]: { title: "A" } } }),
      );
      expect(result.satisfied).toBe(false);
      expect(result.movement).toBe(false);
      expect(result.assertedMovement).toBe(false); // the open exit-0 trap
    });
  });

  it("unsatisfied when the target row does not exist", () => {
    withDb((db) => {
      const spec: DeltaSpec = {
        mode: "update",
        uuid: "ghost",
        assert: [{ field: "title", equals: "B" }],
      };
      const result = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(result.satisfied).toBe(false);
    });
  });
});

// ------------------------------------------------------------------- create mode

describe("evaluateDelta — create", () => {
  it("discovers the fresh row inside the sinceEpoch window", () => {
    withDb((db) => {
      seedTodo(db, { title: "Task", creationDate: 1000 });
      const fresh = seedTodo(db, { title: "Task", creationDate: 5000 });
      const spec: DeltaSpec = {
        mode: "create",
        probe: { title: "Task", type: "to-do", sinceEpoch: 4000 },
        assert: [],
      };
      const result = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(result.satisfied).toBe(true);
      expect(result.discoveredUuid).toBe(fresh);
    });
  });

  it("skips excludeUuids (commit 1) and binds to the genuinely new row", () => {
    withDb((db) => {
      const preExisting = seedTodo(db, { title: "Task", creationDate: 5000 });
      const fresh = seedTodo(db, { title: "Task", creationDate: 5000 });
      const spec: DeltaSpec = {
        mode: "create",
        probe: { title: "Task", type: "to-do", sinceEpoch: 4000, excludeUuids: [preExisting] },
        assert: [],
      };
      const result = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(result.satisfied).toBe(true);
      expect(result.discoveredUuid).toBe(fresh);
      expect(result.discoveredUuid).not.toBe(preExisting);
    });
  });

  it("reports failure (no discovery) when only an excluded row matches", () => {
    withDb((db) => {
      const preExisting = seedTodo(db, { title: "Task", creationDate: 5000 });
      const spec: DeltaSpec = {
        mode: "create",
        probe: { title: "Task", type: "to-do", sinceEpoch: 4000, excludeUuids: [preExisting] },
        assert: [],
      };
      const result = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(result.satisfied).toBe(false);
      expect(result.movement).toBe(false);
      expect(result.discoveredUuid).toBeUndefined();
    });
  });

  it("not-found: no candidate at all", () => {
    withDb((db) => {
      const spec: DeltaSpec = {
        mode: "create",
        probe: { title: "Nope", type: "to-do", sinceEpoch: 0 },
        assert: [],
      };
      const result = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(result.satisfied).toBe(false);
      expect(result.movement).toBe(false);
      expect(result.observed).toBeNull();
    });
  });

  it("candidate present but assertion fails: movement true, satisfied false", () => {
    withDb((db) => {
      seedTodo(db, { title: "Task", notes: "actual", creationDate: 5000 });
      const spec: DeltaSpec = {
        mode: "create",
        probe: { title: "Task", type: "to-do", sinceEpoch: 4000 },
        assert: [{ field: "notes", equals: "expected" }],
      };
      const result = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(result.satisfied).toBe(false);
      expect(result.movement).toBe(true);
      expect(result.discoveredUuid).toBeUndefined();
      expect(result.observed).toEqual({ notes: "actual" });
    });
  });
});

// -------------------------------------------------------------- state (+ cascade)

describe("evaluateDelta — state", () => {
  it("satisfied when the row and every cascade child hold their asserted status", () => {
    withDb((db) => {
      const project = seedProject(db, { status: "completed" });
      const child = seedTodo(db, { status: "completed", project });
      const spec: DeltaSpec = {
        mode: "state",
        uuid: project,
        assert: [{ field: "status", equals: "completed" }],
        cascade: [{ uuid: child, assert: [{ field: "status", equals: "completed" }] }],
      };
      const result = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(result.satisfied).toBe(true);
      expect(result.observed).toMatchObject({ status: "completed" });
      expect(result.observed?.[`${child}.status`]).toBe("completed");
    });
  });

  it("unsatisfied when a cascade child is in the wrong status", () => {
    withDb((db) => {
      const project = seedProject(db, { status: "completed" });
      const child = seedTodo(db, { status: "open", project });
      const spec: DeltaSpec = {
        mode: "state",
        uuid: project,
        assert: [{ field: "status", equals: "completed" }],
        cascade: [{ uuid: child, assert: [{ field: "status", equals: "completed" }] }],
      };
      expect(evaluateDelta(spec, createDbReader(db), EMPTY_PRE).satisfied).toBe(false);
    });
  });

  it("unsatisfied when a cascade child row is missing", () => {
    withDb((db) => {
      const project = seedProject(db, { status: "completed" });
      const spec: DeltaSpec = {
        mode: "state",
        uuid: project,
        assert: [{ field: "status", equals: "completed" }],
        cascade: [{ uuid: "ghost", assert: [{ field: "status", equals: "completed" }] }],
      };
      expect(evaluateDelta(spec, createDbReader(db), EMPTY_PRE).satisfied).toBe(false);
    });
  });
});

// --------------------------------------------------------------------- gone mode

describe("evaluateDelta — gone", () => {
  it("area: satisfied only once the row is absent", () => {
    withDb((db) => {
      const area = seedArea(db, "Doomed");
      const present: DeltaSpec = { mode: "gone", entity: "area", uuid: area };
      expect(evaluateDelta(present, createDbReader(db), EMPTY_PRE).satisfied).toBe(false);
      const absent: DeltaSpec = { mode: "gone", entity: "area", uuid: "ghost" };
      const result = evaluateDelta(absent, createDbReader(db), EMPTY_PRE);
      expect(result.satisfied).toBe(true);
      expect(result.observed).toEqual({ exists: false });
    });
  });

  it("tag: satisfied only once the row is absent", () => {
    withDb((db) => {
      const tag = seedTag(db, "doomed");
      const present: DeltaSpec = { mode: "gone", entity: "tag", uuid: tag };
      expect(evaluateDelta(present, createDbReader(db), EMPTY_PRE).satisfied).toBe(false);
      const absent: DeltaSpec = { mode: "gone", entity: "tag", uuid: "ghost" };
      expect(evaluateDelta(absent, createDbReader(db), EMPTY_PRE).satisfied).toBe(true);
    });
  });
});

// ----------------------------------------------------------- entity-created mode

describe("evaluateDelta — entity-created", () => {
  it("area: discovers a fresh same-title row and matches its tag set", () => {
    withDb((db) => {
      const existing = seedArea(db, "Work");
      const created = seedArea(db, "Work");
      tagArea(db, created, seedTag(db, "focus"));
      const spec: DeltaSpec = {
        mode: "entity-created",
        entity: "area",
        title: "Work",
        excludeUuids: [existing],
        assertTags: ["focus"],
      };
      const result = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(result.satisfied).toBe(true);
      expect(result.discoveredUuid).toBe(created);
    });
  });

  it("area: fresh row whose tag set differs is not a match", () => {
    withDb((db) => {
      const existing = seedArea(db, "Work");
      seedArea(db, "Work"); // created but tagless
      const spec: DeltaSpec = {
        mode: "entity-created",
        entity: "area",
        title: "Work",
        excludeUuids: [existing],
        assertTags: ["focus"],
      };
      expect(evaluateDelta(spec, createDbReader(db), EMPTY_PRE).satisfied).toBe(false);
    });
  });

  it("tag: matches only the fresh row under the expected parent", () => {
    withDb((db) => {
      const parent = seedTag(db, "area51");
      const existing = seedTag(db, "urgent");
      const created = seedTag(db, "urgent", parent);
      const spec: DeltaSpec = {
        mode: "entity-created",
        entity: "tag",
        title: "urgent",
        excludeUuids: [existing],
        parentUuid: parent,
      };
      const result = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(result.satisfied).toBe(true);
      expect(result.discoveredUuid).toBe(created);
    });
  });

  it("tag: wrong parent is not a match", () => {
    withDb((db) => {
      const existing = seedTag(db, "urgent");
      seedTag(db, "urgent"); // created at root, not under the expected parent
      const spec: DeltaSpec = {
        mode: "entity-created",
        entity: "tag",
        title: "urgent",
        excludeUuids: [existing],
        parentUuid: "some-parent",
      };
      expect(evaluateDelta(spec, createDbReader(db), EMPTY_PRE).satisfied).toBe(false);
    });
  });

  it("unsatisfied when only excluded rows carry the title", () => {
    withDb((db) => {
      const existing = seedArea(db, "Work");
      const spec: DeltaSpec = {
        mode: "entity-created",
        entity: "area",
        title: "Work",
        excludeUuids: [existing],
      };
      const result = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(result.satisfied).toBe(false);
      expect(result.movement).toBe(false);
    });
  });
});

// ----------------------------------------------------------- entity-updated mode

describe("evaluateDelta — entity-updated", () => {
  it("area: title + tag assertions pass and movement is derived from pre-fields", () => {
    withDb((db) => {
      const area = seedArea(db, "Home");
      tagArea(db, area, seedTag(db, "cozy"));
      const spec: DeltaSpec = {
        mode: "entity-updated",
        entity: "area",
        uuid: area,
        assert: [
          { field: "title", equals: "Home" },
          { field: "tags", equals: ["cozy"] },
        ],
      };
      const result = evaluateDelta(
        spec,
        createDbReader(db),
        pre({ fields: { [area]: { title: "Old", tags: [] } } }),
      );
      expect(result.satisfied).toBe(true);
      expect(result.movement).toBe(true);
      expect(result.assertedMovement).toBe(true);
    });
  });

  it("tag: parent + shortcut assertions, no movement when pre matches", () => {
    withDb((db) => {
      const tag = seedTag(db, "leaf");
      const spec: DeltaSpec = {
        mode: "entity-updated",
        entity: "tag",
        uuid: tag,
        assert: [
          { field: "parent", equals: null },
          { field: "shortcut", equals: null },
        ],
      };
      const result = evaluateDelta(
        spec,
        createDbReader(db),
        pre({ fields: { [tag]: { parent: null, shortcut: null } } }),
      );
      expect(result.satisfied).toBe(true);
      expect(result.assertedMovement).toBe(false);
    });
  });

  it("row gone: unsatisfied, but movement fires (the row vanished)", () => {
    withDb((db) => {
      const spec: DeltaSpec = {
        mode: "entity-updated",
        entity: "tag",
        uuid: "ghost",
        assert: [{ field: "title", equals: "x" }],
      };
      const result = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(result.satisfied).toBe(false);
      expect(result.movement).toBe(true);
    });
  });
});

// ----------------------------------------------------------------- ordering mode

describe("evaluateDelta — ordering", () => {
  it("satisfied when the sequence reads back in strictly ascending rank", () => {
    withDb((db) => {
      const a = seedTodo(db, { index: 1 });
      const b = seedTodo(db, { index: 2 });
      const c = seedTodo(db, { index: 3 });
      const spec: DeltaSpec = { mode: "ordering", key: "index", sequence: [a, b, c] };
      const result = evaluateDelta(
        spec,
        createDbReader(db),
        pre({ fields: { __ordering__: { [a]: 9, [b]: 8, [c]: 7 } } }),
      );
      expect(result.satisfied).toBe(true);
      expect(result.movement).toBe(true);
    });
  });

  it("unsatisfied when a pair is out of order", () => {
    withDb((db) => {
      const a = seedTodo(db, { index: 3 });
      const b = seedTodo(db, { index: 1 });
      const spec: DeltaSpec = { mode: "ordering", key: "index", sequence: [a, b] };
      expect(evaluateDelta(spec, createDbReader(db), EMPTY_PRE).satisfied).toBe(false);
    });
  });

  it("unsatisfied when a member has no rank", () => {
    withDb((db) => {
      const a = seedTodo(db, { index: 1 });
      const spec: DeltaSpec = { mode: "ordering", key: "index", sequence: [a, "ghost"] };
      expect(evaluateDelta(spec, createDbReader(db), EMPTY_PRE).satisfied).toBe(false);
    });
  });
});

// -------------------------------------------------------------- trash-emptied mode

describe("evaluateDelta — trash-emptied", () => {
  it("satisfied when no trashed rows remain", () => {
    withDb((db) => {
      const spec: DeltaSpec = { mode: "trash-emptied" };
      const result = evaluateDelta(spec, createDbReader(db), pre({ trashedCount: 2 }));
      expect(result.satisfied).toBe(true);
      expect(result.observed).toEqual({ trashedCount: 0 });
    });
  });

  it("unsatisfied while trashed rows survive", () => {
    withDb((db) => {
      seedTodo(db, { trashed: true });
      const spec: DeltaSpec = { mode: "trash-emptied" };
      const result = evaluateDelta(spec, createDbReader(db), pre({ trashedCount: 3 }));
      expect(result.satisfied).toBe(false);
    });
  });
});

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local-calendar YYYY-MM-DD of an epoch-seconds instant (mirrors delta.ts). */
function localIso(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
