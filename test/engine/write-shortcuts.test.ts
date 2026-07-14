/**
 * Shortcuts write-vector engine tests. The executor is exercised ONLY through
 * the WriteDeps seam with a fake vector and an injected proxy-availability
 * function — no `shortcuts run` ever fires (CLAUDE.md safety rails: the two
 * mutating proxies must never touch this host's production Things). Covers:
 * success + verified delta, missing-proxy BLOCKED, first-run timeout →
 * consent-needed hint, and verify-failed on a silent no-op. A separate block
 * unit-tests the real executor's temp-file orchestration with a mock runner.
 */
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import { createShortcutsVector } from "../../src/write/vectors/shortcuts.ts";
import type {
  CompiledInvocation,
  ExecuteResult,
  VectorMatrix,
  WriteVector,
} from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

const PROXIES = ["things-proxy-create-heading", "things-proxy-set-detail"];

const SHORTCUTS_MATRIX: VectorMatrix = {
  "heading.create": { support: "yes", disruption: 0, validation: "validated" },
  "todo.clear-dated-reminder": { support: "yes", disruption: 0, validation: "validated" },
};

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

function fakeVector(effect: (invocation: CompiledInvocation) => ExecuteResult): {
  vector: WriteVector;
  calls: CompiledInvocation[];
} {
  const calls: CompiledInvocation[] = [];
  const vector: WriteVector = {
    id: "shortcuts",
    matrix: SHORTCUTS_MATRIX,
    async execute(invocation) {
      calls.push(invocation);
      return effect(invocation);
    },
  };
  return { vector, calls };
}

function deps(vector: WriteVector, present: string[] = PROXIES): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-shortcuts-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    shortcutProxies: () => ({
      present,
      missing: PROXIES.filter((p) => !present.includes(p)),
      detail: "test",
    }),
  };
}

const OK = (): ExecuteResult => ({ exitCode: 0, stdout: "", stderr: "" });

