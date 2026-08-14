/**
 * promote-via-clone orchestrators (make/add-repeating): drive the FULL compound
 * end-to-end against a synthetic fixture DB with the simulator write vector
 * applying each leg (clone → native promote → trash). Asserts (a) the ok result +
 * repeating block + undoToken, (b) the original is recoverable in the Trash, (c)
 * the summary audit record captures template/instance/original, (d) the clone is
 * an EMBEDDED leg (not an independent todo.clone summary), (e) the undo trash-both
 * + restore round-trip, (f) the refusal + gating copy. No Things app is touched.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import {
  runAddRepeatingProject,
  runAddRepeatingTodo,
  runMakeRepeatingProject,
  runMakeRepeatingTodo,
} from "../../src/write/promote-clone.ts";
import { type WriteDeps } from "../../src/write/pipeline.ts";
import { runUndo } from "../../src/write/undo.ts";
import { createSimulatorVector } from "../../src/write/vectors/simulator.ts";
import type { WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;
let auditDir: string;

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
  ui: { enabled: false },
  host: "test-host",
};

/**
 * A fake applescript vector applying project.delete/restore by SQL — the
 * simulator vector covers todo.delete/restore but not the project variants, so
 * the project promote/undo legs (project.delete + rollback restore) need this.
 */
function projectTrashVector(): WriteVector {
  return {
    id: "applescript",
    matrix: {
      "project.delete": { support: "yes", disruption: 0, validation: "validated" },
      "project.restore": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(inv) {
      const id = /id "([^"]+)"/.exec(inv.payload)?.[1] ?? "";
      const trashed = inv.payload.includes("delete") ? 1 : 0;
      fixture.db.prepare("UPDATE TMTask SET trashed = ? WHERE uuid = ?").run(trashed, id);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function deps(vectors: WriteVector | WriteVector[]): WriteDeps {
  return {
    db: fixture.db,
    vectors: Array.isArray(vectors) ? vectors : [vectors],
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-promote-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    auditDirPath: auditDir,
  };
}

const GUI = { dangerouslyDriveGui: true } as const;
const row = (uuid: string): Record<string, unknown> | undefined =>
  fixture.db.prepare("SELECT * FROM TMTask WHERE uuid = ?").get(uuid) as
    | Record<string, unknown>
    | undefined;

let savedSim: string | undefined;
let savedDb: string | undefined;
let savedState: string | undefined;
let savedConfig: string | undefined;
let vector: WriteVector;

beforeEach(() => {
  fixture = buildFixtureDb({ benchMarker: true });
  auditRecords = [];
  savedSim = process.env["THINGS_SIM_WRITES"];
  savedDb = process.env["THINGS_DB"];
  savedState = process.env["THINGS_API_STATE_DIR"];
  savedConfig = process.env["THINGS_API_CONFIG_DIR"];
  process.env["THINGS_SIM_WRITES"] = "1";
  process.env["THINGS_DB"] = fixture.path;
  process.env["THINGS_API_STATE_DIR"] = mkdtempSync(join(tmpdir(), "promote-state-"));
  process.env["THINGS_API_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "promote-config-"));
  auditDir = mkdtempSync(join(tmpdir(), "promote-audit-"));
  vector = createSimulatorVector(fixture.path, { now: () => NOW });
});
function restoreEnv(k: string, v: string | undefined): void {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  restoreEnv("THINGS_SIM_WRITES", savedSim);
  restoreEnv("THINGS_DB", savedDb);
  restoreEnv("THINGS_API_STATE_DIR", savedState);
  restoreEnv("THINGS_API_CONFIG_DIR", savedConfig);
  fixture.close();
});

/** Persist the in-memory audit records to the JSONL file runUndo reads. */
function flushAudit(): void {
  writeFileSync(
    join(auditDir, "2026-07.jsonl"),
    auditRecords.map((r) => JSON.stringify(r)).join("\n"),
  );
}

describe("todo.make-repeating — promote-via-clone", () => {
  it("clones X, promotes the clone, trashes X; result carries the template + trashed original", async () => {
    const src = seedTodo(fixture.db, { title: "Water plants", start: "active" });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok with template uuid");

    // The original survives in the Trash (recoverable).
    expect(row(src)?.["trashed"]).toBe(1);
    // The result carries the minted template + a repeating block.
    expect(res.repeating?.templateUuid).toBe(res.uuid);
    expect(res.repeating?.instanceUuid).toBeDefined();
    expect(res.undoToken).toBeDefined();
    // The trashed original is named in a warning.
    expect((res.warnings ?? []).join(" ")).toContain(src);

    // A single make-repeating SUMMARY record captures template + instance + original.
    const summary = auditRecords.find(
      (r) => r.op === "todo.make-repeating" && r.txn?.role === "summary",
    );
    expect(summary?.observed).toMatchObject({
      templateUuid: res.uuid,
      originalUuid: src,
    });
    // The clone is an EMBEDDED leg, never an independent todo.clone summary.
    expect(auditRecords.some((r) => r.op === "todo.clone" && r.txn?.role === "summary")).toBe(
      false,
    );
    expect(auditRecords.some((r) => r.op === "todo.clone" && r.txn?.role === "leg")).toBe(true);
  });

  it("undo trashes the template + instance (trash-both) and restores the original", async () => {
    const src = seedTodo(fixture.db, { title: "Standup", start: "active" });
    const made = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "daily", interval: 1 },
      GUI,
    );
    if (made.kind !== "ok" || made.uuid === null || made.undoToken === undefined) {
      throw new Error("expected ok with token");
    }
    const templateUuid = made.uuid;
    const instanceUuid = made.repeating?.instanceUuid ?? null;
    const token = made.undoToken;
    flushAudit();

    const items = await runUndo(deps(vector), auditDir, { txn: token });
    expect(items[0]?.outcome).toBe("ok");
    // Trash-both landed; the original is revived.
    expect(row(templateUuid)?.["trashed"]).toBe(1);
    if (instanceUuid !== null && instanceUuid !== templateUuid) {
      expect(row(instanceUuid)?.["trashed"]).toBe(1);
    }
    expect(row(src)?.["trashed"]).toBe(0);
    expect(items[0]?.plan.notes.join(" ")).toContain("Put Back");
  });

  it("blocks (no clone minted) when the GUI-drive ack is missing", async () => {
    const src = seedTodo(fixture.db, { title: "T", start: "active" });
    const res = await runMakeRepeatingTodo(deps(vector), {
      uuid: src,
      frequency: "weekly",
      interval: 1,
    });
    expect(res).toMatchObject({ kind: "blocked", hazard: "H-UI-DRIVE" });
    // Nothing was cloned or trashed.
    expect(row(src)?.["trashed"]).toBe(0);
    expect(auditRecords.some((r) => r.op === "todo.clone")).toBe(false);
  });

  it("dry-run previews clone → promote → trash without touching anything", async () => {
    const src = seedTodo(fixture.db, { title: "T", start: "active" });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 1 },
      { dryRun: true },
    );
    expect(res.kind).toBe("dry-run");
    if (res.kind === "dry-run") {
      expect(res.plan.invocation).toContain("clone");
      expect(res.plan.invocation).toContain("trash the original");
    }
    expect(row(src)?.["trashed"]).toBe(0);
  });
});

