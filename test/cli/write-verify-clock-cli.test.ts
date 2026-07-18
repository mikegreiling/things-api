/**
 * CLI-level regression for the verify-clock fix (mirrors the bench fence): a
 * fenced simulated `todo add --when evening` under a pinned THINGS_NOW in the
 * FUTURE must succeed (exit 0), not report verify-failed. This is the exact
 * shape the bench refiner hit — a correct write reported as a failure, whose
 * retry then duplicated state.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";

// Far-future so the pinned clock is ALWAYS ahead of the wall clock the suite
// runs under — the condition that made an evening item look future-dated to a
// real-clock verify reader.
const FUTURE_NOW = "2099-06-15T09:00:00-05:00";
const FUTURE_TODAY = "2099-06-15";

let fixture: FixtureDb;
let stateDir: string;
let stdout: string[];
const envBackup: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "THINGS_DB",
  "THINGS_SIM_WRITES",
  "THINGS_NOW",
  "THINGS_TZ",
  "THINGS_API_STATE_DIR",
  "THINGS_API_CONFIG_DIR",
];

beforeEach(() => {
  // benchMarker brands the DB so the simulator fence accepts it.
  fixture = buildFixtureDb({ benchMarker: true });
  stateDir = mkdtempSync(join(tmpdir(), "things-api-vclock-cli-"));
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  process.env["THINGS_DB"] = fixture.path;
  process.env["THINGS_SIM_WRITES"] = "1";
  process.env["THINGS_NOW"] = FUTURE_NOW;
  process.env["THINGS_TZ"] = "America/Chicago";
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

async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(["node", "things", ...argv]);
}

function envelope(): Record<string, unknown> {
  const line = stdout.join("").trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

describe("todo add --when evening under a future pinned THINGS_NOW", () => {
  it("verifies (exit 0) instead of reporting verify-failed:mismatch", async () => {
    await run(["todo", "add", "Evening probe", "--when", "evening", "--json"]);
    const env = envelope();
    expect(env["ok"]).toBe(true);
    expect(env["kind"]).toBe("mutation-result");
    const data = env["data"] as Record<string, unknown>;
    expect(data["kind"]).toBe("ok");
    expect(data["observed"]).toMatchObject({
      start: "active",
      startDate: FUTURE_TODAY,
      todaySection: "evening",
    });
    expect(process.exitCode ?? 0).toBe(0);
  });
});
