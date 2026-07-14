/**
 * Phase 14b engine tests: ops built from the Tier-2 verdicts — project move
 * between areas (E14), trash restore (E15), project duplication (E17), and
 * project notes modes (E18). Fake vectors simulate the validated semantics.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

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
  ui: { enabled: false },
  host: "test-host",
};

const URL_MATRIX: VectorMatrix = Object.fromEntries(
  ["project.update", "project.duplicate"].map((op) => [
    op,
    { support: "yes", disruption: 0, validation: "validated" },
  ]),
) as VectorMatrix;

const AS_MATRIX: VectorMatrix = Object.fromEntries(
  ["project.move", "todo.restore"].map((op) => [
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

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
}

function deps(vectors: WriteVector[]): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-t2-lock-${process.pid}-${lockSeq++}`),
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

describe("project.move (E14)", () => {
  it("compiles the area setter and verifies the new area link", async () => {
    const areaA = seedArea(fixture.db, "AreaA");
    const areaB = seedArea(fixture.db, "AreaB");
    const proj = seedProject(fixture.db, { title: "Mover", area: areaA });
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, () => {
      touch(proj, `area = '${areaB}'`);
    });
    const result = await runMutation(deps([vector]), "project.move", {
      uuid: proj,
      area: { title: "AreaB" },
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`set area of project id "${proj}" to area id "${areaB}"`);
    if (result.kind === "ok") expect(result.observed?.["area.uuid"]).toBe(areaB);
  });

  it("is blocked when the destination area is unknown", async () => {
    const proj = seedProject(fixture.db, { title: "Mover" });
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, null);
    const result = await runMutation(deps([vector]), "project.move", {
      uuid: proj,
      area: { title: "Nope" },
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-UNKNOWN-DESTINATION");
    expect(calls).toHaveLength(0);
  });

  it("is blocked when the target is a to-do, not a project", async () => {
    const areaB = seedArea(fixture.db, "AreaB");
    const todo = seedTodo(fixture.db, { title: "NotAProject" });
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, null);
    const result = await runMutation(deps([vector]), "project.move", {
      uuid: todo,
      area: { uuid: areaB },
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.hazard).toBe("H-UNKNOWN-DESTINATION");
      expect(result.detail).toContain("not a project");
    }
    expect(calls).toHaveLength(0);
  });

  it("is blocked on repeating projects (unvalidated)", async () => {
    const areaB = seedArea(fixture.db, "AreaB");
    const proj = seedProject(fixture.db, { title: "RepeatProj", recurrenceRule: true });
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, null);
    const result = await runMutation(deps([vector]), "project.move", {
      uuid: proj,
      area: { uuid: areaB },
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-REPEAT-SCHEDULE");
    expect(calls).toHaveLength(0);
  });
});

describe("todo.restore (E15)", () => {
  it("compiles move-to-Inbox and verifies the un-trash + de-schedule", async () => {
    const uuid = seedTodo(fixture.db, { title: "Trashed", trashed: true, startDate: "2026-07-01" });
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, () => {
      touch(uuid, "trashed = 0, start = 0, startDate = NULL");
    });
    const result = await runMutation(deps([vector]), "todo.restore", { uuid });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`move to do id "${uuid}" to list "Inbox"`);
    if (result.kind === "ok") {
      expect(result.observed?.["trashed"]).toBe(false);
      expect(result.observed?.["start"]).toBe("inbox");
    }
  });

  it("is blocked when the target is not in the Trash", async () => {
    const uuid = seedTodo(fixture.db, { title: "Live" });
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, null);
    const result = await runMutation(deps([vector]), "todo.restore", { uuid });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.hazard).toBe("H-UNKNOWN-DESTINATION");
      expect(result.detail).toContain("not in the Trash");
    }
    expect(calls).toHaveLength(0);
  });

  it("is blocked when the target is a trashed project (unprobed)", async () => {
    const proj = seedProject(fixture.db, { title: "TrashedProj", trashed: true });
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, null);
    const result = await runMutation(deps([vector]), "todo.restore", { uuid: proj });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.hazard).toBe("H-UNKNOWN-DESTINATION");
      expect(result.detail).toContain("only");
    }
    expect(calls).toHaveLength(0);
  });

  it("silent no-op is classified when the app does nothing", async () => {
    const uuid = seedTodo(fixture.db, { title: "Stuck", trashed: true });
    const { vector } = fakeVector("applescript", AS_MATRIX, null);
    const result = await runMutation(
      deps([vector]),
      "todo.restore",
      { uuid },
      { verifyTimeoutMs: 300 },
    );
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") expect(result.reason).toBe("silent-noop");
  });
});

describe("project.duplicate (E17)", () => {
  it("discovers the copy via the create probe and asserts fidelity", async () => {
    const proj = seedProject(fixture.db, {
      title: "Renovation",
      notes: "PLAN",
      creationDate: NOW_EPOCH - 500,
    });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      seedProject(fixture.db, {
        uuid: "PROJ-COPY-1",
        title: "Renovation",
        notes: "PLAN",
        creationDate: NOW_EPOCH,
      });
      seedTodo(fixture.db, {
        title: "child",
        project: "PROJ-COPY-1",
        creationDate: NOW_EPOCH,
      });
    });
    const result = await runMutation(deps([vector]), "project.duplicate", { uuid: proj });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.uuid).toBe("PROJ-COPY-1");
    expect(calls[0]).toContain("update-project?");
    expect(calls[0]).toContain("duplicate=true");
  });

  it("is blocked on repeating projects (unvalidated)", async () => {
    const proj = seedProject(fixture.db, { title: "RepeatProj", recurrenceRule: true });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(deps([vector]), "project.duplicate", { uuid: proj });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-REPEAT-SCHEDULE");
    expect(calls).toHaveLength(0);
  });

  it("is blocked when the target is a to-do", async () => {
    const todo = seedTodo(fixture.db, { title: "NotAProject" });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(deps([vector]), "project.duplicate", { uuid: todo });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("not a project");
    expect(calls).toHaveLength(0);
  });
});

describe("project notes modes (E18)", () => {
  it("appendNotes joins with newline against existing notes", async () => {
    const proj = seedProject(fixture.db, { title: "PN", notes: "PBASE" });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      touch(proj, "notes = 'PBASE' || char(10) || 'PTAIL'");
    });
    const result = await runMutation(deps([vector]), "project.update", {
      uuid: proj,
      appendNotes: "PTAIL",
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain("append-notes=PTAIL");
  });

  it("prependNotes joins with newline before existing notes", async () => {
    const proj = seedProject(fixture.db, { title: "PN2", notes: "PBASE" });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      touch(proj, "notes = 'PHEAD' || char(10) || 'PBASE'");
    });
    const result = await runMutation(deps([vector]), "project.update", {
      uuid: proj,
      prependNotes: "PHEAD",
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain("prepend-notes=PHEAD");
  });

  it("notes + appendNotes is a hard param conflict", async () => {
    const proj = seedProject(fixture.db, { title: "PN3" });
    const { vector } = fakeVector("url-scheme", URL_MATRIX, null);
    await expect(
      runMutation(deps([vector]), "project.update", { uuid: proj, notes: "A", appendNotes: "B" }),
    ).rejects.toThrow(/exclusive/);
  });
});
