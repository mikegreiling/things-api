/**
 * "The Things UI was unreachable" is its own outcome (issue #512). The osascript
 * seam is MOCKED (no System Events fires). Two layers:
 *   - the ui vector's drive tags a step failure with `uiUnreachable` when the
 *     window stopped answering — either the step's own osascript was killed by
 *     its deadline ("unresponsive"), or the cleanup's blindness probe found no
 *     reachable window ("unreachable", the session degraded mid-drive) — and
 *     leaves an ordinary step failure untagged; and
 *   - the pipeline maps that tag to `verify-failed:ui-unreachable` with the
 *     failing step named and a retry path, NEVER to `verify-failed:silent-noop`
 *     (which means the app WAS reachable and accepted-then-ignored the command).
 *
 * The recipe under test is the one #512 was filed against: the project promote,
 * whose `select-row` step selects the new project row through AXSelectedRows.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import { projectMakeRepeatingRecipe } from "../../src/write/vectors/ui-recipes.ts";
import { createUiVector, type UiCommand, type UiRunResult } from "../../src/write/vectors/ui.ts";
import type { CompiledInvocation, UiRecipe, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { censusStdout, healthyScreen, isCensusCommand } from "../fixtures/ui-state.ts";
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

function config(): ThingsApiConfig {
  return {
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
    ui: { enabled: true, driveBudgetMs: 90_000 },
    host: "test-host",
  };
}

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
}

/** Advance an injected clock instead of sleeping, so the recovery re-verify is instant. */
function fastPoller(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function deps(vector: WriteVector): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: config(),
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-unreach-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    poller: fastPoller(),
    now: () => NOW,
  };
}

function invocation(recipe: UiRecipe): CompiledInvocation {
  return { vector: "ui", kind: "ui-drive", payload: "test", redactedPayload: "test", recipe };
}

const ok = (stdout = ""): UiRunResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr: string): UiRunResult => ({ ok: false, stdout: "", stderr });
const killed = (): UiRunResult => ({ ok: false, stdout: "", stderr: "", timedOut: true });

const REACHABLE = "1 1 -1";
const AX_BLIND = "1 0 0";

const isProbe = (c: UiCommand): boolean => (c.script ?? "").includes("sessgate-reachability probe");
const isSheetProbe = (c: UiCommand): boolean => c.label === "sheet-open probe";

const RECIPE = (): UiRecipe =>
  projectMakeRepeatingRecipe("AREA-1", "PROJ-1", "Quarterly filing", "yearly", 1);

/**
 * A runner for the #512 drive: everything answers healthily up to the
 * `select-row` step, which fails the way `answerSelectRow` says. `blindAfterFail`
 * flips the reachability probe to the AX-blind signature once the row selection
 * has failed — the session degrading UNDER the drive, which is what the pre-seed
 * and in-drive gates cannot catch.
 */
function runnerFor(opts: {
  answerSelectRow: () => UiRunResult;
  blindAfterFail?: boolean;
}): (c: UiCommand, t: number) => Promise<UiRunResult> {
  let rowFailed = false;
  // No dialog is open in this recipe's failure: the row selection dies before
  // the sheet exists. The census (issue #620) says exactly that.
  const screen = healthyScreen({ kind: "none" });
  return async (c) => {
    if (isProbe(c)) return ok(rowFailed && opts.blindAfterFail === true ? AX_BLIND : REACHABLE);
    if (isCensusCommand(c)) return ok(censusStdout(screen));
    if (isSheetProbe(c)) return ok("false");
    if (c.primitive === "select-row") {
      rowFailed = true;
      return opts.answerSelectRow();
    }
    if (c.primitive === "resolve") return ok("true");
    return ok();
  };
}

