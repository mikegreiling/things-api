/**
 * `things deputy` surface + the global `--deputy/--no-deputy` override. Status
 * must be honest on a machine with nothing installed (the common first run),
 * and the global flag must outrank the environment before any action loads
 * config — that is the whole point of a per-invocation override.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";

let stateDir: string;
let stdout: string[];
let stderr: string[];
const savedEnv: Record<string, string | undefined> = {};

async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(["node", "things", ...argv]);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "depcli-"));
  for (const key of ["THINGS_API_STATE_DIR", "THINGS_API_DEPUTY", "THINGS_API_CONFIG_DIR"]) {
    savedEnv[key] = process.env[key];
  }
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
  delete process.env["THINGS_API_DEPUTY"];
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
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

describe("things deputy status", () => {
  it("reports a bare machine honestly (nothing installed, not running, routing disabled)", async () => {
    await run(["deputy", "status"]);
    const out = stdout.join("");
    expect(out).toContain("deputy: not running");
    expect(out).toContain("routing: disabled");
    expect(process.exitCode).toBe(0);
  });

  it("--json carries the structured status", async () => {
    await run(["deputy", "status", "--json"]);
    const parsed = JSON.parse(stdout.join("")) as {
      kind: string;
      data: { running: boolean; enabled: boolean; hello: unknown };
    };
    expect(parsed.kind).toBe("deputy-status");
    expect(parsed.data.running).toBe(false);
    expect(parsed.data.enabled).toBe(false);
    expect(parsed.data.hello).toBeNull();
  });
});

describe("global --deputy/--no-deputy", () => {
  it("--deputy forces THINGS_API_DEPUTY=true for the invocation", async () => {
    await run(["--deputy", "deputy", "status"]);
    expect(process.env["THINGS_API_DEPUTY"]).toBe("true");
    expect(stdout.join("")).toContain("routing: enabled");
  });

  it("--no-deputy outranks an enabling environment", async () => {
    process.env["THINGS_API_DEPUTY"] = "true";
    await run(["--no-deputy", "deputy", "status"]);
    expect(process.env["THINGS_API_DEPUTY"]).toBe("false");
    expect(stdout.join("")).toContain("routing: disabled");
  });

  it("without the flag the environment is left alone", async () => {
    await run(["deputy", "status"]);
    expect(process.env["THINGS_API_DEPUTY"]).toBeUndefined();
  });
});

describe("deputy install", () => {
  it("refuses cleanly when no binary has been built", async () => {
    await run(["deputy", "install", "--binary", join(stateDir, "missing-binary")]);
    expect(stderr.join("")).toContain("not found");
    expect(process.exitCode).toBe(7);
  });
});
