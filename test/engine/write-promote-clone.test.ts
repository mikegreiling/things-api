/**
 * promote-via-clone orchestrators (make/add-repeating): drive the FULL compound
 * end-to-end against a synthetic fixture DB with the simulator write vector
 * applying each leg (clone → native promote → trash). Asserts (a) the ok result +
 * repeating block + undoToken, (b) the original is recoverable in the Trash, (c)
 * the summary audit record captures template/instance/original, (d) the clone is
 * an EMBEDDED leg (not an independent todo.clone summary), (e) the undo trash-both
 * + restore round-trip, (f) the refusal + gating copy. No Things app is touched.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { UiCapability } from "../../src/capability.ts";
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
import { expectedRuleAssertions } from "../../src/write/repeat-asserts.ts";
import { type WriteDeps } from "../../src/write/pipeline.ts";
import { runUndo } from "../../src/write/undo.ts";
import { createSimulatorVector } from "../../src/write/vectors/simulator.ts";
import type { WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";
import { makeTempDir } from "../fixtures/temp-dir.ts";

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
  experimentalAreaReorder: true,
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
  process.env["THINGS_API_STATE_DIR"] = makeTempDir("promote-state");
  process.env["THINGS_API_CONFIG_DIR"] = makeTempDir("promote-config");
  auditDir = makeTempDir("promote-audit");
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
    expect((res.notes ?? []).join(" ")).toContain(src);

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

  it("project.add-repeating: a concrete --when drives the first occurrence (ANCH2)", async () => {
    // The project promote leg re-keyed the rule bag field by field and left `next`
    // out, so the dialog's first-occurrence field was never driven for a project:
    // the series anchored to the app's today-based default and the post-drive
    // verify then failed the caller's own correct request.
    const res = await runAddRepeatingProject(
      deps(vector),
      { title: "Dated series", when: "2026-07-20", frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    expect(decodePackedDate(row(res.uuid)?.["rt1_instanceCreationStartDate"] as number)).toBe(
      "2026-07-20",
    );
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

  // NEXTPOP1: the deadline shift is applied EXACTLY ONCE, in the promote leg's
  // compile. It used to be applied upstream as well, so `next` reached the leg
  // already holding the DUE date and everything downstream that shifts —
  // `assessOffRuleFirst`, through `assertRepeatRule` — shifted it a second time.
  // On a MONTHLY rule that lands off the derived anchor, so the composite was
  // refused before it ran, quoting a date the caller never asked for.
  it("add-repeating: a deadlined MONTHLY rule is NOT refused as off-anchor (the double-shift)", async () => {
    const res = await runAddRepeatingTodo(
      deps(vector),
      {
        title: "Monthly deadlined",
        when: "2026-07-15",
        deadline: "2026-07-29", // anchor = day 29, start = the 15th
        frequency: "monthly",
        interval: 1,
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    const rule = decodeRecurrenceRule(row(res.uuid)?.["rt1_recurrenceRule"] as Uint8Array);
    expect(rule?.startOffsetDays).toBe(-14);
    // The series STARTS on --when; the anchor (the 29th) is the due date.
    expect(decodePackedDate(row(res.uuid)?.["rt1_instanceCreationStartDate"] as number)).toBe(
      "2026-07-15",
    );
  });

  it("make-repeating: the same deadlined MONTHLY shape lands through the direct verb", async () => {
    const src = seedTodo(fixture.db, {
      title: "Monthly deadlined source",
      start: "active",
      startDate: "2026-07-15",
    });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      {
        uuid: src,
        frequency: "monthly",
        interval: 1,
        // `next` is the requested first-occurrence START — what `--when` maps to
        // on this verb — and it stays a START all the way to the compile.
        next: "2026-07-15",
        deadline: true,
        startDaysEarlier: 14,
      } satisfies RepeatRuleParams,
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    const templateUuid = res.repeating?.templateUuid;
    expect(templateUuid).toBeTruthy();
    const rule = decodeRecurrenceRule(
      row(templateUuid as string)?.["rt1_recurrenceRule"] as Uint8Array,
    );
    expect(rule?.startOffsetDays).toBe(-14);
    expect(
      decodePackedDate(row(templateUuid as string)?.["rt1_instanceCreationStartDate"] as number),
    ).toBe("2026-07-15");
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

  // CNCAC2 (docs/lab/cncac2-deadline-lift.md): the deadline geometry no longer
  // diverts by RULE KIND. An after-completion series is deadlined the same way a
  // fixed one is — the offset is measured from each occurrence's own start, which
  // such a series has — and the app's Repeat dialog has always offered it
  // (CNCAC1 §9.1). The two shapes below used to be, respectively, a hard refusal
  // and a silent mis-wire (the deadline stayed on the SEED, so one occurrence was
  // deadlined and the series was not).
  // The offsets below are 5 rather than 7 for a MEASURED reason (DEFAULTS2
  // §clamp): an after-completion series' offset is capped at (its period in days
  // − 1), so `every 1 week` accepts at most 6 — and the app applies that cap
  // SILENTLY, replacing a larger value with no refusal. An offset of 7 here was
  // certifying a request the app could never have honored; it is now refused
  // before dispatch, and the cells keep their subject (the mapping does not
  // divert by rule kind) at an offset the dialog can actually hold.
  it("add-repeating: --start-days-earlier with --after-completion maps to the RULE (CNCAC2)", async () => {
    const res = await runAddRepeatingTodo(
      deps(vector),
      {
        title: "After-completion offset",
        when: "2026-07-15",
        startDaysEarlier: 5,
        afterCompletion: true,
        frequency: "weekly",
        interval: 1,
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    // The RULE owns the deadline on an after-completion series too: the template's
    // 4001 sentinel plus ts = −5 (in-lab: `tp=1 … ts=-3` + `tmplDeadline=4001-01-01`).
    expect(row(res.uuid)?.["deadline"]).not.toBeNull();
    const rule = decodeRecurrenceRule(row(res.uuid)?.["rt1_recurrenceRule"] as Uint8Array);
    expect(rule?.type).toBe("after-completion");
    expect(rule?.startOffsetDays).toBe(-5);
  });

  it("add-repeating: --deadline with --after-completion maps to the RULE, not the seed (CNCAC2)", async () => {
    const res = await runAddRepeatingTodo(
      deps(vector),
      {
        title: "After-completion deadline",
        when: "2026-07-15",
        deadline: "2026-07-20", // 5 days after the start
        afterCompletion: true,
        frequency: "weekly",
        interval: 1,
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    const rule = decodeRecurrenceRule(row(res.uuid)?.["rt1_recurrenceRule"] as Uint8Array);
    expect(rule?.type).toBe("after-completion");
    // Both spellings land the SAME rule — in-lab, byte-identical rule blobs.
    expect(rule?.startOffsetDays).toBe(-5);
    expect(row(res.uuid)?.["deadline"]).not.toBeNull();
    // The landed-rule echo states the deadline on an after-completion series.
    expect((res.notes ?? []).join(" ")).toMatch(
      /after each occurrence is completed, with a deadline/,
    );
  });

  // DEFAULTS2 §clamp: the cap itself, refused before anything is created.
  it("add-repeating: an after-completion offset at or above the period REFUSES (DEFAULTS2)", async () => {
    await expect(
      runAddRepeatingTodo(
        deps(vector),
        {
          title: "After-completion over the cap",
          when: "2026-07-15",
          startDaysEarlier: 7,
          afterCompletion: true,
          frequency: "weekly",
          interval: 1,
        },
        GUI,
      ),
    ).rejects.toThrow(/caps the offset at 6/);
    // …and a longer interval makes the same offset legal, because the cap is the
    // PERIOD and not a constant.
    const ok = await runAddRepeatingTodo(
      deps(vector),
      {
        title: "After-completion inside a longer period",
        when: "2026-07-15",
        startDaysEarlier: 7,
        afterCompletion: true,
        frequency: "weekly",
        interval: 2,
      },
      GUI,
    );
    expect(ok.kind).toBe("ok");
  });

  // The expectedDelta the promote leg verifies against — the SAME assertion set
  // the idempotency precheck rides. An after-completion deadlined rule must
  // assert its type, its deadline flag and its start offset, or a drive that
  // silently dropped the offset would still read as satisfied (#491).
  it("expectedRuleAssertions: an after-completion deadlined rule asserts type + deadline + offset", () => {
    const asserts = expectedRuleAssertions(
      {
        frequency: "weekly",
        interval: 1,
        afterCompletion: true,
        deadline: true,
        startDaysEarlier: 3,
      },
      { includeCursor: false },
    );
    expect(asserts).toContainEqual({ field: "repeating.rule.type", equals: "after-completion" });
    expect(asserts).toContainEqual({ field: "repeating.deadlined", equals: true });
    expect(asserts).toContainEqual({ field: "repeating.rule.startOffsetDays", equals: -3 });
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

  // The PROJECT verb maps a concrete --deadline to the rule exactly as the to-do
  // verb does (DBLSPAWN1 residual). Its stakes are different — a project seed is
  // DELETE-fate, so an un-mapped deadline was DROPPED rather than double-booked —
  // but the fix and the geometry are the same.
  it("project add-repeating: a concrete --deadline lands as the RULE deadline (start-offset)", async () => {
    const res = await runAddRepeatingProject(
      deps(vector),
      {
        title: "Annual review",
        when: "2026-07-15",
        deadline: "2026-07-29", // 14 days after the start
        frequency: "yearly",
        interval: 1,
      },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok" || res.uuid === null) throw new Error("expected ok");
    // The RULE owns the deadline: template deadline sentinel + start-offset −14.
    expect(row(res.uuid)?.["deadline"]).not.toBeNull();
    const rule = decodeRecurrenceRule(row(res.uuid)?.["rt1_recurrenceRule"] as Uint8Array);
    expect(rule?.startOffsetDays).toBe(-14);
    // The template records the START (the --when), not the deadline.
    expect(decodePackedDate(row(res.uuid)?.["rt1_instanceCreationStartDate"] as number)).toBe(
      "2026-07-15",
    );
  });

  it("project add-repeating: --deadline with a keyword --when is refused (needs a concrete date)", async () => {
    await expect(
      runAddRepeatingProject(
        deps(vector),
        {
          title: "Undated project",
          when: "someday",
          deadline: "2026-07-15",
          frequency: "yearly",
          interval: 1,
        },
        GUI,
      ),
    ).rejects.toThrow(/concrete --when/);
  });

  it("project add-repeating: --deadline before --when is refused", async () => {
    await expect(
      runAddRepeatingProject(
        deps(vector),
        {
          title: "Impossible project",
          when: "2026-07-15",
          deadline: "2026-07-01",
          frequency: "monthly",
          interval: 1,
        },
        GUI,
      ),
    ).rejects.toThrow(/on or after/);
  });

  it("project add-repeating: --deadline with --after-completion is refused (it would vanish)", async () => {
    // RSIM-P P4: an after-completion project's seed is DELETED and its instance is
    // minted deadline-free, so the requested deadline has nowhere to live.
    await expect(
      runAddRepeatingProject(
        deps(vector),
        {
          title: "After-completion project",
          when: "2026-07-15",
          deadline: "2026-07-22",
          afterCompletion: true,
          frequency: "monthly",
          interval: 1,
        },
        GUI,
      ),
    ).rejects.toThrow(/after-completion/);
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
    expect((res.notes ?? []).join(" ")).toMatch(/future/i);
    expect((res.notes ?? []).join(" ")).toMatch(/Trash/);
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
    expect([...(res.warnings ?? []), ...(res.notes ?? [])].join(" ")).not.toMatch(/duplicate/i);
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

// COMPOSITE LOCK: a promote is one verb executed as several mutations, and the
// whole verb — not each leg — is what must serialize against other writers.
describe("promote composites hold ONE mutation lock across their legs", () => {
  /** The simulator, plus the lockfile's identity recorded at every leg. */
  function lockWatchingVector(lockPath: string, seen: (string | null)[]): WriteVector {
    const sim = createSimulatorVector(fixture.path, { now: () => NOW });
    return {
      ...sim,
      async execute(inv) {
        try {
          const st = statSync(lockPath);
          seen.push(`${st.dev}:${st.ino}`);
        } catch {
          seen.push(null); // no lock held during this leg
        }
        return sim.execute(inv);
      },
    };
  }

  it("every leg runs under the SAME lockfile, and it is gone afterwards", async () => {
    const seen: (string | null)[] = [];
    const d = deps(vector);
    const watched = deps(lockWatchingVector(d.lockPath, seen));
    watched.lockPath = d.lockPath;

    const src = seedTodo(fixture.db, { title: "Locked promote", start: "active" });
    const res = await runMakeRepeatingTodo(
      watched,
      { uuid: src, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");

    // Several legs ran (clone, trash, promote) …
    expect(seen.length).toBeGreaterThan(2);
    // … every one of them under a lockfile, and the SAME one throughout: a
    // per-leg lock would mint a fresh inode for each leg, leaving a gap between
    // them for another writer's legs to land in.
    expect(seen.filter((s) => s === null)).toEqual([]);
    expect(new Set(seen).size).toBe(1);
    // The composite's own release is the last thing to happen.
    expect(existsSync(d.lockPath)).toBe(false);
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
    expect((res.notes ?? []).join(" ")).toContain("NEW repeating series");
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

// Issue #512: the pre-seed preflight has a SECOND half. A machine that cannot
// drive the Things window at all (Article IV standing — the helper pair holds
// Accessibility + Automation → System Events, and nothing else does) used to fail
// on the PROMOTE leg, i.e. after the seed already existed: the composite created
// the row, refused, and trashed its own artifact for a reason it could have read
// off a config file before touching anything. Same verdict, one leg earlier.
/** A ui vector that DECLARES it drives the GUI (the pipeline gate's own key). */
function guiDrivingVector(): WriteVector {
  return {
    id: "ui",
    matrix: {},
    async execute() {
      throw new Error("execute must never run — the preflight blocks before the seed");
    },
    drivesGui: true,
    probeReachability: async () => {
      throw new Error("the standing check must refuse before any window probe runs");
    },
  };
}

describe("promote composites — pre-seed GUI-standing preflight (#512)", () => {
  const HOST = { bundleId: null, name: "test-host" } as const;
  const NO_STANDING: UiCapability = {
    mode: "helpers-missing",
    detail:
      "GUI-driving is granted only to the helpers, and no helper is answering on this machine",
    remediation: ["run `things helpers setup --gui` to grant GUI-driving to the helpers"],
    host: HOST,
  };

  /** deps whose GUI standing is INJECTED — no test ever reads the host's TCC state. */
  function depsStanding(capability: UiCapability): WriteDeps {
    return {
      ...deps([vector, guiDrivingVector()]),
      config: { ...CONFIG, ui: { enabled: true } },
      uiCapability: () => capability,
    };
  }
  const rowsTitled = (title: string): number =>
    (
      fixture.db.prepare("SELECT COUNT(*) AS n FROM TMTask WHERE title = ?").get(title) as {
        n: number;
      }
    ).n;

  it("add-repeating REFUSES without GUI standing and seeds NOTHING", async () => {
    const res = await runAddRepeatingTodo(
      depsStanding(NO_STANDING),
      { title: "PREFLIGHT doomed seed", frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("blocked");
    if (res.kind !== "blocked") throw new Error("expected blocked");
    expect(res.reason).toBe("environment");
    expect(res.detail).toContain("no helper is answering");
    expect(res.detail).toContain("nothing was created");
    expect(res.remediation).toContain("things helpers setup --gui");
    // The decisive guarantee: the seed to-do was never created.
    expect(rowsTitled("PREFLIGHT doomed seed")).toBe(0);
  });

  it("project make-repeating REFUSES without GUI standing and never clones/trashes the original", async () => {
    const src = seedProject(fixture.db, { title: "PREFLIGHT original" });
    const res = await runMakeRepeatingProject(
      depsStanding(NO_STANDING),
      { uuid: src, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("blocked");
    expect(row(src)?.["trashed"]).toBe(0);
    expect(rowsTitled("PREFLIGHT original")).toBe(1);
  });

  it("proceeds past the preflight when the helpers hold the GUI tier", async () => {
    const granted: UiCapability = {
      mode: "helpers",
      detail: "the helpers hold Accessibility and app control for System Events",
      remediation: [],
      host: HOST,
    };
    const reachableUi: WriteVector = {
      id: "ui",
      matrix: {},
      // The promote leg is delivered by the simulator; this fake only answers the
      // standing/reachability preflight.
      async execute() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      drivesGui: true,
      probeReachability: async () => ({ reachable: true }),
    };
    const res = await runAddRepeatingTodo(
      {
        ...deps([vector, reachableUi]),
        config: { ...CONFIG, ui: { enabled: true } },
        uiCapability: () => granted,
      },
      { title: "PREFLIGHT granted", frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).not.toBe("blocked");
    expect(rowsTitled("PREFLIGHT granted")).toBeGreaterThan(0);
  });
});

// Issue #512, second half: no preflight can catch a session that degrades UNDER a
// running drive (the Mac locks, a full-screen app takes the Space, the window
// stops answering). When that happens mid-composite the fail-closed cleanup is
// unchanged — the seed is trashed and named — but the OUTCOME must read as an
// environment failure, not as the app accepting the command and changing nothing.
describe("add-repeating — a mid-drive unreachable window (#512)", () => {
  /** A simulator whose promote leg reports the ui vector's `uiUnreachable` outcome. */
  function promoteUnreachableVector(): WriteVector {
    const sim = createSimulatorVector(fixture.path, { now: () => NOW });
    return {
      ...sim,
      async execute(inv) {
        if (inv.op === "todo.make-repeating") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: 'ui drive stopped at "select the row" (the row-selection step timed out).',
            uiUnreachable: {
              step: "select the row",
              cause: "unreachable" as const,
              clear: "cleared-blind" as const,
              remediation: "unlock the Mac, then run the same command again",
            },
          };
        }
        return sim.execute(inv);
      },
    };
  }

  it("reports ui-unreachable (not silent-noop), trashes the seed, and names the retry path", async () => {
    const res = await runAddRepeatingTodo(
      deps(promoteUnreachableVector()),
      { title: "Unreachable habit", when: "someday", frequency: "weekly", interval: 1 },
      { ...GUI, verifyTimeoutMs: 300 },
    );
    expect(res.kind).toBe("verify-failed");
    if (res.kind !== "verify-failed") throw new Error("expected verify-failed");
    expect(res.reason).toBe("ui-unreachable");
    expect(res.op).toBe("todo.add-repeating");
    // The window, not the app's choice — plus the honest retry path.
    expect(res.detail).toContain("select the row");
    expect(res.detail).toContain("no Things window was reachable");
    expect(res.hint).toContain("unlock the Mac");
    // The fail-closed cleanup is unchanged: the seed is trashed and disclosed.
    const seed = fixture.db
      .prepare("SELECT uuid, trashed FROM TMTask WHERE title = ? LIMIT 1")
      .get("Unreachable habit") as { uuid: string; trashed: number } | undefined;
    expect(seed?.trashed).toBe(1);
    expect(res.detail).toContain(seed?.uuid ?? "MISSING");
    expect(res.detail).toContain("moved to the Trash");
    expect(res.detail).toContain("things todo restore");
  });
});

// ------------------------------------------- --op-id (one summary, one key)

/** How many live repeating templates the fixture holds. */
const templateCount = (): number =>
  (
    fixture.db
      .prepare(
        "SELECT COUNT(*) AS n FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL AND trashed = 0",
      )
      .get() as { n: number }
  ).n;

describe("the promote compounds take an --op-id — one summary record, one key", () => {
  it("todo.make-repeating records the key on its SUMMARY and on no leg", async () => {
    const src = seedTodo(fixture.db, { title: "Water plants", start: "active" });
    const res = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 1 },
      { ...GUI, opId: "promote-once" },
    );
    expect(res.kind).toBe("ok");

    const keyed = auditRecords.filter((r) => r.opId === "promote-once");
    // ONE RECORDED RESULT per key — preceded by the write-ahead intent that made
    // the key readable while the verb was in flight (#639). Both sit at the
    // SUMMARY layer, because that is where a composite's key lives.
    expect(keyed.map((r) => r.result)).toEqual(["intent", "ok"]);
    expect(keyed.every((r) => r.txn?.role === "summary")).toBe(true);
    expect(keyed[0]?.holder?.pid, "the intent names the process that owns it").toBe(process.pid);
    expect(keyed[1]?.op).toBe("todo.make-repeating");
    // Every leg belongs to the transaction and carries no key of its own.
    expect(
      auditRecords.filter((r) => r.txn?.role === "leg").every((r) => r.opId === undefined),
    ).toBe(true);
  });

  it("a resubmission replays the whole promote and makes no second series", async () => {
    const src = seedTodo(fixture.db, { title: "Water plants", start: "active" });
    const first = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 1 },
      { ...GUI, opId: "promote-once" },
    );
    if (first.kind !== "ok") throw new Error("expected the first promote to land");
    flushAudit();
    const recordsBefore = auditRecords.length;

    const second = await runMakeRepeatingTodo(
      deps(vector),
      { uuid: src, frequency: "weekly", interval: 1 },
      { ...GUI, opId: "promote-once" },
    );

    expect(second.kind === "ok" && second.alreadyApplied).toBe(true);
    if (second.kind !== "ok") throw new Error("unreachable");
    expect(second.uuid).toBe(first.uuid);
    // One summary = one undo unit, so the replay hands back the same token.
    expect(second.undoToken).toBe(first.undoToken);
    expect(auditRecords.length, "a replay records nothing").toBe(recordsBefore);
    expect(templateCount(), "exactly one series exists").toBe(1);
  });

  it("every promote verb honors the key — the flag is symmetric across all four", async () => {
    const area = seedArea(fixture.db, "Ops");
    await runMakeRepeatingProject(
      deps([vector, projectTrashVector()]),
      {
        uuid: seedProject(fixture.db, { title: "Quarterly review", area, start: "active" }),
        frequency: "monthly",
        interval: 1,
      },
      { ...GUI, opId: "p-make" },
    );
    await runAddRepeatingTodo(
      deps(vector),
      { title: "Daily stretch", when: "someday", frequency: "daily", interval: 1 },
      { ...GUI, opId: "t-add" },
    );
    await runAddRepeatingProject(
      deps(vector),
      { title: "Monthly close", frequency: "monthly", interval: 1 },
      { ...GUI, opId: "p-add" },
    );
    for (const op of ["project.make-repeating", "todo.add-repeating", "project.add-repeating"]) {
      // One RESULT per key (the write-ahead intent alongside it is not a result).
      const keyed = auditRecords.filter(
        (r) => r.op === op && r.opId !== undefined && r.result !== "intent",
      );
      expect(keyed, op).toHaveLength(1);
      expect(keyed[0]?.txn?.role, op).toBe("summary");
    }
  });

  it("without a key an add-repeating re-run makes a SECOND series — the hazard the key answers", async () => {
    for (let i = 0; i < 2; i++) {
      await runAddRepeatingTodo(
        deps(vector),
        { title: "Daily stretch", when: "someday", frequency: "daily", interval: 1 },
        GUI,
      );
      flushAudit();
    }
    expect(templateCount()).toBe(2);
  });
});

describe("a promote whose drive never confirmed is reconciled, not re-run", () => {
  /** A promote leg killed by the GUI watchdog: the honest UNCERTAIN outcome. */
  function watchdogVector(): WriteVector {
    const sim = createSimulatorVector(fixture.path, { now: () => NOW });
    return {
      ...sim,
      async execute(inv) {
        if (inv.op === "todo.make-repeating") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "budget blown",
            watchdog: {
              budgetMs: 90_000,
              elapsedMs: 91_000,
              lastStep: "confirm the Repeat dialog",
              clear: "dismissed" as const,
            },
          };
        }
        return sim.execute(inv);
      },
    };
  }

  const UNCONFIRMED = {
    title: "Unconfirmed habit",
    when: "someday",
    frequency: "daily",
    interval: 1,
  } as const;

  it("writes an AMBIGUOUS summary carrying the key and the presence check", async () => {
    const res = await runAddRepeatingTodo(deps(watchdogVector()), UNCONFIRMED, {
      ...GUI,
      verifyTimeoutMs: 100,
      opId: "maybe-made",
    });
    expect(res.kind).toBe("verify-failed");
    expect(res.kind === "verify-failed" && res.reason).toBe("timeout");

    const keyed = auditRecords.filter((r) => r.opId === "maybe-made");
    const summary = keyed[keyed.length - 1];
    expect(summary?.txn?.role).toBe("summary");
    expect(summary?.result).toBe("verify-failed:timeout");
    expect(summary?.expected).toMatchObject({
      mode: "create",
      probe: { title: "Unconfirmed habit", type: "to-do" },
      assert: [{ field: "repeating.isTemplate", equals: true }],
    });
    // The write-ahead intent carried the SAME oracle (#639), so a holder that
    // died mid-drive would leave a retry exactly as able to reconcile as this
    // timeout does.
    expect(keyed[0]?.result).toBe("intent");
    expect(keyed[0]?.expected).toMatchObject({
      mode: "create",
      probe: { title: "Unconfirmed habit", type: "to-do" },
    });
  });

  it("the series exists after all → the retry replays instead of making a second one", async () => {
    await runAddRepeatingTodo(deps(watchdogVector()), UNCONFIRMED, {
      ...GUI,
      verifyTimeoutMs: 100,
      opId: "maybe-made",
    });
    // The drive HAD landed, late: a template of that title now exists.
    const template = seedTodo(fixture.db, {
      title: "Unconfirmed habit",
      creationDate: Math.floor(NOW.getTime() / 1000) + 1,
      recurrenceRuleXml: templateRuleXml({ frequency: "daily", interval: 1 }),
    });
    flushAudit();

    const retry = await runAddRepeatingTodo(deps(vector), UNCONFIRMED, {
      ...GUI,
      opId: "maybe-made",
    });

    expect(retry.kind === "ok" && retry.alreadyApplied).toBe(true);
    expect(retry.kind === "ok" && retry.uuid, "the uuid comes from the re-read").toBe(template);
    expect(templateCount(), "no second series").toBe(1);
  });

  it("the series is absent → the retry runs the promote for real", async () => {
    await runAddRepeatingTodo(deps(watchdogVector()), UNCONFIRMED, {
      ...GUI,
      verifyTimeoutMs: 100,
      opId: "maybe-made",
    });
    expect(templateCount(), "the stalled attempt left no series").toBe(0);
    flushAudit();

    const retry = await runAddRepeatingTodo(deps(vector), UNCONFIRMED, {
      ...GUI,
      opId: "maybe-made",
    });

    expect(retry.kind).toBe("ok");
    expect(retry.kind === "ok" && retry.alreadyApplied).toBeUndefined();
    expect(templateCount()).toBe(1);
  });
});

// ============================================ the failed-promote rollback (#620)
//
// make-repeating is not atomic: it trashes the original and mints a disposable
// copy BEFORE the GUI promote runs. When the promote does not land, both are
// ours to clean up — and the field incident showed both halves failing in the
// worst way: the restored original came back in the Inbox with no schedule (the
// only scriptable restore does exactly that, E15), and the disposable copy
// survived in the user's lists.
describe("make-repeating — rollback after a failed promote (#620)", () => {
  /** The simulator, but the GUI promote leg is a clean no-op (nothing lands). */
  function promoteNoopVector(opts: { cleanupDeleteFails?: boolean } = {}): WriteVector {
    const sim = createSimulatorVector(fixture.path, { now: () => NOW });
    let deletes = 0;
    return {
      ...sim,
      async execute(inv) {
        if (inv.op === "todo.make-repeating") return { exitCode: 0, stdout: "", stderr: "" };
        if (inv.op === "todo.delete") {
          deletes += 1;
          // The FIRST delete is the compound's own trash-the-original leg; the
          // SECOND is the cleanup removing the disposable copy. Only the
          // cleanup is failed here — the shape of an app ignoring scripted
          // changes because a dialog is stranded in front of it.
          if (opts.cleanupDeleteFails === true && deletes > 1) {
            return { exitCode: 1, stdout: "", stderr: "delete failed (injected)" };
          }
        }
        return sim.execute(inv);
      },
    };
  }

  const rowOf = (uuid: string): Record<string, unknown> | undefined =>
    fixture.db.prepare("SELECT * FROM TMTask WHERE uuid = ?").get(uuid) as
      | Record<string, unknown>
      | undefined;

  const cloneOf = (title: string, srcUuid: string): Record<string, unknown> | undefined =>
    fixture.db.prepare("SELECT * FROM TMTask WHERE title = ? AND uuid != ?").get(title, srcUuid) as
      | Record<string, unknown>
      | undefined;

  it("restores the original AND puts back its area and schedule", async () => {
    const area = seedArea(fixture.db, "Home");
    const src = seedTodo(fixture.db, {
      title: "Rollback fixture A",
      start: "active",
      area,
      startDate: "2026-07-05",
    });
    const res = await runMakeRepeatingTodo(
      deps(promoteNoopVector()),
      { uuid: src, frequency: "daily", interval: 1, afterCompletion: true },
      { ...GUI, verifyTimeoutMs: 300 },
    );
    expect(res.kind).toBe("verify-failed");
    const restored = rowOf(src);
    expect(restored?.["trashed"]).toBe(0);
    // A scripted restore lands a to-do in the Inbox with no schedule; the
    // rollback puts both back.
    expect(restored?.["area"]).toBe(area);
    expect(restored?.["startDate"]).not.toBeNull();
    if (res.kind !== "verify-failed") throw new Error("expected verify-failed");
    expect(res.detail).toContain("restored from the Trash");
    expect(res.detail).toContain("restored");
  });

  it("moves the disposable copy to the Trash instead of leaving it in the user's lists", async () => {
    const src = seedTodo(fixture.db, { title: "Rollback fixture B", start: "active" });
    const res = await runMakeRepeatingTodo(
      deps(promoteNoopVector()),
      { uuid: src, frequency: "daily", interval: 1, afterCompletion: true },
      { ...GUI, verifyTimeoutMs: 300 },
    );
    expect(res.kind).toBe("verify-failed");
    const clone = cloneOf("Rollback fixture B", src);
    expect(clone).toBeDefined();
    expect(clone?.["trashed"]).toBe(1);
    if (res.kind !== "verify-failed") throw new Error("expected verify-failed");
    expect(res.detail).toContain("disposable copy");
    expect(res.detail).toContain("moved to the Trash");
  });

  it("names the copy's uuid, the exact command, and the open-dialog cause when the cleanup cannot land", async () => {
    const src = seedTodo(fixture.db, { title: "Rollback fixture C", start: "active" });
    const res = await runMakeRepeatingTodo(
      deps(promoteNoopVector({ cleanupDeleteFails: true })),
      { uuid: src, frequency: "daily", interval: 1, afterCompletion: true },
      { ...GUI, verifyTimeoutMs: 300 },
    );
    expect(res.kind).toBe("verify-failed");
    const clone = cloneOf("Rollback fixture C", src);
    expect(clone?.["trashed"]).toBe(0); // the cleanup delete was refused
    if (res.kind !== "verify-failed") throw new Error("expected verify-failed");
    expect(res.detail).toContain(`things todo delete ${String(clone?.["uuid"])}`);
    // The one cause worth naming: a dialog left open makes the app ignore
    // scripted changes app-wide — and holds Things Cloud sync with them.
    expect(res.detail).toContain("dismiss it first");
    expect(res.detail).toContain("Things Cloud");
  });
});

// ============================================ the pre-seed OPEN-DIALOG gate (#620)
//
// MODALX1 measured the gap: a composite's first leg rides the URL scheme, which
// an open dialog does not touch, so the disposable copy LANDS — and then every
// AppleScript leg after it fails with -1728, leaving that copy in the user's
// lists. The orchestrator asks before it seeds.
describe("make-repeating — the pre-seed open-dialog gate (#620)", () => {
  /** A ui vector whose only job here is to answer the census. */
  function uiVectorWithDialog(open: boolean): WriteVector {
    const sim = createSimulatorVector(fixture.path, { now: () => NOW });
    const { simulates: _simulates, ...rest } = sim;
    return {
      ...rest,
      id: "ui",
      drivesGui: true,
      probeUiState: async () => ({
        thingsRunning: true,
        thingsFrontmost: true,
        frontmostApp: "Things3",
        sheetOpen: open,
        sheetKind: open ? ("repeat" as const) : ("none" as const),
        sheetForm: open ? ("attached" as const) : ("none" as const),
        sheetDepth: open ? 1 : 0,
        sheetControls: open ? "cb:2 pu:1 bt:2 gp:1 tf:0" : null,
        focusOwner: { app: "Things3", role: "AXTextField", subrole: null },
        inspectable: true,
        stalledProbes: [],
        failedProbes: [],
      }),
    };
  }

  const GRANTED_UI: UiCapability = {
    mode: "helpers",
    detail: "the helpers hold GUI access",
    remediation: [],
    host: { bundleId: null, name: "test-host" },
  };
  /** deps whose GUI standing is INJECTED — no test ever reads the host's TCC state. */
  const gateDeps = (open: boolean): WriteDeps => ({
    ...deps([vector, uiVectorWithDialog(open)]),
    config: { ...CONFIG, ui: { enabled: true } },
    uiCapability: () => GRANTED_UI,
  });

  it("refuses with ZERO mutation — no copy is minted — when a dialog is standing", async () => {
    const src = seedTodo(fixture.db, { title: "Gate fixture", start: "active" });
    const before = fixture.db
      .prepare("SELECT count(*) AS n FROM TMTask WHERE title = 'Gate fixture'")
      .get() as { n: number };
    const res = await runMakeRepeatingTodo(
      gateDeps(true),
      { uuid: src, frequency: "daily", interval: 1, afterCompletion: true },
      { ...GUI, verifyTimeoutMs: 300 },
    );
    expect(res.kind).toBe("blocked");
    if (res.kind !== "blocked") throw new Error("expected blocked");
    expect(res.detail).toContain("a dialog is already open in Things");
    expect(res.detail).toContain("Things Cloud");
    expect(res.remediation).toContain("things rescue status");
    // The whole point: nothing was created and the original never moved.
    const after = fixture.db
      .prepare("SELECT count(*) AS n FROM TMTask WHERE title = 'Gate fixture'")
      .get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(row(src)?.["trashed"]).toBe(0);
  });

  it("proceeds when the census reports a clear screen", async () => {
    const src = seedTodo(fixture.db, { title: "Clear fixture", start: "active" });
    const res = await runMakeRepeatingTodo(
      gateDeps(false),
      { uuid: src, frequency: "daily", interval: 1, afterCompletion: true },
      { ...GUI, verifyTimeoutMs: 300 },
    );
    expect(res.kind).not.toBe("blocked");
  });
});
