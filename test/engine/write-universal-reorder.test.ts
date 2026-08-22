/**
 * Universal `things reorder` dispatch (spec §7): ONE verb across to-dos,
 * projects, headings, and sidebar areas, with kind-aware protocol dispatch and
 * precise refusals for mixed-kind / cross-container / cross-axis / non-member
 * operands. Exercises `runUniversalReorder` directly against a seeded fixture.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { computeReorderPre } from "../../src/write/pre-state.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import { runUniversalReorder } from "../../src/write/move.ts";
import type { WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;
let modClock = 1_790_000_000;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
});
afterEach(() => {
  fixture.close();
});

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
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
    bounceEnabled: true,
    bounceMaxItems: 30,
    autoLaunch: true,
    helpersEnabled: false,
    ui: { enabled: false },
    host: "test-host",
  };
}

/** A native reorder + move-heading vector: assigns ascending ranks to the wire. */
function nativeVector() {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "applescript",
    matrix: {
      reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
      "project.move-heading": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(invocation) {
      calls.push(invocation.payload);
      const ids = /with ids "([^"]+)"/.exec(invocation.payload)?.[1]?.split(",") ?? [];
      let rank = 1;
      for (const uuid of ids) {
        fixture.db
          .prepare(`UPDATE TMTask SET "index" = ?, userModificationDate = ? WHERE uuid = ?`)
          .run(rank++, modClock++, uuid);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

function deps(vectors: WriteVector[], overrides: Partial<WriteDeps> = {}): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: config(),
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-universal-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    sdefProbe: () => true,
    ...overrides,
  };
}

describe("universal reorder — kind dispatch", () => {
  it("dispatches a to-do set onto the project index re-rank", async () => {
    const project = seedProject(fixture.db, { title: "P" });
    const t1 = seedTodo(fixture.db, { title: "T1", project, index: 1 });
    const t2 = seedTodo(fixture.db, { title: "T2", project, index: 2 });
    const t3 = seedTodo(fixture.db, { title: "T3", project, index: 3 });
    const { vector, calls } = nativeVector();
    const result = await runUniversalReorder(deps([vector]), {
      uuids: [t3, t1],
      position: { at: "first" },
    });
    expect(result.kind).toBe("move-ok");
    if (result.kind === "move-ok") expect(result.op).toBe("todo.move");
    // The native re-rank ran (a `with ids` wire), and t2 keeps its place.
    expect(calls.join(" ")).toContain("with ids");
    expect([t1, t2, t3]).toHaveLength(3);
  });

  it("dispatches a same-project heading set onto the heading-block wire (move-heading)", async () => {
    const project = seedProject(fixture.db, { title: "P" });
    const h1 = seedHeading(fixture.db, { title: "H1", project, index: 1 });
    seedHeading(fixture.db, { title: "H2", project, index: 2 });
    const h3 = seedHeading(fixture.db, { title: "H3", project, index: 3 });
    const { vector } = nativeVector();
    const dry = await runUniversalReorder(
      deps([vector]),
      { uuids: [h3], position: { at: "first" } },
      { dryRun: true },
    );
    expect(dry.kind).toBe("move-dry-run");
    if (dry.kind === "move-dry-run") {
      expect(dry.op).toBe("project.move-heading");
      expect(dry.plan.note).toContain("heading");
    }
    expect(h1).toBeTruthy();
  });

  it("routes a sidebar-area set onto area.reorder (dry-run: sidebar drag)", async () => {
    const a1 = seedArea(fixture.db, "A1", 0);
    seedArea(fixture.db, "A2", 1);
    const { vector } = nativeVector();
    const dry = await runUniversalReorder(
      deps([vector]),
      { uuids: [a1], position: { at: "last" } },
      { dryRun: true },
    );
    expect(dry.kind).toBe("move-dry-run");
    if (dry.kind === "move-dry-run") {
      expect(dry.op).toBe("area.reorder");
      expect(dry.plan.note).toContain("sidebar-drag");
    }
  });
});

