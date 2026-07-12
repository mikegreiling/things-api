/**
 * Reversibility matrix — the systematic per-op suite that locks down
 * `src/write/reversibility.ts`. This is the test that would have caught the
 * `todo.clear-dated-reminder` mislabel: instead of scattered scenario cases, it
 * asserts a CLASS for every `OperationKind` and proves it.
 *
 * Guards (table integrity):
 *  - EXHAUSTIVENESS: every OPERATION_KINDS member has a table entry AND a
 *    registered case here (a new op fails to compile the CASES record, and
 *    fails this test at runtime, until it is classified + covered).
 *  - CLASS AGREEMENT: each case's declared class equals the table's.
 *  - CROSS-CHECK: undo.ts's IRREVERSIBLE keys === the table's `irreversible`
 *    rows, so the two catalogs cannot drift.
 *
 * Per-op proof:
 *  - reversible / reversible-with-loss → a do/undo ROUND-TRIP that drives the
 *    INVERSE through the real pipeline (runMutation / runReorder / the
 *    orchestrators) from a faithfully-modeled forward audit record — the same
 *    harness the write-undo / write-clear-reminder / write-edit-checklist
 *    engine suites use. The fake vector applies the DB change the app would;
 *    the inverse's own verified read-after-write must pass. `-with-loss` cases
 *    additionally assert the DOCUMENTED loss precisely.
 *  - ANTI-CLOBBER: where the inverse writes a CLOBBER_FIELD (title / notes /
 *    deadline / reminder / tags) on a `uuid` target, an out-of-band edit to
 *    that field must make runUndo REFUSE (blocked) and survive. Ops whose
 *    inverse writes no clobber-tracked field skip the precondition by design
 *    (verified read-after-write guards them instead) — noted in the case.
 *  - conditional → BOTH branches (invertible + irreversible).
 *  - irreversible → planUndo returns kind:"irreversible" with the reason.
 *
 * No `open` / `osascript` / `shortcuts run` ever fires — every vector is a
 * fake driven through the WriteDeps seam (CLAUDE.md safety rails: zero live
 * writes, fixture DBs only).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import { byUuid } from "../../src/read/detail.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { encodePackedDate, encodeReminderTime } from "../../src/model/dates.ts";
import { OPERATION_KINDS, type OperationKind } from "../../src/write/operations.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import { runMutation } from "../../src/write/pipeline.ts";
import {
  irreversibleOps,
  REVERSIBILITY,
  type ReversibilityClass,
} from "../../src/write/reversibility.ts";
import { IRREVERSIBLE, planUndo, runUndo } from "../../src/write/undo.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import {
  seedArea,
  seedChecklistItem,
  seedHeading,
  seedProject,
  seedTag,
  seedTodo,
} from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "mike",
  auditEnabled: true,
  acceptedFingerprint: null,
  allowExperimental: true,
  host: "test-host",
};

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let auditDir: string;
let lockSeq = 0;
let modSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
  modSeq = 0;
  auditDir = mkdtempSync(join(tmpdir(), "things-api-revmatrix-"));
});
afterEach(() => {
  fixture.close();
  rmSync(auditDir, { recursive: true, force: true });
});

// ------------------------------------------------------------- deps + vectors

function deps(vectors: WriteVector[], overrides: Partial<WriteDeps> = {}): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-revmatrix-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    sdefProbe: () => true,
    shortcutProxies: () => ({ present: [], missing: [], detail: "test" }),
    pkgVersion: "0.7.0",
    ...overrides,
  };
}

function matrixFor(ops: OperationKind[]): VectorMatrix {
  return Object.fromEntries(
    ops.map((o) => [o, { support: "yes", disruption: 0, validation: "validated" }]),
  ) as VectorMatrix;
}

/** A url-scheme fake: parses `id=` from the payload and applies `effect`. */
function urlVector(
  ops: OperationKind[],
  effect: ((id: string, payload: string) => void) | null,
): { vector: WriteVector; calls: string[] } {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "url-scheme",
    matrix: matrixFor(ops),
    async execute(inv) {
      calls.push(inv.payload);
      if (effect === null) throw new Error("this vector must not dispatch (refusal expected)");
      const id = new URLSearchParams(inv.payload.split("?")[1] ?? "").get("id") ?? "";
      effect(id, inv.payload);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

/** An applescript fake: parses the first `id "…"` and applies `effect`. */
function osaVector(
  ops: OperationKind[],
  effect: ((id: string, payload: string) => void) | null,
): { vector: WriteVector; calls: string[] } {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "applescript",
    matrix: matrixFor(ops),
    async execute(inv) {
      calls.push(inv.payload);
      if (effect === null) throw new Error("this vector must not dispatch (refusal expected)");
      const id = /id "([^"]+)"/.exec(inv.payload)?.[1] ?? "";
      effect(id, inv.payload);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

/** A url-scheme fake that rewrites the fixture checklist from a replace payload. */
function checklistVector(inert = false): { vector: WriteVector; calls: string[] } {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "url-scheme",
    matrix: matrixFor(["todo.replace-checklist"]),
    async execute(inv) {
      calls.push(inv.payload);
      if (inert) throw new Error("the checklist must not be rewritten on a refusal");
      applyChecklistRewrite(inv.payload);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

// ------------------------------------------------------------------ db helpers

/** Set task columns + bump userModificationDate so movement is observable. */
function set(id: string, assignments: string, binds: unknown[] = []): void {
  fixture.db
    .prepare(`UPDATE TMTask SET ${assignments}, userModificationDate = ? WHERE uuid = ?`)
    .run(...(binds as never[]), NOW_EPOCH + ++modSeq, id);
}

function setTaskTags(taskUuid: string, tagUuids: string[]): void {
  fixture.db.prepare("DELETE FROM TMTaskTag WHERE tasks = ?").run(taskUuid);
  for (const t of tagUuids) {
    fixture.db.prepare("INSERT INTO TMTaskTag (tasks, tags) VALUES (?, ?)").run(taskUuid, t);
  }
  set(taskUuid, "userModificationDate = userModificationDate");
}

function epochNoon(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, 12, 0, 0).getTime() / 1000);
}

function readChecklist(uuid: string): { title: string; completed: boolean }[] {
  const rows = fixture.db
    .prepare(`SELECT title, status FROM TMChecklistItem WHERE task = ? ORDER BY "index"`)
    .all(uuid) as { title: string; status: number }[];
  return rows.map((r) => ({ title: r.title, completed: r.status === 3 }));
}

function seedChecklist(
  uuid: string,
  items: { title: string; status?: "open" | "completed" | "canceled" }[],
): void {
  items.forEach((it, i) =>
    seedChecklistItem(fixture.db, uuid, it.title, { status: it.status ?? "open", index: i }),
  );
}

/** Rewrite the fixture checklist to match a compiled replace-checklist payload. */
function applyChecklistRewrite(payload: string): void {
  let uuid: string;
  let specs: { title: string; status: "open" | "completed" }[];
  if (payload.includes("things:///json")) {
    const data = decodeURIComponent((payload.split("data=")[1] ?? "").split("&")[0] ?? "");
    const arr = JSON.parse(data) as {
      id: string;
      attributes: { "checklist-items": { attributes: { title: string; completed?: boolean } }[] };
    }[];
    const op = arr[0];
    if (op === undefined) return;
    uuid = op.id;
    specs = op.attributes["checklist-items"].map((ci) => ({
      title: ci.attributes.title,
      status: ci.attributes.completed === true ? "completed" : "open",
    }));
  } else {
    const params = new URLSearchParams(payload.split("?")[1] ?? "");
    uuid = params.get("id") ?? "";
    specs = (params.get("checklist-items") ?? "")
      .split("\n")
      .filter((s) => s !== "")
      .map((t) => ({ title: t, status: "open" as const }));
  }
  fixture.db.prepare("DELETE FROM TMChecklistItem WHERE task = ?").run(uuid);
  seedChecklist(uuid, specs);
  set(uuid, "userModificationDate = userModificationDate");
}

// ------------------------------------------------------------------- audit io

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
    env: { pkg: "0.7.0", dbVersion: 26, fingerprint: "ok" },
    ...partial,
  };
}

