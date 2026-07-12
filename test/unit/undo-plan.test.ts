/**
 * Phase 15 unit tests: undo target selection + inverse-plan construction.
 * planUndo is pure — records in, plans out — so every op class is covered
 * here without touching a pipeline.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { AnyTask } from "../../src/model/entities.ts";
import { planUndo, readAuditRecords, selectUndoTargets } from "../../src/write/undo.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

/** Minimal decoded to-do for the clear-reminder targeted-restore path. */
function currentTodo(partial: Partial<AnyTask> = {}): AnyTask {
  return {
    type: "to-do",
    uuid: "U-1",
    startDate: null,
    todaySection: null,
    reminder: null,
    repeating: { isTemplate: false, isInstance: false, templateUuid: null },
    ...partial,
  } as unknown as AnyTask;
}

function record(partial: Partial<AuditRecord>): AuditRecord {
  return {
    v: 1,
    ts: "2026-07-05T10:00:00.000Z",
    actor: "mike",
    host: "host",
    op: "todo.update",
    uuid: "U-1",
    vector: "url-scheme",
    disruption: 0,
    invocation: "things:///update?...",
    requested: {},
    pre: null,
    observed: null,
    result: "ok",
    verify: null,
    durationMs: 1,
    env: { pkg: "0.1.0", dbVersion: 26, fingerprint: "ok" },
    ...partial,
  };
}

describe("selectUndoTargets", () => {
  it("takes only successful records, newest first, excluding undo-generated ones", () => {
    const records = [
      record({ ts: "2026-07-05T09:00:00Z", op: "todo.add", uuid: "A" }),
      record({
        ts: "2026-07-05T09:10:00Z",
        op: "todo.complete",
        result: "blocked:H-REPEAT-SCHEDULE",
      }),
      record({ ts: "2026-07-05T09:20:00Z", op: "todo.complete", uuid: "B" }),
      record({ ts: "2026-07-05T09:30:00Z", op: "todo.reopen", uuid: "B", actor: "undo:mike" }),
    ];
    const targets = selectUndoTargets(records, 2);
    expect(targets.map((t) => t.uuid)).toEqual(["B", "A"]);
  });
});

