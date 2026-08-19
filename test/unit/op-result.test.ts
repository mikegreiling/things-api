/**
 * op-result — the read-only caller-recovery lookup over the local change history
 * (RSPA1 deliverable 3). Fixtures are real JSONL records written through the
 * production audit writer, so the reader is exercised end-to-end over on-disk
 * shape. Covers: found-ok, found-error (verify-failed / blocked), intent-only
 * (with + without a correlated trace), unknown op-id, and the intent→final
 * supersede + newest-final-wins rules.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuditWriter } from "../../src/audit/log.ts";
import type { AuditRecord } from "../../src/audit/schema.ts";
import { opResult } from "../../src/op-result.ts";

let auditDir: string;
let traceDir: string;

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), "things-api-opres-audit-"));
  traceDir = mkdtempSync(join(tmpdir(), "things-api-opres-trace-"));
});
afterEach(() => {
  rmSync(auditDir, { recursive: true, force: true });
  rmSync(traceDir, { recursive: true, force: true });
});

/** A minimal valid record with caller-controllable fields. */
function makeRecord(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    v: 1,
    ts: "2026-08-19T12:00:00.000Z",
    actor: "cli",
    host: "test-host",
    op: "todo.reschedule-repeat",
    uuid: "tmpl-1",
    vector: "ui",
    disruption: 3,
    invocation: null,
    requested: {},
    pre: null,
    observed: null,
    result: "ok",
    verify: null,
    durationMs: 5,
    env: { pkg: "0.0.0", dbVersion: 26, fingerprint: "ok" },
    ...over,
  };
}

/** Append records through the production writer (one file per month). */
function seed(records: AuditRecord[]): void {
  const writer = createAuditWriter({ dir: auditDir, secrets: [], enabled: true });
  for (const r of records) writer.append(r);
}

describe("opResult — found (final record present)", () => {
  it("found-ok: reports ok with the target + observation", () => {
    seed([
      makeRecord({ opId: "job-1", result: "intent", observed: null }),
      makeRecord({ opId: "job-1", result: "ok", observed: { nextOccurrence: "2028-10-16" } }),
    ]);
    const r = opResult("job-1", { auditDir, traceDir });
    expect(r.status).toBe("found");
    expect(r.result).toBe("ok");
    expect(r.op).toBe("todo.reschedule-repeat");
    expect(r.uuid).toBe("tmpl-1");
    expect(r.observed).toEqual({ nextOccurrence: "2028-10-16" });
    expect(r.note).toContain("verification passed");
    expect(r.tracePath).toBeNull();
  });

  it("found-error: a verify-failed:timeout reports the timeout with re-read guidance", () => {
    seed([
      makeRecord({ opId: "job-2", result: "intent" }),
      makeRecord({
        opId: "job-2",
        result: "verify-failed:timeout",
        observed: { nextOccurrence: "2029-10-02" },
        verify: { attempts: 40, elapsedMs: 120000 },
      }),
    ]);
    const r = opResult("job-2", { auditDir, traceDir });
    expect(r.status).toBe("found");
    expect(r.result).toBe("verify-failed:timeout");
    expect(r.verify).toEqual({ attempts: 40, elapsedMs: 120000 });
    expect(r.note).toContain("TIMED OUT");
    expect(r.note).toContain("NEVER blind-retry");
    expect(r.note).toContain("tmpl-1"); // names the target in the show hint
  });

  it("found-error: a blocked record reports the refusal (nothing changed)", () => {
    seed([makeRecord({ opId: "job-3", result: "blocked:H-UI-DRIVE", uuid: null })]);
    const r = opResult("job-3", { auditDir, traceDir });
    expect(r.status).toBe("found");
    expect(r.result).toBe("blocked:H-UI-DRIVE");
    expect(r.note).toContain("REFUSED before touching the app");
    expect(r.note).toContain("nothing changed");
  });

  it("newest final wins when an op-id was re-dispatched (verify-failed then ok)", () => {
    seed([
      makeRecord({
        opId: "job-4",
        ts: "2026-08-19T12:00:00.000Z",
        result: "verify-failed:timeout",
      }),
      makeRecord({ opId: "job-4", ts: "2026-08-19T12:05:00.000Z", result: "ok" }),
    ]);
    const r = opResult("job-4", { auditDir, traceDir });
    expect(r.status).toBe("found");
    expect(r.result).toBe("ok");
  });
});

describe("opResult — intent-only (process died / still running)", () => {
  it("reports intent-only and surfaces a correlated trace when present", () => {
    const ts = "2026-08-19T12:00:00.000Z";
    seed([makeRecord({ opId: "job-5", result: "intent" })]);
    // A trace file whose mtime is near the intent ts (write it, then stamp mtime).
    const tracePath = join(traceDir, "2026-08-19T12-00-00-000Z-1234.jsonl");
    writeFileSync(tracePath, '{"phase":"invocation"}\n');
    const near = new Date(ts).getTime();
    // Stamp both atime + mtime to the intent instant so the mtime-proximity
    // correlation matches (well within the 5-min window).
    utimesSync(tracePath, near / 1000, near / 1000);
    const r = opResult("job-5", { auditDir, traceDir });
    expect(r.status).toBe("intent-only");
    expect(r.result).toBeNull();
    expect(r.op).toBe("todo.reschedule-repeat");
    expect(r.tracePath).toBe(tracePath);
    expect(r.note).toContain("UNCERTAIN");
    expect(r.note).toContain(tracePath);
  });

  it("intent-only with no correlated trace leaves tracePath null", () => {
    seed([makeRecord({ opId: "job-6", result: "intent" })]);
    const r = opResult("job-6", { auditDir, traceDir });
    expect(r.status).toBe("intent-only");
    expect(r.tracePath).toBeNull();
    expect(r.note).toContain("mid-flight");
  });
});

describe("opResult — unknown op-id", () => {
  it("reports unknown for an id absent from the history", () => {
    seed([makeRecord({ opId: "job-7", result: "ok" })]);
    const r = opResult("nope", { auditDir, traceDir });
    expect(r.status).toBe("unknown");
    expect(r.op).toBeNull();
    expect(r.result).toBeNull();
    expect(r.note).toContain("no change-history record");
  });

  it("reports unknown when the audit dir does not exist", () => {
    const r = opResult("job-8", { auditDir: join(auditDir, "missing"), traceDir });
    expect(r.status).toBe("unknown");
  });
});