describe("ui drive — a step that stops because the window is not answering (#512)", () => {
  it("tags a row-selection step killed by its deadline as unresponsive", async () => {
    const vector = createUiVector(config(), runnerFor({ answerSelectRow: killed }));
    const res = await vector.execute(invocation(RECIPE()));
    expect(res.exitCode).not.toBe(0);
    expect(res.uiUnreachable).toBeDefined();
    expect(res.uiUnreachable?.cause).toBe("unresponsive");
    expect(res.uiUnreachable?.step).toContain("select the project row");
    expect(res.uiUnreachable?.remediation).toContain("run the same command again");
    // The human-readable stderr still names the step and what was completed.
    expect(res.stderr).toContain("the row-selection step timed out");
  });

  it("tags a step whose cleanup had to run BLIND as unreachable (the session degraded mid-drive)", async () => {
    const vector = createUiVector(
      config(),
      runnerFor({ answerSelectRow: killed, blindAfterFail: true }),
    );
    const res = await vector.execute(invocation(RECIPE()));
    expect(res.uiUnreachable?.cause).toBe("unreachable");
    expect(res.uiUnreachable?.clear).toBe("cleared-blind");
    expect(res.uiUnreachable?.remediation).toContain("unlock the Mac");
  });

  it("leaves an ORDINARY step failure untagged — a reachable app that refused the step", async () => {
    // The row-selection script answered cleanly with a no-match verdict: the
    // window was reachable and the app had its say, so this is not #512's shape.
    const vector = createUiVector(config(), runnerFor({ answerSelectRow: () => ok("NOMATCH") }));
    const res = await vector.execute(invocation(RECIPE()));
    expect(res.exitCode).not.toBe(0);
    expect(res.uiUnreachable).toBeUndefined();
  });

  it("leaves a step that ERRORED (not timed out) untagged", async () => {
    const vector = createUiVector(
      config(),
      runnerFor({ answerSelectRow: () => fail("execution error: -1728") }),
    );
    const res = await vector.execute(invocation(RECIPE()));
    expect(res.uiUnreachable).toBeUndefined();
  });
});

describe("pipeline maps an unreachable ui drive to verify-failed:ui-unreachable (#512)", () => {
  /** A vector reporting the drive's `uiUnreachable` outcome directly (id "ui"). */
  function unreachableVector(cause: "unreachable" | "unresponsive"): WriteVector {
    const real = createUiVector(config(), async () => ok());
    return {
      id: "ui",
      matrix: real.matrix,
      execute: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: 'ui drive stopped at "select the project row" (the row-selection step timed out).',
        uiUnreachable: {
          step: "select the project row",
          cause,
          clear: "cleared-blind" as const,
          remediation: "unlock the Mac, then run the same command again",
        },
      }),
    };
  }

  it("names the failing step, says the window was unreachable, and carries the retry path", async () => {
    const uuid = seedTodo(fixture.db, { title: "R", recurrenceRule: true });
    const res = await runMutation(
      deps(unreachableVector("unreachable")),
      "todo.pause-repeat",
      { uuid },
      { dangerouslyDriveGui: true },
    );
    expect(res.kind).toBe("verify-failed");
    if (res.kind !== "verify-failed") return;
    expect(res.reason).toBe("ui-unreachable");
    // The decisive contract: NOT the silent-noop verdict, whose meaning is that
    // the app was reachable and accepted-then-ignored the command.
    expect(res.reason).not.toBe("silent-noop");
    expect(res.detail).toContain("select the project row");
    expect(res.detail).toContain("no Things window was reachable");
    expect(res.detail).toContain("nothing landed");
    expect(res.likelyCause).toBe("ui-unreachable");
    expect(res.hint).toContain("unlock the Mac");
    expect(auditRecords.some((r) => r.result === "verify-failed:ui-unreachable")).toBe(true);
  });

  it("distinguishes an app that did not answer in time from one that was locked away", async () => {
    const uuid = seedTodo(fixture.db, { title: "R2", recurrenceRule: true });
    const res = await runMutation(
      deps(unreachableVector("unresponsive")),
      "todo.pause-repeat",
      { uuid },
      { dangerouslyDriveGui: true },
    );
    if (res.kind !== "verify-failed") throw new Error("expected verify-failed");
    expect(res.reason).toBe("ui-unreachable");
    expect(res.detail).toContain("did not answer that step before its deadline");
  });
});
