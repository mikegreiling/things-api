/**
 * Regression: `--json` on a verify-failed write must yield EXACTLY ONE JSON
 * error envelope on stdout — never a plain-text `VERIFY FAILED (…)` banner
 * (that banner is the NON-json rendering, and it belongs on stderr). Field
 * report 2026-07-23: a `reschedule-repeat --dangerously-drive-gui --json` run
 * whose GUI drive completed but whose verification failed was seen printing the
 * banner to stdout, breaking `jq`. Both the transport-refused and the
 * drove-then-verify-failed paths land on the same `verify-failed` result kind
 * (see test/engine/write-ui-vector.test.ts for the exit-0 drove variant), so
 * this locks the CLI output contract for that kind.
 *
 * The failure is reached through the write SIMULATOR (a non-template target
 * makes the reschedule applier refuse), so no real app is ever driven.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

let fixture: FixtureDb;
let stateDir: string;
let stdout: string[];
let stderr: string[];
const envBackup: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "THINGS_DB",
  "THINGS_SIM_WRITES",
  "THINGS_API_STATE_DIR",
  "THINGS_API_CONFIG_DIR",
  "THINGS_API_UI_ENABLED",
];

beforeEach(() => {
  fixture = buildFixtureDb({ benchMarker: true });
  stateDir = mkdtempSync(join(tmpdir(), "things-api-vf-json-"));
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  process.env["THINGS_DB"] = fixture.path;
  process.env["THINGS_SIM_WRITES"] = "1";
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
  process.env["THINGS_API_UI_ENABLED"] = "true";
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
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

function rescheduleArgs(uuid: string, extra: string[]): string[] {
  return [
    "todo",
    "reschedule-repeat",
    uuid,
    "--frequency",
    "daily",
    "--interval",
    "1",
    "--dangerously-drive-gui",
    "--verify-timeout",
    "250",
    ...extra,
  ];
}

describe("verify-failed --json emits exactly one JSON error envelope", () => {
  it("--json: single JSON envelope on stdout, no plain-text banner, exit 3", async () => {
    const plain = seedTodo(fixture.db, { title: "not repeating", start: "active" });
    await run(rescheduleArgs(plain, ["--json"]));

    const out = stdout.join("");
    // stdout must NOT carry the human banner — that breaks jq.
    expect(out).not.toContain("VERIFY FAILED");
    // Exactly one non-empty line, and it parses as JSON.
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    const env = JSON.parse(lines[0] ?? "null") as Record<string, unknown>;
    expect(env["apiVersion"]).toBe(1);
    expect(env["ok"]).toBe(false);
    expect(env["kind"]).toBe("error");
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("verify-failed:silent-noop");
    expect(process.exitCode).toBe(3);
  });

  it("non-json: banner goes to stderr; stdout stays clean (no banner, no JSON)", async () => {
    const plain = seedTodo(fixture.db, { title: "not repeating", start: "active" });
    await run(rescheduleArgs(plain, []));

    expect(stderr.join("")).toContain("VERIFY FAILED (silent-noop)");
    const out = stdout.join("");
    expect(out).not.toContain("VERIFY FAILED");
    expect(out.trim()).toBe("");
    expect(process.exitCode).toBe(3);
  });
});
