/**
 * Granular checklist edit + undo engine tests: intent capture through
 * runEditChecklist, and the TARGETED 3-way-merge undo (planUndo/runUndo). No
 * `open`/`shortcuts run`/`osascript` ever fires — the url-scheme vector is a
 * fake that rewrites the fixture checklist from the compiled payload, exactly
 * as Things would (CLAUDE.md safety rails: zero live writes).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runEditChecklist } from "../../src/write/edit-checklist.ts";
import { runUndo } from "../../src/write/undo.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedChecklistItem, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "mike",
  auditEnabled: true,
  acceptedFingerprint: null,
  allowExperimental: false,
  ui: { enabled: false },
  host: "test-host",
};

const URL_MATRIX: VectorMatrix = {
  "todo.replace-checklist": { support: "yes", disruption: 0, validation: "validated" },
};

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let auditDir: string;
let lockSeq = 0;
let modSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
  auditDir = mkdtempSync(join(tmpdir(), "things-api-editcl-audit-"));
});
afterEach(() => {
  fixture.close();
  rmSync(auditDir, { recursive: true, force: true });
});

interface CLItem {
  title: string;
  completed: boolean;
}

function seedChecklist(uuid: string, items: CLItem[]): void {
  items.forEach((item, i) =>
    seedChecklistItem(fixture.db, uuid, item.title, {
      status: item.completed ? "completed" : "open",
      index: i,
    }),
  );
}

/** Current checklist, ordered — {title, completed}. */
function readChecklist(uuid: string): CLItem[] {
  const rows = fixture.db
    .prepare(`SELECT title, status FROM TMChecklistItem WHERE task = ? ORDER BY "index"`)
    .all(uuid) as { title: string; status: number }[];
  return rows.map((r) => ({ title: r.title, completed: r.status === 3 }));
}

/** Rewrite the fixture checklist to match a compiled replace-checklist payload. */
function applyRewrite(payload: string): void {
  let uuid: string;
  let specs: CLItem[];
  if (payload.includes("things:///json")) {
    const data = decodeURIComponent((payload.split("data=")[1] ?? "").split("&")[0] ?? "");
    const arr = JSON.parse(data) as {
      id: string;
      attributes: { "checklist-items": { attributes: { title: string; completed?: boolean } }[] };
    }[];
    const op = arr[0] as (typeof arr)[number];
    uuid = op.id;
    specs = op.attributes["checklist-items"].map((ci) => ({
      title: ci.attributes.title,
      completed: ci.attributes.completed === true,
    }));
  } else {
    const query = payload.split("?")[1] ?? "";
    const params = new URLSearchParams(query);
    uuid = params.get("id") ?? "";
    const raw = params.get("checklist-items") ?? "";
    specs = raw
      .split("\n")
      .filter((s) => s !== "")
      .map((t) => ({ title: t, completed: false }));
  }
  fixture.db.prepare("DELETE FROM TMChecklistItem WHERE task = ?").run(uuid);
  seedChecklist(uuid, specs);
  fixture.db
    .prepare("UPDATE TMTask SET userModificationDate = ? WHERE uuid = ?")
    .run(NOW_EPOCH + ++modSeq, uuid);
}

/** A url-scheme vector that faithfully rewrites the checklist per dispatch. */
function rewritingVector(): { vector: WriteVector; calls: string[] } {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "url-scheme",
    matrix: URL_MATRIX,
    async execute(invocation) {
      calls.push(invocation.payload);
      applyRewrite(invocation.payload);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

/** A vector that must never dispatch (undo refusal paths). */
function inertVector(): { vector: WriteVector; calls: string[] } {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "url-scheme",
    matrix: URL_MATRIX,
    async execute() {
      throw new Error("the checklist must not be rewritten on a refusal");
    },
  };
  return { vector, calls };
}

function deps(vector: WriteVector): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-editcl-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    pkgVersion: "0.7.0",
  };
}

function writeAudit(records: AuditRecord[]): void {
  writeFileSync(join(auditDir, "2026-07.jsonl"), records.map((r) => JSON.stringify(r)).join("\n"));
}

