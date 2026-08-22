/**
 * UI-drive WATCHDOG + uncertain-outcome mapping (TRACE1, #487). The osascript
 * seam is MOCKED (no System Events fires). Two layers:
 *   - the ui vector's drive returns a structured `watchdog` ExecuteResult once
 *     the overall budget is spent, having attempted the dialog clearance; and
 *   - the pipeline maps that to a verify-failed result flagged `uncertain` with
 *     the trace path and a "re-check with `things show <uuid>`" remediation.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import { pauseRepeatRecipe } from "../../src/write/vectors/ui-recipes.ts";
import { createUiVector, type UiCommand, type UiRunResult } from "../../src/write/vectors/ui.ts";
import type { CompiledInvocation, UiRecipe, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
});
afterEach(() => fixture.close());

function config(driveBudgetMs?: number): ThingsApiConfig {
  return {
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
    helpersEnabled: false,
    ui: { enabled: true, ...(driveBudgetMs !== undefined && { driveBudgetMs }) },
    host: "test-host",
  };
}

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
}

// A fake clock poller so the pipeline's recovery re-verify does not burn real
// wall-clock time (it advances the injected clock instead of sleeping).
function fastPoller(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function deps(vector: WriteVector, cfg: ThingsApiConfig): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: cfg,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-wd-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    poller: fastPoller(),
    now: () => NOW,
  };
}

function invocation(recipe: UiRecipe): CompiledInvocation {
  return { vector: "ui", kind: "ui-drive", payload: "test", redactedPayload: "test", recipe };
}

function mockRunner(
  answer: (c: UiCommand) => UiRunResult,
): (c: UiCommand, t: number) => Promise<UiRunResult> {
  return async (c) => answer(c);
}

const ok = (stdout = ""): UiRunResult => ({ ok: true, stdout, stderr: "" });

describe("ui drive watchdog", () => {
  it("returns a structured watchdog ExecuteResult (with cleanup) once the budget is spent", async () => {
    // A 1ms budget is spent before the first real step; the drive stops at the
    // step boundary, runs the dialog clearance, and reports the budget/step.
    const run = mockRunner((c) => (c.primitive === "resolve" ? ok("true") : ok()));
    const vector = createUiVector(config(1), run);
    const res = await vector.execute(invocation(pauseRepeatRecipe("TODO-1")));
    expect(res.timedOut).toBe(true);
    expect(res.watchdog).toBeDefined();
    expect(res.watchdog?.budgetMs).toBe(1);
    expect(typeof res.watchdog?.lastStep).toBe("string");
    expect(["dismissed", "cleared-blind", "may-remain"]).toContain(res.watchdog?.clear);
  });

  it("a generous budget never fires the watchdog (a fast mocked drive completes)", async () => {
    const run = mockRunner((c) => (c.primitive === "resolve" ? ok("true") : ok()));
    const vector = createUiVector(config(90_000), run);
    const res = await vector.execute(invocation(pauseRepeatRecipe("TODO-1")));
    expect(res.watchdog).toBeUndefined();
    expect(res.exitCode).toBe(0);
  });
});

describe("pipeline maps a watchdog timeout to an uncertain verify-failed", () => {
  // A vector that reports the watchdog outcome directly (id "ui"), so the test
  // pins the pipeline's shaping without depending on wall-clock timing.
  function watchdogVector(): WriteVector {
    const real = createUiVector(
      config(),
      mockRunner(() => ok()),
    );
    return {
      id: "ui",
      matrix: real.matrix,
      execute: async () => ({
        exitCode: 1,
        stdout: "watchdog stopped",
        stderr: "ui drive exceeded its 90s budget",
        timedOut: true,
        watchdog: {
          budgetMs: 90_000,
          elapsedMs: 96_000,
          lastStep: 'press "OK"',
          clear: "dismissed" as const,
          tracePath: "/state/trace/run.jsonl",
        },
      }),
    };
  }

  it("verify-failed timeout, uncertain, with the trace path and a re-check remediation", async () => {
    const uuid = seedTodo(fixture.db, { title: "R", recurrenceRule: true });
    const res = await runMutation(
      deps(watchdogVector(), config()),
      "todo.pause-repeat",
      { uuid },
      { dangerouslyDriveGui: true },
    );
    expect(res.kind).toBe("verify-failed");
    if (res.kind !== "verify-failed") return;
    expect(res.reason).toBe("timeout");
    expect(res.uncertain).toBe(true);
    expect(res.tracePath).toBe("/state/trace/run.jsonl");
    expect(res.detail).toContain("UNCERTAIN");
    expect(res.detail).toContain(`things show ${uuid}`);
    // The audit trail records the timeout verdict for the interrupted drive.
    expect(auditRecords.some((r) => String(r.result).includes("timeout"))).toBe(true);
  });
});
