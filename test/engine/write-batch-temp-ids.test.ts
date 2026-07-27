/**
 * Batch temp-id chaining, opId idempotency, and batch-level undo — driven
 * end-to-end through the FULL mutation pipeline with the simulator write vector
 * (applies each write as SQL, no Things app), so created uuids really land and
 * `$refs` resolve against real rows. Mirrors write-simulator.test.ts's fence
 * setup.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuditWriter } from "../../src/audit/log.ts";
import { undoToken } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runBatch, type BatchOp } from "../../src/write/batch.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import { runUndo } from "../../src/write/undo.ts";
import { createSimulatorVector } from "../../src/write/vectors/simulator.ts";
import type { WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let lockSeq = 0;

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
}

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "batch-actor",
  auditEnabled: true,
  acceptedFingerprint: null,
  allowExperimental: false,
  ui: { enabled: false },
  host: "test-host",
};

/** Deps with a REAL on-disk audit writer + dir (opId lookback and undo both read it). */
function deps(vector: WriteVector, auditDirPath: string): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: CONFIG,
    audit: createAuditWriter({ dir: auditDirPath, secrets: [], enabled: true }),
    auditDirPath,
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-batch-temp-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
  };
}

let vector: WriteVector;
let auditDirPath: string;
let savedSim: string | undefined;
let savedDb: string | undefined;
let savedState: string | undefined;
let savedConfig: string | undefined;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const row = (uuid: string): Record<string, unknown> | undefined =>
  fixture.db.prepare("SELECT * FROM TMTask WHERE uuid = ?").get(uuid) as
    | Record<string, unknown>
    | undefined;

