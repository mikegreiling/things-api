import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/write/commands.ts";
import { evaluateGuards, type GuardBlock } from "../../src/write/guards.ts";
import type {
  Acknowledgements,
  OperationKind,
  OperationParamsMap,
} from "../../src/write/operations.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedHeading, seedProject, seedTag, seedTodo } from "../fixtures/seed.ts";

let fixture: FixtureDb;

beforeEach(() => {
  fixture = buildFixtureDb();
});
afterEach(() => {
  fixture.close();
});

function check<K extends OperationKind>(
  op: K,
  params: OperationParamsMap[K],
  acks: Acknowledgements = {},
): GuardBlock | null {
  const spec = COMMANDS[op];
  const pre = spec.preRead(fixture.db, params, new Date());
  return evaluateGuards(spec.hazards, {
    op,
    params: params as Record<string, unknown>,
    pre,
    acks,
  });
}

describe("H-REPEAT-SCHEDULE", () => {
  it("blocks when/deadline updates and status ops on repeating templates", () => {
    const uuid = seedTodo(fixture.db, {
      title: "Template",
      recurrenceRule: true,
      start: "someday",
    });
    expect(check("todo.update", { uuid, when: "today" })?.hazard).toBe("H-REPEAT-SCHEDULE");
    expect(check("todo.complete", { uuid })?.hazard).toBe("H-REPEAT-SCHEDULE");
    expect(check("todo.delete", { uuid })?.hazard).toBe("H-REPEAT-SCHEDULE");
  });

  it("allows title/notes updates on templates (validated U12B) and everything on normal todos", () => {
    const template = seedTodo(fixture.db, { title: "Template", recurrenceRule: true });
    const normal = seedTodo(fixture.db, { title: "Normal" });
    expect(check("todo.update", { uuid: template, title: "Renamed" })).toBeNull();
    expect(check("todo.update", { uuid: normal, when: "today" })).toBeNull();
    expect(check("todo.complete", { uuid: normal })).toBeNull();
  });
});

describe("H-PROJECT-COMPLETE-CHILDREN", () => {
  it("requires an explicit children policy when open children exist", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    seedTodo(fixture.db, { title: "open child", project: proj });
    seedTodo(fixture.db, { title: "done child", project: proj, status: "completed" });
    expect(check("project.complete", { uuid: proj, children: "require-resolved" })?.hazard).toBe(
      "H-PROJECT-COMPLETE-CHILDREN",
    );
    expect(check("project.complete", { uuid: proj, children: "auto-complete" })).toBeNull();
  });

  it("passes require-resolved when all children are resolved (incl. heading-contained)", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const head = seedHeading(fixture.db, { title: "H", project: proj });
    seedTodo(fixture.db, { title: "done", project: proj, status: "completed" });
    seedTodo(fixture.db, { title: "headed done", heading: head, status: "canceled" });
    expect(check("project.complete", { uuid: proj, children: "require-resolved" })).toBeNull();
  });

  it("counts heading-contained open children (project column NULL)", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const head = seedHeading(fixture.db, { title: "H", project: proj });
    seedTodo(fixture.db, { title: "headed open", heading: head });
    expect(check("project.complete", { uuid: proj, children: "require-resolved" })?.hazard).toBe(
      "H-PROJECT-COMPLETE-CHILDREN",
    );
  });
});

describe("H-CHECKLIST-REPLACE", () => {
  it("requires the ack only when checklist items exist", () => {
    const withItems = seedTodo(fixture.db, { title: "A" });
    fixture.db
      .prepare(
        "INSERT INTO TMChecklistItem (uuid, title, status, \"index\", task, creationDate, userModificationDate) VALUES ('c1', 'x', 0, 0, ?, 1, 1)",
      )
      .run(withItems);
    const bare = seedTodo(fixture.db, { title: "B" });
    expect(check("todo.replace-checklist", { uuid: withItems, items: ["n"] })?.hazard).toBe(
      "H-CHECKLIST-REPLACE",
    );
    expect(
      check(
        "todo.replace-checklist",
        { uuid: withItems, items: ["n"] },
        { acknowledgeChecklistReset: true },
      ),
    ).toBeNull();
    expect(check("todo.replace-checklist", { uuid: bare, items: ["n"] })).toBeNull();
  });
});