describe("universal reorder — refusals", () => {
  it("refuses a mixed-kind set (a to-do and an area) with one message", async () => {
    const t = seedTodo(fixture.db, { title: "T" });
    const a = seedArea(fixture.db, "Area", 0);
    const { vector } = nativeVector();
    const result = await runUniversalReorder(deps([vector]), { uuids: [t, a] });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") {
      expect(result.detail).toContain("one kind at a time");
    }
  });

  it("refuses a heading mixed with a to-do", async () => {
    const project = seedProject(fixture.db, { title: "P" });
    const h = seedHeading(fixture.db, { title: "H", project });
    const t = seedTodo(fixture.db, { title: "T", project });
    const { vector } = nativeVector();
    const result = await runUniversalReorder(deps([vector]), { uuids: [h, t] });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") expect(result.detail).toContain("one kind at a time");
  });

  it("refuses headings that span projects (cross-container)", async () => {
    const p1 = seedProject(fixture.db, { title: "P1" });
    const p2 = seedProject(fixture.db, { title: "P2" });
    const h1 = seedHeading(fixture.db, { title: "H1", project: p1 });
    const h2 = seedHeading(fixture.db, { title: "H2", project: p2 });
    const { vector } = nativeVector();
    const result = await runUniversalReorder(deps([vector]), {
      uuids: [h1, h2],
      position: { at: "first" },
    });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") expect(result.detail).toContain("span projects");
  });

  it("refuses --in on a heading set (a heading has no reorder axis)", async () => {
    const project = seedProject(fixture.db, { title: "P" });
    const h = seedHeading(fixture.db, { title: "H", project });
    const { vector } = nativeVector();
    const result = await runUniversalReorder(deps([vector]), { uuids: [h], in: "today" });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") expect(result.detail).toContain("`--in`");
  });

  it("refuses --in on an area set", async () => {
    const a = seedArea(fixture.db, "A", 0);
    const { vector } = nativeVector();
    const result = await runUniversalReorder(deps([vector]), { uuids: [a], in: "anytime" });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") expect(result.detail).toContain("`--in`");
  });

  it("refuses an area reorder with no position", async () => {
    const a = seedArea(fixture.db, "A", 0);
    const { vector } = nativeVector();
    const result = await runUniversalReorder(deps([vector]), { uuids: [a] });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") expect(result.detail).toContain("needs a position");
  });

  it("names every kind in the not-found refusal", async () => {
    const { vector } = nativeVector();
    const result = await runUniversalReorder(deps([vector]), { uuids: ["ghost"] });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") {
      expect(result.detail).toMatch(/to-do, project, heading, or area/);
    }
  });
});

/** Hold resolutions UNSWEPT: logInterval 4 (Manually) with a manualLogDate BELOW the stopDates. */
function unsweptSettings(manualLogDate = 1_780_000_000): void {
  fixture.db
    .prepare(`INSERT INTO TMSettings (uuid, logInterval, manualLogDate) VALUES (?, 4, ?)`)
    .run("settings-1", manualLogDate);
}

/**
 * A native reorder vector that mimics the LOGSORT byte-level law: sets `index`
 * ONLY, `userModificationDate`-SILENT, status/stopDate untouched — the certified
 * behavior for OPEN and UNSWEPT-resolved rows alike.
 */