describe("project.make-repeating — promote-via-clone", () => {
  it("clones the project, promotes the clone, trashes the original", async () => {
    const area = seedArea(fixture.db, "Ops");
    const proj = seedProject(fixture.db, { title: "Weekly review", area, start: "active" });
    const res = await runMakeRepeatingProject(
      deps([vector, projectTrashVector()]),
      { uuid: proj, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(row(proj)?.["trashed"]).toBe(1); // original recoverable
    expect(res.repeating?.templateUuid).toBe(res.uuid);
  });

  it("refuses a project holding a nested repeating template (H-CLONE-SOURCE at the promote surface)", async () => {
    const proj = seedProject(fixture.db, { title: "Has repeater", start: "active" });
    seedTodo(fixture.db, { title: "daily thing", project: proj, recurrenceRule: true });
    const res = await runMakeRepeatingProject(
      deps(vector),
      { uuid: proj, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res).toMatchObject({ kind: "blocked", op: "project.make-repeating" });
    if (res.kind === "blocked") {
      expect(res.hazard).toBe("H-CLONE-SOURCE");
      expect(res.detail).toContain("nested repeating template");
    }
    expect(row(proj)?.["trashed"]).toBe(0); // untouched
  });
});

describe("add-repeating — add → native promote", () => {
  it("todo.add-repeating: creates the to-do then promotes it (no trash leg)", async () => {
    const res = await runAddRepeatingTodo(
      deps(vector),
      { title: "New habit", when: "someday", frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(res.op).toBe("todo.add-repeating");
    expect(res.repeating?.templateUuid).toBe(res.uuid);
    const summary = auditRecords.find(
      (r) => r.op === "todo.add-repeating" && r.txn?.role === "summary",
    );
    expect(summary?.observed).not.toHaveProperty("originalUuid");
  });

  it("project.add-repeating: full add vocabulary threads through (area kept)", async () => {
    const area = seedArea(fixture.db, "Finance");
    const res = await runAddRepeatingProject(
      deps(vector),
      {
        title: "Monthly finances",
        area: { uuid: area },
        notes: "reconcile",
        frequency: "monthly",
        interval: 1,
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(res.op).toBe("project.add-repeating");
    expect(row(res.uuid)?.["area"]).toBe(area);
  });

  it("blocks before creating when the GUI-drive ack is missing", async () => {
    const res = await runAddRepeatingTodo(deps(vector), {
      title: "x",
      frequency: "weekly",
      interval: 1,
    });
    expect(res).toMatchObject({ kind: "blocked", hazard: "H-UI-DRIVE" });
    expect(auditRecords.some((r) => r.op === "todo.add")).toBe(false);
  });
});
