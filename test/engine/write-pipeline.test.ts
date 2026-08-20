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
  certifiedAppVersion: null,
  allowExperimental: false,
  bounceEnabled: true,
  bounceMaxItems: 30,
  autoLaunch: true,
  deputyEnabled: false,
  ui: { enabled: false },
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
    // M3: a successful write records an INTENT before execute, then the final
    // ok — the pair shares ts/op/actor/host (both derive from startedAt).
    expect(auditRecords).toHaveLength(2);
    expect(auditRecords[0]).toMatchObject({
      op: "todo.update",
      result: "intent",
      actor: "test-actor",
      uuid,
      pre: { title: "Old" },
      observed: null,
    });
    expect(auditRecords[1]).toMatchObject({
      op: "todo.update",
      result: "ok",
      actor: "test-actor",
      pre: { title: "Old" },
      observed: { title: "New" },
    });
    expect(auditRecords[0]?.ts).toBe(auditRecords[1]?.ts);
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
    // The final record carries the discovered uuid; the preceding intent has
    // uuid null (a create discovers its uuid only at verify).
    expect(auditRecords.find((r) => r.result === "ok")?.uuid).toBe("NEW-1");
    expect(auditRecords[0]).toMatchObject({ result: "intent", uuid: null });
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

  it("entity-created: area.add asserts the created area carries the tag set", async () => {
    const tag = seedTag(fixture.db, "Focus");
    const { vector } = fakeVector(
      (db) => {
        db.prepare(
          "INSERT INTO TMArea (uuid, title, visible, \"index\") VALUES ('AREA-T', 'Deep', 1, 0)",
        ).run();
        db.prepare("INSERT INTO TMAreaTag (areas, tags) VALUES ('AREA-T', ?)").run(tag);
      },
      FULL_MATRIX,
      "applescript",
    );
    const result = await runMutation(deps(vector), "area.add", { title: "Deep", tags: ["Focus"] });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.uuid).toBe("AREA-T");
  });

  it("entity-created: area.add FAILS when the app drops the tag (silent partial write)", async () => {
    seedTag(fixture.db, "Focus");
    const { vector } = fakeVector(
      (db) => {
        // Area row appears, but WITHOUT the TMAreaTag row — the pre-close gap
        // this build fixed: the created row must carry the asserted tag set.
        db.prepare(
          "INSERT INTO TMArea (uuid, title, visible, \"index\") VALUES ('AREA-U', 'Deep', 1, 0)",
        ).run();
      },
      FULL_MATRIX,
      "applescript",
    );
    const result = await runMutation(
      deps(vector),
      "area.add",
      { title: "Deep", tags: ["Focus"] },
      { verifyTimeoutMs: 250 },
    );
    expect(result.kind).toBe("verify-failed");
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
    // Intent precedes the failed outcome; the pair keeps the crash-signature
    // invariant (a verify-failed is NOT an orphan — it has a recorded result).
    expect(auditRecords.map((r) => r.result)).toEqual(["intent", "verify-failed:silent-noop"]);
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

describe("log-now (log completed now)", () => {
  const LOGNOW_MATRIX: VectorMatrix = {
    "log-now": { support: "yes", disruption: 0, validation: "validated" },
  };

  it("no-op under the default Immediately cadence: ok, logged 0, no undo token", async () => {
    // No TMSettings row → logInterval defaults to Immediately (boundary = now),
    // so a past completion is already logged and nothing is pending.
    seedTodo(fixture.db, { title: "Done", status: "completed", stopDate: NOW_EPOCH - 3600 });
    const { vector, calls } = fakeVector(null, LOGNOW_MATRIX, "applescript");
    const result = await runMutation(deps(vector), "log-now", {});
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.observed).toMatchObject({ logged: 0 });
      expect(result.undoToken).toBeUndefined(); // irreversible — no token emitted
    }
    // The AS verb still runs — the app itself decides there is nothing to log.
    expect(calls).toEqual(['tell application "Things3" to log completed now']);
  });

  it("Manually + a pending completion: advances the boundary and discloses the count", async () => {
    const t0 = NOW_EPOCH - 86400; // the boundary sits yesterday
    fixture.db
      .prepare("INSERT INTO TMSettings (uuid, logInterval, manualLogDate) VALUES ('S', 4, ?)")
      .run(t0);
    // Completed AFTER the boundary → resolved-but-unlogged (pending = 1).
    seedTodo(fixture.db, { title: "Fresh done", status: "completed", stopDate: NOW_EPOCH - 3600 });
    // The verb advances manualLogDate to ~now, moving the pending completion in.
    const { vector } = fakeVector(
      (db) => db.prepare("UPDATE TMSettings SET manualLogDate = ?").run(NOW_EPOCH),
      LOGNOW_MATRIX,
      "applescript",
    );
    const result = await runMutation(deps(vector), "log-now", {});
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.observed).toMatchObject({ logged: 1, manualLogDate: NOW_EPOCH });
    }
  });

  it("Manually + pending, but the boundary never advances: verify-failed (no silent success)", async () => {
    const t0 = NOW_EPOCH - 86400;
    fixture.db
      .prepare("INSERT INTO TMSettings (uuid, logInterval, manualLogDate) VALUES ('S', 4, ?)")
      .run(t0);
    seedTodo(fixture.db, { title: "Pending", status: "completed", stopDate: NOW_EPOCH - 3600 });
    // The transport is clean but the boundary stamp does not move — pending>0
    // requires the advance, so verify must fail rather than report a false ok.
    const { vector } = fakeVector(null, LOGNOW_MATRIX, "applescript");
    const result = await runMutation(deps(vector), "log-now", {}, { verifyTimeoutMs: 250 });
    expect(result.kind).toBe("verify-failed");
  });
});

