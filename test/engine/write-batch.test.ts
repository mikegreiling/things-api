/**
 * Batch pipeline tests: each op runs the full mutation pipeline. A statically
 * invalid line refuses the WHOLE batch up front (Change 1); a runtime failure
 * STOPS the batch by default with the rest reported not-run (Change 2), while
 * `continueOnError` runs past failures; thrown param-shape errors surface per-op.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { outcomeFailed, runBatch, type BatchOp } from "../../src/write/batch.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
});
afterEach(() => fixture.close());

const MATRIX: VectorMatrix = Object.fromEntries(
  ["todo.update", "todo.complete", "trash.empty"].map((op) => [
    op,
    { support: "yes", disruption: 0, validation: "validated" },
  ]),
) as VectorMatrix;

function vectorApplying(effects: Record<string, () => void>): WriteVector {
  return {
    id: "url-scheme",
    matrix: MATRIX,
    async execute(invocation) {
      for (const [needle, fn] of Object.entries(effects)) {
        if (invocation.payload.includes(needle)) fn();
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "batch-actor",
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

function deps(vector: WriteVector): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-batch-lock-${process.pid}-${lockSeq++}`),
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

describe("runBatch", () => {
  it("continueOnError streams per-op outcomes: ok, blocked, thrown param conflicts", async () => {
    const a = seedTodo(fixture.db, { title: "A" });
    const b = seedTodo(fixture.db, { title: "B", notes: "x" });
    const vector = vectorApplying({
      [`id=${a}`]: () => touch(a, "status = 3, stopDate = 1783300000"),
    });
    const streamed: number[] = [];
    const ops: BatchOp[] = [
      { op: "todo.complete", params: { uuid: a } },
      { op: "trash.empty", params: {} }, // blocked: no dangerouslyPermanent
      { op: "todo.update", params: { uuid: b, notes: "y", appendNotes: "z" } }, // throws: exclusive
    ];
    // continueOnError runs past the blocked line so every per-op outcome streams
    // (the default would STOP at the blocked line — covered separately below).
    const { results } = await runBatch(deps(vector), ops, { continueOnError: true }, (r) =>
      streamed.push(r.index),
    );
    expect(streamed).toEqual([0, 1, 2]);
    expect(results.map((r) => r.outcome.kind)).toEqual(["ok", "blocked", "invalid"]);
    expect(results[2]?.outcome.kind === "invalid" && results[2].outcome.detail).toMatch(
      /exclusive/,
    );
    // ok + blocked both audited (invalid ops never reach the pipeline); the ok
    // op also records its pre-execute intent, excluded here. The batch summary
    // record (op "batch") is excluded — its own coverage is in the undo tests.
    expect(
      auditRecords.filter((r) => r.result !== "intent" && r.op !== "batch").map((r) => r.result),
    ).toEqual(["ok", "blocked:H-PERMANENT-DELETE"]);
  });

  it("stop-on-failure is the DEFAULT: a runtime failure halts, the rest report not-run", async () => {
    const a = seedTodo(fixture.db, { title: "A" });
    const vector = vectorApplying({});
    const ops: BatchOp[] = [
      { op: "trash.empty", params: {} }, // blocked → halts
      { op: "todo.complete", params: { uuid: a } }, // not run
    ];
    const { results } = await runBatch(deps(vector), ops);
    expect(results.map((r) => r.outcome.kind)).toEqual(["blocked", "skipped"]);
    expect(results[1]?.outcome.kind === "skipped" && results[1].outcome.detail).toMatch(/not run/);
    expect(outcomeFailed(results[1]!.outcome)).toBe(true);
  });

  it("continueOnError restores the old proceed-past behavior", async () => {
    const a = seedTodo(fixture.db, { title: "A" });
    const vector = vectorApplying({
      [`id=${a}`]: () => touch(a, "status = 3, stopDate = 1783300000"),
    });
    const ops: BatchOp[] = [
      { op: "trash.empty", params: {} }, // blocked
      { op: "todo.complete", params: { uuid: a } }, // still runs
    ];
    const { results } = await runBatch(deps(vector), ops, { continueOnError: true });
    expect(results.map((r) => r.outcome.kind)).toEqual(["blocked", "ok"]);
  });

  it("dryRun plans every op without executing or auditing", async () => {
    const a = seedTodo(fixture.db, { title: "A" });
    let executed = 0;
    const vector: WriteVector = {
      id: "url-scheme",
      matrix: MATRIX,
      async execute() {
        executed++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const { results } = await runBatch(
      deps(vector),
      [
        { op: "todo.complete", params: { uuid: a } },
        { op: "todo.update", params: { uuid: a, title: "renamed" } },
      ],
      { dryRun: true },
    );
    expect(results.map((r) => r.outcome.kind)).toEqual(["dry-run", "dry-run"]);
    expect(executed).toBe(0);
    expect(auditRecords).toHaveLength(0);
  });

  it("per-op acknowledgements unblock guarded ops", async () => {
    seedTodo(fixture.db, { title: "trashed-one", trashed: true });
    const vector = vectorApplying({
      "empty trash": () => {
        fixture.db.prepare("DELETE FROM TMTask WHERE trashed = 1").run();
      },
    });
    const asVector: WriteVector = {
      ...vector,
      id: "applescript",
    };
    const { results } = await runBatch(deps(asVector), [
      { op: "trash.empty", params: {}, options: { dangerouslyPermanent: true } },
    ]);
    expect(results[0]?.outcome.kind).toBe("ok");
  });

  it("declaration usage errors: duplicate tempId and tempId on tag.add reject the whole batch before any leg runs", async () => {
    const a = seedTodo(fixture.db, { title: "A" });
    let executed = 0;
    const vector: WriteVector = {
      id: "url-scheme",
      matrix: MATRIX,
      async execute() {
        executed++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    // Duplicate tempId "p": the SECOND declaration is the invalid line; the
    // whole batch is rejected pre-flight, so the (otherwise runnable) complete
    // never executes.
    const dup = await runBatch(deps(vector), [
      { op: "project.add", params: { title: "P1" }, tempId: "p" },
      { op: "project.add", params: { title: "P2" }, tempId: "p" },
      { op: "todo.complete", params: { uuid: a } },
    ]);
    expect(dup.results.map((r) => r.outcome.kind)).toEqual(["skipped", "invalid", "skipped"]);
    expect(dup.results[1]?.outcome.kind === "invalid" && dup.results[1].outcome.detail).toMatch(
      /duplicate tempId "p"/,
    );
    expect(dup.undoToken).toBeUndefined();
    expect(executed).toBe(0);
    expect(auditRecords).toHaveLength(0);

    // tempId on tag.add is a usage error (tags have no uuid).
    const tag = await runBatch(deps(vector), [
      { op: "tag.add" as never, params: { title: "focus" }, tempId: "t" },
    ]);
    expect(tag.results[0]?.outcome.kind).toBe("invalid");
    expect(tag.results[0]?.outcome.kind === "invalid" && tag.results[0].outcome.detail).toMatch(
      /tag\.add/,
    );
    expect(executed).toBe(0);
  });

  it("static $-refs (unresolved / forward) refuse the WHOLE batch before anything runs", async () => {
    const a = seedTodo(fixture.db, { title: "A" });
    let executed = 0;
    const vector: WriteVector = {
      id: "url-scheme",
      matrix: MATRIX,
      async execute() {
        executed++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const { results, undoToken } = await runBatch(deps(vector), [
      // unresolved: "$ghost" names no declared tempId anywhere in the batch
      { op: "todo.complete", params: { uuid: "$ghost" } },
      // forward: "$later" IS declared, but on a LATER line
      { op: "todo.complete", params: { uuid: "$later" } },
      // an otherwise-runnable leg — refused with the rest (the batch is a unit)
      { op: "todo.complete", params: { uuid: a } },
      // declares "later" (so line 1 is a forward ref, not merely unresolved)
      { op: "project.add", params: { title: "P" }, tempId: "later" },
    ]);
    // Both static-ref lines are enumerated invalid; the clean lines report
    // not-run; NOTHING is dispatched.
    expect(results.map((r) => r.outcome.kind)).toEqual([
      "invalid",
      "invalid",
      "skipped",
      "skipped",
    ]);
    expect(results[0]?.outcome.kind === "invalid" && results[0].outcome.detail).toMatch(
      /unresolved-temp-ref/,
    );
    expect(results[1]?.outcome.kind === "invalid" && results[1].outcome.detail).toMatch(
      /forward reference/,
    );
    expect(undoToken).toBeUndefined();
    expect(executed).toBe(0);
    expect(auditRecords).toHaveLength(0);
  });

  it("static preflight enumerates EVERY invalid line and dispatches nothing (dry-run parity)", async () => {
    const a = seedTodo(fixture.db, { title: "A" });
    let executed = 0;
    const vector: WriteVector = {
      id: "url-scheme",
      matrix: MATRIX,
      async execute() {
        executed++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const ops: BatchOp[] = [
      { op: "nope.bogus" as never, params: {} }, // unknown op
      { op: "todo.complete", params: { uuid: a } }, // valid
      { op: "todo.make-repeating" as never, params: { uuid: a } }, // compound refused in a batch
      { op: "todo.update", params: {}, opId: "not a valid id!" }, // malformed opId
    ];
    const run = await runBatch(deps(vector), ops);
    // Every statically-invalid line is enumerated; the one clean line is not-run.
    expect(run.results.map((r) => r.outcome.kind)).toEqual([
      "invalid",
      "skipped",
      "invalid",
      "invalid",
    ]);
    expect(run.results[0]?.outcome.kind === "invalid" && run.results[0].outcome.detail).toMatch(
      /unknown op/,
    );
    expect(run.results[2]?.outcome.kind === "invalid" && run.results[2].outcome.detail).toMatch(
      /COMPOUND/,
    );
    expect(run.results[3]?.outcome.kind === "invalid" && run.results[3].outcome.detail).toMatch(
      /opId must match/,
    );
    expect(executed).toBe(0);
    expect(auditRecords).toHaveLength(0);

    // dry-run takes the SAME pass and refuses identically.
    const dry = await runBatch(deps(vector), ops, { dryRun: true });
    expect(dry.results.map((r) => r.outcome.kind)).toEqual([
      "invalid",
      "skipped",
      "invalid",
      "invalid",
    ]);
    expect(executed).toBe(0);
  });

  it("resume guidance: every committed line carried an opId → verbatim rerun is safe", async () => {
    const a = seedTodo(fixture.db, { title: "A" });
    const b = seedTodo(fixture.db, { title: "B" });
    const vector = vectorApplying({
      [`id=${a}`]: () => touch(a, "status = 3, stopDate = 1783300000"),
    });
    const { results, resumption } = await runBatch(deps(vector), [
      { op: "todo.complete", params: { uuid: a }, opId: "op-a" }, // ok (has opId)
      { op: "trash.empty", params: {} }, // blocked → halts
      { op: "todo.complete", params: { uuid: b }, opId: "op-b" }, // not run
    ]);
    expect(results.map((r) => r.outcome.kind)).toEqual(["ok", "blocked", "skipped"]);
    expect(resumption).toBeDefined();
    expect(resumption?.notRun).toBe(1);
    expect(resumption?.verbatimSafe).toBe(true);
    expect(resumption?.nonIdempotentIndices).toEqual([]);
    expect(resumption?.detail).toMatch(/resubmitted verbatim/);
  });

  it("resume guidance: a committed line lacked an opId → names the index that would re-run", async () => {
    const a = seedTodo(fixture.db, { title: "A" });
    const b = seedTodo(fixture.db, { title: "B" });
    const vector = vectorApplying({
      [`id=${a}`]: () => touch(a, "status = 3, stopDate = 1783300000"),
    });
    const { resumption } = await runBatch(deps(vector), [
      { op: "todo.complete", params: { uuid: a } }, // ok, NO opId
      { op: "trash.empty", params: {} }, // blocked → halts
      { op: "todo.complete", params: { uuid: b } }, // not run
    ]);
    expect(resumption?.notRun).toBe(1);
    expect(resumption?.verbatimSafe).toBe(false);
    expect(resumption?.nonIdempotentIndices).toEqual([0]);
    expect(resumption?.detail).toMatch(/RE-RUN line\(s\) 0/);
  });

  it("tempId is valid on project.duplicate (a uuid-minting op) and binds the discovered copy", async () => {
    // project.duplicate mints a new uuid, so it is tempId-eligible. Drive it
    // through the create-probe: the source shares the copy's title (excluded),
    // so discovery lands on the freshly-created copy.
    const src = seedProject(fixture.db, {
      title: "Dup",
      notes: "BODY",
      creationDate: NOW_EPOCH - 500,
    });
    const matrix = {
      "project.duplicate": { support: "yes", disruption: 0, validation: "validated" },
    } as VectorMatrix;
    const vector: WriteVector = {
      id: "url-scheme",
      matrix,
      async execute(invocation) {
        if (invocation.payload.includes("duplicate=true")) {
          seedProject(fixture.db, {
            uuid: "COPY-P",
            title: "Dup",
            notes: "BODY",
            creationDate: NOW_EPOCH,
          });
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const { results, tempIdMapping } = await runBatch(deps(vector), [
      { op: "project.duplicate", params: { uuid: src }, tempId: "copy" },
    ]);
    expect(results[0]?.outcome.kind).toBe("ok");
    expect(results[0]?.tempId).toBe("copy");
    expect(results[0]?.boundUuid).toBe("COPY-P");
    expect(tempIdMapping["copy"]).toBe("COPY-P");
  });
});
