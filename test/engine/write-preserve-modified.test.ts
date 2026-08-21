/**
 * `--preserve-modified` engine tests (docs/reference/timestamps.md §4). The flag
 * captures each pre-existing TARGET row's `userModificationDate` (`umd`) before a
 * write and — after the change verifies — restores it through the AppleScript
 * `set modification date` leg, keeping the edit off the umd-keyed `changes`
 * timeline (TAGMOD T5). A FakeVector applies (or withholds) direct writes to the
 * fixture DB — fine here; the no-direct-writes rule protects the real Things DB.
 * Locked here: single-leg capture/restore + the AS restore leg, the multi-leg
 * compound (capture-once/restore-once after the flip-dance), the create no-op
 * (add), a silent op (no bump → no restore), and NON-FATAL restore-failure
 * disclosure. CI has no real app, so every AS leg is asserted by its payload.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import { runCancelWithDate } from "../../src/write/resolution-timestamps.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);
/** A seeded pre-write umd well in the past — the value a restore must return to. */
const ORIG = 1_780_000_000;

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
  certifiedAppVersion: null,
  allowExperimental: false,
  bounceEnabled: true,
  bounceMaxItems: 30,
  autoLaunch: true,
  deputyEnabled: false,
  ui: { enabled: false },
  host: "test-host",
};

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
}

/** A url-scheme vector whose effect applies a direct write to the fixture DB. */
function urlVector(matrix: VectorMatrix, effect: (db: DatabaseSync) => void) {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "url-scheme",
    matrix,
    async execute(invocation) {
      calls.push(invocation.payload);
      effect(fixture.db);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

/**
 * An AppleScript vector that both (a) runs any `set completion date` backdate
 * leg via `onCompletion`, and (b) simulates a `set modification date` restore by
 * writing the target row's umd back to {@link ORIG} — UNLESS `failRestore`, which
 * returns a nonzero exit and leaves the bumped umd in place (the non-fatal case).
 */
function asVector(
  matrix: VectorMatrix,
  opts: { failRestore?: boolean; onCompletion?: (db: DatabaseSync) => void } = {},
) {
  const restoreCalls: string[] = [];
  const vector: WriteVector = {
    id: "applescript",
    matrix,
    async execute(invocation) {
      if (invocation.payload.includes("set completion date")) {
        opts.onCompletion?.(fixture.db);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (invocation.payload.includes("set modification date")) {
        restoreCalls.push(invocation.payload);
        if (opts.failRestore === true) {
          return { exitCode: 1, stdout: "", stderr: "Things got an error (-1728)" };
        }
        const m = /set modification date of (?:to do|project) id "([^"]+)"/.exec(
          invocation.payload,
        );
        const target = m?.[1];
        if (target !== undefined) {
          fixture.db
            .prepare("UPDATE TMTask SET userModificationDate = ? WHERE uuid = ?")
            .run(ORIG, target);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, restoreCalls };
}

const emptyMatrix: VectorMatrix = {} as VectorMatrix;
const updateMatrix: VectorMatrix = {
  "todo.update": { support: "yes", disruption: 0, validation: "validated" },
  "todo.add": { support: "yes", disruption: 0, validation: "validated" },
} as VectorMatrix;
const cancelMatrix: VectorMatrix = {
  "todo.complete": { support: "yes", disruption: 0, validation: "validated" },
  "todo.cancel": { support: "yes", disruption: 0, validation: "validated" },
} as VectorMatrix;
const setDatesMatrix: VectorMatrix = {
  "todo.set-dates": { support: "yes", disruption: 0, validation: "validated" },
} as VectorMatrix;

function deps(vectors: WriteVector[]): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-pm-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
  };
}

const umdOf = (uuid: string): number | null =>
  (
    fixture.db.prepare("SELECT userModificationDate AS u FROM TMTask WHERE uuid = ?").get(uuid) as
      | { u: number | null }
      | undefined
  )?.u ?? null;

describe("single-leg capture + restore", () => {
  it("restores the target's umd after a bumping update and discloses preservedModified", async () => {
    const uuid = seedTodo(fixture.db, { title: "Old", modificationDate: ORIG });
    const url = urlVector(updateMatrix, (db) => {
      db.prepare("UPDATE TMTask SET title = 'New', userModificationDate = ? WHERE uuid = ?").run(
        NOW_EPOCH,
        uuid,
      );
    });
    const as = asVector(emptyMatrix);
    const result = await runMutation(
      deps([url.vector, as.vector]),
      "todo.update",
      { uuid, title: "New" },
      { preserveModified: true },
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.preservedModified).toBe(1);
      expect(result.preserveFailures).toBeUndefined();
    }
    // Exactly one AS restore leg, addressing the row as a to-do.
    expect(as.restoreCalls).toHaveLength(1);
    expect(as.restoreCalls[0]).toContain(`set modification date of to do id "${uuid}"`);
    // The change stands (title New) but the umd is back at the original second.
    expect(umdOf(uuid)).toBe(ORIG);
    // The ok audit record carries the captured pre-umd (enables a future undo).
    const ok = auditRecords.find((r) => r.result === "ok");
    expect(ok?.preModDates).toEqual({ [uuid]: ORIG });
  });

  it("is a silent no-op when the write does not bump umd (nothing to restore)", async () => {
    const uuid = seedTodo(fixture.db, { title: "Old", modificationDate: ORIG });
    // Effect changes the title but LEAVES umd untouched (a silent-class write).
    const url = urlVector(updateMatrix, (db) => {
      db.prepare("UPDATE TMTask SET title = 'New' WHERE uuid = ?").run(uuid);
    });
    const as = asVector(emptyMatrix);
    const result = await runMutation(
      deps([url.vector, as.vector]),
      "todo.update",
      { uuid, title: "New" },
      { preserveModified: true },
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.preservedModified).toBeUndefined();
    expect(as.restoreCalls).toHaveLength(0);
  });
});

