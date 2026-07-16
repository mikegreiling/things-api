/**
 * clear-dated-reminder engine tests: the orchestrator's vector selection +
 * URL-bounce compound, and the undo path (precondition-refuse + targeted
 * restore). No `shortcuts run` / `open` ever fires — every vector is a fake
 * driven through the WriteDeps seam (CLAUDE.md safety rails).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { encodePackedDate, encodeReminderTime, localToday } from "../../src/model/dates.ts";
import { runClearReminder } from "../../src/write/clear-reminder.ts";
import { runUndo } from "../../src/write/undo.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import type {
  CompiledInvocation,
  VectorMatrix,
  WriteVector,
} from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);
const TODAY = localToday(NOW);

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

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let auditDir: string;
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
  auditDir = mkdtempSync(join(tmpdir(), "things-api-clear-audit-"));
});
afterEach(() => {
  fixture.close();
  rmSync(auditDir, { recursive: true, force: true });
});

const URL_MATRIX: VectorMatrix = {
  "todo.update": { support: "yes", disruption: 0, validation: "validated" },
};
const SHORTCUTS_MATRIX: VectorMatrix = {
  "todo.clear-dated-reminder": { support: "yes", disruption: 0, validation: "validated" },
};

function setSchedule(
  uuid: string,
  opts: { startDate?: string; reminder?: string | null; bucket?: number },
): void {
  const cols: string[] = ["start = 1", "userModificationDate = ?"];
  const binds: (number | null)[] = [NOW_EPOCH + 1];
  if (opts.startDate !== undefined) {
    cols.push("startDate = ?");
    binds.push(encodePackedDate(opts.startDate));
  }
  if (opts.bucket !== undefined) {
    cols.push("startBucket = ?");
    binds.push(opts.bucket);
  }
  if (opts.reminder !== undefined) {
    cols.push("reminderTime = ?");
    binds.push(opts.reminder === null ? null : encodeReminderTime(opts.reminder));
  }
  binds.push(uuid as unknown as number);
  fixture.db.prepare(`UPDATE TMTask SET ${cols.join(", ")} WHERE uuid = ?`).run(...binds);
}

/** A fake url-scheme vector; each execute() calls effect(payload, callIndex). */
function urlVector(effect: (payload: string, call: number) => void): {
  vector: WriteVector;
  calls: string[];
} {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "url-scheme",
    matrix: URL_MATRIX,
    async execute(invocation: CompiledInvocation) {
      effect(invocation.payload, calls.length);
      calls.push(invocation.payload);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

function shortcutsVector(effect: () => void): { vector: WriteVector; calls: CompiledInvocation[] } {
  const calls: CompiledInvocation[] = [];
  const vector: WriteVector = {
    id: "shortcuts",
    matrix: SHORTCUTS_MATRIX,
    async execute(invocation: CompiledInvocation) {
      calls.push(invocation);
      effect();
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

function deps(vectors: WriteVector[], present: string[]): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-clear-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    shortcutProxies: () => ({ present, missing: [], detail: "test" }),
    pkgVersion: "0.7.0",
  };
}

function writeAudit(records: AuditRecord[]): void {
  writeFileSync(join(auditDir, "2026-07.jsonl"), records.map((r) => JSON.stringify(r)).join("\n"));
}

function auditRecord(partial: Partial<AuditRecord>): AuditRecord {
  return {
    v: 1,
    ts: "2026-07-05T10:00:00.000Z",
    actor: "mike",
    host: "test-host",
    op: "todo.clear-dated-reminder",
    uuid: null,
    vector: "url-scheme",
    disruption: 0,
    invocation: "x",
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

describe("runClearReminder — vector selection + URL bounce", () => {
  it("falls back to the URL bounce for a NON-REPEATING dated item when proxies are absent", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "dated",
      startDate: "2026-07-20",
      reminder: "09:30",
    });
    // leg 1 (when=today) clears + moves to Today; leg 2 (when=2026-07-20) re-dates back.
    const { vector, calls } = urlVector((_payload, call) => {
      if (call === 0) setSchedule(uuid, { startDate: TODAY, reminder: null, bucket: 0 });
      else setSchedule(uuid, { startDate: "2026-07-20", bucket: 0 });
    });

    const result = await runClearReminder(deps([vector], []), { uuid });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.vector).toBe("url-scheme");
      expect(result.observed).toEqual({ reminder: null, startDate: "2026-07-20" });
    }
    expect(calls).toHaveLength(2);
    // Two legs (excluded from undo) + one summary (the single undoable unit).
    const legs = auditRecords.filter((r) => r.txn?.role === "leg" && r.result !== "intent");
    const summary = auditRecords.find((r) => r.txn?.role === "summary");
    expect(legs.map((r) => r.op)).toEqual(["todo.update", "todo.update"]);
    expect(summary?.op).toBe("todo.clear-dated-reminder");
    expect(summary?.result).toBe("ok");
    expect(summary?.pre).toEqual({ reminder: "09:30", startDate: "2026-07-20" });
    expect(summary?.observed).toEqual({ reminder: null, startDate: "2026-07-20" });
  });

  it("BLOCKS a REPEATING item with the setup remediation when proxies are absent (never bounces)", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "repeating",
      startDate: "2026-07-20",
      reminder: "09:30",
      recurrenceRule: true,
    });
    const { vector: url, calls: urlCalls } = urlVector(() => {
      throw new Error("the bounce must not run on a repeating item");
    });
    const { vector: sc, calls: scCalls } = shortcutsVector(() => {
      throw new Error("no proxy is installed");
    });

    const result = await runClearReminder(deps([url, sc], []), { uuid });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toBe("environment");
      expect(result.remediation).toContain("things setup shortcuts");
    }
    expect(urlCalls).toHaveLength(0);
    expect(scCalls).toHaveLength(0);
  });

  it("--vector url-scheme on a repeating item is refused (would crash Things)", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "repeating",
      startDate: "2026-07-20",
      reminder: "09:30",
      recurrenceRule: true,
    });
    const { vector, calls } = urlVector(() => {
      throw new Error("must not dispatch");
    });
    const result = await runClearReminder(deps([vector], []), { uuid }, { vector: "url-scheme" });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.hazard).toBe("H-REPEAT-SCHEDULE");
      expect(result.detail).toContain("CRASHES");
    }
    expect(calls).toHaveLength(0);
  });

  it("prefers the atomic Shortcuts path when the proxy is installed", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "dated",
      startDate: "2026-07-20",
      reminder: "09:30",
    });
    const { vector, calls } = shortcutsVector(() =>
      setSchedule(uuid, { startDate: "2026-07-20", reminder: null }),
    );
    const result = await runClearReminder(deps([vector], ["things-proxy-set-detail"]), { uuid });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.vector).toBe("shortcuts");
    expect(calls[0]?.shortcut).toBe("things-proxy-set-detail");
  });

  it("blocks a to-do with no reminder up front (no dispatch)", async () => {
    const uuid = seedTodo(fixture.db, { title: "no reminder", startDate: "2026-07-20" });
    const { vector, calls } = urlVector(() => {
      throw new Error("must not dispatch");
    });
    const result = await runClearReminder(deps([vector], []), { uuid });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-NO-REMINDER");
    expect(calls).toHaveLength(0);
  });
});

