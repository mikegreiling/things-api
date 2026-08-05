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

describe("universal reorder — resolved to-do movees (LOGSORT)", () => {
  it("refuses a swept resolved to-do, pointing at reactivation / --completed-at", () => {
    // logInterval default 0 (Immediately) → boundary = now → a completed row with a
    // past stopDate is SWEPT.
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
    );
    const reason = pre.rejected.find((r) => r.uuid === done)?.reason ?? "";
    expect(reason).toContain("Logbook");
    expect(reason).toContain("--completed-at");
  });

  it("refuses an unswept resolved to-do with a distinct (reopen-first) message", () => {
    // Hold the completion UNSWEPT: logInterval 4 (Manually) with a manualLogDate
    // BEFORE the stopDate keeps the row in the live body.
    fixture.db
      .prepare(`INSERT INTO TMSettings (uuid, logInterval, manualLogDate) VALUES (?, 4, ?)`)
      .run("settings-1", 1_780_000_000);
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
    const reason = pre.rejected.find((r) => r.uuid === done)?.reason ?? "";
    expect(reason).toContain("resolved");
    expect(reason).toContain("reopen");
    expect(reason).not.toContain("Logbook");
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
});