function summaryRecord(partial: Partial<AuditRecord>): AuditRecord {
  return {
    v: 1,
    ts: "2026-07-05T10:00:00.000Z",
    actor: "mike",
    host: "test-host",
    op: "todo.edit-checklist-item",
    uuid: null,
    vector: "url-scheme",
    disruption: 0,
    invocation: "edit-checklist",
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

// -------------------------------------------------- forward: intent capture

describe("runEditChecklist — intent capture", () => {
  it("check records the intent + the targeted item's pre/post state (not a snapshot)", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    seedChecklist(uuid, [
      { title: "A", completed: false },
      { title: "B", completed: false },
      { title: "C", completed: false },
      { title: "D", completed: false },
    ]);
    const { vector } = rewritingVector();
    const result = await runEditChecklist(deps(vector), uuid, { action: "check", item: "C" });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.op).toBe("todo.edit-checklist-item");
    // The rewrite leg is excluded from undo; the summary is the undoable unit.
    const leg = auditRecords.find((r) => r.txn?.role === "leg");
    const summary = auditRecords.find((r) => r.op === "todo.edit-checklist-item");
    expect(leg?.op).toBe("todo.replace-checklist");
    expect(summary?.result).toBe("ok");
    expect(summary?.requested).toMatchObject({ action: "check", title: "C", position: 3 });
    expect(summary?.pre).toEqual({ title: "C", completed: false, position: 3 });
    expect(summary?.observed).toEqual({ title: "C", completed: true, position: 3 });
    // NO whole-list snapshot on the summary (intent, not snapshot).
    expect(summary?.pre).not.toHaveProperty("checklistTitles");
    expect(readChecklist(uuid).find((i) => i.title === "C")?.completed).toBe(true);
  });

  it("remove records {title, completed, position} — enough to re-add", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    seedChecklist(uuid, [
      { title: "A", completed: false },
      { title: "B", completed: true },
    ]);
    const { vector } = rewritingVector();
    await runEditChecklist(deps(vector), uuid, { action: "remove", item: "B" });
    const summary = auditRecords.find((r) => r.op === "todo.edit-checklist-item");
    expect(summary?.pre).toEqual({ title: "B", completed: true, position: 2 });
    expect(summary?.observed).toBeNull();
    expect(readChecklist(uuid)).toEqual([{ title: "A", completed: false }]);
  });

  it("rename records the OLD title (pre) and NEW title (post) for a targeted revert", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    seedChecklist(uuid, [{ title: "old", completed: false }]);
    const { vector } = rewritingVector();
    await runEditChecklist(deps(vector), uuid, { action: "rename", item: "old", title: "new" });
    const summary = auditRecords.find((r) => r.op === "todo.edit-checklist-item");
    expect(summary?.requested).toMatchObject({ action: "rename", title: "new", oldTitle: "old" });
    expect(summary?.pre).toMatchObject({ title: "old" });
    expect(summary?.observed).toMatchObject({ title: "new" });
  });

  it("a bad target surfaces as blocked, nothing dispatched", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    seedChecklist(uuid, [{ title: "A", completed: false }]);
    const { vector, calls } = rewritingVector();
    await expect(
      runEditChecklist(deps(vector), uuid, { action: "check", item: "nope" }),
    ).rejects.toThrow(/no checklist item/);
    expect(calls).toHaveLength(0);
  });
});

// ----------------------------------------- undo: targeted 3-way merge

