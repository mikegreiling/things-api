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
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

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
  certifiedAppVersion: null,
  allowExperimental: false,
  experimentalAreaReorder: true,
  bounceEnabled: true,
  bounceMaxItems: 30,
  autoLaunch: true,
  helpersMode: "false",
  ui: { enabled: false },
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
  [
    "todo.reopen",
    "todo.complete",
    "todo.restore",
    "todo.delete",
    "todo.move",
    "todo.update",
    "area.delete",
  ].map((op) => [op, { support: "yes", disruption: 0, validation: "validated" }]),
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

// The structural precondition guard: an inverse that would OVERWRITE a
// container / status / schedule / trashed axis an out-of-band change already
// moved is refused, unless --acknowledge-out-of-band-changes overrides it.
describe("runUndo — structural precondition guard", () => {
  it("move P→Q then a manual move to R: undo of the move BLOCKS, naming the flag", async () => {
    seedProject(fixture.db, { uuid: "P", title: "Proj P" });
    seedProject(fixture.db, { uuid: "R", title: "Proj R" });
    const uuid = seedTodo(fixture.db, { title: "Task", project: "R" }); // moved out of band to R
    writeAudit([
      auditRecord({
        op: "todo.move",
        uuid,
        requested: { project: { uuid: "Q" } },
        pre: { "project.uuid": "P" },
        observed: { "project.uuid": "Q" },
      }),
    ]);
    const { vector, calls } = fakeVector(() => {
      throw new Error("must not touch the app — the move was clobber-guarded");
    });

    const items = await runUndo(deps([vector]), auditDir);
    expect(items[0]?.outcome).toBe("failed");
    const blocked = items[0]?.results[0];
    expect(blocked?.kind).toBe("blocked");
    if (blocked?.kind === "blocked") {
      expect(blocked.reason).toBe("environment");
      expect(blocked.detail).toContain("project changed since the recorded mutation");
      expect(blocked.remediation).toContain("--acknowledge-out-of-band-changes");
    }
    expect(calls).toHaveLength(0);
  });

  it("the same move undo PROCEEDS and verifies with --acknowledge-out-of-band-changes", async () => {
    seedProject(fixture.db, { uuid: "P", title: "Proj P" });
    seedProject(fixture.db, { uuid: "R", title: "Proj R" });
    const uuid = seedTodo(fixture.db, { title: "Task", project: "R" });
    writeAudit([
      auditRecord({
        op: "todo.move",
        uuid,
        requested: { project: { uuid: "Q" } },
        pre: { "project.uuid": "P" },
        observed: { "project.uuid": "Q" },
      }),
    ]);
    // Forced inverse re-parents the to-do back under P.
    const { vector, calls } = fakeVector(() => touch(uuid, "project = 'P'"));

    const items = await runUndo(deps([vector]), auditDir, {
      acknowledgeOutOfBandChanges: true,
    });
    expect(items[0]?.outcome).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(auditRecords[0]?.actor).toBe("undo:mike");
    expect(auditRecords[0]?.op).toBe("todo.move");
  });

  it("complete then a manual status change: undo of the complete BLOCKS", async () => {
    const uuid = seedTodo(fixture.db, { title: "Done", status: "canceled" }); // moved out of band
    writeAudit([
      auditRecord({
        op: "todo.complete",
        uuid,
        pre: { status: "open" },
        observed: { status: "completed" },
      }),
    ]);
    const { vector, calls } = fakeVector(() => {
      throw new Error("must not touch the app — the status was clobber-guarded");
    });

    const items = await runUndo(deps([vector]), auditDir);
    expect(items[0]?.outcome).toBe("failed");
    const blocked = items[0]?.results[0];
    expect(blocked?.kind).toBe("blocked");
    if (blocked?.kind === "blocked") {
      expect(blocked.detail).toContain("status changed since the recorded mutation");
      expect(blocked.remediation).toContain("--acknowledge-out-of-band-changes");
    }
    expect(calls).toHaveLength(0);
  });

  it("update-schedule then a manual reschedule: undo of the update BLOCKS", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "Sched",
      start: "active",
      startDate: "2026-08-01", // moved out of band to a different date
    });
    writeAudit([
      auditRecord({
        op: "todo.update",
        uuid,
        requested: { when: "someday" }, // the op scheduled it; its inverse restores the prior state
        pre: { start: "someday", startDate: null, reminder: null },
        observed: { start: "active", startDate: "2026-07-05", today: true },
      }),
    ]);
    const { vector, calls } = fakeVector(() => {
      throw new Error("must not touch the app — the schedule was clobber-guarded");
    });

    const items = await runUndo(deps([vector]), auditDir);
    expect(items[0]?.outcome).toBe("failed");
    const blocked = items[0]?.results[0];
    expect(blocked?.kind).toBe("blocked");
    if (blocked?.kind === "blocked") {
      expect(blocked.detail).toContain("schedule changed since the recorded mutation");
    }
    expect(calls).toHaveLength(0);
  });

  it("a CLEAN undo (nothing moved out of band) is unaffected by the guard", async () => {
    const uuid = seedTodo(fixture.db, { title: "Done", status: "completed" }); // still at after-state
    writeAudit([
      auditRecord({
        op: "todo.complete",
        uuid,
        pre: { status: "open" },
        observed: { status: "completed" },
      }),
    ]);
    const { vector, calls } = fakeVector(() => touch(uuid, "status = 0"));

    const items = await runUndo(deps([vector]), auditDir);
    expect(items[0]?.outcome).toBe("ok");
    expect(calls[0]).toContain(`set status of to do id "${uuid}" to open`);
  });

  it("--dry-run surfaces the would-block outcome without executing", async () => {
    const uuid = seedTodo(fixture.db, { title: "Done", status: "canceled" });
    writeAudit([
      auditRecord({
        op: "todo.complete",
        uuid,
        pre: { status: "open" },
        observed: { status: "completed" },
      }),
    ]);
    const { vector, calls } = fakeVector(null);

    const items = await runUndo(deps([vector]), auditDir, { dryRun: true });
    expect(items[0]?.outcome).toBe("dry-run");
    const blocked = items[0]?.results[0];
    expect(blocked?.kind).toBe("blocked");
    if (blocked?.kind === "blocked") {
      expect(blocked.detail).toContain("status changed since the recorded mutation");
    }
    expect(calls).toHaveLength(0);
    expect(auditRecords).toHaveLength(0);
  });
});

