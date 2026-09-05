/**
 * THE COMPOSITE MUTATION LOCK, adopted by the remaining multi-leg orchestrators
 * (maintainer ruling 2026-09-05, #676).
 *
 * The promote verbs took the composite hold in 2026-08; everything else was
 * still per-leg, which means another writer could land between any two legs of a
 * read-modify-write. These cells hold the line for the rest of the family:
 *
 *  - a variadic `todo.move` runs every leg under ONE lockfile — same inode from
 *    the first leg to the last, and gone when the verb returns;
 *  - `area.reorder` — the ruling's own subject, whose drag geometry is planned
 *    from a census and would be invalidated by any concurrent sidebar write —
 *    refuses under contention BEFORE it drives anything;
 *  - so do the other read-modify-write verbs the queue named: the universal
 *    reorder's bounce protocols, the whole-checklist edit, and the heading
 *    archive/unarchive pair;
 *  - and a DRY RUN never queues behind a live writer, because it mutates
 *    nothing.
 *
 * The refusal is asserted by its sentence, not just its shape: a caller who
 * cannot write needs to know WHAT is holding the lock and since when.
 */
import { statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runEditChecklist } from "../../src/write/edit-checklist.ts";
import { runHeadingArchive, runHeadingUnarchive } from "../../src/write/heading.ts";
import { runProjectMove, runTodoMove, runUniversalReorder } from "../../src/write/move.ts";
import { readLockHolder } from "../../src/write/lock.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import { runReorder } from "../../src/write/reorder.ts";
import type { WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import {
  seedArea,
  seedChecklistItem,
  seedHeading,
  seedProject,
  seedTodo,
} from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockPath: string;
let lockSeq = 0;
let modClock = 1_790_000_000;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
  lockPath = join(tmpdir(), `things-api-composite-lock-${process.pid}-${lockSeq++}`);
});
afterEach(() => {
  fixture.close();
  try {
    unlinkSync(lockPath);
  } catch {
    // absent is the expected state for most cells
  }
});