describe("runUndo — clear-dated-reminder inverse", () => {
  const clearAudit = (uuid: string, observedStart: string): AuditRecord =>
    auditRecord({
      op: "todo.clear-dated-reminder",
      uuid,
      pre: { reminder: "09:30", startDate: observedStart },
      observed: { reminder: null, startDate: observedStart },
    });

  it("re-attaches the reminder to the item's CURRENT date and verifies", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "cleared",
      startDate: "2026-07-20",
      reminder: null,
    });
    writeAudit([clearAudit(uuid, "2026-07-20")]);
    const { vector, calls } = urlVector(() =>
      setSchedule(uuid, { startDate: "2026-07-20", reminder: "09:30" }),
    );

    const items = await runUndo(deps([vector], []), auditDir);
    expect(items[0]?.outcome).toBe("ok");
    expect(calls[0]).toContain(`id=${uuid}`);
    expect(auditRecords.at(-1)?.op).toBe("todo.update");
    expect(auditRecords.at(-1)?.actor).toBe("undo:mike");
  });

  it("re-attaches to the NEW date when the item moved out of band (no over-restore)", async () => {
    // The audit says it was cleared from 2026-07-20; the item now sits on 08-01.
    const uuid = seedTodo(fixture.db, { title: "moved", startDate: "2026-08-01", reminder: null });
    writeAudit([clearAudit(uuid, "2026-07-20")]);
    const { vector, calls } = urlVector(() =>
      setSchedule(uuid, { startDate: "2026-08-01", reminder: "09:30" }),
    );

    const items = await runUndo(deps([vector], []), auditDir);
    expect(items[0]?.outcome).toBe("ok");
    // The inverse targets the NEW date, never snapping the item back to 07-20.
    expect(calls[0]).toContain("when=2026-08-01");
    expect(calls[0]).not.toContain("2026-07-20");
  });

  it("REFUSES (blocked) when a reminder was set out of band — the value is preserved", async () => {
    // Someone re-added a reminder after the clear: current reminder != observed null.
    const uuid = seedTodo(fixture.db, {
      title: "touched",
      startDate: "2026-07-20",
      reminder: "07:00",
    });
    writeAudit([clearAudit(uuid, "2026-07-20")]);
    const { vector, calls } = urlVector(() => {
      throw new Error("must not clobber the out-of-band reminder");
    });

    const items = await runUndo(deps([vector], []), auditDir);
    expect(items[0]?.outcome).toBe("failed");
    const blocked = items[0]?.results[0];
    expect(blocked?.kind).toBe("blocked");
    if (blocked?.kind === "blocked") {
      expect(blocked.reason).toBe("environment");
      expect(blocked.detail).toContain("reminder changed since the recorded mutation");
    }
    expect(calls).toHaveLength(0);
    // The out-of-band reminder is untouched.
    const row = fixture.db.prepare("SELECT reminderTime FROM TMTask WHERE uuid = ?").get(uuid) as {
      reminderTime: number | null;
    };
    expect(row.reminderTime).toBe(encodeReminderTime("07:00"));
  });
});
