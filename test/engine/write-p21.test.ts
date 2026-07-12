/**
 * Phase 21a engine tests: failure attribution and environment-tuple tracking
 * wired through the mutation pipeline — consent-failure signatures on the
 * transport, silent-noop theories at verification, warnings + recording on
 * verified success, and the drift block's attribution.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import type { EnvironmentTracker, EnvironmentTuple } from "../../src/write/environment.ts";
import type { ExecuteResult, VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;
/** On-disk 'Enable Things URLs' state injected into the pipeline (never the host's). */
let urlSchemeState: boolean | null;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
  urlSchemeState = true;
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
  ["todo.update", "todo.complete"].map((op) => [
    op,
    { support: "yes", disruption: 0, validation: "validated" },
  ]),
) as VectorMatrix;

const AS_MATRIX: VectorMatrix = Object.fromEntries(
  ["todo.delete"].map((op) => [op, { support: "yes", disruption: 0, validation: "validated" }]),
) as VectorMatrix;

function vectorReturning(
  id: WriteVector["id"],
  matrix: VectorMatrix,
  result: ExecuteResult,
): WriteVector {
  return {
    id,
    matrix,
    async execute() {
      return result;
    },
  };
}

function effectVector(
  id: WriteVector["id"],
  matrix: VectorMatrix,
  effect: (() => void) | null,
): WriteVector {
  return {
    id,
    matrix,
    async execute() {
      effect?.();
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

const TUPLE_A: EnvironmentTuple = {
  thingsVersion: "3.22.11",
  macosVersion: "15.5",
  pkgVersion: "0.3.0",
  nodeBinary: "/usr/local/bin/node",
};
const TUPLE_B: EnvironmentTuple = { ...TUPLE_A, thingsVersion: "3.22.12" };

function fakeTracker(recorded: EnvironmentTuple | null, current: EnvironmentTuple) {
  const recordings: EnvironmentTuple[] = [];
  const tracker: EnvironmentTracker = {
    capture: () => current,
    load: () => recorded,
    record: (t) => {
      recordings.push(t);
    },
  };
  return { tracker, recordings };
}

function deps(vectors: WriteVector[], environment?: EnvironmentTracker): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-p21-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    urlSchemeEnabled: () => urlSchemeState,
    ...(environment !== undefined && { environment }),
  };
}

function touch(uuid: string, sets: string): void {
  fixture.db
    .prepare(`UPDATE TMTask SET ${sets}, userModificationDate = ? WHERE uuid = ?`)
    .run(NOW_EPOCH + 1, uuid);
}

describe("transport failure attribution", () => {
  it("AppleEvent -1743 → permission-denied", async () => {
    const todo = seedTodo(fixture.db, { title: "denied" });
    const vector = vectorReturning("applescript", AS_MATRIX, {
      exitCode: 1,
      stdout: "",
      stderr: "execution error: Not authorized to send Apple events to Things3. (-1743)",
    });
    const result = await runMutation(deps([vector]), "todo.delete", { uuid: todo });
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") {
      expect(result.likelyCause).toBe("permission-denied");
      expect(result.hint).toContain("Automation");
    }
  });

  it("a deadline kill → permission-pending, citing the environment change", async () => {
    const todo = seedTodo(fixture.db, { title: "hung" });
    const vector = vectorReturning("applescript", AS_MATRIX, {
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    const { tracker } = fakeTracker(TUPLE_A, TUPLE_B);
    const result = await runMutation(deps([vector], tracker), "todo.delete", { uuid: todo });
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") {
      expect(result.likelyCause).toBe("permission-pending");
      expect(result.hint).toContain("Automation dialog");
      expect(result.hint).toContain("Things changed (3.22.11 → 3.22.12)");
      expect(result.detail).toContain("timed out");
    }
  });
});

describe("verification failure attribution", () => {
  it("url-scheme silent no-op with 'Enable Things URLs' off on disk → feature-disabled", async () => {
    urlSchemeState = false;
    const todo = seedTodo(fixture.db, { title: "noop" });
    const vector = effectVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(
      deps([vector]),
      "todo.update",
      { uuid: todo, title: "renamed" },
      { verifyTimeoutMs: 300 },
    );
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") {
      expect(result.reason).toBe("silent-noop");
      expect(result.likelyCause).toBe("feature-disabled");
      expect(result.hint).toContain("Enable Things URLs");
    }
  });

  it("silent no-op WITH a token and stable environment → app-behavior-change", async () => {
    fixture.db.exec(
      "DELETE FROM TMSettings;" +
        "INSERT INTO TMSettings (uriSchemeAuthenticationToken) VALUES ('tok-123');",
    );
    const todo = seedTodo(fixture.db, { title: "noop2" });
    const vector = effectVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(
      deps([vector]),
      "todo.update",
      { uuid: todo, title: "renamed" },
      { verifyTimeoutMs: 300 },
    );
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") {
      expect(result.likelyCause).toBe("app-behavior-change");
    }
  });
});

describe("environment tuple on verified success", () => {
  it("warns about a changed tuple and records the current one", async () => {
    const todo = seedTodo(fixture.db, { title: "done deal" });
    const vector = effectVector("url-scheme", URL_MATRIX, () => {
      touch(todo, `status = 3, stopDate = ${NOW_EPOCH}`);
    });
    const { tracker, recordings } = fakeTracker(TUPLE_A, TUPLE_B);
    const result = await runMutation(deps([vector], tracker), "todo.complete", { uuid: todo });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain("Things changed (3.22.11 → 3.22.12)");
    }
    expect(recordings).toEqual([TUPLE_B]);
  });

  it("stays silent when the tuple is unchanged (but still records)", async () => {
    const todo = seedTodo(fixture.db, { title: "steady" });
    const vector = effectVector("url-scheme", URL_MATRIX, () => {
      touch(todo, `status = 3, stopDate = ${NOW_EPOCH}`);
    });
    const { tracker, recordings } = fakeTracker(TUPLE_A, TUPLE_A);
    const result = await runMutation(deps([vector], tracker), "todo.complete", { uuid: todo });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.warnings).toBeUndefined();
    expect(recordings).toEqual([TUPLE_A]);
  });
});

describe("drift attribution", () => {
  it("the drift block carries likelyCause schema-drift", async () => {
    const todo = seedTodo(fixture.db, { title: "drifted" });
    const d = deps([effectVector("url-scheme", URL_MATRIX, null)]);
    d.fingerprint = () => ({
      kind: "drift",
      expected: "sha256:baseline",
      detail: ["column missing: TMTask.example"],
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:other" },
    });
    const result = await runMutation(d, "todo.update", { uuid: todo, title: "x" });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toBe("drift");
      expect(result.likelyCause).toBe("schema-drift");
    }
  });
});