function okFingerprint(): FingerprintStatus {
  return { kind: "ok", observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:t" } };
}

function config(): ThingsApiConfig {
  return {
    profile: "workstation",
    maxDisruption: 1,
    actor: "test-actor",
    auditEnabled: true,
    acceptedFingerprint: null,
    certifiedAppVersion: null,
    allowExperimental: true,
    experimentalAreaReorder: true,
    bounceEnabled: true,
    bounceMaxItems: 30,
    autoLaunch: true,
    helpersMode: "false",
    ui: { enabled: false },
    host: "test-host",
  };
}

/** What each leg saw while it ran: the lockfile's inode and the op it names. */
let legsSeen: { ino: number; holderOp: string | undefined }[] = [];

/** A membership vector that also records what the lockfile said during the leg. */
function movingVector(): WriteVector {
  return {
    id: "url-scheme",
    matrix: {
      "todo.move": { support: "yes", disruption: 0, validation: "validated" },
      "todo.update": { support: "yes", disruption: 0, validation: "validated" },
      "todo.replace-checklist": { support: "yes", disruption: 0, validation: "validated" },
      "project.move": { support: "yes", disruption: 0, validation: "validated" },
      "project.update": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(invocation) {
      legsSeen.push({
        ino: statSync(lockPath).ino,
        holderOp: readLockHolder(lockPath).holder?.op,
      });
      const p = (invocation.opParams ?? {}) as Record<string, unknown>;
      const uuid = p["uuid"] as string;
      if (invocation.op === "project.move" && p["area"] !== undefined) {
        const area = (p["area"] as { uuid?: string }).uuid ?? null;
        fixture.db
          .prepare("UPDATE TMTask SET area = ?, userModificationDate = ? WHERE uuid = ?")
          .run(area, modClock++, uuid);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function deps(vectors: WriteVector[], overrides: Partial<WriteDeps> = {}): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: config(),
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath,
    // Contention must be OBSERVED, not waited out: every cell below that meets a
    // held lock would otherwise sit through the 30s default.
    lockWaitMs: 0,
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    sdefProbe: () => true,
    ...overrides,
  };
}

/**
 * Install a lockfile held by a LIVE process — this one. Our own pid is honest
 * (it really is running) and it is NOT reentrant: the composite hold lives on
 * the async context, which a lockfile written from outside never enters.
 */
function heldByAnotherWriter(op: string): void {
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, ts: "2026-07-05T11:59:00.000Z", op }),
    { flag: "w" },
  );
}

/** The refusal a contended writer must get: it NAMES the holder and the time. */
function namesTheHolder(detail: string, op: string): void {
  expect(detail).toContain(`another operation holds the mutation lock: ${op}`);
  expect(detail).toContain("since 2026-07-05T11:59:00.000Z");
}

describe("one lock, end to end, across a verb's legs", () => {
  it("a variadic project move runs every leg under the SAME lockfile, and releases it", async () => {
    const area = seedArea(fixture.db, "A", 0);
    const p1 = seedProject(fixture.db, { title: "P1" });
    const p2 = seedProject(fixture.db, { title: "P2" });
    const p3 = seedProject(fixture.db, { title: "P3" });
    legsSeen = [];

    const result = await runProjectMove(
      deps([movingVector()]),
      { uuids: [p1, p2, p3], destination: { kind: "area", ref: { uuid: area } } },
      { verifyTimeoutMs: 300 },
    );

    expect(result.kind).toBe("move-ok");
    // Three legs ran, and all three saw ONE lockfile — not three acquisitions
    // with three windows between them…
    expect(legsSeen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(legsSeen.map((l) => l.ino)).size).toBe(1);
    // …taken by the VERB, not by its legs: a leg that had taken its own lock
    // would have written its OWN op into the file.
    expect(new Set(legsSeen.map((l) => l.holderOp))).toEqual(new Set(["project.move"]));
    // …and the hold ended with the verb.
    expect(() => statSync(lockPath)).toThrow();
  });
});

describe("a contended lock refuses the verb, before it touches anything", () => {
  it("area.reorder — the ruling's own case — refuses and drives no gesture", async () => {
    const a1 = seedArea(fixture.db, "A1", 0);
    seedArea(fixture.db, "A2", 1);
    heldByAnotherWriter("todo.add");
    let drove = false;
    const uiVector: WriteVector = {
      id: "ui",
      matrix: { "area.reorder": { support: "yes", disruption: 3, validation: "validated" } },
      async execute() {
        drove = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const result = await runUniversalReorder(deps([uiVector]), {
      uuids: [a1],
      position: { at: "last" },
    });

    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") {
      expect(result.refusal).toBe("blocked");
      namesTheHolder(result.detail, "todo.add");
    }
    // Nothing was censused, nothing was dragged: the sidebar is untouched.
    expect(drove).toBe(false);
  });

  it("the universal reorder's own protocols refuse the same way", async () => {
    const project = seedProject(fixture.db, { title: "P" });
    const t1 = seedTodo(fixture.db, { title: "T1", project, index: 1 });
    const t2 = seedTodo(fixture.db, { title: "T2", project, index: 2 });
    heldByAnotherWriter("area.reorder");

    const result = await runReorder(deps([movingVector()]), {
      scope: "project",
      container: { uuid: project },
      uuids: [t2, t1],
    });

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toBe("lock");
      namesTheHolder(result.detail ?? "", "area.reorder");
    }
  });

  it("a granular checklist edit refuses rather than rewriting a stale list", async () => {
    const todo = seedTodo(fixture.db, { title: "T", checklistItemsCount: 2 });
    seedChecklistItem(fixture.db, todo, "one", { index: 0 });
    seedChecklistItem(fixture.db, todo, "two", { index: 1 });
    heldByAnotherWriter("todo.replace-checklist");

    const result = await runEditChecklist(deps([movingVector()]), todo, {
      action: "check",
      item: "one",
    });

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toBe("lock");
      namesTheHolder(result.detail ?? "", "todo.replace-checklist");
    }
  });

  it("the heading archive/unarchive pair refuse in their own result shapes", async () => {
    const project = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project });
    heldByAnotherWriter("todo.move");

    const archive = await runHeadingArchive(deps([movingVector()]), {
      uuid: heading,
      children: "reparent",
    });
    expect(archive.heading.kind).toBe("blocked");
    if (archive.heading.kind === "blocked") {
      expect(archive.heading.reason).toBe("lock");
      namesTheHolder(archive.heading.detail ?? "", "todo.move");
    }
    expect(archive.reparented).toEqual([]);

    const unarchive = await runHeadingUnarchive(deps([movingVector()]), {
      uuid: heading,
      restoreChildren: true,
    });
    expect(unarchive.heading.kind).toBe("blocked");
    expect(unarchive.children).toEqual([]);
  });

  it("a DRY RUN is never made to wait — it mutates nothing", async () => {
    const project = seedProject(fixture.db, { title: "P" });
    const t1 = seedTodo(fixture.db, { title: "T1" });
    heldByAnotherWriter("area.reorder");

    const preview = await runTodoMove(
      deps([movingVector()]),
      { uuids: [t1], destination: { kind: "project", ref: { uuid: project } } },
      { dryRun: true },
    );

    expect(preview.kind).toBe("move-dry-run");
  });
});
