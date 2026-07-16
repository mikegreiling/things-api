/**
 * The omit-empty emit transform (src/model/serialize.ts), the "Omit-empty"
 * contract in docs/design/contracts.md. Guards: entity optional fields are
 * omitted when empty; identity keys and semantically-meaningful false/0 are
 * kept; the inheritedTags reversal (absent when empty, present when not); and
 * the structural-vs-entity boundary (a sidebar section's `area: null` and a
 * view's empty section arrays survive because they are not entities).
 */
import { describe, expect, it } from "vitest";

import { omitEmpty } from "../../src/model/serialize.ts";

/** A fully-populated to-do (every optional field non-empty). */
function fullTodo(): Record<string, unknown> {
  return {
    uuid: "todo-1",
    type: "to-do",
    title: "write the report",
    notes: "with sources",
    status: "open",
    logged: false,
    trashed: false,
    start: "active",
    startDate: "2026-07-16",
    todaySection: "today",
    deadline: "2026-07-20",
    reminder: "09:00",
    area: { uuid: "area-1", title: "Work" },
    project: { uuid: "proj-1", title: "Q3" },
    heading: { uuid: "head-1", title: "Phase 1" },
    tags: [{ title: "urgent" }],
    inheritedTags: [
      { tag: { title: "team" }, source: { type: "area", uuid: "area-1", title: "Work" } },
    ],
    repeating: { isTemplate: false, isInstance: false, templateUuid: null },
    checklist: [{ title: "step one", status: "open" }],
    checklistItemsCount: 1,
    openChecklistItemsCount: 1,
    created: new Date("2026-07-01T00:00:00.000Z"),
    modified: new Date("2026-07-10T00:00:00.000Z"),
    stopped: new Date("2026-07-11T00:00:00.000Z"),
  };
}

/** A minimal to-do: only the identity plus empty/default optional fields. */
function minimalTodo(): Record<string, unknown> {
  return {
    uuid: "todo-2",
    type: "to-do",
    title: "",
    notes: "",
    status: "open",
    logged: false,
    trashed: false,
    start: "inbox",
    startDate: null,
    todaySection: null,
    deadline: null,
    reminder: null,
    area: null,
    project: null,
    heading: null,
    tags: [],
    inheritedTags: [],
    repeating: { isTemplate: false, isInstance: false, templateUuid: null },
    checklist: [],
    checklistItemsCount: 0,
    openChecklistItemsCount: 0,
    created: new Date("2026-07-01T00:00:00.000Z"),
    modified: new Date("2026-07-01T00:00:00.000Z"),
    stopped: null,
  };
}

describe("omitEmpty — entity field omission", () => {
  it("keeps every field of a fully-populated entity", () => {
    const out = omitEmpty(fullTodo());
    for (const key of Object.keys(fullTodo())) expect(key in out).toBe(true);
  });

  it("omits every empty optional field of a minimal entity", () => {
    const out = omitEmpty(minimalTodo()) as Record<string, unknown>;
    for (const gone of [
      "notes",
      "startDate",
      "todaySection",
      "deadline",
      "reminder",
      "area",
      "project",
      "heading",
      "tags",
      "inheritedTags",
      "checklist",
      "stopped",
    ]) {
      expect(gone in out).toBe(false);
    }
  });

  it("keeps identity keys even when the title is empty", () => {
    const out = omitEmpty(minimalTodo()) as Record<string, unknown>;
    expect(out["uuid"]).toBe("todo-2");
    expect(out["type"]).toBe("to-do");
    // An untitled to-do still carries its (empty) title — a consumer keys on it.
    expect("title" in out).toBe(true);
    expect(out["title"]).toBe("");
  });

  it("keeps semantically-meaningful false and 0 (absence would be lossy)", () => {
    const out = omitEmpty(minimalTodo()) as Record<string, unknown>;
    expect(out["logged"]).toBe(false);
    expect(out["trashed"]).toBe(false);
    expect(out["checklistItemsCount"]).toBe(0);
    expect(out["openChecklistItemsCount"]).toBe(0);
    // status is a non-empty enum string — always present.
    expect(out["status"]).toBe("open");
  });

  it("serializes Date fields as ISO strings, never as {} ", () => {
    const out = omitEmpty(minimalTodo());
    expect(JSON.parse(JSON.stringify(out)).created).toBe("2026-07-01T00:00:00.000Z");
  });

  it("does not mutate its input (render path keeps the full entity)", () => {
    const input = minimalTodo();
    omitEmpty(input);
    expect(input.tags).toEqual([]);
    expect(input.deadline).toBeNull();
  });
});