describe("blocked / unsupported paths", () => {
  it("hazard block: never executes, audited as blocked", async () => {
    const { vector, calls } = fakeVector(null);
    const result = await runMutation(deps(vector), "trash.empty", {});
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-PERMANENT-DELETE");
    expect(calls).toHaveLength(0);
    // A guard block audits ONCE (the blocked record) — no intent is written,
    // since the app is never touched (M3: intent precedes execute only).
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]?.result).toBe("blocked:H-PERMANENT-DELETE");
    expect(auditRecords.some((r) => r.result === "intent")).toBe(false);
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

describe("closed-app auto-launch (issue #486)", () => {
  it("auto-launch on (default): a closed app is launched-and-readied, then the write lands", async () => {
    const uuid = seedTodo(fixture.db, { title: "Old" });
    const { vector } = fakeVector((db) => {
      db.prepare("UPDATE TMTask SET title = 'New' WHERE uuid = ?").run(uuid);
    });
    let launched = false;
    const result = await runMutation(
      deps(vector, {
        isAppRunning: () => false,
        ensureRunning: async (alreadyRunning) => {
          expect(alreadyRunning).toBe(false);
          launched = true;
          return true;
        },
      }),
      "todo.update",
      { uuid, title: "New" },
    );
    expect(launched).toBe(true);
    expect(result.kind).toBe("ok");
  });

  it("auto-launch off: a closed app is refused BEFORE dispatch, zero side effects", async () => {
    const uuid = seedTodo(fixture.db, { title: "x" });
    const { vector, calls } = fakeVector(() => {
      throw new Error("must not dispatch when auto-launch is off and the app is closed");
    });
    let ensureCalled = false;
    const result = await runMutation(
      deps(vector, {
        config: { ...CONFIG, autoLaunch: false },
        isAppRunning: () => false,
        ensureRunning: async () => {
          ensureCalled = true;
          return true;
        },
      }),
      "todo.update",
      { uuid, title: "y" },
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toBe("environment");
      expect(result.likelyCause).toBe("app-not-running");
      expect(result.detail).toContain("not running");
    }
    expect(ensureCalled).toBe(false); // refused before any launch attempt
    expect(calls).toHaveLength(0); // zero dispatch
  });

  it("a residual silent-noop after a launch is attributed to the app not having been running", async () => {
    const uuid = seedTodo(fixture.db, { title: "x" });
    // The app launches but the write is dropped in the startup window (no effect).
    const { vector } = fakeVector(null);
    const result = await runMutation(
      deps(vector, {
        isAppRunning: () => false,
        ensureRunning: async () => true,
      }),
      "todo.update",
      { uuid, title: "y" },
      { verifyTimeoutMs: 250 },
    );
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") {
      expect(result.reason).toBe("silent-noop");
      expect(result.likelyCause).toBe("app-not-running");
      expect(result.hint).toContain("startup window");
    }
  });
});
