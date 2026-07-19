import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/write/commands.ts";
import { evaluateGuards, type GuardBlock } from "../../src/write/guards.ts";
import type {
  Acknowledgements,
  OperationKind,
  OperationParamsMap,
} from "../../src/write/operations.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedHeading, seedProject, seedTag, seedTodo } from "../fixtures/seed.ts";

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

describe("H-TEMPLATE-CHILD-RESTORE", () => {
  it("blocks restoring a trashed to-do that lives under a repeating-template project", () => {
    const template = seedProject(fixture.db, {
      title: "Repeating",
      recurrenceRule: true,
      start: "someday",
    });
    const child = seedTodo(fixture.db, { title: "Child", project: template, trashed: true });
    const block = check("todo.restore", { uuid: child });
    expect(block?.hazard).toBe("H-TEMPLATE-CHILD-RESTORE");
    expect(block?.detail).toContain("child of a repeating template");
    expect(block?.remediation).toContain("recreate the to-do inside the template");
  });

  it("blocks a trashed HEADING-nested child of a template project (reached via headingProject)", () => {
    const template = seedProject(fixture.db, {
      title: "Repeating",
      recurrenceRule: true,
      start: "someday",
    });
    const head = seedHeading(fixture.db, { title: "Phase", project: template });
    const child = seedTodo(fixture.db, { title: "Nested", heading: head, trashed: true });
    expect(check("todo.restore", { uuid: child })?.hazard).toBe("H-TEMPLATE-CHILD-RESTORE");
  });

  it("does NOT fire for an ordinary trashed to-do (plain project, or loose)", () => {
    const plainProj = seedProject(fixture.db, { title: "Plain" });
    const underPlain = seedTodo(fixture.db, {
      title: "C",
      project: plainProj,
      trashed: true,
    });
    const loose = seedTodo(fixture.db, { title: "L", trashed: true });
    expect(check("todo.restore", { uuid: underPlain })).toBeNull();
    expect(check("todo.restore", { uuid: loose })).toBeNull();
  });
});

describe("H-UNKNOWN-DESTINATION (heading.create project resolution)", () => {
  it("blocks when the destination project does not resolve", () => {
    expect(check("heading.create", { project: { title: "ghost" }, title: "H" })?.hazard).toBe(
      "H-UNKNOWN-DESTINATION",
    );
  });

  it("passes when the project resolves", () => {
    seedProject(fixture.db, { title: "Real" });
    expect(check("heading.create", { project: { title: "Real" }, title: "H" })).toBeNull();
  });
});

describe("H-UNKNOWN-DESTINATION missing-target copy", () => {
  it("names an unresolved to-do target with the shared uuid-miss wording", () => {
    const block = check("todo.update", { uuid: "ghost-uuid-000", title: "x" });
    expect(block?.hazard).toBe("H-UNKNOWN-DESTINATION");
    expect(block?.detail).toContain('no to-do matching uuid or partial-uuid "ghost-uuid-000"');
  });

  it("uses the project entity noun for a project op", () => {
    const block = check("project.update", { uuid: "ghost-uuid-000", title: "x" });
    expect(block?.hazard).toBe("H-UNKNOWN-DESTINATION");
    expect(block?.detail).toContain('no project matching uuid or partial-uuid "ghost-uuid-000"');
  });
});

