/**
 * Mutation-pipeline engine tests: a FakeVector applies (or withholds) direct
 * writes against the fixture DB — fine here; the no-direct-writes rule
 * protects the real Things DB, not our fixtures. Exercises verification
 * classification, create-probe uuid discovery, audit records, and the
 * blocked/unsupported paths, deterministically.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { undoToken, type AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedProject, seedTag, seedTodo } from "../fixtures/seed.ts";

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

const FULL_MATRIX: VectorMatrix = Object.fromEntries(
  [
    "todo.add",
    "todo.update",
    "todo.complete",
    "todo.set-tags",
    "project.complete",
    "area.add",
    "tag.delete",
    "trash.empty",
  ].map((op) => [op, { support: "yes", disruption: 0, validation: "validated" }]),
) as VectorMatrix;

function fakeVector(
  effect: ((db: DatabaseSync) => void) | null,
  matrix: VectorMatrix = FULL_MATRIX,
  id: WriteVector["id"] = "url-scheme",
) {
  const calls: string[] = [];
  const vector: WriteVector = {
    id,
    matrix,
    async execute(invocation) {
      calls.push(invocation.payload);
      effect?.(fixture.db);
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

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "test-actor",
  auditEnabled: true,
  acceptedFingerprint: null,
  allowExperimental: false,
  host: "test-host",
};

function deps(vector: WriteVector, overrides: Partial<WriteDeps> = {}): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-test-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    ...overrides,
  };
}

describe("when-value validation", () => {
  it("rejects the raw URL @time grammar with the reminder-parameter pointer", async () => {
    const uuid = seedTodo(fixture.db, { title: "T" });
    const { vector, calls } = fakeVector(() => {});
    await expect(
      runMutation(deps(vector), "todo.update", { uuid, when: "2026-07-20@09:30" as never }),
    ).rejects.toThrow(/reminder time is a separate parameter/);
    await expect(
      runMutation(deps(vector), "todo.update", { uuid, when: "tomorrow" as never }),
    ).rejects.toThrow(/expected today \| evening \| anytime \| someday \| YYYY-MM-DD/);
    expect(calls).toHaveLength(0); // nothing was dispatched
  });
});

describe("verified mutations", () => {
  it("ok update: assertion satisfied, audit record written", async () => {
    const uuid = seedTodo(fixture.db, { title: "Old" });
    const { vector } = fakeVector((db) => {
      db.prepare("UPDATE TMTask SET title = 'New', userModificationDate = ? WHERE uuid = ?").run(
        NOW_EPOCH,
        uuid,
      );
    });
    const result = await runMutation(deps(vector), "todo.update", { uuid, title: "New" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.uuid).toBe(uuid);
      expect(result.observed).toEqual({ title: "New" });
    }
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({
      op: "todo.update",
      result: "ok",
      actor: "test-actor",
      pre: { title: "Old" },
      observed: { title: "New" },
    });
  });

  it("ok result carries an undoToken matching the audit record (additive)", async () => {
    const uuid = seedTodo(fixture.db, { title: "Old" });
    const { vector } = fakeVector((db) => {
      db.prepare("UPDATE TMTask SET title = 'New', userModificationDate = ? WHERE uuid = ?").run(
        NOW_EPOCH,
        uuid,
      );
    });
    const result = await runMutation(deps(vector), "todo.update", { uuid, title: "New" });
    expect(result.kind).toBe("ok");
    const rec = auditRecords[0];
    if (result.kind === "ok" && rec !== undefined) {
      expect(result.undoToken).toBeDefined();
      expect(result.undoToken).toBe(undoToken(rec)); // write path == read path
    }
  });

  it("ok create: probe discovers the new uuid", async () => {
    seedTodo(fixture.db, { title: "Fresh", creationDate: NOW_EPOCH - 500 }); // old row, same title
    const { vector } = fakeVector((db) => {
      seedTodo(db, { uuid: "NEW-1", title: "Fresh", creationDate: NOW_EPOCH, start: "inbox" });
    });
    const result = await runMutation(deps(vector), "todo.add", { title: "Fresh" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.uuid).toBe("NEW-1");
    expect(auditRecords[0]?.uuid).toBe("NEW-1");
  });

  it("project.complete verifies the child cascade (T08 semantics)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const open = seedTodo(fixture.db, { title: "open", project: proj });
    const canceled = seedTodo(fixture.db, { title: "canc", project: proj, status: "canceled" });
    const { vector } = fakeVector((db) => {
      db.prepare("UPDATE TMTask SET status = 3, userModificationDate = ? WHERE uuid IN (?, ?)").run(
        NOW_EPOCH,
        proj,
        open,
      );
    });
    const result = await runMutation(deps(vector), "project.complete", {
      uuid: proj,
      children: "auto-complete",
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.observed?.[`${open}.status`]).toBe("completed");
      expect(result.observed?.[`${canceled}.status`]).toBe("canceled");
    }
  });

  it("entity-created: area.add discovers the new TMArea row", async () => {
    const { vector } = fakeVector(
      (db) => {
        db.prepare(
          "INSERT INTO TMArea (uuid, title, visible, \"index\") VALUES ('AREA-9', 'Work', 1, 0)",
        ).run();
      },
      FULL_MATRIX,
      "applescript",
    );
    const result = await runMutation(deps(vector), "area.add", { title: "Work" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.uuid).toBe("AREA-9");
  });
});

describe("verification failure classification", () => {
  it("silent-noop: transport ok, nothing moved", async () => {
    const uuid = seedTodo(fixture.db, { title: "Old" });
    const { vector } = fakeVector(null);
    const result = await runMutation(
      deps(vector),
      "todo.update",
      { uuid, title: "New" },
      { verifyTimeoutMs: 250 },
    );
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") expect(result.reason).toBe("silent-noop");
    expect(auditRecords[0]?.result).toBe("verify-failed:silent-noop");
  });

  it("timeout: tripwire moved but asserted fields did not", async () => {
    const uuid = seedTodo(fixture.db, { title: "Old" });
    const { vector } = fakeVector((db) => {
      db.prepare("UPDATE TMTask SET userModificationDate = ? WHERE uuid = ?").run(
        NOW_EPOCH + 9,
        uuid,
      );
    });
    const result = await runMutation(
      deps(vector),
      "todo.update",
      { uuid, title: "New" },
      { verifyTimeoutMs: 250 },
    );
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") expect(result.reason).toBe("timeout");
  });

  it("mismatch: asserted field moved to a contradictory value", async () => {
    const uuid = seedTodo(fixture.db, { title: "Old" });
    const { vector } = fakeVector((db) => {
      db.prepare("UPDATE TMTask SET title = 'Wrong', userModificationDate = ? WHERE uuid = ?").run(
        NOW_EPOCH,
        uuid,
      );
    });
    const result = await runMutation(
      deps(vector),
      "todo.update",
      { uuid, title: "New" },
      { verifyTimeoutMs: 250 },
    );
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") expect(result.reason).toBe("mismatch");
  });

  it("transport failure surfaces as verify-failed with the stderr detail", async () => {
    const uuid = seedTodo(fixture.db, { title: "Old" });
    const vector: WriteVector = {
      id: "url-scheme",
      matrix: FULL_MATRIX,
      async execute() {
        return { exitCode: 1, stdout: "", stderr: "osascript boom" };
      },
    };
    const result = await runMutation(deps(vector), "todo.update", { uuid, title: "New" });
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") expect(result.detail).toContain("osascript boom");
  });
});

describe("blocked / unsupported paths", () => {
  it("hazard block: never executes, audited as blocked", async () => {
    const { vector, calls } = fakeVector(null);
    const result = await runMutation(deps(vector), "trash.empty", {});
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-PERMANENT-DELETE");
    expect(calls).toHaveLength(0);
    expect(auditRecords[0]?.result).toBe("blocked:H-PERMANENT-DELETE");
  });

  it("drift block: writes refuse before anything else", async () => {
    const { vector, calls } = fakeVector(null);
    const drifted: FingerprintStatus = {
      kind: "drift",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:other" },
      expected: "sha256:test",
      detail: [],
    };
    const uuid = seedTodo(fixture.db, { title: "x" });
    const result = await runMutation(deps(vector, { fingerprint: () => drifted }), "todo.update", {
      uuid,
      title: "y",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.reason).toBe("drift");
    expect(calls).toHaveLength(0);
  });

  it("tier block: closed app raises the effective tier past the policy", async () => {
    const uuid = seedTodo(fixture.db, { title: "x" });
    const { vector } = fakeVector(null);
    const result = await runMutation(
      deps(vector, { isAppRunning: () => false }),
      "todo.update",
      { uuid, title: "y" },
      { maxDisruption: 0 },
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.reason).toBe("disruption-tier");
  });

  it("unsupported: no validated vector for the operation", async () => {
    const uuid = seedTodo(fixture.db, { title: "x" });
    const { vector } = fakeVector(null, {
      "todo.update": { support: "yes", disruption: 0, validation: "assumed" },
    });
    const result = await runMutation(deps(vector), "todo.update", { uuid, title: "y" });
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.considered[0]?.why).toContain("assumed");
    }
  });

  it("dry-run returns the redacted plan and never executes or audits", async () => {
    seedTag(fixture.db, "doomed");
    const { vector, calls } = fakeVector(null, FULL_MATRIX, "applescript");
    const result = await runMutation(
      deps(vector),
      "tag.delete",
      { target: "doomed" },
      { dryRun: true, dangerouslyPermanent: true },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.plan.vector).toBe("applescript");
      expect(result.plan.expectedDelta.mode).toBe("gone");
    }
    expect(calls).toHaveLength(0);
    expect(auditRecords).toHaveLength(0);
  });
});