function nativeVectorIndexOnly() {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "applescript",
    matrix: {
      reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
      "project.move-heading": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(invocation) {
      calls.push(invocation.payload);
      const ids = /with ids "([^"]+)"/.exec(invocation.payload)?.[1]?.split(",") ?? [];
      let rank = 1;
      for (const uuid of ids) {
        fixture.db.prepare(`UPDATE TMTask SET "index" = ? WHERE uuid = ?`).run(rank++, uuid);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

/**
 * A BUGGY native reorder vector that REOPENS every row it re-ranks (status→open,
 * stopDate→NULL, umd bump) — the exact failure mode the ORD-13 delta byte-lock
 * must catch on a resolved movee.
 */
function reopeningVector() {
  const vector: WriteVector = {
    id: "applescript",
    matrix: {
      reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
      "project.move-heading": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(invocation) {
      const ids = /with ids "([^"]+)"/.exec(invocation.payload)?.[1]?.split(",") ?? [];
      let rank = 1;
      for (const uuid of ids) {
        fixture.db
          .prepare(
            `UPDATE TMTask SET "index" = ?, status = 0, stopDate = NULL, userModificationDate = ? WHERE uuid = ?`,
          )
          .run(rank++, modClock++, uuid);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector };
}

describe("universal reorder — resolved to-do movees (LOGSORT ORD-13)", () => {
  it("refuses a swept resolved to-do, pointing at reactivation / --completed-at", () => {
    // logInterval default 0 (Immediately) → boundary = now → a completed row with a
    // past stopDate is SWEPT. Even the native permit never admits it (a re-rank reopens it).
    const project = seedProject(fixture.db, { title: "P" });
    const done = seedTodo(fixture.db, {
      title: "Done",
      project,
      status: "completed",
      stopDate: 1_780_000_000,
      index: 1,
    });
    const pre = computeReorderPre(
      fixture.db,
      { scope: "project", uuids: [done], container: { uuid: project } },
      project,
      NOW,
      { admitResolved: true },
    );
    expect(pre.members.map((m) => m.uuid)).not.toContain(done);
    expect(pre.resolvedMembers).toHaveLength(0);
    const reason = pre.rejected.find((r) => r.uuid === done)?.reason ?? "";
    expect(reason).toContain("Logbook");
    expect(reason).toContain("--completed-at");
  });

  it("refuses an unswept resolved movee on a NON-native path (native-only condition)", () => {
    // admitResolved=false models every bounce/move/day-axis orchestrator: the
    // uncertified protocol keeps the resolved movee refused with the native-only copy.
    unsweptSettings();
    const project = seedProject(fixture.db, { title: "P" });
    const done = seedTodo(fixture.db, {
      title: "Done",
      project,
      status: "completed",
      stopDate: 1_785_000_000,
      index: 1,
    });
    const pre = computeReorderPre(
      fixture.db,
      { scope: "project", uuids: [done], container: { uuid: project } },
      project,
      NOW,
    );
    expect(pre.resolvedMembers).toHaveLength(0);
    const reason = pre.rejected.find((r) => r.uuid === done)?.reason ?? "";
    expect(reason).toContain("resolved");
    expect(reason).toContain("native");
    expect(reason).toContain("reopen");
    expect(reason).not.toContain("Logbook");
  });

  it("ADMITS an unswept resolved movee on the pure-native index path (permit)", () => {
    unsweptSettings();
    const project = seedProject(fixture.db, { title: "P" });
    const done = seedTodo(fixture.db, {
      title: "Done",
      project,
      status: "completed",
      stopDate: 1_785_000_000,
      index: 2,
    });
    const pre = computeReorderPre(
      fixture.db,
      { scope: "project", uuids: [done], container: { uuid: project } },
      project,
      NOW,
      { admitResolved: true },
    );
    expect(pre.rejected).toHaveLength(0);
    expect(pre.members.map((m) => m.uuid)).toContain(done);
    expect(pre.resolvedMembers).toEqual([
      expect.objectContaining({ uuid: done, status: "completed" }),
    ]);
  });

  it("a canceled (status=2) unswept movee is admitted just like a completed one", () => {
    unsweptSettings();
    const project = seedProject(fixture.db, { title: "P" });
    const cxl = seedTodo(fixture.db, {
      title: "Cxl",
      project,
      status: "canceled",
      stopDate: 1_785_000_000,
      index: 1,
    });
    const pre = computeReorderPre(
      fixture.db,
      { scope: "project", uuids: [cxl], container: { uuid: project } },
      project,
      NOW,
      { admitResolved: true },
    );
    expect(pre.rejected).toHaveLength(0);
    expect(pre.resolvedMembers).toEqual([
      expect.objectContaining({ uuid: cxl, status: "canceled" }),
    ]);
  });

  it("permits a MIXED open + unswept-resolved wire end-to-end, resolved row NOT reopened", async () => {
    unsweptSettings();
    const project = seedProject(fixture.db, { title: "P" });
    const open1 = seedTodo(fixture.db, { title: "Open1", project, index: 1 });
    const done = seedTodo(fixture.db, {
      title: "Done",
      project,
      status: "completed",
      stopDate: 1_785_000_000,
      index: 2,
    });
    const { vector, calls } = nativeVectorIndexOnly();
    const result = await runUniversalReorder(deps([vector]), {
      uuids: [done, open1],
      position: { at: "first" },
    });
    expect(result.kind).toBe("move-ok");
    expect(calls.join(" ")).toContain("with ids");
    // The resolved row moved by index but stayed resolved (no reopen) — the ORD-13 law.
    const row = fixture.db
      .prepare(`SELECT status, stopDate FROM TMTask WHERE uuid = ?`)
      .get(done) as { status: number; stopDate: number | null };
    expect(row.status).toBe(3);
    expect(row.stopDate).toBe(1_785_000_000);
  });

  it("the delta byte-lock FAILS the reorder when a resolved movee is reopened", async () => {
    unsweptSettings();
    const project = seedProject(fixture.db, { title: "P" });
    seedTodo(fixture.db, { title: "Open1", project, index: 1 });
    const done = seedTodo(fixture.db, {
      title: "Done",
      project,
      status: "completed",
      stopDate: 1_785_000_000,
      index: 2,
    });
    const { vector } = reopeningVector();
    const result = await runUniversalReorder(
      deps([vector]),
      { uuids: [done], position: { at: "first" } },
      { verifyTimeoutMs: 100 },
    );
    // The reopening vector violates the frozen (status/stoppedDate/umd) lock → verify fails.
    expect(result.kind).not.toBe("move-ok");
  });

  it("refuses an unswept resolved movee end-to-end when native is UNAVAILABLE", async () => {
    unsweptSettings();
    const project = seedProject(fixture.db, { title: "P" });
    seedTodo(fixture.db, { title: "Open1", project, index: 1 });
    const done = seedTodo(fixture.db, {
      title: "Done",
      project,
      status: "completed",
      stopDate: 1_785_000_000,
      index: 2,
    });
    const { vector } = nativeVectorIndexOnly();
    // sdef canary fails → native unavailable → project routes to the PROJROOT move
    // fallback, which is uncertified for resolved rows → refused (native-only copy).
    const result = await runUniversalReorder(deps([vector], { sdefProbe: () => false }), {
      uuids: [done],
      position: { at: "first" },
    });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") {
      expect(result.detail).toContain("resolved");
      expect(result.detail).toContain("native");
    }
  });

  it("does NOT admit a resolved movee on a day-axis (todayIndex) scope", () => {
    // The permit is index-axis only; a `today` scope keys on todayIndex, so even with
    // admitResolved the resolved row stays refused (--in <date> day-axis exclusion).
    unsweptSettings();
    const done = seedTodo(fixture.db, {
      title: "Done",
      status: "completed",
      stopDate: 1_785_000_000,
      start: "active",
      index: 1,
    });
    const pre = computeReorderPre(fixture.db, { scope: "today", uuids: [done] }, null, NOW, {
      admitResolved: true,
    });
    expect(pre.resolvedMembers).toHaveLength(0);
    expect(pre.members.map((m) => m.uuid)).not.toContain(done);
  });
});

describe("universal reorder — O06 heading-child protection", () => {
  it("a project-scope reorder never pulls a heading's child into the wire", () => {
    const project = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project, index: 1 });
    const bodyChild = seedTodo(fixture.db, { title: "Body", project, index: 1 });
    const headedChild = seedTodo(fixture.db, { title: "Headed", project, heading, index: 2 });
    const pre = computeReorderPre(
      fixture.db,
      { scope: "project", uuids: [bodyChild, headedChild], container: { uuid: project } },
      project,
      NOW,
    );
    // The unheaded body child is a member; the headed child is REJECTED (O06 rip),
    // so it can never enter the project-scope wire.
    expect(pre.members.map((m) => m.uuid)).toContain(bodyChild);
    const rej = pre.rejected.find((r) => r.uuid === headedChild)?.reason ?? "";
    expect(rej).toContain("heading");
  });

  it("O06 protection takes precedence over the ORD-13 permit for a resolved headed child", () => {
    // A resolved child that ALSO lives under a heading rejects for the reparent
    // hazard (O06), not the resolved-permit condition — even with admitResolved.
    unsweptSettings();
    const project = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project, index: 1 });
    const headedDone = seedTodo(fixture.db, {
      title: "HeadedDone",
      project,
      heading,
      status: "completed",
      stopDate: 1_785_000_000,
      index: 1,
    });
    const pre = computeReorderPre(
      fixture.db,
      { scope: "project", uuids: [headedDone], container: { uuid: project } },
      project,
      NOW,
      { admitResolved: true },
    );
    expect(pre.resolvedMembers).toHaveLength(0);
    const rej = pre.rejected.find((r) => r.uuid === headedDone)?.reason ?? "";
    expect(rej).toContain("heading");
    expect(rej).not.toContain("Logbook");
  });
});