describe("H-REOPEN-RESOLVED-PROJECT", () => {
  it("blocks adds/moves into a completed project without the ack", () => {
    seedProject(fixture.db, { title: "Done Project", status: "completed" });
    const todo = seedTodo(fixture.db, { title: "mover" });
    expect(check("todo.add", { title: "n", project: { title: "Done Project" } })?.hazard).toBe(
      "H-REOPEN-RESOLVED-PROJECT",
    );
    expect(check("todo.move", { uuid: todo, project: { title: "Done Project" } })?.hazard).toBe(
      "H-REOPEN-RESOLVED-PROJECT",
    );
    expect(
      check(
        "todo.add",
        { title: "n", project: { title: "Done Project" } },
        { acknowledgeProjectReopen: true },
      ),
    ).toBeNull();
  });
});

describe("H-UNKNOWN-TAG / H-UNKNOWN-DESTINATION / H-AMBIGUOUS-HEADING", () => {
  it("fails fast on unknown tags (app would silently ignore them)", () => {
    seedTag(fixture.db, "real");
    const todo = seedTodo(fixture.db, { title: "t" });
    expect(check("todo.set-tags", { uuid: todo, tags: ["real", "ghost"] })?.hazard).toBe(
      "H-UNKNOWN-TAG",
    );
    expect(check("todo.set-tags", { uuid: todo, tags: ["REAL"] })).toBeNull(); // case-insensitive
  });

  it("fails fast on unknown and ambiguous destinations", () => {
    seedProject(fixture.db, { title: "Dup" });
    seedProject(fixture.db, { title: "Dup" });
    expect(check("todo.add", { title: "n", project: { title: "Nope" } })?.hazard).toBe(
      "H-UNKNOWN-DESTINATION",
    );
    expect(check("todo.add", { title: "n", project: { title: "Dup" } })?.hazard).toBe(
      "H-UNKNOWN-DESTINATION",
    );
    expect(check("todo.update", { uuid: "missing-uuid", title: "x" })?.hazard).toBe(
      "H-UNKNOWN-DESTINATION",
    );
  });

  it("rejects non-to-do targets for every todo op (heading uuids can crash the app)", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const block = check("todo.update", { uuid: heading, when: "today" });
    expect(block?.hazard).toBe("H-UNKNOWN-DESTINATION");
    expect(block?.detail).toContain("heading");
    expect(check("todo.complete", { uuid: proj })?.detail).toContain("project commands");
    expect(check("todo.backdate", { uuid: heading, creationDate: "2024-01-01" })?.hazard).toBe(
      "H-UNKNOWN-DESTINATION",
    );
  });

  it("blocks duplicate heading names in the destination project", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    seedHeading(fixture.db, { title: "Same", project: proj });
    seedHeading(fixture.db, { title: "Same", project: proj });
    expect(
      check("todo.add", { title: "n", project: { title: "P" }, heading: "Same" })?.hazard,
    ).toBe("H-AMBIGUOUS-HEADING");
  });
});

describe("H-PERMANENT-DELETE", () => {
  it("gates area/tag delete and empty-trash behind dangerouslyPermanent", () => {
    seedTag(fixture.db, "doomed");
    expect(check("tag.delete", { target: "doomed" })?.hazard).toBe("H-PERMANENT-DELETE");
    expect(check("tag.delete", { target: "doomed" }, { dangerouslyPermanent: true })).toBeNull();
    expect(check("trash.empty", {})?.hazard).toBe("H-PERMANENT-DELETE");
  });
});

describe("H-HEADING-CHILDREN", () => {
  it("requires a children policy when open children exist; passes when drained or resolved", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    seedTodo(fixture.db, { title: "child", heading });
    expect(check("heading.archive", { uuid: heading })?.hazard).toBe("H-HEADING-CHILDREN");
    expect(check("heading.archive", { uuid: heading, children: "complete" })).toBeNull();
    expect(check("heading.archive", { uuid: heading, children: "cancel" })).toBeNull();
    // reparent at the atomic layer with children still open = orchestrator bypass
    expect(check("heading.archive", { uuid: heading, children: "reparent" })?.detail).toContain(
      "orchestrator",
    );
  });

  it("heading ops reject non-heading targets", () => {
    const todo = seedTodo(fixture.db, { title: "t" });
    expect(check("heading.rename", { uuid: todo, title: "x" })?.hazard).toBe(
      "H-UNKNOWN-DESTINATION",
    );
  });
});
