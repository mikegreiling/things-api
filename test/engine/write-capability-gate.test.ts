/**
 * The write gate (docs/design/permissions-doctrine.md, Articles I + II).
 *
 * The AppleScript vector sends a real Apple Event, and on a machine macOS has
 * no consent record for, that event IS the dialog. So the pipeline establishes
 * app-control standing prompt-free BEFORE dispatch and refuses on anything
 * short of a grant. The property under test throughout: a refusal must reach
 * the caller with remediation and WITHOUT the vector ever executing.
 *
 * SAFETY: the vector is a fake and the capability verdict is injected — no
 * osascript runs, and nothing reads this host's real TCC state.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { WriteCapability } from "../../src/capability.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import type {
  CompiledInvocation,
  ExecuteResult,
  VectorMatrix,
  WriteVector,
} from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

// `todo.delete` compiles for the AppleScript vector ALONE (src/write/commands.ts),
// so the vector under test is not a planner accident.
const MATRIX: VectorMatrix = {
  "todo.delete": { support: "yes", disruption: 0, validation: "validated" },
};

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

const HOST = { bundleId: "com.mitchellh.ghostty", name: "Ghostty" };

function capability(over: Partial<WriteCapability>): WriteCapability {
  return { mode: "direct-granted", detail: "granted", remediation: [], host: HOST, ...over };
}

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

/**
 * A stand-in for the AppleScript vector that APPLIES the delta to the fixture
 * (marks the row trashed) rather than only recording the call — otherwise the
 * pipeline's read-after-write verification waits for a change that never lands.
 */
function fakeAppleScriptVector(uuid: string): {
  vector: WriteVector;
  calls: CompiledInvocation[];
} {
  const calls: CompiledInvocation[] = [];
  return {
    calls,
    vector: {
      id: "applescript",
      matrix: MATRIX,
      async execute(invocation): Promise<ExecuteResult> {
        calls.push(invocation);
        fixture.db.prepare("UPDATE TMTask SET trashed = 1 WHERE uuid = ?").run(uuid);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

function deps(vector: WriteVector, write: WriteCapability): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-writegate-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    writeCapability: () => write,
  };
}

async function update(write: WriteCapability): Promise<{
  result: Awaited<ReturnType<typeof runMutation>>;
  calls: CompiledInvocation[];
}> {
  const uuid = seedTodo(fixture.db, { title: "a synthetic to-do" });
  const { vector, calls } = fakeAppleScriptVector(uuid);
  const result = await runMutation(deps(vector, write), "todo.delete", { uuid });
  return { result, calls };
}

describe("app control missing blocks BEFORE the app is touched", () => {
  it("an unknown standing refuses and points at the ceremony — never at a retry", async () => {
    const { result, calls } = await update(
      capability({
        mode: "direct-unknown",
        detail: "macOS has no app-control record for Ghostty (com.mitchellh.ghostty) yet",
        remediation: ["run `things setup` — it asks for app control once"],
      }),
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toBe("environment");
      expect(result.detail).toContain("drives the Things app");
      expect(result.remediation).toContain("things setup");
    }
    expect(calls, "the Apple Event must never be sent on an unknown standing").toHaveLength(0);
  });

  it("a recorded refusal names the Settings toggle AND the tccutil re-arm", async () => {
    const { result, calls } = await update(
      capability({
        mode: "direct-denied",
        detail: "macOS records a refusal of app control for Ghostty",
        remediation: [
          "turn on Things3 for Ghostty under System Settings ▸ Privacy & Security ▸ Automation",
          "or re-arm the request with `tccutil reset AppleEvents com.mitchellh.ghostty`",
        ],
      }),
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.remediation).toContain("System Settings");
      expect(result.remediation).toContain("tccutil reset AppleEvents");
    }
    expect(calls).toHaveLength(0);
  });

  it("the refusal is recorded as an environment block, not a failed write", async () => {
    await update(capability({ mode: "direct-unknown", remediation: ["run `things setup`"] }));
    expect(auditRecords.length).toBeGreaterThan(0);
    expect(JSON.stringify(auditRecords)).toContain("environment");
  });
});

describe("app control present dispatches exactly as before", () => {
  it("a direct grant on the host app lets the write through", async () => {
    const { result, calls } = await update(capability({ mode: "direct-granted" }));
    expect(result.kind).not.toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("an onboarded deputy lets the write through", async () => {
    const { result, calls } = await update(
      capability({ mode: "deputy", detail: "the deputy holds app control for Things" }),
    );
    expect(result.kind).not.toBe("blocked");
    expect(calls).toHaveLength(1);
  });
});
