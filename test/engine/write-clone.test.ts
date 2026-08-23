/**
 * todo.clone / project.clone orchestrator tests: drive the real clone compound
 * end-to-end against a synthetic fixture DB with the simulator write vector
 * applying each leg (base add + checklist / terminal-state follow-ups). Asserts
 * (a) the ok result + undoToken, (b) the minted clone's DB post-state (content,
 * checklist checked-state, terminal state with the exact stopDate, structure),
 * (c) the source is untouched, and (d) the refusal taxonomy.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { encodePackedDate, encodeReminderTime } from "../../src/model/dates.ts";
import { runCloneProject, runCloneTodo } from "../../src/write/clone.ts";
import { type WriteDeps } from "../../src/write/pipeline.ts";
import { createSimulatorVector } from "../../src/write/vectors/simulator.ts";
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
const TODAY = "2026-07-05";
/** A whole-minute epoch so the ISO round-trip through set-dates is exact. */
const STOP_EPOCH = Math.floor(Date.parse("2026-07-01T09:00:00Z") / 1000);
const CREATED_EPOCH = Math.floor(Date.parse("2026-06-15T09:00:00Z") / 1000);

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
  certifiedAppVersion: null,
  allowExperimental: false,
  bounceEnabled: true,
  bounceMaxItems: 30,
  autoLaunch: true,
  helpersMode: "false",
  ui: { enabled: false },
  host: "test-host",
};

function deps(vector: WriteVector): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-clone-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
  };
}

const row = (uuid: string): Record<string, unknown> =>
  fixture.db.prepare("SELECT * FROM TMTask WHERE uuid = ?").get(uuid) as Record<string, unknown>;