describe("create-only op (add) — silent no-op", () => {
  it("accepts --preserve-modified on todo.add and restores nothing (the new row's umd is new)", async () => {
    const url = urlVector(updateMatrix, (db) => {
      db.prepare(
        'INSERT INTO TMTask (uuid, type, status, trashed, title, creationDate, userModificationDate, start, startBucket, "index", todayIndex) ' +
          "VALUES ('made-1', 0, 0, 0, 'Fresh', ?, ?, 0, 0, 0, 0)",
      ).run(NOW_EPOCH, NOW_EPOCH);
    });
    const as = asVector(emptyMatrix);
    const result = await runMutation(
      deps([url.vector, as.vector]),
      "todo.add",
      { title: "Fresh" },
      { preserveModified: true },
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.preservedModified).toBeUndefined();
    expect(as.restoreCalls).toHaveLength(0);
  });
});

describe("non-fatal restore failure", () => {
  it("the mutation still stands and the failed restore is disclosed per row", async () => {
    const uuid = seedTodo(fixture.db, { title: "Old", modificationDate: ORIG });
    const url = urlVector(updateMatrix, (db) => {
      db.prepare("UPDATE TMTask SET title = 'New', userModificationDate = ? WHERE uuid = ?").run(
        NOW_EPOCH,
        uuid,
      );
    });
    const as = asVector(emptyMatrix, { failRestore: true });
    const result = await runMutation(
      deps([url.vector, as.vector]),
      "todo.update",
      { uuid, title: "New" },
      { preserveModified: true },
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.preservedModified).toBe(0);
      expect(result.preserveFailures).toHaveLength(1);
      expect(result.preserveFailures?.[0]?.uuid).toBe(uuid);
      expect(result.preserveFailures?.[0]?.detail).toContain("exit 1");
    }
    // The mutation landed (title New) even though the umd restore failed.
    expect(umdOf(uuid)).toBe(NOW_EPOCH);
  });
});

describe("multi-leg compound (flip-dance): capture once, restore once", () => {
  it("cancel --completed-at on a canceled to-do restores umd after the last leg", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "t",
      status: "canceled",
      stopDate: Math.floor(new Date("2026-06-01T12:00:00Z").getTime() / 1000),
      modificationDate: ORIG,
    });
    // Each flip re-stamps umd (a real resolution flip bumps it) and moves status.
    const flip = { calls: [] as string[] };
    const urlWired: WriteVector = {
      id: "url-scheme",
      matrix: cancelMatrix,
      async execute(invocation) {
        flip.calls.push(invocation.payload);
        if (invocation.payload.includes("completed=true")) {
          fixture.db
            .prepare("UPDATE TMTask SET status = 3, userModificationDate = ? WHERE uuid = ?")
            .run(NOW_EPOCH, uuid);
        }
        if (invocation.payload.includes("canceled=true")) {
          fixture.db
            .prepare("UPDATE TMTask SET status = 2, userModificationDate = ? WHERE uuid = ?")
            .run(NOW_EPOCH, uuid);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const noonEpoch = Math.floor(new Date("2025-01-15T12:00:00").getTime() / 1000);
    const as = asVector(setDatesMatrix, {
      onCompletion: (db) =>
        db
          .prepare(
            "UPDATE TMTask SET status = 3, stopDate = ?, userModificationDate = ? WHERE uuid = ?",
          )
          .run(noonEpoch, NOW_EPOCH, uuid),
    });
    const result = await runCancelWithDate(
      deps([urlWired, as.vector]),
      "todo",
      uuid,
      { completedAt: "2025-01-15" },
      { preserveModified: true },
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.preservedModified).toBe(1);
      expect(result.preserveFailures).toBeUndefined();
    }
    // Exactly ONE restore leg for the whole 3-leg flip-dance.
    expect(as.restoreCalls).toHaveLength(1);
    // Ends canceled, backdated, with umd back at the original second.
    const row = fixture.db
      .prepare("SELECT status, userModificationDate AS u FROM TMTask WHERE uuid = ?")
      .get(uuid) as {
      status: number;
      u: number;
    };
    expect(row.status).toBe(2);
    expect(row.u).toBe(ORIG);
  });
});