describe("runUndo — granular checklist inverse (3-way merge)", () => {
  it("MAINTAINER SCENARIO: check C, out-of-band check A, undo unchecks ONLY C (A stays)", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    seedChecklist(uuid, [
      { title: "A", completed: false },
      { title: "B", completed: false },
      { title: "C", completed: false },
      { title: "D", completed: false },
    ]);
    const { vector } = rewritingVector();

    // 1. CLI checks item C (through the real orchestrator).
    await runEditChecklist(deps(vector), uuid, { action: "check", item: "C" });
    // 2. The user checks item A in the GUI (out of band).
    fixture.db
      .prepare("UPDATE TMChecklistItem SET status = 3 WHERE task = ? AND title = 'A'")
      .run(uuid);
    // 3. `things undo`.
    writeAudit(auditRecords);
    const items = await runUndo(deps(vector), auditDir);

    expect(items[0]?.outcome).toBe("ok");
    expect(readChecklist(uuid)).toEqual([
      { title: "A", completed: true }, // out-of-band check SURVIVES
      { title: "B", completed: false },
      { title: "C", completed: false }, // only C is reverted
      { title: "D", completed: false },
    ]);
  });

  it("REFUSES (blocked) when the TARGETED item changed out of band; its state is preserved", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    // Audit says C was checked (post completed). Reality: C is now OPEN again
    // (someone unchecked it out of band) — the target itself moved.
    seedChecklist(uuid, [{ title: "C", completed: false }]);
    writeAudit([
      summaryRecord({
        uuid,
        requested: { uuid, action: "check", title: "C", position: 1 },
        pre: { title: "C", completed: false, position: 1 },
        observed: { title: "C", completed: true, position: 1 },
      }),
    ]);
    const { vector, calls } = inertVector();
    const items = await runUndo(deps(vector), auditDir);

    expect(items[0]?.outcome).toBe("failed");
    const blocked = items[0]?.results[0];
    expect(blocked?.kind).toBe("blocked");
    if (blocked?.kind === "blocked") {
      expect(blocked.reason).toBe("environment");
      expect(blocked.detail).toContain("out of band");
    }
    expect(calls).toHaveLength(0);
    expect(readChecklist(uuid)).toEqual([{ title: "C", completed: false }]);
  });

  it("disambiguates duplicate titles by recorded position", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    // Two "X"; the SECOND (position 3) was checked.
    seedChecklist(uuid, [
      { title: "X", completed: false },
      { title: "Y", completed: false },
      { title: "X", completed: true },
    ]);
    writeAudit([
      summaryRecord({
        uuid,
        requested: { uuid, action: "check", title: "X", position: 3 },
        pre: { title: "X", completed: false, position: 3 },
        observed: { title: "X", completed: true, position: 3 },
      }),
    ]);
    const { vector } = rewritingVector();
    const items = await runUndo(deps(vector), auditDir);

    expect(items[0]?.outcome).toBe("ok");
    expect(readChecklist(uuid)).toEqual([
      { title: "X", completed: false }, // first X untouched
      { title: "Y", completed: false },
      { title: "X", completed: false }, // second X reverted
    ]);
  });

  it("REFUSES when duplicate titles make the target ambiguous (position no longer matches)", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    // Recorded position 1, but both X's now sit at indices 1 and 2 (reordered).
    seedChecklist(uuid, [
      { title: "Y", completed: false },
      { title: "X", completed: true },
      { title: "X", completed: true },
    ]);
    writeAudit([
      summaryRecord({
        uuid,
        requested: { uuid, action: "check", title: "X", position: 1 },
        pre: { title: "X", completed: false, position: 1 },
        observed: { title: "X", completed: true, position: 1 },
      }),
    ]);
    const { vector, calls } = inertVector();
    const items = await runUndo(deps(vector), auditDir);

    expect(items[0]?.outcome).toBe("failed");
    expect(items[0]?.results[0]?.kind).toBe("blocked");
    if (items[0]?.results[0]?.kind === "blocked") {
      expect(items[0].results[0].detail).toContain("ambiguous");
    }
    expect(calls).toHaveLength(0);
  });

  it("add-undo removes the added item; a concurrent edit to another item survives", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    // 'new' was added at position 2; item 'A' got checked out of band since.
    seedChecklist(uuid, [
      { title: "A", completed: true },
      { title: "new", completed: false },
    ]);
    writeAudit([
      summaryRecord({
        uuid,
        requested: { uuid, action: "add", title: "new", position: 2 },
        observed: { title: "new", completed: false, position: 2 },
      }),
    ]);
    const { vector } = rewritingVector();
    const items = await runUndo(deps(vector), auditDir);
    expect(items[0]?.outcome).toBe("ok");
    expect(readChecklist(uuid)).toEqual([{ title: "A", completed: true }]);
  });

  it("remove-undo restores the item's title, state, AND position", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    // 'B' (completed, was position 2) had been removed; list is now [A, C].
    seedChecklist(uuid, [
      { title: "A", completed: false },
      { title: "C", completed: false },
    ]);
    writeAudit([
      summaryRecord({
        uuid,
        requested: { uuid, action: "remove", title: "B", position: 2 },
        pre: { title: "B", completed: true, position: 2 },
        observed: null,
      }),
    ]);
    const { vector } = rewritingVector();
    const items = await runUndo(deps(vector), auditDir);
    expect(items[0]?.outcome).toBe("ok");
    expect(readChecklist(uuid)).toEqual([
      { title: "A", completed: false },
      { title: "B", completed: true }, // restored at position 2 with its state
      { title: "C", completed: false },
    ]);
  });

  it("rename-undo restores the old title in place", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    seedChecklist(uuid, [
      { title: "keep", completed: false },
      { title: "new", completed: true },
    ]);
    writeAudit([
      summaryRecord({
        uuid,
        requested: { uuid, action: "rename", title: "new", oldTitle: "old", position: 2 },
        pre: { title: "old", completed: true, position: 2 },
        observed: { title: "new", completed: true, position: 2 },
      }),
    ]);
    const { vector } = rewritingVector();
    const items = await runUndo(deps(vector), auditDir);
    expect(items[0]?.outcome).toBe("ok");
    expect(readChecklist(uuid)).toEqual([
      { title: "keep", completed: false },
      { title: "old", completed: true },
    ]);
  });

  it("move-undo returns the item to its old position", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    // 'M' was moved from position 1 to position 3.
    seedChecklist(uuid, [
      { title: "A", completed: false },
      { title: "B", completed: false },
      { title: "M", completed: false },
    ]);
    writeAudit([
      summaryRecord({
        uuid,
        requested: { uuid, action: "move", title: "M", position: 3, to: 3 },
        pre: { title: "M", completed: false, position: 1 },
        observed: { title: "M", completed: false, position: 3 },
      }),
    ]);
    const { vector } = rewritingVector();
    const items = await runUndo(deps(vector), auditDir);
    expect(items[0]?.outcome).toBe("ok");
    expect(readChecklist(uuid).map((i) => i.title)).toEqual(["M", "A", "B"]);
  });
});

