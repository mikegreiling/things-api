/**
 * Batch pipeline tests: each op runs the full mutation pipeline; invalid
 * lines and thrown param-shape errors surface per-op; --fail-fast skips.
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
  allowExperimental: false,
  bounceEnabled: true,
  bounceMaxItems: 30,
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
  it("streams per-op outcomes: ok, blocked, invalid, thrown param conflicts", async () => {
    const a = seedTodo(fixture.db, { title: "A" });
    const b = seedTodo(fixture.db, { title: "B", notes: "x" });
    const vector = vectorApplying({
      [`id=${a}`]: () => touch(a, "status = 3, stopDate = 1783300000"),
    });
    const streamed: number[] = [];
    const ops: BatchOp[] = [
      { op: "todo.complete", params: { uuid: a } },
      { op: "trash.empty", params: {} }, // blocked: no dangerouslyPermanent
      { op: "nope.bogus" as never, params: {} }, // invalid: unknown op
      { op: "todo.update", params: { uuid: b, notes: "y", appendNotes: "z" } }, // throws: exclusive
    ];
    const { results } = await runBatch(deps(vector), ops, {}, (r) => streamed.push(r.index));
    expect(streamed).toEqual([0, 1, 2, 3]);
    expect(results.map((r) => r.outcome.kind)).toEqual(["ok", "blocked", "invalid", "invalid"]);
    expect(results[3]?.outcome.kind === "invalid" && results[3].outcome.detail).toMatch(
      /exclusive/,
    );
    // ok + blocked both audited (invalid ops never reach the pipeline); the ok
    // op also records its pre-execute intent, excluded here. The batch summary
    // record (op "batch") is excluded — its own coverage is in the undo tests.
    expect(
      auditRecords.filter((r) => r.result !== "intent" && r.op !== "batch").map((r) => r.result),
    ).toEqual(["ok", "blocked:H-PERMANENT-DELETE"]);
  });

  it("failFast skips everything after the first failure", async () => {
    const a = seedTodo(fixture.db, { title: "A" });
    const vector = vectorApplying({});
    const ops: BatchOp[] = [
      { op: "trash.empty", params: {} }, // blocked
      { op: "todo.complete", params: { uuid: a } },
    ];
    const { results } = await runBatch(deps(vector), ops, { failFast: true });
    expect(results.map((r) => r.outcome.kind)).toEqual(["blocked", "skipped"]);
    expect(outcomeFailed(results[1]!.outcome)).toBe(true);
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

  it("strict $-refs: unresolved and forward references fail their own line; independent legs still run", async () => {
    const a = seedTodo(fixture.db, { title: "A" });
    const vector = vectorApplying({
      [`id=${a}`]: () => touch(a, "status = 3, stopDate = 1783300000"),
    });
    const { results } = await runBatch(deps(vector), [
      // unresolved: "$ghost" names no declared tempId anywhere in the batch
      { op: "todo.complete", params: { uuid: "$ghost" } },
      // forward: "$later" IS declared, but on a LATER line
      { op: "todo.complete", params: { uuid: "$later" } },
      // an independent, valid leg — must still run despite the two failures above
      { op: "todo.complete", params: { uuid: a } },
      // declares "later" (so line 1 is a forward ref, not merely unresolved);
      // project.add is out of this fake vector's matrix, so it is unsupported —
      // the declaration is what matters for the forward-ref classification.
      { op: "project.add", params: { title: "P" }, tempId: "later" },
    ]);
    expect(results.map((r) => r.outcome.kind)).toEqual(["invalid", "invalid", "ok", "unsupported"]);
    expect(results[0]?.outcome.kind === "invalid" && results[0].outcome.detail).toMatch(
      /unresolved-temp-ref/,
    );
    expect(results[1]?.outcome.kind === "invalid" && results[1].outcome.detail).toMatch(
      /forward reference/,
    );
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
