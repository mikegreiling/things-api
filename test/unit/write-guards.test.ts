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
  it("blocks when/deadline updates and status/move ops on repeating templates", () => {
    const uuid = seedTodo(fixture.db, {
      title: "Template",
      recurrenceRule: true,
      start: "someday",
    });
    expect(check("todo.update", { uuid, when: "today" })?.hazard).toBe("H-REPEAT-SCHEDULE");
    expect(check("todo.complete", { uuid })?.hazard).toBe("H-REPEAT-SCHEDULE");
  });

  it("a to-do's schedule refusal is a TWO-WAY steer, not a dead end (ruling 2026-08-24)", () => {
    // Both readings of "reschedule this repeating to-do" are reachable now — one
    // occurrence via the exception composite, the series via reschedule-repeat —
    // so the refusal names both rather than sending the caller to the app.
    const uuid = seedTodo(fixture.db, {
      title: "Template",
      recurrenceRule: true,
      start: "someday",
    });
    const block = check("todo.update", { uuid, when: "2026-07-15" });
    expect(block?.hazard).toBe("H-REPEAT-SCHEDULE");
    expect(block?.detail).toContain("ambiguous");
    expect(block?.remediation).toContain("--exception");
    expect(block?.remediation).toContain("reschedule-repeat");
    // A deadline change is the same ambiguity.
    expect(check("todo.update", { uuid, deadline: "2026-07-15" })?.remediation).toContain(
      "--exception",
    );
  });

  it("a repeating PROJECT keeps the original refusal — the composite is to-dos only (CNC1 §8)", () => {
    const uuid = seedProject(fixture.db, {
      title: "Repeating",
      recurrenceRule: true,
      start: "someday",
    });
    const block = check("project.duplicate", { uuid });
    expect(block?.hazard).toBe("H-REPEAT-SCHEDULE");
    expect(block?.remediation).not.toContain("--exception");
  });

  it("ALLOWS deleting a repeating template (byte-identical to the GUI's own delete; disclosure + Put Back ride the result, ruling 2026-08-13)", () => {
    // The delete arm of H-REPEAT-SCHEDULE was lifted: trashing a template is the
    // GUI's own Edit ▸ Delete (SERDEL S1), human-recoverable via Trash ▸ Put Back.
    // The guard no longer refuses it — the pipeline attaches the disclosure.
    const todoTemplate = seedTodo(fixture.db, {
      title: "Template",
      recurrenceRule: true,
      start: "someday",
    });
    const projectTemplate = seedProject(fixture.db, {
      title: "Repeating",
      recurrenceRule: true,
      start: "someday",
    });
    expect(check("todo.delete", { uuid: todoTemplate })).toBeNull();
    expect(check("project.delete", { uuid: projectTemplate })).toBeNull();
  });

  it("refuses restoring a trashed repeating template with a Put-Back message (todo + project)", () => {
    // A trashed template cannot be revived headlessly (our restore is move-to-Inbox;
    // the app forbids moving a template out to a list, AS 301) — so restore refuses
    // categorically and points at the app's Trash ▸ Put Back, not the raw AS no-op.
    const todoTemplate = seedTodo(fixture.db, {
      title: "Template",
      recurrenceRule: true,
      start: "someday",
      trashed: true,
    });
    const projectTemplate = seedProject(fixture.db, {
      title: "Repeating",
      recurrenceRule: true,
      start: "someday",
      trashed: true,
    });
    const todoBlock = check("todo.restore", { uuid: todoTemplate });
    expect(todoBlock?.hazard).toBe("H-REPEAT-SCHEDULE");
    expect(todoBlock?.detail).toContain("trashed repeating series");
    expect(todoBlock?.remediation).toContain("Put Back");
    const projectBlock = check("project.restore", { uuid: projectTemplate });
    expect(projectBlock?.hazard).toBe("H-REPEAT-SCHEDULE");
    expect(projectBlock?.remediation).toContain("Put Back");
  });

  it("allows title/notes updates on templates (validated U12B) and everything on normal todos", () => {
    const template = seedTodo(fixture.db, { title: "Template", recurrenceRule: true });
    const normal = seedTodo(fixture.db, { title: "Normal" });
    expect(check("todo.update", { uuid: template, title: "Renamed" })).toBeNull();
    expect(check("todo.update", { uuid: normal, when: "today" })).toBeNull();
    expect(check("todo.complete", { uuid: normal })).toBeNull();
  });

  it("allows delete on a plain project/to-do and on a repeating INSTANCE (series-preserving, C5)", () => {
    // An instance carries the template FK but no recurrence rule of its own, so it
    // is not a template row — trashing it is clean and series-preserving (C5).
    const template = seedProject(fixture.db, {
      title: "Repeating",
      recurrenceRule: true,
      start: "someday",
    });
    const instance = seedProject(fixture.db, { title: "Occurrence", repeatingTemplate: template });
    const plain = seedProject(fixture.db, { title: "Plain" });
    expect(check("project.delete", { uuid: instance })).toBeNull();
    expect(check("project.delete", { uuid: plain })).toBeNull();
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

describe("H-UNKNOWN-DESTINATION (heading.add project resolution)", () => {
  it("blocks when the destination project does not resolve", () => {
    expect(check("project.add-heading", { project: { title: "ghost" }, title: "H" })?.hazard).toBe(
      "H-UNKNOWN-DESTINATION",
    );
  });

  it("passes when the project resolves", () => {
    seedProject(fixture.db, { title: "Real" });
    expect(check("project.add-heading", { project: { title: "Real" }, title: "H" })).toBeNull();
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
  it("blocks adds/moves into a completed project (reached BY UUID) without the ack", () => {
    // A completed project is not a destination by NAME any more (open-only name
    // resolution — PLOG1); it is reachable only by uuid (explicit intent), which
    // is exactly where this reopen hazard fires.
    const done = seedProject(fixture.db, { title: "Done Project", status: "completed" });
    const todo = seedTodo(fixture.db, { title: "mover" });
    expect(check("todo.add", { title: "n", project: { uuid: done } })?.hazard).toBe(
      "H-REOPEN-RESOLVED-PROJECT",
    );
    expect(check("todo.move", { uuid: todo, project: { uuid: done } })?.hazard).toBe(
      "H-REOPEN-RESOLVED-PROJECT",
    );
    expect(
      check(
        "todo.add",
        { title: "n", project: { uuid: done } },
        { acknowledgeProjectReopen: true },
      ),
    ).toBeNull();
  });

  it("a completed project is NOT a destination BY NAME — not-found with a by-uuid hint", () => {
    seedProject(fixture.db, { title: "Done Project", status: "completed" });
    const todo = seedTodo(fixture.db, { title: "mover" });
    const block = check("todo.move", { uuid: todo, project: { title: "Done Project" } });
    expect(block?.hazard).toBe("H-UNKNOWN-DESTINATION");
    expect(block?.detail).toContain("project not found");
    expect(block?.detail).toContain("1 completed project matches this name");
    expect(block?.detail).toContain("target it by uuid if intended");
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
    expect(check("todo.set-dates", { uuid: heading, createdAt: "2024-01-01" })?.hazard).toBe(
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

describe("H-AREA-NOT-EMPTY", () => {
  it("refuses a non-empty area delete with the member counts and both remediations", () => {
    const area = seedArea(fixture.db, "Work");
    seedProject(fixture.db, { title: "P1", area });
    seedProject(fixture.db, { title: "P2", area });
    seedProject(fixture.db, { title: "P3", area });
    for (let i = 0; i < 12; i++) seedTodo(fixture.db, { title: `t${i}`, area });
    const block = check("area.delete", { target: "Work" });
    expect(block?.hazard).toBe("H-AREA-NOT-EMPTY");
    expect(block?.detail).toContain("3 projects and 12 to-dos");
    expect(block?.remediation).toContain("--allow-non-empty");
    expect(block?.remediation).toContain("empty the area");
  });

  it("uses singular nouns and lists only the member kinds present in the count", () => {
    const projOnly = seedArea(fixture.db, "ProjOnly");
    seedProject(fixture.db, { title: "solo", area: projOnly });
    // Singular "1 project", and the count clause (up to the first ";") names no to-do.
    const projCount = check("area.delete", { target: "ProjOnly" })?.detail.split(";")[0] ?? "";
    expect(projCount).toContain("1 project");
    expect(projCount).not.toContain("to-do");

    const todoOnly = seedArea(fixture.db, "TodoOnly");
    seedTodo(fixture.db, { title: "solo", area: todoOnly });
    const todoCount = check("area.delete", { target: "TodoOnly" })?.detail.split(";")[0] ?? "";
    expect(todoCount).toContain("1 to-do");
    expect(todoCount).not.toContain("project");
  });

  it("counts non-trashed members of any status; trashed rows do not count", () => {
    const area = seedArea(fixture.db, "Mixed");
    seedTodo(fixture.db, { title: "logged", area, status: "completed" });
    seedTodo(fixture.db, { title: "gone", area, trashed: true });
    // A completed (logbook) to-do is still live in the area; the trashed one is not.
    const block = check("area.delete", { target: "Mixed" });
    expect(block?.hazard).toBe("H-AREA-NOT-EMPTY");
    expect(block?.detail).toContain("1 to-do");
  });

  it("passing allowNonEmptyArea clears THIS gate (leaving only the permanent-delete ack)", () => {
    const area = seedArea(fixture.db, "Work");
    seedProject(fixture.db, { title: "P", area });
    // allow-non-empty satisfied → the next gate (permanent delete) is what remains.
    expect(check("area.delete", { target: "Work" }, { allowNonEmptyArea: true })?.hazard).toBe(
      "H-PERMANENT-DELETE",
    );
    // Both acknowledgements → the delete proceeds.
    expect(
      check(
        "area.delete",
        { target: "Work" },
        { allowNonEmptyArea: true, dangerouslyPermanent: true },
      ),
    ).toBeNull();
  });

  it("an EMPTY area never trips this gate — only the permanent-delete ack stands", () => {
    seedArea(fixture.db, "Empty");
    // No allow-non-empty needed; the sole remaining gate is the permanent-delete ack.
    expect(check("area.delete", { target: "Empty" })?.hazard).toBe("H-PERMANENT-DELETE");
    expect(check("area.delete", { target: "Empty" }, { dangerouslyPermanent: true })).toBeNull();
  });
});

describe("H-HEADING-CHILDREN", () => {
  it("requires a children policy when open children exist; passes when drained or resolved", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    seedTodo(fixture.db, { title: "child", heading });
    expect(check("project.archive-heading", { uuid: heading })?.hazard).toBe("H-HEADING-CHILDREN");
    expect(check("project.archive-heading", { uuid: heading, children: "complete" })).toBeNull();
    expect(check("project.archive-heading", { uuid: heading, children: "cancel" })).toBeNull();
    // reparent at the atomic layer with children still open = orchestrator bypass
    expect(
      check("project.archive-heading", { uuid: heading, children: "reparent" })?.detail,
    ).toContain("orchestrator");
  });

  it("heading ops reject non-heading targets", () => {
    const todo = seedTodo(fixture.db, { title: "t" });
    expect(check("project.rename-heading", { uuid: todo, title: "x" })?.hazard).toBe(
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
    // A heading points at the project heading commands.
    expect(check("project.update", { uuid: heading, title: "x" })?.detail).toContain(
      "things project …-heading",
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

describe("H-BACKDATE-OPEN (generalized to set-dates, both kinds)", () => {
  it("blocks rewriting completedAt on an OPEN to-do (with the exact remediation)", () => {
    const uuid = seedTodo(fixture.db, { title: "still open", status: "open" });
    const block = check("todo.set-dates", { uuid, completedAt: "2024-01-01" });
    expect(block?.hazard).toBe("H-BACKDATE-OPEN");
    expect(block?.detail).toContain("requires a completed to-do");
    expect(block?.detail).toContain("open");
    expect(block?.remediation).toContain("complete --completed-at");
    expect(block?.remediation).toContain("cancel --completed-at");
  });

  it("passes completedAt write on a completed to-do", () => {
    const completed = seedTodo(fixture.db, { title: "done", status: "completed" });
    expect(check("todo.set-dates", { uuid: completed, completedAt: "2024-01-01" })).toBeNull();
  });

  it("blocks completedAt write on a CANCELED to-do (silent convert to completed)", () => {
    const canceled = seedTodo(fixture.db, { title: "gone", status: "canceled" });
    const block = check("todo.set-dates", { uuid: canceled, completedAt: "2024-01-01" });
    expect(block?.hazard).toBe("H-BACKDATE-OPEN");
    expect(block?.detail).toContain("requires a completed to-do");
    expect(block?.detail).toContain("discarding the canceled status");
  });

  it("blocks completedAt write on an OPEN project too (kind-agnostic law)", () => {
    const proj = seedProject(fixture.db, { title: "open proj", status: "open" });
    const block = check("project.set-dates", { uuid: proj, completedAt: "2024-01-01" });
    expect(block?.hazard).toBe("H-BACKDATE-OPEN");
    expect(block?.detail).toContain("requires a completed project");
  });

  it("does not fire when only createdAt is written (no completedAt rewrite)", () => {
    const uuid = seedTodo(fixture.db, { title: "still open", status: "open" });
    expect(check("todo.set-dates", { uuid, createdAt: "2024-01-01" })).toBeNull();
  });

  it("allows a createdAt-only write on a CANCELED to-do (set creation date is status-safe)", () => {
    const canceled = seedTodo(fixture.db, { title: "gone", status: "canceled" });
    expect(check("todo.set-dates", { uuid: canceled, createdAt: "2024-01-01" })).toBeNull();
  });
});