beforeEach(() => {
  fixture = buildFixtureDb({ benchMarker: true });
  auditDirPath = mkdtempSync(join(tmpdir(), "batch-temp-audit-"));
  savedSim = process.env["THINGS_SIM_WRITES"];
  savedDb = process.env["THINGS_DB"];
  savedState = process.env["THINGS_API_STATE_DIR"];
  savedConfig = process.env["THINGS_API_CONFIG_DIR"];
  process.env["THINGS_SIM_WRITES"] = "1";
  process.env["THINGS_DB"] = fixture.path;
  process.env["THINGS_API_STATE_DIR"] = mkdtempSync(join(tmpdir(), "batch-temp-state-"));
  process.env["THINGS_API_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "batch-temp-config-"));
  vector = createSimulatorVector(fixture.path, { now: () => NOW });
});
afterEach(() => {
  restoreEnv("THINGS_SIM_WRITES", savedSim);
  restoreEnv("THINGS_DB", savedDb);
  restoreEnv("THINGS_API_STATE_DIR", savedState);
  restoreEnv("THINGS_API_CONFIG_DIR", savedConfig);
  fixture.close();
});

describe("batch temp-id chaining", () => {
  it("project → heading → to-dos in one batch: real uuids land in-container", async () => {
    const ops: BatchOp[] = [
      { op: "project.add", params: { title: "Launch" }, tempId: "proj" },
      {
        op: "heading.add",
        params: { project: { uuid: "$proj" }, title: "Phase A" },
        tempId: "head",
      },
      {
        op: "todo.add",
        params: { title: "step 1", project: { uuid: "$proj" }, heading: "Phase A" },
      },
      {
        op: "todo.add",
        params: { title: "step 2", project: { uuid: "$proj" }, heading: "Phase A" },
      },
    ];
    const {
      results,
      tempIdMapping,
      undoToken: token,
    } = await runBatch(deps(vector, auditDirPath), ops);

    expect(results.map((r) => r.outcome.kind)).toEqual(["ok", "ok", "ok", "ok"]);
    // The declaring lines echo their tempId + bound uuid.
    expect(results[0]?.tempId).toBe("proj");
    expect(results[0]?.boundUuid).toBeDefined();
    const projUuid = tempIdMapping["proj"];
    const headUuid = tempIdMapping["head"];
    expect(projUuid).toBeDefined();
    expect(headUuid).toBeDefined();

    // The two to-dos really landed under the created heading (project column
    // NULL, reached through the heading — the simulator's containment rule).
    const todoUuids = results
      .slice(2)
      .map((r) => (r.outcome.kind === "ok" ? r.outcome.uuid : null));
    for (const t of todoUuids) {
      expect(t).not.toBeNull();
      expect(row(t as string)?.["heading"]).toBe(headUuid);
    }
    // The created heading really lives under the created project.
    expect(row(headUuid as string)?.["project"]).toBe(projUuid);
    // The batch minted an undo token.
    expect(token).toBeDefined();
  });

  it("summary carries tempIdMapping for every bound handle", async () => {
    const { tempIdMapping } = await runBatch(deps(vector, auditDirPath), [
      { op: "project.add", params: { title: "P" }, tempId: "a" },
      { op: "area.add", params: { title: "Zone" }, tempId: "b" },
    ]);
    expect(Object.keys(tempIdMapping).toSorted()).toEqual(["a", "b"]);
    expect(typeof tempIdMapping["a"]).toBe("string");
    expect(typeof tempIdMapping["b"]).toBe("string");
  });

  it("dotted access on a make-repeating leg: bind the template; $x.instance targets the spawned occurrence", async () => {
    const src = seedTodo(fixture.db, {
      title: "Water plants",
      start: "active",
      startDate: "2026-07-01",
    });
    const { results, tempIdMapping } = await runBatch(deps(vector, auditDirPath), [
      {
        op: "todo.make-repeating",
        params: { uuid: src, frequency: "weekly", interval: 1 },
        tempId: "rep",
        options: { dangerouslyDriveGui: true },
      },
      // The occurrence — NOT the hidden template — is the visible item to act on.
      { op: "todo.complete", params: { uuid: "$rep.instance" } },
    ]);
    expect(results.map((r) => r.outcome.kind)).toEqual(["ok", "ok"]);

    // Primary handle = the template (result.uuid).
    const templateUuid = tempIdMapping["rep"];
    expect(templateUuid).toBeDefined();
    const repeatingResult = results[0]?.outcome;
    if (repeatingResult?.kind !== "ok") throw new Error("expected make-repeating ok");
    const instanceUuid = repeatingResult.repeating?.instanceUuid;
    expect(instanceUuid).toBeDefined();
    expect(instanceUuid).not.toBe(templateUuid);

    // The complete leg resolved "$rep.instance" to the spawned occurrence, and
    // that is the row now completed — the template is untouched.
    const completeResult = results[1]?.outcome;
    if (completeResult?.kind !== "ok") throw new Error("expected complete ok");
    expect(completeResult.uuid).toBe(instanceUuid);
    expect(row(instanceUuid as string)?.["status"]).toBe(3);
    expect(row(templateUuid as string)?.["status"]).toBe(0);
  });
});

describe("batch opId idempotency", () => {
  it("a resubmitted opId is skipped (already-applied) with the original uuid, and rebinds it for later $refs", async () => {
    const d = deps(vector, auditDirPath);
    // First submission: create a project under opId "make-proj".
    const first = await runBatch(d, [
      { op: "project.add", params: { title: "Once" }, opId: "make-proj", tempId: "p" },
    ]);
    expect(first.results[0]?.outcome.kind).toBe("ok");
    const originalUuid = first.tempIdMapping["p"];
    expect(originalUuid).toBeDefined();

    // Resubmit the SAME opId, plus a dependent leg that references its tempId.
    const second = await runBatch(d, [
      { op: "project.add", params: { title: "Once" }, opId: "make-proj", tempId: "p" },
      { op: "todo.add", params: { title: "child", project: { uuid: "$p" } } },
    ]);
    // The create was NOT re-run — reported already-applied with the SAME uuid.
    expect(second.results[0]?.outcome.kind).toBe("already-applied");
    if (second.results[0]?.outcome.kind === "already-applied") {
      expect(second.results[0].outcome.uuid).toBe(originalUuid);
    }
    expect(second.results[0]?.boundUuid).toBe(originalUuid);
    expect(second.tempIdMapping["p"]).toBe(originalUuid);
    // The dependent leg resolved "$p" to the original uuid and really filed the
    // child under the first submission's project.
    expect(second.results[1]?.outcome.kind).toBe("ok");
    if (second.results[1]?.outcome.kind === "ok") {
      expect(row(second.results[1].outcome.uuid as string)?.["project"]).toBe(originalUuid);
    }

    // Exactly ONE project titled "Once" exists — no double-create.
    const count = fixture.db
      .prepare("SELECT COUNT(*) AS n FROM TMTask WHERE type = 1 AND title = 'Once' AND trashed = 0")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe("batch-level undo", () => {
  it("summary undoToken undoes the whole batch, replaying leg inverses in REVERSE order", async () => {
    const d = deps(vector, auditDirPath);
    // Two creates whose inverse (todo.delete) the simulator supports; reverse
    // order is proved by which uuid each inverse step targets.
    const { results, undoToken: token } = await runBatch(d, [
      { op: "todo.add", params: { title: "first" } },
      { op: "todo.add", params: { title: "second" } },
    ]);
    expect(results.map((r) => r.outcome.kind)).toEqual(["ok", "ok"]);
    expect(token).toBeDefined();
    const firstUuid = results[0]?.outcome.kind === "ok" ? results[0].outcome.uuid : null;
    const secondUuid = results[1]?.outcome.kind === "ok" ? results[1].outcome.uuid : null;
    expect(row(firstUuid as string)).toBeDefined();
    expect(row(secondUuid as string)).toBeDefined();

    // Undo the WHOLE batch by its token.
    const items = await runUndo(d, auditDirPath, { txn: token as string });
    expect(items).toHaveLength(1);
    expect(items[0]?.outcome).toBe("ok");
    const plan = items[0]?.plan;
    expect(plan?.kind).toBe("invertible");
    // REVERSE leg order: the SECOND-created to-do is inverted before the first.
    expect(plan?.steps.map((s) => s.op)).toEqual(["todo.delete", "todo.delete"]);
    expect(plan?.steps.map((s) => s.params["uuid"])).toEqual([secondUuid, firstUuid]);
    expect(plan?.notes.some((n) => /replays 2 batch leg\(s\) in reverse/.test(n))).toBe(true);

    // Both creations are gone (trashed).
    expect(row(firstUuid as string)?.["trashed"]).toBe(1);
    expect(row(secondUuid as string)?.["trashed"]).toBe(1);

    // Re-running the same token now reports it already undone (an inverse for it
    // is on the trail).
    await expect(runUndo(d, auditDirPath, { txn: token as string })).rejects.toThrow(
      /already been undone/,
    );
  });

  it("a batch leg is not an independent undo target — the summary is the single undoable unit", async () => {
    const d = deps(vector, auditDirPath);
    const { undoToken: token } = await runBatch(d, [
      { op: "todo.add", params: { title: "leg one" } },
      { op: "todo.add", params: { title: "leg two" } },
    ]);
    // --last 1 selects the batch SUMMARY (not a leg): its derived token equals
    // the batch token, and it plans a whole-batch reverse replay.
    const dryRun = await runUndo(d, auditDirPath, { last: 1, dryRun: true });
    expect(dryRun).toHaveLength(1);
    expect(dryRun[0]?.plan.target.op).toBe("batch");
    expect(dryRun[0]?.plan.target.token).toBe(token);
    expect(dryRun[0]?.plan.steps.map((s) => s.op)).toEqual(["todo.delete", "todo.delete"]);
    // The summary's derived undo token is exactly the batch txn id.
    expect(
      undoToken({
        ts: "",
        op: "batch",
        actor: "",
        host: "",
        uuid: null,
        txn: { id: token as string, role: "summary" },
      }),
    ).toBe(token);
  });
});