describe("H-NO-REMINDER (todo.clear-dated-reminder)", () => {
  it("blocks a to-do with no reminder set", () => {
    const uuid = seedTodo(fixture.db, { title: "no reminder", startDate: "2026-07-20" });
    expect(check("todo.clear-dated-reminder", { uuid })?.hazard).toBe("H-NO-REMINDER");
  });

  it("passes a date-scheduled to-do that has a reminder", () => {
    const uuid = seedTodo(fixture.db, {
      title: "dated + reminder",
      startDate: "2026-07-20",
      reminder: "09:30",
    });
    expect(check("todo.clear-dated-reminder", { uuid })).toBeNull();
  });

  it("blocks a non-to-do target via H-UNKNOWN-DESTINATION", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    expect(check("todo.clear-dated-reminder", { uuid: proj })?.hazard).toBe(
      "H-UNKNOWN-DESTINATION",
    );
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
    const block = check("todo.set-tags", { uuid: todo, tags: ["real", "ghost"] });
    expect(block?.hazard).toBe("H-UNKNOWN-TAG");
    expect(block?.remediation).toContain("--create-tags"); // the new remediation suggestion
    expect(check("todo.set-tags", { uuid: todo, tags: ["REAL"] })).toBeNull(); // case-insensitive
  });

  it("accepts a name or a parent/child path as a tag value (uuids are NOT accepted)", () => {
    const work = seedTag(fixture.db, "Work");
    const errands = seedTag(fixture.db, "Errands", work);
    const todo = seedTodo(fixture.db, { title: "t" });
    expect(check("todo.set-tags", { uuid: todo, tags: ["Errands"] })).toBeNull(); // by name
    expect(check("todo.set-tags", { uuid: todo, tags: ["Work/Errands"] })).toBeNull(); // by path
    // A tag uuid is no longer a valid ref — it names no tag, so it is unknown.
    expect(check("todo.set-tags", { uuid: todo, tags: [errands] })?.hazard).toBe("H-UNKNOWN-TAG");
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

describe("duplicate tag names delegate to the app (no refusal)", () => {
  it("a name matching two tags is KNOWN — the app resolves it, exactly as the GUI does", () => {
    // A duplicate-name pair is a Cloud-sync-only pathological state. We apply
    // tags BY NAME through the app's own vector, so the app resolves it — we
    // never pick a uuid, so there is no ambiguity refusal (the old
    // H-DUPLICATE-TAG guard was removed).
    const root = seedTag(fixture.db, "Work");
    seedTag(fixture.db, "Work", root); // a second `Work` — only Cloud sync can make this
    const todo = seedTodo(fixture.db, { title: "t" });
    expect(check("todo.set-tags", { uuid: todo, tags: ["Work"] })).toBeNull();
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

  it("EVERY project op rejects a to-do or heading uuid (wrong-specifier crash guard)", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const todo = seedTodo(fixture.db, { title: "t", project: proj });
    // The four ops that previously had NO type check.
    for (const op of ["project.update", "project.complete", "project.delete"] as const) {
      const params =
        op === "project.complete"
          ? { uuid: todo, children: "require-resolved" as const }
          : { uuid: todo };
      const block = check(op, params as never);
      expect(block?.hazard).toBe("H-UNKNOWN-DESTINATION");
      expect(block?.detail).toContain("not a project");
      expect(block?.detail).toContain("things todo");
    }
    expect(check("project.set-tags", { uuid: todo, tags: [] })?.detail).toContain("not a project");
    // A heading points at the heading commands.
    expect(check("project.update", { uuid: heading, title: "x" })?.detail).toContain(
      "things heading",
    );
    // The already-covered ops still reject too.
    expect(check("project.move", { uuid: todo, area: { uuid: "A" } })?.hazard).toBe(
      "H-UNKNOWN-DESTINATION",
    );
    // ...and a real project passes the type gate (may still hit other problems).
    expect(check("project.update", { uuid: proj, title: "renamed" })).toBeNull();
  });

  it("a cross-table uuid (area) in a task/project op is caught as not-found", () => {
    const area = seedArea(fixture.db, "Home");
    // Areas live in TMArea, not TMTask, so loadTarget returns null.
    expect(check("todo.update", { uuid: area, title: "x" })?.hazard).toBe("H-UNKNOWN-DESTINATION");
    expect(check("project.delete", { uuid: area })?.hazard).toBe("H-UNKNOWN-DESTINATION");
  });
});

describe("H-BACKDATE-OPEN", () => {
  it("blocks rewriting completionDate on an OPEN to-do (with the exact remediation)", () => {
    const uuid = seedTodo(fixture.db, { title: "still open", status: "open" });
    const block = check("todo.backdate", { uuid, completionDate: "2024-01-01" });
    expect(block?.hazard).toBe("H-BACKDATE-OPEN");
    expect(block?.detail).toContain("completionDate can only be rewritten");
    expect(block?.detail).toContain("open");
    expect(block?.remediation).toBe("complete it first (todo.complete), then backdate");
  });

  it("passes completionDate backdate on a completed or a canceled to-do", () => {
    const completed = seedTodo(fixture.db, { title: "done", status: "completed" });
    const canceled = seedTodo(fixture.db, { title: "gone", status: "canceled" });
    expect(check("todo.backdate", { uuid: completed, completionDate: "2024-01-01" })).toBeNull();
    expect(check("todo.backdate", { uuid: canceled, completionDate: "2024-01-01" })).toBeNull();
  });

  it("does not fire when only creationDate is backdated (no completionDate rewrite)", () => {
    const uuid = seedTodo(fixture.db, { title: "still open", status: "open" });
    expect(check("todo.backdate", { uuid, creationDate: "2024-01-01" })).toBeNull();
  });
});