function writeAudit(records: AuditRecord[]): void {
  writeFileSync(join(auditDir, "2026-07.jsonl"), records.map((r) => JSON.stringify(r)).join("\n"));
}

// =============================================================== table checks

describe("reversibility matrix — table integrity", () => {
  it("things capabilities carries each op's undo classification", async () => {
    const { capabilitiesTable } = await import("../../src/write/capabilities.ts");
    for (const entry of capabilitiesTable()) {
      expect(entry.undo).toBe(REVERSIBILITY[entry.op]);
    }
  });

  it("EXHAUSTIVENESS: every operation kind has a table entry AND a registered case", () => {
    for (const op of OPERATION_KINDS) {
      expect(REVERSIBILITY[op], `no reversibility entry for ${op}`).toBeDefined();
      expect(CASES[op], `no round-trip case registered for ${op}`).toBeDefined();
    }
    // No stray keys either — the two records cover EXACTLY OPERATION_KINDS.
    expect(Object.keys(REVERSIBILITY).toSorted()).toEqual([...OPERATION_KINDS].toSorted());
    expect(Object.keys(CASES).toSorted()).toEqual([...OPERATION_KINDS].toSorted());
  });

  it("CLASS AGREEMENT: each registered case's class matches the table", () => {
    for (const op of OPERATION_KINDS) {
      expect(CASES[op].class, `case/table class mismatch for ${op}`).toBe(REVERSIBILITY[op].class);
    }
  });

  it("CROSS-CHECK: undo.ts IRREVERSIBLE keys === the table's irreversible rows", () => {
    expect(Object.keys(IRREVERSIBLE).toSorted()).toEqual(irreversibleOps().toSorted());
  });

  it("every ack-bearing entry names a real acknowledgement", () => {
    for (const op of OPERATION_KINDS) {
      const ack = REVERSIBILITY[op].ack;
      if (ack !== undefined) expect(["permanent", "checklist-reset"]).toContain(ack);
    }
  });
});

// ================================================================ case registry

interface CaseDef {
  class: ReversibilityClass;
  register: () => void;
}

