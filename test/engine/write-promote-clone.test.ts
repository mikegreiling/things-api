/**
 * promote-via-clone orchestrators (make/add-repeating): drive the FULL compound
 * end-to-end against a synthetic fixture DB with the simulator write vector
 * applying each leg (clone → native promote → trash). Asserts (a) the ok result +
 * repeating block + undoToken, (b) the original is recoverable in the Trash, (c)
 * the summary audit record captures template/instance/original, (d) the clone is
 * an EMBEDDED leg (not an independent todo.clone summary), (e) the undo trash-both
 * + restore round-trip, (f) the refusal + gating copy. No Things app is touched.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { decodePackedDate, encodePackedDate } from "../../src/model/dates.ts";
import { decodeRecurrenceRule } from "../../src/model/recurrence.ts";
import { runCloneProject, runCloneTodo } from "../../src/write/clone.ts";
import type { RepeatRuleParams } from "../../src/write/operations.ts";
import {
  runAddRepeatingProject,
  runAddRepeatingTodo,
  runMakeRepeatingProject,
  runMakeRepeatingTodo,
} from "../../src/write/promote-clone.ts";
import { composeRepeatRuleSpec, ruleXml } from "../../src/write/recurrence-rule-blob.ts";
import { type WriteDeps } from "../../src/write/pipeline.ts";
import { runUndo } from "../../src/write/undo.ts";
import { createSimulatorVector } from "../../src/write/vectors/simulator.ts";
import type { WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
/** A pre-write umd well before NOW — the value --preserve-modified must return X to. */
const PAST_UMD = 1_700_000_000;

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;
let auditDir: string;

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

/**
 * A fake applescript vector applying project.delete/restore by SQL — the
 * simulator vector covers todo.delete/restore but not the project variants, so
 * the project promote/undo legs (project.delete + rollback restore) need this.
 */
