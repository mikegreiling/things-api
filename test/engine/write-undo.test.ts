/**
 * Phase 15 engine tests: runUndo end-to-end — audit-trail selection, inverse
 * execution through the real pipeline (fake vectors), the permanent-delete
 * gate, dry-run, and unwind-stop-on-failure.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { undoToken, type AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import { runUndo } from "../../src/write/undo.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

let fixture: FixtureDb;
let auditDir: string;
let auditRecords: AuditRecord[];
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditDir = mkdtempSync(join(tmpdir(), "things-api-undo-audit-"));
  auditRecords = [];
});
afterEach(() => {
  fixture.close();
  rmSync(auditDir, { recursive: true, force: true });
});

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "mike",
  auditEnabled: true,
  acceptedFingerprint: null,
  allowExperimental: false,
  host: "test-host",
};

function auditRecord(partial: Partial<AuditRecord>): AuditRecord {
  return {
    v: 1,
    ts: "2026-07-05T10:00:00.000Z",
    actor: "mike",
    host: "test-host",
    op: "todo.update",
    uuid: null,
    vector: "url-scheme",
    disruption: 0,
    invocation: "x",
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

function writeAudit(records: AuditRecord[]): void {
  writeFileSync(join(auditDir, "2026-07.jsonl"), records.map((r) => JSON.stringify(r)).join("\n"));
}

const MATRIX: VectorMatrix = Object.fromEntries(
  ["todo.reopen", "todo.complete", "todo.restore", "todo.delete", "area.delete"].map((op) => [
    op,
    { support: "yes", disruption: 0, validation: "validated" },
  ]),
) as VectorMatrix;

function fakeVector(effect: ((payload: string) => void) | null) {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "applescript",
    matrix: MATRIX,
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
    lockPath: join(tmpdir(), `things-api-undo-lock-${process.pid}-${lockSeq++}`),
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

describe("runUndo", () => {
  it("undoes a completion: reopen executed, verified, audited as undo:<actor>", async () => {
    const uuid = seedTodo(fixture.db, { title: "Done", status: "completed" });
    writeAudit([auditRecord({ op: "todo.complete", uuid, pre: { status: "open" } })]);
    const { vector, calls } = fakeVector(() => touch(uuid, "status = 0"));

    const items = await runUndo(deps([vector]), auditDir);
    expect(items).toHaveLength(1);
    expect(items[0]?.outcome).toBe("ok");
    expect(calls[0]).toContain(`set status of to do id "${uuid}" to open`);
    expect(auditRecords[0]?.actor).toBe("undo:mike");
    expect(auditRecords[0]?.op).toBe("todo.reopen");
  });

  it("undoes a delete via todo.restore (the Phase-14 primitive)", async () => {
    const uuid = seedTodo(fixture.db, { title: "Trashed", trashed: true });
    writeAudit([auditRecord({ op: "todo.delete", uuid, pre: { trashed: false } })]);
    const { vector, calls } = fakeVector(() => touch(uuid, "trashed = 0, start = 0"));

    const items = await runUndo(deps([vector]), auditDir);
    expect(items[0]?.outcome).toBe("ok");
    expect(items[0]?.plan.notes.join(" ")).toContain("Inbox");
    expect(calls[0]).toContain(`move to do id "${uuid}" to list "Inbox"`);
  });

  it("dry-run returns plans without executing anything", async () => {
    const uuid = seedTodo(fixture.db, { title: "Done", status: "completed" });
    writeAudit([auditRecord({ op: "todo.complete", uuid, pre: { status: "open" } })]);
    const { vector, calls } = fakeVector(null);

    const items = await runUndo(deps([vector]), auditDir, { dryRun: true });
    expect(items[0]?.outcome).toBe("dry-run");
    expect(items[0]?.plan.steps[0]?.op).toBe("todo.reopen");
    expect(calls).toHaveLength(0);
    expect(auditRecords).toHaveLength(0);
  });

  it("gates permanent inverses behind dangerouslyPermanent", async () => {
    const areaUuid = seedArea(fixture.db, "Created");
    writeAudit([auditRecord({ op: "area.add", uuid: areaUuid })]);
    const { vector, calls } = fakeVector(null);

    const blocked = await runUndo(deps([vector]), auditDir);
    expect(blocked[0]?.outcome).toBe("failed");
    const result = blocked[0]?.results[0];
    expect(result?.kind).toBe("blocked");
    if (result?.kind === "blocked") expect(result.hazard).toBe("H-PERMANENT-DELETE");
    expect(calls).toHaveLength(0);

    const { vector: v2, calls: c2 } = fakeVector(() => {
      fixture.db.prepare("DELETE FROM TMArea WHERE uuid = ?").run(areaUuid);
    });
    const allowed = await runUndo(deps([v2]), auditDir, { dangerouslyPermanent: true });
    expect(allowed[0]?.outcome).toBe("ok");
    expect(c2[0]).toContain(`delete area id "${areaUuid}"`);
  });

  it("reports irreversible targets without touching the app", async () => {
    writeAudit([auditRecord({ op: "trash.empty", uuid: null })]);
    const { vector, calls } = fakeVector(null);
    const items = await runUndo(deps([vector]), auditDir);
    expect(items[0]?.outcome).toBe("irreversible");
    expect(calls).toHaveLength(0);
  });

  it("unwinds newest-first and STOPS after a failed inverse", async () => {
    const a = seedTodo(fixture.db, { title: "A", status: "completed" });
    const b = seedTodo(fixture.db, { title: "B", status: "completed" });
    writeAudit([
      auditRecord({
        ts: "2026-07-05T09:00:00Z",
        op: "todo.complete",
        uuid: a,
        pre: { status: "open" },
      }),
      auditRecord({
        ts: "2026-07-05T09:30:00Z",
        op: "todo.complete",
        uuid: b,
        pre: { status: "open" },
      }),
    ]);
    // The vector does nothing → the first (newest, B) inverse verify-fails.
    const { vector } = fakeVector(null);
    const items = await runUndo(deps([vector]), auditDir, { verifyTimeoutMs: 300, last: 2 });
    expect(items).toHaveLength(1); // stopped before touching A
    expect(items[0]?.plan.target.uuid).toBe(b);
    expect(items[0]?.outcome).toBe("failed");
  });

  it("never selects undo-generated records as targets", async () => {
    const uuid = seedTodo(fixture.db, { title: "Done", status: "completed" });
    writeAudit([
      auditRecord({
        ts: "2026-07-05T09:00:00Z",
        op: "todo.complete",
        uuid,
        pre: { status: "open" },
      }),
      auditRecord({
        ts: "2026-07-05T09:30:00Z",
        op: "todo.reopen",
        uuid,
        actor: "undo:mike",
        pre: { status: "completed" },
      }),
    ]);
    const { vector } = fakeVector(() => touch(uuid, "status = 0"));
    const items = await runUndo(deps([vector]), auditDir);
    expect(items[0]?.plan.target.op).toBe("todo.complete");
  });

  it("by:'mcp' undoes the mcp record even when a human record is newer", async () => {
    const mcpTodo = seedTodo(fixture.db, { title: "Agent", status: "completed" });
    const humanTodo = seedTodo(fixture.db, { title: "Human", status: "completed" });
    writeAudit([
      auditRecord({
        ts: "2026-07-05T09:00:00Z",
        op: "todo.complete",
        uuid: mcpTodo,
        actor: "mcp",
        pre: { status: "open" },
      }),
      auditRecord({
        ts: "2026-07-05T09:30:00Z", // NEWER, but a human's
        op: "todo.complete",
        uuid: humanTodo,
        actor: "mike",
        pre: { status: "open" },
      }),
    ]);
    const { vector } = fakeVector(() => touch(mcpTodo, "status = 0"));
    const items = await runUndo(deps([vector]), auditDir, { by: "mcp" });
    expect(items).toHaveLength(1);
    expect(items[0]?.plan.target.uuid).toBe(mcpTodo);
    expect(items[0]?.outcome).toBe("ok");
  });

  it("undoes exactly one record by --txn token, and back-references it as undoOf", async () => {
    const uuid = seedTodo(fixture.db, { title: "Done", status: "completed" });
    const rec = auditRecord({ op: "todo.complete", uuid, actor: "mcp", pre: { status: "open" } });
    writeAudit([rec]);
    const token = undoToken(rec);
    const { vector } = fakeVector(() => touch(uuid, "status = 0"));

    const items = await runUndo(deps([vector]), auditDir, { txn: token });
    expect(items).toHaveLength(1);
    expect(items[0]?.plan.target.token).toBe(token);
    expect(items[0]?.outcome).toBe("ok");
    // The inverse mutation's own ok result carries a token, and the audit
    // record back-references the mutation it reversed.
    const inverse = items[0]?.results[0];
    expect(inverse?.kind).toBe("ok");
    expect(auditRecords[0]?.undoOf).toBe(token);
  });

  it("--txn for an unknown token is a loud usage error (RangeError)", async () => {
    const uuid = seedTodo(fixture.db, { title: "Done", status: "completed" });
    writeAudit([auditRecord({ op: "todo.complete", uuid, pre: { status: "open" } })]);
    const { vector } = fakeVector(null);
    await expect(runUndo(deps([vector]), auditDir, { txn: "m-nope" })).rejects.toThrow(
      /no undoable mutation has undo token/,
    );
  });

  it("--txn for an already-undone mutation reports it specifically", async () => {
    const uuid = seedTodo(fixture.db, { title: "Done", status: "open" });
    const rec = auditRecord({ op: "todo.complete", uuid, pre: { status: "open" } });
    const token = undoToken(rec);
    writeAudit([
      rec,
      // a prior inverse for the same token is on the trail
      auditRecord({
        ts: "2026-07-05T11:00:00Z",
        op: "todo.reopen",
        uuid,
        actor: "undo:mike",
        undoOf: token,
        pre: { status: "completed" },
      }),
    ]);
    const { vector } = fakeVector(null);
    await expect(runUndo(deps([vector]), auditDir, { txn: token })).rejects.toThrow(
      /has already been undone/,
    );
  });
});
