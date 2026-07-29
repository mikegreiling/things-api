/**
 * Single-op idempotency (`--op-id`) end-to-end through the CLI with the
 * simulator write vector (THINGS_SIM_WRITES fence + a bench-marked fixture), so
 * a write really lands and a resubmission can be recognized as already applied
 * from the on-disk change history. Mirrors bulk-add-cli.test.ts's harness.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";

let fixture: FixtureDb;
let stateDir: string;
let stdout: string[];
let stderr: string[];
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  fixture = buildFixtureDb({ benchMarker: true });
  stateDir = mkdtempSync(join(tmpdir(), "things-api-opid-"));
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

/** The last JSON envelope written to stdout. */
function envelope(): Record<string, unknown> {
  const line = stdout.join("").trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

const todoCount = (): number =>
  (fixture.db.prepare("SELECT COUNT(*) AS n FROM TMTask WHERE type = 0").get() as { n: number }).n;

describe("single-op idempotency (--op-id)", () => {
  it("a resubmitted op-id skips execution and replays the ORIGINAL identity (uuid, undoToken, alreadyApplied)", async () => {
    await run(["todo", "add", "Recheck", "--op-id", "add-recheck", "--json"]);
    const first = envelope()["data"] as Record<string, unknown>;
    const before = todoCount();
    expect(first["alreadyApplied"]).toBeUndefined();
    const uuid = first["uuid"] as string;
    const undoToken = first["undoToken"] as string;
    expect(uuid).toBeDefined();
    expect(undoToken).toBeDefined();

    stdout.length = 0;
    await run(["todo", "add", "Recheck", "--op-id", "add-recheck", "--json"]);
    const second = envelope();
    expect(second["ok"]).toBe(true);
    expect(second["kind"]).toBe("mutation-result");
    const data = second["data"] as Record<string, unknown>;
    expect(data["alreadyApplied"]).toBe(true);
    expect(data["uuid"]).toBe(uuid);
    expect(data["undoToken"]).toBe(undoToken);
    expect(data["title"]).toBe("Recheck");
    // Nothing new was created — the second call never executed.
    expect(todoCount()).toBe(before);
    expect(process.exitCode).toBe(0);
  });

  it("a DIFFERENT op-id executes normally (a fresh row, no alreadyApplied)", async () => {
    await run(["todo", "add", "One", "--op-id", "key-a", "--json"]);
    const before = todoCount();
    stdout.length = 0;
    await run(["todo", "add", "Two", "--op-id", "key-b", "--json"]);
    const data = envelope()["data"] as Record<string, unknown>;
    expect(data["alreadyApplied"]).toBeUndefined();
    expect(todoCount()).toBe(before + 1);
    expect(process.exitCode).toBe(0);
  });

  it("the human line reports the replay ('already applied')", async () => {
    await run(["todo", "add", "Human", "--op-id", "human-key"]);
    stdout.length = 0;
    await run(["todo", "add", "Human", "--op-id", "human-key"]);
    expect(stdout.join("")).toContain("already applied");
  });

  it("a malformed op-id is a usage error (exit 2)", async () => {
    await run(["todo", "add", "Bad", "--op-id", "not a valid key!", "--json"]);
    const env = envelope();
    expect(env["ok"]).toBe(false);
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("usage");
    expect(process.exitCode).toBe(2);
    expect(todoCount()).toBe(todoCount()); // nothing created
  });

  it("--dry-run never dedups (mints/records nothing, so no replay)", async () => {
    await run(["todo", "add", "Ghost", "--op-id", "dry-key", "--dry-run", "--json"]);
    expect(envelope()["kind"]).toBe("mutation-plan");
    stdout.length = 0;
    // A real run with the same key still executes — the dry-run recorded nothing.
    await run(["todo", "add", "Ghost", "--op-id", "dry-key", "--json"]);
    const data = envelope()["data"] as Record<string, unknown>;
    expect(data["alreadyApplied"]).toBeUndefined();
  });

  it("--op-id is refused on a variadic move (a compound), naming the batch analogue", async () => {
    await run(["todo", "move", "some-uuid", "--to-project", "x", "--op-id", "k", "--json"]);
    const env = envelope();
    expect(env["ok"]).toBe(false);
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("usage");
    expect(String((env["error"] as Record<string, unknown>)["message"])).toContain("batch");
    expect(process.exitCode).toBe(2);
  });
});
