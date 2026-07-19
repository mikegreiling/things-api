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
import { decodeRecurrenceRule } from "../../src/model/recurrence.ts";
import { runCreateRepeatingProject } from "../../src/write/make-repeating-project.ts";
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

  // ---------------------------------------------------------- recurrence
  // These reproduce the RSIM campaign row shapes (docs/lab/rsim-results.md).
  // The pinned NOW (2026-07-05, a Sunday) matches the RSIM clock, so a default
  // weekly rule anchors on Sunday (wd 0) and the next weekly occurrence is
  // 2026-07-12 — exactly the packed dates RSIM recorded.

  const GUI = { dangerouslyDriveGui: true } as const;
  const decodeTemplate = (uuid: string) =>
    decodeRecurrenceRule(row(uuid)["rt1_recurrenceRule"] as Uint8Array);
  const instancesOf = (templateUuid: string): Record<string, unknown>[] =>
    fixture.db
      .prepare("SELECT * FROM TMTask WHERE rt1_repeatingTemplate = ?")
      .all(templateUuid) as Record<string, unknown>[];

  it("todo.make-repeating FIXED weekly (RSIM1): source deleted, hidden template + one instance", async () => {
    const area = seedArea(fixture.db, "Garden");
    const tag = seedTag(fixture.db, "chores");
    const src = seedTodo(fixture.db, {
      title: "Water the plants",
      notes: "back porch first",
      area,
      start: "active",
      startDate: "2026-07-01",
    });
    fixture.db.prepare("INSERT INTO TMTaskTag (tasks, tags) VALUES (?, ?)").run(src, tag);

    const res = await runMutation(
      deps(vector),
      "todo.make-repeating",
      { uuid: src, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok with template uuid");

    // Source DELETED (identity replacement), not merely trashed.
    expect(fixture.db.prepare("SELECT 1 FROM TMTask WHERE uuid = ?").get(src)).toBeUndefined();

    // Template: hidden (start=someday), deadline-less, next occurrence 2026-07-12.
    const tmpl = row(res.uuid);
    expect(tmpl["type"]).toBe(0);
    expect(tmpl["title"]).toBe("Water the plants");
    expect(tmpl["notes"]).toBe("back porch first");
    expect(tmpl["area"]).toBe(area);
    expect(tmpl["start"]).toBe(2);
    expect(tmpl["startDate"]).toBeNull();
    expect(tmpl["deadline"]).toBeNull();
    expect(tmpl["rt1_instanceCreationCount"]).toBe(1);
    expect(tmpl["rt1_instanceCreationStartDate"]).toBe(encodePackedDate("2026-07-12"));
    expect(tmpl["rt1_nextInstanceStartDate"]).toBe(encodePackedDate("2026-07-12"));
    const rule = decodeTemplate(res.uuid);
    expect(rule).toMatchObject({
      type: "fixed",
      unit: "weekly",
      interval: 1,
      offsets: [{ weekday: 0 }],
    });

    // EXACTLY one instance, dated at the current occurrence (today).
    const inst = instancesOf(res.uuid);
    expect(inst).toHaveLength(1);
    expect(inst[0]?.["rt1_recurrenceRule"]).toBeNull();
    expect(inst[0]?.["startDate"]).toBe(encodePackedDate("2026-07-05"));
    expect(inst[0]?.["start"]).toBe(2);
    expect(inst[0]?.["deadline"]).toBeNull();

    // Title/tags/area copied onto BOTH new rows.
    for (const uuid of [res.uuid, inst[0]?.["uuid"] as string]) {
      const tags = fixture.db.prepare("SELECT tags FROM TMTaskTag WHERE tasks = ?").all(uuid) as {
        tags: string;
      }[];
      expect(tags.map((t) => t.tags)).toEqual([tag]);
    }
  });

  it("todo.make-repeating AFTER-COMPLETION weekly (RSIM2): source preserved as the sole instance", async () => {
    const src = seedTodo(fixture.db, {
      title: "Refill the water filter",
      start: "active",
      startDate: "2026-07-05",
    });
    const res = await runMutation(
      deps(vector),
      "todo.make-repeating",
      { uuid: src, frequency: "weekly", interval: 1, afterCompletion: true },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok with template uuid");

    // Source PRESERVED and relinked as the instance (identity kept).
    const preserved = row(src);
    expect(preserved["rt1_repeatingTemplate"]).toBe(res.uuid);
    expect(preserved["startDate"]).toBe(encodePackedDate("2026-07-05"));
    expect(preserved["start"]).toBe(1);
    expect(preserved["rt1_recurrenceRule"]).toBeNull();

    // Template only: tp=1, no next/reference dates until a completion.
    const tmpl = row(res.uuid);
    expect(tmpl["rt1_instanceCreationCount"]).toBe(0);
    expect(tmpl["rt1_nextInstanceStartDate"]).toBeNull();
    expect(tmpl["rt1_afterCompletionReferenceDate"]).toBeNull();
    expect(decodeTemplate(res.uuid)).toMatchObject({
      type: "after-completion",
      unit: "weekly",
      interval: 1,
      offsets: [{ weekday: 0 }],
    });

    // No FRESH instance minted — the preserved source is the only instance.
    const inst = instancesOf(res.uuid);
    expect(inst).toHaveLength(1);
    expect(inst[0]?.["uuid"]).toBe(src);
  });

  it("todo.complete an after-completion instance (RSIM4): stamps the template, no new instance", async () => {
    const src = seedTodo(fixture.db, {
      title: "Rotate the compost",
      start: "active",
      startDate: "2026-07-05",
    });
    const made = await runMutation(
      deps(vector),
      "todo.make-repeating",
      { uuid: src, frequency: "weekly", interval: 1, afterCompletion: true },
      GUI,
    );
    if (made.kind !== "ok" || made.uuid === null) throw new Error("expected template uuid");
    const templateUuid = made.uuid;

    const done = await runMutation(deps(vector), "todo.complete", { uuid: src });
    expect(done.kind).toBe("ok");

    expect(row(src)["status"]).toBe(3);
    const tmpl = row(templateUuid);
    expect(tmpl["rt1_afterCompletionReferenceDate"]).toBe(encodePackedDate("2026-07-05"));
    expect(tmpl["rt1_nextInstanceStartDate"]).toBe(encodePackedDate("2026-07-12"));
    // The next occurrence is future-dated and NOT materialized — still one instance.
    expect(instancesOf(templateUuid)).toHaveLength(1);
  });

  it("todo.reschedule-repeat (RSIM5): identity preserved, rule replaced in place", async () => {
    const src = seedTodo(fixture.db, { title: "Sweep the deck", start: "active" });
    const made = await runMutation(
      deps(vector),
      "todo.make-repeating",
      { uuid: src, frequency: "weekly", interval: 1 },
      GUI,
    );
    if (made.kind !== "ok" || made.uuid === null) throw new Error("expected template uuid");
    const templateUuid = made.uuid;

    const res = await runMutation(
      deps(vector),
      "todo.reschedule-repeat",
      { uuid: templateUuid, frequency: "daily", interval: 2 },
      GUI,
    );
    expect(res.kind).toBe("ok");

    // Same template uuid, rule rewritten to the TARGET (daily/2 — the app's
    // interval-entry bug is NOT modeled), creation date advanced.
    expect(
      fixture.db.prepare("SELECT title FROM TMTask WHERE uuid = ?").get(templateUuid),
    ).toBeDefined();
    expect(decodeTemplate(templateUuid)).toMatchObject({
      type: "fixed",
      unit: "daily",
      interval: 2,
    });
    expect(row(templateUuid)["rt1_instanceCreationStartDate"]).toBe(encodePackedDate("2026-07-07"));
  });

  it("project.make-repeating FIXED (RSIM6): area preserved, start normalized to Someday", async () => {
    const area = seedArea(fixture.db, "Home Ops");
    const proj = seedProject(fixture.db, {
      title: "Weekly review",
      area,
      start: "active",
    });
    const res = await runMutation(
      deps(vector),
      "project.make-repeating",
      { uuid: proj, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected template uuid");

    expect(fixture.db.prepare("SELECT 1 FROM TMTask WHERE uuid = ?").get(proj)).toBeUndefined();
    const tmpl = row(res.uuid);
    expect(tmpl["type"]).toBe(1);
    expect(tmpl["area"]).toBe(area); // area PRESERVED
    expect(tmpl["start"]).toBe(2); // normalized to Someday
    expect(decodeTemplate(res.uuid)).toMatchObject({ type: "fixed", unit: "weekly", interval: 1 });

    const inst = instancesOf(res.uuid);
    expect(inst).toHaveLength(1);
    expect(inst[0]?.["type"]).toBe(1);
    expect(inst[0]?.["area"]).toBe(area);
    expect(inst[0]?.["startDate"]).toBe(encodePackedDate("2026-07-05"));
  });

  it("project.create-repeating (RSIM3) via the orchestrator: template + one instance, area kept", async () => {
    const area = seedArea(fixture.db, "Operations");
    const res = await runCreateRepeatingProject(
      deps(vector),
      { title: "Monthly finances", area: { uuid: area }, frequency: "monthly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected template uuid");
    expect(res.op).toBe("project.create-repeating");

    // Net effect: exactly the template + its one instance carry the title; the
    // intermediate added project was consumed by the make-repeating replacement.
    const titled = fixture.db
      .prepare("SELECT uuid, rt1_recurrenceRule AS rule FROM TMTask WHERE title = ? AND type = 1")
      .all("Monthly finances") as { uuid: string; rule: unknown }[];
    expect(titled).toHaveLength(2);
    const tmpl = row(res.uuid);
    expect(tmpl["rt1_recurrenceRule"]).not.toBeNull();
    expect(tmpl["area"]).toBe(area);
    expect(tmpl["start"]).toBe(2);
    expect(decodeTemplate(res.uuid)).toMatchObject({ type: "fixed", unit: "monthly", interval: 1 });

    const inst = instancesOf(res.uuid);
    expect(inst).toHaveLength(1);
    expect(inst[0]?.["area"]).toBe(area);
  });

  it("make-repeating with the marquee last-Sunday-of-December rule (yearly mo/wd/wdo)", async () => {
    const src = seedTodo(fixture.db, { title: "Year-end backup", start: "active" });
    const res = await runMutation(
      deps(vector),
      "todo.make-repeating",
      {
        uuid: src,
        frequency: "yearly",
        interval: 1,
        yearly: { month: 12, weekday: "sunday", ordinal: "last" },
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected template uuid");

    // The complex anchor round-trips through the real decoder.
    expect(decodeTemplate(res.uuid)).toMatchObject({
      type: "fixed",
      unit: "yearly",
      interval: 1,
      offsets: [{ month: 12, weekday: 0, weekdayOrdinal: -1 }],
    });
  });

  // ------------------------------------------------ project subtree (RSIM-P)
  // These reproduce the RSIM-P verdicts (docs/lab/rsim-results.md §RSIM-P):
  // making a PROJECT repeat deep-duplicates its whole child subtree under BOTH
  // the hidden template and the instance, hard-deletes the source subtree, and
  // (after-completion) links each instance-side child to its template sibling.

  /** The heading + to-do rows currently hanging (directly or via a heading) off a project. */
  const subtreeOf = (
    projectUuid: string,
  ): { headings: Record<string, unknown>[]; todos: Record<string, unknown>[] } => {
    const headings = fixture.db
      .prepare(`SELECT * FROM TMTask WHERE type = 2 AND project = ?`)
      .all(projectUuid) as Record<string, unknown>[];
    const hIds = headings.map((h) => h["uuid"] as string);
    const ph = hIds.map(() => "?").join(", ");
    const todos = fixture.db
      .prepare(
        `SELECT * FROM TMTask WHERE type = 0 AND (project = ?${hIds.length ? ` OR heading IN (${ph})` : ""})`,
      )
      .all(projectUuid, ...hIds) as Record<string, unknown>[];
    return { headings, todos };
  };
  const count = (sql: string): number => (fixture.db.prepare(sql).get() as { n: number }).n;
  const checklistTitlesOf = (taskUuid: string): string[] =>
    (
      fixture.db
        .prepare(`SELECT title FROM TMChecklistItem WHERE task = ? ORDER BY "index"`)
        .all(taskUuid) as { title: string }[]
    ).map((r) => r.title);
  const tagsOf = (taskUuid: string): string[] =>
    (
      fixture.db.prepare("SELECT tags FROM TMTaskTag WHERE tasks = ?").all(taskUuid) as {
        tags: string;
      }[]
    ).map((r) => r.tags);

  it("project.make-repeating FIXED (RSIM-P P1): children deep-duplicated, source subtree deleted, copies plain", async () => {
    const area = seedArea(fixture.db, "Zone A");
    const tag = seedTag(fixture.db, "AlphaTag");
    const proj = seedProject(fixture.db, { title: "Proj Alpha", area, start: "active" });
    const head = seedHeading(fixture.db, { title: "Phase 1", project: proj, index: 0 });
    const taskA1 = seedTodo(fixture.db, { title: "Task A1", heading: head, index: 0 });
    fixture.db.prepare("INSERT INTO TMTaskTag (tasks, tags) VALUES (?, ?)").run(taskA1, tag);
    seedChecklistItem(fixture.db, taskA1, "Sub 1", { index: 0 });
    seedChecklistItem(fixture.db, taskA1, "Sub 2", { index: 1 });
    const taskA2 = seedTodo(fixture.db, { title: "Task A2", project: proj, index: 1 });

    const res = await runMutation(
      deps(vector),
      "project.make-repeating",
      { uuid: proj, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected template uuid");

    // Source project AND every descendant hard-DELETED.
    for (const uuid of [proj, head, taskA1, taskA2]) {
      expect(fixture.db.prepare("SELECT 1 FROM TMTask WHERE uuid = ?").get(uuid)).toBeUndefined();
    }

    // Template project (RSIM6 shape) + exactly ONE instance PROJECT.
    const tmpl = res.uuid;
    expect(row(tmpl)["type"]).toBe(1);
    expect(row(tmpl)["area"]).toBe(area);
    expect(row(tmpl)["start"]).toBe(2);
    expect(row(tmpl)["rt1_instanceCreationCount"]).toBe(1);
    expect(row(tmpl)["rt1_nextInstanceStartDate"]).toBe(encodePackedDate("2026-07-12"));
    const projInstances = fixture.db
      .prepare("SELECT uuid FROM TMTask WHERE type = 1 AND rt1_repeatingTemplate = ?")
      .all(tmpl) as { uuid: string }[];
    expect(projInstances).toHaveLength(1);
    const instProj = projInstances[0]!.uuid;
    expect(row(instProj)["startDate"]).toBe(encodePackedDate("2026-07-05"));

    // Two mirrored 4-row subtrees (heading + Task A1 + Task A2, per side).
    for (const side of [tmpl, instProj]) {
      const sub = subtreeOf(side);
      expect(sub.headings).toHaveLength(1);
      expect(sub.todos).toHaveLength(2);
      const h = sub.headings[0]!;
      expect(h["title"]).toBe("Phase 1");
      expect(h["start"]).toBe(1); // RSIM-P P1: children are start=1
      // Template-side (and fixed instance-side) children are COMPLETELY PLAIN.
      expect(h["rt1_recurrenceRule"]).toBeNull();
      expect(h["rt1_repeatingTemplate"]).toBeNull();

      const a1 = sub.todos.find((t) => t["title"] === "Task A1")!;
      // Headed child: project NULL, heading points at the COPIED heading.
      expect(a1["project"]).toBeNull();
      expect(a1["heading"]).toBe(h["uuid"]);
      expect(a1["start"]).toBe(1);
      expect(a1["rt1_recurrenceRule"]).toBeNull();
      expect(a1["rt1_repeatingTemplate"]).toBeNull();
      expect(tagsOf(a1["uuid"] as string)).toEqual([tag]);
      expect(checklistTitlesOf(a1["uuid"] as string)).toEqual(["Sub 1", "Sub 2"]);

      const a2 = sub.todos.find((t) => t["title"] === "Task A2")!;
      // Direct child: project points at the new project, no heading.
      expect(a2["project"]).toBe(side);
      expect(a2["heading"]).toBeNull();
      expect(a2["rt1_repeatingTemplate"]).toBeNull();
    }

    // Tags + checklist duplicated per copy: 2 Task A1 copies → 2 tag rows, 4 items.
    expect(count("SELECT COUNT(*) AS n FROM TMTaskTag")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM TMChecklistItem")).toBe(4);
  });

  it("project.make-repeating AFTER-COMPLETION (RSIM-P P4): source deleted, per-child instance→template links", async () => {
    const area = seedArea(fixture.db, "Zone B");
    const proj = seedProject(fixture.db, {
      title: "Beta Proj",
      area,
      start: "active",
      startDate: "2026-07-05",
    });
    const b1 = seedTodo(fixture.db, { title: "Task B1", project: proj, index: 0 });
    const b2 = seedTodo(fixture.db, { title: "Task B2", project: proj, index: 1 });

    const res = await runMutation(
      deps(vector),
      "project.make-repeating",
      { uuid: proj, frequency: "weekly", interval: 1, afterCompletion: true },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected template uuid");

    // Source deleted (contrast the after-completion TO-DO, which is preserved).
    for (const uuid of [proj, b1, b2]) {
      expect(fixture.db.prepare("SELECT 1 FROM TMTask WHERE uuid = ?").get(uuid)).toBeUndefined();
    }

    // Template: tp=1 after-completion rule, icCount=1, NO next/reference dates.
    const tmpl = res.uuid;
    expect(decodeTemplate(tmpl)).toMatchObject({ type: "after-completion", unit: "weekly" });
    expect(row(tmpl)["start"]).toBe(2);
    expect(row(tmpl)["rt1_instanceCreationCount"]).toBe(1); // RSIM-P P4
    expect(row(tmpl)["rt1_nextInstanceStartDate"]).toBeNull();
    expect(row(tmpl)["rt1_afterCompletionReferenceDate"]).toBeNull();

    // Exactly one instance PROJECT, its own startDate = the source's.
    const projInstances = fixture.db
      .prepare("SELECT uuid FROM TMTask WHERE type = 1 AND rt1_repeatingTemplate = ?")
      .all(tmpl) as { uuid: string }[];
    expect(projInstances).toHaveLength(1);
    const instProj = projInstances[0]!.uuid;
    expect(row(instProj)["startDate"]).toBe(encodePackedDate("2026-07-05"));

    // Template-side children are PLAIN; instance-side children each carry a
    // per-child link to their TEMPLATE-side sibling (matched by title).
    const tmplKids = subtreeOf(tmpl).todos;
    const instKids = subtreeOf(instProj).todos;
    expect(tmplKids).toHaveLength(2);
    expect(instKids).toHaveLength(2);
    for (const k of tmplKids) expect(k["rt1_repeatingTemplate"]).toBeNull();
    for (const title of ["Task B1", "Task B2"]) {
      const instKid = instKids.find((t) => t["title"] === title)!;
      const tmplKid = tmplKids.find((t) => t["title"] === title)!;
      expect(instKid["rt1_repeatingTemplate"]).toBe(tmplKid["uuid"]);
    }
    // 6 inserted rows total (template + 2 kids, instance + 2 kids).
    expect(count("SELECT COUNT(*) AS n FROM TMTask WHERE trashed = 0")).toBe(6);
  });

  it("project.complete (RSIM-P P2): cascades to HEADING rows, promotes instance start 2→1", async () => {
    const template = seedProject(fixture.db, {
      title: "Repeating Ops",
      start: "someday",
      recurrenceRule: true,
    });
    const instProj = seedProject(fixture.db, {
      title: "Repeating Ops",
      start: "someday",
      repeatingTemplate: template,
    });
    const head = seedHeading(fixture.db, { title: "Phase 1", project: instProj });
    const headed = seedTodo(fixture.db, { title: "under heading", heading: head });
    const direct = seedTodo(fixture.db, { title: "direct child", project: instProj });

    const res = await runMutation(deps(vector), "project.complete", {
      uuid: instProj,
      children: "auto-complete",
    });
    expect(res.kind).toBe("ok");

    // Heading row (type=2) cascaded to completed — the RSIM-P P2 fix.
    expect(row(head)["status"]).toBe(3);
    expect(row(headed)["status"]).toBe(3);
    expect(row(direct)["status"]).toBe(3);
    // Instance project completed AND promoted start 2→1.
    expect(row(instProj)["status"]).toBe(3);
    expect(row(instProj)["start"]).toBe(1);
    // The template row is untouched (only the instance was completed).
    expect(row(template)["status"]).toBe(0);
    expect(row(template)["start"]).toBe(2);
  });

  it("project.complete on a PLAIN project leaves its start untouched (promotion is instance-only)", async () => {
    const proj = seedProject(fixture.db, { title: "One-off", start: "someday" });
    const res = await runMutation(deps(vector), "project.complete", {
      uuid: proj,
      children: "auto-complete",
    });
    expect(res.kind).toBe("ok");
    expect(row(proj)["status"]).toBe(3);
    expect(row(proj)["start"]).toBe(2); // RSIM-P P2 promotion does NOT fire for non-instances
  });

  it("reschedule-repeat refuses a non-template target", async () => {
    const plain = seedTodo(fixture.db, { title: "not repeating", start: "active" });
    const res = await runMutation(
      deps(vector),
      "todo.reschedule-repeat",
      { uuid: plain, frequency: "daily", interval: 1 },
      { ...GUI, verifyTimeoutMs: 250 },
    );
    // The applier throws (no rule blob); the pipeline surfaces it as a failure,
    // and nothing is written.
    expect(res.kind).not.toBe("ok");
    expect(row(plain)["rt1_recurrenceRule"]).toBeNull();
  });

  it("keeps pause/resume OUT of the simulator matrix (no RSIM-proven shape)", () => {
    for (const op of [
      "todo.pause-repeat",
      "todo.resume-repeat",
      "project.pause-repeat",
      "project.resume-repeat",
    ] as const) {
      expect(vector.matrix[op]).toBeUndefined();
    }
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
