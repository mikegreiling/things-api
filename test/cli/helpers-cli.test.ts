/**
 * `things helpers` surface + the global `--helpers/--no-helpers` override.
 * Status must be honest on a machine with nothing installed (the common first
 * run), and the global flag must outrank the environment before any action
 * loads config — that is the whole point of a per-invocation override.
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
  stateDir = mkdtempSync(join(tmpdir(), "helpcli-"));
  for (const key of [
    "THINGS_API_STATE_DIR",
    "THINGS_API_HELPERS",
    "THINGS_API_CONFIG_DIR",
    "THINGS_API_READER_DIR",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
  // Isolate from a REAL reader serving in this user's container (a granted
  // production machine must not leak into the bare-machine assertions).
  process.env["THINGS_API_READER_DIR"] = join(stateDir, "reader");
  delete process.env["THINGS_API_HELPERS"];
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

describe("things helpers status", () => {
  it("reports a bare machine honestly (nothing installed, not running, routing disabled)", async () => {
    await run(["helpers", "status"]);
    const out = stdout.join("");
    expect(out).toContain("deputy: does not appear to be running");
    expect(out).not.toContain("detail:");
    expect(out).toContain("routing: disabled");
    expect(out).toContain("reader: not installed");
    expect(process.exitCode).toBe(0);
  });

  it("--json carries the structured status", async () => {
    await run(["helpers", "status", "--json"]);
    const parsed = JSON.parse(stdout.join("")) as {
      kind: string;
      data: {
        enabled: boolean;
        bundleInstalled: boolean;
        deputy: { running: boolean; hello: unknown };
        reader: { installed: boolean; granted: boolean };
      };
    };
    expect(parsed.kind).toBe("helpers-status");
    expect(parsed.data.enabled).toBe(false);
    expect(parsed.data.bundleInstalled).toBe(false);
    expect(parsed.data.deputy.running).toBe(false);
    expect(parsed.data.deputy.hello).toBeNull();
    expect(parsed.data.reader.installed).toBe(false);
    expect(parsed.data.reader.granted).toBe(false);
  });
});

describe("global --helpers/--no-helpers", () => {
  it("--helpers forces THINGS_API_HELPERS=true for the invocation", async () => {
    await run(["--helpers", "helpers", "status"]);
    expect(process.env["THINGS_API_HELPERS"]).toBe("true");
    expect(stdout.join("")).toContain("routing: enabled");
  });

  it("--no-helpers outranks an enabling environment", async () => {
    process.env["THINGS_API_HELPERS"] = "true";
    await run(["--no-helpers", "helpers", "status"]);
    expect(process.env["THINGS_API_HELPERS"]).toBe("false");
    expect(stdout.join("")).toContain("routing: disabled");
  });

  it("without the flag the environment is left alone", async () => {
    await run(["helpers", "status"]);
    expect(process.env["THINGS_API_HELPERS"]).toBeUndefined();
  });
});

describe("helpers install", () => {
  it("refuses cleanly when no bundle has been built", async () => {
    await run(["helpers", "install", "--bundle", join(stateDir, "missing-bundle.app")]);
    expect(stderr.join("")).toContain("not found");
    expect(process.exitCode).toBe(7);
  });
});