/**
 * Symmetric umd-restore — the undo half of `--preserve-modified`, and the
 * classification invariant that rides with it.
 *
 * A forward write made with the flag records each touched row's pre-write
 * `userModificationDate` on the audit record (`preModDates`). Undoing that write
 * restores those values after the inverse legs land, so the reversal is as
 * timeline-silent as the original. This mirrors the app: UMDZ1 (2026-08-28,
 * golden-v4 / Things 3.23) measured the GUI's own ⌘Z RESTORING `umd` to its
 * exact pre-edit value — the stored float, sub-second included — on every
 * undoable gesture it could drive (a completion, a move-to-trash, and REPX3
 * §4.2's template rule edit). The app treats an undo as a restoration of the
 * record, not as a fresh edit.
 *
 * THE INVARIANT (maintainer ruling, 2026-08-28): a modification date that cannot
 * be restored NEVER downgrades an op's reversibility. The restore is best-effort
 * and purely additive — a failed leg, or no AppleScript vector to run one at all,
 * is disclosed in the plan notes and the undo still reports `ok`. `planUndo` must
 * never consult `preModDates` to reach `irreversible`.
 */
describe("runUndo — symmetric umd-restore (--preserve-modified originals)", () => {
  /** A fractional pre-write umd: the AS restore lands on floor() (1-second floor). */
  const PRE_UMD = 1_780_000_000.75;

  /**
   * Seed a completed to-do sitting at its post-write umd and write the audit
   * record for the completion that put it there. `preModDates` is the
   * `--preserve-modified` capture the forward write left behind (omit it for a
   * write made without the flag).
   */
  function seedPreservedCompletion(capture?: { preUmd: number | null }): string {
    const uuid = seedTodo(fixture.db, {
      title: "Done",
      status: "completed",
      modificationDate: NOW_EPOCH,
    });
    writeAudit([
      auditRecord({
        op: "todo.complete",
        uuid,
        pre: { status: "open" },
        ...(capture !== undefined && { preModDates: { [uuid]: capture.preUmd } }),
      }),
    ]);
    return uuid;
  }

  /**
   * A vector that runs the inverse (bumping umd, as a real write does) and
   * applies — or refuses — the `set modification date` restore leg.
   */
  function restoringVector(
    uuid: string,
    opts: { id?: "applescript" | "url-scheme"; failRestore?: boolean } = {},
  ) {
    const calls: string[] = [];
    const vector: WriteVector = {
      id: opts.id ?? "applescript",
      matrix: MATRIX,
      async execute(invocation) {
        calls.push(invocation.payload);
        if (invocation.payload.includes("set modification date")) {
          if (opts.failRestore === true) {
            return { exitCode: 1, stdout: "", stderr: "Things got an error (-1728)" };
          }
          const m = /set modification date of (?:to do|project) id "([^"]+)"/.exec(
            invocation.payload,
          );
          if (m?.[1] !== undefined) {
            fixture.db
              .prepare("UPDATE TMTask SET userModificationDate = ? WHERE uuid = ?")
              .run(Math.floor(PRE_UMD), m[1]);
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        // The inverse itself: reopen the to-do, bumping umd like any real write.
        touch(uuid, "status = 0");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    return { vector, calls };
  }

  const umdOf = (uuid: string): number | null =>
    (
      fixture.db
        .prepare("SELECT userModificationDate AS u FROM TMTask WHERE uuid = ?")
        .get(uuid) as { u: number | null } | undefined
    )?.u ?? null;

  it("restores the captured pre-write umd after the inverse lands, and discloses it", async () => {
    const uuid = seedPreservedCompletion({ preUmd: PRE_UMD });
    const { vector, calls } = restoringVector(uuid);

    const items = await runUndo(deps([vector]), auditDir);
    expect(items[0]?.outcome).toBe("ok");
    expect(items[0]?.plan.kind).toBe("invertible");
    // The inverse ran FIRST, then exactly one restore leg addressing the row.
    const restoreLegs = calls.filter((c) => c.includes("set modification date"));
    expect(restoreLegs).toHaveLength(1);
    expect(restoreLegs[0]).toContain(`set modification date of to do id "${uuid}"`);
    // The umd is back at the floored original — the undo is off the timeline.
    expect(umdOf(uuid)).toBe(Math.floor(PRE_UMD));
    expect(items[0]?.plan.notes.join(" ")).toContain("restored the modification date on 1 row(s)");
  });

  it("a FAILED restore is disclosed and non-fatal — the undo still reports ok", async () => {
    const uuid = seedPreservedCompletion({ preUmd: PRE_UMD });
    const { vector } = restoringVector(uuid, { failRestore: true });

    const items = await runUndo(deps([vector]), auditDir);
    // THE INVARIANT: a umd that cannot be restored never makes an op irreversible.
    expect(items[0]?.outcome).toBe("ok");
    expect(items[0]?.plan.kind).toBe("invertible");
    const notes = items[0]?.plan.notes.join(" ") ?? "";
    expect(notes).toContain("could not restore the modification date");
    expect(notes).toContain("non-fatal");
    // The inverse itself stands; only the timeline silence was lost.
    expect(umdOf(uuid)).toBe(NOW_EPOCH + 1);
  });

  it("no AppleScript vector at all: the inverse still lands and the undo is ok", async () => {
    const uuid = seedPreservedCompletion({ preUmd: PRE_UMD });
    // url-scheme only — `set modification date` is AppleScript-exclusive, so the
    // restore has no surface whatsoever. That is the strongest form of "the
    // modification date cannot be restored", and it must NOT change the verdict.
    const { vector } = restoringVector(uuid, { id: "url-scheme" });

    const items = await runUndo(deps([vector]), auditDir);
    expect(items[0]?.outcome).toBe("ok");
    expect(items[0]?.plan.kind).toBe("invertible");
    expect(items[0]?.plan.notes.join(" ")).toContain(
      "no AppleScript vector is available to restore the modification date",
    );
  });

  it("a create-only capture (all-null preModDates) emits no restore leg and no note", async () => {
    // null = a row the forward op CREATED; its umd is legitimately new.
    const uuid = seedPreservedCompletion({ preUmd: null });
    const { vector, calls } = restoringVector(uuid);

    const items = await runUndo(deps([vector]), auditDir);
    expect(items[0]?.outcome).toBe("ok");
    expect(calls.some((c) => c.includes("set modification date"))).toBe(false);
    expect(items[0]?.plan.notes.join(" ")).not.toContain("modification date");
  });

  it("--dry-run previews the restore without running it", async () => {
    const uuid = seedPreservedCompletion({ preUmd: PRE_UMD });
    const { vector, calls } = restoringVector(uuid);

    const items = await runUndo(deps([vector]), auditDir, { dryRun: true });
    expect(items[0]?.outcome).toBe("dry-run");
    expect(items[0]?.plan.notes.join(" ")).toContain(
      "would restore the modification date on 1 row(s)",
    );
    expect(calls).toHaveLength(0);
  });

  it("a record WITHOUT preModDates (the default) gets no restore leg", async () => {
    const uuid = seedPreservedCompletion();
    const { vector, calls } = restoringVector(uuid);

    const items = await runUndo(deps([vector]), auditDir);
    expect(items[0]?.outcome).toBe("ok");
    expect(calls.some((c) => c.includes("set modification date"))).toBe(false);
    // The undo is an honest timeline entry: umd stays at the inverse's bump.
    expect(umdOf(uuid)).toBe(NOW_EPOCH + 1);
  });
});