describe("readAuditRecords", () => {
  it("parses monthly files, tolerates torn lines, sorts by ts", () => {
    const dir = mkdtempSync(join(tmpdir(), "things-api-undo-test-"));
    try {
      writeFileSync(
        join(dir, "2026-07.jsonl"),
        `${JSON.stringify(record({ ts: "2026-07-05T10:00:00Z", op: "b" }))}\n{"torn`,
      );
      writeFileSync(
        join(dir, "2026-06.jsonl"),
        `${JSON.stringify(record({ ts: "2026-06-01T10:00:00Z", op: "a" }))}\n`,
      );
      const records = readAuditRecords(dir);
      expect(records.map((r) => r.op)).toEqual(["a", "b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty for a missing directory", () => {
    expect(readAuditRecords("/nonexistent/audit")).toEqual([]);
  });
});

describe("planUndo — creations invert to deletes", () => {
  it("todo.add → todo.delete (to Trash)", () => {
    const plan = planUndo(record({ op: "todo.add", uuid: "NEW-1" }), NOW);
    expect(plan.kind).toBe("invertible");
    expect(plan.steps).toEqual([{ op: "todo.delete", params: { uuid: "NEW-1" } }]);
  });

  it("project.duplicate → project.delete of the copy", () => {
    const plan = planUndo(record({ op: "project.duplicate", uuid: "COPY-1" }), NOW);
    expect(plan.steps[0]).toEqual({ op: "project.delete", params: { uuid: "COPY-1" } });
  });

  it("area.add → PERMANENT area.delete flagged with the ack", () => {
    const plan = planUndo(record({ op: "area.add", uuid: "AREA-1" }), NOW);
    expect(plan.kind).toBe("invertible");
    expect(plan.steps[0]?.options?.dangerouslyPermanent).toBe(true);
    expect(plan.notes.join(" ")).toContain("PERMANENT");
  });

  it("a create whose uuid was never discovered is irreversible", () => {
    const plan = planUndo(record({ op: "todo.add", uuid: null }), NOW);
    expect(plan.kind).toBe("irreversible");
  });
});

describe("planUndo — status flips", () => {
  it("todo.complete with pre open → todo.reopen", () => {
    const plan = planUndo(record({ op: "todo.complete", pre: { status: "open" } }), NOW);
    expect(plan.steps).toEqual([{ op: "todo.reopen", params: { uuid: "U-1" } }]);
  });

  it("todo.reopen restores the exact pre status (canceled)", () => {
    const plan = planUndo(record({ op: "todo.reopen", pre: { status: "canceled" } }), NOW);
    expect(plan.steps[0]?.op).toBe("todo.cancel");
  });

  it("todo.complete on an already-resolved item is irreversible", () => {
    const plan = planUndo(record({ op: "todo.complete", pre: { status: "completed" } }), NOW);
    expect(plan.kind).toBe("irreversible");
  });
});

describe("planUndo — delete / restore", () => {
  it("todo.delete → todo.restore with the Inbox caveat", () => {
    const plan = planUndo(record({ op: "todo.delete", pre: { trashed: false } }), NOW);
    expect(plan.steps).toEqual([{ op: "todo.restore", params: { uuid: "U-1" } }]);
    expect(plan.notes.join(" ")).toContain("Inbox");
  });

  it("todo.restore → todo.delete", () => {
    const plan = planUndo(record({ op: "todo.restore" }), NOW);
    expect(plan.steps[0]?.op).toBe("todo.delete");
  });

  it("project.delete inverts to the in-place restore (P06)", () => {
    const plan = planUndo(record({ op: "project.delete" }), NOW);
    expect(plan.steps).toEqual([{ op: "project.restore", params: { uuid: "U-1" } }]);
    expect(plan.notes.join(" ")).toContain("IN PLACE");
  });
});

describe("planUndo — field updates", () => {
  it("restores title/notes/deadline from pre-values", () => {
    const plan = planUndo(
      record({
        op: "todo.update",
        requested: { title: "New", notes: "new body" },
        pre: { title: "Old", notes: "old body" },
      }),
      NOW,
    );
    expect(plan.steps).toEqual([
      { op: "todo.update", params: { uuid: "U-1", title: "Old", notes: "old body" } },
    ]);
  });

  it("re-schedule from the Inbox inverts to a move back to the Inbox", () => {
    const plan = planUndo(
      record({
        op: "todo.update",
        requested: { when: "today" },
        pre: { start: "inbox", startDate: null, todaySection: null, reminder: null },
      }),
      NOW,
    );
    expect(plan.steps).toEqual([{ op: "todo.move", params: { uuid: "U-1", inbox: true } }]);
  });

  it("re-schedule from a date restores when=<date> and the old reminder", () => {
    const plan = planUndo(
      record({
        op: "todo.update",
        requested: { when: "today" },
        pre: { start: "someday", startDate: "2026-07-09", todaySection: null, reminder: "15:00" },
      }),
      NOW,
    );
    expect(plan.steps).toEqual([
      { op: "todo.update", params: { uuid: "U-1", when: "2026-07-09", reminder: "15:00" } },
    ]);
  });

  it("a reminder set on today inverts to an explicit clear", () => {
    const plan = planUndo(
      record({
        op: "todo.update",
        requested: { when: "today", reminder: "10:00" },
        pre: { start: "active", startDate: "2026-07-05", todaySection: "today", reminder: null },
      }),
      NOW,
    );
    expect(plan.steps).toEqual([
      { op: "todo.update", params: { uuid: "U-1", when: "today", reminder: null } },
    ]);
  });

  it("a reminder set on a DATE cannot be cleared (sticky) — noted, not attempted", () => {
    const plan = planUndo(
      record({
        op: "todo.update",
        requested: { when: "2026-07-09", reminder: "10:00" },
        pre: { start: "someday", startDate: "2026-07-09", todaySection: null, reminder: null },
      }),
      NOW,
    );
    const step = plan.steps[0];
    expect(step?.params["when"]).toBe("2026-07-09");
    expect("reminder" in (step?.params ?? {})).toBe(false);
    expect(plan.notes.join(" ")).toContain("sticky");
  });

  it("today+evening membership restores as when=evening when the date is today", () => {
    const plan = planUndo(
      record({
        op: "todo.update",
        requested: { when: "someday" },
        pre: { start: "active", startDate: "2026-07-05", todaySection: "evening", reminder: null },
      }),
      NOW,
    );
    expect(plan.steps[0]?.params["when"]).toBe("evening");
  });
});

describe("planUndo — moves", () => {
  it("restores the previous project when it was captured", () => {
    const plan = planUndo(
      record({ op: "todo.move", requested: { project: {} }, pre: { "project.uuid": "P-OLD" } }),
      NOW,
    );
    expect(plan.steps).toEqual([
      { op: "todo.move", params: { uuid: "U-1", project: { uuid: "P-OLD" } } },
    ]);
  });

  it("area moves capture the old project as a Ref — restored from it", () => {
    const plan = planUndo(
      record({
        op: "todo.move",
        requested: { area: {} },
        pre: { "area.uuid": null, project: { uuid: "P-OLD", title: "Old" } },
      }),
      NOW,
    );
    expect(plan.steps[0]?.params["project"]).toEqual({ uuid: "P-OLD" });
  });

  it("an unknown prior container is irreversible, not guessed", () => {
    const plan = planUndo(
      record({ op: "todo.move", requested: { project: {} }, pre: { "project.uuid": null } }),
      NOW,
    );
    expect(plan.kind).toBe("irreversible");
  });

  it("project.move restores the old area; no-area-before inverts to a detach (P24)", () => {
    const back = planUndo(record({ op: "project.move", pre: { "area.uuid": "A-OLD" } }), NOW);
    expect(back.steps[0]).toEqual({
      op: "project.move",
      params: { uuid: "U-1", area: { uuid: "A-OLD" } },
    });
    const gone = planUndo(record({ op: "project.move", pre: { "area.uuid": null } }), NOW);
    expect(gone.steps[0]).toEqual({
      op: "project.move",
      params: { uuid: "U-1", detach: true },
    });
  });
});

describe("planUndo — tags, checklist, entities, reorder", () => {
  it("todo.set-tags restores the pre tag set", () => {
    const plan = planUndo(
      record({ op: "todo.set-tags", requested: { tags: ["b"] }, pre: { tags: ["a", "c"] } }),
      NOW,
    );
    expect(plan.steps[0]?.params["tags"]).toEqual(["a", "c"]);
  });

  it("wholesale checklist replacement restores titles AND states via the json form (P18)", () => {
    const plan = planUndo(
      record({
        op: "todo.replace-checklist",
        pre: { checklistTitles: ["x", "y"], checklistStates: ["completed", "open"] },
        observed: { checklistTitles: ["a"], checklistStates: ["open"] },
      }),
      NOW,
      [],
      currentTodo({ checklist: [{ title: "a", status: "open" }] } as Partial<AnyTask>),
    );
    expect(plan.steps[0]?.options?.acknowledgeChecklistReset).toBe(true);
    // per-item completion IS recoverable now (json form) — no stale caveat.
    expect(plan.notes.join(" ")).not.toContain("unrecoverable");
    expect(plan.steps[0]?.params["items"]).toEqual([
      { title: "x", completed: true },
      { title: "y", completed: false },
    ]);
  });

  it("legacy wholesale record (titles only) restores titles, states default open", () => {
    const plan = planUndo(
      record({ op: "todo.replace-checklist", pre: { checklistTitles: ["x", "y"] } }),
      NOW,
    );
    expect(plan.steps[0]?.options?.acknowledgeChecklistReset).toBe(true);
    expect(plan.steps[0]?.params["items"]).toEqual(["x", "y"]);
    expect(plan.notes.join(" ")).toContain("states restore as open");
  });

  it("tag.update that nested a root tag inverts via unnest (P29)", () => {
    const plan = planUndo(
      record({
        op: "tag.update",
        requested: { parent: "work" },
        pre: { parent: null, title: "deep" },
      }),
      NOW,
    );
    expect(plan.kind).toBe("invertible");
    expect(plan.steps[0]?.params["unnest"]).toBe(true);
    expect(plan.steps[0]?.params["title"]).toBe("deep");
  });

  it("native reorder inverts to the pre-rank sequence", () => {
    const plan = planUndo(
      record({
        op: "reorder",
        uuid: null,
        requested: { scope: "today", uuids: ["A", "B"] },
        pre: { A: 20, B: 10 },
      }),
      NOW,
    );
    expect(plan.steps[0]).toEqual({
      op: "reorder",
      params: { scope: "today", uuids: ["B", "A"] },
    });
  });

  it("bounce reorder summaries (no pre-ranks) are irreversible with guidance", () => {
    const plan = planUndo(
      record({ op: "reorder", uuid: null, requested: { scope: "evening", uuids: ["A"] } }),
      NOW,
    );
    expect(plan.kind).toBe("irreversible");
    expect(plan.reason).toContain("legs");
  });

  it("permanent ops are irreversible", () => {
    for (const op of ["area.delete", "tag.delete", "trash.empty"]) {
      expect(planUndo(record({ op }), NOW).kind).toBe("irreversible");
    }
  });
});

describe("planUndo — project lifecycle (Phase 19)", () => {
  it("project.complete inverts to reopen + reopening exactly the cascaded children", () => {
    const plan = planUndo(
      record({
        op: "project.complete",
        uuid: "P-1",
        // Nested pre map: the project row + two children; only C-OPEN was
        // open pre-write (i.e., cascade-resolved by the app).
        pre: {
          "P-1": { status: "open" },
          "C-OPEN": { status: "open" },
          "C-DONE": { status: "completed" },
        },
      }),
      NOW,
    );
    expect(plan.kind).toBe("invertible");
    expect(plan.steps).toEqual([
      { op: "project.reopen", params: { uuid: "P-1" } },
      { op: "todo.reopen", params: { uuid: "C-OPEN" } },
    ]);
  });

  it("project.complete with no cascade inverts to a bare reopen", () => {
    const plan = planUndo(
      record({ op: "project.complete", uuid: "P-2", pre: { status: "open" } }),
      NOW,
    );
    expect(plan.steps).toEqual([{ op: "project.reopen", params: { uuid: "P-2" } }]);
  });

  it("project.cancel inverts like complete", () => {
    const plan = planUndo(
      record({
        op: "project.cancel",
        uuid: "P-3",
        pre: { "P-3": { status: "open" }, "C-1": { status: "open" } },
      }),
      NOW,
    );
    expect(plan.steps.map((s) => s.op)).toEqual(["project.reopen", "todo.reopen"]);
  });

  it("project.reopen inverts to re-complete/re-cancel per the pre status", () => {
    const done = planUndo(
      record({ op: "project.reopen", uuid: "P-4", pre: { status: "completed" } }),
      NOW,
    );
    expect(done.steps[0]).toEqual({
      op: "project.complete",
      params: { uuid: "P-4", children: "require-resolved" },
    });
    const cxl = planUndo(
      record({ op: "project.reopen", uuid: "P-5", pre: { status: "canceled" } }),
      NOW,
    );
    expect(cxl.steps[0]?.op).toBe("project.cancel");
  });

  it("project.restore inverts to project.delete", () => {
    const plan = planUndo(record({ op: "project.restore", uuid: "P-6" }), NOW);
    expect(plan.steps).toEqual([{ op: "project.delete", params: { uuid: "P-6" } }]);
  });

  it("todo.move detach inverts to a move back to the captured container", () => {
    const plan = planUndo(
      record({
        op: "todo.move",
        requested: { detach: true },
        pre: {
          project: { uuid: "P-OLD", title: "Old" },
          area: null,
          heading: null,
          startDate: "2026-07-09",
        },
      }),
      NOW,
    );
    expect(plan.steps).toEqual([
      { op: "todo.move", params: { uuid: "U-1", project: { uuid: "P-OLD" } } },
    ]);
  });
});

describe("planUndo — clear-dated-reminder (targeted restore)", () => {
  const clearRecord = (partial: Partial<AuditRecord> = {}): AuditRecord =>
    record({
      op: "todo.clear-dated-reminder",
      uuid: "U-1",
      pre: { reminder: "09:30", startDate: "2026-07-20" },
      observed: { reminder: null, startDate: "2026-07-20" },
      ...partial,
    });

  it("re-attaches the captured reminder to the CURRENT concrete date", () => {
    const plan = planUndo(clearRecord(), NOW, [], currentTodo({ startDate: "2026-07-20" }));
    expect(plan.kind).toBe("invertible");
    expect(plan.steps).toEqual([
      { op: "todo.update", params: { uuid: "U-1", when: "2026-07-20", reminder: "09:30" } },
    ]);
  });

  it("re-attaches to the NEW date when the item moved out of band (no over-restore)", () => {
    const plan = planUndo(clearRecord(), NOW, [], currentTodo({ startDate: "2026-08-01" }));
    expect(plan.steps).toEqual([
      { op: "todo.update", params: { uuid: "U-1", when: "2026-08-01", reminder: "09:30" } },
    ]);
  });

  it("restores today/evening via the keyword when the current date is today", () => {
    const plan = planUndo(
      clearRecord(),
      NOW,
      [],
      currentTodo({ startDate: "2026-07-05", todaySection: "evening" }),
    );
    expect(plan.steps[0]?.params["when"]).toBe("evening");
  });

  it("is irreversible-at-plan-time once the item is de-scheduled", () => {
    const plan = planUndo(clearRecord(), NOW, [], currentTodo({ startDate: null }));
    expect(plan.kind).toBe("irreversible");
    expect(plan.reason).toContain("no longer scheduled");
  });

  it("is irreversible once the item is a repeating template", () => {
    const plan = planUndo(
      clearRecord(),
      NOW,
      [],
      currentTodo({
        startDate: "2026-07-20",
        repeating: { isTemplate: true, isInstance: false, templateUuid: null },
      }),
    );
    expect(plan.kind).toBe("irreversible");
    expect(plan.reason).toContain("repeating");
  });
});

describe("transactional undo (compound operations)", () => {
  it("legs are excluded from targeting; the summary is the single unit", () => {
    const records = [
      record({ op: "todo.move", uuid: "C1", txn: { id: "t1", role: "leg" } }),
      record({ op: "todo.move", uuid: "C2", txn: { id: "t1", role: "leg" } }),
      record({
        op: "heading.archive",
        uuid: "H1",
        txn: { id: "t1", role: "summary" },
        pre: { status: "open" },
      }),
    ];
    const targets = selectUndoTargets(records, 3);
    expect(targets.map((r) => r.op)).toEqual(["heading.archive"]);
  });

  it("heading.archive summary replays reparent-leg inverses in reverse order", () => {
    const legs = [
      record({
        op: "todo.move",
        uuid: "C1",
        txn: { id: "t1", role: "leg" },
        requested: { uuid: "C1", project: { uuid: "PROJ" } },
        pre: { "heading.uuid": "H1", "project.uuid": null, "area.uuid": null },
      }),
      record({
        op: "todo.move",
        uuid: "C2",
        txn: { id: "t1", role: "leg" },
        requested: { uuid: "C2", project: { uuid: "PROJ" } },
        pre: { "heading.uuid": "H1", "project.uuid": null, "area.uuid": null },
      }),
    ];
    const summary = record({
      op: "heading.archive",
      uuid: "H1",
      txn: { id: "t1", role: "summary" },
      pre: { status: "open", title: "Phase 1" },
    });
    const plan = planUndo(summary, NOW, [...legs, summary]);
    expect(plan.kind).toBe("invertible");
    if (plan.kind === "invertible") {
      expect(plan.steps[0]).toEqual({ op: "heading.unarchive", params: { uuid: "H1" } });
      // legs replay in reverse (C2 before C1), moving back UNDER the heading
      expect(plan.steps.slice(1)).toEqual([
        { op: "todo.move", params: { uuid: "C2", project: { uuid: "PROJ" }, heading: "Phase 1" } },
        { op: "todo.move", params: { uuid: "C1", project: { uuid: "PROJ" }, heading: "Phase 1" } },
      ]);
    }
  });

  it("heading.archive cascade capture reopens the children that were open", () => {
    const summary = record({
      op: "heading.archive",
      uuid: "H1",
      pre: {
        "C-open": { status: "open" },
        "C-done": { status: "completed" },
      },
    });
    const plan = planUndo(summary, NOW);
    expect(plan.kind).toBe("invertible");
    if (plan.kind === "invertible") {
      expect(plan.steps).toContainEqual({ op: "todo.reopen", params: { uuid: "C-open" } });
      expect(plan.steps.map((st) => (st.params as { uuid: string }).uuid)).not.toContain("C-done");
    }
  });

  it("bounce reorder summaries carry pre-ranks and invert to a single reorder", () => {
    const summary = record({
      op: "reorder",
      uuid: null,
      txn: { id: "t2", role: "summary" },
      requested: { scope: "projects", uuids: ["B", "A"] },
      pre: { A: -10, B: -5 },
    });
    const plan = planUndo(summary, NOW);
    expect(plan.kind).toBe("invertible");
    if (plan.kind === "invertible") {
      const first = plan.steps[0];
      expect(first?.op).toBe("reorder");
      expect((first?.params as { uuids: string[] } | undefined)?.uuids).toEqual(["A", "B"]);
    }
  });
});
