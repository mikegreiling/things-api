/**
 * Idempotency phase 2 — reconciling a resubmission against a TIMED-OUT original.
 *
 * The ambiguous case: the write was dispatched and never confirmed, so what
 * landed is unknown. The timeout record carries the assertion the attempt was
 * verifying, and THAT is the presence oracle — re-evaluated against current
 * state it decides replay vs execute, and when it cannot decide the resubmission
 * is refused rather than guessed.
 *
 * Driven through the FULL pipeline: a "stall" vector that touches the row
 * without applying the change produces a REAL `verify-failed:timeout` record
 * (something moved, the asserted field did not), and the simulator vector then
 * runs the resubmission for real.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuditWriter } from "../../src/audit/log.ts";
import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runBatch } from "../../src/write/batch.ts";
import type { OperationKind, OperationParamsMap } from "../../src/write/operations.ts";
import { RECONCILED_NOTE, replayIfApplied } from "../../src/write/opid.ts";
import {
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "../../src/write/pipeline.ts";
import { readAuditRecords } from "../../src/write/undo.ts";
import { createSimulatorVector } from "../../src/write/vectors/simulator.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let auditDirPath: string;
let lockSeq = 0;
let savedEnv: Record<string, string | undefined>;

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "reconcile-actor",
  auditEnabled: true,
  acceptedFingerprint: null,
  certifiedAppVersion: null,
  allowExperimental: false,
  bounceEnabled: true,
  bounceMaxItems: 30,
  autoLaunch: true,
  helpersMode: "false",
  ui: { enabled: false },
  host: "test-host",
};

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
}

function deps(vector: WriteVector): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: CONFIG,
    audit: createAuditWriter({ dir: auditDirPath, secrets: [], enabled: true }),
    auditDirPath,
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-reconcile-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
  };
}

const UPDATE_MATRIX: VectorMatrix = {
  "todo.update": { support: "yes", disruption: 0, validation: "validated" },
  "todo.complete": { support: "yes", disruption: 0, validation: "validated" },
};

/**
 * A dispatch that TOUCHES the row (its modification date moves) without applying
 * the requested change — the pipeline's own definition of a timeout: something
 * happened, the expected state never appeared.
 */