// --------------------------------------------------- undo: wholesale replace

describe("runUndo — wholesale replace-checklist", () => {
  it("restores titles AND per-item states via the json form (P18)", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    // Current = the post-replacement state [Solo]; pre = [X done, Y open].
    seedChecklist(uuid, [{ title: "Solo", completed: false }]);
    writeAudit([
      summaryRecord({
        op: "todo.replace-checklist",
        uuid,
        requested: { uuid, items: ["Solo"] },
        pre: { checklistTitles: ["X", "Y"], checklistStates: ["completed", "open"] },
        observed: { checklistTitles: ["Solo"], checklistStates: ["open"] },
      }),
    ]);
    const { vector, calls } = rewritingVector();
    const items = await runUndo(deps(vector), auditDir);

    expect(items[0]?.outcome).toBe("ok");
    expect(calls[0]).toContain("things:///json"); // states ride the json form
    expect(readChecklist(uuid)).toEqual([
      { title: "X", completed: true },
      { title: "Y", completed: false },
    ]);
  });

  it("REFUSES on ANY out-of-band difference from the recorded post snapshot", async () => {
    const uuid = seedTodo(fixture.db, { title: "list" });
    // Observed post was [Solo open]; current has an extra out-of-band item.
    seedChecklist(uuid, [
      { title: "Solo", completed: false },
      { title: "Sneaked", completed: false },
    ]);
    writeAudit([
      summaryRecord({
        op: "todo.replace-checklist",
        uuid,
        requested: { uuid, items: ["Solo"] },
        pre: { checklistTitles: ["X"], checklistStates: ["open"] },
        observed: { checklistTitles: ["Solo"], checklistStates: ["open"] },
      }),
    ]);
    const { vector, calls } = inertVector();
    const items = await runUndo(deps(vector), auditDir);

    expect(items[0]?.outcome).toBe("failed");
    expect(items[0]?.results[0]?.kind).toBe("blocked");
    expect(calls).toHaveLength(0);
    // The out-of-band checklist is untouched.
    expect(readChecklist(uuid).map((i) => i.title)).toEqual(["Solo", "Sneaked"]);
  });
});
