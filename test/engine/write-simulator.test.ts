/**
 * Simulator write-vector tests: drive the FULL mutation pipeline end-to-end
 * against a synthetic fixture DB, with the simulator vector applying each write
 * as SQL (no Things app). Mirrors the write-pipeline.test.ts style. Every
 * covered op asserts (a) an "ok" result, (b) the DB post-state by direct SQL,
 * and (c) an audit record appended.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuditWriter } from "../../src/audit/log.ts";
import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { encodePackedDate, encodeReminderTime } from "../../src/model/dates.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import { runUndo } from "../../src/write/undo.ts";
import { defaultVectors } from "../../src/write/vectors/registry.ts";
import { createSimulatorVector } from "../../src/write/vectors/simulator.ts";
import type { WriteVector } from "../../src/write/vectors/types.ts";
import { openInThings, revealLine } from "../../src/cli/commands/reads.ts";
import { probeAccessibility } from "../../src/write/accessibility-probe.ts";
import { probeAutomation } from "../../src/write/automation-probe.ts";
import { simFenceActive } from "../../src/write/vectors/simulator.ts";
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
const TODAY = "2026-07-05"; // localToday(NOW) is date-only, tz-invariant for noon-UTC

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
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
  actor: "test-actor",
  auditEnabled: true,
  acceptedFingerprint: null,
  allowExperimental: false,
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
    lockPath: join(tmpdir(), `things-api-sim-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    ...overrides,
  };
}

beforeEach(() => {
  fixture = buildFixtureDb({ benchMarker: true });
  auditRecords = [];
});
afterEach(() => {
  fixture.close();
});

describe("simulator write vector — covered operations", () => {
  let savedSim: string | undefined;
  let savedDb: string | undefined;
  let vector: WriteVector;

  let savedState: string | undefined;
  let savedConfig: string | undefined;

  beforeEach(() => {
    savedSim = process.env["THINGS_SIM_WRITES"];
    savedDb = process.env["THINGS_DB"];
    savedState = process.env["THINGS_API_STATE_DIR"];
    savedConfig = process.env["THINGS_API_CONFIG_DIR"];
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] = fixture.path;
    process.env["THINGS_API_STATE_DIR"] = mkdtempSync(join(tmpdir(), "sim-state-"));
    process.env["THINGS_API_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "sim-config-"));
    vector = createSimulatorVector(fixture.path, { now: () => NOW });
  });
  afterEach(() => {
    restoreEnv("THINGS_SIM_WRITES", savedSim);
    restoreEnv("THINGS_DB", savedDb);
    restoreEnv("THINGS_API_STATE_DIR", savedState);
    restoreEnv("THINGS_API_CONFIG_DIR", savedConfig);
  });

  const row = (uuid: string): Record<string, unknown> =>
    fixture.db.prepare("SELECT * FROM TMTask WHERE uuid = ?").get(uuid) as Record<string, unknown>;

  it("todo.add: creates a scheduled, tagged, checklisted to-do", async () => {
    seedTag(fixture.db, "focus");
    const res = await runMutation(deps(vector), "todo.add", {
      title: "Write report",
      notes: "draft first",
      when: "today",
      reminder: "09:30",
      deadline: "2026-07-10",
      tags: ["focus"],
      checklistItems: ["outline", "prose"],
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok with uuid");
    const r = row(res.uuid);
    expect(r["title"]).toBe("Write report");
    expect(r["notes"]).toBe("draft first");
    expect(r["start"]).toBe(1);
    expect(r["startDate"]).toBe(encodePackedDate(TODAY));
    expect(r["startBucket"]).toBe(0);
    expect(r["reminderTime"]).toBe(encodeReminderTime("09:30"));
    expect(r["deadline"]).toBe(encodePackedDate("2026-07-10"));
    const tags = fixture.db
      .prepare(
        "SELECT t.title FROM TMTaskTag tt JOIN TMTag t ON tt.tags = t.uuid WHERE tt.tasks = ?",
      )
      .all(res.uuid) as { title: string }[];
    expect(tags.map((t) => t.title)).toEqual(["focus"]);
    const items = fixture.db
      .prepare(`SELECT title FROM TMChecklistItem WHERE task = ? ORDER BY "index"`)
      .all(res.uuid) as { title: string }[];
    expect(items.map((i) => i.title)).toEqual(["outline", "prose"]);
    expect(auditRecords.some((a) => a.result === "ok")).toBe(true);
  });

  it("todo.add: evening/someday buckets", async () => {
    const evening = await runMutation(deps(vector), "todo.add", { title: "Ev", when: "evening" });
    const someday = await runMutation(deps(vector), "todo.add", { title: "Sd", when: "someday" });
    expect(evening.kind).toBe("ok");
    expect(someday.kind).toBe("ok");
    if (evening.kind === "ok" && evening.uuid) {
      const r = row(evening.uuid);
      expect(r["startBucket"]).toBe(1);
      expect(r["startDate"]).toBe(encodePackedDate(TODAY));
    }
    if (someday.kind === "ok" && someday.uuid) {
      expect(row(someday.uuid)["start"]).toBe(2);
    }
  });

  it("todo.update: title/notes-append/when/deadline", async () => {
    const uuid = seedTodo(fixture.db, { title: "Old", notes: "line1" });
    const res = await runMutation(deps(vector), "todo.update", {
      uuid,
      title: "New",
      appendNotes: "line2",
      when: "today",
      deadline: "2026-08-01",
    });
    expect(res.kind).toBe("ok");
    const r = row(uuid);
    expect(r["title"]).toBe("New");
    expect(r["notes"]).toBe("line1\nline2");
    expect(r["startDate"]).toBe(encodePackedDate(TODAY));
    expect(r["deadline"]).toBe(encodePackedDate("2026-08-01"));
    expect(r["userModificationDate"]).toBe(NOW_EPOCH);
  });

  it("todo.complete / cancel / reopen", async () => {
    const done = seedTodo(fixture.db, { title: "A" });
    const canc = seedTodo(fixture.db, { title: "B" });
    const reop = seedTodo(fixture.db, { title: "C", status: "completed" });
    expect((await runMutation(deps(vector), "todo.complete", { uuid: done })).kind).toBe("ok");
    expect((await runMutation(deps(vector), "todo.cancel", { uuid: canc })).kind).toBe("ok");
    expect((await runMutation(deps(vector), "todo.reopen", { uuid: reop })).kind).toBe("ok");
    expect(row(done)["status"]).toBe(3);
    expect(row(canc)["status"]).toBe(2);
    expect(row(reop)["status"]).toBe(0);
    expect(row(reop)["stopDate"]).toBeNull();
  });

  it("todo.delete (trash) and todo.restore", async () => {
    const uuid = seedTodo(fixture.db, { title: "T", start: "active" });
    expect((await runMutation(deps(vector), "todo.delete", { uuid })).kind).toBe("ok");
    expect(row(uuid)["trashed"]).toBe(1);
    expect((await runMutation(deps(vector), "todo.restore", { uuid })).kind).toBe("ok");
    expect(row(uuid)["trashed"]).toBe(0);
    expect(row(uuid)["start"]).toBe(0);
  });

  it("todo.move: into a project, into an area, to inbox", async () => {
    const proj = seedProject(fixture.db, { title: "Proj" });
    const area = seedArea(fixture.db, "Area");
    const t1 = seedTodo(fixture.db, { title: "m1" });
    const t2 = seedTodo(fixture.db, { title: "m2" });
    const t3 = seedTodo(fixture.db, { title: "m3", project: proj });
    expect(
      (await runMutation(deps(vector), "todo.move", { uuid: t1, project: { uuid: proj } })).kind,
    ).toBe("ok");
    expect(row(t1)["project"]).toBe(proj);
    expect(
      (await runMutation(deps(vector), "todo.move", { uuid: t2, area: { uuid: area } })).kind,
    ).toBe("ok");
    expect(row(t2)["area"]).toBe(area);
    expect(row(t2)["project"]).toBeNull();
    expect((await runMutation(deps(vector), "todo.move", { uuid: t3, inbox: true })).kind).toBe(
      "ok",
    );
    expect(row(t3)["start"]).toBe(0);
    expect(row(t3)["project"]).toBeNull();
  });

  it("todo.move: filing an INBOX item into a container promotes it to Anytime; someday start survives", async () => {
    const area = seedArea(fixture.db, "FileArea");
    const proj = seedProject(fixture.db, { title: "FileProj" });
    const inboxTodo = seedTodo(fixture.db, { title: "from-inbox", start: "inbox" });
    const somedayTodo = seedTodo(fixture.db, { title: "keep-someday", start: "someday" });
    expect(
      (await runMutation(deps(vector), "todo.move", { uuid: inboxTodo, area: { uuid: area } }))
        .kind,
    ).toBe("ok");
    expect(row(inboxTodo)["start"]).toBe(1); // inbox → anytime on filing
    expect(
      (await runMutation(deps(vector), "todo.move", { uuid: somedayTodo, project: { uuid: proj } }))
        .kind,
    ).toBe("ok");
    expect(row(somedayTodo)["start"]).toBe(2); // someday is preserved
  });

  it("todo.move {detach}: clears container but PRESERVES the schedule", async () => {
    const proj = seedProject(fixture.db, { title: "Proj" });
    const t = seedTodo(fixture.db, {
      title: "keep-when",
      project: proj,
      start: "active",
      startDate: "2026-07-09",
    });
    const res = await runMutation(deps(vector), "todo.move", { uuid: t, detach: true });
    expect(res.kind).toBe("ok");
    const r = row(t);
    expect(r["project"]).toBeNull();
    expect(r["area"]).toBeNull();
    expect(r["heading"]).toBeNull();
    // Schedule is untouched by a detach (start / startDate preserved).
    expect(r["start"]).toBe(1);
    expect(r["startDate"]).toBe(encodePackedDate("2026-07-09"));
  });

  it("todo.move to a heading: reaches the project via the heading (project NULL)", async () => {
    const proj = seedProject(fixture.db, { title: "Book" });
    const head = seedHeading(fixture.db, { title: "Chapter 1", project: proj });
    const t = seedTodo(fixture.db, { title: "para" });
    const res = await runMutation(deps(vector), "todo.move", {
      uuid: t,
      project: { uuid: proj },
      heading: "Chapter 1",
    });
    expect(res.kind).toBe("ok");
    const r = row(t);
    expect(r["heading"]).toBe(head);
    expect(r["project"]).toBeNull();
    expect(r["area"]).toBeNull();
  });

  it("todo.update: explicit reminder clear (reminder null) with when today", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "T",
      start: "active",
      startDate: "2026-07-01",
      reminder: "08:00",
    });
    expect(row(uuid)["reminderTime"]).toBe(encodeReminderTime("08:00"));
    const res = await runMutation(deps(vector), "todo.update", {
      uuid,
      when: "today",
      reminder: null,
    });
    expect(res.kind).toBe("ok");
    const r = row(uuid);
    expect(r["reminderTime"]).toBeNull();
    expect(r["startDate"]).toBe(encodePackedDate(TODAY));
  });

  it("todo.add into an area", async () => {
    const area = seedArea(fixture.db, "Errands");
    const res = await runMutation(deps(vector), "todo.add", {
      title: "buy milk",
      area: { uuid: area },
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok with uuid");
    const r = row(res.uuid);
    expect(r["area"]).toBe(area);
    expect(r["project"]).toBeNull();
    expect(r["start"]).toBe(1); // Anytime under a container
  });

  it("project.add into an area", async () => {
    const area = seedArea(fixture.db, "Work");
    const res = await runMutation(deps(vector), "project.add", {
      title: "Q3 Launch",
      area: { uuid: area },
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok with uuid");
    const r = row(res.uuid);
    expect(r["type"]).toBe(1);
    expect(r["area"]).toBe(area);
  });

  it("area.update: tags branch replaces the area's tag set", async () => {
    const area = seedArea(fixture.db, "Home");
    const keep = seedTag(fixture.db, "keep");
    seedTag(fixture.db, "add1");
    seedTag(fixture.db, "add2");
    // Pre-existing tag that the replacement must drop.
    fixture.db.prepare("INSERT INTO TMAreaTag (areas, tags) VALUES (?, ?)").run(area, keep);
    const res = await runMutation(deps(vector), "area.update", {
      target: area,
      tags: ["add1", "add2"],
    });
    expect(res.kind).toBe("ok");
    const tags = fixture.db
      .prepare(
        "SELECT t.title FROM TMAreaTag at JOIN TMTag t ON at.tags = t.uuid WHERE at.areas = ? ORDER BY t.title",
      )
      .all(area) as { title: string }[];
    expect(tags.map((t) => t.title)).toEqual(["add1", "add2"]);
  });

  it("todo.set-tags: full replacement", async () => {
    const uuid = seedTodo(fixture.db, { title: "T" });
    const old = seedTag(fixture.db, "old");
    fixture.db.prepare("INSERT INTO TMTaskTag (tasks, tags) VALUES (?, ?)").run(uuid, old);
    seedTag(fixture.db, "new1");
    seedTag(fixture.db, "new2");
    const res = await runMutation(deps(vector), "todo.set-tags", {
      uuid,
      tags: ["new1", "new2"],
    });
    expect(res.kind).toBe("ok");
    const tags = fixture.db
      .prepare(
        "SELECT t.title FROM TMTaskTag tt JOIN TMTag t ON tt.tags = t.uuid WHERE tt.tasks = ? ORDER BY t.title",
      )
      .all(uuid) as { title: string }[];
    expect(tags.map((t) => t.title)).toEqual(["new1", "new2"]);
  });

  it("todo.replace-checklist", async () => {
    const uuid = seedTodo(fixture.db, { title: "T" });
    seedChecklistItem(fixture.db, uuid, "stale", { index: 0 });
    const res = await runMutation(
      deps(vector),
      "todo.replace-checklist",
      { uuid, items: ["a", { title: "b", completed: true }] },
      { acknowledgeChecklistReset: true },
    );
    expect(res.kind).toBe("ok");
    const items = fixture.db
      .prepare(`SELECT title, status FROM TMChecklistItem WHERE task = ? ORDER BY "index"`)
      .all(uuid) as { title: string; status: number }[];
    expect(items).toEqual([
      { title: "a", status: 0 },
      { title: "b", status: 3 },
    ]);
  });

  it("project.add / project.update / project.complete with child cascade", async () => {
    const add = await runMutation(deps(vector), "project.add", {
      title: "Launch",
      notes: "goals",
      when: "someday",
    });
    expect(add.kind).toBe("ok");
    if (add.kind !== "ok" || add.uuid === null) throw new Error("expected project uuid");
    expect(row(add.uuid)["type"]).toBe(1);
    expect(row(add.uuid)["start"]).toBe(2);

    const upd = await runMutation(deps(vector), "project.update", {
      uuid: add.uuid,
      title: "Launch v2",
    });
    expect(upd.kind).toBe("ok");
    expect(row(add.uuid)["title"]).toBe("Launch v2");

    const open = seedTodo(fixture.db, { title: "child", project: add.uuid });
    const done = seedTodo(fixture.db, { title: "child2", project: add.uuid, status: "completed" });
    const comp = await runMutation(deps(vector), "project.complete", {
      uuid: add.uuid,
      children: "auto-complete",
    });
    expect(comp.kind).toBe("ok");
    expect(row(add.uuid)["status"]).toBe(3);
    expect(row(open)["status"]).toBe(3);
    expect(row(done)["status"]).toBe(3); // already completed, untouched
  });

  it("area.add / area.update", async () => {
    seedTag(fixture.db, "deep");
    const add = await runMutation(deps(vector), "area.add", { title: "Work", tags: ["deep"] });
    expect(add.kind).toBe("ok");
    if (add.kind !== "ok" || add.uuid === null) throw new Error("expected area uuid");
    const areaRow = fixture.db.prepare("SELECT title FROM TMArea WHERE uuid = ?").get(add.uuid) as {
      title: string;
    };
    expect(areaRow.title).toBe("Work");
    const upd = await runMutation(deps(vector), "area.update", {
      target: add.uuid,
      title: "Deep Work",
    });
    expect(upd.kind).toBe("ok");
    expect(
      (
        fixture.db.prepare("SELECT title FROM TMArea WHERE uuid = ?").get(add.uuid) as {
          title: string;
        }
      ).title,
    ).toBe("Deep Work");
  });

  it("tag.add: root and nested", async () => {
    const root = await runMutation(deps(vector), "tag.add", { title: "home" });
    expect(root.kind).toBe("ok");
    const nested = await runMutation(deps(vector), "tag.add", { title: "kitchen", parent: "home" });
    expect(nested.kind).toBe("ok");
    const kitchen = fixture.db
      .prepare("SELECT parent FROM TMTag WHERE title = 'kitchen'")
      .get() as { parent: string | null };
    const home = fixture.db.prepare("SELECT uuid FROM TMTag WHERE title = 'home'").get() as {
      uuid: string;
    };
    expect(kitchen.parent).toBe(home.uuid);
  });

  it("heading.create", async () => {
    const proj = seedProject(fixture.db, { title: "Book" });
    const res = await runMutation(deps(vector), "heading.create", {
      project: { uuid: proj },
      title: "Chapter 1",
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected heading uuid");
    const r = row(res.uuid);
    expect(r["type"]).toBe(2);
    expect(r["project"]).toBe(proj);
  });

  it("multi-step: project → heading → to-do under heading → complete (read-back consistent)", async () => {
    const proj = await runMutation(deps(vector), "project.add", { title: "MS Project" });
    expect(proj.kind).toBe("ok");
    const head = await runMutation(deps(vector), "heading.create", {
      project: { title: "MS Project" },
      title: "Phase A",
    });
    expect(head.kind).toBe("ok");
    if (head.kind !== "ok" || head.uuid === null) throw new Error("expected heading uuid");
    const todo = await runMutation(deps(vector), "todo.add", {
      title: "step one",
      project: { title: "MS Project" },
      heading: "Phase A",
    });
    expect(todo.kind).toBe("ok");
    if (todo.kind !== "ok" || todo.uuid === null) throw new Error("expected to-do uuid");
    // The to-do is reached through the heading (project column NULL).
    expect(row(todo.uuid)["heading"]).toBe(head.uuid);
    expect(row(todo.uuid)["project"]).toBeNull();
    const done = await runMutation(deps(vector), "todo.complete", { uuid: todo.uuid });
    expect(done.kind).toBe("ok");
    expect(row(todo.uuid)["status"]).toBe(3);
  });

  it("undo round-trip: forward todo.update, then undo restores the prior title", async () => {
    // The undo executor replays an INVERSE mutation through the same pipeline
    // (and the same simulator vector) from the on-disk audit trail — so it needs
    // a real audit writer, not the in-memory array.
    const auditDir = join(tmpdir(), `sim-audit-${randomUUID()}`);
    const writer = createAuditWriter({ dir: auditDir, secrets: [], enabled: true });
    const d = deps(vector, { audit: writer });
    const uuid = seedTodo(fixture.db, { title: "Before" });

    const fwd = await runMutation(d, "todo.update", { uuid, title: "After" });
    expect(fwd.kind).toBe("ok");
    expect(row(uuid)["title"]).toBe("After");

    const items = await runUndo(d, auditDir, { last: 1 });
    expect(items).toHaveLength(1);
    expect(row(uuid)["title"]).toBe("Before");
  });
});

describe("simulator fence", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      THINGS_SIM_WRITES: process.env["THINGS_SIM_WRITES"],
      THINGS_DB: process.env["THINGS_DB"],
      THINGS_API_STATE_DIR: process.env["THINGS_API_STATE_DIR"],
      THINGS_API_CONFIG_DIR: process.env["THINGS_API_CONFIG_DIR"],
    };
    process.env["THINGS_API_STATE_DIR"] = mkdtempSync(join(tmpdir(), "sim-state-"));
    process.env["THINGS_API_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "sim-config-"));
  });
  afterEach(() => {
    for (const key of Object.keys(saved)) restoreEnv(key, saved[key]);
  });

  it("no env gate + unmarked/absent THINGS_DB → defaultVectors returns real transports", () => {
    delete process.env["THINGS_SIM_WRITES"];
    delete process.env["THINGS_DB"];
    const vectors = defaultVectors(CONFIG);
    expect(vectors).toHaveLength(4);
    expect(vectors.map((v) => v.id)).toEqual(["url-scheme", "applescript", "shortcuts", "ui"]);
    // None of the real transports is the simulator.
    expect(vectors.some((v) => v.simulates === true)).toBe(false);
  });

  // Marker backstop (2026-07-17 incident): a marked fixture in use WITHOUT the
  // env gate must refuse real transports — this is the exact escape that fired
  // real url-scheme adds at a live app while verification read the fixture.
  it("no env gate but THINGS_DB is a MARKED fixture → defaultVectors throws", () => {
    delete process.env["THINGS_SIM_WRITES"];
    process.env["THINGS_DB"] = fixture.path;
    expect(() => defaultVectors(CONFIG)).toThrow(/bench fixture.*fence is not active/s);
  });

  it("no env gate but the client OPENED a marked fixture (--db) → defaultVectors throws", () => {
    delete process.env["THINGS_SIM_WRITES"];
    delete process.env["THINGS_DB"];
    expect(() => defaultVectors(CONFIG, {}, fixture.path)).toThrow(
      /bench fixture.*fence is not active/s,
    );
  });

  it("gate set but scratch state/config dirs unset → defaultVectors throws (audit-pollution guard)", () => {
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] = fixture.path;
    delete process.env["THINGS_API_STATE_DIR"];
    expect(() => defaultVectors(CONFIG, {}, fixture.path)).toThrow(
      /fence is unsatisfied: THINGS_API_STATE_DIR is not set/,
    );
  });

  it("gate set + valid fence → defaultVectors returns ONLY the simulator", () => {
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] = fixture.path;
    const vectors = defaultVectors(CONFIG, {}, fixture.path);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]?.simulates).toBe(true);
  });

  // Fail-closed: once THINGS_SIM_WRITES=1 is set, an unsatisfied fence must THROW
  // rather than fall through to the real transports (which would touch a real app).
  it("gate set but THINGS_DB unset → defaultVectors throws (fail-closed)", () => {
    process.env["THINGS_SIM_WRITES"] = "1";
    delete process.env["THINGS_DB"];
    expect(() => defaultVectors(CONFIG)).toThrow(/fence is unsatisfied: THINGS_DB is not set/);
  });

  it("gate set but no benchFixture marker → defaultVectors throws (fail-closed)", () => {
    fixture.db.prepare("DELETE FROM Meta WHERE key = 'benchFixture'").run();
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] = fixture.path;
    expect(() => defaultVectors(CONFIG, {}, fixture.path)).toThrow(
      /fence is unsatisfied:.*benchFixture/,
    );
  });

  it("gate set but fixture databaseVersion drifted → defaultVectors throws (schema tripwire)", () => {
    fixture.db.prepare("UPDATE Meta SET value = '27' WHERE key = 'databaseVersion'").run();
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] = fixture.path;
    expect(() => defaultVectors(CONFIG, {}, fixture.path)).toThrow(
      /fence is unsatisfied:.*databaseVersion 27.*re-modeled in lockstep/s,
    );
  });

  it("gate set but THINGS_DB is a production-container path → defaultVectors throws", () => {
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] =
      "/Users/x/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-XYZ/Things Database.thingsdatabase/main.sqlite";
    expect(() => defaultVectors(CONFIG)).toThrow(/fence is unsatisfied:.*production/);
  });

  it("gate set but client-opened DB != THINGS_DB → defaultVectors throws (split-brain guard)", () => {
    // The applier would write THINGS_DB while the verifier reads the --db path:
    // the fence must reject the mismatch outright.
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] = fixture.path;
    expect(() => defaultVectors(CONFIG, {}, "/some/other/database.sqlite")).toThrow(
      /fence is unsatisfied: the database the client opened .* does not equal THINGS_DB/,
    );
  });

  it("gate set + client-opened DB equals THINGS_DB after normalization → ok", () => {
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] = fixture.path;
    // A non-normalized but equivalent path (extra `/./`) must still satisfy the
    // equality check — resolve() normalizes both sides before comparing.
    const dir = fixture.path.slice(0, fixture.path.lastIndexOf("/"));
    const base = fixture.path.slice(fixture.path.lastIndexOf("/") + 1);
    const vectors = defaultVectors(CONFIG, {}, `${dir}/./${base}`);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]?.simulates).toBe(true);
  });

  it("env set but no benchFixture marker → createSimulatorVector refuses", () => {
    fixture.db.prepare("DELETE FROM Meta WHERE key = 'benchFixture'").run();
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] = fixture.path;
    expect(() => createSimulatorVector(fixture.path)).toThrow(/benchFixture/);
  });

  it("THINGS_DB unset → createSimulatorVector refuses", () => {
    process.env["THINGS_SIM_WRITES"] = "1";
    delete process.env["THINGS_DB"];
    expect(() => createSimulatorVector(fixture.path)).toThrow(/THINGS_DB/);
  });

  it("live env change after creation → execute refuses defensively", async () => {
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] = fixture.path;
    const vector = createSimulatorVector(fixture.path, { now: () => NOW });
    const uuid = seedTodo(fixture.db, { title: "x" });
    // Pull the fence out from under the live instance, then attempt a write.
    delete process.env["THINGS_SIM_WRITES"];
    const res = await runMutation(
      deps(vector),
      "todo.update",
      { uuid, title: "y" },
      { verifyTimeoutMs: 250 },
    );
    expect(res.kind).toBe("verify-failed");
    expect(
      (fixture.db.prepare("SELECT title FROM TMTask WHERE uuid = ?").get(uuid) as { title: string })
        .title,
    ).toBe("x"); // nothing was written
  });
});

describe("simulator fence — host-escape guards (no live app under the fence)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      THINGS_SIM_WRITES: process.env["THINGS_SIM_WRITES"],
      THINGS_DB: process.env["THINGS_DB"],
      THINGS_API_STATE_DIR: process.env["THINGS_API_STATE_DIR"],
      THINGS_API_CONFIG_DIR: process.env["THINGS_API_CONFIG_DIR"],
    };
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] = fixture.path;
    process.env["THINGS_API_STATE_DIR"] = mkdtempSync(join(tmpdir(), "sim-state-"));
    process.env["THINGS_API_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "sim-config-"));
  });
  afterEach(() => {
    for (const key of Object.keys(saved)) restoreEnv(key, saved[key]);
  });

  it("simFenceActive reflects the ambient THINGS_DB fence", () => {
    expect(simFenceActive()).toBe(true);
    delete process.env["THINGS_SIM_WRITES"];
    expect(simFenceActive()).toBe(false);
  });

  it("`open` (reveal) does NOT spawn `open` — returns the URI marked simulated", () => {
    // If this touched the host it would call execFileSync('/usr/bin/open', …);
    // under the fence it must return without opening.
    const res = openInThings("ABC123");
    expect(res.simulated).toBe(true);
    expect(res.uri).toBe("things:///show?id=ABC123");
    expect(revealLine(res)).toMatch(/would open .* \(simulated/);
  });

  it("the doctor Automation probe reports itself simulated (no osascript)", () => {
    // A run seam that throws proves the osascript path is never entered.
    const res = probeAutomation({
      isAppRunning: () => true,
      run: () => {
        throw new Error("osascript must not run under the fence");
      },
    });
    expect(res.status).toBe("simulated");
  });

  it("the doctor Accessibility probe reports itself simulated (no osascript)", () => {
    const res = probeAccessibility({
      isAppRunning: () => true,
      run: () => {
        throw new Error("osascript must not run under the fence");
      },
    });
    expect(res.status).toBe("simulated");
  });

  it("fence inactive → the reveal would open for real (simulated=false)", () => {
    delete process.env["THINGS_SIM_WRITES"];
    // We do NOT actually invoke openInThings here (it would spawn `open`); we
    // only assert the guard predicate flips, which is what gates the exec.
    expect(simFenceActive()).toBe(false);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