function stallVector(target: () => string): WriteVector {
  return {
    id: "url-scheme",
    matrix: UPDATE_MATRIX,
    async execute() {
      fixture.db
        .prepare("UPDATE TMTask SET userModificationDate = 1780000999 WHERE uuid = ?")
        .run(target());
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

/** The single-op gate exactly as the client's `run` applies it, then the write. */
async function runSingle<K extends OperationKind>(
  d: WriteDeps,
  op: K,
  params: OperationParamsMap[K],
  options: WriteOptions,
): Promise<MutationResult> {
  const replay = replayIfApplied(d, options);
  if (replay !== null) return replay;
  return runMutation(d, op, params, options);
}

/** Append a record straight to the trail (for the shapes the pipeline cannot reach). */
function appendRecord(over: Partial<AuditRecord> & { opId: string }): void {
  const writer = createAuditWriter({ dir: auditDirPath, secrets: [], enabled: true });
  writer.append({
    v: 1,
    ts: NOW.toISOString(),
    actor: CONFIG.actor,
    host: CONFIG.host,
    op: "trash.empty",
    uuid: null,
    vector: "applescript",
    disruption: 1,
    invocation: "trash.empty",
    requested: {},
    pre: null,
    observed: null,
    result: "verify-failed:timeout",
    verify: null,
    durationMs: 1,
    env: { pkg: "test", dbVersion: 26, fingerprint: "ok" },
    ...over,
  });
}

const titleOf = (uuid: string): string | null =>
  (fixture.db.prepare("SELECT title FROM TMTask WHERE uuid = ?").get(uuid) as { title: string })
    .title;

const timedOutRecords = (): AuditRecord[] =>
  readAuditRecords(auditDirPath).filter((r) => r.result === "verify-failed:timeout");

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  fixture = buildFixtureDb({ benchMarker: true });
  auditDirPath = mkdtempSync(join(tmpdir(), "reconcile-audit-"));
  savedEnv = {
    sim: process.env["THINGS_SIM_WRITES"],
    db: process.env["THINGS_DB"],
    state: process.env["THINGS_API_STATE_DIR"],
    config: process.env["THINGS_API_CONFIG_DIR"],
  };
  process.env["THINGS_SIM_WRITES"] = "1";
  process.env["THINGS_DB"] = fixture.path;
  process.env["THINGS_API_STATE_DIR"] = mkdtempSync(join(tmpdir(), "reconcile-state-"));
  process.env["THINGS_API_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "reconcile-config-"));
});
afterEach(() => {
  restore("THINGS_SIM_WRITES", savedEnv["sim"]);
  restore("THINGS_DB", savedEnv["db"]);
  restore("THINGS_API_STATE_DIR", savedEnv["state"]);
  restore("THINGS_API_CONFIG_DIR", savedEnv["config"]);
  fixture.close();
});

/** Dispatch a rename that stalls: the row is touched, the title never changes. */
async function stalledRename(uuid: string, title: string): Promise<MutationResult> {
  return runSingle(
    deps(stallVector(() => uuid)),
    "todo.update",
    { uuid, title },
    { opId: "rename-it", verifyTimeoutMs: 0 },
  );
}

describe("a timed-out attempt records what it was waiting to see", () => {
  it("the timeout record carries the assertion, so a later submission has an oracle", async () => {
    const uuid = seedTodo(fixture.db, { title: "before" });
    const result = await stalledRename(uuid, "after");

    expect(result.kind).toBe("verify-failed");
    expect(result.kind === "verify-failed" && result.reason).toBe("timeout");
    const [record] = timedOutRecords();
    expect(record?.opId).toBe("rename-it");
    expect(record?.expected).toEqual({
      mode: "update",
      uuid,
      assert: [{ field: "title", equals: "after" }],
    });
  });

  it("a CONFIRMED record carries no assertion — there is nothing ambiguous to settle", async () => {
    const uuid = seedTodo(fixture.db, { title: "before" });
    const result = await runSingle(
      deps(createSimulatorVector(fixture.path, { now: () => NOW })),
      "todo.update",
      { uuid, title: "after" },
      { opId: "rename-it" },
    );
    expect(result.kind).toBe("ok");
    const ok = readAuditRecords(auditDirPath).find((r) => r.result === "ok");
    expect(ok?.expected).toBeUndefined();
  });
});

describe("reconciling a resubmission against a timed-out original", () => {
  it("the change IS in place → replays as already-applied, drives nothing", async () => {
    const uuid = seedTodo(fixture.db, { title: "before" });
    await stalledRename(uuid, "after");
    // The app landed it late: the state the attempt was waiting for now holds.
    fixture.db.prepare("UPDATE TMTask SET title = 'after' WHERE uuid = ?").run(uuid);

    const sim = createSimulatorVector(fixture.path, { now: () => NOW });
    const d = deps(sim);
    const recordsBefore = readAuditRecords(auditDirPath).length;
    const replay = await runSingle(
      d,
      "todo.update",
      { uuid, title: "after" },
      { opId: "rename-it" },
    );

    expect(replay.kind).toBe("ok");
    if (replay.kind !== "ok") throw new Error("unreachable");
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.uuid).toBe(uuid);
    expect(replay.warnings, "the reconciliation is disclosed, never silent").toContain(
      RECONCILED_NOTE,
    );
    // No undo token: the trail holds no completed-change record to reverse.
    expect(replay.undoToken).toBeUndefined();
    expect(readAuditRecords(auditDirPath).length, "a replay records nothing").toBe(recordsBefore);
  });

  it("the change is ABSENT → the write runs, exactly once", async () => {
    const uuid = seedTodo(fixture.db, { title: "before" });
    await stalledRename(uuid, "after");
    expect(titleOf(uuid), "the stalled attempt really did not land").toBe("before");

    const d = deps(createSimulatorVector(fixture.path, { now: () => NOW }));
    const rerun = await runSingle(
      d,
      "todo.update",
      { uuid, title: "after" },
      { opId: "rename-it" },
    );

    expect(rerun.kind).toBe("ok");
    expect(rerun.kind === "ok" && rerun.alreadyApplied).toBeUndefined();
    expect(titleOf(uuid)).toBe("after");
  });

  it("a CONFIRMED record still wins over an earlier timeout on the same key", async () => {
    const uuid = seedTodo(fixture.db, { title: "before" });
    await stalledRename(uuid, "after");
    const d = deps(createSimulatorVector(fixture.path, { now: () => NOW }));
    const rerun = await runSingle(
      d,
      "todo.update",
      { uuid, title: "after" },
      { opId: "rename-it" },
    );
    expect(rerun.kind === "ok" && rerun.alreadyApplied).toBeUndefined();

    // A third submission matches the ok record, so it is a plain phase-1 replay:
    // it carries the undo token and no reconciliation note.
    const third = await runSingle(
      d,
      "todo.update",
      { uuid, title: "after" },
      { opId: "rename-it" },
    );
    expect(third.kind === "ok" && third.alreadyApplied).toBe(true);
    if (third.kind !== "ok") throw new Error("unreachable");
    expect(third.undoToken).toBeDefined();
    expect(third.warnings ?? []).not.toContain(RECONCILED_NOTE);
  });

  it("a create whose uuid was never discovered answers with the row the re-read finds", () => {
    const created = seedTodo(fixture.db, {
      title: "Ambiguous capture",
      creationDate: 1_780_000_500,
    });
    appendRecord({
      opId: "make-it",
      op: "todo.add",
      uuid: null, // the attempt never discovered what it made
      requested: { title: "Ambiguous capture" },
      expected: {
        mode: "create",
        probe: { title: "Ambiguous capture", type: "to-do", sinceEpoch: 1_780_000_000 },
        assert: [],
      },
    });

    const replay = replayIfApplied(deps(createSimulatorVector(fixture.path, { now: () => NOW })), {
      opId: "make-it",
    });
    expect(replay?.kind).toBe("ok");
    if (replay?.kind !== "ok") throw new Error("unreachable");
    expect(replay.uuid, "the uuid comes from the re-read, not the record").toBe(created);
    expect(replay.title).toBe("Ambiguous capture");
    expect(replay.warnings).toContain(RECONCILED_NOTE);
  });
});

describe("an operation whose record cannot settle the question is REFUSED", () => {
  it("a whole-database assertion (emptying the Trash) refuses and points at the history", () => {
    appendRecord({ opId: "empty-it", op: "trash.empty", expected: { mode: "trash-emptied" } });

    const refusal = replayIfApplied(deps(createSimulatorVector(fixture.path, { now: () => NOW })), {
      opId: "empty-it",
    });

    expect(refusal?.kind).toBe("blocked");
    if (refusal?.kind !== "blocked") throw new Error("unreachable");
    expect(refusal.reason).toBe("reconcile");
    expect(refusal.detail).toContain("never confirmed");
    expect(refusal.detail).toContain("Trash");
    expect(refusal.remediation).toContain("things op-result empty-it");
    expect(refusal.remediation).toContain("NEW --op-id");
  });

  it("a record that stored no assertion refuses rather than assuming either way", () => {
    appendRecord({ opId: "who-knows", op: "todo.complete", uuid: "U-1" });

    const refusal = replayIfApplied(deps(createSimulatorVector(fixture.path, { now: () => NOW })), {
      opId: "who-knows",
    });

    expect(refusal?.kind).toBe("blocked");
    if (refusal?.kind !== "blocked") throw new Error("unreachable");
    expect(refusal.reason).toBe("reconcile");
    expect(refusal.detail).toContain("did not record what it was waiting to see");
    expect(refusal.remediation).toContain("U-1");
  });

  it("a dry run never reconciles — it records nothing, so it dedupes against nothing", () => {
    appendRecord({ opId: "empty-it", op: "trash.empty", expected: { mode: "trash-emptied" } });
    const d = deps(createSimulatorVector(fixture.path, { now: () => NOW }));
    expect(replayIfApplied(d, { opId: "empty-it", dryRun: true })).toBeNull();
  });
});

describe("the batch line reconciles on the same machinery", () => {
  it("a resubmitted line whose timed-out change landed reports already-applied", async () => {
    const uuid = seedTodo(fixture.db, { title: "before" });
    const stalled = await runBatch(deps(stallVector(() => uuid)), [
      {
        op: "todo.update",
        params: { uuid, title: "after" },
        opId: "line-key",
        options: { verifyTimeoutMs: 0 },
      },
    ]);
    expect(stalled.results[0]?.outcome.kind).toBe("verify-failed");
    fixture.db.prepare("UPDATE TMTask SET title = 'after' WHERE uuid = ?").run(uuid);

    const resubmitted = await runBatch(
      deps(createSimulatorVector(fixture.path, { now: () => NOW })),
      [{ op: "todo.update", params: { uuid, title: "after" }, opId: "line-key" }],
    );
    const outcome = resubmitted.results[0]?.outcome;
    expect(outcome?.kind).toBe("already-applied");
    if (outcome?.kind !== "already-applied") throw new Error("unreachable");
    expect(outcome.uuid).toBe(uuid);
    expect(outcome.detail).toContain("timed out");
  });

  it("a line whose match cannot be settled is BLOCKED, not re-run", async () => {
    appendRecord({ opId: "empty-it", op: "trash.empty", expected: { mode: "trash-emptied" } });
    const uuid = seedTodo(fixture.db, { title: "before" });

    const { results } = await runBatch(
      deps(createSimulatorVector(fixture.path, { now: () => NOW })),
      [{ op: "todo.update", params: { uuid, title: "after" }, opId: "empty-it" }],
    );

    expect(results[0]?.outcome.kind).toBe("blocked");
    expect(titleOf(uuid), "nothing was dispatched for the blocked line").toBe("before");
  });
});
