/**
 * Dev-mode trace + interrupt-guard WIRING across the CLI write drivers (TRACE1
 * residual, #487). The library half (in-flight marker, watchdog, stderr line)
 * works for every write; what is per-driver is the trace FILE and the armed
 * `--json` interrupted envelope. These run real writes through the simulator
 * vector with tracing forced on, and assert each driver opened a trace, closed
 * it with an `invocation-end`, armed the guard, and disarmed it on the way out.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { armInterrupt, disarmInterrupt } from "../../src/cli/interrupt.ts";
import { buildProgram } from "../../src/cli/main.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedProject, seedTodo } from "../fixtures/seed.ts";

vi.mock("../../src/cli/interrupt.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/interrupt.ts")>();
  return {
    ...actual,
    armInterrupt: vi.fn(actual.armInterrupt),
    disarmInterrupt: vi.fn(actual.disarmInterrupt),
  };
});

let fixture: FixtureDb;
let stateDir: string;
let stdout: string[];
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  fixture = buildFixtureDb({ benchMarker: true });
  stateDir = mkdtempSync(join(tmpdir(), "things-api-trace-wiring-"));
  for (const key of [
    "THINGS_DB",
    "THINGS_SIM_WRITES",
    "THINGS_API_STATE_DIR",
    "THINGS_API_CONFIG_DIR",
    "THINGS_API_TRACE",
  ]) {
    envBackup[key] = process.env[key];
  }
  process.env["THINGS_DB"] = fixture.path;
  process.env["THINGS_SIM_WRITES"] = "1";
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
  process.env["THINGS_API_TRACE"] = "true";
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
  vi.mocked(armInterrupt).mockClear();
  vi.mocked(disarmInterrupt).mockClear();
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

/** Every event of the one trace file this invocation wrote. */
function traceEvents(): Record<string, unknown>[] {
  const dir = join(stateDir, "trace");
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0] as string), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The contract every write driver owes: a bracketed trace and a guard cycle. */
function expectTracedAndGuarded(): void {
  const events = traceEvents();
  expect(events[0]).toMatchObject({ phase: "invocation" });
  expect(events.at(-1)).toMatchObject({ phase: "invocation-end" });
  expect(events.at(-1)?.["exitCode"]).toBeTypeOf("number");
  expect(vi.mocked(armInterrupt)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(disarmInterrupt)).toHaveBeenCalledTimes(1);
}

describe("write drivers install the trace and arm the interrupt guard", () => {
  it("the single-mutation driver (runWrite) — unchanged by the refactor", async () => {
    await run(["todo", "add", "Solo", "--json"]);
    expect(process.exitCode).toBe(0);
    expectTracedAndGuarded();
    expect(vi.mocked(armInterrupt)).toHaveBeenCalledWith(true);
  });

  it("the variadic move/reorder driver (runMoveCmd)", async () => {
    const project = seedProject(fixture.db, { title: "Dest" });
    const todo = seedTodo(fixture.db, { title: "Mover" });
    await run(["todo", "move", todo, "--to-project", project, "--json"]);
    expectTracedAndGuarded();
  });

  it("the bulk-add driver (runBulkAdd)", async () => {
    await run(["todo", "add", "One", "Two", "--json"]);
    expect(process.exitCode).toBe(0);
    expectTracedAndGuarded();
  });

  it("the batch driver — armed machine-readable even without --json", async () => {
    const file = join(stateDir, "ops.jsonl");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, `${JSON.stringify({ op: "todo.add", params: { title: "Batched" } })}\n`);
    await run(["batch", file]);
    expectTracedAndGuarded();
    expect(vi.mocked(armInterrupt)).toHaveBeenCalledWith(true);
  });

  it("closes the trace on the failure path too (an unresolvable target)", async () => {
    await run(["todo", "move", "no-such-uuid", "--to-project", "nowhere", "--json"]);
    expect(process.exitCode).toBe(2);
    expectTracedAndGuarded();
    expect(traceEvents().at(-1)).toMatchObject({ phase: "invocation-end", exitCode: 2 });
  });

  it("leaves no signal listener behind — the span really is the write's", async () => {
    const before = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
    await run(["todo", "add", "Scoped", "--json"]);
    expect(process.exitCode).toBe(0);
    // Armed for the drive, off again the moment the driver returned: whatever
    // the invocation does next (rendering, teardown, a synchronous read) dies
    // to a signal under the kernel's disposition instead of queueing it.
    expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual(before);
  });

  it("writes no trace file at all when tracing is off (the default cost)", async () => {
    process.env["THINGS_API_TRACE"] = "false";
    await run(["todo", "add", "Quiet", "--json"]);
    expect(process.exitCode).toBe(0);
    expect(readdirSync(stateDir)).not.toContain("trace");
    // The guard is armed regardless — it does not depend on tracing.
    expect(vi.mocked(armInterrupt)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(disarmInterrupt)).toHaveBeenCalledTimes(1);
  });
});