describe("heading.create", () => {
  it("runs the create-heading proxy and returns the new heading's uuid", async () => {
    const proj = seedProject(fixture.db, { title: "Dest" });
    let created: string | null = null;
    const { vector, calls } = fakeVector(() => {
      created = seedHeading(fixture.db, {
        title: "Phase 2",
        project: proj,
        creationDate: NOW_EPOCH,
      });
      return OK();
    });
    const result = await runMutation(deps(vector), "heading.create", {
      project: { title: "Dest" },
      title: "Phase 2",
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]?.shortcut).toBe("things-proxy-create-heading");
    expect(calls[0]?.input).toEqual({ title: "Phase 2", project: proj });
    if (result.kind === "ok") expect(result.uuid).toBe(created);
  });

  it("BLOCKS with a setup remediation when the proxy is not installed", async () => {
    seedProject(fixture.db, { title: "Dest" });
    const { vector, calls } = fakeVector(() => OK());
    const result = await runMutation(deps(vector, ["things-proxy-set-detail"]), "heading.create", {
      project: { title: "Dest" },
      title: "Phase 2",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toBe("environment");
      expect(result.remediation).toContain("things setup shortcuts");
    }
    // The vector was never dispatched.
    expect(calls).toHaveLength(0);
  });

  it("blocks an unknown destination project before dispatch", async () => {
    const { vector, calls } = fakeVector(() => OK());
    const result = await runMutation(deps(vector), "heading.create", {
      project: { title: "ghost" },
      title: "H",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-UNKNOWN-DESTINATION");
    expect(calls).toHaveLength(0);
  });

  it("--dry-run compiles the invocation without checking proxy availability", async () => {
    seedProject(fixture.db, { title: "Dest" });
    const { vector, calls } = fakeVector(() => OK());
    const result = await runMutation(
      deps(vector, []), // no proxies installed
      "heading.create",
      { project: { title: "Dest" }, title: "H" },
      { dryRun: true },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.plan.vector).toBe("shortcuts");
      expect(result.plan.invocation).toContain("things-proxy-create-heading");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("todo.clear-dated-reminder", () => {
  it("clears the reminder and pins the scheduled date (P3b)", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "dated + reminder",
      startDate: "2026-07-20",
      reminder: "09:30",
    });
    const { vector, calls } = fakeVector(() => {
      fixture.db
        .prepare("UPDATE TMTask SET reminderTime = NULL, userModificationDate = ? WHERE uuid = ?")
        .run(NOW_EPOCH + 1, uuid);
      return OK();
    });
    const result = await runMutation(deps(vector), "todo.clear-dated-reminder", { uuid });
    expect(result.kind).toBe("ok");
    expect(calls[0]?.input).toEqual({ id: uuid, detail: "Reminder Time", value: "" });
    if (result.kind === "ok") {
      expect(result.observed?.["reminder"]).toBeNull();
      expect(result.observed?.["startDate"]).toBe("2026-07-20");
    }
  });

  it("a first-run timeout is attributed to consent (run once, Always Allow)", async () => {
    const uuid = seedTodo(fixture.db, { title: "x", startDate: "2026-07-20", reminder: "09:30" });
    const { vector } = fakeVector(() => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    const result = await runMutation(deps(vector), "todo.clear-dated-reminder", { uuid });
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") {
      expect(result.likelyCause).toBe("permission-pending");
      expect(result.hint).toContain("Always Allow");
    }
  });

  it("a silent no-op fails verification", async () => {
    const uuid = seedTodo(fixture.db, { title: "x", startDate: "2026-07-20", reminder: "09:30" });
    const { vector } = fakeVector(() => OK()); // exit 0 but nothing changed
    const result = await runMutation(
      deps(vector),
      "todo.clear-dated-reminder",
      { uuid },
      { verifyTimeoutMs: 300 },
    );
    expect(result.kind).toBe("verify-failed");
  });

  it("blocks when the to-do has no reminder to clear", async () => {
    const uuid = seedTodo(fixture.db, { title: "no reminder", startDate: "2026-07-20" });
    const { vector, calls } = fakeVector(() => OK());
    const result = await runMutation(deps(vector), "todo.clear-dated-reminder", { uuid });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.hazard).toBe("H-NO-REMINDER");
    expect(calls).toHaveLength(0);
  });
});

describe("createShortcutsVector executor (mock runner — never runs `shortcuts`)", () => {
  it("writes the input JSON to a temp file, reads the output back, and cleans up", async () => {
    let seenInputPath = "";
    let seenInput = "";
    let seenShortcut = "";
    const vector = createShortcutsVector(async (shortcut, inputPath, outputPath) => {
      seenShortcut = shortcut;
      seenInputPath = inputPath;
      seenInput = readFileSync(inputPath, "utf8");
      // Emulate the proxy writing its result to --output-path.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(outputPath, "PROXY-OUTPUT", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await vector.execute({
      vector: "shortcuts",
      kind: "shortcuts-run",
      payload: "run",
      redactedPayload: "run",
      shortcut: "things-proxy-create-heading",
      input: { title: "H", project: "P-1" },
    });
    expect(seenShortcut).toBe("things-proxy-create-heading");
    expect(JSON.parse(seenInput)).toEqual({ title: "H", project: "P-1" });
    expect(result.stdout).toBe("PROXY-OUTPUT");
    // The per-run temp directory is removed after execution.
    expect(existsSync(seenInputPath)).toBe(false);
  });

  it("propagates a timeout from the runner", async () => {
    const vector = createShortcutsVector(async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    const result = await vector.execute({
      vector: "shortcuts",
      kind: "shortcuts-run",
      payload: "run",
      redactedPayload: "run",
      shortcut: "things-proxy-set-detail",
      input: {},
    });
    expect(result.timedOut).toBe(true);
  });
});
