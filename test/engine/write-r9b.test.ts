/**
 * Phase 9b engine tests: reminders (codec, emitter, auto-preserve/clear),
 * notes append/prepend, move-to-inbox, duplicate, area/tag updates. Fake
 * vectors simulate the app semantics the R/E suites validated.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { decodeReminderTime, encodeReminderTime, reminderUrlToken } from "../../src/model/dates.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTag, seedTodo, tagArea, tagTask } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);
const TODAY_ISO = "2026-07-05";

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
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
  ui: { enabled: false },
  host: "test-host",
};

const URL_MATRIX: VectorMatrix = Object.fromEntries(
  ["todo.add", "todo.update", "todo.duplicate", "project.update", "project.set-tags"].map((op) => [
    op,
    { support: "yes", disruption: 0, validation: "validated" },
  ]),
) as VectorMatrix;

const AS_MATRIX: VectorMatrix = Object.fromEntries(
  ["todo.move", "area.update", "tag.update", "project.set-tags"].map((op) => [
    op,
    { support: "yes", disruption: 0, validation: "validated" },
  ]),
) as VectorMatrix;

function fakeVector(
  id: WriteVector["id"],
  matrix: VectorMatrix,
  effect: ((payload: string) => void) | null,
) {
  const calls: string[] = [];
  const vector: WriteVector = {
    id,
    matrix,
    async execute(invocation) {
      calls.push(invocation.payload);
      effect?.(invocation.payload);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
}

function deps(vectors: WriteVector[]): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-9b-lock-${process.pid}-${lockSeq++}`),
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

describe("reminder codec + emitter", () => {
  it("round-trips all lab samples", () => {
    for (const [time, raw] of [
      ["18:00", 1207959552],
      ["06:30", 434110464],
      ["00:15", 15728640],
      ["21:15", 1425014784],
      ["22:05", 1481637888],
      ["10:05", 676331520],
    ] as const) {
      expect(encodeReminderTime(time)).toBe(raw);
      expect(decodeReminderTime(raw)).toBe(time);
    }
  });

  it("emits the deterministic URL spelling per hour class (oddity 2d)", () => {
    expect(reminderUrlToken("06:45")).toBe("06:45");
    expect(reminderUrlToken("6:45")).toBe("06:45"); // normalized, never bare
    expect(reminderUrlToken("00:05")).toBe("00:05");
    expect(reminderUrlToken("10:05")).toBe("10:05am");
    expect(reminderUrlToken("11:59")).toBe("11:59am");
    expect(reminderUrlToken("12:30")).toBe("12:30");
    expect(reminderUrlToken("14:10")).toBe("14:10");
    expect(reminderUrlToken("23:59")).toBe("23:59");
  });
});

describe("reminders through the pipeline", () => {
  it("todo.add compiles when@token and verifies the stored reminder", async () => {
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      seedTodo(fixture.db, {
        uuid: "NEW-R",
        title: "Remind",
        startDate: TODAY_ISO,
        reminder: "10:05",
        creationDate: NOW_EPOCH,
      });
    });
    const result = await runMutation(deps([vector]), "todo.add", {
      title: "Remind",
      when: "today",
      reminder: "10:05",
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(encodeURIComponent("today@10:05am"));
  });

  it("H-REMINDER-SCOPE blocks a reminder without a schedulable when", async () => {
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(deps([vector]), "todo.add", {
      title: "X",
      when: "someday",
      reminder: "10:05",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-REMINDER-SCOPE");
    expect(calls).toHaveLength(0);
  });

  it("todo.update auto-preserves an existing reminder on re-schedule", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "Keep",
      startDate: TODAY_ISO,
      reminder: "18:00",
    });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      touch(uuid, "startBucket = 1"); // app moves to evening; reminder stays
    });
    const result = await runMutation(deps([vector]), "todo.update", { uuid, when: "evening" });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(encodeURIComponent("evening@18:00"));
    if (result.kind === "ok") expect(result.observed?.["reminder"]).toBe("18:00");
  });

  it("todo.update reminder:null compiles a bare when and verifies the clear", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "Clear",
      startDate: TODAY_ISO,
      reminder: "18:00",
    });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      touch(uuid, "reminderTime = NULL");
    });
    const result = await runMutation(deps([vector]), "todo.update", {
      uuid,
      when: "today",
      reminder: null,
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toMatch(/when=today(&|$)/);
    expect(calls[0]).not.toContain("%40"); // no @token
    if (result.kind === "ok") expect(result.observed?.["reminder"]).toBeNull();
  });

  it("silent reminder loss is caught: app clears it but delta expected preservation", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "Lost",
      startDate: TODAY_ISO,
      reminder: "18:00",
    });
    const { vector } = fakeVector("url-scheme", URL_MATRIX, () => {
      touch(uuid, "reminderTime = NULL"); // hostile app: drops the reminder
    });
    const result = await runMutation(
      deps([vector]),
      "todo.update",
      { uuid, when: "today" },
      { verifyTimeoutMs: 300 },
    );
    expect(result.kind).toBe("verify-failed");
  });
});

describe("notes modes", () => {
  it("appendNotes joins with newline against existing notes (E04)", async () => {
    const uuid = seedTodo(fixture.db, { title: "N", notes: "BASE" });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      touch(uuid, "notes = 'BASE' || char(10) || 'TAIL'");
    });
    const result = await runMutation(deps([vector]), "todo.update", {
      uuid,
      appendNotes: "TAIL",
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain("append-notes=TAIL");
  });

  it("appendNotes against an EMPTY note expects no separator (E11)", async () => {
    const uuid = seedTodo(fixture.db, { title: "N2", notes: "" });
    const { vector } = fakeVector("url-scheme", URL_MATRIX, () => {
      touch(uuid, "notes = 'SOLO'");
    });
    const result = await runMutation(deps([vector]), "todo.update", {
      uuid,
      appendNotes: "SOLO",
    });
    expect(result.kind).toBe("ok");
  });

  it("notes + appendNotes is a hard param conflict", async () => {
    const uuid = seedTodo(fixture.db, { title: "N3" });
    const { vector } = fakeVector("url-scheme", URL_MATRIX, null);
    await expect(
      runMutation(deps([vector]), "todo.update", { uuid, notes: "A", appendNotes: "B" }),
    ).rejects.toThrow(/exclusive/);
  });
});

describe("move to inbox / duplicate / entity updates", () => {
  it("todo.move inbox compiles AppleScript and verifies the de-schedule (E06)", async () => {
    const uuid = seedTodo(fixture.db, { title: "Mv", startDate: TODAY_ISO });
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, () => {
      touch(uuid, "start = 0, startDate = NULL");
    });
    const result = await runMutation(
      deps([vector]),
      "todo.move",
      { uuid, inbox: true },
      { vector: "applescript" },
    );
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`move to do id "${uuid}" to list "Inbox"`);
  });

  it("todo.duplicate discovers the copy and asserts fidelity (E07)", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "Dup",
      notes: "BODY",
      creationDate: NOW_EPOCH - 500,
    });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      seedTodo(fixture.db, {
        uuid: "COPY-1",
        title: "Dup",
        notes: "BODY",
        creationDate: NOW_EPOCH,
        start: "inbox",
      });
    });
    const result = await runMutation(deps([vector]), "todo.duplicate", { uuid });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.uuid).toBe("COPY-1");
    expect(calls[0]).toContain("duplicate=true");
  });

  it("todo.duplicate is blocked on repeating templates", async () => {
    const uuid = seedTodo(fixture.db, { title: "Tmpl", recurrenceRule: true });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(deps([vector]), "todo.duplicate", { uuid });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-REPEAT-SCHEDULE");
    expect(calls).toHaveLength(0);
  });

  it("area.update renames + retags with entity-updated verification (E01)", async () => {
    const areaUuid = seedArea(fixture.db, "Home");
    const tagUuid = seedTag(fixture.db, "deep");
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, () => {
      fixture.db.prepare("UPDATE TMArea SET title = 'Casa' WHERE uuid = ?").run(areaUuid);
      tagArea(fixture.db, areaUuid, tagUuid);
    });
    const result = await runMutation(deps([vector]), "area.update", {
      target: "Home",
      title: "Casa",
      tags: ["deep"],
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`set name of area id "${areaUuid}" to "Casa"`);
    expect(calls[0]).toContain(`set tag names of area id "${areaUuid}" to "deep"`);
    if (result.kind === "ok") {
      expect(result.observed).toEqual({ title: "Casa", tags: ["deep"] });
    }
  });

  it("tag.update re-parents by uuid specifier and verifies (E03)", async () => {
    const parent = seedTag(fixture.db, "work");
    const child = seedTag(fixture.db, "deep");
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, () => {
      fixture.db.prepare("UPDATE TMTag SET parent = ? WHERE uuid = ?").run(parent, child);
    });
    const result = await runMutation(deps([vector]), "tag.update", {
      target: "deep",
      parent: "work",
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`set parent tag of tag id "${child}" to tag id "${parent}"`);
  });

  it("tag.update --unnest compiles the property-delete form and verifies parent=null (P29)", async () => {
    const parent = seedTag(fixture.db, "work");
    const child = seedTag(fixture.db, "deep", parent);
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, () => {
      fixture.db.prepare("UPDATE TMTag SET parent = NULL WHERE uuid = ?").run(child);
    });
    const result = await runMutation(deps([vector]), "tag.update", {
      target: "deep",
      unnest: true,
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain('delete parent tag of tag "deep"');
    if (result.kind === "ok") expect(result.observed?.["parent"]).toBeNull();
  });

  it("tag.update rejects parent + unnest together", async () => {
    seedTag(fixture.db, "work");
    seedTag(fixture.db, "deep");
    const { vector } = fakeVector("applescript", AS_MATRIX, null);
    await expect(
      runMutation(deps([vector]), "tag.update", { target: "deep", parent: "work", unnest: true }),
    ).rejects.toThrow(/exclusive/);
  });

  it("tag.update to an unknown parent is blocked (H-UNKNOWN-TAG)", async () => {
    seedTag(fixture.db, "deep");
    const { vector, calls } = fakeVector("applescript", AS_MATRIX, null);
    const result = await runMutation(deps([vector]), "tag.update", {
      target: "deep",
      parent: "nope",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-UNKNOWN-TAG");
    expect(calls).toHaveLength(0);
  });

  it("area.update silent no-op is classified (nothing moves)", async () => {
    seedArea(fixture.db, "Home");
    const { vector } = fakeVector("applescript", AS_MATRIX, null);
    const result = await runMutation(
      deps([vector]),
      "area.update",
      { target: "Home", title: "Casa" },
      { verifyTimeoutMs: 300 },
    );
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") expect(result.reason).toBe("silent-noop");
  });
});

describe("dated reminders (Phase 12b, R17–R21)", () => {
  it("todo.add with a dated reminder compiles when=DATE@token and verifies", async () => {
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      seedTodo(fixture.db, {
        uuid: "NEW-D",
        title: "Dentist",
        start: "someday",
        startDate: "2026-07-09",
        reminder: "15:00",
        creationDate: NOW_EPOCH,
      });
    });
    const result = await runMutation(deps([vector]), "todo.add", {
      title: "Dentist",
      when: "2026-07-09",
      reminder: "15:00",
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(encodeURIComponent("2026-07-09@15:00"));
  });

  it("auto-preserves an existing reminder on a dated re-schedule", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "Keep-dated",
      startDate: TODAY_ISO,
      reminder: "06:45",
    });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      touch(uuid, "startDate = 132805760, start = 2"); // app re-dates; reminder rides along
    });
    const result = await runMutation(deps([vector]), "todo.update", {
      uuid,
      when: "2026-07-09",
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(encodeURIComponent("2026-07-09@06:45"));
  });

  it("blocks clearing a DATED reminder (sticky — no URL clear path, R20/R21)", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "Sticky",
      start: "someday",
      startDate: "2026-07-09",
      reminder: "06:45",
    });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(deps([vector]), "todo.update", {
      uuid,
      when: "2026-07-10",
      reminder: null,
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.hazard).toBe("H-REMINDER-SCOPE");
      expect(result.detail).toContain("persist");
    }
    expect(calls).toHaveLength(0);
  });

  it("still blocks reminders on anytime/someday", async () => {
    const { vector } = fakeVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(deps([vector]), "todo.add", {
      title: "X",
      when: "anytime",
      reminder: "09:00",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-REMINDER-SCOPE");
  });
});

describe("project tags + reminders (Phase 21b)", () => {
  it("project.update sets a reminder via when=<list>@time and verifies it (A3)", async () => {
    const uuid = seedProject(fixture.db, { title: "Proj" });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      touch(uuid, `startDate = ${132805248}, start = 1, startBucket = 0, reminderTime = 970981376`);
    });
    const result = await runMutation(deps([vector]), "project.update", {
      uuid,
      when: "today",
      reminder: "14:30",
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(encodeURIComponent("today@14:30"));
    if (result.kind === "ok") expect(result.observed?.["reminder"]).toBe("14:30");
  });

  it("H-REMINDER-SCOPE blocks a project reminder without a schedulable when", async () => {
    const uuid = seedProject(fixture.db, { title: "Proj" });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(deps([vector]), "project.update", {
      uuid,
      when: "someday",
      reminder: "10:05",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-REMINDER-SCOPE");
    expect(calls).toHaveLength(0);
  });

  it("project.set-tags replaces the tag set via update-project?tags= (A1)", async () => {
    const uuid = seedProject(fixture.db, { title: "Proj" });
    const prio = seedTag(fixture.db, "prio");
    const high = seedTag(fixture.db, "high");
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, () => {
      tagTask(fixture.db, uuid, prio);
      tagTask(fixture.db, uuid, high);
    });
    const result = await runMutation(deps([vector]), "project.set-tags", {
      uuid,
      tags: ["prio", "high"],
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain("things:///update-project?id=");
    expect(calls[0]).toContain(encodeURIComponent("prio,high"));
  });

  it("project.set-tags rejects unknown tags before writing (H-UNKNOWN-TAG)", async () => {
    const uuid = seedProject(fixture.db, { title: "Proj" });
    const { vector, calls } = fakeVector("url-scheme", URL_MATRIX, null);
    const result = await runMutation(deps([vector]), "project.set-tags", {
      uuid,
      tags: ["ghost"],
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-UNKNOWN-TAG");
    expect(calls).toHaveLength(0);
  });
});