describe("omitEmpty — inheritedTags reversal guard", () => {
  it("omits inheritedTags when empty", () => {
    const out = omitEmpty(minimalTodo()) as Record<string, unknown>;
    expect("inheritedTags" in out).toBe(false);
  });

  it("keeps inheritedTags when non-empty", () => {
    const out = omitEmpty(fullTodo()) as Record<string, unknown>;
    expect("inheritedTags" in out).toBe(true);
    expect(out["inheritedTags"]).toHaveLength(1);
  });
});

describe("omitEmpty — tag taxonomy rows", () => {
  it("omits a root tag's null parent and null shortcut, keeps a nested tag's parent", () => {
    const out = omitEmpty([
      { title: "old labels", shortcut: null, parent: null },
      { title: "areas", shortcut: null, parent: "old labels" },
    ]) as Array<Record<string, unknown>>;
    expect("parent" in (out[0] as object)).toBe(false);
    expect("shortcut" in (out[0] as object)).toBe(false);
    expect(out[1]?.["parent"]).toBe("old labels");
  });
});

describe("omitEmpty — area entity", () => {
  it("omits empty tags but keeps a real false visible flag", () => {
    const out = omitEmpty({
      uuid: "area-1",
      title: "Work",
      visible: false,
      tags: [],
    }) as Record<string, unknown>;
    expect("tags" in out).toBe(false);
    expect(out["visible"]).toBe(false);
  });
});

describe("omitEmpty — structural scaffolding is preserved", () => {
  it("keeps a sidebar section's null area (the load-bearing loose-block marker)", () => {
    // area: null on a section is NOT the same as area: null on a to-do — it is
    // the top-level/loose block discriminant and must survive.
    const out = omitEmpty({
      area: null,
      items: [minimalTodo()],
    }) as Record<string, unknown>;
    expect("area" in out).toBe(true);
    expect(out["area"]).toBeNull();
  });

  it("keeps a today view's empty evening section (fixed two-section shape)", () => {
    const out = omitEmpty({
      today: [minimalTodo()],
      evening: [],
      badge: { dueOrOverdue: 0, other: 0 },
    }) as Record<string, unknown>;
    expect("evening" in out).toBe(true);
    expect(out["evening"]).toEqual([]);
    // The badge object is scaffolding, not an entity — its zero counts survive.
    expect(out["badge"]).toEqual({ dueOrOverdue: 0, other: 0 });
  });

  it("keeps empty project-card sections but prunes the nested project entity", () => {
    const out = omitEmpty({
      project: { uuid: "p1", type: "project", title: "Q3", notes: "", tags: [] },
      active: [],
      headings: [],
      later: { scheduled: [], repeating: [], someday: [] },
      logged: [],
      trashed: [],
      openChildrenWhileResolved: 0,
    }) as Record<string, unknown>;
    // Structural section arrays survive even when empty.
    for (const key of ["active", "headings", "logged", "trashed"]) {
      expect(key in out).toBe(true);
    }
    expect(out["later"]).toEqual({ scheduled: [], repeating: [], someday: [] });
    expect(out["openChildrenWhileResolved"]).toBe(0);
    // The nested project ENTITY is pruned.
    const project = out["project"] as Record<string, unknown>;
    expect("notes" in project).toBe(false);
    expect("tags" in project).toBe(false);
    expect(project["title"]).toBe("Q3");
  });
});
