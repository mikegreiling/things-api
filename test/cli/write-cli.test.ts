/**
 * CLI write-command tests: dry-run plans, blocked paths, and capabilities —
 * none of these ever execute a vector, so they run safely anywhere.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTag, seedTodo } from "../fixtures/seed.ts";

let fixture: FixtureDb;
let stateDir: string;
let stdout: string[];
let stderr: string[];
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  fixture = buildFixtureDb();
  stateDir = mkdtempSync(join(tmpdir(), "things-api-cli-test-"));
  for (const key of ["THINGS_DB", "THINGS_API_STATE_DIR", "THINGS_API_CONFIG_DIR"]) {
    envBackup[key] = process.env[key];
  }
  process.env["THINGS_DB"] = fixture.path;
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

function envelope(): Record<string, unknown> {
  const line = stdout.join("").trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

describe("dry-run plans", () => {
  it("todo add --dry-run emits a mutation-plan envelope with the compiled URL", async () => {
    await run(["todo", "add", "Buy milk", "--when", "today", "--dry-run", "--json"]);
    const env = envelope();
    expect(env["ok"]).toBe(true);
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["vector"]).toBe("url-scheme");
    expect(String(plan["invocation"])).toContain("things:///add?title=Buy%20milk&when=today");
    expect(process.exitCode).toBe(0);
  });

  it("todo delete --dry-run plans the applescript vector", async () => {
    const uuid = seedTodo(fixture.db, { title: "victim" });
    await run(["todo", "delete", uuid, "--dry-run", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("mutation-plan");
    const plan = env["data"] as Record<string, unknown>;
    expect(plan["vector"]).toBe("applescript");
    expect(String(plan["invocation"])).toContain(`delete to do id "${uuid}"`);
  });
});

describe("blocked paths (exit 4, nothing executed)", () => {
  it("trash empty without --dangerously-permanent", async () => {
    await run(["trash", "empty", "--json"]);
    const env = envelope();
    expect(env["ok"]).toBe(false);
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("blocked:H-PERMANENT-DELETE");
    expect(process.exitCode).toBe(4);
  });

  it("todo update on a repeating template", async () => {
    const uuid = seedTodo(fixture.db, { title: "tmpl", recurrenceRule: true });
    await run(["todo", "update", uuid, "--when", "today", "--json"]);
    const env = envelope();
    expect((env["error"] as Record<string, unknown>)["code"]).toBe("blocked:H-REPEAT-SCHEDULE");
    expect(process.exitCode).toBe(4);
  });

  it("unknown tag fails fast with remediation", async () => {
    const uuid = seedTodo(fixture.db, { title: "x" });
    seedTag(fixture.db, "real");
    await run(["todo", "tags", uuid, "--set", "real,ghost", "--json"]);
    const env = envelope();
    const error = env["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("blocked:H-UNKNOWN-TAG");
    expect(String(error["remediation"])).toContain("things tag add");
    expect(process.exitCode).toBe(4);
  });
});

describe("capabilities", () => {
  it("dumps the lab-validated matrix for one op", async () => {
    await run(["capabilities", "--op", "todo.delete", "--json"]);
    const env = envelope();
    expect(env["kind"]).toBe("capabilities");
    const data = env["data"] as { op: string; vectors: { vector: string; support: string }[] }[];
    expect(data).toHaveLength(1);
    const entry = data[0];
    expect(entry?.op).toBe("todo.delete");
    expect(entry?.vectors.find((v) => v.vector === "url-scheme")?.support).toBe("no");
    expect(entry?.vectors.find((v) => v.vector === "applescript")?.support).toBe("yes");
  });
});
