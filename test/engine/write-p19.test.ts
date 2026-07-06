/**
 * Phase 19 engine tests: ops from the P-suite verdicts — project cancel/
 * reopen/restore, one-step container detach, stateful checklist replacement
 * over things:///json, the tag-subtree hazard, and the reopen composite's
 * cascade-window heuristic.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import { runProjectReopen } from "../../src/write/reopen.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedChecklistItem, seedProject, seedTag, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
});
afterEach(() => {
  fixture.close();
});

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "test-actor",
  auditEnabled: true,
  acceptedFingerprint: null,
  allowExperimental: false,
  host: "test-host",
};

const URL_MATRIX: VectorMatrix = Object.fromEntries(
  [
    "project.cancel",
    "project.reopen",
    "project.move",
    "todo.move",
    "todo.replace-checklist",
    "todo.reopen",
  ].map((op) => [op, { support: "yes", disruption: 0, validation: "validated" }]),
) as VectorMatrix;

const AS_MATRIX: VectorMatrix = Object.fromEntries(
  ["project.restore", "tag.delete"].map((op) => [
    op,
    { support: "yes", disruption: 0, validation: "validated" },
  ]),
) as VectorMatrix;

function fakeVector(
  id: WriteVector["id"],
  matrix: VectorMatrix,
  effect: ((payload: string) => void) | null,
) {
  const calls: string[] = [];
  const vector: WriteVector = {
    id,
    matrix,
    async execute(invocation) {
      calls.push(invocation.payload);
      effect?.(invocation.payload);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

function deps(vectors: WriteVector[]): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-p19-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
  };
}

function touch(uuid: string, sets: string): void {
  fixture.db
    .prepare(`UPDATE TMTask SET ${sets}, userModificationDate = ? WHERE uuid = ?`)
    .run(NOW_EPOCH + 1, uuid);
}

describe("project.cancel (P01)", () => {
  it("compiles canceled=true and verifies the cascade (open->canceled, completed untouched)", async () => {
    const proj = seedProject(fixture.db, { title: "CXL" });
    const open = seedTodo(fixture.db, { title: "open child", project: proj });
    const done = seedTodo(fixture.db, { title: "done child", project: proj, status: "completed" });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      touch(proj, "status = 2");
      touch(open, "status = 2");
    });
    const result = await runMutation(deps([vector]), "project.cancel", {
      uuid: proj,
      children: "auto-cancel",
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`update-project?id=${proj}&canceled=true`);
    if (result.kind === "ok") {
      expect(result.observed?.[`${open}.status`]).toBe("canceled");
      expect(result.observed?.[`${done}.status`]).toBe("completed");
    }
  });

  it("requires the children policy when open children exist", async () => {
    const proj = seedProject(fixture.db, { title: "CXL2" });
    seedTodo(fixture.db, { title: "child", project: proj });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(deps([vector]), "project.cancel", {
      uuid: proj,
      children: "require-resolved",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-PROJECT-COMPLETE-CHILDREN");
    expect(calls).toHaveLength(0);
  });

  it("is blocked on an already-resolved project (only open->canceled probed)", async () => {
    const proj = seedProject(fixture.db, { title: "CXL3", status: "completed" });
    const { vector } = fakeVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(deps([vector]), "project.cancel", {
      uuid: proj,
      children: "auto-cancel",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("already completed");
  });
});

describe("project.reopen (P02/P05)", () => {
  it("compiles completed=false for a completed project and verifies", async () => {
    const proj = seedProject(fixture.db, { title: "RO", status: "completed" });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => touch(proj, "status = 0"));
    const result = await runMutation(deps([vector]), "project.reopen", { uuid: proj });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`update-project?id=${proj}&completed=false`);
  });

  it("compiles canceled=false for a canceled project", async () => {
    const proj = seedProject(fixture.db, { title: "RO2", status: "canceled" });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => touch(proj, "status = 0"));
    const result = await runMutation(deps([vector]), "project.reopen", { uuid: proj });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`update-project?id=${proj}&canceled=false`);
  });

  it("is blocked when the project is already open", async () => {
    const proj = seedProject(fixture.db, { title: "RO3" });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(deps([vector]), "project.reopen", { uuid: proj });
    expect(result.kind).toBe("blocked");
    expect(calls).toHaveLength(0);
  });
});

describe("runProjectReopen composite (P03 cascade window)", () => {
  it("reopens ONLY children stamped within the cascade window", async () => {
    const projStop = NOW_EPOCH - 100;
    const proj = seedProject(fixture.db, { title: "ROC", status: "completed", stopDate: projStop });
    const cascaded = seedTodo(fixture.db, {
      title: "cascaded",
      project: proj,
      status: "completed",
      stopDate: projStop + 1,
    });
    const finishedEarlier = seedTodo(fixture.db, {
      title: "earlier",
      project: proj,
      status: "completed",
      stopDate: projStop - 5000,
    });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, (payload) => {
      const id = /id=([^&]+)/.exec(payload)?.[1] ?? "";
      touch(decodeURIComponent(id), "status = 0");
    });
    const outcome = await runProjectReopen(deps([vector]), proj, { restoreChildren: true });
    expect(outcome.project.kind).toBe("ok");
    expect(outcome.children.map((c) => c.uuid)).toEqual([cascaded]);
    expect(outcome.children[0]?.result.kind).toBe("ok");
    // The pre-resolved child was never touched (P04 semantics).
    expect(calls.some((c) => c.includes(finishedEarlier))).toBe(false);
  });

  it("without restoreChildren touches only the project row", async () => {
    const proj = seedProject(fixture.db, {
      title: "ROC2",
      status: "completed",
      stopDate: NOW_EPOCH - 10,
    });
    seedTodo(fixture.db, {
      title: "cascaded",
      project: proj,
      status: "completed",
      stopDate: NOW_EPOCH - 9,
    });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => touch(proj, "status = 0"));
    const outcome = await runProjectReopen(deps([vector]), proj);
    expect(outcome.project.kind).toBe("ok");
    expect(outcome.children).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("project.restore (P06)", () => {
  it("compiles the Anytime list-move and verifies the in-place un-trash", async () => {
    const proj = seedProject(fixture.db, { title: "PRS", trashed: true });
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, () =>
      touch(proj, "trashed = 0"),
    );
    const result = await runMutation(deps([vector]), "project.restore", { uuid: proj });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`move project id "${proj}" to list "Anytime"`);
  });

  it("is blocked on a non-trashed project (the same statement would silently no-op, P09)", async () => {
    const proj = seedProject(fixture.db, { title: "PRS2" });
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, null);
    const result = await runMutation(deps([vector]), "project.restore", { uuid: proj });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("not in the Trash");
    expect(calls).toHaveLength(0);
  });
});

describe("container detach (P21/P22/P24)", () => {
  it("todo.move detach compiles the empty list-id and pins the schedule", async () => {
    const area = seedArea(fixture.db, "Zone");
    const uuid = seedTodo(fixture.db, {
      title: "DT",
      area,
      startDate: "2026-07-09",
      start: "someday",
    });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      touch(uuid, "area = NULL");
    });
    const result = await runMutation(deps([vector]), "todo.move", { uuid, detach: true });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toMatch(new RegExp(`update\\?id=${uuid}&list-id=$`));
    if (result.kind === "ok") expect(result.observed?.["startDate"]).toBe("2026-07-09");
  });

  it("a detach that silently de-scheduled would FAIL verification", async () => {
    const uuid = seedTodo(fixture.db, { title: "DT2", startDate: "2026-07-09", start: "someday" });
    const { vector } = fakeVector("url-scheme", URL_MATRIX, () => {
      touch(uuid, "startDate = NULL"); // hostile app: clears the schedule too
    });
    const result = await runMutation(
      deps([vector]),
      "todo.move",
      { uuid, detach: true },
      { verifyTimeoutMs: 300 },
    );
    expect(result.kind).toBe("verify-failed");
  });

  it("project.move detach compiles the empty area-id", async () => {
    const area = seedArea(fixture.db, "Zone");
    const proj = seedProject(fixture.db, { title: "PDT", area });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () =>
      touch(proj, "area = NULL"),
    );
    const result = await runMutation(deps([vector]), "project.move", { uuid: proj, detach: true });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toMatch(new RegExp(`update-project\\?id=${proj}&area-id=$`));
  });

  it("detach and destination are mutually exclusive", async () => {
    const uuid = seedTodo(fixture.db, { title: "DT3" });
    const { vector } = fakeVector("url-scheme", URL_MATRIX, null);
    await expect(
      runMutation(deps([vector]), "todo.move", {
        uuid,
        detach: true,
        area: { title: "X" },
      }),
    ).rejects.toThrow(/exclusive/);
  });
});

describe("stateful checklist replacement (P18)", () => {
  it("plain-string items keep the classic checklist-items= form", async () => {
    const uuid = seedTodo(fixture.db, { title: "CL1" });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      seedChecklistItem(fixture.db, uuid, "A", { index: 0 });
      touch(uuid, "title = title");
    });
    const result = await runMutation(deps([vector]), "todo.replace-checklist", {
      uuid,
      items: ["A"],
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain("checklist-items=A");
    expect(calls[0]).not.toContain("json");
  });

  it("stateful items compile the things:///json payload and verify per-item states", async () => {
    const uuid = seedTodo(fixture.db, { title: "CL2" });
    seedChecklistItem(fixture.db, uuid, "One", { index: 0 });
    seedChecklistItem(fixture.db, uuid, "Two", { index: 1 });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      fixture.db.prepare("DELETE FROM TMChecklistItem WHERE task = ?").run(uuid);
      seedChecklistItem(fixture.db, uuid, "One", { status: "completed", index: 0 });
      seedChecklistItem(fixture.db, uuid, "Two", { index: 1 });
      touch(uuid, "title = title");
    });
    const result = await runMutation(
      deps([vector]),
      "todo.replace-checklist",
      {
        uuid,
        items: [
          { title: "One", completed: true },
          { title: "Two", completed: false },
        ],
      },
      { acknowledgeChecklistReset: true },
    );
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain("things:///json?data=");
    expect(decodeURIComponent(calls[0] ?? "")).toContain('"completed":true');
    if (result.kind === "ok") {
      expect(result.observed?.["checklistStates"]).toEqual(["completed", "open"]);
    }
  });
});

describe("H-TAG-SUBTREE-DELETE (P16)", () => {
  it("blocks deleting a tag with descendants and lists them", async () => {
    const parent = seedTag(fixture.db, "parent");
    seedTag(fixture.db, "child-a", parent);
    const grand = seedTag(fixture.db, "child-b", parent);
    seedTag(fixture.db, "grandchild", grand);
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, null);
    const result = await runMutation(
      deps([vector]),
      "tag.delete",
      { target: "parent" },
      { dangerouslyPermanent: true },
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.hazard).toBe("H-TAG-SUBTREE-DELETE");
      expect(result.detail).toContain("grandchild");
    }
    expect(calls).toHaveLength(0);
  });

  it("proceeds with the subtree acknowledgement (and still needs the permanent ack)", async () => {
    const parent = seedTag(fixture.db, "parent");
    seedTag(fixture.db, "child", parent);
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, () => {
      fixture.db.prepare("DELETE FROM TMTag WHERE uuid = ? OR parent = ?").run(parent, parent);
    });
    const result = await runMutation(
      deps([vector]),
      "tag.delete",
      { target: "parent" },
      { dangerouslyPermanent: true, acknowledgeTagSubtree: true },
    );
    expect(result.kind).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("leaf tags delete without the subtree ack", async () => {
    const leaf = seedTag(fixture.db, "leaf");
    const { vector } = fakeVector("applescript", AS_MATRIX, () => {
      fixture.db.prepare("DELETE FROM TMTag WHERE uuid = ?").run(leaf);
    });
    const result = await runMutation(
      deps([vector]),
      "tag.delete",
      { target: "leaf" },
      { dangerouslyPermanent: true },
    );
    expect(result.kind).toBe("ok");
  });
});