function projectTrashVector(): WriteVector {
  return {
    id: "applescript",
    matrix: {
      "project.delete": { support: "yes", disruption: 0, validation: "validated" },
      "project.restore": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(inv) {
      const id = /id "([^"]+)"/.exec(inv.payload)?.[1] ?? "";
      const trashed = inv.payload.includes("delete") ? 1 : 0;
      fixture.db.prepare("UPDATE TMTask SET trashed = ? WHERE uuid = ?").run(trashed, id);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

/**
 * An AppleScript vector simulating the `--preserve-modified` restore leg: a
 * `set modification date` write returns the target row's umd to {@link PAST_UMD}
 * (CI has no real app; the value is what a real restore floors to). Its matrix is
 * empty so runMutation never selects it — restoreModDates finds it by id.
 */
function umdRestoreVector(): WriteVector {
  return {
    id: "applescript",
    matrix: {},
    async execute(inv) {
      const m = /set modification date of (?:to do|project) id "([^"]+)"/.exec(inv.payload);
      if (m?.[1] !== undefined) {
        fixture.db
          .prepare("UPDATE TMTask SET userModificationDate = ? WHERE uuid = ?")
          .run(PAST_UMD, m[1]);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function deps(vectors: WriteVector | WriteVector[]): WriteDeps {
  return {
    db: fixture.db,
    vectors: Array.isArray(vectors) ? vectors : [vectors],
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-promote-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    auditDirPath: auditDir,
  };
}

const GUI = { dangerouslyDriveGui: true } as const;
const row = (uuid: string): Record<string, unknown> | undefined =>
  fixture.db.prepare("SELECT * FROM TMTask WHERE uuid = ?").get(uuid) as
    | Record<string, unknown>
    | undefined;

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
  process.env["THINGS_API_STATE_DIR"] = mkdtempSync(join(tmpdir(), "promote-state-"));
  process.env["THINGS_API_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "promote-config-"));
  auditDir = mkdtempSync(join(tmpdir(), "promote-audit-"));
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

/** Persist the in-memory audit records to the JSONL file runUndo reads. */
function flushAudit(): void {
  writeFileSync(
    join(auditDir, "2026-07.jsonl"),
    auditRecords.map((r) => JSON.stringify(r)).join("\n"),
  );
}

describe("todo.make-repeating — promote-via-clone", () => {
  it("clones X, promotes the clone, trashes X; result carries the template + trashed original", async () => {
    const src = seedTodo(fixture.db, { title: "Water plants", start: "active" });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok with template uuid");

    // The original survives in the Trash (recoverable).
    expect(row(src)?.["trashed"]).toBe(1);
    // The result carries the minted template + a repeating block.
    expect(res.repeating?.templateUuid).toBe(res.uuid);
    expect(res.repeating?.instanceUuid).toBeDefined();
    expect(res.undoToken).toBeDefined();
    // The trashed original is named in a warning.
    expect((res.warnings ?? []).join(" ")).toContain(src);

    // A single make-repeating SUMMARY record captures template + instance + original.
    const summary = auditRecords.find(
      (r) => r.op === "todo.make-repeating" && r.txn?.role === "summary",
    );
    expect(summary?.observed).toMatchObject({
      templateUuid: res.uuid,
      originalUuid: src,
    });
    // The clone is an EMBEDDED leg, never an independent todo.clone summary.
    expect(auditRecords.some((r) => r.op === "todo.clone" && r.txn?.role === "summary")).toBe(
      false,
    );
    expect(auditRecords.some((r) => r.op === "todo.clone" && r.txn?.role === "leg")).toBe(true);
  });

  it("undo trashes the template + instance (trash-both) and restores the original", async () => {
    const src = seedTodo(fixture.db, { title: "Standup", start: "active" });
    const made = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "daily", interval: 1 },
      GUI,
    );
    if (made.kind !== "ok" || made.uuid === null || made.undoToken === undefined) {
      throw new Error("expected ok with token");
    }
    const templateUuid = made.uuid;
    const instanceUuid = made.repeating?.instanceUuid ?? null;
    const token = made.undoToken;
    flushAudit();

    const items = await runUndo(deps(vector), auditDir, { txn: token });
    expect(items[0]?.outcome).toBe("ok");
    // Trash-both landed; the original is revived.
    expect(row(templateUuid)?.["trashed"]).toBe(1);
    if (instanceUuid !== null && instanceUuid !== templateUuid) {
      expect(row(instanceUuid)?.["trashed"]).toBe(1);
    }
    expect(row(src)?.["trashed"]).toBe(0);
    expect(items[0]?.plan.notes.join(" ")).toContain("Put Back");
  });

  it("--preserve-modified: keeps X's umd off the timeline forward and records preModDates on the summary", async () => {
    const src = seedTodo(fixture.db, {
      title: "Silent standup",
      start: "active",
      modificationDate: PAST_UMD,
    });
    const res = await runMakeRepeatingTodo(
      deps([vector, umdRestoreVector()]),
      { uuid: src, frequency: "weekly", interval: 1 },
      { ...GUI, preserveModified: true },
    );
    if (res.kind !== "ok") throw new Error("expected ok");
    // X is in the Trash but its umd was NOT bumped by the trash leg (restored).
    expect(row(src)?.["trashed"]).toBe(1);
    expect(row(src)?.["userModificationDate"]).toBe(PAST_UMD);
    // The summary record captures X's pre-write umd so the undo restore can fire.
    const summary = auditRecords.find(
      (r) => r.op === "todo.make-repeating" && r.txn?.role === "summary",
    );
    expect(summary?.preModDates).toEqual({ [src]: PAST_UMD });
  });

  it("--preserve-modified: undo restores X AND puts its umd back (symmetric timeline silence)", async () => {
    const src = seedTodo(fixture.db, {
      title: "Silent daily",
      start: "active",
      modificationDate: PAST_UMD,
    });
    const made = await runMakeRepeatingTodo(
      deps([vector, umdRestoreVector()]),
      { uuid: src, frequency: "daily", interval: 1 },
      { ...GUI, preserveModified: true },
    );
    if (made.kind !== "ok" || made.undoToken === undefined) throw new Error("expected ok + token");
    flushAudit();

    const items = await runUndo(deps([vector, umdRestoreVector()]), auditDir, {
      txn: made.undoToken,
    });
    expect(items[0]?.outcome).toBe("ok");
    // X is revived AND its umd is back at the pre-write value (undo stayed silent).
    expect(row(src)?.["trashed"]).toBe(0);
    expect(row(src)?.["userModificationDate"]).toBe(PAST_UMD);
  });

  it("blocks (no clone minted) when the GUI-drive ack is missing", async () => {
    const src = seedTodo(fixture.db, { title: "T", start: "active" });
    const res = await runMakeRepeatingTodo(deps(vector), {
      uuid: src,
      frequency: "weekly",
      interval: 1,
    });
    expect(res).toMatchObject({ kind: "blocked", hazard: "H-UI-DRIVE" });
    // Nothing was cloned or trashed.
    expect(row(src)?.["trashed"]).toBe(0);
    expect(auditRecords.some((r) => r.op === "todo.clone")).toBe(false);
  });

  it("dry-run previews clone → promote → trash without touching anything", async () => {
    const src = seedTodo(fixture.db, { title: "T", start: "active" });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 1 },
      { dryRun: true },
    );
    expect(res.kind).toBe("dry-run");
    if (res.kind === "dry-run") {
      expect(res.plan.invocation).toContain("clone");
      expect(res.plan.invocation).toContain("trash the original");
    }
    expect(row(src)?.["trashed"]).toBe(0);
  });
});

describe("project.make-repeating — promote-via-clone", () => {
  it("clones the project, promotes the clone, trashes the original", async () => {
    const area = seedArea(fixture.db, "Ops");
    const proj = seedProject(fixture.db, { title: "Weekly review", area, start: "active" });
    const res = await runMakeRepeatingProject(
      deps([vector, projectTrashVector()]),
      { uuid: proj, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(row(proj)?.["trashed"]).toBe(1); // original recoverable
    expect(res.repeating?.templateUuid).toBe(res.uuid);
  });

  it("refuses a project holding a nested repeating template (H-CLONE-SOURCE at the promote surface)", async () => {
    const proj = seedProject(fixture.db, { title: "Has repeater", start: "active" });
    seedTodo(fixture.db, { title: "daily thing", project: proj, recurrenceRule: true });
    const res = await runMakeRepeatingProject(
      deps(vector),
      { uuid: proj, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res).toMatchObject({ kind: "blocked", op: "project.make-repeating" });
    if (res.kind === "blocked") {
      expect(res.hazard).toBe("H-CLONE-SOURCE");
      expect(res.detail).toContain("nested repeating template");
    }
    expect(row(proj)?.["trashed"]).toBe(0); // untouched
  });
});

describe("add-repeating — add → native promote", () => {
  it("todo.add-repeating: creates the to-do then promotes it (no trash leg)", async () => {
    const res = await runAddRepeatingTodo(
      deps(vector),
      { title: "New habit", when: "someday", frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(res.op).toBe("todo.add-repeating");
    expect(res.repeating?.templateUuid).toBe(res.uuid);
    const summary = auditRecords.find(
      (r) => r.op === "todo.add-repeating" && r.txn?.role === "summary",
    );
    expect(summary?.observed).not.toHaveProperty("originalUuid");
  });

  it("project.add-repeating: full add vocabulary threads through (area kept)", async () => {
    const area = seedArea(fixture.db, "Finance");
    const res = await runAddRepeatingProject(
      deps(vector),
      {
        title: "Monthly finances",
        area: { uuid: area },
        notes: "reconcile",
        frequency: "monthly",
        interval: 1,
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(res.op).toBe("project.add-repeating");
    expect(row(res.uuid)?.["area"]).toBe(area);
  });

  it("threads the base --reminder onto the SERIES via the promote (ADR1 #480, behavior #3)", async () => {
    // The Repeat-dialog conversion does not preserve the seed's one-off reminder,
    // so add-repeating must drive the dialog reminder with the base time — the
    // promote leg's rule params must carry it (else the template drops it).
    let promoteReminder: unknown = "UNSEEN";
    const sim = createSimulatorVector(fixture.path, { now: () => NOW });
    const capturing: WriteVector = {
      ...sim,
      async execute(inv) {
        if (inv.op === "todo.make-repeating") {
          promoteReminder = (inv.opParams as { reminder?: unknown } | undefined)?.reminder;
        }
        return sim.execute(inv);
      },
    };
    const res = await runAddRepeatingTodo(
      deps(capturing),
      {
        title: "Reminded habit",
        when: "2026-08-26",
        reminder: "18:00",
        frequency: "weekly",
        interval: 1,
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    expect(promoteReminder).toBe("18:00");
  });

  it("blocks before creating when the GUI-drive ack is missing", async () => {
    const res = await runAddRepeatingTodo(deps(vector), {
      title: "x",
      frequency: "weekly",
      interval: 1,
    });
    expect(res).toMatchObject({ kind: "blocked", hazard: "H-UI-DRIVE" });
    expect(auditRecords.some((r) => r.op === "todo.add")).toBe(false);
  });

  it("--preserve-modified is a clean no-op (no pre-existing rows; summary carries no preModDates)", async () => {
    const res = await runAddRepeatingTodo(
      deps([vector, umdRestoreVector()]),
      { title: "Fresh habit", when: "someday", frequency: "weekly", interval: 1 },
      { ...GUI, preserveModified: true },
    );
    expect(res.kind).toBe("ok");
    const summary = auditRecords.find(
      (r) => r.op === "todo.add-repeating" && r.txn?.role === "summary",
    );
    expect(summary).toBeDefined();
    expect(summary?.preModDates).toBeUndefined();
  });
});

// DBLSPAWN1 (docs/lab/dblspawn1-preserved-instance.md, golden-v3 / Things 3.22.14):
// a seed carrying a CONCRETE item-level deadline is SRCFATE-preserved on promote as a
// FUTURE-dated instance, double-booking the template cursor (icCount=0, next == the
// occurrence) — and the app spawns a DUPLICATE when the date arrives (cell C). The fix:
// (add-repeating) map a concrete --deadline to the RULE's deadline so the seed stays
// deadline-free (no preserve); (make-repeating) trash the redundant preserved FUTURE
// instance post-promote.
describe("DBLSPAWN1 — deadlined add-repeating maps to the rule (no preserved double-book)", () => {
  const instancesOf = (templateUuid: string): number =>
    (
      fixture.db
        .prepare("SELECT count(*) AS n FROM TMTask WHERE rt1_repeatingTemplate = ? AND trashed = 0")
        .get(templateUuid) as { n: number }
    ).n;

  it("add-repeating: a concrete --deadline lands as the RULE deadline (start-offset), no orphaned instance", async () => {
    const res = await runAddRepeatingTodo(
      deps(vector),
      {
        title: "Annual filing",
        when: "2026-07-15",
        deadline: "2026-07-29", // 14 days after the start
        frequency: "yearly",
        interval: 1,
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    // The RULE owns the deadline: template deadline sentinel set + start-offset −14.
    expect(row(res.uuid)?.["deadline"]).not.toBeNull();
    const rule = decodeRecurrenceRule(row(res.uuid)?.["rt1_recurrenceRule"] as Uint8Array);
    expect(rule?.startOffsetDays).toBe(-14);
    // The seed was NOT preserved (it carried no deadline) — a future first occurrence
    // holds NO materialized instance, so nothing double-books the cursor.
    expect(res.repeating?.instanceUuid).toBeNull();
    expect(instancesOf(res.uuid)).toBe(0);
    // The template records the START (the --when), not the deadline (icCount=0, future).
    expect(row(res.uuid)?.["rt1_instanceCreationCount"]).toBe(0);
    expect(decodePackedDate(row(res.uuid)?.["rt1_instanceCreationStartDate"] as number)).toBe(
      "2026-07-15",
    );
  });

  it("add-repeating: --start-days-earlier alone maps to the RULE deadline (no concrete --deadline)", async () => {
    const res = await runAddRepeatingTodo(
      deps(vector),
      {
        title: "Lead-only",
        when: "2026-07-15",
        startDaysEarlier: 14, // deadline derived as 2026-07-29
        frequency: "yearly",
        interval: 1,
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    // Same landed rule as the concrete-date form: deadline sentinel + start-offset −14.
    expect(row(res.uuid)?.["deadline"]).not.toBeNull();
    const rule = decodeRecurrenceRule(row(res.uuid)?.["rt1_recurrenceRule"] as Uint8Array);
    expect(rule?.startOffsetDays).toBe(-14);
    // Seed carries no deadline → no future double-book (icCount 0, start == --when).
    expect(res.repeating?.instanceUuid).toBeNull();
    expect(instancesOf(res.uuid)).toBe(0);
  });

  it("add-repeating: --deadline AND --start-days-earlier that AGREE proceed (harmless redundancy)", async () => {
    const res = await runAddRepeatingTodo(
      deps(vector),
      {
        title: "Agreeing offset",
        when: "2026-07-15",
        deadline: "2026-07-29", // 14 days after the start …
        startDaysEarlier: 14, // … and the offset says the same
        frequency: "yearly",
        interval: 1,
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    const rule = decodeRecurrenceRule(row(res.uuid)?.["rt1_recurrenceRule"] as Uint8Array);
    expect(rule?.startOffsetDays).toBe(-14);
  });

  it("add-repeating: --deadline AND --start-days-earlier that DISAGREE are refused (zero mutation)", async () => {
    await expect(
      runAddRepeatingTodo(
        deps(vector),
        {
          title: "Conflicting offset",
          when: "2026-07-15",
          deadline: "2026-07-29", // implies a 14-day lead …
          startDaysEarlier: 10, // … but the offset says 10 — inexpressible
          frequency: "yearly",
          interval: 1,
        },
        GUI,
      ),
    ).rejects.toThrow(/these disagree/);
    // The refusal names both corrected spellings (make them agree).
    await expect(
      runAddRepeatingTodo(
        deps(vector),
        {
          title: "Conflicting offset",
          when: "2026-07-15",
          deadline: "2026-07-29",
          startDaysEarlier: 10,
          frequency: "yearly",
          interval: 1,
        },
        GUI,
      ),
    ).rejects.toThrow(/--start-days-earlier 14, or --deadline 2026-07-25/);
  });

  it("add-repeating: --start-days-earlier with a keyword --when is refused (needs a concrete date)", async () => {
    await expect(
      runAddRepeatingTodo(
        deps(vector),
        {
          title: "Undated offset",
          when: "someday",
          startDaysEarlier: 7,
          frequency: "weekly",
          interval: 1,
        },
        GUI,
      ),
    ).rejects.toThrow(/concrete --when/);
  });

  it("add-repeating: --start-days-earlier with --after-completion is refused (no calendar start)", async () => {
    await expect(
      runAddRepeatingTodo(
        deps(vector),
        {
          title: "After-completion offset",
          when: "2026-07-15",
          startDaysEarlier: 7,
          afterCompletion: true,
          frequency: "weekly",
          interval: 1,
        },
        GUI,
      ),
    ).rejects.toThrow(/after-completion/);
  });

  it("add-repeating: --deadline before --when is refused (behavioral)", async () => {
    await expect(
      runAddRepeatingTodo(
        deps(vector),
        {
          title: "Impossible",
          when: "2026-07-15",
          deadline: "2026-07-01",
          frequency: "weekly",
          interval: 1,
        },
        GUI,
      ),
    ).rejects.toThrow(/on or after/);
  });

  it("add-repeating: --deadline with a keyword --when is refused (needs a concrete date)", async () => {
    await expect(
      runAddRepeatingTodo(
        deps(vector),
        {
          title: "Undated",
          when: "someday",
          deadline: "2026-07-15",
          frequency: "weekly",
          interval: 1,
        },
        GUI,
      ),
    ).rejects.toThrow(/concrete --when/);
  });

  it("make-repeating: a FUTURE-scheduled deadlined source's redundant preserved instance is trashed + disclosed", async () => {
    const src = seedTodo(fixture.db, {
      title: "Future deadlined",
      start: "active",
      startDate: "2026-07-20", // future (NOW = 2026-07-05)
      deadline: "2026-08-03",
    });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    // The preserved FUTURE instance was trashed (it would spawn a duplicate on the date).
    expect(res.repeating?.instanceUuid).toBeNull();
    expect(instancesOf(res.uuid)).toBe(0);
    expect((res.warnings ?? []).join(" ")).toMatch(/future/i);
    expect((res.warnings ?? []).join(" ")).toMatch(/Trash/);
  });

  it("make-repeating: a TODAY-scheduled deadlined source's preserved instance is KEPT (legitimate current occurrence)", async () => {
    const src = seedTodo(fixture.db, {
      title: "Today deadlined",
      start: "active",
      startDate: "2026-07-05", // today (NOW)
      deadline: "2026-07-19",
    });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    // The current-occurrence instance is legitimate — kept, no duplicate-factory warning.
    expect(res.repeating?.instanceUuid).not.toBeNull();
    expect(instancesOf(res.uuid)).toBe(1);
    expect((res.warnings ?? []).join(" ")).not.toMatch(/duplicate/i);
  });
});

// #508: the post-drive first-occurrence verify used ONE oracle — the template's
// `rt1_instanceCreationStartDate` cursor. An AFTER-COMPLETION template is minted with
// that cursor EMPTY (no next occurrence exists until a completion happens), so a
// perfectly correct after-completion creation reported verify-failed:mismatch (exit 3;
// 6/6 on the live host). The oracle is now picked by rule kind: fixed → the template
// cursor, after-completion → the materialized instance's own startDate.
describe("#508 — the after-completion first-occurrence verify uses the instance oracle", () => {
  const instancesOf = (templateUuid: string): number =>
    (
      fixture.db
        .prepare("SELECT count(*) AS n FROM TMTask WHERE rt1_repeatingTemplate = ? AND trashed = 0")
        .get(templateUuid) as { n: number }
    ).n;

  it("add-repeating: --after-completion with a FUTURE --when succeeds (was a false mismatch)", async () => {
    const res = await runAddRepeatingTodo(
      deps(vector),
      {
        title: "Rotate the filters",
        when: "2026-07-20", // future (NOW = 2026-07-05)
        afterCompletion: true,
        frequency: "weekly",
        interval: 2,
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    // The oracle the OLD verify used is empty on an after-completion template —
    // exactly why it produced a false mismatch.
    expect(row(res.uuid)?.["rt1_instanceCreationStartDate"]).toBeNull();
    // The requested date landed on the materialized instance (the new oracle).
    const instanceUuid = res.repeating?.instanceUuid;
    expect(instanceUuid).not.toBeNull();
    expect(decodePackedDate(row(instanceUuid as string)?.["startDate"] as number)).toBe(
      "2026-07-20",
    );
    // The DBLSPAWN1 backstop must NOT trash it: an after-completion series has no
    // cursor to double-book, so its preserved instance is the only occurrence.
    expect(instancesOf(res.uuid)).toBe(1);
    expect(row(instanceUuid as string)?.["trashed"]).toBe(0);
  });

  it("add-repeating: --after-completion with a TODAY --when succeeds", async () => {
    const res = await runAddRepeatingTodo(
      deps(vector),
      {
        title: "Refill the water jug",
        when: "2026-07-05", // today
        afterCompletion: true,
        frequency: "daily",
        interval: 1,
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(instancesOf(res.uuid)).toBe(1);
  });

  it("make-repeating: --after-completion on a FUTURE-scheduled source succeeds", async () => {
    const src = seedTodo(fixture.db, {
      title: "Descale the kettle",
      start: "active",
      startDate: "2026-07-20", // future
    });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "monthly", interval: 1, afterCompletion: true },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    // The promoted CLONE was preserved in place as the sole instance, still on the
    // source's own date; the original went to the Trash as usual.
    const instanceUuid = res.repeating?.instanceUuid;
    expect(instanceUuid).not.toBeNull();
    expect(decodePackedDate(row(instanceUuid as string)?.["startDate"] as number)).toBe(
      "2026-07-20",
    );
    expect(row(src)?.["trashed"]).toBe(1);
  });

  it("a FIXED series whose Next drive did NOT take still fails closed", async () => {
    // The simulator honors the driven Next faithfully, so bend the landed cursor
    // after the promote — the shape of a "Next:" field that did not commit.
    const sim = createSimulatorVector(fixture.path, { now: () => NOW });
    const driftVector: WriteVector = {
      ...sim,
      async execute(inv) {
        const out = await sim.execute(inv);
        if (inv.op === "todo.make-repeating") {
          fixture.db
            .prepare(
              "UPDATE TMTask SET rt1_instanceCreationStartDate = ? " +
                "WHERE rt1_recurrenceRule IS NOT NULL AND rt1_instanceCreationStartDate IS NOT NULL",
            )
            .run(encodePackedDate("2026-07-06"));
        }
        return out;
      },
    };
    const res = await runAddRepeatingTodo(
      deps(driftVector),
      { title: "Drifted", when: "2026-07-20", frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("verify-failed");
    if (res.kind !== "verify-failed") throw new Error("expected verify-failed");
    expect(res.detail).toContain("2026-07-06");
    expect(res.detail).toContain("2026-07-20");
  });
});

// ADR1 (issue #480): the add legs are NOT atomic — the seed persists if the
// promote no-ops. RATIFIED RULING: auto-trash our OWN seed inside the txn and
// disclose it; if the auto-trash also fails, surface the seed's REAL resolvable
// uuid with a working `delete` remediation (the #480 second bug — a residue whose
// reported uuid was not actionable).
describe("add-repeating — seed auto-trash on promote failure (#480)", () => {
  /**
   * A simulator that applies add/delete normally but makes the promote leg a
   * clean-transport NO-OP → the create-mode verify finds no template → the
   * pipeline returns verify-failed:silent-noop (the exact #480 shape). With
   * `deleteFails`, the auto-trash leg reports a transport failure too.
   */
  function promoteFailsVector(opts: { deleteFails?: boolean } = {}): WriteVector {
    const sim = createSimulatorVector(fixture.path, { now: () => NOW });
    return {
      ...sim,
      async execute(inv) {
        if (inv.op === "todo.make-repeating" || inv.op === "project.make-repeating") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          opts.deleteFails === true &&
          (inv.op === "todo.delete" || inv.op === "project.delete")
        ) {
          return { exitCode: 1, stdout: "", stderr: "delete failed (injected)" };
        }
        return sim.execute(inv);
      },
    };
  }

  const seedRow = (title: string): { uuid: string; trashed: number } | undefined =>
    fixture.db
      .prepare("SELECT uuid, trashed FROM TMTask WHERE title = ? ORDER BY trashed DESC LIMIT 1")
      .get(title) as { uuid: string; trashed: number } | undefined;

  it("auto-trashes the seed and points at `restore` when the promote fails", async () => {
    const res = await runAddRepeatingTodo(
      deps(promoteFailsVector()),
      { title: "Doomed habit", when: "someday", frequency: "weekly", interval: 1 },
      { ...GUI, verifyTimeoutMs: 300 },
    );
    expect(res.kind).toBe("verify-failed");
    expect(res.op).toBe("todo.add-repeating");
    const seed = seedRow("Doomed habit");
    expect(seed?.trashed).toBe(1); // created then auto-trashed inside the txn
    if (res.kind !== "verify-failed") throw new Error("expected verify-failed");
    expect(res.detail).toContain(seed?.uuid ?? "MISSING");
    expect(res.detail).toContain("moved to the Trash");
    expect(res.detail).toContain("things todo restore");
    // The auto-trash ran as an embedded leg.
    expect(auditRecords.some((r) => r.op === "todo.delete")).toBe(true);
  });

  it("names the seed's resolvable uuid + a `delete` remediation when the auto-trash ALSO fails", async () => {
    const res = await runAddRepeatingTodo(
      deps(promoteFailsVector({ deleteFails: true })),
      { title: "Stranded habit", when: "someday", frequency: "weekly", interval: 1 },
      { ...GUI, verifyTimeoutMs: 300 },
    );
    expect(res.kind).toBe("verify-failed");
    const seed = seedRow("Stranded habit");
    expect(seed?.trashed).toBe(0); // the auto-trash did not land
    if (res.kind !== "verify-failed") throw new Error("expected verify-failed");
    expect(res.detail).toContain("could NOT be auto-trashed");
    expect(res.detail).toContain(`things todo delete ${seed?.uuid ?? "MISSING"}`);
  });
});

// ============================================ ANCH2 first-occurrence Next drive (issue #476)
//
// The Repeat dialog's "Next:" field is drivable and honored (docs/lab/anch2-next-field.md,
// golden-v2/3.22.12). The promote verbs DRIVE it with the requested first occurrence —
// an explicit --when, else the item's scheduled date — so the series starts THERE
// (verbatim), then post-drive VERIFY the landed first occurrence fail-closed. The
// weekly weekday is still derived from that date so the recurring day is intended
// (not the app's Sunday default). NOW here is Sunday 2026-07-05.
describe("ANCH2 first-occurrence Next drive (issue #476)", () => {
  it("make-repeating drives the source date as the first occurrence (not the app default)", async () => {
    // Source scheduled Wed 2026-07-15; the app default would anchor weekly/2 to
    // Wed 07-08 — but the Next drive makes the series start on 07-15 verbatim.
    const src = seedTodo(fixture.db, {
      title: "Alt Wed",
      start: "active",
      startDate: "2026-07-15",
    });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 2, weekdays: ["wednesday"] },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    // First occurrence honored (cursor == requested), rule offsets = Wednesday.
    expect(decodePackedDate(row(res.uuid)?.["rt1_nextInstanceStartDate"] as number)).toBe(
      "2026-07-15",
    );
    expect(decodeRecurrenceRule(row(res.uuid)?.["rt1_recurrenceRule"] as Uint8Array)).toMatchObject(
      {
        unit: "weekly",
        offsets: [{ weekday: 3 }],
      },
    );
    // The original was moved to the Trash (clone → promote → trash), recoverable.
    expect(row(src)?.["trashed"]).toBe(1);
  });

  it("make-repeating derives the weekday from the source date when --weekdays is omitted", async () => {
    // Source on a Wednesday, weekly/1, no --weekdays: the app would default to
    // Sunday; the promote instead drives Wednesday (wd 3) derived from the date,
    // and Next = the source date.
    const src = seedTodo(fixture.db, {
      title: "Weekly Wed",
      start: "active",
      startDate: "2026-07-15",
    });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(decodeRecurrenceRule(row(res.uuid)?.["rt1_recurrenceRule"] as Uint8Array)).toMatchObject(
      {
        unit: "weekly",
        offsets: [{ weekday: 3 }],
      },
    );
    expect(decodePackedDate(row(res.uuid)?.["rt1_nextInstanceStartDate"] as number)).toBe(
      "2026-07-15",
    );
  });

  it("make-repeating: an explicit --when overrides the item's scheduled date", async () => {
    const src = seedTodo(fixture.db, {
      title: "Overridden",
      start: "active",
      startDate: "2026-07-15",
    });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 2, weekdays: ["wednesday"], next: "2026-07-22" },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(decodePackedDate(row(res.uuid)?.["rt1_nextInstanceStartDate"] as number)).toBe(
      "2026-07-22",
    );
  });

  it("make-repeating: an unscheduled source leaves Next at the app default (no drive)", async () => {
    const src = seedTodo(fixture.db, { title: "Someday habit", start: "someday" });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 2, weekdays: ["wednesday"] },
      GUI,
    );
    expect(res.kind).toBe("ok");
  });

  it("add-repeating drives --when as the first occurrence", async () => {
    const res = await runAddRepeatingTodo(
      deps(vector),
      {
        title: "Alt Wed",
        when: "2026-07-15",
        frequency: "weekly",
        interval: 2,
        weekdays: ["wednesday"],
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(decodePackedDate(row(res.uuid)?.["rt1_nextInstanceStartDate"] as number)).toBe(
      "2026-07-15",
    );
  });

  it("--reminder is accepted (ANCH2: the repeat reminder picker is drivable)", async () => {
    const src = seedTodo(fixture.db, {
      title: "Remind me",
      start: "active",
      startDate: "2026-07-08",
    });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 1, reminder: "18:00" },
      GUI,
    );
    expect(res.kind).toBe("ok");
  });
});

// ============================================ template-direct clone (re-promote)
//
// Cloning a repeating TEMPLATE = clone its content as a PLAIN item, then
// native-promote the clone with the SOURCE's decoded rule (ruling 2026-08-13(d)).
// Result = the add-repeating contract; undo = trash-both; refuse an inexpressible
// or undecodable rule. The clone/promote legs ride the simulator vector.

/** A real, decodable `rt1_recurrenceRule` blob for the given rule vocabulary. */
function templateRuleXml(rule: Omit<RepeatRuleParams, "uuid">): string {
  return ruleXml(composeRepeatRuleSpec({ uuid: "seed", ...rule }, "2026-07-05", 0));
}

/** Seed a repeating TEMPLATE to-do carrying `rule` (born someday, one pending occurrence). */
function seedTemplateTodo(rule: Omit<RepeatRuleParams, "uuid">, title = "Recurring chore"): string {
  return seedTodo(fixture.db, {
    title,
    start: "someday",
    recurrenceRuleXml: templateRuleXml(rule),
    nextInstanceStartDate: "2026-07-12",
  });
}

function summaryOf(op: string): AuditRecord | undefined {
  return auditRecords.find((r) => r.op === op && r.txn?.role === "summary");
}

describe("template-direct clone via re-promote — todo", () => {
  it("clones a daily template's content + rule as a NEW series (add-repeating contract)", async () => {
    const src = seedTemplateTodo({ frequency: "daily", interval: 1 });
    const res = await runCloneTodo(deps(vector), { uuid: src }, GUI);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok with template uuid");

    // Recorded as an add-repeating (the compound's product is a fresh series).
    expect(res.op).toBe("todo.add-repeating");
    expect(res.repeating?.templateUuid).toBe(res.uuid);
    expect(res.repeating?.instanceUuid).toBeDefined();
    expect(res.undoToken).toBeDefined();
    // The new-series-identity disclosure is present.
    expect((res.warnings ?? []).join(" ")).toContain("NEW repeating series");
    // The SOURCE template is untouched (we cloned it, not moved it).
    expect(row(src)?.["trashed"]).toBe(0);

    // The summary maps the decoded rule onto the promote vocabulary (no original).
    const summary = summaryOf("todo.add-repeating");
    expect(summary?.observed).not.toHaveProperty("originalUuid");
    expect(summary?.requested).toMatchObject({ frequency: "daily", interval: 1 });
    // The clone is an EMBEDDED leg, never an independent todo.clone summary.
    expect(auditRecords.some((r) => r.op === "todo.clone" && r.txn?.role === "summary")).toBe(
      false,
    );
    expect(auditRecords.some((r) => r.op === "todo.clone" && r.txn?.role === "leg")).toBe(true);
  });

  it("maps a weekly-with-weekdays rule onto the promote vocabulary", async () => {
    const src = seedTemplateTodo({
      frequency: "weekly",
      interval: 1,
      weekdays: ["monday", "wednesday", "friday"],
    });
    const res = await runCloneTodo(deps(vector), { uuid: src }, GUI);
    expect(res.kind).toBe("ok");
    expect(summaryOf("todo.add-repeating")?.requested).toMatchObject({
      frequency: "weekly",
      interval: 1,
      weekdays: ["monday", "wednesday", "friday"],
    });
  });

  it("maps a monthly nth-weekday (ordinal) anchor", async () => {
    const src = seedTemplateTodo({
      frequency: "monthly",
      interval: 1,
      monthly: { weekday: "tuesday", ordinal: 2 },
    });
    const res = await runCloneTodo(deps(vector), { uuid: src }, GUI);
    expect(res.kind).toBe("ok");
    expect(summaryOf("todo.add-repeating")?.requested).toMatchObject({
      frequency: "monthly",
      monthly: { weekday: "tuesday", ordinal: 2 },
    });
  });

  it("maps an after-completion rule (minted template decodes back to after-completion)", async () => {
    const src = seedTemplateTodo({ frequency: "weekly", interval: 2, afterCompletion: true });
    const res = await runCloneTodo(deps(vector), { uuid: src }, GUI);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(summaryOf("todo.add-repeating")?.requested).toMatchObject({
      frequency: "weekly",
      interval: 2,
      afterCompletion: true,
    });
    // Round-trip: the minted template's rule decodes to an after-completion rule.
    const minted = row(res.uuid)?.["rt1_recurrenceRule"];
    const decoded = decodeRecurrenceRule(minted);
    expect(decoded.type).toBe("after-completion");
    expect(decoded.unit).toBe("weekly");
    expect(decoded.interval).toBe(2);
  });

  it("refuses an INEXPRESSIBLE rule (two end bounds), naming the feature; nothing minted", async () => {
    // A rule with BOTH an end date AND an occurrence count — the Repeat dialog's
    // Ends is single-choice, so ruleToInverseParams returns null.
    const bothBoundsXml = ruleXml({
      tp: 0,
      fu: 16,
      fa: 1,
      ed: Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000),
      rc: 5,
      anchor: 0,
    });
    const src = seedTodo(fixture.db, {
      title: "Two-bound daily",
      start: "someday",
      recurrenceRuleXml: bothBoundsXml,
    });
    const res = await runCloneTodo(deps(vector), { uuid: src }, GUI);
    expect(res).toMatchObject({
      kind: "blocked",
      op: "todo.add-repeating",
      hazard: "H-CLONE-SOURCE",
    });
    if (res.kind === "blocked") {
      expect(res.detail).toContain("date");
      expect(res.detail).toContain("occurrence count");
    }
    // No series was minted (the refusal fired before any create).
    expect(auditRecords.some((r) => r.op === "todo.clone")).toBe(false);
  });

  it("refuses an UNDECODABLE rule (unrecognized format) fail-closed", async () => {
    const src = seedTodo(fixture.db, { title: "Opaque", recurrenceRule: true });
    const res = await runCloneTodo(deps(vector), { uuid: src }, GUI);
    expect(res).toMatchObject({ kind: "blocked", hazard: "H-CLONE-SOURCE" });
    if (res.kind === "blocked") expect(res.detail).toContain("could not be decoded");
  });

  it("blocks (nothing minted) when the GUI-drive ack is missing", async () => {
    const src = seedTemplateTodo({ frequency: "daily", interval: 1 });
    const res = await runCloneTodo(deps(vector), { uuid: src });
    expect(res).toMatchObject({ kind: "blocked", op: "todo.add-repeating", hazard: "H-UI-DRIVE" });
    expect(auditRecords.some((r) => r.op === "todo.clone")).toBe(false);
  });

  it("discloses that a PAUSED source is cloned UNPAUSED", async () => {
    const src = seedTodo(fixture.db, {
      title: "Paused chore",
      start: "someday",
      recurrenceRuleXml: templateRuleXml({ frequency: "weekly", interval: 1 }),
      instanceCreationPaused: true,
    });
    const res = await runCloneTodo(deps(vector), { uuid: src }, GUI);
    expect(res.kind).toBe("ok");
    const warns = (res.kind === "ok" ? (res.warnings ?? []) : []).join(" ");
    expect(warns).toContain("PAUSED");
    expect(warns).toContain("UNPAUSED");
  });

  it("undo trashes the new series (trash-both) and leaves the SOURCE template untouched", async () => {
    const src = seedTemplateTodo({ frequency: "daily", interval: 1 });
    const made = await runCloneTodo(deps(vector), { uuid: src }, GUI);
    if (made.kind !== "ok" || made.uuid === null || made.undoToken === undefined) {
      throw new Error("expected ok with token");
    }
    const templateUuid = made.uuid;
    const instanceUuid = made.repeating?.instanceUuid ?? null;
    flushAudit();

    const items = await runUndo(deps(vector), auditDir, { txn: made.undoToken });
    expect(items[0]?.outcome).toBe("ok");
    expect(row(templateUuid)?.["trashed"]).toBe(1);
    if (instanceUuid !== null && instanceUuid !== templateUuid) {
      expect(row(instanceUuid)?.["trashed"]).toBe(1);
    }
    // No original was trashed by the forward op, so undo restores nothing — the
    // source template stays exactly where it was.
    expect(row(src)?.["trashed"]).toBe(0);
  });

  it("dry-run previews clone → make-repeating without minting anything", async () => {
    const src = seedTemplateTodo({ frequency: "daily", interval: 1 });
    const res = await runCloneTodo(deps(vector), { uuid: src }, { dryRun: true });
    expect(res.kind).toBe("dry-run");
    if (res.kind === "dry-run") {
      expect(res.plan.invocation).toContain("clone the template");
      expect(res.plan.invocation).toContain("make-repeating");
    }
    expect(auditRecords.some((r) => r.op === "todo.clone")).toBe(false);
  });
});

describe("template-direct clone via re-promote — project", () => {
  it("clones a project template's content + rule as a NEW series (area kept)", async () => {
    const area = seedArea(fixture.db, "Ops");
    const src = seedProject(fixture.db, {
      title: "Weekly review",
      area,
      start: "someday",
      recurrenceRuleXml: templateRuleXml({ frequency: "weekly", interval: 1 }),
    });
    const res = await runCloneProject(deps([vector, projectTrashVector()]), { uuid: src }, GUI);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(res.op).toBe("project.add-repeating");
    expect(res.repeating?.templateUuid).toBe(res.uuid);
    expect(row(res.uuid)?.["area"]).toBe(area);
    expect(row(src)?.["trashed"]).toBe(0); // source template untouched
  });

  it("refuses a template project holding a nested repeating template (nested-repeater UNCHANGED)", async () => {
    const src = seedProject(fixture.db, {
      title: "Repeater host",
      start: "someday",
      recurrenceRuleXml: templateRuleXml({ frequency: "weekly", interval: 1 }),
    });
    seedTodo(fixture.db, { title: "nested daily", project: src, recurrenceRule: true });
    const res = await runCloneProject(deps(vector), { uuid: src }, GUI);
    expect(res).toMatchObject({ kind: "blocked", op: "project.add-repeating" });
    if (res.kind === "blocked") {
      expect(res.hazard).toBe("H-CLONE-SOURCE");
      expect(res.detail).toContain("nested repeating template");
    }
    expect(row(src)?.["trashed"]).toBe(0);
  });
});

// SESSGATE (#480): a promote composite is not atomic — it seeds a row before the
// GUI promote leg. A locked/full-screen session must refuse BEFORE the seed, so
// no orphan row is ever created.
/** A fake ui vector that reports the session AX-blind (locked) via probeReachability. */
function lockedUiVector(): WriteVector {
  return {
    id: "ui",
    matrix: {},
    async execute() {
      throw new Error("execute must never run — the gate blocks before the seed");
    },
    probeReachability: async () => ({
      reachable: false,
      scope: "session",
      detail: "the Mac's screen is locked",
      remediation: "unlock the Mac and run this again",
    }),
  };
}

describe("promote composites — pre-seed session-reachability gate (SESSGATE #480)", () => {
  /** deps with ui ENABLED so the gate consults the ui vector's probeReachability. */
  function depsUi(vectors: WriteVector[]): WriteDeps {
    return { ...deps(vectors), config: { ...CONFIG, ui: { enabled: true } } };
  }
  const titleRows = (title: string): number =>
    (
      fixture.db.prepare("SELECT COUNT(*) AS n FROM TMTask WHERE title = ?").get(title) as {
        n: number;
      }
    ).n;

  it("add-repeating REFUSES on a locked session and seeds NOTHING (zero mutation)", async () => {
    const res = await runAddRepeatingTodo(
      depsUi([vector, lockedUiVector()]),
      { title: "SESSGATE doomed seed", frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("blocked");
    if (res.kind === "blocked") {
      expect(res.hazard).toBe("H-UI-SESSION-UNREACHABLE");
      expect(res.op).toBe("todo.add-repeating");
    }
    // The decisive guarantee: the seed to-do was never created.
    expect(titleRows("SESSGATE doomed seed")).toBe(0);
  });

  it("make-repeating REFUSES on a locked session and never clones/trashes the original", async () => {
    const src = seedTodo(fixture.db, { title: "SESSGATE original", start: "active" });
    const res = await runMakeRepeatingTodo(
      depsUi([vector, lockedUiVector()]),
      { uuid: src, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("blocked");
    if (res.kind === "blocked") expect(res.hazard).toBe("H-UI-SESSION-UNREACHABLE");
    // The original is untouched (not trashed) and no clone row was minted.
    expect(row(src)?.["trashed"]).toBe(0);
    expect(titleRows("SESSGATE original")).toBe(1);
  });

  it("proceeds past the gate when the ui vector reports the session reachable", async () => {
    const reachableUi: WriteVector = {
      id: "ui",
      matrix: {},
      // The promote leg is delivered by the simulator (vector: "ui" is remapped in
      // the sim fence); this fake only answers the reachability probe.
      async execute() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      probeReachability: async () => ({ reachable: true }),
    };
    const res = await runAddRepeatingTodo(
      depsUi([vector, reachableUi]),
      { title: "SESSGATE reachable", frequency: "weekly", interval: 1 },
      GUI,
    );
    // The gate did NOT block — the compound ran (the simulator applies the legs).
    expect(res.kind).not.toBe("blocked");
    expect(titleRows("SESSGATE reachable")).toBeGreaterThan(0);
  });
});