/** Every non-source to-do/project row created since seeding (the minted clone tree). */
function taskByTitle(title: string, type: 0 | 1): Record<string, unknown> | undefined {
  return fixture.db
    .prepare(`SELECT * FROM TMTask WHERE title = ? AND type = ? ORDER BY rowid DESC LIMIT 1`)
    .get(title, type) as Record<string, unknown> | undefined;
}

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
  process.env["THINGS_API_STATE_DIR"] = mkdtempSync(join(tmpdir(), "clone-state-"));
  process.env["THINGS_API_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "clone-config-"));
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

describe("todo.clone", () => {
  it("copies content faithfully as a new capture (new uuid, born now)", async () => {
    const area = seedArea(fixture.db, "Home");
    const src = seedTodo(fixture.db, {
      title: "Water the plants",
      notes: "front and back",
      start: "active",
      startDate: TODAY,
      reminder: "09:30",
      deadline: "2026-07-10",
      area,
      creationDate: CREATED_EPOCH,
    });
    seedChecklistItem(fixture.db, src, "kitchen");
    seedChecklistItem(fixture.db, src, "porch");

    const res = await runCloneTodo(deps(vector), { uuid: src });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok with uuid");
    expect(res.uuid).not.toBe(src);
    expect(res.undoToken).toBeDefined();

    const c = row(res.uuid);
    expect(c["title"]).toBe("Water the plants");
    expect(c["notes"]).toBe("front and back");
    expect(c["startDate"]).toBe(encodePackedDate(TODAY));
    expect(c["reminderTime"]).toBe(encodeReminderTime("09:30"));
    expect(c["deadline"]).toBe(encodePackedDate("2026-07-10"));
    expect(c["area"]).toBe(area);
    expect(c["status"]).toBe(0);
    // A new capture: creationDate is NOW, not the source's (no --preserve-created).
    expect(c["creationDate"]).toBe(Math.floor(NOW.getTime() / 1000));
    const items = fixture.db
      .prepare(`SELECT title, status FROM TMChecklistItem WHERE task = ? ORDER BY "index"`)
      .all(res.uuid) as { title: string; status: number }[];
    expect(items.map((i) => i.title)).toEqual(["kitchen", "porch"]);
    // The source is untouched.
    expect(row(src)["title"]).toBe("Water the plants");
  });

  it("--title overrides the title and --preserve-created copies the creation date", async () => {
    const src = seedTodo(fixture.db, { title: "Original", creationDate: CREATED_EPOCH });
    const res = await runCloneTodo(deps(vector), {
      uuid: src,
      title: "Renamed clone",
      preserveCreated: true,
    });
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    const c = row(res.uuid);
    expect(c["title"]).toBe("Renamed clone");
    expect(c["creationDate"]).toBe(CREATED_EPOCH);
    expect(res.warnings?.some((w) => w.includes("MINUTE resolution"))).toBe(true);
  });

  it("--preserve-created + a reminder: splits the reminder into a follow-up leg (no reminder+createdAt collision)", async () => {
    // A single add cannot carry both a reminder and a backdated createdAt (the
    // json import forbids the pair) — the compound used to abort at the clone
    // leg (UIC8 C1c). The reminder must ride a separate todo.update leg.
    const src = seedTodo(fixture.db, {
      title: "Take meds",
      start: "active",
      startDate: TODAY,
      reminder: "08:00",
      creationDate: CREATED_EPOCH,
    });
    const res = await runCloneTodo(deps(vector), { uuid: src, preserveCreated: true });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    const c = row(res.uuid);
    // Both dimensions reproduced: the backdated creationDate AND the reminder.
    expect(c["creationDate"]).toBe(CREATED_EPOCH);
    expect(c["reminderTime"]).toBe(encodeReminderTime("08:00"));
    expect(c["startDate"]).toBe(encodePackedDate(TODAY));
    // The reminder was reproduced by a distinct leg (disclosed in the applied list).
    expect(res.warnings?.join(" ")).toContain("reproduced reminder");
  });

  it("dry-run discloses the reminder follow-up leg under --preserve-created", async () => {
    const src = seedTodo(fixture.db, {
      title: "Dry reminder",
      start: "active",
      startDate: TODAY,
      reminder: "08:00",
      creationDate: CREATED_EPOCH,
    });
    const res = await runCloneTodo(
      deps(vector),
      { uuid: src, preserveCreated: true },
      { dryRun: true },
    );
    if (res.kind !== "dry-run") throw new Error("expected dry-run");
    expect(res.plan.invocation).toContain("todo.update (reproduce reminder)");
    expect(res.plan.invocation).toContain("created-at");
  });

  it("reproduces a pre-checked checklist item (post-check follow-up leg)", async () => {
    const src = seedTodo(fixture.db, { title: "Trip prep" });
    seedChecklistItem(fixture.db, src, "passport", { status: "open" });
    seedChecklistItem(fixture.db, src, "tickets", { status: "completed" });

    const res = await runCloneTodo(deps(vector), { uuid: src });
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    const items = fixture.db
      .prepare(`SELECT title, status FROM TMChecklistItem WHERE task = ? ORDER BY "index"`)
      .all(res.uuid) as { title: string; status: number }[];
    expect(items).toEqual([
      { title: "passport", status: 0 },
      { title: "tickets", status: 3 },
    ]);
  });

  it("reproduces a logged (completed) source with the exact stopDate", async () => {
    const src = seedTodo(fixture.db, {
      title: "Filed taxes",
      status: "completed",
      stopDate: STOP_EPOCH,
    });
    const res = await runCloneTodo(deps(vector), { uuid: src });
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    const c = row(res.uuid);
    expect(c["status"]).toBe(3);
    expect(c["stopDate"]).toBe(STOP_EPOCH);
  });

  it("reproduces a canceled source (status + stopDate) via the flip", async () => {
    const src = seedTodo(fixture.db, {
      title: "Abandoned errand",
      status: "canceled",
      stopDate: STOP_EPOCH,
    });
    const res = await runCloneTodo(deps(vector), { uuid: src });
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    const c = row(res.uuid);
    expect(c["status"]).toBe(2);
    expect(c["stopDate"]).toBe(STOP_EPOCH);
  });

  it("refuses a trashed source, naming the restore path", async () => {
    const src = seedTodo(fixture.db, { title: "Binned", trashed: true });
    const res = await runCloneTodo(deps(vector), { uuid: src });
    expect(res.kind).toBe("blocked");
    if (res.kind !== "blocked") throw new Error("expected blocked");
    expect(res.detail).toContain("Trash");
    expect(res.remediation).toContain("restore");
  });

  it("a repeating template with an undecodable rule refuses fail-closed (H-CLONE-SOURCE)", async () => {
    // A template source now routes to the template-clone compound (re-promote);
    // an UNDECODABLE rule (the fake blob) refuses before minting anything. A
    // decodable template's full re-promote path is covered in
    // write-promote-clone.test.ts (template-direct clone).
    const src = seedTodo(fixture.db, { title: "Weekly review", recurrenceRule: true });
    const res = await runCloneTodo(deps(vector), { uuid: src }, { dangerouslyDriveGui: true });
    expect(res.kind).toBe("blocked");
    if (res.kind !== "blocked") throw new Error("expected blocked");
    expect(res.hazard).toBe("H-CLONE-SOURCE");
    expect(res.detail).toContain("could not be decoded");
  });

  it("dry-run discloses the leg sequence without mutating", async () => {
    const src = seedTodo(fixture.db, { title: "Dry" });
    const before = row(src);
    const res = await runCloneTodo(deps(vector), { uuid: src }, { dryRun: true });
    expect(res.kind).toBe("dry-run");
    if (res.kind !== "dry-run") throw new Error("expected dry-run");
    expect(res.plan.invocation).toContain("todo.add");
    expect(taskByTitle("Dry", 0)?.["uuid"]).toBe(before["uuid"]); // no new row
  });
});

describe("project.clone", () => {
  it("copies the project structure (area, heading, headed + root children)", async () => {
    const area = seedArea(fixture.db, "Work");
    const src = seedProject(fixture.db, { title: "Launch", notes: "Q3", area });
    // Root child first, then a heading with its own child.
    seedTodo(fixture.db, { title: "Kickoff", project: src, index: 0 });
    const heading = seedHeading(fixture.db, { title: "Backlog", project: src, index: 1 });
    seedTodo(fixture.db, { title: "Polish", heading, index: 2 });

    const res = await runCloneProject(deps(vector), { uuid: src });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(res.uuid).not.toBe(src);

    const clone = row(res.uuid);
    expect(clone["title"]).toBe("Launch");
    expect(clone["notes"]).toBe("Q3");
    expect(clone["area"]).toBe(area);

    // A cloned heading row exists under the clone project.
    const cloneHeading = fixture.db
      .prepare(`SELECT uuid FROM TMTask WHERE type = 2 AND project = ? AND title = ?`)
      .get(res.uuid, "Backlog") as { uuid: string } | undefined;
    if (cloneHeading === undefined) throw new Error("expected a cloned heading");
    // Root child sits directly under the clone project; headed child under the heading.
    const rootChild = fixture.db
      .prepare(`SELECT title FROM TMTask WHERE type = 0 AND project = ? AND title = ?`)
      .get(res.uuid, "Kickoff") as { title: string } | undefined;
    expect(rootChild?.title).toBe("Kickoff");
    const headedChild = fixture.db
      .prepare(`SELECT title FROM TMTask WHERE type = 0 AND heading = ? AND title = ?`)
      .get(cloneHeading.uuid, "Polish") as { title: string } | undefined;
    expect(headedChild?.title).toBe("Polish");
  });

  it("reproduces a logged child's terminal state with the exact stopDate", async () => {
    const src = seedProject(fixture.db, { title: "Sprint" });
    seedTodo(fixture.db, { title: "Open task", project: src, index: 0 });
    seedTodo(fixture.db, {
      title: "Done task",
      project: src,
      status: "completed",
      stopDate: STOP_EPOCH,
      index: 1,
    });

    const res = await runCloneProject(deps(vector), { uuid: src });
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    const cloneDone = fixture.db
      .prepare(`SELECT status, stopDate FROM TMTask WHERE project = ? AND title = ?`)
      .get(res.uuid, "Done task") as { status: number; stopDate: number } | undefined;
    expect(cloneDone?.status).toBe(3);
    expect(cloneDone?.stopDate).toBe(STOP_EPOCH);
    const cloneOpen = fixture.db
      .prepare(`SELECT status FROM TMTask WHERE project = ? AND title = ?`)
      .get(res.uuid, "Open task") as { status: number } | undefined;
    expect(cloneOpen?.status).toBe(0);
  });

  it("refuses a project holding a nested repeating template, naming the child", async () => {
    const src = seedProject(fixture.db, { title: "Ops" });
    seedTodo(fixture.db, { title: "Rotate creds", project: src, recurrenceRule: true });

    const res = await runCloneProject(deps(vector), { uuid: src });
    expect(res.kind).toBe("blocked");
    if (res.kind !== "blocked") throw new Error("expected blocked");
    expect(res.detail).toContain("Rotate creds");
    expect(res.detail).toContain("nested repeating template");
  });

  it("refuses a trashed project source", async () => {
    const src = seedProject(fixture.db, { title: "Shelved", trashed: true });
    const res = await runCloneProject(deps(vector), { uuid: src });
    expect(res.kind).toBe("blocked");
  });
});
