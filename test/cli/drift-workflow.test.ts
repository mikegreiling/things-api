/**
 * The full drift story, exercised end-to-end through the CLI:
 * a schema change → doctor reports drift → writes hard-block (exit 5) →
 * user accepts the observed fingerprint → doctor reports user-accepted →
 * writes proceed again. (Design §6 — no silent auto-acceptance, ever.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { saveConfigKey } from "../../src/config.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

let fixture: FixtureDb;
let stateDir: string;
let stdout: string[];
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  fixture = buildFixtureDb();
  // Drift that leaves every read query intact: drop a manifest column no
  // SELECT touches.
  fixture.db.exec("ALTER TABLE TMSettings DROP COLUMN groupTodayByParent;");
  stateDir = mkdtempSync(join(tmpdir(), "things-api-drift-test-"));
  for (const key of ["THINGS_DB", "THINGS_API_STATE_DIR", "THINGS_API_CONFIG_DIR"]) {
    envBackup[key] = process.env[key];
  }
  process.env["THINGS_DB"] = fixture.path;
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fixture.close();
  rmSync(stateDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

async function run(argv: string[]): Promise<Record<string, unknown>> {
  stdout = [];
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(["node", "things", ...argv]);
  const line = stdout.join("").trim().split("\n").at(-1) ?? "null";
  return JSON.parse(line) as Record<string, unknown>;
}

describe("drift workflow", () => {
  it("doctor reports drift (exit 5) with the missing-column detail", async () => {
    const env = await run(["doctor", "--json"]);
    const report = env["data"] as Record<string, Record<string, unknown>>;
    expect(report["fingerprint"]?.["status"]).toBe("drift");
    expect(JSON.stringify(report["fingerprint"]?.["detail"])).toContain(
      "TMSettings.groupTodayByParent",
    );
    expect(report["writes"]?.["enabled"]).toBe(false);
    expect(process.exitCode).toBe(5);
  });

  it("writes hard-block on drift (exit 5) even for --dry-run", async () => {
    const uuid = seedTodo(fixture.db, { title: "x" });
    const env = await run(["todo", "update", uuid, "--title", "y", "--dry-run", "--json"]);
    expect(env["ok"]).toBe(false);
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("blocked:drift");
    expect(process.exitCode).toBe(5);
  });

  it("accepted-fingerprint escape hatch re-enables writes, loudly", async () => {
    // Read the observed (drifted) fingerprint from doctor, accept it.
    const doctorEnv = await run(["doctor", "--json"]);
    const observed = (doctorEnv["data"] as Record<string, Record<string, unknown>>)[
      "fingerprint"
    ]?.["value"] as string;
    expect(observed).toMatch(/^sha256:/);
    saveConfigKey("acceptedFingerprint", observed);

    const doctorAfter = await run(["doctor", "--json"]);
    const report = doctorAfter["data"] as Record<string, Record<string, unknown>>;
    expect(report["fingerprint"]?.["status"]).toBe("user-accepted");
    expect(report["writes"]?.["enabled"]).toBe(true);
    expect(String(report["writes"]?.["reason"])).toContain("AT YOUR OWN RISK");
    expect(process.exitCode).toBe(0);

    const uuid = seedTodo(fixture.db, { title: "x" });
    const plan = await run(["todo", "update", uuid, "--title", "y", "--dry-run", "--json"]);
    expect(plan["ok"]).toBe(true);
    expect(plan["kind"]).toBe("mutation-plan");
    expect(process.exitCode).toBe(0);
  });

  it("acceptance of a DIFFERENT hash does not unlock anything", async () => {
    saveConfigKey("acceptedFingerprint", "sha256:somebody-elses-hash");
    const uuid = seedTodo(fixture.db, { title: "x" });
    const env = await run(["todo", "update", uuid, "--title", "y", "--dry-run", "--json"]);
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("blocked:drift");
    expect(process.exitCode).toBe(5);
  });
});