// The Record is TOTAL over OperationKind — a new op is a COMPILE error here
// until it is classified and given a case (belt to the runtime guard's braces).
const CASES: Record<OperationKind, CaseDef> = {
  // ---- creations: inverse deletes what appeared --------------------------
  "todo.add": {
    class: "reversible",
    register() {
      it("round-trip: forward add (real pipeline, uuid discovered) → undo deletes to Trash", async () => {
        // A GENUINE forward mutation through the pipeline, exercising the
        // create-probe uuid discovery seam, then the inverse delete.
        const insert = urlVector(["todo.add"], () => {
          seedTodo(fixture.db, {
            title: "Fresh",
            creationDate: NOW_EPOCH,
            modificationDate: NOW_EPOCH,
          });
        });
        const fwd = await runMutation(deps([insert.vector]), "todo.add", { title: "Fresh" });
        expect(fwd.kind).toBe("ok");
        const created = fwd.kind === "ok" ? fwd.uuid : null;
        expect(created).not.toBeNull();
        writeAudit(auditRecords);

        const del = osaVector(["todo.delete"], (id) => set(id, "trashed = ?", [1]));
        const items = await runUndo(deps([del.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(items[0]?.plan.steps[0]?.op).toBe("todo.delete");
        const row = fixture.db
          .prepare("SELECT trashed FROM TMTask WHERE uuid = ?")
          .get(created) as { trashed: number };
        expect(row.trashed).toBe(1);
      });
      it("irreversible when the created uuid was never discovered", () => {
        expect(planUndo(auditRecord({ op: "todo.add", uuid: null }), NOW).kind).toBe(
          "irreversible",
        );
      });
    },
  },
  "todo.add-logged": {
    class: "reversible",
    register() {
      it("round-trip: undo deletes the logged to-do to the Trash", async () => {
        const uuid = seedTodo(fixture.db, { title: "Logged", status: "completed" });
        writeAudit([auditRecord({ op: "todo.add-logged", uuid })]);
        const del = osaVector(["todo.delete"], (id) => set(id, "trashed = ?", [1]));
        const items = await runUndo(deps([del.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(
          (
            fixture.db.prepare("SELECT trashed FROM TMTask WHERE uuid=?").get(uuid) as {
              trashed: number;
            }
          ).trashed,
        ).toBe(1);
      });
    },
  },
  "todo.duplicate": {
    class: "reversible",
    register() {
      it("round-trip: undo deletes the copy to the Trash", async () => {
        const uuid = seedTodo(fixture.db, { title: "Copy" });
        writeAudit([auditRecord({ op: "todo.duplicate", uuid })]);
        const del = osaVector(["todo.delete"], (id) => set(id, "trashed = ?", [1]));
        const items = await runUndo(deps([del.vector]), auditDir);
        expect(items[0]?.plan.steps[0]?.op).toBe("todo.delete");
        expect(items[0]?.outcome).toBe("ok");
      });
    },
  },
  "project.add": {
    class: "reversible",
    register() {
      it("round-trip: undo deletes the project (children ride along) to the Trash", async () => {
        const uuid = seedProject(fixture.db, { title: "Proj" });
        writeAudit([auditRecord({ op: "project.add", uuid })]);
        const del = osaVector(["project.delete"], (id) => set(id, "trashed = ?", [1]));
        const items = await runUndo(deps([del.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(items[0]?.plan.notes.join(" ")).toContain("Trash");
        expect(
          (
            fixture.db.prepare("SELECT trashed FROM TMTask WHERE uuid=?").get(uuid) as {
              trashed: number;
            }
          ).trashed,
        ).toBe(1);
      });
    },
  },
  "project.duplicate": {
    class: "reversible",
    register() {
      it("round-trip: undo deletes the duplicated project to the Trash", async () => {
        const uuid = seedProject(fixture.db, { title: "ProjCopy" });
        writeAudit([auditRecord({ op: "project.duplicate", uuid })]);
        const del = osaVector(["project.delete"], (id) => set(id, "trashed = ?", [1]));
        const items = await runUndo(deps([del.vector]), auditDir);
        expect(items[0]?.plan.steps[0]?.op).toBe("project.delete");
        expect(items[0]?.outcome).toBe("ok");
      });
    },
  },
  "area.add": {
    class: "reversible",
    register() {
      it("round-trip: undo PERMANENTLY deletes the area (ack required)", async () => {
        const uuid = seedArea(fixture.db, "NewArea");
        writeAudit([auditRecord({ op: "area.add", uuid })]);
        // Without the ack, the inverse is gated.
        const gated = await runUndo(deps([osaVector(["area.delete"], null).vector]), auditDir);
        expect(gated[0]?.outcome).toBe("failed");
        const blocked = gated[0]?.results[0];
        expect(blocked?.kind === "blocked" && blocked.hazard).toBe("H-PERMANENT-DELETE");
        // With the ack, it deletes for real.
        const del = osaVector(["area.delete"], (id) =>
          fixture.db.prepare("DELETE FROM TMArea WHERE uuid = ?").run(id),
        );
        const items = await runUndo(deps([del.vector]), auditDir, { dangerouslyPermanent: true });
        expect(items[0]?.outcome).toBe("ok");
        expect(REVERSIBILITY["area.add"].ack).toBe("permanent");
      });
    },
  },
  "tag.add": {
    class: "reversible",
    register() {
      it("round-trip: undo PERMANENTLY deletes the tag (ack required)", async () => {
        const uuid = seedTag(fixture.db, "NewTag");
        writeAudit([auditRecord({ op: "tag.add", uuid })]);
        const del = osaVector(["tag.delete"], (id) =>
          fixture.db.prepare("DELETE FROM TMTag WHERE uuid = ?").run(id),
        );
        const items = await runUndo(deps([del.vector]), auditDir, { dangerouslyPermanent: true });
        expect(items[0]?.outcome).toBe("ok");
        expect(fixture.db.prepare("SELECT 1 FROM TMTag WHERE uuid=?").get(uuid)).toBeUndefined();
        expect(REVERSIBILITY["tag.add"].ack).toBe("permanent");
      });
    },
  },

  // ---- status flips ------------------------------------------------------
  "todo.complete": {
    class: "reversible",
    register() {
      it("round-trip: undo reopens the completed to-do", async () => {
        const uuid = seedTodo(fixture.db, { title: "Done", status: "completed" });
        writeAudit([auditRecord({ op: "todo.complete", uuid, pre: { status: "open" } })]);
        const v = urlVector(["todo.reopen"], (id) =>
          set(id, "status = ?, stopDate = ?", [0, null]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.plan.steps[0]?.op).toBe("todo.reopen");
        expect(items[0]?.outcome).toBe("ok");
      });
      it("irreversible when the to-do was not open pre-op", () => {
        const plan = planUndo(
          auditRecord({ op: "todo.complete", uuid: "U-1", pre: { status: "completed" } }),
          NOW,
        );
        expect(plan.kind).toBe("irreversible");
        expect(plan.reason).toContain("not open before");
      });
    },
  },
  "todo.cancel": {
    class: "reversible",
    register() {
      it("round-trip: undo reopens the canceled to-do", async () => {
        const uuid = seedTodo(fixture.db, { title: "Cxl", status: "canceled" });
        writeAudit([auditRecord({ op: "todo.cancel", uuid, pre: { status: "open" } })]);
        const v = urlVector(["todo.reopen"], (id) =>
          set(id, "status = ?, stopDate = ?", [0, null]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
      });
    },
  },
  "todo.reopen": {
    class: "reversible",
    register() {
      it("round-trip: undo re-completes per the captured pre-op status", async () => {
        const uuid = seedTodo(fixture.db, { title: "Reop", status: "open" });
        writeAudit([auditRecord({ op: "todo.reopen", uuid, pre: { status: "completed" } })]);
        const v = urlVector(["todo.complete"], (id) =>
          set(id, "status = ?, stopDate = ?", [3, NOW_EPOCH]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.plan.steps[0]?.op).toBe("todo.complete");
        expect(items[0]?.outcome).toBe("ok");
      });
    },
  },
  "project.complete": {
    class: "reversible",
    register() {
      it("round-trip: undo reopens the project AND the cascade-resolved child", async () => {
        const proj = seedProject(fixture.db, { title: "P", status: "completed" });
        const child = seedTodo(fixture.db, { title: "C", status: "completed", project: proj });
        writeAudit([
          auditRecord({
            op: "project.complete",
            uuid: proj,
            pre: { [proj]: { status: "open" }, [child]: { status: "open" } },
          }),
        ]);
        const v = urlVector(["project.reopen", "todo.reopen"], (id) =>
          set(id, "status = ?, stopDate = ?", [0, null]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(items[0]?.plan.steps.map((s) => s.op)).toEqual(["project.reopen", "todo.reopen"]);
      });
    },
  },
  "project.cancel": {
    class: "reversible",
    register() {
      it("round-trip: undo reopens the project AND the cascade-resolved child", async () => {
        const proj = seedProject(fixture.db, { title: "P", status: "canceled" });
        const child = seedTodo(fixture.db, { title: "C", status: "canceled", project: proj });
        writeAudit([
          auditRecord({
            op: "project.cancel",
            uuid: proj,
            pre: { [proj]: { status: "open" }, [child]: { status: "open" } },
          }),
        ]);
        const v = urlVector(["project.reopen", "todo.reopen"], (id) =>
          set(id, "status = ?, stopDate = ?", [0, null]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(items[0]?.plan.steps.map((s) => s.op)).toEqual(["project.reopen", "todo.reopen"]);
      });
    },
  },
  "project.reopen": {
    class: "reversible",
    register() {
      it("round-trip: undo re-completes (require-resolved) per the pre-op status", async () => {
        const proj = seedProject(fixture.db, { title: "P", status: "open" });
        writeAudit([
          auditRecord({ op: "project.reopen", uuid: proj, pre: { status: "completed" } }),
        ]);
        const v = urlVector(["project.complete"], (id) =>
          set(id, "status = ?, stopDate = ?", [3, NOW_EPOCH]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.plan.steps[0]?.op).toBe("project.complete");
        expect(items[0]?.outcome).toBe("ok");
      });
    },
  },

  // ---- delete / restore --------------------------------------------------
  "todo.delete": {
    class: "reversible-with-loss",
    register() {
      it("round-trip + LOSS: undo restores from the Trash but lands in the Inbox de-scheduled", async () => {
        const uuid = seedTodo(fixture.db, { title: "T", trashed: true, startDate: "2026-07-20" });
        writeAudit([auditRecord({ op: "todo.delete", uuid, pre: { trashed: false } })]);
        const v = osaVector(["todo.restore"], (id) =>
          set(id, "trashed = ?, start = ?, startDate = ?", [0, 0, null]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        // Documented loss: the prior schedule is NOT restored — Inbox, de-scheduled (E15).
        expect(items[0]?.plan.notes.join(" ")).toContain("Inbox");
        expect(items[0]?.plan.notes.join(" ")).toContain("DE-SCHEDULED");
        const row = fixture.db
          .prepare("SELECT trashed, start, startDate FROM TMTask WHERE uuid=?")
          .get(uuid) as {
          trashed: number;
          start: number;
          startDate: number | null;
        };
        expect(row.trashed).toBe(0);
        expect(row.start).toBe(0); // Inbox
        expect(row.startDate).toBeNull();
      });
    },
  },
  "todo.restore": {
    class: "reversible",
    register() {
      it("round-trip: undo re-deletes the to-do to the Trash", async () => {
        const uuid = seedTodo(fixture.db, { title: "R", trashed: false });
        writeAudit([auditRecord({ op: "todo.restore", uuid })]);
        const v = osaVector(["todo.delete"], (id) => set(id, "trashed = ?", [1]));
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.plan.steps[0]?.op).toBe("todo.delete");
        expect(items[0]?.outcome).toBe("ok");
      });
    },
  },
  "project.delete": {
    class: "reversible",
    register() {
      it("round-trip: undo restores the project IN PLACE (P06)", async () => {
        const uuid = seedProject(fixture.db, { title: "P", trashed: true });
        writeAudit([auditRecord({ op: "project.delete", uuid, pre: { trashed: false } })]);
        const v = osaVector(["project.restore"], (id) => set(id, "trashed = ?", [0]));
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(items[0]?.plan.notes.join(" ")).toContain("IN PLACE");
      });
    },
  },
  "project.restore": {
    class: "reversible",
    register() {
      it("round-trip: undo re-deletes the project to the Trash", async () => {
        const uuid = seedProject(fixture.db, { title: "P", trashed: false });
        writeAudit([auditRecord({ op: "project.restore", uuid })]);
        const v = osaVector(["project.delete"], (id) => set(id, "trashed = ?", [1]));
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.plan.steps[0]?.op).toBe("project.delete");
        expect(items[0]?.outcome).toBe("ok");
      });
    },
  },

  // ---- field updates -----------------------------------------------------
  "todo.update": {
    class: "reversible-with-loss",
    register() {
      it("round-trip: undo restores title/notes from pre-values", async () => {
        const uuid = seedTodo(fixture.db, { title: "New", notes: "new body" });
        writeAudit([
          auditRecord({
            op: "todo.update",
            uuid,
            requested: { title: "New", notes: "new body" },
            pre: { title: "Old", notes: "old body" },
            observed: { title: "New", notes: "new body" },
          }),
        ]);
        const v = urlVector(["todo.update"], (id) =>
          set(id, "title = ?, notes = ?", ["Old", "old body"]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        const row = fixture.db
          .prepare("SELECT title, notes FROM TMTask WHERE uuid=?")
          .get(uuid) as {
          title: string;
          notes: string;
        };
        expect(row).toEqual({ title: "Old", notes: "old body" });
      });
      it("anti-clobber: an out-of-band title edit blocks the inverse (title survives)", async () => {
        const uuid = seedTodo(fixture.db, { title: "Hijacked", notes: "new body" });
        writeAudit([
          auditRecord({
            op: "todo.update",
            uuid,
            requested: { title: "New" },
            pre: { title: "Old" },
            observed: { title: "New" },
          }),
        ]);
        const v = urlVector(["todo.update"], null);
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("failed");
        const blocked = items[0]?.results[0];
        expect(blocked?.kind).toBe("blocked");
        if (blocked?.kind === "blocked")
          expect(blocked.detail).toContain("title changed since the recorded mutation");
        expect(
          (
            fixture.db.prepare("SELECT title FROM TMTask WHERE uuid=?").get(uuid) as {
              title: string;
            }
          ).title,
        ).toBe("Hijacked");
      });
      it("LOSS: a dated reminder the op SET cannot be cleared on undo (sticky, R20/R21)", () => {
        const plan = planUndo(
          auditRecord({
            op: "todo.update",
            uuid: "U-1",
            requested: { when: "2026-07-20", reminder: "10:00" },
            pre: { start: "someday", startDate: "2026-07-20", todaySection: null, reminder: null },
          }),
          NOW,
        );
        expect(plan.notes.join(" ")).toContain("sticky");
        expect("reminder" in (plan.steps[0]?.params ?? {})).toBe(false);
      });
    },
  },
  "project.update": {
    class: "reversible-with-loss",
    register() {
      it("round-trip: undo restores title/notes from pre-values", async () => {
        const uuid = seedProject(fixture.db, { title: "New", notes: "new body" });
        writeAudit([
          auditRecord({
            op: "project.update",
            uuid,
            requested: { title: "New", notes: "new body" },
            pre: { title: "Old", notes: "old body" },
            observed: { title: "New", notes: "new body" },
          }),
        ]);
        const v = urlVector(["project.update"], (id) =>
          set(id, "title = ?, notes = ?", ["Old", "old body"]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(
          (
            fixture.db.prepare("SELECT title FROM TMTask WHERE uuid=?").get(uuid) as {
              title: string;
            }
          ).title,
        ).toBe("Old");
      });
      it("anti-clobber: an out-of-band notes edit blocks the inverse", async () => {
        const uuid = seedProject(fixture.db, { title: "New", notes: "hijacked" });
        writeAudit([
          auditRecord({
            op: "project.update",
            uuid,
            requested: { notes: "new body" },
            pre: { notes: "old body" },
            observed: { notes: "new body" },
          }),
        ]);
        const items = await runUndo(deps([urlVector(["project.update"], null).vector]), auditDir);
        expect(items[0]?.outcome).toBe("failed");
        expect(items[0]?.results[0]?.kind).toBe("blocked");
        expect(
          (
            fixture.db.prepare("SELECT notes FROM TMTask WHERE uuid=?").get(uuid) as {
              notes: string;
            }
          ).notes,
        ).toBe("hijacked");
      });
    },
  },
  "todo.set-tags": {
    class: "reversible",
    register() {
      it("round-trip: undo restores the captured pre-op tag set", async () => {
        const a = seedTag(fixture.db, "a");
        const c = seedTag(fixture.db, "c");
        const b = seedTag(fixture.db, "b");
        const uuid = seedTodo(fixture.db, { title: "T" });
        setTaskTags(uuid, [b]);
        writeAudit([
          auditRecord({
            op: "todo.set-tags",
            uuid,
            requested: { tags: ["b"] },
            pre: { tags: ["a", "c"] },
            observed: { tags: ["b"] },
          }),
        ]);
        const v = urlVector(["todo.set-tags"], (id) => setTaskTags(id, [a, c]));
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        const tags = (
          fixture.db
            .prepare(
              "SELECT t.title FROM TMTaskTag tt JOIN TMTag t ON tt.tags=t.uuid WHERE tt.tasks=?",
            )
            .all(uuid) as { title: string }[]
        )
          .map((r) => r.title)
          .toSorted();
        expect(tags).toEqual(["a", "c"]);
      });
      it("anti-clobber: an out-of-band tag change blocks the inverse (tags survive)", async () => {
        const z = seedTag(fixture.db, "z");
        const uuid = seedTodo(fixture.db, { title: "T" });
        setTaskTags(uuid, [z]);
        writeAudit([
          auditRecord({
            op: "todo.set-tags",
            uuid,
            requested: { tags: ["b"] },
            pre: { tags: ["a"] },
            observed: { tags: ["b"] },
          }),
        ]);
        const items = await runUndo(deps([urlVector(["todo.set-tags"], null).vector]), auditDir);
        expect(items[0]?.outcome).toBe("failed");
        expect(items[0]?.results[0]?.kind).toBe("blocked");
      });
    },
  },
  "project.set-tags": {
    class: "reversible",
    register() {
      it("round-trip: undo restores the captured pre-op tag set", async () => {
        const a = seedTag(fixture.db, "a");
        const b = seedTag(fixture.db, "b");
        const uuid = seedProject(fixture.db, { title: "P" });
        setTaskTags(uuid, [b]);
        writeAudit([
          auditRecord({
            op: "project.set-tags",
            uuid,
            requested: { tags: ["b"] },
            pre: { tags: ["a"] },
            observed: { tags: ["b"] },
          }),
        ]);
        const v = urlVector(["project.set-tags"], (id) => setTaskTags(id, [a]));
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(
          (
            fixture.db
              .prepare(
                "SELECT t.title FROM TMTaskTag tt JOIN TMTag t ON tt.tags=t.uuid WHERE tt.tasks=?",
              )
              .all(uuid) as { title: string }[]
          ).map((r) => r.title),
        ).toEqual(["a"]);
      });
    },
  },
  "area.update": {
    class: "reversible",
    register() {
      it("round-trip: undo restores the captured pre-op title (precondition skipped — target, not uuid)", async () => {
        // area.update's inverse addresses the area by `target`, not `uuid`, so
        // checkStepPrecondition (uuid-keyed) does not apply — the inverse's own
        // verified read-after-write is the anti-clobber guard here.
        const uuid = seedArea(fixture.db, "New");
        writeAudit([
          auditRecord({
            op: "area.update",
            uuid,
            requested: { title: "New" },
            pre: { title: "Old" },
            observed: { title: "New" },
          }),
        ]);
        const v = osaVector(["area.update"], (id) =>
          fixture.db.prepare("UPDATE TMArea SET title = ? WHERE uuid = ?").run("Old", id),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(
          (
            fixture.db.prepare("SELECT title FROM TMArea WHERE uuid=?").get(uuid) as {
              title: string;
            }
          ).title,
        ).toBe("Old");
      });
    },
  },
  "tag.update": {
    class: "reversible",
    register() {
      it("round-trip: undo restores the captured pre-op title", async () => {
        const uuid = seedTag(fixture.db, "New");
        writeAudit([
          auditRecord({
            op: "tag.update",
            uuid,
            requested: { title: "New" },
            pre: { title: "Old" },
            observed: { title: "New" },
          }),
        ]);
        const v = osaVector(["tag.update"], (id) =>
          fixture.db.prepare("UPDATE TMTag SET title = ? WHERE uuid = ?").run("Old", id),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(
          (
            fixture.db.prepare("SELECT title FROM TMTag WHERE uuid=?").get(uuid) as {
              title: string;
            }
          ).title,
        ).toBe("Old");
      });
      it("irreversible when none of the changed fields were captured", () => {
        const plan = planUndo(
          auditRecord({ op: "tag.update", uuid: "U-1", requested: { title: "x" }, pre: {} }),
          NOW,
        );
        expect(plan.kind).toBe("irreversible");
        expect(plan.reason).toContain("none of the changed tag fields");
      });
    },
  },
  "heading.rename": {
    class: "reversible",
    register() {
      it("round-trip: undo renames the heading back to the pre-op title", async () => {
        const uuid = seedHeading(fixture.db, { title: "New" });
        writeAudit([
          auditRecord({
            op: "heading.rename",
            uuid,
            requested: { title: "New" },
            pre: { title: "Old" },
            observed: { title: "New" },
          }),
        ]);
        const v = osaVector(["heading.rename"], (id) => set(id, "title = ?", ["Old"]));
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(
          (
            fixture.db.prepare("SELECT title FROM TMTask WHERE uuid=?").get(uuid) as {
              title: string;
            }
          ).title,
        ).toBe("Old");
      });
      it("anti-clobber: an out-of-band rename blocks the inverse (title survives)", async () => {
        const uuid = seedHeading(fixture.db, { title: "Hijacked" });
        writeAudit([
          auditRecord({
            op: "heading.rename",
            uuid,
            requested: { title: "New" },
            pre: { title: "Old" },
            observed: { title: "New" },
          }),
        ]);
        const items = await runUndo(deps([osaVector(["heading.rename"], null).vector]), auditDir);
        expect(items[0]?.outcome).toBe("failed");
        expect(items[0]?.results[0]?.kind).toBe("blocked");
        expect(
          (
            fixture.db.prepare("SELECT title FROM TMTask WHERE uuid=?").get(uuid) as {
              title: string;
            }
          ).title,
        ).toBe("Hijacked");
      });
    },
  },
  "todo.backdate": {
    class: "reversible-with-loss",
    register() {
      it("round-trip + LOSS: undo restores the timestamp at DAY precision only", async () => {
        const uuid = seedTodo(fixture.db, {
          title: "B",
          status: "completed",
          stopDate: epochNoon("2026-06-01"),
        });
        writeAudit([
          auditRecord({
            op: "todo.backdate",
            uuid,
            requested: { completionDate: "2026-06-01" },
            pre: { stoppedDate: "2026-05-15" },
          }),
        ]);
        const v = osaVector(["todo.backdate"], (id) =>
          set(id, "stopDate = ?", [epochNoon("2026-05-15")]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(items[0]?.plan.notes.join(" ")).toContain("DAY precision");
        // Restored to the captured DAY (noon local) — sub-day time is unrecoverable.
        expect(
          (
            fixture.db.prepare("SELECT stopDate FROM TMTask WHERE uuid=?").get(uuid) as {
              stopDate: number;
            }
          ).stopDate,
        ).toBe(epochNoon("2026-05-15"));
      });
    },
  },

  // ---- moves (conditional) -----------------------------------------------
  "todo.move": {
    class: "conditional",
    register() {
      it("invertible branch: undo moves the to-do back to the captured project", async () => {
        const oldProj = seedProject(fixture.db, { title: "Old" });
        const newProj = seedProject(fixture.db, { title: "New" });
        const uuid = seedTodo(fixture.db, { title: "T", project: newProj });
        writeAudit([
          auditRecord({
            op: "todo.move",
            uuid,
            requested: { project: {} },
            pre: { "project.uuid": oldProj },
          }),
        ]);
        // The inverse writes `project` (not a CLOBBER_FIELD) — anti-clobber is
        // the pipeline's verified read-after-write, not checkStepPrecondition.
        const v = urlVector(["todo.move"], (id) =>
          set(id, "project = ?, heading = ?", [oldProj, null]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(
          (
            fixture.db.prepare("SELECT project FROM TMTask WHERE uuid=?").get(uuid) as {
              project: string;
            }
          ).project,
        ).toBe(oldProj);
      });
      it("irreversible branch: only the destination-kind field was audited", () => {
        const plan = planUndo(
          auditRecord({
            op: "todo.move",
            uuid: "U-1",
            requested: { project: {} },
            pre: { "project.uuid": null },
          }),
          NOW,
        );
        expect(plan.kind).toBe("irreversible");
        expect(plan.reason).toContain("not fully captured");
      });
    },
  },
  "project.move": {
    class: "conditional",
    register() {
      it("invertible branch: undo moves the project back to the captured area", async () => {
        const oldArea = seedArea(fixture.db, "Old");
        const newArea = seedArea(fixture.db, "New");
        const uuid = seedProject(fixture.db, { title: "P", area: newArea });
        writeAudit([
          auditRecord({
            op: "project.move",
            uuid,
            requested: { area: {} },
            pre: { "area.uuid": oldArea },
          }),
        ]);
        const v = urlVector(["project.move"], (id) =>
          set(id, "area = ?, project = ?", [oldArea, null]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(
          (fixture.db.prepare("SELECT area FROM TMTask WHERE uuid=?").get(uuid) as { area: string })
            .area,
        ).toBe(oldArea);
      });
      it("no-area-before inverts to a detach (P24)", () => {
        const plan = planUndo(
          auditRecord({ op: "project.move", uuid: "U-1", pre: { "area.uuid": null } }),
          NOW,
        );
        expect(plan.kind).toBe("invertible");
        expect(plan.steps[0]?.params["detach"]).toBe(true);
      });
      it("irreversible branch: the pre-op area was not captured", () => {
        const plan = planUndo(auditRecord({ op: "project.move", uuid: "U-1", pre: {} }), NOW);
        expect(plan.kind).toBe("irreversible");
        expect(plan.reason).toContain("area was not captured");
      });
    },
  },

  // ---- checklists --------------------------------------------------------
  "todo.replace-checklist": {
    class: "reversible-with-loss",
    register() {
      it("round-trip + LOSS: restores titles/states via json; canceled items round-trip as OPEN", async () => {
        const uuid = seedTodo(fixture.db, { title: "list" });
        seedChecklist(uuid, [{ title: "Solo" }]);
        writeAudit([
          auditRecord({
            op: "todo.replace-checklist",
            uuid,
            requested: { uuid, items: ["Solo"] },
            pre: { checklistTitles: ["X", "Done"], checklistStates: ["open", "canceled"] },
            observed: { checklistTitles: ["Solo"], checklistStates: ["open"] },
          }),
        ]);
        const v = checklistVector();
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(v.calls[0]).toContain("things:///json");
        expect(items[0]?.plan.notes.join(" ")).toContain("canceled");
        // The canceled item comes back OPEN (no canceled-create surface) — the loss.
        expect(readChecklist(uuid)).toEqual([
          { title: "X", completed: false },
          { title: "Done", completed: false },
        ]);
      });
      it("anti-clobber: ANY out-of-band checklist difference blocks the wholesale undo", async () => {
        const uuid = seedTodo(fixture.db, { title: "list" });
        seedChecklist(uuid, [{ title: "Solo" }, { title: "Sneaked" }]);
        writeAudit([
          auditRecord({
            op: "todo.replace-checklist",
            uuid,
            requested: { uuid, items: ["Solo"] },
            pre: { checklistTitles: ["X"], checklistStates: ["open"] },
            observed: { checklistTitles: ["Solo"], checklistStates: ["open"] },
          }),
        ]);
        const items = await runUndo(deps([checklistVector(true).vector]), auditDir);
        expect(items[0]?.outcome).toBe("failed");
        expect(items[0]?.results[0]?.kind).toBe("blocked");
        expect(readChecklist(uuid).map((i) => i.title)).toEqual(["Solo", "Sneaked"]);
      });
    },
  },
  "todo.edit-checklist-item": {
    class: "conditional",
    register() {
      it("invertible branch: undo reverts ONLY the targeted item (3-way merge)", async () => {
        const uuid = seedTodo(fixture.db, { title: "list" });
        seedChecklist(uuid, [
          { title: "A", status: "completed" }, // out-of-band check survives
          { title: "C", status: "completed" }, // the CLI-checked target
        ]);
        writeAudit([
          auditRecord({
            op: "todo.edit-checklist-item",
            uuid,
            requested: { uuid, action: "check", title: "C", position: 2 },
            pre: { title: "C", completed: false, position: 2 },
            observed: { title: "C", completed: true, position: 2 },
          }),
        ]);
        const items = await runUndo(deps([checklistVector().vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(readChecklist(uuid)).toEqual([
          { title: "A", completed: true },
          { title: "C", completed: false },
        ]);
      });
      it("irreversible-at-plan / blocked branch: refuses when the targeted item moved out of band", async () => {
        const uuid = seedTodo(fixture.db, { title: "list" });
        seedChecklist(uuid, [{ title: "C", status: "open" }]); // C is open again
        writeAudit([
          auditRecord({
            op: "todo.edit-checklist-item",
            uuid,
            requested: { uuid, action: "check", title: "C", position: 1 },
            pre: { title: "C", completed: false, position: 1 },
            observed: { title: "C", completed: true, position: 1 },
          }),
        ]);
        const items = await runUndo(deps([checklistVector(true).vector]), auditDir);
        expect(items[0]?.outcome).toBe("failed");
        const blocked = items[0]?.results[0];
        expect(blocked?.kind).toBe("blocked");
        if (blocked?.kind === "blocked") expect(blocked.detail).toContain("out of band");
      });
    },
  },

  // ---- reorder (conditional) ---------------------------------------------
  reorder: {
    class: "conditional",
    register() {
      it("invertible branch: a native reorder inverts to the pre-rank sequence", () => {
        const plan = planUndo(
          auditRecord({
            op: "reorder",
            uuid: null,
            requested: { scope: "today", uuids: ["A", "B"] },
            pre: { A: 20, B: 10 },
          }),
          NOW,
        );
        expect(plan.kind).toBe("invertible");
        expect(plan.steps[0]).toEqual({
          op: "reorder",
          params: { scope: "today", uuids: ["B", "A"] },
        });
      });
      it("irreversible branch: a bounce summary with no captured pre-ranks", () => {
        const plan = planUndo(
          auditRecord({
            op: "reorder",
            uuid: null,
            requested: { scope: "evening", uuids: ["A"] },
            pre: null,
          }),
          NOW,
        );
        expect(plan.kind).toBe("irreversible");
        expect(plan.reason).toContain("legs");
      });
    },
  },

  // ---- headings ----------------------------------------------------------
  "heading.archive": {
    class: "reversible-with-loss",
    register() {
      it("round-trip + LOSS: undo reopens ONLY the cascade-resolved child (pre-resolved stays)", async () => {
        const heading = seedHeading(fixture.db, { title: "Phase 1", status: "completed" });
        const openChild = seedTodo(fixture.db, { title: "open", status: "completed", heading });
        const doneChild = seedTodo(fixture.db, { title: "done", status: "completed", heading });
        writeAudit([
          auditRecord({
            op: "heading.archive",
            uuid: heading,
            requested: { uuid: heading, children: "complete" },
            pre: {
              [heading]: { status: "open", title: "Phase 1" },
              [openChild]: { status: "open" },
              [doneChild]: { status: "completed" }, // resolved BEFORE the archive
            },
            observed: { status: "completed", title: "Phase 1" },
          }),
        ]);
        const v = osaVector(["heading.unarchive", "todo.reopen"], (id) =>
          set(id, "status = ?, stopDate = ?", [0, null]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(items[0]?.plan.steps.map((s) => s.op)).toEqual(["heading.unarchive", "todo.reopen"]);
        // The documented loss: undo is state-aware — a child resolved outside the
        // cascade is NOT reopened (only openChild returns to open).
        expect(
          (
            fixture.db.prepare("SELECT status FROM TMTask WHERE uuid=?").get(openChild) as {
              status: number;
            }
          ).status,
        ).toBe(0);
        expect(
          (
            fixture.db.prepare("SELECT status FROM TMTask WHERE uuid=?").get(doneChild) as {
              status: number;
            }
          ).status,
        ).toBe(3);
      });
    },
  },
  "heading.unarchive": {
    class: "reversible",
    register() {
      it("round-trip: undo re-archives the heading (children: complete)", async () => {
        const heading = seedHeading(fixture.db, { title: "Phase 1", status: "open" });
        writeAudit([
          auditRecord({ op: "heading.unarchive", uuid: heading, pre: { status: "completed" } }),
        ]);
        const v = osaVector(["heading.archive"], (id) =>
          set(id, "status = ?, stopDate = ?", [3, NOW_EPOCH]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.plan.steps[0]?.op).toBe("heading.archive");
        expect(items[0]?.outcome).toBe("ok");
      });
    },
  },

  // ---- clear-dated-reminder (conditional, orchestrated inverse) ----------
  "todo.clear-dated-reminder": {
    class: "conditional",
    register() {
      it("invertible branch: undo re-attaches the reminder to the item's CURRENT schedule", async () => {
        const uuid = seedTodo(fixture.db, {
          title: "cleared",
          startDate: "2026-07-20",
          reminder: null,
        });
        writeAudit([
          auditRecord({
            op: "todo.clear-dated-reminder",
            uuid,
            pre: { reminder: "09:30", startDate: "2026-07-20" },
            observed: { reminder: null, startDate: "2026-07-20" },
          }),
        ]);
        const v = urlVector(["todo.update"], (id) =>
          set(id, "reminderTime = ?, startDate = ?", [
            encodeReminderTime("09:30"),
            encodePackedDate("2026-07-20"),
          ]),
        );
        const items = await runUndo(deps([v.vector]), auditDir);
        expect(items[0]?.outcome).toBe("ok");
        expect(items[0]?.plan.steps[0]?.op).toBe("todo.update");
        expect(
          (
            fixture.db.prepare("SELECT reminderTime FROM TMTask WHERE uuid=?").get(uuid) as {
              reminderTime: number;
            }
          ).reminderTime,
        ).toBe(encodeReminderTime("09:30"));
      });
      it("anti-clobber: a reminder set out of band blocks the inverse (survives)", async () => {
        const uuid = seedTodo(fixture.db, {
          title: "touched",
          startDate: "2026-07-20",
          reminder: "07:00",
        });
        writeAudit([
          auditRecord({
            op: "todo.clear-dated-reminder",
            uuid,
            pre: { reminder: "09:30", startDate: "2026-07-20" },
            observed: { reminder: null, startDate: "2026-07-20" },
          }),
        ]);
        const items = await runUndo(deps([urlVector(["todo.update"], null).vector]), auditDir);
        expect(items[0]?.outcome).toBe("failed");
        expect(items[0]?.results[0]?.kind).toBe("blocked");
        expect(
          (
            fixture.db.prepare("SELECT reminderTime FROM TMTask WHERE uuid=?").get(uuid) as {
              reminderTime: number;
            }
          ).reminderTime,
        ).toBe(encodeReminderTime("07:00"));
      });
      it("irreversible branch: the item is no longer scheduled", () => {
        const uuid = seedTodo(fixture.db, {
          title: "descheduled",
          startDate: null,
          reminder: null,
        });
        const record = auditRecord({
          op: "todo.clear-dated-reminder",
          uuid,
          pre: { reminder: "09:30", startDate: "2026-07-20" },
          observed: { reminder: null, startDate: "2026-07-20" },
        });
        const current = fixtureCurrent(uuid);
        const plan = planUndo(record, NOW, [], current);
        expect(plan.kind).toBe("irreversible");
        expect(plan.reason).toContain("no longer scheduled");
      });
    },
  },

  // ---- irreversible ------------------------------------------------------
  "area.delete": {
    class: "irreversible",
    register() {
      it("planUndo reports it irreversible with the permanent-delete reason", () => {
        const plan = planUndo(auditRecord({ op: "area.delete" }), NOW);
        expect(plan.kind).toBe("irreversible");
        expect(plan.reason).toContain("permanently");
      });
    },
  },
  "tag.delete": {
    class: "irreversible",
    register() {
      it("planUndo reports it irreversible (assignments already cascaded)", () => {
        const plan = planUndo(auditRecord({ op: "tag.delete" }), NOW);
        expect(plan.kind).toBe("irreversible");
        expect(plan.reason).toContain("permanently");
      });
    },
  },
  "trash.empty": {
    class: "irreversible",
    register() {
      it("planUndo reports it irreversible (hard delete)", () => {
        const plan = planUndo(auditRecord({ op: "trash.empty", uuid: null }), NOW);
        expect(plan.kind).toBe("irreversible");
        expect(plan.reason).toContain("Trash");
      });
    },
  },
  "heading.create": {
    class: "irreversible",
    register() {
      it("planUndo reports it irreversible (no headless delete surface)", () => {
        const plan = planUndo(auditRecord({ op: "heading.create", uuid: "H-1" }), NOW);
        expect(plan.kind).toBe("irreversible");
        expect(plan.reason).toContain("interactive-only");
      });
    },
  },
};

/** Decode a seeded to-do to the shape planUndo's clear-reminder path reads. */
function fixtureCurrent(uuid: string) {
  return byUuid(fixture.db, uuid);
}

for (const op of OPERATION_KINDS) {
  describe(op, () => {
    CASES[op].register();
  });
}
