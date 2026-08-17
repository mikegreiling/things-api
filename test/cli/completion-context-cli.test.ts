/**
 * HINTS1 completion-context end-to-end through the CLI with the simulator write
 * vector (THINGS_SIM_WRITES fence + a bench-marked fixture): a real complete
 * lands and the result carries the `context` hint on BOTH the `--json` envelope
 * (`data.context`) and the human TTY render (a dim remaining-count line).
 * Mirrors single-op-idempotency-cli.test.ts's harness.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedProject, seedTodo } from "../fixtures/seed.ts";

let fixture: FixtureDb;
let stateDir: string;
let stdout: string[];
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  fixture = buildFixtureDb({ benchMarker: true });
  stateDir = mkdtempSync(join(tmpdir(), "things-api-hints1-"));
  for (const key of [
    "THINGS_DB",
    "THINGS_SIM_WRITES",
    "THINGS_API_STATE_DIR",
    "THINGS_API_CONFIG_DIR",
  ]) {
    envBackup[key] = process.env[key];
  }
  process.env["THINGS_DB"] = fixture.path;
  process.env["THINGS_SIM_WRITES"] = "1";
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

describe("HINTS1 completion-context (CLI)", () => {
  it("--json carries data.context.project with the remaining open count", async () => {
    const proj = seedProject(fixture.db, { title: "Launch" });
    const a = seedTodo(fixture.db, { title: "A", project: proj });
    seedTodo(fixture.db, { title: "B", project: proj });

    await run(["todo", "complete", a, "--json"]);
    const env = envelope();
    expect(env["ok"]).toBe(true);
    const data = env["data"] as Record<string, unknown>;
    expect(data["context"]).toEqual({
      project: { uuid: proj, title: "Launch", remainingOpen: 1 },
    });
  });

  it("the human render prints a dim remaining-count line under the ok line", async () => {
    const proj = seedProject(fixture.db, { title: "Sprint" });
    const a = seedTodo(fixture.db, { title: "task", project: proj });
    seedTodo(fixture.db, { title: "other", project: proj });

    await run(["todo", "complete", a]);
    const out = stdout.join("");
    expect(out).toContain("ok todo.complete");
    // The remaining-count note (ANSI dim may wrap it, but the text is intact).
    expect(out).toContain('project "Sprint": 1 open remaining');
  });

  it("a to-do in no project and not in Today prints no context line and emits no context key", async () => {
    const loose = seedTodo(fixture.db, { title: "loose", start: "active" });
    await run(["todo", "complete", loose, "--json"]);
    const data = envelope()["data"] as Record<string, unknown>;
    expect(data["context"]).toBeUndefined();
  });
});
